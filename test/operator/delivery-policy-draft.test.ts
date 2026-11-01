import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryPolicySchema, actionKinds } from "../../src/core/delivery.js";
import {
  deliveryPolicyChangeText,
  deliveryPolicyDraft,
  statusMappingCoverageWarning,
} from "../../web/src/delivery-policy-draft.js";

test("draft round-trips every policy field, action and optional distinction", () => {
  for (const action of actionKinds) {
    const policy = deliveryPolicySchema.parse({
      mode: "through-merge",
      credentialRef: "env:DELIVERY_TOKEN",
      branchPrefix: "",
      grants: [
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
          ...(action === "issue.status" ? { statusIds: ["S", "S"] } : {}),
        },
      ],
      requiredChecks: [{ name: "Build", appId: 42 }, { name: "Test" }],
    });
    const draft = deliveryPolicyDraft({ ...policy, version: 3 });
    const { credentialRef: _credentialRef, ...policyShape } = policy;
    assert.equal(draft.credentialIntent, "keep");
    assert.deepEqual(
      { ...draft, credentialIntent: undefined, version: undefined },
      {
        ...policyShape,
        credentialIntent: undefined,
        version: undefined,
      },
    );
  }
  const absentPrefix = deliveryPolicyDraft({
    mode: "reviewable-pr",
    credentialRef: null,
    grants: [],
    requiredChecks: [],
    version: 1,
  });
  assert.equal("branchPrefix" in absentPrefix, false);
  assert.equal(absentPrefix.credentialIntent, "clear");
});

test("status mapping warning tracks grant coverage and tracker container identity", () => {
  const draft = deliveryPolicyDraft({
    mode: "reviewable-pr",
    credentialRef: null,
    grants: [
      {
        action: "issue.status",
        repositoryId: "tracker",
        mode: "allow",
        statusIds: ["S1"],
      },
    ],
    requiredChecks: [],
    version: 1,
  });
  assert.equal(
    statusMappingCoverageWarning(draft, {
      tracker: "jira",
      repositoryId: "tracker",
      granted: ["S1"],
    }),
    null,
  );
  assert.match(
    statusMappingCoverageWarning(draft, {
      tracker: "jira",
      repositoryId: "other-tracker",
      granted: ["S1"],
    })!,
    /not covered/,
  );
  assert.match(
    statusMappingCoverageWarning(draft, {
      tracker: "jira",
      repositoryId: "tracker",
      granted: ["S1", "S2"],
    })!,
    /not covered/,
  );
});

test("change text excludes credential references and policy version", () => {
  const before = deliveryPolicyDraft({
    mode: "reviewable-pr",
    credentialRef: "env:SECRET",
    grants: [],
    requiredChecks: [],
    version: 1,
  });
  const after = { ...before, version: 2 };
  assert.deepEqual(deliveryPolicyChangeText(before, after), []);
  assert.doesNotMatch(
    deliveryPolicyChangeText(before, {
      ...after,
      credentialIntent: "set",
    }).join(" "),
    /SECRET/,
  );
});
