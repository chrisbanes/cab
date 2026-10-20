import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { childProcessEnvironment } from "../../src/core/child-environment.js";
import type { Runtime } from "../../src/standalone/codex.js";
import type {
  GitHubSourceReader,
  SelectionSnapshot,
} from "../../src/standalone/github-source.js";
import { sourceCredentialExplanation } from "../../src/standalone/github-source-credential.js";
import { LocalOperatorUi } from "../../src/standalone/operator.js";
import {
  OperatorApi,
  OperatorApiError,
} from "../../src/standalone/operator-api.js";
import {
  type RuntimeSpawnContext,
  StandaloneService,
} from "../../src/standalone/service.js";
import { createFakeGh, fakeGhToken } from "../fixtures/fake-gh.js";
import { startCliService } from "../fixtures/operator-cli.js";
import { tmpdir } from "../fixtures/temp.js";

const selection = {
  id: "S-1",
  kind: "repository" as const,
  repositoryId: "R_1",
  owner: "org",
  name: "repo",
};
const readiness = {
  mode: "any" as const,
  conditions: [{ kind: "label" as const, name: "ready" }],
};
const reference = {
  nodeId: "I_1",
  repositoryId: "R_1",
  repositoryName: "org/repo",
  number: 1,
};

async function fixture(t: TestContext) {
  const gh = createFakeGh();
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-source-credential-")),
  );
  const contexts: RuntimeSpawnContext[] = [];
  const spawns: NodeJS.ProcessEnv[] = [];
  let turns = 0;
  const runtime = (): Runtime => ({
    async start() {},
    async stop() {},
    async startThread() {
      throw new Error("model thread forbidden");
    },
    async resumeThread() {
      throw new Error("model thread forbidden");
    },
    async startTurn() {
      turns++;
      throw new Error("model turn forbidden");
    },
    async interruptTurn() {},
    async waitForTurn() {
      throw new Error("model turn forbidden");
    },
    onUnexpectedRequest() {},
  });
  const service = new StandaloneService(
    join(root, "data"),
    (context) => {
      contexts.push(context);
      spawns.push(context.spawnEnvironment());
      return runtime();
    },
    undefined,
    {
      runtimeHarnesses: ["codex", "claude"],
      power: { enabled: false },
      routingClient: null,
      ghExecutable: gh.executable,
      github: { intervalMs: 60_000 },
    },
  );
  t.after(async () => {
    await service.stop().catch(() => {});
    gh.close();
    rmSync(root, { recursive: true, force: true });
    assert.equal(turns, 0);
  });
  const execute = (command: object) =>
    service
      .domain()
      .execute({ actor: "operator", key: randomUUID(), ...command } as never);
  await service.start();
  const projectId = randomUUID();
  execute({
    type: "project.create",
    projectId,
    name: "Source",
    leadProfileId: null,
  });
  const configure = (credentialRef: string | null) =>
    execute({
      type: "github.configure",
      projectId,
      expectedVersion: service.domain().githubConfiguration(projectId).version,
      credentialRef,
      selections: [selection],
      readiness,
      repositories: [],
    });
  const api = new OperatorApi(service);
  const ui = new LocalOperatorUi(
    service.domain(),
    (ref) => service.gitHubSourceReader(ref),
    service.githubSources(),
    () => service.refreshGitHub(),
    (id) => service.gitHubSourceCredentialStatus(id),
  );
  return {
    gh,
    root,
    service,
    execute,
    configure,
    api,
    ui,
    projectId,
    contexts,
    spawns,
  };
}

function environment(
  t: TestContext,
  values: Record<string, string | undefined>,
) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

