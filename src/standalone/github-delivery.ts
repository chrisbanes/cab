import {
  issueChangedReason,
  projectFieldChangedReason,
} from "../operator/github-reasons.js";
import {
  isOperatorAction,
  isOperatorDeliveryCaller,
  isOperatorPublicationCaller,
} from "../core/delivery.js";
import { hasLabelName } from "../core/github-source-contracts.js";
import { publicationMarker } from "../core/task-publication-contracts.js";
import { DomainPolicyError } from "../core/domain.js";
import { z } from "zod";
import {
  githubApi as api,
  githubFetch,
  githubGraphqlRateLimitResumeAt,
  githubPages,
  githubRateLimitResumeAt,
  nextPageLink,
} from "./github-http.js";
import { type AdoptFunction, adoptOutsideHead } from "./git-fetch.js";
import { type PushOutcome, pushTaskCommit } from "./git-push.js";
import type {
  CodeHostDeliveryProvider,
  RepositoryRequirements,
} from "./code-host.js";
import type { IssueTrackerWriter } from "./issue-tracker.js";
import {
  type BranchRemote,
  type BranchRemotes,
  PublicationRefusal,
  adoptBranchHead,
  branchPreflight,
  inspectBranchHead,
  publishBranch,
} from "./branch-delivery.js";
import {
  actionObservationSchema,
  prObservationSchema,
  repositoryDeliverySettings,
  type DeliveryActionRecord,
  type DeliveryPolicy,
  type ExternalAction,
  type PrDeliveryObservation,
  type ProviderActionObservation,
  type RequiredCheck,
  type StackLinkTarget,
} from "../core/delivery.js";
export type {
  PrDeliveryObservation,
  ProviderActionObservation,
} from "../core/delivery.js";
export interface PrIdentity {
  repositoryId: string;
  prNumber: number;
  expectedPrNodeId: string;
  expectedHeadSha: string;
  /** The delivery's accepted base: a read that finds another base also reports whether the old base's change request merged. */
  recordedBaseRef?: string;
}
/** Fresh provider facts about an issue cab's delivery closed; classification is the caller's. */
export type ClosedIssueInspection =
  | { state: "open" }
  | {
      state: "closed";
      snapshot: import("../core/github-source.js").IssueSnapshot;
      /** GitHub's latest ClosedEvent, or null when it has none. */
      closedEvent: {
        id: string;
        closerKind: "none" | "pull-request" | "other";
        closerPrNodeId: string | null;
      } | null;
    };
/** Offline facts about a push's commit in the task worktree, established before any network call. */
export interface PushVerification {
  workspacePath: string;
  /** Changed or untracked worktree entries; they are never pushed. */
  uncommittedEntries: number;
  /** Whether the commit descends from the last commit cab pushed; null before the first push. */
  descendsFromLastPushed: boolean | null;
}
export interface PublicationContext extends PushVerification {
  /** The task's assigned branch, and the commit cab last pushed to it. */
  branch: string;
  lastPushedSha: string | null;
  /** The approved outside head an overwrite replaces (git's all-zero id for a deleted branch). */
  outsideHeadSha?: string;
  /** A later attempt of an operation whose earlier attempt may have landed late. */
  retry: boolean;
}
/** Offline facts for adopting an outside head: the task's branch, last push, worktree and provisioned base. */
export interface AdoptionContext {
  branch: string;
  lastPushedSha: string | null;
  workspacePath: string;
  baseCommit: string;
}
export type { AdoptFunction } from "./git-fetch.js";
export { PublicationRefusal };
export type PushFunction = (
  request: Parameters<typeof pushTaskCommit>[0],
) => Promise<PushOutcome>;
/** An operator edit whose expected text is no longer what the issue shows on GitHub. */
export class IssueChangedRefusal extends Error {
  readonly reason = issueChangedReason;
  constructor() {
    super(issueChangedReason);
  }
}
/** A Project item whose Status is no longer what the write expected: nothing is written. */
export class ProjectFieldChangedRefusal extends Error {
  readonly reason = projectFieldChangedReason;
  constructor() {
    super(projectFieldChangedReason);
  }
}
/** An issue named to Link a publication: what GitHub shows, and whether it carries the create's marker. */
export interface PublishedIssueInspection {
  nodeId: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  /** Whether the credential user opened it. */
  byCredentialUser: boolean;
  hasMarker: boolean;
}
export const deliveryDocuments = {
  CabDeliveryPr: `query CabDeliveryPr($id:ID!,$after:String){node(id:$id){... on PullRequest{id number repository{id nameWithOwner} baseRefName headRefName headRefOid baseRefOid state isDraft merged mergeable mergeStateStatus reviewDecision isMergeQueueEnabled closingIssuesReferences(first:100){nodes{id state repository{id}} pageInfo{hasNextPage endCursor}} baseRef{target{oid} branchProtectionRule{requiresDeployments requiredDeploymentEnvironments requiresStrictStatusChecks}} reviewThreads(first:100,after:$after){nodes{id isResolved firstComment:comments(first:1){nodes{id}} latestComment:comments(last:1){nodes{id}}} pageInfo{hasNextPage endCursor}}}}}`,
  CabDeliveryRepository: `query CabDeliveryRepository($id:ID!){node(id:$id){... on Repository{id nameWithOwner}}}`,
  CabDeliveryClosure: `query CabDeliveryClosure($id:ID!){node(id:$id){... on Issue{id repository{id} timelineItems(last:1,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{id closer{__typename ... on PullRequest{id}}}}}}}}`,
  CabDeliveryField: `query CabDeliveryField($item:ID!,$field:ID!,$after:String){node(id:$item){... on ProjectV2Item{id project{id} content{... on Issue{id repository{id}}} fieldValues(first:100,after:$after){nodes{__typename ... on ProjectV2ItemFieldSingleSelectValue{optionId field{... on ProjectV2SingleSelectField{id}}}} pageInfo{hasNextPage endCursor}}}} field:node(id:$field){... on ProjectV2SingleSelectField{id options{id} project{id}}}}`,
  CabDeliveryProject: `mutation CabDeliveryProject($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}`,
  CabDeliveryItemAdd: `mutation CabDeliveryItemAdd($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}`,
  CabDeliveryIssueItems: `query CabDeliveryIssueItems($id:ID!,$after:String){node(id:$id){... on Issue{id repository{id} projectItems(first:100,after:$after){nodes{id project{id}} pageInfo{hasNextPage endCursor}}}}}`,
  CabDeliveryThread: `query CabDeliveryThread($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{id isResolved resolvedBy{id} pullRequest{id number repository{id}} latestComment:comments(last:1){nodes{id}} comments(first:100,after:$after){nodes{id body state author{__typename ... on User{id}}} pageInfo{hasNextPage endCursor}}}}}`,
  CabDeliveryThreadReply: `mutation CabDeliveryThreadReply($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{id}}}`,
  CabDeliveryThreadResolve: `mutation CabDeliveryThreadResolve($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}`,
  CabDeliveryReady: `mutation CabDeliveryReady($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft}}}`,
} as const;
const name = z.string().min(1);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const githubStackMembership = z
  .object({
    id: z.number().int().positive(),
    number: z.number().int().positive(),
    position: z.number().int().positive(),
    size: z.number().int().positive(),
    base: z.object({ ref: name, sha }),
  })
  .refine((value) => value.position <= value.size)
  .nullable();
const page = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
const prQuery = deliveryDocuments.CabDeliveryPr;
const hasLabel = (labels: { name: string }[], name: string): boolean =>
  hasLabelName(
    labels.map((v) => v.name),
    name,
  );

const asyncMergeId = z.string().trim().min(1).max(512);
/**
 * `merge-async`'s answer to a merge request and to a poll of it. `details` is one of three shapes: the
 * pending request's (`uuid` and its merge options), a bare `message`, or a `message` with the merge
 * commit `sha`; so only a pending request carries a `uuid`.
 */
const asyncMergeSchema = z.object({
  status: z.enum(["pending", "enqueued", "merged", "failed"]),
  details: z.object({
    uuid: asyncMergeId.optional(),
    message: z.string().optional(),
    sha: z.string().optional(),
  }),
});
/** The body of a 409: the request that is already pending, which the API says it names. */
const asyncMergeConflictSchema = z.object({
  details: z.object({ uuid: asyncMergeId }),
});

class ProviderFailure extends Error {
  constructor(
    readonly status: number,
    /** Set when GitHub rate-limited the request: the epoch-ms time to resume. */
    readonly resumeAt?: number,
    /** A 409's parsed JSON body (a merge-async conflict names the pending request); undefined otherwise. */
    readonly body?: unknown,
  ) {
    super(`provider-http-${status}`);
  }
}

