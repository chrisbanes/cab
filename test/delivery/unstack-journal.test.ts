import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { ProjectWrites } from "../../src/standalone/project-writes.js";
import { GitHubHttpDeliveryProvider } from "../../src/standalone/github-delivery.js";
import { materialDigest } from "../../src/core/delivery.js";
import {
  projectLifecycle,
  projectLifecycleMatches,
} from "../../src/core/project-lifecycle.js";
import { transaction } from "../../src/core/store.js";
import {
  UnstackStore,
  unstackIdentitySchema,
  type UnstackRecord,
} from "../../src/core/unstack.js";
import {
  UnstackCoordinator,
  UnstackAuthorityChangedError,
  type UnstackAuthority,
  type UnstackProvider,
  type UnstackReadback,
} from "../../src/standalone/unstack.js";
import { unstackFixtureRecord } from "../fixtures/unstack-journal.js";

function fixture(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  // Real lifecycle storage, with synthetic identities and no host/runtime/provider access.
  db.exec(`CREATE TABLE domain_projects(id TEXT PRIMARY KEY,version INTEGER,paused INTEGER,archived INTEGER);
    CREATE TABLE domain_tasks(id TEXT PRIMARY KEY,projectId TEXT REFERENCES domain_projects(id));
    CREATE TABLE task_dependency_records(seq INTEGER PRIMARY KEY AUTOINCREMENT,taskId TEXT,blockerTaskId TEXT);
    CREATE TABLE accepted_base(taskId TEXT PRIMARY KEY,base TEXT);
    CREATE TABLE restack_events(identity TEXT PRIMARY KEY);`);
  const taskId = randomUUID(),
    blockerTaskId = randomUUID(),
    projectId = randomUUID();
  db.prepare("INSERT INTO domain_projects VALUES (?,1,0,0)").run(projectId);
  for (const task of [taskId, blockerTaskId])
    db.prepare("INSERT INTO domain_tasks VALUES (?,?)").run(task, projectId);
  db.prepare(
    "INSERT INTO task_dependency_records(taskId,blockerTaskId) VALUES (?,?)",
  ).run(taskId, blockerTaskId);
  const journal = new UnstackStore(db);
  journal.migrate();
  const writes = new ProjectWrites(db);
  const lifecycle = projectLifecycle(db, projectId);
  const identity = unstackIdentitySchema.parse({
    taskId,
    projectId,
    taskVersion: 1,
    projectVersion: 1,
    policyVersion: 1,
    deliveryRevision: 1,
    authorityDigest: "a".repeat(64),
    repositoryId: "R",
    repositoryPath: "/repos/fixture/private",
    pr: {
      nodeId: "PR2",
      number: 2,
      headRef: "upper",
      headSha: "b".repeat(40),
      baseRef: "lower",
    },
    targetBaseRef: "main",
    edge: {
      blockerTaskId,
      repositoryId: "R",
      parentHead: "a".repeat(40),
      settledHead: "a".repeat(40),
      restack: "current",
      restackFromSha: null,
      restackSeq: 0,
      recordedAt: 1,
      seq: 1,
    },
    stack: {
      id: 10,
      number: 3,
      baseRef: "main",
      members: [
        {
          nodeId: "PR1",
          number: 1,
          headRef: "lower",
          headSha: "a".repeat(40),
          state: "OPEN",
        },
        {
          nodeId: "PR2",
          number: 2,
          headRef: "upper",
          headSha: "b".repeat(40),
          state: "OPEN",
        },
      ],
    },
  });
  const command = {
    key: randomUUID(),
    taskId,
    expectedVersion: 1,
    materialHash: materialDigest(identity),
  };
  const material = {
    repositoryPath: identity.repositoryPath,
    pr: identity.pr,
    stack: identity.stack,
  };
  let observation: UnstackReadback = { state: "member", material };
  let valid = true,
    leases = 0,
    unstackSends = 0,
    retargetSends = 0,
    confirms = 0;
  const provider: UnstackProvider = {
    read: async () => observation,
    sendUnstack: async (_, guard) => {
      guard();
      unstackSends++;
      observation = {
        state: "removed",
        baseRef: "lower",
        baseSha: "c".repeat(40),
      };
      return "unknown";
    },
    sendRetarget: async (_, guard) => {
      guard();
      retargetSends++;
      observation = {
        state: "removed",
        baseRef: "main",
        baseSha: "d".repeat(40),
      };
      return "unknown";
    },
  };
  const authority: UnstackAuthority = {
    projectWrite: (_, run) =>
      writes.run(projectId, "provider-write", async () => {
        leases++;
        try {
          return await run();
        } finally {
          leases--;
        }
      }),
    validate: () => {
      if (!valid || !projectLifecycleMatches(db, lifecycle))
        throw new UnstackAuthorityChangedError("Captured authority changed");
    },
    confirm: (r) =>
      transaction(db, () => {
        authority.validate(r.identity);
        db.prepare("INSERT INTO accepted_base VALUES (?,?)").run(
          taskId,
          r.identity.targetBaseRef,
        );
        db.prepare("INSERT INTO restack_events VALUES (?)").run(
          `unstack:${r.operationId}`,
        );
        const next = journal.updateWithinTransaction(r, {
          phase: "confirmed",
          reason: "confirmed",
        });
        confirms++;
        return next;
      }),
  };
  const coordinator = () =>
    new UnstackCoordinator(new UnstackStore(db), provider, authority);
  return {
    db,
    journal,
    writes,
    identity,
    command,
    material,
    provider,
    authority,
    coordinator,
    setValid: (v: boolean) => {
      valid = v;
    },
    setRead: (v: UnstackReadback) => {
      observation = v;
    },
    counts: () => ({ leases, unstackSends, retargetSends, confirms }),
  };
}

