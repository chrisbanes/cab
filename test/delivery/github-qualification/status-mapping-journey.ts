import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  DeliveryStore,
  isServiceDeliveryCaller,
  type PrDeliveryObservation,
  type RuntimeDeliveryCaller,
} from "../../../src/core/delivery.js";
import { DomainStore } from "../../../src/core/domain.js";
import { GitHubSourceStore } from "../../../src/core/github-source.js";
import { StatusMappingStore } from "../../../src/core/status-mapping.js";
import { Store } from "../../../src/core/store.js";
import { DeliveryCoordinator } from "../../../src/standalone/delivery.js";
import { GitHubHttpDeliveryProvider } from "../../../src/standalone/github-delivery.js";
import { GitHubHttpSourceReader } from "../../../src/standalone/github-source.js";
import type { ExecutionState } from "../../../src/standalone/state.js";
import {
  StatusMappingWriter,
  statusMappingEvent,
} from "../../../src/standalone/status-mapping.js";
import {
  harnessDocuments,
  issueTitle,
  projectFilters,
  projectTitle,
  type StatusMappingGuard,
  statusOptionNames,
} from "./status-mapping-fixture.js";

export interface StatusMappingJourneyOptions {
  guard: StatusMappingGuard;
  token: string;
  /** Which attempt this is, within the manifest's allowance. */
  attempt: number;
  /** Runs `gh` under its own login and returns stdout; the journey passes only guarded commands. */
  gh(args: string[]): string;
  /** The raw HTTP transport the guard wraps; tests pass a fake GitHub. */
  fetcher?: typeof fetch;
  /** Milliseconds between reads of a Project that does not list the new item yet; tests pass 0. */
  readRetryMs?: number;
  /** Milliseconds between tries of a `gh` command that hit a transient GitHub error; tests pass 0. */
  ghRetryMs?: number;
}

/** GitHub's own "try again" answers: the command did not take effect. */
const transientGhError =
  /temporary conflict|Please try again|HTTP 50[234]|Bad Gateway|Service Unavailable|Gateway Time-?out/i;
const ghTries = 3;
/** Creates are not repeated: an answer lost after the write would leave a second, unrecorded resource. */
const notRepeated = (args: string[]) =>
  args[1] === "create" && (args[0] === "project" || args[0] === "issue");

/** A Project lists a new item a little after it is added: read it again for at most this many times. */
const projectReads = 10;

const owner = "chrisbanes";

/**
 * One bounded run on a scratch user-owned Project linked to the fixture repository: a real sync of
 * one fixture issue, then the real status-mapping writer, delivery coordinator and provider write
 * `turnStarted` and `handedBack` (induced in local state, with no model turn) and `gh` reads each
 * Status back independently. The harness deletes the Project and closes the issue, then proves both.
 * Never throws for an assertion: returns the evidence with `qualification: "failed"`.
 */
