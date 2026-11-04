import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { materialDigest } from "../../src/core/delivery.js";
import { UnstackStore, type UnstackIdentity } from "../../src/core/unstack.js";
import type {
  UnstackMaterial,
  UnstackProvider,
  UnstackReadback,
} from "../../src/standalone/unstack.js";
import { git } from "../fixtures/publication.js";
import {
  stackedDeliveryFixture,
  repositoryId,
} from "../fixtures/stacked-delivery.js";

async function prepared(t: TestContext) {
  let material!: UnstackMaterial, observation!: UnstackReadback;
  let unstackSends = 0,
    retargetSends = 0,
    loseUnstack = false,
    loseRetarget = false,
    refuseUnstack = false,
    refuseRetarget = false;
  let beforeRead: (() => void) | undefined;
  let partialUnstack = false;
  const provider: UnstackProvider = {
    read: async () => {
      const hook = beforeRead;
      beforeRead = undefined;
      hook?.();
      return observation;
    },
    sendUnstack: async (_, guard) => {
      guard();
      unstackSends++;
      if (refuseUnstack) return "refused";
      if (loseUnstack)
        throw new Error("synthetic lost response before proved effect");
      observation = partialUnstack
        ? { state: "changed" }
        : { state: "removed", baseRef: material.pr.baseRef, baseSha: f.base };
      return "unknown";
    },
    sendRetarget: async (_, guard) => {
      guard();
      retargetSends++;
      if (refuseRetarget) return "refused";
      if (loseRetarget) throw new Error("synthetic lost retarget response");
      observation = { state: "removed", baseRef: "main", baseSha: f.base };
      return "unknown";
    },
  };
  const f = await stackedDeliveryFixture(t, {
    unstack: {
      prepare: async () => material,
      provider,
    },
  });
  const [lower, dependent] = f.tasks as [string, string];
  await f.waitTurn(lower);
  const lowerHead = await f.commit(lower, "lower");
  assert.equal((await f.push(lower, lowerHead)).success, true);
  await f.showPr(lower);
  await f.service.refreshGitHub();
  await f.waitTurn(dependent);
  const upperHead = await f.commit(dependent, "upper");
  assert.equal((await f.push(dependent, upperHead)).success, true);
  await f.showPr(dependent, {
    baseRef: f.branchOf(lower)!.branch,
    baseSha: lowerHead,
  });
  const upper = f.prs.get(`PR-${dependent}`)!,
    bottom = f.prs.get(`PR-${lower}`)!;
  material = {
    repositoryPath: "/repos/fixture/private",
    pr: {
      nodeId: upper.nodeId,
      number: upper.number,
      headRef: upper.headRef,
      headSha: upper.headSha,
      baseRef: upper.baseRef,
    },
    stack: {
      id: 1,
      number: 1,
      baseRef: "main",
      members: [bottom, upper].map((p) => ({
        nodeId: p.nodeId,
        number: p.number,
        headRef: p.headRef,
        headSha: p.headSha,
        state: p.state,
      })),
    },
  };
  observation = { state: "member", material };
  const workspace = (await f.workspaceOf(dependent)).path;
  const image = () => ({
    head: git(workspace, "rev-parse", "HEAD"),
    status: git(workspace, "status", "--porcelain"),
    index: readFileSync(
      git(
        workspace,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
      ),
    ),
    file: readFileSync(`${workspace}/upper.txt`),
  });
  const command = (i: UnstackIdentity) => ({
    key: randomUUID(),
    taskId: dependent,
    expectedVersion: i.taskVersion,
    materialHash: materialDigest(i),
  });
  const journal = () =>
    f.readDb((db) => new UnstackStore(db).records(dependent));
  return {
    ...f,
    current: () => f.service,
    lower,
    dependent,
    material,
    image,
    command,
    journal,
    counts: () => ({ unstackSends, retargetSends }),
    partial: () => {
      partialUnstack = true;
    },
    lost: (effect: "unstack" | "retarget") => {
      if (effect === "unstack") loseUnstack = true;
      else loseRetarget = true;
    },
    refuse: (effect: "unstack" | "retarget") => {
      if (effect === "unstack") refuseUnstack = true;
      else refuseRetarget = true;
    },
    readAs: (next: UnstackReadback) => {
      observation = next;
    },
    onRead: (hook: () => void) => {
      beforeRead = hook;
    },
    hostRetargeted: () => {
      f.prs.set(upper.nodeId, {
        ...upper,
        baseRef: "main",
        baseSha: f.base,
        stack: null,
      });
      f.prs.set(bottom.nodeId, { ...bottom, stack: null });
    },
  };
}

