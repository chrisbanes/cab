import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { WorkspaceLifecycleStore } from "../../src/core/workspace-lifecycle.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
} from "../../src/standalone/codex.js";
import {
  type RuntimeSpawnContext,
  StandaloneService,
} from "../../src/standalone/service.js";
import {
  ignoredTrimPaths,
  unlinkIgnored,
} from "../../src/standalone/workspace-trim.js";
import {
  SqliteWorkspaceBindingStore,
  taskScratchPath,
  type WorkspaceManagerOptions,
  WorkspaceManager,
} from "../../src/standalone/workspaces.js";
import { controlledGit } from "../fixtures/controlled-git.js";
import { coordinationFixture } from "../fixtures/coordination.js";
import { processIdentityDenied } from "../fixtures/host-access.js";
import { tmpdir } from "../fixtures/temp.js";

const taskA = "20000000-0000-4000-8000-000000000001";
const taskB = "20000000-0000-4000-8000-000000000002";
const newline = "new\nline.log";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function write(path: string, contents = "x"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function source(root: string, name: string, ignore: string): string {
  const path = join(root, name);
  mkdirSync(path);
  git(path, "init", "--quiet");
  git(path, "config", "user.name", "Trim Test");
  git(path, "config", "user.email", "trim-test@example.invalid");
  write(join(path, "README.md"), name);
  write(join(path, ".gitignore"), ignore);
  git(path, "add", "README.md", ".gitignore");
  return path;
}

function commit(path: string): void {
  git(path, "commit", "--quiet", "-m", "initial");
}

/** Every entry under `root`, not following links; a link shows only that it is one. */
function tree(root: string): string[] {
  const entries: string[] = [];
  const walk = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) entries.push(`${relative} -> link`);
      else if (info.isDirectory()) {
        entries.push(`${relative}/`);
        walk(path, relative);
      } else entries.push(relative);
    }
  };
  walk(root, "");
  return entries;
}

