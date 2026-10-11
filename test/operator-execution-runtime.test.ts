import assert from "node:assert/strict";
import { test } from "node:test";
import {
  executionSummary,
  failureNotice,
  runtimeCommand,
  runtimeErrors,
  runtimeSummary,
  runtimeValues,
  waitRoute,
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

const assignment = (over: Record<string, unknown> = {}) =>
  ({
    assignmentId: "a1",
    profileId: "p1",
    state: "pending",
    waitReason: null,
    runtime: { harness: "claude", model: "sonnet", reasoningEffort: "high" },
    executionGeneration: null,
    ...over,
  }) as unknown as Parameters<typeof executionSummary>[0];
const generation = (harness: string, failure: unknown = null) => ({
  workId: "w1",
  assignmentVersion: 1,
  requestSequence: 1,
  instructionsRevision: 1,
  profileRevision: 1,
  harness,
  failure,
});

test("execution summaries use the binding harness, else the captured runtime", () => {
  assert.deepEqual(executionSummary(assignment()), {
    harness: "claude",
    line: "Claude · sonnet · high",
    note: null,
  });
  assert.equal(
    executionSummary(assignment({ runtime: { harness: "codex" } })).line,
    "Codex",
  );
  const moved = executionSummary(
    assignment({ executionGeneration: generation("codex") }),
  );
  assert.equal(moved.line, "Codex");
  assert.match(moved.note ?? "", /stays on Codex.*selects Claude/);
});

test("runtime waits map to explanations and routes; unknown wording does not", () => {
  const routes = (reason: string) =>
    waitRoute(assignment({ waitReason: reason }))?.routes.map((r) => r.href);
  const notConfigured = waitRoute(
    assignment({ waitReason: "Claude runtime is not configured" }),
  );
  assert.match(notConfigured?.message ?? "", /not enabled.*never falls back/);
  assert.match(notConfigured?.message ?? "", /Stop/);
  assert.deepEqual(routes("Claude runtime is not configured"), [
    "/app/profiles/p1/settings",
    "/app/settings/runtime",
  ]);
  const restart = waitRoute(
    assignment({
      waitReason: "Claude runtime unavailable; restart the service",
    }),
  );
  assert.match(restart?.message ?? "", /restart the service.*see Recovery/);
  assert.deepEqual(routes("Codex runtime unavailable; restart the service"), [
    "/app/settings/runtime",
    "/app/assignments/a1/recovery",
  ]);
  assert.match(
    waitRoute(
      assignment({
        waitReason: "Codex runtime unavailable; restart the service",
      }),
    )?.message ?? "",
    /The Codex runtime is unavailable/,
  );
  const detail = waitRoute(
    assignment({
      waitReason: "Claude runtime unavailable: sandbox self-test failed",
    }),
  );
  assert.match(
    detail?.message ?? "",
    /^Claude runtime unavailable: sandbox self-test failed\./,
  );
  assert.equal(
    waitRoute(assignment({ waitReason: "Project is paused" })),
    null,
  );
  assert.equal(waitRoute(assignment()), null);
});

test("only held Claude failures render a failure notice", () => {
  const failed = { classification: "permanent", reasonCode: "error_max_turns" };
  const notice = failureNotice(
    assignment({
      state: "held",
      executionGeneration: generation("claude", failed),
    }),
  );
  assert.equal(
    notice?.message,
    "Turn failed (permanent · error_max_turns). Held without automatic retry.",
  );
  assert.deepEqual(notice?.routes, [
    { label: "Recovery", href: "/app/assignments/a1/recovery" },
  ]);
  assert.equal(
    failureNotice(
      assignment({
        state: "held",
        executionGeneration: generation("codex", failed),
      }),
    ),
    null,
  );
  assert.equal(
    failureNotice(
      assignment({ executionGeneration: generation("claude", failed) }),
    ),
    null,
  );
});
