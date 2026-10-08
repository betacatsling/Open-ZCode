import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AgentHarnessError,
  type AgentHarnessEvent,
  type AgentHarnessFileChange,
  type AgentHarnessPermissionProfile,
  type AgentHarnessRunRequest,
  type ModelUsage,
} from "@zcode/contracts";
import { raceAbort, type EventChannel } from "./channel.js";
import { runHarnessProcess, type HarnessDriver, type HarnessDriverContext } from "./driver.js";
import {
  asRecord,
  readBoolean,
  readRecord,
  readString,
  stringifyToolOutput,
  type JsonRecord,
} from "./json-record.js";
import { describeHarnessExit, type HarnessProcess } from "./process.js";
import { addModelUsage, toPiUsage } from "./usage.js";

/**
 * pi 驱动：`pi --mode rpc`（JSONL 命令 + 事件流）。
 *
 * pi 本身没有审批 / 沙箱机制（设计上把这件事交给扩展）。ZCode 随驱动下发一个很小的
 * 审批扩展（`-e zcode-approval.mjs`）：它在 `tool_call` 钩子里调用 `ctx.ui.confirm`，
 * RPC 模式下这会变成 `extension_ui_request`，由驱动转成 ZCode 审批卡片；用户拒绝时
 * 扩展返回 `{ block: true }`。规划模式则直接把工具集限制为只读工具。
 */
export const PI_READ_ONLY_TOOLS = "read,grep,find,ls";
export const PI_APPROVAL_TITLE = "zcode-approval";
export const PI_APPROVAL_POLICY_ENV = "ZCODE_PI_APPROVAL_POLICY";

export type PiApprovalPolicy = "read-only" | "ask-mutations" | "ask-bash" | "off";

export function piApprovalPolicy(permission: AgentHarnessPermissionProfile): PiApprovalPolicy {
  if (permission.planEnabled || permission.mode === "plan") return "read-only";
  switch (permission.mode) {
    case "yolo":
      return "off";
    case "edit":
    case "auto":
      return "ask-bash";
    case "build":
    default:
      return "ask-mutations";
  }
}

export const PI_APPROVAL_EXTENSION_SOURCE = `// 由 ZCode 生成：把 pi 的工具调用接入 ZCode 审批卡片。
const policy = process.env.${PI_APPROVAL_POLICY_ENV} || "off";
const gated =
  policy === "ask-mutations" ? new Set(["bash", "edit", "write"])
  : policy === "ask-bash" ? new Set(["bash"])
  : new Set();

export default function zcodeApproval(pi) {
  pi.on("tool_call", async (event, ctx) => {
    if (!gated.has(event.toolName) || !ctx.hasUI) return undefined;
    const approved = await ctx.ui.confirm(
      ${JSON.stringify(PI_APPROVAL_TITLE)},
      JSON.stringify({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input }),
    );
    return approved ? undefined : { block: true, reason: "The user denied this tool call in ZCode." };
  });
}
`;

export function buildPiArgs(
  request: AgentHarnessRunRequest,
  sessionId: string,
  extensionPath: string | undefined,
): string[] {
  const args = ["--mode", "rpc", "--session-id", sessionId];
  if (request.selection.model) args.push("--model", request.selection.model);
  if (request.selection.thought) args.push("--thinking", request.selection.thought);
  if (piApprovalPolicy(request.permission) === "read-only")
    args.push("--tools", PI_READ_ONLY_TOOLS);
  if (extensionPath) args.push("--extension", extensionPath);
  return args;
}

async function ensureApprovalExtension(supportDir: string): Promise<string> {
  const target = path.join(supportDir, "pi", "zcode-approval.mjs");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, PI_APPROVAL_EXTENSION_SOURCE, "utf8");
  return target;
}

export const piDriver: HarnessDriver = {
  harness: "pi",
  run(request: AgentHarnessRunRequest, context: HarnessDriverContext) {
    // pi 的 --session-id 语义是“存在则打开，不存在则创建”，由 ZCode 生成新会话 id。
    const sessionId = request.resumeSessionId ?? randomUUID();
    const policy = piApprovalPolicy(request.permission);
    let extensionPath: string | undefined;
    const prepared =
      policy === "ask-mutations" || policy === "ask-bash"
        ? ensureApprovalExtension(context.supportDir).then((value) => {
            extensionPath = value;
          })
        : Promise.resolve();
    return runHarnessProcess(
      request,
      () => {
        // 扩展文件需要异步写入：先返回一个延迟启动的进程代理。
        const proxy = createDeferredProcess(async () => {
          await prepared;
          return context.spawnProcess({
            executablePath: context.executablePath,
            args: buildPiArgs(request, sessionId, extensionPath),
            cwd: request.cwd,
            env: { ...context.env, [PI_APPROVAL_POLICY_ENV]: policy },
            platform: context.platform,
          });
        });
        return proxy;
      },
      (process, channel) => pumpPi(request, sessionId, process, channel),
    );
  },
};

