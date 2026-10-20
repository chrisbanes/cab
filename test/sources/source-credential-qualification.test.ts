import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { Runtime } from "../../src/standalone/codex.js";
import {
  OperatorApi,
  OperatorApiError,
} from "../../src/standalone/operator-api.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { createFakeGh, fakeGhToken } from "../fixtures/fake-gh.js";
import { tmpdir } from "../fixtures/temp.js";

const harness = await import(
  new URL(
    "../../../test/sources/credential-qualification/live-source-credential.mjs",
    import.meta.url,
  ).href
);
const metadata = {
  candidateSha: "a".repeat(40),
  projectNodeId: "PVT_944",
  filter:
    "is:issue repo:org/repo label:ready-for-agent status:Ready priority:P2",
  issue: {
    nodeId: "I_944",
    repositoryId: "R_944",
    repositoryName: "org/repo",
    number: 944,
    labels: ["ready-for-agent"],
  },
  returnedCount: 1,
  returnedIssueIds: ["I_944"],
  hasNextPage: false,
  readinessLabel: "ready-for-agent",
};

async function fixture(t: TestContext, missing = false) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-944-qualification-")),
  );
  const gh = createFakeGh();
  let turns = 0,
    writes = 0,
    reads = 0;
  const runtime = {
    async start() {},
    async stop() {},
    async startThread() {
      turns++;
      throw new Error("model forbidden");
    },
    async resumeThread() {
      turns++;
      throw new Error("model forbidden");
    },
    async interruptTurn() {},
    async startTurn() {
      turns++;
      throw new Error("model forbidden");
    },
    async waitForTurn() {
      throw new Error("model forbidden");
    },
    onUnexpectedRequest() {},
  } as Runtime;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    const method = init?.method ?? "GET";
    if (method === "POST") {
      const query = JSON.parse(String(init?.body));
      if (
        url.pathname !== "/graphql" ||
        !String(query.query).startsWith("query EnsembleProjectPage(")
      ) {
        writes++;
        throw new Error("provider mutation forbidden");
      }
      assert.equal(query.variables.id, metadata.projectNodeId);
      assert.equal(query.variables.query, metadata.filter);
      assert.equal(query.variables.after, null);
      reads++;
      const pageInfo = { hasNextPage: false, endCursor: null };
      return Response.json({
        data: {
          node: {
            id: metadata.projectNodeId,
            fields: { nodes: [], pageInfo },
            items: {
              nodes: [
                {
                  id: "ITEM_944",
                  content: {
                    __typename: "Issue",
                    id: "I_944",
                    number: 944,
                    title: "Private issue title",
                    body: "Private issue contents",
                    state: "OPEN",
                    repository: { id: "R_944", nameWithOwner: "org/repo" },
                    labels: { nodes: [{ name: "ready-for-agent" }], pageInfo },
                  },
                  fieldValues: { nodes: [], pageInfo },
                },
              ],
              pageInfo,
            },
          },
        },
      });
    }
    if (method !== "GET") {
      writes++;
      throw new Error("provider mutation forbidden");
    }
    reads++;
    if (url.pathname.endsWith("/dependencies/blocked_by"))
      return Response.json([]);
    if (url.pathname === "/repos/org/repo")
      return Response.json({ node_id: "R_944", full_name: "org/repo" });
    if (url.pathname === "/repos/org/repo/issues/944")
      return Response.json({
        node_id: "I_944",
        number: 944,
        title: "Private issue title",
        body: "Private issue contents",
        state: "closed",
        repository_url: "https://api.github.com/repos/org/repo",
        labels: [{ name: "ready-for-agent" }],
      });
    throw new Error("unexpected provider read");
  };
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    {
      power: { enabled: false },
      routingClient: null,
      ghExecutable: missing ? gh.missing : gh.executable,
      github: { intervalMs: 60_000 },
    },
  );
  t.after(async () => {
    await service.stop();
    globalThis.fetch = previousFetch;
    gh.close();
    rmSync(root, { recursive: true, force: true });
    assert.equal(turns, 0);
    assert.equal(writes, 0);
  });
  await service.start();
  const api = new OperatorApi(service),
    domain = service.domain(),
    sources = service.githubSources();
  const transport = {
    command: (command: Parameters<OperatorApi["execute"]>[0]) =>
      api.execute(command),
    configuration: async (id: string) =>
      (await api.readProjectConfiguration(id)).data,
    refresh: () => service.refreshGitHub(),
    observations: async () => (await api.readSourceObservations()).data,
    importedCount: async (id: string) => domain.tasks(id).length,
    imported: async (id: string) => {
      const issue = sources.issue(id);
      if (!issue) return undefined;
      const task = domain.task(String(issue.taskId));
      return {
        projectId: task.projectId,
        repositoryId: issue.repositoryId,
        issueNumber: Number(issue.issueNumber),
        ready: Boolean(task.ready),
      };
    },
  };
  return {
    root,
    gh,
    service,
    api,
    domain,
    sources,
    transport,
    reads: () => reads,
  };
}

