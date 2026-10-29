import { DeliveryStore } from "./delivery.js";
import { TaskReviewStore } from "./task-review.js";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  itemColumns,
  itemIs,
  itemKey,
  itemParams,
  migrateSourceStorage,
  sameItem,
} from "./source-storage.js";
import { transaction, type Database } from "./store.js";
import {
  type ProjectFieldIds,
  type ProjectFieldName,
  projectFieldNames,
  replaceProjectFieldNames,
  withProjectFieldNames,
} from "./project-field-names.js";

/** Binds the provider and instance of the items this store's sweeps own. */
const adapter = [
  githubIssueTracker.provider,
  githubIssueTracker.instance,
] as const;

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
  /** The Project item holding this issue; set only by Project selections. */
  projectItemNodeId?: string;
  /** When the read that produced this Project item began (epoch ms); a later write is newer than it. */
  projectReadAt?: number;
}
/** `resumeAt` (epoch ms) marks a rate-limited read: do not read again before then. */
export type SelectionSnapshot =
  | {
      complete: true;
      issues: IssueSnapshot[];
      reason: null;
      /** A Project selection's single-select fields, as this read listed them. */
      projectFields?: ProjectFieldName[];
    }
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
  githubIssueTracker,
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
/** A GitLab project-path segment; `.` and `..` are excluded separately. */
const gitLabSegment = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/;
/** A GitLab project path: 2-21 segments, none `.`, `..` or ending in `.git`. */
export function isGitLabProjectPath(path: string): boolean {
  const parts = path.split("/");
  return (
    parts.length >= 2 &&
    parts.length <= 21 &&
    parts.every(
      (part) =>
        gitLabSegment.test(part) &&
        part !== "." &&
        part !== ".." &&
        !part.endsWith(".git"),
    )
  );
}
/** The host, port, scheme and path of a remote URL or scp-style address; never kept. */
function splitOrigin(url: string): {
  protocol: string | null;
  host: string;
  port: string;
  path: string;
} | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      return {
        protocol: parsed.protocol,
        host: parsed.hostname,
        port: parsed.port,
        path: decodeURIComponent(parsed.pathname),
      };
    } catch {
      return null;
    }
  }
  const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(url);
  if (!scp?.[1] || !scp[2]) return null;
  return { protocol: null, host: scp[1], port: "", path: scp[2] };
}
const trimmedOriginPath = (path: string) =>
  path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
/**
 * `owner/name` of a `github.com` remote URL, or null for any other host or shape.
 * Userinfo, a trailing `/` and a `.git` suffix are ignored; the URL itself is never returned.
 */
