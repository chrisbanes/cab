import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DiscoveryStatus,
  Workspace,
} from "../../src/operator/contracts.js";
import {
  type ChecklistRow,
  checklistRows,
  homeRows,
  REQUIRED_ROWS,
} from "../../web/src/getting-started-model.js";
import type { ReadinessRead } from "../../web/src/setup-model.js";

const projectId = "00000000-0000-4000-8000-000000000001",
  profileId = "00000000-0000-4000-8000-000000000002";
type Check =
  | "runtime-enabled"
  | "codex-executable"
  | "codex-login"
  | "claude-executable"
  | "claude-token";
const readiness = (
  status: Partial<Record<Check, "pass" | "fail" | "not-configured">> = {},
): ReadinessRead => ({
  state: "ready",
  checks: (
    [
      "runtime-enabled",
      "codex-executable",
      "codex-login",
      "claude-executable",
      "claude-token",
    ] as const
  ).map((id) => {
    const s = status[id] ?? (id === "claude-token" ? "not-configured" : "pass");
    return {
      id,
      label: id,
      status: s,
      reason: s === "pass" ? null : `${id} reason`,
      fix: s === "pass" ? null : `${id} fix`,
    };
  }),
});
const workspace = (
  o: {
    profile?: boolean;
    /** The project's lead; defaults to the profile when there is one. */
    lead?: boolean;
    revoked?: boolean;
    project?: "paused" | "enabled";
    turnStarted?: boolean;
  } = {},
): Workspace["data"] => ({
  projects: o.project
    ? [
        {
          id: projectId,
          name: "fixture-app",
          version: 2,
          paused: o.project === "paused",
          leadProfileId: (o.lead ?? o.profile) ? profileId : null,
        },
      ]
    : [],
  profiles: o.profile
    ? [
        {
          id: profileId,
          name: "Ada",
          summary: "",
          version: 1,
          revoked: o.revoked ?? false,
          runtime: { harness: "codex" },
        },
      ]
    : [],
  runtime: { state: "available" },
  harnesses: [],
  gettingStarted: { turnStarted: o.turnStarted ?? false, dismissed: false },
});
const discovery = (
  d: Partial<DiscoveryStatus["data"]> = {},
): DiscoveryStatus["data"] => ({
  configured: false,
  available: false,
  source: null,
  gh: { state: "not-signed-in" },
  sourceGh: { state: "not-signed-in" },
  ...d,
});
const rows = (
  w: Workspace["data"],
  r: ReadinessRead = readiness(),
  d: DiscoveryStatus["data"] | null = discovery(),
) => checklistRows({ workspace: w, readiness: r, discovery: d });
const byId = (all: ChecklistRow[]) =>
  Object.fromEntries(all.map((row) => [row.id, row]));
const states = (all: ChecklistRow[]) =>
  Object.fromEntries(all.map((row) => [row.id, row.status]));

test("a fresh installation counts three required rows and makes Project the one primary Next", () => {
  const all = rows(workspace());
  assert.deepEqual(
    all.map((r) => r.id),
    ["runtime", "github", "project", "first-task", "claude"],
  );
  assert.deepEqual(REQUIRED_ROWS, ["runtime", "project", "first-task"]);
  assert.deepEqual(states(all), {
    runtime: "done",
    github: "optional",
    project: "next",
    "first-task": "not-started",
    claude: "optional",
  });
  assert.deepEqual(
    all.filter((r) => r.primary).map((r) => r.id),
    ["project"],
  );
  const { project, "first-task": first } = byId(all);
  assert.equal(project?.detail, "No projects yet.");
  assert.deepEqual(project?.action, {
    kind: "link",
    label: "Create project",
    href: "/app/settings/projects/new",
  });
  assert.equal(first?.detail, "Needs a project first.");
  assert.deepEqual(first?.action, {
    kind: "unavailable",
    label: "Create task",
  });
});

test("Project is not Done with a lead profile but no project", () => {
  const project = byId(rows(workspace({ profile: true }))).project;
  assert.equal(project?.status, "next");
  assert.equal(project?.detail, "No projects yet. Lead profile Ada is ready.");
  assert.deepEqual(project?.action, {
    kind: "link",
    label: "Create project",
    href: "/app/settings/projects/new",
  });
});

test("Project is not Done when the enabled project has no lead", () => {
  const all = byId(
    rows(workspace({ profile: true, lead: false, project: "enabled" })),
  );
  assert.equal(all.project?.status, "next");
  assert.equal(all.project?.primary, true);
  assert.equal(
    all.project?.detail,
    "fixture-app has no lead profile. Tasks wait for a lead.",
  );
  assert.deepEqual(all.project?.action, {
    kind: "link",
    label: "Choose a lead",
    href: `/app/projects/${projectId}/settings`,
  });
  assert.deepEqual(all["first-task"]?.action, {
    kind: "link",
    label: "Create task",
    href: `/app/tasks/new?project=${projectId}`,
  });
});

