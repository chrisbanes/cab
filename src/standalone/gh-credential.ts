import { execFile } from "node:child_process";
import { z } from "zod";
import { credentialFreeEnvironment } from "../core/child-environment.js";
import type { DomainStore } from "../core/domain.js";
import { claudeTokenExclusions } from "./claude-token.js";
import { gitLabCredentialExclusions } from "./glab-credential.js";

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

/** A request-local login probe shared only by identical captured process contexts. */
export class GhLoginScope {
  private readonly probes = new Map<string, Promise<GhLoginState>>();

  detect(options: GhOptions): Promise<GhLoginState> {
    const environment = options.environment ?? process.env;
    const key = JSON.stringify([
      options.executable ?? "gh",
      options.timeoutMs ?? 10_000,
      Object.entries(environment)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ]);
    let probe = this.probes.get(key);
    if (!probe) {
      probe = detectGh(options);
      this.probes.set(key, probe);
    }
    return probe;
  }
}

/** The github.com token from `gh auth token`, after detection; never cached for reads. */
export async function ghToken(
  options: GhOptions = {},
): Promise<{ token: string } | { state: GhFailureState }> {
  const detected = await detectGh(options);
  return ghTokenAfterDetection(detected, options);
}

/** Uses the paired login probe, but always runs a fresh token command. */
export async function ghTokenAfterDetection(
  detected: GhLoginState,
  options: GhOptions = {},
): Promise<{ token: string } | { state: GhFailureState }> {
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

// Exclusion-only lifetime memory grows with distinct rotations; each value is at most 512 bytes.
const resolved = new Set<string>();
/** Kept only to exclude and redact; never persisted, returned or used for a read. */
function remember(token: string) {
  resolved.add(token);
}

/**
 * What children and public output must exclude for a selected reference: env names to drop,
 * values to drop wherever they appear, and every string to redact. For `gh:github.com` these
 * are gh's own token variables and every token value this process has resolved.
 */
export function credentialReferenceExclusions(
  ref: string | null,
  env: NodeJS.ProcessEnv = process.env,
): { names: string[]; values: string[]; redactions: string[] } {
  if (ref === "gh:github.com") {
    const names = ["GH_TOKEN", "GITHUB_TOKEN"];
    const values = [...resolved, ...names.flatMap((name) => env[name] || [])];
    return { names, values, redactions: [ref, ...values] };
  }
  const name = ref?.startsWith("env:") ? ref.slice(4) : null;
  const names = name ? [name] : [];
  const values = [...resolved, ...names.flatMap((key) => env[key] || [])];
  return {
    names,
    values,
    redactions: [...(ref ? [ref] : []), ...names, ...values],
  };
}

/**
 * The environment for this explicit gh operation, independent of discovery's identity.
 * Remove unrelated source, discovery, delivery and Claude credentials and value aliases.
 * Only a selected gh reference keeps gh's token variables; keychain access remains a host limit.
 */
export function ghEnvironment(
  domain: Pick<
    DomainStore,
    | "claudeTokenReference"
    | "projects"
    | "deliveryCredentialReference"
    | "discoveryCredentialReference"
  > &
    Partial<Pick<DomainStore, "githubConfiguration" | "codeHostCredentials">>,
  options?: { reference: string | null; environment?: NodeJS.ProcessEnv },
): NodeJS.ProcessEnv {
  const environment = options?.environment ?? process.env;
  const claudeRef = domain.claudeTokenReference();
  const claude = claudeRef
    ? claudeTokenExclusions(claudeRef, environment)
    : { names: [], values: [] };
  const delivery = domain.projects().flatMap((p) => {
    const ref = domain.deliveryCredentialReference(String(p.id));
    return ref ? [ref.slice(4)] : [];
  });
  const discoveryRef = domain.discoveryCredentialReference();
  const reference = options ? options.reference : discoveryRef;
  const sources = domain.projects().flatMap((p) => {
    const ref = domain.githubConfiguration?.(String(p.id)).credentialRef;
    return ref?.startsWith("env:") ? [ref.slice(4)] : [];
  });
  const discovery = discoveryRef?.startsWith("env:")
    ? [discoveryRef.slice(4)]
    : [];
  const gh = ["GH_TOKEN", "GITHUB_TOKEN"];
  // GitLab credentials never reach gh: glab's variables, `env:` GitLab names and resolved values.
  const gitlab = gitLabCredentialExclusions(
    (domain.codeHostCredentials?.() ?? []).map((c) => c.credentialRef),
    environment,
  );
  const result = credentialFreeEnvironment(
    environment,
    [
      ...delivery,
      ...sources,
      ...claude.names,
      ...discovery,
      ...gh,
      ...gitlab.names,
    ],
    environment,
    [
      ...claude.values,
      ...credentialReferenceExclusions(null, environment).values,
      ...gitlab.values,
    ],
  );
  // Explicit gh selection permits only these current variables, even when another
  // configured credential shares their name or value. All aliases remain removed.
  if (reference === "gh:github.com")
    for (const key of gh)
      if (environment[key] !== undefined) result[key] = environment[key];
  return result;
}
