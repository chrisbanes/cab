import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { startCliOperator } from "../fixtures/operator-cli.js";

const create = (name: string) => ({
  type: "project.create",
  key: randomUUID(),
  projectId: randomUUID(),
  name,
  leadProfileId: null,
});

test("a duplicate project name is refused over HTTP with the field and the existing name", async (t) => {
  const { s } = await startCliOperator(t);
  const response = await s.sessionPost(
    "/api/operator/commands",
    create("cli PROJECT "),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: {
      code: "invalid-input",
      message: "Another project is named CLI project. Choose a different name.",
      fieldPaths: ["name"],
    },
  });
  // Nothing was recorded.
  const workspace = (await (
    await s.sessionGet("/api/operator/workspace")
  ).json()) as { data: { projects: unknown[] } };
  assert.equal(workspace.data.projects.length, 1);
});

test("a rename into another project's name is refused over HTTP and its own name saves", async (t) => {
  const { s, d } = await startCliOperator(t);
  const other = randomUUID();
  d.execute({
    ...create("Relay"),
    projectId: other,
    actor: "operator",
  } as never);
  const configure = (name: string) =>
    s.sessionPost("/api/operator/commands", {
      type: "project.configure",
      key: randomUUID(),
      projectId: other,
      expectedVersion: Number(d.project(other).version),
      name,
    });
  const refused = await configure("cli project");
  assert.equal(refused.status, 400);
  assert.deepEqual(((await refused.json()) as { error: unknown }).error, {
    code: "invalid-input",
    message: "Another project is named CLI project. Choose a different name.",
    fieldPaths: ["name"],
  });
  assert.equal(d.project(other).name, "Relay");
  assert.equal((await configure("RELAY")).status, 200);
  assert.equal(d.project(other).name, "RELAY");
});

test("the duplicate message names the other project up to the 256-character limit, then falls back", async (t) => {
  const { s, d } = await startCliOperator(t);
  // "Another project is named " + name + ". Choose a different name." is 256 characters at 205.
  for (const [length, message] of [
    [
      205,
      `Another project is named ${"L".repeat(205)}. Choose a different name.`,
    ],
    [206, "Another project has this name. Choose a different name."],
    [300, "Another project has this name. Choose a different name."],
  ] as const) {
    d.execute({
      ...create("L".repeat(length)),
      actor: "operator",
    } as never);
    const response = await s.sessionPost(
      "/api/operator/commands",
      create("l".repeat(length)),
    );
    assert.equal(response.status, 400, String(length));
    assert.deepEqual(((await response.json()) as { error: unknown }).error, {
      code: "invalid-input",
      message,
      fieldPaths: ["name"],
    });
  }
});

test("the CLI reports a duplicate project name with the field, a fix line and exit 2", async (t) => {
  const { h, cli } = await startCliOperator(t);
  const doc = join(h.dir, "doc.json");
  const prepared = await cli("ro", [
    "project",
    "prepare-create",
    "--name",
    "CLI PROJECT",
    "--out",
    doc,
  ]);
  assert.equal(prepared.code, 0, prepared.err + prepared.out);
  const human = await h.run([
    "project",
    "apply",
    "--file",
    doc,
    "--connection",
    "rw",
  ]);
  assert.equal(human.code, 2, human.err + human.out);
  assert.match(
    human.err,
    /Another project is named CLI project\. Choose a different name\. Fields: name/,
  );
  assert.match(human.err, /Fix:/);
  const json = await cli("rw", ["project", "apply", "--file", doc]);
  assert.equal(json.code, 2);
  assert.equal(json.json().error.code, "invalid-input");
});

test("project list returns duplicates by id and its table and JSON keep their shape", async (t) => {
  const { s, h, cli, d } = await startCliOperator(t);
  // Created in descending id order, so insertion order is not id order.
  const ids = [
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000001",
  ];
  for (const [index, projectId] of ids.entries())
    d.execute({
      ...create(`Seed ${index}`),
      projectId,
      actor: "operator",
    } as never);
  // Predates the rule: duplicates written straight into storage.
  s.f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_projects SET name = 'Atlas' WHERE id IN (?, ?)")
      .run(...ids),
  );
  const workspace = (await (
    await s.sessionGet("/api/operator/workspace")
  ).json()) as { data: { projects: { id: string; name: string }[] } };
  const listed = await cli("ro", ["project", "list"]);
  assert.equal(listed.code, 0, listed.err);
  assert.deepEqual(listed.json().data.projects, workspace.data.projects);
  const atlas = listed
    .json()
    .data.projects.filter((p: { name: string }) => p.name === "Atlas")
    .map((p: { id: string }) => p.id);
  assert.deepEqual(atlas, [...ids].sort());
  const table = await h.run(["project", "list", "--connection", "ro"]);
  assert.match(
    table.out.split("\n")[0] ?? "",
    /^Name\s+Lead\s+Paused\s+Version\s+Project id$/,
  );
});