test("Project is not Done when the lead profile is revoked", () => {
  const all = byId(
    rows(workspace({ profile: true, revoked: true, project: "enabled" })),
  );
  assert.equal(all.project?.status, "next");
  assert.match(all.project?.detail ?? "", /has no usable lead profile/);
  assert.deepEqual(all.project?.action, {
    kind: "link",
    label: "Choose a lead",
    href: `/app/projects/${projectId}/settings`,
  });
  assert.doesNotMatch(all.project?.detail ?? "", /Lead profile Ada/);
});

test("Project is Done with an enabled project and a usable lead", () => {
  const all = byId(rows(workspace({ profile: true, project: "enabled" })));
  assert.equal(all.project?.status, "done");
  assert.equal(all["first-task"]?.status, "next");
  assert.equal(all["first-task"]?.primary, true);
});

test("an incomplete Project needs attention once a turn has started", () => {
  const all = rows(
    workspace({
      profile: true,
      lead: false,
      project: "enabled",
      turnStarted: true,
    }),
  );
  assert.equal(byId(all).project?.status, "attention");
  assert.deepEqual(
    homeRows(all, true).map((r) => r.id),
    ["project"],
  );
});

test("Runtime is Next, Done, Needs attention after a later row is Done, or Checking", () => {
  assert.equal(
    byId(rows(workspace(), readiness({ "codex-login": "fail" }))).runtime
      ?.status,
    "next",
  );
  const regressed = byId(
    rows(
      workspace({ profile: true, project: "enabled" }),
      readiness({ "codex-login": "fail" }),
    ),
  );
  assert.equal(regressed.runtime?.status, "attention");
  assert.equal(regressed.runtime?.detail, "codex-login reason");
  assert.equal(regressed.runtime?.primary, true);
  assert.equal(
    byId(rows(workspace(), { state: "loading" })).runtime?.status,
    "checking",
  );
  assert.equal(
    byId(rows(workspace(), { state: "unavailable" })).runtime?.status,
    "unknown",
  );
});

test("Runtime passes on any enabled runtime and sends a missing one to Settings > Runtime", () => {
  // Claude-only: Codex is disabled (its checks are not configured), Claude passes.
  const claudeOnly = byId(
    rows(
      workspace(),
      readiness({
        "codex-executable": "not-configured",
        "codex-login": "not-configured",
        "claude-token": "pass",
      }),
    ),
  ).runtime;
  assert.equal(claudeOnly?.status, "done");
  // Codex failing while Claude passes still has a runtime that can run work.
  assert.equal(
    byId(
      rows(
        workspace(),
        readiness({ "codex-login": "fail", "claude-token": "pass" }),
      ),
    ).runtime?.status,
    "done",
  );
  // Nothing enabled: the runtime-enabled check fails and the row opens Runtime settings.
  const none = byId(
    rows(
      workspace(),
      readiness({
        "runtime-enabled": "fail",
        "codex-executable": "not-configured",
        "codex-login": "not-configured",
      }),
    ),
  ).runtime;
  assert.equal(none?.status, "next");
  assert.equal(none?.detail, "runtime-enabled reason");
  assert.deepEqual(none?.action, {
    kind: "link",
    label: "Open runtime settings",
    href: "/app/settings/runtime",
  });
  // An enabled runtime that fails (and no other) keeps the readiness link.
  assert.deepEqual(
    byId(
      rows(
        workspace(),
        readiness({
          "codex-login": "fail",
          "claude-executable": "not-configured",
        }),
      ),
    ).runtime?.action,
    {
      kind: "link",
      label: "Open readiness check",
      href: "/app/settings#readiness",
    },
  );
});

test("GitHub never offers a one-click login", () => {
  const signedIn = byId(
    rows(
      workspace(),
      readiness(),
      discovery({ gh: { state: "signed-in", login: "fixture-user" } }),
    ),
  ).github;
  assert.equal(signedIn?.status, "optional");
  assert.equal(signedIn?.primary, false);
  assert.deepEqual(signedIn?.action, {
    kind: "link",
    label: "Set discovery credential",
    href: "/app/settings#github-discovery",
  });
  assert.match(signedIn?.detail ?? "", /@fixture-user/);
  assert.match(signedIn?.detail ?? "", /Project setup/);
  assert.match(signedIn?.detail ?? "", /Optional for repository-free projects/);
  const done = byId(
    rows(
      workspace(),
      readiness(),
      discovery({ configured: true, available: true, source: "gh" }),
    ),
  ).github;
  assert.equal(done?.status, "done");
  assert.deepEqual(done?.action, {
    kind: "link",
    label: "Discovery settings",
    href: "/app/settings#github-discovery",
  });
  // Configured but unreadable stays optional and points at the credential setting.
  assert.equal(
    byId(rows(workspace(), readiness(), discovery({ configured: true }))).github
      ?.action.kind,
    "link",
  );
});

