import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** Where the Claude subscription token is read from: `env:NAME` or `file:/absolute/path`. */
export type ClaudeTokenSource =
  | { kind: "env"; name: string }
  | { kind: "file"; path: string };

/** The largest token file read, in bytes. */
export const claudeTokenFileLimit = 4096;

export function claudeTokenSource(ref: string): ClaudeTokenSource {
  return ref.startsWith("file:")
    ? { kind: "file", path: ref.slice(5) }
    : { kind: "env", name: ref.slice(4) };
}

/**
 * The token value, or a fixed value-free problem. A file is checked on its opened descriptor
 * before any byte is read; never throws.
 */
export function readClaudeToken(
  source: ClaudeTokenSource,
  env: NodeJS.ProcessEnv = process.env,
  uid: number | undefined = process.getuid?.(),
): { value: string } | { problem: string } {
  if (source.kind === "env") {
    const value = env[source.name];
    return value ? { value } : { problem: "is unavailable" };
  }
  let fd: number;
  try {
    // O_NOFOLLOW covers the final component only; O_NONBLOCK keeps a FIFO from blocking open.
    fd = openSync(
      source.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      problem:
        code === "ENOENT"
          ? "is missing"
          : code === "ELOOP"
            ? "is a symbolic link"
            : "is unreadable",
    };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { problem: "is not a regular file" };
    if (uid === undefined || stat.uid !== uid)
      return { problem: "is not owned by the service user" };
    if ((stat.mode & 0o077) !== 0)
      return { problem: "permits group or other access" };
    const tooLarge = {
      problem: `is larger than ${claudeTokenFileLimit} bytes`,
    };
    if (stat.size > claudeTokenFileLimit) return tooLarge;
    const buffer = Buffer.alloc(claudeTokenFileLimit + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > claudeTokenFileLimit) return tooLarge;
    const value = buffer.subarray(0, length).toString("utf8").trimEnd();
    if (!value) return { problem: "is empty" };
    if (!/^[\x21-\x7e]+$/.test(value))
      return { problem: "does not hold a single token" };
    return { value };
  } catch {
    return { problem: "is unreadable" };
  } finally {
    closeSync(fd);
  }
}

/**
 * What spawn environments and reads must exclude for a Claude token reference: env names to
 * drop, token values to drop wherever they appear, and every string to redact.
 */
export function claudeTokenExclusions(
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
): { names: string[]; values: string[]; redactions: string[] } {
  const source = claudeTokenSource(ref);
  const read = readClaudeToken(source, env);
  const values = "value" in read ? [read.value] : [];
  const location = source.kind === "env" ? source.name : source.path;
  return {
    names: source.kind === "env" ? [source.name] : [],
    values,
    redactions: [ref, location, ...values],
  };
}