for (const failed of [false, true]) {
  test(`assembled ${failed ? "failed-blocker" : "healthy"} Unstack accepts base, retires only selected edge and queues one restack`, async (t) => {
    const f = await prepared(t);
    if (failed) {
      const lower = f.prs.get(`PR-${f.lower}`)!;
      f.prs.set(lower.nodeId, { ...lower, state: "CLOSED", merged: false });
      f.material.stack.members[0]!.state = "CLOSED";
      await f.current().refreshGitHub();
      assert.ok(
        f
          .current()
          .domain()
          .admission(f.dependent)
          .reasons.includes("stacked-blocker-failed"),
      );
    }
    const before = f.image(),
      i = await f.current().previewTaskUnstack(f.dependent),
      command = f.command(i);
    const result = await f.current().unstackTask(command);
    assert.equal(result.phase, "confirmed");
    assert.equal(
      f.current().delivery().delivery(f.dependent)?.acceptedBaseRef,
      "main",
    );
    assert.equal(
      f.current().domain().activeStackedDependency(f.dependent),
      null,
    );
    assert.equal(
      f.current().domain().stackedDependency(f.dependent)?.restack,
      "pending",
    );
    assert.equal(
      f
        .current()
        .domain()
        .admission(f.dependent)
        .reasons.some((r) => r.startsWith("stacked-blocker-")),
      false,
    );
    assert.equal(
      f.current().delivery().stackMergeGuard(f.dependent, repositoryId).reason,
      null,
    );
    assert.deepEqual(f.image(), before);
    assert.deepEqual(await f.current().unstackTask(command), result);
    f.hostRetargeted();
    await f.current().refreshGitHub();
    await f.restart();
    await f.current().refreshGitHub();
    assert.equal(
      f.current().domain().activeStackedDependency(f.dependent),
      null,
    );
    assert.equal(f.journal().length, 1);
    assert.deepEqual(f.counts(), { unstackSends: 1, retargetSends: 1 });
    f.readDb((db) => {
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM coordination_external_delivery_notices WHERE taskId=? AND identity=?",
          )
          .get(f.dependent, `unstack-restack:${command.key}`)?.n,
        1,
      );
      const retained = db
        .prepare(
          "SELECT restackSeq,parentHead FROM stacked_dependencies WHERE taskId=?",
        )
        .get(f.dependent);
      assert.equal(retained?.parentHead, f.base);
      assert.equal(retained?.restackSeq, 1);
    });
  });
}

for (const effect of ["unstack", "retarget"] as const) {
  test(`assembled ${effect} unknown survives restart, holds work/archive, never resends or queues restack`, async (t) => {
    const f = await prepared(t),
      i = await f.current().previewTaskUnstack(f.dependent),
      command = f.command(i);
    f.lost(effect);
    const result = await f.current().unstackTask(command);
    assert.equal(result.phase, `${effect}-attempting`);
    assert.ok(
      f
        .current()
        .domain()
        .admission(f.dependent)
        .reasons.includes("unstack-pending"),
    );
    const counts = f.counts();
    await f.restart();
    await f.current().refreshGitHub();
    await f.current().unstackTask(command);
    assert.deepEqual(f.counts(), counts);
    f.readDb((db) => {
      assert.ok(new UnstackStore(db).projectBlockers(f.projectId).length > 0);
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM coordination_external_delivery_notices WHERE identity=?",
          )
          .get(`unstack-restack:${command.key}`)?.n,
        0,
      );
    });
    f.readAs({ state: "removed", baseRef: "main", baseSha: f.base });
    assert.equal(
      (await f.current().reconcileTaskUnstack(command.key)).phase,
      "confirmed",
    );
    assert.deepEqual(f.counts(), counts);
  });
}

