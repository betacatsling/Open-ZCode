import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { getWindowsEnvValue, windowsExecutableCandidates } from "../exec/windows-executable.js";

/**
 * 定位本机 Agent Harness（Claude Code / Codex / pi）可执行文件。
 *
 * 桌面端从 Dock/开始菜单启动时继承的 PATH 往往不含 npm 全局目录或 ~/.local/bin，
 * 因此在 PATH 之后再检查各 CLI 官方安装器与常见包管理器的默认目录。
 */
export async function resolveAgentHarnessExecutable(
  executable: string,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string } = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  for (const candidate of executableCandidates(executable, env, platform, home)) {
    if (await isExecutableFile(candidate, platform)) return candidate;
  }
  return undefined;
}

function executableCandidates(
  executable: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): string[] {
  if (platform === "win32") {
    const appData = getWindowsEnvValue(env, "APPDATA");
    const localAppData = getWindowsEnvValue(env, "LOCALAPPDATA");
    const extraDirs = [
      appData ? `${appData}\\npm` : undefined,
      localAppData ? `${localAppData}\\pnpm` : undefined,
      `${home}\\.local\\bin`,
      `${home}\\.bun\\bin`,
    ].filter((dir): dir is string => Boolean(dir));
    const pathValue = [getWindowsEnvValue(env, "PATH"), ...extraDirs].filter(Boolean).join(";");
    return windowsExecutableCandidates(executable, { ...env, PATH: pathValue });
  }
  const pathDirs = (env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);
  const extraDirs = [
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    join(home, "Library", "pnpm"),
    join(home, ".local", "share", "pnpm"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  return [...new Set([...pathDirs, ...extraDirs])].map((dir) => join(dir, executable));
}

async function isExecutableFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    if (platform !== "win32") await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const WINDOWS_CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/** npm 在 Windows 上安装的是 .cmd/.bat 垫片，必须经 cmd.exe 启动（Node 拒绝直接 spawn）。 */
export function isWindowsBatchFile(path: string): boolean {
  return /\.(cmd|bat)$/i.test(path);
}

/**
 * 为 `cmd.exe /d /s /c "<command line>"` 转义单个参数：先按 MSVCRT 规则加引号，
 * 再对 cmd 元字符加 `^`。npm 垫片会再次经过 cmd 解析，所以元字符需要转义两次。
 */
export function quoteWindowsCmdArgument(value: string): string {
  let quoted = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  quoted = `"${quoted}"`;
  return quoted.replace(WINDOWS_CMD_META_CHARS, "^$1").replace(WINDOWS_CMD_META_CHARS, "^$1");
}

export function buildWindowsBatchCommandLine(path: string, args: readonly string[]): string {
  const command = path.replace(WINDOWS_CMD_META_CHARS, "^$1");
  return `"${[command, ...args.map(quoteWindowsCmdArgument)].join(" ")}"`;
}
