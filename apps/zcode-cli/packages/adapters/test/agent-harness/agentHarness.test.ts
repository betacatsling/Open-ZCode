import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AgentHarnessApprovalRequest,
  AgentHarnessEvent,
  AgentHarnessRunRequest,
} from "@zcode/contracts";
import {
  ClaudeCodeStreamState,
  buildClaudeCodeArgs,
  claudePermissionArgs,
  readClaudeFileChanges,
} from "../../src/agent-harness/claude-code.js";
import {
  CodexStreamState,
  codexPermissionConfig,
  readCodexFileChanges,
} from "../../src/agent-harness/codex.js";
import {
  PI_APPROVAL_POLICY_ENV,
  PI_APPROVAL_TITLE,
  PiStreamState,
  buildPiArgs,
  mapPiToolCall,
  piApprovalPolicy,
} from "../../src/agent-harness/pi.js";
import { createEventChannel } from "../../src/agent-harness/channel.js";
import { createAgentHarnessRunner } from "../../src/agent-harness/runner.js";
import type {
  HarnessProcess,
  SpawnHarnessProcessOptions,
} from "../../src/agent-harness/process.js";

const MODES = ["plan", "build", "edit", "auto", "yolo"] as const;

function request(overrides: Partial<AgentHarnessRunRequest> = {}): AgentHarnessRunRequest {
  return {
    harness: "claude-code",
    selection: { harness: "claude-code" },
    cwd: "/tmp/project",
    prompt: "hello",
    permission: { mode: "build", planEnabled: false },
    abortSignal: new AbortController().signal,
    requestApproval: async () => ({ decision: "allow" }),
    ...overrides,
  };
}

// ---------------------------------------------------------------- 权限模式映射

test("claude permission args map every ZCode mode", () => {
  const mapped = Object.fromEntries(
    MODES.map((mode) => [mode, claudePermissionArgs({ mode, planEnabled: false }).join(" ")]),
  );
  assert.deepEqual(mapped, {
    plan: "--permission-mode plan",
    build: "--permission-mode default",
    edit: "--permission-mode acceptEdits",
    auto: "--permission-mode auto",
    yolo: "--dangerously-skip-permissions",
  });
  // 计划开关优先于模式。
  assert.deepEqual(claudePermissionArgs({ mode: "yolo", planEnabled: true }), [
    "--permission-mode",
    "plan",
  ]);
});

test("codex permission config maps every ZCode mode to sandbox + approval policy", () => {
  const mapped = Object.fromEntries(
    MODES.map((mode) => [mode, codexPermissionConfig({ mode, planEnabled: false })]),
  );
  assert.deepEqual(mapped, {
    plan: { sandbox: "read-only", approvalPolicy: "never" },
    build: { sandbox: "workspace-write", approvalPolicy: "untrusted" },
    edit: { sandbox: "workspace-write", approvalPolicy: "on-request" },
    auto: { sandbox: "workspace-write", approvalPolicy: "on-request" },
    yolo: { sandbox: "danger-full-access", approvalPolicy: "never" },
  });
});

test("pi approval policy maps every ZCode mode and read-only restricts tools", () => {
  const mapped = Object.fromEntries(
    MODES.map((mode) => [mode, piApprovalPolicy({ mode, planEnabled: false })]),
  );
  assert.deepEqual(mapped, {
    plan: "read-only",
    build: "ask-mutations",
    edit: "ask-bash",
    auto: "ask-bash",
    yolo: "off",
  });
  const planArgs = buildPiArgs(
    request({
      harness: "pi",
      selection: { harness: "pi" },
      permission: { mode: "plan", planEnabled: false },
    }),
    "sid",
    undefined,
  );
  assert.deepEqual(planArgs, [
    "--mode",
    "rpc",
    "--session-id",
    "sid",
    "--tools",
    "read,grep,find,ls",
  ]);
});