test("assembled partial retarget refusal stays held; definite unstack refusal is effect-free and replayable", async (t) => {
  const a = await prepared(t),
    ai = await a.current().previewTaskUnstack(a.dependent),
    ac = a.command(ai);
  a.refuse("unstack");
  assert.equal((await a.current().unstackTask(ac)).phase, "failed");
  assert.deepEqual(a.counts(), { unstackSends: 1, retargetSends: 0 });
  assert.equal((await a.current().unstackTask(ac)).phase, "failed");
  const b = await prepared(t),
    bi = await b.current().previewTaskUnstack(b.dependent),
    bc = b.command(bi);
  b.refuse("retarget");
  assert.equal(
    (await b.current().unstackTask(bc)).phase,
    "retarget-attempting",
  );
  await b.current().reconcileTaskUnstack(bc.key);
  assert.deepEqual(b.counts(), { unstackSends: 1, retargetSends: 1 });
  assert.equal(
    b.current().delivery().delivery(b.dependent)?.acceptedBaseRef,
    bi.pr.baseRef,
  );
  assert.ok(
    b
      .current()
      .domain()
      .admission(b.dependent)
      .reasons.includes("unstack-pending"),
  );
});

test("assembled lifecycle race and altered key material never broaden operator authority", async (t) => {
  const f = await prepared(t),
    i = await f.current().previewTaskUnstack(f.dependent),
    c = f.command(i);
  f.onRead(() =>
    f.run({
      type: "project.configure",
      projectId: f.projectId,
      expectedVersion: Number(
        f.current().domain().project(f.projectId).version,
      ),
      paused: true,
    }),
  );
  assert.equal((await f.current().unstackTask(c)).phase, "failed");
  assert.deepEqual(f.counts(), { unstackSends: 0, retargetSends: 0 });
  await assert.rejects(
    f.current().unstackTask({ ...c, expectedVersion: c.expectedVersion + 1 }),
    /different material/,
  );
});

test("confirmed selected-edge retirement preserves independent dependency, Ready, pause and ownership holds", async (t) => {
  const f = await prepared(t);
  const independent = randomUUID();
  f.run({
    type: "task.create",
    projectId: f.projectId,
    taskId: independent,
    title: "Independent blocker",
    outcome: "Hold",
    ready: false,
  });
  f.run({
    type: "dependency.add",
    projectId: f.projectId,
    taskId: f.dependent,
    blockerTaskId: independent,
    expectedVersion: Number(f.current().domain().task(f.dependent).version),
  });
  f.readDb((db) => {
    db.prepare(
      "INSERT INTO task_writer_holds (taskId,reason,holdKind) VALUES (?,'Independent ownership',NULL)",
    ).run(f.dependent);
  });
  f.run({
    type: "task.configure",
    taskId: f.dependent,
    projectId: f.projectId,
    expectedVersion: Number(f.current().domain().task(f.dependent).version),
    ready: false,
  });
  f.run({
    type: "project.configure",
    projectId: f.projectId,
    expectedVersion: Number(f.current().domain().project(f.projectId).version),
    paused: true,
  });
  const i = await f.current().previewTaskUnstack(f.dependent);
  assert.equal(
    (await f.current().unstackTask(f.command(i))).phase,
    "confirmed",
  );
  const admission = f.current().domain().admission(f.dependent);
  assert.ok(admission.reasons.includes("project-paused"));
  assert.ok(admission.reasons.includes("local-dependency"));
  assert.equal(f.current().domain().task(f.dependent).ready, 0);
  f.readDb((db) =>
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM task_writer_holds WHERE taskId=?")
        .get(f.dependent)?.n,
      1,
    ),
  );
});

