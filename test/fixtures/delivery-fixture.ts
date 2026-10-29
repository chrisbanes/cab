import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StandaloneService,
  type RuntimeSpawnContext,
} from "../../src/standalone/service.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
} from "../../src/standalone/codex.js";
import {
  type ClosedIssueInspection,
  ProjectFieldChangedRefusal,
} from "../../src/standalone/github-delivery.js";
import type {
  CodeHostDeliveryProvider,
  CodeHostProviderFactory,
} from "../../src/standalone/code-host.js";
import type { IssueTrackerWriter } from "../../src/standalone/issue-tracker.js";
import type {
  ExternalAction,
  PrDeliveryObservation,
  ProviderActionObservation,
} from "../../src/core/delivery.js";

/** The fixture Project: Ready while its Status is Todo, In progress or In review. */
export const fixtureProject = {
  projectNodeId: "PRJ1",
  fieldNodeId: "FLD1",
  itemNodeId: "ITEM1",
  todo: "O_TODO",
  inProgress: "O_PROGRESS",
  inReview: "O_REVIEW",
  done: "O_DONE",
} as const;

export async function deliveryFixture(
  mode: "reviewable-pr" | "through-merge" = "reviewable-pr",
  imported = false,
  /** An imported task read from a Project selection whose Status the fake GitHub holds. */
  projectStatus = false,
  /** How long a status-mapping write's provider call may take before it is given up. */
  statusWriteTimeoutMs?: number,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cab-delivery-bound-"))),
    projectId = randomUUID(),
    profileId = randomUUID();
  let taskId: string = randomUUID();
  let sourceLabels = ["ready"];
  let sourceTitle = "T";
  let sourceBody = "O";
  let applyIssueEdits = false;
  let tool: ((call: RuntimeToolCall) => Promise<RuntimeToolResult>) | undefined;
  let stopped = false;
  const turns: Array<{
    threadId: string;
    turnId: string;
    release: () => void;
  }> = [];
  let waiter: (() => void) | undefined;
  let sequence = 0;
  let threadSequence = 0;
  let spawnContext: RuntimeSpawnContext | undefined;
  const runtime: Runtime = {
    async start() {
      stopped = false;
    },
    async stop() {
      stopped = true;
      waiter?.();
    },
    onUnexpectedRequest() {},
    onToolCall(handler) {
      tool = handler;
    },
    async startThread() {
      return `thread-${++threadSequence}`;
    },
    async resumeThread() {},
    async startTurn(threadId) {
      const turnId = `turn-${++sequence}`;
      turns.push({ threadId, turnId, release: () => waiter?.() });
      return turnId;
    },
    async interruptTurn() {
      waiter?.();
    },
    async waitForTurn() {
      await new Promise<void>((resolve) => {
        waiter = resolve;
        if (stopped) resolve();
      });
      return "completed";
    },
  };
  let pr: PrDeliveryObservation = {
    repositoryId: "R1",
    nodeId: "P7",
    number: 7,
    baseRef: "main",
    headRef: "cb/change",
    headSha: "1".repeat(40),
    baseSha: "2".repeat(40),
    state: "OPEN",
    draft: false,
    merged: false,
    reviewDecision: null,
    checks: [],
    closedIssueNodeIds: [],
    mergeBlockers: [],
    allowedMethods: ["squash"],
  };
  const effects: ExternalAction[] = [];
  let actionOutcome: ProviderActionObservation | undefined;
  let inspectOutcome: ProviderActionObservation | undefined;
  let preflightWait: Promise<void> | undefined;
  let preflightHook: (() => void) | undefined;
  let readFailure = false;
  let otherPr: PrDeliveryObservation | undefined;
  let inspectionHook: (() => Promise<void> | void) | undefined;
  // Unset: GitHub shows the issue closed by the merged PR or, without one, an explicit close.
  let closedIssue:
    | { state: "open" }
    | {
        state: "closed";
        closedEvent: Extract<
          ClosedIssueInspection,
          { state: "closed" }
        >["closedEvent"];
      }
    | Error
    | undefined;
  let issueOpen: boolean | undefined;
  // The Status of the fixture issue's Project item (null is no value) and a human move landing with our write.
  let status: string | null = fixtureProject.todo;
  let movedAfterWrite: string | undefined;
  let statusHold: Promise<void> | undefined;
  let closedIssueReads = 0;
  const provider: CodeHostDeliveryProvider & IssueTrackerWriter = {
    inspectPublishedIssue: unusedIssueInspection.inspectPublishedIssue,
    async inspectClosedIssue() {
      closedIssueReads += 1;
      if (closedIssue instanceof Error) throw closedIssue;
      if (closedIssue?.state === "open") return closedIssue;
      return {
        state: "closed",
        snapshot: {
          providerInstance: "github.com",
          nodeId: "I1",
          repositoryId: "R1",
          repositoryName: "org/repo",
          number: 1,
          title: sourceTitle,
          body: sourceBody,
          state: "closed",
          labels: sourceLabels,
          projectFields: [],
        },
        closedEvent: closedIssue
          ? closedIssue.closedEvent
          : pr.merged
            ? { id: "CE1", closerKind: "pull-request", closerPrNodeId: "P7" }
            : { id: "CE1", closerKind: "none", closerPrNodeId: null },
      };
    },
    async preflight(action) {
      preflightHook?.();
      if (preflightWait) await preflightWait;
      if (action.kind === "project.field") {
        if (statusHold) await statusHold;
        if (action.expected && action.expected.optionNodeId !== status)
          throw new ProjectFieldChangedRefusal();
        return { nodeId: "target", optionId: status };
      }
      if (action.kind === "pr.merge" && pr.mergeBlockers.length)
        throw new Error("held");
      return action.kind === "issue.close"
        ? {
            nodeId: "target",
            state: (issueOpen ?? !pr.merged) ? "open" : "closed",
          }
        : { nodeId: "target" };
    },
    async performAction(record) {
      effects.push(record.request.action);
      if (record.request.action.kind === "project.field") {
        status = movedAfterWrite ?? record.request.action.optionNodeId;
        // The real provider reads the item back before it reports the outcome.
        if (!actionOutcome && status !== record.request.action.optionNodeId)
          return { state: "uncertain", reason: "unproved", receipt: null };
      }
      if (actionOutcome) return actionOutcome;
      // As GitHub would: a confirmed edit changes what the next source read shows.
      if (applyIssueEdits && record.request.action.kind === "issue.edit") {
        sourceTitle = record.request.action.fields.title ?? sourceTitle;
        sourceBody = record.request.action.fields.body ?? sourceBody;
      }
      if (record.request.action.kind === "pr.merge")
        pr = {
          ...pr,
          state: "MERGED",
          merged: true,
          closedIssueNodeIds: imported ? ["I1"] : [],
        };
      return {
        state: "confirmed-success",
        reason: null,
        receipt: {
          nodeId: record.request.action.kind.startsWith("pr.") ? "P7" : "C1",
          ...(record.request.action.kind === "pr.merge"
            ? { merged: true, headSha: pr.headSha }
            : {}),
        },
      };
    },
    async inspectAction(record) {
      if (record.request.action.kind === "project.field")
        return status === record.request.action.optionNodeId
          ? {
              state: "confirmed-success",
              reason: null,
              receipt: { nodeId: "target" },
            }
          : { state: "uncertain", reason: "unproved", receipt: null };
      return (
        inspectOutcome ?? {
          state: "uncertain",
          reason: "unproved",
          receipt: null,
        }
      );
    },
    async inspectPr(identity) {
      if (identity.expectedPrNodeId === otherPr?.nodeId) return otherPr;
      if (readFailure) throw new Error("unavailable");
      await inspectionHook?.();
      // GitHub lists only closed issues; a reopened one leaves the merged PR's list.
      return issueOpen === true ? { ...pr, closedIssueNodeIds: [] } : pr;
    },
  };
  const service = new StandaloneService(
    join(root, "data"),
    (context) => {
      spawnContext = context;
      return runtime;
    },
    undefined,
    {
      delivery: {
        providerFactories: { github: () => provider },
        issueTrackerFactories: { github: () => provider },
        ...(statusWriteTimeoutMs ? { statusWriteTimeoutMs } : {}),
      },
      issueTrackers: {
        readerFactories: {
          github: () => ({
            async readSelection() {
              return {
                complete: true,
                // Open-only discovery unless a test sets the issue state explicitly.
                issues:
                  issueOpen === undefined && pr.merged
                    ? []
                    : [
                        {
                          providerInstance: "github.com",
                          nodeId: "I1",
                          repositoryId: "R1",
                          repositoryName: "org/repo",
                          number: 1,
                          title: sourceTitle,
                          body: sourceBody,
                          state: issueOpen === false ? "closed" : "open",
                          labels: sourceLabels,
                          projectFields:
                            projectStatus && status
                              ? [
                                  {
                                    projectNodeId: fixtureProject.projectNodeId,
                                    fieldNodeId: fixtureProject.fieldNodeId,
                                    optionNodeId: status,
                                  },
                                ]
                              : [],
                          ...(projectStatus
                            ? { projectItemNodeId: fixtureProject.itemNodeId }
                            : {}),
                        },
                      ],
                reason: null,
              };
            },
            async readBlockers() {
              return { complete: true, blockers: [], reason: null };
            },
            async readIssueStatus() {
              return {
                status: (issueOpen ?? !pr.merged) ? "open" : "closed",
              };
            },
          }),
        },
      },
      power: { enabled: false },
    },
  );
  await service.start();
  const domain = service.domain();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Lead",
    instructions: "Lead",
    capabilities: "work",
  });
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "P",
    leadProfileId: profileId,
  });
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    instructions: "Deliver the scoped task and satisfy provider gates.",
  });
  if (imported) {
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: "env:FIXTURE_SOURCE",
      selections: [
        projectStatus
          ? {
              id: "repo",
              kind: "project",
              projectNodeId: fixtureProject.projectNodeId,
              filter: "",
            }
          : {
              id: "repo",
              kind: "repository",
              repositoryId: "R1",
              owner: "org",
              name: "repo",
            },
      ],
      readiness: {
        mode: "any",
        conditions: projectStatus
          ? [
              fixtureProject.todo,
              fixtureProject.inProgress,
              fixtureProject.inReview,
            ].map((optionNodeId) => ({
              kind: "project-field" as const,
              projectNodeId: fixtureProject.projectNodeId,
              fieldNodeId: fixtureProject.fieldNodeId,
              operator: "in" as const,
              optionNodeIds: [optionNodeId],
            }))
          : [{ kind: "label", operator: "has", name: "ready" }],
      },
    });
    domain.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId,
      selectionId: "repo",
      expectedVersion: 2,
    });
    await service.refreshGitHub();
    taskId = String(service.githubSources().issue("I1")?.taskId);
  } else
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title: "T",
      outcome: "O",
      ready: true,
    });
  domain.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    mode,
    credentialRef: null,
    grants: [
      { action: "issue.comment", repositoryId: "R1", mode: "allow" },
      { action: "issue.edit", repositoryId: "R1", mode: "allow" },
      { action: "issue.close", repositoryId: "R1", mode: "allow" },
      { action: "pr.merge", repositoryId: "R1", mode: "allow" },
      ...(projectStatus
        ? [
            {
              action: "project.field" as const,
              repositoryId: "R1",
              mode: "allow" as const,
              projectNodeId: fixtureProject.projectNodeId,
              fieldNodeId: fixtureProject.fieldNodeId,
              optionNodeIds: [
                fixtureProject.todo,
                fixtureProject.inProgress,
                fixtureProject.inReview,
                fixtureProject.done,
              ],
            },
          ]
        : []),
    ],
    requiredChecks: [],
  });
  await service.provisionTask(taskId);
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 2,
    paused: false,
  });
  async function waitTurn(index = 0) {
    const deadline = Date.now() + 5000;
    while (
      !turns[index] ||
      !service
        .list()
        .some((i) => i.turnId === turns[index]?.turnId && i.state === "running")
    ) {
      if (Date.now() > deadline) throw new Error("Bound turn did not start");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const turn = turns[index];
    assert.ok(turn);
    return turn;
  }
  const call = async (
    toolName: string,
    args: Record<string, unknown>,
    index = turns.length - 1,
  ) => {
    const turn = await waitTurn(index);
    assert.ok(tool);
    return tool({
      threadId: turn.threadId,
      turnId: turn.turnId,
      callId: randomUUID(),
      tool: toolName,
      arguments: args,
    });
  };
  await waitTurn();
  return {
    root,
    projectId,
    taskId,
    profileId,
    service,
    domain,
    effects,
    setActionOutcome: (value: ProviderActionObservation | undefined) => {
      actionOutcome = value;
    },
    setInspectOutcome: (value: ProviderActionObservation | undefined) => {
      inspectOutcome = value;
    },
    turns,
    call,
    waitTurn,
    spawn: () => spawnContext,
    setSourceBody: (body: string) => {
      sourceBody = body;
    },
    setSourceTitle: (title: string) => {
      sourceTitle = title;
    },
    /** A confirmed issue.edit effect updates the fake source, so a following sync observes it. */
    applyIssueEdits: (value: boolean) => {
      applyIssueEdits = value;
    },
    setSourceLabels: (labels: string[]) => {
      sourceLabels = labels;
    },
    /** The fixture issue's Project Status on the fake GitHub; the next source read observes it. */
    status: () => status,
    setStatus: (value: string | null) => {
      status = value;
    },
    /** A human move that lands with our next Status write, so its readback shows their option. */
    moveStatusAfterWrite: (value: string | undefined) => {
      movedAfterWrite = value;
    },
    /** Status writes' provider reads wait on this; other actions are unaffected. */
    holdStatusWrites: (value: Promise<void> | undefined) => {
      statusHold = value;
    },
    getPr: () => pr,
    setPr: (value: PrDeliveryObservation) => {
      pr = value;
    },
    setOtherPr: (value: PrDeliveryObservation) => {
      otherPr = value;
    },
    onPreflight: (hook: (() => void) | undefined) => {
      preflightHook = hook;
    },
    holdPreflight: (value: Promise<void> | undefined) => {
      preflightWait = value;
    },
    failReads: (value: boolean) => {
      readFailure = value;
    },
    /** The fresh closure read's answer; `undefined` restores the default. */
    setClosedIssue: (value: typeof closedIssue) => {
      closedIssue = value;
    },
    /** The source reader's issue state, read in full; `undefined` lists only an unmerged issue as open. */
    setIssueOpen: (value: boolean | undefined) => {
      issueOpen = value;
    },
    /** How many fresh closure reads the fake GitHub has served. */
    closedIssueReads: () => closedIssueReads,
    onInspection: (hook: (() => Promise<void> | void) | undefined) => {
      inspectionHook = hook;
    },
    async close() {
      stopped = true;
      waiter?.();
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The issue inspections of a fake that registers as both code-host provider and issue-tracker writer. */
export const unusedIssueInspection = {
  async inspectPublishedIssue(): Promise<never> {
    throw new Error("unused");
  },
  async inspectClosedIssue(): Promise<never> {
    throw new Error("unused");
  },
};

/** Registers one fake as GitHub's code-host provider and issue-tracker writer. */
export function githubFake(factory: CodeHostProviderFactory) {
  return {
    providerFactories: { github: factory },
    issueTrackerFactories: {
      github: ((...args) => ({
        ...unusedIssueInspection,
        ...factory(...args),
      })) satisfies CodeHostProviderFactory,
    },
  };
}