test("claude args carry model, effort and resume id", () => {
  const args = buildClaudeCodeArgs(
    request({
      selection: { harness: "claude-code", model: "sonnet", thought: "high" },
      resumeSessionId: "abc",
    }),
  );
  assert.ok(args.includes("--permission-prompt-tool"));
  assert.deepEqual(args.slice(-6), ["--model", "sonnet", "--effort", "high", "--resume", "abc"]);
});

// ---------------------------------------------------------------- Claude Code 解析

test("claude stream state emits session, deltas without duplicating the final assistant message", () => {
  const state = new ClaudeCodeStreamState();
  const events = [
    { type: "system", subtype: "init", session_id: "s-1", model: "claude-x" },
    { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } },
    {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
    },
    {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
    },
    {
      type: "assistant",
      message: {
        id: "m1",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "Hi" },
          {
            type: "tool_use",
            id: "t1",
            name: "Write",
            input: { file_path: "/a.txt", content: "x" },
          },
        ],
      },
    },
    {
      type: "assistant",
      parent_tool_use_id: "task-1",
      message: { id: "sub", content: [{ type: "text", text: "inner" }] },
    },
  ].flatMap((record) => state.parse(record));
  assert.deepEqual(events, [
    { type: "session", nativeSessionId: "s-1", model: "claude-x" },
    { type: "reasoning_delta", text: "hmm" },
    { type: "text_delta", text: "Hi" },
    {
      type: "tool_call",
      call: {
        id: "t1",
        name: "Write",
        nativeName: "Write",
        input: { file_path: "/a.txt", content: "x" },
      },
    },
  ]);
  assert.equal(state.findPendingToolCall("Write"), "t1");
});

