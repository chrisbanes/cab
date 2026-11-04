import type {
  UnstackMaterial,
  UnstackProvider,
} from "../../src/standalone/unstack.js";
import { proveUnchangedRebase } from "../../src/standalone/rebase-proof.js";
import { verifierGit } from "../../src/standalone/push-verification.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import {
  canonicalMaterial,
  type PrDeliveryObservation,
} from "../../src/core/delivery.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
} from "../../src/standalone/codex.js";
import type { CodeHostDeliveryProvider } from "../../src/standalone/code-host.js";
import type { IssueTrackerWriter } from "../../src/standalone/issue-tracker.js";
import {
  StandaloneService,
  type StandaloneServiceOptions,
} from "../../src/standalone/service.js";
import { unusedIssueInspection } from "./delivery-fixture.js";
import { git } from "./publication.js";
import { tmpdir } from "./temp.js";
import { until } from "./until.js";

export const repositoryId = "R1";

/**
 * The assembled service over a real Git repository linked as R1, in a stacking project, with a
 * fake GitHub that records branch heads and serves each task's PR. Tasks are local and Ready;
 * `tasks` lists them in creation order, each blocked by the one before it.
 */
export async function stackedDeliveryFixture(
  t: TestContext,
  options: {
    tasks?: number;
    forcePush?: "allow" | "approval";
    stacking?: boolean;
    backgroundDiagnosticSink?: StandaloneServiceOptions["backgroundDiagnosticSink"];
    unstack?: {
      prepare: (
        repositoryId: string,
        number: number,
      ) => Promise<UnstackMaterial>;
      provider: UnstackProvider;
    };
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cab-stacked-")));
  const source = join(root, "source");
  git(root, "init", "-q", "-b", "main", source);
  writeFileSync(join(source, "base.txt"), "base\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "base");
  const base = git(source, "rev-parse", "HEAD");

  let tool: ((call: RuntimeToolCall) => Promise<RuntimeToolResult>) | undefined;
  const turns: Array<{
    threadId: string;
    turnId: string;
    workspace: string;
    prompt: string;
    release: () => void;
  }> = [];
  const settled = new Map<
    string,
    { done: Promise<void>; release: () => void }
  >();
  const runtime = (): Runtime => ({
    async start() {},
    async stop() {
      for (const turn of settled.values()) turn.release();
    },
    onUnexpectedRequest() {},
    onToolCall(handler) {
      tool = handler;
    },
    async startThread() {
      return `thread-${randomUUID()}`;
    },
    async resumeThread() {},
    async startTurn(threadId, workspace, prompt) {
      const turnId = `turn-${randomUUID()}`;
      let release = () => {};
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      settled.set(turnId, { done, release });
      turns.push({ threadId, turnId, workspace, prompt, release });
      return turnId;
    },
    async interruptTurn(_thread, turnId) {
      settled.get(turnId)?.release();
    },
    async waitForTurn(_thread, turnId) {
      await settled.get(turnId)?.done;
      return "completed";
    },
  });

  const remote: Record<string, string> = {};
  /** Runs once when the next branch push reaches provider preflight, after its proof. */
  let nextPreflight: (() => void) | undefined;
  /** The next branch push fails with a retryable no-effect failure. */
  let failNext = false;
  const prs = new Map<string, PrDeliveryObservation>();
  let afterRebaseProof: (() => void | Promise<void>) | undefined;
  let rebaseProofs = 0;
  const provider: CodeHostDeliveryProvider & IssueTrackerWriter = {
    ...unusedIssueInspection,
    ...(options.unstack
      ? {
          prepareUnstack: options.unstack.prepare,
          unstackProvider: () => options.unstack!.provider,
        }
      : {}),
    async readRebaseHead(_repositoryId, branch) {
      return remote[branch] ?? null;
    },
    async proveRebase(input) {
      rebaseProofs++;
      const proof = await proveUnchangedRebase(
        verifierGit(input.workspacePath),
        input.oldBase,
        input.oldHead,
        input.newBase,
        input.newHead,
      );
      const hook = afterRebaseProof;
      afterRebaseProof = undefined;
      await hook?.();
      return proof;
    },
    async preflight(action, _policy, publication) {
      if (publication && nextPreflight) {
        const hook = nextPreflight;
        nextPreflight = undefined;
        hook();
      }
      return publication
        ? {
            branch: publication.branch,
            beforeHead: remote[publication.branch] ?? null,
            lastPushedSha: publication.lastPushedSha,
            uncommittedEntries: publication.uncommittedEntries,
          }
        : { nodeId: action.target.repositoryId };
    },
    async performAction(record) {
      const action = record.request.action;
      if (action.kind !== "branch.push" && action.kind !== "branch.force-push")
        throw new Error(`unexpected ${action.kind}`);
      const branch = String(record.beforeState?.branch);
      if (failNext) {
        failNext = false;
        return {
          state: "confirmed-failure",
          reason: "provider-retryable",
          receipt: null,
          retryable: true,
        };
      }
      remote[branch] = action.commitSha;
      return {
        state: "confirmed-success",
        reason: null,
        receipt: {
          nodeId: repositoryId,
          ref: branch,
          headSha: action.commitSha,
        },
      };
    },
    async inspectAction() {
      return { state: "uncertain", reason: "unproved", receipt: null };
    },
    async inspectPr(identity) {
      const pr = prs.get(identity.expectedPrNodeId);
      if (!pr) throw new Error("no such PR");
      return pr;
    },
  };

  const dataDir = join(root, "data");
  const startService = async () => {
    const service = new StandaloneService(dataDir, runtime, undefined, {
      delivery: {
        providerFactories: { github: () => provider },
        issueTrackerFactories: { github: () => provider },
      },
      power: { enabled: false },
      ...(options.backgroundDiagnosticSink
        ? { backgroundDiagnosticSink: options.backgroundDiagnosticSink }
        : {}),
    });
    await service.start();
    return service;
  };
  let service = await startService();
  t.after(async () => {
    await service.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  const d = service.domain();
  const run = (command: Record<string, unknown>) =>
    service
      .domain()
      .execute({ actor: "operator", key: randomUUID(), ...command } as never);
  const profileId = randomUUID(),
    projectId = randomUUID();
  run({
    type: "profile.create",
    profileId,
    name: "Lead",
    instructions: "Lead",
    capabilities: "work",
  });
  run({
    type: "project.create",
    projectId,
    name: "P",
    leadProfileId: profileId,
  });
  await d.configureRepositories({
    type: "repositories.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: d.repositoryLinks(projectId).version,
    repositories: [
      {
        codeHost: "github",
        host: "github.com",
        repositoryId,
        path: source,
        ref: "main",
      },
    ],
  });
  const projectVersion = () =>
    Number(service.domain().project(projectId).version);
  const grant = (forcePush: "allow" | "approval") =>
    run({
      type: "delivery.configure",
      projectId,
      expectedVersion: service.delivery().configuration(projectId).version,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: [
        { action: "branch.push", repositoryId, mode: "allow" },
        { action: "branch.force-push", repositoryId, mode: forcePush },
      ],
      requiredChecks: [],
    });
  grant(options.forcePush ?? "allow");
  run({
    type: "project.configure",
    projectId,
    expectedVersion: projectVersion(),
    stacking: options.stacking ?? true,
  });
  // Every task in a chain keeps a running lead turn.
  run({
    type: "capacity.configure",
    globalLimit: 8,
    projectOverrides: { [projectId]: 8 },
  });
  const tasks: string[] = [];
  for (let i = 0; i < (options.tasks ?? 2); i++) {
    const taskId = randomUUID();
    run({
      type: "task.create",
      projectId,
      taskId,
      title: `Task ${i + 1}`,
      outcome: "O",
      ready: true,
      ...(tasks.length ? { blockerTaskIds: [tasks.at(-1)] } : {}),
    });
    tasks.push(taskId);
  }
  run({
    type: "project.configure",
    projectId,
    expectedVersion: projectVersion(),
    paused: false,
  });

  const workspaceOf = async (taskId: string) => {
    const binding = await service.taskWorkspace(taskId);
    const repository = binding?.repositories[0];
    assert.ok(binding && repository, `workspace of ${taskId}`);
    return { root: realpathSync(binding.path), path: repository.workspacePath };
  };
  const turnsOf = async (taskId: string) => {
    if (
      !service
        .domain()
        .leadBindings()
        .some((b) => b.taskId === taskId)
    )
      return [];
    const binding = await service.taskWorkspace(taskId);
    if (!binding) return [];
    const path = realpathSync(binding.path);
    return turns.filter((turn) => turn.workspace === path);
  };
  /** The task's `count`th turn, once it runs. */
  const waitTurn = async (taskId: string, count = 1) => {
    await until(async () => {
      const turn = (await turnsOf(taskId))[count - 1];
      return (
        turn &&
        service
          .list()
          .some((i) => i.turnId === turn.turnId && i.state === "running")
      );
    }, `turn ${count} of ${taskId}`);
    const turn = (await turnsOf(taskId))[count - 1];
    assert.ok(turn);
    return turn;
  };
  const latestTurn = async (taskId: string) => {
    const turn = (await turnsOf(taskId)).at(-1);
    assert.ok(turn, `a turn of ${taskId}`);
    return turn;
  };
  const call = async (
    taskId: string,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const turn = await latestTurn(taskId);
    assert.ok(tool);
    return tool({
      threadId: turn.threadId,
      turnId: turn.turnId,
      callId: randomUUID(),
      tool: name,
      arguments: args,
    });
  };
  const complete = async (taskId: string) => {
    const turn = await latestTurn(taskId);
    turn.release();
    await until(
      () =>
        service
          .list()
          .some((i) => i.turnId === turn.turnId && i.state === "completed"),
      "turn completion",
    );
  };
  /** Commits a new file in the task's worktree; returns the commit. */
  const commit = async (taskId: string, name: string = randomUUID()) => {
    const { path } = await workspaceOf(taskId);
    writeFileSync(join(path, `${name}.txt`), `${name}\n`);
    git(path, "add", ".");
    git(path, "commit", "-q", "-m", name);
    return git(path, "rev-parse", "HEAD");
  };
  const push = (
    taskId: string,
    commitSha: string,
    kind: "branch.push" | "branch.force-push" = "branch.push",
    approval?: { interactionId: string; expectedRevision: number },
  ) =>
    call(taskId, "cab_external_action", {
      operationId: randomUUID(),
      action: { kind, target: { repositoryId }, commitSha },
      ...(approval ? { approval } : {}),
    });
  const branchOf = (taskId: string) =>
    service.delivery().taskBranch(taskId, repositoryId);
  /** The task's PR at its branch's last push, as GitHub shows it; registered on first use. */
  const showPr = async (
    taskId: string,
    overrides: Partial<PrDeliveryObservation> = {},
  ) => {
    const branch = branchOf(taskId);
    assert.ok(branch?.lastPushedSha);
    const nodeId = `PR-${taskId}`;
    prs.set(nodeId, {
      repositoryId,
      nodeId,
      number: tasks.indexOf(taskId) + 1,
      baseRef: "main",
      headRef: branch.branch,
      headSha: branch.lastPushedSha,
      baseSha: base,
      state: "OPEN",
      draft: true,
      merged: false,
      reviewDecision: null,
      checks: [],
      closedIssueNodeIds: [],
      mergeBlockers: [],
      allowedMethods: ["squash"],
      ...overrides,
    });
    if (service.delivery().delivery(taskId)) await service.refreshGitHub();
    else {
      const r = await call(taskId, "cab_register_pr", {
        repositoryId,
        prNumber: tasks.indexOf(taskId) + 1,
        expectedPrNodeId: nodeId,
        expectedHeadSha: branch.lastPushedSha,
      });
      assert.equal(r.success, true, r.text);
    }
  };
  /** The lead requests approval of exact material and the operator approves it. */
  const approve = async (taskId: string, action: Record<string, unknown>) => {
    const requested = await call(taskId, "cab_request_approval", {
      action: action.kind,
      target: canonicalMaterial(action.target),
      material: action,
    });
    assert.equal(requested.success, true, requested.text);
    const interaction = service
      .coordinationView()
      .readTask(taskId)
      .approvals.filter((a) => a.status === "open")
      .at(-1);
    assert.ok(interaction);
    const count = (await turnsOf(taskId)).length;
    await complete(taskId);
    await service.coordinationView().decideApproval({
      taskId,
      key: randomUUID(),
      interactionId: interaction.interactionId,
      expectedRevision: 1,
      decision: "approved",
      action: String(action.kind),
      target: canonicalMaterial(action.target),
      material: action,
    });
    await waitTurn(taskId, count + 1);
    return { interactionId: interaction.interactionId, expectedRevision: 2 };
  };
  /** Restack notices queued for the task's lead, oldest first. */
  const restackNotices = () =>
    readDb((db) =>
      db
        .prepare(
          "SELECT taskId, identity FROM coordination_external_delivery_notices WHERE identity LIKE 'restack:%' ORDER BY rowid",
        )
        .all()
        .map((row) => `${String(row.taskId)} ${String(row.identity)}`),
    );
  const readDb = <T>(read: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(dataDir, "standalone.sqlite"));
    try {
      return read(db);
    } finally {
      db.close();
    }
  };
  /** The task's turn whose prompt matches, once it runs. */
  const turnWith = async (taskId: string, pattern: RegExp) => {
    await until(async () => {
      const turn = (await turnsOf(taskId)).find((t) => pattern.test(t.prompt));
      return (
        turn &&
        service
          .list()
          .some((i) => i.turnId === turn.turnId && i.state === "running")
      );
    }, `a turn of ${taskId} matching ${pattern}`);
    const turn = (await turnsOf(taskId)).find((t) => pattern.test(t.prompt));
    assert.ok(turn);
    return turn;
  };
  return {
    prs,
    onRebaseProof: (hook: () => void | Promise<void>) => {
      afterRebaseProof = hook;
    },
    rebaseProofCount: () => rebaseProofs,
    onNextPreflight: (hook: () => void) => {
      nextPreflight = hook;
    },
    failNextPush: () => {
      failNext = true;
    },
    turnWith,
    root,
    source,
    base,
    projectId,
    tasks,
    remote,
    get service() {
      return service;
    },
    run,
    grant,
    workspaceOf,
    turnsOf,
    waitTurn,
    call,
    complete,
    commit,
    push,
    branchOf,
    showPr,
    approve,
    restackNotices,
    readDb,
    /** Stops the service, applies `change` to its database, and starts it again. */
    async restart(change?: (db: DatabaseSync) => void) {
      await service.stop();
      if (change) readDb(change);
      service = await startService();
    },
  };
}
