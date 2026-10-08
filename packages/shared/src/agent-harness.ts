import { z } from "zod";

/**
 * Agent Harness：每个会话由哪一个 agent loop 执行（与「模型服务」是两个独立维度）。
 *
 * - `zcode`：ZCode 自带的 agent runtime（默认），模型来自 ZCode 的模型服务。
 * - `claude-code` / `codex` / `pi`：本机已安装的第三方 harness 接管整个 agent loop
 *   （工具、文件编辑、上下文管理与模型选择），ZCode 作为前端展示它的消息、工具卡片与审批。
 *
 * 本模块是 UI、协议与 CLI runtime 共享的单一真源，只依赖 zod。
 */
export const AGENT_HARNESS_IDS = ["zcode", "claude-code", "codex", "pi"] as const;
export const agentHarnessIdSchema = z.enum(AGENT_HARNESS_IDS);
export type AgentHarnessId = z.infer<typeof agentHarnessIdSchema>;
export type ExternalAgentHarnessId = Exclude<AgentHarnessId, "zcode">;
export const EXTERNAL_AGENT_HARNESS_IDS = [
  "claude-code",
  "codex",
  "pi",
] as const satisfies readonly ExternalAgentHarnessId[];

export const ZCODE_NATIVE_HARNESS_ID = "zcode" satisfies AgentHarnessId;
/** harness 自己决定模型 / 思考深度时使用的占位值（不向 CLI 传 --model / --effort）。 */
export const AGENT_HARNESS_DEFAULT_VALUE = "default";

const harnessOptionValueSchema = z.string().trim().min(1).max(160);

/** 会话的 harness 选择。model/thought 只对外部 harness 生效；缺省表示 harness 自己的默认值。 */
export const agentHarnessSelectionSchema = z
  .object({
    harness: agentHarnessIdSchema,
    model: harnessOptionValueSchema.optional(),
    thought: harnessOptionValueSchema.optional(),
  })
  .strict();
export type AgentHarnessSelection = z.infer<typeof agentHarnessSelectionSchema>;

export function isExternalAgentHarness(
  harness: string | undefined | null,
): harness is ExternalAgentHarnessId {
  return (
    typeof harness === "string" &&
    harness !== ZCODE_NATIVE_HARNESS_ID &&
    (AGENT_HARNESS_IDS as readonly string[]).includes(harness)
  );
}

export interface AgentHarnessOption {
  readonly value: string;
  readonly label: string;
}

export interface AgentHarnessCatalogEntry {
  readonly id: AgentHarnessId;
  readonly label: string;
  /** 外部 harness 的可执行文件名（不含 Windows 扩展名）。 */
  readonly executable?: string;
  readonly installCommand?: string;
  readonly loginHint?: string;
  /** 首项为默认值。 */
  readonly models: readonly AgentHarnessOption[];
  /** 首项为默认值；空数组表示不支持思考深度。 */
  readonly thoughtLevels: readonly string[];
  /** ZCode 如何把 harness 的工具审批接入审批卡片。 */
  readonly approvalBridge: "native" | "control-protocol" | "app-server" | "extension-ui";
}

const DEFAULT_OPTION: AgentHarnessOption = { value: AGENT_HARNESS_DEFAULT_VALUE, label: "Default" };

export const AGENT_HARNESS_CATALOG: Readonly<Record<AgentHarnessId, AgentHarnessCatalogEntry>> = {
  zcode: {
    id: "zcode",
    label: "ZCode",
    models: [],
    thoughtLevels: [],
    approvalBridge: "native",
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    executable: "claude",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    loginHint: "claude",
    models: [
      DEFAULT_OPTION,
      { value: "sonnet", label: "Sonnet" },
      { value: "opus", label: "Opus" },
      { value: "haiku", label: "Haiku" },
    ],
    thoughtLevels: [AGENT_HARNESS_DEFAULT_VALUE, "low", "medium", "high", "xhigh", "max"],
    approvalBridge: "control-protocol",
  },
  codex: {
    id: "codex",
    label: "Codex",
    executable: "codex",
    installCommand: "npm install -g @openai/codex",
    loginHint: "codex login",
    models: [DEFAULT_OPTION],
    thoughtLevels: [AGENT_HARNESS_DEFAULT_VALUE, "minimal", "low", "medium", "high", "xhigh"],
    approvalBridge: "app-server",
  },
  pi: {
    id: "pi",
    label: "pi",
    executable: "pi",
    installCommand: "npm install -g @earendil-works/pi-coding-agent",
    loginHint: "pi → /login",
    models: [DEFAULT_OPTION],
    thoughtLevels: [
      AGENT_HARNESS_DEFAULT_VALUE,
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ],
    approvalBridge: "extension-ui",
  },
};