test("Unstack confirms removal and exact retarget before one atomic acceptance/restack; replay is effect-free", async (t) => {
  const f = fixture(t);
  const result = await f.coordinator().execute(f.command, f.identity);
  assert.equal(result.phase, "confirmed");
  assert.equal(
    f.journal.retired(f.command.taskId, f.identity.edge.blockerTaskId),
    true,
  );
  assert.deepEqual(
    await f.coordinator().execute(f.command, f.identity),
    result,
  );
  assert.deepEqual(f.counts(), {
    leases: 0,
    unstackSends: 1,
    retargetSends: 1,
    confirms: 1,
  });
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM restack_events").get()!.n,
    1,
  );
  assert.equal(f.journal.pending(f.command.taskId).length, 0);
  // Retained audit never retires a later, explicitly recreated dependency generation.
  f.db.prepare("DELETE FROM task_dependency_records").run();
  f.db
    .prepare(
      "INSERT INTO task_dependency_records(taskId,blockerTaskId) VALUES (?,?)",
    )
    .run(f.command.taskId, f.identity.edge.blockerTaskId);
  assert.equal(
    f.journal.retired(f.command.taskId, f.identity.edge.blockerTaskId),
    false,
  );
});

for (const point of ["unstack", "retarget"] as const) {
  test(`${point} timeout/restart retains intent and performs readback only`, async (t) => {
    const f = fixture(t);
    if (point === "unstack")
      f.provider.sendUnstack = async () => {
        throw new Error("timeout");
      };
    else
      f.provider.sendRetarget = async () => {
        throw new Error("timeout");
      };
    const r = await f.coordinator().execute(f.command, f.identity);
    assert.equal(r.phase, `${point}-attempting`);
    f.provider.sendUnstack = f.provider.sendRetarget = async () => {
      assert.fail("Unknown effects must never resend");
    };
    for (let n = 0; n < 3; n++)
      assert.equal(
        (await f.coordinator().reconcile(r.operationId)).phase,
        r.phase,
      );
    assert.equal(f.journal.pending(f.command.taskId).length, 1);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM accepted_base").get()!.n,
      0,
    );
    // An exact subsequent readback completes without inventing a successful send response.
    f.setRead({ state: "removed", baseRef: "main", baseSha: "d".repeat(40) });
    assert.equal(
      (await f.coordinator().reconcile(r.operationId)).phase,
      "confirmed",
    );
    assert.equal(f.counts().leases, 0);
  });
}