test("qualification separates preview activation/import and retains replay/Clear/history/recovery in production SQLite", async (t) => {
  const f = await fixture(t);
  const result = await harness.qualifySource(
    f.transport,
    harness.validateMetadata(metadata),
    { lostPreviewReply: true },
  );
  assert.equal(f.domain.discoveryCredentialReference(), null);
  assert.equal(
    f.sources.memberships("I_944")[0]?.selectionId,
    result.selectionId,
  );
  const taskId = String(f.sources.issue("I_944")?.taskId);
  assert.equal(f.domain.task(taskId).importedBlockers, "clear");
  const localId = randomUUID();
  f.domain.execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId: result.projectId,
    taskId: localId,
    title: "Dependent",
    outcome: "Wait",
    ready: false,
  });
  f.domain.execute({
    type: "dependency.add",
    key: randomUUID(),
    actor: "operator",
    projectId: result.projectId,
    taskId: localId,
    blockerTaskId: taskId,
    expectedVersion: 1,
  });
  await f.service.refreshGitHub();
  assert.equal(
    f.domain.admission(localId).reasons.includes("local-dependency"),
    false,
  );
  await f.api.execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: result.projectId,
    expectedVersion: 2,
    credentialRef: null,
    selections: [{ id: result.selectionId, keep: true }],
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", name: "ready-for-agent" }],
    },
    repositories: [],
  });
  await f.api.readSourceObservations();
  assert.equal(f.domain.task(taskId).importedBlockers, "unknown");
  assert.ok(f.domain.admission(localId).reasons.includes("local-dependency"));
  assert.ok(f.sources.issue("I_944"));
  assert.deepEqual(await f.api.execute(result.preview), result.activated);
  const previous = process.env.ENSEMBLE_944_RECOVERY;
  process.env.ENSEMBLE_944_RECOVERY = "offline-recovery-canary";
  t.after(() => {
    if (previous === undefined) delete process.env.ENSEMBLE_944_RECOVERY;
    else process.env.ENSEMBLE_944_RECOVERY = previous;
  });
  await f.api.execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: result.projectId,
    expectedVersion: 3,
    credentialRef: "env:ENSEMBLE_944_RECOVERY",
    selections: [{ id: result.selectionId, keep: true }],
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", name: "ready-for-agent" }],
    },
    repositories: [],
  });
  await assert.rejects(
    f.api.execute({ ...result.preview, key: randomUUID() }),
    /conflict|Conflict/,
  );
  await f.api.execute({
    ...result.preview,
    key: randomUUID(),
    expectedVersion: 4,
  });
  await f.service.refreshGitHub();
  assert.equal(f.domain.task(taskId).importedBlockers, "clear");
  await assert.rejects(
    f.api.execute({
      type: "github.configure",
      key: randomUUID(),
      projectId: result.projectId,
      expectedVersion: 4,
      credentialRef: "gh:enterprise.example",
      selections: [{ id: result.selectionId, keep: true }],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", name: "ready-for-agent" }],
      },
      repositories: [],
    }),
  );
  assert.equal(
    f.domain.githubConfiguration(result.projectId).credentialRef,
    "env:ENSEMBLE_944_RECOVERY",
  );
  const safe = JSON.stringify({
    source: await f.api.readProjectConfiguration(result.projectId),
    observations: await f.api.readSourceObservations(),
    summary: result.imported,
  });
  for (const privateValue of [
    fakeGhToken,
    "Private issue contents",
    "ENSEMBLE_944_RECOVERY",
    "offline-recovery-canary",
  ])
    assert.ok(!safe.includes(privateValue));
  await f.service.stop();
  await f.service.start();
  assert.equal(
    f.service.domain().githubConfiguration(result.projectId).credentialRef,
    "env:ENSEMBLE_944_RECOVERY",
  );
  assert.ok(f.service.githubSources().issue("I_944"));
});

