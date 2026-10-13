export class DomainConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainConflictError";
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

/** A command may have committed even though its completion could not be observed. */
export class DomainOperationError extends Error {
  constructor(message = "Command outcome is unknown", options?: ErrorOptions) {
    super(message, options);
    this.name = "DomainOperationError";
  }
}
