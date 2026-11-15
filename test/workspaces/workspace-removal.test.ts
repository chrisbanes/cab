import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { WorkspaceLifecycleStore } from "../../src/core/workspace-lifecycle.js";
import { claudeTemporaryBase } from "../../src/standalone/claude.js";
import type { PushOutcome } from "../../src/standalone/git-push.js";
import {
  GitHubHttpDeliveryProvider,
  type PushFunction,
} from "../../src/standalone/github-delivery.js";
import type { TaskWorkspaceBinding } from "../../src/standalone/workspaces.js";
import { localBranchFetch } from "../fixtures/branch-fetch.js";
import { captureNativeResult } from "../fixtures/native-result.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { tmpdir } from "../fixtures/temp.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Removal",
      "-c",
      "user.email=removal@example.invalid",
      ...args,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    },
  ).trim();

/** The commit at `ref` in a bare remote, or null when the branch does not exist. */
const remoteRef = (remote: string, branch: string): string | null => {
  const read = spawnSync(
    "git",
    [
      "--git-dir",
      remote,
      "rev-parse",
      "--verify",
      "-q",
      `refs/heads/${branch}`,
    ],
    { encoding: "utf8" },
  );
  return read.status === 0 ? read.stdout.trim() : null;
};

const commitFile = (worktree: string, name: string, text = `${name}\n`) => {
  writeFileSync(join(worktree, name), text);
  git(worktree, "add", name);
  git(worktree, "commit", "--quiet", "-m", name);
  return git(worktree, "rev-parse", "HEAD");
};

/** The fake transport's hook: return an outcome to replace the real push. */
type PushHook = (
  request: Parameters<PushFunction>[0],
) => PushOutcome | undefined | Promise<PushOutcome | undefined>;

/**
 * A service with local tasks over real managed repositories, each with a disposable bare remote
 * standing in for the code host: the real GitHub provider reads refs from it through a fake API
 * and pushes to it with real Git.
 */
