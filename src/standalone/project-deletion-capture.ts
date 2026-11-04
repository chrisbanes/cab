import {
  projectCleanupId as cleanupId,
  observeFilesystem as observed,
  type CapturedRepositoryIdentity,
} from "./project-cleanup-identities.js";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { runGit } from "./git-process.js";
import { assertCanonicalDirectoryPath } from "./data-directory.js";
import { claudeTemporaryBase } from "./claude.js";
import { repositoryBindingSchema, taskWorkspaceSchema } from "./workspaces.js";
import {
  projectCleanupSchema,
  type ProjectCleanup,
} from "./project-deletion.js";
import type { ProjectOwnership } from "./project-deletion-ownership.js";
import type { Database } from "../core/store.js";

export const deletionWorktreeStatusSchema = z
  .object({
    workspaceId: z.string().uuid(),
    kind: z.enum(["task", "drafting"]),
    dirty: z.enum(["yes", "no", "unknown"]),
    unpushed: z.enum(["yes", "no", "unknown"]),
    inspection: z.enum(["available", "absent", "unsafe", "unavailable"]),
  })
  .strict();
export type DeletionWorktreeStatus = z.output<
  typeof deletionWorktreeStatusSchema
>;
async function gitRead(
  cwd: string,
  args: string[],
  executable?: string,
  signal?: AbortSignal,
) {
  const result = await runGit({
    ...(executable ? { executable } : {}),
    ...(signal ? { signal } : {}),
    cwd,
    args: ["--no-optional-locks", "-C", cwd, ...args],
    timeoutMs: 10_000,
    terminationGraceMs: 1000,
    observationMs: 1000,
    maxOutputBytes: 1024 * 1024,
  });
  return result.status === "ok"
    ? result.stdout.toString("utf8").trim()
    : undefined;
}

async function captureGitIdentity(
  repository: z.output<typeof repositoryBindingSchema>,
  executable?: string,
  signal?: AbortSignal,
): Promise<CapturedRepositoryIdentity> {
  const root = await observed(repository.workspacePath);
  if (root.state === "absent")
    return { repositoryId: repository.repositoryId, state: "absent" };
  const unavailable = {
    repositoryId: repository.repositoryId,
    state: "unavailable" as const,
  };
  if (
    root.state !== "observed" ||
    !root.stat.isDirectory() ||
    root.stat.isSymbolicLink() ||
    !repository.gitCommonDir
  )
    return unavailable;
  const gitEntry = await observed(join(repository.workspacePath, ".git")),
    source = await observed(repository.sourcePath),
    common = await observed(repository.gitCommonDir);
  const directory = await gitRead(
    repository.workspacePath,
    ["rev-parse", "--absolute-git-dir"],
    executable,
    signal,
  );
  if (!directory || !isAbsolute(directory)) return unavailable;
  const gitDirectory = await observed(directory);
  if (
    gitEntry.state !== "observed" ||
    !gitEntry.stat.isFile() ||
    source.state !== "observed" ||
    common.state !== "observed" ||
    gitDirectory.state !== "observed"
  )
    return unavailable;
  return {
    repositoryId: repository.repositoryId,
    state: "observed",
    root: root.filesystem,
    gitEntry: gitEntry.filesystem,
    source: source.filesystem,
    commonDirectory: {
      path: repository.gitCommonDir,
      filesystem: common.filesystem,
    },
    gitDirectory: { path: directory, filesystem: gitDirectory.filesystem },
  };
}

