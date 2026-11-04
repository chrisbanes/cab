import type { DomainStore } from "../core/domain.js";
import type {
  BlockerSnapshot,
  GitHubSourceStore,
  IssueCommentsRead,
  SelectionSnapshot,
} from "../core/github-source.js";
import type { JiraReaderFactory } from "./issue-tracker.js";

/** Reads every Jira project's active JQL selections into its tracker-bound source store. */
export class JiraSynchronizer {
  private pending: Promise<void> | undefined;
  private stopped = false;
  // Rate-limit pauses per site, in memory: after a restart Jira just answers "rate-limited" again.
  private readonly pausedUntil = new Map<string, number>();

  constructor(
    private readonly domain: DomainStore,
    private readonly storeFor: (instance: string) => GitHubSourceStore,
    private readonly readerFactory: JiraReaderFactory,
  ) {}

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    const pending = this.perform().finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.pending;
  }

  private async perform(): Promise<void> {
    const briefsRead = new Set<string>();
    // An issue matched by projects on one site is stored once, so every read of that site
    // requests the select fields any of its projects' rules need, not just its own.
    const fieldsBySite = new Map<string, string[]>();
    for (const project of this.domain.projects()) {
      if (project.archived) continue;
      const config = this.domain.jiraConfiguration(String(project.id));
      if (!config) continue;
      const ids = new Set(fieldsBySite.get(config.instance));
      for (const c of config.readiness?.conditions ?? [])
        if (c.kind === "select-field") ids.add(c.fieldId);
      fieldsBySite.set(config.instance, [...ids]);
    }
    for (const project of this.domain.projects()) {
      if (project.archived) continue;
      const projectId = String(project.id);
      const config = this.domain.jiraConfiguration(projectId);
      if (!config) continue;
      const active = new Set(this.domain.githubActiveSelectionIds(projectId));
      const reader = this.readerFactory(config.instance);
      const fieldIds = fieldsBySite.get(config.instance) ?? [];
      for (const selection of config.selections) {
        if (this.stopped) return;
        if (!active.has(selection.id)) continue;
        const paused =
          (this.pausedUntil.get(config.instance) ?? 0) > Date.now();
        const snapshot: SelectionSnapshot = paused
          ? { complete: false, issues: [], reason: "rate-limited" }
          : await reader.readSelection(selection, fieldIds).catch(() => ({
              complete: false as const,
              issues: [],
              reason: "reader-error",
            }));
        if (this.stopped) return;
        if (!snapshot.complete && snapshot.resumeAt !== undefined)
          this.pausedUntil.set(config.instance, snapshot.resumeAt);
        const store = this.storeFor(config.instance);
        const binding = {
          projectId,
          projectVersion: Number(project.version),
          configVersion: config.version,
          credentialRef: null,
        };
        const committed = store.reconcileSelection(
          projectId,
          selection.id,
          snapshot,
          binding,
        );
        // Links replace an issue's blockers only from a committed complete read; any other
        // read leaves them, and reconcileSelection has already marked them unknown.
        if (!committed || !snapshot.complete) continue;
        for (const issue of snapshot.issues) {
          const imported = store.issue(issue.nodeId);
          if (!imported) continue;
          const reference = {
            nodeId: issue.nodeId,
            repositoryId: issue.repositoryId,
            repositoryName: issue.repositoryName,
            number: issue.number,
          };
          const blockers: BlockerSnapshot = issue.blockedBy
            ? { complete: true, blockers: issue.blockedBy, reason: null }
            : { complete: false, blockers: [], reason: "links-unread" };
          store.reconcileBlockers(issue.nodeId, blockers, {
            ...binding,
            selectionId: selection.id,
            reference,
          });
          // Only an open task reads its issue brief, once per pass; Done tasks keep their last one.
          const key = `${config.instance}\n${issue.nodeId}`;
          if (
            briefsRead.has(key) ||
            this.domain.task(String(imported.taskId)).state !== "open"
          )
            continue;
          briefsRead.add(key);
          const comments: IssueCommentsRead =
            (this.pausedUntil.get(config.instance) ?? 0) > Date.now()
              ? { complete: false, comments: [], reason: "rate-limited" }
              : await reader.readIssueComments(reference).catch(() => ({
                  complete: false as const,
                  comments: [],
                  reason: "reader-error",
                }));
          if (this.stopped) return;
          if (!comments.complete && comments.resumeAt !== undefined)
            this.pausedUntil.set(config.instance, comments.resumeAt);
          store.reconcileIssueBrief(issue.nodeId, comments, {
            ...binding,
            selectionId: selection.id,
            reference,
          });
        }
      }
    }
  }
}
