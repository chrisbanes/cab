import assert from "node:assert/strict";
import { test } from "node:test";
import { holdPills } from "../../web/src/settings-view.js";
import { taskStatusLines, waitLines } from "../../src/cli/task-write.js";
import {
  cliFix,
  deriveWaits,
  holdLines,
  orderWaits,
  runtimeWaitCodes,
  waitCodes,
  waitSchema,
} from "../../src/operator/wait-reasons.js";

const projectId = "00000000-0000-4000-8000-000000000001",
  profileId = "00000000-0000-4000-8000-000000000002",
  blockerId = "00000000-0000-4000-8000-000000000003",
  assignmentId = "00000000-0000-4000-8000-000000000005";
const lead = {
  profileId,
  runtimeUnavailable: false,
  claudeTokenUnavailable: false,
  runtimeNotConfigured: false,
};
const powerReason = "Power-event history is incomplete or ambiguous";
const assignmentReasons = [
  ["profile-revoked", "assignment-profile-revoked", true],
  ["assignment-profile-revision-stale", "assignment-profile-stale", true],
  [
    "assignment-instructions-revision-stale",
    "assignment-instructions-stale",
    false,
  ],
  ["profile-not-permitted", "assignment-profile-not-permitted", false],
  ["assignment-held", "assignment-held", false],
  ["recovery-continuation-unresolved", "assignment-recovery-unresolved", false],
] as const;
const recoveryLink = {
  kind: "recovery",
  assignmentId,
  label: "Open recovery",
} as const;
const assignment = (reasons: readonly string[], profileName = "Worker") => ({
  assignmentId,
  profileId,
  profileName,
  reasons,
});
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
      { repositoryAccessRevoked: true },
      {
        code: "repository-access-revoked",
        fix: { kind: "open-repositories", projectId },
        links: [],
      },
    ],
    ...assignmentReasons.map(
      ([reason, code, openProfile]): [
        Partial<Parameters<typeof deriveWaits>[0]>,
        unknown,
      ] => [
        { assignments: [assignment([reason])] },
        {
          code,
          fix: openProfile ? { kind: "open-profile", profileId } : null,
          links:
            code === "assignment-recovery-unresolved" ? [recoveryLink] : [],
          detail: "Worker",
        },
      ],
    ),
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
    repositoryAccessRevoked: true,
    assignments: [assignment(assignmentReasons.map(([reason]) => reason))],
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
        "assignment-instructions-stale",
        "assignment-profile-not-permitted",
        "assignment-held",
        "assignment-recovery-unresolved",
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

test("an assignment's admission reasons sit after the power hold and revoked repository access, name its profile and keep the first per code", () => {
  const all = assignmentReasons.map(([reason]) => reason);
  assert.deepEqual(
    one({
      admissionReasons: ["project-paused", "local-dependency"],
      lead: { ...lead, runtimeUnavailable: true },
      powerHold: { reason: null },
      repositoryAccessRevoked: true,
      assignments: [assignment(all)],
    }).map((w) => w.code),
    [
      "project-paused",
      "runtime-unavailable",
      "power-held",
      "repository-access-revoked",
      ...assignmentReasons.map(([, code]) => code),
      "local-dependency",
    ],
  );
  assert.deepEqual(
    waitCodes.slice(
      waitCodes.indexOf("repository-access-revoked") + 1,
      waitCodes.indexOf("local-dependency"),
    ),
    assignmentReasons.map(([, code]) => code),
  );
  // Only the first assignment's wait, with its Fix and profile name, is kept per code.
  const other = "00000000-0000-4000-8000-000000000004";
  assert.deepEqual(
    one({
      assignments: [
        assignment(["profile-revoked"]),
        {
          assignmentId: other,
          profileId: other,
          profileName: "Other",
          reasons: ["profile-revoked"],
        },
      ],
    }),
    [
      {
        code: "assignment-profile-revoked",
        fix: { kind: "open-profile", profileId },
        links: [],
        detail: "Worker",
      },
    ],
  );
  // A name that is not disclosable leaves the detail out rather than null.
  const unnamed = one({
    assignments: [{ ...assignment(["profile-revoked"]), profileName: null }],
  });
  assert.ok(!("detail" in (unnamed[0] ?? {})));
  assert.ok(waitSchema.safeParse(unnamed[0]).success);
  // Two unresolved recoveries keep the first assignment's link only.
  assert.deepEqual(
    one({
      assignments: [
        assignment(["recovery-continuation-unresolved"]),
        {
          assignmentId: other,
          profileId: other,
          profileName: "Other",
          reasons: ["recovery-continuation-unresolved"],
        },
      ],
    }),
    [
      {
        code: "assignment-recovery-unresolved",
        fix: null,
        links: [recoveryLink],
        detail: "Worker",
      },
    ],
  );
  assert.deepEqual(one({ assignments: [assignment([])] }), []);
  assert.deepEqual(one({ assignments: [] }), []);
});

