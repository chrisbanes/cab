/**
 * The one wording for a project's command network access (SPEC execution policy). The server
 * disclosure, the CLI and the web import it, so every surface that shows the effective policy
 * reads the same. Ensemble enforces only what it sends the runtime; the runtime enforces access.
 */
export const commandNetworkDisclosure =
  "Network-enabled commands can reach whatever credentials and logins the host exposes.";

/** Saves apply to later admissions only. */
export const commandNetworkAppliesNote =
  "Applies to turns admitted after the change; running turns keep their policy.";

export const projectCommandNetworkLine = (enabled: boolean) =>
  enabled
    ? "Command network access is enabled for this project's Codex turns; Claude Code turns keep it denied."
    : "Command network access is disabled for this project.";

/** `null` is a turn that has not been admitted yet. */
export const turnCommandNetworkLine = (value: boolean | null) =>
  value === null
    ? "Not yet admitted; the project's setting at admission applies."
    : value
      ? "Admitted with command network access enabled."
      : "Admitted with command network access disabled.";
