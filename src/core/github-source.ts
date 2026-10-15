import { TaskReviewStore } from "./task-review.js";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { transaction, type Database } from "./store.js";

const parseRule = (json: unknown) =>
  readinessSchema.nullable().parse(JSON.parse(String(json)) as unknown);

/** Why an imported task is or is not Draft, with its project's rule. */
export interface TaskReadiness {
  rule: Readiness | null;
  outcome: "matched" | "unmet" | "not-evaluated";
  unmet: ReadinessCondition[];
}

export interface IssueSnapshot {
  providerInstance: "github.com";
  nodeId: string;
  repositoryId: string;
  repositoryName: string;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  projectFields: Array<{
    projectNodeId: string;
    fieldNodeId: string;
    optionNodeId: string;
  }>;
}
/** `resumeAt` (epoch ms) marks a rate-limited read: do not read again before then. */
export type SelectionSnapshot =
  | { complete: true; issues: IssueSnapshot[]; reason: null }
  | {
      complete: false;
      issues: IssueSnapshot[];
      reason: string;
      resumeAt?: number;
    };
export type IssueStatus = {
  status: "open" | "closed" | "unknown";
  reason?: string;
  resumeAt?: number;
};
export type BlockerSnapshot = {
  complete: boolean;
  blockers: IssueSnapshot[];
  reason: string | null;
  resumeAt?: number;
};
export interface IssueReference {
  nodeId: string;
  repositoryId: string;
  repositoryName: string;
  number: number;
}

export interface GitHubObservationBinding {
  projectId: string;
  configVersion: number;
  credentialRef: string | null;
}

import {
  nonempty,
  projectFieldsSchema,
  repositoryLinkSchema,
  readinessSchema,
  selectionSchema,
  evaluateReadiness,
  type Readiness,
  type ReadinessCondition,
} from "./github-source-contracts.js";
export {
  repositoryLinkSchema,
  readinessSchema,
  selectionSchema,
  githubConfigurationSchema,
  githubConfigurationCommandSchema,
  type GitHubConfigurationInput,
  type GitHubSelection,
} from "./github-source-contracts.js";
export const linkedRepositorySchema = repositoryLinkSchema.extend({
  gitCommonDirectory: z.string().min(1).refine(isAbsolute),
});
export type LinkedRepository = z.output<typeof linkedRepositorySchema>;

export type RepositoryVerificationReason =
  | "path-invalid"
  | "not-checkout"
  | "origin-missing"
  | "origin-provider"
  | "origin-mismatch"
  | "ref-unavailable";
/** A failed checkout check; `actual` is the origin's `owner/name` on `origin-mismatch`. */
export class RepositoryVerificationError extends Error {
  constructor(
    readonly reason: RepositoryVerificationReason,
    readonly actual: string | null = null,
  ) {
    super(`Repository verification failed: ${reason}`);
    this.name = "RepositoryVerificationError";
  }
}
const githubSegment = /^[A-Za-z0-9_.-]{1,100}$/;
/**
 * `owner/name` of a `github.com` remote URL, or null for any other host or shape.
 * Userinfo, a trailing `/` and a `.git` suffix are ignored; the URL itself is never returned.
 */
export function parseGitHubOrigin(
  url: string,
): { owner: string; name: string } | null {
  let host: string, path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!["https:", "ssh:", "git:"].includes(parsed.protocol) || parsed.port)
      return null;
    host = parsed.hostname;
    path = decodeURIComponent(parsed.pathname);
  } else {
    const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(url);
    if (!scp?.[1] || !scp[2]) return null;
    host = scp[1];
    path = scp[2];
  }
  if (host.toLowerCase() !== "github.com") return null;
  const parts = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/");
  const [owner, name] = parts;
  if (
    parts.length !== 2 ||
    !owner ||
    !name ||
    !githubSegment.test(owner) ||
    !githubSegment.test(name) ||
    [owner, name].some((segment) => segment === "." || segment === "..")
  )
    return null;
  return { owner, name };
}
/** Verifies a local checkout; the host supplies the implementation (see `DomainStore`). */
export type RepositoryVerifier = (
  input: z.output<typeof repositoryLinkSchema>,
  expectedOrigin?: { owner: string; name: string },
) => Promise<LinkedRepository>;

type Row = Record<string, string | number | null>;

export function sourceTextDigest(title: string, body: string): string {
  return createHash("sha256")
    .update(JSON.stringify([title, body]))
    .digest("hex");
}

/** Provider-owned observations. Each selection's complete generation commits atomically. */
export class GitHubSourceStore {
  constructor(private readonly db: Database) {}

  private currentBinding(
    binding: GitHubObservationBinding,
    selectionId?: string,
  ): boolean {
    const current = this.db
      .prepare(
        "SELECT version, credentialRef FROM project_github_sources WHERE projectId = ?",
      )
      .get(binding.projectId) as Row | undefined;
    if (
      !current ||
      Number(current.version) !== binding.configVersion ||
      current.credentialRef !== binding.credentialRef
    )
      return false;
    return (
      !selectionId ||
      Boolean(
        this.db
          .prepare(
            "SELECT 1 FROM project_github_active WHERE projectId = ? AND selectionId = ? AND configVersion = ?",
          )
          .get(binding.projectId, selectionId, binding.configVersion),
      )
    );
  }

  migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS github_external_issues (
      providerInstance TEXT NOT NULL CHECK(providerInstance = 'github.com'), nodeId TEXT NOT NULL,
      taskId TEXT NOT NULL UNIQUE REFERENCES domain_tasks(id), repositoryId TEXT NOT NULL,
      repositoryName TEXT NOT NULL, issueNumber INTEGER NOT NULL,
      observedTitle TEXT NOT NULL, observedBody TEXT NOT NULL, observedState TEXT NOT NULL,
      labels TEXT NOT NULL, PRIMARY KEY(providerInstance, nodeId), UNIQUE(nodeId)
    );
    CREATE TABLE IF NOT EXISTS github_memberships (
      projectId TEXT NOT NULL REFERENCES domain_projects(id), selectionId TEXT NOT NULL,
      nodeId TEXT NOT NULL, projectFields TEXT NOT NULL,
      PRIMARY KEY(projectId, selectionId, nodeId),
      FOREIGN KEY(nodeId) REFERENCES github_external_issues(nodeId)
    );
    CREATE TABLE IF NOT EXISTS github_sync_state (
      projectId TEXT NOT NULL REFERENCES domain_projects(id), selectionId TEXT NOT NULL,
      complete INTEGER NOT NULL CHECK(complete IN (0,1)), reason TEXT,
      refreshedAt TEXT NOT NULL, skippedClosedNodeIds TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY(projectId, selectionId)
    );
    CREATE TABLE IF NOT EXISTS github_placement_decisions (
      nodeId TEXT PRIMARY KEY REFERENCES github_external_issues(nodeId),
      projectId TEXT NOT NULL REFERENCES domain_projects(id)
    );
    CREATE TABLE IF NOT EXISTS github_native_blockers (
      nodeId TEXT NOT NULL REFERENCES github_external_issues(nodeId), blockerNodeId TEXT NOT NULL,
      repositoryId TEXT NOT NULL, repositoryName TEXT NOT NULL, issueNumber INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','closed')),
      PRIMARY KEY(nodeId, blockerNodeId)
    );
    CREATE TABLE IF NOT EXISTS github_dependency_observations (
      nodeId TEXT PRIMARY KEY REFERENCES github_external_issues(nodeId),
      complete INTEGER NOT NULL CHECK(complete IN (0,1)), reason TEXT, refreshedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS github_source_reviews (
      nodeId TEXT PRIMARY KEY REFERENCES github_external_issues(nodeId),
      observedDigest TEXT NOT NULL, acceptedDigest TEXT NOT NULL,
      decision TEXT, decidedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS github_delivery_closures (nodeId TEXT PRIMARY KEY, operationId TEXT NOT NULL, closerPrNodeId TEXT, snapshotJson TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS github_source_holds (
      nodeId TEXT PRIMARY KEY REFERENCES github_external_issues(nodeId),
      active INTEGER NOT NULL CHECK(active IN (0,1)), reason TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation > 0)
    );
    CREATE TABLE IF NOT EXISTS github_provider_completions (
      taskId TEXT PRIMARY KEY REFERENCES domain_tasks(id),
      nodeId TEXT NOT NULL, completedAt TEXT NOT NULL
    );`);
    const syncColumns = this.db
      .prepare("PRAGMA table_info(github_sync_state)")
      .all() as Row[];
    if (!syncColumns.some((c) => c.name === "skippedClosedNodeIds"))
      this.db.exec(
        "ALTER TABLE github_sync_state ADD COLUMN skippedClosedNodeIds TEXT NOT NULL DEFAULT '[]'",
      );
  }

  issue(nodeId: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT * FROM github_external_issues WHERE providerInstance = 'github.com' AND nodeId = ?",
      )
      .get(nodeId) as Row | undefined;
  }

  memberships(nodeId: string): Row[] {
    return this.db
      .prepare(
        "SELECT projectId, selectionId, nodeId, projectFields FROM github_memberships WHERE nodeId = ? ORDER BY selectionId, projectId",
      )
      .all(nodeId) as Row[];
  }

  syncState(projectId: string, selectionId: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT projectId, selectionId, complete, reason, refreshedAt FROM github_sync_state WHERE projectId = ? AND selectionId = ?",
      )
      .get(projectId, selectionId) as Row | undefined;
  }

  review(nodeId: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT observedDigest, acceptedDigest, decision, decidedAt FROM github_source_reviews WHERE nodeId = ?",
      )
      .get(nodeId) as Row | undefined;
  }

  /** Set only while a Done task was completed by GitHub closure under a Done-mode source. */
  providerCompletion(taskId: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT nodeId, completedAt FROM github_provider_completions WHERE taskId = ?",
      )
      .get(taskId) as Row | undefined;
  }

  /**
   * Completes a closure-held task under a Done-mode source. Every condition is
   * rechecked here, and `settled` runs inside the same transaction.
   */
  completeFromProviderClosure(taskId: string, settled: () => boolean): boolean {
    return transaction(this.db, () => {
      const task = this.db
        .prepare(`SELECT e.nodeId, t.projectId FROM github_external_issues e
        JOIN domain_tasks t ON t.id = e.taskId
        JOIN project_github_sources c ON c.projectId = t.projectId
        WHERE e.taskId = ? AND t.state = 'open' AND e.observedState = 'closed'
          AND c.closedIssues = 'done'
          AND EXISTS (SELECT 1 FROM github_source_holds h
            WHERE h.nodeId = e.nodeId AND h.active = 1 AND h.reason = 'closed')
          AND NOT EXISTS (SELECT 1 FROM github_delivery_closures d WHERE d.nodeId = e.nodeId)`)
        .get(taskId) as Row | undefined;
      if (!task) return false;
      const memberships = this.db
        .prepare(`SELECT CASE WHEN a.configVersion = c.version THEN s.complete ELSE 0 END AS complete
        FROM github_memberships m
        JOIN project_github_sources c ON c.projectId = m.projectId
        LEFT JOIN github_sync_state s ON s.projectId = m.projectId AND s.selectionId = m.selectionId
        LEFT JOIN project_github_active a ON a.projectId = m.projectId AND a.selectionId = m.selectionId
        WHERE m.nodeId = ? AND m.projectId = ?`)
        .all(String(task.nodeId), String(task.projectId)) as Row[];
      if (
        memberships.length === 0 ||
        memberships.some((row) => Number(row.complete) !== 1) ||
        !settled()
      )
        return false;
      this.db
        .prepare(
          "UPDATE domain_tasks SET state = 'done', version = version + 1 WHERE id = ?",
        )
        .run(taskId);
      this.db
        .prepare(
          "INSERT INTO github_provider_completions (taskId, nodeId, completedAt) VALUES (?, ?, ?)",
        )
        .run(taskId, String(task.nodeId), new Date().toISOString());
      return true;
    });
  }

  hold(nodeId: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT active, reason, generation FROM github_source_holds WHERE nodeId = ?",
      )
      .get(nodeId) as Row | undefined;
  }

  conflicts(): Array<{ nodeId: string; taskId: string; projectIds: string[] }> {
    const rows = this.db
      .prepare(`SELECT e.nodeId, e.taskId, m.projectId
      FROM github_external_issues e JOIN github_memberships m ON m.nodeId = e.nodeId
      WHERE NOT EXISTS (SELECT 1 FROM github_placement_decisions d WHERE d.nodeId = e.nodeId)
        AND NOT EXISTS (SELECT 1 FROM domain_assignments a WHERE a.taskId = e.taskId)
      ORDER BY e.nodeId, m.projectId`)
      .all() as Row[];
    const grouped = new Map<
      string,
      { nodeId: string; taskId: string; projectIds: Set<string> }
    >();
    for (const row of rows) {
      const nodeId = String(row.nodeId);
      const item = grouped.get(nodeId) ?? {
        nodeId,
        taskId: String(row.taskId),
        projectIds: new Set<string>(),
      };
      item.projectIds.add(String(row.projectId));
      grouped.set(nodeId, item);
    }
    return [...grouped.values()]
      .filter((item) => item.projectIds.size > 1)
      .map((item) => ({
        nodeId: item.nodeId,
        taskId: item.taskId,
        projectIds: [...item.projectIds],
      }));
  }

  nativeBlockers(nodeId: string): Row[] {
    return this.db
      .prepare(
        "SELECT blockerNodeId, repositoryId, repositoryName, issueNumber, status FROM github_native_blockers WHERE nodeId = ? ORDER BY blockerNodeId",
      )
      .all(nodeId) as Row[];
  }

  activeHolds(): Array<{
    nodeId: string;
    taskId: string;
    reason: string;
    generation: number;
  }> {
    const rows = this.db
      .prepare(`SELECT h.nodeId, e.taskId, h.reason, h.generation
      FROM github_source_holds h JOIN github_external_issues e ON e.nodeId = h.nodeId
      WHERE h.active = 1 ORDER BY h.nodeId`)
      .all() as Row[];
    return rows.map((row) => ({
      nodeId: String(row.nodeId),
      taskId: String(row.taskId),
      reason: String(row.reason),
      generation: Number(row.generation),
    }));
  }

  localBlockerReferences(): Array<{
    projectId: string;
    reference: IssueReference;
  }> {
    const rows = this.db
      .prepare(`SELECT DISTINCT t.projectId, e.nodeId, e.repositoryId,
      e.repositoryName, e.issueNumber FROM local_dependencies d
      JOIN github_external_issues e ON e.taskId = d.blockerTaskId
      JOIN domain_tasks t ON t.id = e.taskId ORDER BY e.nodeId`)
      .all() as Row[];
    return rows.map((row) => ({
      projectId: String(row.projectId),
      reference: {
        nodeId: String(row.nodeId),
        repositoryId: String(row.repositoryId),
        repositoryName: String(row.repositoryName),
        number: Number(row.issueNumber),
      },
    }));
  }

  recordIssueStatus(
    nodeId: string,
    observation: IssueStatus,
    binding?: GitHubObservationBinding & { reference: IssueReference },
  ): boolean {
    return transaction(this.db, () => {
      const issue = this.issue(nodeId);
      if (
        binding &&
        (!this.currentBinding(binding) ||
          !issue ||
          issue.nodeId !== binding.reference.nodeId ||
          issue.repositoryId !== binding.reference.repositoryId ||
          issue.repositoryName !== binding.reference.repositoryName ||
          Number(issue.issueNumber) !== binding.reference.number ||
          !this.db
            .prepare(
              "SELECT 1 FROM domain_tasks WHERE id = ? AND projectId = ?",
            )
            .get(String(issue.taskId), binding.projectId))
      ) {
        return false;
      }
      if (!issue) throw new Error("Unknown imported issue");
      const prior = this.db
        .prepare("SELECT status FROM github_issue_status WHERE nodeId = ?")
        .get(nodeId) as Row | undefined;
      this.db
        .prepare(
          "INSERT INTO github_issue_status (nodeId, status, reason, refreshedAt) VALUES (?, ?, ?, ?) ON CONFLICT(nodeId) DO UPDATE SET status = excluded.status, reason = excluded.reason, refreshedAt = excluded.refreshedAt",
        )
        .run(
          nodeId,
          observation.status,
          observation.reason ?? null,
          new Date().toISOString(),
        );
      if ((prior?.status === "closed") !== (observation.status === "closed"))
        this.db
          .prepare(
            "UPDATE domain_tasks SET version = version + 1 WHERE id IN (SELECT taskId FROM local_dependencies WHERE blockerTaskId = ?)",
          )
          .run(String(issue.taskId));
      return true;
    });
  }

  invalidateProviderObservations(): void {
    transaction(this.db, () => {
      this.db
        .prepare(`UPDATE domain_tasks SET importedBlockers = 'unknown', version = version + 1
        WHERE id IN (SELECT taskId FROM github_external_issues) AND importedBlockers != 'unknown'`)
        .run();
      this.db
        .prepare(`UPDATE domain_tasks SET version = version + 1
        WHERE id IN (SELECT d.taskId FROM local_dependencies d
          JOIN github_external_issues e ON e.taskId = d.blockerTaskId
          JOIN github_issue_status s ON s.nodeId = e.nodeId WHERE s.status = 'closed')`)
        .run();
      this.db
        .prepare(
          "UPDATE github_issue_status SET status = 'unknown', reason = 'startup-refresh-required'",
        )
        .run();
      this.db
        .prepare(
          "UPDATE github_dependency_observations SET complete = 0, reason = 'startup-refresh-required'",
        )
        .run();
      this.db
        .prepare(
          "UPDATE github_sync_state SET complete = 0, reason = 'startup-refresh-required'",
        )
        .run();
    });
  }

  /** A failed credential check invalidates knowledge, never fabricates a provider attempt. */
  invalidateCredentialFailure(
    binding: GitHubObservationBinding,
    reason:
      | "missing-credential"
      | "invalid-credential-reference"
      | "gh-not-installed"
      | "gh-not-signed-in"
      | "gh-unreadable",
  ): boolean {
    const controlled = z
      .enum([
        "missing-credential",
        "invalid-credential-reference",
        "gh-not-installed",
        "gh-not-signed-in",
        "gh-unreadable",
      ])
      .parse(reason);
    return transaction(this.db, () => {
      if (!this.currentBinding(binding)) return false;
      this.db
        .prepare(`UPDATE domain_tasks SET importedBlockers = 'unknown', version = version + 1
        WHERE projectId = ? AND id IN (SELECT taskId FROM github_external_issues) AND importedBlockers != 'unknown'`)
        .run(binding.projectId);
      this.db
        .prepare(`UPDATE domain_tasks SET version = version + 1
        WHERE id IN (SELECT d.taskId FROM local_dependencies d
          JOIN github_external_issues e ON e.taskId = d.blockerTaskId
          JOIN domain_tasks b ON b.id = e.taskId
          JOIN github_issue_status s ON s.nodeId = e.nodeId
          WHERE b.projectId = ? AND s.status = 'closed')`)
        .run(binding.projectId);
      this.db
        .prepare(`UPDATE github_issue_status SET status = 'unknown', reason = ?
        WHERE nodeId IN (SELECT e.nodeId FROM github_external_issues e
          JOIN domain_tasks t ON t.id = e.taskId WHERE t.projectId = ?)`)
        .run(controlled, binding.projectId);
      this.db
        .prepare(`UPDATE github_dependency_observations SET complete = 0, reason = ?
        WHERE nodeId IN (SELECT e.nodeId FROM github_external_issues e
          JOIN domain_tasks t ON t.id = e.taskId WHERE t.projectId = ?)`)
        .run(controlled, binding.projectId);
      this.db
        .prepare(`UPDATE domain_tasks SET version = version + 1
        WHERE projectId = ? AND id IN (SELECT e.taskId FROM github_external_issues e
          JOIN github_memberships m ON m.nodeId = e.nodeId
          JOIN github_sync_state s ON s.projectId = m.projectId AND s.selectionId = m.selectionId
          JOIN project_github_active a ON a.projectId = m.projectId AND a.selectionId = m.selectionId
          WHERE m.projectId = ? AND a.configVersion = ? AND s.complete = 1)`)
        .run(binding.projectId, binding.projectId, binding.configVersion);
      this.db
        .prepare(`UPDATE github_sync_state SET complete = 0, reason = ?
        WHERE projectId = ? AND selectionId IN (SELECT selectionId FROM project_github_active
          WHERE projectId = ? AND configVersion = ?)`)
        .run(
          controlled,
          binding.projectId,
          binding.projectId,
          binding.configVersion,
        );
      return true;
    });
  }

  reconcileBlockers(
    nodeId: string,
    snapshot: BlockerSnapshot,
    binding?: GitHubObservationBinding & {
      selectionId: string;
      reference: IssueReference;
    },
  ): boolean {
    return transaction(this.db, () => {
      const issue = this.issue(nodeId);
      if (!issue) throw new Error("Unknown imported issue");
      if (
        binding &&
        (!this.currentBinding(binding, binding.selectionId) ||
          nodeId !== binding.reference.nodeId ||
          issue.repositoryId !== binding.reference.repositoryId ||
          issue.repositoryName !== binding.reference.repositoryName ||
          Number(issue.issueNumber) !== binding.reference.number ||
          !this.db
            .prepare(
              "SELECT 1 FROM github_memberships WHERE projectId = ? AND selectionId = ? AND nodeId = ?",
            )
            .get(binding.projectId, binding.selectionId, nodeId))
      ) {
        return false;
      }
      if (snapshot.complete) {
        this.db
          .prepare("DELETE FROM github_native_blockers WHERE nodeId = ?")
          .run(nodeId);
        for (const blocker of snapshot.blockers) {
          if (blocker.providerInstance !== "github.com")
            throw new Error("Provider identity mismatch");
          this.db
            .prepare(
              "INSERT OR IGNORE INTO github_native_blockers (nodeId, blockerNodeId, repositoryId, repositoryName, issueNumber, status) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(
              nodeId,
              blocker.nodeId,
              blocker.repositoryId,
              blocker.repositoryName,
              blocker.number,
              blocker.state,
            );
        }
      }
      this.db
        .prepare(
          "INSERT INTO github_dependency_observations (nodeId, complete, reason, refreshedAt) VALUES (?, ?, ?, ?) ON CONFLICT(nodeId) DO UPDATE SET complete = excluded.complete, reason = excluded.reason, refreshedAt = excluded.refreshedAt",
        )
        .run(
          nodeId,
          Number(snapshot.complete),
          snapshot.reason,
          new Date().toISOString(),
        );
      const state = !snapshot.complete
        ? "unknown"
        : this.nativeBlockers(nodeId).some(
              (blocker) => blocker.status === "open",
            )
          ? "blocked"
          : "clear";
      const task = this.db
        .prepare("SELECT importedBlockers FROM domain_tasks WHERE id = ?")
        .get(String(issue.taskId)) as Row;
      if (task.importedBlockers !== state)
        this.db
          .prepare(
            "UPDATE domain_tasks SET importedBlockers = ?, version = version + 1 WHERE id = ?",
          )
          .run(state, String(issue.taskId));
      return true;
    });
  }

  reconcileSelection(
    projectId: string,
    selectionId: string,
    snapshot: SelectionSnapshot,
    binding?: GitHubObservationBinding,
  ): boolean {
    return transaction(this.db, () => {
      if (
        binding &&
        (binding.projectId !== projectId ||
          !this.currentBinding(binding, selectionId))
      ) {
        return false;
      }
      const config = this.db
        .prepare(
          "SELECT version, readiness, selections, closedIssues FROM project_github_sources WHERE projectId = ?",
        )
        .get(projectId) as Row | undefined;
      if (!config) throw new Error("GitHub selection is not active");
      const active = this.db
        .prepare(
          "SELECT 1 FROM project_github_active WHERE projectId = ? AND selectionId = ? AND configVersion = ?",
        )
        .get(projectId, selectionId, Number(config.version)) as Row | undefined;
      if (!active) throw new Error("GitHub selection is not active");
      const selections = z
        .array(selectionSchema)
        .parse(JSON.parse(String(config.selections)) as unknown);
      if (!selections.some((selection) => selection.id === selectionId))
        throw new Error("Unknown GitHub selection");
      const previousSync = this.syncState(projectId, selectionId);
      const seen = new Set<string>();
      // Closed issues this read left unimported; counted as observed without a task.
      const skipped = new Set<string>();
      const sourceCaptures: {
        taskId: string;
        kind: "github";
        supplied: { title: string; body: string };
      }[] = [];
      for (const issue of snapshot.issues) {
        if (issue.providerInstance !== "github.com")
          throw new Error("Provider identity mismatch");
        if (seen.has(issue.nodeId)) continue;
        seen.add(issue.nodeId);
        const existing = this.issue(issue.nodeId);
        let taskId: string;
        if (!existing) {
          // A closed issue is imported, as Done, only by a Done-mode source on a complete read.
          const importClosed =
            config.closedIssues === "done" && snapshot.complete;
          if (issue.state === "closed" && !importClosed) {
            skipped.add(issue.nodeId);
            continue;
          }
          taskId = randomUUID();
          this.db
            .prepare(
              "INSERT INTO tasks (id, projectId, title) VALUES (?, ?, ?)",
            )
            .run(taskId, projectId, issue.title);
          this.db
            .prepare(
              "INSERT INTO domain_tasks (id, projectId, version, outcome, ready, state, importedBlockers) VALUES (?, ?, 1, ?, 0, ?, 'unknown')",
            )
            .run(
              taskId,
              projectId,
              issue.body,
              issue.state === "closed" ? "done" : "open",
            );
          this.db
            .prepare(
              "INSERT INTO github_imported_tasks (taskId, providerInstance, nodeId, repositoryId) VALUES (?, 'github.com', ?, ?)",
            )
            .run(taskId, issue.nodeId, issue.repositoryId);
          this.db
            .prepare(
              "INSERT INTO github_external_issues (providerInstance, nodeId, taskId, repositoryId, repositoryName, issueNumber, observedTitle, observedBody, observedState, labels) VALUES ('github.com', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              issue.nodeId,
              taskId,
              issue.repositoryId,
              issue.repositoryName,
              issue.number,
              issue.title,
              issue.body,
              issue.state,
              JSON.stringify(issue.labels),
            );
          const digest = sourceTextDigest(issue.title, issue.body);
          this.db
            .prepare(
              "INSERT INTO github_source_reviews (nodeId, observedDigest, acceptedDigest) VALUES (?, ?, ?)",
            )
            .run(issue.nodeId, digest, digest);
          if (issue.state === "closed")
            this.db
              .prepare(
                "INSERT INTO github_provider_completions (taskId, nodeId, completedAt) VALUES (?, ?, ?)",
              )
              .run(taskId, issue.nodeId, new Date().toISOString());
        } else {
          taskId = String(existing.taskId);
          const digest = sourceTextDigest(issue.title, issue.body);
          const prior = this.db
            .prepare(
              "SELECT observedDigest FROM github_source_reviews WHERE nodeId = ?",
            )
            .get(issue.nodeId) as Row | undefined;
          if (prior?.observedDigest !== digest) {
            this.db
              .prepare(
                "INSERT INTO github_source_reviews (nodeId, observedDigest, acceptedDigest) VALUES (?, ?, ?) ON CONFLICT(nodeId) DO UPDATE SET observedDigest = excluded.observedDigest",
              )
              .run(
                issue.nodeId,
                digest,
                prior?.observedDigest ??
                  sourceTextDigest(
                    String(existing.observedTitle),
                    String(existing.observedBody),
                  ),
              );
            this.db
              .prepare(
                "UPDATE domain_tasks SET version = version + 1 WHERE id = ?",
              )
              .run(taskId);
            this.setSourceHold(issue.nodeId, "changed-text");
          }
          this.db
            .prepare(
              "UPDATE github_external_issues SET repositoryId = ?, repositoryName = ?, issueNumber = ?, observedTitle = ?, observedBody = ?, observedState = ?, labels = ? WHERE providerInstance = 'github.com' AND nodeId = ?",
            )
            .run(
              issue.repositoryId,
              issue.repositoryName,
              issue.number,
              issue.title,
              issue.body,
              issue.state,
              JSON.stringify(issue.labels),
              issue.nodeId,
            );
        }
        this.db
          .prepare(
            "INSERT INTO github_memberships (projectId, selectionId, nodeId, projectFields) VALUES (?, ?, ?, ?) ON CONFLICT(projectId, selectionId, nodeId) DO UPDATE SET projectFields = excluded.projectFields",
          )
          .run(
            projectId,
            selectionId,
            issue.nodeId,
            JSON.stringify(issue.projectFields),
          );
        sourceCaptures.push({
          taskId,
          kind: "github",
          supplied: { title: issue.title, body: issue.body },
        });
        this.updateReadiness(taskId);
      }
      new TaskReviewStore(this.db).captureSources(sourceCaptures);
      if (snapshot.complete) {
        const old = this.db
          .prepare(
            "SELECT nodeId FROM github_memberships WHERE projectId = ? AND selectionId = ?",
          )
          .all(projectId, selectionId) as Row[];
        for (const membership of old)
          if (!seen.has(String(membership.nodeId))) {
            this.db
              .prepare(
                "DELETE FROM github_memberships WHERE projectId = ? AND selectionId = ? AND nodeId = ?",
              )
              .run(projectId, selectionId, String(membership.nodeId));
            const external = this.issue(String(membership.nodeId));
            if (external) this.updateReadiness(String(external.taskId));
          }
      } else {
        const retained = this.db
          .prepare(`SELECT e.nodeId, e.taskId FROM github_memberships m
          JOIN github_external_issues e ON e.nodeId = m.nodeId
          WHERE m.projectId = ? AND m.selectionId = ?`)
          .all(projectId, selectionId) as Row[];
        for (const issue of retained) {
          this.db
            .prepare(
              "UPDATE github_dependency_observations SET complete = 0, reason = 'source-read-incomplete' WHERE nodeId = ?",
            )
            .run(String(issue.nodeId));
          this.db
            .prepare(
              "UPDATE domain_tasks SET importedBlockers = 'unknown', version = version + 1 WHERE id = ? AND importedBlockers != 'unknown'",
            )
            .run(String(issue.taskId));
        }
      }
      // A complete read replaces the skipped issues; a partial read adds to them, as it
      // adds memberships without pruning.
      if (!snapshot.complete) {
        const stored = this.db
          .prepare(
            "SELECT skippedClosedNodeIds FROM github_sync_state WHERE projectId = ? AND selectionId = ?",
          )
          .get(projectId, selectionId) as Row | undefined;
        const prior = z
          .array(z.string())
          .parse(
            JSON.parse(String(stored?.skippedClosedNodeIds ?? "[]")) as unknown,
          );
        for (const id of prior) skipped.add(id);
      }
      this.db
        .prepare(
          "INSERT INTO github_sync_state (projectId, selectionId, complete, reason, refreshedAt, skippedClosedNodeIds) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(projectId, selectionId) DO UPDATE SET complete = excluded.complete, reason = excluded.reason, refreshedAt = excluded.refreshedAt, skippedClosedNodeIds = excluded.skippedClosedNodeIds",
        )
        .run(
          projectId,
          selectionId,
          Number(snapshot.complete),
          snapshot.reason,
          new Date().toISOString(),
          JSON.stringify([...skipped]),
        );
      if (
        previousSync &&
        Number(previousSync.complete) !== Number(snapshot.complete)
      )
        this.db
          .prepare(`UPDATE domain_tasks SET version = version + 1 WHERE id IN (
          SELECT e.taskId FROM github_external_issues e JOIN github_memberships m ON m.nodeId = e.nodeId
          WHERE m.projectId = ? AND m.selectionId = ?)`)
          .run(projectId, selectionId);
      return true;
    });
  }

  recordDeliveryClosure(
    projectId: string,
    configVersion: number,
    input: IssueSnapshot,
    operationId: string,
    closerPrNodeId: string | null,
  ): boolean {
    const snapshot = z
      .object({
        providerInstance: z.literal("github.com"),
        nodeId: nonempty,
        repositoryId: nonempty,
        repositoryName: nonempty,
        number: z.number().int().positive(),
        title: z.string(),
        body: z.string(),
        state: z.literal("closed"),
        labels: z.array(nonempty),
        projectFields: projectFieldsSchema,
      })
      .strict()
      .parse(input);
    return transaction(this.db, () => {
      const issue = this.issue(snapshot.nodeId),
        config = this.db
          .prepare(
            "SELECT version,readiness,selections FROM project_github_sources WHERE projectId=?",
          )
          .get(projectId) as Row | undefined;
      if (
        !issue ||
        !config ||
        config.version !== configVersion ||
        issue.repositoryId !== snapshot.repositoryId ||
        issue.repositoryName !== snapshot.repositoryName ||
        Number(issue.issueNumber) !== snapshot.number ||
        !this.db
          .prepare("SELECT 1 FROM domain_tasks WHERE id=? AND projectId=?")
          .get(String(issue.taskId), projectId)
      ) {
        return false;
      }
      const digest = sourceTextDigest(snapshot.title, snapshot.body),
        review = this.review(snapshot.nodeId);
      if (review?.observedDigest !== digest) {
        this.db
          .prepare(
            "UPDATE github_source_reviews SET observedDigest=? WHERE nodeId=?",
          )
          .run(digest, snapshot.nodeId);
        this.db
          .prepare("UPDATE domain_tasks SET version=version+1 WHERE id=?")
          .run(String(issue.taskId));
        this.setSourceHold(snapshot.nodeId, "changed-text");
      }
      this.db
        .prepare(
          "UPDATE github_external_issues SET observedState='closed',observedTitle=?,observedBody=?,labels=? WHERE nodeId=?",
        )
        .run(
          snapshot.title,
          snapshot.body,
          JSON.stringify(snapshot.labels),
          snapshot.nodeId,
        );
      new TaskReviewStore(this.db).captureSource(
        String(issue.taskId),
        "github",
        { title: snapshot.title, body: snapshot.body },
      );
      const priorHold = this.db
        .prepare("SELECT active,reason FROM github_source_holds WHERE nodeId=?")
        .get(snapshot.nodeId) as Row | undefined;
      this.updateReadiness(String(issue.taskId), true);
      const rule = readinessSchema.parse(JSON.parse(String(config.readiness)));
      const labelProof =
        rule.conditions.every((c) => c.kind === "label") &&
        (rule.mode === "all"
          ? rule.conditions.every(
              (c) => c.kind === "label" && snapshot.labels.includes(c.name),
            )
          : rule.conditions.some(
              (c) => c.kind === "label" && snapshot.labels.includes(c.name),
            ));
      const hold = priorHold;
      if (
        labelProof &&
        (!hold?.active ||
          ["closed", "withdrawn", "closure-read-unavailable"].includes(
            String(hold.reason),
          ))
      )
        this.setSourceHold(snapshot.nodeId, "closed");
      else if (!labelProof && (!hold?.active || hold.reason === "closed"))
        this.setSourceHold(snapshot.nodeId, "readiness-lost");
      else if (hold?.active)
        this.setSourceHold(snapshot.nodeId, String(hold.reason));
      this.db
        .prepare(
          "INSERT INTO github_delivery_closures VALUES (?,?,?,?) ON CONFLICT(nodeId) DO UPDATE SET operationId=excluded.operationId,closerPrNodeId=excluded.closerPrNodeId,snapshotJson=excluded.snapshotJson",
        )
        .run(
          snapshot.nodeId,
          operationId,
          closerPrNodeId,
          JSON.stringify(snapshot),
        );
      return true;
    });
  }
  recordDeliveryClosureUnavailable(nodeId: string): void {
    const hold = this.db
      .prepare("SELECT active,reason FROM github_source_holds WHERE nodeId=?")
      .get(nodeId) as Row | undefined;
    if (!hold?.active || hold.reason === "closed")
      this.setSourceHold(nodeId, "closure-read-unavailable");
  }

  /** `deliveryClosure` marks the own-delivery closure flow, which sets its own hold. */
  updateReadiness(taskId: string, deliveryClosure = false): void {
    const external = this.db
      .prepare(
        "SELECT e.nodeId, e.labels, e.observedState, t.projectId FROM github_external_issues e JOIN domain_tasks t ON t.id = e.taskId WHERE e.taskId = ?",
      )
      .get(taskId) as Row;
    const config = this.db
      .prepare(
        "SELECT closedIssues FROM project_github_sources WHERE projectId = ?",
      )
      .get(String(external.projectId)) as Row;
    const nodeId = String(external.nodeId);
    const closed = external.observedState === "closed";
    // Reopening, or a switch to Skip, reverses a provider completion; holds are untouched.
    if (
      (!closed || config.closedIssues !== "done") &&
      this.providerCompletion(taskId)
    ) {
      this.db
        .prepare("DELETE FROM github_provider_completions WHERE taskId = ?")
        .run(taskId);
      this.db
        .prepare(
          "UPDATE domain_tasks SET state = 'open', version = version + 1 WHERE id = ?",
        )
        .run(taskId);
    }
    const facts = this.readinessFacts(external);
    const memberships = facts.memberships;
    const ready =
      memberships > 0 &&
      external.observedState === "open" &&
      evaluateReadiness(this.readinessRule(String(external.projectId)), facts)
        .satisfied;
    const row = this.db
      .prepare("SELECT ready, state FROM domain_tasks WHERE id = ?")
      .get(taskId) as Row;
    const hold = this.hold(nodeId);
    if (
      closed &&
      row.state === "open" &&
      !deliveryClosure &&
      !this.db
        .prepare("SELECT 1 FROM github_delivery_closures WHERE nodeId = ?")
        .get(nodeId)
    ) {
      // Closure after import holds the task whatever its readiness. Stricter text review
      // and a pending own-delivery closure proof (closure-read-unavailable) keep their hold.
      if (
        !hold?.active ||
        ["withdrawn", "readiness-lost"].includes(String(hold.reason))
      ) {
        this.setSourceHold(nodeId, "closed");
        if (Number(row.ready) === Number(ready))
          this.db
            .prepare(
              "UPDATE domain_tasks SET version = version + 1 WHERE id = ?",
            )
            .run(taskId);
      }
    } else if (Number(row.ready) === 1 && !ready)
      this.setSourceHold(
        String(external.nodeId),
        external.observedState === "closed"
          ? "closed"
          : memberships === 0
            ? "withdrawn"
            : "readiness-lost",
      );
    if (Number(row.ready) !== Number(ready))
      this.db
        .prepare(
          "UPDATE domain_tasks SET ready = ?, version = version + 1 WHERE id = ?",
        )
        .run(Number(ready), taskId);
  }

  /** The stored readiness rule; `null` filters nothing. */
  readinessRule(projectId: string): Readiness | null {
    const row = this.db
      .prepare(
        "SELECT readiness FROM project_github_sources WHERE projectId = ?",
      )
      .get(projectId) as Row | undefined;
    return row ? parseRule(row.readiness) : null;
  }

  /** One issue's labels and the Project fields of its memberships in its task's project. */
  private readinessFacts(external: Row) {
    const rows = this.db
      .prepare(
        "SELECT projectFields FROM github_memberships WHERE nodeId = ? AND projectId = ?",
      )
      .all(String(external.nodeId), String(external.projectId)) as Row[];
    return {
      memberships: rows.length,
      labels: z
        .array(z.string())
        .parse(JSON.parse(String(external.labels)) as unknown),
      fields: rows.flatMap((row) =>
        projectFieldsSchema.parse(JSON.parse(String(row.projectFields))),
      ),
    };
  }

  /**
   * Read-only counts per read selection of a project, from stored observations, in a
   * fixed number of queries. Never a readiness grant: matching is not Ready or admissible.
   */
  selectionCounts(projectId: string): Map<
    string,
    {
      observed: number;
      open: number;
      closedSkipped: number;
      /** `null` while a member's stored Ready flag predates the current rule. */
      matching: number | null;
      complete: boolean;
    }
  > {
    const states = this.db
      .prepare(
        "SELECT selectionId, complete, skippedClosedNodeIds FROM github_sync_state WHERE projectId = ?",
      )
      .all(projectId) as Row[];
    const rows = this.db
      .prepare(`SELECT m.selectionId, m.nodeId, m.projectFields, e.observedState, e.labels,
        t.ready, t.projectId AS taskProjectId
        FROM github_memberships m JOIN github_external_issues e ON e.nodeId = m.nodeId
        JOIN domain_tasks t ON t.id = e.taskId
        WHERE m.projectId = ?`)
      .all(projectId) as Row[];
    const rule = this.readinessRule(projectId);
    // Each issue's fields from every membership in the project, as `readinessFacts` reads them.
    const fields = new Map<string, z.output<typeof projectFieldsSchema>>();
    for (const r of rows)
      fields.set(String(r.nodeId), [
        ...(fields.get(String(r.nodeId)) ?? []),
        ...projectFieldsSchema.parse(JSON.parse(String(r.projectFields))),
      ]);
    const matches = new Map<string, boolean>();
    const matching = (r: Row) => {
      const nodeId = String(r.nodeId);
      if (!matches.has(nodeId))
        matches.set(
          nodeId,
          evaluateReadiness(rule, {
            labels: z
              .array(z.string())
              .parse(JSON.parse(String(r.labels)) as unknown),
            fields: fields.get(nodeId) ?? [],
          }).satisfied,
        );
      return matches.get(nodeId) === true;
    };
    return new Map(
      states.map((sync) => {
        const members = rows.filter((r) => r.selectionId === sync.selectionId);
        const memberIds = new Set(members.map((r) => String(r.nodeId)));
        // An issue imported since it was skipped (reopened on a partial read) counts once.
        const closedSkipped = z
          .array(z.string())
          .parse(JSON.parse(String(sync.skippedClosedNodeIds)) as unknown)
          .filter((id) => !memberIds.has(id)).length;
        const open = members.filter((r) => r.observedState === "open");
        // A rule change re-evaluates Ready only on the next read; claim no match until then.
        const stale = open.some(
          (r) =>
            r.taskProjectId === projectId &&
            matching(r) !== (Number(r.ready) === 1),
        );
        return [
          String(sync.selectionId),
          {
            observed: members.length + closedSkipped,
            open: open.length,
            closedSkipped,
            matching: stale ? null : open.filter(matching).length,
            complete: Number(sync.complete) === 1,
          },
        ];
      }),
    );
  }

  /**
   * Why an imported task is or is not Draft under the rule; `null` for a local task.
   * `not-evaluated` covers closed and withdrawn issues.
   */
  taskReadiness(taskId: string) {
    const r = this.readinessByTask([taskId]).get(taskId);
    return r ? { outcome: r.outcome, unmet: r.unmet } : null;
  }

  /**
   * `taskReadiness` for many imported tasks in a fixed number of queries, with each
   * task's project rule. Local tasks are absent.
   */
  readinessByTask(taskIds: readonly string[]): Map<string, TaskReadiness> {
    const ids = JSON.stringify(taskIds);
    const externals = this.db
      .prepare(`SELECT e.taskId, e.nodeId, e.labels, e.observedState, t.projectId, t.ready
        FROM github_external_issues e JOIN domain_tasks t ON t.id = e.taskId
        WHERE e.taskId IN (SELECT value FROM json_each(?))`)
      .all(ids) as Row[];
    const memberships = this.db
      .prepare(`SELECT m.nodeId, m.projectId, m.projectFields FROM github_memberships m
        JOIN github_external_issues e ON e.nodeId = m.nodeId
        WHERE e.taskId IN (SELECT value FROM json_each(?))`)
      .all(ids) as Row[];
    const rules = new Map(
      (
        this.db
          .prepare(`SELECT projectId, readiness FROM project_github_sources
          WHERE projectId IN (SELECT DISTINCT t.projectId FROM domain_tasks t
            WHERE t.id IN (SELECT value FROM json_each(?)))`)
          .all(ids) as Row[]
      ).map((row) => [String(row.projectId), parseRule(row.readiness)]),
    );
    // The facts `readinessFacts` reads: memberships in the task's project.
    const byIssue = new Map<string, Row[]>();
    for (const m of memberships) {
      const key = `${String(m.projectId)}\0${String(m.nodeId)}`;
      byIssue.set(key, [...(byIssue.get(key) ?? []), m]);
    }
    return new Map(
      externals.map((external): [string, TaskReadiness] => {
        const projectId = String(external.projectId),
          rule = rules.get(projectId) ?? null;
        const own =
          byIssue.get(`${projectId}\0${String(external.nodeId)}`) ?? [];
        const notEvaluated: TaskReadiness = {
          rule,
          outcome: "not-evaluated",
          unmet: [],
        };
        if (external.observedState !== "open" || own.length === 0)
          return [String(external.taskId), notEvaluated];
        const result = evaluateReadiness(rule, {
          labels: z
            .array(z.string())
            .parse(JSON.parse(String(external.labels)) as unknown),
          fields: own.flatMap((m) =>
            projectFieldsSchema.parse(JSON.parse(String(m.projectFields))),
          ),
        });
        // Until the next read re-evaluates Ready under a changed rule, explain nothing.
        if (result.satisfied !== (Number(external.ready) === 1))
          return [String(external.taskId), notEvaluated];
        return [
          String(external.taskId),
          result.satisfied
            ? { rule, outcome: "matched" as const, unmet: [] }
            : {
                rule,
                outcome: "unmet" as const,
                unmet: result.unmet,
              },
        ];
      }),
    );
  }

  private setSourceHold(nodeId: string, reason: string): void {
    this.db
      .prepare(`INSERT INTO github_source_holds (nodeId, active, reason, generation) VALUES (?, 1, ?, 1)
      ON CONFLICT(nodeId) DO UPDATE SET active = 1, reason = excluded.reason,
      generation = CASE WHEN active = 0 OR reason != excluded.reason THEN generation + 1 ELSE generation END`)
      .run(nodeId, reason);
  }
}