export async function runStatusMappingJourney(
  options: StatusMappingJourneyOptions,
) {
  const { guard, token } = options;
  const readRetryMs = options.readRetryMs ?? 5000;
  const manifest = guard.manifest;
  const fullName = manifest.repository.fullName;
  const repositoryId = manifest.repository.nodeId;
  const runId = randomBytes(4).toString("hex");
  const redact = (text: string) => text.split(token).join("[redacted]");
  const evidence: Record<string, unknown> = {
    version: 1,
    repository: fullName,
    runId,
    attempt: options.attempt,
    turns: 0,
    qualification: "failed",
    cleanup: "unverified",
  };
  guard.begin(runId, options.attempt);
  const ghRetryMs = options.ghRetryMs ?? 2000;
  const gh = (args: string[]) => {
    guard.assertGh(args);
    for (let attempt = 1; ; attempt++) {
      try {
        return options.gh(args);
      } catch (error) {
        if (
          attempt >= ghTries ||
          notRepeated(args) ||
          !transientGhError.test(String((error as Error).message))
        )
          throw error;
        // shortcut: blocks the thread, which is fine in a single-run script; upgrade if the harness goes concurrent.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ghRetryMs);
      }
    }
  };
  const json = (args: string[]) => JSON.parse(gh(args)) as unknown;
  const raw = options.fetcher ?? fetch;
  const guardedFetch: typeof fetch = async (input, init) => {
    guard.assertRequest(input, init);
    return raw(input, { ...init, redirect: init?.redirect ?? "error" });
  };
  const db = new DatabaseSync(":memory:");
  let project: { nodeId: string; number: number } | undefined;
  let issue: number | undefined;
  try {
    // Fixture identity, visibility and the login's scopes, from reads, before anything is written.
    const scopes =
      /^x-oauth-scopes:\s*(.*)$/im.exec(gh(["api", "-i", "/user"]))?.[1] ?? "";
    if (!scopes.split(",").some((s) => s.trim() === "project"))
      throw new Error("The gh login lacks the project scope");
    const repo = (await (
      await guardedFetch(`https://api.github.com/repos/${fullName}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { node_id: string; private: boolean };
    if (repo.node_id !== repositoryId)
      throw new Error("Fixture identity does not match the manifest");
    guard.assertRepositoryVisibility(repo.private);

    // 1-2. The scratch Project, linked to the fixture repository only.
    const created = json([
      "project",
      "create",
      "--owner",
      owner,
      "--title",
      projectTitle(runId),
      "--format",
      "json",
    ]) as { id: string; number: number };
    project = { nodeId: created.id, number: created.number };
    // Known before anything else can fail, so cleanup deletes it even when the run does not finish.
    guard.recordProject({ ...project, linkedRepositories: [] });
    gh([
      "project",
      "link",
      String(project.number),
      "--owner",
      owner,
      "--repo",
      fullName,
    ]);
    const linked = (
      json([
        "api",
        "graphql",
        "-f",
        `query=${harnessDocuments.projectLinks}`,
        "-f",
        `project=${project.nodeId}`,
      ]) as {
        data: {
          node: { repositories: { nodes: { nameWithOwner: string }[] } };
        };
      }
    ).data.node.repositories.nodes.map((n) => n.nameWithOwner);
    guard.recordProject({ ...project, linkedRepositories: linked });
    evidence.project = { nodeId: project.nodeId, number: project.number };

    // 3. Its Status options: Todo / In Progress / In review / Done, with one field update.
    const fields = json([
      "project",
      "field-list",
      String(project.number),
      "--owner",
      owner,
      "--format",
      "json",
    ]) as { fields: { id: string; name: string }[] };
    const statusField = fields.fields.find((f) => f.name === "Status");
    if (!statusField) throw new Error("The scratch Project has no Status");
    guard.recordField(statusField.id, []);
    const updated = json([
      "api",
      "graphql",
      "-f",
      `query=${harnessDocuments.setStatusOptions}`,
      "-f",
      `field=${statusField.id}`,
    ]) as {
      data: {
        updateProjectV2Field: {
          projectV2Field: {
            id: string;
            options: { id: string; name: string }[];
          };
        };
      };
    };
    const options = updated.data.updateProjectV2Field.projectV2Field.options;
    const optionId = (name: string) => {
      const found = options.find((o) => o.name === name)?.id;
      if (!found) throw new Error(`No Status option ${name}`);
      return found;
    };
    if (options.map((o) => o.name).join("|") !== statusOptionNames.join("|"))
      throw new Error("The Status options are not the granted four");
    guard.recordField(
      statusField.id,
      options.map((o) => o.id),
    );

    // 4. One fixture issue in the Project at Todo.
    const issueUrl = gh([
      "issue",
      "create",
      "--repo",
      fullName,
      "--title",
      issueTitle(runId),
      "--body",
      `Created by the status mapping qualification run ${runId}; closed by the harness.`,
    ]).trim();
    issue = Number(/\/issues\/(\d+)$/.exec(issueUrl)?.[1]);
    if (!Number.isInteger(issue)) throw new Error("No fixture issue number");
    guard.recordIssue(issue);
    const added = json([
      "project",
      "item-add",
      String(project.number),
      "--owner",
      owner,
      "--url",
      issueUrl,
      "--format",
      "json",
    ]) as { id: string };
    guard.recordItem(added.id);
    gh([
      "project",
      "item-edit",
      "--id",
      added.id,
      "--project-id",
      project.nodeId,
      "--field-id",
      statusField.id,
      "--single-select-option-id",
      optionId("Todo"),
    ]);

    // 5. The service's own stores: a project, a Project source, grants, the mapping.
    new Store(db).ensureHost("status-mapping-qualification");
    const domain = new DomainStore(db);
    domain.migrate();
    const sources = new GitHubSourceStore(db);
    sources.migrate();
    const store = new DeliveryStore(db);
    const mappings = new StatusMappingStore(db);
    const projectId = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Status mapping qualification",
      leadProfileId: null,
    });
    const selection = {
      id: "project",
      kind: "project" as const,
      projectNodeId: project.nodeId,
      filter: projectFilters[0],
    };
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: null,
      selections: [selection],
      readiness: {
        mode: "any",
        conditions: ["Todo", "In Progress", "In review"].map((name) => ({
          kind: "project-field" as const,
          projectNodeId: project?.nodeId ?? "",
          fieldNodeId: statusField.id,
          optionNodeId: optionId(name),
        })),
      },
      repositories: [],
    });
    domain.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId,
      selectionId: "project",
      expectedVersion: 2,
    });
    domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: [
        {
          action: "project.field",
          repositoryId,
          mode: "allow",
          projectNodeId: project.nodeId,
          fieldNodeId: statusField.id,
          optionNodeIds: options.map((o) => o.id),
        },
      ],
      requiredChecks: [],
    });
    domain.execute({
      type: "status-mapping.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      mapping: {
        selectionId: "project",
        projectNodeId: project.nodeId,
        fieldNodeId: statusField.id,
        events: {
          turnStarted: optionId("In Progress"),
          handedBack: optionId("In review"),
          held: null,
          done: optionId("Done"),
        },
      },
    });

    // 6. One real sync of the Project.
    const reader = new GitHubHttpSourceReader(token, guardedFetch);
    // Reads alternate between the granted filters until the Project lists its one item.
    let snapshot = await reader.readSelection(selection);
    let reads = 1;
    while (
      reads < projectReads &&
      (!snapshot.complete || snapshot.issues.length !== 1)
    ) {
      await new Promise((resolve) => setTimeout(resolve, readRetryMs));
      snapshot = await reader.readSelection({
        ...selection,
        filter: projectFilters[reads % projectFilters.length] ?? "",
      });
      reads++;
    }
    evidence.projectReads = {
      reads,
      filter: projectFilters[(reads - 1) % projectFilters.length],
      complete: snapshot.complete,
      reason: snapshot.reason,
      issues: snapshot.issues.length,
    };
    if (!snapshot.complete || snapshot.issues.length !== 1) {
      // Whether GitHub itself lists the item, to tell a read problem from a late listing.
      const listed = json([
        "project",
        "item-list",
        String(project.number),
        "--owner",
        owner,
        "--format",
        "json",
      ]) as { items: unknown[] };
      evidence.itemsListedByGh = listed.items.length;
      throw new Error(
        `The Project read was ${snapshot.complete ? `${snapshot.issues.length} issues` : snapshot.reason}`,
      );
    }
    sources.reconcileSelection(projectId, "project", snapshot);
    const imported = snapshot.issues[0];
    const taskId = String(sources.issue(imported?.nodeId ?? "")?.taskId);
    if (domain.task(taskId).ready !== 1)
      throw new Error("The imported task is not Ready");
    if (imported?.projectItemNodeId !== added.id)
      throw new Error("The sync did not record the Project item");

    // 7-8. The real writer, coordinator and provider. The two events are induced in local state.
    let started = false;
    const state = {
      taskHold: () => undefined,
      taskStartedTurnCount: () => (started ? 1 : 0),
    } as unknown as ExecutionState;
    const facts = { domain, state, deliveryStore: store, mappings };
    const coordinator = new DeliveryCoordinator(store, {
      providerFactory: () =>
        new GitHubHttpDeliveryProvider(token, guardedFetch),
      // The service's own check: the event the write was minted for is still the task's.
      authorize: (caller) => {
        if (
          !isServiceDeliveryCaller(caller) ||
          statusMappingEvent(facts, caller.taskId) !== caller.event
        )
          throw new Error("stale or foreign caller");
      },
      approved: () => false,
    });
    const writer = new StatusMappingWriter(
      facts,
      mappings,
      sources,
      coordinator,
    );
    const written = () =>
      store.actions(taskId).filter((a) => isServiceDeliveryCaller(a.binding));
    const statusOnGitHub = () => {
      const listed = json([
        "project",
        "item-list",
        String(project?.number),
        "--owner",
        owner,
        "--format",
        "json",
      ]) as { items: { id: string; status?: string }[] };
      return listed.items.find((i) => i.id === added.id)?.status ?? null;
    };
    const event = async (
      name: "turnStarted" | "handedBack",
      expected: (typeof statusOptionNames)[number],
    ) => {
      await writer.run();
      const record = written().at(-1);
      const caller = record?.binding;
      if (
        record?.state !== "confirmed-success" ||
        !caller ||
        !isServiceDeliveryCaller(caller) ||
        caller.event !== name
      )
        throw new Error(
          `${name}: ${record?.state ?? "no write"} (${record?.observation?.reason ?? "no reason"})`,
        );
      const independent = statusOnGitHub();
      if (independent !== expected)
        throw new Error(`${name}: GitHub shows ${independent}`);
      return {
        operationId: record.operationId,
        state: record.state,
        providerReadback: "confirmed",
        independentReadback: independent,
      };
    };
    started = true;
    const turnStarted = await event("turnStarted", "In Progress");
    const lead = randomUUID();
    const observation: PrDeliveryObservation = {
      repositoryId,
      nodeId: "PR_local_state",
      number: 1,
      baseRef: "qualification",
      headRef: "local-state",
      headSha: "1".repeat(40),
      baseSha: "2".repeat(40),
      state: "OPEN",
      draft: false,
      merged: false,
      reviewDecision: null,
      checks: [],
      mergeBlockers: [],
      closedIssueNodeIds: [],
      allowedMethods: [],
    };
    const runtimeCaller: RuntimeDeliveryCaller = {
      projectId,
      taskId,
      taskVersion: 1,
      assignmentId: lead,
      assignmentVersion: 1,
      workId: "local-state",
      workRevision: 1,
      conversationRevision: 1,
    };
    store.transaction(() =>
      store.registerPrWithinTransaction(runtimeCaller, observation, lead),
    );
    const handedBack = await event("handedBack", "In review");
    // A pass with nothing new writes nothing.
    await writer.run();
    if (written().length !== 2)
      throw new Error("A pass with no transition wrote again");
    await coordinator.stop();

    const text = JSON.stringify({ turnStarted, handedBack });
    if (text.includes(token)) throw new Error("The credential was exposed");
    Object.assign(evidence, {
      qualification: "passed",
      turnStarted,
      handedBack,
      credentialExposures: 0,
      limits:
        "Event origin is covered by the deterministic service tests; this run covers the real Project write, re-read and readback path.",
    });
  } catch (error) {
    evidence.failure = redact(
      String(error instanceof Error ? error.message : error),
    );
  } finally {
    // The harness owns cleanup: close the issue, delete the Project, then prove both.
    try {
      // Each step is attempted whatever the others did; the proofs below decide the outcome.
      const attempts: string[] = [];
      const attempt = (run: () => void) => {
        try {
          run();
        } catch (error) {
          attempts.push(redact(String(error)));
        }
      };
      if (issue !== undefined)
        attempt(() =>
          gh(["issue", "close", String(issue), "--repo", fullName]),
        );
      if (project)
        attempt(() =>
          gh(["project", "delete", String(project?.number), "--owner", owner]),
        );
      if (attempts.length) evidence.cleanupErrors = attempts;
      // A deleted Project no longer resolves: GitHub answers the read with a not-found error.
      const gone = project
        ? (() => {
            try {
              return (
                (
                  JSON.parse(
                    gh([
                      "api",
                      "graphql",
                      "-f",
                      `query=${harnessDocuments.projectExists}`,
                      "-f",
                      `project=${project.nodeId}`,
                    ]),
                  ) as { data: { node: unknown } }
                ).data.node === null
              );
            } catch (error) {
              return /Could not resolve to a node/.test(String(error));
            }
          })()
        : true;
      const closed =
        issue === undefined ||
        gh([
          "api",
          `repos/${fullName}/issues/${issue}`,
          "--jq",
          ".state",
        ]).trim() === "closed";
      evidence.cleanup = gone && closed ? "verified" : "unverified";
      if (project) evidence.deletedProject = { ...project, deleted: gone };
    } catch (error) {
      evidence.cleanup = "unverified";
      evidence.cleanupFailure = redact(
        String(error instanceof Error ? error.message : error),
      );
    }
    evidence.writes = guard.writes;
    db.close();
  }
  return evidence;
}
