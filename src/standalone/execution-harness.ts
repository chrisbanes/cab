import { z } from "zod";

/** Closed until another runtime lands, so harness-specific mappings must be exhaustive. */
export const executionHarnessSchema = z.enum(["codex"]);
export type ExecutionHarness = z.infer<typeof executionHarnessSchema>;
export const defaultExecutionHarness: ExecutionHarness = "codex";
