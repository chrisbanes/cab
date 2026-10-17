import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  operatorCommandSchema,
  type HarnessStatus,
  type Workspace,
} from "../../src/operator/contracts.js";
import {
  readinessCheckIds,
  readinessSchema,
} from "../../src/operator/readiness.js";
import { sourceCredentialExplanation } from "../../src/operator/source-credential.js";
import { ClientError, OperatorClient } from "../../web/src/api.js";
import { ConfigurationDraft } from "../../web/src/settings-state.js";
import { settingsHeader } from "../../web/src/settings-view.js";
import {
  blankRow,
  buildProjectCreate,
  duplicateRows,
  emptyRow,
  folderCaption,
  listedProject,
  parseTypedRepository,
  pickerStart,
  type ReadinessRead,
  readyCheckItems,
  rowsFromDraft,
  rowsToDraft,
  setupSourceCredentialCopy,
  sourceCredentialLine,
  typedRepositoryId,
  typeRepository,
  verificationCopy,
} from "../../web/src/setup-model.js";

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
  // Setup latches the heading for the visit, so the project it creates keeps it.
  assert.equal(
    settingsHeader("/app/settings/projects/new", "", workspace(1), true)?.title,
    "Set up your first project",
  );
  assert.equal(
    settingsHeader("/app/settings/projects/new", "", workspace(0), false)
      ?.title,
    "Create project",
  );
});

test("a Project is sent only while the current list shows it", () => {
  const list = {
    linked: [{ projectNodeId: "PVT_atlas" }],
    owned: [{ projectNodeId: "PVT_web" }],
  };
  assert.equal(listedProject("PVT_atlas", list), "PVT_atlas");
  assert.equal(listedProject("PVT_web", list), "PVT_web");
  // Loading, unavailable or a changed list: the control shows nothing, so nothing is sent.
  assert.equal(listedProject("PVT_atlas", null), "");
  assert.equal(listedProject("PVT_gone", list), "");
  assert.equal(listedProject("", list), "");
});

test("a visible ref alone makes a row count", () => {
  // Typed entry shows the Ref field, so a ref there is operator input that must be validated.
  assert.equal(blankRow({ ...emptyRow("typed"), ref: "main" }), false);
  // A discovered row without a repository hides its Ref field.
  assert.equal(blankRow({ ...emptyRow("discovered"), ref: "main" }), true);
  assert.equal(blankRow(emptyRow("typed")), true);
  const { rowIndex } = buildProjectCreate(
    values,
    [{ ...emptyRow("typed"), ref: "main" }],
    "",
  );
  assert.deepEqual(rowIndex, [0]);
});

const leadId = randomUUID();
const harness = (
  name: "codex" | "claude",
  state: "available" | "not-configured" | "unavailable" = "available",
): HarnessStatus =>
  state === "unavailable"
    ? {
        harness: name,
        enabled: true,
        state,
        since: 1,
        policy: null,
        settings: null,
      }
    : state === "not-configured"
      ? {
          harness: name,
          enabled: true,
          state,
          reason: "executable-missing",
          policy: null,
          settings: null,
        }
      : { harness: name, enabled: true, state, policy: null, settings: null };
