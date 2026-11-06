import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  maxCapturedTargetChars,
  maxToolPathChars,
  maxToolPaths,
  outsideWorkspace,
} from "../operator/tool-limits.js";

/**
 * Tool paths and targets for diagnostics. Everything returned is workspace-relative
 * or the literal `outsideWorkspace`; an absolute path never leaves these functions.
 */

/** The lexical root plus its real path when they differ (`/var` is `/private/var` on macOS). */
export function workspaceRoots(root: string): string[] {
  const lexical = resolve(root);
  try {
    const real = realpathSync(lexical);
    return real === lexical ? [lexical] : [lexical, real];
  } catch {
    return [lexical];
  }
}

export function relativeToWorkspace(
  roots: readonly string[],
  path: string,
): string {
  const first = roots[0];
  if (first === undefined) return outsideWorkspace;
  const absolute = resolve(first, path);
  for (const root of roots) {
    const rel = relative(root, absolute);
    if (rel === "") return ".";
    if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
      return rel;
  }
  return outsideWorkspace;
}

/** At most `maxToolPaths` relative paths; an over-long or surplus path is dropped and flagged. */
export function changedPaths(
  roots: readonly string[],
  paths: readonly string[],
): { paths: string[]; truncated: boolean } {
  const kept = new Set<string>();
  let truncated = false;
  for (const path of paths) {
    const rel = relativeToWorkspace(roots, path);
    if (rel.length > maxToolPathChars) truncated = true;
    else if (!kept.has(rel) && kept.size >= maxToolPaths) truncated = true;
    else kept.add(rel);
  }
  return { paths: [...kept], truncated };
}

/** cab's own coordination tools are recorded elsewhere and never get a target. */
export function isCoordinationTool(name: string): boolean {
  return name.startsWith("cab_") || name.startsWith("mcp__cab__");
}

export function mcpTarget(server: string, tool: string): string | undefined {
  if (server === "cab" || isCoordinationTool(tool)) return undefined;
  return capTarget(`${server}/${tool}`);
}

export function capTarget(value: string): string | undefined {
  return value.length > 0 && value.length <= maxCapturedTargetChars
    ? value
    : undefined;
}

/** The allowlisted target of a Claude tool call; any other tool has none. */
export function claudeToolTarget(
  roots: readonly string[],
  name: string,
  input: unknown,
): string | undefined {
  if (isCoordinationTool(name)) return undefined;
  const field = (key: string) => {
    const value =
      typeof input === "object" && input !== null
        ? (input as Record<string, unknown>)[key]
        : undefined;
    return typeof value === "string" ? value : undefined;
  };
  switch (name) {
    case "Read":
    case "Write":
    case "Edit": {
      const path = field("file_path");
      return path === undefined
        ? undefined
        : capTarget(relativeToWorkspace(roots, path));
    }
    case "Grep":
    case "Glob": {
      const pattern = field("pattern");
      // A Glob can be an absolute path; a Grep pattern is a regex and stays as written.
      return pattern === undefined
        ? undefined
        : capTarget(
            name === "Glob" && isAbsolute(pattern)
              ? relativeToWorkspace(roots, pattern)
              : pattern,
          );
    }
    case "Agent": {
      const type = field("subagent_type");
      return type === undefined ? undefined : capTarget(type);
    }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      return mcp?.[1] !== undefined && mcp[2] !== undefined
        ? mcpTarget(mcp[1], mcp[2])
        : undefined;
    }
  }
}
