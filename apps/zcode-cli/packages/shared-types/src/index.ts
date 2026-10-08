export type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type RunContext = {
  argv: string[];
  stderr: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
};

export type GlobalLocale = "auto" | "en-US" | "zh-CN";
export type GlobalDetectedLocale = Exclude<GlobalLocale, "auto">;

/**
 * How a headless run reports itself.
 *
 * `text` prints the answer only. `json` prints one summary document after the
 * turn. `stream-json` additionally writes each session event as its own line
 * (NDJSON) while the turn runs, for callers that drive the CLI as a subprocess
 * and need progress — a bridge rendering a chat UI, for instance — rather than
 * only the finished answer.
 */
export type GlobalOutputFormat = "text" | "json" | "stream-json";

export type GlobalOptions = {
  browserExecutable?: string;
  browserUse?: "headless";
  detectedLocale?: GlobalDetectedLocale;
  enableWorkflow?: boolean;
  force: boolean;
  /** 本次会话使用的 agent harness（zcode / claude-code / codex / pi）及其模型、思考档位。 */
  harness?: { harness: string; model?: string; thought?: string };
  json: boolean;
  locale?: GlobalLocale;
  memoryBench?: boolean;
  noColor: boolean;
  outputFormat?: GlobalOutputFormat;
  verbose: boolean;
};

export type RuntimeInfo = {
  arch: NodeJS.Architecture;
  cwd: string;
  execPath: string;
  node: string;
  platform: NodeJS.Platform;
  sea: boolean;
  versions: NodeJS.ProcessVersions;
};
