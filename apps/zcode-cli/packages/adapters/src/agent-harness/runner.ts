import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  AgentHarnessError,
  type AgentHarnessAvailability,
  type AgentHarnessEvent,
  type AgentHarnessRunRequest,
  type AgentHarnessRunnerPort,
  type ExternalAgentHarnessId,
} from "@zcode/contracts";
import { AGENT_HARNESS_CATALOG } from "@zcode/shared/agent-harness";
import { claudeCodeDriver } from "./claude-code.js";
import { codexDriver } from "./codex.js";
import type { HarnessDriver } from "./driver.js";
import {
  buildWindowsBatchCommandLine,
  isWindowsBatchFile,
  resolveAgentHarnessExecutable,
} from "./executable.js";
import { piDriver } from "./pi.js";
import { spawnHarnessProcess, type SpawnHarnessProcess } from "./process.js";

export const EXTERNAL_AGENT_HARNESS_IDS: readonly ExternalAgentHarnessId[] = [
  "claude-code",
  "codex",
  "pi",
];

const DRIVERS: Readonly<Record<ExternalAgentHarnessId, HarnessDriver>> = {
  "claude-code": claudeCodeDriver,
  codex: codexDriver,
  pi: piDriver,
};

/** 可执行文件覆盖：ZCODE_CLAUDE_CODE_PATH / ZCODE_CODEX_PATH / ZCODE_PI_PATH。 */
const EXECUTABLE_OVERRIDE_ENV: Readonly<Record<ExternalAgentHarnessId, string>> = {
  "claude-code": "ZCODE_CLAUDE_CODE_PATH",
  codex: "ZCODE_CODEX_PATH",
  pi: "ZCODE_PI_PATH",
};

const DETECT_CACHE_MS = 30_000;
const VERSION_TIMEOUT_MS = 8_000;

export interface AgentHarnessRunnerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  /** 驱动辅助文件目录（默认 ~/.zcode/agent-harness）。 */
  readonly supportDir?: string;
  readonly spawnProcess?: SpawnHarnessProcess;
  readonly now?: () => number;
}

/**
 * 外部 harness 运行器：解析可执行文件、检测可用性，并把运行请求分派给对应驱动。
 */
export function createAgentHarnessRunner(
  options: AgentHarnessRunnerOptions = {},
): AgentHarnessRunnerPort {
  const baseEnv = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const supportDir = options.supportDir ?? path.join(home, ".zcode", "agent-harness");
  const spawnProcess = options.spawnProcess ?? spawnHarnessProcess;
  const now = options.now ?? Date.now;
  let detectCache: { at: number; value: Promise<readonly AgentHarnessAvailability[]> } | undefined;

  const resolveExecutable = (harness: ExternalAgentHarnessId): Promise<string | undefined> => {
    const override = baseEnv[EXECUTABLE_OVERRIDE_ENV[harness]];
    if (override) return Promise.resolve(override);
    const executable = AGENT_HARNESS_CATALOG[harness].executable ?? harness;
    return resolveAgentHarnessExecutable(executable, { env: baseEnv, platform, home });
  };

  const harnessEnv = (): NodeJS.ProcessEnv => {
    const env = { ...baseEnv };
    // ZCode 自身可能运行在 Claude Code 终端里：嵌套标记会让子 claude 拒绝启动或改变行为。
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    return env;
  };

  return {
    run(request: AgentHarnessRunRequest): AsyncIterable<AgentHarnessEvent> {
      const driver = DRIVERS[request.harness];
      return {
        async *[Symbol.asyncIterator]() {
          const executablePath = await resolveExecutable(request.harness);
          if (!executablePath) {
            const entry = AGENT_HARNESS_CATALOG[request.harness];
            throw new AgentHarnessError(
              request.harness,
              "not_installed",
              `${entry.label} is not installed (${entry.executable ?? request.harness} not found). Install it with: ${entry.installCommand ?? ""}`.trim(),
            );
          }
          yield* driver.run(request, {
            executablePath,
            spawnProcess,
            env: harnessEnv(),
            platform,
            supportDir,
          });
        },
      };
    },
    detect(): Promise<readonly AgentHarnessAvailability[]> {
      if (detectCache && now() - detectCache.at < DETECT_CACHE_MS) return detectCache.value;
      const value = Promise.all(
        EXTERNAL_AGENT_HARNESS_IDS.map(async (harness): Promise<AgentHarnessAvailability> => {
          const executablePath = await resolveExecutable(harness);
          if (!executablePath) return { harness, available: false };
          const version = await readVersion(executablePath, platform, harnessEnv());
          return { harness, available: true, executablePath, ...(version ? { version } : {}) };
        }),
      );
      detectCache = { at: now(), value };
      return value;
    },
  };
}

function readVersion(
  executablePath: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const useCmd = platform === "win32" && isWindowsBatchFile(executablePath);
    const file = useCmd ? (env.ComSpec ?? "cmd.exe") : executablePath;
    const args = useCmd
      ? ["/d", "/s", "/c", buildWindowsBatchCommandLine(executablePath, ["--version"])]
      : ["--version"];
    execFile(
      file,
      args,
      { env, timeout: VERSION_TIMEOUT_MS, windowsHide: true, windowsVerbatimArguments: useCmd },
      (error, stdout, stderr) => {
        if (error) return resolve(undefined);
        const line = `${stdout}${stderr}`.trim().split("\n")[0]?.trim();
        resolve(line ? line.slice(0, 80) : undefined);
      },
    );
  });
}
