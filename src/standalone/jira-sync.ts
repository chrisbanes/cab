import type { DomainStore } from "../core/domain.js";
import type {
  GitHubSourceStore,
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
    for (const project of this.domain.projects()) {
      const projectId = String(project.id);
      const config = this.domain.jiraConfiguration(projectId);
      if (!config) continue;
      const active = new Set(this.domain.githubActiveSelectionIds(projectId));
      const reader = this.readerFactory(config.instance);
      for (const selection of config.selections) {
        if (this.stopped) return;
        if (!active.has(selection.id)) continue;
        const paused =
          (this.pausedUntil.get(config.instance) ?? 0) > Date.now();
        const snapshot: SelectionSnapshot = paused
          ? { complete: false, issues: [], reason: "rate-limited" }
          : await reader.readSelection(selection).catch(() => ({
              complete: false as const,
              issues: [],
              reason: "reader-error",
            }));
        if (this.stopped) return;
        if (!snapshot.complete && snapshot.resumeAt !== undefined)
          this.pausedUntil.set(config.instance, snapshot.resumeAt);
        this.storeFor(config.instance).reconcileSelection(
          projectId,
          selection.id,
          snapshot,
          { projectId, configVersion: config.version, credentialRef: null },
        );
      }
    }
  }
}
