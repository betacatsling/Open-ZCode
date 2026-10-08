import {
  AgentHarnessError,
  type AgentHarnessEvent,
  type AgentHarnessFileChange,
  type AgentHarnessPermissionProfile,
  type AgentHarnessRunRequest,
  type ModelUsage,
} from "@zcode/contracts";
import { createEventChannel, raceAbort, type EventChannel } from "./channel.js";
import { runHarnessProcess, type HarnessDriver, type HarnessDriverContext } from "./driver.js";
import {
  asRecord,
  readArray,
  readNumber,
  readRecord,
  readString,
  stringifyToolOutput,
  type JsonRecord,
} from "./json-record.js";
import { describeHarnessExit, type HarnessProcess } from "./process.js";
import { toCodexUsage } from "./usage.js";

/**
 * Codex 驱动：`codex app-server`（stdio JSON-RPC，Codex IDE 插件使用的同一协议）。
 *
 * initialize → thread/start | thread/resume → turn/start，随后消费 item/* 通知直到
 * turn/completed。命令执行与文件改动的审批以服务端请求
 * `item/commandExecution/requestApproval` / `item/fileChange/requestApproval` 发回宿主。
 */
export interface CodexPermissionConfig {
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access";
  readonly approvalPolicy: "untrusted" | "on-request" | "never";
}

export function codexPermissionConfig(
  permission: AgentHarnessPermissionProfile,
): CodexPermissionConfig {
  if (permission.planEnabled || permission.mode === "plan") {
    // 规划：只读沙箱，不允许升级权限（never 表示失败直接返回给模型，而不是询问）。
    return { sandbox: "read-only", approvalPolicy: "never" };
  }
  switch (permission.mode) {
    case "yolo":
      return { sandbox: "danger-full-access", approvalPolicy: "never" };
    case "edit":
    case "auto":
      // 工作区内写入自动执行，越界 / 联网等升级请求才询问。
      return { sandbox: "workspace-write", approvalPolicy: "on-request" };
    case "build":
    default:
      // 默认：除受信任的只读命令外都询问。
      return { sandbox: "workspace-write", approvalPolicy: "untrusted" };
  }
}

export const codexDriver: HarnessDriver = {
  harness: "codex",
  run(request: AgentHarnessRunRequest, context: HarnessDriverContext) {
    return runHarnessProcess(
      request,
      () =>
        context.spawnProcess({
          executablePath: context.executablePath,
          args: ["app-server"],
          cwd: request.cwd,
          env: context.env,
          platform: context.platform,
        }),
      (process, channel) => pumpCodex(request, process, channel),
    );
  },
};

interface PendingCall {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

class CodexRpcError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(message);
  }
}

