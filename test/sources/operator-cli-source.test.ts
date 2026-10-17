import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  removesAllAccess,
  sourceCommand,
  sourceRowsFrom,
} from "../../web/src/settings-changes.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import { startCliOperator } from "../fixtures/operator-cli.js";
import {
  createCheckout,
  seedSettingsWorld,
} from "../fixtures/operator-settings.js";

process.env.FIXTURE_GITHUB = "test-only-github-source-token";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes are asserted structurally
type Json = Record<string, any>;

const PRIVATE = [
  "PRIVATE SAVED QUERY",
  "PRIVATE FILTER",
  "FIXTURE_GITHUB",
  "test-only-github-source-token",
];

async function world(t: Parameters<typeof startCliOperator>[0]) {
  const o = await startCliOperator(t, {
    previewReader: () => ({
      async readSelection() {
        return { complete: true, issues: [], reason: null };
      },
    }),
  });
  const ids = await seedSettingsWorld(o.s.f);
  const config = async (projectId = ids.atlas) =>
    (
      (await (
        await o.s.sessionGet(
          `/api/operator/projects/${projectId}/configuration`,
        )
      ).json()) as Json
    ).data;
  const ok = async (connection: "ro" | "rw", args: string[], extra = {}) => {
    const r = await o.cli(connection, args, extra);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}${r.out}`);
    return r.json() as Json;
  };
  const journal = join(o.h.configDir, "requests.jsonl");
  return { ...o, ids, config, ok, journal };
}

test("project sources reads selections, links and observations without private text", async (t) => {
  const w = await world(t);
  const before = databaseDigest(w.s.f);
  const json = await w.ok("ro", ["project", "sources", w.ids.atlas]);
  const human = await w.h.run([
    "project",
    "sources",
    w.ids.atlas,
    "--connection",
    "ro",
  ]);
  assert.equal(human.code, 0, human.err);
  for (const text of [JSON.stringify(json), human.out]) {
    for (const secret of [...PRIVATE, w.ids.checkout])
      assert.ok(!text.includes(secret), secret);
  }
  assert.deepEqual(json.data.source, (await w.config()).source);
  assert.deepEqual(
    json.data.source.selections.map((s: Json) => [s.id, s.active]),
    [
      ["S-1", false],
      ["S-2", false],
      ["S-3", false],
    ],
  );
  assert.deepEqual(json.coverage.gaps, []);
  assert.deepEqual(
    json.data.observations.map((o: Json) => o.state),
    ["never", "never", "never"],
  );
  assert.match(human.out, /S-2 +Search +\(query private\)/);
  assert.match(human.out, /acme\/atlas +main/);
  assert.match(human.out, /Closed issues:? +Skip closed issues/);
  assert.equal(databaseDigest(w.s.f), before);
  // A partial provider read is an evidence gap, not a complete observation.
  const activated = await w.s.sessionPost("/api/operator/commands", {
    type: "github.preview",
    key: randomUUID(),
    projectId: w.ids.atlas,
    selectionId: "S-1",
    expectedVersion: json.data.source.version,
  });
  assert.equal(activated.status, 200);
  const sources = w.s.f.service.githubSources();
  sources.reconcileSelection(w.ids.atlas, "S-1", {
    complete: true,
    issues: [1, 2, 3].map((n) => ({
      providerInstance: "github.com" as const,
      nodeId: `I_${n}`,
      repositoryId: "acme/atlas",
      repositoryName: "acme/atlas",
      number: n,
      title: `Issue ${n}`,
      body: "Scope",
      state: "open" as const,
      labels: [],
      projectFields: [],
    })),
    reason: null,
  });
  const counted = databaseDigest(w.s.f);
  const complete = await w.ok("ro", ["project", "sources", w.ids.atlas]);
  const humanCounts = await w.h.run([
    "project",
    "sources",
    w.ids.atlas,
    "--connection",
    "ro",
  ]);
  assert.deepEqual(complete.data.observations[0].counts, {
    observed: 3,
    open: 3,
    closedSkipped: 0,
    matching: 0,
    complete: true,
  });
  assert.equal(complete.data.readinessRule.kind, "rule");
  assert.match(humanCounts.out, /3 observed · 3 open · 0 match label `ready`/);
  assert.match(
    humanCounts.out,
    /^S-1: No open item matches the readiness rule \(label `ready`\); imported tasks stay Draft until one does\. Change readiness with 'ensemble project prepare-source'\.$/m,
  );
  for (const secret of [...PRIVATE, w.ids.checkout])
    assert.ok(!humanCounts.out.includes(secret), secret);
  assert.equal(databaseDigest(w.s.f), counted);
  sources.reconcileSelection(w.ids.atlas, "S-1", {
    complete: false,
    issues: [],
    reason: "rate-limited",
  });
  const partial = await w.ok("ro", ["project", "sources", w.ids.atlas]);
  assert.equal(partial.data.observations[0].state, "partial");
  assert.deepEqual(partial.coverage.gaps, ["evidence-gap"]);
  const humanPartial = await w.h.run([
    "project",
    "sources",
    w.ids.atlas,
    "--connection",
    "ro",
  ]);
  assert.match(humanPartial.out, /partial read; counts may be incomplete/);
  assert.doesNotMatch(humanPartial.out, /No open item matches/);
  assert.equal(existsSync(w.journal), false);
});

test("project sources and prepare-source show and round-trip no readiness rule, never inferring it from an unavailable rule", async (t) => {
  const w = await world(t);
  const prepare = async (projectId: string, edit: unknown) => {
    const out = join(w.h.dir, `${randomUUID()}.json`);
    const r = await w.cli("ro", [
      "project",
      "prepare-source",
      projectId,
      "--out",
      out,
      "--edit-file",
      w.file(`${randomUUID()}.edit`, JSON.stringify(edit)),
    ]);
    return {
      code: r.code,
      out,
      document: r.code === 0 ? JSON.parse(readFileSync(out, "utf8")) : null,
    };
  };
  // A project never given a rule shows none and keeps none.
  const relay = await w.ok("ro", ["project", "sources", w.ids.relay]);
  assert.deepEqual(relay.data.source.readiness, { kind: "none" });
  assert.ok(!relay.coverage.gaps.includes("content-unavailable"));
  const relayHuman = await w.h.run([
    "project",
    "sources",
    w.ids.relay,
    "--connection",
    "ro",
  ]);
  assert.match(relayHuman.out, /No readiness rule/);
  const kept = await prepare(w.ids.relay, { closedIssues: "done" });
  assert.equal(kept.document.command.readiness, null);
  // An omitted readiness keeps a saved rule as a command value, without the read's kind.
  const keptRule = await prepare(w.ids.atlas, { closedIssues: "done" });
  assert.deepEqual(keptRule.document.command.readiness, {
    mode: "all",
    conditions: [{ kind: "label", name: "ready" }],
  });
  // `null` removes the rule, and applying it reads back as none.
  const removed = await prepare(w.ids.atlas, { readiness: null });
  assert.equal(removed.document.command.readiness, null);
  assert.deepEqual(removed.document.preview.diff.lines, [
    "Readiness: no readiness rule",
  ]);
  await w.ok("rw", ["project", "apply", "--file", removed.out]);
  assert.deepEqual((await w.config()).source.readiness, { kind: "none" });
  // A rule naming private text is withheld: unknown, and an edit must replace it.
  const r = await w.s.sessionPost("/api/operator/commands", {
    type: "github.configure",
    key: randomUUID(),
    projectId: w.ids.relay,
    expectedVersion: (await w.config(w.ids.relay)).source.version,
    credentialRef: "env:FIXTURE_GITHUB",
    selections: [],
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", name: "FIXTURE_GITHUB" }],
    },
    repositories: [],
  });
  assert.equal(r.status, 200);
  const hidden = await w.ok("ro", ["project", "sources", w.ids.relay]);
  assert.deepEqual(hidden.data.source.readiness, { kind: "unavailable" });
  assert.ok(hidden.coverage.gaps.includes("content-unavailable"));
  const hiddenHuman = await w.h.run([
    "project",
    "sources",
    w.ids.relay,
    "--connection",
    "ro",
  ]);
  assert.match(hiddenHuman.out, /\(unavailable\)/);
  assert.doesNotMatch(hiddenHuman.out, /No readiness rule/);
  assert.equal((await prepare(w.ids.relay, { closedIssues: "done" })).code, 4);
  const replaced = await prepare(w.ids.relay, { readiness: null });
  assert.equal(replaced.document.command.readiness, null);
  assert.deepEqual(replaced.document.preview.diff.lines, [
    "Readiness: no readiness rule (replaces unavailable readiness)",
  ]);
});

test("prepare-source writes the exact UI command with redacted preview lines", async (t) => {
  const w = await world(t);
  const edit = {
    addSelections: [
      { kind: "repository", repositoryId: "acme/x", owner: "acme", name: "x" },
      { kind: "search", query: "NEW PRIVATE QUERY" },
    ],
    removeSelections: ["S-2"],
    readiness: {
      mode: "any",
      conditions: [
        { kind: "label", name: "ready" },
        { kind: "label", name: "go" },
      ],
    },
    setRefs: { "acme/atlas": "dev" },
  };
  const out = join(w.h.dir, "source.json");
  const before = databaseDigest(w.s.f);
  const prepared = await w.ok("ro", [
    "project",
    "prepare-source",
    w.ids.atlas,
    "--out",
    out,
    "--edit-file",
    w.file("edit.json", JSON.stringify(edit)),
  ]);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  const document = JSON.parse(readFileSync(out, "utf8"));
  const source = (await w.config()).source;
  assert.deepEqual(document.command, {
    type: "github.configure",
    projectId: w.ids.atlas,
    expectedVersion: source.version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-3", keep: true },
      {
        id: "S-4",
        kind: "repository",
        repositoryId: "acme/x",
        owner: "acme",
        name: "x",
      },
      { id: "S-5", kind: "search", query: "NEW PRIVATE QUERY" },
    ],
    readiness: edit.readiness,
    closedIssues: "skip",
    repositories: [{ repositoryId: "acme/atlas", ref: "dev" }],
  });
  assert.deepEqual(document.preview.diff.lines, [
    "− S-2 · Search",
    "+ S-4 · Repository acme/x · added inactive",
    "+ S-5 · Search (query private) · added inactive",
    "Readiness: any of 2 conditions",
    "Ref for acme/atlas: main → dev",
  ]);
  const shown =
    JSON.stringify(document.preview) +
    JSON.stringify(prepared.data.document.preview);
  for (const secret of [...PRIVATE, "NEW PRIVATE QUERY", w.ids.checkout])
    assert.ok(!shown.includes(secret), secret);
  assert.ok(
    document.preview.notes.some((n: string) =>
      /inactive until it is previewed/.test(n),
    ),
  );
  assert.ok(
    document.preview.notes.some((n: string) =>
      /discards its saved definition/.test(n),
    ),
  );
  assert.equal(databaseDigest(w.s.f), before);
  assert.equal(existsSync(w.journal), false);

  const modeOut = join(w.h.dir, "mode-source.json");
  await w.ok("ro", [
    "project",
    "prepare-source",
    w.ids.atlas,
    "--out",
    modeOut,
    "--edit-file",
    w.file("mode.json", JSON.stringify({ closedIssues: "done" })),
  ]);
  const mode = JSON.parse(readFileSync(modeOut, "utf8"));
  assert.equal(mode.command.closedIssues, "done");
  assert.deepEqual(mode.preview.diff.lines, [
    "Closed issues: Treat closure as Done",
  ]);

  // Parity: the operator UI builds the same command for the same edit.
  const rows = sourceRowsFrom(source);
  const ui = sourceCommand(w.ids.atlas, {
    key: "k",
    expectedVersion: String(source.version),
    selections: JSON.stringify([
      ...rows.selections.map((r) =>
        r.id === "S-2" ? { ...r, removed: true } : r,
      ),
      {
        id: "S-4",
        kind: "repository",
        repositoryId: "acme/x",
        owner: "acme",
        name: "x",
      },
      { id: "S-5", kind: "search", query: "NEW PRIVATE QUERY" },
    ]),
    repositories: JSON.stringify(
      rows.repositories.map((r) => ({
        repositoryId: r.repositoryId,
        ref: "dev",
        keep: true,
      })),
    ),
    conditions: JSON.stringify(edit.readiness.conditions),
    mode: "any",
    closedIssues: rows.closedIssues,
  });
  const { key: _key, ...uiCommand } = ui;
  assert.deepEqual(uiCommand, document.command);
  assert.equal(
    removesAllAccess(source, {
      repositories: JSON.stringify([{ removed: true }]),
    }),
    true,
  );

  // Rejected edits write nothing.
  const reject = async (code: number, body: unknown, extra: string[] = []) => {
    const target = join(w.h.dir, `${randomUUID()}.json`);
    const r = await w.cli("ro", [
      "project",
      "prepare-source",
      w.ids.atlas,
      "--out",
      target,
      "--edit-file",
      typeof body === "string"
        ? body
        : w.file(`${randomUUID()}.json`, JSON.stringify(body)),
      ...extra,
    ]);
    assert.equal(r.code, code, `${JSON.stringify(body)}: ${r.out}`);
    assert.equal(existsSync(target), false);
  };
  await reject(4, edit, ["--expected-version", String(source.version + 1)]);
  await reject(2, {});
  await reject(2, { removeSelections: ["S-9"] });
  await reject(2, { removeSelections: ["S-1", "S-1"] });
  await reject(2, {
    addSelections: [{ id: "S-9", kind: "search", query: "q" }],
  });
  await reject(2, { unlinkRepositories: ["acme/atlas"] });
  await reject(2, {
    linkRepositories: [{ repositoryId: "acme/atlas", path: "/x", ref: "main" }],
  });
  await reject(2, { surprise: true });
  await reject(2, { closedIssues: "closed" });
  await reject(2, { credentialRef: "gh:example.com" });
  await reject(2, { credentialRef: "gh:" });
  await reject(2, { credentialRef: "GH:github.com" });
  await reject(2, w.file("bad.json", "{not json"));
  const link = join(w.h.dir, "link.json");
  symlinkSync(w.file("real.json", JSON.stringify(edit)), link);
  await reject(2, link);
  // A saved selection this read cannot name blocks preparation.
  const secret = "PRIVATE FIELDNOTES INSTRUCTIONS";
  const fieldnotes = w.ids.fieldnotes;
  const r = await w.s.sessionPost("/api/operator/commands", {
    type: "github.configure",
    key: randomUUID(),
    projectId: fieldnotes,
    expectedVersion: (await w.config(fieldnotes)).source.version,
    selections: [{ id: secret, kind: "search", query: "q" }],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [],
  });
  assert.equal(r.status, 200);
  const hidden = await w.ok("ro", ["project", "sources", fieldnotes]);
  assert.equal(hidden.data.source.selections[0].id, null);
  assert.ok(hidden.coverage.gaps.includes("content-unavailable"));
  assert.equal(
    (
      await w.cli("ro", [
        "project",
        "prepare-source",
        fieldnotes,
        "--out",
        join(w.h.dir, "hidden.json"),
        "--edit-file",
        w.file(
          "hidden-edit.json",
          JSON.stringify({ addSelections: [{ kind: "search", query: "q" }] }),
        ),
      ])
    ).code,
    4,
  );
});

test("source credential edits accept the shared env/gh contract and keep omission distinct from Clear", async (t) => {
  const w = await world(t);
  const source = (await w.config()).source;
  const prepare = async (body: unknown, name: string) => {
    const out = join(w.h.dir, name);
    const result = await w.ok("ro", [
      "project",
      "prepare-source",
      w.ids.atlas,
      "--out",
      out,
      "--edit-file",
      w.file(`${name}.edit`, JSON.stringify(body)),
    ]);
    return { out: JSON.parse(readFileSync(out, "utf8")), result };
  };
  const omitted = await prepare(
    { setRefs: { "acme/atlas": "dev" } },
    "omitted.json",
  );
  assert.equal("credentialRef" in omitted.out.command, false);
  const env = await prepare({ credentialRef: "env:SOURCE_TOKEN" }, "env.json");
  assert.equal(env.out.command.credentialRef, "env:SOURCE_TOKEN");
  assert.match(JSON.stringify(env.out.preview), /environment variable/);
  assert.ok(!JSON.stringify(env.out.preview).includes("SOURCE_TOKEN"));
  const gh = await prepare({ credentialRef: "gh:github.com" }, "gh.json");
  assert.equal(gh.out.command.credentialRef, "gh:github.com");
  assert.match(JSON.stringify(gh.out.preview), /GitHub CLI/);
  assert.ok(!JSON.stringify(gh.out.preview).includes("gh:github.com"));
  const clear = await prepare({ credentialRef: null }, "clear.json");
  assert.equal(clear.out.command.credentialRef, null);
  assert.match(JSON.stringify(clear.out.preview), /cleared/);
  assert.equal((await w.config()).source.version, source.version);
});

test("project apply sends the prepared source change once, deactivating selections", async (t) => {
  const w = await world(t);
  const atlas = w.ids.atlas;
  const version = async () => (await w.config()).source.version as number;
  const preview = await w.s.sessionPost("/api/operator/commands", {
    type: "github.preview",
    key: randomUUID(),
    projectId: atlas,
    selectionId: "S-1",
    expectedVersion: await version(),
  });
  assert.equal(preview.status, 200);
  assert.equal((await w.config()).source.selections[0].active, true);
  const prepare = async (edit: unknown, name = `${randomUUID()}.json`) => {
    const out = join(w.h.dir, name);
    await w.ok("ro", [
      "project",
      "prepare-source",
      atlas,
      "--out",
      out,
      "--edit-file",
      w.file(`edit-${name}`, JSON.stringify(edit)),
    ]);
    return out;
  };
  const doc = await prepare({ removeSelections: ["S-3"] });
  const before = databaseDigest(w.s.f);
  const denied = await w.cli("ro", ["project", "apply", "--file", doc]);
  assert.equal(denied.code, 3, denied.out);
  assert.equal(databaseDigest(w.s.f), before);
  const v = await version();
  const applied = await w.ok("rw", ["project", "apply", "--file", doc]);
  assert.deepEqual(applied.data.receipt.result, {
    commandType: "github.configure",
    resourceId: atlas,
    version: v + 1,
    credentialConfigured: true,
    selectionCount: 2,
    repositoryCount: 1,
  });
  const human = await w.h.run([
    "project",
    "apply",
    "--file",
    doc,
    "--connection",
    "rw",
  ]);
  assert.equal(human.code, 0, human.err);
  assert.match(human.out, /inactive until previewed again/);
  assert.equal(await version(), v + 1, "replay applies once");
  assert.ok((await w.config()).source.selections.every((s: Json) => !s.active));

  // A change saved elsewhere after preparation is a conflict with no change.
  const stale = await prepare({ setRefs: { "acme/atlas": "dev" } });
  const r = await w.s.sessionPost("/api/operator/commands", {
    type: "github.configure",
    key: randomUUID(),
    projectId: atlas,
    expectedVersion: await version(),
    selections: [
      { id: "S-1", keep: true },
      { id: "S-2", keep: true },
    ],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
  });
  assert.equal(r.status, 200);
  const at = await version();
  assert.equal(
    (await w.cli("rw", ["project", "apply", "--file", stale])).code,
    4,
  );
  assert.equal(await version(), at);

  // Links: a real checkout applies; a missing path is a field error with no change.
  const checkout = await createCheckout(w.s.f.directory, "second");
  await w.ok("rw", [
    "project",
    "apply",
    "--file",
    await prepare({
      linkRepositories: [
        { repositoryId: "acme/second", path: checkout, ref: "main" },
      ],
      credentialRef: null,
    }),
  ]);
  const linked = await w.ok("ro", ["project", "sources", atlas]);
  assert.deepEqual(linked.data.source.repositories, [
    { repositoryId: "acme/atlas", ref: "main" },
    { repositoryId: "acme/second", ref: "main" },
  ]);
  assert.equal(linked.data.source.credentialConfigured, false);
  const missing = await w.cli("rw", [
    "project",
    "apply",
    "--file",
    await prepare({
      linkRepositories: [
        {
          repositoryId: "acme/none",
          path: join(w.h.dir, "absent"),
          ref: "main",
        },
      ],
    }),
  ]);
  assert.equal(missing.code, 2, missing.out);
  assert.match(missing.json().error.message, /Fields: repositories/);
  const set = await w.ok("rw", [
    "project",
    "apply",
    "--file",
    await prepare({ credentialRef: "env:FIXTURE_OTHER" }),
  ]);
  assert.equal(set.data.receipt.result.credentialConfigured, true);
  assert.ok(!JSON.stringify(set).includes("FIXTURE_OTHER"));
  assert.equal((await w.config()).source.credential.source, "env");
  const selectedCli = await w.ok("rw", [
    "project",
    "apply",
    "--file",
    await prepare({ credentialRef: "gh:github.com" }),
  ]);
  assert.equal(selectedCli.data.receipt.result.credentialConfigured, true);
  assert.equal((await w.config()).source.credential.source, "gh");
  assert.equal((await w.config()).source.credential.usable, false);
  const listed = await w.cli("ro", ["project", "sources", atlas]);
  assert.equal(listed.code, 0, listed.out);
  assert.equal(listed.json().data.source.credential.reason, "gh-not-installed");
  const listedHuman = await w.h.run([
    "project",
    "sources",
    atlas,
    "--connection",
    "ro",
  ]);
  assert.match(listedHuman.out, /GitHub CLI is not installed/);
  assert.ok(!listedHuman.out.includes("FIXTURE_GITHUB"));
  for (const secret of PRIVATE)
    assert.ok(!JSON.stringify(listed.json()).includes(secret));
  const beforeClear = (await w.config()).source.selections;
  const cleared = await w.ok("rw", [
    "project",
    "apply",
    "--file",
    await prepare({ credentialRef: null }),
  ]);
  assert.equal(cleared.data.receipt.result.credentialConfigured, false);
  const afterClear = (await w.config()).source;
  assert.equal(afterClear.credentialConfigured, false);
  assert.deepEqual(
    afterClear.selections.map((s: Json) => s.id),
    beforeClear.map((s: Json) => s.id),
  );
  assert.equal(
    afterClear.selections.every((s: Json) => !s.active),
    true,
  );
});

test("a lost source apply reply is reconciled and retried under the same key", async (t) => {
  const w = await world(t);
  const out = join(w.h.dir, "lost.json");
  await w.ok("ro", [
    "project",
    "prepare-source",
    w.ids.atlas,
    "--out",
    out,
    "--edit-file",
    w.file("lost-edit.json", JSON.stringify({ removeSelections: ["S-2"] })),
  ]);
  const v = (await w.config()).source.version;
  const lost = await w.cli("rw", ["project", "apply", "--file", out], {
    fetch: w.lostReply,
  });
  assert.equal(lost.code, 6, lost.out);
  const { request, message } = lost.json().error;
  assert.equal(request.scope, `project:${w.ids.atlas}`);
  assert.equal(request.type, "github.configure");
  assert.match(message, /operation get/);
  assert.match(message, new RegExp(`--request-id ${request.key}`));
  const read = await w.ok("rw", [
    "operation",
    "get",
    request.key,
    "--scope",
    request.scope,
    "--type",
    "github.configure",
  ]);
  assert.equal(read.data.state, "recorded");
  await w.s.restart();
  const again = await w.ok("rw", ["project", "apply", "--file", out]);
  assert.equal(again.request.key, request.key);
  assert.deepEqual(again.data.receipt, read.data.receipt);
  assert.equal((await w.config()).source.version, v + 1);
});

import { createFakeGh } from "../fixtures/fake-gh.js";

test("CLI source readback offers the same environment-precedence account before and after explicit gh choice", async (t) => {
  const fake = createFakeGh();
  t.after(() => fake.close());
  fake.setAccounts({
    stored: { login: "stored-account", token: "stored-cli-token" },
    tokens: {
      "cli-gh-first": "offered-account",
      "cli-github-second": "other-account",
    },
  });
  const oldGh = process.env.GH_TOKEN,
    oldGithub = process.env.GITHUB_TOKEN;
  process.env.GH_TOKEN = "cli-gh-first";
  process.env.GITHUB_TOKEN = "cli-github-second";
  t.after(() => {
    if (oldGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = oldGh;
    if (oldGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = oldGithub;
  });
  const o = await startCliOperator(t, {
    service: { ghExecutable: fake.executable },
  });
  const projectId = o.s.projectId;
  const configure = (credentialRef: string | null) =>
    o.d.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: o.d.githubConfiguration(projectId).version,
      credentialRef,
      selections: [],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [],
    });
  configure(null);
  const before = o.d.githubConfiguration(projectId);
  const start = fake.commands().length;
  const offer = await o.cli("ro", ["project", "sources", projectId]);
  assert.equal(offer.code, 0);
  assert.equal(offer.json().data.source.credential.gh.login, "offered-account");
  assert.ok(
    fake
      .commands()
      .slice(start)
      .every((command) => command === "status"),
  );
  assert.deepEqual(o.d.githubConfiguration(projectId), before);
  configure("gh:github.com");
  const selected = await o.cli("ro", ["project", "sources", projectId]);
  assert.equal(selected.code, 0);
  assert.equal(
    selected.json().data.source.credential.gh.login,
    "offered-account",
  );
  assert.equal(selected.json().data.source.credential.usable, true);
  configure(null);
  assert.equal(
    (await o.cli("ro", ["project", "sources", projectId])).json().data.source
      .credential.gh.login,
    "offered-account",
  );
  assert.equal(o.s.f.runtime.turns, 0);
});

test("project prepare-source defaults its document into the working directory", async (t) => {
  const w = await world(t);
  const cwd = mkdtempSync(join(w.h.dir, "cwd-"));
  const prepared = await w.ok(
    "ro",
    [
      "project",
      "prepare-source",
      w.ids.atlas,
      "--edit-file",
      w.file(
        "edit.json",
        JSON.stringify({
          addSelections: [{ kind: "search", query: "is:open" }],
        }),
      ),
    ],
    { cwd },
  );
  const name = `ensemble-github-configure-${w.ids.atlas.slice(0, 8)}.json`;
  assert.equal(prepared.data.file, join(cwd, name));
  assert.deepEqual(readdirSync(cwd), [name]);
  const dry = await w.ok("rw", [
    "project",
    "apply",
    "--file",
    join(cwd, name),
    "--dry-run",
  ]);
  assert.equal(dry.data.document.kind, "github.configure");
});
