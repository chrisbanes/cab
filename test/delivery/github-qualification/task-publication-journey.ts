import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readiness } from "../../../src/core/github-source-contracts.js";
import type { CodeHostProviderFactories } from "../../../src/standalone/code-host.js";
import { GitHubHttpSourceReader } from "../../../src/standalone/github-source.js";
import type { GitHubReaderFactory } from "../../../src/standalone/github-sync.js";
import { StandaloneService } from "../../../src/standalone/service.js";
import { checkout, noRuntime } from "../../fixtures/task-publication.js";
import { retryingGh } from "./gh-retry.js";
import {
  harnessDocuments,
  issueTitle,
  projectFilters,
  projectTitle,
  readyLabel,
  statusOptionNames,
  type TaskPublicationGuard,
} from "./task-publication-fixture.js";

export interface TaskPublicationJourneyOptions {
  guard: TaskPublicationGuard;
  token: string;
  /** Which attempt this is, within the manifest's allowance. */
  attempt: number;
  /** Runs `gh` under its own login and returns stdout; the journey passes only guarded commands. */
  gh(args: string[]): string;
  /** The raw HTTP transport the guard wraps; tests pass a fake GitHub. */
  fetcher?: typeof fetch;
  /** Test seams for the service's delivery provider and source reader. */
  providerFactories?: CodeHostProviderFactories;
  readerFactory?: GitHubReaderFactory;
  /** Milliseconds between tries of a `gh` command that hit a transient GitHub error; tests pass 0. */
  ghRetryMs?: number;
  /** Milliseconds between reads of a Project that does not list the new item yet; tests pass 0. */
  readRetryMs?: number;
}

/**
 * GitHub's issue list can trail a create by a moment, so the first read-back may not list the new
 * issue and the create stays unproved. The product resolves it on its next refresh, never by
 * resending; the journey refreshes at most this many times before it gives up on a publication.
 */
const refreshPasses = 8;

/** A Project lists a new item a little after it is added: read it again for at most this many times. */
const projectReads = 10;

const owner = "chrisbanes";
/** The name of the in-process variable the service reads the delivery credential from. */
const credentialName = "CAB_1167_LIVE_CREDENTIAL";

/**
 * One bounded run on a scratch user-owned Project linked to the fixture repository, driving the real
 * service, delivery coordinator and provider with no model turn: a Ready local task is published to the
 * Project (issue, item, label and the Ready option), another to the repository, then one real sync must
 * match both instead of importing duplicates. `gh` reads each result back independently. The harness
 * closes the issues, deletes the Project and the label, then proves it. Never throws for an assertion:
 * returns the evidence with `qualification: "failed"`.
 */