async function world(t: TestContext, repositoryCount = 1) {
  const root = mkdtempSync(join(tmpdir(), "cab-workspace-removal-"));
  const repositories = Array.from({ length: repositoryCount }, (_, index) => {
    const id = `R${index + 1}`;
    const source = join(root, `source-${index + 1}`);
    mkdirSync(source);
    git(source, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(source, ".gitignore"), "node_modules/\ndist\n");
    writeFileSync(join(source, "README.md"), `${id}\n`);
    git(source, "add", ".");
    git(source, "commit", "--quiet", "-m", "base");
    const remote = join(root, `remote-${index + 1}.git`);
    execFileSync("git", ["init", "--quiet", "--bare", remote]);
    return { id, name: `org/${id.toLowerCase()}`, source, remote };
  });
  const byName = new Map(repositories.map((r) => [r.name, r]));
  const byId = new Map(repositories.map((r) => [r.id, r]));
  const pushes: Array<{ repositoryId: string; commitSha: string }> = [];
  let hook: PushHook | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/graphql") {
      const { variables } = JSON.parse(String(init?.body)) as {
        variables: { id: string };
      };
      const repository = byId.get(variables.id);
      return Response.json({
        data: {
          node: repository && {
            id: repository.id,
            nameWithOwner: repository.name,
          },
        },
      });
    }
    const match = /^\/repos\/(org\/[^/]+)(?:\/git\/ref\/heads\/(.+))?$/.exec(
      url.pathname,
    );
    const repository = match && byName.get(match[1]!);
    if (!repository) throw new Error(`unexpected route ${url.pathname}`);
    if (match[2] === undefined)
      return Response.json({
        node_id: repository.id,
        full_name: repository.name,
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: false,
      });
    const branch = decodeURIComponent(match[2]);
    const head = remoteRef(repository.remote, branch);
    return head
      ? Response.json({ ref: `refs/heads/${branch}`, object: { sha: head } })
      : Response.json({ message: "Not Found" }, { status: 404 });
  };
  const push: PushFunction = async (request) => {
    const repository = byName.get(request.nameWithOwner);
    if (!repository) return "not-attempted";
    pushes.push({ repositoryId: repository.id, commitSha: request.commitSha });
    const replaced = await hook?.(request);
    if (replaced) return replaced;
    const head = remoteRef(repository.remote, request.branch);
    if (head === request.commitSha) return "up-to-date";
    if (head !== request.lease) return "rejected-lease";
    git(
      request.workspacePath,
      "push",
      "--quiet",
      repository.remote,
      `${request.commitSha}:refs/heads/${request.branch}`,
    );
    return "pushed";
  };
  // Each repository's target branch is its source checkout's `main`.
  const targets = new Map(
    repositories.map((r) => [r.name, localBranchFetch(r.source).fetchBranch]),
  );
  const provider = new GitHubHttpDeliveryProvider(
    "token",
    fetcher,
    push,
    undefined,
    "github.com",
    undefined,
    (request) => targets.get(request.nameWithOwner)!(request),
  );
  const f = await createOperatorFixture(null, undefined, {
    providerFactories: { github: () => provider },
  });
  t.after(async () => {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  });
  const domain = f.service.domain();
  const projectId = randomUUID();
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Removal",
    leadProfileId: null,
  });
  const grant = (
    grants: Array<{ repositoryId: string; mode: "allow" | "approval" }>,
  ) =>
    domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: f.service.delivery().configuration(projectId).version,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: grants.map((g) => ({ action: "branch.push", ...g })),
      requiredChecks: [],
    } as never);
  grant(repositories.map((r) => ({ repositoryId: r.id, mode: "allow" })));
  const finish = (taskId: string, state: "done" | "cancelled" = "done") =>
    domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      expectedVersion: Number(domain.task(taskId).version),
      state,
    });
  /** A local task with a ready workspace over every repository (or none). */
  const task = async (
    options: { title?: string; repositories?: boolean } = {},
  ) => {
    const taskId = randomUUID();
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title: options.title ?? "Remove workspace",
      outcome: "O",
    });
    const binding: TaskWorkspaceBinding = await f.service.provisionTask(
      taskId,
      options.repositories === false
        ? []
        : repositories.map((r) => ({
            repositoryId: r.id,
            path: r.source,
            ref: "main",
          })),
    );
    assert.equal(binding.state, "ready", binding.reason ?? "");
    const worktree = (index = 0) => binding.repositories[index]!.workspacePath;
    return { taskId, binding, worktree };
  };
  const branchOf = (taskId: string, repositoryId = "R1") =>
    f.service.delivery().taskBranch(taskId, repositoryId);
  const lifecycle = () =>
    new WorkspaceLifecycleStore(
      // biome-ignore lint/complexity/useLiteralKeys: the service's own database
      f.service["cache"]!,
    );
  const operations = (binding: TaskWorkspaceBinding) =>
    lifecycle().operations(binding);
  const archivalHeld = (taskId: string) =>
    f.service[
      // biome-ignore lint/complexity/useLiteralKeys: the service's own database
      "cache"
    ]!.prepare("SELECT 1 FROM task_archival_holds WHERE taskId=?").get(
      taskId,
    ) !== undefined;
  return {
    f,
    root,
    domain,
    projectId,
    repositories,
    pushes,
    setPushHook: (next: PushHook | undefined) => {
      hook = next;
    },
    grant,
    finish,
    task,
    branchOf,
    lifecycle,
    operations,
    archivalHeld,
    remove: (taskId: string, trigger: "manual" | "delivered" = "manual") =>
      f.service.removeTaskWorkspace(taskId, trigger),
  };
}

const gone = (binding: TaskWorkspaceBinding) => {
  assert.equal(existsSync(binding.path), false);
  for (const repository of binding.repositories) {
    assert.equal(existsSync(repository.workspacePath), false);
    assert.equal(
      git(repository.gitCommonDir!, "worktree", "list", "--porcelain").includes(
        repository.workspacePath,
      ),
      false,
    );
  }
};