test("claude tool results carry structuredPatch diffs", () => {
  const state = new ClaudeCodeStreamState();
  const events = state.parse({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    tool_use_result: {
      type: "update",
      filePath: "/a.txt",
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] },
      ],
    },
  });
  assert.deepEqual(events, [
    {
      type: "tool_result",
      callId: "t1",
      output: "ok",
      isError: false,
      fileChanges: [
        {
          filePath: "/a.txt",
          kind: "update",
          structuredPatch: [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual(
    readClaudeFileChanges({
      type: "create",
      filePath: "/n.txt",
      content: "new",
      structuredPatch: [],
    }),
    [{ filePath: "/n.txt", kind: "add", oldText: "", newText: "new" }],
  );
});

// ---------------------------------------------------------------- Codex 解析

test("codex stream state maps command execution and file change items", () => {
  const state = new CodexStreamState();
  const started = state.parseNotification("item/started", {
    item: { id: "c1", type: "commandExecution", command: "ls" },
  });
  assert.deepEqual(started, [
    {
      type: "tool_call",
      call: { id: "c1", name: "Bash", nativeName: "commandExecution", input: { command: "ls" } },
    },
  ]);
  const done = state.parseNotification("item/completed", {
    item: { id: "c1", type: "commandExecution", command: "ls", status: "declined" },
  });
  assert.deepEqual(done, [
    { type: "tool_result", callId: "c1", output: "Command declined by the user.", isError: true },
  ]);

  const patch = state.parseNotification("item/completed", {
    item: {
      id: "f1",
      type: "fileChange",
      status: "completed",
      changes: [{ path: "/w/hello.txt", kind: { type: "add" }, diff: "hi\n" }],
    },
  });
  assert.equal(patch[0]?.type, "tool_call");
  assert.deepEqual(patch[0]?.type === "tool_call" ? patch[0].call.name : undefined, "Write");
  assert.deepEqual(patch[1], {
    type: "tool_result",
    callId: "f1",
    output: "add /w/hello.txt",
    isError: false,
    fileChanges: [{ filePath: "/w/hello.txt", kind: "add", oldText: "", newText: "hi\n" }],
  });
  assert.deepEqual(
    readCodexFileChanges({
      changes: [{ path: "/a", kind: { type: "update", move_path: "/b" }, diff: "@@ -1 +1 @@" }],
    }),
    [{ filePath: "/b", kind: "update", unifiedDiff: "@@ -1 +1 @@" }],
  );
});

test("codex text and reasoning deltas are not duplicated by completed items", () => {
  const state = new CodexStreamState();
  const events = [
    state.parseNotification("item/reasoning/summaryTextDelta", { itemId: "r1", delta: "think" }),
    state.parseNotification("item/completed", {
      item: { id: "r1", type: "reasoning", summary: ["think"] },
    }),
    state.parseNotification("item/agentMessage/delta", { itemId: "a1", delta: "Hello" }),
    state.parseNotification("item/completed", {
      item: { id: "a1", type: "agentMessage", text: "Hello" },
    }),
    state.parseNotification("item/completed", {
      item: { id: "a2", type: "agentMessage", text: "Again" },
    }),
  ].flat();
  assert.deepEqual(events, [
    { type: "reasoning_delta", text: "think" },
    { type: "text_delta", text: "Hello" },
    { type: "text_delta", text: "\n\n" },
    { type: "text_delta", text: "Again" },
  ]);
});

test("codex usage is reported per turn relative to the thread baseline", () => {
  const state = new CodexStreamState();
  const first = state.parseNotification("thread/tokenUsage/updated", {
    tokenUsage: {
      total: { inputTokens: 1100, outputTokens: 60, totalTokens: 1160 },
      last: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    },
  });
  assert.equal(first[0]?.type, "usage");
  const usage = first[0]?.type === "usage" ? first[0].usage : undefined;
  assert.equal(usage?.inputTokens, 100);
  assert.equal(usage?.outputTokens, 10);
});

// ---------------------------------------------------------------- pi 解析

test("pi tool calls map to ZCode native tool shapes", () => {
  assert.deepEqual(mapPiToolCall("bash", { command: "ls" }), {
    name: "Bash",
    input: { command: "ls" },
  });
  assert.deepEqual(mapPiToolCall("read", { path: "a.ts", offset: 2 }), {
    name: "Read",
    input: { file_path: "a.ts", offset: 2 },
  });
  assert.deepEqual(mapPiToolCall("write", { path: "a.ts", content: "x" }), {
    name: "Write",
    input: { file_path: "a.ts", content: "x" },
  });
  assert.deepEqual(
    mapPiToolCall("edit", { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }),
    {
      name: "Edit",
      input: { file_path: "a.ts", old_string: "a", new_string: "b" },
    },
  );
  assert.deepEqual(mapPiToolCall("find", { pattern: "*.ts" }), {
    name: "Glob",
    input: { pattern: "*.ts" },
  });
  assert.deepEqual(mapPiToolCall("custom", { a: 1 }), { name: "custom", input: { a: 1 } });
});

test("pi stream state emits deltas, tool results with diffs, cumulative usage and failures", () => {
  const state = new PiStreamState();
  const events = [
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "t" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } },
    {
      type: "tool_execution_start",
      toolCallId: "p1",
      toolName: "edit",
      args: { path: "a.txt", edits: [{ oldText: "a", newText: "b" }] },
    },
    {
      type: "tool_execution_end",
      toolCallId: "p1",
      toolName: "edit",
      result: {
        content: [{ type: "text", text: "ok" }],
        details: { patch: "@@ -1 +1 @@\n-a\n+b" },
      },
    },
    {
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 2 } },
    },
    {
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", usage: { input: 5, output: 1 } },
    },
  ].flatMap((record) => state.parse(record));
  assert.deepEqual(events.slice(0, 2), [
    { type: "reasoning_delta", text: "t" },
    { type: "text_delta", text: "x" },
  ]);
  assert.equal(events[2]?.type, "tool_call");
  const result = events[3];
  assert.equal(result?.type, "tool_result");
  assert.deepEqual(result?.type === "tool_result" ? result.fileChanges : undefined, [
    { filePath: "a.txt", kind: "update", unifiedDiff: "@@ -1 +1 @@\n-a\n+b" },
  ]);
  const lastUsage = events.at(-1);
  assert.equal(lastUsage?.type === "usage" ? lastUsage.usage.inputTokens : undefined, 15);
  state.parse({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "boom" },
  });
  assert.equal(state.failure, "boom");
});

