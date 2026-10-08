import { readFile } from "node:fs/promises";
import path from "node:path";
import { applyPatch, parsePatch, reversePatch } from "diff";
import {
  createModelId,
  createModelProviderId,
  getModelUsageTotalTokens,
  isAgentHarnessError,
  type AgentHarnessApprovalDecision,
  type AgentHarnessApprovalRequest,
  type AgentHarnessEvent,
  type AgentHarnessFileChange,
  type AgentHarnessSelection,
  type AgentHarnessToolCall,
  type DiffHunk,
  type ExternalAgentHarnessId,
  type MessageId,
  type Model,
  type ModelUsage,
  type PartId,
  type SessionEvent,
  type ToolCallId,
  type TraceContext,
  type TurnId,
} from "@zcode/contracts";
import {
  formatAgentHarnessApprovalReason,
  getAgentHarnessCatalogEntry,
} from "@zcode/shared/agent-harness";
import { createRuntimeAssistantEntry } from "../../agent/message-history.js";
import { createStructuredPatch } from "../../tool/diff.js";
import { createToolResultDisplay } from "../../tool/executor/result-display.js";
import { SessionEventType, createMessageId, createPartId, createToolCallId } from "../deps.js";
import { toTokenUsageInfo } from "../helpers/index.js";
import { buildTurnFileChangeSummary, recordTurnFileChange } from "../helpers/turn-file-changes.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildHarnessHandoffPrompt } from "./handoff.js";
import { bindHarnessSession } from "./state.js";

/** 工具输出写入 transcript 前的上限（展示用；harness 自己保留完整输出）。 */
const MAX_TOOL_OUTPUT_CHARS = 64_000;

export interface ExternalHarnessTurnParams {
  readonly selection: AgentHarnessSelection & { harness: ExternalAgentHarnessId };
  /** 本轮交给 harness 的输入（slash command 已展开）。 */
  readonly prompt: string;
  readonly events: SessionEvent[];
  readonly turnId: TurnId;
  readonly traceContext: TraceContext;
  readonly abortSignal: AbortSignal;
  readonly userMessageId: MessageId;
}

export interface ExternalHarnessTurnResult {
  readonly response: string;
  readonly tokenCount: number;
  readonly toolCallCount: number;
  readonly historyRoundCount: number;
}

/**
 * 外部 harness 执行一个 ZCode turn。
 *
 * harness 自己跑完整个 agent loop；这里把它的归一化事件投影成与 ZCode 原生 turn 相同的
 * 事件与持久化形状（assistant message / step / text & reasoning part / tool part /
 * ModelStreaming / ToolCall* / Permission*），因此 V4 投影、桌面 UI、冷恢复都无需区分来源。
 */
export async function runExternalHarnessTurn(
  runtime: AgentRuntimeInternal,
  params: ExternalHarnessTurnParams,
): Promise<ExternalHarnessTurnResult> {
  const runner = runtime.harnessRunner;
  const harness = params.selection.harness;
  const label = getAgentHarnessCatalogEntry(harness).label;
  if (!runner) {
    throw new Error(`${label} harness is not available in this ZCode host.`);
  }
  const writer = new HarnessTurnWriter(runtime, params);
  const binding = runtime.harnessState.binding;
  let resumeSessionId = binding?.harness === harness ? binding.nativeSessionId : undefined;
  const previousHarness = binding && binding.harness !== harness ? binding.harness : undefined;

  for (let attempt = 0; ; attempt += 1) {
    const prompt = resumeSessionId
      ? params.prompt
      : await buildHandoffPrompt(runtime, params, previousHarness);
    try {
      const run = runner.run({
        harness,
        selection: params.selection,
        cwd: runtime.workingDirectory,
        prompt,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        permission: { mode: runtime.config.mode ?? "build", planEnabled: runtime.getPlanEnabled() },
        abortSignal: params.abortSignal,
        requestApproval: (request) => requestHarnessApproval(runtime, writer, harness, request),
        traceContext: params.traceContext,
      });
      for await (const event of run) {
        if (event.type === "session") {
          await bindHarnessSession(runtime, { harness, nativeSessionId: event.nativeSessionId });
        }
        await writer.handle(event);
      }
      break;
    } catch (error) {
      if (
        attempt === 0 &&
        resumeSessionId &&
        isAgentHarnessError(error) &&
        error.code === "resume_failed" &&
        !writer.hasOutput
      ) {
        // 原生会话已不存在（被清理或换了机器）：改为新会话 + 历史交接重试一次。
        runtime.logger?.warn("Agent harness session resume failed; starting a new session", {
          event: "agent_harness.resume_failed",
          harness,
          module: "core.runtime",
          status: "waiting",
        });
        resumeSessionId = undefined;
        await bindHarnessSession(runtime, undefined);
        continue;
      }
      await writer.fail(error, params.abortSignal.aborted);
      throw error;
    }
  }
  return writer.finish();
}

