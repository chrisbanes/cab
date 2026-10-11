import type { CredentialStore } from "./connections.js";
import type { Coverage, Pagination } from "./browse.js";

export type CliDeps = {
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WriteStream;
  fetch: typeof fetch;
  platform: NodeJS.Platform;
  keychain: () => CredentialStore;
  now: () => number;
  /** Command request timeout; expiry is an unknown outcome (default 60 s). */
  commandTimeoutMs?: number;
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
  id?: string | undefined;
  enabled?: string | undefined;
  "guidance-file"?: string | undefined;
  "credential-ref"?: string | undefined;
  candidates?: string | undefined;
  "global-limit"?: string | undefined;
  "project-limit"?: string[] | undefined;
  scope?: string | undefined;
};
