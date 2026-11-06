/**
 * The one wording for a project's local listening (SPEC execution policy, ADR-1027). The server
 * disclosure, the CLI and the web import it, so every surface that shows the effective policy
 * reads the same. cab enforces only what it sends the runtime; the runtime enforces access.
 */

/** What Claude Code's `allowLocalBinding` permits, as measured in the 2026-11-06 probe. */
export const claudeLocalListeningLine =
  "Commands can listen on local ports only when the project enables local listening, and outbound network stays denied. Claude Code does not limit binding to loopback, so a listener on 0.0.0.0 accepts connections on any interface the host allows.";

/** Codex has no loopback-only per-turn control; the setting never reaches a Codex turn. */
export const codexLocalListeningLine =
  "Codex has no loopback-only control: commands can listen on local ports, on any interface, only when command network access is enabled. The local listening setting does not change Codex turns.";

export const localListeningLimit =
  "Other processes on the host can connect to a listening port, and a command allowed to listen can also connect to other services on the host's loopback interface.";

/** Saves apply to later admissions only. */
export const localListeningAppliesNote =
  "Applies to Claude Code task turns admitted after the change; running turns keep their policy.";

export const projectLocalListeningLine = (enabled: boolean) =>
  enabled
    ? "Local listening is enabled for this project's Claude Code task turns; Codex turns can listen only with command network access."
    : "Local listening is disabled for this project.";

/** `null` is a turn with no recorded admission: not admitted yet, held before admission, or admitted before the setting existed. */
export const turnLocalListeningLine = (value: boolean | null) =>
  value === null
    ? "No local listening admission recorded; the project's setting at admission applies."
    : value
      ? "Admitted with local listening enabled."
      : "Admitted with local listening disabled.";
