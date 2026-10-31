import { isAbsolute } from "node:path";
import { glabTokenVariables } from "../../../src/standalone/glab-credential.js";

/** The only GitLab project a qualification run may write to, and the only host it may reach. */
export const qualificationProject = {
  host: "gitlab.com",
  id: "88319115",
  path: "banes3/Banes-project",
  defaultBranch: "main",
} as const;
/** The least time between two requests of a live run, so it stays far below GitLab's per-minute limits. */
export const livePaceMs = 300;
/** Provider writes (API writes and Git pushes) one run may make. */
export const maxWrites = 16;

const project = `/api/v4/projects/${qualificationProject.id}`;
const iidPattern = "([1-9][0-9]{0,8})";
/** The one GraphQL document the product sends to make a draft merge request ready. */
const readyDocument =
  /^mutation\(\$projectPath: ID!, \$iid: String!\) \{ mergeRequestSetDraft\(input: \{ projectPath: \$projectPath, iid: \$iid, draft: false \}\) \{ errors \} \}$/;
const sha = /^[0-9a-f]{40}$/;

export class GuardDenied extends Error {
  constructor(readonly reason: string) {
    super(`guard-denied:${reason}`);
  }
}

interface Created {
  id: number;
  iid: number;
}

/**
 * Enforces the run's fixed scope on every request, Git push and fetch the product makes: only
 * https://gitlab.com, only project 88319115, reads under it plus the account and token probes, and
 * writes only to the branches and merge requests this run recorded, with one setup discussion, one setup
 * commit and one merge, at most `maxWrites` in all. Nothing is logged but the method, the route shape and
 * the status; never a header, a body or a token.
 */
export class GitLabGuard {
  readonly branches = new Set<string>();
  readonly requests = new Map<number, Created>();
  readonly log: Array<{ route: string; status: number | null }> = [];
  /** Every request, push or fetch the guard refused; a clean run has none. */
  readonly denied: string[] = [];
  /** Requests sent, by method and route shape, so a rate limit can be traced to what caused it. */
  readonly counts: Record<string, number> = {};
  /** Each 429 GitLab answered: the rate-limit headers it carried (names, and the wait it named) and its text. */
  readonly rateLimited: Array<{
    route: string;
    headers: string[];
    retryAfter: string | null;
    body: string;
  }> = [];
  private nextSlot = 0;
  /** The one-shot write the request being checked would spend, released if GitLab answers 429. */
  private oneShot: "merge" | "discussion" | "commit" | null = null;
  private writes = 0;
  private merges = 0;
  private setupDiscussions = 0;
  private setupCommits = 0;
  /** Merge requests whose merge the guard may let through, each once. */
  private readonly mergeable = new Set<number>();
  /** `paceMs` is the least time between two requests, so the run's own rate stays well below GitLab's limits. */
  constructor(
    private readonly limit = maxWrites,
    private readonly paceMs = 0,
  ) {}

  get writeCount() {
    return this.writes;
  }
  get mergeCount() {
    return this.merges;
  }
  /** Records a merge request and branch an earlier run created, so a cleanup may close and delete them. */
  recordExisting(iid: number, id: number, branch: string) {
    this.requests.set(iid, { id, iid });
    this.branches.add(branch);
  }
  /** Allows the one merge of this merge request. */
  allowMerge(iid: number) {
    this.mergeable.add(iid);
  }

  private deny(reason: string): never {
    this.denied.push(reason);
    throw new GuardDenied(reason);
  }
  /** Whether a merge was sent and no definitive refusal proved it had no effect. */
  mergeMayBePending() {
    const sent = this.log.filter((e) => e.route === "PUT merge").at(-1);
    return (
      sent !== undefined &&
      !(
        sent.status !== null &&
        [400, 401, 403, 404, 405, 409, 422, 429].includes(sent.status)
      )
    );
  }

  private spend(route: string) {
    if (this.writes >= this.limit) this.deny("write-cap");
    this.writes++;
    this.log.push({ route, status: null });
  }
  private done(status: number) {
    const last = this.log.at(-1);
    if (last && last.status === null) last.status = status;
  }

