/** The error a qualification guard throws for a request it refuses. */
export class GuardDenied extends Error {
  constructor(readonly reason: string) {
    super(`guard-denied:${reason}`);
  }
}

/** Each 429 a provider answered: where it fell in the run, its rate-limit headers and its text. */
export interface RateLimitEvidence {
  route: string;
  /** Which request of the run this was, and when: seconds since the first, and requests in the minute before. */
  request: number;
  atSeconds: number;
  lastMinute: number;
  headers: Record<string, string>;
  retryAfter: string | null;
  body: string;
}

/** The response headers whose names match `pattern`, name and value. */
export const rateHeaders = (response: Response, pattern: RegExp) =>
  Object.fromEntries(
    [...response.headers.entries()].filter(([name]) => pattern.test(name)),
  );

/**
 * The accounting a qualification guard shares with every other: the write budget and the writes kept for
 * cleanup, the log of writes, request counts by route shape, request pacing, and the denial and 429
 * records. It decides nothing about what a provider permits; each guard checks its own routes and bodies,
 * then spends here.
 */
export class GuardMechanics {
  readonly log: Array<{ route: string; status: number | null }> = [];
  /** Every request the guard refused; a clean run has none. */
  readonly denied: string[] = [];
  /** Requests sent, by method and route shape. */
  readonly counts: Record<string, number> = {};
  readonly rateLimited: RateLimitEvidence[] = [];
  private readonly sentAt: number[] = [];
  private nextSlot = 0;
  private writes = 0;

  /** `paceMs` is the least time between two requests; `cleanupReserve` the writes only cleanup may spend. */
  constructor(
    private readonly limit: number,
    private readonly paceMs: number,
    private readonly cleanupReserve: number,
  ) {}

  get writeCount() {
    return this.writes;
  }

  deny(reason: string): never {
    this.denied.push(reason);
    throw new GuardDenied(reason);
  }

  /** Refuses a write the cap leaves no room for; a journey write must leave the cleanup reserve free. */
  checkBudget(cleanup: boolean) {
    if (this.writes >= this.limit - (cleanup ? 0 : this.cleanupReserve))
      this.deny("write-cap");
  }
  /** Counts a write and logs it, its status unknown until the response. */
  recordSpend(route: string) {
    this.writes++;
    this.log.push({ route, status: null });
  }
  spend(route: string, cleanup: boolean) {
    this.checkBudget(cleanup);
    this.recordSpend(route);
  }
  /** Gives the latest logged write its status, if it has none yet. */
  settle(status: number) {
    const last = this.log.at(-1);
    if (last && last.status === null) last.status = status;
  }

  /** Counts a request and waits for its pacing slot; slots are reserved first, so concurrent requests are spaced too. */
  async admit(shape: string) {
    this.counts[shape] = (this.counts[shape] ?? 0) + 1;
    this.sentAt.push(Date.now());
    const slot = Math.max(Date.now(), this.nextSlot);
    this.nextSlot = slot + this.paceMs;
    if (slot > Date.now())
      await new Promise((r) => setTimeout(r, slot - Date.now()));
  }

  async noteRateLimit(
    shape: string,
    response: Response,
    headers: Record<string, string>,
  ) {
    const now = Date.now();
    this.rateLimited.push({
      route: shape,
      request: this.sentAt.length,
      atSeconds: Math.round((now - (this.sentAt[0] ?? now)) / 1000),
      lastMinute: this.sentAt.filter((t) => now - t <= 60_000).length,
      headers,
      retryAfter: response.headers.get("retry-after"),
      body: (
        await response
          .clone()
          .text()
          .catch(() => "")
      ).slice(0, 4096),
    });
  }
}
