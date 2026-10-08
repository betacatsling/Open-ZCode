import type {
  AgentHarnessEvent,
  AgentHarnessRunRequest,
  ExternalAgentHarnessId,
} from "@zcode/contracts";
import { abortReason, createEventChannel, type EventChannel } from "./channel.js";
import type { HarnessProcess, SpawnHarnessProcess } from "./process.js";

export interface HarnessDriverContext {
  readonly executablePath: string;
  readonly spawnProcess: SpawnHarnessProcess;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** 驱动可写入辅助文件（例如 pi 审批扩展）的目录。 */
  readonly supportDir: string;
}

export interface HarnessDriver {
  readonly harness: ExternalAgentHarnessId;
  run(
    request: AgentHarnessRunRequest,
    context: HarnessDriverContext,
  ): AsyncIterable<AgentHarnessEvent>;
}

/** 正常结束后给 harness 的退出宽限期；超时直接结束进程组。 */
const EXIT_GRACE_MS = 3_000;

/**
 * 驱动通用骨架：启动进程、把 abort / 消费方提前退出转成结束进程，
 * pump 负责协议细节并通过 channel 推送归一化事件。
 */
export function runHarnessProcess(
  request: AgentHarnessRunRequest,
  start: () => HarnessProcess,
  pump: (process: HarnessProcess, channel: EventChannel<AgentHarnessEvent>) => Promise<void>,
): AsyncIterable<AgentHarnessEvent> {
  let child: HarnessProcess | undefined;
  const channel = createEventChannel<AgentHarnessEvent>(() => child?.kill());
  if (request.abortSignal.aborted) {
    channel.fail(abortReason(request.abortSignal));
    return channel;
  }
  child = start();
  const running = child;
  const onAbort = () => running.kill();
  request.abortSignal.addEventListener("abort", onAbort, { once: true });
  void pump(running, channel)
    .then(
      async () => {
        running.endInput();
        const timer = setTimeout(() => running.kill(), EXIT_GRACE_MS);
        await running.exited;
        clearTimeout(timer);
        if (request.abortSignal.aborted) channel.fail(abortReason(request.abortSignal));
        else channel.close();
      },
      (error: unknown) => {
        running.kill();
        channel.fail(request.abortSignal.aborted ? abortReason(request.abortSignal) : error);
      },
    )
    .finally(() => request.abortSignal.removeEventListener("abort", onAbort));
  return channel;
}
