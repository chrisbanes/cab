import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import {
  GuardDenied,
  GuardMechanics,
  rateHeaders,
} from "./qualification-guard-mechanics.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const refusal = (reason: string) => (error: unknown) =>
  error instanceof GuardDenied &&
  error.reason === reason &&
  error.message === `guard-denied:${reason}`;

test("a journey write leaves the cleanup reserve free, and only cleanup may spend it", () => {
  const mechanics = new GuardMechanics(4, 0, 2);
  mechanics.spend("POST a", false);
  mechanics.spend("POST b", false);
  assert.throws(() => mechanics.spend("POST c", false), refusal("write-cap"));
  mechanics.spend("DELETE d", true);
  mechanics.spend("DELETE e", true);
  assert.throws(() => mechanics.spend("DELETE f", true), refusal("write-cap"));
  assert.equal(mechanics.writeCount, 4);
  assert.deepEqual(
    mechanics.log.map((e) => e.route),
    ["POST a", "POST b", "DELETE d", "DELETE e"],
  );
  assert.deepEqual(mechanics.denied, ["write-cap", "write-cap"]);
});

test("a denied budget check spends and logs nothing; a recorded spend is logged unfinished, then given one status", () => {
  const mechanics = new GuardMechanics(1, 0, 1);
  assert.throws(() => mechanics.checkBudget(false), refusal("write-cap"));
  assert.equal(mechanics.writeCount, 0);
  assert.deepEqual(mechanics.log, []);
  mechanics.checkBudget(true);
  mechanics.recordSpend("PUT x");
  assert.deepEqual(mechanics.log, [{ route: "PUT x", status: null }]);
  mechanics.settle(429);
  mechanics.settle(200);
  assert.deepEqual(mechanics.log, [{ route: "PUT x", status: 429 }]);
  assert.equal(mechanics.writeCount, 1);
});

test("denials are recorded in order and thrown as the shared error", () => {
  const mechanics = new GuardMechanics(1, 0, 0);
  assert.throws(() => mechanics.deny("origin"), refusal("origin"));
  assert.throws(() => mechanics.deny("read"), refusal("read"));
  assert.deepEqual(mechanics.denied, ["origin", "read"]);
  assert.ok(new GuardDenied("x") instanceof Error);
});

test("requests are counted by the route shape the guard names", async () => {
  const mechanics = new GuardMechanics(1, 0, 0);
  await mechanics.admit("GET /a/:n");
  await mechanics.admit("GET /a/:n");
  await mechanics.admit("POST /a");
  assert.deepEqual(mechanics.counts, { "GET /a/:n": 2, "POST /a": 1 });
});

test("concurrent requests are spaced by slots reserved before any waits", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const paced = new GuardMechanics(1, 50, 0);
  const released: number[] = [];
  const requests = [0, 1, 2].map((n) =>
    paced.admit("GET /x").then(() => released.push(n)),
  );
  await settle();
  assert.deepEqual(released, [0]);
  t.mock.timers.tick(49);
  await settle();
  assert.deepEqual(released, [0]);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(released, [0, 1]);
  t.mock.timers.tick(50);
  await settle();
  assert.deepEqual(released, [0, 1, 2]);
  await Promise.all(requests);
});

test("a 429 records where it fell, its selected headers, the wait it named and a bounded body", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const mechanics = new GuardMechanics(2, 0, 0);
  await mechanics.admit("POST /a");
  t.mock.timers.tick(90_000);
  await mechanics.admit("GET /b");
  mechanics.spend("POST /a", false);
  const response = new Response("x".repeat(5000), {
    status: 429,
    headers: {
      "retry-after": "7",
      "x-ratelimit-limit": "10",
      "content-type": "text/plain",
    },
  });
  const headers = rateHeaders(response, /^(x-ratelimit|retry-after)/);
  assert.deepEqual(headers, {
    "retry-after": "7",
    "x-ratelimit-limit": "10",
  });
  await mechanics.noteRateLimit("POST /a", response, headers);
  assert.deepEqual(mechanics.rateLimited, [
    {
      route: "POST /a",
      request: 2,
      atSeconds: 90,
      lastMinute: 1,
      headers,
      retryAfter: "7",
      body: "x".repeat(4096),
    },
  ]);
  // A 429 does not give the write back: releasing an allowance is the guard's own decision.
  assert.equal(mechanics.writeCount, 1);
  assert.equal(await response.text(), "x".repeat(5000));
});

test("a 429 whose body cannot be read is recorded with an empty body", async () => {
  const mechanics = new GuardMechanics(1, 0, 0);
  await mechanics.admit("GET /a");
  const failing = new Response(
    new ReadableStream({
      start: (controller) => controller.error(new Error("broken")),
    }),
    { status: 429 },
  );
  await mechanics.noteRateLimit("GET /a", failing, {});
  assert.equal(mechanics.rateLimited[0]?.body, "");
  assert.equal(mechanics.rateLimited[0]?.retryAfter, null);
});
