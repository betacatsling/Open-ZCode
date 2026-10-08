import assert from "node:assert/strict";
import test from "node:test";
import type { MessageWithParts } from "@zcode/contracts";
import { buildHarnessHandoffPrompt } from "../../src/runtime/harness/handoff.js";
import { reverseApplyHunks, toDiffHunks } from "../../src/runtime/harness/external-turn.js";
import {
  createRuntimeHarnessState,
  isExternalHarnessSelection,
  parsePersistedHarnessState,
  resolveTurnHarnessSelection,
} from "../../src/runtime/harness/state.js";

function message(
  id: string,
  role: "user" | "assistant",
  parts: unknown[],
  extra: object = {},
): MessageWithParts {
  return { info: { id, role, ...extra }, parts } as unknown as MessageWithParts;
}

test("handoff prompt wraps visible transcript and keeps the current prompt last", () => {
  const prompt = buildHarnessHandoffPrompt({
    messages: [
      message("u1", "user", [{ type: "text", text: "remember CODEWORD:PINEAPPLE" }]),
      message("a1", "assistant", [
        { type: "reasoning", text: "secret reasoning" },
        { type: "text", text: "Noted." },
        {
          type: "tool",
          tool: "Bash",
          state: { status: "completed", input: { command: "ls" }, output: "a.txt" },
        },
      ]),
      message("hidden", "user", [{ type: "text", text: "internal" }], {
        semantics: { transcriptVisibility: "hidden" },
      }),
      message("u2", "user", [{ type: "text", text: "RECALL" }]),
    ],
    excludeMessageId: "u2",
    previousHarness: "claude-code",
    prompt: "RECALL",
  });
  assert.match(prompt, /^<zcode_conversation_handoff>/);
  assert.match(prompt, /previously handled by Claude Code/);
  assert.match(prompt, /CODEWORD:PINEAPPLE/);
  assert.match(prompt, /\[tool Bash\] \{"command":"ls"\}\n→ a\.txt/);
  assert.doesNotMatch(prompt, /secret reasoning/);
  assert.doesNotMatch(prompt, /internal/);
  assert.ok(prompt.endsWith("</zcode_conversation_handoff>\n\nRECALL"));
});

test("handoff is skipped when there is no earlier conversation and truncates oldest turns", () => {
  assert.equal(buildHarnessHandoffPrompt({ messages: [], prompt: "hi" }), "hi");
  const many = Array.from({ length: 20 }, (_, index) =>
    message(`u${index}`, "user", [{ type: "text", text: `turn-${index} ${"x".repeat(3000)}` }]),
  );
  const prompt = buildHarnessHandoffPrompt({ messages: many, prompt: "next" });
  assert.match(prompt, /earlier conversation omitted/);
  assert.match(prompt, /turn-19/);
  assert.doesNotMatch(prompt, /turn-0 /);
  assert.ok(prompt.length < 30_000);
});

test("toDiffHunks accepts structured patches, unified diffs and full-text changes", () => {
  const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] };
  assert.deepEqual(toDiffHunks({ filePath: "/a", kind: "update", structuredPatch: [hunk] }, "/a"), [
    hunk,
  ]);
  const unified = toDiffHunks(
    { filePath: "/a", kind: "update", unifiedDiff: "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n" },
    "/a",
  );
  assert.equal(unified.length, 1);
  assert.deepEqual(unified[0]?.lines, ["-old", "+new"]);
  const created = toDiffHunks(
    { filePath: "/n", kind: "add", oldText: "", newText: "line1\nline2\n" },
    "/n",
  );
  assert.ok(created[0]?.lines.includes("+line1"));
  assert.deepEqual(toDiffHunks({ filePath: "/x", kind: "update" }, "/x"), []);
});

test("persisted harness state is validated", () => {
  assert.equal(parsePersistedHarnessState(null), undefined);
  assert.equal(parsePersistedHarnessState({ selection: { harness: "bogus" } }), undefined);
  assert.deepEqual(
    parsePersistedHarnessState({
      selection: { harness: "codex", model: "gpt-5.5" },
      binding: { harness: "codex", nativeSessionId: "thr_1" },
    }),
    {
      selection: { harness: "codex", model: "gpt-5.5" },
      binding: { harness: "codex", nativeSessionId: "thr_1" },
    },
  );
  assert.deepEqual(
    parsePersistedHarnessState({
      selection: { harness: "pi" },
      binding: { harness: "zcode", nativeSessionId: "x" },
    }),
    { selection: { harness: "pi" } },
  );
});

test("turn harness: submission intent wins over the session selection", () => {
  const runtime = { harnessState: createRuntimeHarnessState() };
  assert.deepEqual(resolveTurnHarnessSelection(runtime, undefined), { harness: "zcode" });
  const selected = resolveTurnHarnessSelection(runtime, {
    harness: { harness: "pi", thought: "default" },
  } as never);
  assert.deepEqual(selected, { harness: "pi" });
  assert.equal(isExternalHarnessSelection(selected), true);
  assert.equal(isExternalHarnessSelection({ harness: "zcode" }), false);
});

test("reverseApplyHunks restores the pre-change file for checkpoints", () => {
  const hunks = toDiffHunks(
    {
      filePath: "/a",
      kind: "update",
      unifiedDiff: "--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n-hello\n+goodbye\n keep\n",
    },
    "/a",
  );
  assert.equal(reverseApplyHunks("/a", "goodbye\nkeep\n", hunks), "hello\nkeep\n");
  assert.equal(reverseApplyHunks("/a", "unrelated\n", hunks), undefined);
  assert.equal(reverseApplyHunks("/a", undefined, hunks), undefined);
});
