import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  InboxLifecycle,
  workspaceMaintenanceInboxId,
} from "../../src/core/inbox-lifecycle.js";
import { randomUUID } from "node:crypto";

test("Inbox visibility receipts replay without effects and resolved episodes never restore", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE domain_tasks (id TEXT PRIMARY KEY)");
    const store = new InboxLifecycle(db);
    store.migrate();
    const row = store.observe({
      taskId: null,
      kind: "runtime",
      sourceKey: "runtime:1",
    });
    const command = {
      type: "inbox.dismiss" as const,
      key: randomUUID(),
      itemId: row.id,
      expectedRevision: 1,
      note: "Investigating",
    };
    let checks = 0;
    const receipt = store.command(command, () => {
      checks++;
    });
    assert.equal(checks, 1);
    assert.deepEqual(
      store.command(command, () => {
        throw Error("must replay first");
      }),
      receipt,
    );
    assert.equal(store.get(row.id)?.note, "Investigating");
    assert.equal(store.get(row.id)?.dismissedAt !== null, true);
    assert.throws(
      () => store.command({ ...command, note: "different" }, () => {}),
      /different content/,
    );
    const restarted = new InboxLifecycle(db);
    restarted.migrate();
    assert.equal(
      restarted.observe({
        taskId: null,
        kind: "runtime",
        sourceKey: "runtime:1",
      }).status,
      "dismissed",
    );
    assert.equal(
      restarted.observe({
        taskId: null,
        kind: "runtime",
        sourceKey: "runtime:2",
      }).status,
      "actionable",
    );
    store.resolve(row.id, "Runtime became available");
    assert.throws(() => store.change(row.id, 3, "restore"), /changed/);
    assert.equal(store.get(row.id)?.resolution, "Runtime became available");
    assert.equal(store.get(row.id)?.note, "Investigating");
  } finally {
    db.close();
  }
});

import { coordinationFixture } from "../fixtures/coordination.js";
import { canonicalMaterial } from "../../src/core/delivery.js";
import { transaction } from "../../src/core/store.js";

test("exact PR supersession preserves response state and queues one no-grant event across restart", () => {
  const f = coordinationFixture();
  try {
    const material = {
      kind: "pr.edit",
      target: {
        repositoryId: "repo-A",
        number: 31,
        nodeId: "PR-A",
        baseRef: "main",
        headRef: "feature",
        expectedHeadSha: "a".repeat(40),
      },
      fields: { title: "Update title" },
    };
    const result = f.coordination.requestApproval({
      threadId: "thread-child-a",
      turnId: "turn-child-a",
      callId: randomUUID(),
      tool: "cab_request_approval",
      arguments: {
        action: "pr.edit",
        target: canonicalMaterial(material.target),
        material,
      },
    });
    const id = result.text.split(" ").at(-1)!;
    const request = f.coordination
      .interactions()
      .find((i) => i.interactionId === id)!;
    const lifecycle = f.coordination.inboxLifecycle();
    const eventsBefore = f.coordination.inboxEvents(
      request.requestingAssignmentId,
    ).length;
    lifecycle.command(
      {
        type: "inbox.dismiss",
        key: randomUUID(),
        itemId: id,
        expectedRevision: 1,
      },
      () => {},
    );
    assert.equal(
      f.coordination
        .openInteractionsForCompletion(request.taskId)
        .some((i) => i.interactionId === id),
      false,
    );
    assert.equal(
      f.coordination.authorizationFor({
        assignmentId: request.requestingAssignmentId,
        interactionId: id,
        expectedRevision: 1,
        action: "pr.edit",
        target: canonicalMaterial(material.target),
        material,
      }),
      false,
    );
    assert.equal(
      f.coordination.inboxEvents(request.requestingAssignmentId).length,
      eventsBefore,
    );
    lifecycle.command(
      {
        type: "inbox.restore",
        key: randomUUID(),
        itemId: id,
        expectedRevision: 2,
      },
      () => {},
    );
    assert.equal(
      f.coordination
        .openInteractionsForCompletion(request.taskId)
        .some((i) => i.interactionId === id),
      true,
    );
    const supersede = (pr: {
      repositoryId: string;
      number: number;
      nodeId: string;
      state: string;
    }) =>
      transaction(f.db, () =>
        f.coordination.supersedePrApprovalsWithinTransaction(
          request.taskId,
          pr,
        ),
      );
    for (const pr of [
      { repositoryId: "repo-A", number: 31, nodeId: "PR-A", state: "OPEN" },
      { repositoryId: "repo-B", number: 31, nodeId: "PR-A", state: "MERGED" },
      { repositoryId: "repo-A", number: 32, nodeId: "PR-A", state: "CLOSED" },
      {
        repositoryId: "repo-A",
        number: 31,
        nodeId: "PR-other",
        state: "MERGED",
      },
    ])
      supersede(pr);
    assert.equal(
      f.coordination.interactions().find((i) => i.interactionId === id)?.status,
      "open",
    );
    const target = {
      repositoryId: "repo-A",
      number: 31,
      nodeId: "PR-A",
      state: "MERGED",
    };
    supersede(target);
    assert.equal(
      f.coordination.interactions().find((i) => i.interactionId === id)?.status,
      "superseded",
    );
    const raw = f.db
      .prepare(
        "SELECT status,response FROM coordination_interactions WHERE interactionId=?",
      )
      .get(id);
    assert.deepEqual({ ...raw }, { status: "open", response: null });
    let events = f.coordination
      .inboxEvents(request.requestingAssignmentId)
      .filter((e) => e.eventType === "approval-superseded");
    assert.equal(events.length, 1);
    assert.match(events[0]!.payload, /no approval was granted/);
    f.reopen();
    supersede(target);
    events = f.coordination
      .inboxEvents(request.requestingAssignmentId)
      .filter((e) => e.eventType === "approval-superseded");
    assert.equal(events.length, 1);
    assert.throws(
      () =>
        f.coordination.decideApproval({
          actor: "operator",
          key: randomUUID(),
          interactionId: id,
          expectedRevision: 1,
          decision: "approved",
          action: "pr.edit",
          target: canonicalMaterial(material.target),
          material,
        }),
      /obsolete/,
    );
  } finally {
    f.close();
  }
});

