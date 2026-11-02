import assert from "node:assert/strict";
import { test } from "node:test";
import { leadDeliveryGuidance } from "../../src/core/delivery-guidance.js";
import { repositoryLevelGrants } from "../../src/core/delivery-levels.js";

test("custom level lists granted code-host actions with modes and omits issue grants", () => {
  const text = leadDeliveryGuidance(
    {
      mode: "through-merge",
      grants: [
        { action: "branch.push", repositoryId: "R1", mode: "allow" },
        { action: "pr.merge", repositoryId: "R1", mode: "approval" },
        { action: "issue.comment", repositoryId: "R1", mode: "allow" },
      ],
    },
    ["R1"],
  );
  assert.match(
    text,
    /R1: Custom: .*branch\.push \(allow\), pr\.merge \(approval\)/,
  );
  assert.doesNotMatch(text, /issue\.comment/);
});

test("merge levels carry the refusal caveat only outside through-merge", () => {
  const grants = repositoryLevelGrants("R1", "merge-when-ready");
  const caveat = /delivery mode refuses pr\.merge/;
  assert.match(
    leadDeliveryGuidance({ mode: "reviewable-pr", grants }, ["R1"]),
    caveat,
  );
  assert.doesNotMatch(
    leadDeliveryGuidance({ mode: "through-merge", grants }, ["R1"]),
    caveat,
  );
  const custom = [
    { action: "pr.merge", repositoryId: "R1", mode: "allow" },
  ] as const;
  assert.match(
    leadDeliveryGuidance({ mode: "reviewable-pr", grants: [...custom] }, [
      "R1",
    ]),
    caveat,
  );
});

test("no linked repositories still states the escalation rule", () => {
  const text = leadDeliveryGuidance({ mode: "through-merge", grants: [] }, []);
  assert.match(text, /No linked repositories/);
  assert.match(text, /three unsuccessful repairs[\s\S]*conflicting direction/);
});

test("merge guidance names the repository's configured method, or says pr.merge is held without one", () => {
  const repositories = [
    { repositoryId: "R1", mergeMethod: "squash" as const, requiredChecks: [] },
  ];
  for (const level of ["merge-when-ready", "merge-with-approval"] as const) {
    const grants = repositoryLevelGrants("R1", level);
    assert.match(
      leadDeliveryGuidance({ mode: "through-merge", grants, repositories }, [
        "R1",
      ]),
      /R1: Merge .*pr\.merge with the squash method/,
    );
    assert.match(
      leadDeliveryGuidance({ mode: "through-merge", grants }, ["R1"]),
      /R1: Merge .*No merge method is configured, so pr\.merge is held until the operator sets one\./,
    );
  }
  assert.match(
    leadDeliveryGuidance(
      {
        mode: "through-merge",
        grants: [{ action: "pr.merge", repositoryId: "R1", mode: "allow" }],
        repositories,
      },
      ["R1"],
    ),
    /R1: Custom: .*Merge with the squash method\./,
  );
});
