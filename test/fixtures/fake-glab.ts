import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "./temp.js";

/** The token the signed-in fake prints; tests assert it never appears in output. */
export const fakeGlabToken = "glpat-fake-canary-311";
export type FakeGlabState =
  | "signed-in"
  /** The `Token: <t>` line of glab v1.30-v1.60. */
  | "legacy-format"
  | "not-signed-in"
  | "unreadable"
  | "masked"
  | "hang";

export interface FakeGlab {
  /** Absolute path of the executable, for `glabExecutable`. */
  executable: string;
  /** A path where no executable exists, for the not-installed state. */
  missing: string;
  set(state: FakeGlabState): void;
  /** Change only the successful token output. */
  setToken(token: string): void;
  /** The argv of every invocation, oldest first. */
  commands(): string[][];
  /** The environment of every invocation, oldest first. */
  environments(): Record<string, string>[];
  close(): void;
}

// Plain CommonJS so the fake needs no build step; state is read from a sibling file. Like glab,
// status goes to stderr and a token variable takes precedence over the stored login.
const script = `
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
fs.appendFileSync(path.join(dir, "env.jsonl"), JSON.stringify(process.env) + "\\n");
fs.appendFileSync(path.join(dir, "commands.jsonl"), JSON.stringify(process.argv.slice(2)) + "\\n");
const state = fs.readFileSync(path.join(dir, "state"), "utf8").trim();
const host = process.argv[process.argv.indexOf("--hostname") + 1];
const override = process.env.GITLAB_TOKEN || process.env.GITLAB_ACCESS_TOKEN || process.env.OAUTH_TOKEN;
const token = override || fs.readFileSync(path.join(dir, "token"), "utf8");
const say = (line) => process.stderr.write(line + "\\n");
if (state === "hang") setTimeout(() => {}, 600000);
else if (process.argv.slice(2, 4).join(" ") !== "auth status") process.exitCode = 2;
else if (state === "not-signed-in") {
  say("x " + host + " has not been authenticated with glab; run \`glab auth login --hostname " + host + "\` to authenticate");
  process.exitCode = 1;
} else if (state === "unreadable") say(host + "\\n  keyring failed");
else {
  say(host);
  say("  ✓ Logged in to " + host + " as fake-user (keyring)");
  if (state === "legacy-format") say("  ✓ Token: " + token);
  else say("  ✓ Token found in operating system keyring: " + (state === "masked" ? "**************************" : token));
}
`;

/** Writes an executable fake `glab` into a fresh temporary directory. */
export function createFakeGlab(state: FakeGlabState = "signed-in"): FakeGlab {
  const dir = mkdtempSync(join(tmpdir(), "cab-fake-glab-"));
  const executable = join(dir, "glab");
  writeFileSync(executable, `#!${process.execPath}\n${script}`);
  chmodSync(executable, 0o700);
  const set = (next: FakeGlabState) => writeFileSync(join(dir, "state"), next);
  set(state);
  const setToken = (token: string) => writeFileSync(join(dir, "token"), token);
  setToken(fakeGlabToken);
  const lines = <T>(file: string) => {
    try {
      return readFileSync(join(dir, file), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T);
    } catch {
      return [];
    }
  };
  return {
    executable,
    missing: join(dir, "absent", "glab"),
    set,
    setToken,
    commands: () => lines<string[]>("commands.jsonl"),
    environments: () => lines<Record<string, string>>("env.jsonl"),
    // A `glab` the service started can still be appending to its logs as the test ends.
    close: () =>
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      }),
  };
}
