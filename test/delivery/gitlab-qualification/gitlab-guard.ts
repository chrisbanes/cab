/** The only GitLab project a qualification run may write to, and the only host it may reach. */
export const qualificationProject = {
  host: "gitlab.com",
  id: "88319115",
  path: "banes3/Banes-project",
  defaultBranch: "main",
} as const;
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
  private writes = 0;
  private merges = 0;
  private setupDiscussions = 0;
  private setupCommits = 0;
  /** Merge requests whose merge the guard may let through, each once. */
  private readonly mergeable = new Set<number>();
  constructor(private readonly limit = maxWrites) {}

  get writeCount() {
    return this.writes;
  }
  get mergeCount() {
    return this.merges;
  }
  /** Allows the one merge of this merge request. */
  allowMerge(iid: number) {
    this.mergeable.add(iid);
  }

  private spend(route: string) {
    if (this.writes >= this.limit) throw new GuardDenied("write-cap");
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
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      const method = init?.method ?? "GET";
      if (url.origin !== `https://${qualificationProject.host}`)
        throw new GuardDenied("origin");
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      if (method === "GET") this.readAllowed(url);
      else this.writeAllowed(method, url, body);
      const response = await next(input, init);
      if (method !== "GET") {
        this.done(response.status);
        await this.record(method, url, response);
      }
      return response;
    }) as typeof fetch;
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
    throw new GuardDenied("read");
  }

  private writeAllowed(
    method: string,
    url: URL,
    body: Record<string, unknown>,
  ) {
    // Auto-merge can never be asked for, by any request.
    const text = JSON.stringify(body);
    if (/merge_when_pipeline_succeeds|"auto_merge":true/.test(text))
      throw new GuardDenied("auto-merge");
    const path = url.pathname;
    if (method === "POST" && path === "/api/graphql") {
      const variables = body.variables as Record<string, unknown> | undefined;
      if (
        typeof body.query !== "string" ||
        !readyDocument.test(body.query) ||
        variables?.projectPath !== qualificationProject.path ||
        !this.knownIid(variables?.iid)
      )
        throw new GuardDenied("graphql");
      this.spend("POST graphql ready");
      return;
    }
    if (!path.startsWith(`${project}/`)) throw new GuardDenied("write-scope");
    const rest = path.slice(project.length);
    const mr = rest.match(new RegExp(`^/merge_requests/${iidPattern}(/.*)?$`));
    const iid = mr ? Number(mr[1]) : null;
    const known = iid !== null && this.requests.has(iid);
    if (method === "POST" && rest === "/merge_requests") {
      if (
        !this.branches.has(String(body.source_branch)) ||
        body.target_branch !== qualificationProject.defaultBranch
      )
        throw new GuardDenied("merge-request-create");
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
        throw new GuardDenied("merge-request-edit");
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
        throw new GuardDenied("merge");
      this.merges++;
      return this.spend("PUT merge");
    }
    if (method === "POST" && mr?.[2] === "/discussions") {
      if (
        !known ||
        this.setupDiscussions > 0 ||
        Object.keys(body).join() !== "body"
      )
        throw new GuardDenied("discussion");
      this.setupDiscussions++;
      return this.spend("POST discussion");
    }
    if (
      method === "POST" &&
      mr?.[2]?.match(/^\/discussions\/[0-9a-f]+\/notes$/)
    ) {
      if (!known || Object.keys(body).join() !== "body")
        throw new GuardDenied("reply");
      return this.spend("POST reply");
    }
    if (method === "PUT" && mr?.[2]?.match(/^\/discussions\/[0-9a-f]+$/)) {
      if (!known || url.search !== "?resolved=true")
        throw new GuardDenied("resolve");
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
        throw new GuardDenied("commit");
      this.setupCommits++;
      return this.spend("POST commit");
    }
    const branch = rest.match(/^\/repository\/branches\/(.+)$/);
    if (method === "DELETE" && branch) {
      if (!this.branches.has(decodeURIComponent(branch[1] ?? "")))
        throw new GuardDenied("branch-delete");
      return this.spend("DELETE branch");
    }
    throw new GuardDenied("write");
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
      throw new GuardDenied("git-scope");
  }
  /** A push to the task's branch; the branch becomes one this run may delete. */
  guardPush<
    T extends { host: string; nameWithOwner: string; branch: string },
    R,
  >(next: (request: T) => Promise<R>) {
    return async (request: T) => {
      this.verified(request);
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
      if (!this.branches.has(request.branch))
        throw new GuardDenied("git-fetch");
      return next(request);
    };
  }
}