export function parseGitHubOrigin(
  url: string,
): { owner: string; name: string } | null {
  const origin = splitOrigin(url);
  if (
    !origin ||
    (origin.protocol !== null &&
      !["https:", "ssh:", "git:"].includes(origin.protocol)) ||
    origin.port ||
    origin.host.toLowerCase() !== "github.com"
  )
    return null;
  const parts = trimmedOriginPath(origin.path).split("/");
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
/**
 * The full project path of a remote URL on `host` (compared case-insensitively), or null
 * for another host or shape. Accepts `https://`, `ssh://` (the only form that may carry a
 * port, as identity is host and path) and scp-style addresses; the URL is never returned.
 */
export function parseGitLabOrigin(url: string, host: string): string | null {
  const origin = splitOrigin(url);
  if (
    !origin ||
    origin.host.toLowerCase() !== host.toLowerCase() ||
    !(
      origin.protocol === null ||
      origin.protocol === "ssh:" ||
      (origin.protocol === "https:" && !origin.port)
    )
  )
    return null;
  const path = trimmedOriginPath(origin.path);
  return isGitLabProjectPath(path) ? path : null;
}
/** The repository identity a checkout's `origin` must match. */
export type ExpectedOrigin =
  | { owner: string; name: string }
  | { codeHost: "gitlab"; host: string; projectPath: string };
/** Verifies a local checkout; the host supplies the implementation (see `DomainStore`). */
export type RepositoryVerifier = (
  input: z.output<typeof repositoryLinkSchema>,
  expectedOrigin?: ExpectedOrigin,
) => Promise<LinkedRepository>;

type Row = Record<string, string | number | null>;

/** SQL testing for a recorded own-delivery closure of the item key `item` that no reopen superseded. */
export function effectiveOwnClosure(
  item: readonly [string, string, string],
): string {
  return `EXISTS (SELECT 1 FROM source_closures d WHERE d.provider = ${item[0]}
    AND d.instance = ${item[1]} AND d.externalId = ${item[2]}
    AND NOT EXISTS (SELECT 1 FROM source_closure_supersessions s
      WHERE ${sameItem("s", "d")} AND s.operationId = d.operationId))`;
}

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
        "SELECT version, credentialRef FROM project_task_sources WHERE projectId = ?",
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
            "SELECT 1 FROM project_active_selections WHERE projectId = ? AND selectionId = ? AND configVersion = ?",
          )
          .get(binding.projectId, selectionId, binding.configVersion),
      )
    );
  }

  /** The domain migration already runs this; it stays for stores opened on their own. */
  migrate(): void {
    transaction(this.db, () => migrateSourceStorage(this.db));
  }

  issue(nodeId: string): Row | undefined {
    return this.db
      .prepare(
        `SELECT instance AS providerInstance, externalId AS nodeId, taskId, containerId AS repositoryId,
          containerName AS repositoryName, number AS issueNumber, observedTitle, observedBody,
          observedState, labels FROM external_items WHERE ${itemIs()}`,
      )
      .get(...itemKey(nodeId)) as Row | undefined;
  }

  memberships(nodeId: string): Row[] {
    return this.db
      .prepare(
        `SELECT projectId, selectionId, externalId AS nodeId, fields AS projectFields FROM source_memberships WHERE ${itemIs()} ORDER BY selectionId, projectId`,
      )
      .all(...itemKey(nodeId)) as Row[];
  }

  /** An issue's current item in one Project selection, with its stored Project field values. */
  membershipItem(
    projectId: string,
    selectionId: string,
    nodeId: string,
  ): {
    itemNodeId: string;
    projectFields: z.output<typeof projectFieldsSchema>;
    /** Epoch ms of the read that last set these fields, or null before it was recorded. */
    readAt: number | null;
  } | null {
    const row = this.db
      .prepare(
        `SELECT itemId AS itemNodeId, fields AS projectFields, readAt FROM source_memberships WHERE projectId = ? AND selectionId = ? AND ${itemIs()}`,
      )
      .get(projectId, selectionId, ...itemKey(nodeId)) as Row | undefined;
    if (!row?.itemNodeId) return null;
    return {
      itemNodeId: String(row.itemNodeId),
      projectFields: projectFieldsSchema.parse(
        JSON.parse(String(row.projectFields)),
      ),
      readAt: row.readAt === null ? null : Number(row.readAt),
    };
  }

  syncState(projectId: string, selectionId: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT projectId, selectionId, complete, reason, refreshedAt FROM source_sync_state WHERE projectId = ? AND selectionId = ?",
      )
      .get(projectId, selectionId) as Row | undefined;
  }

  review(nodeId: string): Row | undefined {
    return this.db
      .prepare(
        `SELECT observedDigest, acceptedDigest, decision, decidedAt FROM source_reviews WHERE ${itemIs()}`,
      )
      .get(...itemKey(nodeId)) as Row | undefined;
  }

  /** Set only while a Done task was completed by GitHub closure under a Done-mode source. */
  providerCompletion(taskId: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT externalId AS nodeId, completedAt FROM source_completions WHERE taskId = ?",
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
        .prepare(`SELECT e.externalId AS nodeId, t.projectId FROM external_items e
        JOIN domain_tasks t ON t.id = e.taskId
        JOIN project_task_sources c ON c.projectId = t.projectId
        WHERE e.taskId = ? AND t.state = 'open' AND e.observedState = 'closed'
          AND c.closedIssues = 'done'
          AND EXISTS (SELECT 1 FROM source_holds h
            WHERE ${sameItem("h", "e")} AND h.active = 1 AND h.reason = 'closed')
          AND NOT ${effectiveOwnClosure(itemColumns("e"))}`)
        .get(taskId) as Row | undefined;
      // An unsuperseded own closure is never provider closure, proved or not.
      if (
        !task ||
        new DeliveryStore(this.db).ownsConfirmedClosure(
          taskId,
          String(task.nodeId),
        )
      )
        return false;
      const memberships = this.db
        .prepare(`SELECT CASE WHEN a.configVersion = c.version THEN s.complete ELSE 0 END AS complete
        FROM source_memberships m
        JOIN project_task_sources c ON c.projectId = m.projectId
        LEFT JOIN source_sync_state s ON s.projectId = m.projectId AND s.selectionId = m.selectionId
        LEFT JOIN project_active_selections a ON a.projectId = m.projectId AND a.selectionId = m.selectionId
        WHERE ${itemIs("m")} AND m.projectId = ?`)
        .all(...itemKey(String(task.nodeId)), String(task.projectId)) as Row[];
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
          "INSERT INTO source_completions (taskId, provider, instance, externalId, completedAt) VALUES (?, ?, ?, ?, ?)",
        )
        .run(taskId, ...itemKey(String(task.nodeId)), new Date().toISOString());
      return true;
    });
  }

  hold(nodeId: string): Row | undefined {
    return this.db
      .prepare(
        `SELECT active, reason, generation FROM source_holds WHERE ${itemIs()}`,
      )
      .get(...itemKey(nodeId)) as Row | undefined;
  }

  conflicts(): Array<{ nodeId: string; taskId: string; projectIds: string[] }> {
    const rows = this.db
      .prepare(`SELECT e.externalId AS nodeId, e.taskId, m.projectId
      FROM external_items e JOIN source_memberships m ON ${sameItem("m", "e")}
      WHERE e.provider = ? AND e.instance = ?
        AND NOT EXISTS (SELECT 1 FROM source_placement_decisions d WHERE ${sameItem("d", "e")})
        AND NOT EXISTS (SELECT 1 FROM domain_assignments a WHERE a.taskId = e.taskId)
      ORDER BY e.externalId, m.projectId`)
      .all(...adapter) as Row[];
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

  /** The issue's recorded blockers, with the cab task each was imported as when it is in the blocked task's project. */
  nativeBlockers(nodeId: string): Row[] {
    return this.db
      .prepare(
        `SELECT b.blockerExternalId AS blockerNodeId, b.containerId AS repositoryId,
          b.containerName AS repositoryName, b.number AS issueNumber, b.status,
          i.taskId, t.title AS taskTitle FROM source_native_blockers b
          LEFT JOIN imported_tasks i ON i.provider = b.provider AND i.instance = b.instance
            AND i.externalId = b.blockerExternalId
            AND (SELECT projectId FROM tasks WHERE id = i.taskId) =
              (SELECT bt.projectId FROM imported_tasks bi JOIN tasks bt ON bt.id = bi.taskId
                WHERE ${sameItem("bi", "b")})
          LEFT JOIN tasks t ON t.id = i.taskId
          WHERE ${itemIs("b")} ORDER BY b.blockerExternalId`,
      )
      .all(...itemKey(nodeId)) as Row[];
  }

  activeHolds(): Array<{
    nodeId: string;
    taskId: string;
    reason: string;
    generation: number;
  }> {
    const rows = this.db
      .prepare(`SELECT h.externalId AS nodeId, e.taskId, h.reason, h.generation
      FROM source_holds h JOIN external_items e ON ${sameItem("e", "h")}
      WHERE h.active = 1 AND h.provider = ? AND h.instance = ? ORDER BY h.externalId`)
      .all(...adapter) as Row[];
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
      .prepare(`SELECT DISTINCT t.projectId, e.externalId AS nodeId, e.containerId AS repositoryId,
      e.containerName AS repositoryName, e.number AS issueNumber FROM local_dependencies d
      JOIN external_items e ON e.taskId = d.blockerTaskId
      JOIN domain_tasks t ON t.id = e.taskId ORDER BY e.externalId`)
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
        .prepare(`SELECT status FROM external_item_status WHERE ${itemIs()}`)
        .get(...itemKey(nodeId)) as Row | undefined;
      this.db
        .prepare(
          "INSERT INTO external_item_status (provider, instance, externalId, status, reason, refreshedAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider, instance, externalId) DO UPDATE SET status = excluded.status, reason = excluded.reason, refreshedAt = excluded.refreshedAt",
        )
        .run(
          ...itemKey(nodeId),
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
        WHERE id IN (SELECT taskId FROM external_items WHERE provider = ? AND instance = ?)
          AND importedBlockers != 'unknown'`)
        .run(...adapter);
      this.db
        .prepare(`UPDATE domain_tasks SET version = version + 1
        WHERE id IN (SELECT d.taskId FROM local_dependencies d
          JOIN external_items e ON e.taskId = d.blockerTaskId
          JOIN external_item_status s ON ${sameItem("s", "e")}
          WHERE s.status = 'closed' AND e.provider = ? AND e.instance = ?)`)
        .run(...adapter);
      this.db
        .prepare(
          "UPDATE external_item_status SET status = 'unknown', reason = 'startup-refresh-required' WHERE provider = ? AND instance = ?",
        )
        .run(...adapter);
      this.db
        .prepare(
          "UPDATE source_dependency_observations SET complete = 0, reason = 'startup-refresh-required' WHERE provider = ? AND instance = ?",
        )
        .run(...adapter);
      this.db
        .prepare(
          "UPDATE source_sync_state SET complete = 0, reason = 'startup-refresh-required'",
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
        WHERE projectId = ? AND id IN (SELECT taskId FROM external_items) AND importedBlockers != 'unknown'`)
        .run(binding.projectId);
      this.db
        .prepare(`UPDATE domain_tasks SET version = version + 1
        WHERE id IN (SELECT d.taskId FROM local_dependencies d
          JOIN external_items e ON e.taskId = d.blockerTaskId
          JOIN domain_tasks b ON b.id = e.taskId
          JOIN external_item_status s ON ${sameItem("s", "e")}
          WHERE b.projectId = ? AND s.status = 'closed')`)
        .run(binding.projectId);
      this.db
        .prepare(`UPDATE external_item_status SET status = 'unknown', reason = ?
        WHERE (provider, instance, externalId) IN (SELECT e.provider, e.instance, e.externalId FROM external_items e
          JOIN domain_tasks t ON t.id = e.taskId WHERE t.projectId = ?)`)
        .run(controlled, binding.projectId);
      this.db
        .prepare(`UPDATE source_dependency_observations SET complete = 0, reason = ?
        WHERE (provider, instance, externalId) IN (SELECT e.provider, e.instance, e.externalId FROM external_items e
          JOIN domain_tasks t ON t.id = e.taskId WHERE t.projectId = ?)`)
        .run(controlled, binding.projectId);
      this.db
        .prepare(`UPDATE domain_tasks SET version = version + 1
        WHERE projectId = ? AND id IN (SELECT e.taskId FROM external_items e
          JOIN source_memberships m ON ${sameItem("m", "e")}
          JOIN source_sync_state s ON s.projectId = m.projectId AND s.selectionId = m.selectionId
          JOIN project_active_selections a ON a.projectId = m.projectId AND a.selectionId = m.selectionId
          WHERE m.projectId = ? AND a.configVersion = ? AND s.complete = 1)`)
        .run(binding.projectId, binding.projectId, binding.configVersion);
      this.db
        .prepare(`UPDATE source_sync_state SET complete = 0, reason = ?
        WHERE projectId = ? AND selectionId IN (SELECT selectionId FROM project_active_selections
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
              `SELECT 1 FROM source_memberships WHERE projectId = ? AND selectionId = ? AND ${itemIs()}`,
            )
            .get(binding.projectId, binding.selectionId, ...itemKey(nodeId)))
      ) {
        return false;
      }
      if (snapshot.complete) {
        this.db
          .prepare(`DELETE FROM source_native_blockers WHERE ${itemIs()}`)
          .run(...itemKey(nodeId));
        for (const blocker of snapshot.blockers) {
          if (blocker.providerInstance !== "github.com")
            throw new Error("Provider identity mismatch");
          this.db
            .prepare(
              "INSERT OR IGNORE INTO source_native_blockers (provider, instance, externalId, blockerExternalId, containerId, containerName, number, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              ...itemKey(nodeId),
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
          "INSERT INTO source_dependency_observations (provider, instance, externalId, complete, reason, refreshedAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider, instance, externalId) DO UPDATE SET complete = excluded.complete, reason = excluded.reason, refreshedAt = excluded.refreshedAt",
        )
        .run(
          ...itemKey(nodeId),
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
          "SELECT version, readiness, selections, closedIssues FROM project_task_sources WHERE projectId = ?",
        )
        .get(projectId) as Row | undefined;
      if (!config) throw new Error("GitHub selection is not active");
      const active = this.db
        .prepare(
          "SELECT 1 FROM project_active_selections WHERE projectId = ? AND selectionId = ? AND configVersion = ?",
        )
        .get(projectId, selectionId, Number(config.version)) as Row | undefined;
      if (!active) throw new Error("GitHub selection is not active");
      const selections = z
        .array(selectionSchema)
        .parse(JSON.parse(String(config.selections)) as unknown);
      const selection = selections.find((s) => s.id === selectionId);
      if (!selection) throw new Error("Unknown GitHub selection");
      // Names only label stored node IDs; a partial read may list fields partially, so it keeps them.
      if (
        snapshot.complete &&
        snapshot.projectFields &&
        selection.kind === "project"
      )
        replaceProjectFieldNames(
          this.db,
          selection.projectNodeId,
          snapshot.projectFields,
        );
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
        // An issue cab is publishing is not new: its task is converted when the create resolves.
        if (!existing && this.publishingIssue(issue)) continue;
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
              "INSERT INTO imported_tasks (taskId, provider, instance, externalId, containerId) VALUES (?, ?, ?, ?, ?)",
            )
            .run(taskId, ...itemKey(issue.nodeId), issue.repositoryId);
          this.db
            .prepare(
              "INSERT INTO external_items (provider, instance, externalId, taskId, containerId, containerName, number, observedTitle, observedBody, observedState, labels) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              ...itemKey(issue.nodeId),
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
              "INSERT INTO source_reviews (provider, instance, externalId, observedDigest, acceptedDigest) VALUES (?, ?, ?, ?, ?)",
            )
            .run(...itemKey(issue.nodeId), digest, digest);
          if (issue.state === "closed")
            this.db
              .prepare(
                "INSERT INTO source_completions (taskId, provider, instance, externalId, completedAt) VALUES (?, ?, ?, ?, ?)",
              )
              .run(taskId, ...itemKey(issue.nodeId), new Date().toISOString());
        } else {
          taskId = String(existing.taskId);
          const digest = sourceTextDigest(issue.title, issue.body);
          const prior = this.db
            .prepare(
              `SELECT observedDigest FROM source_reviews WHERE ${itemIs()}`,
            )
            .get(...itemKey(issue.nodeId)) as Row | undefined;
          if (prior?.observedDigest !== digest) {
            this.db
              .prepare(
                "INSERT INTO source_reviews (provider, instance, externalId, observedDigest, acceptedDigest) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider, instance, externalId) DO UPDATE SET observedDigest = excluded.observedDigest",
              )
              .run(
                ...itemKey(issue.nodeId),
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
              `UPDATE external_items SET containerId = ?, containerName = ?, number = ?, observedTitle = ?, observedBody = ?, observedState = ?, labels = ? WHERE ${itemIs()}`,
            )
            .run(
              issue.repositoryId,
              issue.repositoryName,
              issue.number,
              issue.title,
              issue.body,
              issue.state,
              JSON.stringify(issue.labels),
              ...itemKey(issue.nodeId),
            );
        }
        this.db
          .prepare(
            "INSERT INTO source_memberships (projectId, selectionId, provider, instance, externalId, fields, itemId, readAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(projectId, selectionId, provider, instance, externalId) DO UPDATE SET fields = excluded.fields, itemId = excluded.itemId, readAt = excluded.readAt, missedReads = NULL",
          )
          .run(
            projectId,
            selectionId,
            ...itemKey(issue.nodeId),
            JSON.stringify(issue.projectFields),
            issue.projectItemNodeId ?? null,
            issue.projectReadAt ?? Date.now(),
          );
        sourceCaptures.push({
          taskId,
          kind: "github",
          supplied: { title: issue.title, body: issue.body },
        });
        this.updateReadiness(taskId);
        if (snapshot.complete) this.releaseSourceHold(taskId);
      }
      new TaskReviewStore(this.db).captureSources(sourceCaptures);
      if (snapshot.complete) {
        const old = this.db
          .prepare(
            "SELECT externalId AS nodeId, missedReads FROM source_memberships WHERE projectId = ? AND selectionId = ?",
          )
          .all(projectId, selectionId) as Row[];
        for (const membership of old)
          if (!seen.has(String(membership.nodeId))) {
            // GitHub's lists trail a create: a just-published issue survives one complete read that omits it.
            if (membership.missedReads === 0) {
              this.db
                .prepare(
                  `UPDATE source_memberships SET missedReads = 1 WHERE projectId = ? AND selectionId = ? AND ${itemIs()}`,
                )
                .run(
                  projectId,
                  selectionId,
                  ...itemKey(String(membership.nodeId)),
                );
              continue;
            }
            this.db
              .prepare(
                `DELETE FROM source_memberships WHERE projectId = ? AND selectionId = ? AND ${itemIs()}`,
              )
              .run(
                projectId,
                selectionId,
                ...itemKey(String(membership.nodeId)),
              );
            const external = this.issue(String(membership.nodeId));
            if (external) this.updateReadiness(String(external.taskId));
          }
      } else {
        const retained = this.db
          .prepare(`SELECT e.externalId AS nodeId, e.taskId FROM source_memberships m
          JOIN external_items e ON ${sameItem("e", "m")}
          WHERE m.projectId = ? AND m.selectionId = ?`)
          .all(projectId, selectionId) as Row[];
        for (const issue of retained) {
          this.db
            .prepare(
              `UPDATE source_dependency_observations SET complete = 0, reason = 'source-read-incomplete' WHERE ${itemIs()}`,
            )
            .run(...itemKey(String(issue.nodeId)));
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
            "SELECT skippedClosedIds FROM source_sync_state WHERE projectId = ? AND selectionId = ?",
          )
          .get(projectId, selectionId) as Row | undefined;
        const prior = z
          .array(z.string())
          .parse(
            JSON.parse(String(stored?.skippedClosedIds ?? "[]")) as unknown,
          );
        for (const id of prior) skipped.add(id);
      }
      this.db
        .prepare(
          "INSERT INTO source_sync_state (projectId, selectionId, complete, reason, refreshedAt, skippedClosedIds) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(projectId, selectionId) DO UPDATE SET complete = excluded.complete, reason = excluded.reason, refreshedAt = excluded.refreshedAt, skippedClosedIds = excluded.skippedClosedIds",
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
          SELECT e.taskId FROM external_items e JOIN source_memberships m ON ${sameItem("m", "e")}
          WHERE m.projectId = ? AND m.selectionId = ?)`)
          .run(projectId, selectionId);
      return true;
    });
  }

  /**
   * A complete read that lists the issue again while its task is Ready resolves a source-caused
   * `withdrawn` or `readiness-lost` hold: the source has recovered. Every other source hold stays
   * for `source.review`, and a partial read never calls this.
   */
  private releaseSourceHold(taskId: string): void {
    const released = this.db
      .prepare(
        `UPDATE source_holds SET active = 0 WHERE active = 1 AND reason IN ('withdrawn', 'readiness-lost')
          AND (provider, instance, externalId) = (SELECT e.provider, e.instance, e.externalId FROM external_items e JOIN domain_tasks t ON t.id = e.taskId
            WHERE e.taskId = ? AND t.ready = 1)`,
      )
      .run(taskId) as { changes: number | bigint };
    if (Number(released.changes) > 0)
      this.db
        .prepare("UPDATE domain_tasks SET version = version + 1 WHERE id = ?")
        .run(taskId);
  }

  /**
   * Whether `body` carries the marker of a task publication whose create is unresolved. Such an
   * issue belongs to that task, so a racing sync must not import it as a second one.
   */
  private publishingIssue(issue: { nodeId: string; body: string }): boolean {
    return (
      this.db
        .prepare(
          "SELECT publicationId,issueNodeId FROM task_publications WHERE state='sending'",
        )
        .all() as Row[]
    ).some(
      (row) =>
        // The create's confirmed issue is known by identity; one still unproved only by its marker.
        row.issueNodeId === issue.nodeId ||
        issue.body.includes(
          `<!-- cab-operation:${String(row.publicationId)} -->`,
        ),
    );
  }

  /**
   * Turns a published local task into the imported task of the issue it created, writing what the
   * sync would have written for it. Ready is kept, as the next sync recomputes it from GitHub.
   */
  convertPublishedTaskWithinTransaction(input: {
    taskId: string;
    projectId: string;
    selectionId: string;
    repositoryId: string;
    repositoryName: string;
    nodeId: string;
    number: number;
    title: string;
    /** The body as created, marker included. */
    body: string;
    labels: string[];
    itemNodeId: string | null;
    projectFields: z.output<typeof projectFieldsSchema>;
  }): void {
    const digest = sourceTextDigest(input.title, input.body),
      now = Date.now();
    this.db
      .prepare(
        "INSERT INTO imported_tasks (taskId, provider, instance, externalId, containerId) VALUES (?, ?, ?, ?, ?)",
      )
      .run(input.taskId, ...itemKey(input.nodeId), input.repositoryId);
    this.db
      .prepare(
        "INSERT INTO external_items (provider, instance, externalId, taskId, containerId, containerName, number, observedTitle, observedBody, observedState, labels) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
      )
      .run(
        ...itemKey(input.nodeId),
        input.taskId,
        input.repositoryId,
        input.repositoryName,
        input.number,
        input.title,
        input.body,
        JSON.stringify(input.labels),
      );
    this.db
      .prepare(
        "INSERT INTO source_reviews (provider, instance, externalId, observedDigest, acceptedDigest) VALUES (?, ?, ?, ?, ?)",
      )
      .run(...itemKey(input.nodeId), digest, digest);
    // Local dependents keep treating the task as an open blocker, not an unknown one.
    this.db
      .prepare(
        "INSERT INTO external_item_status (provider, instance, externalId, status, reason, refreshedAt) VALUES (?, ?, ?, 'open', NULL, ?) ON CONFLICT(provider, instance, externalId) DO UPDATE SET status = 'open', reason = NULL, refreshedAt = excluded.refreshedAt",
      )
      .run(...itemKey(input.nodeId), new Date(now).toISOString());
    this.db
      .prepare(
        "INSERT INTO source_memberships (projectId, selectionId, provider, instance, externalId, fields, itemId, readAt, missedReads) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
      )
      .run(
        input.projectId,
        input.selectionId,
        ...itemKey(input.nodeId),
        JSON.stringify(input.projectFields),
        input.itemNodeId,
        now,
      );
    this.db
      .prepare(
        "UPDATE domain_tasks SET readinessRule = ?, importedBlockers = 'unknown', version = version + 1 WHERE id = ?",
      )
      .run(this.readinessRuleText(input.projectId) ?? "null", input.taskId);
    new TaskReviewStore(this.db).captureSources([
      {
        taskId: input.taskId,
        kind: "github",
        supplied: { title: input.title, body: input.body },
      },
    ]);
  }

  recordDeliveryClosure(
    projectId: string,
    configVersion: number,
    input: IssueSnapshot,
    operationId: string,
    closerPrNodeId: string | null,
    closedEventId: string | null,
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
            "SELECT version,readiness,selections FROM project_task_sources WHERE projectId=?",
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
            `UPDATE source_reviews SET observedDigest=? WHERE ${itemIs()}`,
          )
          .run(digest, ...itemKey(snapshot.nodeId));
        this.db
          .prepare("UPDATE domain_tasks SET version=version+1 WHERE id=?")
          .run(String(issue.taskId));
        this.setSourceHold(snapshot.nodeId, "changed-text");
      }
      this.db
        .prepare(
          `UPDATE external_items SET observedState='closed',observedTitle=?,observedBody=?,labels=? WHERE ${itemIs()}`,
        )
        .run(
          snapshot.title,
          snapshot.body,
          JSON.stringify(snapshot.labels),
          ...itemKey(snapshot.nodeId),
        );
      new TaskReviewStore(this.db).captureSource(
        String(issue.taskId),
        "github",
        { title: snapshot.title, body: snapshot.body },
      );
      const priorHold = this.db
        .prepare(`SELECT active,reason FROM source_holds WHERE ${itemIs()}`)
        .get(...itemKey(snapshot.nodeId)) as Row | undefined;
      this.updateReadiness(String(issue.taskId), true);
      const rule = parseRule(config.readiness);
      // The closure read carries no Project fields and closing changes none: use those last observed.
      const readinessProof = evaluateReadiness(rule, {
        labels: snapshot.labels,
        fields: this.readinessFacts({ ...issue, projectId }).fields,
      }).satisfied;
      const hold = priorHold;
      if (
        readinessProof &&
        (!hold?.active ||
          [
            "closed",
            "withdrawn",
            "closure-read-unavailable",
            "closure-attribution-unproved",
          ].includes(String(hold.reason)))
      )
        this.setSourceHold(snapshot.nodeId, "closed");
      else if (!readinessProof && (!hold?.active || hold.reason === "closed"))
        this.setSourceHold(snapshot.nodeId, "readiness-lost");
      else if (hold?.active)
        this.setSourceHold(snapshot.nodeId, String(hold.reason));
      this.db
        .prepare(
          "INSERT INTO source_closures (provider,instance,externalId,operationId,closerChangeRequestId,snapshotJson,closedEventId) VALUES (?,?,?,?,?,?,?) ON CONFLICT(provider,instance,externalId) DO UPDATE SET operationId=excluded.operationId,closerChangeRequestId=excluded.closerChangeRequestId,snapshotJson=excluded.snapshotJson,closedEventId=excluded.closedEventId",
        )
        .run(
          ...itemKey(snapshot.nodeId),
          operationId,
          closerPrNodeId,
          JSON.stringify(snapshot),
          closedEventId,
        );
      return true;
    });
  }
  recordDeliveryClosureUnavailable(nodeId: string): void {
    const hold = this.db
      .prepare(`SELECT active,reason FROM source_holds WHERE ${itemIs()}`)
      .get(...itemKey(nodeId)) as Row | undefined;
    if (!hold?.active || hold.reason === "closed")
      this.setSourceHold(nodeId, "closure-read-unavailable");
  }
  /**
   * A fresh read shows the issue closed, but not provably by the confirmed own-delivery
   * operation. The closure is observed; the explained hold replaces a pending proof.
   */
  recordDeliveryClosureAttributionUnproved(nodeId: string): void {
    transaction(this.db, () => {
      const issue = this.issue(nodeId);
      if (!issue) return;
      const hold = this.hold(nodeId);
      if (
        !hold?.active ||
        ["closed", "withdrawn", "closure-read-unavailable"].includes(
          String(hold.reason),
        )
      )
        this.setSourceHold(nodeId, "closure-attribution-unproved");
      this.db
        .prepare(
          `UPDATE external_items SET observedState = 'closed' WHERE ${itemIs()}`,
        )
        .run(...itemKey(nodeId));
      this.updateReadiness(String(issue.taskId));
    });
  }
  /** The stored own-delivery closure for an issue, superseded or not. */
  deliveryClosure(
    nodeId: string,
  ): { operationId: string; closedEventId: string | null } | undefined {
    const row = this.db
      .prepare(
        `SELECT operationId, closedEventId FROM source_closures WHERE ${itemIs()}`,
      )
      .get(...itemKey(nodeId)) as Row | undefined;
    return row
      ? {
          operationId: String(row.operationId),
          closedEventId:
            row.closedEventId === null ? null : String(row.closedEventId),
        }
      : undefined;
  }
  /**
   * The issue was reopened after the operation closed it: that own closure no longer
   * counts, so a later closure is provider closure. Append-only; a pending-proof hold
   * becomes the ordinary closure hold and every other hold is kept.
   */
  supersedeDeliveryClosure(nodeId: string, operationId: string): void {
    transaction(this.db, () => {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO source_closure_supersessions (provider, instance, externalId, operationId, supersededAt) VALUES (?, ?, ?, ?, ?)",
        )
        .run(...itemKey(nodeId), operationId, new Date().toISOString());
      const hold = this.hold(nodeId);
      if (
        hold?.active &&
        ["closure-read-unavailable", "closure-attribution-unproved"].includes(
          String(hold.reason),
        )
      )
        this.setSourceHold(nodeId, "closed");
      this.db
        .prepare(
          `UPDATE domain_tasks SET version = version + 1 WHERE id = (SELECT taskId FROM external_items WHERE ${itemIs()})`,
        )
        .run(...itemKey(nodeId));
    });
  }

  /** `deliveryClosure` marks the own-delivery closure flow, which sets its own hold. */
  updateReadiness(taskId: string, deliveryClosure = false): void {
    const external = this.db
      .prepare(
        "SELECT e.externalId AS nodeId, e.labels, e.observedState, t.projectId FROM external_items e JOIN domain_tasks t ON t.id = e.taskId WHERE e.taskId = ?",
      )
      .get(taskId) as Row;
    const config = this.db
      .prepare(
        "SELECT closedIssues, readiness FROM project_task_sources WHERE projectId = ?",
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
        .prepare("DELETE FROM source_completions WHERE taskId = ?")
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
      evaluateReadiness(parseRule(config.readiness), facts).satisfied;
    const row = this.db
      .prepare(
        "SELECT ready, state, readinessRule FROM domain_tasks WHERE id = ?",
      )
      .get(taskId) as Row;
    const hold = this.hold(nodeId);
    if (
      closed &&
      row.state === "open" &&
      !deliveryClosure &&
      !(
        this.db
          .prepare(`SELECT ${effectiveOwnClosure(itemParams)} AS present`)
          .get(...itemKey(nodeId)) as Row
      ).present &&
      !new DeliveryStore(this.db).ownsConfirmedClosure(taskId, nodeId)
    ) {
      // Closure after import holds the task whatever its readiness. Stricter text review
      // keeps its hold; an unsuperseded own closure, proved or not, is not this closure.
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
    } else if (
      Number(row.ready) === 1 &&
      !ready &&
      // A closure hold, or a pending or unattributed own-delivery closure proof, keeps its reason:
      // only the operator resolves it, so a later readiness loss or withdrawal must not make it self-releasing.
      !(
        hold?.active &&
        [
          "closed",
          "closure-read-unavailable",
          "closure-attribution-unproved",
        ].includes(String(hold.reason))
      )
    )
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
          "UPDATE domain_tasks SET ready = ?, readinessRule = ?, version = version + 1 WHERE id = ?",
        )
        .run(Number(ready), String(config.readiness), taskId);
    // Stamp only: approval bindings compare the task version, which Ready alone moves.
    else if (row.readinessRule !== config.readiness)
      this.db
        .prepare("UPDATE domain_tasks SET readinessRule = ? WHERE id = ?")
        .run(String(config.readiness), taskId);
  }

  /** The stored readiness rule; `null` filters nothing. */
  readinessRule(projectId: string): Readiness | null {
    const text = this.readinessRuleText(projectId);
    return text === undefined ? null : parseRule(text);
  }

  /** The stored rule JSON, the identity a task's Ready flag is stamped with. */
  private readinessRuleText(projectId: string): string | undefined {
    const row = this.db
      .prepare("SELECT readiness FROM project_task_sources WHERE projectId = ?")
      .get(projectId) as Row | undefined;
    return row ? String(row.readiness) : undefined;
  }

  /** One issue's labels and the Project fields of its memberships in its task's project. */
  private readinessFacts(external: Row) {
    const rows = this.db
      .prepare(
        `SELECT fields AS projectFields FROM source_memberships WHERE ${itemIs()} AND projectId = ?`,
      )
      .all(
        ...itemKey(String(external.nodeId)),
        String(external.projectId),
      ) as Row[];
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
        "SELECT selectionId, complete, skippedClosedIds FROM source_sync_state WHERE projectId = ?",
      )
      .all(projectId) as Row[];
    const rows = this.db
      .prepare(`SELECT m.selectionId, m.externalId AS nodeId, m.fields AS projectFields, e.observedState, e.labels,
        t.ready, t.readinessRule, t.projectId AS taskProjectId
        FROM source_memberships m JOIN external_items e ON ${sameItem("e", "m")}
        JOIN domain_tasks t ON t.id = e.taskId
        WHERE m.projectId = ?`)
      .all(projectId) as Row[];
    const ruleText = this.readinessRuleText(projectId);
    const rule = ruleText === undefined ? null : parseRule(ruleText);
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
          .parse(JSON.parse(String(sync.skippedClosedIds)) as unknown)
          .filter((id) => !memberIds.has(id)).length;
        const open = members.filter((r) => r.observedState === "open");
        // A rule change re-evaluates Ready only on the next read; claim no match until then.
        const stale = open.some(
          (r) =>
            r.taskProjectId === projectId &&
            (r.readinessRule !== ruleText ||
              matching(r) !== (Number(r.ready) === 1)),
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

  /** Conditions or field values with their stored names; see `withProjectFieldNames`. */
  withFieldNames<T extends ProjectFieldIds>(
    items: readonly T[],
    disclose?: (name: string) => boolean,
  ) {
    return withProjectFieldNames(this.db, items, disclose);
  }

  /**
   * Each Project selection's single-select fields, named by its last complete read, with how
   * many open items of the selection hold each option. Never a readiness grant.
   */
  selectionFieldCounts(projectId: string): Map<
    string,
    {
      projectNodeId: string;
      fields: {
        fieldNodeId: string;
        name: string;
        options: { optionNodeId: string; name: string; open: number }[];
      }[];
    }
  > {
    const row = this.db
      .prepare(
        "SELECT selections FROM project_task_sources WHERE projectId = ?",
      )
      .get(projectId) as Row | undefined;
    const projects = z
      .array(selectionSchema)
      .parse(JSON.parse(String(row?.selections ?? "[]")) as unknown)
      .flatMap((s) => (s.kind === "project" ? [s] : []));
    const names = projectFieldNames(
      this.db,
      projects.map((s) => s.projectNodeId),
    );
    // Open items per selection, field and option, tallied in one pass.
    const open = new Map<string, number>();
    const key = (selectionId: string, fieldNodeId: string, optionId: string) =>
      `${selectionId}\0${fieldNodeId}\0${optionId}`;
    for (const m of this.db
      .prepare(`SELECT m.selectionId, m.fields AS projectFields FROM source_memberships m
        JOIN external_items e ON ${sameItem("e", "m")}
        WHERE m.projectId = ? AND e.observedState = 'open'`)
      .all(projectId) as Row[])
      for (const f of projectFieldsSchema.parse(
        JSON.parse(String(m.projectFields)),
      )) {
        const k = key(String(m.selectionId), f.fieldNodeId, f.optionNodeId);
        open.set(k, (open.get(k) ?? 0) + 1);
      }
    return new Map(
      projects.map((s) => [
        s.id,
        {
          projectNodeId: s.projectNodeId,
          fields: names
            .filter((f) => f.projectNodeId === s.projectNodeId)
            .map((f) => ({
              fieldNodeId: f.fieldNodeId,
              name: f.name,
              options: f.options.map((o) => ({
                ...o,
                open: open.get(key(s.id, f.fieldNodeId, o.optionNodeId)) ?? 0,
              })),
            })),
        },
      ]),
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
      .prepare(`SELECT e.taskId, e.externalId AS nodeId, e.labels, e.observedState, t.projectId, t.ready,
        t.readinessRule
        FROM external_items e JOIN domain_tasks t ON t.id = e.taskId
        WHERE e.taskId IN (SELECT value FROM json_each(?))`)
      .all(ids) as Row[];
    const memberships = this.db
      .prepare(`SELECT m.externalId AS nodeId, m.projectId, m.fields AS projectFields FROM source_memberships m
        JOIN external_items e ON ${sameItem("e", "m")}
        WHERE e.taskId IN (SELECT value FROM json_each(?))`)
      .all(ids) as Row[];
    const rules = new Map(
      (
        this.db
          .prepare(`SELECT projectId, readiness FROM project_task_sources
          WHERE projectId IN (SELECT DISTINCT t.projectId FROM domain_tasks t
            WHERE t.id IN (SELECT value FROM json_each(?)))`)
          .all(ids) as Row[]
      ).map((row) => [String(row.projectId), String(row.readiness)]),
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
          ruleText = rules.get(projectId),
          rule = ruleText === undefined ? null : parseRule(ruleText);
        const own =
          byIssue.get(`${projectId}\0${String(external.nodeId)}`) ?? [];
        const notEvaluated: TaskReadiness = {
          rule,
          outcome: "not-evaluated",
          unmet: [],
        };
        // A stamp other than the current rule (or none) fails closed: Ready predates the rule.
        if (
          external.observedState !== "open" ||
          own.length === 0 ||
          external.readinessRule !== ruleText
        )
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
      .prepare(`INSERT INTO source_holds (provider, instance, externalId, active, reason, generation) VALUES (?, ?, ?, 1, ?, 1)
      ON CONFLICT(provider, instance, externalId) DO UPDATE SET active = 1, reason = excluded.reason,
      generation = CASE WHEN active = 0 OR reason != excluded.reason THEN generation + 1 ELSE generation END`)
      .run(...itemKey(nodeId), reason);
  }
}
