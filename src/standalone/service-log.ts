import {
  prepareExclusions,
  sanitizeConversationText,
} from "./conversation-history.js";

export const maxErrorMessageBytes = 2048;
export const maxErrorStackFrames = 10;
export const maxErrorStackFrameBytes = 512;
export const maxErrorCauseDepth = 3;

/** A thrown value reduced to what a launchd log may show. */
export interface SanitizedError {
  name: string;
  code?: string | number;
  message?: string;
  messageTruncated?: true;
  stack?: string[];
  cause?: SanitizedError;
  causeOmitted?: true;
  redaction: "applied" | "unavailable";
}

const identifier = /^[A-Za-z_$][\w$]{0,63}$/;
const codePattern = /^[A-Za-z0-9_.:-]{1,64}$/;
const stackFrame = /^\s*at /;

/** Cuts after redaction, so a cut can never leave the start of a secret. */
function truncate(text: string, maxBytes: number): [string, boolean] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text, false];
  let cut = text.slice(0, maxBytes);
  while (Buffer.byteLength(cut, "utf8") > maxBytes) cut = cut.slice(0, -1);
  return [cut, true];
}

function identity(error: unknown): Pick<SanitizedError, "name" | "code"> {
  if (!(error instanceof Error)) return { name: "NonError" };
  const { name, code } = error as Error & { code?: unknown };
  return {
    name: typeof name === "string" && identifier.test(name) ? name : "Error",
    ...(typeof code === "string" && codePattern.test(code)
      ? { code }
      : Number.isSafeInteger(code)
        ? { code: code as number }
        : {}),
  };
}

function describe(
  error: unknown,
  exclusions: readonly string[],
  depth: number,
): SanitizedError {
  const result: SanitizedError = { ...identity(error), redaction: "applied" };
  if (!(error instanceof Error)) return result;
  if (typeof error.message === "string") {
    const message = sanitizeConversationText(error.message, exclusions);
    if (message !== undefined) {
      const [text, cut] = truncate(message, maxErrorMessageBytes);
      result.message = text;
      if (cut) result.messageTruncated = true;
    }
  }
  if (typeof error.stack === "string") {
    const frames = error.stack
      .split("\n")
      .filter((line) => stackFrame.test(line))
      .slice(0, maxErrorStackFrames)
      .join("\n");
    const stack = sanitizeConversationText(frames, exclusions);
    if (stack !== undefined)
      result.stack = stack
        .split("\n")
        .map((frame) => truncate(frame.trim(), maxErrorStackFrameBytes)[0]);
  }
  if (error.cause !== undefined) {
    if (depth >= maxErrorCauseDepth) result.causeOmitted = true;
    else result.cause = describe(error.cause, exclusions, depth + 1);
  }
  return result;
}

/**
 * Never throws and never returns unredacted text: without a usable exclusion list
 * only the identifier-shaped name and code remain.
 */
export function sanitizeError(
  error: unknown,
  exclusions: readonly string[] | undefined,
): SanitizedError {
  try {
    if (exclusions) {
      const prepared = prepareExclusions(exclusions);
      // An invalid list (too many or too large values) makes the sanitiser refuse every text.
      if (sanitizeConversationText("", prepared) !== undefined)
        return describe(error, prepared, 0);
    }
  } catch {
    // Fall through to the identifier-only form.
  }
  try {
    return { ...identity(error), redaction: "unavailable" };
  } catch {
    return { name: "Error", redaction: "unavailable" };
  }
}

export type ServiceExit =
  | { reason: "signal"; signal: string }
  | { reason: "background-failure"; operation: string }
  | { reason: "shutdown-failure" }
  | { reason: "crash"; error: unknown };

/** One JSON line per record on stderr; the first `exited` call is the process's only exit line. */
export class ServiceLog {
  private service?: { failureExclusions(): readonly string[] | undefined };
  private exitWritten = false;

  constructor(
    private readonly write: (line: string) => void = (line) => {
      process.stderr.write(line);
    },
  ) {}

  /** Later records read this service's redaction inputs. */
  attach(service: {
    failureExclusions(): readonly string[] | undefined;
  }): void {
    this.service = service;
  }

  started(fields: {
    version: string;
    mode: "serve" | "operator";
    port: number | null;
    serviceId: string;
  }): void {
    this.line({ event: "service-start", ...fields });
  }

  failure(stage: "service-shutdown" | "listener-shutdown", error: unknown) {
    this.line({ event: "service-failure", stage, error: this.sanitize(error) });
  }

  exited(exit: ServiceExit): void {
    if (this.exitWritten) return;
    this.exitWritten = true;
    this.line({
      event: "service-exit",
      ...(exit.reason === "crash"
        ? { reason: exit.reason, error: this.sanitize(exit.error) }
        : exit),
    });
  }

  private sanitize(error: unknown): SanitizedError {
    let exclusions: readonly string[] | undefined;
    try {
      exclusions = this.service?.failureExclusions();
    } catch {
      // Unavailable exclusions leave only the identifier-shaped fields.
    }
    return sanitizeError(error, exclusions);
  }

  private line(record: object): void {
    try {
      this.write(`${JSON.stringify(record)}\n`);
    } catch {
      // Logging is best-effort; the exit status still reports the failure.
    }
  }
}
