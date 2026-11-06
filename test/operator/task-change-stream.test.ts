import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ChangeSource,
  TaskChangeStream,
  streamTiming,
} from "../../web/src/task-change-stream.js";

class FakeSource implements ChangeSource {
  readonly listeners = new Map<string, () => void>();
  closed = false;
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
  }
  emit(type: "heartbeat" | "read" | "timeline" | "error") {
    this.listeners.get(type)?.();
  }
}

function setup(random = 0.5) {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const sources: FakeSource[] = [];
  const opened: number[] = [];
  let hidden = false;
  let changed = () => {};
  const calls: string[] = [];
  const health: boolean[] = [];
  const stream = new TaskChangeStream({
    url: "/api/operator/tasks/t/stream",
    onRead: () => calls.push("read"),
    onTimeline: () => calls.push("timeline"),
    onHealthy: (healthy) => health.push(healthy),
    open: () => {
      const source = new FakeSource();
      sources.push(source);
      opened.push(now);
      return source;
    },
    setTimer: (run, ms) => {
      const id = ++next;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimer: (id) => timers.delete(id as number),
    now: () => now,
    random: () => random,
    visibility: {
      hidden: () => hidden,
      watch: (listener) => {
        changed = listener;
        return () => {
          changed = () => {};
        };
      },
    },
  });
  /** Runs due timers in order until `ms` has passed. */
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end);
      if (!due.length) break;
      due.sort((a, b) => a[1].at - b[1].at);
      const [id, timer] = due[0]!;
      timers.delete(id);
      now = timer.at;
      timer.run();
    }
    now = end;
  };
  return {
    stream,
    sources,
    opened,
    calls,
    health,
    timers,
    advance,
    now: () => now,
    source: () => sources.at(-1)!,
    setHidden: (value: boolean) => {
      hidden = value;
      changed();
    },
  };
}

test("the first frame marks the stream healthy and refetches once per connection", () => {
  const s = setup();
  assert.deepEqual(s.health, []);
  s.source().emit("heartbeat");
  s.source().emit("heartbeat");
  assert.deepEqual(s.health, [true]);
  assert.deepEqual(s.calls, ["read"]);
  s.source().emit("error");
  assert.deepEqual(s.health, [true, false]);
  s.advance(streamTiming.firstRetryMs);
  s.source().emit("heartbeat");
  assert.deepEqual(s.health, [true, false, true]);
  assert.deepEqual(s.calls, ["read", "read"]);
});

test("notices are debounced, a read outranks a timeline and a busy stream still refreshes", () => {
  const s = setup();
  s.source().emit("heartbeat");
  s.calls.length = 0;
  s.source().emit("timeline");
  s.advance(streamTiming.debounceMs);
  assert.deepEqual(s.calls, ["timeline"]);
  for (let i = 0; i < 5; i += 1) s.source().emit(i === 2 ? "read" : "timeline");
  s.advance(streamTiming.debounceMs - 1);
  assert.deepEqual(s.calls, ["timeline"]);
  s.advance(1);
  assert.deepEqual(s.calls, ["timeline", "read"]);
  s.calls.length = 0;
  // A notice every 100 ms never lets the debounce settle; the maximum wait does.
  for (let t = 0; t < 4_000; t += 100) {
    s.source().emit("timeline");
    s.advance(100);
  }
  assert.ok(s.calls.length >= 1 && s.calls.length <= 2, String(s.calls));
});

test("errors reconnect with doubling, capped, jittered back-off reset by a frame", () => {
  for (const [random, factor] of [
    [0.5, 1],
    [0, 1 - streamTiming.jitter],
    [1, 1 + streamTiming.jitter],
  ] as const) {
    const s = setup(random);
    const delays: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const before = s.now();
      s.source().emit("error");
      assert.ok(s.sources.at(-1)!.closed);
      s.advance(40_000);
      delays.push(s.opened.at(-1)! - before);
    }
    assert.deepEqual(
      delays,
      [1, 2, 4, 8, 16, 30, 30].map((sec) => sec * 1000 * factor),
    );
    s.source().emit("heartbeat");
    const before = s.now();
    s.source().emit("error");
    s.advance(40_000);
    assert.equal(s.opened.at(-1)! - before, 1000 * factor);
  }
});

test("45 seconds without a frame reconnects", () => {
  const s = setup();
  s.source().emit("heartbeat");
  s.advance(streamTiming.silenceMs - 1);
  assert.equal(s.sources.length, 1);
  s.advance(1);
  assert.ok(s.sources[0]!.closed);
  assert.deepEqual(s.health, [true, false]);
  s.advance(streamTiming.firstRetryMs);
  assert.equal(s.sources.length, 2);
});

test("a page hidden for a minute closes the stream and reopens it when visible", () => {
  const s = setup();
  s.source().emit("heartbeat");
  s.setHidden(true);
  s.advance(30_000);
  s.setHidden(false);
  s.setHidden(true);
  for (let i = 0; i < 3; i += 1) {
    s.source().emit("heartbeat");
    s.advance(15_000);
  }
  s.source().emit("heartbeat");
  s.advance(14_999);
  assert.ok(!s.source().closed);
  s.advance(1);
  assert.ok(s.source().closed);
  assert.deepEqual(s.health, [true, false]);
  s.advance(10 * 60_000);
  assert.equal(s.sources.length, 1, "no reconnect while hidden");
  s.setHidden(false);
  assert.equal(s.sources.length, 2);
  s.source().emit("heartbeat");
  assert.deepEqual(s.calls, ["read", "read"]);
});

test("dispose closes the source and cancels every timer", () => {
  const s = setup();
  s.source().emit("heartbeat");
  s.source().emit("read");
  s.setHidden(true);
  s.stream.dispose();
  assert.ok(s.source().closed);
  assert.equal(s.timers.size, 0);
  s.advance(10 * 60_000);
  assert.equal(s.sources.length, 1);
  assert.deepEqual(s.calls, ["read"]);
});