test("definite Unstack rejection is terminal; partial Unstack with refused retarget stays blocking", async (t) => {
  const a = fixture(t);
  a.provider.sendUnstack = async () => "refused";
  assert.equal(
    (await a.coordinator().execute(a.command, a.identity)).phase,
    "failed",
  );
  assert.equal(a.journal.pending(a.command.taskId).length, 0);
  const b = fixture(t);
  b.provider.sendRetarget = async () => "refused";
  const partial = await b.coordinator().execute(b.command, b.identity);
  assert.equal(partial.phase, "retarget-attempting");
  assert.equal(partial.retargetRejected, true);
  assert.equal(b.journal.pending(b.command.taskId).length, 1);
  b.provider.sendRetarget = async () => {
    assert.fail("Rejected partial operation must not resend");
  };
  assert.equal(
    (await b.coordinator().reconcile(partial.operationId)).phase,
    "retarget-attempting",
  );
  assert.equal(
    b.journal.retired(b.command.taskId, b.identity.edge.blockerTaskId),
    false,
  );
});

test("membership/order/head changes and stale authority refuse sends; storage failure stays visible", async (t) => {
  const a = fixture(t);
  a.setRead({
    state: "member",
    material: {
      ...a.material,
      stack: {
        ...a.identity.stack,
        members: [...a.identity.stack.members].reverse(),
      },
    },
  });
  assert.equal(
    (await a.coordinator().execute(a.command, a.identity)).reason,
    "identity-changed",
  );
  assert.equal(a.counts().unstackSends, 0);
  const b = fixture(t);
  b.provider.read = async () => {
    b.setValid(false);
    return { state: "member", material: b.material };
  };
  assert.equal(
    (await b.coordinator().execute(b.command, b.identity)).phase,
    "failed",
  );
  assert.equal(b.counts().unstackSends, 0);
  const c = fixture(t);
  c.authority.validate = () => {
    throw new Error("storage fault");
  };
  await assert.rejects(
    c.coordinator().execute(c.command, c.identity),
    /storage fault/,
  );
  assert.equal(c.counts().leases, 0);
});

test("journal rejects altered key material, malformed ownership, phase rewind and partial-effect failure", async (t) => {
  const f = fixture(t);
  let r = f.journal.prepare(f.command, f.identity, () => {});
  await assert.rejects(
    f.coordinator().execute({ ...f.command, expectedVersion: 2 }, f.identity),
    /different material/,
  );
  r = f.journal.update(r, { phase: "unstack-attempting" });
  r = f.journal.update(r, { phase: "unstack-confirmed", removed: true });
  assert.throws(() =>
    f.journal.update(r, { phase: "failed", reason: "unstack-refused" }),
  );
  assert.throws(() => f.journal.update(r, { phase: "prepared" }));
  const otherProject = randomUUID();
  f.db
    .prepare("INSERT INTO domain_projects VALUES (?,1,0,0)")
    .run(otherProject);
  f.db
    .prepare("UPDATE delivery_unstack_operations SET projectId=?")
    .run(otherProject);
  assert.throws(() => f.journal.pending(f.command.taskId), /owner\/phase/);
});

test("final local failure rolls back base, restack and terminal phase together", async (t) => {
  const f = fixture(t),
    original = f.authority.confirm;
  f.authority.confirm = (r: UnstackRecord) =>
    transaction(f.db, () => {
      f.db
        .prepare("INSERT INTO accepted_base VALUES (?,?)")
        .run(f.command.taskId, "main");
      f.journal.updateWithinTransaction(r, {
        phase: "confirmed",
        reason: "confirmed",
      });
      throw new Error("atomic acceptance interrupted");
    });
  await assert.rejects(
    f.coordinator().execute(f.command, f.identity),
    /interrupted/,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM accepted_base").get()!.n,
    0,
  );
  assert.equal(f.journal.get(f.command.key)?.phase, "retarget-confirmed");
  assert.equal(f.journal.pending(f.command.taskId).length, 1);
  f.authority.confirm = original;
  assert.equal(
    (await f.coordinator().reconcile(f.command.key)).phase,
    "confirmed",
  );
  assert.deepEqual(f.counts(), {
    leases: 0,
    unstackSends: 1,
    retargetSends: 1,
    confirms: 1,
  });
});

test("all unfinished phases retain drain ownership, including both confirmed intermediates", (t) => {
  const f = fixture(t);
  let r = f.journal.prepare(f.command, f.identity, () => {});
  assert.equal(f.journal.pending(f.command.taskId).length, 1);
  for (const patch of [
    { phase: "unstack-attempting" as const },
    { phase: "unstack-confirmed" as const, removed: true },
    { phase: "retarget-attempting" as const },
    { phase: "retarget-confirmed" as const, newBaseSha: "d".repeat(40) },
  ]) {
    r = f.journal.update(r, patch);
    assert.equal(f.journal.pending(f.command.taskId).length, 1, r.phase);
    assert.throws(
      () =>
        f.journal.prepare(
          { ...f.command, key: randomUUID() },
          f.identity,
          () => {},
        ),
      /unfinished owner/,
    );
  }
});

