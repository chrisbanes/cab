import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryPolicySchema, actionKinds } from "../../src/core/delivery.js";
import {
  deliveryActionKinds,
  deliveryPolicyChangeText,
  deliveryPolicyDraft,
  deliveryPolicySubmission,
  addGrantRow,
  removeGrantRow,
  validateDeliveryPolicyDraft,
  statusMappingCoverageLoss,
  deliveryMappingCoverageWarning,
  type DeliveryPolicySeed,
  type RepositoryDeliveryRead,
} from "../../web/src/delivery-policy-draft.js";

const seed = (
  overrides: Partial<DeliveryPolicySeed> = {},
): DeliveryPolicySeed => ({
  mode: "through-merge" as const,
  version: 7,
  credentialConfigured: true,
  branchPrefix: "",
  grants: [],
  requiredChecks: [],
  ...overrides,
});

test("all domain actions round-trip public fields exactly and remain domain-schema valid", () => {
  assert.deepEqual(deliveryActionKinds, actionKinds);
  for (const action of actionKinds) {
    const policy = deliveryPolicySchema.parse({
      mode: "through-merge",
      credentialRef: "env:FIXTURE",
      branchPrefix: "",
      grants: [
        {
          action,
          repositoryId: "tracker-container",
          mode: action === "branch.adopt" ? "approval" : "allow",
          ...(action.startsWith("project.") ? { projectNodeId: "P" } : {}),
          ...(action === "project.field"
            ? { fieldNodeId: "F", optionNodeIds: [] }
            : {}),
          ...(action === "issue.status" ? { statusIds: ["S", "S"] } : {}),
        },
        {
          action,
          repositoryId: "tracker-container",
          mode: action === "branch.adopt" ? "approval" : "allow",
          ...(action === "project.field"
            ? {
                projectNodeId: "P",
                fieldNodeId: "F",
                optionNodeIds: ["O", "O"],
              }
            : {}),
          ...(action === "project.item.add" ? { projectNodeId: "P" } : {}),
          ...(action === "issue.status" ? { statusIds: [] } : {}),
        },
      ],
      requiredChecks: [
        { name: "Build", appId: 42 },
        { name: "Test" },
        { name: "Build", appId: 42 },
      ],
    });
    const {
      credentialRef: _savedReference,
      repositories: _repositories,
      ...publicPolicy
    } = policy;
    const publicSeed = {
      ...publicPolicy,
      credentialConfigured: true,
      version: 7,
    };
    const draft = deliveryPolicyDraft(publicSeed);
    assert.equal("credentialRef" in draft, false);
    assert.equal(draft.credentialIntent, "preserve");
    const {
      credentialIntent: _intent,
      version: _version,
      grantKeys: _grantKeys,
      requiredCheckKeys: _checkKeys,
      ...roundTripped
    } = draft;
    deliveryPolicySchema.parse({
      ...roundTripped,
      credentialRef: "env:FIXTURE",
    });
    assert.deepEqual(roundTripped, {
      mode: policy.mode,
      branchPrefix: policy.branchPrefix,
      grants: policy.grants,
      requiredChecks: policy.requiredChecks,
    });
  }
  const missing = deliveryPolicyDraft({
    mode: "reviewable-pr",
    version: 1,
    credentialConfigured: false,
    grants: [],
    requiredChecks: [],
  });
  delete missing.branchPrefix;
  assert.equal("branchPrefix" in missing, false);
  assert.equal("credentialRef" in deliveryPolicySubmission(missing), false);
});

