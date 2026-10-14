import { EventEmitter } from "node:events";
import {
  CaffeinateAssertion,
  type PowerEventBatch,
  type PowerEventSource,
} from "../../src/standalone/power.js";
import type { PowerEventCursor } from "../../src/standalone/state.js";

const baseline: PowerEventCursor = { version: 1, value: "baseline" };

/**
 * A power-event source with no transitions. While `complete` is false its history is
 * incomplete, so the supervisor holds admission ("Power-event history is incomplete or
 * ambiguous"); once true, the next poll reconciles and releases the hold.
 */
export class ControllablePowerEvents implements PowerEventSource {
  complete = false;

  async readSince(
    requested: PowerEventCursor | null,
  ): Promise<PowerEventBatch> {
    return {
      complete: this.complete,
      fromCursor: requested,
      cursor: requested ?? baseline,
      events: [],
    };
  }
}

class FakeChild extends EventEmitter {
  kill() {
    queueMicrotask(() => this.emit("close", 0, "SIGTERM"));
    return true;
  }
}

/** Service options that supervise power with `events` and a fake caffeinate child. */
export function supervisedPower(events: PowerEventSource) {
  return {
    eventSource: events,
    pollIntervalMs: 10,
    assertion: new CaffeinateAssertion((() => new FakeChild()) as never),
  };
}
