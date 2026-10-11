import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { operatorCommandSchema } from "../src/operator/contracts.js";
import { ClientError, OperatorClient } from "../web/src/api.js";
import { ConfigurationDraft } from "../web/src/settings-state.js";
import { settingsHeader } from "../web/src/settings-view.js";
import {
  buildProjectCreate,
  duplicateRows,
  emptyRow,
  folderCaption,
  parseTypedRepository,
  pickerStart,
  rowsFromDraft,
  rowsToDraft,
  typedRepositoryId,
  typeRepository,
  verificationCopy,
} from "../web/src/setup-model.js";

const values = {
  key: randomUUID(),
  projectId: randomUUID(),
  name: "Atlas",
  leadProfileId: "",
  instructions: "  ",
};

test("typed repositories and rows build the one create command", () => {
  assert.equal(typedRepositoryId("Acme", "Atlas"), "github.com/acme/atlas");
  for (const bad of [
    "acme",
    "acme/",
    "a/b/c",
    "acme /atlas",
    "../x",
    "acme/..",
  ])
    assert.equal(parseTypedRepository(bad), null, bad);
  assert.deepEqual(parseTypedRepository(" acme/atlas "), {
    owner: "acme",
    name: "atlas",
  });
  const bare = buildProjectCreate(values, [emptyRow("discovered")], "PVT_x");
  assert.equal("instructions" in bare.command, false);
  assert.equal("repositories" in bare.command, false);
  assert.deepEqual(bare.rowIndex, []);
  assert.equal(operatorCommandSchema.safeParse(bare.command).success, true);
  const typed = {
    ...typeRepository(emptyRow("typed"), "Acme/Atlas"),
    ref: "main",
    path: "~/src/atlas",
  };
  const rows = [typed, emptyRow("typed"), { ...typed, id: "dup" }];
  assert.deepEqual([...duplicateRows(rows)], ["dup"]);
  // A typed row and a discovered row naming the same repository collide.
  assert.deepEqual(
    [
      ...duplicateRows([
        typed,
        {
          ...emptyRow("discovered"),
          id: "node",
          repositoryId: "R_atlas",
          owner: "acme",
          name: "atlas",
        },
      ]),
    ],
    ["node"],
  );
  const { command, rowIndex } = buildProjectCreate(
    { ...values, instructions: "Private" },
    rows.slice(0, 2),
    "PVT_atlas",
  );
  assert.deepEqual(rowIndex, [0]);
  assert.deepEqual(command, {
    type: "project.create",
    key: values.key,
    projectId: values.projectId,
    name: "Atlas",
    leadProfileId: null,
    instructions: "Private",
    repositories: [
      {
        repositoryId: "github.com/acme/atlas",
        owner: "Acme",
        name: "Atlas",
        path: "~/src/atlas",
        ref: "main",
      },
    ],
    githubProject: { projectNodeId: "PVT_atlas" },
  });
  assert.equal(operatorCommandSchema.safeParse(command).success, true);
  assert.deepEqual(rowsFromDraft(rowsToDraft(rows)), rows);
  assert.deepEqual(rowsFromDraft("not json"), []);
});

test("verification and folder copy never include a path", () => {
  const expected = { owner: "acme", name: "atlas", ref: "main" };
  assert.equal(
    verificationCopy(
      { state: "rejected", reason: "origin-mismatch", origin: "acme/relay" },
      expected,
    ),
    "This folder is a checkout of acme/relay, not acme/atlas. Choose another folder or change the repository.",
  );
  assert.equal(
    verificationCopy(
      { state: "verified", origin: "acme/atlas", branch: "main" },
      expected,
    ),
    "Verified on this Mac: git checkout · origin acme/atlas · main available.",
  );
  const reasons = [
    "path-invalid",
    "not-checkout",
    "origin-missing",
    "origin-provider",
    "ref-unavailable",
    "unreadable",
  ] as const;
  const copies = reasons.map((reason) =>
    verificationCopy({ state: "rejected", reason, origin: null }, expected),
  );
  assert.equal(new Set(copies).size, reasons.length);
  assert.ok(copies.every((c) => !c.includes("/src")));
  assert.equal(
    folderCaption({
      name: "a",
      kind: "git",
      origin: "acme/atlas",
      branch: "main",
    }),
    "Git checkout · origin acme/atlas · main",
  );
  assert.equal(
    folderCaption({ name: "a", kind: "folder", origin: null, branch: null }),
    "Folder",
  );
  assert.equal(pickerStart("~/src/atlas"), "~/src");
  assert.equal(pickerStart(""), "~");
  assert.equal(pickerStart("/Users/x/src"), "~");
});

test("setup posts carry CSRF and a JSON body and surface refusals", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const client = new OperatorClient(async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(
      { error: { code: "forbidden", message: "Request denied." } },
      { status: 403 },
    );
  });
  await assert.rejects(
    client.folders("~/src/escape", "csrf"),
    (e) => e instanceof ClientError && e.code === "forbidden",
  );
  await assert.rejects(
    client.verifyCheckout(
      {
        path: "~/src/atlas",
        repository: { owner: "acme", name: "atlas" },
        ref: "main",
      },
      "csrf",
    ),
    (e) => e instanceof ClientError && e.status === 403,
  );
  for (const call of calls) {
    assert.equal(call.init?.method, "POST");
    assert.equal(new Headers(call.init?.headers).get("x-csrf-token"), "csrf");
    assert.equal(call.url.includes("~"), false);
  }
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    path: "~/src/escape",
  });
});

test("a discovery credential receipt settles only its own outcome", async () => {
  const receipt = (configured: boolean) =>
    new OperatorClient(async (_url, init) => {
      const c = JSON.parse(String(init?.body));
      return Response.json({
        kind: "configuration",
        key: c.key,
        recorded: true,
        result: {
          commandType: "discovery.configure",
          resourceId: "system:discovery",
          configured,
        },
      });
    });
  const command = {
    type: "discovery.configure" as const,
    key: randomUUID(),
    credentialRef: "env:FIXTURE_DISCOVERY",
  };
  const matched = new ConfigurationDraft();
  await matched.submit(receipt(true), command, "csrf");
  assert.equal(matched.phase, "recorded");
  const mismatched = new ConfigurationDraft();
  await mismatched.submit(receipt(false), command, "csrf");
  assert.equal(mismatched.phase, "unknown");
});

test("setup headers follow the first-run and settings frames", () => {
  const workspace = (projects: number) =>
    ({
      data: {
        projects: Array.from({ length: projects }, () => ({
          id: randomUUID(),
        })),
        profiles: [],
      },
    }) as never;
  assert.deepEqual(
    settingsHeader("/app/settings/projects/new", "", workspace(0)),
    {
      title: "Set up your first project",
      trail: [{ label: "Overview", href: "/app" }, { label: "New project" }],
    },
  );
  assert.deepEqual(
    settingsHeader("/app/settings/projects/new", "", workspace(1))?.trail.map(
      (c) => c.label,
    ),
    ["Settings", "Projects", "Create project"],
  );
});
