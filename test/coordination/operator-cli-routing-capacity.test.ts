import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { digestOf } from "../../src/cli/change-document.js";
import { harness } from "../fixtures/cli-harness.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import { seedInstructionHistory } from "../fixtures/instruction-history.js";
import { startCliService } from "../fixtures/operator-cli.js";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes are asserted structurally
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
    const issued = await s.issue(scope, `rc-${name}`);
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
  const cli = (connection: "ro" | "rw", args: string[]) =>
    h.run([...args, "--connection", connection, "--output", "json"]);
  const out = () => join(h.dir, `${randomUUID()}.json`);
  return { s, seed, h, cli, out, d: s.f.service.domain() };
}

test("routing changes through reviewed documents", async (t) => {
  const { s, seed, h, cli, out, d } = await setup(t);
  const other = randomUUID();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: other,
    name: "Other",
    instructions: "o",
    capabilities: "c",
  });
  const guidance = join(h.dir, "guidance.md");
  writeFileSync(guidance, "Route reviews to Other", { mode: 0o600 });
  let doc = out();
  const fetched = h.fetches.length;
  let r = await cli("ro", [
    "project",
    "prepare-routing",
    seed.projectA,
    "--enabled",
    "true",
    "--candidates",
    `${seed.profileId},${other}`,
    "--guidance-file",
    guidance,
    "--out",
    doc,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  const document = r.json().data.document;
  assert.deepEqual(
    document.preview.changes.map((c: Json) => c.field),
    ["enabled", "candidateProfileIds", "guidance"],
  );
  assert.ok(document.preview.diff.lines.includes("+ Route reviews to Other"));
  assert.match(
    document.preview.notes.join(" "),
    /current guidance is not readable/,
  );
  assert.ok(
    h.fetches
      .slice(fetched)
      .every((f) =>
        /\/api\/operator\/(cli|projects\/[^/]+\/configuration)$/.test(f),
      ),
  );
  r = await cli("rw", ["project", "apply", "--file", doc]);
  assert.equal(r.code, 0, r.err + r.out);
  const receipt = r.json().data.receipt;
  assert.equal(receipt.result.enabled, true);
  assert.equal(receipt.result.credentialConfigured, true);
  const readBack = await cli("ro", [
    "operation",
    "get",
    receipt.key,
    "--scope",
    `project:${seed.projectA}`,
    "--type",
    "routing.configure",
  ]);
  assert.deepEqual(readBack.json().data, { state: "recorded", receipt });
  assert.equal(d.routing(seed.projectA).guidance, "Route reviews to Other");

  for (const [ref, configured] of [
    ["none", false],
    ["env:CLI3_ROUTING", true],
  ] as const) {
    doc = out();
    r = await cli("ro", [
      "project",
      "prepare-routing",
      seed.projectA,
      "--credential-ref",
      ref,
      "--out",
      doc,
    ]);
    assert.equal(r.code, 0, r.err + r.out);
    r = await cli("rw", ["project", "apply", "--file", doc]);
    assert.equal(r.code, 0, r.err + r.out);
    assert.equal(r.json().data.receipt.result.credentialConfigured, configured);
  }

  // Revoked saved candidates are dropped and listed; naming one is rejected.
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: other,
    expectedVersion: 1,
    revoked: true,
  });
  for (const candidates of [other, randomUUID()]) {
    r = await cli("ro", [
      "project",
      "prepare-routing",
      seed.projectA,
      "--candidates",
      candidates,
      "--out",
      out(),
    ]);
    assert.equal(r.code, 2, candidates);
  }
  doc = out();
  r = await cli("ro", [
    "project",
    "prepare-routing",
    seed.projectA,
    "--out",
    doc,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(
    r.json().data.document.preview.notes.join(" "),
    new RegExp(other),
  );

  // A concurrent routing edit stops the apply.
  const routing = d.routing(seed.projectA);
  const bumped = await s.sessionPost("/api/operator/commands", {
    type: "routing.configure",
    key: randomUUID(),
    projectId: seed.projectA,
    expectedVersion: Number(routing.version),
    enabled: false,
    candidateProfileIds: [seed.profileId],
  });
  assert.equal(bumped.status, 200);
  const before = databaseDigest(s.f);
  r = await cli("rw", ["project", "apply", "--file", doc]);
  assert.equal(r.code, 4, r.out);
  assert.equal(databaseDigest(s.f), before);
  // A routing document is prepared again with prepare-routing, not project prepare.
  const human = await h.run([
    "project",
    "apply",
    "--file",
    doc,
    "--connection",
    "rw",
  ]);
  assert.equal(human.code, 4);
  assert.match(
    human.err,
    new RegExp(
      `^Fix: Review project:${seed.projectA} with 'cab project get ${seed.projectA}', then run 'cab project prepare-routing' again\\.$`,
      "m",
    ),
  );
});

