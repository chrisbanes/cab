import { z } from "zod";
const oid = z.string().regex(/^[0-9a-f]{40}$/);
/** Object identities and digests only; never commit-message or patch text. */
export const rebaseProofSchema = z
  .object({
    version: z.literal(1),
    oldBase: oid,
    oldHead: oid,
    newBase: oid,
    newHead: oid,
    pairs: z
      .array(
        z
          .object({
            oldCommit: oid,
            newCommit: oid,
            patchId: oid,
            messageSha256: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict();
export type RebaseProof = z.output<typeof rebaseProofSchema>;
