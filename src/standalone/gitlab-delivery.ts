import { z } from "zod";
import { DomainPolicyError, type DomainStore } from "../core/domain.js";
import {
  type DeliveryActionRecord,
  type DeliveryPolicy,
  type ExternalAction,
  type PrDeliveryObservation,
  type ProviderActionObservation,
  isRuntimeDeliveryCaller,
  prObservationSchema,
} from "../core/delivery.js";
import { isGitLabProjectPath } from "../core/github-source.js";
import {
  type BranchRemote,
  type BranchRemotes,
  adoptBranchHead,
  branchPreflight,
  isBranchAction,
  isBranchKind,
  inspectBranchHead,
  publishBranch,
} from "./branch-delivery.js";
import type {
  CodeHostDeliveryProvider,
  CodeHostProviderFactory,
} from "./code-host.js";
import { type AdoptFunction, adoptOutsideHead } from "./git-fetch.js";
import { pushTaskCommit } from "./git-push.js";
import type {
  AdoptionContext,
  PrIdentity,
  PublicationContext,
  PushFunction,
} from "./github-delivery.js";
import { type GitLabSeams, codeHostToken } from "./gitlab-credentials.js";

/** A non-2xx response. Only the status is kept: never a body or a header. */
class GitLabFailure extends Error {
  constructor(readonly status: number) {
    super(`provider-http-${status}`);
  }
}

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const userId = z.object({ id: z.number().int() });
const mergeRequestFields = {
  id: z.number().int().positive(),
  iid: z.number().int().positive(),
  source_project_id: z.number().int(),
  target_project_id: z.number().int(),
  source_branch: z.string().min(1),
  target_branch: z.string().min(1),
  sha,
  title: z.string(),
  description: z.string().nullable(),
  draft: z.boolean(),
  author: userId,
};
const mergeRequestSchema = z.object({
  ...mergeRequestFields,
  state: z.enum(["opened", "locked", "merged", "closed"]),
  diff_refs: z.object({ base_sha: sha.nullable() }).nullable(),
  head_pipeline: z
    .object({
      id: z.number().int(),
      sha: z.string(),
      status: z.string(),
      started_at: z.string().nullable(),
      finished_at: z.string().nullable(),
    })
    .nullish(),
});
const noteSchema = z.object({
  id: z.number().int(),
  type: z.string().nullable(),
  system: z.boolean(),
  body: z.string(),
  author: userId,
  updated_at: z.string().min(1),
  resolvable: z.boolean(),
  resolved: z.boolean().optional(),
  resolved_by: userId.nullish(),
  position: z.object({ head_sha: z.string().nullish() }).nullish(),
});
const discussionSchema = z.object({
  id: z.string().min(1),
  individual_note: z.boolean(),
  notes: z.array(noteSchema).min(1),
});
type Discussion = z.output<typeof discussionSchema>;
type MergeRequest = z.output<typeof mergeRequestSchema>;

/** GitLab has no draft field to write: a draft is a title that starts with `Draft:` (or its variants). */
const draftPrefix = /^\s*(\[draft\]|\(draft\)|draft:)/i;
const quickAction = /^\s*\/[A-Za-z]/m;
const draftTitle = (title: string, draft: boolean) =>
  draft ? `Draft: ${title}` : title;
const pipelineStatus = (status: string) =>
  status === "success" || status === "skipped"
    ? "success"
    : status === "failed" || status === "canceled"
      ? "failure"
      : "pending";

/** A resolvable thread's identity and state, from its non-system notes; null for any other discussion. */
function threadOf(d: Discussion) {
  const notes = d.notes.filter((n) => !n.system);
  const first = notes[0];
  const last = notes[notes.length - 1];
  if (d.individual_note || !first?.resolvable || !last) return null;
  return {
    nodeId: d.id,
    isResolved: notes.filter((n) => n.resolvable).every((n) => n.resolved),
    firstCommentNodeId: String(first.id),
    latestCommentNodeId: String(last.id),
  };
}

type ChangeRequestAction = Extract<
  ExternalAction,
  {
    kind:
      | "pr.create"
      | "pr.edit"
      | "pr.ready"
      | "pr.thread.reply"
      | "pr.thread.resolve";
  }