test("a done or cancelled task's clean workspace is removed with its Claude base, once", async (t) => {
  const w = await world(t);
  for (const state of ["done", "cancelled"] as const) {
    const { taskId, binding } = await w.task();
    const base = claudeTemporaryBase(binding.path);
    mkdirSync(base, { mode: 0o700 });
    writeFileSync(join(binding.path, "evidence.txt"), "root file\n");
    w.finish(taskId, state);
    const removed = await w.remove(taskId, "delivered");
    assert.equal(removed.outcome, "cleaned", JSON.stringify(removed));
    if (removed.outcome !== "cleaned") return;
    assert.equal(removed.binding.state, "archived");
    gone(binding);
    assert.equal(existsSync(base), false);
    assert.equal(removed.operation.trigger, "delivered");
    assert.deepEqual(removed.operation.repositories, [
      {
        kind: "base",
        repositoryId: "R1",
        branch: "main",
        commit: binding.repositories[0]!.commit,
        noTaskCommits: true,
      },
    ]);
    assert.deepEqual(
      removed.operation.effects.map((e) => [e.target.kind, e.outcome]),
      [
        ["repository", "succeeded"],
        ["root", "succeeded"],
        ["claude-base", "succeeded"],
      ],
    );
    assert.equal(w.archivalHeld(taskId), false);
    assert.equal(w.pushes.length, 0);
    // A response lost after completion: the replay returns the original record and touches nothing.
    const replay = await w.remove(taskId);
    assert.deepEqual(replay, removed);
  }
});

test("a repository-free workspace is removed with its root files", async (t) => {
  const w = await world(t);
  const { taskId, binding } = await w.task({ repositories: false });
  writeFileSync(join(binding.path, "summary.md"), "result\n");
  w.finish(taskId, "cancelled");
  const removed = await w.remove(taskId);
  assert.equal(removed.outcome, "cleaned", JSON.stringify(removed));
  assert.equal(existsSync(binding.path), false);
  assert.deepEqual(
    removed.outcome === "cleaned" && removed.operation.repositories,
    [],
  );
});

test("ignored build output alone does not block removal", async (t) => {
  const w = await world(t);
  const { taskId, binding, worktree } = await w.task();
  mkdirSync(join(worktree(), "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(worktree(), "node_modules", "pkg", "index.js"), "x\n");
  writeFileSync(join(worktree(), "dist"), "build\n");
  writeFileSync(join(binding.path, "scratch", "cache.bin"), "cache\n");
  w.finish(taskId);
  const removed = await w.remove(taskId);
  assert.equal(removed.outcome, "cleaned", JSON.stringify(removed));
  gone(binding);
});

test("each unsafe state refuses removal by name and deletes nothing", async (t) => {
  const w = await world(t);
  const refused = async (
    prepare: (task: Awaited<ReturnType<typeof w.task>>) => void | Promise<void>,
    reason: RegExp,
    terminal = true,
  ) => {
    const task = await w.task();
    if (terminal) w.finish(task.taskId);
    await prepare(task);
    const result = await w.remove(task.taskId);
    assert.equal(result.outcome, "retained");
    assert.match(result.outcome === "retained" ? result.reason : "", reason);
    assert.equal(existsSync(task.worktree()), true);
    assert.equal(result.binding.state, "ready");
    assert.equal(w.archivalHeld(task.taskId), false);
    return task;
  };
  await refused(() => {}, /Only a done or cancelled task/, false);
  await refused(
    ({ taskId }) =>
      w.f.seedPersistedState((db) =>
        db
          .prepare(
            "INSERT INTO task_writer_holds (taskId, reason) VALUES (?, ?)",
          )
          .run(taskId, "writer"),
      ),
    /Task execution is not settled/,
  );
  await refused(
    ({ worktree }) => writeFileSync(join(worktree(), "README.md"), "edited\n"),
    /Uncommitted work remains in R1/,
  );
  await refused(({ worktree }) => {
    writeFileSync(join(worktree(), "README.md"), "staged\n");
    git(worktree(), "add", "README.md");
  }, /Uncommitted work remains in R1/);
  await refused(
    ({ worktree }) => rmSync(join(worktree(), "README.md")),
    /Uncommitted work remains in R1/,
  );
  await refused(
    ({ worktree }) => writeFileSync(join(worktree(), "notes.txt"), "new\n"),
    /Uncommitted work remains in R1/,
  );
  // Committed work whose push the policy refuses stays, with the delivery's reason.
  w.grant([]);
  const unpushed = await refused(
    ({ worktree }) => void commitFile(worktree(), "work.txt"),
    /Pushing R1 to its task branch was refused: External action denied by project policy/,
  );
  assert.equal(w.pushes.length, 0);
  assert.equal(
    w
      .operations(unpushed.binding)
      .map((o) => o.state)
      .join(),
    "refused",
  );
});

test("a recorded dirty result refuses removal until its work is committed", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const native = await captureNativeResult(f, { repository: true });
  rmSync(native.textPath);
  const domain = f.service.domain();
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: native.seeded.projectId,
    taskId: native.seeded.taskId,
    expectedVersion: Number(domain.task(native.seeded.taskId).version),
    state: "done",
  });
  const result = await f.service.removeTaskWorkspace(
    native.seeded.taskId,
    "manual",
  );
  assert.equal(
    result.outcome === "retained" && result.reason,
    `Result ${native.resultId} recorded uncommitted changes in R1 that are neither committed nor delivered; commit or deliver them, or reset the task to discard them`,
  );
  assert.equal(existsSync(native.worktree), true);
});