export async function runTaskPublicationJourney(
  options: TaskPublicationJourneyOptions,
) {
  const { guard, token } = options;
  const manifest = guard.manifest;
  const fullName = manifest.repository.fullName;
  const repositoryId = manifest.repository.nodeId;
  const runId = randomBytes(4).toString("hex");
  const label = readyLabel(runId);
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
  const gh = retryingGh(
    (args) => guard.assertGh(args),
    options.gh,
    options.ghRetryMs ?? 2000,
  );
  const json = (args: string[]) => JSON.parse(gh(args)) as unknown;
  const raw = options.fetcher ?? fetch;
  const readerFactory: GitHubReaderFactory =
    options.readerFactory ??
    (() => new GitHubHttpSourceReader(token, guardedFetch));
  // What the product creates is recorded as GitHub answers, so cleanup and the guard know it.
  const guardedFetch: typeof fetch = async (input, init) => {
    guard.assertRequest(input, init);
    const response = await raw(input, {
      ...init,
      redirect: init?.redirect ?? "error",
    });
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    if (response.ok && method === "POST") {
      const answer = (await response.clone().json()) as {
        node_id?: string;
        number?: number;
        data?: { addProjectV2ItemById?: { item?: { id?: string } } };
      };
      if (
        url.pathname === `/repos/${fullName}/issues` &&
        answer.node_id &&
        answer.number
      )
        guard.recordIssue(answer.number, answer.node_id);
      const item = answer.data?.addProjectV2ItemById?.item?.id;
      if (item) guard.recordItem(item);
    }
    return response;
  };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cab-1167-live-")));
  let service: StandaloneService | undefined;
  let project: { nodeId: string; number: number } | undefined;
  let labelCreated = false;
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

    // 3. Its Status field: Todo and Ready.
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
    const statusOptions =
      updated.data.updateProjectV2Field.projectV2Field.options;
    if (
      statusOptions.map((o) => o.name).join("|") !== statusOptionNames.join("|")
    )
      throw new Error("The Status options are not the granted two");
    const readyOption = statusOptions.find((o) => o.name === "Ready")?.id ?? "";
    guard.recordField(
      statusField.id,
      statusOptions.map((o) => o.id),
    );
    // The label exists before the first publication, so no create depends on GitHub making it.
    gh([
      "api",
      "-X",
      "POST",
      `repos/${fullName}/labels`,
      "-f",
      `name=${label}`,
      "-f",
      "color=ededed",
    ]);
    labelCreated = true;

    // 4. The service: its own stores, a project with a Project and a repository source, and the grants.
    const checkoutPath = await checkout(root);
    const started = new StandaloneService(
      join(root, "data"),
      () => noRuntime,
      undefined,
      {
        delivery: {
          fetcher: guardedFetch,
          ...(options.providerFactories
            ? { providerFactories: options.providerFactories }
            : {}),
        },
        github: { readerFactory },
        ghExecutable: join(root, "no-gh", "gh"),
        power: { enabled: false },
      },
    );
    service = started;
    await started.start();
    // Set after start, so no runtime snapshot holds it.
    process.env[credentialName] = token;
    const domain = started.domain();
    const projectId = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Task publication qualification",
      leadProfileId: null,
    });
    const repoSelection = {
      id: "repo",
      kind: "repository" as const,
      repositoryId,
      owner,
      name: "cab-s07a-fixture",
    };
    const projectSelection = {
      id: "project",
      kind: "project" as const,
      projectNodeId: project.nodeId,
      filter: projectFilters[0] as string,
    };
    const selections = [repoSelection, projectSelection];
    const fieldCondition = {
      kind: "project-field" as const,
      projectNodeId: project.nodeId,
      fieldNodeId: statusField.id,
      operator: "in" as const,
      optionNodeIds: [readyOption],
    };
    const labelCondition = {
      kind: "label" as const,
      operator: "has" as const,
      name: label,
    };
    const configure = async (readiness: Readiness) => {
      await domain.configureRepositories({
        type: "repositories.configure",
        actor: "operator",
        key: randomUUID(),
        projectId,
        expectedVersion: domain.repositoryLinks(projectId).version,
        repositories: [
          {
            codeHost: "github",
            host: "github.com",
            repositoryId,
            path: checkoutPath,
            ref: "main",
          },
        ],
      });
      domain.execute({
        type: "github.configure",
        actor: "operator",
        key: randomUUID(),
        projectId,
        expectedVersion: domain.githubConfiguration(projectId).version,
        credentialRef: `env:${credentialName}`,
        selections,
        readiness,
      });
      for (const selection of selections)
        domain.execute({
          type: "github.activate",
          actor: "operator",
          key: randomUUID(),
          projectId,
          selectionId: selection.id,
          expectedVersion: domain.githubConfiguration(projectId).version,
        });
    };
    domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: started.delivery().configuration(projectId).version,
      mode: "reviewable-pr",
      credentialRef: `env:${credentialName}`,
      grants: [
        { action: "issue.create", repositoryId, mode: "allow" },
        {
          action: "project.item.add",
          repositoryId,
          mode: "allow",
          projectNodeId: project.nodeId,
        },
        {
          action: "project.field",
          repositoryId,
          mode: "allow",
          projectNodeId: project.nodeId,
          fieldNodeId: statusField.id,
          optionNodeIds: [readyOption],
        },
      ],
      requiredChecks: [],
    });
    const task = (suffix: string) => {
      const taskId = randomUUID();
      domain.execute({
        type: "task.create",
        actor: "operator",
        key: randomUUID(),
        projectId,
        taskId,
        title: `${issueTitle(runId)} ${suffix}`,
        outcome: `Created by the task publication qualification run ${runId}; closed by the harness.`,
        ready: true,
      });
      return taskId;
    };
    const publish = async (taskId: string, selectionId: string) => {
      const target = started
        .publicationAvailability(taskId)
        .targets.find((t) => t.selectionId === selectionId);
      if (!target?.enabled)
        throw new Error(
          `Target ${selectionId} is unavailable: ${target?.reasonCode ?? "missing"}`,
        );
      const review = started.reviewTaskPublication({
        key: randomUUID(),
        taskId,
        targetId: target.id,
        expectedTaskVersion: Number(domain.task(taskId).version),
      });
      started.confirmTaskPublication({
        key: randomUUID(),
        taskId,
        reviewId: review.publicationId,
        expectedRevision: review.revision,
        materialHash: review.materialHash,
        decision: "approved",
      });
      let sent = await started.sendTaskPublication({
        taskId,
        publicationId: review.publicationId,
        expectedTaskVersion: review.taskVersion,
      });
      const immediate = sent.state;
      let passes = 0;
      while (sent.state === "sending" && passes < refreshPasses) {
        if (sent.issueNumber === null)
          await new Promise((r) => setTimeout(r, options.readRetryMs ?? 5000));
        await started.refreshGitHub();
        passes++;
        sent = started.publication(review.publicationId) ?? sent;
      }
      const steps = started.latestPublication(taskId)?.steps ?? [];
      // Recorded from the service's own state too, so cleanup never depends on parsing a response.
      if (sent.issueNumber && sent.issueNodeId)
        guard.recordIssue(sent.issueNumber, sent.issueNodeId);
      return { review, sent, steps, target, immediate, passes };
    };
    const outcome = (p: Awaited<ReturnType<typeof publish>>) => ({
      target: p.target.selectionId,
      immediate: p.immediate,
      refreshPasses: p.passes,
      state: p.sent.state,
      issueNumber: p.sent.issueNumber,
      steps: p.steps.map((s) => ({ kind: s.kind, state: s.state })),
      labels: p.review.issue.labels,
      projectFields: p.review.fields.length,
    });

    // 5. A Ready task to the Project: the issue, the label, the item and the Ready option, as the rule asks.
    await configure({
      mode: "all",
      conditions: [labelCondition, fieldCondition],
    });
    const projectTask = task("project");
    const toProject = await publish(projectTask, "project");
    // 6. A Ready task to the repository, under the rule that accepts either.
    await configure({
      mode: "any",
      conditions: [labelCondition, fieldCondition],
    });
    const repositoryTask = task("repository");
    const toRepository = await publish(repositoryTask, "repo");
    evidence.publications = [outcome(toProject), outcome(toRepository)];
    for (const p of [toProject, toRepository])
      if (
        p.sent.state !== "converted" ||
        p.steps.some((s) => s.state !== "confirmed-success")
      ) {
        // What GitHub shows for the issues made so far, for a diagnosis; the cause is not guessed.
        evidence.diagnostic = guard.createdIssues().map((number) => {
          const issue = json(["api", `repos/${fullName}/issues/${number}`]) as {
            title: string;
            body: string;
            labels: { name: string }[];
            user: { node_id: string };
          };
          return {
            number,
            title: issue.title,
            labels: issue.labels.map((l) => l.name),
            bodyEndsWithMarker: /<!-- cab-operation:[0-9a-f-]{36} -->$/.test(
              issue.body,
            ),
          };
        });
        throw new Error(
          `Publication to ${p.target.selectionId} ended ${p.sent.state}: ${JSON.stringify(p.steps)}`,
        );
      }
    const tasksBefore = domain.tasks(projectId).length;

    // 7. One real sync must match both issues to their tasks, once the Project lists its item.
    const sourceReader = readerFactory("source");
    let listed = 0;
    for (let reads = 0; reads < projectReads && listed !== 1; reads++) {
      if (reads)
        await new Promise((r) => setTimeout(r, options.readRetryMs ?? 5000));
      const snapshot = await sourceReader.readSelection({
        ...projectSelection,
        filter: projectFilters[reads % projectFilters.length] ?? "",
      });
      listed = snapshot.complete ? snapshot.issues.length : 0;
    }
    evidence.projectListed = listed;
    if (listed !== 1)
      throw new Error("The Project does not list the published item");
    await started.refreshGitHub();
    const issueOf = (taskId: string) => {
      const imported = domain.importedTask(taskId);
      return imported
        ? started.githubSources().issue(String(imported.nodeId))
        : undefined;
    };
    const published = [projectTask, repositoryTask].map((taskId) => ({
      taskId,
      issue: issueOf(taskId),
      ready: domain.task(taskId).ready === 1,
    }));
    const ours = new Set(published.map((p) => String(p.issue?.nodeId)));
    const importedOfOurs = domain.tasks(projectId).filter((t) => {
      const imported = domain.importedTask(String(t.id));
      return imported && ours.has(String(imported.nodeId));
    }).length;
    evidence.sync = {
      tasksBeforeSync: tasksBefore,
      tasksAfterSync: domain.tasks(projectId).length,
      ready: published.map((p) => p.ready),
    };
    evidence.duplicateImports = importedOfOurs - published.length;
    if (evidence.duplicateImports !== 0)
      throw new Error("The sync imported a duplicate");
    if (published.some((p) => !p.issue || !p.ready)) {
      // Local state of each published task after the sync, for a diagnosis; no cause is guessed.
      evidence.diagnostic = published.map((p) => ({
        ready: p.ready,
        matched: p.issue !== undefined,
        labels: p.issue ? JSON.parse(String(p.issue.labels)) : null,
        memberships: p.issue
          ? started.githubSources().memberships(String(p.issue.nodeId)).length
          : 0,
        holds: started
          .githubSources()
          .activeHolds()
          .filter((h) => h.taskId === p.taskId)
          .map((h) => h.reason),
        admission: domain.admission(p.taskId).reasons,
      }));
      throw new Error("A published task is not matched and Ready after sync");
    }

    // 8. Independent reads of both issues, the Project item and its field.
    const independent = published.map((p) => {
      const number = Number(p.issue?.issueNumber);
      const issue = json(["api", `repos/${fullName}/issues/${number}`]) as {
        number: number;
        state: string;
        title: string;
        body: string;
        labels: { name: string }[];
      };
      return {
        number: issue.number,
        state: issue.state,
        labels: issue.labels.map((l) => l.name),
        marked: /<!-- cab-operation:[0-9a-f-]{36} -->/.test(issue.body),
      };
    });
    const items = json([
      "project",
      "item-list",
      String(project.number),
      "--owner",
      owner,
      "--format",
      "json",
    ]) as { items: { status?: string; content?: { number?: number } }[] };
    const projectNumber = Number(published[0]?.issue?.issueNumber);
    const item = items.items.find((i) => i.content?.number === projectNumber);
    evidence.independentReadback = {
      issues: independent,
      projectItem: item ? { status: item.status ?? null } : null,
      projectItems: items.items.length,
    };
    if (
      independent.some(
        (i) => i.state !== "open" || !i.marked || !i.labels.includes(label),
      ) ||
      item?.status !== "Ready" ||
      items.items.length !== 1
    )
      throw new Error("An independent read does not show the publications");

    const text = JSON.stringify(evidence);
    if (text.includes(token)) throw new Error("The credential was exposed");
    Object.assign(evidence, {
      qualification: "passed",
      credentialExposures: 0,
      limits:
        "The uncertain, Link and Abandon paths are covered by the deterministic service tests; this run covers the real create, item add, field write, read-back and sync-match path.",
    });
  } catch (error) {
    evidence.failure = redact(
      String(error instanceof Error ? error.message : error),
    );
  } finally {
    // The harness owns cleanup: close the issues, delete the Project and the label, then prove them.
    try {
      await service?.stop().catch(() => undefined);
      delete process.env[credentialName];
      const attempts: string[] = [];
      const attempt = (run: () => void) => {
        try {
          run();
        } catch (error) {
          attempts.push(redact(String(error)));
        }
      };
      const issues = guard.createdIssues();
      for (const number of issues)
        attempt(() =>
          gh(["issue", "close", String(number), "--repo", fullName]),
        );
      if (project)
        attempt(() =>
          gh(["project", "delete", String(project?.number), "--owner", owner]),
        );
      if (labelCreated)
        attempt(() =>
          gh(["api", "-X", "DELETE", `repos/${fullName}/labels/${label}`]),
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
      const closed = issues.every(
        (number) =>
          (
            JSON.parse(gh(["api", `repos/${fullName}/issues/${number}`])) as {
              state: string;
            }
          ).state === "closed",
      );
      evidence.cleanup = gone && closed ? "verified" : "unverified";
      evidence.createdIssues = issues;
      if (project) evidence.deletedProject = { ...project, deleted: gone };
    } catch (error) {
      evidence.cleanup = "unverified";
      evidence.cleanupFailure = redact(
        String(error instanceof Error ? error.message : error),
      );
    }
    evidence.writes = guard.writes;
    rmSync(root, { recursive: true, force: true });
  }
  return evidence;
}