function fixture() {
  const coordination = coordinationFixture();
  // The fixture's bound work has finished, so each task's execution is settled.
  coordination.db.exec("UPDATE execution_intents SET state = 'completed'");
  const root = mkdtempSync(join(tmpdir(), "cab-workspace-trim-"));
  const bindings = new SqliteWorkspaceBindingStore(coordination.db);
  const workspaceRoot = join(root, "task-workspaces");
  const outside = join(root, "outside");
  write(join(outside, "sentinel.txt"), "outside");
  write(join(outside, "a.o"), "outside object");
  const managers: WorkspaceManager[] = [];
  return {
    root,
    outside,
    db: coordination.db,
    state: coordination.state,
    lifecycle: new WorkspaceLifecycleStore(coordination.db),
    manager(options: WorkspaceManagerOptions = {}) {
      const manager = new WorkspaceManager(bindings, workspaceRoot, options);
      managers.push(manager);
      return manager;
    },
    close() {
      for (const manager of managers) manager.cancelGitWork();
      coordination.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Two real repositories and root, evidence, cache and scratch files around them. */
async function populated(
  f: ReturnType<typeof fixture>,
  manager: WorkspaceManager,
) {
  const a = source(f.root, "source-a", "ignored/\n*.log\nbuild/\n");
  write(join(a, "ignored", "tracked.txt"), "tracked under an ignored parent");
  git(a, "add", "--force", "ignored/tracked.txt");
  commit(a);
  const b = source(f.root, "source-b", "node_modules/\ndist\n.env\n");
  commit(b);
  const binding = await manager.provision(taskA, [
    { repositoryId: "repo-a", path: a },
    { repositoryId: "repo-b", path: b },
  ]);
  assert.equal(binding.state, "ready");
  const [repoA, repoB] = binding.repositories.map((r) => r.workspacePath) as [
    string,
    string,
  ];
  write(join(repoA, "ignored", "a.o"));
  write(join(repoA, "ignored", "deep", "b.o"));
  symlinkSync(f.outside, join(repoA, "ignored", "escape"));
  write(join(repoA, "build", "with space", "out file.bin"));
  write(join(repoA, "src", newline));
  write(join(repoA, "src", "untracked.txt"), "keep");
  symlinkSync(join(f.outside, "sentinel.txt"), join(repoA, "link.log"));
  symlinkSync(f.outside, join(repoA, "linkdir.log"));
  write(join(repoB, "node_modules", "pkg", "index.js"));
  mkdirSync(join(repoB, "node_modules", ".bin"));
  symlinkSync(
    join(f.outside, "sentinel.txt"),
    join(repoB, "node_modules", ".bin", "tool"),
  );
  write(join(repoB, "dist", "app.js"));
  write(join(repoB, ".env"), "TOKEN=fixture");
  write(join(repoB, "notes draft.md"), "keep");
  write(join(binding.path, "evidence", "report.md"), "evidence");
  write(join(binding.path, "tmp", "cache.bin"));
  write(join(binding.path, "npm-cache", "_cacache", "index"));
  write(join(binding.path, "notes.txt"), "root file");
  const scratch = taskScratchPath(binding.path);
  write(join(scratch, "a.txt"));
  write(join(scratch, "sub", "b.txt"));
  symlinkSync(f.outside, join(scratch, "out"));
  return { binding, repoA, repoB, scratch };
}

const repoAAfter = [
  ".git",
  ".gitignore",
  "README.md",
  "ignored/",
  "ignored/tracked.txt",
  "src/",
  "src/untracked.txt",
];
const repoBAfter = [".git", ".gitignore", "README.md", "notes draft.md"];
const rootAfter = [
  "evidence/",
  "evidence/report.md",
  "notes.txt",
  "npm-cache/",
  "npm-cache/_cacache/",
  "npm-cache/_cacache/index",
  "repo-1/",
  ...repoAAfter.map((p) => `repo-1/${p}`),
  "repo-2/",
  ...repoBAfter.map((p) => `repo-2/${p}`),
  "scratch/",
  "tmp/",
  "tmp/cache.bin",
];

/** Ownership as the service grants it: the archival lease, then a hook at each recheck. */
function lease(
  f: ReturnType<typeof fixture>,
  taskId: string,
  atCall?: (call: number) => void,
) {
  assert.equal(f.state.beginArchive(taskId), true);
  let calls = 0;
  return () => {
    atCall?.(++calls);
    return f.state.confirmArchive(taskId);
  };
}

test("trimming deletes exactly ignored files and scratch contents in two repositories", async () => {
  const f = fixture();
  try {
    const manager = f.manager();
    const { binding, repoA, scratch } = await populated(f, manager);
    const outsideBefore = tree(f.outside);
    assert.deepEqual(tree(binding.path), [
      "evidence/",
      "evidence/report.md",
      "notes.txt",
      "npm-cache/",
      "npm-cache/_cacache/",
      "npm-cache/_cacache/index",
      "repo-1/",
      "repo-1/.git",
      "repo-1/.gitignore",
      "repo-1/README.md",
      "repo-1/build/",
      "repo-1/build/with space/",
      "repo-1/build/with space/out file.bin",
      "repo-1/ignored/",
      "repo-1/ignored/a.o",
      "repo-1/ignored/deep/",
      "repo-1/ignored/deep/b.o",
      "repo-1/ignored/escape -> link",
      "repo-1/ignored/tracked.txt",
      "repo-1/link.log -> link",
      "repo-1/linkdir.log -> link",
      "repo-1/src/",
      `repo-1/src/${newline}`,
      "repo-1/src/untracked.txt",
      "repo-2/",
      "repo-2/.env",
      "repo-2/.git",
      "repo-2/.gitignore",
      "repo-2/README.md",
      "repo-2/dist/",
      "repo-2/dist/app.js",
      "repo-2/node_modules/",
      "repo-2/node_modules/.bin/",
      "repo-2/node_modules/.bin/tool -> link",
      "repo-2/node_modules/pkg/",
      "repo-2/node_modules/pkg/index.js",
      "repo-2/notes draft.md",
      "scratch/",
      "scratch/a.txt",
      "scratch/out -> link",
      "scratch/sub/",
      "scratch/sub/b.txt",
      "tmp/",
      "tmp/cache.bin",
    ]);

    const result = await manager.trim(
      taskA,
      "idle",
      f.lifecycle,
      lease(f, taskA),
    );
    assert.equal(result.outcome, "trimmed");
    assert.deepEqual(tree(binding.path), rootAfter);
    assert.ok(lstatSync(scratch).isDirectory());
    assert.deepEqual(tree(f.outside), outsideBefore);
    assert.equal(
      readFileSync(join(f.outside, "sentinel.txt"), "utf8"),
      "outside",
    );
    assert.equal(
      readFileSync(join(repoA, "ignored", "tracked.txt"), "utf8"),
      "tracked under an ignored parent",
    );
    assert.equal(
      git(repoA, "status", "--porcelain=v1", "--untracked-files=all"),
      "?? src/untracked.txt\n",
    );

    const operations = f.lifecycle.operations({
      taskId: taskA,
      workspaceId: binding.workspaceId,
    });
    assert.equal(operations.length, 1);
    const [operation] = operations;
    assert.equal(operation?.state, "completed");
    assert.equal(operation?.trigger, "idle");
    assert.deepEqual(
      operation?.effects.map((e) => [e.target, e.outcome]),
      [
        [{ kind: "repository", repositoryId: "repo-a" }, "succeeded"],
        [{ kind: "repository", repositoryId: "repo-b" }, "succeeded"],
        [{ kind: "scratch" }, "succeeded"],
      ],
    );
    assert.ok(operation?.completedAt);
    assert.ok(
      operation.effects.every((e) => e.settledAt! <= operation.completedAt!),
    );
  } finally {
    f.close();
  }
});

test("a repository-free workspace trims only its scratch contents", async () => {
  const f = fixture();
  try {
    const manager = f.manager();
    const binding = await manager.provision(taskB);
    const scratch = taskScratchPath(binding.path);
    write(join(scratch, "deep", "file"));
    symlinkSync(f.outside, join(scratch, "outside"));
    write(join(binding.path, "evidence", "kept.md"));
    const result = await manager.trim(
      taskB,
      "manual",
      f.lifecycle,
      lease(f, taskB),
    );
    assert.equal(result.outcome, "trimmed");
    assert.deepEqual(tree(binding.path), [
      "evidence/",
      "evidence/kept.md",
      "scratch/",
    ]);
    assert.deepEqual(tree(f.outside), ["a.o", "sentinel.txt"]);
  } finally {
    f.close();
  }
});

test("a nested repository or submodule refuses that repository's trim and deletes nothing", async () => {
  const f = fixture();
  try {
    const manager = f.manager();
    const { binding, repoA } = await populated(f, manager);
    mkdirSync(join(repoA, "ignored", "vendor"));
    git(join(repoA, "ignored", "vendor"), "init", "--quiet");
    write(join(repoA, "ignored", "vendor", "kept.c"));
    const before = tree(binding.path);
    const nested = await manager.trim(
      taskA,
      "manual",
      f.lifecycle,
      lease(f, taskA),
    );
    assert.deepEqual(
      nested.outcome === "refused" && nested.reason,
      "Trimming repo-a is refused: it contains a nested Git repository",
    );
    assert.deepEqual(tree(binding.path), before);
    f.state.endArchive(taskA);

    const submodule = source(f.root, "source-sub", "*.o\n");
    commit(submodule);
    const parent = source(f.root, "source-parent", "*.o\n");
    execFileSync("git", [
      "-C",
      parent,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      submodule,
      "sub",
    ]);
    commit(parent);
    const withSubmodule = await manager.provision(taskB, [
      { repositoryId: "parent", path: parent },
    ]);
    write(join(withSubmodule.path, "repo-1", "kept.o"));
    const refused = await manager.trim(
      taskB,
      "manual",
      f.lifecycle,
      lease(f, taskB),
    );
    assert.equal(
      refused.outcome === "refused" && refused.reason,
      "Trimming parent is refused: it contains a Git submodule",
    );
    assert.ok(existsSync(join(withSubmodule.path, "repo-1", "kept.o")));
    assert.equal(
      f.lifecycle.operations({
        taskId: taskB,
        workspaceId: withSubmodule.workspaceId,
      }).length,
      0,
    );
  } finally {
    f.close();
  }
});

test("an unsettled lease at the start refuses without journaling or deleting", async () => {
  const f = fixture();
  try {
    const manager = f.manager();
    const { binding } = await populated(f, manager);
    const before = tree(binding.path);
    f.db
      .prepare("INSERT INTO task_writer_holds (taskId, reason) VALUES (?, ?)")
      .run(taskA, "writer");
    assert.equal(f.state.beginArchive(taskA), false);
    const result = await manager.trim(taskA, "manual", f.lifecycle, () =>
      f.state.confirmArchive(taskA),
    );
    assert.deepEqual(
      result.outcome === "refused" && result.reason,
      "Task execution is not settled",
    );
    assert.deepEqual(tree(binding.path), before);
    assert.equal(
      f.lifecycle.operations({
        taskId: taskA,
        workspaceId: binding.workspaceId,
      }).length,
      0,
    );
  } finally {
    f.close();
  }
});

/** Rechecks: 1 start, 2 after scanning, 3 before repo-a, 4 before repo-b, 5 before scratch. */
for (const [name, inject] of [
  [
    "a new writer",
    (f: ReturnType<typeof fixture>) =>
      f.db
        .prepare("INSERT INTO task_writer_holds (taskId, reason) VALUES (?, ?)")
        .run(taskA, "writer"),
  ],
  [
    "an ambiguity hold",
    (f: ReturnType<typeof fixture>) =>
      f.db
        .prepare(
          "INSERT INTO task_writer_ambiguity_holds (taskId, reason) VALUES (?, ?)",
        )
        .run(taskA, "ambiguous"),
  ],
  [
    "a lost lease",
    (f: ReturnType<typeof fixture>) => f.state.endArchive(taskA),
  ],
] as const)
  test(`${name} between repositories holds the journal with the completed repository only`, async () => {
    const f = fixture();
    try {
      const manager = f.manager();
      const { binding, repoB, scratch } = await populated(f, manager);
      const repoBBefore = tree(repoB);
      const result = await manager.trim(
        taskA,
        "disk",
        f.lifecycle,
        lease(f, taskA, (call) => {
          if (call === 4) inject(f);
        }),
      );
      assert.equal(result.outcome, "held");
      assert.equal(
        result.outcome === "held" && result.reason,
        "Workspace trimming stopped: Task ownership changed during trimming",
      );
      assert.deepEqual(tree(join(binding.path, "repo-1")), repoAAfter);
      assert.deepEqual(tree(repoB), repoBBefore);
      assert.deepEqual(tree(scratch), [
        "a.txt",
        "out -> link",
        "sub/",
        "sub/b.txt",
      ]);
      const [operation] = f.lifecycle.operations({
        taskId: taskA,
        workspaceId: binding.workspaceId,
      });
      assert.equal(operation?.state, "held");
      assert.equal(operation?.completedAt, null);
      assert.deepEqual(
        operation?.effects.map((e) => [e.target, e.outcome]),
        [[{ kind: "repository", repositoryId: "repo-a" }, "succeeded"]],
      );
      // An unfinished journal blocks the next trim instead of reporting success.
      f.db.exec(
        "DELETE FROM task_writer_holds; DELETE FROM task_writer_ambiguity_holds",
      );
      f.state.endArchive(taskA);
      const again = await manager.trim(
        taskA,
        "disk",
        f.lifecycle,
        lease(f, taskA),
      );
      assert.equal(
        again.outcome === "refused" && again.reason,
        "Workspace has unfinished maintenance",
      );
    } finally {
      f.close();
    }
  });

test("a parent replaced by a link after scanning is refused and its target survives", async () => {
  const f = fixture();
  try {
    const manager = f.manager();
    const { binding, repoA, repoB } = await populated(f, manager);
    const repoBBefore = tree(repoB);
    const result = await manager.trim(
      taskA,
      "manual",
      f.lifecycle,
      lease(f, taskA, (call) => {
        if (call !== 3) return;
        renameSync(join(repoA, "ignored"), join(f.root, "moved-ignored"));
        symlinkSync(f.outside, join(repoA, "ignored"));
      }),
    );
    assert.equal(
      result.outcome === "held" && result.reason,
      "Workspace trimming stopped: An ignored path's parent is not a directory",
    );
    assert.equal(
      readFileSync(join(f.outside, "a.o"), "utf8"),
      "outside object",
    );
    assert.deepEqual(tree(f.outside), ["a.o", "sentinel.txt"]);
    assert.deepEqual(tree(repoB), repoBBefore);
    const [operation] = f.lifecycle.operations({
      taskId: taskA,
      workspaceId: binding.workspaceId,
    });
    assert.deepEqual(
      operation?.effects.map((e) => [e.target, e.outcome]),
      [[{ kind: "repository", repositoryId: "repo-a" }, "failed"]],
    );
  } finally {
    f.close();
  }
});

test("a filesystem error part-way keeps the failed effect held with no success record", async () => {
  const f = fixture();
  const manager = f.manager();
  const { binding, repoA, scratch } = await populated(f, manager);
  const locked = join(repoA, "ignored", "deep");
  try {
    chmodSync(locked, 0o555);
    const result = await manager.trim(
      taskA,
      "manual",
      f.lifecycle,
      lease(f, taskA),
    );
    assert.equal(
      result.outcome === "held" && result.reason,
      "Workspace trimming stopped: filesystem error EACCES",
    );
    assert.equal(result.binding?.state, "ready");
    assert.ok(existsSync(join(locked, "b.o")));
    assert.ok(existsSync(join(scratch, "a.txt")));
    const [operation] = f.lifecycle.operations({
      taskId: taskA,
      workspaceId: binding.workspaceId,
    });
    assert.equal(operation?.state, "held");
    assert.deepEqual(
      operation?.effects.map((e) => e.outcome),
      ["failed"],
    );
  } finally {
    chmodSync(locked, 0o755);
    f.close();
  }
});

test("cancellation between repositories is held and reports no success", async () => {
  const f = fixture();
  try {
    const manager = f.manager();
    const { binding, repoB } = await populated(f, manager);
    const repoBBefore = tree(repoB);
    const result = await manager.trim(
      taskA,
      "manual",
      f.lifecycle,
      lease(f, taskA, (call) => {
        if (call === 4) manager.cancelGitWork();
      }),
    );
    assert.equal(
      result.outcome === "held" && result.reason,
      "Workspace trimming was cancelled; some ignored files or scratch contents may already be deleted",
    );
    assert.deepEqual(tree(repoB), repoBBefore);
    const [operation] = f.lifecycle.operations({
      taskId: taskA,
      workspaceId: binding.workspaceId,
    });
    assert.equal(operation?.state, "held");
    assert.deepEqual(
      operation?.effects.map((e) => e.outcome),
      ["succeeded"],
    );
  } finally {
    f.close();
  }
});

test("an unobserved readback Git child marks the workspace uncertain and keeps the journal held", {
  skip: processIdentityDenied(),
}, async () => {
  const controlled = controlledGit();
  const f = fixture();
  try {
    const manager = f.manager({
      gitExecutable: controlled.executable,
      gitTimeoutMs: { "trim-scan": 300 },
      gitTerminationGraceMs: 50,
      gitTerminationObservationMs: 40,
    });
    const { binding, repoA, repoB } = await populated(f, manager);
    const repoBBefore = tree(repoB);
    const result = await manager.trim(
      taskA,
      "manual",
      f.lifecycle,
      lease(f, taskA, (call) => {
        if (call === 3)
          controlled.setRule({
            commandPrefix: "--no-optional-locks status",
            cwd: repoA,
            behavior: "stall",
          });
      }),
    );
    assert.equal(result.outcome, "held");
    assert.equal(result.binding?.gitUncertain, true);
    assert.equal(result.binding?.state, "held");
    assert.deepEqual(tree(repoB), repoBBefore);
    const [operation] = f.lifecycle.operations({
      taskId: taskA,
      workspaceId: binding.workspaceId,
    });
    assert.equal(operation?.state, "held");
    assert.deepEqual(
      operation?.effects.map((e) => e.outcome),
      ["failed"],
    );
  } finally {
    try {
      await controlled.cleanup();
    } finally {
      f.close();
    }
  }
});

test("path safety checks are what preserve outside files", async () => {
  // A directory Git did not enumerate is refused rather than handed to deletion.
  assert.deepEqual(
    ignoredTrimPaths(Buffer.from("!! ignored/a.o\0!! ignored/nested/\0")),
    { ok: false, reason: "it contains a nested Git repository" },
  );
  for (const path of ["../escape", "a/../b", "/abs", "a//b", "x/.git/config"])
    assert.equal(ignoredTrimPaths(Buffer.from(`!! ${path}\0`)).ok, false, path);
  assert.equal(
    ignoredTrimPaths(Buffer.from([0x21, 0x21, 0x20, 0xff, 0x00])).ok,
    false,
  );

  const root = mkdtempSync(join(tmpdir(), "cab-trim-safety-"));
  try {
    const worktree = join(root, "worktree");
    const outside = join(root, "outside");
    write(join(outside, "a.o"), "outside");
    mkdirSync(worktree);
    symlinkSync(outside, join(worktree, "ignored"));
    await assert.rejects(
      unlinkIgnored(worktree, "ignored/a.o"),
      /parent is not a directory/,
    );
    assert.ok(existsSync(join(outside, "a.o")));
    // With the ancestor check disabled, the same unlink follows the link and the outside file goes.
    unlinkSync(join(worktree, "ignored", "a.o"));
    assert.equal(existsSync(join(outside, "a.o")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A Codex-shaped fake whose first turn can be held open. */
class TrimRuntime implements Runtime {
  readonly harness = "codex" as const;
  readonly turns: unknown[][] = [];
  safety: RuntimeSpawnContext["safety"] | undefined;
  release: (() => void) | undefined;
  private gate: Promise<void> | undefined;
  private count = 0;
  private tool:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
  constructor() {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.tool = listener;
  }
  currentUserInputGeneration() {
    return "trim-fixture";
  }
  async start() {}
  async stop() {}
  async startThread() {
    return `thread-${++this.count}`;
  }
  async resumeThread() {}
  async startTurn(...args: unknown[]) {
    this.turns.push(args);
    return `turn-${this.turns.length}`;
  }
  async interruptTurn() {}
  async waitForTurn(threadId: string, turnId: string) {
    await this.gate;
    const result = await this.tool?.({
      threadId,
      turnId,
      callId: randomUUID(),
      tool: "cab_report_result",
      arguments: { summary: "fixture result" },
    });
    assert.equal(result?.success, true, result?.text ?? "Missing report");
    // As a real runtime does, record the exact terminal turn: the turn-end clock reads it.
    this.safety?.recordTerminal({
      threadId,
      turnId,
      status: "completed",
      runtimeGeneration: "trim-fixture",
    });
    return "completed" as const;
  }
  onUnexpectedRequest() {}
}

async function waitUntil(predicate: () => boolean, describe: () => unknown) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out: ${JSON.stringify(describe())}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("the service trims only settled execution and the next turn's context reports it once", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cab-trim-service-"));
  const runtime = new TrimRuntime();
  const service = new StandaloneService(
    join(root, "data"),
    (context) => {
      runtime.safety = context.safety;
      return runtime;
    },
    undefined,
    { power: { enabled: false }, routingClient: null },
  );
  t.after(async () => {
    runtime.release?.();
    await service.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  const execute = (command: Record<string, unknown>) =>
    service
      .domain()
      .execute({ key: randomUUID(), actor: "operator", ...command } as never);
  await service.start();
  const lead = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  execute({
    type: "profile.create",
    profileId: lead,
    name: "Lead",
    instructions: "lead",
    capabilities: "code",
    runtime: { harness: "codex" },
  });
  execute({
    type: "project.create",
    projectId,
    name: "Trim",
    leadProfileId: lead,
  });
  execute({
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  execute({
    type: "task.create",
    projectId,
    taskId,
    title: "Trim",
    outcome: "Trim notice",
    ready: false,
  });
  await service.provisionTask(taskId);
  execute({
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  const describe = () =>
    service.list().map((i) => [i.workId, i.state, i.reason]);
  await waitUntil(() => runtime.turns.length === 1, describe);
  const workspace = String(runtime.turns[0]?.[1]);
  const scratch = taskScratchPath(workspace);
  write(join(scratch, "cache", "file"));
  write(join(workspace, "evidence", "kept.md"));

  // A running turn holds execution, so trimming refuses and deletes nothing.
  const busy = await service.trimTaskWorkspace(taskId, "idle");
  assert.equal(busy.outcome, "refused");
  assert.ok(existsSync(join(scratch, "cache", "file")));

  runtime.release?.();
  await waitUntil(
    () => service.list().some((i) => i.state === "completed"),
    describe,
  );
  const trimmed = await service.trimTaskWorkspace(taskId, "idle");
  assert.equal(
    trimmed.outcome,
    "trimmed",
    JSON.stringify([trimmed, describe()]),
  );
  assert.deepEqual(tree(workspace), [
    "evidence/",
    "evidence/kept.md",
    "scratch/",
  ]);
  const at = trimmed.outcome === "trimmed" ? trimmed.operation.completedAt! : 0;

  const assignmentId =
    service.recoveryForTask(taskId)[0]?.binding?.assignmentId;
  assert.ok(assignmentId);
  const message = () =>
    service.coordinationView().postOperatorMessage({
      key: randomUUID(),
      taskId,
      recipientAssignmentId: assignmentId,
      expectedAssignmentVersion: Number(
        service.domain().assignment(assignmentId).version,
      ),
      message: "Continue",
    });
  await message();
  await waitUntil(() => runtime.turns.length === 2, describe);
  const notice = `Workspace trimmed ${new Date(at).toISOString()}: cab deleted the Git-ignored files in this task's repositories and everything in its scratch directory. Rebuild any ignored or scratch files you need, such as dependencies, build output and caches.`;
  const prompt = String(runtime.turns[1]?.[2]);
  assert.equal(prompt.split(notice).length - 1, 1, prompt);
  assert.doesNotMatch(String(runtime.turns[0]?.[2]), /Workspace trimmed/);
  assert.doesNotMatch(prompt, /restored/);

  await waitUntil(
    () => service.list().filter((i) => i.state === "completed").length === 2,
    describe,
  );
  await message();
  await waitUntil(() => runtime.turns.length === 3, describe);
  assert.doesNotMatch(String(runtime.turns[2]?.[2]), /Workspace trimmed/);
});
