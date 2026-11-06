import { assertCapturedWorkspaceAvailable } from "./project-cleanup-reservations.js";
import {
  capturedFilesystemState,
  observeFilesystem,
  type CapturedRepositoryIdentity,
  type FilesystemIdentity,
  type CleanupOutcome,
} from "./project-cleanup-identities.js";
import {
  assertOwnedTaskWritable,
  taskAcceptsWrites,
  ProjectArchivedError,
} from "../core/project-lifecycle.js";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { transaction, type Database } from "../core/store.js";
import { runGit } from "./git-process.js";

const maxGitOutputBytes = 1024 * 1024;
const maxTimerMs = 2_147_483_647;

const gitOperations = [
  "repository-identity",
  "repository-create",
  "ref-resolution",
  "checkout-validation",
  "worktree-add",
  "archive-status",
  "worktree-remove",
] as const;

type GitOperation = (typeof gitOperations)[number];
type GitFailureKind = "failed" | "timed-out" | "cancelled" | "output-limit";

const gitOperationTimeouts: Record<GitOperation, number> = {
  "repository-identity": 30_000,
  "repository-create": 30_000,
  "ref-resolution": 30_000,
  "checkout-validation": 30_000,
  "worktree-add": 120_000,
  "archive-status": 120_000,
  "worktree-remove": 120_000,
};

const workspaceStateSchema = z.enum([
  "provisioning",
  "ready",
  "held",
  "archiving",
  "archived",
]);

export const repositoryBindingSchema = z.object({
  repositoryId: z.string().min(1).max(512),
  sourcePath: z.string().min(1),
  workspacePath: z.string().min(1),
  ref: z.string().min(1).max(512),
  /** The worktree's common directory: cab's managed repository, or the source's for a legacy binding. */
  gitCommonDir: z.string().nullable(),
  commit: z.string().nullable(),
  /** The source checkout's common directory; present only when `gitCommonDir` is a managed repository. */
  sourceGitCommonDir: z.string().nullable().optional(),
  /** The worktree's admin directory in the managed repository. */
  gitDirectory: z.string().nullable().optional(),
});

