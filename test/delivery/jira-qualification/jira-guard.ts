import { isAbsolute } from "node:path";
import { glabTokenVariables } from "../../../src/standalone/glab-credential.js";
import { GuardDenied } from "../gitlab-qualification/gitlab-guard.js";

/** The only Jira site and project a qualification run may reach. */
export const qualificationSite = {
  host: "banes-team.atlassian.net",
  projectKey: "KAN",
  projectId: "10001",
} as const;
/** The variables a live run needs by name; their values are never printed, stored or committed. */
export const liveVariables = [
  "CAB_JIRA_SITE",
  "CAB_JIRA_EMAIL",
  "CAB_JIRA_API_TOKEN",
  "CAB_GITLAB_TOKEN",
] as const;
/** The writes cleanup needs at most: delete both issues, or remove `cab-ready` from both. */
export const jiraCleanupWrites = 4;
/** Jira writes (API writes) one run may make. */
export const maxJiraWrites = 16;
/** The least time between two Jira requests of a live run. */
export const jiraPaceMs = 500;

export const runPattern = /^\d{14}-[0-9a-f]{4}$/;
export const runLabel = (run: string) => `cab-qual-${run}`;
/** The JQL that selects exactly one run's issues. */
export const runJql = (run: string) =>
  `project = ${qualificationSite.projectKey} AND labels = "${runLabel(run)}"`;
/** The summary every issue of a run carries; only these are ever deleted by a cleanup. */
export const summaryOf = (run: string, role: "a" | "blocker") =>
  `Qualification ${run} ${role}`;
export const summaryPattern =
  /^Qualification (\d{14}-[0-9a-f]{4}) (?:a|blocker)$/;

const base = "/rest/api/3";
const issueRoute =
  /^\/issue\/([A-Za-z0-9-]+)(?:\/(transitions|changelog|comment))?$/;
const keyPattern = new RegExp(
  `^${qualificationSite.projectKey}-[1-9][0-9]{0,8}$`,
);
const rateHeader = /^(x-ratelimit|ratelimit|retry-after|beta-retry-after)/;
/** Writes by route, and the most a run may send of each; a send answered 429 is released. */
const routeCaps: Record<string, number> = {
  "POST issue": 2,
  "POST issueLink": 1,
  "POST transition": 4,
  "POST comment": 1,
  "PUT labels": 1,
  "PUT remove-ready": 2,
  "DELETE issue": 2,
};

/**
 * Enforces the run's fixed scope on every Jira request the harness and the product make: only
 * https://banes-team.atlassian.net, only project KAN (id 10001), reads of the run's own issues, and writes
 * only to issues this run created, at most `limit` in all with `cleanupReserve` kept for cleanup. Nothing
 * is logged but the method, the route shape and the status; never a header, a body or a credential.
 */
export class JiraGuard {
  /** Issues this run created (or a cleanup recognised as a run's), by id. */
  readonly issues = new Map<string, string>();
  readonly log: Array<{ route: string; status: number | null }> = [];
  /** Every request the guard refused; a clean run has none. */
  readonly denied: string[] = [];
  /** Requests sent, by method and route shape. */
  readonly counts: Record<string, number> = {};
  /** Each 429 Jira answered: where it fell in the run, every rate-limit header value, and its text. */
  readonly rateLimited: Array<{
    route: string;
    request: number;
    atSeconds: number;
    lastMinute: number;
    headers: Record<string, string>;
    retryAfter: string | null;
    body: string;
  }> = [];
  /** The latest rate-limit header values seen on any response. */
  lastRateHeaders: Record<string, string> = {};
  /** Set by a cleanup: only then may an issue be deleted or `cab-ready` removed. */
  cleaning = false;
  private run: string | null = null;
  private readonly lookups = new Set<string>();
  private readonly sentAt: number[] = [];
  private readonly sent: Record<string, number> = {};
  private nextSlot = 0;
  private writes = 0;
  private route: string | null = null;

