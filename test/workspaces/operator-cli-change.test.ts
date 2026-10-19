import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { CliDeps } from "../../src/cli/types.js";
import { harness, stdinOf } from "../fixtures/cli-harness.js";
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
  assert.match(applied.out, /^Already applied \(replay\); nothing changed\./);
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

test("profile prepare sets, shows and clears Codex model and effort", async (t) => {
  const { seed, d, out, cli, h } = await setup(t);
  assert.deepEqual(d.profileRuntime(seed.profileId), { harness: "codex" });
  const apply = async (...args: string[]) => {
    const doc = out();
    let r = await cli("ro", [
      "profile",
      "prepare",
      seed.profileId,
      ...args,
      "--out",
      doc,
    ]);
    assert.equal(r.code, 0, r.err + r.out);
    const prepared = r.json().data.document as Json;
    r = await cli("rw", ["profile", "apply", "--file", doc]);
    assert.equal(r.code, 0, r.err + r.out);
    return prepared;
  };
  const prepared = await apply("--model", "m-alt", "--effort", "medium");
  assert.deepEqual(prepared.command.runtime, {
    harness: "codex",
    model: "m-alt",
    reasoningEffort: "medium",
  });
  assert.deepEqual(prepared.preview.changes, [
    { field: "runtime.model", from: "default", to: "m-alt" },
    { field: "runtime.reasoningEffort", from: "default", to: "medium" },
  ]);
  assert.deepEqual(d.profileRuntime(seed.profileId), {
    harness: "codex",
    model: "m-alt",
    reasoningEffort: "medium",
  });
  const shown = await cli("ro", ["profile", "get", seed.profileId]);
  assert.equal(shown.code, 0, shown.err);
  assert.deepEqual(shown.json().data.runtime, {
    harness: "codex",
    model: "m-alt",
    reasoningEffort: "medium",
  });
  const human = await h.run([
    "profile",
    "get",
    seed.profileId,
    "--connection",
    "ro",
  ]);
  assert.match(human.out, /codex \(model m-alt, effort medium\)/);

  // One value changes alone; an unchanged value is no change and writes nothing.
  const effortOnly = await apply("--effort", "high");
  assert.deepEqual(effortOnly.preview.changes, [
    { field: "runtime.reasoningEffort", from: "medium", to: "high" },
  ]);
  for (const args of [
    ["--effort", "high"],
    ["--model", "m alt"],
  ]) {
    const target = out();
    const refused = await cli("ro", [
      "profile",
      "prepare",
      seed.profileId,
      ...args,
      "--out",
      target,
    ]);
    assert.equal(refused.code, 2, args.join(" "));
    assert.equal(existsSync(target), false, args.join(" "));
  }

  // `default` clears both and returns to the bare stored form.
  await apply("--model", "default", "--effort", "default");
  assert.deepEqual(d.profileRuntime(seed.profileId), { harness: "codex" });
  const target = out();
  const none = await cli("ro", [
    "profile",
    "prepare",
    seed.profileId,
    "--model",
    "default",
    "--out",
    target,
  ]);
  assert.equal(none.code, 2);
});

