import type { jiraCredentialReasons } from "./contracts.js";

export type SourceCredentialReason =
  | "missing-credential"
  | "invalid-credential-reference"
  | "gh-not-installed"
  | "gh-not-signed-in"
  | "gh-unreadable";

/** Safe guidance shared by operator surfaces for source credential failures. */
export function sourceCredentialExplanation(
  reason: SourceCredentialReason,
): string {
  switch (reason) {
    case "missing-credential":
      return "GitHub source credential required. Choose GitHub CLI or an available service environment variable in Task source settings, then preview this source version.";
    case "invalid-credential-reference":
      return "GitHub source credential is invalid. Choose GitHub CLI or an environment variable in Task source settings.";
    case "gh-not-installed":
      return "GitHub CLI is not installed on the service host. Install gh or change the credential in Task source settings, then retry preview.";
    case "gh-not-signed-in":
      return "GitHub CLI is not signed in. Run gh auth login on the service host or change the credential in Task source settings, then retry preview.";
    case "gh-unreadable":
      return "The service cannot read the GitHub CLI login. Check the service's access to gh or change the credential in Task source settings, then retry preview.";
  }
}

/** Why a Jira site credential is unusable, shared by Task source settings and the ready check. */
export function jiraCredentialExplanation(
  reason: (typeof jiraCredentialReasons)[number],
): string {
  switch (reason) {
    case "missing-credential":
      return "a variable has no value in the service environment";
    case "site-invalid":
      return "the site variable must be an https:// address with no path or port";
    case "site-mismatch":
      return "the site variable now names a different site";
    case "site-unreachable":
      return "the site could not be reached";
    case "not-jira":
      return "the address is not a Jira Cloud site";
    case "unauthorized":
      return "Jira rejected the email and token";
  }
}
