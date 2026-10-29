import { z } from "zod";

/** `env:NAME`: a variable in the service environment. */
export const envCredentialReference = z.string().regex(/^env:[A-Z][A-Z0-9_]*$/);
/** The GitHub CLI login for github.com, resolved by running `gh` on each use. */
export const ghCredentialReference = z.literal("gh:github.com");
/** A discovery credential reference; never its value. */
export const discoveryCredentialReference = z.union([
  envCredentialReference,
  ghCredentialReference,
]);
/** A project GitHub source credential, chosen independently of discovery. */
export const sourceCredentialReference = z.union([
  envCredentialReference,
  ghCredentialReference,
]);
/**
 * The GitLab CLI login for one host, resolved by running `glab` on each use. The host pattern
 * matches `gitLabHostSchema`, which lives in a module that imports this one.
 */
export const glabCredentialReference = z
  .string()
  .regex(
    /^glab:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
  )
  .max(5 + 253)
  .refine((ref) => ref !== "glab:github.com");
/** An installation GitLab credential reference; never its value. */
export const gitLabCredentialReference = z.union([
  envCredentialReference,
  glabCredentialReference,
]);

/** A `glab:` reference names the host it configures; `env:` references name no host. */
export const glabReferenceMatchesHost = (command: {
  host: string;
  credentialRef: string | null;
}): boolean =>
  !command.credentialRef?.startsWith("glab:") ||
  command.credentialRef === `glab:${command.host}`;

/** A Jira Cloud site's installation credential: `env:` references only, never their values. */
export const jiraCredentialReferencesSchema = z
  .object({
    siteRef: envCredentialReference,
    emailRef: envCredentialReference,
    tokenRef: envCredentialReference,
  })
  .strict()
  .refine(
    (refs) => new Set([refs.siteRef, refs.emailRef, refs.tokenRef]).size === 3,
    "Site, email and token must use different variables",
  );
