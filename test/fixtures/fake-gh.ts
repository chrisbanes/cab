import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "./temp.js";

export const fakeGhLogin = "octo";
/** The token the signed-in fake prints; tests assert it never appears in output. */
export const fakeGhToken = "gho_fake-canary-942";
export type FakeGhState =
  | "signed-in"
  | "not-signed-in"
  | "unreadable"
  | "hang"
  | "invalid-token";

export interface FakeGh {
  /** Absolute path of the executable, for `ghExecutable`. */
  executable: string;
  /** A path where no executable exists, for the not-installed state. */
  missing: string;
  set(state: FakeGhState): void;
  /** Change only the successful token output, preserving the fake login. */
  setToken(token: string): void;
  /** Optional environment-sensitive accounts; default fake behavior stays unchanged. */
  setAccounts(accounts: {
    stored: { login: string; token: string };
    tokens: Record<string, string>;
  }): void;
  commands(): string[];
  /** The environment of every invocation, oldest first. */
  environments(): Record<string, string>[];
  close(): void;
}

// Plain CommonJS so the fake needs no build step; state is read from a sibling file.
const script = `
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
fs.appendFileSync(path.join(dir, "env.jsonl"), JSON.stringify(process.env) + "\\n");
const state = fs.readFileSync(path.join(dir, "state"), "utf8").trim();
const [group, command] = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "commands.jsonl"), JSON.stringify(command) + "\\n");
const accountsPath = path.join(dir, "accounts.json");
const accounts = fs.existsSync(accountsPath) ? JSON.parse(fs.readFileSync(accountsPath, "utf8")) : null;
const override = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const identity = accounts ? (override ? accounts.tokens[override] : accounts.stored.login) : ${JSON.stringify(fakeGhLogin)};
const account = (s) => JSON.stringify({ hosts: { "github.com": [
  { state: s, active: true, host: "github.com", login: identity || "invalid", tokenSource: "keyring", scopes: "repo" },
] } });
if (state === "hang") setTimeout(() => {}, 600000);
else if (group === "auth" && command === "status") {
  if (accounts && !identity) {
    process.stdout.write(account("error") + "\\n"); process.exitCode = 1;
  } else if (state === "not-signed-in") {
    process.stderr.write("You are not logged into any GitHub hosts.\\n");
    process.stdout.write('{"hosts":{}}\\n');
  } else if (state === "unreadable") {
    process.stderr.write("keyring failed for ${fakeGhToken}\\n");
    process.stdout.write(account("error") + "\\n");
    process.exitCode = 1;
  } else process.stdout.write(account("success") + "\\n");
} else if (group === "auth" && command === "token") {
  if (accounts && !identity) process.exitCode = 1;
  else if (state === "signed-in") process.stdout.write((accounts ? (override || accounts.stored.token) : fs.readFileSync(path.join(dir, "token"), "utf8")) + "\\n");
  else if (state === "invalid-token") process.stdout.write("not a token\\nsecond line\\n");
  else {
    process.stderr.write("no oauth token found for github.com ${fakeGhToken}\\n");
    process.exitCode = 1;
  }
} else process.exitCode = 2;
`;

/** Writes an executable fake `gh` into a fresh temporary directory. */
export function createFakeGh(state: FakeGhState = "signed-in"): FakeGh {
  const dir = mkdtempSync(join(tmpdir(), "cab-fake-gh-"));
  const executable = join(dir, "gh");
  writeFileSync(executable, `#!${process.execPath}\n${script}`);
  chmodSync(executable, 0o700);
  const set = (next: FakeGhState) => writeFileSync(join(dir, "state"), next);
  set(state);
  const setToken = (token: string) => writeFileSync(join(dir, "token"), token);
  setToken(fakeGhToken);
  return {
    executable,
    missing: join(dir, "absent", "gh"),
    set,
    setToken,
    setAccounts: (accounts) =>
      writeFileSync(join(dir, "accounts.json"), JSON.stringify(accounts)),
    commands: () => {
      try {
        return readFileSync(join(dir, "commands.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string);
      } catch {
        return [];
      }
    },
    environments: () => {
      try {
        return readFileSync(join(dir, "env.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, string>);
      } catch {
        return [];
      }
    },
    // A `gh` the service started can still be appending to its logs as the test ends, which
    // makes the directory not empty by the time it is removed.
    close: () =>
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      }),
  };
}
