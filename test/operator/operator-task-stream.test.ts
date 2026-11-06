import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { startCliService } from "../fixtures/operator-cli.js";

type After = { after(fn: () => unknown): void };
const framePattern =
  /^(?:event: (?:read|timeline|heartbeat)\ndata: \{\}\n\n)*$/;
const apiCsp =
  "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'";

async function setup(
  t: After,
  options: Parameters<typeof startCliService>[1] = {},
) {
  const s = await startCliService(t, options);
  const path = `/api/operator/tasks/${s.taskId}/stream`;
  /** Opens a stream with the signed-in cookie and reads it incrementally. */
  const open = async (headers: Record<string, string> = {}) => {
    const abort = new AbortController();
    t.after(() => abort.abort());
    const response = await fetch(`${s.origin}${path}`, {
      headers: { cookie: s.cookie, ...headers },
      signal: abort.signal,
    });
    let text = "";
    let ended = false;
    const reading = (async () => {
      if (!response.body) return;
      const decoder = new TextDecoder();
      try {
        for await (const chunk of response.body)
          text += decoder.decode(chunk, { stream: true });
      } catch {
        // Aborted by the test.
      }
      ended = true;
    })();
    const until = async (condition: () => boolean, label: string) => {
      const deadline = Date.now() + 10_000;
      while (!condition()) {
        if (Date.now() > deadline) throw Error(`timed out: ${label}\n${text}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    return {
      response,
      abort: () => abort.abort(),
      text: () => text,
      ended: () => ended,
      events: () => [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]),
      until,
      closed: async () => {
        await until(() => ended, "stream end");
        await reading;
      },
    };
  };
  return { s, path, open };
}

test("an authenticated stream sends content-free notices for its task", async (t) => {
  const { s, open } = await setup(t);
  const stream = await open();
  assert.equal(stream.response.status, 200);
  assert.equal(
    stream.response.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
  assert.equal(stream.response.headers.get("content-security-policy"), apiCsp);
  await stream.until(() => stream.events().length > 0, "first frame");
  assert.deepEqual(stream.events(), ["heartbeat"]);

  const title = `Distinctive title ${randomUUID()}`;
  const d = s.f.service.domain();
  const configured = await s.sessionPost("/api/operator/commands", {
    type: "task.configure",
    key: randomUUID(),
    projectId: s.projectId,
    taskId: s.taskId,
    expectedVersion: Number(d.task(s.taskId).version),
    title,
  });
  assert.equal(configured.status, 200, await configured.text());
  await stream.until(() => stream.events().includes("read"), "read notice");
  const again = await s.sessionPost("/api/operator/commands", {
    type: "task.configure",
    key: randomUUID(),
    projectId: s.projectId,
    taskId: s.taskId,
    expectedVersion: Number(d.task(s.taskId).version),
    outcome: `Outcome ${title}`,
  });
  assert.equal(again.status, 200, await again.text());
  await stream.until(
    () => stream.events().filter((e) => e === "read").length >= 2,
    "second notice",
  );
  stream.abort();
  const text = stream.text();
  assert.match(text, framePattern);
  assert.ok(!text.includes(title) && !text.includes(s.taskId));
});

test("the stream is refused without a signed-in same-origin session", async (t) => {
  const { s, path } = await setup(t);
  const get = (headers: Record<string, string>, target = path) =>
    fetch(`${s.origin}${target}`, { headers });
  const code = async (response: Response) =>
    ((await response.json()) as { error: { code: string } }).error.code;
  let r = await get({});
  assert.equal(r.status, 401);
  assert.equal(await code(r), "unauthenticated");
  const anonymous = (await fetch(`${s.origin}/api/operator/session`)).headers
    .get("set-cookie")
    ?.split(";")[0];
  r = await get({ cookie: anonymous ?? "" });
  assert.equal(r.status, 401);
  r = await get({ cookie: s.cookie, origin: "http://evil.example" });
  assert.equal(r.status, 403);
  assert.equal(await code(r), "forbidden");
  const read = await s.issue("read", "stream-ro");
  r = await s.bearer(read.token, path);
  assert.equal(r.status, 403);
  r = await get(
    { cookie: s.cookie },
    `/api/operator/tasks/${randomUUID()}/stream`,
  );
  assert.equal(r.status, 404);
  r = await get({ cookie: s.cookie }, `${path}?since=1`);
  assert.equal(r.status, 400);
  r = await fetch(`${s.origin}${path}`, {
    method: "POST",
    headers: { cookie: s.cookie },
  });
  assert.equal(r.status, 405);
});

test("streams end on sign-out, session expiry, shutdown and project deletion", async (t) => {
  let clock = Date.now();
  const { open } = await setup(t, {
    auth: { now: () => clock, idleTimeoutMs: 60_000 },
    streamHeartbeatMs: 50,
  });
  // Expiry: the next heartbeat finds the session gone.
  let stream = await open();
  await stream.until(() => stream.events().length > 1, "heartbeats");
  clock += 120_000;
  await stream.closed();
  clock = Date.now();

  // Shutdown resolves with a stream open.
  const shutdown = await setup(t, { streamHeartbeatMs: 50 });
  stream = await shutdown.open();
  await stream.until(() => stream.events().length > 0, "first frame");
  await shutdown.s.http.stop();
  await stream.closed();

  // Sign-out.
  const signed = await setup(t);
  stream = await signed.open();
  await stream.until(() => stream.events().length > 0, "first frame");
  const out = await signed.s.sessionPost("/api/operator/logout", {});
  assert.equal(out.status, 200);
  await stream.closed();

  // Project deletion.
  const deleted = await setup(t);
  stream = await deleted.open();
  await stream.until(() => stream.events().length > 0, "first frame");
  const d = deleted.s.f.service.domain();
  d.execute({
    type: "project.archive",
    actor: "operator",
    key: randomUUID(),
    projectId: deleted.s.projectId,
    expectedVersion: Number(d.project(deleted.s.projectId).version),
  });
  const preview = (
    (await (
      await deleted.s.sessionGet(
        `/api/operator/projects/${deleted.s.projectId}/delete-preview`,
      )
    ).json()) as {
      data: { name: string; version: number; previewDigest: string };
    }
  ).data;
  const removed = await deleted.s.sessionPost("/api/operator/commands", {
    type: "project.delete",
    key: randomUUID(),
    projectId: deleted.s.projectId,
    confirmationName: preview.name,
    expectedVersion: preview.version,
    previewDigest: preview.previewDigest,
  });
  assert.equal(removed.status, 200, await removed.text());
  await stream.closed();
});

test("a session holds at most three streams and a closed one frees its slot", async (t) => {
  const { open } = await setup(t);
  const streams = [await open(), await open(), await open()];
  for (const stream of streams) assert.equal(stream.response.status, 200);
  const refused = await open();
  assert.equal(refused.response.status, 503);
  assert.equal(refused.response.headers.get("retry-after"), "30");
  streams[0]!.abort();
  // The server frees the slot when it sees the socket close.
  const deadline = Date.now() + 10_000;
  for (;;) {
    const next = await open();
    if (next.response.status === 200) break;
    assert.ok(Date.now() < deadline, "slot freed");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});
