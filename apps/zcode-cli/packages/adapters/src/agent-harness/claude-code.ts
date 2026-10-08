import {
  AgentHarnessError,
  type AgentHarnessEvent,
  type AgentHarnessFileChange,
  type AgentHarnessDiffHunk,
  type AgentHarnessPermissionProfile,
  type AgentHarnessRunRequest,
} from "@zcode/contracts";
import { raceAbort, type EventChannel } from "./channel.js";
import { runHarnessProcess, type HarnessDriver, type HarnessDriverContext } from "./driver.js";
import {
  asRecord,
  readArray,
  readBoolean,
  readNumber,
  readRecord,
  readString,
  stringifyToolOutput,
  type JsonRecord,
} from "./json-record.js";
import { describeHarnessExit, type HarnessProcess } from "./process.js";
import { toAnthropicUsage } from "./usage.js";

/**
 * Claude Code 驱动：`claude -p --input-format stream-json --output-format stream-json`
 * 加 `--permission-prompt-tool stdio`，即官方 Agent SDK 使用的双向控制协议。
 *
 * - 用户输入以 `{"type":"user",...}` 写入 stdin；
 * - 需要审批的工具调用以 `control_request{subtype:"can_use_tool"}` 发回宿主，宿主应答
 *   `control_response`，由此接入 ZCode 的审批卡片；
 * - 会话续接用 `--resume <session_id>`。
 */
export function claudePermissionArgs(permission: AgentHarnessPermissionProfile): string[] {
  if (permission.planEnabled || permission.mode === "plan") return ["--permission-mode", "plan"];
  switch (permission.mode) {
    case "edit":
      return ["--permission-mode", "acceptEdits"];
    case "yolo":
      return ["--dangerously-skip-permissions"];
    case "auto":
      return ["--permission-mode", "auto"];
    case "build":
    default:
      // 默认模式：写文件 / 执行命令都经 can_use_tool 请求宿主审批。
      return ["--permission-mode", "default"];
  }
}

export function buildClaudeCodeArgs(request: AgentHarnessRunRequest): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
    ...claudePermissionArgs(request.permission),
  ];
  if (request.selection.model) args.push("--model", request.selection.model);
  if (request.selection.thought) args.push("--effort", request.selection.thought);
  if (request.resumeSessionId) args.push("--resume", request.resumeSessionId);
  return args;
}

export const claudeCodeDriver: HarnessDriver = {
  harness: "claude-code",
  run(request: AgentHarnessRunRequest, context: HarnessDriverContext) {
    return runHarnessProcess(
      request,
      () =>
        context.spawnProcess({
          executablePath: context.executablePath,
          args: buildClaudeCodeArgs(request),
          cwd: request.cwd,
          env: context.env,
          platform: context.platform,
        }),
      (process, channel) => pumpClaudeCode(request, process, channel),
    );
  },
};

async function pumpClaudeCode(
  request: AgentHarnessRunRequest,
  process: HarnessProcess,
  channel: EventChannel<AgentHarnessEvent>,
): Promise<void> {
  const state = new ClaudeCodeStreamState();
  process.send({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: request.prompt }] },
    parent_tool_use_id: null,
    session_id: request.resumeSessionId ?? "",
  });
  let result: JsonRecord | undefined;
  for await (const raw of process.records) {
    const record = asRecord(raw);
    if (!record) continue;
    const type = readString(record, "type");
    if (type === "control_request") {
      await answerControlRequest(request, process, record, state, channel);
      continue;
    }
    if (type === "result") {
      result = record;
      for (const event of state.parse(record)) channel.push(event);
      // 结果之后关闭 stdin，CLI 才会退出。
      process.endInput();
      break;
    }
    for (const event of state.parse(record)) channel.push(event);
  }
  const exit = await process.exited;
  if (!result) {
    throw classifyClaudeFailure(request, state, describeHarnessExit(exit));
  }
  if (readBoolean(result, "is_error") === true || readString(result, "subtype") !== "success") {
    const errors = readArray(result, "errors").filter((item) => typeof item === "string");
    const message =
      readString(result, "result") ||
      errors.join("\n") ||
      readString(result, "subtype") ||
      "Claude Code failed";
    throw classifyClaudeFailure(request, state, message);
  }
}

