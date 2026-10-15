import { z } from "zod";
import {
  githubApi,
  githubFetch,
  githubRateLimitResumeAt,
  nextPageLink,
} from "./github-http.js";

export type DiscoveryFailureReason =
  | "missing-credential"
  | "unauthorized"
  | "forbidden"
  | "rate-limited"
  | "unreadable"
  | "gh-not-installed"
  | "gh-not-signed-in"
  | "gh-unreadable";
/** A failed discovery read. The message is the reason code only, never a token or URL. */
export class DiscoveryFailure extends Error {
  constructor(readonly reason: DiscoveryFailureReason) {
    super(reason);
    this.name = "DiscoveryFailure";
  }
}
export interface DiscoveredProject {
  projectNodeId: string;
  title: string;
  number: number;
}
export interface DiscoveredProjectField {
  fieldNodeId: string;
  name: string;
  options: { optionNodeId: string; name: string }[];
}
/** Read-only GitHub lists for project setup. Nothing it returns is stored. */
export interface DiscoveryReader {
  repositories(): Promise<{
    repositories: {
      repositoryId: string;
      owner: string;
      name: string;
      defaultBranch: string;
    }[];
    truncated: boolean;
  }>;
  branches(
    owner: string,
    name: string,
  ): Promise<{ branches: string[]; truncated: boolean }>;
  projects(
    owner: string,
    name: string,
  ): Promise<{
    ownerLogin: string;
    linked: DiscoveredProject[];
    owned: DiscoveredProject[];
    truncated: boolean;
  }>;
  projectFields(project: string): Promise<{
    fields: DiscoveredProjectField[];
    truncated: boolean;
  }>;
}

const segment = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);
const repositoryPage = z.array(
  z.object({
    node_id: z.string().min(1).max(512),
    name: segment,
    owner: z.object({ login: segment }),
    default_branch: z.string().min(1).max(255),
  }),
);
const branchPage = z.array(z.object({ name: z.string().min(1).max(255) }));
const projectConnection = z.object({
  nodes: z.array(
    z
      .object({
        id: z.string().min(1).max(512),
        title: z.string().max(512),
        number: z.number().int().positive(),
        closed: z.boolean(),
      })
      .nullable(),
  ),
  pageInfo: z.object({ hasNextPage: z.boolean() }),
});
const projectsResponse = z.object({
  data: z.object({
    repository: z.object({ projectsV2: projectConnection }).nullable(),
    repositoryOwner: z
      .object({
        login: segment,
        projectsV2: projectConnection.optional(),
      })
      .nullable(),
  }),
});
// One fixed read-only query; `owner` and `name` travel only as variables.
const projectsQuery = `query ($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    projectsV2(first: 100) { nodes { id title number closed } pageInfo { hasNextPage } }
  }
  repositoryOwner(login: $owner) {
    login
    ... on ProjectV2Owner {
      projectsV2(first: 100) { nodes { id title number closed } pageInfo { hasNextPage } }
    }
  }
}`;

const singleSelectField = z.object({
  id: z.string().min(1).max(512),
  name: z.string().max(512),
  options: z.array(
    z.object({ id: z.string().min(1).max(512), name: z.string().max(512) }),
  ),
});
const projectFieldsResponse = z.object({
  data: z.object({
    node: z
      .object({
        id: z.string().min(1).max(512).optional(),
        fields: z
          .object({
            nodes: z.array(
              z.object({ __typename: z.string() }).passthrough().nullable(),
            ),
            pageInfo: z.object({ hasNextPage: z.boolean() }),
          })
          .optional(),
      })
      .nullable(),
  }),
});
// One fixed read-only query; `project` travels only as a variable.
const projectFieldsQuery = `query ($project: ID!) {
  node(id: $project) {
    ... on ProjectV2 {
      id
      fields(first: 100) {
        nodes { __typename ... on ProjectV2SingleSelectField { id name options { id name } } }
        pageInfo { hasNextPage }
      }
    }
  }
}`;

const exhausted = (response: Response) =>
  response.headers.get("x-ratelimit-remaining") === "0";