for (const source of ["gh:github.com", "env:FIXTURE_SX_SOURCE"])
  for (const discovery of [null, "env:FIXTURE_SX_DISCOVERY"])
    test(`${source.split(":")[0]} source excludes runtimes/helpers/public and captured values with discovery ${discovery ? "different" : "unset"}`, async (t) => {
      const value = source.startsWith("gh:")
        ? "source-gh-environment"
        : "source-env-value";
      const name = source.startsWith("gh:") ? "GH_TOKEN" : "FIXTURE_SX_SOURCE";
      environment(t, {
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
        FIXTURE_SX_SOURCE: undefined,
        [name]: value,
        FIXTURE_SX_ALIAS: value,
        FIXTURE_SX_RESOLVED_ALIAS: fakeGhToken,
        FIXTURE_SX_CLAUDE: "claude-source-canary",
        FIXTURE_SX_DISCOVERY: "different-discovery-value",
      });
      const f = await fixture(t);
      if (discovery)
        f.execute({ type: "discovery.configure", credentialRef: discovery });
      f.configure(source);
      f.execute({
        type: "claude-token.configure",
        credentialRef: "env:FIXTURE_SX_CLAUDE",
      });
      await f.service.stop();
      await f.service.start();
      const hidden = [
        value,
        ...(source.startsWith("gh:") ? [fakeGhToken] : []),
      ];
      const clean = (env: NodeJS.ProcessEnv) => {
        assert.equal(env[name], undefined);
        assert.equal(env.FIXTURE_SX_ALIAS, undefined);
        for (const token of hidden)
          assert.equal(JSON.stringify(env).includes(token), false);
      };
      clean(f.spawns.at(-1) ?? {});
      const context = f.contexts.at(-1);
      assert.ok(context?.claude);
      const envTurn = context.claude.turnEnvironment();
      assert.ok("env" in envTurn);
      clean(envTurn.env);
      chmodSync(f.root, 0o700);
      writeFileSync(join(f.root, "claude"), "claude-file-source-canary\n", {
        mode: 0o600,
      });
      f.execute({
        type: "claude-token.configure",
        credentialRef: `file:${join(f.root, "claude")}`,
      });
      const fileTurn = context.claude.turnEnvironment();
      assert.ok("env" in fileTurn);
      clean(fileTurn.env);
      clean(childProcessEnvironment());
      const profileId = randomUUID(),
        taskId = randomUUID(),
        assignmentId = randomUUID();
      f.execute({
        type: "profile.create",
        profileId,
        name: "Capture",
        instructions: "Capture instructions",
        capabilities: "",
      });
      f.execute({
        type: "task.create",
        projectId: f.projectId,
        taskId,
        title: `Private ${value}`,
        outcome: "Source",
        ready: false,
      });
      f.execute({
        type: "routing.configure",
        projectId: f.projectId,
        expectedVersion: 1,
        enabled: false,
        candidateProfileIds: [profileId],
        guidance: "",
        credentialRef: null,
      });
      f.execute({
        type: "assignment.create",
        projectId: f.projectId,
        taskId,
        assignmentId,
        profileId,
        brief: "Capture",
        resultDestination: "parent",
        requesterAssignmentId: null,
      });
      const capture = (
        f.service as unknown as {
          conversationExclusionsForAssignment(
            taskId: string,
            assignmentId: string,
          ): readonly string[] | undefined;
        }
      ).conversationExclusionsForAssignment(taskId, assignmentId);
      assert.ok(capture?.includes(value));
      if (source.startsWith("env:")) assert.ok(capture?.includes(name));
      if (source.startsWith("gh:")) assert.ok(capture?.includes(fakeGhToken));
      const publicReads = JSON.stringify([
        await f.api.readProjectConfiguration(f.projectId),
        await f.api.readReview(taskId),
        await f.api.readSourceObservations(),
      ]);
      for (const token of hidden)
        assert.equal(publicReads.includes(token), false);
      assert.equal(publicReads.includes("FIXTURE_SX_SOURCE"), false);
      if (source.startsWith("env:")) {
        f.configure(null);
        const clearedReads = JSON.stringify(await f.api.readReview(taskId));
        assert.equal(
          clearedReads.includes(value),
          false,
          "Clear preserves credential privacy in task history",
        );
      }
      if (source.startsWith("gh:")) {
        for (let i = 0; i < 10; i++) {
          f.gh.setToken(`source-old-${i}`);
          await f.service.gitHubSourceCredentialStatus(f.projectId);
        }
        process.env.FIXTURE_SX_OLD_NEUTRAL = "source-old-0";
        t.after(() => delete process.env.FIXTURE_SX_OLD_NEUTRAL);
        f.configure(null);
        assert.equal(
          childProcessEnvironment().FIXTURE_SX_OLD_NEUTRAL,
          undefined,
        );
        assert.ok(
          f.service
            .gitHubCredentialExclusions()
            .redactions.includes("source-old-0"),
        );
      }
    });

