import { open } from "node:fs/promises";
import { z } from "zod";
import {
  noTurnAttestationSchema,
  noTurnEvidenceSchema,
  preTurnAttestationSchema,
  preTurnRecoveryReceiptSchema,
  type RecoveryPath,
  recoveryEvidenceSchema,
  recoveryPaths,
  recoveryRpcErrorSchema,
} from "../core/recovery-contracts.js";
import { writeOut } from "./browse-evidence.js";
import { readSealedDocument, sealDocument } from "./change-document.js";
import { CliError } from "./connections.js";

export const RECOVERY_SCHEMA = "ensemble.cli.recovery/v1";
export const EVIDENCE_SCHEMA = "ensemble.cli.recovery-evidence/v1";
const MAX_EVIDENCE_BYTES = 64 * 1024;

const recoveryDocumentSchema = z
  .object({
    schema: z.literal(RECOVERY_SCHEMA),
    path: z.enum(recoveryPaths),
    preparedAt: z.number().int().nonnegative(),
    service: z
      .object({ installationId: z.uuid(), origin: z.string() })
      .strict(),
    target: z
      .object({
        scope: z.string(),
        assignmentId: z.uuid(),
        taskId: z.uuid(),
        projectId: z.uuid(),
        workId: z.string().nullable(),
      })
      .strict(),
    /** Versions observed at preparation; the service rechecks every one. */
    bound: z
      .object({
        assignmentVersion: z.number().int().positive(),
        conversationRevision: z.number().int().positive(),
        workRevision: z.number().int().positive().nullable(),
        requestSequence: z.number().int().positive().nullable(),
        observedAt: z.number().int().nonnegative(),
      })
      .strict(),
    /** The exact command sent on submit, without its request key. */
    command: z.record(z.string(), z.unknown()),
    preview: z.object({ lines: z.array(z.string()) }).strict(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type RecoveryDocument = z.infer<typeof recoveryDocumentSchema>;

export async function writeRecoveryDocument(
  path: string,
  document: Omit<RecoveryDocument, "digest">,
) {
  const { complete, body } = sealDocument(document, "recovery");
  return { path: await writeOut(path, body), document: complete };
}

const invalid = (why: string, fix?: string) =>
  new CliError(
    "change-document-invalid",
    `Recovery document rejected: ${why}.`,
    { ...(fix ? { fix } : {}) },
  );
const PREPARE_FIX =
  "Prepare it first with 'ensemble recovery prepare' (see 'ensemble help recovery'), then submit the file it writes.";

/** Reads an owner-only recovery document and verifies its schema and digest. */
export const readRecoveryDocument = (
  path: string,
  uid = process.getuid?.(),
): Promise<RecoveryDocument> =>
  readSealedDocument(
    path,
    uid,
    recoveryDocumentSchema,
    RECOVERY_SCHEMA,
    invalid,
    PREPARE_FIX,
  );

const receiptAssertions = z
  .object({
    receipt: preTurnRecoveryReceiptSchema
      .pick({ termination: true, effects: true, workspace: true })
      .strict(),
  })
  .strict();
/** What the operator must supply per path; nothing here is ever defaulted or inferred. */
const evidenceFileSchemas: Record<
  Exclude<RecoveryPath, "conversation-replace">,
  z.ZodType
> = {
  "pre-turn-adopt": z
    .object({
      rpcError: recoveryRpcErrorSchema,
      evidence: recoveryEvidenceSchema,
      attestation: preTurnAttestationSchema,
    })
    .strict(),
  "no-turn-adopt": z
    .object({
      evidence: noTurnEvidenceSchema,
      attestation: noTurnAttestationSchema,
    })
    .strict(),
  "pre-turn-recover": receiptAssertions,
  "no-turn-recover": receiptAssertions,
};

/** Reads and strictly validates an operator evidence file for one path. */
export async function readEvidenceFile(
  path: string,
  recoveryPath: Exclude<RecoveryPath, "conversation-replace">,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    const handle = await open(path, "r");
    try {
      if ((await handle.stat()).size > MAX_EVIDENCE_BYTES)
        throw new CliError(
          "invalid-input",
          "--evidence-file is larger than 64 KiB.",
        );
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("invalid-input", `Cannot read --evidence-file ${path}.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CliError("invalid-input", "--evidence-file is not JSON.");
  }
  const { schema, ...rest } = (
    value && typeof value === "object" ? value : {}
  ) as Record<string, unknown>;
  if (schema !== EVIDENCE_SCHEMA)
    throw new CliError(
      "invalid-input",
      `--evidence-file must declare "schema": "${EVIDENCE_SCHEMA}".`,
    );
  const parsed = evidenceFileSchemas[recoveryPath].safeParse(rest);
  if (!parsed.success)
    throw new CliError(
      "invalid-input",
      `--evidence-file is not complete, exact evidence for ${recoveryPath}: ${[
        ...new Set(
          parsed.error.issues.map((i) => i.path.join(".") || i.message),
        ),
      ].join(
        ", ",
      )}. Nothing is inferred; every field and attestation must be stated.`,
    );
  return parsed.data as Record<string, unknown>;
}