/** Read-only preparation: never calls WorkspaceManager.get/recover or any provider. */
export async function captureDeletionCleanup(
  db: Database,
  owner: ProjectOwnership,
  roots: { task: string; drafting: string },
  gitExecutable?: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const items: ProjectCleanup["items"] = [],
    worktrees: DeletionWorktreeStatus[] = [],
    retiring: string[] = [];
  const boundPaths = new Set<string>();
  const work = new Set(owner.parameters.work as string[]),
    tasks = new Set(owner.parameters.tasks as string[]),
    drafts = new Set(owner.parameters.drafts as string[]);
  for (const [table, kind, managedRoot] of [
    ["task_workspace_bindings", "task", roots.task],
    ["drafting_workspace_bindings", "drafting", roots.drafting],
  ] as const) {
    for (const row of owner.rows[table] ?? []) {
      signal?.throwIfAborted();
      const binding = taskWorkspaceSchema
        .extend({ repositories: z.array(repositoryBindingSchema.strict()) })
        .strict()
        .parse({
          taskId: row.taskId,
          workspaceId: row.workspaceId,
          path: row.path,
          repositories: JSON.parse(String(row.repositories)),
          state: row.state,
          reason: row.reason,
          gitUncertain: row.gitUncertain === 1,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
      if (!isAbsolute(binding.path) || resolve(binding.path) !== binding.path)
        throw new Error("Workspace cleanup identity is malformed");
      for (const table of [
        "task_workspace_bindings",
        "drafting_workspace_bindings",
      ])
        for (const live of db
          .prepare(`SELECT taskId FROM ${table} WHERE path=?`)
          .all(binding.path) as { taskId: string }[])
          if (!tasks.has(live.taskId) && !drafts.has(live.taskId))
            throw new Error("Workspace cleanup has another owner");
      for (const live of db
        .prepare("SELECT workId FROM execution_intents WHERE workspace=?")
        .all(binding.path) as { workId: string }[])
        if (!work.has(live.workId))
          throw new Error("Workspace execution has another owner");
      boundPaths.add(binding.path);
      retiring.push(
        binding.path,
        ...binding.repositories.flatMap((r) => [
          r.sourcePath,
          r.workspacePath,
          ...(r.gitCommonDir ? [r.gitCommonDir] : []),
        ]),
      );
      for (const path of [
        binding.path,
        ...binding.repositories.flatMap((r) => [
          r.sourcePath,
          r.workspacePath,
          ...(r.gitCommonDir ? [r.gitCommonDir] : []),
        ]),
      ])
        try {
          retiring.push(await realpath(path));
        } catch {
          /* Preserve lexical spellings even when the path is gone. */
        }
      const gitIdentities: CapturedRepositoryIdentity[] = [];
      for (const repository of binding.repositories)
        gitIdentities.push(
          await captureGitIdentity(repository, gitExecutable, signal),
        );
      const id = cleanupId("workspace", binding.workspaceId),
        observation = await observed(binding.path);
      let inspection: DeletionWorktreeStatus["inspection"] =
        observation.state === "observed" ? "available" : observation.state;
      if (observation.state === "absent")
        items.push({ id, kind: "workspace", state: "complete" });
      else {
        let safe =
          observation.state === "observed" &&
          observation.stat.isDirectory() &&
          !observation.stat.isSymbolicLink() &&
          binding.path === join(managedRoot, binding.workspaceId);
        try {
          assertCanonicalDirectoryPath(managedRoot, "Managed workspace root");
          assertCanonicalDirectoryPath(binding.path, "Captured workspace");
          for (const repository of binding.repositories) {
            if (
              !repository.workspacePath.startsWith(binding.path + sep) ||
              !isAbsolute(repository.sourcePath)
            )
              safe = false;
            assertCanonicalDirectoryPath(
              repository.workspacePath,
              "Captured repository",
              "leaf",
            );
          }
        } catch {
          safe = false;
        }
        if (!safe && observation.state === "observed") inspection = "unsafe";
        items.push({
          id,
          kind: "workspace",
          state: "pending",
          reason:
            inspection === "unsafe"
              ? "unsafe"
              : inspection === "unavailable"
                ? "unavailable"
                : "not-attempted",
          captured: {
            kind: "workspace",
            binding,
            managedRoot,
            gitIdentities,
            filesystem:
              observation.state === "observed"
                ? observation.filesystem
                : { unavailable: true },
          },
        });
      }
      let dirty: DeletionWorktreeStatus["dirty"] = "unknown",
        unpushed: DeletionWorktreeStatus["unpushed"] = "unknown";
      if (inspection === "available" && binding.repositories.length) {
        const status: {
          dirty: DeletionWorktreeStatus["dirty"];
          unpushed: DeletionWorktreeStatus["unpushed"];
        }[] = [];
        for (const repository of binding.repositories) {
          const changes = await gitRead(
            repository.workspacePath,
            [
              "status",
              "--porcelain=v1",
              "--untracked-files=all",
              "--ignored=matching",
            ],
            gitExecutable,
            signal,
          );
          const ahead = await gitRead(
            repository.workspacePath,
            ["rev-list", "--count", "@{upstream}..HEAD"],
            gitExecutable,
            signal,
          );
          status.push({
            dirty:
              changes === undefined
                ? ("unknown" as const)
                : changes
                  ? ("yes" as const)
                  : ("no" as const),
            unpushed:
              ahead === undefined || !/^\d+$/.test(ahead)
                ? ("unknown" as const)
                : Number(ahead) > 0
                  ? ("yes" as const)
                  : ("no" as const),
          });
        }
        dirty = status.some((s) => s.dirty === "yes")
          ? "yes"
          : status.some((s) => s.dirty === "unknown")
            ? "unknown"
            : "no";
        unpushed = status.some((s) => s.unpushed === "yes")
          ? "yes"
          : status.some((s) => s.unpushed === "unknown")
            ? "unknown"
            : "no";
      }
      worktrees.push({
        workspaceId: binding.workspaceId,
        kind,
        dirty,
        unpushed,
        inspection,
      });
      const tempPath = claudeTemporaryBase(binding.path),
        tempId = cleanupId("claude-temp", binding.workspaceId),
        temp = await observed(tempPath);
      retiring.push(tempPath);
      let canonicalTemp: string | undefined;
      try {
        canonicalTemp = await realpath(tempPath);
        retiring.push(canonicalTemp);
      } catch {
        /* An unavailable identity stays pending. */
      }
      if (temp.state === "absent")
        items.push({ id: tempId, kind: "claude-temp", state: "complete" });
      else
        items.push({
          id: tempId,
          kind: "claude-temp",
          state: "pending",
          reason:
            temp.state === "unavailable"
              ? "unavailable"
              : !temp.stat.isDirectory() ||
                  temp.stat.isSymbolicLink() ||
                  temp.stat.uid !== process.getuid?.() ||
                  (temp.stat.mode & 0o777) !== 0o700
                ? "unsafe"
                : "not-attempted",
          captured: {
            kind: "claude-temp",
            path: tempPath,
            workspacePath: binding.path,
            ...(canonicalTemp ? { canonicalPath: canonicalTemp } : {}),
            taskId: binding.taskId,
            workspaceId: binding.workspaceId,
            filesystem:
              temp.state === "observed"
                ? temp.filesystem
                : { unavailable: true },
          },
        });
    }
  }
  // Historical execution can outlive a binding. Never lose a temp directory whose
  // workspace ownership cannot be proven from the retained binding descriptor.
  const historicalPaths = new Set<string>();
  for (const table of [
    "execution_intents",
    "turn_requests",
    "task_writer_admissions",
  ])
    for (const row of owner.rows[table] ?? []) {
      if (row.workspace === null || row.workspace === undefined) continue;
      if (
        typeof row.workspace !== "string" ||
        !isAbsolute(row.workspace) ||
        resolve(row.workspace) !== row.workspace
      )
        throw new Error("Historical workspace identity is malformed");
      historicalPaths.add(row.workspace);
    }
  for (const path of historicalPaths) {
    retiring.push(path);
    try {
      retiring.push(await realpath(path));
    } catch {
      /* Keep the exact recorded spelling. */
    }
    if (boundPaths.has(path)) continue;
    const tempPath = claudeTemporaryBase(path),
      temp = await observed(tempPath);
    retiring.push(tempPath);
    if (temp.state !== "absent")
      throw new Error(
        "Historical temporary workspace ownership is unavailable",
      );
    items.push({
      id: cleanupId("claude-temp-unbound", path),
      kind: "claude-temp",
      state: "complete",
    });
  }
  for (const threadId of owner.parameters.threads as string[]) {
    const qualification = db
      .prepare(
        "SELECT harness,codexHome FROM runtime_thread_qualification WHERE threadId=?",
      )
      .get(threadId) as
      | { harness: string; codexHome: string | null }
      | undefined;
    if (qualification?.harness === "codex" && qualification.codexHome === "cab")
      items.push({
        id: cleanupId("codex-thread", threadId),
        kind: "codex-thread",
        state: "pending",
        reason: "not-attempted",
        captured: {
          kind: "codex-thread",
          threadId,
          harness: "codex",
          codexHome: "cab",
        },
      });
  }
  signal?.throwIfAborted();
  // Cleanup IDs are stable across previews; statuses do not reserve outside worktree contents.
  return {
    cleanup: projectCleanupSchema.parse({ version: 1, items }),
    worktrees,
    retiring: [...new Set(retiring)].sort(),
  };
}
