import { z } from "zod";
import type { DomainStore } from "../core/domain.js";
import { JiraFailure, type JiraAccess, jiraRequest } from "./jira-http.js";

export type JiraCredentialReason =
  | "missing-credential"
  | "site-invalid"
  | "site-mismatch"
  | "site-unreachable"
  | "not-jira"
  | "unauthorized";

/** The three `env:` references of one Jira site. */
type JiraRefs = ReturnType<DomainStore["issueTrackerCredentials"]>[number];

const printable = /^[\x20-\x7e]{1,512}$/;
const envValue = (ref: string, env: NodeJS.ProcessEnv) =>
  env[ref.slice(4)] ?? "";

/** Jira Cloud sites only; credentials are never sent to another host (Data Center is out of scope). */
const jiraCloudHost =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:atlassian\.net|jira\.com)$/;

/**
 * The host of a Jira site variable: an `https://` origin with no path, credentials, port,
 * query or fragment. Anything else is not a site cab sends credentials to.
 */
export function jiraSiteHost(
  value: string,
): { instance: string } | { reason: "missing-credential" | "site-invalid" } {
  if (!value) return { reason: "missing-credential" };
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !jiraCloudHost.test(url.hostname)
    )
      return { reason: "site-invalid" };
    return { instance: url.hostname };
  } catch {
    return { reason: "site-invalid" };
  }
}

/**
 * Resolves a site's credential on every use, so a changed variable is seen at once. Fails
 * closed with `site-mismatch` when the site variable now names another host than the one
 * the credential was configured for.
 */
export function resolveJiraAccess(
  refs: JiraRefs | undefined,
  env: NodeJS.ProcessEnv = process.env,
):
  | JiraAccess
  | { reason: "missing-credential" | "site-invalid" | "site-mismatch" } {
  if (!refs) return { reason: "missing-credential" };
  const site = jiraSiteHost(envValue(refs.siteRef, env));
  if ("reason" in site) return site;
  const email = envValue(refs.emailRef, env);
  const token = envValue(refs.tokenRef, env);
  if (!printable.test(email) || !printable.test(token))
    return { reason: "missing-credential" };
  if (site.instance !== refs.instance) return { reason: "site-mismatch" };
  return { instance: site.instance, email, token };
}

const myselfSchema = z
  .object({ accountId: z.string().min(1), displayName: z.string() })
  .passthrough();

export type JiraCredentialStatus =
  | {
      usable: true;
      account: { accountId: string; displayName: string };
      reason: null;
    }
  | { usable: false; account: null; reason: JiraCredentialReason };

/** Whether the site's credential works and the account it acts as; never a secret. */
export async function jiraCredentialStatus(
  access: JiraAccess | { reason: JiraCredentialReason },
  fetcher: typeof fetch = fetch,
): Promise<JiraCredentialStatus> {
  const unusable = (reason: JiraCredentialReason): JiraCredentialStatus => ({
    usable: false,
    account: null,
    reason,
  });
  if ("reason" in access) return unusable(access.reason);
  try {
    const me = myselfSchema.safeParse(
      await jiraRequest(fetcher, access, "/myself"),
    );
    return me.success
      ? {
          usable: true,
          account: {
            accountId: me.data.accountId,
            displayName: me.data.displayName.slice(0, 255),
          },
          reason: null,
        }
      : unusable("not-jira");
  } catch (error) {
    if (!(error instanceof JiraFailure)) return unusable("site-unreachable");
    switch (error.reason) {
      case "unauthorized":
        return unusable("unauthorized");
      case "site-unreachable":
      case "rate-limited":
      case "unavailable":
        return unusable("site-unreachable");
      default:
        return unusable("not-jira");
    }
  }
}

/**
 * What children and public output must exclude for Jira credentials: variable names to drop,
 * values to drop wherever they appear, and every string to redact. The email and token
 * values are excluded everywhere; the site address is not secret (it is the task link), so
 * only the site variable's name is.
 */
export function jiraCredentialExclusions(
  credentials: readonly JiraRefs[],
  env: NodeJS.ProcessEnv = process.env,
): { names: string[]; values: string[]; redactions: string[] } {
  const refs = credentials.flatMap((c) => [c.siteRef, c.emailRef, c.tokenRef]);
  const names = [...new Set(refs.map((ref) => ref.slice(4)))];
  const values = [
    ...new Set(
      credentials.flatMap((c) =>
        [c.emailRef, c.tokenRef].flatMap((ref) => env[ref.slice(4)] || []),
      ),
    ),
  ];
  return { names, values, redactions: [...refs, ...names, ...values] };
}