// ---------------------------------------------------------------- channel

test("event channel buffers, closes and propagates failures", async () => {
  let cancelled = false;
  const channel = createEventChannel<number>(() => {
    cancelled = true;
  });
  channel.push(1);
  channel.push(2);
  channel.close();
  const seen: number[] = [];
  for await (const value of channel) seen.push(value);
  assert.deepEqual(seen, [1, 2]);

  const failing = createEventChannel<number>(() => {});
  failing.fail(new Error("nope"));
  await assert.rejects(async () => {
    for await (const _ of failing) void _;
  }, /nope/);

  const early = createEventChannel<number>(() => {
    cancelled = true;
  });
  early.push(1);
  for await (const _ of early) break;
  assert.equal(cancelled, true);
});

// ---------------------------------------------------------------- 驱动 + 审批桥（假进程）

interface FakeProcess extends HarnessProcess {
  readonly sent: unknown[];
  readonly options: SpawnHarnessProcessOptions;
}

/** 脚本化的假 harness 进程：reply 根据收到的 stdin 记录推送 stdout 记录。 */
function fakeSpawn(
  script: (record: unknown, emit: (record: unknown) => void, exit: () => void) => void,
  spawned: FakeProcess[],
) {
  return (options: SpawnHarnessProcessOptions): HarnessProcess => {
    const queue: unknown[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let resolveExit!: (value: Awaited<HarnessProcess["exited"]>) => void;
    const exited = new Promise<Awaited<HarnessProcess["exited"]>>((resolve) => {
      resolveExit = resolve;
    });
    const emit = (record: unknown) => {
      queue.push(record);
      wake?.();
    };
    const exit = () => {
      done = true;
      wake?.();
      resolveExit({ exitCode: 0, signal: null, stderrTail: "", nonJsonTail: "" });
    };
    const proc: FakeProcess = {
      options,
      sent: [],
      records: {
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (queue.length > 0) {
              yield queue.shift();
              continue;
            }
            if (done) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
          }
        },
      },
      exited,
      send(record) {
        proc.sent.push(record);
        queueMicrotask(() => script(record, emit, exit));
      },
      endInput() {
        exit();
      },
      kill() {
        exit();
      },
    };
    spawned.push(proc);
    return proc;
  };
}

async function collect(iterable: AsyncIterable<AgentHarnessEvent>): Promise<AgentHarnessEvent[]> {
  const events: AgentHarnessEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test("claude driver bridges can_use_tool approvals into requestApproval", async () => {
  const spawned: FakeProcess[] = [];
  const approvals: AgentHarnessApprovalRequest[] = [];
  const runner = createAgentHarnessRunner({
    env: { ZCODE_CLAUDE_CODE_PATH: "/fake/claude" },
    spawnProcess: fakeSpawn((record, emit) => {
      const r = record as { type: string; response?: { response?: { behavior?: string } } };
      if (r.type === "user") {
        emit({ type: "system", subtype: "init", session_id: "native-1" });
        emit({
          type: "assistant",
          message: {
            id: "m",
            content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "rm x" } }],
          },
        });
        emit({
          type: "control_request",
          request_id: "req-1",
          request: {
            subtype: "can_use_tool",
            tool_name: "Bash",
            tool_use_id: "t1",
            input: { command: "rm x" },
          },
        });
      } else if (r.type === "control_response") {
        const denied = r.response?.response?.behavior === "deny";
        emit({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: denied ? "denied" : "ok",
                is_error: denied,
              },
            ],
          },
        });
        emit({
          type: "result",
          subtype: "success",
          is_error: false,
          usage: { input_tokens: 3, output_tokens: 1 },
        });
      }
    }, spawned),
  });
  const events = await collect(
    runner.run(
      request({
        requestApproval: async (approval) => {
          approvals.push(approval);
          return { decision: "deny", reason: "no" };
        },
      }),
    ),
  );
  assert.equal(spawned[0]?.options.executablePath, "/fake/claude");
  assert.deepEqual(approvals, [{ callId: "t1", toolName: "Bash", input: { command: "rm x" } }]);
  const response = spawned[0]?.sent.find(
    (record) => (record as { type: string }).type === "control_response",
  );
  assert.deepEqual(response, {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "req-1",
      response: { behavior: "deny", message: "no" },
    },
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ["session", "tool_call", "tool_result", "usage"],
  );
});

