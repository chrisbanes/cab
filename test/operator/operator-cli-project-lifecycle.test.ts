import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { archivedProjectFixture } from "../fixtures/archived-project.js";
import { loginCli, serveCli } from "../fixtures/operator-cli.js";

async function world(t: Parameters<typeof archivedProjectFixture>[0]) {
  const f = await archivedProjectFixture(t);
  const o = await loginCli(t, await serveCli(t, f.fixture));
  return { ...o, f };
}

test("CLI project list opts into archive history and delete preview prints consequences using read-only authority", async (t) => {
  const { cli, f } = await world(t);
  const normal = await cli("ro", ["project", "list"]);
  assert.equal(normal.code, 0, normal.err);
  assert.equal(normal.out.includes(f.projectId), false);
  const history = await cli("ro", ["project", "list", "--archived"]);
  assert.equal(history.code, 0, `${history.err}${history.out}`);
  assert.equal(history.out.includes(f.projectId), true);
  const preview = await cli("ro", [
    "project",
    "delete",
    f.projectId,
    "--preview",
  ]);
  assert.equal(preview.code, 0, preview.err);
  assert.equal(preview.json().data.projectId, f.projectId);
  assert.equal(preview.json().data.forceDiscard, true);
});

test("CLI delete requires all exact confirmation fields, refuses bypass flags and sends the inspected body", async (t) => {
  const { cli, f, s, h } = await world(t);
  const before = h.fetches.length;
  for (const flags of [
    [],
    ["--yes"],
    ["--force"],
    ["--confirm-name", "Archive fixture"],
    ["--preview", "--request-id", randomUUID()],
  ]) {
    const response = await cli("rw", [
      "project",
      "delete",
      f.projectId,
      ...flags,
    ]);
    assert.notEqual(response.code, 0);
  }
  assert.equal(
    h.fetches.length,
    before,
    "invalid CLI confirmation performs no HTTP request",
  );
  const preview = (
    await cli("ro", ["project", "delete", f.projectId, "--preview"])
  ).json().data;
  const key = randomUUID();
  const args = [
    "project",
    "delete",
    f.projectId,
    "--confirm-name",
    preview.name,
    "--expected-version",
    String(preview.version),
    "--preview-digest",
    preview.previewDigest,
    "--request-id",
    key,
  ];
  const bodies: unknown[] = [];
  const response = await cli("rw", args, {
    fetch: async (input, init) => {
      if (String(input).endsWith("/api/operator/commands"))
        bodies.push(JSON.parse(String(init?.body)));
      return fetch(input, init);
    },
  });
  assert.equal(response.code, 0, response.err);
  assert.deepEqual(bodies, [
    {
      type: "project.delete",
      projectId: f.projectId,
      confirmationName: preview.name,
      expectedVersion: preview.version,
      previewDigest: preview.previewDigest,
      key,
    },
  ]);
  const original = response.json().data.receipt;
  assert.equal(original.result.commandType, "project.delete");
  assert.equal(response.json().data.project.state, "deleted");
  const replay = await cli("rw", args);
  assert.equal(replay.code, 0, replay.err);
  assert.deepEqual(replay.json().data.receipt, original);
  const old = await s.sessionGet(`/api/operator/projects/${f.projectId}`);
  assert.equal(old.status, 200);
});

test("CLI unknown restore checks original operation and an absent receipt permits only the original versioned body", async (t) => {
  const { cli, f, h } = await world(t);
  const posts: string[] = [];
  const key = randomUUID();
  const originalVersion = Number(f.domain.project(f.projectId)?.version);
  const lost: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/api/operator/commands")) {
      posts.push(String(init?.body));
      throw new TypeError("request outcome unknown");
    }
    return fetch(input, init);
  };
  const args = ["project", "restore", f.projectId, "--request-id", key];
  const first = await cli("rw", args, { fetch: lost });
  assert.notEqual(first.code, 0);
  assert.equal(posts.length, 1);
  const withoutVersion = await cli("rw", args, { fetch: lost });
  assert.notEqual(withoutVersion.code, 0);
  assert.equal(posts.length, 1);
  const wrong = await cli(
    "rw",
    [...args, "--expected-version", String(originalVersion + 1)],
    { fetch: lost },
  );
  assert.notEqual(wrong.code, 0);
  assert.equal(posts.length, 1, "changed version never reaches HTTP");
  await cli("rw", [...args, "--expected-version", String(originalVersion)], {
    fetch: lost,
  });
  assert.equal(posts.length, 2);
  assert.equal(posts[0], posts[1]);
  const journal = await readFile(join(h.configDir, "requests.jsonl"), "utf8");
  assert.equal(journal.includes("bodyDigest"), true);
  assert.equal(journal.includes("confirmationName"), false);
  assert.equal(journal.includes("Archive fixture"), false);
  const success = await cli("rw", [
    ...args,
    "--expected-version",
    String(originalVersion),
  ]);
  assert.equal(success.code, 0, success.err);
  const restored = f.domain.project(f.projectId)!;
  assert.equal(restored.archived, 0);
  assert.equal(restored.paused, 1);
  const changedAfterReceipt = await cli(
    "rw",
    [...args, "--expected-version", String(originalVersion + 1)],
    { fetch: lost },
  );
  assert.notEqual(changedAfterReceipt.code, 0);
  assert.equal(changedAfterReceipt.json().error.code, "conflict");
  assert.equal(
    posts.length,
    2,
    "a recorded original receipt does not authorize a changed version",
  );
});

test("CLI project archive and project restore retain normal versioned receipts and render paused counterpaths", async (t) => {
  const { cli, h, f } = await world(t);
  const restore = await cli("rw", ["project", "restore", f.projectId]);
  assert.equal(restore.code, 0, `${restore.err}${restore.out}`);
  const archived = await cli("rw", ["project", "archive", f.projectId]);
  assert.equal(archived.code, 0, `${archived.err}${archived.out}`);
  assert.equal(
    archived.json().data.receipt.result.commandType,
    "project.archive",
  );
  assert.equal(archived.json().data.receipt.result.archived, true);
  assert.equal(archived.json().data.receipt.result.paused, true);
  const history = await h.run([
    "project",
    "list",
    "--archived",
    "--connection",
    "ro",
  ]);
  assert.equal(history.code, 0, history.err);
  assert.match(history.out, /Paused\s+Archived\s+Version/);
  const preview = await h.run([
    "project",
    "delete",
    f.projectId,
    "--preview",
    "--connection",
    "ro",
  ]);
  assert.equal(preview.code, 0, preview.err);
  assert.match(preview.out, /Preview digest: [a-f0-9]{64}/);
  assert.match(preview.out, /force-discards/);
  assert.match(preview.out, /Cleanup can remain pending/);
});
