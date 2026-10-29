/** Why a Jira Cloud request failed; a stable code, never a message, header or response body. */
export type JiraFailureReason =
  | "unauthorized"
  | "not-found"
  | "redirected"
  | "rate-limited"
  | "unavailable"
  | "site-unreachable"
  | "not-json"
  | "jql-invalid"
  | "missing-credential"
  | "site-invalid"
  | "site-mismatch"
  | "malformed"
  | "page-limit";

export class JiraFailure extends Error {
  constructor(
    readonly reason: JiraFailureReason,
    /** Epoch ms before which a rate-limited read must not repeat. */
    readonly resumeAt?: number,
    /** Jira's own validation messages, for `jql-invalid` only. */
    readonly messages: readonly string[] = [],
  ) {
    super(`Jira request failed: ${reason}`);
    this.name = "JiraFailure";
  }
}

/** A resolved Jira site and its Basic credentials; held only for the duration of a call. */
export interface JiraAccess {
  /** The site host, the item `instance`. */
  instance: string;
  email: string;
  token: string;
}

const requestTimeoutMs = 20_000;
const maxBodyBytes = 16 * 1024 * 1024;
const maxRetryAfterMs = 3_600_000;

function retryAfter(response: Response): number {
  const header = response.headers.get("retry-after") ?? "";
  const seconds = /^\d{1,7}$/.test(header) ? Number(header) : NaN;
  const delay = Number.isNaN(seconds)
    ? Date.parse(header) - Date.now()
    : seconds * 1000;
  return (
    Date.now() + Math.min(Math.max(delay || 60_000, 1000), maxRetryAfterMs)
  );
}

/**
 * One request to `https://<instance>/rest/api/3<path>`. The origin is fixed by the site host
 * and a redirect is never followed, so the Authorization header cannot leave the site. Returns
 * the decoded JSON body; any other outcome is a `JiraFailure` carrying no response text.
 */
export async function jiraRequest(
  fetcher: typeof fetch,
  access: JiraAccess,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown } = { method: "GET" },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(`https://${access.instance}/rest/api/3${path}`, {
      method: init.method,
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        accept: "application/json",
        authorization: `Basic ${Buffer.from(`${access.email}:${access.token}`).toString("base64")}`,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    throw new JiraFailure("site-unreachable");
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new JiraFailure("redirected");
  }
  if (response.status === 429) {
    await response.body?.cancel();
    throw new JiraFailure("rate-limited", retryAfter(response));
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new JiraFailure("site-unreachable");
  }
  if (response.status === 401 || response.status === 403)
    throw new JiraFailure("unauthorized");
  if (response.status === 404) throw new JiraFailure("not-found");
  if (response.status >= 500) throw new JiraFailure("unavailable");
  let value: unknown;
  try {
    if (text.length > maxBodyBytes) throw new Error("too large");
    value = JSON.parse(text);
  } catch {
    throw new JiraFailure(response.ok ? "not-json" : "unavailable");
  }
  if (response.status === 400) {
    const messages =
      typeof value === "object" && value !== null && "errorMessages" in value
        ? (value as { errorMessages: unknown }).errorMessages
        : [];
    throw new JiraFailure(
      "jql-invalid",
      undefined,
      jiraMessages(Array.isArray(messages) ? messages : []),
    );
  }
  if (!response.ok) throw new JiraFailure("unavailable");
  return value;
}

/** Jira's validation messages, bounded and without control characters. */
export function jiraMessages(messages: readonly unknown[]): string[] {
  return (
    messages
      .filter((m): m is string => typeof m === "string")
      .slice(0, 5)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are stripped on purpose
      .map((m) => m.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300))
  );
}