test("late dispatch authority change sends nothing and retains the attempting checkpoint", async (t) => {
  const f = fixture(t);
  f.provider.sendUnstack = async (_, beforeSend) => {
    f.setValid(false); // Credential resolution or another await can invalidate the captured authority.
    beforeSend();
    assert.fail("Dispatch must not pass its final authority guard");
  };
  const r = await f.coordinator().execute(f.command, f.identity);
  assert.equal(r.phase, "unstack-attempting");
  assert.equal(f.journal.pending(f.command.taskId).length, 1);
  assert.equal(f.counts().unstackSends, 0);
});

test("concurrent command/reconcile calls serialize and register every service write before awaiting", async (t) => {
  const f = fixture(t),
    c = f.coordinator();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.provider.read;
  let first = true;
  f.provider.read = async (i) => {
    if (first) {
      first = false;
      await barrier;
    }
    return original(i);
  };
  const a = c.execute(f.command, f.identity),
    b = c.execute(f.command, f.identity);
  assert.equal(f.counts().leases, 2);
  assert.equal(
    f.writes.blockers(f.identity.projectId)[0]?.kind,
    "provider-write",
  );
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(ra, rb);
  assert.deepEqual(f.writes.blockers(f.identity.projectId), []);
  assert.deepEqual(f.counts(), {
    leases: 0,
    unstackSends: 1,
    retargetSends: 1,
    confirms: 1,
  });
});

test("forged target SHA or missing readback stays unfinished and cannot commit a base", async (t) => {
  const f = fixture(t);
  f.provider.sendUnstack = async () => {
    f.setRead({ state: "removed", baseRef: "main", baseSha: "forged" });
    return "unknown";
  };
  assert.equal(
    (await f.coordinator().execute(f.command, f.identity)).phase,
    "unstack-attempting",
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM accepted_base").get()!.n,
    0,
  );
});

test("GitHub Unstack and retarget use frozen paths, exact methods/bodies and post-credential authority guards", async (t) => {
  const f = fixture(t),
    requests: {
      path: string;
      method: string;
      body: unknown;
      version: string | null;
    }[] = [];
  const policy = {
    version: 1,
    mode: "reviewable-pr" as const,
    credentialRef: null,
    grants: [],
    requiredChecks: [],
  };
  let credentials = 0,
    guarded = 0;
  const transport = new GitHubHttpDeliveryProvider(
    async () => {
      credentials++;
      return "synthetic-token";
    },
    async (url, init) => {
      assert.equal(guarded, requests.length + 1);
      requests.push({
        path: new URL(String(url)).pathname,
        method: init!.method!,
        body: init!.body,
        version: new Headers(init!.headers).get("X-GitHub-Api-Version"),
      });
      return new Response(null, { status: 204 });
    },
  ).unstackProvider(policy);
  let r = f.journal.prepare(f.command, f.identity, () => {});
  r = f.journal.update(r, { phase: "unstack-attempting" });
  assert.equal(
    await transport.sendUnstack(r, () => {
      assert.equal(credentials, 1);
      guarded++;
    }),
    "unknown",
  );
  r = f.journal.update(r, { phase: "unstack-confirmed", removed: true });
  r = f.journal.update(r, { phase: "retarget-attempting" });
  assert.equal(
    await transport.sendRetarget(r, () => {
      guarded++;
    }),
    "unknown",
  );
  assert.deepEqual(requests, [
    {
      path: "/repos/fixture/private/stacks/3/unstack",
      method: "POST",
      body: undefined,
      version: "2026-03-10",
    },
    {
      path: "/repos/fixture/private/pulls/2",
      method: "PATCH",
      body: JSON.stringify({ base: "main" }),
      version: "2026-03-10",
    },
  ]);
  const denied = new GitHubHttpDeliveryProvider("synthetic-token", async () => {
    assert.fail("Authority changed: no network");
  }).unstackProvider(policy);
  assert.equal(
    await denied.sendRetarget(r, () => {
      throw new UnstackAuthorityChangedError("stale");
    }),
    "unknown",
  );
});