const workspace = (
  lead: "codex" | "claude" | null,
  patch: Partial<Workspace["data"]> = {},
): Workspace["data"] => ({
  projects: [],
  profiles: lead
    ? [
        {
          id: leadId,
          name: "Mira Private",
          summary: "",
          version: 1,
          revoked: false,
          runtime:
            lead === "claude"
              ? { harness: "claude", model: null, reasoningEffort: null }
              : { harness: "codex" },
        },
      ]
    : [],
  runtime: { state: "available" },
  harnesses: [harness("codex"), harness("claude", "not-configured")],
  gettingStarted: { turnStarted: false, dismissed: false },
  ...patch,
});
/** A schema-valid readiness read: everything passes except the named checks. */
const readiness = (
  failing: Partial<Record<(typeof readinessCheckIds)[number], string>> = {},
): ReadinessRead => {
  const checks = readinessCheckIds.map((id) => {
    const status = failing[id];
    return {
      id,
      label: id,
      status: (status ?? "pass") as "pass" | "fail" | "not-configured",
      reason: status ? `${id} reason` : null,
      fix: status ? `${id} fix` : null,
    };
  });
  readinessSchema.parse({ data: { checks }, observedAt: 1 });
  return { state: "ready", checks };
};
const free = {
  globalUsage: 0,
  globalLimit: 4,
  projectUsage: 0,
  projectLimit: 2,
};
const input = (
  patch: Partial<Parameters<typeof readyCheckItems>[0]> = {},
): Parameters<typeof readyCheckItems>[0] => ({
  leadProfileId: leadId,
  workspace: workspace("codex"),
  readiness: readiness(),
  capacity: free,
  ...patch,
});

test("the ready check lists only what would make this lead's work wait", () => {
  assert.deepEqual(readyCheckItems(input()), {
    items: [],
    checking: false,
    blocked: false,
    capacityFull: false,
  });
  // No lead, or one revoked since creation.
  for (const missing of [
    input({ leadProfileId: null }),
    input({
      workspace: {
        ...workspace("codex"),
        profiles: workspace("codex").profiles.map((p) => ({
          ...p,
          revoked: true,
        })),
      },
    }),
  ]) {
    const result = readyCheckItems(missing);
    assert.deepEqual(
      result.items.map((i) => i.text),
      ["No lead profile. Tasks wait for a lead before starting."],
    );
    assert.equal(result.blocked, true);
  }
  // A Codex lead reads the Codex checks and ignores the others.
  const login = readyCheckItems(
    input({ readiness: readiness({ "codex-login": "fail", git: "fail" }) }),
  );
  assert.deepEqual(login.items, [
    { text: "codex-login reason", fix: "codex-login fix" },
  ]);
  assert.equal(login.blocked, true);
  // A Claude lead reads the token check, and its fix is Add Claude.
  const token = readyCheckItems(
    input({
      workspace: workspace("claude", {
        harnesses: [harness("codex"), harness("claude")],
      }),
      readiness: readiness({
        "claude-token": "not-configured",
        "codex-login": "fail",
      }),
    }),
  );
  assert.deepEqual(token.items, [
    {
      text: "claude-token reason",
      fix: "claude-token fix",
      link: { label: "Add Claude", href: "/app/settings/runtime" },
    },
  ]);
  assert.equal(token.blocked, true);
  // A missing claude is its own item with its fix, no Add Claude link; the token item keeps it.
  const executable = readyCheckItems(
    input({
      workspace: workspace("claude", {
        harnesses: [harness("codex"), harness("claude")],
      }),
      readiness: readiness({
        "claude-executable": "fail",
        "claude-token": "not-configured",
      }),
    }),
  );
  assert.deepEqual(executable.items, [
    { text: "claude-executable reason", fix: "claude-executable fix" },
    {
      text: "claude-token reason",
      fix: "claude-token fix",
      link: { label: "Add Claude", href: "/app/settings/runtime" },
    },
  ]);
  // A Codex lead ignores it.
  assert.deepEqual(
    readyCheckItems(
      input({ readiness: readiness({ "claude-executable": "fail" }) }),
    ).items,
    [],
  );
});

