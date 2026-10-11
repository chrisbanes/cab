import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { cliCapabilities } from "../src/operator/contracts.js";
import { operatorRouteAuthority } from "../src/standalone/operator-credentials.js";
import { OperatorWebBoundary } from "../src/standalone/operator-web.js";
import { databaseDigest } from "./fixtures/database-digest.js";
import { startCliService } from "./fixtures/operator-cli.js";

const DAY = 24 * 60 * 60 * 1000;

test("bearer credentials read through the service under server-side route authority", async (t) => {
  const s = await startCliService(t);
  const read = await s.issue("read", "laptop-ro");
  const write = await s.issue("read-write", "agent-rw");
  const taskPath = `/api/operator/tasks/${s.taskId}`;

  // 1. identity and task read equal the session read.
  let r = await s.bearer(read.token, "/api/operator/cli");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("set-cookie"), null);
  const identity = (await r.json()) as Record<string, unknown>;
  assert.equal(identity.apiVersion, 1);
  assert.deepEqual(identity.capabilities, [...cliCapabilities]);
  assert.deepEqual(identity.service, {
    installationId: s.f.service.operatorCredentials().installationId(),
    origin: s.authOrigin,
  });
  assert.equal((identity.credential as { scope: string }).scope, "read");
  assert.ok(!JSON.stringify(identity).includes(read.token));
  r = await s.bearer(read.token, taskPath);
  assert.equal(r.status, 200);
  const bearerTask = (await r.json()) as {
    data: { task: { version: number } };
  };
  const sessionTask = (await (await s.sessionGet(taskPath)).json()) as {
    data: unknown;
  };
  assert.deepEqual(bearerTask.data, sessionTask.data);
  const version = bearerTask.data.task.version;
  const configure = (expectedVersion: number, key = randomUUID()) => ({
    type: "task.configure",
    key,
    projectId: s.projectId,
    taskId: s.taskId,
    expectedVersion,
    title: "Renamed by CLI",
  });

  // 2. read scope cannot reach write routes.
  for (const [method, path, body] of [
    ["POST", "/api/operator/commands", configure(version)],
    ["POST", "/api/operator/source-refresh", {}],
    ["GET", `/api/operator/tasks/${s.taskId}/comparisons`, undefined],
  ] as const) {
    r = await s.bearer(read.token, path, { method, body });
    assert.equal(r.status, 403, path);
    assert.equal(
      ((await r.json()) as { error: { code: string } }).error.code,
      "insufficient-scope",
    );
  }

  // 3. session-only and legacy routes are denied for both scopes.
  const denied: [string, string, unknown?][] = [
    ["GET", "/api/operator/session"],
    ["POST", "/api/operator/login", { password: "fixture-password" }],
    ["POST", "/api/operator/logout", {}],
    ["POST", "/api/operator/setup/folders", { path: "" }],
    ["POST", "/api/operator/setup/verify-checkout", {}],
    ["GET", `/api/operator/tasks/${s.taskId}/review-draft`],
    ["GET", `/api/operator/tasks/${s.taskId}/local-reviews`],
    ["GET", `/api/operator/tasks/${s.taskId}/local-reviews/${randomUUID()}`],
    ["GET", "/api/operator/credentials"],
    ["POST", "/api/operator/credentials", { name: "x", scope: "read-write" }],
    ["POST", `/api/operator/credentials/${read.credential.id}/rotate`, {}],
    ["POST", `/api/operator/credentials/${read.credential.id}/revoke`, {}],
    ["GET", "/"],
    ["GET", `/task/${s.taskId}`],
    ["GET", "/app"],
    ["GET", "/assets/main.js"],
    ["POST", "/command", {}],
    ["POST", `/coordination/task/${s.taskId}`, {}],
  ];
  for (const token of [read.token, write.token])
    for (const [method, path, body] of denied) {
      r = await s.bearer(token, path, { method, body });
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(r.headers.get("set-cookie"), null);
    }
  assert.equal(
    s.f.service.operatorCredentials().list().length,
    2,
    "no credential created",
  );
  const unchanged = (await (await s.sessionGet(taskPath)).json()) as {
    data: { task: { version: number; title: string } };
  };
  assert.equal(unchanged.data.task.version, version);
  assert.equal(unchanged.data.task.title, "Inspect me");

  // 4. read-write writes use the same command path, conflicts and receipts.
  r = await s.bearer(write.token, "/api/operator/commands", {
    method: "POST",
    body: configure(version + 5),
  });
  assert.equal(r.status, 409);
  const sessionConflict = await s.sessionPost(
    "/api/operator/commands",
    configure(version + 5),
  );
  assert.equal(sessionConflict.status, 409);
  assert.deepEqual(await r.json(), await sessionConflict.json());
  const command = configure(version);
  r = await s.bearer(write.token, "/api/operator/commands", {
    method: "POST",
    body: command,
  });
  assert.equal(r.status, 200);
  const receipt = await r.json();
  r = await s.bearer(write.token, "/api/operator/commands", {
    method: "POST",
    body: command,
  });
  assert.deepEqual(await r.json(), receipt);
  const after = (await (await s.sessionGet(taskPath)).json()) as {
    data: { task: { version: number; title: string } };
  };
  assert.equal(after.data.task.version, version + 1);
  assert.equal(after.data.task.title, "Renamed by CLI");

  // 5. credential failures are uniform.
  const expired = s.f.service
    .operatorCredentials()
    .issue(
      { name: "old", scope: "read", expiresInDays: 1 },
      Date.now() - 2 * DAY,
    );
  const revoked = await s.issue("read", "revoked");
  assert.equal(
    (
      await s.sessionPost(
        `/api/operator/credentials/${revoked.credential.id}/revoke`,
        {},
      )
    ).status,
    200,
  );
  for (const authorization of [
    `Bearer ${expired.token}`,
    `Bearer ${revoked.token}`,
    `Bearer ${read.token.slice(0, -2)}xx`,
    "Bearer",
    "Bearer ",
    "Basic x",
    `Bearer ${read.token} ${write.token}`,
    read.token,
  ]) {
    r = await fetch(`${s.origin}/api/operator/cli`, {
      headers: { authorization },
    });
    assert.equal(r.status, 401, authorization.slice(0, 12));
    assert.deepEqual(await r.json(), {
      error: {
        code: "credential-invalid",
        message: "Operator credential is invalid.",
      },
    });
  }
  r = await s.bearer(read.token, "/api/operator/unknown");
  assert.equal(r.status, 404);
  r = await s.bearer(read.token, "/api/operator/workspace", { method: "PUT" });
  assert.equal(r.status, 405);

  // 6. a bearer request carrying a session cookie gets no cookie authority.
  r = await s.bearer(write.token, "/api/operator/credentials", {
    method: "POST",
    body: { name: "escalate", scope: "read-write" },
    headers: { cookie: s.cookie, origin: s.authOrigin },
  });
  assert.equal(r.status, 403);
  r = await fetch(`${s.origin}/api/operator/workspace`, {
    headers: { cookie: s.cookie, authorization: "Bearer nope" },
  });
  assert.equal(r.status, 401);

  // 7. browser protections still apply to session writes.
  assert.equal(
    (
      await s.sessionPost(
        "/api/operator/credentials",
        {
          name: "x",
          scope: "read",
        },
        { origin: "" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await s.sessionPost(
        "/api/operator/credentials",
        {
          name: "x",
          scope: "read",
        },
        { "x-csrf-token": "wrong" },
      )
    ).status,
    403,
  );
  assert.equal((await s.sessionGet("/api/operator/workspace")).status, 200);
  assert.equal(
    (await fetch(`${s.origin}/api/operator/credentials`)).status,
    401,
  );
});

test("session credential endpoints reveal a token only when issued", async (t) => {
  const s = await startCliService(t);
  let r = await s.sessionPost("/api/operator/credentials", {
    name: "agent",
    scope: "read-write",
    expiresInDays: 30,
  });
  assert.equal(r.status, 200);
  const issued = (await r.json()) as {
    token: string;
    credential: { id: string; expiresAt: number; createdAt: number };
  };
  assert.equal(
    issued.credential.expiresAt - issued.credential.createdAt,
    30 * DAY,
  );
  for (const body of [
    { name: "", scope: "read" },
    { name: "x".repeat(65), scope: "read" },
    { name: "x", scope: "admin" },
    { name: "x", scope: "read", expiresInDays: 91 },
    { name: "x", scope: "read", token: "chosen" },
  ])
    assert.equal(
      (await s.sessionPost("/api/operator/credentials", body)).status,
      400,
    );
  let listText = await (await s.sessionGet("/api/operator/credentials")).text();
  assert.ok(!listText.includes(issued.token));
  assert.ok(!listText.includes('"token"'));
  r = await s.sessionPost(
    `/api/operator/credentials/${issued.credential.id}/rotate`,
    {},
  );
  assert.equal(r.status, 200);
  const rotated = (await r.json()) as {
    token: string;
    credential: { id: string; replacesId: string };
  };
  assert.equal(rotated.credential.replacesId, issued.credential.id);
  assert.equal((await s.bearer(issued.token, "/api/operator/cli")).status, 200);
  assert.equal(
    (await s.bearer(rotated.token, "/api/operator/cli")).status,
    200,
  );
  r = await s.sessionPost(
    `/api/operator/credentials/${issued.credential.id}/revoke`,
    {},
  );
  assert.equal(r.status, 200);
  assert.equal(
    ((await r.json()) as { credential: { state: string } }).credential.state,
    "revoked",
  );
  assert.equal((await s.bearer(issued.token, "/api/operator/cli")).status, 401);
  assert.equal(
    (await s.bearer(rotated.token, "/api/operator/cli")).status,
    200,
  );
  assert.equal(
    (
      await s.sessionPost(
        `/api/operator/credentials/${issued.credential.id}/rotate`,
        {},
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await s.sessionPost(
        `/api/operator/credentials/${randomUUID()}/revoke`,
        {},
      )
    ).status,
    404,
  );
  listText = await (await s.sessionGet("/api/operator/credentials")).text();
  assert.ok(
    !listText.includes(issued.token) && !listText.includes(rotated.token),
  );
  const list = JSON.parse(listText) as {
    data: {
      credentials: { id: string; state: string; lastUsedAt: number | null }[];
    };
  };
  assert.deepEqual(
    list.data.credentials.map((c) => c.state),
    ["revoked", "active"],
  );
  assert.ok(list.data.credentials[1]?.lastUsedAt);
});

test("every known API route has an explicit authority", () => {
  const id = randomUUID();
  const representative = [
    "/api/operator/session",
    "/api/operator/runtime",
    "/api/operator/login",
    "/api/operator/logout",
    "/api/operator/workspace",
    "/api/operator/task-list",
    "/api/operator/inbox",
    "/api/operator/search",
    "/api/operator/commands",
    "/api/operator/source-refresh",
    "/api/operator/source-observations",
    "/api/operator/discovery",
    "/api/operator/claude-token",
    "/api/operator/discovery/repositories",
    "/api/operator/discovery/branches",
    "/api/operator/discovery/projects",
    "/api/operator/setup/folders",
    "/api/operator/setup/verify-checkout",
    "/api/operator/cli",
    "/api/operator/credentials",
    `/api/operator/credentials/${id}/rotate`,
    `/api/operator/credentials/${id}/revoke`,
    `/api/operator/projects/${id}/configuration`,
    `/api/operator/profiles/${id}/configuration`,
    `/api/operator/projects/${id}`,
    `/api/operator/tasks/${id}`,
    `/api/operator/tasks/${id}/review`,
    `/api/operator/tasks/${id}/artifacts/${id}`,
    `/api/operator/tasks/${id}/files`,
    `/api/operator/tasks/${id}/preview`,
    `/api/operator/tasks/${id}/results/${id}/evidence`,
    `/api/operator/tasks/${id}/results/${id}/evidence/${id}`,
    `/api/operator/tasks/${id}/review-anchors/${id}`,
    `/api/operator/tasks/${id}/review-draft`,
    `/api/operator/tasks/${id}/local-reviews`,
    `/api/operator/tasks/${id}/local-reviews/${id}`,
    `/api/operator/tasks/${id}/comparisons`,
    `/api/operator/tasks/${id}/questions/${id}`,
    `/api/operator/projects/${id}/composer-options`,
    `/api/operator/assignments/${id}/history`,
    `/api/operator/assignments/${id}/recovery`,
    `/api/operator/tasks/${id}/results`,
    `/api/operator/tasks/${id}/messages`,
    `/api/operator/assignments/${id}`,
    `/api/operator/assignments/${id}/instructions`,
    `/api/operator/projects/${id}/instructions`,
    `/api/operator/profiles/${id}/instructions`,
    "/api/operator/operations",
    `/api/operator/projects/${id}/impact`,
    `/api/operator/profiles/${id}/impact`,
    "/api/operator/executions",
    `/api/operator/executions/assignment:${id}:initial`,
    `/api/operator/executions/assignment:${id}:initial/inputs`,
    `/api/operator/executions/assignment:${id}:initial/events`,
  ];
  for (const path of [
    `/api/operator/tasks/${id}/results`,
    `/api/operator/tasks/${id}/messages`,
    `/api/operator/assignments/${id}`,
    `/api/operator/assignments/${id}/instructions`,
    `/api/operator/projects/${id}/instructions`,
    `/api/operator/profiles/${id}/instructions`,
    "/api/operator/operations",
    `/api/operator/projects/${id}/impact`,
    `/api/operator/profiles/${id}/impact`,
    "/api/operator/executions",
    `/api/operator/executions/assignment:${id}:initial`,
    `/api/operator/executions/assignment:${id}:initial/inputs`,
    `/api/operator/executions/assignment:${id}:initial/events`,
  ])
    assert.equal(operatorRouteAuthority("GET", path), "read", path);
  const known = Object.create(
    OperatorWebBoundary.prototype,
  ) as OperatorWebBoundary;
  for (const path of representative) {
    assert.ok(known.knownApi(path), path);
    assert.ok(
      operatorRouteAuthority("GET", path) ??
        operatorRouteAuthority("POST", path),
      path,
    );
  }
  assert.equal(
    operatorRouteAuthority("GET", "/api/operator/future"),
    undefined,
  );
  assert.equal(
    operatorRouteAuthority("DELETE", `/api/operator/tasks/${id}`),
    undefined,
  );
  assert.equal(
    operatorRouteAuthority("POST", `/api/operator/tasks/${id}`),
    undefined,
  );
});

test("Stop and Resume are receipted commands under bearer scope; retained forms stay session-only", async (t) => {
  const s = await startCliService(t, {
    service: { supervisor: { observationMs: 50 } },
  });
  const read = await s.issue("read", "control-ro");
  const write = await s.issue("read-write", "control-rw");
  const command = (type: string, key = randomUUID()) => ({
    type,
    key,
    taskId: s.taskId,
  });
  const before = databaseDigest(s.f);
  for (const type of ["task.stop", "task.resume"]) {
    const r = await s.bearer(read.token, "/api/operator/commands", {
      method: "POST",
      body: command(type),
    });
    assert.equal(r.status, 403, type);
    assert.equal(
      ((await r.json()) as { error: { code: string } }).error.code,
      "insufficient-scope",
    );
  }
  for (const token of [read.token, write.token])
    for (const path of ["/runtime/control/stop", "/runtime/control/resume"]) {
      const r = await fetch(`${s.origin}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ taskId: s.taskId }).toString(),
      });
      assert.equal(r.status, 403, path);
    }
  assert.equal(databaseDigest(s.f), before);
  assert.equal(s.f.service.isTaskStopped(s.taskId), false);

  const stop = command("task.stop");
  let r = await s.bearer(write.token, "/api/operator/commands", {
    method: "POST",
    body: stop,
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    kind: "task-stop",
    key: stop.key,
    recorded: true,
    taskId: s.taskId,
    cancellationRequested: 0,
  });
  assert.equal(s.f.service.isTaskStopped(s.taskId), true);
  r = await s.sessionPost("/api/operator/commands", command("task.resume"));
  assert.equal(r.status, 200);
  const resumed = (await r.json()) as Record<string, unknown>;
  assert.equal(resumed.kind, "task-resume");
  assert.equal(resumed.stopCleared, true);
  assert.equal(s.f.service.isTaskStopped(s.taskId), false);
  // The retained session form still works and shares the hold.
  r = await s.sessionForm("/runtime/control/stop", { taskId: s.taskId });
  assert.equal(r.status, 303);
  assert.equal(s.f.service.isTaskStopped(s.taskId), true);
  r = await s.bearer(write.token, "/api/operator/commands", {
    method: "POST",
    body: { ...stop, expectedVersion: 1 },
  });
  assert.equal(r.status, 409, "same key, other content");
});
