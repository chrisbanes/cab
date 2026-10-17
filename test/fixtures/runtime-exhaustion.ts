import type { StandaloneServiceOptions } from "../../src/standalone/service.js";
import { OperatorFixtureRuntime } from "./operator-web.js";
import { flush, ManualRestartClock } from "./restart-clock.js";

/**
 * A Codex runtime that can be told to fail every start, with a fake restart clock, so a fixture
 * can drive the runtime through its 30 s / 2 min / 10 min retries without waiting.
 */
export function exhaustibleRuntime() {
  const clock = new ManualRestartClock();
  const gate = { failStarts: false, starts: 0 };
  class Runtime extends OperatorFixtureRuntime {
    override async start() {
      gate.starts++;
      if (gate.failStarts) throw new Error("App Server will not start");
    }
  }
  const serviceOptions: StandaloneServiceOptions = {
    runtimeRestart: { clock, wallNow: clock.wallNow },
  };
  return {
    clock,
    gate,
    serviceOptions,
    factory: () => new Runtime(),
    /** Crashes the live runtime and runs all three failing retries to exhaustion. */
    async exhaust(runtime: { crash(): void }) {
      gate.failStarts = true;
      runtime.crash();
      for (const delay of [30_000, 120_000, 600_000]) {
        const before = gate.starts;
        clock.advance(delay);
        for (let turn = 0; turn < 2000 && gate.starts === before; turn++)
          await flush(1);
        await flush();
      }
    },
  };
}