test("committed work is pushed to the task branch before the workspace is removed", async (t) => {
  const w = await world(t);
  const { taskId, binding, worktree } = await w.task();
  const head = commitFile(worktree(), "work.txt");
  w.finish(taskId);
  const removed = await w.remove(taskId);
  assert.equal(removed.outcome, "cleaned", JSON.stringify(removed));
  const branch = w.branchOf(taskId)!;
  assert.equal(remoteRef(w.repositories[0]!.remote, branch.branch), head);
  assert.equal(branch.lastPushedSha, head);
  assert.deepEqual(w.pushes, [{ repositoryId: "R1", commitSha: head }]);
  assert.deepEqual(
    removed.outcome === "cleaned" && removed.operation.repositories,
    [
      {
        kind: "pushed",
        repositoryId: "R1",
        branch: branch.branch,
        commit: head,
      },
    ],
  );
  gone(binding);
  // The push is the removal's: it is recorded without restarting the delivered clock.
  const generation = w.lifecycle().get(binding.workspaceId)!;
  assert.equal(generation.lastPushAt, null);
  assert.equal(generation.repositoryClocks[0]!.pushedCommit, head);
  // The delivery read names the push as the service's.
  assert.equal(
    w.f.service
      .delivery()
      .actions(taskId)
      .every((a) => a.state === "confirmed-success"),
    true,
  );
});

test("a branch changed outside cab refuses the push and every later removal", async (t) => {
  const w = await world(t);
  const { taskId, worktree } = await w.task({ title: "Outside" });
  commitFile(worktree(), "work.txt");
  w.finish(taskId);
  const branch = `cab/${taskId.replaceAll("-", "").slice(0, 8)}-outside`;
  const outside = git(w.repositories[0]!.source, "rev-parse", "HEAD");
  git(
    w.repositories[0]!.source,
    "push",
    "--quiet",
    w.repositories[0]!.remote,
    `${outside}:refs/heads/${branch}`,
  );
  const first = await w.remove(taskId);
  assert.match(
    first.outcome === "retained" ? first.reason : "",
    /Pushing R1 to its task branch was refused: branch-outside-change/,
  );
  assert.equal(remoteRef(w.repositories[0]!.remote, branch), outside);
  const again = await w.remove(taskId);
  assert.match(
    again.outcome === "retained" ? again.reason : "",
    /The task branch of R1 changed outside cab/,
  );
  assert.equal(existsSync(worktree()), true);
});

test("removal never widens delivery authority: approval grants and target conflicts refuse", async (t) => {
  const w = await world(t);
  w.grant([{ repositoryId: "R1", mode: "approval" }]);
  const gated = await w.task();
  commitFile(gated.worktree(), "work.txt");
  w.finish(gated.taskId);
  const approval = await w.remove(gated.taskId);
  assert.match(
    approval.outcome === "retained" ? approval.reason : "",
    /Pushing R1 to its task branch was refused: Exact material approval required/,
  );
  assert.equal(w.pushes.length, 0);
  assert.equal(existsSync(gated.worktree()), true);

  w.grant([{ repositoryId: "R1", mode: "allow" }]);
  const conflicted = await w.task();
  commitFile(conflicted.worktree(), "README.md", "task side\n");
  commitFile(w.repositories[0]!.source, "README.md", "target side\n");
  w.finish(conflicted.taskId);
  const conflict = await w.remove(conflicted.taskId);
  assert.match(
    conflict.outcome === "retained" ? conflict.reason : "",
    /Pushing R1 to its task branch was refused: publication-target-conflict/,
  );
  assert.equal(w.pushes.length, 0);
  assert.equal(
    remoteRef(w.repositories[0]!.remote, w.branchOf(conflicted.taskId)!.branch),
    null,
  );
  assert.equal(existsSync(conflicted.worktree()), true);
});

