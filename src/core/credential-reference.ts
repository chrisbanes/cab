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
