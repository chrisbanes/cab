import type { StandaloneService } from "../../src/standalone/service.js";

// Tests reach the service's private lifecycle state only through these helpers.

/** The published component record; throws "Service is not started" when unpublished. */
export function startedOf(service: StandaloneService) {
  // biome-ignore lint/complexity/useLiteralKeys: private member access for tests
  return service["started"]();
}

/** The published component record, or undefined. */
export function publishedOf(service: StandaloneService) {
  // biome-ignore lint/complexity/useLiteralKeys: private member access for tests
  return service["current"];
}

/** The components start() acquired, which teardown releases. */
export function acquiredOf(service: StandaloneService) {
  // biome-ignore lint/complexity/useLiteralKeys: private member access for tests
  return service["acquired"];
}

export function timersOf(service: StandaloneService) {
  // biome-ignore lint/complexity/useLiteralKeys: private member access for tests
  return service["timers"];
}

/** Simulates a crash: the service stops admitting without any teardown. */
export function unpublish(service: StandaloneService): void {
  // biome-ignore lint/complexity/useLiteralKeys: private member access for tests
  service["current"] = undefined;
}
