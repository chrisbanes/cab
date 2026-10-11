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
};

export type Result = {
  human: string;
  data: unknown;
  connection?: string;
  service?: { installationId: string; origin: string; apiVersion: number };
  pagination?: Pagination;
  coverage?: Coverage;
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
};
