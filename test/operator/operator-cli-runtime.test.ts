import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { startCliOperator } from "../fixtures/operator-cli.js";

test("runtime list, enable and disable: --yes for bound work, refusal for a missing executable", async (t) => {
  let claudeOnPath = true;
  const o = await startCliOperator(t, {
    service: {
      supervisor: { observationMs: 50 },
      runtimeHarnesses: ["codex", "claude"],
      resolveExecutable: async (harness) =>
        harness !== "claude" || claudeOnPath,
    },
  });
  const { cli, s } = o;
  // One Claude-bound turn that has not run: bound work, nothing running.
  s.f.seedPersistedState((db) => {
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      "INSERT INTO execution_intents (id, workId, prompt, workspace, state, accountType, sandbox, approval) VALUES (?, 'cli-bound-probe', 'p', '/w', 'ready', 'chatgpt', 'workspaceWrite', 'never')",
    ).run(randomUUID());
    db.prepare(
      "INSERT INTO task_execution_bindings (workId, taskId, assignmentId, assignmentVersion, instructionsRevision, profileRevision, conversationRevision, harness) VALUES ('cli-bound-probe', ?, ?, 1, 1, 1, 1, 'claude')",
    ).run(s.taskId, randomUUID());
  });

  // Without --yes a disable with bound work is refused and nothing changes.
  let r = await o.h.run(["runtime", "disable", "claude", "--connection", "rw"]);
  assert.equal(r.code, 4, r.out + r.err);
  assert.match(
    r.err,
    /1 task uses Claude\. Running turns finish; their next turns wait until Claude is enabled again\. Re-run with --yes/,
  );
  assert.equal(s.f.service.domain().runtimeEnabled("claude"), true);

  // --yes confirms the count it read; a task bound after that read is refused.
  let grown = false;
  r = await o.h.run(
    ["runtime", "disable", "claude", "--yes", "--connection", "rw"],
    {
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (!grown && String(input).endsWith("/api/operator/runtime")) {
          grown = true;
          s.f.seedPersistedState((db) => {
            db.exec("PRAGMA foreign_keys = OFF");
            db.prepare(
              "INSERT INTO execution_intents (id, workId, prompt, workspace, state, accountType, sandbox, approval) VALUES (?, 'cli-bound-probe-2', 'p', '/w', 'ready', 'chatgpt', 'workspaceWrite', 'never')",
            ).run(randomUUID());
            db.prepare(
              "INSERT INTO task_execution_bindings (workId, taskId, assignmentId, assignmentVersion, instructionsRevision, profileRevision, conversationRevision, harness) VALUES ('cli-bound-probe-2', ?, ?, 1, 1, 1, 1, 'claude')",
            ).run(randomUUID(), randomUUID());
          });
        }
        return response;
      },
    },
  );
  assert.ok(grown);
  assert.equal(r.code, 4, r.out + r.err);
  assert.match(r.err, /2 tasks use Claude\. .* Re-run with --yes/);
  assert.equal(s.f.service.domain().runtimeEnabled("claude"), true);

  r = await cli("rw", ["runtime", "disable", "claude", "--yes"]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.json().data.receipt.result, {
    commandType: "runtime.configure",
    resourceId: "system:runtime:claude",
    harness: "claude",
    enabled: false,
  });
  r = await o.h.run(["runtime", "list", "--connection", "ro"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /codex\s+enabled\s+Available\s+0/);
  assert.match(
    r.out,
    /claude\s+disabled\s+Not enabled \(Disabled in Settings\)\s+2/,
  );
  r = await cli("ro", ["runtime", "list"]);
  assert.deepEqual(r.json().data.runtimes, [
    {
      harness: "codex",
      enabled: true,
      state: "available",
      reason: null,
      boundTasks: 0,
    },
    {
      harness: "claude",
      enabled: false,
      state: "not-configured",
      reason: "disabled",
      boundTasks: 2,
    },
  ]);

  // Enabling with `claude` missing is refused, and the setting stays disabled.
  claudeOnPath = false;
  r = await o.h.run(["runtime", "enable", "claude", "--connection", "rw"]);
  assert.equal(r.code, 4, r.out + r.err);
  assert.match(r.err, /`claude` not found on the service PATH/);
  assert.equal(s.f.service.domain().runtimeEnabled("claude"), false);
  claudeOnPath = true;
  r = await cli("rw", ["runtime", "enable", "claude"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(s.f.service.domain().runtimeEnabled("claude"), true);

  // Codex has no bound work: no --yes needed. A read-only credential cannot write.
  r = await cli("ro", ["runtime", "disable", "codex"]);
  assert.equal(r.code, 3, r.out);
  r = await o.h.run(["runtime", "disable", "codex", "--connection", "rw"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Disabled Codex/);
  assert.match(r.out, /Reverse with 'runtime enable codex'/);
  assert.equal(s.f.service.domain().runtimeEnabled("codex"), false);
  r = await o.h.run(["runtime", "enable", "pi", "--connection", "rw"]);
  assert.equal(r.code, 2);
});
