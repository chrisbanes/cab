import { execFile } from "node:child_process";
import { z } from "zod";
import { credentialFreeEnvironment } from "../core/child-environment.js";
import type { DomainStore } from "../core/domain.js";
import { claudeTokenExclusions } from "./claude-token.js";

export type GhFailureState = "not-installed" | "not-signed-in" | "unreadable";
/** The detected github.com login; never a token. */
export type GhLoginState =
  | { state: "signed-in"; login: string }
  | { state: GhFailureState };

export interface GhOptions {
  /** Defaults to `gh` on the service `PATH`. */
  executable?: string | undefined;
  /** Defaults to 10 seconds. */
  timeoutMs?: number;
  /** The environment `gh` runs with; see `ghEnvironment`. */
  environment?: NodeJS.ProcessEnv;
}

const statusSchema = z.object({
  hosts: z.record(
    z.string(),
    z.array(
      z.object({
        state: z.string(),
        active: z.boolean(),
        login: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
      }),
    ),
  ),
});

/** Runs `gh` without stdin; stderr is discarded and never surfaced. */
function run(
  args: string[],
  options: GhOptions,
): Promise<{ stdout: string; failure?: "missing" | "failed" }> {
  return new Promise((resolve) => {
    const child = execFile(
      options.executable ?? "gh",
      args,
      {
        env: {
          ...(options.environment ?? process.env),
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
        },
        timeout: options.timeoutMs ?? 10_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (!error) return resolve({ stdout });
        const code = (error as NodeJS.ErrnoException).code;
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          failure: code === "ENOENT" ? "missing" : "failed",
        });
      },
    );
    child.on("error", () => {});
    child.stdin?.end();
  });
}

/** The active github.com login from `gh auth status`, which reports no token. */
export async function detectGh(options: GhOptions = {}): Promise<GhLoginState> {
  const result = await run(
    [
      "auth",
      "status",
      "--active",
      "--hostname",
      "github.com",
      "--json",
      "hosts",
    ],
    options,
  );
  if (result.failure === "missing") return { state: "not-installed" };
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    return { state: "unreadable" };
  }
  const parsed = statusSchema.safeParse(json);
  if (!parsed.success) return { state: "unreadable" };
  const account = parsed.data.hosts["github.com"]?.find((a) => a.active);
  if (!account) return { state: "not-signed-in" };
  // A reported account with a failed exit is not trusted as signed in.
  return account.state === "success" && !result.failure
    ? { state: "signed-in", login: account.login }
    : { state: "unreadable" };
}

/** The github.com token from `gh auth token`, after detection; never cached for reads. */
export async function ghToken(
  options: GhOptions = {},
): Promise<{ token: string } | { state: GhFailureState }> {
  const detected = await detectGh(options);
  if (detected.state !== "signed-in") return detected;
  const result = await run(
    ["auth", "token", "--hostname", "github.com"],
    options,
  );
  if (result.failure === "missing") return { state: "not-installed" };
  const token = result.stdout.replace(/\r?\n$/, "");
  if (result.failure || !/^[\x21-\x7e]{1,512}$/.test(token))
    return { state: "unreadable" };
  remember(token);
  return { token };
}

// ponytail: in memory only; a token rotated more than eight times since start is no longer excluded.
const resolvedLimit = 8;
const resolved = new Set<string>();
/** Kept only to exclude and redact; never persisted, returned or used for a read. */
function remember(token: string) {
  resolved.delete(token);
  resolved.add(token);
  for (const oldest of resolved) {
    if (resolved.size <= resolvedLimit) break;
    resolved.delete(oldest);
  }
}

/**
 * What child environments and reads must exclude for a discovery reference: env names to drop,
 * values to drop wherever they appear, and every string to redact. For `gh:github.com` these
 * are gh's own token variables and every token value this process has resolved.
 */
export function discoveryCredentialExclusions(
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
): { names: string[]; values: string[]; redactions: string[] } {
  if (ref.startsWith("gh:")) {
    const names = ["GH_TOKEN", "GITHUB_TOKEN"];
    const values = [...resolved, ...names.flatMap((name) => env[name] || [])];
    return { names, values, redactions: [ref, ...values] };
  }
  const name = ref.slice(4);
  const values = env[name] ? [env[name]] : [];
  return { names: [name], values, redactions: [ref, name, ...values] };
}

/**
 * The service environment `gh` runs with: the Claude token and delivery credentials removed,
 * the discovery credential kept because `gh` may read `GH_TOKEN` or `GITHUB_TOKEN`.
 */
export function ghEnvironment(
  domain: Pick<
    DomainStore,
    "claudeTokenReference" | "projects" | "deliveryCredentialReference"
  >,
): NodeJS.ProcessEnv {
  const claudeRef = domain.claudeTokenReference();
  const claude = claudeRef
    ? claudeTokenExclusions(claudeRef)
    : { names: [], values: [] };
  const delivery = domain.projects().flatMap((p) => {
    const ref = domain.deliveryCredentialReference(String(p.id));
    return ref ? [ref.slice(4)] : [];
  });
  return credentialFreeEnvironment(
    process.env,
    [...delivery, ...claude.names],
    process.env,
    claude.values,
  );
}
