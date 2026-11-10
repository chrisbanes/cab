import { ZodError } from "zod";

/** A JSON-RPC error response from the runtime: it received the request and refused it. */
export class RuntimeRequestRejectedError extends Error {}

/** Where a submission failed before cab called `startTurn`. */
export type PreTurnStage = "thread" | "resume" | "bound";

/**
 * Why it failed: cab could not accept the runtime's response, the runtime refused the
 * request, or the outcome is unknown (timeout, transport, App Server failure, anything else).
 */
export type PreTurnFailureClass =
  | "response-rejected"
  | "request-rejected"
  | "outcome-unknown";

export function preTurnFailureClass(error: unknown): PreTurnFailureClass {
  if (
    error instanceof ZodError ||
    (error instanceof Error && error.cause instanceof ZodError)
  )
    return "response-rejected";
  if (error instanceof RuntimeRequestRejectedError) return "request-rejected";
  return "outcome-unknown";
}

export const preTurnRefusalPrefix = "Request refused before any turn was sent";
const phrases: Record<PreTurnFailureClass, string> = {
  "response-rejected":
    "cab rejected the runtime's response. A cab build with the fix is expected to help; then use Start again",
  "request-rejected": "the runtime rejected the request",
  "outcome-unknown": "the request's outcome is unknown",
};
const maxDetail = 2000;

/** The refusal's reason; bounded well under the 4000-character reason limit. */
export function preTurnRefusalReason(
  stage: PreTurnStage,
  failureClass: PreTurnFailureClass,
  error: unknown,
): string {
  const detail = String(error);
  return `${preTurnRefusalPrefix} (${stage}): ${phrases[failureClass]}: ${
    detail.length > maxDetail ? `${detail.slice(0, maxDetail)}…` : detail
  }`;
}

export const adoptedPreTurnRefusalReason = `${preTurnRefusalPrefix}: operator-adopted reviewed evidence shows startTurn was not called`;