test("an unmapped assignment reason is never dropped and shares the one admission-blocked wait", () => {
  assert.deepEqual(
    one({
      assignments: [assignment(["assignment-completed", "future-reason"])],
    }),
    [{ code: "admission-blocked", fix: null, links: [] }],
  );
  // Reasons are looked up by own key, never on the shared prototype.
  assert.deepEqual(
    one({ assignments: [assignment(["constructor", "__proto__"])] }).map(
      (w) => w.code,
    ),
    ["admission-blocked"],
  );
  assert.deepEqual(
    one({
      admissionReasons: ["task-not-open"],
      assignments: [assignment(["assignment-completed"])],
    }),
    [{ code: "admission-blocked", fix: null, links: [] }],
  );
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
  assert.deepEqual(cliFix({ kind: "open-repositories", projectId }), [
    `ensemble project sources ${projectId}`,
    `ensemble project prepare-source ${projectId} --out source.json --edit-file EDIT_FILE`,
    "ensemble project apply --file source.json",
  ]);
});

test("revoked repository access discloses no repository and a recovery link sends nothing", () => {
  const [repository] = one({ repositoryAccessRevoked: true });
  assert.ok(repository && !("detail" in repository));
  assert.deepEqual(one({ repositoryAccessRevoked: false }), []);
  assert.ok(
    !waitSchema.safeParse({
      code: "assignment-recovery-unresolved",
      fix: null,
      links: [{ ...recoveryLink, assignmentId: "not-a-uuid" }],
    }).success,
  );
  assert.deepEqual(
    waitLines(
      one({ assignments: [assignment(["recovery-continuation-unresolved"])] }),
      projectId,
    ),
    [
      "Waiting: Assignment recovery unresolved",
      "  Worker",
      `  Recovery: ensemble recovery get ${assignmentId}`,
    ],
  );
  assert.deepEqual(
    waitLines(one({ repositoryAccessRevoked: true }), projectId),
    [
      "Waiting: Repository access revoked",
      `  Fix: ensemble project sources ${projectId}`,
      `  Fix: ensemble project prepare-source ${projectId} --out source.json --edit-file EDIT_FILE`,
      "  Fix: ensemble project apply --file source.json",
    ],
  );
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

test("the CLI names the assignment's profile under its wait and the Settings path as its Fix", () => {
  assert.deepEqual(
    waitLines(
      one({ assignments: [assignment(["profile-revoked"])] }),
      projectId,
    ),
    [
      "Waiting: Assignment profile revoked",
      "  Worker",
      `  Fix: Settings → Profiles → ${profileId}`,
    ],
  );
  assert.deepEqual(
    waitLines(
      one({ assignments: [assignment(["assignment-held"])] }),
      projectId,
    ),
    ["Waiting: Assignment held", "  Worker"],
  );
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

test("hold lines state what clears each hold, list Stop once and follow the recovery labels", () => {
  const none = {
    stop: false,
    writer: false,
    capacity: false,
    uncertainty: false,
  };
  const all = { stop: true, writer: true, capacity: true, uncertainty: true };
  assert.deepEqual(holdLines(all, { reason: "Archival is awaiting review" }), [
    {
      kind: "stop",
      label: "Operator Stop",
      clears: "Clears when the task's Stop is resumed.",
      name: "Operator Stop",
    },
    {
      kind: "task",
      label: "Task hold",
      clears:
        "Archival is awaiting review. Recovery stays blocked while it remains.",
      name: "task hold",
    },
    {
      kind: "writer",
      label: "Writer ownership",
      clears: "Clears when we know the execution ended.",
      name: "writer ownership",
    },
    {
      kind: "capacity",
      label: "Capacity",
      clears: "Clears when we know the execution ended.",
      name: "capacity hold",
    },
    {
      kind: "uncertainty",
      label: "Uncertainty",
      clears: "Clears when we know the execution ended.",
      name: "uncertainty hold",
    },
  ]);
  assert.deepEqual(holdLines(none, null), []);
  // A withheld reason is not echoed as an empty string or null; a full stop is not doubled.
  assert.equal(
    holdLines(none, { reason: null })[0]?.clears,
    "No reason recorded. Recovery stays blocked while it remains.",
  );
  assert.equal(
    holdLines(none, { reason: "Held already." })[0]?.clears,
    "Held already. Recovery stays blocked while it remains.",
  );
  // A Stop-only task has no task hold and so exactly one line.
  assert.deepEqual(
    holdLines({ ...none, stop: true }, null).map((line) => line.kind),
    ["stop"],
  );
  // The labels are the recovery page's hold pills, in the same order.
  assert.deepEqual(
    holdLines(all, { reason: "x" }).map((line) => line.label),
    holdPills({ ...all, task: true }).map((pill) => pill.label),
  );
});
