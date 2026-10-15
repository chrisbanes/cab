import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { test } from "node:test";
import type { SourceCredentialReason } from "../../src/standalone/github-source-credential.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import { createFakeGh, fakeGhToken } from "../fixtures/fake-gh.js";
import { startCliOperator } from "../fixtures/operator-cli.js";
import {
  seedImportedConflict,
  seedSettingsWorld,
} from "../fixtures/operator-settings.js";

process.env.FIXTURE_GITHUB = "test-only-github-source-token";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes are asserted structurally
type Json = Record<string, any>;
/** A read's readiness view as the `github.configure` value that keeps it. */
const ruleOf = (r: Json) =>
  r.kind === "rule" ? { mode: r.mode, conditions: r.conditions } : null;

async function world(
  t: Parameters<typeof startCliOperator>[0],
  ghExecutable?: string,
) {
  const reader = {
    mode: "complete" as "complete" | "incomplete" | "throw",
    reason: "rate-limited" as "rate-limited" | SourceCredentialReason,
    reads: 0,
  };
  const o = await startCliOperator(t, {
    service: {
      supervisor: { observationMs: 50 },
      ...(ghExecutable ? { ghExecutable } : {}),
    },
    previewReader: () => ({
      async readSelection() {
        reader.reads++;
        if (reader.mode === "throw") throw new Error("provider unavailable");
        return reader.mode === "complete"
          ? { complete: true, issues: [], reason: null }
          : { complete: false, issues: [], reason: reader.reason };
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
  return { ...o, ids, config, ok, reader };
}

test("service and advanced HTML source status use only the configured fake gh executable", async (t) => {
  const gh = createFakeGh();
  t.after(() => gh.close());
  const originalPath = process.env.PATH;
  process.env.PATH = [dirname(gh.executable), originalPath]
    .filter(Boolean)
    .join(":");
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  const defaultWorld = await world(t);
  await defaultWorld.config();
  assert.equal(
    gh.environments().length,
    0,
    "the default absent executable must not fall through to the fake PATH entry",
  );

  const explicitWorld = await world(t, gh.executable);
  const source = (await explicitWorld.config()).source;
  assert.equal(
    explicitWorld.s.f.service.domain().discoveryCredentialReference(),
    null,
  );
  assert.equal(source.credential.source, "env");
  assert.equal(source.credential.usable, true);
  assert.equal(source.credential.gh.state, "signed-in");
  assert.equal(source.credential.gh.login, "octo");
  const html = await explicitWorld.s.sessionGet(
    `/project/${explicitWorld.ids.atlas}`,
  );
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Detected GitHub CLI account @octo/);
  assert.ok(
    gh.environments().length > 0,
    "explicit fake gh must serve the source status",
  );
  const configure = await explicitWorld.s.sessionPost(
    "/api/operator/commands",
    {
      type: "github.configure",
      key: randomUUID(),
      projectId: explicitWorld.ids.atlas,
      expectedVersion: source.version,
      credentialRef: "gh:github.com",
      selections: source.selections.map((selection: Json) => ({
        id: selection.id,
        keep: true,
      })),
      readiness: ruleOf(source.readiness),
      repositories: source.repositories,
    },
  );
  assert.equal(configure.status, 200);
  const ghSource = (await explicitWorld.config()).source;
  assert.equal(ghSource.credential.source, "gh");
  assert.equal(ghSource.credential.usable, true);
  const preview = await explicitWorld.ok("rw", [
    "project",
    "preview-source",
    explicitWorld.ids.atlas,
    "--selection",
    "S-1",
    "--expected-version",
    String(ghSource.version),
  ]);
  assert.equal(preview.data.receipt.result.active, true);
});

test("preview reports each unusable GitHub CLI credential with actionable safe guidance", async (t) => {
  for (const [state, expected] of [
    ["not-signed-in", /GitHub CLI is not signed in/],
    ["unreadable", /cannot read the GitHub CLI login/],
  ] as const) {
    await t.test(state, async (subtest) => {
      const gh = createFakeGh(state);
      subtest.after(() => gh.close());
      const w = await world(subtest, gh.executable);
      const source = (await w.config()).source;
      const configured = await w.s.sessionPost("/api/operator/commands", {
        type: "github.configure",
        key: randomUUID(),
        projectId: w.ids.atlas,
        expectedVersion: source.version,
        credentialRef: "gh:github.com",
        selections: source.selections.map((selection: Json) => ({
          id: selection.id,
          keep: true,
        })),
        readiness: ruleOf(source.readiness),
        repositories: source.repositories,
      });
      assert.equal(configured.status, 200);
      const current = (await w.config()).source;
      const result = await w.cli("rw", [
        "project",
        "preview-source",
        w.ids.atlas,
        "--selection",
        "S-1",
        "--expected-version",
        String(current.version),
      ]);
      assert.equal(result.code, 4, result.out);
      assert.match(result.json().error.message, expected);
      assert.equal(w.reader.reads, 0);
      assert.ok(!result.out.includes("gho_fake-canary-942"));
    });
  }
});

test("preview preserves a credential refusal returned after a usable preflight", async (t) => {
  const w = await world(t);
  const current = (await w.config()).source;
  assert.equal(current.credential.usable, true);
  w.reader.mode = "incomplete";
  w.reader.reason = "gh-not-signed-in";
  const refused = await w.cli("rw", [
    "project",
    "preview-source",
    w.ids.atlas,
    "--selection",
    "S-1",
    "--expected-version",
    String(current.version),
  ]);
  assert.equal(refused.code, 4, refused.out);
  const error = refused.json().error;
  assert.equal(
    error.message,
    "GitHub CLI is not signed in. Run gh auth login on the service host or change the credential in GitHub source settings, then retry preview.",
  );
  assert.deepEqual(
    {
      service: error.request.service,
      scope: error.request.scope,
      type: error.request.type,
      key: error.request.key,
    },
    {
      service: w.s.f.service.operatorCredentials().installationId(),
      scope: `project:${w.ids.atlas}`,
      type: "github.preview",
      key: error.request.key,
    },
  );
  assert.match(error.request.key, /^[0-9a-f-]{36}$/);
  assert.equal(w.reader.reads, 1);
});

test("preview-source activates after a complete read and reports the live state", async (t) => {
  const w = await world(t);
  const atlas = w.ids.atlas;
  const version = (await w.config()).source.version as number;
  const preview = (selection: string, v = version) => [
    "project",
    "preview-source",
    atlas,
    "--selection",
    selection,
    "--expected-version",
    String(v),
  ];
  const before = databaseDigest(w.s.f);
  const denied = await w.cli("ro", preview("S-1"));
  assert.equal(denied.code, 3, denied.out);
  assert.equal(databaseDigest(w.s.f), before);
  assert.equal(w.reader.reads, 0);

  const first = await w.ok("rw", preview("S-1"));
  assert.deepEqual(first.data.receipt.result, {
    commandType: "github.preview",
    resourceId: atlas,
    selectionId: "S-1",
    configVersion: version,
    active: true,
  });
  assert.equal(first.data.current.active, true);
  assert.equal(first.data.current.observation.state, "never");
  const human = await w.h.run([...preview("S-1"), "--connection", "rw"]);
  assert.match(human.out, /imports no tasks and does not prove a sync/);
  assert.match(human.out, /observation never/);
  assert.deepEqual(
    (await w.config()).source.selections.map((s: Json) => s.active),
    [true, false, false],
  );
  assert.equal(w.reader.reads, 1, "an identical rerun replays the receipt");

  // Advisory gates send nothing.
  for (const [code, args] of [
    [4, preview("S-2", version + 1)],
    [2, preview("S-9")],
  ] as const) {
    const r = await w.cli("rw", args);
    assert.equal(r.code, code, r.out);
  }
  const noCredential = w.ids.fieldnotes;
  const configured = await w.s.sessionPost("/api/operator/commands", {
    type: "github.configure",
    key: randomUUID(),
    projectId: noCredential,
    expectedVersion: (await w.config(noCredential)).source.version,
    selections: [{ id: "S-1", kind: "search", query: "q" }],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [],
  });
  assert.equal(configured.status, 200);
  const unconfigured = await w.cli("rw", [
    "project",
    "preview-source",
    noCredential,
    "--selection",
    "S-1",
    "--expected-version",
    String((await w.config(noCredential)).source.version),
  ]);
  assert.equal(unconfigured.code, 4, unconfigured.out);
  assert.match(
    unconfigured.json().error.message,
    /GitHub source credential required/,
  );
  assert.equal(w.reader.reads, 1);
  const noCredentialSource = (await w.config(noCredential)).source;
  assert.equal(w.s.f.service.domain().discoveryCredentialReference(), null);
  const ghConfigured = await w.s.sessionPost("/api/operator/commands", {
    type: "github.configure",
    key: randomUUID(),
    projectId: noCredential,
    expectedVersion: noCredentialSource.version,
    credentialRef: "gh:github.com",
    selections: [{ id: "S-1", keep: true }],
    readiness: ruleOf(noCredentialSource.readiness),
    repositories: [],
  });
  assert.equal(ghConfigured.status, 200);
  const ghVersion = (await w.config(noCredential)).source.version;
  const unusable = await w.cli("rw", [
    "project",
    "preview-source",
    noCredential,
    "--selection",
    "S-1",
    "--expected-version",
    String(ghVersion),
  ]);
  assert.equal(unusable.code, 4, unusable.out);
  assert.match(unusable.json().error.message, /GitHub CLI is not installed/);
  assert.equal(
    w.reader.reads,
    1,
    "unusable source credentials never reach the provider reader",
  );

  // An incomplete read activates nothing; a failed read is an unknown outcome.
  w.reader.mode = "incomplete";
  const incomplete = await w.cli("rw", preview("S-2"));
  assert.equal(incomplete.code, 4, incomplete.out);
  assert.match(incomplete.json().error.message, /Not activated/);
  w.reader.mode = "throw";
  const failed = await w.cli("rw", preview("S-3"));
  assert.equal(failed.code, 6, failed.out);
  assert.equal(failed.json().error.request.type, "github.preview");
  assert.deepEqual(
    (await w.config()).source.selections.map((s: Json) => s.active),
    [true, false, false],
  );

  // A later save deactivates; rerunning the old preview replays it and says so.
  w.reader.mode = "complete";
  const reads = w.reader.reads;
  const saved = await w.s.sessionPost("/api/operator/commands", {
    type: "github.configure",
    key: randomUUID(),
    projectId: atlas,
    expectedVersion: version,
    selections: ["S-1", "S-2", "S-3"].map((id) => ({ id, keep: true })),
    readiness: ruleOf((await w.config()).source.readiness),
    repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
  });
  assert.equal(saved.status, 200);
  const replay = await w.ok("rw", preview("S-1"));
  assert.equal(replay.request.key, first.request.key);
  assert.deepEqual(replay.data.receipt, first.data.receipt);
  assert.equal(replay.data.current.active, false);
  assert.equal(replay.data.current.version, version + 1);
  const replayText = await w.h.run([...preview("S-1"), "--connection", "rw"]);
  assert.match(replayText.out, /S-1 is NOT active/);
  assert.match(replayText.out, new RegExp(`--expected-version ${version + 1}`));
  assert.equal(w.reader.reads, reads);

  // A lost reply survives a restart and the rerun records once.
  const lost = await w.cli("rw", preview("S-3", version + 1), {
    fetch: w.lostReply,
  });
  assert.equal(lost.code, 6, lost.out);
  assert.match(lost.json().error.message, /operation get/);
  const current = await w.config();
  const clear = await w.s.sessionPost("/api/operator/commands", {
    type: "github.configure",
    key: randomUUID(),
    projectId: atlas,
    expectedVersion: current.source.version,
    credentialRef: null,
    selections: current.source.selections.map((s: Json) => ({
      id: s.id,
      keep: true,
    })),
    readiness: ruleOf(current.source.readiness),
    repositories: current.source.repositories,
  });
  assert.equal(clear.status, 200);
  const beforeReplayReads = w.reader.reads;
  await w.s.restart();
  const settled = await w.ok("rw", preview("S-3", version + 1));
  assert.equal(settled.request.key, lost.json().error.request.key);
  assert.equal(settled.data.current.active, false);
  assert.equal(
    w.reader.reads,
    beforeReplayReads,
    "replay after Clear does not reread the provider",
  );
  const read = await w.ok("rw", [
    "operation",
    "get",
    settled.request.key,
    "--scope",
    `project:${atlas}`,
    "--type",
    "github.preview",
  ]);
  assert.deepEqual(read.data.receipt, settled.data.receipt);
});

test("place-task chooses a matching project once, with the domain's placement rules", async (t) => {
  const w = await world(t);
  const { atlas, relay, fieldnotes } = w.ids;
  const tasks = [randomUUID(), randomUUID(), randomUUID()];
  for (const [i, taskId] of tasks.entries())
    seedImportedConflict(w.s.f, taskId, [atlas, relay], `I_PLACE_${i}`, i + 1);
  const [otherTask = "", plainTask = "", assignedTask = ""] = tasks;
  w.d.execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId: atlas,
    taskId: assignedTask,
    assignmentId: randomUUID(),
    profileId: w.ids.profiles.Mira as string,
    brief: "Work",
    resultDestination: "operator",
    requesterAssignmentId: null,
  });
  const sources = await w.ok("ro", ["project", "sources", atlas]);
  const placement = sources.data.placements.find(
    (p: Json) => p.taskId === plainTask,
  );
  assert.deepEqual(
    placement.choices.map((c: Json) => c.id).sort(),
    [atlas, relay].sort(),
  );
  const version = (taskId: string) =>
    Number(w.s.f.service.domain().task(taskId).version);
  const place = (taskId: string, to: string, v = version(taskId)) => [
    "project",
    "place-task",
    taskId,
    "--to",
    to,
    "--expected-version",
    String(v),
  ];
  const before = databaseDigest(w.s.f);
  assert.equal((await w.cli("ro", place(plainTask, relay))).code, 3);
  for (const args of [
    place(plainTask, relay, version(plainTask) + 1),
    place(plainTask, fieldnotes),
    place(w.s.taskId, relay),
    place(assignedTask, relay),
  ]) {
    const r = await w.cli("rw", args);
    assert.equal(r.code, 4, `${args.join(" ")}: ${r.out}`);
  }
  assert.equal(databaseDigest(w.s.f), before);
  // The service refuses direct HTTP the same way.
  const direct = await w.s.sessionPost("/api/operator/commands", {
    type: "github.place",
    key: randomUUID(),
    projectId: atlas,
    taskId: plainTask,
    chosenProjectId: relay,
    expectedVersion: version(plainTask) + 1,
  });
  assert.equal(direct.status, 409);

  const placed = await w.ok("rw", place(plainTask, relay));
  assert.equal(placed.data.receipt.result.commandType, "github.place");
  assert.equal(placed.data.receipt.result.resourceId, plainTask);
  assert.equal(w.s.f.service.domain().task(plainTask).projectId, relay);
  const human = await w.h.run([
    ...place(otherTask, relay),
    "--connection",
    "rw",
    "--request-id",
    randomUUID(),
  ]);
  assert.match(human.out, /neither starts work nor grants repository access/);
  assert.ok(
    !(await w.ok("ro", ["project", "sources", atlas])).data.placements.some(
      (p: Json) => p.taskId === plainTask,
    ),
  );

  // A lost reply is reconciled by rerunning under the same key.
  const third = randomUUID();
  seedImportedConflict(w.s.f, third, [atlas, relay], "I_PLACE_LOST", 9);
  const v = version(third);
  const lost = await w.cli("rw", place(third, relay, v), {
    fetch: w.lostReply,
  });
  assert.equal(lost.code, 6, lost.out);
  assert.match(lost.json().error.message, /--request-id/);
  assert.doesNotMatch(lost.json().error.message, /operation get/);
  assert.equal(
    w.s.f.service.domain().task(third).projectId,
    relay,
    "the lost attempt applied",
  );
  await w.s.restart();
  const applied = version(third);
  const rerun = await w.ok("rw", place(third, relay, v));
  assert.equal(rerun.request.key, lost.json().error.request.key);
  assert.equal(rerun.data.receipt, null);
  assert.equal(rerun.data.current.projectId, relay);
  assert.equal(version(third), applied, "placed once");
});

test("a setup-recorded GitHub CLI source credential reads back the same in JSON, HTML and the CLI, and after Clear", async (t) => {
  const gh = createFakeGh();
  t.after(() => gh.close());
  const w = await world(t, gh.executable);
  const projectId = randomUUID();
  const created = await w.s.sessionPost("/api/operator/commands", {
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "Defaulted",
    leadProfileId: null,
    sourceCredentialRef: "gh:github.com",
  });
  assert.equal(created.status, 200);
  const readBack = async () => {
    const source = (await w.config(projectId)).source;
    const html = await (await w.s.sessionGet(`/project/${projectId}`)).text();
    const human = await w.h.run([
      "project",
      "sources",
      projectId,
      "--connection",
      "ro",
    ]);
    assert.equal(human.code, 0, human.err);
    assert.ok(!html.includes(fakeGhToken) && !human.out.includes(fakeGhToken));
    return { source, html, cli: human.out };
  };
  const defaulted = await readBack();
  assert.equal(defaulted.source.version, 1);
  assert.equal(defaulted.source.credential.source, "gh");
  assert.equal(defaulted.source.credential.usable, true);
  assert.match(defaulted.html, /Credential: GitHub CLI\. Usable\./);
  assert.match(defaulted.html, /Detected GitHub CLI account @octo\./);
  assert.match(defaulted.cli, /Credential:\s+GitHub CLI\n/);
  assert.match(defaulted.cli, /Detected GitHub CLI account:\s+@octo/);
  const cleared = await w.s.sessionPost("/api/operator/commands", {
    type: "github.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    credentialRef: null,
    selections: [],
    readiness: ruleOf(defaulted.source.readiness),
    repositories: [],
  });
  assert.equal(cleared.status, 200);
  const after = await readBack();
  assert.equal(after.source.version, 2);
  assert.equal(after.source.credentialConfigured, false);
  assert.equal(after.source.credential.configured, false);
  assert.match(after.html, /Credential: not configured\./);
  assert.match(after.cli, /Credential:\s+not configured\n/);
});
