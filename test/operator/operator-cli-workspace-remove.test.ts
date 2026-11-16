import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startCliOperator } from "../fixtures/operator-cli.js";
import { startedOf } from "../fixtures/service-internals.js";

type Operator = Awaited<ReturnType<typeof startCliOperator>>;

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Remove",
      "-c",
      "user.email=remove@example.invalid",
      ...args,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    },
  ).trim();

/** The CLI task with a workspace over one local repository at its base, finished as `state`. */
async function workspace(o: Operator, state: "done" | "open" = "done") {
  const source = join(o.s.f.directory, `source-${randomUUID()}`);
  mkdirSync(source);
  git(source, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(source, "README.md"), "base\n");
  git(source, "add", ".");
  git(source, "commit", "--quiet", "-m", "base");
  const binding = await o.s.f.service.provisionTask(o.s.taskId, [
    { repositoryId: "R1", path: source, ref: "main" },
  ]);
  assert.equal(binding.state, "ready", binding.reason ?? "");
  if (state === "done")
    o.d.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: o.s.projectId,
      taskId: o.s.taskId,
      expectedVersion: Number(o.d.task(o.s.taskId).version),
      state: "done",
    } as never);
  return { binding, base: binding.repositories[0]!.commit! };
}

/** A fetch that counts command POSTs, optionally losing the reply of the next one. */
function counting(lose = false) {
  const posts: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).endsWith("/api/operator/commands")) {
      posts.push(String(init?.body));
      if (lose) {
        lose = false;
        throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      }
    }
    return response;
  };
  return { posts, fetch: fetcher };
}

test("task workspace-remove validates its arguments and accepts no override", async (t) => {
  const o = await startCliOperator(t);
  for (const args of [
    [],
    ["not-a-uuid"],
    [o.s.taskId, "--force"],
    [o.s.taskId, "--request-id", "nope"],
  ]) {
    const r = await o.cli("rw", ["task", "workspace-remove", ...args]);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.err}${r.out}`);
  }
  const help = await o.h.run(["--help", "--all"]);
  assert.match(help.out, /task workspace-remove TASK_ID \[--request-id UUID\]/);
  assert.match(help.out, /task show TASK_ID \[--connection NAME\]/);
  assert.match(
    help.out,
    /task workspace-remove deletes a done or cancelled task's workspace/,
  );
  // A task without a workspace has nothing to name: the CLI sends nothing.
  const sent = counting();
  const r = await o.cli("rw", ["task", "workspace-remove", o.s.taskId], {
    fetch: sent.fetch,
  });
  assert.equal(r.code, 4, r.err + r.out);
  assert.deepEqual(sent.posts, []);
});

test("task workspace-remove sends only the task and its current workspace and prints the evidence", async (t) => {
  const o = await startCliOperator(t);
  const { binding, base } = await workspace(o);
  const key = randomUUID();
  const sent = counting();
  const r = await o.h.run(
    [
      "task",
      "workspace-remove",
      o.s.taskId,
      "--request-id",
      key,
      "--connection",
      "rw",
    ],
    { fetch: sent.fetch },
  );
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(
    sent.posts.map((body) => JSON.parse(body)),
    [
      {
        type: "task.workspace.remove",
        key,
        taskId: o.s.taskId,
        workspaceId: binding.workspaceId,
      },
    ],
  );
  assert.match(
    r.out,
    new RegExp(
      `^Removed the workspace of task ${o.s.taskId} \\(request ${key}\\)\\.`,
    ),
  );
  assert.match(r.out, /Effect:\s+completed/);
  assert.match(r.out, new RegExp(`Workspace:\\s+${binding.workspaceId}`));
  assert.match(
    r.out,
    new RegExp(`Evidence:\\n  R1: no task commits beyond main at ${base}`),
  );
  assert.match(
    r.out,
    /The task branch, change requests, results and conversations remain\. A later turn gets a new workspace\./,
  );
  assert.doesNotMatch(r.out, /archiv/i);
  assert.equal(r.out.includes(binding.path), false);
  assert.equal(existsSync(binding.path), false);

  // `task show` is `task get`: the same data, with the record and its evidence.
  const show = await o.cli("ro", ["task", "show", o.s.taskId]);
  const get = await o.cli("ro", ["task", "get", o.s.taskId]);
  assert.equal(show.code, 0, show.err);
  const { observedAt: _a, ...shown } = show.json().coverage;
  const { observedAt: _b, ...got } = get.json().coverage;
  assert.deepEqual(shown, got);
  assert.deepEqual(show.json().data, get.json().data);
  assert.deepEqual(show.json().data.workspace.removal.repositories, [
    { repositoryId: "R1", kind: "base", branch: "main", commit: base },
  ]);
  const human = await o.h.run([
    "task",
    "show",
    o.s.taskId,
    "--connection",
    "ro",
  ]);
  assert.match(
    human.out,
    /\nWorkspace: Workspace removed \d{4}-\d{2}-\d{2}T[\d:.]+Z \(manual\)\n {2}R1: no task commits beyond main at [0-9a-f]{40}\n/,
  );
  assert.doesNotMatch(human.out, /archiv/i);
  assert.equal(human.out.includes(binding.path), false);
});

test("task workspace-remove reports a refusal with its reason and records nothing", async (t) => {
  const o = await startCliOperator(t);
  const { binding } = await workspace(o, "open");
  const r = await o.h.run([
    "task",
    "workspace-remove",
    o.s.taskId,
    "--connection",
    "rw",
  ]);
  assert.equal(r.code, 4, r.err + r.out);
  assert.match(
    r.err,
    /Workspace not removed: Only a done or cancelled task's workspace can be removed\./,
  );
  assert.equal(existsSync(binding.path), true);
  assert.equal(
    startedOf(o.s.f.service).workspaceBindings.get(o.s.taskId)?.state,
    "ready",
  );
});

test("a lost removal reply is read back under its key with no second command", async (t) => {
  const o = await startCliOperator(t);
  const { binding } = await workspace(o);
  const lost = counting(true);
  let r = await o.cli("rw", ["task", "workspace-remove", o.s.taskId], {
    fetch: lost.fetch,
  });
  assert.equal(r.code, 6, r.err + r.out);
  const error = r.json().error;
  assert.equal(error.code, "command-outcome-unknown");
  const key = error.request.key;
  assert.match(
    error.message,
    new RegExp(
      `cab operation get ${key} --scope task:${o.s.taskId} --type task.workspace.remove`,
    ),
  );
  assert.equal(lost.posts.length, 1);
  assert.equal(existsSync(binding.path), false);

  // The rerun reuses the journal's key and reads the recorded receipt: nothing more is sent.
  const again = counting();
  r = await o.cli("rw", ["task", "workspace-remove", o.s.taskId], {
    fetch: again.fetch,
  });
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.json().data.reusedRequest, true);
  assert.equal(r.json().data.receipt.key, key);
  assert.equal(r.json().data.receipt.workspaceId, binding.workspaceId);
  assert.deepEqual(again.posts, []);

  // Settled, the next run is a new request, which the service refuses: the workspace is gone.
  r = await o.cli("rw", ["task", "workspace-remove", o.s.taskId], {
    fetch: again.fetch,
  });
  assert.equal(r.code, 4, r.err + r.out);
  assert.equal(again.posts.length, 1);
  assert.notEqual(JSON.parse(again.posts[0]!).key, key);
  assert.match(r.json().error.message, /This workspace was already removed\./);
});