test("the ready check names a runtime that cannot run the lead's work in fixed words", () => {
  const plain =
    /recorded|receipt|observation|admission|reconcile|submission|revision|\d|project\.|conflict|invalid|Mira/i;
  const cases = [
    [
      input({ workspace: workspace("claude") }),
      "Claude runtime isn't enabled for this service.",
    ],
    [
      input({
        workspace: workspace("codex", {
          runtime: { state: "unavailable", since: 1 },
        }),
      }),
      "Codex runtime unavailable — turn it off and on in Settings → Runtime, or restart the service",
    ],
    [
      input({
        workspace: workspace("claude", {
          harnesses: [harness("codex"), harness("claude", "unavailable")],
        }),
      }),
      "Claude runtime unavailable — turn it off and on in Settings → Runtime, or restart the service",
    ],
    [
      input({ readiness: { state: "unavailable" } }),
      "Readiness couldn't be checked.",
    ],
  ] as const;
  for (const [given, text] of cases) {
    const result = readyCheckItems(given);
    assert.deepEqual(
      result.items.map((i) => i.text),
      [text],
    );
    assert.equal(result.blocked, true);
    assert.doesNotMatch(text, plain);
  }
});

test("the ready check links a disabled runtime to Settings > Runtime and says it once when none is enabled", () => {
  const link = { label: "Runtime settings", href: "/app/settings/runtime" };
  assert.deepEqual(
    readyCheckItems(input({ workspace: workspace("claude") })).items,
    [{ text: "Claude runtime isn't enabled for this service.", link }],
  );
  // Nothing enabled: the readiness check speaks once, not once more for the lead's runtime.
  assert.deepEqual(
    readyCheckItems(
      input({
        workspace: workspace("claude"),
        readiness: readiness({ "runtime-enabled": "fail" }),
      }),
    ).items,
    [
      {
        text: "runtime-enabled reason",
        fix: "runtime-enabled fix",
        link,
      },
    ],
  );
});

test("the ready check fails closed while loading and never blocks on capacity", () => {
  const loading = readyCheckItems(input({ readiness: { state: "loading" } }));
  assert.deepEqual(loading, {
    items: [],
    checking: true,
    blocked: true,
    capacityFull: false,
  });
  assert.equal(readyCheckItems(input({ workspace: null })).checking, true);
  for (const capacity of [
    { ...free, projectUsage: 2 },
    { ...free, globalUsage: 4 },
  ]) {
    const full = readyCheckItems(input({ capacity }));
    assert.equal(full.capacityFull, true);
    assert.equal(full.blocked, false);
  }
  assert.equal(readyCheckItems(input({ capacity: null })).capacityFull, false);
});

test("the ready check judges the lead's own model and effort against the supported settings", () => {
  const supported = { models: [{ model: "sonnet", efforts: ["high"] }] };
  const claude = (runtime: { model: string | null; effort: string | null }) => {
    const base = workspace("claude");
    return input({
      workspace: {
        ...base,
        profiles: base.profiles.map((p) => ({
          ...p,
          runtime: {
            harness: "claude" as const,
            model: runtime.model,
            reasoningEffort: runtime.effort,
          },
        })),
        harnesses: [
          harness("codex"),
          { ...harness("claude"), settings: supported },
        ],
      },
    });
  };
  const edit = {
    text: "Claude runtime doesn't accept the lead profile's model or reasoning effort.",
    link: { label: "Edit profile", href: `/app/profiles/${leadId}/settings` },
  };
  // A model the runtime lacks, and an effort its model lacks: the lead cannot run.
  for (const rejected of [
    { model: "gone", effort: null },
    { model: "sonnet", effort: "low" },
    // The default model is missing from these settings too.
    { model: null, effort: null },
  ]) {
    const result = readyCheckItems(claude(rejected));
    assert.deepEqual(result.items, [edit], JSON.stringify(rejected));
    assert.equal(result.blocked, true);
  }
  assert.deepEqual(
    readyCheckItems(claude({ model: "sonnet", effort: "high" })).items,
    [],
  );
  // The settings are unknown before the first Claude turn: nothing can be judged, and
  // blocking would stop the first task that reads them.
  const unknown = claude({ model: "gone", effort: null });
  const harnesses = [harness("codex"), harness("claude")];
  assert.deepEqual(
    readyCheckItems({
      ...unknown,
      workspace: unknown.workspace && { ...unknown.workspace, harnesses },
    }).items,
    [],
  );
  // A runtime that is not running is named by its own item, not by this one.
  const down = readyCheckItems({
    ...unknown,
    workspace: unknown.workspace && {
      ...unknown.workspace,
      harnesses: [
        harness("codex"),
        { ...harness("claude", "unavailable"), settings: supported },
      ],
    },
  });
  assert.deepEqual(
    down.items.map((i) => i.text),
    [
      "Claude runtime unavailable — turn it off and on in Settings → Runtime, or restart the service",
    ],
  );
});

