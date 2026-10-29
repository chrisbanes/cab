import { execFile } from "node:child_process";
import { credentialFreeEnvironment } from "../core/child-environment.js";
import type { DomainStore } from "../core/domain.js";
import { claudeTokenExclusions } from "./claude-token.js";
import { credentialReferenceExclusions } from "./gh-credential.js";

export type GlabFailureState = "not-installed" | "not-signed-in" | "unreadable";

export interface GlabOptions {
  /** Defaults to `glab` on the service `PATH`. */
  executable?: string | undefined;
  /** Defaults to 10 seconds. */
  timeoutMs?: number;
  /** The environment `glab` runs with; see `glabEnvironment`. */
  environment?: NodeJS.ProcessEnv;
}

/** glab's documented token variables; any of them overrides a stored login. */
export const glabTokenVariables = [
  "GITLAB_TOKEN",
  "GITLAB_ACCESS_TOKEN",
  "OAUTH_TOKEN",
] as const;

// glab prints `✓ Token: <t>` (v1.30-v1.60) or `✓ Token found in <where>: <t>` (current main)
// on stderr when run with --show-token.
const tokenLine =
  /^\s*\S*\s*Token(?: found in [^:\n]*)?:\s+([\x21-\x7e]{1,512})\s*$/;

/**
 * The token for one host from `glab auth status --show-token`, run on every call and never
 * cached. glab reports on stderr, so both streams are read in memory and never surfaced.
 */
export async function glabToken(
  host: string,
  options: GlabOptions = {},
): Promise<{ token: string } | { state: GlabFailureState }> {
  const result = await new Promise<
    { output: string } | { state: GlabFailureState }
  >((resolve) => {
    const child = execFile(
      options.executable ?? "glab",
      ["auth", "status", "--hostname", host, "--show-token"],
      {
        env: {
          ...(options.environment ?? process.env),
          NO_PROMPT: "1",
          GLAB_CHECK_UPDATE: "false",
          NO_COLOR: "1",
        },
        timeout: options.timeoutMs ?? 10_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ output: `${stderr}\n${stdout}` });
        const e = error as NodeJS.ErrnoException & { killed?: boolean };
        resolve({
          state:
            e.code === "ENOENT"
              ? "not-installed"
              : typeof e.code === "number" && !e.killed
                ? "not-signed-in"
                : "unreadable",
        });
      },
    );
    child.on("error", () => {});
    child.stdin?.end();
  });
  if ("state" in result) return result;
  const tokens = result.output.split(/\r?\n/).flatMap((line) => {
    const match = tokenLine.exec(line);
    return match?.[1] ? [match[1]] : [];
  });
  const token = tokens.length === 1 ? tokens[0] : undefined;
  // `*` only: glab's mask for a hidden token, which is no credential.
  if (!token || /^\*+$/.test(token)) return { state: "unreadable" };
  remember(token);
  return { token };
}

// Exclusion-only lifetime memory grows with distinct rotations; each value is at most 512 bytes.
const resolved = new Set<string>();
function remember(token: string) {
  resolved.add(token);
}

/** True when a glab login is shadowed by one of glab's token variables in `env`. */
export function glabOverridden(env: NodeJS.ProcessEnv = process.env): boolean {
  return glabTokenVariables.some((name) => Boolean(env[name]));
}

/**
 * What children and public output must exclude for GitLab credential references: env names
 * to drop, values to drop wherever they appear, and every string to redact. A `glab:` reference
 * contributes glab's token variables; every token value this process has resolved is always
 * included. Pass no references for the resolved values alone.
 */
export function gitLabCredentialExclusions(
  refs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { names: string[]; values: string[]; redactions: string[] } {
  const names = [
    ...new Set(
      refs.flatMap((ref) =>
        ref.startsWith("glab:")
          ? glabTokenVariables
          : ref.startsWith("env:")
            ? [ref.slice(4)]
            : [],
      ),
    ),
  ];
  const values = [...resolved, ...names.flatMap((name) => env[name] || [])];
  return {
    names,
    values,
    redactions: [
      ...refs,
      ...refs.filter((r) => r.startsWith("env:")).map((r) => r.slice(4)),
      ...values,
    ],
  };
}

/**
 * The environment for glab: unrelated source, discovery, delivery, Claude, GitHub and
 * `env:` GitLab credentials and their value aliases are removed. glab keeps only its own
 * token variables, so the account it reports is the one it would really use.
 */
export function glabEnvironment(
  domain: Pick<
    DomainStore,
    | "claudeTokenReference"
    | "projects"
    | "deliveryCredentialReference"
    | "discoveryCredentialReference"
  > &
    Partial<Pick<DomainStore, "githubConfiguration">> & {
      codeHostCredentials?: () => { credentialRef: string }[];
    },
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const claudeRef = domain.claudeTokenReference();
  const claude = claudeRef
    ? claudeTokenExclusions(claudeRef, environment)
    : { names: [], values: [] };
  const envName = (ref: string | null | undefined) =>
    ref?.startsWith("env:") ? [ref.slice(4)] : [];
  const projects = domain.projects();
  const names = [
    ...projects.flatMap((p) => [
      ...envName(domain.deliveryCredentialReference(String(p.id))),
      ...envName(domain.githubConfiguration?.(String(p.id)).credentialRef),
    ]),
    ...envName(domain.discoveryCredentialReference()),
    ...(domain.codeHostCredentials?.() ?? []).flatMap((c) =>
      envName(c.credentialRef),
    ),
    ...claude.names,
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ];
  const result = credentialFreeEnvironment(environment, names, environment, [
    ...claude.values,
    ...credentialReferenceExclusions(null, environment).values,
  ]);
  for (const key of glabTokenVariables)
    if (environment[key] !== undefined) result[key] = environment[key];
  return result;
}
