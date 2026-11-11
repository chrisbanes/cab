import { z } from "zod";

/**
 * A project's sandbox level (ADR-1034). `strict` keeps the harness sandbox; `unsandboxed` runs
 * task turns without it. Separate from domain.ts so the web can import it without node:sqlite.
 */
export const sandboxLevels = ["strict", "unsandboxed"] as const;
export const sandboxLevelSchema = z.enum(sandboxLevels);
export type SandboxLevel = z.infer<typeof sandboxLevelSchema>;