test("a partial multi-repository push keeps both worktrees and is not pushed again", async (t) => {
  const w = await world(t, 2);
  w.grant([{ repositoryId: "R1", mode: "allow" }]);
  const { taskId, binding, worktree } = await w.task();
  const first = commitFile(worktree(0), "one.txt");
  const second = commitFile(worktree(1), "two.txt");
  w.finish(taskId);
  const partial = await w.remove(taskId);
  assert.match(
    partial.outcome === "retained" ? partial.reason : "",
    /Pushing R2 to its task branch was refused/,
  );
  assert.equal(existsSync(worktree(0)), true);
  assert.equal(existsSync(worktree(1)), true);
  assert.equal(
    remoteRef(w.repositories[0]!.remote, w.branchOf(taskId, "R1")!.branch),
    first,
  );
  const [attempt] = w.operations(binding);
  assert.equal(attempt?.state, "refused");
  assert.equal(
    w.lifecycle().get(binding.workspaceId)!.repositoryClocks[0]!.pushedCommit,
    first,
  );

  w.grant([
    { repositoryId: "R1", mode: "allow" },
    { repositoryId: "R2", mode: "allow" },
  ]);
  const replay = await w.remove(taskId);
  assert.equal(replay.outcome, "cleaned", JSON.stringify(replay));
  assert.deepEqual(w.pushes, [
    { repositoryId: "R1", commitSha: first },
    { repositoryId: "R2", commitSha: second },
  ]);
  gone(binding);
});

test("removal proves ancestry from commit objects, not from refs or a forged graph", async (t) => {
  const w = await world(t);
  /** Records `commit` as the task branch's last push, as a prior delivery would have. */
  const pushedBefore = (taskId: string, commit: string) => {
    const branch = `cab/${randomUUID()}`;
    w.f.seedPersistedState((db) =>
      db
        .prepare(
          "INSERT INTO delivery_task_branches (taskId,repositoryId,branch,lastPushedSha,outsideHeadSha,assignedAt) VALUES (?,?,?,?,NULL,1)",
        )
        .run(taskId, "R1", branch, commit),
    );
    return branch;
  };

  // HEAD moved back to an ancestor of the last push: everything is already on the branch.
  const behind = await w.task();
  const older = commitFile(behind.worktree(), "a.txt");
  const newer = commitFile(behind.worktree(), "b.txt");
  const branch = pushedBefore(behind.taskId, newer);
  git(behind.worktree(), "reset", "--quiet", "--hard", older);
  w.finish(behind.taskId);
  const removed = await w.remove(behind.taskId);
  assert.deepEqual(
    removed.outcome === "cleaned" && removed.operation.repositories,
    [{ kind: "pushed", repositoryId: "R1", branch, commit: newer }],
  );
  assert.equal(w.pushes.length, 0);

  // A rewritten commit has diverged from the last push.
  const diverged = await w.task();
  const pushed = commitFile(diverged.worktree(), "a.txt");
  pushedBefore(diverged.taskId, pushed);
  git(diverged.worktree(), "commit", "--quiet", "--amend", "-m", "rewritten");
  w.finish(diverged.taskId);
  const divergent = await w.remove(diverged.taskId);
  assert.match(
    divergent.outcome === "retained" ? divergent.reason : "",
    /The history of R1 does not provably follow its last push or provisioned base/,
  );

  // A graft that makes HEAD look like an ancestor of the last push proves nothing.
  const forged = await w.task();
  const claimed = commitFile(forged.worktree(), "a.txt");
  pushedBefore(forged.taskId, claimed);
  git(forged.worktree(), "reset", "--quiet", "--hard", "HEAD~1");
  const real = commitFile(forged.worktree(), "other.txt");
  git(forged.worktree(), "replace", "--graft", claimed, real);
  git(forged.worktree(), "merge-base", "--is-ancestor", real, claimed);
  w.finish(forged.taskId);
  const refused = await w.remove(forged.taskId);
  assert.match(
    refused.outcome === "retained" ? refused.reason : "",
    /The history of R1 does not provably follow/,
  );
  assert.equal(existsSync(forged.worktree()), true);
  assert.equal(w.pushes.length, 0);
});

