import { sourceCredentialReference } from "../core/credential-reference.js";
import type { GitHubSelection } from "../core/github-source-contracts.js";
import type { IssueReference } from "../core/github-source.js";
import { detectGh, ghToken, type GhOptions } from "./gh-credential.js";
import {
  GitHubHttpSourceReader,
  type GitHubSourceReader,
} from "./github-source.js";

import type { SourceCredentialReason } from "../operator/source-credential.js";
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
) {
  let ghOptions: GhOptions | undefined;
  let captureFailed = false;
  try {
    ghOptions = typeof options.gh === "function" ? options.gh() : options.gh;
  } catch {
    captureFailed = true;
  }
  const current: SourceCredentialOptions = {
    ...(options.environment ? { environment: options.environment } : {}),
    ...(ghOptions ? { gh: ghOptions } : {}),
  };
  const [gh, resolved] = await Promise.all([
    captureFailed ? { state: "unreadable" as const } : detectGh(ghOptions),
    captureFailed && reference === "gh:github.com"
      ? { reason: "gh-unreadable" as const }
      : resolveGitHubSourceCredential(reference, current),
  ]);
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

/**
 * Resolves the bound source reference on every public read. A blocker delegate's nested
 * status reads use that read's token; the next public read resolves again.
 */
export class CredentialGitHubSourceReader implements GitHubSourceReader {
  constructor(
    private readonly reference: string | null,
    private readonly options: CredentialSourceReaderOptions = {},
  ) {}

  private async delegate() {
    const resolved = await resolveGitHubSourceCredential(
      this.reference,
      this.options,
    );
    return "reason" in resolved
      ? resolved
      : {
          reader: this.options.reader
            ? this.options.reader(resolved.token)
            : new GitHubHttpSourceReader(resolved.token, this.options.fetcher),
        };
  }

  async readSelection(selection: GitHubSelection) {
    const resolved = await this.delegate();
    return "reason" in resolved
      ? { complete: false as const, issues: [], reason: resolved.reason }
      : resolved.reader.readSelection(selection);
  }

  async readIssueStatus(reference: IssueReference) {
    const resolved = await this.delegate();
    return "reason" in resolved
      ? { status: "unknown" as const, reason: resolved.reason }
      : resolved.reader.readIssueStatus(reference);
  }

  async readBlockers(reference: IssueReference) {
    const resolved = await this.delegate();
    return "reason" in resolved
      ? { complete: false, blockers: [], reason: resolved.reason }
      : resolved.reader.readBlockers(reference);
  }
}
