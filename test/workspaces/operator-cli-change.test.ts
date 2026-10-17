import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { harness } from "../fixtures/cli-harness.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import {
  instructionSecret,
  seedInstructionHistory,
} from "../fixtures/instruction-history.js";
import { startCliService } from "../fixtures/operator-cli.js";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes and documents are asserted structurally
type Json = Record<string, any>;
type After = { after(fn: () => unknown): void };

async function setup(t: After) {
  const s = await startCliService(t);
  const seed = await seedInstructionHistory(s.f);
  t.after(seed.cleanup);
  const h = harness(t);
  for (const [name, scope] of [
    ["ro", "read"],
    ["rw", "read-write"],
  ] as const) {
    const issued = await s.issue(scope, `change-${name}`);
    const login = await h.run([
      "auth",
      "login",
      "--connection",
      name,
      "--url",
      s.origin,
      "--token-file",
      h.tokenFile(issued.token),
    ]);
    assert.equal(login.code, 0, login.err);
  }
  const d = s.f.service.domain();
  const file = (name: string, text: string) => {
    const path = join(h.dir, name);
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  };
  const out = (name = `${randomUUID()}.json`) => join(h.dir, name);
  const cli = (
    connection: "ro" | "rw",
    args: string[],
    extra: Parameters<typeof h.run>[1] = {},
  ) => h.run([...args, "--connection", connection, "--output", "json"], extra);
  const journal = () => {
    const path = join(h.configDir, "requests.jsonl");
    return existsSync(path)
      ? readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Json)
      : [];
  };
  return { s, seed, h, d, file, out, cli, journal };
}