test("a writer or a replaced root found at the final check keeps the workspace", async (t) => {
  const w = await world(t);
  const writer = await w.task();
  commitFile(writer.worktree(), "work.txt");
  w.finish(writer.taskId);
  w.setPushHook(() => {
    w.f.seedPersistedState((db) =>
      db
        .prepare("INSERT INTO task_writer_holds (taskId, reason) VALUES (?, ?)")
        .run(writer.taskId, "late writer"),
    );
    return undefined;
  });
  const late = await w.remove(writer.taskId);
  assert.match(
    late.outcome === "retained" ? late.reason : "",
    /Task execution is not settled/,
  );
  assert.equal(existsSync(writer.worktree()), true);
  assert.equal(w.operations(writer.binding).at(-1)?.state, "refused");

  const replaced = await w.task();
  commitFile(replaced.worktree(), "work.txt");
  w.finish(replaced.taskId);
  const moved = join(w.root, "moved-root");
  w.setPushHook(() => {
    renameSync(replaced.binding.path, moved);
    symlinkSync(moved, replaced.binding.path);
    return undefined;
  });
  const swapped = await w.remove(replaced.taskId);
  w.setPushHook(undefined);
  assert.equal(swapped.outcome, "retained");
  assert.equal(existsSync(join(moved, "repo-1", "work.txt")), true);
  assert.equal(existsSync(join(moved, "scratch")), true);
});

test("a partly removed workspace stays held with its journal across a restart", async (t) => {
  const w = await world(t, 2);
  const { taskId, binding, worktree } = await w.task();
  // Git refuses to remove a locked worktree without --force, which removal never passes.
  git(binding.repositories[1]!.gitCommonDir!, "worktree", "lock", worktree(1));
  w.finish(taskId);
  const held = await w.remove(taskId);
  assert.equal(held.outcome, "retained");
  assert.equal(held.binding.state, "held");
  assert.equal(existsSync(worktree(0)), false);
  assert.equal(existsSync(worktree(1)), true);
  const [operation] = w.operations(binding);
  assert.equal(operation?.state, "held");
  assert.deepEqual(
    operation?.effects.map((e) => e.outcome),
    ["succeeded", "failed"],
  );
  assert.equal(w.archivalHeld(taskId), true);

  await w.f.reopen();
  assert.equal(w.archivalHeld(taskId), true);
  const again = await w.remove(taskId);
  assert.equal(again.outcome, "retained");
  assert.equal(existsSync(worktree(1)), true);
  assert.equal(w.operations(binding).length, 1);
});

test("a Claude base that cannot be released holds the removal after the root is gone", async (t) => {
  const w = await world(t);
  const { taskId, binding } = await w.task();
  const base = claudeTemporaryBase(binding.path);
  mkdirSync(base);
  chmodSync(base, 0o755);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  w.finish(taskId);
  const held = await w.remove(taskId);
  assert.equal(held.outcome, "retained");
  assert.match(
    held.outcome === "retained" ? held.reason : "",
    /claude-base is still present/,
  );
  assert.equal(existsSync(binding.path), false);
  assert.equal(existsSync(base), true);
  assert.equal(held.binding.state, "held");
  const [operation] = w.operations(binding);
  assert.equal(operation?.state, "held");
  assert.equal(operation?.completedAt, null);
  assert.equal(w.archivalHeld(taskId), true);
});

test("an interrupted removal journal is held after restart and nothing more is deleted", async (t) => {
  const w = await world(t);
  const { taskId, binding, worktree } = await w.task();
  w.finish(taskId);
  const operationId = randomUUID();
  // A crash after the first destructive effect was journaled but before it settled.
  w.f.seedPersistedState((db) => {
    const lifecycle = new WorkspaceLifecycleStore(db as never);
    const owner = { taskId, workspaceId: binding.workspaceId };
    lifecycle.beginOperation(owner, {
      operationId,
      kind: "remove",
      trigger: "manual",
      startedAt: Date.now(),
    });
    lifecycle.startEffect(owner, operationId, {
      effectId: randomUUID(),
      target: { kind: "repository", repositoryId: "R1" },
      startedAt: Date.now(),
    });
    db.prepare(
      "UPDATE task_workspace_bindings SET state='archiving' WHERE taskId=?",
    ).run(taskId);
    db.prepare(
      "INSERT INTO task_archival_holds (taskId, reason, ownerToken) VALUES (?, 'Task archival in progress', ?)",
    ).run(taskId, operationId);
  });
  await w.f.reopen();
  const [operation] = w.operations(binding);
  assert.equal(operation?.state, "held");
  assert.equal(operation?.effects[0]?.settledAt, null);
  assert.equal(w.archivalHeld(taskId), true);
  const again = await w.remove(taskId);
  assert.equal(again.outcome, "retained");
  assert.equal(again.binding.state, "held");
  assert.equal(existsSync(worktree()), true);
  assert.equal(w.operations(binding).length, 1);
});

