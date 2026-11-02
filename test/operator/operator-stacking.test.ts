import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { harness } from "../fixtures/cli-harness.js";
import { startCliService } from "../fixtures/operator-cli.js";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI documents are asserted structurally
type Json = Record<string, any>;

test("the stacking setting and a task's stack facts through the API and the CLI", async (t) => {
  const s = await startCliService(t);
  const d = s.f.service.domain();
  const version = () => Number(d.project(s.projectId).version);
  const configure = (stacking: boolean, expectedVersion = version()) => ({
    type: "project.configure",
    key: randomUUID(),
    projectId: s.projectId,
    expectedVersion,
    stacking,
  });
  const read = await s.issue("read", "stack-ro");
  const write = await s.issue("read-write", "stack-rw");
  const get = async (path: string) => {
    const r = await s.bearer(read.token, path);
    assert.equal(r.status, 200);
    return ((await r.json()) as { data: Json }).data;
  };
  const config = () =>
    get(`/api/operator/projects/${s.projectId}/configuration`);
  const task = () => get(`/api/operator/tasks/${s.taskId}`);
  const post = (token: string, body: unknown) =>
    s.bearer(token, "/api/operator/commands", { method: "POST", body });

  assert.equal((await config()).stacking, false, "off by default");
  // The CLI fixture's task depends on a blocker in its project.
  const blocker = randomUUID();
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: s.projectId,
    taskId: blocker,
    title: "Blocker",
    outcome: "O",
    blockerTaskIds: [],
  });
  d.execute({
    type: "dependency.add",
    actor: "operator",
    key: randomUUID(),
    projectId: s.projectId,
    taskId: s.taskId,
    blockerTaskId: blocker,
    expectedVersion: Number(d.task(s.taskId).version),
  });
  let data = await task();
  assert.equal(data.stack.reason, "stacking-off");
  assert.ok(data.admission.reasons.includes("local-dependency"));

  assert.equal((await post(read.token, configure(true))).status, 403);
  const stale = version();
  const set = await post(write.token, configure(true));
  assert.equal(set.status, 200);
  assert.equal((await config()).stacking, true);
  assert.equal(version(), stale + 1, "the project version moves");
  assert.equal((await post(write.token, configure(false, stale))).status, 409);
  assert.equal(d.stacking(s.projectId), true);

  data = await task();
  assert.deepEqual(data.stack, {
    state: "waiting",
    reason: "blocker-unpublished",
    blockerTaskId: blocker,
    repositoryId: null,
    parentHead: null,
    restack: null,
  });
  assert.ok(data.admission.reasons.includes("stacked-blocker-unpublished"));
  assert.ok(!data.admission.reasons.includes("local-dependency"));
  assert.deepEqual(
    data.waits.find((w: Json) => w.code === "stacked-blocker-unpublished")
      ?.links,
    [{ kind: "task", id: blocker, label: "Blocker" }],
  );

  const h = harness(t);
  for (const [name, token] of [
    ["ro", read.token],
    ["rw", write.token],
  ] as const) {
    const login = await h.run([
      "auth",
      "login",
      "--connection",
      name,
      "--url",
      s.origin,
      "--token-file",
      h.tokenFile(token),
    ]);
    assert.equal(login.code, 0, login.err);
  }
  const cli = (connection: "ro" | "rw", args: string[]) =>
    h.run([...args, "--connection", connection]);
  const project = await cli("ro", ["project", "get", s.projectId]);
  assert.match(project.out, /Stacking:\s+on/);
  const detail = await cli("ro", ["task", "get", s.taskId]);
  assert.equal(detail.code, 0, detail.err);
  assert.match(
    detail.out,
    /Stack: {3}Will start stacked on its blocker; waiting because its blocker has no open change request at its last push\./,
  );

  const prepare = (extra: string[]) => {
    const out = join(h.dir, `${randomUUID()}.json`);
    return {
      out,
      run: () =>
        cli("ro", [
          "project",
          "prepare",
          s.projectId,
          ...extra,
          "--out",
          out,
          "--output",
          "json",
        ]),
    };
  };
  const bad = prepare(["--stacking", "maybe"]);
  let r = await bad.run();
  assert.equal(r.code, 2, r.err + r.out);
  assert.equal(existsSync(bad.out), false);

  const off = prepare(["--stacking", "false"]);
  r = await off.run();
  assert.equal(r.code, 0, r.err + r.out);
  const doc = JSON.parse(readFileSync(off.out, "utf8")) as Json;
  assert.deepEqual(doc.preview.changes, [
    { field: "stacking", from: "true", to: "false" },
  ]);
  const notes = JSON.stringify(doc.preview.notes);
  assert.match(notes, /unmerged work/);
  assert.match(notes, /merge cannot be undone/);
  assert.match(notes, /dependents that have not started/);
  r = await cli("rw", ["project", "apply", "--file", off.out]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(d.stacking(s.projectId), false);
});