test("setup sends the source credential only for a signed-in login and at least one repository", () => {
  const rows = [
    {
      ...typeRepository(emptyRow("typed"), "acme/atlas"),
      ref: "main",
      path: "~/src/atlas",
    },
  ];
  const login = { state: "signed-in" as const, login: "octo" };
  const signedIn = buildProjectCreate(values, rows, "", login).command;
  assert.equal(
    (signedIn as { sourceCredentialRef?: string }).sourceCredentialRef,
    "gh:github.com",
  );
  assert.equal(operatorCommandSchema.safeParse(signedIn).success, true);
  // A repository-free project has no source to use the login, so none is recorded.
  const free = buildProjectCreate(values, [emptyRow("discovered")], "", login);
  assert.equal("sourceCredentialRef" in free.command, false);
  assert.equal(operatorCommandSchema.safeParse(free.command).success, true);
  for (const gh of [
    undefined,
    null,
    { state: "not-signed-in" as const },
    { state: "unreadable" as const },
    { state: "not-installed" as const },
  ]) {
    assert.equal(
      "sourceCredentialRef" in buildProjectCreate(values, rows, "", gh).command,
      false,
    );
    assert.match(
      setupSourceCredentialCopy(gh),
      gh === undefined
        ? /^GitHub source credential: checking…$/
        : /^GitHub source credential: none\./,
    );
  }
  assert.match(
    setupSourceCredentialCopy({ state: "signed-in", login: "octo" }),
    /^GitHub source credential: GitHub CLI · @octo\./,
  );
  assert.match(setupSourceCredentialCopy(null), /could not be checked/);
  assert.match(
    setupSourceCredentialCopy({ state: "not-signed-in" }),
    /No usable GitHub CLI login was detected/,
  );
});

test("the ready check states the recorded source credential with a settings link when it cannot sync", () => {
  const id = "p1";
  const link = {
    label: "GitHub source settings",
    href: "/app/projects/p1/settings?tab=github",
  };
  const credential = (
    over: Partial<{
      configured: boolean;
      source: "env" | "gh" | null;
      usable: boolean;
      reason: "gh-not-signed-in" | null;
    }> = {},
  ) => ({
    configured: true,
    source: "gh" as const,
    usable: true,
    reason: null,
    gh: { state: "signed-in" as const, login: "octo" },
    ...over,
  });
  assert.deepEqual(
    sourceCredentialLine(id, {
      credentialConfigured: true,
      credential: credential(),
    }),
    { text: "GitHub source credential: GitHub CLI · @octo" },
  );
  assert.deepEqual(
    sourceCredentialLine(id, {
      credentialConfigured: false,
      credential: credential({
        configured: false,
        source: null,
        usable: false,
      }),
    }),
    {
      text: "GitHub source credential: not set. The source won't sync until one is set.",
      link,
    },
  );
  assert.deepEqual(
    sourceCredentialLine(id, {
      credentialConfigured: true,
      credential: credential({ usable: false, reason: "gh-not-signed-in" }),
    }),
    {
      text: `GitHub source credential: GitHub CLI. ${sourceCredentialExplanation("gh-not-signed-in")}`,
      link,
    },
  );
  assert.deepEqual(sourceCredentialLine(id, undefined), {
    text: "GitHub source credential: checking…",
  });
  for (const unavailable of [null, { credentialConfigured: true }])
    assert.deepEqual(sourceCredentialLine(id, unavailable), {
      text: "GitHub source credential: status unavailable.",
    });
});
