/**
 * How a GitLab request waits out a rate limit. GitLab answers a request it will not process with 429
 * and a plain-text body, so the request has had no effect and may be sent again once the limit clears.
 */
export interface RateLimitPolicy {
  /** Times one request is sent again after a 429; 3 when omitted. */
  maxRetries?: number | undefined;
  /** The most time one request spends waiting across its retries; 60 seconds when omitted. */
  maxTotalDelayMs?: number | undefined;
  /**
   * The first wait when a 429 names no reset time, doubled for each retry; 20 seconds when omitted,
   * so 20 and 40 seconds fill the default 60 second budget.
   * The Projects, Groups and Users APIs send no rate-limit headers on a 429.
   */
  fallbackDelayMs?: number | undefined;
  /** The clock `RateLimit-Reset` is compared against; `Date.now` when omitted. */
  now?: (() => number) | undefined;
  /** Waits; rejects when `signal` aborts. A timer when omitted. */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  /** Cancels a wait, and the request it would have retried. */
  signal?: AbortSignal | undefined;
}

const defaults = {
  maxRetries: 3,
  maxTotalDelayMs: 60_000,
  fallbackDelayMs: 20_000,
} as const;

/** A wait that ends early, with the signal's reason, when `signal` aborts. */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * How long a 429 asks the client to wait, or null when it names no time: `Retry-After` first (seconds, or
 * an HTTP date), then `RateLimit-Reset` (a Unix time in seconds, compared with `now`).
 */
export function rateLimitDelayMs(headers: Headers, now: number): number | null {
  const after = headers.get("retry-after")?.trim();
  if (after) {
    if (/^\d{1,9}$/.test(after)) return Number(after) * 1000;
    // Only a strict HTTP date: Date.parse also accepts "1.5" and "-5".
    if (
      /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
        after,
      ) &&
      !Number.isNaN(Date.parse(after))
    )
      return Math.max(0, Date.parse(after) - now);
  }
  const reset = headers.get("ratelimit-reset")?.trim();
  if (reset && /^\d{1,12}$/.test(reset))
    return Math.max(0, Number(reset) * 1000 - now);
  return null;
}

/**
 * Sends a request, and sends it again after a 429 that asks for a wait the policy allows. Only 429 is
 * retried, whatever the method: GitLab did not process that request. When the retries or the total wait
 * are used up, the last 429 is returned for the caller to treat as it always has. `request` builds each
 * attempt's init, so every attempt has its own timeout.
 */
export async function fetchRateLimited(
  fetcher: typeof fetch,
  url: string,
  request: () => RequestInit,
  policy: RateLimitPolicy = {},
): Promise<Response> {
  const maxRetries = policy.maxRetries ?? defaults.maxRetries;
  const maxTotal = policy.maxTotalDelayMs ?? defaults.maxTotalDelayMs;
  const fallback = policy.fallbackDelayMs ?? defaults.fallbackDelayMs;
  const now = policy.now ?? Date.now;
  const sleep = policy.sleep ?? abortableSleep;
  let waited = 0;
  for (let retry = 0; ; retry++) {
    policy.signal?.throwIfAborted();
    const response = await fetcher(url, request());
    if (response.status !== 429 || response.redirected) return response;
    const delay = Math.max(
      0,
      rateLimitDelayMs(response.headers, now()) ?? fallback * 2 ** retry,
    );
    if (retry >= maxRetries || waited + delay > maxTotal) return response;
    await response.body?.cancel().catch(() => {});
    waited += delay;
    await sleep(delay, policy.signal);
  }
}

/** The JSON body of a response; a body that is not JSON (a rate limit's plain text) is a plain failure. */
export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // Never the parse error: its message quotes the start of the body.
    throw new Error("provider-response-unreadable");
  }
}
