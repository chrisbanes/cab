import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  insertExternalItem,
  insertSourceMembership,
} from "../fixtures/source-rows.js";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  createOperatorFixture,
  seedOperatorDelivery,
} from "../fixtures/operator-web.js";
import { actionKinds } from "../../src/core/delivery.js";
import { runtimeOperatorRoutes } from "../../src/standalone/operator-runtime.js";
test("retained rendered form actions, fields and mounted route controls match documented owners", async (t) => {
  let providerCalls = 0;
  const unexpectedProviderCall = async () => {
    providerCalls++;
    throw Error("Unexpected fixture provider call");
  };
  const unexpectedProvider = () => ({
    inspectAction: unexpectedProviderCall,
    preflight: unexpectedProviderCall,
    performAction: unexpectedProviderCall,
    inspectPr: unexpectedProviderCall,
    inspectPublishedIssue: unexpectedProviderCall,
    inspectClosedIssue: unexpectedProviderCall,
  });
  const f = await createOperatorFixture(null, undefined, {
    providerFactories: { github: unexpectedProvider },
    issueTrackerFactories: { github: unexpectedProvider },
  });
  t.after(() => f.close());
  const d = f.service.domain();
  const projectId = randomUUID(),
    profileId = randomUUID(),
    taskId = randomUUID(),
    blockerId = randomUUID(),
    assignmentId = randomUUID();
  const command = (body: Record<string, unknown>) =>
    d.execute({ actor: "operator", key: randomUUID(), ...body } as never);
  command({
    type: "profile.create",
    profileId,
    name: "Lead",
    instructions: "Private",
    capabilities: "coordinate",
  });
  command({
    type: "project.create",
    projectId,
    name: "Project",
    leadProfileId: profileId,
  });
  for (const [id, title] of [
    [taskId, "Task"],
    [blockerId, "Blocker"],
  ])
    command({
      type: "task.create",
      projectId,
      taskId: id,
      title,
      outcome: "Finish",
      ready: false,
    });
  command({
    type: "assignment.create",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "Work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  command({
    type: "dependency.add",
    projectId,
    taskId,
    blockerTaskId: blockerId,
    expectedVersion: 1,
  });
  command({
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    instructions: "Changed instructions",
  });
  command({
    type: "github.configure",
    projectId,
    expectedVersion: 1,
    credentialRef: null,
    selections: [
      {
        id: "repo",
        kind: "repository",
        repositoryId: "R1",
        owner: "owner",
        name: "repo",
      },
    ],
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", operator: "has", name: "ready" }],
    },
  });
  const importedId = randomUUID();
  command({
    type: "task.create",
    projectId,
    taskId: importedId,
    title: "Imported",
    outcome: "Provider outcome",
    ready: false,
  });
  d.markImportedTask(importedId, "I1", "R1");
  const otherProject = randomUUID();
  command({
    type: "project.create",
    projectId: otherProject,
    name: "Other",
    leadProfileId: null,
  });
  f.seedPersistedState((db) => {
    insertExternalItem(db, {
      externalId: "I1",
      taskId: importedId,
      containerId: "R1",
      containerName: "owner/repo",
      number: 1,
      observedTitle: "Imported",
      observedBody: "Body",
      observedState: "open",
      labels: "[]",
    });
    insertSourceMembership(db, {
      projectId,
      selectionId: "repo",
      externalId: "I1",
    });
    insertSourceMembership(db, {
      projectId: otherProject,
      selectionId: "repo",
      externalId: "I1",
    });
    db.prepare(
      "INSERT INTO source_holds VALUES ('github','github.com','I1',1,'source hold',1)",
    ).run();
  });
  command({
    type: "delivery.configure",
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: actionKinds.map((action) => ({
      action,
      repositoryId: "R1",
      mode: "approval",
      ...(action === "project.field"
        ? { projectNodeId: "P1", fieldNodeId: "F1", optionNodeIds: ["O1"] }
        : action === "project.item.add"
          ? { projectNodeId: "P1" }
          : {}),
    })),
    requiredChecks: [{ name: "check", appId: 42 }],
  });
  const deliveryCaller = seedOperatorDelivery(f, {
    projectId,
    taskId,
    assignmentId,
  });
  const web = await f.startWeb();
  let response = await fetch(`${web.origin}/api/operator/session`);
  let cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const session = (await response.json()) as { csrfToken: string };
  response = await fetch(`${web.origin}/api/operator/login`, {
    method: "POST",
    headers: {
      cookie,
      origin: web.origin,
      "x-csrf-token": session.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ password: web.password }),
  });
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const routes = runtimeOperatorRoutes(f.service);
  const inventory = await readFile(
    new URL("../../../docs/design/ui02-foundation.md", import.meta.url),
    "utf8",
  );
  const dispositions = await readFile(
    new URL("../../../docs/design/ui06-configuration.md", import.meta.url),
    "utf8",
  );
  const dispositionRows = dispositions
    .split("\n")
    .filter((line) => line.startsWith("| "))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  let individual = 0;
  const resolve = (path: string) =>
    path.replace(
      ":id",
      path.includes("profiles") || path.startsWith("/profile/")
        ? profileId
        : path.includes("assignments") || path.includes("assignment/")
          ? assignmentId
          : path.includes("tasks") || path.includes("task/")
            ? taskId
            : projectId,
    );
  const reached = new Set<string>();
  for (const line of inventory.split("\n")) {
    if (!line.startsWith("| ")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (
      cells.length !== 5 ||
      cells[0] === "Existing destination" ||
      cells[0] === "---"
    )
      continue;
    for (const control of (cells[2] ?? "").split(";")) {
      const row = dispositionRows.find(
        (r) => r[0] === cells[1] && r[1] === control.trim(),
      );
      assert.ok(
        row,
        `${cells[1]} ${control.trim()} has an individual disposition`,
      );
      assert.ok((row[4]?.length ?? 0) > 30, "concrete scope disposition");
      const destination = resolve(row[3] ?? "");
      if (!reached.has(destination)) {
        const response = await fetch(`${web.origin}${destination}`, {
          headers: { cookie },
        });
        assert.equal(response.status, 200, destination);
        reached.add(destination);
      }
      individual++;
    }
  }
  console.log(
    `UI06 inventory: ${individual} individual controls; ${reached.size} concrete reachable destinations`,
  );
  for (const route of routes)
    assert.ok(
      inventory.includes(
        route.path.replace(":taskId", ":id").replace(":assignmentId", ":id"),
      ) || inventory.includes(route.path),
      `${route.method} ${route.path} has retained owner`,
    );
  const paths = [
    "/",
    `/app/tasks/${taskId}`,
    `/profile/${profileId}`,
    "/runtime",
  ];
  const actions = new Set<string>(),
    commands = new Set<string>(),
    fields = new Set<string>(),
    options = new Set<string>(),
    destinations = new Set<string>();
  let forms = 0;
  for (const path of paths) {
    const r = await fetch(`${web.origin}${path}`, { headers: { cookie } });
    assert.equal(r.status, 200, path);
    const html = await r.text();
    for (const match of html.matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>/g)) {
      forms++;
      actions.add(match[1] ?? "");
    }
    for (const match of html.matchAll(/data-command="([^"]+)"/g))
      commands.add(match[1] ?? "");
    for (const match of html.matchAll(
      /<(?:input|textarea|select)\b[^>]*name="([^"]+)"/g,
    ))
      fields.add(match[1] ?? "");
    for (const match of html.matchAll(/<option\b[^>]*value="([^"]+)"/g))
      options.add(match[1] ?? "");
    for (const match of html.matchAll(/href="([^"]+)"/g))
      destinations.add(match[1] ?? "");
  }
  for (const c of ["project.create", "profile.create", "profile.configure"]) {
    assert.ok(commands.has(c), `${c} remains rendered`);
    assert.ok(inventory.includes(c), `${c} retains documented owner`);
  }
  // The task page and its two forms are removed; the task workspace sends these as JSON.
  for (const removed of ["source.review", "task.configure"]) {
    assert.ok(!commands.has(removed), `${removed} form is not rendered`);
    assert.ok(inventory.includes(removed), `${removed} keeps its owner`);
  }
  for (const path of actions)
    assert.ok(
      path === "/command" || inventory.includes(path),
      `${path} retains owner`,
    );
  for (const name of [
    "name",
    "leadProfileId",
    "instructions",
    "revoked",
    "capabilities",
    "globalLimit",
    "projectLimit",
  ])
    assert.ok(fields.has(name), `${name} remains rendered`);
  for (const removed of [
    "observedDigest",
    "decision",
    "title",
    "outcome",
    "ready",
  ])
    assert.ok(!fields.has(removed), `${removed} field is not rendered`);
  for (const removed of [
    "resume-source-hold",
    "clarification",
    "accept-revised-scope",
  ])
    assert.ok(!options.has(removed), `${removed} is not offered`);
  for (const path of [
    "/",
    `/app/projects/${projectId}/settings`,
    `/profile/${profileId}`,
    "/runtime",
    "/app",
  ])
    assert.ok(destinations.has(path), `${path} cross-navigation retained`);
  assert.ok(forms > 0);
  for (const removed of [
    "/runtime/control/dependency/add",
    "/runtime/control/dependency/remove",
    "/runtime/control/stop",
    "/runtime/control/resume",
  ])
    assert.equal(actions.has(removed), false, `${removed} is not rendered`);
  assert.equal(
    f.service.delivery().delivery(taskId)?.registeredWorkId,
    deliveryCaller.workId,
  );
  assert.equal(
    f.service.domain().task(taskId).version,
    deliveryCaller.taskVersion,
  );
  assert.equal(f.runtime.turns, 0);
  assert.equal(providerCalls, 0);
  console.log(
    `UI02 retained inventory: ${forms} rendered forms; ${commands.size} command discriminants; ${actions.size} form actions; ${routes.length} extension routes`,
  );
});
