import { z } from "zod";
import { DomainPolicyError, type DomainStore } from "../core/domain.js";
import {
  type DeliveryActionRecord,
  type DeliveryPolicy,
  type ExternalAction,
  type PrDeliveryObservation,
  type ProviderActionObservation,
  isRuntimeDeliveryCaller,
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
 * Branch delivery on a GitLab project. Every request goes to `https://<host>` with the host
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
    return isBranchKind(kind);
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
  private async get(path: string): Promise<unknown> {
    const token = await this.token();
    const url = new URL(`/api/v4${path}`, this.origin);
    if (url.origin !== this.origin) throw new Error("provider-origin-mismatch");
    const response = await (this.options.fetcher ?? fetch)(url.href, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
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
    return response.json();
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
  async preflight(
    action: ExternalAction,
    _policy: DeliveryPolicy,
    publication?: PublicationContext,
    adoption?: AdoptionContext,
  ) {
    if (!isBranchAction(action)) throw new Error("provider-action-unsupported");
    const repositoryId = action.target.repositoryId;
    const projectPath = await this.project(repositoryId);
    return {
      repositoryPath: `/projects/${repositoryId}`,
      projectPath,
      ...(await branchPreflight(
        action,
        this.remoteFor(repositoryId, projectPath),
        publication,
        adoption,
      )),
    };
  }
  async performAction(
    record: DeliveryActionRecord,
  ): Promise<ProviderActionObservation> {
    const a = record.request.action;
    if (!isRuntimeDeliveryCaller(record.binding) || !isBranchAction(a))
      throw new DomainPolicyError(
        "forbidden",
        "GitLab delivery only permits a task's branch actions",
      );
    return a.kind === "branch.adopt"
      ? adoptBranchHead(record, a, this.remotes)
      : publishBranch(record, a, this.remotes);
  }
  async inspectAction(
    record: DeliveryActionRecord,
  ): Promise<ProviderActionObservation> {
    const a = record.request.action;
    if (!isBranchAction(a)) throw new Error("provider-action-unsupported");
    // An adoption left unsettled by a restart runs again from its recorded context.
    return a.kind === "branch.adopt"
      ? adoptBranchHead(record, a, this.remotes)
      : inspectBranchHead(
          record,
          a,
          record.observation?.pushed === true,
          this.remotes,
        );
  }
  async inspectPr(
    _identity: PrIdentity,
    _policy: DeliveryPolicy,
  ): Promise<PrDeliveryObservation> {
    throw new Error("provider-change-request-unavailable");
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