  /** A fetch that reaches GitLab only as far as the run's scope allows. */
  fetcher(next: typeof fetch): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      // The product sends a string URL, an explicit method and a JSON string body; nothing else is understood.
      if (input instanceof Request) this.deny("request-object");
      const url = new URL(input);
      const method = init?.method ?? "GET";
      if (url.origin !== `https://${qualificationProject.host}`)
        this.deny("origin");
      if (init?.body !== undefined && typeof init.body !== "string")
        this.deny("body-type");
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      this.oneShot = null;
      if (method === "GET") this.readAllowed(url);
      else this.writeAllowed(method, url, body);
      const oneShot = this.oneShot;
      this.count(method, url);
      // Reserve the next slot before waiting, so concurrent requests are spaced too.
      const slot = Math.max(Date.now(), this.nextSlot);
      this.nextSlot = slot + this.paceMs;
      if (slot > Date.now())
        await new Promise((r) => setTimeout(r, slot - Date.now()));
      const response = await next(input, init);
      if (response.status === 429) {
        await this.noteRateLimit(method, url, response);
        // A request answered 429 was not processed: it may be sent again, though the write stays counted.
        if (oneShot === "merge") this.merges--;
        if (oneShot === "discussion") this.setupDiscussions--;
        if (oneShot === "commit") this.setupCommits--;
      }
      if (method !== "GET") {
        this.done(response.status);
        await this.record(method, url, response);
      }
      return response;
    }) as typeof fetch;
  }

  /** The route with identifiers removed: `GET /projects/:n/merge_requests/:n/discussions`. */
  private shape(method: string, url: URL) {
    return `${method} ${url.pathname
      .replace(/\/[0-9]+(?=\/|$)/g, "/:n")
      .replace(/(?<=\/branches\/).+$/, ":branch")
      .replace(/(?<=\/discussions\/)[0-9a-f]+/, ":id")}`;
  }
  private count(method: string, url: URL) {
    const key = this.shape(method, url);
    this.counts[key] = (this.counts[key] ?? 0) + 1;
  }
  private async noteRateLimit(method: string, url: URL, response: Response) {
    const headers = [...response.headers.keys()].filter((name) =>
      /^(ratelimit|retry-after)/.test(name),
    );
    this.rateLimited.push({
      route: this.shape(method, url),
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

  private readAllowed(url: URL) {
    const path = url.pathname;
    if (
      path === "/api/v4/user" ||
      path === "/api/v4/version" ||
      path === "/api/v4/projects" ||
      path === "/api/v4/personal_access_tokens/self" ||
      path === "/oauth/token/info" ||
      path === project ||
      path.startsWith(`${project}/`)
    )
      return;
    this.deny("read");
  }

  private writeAllowed(
    method: string,
    url: URL,
    body: Record<string, unknown>,
  ) {
    // Auto-merge can never be asked for, by any request.
    const text = JSON.stringify(body);
    if (/merge_when_pipeline_succeeds|"auto_merge":true/.test(text))
      this.deny("auto-merge");
    const path = url.pathname;
    if (url.search && url.search !== "?resolved=true") this.deny("query");
    if (method === "POST" && path === "/api/graphql") {
      const variables = body.variables as Record<string, unknown> | undefined;
      if (
        typeof body.query !== "string" ||
        !readyDocument.test(body.query) ||
        variables?.projectPath !== qualificationProject.path ||
        !this.knownIid(variables?.iid)
      )
        this.deny("graphql");
      this.spend("POST graphql ready");
      return;
    }
    if (!path.startsWith(`${project}/`)) this.deny("write-scope");
    const rest = path.slice(project.length);
    const mr = rest.match(new RegExp(`^/merge_requests/${iidPattern}(/.*)?$`));
    const iid = mr ? Number(mr[1]) : null;
    const known = iid !== null && this.requests.has(iid);
    if (method === "POST" && rest === "/merge_requests") {
      if (
        !this.branches.has(String(body.source_branch)) ||
        body.target_branch !== qualificationProject.defaultBranch
      )
        this.deny("merge-request-create");
      return this.spend("POST merge_requests");
    }
    if (method === "PUT" && mr && !mr[2]) {
      const keys = Object.keys(body);
      if (
        !known ||
        keys.some(
          (k) => !["title", "description", "state_event"].includes(k),
        ) ||
        (body.state_event !== undefined && body.state_event !== "close")
      )
        this.deny("merge-request-edit");
      return this.spend("PUT merge_request");
    }
    if (method === "PUT" && mr?.[2] === "/merge") {
      if (
        !known ||
        iid === null ||
        !this.mergeable.has(iid) ||
        this.merges > 0 ||
        !sha.test(String(body.sha)) ||
        body.auto_merge !== false ||
        Object.keys(body).some(
          (k) => !["sha", "squash", "auto_merge"].includes(k),
        )
      )
        this.deny("merge");
      this.spend("PUT merge");
      this.merges++;
      this.oneShot = "merge";
      return;
    }
    if (method === "POST" && mr?.[2] === "/discussions") {
      if (
        !known ||
        this.setupDiscussions > 0 ||
        Object.keys(body).join() !== "body"
      )
        this.deny("discussion");
      this.spend("POST discussion");
      this.setupDiscussions++;
      this.oneShot = "discussion";
      return;
    }
    if (
      method === "POST" &&
      mr?.[2]?.match(/^\/discussions\/[0-9a-f]+\/notes$/)
    ) {
      if (!known || Object.keys(body).join() !== "body") this.deny("reply");
      return this.spend("POST reply");
    }
    if (method === "PUT" && mr?.[2]?.match(/^\/discussions\/[0-9a-f]+$/)) {
      if (!known || url.search !== "?resolved=true") this.deny("resolve");
      return this.spend("PUT resolve");
    }
    if (method === "POST" && rest === "/repository/commits") {
      const actions = body.actions as
        | Array<Record<string, unknown>>
        | undefined;
      if (
        this.setupCommits > 0 ||
        !this.branches.has(String(body.branch)) ||
        actions?.length !== 1 ||
        actions[0]?.action !== "create" ||
        !String(actions[0]?.file_path).startsWith("qual/")
      )
        this.deny("commit");
      this.spend("POST commit");
      this.setupCommits++;
      this.oneShot = "commit";
      return;
    }
    const branch = rest.match(/^\/repository\/branches\/(.+)$/);
    if (method === "DELETE" && branch) {
      if (!this.branches.has(decodeURIComponent(branch[1] ?? "")))
        this.deny("branch-delete");
      return this.spend("DELETE branch");
    }
    this.deny("write");
  }

  private knownIid(value: unknown) {
    return (
      typeof value === "string" &&
      /^[1-9][0-9]{0,8}$/.test(value) &&
      this.requests.has(Number(value))
    );
  }

  /** Remembers a merge request this run created, from the response to its creation. */
  private async record(method: string, url: URL, response: Response) {
    if (
      method !== "POST" ||
      url.pathname !== `${project}/merge_requests` ||
      !response.ok
    )
      return;
    const value = (await response.clone().json()) as Partial<Created>;
    if (Number.isInteger(value.iid) && Number.isInteger(value.id))
      this.requests.set(Number(value.iid), {
        id: Number(value.id),
        iid: Number(value.iid),
      });
  }

  private verified(request: { host: string; nameWithOwner: string }) {
    if (
      request.host !== qualificationProject.host ||
      request.nameWithOwner !== qualificationProject.path
    )
      this.deny("git-scope");
  }
  /** A push to the task's branch; the branch becomes one this run may delete. */
  guardPush<
    T extends { host: string; nameWithOwner: string; branch: string },
    R,
  >(next: (request: T) => Promise<R>) {
    return async (request: T) => {
      this.verified(request);
      // Only a task branch (`cab/` prefix), never the default branch.
      if (!request.branch.startsWith("cab/")) this.deny("git-branch");
      this.spend("git push");
      this.branches.add(request.branch);
      return next(request);
    };
  }
  /** A fetch of a branch this run pushed. */
  guardAdopt<
    T extends { host: string; nameWithOwner: string; branch: string },
    R,
  >(next: (request: T) => Promise<R>) {
    return async (request: T) => {
      this.verified(request);
      if (!this.branches.has(request.branch)) this.deny("git-fetch");
      return next(request);
    };
  }
}

/**
 * Whether a command line and environment may start the live run: `--live`, optionally `--result` with an
 * absolute path, nothing else; the fixture credential set; and none of the variables that make `glab` use
 * a token instead of its own login. Any other state refuses before a credential is read or a request is made.
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
    !env.CAB_GITLAB_TOKEN
  )
    throw new Error(
      "Refusing execution: require --live [--result ABSOLUTE_PATH], CAB_GITLAB_TOKEN set, and none of GITLAB_TOKEN, GITLAB_ACCESS_TOKEN or OAUTH_TOKEN",
    );
  return { resultPath };
}

/**
 * Whether a command line and environment may start a cleanup of an earlier run: `--live`, one of `--run`
 * (a run id) or `--mr` (a merge request IID), optionally `--result` with an absolute path, and the fixture
 * credential set.
 */
export function cleanupInvocation(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { run?: string; mr?: number; resultPath?: string } {
  const value = (flag: string) => {
    const at = args.indexOf(flag);
    return at < 0 ? undefined : args[at + 1];
  };
  const run = value("--run"),
    mr = value("--mr"),
    resultPath = value("--result");
  const flags = [run, mr, resultPath].filter((v) => v !== undefined).length;
  if (
    !args.includes("--live") ||
    args.length !== 1 + 2 * flags ||
    (run === undefined) === (mr === undefined) ||
    (run !== undefined && !/^\d{14}-[0-9a-f]{4}$/.test(run)) ||
    (mr !== undefined && !/^[1-9][0-9]{0,8}$/.test(mr)) ||
    (resultPath !== undefined && !isAbsolute(resultPath)) ||
    !env.CAB_GITLAB_TOKEN
  )
    throw new Error(
      "Refusing execution: require --live and one of --run RUN_ID or --mr IID, optionally --result ABSOLUTE_PATH, with CAB_GITLAB_TOKEN set",
    );
  return {
    ...(run === undefined ? {} : { run }),
    ...(mr === undefined ? {} : { mr: Number(mr) }),
    ...(resultPath === undefined ? {} : { resultPath }),
  };
}
