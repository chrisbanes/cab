import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { isServiceDeliveryCaller } from "../../../src/core/delivery.js";
import { StatusMappingRefusal } from "../../../src/core/status-mapping.js";
import type { StatusMappingEvent } from "../../../src/core/status-mapping-contracts.js";
import {
  type AdoptFunction,
  adoptOutsideHead,
} from "../../../src/standalone/git-fetch.js";
import { pushTaskCommit } from "../../../src/standalone/git-push.js";
import type { PushFunction } from "../../../src/standalone/github-delivery.js";
import type { RateLimitPolicy } from "../../../src/standalone/gitlab-http.js";
import { adfParagraph } from "../../fixtures/fake-jira.js";
import {
  publicationWorld,
  until,
} from "../../fixtures/delivery-integration.js";
import { git } from "../../fixtures/publication.js";
import {
  cleanUp,
  harnessApi,
  type CleanupRead,
  type HarnessApi,
} from "../gitlab-qualification/gitlab-cleanup.js";
import {
  type GitLabGuard,
  qualificationProject,
} from "../gitlab-qualification/gitlab-guard.js";
import { type JiraRateLimit, cleanUpJira, jiraApi } from "./jira-cleanup.js";
import {
  type JiraGuard,
  qualificationSite,
  runJql,
  runLabel,
  summaryOf,
} from "./jira-guard.js";

const { host, projectKey, projectId } = qualificationSite;
const {
  id: repositoryId,
  path: projectPath,
  host: gitlabHost,
} = qualificationProject;
const base = `/api/v4/projects/${repositoryId}`;
/** The fixture project's statuses, and the readiness field and option (#1325). */
const status = { todo: "10003", progress: "3", review: "10004", done: "10005" };
const priority = { fieldId: "customfield_10045", high: "10022" };

export interface JiraQualificationOptions {
  jira: JiraGuard;
  gitlab: GitLabGuard;
  /** The raw HTTP transports the guards wrap; production passes `fetch`, tests a scripted site. */
  jiraFetcher: typeof fetch;
  gitlabFetcher: typeof fetch;
  /** The checkout the run clones; its `main` must equal the project's. */
  source: string;
  push?: PushFunction;
  adopt?: AdoptFunction;
  /** Waits between polls of Jira's search; tests pass a no-op. */
  pause?: () => Promise<void>;
  /** The most polls one wait makes (10 by default). */
  maxPolls?: number;
  rateLimit?: { jira?: JiraRateLimit; gitlab?: RateLimitPolicy };
}

type Step = { step: string; result: "passed" | "failed"; detail?: string };
type Write = {
  event: string;
  state: string;
  reason: string | null;
};

/** What a run reports: every field is a status, a count or an identifier, never a credential value. */
export interface JiraEvidence {
  runId: string;
  site: typeof qualificationSite;
  project: { host: string; id: string; path: string };
  qualification: "passed" | "failed";
  cleanup: "not-run" | "verified" | "failed";
  failure?: string;
  account?: { jira: string; gitlab: number };
  gitlabVersion?: string;
  issues?: {
    a: { id: string; key: string };
    blocker: { id: string; key: string };
  };
  mergeRequest?: { iid: number };
  /** The links issue A showed: read directly after the link was made, and in the latest search. */
  links?: {
    afterCreate?: ReturnType<typeof linkSummary>;
    lastSearch?: ReturnType<typeof linkSummary>;
  };
  /** Polls the harness's own JQL read made before the index showed what the step waited for. */
  polls: Record<string, number>;
  steps: Step[];
  /** What the live prerequisites of the plan showed. */
  prerequisites: Record<string, string>;
  statusWrites: Write[];
  cleanupReads: CleanupRead[];
  writes?: { jira: number; gitlab: number; merges: number };
  requests?: { jira: JiraGuard["log"]; gitlab: GitLabGuard["log"] };
  requestCounts?: { jira: JiraGuard["counts"]; gitlab: GitLabGuard["counts"] };
  rateLimited?: {
    jira: JiraGuard["rateLimited"];
    gitlab: GitLabGuard["rateLimited"];
  };
  lastRateHeaders?: JiraGuard["lastRateHeaders"];
  source?: { revision: string; node: string };
}

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const id = z.string().regex(/^\d{1,20}$/);
/** The few fields of each response the run reads; anything else is a failure, not a guess. */
const linkType = z
  .object({
    name: z.string().optional(),
    inward: z.string(),
    outward: z.string().optional(),
  })
  .passthrough();