test("credential intent preserves, clears or submits only newly entered reference", () => {
  const base = deliveryPolicyDraft(seed({ credentialConfigured: true }));
  assert.equal("credentialRef" in base, false);
  assert.equal("credentialRef" in deliveryPolicySubmission(base), false);
  assert.deepEqual(
    deliveryPolicySubmission({ ...base, credentialIntent: "clear" }),
    {
      mode: "through-merge",
      branchPrefix: "",
      grants: [],
      requiredChecks: [],
      credentialRef: null,
    },
  );
  assert.throws(
    () => deliveryPolicySubmission({ ...base, credentialIntent: "set" }),
    /valid delivery credential/,
  );
  assert.deepEqual(
    deliveryPolicySubmission({
      ...base,
      credentialIntent: "set",
      credentialInput: "env:NEW",
    }),
    {
      mode: "through-merge",
      branchPrefix: "",
      grants: [],
      requiredChecks: [],
      credentialRef: "env:NEW",
    },
  );
});

test("the GitHub CLI login is a valid delivery credential and its status never reaches a submission", () => {
  const base = deliveryPolicyDraft(
    seed({
      credential: {
        configured: true,
        source: "gh",
        usable: true,
        reason: null,
        gh: { state: "signed-in", login: "octo" },
      },
    }),
  );
  assert.equal("credential" in base, false);
  assert.equal("credential" in deliveryPolicySubmission(base), false);
  const chosen = { ...base, credentialIntent: "set" as const };
  assert.deepEqual(
    deliveryPolicySubmission({ ...chosen, credentialInput: "gh:github.com" }),
    { ...deliveryPolicySubmission(base), credentialRef: "gh:github.com" },
  );
  assert.throws(
    () =>
      deliveryPolicySubmission({
        ...chosen,
        credentialInput: "gh:example.com",
      }),
    /valid delivery credential/,
  );
  assert.deepEqual(
    validateDeliveryPolicyDraft({
      ...chosen,
      credentialInput: "gh:github.com",
    }),
    [],
  );
});

test("stable row keys survive edits and removal while submission contains only policy fields", () => {
  const base = deliveryPolicyDraft(
    seed({
      grants: [
        { action: "issue.comment", repositoryId: "R", mode: "allow" },
        { action: "issue.labels", repositoryId: "R", mode: "allow" },
      ],
    }),
  );
  assert.deepEqual(base.grantKeys, ["grant-0", "grant-1"]);
  const added = addGrantRow(
    base,
    { action: "pr.merge", repositoryId: "R", mode: "allow" },
    "new-row",
  );
  assert.deepEqual(added.grantKeys, ["grant-0", "grant-1", "new-row"]);
  assert.deepEqual(removeGrantRow(added, "grant-0").grantKeys, [
    "grant-1",
    "new-row",
  ]);
  assert.throws(
    () => addGrantRow(added, added.grants[0]!, "grant-1"),
    /must be new/,
  );
  const submission = deliveryPolicySubmission(added);
  assert.equal("grantKeys" in submission, false);
  assert.deepEqual(submission.grants, added.grants);
});

test("indexed validation matches domain accepted policy requirements", () => {
  const invalid = deliveryPolicyDraft(
    seed({
      branchPrefix: "../bad",
      grants: [
        { action: "branch.adopt", repositoryId: "R", mode: "allow" },
        {
          action: "project.field",
          repositoryId: "R",
          mode: "allow",
          projectNodeId: "",
          fieldNodeId: "",
          optionNodeIds: [],
        },
        { action: "project.item.add", repositoryId: "R", mode: "allow" },
        {
          action: "issue.comment",
          repositoryId: "R",
          mode: "allow",
          statusIds: ["S"],
        },
        {
          action: "issue.status",
          repositoryId: "R",
          mode: "allow",
          statusIds: [],
        },
      ],
      requiredChecks: [{ name: "Build", appId: 0 }],
    }),
  );
  const paths = validateDeliveryPolicyDraft(invalid).map((error) => error.path);
  for (const expected of [
    "branchPrefix",
    "grants.grant-0.mode",
    "grants.grant-1.optionNodeIds",
    "grants.grant-2.projectNodeId",
    "grants.grant-3.statusIds",
    "grants.grant-4.statusIds",
    "requiredChecks.check-0.appId",
  ])
    assert.ok(paths.includes(expected), expected);
  const valid = deliveryPolicyDraft(
    seed({
      grants: deliveryActionKinds.map((action) => ({
        action,
        repositoryId: "R",
        mode: action === "branch.adopt" ? "approval" : "allow",
        ...(action === "project.field"
          ? { projectNodeId: "P", fieldNodeId: "F", optionNodeIds: ["O"] }
          : {}),
        ...(action === "project.item.add" ? { projectNodeId: "P" } : {}),
        ...(action === "issue.status" ? { statusIds: ["S"] } : {}),
      })),
    }),
  );
  assert.deepEqual(validateDeliveryPolicyDraft(valid), []);
});

