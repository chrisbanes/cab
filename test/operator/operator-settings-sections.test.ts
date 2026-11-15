import assert from "node:assert/strict";
import { test } from "node:test";
import { readinessCheckIds } from "../../src/operator/readiness.js";
import { waitFixHref } from "../../web/src/wait-fix-href.js";
import {
  addClaudeHref,
  isSettingsRoute,
  landingTargetId,
  legacySettingsUrl,
  readinessCheckHref,
  SETTINGS_SECTIONS,
  sectionForPath,
  settingsLanding,
  settingsSectionHref,
} from "../../web/src/settings-sections.js";

const routes = {
  projects: "/settings/projects",
  runtime: "/settings/runtime",
  profiles: "/settings/agents",
  routing: "/settings/routing",
  "github-discovery": "/settings/github-discovery",
  "gitlab-credentials": "/settings/gitlab-credentials",
  "cli-credentials": "/settings/cli-credentials",
  notifications: "/settings/notifications",
  readiness: "/settings/readiness",
} as const;

test("each section has one route, in the designed order, and the route names it back", () => {
  assert.deepEqual(
    SETTINGS_SECTIONS.map((s) => s.id),
    Object.keys(routes),
  );
  for (const [id, path] of Object.entries(routes)) {
    const section = id as keyof typeof routes;
    assert.equal(settingsSectionHref(section), path);
    assert.equal(sectionForPath(path), section);
  }
  // Agents keeps its internal id; its old id is not a route.
  assert.equal(sectionForPath("/settings/profiles"), null);
  for (const path of [
    "/settings",
    "/settings/",
    "/settings/nope",
    "/settings/projects/new",
    "/settings/runtime/x",
  ])
    assert.equal(sectionForPath(path), null, path);
  assert.equal(
    readinessCheckHref("claude-executable"),
    "/settings/readiness#readiness-claude-executable",
  );
});

test("a legacy Settings fragment opens its section page, keeping the query", () => {
  for (const [id, path] of Object.entries(routes)) {
    assert.equal(legacySettingsUrl("/settings", "", `#${id}`), path);
    assert.equal(
      legacySettingsUrl("/settings", "?from=mail", `#${id}`),
      `${path}?from=mail`,
    );
  }
  for (const check of readinessCheckIds)
    assert.equal(
      legacySettingsUrl("/settings", "", `#readiness-${check}`),
      `/settings/readiness#readiness-${check}`,
    );
  assert.equal(
    legacySettingsUrl("/settings", "?a=1", "#readiness-git"),
    "/settings/readiness?a=1#readiness-git",
  );
  // Unknown and undecodable fragments are dropped, so the landing applies.
  for (const hash of [
    "#nope",
    "#readiness-nope",
    "#%E0%A4%A",
    "#agents",
    "#add-claude",
  ])
    assert.equal(legacySettingsUrl("/settings", "?q=1", hash), "/settings?q=1");
  // Nothing to rewrite without a fragment, or off the Settings root.
  assert.equal(legacySettingsUrl("/settings", "", ""), null);
  assert.equal(legacySettingsUrl("/settings", "", "#"), null);
  assert.equal(legacySettingsUrl("/settings/runtime", "", "#add-claude"), null);
  assert.equal(
    legacySettingsUrl("/projects/x/settings", "", "#notifications"),
    null,
  );
});

test("Settings lands on Readiness only before the first turn", () => {
  assert.equal(settingsLanding(false), "readiness");
  assert.equal(settingsLanding(true), "projects");
  assert.equal(settingsLanding(undefined), "projects");
});

test("only a known check on Readiness and Add Claude on Runtime are landing targets", () => {
  assert.equal(
    landingTargetId("/settings/readiness", "#readiness-claude-executable"),
    "readiness-claude-executable",
  );
  assert.equal(landingTargetId("/settings/readiness", "#readiness-nope"), null);
  assert.equal(landingTargetId("/settings/readiness", "#%E0%A4%A"), null);
  assert.equal(
    landingTargetId("/settings/runtime", "#add-claude"),
    "add-claude",
  );
  assert.equal(landingTargetId("/settings/projects", "#add-claude"), null);
  assert.equal(landingTargetId("/settings", "#readiness-git"), null);
});

test("Settings ancestry covers its sections and detail pages, nothing else", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  for (const path of [
    "/settings",
    "/settings/notifications",
    "/settings/projects/new",
    "/settings/profiles/new",
    `/projects/${id}/settings`,
    `/profiles/${id}/settings`,
    `/assignments/${id}/recovery`,
  ])
    assert.ok(isSettingsRoute(path), path);
  for (const path of ["/", `/projects/${id}`, "/tasks", "/getting-started"])
    assert.ok(!isSettingsRoute(path), path);
});

test("a wait's Fix opens the section page that holds it, never bare Settings", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  assert.equal(waitFixHref({ kind: "readiness" }), "/settings/readiness");
  assert.equal(waitFixHref({ kind: "add-claude" }), addClaudeHref);
  assert.equal(addClaudeHref, "/settings/runtime#add-claude");
  for (const fix of [
    { kind: "choose-lead", projectId: id },
    { kind: "readiness" },
    { kind: "add-claude" },
    { kind: "open-profile", profileId: id },
    { kind: "open-repositories", projectId: id },
  ] as const)
    assert.notEqual(waitFixHref(fix), "/settings", fix.kind);
});
