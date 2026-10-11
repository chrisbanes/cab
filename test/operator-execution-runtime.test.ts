import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runtimeCommand,
  runtimeErrors,
  runtimeSummary,
  runtimeValues,
} from "../web/src/execution-runtime.js";
import {
  profileChanges,
  type ProfileConfigurationData,
} from "../web/src/settings-changes.js";

const claude = (model: string, effort: string) => ({
  runtimeHarness: "claude",
  runtimeModel: model,
  runtimeEffort: effort,
});

test("runtime errors name the field and accept blank or token values", () => {
  assert.deepEqual(runtimeErrors(claude("a b", "")), {
    "runtime.model": "Model cannot contain spaces.",
  });
  assert.deepEqual(runtimeErrors(claude("", "x".repeat(129))), {
    "runtime.reasoningEffort":
      "Reasoning effort must be at most 128 characters.",
  });
  assert.deepEqual(runtimeErrors(claude("", "")), {});
  assert.deepEqual(runtimeErrors(claude("sonnet", "high")), {});
  assert.deepEqual(
    runtimeErrors({ ...claude("a b", "c d"), runtimeHarness: "codex" }),
    {},
  );
});

test("runtime summaries and commands", () => {
  assert.equal(runtimeSummary({ harness: "codex" }), "Codex");
  assert.equal(
    runtimeSummary({
      harness: "claude",
      model: "sonnet",
      reasoningEffort: "high",
    }),
    "Claude · sonnet · high",
  );
  assert.equal(
    runtimeSummary({ harness: "claude", model: null, reasoningEffort: null }),
    "Claude · default model and effort",
  );
  assert.equal(
    runtimeSummary({
      harness: "claude",
      model: "sonnet",
      reasoningEffort: null,
    }),
    "Claude · sonnet · default effort",
  );
  assert.deepEqual(
    runtimeCommand({ ...claude("x", "y"), runtimeHarness: "codex" }),
    {
      harness: "codex",
    },
  );
  assert.deepEqual(runtimeCommand(claude(" sonnet ", "")), {
    harness: "claude",
    model: "sonnet",
    reasoningEffort: null,
  });
  assert.deepEqual(
    runtimeValues({ harness: "claude", model: null, reasoningEffort: "low" }),
    claude("", "low"),
  );
});

test("profile changes name a runtime change once", () => {
  const data = {
    profile: { name: "Builder", summary: null, revoked: false },
    capabilities: "code",
    runtime: { harness: "codex" },
  } as unknown as ProfileConfigurationData;
  const base = { name: "Builder", summary: "", capabilities: "code" };
  assert.deepEqual(
    profileChanges(data, { ...base, ...runtimeValues({ harness: "codex" }) }),
    [],
  );
  assert.deepEqual(profileChanges(data, { ...base, ...claude("sonnet", "") }), [
    "Runtime: Codex → Claude · sonnet · default effort",
  ]);
  const back = {
    ...data,
    runtime: { harness: "claude", model: "sonnet", reasoningEffort: null },
  } as ProfileConfigurationData;
  assert.deepEqual(
    profileChanges(back, {
      ...base,
      ...claude("sonnet", ""),
      runtimeHarness: "codex",
    }),
    ["Runtime: Claude · sonnet · default effort → Codex"],
  );
});
