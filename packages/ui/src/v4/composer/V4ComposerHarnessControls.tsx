/**
 * Agent harness 选择器（ZCode / Claude Code / Codex / pi）与外部 harness 的模型、思考深度选择器。
 *
 * - 只编辑 Composer 草稿；选择随下一次 Submission 发送，在开跑时成为会话事实（与 mode 同一路径）。
 * - 可用性来自 workspace presentation（CLI 侧 `--version` 检测）；未安装的 harness 仍可浏览，
 *   但发送按钮由 SessionPane 门禁阻断，并给出安装命令与登录提示。
 * - 选中外部 harness 时，右侧模型区域换成 harness 自己的模型/思考深度目录。
 */
import { memo, useMemo } from "react";
import {
  BrainIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CpuIcon,
} from "lucide-react";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared";
import {
  AGENT_HARNESS_DEFAULT_VALUE,
  getAgentHarnessCatalogEntry,
  type AgentHarnessAvailabilityInfo,
  type AgentHarnessSelection,
} from "@zcode/shared/agent-harness";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { V4ComposerConfigPicker } from "@/v4/composer/configPickerState.js";
import {
  buildComposerHarnessChoices,
  getComposerHarnessModelOptions,
  getComposerHarnessThoughtOptions,
  resolveComposerHarness,
  type ComposerHarnessChoice,
} from "@/v4/composer/composerHarnessState.js";

export const TID_V4_HARNESS_TRIGGER = "v4-composer-harness-trigger";
export const TID_V4_HARNESS_ITEM = "v4-composer-harness-item";
export const TID_V4_HARNESS_MODEL_TRIGGER = "v4-composer-harness-model-trigger";
export const TID_V4_HARNESS_THOUGHT_TRIGGER = "v4-composer-harness-thought-trigger";

function refocusComposer(event: Event): void {
  event.preventDefault();
  if (!isCoarseTouchDevice()) {
    document.querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)?.focus();
  }
}

function HarnessStatusIcon({ status }: { status: ComposerHarnessChoice["status"] }) {
  if (status === "available") return <CircleCheckIcon className="size-3.5 text-success" />;
  if (status === "missing") return <CircleAlertIcon className="size-3.5 text-warning" />;
  return <CircleDashedIcon className="size-3.5 text-foreground-subtle" />;
}

interface HarnessSwitchProps {
  harness: AgentHarnessSelection | undefined;
  /** 会话当前实际运行的 harness（快照）；与草稿不同表示下一次发送会切换。 */
  sessionHarness: AgentHarnessSelection | undefined;
  availability: readonly AgentHarnessAvailabilityInfo[] | undefined;
  disabled: boolean;
  activeConfigPicker: V4ComposerConfigPicker | null;
  onConfigPickerOpenChange: (picker: V4ComposerConfigPicker, open: boolean) => void;
  onSelectHarness: (harness: string) => void;
}