test("source-only production factory previews, imports, fails closed and recovers under keyed/versioned boundaries", async (t) => {
  environment(t, { GH_TOKEN: undefined, GITHUB_TOKEN: undefined });
  const f = await fixture(t);
  const previousFetch = globalThis.fetch;
  const requests: string[] = [],
    headers: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.ok(url.startsWith("https://api.github.com/"));
    assert.equal(init?.method, "GET");
    requests.push(url);
    headers.push(new Headers(init?.headers).get("authorization") ?? "");
    if (url.endsWith("/repos/org/repo"))
      return Response.json({ node_id: "R_1", full_name: "org/repo" });
    if (url.includes("dependencies/blocked_by")) return Response.json([]);
    if (url.endsWith("/issues/1"))
      return Response.json({
        node_id: "I_1",
        number: 1,
        title: "Source issue",
        body: "Scope",
        state: "closed",
        repository_url: "https://api.github.com/repos/org/repo",
        labels: [{ name: "ready" }],
      });
    return Response.json([
      {
        node_id: "I_1",
        number: 1,
        title: "Source issue",
        body: "Scope",
        state: "open",
        repository_url: "https://api.github.com/repos/org/repo",
        labels: [{ name: "ready" }],
      },
    ]);
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const missing = await f.api.readSourceObservations();
  assert.equal(missing.data.projects[0]?.selections.length, 0);
  f.configure(null);
  const blocked = (await f.api.readSourceObservations()).data.projects[0]
    ?.selections[0];
  assert.equal(blocked?.credentialReason, "missing-credential");
  assert.equal(blocked?.lastAttemptAt, null);
  assert.equal(blocked?.lastSuccessfulAt, null);
  const missingKey = randomUUID();
  await assert.rejects(
    f.api.execute({
      type: "github.preview",
      projectId: f.projectId,
      expectedVersion: 2,
      selectionId: "S-1",
      key: missingKey,
    }),
    (error: unknown) =>
      error instanceof OperatorApiError &&
      error.credentialReason === "missing-credential",
  );
  await assert.rejects(
    f.ui.submit({
      type: "github.preview",
      projectId: f.projectId,
      expectedVersion: "2",
      selectionId: "S-1",
      key: missingKey,
    }),
    { message: sourceCredentialExplanation("missing-credential") },
  );
  assert.equal(requests.length, 0);
  assert.match(
    await f.ui.projectWithCredentialStatus(f.projectId),
    /href="#github-source-credential"/,
  );
  f.configure("gh:github.com");
  const key = randomUUID(),
    expectedVersion = 3;
  const preview = {
    type: "github.preview" as const,
    projectId: f.projectId,
    expectedVersion,
    selectionId: "S-1",
    key,
  };
  const receipt = await f.api.execute(preview);
  assert.deepEqual(f.service.domain().githubActiveSelectionIds(f.projectId), [
    "S-1",
  ]);
  assert.equal(
    f.service.domain().tasks(f.projectId).length,
    0,
    "preview does not import",
  );
  await f.service.refreshGitHub();
  const imported = f.service.githubSources().issue("I_1");
  assert.ok(imported);
  const taskId = String(imported.taskId);
  assert.equal(f.service.domain().task(taskId).importedBlockers, "clear");
  const localId = randomUUID();
  f.execute({
    type: "task.create",
    projectId: f.projectId,
    taskId: localId,
    title: "Local dependent",
    outcome: "Wait",
    ready: false,
  });
  f.execute({
    type: "dependency.add",
    projectId: f.projectId,
    taskId: localId,
    blockerTaskId: taskId,
    expectedVersion: 1,
  });
  await f.service.refreshGitHub();
  assert.equal(
    f.service.domain().admission(localId).reasons.includes("local-dependency"),
    false,
  );
  assert.equal(
    headers.every((h) => h === `Bearer ${fakeGhToken}`),
    true,
  );
  const cached = f.service.gitHubSourceReader("gh:github.com");
  f.gh.setToken("new-source-token");
  const before = headers.length;
  assert.equal((await cached.readIssueStatus(reference)).status, "closed");
  assert.ok(
    headers.slice(before).every((h) => h === "Bearer new-source-token"),
  );
  f.gh.set("not-signed-in");
  const attemptBeforeFailure = f.service
    .githubSources()
    .syncState(f.projectId, "S-1")?.refreshedAt;
  assert.deepEqual(await f.api.execute(preview), receipt);
  await f.ui.submit({ ...preview, expectedVersion: String(expectedVersion) });
  assert.equal(
    f.service.domain().task(taskId).importedBlockers,
    "clear",
    "recorded replay does not probe or invalidate",
  );
  await assert.rejects(
    f.ui.submit({
      ...preview,
      key: randomUUID(),
      expectedVersion: String(expectedVersion),
    }),
    { message: sourceCredentialExplanation("gh-not-signed-in") },
  );
  assert.equal(
    f.service.domain().task(taskId).importedBlockers,
    "unknown",
    "failed active HTML preview invalidates stale admission",
  );
  assert.equal(
    f.service.githubSources().syncState(f.projectId, "S-1")?.refreshedAt,
    attemptBeforeFailure,
  );
  const unknownVersion = f.service.domain().task(taskId).version;
  const unknownLocalVersion = f.service.domain().task(localId).version;
  await assert.rejects(
    f.api.execute({ ...preview, key: randomUUID() }),
    (error: unknown) =>
      error instanceof OperatorApiError &&
      error.credentialReason === "gh-not-signed-in",
  );
  assert.equal(f.service.domain().task(taskId).version, unknownVersion);
  assert.equal(f.service.domain().task(localId).version, unknownLocalVersion);
  f.gh.set("signed-in");
  assert.equal(
    (await f.service.gitHubSourceCredentialStatus(f.projectId)).usable,
    true,
  );
  assert.equal(
    f.service.domain().task(taskId).importedBlockers,
    "unknown",
    "successful status restores no provider knowledge",
  );
  await f.service.refreshGitHub();
  assert.equal(f.service.domain().task(taskId).importedBlockers, "clear");
  f.gh.set("not-signed-in");
  const beforeStatusAttempt = f.service
    .githubSources()
    .syncState(f.projectId, "S-1")?.refreshedAt;
  await f.api.readProjectConfiguration(f.projectId);
  assert.equal(
    f.service.domain().task(taskId).importedBlockers,
    "unknown",
    "status failure invalidates before refresh",
  );
  assert.equal(
    f.service.githubSources().syncState(f.projectId, "S-1")?.refreshedAt,
    beforeStatusAttempt,
  );
  const calls = requests.length;
  await f.service.refreshGitHub();
  assert.equal(requests.length, calls);
  assert.equal(
    f.service.githubSources().syncState(f.projectId, "S-1")?.complete,
    0,
  );
  assert.equal(f.service.domain().task(taskId).importedBlockers, "unknown");
  assert.ok(
    f.service.domain().admission(localId).reasons.includes("local-dependency"),
  );
  assert.equal(
    (await f.api.readSourceObservations()).data.projects[0]?.selections[0]
      ?.credentialReason,
    "gh-not-signed-in",
  );
  const clearKey = randomUUID();
  const clear = {
    type: "github.configure" as const,
    projectId: f.projectId,
    expectedVersion: 3,
    credentialRef: null,
    selections: [{ id: "S-1", keep: true as const }],
    readiness,
    repositories: [],
    key: clearKey,
  };
  const cleared = await f.api.execute(clear);
  assert.deepEqual(
    await f.api.execute(clear),
    cleared,
    "same-key unknown save replay",
  );
  assert.deepEqual(
    await f.api.execute(preview),
    receipt,
    "recorded preview replay skips provider despite Clear",
  );
  assert.deepEqual(
    await f.ui.submit({ ...preview, expectedVersion: String(expectedVersion) }),
    f.service.domain().recordedCommand({
      ...preview,
      type: "github.activate",
      actor: "operator",
    }),
    "HTML same-key replay skips provider despite Clear",
  );
  assert.equal(f.service.domain().tasks(f.projectId).length, 2);
  assert.equal(
    f.service.domain().githubConfiguration(f.projectId).selections.length,
    1,
  );
  assert.deepEqual(
    f.service.domain().githubActiveSelectionIds(f.projectId),
    [],
  );
  await assert.rejects(
    f.api.execute({ ...preview, key: randomUUID() }),
    (error: unknown) =>
      error instanceof OperatorApiError && error.code === "conflict",
  );
  f.gh.set("signed-in");
  f.configure("gh:github.com");
  await f.api.execute({ ...preview, key: randomUUID(), expectedVersion: 5 });
  await f.service.refreshGitHub();
  assert.equal(f.service.domain().tasks(f.projectId).length, 2);
  assert.equal(f.service.domain().task(taskId).importedBlockers, "clear");
});

