import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ExternalAction,
  ProviderActionObservation,
} from "../../src/core/delivery.js";
import type { IssueSnapshot } from "../../src/core/github-source.js";
import type { Readiness } from "../../src/core/github-source-contracts.js";
import type { Runtime } from "../../src/standalone/codex.js";
import type { CodeHostDeliveryProvider } from "../../src/standalone/code-host.js";
import type { IssueTrackerWriter } from "../../src/standalone/issue-tracker.js";
import type { PublishedIssueInspection } from "../../src/standalone/github-delivery.js";
import type { GitHubReaderFactory } from "../../src/standalone/github-sync.js";
import { StandaloneService } from "../../src/standalone/service.js";

export const publicationProject = {
  projectNodeId: "PRJ1",
  fieldNodeId: "FLD1",
  ready: "O_READY",
  other: "O_OTHER",
} as const;

type FakeIssue = {
  nodeId: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  /** Project node id to item node id. */
  items: Map<string, string>;
  /** `<project>/<field>` to option. */
  fields: Map<string, string>;
  /** Not yet listed by the credential user's issue list, as a lagging index would be. */
  hidden: boolean;
};

export const marker = (operationId: string) =>
  `<!-- cab-operation:${operationId} -->`;

/** A GitHub that holds issues, Projects and counts every write the provider sends. */
export class FakeGitHub {
  readonly issues = new Map<number, FakeIssue>();
  next = 1;
  posts = 0;
  itemAdds = 0;
  fieldWrites = 0;
  readonly order: string[] = [];
  /** How a create ends: confirmed; created but the response lost; or lost before it landed. */
  createMode: "ok" | "lost" | "lost-unseen" | "rejected" = "ok";
  /** Whether a lost create can be found by the read-back. */
  readbackVisible = true;
  itemMode: "ok" | "rejected" | "uncertain" | "retry" = "ok";
  /** Read-backs wait on this, so a test can act while one is in flight. */
  inspectGate: Promise<void> | undefined;
  /** Runs when an item add arrives, before it takes effect. */
  beforeItemAdd: (() => Promise<void>) | undefined;
  fieldMode: "ok" | "rejected" | "uncertain" = "ok";
  nodeSequence = 0;