  constructor(
    private readonly limit = maxJiraWrites,
    private readonly paceMs = 0,
    /** Writes kept for cleanup: a journey write that would leave fewer is refused. */
    private readonly cleanupReserve = jiraCleanupWrites,
  ) {}

  get writeCount() {
    return this.writes;
  }
  /** Fixes the run whose label every search and created issue must carry. */
  bindRun(run: string) {
    if (!runPattern.test(run) || this.run) throw new Error("guard-run");
    this.run = run;
  }
  /** Records an issue an earlier run created, so a cleanup may delete it. */
  recordExisting(id: string, key: string) {
    this.issues.set(id, key);
  }
  /** Allows one read of an issue not yet recorded, so a cleanup can tell whether it is a run's. */
  lookup(key: string) {
    if (!keyPattern.test(key)) throw new Error("guard-lookup");
    this.lookups.add(key);
  }

  private deny(reason: string): never {
    this.denied.push(reason);
    throw new GuardDenied(reason);
  }
  private known(idOrKey: string) {
    return (
      this.issues.has(idOrKey) || [...this.issues.values()].includes(idOrKey)
    );
  }
  private jqlAllowed(jql: unknown) {
    return (
      this.run !== null && typeof jql === "string" && jql === runJql(this.run)
    );
  }

  private spend(route: string) {
    const cleanup = route === "DELETE issue" || route === "PUT remove-ready";
    if (cleanup && !this.cleaning) this.deny("cleanup-only");
    if (this.writes >= this.limit - (cleanup ? 0 : this.cleanupReserve))
      this.deny("write-cap");
    if ((this.sent[route] ?? 0) >= (routeCaps[route] ?? 0))
      this.deny("route-cap");
    this.sent[route] = (this.sent[route] ?? 0) + 1;
    this.writes++;
    this.route = route;
    this.log.push({ route, status: null });
  }

