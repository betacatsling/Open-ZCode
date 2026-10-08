// Composer 的 agent harness 选择（纯函数，供草稿、选择器与提交共用，可单测）。
//
// harness 与模型是两个独立维度：
// - harness=zcode：沿用 ZCode 模型目录（ModelSelectionView）与思考深度；
// - 外部 harness（Claude Code / Codex / pi）：模型与思考深度来自 harness 目录，
//   由 harness 自己解释；ZCode 模型选择保留在草稿里，切回 zcode 时继续生效。
import {
  AGENT_HARNESS_DEFAULT_VALUE,
  AGENT_HARNESS_IDS,
  agentHarnessSelectionSchema,
  getAgentHarnessCatalogEntry,
  isExternalAgentHarness,
  normalizeAgentHarnessSelection,
  ZCODE_NATIVE_HARNESS_ID,
  type AgentHarnessAvailabilityInfo,
  type AgentHarnessId,
  type AgentHarnessSelection,
} from "@zcode/shared/agent-harness";

export type ComposerHarnessAvailabilityStatus = "available" | "missing" | "unknown";

export interface ComposerHarnessChoice {
  readonly id: AgentHarnessId;
  readonly label: string;
  readonly status: ComposerHarnessAvailabilityStatus;
  /** 可用时为版本号；未安装时为安装命令。 */
  readonly detail?: string;
  /** 外部 harness 的登录提示（由 harness 自己的登录流程完成，ZCode 不接管凭据）。 */
  readonly loginHint?: string;
}

/** 解析草稿 / 快照里的 harness；非法值视为缺省（zcode）。 */
export function readComposerHarness(value: unknown): AgentHarnessSelection | undefined {
  const parsed = agentHarnessSelectionSchema.safeParse(value);
  return parsed.success ? normalizeAgentHarnessSelection(parsed.data) : undefined;
}

export function resolveComposerHarness(
  value: AgentHarnessSelection | undefined | null,
): AgentHarnessSelection {
  return normalizeAgentHarnessSelection(value);
}

export function isComposerExternalHarness(
  value: AgentHarnessSelection | undefined | null,
): boolean {
  return isExternalAgentHarness(value?.harness);
}

/** 切换 harness：同 harness 保留模型/档位；换 harness 回到该 harness 的默认值。 */
export function selectComposerHarness(
  current: AgentHarnessSelection | undefined,
  harness: string,
): AgentHarnessSelection {
  const parsed = agentHarnessSelectionSchema.shape.harness.safeParse(harness);
  if (!parsed.success) return resolveComposerHarness(current);
  if (current?.harness === parsed.data) return resolveComposerHarness(current);
  return { harness: parsed.data };
}

export function selectComposerHarnessModel(
  current: AgentHarnessSelection | undefined,
  model: string,
): AgentHarnessSelection {
  const selection = resolveComposerHarness(current);
  if (!isExternalAgentHarness(selection.harness)) return selection;
  return normalizeAgentHarnessSelection({ ...selection, model: model.trim() || undefined });
}

export function selectComposerHarnessThought(
  current: AgentHarnessSelection | undefined,
  thought: string,
): AgentHarnessSelection {
  const selection = resolveComposerHarness(current);
  if (!isExternalAgentHarness(selection.harness)) return selection;
  return normalizeAgentHarnessSelection({ ...selection, thought: thought.trim() || undefined });
}

/** 选择器展示的 harness 列表（固定顺序），合并宿主报告的可用性。 */
export function buildComposerHarnessChoices(
  availability: readonly AgentHarnessAvailabilityInfo[] | undefined,
): ComposerHarnessChoice[] {
  return AGENT_HARNESS_IDS.map((id) => {
    const entry = getAgentHarnessCatalogEntry(id);
    if (id === ZCODE_NATIVE_HARNESS_ID) {
      return { id, label: entry.label, status: "available" as const };
    }
    const reported = availability?.find((item) => item.harness === id);
    const status: ComposerHarnessAvailabilityStatus = !reported
      ? "unknown"
      : reported.available
        ? "available"
        : "missing";
    const detail =
      status === "available"
        ? reported?.version
        : status === "missing"
          ? entry.installCommand
          : undefined;
    return {
      id,
      label: entry.label,
      status,
      ...(detail ? { detail } : {}),
      ...(entry.loginHint ? { loginHint: entry.loginHint } : {}),
    };
  });
}

/** 外部 harness 未安装时禁止提交（已知缺失才阻断；未知时交给运行时报错）。 */
export function isComposerHarnessSubmittable(
  selection: AgentHarnessSelection | undefined,
  availability: readonly AgentHarnessAvailabilityInfo[] | undefined,
): boolean {
  const resolved = resolveComposerHarness(selection);
  if (!isExternalAgentHarness(resolved.harness)) return true;
  const reported = availability?.find((item) => item.harness === resolved.harness);
  return reported?.available !== false;
}

export interface ComposerHarnessPickerOption {
  readonly value: string;
  readonly label: string;
}

/** harness-aware 模型选择器：外部 harness 的模型目录（首项 = harness 默认）。 */
export function getComposerHarnessModelOptions(selection: AgentHarnessSelection | undefined): {
  options: ComposerHarnessPickerOption[];
  current: string;
} {
  const resolved = resolveComposerHarness(selection);
  const entry = getAgentHarnessCatalogEntry(resolved.harness);
  const options = entry.models.map((option) => ({ value: option.value, label: option.label }));
  const current = resolved.model ?? AGENT_HARNESS_DEFAULT_VALUE;
  // 自定义模型（CLI / 旧草稿写入）不在目录里时仍展示为当前值。
  if (!options.some((option) => option.value === current)) {
    options.push({ value: current, label: current });
  }
  return { options, current };
}

export function getComposerHarnessThoughtOptions(selection: AgentHarnessSelection | undefined): {
  options: string[];
  current: string;
} {
  const resolved = resolveComposerHarness(selection);
  const entry = getAgentHarnessCatalogEntry(resolved.harness);
  return {
    options: [...entry.thoughtLevels],
    current: resolved.thought ?? AGENT_HARNESS_DEFAULT_VALUE,
  };
}