test("Jira and GitHub mapping losses use their own action and exact scope", () => {
  const jira = {
    tracker: "jira" as const,
    repositoryId: "tracker",
    granted: ["S1", "S2"],
  };
  const gitHub = {
    tracker: "github" as const,
    repositoryId: "code",
    granted: [
      { projectNodeId: "P", fieldNodeId: "F", optionNodeIds: ["O1", "O2"] },
    ],
  };
  const saved = seed({
    grants: [
      {
        action: "issue.status",
        repositoryId: "tracker",
        mode: "allow",
        statusIds: ["S1"],
      },
      {
        action: "issue.status",
        repositoryId: "tracker",
        mode: "allow",
        statusIds: ["S2"],
      },
      {
        action: "project.field",
        repositoryId: "code",
        mode: "allow",
        projectNodeId: "P",
        fieldNodeId: "F",
        optionNodeIds: ["O1"],
      },
      {
        action: "project.field",
        repositoryId: "code",
        mode: "allow",
        projectNodeId: "P",
        fieldNodeId: "F",
        optionNodeIds: ["O2"],
      },
    ],
  });
  const proposed = seed({
    grants: [
      {
        action: "issue.status",
        repositoryId: "tracker",
        mode: "allow",
        statusIds: ["S1", "S2"],
      },
      {
        action: "project.field",
        repositoryId: "code",
        mode: "allow",
        projectNodeId: "P",
        fieldNodeId: "F",
        optionNodeIds: ["O1", "O2"],
      },
    ],
  });
  assert.deepEqual(statusMappingCoverageLoss(saved, proposed, jira), []);
  assert.deepEqual(statusMappingCoverageLoss(saved, proposed, gitHub), []);
  assert.deepEqual(
    statusMappingCoverageLoss(
      saved,
      seed({
        grants: [
          {
            action: "issue.status",
            repositoryId: "tracker",
            mode: "allow",
            statusIds: ["S1"],
          },
        ],
      }),
      jira,
    ),
    ["S2"],
  );
  assert.deepEqual(
    statusMappingCoverageLoss(
      saved,
      seed({
        grants: [
          {
            action: "project.field",
            repositoryId: "code",
            mode: "allow",
            projectNodeId: "P",
            fieldNodeId: "F",
            optionNodeIds: ["O1"],
          },
        ],
      }),
      gitHub,
    ),
    ["P\0F\0O2"],
  );
  assert.deepEqual(
    statusMappingCoverageLoss(
      saved,
      seed({
        grants: [
          {
            action: "issue.status",
            repositoryId: "tracker",
            mode: "approval",
            statusIds: ["S1", "S2"],
          },
        ],
      }),
      jira,
    ),
    ["S1", "S2"],
  );
  assert.deepEqual(
    statusMappingCoverageLoss(
      saved,
      seed({
        grants: [
          {
            action: "project.field",
            repositoryId: "code",
            mode: "approval",
            projectNodeId: "P",
            fieldNodeId: "F",
            optionNodeIds: ["O1", "O2"],
          },
        ],
      }),
      gitHub,
    ),
    ["P\0F\0O1", "P\0F\0O2"],
  );
  assert.deepEqual(
    statusMappingCoverageLoss(
      saved,
      seed({
        grants: [
          {
            action: "project.field",
            repositoryId: "other",
            mode: "allow",
            projectNodeId: "P",
            fieldNodeId: "F",
            optionNodeIds: ["O1", "O2"],
          },
        ],
      }),
      gitHub,
    ),
    ["P\0F\0O1", "P\0F\0O2"],
  );
  assert.deepEqual(statusMappingCoverageLoss(seed(), proposed, jira), []);
});