test("a tokenless archival hold from an earlier build stays held and refuses removal", async (t) => {
  const w = await world(t);
  const { taskId, worktree } = await w.task();
  w.finish(taskId);
  w.f.seedPersistedState((db) =>
    db
      .prepare("INSERT INTO task_archival_holds (taskId, reason) VALUES (?, ?)")
      .run(taskId, "Task archival in progress"),
  );
  const refused = await w.remove(taskId);
  assert.match(
    refused.outcome === "retained" ? refused.reason : "",
    /Task execution is not settled or its workspace is held/,
  );
  assert.equal(w.archivalHeld(taskId), true);
  // A restart cannot prove who owns it either, so it stays.
  await w.f.reopen();
  assert.equal(w.archivalHeld(taskId), true);
  const again = await w.remove(taskId);
  assert.equal(again.outcome, "retained");
  assert.equal(existsSync(worktree()), true);
});

test("a removal interrupted before any deletion is refused at restart and releases its hold", async (t) => {
  const w = await world(t);
  const { taskId, binding } = await w.task();
  w.finish(taskId);
  const operationId = randomUUID();
  // A crash during the push window: the operation began, nothing was deleted.
  w.f.seedPersistedState((db) => {
    new WorkspaceLifecycleStore(db as never).beginOperation(
      { taskId, workspaceId: binding.workspaceId },
      {
        operationId,
        kind: "remove",
        trigger: "manual",
        startedAt: Date.now(),
      },
    );
    db.prepare(
      "INSERT INTO task_archival_holds (taskId, reason, ownerToken) VALUES (?, 'Task archival in progress', ?)",
    ).run(taskId, operationId);
  });
  await w.f.reopen();
  const [operation] = w.operations(binding);
  assert.equal(operation?.state, "refused");
  assert.match(operation?.reason ?? "", /interrupted before any deletion/);
  assert.equal(w.archivalHeld(taskId), false);
  assert.equal(w.f.service.taskHold(taskId), undefined);
  const removed = await w.remove(taskId);
  assert.equal(removed.outcome, "cleaned", JSON.stringify(removed));
});

test("a push with an unknown outcome refuses removal until delivery settles it", async (t) => {
  const w = await world(t);
  const { taskId, binding, worktree } = await w.task();
  commitFile(worktree(), "work.txt");
  w.finish(taskId);
  w.setPushHook(() => "uncertain");
  const first = await w.remove(taskId);
  w.setPushHook(undefined);
  assert.match(
    first.outcome === "retained" ? first.reason : "",
    /Pushing R1 to its task branch was refused/,
  );
  assert.equal(w.operations(binding).at(-1)?.state, "refused");
  assert.equal(w.archivalHeld(taskId), false);
  const second = await w.remove(taskId);
  assert.match(
    second.outcome === "retained" ? second.reason : "",
    /delivery actions whose outcome is not settled/,
  );
  assert.equal(w.pushes.length, 1);
  assert.equal(existsSync(worktree()), true);
});

test("a repository whose status Git cannot read refuses removal and deletes nothing", async (t) => {
  const w = await world(t);
  const { taskId, binding, worktree } = await w.task();
  w.finish(taskId);
  writeFileSync(
    join(binding.repositories[0]!.gitDirectory!, "index"),
    "not an index",
  );
  const refused = await w.remove(taskId);
  assert.equal(refused.outcome, "retained", JSON.stringify(refused));
  assert.equal(
    refused.outcome === "retained" && refused.reason,
    "Git could not read the status or HEAD of R1",
  );
  assert.equal(existsSync(worktree()), true);
  assert.equal(existsSync(join(worktree(), "README.md")), true);
  assert.equal(w.operations(binding).length, 0);
});