export function mergeGateReasons(g: {
  draft: boolean;
  merged: boolean;
  state: string;
  mergeable: string;
  mergeStateStatus: string;
  queue: boolean;
  reviewDecision: string | null;
  unresolvedThreads: boolean;
  headSha: string;
  baseSha: string;
  strict: boolean;
  deployments: Array<{ environment: string; sha: string; success: boolean }>;
  requiredEnvironments: string[];
  checks: PrDeliveryObservation["checks"];
  /** What the code host requires; with cab's checks, empty means nothing guards the merge. */
  hostChecks: RequiredCheck[];
  cabChecks: RequiredCheck[];
  configuredMethod: string | undefined;
  unsupportedRules: string[];
  allowedMethods: string[];
}): string[] {
  const reasons = [...g.unsupportedRules];
  if (g.state !== "OPEN" || g.merged) reasons.push("pr-not-open");
  if (g.draft) reasons.push("pr-draft");
  if (g.mergeable !== "MERGEABLE") reasons.push("mergeability-unproved");
  if (g.queue) reasons.push("merge-queue-required");
  if (g.strict && g.mergeStateStatus !== "CLEAN")
    reasons.push(
      g.mergeStateStatus === "BEHIND"
        ? "strict-head-behind"
        : "strict-head-current-unproved",
    );
  if (
    g.reviewDecision === "CHANGES_REQUESTED" ||
    g.reviewDecision === "REVIEW_REQUIRED"
  )
    reasons.push("review-not-satisfied");
  if (g.unresolvedThreads) reasons.push("unresolved-review-thread");
  if (!g.hostChecks.length && !g.cabChecks.length)
    reasons.push("no-required-checks");
  for (const check of [...g.hostChecks, ...g.cabChecks])
    if (
      !g.checks.some(
        (c) =>
          c.name === check.name &&
          (check.appId === undefined || c.appId === check.appId) &&
          c.sha === g.headSha &&
          c.status === "success",
      )
    )
      reasons.push(`check-${check.name}-unproved`);
  for (const environment of g.requiredEnvironments)
    if (
      !g.deployments.some(
        (d) =>
          d.environment === environment && d.sha === g.headSha && d.success,
      )
    )
      reasons.push(`deployment-${environment}-unproved`);
  if (!g.allowedMethods.length) reasons.push("merge-method-unavailable");
  if (!g.configuredMethod || !g.allowedMethods.includes(g.configuredMethod))
    reasons.push("merge-method-not-configured");
  return [...new Set(reasons)];
}
/** The observation's record of the checks the gate required, by source. */
export function requiredCheckSources(
  hostChecks: RequiredCheck[],
  cabChecks: RequiredCheck[],
): NonNullable<PrDeliveryObservation["requiredChecks"]> {
  return [
    ...hostChecks.map((c) => ({ ...c, source: "code-host" as const })),
    ...cabChecks.map((c) => ({ ...c, source: "cab" as const })),
  ];
}

