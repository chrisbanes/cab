import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiscoveryStatus, Workspace } from "../src/operator/contracts.js";
import {
  type ChecklistRow,
  checklistRows,
  homeRows,
} from "../web/src/getting-started-model.js";
import type { ReadinessRead } from "../web/src/setup-model.js";

const projectId = "00000000-0000-4000-8000-000000000001",
  profileId = "00000000-0000-4000-8000-000000000002";
type Check = "codex-executable" | "codex-login" | "claude-token";
const readiness = (
  status: Partial<Record<Check, "pass" | "fail" | "not-configured">> = {},
): ReadinessRead => ({
  state: "ready",
  checks: (["codex-executable", "codex-login", "claude-token"] as const).map(
    (id) => {
      const s =
        status[id] ?? (id === "claude-token" ? "not-configured" : "pass");
      return {
        id,
        label: id,
        status: s,
        reason: s === "pass" ? null : `${id} reason`,
        fix: s === "pass" ? null : `${id} fix`,
      };
    },
  ),
});
const workspace = (
  o: {
    profile?: boolean;
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
          leadProfileId: o.profile ? profileId : null,
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
          revoked: false,
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

test("a fresh installation has Runtime Done and Lead profile as the one primary Next", () => {
  const all = rows(workspace());
  assert.deepEqual(
    all.map((r) => r.id),
    ["runtime", "github", "lead", "project", "first-task", "claude"],
  );
  assert.deepEqual(states(all), {
    runtime: "done",
    github: "optional",
    lead: "next",
    project: "not-started",
    "first-task": "not-started",
    claude: "optional",
  });
  assert.deepEqual(
    all.filter((r) => r.primary).map((r) => r.id),
    ["lead"],
  );
  assert.deepEqual(byId(all).lead?.action, {
    kind: "link",
    label: "Create in project setup",
    href: "/app/settings/projects/new",
  });
});

test("Runtime is Next, Done, Needs attention after a later row is Done, or Checking", () => {
  assert.equal(
    byId(rows(workspace(), readiness({ "codex-login": "fail" }))).runtime
      ?.status,
    "next",
  );
  const regressed = byId(
    rows(workspace({ profile: true }), readiness({ "codex-login": "fail" })),
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

test("GitHub is optional, never primary, and offers the signed-in gh login", () => {
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
    kind: "gh-login",
    login: "fixture-user",
  });
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
    href: "/app/settings",
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
  assert.equal(all.lead?.status, "done");
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
  assert.equal(homeRows(healthy, false).length, 6);
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
    href: "/app/settings/runtime",
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