function classifyClaudeFailure(
  request: AgentHarnessRunRequest,
  state: ClaudeCodeStreamState,
  message: string,
): AgentHarnessError {
  const resumeFailed =
    request.resumeSessionId !== undefined &&
    !state.producedOutput &&
    /no conversation found|session.*not found/i.test(message);
  return new AgentHarnessError(
    "claude-code",
    resumeFailed ? "resume_failed" : "failed",
    `Claude Code: ${message}`,
  );
}

async function answerControlRequest(
  request: AgentHarnessRunRequest,
  process: HarnessProcess,
  record: JsonRecord,
  state: ClaudeCodeStreamState,
  channel: EventChannel<AgentHarnessEvent>,
): Promise<void> {
  const requestId = readString(record, "request_id");
  const body = readRecord(record, "request");
  if (!requestId) return;
  if (readString(body, "subtype") !== "can_use_tool") {
    process.send({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: requestId,
        error: `ZCode does not handle ${readString(body, "subtype") ?? "unknown"} requests`,
      },
    });
    return;
  }
  const toolName = readString(body, "tool_name") ?? "tool";
  const input = (readRecord(body, "input") ?? {}) as Record<string, unknown>;
  const callId =
    readString(body, "tool_use_id") ?? state.findPendingToolCall(toolName) ?? `claude-${requestId}`;
  if (!state.hasToolCall(callId)) {
    // 部分版本在 assistant 消息落地前就请求审批：先补发工具卡片，审批卡片才有归属。
    for (const event of state.registerToolCall(callId, toolName, input)) channel.push(event);
  }
  // Claude 的 description / decision_reason 是英文的内部说明（常常只是文件名），不作为审批标题；
  // ZCode 用统一的、按界面语言渲染的 harness 审批标题，工具详情由审批卡片自己展示。
  const decision = await raceAbort(
    request.requestApproval({ callId, toolName, input }),
    request.abortSignal,
  );
  const suggestions = body?.permission_suggestions;
  const response =
    decision.decision === "deny"
      ? { behavior: "deny", message: decision.reason ?? "The user denied this tool call in ZCode." }
      : {
          behavior: "allow",
          updatedInput: input,
          ...(decision.decision === "allow_session" && Array.isArray(suggestions)
            ? { updatedPermissions: suggestions }
            : {}),
        };
  process.send({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  });
}

/** Claude Code stream-json 记录 → 归一化事件（纯解析，便于单测）。 */
export class ClaudeCodeStreamState {
  readonly #streamedMessageIds = new Set<string>();
  readonly #toolCalls = new Map<string, string>();
  readonly #completedToolCalls = new Set<string>();
  #currentMessageId = "message";
  producedOutput = false;

  hasToolCall(id: string): boolean {
    return this.#toolCalls.has(id);
  }