test("change text excludes credential input and reports policy changes only", () => {
  const before = deliveryPolicyDraft(seed());
  const after = {
    ...before,
    version: 8,
    credentialIntent: "set" as const,
    credentialInput: "env:SECRET",
  };
  assert.deepEqual(deliveryPolicyChangeText(before, after), []);
  assert.doesNotMatch(
    JSON.stringify(deliveryPolicyChangeText(before, after)),
    /SECRET/,
  );
});

test("opaque rows and prefix round-trip through editor values without synthetic identity or UI keys", async () => {
  const { deliveryEditorValues, deliveryEditorDraft, deliveryFieldErrors } =
    await import("../../web/src/delivery-policy-draft.js");
  const savedRow = {
    projectId: "p",
    section: "delivery-grants" as const,
    version: 7,
    index: 0,
  };
  const unavailable = {
    kind: "unavailable" as const,
    label: "Unavailable saved row" as const,
    savedRow,
  };
  const saved = seed({
    branchPrefix: null,
    branchPrefixUnavailable: true,
    grants: [
      unavailable,
      {
        action: "issue.comment",
        repositoryId: "r",
        mode: "allow",
        optionNodeIds: [],
      },
    ],
    requiredChecks: [
      {
        kind: "unavailable",
        label: "Unavailable saved row",
        savedRow: { ...savedRow, section: "delivery-checks" },
      },
      { name: "Build", appId: 42 },
    ],
  });
  const values = deliveryEditorValues(saved);
  const draft = deliveryEditorDraft(values);
  assert.deepEqual(deliveryFieldErrors(draft), {});
  const submitted = deliveryPolicySubmission(draft);
  assert.deepEqual(submitted, {
    mode: "through-merge",
    preserveBranchPrefix: true,
    grants: [{ savedRow, keep: true }, saved.grants[1]],
    requiredChecks: [
      { savedRow: { ...savedRow, section: "delivery-checks" }, keep: true },
      { name: "Build", appId: 42 },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(submitted),
    /rowKey|credential|unavailable/,
  );
  assert.deepEqual(deliveryPolicyChangeText(saved, draft), []);
  values.grants = JSON.stringify(JSON.parse(String(values.grants)).slice(1));
  assert.deepEqual(
    deliveryPolicySubmission(deliveryEditorDraft(values)).grants,
    [saved.grants[1]],
  );
  assert.deepEqual(
    deliveryPolicySubmission(deliveryEditorDraft(deliveryEditorValues(saved))),
    submitted,
  );
});

test("editor preserves missing versus empty prefix and optional lists, and maps keyed errors to numeric fields", async () => {
  const { deliveryEditorValues, deliveryEditorDraft, deliveryFieldErrors } =
    await import("../../web/src/delivery-policy-draft.js");
  for (const prefix of [undefined, ""]) {
    const saved = seed({
      grants: [
        {
          action: "issue.comment",
          repositoryId: "r",
          mode: "allow",
          optionNodeIds: [],
          projectNodeId: "P",
          fieldNodeId: "F",
        },
      ],
    });
    if (prefix === undefined) delete saved.branchPrefix;
    else saved.branchPrefix = prefix;
    const result = deliveryPolicySubmission(
      deliveryEditorDraft(deliveryEditorValues(saved)),
    );
    assert.equal(Object.hasOwn(result, "branchPrefix"), prefix !== undefined);
    assert.deepEqual(result.grants, saved.grants);
  }
  const draft = deliveryPolicyDraft(
    seed({
      grants: [{ action: "project.field", repositoryId: "", mode: "allow" }],
      requiredChecks: [{ name: "", appId: 0 }],
    }),
  );
  draft.credentialIntent = "set";
  assert.deepEqual(Object.keys(deliveryFieldErrors(draft)), [
    "grants.0.repositoryId",
    "grants.0.projectNodeId",
    "grants.0.fieldNodeId",
    "grants.0.optionNodeIds",
    "requiredChecks.0.name",
    "requiredChecks.0.appId",
    "credentialRef",
  ]);
});

test("configured mapping warning compares exact scopes and target options, not unrelated grants", async () => {
  const { deliveryMappingCoverageLoss } = await import(
    "../../web/src/delivery-policy-draft.js"
  );
  const saved = seed({
    grants: [
      {
        action: "project.field",
        mode: "allow",
        repositoryId: "r",
        projectNodeId: "P",
        fieldNodeId: "F",
        optionNodeIds: ["O", "other"],
      },
    ],
  });
  const view = {
    version: 1,
    availability: "available" as const,
    mapping: {
      selectionId: "s",
      projectNodeId: "P",
      fieldNodeId: "F",
      events: { turnStarted: "O", handedBack: null, held: null, done: null },
    },
    selections: [],
    granted: [
      { projectNodeId: "P", fieldNodeId: "F", optionNodeIds: ["O", "other"] },
    ],
  };
  assert.equal(deliveryMappingCoverageLoss(saved, seed(), view), true);
  assert.equal(
    deliveryMappingCoverageLoss(
      saved,
      {
        ...saved,
        grants: [
          {
            action: "project.field",
            mode: "allow",
            repositoryId: "r",
            projectNodeId: "P",
            fieldNodeId: "F",
            optionNodeIds: ["O"],
          },
        ],
      },
      view,
    ),
    false,
  );
  assert.equal(
    deliveryMappingCoverageLoss(saved, seed(), { ...view, mapping: null }),
    false,
  );
  assert.equal(
    deliveryMappingCoverageLoss(saved, seed(), {
      ...view,
      mapping: { ...view.mapping, fieldNodeId: "different" },
    }),
    false,
  );
  const jiraSaved = seed({
    grants: [
      {
        action: "issue.status",
        mode: "allow",
        repositoryId: "jira-container",
        statusIds: ["O"],
      },
    ],
  });
  const jiraView = {
    tracker: "jira" as const,
    version: 1,
    availability: "available" as const,
    mapping: { tracker: "jira" as const, events: view.mapping.events },
    granted: ["O"],
  };
  assert.equal(
    deliveryMappingCoverageLoss(
      jiraSaved,
      {
        ...jiraSaved,
        grants: [
          {
            action: "issue.status",
            mode: "allow",
            repositoryId: "other-container",
            statusIds: ["O"],
          },
        ],
      },
      jiraView,
    ),
    true,
  );
  assert.equal(
    deliveryMappingCoverageLoss(
      jiraSaved,
      { ...jiraSaved, grants: [...jiraSaved.grants, ...jiraSaved.grants] },
      jiraView,
    ),
    false,
  );
});

test("all actions keep every accepted supplemental scope and duplicate check through the editor adapter", async () => {
  const { deliveryEditorValues, deliveryEditorDraft, deliveryFieldErrors } =
    await import("../../web/src/delivery-policy-draft.js");
  for (const action of actionKinds) {
    const saved = seed({
      grants: [
        {
          action,
          repositoryId: "tracker",
          mode: action === "branch.adopt" ? "approval" : "allow",
          projectNodeId: "P",
          fieldNodeId: "F",
          optionNodeIds: action === "project.field" ? ["O", "O"] : [],
          ...(action === "issue.status" ? { statusIds: ["S", "S"] } : {}),
        },
      ],
      requiredChecks: [
        { name: "Build" },
        { name: "Build", appId: 42 },
        { name: "Build", appId: 42 },
      ],
    });
    const draft = deliveryEditorDraft(deliveryEditorValues(saved));
    assert.deepEqual(deliveryFieldErrors(draft), {}, action);
    const result = deliveryPolicySubmission(draft);
    assert.deepEqual(
      result,
      {
        mode: saved.mode,
        branchPrefix: "",
        grants: saved.grants,
        requiredChecks: saved.requiredChecks,
      },
      action,
    );
    deliveryPolicySchema.parse({ ...result, credentialRef: null });
  }
});

test("reviewing a newer policy cannot rebind an old unavailable ordinal", async () => {
  const { deliveryEditorValues, deliveryEditorDraft, deliveryFieldErrors } =
    await import("../../web/src/delivery-policy-draft.js");
  const saved = seed({
    grants: [
      {
        kind: "unavailable",
        label: "Unavailable saved row",
        savedRow: {
          projectId: "p",
          section: "delivery-grants",
          version: 7,
          index: 0,
        },
      },
    ],
  });
  const values = deliveryEditorValues(saved);
  values.expectedVersion = "8";
  assert.match(
    deliveryFieldErrors(deliveryEditorDraft(values))["grants.0.savedRow"]!,
    /older version/,
  );
  const row = deliveryPolicySubmission(deliveryEditorDraft(values)).grants[0];
  assert.ok(row && "savedRow" in row);
  assert.equal(row.savedRow.version, 7);
});

test("withheld mapping warns conservatively when public status authority is reduced", () => {
  const grant = {
    action: "project.field" as const,
    repositoryId: "r",
    mode: "allow" as const,
    projectNodeId: "P",
    fieldNodeId: "F",
    optionNodeIds: ["O", "other"],
  };
  const saved = seed({ grants: [grant] });
  const warning = (next: DeliveryPolicySeed) =>
    deliveryMappingCoverageWarning(saved, next, undefined);
  for (const next of [
    seed(),
    seed({ grants: [{ ...grant, mode: "approval" }] }),
    seed({ grants: [{ ...grant, optionNodeIds: ["O"] }] }),
    seed({ grants: [{ ...grant, repositoryId: "other" }] }),
    seed({ grants: [{ ...grant, fieldNodeId: "other" }] }),
  ])
    assert.match(warning(next) ?? "", /may remove status-mapping authority/);
  assert.equal(warning(saved), null);
  assert.equal(warning(seed({ grants: [grant, grant] })), null);
  assert.equal(
    deliveryMappingCoverageWarning(
      seed({ grants: [grant, grant] }),
      saved,
      undefined,
    ),
    null,
  );
  const jira = {
    action: "issue.status" as const,
    repositoryId: "jira-container",
    mode: "allow" as const,
    statusIds: ["open", "done"],
  };
  assert.match(
    deliveryMappingCoverageWarning(
      seed({ grants: [jira] }),
      seed({ grants: [{ ...jira, statusIds: ["open"] }] }),
      undefined,
    ) ?? "",
    /may remove status-mapping authority/,
  );
  assert.equal(
    deliveryMappingCoverageWarning(
      seed({
        grants: [{ action: "branch.push", repositoryId: "r", mode: "allow" }],
      }),
      seed(),
      undefined,
    ),
    null,
  );
  assert.equal(
    deliveryMappingCoverageWarning(saved, seed(), {
      version: 1,
      availability: "available",
      mapping: null,
      selections: [],
      granted: [],
    }),
    null,
  );
});

import {
  applyRepositoryDeliveryLevel,
  deliveryLevelView,
} from "../../web/src/delivery-policy-draft.js";
import { repositoryLevelGrants } from "../../src/core/delivery-levels.js";

test("bulk presets preserve unrelated rows and keys, derive mode over unlinked IDs and are idempotent", () => {
  const retained = [
    {
      action: "issue.comment" as const,
      repositoryId: "R",
      mode: "allow" as const,
      optionNodeIds: ["O", "O"],
    },
    {
      action: "branch.adopt" as const,
      repositoryId: "R",
      mode: "approval" as const,
    },
  ];
  const draft = deliveryPolicyDraft(
    seed({
      grants: [
        ...retained,
        ...retained,
        ...repositoryLevelGrants("unlinked", "merge-with-approval"),
        {
          action: "pr.merge",
          repositoryId: "R",
          mode: "allow",
          fieldNodeId: "F",
        },
      ],
    }),
  );
  const before = structuredClone(draft);
  const result = applyRepositoryDeliveryLevel(
    draft,
    ["R", "42", "R"],
    "open-prs",
  );
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.equal(result.draft.mode, "through-merge");
  assert.deepEqual(result.draft.grants.slice(0, 12), draft.grants.slice(0, 12));
  assert.deepEqual(
    result.draft.grantKeys.slice(0, 12),
    draft.grantKeys.slice(0, 12),
  );
  assert.deepEqual(result.draft.grants.slice(12), [
    ...repositoryLevelGrants("R", "open-prs"),
    ...repositoryLevelGrants("42", "open-prs"),
  ]);
  assert.equal(
    new Set(result.draft.grantKeys).size,
    result.draft.grants.length,
  );
  assert.deepEqual(draft, before);
  assert.deepEqual(
    applyRepositoryDeliveryLevel(result.draft, ["R", "42"], "open-prs"),
    result,
  );
  assert.equal(deliveryLevelView(result.draft.grants, "R"), "open-prs");
  const down = applyRepositoryDeliveryLevel(
    result.draft,
    ["unlinked"],
    "open-prs",
  );
  assert.equal(down.kind === "applied" && down.draft.mode, "reviewable-pr");
  const custom = applyRepositoryDeliveryLevel(
    deliveryPolicyDraft(
      seed({
        grants: [{ action: "pr.merge", repositoryId: "custom", mode: "allow" }],
      }),
    ),
    ["R"],
    "open-prs",
  );
  assert.equal(custom.kind === "applied" && custom.draft.mode, "reviewable-pr");
});

test("unavailable facts and oversized bulk proposals refuse without mutating the draft", () => {
  const opaque = {
    kind: "unavailable" as const,
    label: "Unavailable saved row" as const,
    savedRow: {
      projectId: "P",
      section: "delivery-grants" as const,
      version: 7,
      index: 0,
    },
  };
  const draft = deliveryPolicyDraft(seed({ grants: [opaque] }));
  const before = structuredClone(draft);
  assert.equal(deliveryLevelView(draft.grants, "R"), "unavailable");
  assert.equal(
    applyRepositoryDeliveryLevel(draft, ["R"], "open-prs").kind,
    "unavailable",
  );
  assert.deepEqual(draft, before);
  const publicDraft = deliveryPolicyDraft(
    seed({
      branchPrefix: null,
      branchPrefixUnavailable: true,
      requiredChecks: [
        {
          ...opaque,
          savedRow: { ...opaque.savedRow, section: "delivery-checks" },
        },
      ],
    }),
  );
  assert.equal(
    applyRepositoryDeliveryLevel(publicDraft, [null], "open-prs").kind,
    "unavailable",
  );
  const valid = applyRepositoryDeliveryLevel(
    publicDraft,
    ["R"],
    "merge-when-ready",
  );
  assert.equal(valid.kind, "applied");
  if (valid.kind === "applied") {
    assert.deepEqual(valid.draft.requiredChecks, publicDraft.requiredChecks);
    assert.equal(valid.draft.branchPrefix, null);
    assert.equal(valid.draft.credentialIntent, "preserve");
  }
  const full = deliveryPolicyDraft(
    seed({
      grants: Array.from({ length: 250 }, () => ({
        action: "issue.comment",
        repositoryId: "T",
        mode: "allow",
      })),
    }),
  );
  const snapshot = structuredClone(full);
  const rejected = applyRepositoryDeliveryLevel(
    full,
    ["R", "42"],
    "merge-when-ready",
  );
  assert.equal(rejected.kind, "invalid");
  assert.deepEqual(full, snapshot);
});

test("a legacy read becomes per-repository rows, and every save sends the repositories with an empty project-wide list", async () => {
  const { deliveryEditorValues, deliveryEditorDraft, deliveryFieldErrors } =
    await import("../../web/src/delivery-policy-draft.js");
  const read = (
    mergeMethod: "merge" | "squash" | "rebase" | null,
  ): RepositoryDeliveryRead => ({
    repositoryId: "R1",
    mergeMethod,
    additionalChecks: [
      { name: "build", appId: 7 },
      {
        kind: "unavailable",
        label: "Unavailable saved row",
        savedRow: {
          projectId: "00000000-0000-4000-8000-000000000001",
          section: "delivery-checks",
          version: 7,
          index: 1,
          repositoryId: "R1",
        },
      },
    ],
    codeHost: { status: "live", checks: [], allowedMethods: ["squash"] },
    suggestions: ["lint"],
    noRequiredChecks: false,
  });
  const saved = seed({
    requiredChecks: [{ name: "build", appId: 7 }],
    repositories: [read(null)],
  });
  const draft = deliveryEditorDraft(deliveryEditorValues(saved));
  assert.deepEqual(draft.repositories, [
    {
      repositoryId: "R1",
      mergeMethod: null,
      additionalChecks: read(null).additionalChecks,
    },
  ]);
  // The legacy list moves on the first save, so the form offers it as a change.
  assert.deepEqual(deliveryPolicyChangeText(saved, draft), [
    "Project-wide required checks move into each repository's additional checks",
  ]);
  const sent = deliveryPolicySubmission(draft);
  assert.deepEqual(sent.requiredChecks, []);
  assert.deepEqual(sent.repositories, [
    {
      repositoryId: "R1",
      requiredChecks: [
        { name: "build", appId: 7 },
        {
          savedRow: (read(null).additionalChecks[1] as { savedRow: unknown })
            .savedRow,
          keep: true,
        },
      ],
    },
  ]);
  const squash = {
    ...draft,
    repositories: [
      { ...draft.repositories![0]!, mergeMethod: "squash" as const },
    ],
  };
  assert.deepEqual(
    deliveryPolicySubmission(squash).repositories?.[0]?.mergeMethod,
    "squash",
  );
  assert.deepEqual(deliveryPolicyChangeText(saved, squash).slice(0, 1), [
    "Merge method changed for R1",
  ]);
  assert.deepEqual(deliveryFieldErrors(squash), {});
  // The default branch's methods are guidance: a PR may target a branch with other rules.
  const rebase = {
    ...draft,
    repositories: [
      { ...draft.repositories![0]!, mergeMethod: "rebase" as const },
    ],
  };
  assert.deepEqual(deliveryFieldErrors(rebase), {});
  assert.equal(
    deliveryPolicySubmission(rebase).repositories?.[0]?.mergeMethod,
    "rebase",
  );
  const blank = {
    ...draft,
    repositories: [
      {
        ...draft.repositories![0]!,
        additionalChecks: [{ name: " " }, { name: "x", appId: Number.NaN }],
      },
    ],
  };
  assert.deepEqual(Object.keys(deliveryFieldErrors(blank)), [
    "repositories.0.requiredChecks.0.name",
    "repositories.0.requiredChecks.1.appId",
  ]);
  // With no visible repository, or from an older server, the project-wide list is sent as before.
  const unlinked = deliveryEditorDraft(
    deliveryEditorValues(
      seed({ requiredChecks: [{ name: "build" }], repositories: [] }),
    ),
  );
  assert.equal("repositories" in deliveryPolicySubmission(unlinked), false);
  assert.deepEqual(deliveryPolicySubmission(unlinked).requiredChecks, [
    { name: "build" },
  ]);
  const legacy = deliveryEditorDraft(
    deliveryEditorValues(seed({ requiredChecks: [{ name: "build" }] })),
  );
  assert.equal("repositories" in deliveryPolicySubmission(legacy), false);
  assert.deepEqual(deliveryPolicySubmission(legacy).requiredChecks, [
    { name: "build" },
  ]);
});