test("pi driver answers the approval extension confirm with extension_ui_response", async () => {
  const supportDir = await mkdtemp(join(tmpdir(), "zcode-pi-test-"));
  try {
    const spawned: FakeProcess[] = [];
    const runner = createAgentHarnessRunner({
      env: { ZCODE_PI_PATH: "/fake/pi" },
      supportDir,
      spawnProcess: fakeSpawn((record, emit, exit) => {
        const r = record as { type: string; confirmed?: boolean };
        if (r.type === "prompt") {
          emit({ type: "response", id: "zcode-prompt", command: "prompt", success: true });
          emit({
            type: "extension_ui_request",
            id: "ui-1",
            method: "confirm",
            title: PI_APPROVAL_TITLE,
            message: JSON.stringify({
              toolCallId: "p1",
              toolName: "bash",
              input: { command: "touch x" },
            }),
          });
        } else if (r.type === "extension_ui_response") {
          emit({
            type: "tool_execution_start",
            toolCallId: "p1",
            toolName: "bash",
            args: { command: "touch x" },
          });
          emit({
            type: "tool_execution_end",
            toolCallId: "p1",
            toolName: "bash",
            result: { content: [{ type: "text", text: "" }] },
          });
          emit({ type: "agent_settled" });
          setTimeout(exit, 5);
        }
      }, spawned),
    });
    const approvals: AgentHarnessApprovalRequest[] = [];
    const events = await collect(
      runner.run(
        request({
          harness: "pi",
          selection: { harness: "pi" },
          requestApproval: async (approval) => {
            approvals.push(approval);
            return { decision: "allow" };
          },
        }),
      ),
    );
    const proc = spawned[0]!;
    assert.equal(proc.options.env?.[PI_APPROVAL_POLICY_ENV], "ask-mutations");
    const extIndex = proc.options.args.indexOf("--extension");
    assert.ok(extIndex > 0);
    assert.match(await readFile(proc.options.args[extIndex + 1]!, "utf8"), /ctx\.ui\.confirm/);
    assert.deepEqual(approvals, [
      { callId: "p1", toolName: "Bash", input: { command: "touch x" } },
    ]);
    assert.deepEqual(
      proc.sent.find((record) => (record as { type: string }).type === "extension_ui_response"),
      { type: "extension_ui_response", id: "ui-1", confirmed: true },
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ["session", "tool_call", "tool_result"],
    );
  } finally {
    await rm(supportDir, { recursive: true, force: true });
  }
});

test("runner reports not_installed when the executable cannot be found", async () => {
  const runner = createAgentHarnessRunner({
    env: { PATH: "/nonexistent" },
    home: "/nonexistent-home",
    platform: "linux",
  });
  await assert.rejects(
    collect(runner.run(request())),
    (error: Error & { code?: string }) => error.code === "not_installed",
  );
  const availability = await runner.detect();
  assert.deepEqual(
    availability.map((entry) => [entry.harness, entry.available]),
    [
      ["claude-code", false],
      ["codex", false],
      ["pi", false],
    ],
  );
});