const shapes = {
  myself: z.object({ accountId: z.string().min(1) }),
  statuses: z.array(
    z.object({
      id,
      name: z.string(),
      statuses: z.array(z.object({ id: z.string() })),
    }),
  ),
  created: z.object({ id, key: z.string().regex(/^KAN-[1-9]\d{0,8}$/) }),
  search: z.object({
    issues: z.array(
      z.object({
        id,
        fields: z.object({
          status: z.object({ id: z.string() }),
          labels: z.array(z.string()),
          issuelinks: z
            .array(
              z
                .object({
                  type: linkType,
                  inwardIssue: z
                    .object({
                      key: z.string(),
                      fields: z.object({
                        status: z.object({
                          statusCategory: z.object({ key: z.string() }),
                        }),
                      }),
                    })
                    .optional(),
                  outwardIssue: z.object({ key: z.string() }).optional(),
                })
                .passthrough(),
            )
            .default([]),
        }),
      }),
    ),
  }),
  links: z.object({
    fields: z.object({
      issuelinks: z.array(
        z
          .object({
            type: linkType,
            inwardIssue: z.object({ key: z.string() }).optional(),
            outwardIssue: z.object({ key: z.string() }).optional(),
          })
          .passthrough(),
      ),
    }),
  }),
  issue: z.object({
    fields: z.object({
      status: z.object({ id: z.string() }),
      labels: z.array(z.string()),
    }),
  }),
  transitions: z.object({
    transitions: z.array(
      z.object({ id: z.string(), to: z.object({ id: z.string() }) }),
    ),
  }),
  changelog: z.object({
    values: z.array(
      z.object({
        id,
        author: z.object({ accountId: z.string() }).optional(),
        items: z.array(
          z.object({ field: z.string(), to: z.string().nullish() }),
        ),
      }),
    ),
  }),
  version: z.object({ version: z.string() }),
  project: z.object({ id: z.number().int(), path_with_namespace: z.string() }),
  branch: z.object({ commit: z.object({ id: sha }) }),
  user: z.object({ id: z.number().int() }),
};

/** Which way a link reads from an issue, and to which issue: type, direction and other key, nothing else. */
const linkSummary = (
  links: Array<{
    type: z.output<typeof linkType>;
    inwardIssue?: { key: string } | undefined;
    outwardIssue?: { key: string } | undefined;
  }>,
) =>
  links.map((l) => ({
    type: l.type.name ?? "",
    direction: l.inwardIssue ? ("inward" as const) : ("outward" as const),
    label: l.inwardIssue ? l.type.inward : (l.type.outward ?? ""),
    other: l.inwardIssue?.key ?? l.outwardIssue?.key ?? "",
  }));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The bounded Jira + GitLab qualification: one journey through the real service, delivery coordinator,
 * Jira source and writer and GitLab provider, with the fixture's scripted lead runtime (no model turns).
 * Two Jira issues are created (A, blocked by B); A is imported, held, unblocked, started, commented on,
 * labelled, pushed and opened as a merge request keyed to it, handed back with a status write that skips
 * because a person moved the issue, settled and closed. Nothing merges. Cleanup deletes only what the
 * guards recorded and counts toward pass or fail. Returns evidence that holds no credential value.
 */