async function buildHandoffPrompt(
  runtime: AgentRuntimeInternal,
  params: ExternalHarnessTurnParams,
  previousHarness: ExternalAgentHarnessId | undefined,
): Promise<string> {
  if (!runtime.sessionStore) return params.prompt;
  try {
    const messages = await runtime.sessionStore.messages({ sessionID: runtime.sessionId });
    return buildHarnessHandoffPrompt({
      messages,
      excludeMessageId: params.userMessageId,
      ...(previousHarness ? { previousHarness } : {}),
      prompt: params.prompt,
    });
  } catch (error) {
    runtime.logger?.warn("Agent harness handoff transcript unavailable", {
      error: error instanceof Error ? error.message : String(error),
      event: "agent_harness.handoff_failed",
      module: "core.runtime",
      status: "failed",
    });
    return params.prompt;
  }
}

/** ZCode 审批卡片 ⇄ harness 原生审批。 */
async function requestHarnessApproval(
  runtime: AgentRuntimeInternal,
  writer: HarnessTurnWriter,
  harness: ExternalAgentHarnessId,
  request: AgentHarnessApprovalRequest,
): Promise<AgentHarnessApprovalDecision> {
  const toolCallId = await writer.ensureToolCard({
    id: request.callId,
    name: request.toolName,
    nativeName: request.toolName,
    input: request.input,
  });
  if (runtime.harnessState.sessionApprovedTools.has(request.toolName)) {
    return { decision: "allow" };
  }
  const reason = request.reason ?? formatAgentHarnessApprovalReason(harness, request.toolName);
  const requestId = `perm_${crypto.randomUUID()}`;
  await writer.emit(SessionEventType.PermissionRequested, {
    requestId,
    toolCallId,
    toolName: request.toolName,
    riskLevel: "medium",
    reason,
    input: request.input,
    suggestedPermissionUpdates: [],
    optionsPolicy: "session-always-allow",
  });
  try {
    const result = await runtime.permissionBroker.requestPermission(
      {
        requestId,
        sessionId: runtime.sessionId,
        turnId: writer.turnId,
        traceId: writer.traceContext.traceId,
        toolCallId,
        toolName: request.toolName,
        input: request.input,
        mode: runtime.config.mode ?? "build",
        ruleId: `agent-harness:${harness}`,
        reason,
        riskLevel: "medium",
        optionsPolicy: "session-always-allow",
        requestedAt: new Date(),
      },
      { signal: writer.abortSignal },
    );
    await writer.emit(SessionEventType.PermissionResolved, {
      requestId,
      toolCallId,
      decision: result.decision,
      ...(result.reason ? { reason: result.reason } : {}),
    });
    if (result.decision === "allow" || result.decision === "modify") {
      if (result.sessionPermissionUpdates?.length || result.permissionUpdates?.length) {
        runtime.harnessState.sessionApprovedTools.add(request.toolName);
        return { decision: "allow_session" };
      }
      return { decision: "allow" };
    }
    return { decision: "deny", ...(result.reason ? { reason: result.reason } : {}) };
  } catch (error) {
    await writer.emit(SessionEventType.PermissionResolved, {
      requestId,
      toolCallId,
      decision: "deny",
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

interface OpenStep {
  readonly messageId: MessageId;
  readonly createdAt: number;
  text: string;
  reasoning: string;
  textOpen: boolean;
  reasoningOpen: boolean;
  toolCount: number;
  closed: boolean;
}

interface ToolCard {
  readonly toolCallId: ToolCallId;
  readonly partId: PartId;
  readonly messageId: MessageId;
  readonly name: string;
  readonly nativeName: string;
  readonly input: Record<string, unknown>;
  readonly startedAt: number;
  done: boolean;
}

/** 把 harness 事件按“模型步骤”写成 ZCode 的消息、part 与事件。所有写入串行执行。 */
class HarnessTurnWriter {
  readonly turnId: TurnId;
  readonly traceContext: TraceContext;
  readonly abortSignal: AbortSignal;
  readonly #runtime: AgentRuntimeInternal;
  readonly #params: ExternalHarnessTurnParams;
  readonly #tools = new Map<string, ToolCard>();
  #queue: Promise<unknown> = Promise.resolve();
  #step: OpenStep | undefined;
  #modelId: string;
  #usage: ModelUsage = {};
  #reportedUsage: ModelUsage = {};
  #response = "";
  #assistantTexts: string[] = [];
  #stepCount = 0;
  #toolCallCount = 0;
  #tokenCount = 0;
  hasOutput = false;

  constructor(runtime: AgentRuntimeInternal, params: ExternalHarnessTurnParams) {
    this.#runtime = runtime;
    this.#params = params;
    this.turnId = params.turnId;
    this.traceContext = params.traceContext;
    this.abortSignal = params.abortSignal;
    this.#modelId = params.selection.model ?? "default";
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  handle(event: AgentHarnessEvent): Promise<void> {
    return this.#serial(async () => {
      switch (event.type) {
        case "session":
          if (event.model) this.#modelId = event.model;
          return;
        case "text_delta":
          return this.#textDelta(event.text);
        case "reasoning_delta":
          return this.#reasoningDelta(event.text);
        case "notice":
          return this.#reasoningDelta(`${event.message}\n`);
        case "tool_call":
          await this.#toolCall(event.call);
          return;
        case "tool_result":
          return this.#toolResult(event);
        case "usage":
          this.#usage = event.usage;
          return;
      }
    });
  }

  ensureToolCard(call: AgentHarnessToolCall): Promise<ToolCallId> {
    return this.#serial(() => this.#toolCall(call));
  }

  emit(type: SessionEventType, payload: unknown): Promise<void> {
    return this.#serial(() => this.#appendEvent(type, payload));
  }

  async finish(): Promise<ExternalHarnessTurnResult> {
    return this.#serial(async () => {
      await this.#closeStep();
      for (const tool of this.#tools.values()) {
        if (!tool.done)
          await this.#completeTool(
            tool,
            "The harness did not report a result for this tool call.",
            true,
          );
      }
      const text = this.#assistantTexts.join("\n\n").trim();
      if (text) {
        // 只把正文写入 ZCode 的 provider 历史：切回 ZCode 原生 harness 时上下文连续，
        // 而 harness 私有的工具协议 / 推理签名不会污染 ZCode 的模型请求。
        this.#runtime.messageHistory.addEntries([
          createRuntimeAssistantEntry(text, undefined, undefined, this.#identity()),
        ]);
      }
      return {
        response: this.#response,
        tokenCount: this.#tokenCount,
        toolCallCount: this.#toolCallCount,
        historyRoundCount: this.#stepCount,
      };
    });
  }

  async fail(error: unknown, cancelled: boolean): Promise<void> {
    await this.#serial(async () => {
      const step = this.#step;
      if (step && !step.closed) {
        await this.#flushStepParts(step);
        step.closed = true;
        await this.#runtime.persistAssistantMessage(
          step.messageId,
          this.#params.userMessageId,
          step.createdAt,
          {
            completed: Date.now(),
            error: {
              name: error instanceof Error ? error.name : "AgentHarnessError",
              data: {
                message: error instanceof Error ? error.message : String(error),
                ...(cancelled ? { turnResult: "cancelled" } : {}),
              },
            },
          },
          this.traceContext,
          this.#identity() as Model,
        );
      }
      for (const tool of this.#tools.values()) {
        if (!tool.done) {
          await this.#completeTool(
            tool,
            cancelled ? "Cancelled." : "The harness stopped before this tool call finished.",
            true,
          );
        }
      }
    }).catch(() => undefined);
  }

  /** ZCode 侧把 harness 当作“模型提供方”记录：providerId=harness，modelId=harness 报告的模型。 */
  #identity(): Pick<Model, "providerId" | "modelId"> {
    return {
      providerId: createModelProviderId(this.#params.selection.harness),
      modelId: createModelId(this.#modelId),
    };
  }

  async #appendEvent(type: SessionEventType, payload: unknown): Promise<void> {
    const event = this.#runtime.createEvent(type, payload, this.traceContext);
    await this.#runtime.appendEvent(event, this.traceContext);
    this.#params.events.push(event);
  }

  async #stream(kind: string, delta = "", done = false): Promise<void> {
    const step = this.#step;
    if (!step) return;
    await this.#runtime.emitModelStreamingEvent(
      { assistantMessageId: step.messageId, delta, done, kind: kind as never },
      this.traceContext,
      this.#params.events,
    );
  }

  async #openStep(): Promise<OpenStep> {
    const step: OpenStep = {
      messageId: createMessageId(),
      createdAt: Date.now(),
      text: "",
      reasoning: "",
      textOpen: false,
      reasoningOpen: false,
      toolCount: 0,
      closed: false,
    };
    this.#step = step;
    await this.#runtime.persistAssistantMessage(
      step.messageId,
      this.#params.userMessageId,
      step.createdAt,
      undefined,
      this.traceContext,
      this.#identity() as Model,
    );
    await this.#runtime.persistPart(
      {
        id: createPartId(),
        sessionID: this.#runtime.sessionId,
        messageID: step.messageId,
        type: "step-start",
      },
      this.traceContext,
    );
    const identity = this.#identity();
    await this.#appendEvent(SessionEventType.ModelRequest, {
      messages: [],
      providerId: String(identity.providerId),
      modelId: String(identity.modelId),
      querySource: "main_turn",
      toolCount: 0,
      iteration: this.#stepCount,
    });
    await this.#stream("start");
    return step;
  }

  async #contentStep(): Promise<OpenStep> {
    const step = this.#step;
    if (step && !step.closed && step.toolCount === 0) return step;
    return this.#openStep();
  }

  async #textDelta(text: string): Promise<void> {
    if (!text) return;
    this.hasOutput = true;
    const step = await this.#contentStep();
    if (step.reasoningOpen) {
      step.reasoningOpen = false;
      await this.#stream("reasoning_end");
    }
    if (!step.textOpen) {
      step.textOpen = true;
      await this.#stream("text_start");
    }
    step.text += text;
    await this.#stream("text_delta", text);
  }

  async #reasoningDelta(text: string): Promise<void> {
    if (!text) return;
    this.hasOutput = true;
    let step = await this.#contentStep();
    if (step.text.length > 0) {
      // 一个 step 只持久化一段推理 + 一段正文：正文之后的新推理开启新 step。
      await this.#closeStep();
      step = await this.#openStep();
    }
    if (!step.reasoningOpen) {
      step.reasoningOpen = true;
      await this.#stream("reasoning_start");
    }
    step.reasoning += text;
    await this.#stream("reasoning_delta", text);
  }

  async #flushStepParts(step: OpenStep): Promise<void> {
    if (step.reasoningOpen) {
      step.reasoningOpen = false;
      await this.#stream("reasoning_end");
    }
    if (step.textOpen) {
      step.textOpen = false;
      await this.#stream("text_end");
    }
    const now = Date.now();
    if (step.reasoning.trim()) {
      await this.#runtime.persistPart(
        {
          id: createPartId(),
          sessionID: this.#runtime.sessionId,
          messageID: step.messageId,
          type: "reasoning",
          text: step.reasoning,
          time: { start: step.createdAt, end: now },
        },
        this.traceContext,
      );
    }
    if (step.text.length > 0) {
      await this.#runtime.persistPart(
        {
          id: createPartId(),
          sessionID: this.#runtime.sessionId,
          messageID: step.messageId,
          type: "text",
          text: step.text,
          time: { start: step.createdAt, end: now },
        },
        this.traceContext,
      );
    }
  }

  async #closeStep(): Promise<void> {
    const step = this.#step;
    if (!step || step.closed) return;
    step.closed = true;
    await this.#flushStepParts(step);
    await this.#stream("finish", "", true);
    const usage = subtractUsage(this.#usage, this.#reportedUsage);
    this.#reportedUsage = { ...this.#usage };
    this.#tokenCount += getModelUsageTotalTokens(usage);
    const fileChanges =
      step.toolCount === 0
        ? buildTurnFileChangeSummary(this.#runtime.currentTurnFileChanges)
        : undefined;
    await this.#appendEvent(SessionEventType.ModelComplete, {
      content: step.text,
      querySource: "main_turn",
      stopReason: step.toolCount > 0 ? "tool-calls" : "stop",
      usage,
      toolCallCount: step.toolCount,
      ...(fileChanges ? { fileChanges } : {}),
    });
    await this.#runtime.persistAssistantMessage(
      step.messageId,
      this.#params.userMessageId,
      step.createdAt,
      {
        completed: Date.now(),
        finish: step.toolCount > 0 ? "tool-calls" : "stop",
        tokens: toTokenUsageInfo(usage),
      },
      this.traceContext,
      this.#identity() as Model,
    );
    this.#stepCount += 1;
    this.#response = step.text;
    if (step.text.trim()) this.#assistantTexts.push(step.text.trim());
  }

  async #toolCall(call: AgentHarnessToolCall): Promise<ToolCallId> {
    const existing = this.#tools.get(call.id);
    if (existing) return existing.toolCallId;
    this.hasOutput = true;
    let step = this.#step;
    if (!step || (step.closed && step.toolCount === 0)) step = await this.#openStep();
    step.toolCount += 1;
    // 工具调用意味着本次“模型响应”结束：先完成 step（ModelComplete），再展示工具卡片；
    // 之后没有新正文的连续工具调用挂在同一条 assistant 消息上。
    if (!step.closed) await this.#closeStep();
    const card: ToolCard = {
      toolCallId: createToolCallId(),
      partId: createPartId(),
      messageId: step.messageId,
      name: call.name,
      nativeName: call.nativeName,
      input: call.input,
      startedAt: Date.now(),
      done: false,
    };
    this.#tools.set(call.id, card);
    this.#toolCallCount += 1;
    await this.#runtime.persistPart(
      {
        id: card.partId,
        sessionID: this.#runtime.sessionId,
        messageID: card.messageId,
        type: "tool",
        callID: card.toolCallId,
        tool: card.name,
        metadata: this.#toolMetadata(card, call.id),
        state: {
          status: "running",
          input: card.input,
          title: card.name,
          time: { start: card.startedAt },
        },
      },
      this.traceContext,
    );
    await this.#appendEvent(SessionEventType.ToolCallScheduled, {
      toolCallId: card.toolCallId,
      assistantMessageId: card.messageId,
      toolName: card.name,
      input: card.input,
      dependencies: [],
      canRunParallel: false,
      schedule: { parallelGroups: [[card.toolCallId]], executionOrder: [card.toolCallId] },
    });
    await this.#appendEvent(SessionEventType.ToolCallStarted, {
      toolCallId: card.toolCallId,
      toolName: card.name,
      startedAt: new Date(card.startedAt),
    });
    return card.toolCallId;
  }

  #toolMetadata(card: ToolCard, nativeId: string): Record<string, unknown> {
    return {
      agentHarness: this.#params.selection.harness,
      harnessToolName: card.nativeName,
      harnessToolCallId: nativeId,
    };
  }

  async #toolResult(event: Extract<AgentHarnessEvent, { type: "tool_result" }>): Promise<void> {
    let card = this.#tools.get(event.callId);
    if (!card) {
      await this.#toolCall({ id: event.callId, name: "tool", nativeName: "tool", input: {} });
      card = this.#tools.get(event.callId)!;
    }
    if (card.done) return;
    const changes = await this.#resolveFileChanges(event.fileChanges);
    const display = changes[0]
      ? createToolResultDisplay("Edit", {
          filePath: changes[0].filePath,
          structuredPatch: changes[0].hunks,
        })
      : undefined;
    await this.#completeTool(card, event.output, event.isError, display, event.callId);
    for (const change of changes) await this.#recordFileChange(card, change);
  }

  /** 统一 harness 报告的改动：绝对路径、ZCode diff hunks，并尽量还原改动前后的全文。 */
  async #resolveFileChanges(
    changes: readonly AgentHarnessFileChange[] | undefined,
  ): Promise<ResolvedFileChange[]> {
    const resolved: ResolvedFileChange[] = [];
    for (const change of changes ?? []) {
      const filePath = path.isAbsolute(change.filePath)
        ? change.filePath
        : path.resolve(this.#runtime.workingDirectory, change.filePath);
      const hunks = toDiffHunks(change, filePath);
      const afterContent =
        change.kind === "delete"
          ? undefined
          : (change.newText ?? (await readFile(filePath, "utf8").catch(() => undefined)));
      const beforeContent =
        change.kind === "add"
          ? null
          : (change.oldText ?? reverseApplyHunks(filePath, afterContent, hunks));
      resolved.push({ filePath, hunks, afterContent, beforeContent });
    }
    return resolved;
  }

  /**
   * 记录本轮文件改动。能还原改动前全文时写 workspace checkpoint（与原生 Write/Edit 相同），
   * 使“本轮改动”面板可以展示 diff 并支持撤销；否则只记入本轮改动汇总。
   */
  async #recordFileChange(card: ToolCard, change: ResolvedFileChange): Promise<void> {
    if (this.#runtime.artifactStore && change.beforeContent !== undefined) {
      const startedAt = new Date(card.startedAt);
      await this.#runtime.emitFileMutationCheckpoint({
        abortSignal: this.abortSignal,
        events: this.#params.events,
        messageId: this.#params.userMessageId,
        toolMessageId: card.messageId,
        traceContext: this.traceContext,
        result: {
          toolCallId: card.toolCallId,
          toolName: card.name,
          success: true,
          output: {
            filePath: change.filePath,
            originalFile: change.beforeContent,
            structuredPatch: change.hunks,
            ...(change.afterContent !== undefined ? { content: change.afterContent } : {}),
            type: change.beforeContent === null ? "create" : "update",
          },
          durationMs: Date.now() - card.startedAt,
          startedAt,
          completedAt: new Date(),
        },
      });
      return;
    }
    recordTurnFileChange(this.#runtime.currentTurnFileChanges, {
      path: change.filePath,
      beforeContent: change.beforeContent ?? "",
      ...(change.afterContent !== undefined ? { afterContent: change.afterContent } : {}),
      structuredPatch: change.hunks,
      toolName: card.name,
    });
  }

  async #completeTool(
    card: ToolCard,
    rawOutput: string,
    isError: boolean,
    display?: ReturnType<typeof createToolResultDisplay>,
    nativeId?: string,
  ): Promise<void> {
    card.done = true;
    const output =
      rawOutput.length > MAX_TOOL_OUTPUT_CHARS
        ? `${rawOutput.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (truncated)`
        : rawOutput;
    const end = Date.now();
    const metadata = {
      ...this.#toolMetadata(card, nativeId ?? ""),
      schemaVersion: 1,
      ...(display ? { display } : {}),
    };
    await this.#runtime.persistPart(
      {
        id: card.partId,
        sessionID: this.#runtime.sessionId,
        messageID: card.messageId,
        type: "tool",
        callID: card.toolCallId,
        tool: card.name,
        metadata,
        state: isError
          ? {
              status: "error",
              input: card.input,
              error: output || "Tool failed",
              metadata,
              time: { start: card.startedAt, end },
            }
          : {
              status: "completed",
              input: card.input,
              output,
              title: card.name,
              metadata,
              time: { start: card.startedAt, end },
            },
      },
      this.traceContext,
    );
    if (isError) {
      await this.#appendEvent(SessionEventType.ToolCallError, {
        toolCallId: card.toolCallId,
        error: { type: "ToolExecutionError", message: output || "Tool failed" },
      });
    } else {
      await this.#appendEvent(SessionEventType.ToolCallResult, {
        toolCallId: card.toolCallId,
        result: { success: true, content: output, ...(display ? { display } : {}) },
        duration: end - card.startedAt,
      });
    }
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

