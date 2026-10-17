import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { COVERAGE_GAPS, cursorQuery } from "../../src/cli/browse.js";
import { fakeServer, harness } from "../fixtures/cli-harness.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import { startCliService } from "../fixtures/operator-cli.js";
import { taskColumnOf } from "../../src/operator/task-presentation.js";
import { seedOwnQuestion } from "../fixtures/questions.js";
import { seedBrowseWorkspace } from "../fixtures/operator-cli-browse.js";

type After = { after(fn: () => unknown): void };
// biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes are asserted structurally
type Json = Record<string, any>;

async function setup(t: After) {
  const s = await startCliService(t);
  const seed = await seedBrowseWorkspace(s);
  const h = harness(t);
  const read = await s.issue("read", "browse-ro");
  const login = await h.run([
    "auth",
    "login",
    "--connection",
    "home",
    "--url",
    s.origin,
    "--token-file",
    h.tokenFile(read.token),
  ]);
  assert.equal(login.code, 0, login.err);
  const ok = async (args: string[]) => {
    const r = await h.run([...args, "--output", "json"]);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}${r.out}`);
    return r.json() as Json;
  };
  const api = async (path: string) => {
    const r = await s.bearer(read.token, path);
    assert.equal(r.status, 200, path);
    return ((await r.json()) as Json).data as Json;
  };
  return { s, seed, h, read, ok, api, d: s.f.service.domain() };
}

const strip = ({ nextCursor, catalogFingerprint, ...rest }: Json) => rest;
const forge = (kind: string, q: string, c: string) =>
  Buffer.from(JSON.stringify({ v: 1, k: kind, q, c })).toString("base64url");

test("an empty profile list prints the create command next", async (t) => {
  const s = await startCliService(t);
  const h = harness(t);
  const read = await s.issue("read", "empty-profiles");
  const login = await h.run([
    "auth",
    "login",
    "--url",
    s.origin,
    "--token-file",
    h.tokenFile(read.token),
  ]);
  assert.equal(login.code, 0, login.err);
  const human = await h.run(["profile", "list"]);
  assert.equal(human.code, 0, human.err);
  const lines = human.out.trimEnd().split("\n");
  assert.equal(lines[0], "No profiles.");
  assert.equal(
    lines[1],
    "Next: ensemble profile prepare-create --out profile.json --name NAME --instructions TEXT",
  );
  assert.equal(lines.length, 2);
  assert.equal(human.err, "");
  // JSON carries no Next line and no new keys.
  const json = await h.run(["profile", "list", "--output", "json"]);
  assert.equal(json.code, 0, json.err);
  assert.ok(!json.out.includes("Next:"));
  assert.deepEqual(Object.keys(json.json().data).sort(), [
    "profiles",
    "runtime",
  ]);
  assert.deepEqual(json.json().data.profiles, []);
});

test("project, profile and task identities stay distinct across projects", async (t) => {
  const { s, seed, h, ok, api } = await setup(t);
  let r = await h.run(["project", "list"]);
  assert.equal(r.code, 0, r.err);
  for (const id of [seed.alphaId, seed.betaId, s.projectId])
    assert.ok(r.out.includes(id), id);
  assert.match(r.out, /Alpha/);
  assert.doesNotMatch(r.out, /Runtime:/);
  r = await h.run(["profile", "list"]);
  for (const id of [seed.alphaLeadId, seed.sharedProfileId])
    assert.ok(r.out.includes(id), id);
  const workspace = await api("/api/operator/workspace");
  const projects = await ok(["project", "list"]);
  assert.deepEqual(projects.data, {
    projects: workspace.projects,
    runtime: workspace.runtime,
  });
  assert.equal(projects.schema, "ensemble.cli/v1");
  assert.equal(typeof projects.coverage.observedAt, "number");
  assert.equal(projects.coverage.complete, true);
  assert.equal(projects.pagination, undefined);
  const profiles = await ok(["profile", "list"]);
  assert.deepEqual(profiles.data, {
    profiles: workspace.profiles,
    runtime: workspace.runtime,
  });
  assert.equal(workspace.projects.length, 3);

  // Two tasks share a title but not an identity.
  assert.notEqual(seed.alphaSharedTaskId, seed.betaSharedTaskId);
  const listAll = async (project: string) => {
    const tasks: Json[] = [];
    let token: string | undefined;
    do {
      const page = await ok([
        "task",
        "list",
        "--project",
        project,
        "--limit",
        "100",
        ...(token ? ["--cursor", token] : []),
      ]);
      tasks.push(...page.data.tasks);
      token = page.pagination.nextCursor ?? undefined;
    } while (token);
    return { data: { tasks } };
  };
  const alpha = await listAll(seed.alphaId);
  const beta = await listAll(seed.betaId);
  const shared = (page: Json) =>
    page.data.tasks.filter((x: Json) => x.title === "Shared title");
  assert.deepEqual(
    shared(alpha).map((x: Json) => [x.id, x.projectId]),
    [[seed.alphaSharedTaskId, seed.alphaId]],
  );
  assert.deepEqual(
    shared(beta).map((x: Json) => [x.id, x.projectId]),
    [[seed.betaSharedTaskId, seed.betaId]],
  );
  assert.ok(alpha.data.tasks.every((x: Json) => x.projectId === seed.alphaId));
  r = await h.run(["task", "list", "--project", seed.betaId]);
  assert.ok(r.out.includes(seed.betaSharedTaskId));
  // The project is named by the filter, so its id is not repeated per row.
  assert.ok(!r.out.includes(seed.betaId));
  assert.ok(!r.out.includes(seed.alphaSharedTaskId));
  const found = await ok(["task", "search", "Shared title", "--historical"]);
  const hits = found.data.matches.filter(
    (m: Json) => m.taskTitle === "Shared title",
  );
  assert.deepEqual(
    hits.map((m: Json) => m.taskId).sort(),
    [seed.alphaSharedTaskId, seed.betaSharedTaskId].sort(),
  );
  assert.equal(new Set(hits.map((m: Json) => m.projectId)).size, 2);
  for (const [task, project] of [
    [seed.alphaSharedTaskId, seed.alphaId],
    [seed.betaSharedTaskId, seed.betaId],
  ] as const) {
    const got = await ok(["task", "get", task]);
    assert.equal(got.data.task.projectId, project);
    r = await h.run(["task", "get", task]);
    assert.match(r.out, new RegExp(`Project: +${project}`));
  }
  const done = await ok(["task", "list", "--state", "done"]);
  assert.deepEqual(
    done.data.tasks.map((x: Json) => x.id),
    [seed.doneTaskId],
  );
  const cancelled = await ok([
    "task",
    "list",
    "--project",
    seed.betaId,
    "--state",
    "cancelled",
  ]);
  assert.deepEqual(
    cancelled.data.tasks.map((x: Json) => x.id),
    [seed.cancelledTaskId],
  );

  // Configuration reads equal the direct API and show the runtime harness.
  for (const [area, id] of [
    ["project", seed.alphaId],
    ["project", seed.betaId],
    ["profile", seed.alphaLeadId],
    ["profile", seed.sharedProfileId],
  ] as const) {
    const got = await ok([area, "get", id]);
    assert.deepEqual(
      got.data,
      await api(`/api/operator/${area}s/${id}/configuration`),
    );
    assert.equal(got.coverage.complete, true);
  }
  r = await h.run(["profile", "get", seed.alphaLeadId]);
  assert.match(r.out, /Runtime: +claude \(model opus, effort high\)/);
  r = await h.run(["profile", "get", seed.sharedProfileId]);
  assert.match(r.out, /Runtime: +codex/);
  for (const area of ["project", "profile"]) {
    r = await h.run([area, "get", randomUUID(), "--output", "json"]);
    assert.equal(r.code, 2);
    assert.equal(r.json().error.code, "not-found");
  }
  assert.equal((await h.run(["project", "get", "nope"])).code, 2);
});

test("task list pages by opaque token without implicit paging", async (t) => {
  const { seed, h, ok, d } = await setup(t);
  const catalog = d.taskCatalog().map((x) => String(x.id));
  assert.ok(catalog.length > 120);
  const seen: string[] = [];
  const sizes: number[] = [];
  let token: string | undefined;
  for (let page = 0; page < 3; page++) {
    const before = h.fetches.length;
    const out = await ok([
      "task",
      "list",
      ...(token ? ["--cursor", token] : []),
    ]);
    const requests = h.fetches.slice(before);
    assert.equal(requests.length, 2, "one identity and one list request");
    assert.match(requests[0] ?? "", /\/api\/operator\/cli$/);
    assert.match(requests[1] ?? "", /\/api\/operator\/task-list\?limit=50/);
    seen.push(...out.data.tasks.map((x: Json) => x.id));
    sizes.push(out.data.tasks.length);
    assert.equal(out.data.nextCursor, undefined);
    assert.equal(out.data.catalogFingerprint, undefined);
    assert.equal(out.pagination.limit, 50);
    assert.equal(out.pagination.maxLimit, 100);
    assert.equal(out.pagination.returned, out.data.tasks.length);
    token = out.pagination.nextCursor ?? undefined;
    assert.equal(out.coverage.complete, token === undefined);
    assert.deepEqual(
      out.coverage.gaps,
      token === undefined ? [] : ["more-pages"],
    );
    if (!token) break;
    assert.doesNotMatch(token, /[^A-Za-z0-9_-]/);
  }
  assert.equal(token, undefined);
  assert.deepEqual(sizes, [50, 50, catalog.length - 100]);
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual([...seen].sort(), [...catalog].sort());

  // Human output prints the exact next command.
  const first = await h.run([
    "task",
    "list",
    "--limit",
    "10",
    "--project",
    seed.alphaId,
  ]);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /^Gap: more-pages$/m);
  const more = /^More: (.*)$/m.exec(first.out)?.[1] ?? "";
  assert.match(
    more,
    /^ensemble task list --project [0-9a-f-]{36} --limit 10 --cursor [A-Za-z0-9_-]+$/,
  );
  const next = await h.run(more.split(" ").slice(1));
  assert.equal(next.code, 0, next.err);

  // Clamping and validation.
  const capped = await ok(["task", "list", "--limit", "150"]);
  assert.equal(capped.pagination.limit, 100);
  assert.equal(capped.pagination.maxLimit, 100);
  assert.ok(capped.coverage.gaps.includes("limit-capped"));
  assert.equal(capped.coverage.complete, false);
  assert.match(h.fetches.at(-1) ?? "", /limit=100/);
  const before = h.fetches.length;
  for (const limit of ["0", "201", "x", "-1", "1.5"]) {
    const r = await h.run([
      "task",
      "list",
      `--limit=${limit}`,
      "--output",
      "json",
    ]);
    assert.equal(r.code, 2, limit);
    assert.equal(r.json().error.code, "invalid-input");
  }
  assert.equal((await h.run(["task", "list", "--state", "stuck"])).code, 2);
  assert.equal((await h.run(["task", "list", "--project", "nope"])).code, 2);
  assert.equal(h.fetches.length, before, "validated before any request");
  assert.ok(COVERAGE_GAPS.includes("catalog-changed"));
});

test("cursors detect catalog changes and refuse stale or foreign tokens", async (t) => {
  const { s, seed, h, ok, d } = await setup(t);
  const page1 = await ok(["task", "list", "--limit", "20"]);
  assert.equal(page1.coverage.continuity, undefined);
  const next1 = page1.pagination.nextCursor as string;
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: seed.alphaId,
    taskId: randomUUID(),
    title: "Arrived between pages",
    outcome: "late",
    ready: false,
  });
  const page2 = await ok(["task", "list", "--limit", "20", "--cursor", next1]);
  assert.ok(page2.coverage.gaps.includes("catalog-changed"));
  assert.equal(page2.coverage.continuity, "changed");
  assert.equal(page2.coverage.complete, false);
  const page3 = await ok([
    "task",
    "list",
    "--limit",
    "20",
    "--cursor",
    page2.pagination.nextCursor,
  ]);
  assert.equal(page3.coverage.continuity, "changed");
  const human = await h.run([
    "task",
    "list",
    "--limit",
    "20",
    "--cursor",
    next1,
  ]);
  assert.match(human.out, /^Gap: catalog-changed$/m);

  let r = await h.run([
    "task",
    "list",
    "--cursor",
    forge("task list", cursorQuery({}), randomUUID()),
    "--output",
    "json",
  ]);
  assert.equal(r.code, 4);
  assert.equal(r.json().error.code, "cursor-stale");
  assert.equal(r.json().error.category, "conflict");
  assert.equal(r.json().error.retryable, false);
  assert.match(r.json().error.message, /without --cursor/);
  r = await h.run([
    "task",
    "list",
    "--cursor",
    forge("task list", cursorQuery({}), randomUUID()),
  ]);
  assert.equal(r.code, 4);
  assert.match(r.err, /cursor-stale/);

  const searchToken = (
    await ok(["task", "search", "work", "--historical", "--limit", "2"])
  ).pagination.nextCursor as string;
  const projectToken = (
    await ok(["task", "list", "--project", seed.alphaId, "--limit", "5"])
  ).pagination.nextCursor as string;
  const stateToken = (
    await ok(["task", "list", "--state", "open", "--limit", "5"])
  ).pagination.nextCursor as string;
  assert.ok(searchToken && projectToken && stateToken);
  const mark = h.fetches.length;
  for (const args of [
    ["task", "list", "--cursor", "not-a-token"],
    ["task", "list", "--cursor", Buffer.from("{}").toString("base64url")],
    ["task", "list", "--cursor", searchToken],
    ["task", "list", "--cursor", projectToken],
    ["task", "list", "--project", s.projectId, "--cursor", projectToken],
    ["task", "list", "--state", "done", "--cursor", stateToken],
    ["task", "list", "--cursor", stateToken],
    ["task", "messages", seed.betaSharedTaskId, "--cursor", projectToken],
    ["task", "search", "work", "--cursor", searchToken],
  ]) {
    r = await h.run([...args, "--output", "json"]);
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.json().error.code, "invalid-input");
  }
  assert.equal(h.fetches.length, mark, "rejected before any request");
  // The matching filters are accepted.
  const again = await ok([
    "task",
    "list",
    "--project",
    seed.alphaId,
    "--limit",
    "5",
    "--cursor",
    projectToken,
  ]);
  assert.equal(again.data.tasks.length, 5);
});

test("task search filters, pages and states its coverage", async (t) => {
  const { h, ok, api, seed } = await setup(t);
  const all = await ok(["task", "search", "Shared title", "--historical"]);
  assert.deepEqual(all.coverage.notes, ["retained records only"]);
  assert.equal(all.pagination.maxLimit, 50);
  assert.equal(all.pagination.limit, 50);
  const human = await h.run(["task", "search", "Shared title", "--historical"]);
  assert.match(human.out, /^Note: retained records only$/m);
  assert.ok(human.out.includes(seed.alphaSharedTaskId));
  assert.ok(human.out.includes(seed.betaSharedTaskId));

  const results = await ok([
    "task",
    "search",
    "needle",
    "--type",
    "result",
    "--historical",
  ]);
  assert.ok(results.data.matches.length >= 1);
  assert.ok(
    results.data.matches.every(
      (m: Json) => m.type === "result" && m.projectId === seed.betaId,
    ),
  );
  const scoped = await ok([
    "task",
    "search",
    "Shared title",
    "--historical",
    "--project",
    seed.alphaId,
  ]);
  assert.deepEqual(
    scoped.data.matches.map((m: Json) => m.taskId),
    [seed.alphaSharedTaskId],
  );
  const none = await ok(["task", "search", "zzzznothing"]);
  assert.deepEqual(none.data.matches, []);
  assert.equal(none.coverage.complete, true);

  // ISO and epoch milliseconds select the same records.
  const iso = await ok([
    "task",
    "search",
    "Shared title",
    "--historical",
    "--after",
    "2000-01-01T00:00:00Z",
  ]);
  const ms = await ok([
    "task",
    "search",
    "Shared title",
    "--historical",
    "--after",
    "946684800000",
  ]);
  assert.deepEqual(iso.data, ms.data);
  assert.equal(iso.data.matches.length, all.data.matches.length);
  assert.match(h.fetches.at(-1) ?? "", /after=946684800000/);
  const early = await ok([
    "task",
    "search",
    "Shared title",
    "--historical",
    "--before",
    "2000-01-01",
  ]);
  assert.deepEqual(early.data.matches, []);
  assert.match(h.fetches.at(-1) ?? "", /before=946684800000/);
  for (const bad of ["yesterday", "-5", "2000-13-45"])
    assert.equal(
      (await h.run(["task", "search", "x", "--after", bad])).code,
      2,
      bad,
    );
  assert.equal(
    (await h.run(["task", "search", "x", "--type", "bogus"])).code,
    2,
  );
  assert.equal((await h.run(["task", "search", " "])).code, 2);

  // Paging by token, then a stale token.
  const seen: string[] = [];
  let token: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = await ok([
      "task",
      "search",
      "Alpha work",
      "--historical",
      "--limit",
      "40",
      ...(token ? ["--cursor", token] : []),
    ]);
    assert.equal(page.data.nextCursor, undefined);
    seen.push(...page.data.matches.map((m: Json) => m.recordId));
    token = page.pagination.nextCursor ?? undefined;
    assert.equal(page.coverage.complete, token === undefined);
    assert.deepEqual(page.coverage.notes, ["retained records only"]);
    if (!token) break;
  }
  assert.equal(seen.length, 119);
  assert.equal(new Set(seen).size, 119);
  const clamp = await ok([
    "task",
    "search",
    "Alpha",
    "--limit",
    "200",
    "--historical",
  ]);
  assert.equal(clamp.pagination.limit, 50);
  assert.ok(clamp.coverage.gaps.includes("limit-capped"));
  const stale = await h.run([
    "task",
    "search",
    "Alpha work",
    "--historical",
    "--cursor",
    forge(
      "task search",
      cursorQuery({ query: "Alpha work", historical: true }),
      randomUUID(),
    ),
    "--output",
    "json",
  ]);
  assert.equal(stale.code, 4);
  assert.equal(stale.json().error.code, "cursor-stale");
  const direct = await api(
    "/api/operator/search?query=Shared%20title&historical=true&limit=50",
  );
  assert.deepEqual(all.data, strip(direct));
});

test("task messages page and task get reports coverage", async (t) => {
  const { s, seed, h, ok, api } = await setup(t);
  const id = seed.betaSharedTaskId;
  const total = (await api(`/api/operator/tasks/${id}/messages`)).total;
  assert.ok(total >= 5);
  const seen: string[] = [];
  const sizes: number[] = [];
  let token: string | undefined;
  do {
    const before = h.fetches.length;
    const page = await ok([
      "task",
      "messages",
      id,
      "--limit",
      "2",
      ...(token ? ["--cursor", token] : []),
    ]);
    assert.equal(h.fetches.length - before, 2);
    assert.equal(page.data.total, total);
    assert.equal(page.pagination.maxLimit, 200);
    seen.push(...page.data.messages.map((m: Json) => m.eventId));
    sizes.push(page.data.messages.length);
    token = page.pagination.nextCursor ?? undefined;
  } while (token);
  assert.equal(seen.length, total);
  assert.equal(sizes[0], 2);
  const direct = await api(`/api/operator/tasks/${id}/messages?limit=200`);
  assert.deepEqual(
    seen,
    direct.messages.map((m: Json) => m.eventId),
  );
  const human = await h.run(["task", "messages", id, "--limit", "2"]);
  assert.match(human.out, /Operator message \d/);
  assert.match(human.out, /^Gap: more-pages$/m);
  assert.match(
    human.out,
    new RegExp(`^More: ensemble task messages ${id} --limit 2 --cursor `, "m"),
  );
  assert.equal((await h.run(["task", "messages", "nope"])).code, 2);
  const missing = await h.run([
    "task",
    "messages",
    randomUUID(),
    "--output",
    "json",
  ]);
  assert.equal(missing.json().error.code, "not-found");

  const got = await ok(["task", "get", s.taskId]);
  assert.equal(got.coverage.complete, true);
  assert.deepEqual(got.coverage.gaps, []);
  assert.equal(typeof got.coverage.observedAt, "number");
  assert.equal(got.pagination, undefined);
  const text = await h.run(["task", "get", s.taskId]);
  assert.match(text.out, /^Inspect me\nTask: +/);
});

const cells = (line: string) => line.trim().split(/ {2,}/);

test("task get names the lead assignment, execution and who acts next", async (t) => {
  const { s, seed, h, ok, api } = await setup(t);
  const line = (out: string, label: string) =>
    out.split("\n").find((l) => l.startsWith(`${label}:`));
  const id = seed.betaSharedTaskId;
  const json = await ok(["task", "get", id]);
  assert.deepEqual(json.data, await api(`/api/operator/tasks/${id}`));
  const leadAssignmentId = json.data.leadAssignmentId as string;
  assert.match(leadAssignmentId, /^[0-9a-f-]{36}$/);
  const human = (await h.run(["task", "get", id])).out;
  assert.deepEqual(cells(line(human, "Lead") ?? ""), [
    `Lead:`,
    `Task lead (assignment ${leadAssignmentId})`,
  ]);
  assert.match(line(human, "Execution") ?? "", /^Execution: +\S+/);
  assert.match(line(human, "Next") ?? "", /^Next: +\S/);
  assert.doesNotMatch(line(human, "State") ?? "", /\bopen\b/);
  assert.match(
    line(human, "State") ?? "",
    /^State: +(Ready|Running|Waiting|Paused|Stopping|Uncertain|Draft|Done|Cancelled)\b/,
  );

  // A lead name the service withholds reads as unavailable, never `null`.
  const withheld = await h.run(["task", "get", id], {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).endsWith(`/api/operator/tasks/${id}`)) return response;
      const body = (await response.json()) as Json;
      body.data.lead.name = null;
      return new Response(JSON.stringify(body), {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.match(
    line(withheld.out, "Lead") ?? "",
    new RegExp(
      `^Lead: +\\(unavailable\\) \\(assignment ${leadAssignmentId}\\)$`,
    ),
  );
  // A project with no lead has no Lead line; its Waiting line says so.
  const bare = (await h.run(["task", "get", s.taskId])).out;
  assert.equal(line(bare, "Lead"), undefined);
  assert.match(bare, /^Waiting: .*lead/im);
  // State is the UI's column word, never the raw task state.
  for (const [taskId, column] of [
    [seed.doneTaskId, "Done"],
    [seed.cancelledTaskId, "Cancelled"],
    [
      seed.alphaSharedTaskId,
      taskColumnOf((await ok(["task", "get", seed.alphaSharedTaskId])).data),
    ],
  ] as const)
    assert.equal(
      line((await h.run(["task", "get", taskId])).out, "State"),
      `State:   ${column}`,
    );
  // An operator-owned question reads "you" and names the Inbox command.
  const q = await seedOwnQuestion(s.f);
  const asked = (await h.run(["task", "get", q.taskId])).out;
  const projectId = (await ok(["task", "get", q.taskId])).data.task.projectId;
  assert.deepEqual(cells(line(asked, "Next") ?? ""), [
    "Next:",
    `you · answer question (ensemble inbox list --project ${projectId})`,
  ]);
  // A task nobody needs to act on does not name the Inbox.
  assert.ok(!(line(bare, "Next") ?? "").includes("ensemble inbox"));
});

const COLUMN_WORDS =
  /^(Ready|Running|Waiting|Paused|Stopping|Uncertain|Draft|Done|Cancelled)\b/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The header and the `count` rows after it, as cells. */
const tableCells = (out: string, count?: number) => {
  const lines = out.split("\n");
  const end = count === undefined ? lines.length : count + 1;
  return lines.slice(0, end).map(cells);
};

test("task list leads with the title and ends with the task id", async (t) => {
  const { s, seed, h, ok, api } = await setup(t);
  const q = await seedOwnQuestion(s.f);
  const json = await ok(["task", "list", "--limit", "100"]);
  const human = await h.run(["task", "list", "--limit", "100"]);
  assert.equal(human.code, 0, human.err);
  const [header, ...rows] = tableCells(human.out, json.data.tasks.length);
  assert.deepEqual(header, [
    "Title",
    "Project",
    "State",
    "Next",
    "Lead",
    "Task id",
  ]);
  assert.equal(rows.length, json.data.tasks.length);
  json.data.tasks.forEach((task: Json, i: number) => {
    const row = rows[i] ?? [];
    assert.equal(row.length, 6, task.id);
    assert.equal(row.at(-1), task.id);
    assert.match(row.at(-1) ?? "", UUID);
    assert.equal(row[1], task.project.name);
    assert.equal(row[4], task.lead ? task.lead.name : "none");
    assert.match(row[2] ?? "", COLUMN_WORDS);
    // No project id anywhere: the project is named, and the id stays in JSON.
    assert.ok(!human.out.includes(task.projectId), task.projectId);
  });
  assert.doesNotMatch(human.out, /Attention|Execution|Runtime:/);
  assert.ok(rows.some((r) => r[4] === "Alpha lead"));
  // A project without a lead reads `none`.
  const bare = await h.run(["task", "list", "--project", s.projectId]);
  assert.equal(
    tableCells(bare.out).find((r) => r.at(-1) === s.taskId)?.[3],
    "none",
  );

  // Filtering by project drops the column, and the id with it.
  const beta = await h.run(["task", "list", "--project", seed.betaId]);
  assert.equal(beta.code, 0, beta.err);
  assert.deepEqual(cells(beta.out.split("\n")[0] ?? ""), [
    "Title",
    "State",
    "Next",
    "Lead",
    "Task id",
  ]);
  assert.ok(beta.out.includes(seed.betaSharedTaskId));
  assert.ok(!beta.out.includes(seed.betaId));

  // An operator-owned question reads "you · answer question".
  const projectId = (await api(`/api/operator/tasks/${q.taskId}`)).task
    .projectId;
  const asked = await h.run(["task", "list", "--project", projectId]);
  const row = tableCells(asked.out).find((r) => r.at(-1) === q.taskId);
  assert.equal(row?.[2], "you · answer question");
  // The data is what the direct API returns (also covered by the list data test).
  assert.deepEqual(
    strip(json.data),
    strip(await api("/api/operator/task-list?limit=100")),
  );
});

test("task search puts the title first and drops the project under --project", async (t) => {
  const { seed, h, ok } = await setup(t);
  const query = ["task", "search", "Shared title", "--historical"];
  const all = await h.run(query);
  assert.equal(all.code, 0, all.err);
  const json = await ok(query);
  const [header, ...rows] = tableCells(all.out, json.data.matches.length);
  assert.deepEqual(header, [
    "Title",
    "Project",
    "Type",
    "Created",
    "Excerpt",
    "Task id",
  ]);
  json.data.matches.forEach((m: Json, i: number) => {
    assert.equal(rows[i]?.[0], m.taskTitle);
    assert.equal(rows[i]?.[1], m.projectName);
    assert.equal(rows[i]?.at(-1), m.taskId);
    assert.ok(!all.out.includes(m.projectId), m.projectId);
  });
  const scoped = await h.run([...query, "--project", seed.alphaId]);
  assert.equal(scoped.code, 0, scoped.err);
  const scopedJson = await ok([...query, "--project", seed.alphaId]);
  assert.deepEqual(tableCells(scoped.out, 1)[0], [
    "Title",
    "Type",
    "Created",
    "Excerpt",
    "Task id",
  ]);
  assert.ok(!scoped.out.includes(seed.alphaId));
  assert.ok(scoped.out.includes(seed.alphaSharedTaskId));
  // Coverage is unchanged by the layout.
  assert.deepEqual(
    scopedJson.coverage.gaps,
    json.coverage.gaps.filter((g: string) => g !== "more-pages"),
  );
  assert.match(all.out, /^Note: retained records only$/m);
});

test("project and profile lists show the lead by name and the runtime only when unavailable", async (t) => {
  const { s, seed, h, api } = await setup(t);
  const projects = await h.run(["project", "list"]);
  assert.equal(projects.code, 0, projects.err);
  const rows = tableCells(projects.out, 3);
  assert.deepEqual(rows[0], [
    "Name",
    "Lead",
    "Paused",
    "Version",
    "Project id",
  ]);
  const alpha = rows.find((r) => r.at(-1) === seed.alphaId);
  assert.equal(alpha?.[0], "Alpha");
  assert.equal(alpha?.[1], "Alpha lead");
  const bare = rows.find((r) => r.at(-1) === s.projectId);
  assert.equal(bare?.[1], "none");
  assert.doesNotMatch(projects.out, /Lead profile|Runtime:/);
  assert.ok(!projects.out.includes(seed.alphaLeadId));

  const profiles = await h.run(["profile", "list"]);
  assert.equal(profiles.code, 0, profiles.err);
  const profileRows = tableCells(profiles.out, 2);
  assert.deepEqual(profileRows[0], [
    "Name",
    "Revoked",
    "Version",
    "Summary",
    "Profile id",
  ]);
  assert.ok(profileRows.some((r) => r.at(-1) === seed.alphaLeadId));
  assert.doesNotMatch(profiles.out, /Runtime:/);

  const got = await h.run(["project", "get", seed.alphaId]);
  assert.match(got.out, /^Lead: +Alpha lead$/m);
  assert.doesNotMatch(got.out, /Lead profile/);
  assert.ok(
    got.out.split("\n").some((l) => /^Alpha lead +[0-9a-f-]{36}$/.test(l)),
    got.out,
  );

  // An unavailable runtime is stated last; the JSON is what the service sent.
  const since = 1_700_000_000_000;
  const workspace = await api("/api/operator/workspace");
  const down = { state: "unavailable", since };
  const unavailable: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (!String(input).endsWith("/api/operator/workspace")) return response;
    const body = (await response.json()) as Json;
    body.data.runtime = down;
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
  for (const area of ["project", "profile"]) {
    const text = await h.run([area, "list"], { fetch: unavailable });
    assert.equal(
      text.out.trimEnd().split("\n").at(-1),
      `Runtime: unavailable since ${new Date(since).toISOString()}`,
    );
    const asJson = await h.run([area, "list", "--output", "json"], {
      fetch: unavailable,
    });
    assert.deepEqual(asJson.json().data.runtime, down);
    assert.deepEqual(asJson.json().data[`${area}s`], workspace[`${area}s`]);
  }
});

test("list data equals the direct API data without paging internals", async (t) => {
  const { seed, ok, api } = await setup(t);
  const cases: [string[], string][] = [
    [["task", "list", "--limit", "30"], "/api/operator/task-list?limit=30"],
    [
      [
        "task",
        "list",
        "--project",
        seed.alphaId,
        "--state",
        "open",
        "--limit",
        "7",
      ],
      `/api/operator/task-list?limit=7&projectId=${seed.alphaId}&state=open`,
    ],
    [
      ["task", "messages", seed.betaSharedTaskId, "--limit", "3"],
      `/api/operator/tasks/${seed.betaSharedTaskId}/messages?limit=3`,
    ],
    [
      ["task", "search", "needle", "--type", "result", "--historical"],
      "/api/operator/search?query=needle&type=result&historical=true&limit=50",
    ],
  ];
  for (const [args, path] of cases) {
    const out = await ok(args);
    assert.deepEqual(out.data, strip(await api(path)), path);
  }
});

test("browse reads are read-only, capability gated and refuse managed assignments", async (t) => {
  const { s, seed, h, read, ok } = await setup(t);
  const commands: string[][] = [
    ["project", "list"],
    ["profile", "list"],
    ["project", "get", seed.alphaId],
    ["profile", "get", seed.alphaLeadId],
    ["task", "list"],
    ["task", "search", "Shared title", "--historical"],
    ["task", "messages", seed.betaSharedTaskId],
  ];
  const before = databaseDigest(s.f);
  for (const args of commands) {
    const out = await ok(args);
    assert.equal(out.schema, "ensemble.cli/v1");
    assert.equal(typeof out.coverage.observedAt, "number");
    assert.equal(typeof out.coverage.complete, "boolean");
    assert.ok(Array.isArray(out.coverage.gaps));
    assert.ok(Array.isArray(out.coverage.notes));
    assert.ok((await h.run(args)).out.length > 0);
  }
  await ok(["task", "get", seed.alphaSharedTaskId]);
  assert.equal(databaseDigest(s.f), before);

  // Managed assignments get no request at all.
  const requests = h.fetches.length;
  for (const args of commands) {
    const r = await h.run(args, {
      env: {
        ENSEMBLE_CLI_CONFIG_DIR: h.configDir,
        ENSEMBLE_MANAGED_ASSIGNMENT: "1",
      },
    });
    assert.equal(r.code, 3, args.join(" "));
    assert.match(r.err, /managed-assignment/);
  }
  assert.equal(h.fetches.length, requests);

  // A service without the capability family is unsupported after identity only.
  const installationId = randomUUID();
  const fake = await fakeServer(t, (_q, response) =>
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        apiVersion: 1,
        capabilities: ["cli.identity", "task.read"],
        service: { installationId, origin: "https://ensemble.example" },
        credential: {
          id: randomUUID(),
          name: "fake",
          scope: "read",
          createdAt: 1,
          expiresAt: Date.now() + 86_400_000,
        },
      }),
    ),
  );
  let r = await h.run([
    "auth",
    "login",
    "--connection",
    "fake",
    "--url",
    fake.origin,
    "--token-file",
    h.tokenFile(read.token),
  ]);
  assert.equal(r.code, 0, r.err);
  assert.equal(fake.hits.length, 1);
  for (const args of commands) {
    const seenHits: number = fake.hits.length;
    r = await h.run([...args, "--connection", "fake", "--output", "json"]);
    assert.equal(r.code, 7, args.join(" "));
    assert.equal(r.json().error.code, "unsupported-service");
    assert.equal(fake.hits.length, seenHits + 1, "only the identity request");
    assert.match(fake.hits.at(-1) ?? "", /^GET \/api\/operator\/cli /);
  }

  assert.equal((await h.run(["task", "list", "extra"])).code, 2);
  for (const text of h.outputs) assert.ok(!text.includes(read.token));
});