for (const failure of [
  "not-signed-in",
  "unreadable",
  "missing",
  "hang",
] as const)
  test(`qualification ${failure} refuses preview without activation/provider reads`, async (t) => {
    const f = await fixture(t, failure === "missing");
    if (failure !== "missing") f.gh.set(failure);
    const projectId = randomUUID();
    f.domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Failure",
      leadProfileId: null,
    });
    f.domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: "gh:github.com",
      selections: [
        {
          id: "one",
          kind: "project",
          projectNodeId: metadata.projectNodeId,
          filter: metadata.filter,
        },
      ],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", name: "ready-for-agent" }],
      },
      repositories: [],
    });
    await assert.rejects(
      f.api.execute({
        type: "github.preview",
        key: randomUUID(),
        projectId,
        expectedVersion: 2,
        selectionId: "one",
      }),
      (error: unknown) =>
        error instanceof OperatorApiError &&
        error.credentialReason ===
          (failure === "missing"
            ? "gh-not-installed"
            : failure === "hang"
              ? "gh-unreadable"
              : `gh-${failure}`),
    );
    assert.deepEqual(f.domain.githubActiveSelectionIds(projectId), []);
    assert.equal(f.domain.tasks(projectId).length, 0);
    assert.equal(f.reads(), 0);
  });

test("prepare-only cannot launch; exact consumed record/callback binds one bootstrap and immutable artifacts", async (t) => {
  const parent = realpathSync(
      mkdtempSync(join(tmpdir(), "ensemble-944-prepared-")),
    ),
    root = join(parent, "one-attempt");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  let linted = "",
    callbacks = 0,
    bootstraps = 0;
  const prepared = await harness.prepareOnly(
    {
      root,
      label: "com.example.ensemble944.offline",
      nodePath: realpathSync(process.execPath),
      cliPath: realpathSync(join(process.cwd(), "dist/src/standalone/cli.js")),
      port: 18744,
      metadata,
    },
    {
      lint: async (path: string) => {
        linted = path;
      },
    },
  );
  assert.ok(linted.endsWith("com.example.ensemble944.offline.plist"));
  const manifest = JSON.parse(readFileSync(prepared.manifest, "utf8"));
  const password = readFileSync(manifest.passwordFile, "utf8");
  assert.ok(!readFileSync(prepared.manifest, "utf8").includes(password));
  assert.ok(!readFileSync(linted, "utf8").includes(password));
  assert.equal(existsSync(join(root, "attempt-started")), false);
  const consumed = join(parent, "root-consumed.json");
  const record = {
    consumed: true,
    attempt: 1,
    maxSeconds: 300,
    maxModelTurns: 0,
    maxGitHubWrites: 0,
    root,
    manifest: prepared.manifest,
    label: prepared.label,
    candidateSha: prepared.candidateSha,
    manifestDigest: prepared.manifestDigest,
  };
  writeFileSync(
    consumed,
    JSON.stringify({ ...record, candidateSha: "b".repeat(40) }),
    { mode: 0o600 },
  );
  await assert.rejects(
    harness.bootstrapPrepared(
      prepared.manifest,
      consumed,
      async () => {
        callbacks++;
      },
      async () => {
        bootstraps++;
      },
    ),
  );
  assert.equal(callbacks, 0);
  assert.equal(bootstraps, 0);
  writeFileSync(consumed, JSON.stringify(record));
  await assert.rejects(
    harness.bootstrapPrepared(
      prepared.manifest,
      consumed,
      async () => {
        throw new Error("root boundary rejected");
      },
      async () => {
        bootstraps++;
      },
    ),
  );
  assert.equal(bootstraps, 0);
  await harness.bootstrapPrepared(
    prepared.manifest,
    consumed,
    async () => {
      callbacks++;
    },
    async () => {
      bootstraps++;
    },
  );
  assert.equal(callbacks, 1);
  assert.equal(bootstraps, 1);
  await assert.rejects(
    harness.bootstrapPrepared(
      prepared.manifest,
      consumed,
      async () => {},
      async () => {
        bootstraps++;
      },
    ),
  );
  assert.equal(bootstraps, 1);
  writeFileSync(linted, `${readFileSync(linted, "utf8")}\nchanged`);
  assert.throws(() => harness.verifyPrepared(prepared.manifest, consumed));
});