test("the maintenance episode refreshes in place, reactivates the same item, cannot be dismissed and prunes deleted tasks", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE domain_tasks (id TEXT PRIMARY KEY)");
    const store = new InboxLifecycle(db);
    store.migrate();
    const [a, b] = [randomUUID(), randomUUID()];
    const blocker = (taskId: string, reason: "uncommitted" | "unsettled") => ({
      taskId,
      workspaceId: randomUUID(),
      condition: "retention" as const,
      reason,
    });
    const first = store.refreshWorkspaceMaintenance(
      { usage: null, blockers: [blocker(a, "uncommitted")] },
      100,
    );
    assert.equal(first.id, workspaceMaintenanceInboxId);
    assert.equal(first.taskId, null);
    assert.equal(first.kind, "workspace-maintenance");
    // Unchanged data is no new revision; changed reasons update the same row.
    const same = store.refreshWorkspaceMaintenance(
      JSON.parse(first.dataJson),
      200,
    );
    assert.equal(same.revision, 1);
    const changed = store.refreshWorkspaceMaintenance(
      {
        usage: { measuredBytes: 12, capBytes: 10 },
        blockers: [blocker(a, "unsettled"), blocker(b, "uncommitted")],
      },
      300,
    );
    assert.equal(changed.revision, 2);
    assert.equal(changed.createdAt, 100);
    assert.equal(store.rows().length, 1);
    assert.throws(
      () =>
        store.command(
          {
            type: "inbox.dismiss",
            key: randomUUID(),
            itemId: changed.id,
            expectedRevision: 2,
          },
          () => {},
        ),
      /cannot be dismissed/,
    );
    store.pruneWorkspaceMaintenance([a]);
    assert.deepEqual(
      store.workspaceMaintenance()?.attention.blockers.map((x) => x.taskId),
      [b],
    );
    store.resolve(changed.id, "cleared");
    assert.equal(store.get(changed.id)?.status, "resolved");
    // A recurrence reactivates the same item as a new episode.
    const again = store.refreshWorkspaceMaintenance(
      { usage: null, blockers: [blocker(b, "uncommitted")] },
      900,
    );
    assert.equal(again.id, changed.id);
    assert.equal(again.status, "actionable");
    assert.equal(again.createdAt, 900);
    assert.equal(again.resolvedAt, null);
    assert.equal(store.rows().length, 1);
    // Bounded, validated data only.
    assert.throws(() =>
      store.refreshWorkspaceMaintenance({
        usage: null,
        blockers: [{ ...blocker(a, "uncommitted"), path: "/private" }],
      } as never),
    );
  } finally {
    db.close();
  }
});