test("a late source reference filters helpers immediately while the existing Codex snapshot needs restart", async (t) => {
  environment(t, {
    FIXTURE_SX_SOURCE: "late-source-value",
    FIXTURE_SX_ALIAS: "late-source-value",
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
  });
  const f = await fixture(t);
  const initial = f.spawns.at(-1);
  assert.ok(initial);
  assert.equal(initial.FIXTURE_SX_SOURCE, "late-source-value");
  f.configure("env:FIXTURE_SX_SOURCE");
  assert.equal(initial.FIXTURE_SX_SOURCE, "late-source-value");
  assert.equal(childProcessEnvironment().FIXTURE_SX_SOURCE, undefined);
  assert.equal(childProcessEnvironment().FIXTURE_SX_ALIAS, undefined);
  await f.service.stop();
  await f.service.start();
  assert.equal(f.spawns.at(-1)?.FIXTURE_SX_SOURCE, undefined);
  assert.equal(f.spawns.at(-1)?.FIXTURE_SX_ALIAS, undefined);
});

test("JSON and advanced HTML expose the same actionable source credential refusal", async (t) => {
  const gh = createFakeGh();
  t.after(() => gh.close());
  const s = await startCliService(t, {
    service: {
      power: { enabled: false },
      routingClient: null,
      ghExecutable: gh.executable,
    },
  });
  const d = s.f.service.domain();
  const configure = (ref: string | null) =>
    d.execute({
      type: "github.configure",
      actor: "operator",
      projectId: s.projectId,
      key: randomUUID(),
      expectedVersion: d.githubConfiguration(s.projectId).version,
      credentialRef: ref,
      selections: [selection],
      readiness,
      repositories: [],
    });
  configure(null);
  for (const state of [
    "missing",
    "not-signed-in",
    "unreadable",
    "not-installed",
  ] as const) {
    if (state !== "missing") {
      if (state === "not-installed") unlinkSync(gh.executable);
      else gh.set(state);
      configure("gh:github.com");
    }
    const version = d.githubConfiguration(s.projectId).version;
    const reason =
      state === "missing"
        ? "missing-credential"
        : state === "not-signed-in"
          ? "gh-not-signed-in"
          : state === "not-installed"
            ? "gh-not-installed"
            : "gh-unreadable";
    const command = {
      type: "github.preview",
      key: randomUUID(),
      projectId: s.projectId,
      selectionId: "S-1",
      expectedVersion: version,
    };
    const json = await s.sessionPost("/api/operator/commands", command);
    assert.equal(json.status, 409);
    const body = await json.json();
    assert.equal(body.error.credentialReason, reason);
    assert.equal(body.error.message, sourceCredentialExplanation(reason));
    assert.equal(JSON.stringify(body).includes(fakeGhToken), false);
    const html = await s.sessionForm("/command", {
      ...command,
      expectedVersion: String(version),
    });
    assert.equal(html.status, 409);
    const text = await html.text();
    assert.ok(
      text
        .replaceAll("&#39;", "'")
        .includes(sourceCredentialExplanation(reason)),
    );
    assert.ok(text.includes(`#github-source-credential`));
    assert.equal(text.includes(fakeGhToken), false);
  }
});

