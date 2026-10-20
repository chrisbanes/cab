import { createHash } from "node:crypto";
import { sourceCredentialReference } from "../core/credential-reference.js";
import type { IssueReference } from "../core/github-source.js";
import type { GitHubSelection } from "../core/github-source-contracts.js";
import type { SourceCredentialReason } from "../operator/source-credential.js";
import {
  detectGh,
  type GhLoginScope,
  type GhOptions,
  ghToken,
  ghTokenAfterDetection,
} from "./gh-credential.js";
import {
  GitHubHttpSourceReader,
  type GitHubSourceReader,
} from "./github-source.js";

export {
  type SourceCredentialReason,
  sourceCredentialExplanation,
} from "../operator/source-credential.js";

export interface SourceCredentialOptions {
  /** Defaults to the current service environment on each read. */
  environment?: NodeJS.ProcessEnv;
  /** Supply an explicitly source-scoped `ghEnvironment`, independent of discovery. */
  gh?: GhOptions | (() => GhOptions);
}

/** Resolve only the selected source reference; discovery is never a fallback. */
export async function resolveGitHubSourceCredential(
  reference: string | null,
  options: SourceCredentialOptions = {},
): Promise<{ token: string } | { reason: SourceCredentialReason }> {
  if (reference === null) return { reason: "missing-credential" };
  const parsed = sourceCredentialReference.safeParse(reference);
  if (!parsed.success) return { reason: "invalid-credential-reference" };
  if (parsed.data.startsWith("env:")) {
    const token = (options.environment ?? process.env)[parsed.data.slice(4)];
    return token ? { token } : { reason: "missing-credential" };
  }
  try {
    const gh = typeof options.gh === "function" ? options.gh() : options.gh;
    const resolved = await ghToken(gh);
    return "token" in resolved ? resolved : { reason: `gh-${resolved.state}` };
  } catch {
    // A failed source-scoped environment must never fall back to host gh.
    return { reason: "gh-unreadable" };
  }
}

/** Detection offers an account; usability requires resolving the chosen source credential. */
export async function gitHubSourceCredentialStatus(
  reference: string | null,
  options: SourceCredentialOptions = {},
  scope?: GhLoginScope,
) {
  let ghOptions: GhOptions | undefined;
  let captureFailed = false;
  try {
    const captured =
      typeof options.gh === "function" ? options.gh() : options.gh;
    ghOptions = {
      ...captured,
      environment: { ...(captured?.environment ?? process.env) },
    };
  } catch {
    captureFailed = true;
  }
  const current: SourceCredentialOptions = {
    ...(options.environment ? { environment: options.environment } : {}),
    ...(ghOptions ? { gh: ghOptions } : {}),
  };
  const gh = captureFailed
    ? { state: "unreadable" as const }
    : await (scope ? scope.detect(ghOptions!) : detectGh(ghOptions));
  const resolved =
    reference === "gh:github.com"
      ? captureFailed
        ? { reason: "gh-unreadable" as const }
        : await ghTokenAfterDetection(gh, ghOptions).then((result) =>
            "token" in result
              ? result
              : { reason: `gh-${result.state}` as SourceCredentialReason },
          )
      : await resolveGitHubSourceCredential(reference, current);
  return {
    configured: reference !== null,
    source:
      reference === "gh:github.com"
        ? ("gh" as const)
        : reference?.startsWith("env:")
          ? ("env" as const)
          : null,
    usable: "token" in resolved,
    reason: "reason" in resolved ? resolved.reason : null,
    gh,
  };
}

export interface CredentialSourceReaderOptions extends SourceCredentialOptions {
  fetcher?: typeof fetch;
  /** Injection seam; a fresh delegate receives each public read's resolved token. */
  reader?: (token: string) => GitHubSourceReader;
}

/** Synchronizer-owned, memory-only pauses keyed by the resolved token identity. */
export class SourceRateLimitPauses {
  private readonly until = new Map<string, number>();

  private identity(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }

  paused(token: string): boolean {
    const key = this.identity(token);
    const until = this.until.get(key);
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    this.until.delete(key);
    return false;
  }

  note(token: string, result: { reason?: string | null; resumeAt?: number }) {
    if (result.reason === "rate-limited" && result.resumeAt !== undefined)
      this.until.set(this.identity(token), result.resumeAt);
  }
}

/**
 * Resolves the bound source reference on every public read. A blocker delegate's nested
 * status reads use that read's token; the next public read resolves again.
 */
export class CredentialGitHubSourceReader implements GitHubSourceReader {
  constructor(
    private readonly reference: string | null,
    private readonly options: CredentialSourceReaderOptions = {},
    private readonly pauses?: SourceRateLimitPauses,
  ) {}

  withRateLimitPauses(scope: SourceRateLimitPauses) {
    return new CredentialGitHubSourceReader(
      this.reference,
      this.options,
      scope,
    );
  }

  private async delegate() {
    const resolved = await resolveGitHubSourceCredential(
      this.reference,
      this.options,
    );
    return "reason" in resolved
      ? resolved
      : this.pauses?.paused(resolved.token)
        ? { reason: "rate-limited" as const }
        : {
            token: resolved.token,
            reader: this.options.reader
              ? this.options.reader(resolved.token)
              : new GitHubHttpSourceReader(
                  resolved.token,
                  this.options.fetcher,
                ),
          };
  }

  async readSelection(selection: GitHubSelection) {
    const resolved = await this.delegate();
    if ("reason" in resolved)
      return { complete: false as const, issues: [], reason: resolved.reason };
    const result = await resolved.reader.readSelection(selection);
    this.pauses?.note(resolved.token, result);
    return result;
  }

  async readIssueStatus(reference: IssueReference) {
    const resolved = await this.delegate();
    if ("reason" in resolved)
      return { status: "unknown" as const, reason: resolved.reason };
    const result = await resolved.reader.readIssueStatus(reference);
    this.pauses?.note(resolved.token, result);
    return result;
  }

  async readBlockers(reference: IssueReference) {
    const resolved = await this.delegate();
    if ("reason" in resolved)
      return { complete: false, blockers: [], reason: resolved.reason };
    const result = await resolved.reader.readBlockers(reference);
    this.pauses?.note(resolved.token, result);
    return result;
  }
}