async function pumpPi(
  request: AgentHarnessRunRequest,
  sessionId: string,
  process: HarnessProcess,
  channel: EventChannel<AgentHarnessEvent>,
): Promise<void> {
  channel.push({ type: "session", nativeSessionId: sessionId });
  const state = new PiStreamState();
  process.send({ id: "zcode-prompt", type: "prompt", message: request.prompt });
  let settled = false;
  for await (const raw of process.records) {
    const record = asRecord(raw);
    if (!record) continue;
    const type = readString(record, "type");
    if (type === "response") {
      if (readString(record, "id") === "zcode-prompt") {
        if (readBoolean(record, "success") === false) {
          throw new AgentHarnessError(
            "pi",
            "failed",
            `pi: ${readString(record, "error") ?? "prompt rejected"}`,
          );
        }
        if (readString(readRecord(record, "data"), "disposition") === "handled") {
          settled = true;
          break;
        }
      }
      continue;
    }
    if (type === "extension_ui_request") {
      await answerUiRequest(request, process, record, state, channel);
      continue;
    }
    for (const event of state.parse(record)) channel.push(event);
    if (type === "agent_settled") {
      settled = true;
      break;
    }
  }
  process.endInput();
  const exit = await process.exited;
  if (!settled) throw new AgentHarnessError("pi", "failed", `pi: ${describeHarnessExit(exit)}`);
  if (state.failure) throw new AgentHarnessError("pi", "failed", `pi: ${state.failure}`);
}

async function answerUiRequest(
  request: AgentHarnessRunRequest,
  process: HarnessProcess,
  record: JsonRecord,
  state: PiStreamState,
  channel: EventChannel<AgentHarnessEvent>,
): Promise<void> {
  const id = readString(record, "id");
  const method = readString(record, "method");
  if (!id || !["confirm", "select", "input", "editor"].includes(method ?? "")) return;
  if (method !== "confirm" || readString(record, "title") !== PI_APPROVAL_TITLE) {
    // 其它扩展的交互对话 ZCode 无法呈现：按取消处理，避免 pi 阻塞等待。
    process.send({ type: "extension_ui_response", id, cancelled: true });
    return;
  }
  let payload: JsonRecord | undefined;
  try {
    payload = asRecord(JSON.parse(readString(record, "message") ?? ""));
  } catch {
    payload = undefined;
  }
  const nativeName = readString(payload, "toolName") ?? "tool";
  const callId = readString(payload, "toolCallId") ?? `pi-${id}`;
  const nativeInput = (readRecord(payload, "input") ?? {}) as Record<string, unknown>;
  const events = state.registerToolCall(callId, nativeName, nativeInput);
  for (const event of events) channel.push(event);
  const call = state.toolCall(callId);
  const decision = await raceAbort(
    request.requestApproval({
      callId,
      toolName: call?.name ?? nativeName,
      input: call?.input ?? nativeInput,
    }),
    request.abortSignal,
  );
  process.send({ type: "extension_ui_response", id, confirmed: decision.decision !== "deny" });
}

/** pi 工具名 / 参数 → ZCode 同名工具（复用原生卡片）。 */
export function mapPiToolCall(
  nativeName: string,
  args: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  const filePath = typeof args.path === "string" ? args.path : undefined;
  switch (nativeName) {
    case "bash":
      return {
        name: "Bash",
        input: { command: args.command ?? "", ...(args.timeout ? { timeout: args.timeout } : {}) },
      };
    case "read":
      return {
        name: "Read",
        input: {
          file_path: filePath ?? "",
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        },
      };
    case "write":
      return { name: "Write", input: { file_path: filePath ?? "", content: args.content ?? "" } };
    case "edit": {
      const edits = Array.isArray(args.edits) ? args.edits.map(asRecord) : [];
      const first = edits[0];
      return {
        name: "Edit",
        input: {
          file_path: filePath ?? "",
          old_string: readString(first, "oldText") ?? "",
          new_string: readString(first, "newText") ?? "",
          ...(edits.length > 1 ? { edits: args.edits } : {}),
        },
      };
    }
    case "grep":
      return {
        name: "Grep",
        input: {
          pattern: args.pattern ?? "",
          ...(filePath ? { path: filePath } : {}),
          ...(args.glob ? { glob: args.glob } : {}),
        },
      };
    case "find":
      return {
        name: "Glob",
        input: { pattern: args.pattern ?? "", ...(filePath ? { path: filePath } : {}) },
      };
    case "ls":
      return { name: "LS", input: { path: filePath ?? "." } };
    default:
      return { name: nativeName, input: args };
  }
}

