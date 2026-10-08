// 外部 agent harness 可用性（按 workspace 缓存）。
//
// 来源：workspace/readPresentation 的 additive 字段 harnesses（CLI 侧 `--version` 检测，30s 缓存）。
// 只用于选择器展示与“未安装时禁止提交”；真正能否运行以运行时为准。
import { useSyncExternalStore } from "react";
import type { AgentHarnessAvailabilityInfo } from "@zcode/shared/agent-harness";

const availabilityByWorkspace = new Map<string, readonly AgentHarnessAvailabilityInfo[]>();
const listeners = new Set<() => void>();

function resolveKey(workspacePath: string, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath;
}

export function setAgentHarnessAvailability(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  availability: readonly AgentHarnessAvailabilityInfo[],
): void {
  availabilityByWorkspace.set(resolveKey(workspacePath, workspaceIdentity), [...availability]);
  for (const listener of listeners) listener();
}

export function getAgentHarnessAvailability(
  workspacePath: string,
  workspaceIdentity?: string,
): readonly AgentHarnessAvailabilityInfo[] | undefined {
  return availabilityByWorkspace.get(resolveKey(workspacePath, workspaceIdentity));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAgentHarnessAvailability(
  workspacePath: string,
  workspaceIdentity?: string,
): readonly AgentHarnessAvailabilityInfo[] | undefined {
  return useSyncExternalStore(
    subscribe,
    () => getAgentHarnessAvailability(workspacePath, workspaceIdentity),
    () => undefined,
  );
}
