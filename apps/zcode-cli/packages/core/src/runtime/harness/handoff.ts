import type { MessageWithParts } from "@zcode/contracts";
import { getAgentHarnessCatalogEntry, type AgentHarnessId } from "@zcode/shared/agent-harness";

/**
 * 会话交接：当本轮 harness 没有可续接的原生会话（第一次使用该 harness，或会话中途切换了
 * harness）时，把 ZCode 已持久化的对话整理成一段文本放在本轮输入之前，让新 harness 接上
 * 上下文。只交接可见对话（用户输入、助手正文、工具调用摘要），不交接推理内容。
 */
const MAX_HANDOFF_CHARS = 24_000;
const MAX_TEXT_CHARS = 4_000;
const MAX_TOOL_CHARS = 400;

export interface HandoffInput {
  readonly messages: readonly MessageWithParts[];
  /** 本轮用户消息（已持久化）不进入交接摘要。 */
  readonly excludeMessageId?: string;
  readonly previousHarness?: AgentHarnessId;
  readonly prompt: string;
}

export function buildHarnessHandoffPrompt(input: HandoffInput): string {
  const lines = collectTranscriptLines(input.messages, input.excludeMessageId);
  if (lines.length === 0) return input.prompt;
  // 从最近的对话往前保留，超过预算时丢弃最早的部分。
  const kept: string[] = [];
  let size = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (size + line.length > MAX_HANDOFF_CHARS && kept.length > 0) {
      kept.unshift("[… earlier conversation omitted …]");
      break;
    }
    kept.unshift(line);
    size += line.length;
  }
  const source = input.previousHarness
    ? ` It was previously handled by ${getAgentHarnessCatalogEntry(input.previousHarness).label}.`
    : "";
  return [
    "<zcode_conversation_handoff>",
    `This ZCode session already has earlier conversation turns.${source} They are summarized below so you can continue the same task; do not redo work that is already done.`,
    "",
    ...kept,
    "</zcode_conversation_handoff>",
    "",
    input.prompt,
  ].join("\n");
}

function collectTranscriptLines(
  messages: readonly MessageWithParts[],
  excludeMessageId: string | undefined,
): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.info.id === excludeMessageId) continue;
    const info = message.info as {
      role: string;
      summary?: unknown;
      semantics?: { transcriptVisibility?: string };
    };
    if (info.semantics?.transcriptVisibility === "hidden") continue;
    if (info.role === "user") {
      const text = joinText(message);
      if (text) lines.push(`[user]\n${truncate(text, MAX_TEXT_CHARS)}\n`);
      continue;
    }
    if (info.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type === "text" && part.text.trim()) {
        lines.push(`[assistant]\n${truncate(part.text.trim(), MAX_TEXT_CHARS)}\n`);
      } else if (part.type === "tool") {
        const state = part.state as {
          status: string;
          input?: unknown;
          output?: unknown;
          error?: unknown;
        };
        const inputText = truncate(safeJson(state.input), MAX_TOOL_CHARS);
        const outcome =
          state.status === "completed"
            ? truncate(String(state.output ?? ""), MAX_TOOL_CHARS)
            : state.status === "error"
              ? `error: ${truncate(String(state.error ?? ""), MAX_TOOL_CHARS)}`
              : state.status;
        lines.push(`[tool ${part.tool}] ${inputText}\n→ ${outcome || "(no output)"}\n`);
      }
    }
  }
  return lines;
}

function joinText(message: MessageWithParts): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}