test("credential failure invalidation is atomic, idempotent, scoped and keeps observation timestamps", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { DomainStore } = await import("../../src/core/domain.js");
  const { GitHubSourceStore } = await import("../../src/core/github-source.js");
  const { Store } = await import("../../src/core/store.js");
  const root = mkdtempSync(join(tmpdir(), "ensemble-credential-invalidation-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  new Store(db).ensureHost("fixture");
  const d = new DomainStore(db);
  d.migrate();
  const sources = new GitHubSourceStore(db);
  sources.migrate();
  const execute = (command: object) =>
    d.execute({ actor: "operator", key: randomUUID(), ...command } as never);
  const seed = (suffix: string, active = true) => {
    const projectId = randomUUID();
    execute({
      type: "project.create",
      projectId,
      name: suffix,
      leadProfileId: null,
    });
    const selected = {
      ...selection,
      repositoryId: `R_${suffix}`,
      name: suffix,
    };
    execute({
      type: "github.configure",
      projectId,
      expectedVersion: 1,
      credentialRef: "gh:github.com",
      selections: [selected],
      readiness,
      repositories: [],
    });
    const binding = {
      projectId,
      configVersion: 2,
      credentialRef: "gh:github.com",
    };
    const issue = {
      providerInstance: "github.com" as const,
      nodeId: `I_${suffix}`,
      repositoryId: selected.repositoryId,
      repositoryName: `org/${suffix}`,
      number: 1,
      title: suffix,
      body: "Scope",
      state: "open" as const,
      labels: ["ready"],
      projectFields: [],
    };
    if (active) {
      execute({
        type: "github.activate",
        projectId,
        expectedVersion: 2,
        selectionId: selected.id,
      });
      sources.reconcileSelection(
        projectId,
        selected.id,
        { complete: true, issues: [issue], reason: null },
        binding,
      );
      sources.reconcileBlockers(issue.nodeId, {
        complete: true,
        blockers: [
          { ...issue, nodeId: `B_${suffix}`, number: 2, state: "closed" },
        ],
        reason: null,
      });
      sources.recordIssueStatus(issue.nodeId, { status: "closed" });
    }
    return {
      projectId,
      selected,
      binding,
      issue,
      taskId: String(sources.issue(issue.nodeId)?.taskId ?? ""),
    };
  };
  const a = seed("a"),
    b = seed("b"),
    inactive = seed("inactive", false);
  const localId = randomUUID();
  execute({
    type: "task.create",
    projectId: a.projectId,
    taskId: localId,
    title: "Dependent",
    outcome: "Wait",
    ready: false,
  });
  execute({
    type: "dependency.add",
    projectId: a.projectId,
    taskId: localId,
    blockerTaskId: a.taskId,
    expectedVersion: 1,
  });
  const read = (s: typeof a) => ({
    task: d.task(s.taskId),
    sync: sources.syncState(s.projectId, "S-1"),
    dependency: db
      .prepare("SELECT * FROM github_dependency_observations WHERE nodeId = ?")
      .get(s.issue.nodeId),
    status: db
      .prepare("SELECT * FROM github_issue_status WHERE nodeId = ?")
      .get(s.issue.nodeId),
    native: sources.nativeBlockers(s.issue.nodeId),
  });
  const before = read(a),
    other = read(b),
    localVersion = d.task(localId).version;
  assert.equal(before.task.importedBlockers, "clear");
  assert.equal(before.status?.status, "closed");
  assert.equal(
    sources.invalidateCredentialFailure(a.binding, "gh-not-signed-in"),
    true,
  );
  const after = read(a);
  assert.equal(after.task.importedBlockers, "unknown");
  assert.equal(after.status?.status, "unknown");
  assert.equal(after.dependency?.complete, 0);
  assert.equal(after.sync?.complete, 0);
  assert.equal(after.sync?.refreshedAt, before.sync?.refreshedAt);
  assert.equal(after.status?.refreshedAt, before.status?.refreshedAt);
  assert.equal(after.dependency?.refreshedAt, before.dependency?.refreshedAt);
  assert.deepEqual(after.native, before.native);
  assert.deepEqual(read(b), other);
  assert.equal(Number(d.task(localId).version), Number(localVersion) + 1);
  assert.ok(d.admission(localId).reasons.includes("local-dependency"));
  sources.invalidateCredentialFailure(a.binding, "gh-not-signed-in");
  assert.deepEqual(read(a), after);
  assert.equal(Number(d.task(localId).version), Number(localVersion) + 1);
  assert.equal(
    sources.invalidateCredentialFailure(inactive.binding, "gh-unreadable"),
    true,
  );
  assert.equal(sources.syncState(inactive.projectId, "S-1"), undefined);
  execute({
    type: "github.configure",
    projectId: a.projectId,
    expectedVersion: 2,
    credentialRef: "env:NEW_SOURCE",
    selections: [{ id: "S-1", keep: true }],
    readiness,
    repositories: [],
  });
  execute({
    type: "github.activate",
    projectId: a.projectId,
    expectedVersion: 3,
    selectionId: "S-1",
  });
  const fresh = {
    ...a.binding,
    configVersion: 3,
    credentialRef: "env:NEW_SOURCE",
  };
  sources.reconcileSelection(
    a.projectId,
    "S-1",
    { complete: true, issues: [a.issue], reason: null },
    fresh,
  );
  sources.reconcileBlockers(a.issue.nodeId, {
    complete: true,
    blockers: [],
    reason: null,
  });
  sources.recordIssueStatus(a.issue.nodeId, { status: "closed" });
  const recovered = read(a),
    recoveredLocal = d.task(localId).version;
  assert.equal(
    sources.invalidateCredentialFailure(a.binding, "gh-not-signed-in"),
    false,
  );
  assert.equal(
    sources.invalidateCredentialFailure(
      { ...fresh, credentialRef: "gh:github.com" },
      "gh-unreadable",
    ),
    false,
  );
  assert.deepEqual(read(a), recovered);
  assert.equal(d.task(localId).version, recoveredLocal);
  assert.throws(() =>
    sources.invalidateCredentialFailure(fresh, "child stderr" as never),
  );
  assert.deepEqual(read(a), recovered);
});

test("a delayed status credential failure cannot poison a newly configured source", async (t) => {
  environment(t, {
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    FIXTURE_SX_RACE_NEW: "race-new-value",
  });
  const f = await fixture(t);
  const started = join(f.root, "status-started"),
    release = join(f.root, "status-release");
  writeFileSync(
    f.gh.executable,
    `#!${process.execPath}\nconst fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(started)}, "started");
const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(release)})) return;
clearInterval(timer); process.stdout.write(JSON.stringify({hosts:{"github.com":[{state:"error",active:true,login:"octo"}]}})); process.exitCode=1; }, 10);\n`,
    { mode: 0o700 },
  );
  t.after(() => {
    if (existsSync(f.root)) writeFileSync(release, "release");
  });
  f.configure("gh:github.com");
  const d = f.service.domain(),
    sources = f.service.githubSources();
  const issue = {
    providerInstance: "github.com" as const,
    ...reference,
    title: "Race",
    body: "Scope",
    state: "open" as const,
    labels: ["ready"],
    projectFields: [],
  };
  f.execute({
    type: "github.activate",
    projectId: f.projectId,
    expectedVersion: 2,
    selectionId: "S-1",
  });
  sources.reconcileSelection(f.projectId, "S-1", {
    complete: true,
    issues: [issue],
    reason: null,
  });
  sources.reconcileBlockers(issue.nodeId, {
    complete: true,
    blockers: [],
    reason: null,
  });
  const taskId = String(sources.issue(issue.nodeId)?.taskId);
  const oldStatus = f.service.gitHubSourceCredentialStatus(f.projectId);
  const deadline = Date.now() + 2000;
  while (!existsSync(started) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(existsSync(started), "old gh check is pending");
  f.configure("env:FIXTURE_SX_RACE_NEW");
  f.execute({
    type: "github.activate",
    projectId: f.projectId,
    expectedVersion: 3,
    selectionId: "S-1",
  });
  const binding = {
    projectId: f.projectId,
    configVersion: 3,
    credentialRef: "env:FIXTURE_SX_RACE_NEW",
  };
  sources.reconcileSelection(
    f.projectId,
    "S-1",
    { complete: true, issues: [issue], reason: null },
    binding,
  );
  sources.reconcileBlockers(issue.nodeId, {
    complete: true,
    blockers: [],
    reason: null,
  });
  const currentVersion = d.task(taskId).version;
  const currentAttempt = sources.syncState(f.projectId, "S-1")?.refreshedAt;
  writeFileSync(release, "release");
  assert.equal((await oldStatus).reason, "gh-unreadable");
  assert.equal(d.task(taskId).importedBlockers, "clear");
  assert.equal(d.task(taskId).version, currentVersion);
  assert.equal(sources.syncState(f.projectId, "S-1")?.complete, 1);
  assert.equal(
    sources.syncState(f.projectId, "S-1")?.refreshedAt,
    currentAttempt,
  );
});

for (const consumer of ["configuration", "observations", "html"] as const)
  test(`${consumer} readback cannot mix a pending old credential with a new source configuration`, async (t) => {
    environment(t, {
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      FIXTURE_SX_READBACK: "current-readback-value",
    });
    const f = await fixture(t);
    const started = join(f.root, "readback-started"),
      release = join(f.root, "readback-release");
    writeFileSync(
      f.gh.executable,
      `#!${process.execPath}\nconst fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(started)}, "started"); const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(release)})) return; clearInterval(timer); process.stdout.write(JSON.stringify({hosts:{"github.com":[{state:"error",active:true,login:"octo"}]}})); process.exitCode=1; }, 10);\n`,
      { mode: 0o700 },
    );
    t.after(() => {
      if (existsSync(f.root)) writeFileSync(release, "release");
    });
    f.configure("gh:github.com");
    const pending =
      consumer === "configuration"
        ? f.api.readProjectConfiguration(f.projectId)
        : consumer === "observations"
          ? f.api.readSourceObservations()
          : f.ui.projectWithCredentialStatus(f.projectId);
    const deadline = Date.now() + 2000;
    while (!existsSync(started) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(existsSync(started));
    f.configure("env:FIXTURE_SX_READBACK");
    f.execute({
      type: "github.activate",
      projectId: f.projectId,
      expectedVersion: 3,
      selectionId: "S-1",
    });
    writeFileSync(release, "release");
    const response = await pending;
    if (typeof response === "string") {
      assert.ok(response.includes("Usable."));
      assert.ok(!response.includes("GitHub CLI sign-in could not be read"));
    } else if ("source" in response.data) {
      assert.equal(response.data.source.version, 3);
      assert.equal(response.data.source.selections[0]?.active, true);
      assert.equal(response.data.source.credential?.usable, true);
    } else {
      assert.equal(response.data.projects[0]?.credential?.usable, true);
      assert.equal(
        response.data.projects[0]?.selections[0]?.credentialReason,
        null,
      );
    }
  });

for (const surface of ["api", "html"] as const)
  test(`${surface} delayed preview credential failure preserves newer source evidence`, async (t) => {
    environment(t, { FIXTURE_SX_PREVIEW_NEW: "preview-new-value" });
    const f = await fixture(t);
    f.configure("gh:github.com");
    let release!: (value: SelectionSnapshot) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pendingSnapshot = new Promise<SelectionSnapshot>((resolve) => {
      release = resolve;
    });
    const reader: GitHubSourceReader = {
      readSelection: async () => {
        started();
        return pendingSnapshot;
      },
      readBlockers: async () => {
        throw new Error("unexpected blockers read");
      },
      readIssueStatus: async () => {
        throw new Error("unexpected status read");
      },
    };
    const api = new OperatorApi(
      f.service,
      [],
      () => f.service.coordinationView(),
      () => reader,
    );
    const ui = new LocalOperatorUi(
      f.service.domain(),
      () => reader,
      f.service.githubSources(),
    );
    const command = {
      type: "github.preview" as const,
      projectId: f.projectId,
      selectionId: "S-1",
      expectedVersion: 2,
      key: randomUUID(),
    };
    const pending =
      surface === "api"
        ? api.execute(command)
        : ui.submit({ ...command, expectedVersion: "2" });
    const rejection = assert.rejects(pending);
    await entered;
    f.configure("env:FIXTURE_SX_PREVIEW_NEW");
    f.execute({
      type: "github.activate",
      projectId: f.projectId,
      expectedVersion: 3,
      selectionId: "S-1",
    });
    const sources = f.service.githubSources();
    const issue = {
      providerInstance: "github.com" as const,
      ...reference,
      title: "Fresh",
      body: "Scope",
      state: "open" as const,
      labels: ["ready"],
      projectFields: [],
    };
    sources.reconcileSelection(
      f.projectId,
      "S-1",
      { complete: true, issues: [issue], reason: null },
      {
        projectId: f.projectId,
        configVersion: 3,
        credentialRef: "env:FIXTURE_SX_PREVIEW_NEW",
      },
    );
    sources.reconcileBlockers(issue.nodeId, {
      complete: true,
      blockers: [],
      reason: null,
    });
    const taskId = String(sources.issue(issue.nodeId)?.taskId);
    const before = {
      version: f.service.domain().task(taskId).version,
      sync: sources.syncState(f.projectId, "S-1"),
    };
    release({ complete: false, issues: [], reason: "gh-unreadable" });
    await rejection;
    assert.equal(f.service.domain().task(taskId).importedBlockers, "clear");
    assert.equal(f.service.domain().task(taskId).version, before.version);
    assert.deepEqual(sources.syncState(f.projectId, "S-1"), before.sync);
  });

import { ghToken } from "../../src/standalone/gh-credential.js";

test("candidate gh offers match selected identity across service/JSON/HTML with precedence and private exclusions", async (t) => {
  const f = await fixture(t);
  environment(t, {
    PATH: `${f.gh.executable.slice(0, f.gh.executable.lastIndexOf("/"))}:${process.env.PATH}`,
    GH_TOKEN: "candidate-gh-first",
    GITHUB_TOKEN: "candidate-github-second",
    FIXTURE_SX_SOURCE: "candidate-gh-first",
    FIXTURE_SX_ALIAS: "candidate-gh-first",
    FIXTURE_SX_DISCOVERY: "discovery-canary",
    FIXTURE_SX_DISCOVERY_ALIAS: "discovery-canary",
    FIXTURE_SX_CLAUDE: "claude-canary",
    FIXTURE_SX_CLAUDE_ALIAS: "claude-canary",
    FIXTURE_SX_DELIVERY: "delivery-canary",
    FIXTURE_SX_DELIVERY_ALIAS: "delivery-canary",
    FIXTURE_SX_OLD_NEUTRAL: "identity-old-resolved",
  });
  f.gh.setToken("identity-old-resolved");
  assert.ok(
    "token" in
      (await ghToken({ executable: f.gh.executable, environment: {} })),
  );
  f.gh.setAccounts({
    stored: { login: "stored-account", token: "stored-token" },
    tokens: {
      "candidate-gh-first": "first-account",
      "candidate-github-second": "second-account",
    },
  });
  f.execute({
    type: "claude-token.configure",
    credentialRef: "env:FIXTURE_SX_CLAUDE",
  });
  f.execute({
    type: "delivery.configure",
    projectId: f.projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: "env:FIXTURE_SX_DELIVERY",
    grants: [],
    requiredChecks: [],
  });
  const direct = new LocalOperatorUi(
    f.service.domain(),
    undefined,
    f.service.githubSources(),
  );
  const provider = globalThis.fetch;
  let providerReads = 0;
  globalThis.fetch = async () => {
    providerReads++;
    throw new Error("provider read forbidden");
  };
  t.after(() => {
    globalThis.fetch = provider;
  });
  for (const discovery of [null, "env:FIXTURE_SX_DISCOVERY"]) {
    if (discovery) {
      process.env.FIXTURE_SX_DISCOVERY = "discovery-canary";
      process.env.FIXTURE_SX_DISCOVERY_ALIAS = "discovery-canary";
    } else {
      delete process.env.FIXTURE_SX_DISCOVERY;
      delete process.env.FIXTURE_SX_DISCOVERY_ALIAS;
    }
    f.execute({ type: "discovery.configure", credentialRef: discovery });
    for (const actual of [null, "env:FIXTURE_SX_SOURCE", "env:GH_TOKEN"]) {
      f.configure(actual);
      const config = f.service.domain().githubConfiguration(f.projectId);
      const start = f.gh.commands().length;
      const status = await f.service.gitHubSourceCredentialStatus(f.projectId);
      assert.deepEqual(status.gh, {
        state: "signed-in",
        login: "first-account",
      });
      assert.equal(status.usable, actual !== null);
      const json = await f.api.readProjectConfiguration(f.projectId);
      assert.deepEqual(json.data.source.credential?.gh, status.gh);
      const observations = await f.api.readSourceObservations();
      assert.deepEqual(
        observations.data.projects.find((p) => p.projectId === f.projectId)
          ?.credential?.gh,
        status.gh,
      );
      assert.match(
        await f.ui.projectWithCredentialStatus(f.projectId),
        /Detected GitHub CLI account @first-account/,
      );
      assert.match(
        await direct.projectWithCredentialStatus(f.projectId),
        /Detected GitHub CLI account @first-account/,
      );
      assert.ok(
        f.gh
          .commands()
          .slice(start)
          .every((command) => command === "status"),
        "null/env offers never read a gh token",
      );
      assert.deepEqual(
        f.service.domain().githubConfiguration(f.projectId),
        config,
      );
      assert.deepEqual(
        f.service.domain().githubActiveSelectionIds(f.projectId),
        [],
      );
      for (const env of f.gh.environments().slice(-5)) {
        assert.equal(env.GH_TOKEN, "candidate-gh-first");
        assert.equal(env.GITHUB_TOKEN, "candidate-github-second");
        for (const key of [
          "FIXTURE_SX_SOURCE",
          "FIXTURE_SX_ALIAS",
          "FIXTURE_SX_DISCOVERY",
          "FIXTURE_SX_DISCOVERY_ALIAS",
          "FIXTURE_SX_CLAUDE",
          "FIXTURE_SX_CLAUDE_ALIAS",
          "FIXTURE_SX_DELIVERY",
          "FIXTURE_SX_DELIVERY_ALIAS",
          "FIXTURE_SX_OLD_NEUTRAL",
        ])
          assert.equal(env[key], undefined);
      }
      f.configure("gh:github.com");
      assert.deepEqual(
        (await f.service.gitHubSourceCredentialStatus(f.projectId)).gh,
        status.gh,
      );
      f.configure(null); // Clear retains the same explicit candidate offer, without activation.
      assert.deepEqual(
        (await f.service.gitHubSourceCredentialStatus(f.projectId)).gh,
        status.gh,
      );
    }
  }
  delete process.env.GH_TOKEN;
  assert.deepEqual(
    (await f.service.gitHubSourceCredentialStatus(f.projectId)).gh,
    { state: "signed-in", login: "second-account" },
  );
  delete process.env.GITHUB_TOKEN;
  assert.deepEqual(
    (await f.service.gitHubSourceCredentialStatus(f.projectId)).gh,
    { state: "signed-in", login: "stored-account" },
  );
  process.env.GH_TOKEN = "invalid-overriding-token";
  f.configure("env:FIXTURE_SX_SOURCE");
  const start = f.gh.commands().length;
  const independent = await f.service.gitHubSourceCredentialStatus(f.projectId);
  assert.equal(independent.usable, true);
  assert.equal(independent.reason, null);
  assert.equal(independent.gh.state, "unreadable");
  assert.ok(
    f.gh
      .commands()
      .slice(start)
      .every((command) => command === "status"),
  );
  assert.doesNotMatch(
    await direct.projectWithCredentialStatus(f.projectId),
    /@stored-account/,
  );
  f.configure("gh:github.com");
  assert.equal(
    (await f.service.gitHubSourceCredentialStatus(f.projectId)).reason,
    "gh-unreadable",
  );
  assert.equal(providerReads, 0);
  assert.equal(f.service.githubSources().issue("I_1"), undefined);
});

test("a readiness rule naming a withheld value is unavailable, never none, and its text never leaves", async (t) => {
  environment(t, {
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    FIXTURE_SX_LABEL: "label-secret-value",
  });
  const f = await fixture(t);
  f.execute({
    type: "github.configure",
    projectId: f.projectId,
    expectedVersion: 1,
    credentialRef: "env:FIXTURE_SX_LABEL",
    selections: [selection],
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", name: "label-secret-value" }],
    },
    repositories: [],
  });
  f.execute({
    type: "github.activate",
    projectId: f.projectId,
    expectedVersion: 2,
    selectionId: "S-1",
  });
  const sources = f.service.githubSources();
  sources.reconcileSelection(f.projectId, "S-1", {
    complete: true,
    issues: [
      {
        providerInstance: "github.com",
        ...reference,
        title: "Withheld",
        body: "Scope",
        state: "open",
        labels: [],
        projectFields: [],
      },
    ],
    reason: null,
  });
  const taskId = String(sources.issue(reference.nodeId)?.taskId);
  const observations = await f.api.readSourceObservations(),
    project = observations.data.projects.find(
      (p) => p.projectId === f.projectId,
    );
  assert.deepEqual(project?.readiness, { kind: "unavailable" });
  assert.equal(project?.selections[0]?.counts?.matching, null);
  assert.equal(project?.selections[0]?.counts?.open, 1);
  const list = await f.api.readTaskListPage(),
    task = await f.api.readTask(taskId);
  const summary = list.data.tasks.find((s) => s.id === taskId);
  for (const readiness of [
    summary?.source?.readiness,
    task.data.source?.readiness,
  ])
    assert.deepEqual(readiness, {
      rule: { kind: "unavailable" },
      outcome: "not-evaluated",
      unmet: [],
    });
  assert.equal(
    JSON.stringify([observations, list, task]).includes("label-secret-value"),
    false,
  );
});