async function pumpCodex(
  request: AgentHarnessRunRequest,
  process: HarnessProcess,
  channel: EventChannel<AgentHarnessEvent>,
): Promise<void> {
  const pending = new Map<number, PendingCall & { method: string }>();
  // 通知与服务端请求按到达顺序进入 inbox；响应直接分发给等待中的调用。
  const inbox = createEventChannel<JsonRecord>(() => undefined);
  let nextId = 1;
  const reader = (async () => {
    for await (const raw of process.records) {
      const record = asRecord(raw);
      if (!record) continue;
      const method = readString(record, "method");
      const id = readNumber(record, "id");
      if (method === undefined && id !== undefined) {
        const call = pending.get(id);
        if (!call) continue;
        pending.delete(id);
        const error = readRecord(record, "error");
        if (error)
          call.reject(new CodexRpcError(call.method, readString(error, "message") ?? "error"));
        else call.resolve(record.result);
        continue;
      }
      inbox.push(record);
    }
    const exit = await process.exited;
    const failure = new AgentHarnessError("codex", "failed", `Codex: ${describeHarnessExit(exit)}`);
    for (const call of pending.values()) call.reject(failure);
    pending.clear();
    inbox.fail(failure);
  })();
  void reader.catch(() => undefined);

  const call = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
    });
    process.send({ id, method, params });
    return raceAbort(promise, request.abortSignal);
  };

  await call("initialize", {
    clientInfo: { name: "zcode", title: "ZCode", version: "1.0.0" },
    capabilities: null,
  });
  process.send({ method: "initialized" });

  const permission = codexPermissionConfig(request.permission);
  const model = request.selection.model;
  const state = new CodexStreamState();
  let threadId: string;
  try {
    const response = asRecord(
      request.resumeSessionId
        ? await call("thread/resume", {
            threadId: request.resumeSessionId,
            cwd: request.cwd,
            approvalPolicy: permission.approvalPolicy,
            sandbox: permission.sandbox,
            excludeTurns: true,
            ...(model ? { model } : {}),
          })
        : await call("thread/start", {
            cwd: request.cwd,
            approvalPolicy: permission.approvalPolicy,
            sandbox: permission.sandbox,
            ...(model ? { model } : {}),
          }),
    );
    const thread = readRecord(response, "thread");
    threadId = readString(thread, "id") ?? request.resumeSessionId ?? "";
    if (!threadId) throw new CodexRpcError("thread/start", "missing thread id");
    const resolvedModel = readString(response, "model");
    channel.push({
      type: "session",
      nativeSessionId: threadId,
      ...(resolvedModel ? { model: resolvedModel } : {}),
    });
  } catch (error) {
    if (error instanceof CodexRpcError && request.resumeSessionId) {
      throw new AgentHarnessError("codex", "resume_failed", `Codex: ${error.message}`, {
        cause: error,
      });
    }
    throw toHarnessError(error);
  }

  try {
    await call("turn/start", {
      threadId,
      input: [{ type: "text", text: request.prompt, text_elements: [] }],
      ...(request.selection.thought ? { effort: request.selection.thought } : {}),
    });
  } catch (error) {
    throw toHarnessError(error);
  }

  for await (const record of inbox) {
    const method = readString(record, "method") ?? "";
    const id = readNumber(record, "id");
    if (id !== undefined) {
      const result = await handleServerRequest(
        request,
        method,
        readRecord(record, "params"),
        state,
        channel,
      );
      process.send(
        result.ok
          ? { id, result: result.value }
          : { id, error: { code: -32601, message: result.message } },
      );
      continue;
    }
    const params = readRecord(record, "params");
    if (method === "turn/completed") {
      const turn = readRecord(params, "turn");
      const status = readString(turn, "status");
      if (status === "failed" || status === "interrupted") {
        const message =
          readString(readRecord(turn, "error"), "message") ?? state.lastError ?? `turn ${status}`;
        throw new AgentHarnessError("codex", "failed", `Codex: ${message}`);
      }
      break;
    }
    for (const event of state.parseNotification(method, params)) channel.push(event);
  }
  process.endInput();
  await reader;
}