for (const status of [409, 422, 500]) {
  test(`GitHub send status ${status} preserves conservative no-effect classification`, async (t) => {
    const f = fixture(t);
    const transport = new GitHubHttpDeliveryProvider(
      "synthetic-token",
      async () =>
        new Response(JSON.stringify({ message: "synthetic refusal" }), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    ).unstackProvider({
      version: 1,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: [],
      requiredChecks: [],
    });
    const r = f.journal.update(
      f.journal.prepare(f.command, f.identity, () => {}),
      { phase: "unstack-attempting" },
    );
    assert.equal(
      await transport.sendUnstack(r, () => {}),
      status === 422 ? "refused" : "unknown",
    );
  });
}

test("closed-unmerged lower layer follows the same explicit operator Unstack path", async (t) => {
  const f = fixture(t);
  const identity = unstackIdentitySchema.parse({
    ...f.identity,
    stack: {
      ...f.identity.stack,
      members: f.identity.stack.members.map((m) =>
        m.nodeId === "PR1" ? { ...m, state: "CLOSED" } : m,
      ),
    },
  });
  f.setRead({
    state: "member",
    material: {
      repositoryPath: identity.repositoryPath,
      pr: identity.pr,
      stack: identity.stack,
    },
  });
  const command = { ...f.command, materialHash: materialDigest(identity) };
  assert.equal(
    (await f.coordinator().execute(command, identity)).phase,
    "confirmed",
  );
  assert.deepEqual(f.counts(), {
    leases: 0,
    unstackSends: 1,
    retargetSends: 1,
    confirms: 1,
  });
});

for (const field of ["headSha", "baseRef"] as const) {
  test(`changed ${field} invalidates captured operator material before any send`, async (t) => {
    const f = fixture(t);
    f.setRead({
      state: "member",
      material: {
        ...f.material,
        pr: {
          ...f.material.pr,
          [field]: field === "headSha" ? "f".repeat(40) : "other-base",
        },
      },
    });
    assert.equal(
      (await f.coordinator().execute(f.command, f.identity)).reason,
      "identity-changed",
    );
    assert.equal(f.counts().unstackSends, 0);
    assert.equal(f.journal.pending(f.command.taskId).length, 1);
  });
}

test("authority change after removal preserves partial ownership and never sends retarget", async (t) => {
  const f = fixture(t),
    unstack = f.provider.sendUnstack;
  f.provider.sendUnstack = async (r, guard) => {
    const result = await unstack(r, guard);
    f.setValid(false);
    return result;
  };
  const r = await f.coordinator().execute(f.command, f.identity);
  assert.equal(r.phase, "unstack-confirmed");
  assert.equal(r.reason, "authority-changed");
  assert.equal(f.journal.pending(f.command.taskId).length, 1);
  assert.deepEqual(f.counts(), {
    leases: 0,
    unstackSends: 1,
    retargetSends: 0,
    confirms: 0,
  });
});

test("actual lifecycle version changes across a provider await refuse the first send", async (t) => {
  const f = fixture(t);
  f.provider.read = async () => {
    f.db
      .prepare(
        "UPDATE domain_projects SET version=version+1,paused=1 WHERE id=?",
      )
      .run(f.identity.projectId);
    return { state: "member", material: f.material };
  };
  const r = await f.coordinator().execute(f.command, f.identity);
  assert.equal(r.phase, "failed");
  assert.equal(r.noEffect, "prepared-authority-refused");
  assert.equal(f.counts().unstackSends, 0);
  assert.deepEqual(f.writes.blockers(f.identity.projectId), []);
});

test("terminal receipt replay is read-only after archive and never creates a new write lease", async (t) => {
  const f = fixture(t),
    c = f.coordinator();
  const confirmed = await c.execute(f.command, f.identity);
  f.db
    .prepare(
      "UPDATE domain_projects SET version=version+1,archived=1 WHERE id=?",
    )
    .run(f.identity.projectId);
  assert.deepEqual(
    await f.coordinator().execute(f.command, f.identity),
    confirmed,
  );
  assert.deepEqual(await f.coordinator().reconcile(f.command.key), confirmed);
  assert.deepEqual(f.writes.blockers(f.identity.projectId), []);
  assert.deepEqual(f.counts(), {
    leases: 0,
    unstackSends: 1,
    retargetSends: 1,
    confirms: 1,
  });
});

test("GitHub transport with synthetic HTTP200 partial membership is never success, and later complete removal is identity-bound readback", async (t) => {
  const f = fixture(t),
    i = f.identity;
  let selectedRemoved = false,
    siblingRemoved = false,
    omitMembership = false,
    posts = 0;
  const membership = {
    id: i.stack.id,
    number: i.stack.number,
    position: 1,
    size: 2,
    base: { ref: "main", sha: "c".repeat(40) },
  };
  const host = new GitHubHttpDeliveryProvider(
    "synthetic-token",
    async (url, init) => {
      const path = new URL(String(url)).pathname;
      let value: unknown;
      if (path === "/graphql")
        value = {
          data: { node: { id: "R", nameWithOwner: "fixture/private" } },
        };
      else if (path === "/repos/fixture/private")
        value = {
          node_id: "R",
          full_name: "fixture/private",
          allow_merge_commit: true,
          allow_squash_merge: true,
          allow_rebase_merge: true,
          default_branch: "main",
        };
      else if (path.endsWith("/unstack")) {
        assert.equal(init?.method, "POST");
        posts++;
        selectedRemoved = true;
        value = {
          id: i.stack.id,
          number: i.stack.number,
          pull_requests: [{ number: 1 }],
        };
      } else if (path === `/repos/fixture/private/stacks/${i.stack.number}`) {
        value = {
          id: i.stack.id,
          number: i.stack.number,
          base: { ref: "main" },
          pull_requests: i.stack.members.map((m) => ({
            node_id: m.nodeId,
            number: m.number,
            head: { ref: m.headRef, sha: m.headSha },
            state: "open",
            merged_at: null,
          })),
        };
      } else {
        const own = path.endsWith("/pulls/2"),
          m = i.stack.members[own ? 1 : 0]!;
        value = {
          node_id: m.nodeId,
          number: m.number,
          state: "open",
          merged: false,
          body: "",
          head: { ref: m.headRef, sha: m.headSha, repo: { node_id: "R" } },
          base: { ref: own ? "lower" : "main", repo: { node_id: "R" } },
          stack: (own ? selectedRemoved : siblingRemoved)
            ? omitMembership
              ? undefined
              : null
            : { ...membership, position: own ? 2 : 1 },
        };
      }
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  // inspectPr's REST/GraphQL head+base proof is separately tested; isolate this full-stack transport boundary.
  host.inspectPr = async () => ({
    repositoryId: "R",
    nodeId: "PR2",
    number: 2,
    headRef: "upper",
    headSha: i.pr.headSha,
    baseRef: "main",
    baseSha: "d".repeat(40),
    state: "OPEN",
    merged: false,
    draft: false,
    reviewDecision: null,
    checks: [],
    closedIssueNodeIds: [],
    mergeBlockers: [],
    allowedMethods: ["squash"],
    stack: null,
  });
  const provider = host.unstackProvider({
    version: 1,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: [],
    requiredChecks: [],
  });
  const coordinator = () =>
    new UnstackCoordinator(f.journal, provider, f.authority);
  assert.equal(
    (await coordinator().execute(f.command, i)).phase,
    "unstack-attempting",
  );
  assert.deepEqual(await provider.read(i), { state: "changed" });
  assert.equal(
    (await coordinator().reconcile(f.command.key)).phase,
    "unstack-attempting",
  );
  assert.equal(posts, 1);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM restack_events").get()!.n,
    0,
  );
  omitMembership = true;
  assert.deepEqual(await provider.read(i), { state: "changed" });
  siblingRemoved = true;
  assert.equal(
    (await coordinator().reconcile(f.command.key)).phase,
    "confirmed",
  );
  assert.equal(posts, 1);
});

test("a second task cannot issue another command against the same unfinished provider stack", (t) => {
  const f = fixture(t);
  f.journal.prepare(f.command, f.identity, () => {});
  const taskId = randomUUID();
  f.db
    .prepare("INSERT INTO domain_tasks VALUES (?,?)")
    .run(taskId, f.identity.projectId);
  const identity = unstackIdentitySchema.parse({ ...f.identity, taskId });
  const command = {
    ...f.command,
    key: randomUUID(),
    taskId,
    materialHash: materialDigest(identity),
  };
  assert.throws(
    () => f.journal.prepare(command, identity, () => {}),
    /unfinished owner/,
  );
  assert.equal(f.journal.records().length, 1);
});

test("a final dispatch guard storage failure remains visible with durable attempting intent and no effect", async (t) => {
  const f = fixture(t);
  f.provider.sendUnstack = async (_, guard) => {
    f.authority.validate = () => {
      throw new Error("dispatch storage fault");
    };
    guard();
    assert.fail("A storage fault must prevent dispatch");
  };
  await assert.rejects(
    f.coordinator().execute(f.command, f.identity),
    /dispatch storage fault/,
  );
  assert.equal(f.journal.get(f.command.key)?.phase, "unstack-attempting");
  assert.equal(f.counts().unstackSends, 0);
  assert.equal(f.counts().leases, 0);
});

for (const valid of [true, false]) {
  test(`advancing target base ${valid ? "renews evidence and needs a later matching read" : "cannot bypass changed authority"}`, async (t) => {
    const f = fixture(t),
      read = f.provider.read,
      nextBase = "e".repeat(40);
    let advanced = false;
    f.provider.read = async (identity) => {
      if (
        !advanced &&
        f.journal.get(f.command.key)?.phase === "retarget-confirmed"
      ) {
        advanced = true;
        f.setRead({ state: "removed", baseRef: "main", baseSha: nextBase });
        f.setValid(valid);
      }
      return read(identity);
    };
    const renewed = await f.coordinator().execute(f.command, f.identity);
    assert.equal(renewed.phase, "retarget-confirmed");
    assert.equal(
      renewed.reason,
      valid ? "readback-required" : "authority-changed",
    );
    assert.equal(renewed.newBaseSha, valid ? nextBase : "d".repeat(40));
    assert.deepEqual(renewed.identity, f.identity);
    assert.equal(f.journal.pending(f.command.taskId).length, 1);
    assert.equal(f.counts().confirms, 0);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM restack_events").get()!.n,
      0,
    );
    f.setValid(true);
    if (!valid) {
      const refreshed = await f.coordinator().reconcile(f.command.key);
      assert.equal(refreshed.phase, "retarget-confirmed");
      assert.equal(refreshed.newBaseSha, nextBase);
      assert.equal(f.counts().confirms, 0);
    }
    const confirmed = await f.coordinator().reconcile(f.command.key);
    assert.equal(confirmed.phase, "confirmed");
    assert.equal(confirmed.newBaseSha, nextBase);
    assert.deepEqual(confirmed.command, f.command);
    assert.deepEqual(f.counts(), {
      leases: 0,
      unstackSends: 1,
      retargetSends: 1,
      confirms: 1,
    });
    assert.deepEqual(await f.coordinator().reconcile(f.command.key), confirmed);
    assert.equal(f.counts().confirms, 1);
  });
}

test("a GitLab Unstack identity has no stack object; GitHub identities parse and hash as before", () => {
  const github = unstackFixtureRecord({
    projectId: randomUUID(),
    taskId: randomUUID(),
    blockerTaskId: randomUUID(),
    operationId: randomUUID(),
    seq: 1,
  }).identity;
  const reparsed = unstackIdentitySchema.parse(structuredClone(github));
  assert.deepEqual(reparsed, github);
  assert.equal(materialDigest(reparsed), materialDigest(github));
  const accepts = (value: unknown) =>
    unstackIdentitySchema.safeParse(value).success;
  assert.equal(
    accepts({ ...github, stack: { ...github.stack, number: null } }),
    false,
  );
  const gitlab = {
    ...github,
    repositoryId: "42",
    repositoryPath: "/projects/42",
    edge: { ...github.edge, repositoryId: "42" },
    stack: { ...github.stack, id: null, number: null },
  };
  assert.equal(accepts(gitlab), true);
  assert.equal(
    accepts({ ...gitlab, stack: { ...gitlab.stack, number: 1 } }),
    false,
  );
  const [lower, own] = gitlab.stack.members;
  assert.equal(
    accepts({
      ...gitlab,
      stack: {
        ...gitlab.stack,
        members: [{ ...lower!, nodeId: "PR-other", number: 9 }, lower, own],
      },
    }),
    false,
  );
  assert.equal(
    accepts({ ...gitlab, stack: { ...gitlab.stack, members: [own, lower] } }),
    false,
  );
});