function V4ComposerHarnessSwitchImpl({
  harness,
  sessionHarness,
  availability,
  disabled,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSelectHarness,
}: HarnessSwitchProps) {
  const { intl } = useZCodeIntl();
  const selected = resolveComposerHarness(harness);
  const choices = useMemo(() => buildComposerHarnessChoices(availability), [availability]);
  const current = choices.find((choice) => choice.id === selected.harness) ?? choices[0]!;
  const running = sessionHarness ? resolveComposerHarness(sessionHarness).harness : undefined;
  const pendingSwitch = running !== undefined && running !== selected.harness;
  const statusText = (choice: ComposerHarnessChoice) =>
    choice.status === "available"
      ? intl.formatMessage(
          { id: "chat.toolbar.harness.status.available" },
          { version: choice.detail ?? "" },
        )
      : choice.status === "missing"
        ? intl.formatMessage(
            { id: "chat.toolbar.harness.status.missing" },
            { install: choice.detail ?? "" },
          )
        : intl.formatMessage({ id: "chat.toolbar.harness.status.unknown" });
  return (
    <DropdownMenu
      open={activeConfigPicker === "harness"}
      onOpenChange={(open) => onConfigPickerOpenChange("harness", open)}
    >
      <ControlHintTooltip
        title={intl.formatMessage({ id: "chat.toolbar.harness.tooltip" })}
        open={activeConfigPicker === "harness" ? false : undefined}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            data-testid={TID_V4_HARNESS_TRIGGER}
            data-harness={selected.harness}
            data-composer-collapse-priority="1"
            aria-label={intl.formatMessage({ id: "chat.toolbar.harness.label" })}
            className={cn(
              "group/harness h-7 gap-1 rounded-lg px-2 text-ui-base data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
              current.status === "missing" && "text-warning hover:text-warning",
            )}
          >
            <CpuIcon className="size-4" />
            <span className="inline group-data-[composer-compact=true]/harness:hidden">
              {current.label}
            </span>
            <ChevronDownIcon className="size-3.5 group-data-[composer-compact=true]/harness:hidden" />
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent
        side="top"
        sideOffset={4}
        className="w-80"
        onCloseAutoFocus={refocusComposer}
      >
        <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "chat.toolbar.harness.label" })}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={selected.harness} onValueChange={onSelectHarness}>
          {choices.map((choice) => (
            <DropdownMenuRadioItem
              key={choice.id}
              value={choice.id}
              data-testid={`${TID_V4_HARNESS_ITEM}-${choice.id}`}
              data-harness-status={choice.status}
              className="min-h-13 items-start gap-3 py-2"
            >
              <span className="mt-0.5 shrink-0">
                <HarnessStatusIcon status={choice.status} />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>{choice.label}</span>
                <span className="text-ui-sm text-foreground-subtle">
                  {choice.id === "zcode"
                    ? intl.formatMessage({ id: "chat.toolbar.harness.zcode.description" })
                    : intl.formatMessage(
                        { id: "chat.toolbar.harness.external.description" },
                        { name: choice.label },
                      )}
                </span>
                {choice.id !== "zcode" && (
                  <span className="text-ui-sm text-foreground-subtle">{statusText(choice)}</span>
                )}
                {choice.id !== "zcode" && choice.loginHint && (
                  <span className="text-ui-sm text-foreground-subtle">
                    {intl.formatMessage(
                      { id: "chat.toolbar.harness.loginHint" },
                      { hint: choice.loginHint },
                    )}
                  </span>
                )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {pendingSwitch && (
          <>
            <DropdownMenuSeparator />
            <p
              data-testid="v4-composer-harness-switch-notice"
              className="px-2 py-1.5 text-ui-sm text-foreground-subtle"
            >
              {intl.formatMessage(
                { id: "chat.toolbar.harness.switchNotice" },
                { name: current.label },
              )}
            </p>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
export const V4ComposerHarnessSwitch = memo(V4ComposerHarnessSwitchImpl);

interface HarnessModelControlsProps {
  harness: AgentHarnessSelection | undefined;
  disabled: boolean;
  activeConfigPicker: V4ComposerConfigPicker | null;
  onConfigPickerOpenChange: (picker: V4ComposerConfigPicker, open: boolean) => void;
  onSelectHarnessModel: (model: string) => void;
  onSelectHarnessThought: (thought: string) => void;
}

/** 外部 harness 的模型 / 思考深度（替换 ZCode 模型目录）。 */
function V4ComposerHarnessModelControlsImpl({
  harness,
  disabled,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSelectHarnessModel,
  onSelectHarnessThought,
}: HarnessModelControlsProps) {
  const { intl } = useZCodeIntl();
  const selected = resolveComposerHarness(harness);
  const entry = getAgentHarnessCatalogEntry(selected.harness);
  const models = getComposerHarnessModelOptions(selected);
  const thoughts = getComposerHarnessThoughtOptions(selected);
  const modelLabel = (value: string, label: string) =>
    value === AGENT_HARNESS_DEFAULT_VALUE
      ? intl.formatMessage({ id: "chat.toolbar.harness.model.default" })
      : label;
  const thoughtLabel = (value: string) =>
    value === AGENT_HARNESS_DEFAULT_VALUE
      ? intl.formatMessage({ id: "chat.toolbar.harness.thought.default" })
      : value;
  const currentModel = models.options.find((option) => option.value === models.current);
  return (
    <span
      className="flex min-w-0 items-center gap-1"
      data-testid="v4-composer-harness-model-controls"
    >
      <DropdownMenu
        open={activeConfigPicker === "model"}
        onOpenChange={(open) => onConfigPickerOpenChange("model", open)}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            data-testid={TID_V4_HARNESS_MODEL_TRIGGER}
            aria-label={intl.formatMessage(
              { id: "chat.toolbar.harness.model.label" },
              { name: entry.label },
            )}
            className="h-7 min-w-0 gap-1 rounded-lg px-2 text-ui-base"
          >
            <span className="truncate">
              {entry.label} · {modelLabel(models.current, currentModel?.label ?? models.current)}
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          sideOffset={4}
          className="w-56"
          onCloseAutoFocus={refocusComposer}
        >
          <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolbar.harness.model.label" }, { name: entry.label })}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup value={models.current} onValueChange={onSelectHarnessModel}>
            {models.options.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {modelLabel(option.value, option.label)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {thoughts.options.length > 0 && (
        <DropdownMenu
          open={activeConfigPicker === "thought"}
          onOpenChange={(open) => onConfigPickerOpenChange("thought", open)}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-testid={TID_V4_HARNESS_THOUGHT_TRIGGER}
              aria-label={intl.formatMessage({ id: "chat.toolbar.harness.thought.label" })}
              className="h-7 gap-1 rounded-lg px-2 text-ui-base"
            >
              <BrainIcon className="size-4" />
              <span>{thoughtLabel(thoughts.current)}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            sideOffset={4}
            className="w-48"
            onCloseAutoFocus={refocusComposer}
          >
            <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "chat.toolbar.harness.thought.label" })}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup value={thoughts.current} onValueChange={onSelectHarnessThought}>
              {thoughts.options.map((value) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {thoughtLabel(value)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </span>
  );
}
export const V4ComposerHarnessModelControls = memo(V4ComposerHarnessModelControlsImpl);
