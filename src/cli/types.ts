import type { CredentialStore } from "./connections.js";
import type { Coverage, Pagination } from "./browse.js";

export type CliDeps = {
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WriteStream;
  fetch: typeof fetch;
  platform: NodeJS.Platform;
  /** The caller's uid; tests inject it (default: the process's). */
  uid?: number;
  keychain: () => CredentialStore;
  now: () => number;
  /** Command request timeout; expiry is an unknown outcome (default 60 s). */
  commandTimeoutMs?: number;
  /** Following waits with this; tests inject it. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Where a prepare with no `--out` writes its document (default `process.cwd()`); tests inject it. */
  cwd?: string;
  /** Aborted on SIGINT by the CLI entry point. */
  signal?: AbortSignal;
};

export type Result = {
  human: string;
  data: unknown;
  connection?: string;
  service?: { installationId: string; origin: string; apiVersion: number };
  pagination?: Pagination;
  coverage?: Coverage;
  /** The receipt identity of a write: service installation, scope, type and key. */
  request?: RequestIdentity;
  /** Already written to stdout (follow or JSONL); nothing more is printed. */
  streamed?: boolean;
};

export type RequestIdentity = {
  service: string;
  scope: string;
  type: string;
  key: string;
};

/** Every flag the CLI accepts; a command reads only the ones it documents. */
export type Values = {
  connection?: string | undefined;
  url?: string | undefined;
  "token-file"?: string | undefined;
  limit?: string | undefined;
  cursor?: string | undefined;
  project?: string | undefined;
  state?: string | undefined;
  type?: string | undefined;
  after?: string | undefined;
  before?: string | undefined;
  historical?: boolean | undefined;
  revision?: string | undefined;
  out?: string | undefined;
  file?: string | undefined;
  "request-id"?: string | undefined;
  "expected-version"?: string | undefined;
  name?: string | undefined;
  summary?: string | undefined;
  "instructions-file"?: string | undefined;
  "capabilities-file"?: string | undefined;
  "restore-revision"?: string | undefined;
  revoked?: string | undefined;
  paused?: string | undefined;
  "lead-profile"?: string | undefined;
  "diagnostic-capture"?: string | undefined;
  id?: string | undefined;
  enabled?: string | undefined;
  "guidance-file"?: string | undefined;
  "credential-ref"?: string | undefined;
  candidates?: string | undefined;
  "global-limit"?: string | undefined;
  "project-limit"?: string[] | undefined;
  scope?: string | undefined;
  output?: string | undefined;
  task?: string | undefined;
  assignment?: string | undefined;
  execution?: string | undefined;
  kind?: string | undefined;
  severity?: string | undefined;
  follow?: boolean | undefined;
  yes?: boolean | undefined;
  interval?: string | undefined;
  "max-duration"?: string | undefined;
  "compare-current"?: boolean | undefined;
  verbose?: boolean | undefined;
  "dry-run"?: boolean | undefined;
  title?: string | undefined;
  outcome?: string | undefined;
  "outcome-file"?: string | undefined;
  instructions?: string | undefined;
  ready?: string | undefined;
  blocker?: string[] | undefined;
  assignee?: string | undefined;
  to?: string | undefined;
  "message-file"?: string | undefined;
  "answers-file"?: string | undefined;
  decision?: string | undefined;
  "expected-revision"?: string | undefined;
  "material-hash"?: string | undefined;
  "edit-file"?: string | undefined;
  selection?: string | undefined;
  "body-file"?: string | undefined;
  "expected-task-version"?: string | undefined;
  "review-id"?: string | undefined;
  work?: string | undefined;
  "evidence-file"?: string | undefined;
  "expected-conversation-revision"?: string | undefined;
};