/** Narrow GitHub.com transport; every effect is settled by an independent read. */
export class GitHubHttpDeliveryProvider
  implements CodeHostDeliveryProvider, IssueTrackerWriter
{
  constructor(
    credential: string | (() => Promise<string | undefined>),
    private readonly fetcher: typeof fetch = fetch,
    private readonly push: PushFunction = pushTaskCommit,
    private readonly adopt: AdoptFunction = adoptOutsideHead,
    private readonly host = "github.com",
  ) {
    this.resolveCredential =
      typeof credential === "string" ? async () => credential : credential;
  }
  private readonly resolveCredential: () => Promise<string | undefined>;
  private resolved?: Promise<string | undefined>;
  /** Resolved on first use and kept for this instance only; every delivery action builds its own provider. */
  private credential(): Promise<string | undefined> {
    this.resolved ??= this.resolveCredential().catch(() => undefined);
    return this.resolved;
  }
  private async request(
    path: string,
    method = "GET",
    body?: unknown,
    version = "2022-11-28",
  ): Promise<{ json: unknown; response: Response }> {
    const url = new URL(path, api);
    if (url.origin !== api) throw new Error("provider-origin-mismatch");
    const credential = await this.credential();
    if (!credential) throw new Error("provider-credential-unavailable");
    const response = await githubFetch(
      this.fetcher,
      url.href,
      {
        method,
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${credential}`,
          "X-GitHub-Api-Version": version,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      () => new Error("provider-origin-mismatch"),
    );
    if (!response.ok)
      throw new ProviderFailure(
        response.status,
        await githubRateLimitResumeAt(response),
        response.status === 409 || response.status === 422
          ? await response.json().catch(() => undefined)
          : undefined,
      );
    return {
      json: response.status === 204 ? null : await response.json(),
      response,
    };
  }
  private async graph(query: string, variables: unknown): Promise<unknown> {
    const { json, response } = await this.request("/graphql", "POST", {
      query,
      variables,
    });
    const result = z
      .object({ data: z.unknown(), errors: z.array(z.unknown()).optional() })
      .parse(json);
    if (result.errors?.length) {
      // GraphQL reports a rate limit as HTTP 200, but GitHub did not apply the request.
      const resumeAt = githubGraphqlRateLimitResumeAt(response, result.errors, {
        typedOnly: true,
      });
      if (resumeAt !== undefined) throw new ProviderFailure(429, resumeAt);
      throw new Error("provider-graphql-incomplete");
    }
    return result.data;
  }
  private async pages(path: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    const incomplete = () => new Error("provider-pagination-incomplete");
    for await (const value of githubPages(
      path,
      async (url) => {
        const { json, response } = await this.request(url);
        return { value: json, response };
      },
      (response) => nextPageLink(response, incomplete),
      incomplete,
    ))
      rows.push(...z.array(z.unknown()).parse(value));
    return rows;
  }
  private async repository(id: string) {
    const data = z
      .object({
        node: z.object({
          id: name,
          nameWithOwner: z.string().regex(/^[^/]+\/[^/]+$/),
        }),
      })
      .parse(await this.graph(deliveryDocuments.CabDeliveryRepository, { id }));
    if (data.node.id !== id) throw new Error("provider-repository-mismatch");
    const path = `/repos/${data.node.nameWithOwner.split("/").map(encodeURIComponent).join("/")}`;
    const repo = z
      .object({
        node_id: name,
        full_name: name,
        allow_merge_commit: z.boolean(),
        allow_squash_merge: z.boolean(),
        allow_rebase_merge: z.boolean(),
        default_branch: name.optional(),
      })
      .parse((await this.request(path)).json);
    if (repo.node_id !== id || repo.full_name !== data.node.nameWithOwner)
      throw new Error("provider-repository-mismatch");
    return {
      path,
      owner: data.node.nameWithOwner.split("/")[0] ?? "",
      defaultBranch: repo.default_branch,
      methods: [
        ...(repo.allow_merge_commit ? ["merge"] : []),
        ...(repo.allow_squash_merge ? ["squash"] : []),
        ...(repo.allow_rebase_merge ? ["rebase"] : []),
      ] as PrDeliveryObservation["allowedMethods"],
    };
  }
  private async issue(
    path: string,
    target: { nodeId: string; number: number },
  ) {
    const value = z
      .object({
        node_id: name,
        number: z.number().int().positive(),
        state: z.enum(["open", "closed"]),
        title: z.string(),
        body: z.string().nullable(),
        labels: z.array(z.object({ name })),
        pull_request: z.unknown().optional(),
      })
      .parse((await this.request(`${path}/issues/${target.number}`)).json);
    if (
      value.node_id !== target.nodeId ||
      value.number !== target.number ||
      value.pull_request
    )
      throw new Error("provider-issue-mismatch");
    return value;
  }
  private async ref(path: string, ref: string): Promise<string> {
    const value = z
      .object({ ref: name, object: z.object({ sha }) })
      .parse(
        (
          await this.request(
            `${path}/git/ref/heads/${ref.split("/").map(encodeURIComponent).join("/")}`,
          )
        ).json,
      );
    if (value.ref !== `refs/heads/${ref}`)
      throw new Error("provider-ref-mismatch");
    return value.object.sha;
  }
  /** The branch's head, or null when the branch does not exist. */
  private async optionalRef(path: string, ref: string): Promise<string | null> {
    try {
      return await this.ref(path, ref);
    } catch (error) {
      if (error instanceof ProviderFailure && error.status === 404) return null;
      throw error;
    }
  }
  /** Reads a review thread; `all` pages every comment, otherwise only the first page. */
  private async thread(id: string, all: boolean) {
    const comments: Array<{
      id: string;
      body: string;
      state: string;
      authorId: string | null;
    }> = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    let head:
      | {
          id: string;
          isResolved: boolean;
          resolvedBy: string | null;
          latest: string | null;
          prId: string;
          prNumber: number;
          repositoryId: string;
        }
      | undefined;
    for (let count = 0; count < 20; count++) {
      const { node } = z
        .object({
          node: z.object({
            id: name,
            isResolved: z.boolean(),
            resolvedBy: z.object({ id: name }).nullable(),
            pullRequest: z.object({
              id: name,
              number: z.number().int().positive(),
              repository: z.object({ id: name }),
            }),
            latestComment: z.object({ nodes: z.array(z.object({ id: name })) }),
            comments: z.object({
              nodes: z.array(
                z.object({
                  id: name,
                  body: z.string(),
                  state: name,
                  author: z
                    .object({ __typename: name, id: name.optional() })
                    .nullable(),
                }),
              ),
              pageInfo: page,
            }),
          }),
        })
        .parse(
          await this.graph(deliveryDocuments.CabDeliveryThread, {
            id,
            after: cursor,
          }),
        );
      if (node.id !== id) throw new Error("provider-thread-mismatch");
      head = {
        id: node.id,
        isResolved: node.isResolved,
        resolvedBy: node.resolvedBy?.id ?? null,
        latest: node.latestComment.nodes[0]?.id ?? null,
        prId: node.pullRequest.id,
        prNumber: node.pullRequest.number,
        repositoryId: node.pullRequest.repository.id,
      };
      for (const c of node.comments.nodes)
        comments.push({
          id: c.id,
          body: c.body,
          state: c.state,
          authorId: c.author?.id ?? null,
        });
      if (!all || !node.comments.pageInfo.hasNextPage)
        return { ...head, comments };
      cursor = node.comments.pageInfo.endCursor;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    throw new Error("provider-thread-pagination-incomplete");
  }
  async inspectClosedIssue(target: {
    repositoryId: string;
    nodeId: string;
    number: number;
  }): Promise<ClosedIssueInspection> {
    const repo = await this.repository(target.repositoryId),
      issue = await this.issue(repo.path, target);
    if (issue.state !== "closed") return { state: "open" };
    const data = z
      .object({
        node: z.object({
          id: name,
          repository: z.object({ id: name }),
          timelineItems: z.object({
            nodes: z
              .array(
                z.object({
                  id: name,
                  closer: z
                    .object({ __typename: name, id: name.optional() })
                    .nullable(),
                }),
              )
              .max(1),
          }),
        }),
      })
      .parse(
        await this.graph(deliveryDocuments.CabDeliveryClosure, {
          id: target.nodeId,
        }),
      );
    if (
      data.node.id !== target.nodeId ||
      data.node.repository.id !== target.repositoryId
    )
      throw new Error("provider-closure-identity-mismatch");
    const event = data.node.timelineItems.nodes[0];
    const closer = event?.closer ?? null;
    return {
      state: "closed",
      snapshot: {
        providerInstance: "github.com",
        nodeId: issue.node_id,
        repositoryId: target.repositoryId,
        repositoryName: repo.path.slice("/repos/".length),
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        state: "closed",
        labels: issue.labels.map((v) => v.name),
        projectFields: [],
      },
      closedEvent: event
        ? {
            id: event.id,
            closerKind:
              closer === null
                ? "none"
                : closer.__typename === "PullRequest"
                  ? "pull-request"
                  : "other",
            closerPrNodeId:
              closer?.__typename === "PullRequest" ? (closer.id ?? null) : null,
          }
        : null,
    };
  }
  /** The issue's item in the Project, or null; more than one is unproved. */
  private async projectItem(
    action: Extract<ExternalAction, { kind: "project.item.add" }>,
  ): Promise<string | null> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    const items: string[] = [];
    for (let count = 0; count < 100; count++) {
      const data = z
        .object({
          node: z.object({
            id: name,
            repository: z.object({ id: name }),
            projectItems: z.object({
              nodes: z.array(
                z.object({ id: name, project: z.object({ id: name }) }),
              ),
              pageInfo: page,
            }),
          }),
        })
        .parse(
          await this.graph(deliveryDocuments.CabDeliveryIssueItems, {
            id: action.target.nodeId,
            after: cursor,
          }),
        );
      if (
        data.node.id !== action.target.nodeId ||
        data.node.repository.id !== action.target.repositoryId
      )
        throw new Error("provider-project-item-unproved");
      for (const item of data.node.projectItems.nodes)
        if (item.project.id === action.projectNodeId) items.push(item.id);
      if (!data.node.projectItems.pageInfo.hasNextPage) {
        if (items.length > 1) throw new Error("provider-project-item-unproved");
        return items[0] ?? null;
      }
      cursor = data.node.projectItems.pageInfo.endCursor;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    throw new Error("provider-item-pagination-incomplete");
  }
  /** What GitHub shows for an issue the operator names to Link a publication, and whether it carries the marker. */
  async inspectPublishedIssue(
    target: { repositoryId: string; number: number },
    operationId: string,
  ): Promise<PublishedIssueInspection> {
    const repo = await this.repository(target.repositoryId);
    const me = z
      .object({ node_id: name })
      .parse((await this.request("/user")).json);
    const value = z
      .object({
        node_id: name,
        number: z.number().int().positive(),
        title: z.string(),
        body: z.string().nullable(),
        labels: z.array(z.object({ name })),
        user: z.object({ node_id: name }),
        pull_request: z.unknown().optional(),
      })
      .parse((await this.request(`${repo.path}/issues/${target.number}`)).json);
    if (value.number !== target.number || value.pull_request)
      throw new Error("provider-issue-mismatch");
    return {
      nodeId: value.node_id,
      number: value.number,
      title: value.title,
      body: value.body ?? "",
      labels: value.labels.map((l) => l.name),
      byCredentialUser: value.user.node_id === me.node_id,
      hasMarker: (value.body ?? "").includes(publicationMarker(operationId)),
    };
  }
  private async projectField(
    action: Extract<ExternalAction, { kind: "project.field" }>,
  ): Promise<string | null> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    let option: string | null = null;
    let matches = 0;
    for (let count = 0; count < 100; count++) {
      const data = z
        .object({
          node: z.object({
            id: name,
            project: z.object({ id: name }),
            content: z.object({ id: name, repository: z.object({ id: name }) }),
            fieldValues: z.object({
              nodes: z.array(
                z.object({
                  __typename: name,
                  optionId: name.optional(),
                  field: z.object({ id: name }).optional(),
                }),
              ),
              pageInfo: page,
            }),
          }),
          field: z.object({
            id: name,
            options: z.array(z.object({ id: name })),
            project: z.object({ id: name }),
          }),
        })
        .parse(
          await this.graph(deliveryDocuments.CabDeliveryField, {
            item: action.itemNodeId,
            field: action.fieldNodeId,
            after: cursor,
          }),
        );
      if (
        data.node.id !== action.itemNodeId ||
        data.node.project.id !== action.projectNodeId ||
        data.node.content.id !== action.target.nodeId ||
        data.node.content.repository.id !== action.target.repositoryId ||
        data.field.id !== action.fieldNodeId ||
        data.field.project.id !== action.projectNodeId ||
        !data.field.options.some((o) => o.id === action.optionNodeId)
      )
        throw new Error("provider-project-field-unproved");
      for (const value of data.node.fieldValues.nodes)
        if (value.field?.id === action.fieldNodeId) {
          if (
            value.__typename !== "ProjectV2ItemFieldSingleSelectValue" ||
            !value.optionId ||
            ++matches > 1
          )
            throw new Error("provider-project-field-unproved");
          option = value.optionId;
        }
      if (!data.node.fieldValues.pageInfo.hasNextPage) return option;
      cursor = data.node.fieldValues.pageInfo.endCursor;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    throw new Error("provider-field-pagination-incomplete");
  }

  /**
   * What `ref`'s rulesets and classic protection require. `approved` says whether the PR's review
   * is approved, and `classicAbsent` whether GraphQL showed no classic protection rule, so a 404 means none.
   */
  private async branchRequirements(
    repo: { path: string; methods: PrDeliveryObservation["allowedMethods"] },
    ref: string,
    approved: boolean,
    classicAbsent: boolean,
  ) {
    const hostChecks: RequiredCheck[] = [];
    let requireThreads = false;
    let allowedMethods = [...repo.methods];
    const unsupportedRules: string[] = [];
    let strict = false;
    const environments: string[] = [];
    const rules = z
      .array(z.object({ type: name, parameters: z.unknown().optional() }))
      .parse(
        (
          await this.request(
            `${repo.path}/rules/branches/${encodeURIComponent(ref)}`,
          )
        ).json,
      );
    for (const rule of rules) {
      if (rule.type === "required_status_checks") {
        const p = z
          .object({
            strict_required_status_checks_policy: z.boolean(),
            required_status_checks: z.array(
              z.object({
                context: name,
                integration_id: z.number().int().nullable().optional(),
              }),
            ),
          })
          .parse(rule.parameters);
        strict ||= p.strict_required_status_checks_policy;
        hostChecks.push(
          ...p.required_status_checks.map((c) => ({
            name: c.context,
            ...(c.integration_id && c.integration_id > 0
              ? { appId: c.integration_id }
              : {}),
          })),
        );
      } else if (rule.type === "pull_request") {
        const p = z
          .object({
            required_approving_review_count: z.number().int(),
            required_review_thread_resolution: z.boolean(),
            allowed_merge_methods: z
              .array(z.enum(["merge", "squash", "rebase"]))
              .min(1)
              .optional(),
            require_code_owner_review: z.boolean().optional(),
            require_last_push_approval: z.boolean().optional(),
            required_reviewers: z.array(z.unknown()).optional(),
          })
          .parse(rule.parameters);
        requireThreads ||= p.required_review_thread_resolution;
        if (p.allowed_merge_methods)
          allowedMethods = allowedMethods.filter((m) =>
            p.allowed_merge_methods?.includes(m),
          );
        if (p.required_reviewers?.length)
          unsupportedRules.push("required-reviewer-proof-unsupported");
        if (
          (p.required_approving_review_count > 0 ||
            p.require_code_owner_review ||
            p.require_last_push_approval) &&
          !approved
        )
          unsupportedRules.push("required-review-unproved");
      } else if (rule.type === "required_deployments")
        environments.push(
          ...z
            .object({ required_deployment_environments: z.array(name) })
            .parse(rule.parameters).required_deployment_environments,
        );
      else if (rule.type === "merge_queue")
        unsupportedRules.push("merge-queue-required");
      else if (
        !["deletion", "non_fast_forward", "creation"].includes(rule.type)
      )
        unsupportedRules.push(`unsupported-rule-${rule.type}`);
    }
    try {
      const protection = z
        .object({
          required_status_checks: z
            .object({
              strict: z.boolean(),
              checks: z.array(
                z.object({
                  context: name,
                  app_id: z.number().int().nullable(),
                }),
              ),
            })
            .nullable()
            .optional(),
          required_pull_request_reviews: z
            .object({
              required_approving_review_count: z.number().int(),
              require_code_owner_reviews: z.boolean().optional(),
              require_last_push_approval: z.boolean().optional(),
            })
            .nullable()
            .optional(),
          restrictions: z.object({}).passthrough().nullable().optional(),
          required_signatures: z.object({ enabled: z.boolean() }).optional(),
          required_linear_history: z
            .object({ enabled: z.boolean() })
            .optional(),
          lock_branch: z.object({ enabled: z.boolean() }).optional(),
          required_conversation_resolution: z
            .object({ enabled: z.boolean() })
            .optional(),
        })
        .parse(
          (
            await this.request(
              `${repo.path}/branches/${encodeURIComponent(ref)}/protection`,
            )
          ).json,
        );
      if (protection.restrictions)
        unsupportedRules.push("classic-update-restriction-unproved");
      if (protection.required_signatures?.enabled)
        unsupportedRules.push("classic-signature-proof-unsupported");
      if (protection.lock_branch?.enabled)
        unsupportedRules.push("classic-locked-branch");
      if (protection.required_linear_history?.enabled)
        allowedMethods = allowedMethods.filter((method) => method !== "merge");
      strict ||= protection.required_status_checks?.strict ?? false;
      requireThreads ||=
        protection.required_conversation_resolution?.enabled ?? false;
      hostChecks.push(
        ...(protection.required_status_checks?.checks ?? []).map((c) => ({
          name: c.context,
          ...(c.app_id && c.app_id > 0 ? { appId: c.app_id } : {}),
        })),
      );
      if (
        ((protection.required_pull_request_reviews
          ?.required_approving_review_count ?? 0) > 0 ||
          protection.required_pull_request_reviews
            ?.require_code_owner_reviews ||
          protection.required_pull_request_reviews
            ?.require_last_push_approval) &&
        !approved
      )
        unsupportedRules.push("required-review-unproved");
    } catch (error) {
      if (
        !(
          error instanceof ProviderFailure &&
          error.status === 404 &&
          classicAbsent
        )
      )
        unsupportedRules.push("classic-protection-unproved");
    }
    return {
      hostChecks,
      requireThreads,
      allowedMethods,
      unsupportedRules,
      strict,
      environments,
    };
  }
  async repositoryRequirements(
    repositoryId: string,
  ): Promise<RepositoryRequirements> {
    const repo = await this.repository(repositoryId);
    if (!repo.defaultBranch) throw new Error("provider-default-branch-unknown");
    // Without a PR there is no GraphQL rule to tell "unprotected" from "unreadable", so a 404 reads as
    // unprotected. The merge gate still proves classic protection from GraphQL on every merge.
    const branch = await this.branchRequirements(
      repo,
      repo.defaultBranch,
      true,
      true,
    );
    if (branch.unsupportedRules.includes("classic-protection-unproved"))
      throw new Error("provider-protection-unproved");
    return {
      hostChecks: branch.hostChecks,
      allowedMethods: branch.allowedMethods,
    };
  }
  /** Stack-bearing reads deliberately use the API version that exposes membership. */
  private async stackPr(path: string, number: number) {
    return z
      .object({
        node_id: name,
        number: z.number().int().positive(),
        state: z.enum(["open", "closed"]),
        merged: z.boolean(),
        body: z.string().nullable(),
        head: z.object({ sha, ref: name, repo: z.object({ node_id: name }) }),
        base: z.object({ ref: name, repo: z.object({ node_id: name }) }),
        // Missing is unknown, never the same as an explicit null.
        stack: githubStackMembership,
      })
      .parse(
        (
          await this.request(
            `${path}/pulls/${number}`,
            "GET",
            undefined,
            "2026-03-10",
          )
        ).json,
      );
  }
  private async stackPair(record: DeliveryActionRecord) {
    const link = record.stackLink,
      create = record.stackCreate;
    if (!link || !create || record.request.action.kind !== "pr.create")
      throw new Error("Stack identity unavailable");
    const i = link.identity,
      a = record.request.action;
    const repo = await this.repository(i.repositoryId);
    if (repo.path !== record.beforeState?.repositoryPath)
      throw new Error("Stack repository path changed");
    const blocker = await this.stackPr(repo.path, i.blockerPrNumber);
    const dependent = await this.stackPr(repo.path, i.dependentPrNumber);
    if (
      blocker.node_id !== i.blockerPrNodeId ||
      blocker.number !== i.blockerPrNumber ||
      blocker.head.ref !== i.blockerBranch ||
      blocker.head.sha !== create.blockerHeadSha ||
      blocker.head.repo.node_id !== i.repositoryId ||
      blocker.base.repo.node_id !== i.repositoryId ||
      dependent.node_id !== i.dependentPrNodeId ||
      dependent.number !== i.dependentPrNumber ||
      dependent.head.ref !== a.target.headRef ||
      dependent.head.sha !== a.target.expectedHeadSha ||
      dependent.head.repo.node_id !== i.repositoryId ||
      dependent.base.repo.node_id !== i.repositoryId ||
      dependent.base.ref !== i.blockerBranch ||
      !dependent.body?.includes(
        `<!-- cab-operation:${record.operationId} -->`,
      ) ||
      blocker.state !== "open" ||
      blocker.merged ||
      dependent.state !== "open" ||
      dependent.merged
    )
      throw new Error("Stack PR identity changed");
    return { path: repo.path, blocker, dependent };
  }
  private async orderedStack(
    path: string,
    membership: {
      id: number;
      number: number;
      size: number;
      base: { ref: string };
    },
  ) {
    const stack = z
      .object({
        id: z.number().int().positive(),
        number: z.number().int().positive(),
        base: z.object({ ref: name }),
        pull_requests: z.array(
          z.object({
            node_id: name,
            number: z.number().int().positive(),
            head: z.object({ ref: name, sha }),
            state: z.enum(["open", "closed"]),
            merged_at: z.string().nullable(),
          }),
        ),
      })
      .parse(
        (
          await this.request(
            `${path}/stacks/${membership.number}`,
            "GET",
            undefined,
            "2026-03-10",
          )
        ).json,
      );
    if (
      stack.id !== membership.id ||
      stack.number !== membership.number ||
      stack.base.ref !== membership.base.ref ||
      stack.pull_requests.length !== membership.size ||
      new Set(stack.pull_requests.map((p) => p.number)).size !==
        membership.size ||
      new Set(stack.pull_requests.map((p) => p.node_id)).size !==
        membership.size
    )
      throw new Error("Stack membership inconsistent");
    return stack;
  }
  /** The async endpoint merges downstack too: establish that no other open layer is below this PR. */
  private async qualifyStackMerge(
    action: Extract<ExternalAction, { kind: "pr.merge" }>,
    path: string,
  ) {
    const own = await this.stackPr(path, action.target.number);
    if (
      own.node_id !== action.target.nodeId ||
      own.number !== action.target.number ||
      own.head.repo.node_id !== action.target.repositoryId ||
      own.base.repo.node_id !== action.target.repositoryId ||
      own.head.ref !== action.target.headRef ||
      own.head.sha !== action.target.expectedHeadSha ||
      own.base.ref !== action.target.baseRef
    )
      throw new Error("provider-stack-merge-identity-unproved");
    if (own.stack === null) return;
    const stack = await this.orderedStack(path, own.stack);
    const index = own.stack.position - 1;
    const entry = stack.pull_requests[index];
    if (
      entry?.node_id !== own.node_id ||
      entry.number !== own.number ||
      entry.head.ref !== own.head.ref ||
      entry.head.sha !== own.head.sha
    )
      throw new Error("provider-stack-merge-membership-unproved");
    for (const lower of stack.pull_requests.slice(0, index)) {
      if (lower.state !== "closed" || lower.merged_at === null)
        throw new Error("provider-stack-lower-pr-unmerged");
      // Revalidate the exact PR identity in this repository, not only a stack row's state.
      const pr = await this.stackPr(path, lower.number);
      if (
        pr.node_id !== lower.node_id ||
        pr.number !== lower.number ||
        pr.head.repo.node_id !== action.target.repositoryId ||
        pr.base.repo.node_id !== action.target.repositoryId ||
        pr.head.ref !== lower.head.ref ||
        pr.head.sha !== lower.head.sha ||
        !pr.merged ||
        pr.state !== "closed"
      )
        throw new Error("provider-stack-lower-pr-unproved");
    }
  }
  async prepareStackLink(
    record: DeliveryActionRecord,
  ): Promise<StackLinkTarget> {
    const { path, blocker, dependent } = await this.stackPair(record);
    if (dependent.stack !== null)
      throw new Error("Dependent already has stack membership");
    if (blocker.stack === null) return null;
    const stack = await this.orderedStack(path, blocker.stack);
    const top = stack.pull_requests.at(-1);
    if (
      blocker.stack.position !== blocker.stack.size ||
      top?.node_id !== blocker.node_id ||
      top.number !== blocker.number ||
      top.head.ref !== blocker.head.ref ||
      top.head.sha !== blocker.head.sha ||
      top.state !== "open" ||
      top.merged_at !== null
    )
      throw new Error("Blocker is not the stack top");
    return {
      id: stack.id,
      number: stack.number,
      size: stack.pull_requests.length,
    };
  }
  async performStackLink(
    record: DeliveryActionRecord,
  ): Promise<ProviderActionObservation> {
    const link = record.stackLink;
    if (link?.phase !== "link-attempting" || link.target === undefined)
      throw new Error("Stack send intent unavailable");
    const path = z
      .string()
      .regex(/^\/repos\/[^/?#]+\/[^/?#]+$/)
      .parse(record.beforeState?.repositoryPath);
    try {
      await this.request(
        link.target === null
          ? `${path}/stacks`
          : `${path}/stacks/${link.target.number}/add`,
        "POST",
        {
          pull_requests:
            link.target === null
              ? [link.identity.blockerPrNumber, link.identity.dependentPrNumber]
              : [link.identity.dependentPrNumber],
        },
        "2026-03-10",
      );
      return {
        state: "uncertain",
        reason: "stack-link-readback-required",
        receipt: null,
      };
    } catch (error) {
      if (error instanceof ProviderFailure && error.status === 422) {
        const message = z.object({ message: z.string() }).safeParse(error.body);
        return {
          state: "uncertain",
          reason: "stack-link-refused",
          receipt: null,
          stackLinkRefused: true,
          // Fixed prefix and a bounded host message; never persist the raw provider body.
          hostReason: (message.success
            ? message.data.message
            : "GitHub refused the stack (422)"
          )
            .replace(/\p{Cc}/gu, " ")
            .slice(0, 500),
        };
      }
      return {
        state: "uncertain",
        reason:
          error instanceof ProviderFailure && error.status === 409
            ? "stack-link-concurrent-change"
            : "stack-link-effect-unproved",
        receipt: null,
      };
    }
  }
  async inspectStackLink(
    record: DeliveryActionRecord,
  ): Promise<ProviderActionObservation> {
    const link = record.stackLink;
    if (link?.phase !== "link-attempting" || link.target === undefined)
      throw new Error("Stack send intent unavailable");
    const { path, blocker, dependent } = await this.stackPair(record);
    const receipt = record.observation?.receipt ?? null;
    if (!receipt || receipt.nodeId !== link.identity.dependentPrNodeId)
      throw new Error("Stack receipt unavailable");
    if (dependent.stack === null) {
      return record.observation?.stackLinkRefused
        ? {
            state: "confirmed-success",
            reason: "stack-link-refused-plain-chain",
            receipt,
            stack: null,
            stackLinkRefused: true,
            hostReason: record.observation.hostReason,
          }
        : { state: "uncertain", reason: "stack-link-effect-unproved", receipt };
    }
    const membership = dependent.stack;
    const stack = await this.orderedStack(path, membership);
    const lower = stack.pull_requests[membership.position - 2];
    const own = stack.pull_requests[membership.position - 1];
    if (
      !blocker.stack ||
      blocker.stack.id !== membership.id ||
      blocker.stack.number !== membership.number ||
      blocker.stack.size !== membership.size ||
      blocker.stack.position + 1 !== membership.position ||
      blocker.stack.base.ref !== membership.base.ref ||
      blocker.stack.base.sha !== membership.base.sha ||
      lower?.node_id !== blocker.node_id ||
      lower.number !== blocker.number ||
      lower.head.ref !== blocker.head.ref ||
      lower.head.sha !== blocker.head.sha ||
      own?.node_id !== dependent.node_id ||
      own.number !== dependent.number ||
      own.head.ref !== dependent.head.ref ||
      own.head.sha !== dependent.head.sha ||
      (link.target !== null &&
        (link.target.id !== membership.id ||
          link.target.number !== membership.number ||
          membership.position !== link.target.size + 1)) ||
      (link.target === null && membership.position !== 2)
    )
      throw new Error("Stack link membership unproved");
    return {
      state: "confirmed-success",
      reason: null,
      receipt,
      stack: {
        id: membership.id,
        number: membership.number,
        position: membership.position,
        size: membership.size,
      },
    };
  }
  async inspectPr(
    identity: PrIdentity,
    policy: DeliveryPolicy,
  ): Promise<PrDeliveryObservation> {
    const repo = await this.repository(identity.repositoryId);
    const raw = z
      .object({
        node_id: name,
        number: z.number().int().positive(),
        stack: githubStackMembership.optional(),
        head: z.object({ sha, ref: name, repo: z.object({ node_id: name }) }),
        base: z.object({ sha, ref: name, repo: z.object({ node_id: name }) }),
      })
      .parse(
        (
          await this.request(
            `${repo.path}/pulls/${identity.prNumber}`,
            "GET",
            undefined,
            "2026-03-10",
          )
        ).json,
      );
    if (
      raw.node_id !== identity.expectedPrNodeId ||
      raw.number !== identity.prNumber ||
      raw.head.repo.node_id !== identity.repositoryId ||
      raw.base.repo.node_id !== identity.repositoryId
    )
      throw new Error("provider-pr-mismatch");
    const graphSchema = z.object({
      node: z.object({
        id: name,
        number: z.number().int().positive(),
        repository: z.object({ id: name, nameWithOwner: name }),
        baseRefName: name,
        headRefName: name,
        headRefOid: sha,
        baseRefOid: sha,
        state: z.enum(["OPEN", "CLOSED", "MERGED"]),
        isDraft: z.boolean(),
        merged: z.boolean(),
        mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
        mergeStateStatus: name,
        reviewDecision: z
          .enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])
          .nullable(),
        isMergeQueueEnabled: z.boolean(),
        closingIssuesReferences: z.object({
          nodes: z.array(
            z.object({
              id: name,
              state: z.enum(["OPEN", "CLOSED"]),
              repository: z.object({ id: name }),
            }),
          ),
          pageInfo: page,
        }),
        baseRef: z
          .object({
            target: z.object({ oid: sha }),
            branchProtectionRule: z
              .object({
                requiresDeployments: z.boolean(),
                requiredDeploymentEnvironments: z.array(name),
                requiresStrictStatusChecks: z.boolean(),
              })
              .nullable(),
          })
          .nullable(),
        reviewThreads: z.object({
          nodes: z.array(
            z.object({
              id: name,
              isResolved: z.boolean(),
              firstComment: z.object({
                nodes: z.array(z.object({ id: name })),
              }),
              latestComment: z.object({
                nodes: z.array(z.object({ id: name })),
              }),
            }),
          ),
          pageInfo: page,
        }),
      }),
    });
    let cursor: string | null = null;
    const seen = new Set<string>();
    let graph: ReturnType<typeof graphSchema.parse>["node"] | undefined;
    const reviewThreads: NonNullable<PrDeliveryObservation["reviewThreads"]> =
      [];
    for (let count = 0; count < 100; count++) {
      const value: z.output<typeof graphSchema>["node"] = graphSchema.parse(
        await this.graph(prQuery, {
          id: identity.expectedPrNodeId,
          after: cursor,
        }),
      ).node;
      if (
        value.id !== raw.node_id ||
        value.repository.id !== identity.repositoryId ||
        value.number !== raw.number ||
        value.headRefOid !== raw.head.sha ||
        value.baseRefOid !== raw.base.sha ||
        value.headRefName !== raw.head.ref ||
        value.baseRefName !== raw.base.ref
      )
        throw new Error("provider-pr-snapshot-changed");
      graph = value;
      for (const t of value.reviewThreads.nodes)
        reviewThreads.push({
          nodeId: t.id,
          isResolved: t.isResolved,
          firstCommentNodeId: t.firstComment.nodes[0]?.id ?? null,
          latestCommentNodeId: t.latestComment.nodes[0]?.id ?? null,
        });
      if (!value.reviewThreads.pageInfo.hasNextPage) break;
      cursor = value.reviewThreads.pageInfo.endCursor;
      if (!cursor || seen.has(cursor) || count === 99)
        throw new Error("provider-review-pagination-incomplete");
      seen.add(cursor);
    }
    if (!graph) throw new Error("provider-pr-unavailable");
    const checks: PrDeliveryObservation["checks"] = [];
    let next: string | null =
      `${repo.path}/commits/${raw.head.sha}/check-runs?per_page=100&filter=latest`;
    const checkPages = new Set<string>();
    while (next) {
      if (checkPages.size >= 100 || checkPages.has(next))
        throw new Error("provider-check-pagination-incomplete");
      checkPages.add(next);
      const result = await this.request(next);
      const runs = z
        .object({
          total_count: z.number().int(),
          check_runs: z.array(
            z.object({
              name,
              node_id: name,
              completed_at: name.nullable(),
              started_at: name.nullable(),
              head_sha: sha,
              status: name,
              conclusion: name.nullable(),
              app: z.object({ id: z.number().int() }).nullable(),
            }),
          ),
        })
        .parse(result.json);
      for (const run of runs.check_runs)
        checks.push({
          name: run.name,
          nodeId: run.node_id,
          updatedAt: run.completed_at ?? run.started_at ?? "unproved",
          appId: run.app?.id ?? null,
          sha: run.head_sha,
          status:
            run.status !== "completed"
              ? "pending"
              : ["success", "neutral", "skipped"].includes(run.conclusion ?? "")
                ? "success"
                : "failure",
        });
      next = nextPageLink(
        result.response,
        () => new Error("provider-check-pagination-incomplete"),
      );
      if (!next && checks.length < runs.total_count)
        throw new Error("provider-check-pagination-incomplete");
    }
    for (const value of await this.pages(
      `${repo.path}/commits/${raw.head.sha}/statuses?per_page=100`,
    )) {
      const status = z
        .object({
          context: name,
          node_id: name,
          updated_at: name,
          state: z.enum(["success", "pending", "failure", "error"]),
          sha: sha.optional(),
        })
        .parse(value);
      // Legacy status identities cannot impersonate a required GitHub App.
      if (!checks.some((c) => c.name === status.context && c.appId === null))
        checks.push({
          name: status.context,
          nodeId: status.node_id,
          updatedAt: status.updated_at,
          appId: null,
          sha: status.sha ?? raw.head.sha,
          status:
            status.state === "success"
              ? "success"
              : status.state === "pending"
                ? "pending"
                : "failure",
        });
    }
    reviewThreads.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    const unresolved = reviewThreads.some((t) => !t.isResolved);
    const branch = await this.branchRequirements(
      repo,
      raw.base.ref,
      graph.reviewDecision === "APPROVED",
      graph.baseRef?.branchProtectionRule === null,
    );
    const { hostChecks, requireThreads, allowedMethods } = branch;
    const unsupportedRules = [
      ...(!graph.baseRef || graph.baseRef.target.oid !== raw.base.sha
        ? ["base-ref-current-unproved"]
        : []),
      ...branch.unsupportedRules,
    ];
    const strict =
      (graph.baseRef?.branchProtectionRule?.requiresStrictStatusChecks ??
        false) ||
      branch.strict;
    const environments = [
      ...(graph.baseRef?.branchProtectionRule?.requiredDeploymentEnvironments ??
        []),
      ...branch.environments,
    ];
    const { mergeMethod, cabChecks } = repositoryDeliverySettings(
      policy,
      identity.repositoryId,
    );
    if (
      graph.baseRef?.branchProtectionRule?.requiresDeployments &&
      !environments.length
    )
      unsupportedRules.push("deployment-requirements-unproved");
    const deployments: Array<{
      environment: string;
      sha: string;
      success: boolean;
    }> = [];
    if (environments.length)
      for (const value of await this.pages(
        `${repo.path}/deployments?sha=${raw.head.sha}&per_page=100`,
      )) {
        const d = z
          .object({ id: z.number().int(), environment: name, sha })
          .parse(value);
        const statuses = (
          await this.pages(
            `${repo.path}/deployments/${d.id}/statuses?per_page=100`,
          )
        ).map((v) => z.object({ state: name }).parse(v));
        deployments.push({
          environment: d.environment,
          sha: d.sha,
          success: statuses[0]?.state === "success",
        });
      }
    if (graph.closingIssuesReferences.pageInfo.hasNextPage)
      unsupportedRules.push("closing-issue-pagination-unproved");
    const mergeBlockers = mergeGateReasons({
      draft: graph.isDraft,
      merged: graph.merged,
      state: graph.state,
      mergeable: graph.mergeable,
      mergeStateStatus: graph.mergeStateStatus,
      queue: graph.isMergeQueueEnabled,
      reviewDecision: graph.reviewDecision,
      unresolvedThreads: requireThreads && unresolved,
      headSha: raw.head.sha,
      baseSha: raw.base.sha,
      strict,
      requiredEnvironments: [...new Set(environments)],
      deployments,
      checks,
      hostChecks,
      cabChecks,
      configuredMethod: mergeMethod,
      unsupportedRules,
      allowedMethods,
    });
    const feedback: NonNullable<PrDeliveryObservation["feedback"]> = [];
    for (const [kind, path] of [
      ["comment", `${repo.path}/issues/${raw.number}/comments?per_page=100`],
      ["review", `${repo.path}/pulls/${raw.number}/reviews?per_page=100`],
      [
        "review-comment",
        `${repo.path}/pulls/${raw.number}/comments?per_page=100`,
      ],
    ] as const) {
      for (const value of await this.pages(path)) {
        const entry = z
          .object({
            node_id: name,
            user: z.object({ node_id: name }),
            body: z.string().nullable(),
            updated_at: name.optional(),
            submitted_at: name.nullable().optional(),
            state: name.optional(),
            commit_id: sha.optional(),
          })
          .parse(value);
        const updatedAt = entry.updated_at ?? entry.submitted_at;
        if (!updatedAt) throw new Error("provider-feedback-incomplete");
        feedback.push({
          kind,
          nodeId: entry.node_id,
          author: entry.user.node_id,
          updatedAt,
          state: entry.state ?? "COMMENTED",
          body: (entry.body ?? "").slice(0, 2000),
          commitSha: entry.commit_id ?? null,
        });
      }
    }
    feedback.sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) || a.nodeId.localeCompare(b.nodeId),
    );
    const retarget =
      identity.recordedBaseRef !== undefined &&
      identity.recordedBaseRef !== raw.base.ref
        ? {
            fromRef: identity.recordedBaseRef,
            priorMerged: await this.priorMerged(
              repo,
              identity.repositoryId,
              identity.recordedBaseRef,
              raw.base.ref,
            ),
          }
        : undefined;
    return prObservationSchema.parse({
      ...(raw.stack === undefined
        ? {}
        : {
            stack:
              raw.stack === null
                ? null
                : {
                    id: raw.stack.id,
                    number: raw.stack.number,
                    position: raw.stack.position,
                    size: raw.stack.size,
                  },
          }),
      repositoryId: identity.repositoryId,
      nodeId: raw.node_id,
      number: raw.number,
      baseRef: raw.base.ref,
      headRef: raw.head.ref,
      headSha: raw.head.sha,
      baseSha: raw.base.sha,
      state: graph.state,
      draft: graph.isDraft,
      merged: graph.merged,
      reviewDecision: graph.reviewDecision,
      checks,
      feedback,
      reviewThreads,
      mergeBlockers,
      requiredChecks: requiredCheckSources(hostChecks, cabChecks),
      closedIssueNodeIds: graph.closingIssuesReferences.pageInfo.hasNextPage
        ? []
        : graph.closingIssuesReferences.nodes
            .filter(
              (i) =>
                i.state === "CLOSED" &&
                i.repository.id === identity.repositoryId,
            )
            .map((i) => i.id),
      allowedMethods,
      ...(retarget ? { retarget } : {}),
    });
  }
  /**
   * Whether the change request that was the base (the pull requests of branch `ref` in this repository)
   * is merged into `into`, the new base: at least one is, and none is open. A read that fails reads as not merged.
   */
  private async priorMerged(
    repo: { path: string; owner: string },
    repositoryId: string,
    ref: string,
    into: string,
  ): Promise<boolean> {
    try {
      const lower = (
        await this.pages(
          `${repo.path}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:${ref}`)}&per_page=100`,
        )
      )
        .map((v) =>
          z
            .object({
              state: name,
              merged_at: name.nullable(),
              head: z.object({
                ref: name,
                repo: z.object({ node_id: name }).nullable(),
              }),
              base: z.object({ ref: name }),
            })
            .parse(v),
        )
        .filter(
          (p) => p.head.ref === ref && p.head.repo?.node_id === repositoryId,
        );
      return (
        lower.some((p) => p.merged_at !== null && p.base.ref === into) &&
        !lower.some((p) => p.state === "open")
      );
    } catch {
      return false;
    }
  }
  private assertThreadOn(
    thread: { prId: string; prNumber: number; repositoryId: string },
    target: { repositoryId: string; nodeId: string; number: number },
  ) {
    if (
      thread.prId !== target.nodeId ||
      thread.prNumber !== target.number ||
      thread.repositoryId !== target.repositoryId
    )
      throw new Error("provider-thread-mismatch");
  }
  async preflight(
    action: ExternalAction,
    policy: DeliveryPolicy,
    publication?: PublicationContext,
    adoption?: AdoptionContext,
  ) {
    const repo = await this.repository(action.target.repositoryId);
    if (action.kind === "issue.create") return { repositoryPath: repo.path };
    if (
      action.kind === "branch.adopt" ||
      action.kind === "branch.push" ||
      action.kind === "branch.force-push"
    )
      return {
        repositoryPath: repo.path,
        ...(await branchPreflight(
          action,
          this.remoteAt(repo.path),
          publication,
          adoption,
        )),
      };
    if (action.kind === "pr.create") {
      const head = await this.ref(repo.path, action.target.headRef);
      await this.ref(repo.path, action.target.baseRef);
      if (head !== action.target.expectedHeadSha)
        throw new Error("provider-head-changed");
      return {
        repositoryPath: repo.path,
        repositoryId: action.target.repositoryId,
        headSha: head,
      };
    }
    if (
      action.kind === "pr.thread.reply" ||
      action.kind === "pr.thread.resolve"
    ) {
      const thread = await this.thread(action.target.threadNodeId, false);
      this.assertThreadOn(thread, action.target);
      if (
        action.kind === "pr.thread.resolve" &&
        (thread.isResolved ||
          thread.latest !== action.expectedLatestCommentNodeId)
      )
        throw new Error("provider-thread-resolve-held");
      return {
        repositoryPath: repo.path,
        threadNodeId: thread.id,
        latestCommentNodeId: thread.latest,
        isResolved: thread.isResolved,
      };
    }
    if (action.kind.startsWith("pr.") && "expectedHeadSha" in action.target) {
      const observation = await this.inspectPr(
        {
          repositoryId: action.target.repositoryId,
          prNumber: action.target.number,
          expectedPrNodeId: action.target.nodeId,
          expectedHeadSha: action.target.expectedHeadSha,
        },
        policy,
      );
      if (
        observation.headSha !== action.target.expectedHeadSha ||
        observation.baseRef !== action.target.baseRef ||
        observation.headRef !== action.target.headRef
      )
        throw new Error("provider-head-changed");
      if (
        action.kind === "pr.merge" &&
        (observation.mergeBlockers.length ||
          action.method !==
            repositoryDeliverySettings(policy, action.target.repositoryId)
              .mergeMethod)
      )
        throw new Error("provider-merge-gates-held");
      if (action.kind === "pr.merge")
        await this.qualifyStackMerge(action, repo.path);
      return {
        repositoryPath: repo.path,
        nodeId: observation.nodeId,
        headSha: observation.headSha,
      };
    }
    if (!("number" in action.target))
      throw new Error("provider-target-invalid");
    const issue = await this.issue(repo.path, action.target);
    if (action.kind === "project.item.add")
      return { repositoryPath: repo.path, nodeId: issue.node_id };
    if (action.kind === "project.field") {
      const optionId = await this.projectField(action);
      // The mutation is not conditional, so this read is the guard; a move after it is the accepted race.
      if (action.expected && action.expected.optionNodeId !== optionId)
        throw new ProjectFieldChangedRefusal();
      return { repositoryPath: repo.path, nodeId: issue.node_id, optionId };
    }
    // GitHub's issue PATCH is not conditional, so this read is the only guard against a stale edit.
    if (
      action.kind === "issue.edit" &&
      action.expected &&
      (issue.title !== action.expected.title ||
        (issue.body ?? "") !== action.expected.body)
    )
      throw new IssueChangedRefusal();
    return {
      repositoryPath: repo.path,
      nodeId: issue.node_id,
      state: issue.state,
      title: issue.title,
      body: issue.body,
      labels: issue.labels.map((v) => v.name),
    };
  }
  async performAction(
    record: DeliveryActionRecord,
  ): Promise<ProviderActionObservation> {
    if (
      isOperatorDeliveryCaller(record.binding) &&
      (!isOperatorAction(record.request.action) ||
        record.request.approval ||
        record.request.action.target.nodeId !== record.binding.sourceNodeId ||
        record.request.action.target.repositoryId !==
          record.binding.sourceRepositoryId)
    )
      throw new DomainPolicyError(
        "forbidden",
        "Operator delivery only permits the bound issue.comment",
      );
    const a = record.request.action;
    // Defence in depth behind `DeliveryStore.authorize`: only the publication creates or adds.
    if (
      isOperatorPublicationCaller(record.binding)
        ? !["issue.create", "project.item.add", "project.field"].includes(
            a.kind,
          ) || a.target.repositoryId !== record.binding.repositoryId
        : a.kind === "issue.create" || a.kind === "project.item.add"
    )
      throw new DomainPolicyError(
        "forbidden",
        "Publication delivery only permits its own issue.create, project.item.add and project.field",
      );
    if (a.kind === "branch.push" || a.kind === "branch.force-push")
      return publishBranch(record, a, this.branchRemotes);
    if (a.kind === "branch.adopt")
      return adoptBranchHead(record, a, this.branchRemotes);
    try {
      const repo = {
        path: z
          .string()
          .regex(/^\/repos\/[^/]+\/[^/]+$/)
          .parse(record.beforeState?.repositoryPath),
      };
      const marker = `<!-- cab-operation:${record.operationId} -->`;
      let readback = record;
      switch (a.kind) {
        case "issue.create":
          await this.request(`${repo.path}/issues`, "POST", {
            title: a.title,
            body: `${a.body}\n\n${marker}`,
            labels: a.labels,
          });
          break;
        case "project.item.add":
          await this.graph(deliveryDocuments.CabDeliveryItemAdd, {
            project: a.projectNodeId,
            content: a.target.nodeId,
          });
          break;
        case "issue.comment":
          await this.request(
            `${repo.path}/issues/${a.target.number}/comments`,
            "POST",
            { body: `${a.body}\n\n${marker}` },
          );
          break;
        case "issue.labels":
          for (const label of a.remove)
            try {
              await this.request(
                `${repo.path}/issues/${a.target.number}/labels/${encodeURIComponent(label)}`,
                "DELETE",
              );
            } catch (error) {
              // A label the issue does not carry is already removed.
              if (!(error instanceof ProviderFailure && error.status === 404))
                throw error;
            }
          if (a.add.length)
            await this.request(
              `${repo.path}/issues/${a.target.number}/labels`,
              "POST",
              { labels: a.add },
            );
          break;
        case "issue.edit":
          await this.request(
            `${repo.path}/issues/${a.target.number}`,
            "PATCH",
            a.fields,
          );
          break;
        case "issue.close":
          await this.request(
            `${repo.path}/issues/${a.target.number}`,
            "PATCH",
            { state: "closed" },
          );
          break;
        case "project.field":
          await this.graph(deliveryDocuments.CabDeliveryProject, {
            project: a.projectNodeId,
            item: a.itemNodeId,
            field: a.fieldNodeId,
            option: a.optionNodeId,
          });
          break;
        case "pr.create":
          await this.request(`${repo.path}/pulls`, "POST", {
            title: a.title,
            body: `${a.body}\n\n${marker}`,
            head: a.target.headRef,
            base: a.target.baseRef,
            draft: a.draft,
          });
          break;
        case "pr.edit":
          await this.request(
            `${repo.path}/pulls/${a.target.number}`,
            "PATCH",
            a.fields,
          );
          break;
        case "pr.ready":
          await this.graph(deliveryDocuments.CabDeliveryReady, {
            id: a.target.nodeId,
          });
          break;
        case "pr.thread.reply":
          await this.graph(deliveryDocuments.CabDeliveryThreadReply, {
            thread: a.target.threadNodeId,
            body: `${a.body}\n\n${marker}`,
          });
          break;
        case "pr.thread.resolve":
          await this.graph(deliveryDocuments.CabDeliveryThreadResolve, {
            thread: a.target.threadNodeId,
          });
          break;
        case "pr.merge": {
          // The one merge write: nothing after it sends the request again, only reads it.
          await this.qualifyStackMerge(a, repo.path);
          const sent = await this.mergeAsync(repo.path, a);
          readback = {
            ...record,
            observation: {
              state: "uncertain",
              reason: "provider-merge-pending",
              receipt: null,
              mergeRequest: {
                ...(sent.uuid ? { uuid: sent.uuid } : {}),
                status: sent.status,
              },
              ...(sent.status === "failed" && sent.message
                ? { hostReason: sent.message }
                : {}),
            },
          };
          break;
        }
      }
      // The write response never establishes success.
      return await this.inspectAction(readback);
    } catch (error) {
      // Only a single-request rejection is definitive. Label removal is multi-effect.
      if (
        error instanceof ProviderFailure &&
        a.kind !== "issue.labels" &&
        [400, 401, 403, 404, 405, 409, 422, 429].includes(error.status)
      )
        return {
          state: "confirmed-failure",
          reason: `provider-http-${error.status}`,
          receipt: null,
          ...(error.resumeAt === undefined
            ? {}
            : { retryable: true, resumeAt: error.resumeAt }),
        };
      return {
        state: "uncertain",
        reason: "provider-effect-unproved",
        receipt: null,
      };
    }
  }
  /** A branch remote for the repository at `path` (`/repos/owner/name`). */
  private remoteAt(path: string): BranchRemote {
    const nameWithOwner = path
      .slice("/repos/".length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    return {
      readRef: (branch) => this.optionalRef(path, branch),
      push: async (request) =>
        this.push({
          ...request,
          host: this.host,
          nameWithOwner,
          token: (await this.credential()) ?? "",
        }),
      adopt: async (request) =>
        this.adopt({
          ...request,
          host: this.host,
          nameWithOwner,
          token: (await this.credential()) ?? "",
        }),
    };
  }
  private readonly branchRemotes: BranchRemotes = {
    recorded: (beforeState) =>
      this.remoteAt(
        z
          .object({
            repositoryPath: z.string().regex(/^\/repos\/[^/]+\/[^/]+$/),
          })
          .parse(beforeState).repositoryPath,
      ),
    verified: async (repositoryId) =>
      this.remoteAt((await this.repository(repositoryId)).path),
  };
  /** Sends the merge once, without a rule bypass; a 409 that names the pending request resolves to it. */
  private async mergeAsync(
    path: string,
    a: Extract<ExternalAction, { kind: "pr.merge" }>,
  ) {
    const url = `${path}/pulls/${a.target.number}/merge-async`;
    try {
      const sent = asyncMergeSchema.parse(
        (
          await this.request(url, "PUT", {
            sha: a.target.expectedHeadSha,
            merge_method: a.method,
            bypass_rules: false,
          })
        ).json,
      );
      return {
        status: sent.status,
        uuid: sent.details.uuid,
        message: sent.details.message?.slice(0, 500),
      };
    } catch (error) {
      const existing =
        error instanceof ProviderFailure && error.status === 409
          ? asyncMergeConflictSchema.safeParse(error.body)
          : undefined;
      if (!existing?.success) throw error;
      return {
        status: "pending" as const,
        uuid: existing.data.details.uuid,
        message: undefined,
      };
    }
  }
  /**
   * A merge the pull request does not show yet. The recorded request is polled, never sent again;
   * an `enqueued` request or an expired one is settled by the pull request itself.
   */
  private async mergeOutcome(
    path: string,
    a: Extract<ExternalAction, { kind: "pr.merge" }>,
    record: DeliveryActionRecord,
    prState: string,
    moved = false,
  ): Promise<ProviderActionObservation> {
    const known = record.observation?.mergeRequest;
    const uncertain = (
      reason: string,
      mergeRequest = known,
    ): ProviderActionObservation => ({
      state: "uncertain",
      reason,
      receipt: null,
      ...(mergeRequest ? { mergeRequest } : {}),
    });
    const failed = (
      mergeRequest: NonNullable<typeof known>,
      hostReason: string | undefined,
    ): ProviderActionObservation => ({
      state: "confirmed-failure",
      reason: "provider-merge-failed",
      receipt: null,
      mergeRequest,
      ...(hostReason ? { hostReason } : {}),
    });
    if (!known) return uncertain("provider-merge-outcome-unknown");
    if (known.status === "failed")
      return failed(known, record.observation?.hostReason);
    if (known.status === "enqueued")
      return prState === "closed" && !moved
        ? {
            state: "confirmed-failure",
            reason: "provider-merge-dequeued",
            receipt: null,
            mergeRequest: known,
          }
        : uncertain("provider-merge-enqueued");
    // Only a pending request has an id to poll; without one the pull request alone settles it.
    if (!known.uuid) return uncertain("provider-merge-outcome-unknown");
    let polled: z.output<typeof asyncMergeSchema>;
    try {
      polled = asyncMergeSchema.parse(
        (
          await this.request(
            `${path}/pulls/${a.target.number}/merge-async/${encodeURIComponent(known.uuid)}`,
          )
        ).json,
      );
    } catch (error) {
      // The result expired: only the pull request can say more, and it did not show a merge.
      if (error instanceof ProviderFailure && error.status === 404)
        return uncertain("provider-merge-outcome-unknown");
      throw error;
    }
    const mergeRequest = { uuid: known.uuid, status: polled.status };
    if (polled.status === "failed")
      return failed(mergeRequest, polled.details.message?.slice(0, 500));
    return uncertain(
      polled.status === "enqueued"
        ? "provider-merge-enqueued"
        : "provider-merge-pending",
      mergeRequest,
    );
  }
  async inspectAction(
    record: DeliveryActionRecord,
  ): Promise<ProviderActionObservation> {
    try {
      const a = record.request.action;
      // An adoption left unsettled by a restart runs again from its recorded context; it needs no
      // repository read of its own, so an outage here can never leave it unproved.
      if (a.kind === "branch.adopt")
        return await adoptBranchHead(record, a, this.branchRemotes);
      const repo = await this.repository(a.target.repositoryId),
        marker = `<!-- cab-operation:${record.operationId} -->`;
      if (a.kind === "branch.push" || a.kind === "branch.force-push")
        return await inspectBranchHead(
          record,
          a,
          record.observation?.pushed === true,
          this.branchRemotes,
        );
      const user = z
        .object({ node_id: name, login: name.optional() })
        .parse((await this.request("/user")).json);
      let receipt: ProviderActionObservation["receipt"] = null;
      if (a.kind === "issue.create") {
        // The search index lags, so this lists the credential user's issues instead. A list that
        // shows no marker proves nothing: the outcome then stays unproved.
        if (!user.login) throw new Error("provider-user-unreadable");
        const since = new Date(record.createdAt - 60_000).toISOString();
        const issues = (
          await this.pages(
            `${repo.path}/issues?creator=${encodeURIComponent(user.login)}&state=all&since=${encodeURIComponent(since)}&per_page=100`,
          )
        )
          .filter((v) => {
            const row = z
              .object({
                body: z.string().nullable(),
                pull_request: z.unknown().optional(),
              })
              .safeParse(v).data;
            return row && !row.pull_request && row.body?.includes(marker);
          })
          .map((v) =>
            z
              .object({
                node_id: name,
                number: z.number().int().positive(),
                title: z.string(),
                body: z.string(),
                labels: z.array(z.object({ name })),
                user: z.object({ node_id: name }),
              })
              .parse(v),
          );
        const found = issues[0];
        if (
          issues.length === 1 &&
          found &&
          found.body === `${a.body}\n\n${marker}` &&
          found.title === a.title &&
          a.labels.every((l) => hasLabel(found.labels, l)) &&
          found.user.node_id === user.node_id
        )
          receipt = { nodeId: found.node_id, number: found.number };
      } else if (a.kind === "project.item.add") {
        const itemId = await this.projectItem(a);
        if (itemId) receipt = { nodeId: itemId };
      } else if (a.kind === "issue.comment") {
        await this.issue(repo.path, a.target);
        const comments = (
          await this.pages(
            `${repo.path}/issues/${a.target.number}/comments?per_page=100`,
          )
        ).map((v) =>
          z
            .object({
              node_id: name,
              body: z.string(),
              user: z.object({ node_id: name }),
            })
            .parse(v),
        );
        const matching = comments.filter((c) => c.body.includes(marker));
        if (
          matching.length === 1 &&
          matching[0]?.body === `${a.body}\n\n${marker}` &&
          matching[0].user.node_id === user.node_id
        )
          receipt = { nodeId: matching[0].node_id };
      } else if (a.kind === "pr.thread.reply") {
        const thread = await this.thread(a.target.threadNodeId, true);
        this.assertThreadOn(thread, a.target);
        const matching = thread.comments.filter((c) => c.body.includes(marker));
        // A reply on the credential user's pending review is not yet visible.
        if (
          matching.length === 1 &&
          matching[0]?.body === `${a.body}\n\n${marker}` &&
          matching[0].state === "SUBMITTED" &&
          matching[0].authorId === user.node_id
        )
          receipt = { nodeId: matching[0].id };
      } else if (a.kind === "pr.thread.resolve") {
        const thread = await this.thread(a.target.threadNodeId, false);
        this.assertThreadOn(thread, a.target);
        if (thread.isResolved && thread.resolvedBy === user.node_id)
          receipt = { nodeId: thread.id };
      } else if (a.kind === "pr.create") {
        // GitHub filters by head owner:branch; the marker filter below keeps
        // unrelated PRs (e.g. a deleted fork's null head.repo) out of strict parsing.
        const head = encodeURIComponent(`${repo.owner}:${a.target.headRef}`);
        const pulls = (
          await this.pages(
            `${repo.path}/pulls?state=all&head=${head}&base=${encodeURIComponent(a.target.baseRef)}&per_page=100`,
          )
        )
          .filter((v) =>
            z
              .object({ body: z.string() })
              .safeParse(v)
              .data?.body.includes(marker),
          )
          .map((v) =>
            z
              .object({
                node_id: name,
                number: z.number().int().positive(),
                title: z.string(),
                body: z.string().nullable(),
                draft: z.boolean(),
                user: z.object({ node_id: name }),
                head: z.object({
                  sha,
                  ref: name,
                  // A deleted fork's head repository is null; it never matches.
                  repo: z.object({ node_id: name }).nullable(),
                }),
                base: z.object({
                  ref: name,
                  repo: z.object({ node_id: name }),
                }),
              })
              .parse(v),
          );
        const p = pulls[0];
        if (
          pulls.length === 1 &&
          p &&
          p.body === `${a.body}\n\n${marker}` &&
          p.title === a.title &&
          p.draft === a.draft &&
          p.user.node_id === user.node_id &&
          p.head.sha === a.target.expectedHeadSha &&
          p.head.ref === a.target.headRef &&
          p.base.ref === a.target.baseRef &&
          p.head.repo?.node_id === a.target.repositoryId &&
          p.base.repo.node_id === a.target.repositoryId
        )
          receipt = {
            nodeId: p.node_id,
            number: p.number,
            headSha: p.head.sha,
          };
      } else if (a.kind.startsWith("pr.") && "expectedHeadSha" in a.target) {
        const p = z
          .object({
            node_id: name,
            number: z.number().int().positive(),
            title: z.string(),
            body: z.string().nullable(),
            draft: z.boolean(),
            merged: z.boolean(),
            head: z.object({
              sha,
              ref: name,
              repo: z.object({ node_id: name }),
            }),
            base: z.object({ ref: name, repo: z.object({ node_id: name }) }),
            state: name,
          })
          .parse(
            (await this.request(`${repo.path}/pulls/${a.target.number}`)).json,
          );
        if (
          p.node_id !== a.target.nodeId ||
          p.number !== a.target.number ||
          p.head.repo.node_id !== a.target.repositoryId ||
          p.base.repo.node_id !== a.target.repositoryId
        )
          throw new Error("provider-pr-mismatch");
        const moved =
          p.head.sha !== a.target.expectedHeadSha ||
          p.head.ref !== a.target.headRef ||
          p.base.ref !== (record.acceptedBaseRef ?? a.target.baseRef);
        // A pull request that moved off the merge target never confirms it, but its recorded merge request can still fail.
        if (moved && a.kind === "pr.merge")
          return await this.mergeOutcome(repo.path, a, record, p.state, true);
        if (moved) throw new Error("provider-pr-mismatch");
        const matches =
          a.kind === "pr.ready"
            ? !p.draft
            : a.kind === "pr.merge"
              ? p.merged
              : a.kind === "pr.edit"
                ? (a.fields.title === undefined ||
                    p.title === a.fields.title) &&
                  (a.fields.body === undefined || p.body === a.fields.body)
                : false;
        if (matches)
          receipt = {
            nodeId: p.node_id,
            number: p.number,
            headSha: p.head.sha,
            merged: p.merged,
          };
        else if (a.kind === "pr.merge")
          return await this.mergeOutcome(repo.path, a, record, p.state);
      } else if ("number" in a.target) {
        const issue = await this.issue(repo.path, a.target);
        let matches = false;
        if (a.kind === "issue.close") matches = issue.state === "closed";
        if (a.kind === "issue.edit")
          matches =
            (a.fields.title === undefined || issue.title === a.fields.title) &&
            (a.fields.body === undefined || issue.body === a.fields.body);
        if (a.kind === "issue.labels")
          matches =
            a.add.every((l) => hasLabel(issue.labels, l)) &&
            a.remove.every((l) => !hasLabel(issue.labels, l));
        if (a.kind === "project.field")
          matches = (await this.projectField(a)) === a.optionNodeId;
        if (matches)
          receipt = {
            nodeId: issue.node_id,
            number: issue.number,
            issueClosed: issue.state === "closed",
          };
      }
      return actionObservationSchema.parse({
        state: receipt ? "confirmed-success" : "uncertain",
        reason: receipt ? null : "provider-effect-unproved",
        receipt,
      });
    } catch {
      return {
        state: "uncertain",
        reason: "provider-readback-unavailable",
        receipt: null,
        // A readback failure never forgets the code host's merge request, nor that Git reported the push done.
        ...(record.observation?.mergeRequest
          ? { mergeRequest: record.observation.mergeRequest }
          : {}),
        ...(record.observation?.hostReason
          ? { hostReason: record.observation.hostReason }
          : {}),
        ...(record.observation?.pushed ? { pushed: true } : {}),
        ...(record.observation?.rejected ? { rejected: true } : {}),
        ...(record.observation?.ambiguous ? { ambiguous: true } : {}),
      };
    }
  }
}