  /** An issue created outside cab, as a human would. */
  add(title: string, body: string, labels: string[] = []): FakeIssue {
    const number = this.next++;
    const issue: FakeIssue = {
      nodeId: `I_${number}`,
      number,
      title,
      body,
      labels,
      state: "open",
      items: new Map(),
      fields: new Map(),
      hidden: false,
    };
    this.issues.set(number, issue);
    return issue;
  }
  byMarker(operationId: string) {
    return [...this.issues.values()].filter((i) =>
      i.body.includes(marker(operationId)),
    );
  }
  snapshots(selection: {
    kind: string;
    projectNodeId?: string;
  }): IssueSnapshot[] {
    return [...this.issues.values()]
      .filter(
        (i) =>
          i.state === "open" &&
          (selection.kind !== "project" ||
            i.items.has(selection.projectNodeId ?? "")),
      )
      .map((i) => ({
        providerInstance: "github.com" as const,
        nodeId: i.nodeId,
        repositoryId: "R1",
        repositoryName: "org/repo",
        number: i.number,
        title: i.title,
        body: i.body,
        state: i.state,
        labels: i.labels,
        projectFields:
          selection.kind === "project"
            ? [...i.fields].map(([key, optionNodeId]) => {
                const [projectNodeId = "", fieldNodeId = ""] = key.split("/");
                return { projectNodeId, fieldNodeId, optionNodeId };
              })
            : [],
        ...(selection.kind === "project" &&
        i.items.has(selection.projectNodeId ?? "")
          ? {
              projectItemNodeId: String(
                i.items.get(selection.projectNodeId ?? ""),
              ),
            }
          : {}),
      }));
  }
  /** The source reader over this GitHub, for a service's `issueTrackers.readerFactories.github`. */
  readerFactory(): GitHubReaderFactory {
    return () => ({
      readSelection: async (selection) => ({
        complete: true,
        issues: this.snapshots(selection),
        reason: null,
      }),
      readBlockers: async () => ({
        complete: true,
        blockers: [],
        reason: null,
      }),
      readIssueStatus: async () => ({ status: "open" }),
    });
  }
  provider(): CodeHostDeliveryProvider & IssueTrackerWriter {
    const gh = this;
    const find = (action: ExternalAction) =>
      "number" in action.target
        ? gh.issues.get(action.target.number)
        : undefined;
    return {
      async preflight(action) {
        if (action.kind === "issue.create")
          return { repositoryPath: "/repos/org/repo" };
        return { repositoryPath: "/repos/org/repo", nodeId: "target" };
      },
      async performAction(record) {
        const a = record.request.action;
        gh.order.push(a.kind);
        if (a.kind === "issue.create") {
          gh.posts++;
          if (gh.createMode === "rejected")
            return {
              state: "confirmed-failure",
              reason: "provider-http-422",
              receipt: null,
            };
          if (gh.createMode !== "lost-unseen") {
            const issue = gh.add(
              a.title,
              `${a.body}\n\n${marker(record.operationId)}`,
              a.labels,
            );
            issue.hidden = !gh.readbackVisible;
          }
          if (gh.createMode !== "ok")
            return {
              state: "uncertain",
              reason: "provider-effect-unproved",
              receipt: null,
            };
          return this.inspectAction(record);
        }
        if (a.kind === "project.item.add") {
          gh.itemAdds++;
          await gh.beforeItemAdd?.();
          if (gh.itemMode === "retry")
            return {
              state: "confirmed-failure",
              reason: "provider-http-429",
              receipt: null,
              retryable: true,
              resumeAt: Date.now() + 3_600_000,
            };
          if (gh.itemMode === "rejected")
            return {
              state: "confirmed-failure",
              reason: "provider-http-403",
              receipt: null,
            };
          if (gh.itemMode === "uncertain")
            return {
              state: "uncertain",
              reason: "provider-effect-unproved",
              receipt: null,
            };
          find(a)?.items.set(a.projectNodeId, `ITEM_${++gh.nodeSequence}`);
          return this.inspectAction(record);
        }
        if (a.kind === "project.field") {
          gh.fieldWrites++;
          if (gh.fieldMode === "rejected")
            return {
              state: "confirmed-failure",
              reason: "provider-http-403",
              receipt: null,
            };
          if (gh.fieldMode === "uncertain")
            return {
              state: "uncertain",
              reason: "provider-effect-unproved",
              receipt: null,
            };
          find(a)?.fields.set(
            `${a.projectNodeId}/${a.fieldNodeId}`,
            a.optionNodeId,
          );
          return this.inspectAction(record);
        }
        throw new Error(`unexpected ${a.kind}`);
      },
      async inspectAction(record): Promise<ProviderActionObservation> {
        if (gh.inspectGate) await gh.inspectGate;
        const a = record.request.action;
        const unproved: ProviderActionObservation = {
          state: "uncertain",
          reason: "provider-effect-unproved",
          receipt: null,
        };
        if (a.kind === "issue.create") {
          const found = gh
            .byMarker(record.operationId)
            .filter((i) => !i.hidden);
          const issue = found[0];
          return found.length === 1 && issue
            ? {
                state: "confirmed-success",
                reason: null,
                receipt: { nodeId: issue.nodeId, number: issue.number },
              }
            : unproved;
        }
        if (a.kind === "project.item.add") {
          const item = find(a)?.items.get(a.projectNodeId);
          return item
            ? {
                state: "confirmed-success",
                reason: null,
                receipt: { nodeId: item },
              }
            : unproved;
        }
        if (a.kind === "project.field")
          return find(a)?.fields.get(`${a.projectNodeId}/${a.fieldNodeId}`) ===
            a.optionNodeId
            ? {
                state: "confirmed-success",
                reason: null,
                receipt: { nodeId: "target" },
              }
            : unproved;
        return unproved;
      },
      async inspectPr() {
        throw new Error("no pull requests here");
      },
      async inspectClosedIssue() {
        throw new Error("no closed issues here");
      },
      async inspectPublishedIssue(
        target,
        operationId,
      ): Promise<PublishedIssueInspection> {
        const issue = gh.issues.get(target.number);
        if (!issue) throw new Error("provider-http-404");
        return {
          nodeId: issue.nodeId,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          labels: issue.labels,
          byCredentialUser: true,
          hasMarker: issue.body.includes(marker(operationId)),
        };
      },
    };
  }
}