  findPendingToolCall(toolName: string): string | undefined {
    let match: string | undefined;
    for (const [id, name] of this.#toolCalls) {
      if (name === toolName && !this.#completedToolCalls.has(id)) match = id;
    }
    return match;
  }

  registerToolCall(id: string, name: string, input: Record<string, unknown>): AgentHarnessEvent[] {
    if (this.#toolCalls.has(id)) return [];
    this.#toolCalls.set(id, name);
    this.producedOutput = true;
    return [{ type: "tool_call", call: { id, name, nativeName: name, input } }];
  }

  parse(raw: unknown): AgentHarnessEvent[] {
    const record = asRecord(raw);
    if (!record) return [];
    // 子代理（Task/Agent 工具）内部记录带 parent_tool_use_id，只作为所属工具的内部过程。
    if (readString(record, "parent_tool_use_id")) return [];
    switch (readString(record, "type")) {
      case "system": {
        const sessionId = readString(record, "session_id");
        if (readString(record, "subtype") !== "init" || !sessionId) return [];
        const model = readString(record, "model");
        return [{ type: "session", nativeSessionId: sessionId, ...(model ? { model } : {}) }];
      }
      case "stream_event":
        return this.#parseStreamEvent(readRecord(record, "event"));
      case "assistant":
        return this.#parseAssistant(readRecord(record, "message"));
      case "user":
        return this.#parseUser(record);
      case "result": {
        const usage = toAnthropicUsage(readRecord(record, "usage"));
        return usage ? [{ type: "usage", usage }] : [];
      }
      default:
        return [];
    }
  }

  #parseStreamEvent(event: JsonRecord | undefined): AgentHarnessEvent[] {
    switch (readString(event, "type")) {
      case "message_start": {
        const message = readRecord(event, "message");
        this.#currentMessageId = readString(message, "id") ?? this.#currentMessageId;
        this.#streamedMessageIds.add(this.#currentMessageId);
        return [];
      }
      case "content_block_delta": {
        const delta = readRecord(event, "delta");
        const deltaType = readString(delta, "type");
        if (deltaType === "text_delta") {
          const text = readString(delta, "text");
          if (!text) return [];
          this.producedOutput = true;
          return [{ type: "text_delta", text }];
        }
        if (deltaType === "thinking_delta") {
          const text = readString(delta, "thinking");
          if (!text) return [];
          this.producedOutput = true;
          return [{ type: "reasoning_delta", text }];
        }
        return [];
      }
      default:
        return [];
    }
  }

  #parseAssistant(message: JsonRecord | undefined): AgentHarnessEvent[] {
    if (!message) return [];
    const messageId = readString(message, "id") ?? this.#currentMessageId;
    const streamed = this.#streamedMessageIds.has(messageId);
    const events: AgentHarnessEvent[] = [];
    for (const item of readArray(message, "content")) {
      const block = asRecord(item);
      switch (readString(block, "type")) {
        case "text": {
          const text = readString(block, "text");
          if (!streamed && text) {
            this.producedOutput = true;
            events.push({ type: "text_delta", text });
          }
          break;
        }
        case "thinking": {
          const text = readString(block, "thinking");
          if (!streamed && text) {
            this.producedOutput = true;
            events.push({ type: "reasoning_delta", text });
          }
          break;
        }
        case "tool_use": {
          const id = readString(block, "id");
          if (!id) break;
          const name = readString(block, "name") ?? "tool";
          const input = (readRecord(block, "input") ?? {}) as Record<string, unknown>;
          events.push(...this.registerToolCall(id, name, input));
          break;
        }
      }
    }
    return events;
  }

  #parseUser(record: JsonRecord): AgentHarnessEvent[] {
    const message = readRecord(record, "message");
    const structured = readRecord(record, "tool_use_result");
    return readArray(message, "content").flatMap((item): AgentHarnessEvent[] => {
      const block = asRecord(item);
      if (readString(block, "type") !== "tool_result") return [];
      const callId = readString(block, "tool_use_id");
      if (!callId) return [];
      this.#completedToolCalls.add(callId);
      const isError = readBoolean(block, "is_error") === true;
      const fileChanges = isError ? undefined : readClaudeFileChanges(structured);
      return [
        {
          type: "tool_result",
          callId,
          output: stringifyToolOutput(block?.content),
          isError,
          ...(fileChanges ? { fileChanges } : {}),
        },
      ];
    });
  }
}

/** Edit / MultiEdit / Write 的结构化结果自带 structuredPatch，直接映射为 ZCode diff。 */
export function readClaudeFileChanges(
  structured: JsonRecord | undefined,
): AgentHarnessFileChange[] | undefined {
  const filePath = readString(structured, "filePath");
  if (!structured || !filePath) return undefined;
  const hunks = readArray(structured, "structuredPatch").flatMap((item): AgentHarnessDiffHunk[] => {
    const hunk = asRecord(item);
    const oldStart = readNumber(hunk, "oldStart");
    const newStart = readNumber(hunk, "newStart");
    if (oldStart === undefined || newStart === undefined) return [];
    return [
      {
        oldStart,
        oldLines: readNumber(hunk, "oldLines") ?? 0,
        newStart,
        newLines: readNumber(hunk, "newLines") ?? 0,
        lines: readArray(hunk, "lines").filter((line): line is string => typeof line === "string"),
      },
    ];
  });
  const kind = readString(structured, "type") === "create" ? "add" : "update";
  const content = readString(structured, "content");
  if (hunks.length > 0) return [{ filePath, kind, structuredPatch: hunks }];
  if (kind === "add" && content !== undefined)
    return [{ filePath, kind, oldText: "", newText: content }];
  const original = readString(structured, "originalFile");
  if (original !== undefined && content !== undefined) {
    return [{ filePath, kind, oldText: original, newText: content }];
  }
  return undefined;
}
