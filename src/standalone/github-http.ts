export const githubApi = "https://api.github.com";
const maxRedirects = 3;
const redirects = new Set([301, 302, 303, 307, 308]);

/**
 * One GitHub API request. A non-GET never follows a redirect; a GET follows at
 * most three, each of which must stay on the API origin. Anything else is the
 * caller's `refused` error, so each client keeps its own error vocabulary.
 */
export async function githubFetch(
  fetcher: typeof fetch,
  href: string,
  init: RequestInit & { method: string },
  refused: () => Error,
): Promise<Response> {
  const get = init.method === "GET";
  let target = new URL(href);
  for (let hop = 0; ; hop++) {
    if (target.origin !== githubApi) throw refused();
    const response = await fetcher(target.href, {
      ...init,
      redirect: get ? "manual" : "error",
    });
    if (
      response.redirected ||
      (response.url && new URL(response.url).origin !== githubApi)
    )
      throw refused();
    if (!redirects.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!get || !location || hop >= maxRedirects) throw refused();
    await response.body?.cancel();
    target = new URL(location, target);
  }
}

/** The `rel="next"` URL of a Link header, or null when there is no next page. */
export function nextPageLink(
  response: Response,
  malformed: () => Error,
): string | null {
  const next = response.headers
    .get("link")
    ?.split(",")
    .find((part) => /;\s*rel="next"/.test(part));
  if (!next) return null;
  const match = /<([^>]+)>/.exec(next);
  if (!match?.[1]) throw malformed();
  return new URL(match[1], githubApi).href;
}

/**
 * Pages a GitHub REST listing from `first`, yielding each page's decoded body.
 * At most 100 pages are read and a repeated URL is refused, both as `exceeded`.
 */
export async function* githubPages(
  first: string,
  request: (url: string) => Promise<{ response: Response; value: unknown }>,
  next: (response: Response) => string | null,
  exceeded: () => Error,
): AsyncGenerator<unknown> {
  const seen = new Set<string>();
  let url: string | null = first;
  for (let page = 0; url; page++) {
    if (page >= 100 || seen.has(url)) throw exceeded();
    seen.add(url);
    const { response, value } = await request(url);
    yield value;
    url = next(response);
  }
}

/**
 * The epoch-ms time GitHub says to resume when a failed response is a primary or
 * secondary rate limit, else undefined. Reads (and so consumes) a 403 body.
 */
export async function githubRateLimitResumeAt(
  response: Response,
): Promise<number | undefined> {
  if (response.status !== 403 && response.status !== 429) return undefined;
  const header = (name: string) => response.headers.get(name);
  const retryAfter = header("retry-after");
  // A 429 is always a rate limit; a 403 is one only when its headers or body say so.
  if (
    response.status === 403 &&
    header("x-ratelimit-remaining") !== "0" &&
    retryAfter === null &&
    !/rate limit/i.test(await response.text().catch(() => ""))
  )
    return undefined;
  return resumeTime(response);
}

/**
 * The epoch-ms time to resume after a GraphQL rate limit, else undefined.
 * GraphQL reports a spent budget as HTTP 200 with a `RATE_LIMITED` error (or
 * errors alongside an exhausted `x-ratelimit-remaining`), never as 403/429.
 * A write that must know GitHub did not apply it passes `typedOnly`: the request
 * that spends the last point executes and also reports `remaining: 0`.
 */
export function githubGraphqlRateLimitResumeAt(
  response: Response,
  errors: readonly unknown[],
  { typedOnly = false } = {},
): number | undefined {
  const limited =
    errors.length > 0 &&
    ((!typedOnly && response.headers.get("x-ratelimit-remaining") === "0") ||
      errors.some(
        (error) =>
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "RATE_LIMITED",
      ));
  return limited ? resumeTime(response) : undefined;
}

function resumeTime(response: Response): number {
  const header = (name: string) => response.headers.get(name);
  const retryAfter = header("retry-after");
  const now = Date.now();
  // Only positive whole seconds are usable; empty, negative or past values fall back.
  const seconds = (value: string | null) =>
    value !== null && /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  const times = [
    seconds(header("x-ratelimit-reset")) * 1000,
    now + seconds(retryAfter) * 1000,
  ].filter((time) => Number.isFinite(time) && time > now);
  // GitHub documents waiting at least one minute when no header gives a reset time.
  // Headers are external input: cap at GitHub's one-hour primary window so they cannot pause work indefinitely.
  return times.length
    ? Math.min(Math.max(...times), now + 3_600_000)
    : now + 60_000;
}
