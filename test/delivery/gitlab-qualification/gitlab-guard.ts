import { isAbsolute } from "node:path";
import { glabTokenVariables } from "../../../src/standalone/glab-credential.js";
import {
  GuardDenied,
  GuardMechanics,
  rateHeaders,
  type RateLimitEvidence,
} from "../qualification-guard-mechanics.js";

export { GuardDenied };

/** The only GitLab project a qualification run may write to, and the only host it may reach. */
export const qualificationProject = {
  host: "gitlab.com",
  id: "88319115",
  path: "banes3/Banes-project",
  defaultBranch: "main",
} as const;
/** The writes cleanup needs at most: close both merge requests and delete both branches. */
export const cleanupWrites = 4;
/** The least time between two requests of a live run, so it stays far below GitLab's per-minute limits. */
export const livePaceMs = 750;
/** Provider writes (API writes and Git pushes) one run may make. */
export const maxWrites = 16;
/** The stack journey's tasks: three pushes and three merge requests. */
const stackLayers = 3;

const project = `/api/v4/projects/${qualificationProject.id}`;
const iidPattern = "([1-9][0-9]{0,8})";
/** The one GraphQL document the product sends to make a draft merge request ready. */
const readyDocument =
  /^mutation\(\$projectPath: ID!, \$iid: String!\) \{ mergeRequestSetDraft\(input: \{ projectPath: \$projectPath, iid: \$iid, draft: false \}\) \{ errors \} \}$/;
const sha = /^[0-9a-f]{40}$/;

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
 *
 * The `stack` mode is the stacking journey's scope instead: three pushes and three merge requests, each
 * on `main` or a branch of the run; one merge of each allowed merge request, with the source-branch
 * removal flag exactly when allowed; one retarget of an allowed merge request to `main`; and cleanup.
 * It permits no discussion, commit or ready request. Merge bodies are kept, as they carry no credential.
 */
export class GitLabGuard {
  readonly branches = new Set<string>();
  readonly requests = new Map<number, Created>();
  readonly log: GuardMechanics["log"];
  /** Every request, push or fetch the guard refused; a clean run has none. */
  readonly denied: string[];
  /** Requests sent, by method and route shape, so a rate limit can be traced to what caused it. */
  readonly counts: Record<string, number>;
  /** Each 429 GitLab answered: the rate-limit headers it carried (name and value: the limit's name, its quota, what was observed and when it resets, and the wait it named) and its text. */
  readonly rateLimited: RateLimitEvidence[];
  private readonly mechanics: GuardMechanics;
  /** Gives back the one-shot write the request being checked spent, if GitLab answers 429. */
  private undo: (() => void) | null = null;
  private merges = 0;
  private setupDiscussions = 0;
  private setupCommits = 0;
  private stackCreates = 0;
  private stackPushes = 0;
  /** Merge requests whose merge the guard may let through, each once, and whether it removes the source branch. */
  private readonly mergeable = new Map<
    number,
    { removeSourceBranch: boolean }
  >();
  /** Merge requests the stack journey may retarget to `main`, each once. */
  private readonly retargetable = new Set<number>();
  /** The body of every merge the guard let through. */
  readonly mergeBodies: Array<{ iid: number; body: Record<string, unknown> }> =
    [];
  /** `paceMs` is the least time between two requests, so the run's own rate stays well below GitLab's limits. */
  constructor(
    limit = maxWrites,
    paceMs = 0,
    /** Writes kept for cleanup: a journey write that would leave fewer is refused, so retries cannot starve it. */
    cleanupReserve = cleanupWrites,
    readonly mode: "delivery" | "stack" = "delivery",
  ) {
    this.mechanics = new GuardMechanics(limit, paceMs, cleanupReserve);
    this.log = this.mechanics.log;
    this.denied = this.mechanics.denied;
    this.counts = this.mechanics.counts;
    this.rateLimited = this.mechanics.rateLimited;
  }

  get writeCount() {
    return this.mechanics.writeCount;
  }
  get mergeCount() {
    return this.merges;
  }
  /** Records a merge request and branch an earlier run created, so a cleanup may close and delete them. */
  recordExisting(iid: number, id: number, branch: string) {
    this.requests.set(iid, { id, iid });
    this.branches.add(branch);
  }
  /** Allows the one merge of this merge request; in stack mode, with removal of its source branch or without. */
  allowMerge(iid: number, removeSourceBranch = false) {
    this.mergeable.set(iid, { removeSourceBranch });
  }
  /** Allows one `target_branch` edit of this merge request, to `main` (stack mode). */
  allowRetarget(iid: number) {
    this.retargetable.add(iid);
  }