export async function runJiraQualification(
  options: JiraQualificationOptions,
): Promise<JiraEvidence> {
  const { jira: jiraGuard, gitlab: gitlabGuard } = options;
  const runId = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(2).toString("hex")}`;
  const label = runLabel(runId);
  jiraGuard.bindRun(runId);
  const evidence: JiraEvidence = {
    runId,
    site: qualificationSite,
    project: { host: gitlabHost, id: repositoryId, path: projectPath },
    qualification: "failed",
    cleanup: "not-run",
    polls: {},
    steps: [],
    prerequisites: {},
    statusWrites: [],
    cleanupReads: [],
  };
  // Read once, so nothing that is reported can carry a value.
  const email = process.env.CAB_JIRA_EMAIL ?? "";
  const token = process.env.CAB_JIRA_API_TOKEN ?? "";
  const gitlabToken = process.env.CAB_GITLAB_TOKEN ?? "";
  const clean = (value: unknown) =>
    [email, token, gitlabToken].reduce<string>(
      (text, secret) => (secret ? text.replaceAll(secret, "[redacted]") : text),
      String(value),
    );
  const pass = (step: string, detail?: string) =>
    evidence.steps.push({
      step,
      result: "passed",
      ...(detail === undefined ? {} : { detail }),
    });
  const jiraFetch = jiraGuard.fetcher(options.jiraFetcher);
  const gitlabFetch = gitlabGuard.fetcher(options.gitlabFetcher);
  const jira = jiraApi(
    jiraFetch,
    () => ({ email, token }),
    options.rateLimit?.jira,
  );
  const gitlab: HarnessApi = harnessApi(
    gitlabFetch,
    () => gitlabToken,
    options.rateLimit?.gitlab,
  );
  type Api = (
    path: string,
    init?: { method?: "GET" | "POST"; body?: unknown },
  ) => Promise<{ status: number; json: unknown }>;
  const ok = async <S extends z.ZodType>(
    api: Api,
    path: string,
    schema: S,
    init?: Parameters<Api>[1],
  ): Promise<z.output<S>> => {
    const response = await api(path, init);
    assert.ok(
      response.status >= 200 && response.status < 300,
      `${path}: ${response.status}`,
    );
    return schema.parse(response.json);
  };

  const temp = realpathSync(mkdtempSync(join(tmpdir(), "cab-jira-qual-")));
  let world: Awaited<ReturnType<typeof publicationWorld>> | undefined;
  try {
    // Reads only, before anything is written: the accounts, the statuses, the project and the clone.
    const me = await ok(jira, "/myself", shapes.myself);
    evidence.account = { jira: me.accountId, gitlab: 0 };
    const types = await ok(
      jira,
      `/project/${projectId}/statuses`,
      shapes.statuses,
    );
    const task = types.find((t) => t.name === "Task");
    assert.ok(task, "issue-type-task-missing");
    for (const wanted of Object.values(status))
      assert.ok(
        task.statuses.some((s) => s.id === wanted),
        `status-missing:${wanted}`,
      );
    evidence.gitlabVersion = (
      await ok(gitlab, "/api/v4/version", shapes.version)
    ).version;
    const info = await ok(gitlab, base, shapes.project);
    assert.equal(String(info.id), repositoryId);
    assert.equal(info.path_with_namespace, projectPath);
    const mainHead = await ok(
      gitlab,
      `${base}/repository/branches/main`,
      shapes.branch,
    );
    const clone = join(temp, "clone");
    git(
      temp,
      "clone",
      "-q",
      "--no-hardlinks",
      "--branch",
      "main",
      options.source,
      clone,
    );
    git(
      clone,
      "remote",
      "set-url",
      "origin",
      `https://${gitlabHost}/${projectPath}.git`,
    );
    assert.equal(
      git(clone, "rev-parse", "main"),
      mainHead.commit.id,
      "clone-main-stale",
    );
    evidence.account.gitlab = (
      await ok(gitlab, "/api/v4/user", shapes.user)
    ).id;
    pass(
      "read-only preflight",
      "accounts, statuses, project and clone checked",
    );

    // Setup: A (ready, blocked by B) and B (the blocker), then wait for the search index.
    const create = async (role: "a" | "blocker") => {
      const made = await ok(jira, "/issue", shapes.created, {
        method: "POST",
        body: {
          fields: {
            project: { id: projectId },
            issuetype: { id: task.id },
            summary: summaryOf(runId, role),
            labels: role === "a" ? ["cab-ready", label] : [label],
            description: adfParagraph(
              `Bounded cab qualification run ${runId}.`,
            ),
            ...(role === "a"
              ? { [priority.fieldId]: { id: priority.high } }
              : {}),
          },
        },
      });
      return {
        id: made.id,
        key: made.key,
        number: Number(made.key.slice(projectKey.length + 1)),
      };
    };
    const a = await create("a");
    const blocker = await create("blocker");
    evidence.issues = { a, blocker };
    // "B blocks A": Jira reads `inwardIssue` as the issue that blocks and `outwardIssue` as the one it blocks.
    const linked = await jira("/issueLink", {
      method: "POST",
      body: {
        type: { name: "Blocks" },
        inwardIssue: { key: blocker.key },
        outwardIssue: { key: a.key },
      },
    });
    assert.equal(linked.status, 201, "issue-link");
    // A direct read, which the search index cannot lag: A must show B as the issue it "is blocked by".
    const direct = linkSummary(
      (await ok(jira, `/issue/${a.id}?fields=issuelinks`, shapes.links)).fields
        .issuelinks,
    );
    evidence.links = { afterCreate: direct };
    assert.ok(
      direct.some(
        (l) =>
          l.direction === "inward" &&
          l.label === "is blocked by" &&
          l.other === blocker.key,
      ),
      `link-direction: ${a.key} shows ${JSON.stringify(direct)}`,
    );
    const search = async () => {
      const found = (
        await ok(jira, "/search/jql", shapes.search, {
          method: "POST",
          body: {
            jql: runJql(runId),
            fields: [
              "summary",
              "status",
              "labels",
              "issuelinks",
              priority.fieldId,
            ],
            maxResults: 50,
          },
        })
      ).issues;
      // Kept for the evidence, so a timed-out poll shows what the index returned for A.
      evidence.links = {
        ...evidence.links,
        lastSearch: linkSummary(
          found.find((i) => i.id === a.id)?.fields.issuelinks ?? [],
        ),
      };
      return found;
    };
    /** Searches until `done`, with no timing assertion: only the number of polls is recorded. */
    const poll = async (
      name: string,
      done: (issues: Awaited<ReturnType<typeof search>>) => boolean,
    ) => {
      for (let n = 1; n <= (options.maxPolls ?? 10); n++) {
        if (done(await search())) {
          evidence.polls[name] = n;
          return;
        }
        await (options.pause ? options.pause() : sleep(3000));
      }
      throw new Error(`Timed out: ${name}`);
    };
    const blockedBy = (issues: Awaited<ReturnType<typeof search>>) =>
      issues
        .find((i) => i.id === a.id)
        ?.fields.issuelinks.find(
          (l) =>
            l.type.inward === "is blocked by" &&
            l.inwardIssue?.key === blocker.key,
        );
    await poll(
      "issues and link indexed",
      (issues) =>
        [a.id, blocker.id].every((x) => issues.some((i) => i.id === x)) &&
        !!blockedBy(issues),
    );
    evidence.prerequisites[
      "search issuelinks with the linked issue's status category"
    ] =
      `passed: ${blockedBy(await search())?.inwardIssue?.fields.status.statusCategory.key}`;
    pass(
      "issues created, linked and indexed",
      `${a.key} blocked by ${blocker.key}`,
    );

    // The service: Jira source and delivery on the fixture project, credentials from the variables.
    const link = {
      host: gitlabHost,
      repositoryId,
      projectPath,
      origin: `https://${gitlabHost}/${projectPath}.git`,
      delivery: {
        fetcher: gitlabFetch,
        push: gitlabGuard.guardPush(options.push ?? pushTaskCommit),
        adopt: gitlabGuard.guardAdopt(options.adopt ?? adoptOutsideHead),
        ...(options.rateLimit?.gitlab
          ? { rateLimit: options.rateLimit.gitlab }
          : {}),
      },
    };
    const w = await publicationWorld("allow", link, {
      source: clone,
      deliveryMode: "reviewable-pr",
      jira: {
        issueTrackers: { jiraFetcher: jiraFetch, intervalMs: 3_600_000 },
        setup: async (f, projectIdOfService) => {
          const domain = f.service.domain();
          const command = { actor: "operator" as const, key: randomUUID() };
          domain.execute({
            ...command,
            type: "issue-tracker-credential.configure",
            issueTracker: "jira",
            instance: host,
            credential: {
              siteRef: "env:CAB_JIRA_SITE",
              emailRef: "env:CAB_JIRA_EMAIL",
              tokenRef: "env:CAB_JIRA_API_TOKEN",
            },
          });
          domain.execute({
            ...command,
            key: randomUUID(),
            type: "jira.configure",
            projectId: projectIdOfService,
            expectedVersion: 1,
            instance: host,
            selections: [{ id: "S-1", kind: "jql", jql: runJql(runId) }],
            readiness: {
              mode: "all",
              conditions: [
                { kind: "label", operator: "has", name: "cab-ready" },
                {
                  kind: "select-field",
                  fieldId: priority.fieldId,
                  operator: "in",
                  optionIds: [priority.high],
                },
                {
                  kind: "status",
                  operator: "in",
                  statusIds: [status.todo, status.progress, status.review],
                },
              ],
            },
          });
          await f.service.refreshGitHub();
          const taskId = f.service
            .githubSources()
            .forTracker({ provider: "jira", instance: host })
            .issue(a.id)?.taskId;
          assert.ok(taskId, "issue-a-not-imported");
          return String(taskId);
        },
      },
    });
    world = w;
    const { f } = w;
    const domain = f.service.domain();
    const command = () => ({ actor: "operator" as const, key: randomUUID() });
    domain.execute({
      ...command(),
      type: "code-host-credential.configure",
      codeHost: "gitlab",
      host: gitlabHost,
      credentialRef: "env:CAB_GITLAB_TOKEN",
    } as never);
    const configureDelivery = (statusIds: string[]) => {
      const delivery = f.service.delivery();
      domain.execute({
        ...command(),
        type: "delivery.configure",
        projectId: f.projectId,
        expectedVersion: delivery.configuration(f.projectId).version,
        mode: "reviewable-pr",
        credentialRef: null,
        grants: [
          ...(["issue.comment", "issue.labels", "issue.close"] as const).map(
            (action) => ({
              action,
              repositoryId: projectId,
              mode: "allow" as const,
            }),
          ),
          {
            action: "issue.status",
            repositoryId: projectId,
            mode: "allow",
            statusIds,
          },
          ...(["branch.push", "pr.create"] as const).map((action) => ({
            action,
            repositoryId,
            mode: "allow" as const,
          })),
        ],
        requiredChecks: [],
      } as never);
    };
    const mapping = (events: Record<StatusMappingEvent, string>) => ({
      ...command(),
      type: "status-mapping.configure" as const,
      projectId: f.projectId,
      expectedVersion: 1,
      mapping: { tracker: "jira" as const, events },
    });
    const refused = (events: Record<StatusMappingEvent, string>) => {
      try {
        domain.execute(mapping(events) as never);
      } catch (error) {
        if (error instanceof StatusMappingRefusal) return error.reason;
        throw error;
      }
      return "saved";
    };
    configureDelivery([status.todo, status.progress, status.done]);
    assert.equal(
      refused({
        turnStarted: status.done,
        handedBack: status.progress,
        held: status.todo,
        done: status.done,
      }),
      "readiness",
    );
    const wanted = {
      turnStarted: status.progress,
      handedBack: status.review,
      held: status.todo,
      done: status.done,
    };
    assert.equal(refused(wanted), "ungranted");
    configureDelivery([
      status.todo,
      status.progress,
      status.review,
      status.done,
    ]);
    assert.equal(refused(wanted), "saved");
    domain.execute({
      ...command(),
      type: "project.configure",
      projectId: f.projectId,
      expectedVersion: 2,
      paused: false,
    });
    pass(
      "configured",
      "refused readiness, then ungranted, then saved the mapping",
    );

    const store = f.service
      .githubSources()
      .forTracker({ provider: "jira", instance: host });
    const blockerTask = String(store.issue(blocker.id)?.taskId);
    const writes = (): Write[] =>
      f.service
        .delivery()
        .actions(f.taskId)
        .flatMap((x) =>
          isServiceDeliveryCaller(x.binding)
            ? [
                {
                  event: x.binding.event,
                  state: x.state,
                  reason: x.observation?.reason ?? null,
                },
              ]
            : [],
        );
    const map = async () => {
      await f.service.runStatusMapping();
      evidence.statusWrites = writes();
      return evidence.statusWrites;
    };
    const jiraIssue = (key: string) =>
      ok(jira, `/issue/${key}?fields=status,labels`, shapes.issue);
    const act = (action: Record<string, unknown>, index?: number) =>
      f.call(
        "cab_external_action",
        { operationId: randomUUID(), action },
        index,
      );
    const target = { repositoryId: projectId, number: a.number, nodeId: a.id };

    // Import, readiness and the dependency: A is Ready and held by B, which is Draft.
    assert.equal(domain.task(f.taskId).ready, 1, "a-ready");
    assert.equal(domain.task(blockerTask).ready, 0, "blocker-draft");
    assert.equal(domain.task(f.taskId).importedBlockers, "blocked");
    assert.deepEqual(await map(), [
      {
        event: "held",
        state: "confirmed-failure",
        reason: "provider-issue-status-current",
      },
    ]);
    pass(
      "imported, ready, held by the source-owned dependency",
      "held write skipped: already at that status",
    );

    // The dependency clears.
    /** Moves an issue by the one transition that reaches `to`, as the credential's account does. */
    const moveTo = async (issue: { id: string }, to: string) => {
      const options = await ok(
        jira,
        `/issue/${issue.id}/transitions`,
        shapes.transitions,
      );
      const reaching = options.transitions.filter((t) => t.to.id === to);
      assert.equal(reaching.length, 1, `transition-to-${to}`);
      return jira(`/issue/${issue.id}/transitions`, {
        method: "POST",
        body: { transition: { id: reaching[0]?.id } },
      });
    };
    const doneByHarness = await moveTo(blocker, status.done);
    assert.equal(doneByHarness.status, 204);
    evidence.prerequisites["transition response"] =
      `passed: ${doneByHarness.status}`;
    await poll(
      "blocker done indexed",
      (issues) =>
        blockedBy(issues)?.inwardIssue?.fields.status.statusCategory.key ===
        "done",
    );
    await f.service.refreshGitHub();
    assert.equal(domain.task(f.taskId).importedBlockers, "clear");
    await f.waitTurn(1);
    pass("blocker done; A unblocked and its lead turn started");

    // Turn started: the status write moves A to In Progress, read back.
    assert.deepEqual((await map()).at(-1), {
      event: "turnStarted",
      state: "confirmed-success",
      reason: null,
    });
    assert.equal((await jiraIssue(a.id)).fields.status.id, status.progress);
    pass("turnStarted moved A to In Progress");

    // Comment and labels.
    const commented = await act({
      kind: "issue.comment",
      target,
      body: `Qualification ${runId}: a comment from the lead.`,
    });
    assert.equal(commented.success, true, clean(commented.text));
    evidence.prerequisites["comment properties and ADF readback"] = "passed";
    const progress = `${label}-progress`;
    const labelled = await act({
      kind: "issue.labels",
      target,
      add: [progress],
      remove: [],
    });
    assert.equal(labelled.success, true, clean(labelled.text));
    const afterLabels = (await jiraIssue(a.id)).fields.labels;
    assert.ok(
      afterLabels.includes(progress) && afterLabels.includes("cab-ready"),
    );
    evidence.prerequisites["update.labels semantics"] = "passed";
    const before = jiraGuard.writeCount;
    const unready = await act({
      kind: "issue.labels",
      target,
      add: [],
      remove: ["cab-ready"],
    });
    assert.equal(unready.success, false);
    assert.equal(
      jiraGuard.writeCount,
      before,
      "removing the readiness label makes no write",
    );
    pass(
      "comment confirmed, label added, readiness label removal refused with no write",
    );

    // The Jira key in the branch and the merge request.
    const workspaceCommit = w.commit(`qual-${runId}-jira.md`);
    const pushed = await w.push(workspaceCommit);
    assert.equal(pushed.success, true, clean(pushed.text));
    const branch =
      f.service.delivery().taskBranch(f.taskId, repositoryId)?.branch ?? "";
    assert.match(branch, new RegExp(`^cab/${a.key}-[0-9a-f]{8}-`));
    const mr = {
      kind: "pr.create",
      target: {
        repositoryId,
        baseRef: "main",
        headRef: branch,
        expectedHeadSha: workspaceCommit,
      },
      title: `${a.key} Qualification ${runId} a`,
      body: `Bounded cab qualification run ${runId}. Safe to close.`,
      draft: false,
    };
    const gitlabWrites = gitlabGuard.writeCount;
    const closing = await act({ ...mr, body: `Closes ${a.key}` });
    assert.equal(closing.success, false);
    assert.equal(
      gitlabGuard.writeCount,
      gitlabWrites,
      "a closing keyword makes no write",
    );
    const created = await act(mr);
    assert.equal(created.success, true, clean(created.text));
    const iid = [...gitlabGuard.requests.keys()].at(-1);
    const request =
      iid === undefined ? undefined : gitlabGuard.requests.get(iid);
    assert.ok(iid && request);
    evidence.mergeRequest = { iid };
    pass("push and merge request keyed to the issue", `${branch} !${iid}`);

    // The changed skip: a person moves A before the handback is written, and no source read intervenes.
    assert.equal((await moveTo(a, status.todo)).status, 204);
    assert.equal((await jiraIssue(a.id)).fields.status.id, status.todo);
    const searches = jiraGuard.counts["POST /search/jql"] ?? 0;
    const registered = await f.call("cab_register_pr", {
      repositoryId,
      prNumber: iid,
      expectedPrNodeId: String(request.id),
      expectedHeadSha: workspaceCommit,
    });
    assert.equal(registered.success, true, clean(registered.text));
    const handback = (await map()).at(-1);
    assert.deepEqual(handback, {
      event: "handedBack",
      state: "confirmed-failure",
      reason: "provider-issue-status-changed",
    });
    assert.equal(
      jiraGuard.counts["POST /search/jql"] ?? 0,
      searches,
      "no source read between the move and the write",
    );
    assert.equal(
      (await jiraIssue(a.id)).fields.status.id,
      status.todo,
      "the skipped write sent nothing",
    );
    pass(
      "handedBack skipped: the status changed in Jira since cab saw it",
      "no search and no transition POST in between",
    );

    // Closure: the operator settles, the lead closes the issue by the one transition to Done.
    await f.terminal(1);
    assert.ok(
      f.service
        .delivery()
        .completionBlockers(f.taskId, Number(domain.task(f.taskId).version))
        .includes("reviewable-pr-awaiting-current-settlement"),
    );
    const settle = () =>
      f.service.settleHandback({
        ...f.settlement(),
        repositoryId,
        prNumber: iid,
        expectedPrNodeId: String(request.id),
        expectedHeadSha: workspaceCommit,
      });
    await settle();
    await f.waitTurn(2);
    const high = Math.max(
      0,
      ...(
        await ok(jira, `/issue/${a.id}/changelog`, shapes.changelog)
      ).values.map((h) => Number(h.id)),
    );
    const closed = await act(
      { kind: "issue.close", target, reviewedResultIds: [] },
      2,
    );
    assert.equal(closed.success, true, clean(closed.text));
    const entries = (
      await ok(jira, `/issue/${a.id}/changelog`, shapes.changelog)
    ).values.filter(
      (h) => Number(h.id) > high && h.items.some((i) => i.field === "status"),
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.author?.accountId, me.accountId);
    assert.equal(
      entries[0]?.items.find((i) => i.field === "status")?.to,
      status.done,
    );
    evidence.prerequisites["changelog ids increase and carry accountId"] =
      "passed";
    assert.equal((await jiraIssue(a.id)).fields.status.id, status.done);
    // The closure took A out of Ready, which changes the task version the settlement is bound to, and the
    // source read that follows changes it again: the operator settles the handback once more, now
    // current, and the lead takes the pending events in a new turn before it can complete.
    await poll(
      "A done indexed",
      (issues) =>
        issues.find((i) => i.id === a.id)?.fields.status.id === status.done,
    );
    await f.service.refreshGitHub();
    assert.ok(
      f.service
        .delivery()
        .completionBlockers(f.taskId, Number(domain.task(f.taskId).version))
        .includes("reviewable-pr-awaiting-current-settlement"),
    );
    await settle();
    await f.terminal(2);
    await f.waitTurn(3);
    const completion = await f.call(
      "cab_request_completion",
      { reviewedResultIds: [] },
      3,
    );
    assert.equal(completion.success, true, clean(completion.text));
    f.runtime.complete(3);
    await until(() => domain.task(f.taskId).state === "done", "task done");
    assert.deepEqual((await map()).at(-1), {
      event: "done",
      state: "confirmed-failure",
      reason: "provider-issue-status-current",
    });
    pass(
      "closed by the single transition to Done; task completed; Done write skipped as current",
    );

    // A refusal by a guard is a defect in the run, even when the product handled it.
    assert.deepEqual(jiraGuard.denied, [], "the Jira guard refused a request");
    assert.deepEqual(
      gitlabGuard.denied,
      [],
      "the GitLab guard refused a request",
    );
    evidence.qualification = "passed";
  } catch (error) {
    const message = clean(
      String(error instanceof Error ? error.message : error),
    );
    evidence.steps.push({ step: "journey", result: "failed", detail: message });
    evidence.failure = message;
    if (jiraGuard.denied.length)
      evidence.failure += ` [jira guard refused: ${[...new Set(jiraGuard.denied)].join(", ")}]`;
    if (gitlabGuard.denied.length)
      evidence.failure += ` [gitlab guard refused: ${[...new Set(gitlabGuard.denied)].join(", ")}]`;
  } finally {
    // Cleanup acts only on what the guards recorded, and counts toward pass or fail.
    const jiraCleanup = await cleanUpJira(jira, jiraGuard, clean);
    const gitlabCleanup = await cleanUp(gitlab, gitlabGuard, null, clean);
    evidence.cleanup =
      jiraCleanup.cleanup === "verified" && gitlabCleanup.cleanup === "verified"
        ? "verified"
        : "failed";
    evidence.cleanupReads = [
      ...jiraCleanup.cleanupReads,
      ...gitlabCleanup.cleanupReads,
    ];
    await world?.f.close().catch(() => {});
    rmSync(temp, { recursive: true, force: true });
  }
  evidence.writes = {
    jira: jiraGuard.writeCount,
    gitlab: gitlabGuard.writeCount,
    merges: gitlabGuard.mergeCount,
  };
  evidence.requests = { jira: jiraGuard.log, gitlab: gitlabGuard.log };
  evidence.requestCounts = {
    jira: jiraGuard.counts,
    gitlab: gitlabGuard.counts,
  };
  const redact = <T extends { headers: Record<string, string>; body: string }>(
    rows: T[],
  ) =>
    rows.map((r) => ({
      ...r,
      headers: Object.fromEntries(
        Object.entries(r.headers).map(([k, v]) => [k, clean(v)]),
      ),
      body: clean(r.body),
    }));
  evidence.rateLimited = {
    jira: redact(jiraGuard.rateLimited),
    gitlab: redact(gitlabGuard.rateLimited),
  };
  evidence.lastRateHeaders = Object.fromEntries(
    Object.entries(jiraGuard.lastRateHeaders).map(([k, v]) => [k, clean(v)]),
  );
  return evidence;
}
