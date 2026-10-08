import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAgentHarnessSelection,
  sameAgentHarnessSelection,
} from "../../shared/src/agent-harness.js";
import {
  buildComposerHarnessChoices,
  getComposerHarnessModelOptions,
  getComposerHarnessThoughtOptions,
  isComposerExternalHarness,
  isComposerHarnessSubmittable,
  readComposerHarness,
  selectComposerHarness,
  selectComposerHarnessModel,
  selectComposerHarnessThought,
} from "../src/v4/composer/composerHarnessState.js";
import { createComposerSubmissionConfig } from "../src/v4/composer/composerSubmissionConfig.js";

test("normalize collapses unknown harnesses to zcode and drops default model/thought", () => {
  assert.deepEqual(normalizeAgentHarnessSelection(undefined), { harness: "zcode" });
  assert.deepEqual(normalizeAgentHarnessSelection({ harness: "nope" } as never), {
    harness: "zcode",
  });
  assert.deepEqual(normalizeAgentHarnessSelection({ harness: "zcode", model: "x" }), {
    harness: "zcode",
  });
  assert.deepEqual(
    normalizeAgentHarnessSelection({ harness: "codex", model: "default", thought: "high" }),
    { harness: "codex", thought: "high" },
  );
  assert.equal(
    sameAgentHarnessSelection({ harness: "pi", model: "default" }, { harness: "pi" }),
    true,
  );
  assert.equal(sameAgentHarnessSelection({ harness: "pi" }, { harness: "codex" }), false);
});

test("readComposerHarness tolerates invalid persisted drafts", () => {
  assert.equal(readComposerHarness("garbage"), undefined);
  assert.equal(readComposerHarness({ harness: 42 }), undefined);
  assert.deepEqual(readComposerHarness({ harness: "claude-code", model: "opus" }), {
    harness: "claude-code",
    model: "opus",
  });
});

test("switching harness resets harness model/thought; same harness keeps them", () => {
  const claude = { harness: "claude-code" as const, model: "opus", thought: "high" };
  assert.deepEqual(selectComposerHarness(claude, "claude-code"), claude);
  assert.deepEqual(selectComposerHarness(claude, "codex"), { harness: "codex" });
  assert.deepEqual(selectComposerHarness(claude, "zcode"), { harness: "zcode" });
  assert.deepEqual(selectComposerHarness(claude, "bogus"), claude);
});

test("model and thought pickers only apply to external harnesses", () => {
  assert.deepEqual(selectComposerHarnessModel({ harness: "zcode" }, "opus"), { harness: "zcode" });
  assert.deepEqual(selectComposerHarnessModel({ harness: "claude-code" }, "opus"), {
    harness: "claude-code",
    model: "opus",
  });
  assert.deepEqual(
    selectComposerHarnessModel({ harness: "claude-code", model: "opus" }, "default"),
    {
      harness: "claude-code",
    },
  );
  assert.deepEqual(selectComposerHarnessThought({ harness: "pi" }, "max"), {
    harness: "pi",
    thought: "max",
  });
  assert.equal(isComposerExternalHarness({ harness: "pi" }), true);
  assert.equal(isComposerExternalHarness(undefined), false);
});

test("model options come from the harness catalog and keep unknown current values", () => {
  const claude = getComposerHarnessModelOptions({
    harness: "claude-code",
    model: "claude-custom-1",
  });
  assert.deepEqual(
    claude.options.map((option) => option.value),
    ["default", "sonnet", "opus", "haiku", "claude-custom-1"],
  );
  assert.equal(claude.current, "claude-custom-1");
  assert.deepEqual(getComposerHarnessModelOptions({ harness: "codex" }).current, "default");
  const thoughts = getComposerHarnessThoughtOptions({ harness: "codex", thought: "high" });
  assert.equal(thoughts.current, "high");
  assert.ok(thoughts.options.includes("minimal"));
});

test("harness choices merge reported availability with install and login hints", () => {
  const unknown = buildComposerHarnessChoices(undefined);
  assert.deepEqual(
    unknown.map((choice) => [choice.id, choice.status]),
    [
      ["zcode", "available"],
      ["claude-code", "unknown"],
      ["codex", "unknown"],
      ["pi", "unknown"],
    ],
  );
  const reported = buildComposerHarnessChoices([
    { harness: "claude-code", available: true, version: "2.1.0 (Claude Code)" },
    { harness: "codex", available: false },
  ]);
  assert.deepEqual(reported[1], {
    id: "claude-code",
    label: "Claude Code",
    status: "available",
    detail: "2.1.0 (Claude Code)",
    loginHint: "claude",
  });
  assert.deepEqual(reported[2], {
    id: "codex",
    label: "Codex",
    status: "missing",
    detail: "npm install -g @openai/codex",
    loginHint: "codex login",
  });
  assert.equal(reported[3]?.status, "unknown");
});

test("submission is blocked only for a harness known to be missing", () => {
  const availability = [
    { harness: "claude-code" as const, available: true },
    { harness: "codex" as const, available: false },
  ];
  assert.equal(isComposerHarnessSubmittable({ harness: "zcode" }, availability), true);
  assert.equal(isComposerHarnessSubmittable({ harness: "claude-code" }, availability), true);
  assert.equal(isComposerHarnessSubmittable({ harness: "codex" }, availability), false);
  assert.equal(isComposerHarnessSubmittable({ harness: "pi" }, availability), true);
  assert.equal(isComposerHarnessSubmittable({ harness: "codex" }, undefined), true);
});

test("submission config: external harness does not require a ZCode model", () => {
  assert.equal(createComposerSubmissionConfig({ mode: "build" }, null), null);
  assert.deepEqual(
    createComposerSubmissionConfig(
      { mode: "build", harness: { harness: "codex", thought: "default" } },
      null,
    ),
    { mode: "build", planEnabled: false, harness: { harness: "codex" } },
  );
  const plan = createComposerSubmissionConfig({ mode: "plan", harness: { harness: "pi" } }, null);
  assert.equal(plan?.mode, "build");
  assert.equal(plan?.planEnabled, true);
});