/** pi RPC 事件 → 归一化事件（纯解析，便于单测）。 */
export class PiStreamState {
  readonly #tools = new Map<
    string,
    {
      name: string;
      input: Record<string, unknown>;
      nativeName: string;
      args: Record<string, unknown>;
    }
  >();
  #usage: ModelUsage | undefined;
  failure: string | undefined;

  toolCall(id: string): { name: string; input: Record<string, unknown> } | undefined {
    return this.#tools.get(id);
  }

  registerToolCall(
    id: string,
    nativeName: string,
    args: Record<string, unknown>,
  ): AgentHarnessEvent[] {
    if (this.#tools.has(id)) return [];
    const mapped = mapPiToolCall(nativeName, args);
    this.#tools.set(id, { ...mapped, nativeName, args });
    return [
      { type: "tool_call", call: { id, name: mapped.name, nativeName, input: mapped.input } },
    ];
  }

  parse(raw: unknown): AgentHarnessEvent[] {
    const record = asRecord(raw);
    switch (readString(record, "type")) {
      case "message_update": {
        const event = readRecord(record, "assistantMessageEvent");
        const delta = readString(event, "delta");
        if (!delta) return [];
        const type = readString(event, "type");
        if (type === "text_delta") return [{ type: "text_delta", text: delta }];
        if (type === "thinking_delta") return [{ type: "reasoning_delta", text: delta }];
        return [];
      }
      case "message_end": {
        const message = readRecord(record, "message");
        if (readString(message, "role") !== "assistant") return [];
        if (readString(message, "stopReason") === "error") {
          this.failure = readString(message, "errorMessage") ?? "model request failed";
        } else if (readString(message, "stopReason") !== "aborted") {
          this.failure = undefined;
        }
        const usage = toPiUsage(readRecord(message, "usage"));
        if (!usage) return [];
        this.#usage = addModelUsage(this.#usage, usage);
        return [{ type: "usage", usage: this.#usage }];
      }
      case "tool_execution_start": {
        const id = readString(record, "toolCallId");
        if (!id) return [];
        return this.registerToolCall(
          id,
          readString(record, "toolName") ?? "tool",
          (readRecord(record, "args") ?? {}) as Record<string, unknown>,
        );
      }
      case "tool_execution_end": {
        const id = readString(record, "toolCallId");
        if (!id) return [];
        const events = this.registerToolCall(
          id,
          readString(record, "toolName") ?? "tool",
          (readRecord(record, "args") ?? {}) as Record<string, unknown>,
        );
        const result = readRecord(record, "result");
        const isError = readBoolean(record, "isError") === true;
        const fileChanges = isError
          ? undefined
          : this.#fileChanges(id, readRecord(result, "details"));
        events.push({
          type: "tool_result",
          callId: id,
          output: stringifyToolOutput(result?.content ?? result),
          isError,
          ...(fileChanges ? { fileChanges } : {}),
        });
        return events;
      }
      default:
        return [];
    }
  }

  #fileChanges(id: string, details: JsonRecord | undefined): AgentHarnessFileChange[] | undefined {
    const tool = this.#tools.get(id);
    const filePath = typeof tool?.args.path === "string" ? tool.args.path : undefined;
    if (!tool || !filePath) return undefined;
    if (tool.nativeName === "edit") {
      const patch = readString(details, "patch");
      return patch ? [{ filePath, kind: "update", unifiedDiff: patch }] : undefined;
    }
    if (tool.nativeName === "write" && typeof tool.args.content === "string") {
      // pi 的 write 不报告旧内容；按新建展示全文。
      return [{ filePath, kind: "add", oldText: "", newText: tool.args.content }];
    }
    return undefined;
  }
}

/** 支持异步准备后再 spawn 的进程代理（接口与真实进程一致）。 */
function createDeferredProcess(start: () => Promise<HarnessProcess>): HarnessProcess {
  const pendingSends: unknown[] = [];
  let real: HarnessProcess | undefined;
  let killed = false;
  let inputEnded = false;
  const ready = start().then(
    (child) => {
      real = child;
      for (const record of pendingSends.splice(0)) child.send(record);
      if (inputEnded) child.endInput();
      if (killed) child.kill();
      return child;
    },
    (error: unknown) => {
      throw error instanceof Error ? error : new Error(String(error));
    },
  );
  return {
    records: {
      async *[Symbol.asyncIterator]() {
        const child = await ready;
        yield* child.records;
      },
    },
    exited: ready.then(
      (child) => child.exited,
      (error: unknown) => ({
        exitCode: null,
        signal: null,
        stderrTail: "",
        nonJsonTail: "",
        spawnError: error instanceof Error ? error : new Error(String(error)),
      }),
    ),
    send(record) {
      if (real) real.send(record);
      else pendingSends.push(record);
    },
    endInput() {
      inputEnded = true;
      real?.endInput();
    },
    kill() {
      killed = true;
      real?.kill();
    },
  };
}