/** 把 harness 报告的改动统一转成 ZCode diff hunks。 */
export function toDiffHunks(change: AgentHarnessFileChange, filePath: string): DiffHunk[] {
  if (change.structuredPatch?.length)
    return change.structuredPatch.map((hunk) => ({ ...hunk, lines: [...hunk.lines] }));
  if (change.unifiedDiff) {
    try {
      const [patch] = parsePatch(change.unifiedDiff);
      if (patch?.hunks.length)
        return patch.hunks.map((hunk) => ({ ...hunk, lines: [...hunk.lines] }));
    } catch {
      // 非标准 diff：退回全文对比或空 diff。
    }
  }
  if (change.oldText !== undefined || change.newText !== undefined) {
    return createStructuredPatch({
      filePath,
      oldContent: change.oldText ?? "",
      newContent: change.newText ?? "",
    });
  }
  return [];
}

interface ResolvedFileChange {
  readonly filePath: string;
  readonly hunks: DiffHunk[];
  readonly afterContent: string | undefined;
  /** null = 新建文件；undefined = 无法还原改动前全文。 */
  readonly beforeContent: string | null | undefined;
}

/** 由改动后全文与 hunks 反推改动前全文；失败返回 undefined。 */
export function reverseApplyHunks(
  filePath: string,
  afterContent: string | undefined,
  hunks: readonly DiffHunk[],
): string | undefined {
  if (afterContent === undefined || hunks.length === 0) return undefined;
  try {
    const reversed = reversePatch({
      oldFileName: filePath,
      newFileName: filePath,
      oldHeader: undefined,
      newHeader: undefined,
      hunks: hunks.map((hunk) => ({ ...hunk, lines: [...hunk.lines] })),
    });
    const before = applyPatch(afterContent, reversed, { fuzzFactor: 0 });
    return typeof before === "string" ? before : undefined;
  } catch {
    return undefined;
  }
}
