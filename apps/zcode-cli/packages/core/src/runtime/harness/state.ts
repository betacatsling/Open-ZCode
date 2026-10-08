import {
  SESSION_ENTRY_HARNESS_STATE,
  SessionEventType,
  type AgentHarnessSelection,
  type ExternalAgentHarnessId,
  type SessionHarnessChangedPayload,
  type TraceContext,
  type TurnInputIntentMetadata,
} from "@zcode/contracts";
import {
  agentHarnessSelectionSchema,
  isExternalAgentHarness,
  normalizeAgentHarnessSelection,
  sameAgentHarnessSelection,
  ZCODE_NATIVE_HARNESS_ID,
} from "@zcode/shared/agent-harness";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * Session 级 harness 状态。
 *
 * - selection：用户在前端为该会话选择的 harness（以及 harness 自己的模型 / 思考档位），
 *   随 Submission 一起到达并在开跑时应用，与 mode / modelSelection 同一条路径。
 * - binding：上一次外部 harness 运行留下的原生会话 id（Claude session_id、Codex threadId、
 *   pi session id）。后续轮次只要 harness 不变就用它续接；换 harness 时不会复用。
 */
export interface RuntimeHarnessBinding {
  readonly harness: ExternalAgentHarnessId;
  readonly nativeSessionId: string;
}

export interface RuntimeHarnessState {
  selection: AgentHarnessSelection;
  binding?: RuntimeHarnessBinding;
  /** 用户在审批卡片上选择“本会话内允许”的工具名（按 harness 隔离，切换时清空）。 */
  sessionApprovedTools: Set<string>;
}

export function createRuntimeHarnessState(): RuntimeHarnessState {
  return { selection: { harness: ZCODE_NATIVE_HARNESS_ID }, sessionApprovedTools: new Set() };
}

export interface PersistedHarnessState {
  readonly selection: AgentHarnessSelection;
  readonly binding?: RuntimeHarnessBinding;
}

/** 本轮实际使用的 harness：Submission 携带的选择优先，否则沿用会话当前选择。 */
export function resolveTurnHarnessSelection(
  runtime: Pick<AgentRuntimeInternal, "harnessState">,
  intent: TurnInputIntentMetadata | undefined,
): AgentHarnessSelection {
  return intent?.harness
    ? normalizeAgentHarnessSelection(intent.harness)
    : runtime.harnessState.selection;
}

export function isExternalHarnessSelection(
  selection: AgentHarnessSelection,
): selection is AgentHarnessSelection & { harness: ExternalAgentHarnessId } {
  return isExternalAgentHarness(selection.harness);
}

/** 应用会话 harness 选择：变化时持久化并发出 SessionHarnessChanged（投影据此更新 config.harness）。 */
export async function applyHarnessSelection(
  runtime: AgentRuntimeInternal,
  next: AgentHarnessSelection,
  options: { source: SessionHarnessChangedPayload["source"]; traceContext: TraceContext },
): Promise<boolean> {
  const selection = normalizeAgentHarnessSelection(next);
  const previous = runtime.harnessState.selection;
  if (sameAgentHarnessSelection(previous, selection)) return false;
  runtime.harnessState.selection = selection;
  if (previous.harness !== selection.harness) runtime.harnessState.sessionApprovedTools.clear();
  await persistHarnessState(runtime);
  await emitHarnessChanged(runtime, {
    harness: selection,
    previousHarness: previous,
    source: options.source,
    traceContext: options.traceContext,
  });
  return true;
}

export async function bindHarnessSession(
  runtime: AgentRuntimeInternal,
  binding: RuntimeHarnessBinding | undefined,
): Promise<void> {
  const current = runtime.harnessState.binding;
  if (
    current?.harness === binding?.harness &&
    current?.nativeSessionId === binding?.nativeSessionId
  ) {
    return;
  }
  runtime.harnessState.binding = binding;
  await persistHarnessState(runtime);
}

async function emitHarnessChanged(
  runtime: AgentRuntimeInternal,
  input: {
    harness: AgentHarnessSelection;
    previousHarness?: AgentHarnessSelection;
    source: SessionHarnessChangedPayload["source"];
    traceContext: TraceContext;
  },
): Promise<void> {
  const payload: SessionHarnessChangedPayload = {
    harness: input.harness,
    ...(input.previousHarness ? { previousHarness: input.previousHarness } : {}),
    source: input.source,
  };
  const event = runtime.createEvent(
    SessionEventType.SessionHarnessChanged,
    payload,
    input.traceContext,
  );
  await runtime.appendEvent(event, input.traceContext);
}

async function persistHarnessState(runtime: AgentRuntimeInternal): Promise<void> {
  if (!runtime.sessionStore?.saveSessionEntry) return;
  const timestamp = Date.now();
  const data: PersistedHarnessState = {
    selection: runtime.harnessState.selection,
    ...(runtime.harnessState.binding ? { binding: runtime.harnessState.binding } : {}),
  };
  try {
    await runtime.sessionStore.saveSessionEntry({
      id: `${runtime.sessionId}:runtime-harness-state`,
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_HARNESS_STATE,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      data,
    });
  } catch (error) {
    runtime.logger?.warn("Session harness state persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.harness_state.persist_failed",
      harness: data.selection.harness,
      module: "core.runtime",
      status: "failed",
    });
  }
}

export function parsePersistedHarnessState(value: unknown): PersistedHarnessState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { selection?: unknown; binding?: unknown };
  const selection = agentHarnessSelectionSchema.safeParse(record.selection);
  if (!selection.success) return undefined;
  const binding = record.binding as { harness?: unknown; nativeSessionId?: unknown } | undefined;
  const validBinding =
    binding &&
    typeof binding.harness === "string" &&
    isExternalAgentHarness(binding.harness) &&
    typeof binding.nativeSessionId === "string" &&
    binding.nativeSessionId.length > 0
      ? { harness: binding.harness, nativeSessionId: binding.nativeSessionId }
      : undefined;
  return { selection: selection.data, ...(validBinding ? { binding: validBinding } : {}) };
}

/**
 * cold resume：恢复会话 harness 选择与原生会话绑定。
 * 投影经 config 种子（getHarnessSelection）拿到当前 harness，这里不补发事件。
 */
export async function restoreHarnessState(runtime: AgentRuntimeInternal): Promise<void> {
  const entries = await runtime.sessionStore?.sessionEntries?.({
    sessionID: runtime.sessionId,
    type: SESSION_ENTRY_HARNESS_STATE,
  });
  const saved = parsePersistedHarnessState(entries?.at(-1)?.data);
  if (!saved) return;
  runtime.harnessState.selection = normalizeAgentHarnessSelection(saved.selection);
  runtime.harnessState.binding = saved.binding;
}

/** AgentRuntime 公共方法：当前会话 harness 选择。 */
export function getHarnessSelection(this: AgentRuntimeInternal): AgentHarnessSelection {
  return { ...this.harnessState.selection };
}

/** AgentRuntime 公共方法：显式切换会话 harness（createSession.config / 设置面板）。 */
export async function setHarnessSelection(
  this: AgentRuntimeInternal,
  selection: AgentHarnessSelection,
  traceContext?: TraceContext,
): Promise<boolean> {
  return applyHarnessSelection(this, selection, {
    source: "command",
    traceContext: traceContext ?? this.rootTraceContext,
  });
}
