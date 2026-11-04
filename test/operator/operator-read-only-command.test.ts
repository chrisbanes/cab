import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { OperatorCommand } from "../../src/operator/contracts.js";
import { OperatorClient } from "../../web/src/api.js";
import { CommandSend } from "../../web/src/command-send.js";

test("archive transition keeps frozen comment body/key and reads the original receipt without retrying a write", async () => {
  const command: OperatorCommand = {
    type: "task.comment.send",
    key: randomUUID(),
    taskId: randomUUID(),
    body: "Original comment",
    recipients: [],
  };
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  let recorded = false;
  const receipt = {
    kind: "domain" as const,
    key: command.key,
    recorded: true as const,
    result: {
      id: command.taskId,
      projectId: randomUUID(),
      state: "open" as const,
      ready: false,
      version: 1,
    },
  };
  const client = new OperatorClient(async (url, init) => {
    const method = init?.method ?? "GET";
    requests.push({ method, url: String(url), body: init?.body });
    if (method === "POST") throw Error("lost reply");
    return new Response(
      JSON.stringify({
        observedAt: 1,
        data: recorded
          ? { state: "recorded", receipt }
          : { state: "not-recorded" },
      }),
    );
  });
  const send = new CommandSend();
  const matches = (c: OperatorCommand, r: { key: string }) => c.key === r.key;
  assert.equal(
    (await send.send(client, "csrf", matches, command))?.kind,
    "unknown",
  );
  const original = send.lifecycle.frozen;
  assert.equal(
    (await send.send(client, "csrf", matches, undefined, true))?.kind,
    "unknown",
  );
  assert.deepEqual(send.lifecycle.frozen, original);
  assert.equal(requests.filter((r) => r.method === "POST").length, 1);
  const query = new URL(requests[1]!.url, "http://fixture.invalid")
    .searchParams;
  assert.equal(query.get("scope"), `task:${command.taskId}`);
  assert.equal(query.get("type"), command.type);
  assert.equal(query.get("key"), command.key);
  assert.equal(
    await send.send(
      client,
      "csrf",
      matches,
      { ...command, key: randomUUID(), body: "Edited" },
      true,
    ),
    null,
  );
  assert.deepEqual(send.lifecycle.frozen, original);
  recorded = true;
  assert.equal(
    (await send.send(client, "csrf", matches, undefined, true))?.kind,
    "recorded",
  );
  assert.equal(requests.filter((r) => r.method === "POST").length, 1);
});

test("historical checks without an existing receipt read operation remain unknown and never POST", async () => {
  const command: OperatorCommand = {
    type: "review.view",
    key: randomUUID(),
    taskId: randomUUID(),
    sourceId: null,
    resultIds: [],
  };
  let calls = 0;
  const client = new OperatorClient(async () => {
    calls++;
    throw Error("must not request");
  });
  const send = new CommandSend();
  send.lifecycle.restoreUnknown(command);
  const frozen = send.lifecycle.frozen;
  const result = await send.send(client, "csrf", () => false, undefined, true);
  assert.equal(result?.kind, "unknown");
  assert.deepEqual(send.lifecycle.frozen, frozen);
  assert.equal(calls, 0);
});

test("read-only assignment apply checks its original project-scoped operation and never resends", async () => {
  const command: OperatorCommand = {
    type: "assignment.apply",
    key: randomUUID(),
    projectId: randomUUID(),
    assignmentId: randomUUID(),
    expectedVersion: 1,
  };
  const requests: string[] = [];
  const client = new OperatorClient(async (url) => {
    requests.push(String(url));
    return Response.json({ observedAt: 1, data: { state: "not-recorded" } });
  });
  const send = new CommandSend();
  send.lifecycle.restoreUnknown(command);
  assert.equal(
    (await send.send(client, "csrf", () => false, undefined, true))?.kind,
    "unknown",
  );
  const query = new URL(requests[0]!, "http://fixture.invalid").searchParams;
  assert.equal(query.get("scope"), `project:${command.projectId}`);
  assert.equal(query.get("key"), command.key);
  assert.equal(query.get("type"), "assignment.apply");
  assert.equal(requests.length, 1);
});