test("capacity reads, prepares and applies with a server-side guard", async (t) => {
  const { s, seed, h, cli, out, d } = await setup(t);
  const before = databaseDigest(s.f);
  let r = await cli("ro", ["capacity", "get"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.json().data.globalLimit, 6);
  assert.equal(r.json().data.minimumLeadSlots, 1);
  assert.equal(r.json().data.leadUsage, 0);
  assert.deepEqual(
    r.json().data.projects.find((p: Json) => p.projectId === seed.projectA)
      .limit,
    null,
  );
  assert.deepEqual(
    r.json().data.agents.find((a: Json) => a.agentId === seed.profileId),
    {
      agentId: seed.profileId,
      name: r.json().data.agents[0].name,
      limit: null,
      usage: 0,
    },
  );
  const human = await h.run(["capacity", "get", "--connection", "ro"]);
  assert.equal(human.code, 0, human.err);
  assert.match(human.out, /^Minimum lead slots: 1$/m);
  assert.match(
    human.out,
    new RegExp(`^${seed.projectA}\\s+Alpha\\s+none\\s+0$`, "m"),
  );
  assert.ok(!("tasks" in r.json().data.projects[0]));
  assert.equal(typeof r.json().coverage.observedAt, "number");
  assert.equal(databaseDigest(s.f), before);

  let doc = out();
  r = await cli("ro", [
    "capacity",
    "prepare",
    "--global-limit",
    "7",
    "--min-lead-slots",
    "0",
    "--project-limit",
    `${seed.projectA}=3`,
    "--agent-limit",
    `${seed.profileId}=2`,
    "--out",
    doc,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  const document = JSON.parse(readFileSync(doc, "utf8")) as Json;
  assert.equal(document.command.minimumLeadSlots, 0);
  assert.deepEqual(document.command.agentOverrides, { [seed.profileId]: 2 });
  assert.deepEqual(document.command.expectedCurrent, {
    globalLimit: 6,
    minimumLeadSlots: 1,
    projectOverrides: { [seed.projectA]: null },
    agentOverrides: { [seed.profileId]: null },
  });
  // A document prepared before lead slots and agent caps is refused, not applied.
  const stale = JSON.parse(readFileSync(doc, "utf8")) as Json;
  const { digest: _digest, ...staleBody } = stale;
  delete staleBody.command.minimumLeadSlots;
  delete staleBody.command.agentOverrides;
  delete staleBody.command.expectedCurrent.minimumLeadSlots;
  delete staleBody.command.expectedCurrent.agentOverrides;
  const staleDoc = out();
  writeFileSync(
    staleDoc,
    JSON.stringify({ ...staleBody, digest: digestOf(staleBody) }),
    { mode: 0o600 },
  );
  const beforeStale = databaseDigest(s.f);
  r = await cli("rw", ["capacity", "apply", "--file", staleDoc]);
  assert.notEqual(r.code, 0, r.out);
  assert.equal(databaseDigest(s.f), beforeStale);
  r = await cli("rw", ["capacity", "apply", "--file", doc]);
  assert.equal(r.code, 0, r.err + r.out);
  const receipt = r.json().data.receipt;
  assert.deepEqual(receipt.result.projectOverrides, { [seed.projectA]: 3 });
  assert.deepEqual(receipt.result.agentOverrides, { [seed.profileId]: 2 });
  assert.equal(receipt.result.minimumLeadSlots, 0);
  assert.match(
    (await cli("rw", ["capacity", "apply", "--file", doc])).out,
    /"globalLimit":7/,
  );
  r = await cli("ro", [
    "operation",
    "get",
    receipt.key,
    "--scope",
    "system:capacity",
    "--type",
    "capacity.configure",
  ]);
  assert.deepEqual(r.json().data, { state: "recorded", receipt });

  doc = out();
  r = await cli("ro", [
    "capacity",
    "prepare",
    "--project-limit",
    `${seed.projectA}=none`,
    "--agent-limit",
    `${seed.profileId}=none`,
    "--out",
    doc,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  r = await cli("rw", ["capacity", "apply", "--file", doc]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(d.capacityLimits().projectOverrides, {});
  assert.deepEqual(d.capacityLimits().agentOverrides, {});

  // A browser change between prepare and apply is detected by the server guard.
  doc = out();
  r = await cli("ro", [
    "capacity",
    "prepare",
    "--global-limit",
    "2",
    "--out",
    doc,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  const browser = await s.sessionPost("/api/operator/commands", {
    type: "capacity.configure",
    key: randomUUID(),
    globalLimit: 5,
    minimumLeadSlots: 0,
    projectOverrides: {},
  });
  assert.equal(browser.status, 200);
  r = await cli("rw", ["capacity", "apply", "--file", doc]);
  assert.equal(r.code, 4, r.out);
  assert.equal(r.json().error.code, "conflict");
  assert.equal(d.capacityLimits().globalLimit, 5);

  for (const args of [
    ["--project-limit", `${randomUUID()}=1`],
    ["--project-limit", `${seed.projectA}=0`],
    ["--project-limit", `${seed.projectA}=default`],
    ["--agent-limit", `${randomUUID()}=1`],
    ["--agent-limit", `${seed.profileId}=0`],
    ["--min-lead-slots", "-1"],
    ["--min-lead-slots", "x"],
    ["--min-lead-slots", "5"],
    ["--global-limit", "5"],
  ]) {
    r = await cli("ro", ["capacity", "prepare", ...args, "--out", out()]);
    assert.equal(r.code, 2, args.join(" "));
  }
});
