import {
  selectionSchema,
  type GitHubSourceStore,
} from "../core/github-source.js";
import type { DomainStore } from "../core/domain.js";
import {
  CredentialGitHubSourceReader,
  SourceRateLimitPauses,
} from "./github-source-credential.js";
import { ghEnvironment } from "./gh-credential.js";
import type {
  BlockerSnapshot,
  GitHubSourceReader,
  IssueReference,
  IssueSnapshot,
  IssueStatus,
  SelectionSnapshot,
} from "./github-source.js";

export type GitHubReaderFactory = (credentialRef: string) => GitHubSourceReader;

/** Serializes provider reads and commits each selection before the scheduler observes it. */
export class GitHubSynchronizer {
  private pending: Promise<void> | undefined;
  private stopped = false;
  // Rate-limit pauses per credential, in memory: after a restart GitHub just answers "rate-limited" again.
  private readonly tokenPauses = new SourceRateLimitPauses();
  private readonly pausedUntil = new Map<string, number>();

  constructor(
    private readonly domain: DomainStore,
    private readonly sources: GitHubSourceStore,
    private readonly readerFactory: GitHubReaderFactory = (reference) =>
      new CredentialGitHubSourceReader(reference, {
        gh: () => ({ environment: ghEnvironment(domain, { reference }) }),
      }),
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

  private reader(reference: string) {
    const reader = this.readerFactory(reference);
    return reader instanceof CredentialGitHubSourceReader
      ? reader.withRateLimitPauses(this.tokenPauses)
      : reader;
  }

  private paused(credentialRef: string): boolean {
    const until = this.pausedUntil.get(credentialRef);
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    this.pausedUntil.delete(credentialRef);
    return false;
  }

  private notePause(
    credentialRef: string,
    result: { reason?: string | null; resumeAt?: number },
  ): void {
    if (result.reason === "rate-limited" && result.resumeAt !== undefined)
      this.pausedUntil.set(credentialRef, result.resumeAt);
  }

  /**
   * Admission consults imported blockers only for a ready open task, or a closed
   * issue's open task continuing from its own delivery closure. Other issues are
   * not read, which keeps a pass within GitHub's hourly request budget.
   */
  private readsBlockers(issue: IssueSnapshot): boolean | "unneeded" {
    const taskId = this.sources.issue(issue.nodeId)?.taskId;
    if (taskId === undefined) return false;
    const task = this.domain.task(String(taskId));
    if (issue.state !== "closed")
      return task.state === "open" && task.ready ? true : "unneeded";
    return (
      task.state === "open" && this.domain.hasOwnDeliveryClosure(String(taskId))
    );
  }

  private async perform(): Promise<void> {
    // One reader per credential for this pass, so its repository lookups are shared.
    const readers = new Map<string, GitHubSourceReader>();
    const readerFor = (reference: string) => {
      const reader = readers.get(reference) ?? this.reader(reference);
      readers.set(reference, reader);
      return reader;
    };
    for (const project of this.domain.projects()) {
      const projectId = String(project.id);
      const config = this.domain.githubConfiguration(projectId);
      const active = new Set(this.domain.githubActiveSelectionIds(projectId));
      const credentialRef = config.credentialRef;
      if (!credentialRef) continue;
      const reader = readerFor(credentialRef);
      for (const raw of config.selections) {
        if (this.stopped) return;
        const selection = selectionSchema.parse(raw);
        if (!active.has(selection.id)) continue;
        const snapshot: SelectionSnapshot =
          !(reader instanceof CredentialGitHubSourceReader) &&
          this.paused(credentialRef)
            ? { complete: false, issues: [], reason: "rate-limited" }
            : await reader.readSelection(selection).catch(() => ({
                complete: false as const,
                issues: [],
                reason: "reader-error",
              }));
        if (this.stopped) return;
        if (!(reader instanceof CredentialGitHubSourceReader))
          this.notePause(credentialRef, snapshot);
        const committed = this.sources.reconcileSelection(
          projectId,
          selection.id,
          snapshot,
          {
            projectId,
            configVersion: config.version,
            credentialRef: config.credentialRef,
          },
        );
        if (!committed) continue;
        if (!snapshot.complete) continue;
        for (const issue of snapshot.issues) {
          const reads = this.readsBlockers(issue);
          if (!reads) continue;
          const reference: IssueReference = {
            nodeId: issue.nodeId,
            repositoryId: issue.repositoryId,
            repositoryName: issue.repositoryName,
            number: issue.number,
          };
          // Paused and unread issues are recorded as unknown, never left with an
          // earlier "clear" that a later readiness could admit before its read.
          const blockers: BlockerSnapshot =
            reads === "unneeded"
              ? { complete: false, blockers: [], reason: "task-unready" }
              : !(reader instanceof CredentialGitHubSourceReader) &&
                  this.paused(credentialRef)
                ? { complete: false, blockers: [], reason: "rate-limited" }
                : await reader.readBlockers(reference).catch(() => ({
                    complete: false,
                    blockers: [],
                    reason: "reader-error",
                  }));
          if (this.stopped) return;
          if (!(reader instanceof CredentialGitHubSourceReader))
            this.notePause(credentialRef, blockers);
          this.sources.reconcileBlockers(issue.nodeId, blockers, {
            projectId,
            configVersion: config.version,
            credentialRef: config.credentialRef,
            selectionId: selection.id,
            reference,
          });
        }
      }
    }
    for (const retained of this.sources.localBlockerReferences()) {
      if (this.stopped) return;
      const config = this.domain.githubConfiguration(retained.projectId);
      const credentialRef = config.credentialRef;
      const reader = credentialRef ? readerFor(credentialRef) : undefined;
      const paused =
        credentialRef && !(reader instanceof CredentialGitHubSourceReader)
          ? this.paused(credentialRef)
          : false;
      // A paused read must not leave an earlier "closed" clearing a local dependent.
      const status: IssueStatus = paused
        ? { status: "unknown", reason: "rate-limited" }
        : reader
          ? await reader.readIssueStatus(retained.reference).catch(() => ({
              status: "unknown" as const,
              reason: "reader-error",
            }))
          : { status: "unknown", reason: "missing-credential" };
      if (this.stopped) return;
      if (credentialRef && !(reader instanceof CredentialGitHubSourceReader))
        this.notePause(credentialRef, status);
      this.sources.recordIssueStatus(retained.reference.nodeId, status, {
        projectId: retained.projectId,
        configVersion: config.version,
        credentialRef: config.credentialRef,
        reference: retained.reference,
      });
    }
  }
}