test("profile and project instructions can be given inline or on stdin", async (t) => {
  const { seed, d, file, out, cli, h } = await setup(t);
  type Kind = {
    area: "profile" | "project";
    /** The id of an existing target and its idempotent "bump the version" command. */
    target: string;
    idField: "profileId" | "projectId";
    stored(id: string): unknown;
    current(): number;
    bump(): void;
    /** Instructions are optional on create. */
    optionalOnCreate: boolean;
  };
  const kinds: Kind[] = [
    {
      area: "profile",
      target: seed.profileId,
      idField: "profileId",
      stored: (id) => d.profileRevision(id, 1).instructions,
      current: () => Number(d.profile(seed.profileId).version),
      bump: () =>
        d.execute({
          type: "profile.configure",
          actor: "operator",
          key: randomUUID(),
          profileId: seed.profileId,
          expectedVersion: Number(d.profile(seed.profileId).version),
          summary: "Changed meanwhile",
        } as never),
      optionalOnCreate: false,
    },
    {
      area: "project",
      target: seed.projectB,
      idField: "projectId",
      stored: (id) => d.instructionRevision(id, 1),
      current: () => Number(d.project(seed.projectB).version),
      bump: () =>
        d.execute({
          type: "project.configure",
          actor: "operator",
          key: randomUUID(),
          projectId: seed.projectB,
          expectedVersion: Number(d.project(seed.projectB).version),
          paused: !d.project(seed.projectB).paused,
        } as never),
      optionalOnCreate: true,
    },
  ];
  for (const k of kinds) {
    const create = (name: string, ...rest: string[]) => [
      k.area,
      "prepare-create",
      "--name",
      name,
      ...rest,
    ];
    const created = async (args: string[], extra = {}) => {
      const doc = out();
      const prepared = await cli("ro", [...args, "--out", doc], extra);
      assert.equal(
        prepared.code,
        0,
        `${k.area}: ${prepared.err}${prepared.out}`,
      );
      const applied = await cli("rw", [k.area, "apply", "--file", doc]);
      assert.equal(applied.code, 0, `${k.area}: ${applied.err}${applied.out}`);
      return JSON.parse(readFileSync(doc, "utf8")).command[k.idField] as string;
    };

    // 1. Inline text becomes the first revision; 2. `-` reads standard input verbatim.
    const inline = await created(
      create("Inline", "--instructions", "Be brief\n'$(x)'"),
    );
    assert.equal(k.stored(inline), "Be brief\n'$(x)'", k.area);
    const piped = await created(create("Piped", "--instructions", "-"), {
      stdin: stdinOf("From stdin\n"),
    });
    assert.equal(k.stored(piped), "From stdin\n", k.area);
    // The field limit counts characters, so 16,000 four-byte ones are accepted.
    const astral = await created(create("Astral", "--instructions", "-"), {
      stdin: stdinOf("😀".repeat(16000)),
    });
    assert.equal(k.stored(astral), "😀".repeat(16000), k.area);
    // The file form still works.
    const filed = await created(
      create("Filed", "--instructions-file", file("i.md", "From a file")),
    );
    assert.equal(k.stored(filed), "From a file", k.area);

    // 3-5. Refusals write no document and send nothing.
    const sent = h.fetches.length;
    const refuse = async (
      name: string,
      args: string[],
      code: string,
      message: RegExp,
      extra = {},
    ) => {
      const doc = out();
      const r = await cli("ro", [...args, "--out", doc], extra);
      assert.equal(r.code, 2, `${k.area} ${name}: ${r.out}`);
      assert.equal(r.json().error.code, code, `${k.area} ${name}`);
      assert.match(r.json().error.message, message, `${k.area} ${name}`);
      assert.equal(existsSync(doc), false, `${k.area} ${name}`);
    };
    await refuse(
      "both flags",
      create(
        "Both",
        "--instructions",
        "X",
        "--instructions-file",
        file("b.md", "B"),
      ),
      "usage",
      /either --instructions or --instructions-file, not both/,
    );
    if (!k.optionalOnCreate)
      await refuse(
        "neither flag",
        create("None"),
        "usage",
        /--instructions TEXT/,
      );
    await refuse(
      "no name",
      [k.area, "prepare-create", "--instructions", "X"],
      "usage",
      /--name/,
    );
    await refuse(
      "empty stdin",
      create("Empty", "--instructions", "-"),
      "invalid-input",
      /was empty/,
      { stdin: stdinOf("") },
    );
    await refuse(
      "oversized stdin",
      create("Big", "--instructions", "-"),
      "invalid-input",
      /longer than the 16000 characters a field takes/,
      { stdin: stdinOf("x".repeat(16000 * 4 + 1)) },
    );
    // Over the field limit by whichever way the text arrives: inline, file and stdin.
    const over =
      /is 16001 characters, longer than the 16000 characters a field takes/;
    await refuse(
      "inline over the limit",
      create("Long", "--instructions", "x".repeat(16001)),
      "invalid-input",
      over,
    );
    await refuse(
      "file over the limit",
      create("Long", "--instructions-file", file("long.md", "x".repeat(16001))),
      "invalid-input",
      over,
    );
    await refuse(
      "stdin over the limit",
      create("Long", "--instructions", "-"),
      "invalid-input",
      over,
      { stdin: stdinOf("x".repeat(16001)) },
    );
    await refuse(
      "stdin astral over the limit",
      create("Long", "--instructions", "-"),
      "invalid-input",
      /longer than the 16000 characters a field takes/,
      { stdin: stdinOf("😀".repeat(16001)) },
    );
    await refuse(
      "prepare stdin over the limit",
      [k.area, "prepare", k.target, "--instructions", "-"],
      "invalid-input",
      over,
      { stdin: stdinOf("x".repeat(16001)) },
    );
    const interrupt = new AbortController();
    setImmediate(() => interrupt.abort());
    await refuse(
      "open stdin",
      create("Open", "--instructions", "-"),
      "invalid-input",
      /interrupted/,
      {
        stdin: new PassThrough() as unknown as NodeJS.ReadStream,
        signal: interrupt.signal,
      },
    );
    await refuse(
      "prepare with restore",
      [
        k.area,
        "prepare",
        k.target,
        "--instructions",
        "X",
        "--restore-revision",
        "1",
      ],
      "usage",
      /--restore-revision, not both/,
    );
    await refuse(
      "prepare with file and restore",
      [
        k.area,
        "prepare",
        k.target,
        "--instructions-file",
        file("r.md", "R"),
        "--restore-revision",
        "1",
      ],
      "usage",
      /--restore-revision, not both/,
    );
    assert.equal(
      h.fetches.length,
      sent,
      `${k.area}: refusals are decided before connecting`,
    );

    // 6. prepare takes inline and stdin text, and diffs it.
    const doc = out();
    let r = await cli("ro", [
      k.area,
      "prepare",
      k.target,
      "--instructions",
      "New guidance",
      "--out",
      doc,
    ]);
    assert.equal(r.code, 0, `${k.area}: ${r.err}${r.out}`);
    assert.equal(
      JSON.parse(readFileSync(doc, "utf8")).command.instructions,
      "New guidance",
    );
    const human = await h.run(
      [
        k.area,
        "prepare",
        k.target,
        "--instructions",
        "-",
        "--out",
        out(),
        "--connection",
        "ro",
      ],
      { stdin: stdinOf("Piped guidance\n") },
    );
    assert.equal(human.code, 0, human.err);
    assert.match(human.out, /\+ Piped guidance/);

    // Standard input is read once even when the target changes during the read and the
    // read is repeated.
    let bumped = false;
    const racing: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (
        !bumped &&
        String(input).endsWith(`/${k.area}s/${k.target}/configuration`)
      ) {
        bumped = true;
        k.bump();
      }
      return response;
    };
    const retried = out();
    r = await cli(
      "ro",
      [k.area, "prepare", k.target, "--instructions", "-", "--out", retried],
      { stdin: stdinOf("Read once\n"), fetch: racing },
    );
    assert.equal(r.code, 0, `${k.area}: ${r.err}${r.out}`);
    assert.equal(bumped, true, k.area);
    const document = JSON.parse(readFileSync(retried, "utf8"));
    assert.equal(document.command.instructions, "Read once\n");
    assert.equal(document.command.expectedVersion, k.current(), k.area);
  }
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

test("prepare writes a change document to a default path that never overwrites", async (t) => {
  const { seed, h, cli } = await setup(t);
  const stem = `ensemble-project-configure-${seed.projectA.slice(0, 8)}`;
  const cwdOf = (prefix = "cwd-") => mkdtempSync(join(h.dir, prefix));
  const names = (cwd: string) => readdirSync(cwd).sort();
  let n = 0;
  const prepare = (cwd: string, extra: string[] = []) =>
    cli(
      "ro",
      [
        "project",
        "prepare",
        seed.projectA,
        "--name",
        `Renamed ${++n}`,
        ...extra,
      ],
      { cwd },
    );
  const fetched = () => h.fetches.length;

  // 1. No --out: the base name in the working directory, owner-only, and runnable.
  const cwd1 = cwdOf();
  let r = await prepare(cwd1);
  assert.equal(r.code, 0, r.err + r.out);
  const base = join(cwd1, `${stem}.json`);
  assert.equal(r.json().data.file, base);
  assert.equal(statSync(base).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(readFileSync(base, "utf8")).digest,
    r.json().data.document.digest,
  );
  const humanCwd = cwdOf();
  const human = await h.run(
    [
      "project",
      "prepare",
      seed.projectA,
      "--name",
      "Human",
      "--connection",
      "ro",
    ],
    { cwd: humanCwd },
  );
  assert.equal(human.code, 0, human.err);
  const humanFile = join(humanCwd, `${stem}.json`);
  assert.equal(
    human.out.trimEnd().split("\n").at(-1),
    `Apply with: ensemble project apply --file ${humanFile}`,
  );
  r = await cli("rw", ["project", "apply", "--file", humanFile]);
  assert.equal(r.code, 0, r.err + r.out);

  // 2. A taken name gets the next free suffix; nothing existing is touched.
  const cwd2 = cwdOf();
  await prepare(cwd2);
  const first = readFileSync(join(cwd2, `${stem}.json`), "utf8");
  writeFileSync(join(cwd2, `${stem}-2.json`), "sentinel", { mode: 0o600 });
  r = await prepare(cwd2);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.json().data.file, join(cwd2, `${stem}-3.json`));
  assert.equal(readFileSync(join(cwd2, `${stem}.json`), "utf8"), first);
  assert.equal(readFileSync(join(cwd2, `${stem}-2.json`), "utf8"), "sentinel");

  // 3. Two prepares at once never share a file, whichever gets the base name.
  const cwd3 = cwdOf();
  const both = await Promise.all([prepare(cwd3), prepare(cwd3)]);
  for (const result of both)
    assert.equal(result.code, 0, result.err + result.out);
  assert.deepEqual(both.map((x) => x.json().data.file).sort(), [
    join(cwd3, `${stem}-2.json`),
    join(cwd3, `${stem}.json`),
  ]);
  for (const result of both)
    assert.equal(
      JSON.parse(readFileSync(result.json().data.file, "utf8")).digest,
      result.json().data.document.digest,
    );

  // 4. An explicit --out still refuses an existing file and never takes a suffix.
  const explicit = join(cwd3, "explicit.json");
  writeFileSync(explicit, "mine", { mode: 0o600 });
  r = await prepare(cwd3, ["--out", explicit]);
  assert.equal(r.code, 2);
  assert.equal(r.json().error.code, "output-exists");
  assert.equal(readFileSync(explicit, "utf8"), "mine");
  assert.deepEqual(
    names(cwd3),
    [`${stem}-2.json`, `${stem}.json`, "explicit.json"].sort(),
  );

  // 5. `-` and an empty --out are refused before anything connects.
  const cwd5 = cwdOf();
  const sent = fetched();
  for (const out of ["-", ""]) {
    r = await prepare(cwd5, ["--out", out]);
    assert.equal(r.code, 2, out);
    assert.equal(r.json().error.code, "usage", out);
    assert.match(r.json().error.message, /ensemble-<kind>-<id8>\.json/);
  }
  assert.deepEqual(names(cwd5), []);
  assert.equal(fetched(), sent);

  // 6. A directory that cannot be written is output-failed with one Fix line.
  if (process.getuid?.() !== 0) {
    const locked = cwdOf();
    chmodSync(locked, 0o500);
    try {
      const failed = await h.run(
        [
          "project",
          "prepare",
          seed.projectA,
          "--name",
          "Locked",
          "--connection",
          "ro",
        ],
        { cwd: locked },
      );
      assert.equal(failed.code, 2);
      assert.deepEqual(
        failed.err.split("\n").filter((l) => l.startsWith("Fix: ")),
        ["Fix: Pass --out FILE in a directory you can write."],
      );
      assert.deepEqual(names(locked), []);
    } finally {
      chmodSync(locked, 0o700);
    }
  }

  // 7. All 99 names taken: output-exists, nothing created.
  const full = cwdOf();
  for (let i = 1; i <= 99; i++)
    writeFileSync(join(full, `${stem}${i === 1 ? "" : `-${i}`}.json`), "x", {
      mode: 0o600,
    });
  const refused = await h.run(
    [
      "project",
      "prepare",
      seed.projectA,
      "--name",
      "Full",
      "--connection",
      "ro",
    ],
    { cwd: full },
  );
  assert.equal(refused.code, 2);
  assert.match(refused.err, /\(output-exists\)/);
  assert.deepEqual(
    refused.err.split("\n").filter((l) => l.startsWith("Fix: ")),
    [
      `Fix: Remove or apply the older ${stem}*.json files here, or pass --out FILE.`,
    ],
  );
  assert.equal(names(full).length, 99);

  // 7b. The last suffix, -99, is used when every earlier name is taken.
  const nearlyFull = cwdOf();
  for (let i = 1; i <= 98; i++)
    writeFileSync(
      join(nearlyFull, `${stem}${i === 1 ? "" : `-${i}`}.json`),
      "x",
      { mode: 0o600 },
    );
  r = await prepare(nearlyFull);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.json().data.file, join(nearlyFull, `${stem}-99.json`));

  // 8. After `--`, `--out` is a positional, so the command is refused unread.
  const cwd8 = cwdOf();
  const before8 = fetched();
  const terminated = await h.run(
    [
      "project",
      "prepare",
      seed.projectA,
      "--name",
      "Term",
      "--connection",
      "ro",
      "--",
      "--out",
      "x.json",
    ],
    { cwd: cwd8 },
  );
  assert.equal(terminated.code, 2);
  assert.deepEqual(names(cwd8), []);
  assert.equal(fetched(), before8);

  // 9. Capacity has no target id, so its name has none.
  const cwd9 = cwdOf();
  r = await cli("ro", ["capacity", "prepare", "--global-limit", "6"], {
    cwd: cwd9,
  });
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(
    r.json().data.file,
    join(cwd9, "ensemble-capacity-configure.json"),
  );

  // 10. A path with a space and a quote is printed as one runnable shell word.
  const odd = cwdOf("it's a dir-");
  const printed = await h.run(
    [
      "project",
      "prepare",
      seed.projectA,
      "--name",
      "Odd",
      "--connection",
      "ro",
    ],
    { cwd: odd },
  );
  assert.equal(printed.code, 0, printed.err);
  const line = printed.out.trimEnd().split("\n").at(-1) ?? "";
  const word = line.slice("Apply with: ensemble project apply --file ".length);
  assert.ok(word.startsWith("'") && word.endsWith("'"), word);
  const unquoted = word.slice(1, -1).replaceAll("'\\''", "'");
  assert.equal(unquoted, join(odd, `${stem}.json`));
  r = await cli("rw", ["project", "apply", "--file", unquoted]);
  assert.equal(r.code, 0, r.err + r.out);
});