test("profile changes prepare read-only, apply once and keep revisions immutable", async (t) => {
  const { s, seed, h, d, file, out, cli, journal } = await setup(t);
  // A runtime set outside the CLI survives CLI changes.
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: seed.profileId,
    expectedVersion: Number(d.profile(seed.profileId).version),
    runtime: {
      harness: "claude",
      model: "default",
      reasoningEffort: "default",
    },
  } as never);
  const revisions = () =>
    [1, 2, 3].map((r) => d.profileRevision(seed.profileId, r).instructions);
  const original = revisions();
  const text = "New guidance\nwith two lines\n";
  const doc = out();
  const before = databaseDigest(s.f);
  let r = await cli("ro", [
    "profile",
    "prepare",
    seed.profileId,
    "--instructions-file",
    file("p.md", text),
    "--out",
    doc,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(databaseDigest(s.f), before);
  assert.deepEqual(journal(), []);
  assert.equal(statSync(doc).mode & 0o777, 0o600);
  const document = JSON.parse(readFileSync(doc, "utf8")) as Json;
  assert.equal(document.kind, "profile.configure");
  assert.equal(document.target.scope, `profile:${seed.profileId}`);
  assert.equal(document.expected.version, 4);
  assert.deepEqual(Object.keys(document.command).sort(), [
    "expectedVersion",
    "instructions",
    "profileId",
    "type",
  ]);
  assert.equal(document.command.instructions, text);
  assert.equal(
    document.preview.impact.label,
    "preparation-time, informational",
  );
  assert.equal(typeof document.preview.impact.observedAt, "number");
  assert.ok(r.json().data.document.digest);
  const human = await h.run([
    "profile",
    "prepare",
    seed.profileId,
    "--instructions-file",
    file("p2.md", text),
    "--out",
    out(),
    "--connection",
    "ro",
  ]);
  assert.match(human.out, /Prepared profile.configure for profile:/);
  assert.match(human.out, /on ro \(http:\/\/127\.0\.0\.1/);
  assert.match(human.out, /\+ New guidance/);

  r = await cli("rw", ["profile", "apply", "--file", doc]);
  assert.equal(r.code, 0, r.err + r.out);
  const receipt = r.json().data.receipt;
  assert.equal(receipt.result.commandType, "profile.configure");
  assert.equal(receipt.result.version, 5);
  assert.equal(r.json().request.scope, `profile:${seed.profileId}`);
  assert.equal(d.profileRevision(seed.profileId, 5).instructions, text);
  assert.deepEqual(revisions(), original);
  assert.equal(d.profileRuntime(seed.profileId).harness, "claude");
  assert.deepEqual(
    journal().map((l) => l.state),
    ["sending", "recorded"],
  );
  const staleness = await cli("ro", [
    "assignment",
    "instructions",
    seed.assignmentA,
  ]);
  assert.equal(staleness.json().data.comparison.boundIsCurrent, false);
  const applied = await h.run([
    "profile",
    "apply",
    "--file",
    doc,
    "--connection",
    "rw",
  ]);
  assert.equal(applied.code, 0, applied.err);
  assert.match(applied.out, /nothing was dispatched/);
  assert.equal(Number(d.profile(seed.profileId).version), 5, "replayed once");

  // Restore revision 1 as a new revision.
  const restore = out();
  r = await cli("ro", [
    "profile",
    "prepare",
    seed.profileId,
    "--restore-revision",
    "1",
    "--out",
    restore,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  r = await cli("rw", ["profile", "apply", "--file", restore]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(
    d.profileRevision(seed.profileId, 6).instructions,
    seed.text.profile[0],
  );
  assert.equal(d.profileRevision(seed.profileId, 1).instructions, original[0]);

  for (const args of [
    ["--restore-revision", "3"],
    ["--instructions-file", file("same.md", seed.text.profile[0] ?? "")],
    ["--restore-revision", "1", "--instructions-file", file("x.md", "x")],
    ["--paused", "true"],
    // Trimmed like the service, so this is no change.
    ["--name", "Shared lead "],
  ]) {
    const target = out();
    const denied = await cli("ro", [
      "profile",
      "prepare",
      seed.profileId,
      ...args,
      "--out",
      target,
    ]);
    assert.equal(denied.code, 2, args.join(" "));
    assert.equal(existsSync(target), false, args.join(" "));
  }

  // Revoke then unrevoke; versions only increase.
  for (const value of ["true", "false"]) {
    const change = out();
    r = await cli("ro", [
      "profile",
      "prepare",
      seed.profileId,
      "--revoked",
      value,
      "--out",
      change,
    ]);
    assert.equal(r.code, 0, r.err + r.out);
    r = await cli("rw", ["profile", "apply", "--file", change]);
    assert.equal(r.code, 0, r.err + r.out);
    assert.equal(r.json().data.receipt.result.revoked, value === "true");
    if (value === "true")
      assert.ok(
        d
          .assignmentAdmission(seed.assignmentB)
          .reasons.includes("profile-revoked"),
      );
  }
  assert.equal(Number(d.profile(seed.profileId).version), 8);
});

test("project changes and creation apply exactly once", async (t) => {
  const { s, seed, h, d, file, out, cli } = await setup(t);
  const change = out();
  let r = await cli("ro", [
    "project",
    "prepare",
    seed.projectB,
    "--name",
    "Beta renamed",
    "--paused",
    "true",
    "--lead-profile",
    "none",
    "--instructions-file",
    file("b.md", "Project B v2"),
    "--out",
    change,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  r = await cli("rw", ["project", "apply", "--file", change]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(
    {
      ...r.json().data.receipt.result,
      resourceId: undefined,
      version: undefined,
    },
    {
      commandType: "project.configure",
      resourceId: undefined,
      version: undefined,
      paused: true,
      leadProfileId: null,
      instructionsRevision: 2,
    },
  );
  const p = d.project(seed.projectB);
  assert.equal(p.name, "Beta renamed");
  assert.equal(p.instructions, "Project B v2");

  const id = randomUUID();
  const create = out();
  r = await cli("ro", [
    "project",
    "prepare-create",
    "--name",
    "Delta",
    "--lead-profile",
    seed.profileId,
    "--instructions-file",
    file("d.md", "Delta one"),
    "--id",
    id,
    "--out",
    create,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  // A read-only attempt is journalled as rejected; its key is not reused.
  r = await cli("ro", ["project", "apply", "--file", create]);
  assert.equal(r.code, 3, r.out);
  const rejectedKey = r.json().error.request.key;
  r = await cli("rw", ["project", "apply", "--file", create]);
  assert.equal(r.code, 0, r.err + r.out);
  const first = r.json().data.receipt;
  assert.notEqual(first.key, rejectedKey);
  // A rejected key still gets the existence pre-check instead of being sent.
  const posts = h.fetches.filter((f) => f.endsWith("/commands")).length;
  r = await cli("rw", [
    "project",
    "apply",
    "--file",
    create,
    "--request-id",
    rejectedKey,
  ]);
  assert.equal(r.code, 4, r.out);
  assert.match(r.json().error.message, /already exists/);
  assert.equal(h.fetches.filter((f) => f.endsWith("/commands")).length, posts);
  assert.equal(first.result.paused, true);
  assert.equal(first.result.leadProfileId, seed.profileId);
  assert.equal(d.instructionRevision(id, 1), "Delta one");
  r = await cli("rw", ["project", "apply", "--file", create]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(r.json().data.receipt, first);
  assert.equal(d.projects().filter((project) => project.id === id).length, 1);
  // A fresh identity (another machine, no journal) is stopped by the pre-check.
  const other = harness(t);
  const issued = await s.issue("read-write", "change-other");
  await other.run([
    "auth",
    "login",
    "--connection",
    "rw",
    "--url",
    s.origin,
    "--token-file",
    other.tokenFile(issued.token),
  ]);
  const copy = join(other.dir, "create.json");
  writeFileSync(copy, readFileSync(create), { mode: 0o600 });
  r = await other.run(["project", "apply", "--file", copy, "--output", "json"]);
  assert.equal(r.code, 4, r.out);
  assert.equal(r.json().error.code, "conflict");
  assert.equal(r.json().error.outcome, "not-applied");

  const profileId = randomUUID();
  const profile = out();
  r = await cli("ro", [
    "profile",
    "prepare-create",
    "--name",
    "Writer",
    "--instructions-file",
    file("w.md", "Write well"),
    "--id",
    profileId,
    "--out",
    profile,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(!("runtime" in JSON.parse(readFileSync(profile, "utf8")).command));
  r = await cli("rw", ["profile", "apply", "--file", profile]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.json().data.receipt.result.version, 1);

  // Lost reply (unknown), then a retry rejected before sending: the next bare apply
  // keeps the key, skips the existence pre-check and replays the recorded receipt.
  const lostId = randomUUID();
  const lostDoc = out();
  r = await cli("ro", [
    "profile",
    "prepare-create",
    "--name",
    "Lost",
    "--instructions-file",
    file("lost.md", "Lost reply"),
    "--id",
    lostId,
    "--out",
    lostDoc,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  const commands = (input: Parameters<typeof fetch>[0]) =>
    String(input).endsWith("/api/operator/commands");
  r = await cli("rw", ["profile", "apply", "--file", lostDoc], {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (commands(input))
        throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      return response;
    },
  });
  assert.equal(r.code, 6, r.out);
  const lostKey = r.json().error.request.key;
  r = await cli("rw", ["profile", "apply", "--file", lostDoc], {
    fetch: async (input, init) => {
      if (commands(input))
        throw new TypeError("fetch failed", {
          cause: { code: "ECONNREFUSED" },
        });
      return fetch(input, init);
    },
  });
  assert.equal(r.code, 5, r.out);
  assert.equal(r.json().error.request.key, lostKey);
  r = await cli("rw", ["profile", "apply", "--file", lostDoc]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.json().request.key, lostKey);
  assert.equal(r.json().data.receipt.result.version, 1);
  assert.equal(Number(d.profile(lostId).version), 1);
  assert.equal(h.outputs.length > 0, true);
});

test("stale revisions, tampering, wrong services and denials send nothing", async (t) => {
  const { s, seed, h, d, file, out, cli, journal } = await setup(t);
  const doc = out();
  let r = await cli("ro", [
    "profile",
    "prepare",
    seed.profileId,
    "--summary",
    "Prepared",
    "--out",
    doc,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  const projectDoc = out();
  r = await cli("ro", [
    "project",
    "prepare",
    seed.projectA,
    "--instructions-file",
    file("a.md", `Changed ${instructionSecret}`),
    "--out",
    projectDoc,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  const prepared = JSON.parse(readFileSync(projectDoc, "utf8")) as Json;
  assert.deepEqual(prepared.preview.impact.assignmentIds, [seed.assignmentA]);

  // Concurrent edit through the browser session.
  const bumped = await s.sessionPost("/api/operator/commands", {
    type: "profile.configure",
    key: randomUUID(),
    profileId: seed.profileId,
    expectedVersion: Number(d.profile(seed.profileId).version),
    name: "Edited in the browser",
  });
  assert.equal(bumped.status, 200);
  let before = databaseDigest(s.f);
  r = await cli("rw", ["profile", "apply", "--file", doc]);
  assert.equal(r.code, 4, r.out);
  assert.equal(r.json().error.code, "conflict");
  assert.equal(r.json().error.outcome, "not-applied");
  assert.match(
    r.json().error.message,
    /changed since this document was prepared.*prepare again/,
  );
  assert.equal(r.json().error.request.scope, `profile:${seed.profileId}`);
  assert.equal(databaseDigest(s.f), before);
  r = await cli("ro", [
    "profile",
    "prepare",
    seed.profileId,
    "--summary",
    "x",
    "--expected-version",
    "1",
    "--out",
    out("stale.json"),
  ]);
  assert.equal(r.code, 4);
  assert.equal(existsSync(join(h.dir, "stale.json")), false);

  // An assignment created after preparation does not fence the apply.
  const taskId = randomUUID(),
    assignmentId = randomUUID();
  const created = await s.sessionPost("/api/operator/commands", {
    type: "task.create",
    key: randomUUID(),
    projectId: seed.projectA,
    taskId,
    title: "Late",
    outcome: "Late",
    ready: false,
    initialAssignment: { assignmentId, profileId: seed.profileId },
  });
  assert.equal(created.status, 200);
  r = await cli("rw", ["project", "apply", "--file", projectDoc]);
  assert.equal(r.code, 0, r.err + r.out);
  r = await cli("ro", ["assignment", "instructions", assignmentId]);
  assert.equal(r.json().data.comparison.boundIsCurrent, false);
  assert.deepEqual(
    JSON.parse(readFileSync(projectDoc, "utf8")).preview.impact.observedAt,
    prepared.preview.impact.observedAt,
  );

  // Tampering.
  const fresh = out();
  r = await cli("ro", [
    "profile",
    "prepare",
    seed.profileId,
    "--summary",
    "Tamper target",
    "--out",
    fresh,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  const good = readFileSync(fresh, "utf8");
  const json = JSON.parse(good) as Json;
  const variants: [string, (path: string) => void][] = [
    [
      "command",
      (p) =>
        writeFileSync(
          p,
          JSON.stringify({
            ...json,
            command: { ...json.command, summary: "other" },
          }),
        ),
    ],
    [
      "preview",
      (p) =>
        writeFileSync(
          p,
          JSON.stringify({
            ...json,
            preview: { ...json.preview, notes: ["x"] },
          }),
        ),
    ],
    [
      "digest",
      (p) =>
        writeFileSync(p, JSON.stringify({ ...json, digest: "0".repeat(64) })),
    ],
    [
      "target",
      (p) =>
        writeFileSync(
          p,
          JSON.stringify({
            ...json,
            target: { ...json.target, id: seed.projectA },
          }),
        ),
    ],
    [
      "expected",
      (p) =>
        writeFileSync(p, JSON.stringify({ ...json, expected: { version: 1 } })),
    ],
    ["truncated", (p) => writeFileSync(p, good.slice(0, good.length / 2))],
    [
      "schema",
      (p) => writeFileSync(p, JSON.stringify({ ...json, schema: "other" })),
    ],
    ["oversized", (p) => writeFileSync(p, `${good}${" ".repeat(600 * 1024)}`)],
  ];
  before = databaseDigest(s.f);
  const posts = () => h.fetches.filter((f) => f.endsWith("/commands")).length;
  const sent = posts();
  for (const [name, write] of variants) {
    const path = join(h.dir, `tamper-${name}.json`);
    write(path);
    chmodSync(path, 0o600);
    r = await cli("rw", ["profile", "apply", "--file", path]);
    assert.equal(r.code, 2, name);
    assert.equal(r.json().error.code, "change-document-invalid", name);
  }
  const link = join(h.dir, "link.json");
  symlinkSync(fresh, link);
  r = await cli("rw", ["profile", "apply", "--file", link]);
  assert.equal(r.json().error.code, "change-document-invalid");
  chmodSync(fresh, 0o640);
  r = await cli("rw", ["profile", "apply", "--file", fresh]);
  assert.equal(r.json().error.code, "change-document-invalid");
  chmodSync(fresh, 0o600);
  r = await cli("rw", ["project", "apply", "--file", fresh]);
  assert.equal(r.json().error.code, "change-document-invalid");
  assert.equal(posts(), sent);
  assert.equal(databaseDigest(s.f), before);
  r = await cli("ro", [
    "profile",
    "prepare",
    seed.profileId,
    "--summary",
    "again",
    "--out",
    fresh,
  ]);
  assert.equal(r.json().error.code, "output-exists");

  // Wrong service.
  const other = await startCliService(t);
  const issued = await other.issue("read-write", "other");
  await h.run([
    "auth",
    "login",
    "--connection",
    "other",
    "--url",
    other.origin,
    "--token-file",
    h.tokenFile(issued.token),
  ]);
  r = await h.run([
    "profile",
    "apply",
    "--file",
    fresh,
    "--connection",
    "other",
    "--output",
    "json",
  ]);
  assert.equal(r.code, 2);
  assert.equal(r.json().error.code, "wrong-service");
  assert.equal(posts(), sent);

  // Read-only credential cannot apply.
  r = await cli("ro", ["profile", "apply", "--file", fresh]);
  assert.equal(r.code, 3);
  assert.equal(r.json().error.code, "insufficient-scope");
  assert.equal(databaseDigest(s.f), before);

  // Oversized command and unrelated or missing flags fail before any request.
  const count = h.fetches.length;
  r = await cli("ro", [
    "profile",
    "prepare",
    seed.profileId,
    "--paused",
    "true",
    "--out",
    out(),
  ]);
  assert.equal(r.code, 2);
  r = await cli("ro", ["profile", "prepare", seed.profileId]);
  assert.equal(r.code, 2);
  r = await cli("rw", ["profile", "apply"]);
  assert.equal(r.code, 2);
  assert.equal(h.fetches.length, count);
  r = await cli("ro", [
    "profile",
    "prepare",
    seed.profileId,
    "--instructions-file",
    file("big3.md", "\u0001".repeat(12000)),
    "--capabilities-file",
    file("big4.md", "\u0001".repeat(12000)),
    "--out",
    out("big.json"),
  ]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.json().error.message, /64 KiB/);
  assert.equal(existsSync(join(h.dir, "big.json")), false);

  const journalText = JSON.stringify(journal());
  assert.ok(!journalText.includes(instructionSecret));
  for (const line of h.outputs.filter((o) => o.includes('"error"')))
    assert.ok(!line.includes(instructionSecret));
});

test("a missing change document says it is missing and sends nothing", async (t) => {
  const h = harness(t);
  const missing = join(h.dir, "nofile");
  const r = await h.run(["project", "apply", "--file", missing]);
  assert.equal(r.code, 2);
  assert.match(r.err, /\(change-document-invalid\)/);
  assert.match(r.err, /Change document rejected: it does not exist\./);
  assert.match(
    r.err,
    /^Fix: Prepare it first with .*'ensemble project prepare'.*then apply/m,
  );
  assert.deepEqual(h.fetches, []);
  assert.equal(existsSync(join(h.configDir, "requests.jsonl")), false);
  const json = await h.run([
    "profile",
    "apply",
    "--file",
    missing,
    "--output",
    "json",
  ]);
  assert.equal(json.code, 2);
  assert.equal(json.err, "");
  assert.equal(json.json().error.code, "change-document-invalid");
  assert.ok(!json.out.includes("Fix:"));

  // A document others can read is refused with the exact chmod.
  const open = join(h.dir, "open.json");
  writeFileSync(open, "{}", { mode: 0o600 });
  chmodSync(open, 0o644);
  const mode = await h.run(["capacity", "apply", "--file", open]);
  assert.equal(mode.code, 2);
  assert.match(mode.err, /its mode is 0644; it must be 0600 or stricter/);
  assert.match(mode.err, new RegExp(`^Fix: chmod 600 ${open}$`, "m"));
  assert.deepEqual(h.fetches, []);
});
