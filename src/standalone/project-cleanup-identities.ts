import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { materialDigest } from "../core/delivery.js";

export const filesystemIdentitySchema = z
  .object({
    device: z.string().min(1).max(512),
    inode: z.string().min(1).max(512),
    ownerUid: z.number().int().nonnegative().optional(),
  })
  .strict();
export type FilesystemIdentity = z.output<typeof filesystemIdentitySchema>;
export const capturedRepositoryIdentitySchema = z.discriminatedUnion("state", [
  z
    .object({ repositoryId: z.string().min(1), state: z.literal("absent") })
    .strict(),
  z
    .object({
      repositoryId: z.string().min(1),
      state: z.literal("unavailable"),
    })
    .strict(),
  z
    .object({
      repositoryId: z.string().min(1),
      state: z.literal("observed"),
      root: filesystemIdentitySchema,
      gitEntry: filesystemIdentitySchema,
      gitDirectory: z
        .object({
          path: z.string().min(1),
          filesystem: filesystemIdentitySchema,
        })
        .strict(),
      commonDirectory: z
        .object({
          path: z.string().min(1),
          filesystem: filesystemIdentitySchema,
        })
        .strict(),
      source: filesystemIdentitySchema,
    })
    .strict(),
]);
export type CapturedRepositoryIdentity = z.output<
  typeof capturedRepositoryIdentitySchema
>;
export type CleanupOutcome =
  | { outcome: "complete" }
  | {
      outcome: "pending";
      reason: "unsafe" | "unavailable" | "failed" | "unknown";
    };

/** Stable opaque identity survives payload pruning, including the deleted-thread restore fence. */
export function projectCleanupId(kind: string, value: string) {
  const hex = materialDigest({ kind, value });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export async function observeFilesystem(path: string) {
  try {
    const stat = await lstat(path);
    return {
      state: "observed" as const,
      stat,
      filesystem: {
        device: String(stat.dev),
        inode: String(stat.ino),
        ownerUid: stat.uid,
      },
    };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "absent" as const }
      : { state: "unavailable" as const };
  }
}
export async function capturedFilesystemState(
  path: string,
  expected: FilesystemIdentity,
  kind: "directory" | "file" = "directory",
): Promise<"same" | "absent" | "unsafe" | "unavailable"> {
  if (!isAbsolute(path) || resolve(path) !== path) return "unsafe";
  const current = await observeFilesystem(path);
  if (current.state !== "observed") return current.state;
  if (
    current.stat.isSymbolicLink() ||
    (kind === "directory"
      ? !current.stat.isDirectory()
      : !current.stat.isFile()) ||
    current.filesystem.device !== expected.device ||
    current.filesystem.inode !== expected.inode ||
    (expected.ownerUid !== undefined && current.stat.uid !== expected.ownerUid)
  )
    return "unsafe";
  try {
    // Canonical equality refuses a symlink in any ancestor as well as at the leaf.
    return (await realpath(path)) === path ? "same" : "unsafe";
  } catch {
    return "unavailable";
  }
}