  private deny(reason: string): never {
    return this.mechanics.deny(reason);
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
    const cleanup =
      route === "PUT close merge_request" || route === "DELETE branch";
    this.mechanics.spend(route, cleanup);
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
      this.undo = null;
      if (method === "GET") this.readAllowed(url);
      else this.writeAllowed(method, url, body);
      // Set by the check above; TypeScript cannot see that through the call.
      const undo = this.undo as (() => void) | null;
      await this.mechanics.admit(this.shape(method, url));
      const response = await next(input, init);
      if (response.status === 429) {
        await this.mechanics.noteRateLimit(
          this.shape(method, url),
          response,
          rateHeaders(response, /^(ratelimit|retry-after)/),
        );
        // A request answered 429 was not processed: it may be sent again, though the write stays counted.
        undo?.();
      }
      if (method !== "GET") {
        this.mechanics.settle(response.status);
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
    const stack = this.mode === "stack";
    if (method === "POST" && rest === "/merge_requests") {
      const target = String(body.target_branch);
      if (
        !this.branches.has(String(body.source_branch)) ||
        (target !== qualificationProject.defaultBranch &&
          !(
            stack &&
            this.branches.has(target) &&
            target !== body.source_branch
          )) ||
        (stack && this.stackCreates >= stackLayers)
      )
        this.deny("merge-request-create");
      if (stack) this.stackCreates++;
      return this.spend("POST merge_requests");
    }
    if (method === "PUT" && mr && !mr[2]) {
      const keys = Object.keys(body);
      if (stack && keys.join() === "target_branch") {
        if (
          iid === null ||
          !known ||
          !this.retargetable.has(iid) ||
          body.target_branch !== qualificationProject.defaultBranch
        )
          this.deny("merge-request-retarget");
        this.retargetable.delete(iid);
        this.undo = () => this.retargetable.add(iid);
        return this.spend("PUT retarget merge_request");
      }
      if (
        !known ||
        keys.some(
          (k) =>
            !(
              stack ? ["state_event"] : ["title", "description", "state_event"]
            ).includes(k),
        ) ||
        (body.state_event !== undefined && body.state_event !== "close")
      )
        this.deny("merge-request-edit");
      // Only a plain close is cleanup, so an edit cannot use the writes kept for it.
      return this.spend(
        keys.join() === "state_event"
          ? "PUT close merge_request"
          : "PUT merge_request",
      );
    }
    if (method === "PUT" && mr?.[2] === "/merge") {
      const allowed = iid === null ? undefined : this.mergeable.get(iid);
      const removal = stack && allowed?.removeSourceBranch === true;
      const keys = Object.keys(body);
      if (
        !known ||
        iid === null ||
        !allowed ||
        this.merges >= (stack ? stackLayers - 1 : 1) ||
        !sha.test(String(body.sha)) ||
        body.auto_merge !== false ||
        keys.some(
          (k) =>
            ![
              "sha",
              "squash",
              "auto_merge",
              ...(removal ? ["should_remove_source_branch"] : []),
            ].includes(k),
        ) ||
        (removal && body.should_remove_source_branch !== true)
      )
        this.deny("merge");
      this.spend("PUT merge");
      this.merges++;
      this.mergeable.delete(iid);
      this.mergeBodies.push({ iid, body });
      this.undo = () => {
        this.merges--;
        this.mergeable.set(iid, allowed);
        this.mergeBodies.pop();
      };
      return;
    }
    // The stack journey writes nothing else but cleanup.
    if (
      stack &&
      !(method === "DELETE" && rest.startsWith("/repository/branches/"))
    )
      this.deny("write");
    if (method === "POST" && mr?.[2] === "/discussions") {
      if (
        !known ||
        this.setupDiscussions > 0 ||
        Object.keys(body).join() !== "body"
      )
        this.deny("discussion");
      this.spend("POST discussion");
      this.setupDiscussions++;
      this.undo = () => this.setupDiscussions--;
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
      this.undo = () => this.setupCommits--;
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
      if (this.mode === "stack" && this.stackPushes++ >= stackLayers)
        this.deny("git-push-count");
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
  /** Whether the run needs `CAB_GITLAB_TOKEN`: the stack journey uses the `glab` login alone. */
  envToken = true,
): { resultPath: string | undefined } {
  const at = args.indexOf("--result");
  const resultPath = at < 0 ? undefined : args[at + 1];
  if (
    !args.includes("--live") ||
    args.length !== (at < 0 ? 1 : 3) ||
    (at >= 0 && !isAbsolute(resultPath ?? "")) ||
    glabTokenVariables.some((name) => env[name]) ||
    (envToken && !env.CAB_GITLAB_TOKEN)
  )
    throw new Error(
      `Refusing execution: require --live [--result ABSOLUTE_PATH]${envToken ? ", CAB_GITLAB_TOKEN set," : ""} and none of GITLAB_TOKEN, GITLAB_ACCESS_TOKEN or OAUTH_TOKEN`,
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