const git = promisify(execFile);
export async function checkout(directory: string) {
  const path = join(directory, "checkout");
  await git("git", ["init", "-q", "-b", "main", path]);
  writeFileSync(join(path, "README.md"), "Fixture\n");
  await git("git", ["-C", path, "add", "README.md"]);
  await git("git", [
    "-C",
    path,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-q",
    "-m",
    "Fixture",
  ]);
  return path;
}

export const noRuntime: Runtime = {
  async start() {},
  async stop() {},
  onUnexpectedRequest() {},
  onToolCall() {},
  async startThread() {
    return "thread";
  },
  async resumeThread() {},
  async startTurn() {
    return "turn";
  },
  async interruptTurn() {},
  async waitForTurn() {
    return "completed";
  },
};

export type PublicationFixtureOptions = {
  /** The selections the source reads, in order. */
  selections?: ("repo" | "project" | "search" | "filtered")[];
  readiness?: Readiness | null;
  grants?: ("create" | "item" | "field")[];
  mode?: "allow" | "approval";
};

const labelReady: Readiness = {
  mode: "any",
  conditions: [{ kind: "label", operator: "has", name: "ready" }],
};
export const fieldReady: Readiness = {
  mode: "any",
  conditions: [
    {
      kind: "project-field",
      projectNodeId: publicationProject.projectNodeId,
      fieldNodeId: publicationProject.fieldNodeId,
      operator: "in",
      optionNodeIds: [publicationProject.ready],
    },
  ],
};
export const labelAndFieldReady: Readiness = {
  mode: "all",
  conditions: [...labelReady.conditions, ...fieldReady.conditions],
};

/**
 * A project with a GitHub source over the fake GitHub, no lead (so no turn ever starts) and publish
 * grants, on a started service. The delivery credential is set once the runtime has started: the
 * activation guard refuses a credential its environment snapshot holds.
 */