  /** A fetch that reaches Jira only as far as the run's scope allows. */
  fetcher(next: typeof fetch): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      // The product and the harness send a string URL, manual redirects and a JSON string body.
      if (typeof input !== "string") this.deny("request-object");
      const url = new URL(input);
      if (url.origin !== `https://${qualificationSite.host}`)
        this.deny("origin");
      if (!url.pathname.startsWith(`${base}/`)) this.deny("path");
      if (init?.redirect !== "manual") this.deny("redirect");
      if (init?.body !== undefined && typeof init.body !== "string")
        this.deny("body-type");
      const method = init?.method ?? "GET";
      let body: Record<string, unknown> = {};
      try {
        body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : {};
      } catch {
        this.deny("body");
      }
      const path = url.pathname.slice(base.length);
      this.route = null;
      this.check(method, path, url.search, body);
      const route = this.route;
      this.count(method, path);
      this.sentAt.push(Date.now());
      // Reserve the next slot before waiting, so concurrent requests are spaced too.
      const slot = Math.max(Date.now(), this.nextSlot);
      this.nextSlot = slot + this.paceMs;
      if (slot > Date.now())
        await new Promise((r) => setTimeout(r, slot - Date.now()));
      const response = await next(input, init);
      const headers = this.headersOf(response);
      if (Object.keys(headers).length) this.lastRateHeaders = headers;
      if (response.status === 429) {
        await this.noteRateLimit(method, path, response, headers);
        // A request answered 429 was not processed: it may be sent again, though the write stays counted.
        if (route) this.sent[route] = (this.sent[route] ?? 1) - 1;
      }
      const last = this.log.at(-1);
      if (route && last && last.status === null) last.status = response.status;
      if (route === "POST issue" && response.ok) await this.record(response);
      return response;
    }) as typeof fetch;
  }

  private shape(method: string, path: string) {
    return `${method} ${path.replace(/^\/issue\/[^/]+/, "/issue/:id")}`;
  }
  private count(method: string, path: string) {
    const key = this.shape(method, path);
    this.counts[key] = (this.counts[key] ?? 0) + 1;
  }
  private headersOf(response: Response) {
    return Object.fromEntries(
      [...response.headers.entries()].filter(([name]) => rateHeader.test(name)),
    );
  }
  private async noteRateLimit(
    method: string,
    path: string,
    response: Response,
    headers: Record<string, string>,
  ) {
    const now = Date.now();
    this.rateLimited.push({
      route: this.shape(method, path),
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

  private check(
    method: string,
    path: string,
    search: string,
    body: Record<string, unknown>,
  ) {
    const only = (allowed: readonly string[], value: object = body) =>
      Object.keys(value).every((k) => allowed.includes(k));
    if (
      method === "GET" &&
      (path === "/myself" || path === "/project/10001/statuses")
    ) {
      if (search) this.deny("query");
      return;
    }
    if (method === "POST" && path === "/search/jql") {
      if (
        search ||
        !this.jqlAllowed(body.jql) ||
        !only(["jql", "fields", "maxResults", "nextPageToken"])
      )
        this.deny("search");
      return;
    }
    if (method === "POST" && path === "/jql/parse") {
      const queries = body.queries;
      if (
        search !== "?validation=strict" ||
        !Array.isArray(queries) ||
        !queries.every((q) => this.jqlAllowed(q)) ||
        !only(["queries"])
      )
        this.deny("search");
      return;
    }
    if (method === "POST" && path === "/comment/list") {
      if (
        search !== "?expand=properties" ||
        !only(["ids"]) ||
        !Array.isArray(body.ids)
      )
        this.deny("comment-list");
      return;
    }
    const issue = issueRoute.exec(path);
    if (method === "GET" && issue) {
      const [, id = "", part] = issue;
      // Only a cleanup deciding whether an issue is a run's reads one it has not recorded.
      const lookup = !part && this.lookups.has(id);
      if (!this.known(id) && !lookup) this.deny("read");
      return;
    }
    if (method === "POST" && path === "/issue") {
      const fields = body.fields as Record<string, unknown> | undefined;
      const labels = fields?.labels;
      if (
        search ||
        !only(["fields"]) ||
        !fields ||
        !only(
          [
            "project",
            "issuetype",
            "summary",
            "labels",
            "customfield_10045",
            "description",
          ],
          fields,
        ) ||
        (fields.project as { id?: unknown } | undefined)?.id !==
          qualificationSite.projectId ||
        !this.run ||
        !Array.isArray(labels) ||
        !labels.includes(runLabel(this.run)) ||
        !(
          fields.summary === summaryOf(this.run, "a") ||
          fields.summary === summaryOf(this.run, "blocker")
        )
      )
        this.deny("issue-create");
      return this.spend("POST issue");
    }
    if (method === "POST" && path === "/issueLink") {
      const key = (side: unknown) =>
        (side as { key?: unknown } | undefined)?.key;
      if (
        search ||
        !only(["type", "inwardIssue", "outwardIssue"]) ||
        (body.type as { name?: unknown } | undefined)?.name !== "Blocks" ||
        !this.known(String(key(body.inwardIssue))) ||
        !this.known(String(key(body.outwardIssue)))
      )
        this.deny("issue-link");
      return this.spend("POST issueLink");
    }
    if (issue) {
      const [, id = "", part] = issue;
      if (search || !this.known(id)) this.deny("write-scope");
      if (method === "POST" && part === "transitions") {
        const transition = body.transition as { id?: unknown } | undefined;
        if (!only(["transition"]) || typeof transition?.id !== "string")
          this.deny("transition");
        return this.spend("POST transition");
      }
      if (method === "POST" && part === "comment") {
        if (!only(["body", "properties"])) this.deny("comment");
        return this.spend("POST comment");
      }
      if (method === "PUT" && !part) {
        const update = body.update as { labels?: unknown } | undefined;
        const edits = update?.labels;
        if (
          !only(["update"]) ||
          !update ||
          !only(["labels"], update) ||
          !Array.isArray(edits) ||
          edits.length !== 1
        )
          this.deny("labels");
        const [edit] = edits as Array<{ add?: unknown; remove?: unknown }>;
        if (
          typeof edit?.add === "string" &&
          Object.keys(edit).length === 1 &&
          this.run &&
          edit.add.startsWith(runLabel(this.run))
        )
          return this.spend("PUT labels");
        if (edit?.remove === "cab-ready" && Object.keys(edit).length === 1)
          return this.spend("PUT remove-ready");
        this.deny("labels");
      }
      if (method === "DELETE" && !part) return this.spend("DELETE issue");
    }
    this.deny("write");
  }

  /** Remembers an issue this run created, from the response to its creation. */
  private async record(response: Response) {
    const value = (await response.clone().json()) as {
      id?: unknown;
      key?: unknown;
    };
    if (
      typeof value.id === "string" &&
      /^\d{1,20}$/.test(value.id) &&
      typeof value.key === "string" &&
      keyPattern.test(value.key)
    )
      this.issues.set(value.id, value.key);
  }
}

const refusal = (what: string) =>
  new Error(`Refusing execution: require ${what}`);
const missing = (env: NodeJS.ProcessEnv) =>
  liveVariables.some((name) => !env[name]) ||
  env.CAB_JIRA_SITE !== `https://${qualificationSite.host}`;

/**
 * Whether a command line and environment may start the live run: `--live`, optionally `--result` with an
 * absolute path, nothing else; the four fixture variables set (the site exactly the fixture's); and none
 * of the variables that make `glab` use a token. Any other state refuses before a credential is read.
 */
export function liveInvocation(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { resultPath: string | undefined } {
  const at = args.indexOf("--result");
  const resultPath = at < 0 ? undefined : args[at + 1];
  if (
    !args.includes("--live") ||
    args.length !== (at < 0 ? 1 : 3) ||
    (at >= 0 && !isAbsolute(resultPath ?? "")) ||
    glabTokenVariables.some((name) => env[name]) ||
    missing(env)
  )
    throw refusal(
      `--live [--result ABSOLUTE_PATH], ${liveVariables.join(", ")} set (CAB_JIRA_SITE https://${qualificationSite.host}), and none of GITLAB_TOKEN, GITLAB_ACCESS_TOKEN or OAUTH_TOKEN`,
    );
  return { resultPath };
}

/**
 * Whether a command line and environment may start a cleanup of an earlier run: `--live`, one of `--run`
 * (a run id, which also cleans up its GitLab merge request) or `--issue` (one Jira issue key), optionally
 * `--result` with an absolute path, and the four fixture variables.
 */
export function cleanupInvocation(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { run?: string; issue?: string; resultPath?: string } {
  const value = (flag: string) => {
    const at = args.indexOf(flag);
    return at < 0 ? undefined : args[at + 1];
  };
  const run = value("--run"),
    issue = value("--issue"),
    resultPath = value("--result");
  const flags = [run, issue, resultPath].filter((v) => v !== undefined).length;
  if (
    !args.includes("--live") ||
    args.length !== 1 + 2 * flags ||
    (run === undefined) === (issue === undefined) ||
    (run !== undefined && !runPattern.test(run)) ||
    (issue !== undefined && !keyPattern.test(issue)) ||
    (resultPath !== undefined && !isAbsolute(resultPath)) ||
    glabTokenVariables.some((name) => env[name]) ||
    missing(env)
  )
    throw refusal(
      `--live and one of --run RUN_ID or --issue ${qualificationSite.projectKey}-N, optionally --result ABSOLUTE_PATH, with ${liveVariables.join(", ")} set`,
    );
  return {
    ...(run === undefined ? {} : { run }),
    ...(issue === undefined ? {} : { issue }),
    ...(resultPath === undefined ? {} : { resultPath }),
  };
}
