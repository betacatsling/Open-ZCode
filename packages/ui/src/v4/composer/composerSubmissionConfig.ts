import { resolveExecutionState, type ModelSelection } from "@zcode/shared";
import type { AgentHarnessSelection } from "@zcode/shared/agent-harness";
import { submissionModeSchema, type SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "@zcode/services";
import { validateModelSelectionOptions } from "@zcode/provider";
import {
  isComposerExternalHarness,
  resolveComposerHarness,
} from "@/v4/composer/composerHarnessState.js";

export interface ComposerSubmissionConfig {
  /** ZCode 模型选择；外部 harness 自己选模型，此时可缺省。 */
  modelSelection?: ModelSelection;
  mode: SubmissionMode;
  planEnabled: boolean;
  /** 本次 Submission 的 agent harness（显式选择过才携带；缺省 = 会话当前 harness）。 */
  harness?: AgentHarnessSelection;
}

/** 在点击提交的瞬间，把 Composer 意图冻结成本次 Submission 的执行配置。 */
export function createComposerSubmissionConfig(
  composer:
    | {
        mode?: string;
        planEnabled?: boolean;
        modelSelection?: ModelSelection;
        harness?: AgentHarnessSelection;
      }
    | null
    | undefined,
  view: ModelSelectionView | null,
): ComposerSubmissionConfig | null {
  // 只读子会话和未挂载 Composer 的 SessionPane 不提供草稿；这类场景没有可提交配置，
  // 不能因为渲染提交门禁而读取 undefined 并让整个会话区域崩溃。
  if (!composer) {
    return null;
  }
  const selection = composer.modelSelection;
  const mode = submissionModeSchema.safeParse(composer.mode);
  if (!mode.success) return null;
  const model =
    selection &&
    view?.providers
      .find((provider) => provider.providerId === selection.providerId)
      ?.models.find((candidate) => candidate.modelId === selection.modelId);
  const validModel = Boolean(
    selection && model && validateModelSelectionOptions(model, selection).ok,
  );
  const externalHarness = isComposerExternalHarness(composer.harness);
  // 外部 harness 不依赖 ZCode 模型；ZCode harness 仍要求完整模型选择。
  if (!validModel && !externalHarness) return null;
  const harness = composer.harness ? resolveComposerHarness(composer.harness) : undefined;
  // 不读取 Session 或显示别名；复制所有选择叶子，防止 await 后用户切模改变本次请求。
  return Object.freeze({
    mode: mode.data === "plan" ? "build" : mode.data,
    planEnabled: resolveExecutionState(composer).planEnabled,
    ...(validModel && selection
      ? {
          modelSelection: Object.freeze({
            providerId: selection.providerId,
            modelId: selection.modelId,
            options: Object.freeze({ reasoningLevel: selection.options!.reasoningLevel! }),
          }),
        }
      : {}),
    ...(harness ? { harness: Object.freeze({ ...harness }) } : {}),
  });
}