export function getAgentHarnessCatalogEntry(harness: AgentHarnessId): AgentHarnessCatalogEntry {
  return AGENT_HARNESS_CATALOG[harness];
}

/**
 * 把任意输入收敛为完整的 harness 选择：未知 harness 回落 zcode；外部 harness 的 model/thought
 * 缺省或为 default 时省略，交给 harness 自己的配置。
 */
export function normalizeAgentHarnessSelection(
  value: AgentHarnessSelection | undefined | null,
): AgentHarnessSelection {
  const parsed = agentHarnessSelectionSchema.safeParse(value);
  if (!parsed.success || !isExternalAgentHarness(parsed.data.harness)) {
    return { harness: ZCODE_NATIVE_HARNESS_ID };
  }
  const { harness, model, thought } = parsed.data;
  return {
    harness,
    ...(model && model !== AGENT_HARNESS_DEFAULT_VALUE ? { model } : {}),
    ...(thought && thought !== AGENT_HARNESS_DEFAULT_VALUE ? { thought } : {}),
  };
}

export function sameAgentHarnessSelection(
  left: AgentHarnessSelection | undefined | null,
  right: AgentHarnessSelection | undefined | null,
): boolean {
  const a = normalizeAgentHarnessSelection(left);
  const b = normalizeAgentHarnessSelection(right);
  return a.harness === b.harness && a.model === b.model && a.thought === b.thought;
}

/** 宿主报告的外部 harness 可用性（workspace presentation 携带，供选择器展示）。 */
export const agentHarnessAvailabilitySchema = z.object({
  harness: agentHarnessIdSchema,
  available: z.boolean(),
  version: z.string().optional(),
});
export type AgentHarnessAvailabilityInfo = z.infer<typeof agentHarnessAvailabilitySchema>;

/** workspace-config 中 harness 选项的 id（select 值即 AgentHarnessId）。 */
export const AGENT_HARNESS_CONFIG_OPTION_ID = "harness";

/** 外部 harness 审批请求的动作类别（决定审批卡片标题的措辞）。 */
export type AgentHarnessApprovalAction = "edit" | "write" | "command" | "tool";

const APPROVAL_ACTION_BY_TOOL: Record<string, AgentHarnessApprovalAction> = {
  edit: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  apply_patch: "edit",
  write: "write",
  bash: "command",
  shell: "command",
  exec_command: "command",
};

export function classifyAgentHarnessApprovalTool(toolName: string): AgentHarnessApprovalAction {
  return APPROVAL_ACTION_BY_TOOL[toolName.toLowerCase()] ?? "tool";
}

const APPROVAL_ACTION_TEXT: Record<Exclude<AgentHarnessApprovalAction, "tool">, string> = {
  edit: "edit a file",
  write: "write a file",
  command: "run a command",
};

/**
 * harness 没有给出说明时，ZCode 审批卡片的默认标题（英文、可解析）。
 * agent 进程不知道界面语言，UI 用 {@link parseAgentHarnessApprovalReason} 识别后按界面语言重新渲染。
 */
export function formatAgentHarnessApprovalReason(
  harness: ExternalAgentHarnessId,
  toolName: string,
): string {
  const label = AGENT_HARNESS_CATALOG[harness].label;
  const action = classifyAgentHarnessApprovalTool(toolName);
  return action === "tool"
    ? `${label} wants to use ${toolName}`
    : `${label} wants to ${APPROVAL_ACTION_TEXT[action]}`;
}

export interface ParsedAgentHarnessApprovalReason {
  harness: ExternalAgentHarnessId;
  label: string;
  action: AgentHarnessApprovalAction;
  toolName?: string;
}

export function parseAgentHarnessApprovalReason(
  reason: string | null | undefined,
): ParsedAgentHarnessApprovalReason | null {
  if (!reason) return null;
  for (const harness of EXTERNAL_AGENT_HARNESS_IDS) {
    const label = AGENT_HARNESS_CATALOG[harness].label;
    const prefix = `${label} wants to `;
    if (!reason.startsWith(prefix)) continue;
    const rest = reason.slice(prefix.length);
    for (const [action, text] of Object.entries(APPROVAL_ACTION_TEXT)) {
      if (rest === text) return { harness, label, action: action as AgentHarnessApprovalAction };
    }
    if (rest.startsWith("use ") && rest.length > 4) {
      return { harness, label, action: "tool", toolName: rest.slice(4) };
    }
  }
  return null;
}
