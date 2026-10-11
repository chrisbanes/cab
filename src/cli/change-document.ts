import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { writeOut } from "./browse-evidence.js";
import { CliError } from "./connections.js";

export const CHANGE_SCHEMA = "ensemble.cli.change/v1";
const MAX_DOCUMENT_BYTES = 512 * 1024;

export const changeKinds = [
  "profile.create",
  "profile.configure",
  "project.create",
  "project.configure",
  "routing.configure",
  "capacity.configure",
] as const;
export type ChangeKind = (typeof changeKinds)[number];

const changeSchema = z
  .object({
    field: z.string(),
    from: z.string().nullable(),
    to: z.string().nullable(),
  })
  .strict();
const changeDocumentSchema = z
  .object({
    schema: z.literal(CHANGE_SCHEMA),
    kind: z.enum(changeKinds),
    preparedAt: z.number().int().nonnegative(),
    service: z
      .object({ installationId: z.uuid(), origin: z.string() })
      .strict(),
    target: z.object({ scope: z.string(), id: z.string() }).strict(),
    /** Revisions or values the change was prepared against; the server rechecks them. */
    expected: z.record(z.string(), z.unknown()),
    /** The exact command sent on apply, without its request key. */
    command: z.record(z.string(), z.unknown()),
    preview: z
      .object({
        changes: z.array(changeSchema),
        diff: z
          .object({ lines: z.array(z.string()), truncated: z.boolean() })
          .strict(),
        impact: z.unknown(),
        notes: z.array(z.string()),
      })
      .strict(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ChangeDocument = z.infer<typeof changeDocumentSchema>;

/** JSON with object keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Detects accidental or in-transit modification; it is not a MAC. */
export const digestOf = (document: Omit<ChangeDocument, "digest">): string =>
  createHash("sha256").update(canonicalJson(document)).digest("hex");

export async function writeChangeDocument(
  path: string,
  document: Omit<ChangeDocument, "digest">,
): Promise<{ path: string; document: ChangeDocument }> {
  const complete = { ...document, digest: digestOf(document) };
  const body = Buffer.from(`${JSON.stringify(complete, null, 2)}\n`);
  if (body.byteLength > MAX_DOCUMENT_BYTES)
    throw new CliError(
      "invalid-input",
      "The change document would exceed 512 KiB.",
    );
  return { path: await writeOut(path, body), document: complete };
}

const invalid = (why: string) =>
  new CliError("change-document-invalid", `Change document rejected: ${why}.`);

/** Reads an owner-only regular file and verifies its schema and digest. */
export async function readChangeDocument(
  path: string,
  uid = process.getuid?.(),
): Promise<ChangeDocument> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw invalid("it must be a readable regular file, not a symlink");
  }
  let text: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw invalid("it is not a regular file");
    if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0)
      throw invalid("it must be owned by you with mode 0600 or stricter");
    if (stat.size > MAX_DOCUMENT_BYTES)
      throw invalid("it is larger than 512 KiB");
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid("it is not JSON");
  }
  const parsed = changeDocumentSchema.safeParse(value);
  if (!parsed.success)
    throw invalid("it is not an ensemble.cli.change/v1 document");
  const { digest, ...rest } = parsed.data;
  if (digestOf(rest) !== digest)
    throw invalid("its digest does not match its content; prepare it again");
  return parsed.data;
}