test("a paused project is not Done: its action is Resume (143b)", () => {
  const all = byId(rows(workspace({ profile: true, project: "paused" })));
  assert.equal(all.project?.status, "next");
  assert.equal(all.project?.primary, true);
  assert.deepEqual(all.project?.action, { kind: "resume", projectId });
  assert.equal(
    all["first-task"]?.action.kind === "link" && all["first-task"].action.href,
    `/app/tasks/new?project=${projectId}`,
  );
  const enabled = byId(rows(workspace({ profile: true, project: "enabled" })));
  assert.equal(enabled.project?.status, "done");
  assert.equal(enabled["first-task"]?.status, "next");
  assert.equal(enabled["first-task"]?.primary, true);
});

test("First task is Done once a turn has started, and earlier gaps then need attention", () => {
  const started = rows(
    workspace({ profile: true, project: "paused", turnStarted: true }),
  );
  assert.equal(byId(started)["first-task"]?.status, "done");
  assert.equal(byId(started).project?.status, "attention");
  assert.deepEqual(
    homeRows(started, true).map((r) => r.id),
    ["project"],
  );
  const healthy = rows(
    workspace({ profile: true, project: "enabled", turnStarted: true }),
  );
  assert.deepEqual(homeRows(healthy, true), []);
  assert.equal(homeRows(healthy, false).length, 5);
});

test("a claude that is not runnable needs attention even when the token is readable", () => {
  const claude = (executable: "pass" | "fail" | "not-configured") =>
    byId(
      rows(
        workspace(),
        readiness({ "claude-executable": executable, "claude-token": "pass" }),
      ),
    ).claude;
  const failing = claude("fail");
  assert.equal(failing?.status, "attention");
  assert.equal(failing?.detail, "claude-executable reason");
  assert.deepEqual(failing?.action, {
    kind: "link",
    label: "Open readiness check",
    href: "/app/settings#readiness-claude-executable",
  });
  assert.equal(failing?.primary, false);
  // Claude unused: no token and no claude is still optional; both passing is done.
  assert.equal(
    byId(
      rows(workspace(), readiness({ "claude-executable": "not-configured" })),
    ).claude?.status,
    "optional",
  );
  assert.equal(claude("pass")?.status, "done");
  assert.deepEqual(
    homeRows(
      rows(
        workspace({ profile: true, project: "enabled", turnStarted: true }),
        readiness({ "claude-executable": "fail" }),
      ),
      true,
    ).map((r) => r.id),
    ["claude"],
  );
});

test("Claude is Optional, Done, or Needs attention with Add Claude", () => {
  const claude = (status: "pass" | "fail" | "not-configured") =>
    byId(rows(workspace(), readiness({ "claude-token": status }))).claude;
  assert.equal(claude("not-configured")?.status, "optional");
  assert.equal(claude("pass")?.status, "done");
  const failing = claude("fail");
  assert.equal(failing?.status, "attention");
  assert.equal(failing?.primary, false);
  assert.deepEqual(failing?.action, {
    kind: "link",
    label: "Add Claude",
    href: "/app/settings/runtime#add-claude",
  });
  // A removed token returns to Home after the first turn.
  assert.deepEqual(
    homeRows(
      rows(
        workspace({ profile: true, project: "enabled", turnStarted: true }),
        readiness({ "claude-token": "fail" }),
      ),
      true,
    ).map((r) => r.id),
    ["claude"],
  );
});

test("no two checklist rows open the same screen", () => {
  const links = (all: ChecklistRow[]) =>
    all.flatMap((r) => (r.action.kind === "link" ? [r.action.href] : []));
  const inputs: [string, ChecklistRow[]][] = [
    ["a fresh install", rows(workspace())],
    [
      "runtime-enabled failing with Claude not configured",
      rows(
        workspace(),
        readiness({
          "runtime-enabled": "fail",
          "codex-executable": "not-configured",
          "codex-login": "not-configured",
        }),
      ),
    ],
    [
      "Codex login failing with Claude unrunnable",
      rows(
        workspace(),
        readiness({ "codex-login": "fail", "claude-executable": "fail" }),
      ),
    ],
    [
      "everything done",
      rows(
        workspace({ profile: true, project: "enabled", turnStarted: true }),
        readiness({ "claude-token": "pass" }),
        discovery({ configured: true, available: true, source: "gh" }),
      ),
    ],
  ];
  for (const [name, all] of inputs) {
    const hrefs = links(all);
    assert.ok(hrefs.length >= 3, name);
    assert.equal(new Set(hrefs).size, hrefs.length, `${name}: ${hrefs}`);
    assert.equal(
      hrefs.includes("/app/settings"),
      false,
      `${name}: bare Settings`,
    );
  }
});
