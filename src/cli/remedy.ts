import type { AttentionCode } from "../operator/attention.js";
import { nextActor, type TaskColumn } from "../operator/task-presentation.js";
import type { CliError } from "./connections.js";

/**
 * Human-output remedies. A human error ends with exactly one `Fix:` line and a
 * success may end with `Next:` lines; JSON and JSONL output never carry either.
 * Sites that know better set `CliError.extra.fix`; everything else falls back to
 * `DEFAULT_FIX` by code, then `CATEGORY_FIX` by category, so a remedy always exists.
 */
export const fixLine = (text: string) => `Fix: ${text}`;
/**
 * `command` is a runnable `cab ...` command, not prose. The task views' `Next:` line is a
 * different thing: it names who acts next (`nextText`), not a command to run.
 */
export const nextLine = (command: string) => `Next: ${command}`;

/**
 * The task holds in the operator UI's words. The writer, capacity and uncertainty holds share one
 * clearing condition and one path (`recovery get`), so they read as one `Ownership held`; the
 * individual flags stay in JSON and in the recovery views.
 */
export function heldLabels(holds: {
  stop: boolean;
  writer: boolean;
  capacity: boolean;
  uncertainty: boolean;
  task: boolean;
}): string[] {
  return [
    ...(holds.stop ? ["Stop requested"] : []),
    ...(holds.task ? ["Task hold"] : []),
    ...(holds.writer || holds.capacity || holds.uncertainty
      ? ["Ownership held"]
      : []),
  ];
}

/**
 * The labels for a task read. A Stop sets the task-wide hold flag too, so with a Stop in effect
 * the flag only counts as a `Task hold` when the read also reports a hold other than Stop
 * (`taskHold`), as the task page's hold list does.
 */
export const taskHeldLabels = (data: {
  execution: { holds: Parameters<typeof heldLabels>[0] };
  taskHold: unknown;
}) =>
  heldLabels({
    ...data.execution.holds,
    task:
      data.execution.holds.task &&
      (!data.execution.holds.stop || data.taskHold !== null),
  });

/** Who acts next, by the UI's rule, without the web's `Next: ` prefix. */
export function nextText(codes: readonly AttentionCode[], column: TaskColumn) {
  const { text, operator } = nextActor(codes, column);
  return { text: text.replace(/^Next: /, ""), operator };
}

const LOGIN = "run 'cab auth login' to store a credential again";
const LIST = "'cab connection list' shows the saved connections";

/** One entry per key of `EXIT` in main.ts; a test keeps the two in step. */
export const DEFAULT_FIX: Record<string, string> = {
  usage: "Run 'cab --help'.",
  "invalid-input":
    "Correct the option named above; 'cab --help --all' lists each command's options.",
  "invalid-url":
    "Use https://HOST[:PORT] or http://127.0.0.1:PORT with no path.",
  "invalid-token-file":
    "Put the token alone in a file only you can read (chmod 600) and pass it with --token-file PATH.",
  "invalid-configuration": `Correct the connections file named above, then check it with 'cab connection list'.`,
  "connection-ambiguous":
    "Pass --connection NAME, or run 'cab connection use NAME' to set the default.",
  "connection-not-found": `Run 'cab auth login --connection NAME --url ORIGIN'; ${LIST}.`,
  "not-found":
    "Check the ID against the matching list command, for example 'cab task list'.",
  "credential-invalid": `The service refused the credential (expired or revoked); ${LOGIN}.`,
  "credential-not-found":
    "Run 'cab auth login' to store a credential for this connection.",
  "insufficient-scope":
    "Log in with a read-write credential: 'cab auth login --connection NAME --url ORIGIN --token-file PATH'.",
  forbidden: `This credential may not do that; ${LOGIN} with one that may.`,
  unauthenticated: `The credential was refused; ${LOGIN}.`,
  "managed-assignment":
    "Run the command from your own terminal, outside the cab-managed assignment.",
  "credential-store-unavailable":
    "On macOS unlock the Keychain and retry; otherwise log in with a token file: 'cab auth login --connection NAME --url ORIGIN --token-file PATH'.",
  "service-identity-changed": `Check the URL (${LIST}); if the service was reinstalled, ${LOGIN}.`,
  "output-exists":
    "Choose a path that does not exist yet, or move the existing file first.",
  "output-failed":
    "Check that the directory exists and is writable by you, then retry.",
  conflict:
    "Read the current state with the matching 'get' command, then retry with what it shows.",
  "policy-denied":
    "Read the task and its project with the matching 'get' command to see what the policy needs.",
  "change-document-invalid":
    "Prepare the change again with the matching 'prepare' command.",
  "wrong-service": `Use the connection for the installation the file was prepared against (${LIST}).`,
  "journal-unavailable":
    "Make the CLI state directory (CAB_CLI_CONFIG_DIR, default ~/.config/cab) writable by you, then retry.",
  "cursor-stale":
    "Repeat the command without --cursor to restart from the first page.",
  unavailable: `Check that the service is running and reachable, then retry (${LIST}).`,
  "redaction-limit":
    "The service holds more private material than it can redact against; ask its operator to reduce it. Retrying will not help.",
  "integrity-mismatch": "Retry the download; do not use any partial output.",
  "tls-verification-failed":
    "Point NODE_EXTRA_CA_CERTS at the service's CA certificate (a PEM file), then retry.",
  "redirect-rejected": `Check the connection URL (${LIST}); the service must answer at its own origin.`,
  "command-outcome-unknown":
    "Do not assume either outcome: repeat the same command with the same --request-id to settle it.",
  "unsupported-service": `Use a CLI that matches this service, or check the URL (${LIST}).`,
};

/** For codes outside `EXIT`, such as service-returned ones; keyed by the category main.ts derives. */
export const CATEGORY_FIX: Record<string, string> = {
  usage:
    "Correct the command and run it again; 'cab --help --all' lists the options.",
  authentication: `Check the credential, or ${LOGIN}.`,
  conflict:
    "Read the current state with the matching 'get' command, then retry.",
  unavailable: `Check that the service is running and reachable, then retry (${LIST}).`,
  uncertain:
    "Do not assume either outcome: repeat the same command with the same --request-id.",
  unsupported: `Use a CLI that matches this service, or check the URL (${LIST}).`,
};

/** The one-line remedy for a human error: the site's own, else by code, else by category. */
export function remedyFor(error: CliError, category: string): string {
  const key = error.extra.request?.key;
  const fix =
    error.extra.fix ??
    (error.code === "command-outcome-unknown" && key
      ? `Do not assume either outcome: repeat the same command with --request-id ${key} to settle it.`
      : undefined) ??
    DEFAULT_FIX[error.code] ??
    CATEGORY_FIX[category] ??
    CATEGORY_FIX.unavailable ??
    "Run 'cab --help'.";
  // A path or ID inside a fix must not be able to start a second line.
  return fix.replace(/\s*[\r\n]+\s*/g, " ");
}

/** One shell word: bare when it is plain, else single-quoted so nothing in it expands. */
export const shellWord = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
