import { createAgentHarnessRunner } from "@zcode/adapters/agent-harness";
import type { AgentHarnessAvailability, AgentHarnessRunnerPort } from "@zcode/contracts";

/**
 * 进程级共享的外部 harness 运行器。
 *
 * 运行器本身无会话状态（每轮按 run 请求起子进程），共享一个实例只是为了让可用性检测
 * （`--version`，30s 缓存）在所有会话与 workspace-config 之间复用。
 */
let sharedRunner: AgentHarnessRunnerPort | undefined;

export function getSharedAgentHarnessRunner(): AgentHarnessRunnerPort {
  sharedRunner ??= createAgentHarnessRunner();
  return sharedRunner;
}

const runnersByEnv = new WeakMap<NodeJS.ProcessEnv, AgentHarnessRunnerPort>();

/** 选择 runtime 使用的运行器：宿主注入优先；自定义 env 按 env 对象复用，避免串用 PATH。 */
export function resolveAgentHarnessRunner(options: {
  harnessRunner?: AgentHarnessRunnerPort;
  env?: NodeJS.ProcessEnv;
}): AgentHarnessRunnerPort {
  if (options.harnessRunner) return options.harnessRunner;
  const env = options.env;
  if (!env || env === process.env) return getSharedAgentHarnessRunner();
  let runner = runnersByEnv.get(env);
  if (!runner) {
    runner = createAgentHarnessRunner({ env });
    runnersByEnv.set(env, runner);
  }
  return runner;
}

/** workspace presentation 用：检测失败不影响目录读取，返回空列表（前端视为未知）。 */
export async function detectAgentHarnesses(
  env?: NodeJS.ProcessEnv,
): Promise<
  { harness: AgentHarnessAvailability["harness"]; available: boolean; version?: string }[]
> {
  try {
    const result = await resolveAgentHarnessRunner(env ? { env } : {}).detect();
    return result.map((entry) => ({
      harness: entry.harness,
      available: entry.available,
      ...(entry.version ? { version: entry.version } : {}),
    }));
  } catch {
    return [];
  }
}
