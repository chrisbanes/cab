import assert from "node:assert/strict";
import { test } from "node:test";
import { taskStatusLines, waitLines } from "../src/cli/task-write.js";
import {
  cliFix,
  deriveWaits,
  orderWaits,
  runtimeWaitCodes,
  waitCodes,
  waitSchema,
} from "../src/operator/wait-reasons.js";

const projectId = "00000000-0000-4000-8000-000000000001",
  profileId = "00000000-0000-4000-8000-000000000002",
  blockerId = "00000000-0000-4000-8000-000000000003";
const lead = {
  profileId,
  runtimeUnavailable: false,
  claudeTokenUnavailable: false,
  runtimeNotConfigured: false,
};
const powerReason = "Power-event history is incomplete or ambiguous";
const one = (facts: Partial<Parameters<typeof deriveWaits>[0]>) =>
  deriveWaits({ projectId, admissionReasons: [], ...facts });

test("each wait code has one input producing exactly that wait, its Fix or its links", () => {
  const cases: [Partial<Parameters<typeof deriveWaits>[0]>, unknown][] = [
    [
      { admissionReasons: ["project-paused"] },
      {
        code: "project-paused",
        fix: { kind: "resume-project", projectId },
        links: [],
      },
    ],
    [
      { admissionReasons: ["project-lead-unconfigured"] },
      {
        code: "project-lead-unconfigured",
        fix: { kind: "choose-lead", projectId },
        links: [],
      },
    ],
    [
      { admissionReasons: ["project-lead-revoked"] },
      {
        code: "project-lead-revoked",
        fix: { kind: "choose-lead", projectId },
        links: [],
      },
    ],
    [
      { lead: { ...lead, runtimeUnavailable: true } },
      { code: "runtime-unavailable", fix: { kind: "readiness" }, links: [] },
    ],
    [
      { lead: { ...lead, claudeTokenUnavailable: true } },
      {
        code: "claude-token-unavailable",
        fix: { kind: "add-claude" },
        links: [],
      },
    ],
    [
      { lead: { ...lead, runtimeNotConfigured: true } },
      {
        code: "profile-runtime-not-configured",
        fix: { kind: "open-profile", profileId },
        links: [],
      },
    ],
    [
      { powerHold: { reason: powerReason } },
      { code: "power-held", fix: null, links: [], detail: powerReason },
    ],
    [
      {
        admissionReasons: ["local-dependency"],
        dependencies: [{ id: blockerId, label: "Set up CI" }],
      },
      {
        code: "local-dependency",
        fix: null,
        links: [{ kind: "task", id: blockerId, label: "Set up CI" }],
      },
    ],
    [
      {
        admissionReasons: ["imported-blockers-blocked"],
        nativeBlockers: [
          { url: "https://github.com/o/r/issues/2", label: "o/r#2" },
        ],
      },
      {
        code: "imported-blockers-blocked",
        fix: null,
        links: [
          {
            kind: "source",
            url: "https://github.com/o/r/issues/2",
            label: "o/r#2",
          },
        ],
      },
    ],
    [
      {
        admissionReasons: ["imported-blockers-unknown"],
        sourceUrl: "https://github.com/o/r/issues/1",
      },
      {
        code: "imported-blockers-unknown",
        fix: null,
        links: [
          {
            kind: "source",
            url: "https://github.com/o/r/issues/1",
            label: "Open source issue",
          },
        ],
      },
    ],
    [
      { admissionReasons: ["source-held"] },
      { code: "source-held", fix: null, links: [] },
    ],
    [
      { approvals: [{ id: "request-1", label: "Review the request" }] },
      {
        code: "approval",
        fix: null,
        links: [
          { kind: "request", id: "request-1", label: "Review the request" },
        ],
      },
    ],
    [
      { admissionReasons: ["task-not-open"] },
      { code: "admission-blocked", fix: null, links: [] },
    ],
    [
      { capacity: "2 of 2 project turns running" },
      {
        code: "capacity",
        fix: null,
        links: [
          { kind: "tasks-running", label: "2 of 2 project turns running" },
        ],
      },
    ],
  ];
  assert.equal(cases.length, waitCodes.length);
  for (const [facts, expected] of cases) {
    const waits = one(facts);
    assert.deepEqual(waits, [expected]);
    assert.ok(waitSchema.safeParse(waits[0]).success);
  }
});

