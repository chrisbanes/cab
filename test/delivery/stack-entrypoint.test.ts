import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { tmpdir } from "../fixtures/temp.js";
import {
  commandReceiptSchema,
  operationReadSchema,
} from "../../src/operator/contracts.js";
import { unstackReadSchema } from "../../src/operator/unstack-contracts.js";
import { StackFixtureRunner } from "./github-qualification/stack-guard.js";
import {
  authorizeStackComposition,
  runStackComposition,
  stackMaterialHash,
  type StackJourneyPorts,
  type StackPortFactory,
} from "./github-qualification/stack-journey.js";

const lower = "30000000-0000-4000-8000-000000000001",
  upper = "30000000-0000-4000-8000-000000000002";
const key = "30000000-0000-4000-8000-000000000004";
const secret = "synthetic-test-secret-0000";
const head = "c".repeat(40),
  rebased = "e".repeat(40),
  newBase = "f".repeat(40);
async function fixture(
  t: TestContext,
  scenario: "merge-adoption" | "unstack" = "merge-adoption",
  equivalent = false,
  cleanup = false,
) {
  const root = await mkdtemp(join(tmpdir(), "cab-stack-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const observed = {
    account: "synthetic-account",
    accountNodeId: "A_synthetic",
    repository: "synthetic/fixture",
    repositoryNodeId: "R_synthetic",
    projectId: "30000000-0000-4000-8000-000000000003",
    taskIds: [lower, upper],
    branchPrefix: "cab-fixture-synthetic/",
    visibility: "private",
    base: "main",
    baseSha: "a".repeat(40),
    refs: [
      { name: "cab-fixture-synthetic/lower", sha: "b".repeat(40) },
      { name: "cab-fixture-synthetic/upper", sha: head },
    ],
    prs: [
      {
        id: "PR_lower_synthetic",
        number: 1,
        head: "cab-fixture-synthetic/lower",
        base: "main",
      },
      {
        id: "PR_upper_synthetic",
        number: 2,
        head: "cab-fixture-synthetic/upper",
        base: "cab-fixture-synthetic/lower",
      },
    ],
    stack: ["PR_lower_synthetic", "PR_upper_synthetic"],
  };
  const merge = {
    id: "lower-merge",
    cleanup: false,
    send: {
      method: "PUT",
      path: "/repos/synthetic/fixture/pulls/1/merge-async",
      body: JSON.stringify({
        sha: "b".repeat(40),
        merge_method: "squash",
        bypass_rules: false,
      }),
    },
    readback: {
      method: "GET",
      path: "/repos/synthetic/fixture/pulls/1",
      body: "",
    },
  };
  const unstack = {
    id: "unstack",
    cleanup: false,
    send: {
      method: "POST",
      path: "/repos/synthetic/fixture/stacks/1/unstack",
      body: "",
    },
    readback: {
      method: "GET",
      path: "/repos/synthetic/fixture/stacks/1",
      body: "",
    },
  };
  const retarget = {
    id: "retarget",
    cleanup: false,
    send: {
      method: "PATCH",
      path: "/repos/synthetic/fixture/pulls/2",
      body: '{"base":"main"}',
    },
    readback: {
      method: "GET",
      path: "/repos/synthetic/fixture/pulls/2",
      body: "",
    },
  };
  const operations =
    scenario === "merge-adoption" ? [merge] : [unstack, retarget];
  if (equivalent)
    operations.push({
      id: "equivalent-rebase",
      cleanup: false,
      send: {
        method: "PATCH",
        path: "/repos/synthetic/fixture/git/refs/heads/cab-fixture-synthetic/upper",
        body: JSON.stringify({ sha: rebased, force: false }),
      },
      readback: {
        method: "GET",
        path: "/repos/synthetic/fixture/git/ref/heads/cab-fixture-synthetic/upper",
        body: "",
      },
    });
  if (cleanup)
    operations.push({
      id: "cleanup-upper",
      cleanup: true,
      send: {
        method: "DELETE",
        path: "/repos/synthetic/fixture/git/refs/heads/cab-fixture-synthetic/upper",
        body: "",
      },
      readback: {
        method: "GET",
        path: "/repos/synthetic/fixture/git/ref/heads/cab-fixture-synthetic/upper",
        body: "",
      },
    });
  const readiness = {
    version: 1,
    runId: "30000000-0000-4000-8000-000000000005",
    observedAt: "2098-01-01T00:00:00Z",
    expiresAt: "2098-01-01T00:10:00Z",
    host: {
      id: "synthetic-host",
      runtime: "synthetic-runtime",
      version: "synthetic-1",
      credentialRef: "env:SYNTHETIC_ONLY",
    },
    observed,
    scenario,
    maxElapsedMs: 120000,
    mergeOperation: scenario === "merge-adoption" ? merge.id : null,
    equivalentRebaseOperation: equivalent ? "equivalent-rebase" : null,
    unstackCommand:
      scenario === "unstack"
        ? {
            type: "task.unstack",
            key,
            taskId: upper,
            expectedVersion: 1,
            materialHash: "d".repeat(64),
          }
        : null,
    cleanupOperations: cleanup ? ["cleanup-upper"] : [],
  };
  const readinessRaw = JSON.stringify(readiness);
  const manifest = {
    version: 1,
    runId: readiness.runId,
    resource: { ...observed, materialSha256: stackMaterialHash(readinessRaw) },
    credentialRef: readiness.host.credentialRef,
    maxWrites: 16,
    runtimeTurns: 2,
    operations,
  };
  const raw = JSON.stringify(manifest),
    grant = {
      version: 1,
      runId: manifest.runId,
      manifestSha256: stackMaterialHash(raw),
      expiresAt: readiness.expiresAt,
      resource: manifest.resource,
      credentialRef: manifest.credentialRef,
      maxWrites: manifest.maxWrites,
      runtimeTurns: manifest.runtimeTurns,
      cleanup,
    };
  let clock = Date.parse(readiness.observedAt),
    factories = 0,
    credentials = 0,
    turns = 0,
    refreshes = 0,
    commands = 0;
  let merged = true,
    platform = true,
    partial = false,
    transportUnknown = false,
    retargeted = false,
    equivalentDone = false,
    completedUnstack = false,
    providerUnstackSent = false;
  const writes: string[] = [],
    runtime = new Map<string, unknown>();
  const workspace = { head, index: "1".repeat(64), files: "2".repeat(64) };
  const proof = {
    version: 1,
    oldBase: "b".repeat(40),
    oldHead: head,
    newBase,
    newHead: rebased,
    pairs: [
      {
        oldCommit: head,
        newCommit: rebased,
        patchId: "3".repeat(40),
        messageSha256: "4".repeat(64),
      },
    ],
  };
  const observation = () => ({
    taskId: upper,
    repositoryNodeId: observed.repositoryNodeId,
    prId: observed.prs[1]!.id,
    head: refreshes && (platform || equivalentDone) ? rebased : head,
    baseRef: refreshes || completedUnstack ? "main" : observed.prs[1]!.base,
    baseSha: refreshes || completedUnstack ? newBase : "b".repeat(40),
    acceptedBaseRef:
      refreshes || completedUnstack ? "main" : observed.prs[1]!.base,
    outsideHead: null,
    workspace,
    proofs: refreshes && (platform || equivalentDone) ? [proof] : [],
    selectedEdgeActive: !completedUnstack,
    restackSequence: completedUnstack ? 1 : 0,
  });
  const receipt = () =>
    commandReceiptSchema.parse({
      kind: "task-unstack",
      key,
      taskId: upper,
      recorded: true,
      expectedVersion: 1,
      materialHash: "d".repeat(64),
      phase: completedUnstack ? "confirmed" : "unstack-attempting",
      revision: completedUnstack ? 5 : 2,
      reason: completedUnstack ? "confirmed" : "readback-required",
    });
  const factory: StackPortFactory = (scope) => {
    factories++;
    const reconcile = async () => {
      if (!providerUnstackSent) throw Error("No original service operation");
      const removal = await scope.providerReadback(
        "unstack",
        async (response) => {
          const read = await response.json();
          // A synthetic aggregate of T3's per-member reads, not a second real-provider verifier.
          return (
            response.ok &&
            read.selected_removed === true &&
            Array.isArray(read.remaining_unmerged) &&
            read.remaining_unmerged.length === 0
          );
        },
      );
      if (removal !== "confirmed") return;
      if (!retargeted) {
        await scope.providerSend("retarget");
      }
      const target = await scope.providerReadback(
        "retarget",
        async (response) =>
          response.ok && (await response.json()).base === "main",
      );
      if (target === "confirmed") completedUnstack = true;
    };
    const ports: StackJourneyPorts = {
      credential: async (reference) => {
        assert.equal(reference, manifest.credentialRef);
        credentials++;
        return secret;
      },
      transport: async (input, init) => {
        assert.equal(
          new Headers(init?.headers).get("Authorization"),
          `Bearer ${secret}`,
        );
        assert.equal(init?.redirect, "error");
        assert.equal(
          new Headers(init?.headers).get("x-github-api-version"),
          "2026-03-10",
        );
        const path = new URL(String(input)).pathname,
          method = init?.method ?? "GET";
        if (method !== "GET") {
          const op = operations.find(
            (op) => op.send.path === path && op.send.method === method,
          );
          assert.ok(op);
          assert.equal(init?.body ?? "", op.send.body);
          writes.push(op.id);
          if (transportUnknown) throw Error("synthetic response lost");
          if (op.id === "retarget") retargeted = true;
          if (op.id === "equivalent-rebase") equivalentDone = true;
          return new Response(
            JSON.stringify(
              op.id === "lower-merge"
                ? {
                    status: "pending",
                    details: { uuid: "synthetic-merge-request" },
                  }
                : {},
            ),
          );
        }
        if (path === merge.readback.path)
          return Response.json({
            node_id: observed.prs[0]!.id,
            number: 1,
            merged,
            head: { ref: observed.prs[0]!.head, sha: "b".repeat(40) },
            base: { ref: "main", repo: { node_id: observed.repositoryNodeId } },
          });
        if (path === unstack.readback.path)
          return Response.json({
            selected_removed: true,
            remaining_unmerged: partial
              ? [{ id: observed.prs[0]!.id, number: observed.prs[0]!.number }]
              : [],
          });
        if (path === retarget.readback.path)
          return Response.json({
            base: retargeted ? "main" : observed.prs[1]!.base,
          });
        return equivalentDone
          ? Response.json({ object: { sha: rebased } })
          : new Response(null, { status: 404 });
      },
      turn: async (taskId, operationId, beforeTurn) => {
        await beforeTurn();
        turns++;
        runtime.set(operationId, {
          taskId,
          operationId,
          threadId: `synthetic-thread-${taskId}`,
          turnId: `synthetic-turn-${turns}`,
        });
      },
      readTurn: async (_taskId, operationId) => runtime.get(operationId),
      observe: async () => observation(),
      restack: async (operationId) => ({
        operationId,
        count: completedUnstack ? 1 : 0,
        newBaseSha: newBase,
      }),
      service: {
        refreshGitHub: async () => {
          refreshes++;
        },
        readUnstack: async () =>
          unstackReadSchema.parse({
            data: {
              taskId: upper,
              readOnly: false,
              failedBlocker: false,
              cancelAvailable: false,
              preview: {
                taskId: upper,
                expectedVersion: 1,
                materialHash: "d".repeat(64),
                repository: observed.repository,
                selectedPr: 2,
                stackNumber: 1,
                targetBase: "main",
                members: [
                  { number: 1, state: "OPEN" },
                  { number: 2, state: "OPEN" },
                ],
              },
              operation: null,
              cancelOperation: null,
              available: true,
              unavailable: null,
            },
            observedAt: clock,
          }),
        execute: async (command) => {
          assert.deepEqual(command, readiness.unstackCommand);
          commands++;
          providerUnstackSent = true;
          await scope.providerSend("unstack");
          await reconcile();
          return receipt();
        },
        reconcileTaskUnstack: async (operationId) => {
          assert.equal(operationId, key);
          await reconcile();
          return {} as Awaited<
            ReturnType<StackJourneyPorts["service"]["reconcileTaskUnstack"]>
          >;
        },
        readOperation: async (query) => {
          assert.equal(query.get("key"), key);
          return operationReadSchema.parse({
            data: { state: "recorded", receipt: receipt() },
            observedAt: clock,
          });
        },
      },
    };
    return ports;
  };
  const resultPath = join(root, "result.json");
  const run = () =>
    runStackComposition({
      manifest: raw,
      grant,
      readiness: readinessRaw,
      resultPath,
      factory,
      now: () => clock,
    });
  return {
    root,
    raw,
    grant,
    readinessRaw,
    readiness,
    manifest,
    resultPath,
    factory,
    run,
    counts: () => ({
      factories,
      credentials,
      turns,
      refreshes,
      commands,
      writes: [...writes],
    }),
    partial: (value = true) => {
      partial = value;
    },
    platform: (value: boolean) => {
      platform = value;
    },
    lost: (value = true) => {
      transportUnknown = value;
    },
    merged: (value: boolean) => {
      merged = value;
    },
    expire: () => {
      clock = Date.parse(readiness.expiresAt);
    },
  };
}

test("composition authority rejects absent/expired/mutated inputs before factory, credential, network, runtime or result creation", async (t) => {
  const f = await fixture(t);
  for (const grant of [
    undefined,
    { ...f.grant, expiresAt: "2000-01-01T00:00:00Z" },
    { ...f.grant, maxWrites: 32 },
  ])
    await assert.rejects(
      runStackComposition({
        manifest: f.raw,
        grant,
        readiness: f.readinessRaw,
        resultPath: f.resultPath,
        factory: f.factory,
        now: () => Date.parse(f.readiness.observedAt),
      }),
    );
  assert.throws(() =>
    authorizeStackComposition(f.raw, f.grant, f.readinessRaw + " ", () =>
      Date.parse(f.readiness.observedAt),
    ),
  );
  assert.deepEqual(f.counts(), {
    factories: 0,
    credentials: 0,
    turns: 0,
    refreshes: 0,
    commands: 0,
    writes: [],
  });
  await assert.rejects(access(f.resultPath));
});

test("merge/adoption composes exact guarded provider material with runtime, actual service method names and preserved workspace digests", async (t) => {
  const f = await fixture(t),
    result = await f.run();
  assert.equal(result.disposition, "recorded");
  assert.equal(result.mode, "offline-injected");
  assert.equal(result.adoption, "verified");
  assert.equal(result.platformRebase, "observed");
  assert.equal(result.mergeRequestId, "synthetic-merge-request");
  assert.deepEqual(f.counts().writes, ["lower-merge"]);
  assert.equal(f.counts().turns, 2);
  const raw = await readFile(f.resultPath, "utf8");
  assert.equal(raw.includes(secret), false);
  assert.equal(raw.includes(f.manifest.operations[0]!.send.body), false);
  assert.equal(
    JSON.parse(raw).effects["provider-lower-merge"].phase,
    "confirmed",
  );
});

test("a lost async merge stays original/readback-only after restart; lack of its observed request ID never fabricates a successful journey", async (t) => {
  const f = await fixture(t);
  f.lost();
  assert.equal((await f.run()).disposition, "held");
  f.lost(false);
  const resumed = await f.run();
  assert.equal(resumed.disposition, "held");
  assert.equal(resumed.mergeRequestId, null);
  assert.deepEqual(f.counts().writes, ["lower-merge"]);
  assert.equal(f.counts().turns, 2);
});

test("pending lower merge survives restart without repeating either runtime or merge; later exact readback continues", async (t) => {
  const f = await fixture(t);
  f.merged(false);
  assert.equal((await f.run()).disposition, "held");
  f.merged(true);
  assert.equal((await f.run()).disposition, "recorded");
  assert.deepEqual(f.counts().writes, ["lower-merge"]);
  assert.equal(f.counts().turns, 2);
});

test("platform non-rebase is reported honestly and fixture-equivalent rebase is used only when separately listed and pinned", async (t) => {
  const plain = await fixture(t);
  plain.platform(false);
  const held = await plain.run();
  assert.equal(held.disposition, "held");
  assert.equal(held.platformRebase, "not-observed");
  assert.deepEqual(plain.counts().writes, ["lower-merge"]);
  const equivalent = await fixture(t, "merge-adoption", true);
  equivalent.platform(false);
  const result = await equivalent.run();
  assert.equal(result.disposition, "recorded");
  assert.equal(result.platformRebase, "not-observed");
  assert.equal(result.adoption, "fixture-equivalent");
  const replay = await equivalent.run();
  assert.equal(replay.platformRebase, "not-observed");
  assert.deepEqual(equivalent.counts().writes, [
    "lower-merge",
    "equivalent-rebase",
  ]);
});

test("D46 partial HTTP200 selected removal with retained sibling stays original across restart: no retarget/restack/cleanup until validated full removal", async (t) => {
  const f = await fixture(t, "unstack");
  f.partial();
  const first = await f.run();
  assert.equal(first.disposition, "held");
  assert.equal((await f.run()).disposition, "held");
  assert.equal(f.counts().commands, 1);
  assert.deepEqual(f.counts().writes, ["unstack"]);
  f.partial(false);
  const final = await f.run();
  assert.equal(final.disposition, "recorded");
  assert.deepEqual(f.counts().writes, ["unstack", "retarget"]);
  assert.equal(f.counts().commands, 1);
});

test("cleanup requires an explicit matching grant and runs only after the scenario is proved", async (t) => {
  const f = await fixture(t, "unstack", false, true);
  f.partial();
  assert.equal((await f.run()).cleanup, "not-requested");
  assert.deepEqual(f.counts().writes, ["unstack"]);
  f.partial(false);
  assert.equal((await f.run()).cleanup, "confirmed");
  assert.deepEqual(f.counts().writes, ["unstack", "retarget", "cleanup-upper"]);
});

test("checkpoint identity/count tampering, ownership locks and expiry fail closed without more effects", async (t) => {
  const f = await fixture(t);
  f.merged(false);
  await f.run();
  const checkpoint = JSON.parse(await readFile(f.resultPath, "utf8"));
  checkpoint.effects["lower-merge"].identity = "0".repeat(64);
  await writeFile(f.resultPath, JSON.stringify(checkpoint));
  await assert.rejects(f.run(), /checkpoint mismatch/);
  assert.deepEqual(f.counts().writes, ["lower-merge"]);
  const locked = await fixture(t);
  await writeFile(`${locked.resultPath}.lock`, "unknown owner");
  await assert.rejects(locked.run());
  assert.equal(locked.counts().factories, 0);
  const expired = await fixture(t);
  expired.expire();
  await assert.rejects(expired.run());
  assert.equal(expired.counts().factories, 0);
});

test("CLI import/default invocation is inert and even well-formed synthetic authority cannot select a missing real adapter", async (t) => {
  const f = await fixture(t),
    entry = await import(
      pathToFileURL(
        resolve("test/delivery/github-qualification/live-stack.mjs"),
      ).href
    );
  await assert.rejects(entry.main([]));
  await assert.rejects(access(f.resultPath));
  const paths = [
    join(f.root, "manifest.json"),
    join(f.root, "grant.json"),
    join(f.root, "readiness.json"),
  ];
  await writeFile(paths[0]!, f.raw);
  await writeFile(paths[1]!, JSON.stringify(f.grant));
  await writeFile(paths[2]!, f.readinessRaw);
  const args = [
    "--live",
    "--manifest",
    paths[0],
    "--grant",
    paths[1],
    "--readiness",
    paths[2],
    "--result",
    f.resultPath,
  ];
  await assert.rejects(
    entry.main(args, { now: () => Date.parse(f.readiness.observedAt) }),
    /Unsupported real stack adapter/,
  );
  assert.equal(f.counts().factories, 0);
  await assert.rejects(access(f.resultPath));
  assert.throws(() => entry.stackArguments([...args, "--live"]));
  assert.throws(() =>
    entry.stackArguments([
      "--live",
      "--manifest",
      paths[0],
      "--grant",
      paths[1],
      "--readiness",
      paths[2],
      "--result",
      paths[0],
    ]),
  );
  const result = await entry.main(args, {
    factory: f.factory,
    now: () => Date.parse(f.readiness.observedAt),
  });
  assert.equal(result.mode, "offline-injected");
  assert.equal(result.disposition, "recorded");
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal("baseline" in result, false);
});

for (const changed of [
  "account",
  "repository",
  "visibility",
  "base",
  "refs",
  "prs",
  "stack",
  "credentialRef",
] as const)
  test(`readiness ${changed} mismatch rejects before injected capabilities or result creation`, async (t) => {
    const f = await fixture(t),
      readiness = JSON.parse(f.readinessRaw);
    if (changed === "credentialRef")
      readiness.host.credentialRef = "env:OTHER_SYNTHETIC";
    else if (changed === "refs")
      readiness.observed.refs[1].sha = "0".repeat(40);
    else if (changed === "prs") readiness.observed.prs[1].number = 99;
    else if (changed === "stack") readiness.observed.stack.reverse();
    else
      readiness.observed[changed] =
        changed === "visibility" ? "public" : "wrong";
    // The fake grant pins the changed receipt too, so this control reaches the cross-identity fence.
    const rawReadiness = JSON.stringify(readiness),
      manifest = {
        ...f.manifest,
        resource: {
          ...f.manifest.resource,
          materialSha256: stackMaterialHash(rawReadiness),
        },
      };
    const raw = JSON.stringify(manifest),
      grant = {
        ...f.grant,
        resource: manifest.resource,
        manifestSha256: stackMaterialHash(raw),
      };
    await assert.rejects(
      runStackComposition({
        manifest: raw,
        grant,
        readiness: rawReadiness,
        resultPath: f.resultPath,
        factory: f.factory,
        now: () => Date.parse(f.readiness.observedAt),
      }),
    );
    assert.equal(f.counts().factories, 0);
    await assert.rejects(access(f.resultPath));
  });

for (const mutation of [
  "method",
  "path",
  "body",
  "writes",
  "turns",
  "cleanup",
] as const)
  test(`composition refuses unsupported ${mutation} material or allowance before ports`, async (t) => {
    const f = await fixture(t),
      manifest = structuredClone(f.manifest);
    if (mutation === "method") manifest.operations[0]!.send.method = "PATCH";
    if (mutation === "path")
      manifest.operations[0]!.send.path =
        "/repos/synthetic/fixture/pulls/2/merge-async";
    if (mutation === "body")
      manifest.operations[0]!.send.body =
        '{"sha":"wrong","merge_method":"squash","bypass_rules":true}';
    if (mutation === "writes") manifest.maxWrites = 1;
    if (mutation === "turns") manifest.runtimeTurns = 1;
    if (mutation === "cleanup") manifest.operations[0]!.cleanup = true;
    const raw = JSON.stringify(manifest),
      grant = {
        ...f.grant,
        manifestSha256: stackMaterialHash(raw),
        maxWrites: manifest.maxWrites,
        runtimeTurns: manifest.runtimeTurns,
      };
    await assert.rejects(
      runStackComposition({
        manifest: raw,
        grant,
        readiness: f.readinessRaw,
        resultPath: f.resultPath,
        factory: f.factory,
        now: () => Date.parse(f.readiness.observedAt),
      }),
    );
    assert.equal(f.counts().factories, 0);
    assert.equal(f.counts().credentials, 0);
  });

test("intent and both counters are durable before credential/transport/runtime effects, and callbacks expire when the composition closes", async (t) => {
  const f = await fixture(t);
  let late: (() => Promise<number>) | undefined;
  const factory: StackPortFactory = (scope) => {
    const ports = f.factory(scope);
    return {
      ...ports,
      credential: async (reference) => {
        const result = JSON.parse(await readFile(f.resultPath, "utf8"));
        const provider = JSON.parse(
          await readFile(`${f.resultPath}.provider`, "utf8"),
        );
        assert.equal(result.effects["provider-lower-merge"].phase, "sent");
        assert.ok(result.writes > 0);
        assert.ok(provider.writes > 0);
        return ports.credential(reference);
      },
      turn: async (taskId, operationId, beforeTurn) => {
        late = beforeTurn;
        return ports.turn(taskId, operationId, async () => {
          const turn = await beforeTurn(),
            result = JSON.parse(await readFile(f.resultPath, "utf8"));
          assert.equal(result.turns, turn);
          return turn;
        });
      },
    };
  };
  await runStackComposition({
    manifest: f.raw,
    grant: f.grant,
    readiness: f.readinessRaw,
    resultPath: f.resultPath,
    factory,
    now: () => Date.parse(f.readiness.observedAt),
  });
  assert.ok(late);
  await assert.rejects(late(), /closed/);
  assert.equal(f.counts().turns, 2);
});

test("runtime reservation crossing expiry consumes its budget without releasing a turn", async (t) => {
  const f = await fixture(t),
    reserve = StackFixtureRunner.prototype.beginRuntimeTurn;
  t.mock.method(
    StackFixtureRunner.prototype,
    "beginRuntimeTurn",
    async function (this: StackFixtureRunner) {
      const permit = await reserve.call(this);
      f.expire();
      return permit;
    },
  );
  await assert.rejects(f.run(), /expired/);
  assert.equal(f.counts().turns, 0);
  assert.deepEqual(f.counts().writes, []);
  const state = JSON.parse(await readFile(f.resultPath, "utf8")),
    provider = JSON.parse(await readFile(`${f.resultPath}.provider`, "utf8"));
  assert.equal(state.turns, 1);
  assert.equal(provider.turns, 1);
});

test("a pending runtime reservation cannot release a turn after the composition closes", async (t) => {
  const f = await fixture(t),
    reserve = StackFixtureRunner.prototype.beginRuntimeTurn;
  let reached!: () => void,
    release!: () => void,
    late: Promise<number> | undefined;
  const reserved = new Promise<void>((resolve) => {
      reached = resolve;
    }),
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
  t.after(() => release());
  t.mock.method(
    StackFixtureRunner.prototype,
    "beginRuntimeTurn",
    async function (this: StackFixtureRunner) {
      const permit = await reserve.call(this);
      reached();
      await blocked;
      return permit;
    },
  );
  const factory: StackPortFactory = (scope) => ({
    ...f.factory(scope),
    turn: async (_task, _operation, beforeTurn) => {
      late = beforeTurn();
      await reserved;
      throw Error("Synthetic runtime continuation ended");
    },
  });
  const result = await runStackComposition({
    manifest: f.raw,
    grant: f.grant,
    readiness: f.readinessRaw,
    resultPath: f.resultPath,
    factory,
    now: () => Date.parse(f.readiness.observedAt),
  });
  assert.equal(result.disposition, "held");
  assert.ok(late);
  const refused = assert.rejects(late, /closed/);
  release();
  await refused;
  assert.equal(f.counts().turns, 0);
  const provider = JSON.parse(
    await readFile(`${f.resultPath}.provider`, "utf8"),
  );
  assert.equal(provider.turns, 1);
});

test("provider credential callback crossing expiry performs no transport and retains the original intent", async (t) => {
  const f = await fixture(t);
  let expired = false;
  const factory: StackPortFactory = (scope) => {
    const ports = f.factory(scope);
    return {
      ...ports,
      credential: async (reference) => {
        const token = await ports.credential(reference);
        f.expire();
        expired = true;
        return token;
      },
    };
  };
  await assert.rejects(
    runStackComposition({
      manifest: f.raw,
      grant: f.grant,
      readiness: f.readinessRaw,
      resultPath: f.resultPath,
      factory,
      now: () => {
        return expired
          ? Date.parse(f.readiness.expiresAt)
          : Date.parse(f.readiness.observedAt);
      },
    }),
  );
  assert.deepEqual(f.counts().writes, []);
  const state = JSON.parse(await readFile(`${f.resultPath}.provider`, "utf8"));
  assert.equal(state.operations["lower-merge"].phase, "intent");
});

test("a local storage fault is surfaced with original intent retained, rather than silently classified as provider refusal", async (t) => {
  const f = await fixture(t, "unstack"),
    factory: StackPortFactory = (scope) => {
      const ports = f.factory(scope);
      return {
        ...ports,
        service: {
          ...ports.service,
          execute: async () => {
            throw Object.assign(Error("synthetic storage"), { code: "EIO" });
          },
        },
      };
    };
  await assert.rejects(
    runStackComposition({
      manifest: f.raw,
      grant: f.grant,
      readiness: f.readinessRaw,
      resultPath: f.resultPath,
      factory,
      now: () => Date.parse(f.readiness.observedAt),
    }),
    { code: "EIO" },
  );
  const checkpoint = JSON.parse(await readFile(f.resultPath, "utf8"));
  assert.equal(checkpoint.effects["operator-unstack"].phase, "sent");
  assert.deepEqual(f.counts().writes, []);
});

test("unresolved atomic-write artifacts are preserved and refuse before port binding", async (t) => {
  const f = await fixture(t);
  await writeFile(
    `${f.resultPath}.provider.tmp`,
    "synthetic unknown checkpoint",
  );
  await assert.rejects(f.run(), /artifact/);
  assert.equal(f.counts().factories, 0);
  assert.equal(
    await readFile(`${f.resultPath}.provider.tmp`, "utf8"),
    "synthetic unknown checkpoint",
  );
});

test("a previous task runtime receipt cannot prove the new immutable runtime intent", async (t) => {
  const f = await fixture(t),
    factory: StackPortFactory = (scope) => {
      const ports = f.factory(scope);
      return {
        ...ports,
        readTurn: async (taskId, operationId) => ({
          taskId,
          operationId: operationId + ":previous",
          threadId: "synthetic-old-thread",
          turnId: "synthetic-old-turn",
        }),
      };
    };
  const result = await runStackComposition({
    manifest: f.raw,
    grant: f.grant,
    readiness: f.readinessRaw,
    resultPath: f.resultPath,
    factory,
    now: () => Date.parse(f.readiness.observedAt),
  });
  assert.equal(result.disposition, "held");
  assert.deepEqual(f.counts().writes, []);
  assert.equal(f.counts().turns, 1);
});

for (const timestamp of [
  "2097-12-31T23:54:00Z",
  "2098-01-01T00:01:00Z",
  "2097-12-31T23:59:59Z",
])
  test(`stale, future or expired separately pinned readiness refuses (${timestamp})`, async (t) => {
    const f = await fixture(t),
      readiness = { ...f.readiness, observedAt: timestamp };
    if (timestamp === "2097-12-31T23:59:59Z") {
      readiness.observedAt = "2097-12-31T23:59:58Z";
      readiness.expiresAt = timestamp;
    }
    const rawReadiness = JSON.stringify(readiness),
      manifest = {
        ...f.manifest,
        resource: {
          ...f.manifest.resource,
          materialSha256: stackMaterialHash(rawReadiness),
        },
      },
      raw = JSON.stringify(manifest);
    await assert.rejects(
      runStackComposition({
        manifest: raw,
        grant: {
          ...f.grant,
          resource: manifest.resource,
          manifestSha256: stackMaterialHash(raw),
        },
        readiness: rawReadiness,
        resultPath: f.resultPath,
        factory: f.factory,
        now: () => Date.parse(f.readiness.observedAt),
      }),
    );
    assert.equal(f.counts().factories, 0);
    assert.equal(f.counts().credentials, 0);
  });

for (const invalid of ["workspace", "outside-head", "missing-proof"] as const)
  test(`adoption ${invalid} refuses successful disposition and cleanup`, async (t) => {
    const f = await fixture(t, "merge-adoption", false, true),
      factory: StackPortFactory = (scope) => {
        const ports = f.factory(scope);
        return {
          ...ports,
          observe: async (taskId) => {
            const value = (await ports.observe(taskId)) as Record<
              string,
              unknown
            >;
            if (f.counts().refreshes) {
              if (invalid === "workspace")
                value.workspace = {
                  head,
                  index: "1".repeat(64),
                  files: "9".repeat(64),
                };
              if (invalid === "outside-head") value.outsideHead = rebased;
              if (invalid === "missing-proof") value.proofs = [];
            }
            return value;
          },
        };
      };
    const result = await runStackComposition({
      manifest: f.raw,
      grant: f.grant,
      readiness: f.readinessRaw,
      resultPath: f.resultPath,
      factory,
      now: () => Date.parse(f.readiness.observedAt),
    });
    assert.equal(result.disposition, "held");
    assert.equal(result.cleanup, "not-requested");
    assert.deepEqual(f.counts().writes, ["lower-merge"]);
  });
