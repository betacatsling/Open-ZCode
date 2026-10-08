import type { ModelUsage } from "@zcode/contracts";
import { readNumber, type JsonRecord } from "./json-record.js";

const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;

/** 逐字段相加（一次 harness 运行内多次模型请求的合计）。 */
export function addModelUsage(left: ModelUsage | undefined, right: ModelUsage): ModelUsage {
  if (!left) return { ...right };
  const sum: ModelUsage = {};
  for (const field of USAGE_FIELDS) {
    if (left[field] === undefined && right[field] === undefined) continue;
    sum[field] = (left[field] ?? 0) + (right[field] ?? 0);
  }
  return sum;
}

/** Anthropic 用量：ZCode 的 inputTokens 约定为包含缓存读写的总输入。 */
export function toAnthropicUsage(usage: JsonRecord | undefined): ModelUsage | undefined {
  if (!usage) return undefined;
  const input = readNumber(usage, "input_tokens");
  const output = readNumber(usage, "output_tokens");
  const cacheRead = readNumber(usage, "cache_read_input_tokens");
  const cacheWrite = readNumber(usage, "cache_creation_input_tokens");
  if ([input, output, cacheRead, cacheWrite].every((value) => value === undefined)) {
    return undefined;
  }
  const inputTokens = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  return {
    inputTokens,
    ...(output !== undefined ? { outputTokens: output } : {}),
    totalTokens: inputTokens + (output ?? 0),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

/** pi-ai 用量：input 不含缓存读写。 */
export function toPiUsage(usage: JsonRecord | undefined): ModelUsage | undefined {
  if (!usage) return undefined;
  const input = readNumber(usage, "input");
  const output = readNumber(usage, "output");
  const cacheRead = readNumber(usage, "cacheRead");
  const cacheWrite = readNumber(usage, "cacheWrite");
  if ([input, output, cacheRead, cacheWrite].every((value) => value === undefined)) {
    return undefined;
  }
  const inputTokens = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  return {
    inputTokens,
    ...(output !== undefined ? { outputTokens: output } : {}),
    totalTokens: readNumber(usage, "totalTokens") ?? inputTokens + (output ?? 0),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

/** Codex app-server 的 TokenUsageBreakdown（inputTokens 已包含 cachedInputTokens）。 */
export function toCodexUsage(breakdown: JsonRecord | undefined): ModelUsage | undefined {
  if (!breakdown) return undefined;
  const input = readNumber(breakdown, "inputTokens");
  const output = readNumber(breakdown, "outputTokens");
  if (input === undefined && output === undefined) return undefined;
  const cached = readNumber(breakdown, "cachedInputTokens");
  const reasoning = readNumber(breakdown, "reasoningOutputTokens");
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    totalTokens: readNumber(breakdown, "totalTokens") ?? (input ?? 0) + (output ?? 0),
    ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
  };
}
