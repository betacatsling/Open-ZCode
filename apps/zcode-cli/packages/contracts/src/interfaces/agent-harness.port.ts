import type { AgentHarnessSelection, ExternalAgentHarnessId } from "@zcode/shared/agent-harness";
import type { ModelUsage } from "../model/index.js";
import type { TraceContext } from "../tracing/tracer.js";
import type { CollaborationMode } from "./session.port.js";

export type {
  AgentHarnessId,
  AgentHarnessSelection,
  ExternalAgentHarnessId,
} from "@zcode/shared/agent-harness";

/**
 * 外部 Agent Harness（Claude Code / Codex / pi）的运行端口。
 *
 * 外部 harness 接管整个 agent loop：它自己调用模型、执行工具、管理上下文与会话。
 * ZCode runtime 只负责把用户输入交给它、把它的事件投影为 ZCode 原生的消息 / 工具卡片 /
 * 审批卡片，并在后续轮次续接同一个 harness 会话。adapter 负责进程与协议细节，
 * core 只依赖下面这些归一化后的契约。
 */

/** 一次文件改动；至少提供 unifiedDiff、structuredPatch 或 old/new 全文之一用于展示 diff。 */
export interface AgentHarnessFileChange {
  readonly filePath: string;
  readonly kind: "add" | "update" | "delete";
  readonly unifiedDiff?: string;
  readonly oldText?: string;
  readonly newText?: string;
  readonly structuredPatch?: readonly AgentHarnessDiffHunk[];
}

export interface AgentHarnessDiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

/**
 * harness 的一次工具调用。`name`/`input` 已映射成 ZCode 同名工具（Bash、Read、Write、Edit、
 * Grep、Glob、WebSearch、WebFetch、TodoWrite 等）的输入形状，使 UI 复用原生工具卡片；
 * 无法映射的工具保留 harness 自己的名字，按通用工具卡片展示。
 */
export interface AgentHarnessToolCall {
  readonly id: string;
  readonly name: string;
  readonly nativeName: string;
  readonly input: Record<string, unknown>;
}

export type AgentHarnessEvent =
  /** harness 自己的会话 / 线程 id，用于后续轮次续接。 */
  | { readonly type: "session"; readonly nativeSessionId: string; readonly model?: string }
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "reasoning_delta"; readonly text: string }
  | { readonly type: "tool_call"; readonly call: AgentHarnessToolCall }
  | {
      readonly type: "tool_result";
      readonly callId: string;
      readonly output: string;
      readonly isError: boolean;
      readonly fileChanges?: readonly AgentHarnessFileChange[];
    }
  /** 本次运行（一个 ZCode turn）的累计用量；可多次上报，后者覆盖前者。 */
  | { readonly type: "usage"; readonly usage: ModelUsage }
  /** 非致命提示（例如 harness 自身的告警），以 reasoning 形式展示。 */
  | { readonly type: "notice"; readonly message: string };

export interface AgentHarnessApprovalRequest {
  /** 对应已经发出的 tool_call 事件 id；approval 之前必须先发 tool_call。 */
  readonly callId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly reason?: string;
}

export interface AgentHarnessApprovalDecision {
  readonly decision: "allow" | "allow_session" | "deny";
  readonly reason?: string;
}

export interface AgentHarnessPermissionProfile {
  readonly mode: CollaborationMode;
  readonly planEnabled: boolean;
}

export interface AgentHarnessRunRequest {
  readonly harness: ExternalAgentHarnessId;
  readonly selection: AgentHarnessSelection;
  readonly cwd: string;
  /** 交给 harness 的本轮用户输入（新会话时已包含 ZCode 侧的历史交接摘要）。 */
  readonly prompt: string;
  /** 续接的 harness 会话 id；缺省表示新建会话。 */
  readonly resumeSessionId?: string;
  readonly permission: AgentHarnessPermissionProfile;
  readonly abortSignal: AbortSignal;
  readonly requestApproval: (
    request: AgentHarnessApprovalRequest,
  ) => Promise<AgentHarnessApprovalDecision>;
  readonly traceContext?: TraceContext;
}

export interface AgentHarnessAvailability {
  readonly harness: ExternalAgentHarnessId;
  readonly available: boolean;
  readonly executablePath?: string;
  readonly version?: string;
}

export type AgentHarnessErrorCode =
  | "not_installed"
  /** 续接失败且尚未产生任何输出；调用方可改为新会话 + 历史交接重试一次。 */
  | "resume_failed"
  | "failed";

export class AgentHarnessError extends Error {
  readonly code: AgentHarnessErrorCode;
  readonly harness: ExternalAgentHarnessId;

  constructor(
    harness: ExternalAgentHarnessId,
    code: AgentHarnessErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AgentHarnessError";
    this.code = code;
    this.harness = harness;
  }
}

export function isAgentHarnessError(error: unknown): error is AgentHarnessError {
  return error instanceof AgentHarnessError;
}

export interface AgentHarnessRunnerPort {
  run(request: AgentHarnessRunRequest): AsyncIterable<AgentHarnessEvent>;
  detect(): Promise<readonly AgentHarnessAvailability[]>;
}