test("actual service registry keeps archive blocked throughout the provider read", async (t) => {
  const f = await prepared(t);
  f.run({
    type: "project.configure",
    projectId: f.projectId,
    expectedVersion: Number(f.current().domain().project(f.projectId).version),
    paused: true,
  });
  const i = await f.current().previewTaskUnstack(f.dependent);
  f.onRead(() =>
    assert.throws(
      () =>
        f.run({
          type: "project.archive",
          projectId: f.projectId,
          expectedVersion: Number(
            f.current().domain().project(f.projectId).version,
          ),
        }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "blockers" in error &&
        Array.isArray(error.blockers) &&
        error.blockers.some(
          (b: { kind: string }) => b.kind === "provider-write",
        ),
    ),
  );
  assert.equal(
    (await f.current().unstackTask(f.command(i))).phase,
    "confirmed",
  );
});

test("partial HTTP200 with selected PR removed and sibling retained stays original/readback-only across restart until complete-removal proof", async (t) => {
  const f = await prepared(t),
    i = await f.current().previewTaskUnstack(f.dependent),
    command = f.command(i);
  f.partial();
  assert.equal(
    (await f.current().unstackTask(command)).phase,
    "unstack-attempting",
  );
  await f.restart();
  await f.current().refreshGitHub();
  assert.equal(
    (await f.current().unstackTask(command)).phase,
    "unstack-attempting",
  );
  await assert.rejects(
    f.current().unstackTask({ ...command, key: randomUUID() }),
    /authority|current/,
  );
  assert.deepEqual(f.counts(), { unstackSends: 1, retargetSends: 0 });
  assert.equal(f.journal().length, 1);
  assert.equal(
    f.current().delivery().delivery(f.dependent)?.acceptedBaseRef,
    i.pr.baseRef,
  );
  assert.ok(f.current().domain().activeStackedDependency(f.dependent));
  f.readDb((db) => {
    assert.ok(new UnstackStore(db).projectBlockers(f.projectId).length > 0);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM coordination_external_delivery_notices WHERE identity=?",
        )
        .get(`unstack-restack:${command.key}`)?.n,
      0,
    );
  });
  f.readAs({ state: "removed", baseRef: i.pr.baseRef, baseSha: f.base });
  assert.equal(
    (await f.current().reconcileTaskUnstack(command.key)).phase,
    "confirmed",
  );
  assert.deepEqual(f.counts(), { unstackSends: 1, retargetSends: 1 });
  assert.equal(f.journal().length, 1);
});

for (const phase of [
  "prepared",
  "unstack-confirmed",
  "retarget-confirmed",
] as const) {
  test(`assembled restart from ${phase} resumes only unsent effects and commits exactly once`, async (t) => {
    const f = await prepared(t),
      i = await f.current().previewTaskUnstack(f.dependent),
      command = f.command(i);
    if (phase !== "prepared")
      f.readAs({
        state: "removed",
        baseRef: phase === "retarget-confirmed" ? "main" : i.pr.baseRef,
        baseSha: f.base,
      });
    await f.restart((db) => {
      const journal = new UnstackStore(db);
      let r = journal.prepare(command, i, () => {});
      if (phase !== "prepared") {
        r = journal.update(r, { phase: "unstack-attempting" });
        r = journal.update(r, { phase: "unstack-confirmed", removed: true });
        if (phase === "retarget-confirmed")
          journal.update(r, {
            phase: "retarget-confirmed",
            newBaseSha: f.base,
          });
      }
    });
    assert.equal(f.journal()[0]?.phase, "confirmed");
    assert.deepEqual(f.counts(), {
      unstackSends: phase === "prepared" ? 1 : 0,
      retargetSends: phase === "retarget-confirmed" ? 0 : 1,
    });
    await f.current().unstackTask(command);
    assert.equal(f.journal().length, 1);
  });
}

test("assembled concurrent same-key confirmation shares its original operation and conflicting material is refused", async (t) => {
  const f = await prepared(t),
    i = await f.current().previewTaskUnstack(f.dependent),
    command = f.command(i);
  const first = f.current().unstackTask(command),
    second = f.current().unstackTask(command);
  await assert.rejects(
    f.current().unstackTask({ ...command, materialHash: "f".repeat(64) }),
    /different material/,
  );
  assert.deepEqual(await first, await second);
  assert.deepEqual(f.counts(), { unstackSends: 1, retargetSends: 1 });
  assert.equal(f.journal().length, 1);
});
