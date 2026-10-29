import { createHash } from "node:crypto";
import type { DomainStore } from "../core/domain.js";
import {
  GitLabDiscoveryFailure,
  GitLabDiscoveryReader,
  type GitLabFailureReason,
} from "./gitlab-discovery.js";
import {
  glabEnvironment,
  glabOverridden,
  glabToken,
} from "./glab-credential.js";

export type GitLabCredentialReason =
  | GitLabFailureReason
  | "missing-credential"
  | "glab-not-installed"
  | "glab-not-signed-in"
  | "glab-unreadable";

/** Test seams: the `glab` executable and the GitLab reader factory. */
export interface GitLabSeams {
  /** Defaults to `glab` on the service `PATH`. */
  glabExecutable?: string | undefined;
  gitlab?: (host: string, token: string) => GitLabReads;
}
export type GitLabReads = Pick<GitLabDiscoveryReader, "user" | "projects">;
type Domain = Pick<DomainStore, "codeHostCredentials"> &
  Parameters<typeof glabEnvironment>[0];

const reasonOf = (error: unknown): GitLabCredentialReason =>
  error instanceof GitLabDiscoveryFailure ? error.reason : "unreadable";

/** The credential's token, resolved on every call: a `glab:` login or an `env:` variable. */
async function resolve(
  domain: Domain,
  seams: GitLabSeams,
  { host, credentialRef: ref }: { host: string; credentialRef: string },
): Promise<{ token: string } | { reason: GitLabCredentialReason }> {
  if (ref.startsWith("env:")) {
    const token = process.env[ref.slice(4)];
    return token ? { token } : { reason: "missing-credential" };
  }
  const result = await glabToken(host, {
    executable: seams.glabExecutable,
    environment: glabEnvironment(domain),
  });
  return "token" in result
    ? result
    : { reason: `glab-${result.state}` as GitLabCredentialReason };
}

/** The token of the host's configured credential, or null when there is none or it is unusable. */
export async function codeHostToken(
  domain: Domain,
  seams: GitLabSeams,
  host: string,
): Promise<string | null> {
  const ref = domain
    .codeHostCredentials()
    .find((c) => c.host === host)?.credentialRef;
  if (!ref) return null;
  const resolved = await resolve(domain, seams, { host, credentialRef: ref });
  return "token" in resolved ? resolved.token : null;
}

const overridden = (domain: Domain, ref: string) =>
  ref.startsWith("glab:") && glabOverridden(glabEnvironment(domain));

/**
 * Whether the configured GitLab credentials resolve and whether a `glab` login is shadowed by
 * a token variable. No cab request to GitLab; glab itself may contact the host, within its time limit.
 */
export async function gitLabCredentialLocalState(
  domain: Domain,
  seams: GitLabSeams,
): Promise<{ configured: boolean; unusable: boolean; overridden: boolean }> {
  const credentials = domain.codeHostCredentials();
  const resolved = await Promise.all(
    credentials.map((c) => resolve(domain, seams, c)),
  );
  return {
    configured: credentials.length > 0,
    unusable: resolved.some((r) => "reason" in r),
    overridden: credentials.some((c) => overridden(domain, c.credentialRef)),
  };
}

/** Each configured host's kind, usability and the account its token acts as; never a token. */
export async function readCodeHostCredentials(
  domain: Domain,
  seams: GitLabSeams,
) {
  return Promise.all(
    domain.codeHostCredentials().map(async (c) => {
      const base = {
        codeHost: c.codeHost,
        host: c.host,
        kind: c.credentialRef.startsWith("glab:")
          ? ("glab" as const)
          : ("env" as const),
        glabOverridden: overridden(domain, c.credentialRef),
      };
      const resolved = await resolve(domain, seams, c);
      if ("reason" in resolved)
        return {
          ...base,
          state: "unavailable" as const,
          reason: resolved.reason,
        };
      try {
        const reader = (seams.gitlab ?? defaultReader)(c.host, resolved.token);
        return {
          ...base,
          state: "usable" as const,
          account: (await reader.user()).username,
        };
      } catch (error) {
        return {
          ...base,
          state: "unavailable" as const,
          reason: reasonOf(error),
        };
      }
    }),
  );
}

const defaultReader = (host: string, token: string) =>
  new GitLabDiscoveryReader(host, token);

/** What a read was made with, so a credential changed meanwhile discards the result. */
function fence(domain: Domain, host: string) {
  const ref =
    domain.codeHostCredentials().find((c) => c.host === host)?.credentialRef ??
    null;
  return JSON.stringify([
    ref,
    createHash("sha256")
      .update(ref?.startsWith("env:") ? (process.env[ref.slice(4)] ?? "") : "")
      .digest("hex"),
  ]);
}

/**
 * Projects the host's credential can see, for guided setup. A result read with a credential
 * that changed meanwhile is discarded and read once more; a second change leaves it unreadable.
 */
export async function readGitLabProjects(
  domain: Domain,
  seams: GitLabSeams,
  host: string,
) {
  const unavailable = (reason: GitLabCredentialReason | "unconfigured") => ({
    state: "unavailable" as const,
    reason,
  });
  type Read =
    | ReturnType<typeof unavailable>
    | ({ state: "ready" } & Awaited<ReturnType<GitLabReads["projects"]>>);
  let data: Read = unavailable("unreadable");
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = fence(domain, host);
    const ref = domain
      .codeHostCredentials()
      .find((c) => c.host === host)?.credentialRef;
    let current: Read;
    if (!ref) current = unavailable("unconfigured");
    else {
      const resolved = await resolve(domain, seams, {
        host,
        credentialRef: ref,
      });
      if ("reason" in resolved) current = unavailable(resolved.reason);
      else
        try {
          current = {
            state: "ready",
            ...(await (seams.gitlab ?? defaultReader)(
              host,
              resolved.token,
            ).projects()),
          };
        } catch (error) {
          current = unavailable(reasonOf(error));
        }
    }
    if (before === fence(domain, host)) {
      data = current;
      break;
    }
  }
  return data;
}