test("qualification metadata refuses broad/truncated/mismatched selections before preparation", () => {
  for (const patch of [
    { hasNextPage: true },
    { returnedCount: 2 },
    { returnedIssueIds: ["another"] },
    { filter: "is:issue" },
    { filter: `${metadata.filter} OR *` },
    { readinessLabel: "another" },
  ])
    assert.throws(() => harness.validateMetadata({ ...metadata, ...patch }));
});

test("outer deadline reserves cleanup and unknown process ownership never deletes state", async () => {
  let now = 0,
    removed = 0,
    stopped = 0;
  const budget = harness.deadlineBudget(300, () => now);
  assert.equal(budget.timeout(90_000), 90_000);
  now = 270_000;
  assert.throws(() => budget.timeout(1000), /qualification-deadline/);
  const unknown = await harness.cleanupOwnedJob(
    {
      bootout: async () => {
        stopped++;
      },
      inspect: async () => ({
        ownershipUnknown: true,
        labelAbsent: false,
        pidExited: false,
        portClosed: false,
      }),
      remove: async () => {
        removed++;
      },
    },
    budget,
  );
  assert.equal(unknown.disposition, "retained-ownership-unknown");
  assert.equal(removed, 0);
  const absent = await harness.cleanupOwnedJob(
    {
      bootout: async () => {
        stopped++;
      },
      inspect: async () => ({
        ownershipUnknown: false,
        ownershipProven: true,
        labelAbsent: true,
        pidExited: true,
        portClosed: true,
      }),
      remove: async () => {
        removed++;
      },
    },
    budget,
  );
  assert.equal(absent.disposition, "removed");
  assert.equal(removed, 1);
  assert.equal(
    stopped,
    0,
    "unknown and already absent jobs receive no bootout",
  );
  const late = await harness.cleanupOwnedJob(
    {
      bootout: async () => {},
      inspect: async () => ({ labelAbsent: false, ownershipProven: true }),
      remove: async () => {
        removed++;
      },
      pause: async () => {
        now = 300_000;
      },
    },
    budget,
  );
  assert.equal(late.disposition, "retained-deadline");
  assert.equal(removed, 1);
});

test("qualification missing source reference refuses preview without fallback or sync row", async (t) => {
  const f = await fixture(t);
  const projectId = randomUUID();
  f.domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "No source credential",
    leadProfileId: null,
  });
  f.domain.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    selections: [
      {
        id: "one",
        kind: "project",
        projectNodeId: metadata.projectNodeId,
        filter: metadata.filter,
      },
    ],
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", name: "ready-for-agent" }],
    },
    repositories: [],
  });
  await assert.rejects(
    f.api.execute({
      type: "github.preview",
      key: randomUUID(),
      projectId,
      expectedVersion: 2,
      selectionId: "one",
    }),
    (error: unknown) =>
      error instanceof OperatorApiError &&
      error.credentialReason === "missing-credential",
  );
  assert.deepEqual(f.domain.githubActiveSelectionIds(projectId), []);
  assert.equal(f.sources.syncState(projectId, "one"), undefined);
  assert.equal(f.reads(), 0);
});

