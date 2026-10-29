import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { Runtime } from "../../src/standalone/codex.js";
import type {
  GitHubSourceReader,
  IssueSnapshot,
} from "../../src/standalone/github-source.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { StandaloneService } from "../../src/standalone/service.js";

const at = (n: number, state: "open" | "closed" = "open"): IssueSnapshot => ({
  providerInstance: "github.com",
  nodeId: `I_${n}`,
  repositoryId: "R_1",
  repositoryName: "org/repo",
  number: n,
  title: `Issue ${n}`,
  body: "Scope",
  state,
  labels: [],
  projectFields: [],
});

test("readiness counts and unmet reasons come from stored observations without provider reads", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cab-readiness-")));
  const previous = process.env.FIXTURE_READINESS_TOKEN;
  process.env.FIXTURE_READINESS_TOKEN = "readiness-token";
  const reads = { selection: 0, blockers: 0, status: 0 };
  let failing = false;
  const reader: GitHubSourceReader = {
    async readSelection() {
      reads.selection++;
      return failing
        ? { complete: false, issues: [], reason: "http-403" }
        : {
            complete: true,
            issues: [at(1), at(2), at(3), at(4, "closed")],
            reason: null,
          };
    },
    async readBlockers() {
      reads.blockers++;
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      reads.status++;
      return { status: "open" };
    },
  };
  const runtime = (): Runtime => ({
    async start() {},
    async stop() {},
    onUnexpectedRequest() {},
    async startThread() {
      throw new Error("no threads");
    },
    async resumeThread() {},
    async startTurn() {
      throw new Error("no turns");
    },
    async interruptTurn() {},
    async waitForTurn() {
      return "completed";
    },
  });
  const service = new StandaloneService(
    join(root, "data"),
    runtime,
    undefined,
    {
      github: { readerFactory: () => reader, intervalMs: 60_000 },
      power: { enabled: false },
    },
  );
  try {
    await service.start();
    const projectId = randomUUID();
    const execute = (command: object) =>
      service
        .domain()
        .execute({ actor: "operator", key: randomUUID(), ...command } as never);
    execute({
      type: "project.create",
      projectId,
      name: "Alpha",
      leadProfileId: null,
    });
    execute({
      type: "github.configure",
      projectId,
      expectedVersion: 1,
      credentialRef: "env:FIXTURE_READINESS_TOKEN",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R_1",
          owner: "org",
          name: "repo",
        },
      ],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", name: "ready" }],
      },
    });
    execute({
      type: "github.activate",
      projectId,
      selectionId: "repo",
      expectedVersion: 2,
    });
    const api = new OperatorApi(service);
    await service.refreshGitHub();
    const snapshot = { ...reads };
    const selection = async () =>
      (await api.readSourceObservations()).data.projects.find(
        (p) => p.projectId === projectId,
      );
    const observed = await selection();
    assert.deepEqual(observed?.readiness, {
      kind: "rule",
      mode: "all",
      conditions: [{ kind: "label", name: "ready" }],
    });
    assert.deepEqual(observed?.selections[0]?.counts, {
      observed: 4,
      open: 3,
      closedSkipped: 1,
      matching: 0,
      complete: true,
    });
    const unmet = {
      rule: observed?.readiness,
      outcome: "unmet",
      unmet: [{ kind: "label", name: "ready" }],
    };
    const tasks = (await api.readTaskListPage()).data.tasks.filter(
      (t) => t.projectId === projectId,
    );
    assert.equal(tasks.length, 3);
    for (const task of tasks) {
      assert.deepEqual(task.source?.readiness, unmet);
      assert.deepEqual(
        (await api.readTask(task.id)).data.source?.readiness,
        unmet,
      );
    }
    await selection();
    assert.deepEqual(reads, snapshot, "reads never call the provider");
    // Collection reads load readiness once for all their tasks.
    const batched = mock.method(service.githubSources(), "readinessByTask");
    await api.readTaskListPage();
    await api.readComposerOptions(projectId);
    await api.readInbox();
    assert.equal(batched.mock.callCount(), 3);
    batched.mock.restore();

    failing = true;
    await service.refreshGitHub();
    assert.equal(reads.selection, snapshot.selection + 1);
    const partial = (await selection())?.selections[0];
    assert.equal(partial?.state, "partial");
    assert.deepEqual(partial?.counts, {
      observed: 4,
      open: 3,
      closedSkipped: 1,
      matching: 0,
      complete: false,
    });

    delete process.env.FIXTURE_READINESS_TOKEN;
    const unusable = (await selection())?.selections[0];
    assert.equal(unusable?.state, "unavailable");
    assert.equal(unusable?.counts, null);
  } finally {
    await service.stop();
    if (previous === undefined) delete process.env.FIXTURE_READINESS_TOKEN;
    else process.env.FIXTURE_READINESS_TOKEN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
