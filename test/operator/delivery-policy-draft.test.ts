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
  type DeliveryPolicySeed,
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
    const { credentialRef: _savedReference, ...publicPolicy } = policy;
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