function toHarnessError(error: unknown): Error {
  if (error instanceof CodexRpcError) {
    return new AgentHarnessError("codex", "failed", `Codex ${error.method}: ${error.message}`, {
      cause: error,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

type ServerRequestResult = { ok: true; value: unknown } | { ok: false; message: string };

async function handleServerRequest(
  request: AgentHarnessRunRequest,
  method: string,
  params: JsonRecord | undefined,
  state: CodexStreamState,
  channel: EventChannel<AgentHarnessEvent>,
): Promise<ServerRequestResult> {
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  ) {
    const itemId = readString(params, "itemId") ?? `codex-approval-${Date.now()}`;
    const isCommand = method === "item/commandExecution/requestApproval";
    const command = readString(params, "command");
    if (!state.hasToolCall(itemId)) {
      for (const event of state.registerToolCall(
        itemId,
        isCommand ? "Bash" : "Edit",
        isCommand ? "commandExecution" : "fileChange",
        isCommand ? { command: command ?? "" } : {},
      )) {
        channel.push(event);
      }
    }
    const reason = readString(params, "reason");
    const decision = await raceAbort(
      request.requestApproval({
        callId: itemId,
        toolName: state.toolName(itemId) ?? (isCommand ? "Bash" : "Edit"),
        input: state.toolInput(itemId) ?? (isCommand ? { command: command ?? "" } : {}),
        ...(reason ? { reason } : {}),
      }),
      request.abortSignal,
    );
    return {
      ok: true,
      value: {
        decision:
          decision.decision === "allow"
            ? "accept"
            : decision.decision === "allow_session"
              ? "acceptForSession"
              : "decline",
      },
    };
  }
  // 其余交互（MCP elicitation、额外权限申请、向用户提问）ZCode 暂不桥接：明确拒绝，
  // 让 Codex 按“用户拒绝”继续，而不是无限等待。
  return { ok: false, message: `ZCode does not support ${method}` };
}

/** Codex app-server 通知 → 归一化事件（纯解析，便于单测）。 */
export class CodexStreamState {
  readonly #tools = new Map<string, { name: string; input: Record<string, unknown> }>();
  readonly #streamedItems = new Set<string>();
  #usageBaseline: ModelUsage | undefined;
  #textSinceTool = false;
  #lastMessageItem: string | undefined;
  lastError: string | undefined;

  hasToolCall(id: string): boolean {
    return this.#tools.has(id);
  }

  toolName(id: string): string | undefined {
    return this.#tools.get(id)?.name;
  }

  toolInput(id: string): Record<string, unknown> | undefined {
    return this.#tools.get(id)?.input;
  }

  registerToolCall(
    id: string,
    name: string,
    nativeName: string,
    input: Record<string, unknown>,
  ): AgentHarnessEvent[] {
    if (this.#tools.has(id)) return [];
    this.#tools.set(id, { name, input });
    this.#textSinceTool = false;
    return [{ type: "tool_call", call: { id, name, nativeName, input } }];
  }

  parseNotification(method: string, params: JsonRecord | undefined): AgentHarnessEvent[] {
    switch (method) {
      case "item/agentMessage/delta":
        return this.#text(readString(params, "itemId"), readString(params, "delta"));
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const itemId = readString(params, "itemId");
        const delta = readString(params, "delta");
        if (!delta) return [];
        if (itemId) this.#streamedItems.add(itemId);
        return [{ type: "reasoning_delta", text: delta }];
      }
      case "item/started":
        return this.#itemStarted(readRecord(params, "item"));
      case "item/completed":
        return this.#itemCompleted(readRecord(params, "item"));
      case "thread/tokenUsage/updated":
        return this.#usage(readRecord(params, "tokenUsage"));
      case "error": {
        const error = readRecord(params, "error");
        this.lastError = readString(error, "message") ?? this.lastError;
        return [];
      }
      default:
        return [];
    }
  }

  #text(itemId: string | undefined, delta: string | undefined): AgentHarnessEvent[] {
    if (!delta) return [];
    const events: AgentHarnessEvent[] = [];
    if (itemId && itemId !== this.#lastMessageItem) {
      // 同一步内连续的两条 agentMessage 之间补一个段落分隔。
      if (this.#textSinceTool) events.push({ type: "text_delta", text: "\n\n" });
      this.#lastMessageItem = itemId;
    }
    if (itemId) this.#streamedItems.add(itemId);
    this.#textSinceTool = true;
    events.push({ type: "text_delta", text: delta });
    return events;
  }

  #itemStarted(item: JsonRecord | undefined): AgentHarnessEvent[] {
    const id = readString(item, "id");
    if (!item || !id) return [];
    switch (readString(item, "type")) {
      case "commandExecution":
        return this.registerToolCall(id, "Bash", "commandExecution", {
          command: readString(item, "command") ?? "",
        });
      case "fileChange":
        return this.#fileChangeCall(id, item);
      case "mcpToolCall": {
        const server = readString(item, "server") ?? "mcp";
        const tool = readString(item, "tool") ?? "tool";
        return this.registerToolCall(
          id,
          `mcp__${server}__${tool}`,
          "mcpToolCall",
          toInput(item.arguments),
        );
      }
      case "dynamicToolCall":
        return this.registerToolCall(
          id,
          readString(item, "tool") ?? "tool",
          "dynamicToolCall",
          toInput(item.arguments),
        );
      case "webSearch":
        return this.registerToolCall(id, "WebSearch", "webSearch", {
          query: readString(item, "query") ?? "",
        });
      default:
        return [];
    }
  }

  #fileChangeCall(id: string, item: JsonRecord): AgentHarnessEvent[] {
    const changes = readCodexFileChanges(item);
    const first = changes[0];
    const name = changes.length === 1 && first?.kind === "add" ? "Write" : "Edit";
    const input: Record<string, unknown> = first
      ? {
          file_path: first.filePath,
          ...(changes.length === 1 && first.kind === "add" && first.newText !== undefined
            ? { content: first.newText }
            : {}),
          ...(changes.length > 1 ? { files: changes.map((change) => change.filePath) } : {}),
        }
      : {};
    const known = this.#tools.get(id);
    if (known) {
      // 审批请求先于 item/started 到达时，补全输入（卡片已存在，不重复发 tool_call）。
      known.input = { ...known.input, ...input };
      return [];
    }
    return this.registerToolCall(id, name, "fileChange", input);
  }

  #itemCompleted(item: JsonRecord | undefined): AgentHarnessEvent[] {
    const id = readString(item, "id");
    if (!item || !id) return [];
    const type = readString(item, "type");
    switch (type) {
      case "agentMessage": {
        if (this.#streamedItems.has(id)) return [];
        return this.#text(id, readString(item, "text"));
      }
      case "reasoning": {
        if (this.#streamedItems.has(id)) return [];
        const text = [...readArray(item, "summary"), ...readArray(item, "content")]
          .filter((part): part is string => typeof part === "string")
          .join("\n\n");
        return text ? [{ type: "reasoning_delta", text }] : [];
      }
      case "plan": {
        const text = readString(item, "text");
        return text ? [{ type: "reasoning_delta", text }] : [];
      }
      case "commandExecution": {
        const events = this.#itemStarted(item);
        const status = readString(item, "status");
        const exitCode = readNumber(item, "exitCode");
        const output = readString(item, "aggregatedOutput") ?? "";
        const isError =
          status === "failed" ||
          status === "declined" ||
          (exitCode !== undefined && exitCode !== 0);
        events.push({
          type: "tool_result",
          callId: id,
          output: output || (status === "declined" ? "Command declined by the user." : ""),
          isError,
        });
        return events;
      }
      case "fileChange": {
        const events = this.#itemStarted(item);
        const status = readString(item, "status");
        const isError = status === "failed" || status === "declined";
        const changes = readCodexFileChanges(item);
        events.push({
          type: "tool_result",
          callId: id,
          output: isError
            ? `Patch ${status}.`
            : changes.map((change) => `${change.kind} ${change.filePath}`).join("\n"),
          isError,
          ...(isError ? {} : { fileChanges: changes }),
        });
        return events;
      }
      case "mcpToolCall":
      case "dynamicToolCall": {
        const events = this.#itemStarted(item);
        const error = readRecord(item, "error");
        const status = readString(item, "status");
        events.push({
          type: "tool_result",
          callId: id,
          output: error
            ? (readString(error, "message") ?? "error")
            : stringifyToolOutput(item.result ?? item.contentItems),
          isError: Boolean(error) || status === "failed",
        });
        return events;
      }
      case "webSearch": {
        const events = this.#itemStarted(item);
        events.push({
          type: "tool_result",
          callId: id,
          output: readString(item, "query") ?? "",
          isError: false,
        });
        return events;
      }
      default:
        return [];
    }
  }

  #usage(tokenUsage: JsonRecord | undefined): AgentHarnessEvent[] {
    const total = toCodexUsage(readRecord(tokenUsage, "total"));
    const last = toCodexUsage(readRecord(tokenUsage, "last"));
    if (!total) return [];
    // 线程累计用量减去本轮开始前的累计值，得到本轮用量。
    if (!this.#usageBaseline) this.#usageBaseline = subtractUsage(total, last ?? {});
    return [{ type: "usage", usage: subtractUsage(total, this.#usageBaseline) }];
  }
}

function subtractUsage(total: ModelUsage, baseline: ModelUsage): ModelUsage {
  const result: ModelUsage = {};
  for (const field of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
  ] as const) {
    const value = total[field];
    if (value === undefined) continue;
    result[field] = Math.max(0, value - (baseline[field] ?? 0));
  }
  return result;
}

function toInput(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  return record ? { ...record } : value === undefined || value === null ? {} : { arguments: value };
}

/** fileChange.changes：add/delete 的 diff 字段是文件全文，update 是 unified diff。 */
export function readCodexFileChanges(item: JsonRecord): AgentHarnessFileChange[] {
  return readArray(item, "changes").flatMap((entry): AgentHarnessFileChange[] => {
    const change = asRecord(entry);
    const filePath = readString(change, "path");
    if (!filePath) return [];
    const diff = readString(change, "diff") ?? "";
    const kindRecord = readRecord(change, "kind");
    const kind = readString(kindRecord, "type") ?? readString(change, "kind") ?? "update";
    if (kind === "add") return [{ filePath, kind: "add", oldText: "", newText: diff }];
    if (kind === "delete") return [{ filePath, kind: "delete", oldText: diff, newText: "" }];
    const movePath = readString(kindRecord, "move_path");
    return [{ filePath: movePath ?? filePath, kind: "update", unifiedDiff: diff }];
  });
}