export class GitHubDiscoveryReader implements DiscoveryReader {
  constructor(
    private readonly token: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request(href: string, body?: object): Promise<Response> {
    if (!this.token) throw new DiscoveryFailure("missing-credential");
    let response: Response;
    try {
      response = await githubFetch(
        this.fetcher,
        href,
        {
          method: body ? "POST" : "GET",
          signal: AbortSignal.timeout(15_000),
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: "application/vnd.github+json",
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
        () => new DiscoveryFailure("unreadable"),
      );
    } catch (error) {
      if (error instanceof DiscoveryFailure) throw error;
      throw new DiscoveryFailure("unreadable");
    }
    if (response.ok) return response;
    // Only a 403 body is read, to tell a secondary rate limit from a refusal.
    if (response.status !== 403) await response.body?.cancel().catch(() => {});
    if ((await githubRateLimitResumeAt(response)) !== undefined)
      throw new DiscoveryFailure("rate-limited");
    if (response.status === 401) throw new DiscoveryFailure("unauthorized");
    if (response.status === 403 || response.status === 404)
      throw new DiscoveryFailure("forbidden");
    throw new DiscoveryFailure("unreadable");
  }

  private async json<T>(response: Response, schema: z.ZodType<T>) {
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new DiscoveryFailure("unreadable");
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new DiscoveryFailure("unreadable");
    return parsed.data;
  }

  private async pages<T>(
    first: string,
    schema: z.ZodType<T[]>,
    limit: number,
  ): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let next: string | null = first;
    for (let page = 0; next; page++) {
      if (page === limit) return { items, truncated: true };
      const response = await this.request(next);
      next = nextPageLink(response, () => new DiscoveryFailure("unreadable"));
      items.push(...(await this.json(response, schema)));
    }
    return { items, truncated: false };
  }

  async repositories() {
    const { items, truncated } = await this.pages(
      `${githubApi}/user/repos?per_page=100&sort=full_name&affiliation=owner,collaborator,organization_member`,
      repositoryPage,
      10,
    );
    return {
      repositories: items.map((r) => ({
        repositoryId: r.node_id,
        owner: r.owner.login,
        name: r.name,
        defaultBranch: r.default_branch,
      })),
      truncated,
    };
  }

  async branches(owner: string, name: string) {
    const { items, truncated } = await this.pages(
      `${githubApi}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches?per_page=100`,
      branchPage,
      5,
    );
    return { branches: items.map((b) => b.name), truncated };
  }

  /** POST one fixed GraphQL query; GitHub reports errors and limits as HTTP 200. */
  private async graphql(query: string, variables: object): Promise<unknown> {
    const response = await this.request(`${githubApi}/graphql`, {
      query,
      variables,
    });
    const raw = await this.json(
      response,
      z.object({ errors: z.array(z.unknown()).optional() }).passthrough(),
    );
    if (raw.errors?.length) {
      // GraphQL reports an exhausted limit as HTTP 200 with errors.
      if (
        exhausted(response) ||
        raw.errors.some(
          (e) =>
            typeof e === "object" &&
            e !== null &&
            "type" in e &&
            e.type === "RATE_LIMITED",
        )
      )
        throw new DiscoveryFailure("rate-limited");
      // A token without Projects access answers with GraphQL errors: degrade only this read.
      throw new DiscoveryFailure("forbidden");
    }
    return raw;
  }

  async projects(owner: string, name: string) {
    const raw = await this.graphql(projectsQuery, { owner, name });
    const parsed = projectsResponse.safeParse(raw);
    if (!parsed.success) throw new DiscoveryFailure("unreadable");
    const { repository, repositoryOwner } = parsed.data.data;
    if (!repository || !repositoryOwner)
      throw new DiscoveryFailure("forbidden");
    const open = (c: z.infer<typeof projectConnection> | undefined) =>
      (c?.nodes ?? []).flatMap((n) =>
        n && !n.closed
          ? [{ projectNodeId: n.id, title: n.title, number: n.number }]
          : [],
      );
    const linked = open(repository.projectsV2);
    const linkedIds = new Set(linked.map((p) => p.projectNodeId));
    return {
      ownerLogin: repositoryOwner.login,
      linked,
      owned: open(repositoryOwner.projectsV2).filter(
        (p) => !linkedIds.has(p.projectNodeId),
      ),
      truncated:
        repository.projectsV2.pageInfo.hasNextPage ||
        Boolean(repositoryOwner.projectsV2?.pageInfo.hasNextPage),
    };
  }

  async projectFields(project: string) {
    const parsed = projectFieldsResponse.safeParse(
      await this.graphql(projectFieldsQuery, { project }),
    );
    if (!parsed.success) throw new DiscoveryFailure("unreadable");
    // A null node, or one that is not a ProjectV2, is not readable with this token.
    const { node } = parsed.data.data;
    if (!node?.id || !node.fields) throw new DiscoveryFailure("forbidden");
    const fields: DiscoveredProjectField[] = [];
    for (const n of node.fields.nodes) {
      if (n?.__typename !== "ProjectV2SingleSelectField") continue;
      const field = singleSelectField.safeParse(n);
      if (!field.success) throw new DiscoveryFailure("unreadable");
      fields.push({
        fieldNodeId: field.data.id,
        name: field.data.name,
        options: field.data.options.map((o) => ({
          optionNodeId: o.id,
          name: o.name,
        })),
      });
    }
    return { fields, truncated: node.fields.pageInfo.hasNextPage };
  }
}
