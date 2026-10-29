import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startCliOperator } from "../fixtures/operator-cli.js";
import { fakeJira, jiraIssue, json } from "../fixtures/fake-jira.js";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes are asserted structurally
type Json = Record<string, any>;

const site = "example.atlassian.net";
process.env.FIXTURE_JIRA_SITE = `https://${site}`;
process.env.FIXTURE_JIRA_EMAIL = "chris@example.test";
process.env.FIXTURE_JIRA_TOKEN = "jira-cli-token-canary-1318";

async function world(t: Parameters<typeof startCliOperator>[0]) {
  const jira = fakeJira((request) => {
    if (request.url.pathname.endsWith("/jql/parse"))
      return json({ queries: [{ query: "ok" }] });
    return json({ issues: [jiraIssue(1)] });
  });
  const o = await startCliOperator(t, {
    service: {
      supervisor: { observationMs: 50 },
      issueTrackers: { jiraFetcher: jira.fetcher },
    },
  });
  const projectId = randomUUID();
  o.d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Jira CLI",
    leadProfileId: null,
  });
  o.d.execute({
    type: "issue-tracker-credential.configure",
    actor: "operator",
    key: randomUUID(),
    issueTracker: "jira",
    instance: site,
    credential: {
      siteRef: "env:FIXTURE_JIRA_SITE",
      emailRef: "env:FIXTURE_JIRA_EMAIL",
      tokenRef: "env:FIXTURE_JIRA_TOKEN",
    },
  });
  const ok = async (connection: "ro" | "rw", args: string[]) => {
    const r = await o.cli(connection, args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}${r.out}`);
    return r.json() as Json;
  };
  const file = (name: string, text: string) => {
    const path = join(o.h.dir, name);
    writeFileSync(path, text);
    return path;
  };
  return { ...o, projectId, ok, file };
}

test("prepare-source and apply save a Jira source without showing the query, then sources lists it", async (t) => {
  const w = await world(t);
  const edit = {
    jira: {
      instance: site,
      selections: [{ jql: "project = ABC AND labels = SECRET-JQL-CANARY" }],
    },
  };
  const out = join(w.h.dir, "jira-source.json");
  const prepared = await w.ok("ro", [
    "project",
    "prepare-source",
    w.projectId,
    "--out",
    out,
    "--edit-file",
    w.file("edit.json", JSON.stringify(edit)),
  ]);
  const document = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(document.kind, "jira.configure");
  assert.deepEqual(document.command, {
    type: "jira.configure",
    projectId: w.projectId,
    expectedVersion: 1,
    instance: site,
    selections: [
      {
        id: "S-1",
        kind: "jql",
        jql: "project = ABC AND labels = SECRET-JQL-CANARY",
      },
    ],
  });
  assert.equal(
    JSON.stringify(prepared.data.document.preview).includes(
      "SECRET-JQL-CANARY",
    ),
    false,
  );
  const applied = await w.ok("rw", ["project", "apply", "--file", out]);
  assert.deepEqual(applied.data.receipt.result, {
    commandType: "jira.configure",
    resourceId: w.projectId,
    version: 2,
    selectionCount: 1,
  });

  // A refresh imports the issue; sources shows the Jira selection and its last success.
  await w.s.sessionPost("/api/operator/source-refresh", {});
  const sources = await w.ok("ro", ["project", "sources", w.projectId]);
  assert.equal(sources.data.source.tracker, "jira");
  assert.equal(sources.data.source.instance, site);
  assert.equal(sources.data.observations[0].state, "complete");
  assert.ok(sources.data.observations[0].lastSuccessfulAt);
  assert.deepEqual(sources.coverage.gaps, []);
  const human = await w.h.run([
    "project",
    "sources",
    w.projectId,
    "--connection",
    "ro",
  ]);
  assert.equal(human.code, 0, human.err);
  assert.match(human.out, /Issue tracker: +Jira example\.atlassian\.net/);
  assert.match(human.out, /S-1 +Jira JQL +\(query private\)/);
  for (const secret of [
    "SECRET-JQL-CANARY",
    "FIXTURE_JIRA_TOKEN",
    process.env.FIXTURE_JIRA_TOKEN ?? "",
  ]) {
    assert.equal(human.out.includes(secret), false, secret);
    assert.equal(JSON.stringify(sources).includes(secret), false, secret);
  }
});

test("a Jira project accepts only the jira edit, and a GitHub edit key is refused", async (t) => {
  const w = await world(t);
  const edit = (value: unknown) => w.file("bad.json", JSON.stringify(value));
  const configured = [
    "project",
    "prepare-source",
    w.projectId,
    "--out",
    join(w.h.dir, "x.json"),
    "--edit-file",
  ];
  const mixed = await w.cli("ro", [
    ...configured,
    edit({
      jira: { instance: site, selections: [] },
      removeSelections: ["S-1"],
    }),
  ]);
  assert.notEqual(mixed.code, 0);
  assert.match(mixed.out + mixed.err, /carries no other key/);
});