export async function seedPublication(
  service: () => StandaloneService,
  directory: string,
  options: PublicationFixtureOptions = {},
) {
  const projectId = randomUUID();
  const path = await checkout(directory);
  process.env.FIXTURE_DELIVERY = "fixture-delivery-credential";
  const domain = () => service().domain();
  domain().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "P",
    leadProfileId: null,
  });
  const defs = {
    repo: {
      id: "repo",
      kind: "repository" as const,
      repositoryId: "R1",
      owner: "org",
      name: "repo",
    },
    project: {
      id: "project",
      kind: "project" as const,
      projectNodeId: publicationProject.projectNodeId,
      filter: "",
    },
    filtered: {
      id: "filtered",
      kind: "project" as const,
      projectNodeId: publicationProject.projectNodeId,
      filter: "label:bug",
    },
    search: { id: "search", kind: "search" as const, query: "repo:org/repo" },
  };
  const chosen = options.selections ?? ["repo", "project"];
  await domain().configureRepositories({
    type: "repositories.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    repositories: [
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: "R1",
        path,
        ref: "main",
      },
    ],
  });
  domain().execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    credentialRef: "env:FIXTURE_SOURCE",
    selections: chosen.map((s) => defs[s]),
    readiness: options.readiness === undefined ? labelReady : options.readiness,
  });
  for (const s of chosen)
    domain().execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId,
      selectionId: s,
      expectedVersion: 2,
    });
  const allowed = options.grants ?? ["create", "item", "field"];
  const mode = options.mode ?? "allow";
  const configureGrants = (grants: typeof allowed) =>
    domain().execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: service().delivery().configuration(projectId).version,
      mode: "reviewable-pr",
      credentialRef: "env:FIXTURE_DELIVERY",
      grants: [
        ...(grants.includes("create")
          ? [{ action: "issue.create" as const, repositoryId: "R1", mode }]
          : []),
        ...(grants.includes("item")
          ? [
              {
                action: "project.item.add" as const,
                repositoryId: "R1",
                mode,
                projectNodeId: publicationProject.projectNodeId,
              },
            ]
          : []),
        ...(grants.includes("field")
          ? [
              {
                action: "project.field" as const,
                repositoryId: "R1",
                mode,
                projectNodeId: publicationProject.projectNodeId,
                fieldNodeId: publicationProject.fieldNodeId,
                optionNodeIds: [
                  publicationProject.ready,
                  publicationProject.other,
                ],
              },
            ]
          : []),
      ],
      requiredChecks: [],
    });
  configureGrants(allowed);
  const task = (ready: boolean, title = "Publish me", outcome = "Do it") => {
    const taskId = randomUUID();
    domain().execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title,
      outcome,
      ready,
    });
    return taskId;
  };
  const version = (taskId: string) => Number(domain().task(taskId).version);
  const target = (taskId: string, selectionId: string) => {
    const found = service()
      .publicationAvailability(taskId)
      .targets.find((t) => t.selectionId === selectionId);
    assert.ok(found, `no target for ${selectionId}`);
    return found;
  };
  /** Review, confirm and send to the target; returns where the publication ended up. */
  const publish = async (taskId: string, selectionId = "repo") => {
    const review = service().reviewTaskPublication({
      key: randomUUID(),
      taskId,
      targetId: target(taskId, selectionId).id,
      expectedTaskVersion: version(taskId),
    });
    service().confirmTaskPublication({
      key: randomUUID(),
      taskId,
      reviewId: review.publicationId,
      expectedRevision: review.revision,
      materialHash: review.materialHash,
      decision: "approved",
    });
    const sent = await service().sendTaskPublication({
      taskId,
      publicationId: review.publicationId,
      expectedTaskVersion: version(taskId),
    });
    return { review, sent };
  };
  const taskCount = () => domain().tasks(projectId).length;
  return {
    projectId,
    domain,
    task,
    version,
    target,
    publish,
    taskCount,
    configureGrants,
    release: () => {
      delete process.env.FIXTURE_DELIVERY;
    },
  };
}

/** A started service over the fake GitHub with a seeded publishing project. */
export async function publicationFixture(
  options: PublicationFixtureOptions = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cab-publication-"))),
    gh = new FakeGitHub(),
    /** The host each provider or writer was built for, as the repository link or task source names it. */
    hosts: string[] = [];
  const build = () =>
    new StandaloneService(join(root, "data"), () => noRuntime, undefined, {
      delivery: {
        providerFactories: {
          github: (_project, _policy, host) => {
            hosts.push(host);
            return gh.provider();
          },
        },
        issueTrackerFactories: {
          github: (_project, _policy, instance) => {
            hosts.push(instance);
            return gh.provider();
          },
        },
      },
      issueTrackers: { readerFactories: { github: gh.readerFactory() } },
      power: { enabled: false },
    });
  let service = build();
  await service.start();
  const seeded = await seedPublication(() => service, root, options);
  return {
    ...seeded,
    root,
    gh,
    hosts,
    get service() {
      return service;
    },
    /** Stops the service and opens another on the same data, as a restart. */
    async restart() {
      await service.stop();
      service = build();
      await service.start();
    },
    async close() {
      await service.stop();
      seeded.release();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
