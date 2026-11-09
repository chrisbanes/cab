/**
 * The one wording for a project's dangerouslySkipSandbox setting (ADR-1029). The server
 * disclosure, the CLI and the web import it, so every surface that shows the effective policy
 * reads the same. Each line stays within the 300-character policy disclosure cap.
 */

/** What the setting sends Codex for a task turn. */
export const codexSkipSandboxLine =
  "A project that skips the sandbox runs its Codex task turns with sandbox policy dangerFullAccess; the approval policy stays never. Draft, read-only and unbound turns never skip it.";

/** What the setting sends Claude Code for a task turn. */
export const claudeSkipSandboxLine =
  "A project that skips the sandbox runs its Claude Code task turns with Claude Code's sandbox disabled. Draft, read-only and unbound turns never skip it.";

/** The threat model, in two lines so each fits the disclosure cap. */
export const skipSandboxRiskLines = [
  "An unsandboxed turn has the service user's full filesystem, process, network and credential access, and untrusted text, including issue and pull request bodies, can drive it. Claude Code's edit-tool confinement still applies but is not a boundary.",
  "Processes it starts, such as emulators and browsers, can outlive the turn; cab does not clean them up. The Claude subprocess environment scrub, per-task temporary directory confinement and Seatbelt self-test no longer hold. Only macOS is qualified.",
];

/** The risks as one paragraph, for the CLI and the confirmation dialog. */
export const skipSandboxRisk = skipSandboxRiskLines.join(" ");

/** Saves apply to later admissions only. */
export const skipSandboxAppliesNote =
  "Applies to task turns admitted after the change; running turns keep their policy.";

/** Network access and local listening are covered by the grant while the setting is on. */
export const skipSandboxSupersededLine =
  "Superseded while skipping the sandbox: an unsandboxed command can use the network and listen on ports. The stored value is kept and applies again when the setting is off.";

export const projectSkipSandboxLine = (enabled: boolean) =>
  enabled
    ? "Skip sandbox is enabled for this project's task turns in both harnesses."
    : "Skip sandbox is disabled for this project.";

/** `null` is a turn with no recorded admission: not admitted yet, held before admission, or admitted before the setting existed. */
export const turnSkipSandboxLine = (value: boolean | null) =>
  value === null
    ? "No skip-sandbox admission recorded; the project's setting at admission applies."
    : value
      ? "Admitted with the sandbox skipped."
      : "Admitted with the sandbox in force.";