test("apply --dry-run shows the stored change and sends nothing", async (t) => {
  const { s, seed, h, d, file, out, cli, journal } = await setup(t);
  const prepare = (args: string[], doc = out()) =>
    h.run([
      "project",
      "prepare",
      seed.projectA,
      ...args,
      "--out",
      doc,
      "--connection",
      "ro",
    ]);
  const D = out();
  const prepared = await prepare(
    ["--instructions-file", file("dry.md", "Dry run guidance")],
    D,
  );
  assert.equal(prepared.code, 0, prepared.err);
  /** From `Changes:` to the line before the closing lines of prepare or of the dry run. */
  const section = (text: string) => {
    const l = text.trimEnd().split("\n");
    const end = l.findIndex(
      (x) => x.startsWith("Apply with:") || x.startsWith("Not checked"),
    );
    // `Gap:` lines are prepare-time coverage, which the document does not store.
    return l
      .slice(l.indexOf("Changes:"), end)
      .filter((x) => !x.startsWith("Gap: "))
      .join("\n")
      .trimEnd();
  };
  assert.match(section(prepared.out), /\+ Dry run guidance/);
  assert.match(section(prepared.out), /Affected assignments/);
  const document = JSON.parse(readFileSync(D, "utf8")) as Json;
  const state = () => ({
    fetches: h.fetches.length,
    journal: journal().length,
    db: databaseDigest(s.f),
    file: readFileSync(D, "utf8"),
  });
  const before = state();

  // 1. Human output: the prepared change, the origin and installation, the apply command.
  let r = await h.run([
    "project",
    "apply",
    "--file",
    D,
    "--dry-run",
    "--connection",
    "rw",
  ]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(state(), before);
  assert.equal(r.err, "");
  assert.equal(section(r.out), section(prepared.out));
  assert.ok(r.out.includes(document.service.origin), r.out);
  assert.ok(r.out.includes(document.service.installationId), r.out);
  assert.ok(
    r.out.includes(
      "Not checked against the service; apply re-checks the version and installation.",
    ),
  );
  assert.equal(
    r.out.trimEnd().split("\n").at(-1),
    `Apply with: ensemble project apply --file ${D}`,
  );

  // 2. JSON: the stored document, and nothing the service said.
  r = await cli("rw", ["project", "apply", "--file", D, "--dry-run"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(state(), before);
  assert.deepEqual(r.json().data, { file: D, document });
  for (const key of ["request", "connection", "service"])
    assert.ok(!(key in r.json()), key);

  // 3. The dry run left no journal key behind: the real apply happens once.
  const version = Number(d.project(seed.projectA).version);
  r = await cli("rw", ["project", "apply", "--file", D]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(Number(d.project(seed.projectA).version), version + 1);

  // 4. A document edited after prepare is refused locally.
  const edited = out();
  writeFileSync(
    edited,
    JSON.stringify({
      ...document,
      command: { ...document.command, name: "Edited" },
    }),
    { mode: 0o600 },
  );
  const sent = h.fetches.length;
  r = await cli("rw", ["project", "apply", "--file", edited, "--dry-run"]);
  assert.equal(r.code, 2);
  assert.equal(r.json().error.code, "change-document-invalid");

  // 5. A document of another kind names the command that applies it.
  r = await cli("rw", ["profile", "apply", "--file", D, "--dry-run"]);
  assert.equal(r.code, 2);
  assert.equal(r.json().error.code, "change-document-invalid");
  assert.match(r.json().error.message, /ensemble project apply/);
  assert.equal(h.fetches.length, sent);

  // 6. A stale version is not noticed by the dry run, but apply still refuses it.
  const stale = out();
  const newer = out();
  assert.equal((await prepare(["--name", "Stale one"], stale)).code, 0);
  assert.equal((await prepare(["--name", "Newer one"], newer)).code, 0);
  r = await cli("rw", ["project", "apply", "--file", newer]);
  assert.equal(r.code, 0, r.err + r.out);
  const requests = h.fetches.length;
  r = await cli("rw", ["project", "apply", "--file", stale, "--dry-run"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(h.fetches.length, requests);
  r = await cli("rw", ["project", "apply", "--file", stale]);
  assert.equal(r.code, 4);
  assert.equal(r.json().error.code, "conflict");

  // 7. Another connection, or none at all: still local, still naming the origin.
  const other = await startCliService(t);
  const issued = await other.issue("read-write", "other");
  const login = await h.run([
    "auth",
    "login",
    "--connection",
    "other",
    "--url",
    other.origin,
    "--token-file",
    h.tokenFile(issued.token),
  ]);
  assert.equal(login.code, 0, login.err);
  const elsewhere = out();
  assert.equal((await prepare(["--name", "Elsewhere"], elsewhere)).code, 0);
  const afterLogin = h.fetches.length;
  r = await h.run([
    "project",
    "apply",
    "--file",
    elsewhere,
    "--dry-run",
    "--connection",
    "other",
    "--output",
    "json",
  ]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(
    r.json().data.document.service,
    JSON.parse(readFileSync(elsewhere, "utf8")).service,
  );
  assert.equal(h.fetches.length, afterLogin);
  const loggedOut = harness(t);
  r = await loggedOut.run([
    "project",
    "apply",
    "--file",
    elsewhere,
    "--dry-run",
    "--output",
    "json",
  ]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(loggedOut.fetches, []);
  r = await h.run([
    "project",
    "apply",
    "--file",
    elsewhere,
    "--connection",
    "other",
    "--output",
    "json",
  ]);
  assert.equal(r.code, 2);
  assert.equal(r.json().error.code, "wrong-service");

  // 8. A dry run takes no request key.
  const count = h.fetches.length;
  r = await cli("rw", [
    "project",
    "apply",
    "--file",
    elsewhere,
    "--dry-run",
    "--request-id",
    randomUUID(),
  ]);
  assert.equal(r.code, 2);
  assert.equal(r.json().error.code, "usage");
  assert.equal(h.fetches.length, count);

  // 9. Capacity and creation documents dry-run the same way.
  const capacityDoc = out();
  r = await cli("ro", [
    "capacity",
    "prepare",
    "--global-limit",
    "6",
    "--out",
    capacityDoc,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  const profileDoc = out();
  r = await cli("ro", [
    "profile",
    "prepare-create",
    "--name",
    "Dry",
    "--instructions-file",
    file("dry-p.md", "Dry profile"),
    "--out",
    profileDoc,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  const fetched = h.fetches.length;
  for (const [area, doc, kind] of [
    ["capacity", capacityDoc, "capacity.configure"],
    ["profile", profileDoc, "profile.create"],
  ] as const) {
    r = await cli("rw", [area, "apply", "--file", doc, "--dry-run"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().data.document.kind, kind);
  }
  assert.equal(h.fetches.length, fetched);
});

test("apply says when it replays and when it settles a lost reply", async (t) => {
  const { s, seed, h, d, file, out, cli, journal } = await setup(t);
  const projectDoc = async (name: string) => {
    const doc = out();
    const r = await h.run([
      "project",
      "prepare",
      seed.projectA,
      "--name",
      name,
      "--out",
      doc,
      "--connection",
      "ro",
    ]);
    assert.equal(r.code, 0, r.err);
    return doc;
  };
  const version = () => Number(d.project(seed.projectA).version);
  const posts = (machine = h) =>
    machine.fetches.filter((f) => f.endsWith("/api/operator/commands")).length;
  const isCommands = (input: Parameters<typeof fetch>[0]) =>
    String(input).endsWith("/api/operator/commands");
  const reset = () => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
  };
  const lostApplied: Partial<CliDeps> = {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (isCommands(input)) reset();
      return response;
    },
  };
  const lostUnsent: Partial<CliDeps> = {
    fetch: async (input, init) => {
      if (isCommands(input)) reset();
      return fetch(input, init);
    },
  };
  const applyHuman = (doc: string, extra: string[] = []) =>
    h.run(["project", "apply", "--file", doc, ...extra, "--connection", "rw"]);
  const first = (text: string) => text.split("\n")[0];

  // 1. A true replay says so, sends the command again, and changes nothing.
  const fresh = await projectDoc("Fresh");
  let r = await applyHuman(fresh);
  assert.equal(r.code, 0, r.err);
  assert.match(first(r.out) ?? "", /^Applied project\.configure to project:/);
  assert.match(r.out, /Configuration saved/);
  const doc = await projectDoc("Replay");
  const start = version();
  const applied = await cli("rw", ["project", "apply", "--file", doc]);
  assert.equal(applied.code, 0, applied.err);
  assert.equal(applied.json().data.replayed, false);
  assert.equal(version(), start + 1);
  const sent = posts();
  const again = await applyHuman(doc);
  assert.equal(again.code, 0, again.err);
  assert.equal(first(again.out), "Already applied (replay); nothing changed.");
  assert.ok(again.out.includes(applied.json().request.key), again.out);
  assert.doesNotMatch(again.out, /Configuration saved/);
  const replay = await cli("rw", ["project", "apply", "--file", doc]);
  assert.equal(replay.code, 0, replay.err);
  assert.equal(replay.json().data.replayed, true);
  assert.deepEqual(replay.json().request, applied.json().request);
  assert.deepEqual(replay.json().data.receipt, applied.json().data.receipt);
  assert.equal(version(), start + 1);
  assert.equal(posts() - sent, 2);
  // A later rejected attempt does not erase the record of the receipt.
  r = await cli("rw", ["project", "apply", "--file", doc], {
    fetch: async (input, init) => {
      if (isCommands(input))
        throw new TypeError("fetch failed", {
          cause: { code: "ECONNREFUSED" },
        });
      return fetch(input, init);
    },
  });
  assert.equal(r.code, 5, r.out);
  assert.equal(journal().at(-1)?.state, "rejected");
  r = await cli("rw", ["project", "apply", "--file", doc]);
  assert.equal(r.json().data.replayed, true);

  // 6. The JSON shape only gains `replayed`.
  assert.deepEqual(Object.keys(replay.json().data).sort(), [
    "digest",
    "file",
    "receipt",
    "replayed",
  ]);
  assert.deepEqual(Object.keys(replay.json()), Object.keys(applied.json()));

  // 2. A reply lost after the service applied the change: the rerun settles it once.
  const lost = await projectDoc("Lost after applying");
  const beforeLost = version();
  r = await cli("rw", ["project", "apply", "--file", lost], lostApplied);
  assert.equal(r.code, 6, r.out);
  const lostKey = r.json().error.request.key;
  assert.equal(version(), beforeLost + 1);
  r = await cli("rw", ["project", "apply", "--file", lost]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.json().data.replayed, null);
  assert.equal(r.json().request.key, lostKey);
  assert.equal(version(), beforeLost + 1);

  // 3. A reply lost before the service saw the request: the rerun applies it once.
  const unsent = await projectDoc("Lost before sending");
  const beforeUnsent = version();
  r = await cli("rw", ["project", "apply", "--file", unsent], lostUnsent);
  assert.equal(r.code, 6, r.out);
  const unsentKey = r.json().error.request.key;
  assert.equal(journal().at(-1)?.state, "unknown");
  assert.equal(version(), beforeUnsent);
  r = await h.run(["project", "apply", "--file", unsent, "--connection", "rw"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(
    r.out.split("\n")[1],
    `An earlier attempt with request ${unsentKey} lost its reply; the change is applied once.`,
  );
  assert.equal(version(), beforeUnsent + 1);

  // 4. A request key from another machine is not a replay this machine can know.
  const login = async (machine: ReturnType<typeof harness>) => {
    const issued = await s.issue("read-write", `machine-${randomUUID()}`);
    const loggedIn = await machine.run([
      "auth",
      "login",
      "--connection",
      "rw",
      "--url",
      s.origin,
      "--token-file",
      machine.tokenFile(issued.token),
    ]);
    assert.equal(loggedIn.code, 0, loggedIn.err);
  };
  const key = applied.json().request.key;
  const beforeOther = version();
  const m1 = harness(t);
  await login(m1);
  r = await m1.run([
    "project",
    "apply",
    "--file",
    doc,
    "--request-id",
    key,
    "--connection",
    "rw",
    "--output",
    "json",
  ]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().data.replayed, null);
  const m2 = harness(t);
  await login(m2);
  r = await m2.run([
    "project",
    "apply",
    "--file",
    doc,
    "--request-id",
    key,
    "--connection",
    "rw",
  ]);
  assert.equal(r.code, 0, r.err);
  assert.equal(
    r.out.split("\n")[1],
    `If request ${key} was applied before, this is its recorded receipt; the change is applied once.`,
  );
  assert.equal(version(), beforeOther);

  // 5. A creation replays the same way, and creates one profile.
  const profileId = randomUUID();
  const profileDoc = out();
  r = await cli("ro", [
    "profile",
    "prepare-create",
    "--name",
    "Replay profile",
    "--instructions-file",
    file("replay.md", "Replay"),
    "--id",
    profileId,
    "--out",
    profileDoc,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  r = await cli("rw", ["profile", "apply", "--file", profileDoc]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.json().data.replayed, false);
  r = await h.run([
    "profile",
    "apply",
    "--file",
    profileDoc,
    "--connection",
    "rw",
  ]);
  assert.equal(r.code, 0, r.err);
  assert.equal(first(r.out), "Already applied (replay); nothing changed.");
  r = await cli("rw", ["profile", "apply", "--file", profileDoc]);
  assert.equal(r.json().data.replayed, true);
  assert.equal(Number(d.profile(profileId).version), 1);
});

test("every change prepare command defaults its document into the working directory", async (t) => {
  const { seed, h, cli } = await setup(t);
  const cwd = mkdtempSync(join(h.dir, "cwd-"));
  const profileId = randomUUID();
  const projectId = randomUUID();
  const short = (id: string) => id.slice(0, 8);
  const routes: [string[], string][] = [
    [
      ["profile", "prepare", seed.profileId, "--summary", "Default path"],
      `ensemble-profile-configure-${short(seed.profileId)}.json`,
    ],
    [
      [
        "profile",
        "prepare-create",
        "--id",
        profileId,
        "--name",
        "Default path profile",
        "--instructions",
        "Guidance",
      ],
      `ensemble-profile-create-${short(profileId)}.json`,
    ],
    [
      [
        "project",
        "prepare-create",
        "--id",
        projectId,
        "--name",
        "Default path project",
      ],
      `ensemble-project-create-${short(projectId)}.json`,
    ],
    [
      [
        "project",
        "prepare-routing",
        seed.projectA,
        "--credential-ref",
        "env:DEFAULT_PATH_REF",
      ],
      `ensemble-routing-configure-${short(seed.projectA)}.json`,
    ],
  ];
  for (const [args, name] of routes) {
    const r = await cli("ro", args, { cwd });
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}${r.out}`);
    assert.equal(r.json().data.file, join(cwd, name), args.join(" "));
  }
  assert.deepEqual(
    readdirSync(cwd).sort(),
    routes.map(([, name]) => name).sort(),
  );
});