test("owned terminal logs are checked before deletion and credential matches retain only safe failure metadata", async (t) => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-944-owned-logs-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stdout = join(root, "stdout.log"),
    stderr = join(root, "stderr.log");
  writeFileSync(stdout, "service started\n", { mode: 0o600 });
  writeFileSync(stderr, "fixed diagnostic\n", { mode: 0o600 });
  assert.deepEqual(harness.inspectPrivateLogs([stdout, stderr]), {
    safe: true,
    inspectedFiles: 2,
  });
  let removed = 0,
    inspected = 0;
  const operations = {
    bootout: async () => {},
    inspect: async () => ({
      labelAbsent: true,
      pidExited: true,
      portClosed: true,
      ownershipProven: true,
    }),
    verifyLogs: async () => {
      inspected++;
      return harness.inspectPrivateLogs([stdout, stderr]);
    },
    remove: async () => {
      removed++;
    },
  };
  for (const token of [
    fakeGhToken,
    `ghp_${"a".repeat(24)}`,
    `github_pat_${"b".repeat(24)}`,
  ]) {
    writeFileSync(stderr, token);
    const retained = await harness.cleanupOwnedJob(
      operations,
      harness.deadlineBudget(),
    );
    assert.equal(retained.disposition, "retained-log-inspection-failed");
    assert.equal(retained.reason, "credential-pattern");
    assert.ok(!JSON.stringify(retained).includes(token));
    assert.equal(removed, 0);
    assert.ok(existsSync(root));
  }
  const before = inspected;
  await harness.cleanupOwnedJob(
    {
      ...operations,
      inspect: async () => ({
        labelAbsent: false,
        pidExited: false,
        portClosed: false,
        ownershipUnknown: true,
      }),
    },
    harness.deadlineBudget(),
  );
  assert.equal(
    inspected,
    before,
    "no log read until terminal ownership/absence proof",
  );
  writeFileSync(stderr, "fixed diagnostic\n");
  const cleaned = await harness.cleanupOwnedJob(
    operations,
    harness.deadlineBudget(),
  );
  assert.equal(cleaned.disposition, "removed");
  assert.deepEqual(cleaned.logInspection, { safe: true, inspectedFiles: 2 });
  assert.equal(removed, 1);
});

test("failed or ambiguous bootstrap never stops a foreign/unknown job; only exact owned reconciliation permits bootout", async () => {
  const prepared = {
    plist: "/private/tmp/qualification944/launch-agents/com.example944.plist",
    configuration: {
      nodePath: "/offline/node",
      cliPath: "/offline/dist/src/standalone/cli.js",
      dataDirectory: "/private/tmp/qualification944/data",
      port: 18744,
    },
  };
  const args = [
    prepared.configuration.nodePath,
    prepared.configuration.cliPath,
    "operator",
    prepared.configuration.dataDirectory,
    String(prepared.configuration.port),
  ];
  const printed = (path = prepared.plist) =>
    `gui/501/com.example944 = {\n path = ${path}\n program = ${args[0]}\n arguments = {\n${args.map((arg) => `  ${arg}`).join("\n")}\n }\n pid = 9440\n}`;
  for (const scenario of [
    "failed-bootstrap-foreign-label",
    "ambiguous-bootstrap-unknown",
    "matching-plist-foreign-command",
  ] as const) {
    let bootouts = 0,
      removed = 0;
    const known = { owned: false, pid: undefined };
    const observed = {
      print: async () => {
        if (scenario === "ambiguous-bootstrap-unknown")
          throw new Error("unknown bootstrap");
        return {
          labelAbsent: false,
          stdout: printed(
            scenario === "failed-bootstrap-foreign-label"
              ? "/foreign/job.plist"
              : prepared.plist,
          ),
        };
      },
      commandLine: async () => "foreign process",
      pidAlive: async () => true,
      portClosed: async () => false,
    };
    const result = await harness.cleanupOwnedJob(
      {
        bootout: async () => {
          bootouts++;
        },
        inspect: () => harness.reconcileJobOwnership(prepared, observed, known),
        remove: async () => {
          removed++;
        },
      },
      harness.deadlineBudget(),
    );
    assert.equal(result.disposition, "retained-ownership-unknown", scenario);
    assert.equal(bootouts, 0, scenario);
    assert.equal(removed, 0, scenario);
  }
  let stopped = false,
    bootouts = 0,
    removed = 0;
  const known = { owned: false, pid: undefined };
  const observed = {
    print: async () =>
      stopped
        ? { labelAbsent: true }
        : { labelAbsent: false, stdout: printed() },
    commandLine: async () => args.join(" "),
    pidAlive: async () => !stopped,
    portClosed: async () => stopped,
  };
  const result = await harness.cleanupOwnedJob(
    {
      bootout: async () => {
        assert.equal(
          known.owned,
          true,
          "proof precedes stop even without startup PID capture",
        );
        bootouts++;
        stopped = true;
      },
      inspect: () => harness.reconcileJobOwnership(prepared, observed, known),
      remove: async () => {
        removed++;
      },
      pause: async () => {},
    },
    harness.deadlineBudget(),
  );
  assert.equal(result.disposition, "removed");
  assert.equal(bootouts, 1);
  assert.equal(removed, 1);
  assert.equal(known.pid, 9440);
  assert.equal(
    harness.ownedJobMetadata(
      prepared,
      printed().replace(prepared.configuration.dataDirectory, "/foreign/data"),
    ),
    null,
  );
});