test("every reason present returns the flow's fixed order, and holds never carry a Fix", () => {
  const waits = one({
    admissionReasons: [
      "admission-blocked",
      "source-held",
      "imported-blockers-unknown",
      "imported-blockers-blocked",
      "local-dependency",
      "project-lead-revoked",
      "project-lead-unconfigured",
      "project-paused",
      "task-unready",
    ],
    lead: {
      profileId,
      runtimeUnavailable: true,
      claudeTokenUnavailable: true,
      runtimeNotConfigured: false,
    },
    approvals: [{ id: "r", label: "Review the request" }],
    capacity: "1 of 1 turns running",
    powerHold: { reason: powerReason },
  });
  const withProfile = one({ lead: { ...lead, runtimeNotConfigured: true } });
  assert.deepEqual(
    orderWaits([...waits, ...withProfile]).map((w) => w.code),
    waitCodes,
  );
  for (const w of waits)
    if (
      [
        "power-held",
        "local-dependency",
        "imported-blockers-blocked",
        "imported-blockers-unknown",
        "source-held",
        "approval",
        "admission-blocked",
        "capacity",
      ].includes(w.code)
    )
      assert.equal(w.fix, null, w.code);
});

test("a Draft alone has no wait, and an unmapped admission reason is never dropped", () => {
  assert.deepEqual(one({ admissionReasons: ["task-unready"] }), []);
  assert.deepEqual(
    one({ admissionReasons: ["external-action-uncertain"] }).map((w) => w.code),
    ["admission-blocked"],
  );
  assert.deepEqual(
    one({ admissionReasons: ["source-review-required"] }).map((w) => w.code),
    ["source-held"],
  );
  assert.deepEqual(
    one({
      admissionReasons: ["admission-blocked", "task-not-open"],
    }).map((w) => w.code),
    ["admission-blocked"],
  );
});

test("a power hold is installation-wide, sits after the runtime waits and carries its reason only when known", () => {
  assert.deepEqual(
    one({
      admissionReasons: ["local-dependency"],
      lead: { ...lead, runtimeUnavailable: true },
      powerHold: { reason: powerReason },
    }).map((w) => w.code),
    ["runtime-unavailable", "power-held", "local-dependency"],
  );
  const unknown = one({ powerHold: { reason: null } });
  assert.deepEqual(unknown, [{ code: "power-held", fix: null, links: [] }]);
  assert.ok(!("detail" in (unknown[0] ?? {})));
  assert.deepEqual(one({ powerHold: null }), []);
  assert.deepEqual(one({}), []);
  // Not a runtime wait, so an explicit composer assignee never replaces it.
  assert.ok(!runtimeWaitCodes.includes("power-held"));
});

test("a wait detail is bounded like a label", () => {
  const wait = { code: "power-held", fix: null, links: [] };
  assert.ok(
    waitSchema.safeParse({ ...wait, detail: "x".repeat(16000) }).success,
  );
  assert.ok(
    !waitSchema.safeParse({ ...wait, detail: "x".repeat(16001) }).success,
  );
  assert.ok(!waitSchema.safeParse({ ...wait, detail: "" }).success);
  assert.ok(!waitSchema.safeParse({ ...wait, detail: null }).success);
});

test("the CLI Fix is the command or Settings path", () => {
  assert.deepEqual(cliFix({ kind: "resume-project", projectId }), [
    `ensemble project prepare ${projectId} --out project.json --paused false`,
    "ensemble project apply --file project.json",
  ]);
  assert.match(
    cliFix({ kind: "choose-lead", projectId })[0] ?? "",
    /--lead-profile PROFILE_ID$/,
  );
  assert.deepEqual(cliFix({ kind: "readiness" }), ["ensemble doctor"]);
  assert.deepEqual(cliFix({ kind: "add-claude" }), ["Settings → Add Claude"]);
  assert.deepEqual(cliFix({ kind: "open-profile", profileId }), [
    `Settings → Profiles → ${profileId}`,
  ]);
});

test("the CLI names the approval command for an approval wait", () => {
  assert.deepEqual(
    waitLines(
      one({
        approvals: [{ id: "request-1", label: "Review material & decide" }],
      }),
      projectId,
    ),
    [
      "Waiting: Approval needs a decision",
      `  Review: ensemble approval get ${projectId} request-1`,
    ],
  );
});

test("the CLI prints a power hold's reason under its label, with no Fix", () => {
  assert.deepEqual(
    waitLines(one({ powerHold: { reason: powerReason } }), projectId),
    ["Waiting: Held by power supervision", `  ${powerReason}`],
  );
  assert.deepEqual(waitLines(one({ powerHold: { reason: null } }), projectId), [
    "Waiting: Held by power supervision",
  ]);
});

test("a write command's status row carries the power hold's reason", () => {
  const status = (waits: ReturnType<typeof one>) =>
    taskStatusLines({
      task: { id: projectId, state: "open", ready: true, version: 3 },
      waits,
      execution: { state: "queued", holds: {} },
    } as never).find(([name]) => name === "Waiting")?.[1];
  assert.equal(
    status(
      one({
        powerHold: { reason: powerReason },
        capacity: "1 of 1 turns running",
      }),
    ),
    `Held by power supervision (${powerReason}), Capacity full`,
  );
  assert.equal(
    status(one({ powerHold: { reason: null } })),
    "Held by power supervision",
  );
  assert.equal(status([]), "none");
});
