import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ResourceController,
  type ResourceState,
} from "../../web/src/resource.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function freshController(value = "first") {
  const published: ResourceState<string>[] = [];
  const controller = new ResourceController<string>((state) =>
    published.push(state),
  );
  await controller.load(async () => value);
  published.length = 0;
  return { controller, published };
}

test("a background read publishes only when it settles", async () => {
  const { controller, published } = await freshController();
  const read = deferred<string>();
  const loading = controller.load(() => read.promise, { background: true });
  assert.equal(published.length, 0);
  assert.equal(controller.state.pending, false);
  assert.equal(controller.state.status, "fresh");
  read.reject(new Error("unavailable"));
  await loading;
  assert.equal(published.length, 1);
  assert.equal(controller.state.status, "stale");
  assert.equal(controller.state.error, "unavailable");
  assert.equal(controller.state.data, "first");
});

test("a background read never interrupts or outlives a newer read", async () => {
  const { controller } = await freshController();
  const slow = deferred<string>();
  const first = controller.load(() => slow.promise, { background: true });
  let skipped = true;
  await controller.load(
    async () => {
      skipped = false;
      return "ignored";
    },
    { background: true },
  );
  assert.equal(skipped, true);

  const explicit = deferred<string>();
  const refreshing = controller.load(() => explicit.promise);
  assert.equal(controller.state.status, "stale");
  assert.equal(controller.state.pending, true);
  slow.resolve("late poll");
  await first;
  assert.equal(controller.state.data, "first");
  explicit.resolve("explicit");
  await refreshing;
  assert.equal(controller.state.data, "explicit");

  const pending = deferred<string>();
  const waiting = controller.load(() => pending.promise);
  let ran = false;
  await controller.load(
    async () => {
      ran = true;
      return "ignored";
    },
    { background: true },
  );
  assert.equal(ran, false);
  pending.resolve("done");
  await waiting;
});

test("an unauthenticated background read clears the resource", async () => {
  const { controller } = await freshController();
  await controller.load(
    async () => {
      throw new Error("unauthenticated");
    },
    { background: true },
  );
  assert.equal(controller.state.status, "empty");
  assert.equal(controller.state.data, null);
});

test("replies that arrive out of order publish only the latest read, whether it succeeds or fails", async () => {
  const { controller } = await freshController("first");
  const older = deferred<string>();
  const newer = deferred<string>();
  const first = controller.load(() => older.promise);
  const second = controller.load(() => newer.promise);
  // The newer read answers first, then the older one: the older never replaces it.
  newer.resolve("newer");
  await second;
  older.resolve("older");
  await first;
  assert.equal(controller.state.data, "newer");
  assert.equal(controller.state.status, "fresh");

  // An older read that fails after a newer one succeeded does not turn it into an error.
  const failing = deferred<string>();
  const latest = deferred<string>();
  const doomed = controller.load(() => failing.promise);
  const current = controller.load(() => latest.promise);
  latest.resolve("latest");
  await current;
  failing.reject(new Error("unavailable"));
  await doomed;
  assert.equal(controller.state.data, "latest");
  assert.equal(controller.state.error, null);

  // And the latest read failing is the failure that shows.
  const last = deferred<string>();
  const superseded = deferred<string>();
  const early = controller.load(() => superseded.promise);
  const final = controller.load(() => last.promise);
  last.reject(new Error("unavailable"));
  await final;
  superseded.resolve("ignored");
  await early;
  assert.equal(controller.state.error, "unavailable");
  assert.equal(controller.state.data, "latest");
});