>;
const changeRequestKinds: readonly string[] = [
  "pr.create",
  "pr.edit",
  "pr.ready",
  "pr.thread.reply",
  "pr.thread.resolve",
];
const isChangeRequestAction = (a: ExternalAction): a is ChangeRequestAction =>
  changeRequestKinds.includes(a.kind);

export interface GitLabDeliveryOptions {
  /** The lowercase DNS name of the GitLab instance. */
  host: string;
  /** The project's linked GitLab project on `host` for a numeric ID, or null when it is not linked. */
  link: (repositoryId: string) => { projectPath: string } | null;
  /** The host's code-host credential, resolved on every use; null when it is unusable. */
  token: () => Promise<string | null>;
  fetcher?: typeof fetch | undefined;
  push?: PushFunction | undefined;
  adopt?: AdoptFunction | undefined;
}

/**
 * Branch and merge request delivery on a GitLab project. Every request goes to `https://<host>` with the host
 * credential as a bearer token and refuses redirects. The project is verified against the link
 * (numeric ID and path) before any push or fetch, and Git uses the path the API reports. The token
 * goes only to the request header and the Git child's environment.
 */
export class GitLabHttpDeliveryProvider implements CodeHostDeliveryProvider {
  private readonly origin: string;
  constructor(private readonly options: GitLabDeliveryOptions) {
    this.origin = `https://${options.host}`;
  }
  supportsAction(kind: ExternalAction["kind"]): boolean {
    return isBranchKind(kind) || changeRequestKinds.includes(kind);
  }
  private async token(): Promise<string> {
    const token = await this.options.token();
    // Printable ASCII only: anything else cannot be a token, and an invalid header value would be echoed in the error.
    if (!token || !/^[\x21-\x7e]+$/.test(token))
      throw new Error("provider-credential-unavailable");
    return token;
  }
  /** For Git: a credential that vanished after preflight is an empty token, which the transport reports as not attempted. */
  private transportToken(): Promise<string> {
    return this.token().catch(() => "");
  }
  /** One request to the instance; a redirect, another origin or a non-2xx status is a failure. */
  private async send(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const token = await this.token();
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new Error("provider-origin-mismatch");
    const response = await (this.options.fetcher ?? fetch)(url.href, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // A redirect could carry the token to another origin.
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400) ||
      (response.url && new URL(response.url).origin !== this.origin)
    ) {
      await response.body?.cancel().catch(() => {});
      throw new Error("provider-origin-mismatch");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new GitLabFailure(response.status);
    }
    return response;
  }
  private async get(path: string): Promise<unknown> {
    return (await this.send("GET", `/api/v4${path}`)).json();
  }
  /** A write whose response is never trusted: an independent read settles it. */
  private async write(
    method: "POST" | "PUT",
    path: string,
    body: unknown,
  ): Promise<void> {
    const response = await this.send(method, `/api/v4${path}`, body);
    await response.body?.cancel().catch(() => {});
  }
  /** Every row of a list, following `x-next-page` up to a fixed bound; an incomplete list is a failure. */
  private async pages(path: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    let next: string | null = "1";
    for (let count = 0; count < 20 && next; count++) {
      const response: Response = await this.send(
        "GET",
        `/api/v4${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${next}`,
      );
      rows.push(...z.array(z.unknown()).parse(await response.json()));
      next = response.headers.get("x-next-page") || null;
      if (next !== null && !/^[1-9][0-9]{0,5}$/.test(next))
        throw new Error("provider-pages-unreadable");
    }
    if (next) throw new Error("provider-pages-incomplete");
    return rows;
  }
  /** The project the link names, confirmed by the API; its path is the one Git uses. */
  private async project(repositoryId: string) {
    const link = this.options.link(repositoryId);
    if (!link) throw new Error("provider-repository-mismatch");
    const value = z
      .object({ id: z.number().int(), path_with_namespace: z.string() })
      .parse(await this.get(`/projects/${repositoryId}`));
    if (
      String(value.id) !== repositoryId ||
      value.path_with_namespace.toLowerCase() !==
        link.projectPath.toLowerCase() ||
      !isGitLabProjectPath(value.path_with_namespace)
    )
      throw new Error("provider-repository-mismatch");
    return value.path_with_namespace;
  }
  private remoteFor(repositoryId: string, projectPath: string): BranchRemote {
    return {
      readRef: async (branch) => {
        try {
          const value = z
            .object({
              name: z.string(),
              commit: z.object({ id: z.string().regex(/^[0-9a-f]{40}$/) }),
            })
            .parse(
              await this.get(
                `/projects/${repositoryId}/repository/branches/${encodeURIComponent(branch)}`,
              ),
            );
          if (value.name !== branch) throw new Error("provider-ref-mismatch");
          return value.commit.id;
        } catch (error) {
          // A 404 means no such branch only while the project itself still reads.
          if (!(error instanceof GitLabFailure) || error.status !== 404)
            throw error;
          await this.project(repositoryId);
          return null;
        }
      },
      push: async (request) =>
        (this.options.push ?? pushTaskCommit)({
          ...request,
          host: this.options.host,
          codeHost: "gitlab",
          nameWithOwner: projectPath,
          token: await this.transportToken(),
        }),
      adopt: async (request) =>
        (this.options.adopt ?? adoptOutsideHead)({
          ...request,
          host: this.options.host,
          codeHost: "gitlab",
          nameWithOwner: projectPath,
          token: await this.transportToken(),
        }),
    };
  }
  private readonly remotes: BranchRemotes = {
    recorded: (beforeState) => {
      const recorded = z
        .object({
          repositoryPath: z.string().regex(/^\/projects\/[1-9][0-9]{0,18}$/),
          projectPath: z.string().refine(isGitLabProjectPath),
        })
        .parse(beforeState);
      return this.remoteFor(
        recorded.repositoryPath.slice("/projects/".length),
        recorded.projectPath,
      );
    },
    verified: async (repositoryId) =>
      this.remoteFor(repositoryId, await this.project(repositoryId)),
  };
  /** The merge request a target names: the same instance-wide ID and IID, and never a fork. */
  private async boundMergeRequest(target: {
    repositoryId: string;
    nodeId: string;
    number: number;
  }): Promise<MergeRequest> {
    const mr = mergeRequestSchema.parse(
      await this.get(
        `/projects/${target.repositoryId}/merge_requests/${target.number}`,
      ),
    );
    if (
      String(mr.id) !== target.nodeId ||
      mr.iid !== target.number ||
      String(mr.source_project_id) !== target.repositoryId ||
      String(mr.target_project_id) !== target.repositoryId
    )
      throw new Error("provider-pr-mismatch");
    return mr;
  }
  /** The merge request an edit or ready names, still at the head and branches the action saw. */
  private async targetMergeRequest(
    target: Parameters<typeof this.boundMergeRequest>[0] & {
      baseRef: string;
      headRef: string;
      expectedHeadSha: string;
    },
  ) {
    const mr = await this.boundMergeRequest(target);
    if (
      mr.sha !== target.expectedHeadSha ||
      mr.source_branch !== target.headRef ||
      mr.target_branch !== target.baseRef
    )
      throw new Error("provider-head-changed");
    return mr;
  }
  /** A discussion that is a resolvable thread on the bound merge request. */
  private async thread(
    target: Parameters<typeof this.boundMergeRequest>[0] & {
      threadNodeId: string;
    },
  ) {
    await this.boundMergeRequest(target);
    const discussion = discussionSchema.parse(
      await this.get(
        `/projects/${target.repositoryId}/merge_requests/${target.number}/discussions/${encodeURIComponent(target.threadNodeId)}`,
      ),
    );
    const thread = threadOf(discussion);
    if (!thread || thread.nodeId !== target.threadNodeId)
      throw new Error("provider-thread-mismatch");
    return { discussion, ...thread };
  }
  async preflight(
    action: ExternalAction,
    _policy: DeliveryPolicy,
    publication?: PublicationContext,
    adoption?: AdoptionContext,
  ): ReturnType<CodeHostDeliveryProvider["preflight"]> {
    if (!isBranchAction(action) && !isChangeRequestAction(action))
      throw new Error("provider-action-unsupported");
    const repositoryId = action.target.repositoryId;
    const projectPath = await this.project(repositoryId);
    const recorded = {
      repositoryPath: `/projects/${repositoryId}`,
      projectPath,
    };
    if (isBranchAction(action))
      return {
        ...recorded,
        ...(await branchPreflight(
          action,
          this.remoteFor(repositoryId, projectPath),
          publication,
          adoption,
        )),
      };
    // Draft status is the title's prefix, so a title that carries one could change it unseen.
    if (
      (action.kind === "pr.create" && draftPrefix.test(action.title)) ||
      (action.kind === "pr.edit" &&
        action.fields.title !== undefined &&
        draftPrefix.test(action.fields.title))
    )
      throw new Error("provider-title-draft-prefix");
    // GitLab runs a line that starts with `/command` in a description or note as the credential
    // user, which would bypass the grants (`/merge`, `/ready`, `/close`), so such text is held.
    const text =
      action.kind === "pr.create"
        ? action.body
        : action.kind === "pr.edit"
          ? action.fields.body
          : action.kind === "pr.thread.reply"
            ? action.body
            : undefined;
    if (text !== undefined && quickAction.test(text))
      throw new Error("provider-quick-action-held");
    if (action.kind === "pr.create") {
      const remote = this.remoteFor(repositoryId, projectPath);
      const head = await remote.readRef(action.target.headRef);
      if (!(await remote.readRef(action.target.baseRef)))
        throw new Error("provider-ref-missing");
      if (head !== action.target.expectedHeadSha)
        throw new Error("provider-head-changed");
      return { ...recorded, repositoryId, headSha: head };
    }
    if (
      action.kind === "pr.thread.reply" ||
      action.kind === "pr.thread.resolve"
    ) {
      const thread = await this.thread(action.target);
      if (
        action.kind === "pr.thread.resolve" &&
        (thread.isResolved ||
          thread.latestCommentNodeId !== action.expectedLatestCommentNodeId)
      )
        throw new Error("provider-thread-resolve-held");
      return {
        ...recorded,
        threadNodeId: thread.nodeId,
        latestCommentNodeId: thread.latestCommentNodeId,
        isResolved: thread.isResolved,
      };
    }
    const mr = await this.targetMergeRequest(action.target);
    return { ...recorded, draft: mr.draft };
  }
  async performAction(
    record: DeliveryActionRecord,
  ): Promise<ProviderActionObservation> {
    const a = record.request.action;
    if (
      !isRuntimeDeliveryCaller(record.binding) ||
      !(isBranchAction(a) || isChangeRequestAction(a))
    )
      throw new DomainPolicyError(
        "forbidden",
        "GitLab delivery only permits a task's branch and merge request actions",
      );
    if (isBranchAction(a))
      return a.kind === "branch.adopt"
        ? adoptBranchHead(record, a, this.remotes)
        : publishBranch(record, a, this.remotes);
    try {
      const recorded = z
        .object({
          repositoryPath: z.string(),
          projectPath: z.string().refine(isGitLabProjectPath),
        })
        .parse(record.beforeState);
      const id = a.target.repositoryId;
      if (recorded.repositoryPath !== `/projects/${id}`)
        throw new Error("provider-repository-mismatch");
      const requests = `/projects/${id}/merge_requests`;
      const marker = `<!-- cab-operation:${record.operationId} -->`;
      switch (a.kind) {
        case "pr.create":
          await this.write("POST", requests, {
            source_branch: a.target.headRef,
            target_branch: a.target.baseRef,
            title: draftTitle(a.title, a.draft),
            description: `${a.body}\n\n${marker}`,
          });
          break;
        case "pr.edit":
          await this.write("PUT", `${requests}/${a.target.number}`, {
            ...(a.fields.title === undefined
              ? {}
              : {
                  title: draftTitle(
                    a.fields.title,
                    record.beforeState?.draft === true,
                  ),
                }),
            ...(a.fields.body === undefined
              ? {}
              : { description: a.fields.body }),
          });
          break;
        case "pr.ready":
          // REST has no draft field; the title prefix is cleared by GraphQL's own mutation.
          {
            const response = await this.send("POST", "/api/graphql", {
              query:
                "mutation($projectPath: ID!, $iid: String!) { mergeRequestSetDraft(input: { projectPath: $projectPath, iid: $iid, draft: false }) { errors } }",
              variables: {
                projectPath: recorded.projectPath,
                iid: String(a.target.number),
              },
            });
            await response.body?.cancel().catch(() => {});
          }
          break;
        case "pr.thread.reply":
          await this.write(
            "POST",
            `${requests}/${a.target.number}/discussions/${encodeURIComponent(a.target.threadNodeId)}/notes`,
            { body: `${a.body}\n\n${marker}` },
          );
          break;
        case "pr.thread.resolve":
          await this.write(
            "PUT",
            `${requests}/${a.target.number}/discussions/${encodeURIComponent(a.target.threadNodeId)}?resolved=true`,
            {},
          );
          break;
      }
      // The write response never establishes success.
      return await this.inspectAction(record);
    } catch (error) {
      // Only a single-request rejection is definitive.
      if (
        error instanceof GitLabFailure &&
        [400, 401, 403, 404, 405, 409, 422, 429].includes(error.status)
      )
        return {
          state: "confirmed-failure",
          reason: `provider-http-${error.status}`,
          receipt: null,
        };
      return {
        state: "uncertain",
        reason: "provider-effect-unproved",
        receipt: null,
      };
    }
  }
  async inspectAction(
    record: DeliveryActionRecord,
  ): Promise<ProviderActionObservation> {
    const a = record.request.action;
    if (isBranchAction(a))
      // An adoption left unsettled by a restart runs again from its recorded context.
      return a.kind === "branch.adopt"
        ? adoptBranchHead(record, a, this.remotes)
        : inspectBranchHead(
            record,
            a,
            record.observation?.pushed === true,
            this.remotes,
          );
    if (!isChangeRequestAction(a))
      throw new Error("provider-action-unsupported");
    try {
      const id = a.target.repositoryId;
      const marker = `<!-- cab-operation:${record.operationId} -->`;
      const user = userId.parse(await this.get("/user"));
      let receipt: ProviderActionObservation["receipt"] = null;
      if (a.kind === "pr.create") {
        const query = new URLSearchParams({
          state: "all",
          source_branch: a.target.headRef,
          target_branch: a.target.baseRef,
          author_id: String(user.id),
        });
        const found = (
          await this.pages(`/projects/${id}/merge_requests?${query}`)
        )
          .filter((v) =>
            z
              .object({ description: z.string() })
              .safeParse(v)
              .data?.description.includes(marker),
          )
          .map((v) => z.object(mergeRequestFields).parse(v));
        const mr = found[0];
        if (
          found.length === 1 &&
          mr &&
          mr.description === `${a.body}\n\n${marker}` &&
          mr.title === draftTitle(a.title, a.draft) &&
          mr.draft === a.draft &&
          mr.author.id === user.id &&
          mr.sha === a.target.expectedHeadSha &&
          mr.source_branch === a.target.headRef &&
          mr.target_branch === a.target.baseRef &&
          String(mr.source_project_id) === id &&
          String(mr.target_project_id) === id
        )
          receipt = { nodeId: String(mr.id), number: mr.iid, headSha: mr.sha };
      } else if (a.kind === "pr.edit" || a.kind === "pr.ready") {
        const mr = await this.targetMergeRequest(a.target);
        const matches =
          a.kind === "pr.ready"
            ? !mr.draft
            : (a.fields.title === undefined ||
                mr.title ===
                  draftTitle(
                    a.fields.title,
                    record.beforeState?.draft === true,
                  )) &&
              (a.fields.body === undefined ||
                (mr.description ?? "") === a.fields.body);
        if (matches)
          receipt = { nodeId: String(mr.id), number: mr.iid, headSha: mr.sha };
      } else {
        const { discussion, ...thread } = await this.thread(a.target);
        if (a.kind === "pr.thread.reply") {
          const matching = discussion.notes.filter((n) =>
            n.body.includes(marker),
          );
          const note = matching[0];
          if (
            matching.length === 1 &&
            note &&
            note.body === `${a.body}\n\n${marker}` &&
            note.author.id === user.id
          )
            receipt = { nodeId: String(note.id) };
        } else {
          const resolver = discussion.notes
            .filter((n) => n.resolvable)
            .at(-1)?.resolved_by;
          if (thread.isResolved && resolver?.id === user.id)
            receipt = { nodeId: thread.nodeId };
        }
      }
      return {
        state: receipt ? "confirmed-success" : "uncertain",
        reason: receipt ? null : "provider-effect-unproved",
        receipt,
      };
    } catch {
      return {
        state: "uncertain",
        reason: "provider-readback-unavailable",
        receipt: null,
      };
    }
  }
  async inspectPr(
    identity: PrIdentity,
    _policy: DeliveryPolicy,
  ): Promise<PrDeliveryObservation> {
    const id = identity.repositoryId;
    await this.project(id);
    const mr = await this.boundMergeRequest({
      repositoryId: id,
      nodeId: identity.expectedPrNodeId,
      number: identity.prNumber,
    });
    if (!mr.diff_refs?.base_sha) throw new Error("provider-pr-unreadable");
    const pipeline = mr.head_pipeline?.sha === mr.sha ? mr.head_pipeline : null;
    const feedback: NonNullable<PrDeliveryObservation["feedback"]> = [];
    const reviewThreads: NonNullable<PrDeliveryObservation["reviewThreads"]> =
      [];
    for (const value of await this.pages(
      `/projects/${id}/merge_requests/${mr.iid}/discussions`,
    )) {
      const discussion = discussionSchema.parse(value);
      // A push or a label change adds system notes; they are not feedback.
      for (const n of discussion.notes)
        if (!n.system)
          feedback.push({
            kind: n.type === "DiffNote" ? "review-comment" : "comment",
            nodeId: String(n.id),
            author: String(n.author.id),
            updatedAt: n.updated_at,
            state: "COMMENTED",
            body: n.body.slice(0, 2000),
            commitSha: n.position?.head_sha ?? null,
          });
      const thread = threadOf(discussion);
      if (thread) reviewThreads.push(thread);
    }
    // Nothing volatile and a fixed order: an unchanged merge request has an unchanged digest.
    feedback.sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) || a.nodeId.localeCompare(b.nodeId),
    );
    reviewThreads.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    return prObservationSchema.parse({
      repositoryId: id,
      nodeId: String(mr.id),
      number: mr.iid,
      baseRef: mr.target_branch,
      headRef: mr.source_branch,
      headSha: mr.sha,
      baseSha: mr.diff_refs.base_sha,
      state:
        mr.state === "merged"
          ? "MERGED"
          : mr.state === "closed"
            ? "CLOSED"
            : "OPEN",
      draft: mr.draft,
      merged: mr.state === "merged",
      reviewDecision: null,
      checks: pipeline
        ? [
            {
              name: "pipeline",
              appId: null,
              sha: pipeline.sha,
              status: pipelineStatus(pipeline.status),
              nodeId: String(pipeline.id),
              updatedAt:
                pipeline.finished_at ?? pipeline.started_at ?? "unproved",
            },
          ]
        : [],
      feedback,
      reviewThreads,
      // Merging a merge request is not delivered yet (#1315).
      mergeBlockers: ["merge-unsupported"],
      closedIssueNodeIds: [],
      allowedMethods: [],
    });
  }
}

/**
 * Builds the GitLab provider for a project's repository link on `host`. The credential is the
 * installation's code-host credential for that host, read again on every use; it is only the
 * identity that acts, and the project's delivery grants still decide what may be done.
 */
export function gitLabDeliveryFactory(
  domain: Pick<DomainStore, "repositoryLinks" | "codeHostCredentials"> &
    Parameters<typeof codeHostToken>[0],
  seams: GitLabSeams & {
    fetcher?: typeof fetch | undefined;
    push?: PushFunction | undefined;
    adopt?: AdoptFunction | undefined;
  },
): CodeHostProviderFactory {
  return (projectId, _policy, host) =>
    new GitLabHttpDeliveryProvider({
      host,
      link: (repositoryId) => {
        const link = domain
          .repositoryLinks(projectId)
          .links.find(
            (l) =>
              l.codeHost === "gitlab" &&
              l.host === host &&
              l.repositoryId === repositoryId,
          );
        return link?.codeHost === "gitlab"
          ? { projectPath: link.projectPath }
          : null;
      },
      token: () => codeHostToken(domain, seams, host),
      fetcher: seams.fetcher,
      push: seams.push,
      adopt: seams.adopt,
    });
}
