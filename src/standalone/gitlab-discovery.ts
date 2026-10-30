import { z } from "zod";
import { isGitLabProjectPath } from "../core/github-source.js";
import {
  gitLabHostSchema,
  gitLabRepositoryId,
} from "../core/repository-links.js";

export type GitLabFailureReason =
  | "unauthorized"
  | "forbidden"
  | "rate-limited"
  | "unreachable"
  | "unreadable";
/** A failed GitLab read. The message is the reason code only, never a token or URL. */
export class GitLabDiscoveryFailure extends Error {
  constructor(readonly reason: GitLabFailureReason) {
    super(reason);
    this.name = "GitLabDiscoveryFailure";
  }
}

const maxPages = 10;
const userSchema = z.object({ username: z.string().min(1).max(255) });
// Items are validated one by one, so a single odd project is skipped, not the whole page.
const projectPage = z.array(z.unknown()).max(100);
const projectItem = z.object({
  id: z.number().int().positive(),
  path_with_namespace: z.string().refine(isGitLabProjectPath),
  default_branch: z.string().min(1).max(255),
});

/** Read-only GitLab account and project reads for one host. Nothing it returns is stored. */
export class GitLabDiscoveryReader {
  private readonly api: string;

  constructor(
    host: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const parsed = gitLabHostSchema.safeParse(host);
    // A token fetch would reject as a header value is unreadable, not an unreachable host.
    if (!parsed.success || !/^[\x21-\x7e]{1,4096}$/.test(token))
      throw new GitLabDiscoveryFailure("unreadable");
    this.api = `https://${parsed.data}/api/v4`;
  }

  private async get<T>(
    path: string,
    schema: z.ZodType<T>,
  ): Promise<{ value: T; next: string | null }> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.api}${path}`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        // Bearer takes OAuth tokens (a glab login) as well as personal access tokens.
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
        },
      });
    } catch {
      // A network error or the timeout; never the error text, which may carry the URL.
      throw new GitLabDiscoveryFailure("unreachable");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new GitLabDiscoveryFailure(
        response.status === 401
          ? "unauthorized"
          : response.status === 403
            ? "forbidden"
            : response.status === 429
              ? "rate-limited"
              : "unreadable",
      );
    }
    // A redirect could carry the token to another origin.
    if (response.redirected) throw new GitLabDiscoveryFailure("unreadable");
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GitLabDiscoveryFailure("unreadable");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new GitLabDiscoveryFailure("unreadable");
    return {
      value: parsed.data,
      next: response.headers.get("x-next-page") || null,
    };
  }

  /** The account the token acts as. */
  async user(): Promise<{ username: string }> {
    return { username: (await this.get("/user", userSchema)).value.username };
  }

  /** Non-archived member projects with a default branch, by path, up to ten pages of 100. */
  async projects(): Promise<{
    projects: {
      repositoryId: string;
      projectPath: string;
      defaultBranch: string;
    }[];
    truncated: boolean;
  }> {
    const projects = [];
    let page: string | null = "1";
    for (let read = 0; page; read++) {
      if (read === maxPages) return { projects, truncated: true };
      if (!/^[1-9][0-9]{0,5}$/.test(page))
        throw new GitLabDiscoveryFailure("unreadable");
      const result: {
        value: z.infer<typeof projectPage>;
        next: string | null;
      } = await this.get(
        `/projects?membership=true&simple=true&archived=false&order_by=path&sort=asc&per_page=100&page=${page}`,
        projectPage,
      );
      for (const item of result.value) {
        // A project with no default branch (empty repository) can't be linked.
        const p = projectItem.safeParse(item);
        const repositoryId = gitLabRepositoryId.safeParse(String(p.data?.id));
        if (!p.success || !repositoryId.success) continue;
        projects.push({
          repositoryId: repositoryId.data,
          projectPath: p.data.path_with_namespace,
          defaultBranch: p.data.default_branch,
        });
      }
      page = result.next;
    }
    return { projects, truncated: false };
  }
}
