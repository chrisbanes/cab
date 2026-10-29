import type { RepositoryVerificationReason } from "./github-source.js";

export class DomainConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainConflictError";
  }
}

/** Stop applies only to an open task (CONTEXT.md "Task stop"). */
export class TaskNotOpenError extends DomainConflictError {
  constructor(readonly taskState: string) {
    super("Only an open task can be stopped");
    this.name = "TaskNotOpenError";
  }
}

export class DomainStaleDispositionError extends Error {
  constructor(
    message: string,
    readonly reason: "external-admission" | "stale",
  ) {
    super(message);
    this.name = "DomainStaleDispositionError";
  }
}

export class DomainNotFoundError extends Error {
  constructor() {
    super("Unknown domain record");
    this.name = "DomainNotFoundError";
  }
}

export class DomainPolicyError extends Error {
  constructor(
    readonly code: "forbidden" | "invalid-input",
    message: string,
    readonly fieldPaths?: string[],
  ) {
    super(message);
    this.name = "DomainPolicyError";
  }
}

/** Another project already has this name, ignoring case (SPEC "Guided setup"). */
export class ProjectNameTakenError extends DomainPolicyError {
  constructor(readonly existingName: string) {
    super("invalid-input", "Another project has this name", ["name"]);
    this.name = "ProjectNameTakenError";
  }
}

const verificationRefusals: Record<RepositoryVerificationReason, string> = {
  "path-invalid": "the path is not an absolute directory path",
  "not-checkout": "the path is not a Git checkout",
  "origin-missing": "the checkout has no origin remote",
  "origin-provider":
    "the origin remote is not a project on the configured host",
  "origin-mismatch": "the origin remote is a different project than configured",
  "ref-unavailable": "the ref does not name a commit in the checkout",
};

/** A linked checkout failed verification; the message names the row and reason, never a path. */
export class RepositoryVerificationRefusedError extends DomainPolicyError {
  constructor(
    readonly reason: RepositoryVerificationReason,
    index: number,
  ) {
    super(
      "invalid-input",
      `Repository ${index + 1}: ${verificationRefusals[reason]}.`,
      [
        `repositories.${index}.${reason === "ref-unavailable" ? "ref" : "path"}`,
      ],
    );
    this.name = "RepositoryVerificationRefusedError";
  }
}

/** A command may have committed even though its completion could not be observed. */
export class DomainOperationError extends Error {
  constructor(message = "Command outcome is unknown", options?: ErrorOptions) {
    super(message, options);
    this.name = "DomainOperationError";
  }
}
