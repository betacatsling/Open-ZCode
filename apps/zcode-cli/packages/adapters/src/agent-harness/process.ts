import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { terminateGenericPosixProcessGroup } from "../exec/process-tree.js";
import { buildWindowsBatchCommandLine, isWindowsBatchFile } from "./executable.js";

/** stderr / 非 JSON 输出只保留尾部，用于错误信息，避免长时间运行时内存无限增长。 */
const DIAGNOSTIC_TAIL_CHARS = 4_000;

export interface HarnessProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string;
  /** stdout 中无法解析为 JSON 的行（例如 CLI 直接打印的错误提示）。 */
  readonly nonJsonTail: string;
  readonly spawnError?: Error;
}

/**
 * 双向 JSONL 子进程：stdout 严格按 LF 切分为记录（不能用 readline：它会在 U+2028/U+2029
 * 处错误断行），stdin 保持打开用于发送命令与审批应答。
 */
export interface HarnessProcess {
  readonly records: AsyncIterable<unknown>;
  readonly exited: Promise<HarnessProcessExit>;
  send(record: unknown): void;
  endInput(): void;
  kill(): void;
}

export interface SpawnHarnessProcessOptions {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

export type SpawnHarnessProcess = (options: SpawnHarnessProcessOptions) => HarnessProcess;

const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

/** 宿主退出时同步结束仍在运行的 harness 进程组，避免孤儿进程继续修改工作区。 */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const child of liveChildren) killChild(child, process.platform);
  });
}

export const spawnHarnessProcess: SpawnHarnessProcess = (options) => {
  const platform = options.platform ?? process.platform;
  const env = { ...(options.env ?? process.env) };
  const useCmdShim = platform === "win32" && isWindowsBatchFile(options.executablePath);
  const child = useCmdShim
    ? spawn(
        env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", buildWindowsBatchCommandLine(options.executablePath, options.args)],
        { cwd: options.cwd, env, stdio: "pipe", windowsHide: true, windowsVerbatimArguments: true },
      )
    : spawn(options.executablePath, [...options.args], {
        cwd: options.cwd,
        env,
        stdio: "pipe",
        windowsHide: true,
        // POSIX 下独立进程组，取消时可以连同 harness 派生的 shell/工具进程一起结束。
        detached: platform !== "win32",
      });
  liveChildren.add(child);
  installExitHook();

  const queue = createRecordQueue();
  let stderrTail = "";
  let nonJsonTail = "";
  let spawnError: Error | undefined;
  let inputEnded = false;
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  const pushLine = (line: string) => {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.trim().length === 0) return;
    try {
      queue.push(JSON.parse(trimmed));
    } catch {
      nonJsonTail = appendTail(nonJsonTail, `${trimmed}\n`);
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    buffered += decoder.write(chunk);
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      pushLine(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = appendTail(stderrTail, chunk.toString("utf8"));
  });
  // stdin 被 harness 提前关闭（例如启动即失败）时 EPIPE 不能变成未捕获异常。
  child.stdin?.on("error", () => undefined);

  const exited = new Promise<HarnessProcessExit>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      liveChildren.delete(child);
      pushLine(buffered + decoder.end());
      buffered = "";
      queue.close();
      resolve({
        exitCode,
        signal,
        stderrTail,
        nonJsonTail,
        ...(spawnError ? { spawnError } : {}),
      });
    };
    child.once("error", (error) => {
      spawnError = error;
      finish(null, null);
    });
    child.once("close", (code, signal) => finish(code, signal));
  });

  return {
    records: queue,
    exited,
    send(record) {
      if (inputEnded || !child.stdin || child.stdin.destroyed) return;
      child.stdin.write(`${JSON.stringify(record)}\n`);
    },
    endInput() {
      if (inputEnded) return;
      inputEnded = true;
      child.stdin?.end();
    },
    kill: () => killChild(child, platform),
  };
};

function killChild(child: ChildProcess, platform: NodeJS.Platform): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (platform === "win32") {
    // taskkill /T 结束整棵进程树；cmd 垫片下 child.kill 只会结束 cmd.exe 本身。
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => child.kill());
    return;
  }
  terminateGenericPosixProcessGroup(child);
}

function appendTail(current: string, next: string): string {
  const combined = current + next;
  return combined.length > DIAGNOSTIC_TAIL_CHARS
    ? combined.slice(combined.length - DIAGNOSTIC_TAIL_CHARS)
    : combined;
}

interface RecordQueue extends AsyncIterable<unknown> {
  push(record: unknown): void;
  close(): void;
}

function createRecordQueue(): RecordQueue {
  const items: unknown[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  return {
    push(record) {
      items.push(record);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (items.length > 0) {
          yield items.shift();
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
}

/** 进程失败时拼接给用户看的诊断（优先 stderr，其次 stdout 中的非 JSON 行）。 */
export function describeHarnessExit(exit: HarnessProcessExit): string {
  if (exit.spawnError) return exit.spawnError.message;
  const detail = (exit.stderrTail.trim() || exit.nonJsonTail.trim())
    .split("\n")
    .slice(-6)
    .join("\n");
  const status =
    exit.signal !== null ? `signal ${exit.signal}` : `exit code ${String(exit.exitCode)}`;
  return detail ? `${status}: ${detail}` : status;
}
