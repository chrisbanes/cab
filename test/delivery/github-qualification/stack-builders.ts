import { z } from "zod";
import {
  authorityHash,
  materialHash,
  stackAuthoritySchema,
  stackV2ManifestSchema,
  stackV2ReadinessSchema,
  stackV2GrantSchema,
} from "./stack-authority.js";

/** Schemas contain no sample identities, credentials, grants or executable fixture. */
export function stackV2Schemas() {
  return {
    manifest: z.toJSONSchema(stackV2ManifestSchema),
    authority: z.toJSONSchema(stackAuthoritySchema),
    readiness: z.toJSONSchema(stackV2ReadinessSchema),
    grant: z.toJSONSchema(stackV2GrantSchema),
  };
}

/** Capture preparation computes bindings; it cannot issue independent live authority. */
export function prepareStackV2Manifest(
  input: Omit<z.input<typeof stackV2ManifestSchema>, "readinessSha256">,
  readinessInput: Omit<
    z.input<typeof stackV2ReadinessSchema>,
    "resourceSha256" | "authoritySha256"
  >,
) {
  const authority = stackAuthoritySchema.parse(input.authority);
  const resourceSha256 = materialHash(input.resource),
    authoritySha256 = materialHash(authority);
  const readiness = JSON.stringify(
    stackV2ReadinessSchema.parse({
      ...readinessInput,
      resourceSha256,
      authoritySha256,
    }),
  );
  const manifest = JSON.stringify(
    stackV2ManifestSchema.parse({
      ...input,
      authority,
      readinessSha256: authorityHash(readiness),
    }),
  );
  // Deliberately absent: issuedAt, expiresAt, teardownDeadline. Root must independently
  // authorize those and the exact captured bindings after reviewing actual resources.
  return {
    manifest,
    readiness,
    grantBindings: {
      version: 2 as const,
      runId: input.runId,
      manifestSha256: authorityHash(manifest),
      readinessSha256: authorityHash(readiness),
      resourceSha256,
      authoritySha256,
      credentialRef: input.credentialRef,
    },
  };
}
