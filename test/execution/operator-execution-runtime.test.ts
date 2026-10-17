import assert from "node:assert/strict";
import { test } from "node:test";
import { claudePolicyDisclosure } from "../../src/standalone/execution-policy.js";
import {
  executionSummary,
  failureNotice,
  harnessNote,
  runtimeCommand,
  runtimeErrors,
  runtimeSummary,
  runtimeValues,
  waitRoute,
} from "../../web/src/execution-runtime.js";
import {
  profileChanges,
  type ProfileConfigurationData,
} from "../../web/src/settings-changes.js";

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
  assert.match(
    notConfigured?.message ?? "",
    /If it is off, turn it on in Settings → Runtime; if that is refused, install `claude` on the service PATH first\. If it is already on, install `claude` on the service PATH, then turn it off and on/,
  );
  // The stored reason is the current text or the legacy one persisted before the off/on recovery.
  for (const reason of [
    "Claude runtime unavailable; turn it off and on in Settings → Runtime, or restart the service",
    "Claude runtime unavailable; restart the service",
  ]) {
    const unavailable = waitRoute(assignment({ waitReason: reason }));
    assert.match(
      unavailable?.message ?? "",
      /Turn it off and on in Settings → Runtime.*restart the service.*see Recovery/,
    );
    assert.deepEqual(routes(reason), [
      "/app/settings/runtime",
      "/app/assignments/a1/recovery",
    ]);
  }
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

const base = (harness: "codex" | "claude") => ({
  harness,
  policy: null,
  settings: null,
  enabled: true,
});

test("the profile runtime note names the recovery for each cause", () => {
  assert.equal(harnessNote({ ...base("codex"), state: "available" }), null);
  const disabled = harnessNote({
    ...base("claude"),
    state: "not-configured",
    reason: "disabled",
  });
  assert.match(disabled ?? "", /Turn it on in Settings → Runtime\./);
  // The switch is already on when the executable is missing: installing it is the fix.
  const missing = harnessNote({
    ...base("claude"),
    state: "not-configured",
    reason: "executable-missing",
  });
  assert.match(
    missing ?? "",
    /Install `claude` on the service PATH, then turn it off and on in Settings → Runtime\./,
  );
  assert.doesNotMatch(missing ?? "", /Turn it on/);
  assert.match(
    harnessNote({ ...base("codex"), state: "unavailable", since: 1 }) ?? "",
    /turn it off and on in Settings → Runtime, or restart the service/,
  );
});

test("only Claude failures render a failure notice", () => {
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
    failureNotice(assignment({ executionGeneration: generation("claude") })),
    null,
  );
});

test("Claude policy disclosure names roots by category and keeps the runtime's limits", () => {
  const base = {
    writableRoots: ["/w", "/tmp/ens-0123"],
    sharedWriteRoots: [] as string[],
    network: "denied",
    fileToolConfinement: "hook",
    limits: ["Hook confinement is not OS confinement."],
  };
  const redirected = claudePolicyDisclosure(base, "/w");
  assert.match(
    redirected.lines[0] ?? "",
    /write only the task workspace and a per-task temporary directory/,
  );
  assert.ok(
    redirected.lines.some((l) =>
      /Ensemble's hook, not by the operating system/.test(l),
    ),
  );
  assert.deepEqual(redirected.limits, base.limits);
  assert.equal(JSON.stringify(redirected).includes("/tmp/ens-"), false);
  const shared = claudePolicyDisclosure(
    { ...base, writableRoots: ["/w"], sharedWriteRoots: ["/tmp/claude-501"] },
    "/w",
  );
  assert.match(shared.lines[0] ?? "", /write only the task workspace,/);
  assert.ok(
    shared.lines.some((l) => /shared across tasks, not isolated/.test(l)),
  );
  assert.equal(JSON.stringify(shared).includes("claude-501"), false);
  for (const malformed of [
    { ...base, network: "allowed" },
    { ...base, fileToolConfinement: "os" },
    { ...base, limits: ["x".repeat(301)] },
    { ...base, extra: true },
  ])
    assert.throws(() => claudePolicyDisclosure(malformed, "/w"));
});

test("supported settings narrow runtime errors to listed values", () => {
  const supported = {
    models: [
      { model: "default", efforts: ["low", "high"] },
      { model: "sonnet", efforts: ["high"] },
    ],
  };
  assert.deepEqual(runtimeErrors(claude("opus", ""), supported), {
    "runtime.model": "Model must be one of: sonnet.",
  });
  assert.deepEqual(runtimeErrors(claude("sonnet", "low"), supported), {
    "runtime.reasoningEffort": "Reasoning effort must be one of: high.",
  });
  assert.deepEqual(runtimeErrors(claude("", "low"), supported), {});
  assert.deepEqual(runtimeErrors(claude("sonnet", ""), supported), {});
});

test("an unauthorized Claude failure names the token and Settings", () => {
  const notice = failureNotice(
    assignment({
      state: "held",
      executionGeneration: generation("claude", {
        classification: "permanent",
        reasonCode: "unauthorized",
      }),
    }),
  );
  assert.match(notice?.message ?? "", /Claude rejected the configured token/);
  assert.deepEqual(
    notice?.routes.map((r) => r.href),
    ["/app/settings#runtime", "/app/assignments/a1/recovery"],
  );
  assert.deepEqual(
    waitRoute(
      assignment({
        waitReason:
          "Claude runtime unavailable: subscription token is unavailable",
      }),
    )?.routes.map((r) => r.href),
    ["/app/settings/runtime", "/app/settings#runtime"],
  );
});

test("no runtime wait or failure route opens bare Settings", () => {
  const hrefs: string[] = [];
  for (const harness of ["Codex", "Claude"])
    for (const reason of [
      `${harness} runtime is not configured`,
      `${harness} runtime unavailable; restart the service`,
      `${harness} runtime unavailable: subscription token is unavailable`,
      `${harness} runtime unavailable: the runtime failed`,
    ])
      hrefs.push(
        ...(waitRoute(assignment({ waitReason: reason }))?.routes ?? []).map(
          (r) => r.href,
        ),
      );
  hrefs.push(
    ...(
      failureNotice(
        assignment({
          state: "held",
          executionGeneration: generation("claude", {
            classification: "permanent",
            reasonCode: "unauthorized",
          }),
        }),
      )?.routes ?? []
    ).map((r) => r.href),
  );
  assert.ok(hrefs.length >= 6);
  assert.deepEqual(
    hrefs.filter((h) => h === "/app/settings"),
    [],
  );
});