export const taskWorkspaceSchema = z.object({
  taskId: z.string().min(1).max(512),
  workspaceId: z.string().uuid(),
  path: z.string().min(1),
  repositories: z.array(repositoryBindingSchema),
  state: workspaceStateSchema,
  reason: z.string().nullable(),
  gitUncertain: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const storedWorkspaceSchema = z.object({
  taskId: z.string(),
  workspaceId: z.string(),
  path: z.string(),
  repositories: z.string(),
  state: z.string(),
  reason: z.string().nullable(),
  gitUncertain: z.union([z.literal(0), z.literal(1)]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const repositoryInputSchema = z.object({
  repositoryId: z.string().trim().min(1).max(512),
  path: z.string().trim().min(1),
  ref: z.string().trim().min(1).max(512).optional(),
  /** Starts the worktree at this commit instead of `ref`'s, as a stacked dependent does. */
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});

export type TaskWorkspaceRepositoryInput = z.infer<
  typeof repositoryInputSchema
>;

export type TaskWorkspaceRepository = z.infer<typeof repositoryBindingSchema>;

/** Every stored path of a repository binding, for reservations and redaction. */
export function repositoryBindingPaths(
  repository: TaskWorkspaceRepository,
): string[] {
  return [
    repository.sourcePath,
    repository.workspacePath,
    ...[
      repository.gitCommonDir,
      repository.sourceGitCommonDir,
      repository.gitDirectory,
    ].filter((path): path is string => typeof path === "string"),
  ];
}

/**
 * The paths a task turn's Git may write besides its workspace: the managed repository's
 * objects and refs and the worktree's own admin directory. None for a legacy binding.
 */
export function taskGitWritableRoots(binding: TaskWorkspaceBinding): string[] {
  return binding.repositories.flatMap((repository) =>
    managedRepositoryOf(repository) && repository.gitDirectory
      ? [
          join(repository.gitCommonDir, "objects"),
          join(repository.gitCommonDir, "reftable"),
          repository.gitDirectory,
        ]
      : [],
  );
}

/** A binding made from a managed repository, which is its `gitCommonDir`; legacy ones are not. */
function managedRepositoryOf(
  repository: TaskWorkspaceRepository,
): repository is TaskWorkspaceRepository & { gitCommonDir: string } {
  return !!repository.sourceGitCommonDir && !!repository.gitCommonDir;
}

/** The repository whose worktree list holds this binding's worktree. */
function worktreeOwner(repository: TaskWorkspaceRepository): string {
  return managedRepositoryOf(repository)
    ? repository.gitCommonDir
    : repository.sourcePath;
}

/** Runs `operation` after every earlier one under `key` has settled. */
function serialized<T>(
  chains: Map<string, Promise<unknown>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const current = (chains.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(operation);
  chains.set(key, current);
  return current.finally(() => {
    if (chains.get(key) === current) chains.delete(key);
  });
}

export type TaskWorkspaceBinding = z.infer<typeof taskWorkspaceSchema>;

export interface CapturedWorkspaceDiscard {
  binding: TaskWorkspaceBinding;
  managedRoot: string;
  filesystem: FilesystemIdentity | { unavailable: true };
  gitIdentities?: CapturedRepositoryIdentity[] | undefined;
}

export interface CapturedWorkspaceRemovalJournal {
  begin(repositoryId: string): boolean;
  settled(repositoryId: string): boolean;
  unobserved(): void;
}

export interface WorkspaceCleanupEvidence {
  deliveryConfirmed: boolean;
  writerOwnershipResolved: boolean;
  handoffsPreserved: boolean;
  reconciliationEvidencePreserved: boolean;
  workspaceContentsPreserved: boolean;
}

export type WorkspaceCleanupResult =
  | { outcome: "cleaned"; binding: TaskWorkspaceBinding }
  | { outcome: "retained"; binding: TaskWorkspaceBinding; reason: string };

export type WorkspaceManagerOptions = {
  /**
   * Makes new worktrees from a cab-owned bare repository per scope and source repository,
   * under `root`, instead of from the source checkout. Task workspaces only.
   */
  managedRepositories?: { root: string; scopeOf(taskId: string): string };
  /** Narrow path-access observer used to prove restored-root identity ordering. */
  beforePathAccess?: (path: string) => void;
  /** Test-only executable override; production always resolves the `git` command. */
  gitExecutable?: string;
  /** Test-only captured-cleanup child runner; never used by ordinary workspace operations. */
  capturedGitRunner?: typeof runGit;
  /** Test-only shortened per-operation deadlines. */
  gitTimeoutMs?: Partial<Record<GitOperation, number>>;
  /** Test-only bounds for exact-child termination and final stream observation. */
  gitTerminationGraceMs?: number;
  gitTerminationObservationMs?: number;
  /** Test-only safe child-lifecycle readback; never receives arguments or paths. */
  gitFailureObserver?: (failure: {
    operation: GitOperation;
    kind: GitFailureKind;
    childExitObserved: boolean;
    childExitSignal: NodeJS.Signals | null;
  }) => void;
};

/** The task-domain and writer-owner call seam; neither needs to own this storage. */
export interface TaskWorkspaceLifecycle {
  provision(
    taskId: string,
    repositories?: TaskWorkspaceRepositoryInput[],
  ): Promise<TaskWorkspaceBinding>;
  /** `reuseRecentIdentity` is for read-only inspection rechecks, never execution. */
  get(
    taskId: string,
    options?: { reuseRecentIdentity?: boolean },
  ): Promise<TaskWorkspaceBinding | undefined>;
  forExecution(taskId: string): Promise<TaskWorkspaceBinding>;
  archiveAndCleanup(
    taskId: string,
    evidence: WorkspaceCleanupEvidence,
    finalWriterCheck?: () => boolean,
  ): Promise<WorkspaceCleanupResult>;
}

export interface WorkspaceBindingStore {
  writable?(taskId: string): boolean;
  projectWrite?:
    | (<T>(taskId: string, run: () => Promise<T>) => Promise<T>)
    | undefined;
  createOrGet(
    taskId: string,
    workspaceId: string,
    path: string,
    repositories: TaskWorkspaceRepository[],
  ): TaskWorkspaceBinding;
  get(taskId: string): TaskWorkspaceBinding | undefined;
  list(): TaskWorkspaceBinding[];
  bindRepository(
    taskId: string,
    repositoryId: string,
    gitCommonDir: string,
    commit: string,
    sourceGitCommonDir?: string,
  ): TaskWorkspaceBinding;
  /** Records a managed worktree's admin directory once Git has created it. */
  recordGitDirectory(
    taskId: string,
    repositoryId: string,
    gitDirectory: string,
  ): TaskWorkspaceBinding;
  update(
    taskId: string,
    state: TaskWorkspaceBinding["state"],
    reason: string | null,
  ): TaskWorkspaceBinding;
  markGitUncertain(taskId: string, reason: string): TaskWorkspaceBinding;
}

class WorkspaceGitError extends Error {
  readonly uncertain: boolean;

  constructor(
    readonly operation: GitOperation,
    readonly kind: GitFailureKind,
    readonly childExitObserved: boolean,
    readonly childExitSignal: NodeJS.Signals | null,
    readonly childStarted: boolean,
  ) {
    super(`Workspace Git ${kind} during ${operation}`);
    this.name = "WorkspaceGitError";
    this.uncertain = kind !== "failed" || (childStarted && !childExitObserved);
  }
}

class WorkspaceManagerCancelledError extends Error {
  constructor() {
    super("Workspace manager is stopping");
    this.name = "WorkspaceManagerCancelledError";
  }
}

/** Call after Store.ensureHost; owns only the workspace-binding table. */
export class SqliteWorkspaceBindingStore implements WorkspaceBindingStore {
  /** `table` lets disposable drafting worktrees use their own bindings. */
  constructor(
    private readonly db: Database,
    private readonly table = "task_workspace_bindings",
    readonly projectWrite?: <T>(
      taskId: string,
      run: () => Promise<T>,
    ) => Promise<T>,
  ) {
    if (!/^[a-z_]+$/.test(table)) throw new Error("Invalid workspace table");
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      taskId TEXT PRIMARY KEY,
      workspaceId TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL UNIQUE,
      repositories TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('provisioning','ready','held','archiving','archived')),
      reason TEXT,
      gitUncertain INTEGER NOT NULL DEFAULT 0 CHECK(gitUncertain IN (0,1)),
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`);
    const columns = this.db
      .prepare(`PRAGMA table_info(${this.table})`)
      .all() as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === "gitUncertain"))
      this.db.exec(`ALTER TABLE ${this.table}
        ADD COLUMN gitUncertain INTEGER NOT NULL DEFAULT 0
        CHECK(gitUncertain IN (0,1))`);
  }

  writable(taskId: string): boolean {
    return taskAcceptsWrites(this.db, taskId);
  }

  createOrGet(
    taskId: string,
    workspaceId: string,
    path: string,
    repositories: TaskWorkspaceRepository[],
  ): TaskWorkspaceBinding {
    const create = () => {
      assertOwnedTaskWritable(this.db, taskId);
      assertCapturedWorkspaceAvailable(this.db, {
        taskId,
        workspaceId,
        path,
        repositories,
      });
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT OR IGNORE INTO ${this.table}
            (taskId, workspaceId, path, repositories, state, reason, gitUncertain, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, 'provisioning', NULL, 0, ?, ?)`,
        )
        .run(taskId, workspaceId, path, JSON.stringify(repositories), now, now);
      return this.get(taskId) ?? this.invalidRow();
    };
    return this.db.isTransaction ? create() : transaction(this.db, create);
  }

  get(taskId: string): TaskWorkspaceBinding | undefined {
    const row = this.db
      .prepare(`SELECT * FROM ${this.table} WHERE taskId = ?`)
      .get(taskId);
    return row === undefined ? undefined : this.parseRow(row);
  }

  list(): TaskWorkspaceBinding[] {
    return this.db
      .prepare(`SELECT * FROM ${this.table} ORDER BY createdAt, taskId`)
      .all()
      .map((row) => this.parseRow(row));
  }

  /** Bindings whose copy may still exist, selected in SQL so archived rows cost nothing. */
  unarchived(): TaskWorkspaceBinding[] {
    return this.db
      .prepare(
        `SELECT * FROM ${this.table} WHERE state != 'archived' ORDER BY createdAt, taskId`,
      )
      .all()
      .map((row) => this.parseRow(row));
  }

  bindRepository(
    taskId: string,
    repositoryId: string,
    gitCommonDir: string,
    commit: string,
    sourceGitCommonDir?: string,
  ): TaskWorkspaceBinding {
    return transaction(this.db, () => {
      assertOwnedTaskWritable(this.db, taskId);
      const binding = this.get(taskId);
      if (!binding) throw new Error(`No task workspace for ${taskId}`);
      const index = binding.repositories.findIndex(
        (repository) => repository.repositoryId === repositoryId,
      );
      if (index < 0) throw new Error(`Unknown repository ${repositoryId}`);
      const current = binding.repositories[index];
      if (!current) throw new Error(`Unknown repository ${repositoryId}`);
      if (current.gitCommonDir !== null) {
        if (
          current.gitCommonDir !== gitCommonDir ||
          (current.sourceGitCommonDir ?? undefined) !== sourceGitCommonDir
        )
          throw new Error(`Repository identity changed for ${repositoryId}`);
        return binding;
      }
      const repositories = [...binding.repositories];
      repositories[index] = {
        ...current,
        gitCommonDir,
        commit,
        ...(sourceGitCommonDir ? { sourceGitCommonDir } : {}),
      };
      assertCapturedWorkspaceAvailable(this.db, { ...binding, repositories });
      this.db
        .prepare(
          `UPDATE ${this.table} SET repositories = ?, updatedAt = ? WHERE taskId = ?`,
        )
        .run(JSON.stringify(repositories), new Date().toISOString(), taskId);
      return this.get(taskId) ?? this.invalidRow();
    });
  }

  recordGitDirectory(
    taskId: string,
    repositoryId: string,
    gitDirectory: string,
  ): TaskWorkspaceBinding {
    return transaction(this.db, () => {
      assertOwnedTaskWritable(this.db, taskId);
      const binding = this.get(taskId);
      const current = binding?.repositories.find(
        (repository) => repository.repositoryId === repositoryId,
      );
      if (!binding || !current?.sourceGitCommonDir)
        throw new Error(`Unknown managed repository ${repositoryId}`);
      if (current.gitDirectory === gitDirectory) return binding;
      if (current.gitDirectory)
        throw new Error(`Repository identity changed for ${repositoryId}`);
      const repositories = binding.repositories.map((repository) =>
        repository === current ? { ...repository, gitDirectory } : repository,
      );
      assertCapturedWorkspaceAvailable(this.db, { ...binding, repositories });
      this.db
        .prepare(
          `UPDATE ${this.table} SET repositories = ?, updatedAt = ? WHERE taskId = ?`,
        )
        .run(JSON.stringify(repositories), new Date().toISOString(), taskId);
      return this.get(taskId) ?? this.invalidRow();
    });
  }

  /** Moves a repository's recorded starting point forward, as after a restack; no transaction of its own. */
  advanceCommit(taskId: string, repositoryId: string, commit: string): void {
    assertOwnedTaskWritable(this.db, taskId);
    const binding = this.get(taskId);
    if (!binding) return;
    this.db
      .prepare(
        `UPDATE ${this.table} SET repositories = ?, updatedAt = ? WHERE taskId = ?`,
      )
      .run(
        JSON.stringify(
          binding.repositories.map((repository) =>
            repository.repositoryId === repositoryId
              ? { ...repository, commit }
              : repository,
          ),
        ),
        new Date().toISOString(),
        taskId,
      );
  }

  update(
    taskId: string,
    state: TaskWorkspaceBinding["state"],
    reason: string | null,
  ): TaskWorkspaceBinding {
    assertOwnedTaskWritable(this.db, taskId);
    this.db
      .prepare(
        `UPDATE ${this.table} SET state = ?, reason = ?, updatedAt = ? WHERE taskId = ?`,
      )
      .run(state, reason, new Date().toISOString(), taskId);
    return this.get(taskId) ?? this.invalidRow();
  }

  markGitUncertain(taskId: string, reason: string): TaskWorkspaceBinding {
    assertOwnedTaskWritable(this.db, taskId);
    this.db
      .prepare(
        `UPDATE ${this.table} SET state = 'held', reason = ?, gitUncertain = 1, updatedAt = ? WHERE taskId = ?`,
      )
      .run(reason, new Date().toISOString(), taskId);
    return this.get(taskId) ?? this.invalidRow();
  }

  private parseRow(row: unknown): TaskWorkspaceBinding {
    const stored = storedWorkspaceSchema.parse(row);
    return taskWorkspaceSchema.parse({
      ...stored,
      repositories: JSON.parse(stored.repositories),
      gitUncertain: stored.gitUncertain === 1,
    });
  }

  private invalidRow(): never {
    throw new Error("Task workspace binding could not be read after update");
  }
}

/** Creates task worktrees and keeps their stable bindings independent of turns. */
export class WorkspaceManager implements TaskWorkspaceLifecycle {
  private readonly workspaceRoot: string;
  private readonly repositoryRoot: string | undefined;
  /** Serializes create-or-validate of each managed repository. */
  private readonly repositoryLocks = new Map<string, Promise<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly unobservedCaptured = new Set<string>();
  private readonly settlementWaiters = new Set<() => void>();
  private readonly gitExecutable: string;
  private readonly gitTimeouts: Partial<Record<GitOperation, number>>;
  private readonly gitTerminationGraceMs: number;
  private readonly gitTerminationObservationMs: number;
  private readonly gitCancellation = new AbortController();
  /** Recent successful worktree identity checks, keyed by workspace path. */
  private readonly worktreeChecks = new Map<
    string,
    { stamp: string; checkedAt: number }
  >();
  private cancelled = false;

  constructor(
    private readonly store: WorkspaceBindingStore,
    workspaceRoot: string,
    private readonly options: WorkspaceManagerOptions = {},
  ) {
    if (!isAbsolute(workspaceRoot))
      throw new Error("Workspace directory must be absolute");
    this.workspaceRoot = canonicalRoot(workspaceRoot);
    const repositoryRoot = options.managedRepositories?.root;
    if (repositoryRoot !== undefined && !isAbsolute(repositoryRoot))
      throw new Error("Managed repository directory must be absolute");
    this.repositoryRoot =
      repositoryRoot === undefined ? undefined : canonicalRoot(repositoryRoot);
    if (
      options.gitExecutable !== undefined &&
      !isAbsolute(options.gitExecutable)
    )
      throw new Error("Test Git executable must be an absolute path");
    this.gitExecutable = options.gitExecutable ?? "git";
    this.gitTimeouts = validateGitTimeouts(options.gitTimeoutMs ?? {});
    this.gitTerminationGraceMs = validateTimer(
      options.gitTerminationGraceMs ?? 2_000,
      "Git termination grace",
    );
    this.gitTerminationObservationMs = validateTimer(
      options.gitTerminationObservationMs ?? 2_000,
      "Git termination observation",
    );
  }

  /** Stops new workspace Git work and interrupts every currently owned child. */
  cancelGitWork(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.gitCancellation.abort();
  }

  /** Waits for bounded outcomes; unobserved captured children remain reserved beyond shutdown. */
  async settle(): Promise<void> {
    while (this.inFlight.size > 0) {
      let changed!: () => void;
      const notification = new Promise<void>((resolve) => {
        changed = resolve;
      });
      this.settlementWaiters.add(changed);
      try {
        const waiting = [...this.inFlight].filter(
          ([id]) => !this.unobservedCaptured.has(id),
        );
        if (!waiting.length) return;
        await Promise.race([
          Promise.allSettled(waiting.map(([, operation]) => operation)),
          notification,
        ]);
      } finally {
        this.settlementWaiters.delete(changed);
      }
    }
  }

  provision(
    taskId: string,
    repositories: TaskWorkspaceRepositoryInput[] = [],
  ): Promise<TaskWorkspaceBinding> {
    const id = z.string().trim().min(1).max(512).parse(taskId);
    const requested = this.normalizeRepositories(repositories);
    return this.withTaskLock(id, async () => {
      let binding = this.store.get(id);
      if (!binding) {
        const workspaceId = randomUUID();
        const path = join(this.workspaceRoot, workspaceId);
        const allocated = requested.map((repository, index) => ({
          repositoryId: repository.repositoryId,
          sourcePath: repository.path,
          workspacePath: join(path, `repo-${index + 1}`),
          ref: repository.ref,
          gitCommonDir: null,
          commit: repository.commit ?? null,
        }));
        binding = this.store.createOrGet(id, workspaceId, path, allocated);
      }
      this.assertSameRepositories(binding, requested);

      if (binding.state === "ready") return this.validateReady(binding);
      if (binding.state !== "provisioning") return binding;
      return this.provisionBinding(binding);
    });
  }

  async get(
    taskId: string,
    options: { reuseRecentIdentity?: boolean } = {},
  ): Promise<TaskWorkspaceBinding | undefined> {
    const id = z.string().trim().min(1).max(512).parse(taskId);
    if (this.store.writable?.(id) === false) return this.store.get(id);
    return this.withTaskLock(id, async () => {
      const binding = this.store.get(id);
      if (binding?.state !== "ready") return binding;
      return this.validateReady(binding, options.reuseRecentIdentity === true);
    });
  }

  async forExecution(taskId: string): Promise<TaskWorkspaceBinding> {
    if (this.store.writable?.(taskId) === false)
      throw new ProjectArchivedError();
    const binding = await this.get(taskId);
    if (!binding) throw new Error(`Task ${taskId} has no workspace binding`);
    if (binding.state !== "ready")
      throw new Error(
        binding.reason ?? `Task workspace is ${binding.state} and cannot run`,
      );
    return binding;
  }

  async recover(): Promise<void> {
    for (const binding of this.store.list()) {
      if (this.store.writable?.(binding.taskId) === false) continue;
      await this.withTaskLock(binding.taskId, async () => {
        if (binding.path !== join(this.workspaceRoot, binding.workspaceId)) {
          this.store.update(
            binding.taskId,
            "held",
            "Stored workspace path does not match its identity",
          );
          return;
        }
        if (binding.state === "provisioning") {
          await this.provisionBinding(binding);
        } else if (binding.state === "ready") {
          await this.validateReady(binding);
        } else if (binding.state === "archiving") {
          this.store.update(
            binding.taskId,
            "held",
            "Workspace cleanup was interrupted; inspect retained paths before recovery",
          );
        }
      });
    }
  }

  archiveAndCleanup(
    taskId: string,
    evidence: WorkspaceCleanupEvidence,
    finalWriterCheck?: () => boolean,
  ): Promise<WorkspaceCleanupResult> {
    const id = z.string().trim().min(1).max(512).parse(taskId);
    const approval = z
      .object({
        deliveryConfirmed: z.boolean(),
        writerOwnershipResolved: z.boolean(),
        handoffsPreserved: z.boolean(),
        reconciliationEvidencePreserved: z.boolean(),
        workspaceContentsPreserved: z.boolean(),
      })
      .parse(evidence);
    return this.withTaskLock(id, async () => {
      const binding = this.store.get(id);
      if (!binding) throw new Error(`Task ${id} has no workspace binding`);
      if (binding.state !== "ready")
        return this.retained(
          binding,
          binding.reason ?? `Workspace is ${binding.state}`,
        );

      const missingEvidence = Object.entries(approval).find(
        ([, value]) => !value,
      )?.[0];
      if (missingEvidence)
        return this.retained(
          binding,
          `Workspace retained until ${missingEvidence} is confirmed`,
        );

      const checked = await this.validateReady(binding);
      if (checked.state !== "ready")
        return this.retained(
          checked,
          checked.reason ?? "Workspace is not available for cleanup",
        );

      for (const repository of checked.repositories) {
        const status = await this.git(
          repository.workspacePath,
          "archive-status",
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--ignored=matching",
          "--ignore-submodules=dirty",
        ).catch((error: unknown) => {
          if (isUncertainGitError(error)) {
            const held = this.store.markGitUncertain(id, error.message);
            return this.retained(held, error.message);
          }
          throw error;
        });
        if (typeof status !== "string") return status;
        if (status.length > 0)
          return this.retained(
            checked,
            `Uncommitted or ignored work remains in ${repository.repositoryId}`,
          );
      }

      if (finalWriterCheck && !finalWriterCheck())
        return this.retained(
          checked,
          "Workspace retained because writer ownership changed during cleanup validation",
        );

      const archiving = this.store.update(
        id,
        "archiving",
        "Workspace cleanup in progress",
      );
      try {
        for (const repository of archiving.repositories) {
          await this.git(
            worktreeOwner(repository),
            "worktree-remove",
            "worktree",
            "remove",
            repository.workspacePath,
          );
        }
        await this.assertManagedRoot(archiving);
        await rm(archiving.path, { recursive: true });
        return {
          outcome: "cleaned",
          binding: this.store.update(id, "archived", null),
        };
      } catch (error) {
        const reason = `Workspace cleanup interrupted: ${messageOf(error)}`;
        const held =
          isUncertainGitError(error) && error.uncertain
            ? this.store.markGitUncertain(id, error.message)
            : this.store.update(id, "held", reason);
        return this.retained(
          held,
          held.reason ?? "Workspace cleanup interrupted",
        );
      }
    });
  }

  /**
   * Removes a disposable worktree even when its files were written. Task
   * workspaces never use this: they are cleaned with evidence by
   * `archiveAndCleanup`. A failure leaves the binding held for a retry.
   */
  discard(id: string): Promise<TaskWorkspaceBinding | undefined> {
    return this.withTaskLock(id, async () => {
      const binding = this.store.get(id);
      if (!binding || binding.state === "archived") return binding;
      this.store.update(id, "archiving", "Workspace discard in progress");
      try {
        if (!(await lstatIfExists(binding.path)))
          return this.store.update(id, "archived", null);
        await this.assertManagedRoot(binding);
        for (const repository of binding.repositories) {
          if (!(await lstatIfExists(repository.workspacePath))) continue;
          await this.git(
            worktreeOwner(repository),
            "worktree-remove",
            "worktree",
            "remove",
            "--force",
            repository.workspacePath,
          );
        }
        await rm(binding.path, { recursive: true, force: true });
        return this.store.update(id, "archived", null);
      } catch (error) {
        const reason = `Workspace discard interrupted: ${messageOf(error)}`;
        return isUncertainGitError(error)
          ? this.store.markGitUncertain(id, error.message)
          : this.store.update(id, "held", reason);
      }
    });
  }

  /** Deleted-domain cleanup: shared task lock, captured proof, no live binding lookup/update. */
  discardCaptured(
    captured: CapturedWorkspaceDiscard,
    allowed: () => boolean,
    journal: CapturedWorkspaceRemovalJournal,
  ): Promise<CleanupOutcome> {
    return this.withTaskIdentityLock(
      captured.binding.taskId,
      async (): Promise<CleanupOutcome> => {
        const pending = (
          reason: "unsafe" | "unavailable" | "failed" | "unknown",
        ): CleanupOutcome => ({ outcome: "pending", reason });
        const { binding } = captured;
        try {
          if (
            !allowed() ||
            captured.managedRoot !== this.workspaceRoot ||
            binding.path !== join(this.workspaceRoot, binding.workspaceId)
          )
            return pending("unsafe");
          const managed = await observeFilesystem(this.workspaceRoot);
          if (managed.state === "absent") {
            return (await realpath(dirname(this.workspaceRoot))) ===
              dirname(this.workspaceRoot) && allowed()
              ? { outcome: "complete" }
              : pending("unsafe");
          }
          if (managed.state !== "observed") return pending("unavailable");
          if (
            !managed.stat.isDirectory() ||
            managed.stat.isSymbolicLink() ||
            (await realpath(this.workspaceRoot)) !== this.workspaceRoot
          )
            return pending("unsafe");
          const root = await observeFilesystem(binding.path);
          if (root.state === "absent")
            return allowed() ? { outcome: "complete" } : pending("unsafe");
          if ("unavailable" in captured.filesystem)
            return pending("unavailable");
          const rootState = await capturedFilesystemState(
            binding.path,
            captured.filesystem,
          );
          if (rootState !== "same")
            return pending(rootState === "unsafe" ? "unsafe" : "unavailable");
          await this.assertManagedRoot(binding);
          const identities = captured.gitIdentities ?? [];
          if (
            identities.length !== binding.repositories.length ||
            new Set(identities.map((identity) => identity.repositoryId))
              .size !== identities.length
          )
            return pending("unavailable");
          for (const repository of binding.repositories) {
            if (!allowed()) return pending("unavailable");
            const proof = identities.find(
              (item) => item.repositoryId === repository.repositoryId,
            );
            const current = await observeFilesystem(repository.workspacePath);
            if (!proof) return pending("unavailable");
            if (proof.state !== "observed") {
              if (current.state === "absent") continue;
              return pending(
                proof.state === "absent" ? "unsafe" : "unavailable",
              );
            }
            if (
              proof.commonDirectory.path !== repository.gitCommonDir ||
              dirname(proof.gitDirectory.path) !==
                join(proof.commonDirectory.path, "worktrees")
            )
              return pending("unsafe");
            for (const [path, identity] of [
              [repository.sourcePath, proof.source],
              [proof.commonDirectory.path, proof.commonDirectory.filesystem],
            ] as const) {
              const state = await capturedFilesystemState(path, identity);
              if (state !== "same")
                return pending(state === "unsafe" ? "unsafe" : "unavailable");
            }
            const admin = await capturedFilesystemState(
              proof.gitDirectory.path,
              proof.gitDirectory.filesystem,
            );
            if (current.state === "absent" && admin === "absent") continue;
            if (admin !== "same")
              return pending(
                admin === "unsafe" || admin === "absent"
                  ? "unsafe"
                  : "unavailable",
              );
            const backPointer = await observeFilesystem(
              join(proof.gitDirectory.path, "gitdir"),
            );
            if (
              backPointer.state !== "observed" ||
              !backPointer.stat.isFile() ||
              backPointer.stat.isSymbolicLink() ||
              (
                await readFile(join(proof.gitDirectory.path, "gitdir"), "utf8")
              ).trim() !== join(repository.workspacePath, ".git")
            )
              return pending("unsafe");
            if (current.state !== "absent") {
              for (const [path, identity, kind] of [
                [repository.workspacePath, proof.root, "directory"],
                [
                  join(repository.workspacePath, ".git"),
                  proof.gitEntry,
                  "file",
                ],
              ] as const) {
                const state = await capturedFilesystemState(
                  path,
                  identity,
                  kind,
                );
                if (state !== "same")
                  return pending(
                    state === "unsafe" || state === "absent"
                      ? "unsafe"
                      : "unavailable",
                  );
              }
              if (
                (await this.capturedGit(repository.workspacePath, [
                  "rev-parse",
                  "--absolute-git-dir",
                ])) !== proof.gitDirectory.path ||
                (await this.capturedGit(repository.workspacePath, [
                  "rev-parse",
                  "--path-format=absolute",
                  "--git-common-dir",
                ])) !== proof.commonDirectory.path ||
                (await this.capturedGit(repository.workspacePath, [
                  "rev-parse",
                  "--show-toplevel",
                ])) !== repository.workspacePath
              )
                return pending("unsafe");
            }
            this.options.beforePathAccess?.(repository.workspacePath);
            // Every await above permits another cab request; fence and compare immediately before mutation.
            for (const [path, identity] of [
              [repository.sourcePath, proof.source],
              [proof.commonDirectory.path, proof.commonDirectory.filesystem],
              [proof.gitDirectory.path, proof.gitDirectory.filesystem],
            ] as const) {
              if ((await capturedFilesystemState(path, identity)) !== "same")
                return pending("unsafe");
            }
            if (
              current.state === "observed" &&
              (await capturedFilesystemState(
                join(repository.workspacePath, ".git"),
                proof.gitEntry,
                "file",
              )) !== "same"
            )
              return pending("unsafe");
            const finalPointer = await observeFilesystem(
              join(proof.gitDirectory.path, "gitdir"),
            );
            if (
              finalPointer.state !== "observed" ||
              finalPointer.stat.isSymbolicLink() ||
              !finalPointer.stat.isFile() ||
              finalPointer.stat.dev !== backPointer.stat.dev ||
              finalPointer.stat.ino !== backPointer.stat.ino ||
              (
                await readFile(join(proof.gitDirectory.path, "gitdir"), "utf8")
              ).trim() !== join(repository.workspacePath, ".git")
            )
              return pending("unsafe");
            const finalRoot = await capturedFilesystemState(
              binding.path,
              captured.filesystem,
            );
            const finalRepo = await observeFilesystem(repository.workspacePath);
            if (finalRoot !== "same" || !allowed()) return pending("unsafe");
            if (
              finalRepo.state !== current.state ||
              (finalRepo.state === "observed" &&
                (String(finalRepo.stat.dev) !== proof.root.device ||
                  String(finalRepo.stat.ino) !== proof.root.inode ||
                  finalRepo.stat.isSymbolicLink()))
            )
              return pending("unsafe");
            // A failed reservation write must precede (and prevent) child dispatch.
            if (!journal.begin(repository.repositoryId))
              return pending("unsafe");
            let failure: unknown;
            try {
              await this.capturedGit(
                worktreeOwner(repository),
                ["worktree", "remove", "--force", repository.workspacePath],
                () => {
                  this.unobservedCaptured.add(binding.taskId);
                  for (const notify of this.settlementWaiters) notify();
                  journal.unobserved();
                },
                () => {
                  this.unobservedCaptured.delete(binding.taskId);
                },
              );
            } catch (error) {
              // A bounded unobserved result never gets here until exact-child exit.
              if (
                !(error instanceof WorkspaceGitError) ||
                (error.childStarted && !error.childExitObserved)
              )
                throw error;
              failure = error;
            }
            // Positive exit (or proof no child spawned) alone is not permission to clear.
            // Recheck the captured source/common/root and competing owners after the await.
            for (const [path, identity] of [
              [repository.sourcePath, proof.source],
              [proof.commonDirectory.path, proof.commonDirectory.filesystem],
              [binding.path, captured.filesystem],
            ] as const) {
              if ((await capturedFilesystemState(path, identity)) !== "same")
                return pending("unsafe");
            }
            const remaining = await observeFilesystem(repository.workspacePath);
            if (
              remaining.state !== "absent" &&
              (remaining.state !== "observed" ||
                remaining.stat.isSymbolicLink() ||
                String(remaining.stat.dev) !== proof.root.device ||
                String(remaining.stat.ino) !== proof.root.inode)
            )
              return pending("unsafe");
            if (!journal.settled(repository.repositoryId))
              return pending("unsafe");
            if (!allowed()) return pending("unavailable");
            if (failure) throw failure;
            if (
              (await observeFilesystem(repository.workspacePath)).state !==
              "absent"
            )
              return pending("unknown");
          }
          this.options.beforePathAccess?.(binding.path);
          if (
            (await capturedFilesystemState(
              binding.path,
              captured.filesystem,
            )) !== "same" ||
            !allowed()
          )
            return pending("unsafe");
          await rm(binding.path, { recursive: true, force: true });
          return (await observeFilesystem(binding.path)).state === "absent"
            ? { outcome: "complete" }
            : pending("unknown");
        } catch (error) {
          return pending(
            error instanceof WorkspaceGitError &&
              error.childStarted &&
              !error.childExitObserved
              ? "unknown"
              : "failed",
          );
        }
      },
    ).catch(
      (): CleanupOutcome => ({ outcome: "pending", reason: "unavailable" }),
    );
  }

  private async capturedGit(
    cwd: string,
    args: string[],
    unobserved?: () => void,
    observed?: () => void,
  ): Promise<string> {
    this.assertNotCancelled();
    let result = await (this.options.capturedGitRunner ?? runGit)({
      executable: this.gitExecutable,
      cwd,
      args: ["--no-optional-locks", "-C", cwd, ...args],
      timeoutMs: 10_000,
      observeSettlement: !!unobserved,
      terminationGraceMs: this.gitTerminationGraceMs,
      observationMs: this.gitTerminationObservationMs,
      maxOutputBytes: maxGitOutputBytes,
      signal: this.gitCancellation.signal,
    });
    if (
      unobserved &&
      result.status === "interrupted" &&
      result.spawned &&
      !result.childExitObserved
    ) {
      unobserved();
      // A malformed injected result keeps the durable marker; it never authorizes a retry.
      if (!result.settlement)
        throw new Error("Captured Git settlement notification unavailable");
      await result.settlement;
      observed?.();
      this.assertNotCancelled();
      result = { ...result, childExitObserved: true };
    }
    if (result.status === "ok") return result.stdout.toString("utf8").trim();
    if (result.status === "exit")
      throw reportGitFailure(
        this.options.gitFailureObserver,
        "worktree-remove",
        "failed",
        result.childExitObserved,
        result.signal,
        true,
      );
    throw reportGitFailure(
      this.options.gitFailureObserver,
      "worktree-remove",
      result.kind,
      result.childExitObserved,
      result.childExitSignal,
      result.spawned,
    );
  }

  private async provisionBinding(
    original: TaskWorkspaceBinding,
  ): Promise<TaskWorkspaceBinding> {
    let binding = original;
    try {
      await this.ensureManagedRoot(binding);
      for (const originalRepository of binding.repositories) {
        binding = this.store.get(binding.taskId) ?? binding;
        let repository = binding.repositories.find(
          (candidate) =>
            candidate.repositoryId === originalRepository.repositoryId,
        );
        if (!repository) throw new Error("Repository binding disappeared");

        if (!repository.gitCommonDir || !repository.commit) {
          const source = await this.gitRepositoryInfo(repository.sourcePath);
          const managed = this.repositoryRoot
            ? await this.managedRepository(binding.taskId, source.gitCommonDir)
            : undefined;
          // A requested commit must already be in the repository: it never falls back to `ref`.
          // A stacked dependent's requested commit is its blocker's, in the managed repository.
          const commit = repository.commit
            ? await this.resolveCommit(
                managed ?? repository.sourcePath,
                repository.commit,
              )
            : await this.resolveCommit(repository.sourcePath, repository.ref);
          binding = this.store.bindRepository(
            binding.taskId,
            repository.repositoryId,
            managed ?? source.gitCommonDir,
            commit,
            managed && source.gitCommonDir,
          );
          repository = binding.repositories.find(
            (candidate) =>
              candidate.repositoryId === originalRepository.repositoryId,
          );
          if (!repository) throw new Error("Repository binding disappeared");
        }
        if (!repository.gitCommonDir || !repository.commit)
          throw new Error(
            `Repository identity is incomplete for ${repository.repositoryId}`,
          );

        if (await this.isExistingWorktree(repository)) {
          await this.assertProvisionedWorktree(repository);
          await this.recordGitDirectory(binding.taskId, repository);
          continue;
        }
        await this.ensureSourceStillMatches(binding.taskId, repository);
        await this.git(
          worktreeOwner(repository),
          "worktree-add",
          "worktree",
          "add",
          "--detach",
          repository.workspacePath,
          repository.commit,
        ).catch(async (error: unknown) => {
          if (isUncertainGitError(error)) throw error;
          if (!(await this.isExistingWorktree(repository))) throw error;
        });
        if (!(await this.isExistingWorktree(repository)))
          throw new Error(
            `Git did not create the workspace for ${repository.repositoryId}`,
          );
        await this.assertProvisionedWorktree(repository);
        await this.recordGitDirectory(binding.taskId, repository);
      }
      return this.store.update(binding.taskId, "ready", null);
    } catch (error) {
      if (isUncertainGitError(error) && error.uncertain)
        return this.store.markGitUncertain(binding.taskId, error.message);
      return this.store.update(
        binding.taskId,
        "provisioning",
        `Workspace creation incomplete: ${messageOf(error)}`,
      );
    }
  }

  private async validateReady(
    binding: TaskWorkspaceBinding,
    reuseRecentIdentity = false,
  ): Promise<TaskWorkspaceBinding> {
    try {
      await this.assertManagedRoot(binding);
      for (const repository of binding.repositories) {
        if (!(await this.isExistingWorktree(repository, reuseRecentIdentity)))
          throw new Error(
            `Missing workspace for repository ${repository.repositoryId}`,
          );
      }
      return binding;
    } catch (error) {
      if (isUncertainGitError(error) && error.uncertain)
        return this.store.markGitUncertain(binding.taskId, error.message);
      return this.store.update(
        binding.taskId,
        "held",
        `Task workspace unavailable: ${messageOf(error)}`,
      );
    }
  }

  private async ensureManagedRoot(
    binding: TaskWorkspaceBinding,
  ): Promise<void> {
    if (binding.path !== join(this.workspaceRoot, binding.workspaceId))
      throw new Error("Stored workspace path does not match its identity");
    this.assertRepositoryPaths(binding);
    await mkdir(this.workspaceRoot, { recursive: true });
    const rootInfo = await lstat(this.workspaceRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
      throw new Error("Workspace directory must be a real directory");
    if (
      resolve(await realpath(dirname(this.workspaceRoot))) !==
      dirname(this.workspaceRoot)
    )
      throw new Error("Workspace directory parent changed");
    const workspaceInfo = await lstatIfExists(binding.path);
    if (!workspaceInfo) {
      if (binding.state !== "provisioning")
        throw new Error("Task workspace is missing");
      await mkdir(binding.path);
    } else if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory()) {
      throw new Error("Task workspace path is not a real directory");
    }
  }

  private async assertManagedRoot(
    binding: TaskWorkspaceBinding,
  ): Promise<void> {
    if (binding.path !== join(this.workspaceRoot, binding.workspaceId))
      throw new Error("Stored workspace path does not match its identity");
    this.assertRepositoryPaths(binding);
    this.options.beforePathAccess?.(binding.path);
    const workspaceInfo = await lstatIfExists(binding.path);
    if (!workspaceInfo) throw new Error("Task workspace is missing");
    if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory())
      throw new Error("Task workspace path is not a real directory");
    this.options.beforePathAccess?.(this.workspaceRoot);
    const canonicalRoot = await realpath(this.workspaceRoot);
    this.options.beforePathAccess?.(binding.path);
    const canonicalWorkspace = await realpath(binding.path);
    if (resolve(canonicalRoot) !== this.workspaceRoot)
      throw new Error("Workspace directory escaped its managed location");
    if (
      resolve(canonicalWorkspace) !==
      resolve(canonicalRoot, binding.workspaceId)
    )
      throw new Error("Task workspace escaped its managed directory");
  }

  private async ensureSourceStillMatches(
    taskId: string,
    repository: TaskWorkspaceRepository,
  ): Promise<void> {
    const source = await this.gitRepositoryInfo(repository.sourcePath);
    const managed = repository.sourceGitCommonDir;
    if (
      source.gitCommonDir !== (managed ?? repository.gitCommonDir) ||
      (managed &&
        (await this.managedRepository(taskId, managed)) !==
          repository.gitCommonDir)
    )
      throw new Error(
        `Repository identity changed for ${repository.repositoryId}`,
      );
  }

  private resolveCommit(path: string, ref: string): Promise<string> {
    return this.git(
      path,
      "ref-resolution",
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    );
  }

  /**
   * Creates or validates the scope's bare reftable repository for a source common
   * directory. It reads the source's objects through an alternate, so no transport runs.
   * A repository that no longer matches is refused, never repaired.
   */
  private async managedRepository(
    taskId: string,
    sourceGitCommonDir: string,
  ): Promise<string> {
    const root = this.repositoryRoot;
    const scope = this.options.managedRepositories?.scopeOf(taskId);
    if (!root || !scope)
      throw new Error("Managed repository scope unavailable");
    const key = createHash("sha256")
      .update(`${scope}\0${sourceGitCommonDir}`)
      .digest("hex")
      .slice(0, 32);
    const path = join(root, key);
    const alternates = `${join(sourceGitCommonDir, "objects")}\n`;
    return serialized(this.repositoryLocks, path, async () => {
      if (!(await lstatIfExists(path))) {
        await mkdir(root, { recursive: true });
        const temporary = join(root, `.${key}-${randomUUID()}`);
        try {
          const format = await this.git(
            sourceGitCommonDir,
            "repository-identity",
            "rev-parse",
            "--show-object-format",
          );
          await this.git(
            root,
            "repository-create",
            "init",
            "--quiet",
            "--bare",
            "--template=",
            "--ref-format=reftable",
            `--object-format=${format}`,
            temporary,
          );
          await writeFile(
            join(temporary, "objects", "info", "alternates"),
            alternates,
          );
          for (const [name, value] of [
            ["gc.auto", "0"],
            ["maintenance.auto", "false"],
            ["core.logAllRefUpdates", "true"],
          ] as const)
            await this.git(
              temporary,
              "repository-create",
              "config",
              name,
              value,
            );
          await rename(temporary, path);
        } catch (error) {
          await rm(temporary, { recursive: true, force: true });
          // Another process may have created it first; validation below decides.
          if (!(await lstatIfExists(path))) throw error;
        }
      }
      const info = await lstat(path);
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        (await realpath(path)) !== path ||
        (await this.git(
          path,
          "repository-identity",
          "rev-parse",
          "--absolute-git-dir",
          "--is-bare-repository",
          "--show-ref-format",
        )) !== `${path}\ntrue\nreftable` ||
        (await readFile(
          join(path, "objects", "info", "alternates"),
          "utf8",
        ).catch(() => null)) !== alternates
      )
        throw new Error(
          "Managed repository does not match its source; inspect it before recovery",
        );
      return path;
    });
  }

  /** Binds a managed worktree to the admin directory Git chose for it. */
  private async recordGitDirectory(
    taskId: string,
    repository: TaskWorkspaceRepository,
  ): Promise<void> {
    if (!managedRepositoryOf(repository)) return;
    const gitDirectory = await this.git(
      repository.workspacePath,
      "checkout-validation",
      "rev-parse",
      "--absolute-git-dir",
    );
    if (dirname(gitDirectory) !== join(repository.gitCommonDir, "worktrees"))
      throw new Error(
        `Workspace admin directory is outside the managed repository for ${repository.repositoryId}`,
      );
    this.store.recordGitDirectory(
      taskId,
      repository.repositoryId,
      gitDirectory,
    );
  }

  private async gitRepositoryInfo(
    path: string,
  ): Promise<{ root: string; gitCommonDir: string }> {
    const combinedIdentity = await this.git(
      path,
      "repository-identity",
      "rev-parse",
      "--show-toplevel",
      "--git-common-dir",
    );
    const identityLines = combinedIdentity.split("\n");
    const reportedCombinedRoot = identityLines[0];
    const reportedCombinedCommonDir = identityLines[1];
    if (
      identityLines.length === 2 &&
      reportedCombinedRoot &&
      isAbsolute(reportedCombinedRoot) &&
      reportedCombinedCommonDir
    ) {
      const root = await realpath(reportedCombinedRoot);
      const reportedCommonPath = isAbsolute(reportedCombinedCommonDir)
        ? reportedCombinedCommonDir
        : resolve(await realpath(path), reportedCombinedCommonDir);
      const gitCommonDir = await realpath(reportedCommonPath);
      return { root: resolve(root), gitCommonDir };
    }

    // Paths can contain newlines, so a combined rev-parse result is ambiguous
    // unless it has exactly two nonempty identity lines. Preserve those paths
    // by falling back to the original separately bounded reads.
    const reportedRoot = await this.git(
      path,
      "repository-identity",
      "rev-parse",
      "--show-toplevel",
    );
    const root = await realpath(reportedRoot);
    const reportedCommonDir = await this.git(
      root,
      "repository-identity",
      "rev-parse",
      "--git-common-dir",
    );
    const gitCommonDir = await realpath(
      isAbsolute(reportedCommonDir)
        ? reportedCommonDir
        : resolve(root, reportedCommonDir),
    );
    return { root: resolve(root), gitCommonDir };
  }

  private async git(
    cwd: string,
    operation: GitOperation,
    ...args: string[]
  ): Promise<string> {
    this.assertNotCancelled();
    const signal = this.gitCancellation.signal;
    // Cancelled before starting: no child, so no failure observation.
    if (signal.aborted)
      throw new WorkspaceGitError(operation, "cancelled", false, null, false);
    const defaultTimeoutMs =
      operation === "checkout-validation" && args[0] === "status"
        ? 120_000
        : gitOperationTimeouts[operation];
    const result = await runGit({
      executable: this.gitExecutable,
      cwd,
      args: ["-C", cwd, ...args],
      timeoutMs: this.gitTimeouts[operation] ?? defaultTimeoutMs,
      terminationGraceMs: this.gitTerminationGraceMs,
      observationMs: this.gitTerminationObservationMs,
      maxOutputBytes: maxGitOutputBytes,
      signal,
    });
    if (result.status === "ok") return result.stdout.toString("utf8").trim();
    const failure =
      result.status === "exit"
        ? {
            kind: "failed" as const,
            childExitObserved: result.childExitObserved,
            childExitSignal: result.signal,
            started: true,
          }
        : {
            kind: result.kind,
            childExitObserved: result.childExitObserved,
            childExitSignal: result.childExitSignal,
            started: result.spawned,
          };
    throw reportGitFailure(
      this.options.gitFailureObserver,
      operation,
      failure.kind,
      failure.childExitObserved,
      failure.childExitSignal,
      failure.started,
    );
  }

  /** @internal Allows service startup to honor the same sticky cancellation latch. */
  assertNotCancelled(): void {
    if (this.cancelled) throw new WorkspaceManagerCancelledError();
  }

  private async isExistingWorktree(
    repository: TaskWorkspaceRepository,
    reuseRecentIdentity = false,
  ): Promise<boolean> {
    const info = await lstatIfExists(repository.workspacePath);
    const previous = this.worktreeChecks.get(repository.workspacePath);
    this.worktreeChecks.delete(repository.workspacePath);
    if (!info) return false;
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(
        `Workspace path for ${repository.repositoryId} is not a real directory`,
      );
    // Inspection rechecks run many times per read; they may reuse a just-verified
    // Git identity only while the worktree root and its .git entry are unchanged.
    const gitEntry = await lstatIfExists(
      join(repository.workspacePath, ".git"),
    );
    const stamp = JSON.stringify([
      repository.gitCommonDir,
      ...[info, gitEntry].map((entry) =>
        entry
          ? [entry.dev, entry.ino, entry.mode, entry.mtimeMs, entry.ctimeMs]
          : null,
      ),
    ]);
    const now = Date.now();
    if (
      reuseRecentIdentity &&
      previous?.stamp === stamp &&
      now - previous.checkedAt >= 0 &&
      now - previous.checkedAt < worktreeCheckReuseMs
    ) {
      this.worktreeChecks.set(repository.workspacePath, previous);
      return true;
    }
    try {
      const worktree = await this.gitRepositoryInfo(repository.workspacePath);
      if (
        worktree.root !== resolve(repository.workspacePath) ||
        worktree.gitCommonDir !== repository.gitCommonDir ||
        (repository.gitDirectory &&
          (await this.git(
            repository.workspacePath,
            "repository-identity",
            "rev-parse",
            "--absolute-git-dir",
          )) !== repository.gitDirectory)
      )
        throw new Error(
          `Workspace path for ${repository.repositoryId} belongs to another repository`,
        );
      this.worktreeChecks.set(repository.workspacePath, {
        stamp,
        checkedAt: now,
      });
      return true;
    } catch (error) {
      if (
        isUncertainGitError(error) &&
        (error.kind !== "failed" || !error.childExitObserved)
      )
        throw error;
      if (messageOf(error).includes("belongs to another repository"))
        throw error;
      const entries = await readdir(repository.workspacePath);
      if (entries.length > 0)
        throw new Error(
          `Incomplete workspace files for ${repository.repositoryId} are preserved at ${repository.workspacePath}`,
        );
      return false;
    }
  }

  private async assertProvisionedWorktree(
    repository: TaskWorkspaceRepository,
  ): Promise<void> {
    if (!repository.commit)
      throw new Error(
        `Repository commit is missing for ${repository.repositoryId}`,
      );
    const head = await this.git(
      repository.workspacePath,
      "checkout-validation",
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    );
    const trackedChanges = await this.git(
      repository.workspacePath,
      "checkout-validation",
      "status",
      "--porcelain=v1",
      "--untracked-files=no",
      "--ignore-submodules=dirty",
    );
    if (head !== repository.commit || trackedChanges.length > 0)
      throw new Error(
        `Workspace checkout is incomplete for ${repository.repositoryId}`,
      );
  }

  private normalizeRepositories(
    repositories: TaskWorkspaceRepositoryInput[],
  ): Array<{
    repositoryId: string;
    path: string;
    ref: string;
    commit?: string;
  }> {
    const parsed = z.array(repositoryInputSchema).parse(repositories);
    const normalized = parsed
      .map((repository) => {
        if (!isAbsolute(repository.path))
          throw new Error("Repository paths must be absolute");
        return {
          repositoryId: repository.repositoryId,
          path: resolve(repository.path),
          ref: repository.ref ?? "HEAD",
          ...(repository.commit ? { commit: repository.commit } : {}),
        };
      })
      .sort((a, b) =>
        a.repositoryId < b.repositoryId
          ? -1
          : a.repositoryId > b.repositoryId
            ? 1
            : 0,
      );
    if (
      new Set(normalized.map(({ repositoryId }) => repositoryId)).size !==
      normalized.length
    )
      throw new Error("Repository IDs must be unique within a task");
    if (new Set(normalized.map(({ path }) => path)).size !== normalized.length)
      throw new Error("A task cannot bind the same repository path twice");
    return normalized;
  }

  private assertSameRepositories(
    binding: TaskWorkspaceBinding,
    requested: Array<{ repositoryId: string; path: string; ref: string }>,
  ): void {
    const current = binding.repositories.map((repository) => ({
      repositoryId: repository.repositoryId,
      path: repository.sourcePath,
      ref: repository.ref,
    }));
    if (
      JSON.stringify(current) !==
      JSON.stringify(
        requested.map(({ repositoryId, path, ref }) => ({
          repositoryId,
          path,
          ref,
        })),
      )
    )
      throw new Error(
        `Task ${binding.taskId} is already bound to a different repository set`,
      );
  }

  private retained(
    binding: TaskWorkspaceBinding,
    reason: string,
  ): WorkspaceCleanupResult {
    return { outcome: "retained", binding, reason };
  }

  private assertRepositoryPaths(binding: TaskWorkspaceBinding): void {
    for (const [index, repository] of binding.repositories.entries()) {
      if (repository.workspacePath !== join(binding.path, `repo-${index + 1}`))
        throw new Error(
          `Stored workspace path for ${repository.repositoryId} is invalid`,
        );
    }
  }

  private withTaskLock<T>(
    taskId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withTaskIdentityLock(taskId, () => {
      if (this.store.writable?.(taskId) === false)
        throw new ProjectArchivedError();
      return this.store.projectWrite
        ? this.store.projectWrite(taskId, operation)
        : operation();
    });
  }

  private withTaskIdentityLock<T>(
    taskId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return serialized(this.inFlight, taskId, () => {
      this.assertNotCancelled();
      return operation();
    });
  }
}

function isUncertainGitError(error: unknown): error is WorkspaceGitError {
  return error instanceof WorkspaceGitError && error.uncertain;
}

function reportGitFailure(
  observer: WorkspaceManagerOptions["gitFailureObserver"],
  operation: GitOperation,
  kind: GitFailureKind,
  childExitObserved: boolean,
  childExitSignal: NodeJS.Signals | null,
  childStarted: boolean,
): WorkspaceGitError {
  const error = new WorkspaceGitError(
    operation,
    kind,
    childExitObserved,
    childExitSignal,
    childStarted,
  );
  try {
    observer?.({
      operation: error.operation,
      kind: error.kind,
      childExitObserved: error.childExitObserved,
      childExitSignal: error.childExitSignal,
    });
  } catch {
    // Test observation cannot alter the Git result.
  }
  return error;
}

function validateGitTimeouts(
  values: Partial<Record<GitOperation, number>>,
): Partial<Record<GitOperation, number>> {
  for (const [operation, milliseconds] of Object.entries(values)) {
    if (
      !gitOperations.includes(operation as GitOperation) ||
      !Number.isSafeInteger(milliseconds) ||
      (milliseconds as number) <= 0 ||
      (milliseconds as number) > maxTimerMs
    )
      throw new Error(
        "Git operation deadlines must be finite positive milliseconds",
      );
  }
  return { ...values };
}

function validateTimer(milliseconds: number, label: string): number {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    milliseconds > maxTimerMs
  )
    throw new Error(`${label} must be finite positive milliseconds`);
  return milliseconds;
}

/** An absolute directory under its parent's physical path, as cab's managed roots are kept. */
function canonicalRoot(path: string): string {
  const resolved = resolve(path);
  return join(realpathSync(dirname(resolved)), basename(resolved));
}

/** Bounds how long an unchanged worktree may skip its Git identity read. */
const worktreeCheckReuseMs = 1_000;

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
