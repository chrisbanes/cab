#!/usr/bin/env node
import {
  defaultLocalState,
  readLocalAccess,
  localOrigin,
  LocalAccessError,
} from "../operator/local-access.js";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readinessSchema } from "../operator/readiness.js";
import {
  type CliIdentity,
  operatorCredentialTokenSchema,
  taskSchema,
} from "../operator/contracts.js";
import { readHiddenPassword } from "../standalone/operator-hidden-password.js";
import {
  CliError,
  type CliConfig,
  type Connection,
  ConnectionConfig,
  configDirectory,
  connectionNameSchema,
  KeychainCredentialStore,
  readTokenFile,
} from "./connections.js";
import { coverage, uuidArg } from "./browse.js";
import { browseCommands, writeCommands } from "./commands.js";
import {
  defaultServiceHost,
  type InstallCli,
  type OperatorConnection,
  localHelpArea,
  SERVICE_USAGE,
  serviceCommand,
  serviceHelp,
  snapshotCommand,
} from "./service.js";
import { jsonLine, terminalSafe, unavailable } from "./render.js";
import {
  DEFAULT_FIX,
  fixLine,
  nextLine,
  nextText,
  remedyFor,
  shellWord,
  taskHeldLabels,
} from "./remedy.js";
import { RequestJournal } from "./request-journal.js";
import { closureSuffix, waitLines } from "./task-write.js";
import { unmetReason } from "../operator/readiness-text.js";
import { taskColumnOf } from "../operator/task-presentation.js";
import { connectionOrigin, ServiceClient } from "./transport.js";
import type { CliDeps, Result, Values } from "./types.js";
import { rejectUnusedFlags } from "./write.js";

export type { CliDeps } from "./types.js";

const SCHEMA = "cab.cli/v1";
const KEYCHAIN_CLEANUP_MS = 20_000;
const TASK_CAPABILITIES = ["cli.identity", "task.read"] as const;

export const EXIT: Record<string, [number, string]> = {
  usage: [2, "usage"],
  "invalid-input": [2, "usage"],
  "invalid-url": [2, "usage"],
  "invalid-token-file": [2, "usage"],
  "invalid-configuration": [2, "usage"],
  "connection-ambiguous": [2, "usage"],
  "connection-not-found": [2, "usage"],
  "not-found": [2, "usage"],
  "credential-invalid": [3, "authentication"],
  "credential-not-found": [3, "authentication"],
  "insufficient-scope": [3, "authentication"],
  forbidden: [3, "authentication"],
  unauthenticated: [3, "authentication"],
  "managed-assignment": [3, "authentication"],
  "credential-store-unavailable": [3, "authentication"],
  "service-identity-changed": [3, "authentication"],
  "local-access-unavailable": [3, "authentication"],
  "output-exists": [2, "usage"],
  "output-failed": [2, "usage"],
  conflict: [4, "conflict"],
  "policy-denied": [4, "conflict"],
  "change-document-invalid": [2, "usage"],
  "wrong-service": [2, "usage"],
  "journal-unavailable": [5, "unavailable"],
  "cursor-stale": [4, "conflict"],
  unavailable: [5, "unavailable"],
  "redaction-limit": [5, "unavailable"],
  "integrity-mismatch": [5, "unavailable"],
  "tls-verification-failed": [5, "unavailable"],
  "redirect-rejected": [5, "unavailable"],
  "command-outcome-unknown": [6, "uncertain"],
  "unsupported-service": [7, "unsupported"],
};

/** Login copy and defaults, kept together so the help layout can move them. */
const AUTH_LOGIN_USAGE =
  "auth login [--url ORIGIN] [--connection NAME] [--token-file PATH]";
const DEFAULT_CONNECTION = "local";
/** The loopback origin `service install` serves on by default. */
const DEFAULT_ORIGIN = "http://127.0.0.1:8787";
const tokenSource = (origin: string) =>
  `Create a token in Settings → CLI credentials in the web UI, then run: cab auth login --url ${origin}`;

/** The first command of each help view for someone who has not used the CLI yet. */
const START_HERE = [
  "auth login",
  "doctor",
  "project list",
  "task list",
  "task get",
  "task create",
  "inbox list",
];

export const BUILTIN_USAGE = new Map([
  ["auth login", AUTH_LOGIN_USAGE],
  ["auth status", "auth status [--connection NAME]"],
  ["auth logout", "auth logout [--connection NAME]"],
  ["connection local", "connection local NAME [--local-state DATA_DIR]"],
  ["connection list", "connection list"],
  ["connection use", "connection use NAME"],
  ["connection remove", "connection remove NAME"],
  ["task get", "task get TASK_ID [--connection NAME]"],
]);

/** Every operator command's usage line by key ("area action", or "logs"/"doctor"). */
const COMMAND_USAGE = new Map<string, string>([
  ...BUILTIN_USAGE,
  ...[...browseCommands, ...writeCommands].map(
    ([key, c]) => [key, c.usage] as const,
  ),
]);
/** A usage line, and under it, when the command has one, the line saying what its expected-* flags check. */
const helpEntry = (key: string, usage: string) => {
  const expects = writeCommands.get(key)?.expects;
  return expects === undefined ? [usage] : [usage, `  ${expects}`];
};
const areaOf = (key: string) => key.split(" ")[0] ?? key;
const LOCAL_AREAS = ["service", "snapshot"];
const operatorAreas = () => [...new Set([...COMMAND_USAGE.keys()].map(areaOf))];
const areaNames = () => [...operatorAreas(), ...LOCAL_AREAS];
const indented = (lines: Iterable<string>) =>
  [...lines].map((line) => `  ${line}\n`).join("");

const OPTIONS_HELP = `Options:
  --local               Same-OS-account local read/write access
  --local-state DATA_DIR  Custom foreground data directory (with --local)
  --output human|json   Result format (default human)
  --limit N             Page size, 1-200 (default 50; some reads cap lower)
  --cursor TOKEN        Continue from the More: line of the previous page
  --output jsonl        logs only: one cab.cli/v1 record per line
  --follow              logs only: poll every --interval S (1-30, default 2)
                        for at most --max-duration S (default 900, max 86400)
  --help                Show this help
  --all                 With --help: list every command and option
  --verbose             execution list/get and logs only: also print capture notes
  --dry-run             apply only: print the stored change; connect and send nothing
  --version             Show the installed version
`;

const TASK_NOTE = `Task operations: task create, task message, task follow-up, task draft-turn, question answer
and approval decide cannot be undone. task start-again queues a refused request
again and keeps the refusal in the history; task reset replaces every
assignment's conversation, starts the lead fresh in the same workspace and
cannot be undone. Reverse pairs: task stop/resume (Stop is
best-effort cancellation of an open task; Resume clears only the operator
Stop),
add-dependency/remove-dependency and task configure --ready true/false.`;
const RUNTIME_NOTE = `Runtimes: runtime enable and runtime disable are a reverse pair. Disabling never
cancels a running turn; work bound to that runtime waits until it is enabled again,
and disabling one that bound tasks use needs --yes.`;
const DELIVERY_NOTE = `Sources and delivery: delivery send-comment posts a public GitHub comment that
The CLI cannot edit or retract, and a confirm-comment decision is final (deny
is the counterpart of approve). Removing a source selection discards its saved
definition. preview-source has no deactivate command; saving any source change
deactivates every selection. place-task is final once the task has an
assignment. delivery refresh is installation-wide. send-comment --review-id
first replays that review to check it is approved; an ID that is not an existing
review records a new pending review instead, and nothing is posted.
delivery publish-send creates a public GitHub issue and turns the local task into
it; nothing takes that back (close the issue on GitHub), and a publish-confirm
decision is final. publish-abandon gives up on a create whose outcome is unknown
and may leave a duplicate issue. delivery settle records your handback decision for
the pull request head, delivery policy version and task version it was read at; it
does not merge, close or comment on GitHub, does not complete the task, and has no
undo (a new push or policy change needs a new settlement).`;
const RESULT_NOTE = `Results: result deliver sends an undelivered result to the one recipient the service
permits (a lead or requester); it cannot be redirected or undone, and by itself
does not complete the task.`;
const RECOVERY_NOTE = `Recovery: recovery prepare writes an owner-only document from the observed
generation identity plus your --evidence-file; nothing is inferred, defaulted or
confirmed by a flag. recovery submit sends it once. Adoption, recovery and
conversation replacement cannot be undone, and none of them resumes the task or
dispatches work; continue with a new task message after replacement. Adoption
here records evidence and is unrelated to assignment apply-current.`;

/** The prose notes that name an area's commands. */
const LOCAL_ACCESS_NOTE = `Local access: cab auth status --local --local-state /absolute/private/cab-data
uses this OS account with read/write CLI authority, without a token or Keychain.
Saved token selections keep their scope, expiry and logout; they never fall back.
cab connection local NAME --local-state DATA_DIR deliberately saves local access
after checking the installation. Local login/logout explain OS-account access;
logout cannot disable it. This does not isolate same-account processes.
Installed-service discovery and lifecycle integration remain outstanding.`;

const AREA_NOTES: Record<string, string[]> = {
  auth: [LOCAL_ACCESS_NOTE],
  connection: [LOCAL_ACCESS_NOTE],
  task: [TASK_NOTE],
  question: [TASK_NOTE],
  approval: [TASK_NOTE],
  runtime: [RUNTIME_NOTE],
  delivery: [DELIVERY_NOTE],
  project: [DELIVERY_NOTE],
  recovery: [RECOVERY_NOTE],
  result: [RESULT_NOTE],
};

const ORIGIN_NOTE =
  "ORIGIN is https://HOST[:PORT], or http://127.0.0.1:PORT for a service on this machine.";

const areasLine = () => `Areas: ${areaNames().join(", ")}`;
/** What a usage error shows when no command or area could be recognised. */
const areasBlock = () => `Usage: cab <command> [options]\n${areasLine()}`;

/** `cab` and `cab --help`: where to start, and how to find the rest. */
function startHelp() {
  return `Usage: cab <command> [options]

Start here:
${indented(START_HERE.map((key) => COMMAND_USAGE.get(key) ?? key))}
${areasLine()}

  cab help AREA     The commands of one area (also: cab AREA --help)
  cab --help --all  Every command and option

Options:
  --connection NAME     Use this saved connection
  --local               Use same-OS-account local read/write access
  --local-state DATA_DIR  Select a foreground data directory (with --local)
                         Example: cab auth status --local --local-state /private/cab/data
  --output human|json   Result format (default human)
  --help [--all]        Show help
  --version             Show the installed version
`;
}

/** `cab help AREA` and `cab AREA --help`; undefined when `area` is not one. */
function areaHelp(area: string | undefined) {
  if (area === "service" || area === "snapshot") return serviceHelp(area);
  const lines = [...COMMAND_USAGE]
    .filter(([key]) => areaOf(key) === area)
    .flatMap(([key, usage]) => helpEntry(key, usage));
  if (!area || !lines.length) return undefined;
  const single = COMMAND_USAGE.has(area);
  return `Usage: cab ${area}${single ? "" : " <action>"} [options]

${indented(lines)}
${OPTIONS_HELP}${(AREA_NOTES[area] ?? []).map((note) => `\n${note}\n`).join("")}`;
}

/** `cab --help --all`: every command, with the local service commands in their own block. */
const fullHelp = () => `Usage: cab <command> [options]

Commands:
${indented([...COMMAND_USAGE].flatMap(([key, usage]) => helpEntry(key, usage))).trimEnd()}

${SERVICE_USAGE}
${OPTIONS_HELP}
${[TASK_NOTE, RUNTIME_NOTE, DELIVERY_NOTE, RESULT_NOTE, RECOVERY_NOTE].join("\n\n")}

${ORIGIN_NOTE}
`;

/** The usage lines a usage error shows: the command's, else its area's, else the areas. */
function usageBlock([first = "", second = ""]: string[]) {
  const key = COMMAND_USAGE.has(first) ? first : `${first} ${second}`;
  const exact = COMMAND_USAGE.get(key);
  const lines = exact
    ? [exact]
    : [...COMMAND_USAGE].filter(([k]) => areaOf(k) === first).map(([, u]) => u);
  return lines.length ? `Usage:\n${indented(lines)}` : `${areasBlock()}\n`;
}

const defaultDeps = (): CliDeps => ({
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  fetch,
  platform: process.platform,
  keychain: () => new KeychainCredentialStore(),
  now: Date.now,
});

/** Every option of the operator commands. */
export const OPTIONS = {
  local: { type: "boolean" },
  "local-state": { type: "string" },
  connection: { type: "string" },
  url: { type: "string" },
  "token-file": { type: "string" },
  output: { type: "string" },
  help: { type: "boolean" },
  all: { type: "boolean" },
  verbose: { type: "boolean" },
  "dry-run": { type: "boolean" },
  version: { type: "boolean" },
  limit: { type: "string" },
  cursor: { type: "string" },
  project: { type: "string" },
  state: { type: "string" },
  type: { type: "string" },
  after: { type: "string" },
  before: { type: "string" },
  historical: { type: "boolean" },
  revision: { type: "string" },
  out: { type: "string" },
  file: { type: "string" },
  "request-id": { type: "string" },
  "expected-version": { type: "string" },
  name: { type: "string" },
  summary: { type: "string" },
  instructions: { type: "string" },
  "instructions-file": { type: "string" },
  "capabilities-file": { type: "string" },
  "skills-file": { type: "string" },
  "restore-revision": { type: "string" },
  revoked: { type: "string" },
  model: { type: "string" },
  effort: { type: "string" },
  paused: { type: "string" },
  "lead-profile": { type: "string" },
  "diagnostic-capture": { type: "string" },
  "command-network-access": { type: "string" },
  id: { type: "string" },
  enabled: { type: "string" },
  "guidance-file": { type: "string" },
  "credential-ref": { type: "string" },
  candidates: { type: "string" },
  "global-limit": { type: "string" },
  "project-limit": { type: "string", multiple: true },
  scope: { type: "string" },
  task: { type: "string" },
  assignment: { type: "string" },
  execution: { type: "string" },
  kind: { type: "string" },
  severity: { type: "string" },
  follow: { type: "boolean" },
  yes: { type: "boolean" },
  interval: { type: "string" },
  "max-duration": { type: "string" },
  "compare-current": { type: "boolean" },
  title: { type: "string" },
  outcome: { type: "string" },
  "outcome-file": { type: "string" },
  ready: { type: "string" },
  blocker: { type: "string", multiple: true },
  assignee: { type: "string" },
  to: { type: "string" },
  "message-file": { type: "string" },
  "answers-file": { type: "string" },
  decision: { type: "string" },
  "expected-revision": { type: "string" },
  "material-hash": { type: "string" },
  "edit-file": { type: "string" },
  selection: { type: "string" },
  "body-file": { type: "string" },
  "expected-task-version": { type: "string" },
  "expected-delivery-revision": { type: "string" },
  "expected-policy-version": { type: "string" },
  "expected-head-sha": { type: "string" },
  "review-id": { type: "string" },
  target: { type: "string" },
  "publication-id": { type: "string" },
  issue: { type: "string" },
  work: { type: "string" },
  "evidence-file": { type: "string" },
  "expected-conversation-revision": { type: "string" },
} as const;

export async function main(
  argv: string[],
  deps: CliDeps = defaultDeps(),
): Promise<number> {
  // Local commands on the service's own Mac, outside the operator CLI's options.
  const local = localHelpArea(argv);
  if (local) {
    deps.stdout.write(serviceHelp(local));
    return 0;
  }
  if (argv[0] === "service")
    return serviceCommand(
      argv.slice(1),
      deps,
      (name) => operatorConnection(deps, name),
      defaultServiceHost,
      installCli(deps),
    );
  if (argv[0] === "snapshot") return snapshotCommand(argv.slice(1), deps);
  let json = false;
  let jsonl = false;
  let positionals: string[] | undefined;
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: OPTIONS,
    });
    const { values } = parsed;
    positionals = parsed.positionals;
    jsonl = values.output === "jsonl" && positionals[0] === "logs";
    if (
      values.output !== undefined &&
      !["human", "json"].includes(values.output) &&
      !jsonl
    )
      throw new CliError(
        "usage",
        "--output must be human or json (jsonl only for logs).",
      );
    json = values.output === "json";
    if (values.version) {
      // Resolves from dist/src/cli/main.js in a checkout, an npm install and a release.
      const pkg = JSON.parse(
        readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      deps.stdout.write(`cab ${pkg.version}\n`);
      return 0;
    }
    if (values.all && !values.help)
      throw new CliError("usage", "--all only goes with --help.");
    if (values.help) {
      // `cab help AREA --help` is the area's help too.
      const [first, second] = positionals;
      deps.stdout.write(
        (values.all
          ? fullHelp()
          : areaHelp(first === "help" ? second : first)) ?? startHelp(),
      );
      return 0;
    }
    if (positionals.length === 0) {
      // A bare invocation is a usage error: the help stays on stdout, the remedy goes to stderr.
      deps.stdout.write(startHelp());
      if (!json) deps.stderr.write(`${fixLine(DEFAULT_FIX.usage ?? "")}\n`);
      return 2;
    }
    if (positionals[0] === "help") {
      const [, area, ...extra] = positionals;
      if (area === undefined)
        throw new CliError("usage", "Name an area: cab help AREA.");
      const help = areaHelp(area);
      if (help === undefined)
        throw new CliError("usage", `Unknown area '${area}'.`);
      if (extra.length) throw new CliError("usage", "Unexpected arguments.");
      deps.stdout.write(help);
      return 0;
    }
    if (
      values.local &&
      (values.url !== undefined || values["token-file"] !== undefined)
    )
      throw new CliError(
        "usage",
        "--local cannot be combined with token login options.",
      );
    if (values.local && values.connection !== undefined)
      throw new CliError("usage", "Choose --local or --connection, not both.");
    if (
      values["local-state"] !== undefined &&
      !values.local &&
      positionals.slice(0, 2).join(" ") !== "connection local"
    )
      throw new CliError(
        "usage",
        "--local-state requires --local or connection local.",
      );
    const result = await run(positionals, values, {
      ...deps,
      forceLocal: values.local,
      localState: values["local-state"],
    });
    if (result.streamed) return 0;
    if (json)
      deps.stdout.write(
        `${jsonLine({
          schema: SCHEMA,
          observedAt: deps.now(),
          ...(result.connection ? { connection: result.connection } : {}),
          ...(result.service ? { service: result.service } : {}),
          data: result.data,
          ...(result.pagination ? { pagination: result.pagination } : {}),
          ...(result.coverage ? { coverage: result.coverage } : {}),
          ...(result.request ? { request: result.request } : {}),
        })}\n`,
      );
    else deps.stdout.write(`${terminalSafe(result.human)}\n`);
    return 0;
  } catch (raw) {
    const error =
      raw instanceof CliError
        ? raw
        : raw instanceof Error &&
            "code" in raw &&
            String(raw.code).startsWith("ERR_PARSE_ARGS")
          ? new CliError(
              "usage",
              // Node's hint to pass a leading "-" word after "--" is wrong advice for `-h`.
              raw.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
                ? `${raw.message.split(". To specify")[0]}.`
                : raw.message,
            )
          : new CliError("unavailable", "Unexpected CLI failure.", {
              fix: "Reads can be retried. After a write, check the state with the matching 'get' command before repeating it, and report the failure with the command you ran.",
            });
    const [exit, category] =
      EXIT[error.code] ??
      (error.extra.status === 409
        ? [4, "conflict"]
        : error.extra.status && error.extra.status < 500
          ? [2, "usage"]
          : [5, "unavailable"]);
    if (json || jsonl)
      deps.stdout.write(
        `${jsonLine({
          schema: SCHEMA,
          ...(jsonl ? { type: "error" } : {}),
          error: {
            code: error.code,
            category,
            message: error.message,
            requestId: error.extra.requestId ?? null,
            retryable: error.extra.retryable ?? false,
            outcome:
              error.code === "command-outcome-unknown"
                ? "unknown"
                : "not-applied",
            ...(error.extra.request ? { request: error.extra.request } : {}),
          },
        })}\n`,
      );
    else {
      const lines =
        error.code === "usage" ? usageBlock(positionals ?? lenient(argv)) : "";
      deps.stderr.write(
        `cab: ${terminalSafe(error.message)} (${error.code}${error.extra.requestId && !error.extra.notSent ? `, request ${error.extra.requestId}` : ""})\n${lines}${terminalSafe(fixLine(remedyFor(error, category)))}\n`,
      );
    }
    return exit;
  }
}

/** The words of a command line that did not parse, for the usage block of its error. */
function lenient(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: false,
      options: OPTIONS,
    }).positionals;
  } catch {
    return [];
  }
}

function expectArgs(positionals: string[], count: number) {
  if (positionals.length !== count)
    throw new CliError("usage", "Unexpected arguments.");
}

function rejectManaged(env: NodeJS.ProcessEnv) {
  // Prevents accidental privilege crossing only; it is not OS isolation.
  if (env.CAB_MANAGED_ASSIGNMENT)
    throw new CliError(
      "managed-assignment",
      "Operator credentials are unavailable inside a cab-managed assignment.",
    );
}

/**
 * The options a command takes, besides the always-allowed ones: a write command's `flags`, and for
 * every other command the options its usage line names. Undefined for a key that is no command.
 */
export function declaredOptions(key: string): readonly string[] | undefined {
  const write = writeCommands.get(key);
  if (write) return write.flags;
  const usage = browseCommands.get(key)?.usage ?? BUILTIN_USAGE.get(key);
  return usage === undefined ? undefined : usageOptions(usage);
}
export const usageOptions = (usage: string) =>
  [...usage.matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)].map((m) => m[1] ?? "");

async function run(
  positionals: string[],
  values: Values,
  deps: CliDeps,
): Promise<Result> {
  const config = new ConnectionConfig(configDirectory(deps.env));
  const [area, action, argument] = positionals;
  const requested = values.connection ?? deps.env.CAB_CONNECTION;
  // `logs` and `doctor` are the only single-word commands.
  const singleWord = area === "logs" || area === "doctor";
  const key = singleWord ? area : `${area} ${action}`;
  // Before any handler runs, so no command acts on an option it does not take.
  const declared = declaredOptions(key);
  if (!declared) throw new CliError("usage", "Unknown command.");
  rejectUnusedFlags(values, declared);
  if (key === "connection local") {
    expectArgs(positionals, 3);
    rejectManaged(deps.env);
    const parsedName = connectionNameSchema.safeParse(argument);
    if (!parsedName.success)
      throw new CliError(
        "usage",
        "NAME must be a connection name (letters, digits, . _ -).",
      );
    const name = parsedName.data;
    const state = resolve(values["local-state"] ?? defaultLocalState());
    const session = await connect(
      config,
      undefined,
      { ...deps, forceLocal: true, localState: state },
      ["cli.identity"],
    );
    const current = await config.read();
    const prior = current.connections[name];
    if (
      prior &&
      prior.installationId !== session.identity.service.installationId
    )
      throw new CliError(
        "service-identity-changed",
        "Adoption must bind the existing connection's installation. The prior connection has been preserved.",
      );
    current.connections[name] = {
      url: session.url,
      installationId: session.identity.service.installationId,
      credential: { kind: "local", state },
    };
    await config.write(current);
    return {
      ...session.result,
      connection: name,
      data: {
        connection: name,
        accessMode: "local",
        service: session.result.service,
      },
      human: `Connection ${name} now uses local read/write access to ${session.url} through this OS account. Its previous server token and token file have not been changed.`,
    };
  }
  if (key === "auth login") {
    expectArgs(positionals, 2);
    rejectManaged(deps.env);
    if (values.url === undefined && values["token-file"] === undefined) {
      const current = await config.read();
      let local =
        deps.forceLocal ||
        (requested === undefined &&
          current.default === undefined &&
          !Object.keys(current.connections).length);
      if (!local) {
        try {
          local =
            config.select(current, requested).connection.credential?.kind ===
            "local";
        } catch (error) {
          if (!(error instanceof CliError)) throw error;
        }
      }
      if (local) {
        const session = await connect(config, requested, deps, [
          "cli.identity",
        ]);
        return {
          ...session.result,
          data: { accessMode: "local", service: session.result.service },
          human: `Local access to ${session.url} uses this OS account with read/write authority; no token or separate login is needed.`,
        };
      }
    }
    return login(config, values, deps);
  }
  if (key === "auth status") {
    expectArgs(positionals, 2);
    rejectManaged(deps.env);
    const session = await connect(config, requested, deps, []);
    const { identity } = session;
    const expires =
      identity.credential.expiresAt === null
        ? "never (OS-account access)"
        : new Date(identity.credential.expiresAt ?? 0).toISOString();
    return {
      ...session.result,
      data: identity,
      human: [
        `Connection:   ${session.name}`,
        `URL:          ${session.url}`,
        `Access mode:  ${session.accessMode}`,
        `Installation: ${identity.service.installationId}`,
        `Credential:   ${identity.credential.name} (${identity.credential.scope}), expires ${expires}`,
        `API:          version ${identity.apiVersion}`,
      ].join("\n"),
    };
  }
  if (key === "auth logout") {
    expectArgs(positionals, 2);
    rejectManaged(deps.env);
    const current = await config.read();
    const { name, connection } = await selectConnection(
      config,
      current,
      requested,
      deps,
    );
    if (connection.credential?.kind === "local") {
      const session = await connect(config, requested, deps, []);
      return {
        ...session.result,
        data: { connection: name, accessMode: "local", loggedOut: false },
        human: `Local access to ${session.url} is provided by this OS account. Logout does not disable OS-account access; no token was removed.`,
      };
    }
    if (
      connection.credential?.kind === "keychain" &&
      deps.platform === "darwin"
    )
      await deps.keychain().delete(connection.credential.account);
    const { credential: _removed, ...rest } = connection;
    current.connections[name] = rest;
    await config.write(current);
    return {
      connection: name,
      data: {
        connection: name,
        accessMode: "token",
        url: connection.url,
        installationId: connection.installationId,
        loggedOut: true,
      },
      human: `Token access to ${name} (${connection.url}): removed the local credential. The server credential stays active until it is revoked in Settings or expires.`,
    };
  }
  if (key === "connection list") {
    expectArgs(positionals, 2);
    const current = await config.read();
    const rows = Object.entries(current.connections)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, c]) => ({
        name,
        url: c.url,
        installationId: c.installationId,
        credential: c.credential?.kind ?? null,
        accessMode: c.credential?.kind === "local" ? "local" : "token",
        default: current.default === name,
      }));
    return {
      data: { connections: rows },
      human: rows.length
        ? rows
            .map(
              (r) =>
                `${r.default ? "*" : " "} ${r.name}  ${r.url}  ${r.accessMode}  ${r.credential ?? "logged out"}`,
            )
            .join("\n")
        : "No connections. Run 'cab auth login'.",
    };
  }
  if (key === "connection use" || key === "connection remove") {
    expectArgs(positionals, 3);
    const current = await config.read();
    const name = argument ?? "";
    const connection = current.connections[name];
    if (!connection)
      throw new CliError("connection-not-found", `Unknown connection ${name}`);
    if (action === "use") current.default = name;
    else {
      if (
        connection.credential?.kind === "keychain" &&
        deps.platform === "darwin"
      )
        await deps.keychain().delete(connection.credential.account);
      delete current.connections[name];
      if (current.default === name) delete current.default;
    }
    await config.write(current);
    return {
      connection: name,
      data: {
        connection: name,
        [action === "use" ? "default" : "removed"]: true,
      },
      human:
        action === "use"
          ? `Default connection is now ${name}.`
          : `Removed connection ${name}. Its server credential stays active until revoked or expired.`,
    };
  }
  if (key === "task get") {
    expectArgs(positionals, 3);
    rejectManaged(deps.env);
    const taskId = uuidArg(argument ?? "", "TASK_ID");
    const session = await connect(config, requested, deps, TASK_CAPABILITIES);
    const read = await session.client.get(
      `/api/operator/tasks/${encodeURIComponent(taskId)}`,
      taskSchema,
    );
    const { task } = read.data;
    const readiness = unmetReason(read.data.source?.readiness);
    const column = taskColumnOf(read.data);
    const held = taskHeldLabels(read.data);
    const next = nextText(read.data.attention.codes, column);
    const { lead, leadAssignmentId } = read.data;
    return {
      ...session.result,
      data: read.data,
      coverage: coverage(
        read.observedAt,
        read.data.contentUnavailable ? ["content-unavailable"] : [],
      ),
      human: [
        `${task.title ?? "(untitled)"}`,
        `Task:    ${task.id}`,
        `Project: ${task.projectId}`,
        `State:   ${column}${closureSuffix(read.data.source?.closure)}`,
        `Version: ${task.version}`,
        ...(lead
          ? [
              `Lead:    ${unavailable(lead.name)}${leadAssignmentId ? ` (assignment ${leadAssignmentId})` : ""}`,
            ]
          : []),
        `Execution: ${read.data.execution.state}${held.length ? `; held: ${held.join(", ")}` : ""}`,
        `Next:    ${next.text}${next.operator ? ` (cab inbox list --project ${task.projectId})` : ""}`,
        ...(readiness ? [`Readiness: ${readiness}`] : []),
        ...waitLines(read.data.waits, task.id),
        ...read.data.unresolvedResults.map((r) =>
          r.availability === "available"
            ? `Undelivered result ${r.resultId}: cab result deliver ${task.id} ${r.resultId}`
            : `Undelivered result ${r.resultId}: no lead or requester can receive it now`,
        ),
        ...(task.outcome ? ["", task.outcome] : []),
      ].join("\n"),
    };
  }
  const write = writeCommands.get(key);
  if (write) {
    expectArgs(positionals, 2 + write.positionals);
    rejectManaged(deps.env);
    let session: Awaited<ReturnType<typeof connect>> | undefined;
    const output = await write.run({
      positionals,
      values,
      deps,
      journal: new RequestJournal(config.directory, deps.now),
      connect: async (capabilities) =>
        (session = await connect(config, requested, deps, capabilities)),
    });
    return { ...session?.result, ...output };
  }
  const command = browseCommands.get(key);
  if (!command) throw new CliError("usage", "Unknown command.");
  expectArgs(positionals, (singleWord ? 1 : 2) + command.positionals);
  rejectManaged(deps.env);
  let session: Awaited<ReturnType<typeof connect>> | undefined;
  const output = await command.run({
    positionals,
    values,
    deps,
    connect: async () => {
      session = await connect(config, requested, deps, command.capabilities);
      return session.client;
    },
  });
  return { ...session?.result, ...output };
}

/** The upgrade's readiness reads through the operator's own CLI connection. */
export function operatorConnection(
  deps: CliDeps,
  name: string | undefined,
): OperatorConnection {
  const config = new ConnectionConfig(configDirectory(deps.env));
  const requested = name ?? deps.env.CAB_CONNECTION;
  return {
    async origin() {
      rejectManaged(deps.env);
      const { name, connection } = await selectConnection(
        config,
        await config.read(),
        requested,
        deps,
      );
      await loadToken(name, connection, deps);
      return connection.url;
    },
    async readiness(signal) {
      // Every request of this read, identity included, aborts with the lifecycle wait.
      const bound: CliDeps = {
        ...deps,
        fetch: (input, init) =>
          deps.fetch(input, {
            ...init,
            signal,
          }),
      };
      const session = await connect(config, requested, bound, [
        "cli.identity",
        "diagnostics.read",
      ]);
      const read = await session.client.get(
        "/api/operator/readiness",
        readinessSchema,
      );
      return read.data.checks;
    },
  };
}

async function localMaterial(state: string, deps: CliDeps) {
  rejectManaged(deps.env);
  try {
    return await readLocalAccess(state, deps.uid);
  } catch (error) {
    if (error instanceof LocalAccessError)
      throw new CliError("local-access-unavailable", error.message);
    throw error;
  }
}

async function selectConnection(
  config: ConnectionConfig,
  current: CliConfig,
  requested: string | undefined,
  deps: CliDeps,
) {
  rejectManaged(deps.env);
  const fallback =
    requested === undefined &&
    current.default === undefined &&
    Object.keys(current.connections).length === 0;
  if (deps.forceLocal || fallback) {
    const state = resolve(
      deps.localState ?? deps.env.CAB_LOCAL_STATE ?? defaultLocalState(),
    );
    const material = await localMaterial(state, deps);
    return {
      name: "local",
      connection: {
        url: material.origin,
        installationId: material.installationId,
        credential: { kind: "local" as const, state },
      },
    };
  }
  const selected = config.select(current, requested);
  if (selected.connection.credential?.kind === "local") {
    const material = await localMaterial(
      selected.connection.credential.state,
      deps,
    );
    if (material.installationId !== selected.connection.installationId)
      throw new CliError(
        "service-identity-changed",
        "Local state belongs to a different installation. The saved connection has not been changed.",
      );
    return {
      ...selected,
      connection: { ...selected.connection, url: material.origin },
    };
  }
  return selected;
}

async function connect(
  config: ConnectionConfig,
  requested: string | undefined,
  deps: CliDeps,
  capabilities: readonly string[],
) {
  rejectManaged(deps.env);
  const { name, connection } = await selectConnection(
    config,
    await config.read(),
    requested,
    deps,
  );
  const token = await loadToken(name, connection, deps);
  const accessMode =
    connection.credential?.kind === "local" ? "local" : "token";
  const client = new ServiceClient(
    connectionOrigin(connection.url),
    token,
    deps.fetch,
    deps.signal,
  );
  let identity: CliIdentity;
  try {
    identity = await client.identity(capabilities);
  } catch (error) {
    if (
      accessMode === "local" &&
      error instanceof CliError &&
      error.code === "credential-invalid"
    )
      throw new CliError(
        "local-access-unavailable",
        "The service refused stale or wrong-installation local material. Restart the intended service and check --local-state DATA_DIR.",
      );
    if (
      accessMode === "local" &&
      error instanceof CliError &&
      error.code === "unavailable"
    )
      throw new CliError(
        error.code,
        "The selected local service is unavailable or its material is stale.",
        {
          ...error.extra,
          fix: "Restart the intended service and check --local --local-state DATA_DIR; no other connection was tried.",
        },
      );
    throw error;
  }
  if (identity.service.installationId !== connection.installationId)
    throw new CliError(
      "service-identity-changed",
      accessMode === "local"
        ? `The service at ${connection.url} does not match the selected local installation. Check --local-state DATA_DIR.`
        : `The service at ${connection.url} is a different installation than when ${name} logged in. Run 'cab auth login' again if this is expected.`,
      {
        fix:
          accessMode === "local"
            ? "Check the selected data directory and restart the intended service. Adopt another installation under a new connection name with cab connection local NAME --local-state DATA_DIR."
            : `If the reinstall is expected, run 'cab auth login --connection ${name} --url ${connection.url}'; otherwise check the URL with 'cab connection list'.`,
      },
    );
  return {
    name,
    accessMode,
    url: connection.url,
    client,
    identity,
    result: {
      connection: name,
      service: {
        installationId: identity.service.installationId,
        origin: identity.service.origin,
        apiVersion: identity.apiVersion,
        url: connection.url,
        accessMode,
      },
    },
  };
}

async function loadToken(name: string, connection: Connection, deps: CliDeps) {
  rejectManaged(deps.env);
  const credential = connection.credential;
  if (credential?.kind === "local") {
    const material = await localMaterial(credential.state, deps);
    if (material.installationId !== connection.installationId)
      throw new CliError(
        "service-identity-changed",
        "Local material belongs to a different installation. Check --local-state; adopt a new connection deliberately.",
      );
    if (material.origin !== connection.url)
      throw new CliError(
        "local-access-unavailable",
        "The local endpoint changed during resolution. Retry against the restarted service.",
      );
    localOrigin(connection.url);
    return material.secret;
  }
  if (!credential)
    throw new CliError(
      "credential-not-found",
      "This connection is logged out. Run 'cab auth login'.",
      {
        fix: `Run 'cab auth login --connection ${name} --url ${connection.url}' to store a credential.`,
      },
    );
  if (credential.kind === "token-file")
    return readTokenFile(credential.path).catch((error: unknown) => {
      if (error instanceof CliError && error.code === "invalid-token-file")
        throw new CliError(error.code, error.message, {
          ...error.extra,
          fix: `${error.extra.fix ?? ""} Or log in again: 'cab auth login --connection ${name} --url ${connection.url} --token-file PATH'.`.trim(),
        });
      throw error;
    });
  if (deps.platform !== "darwin")
    throw new CliError(
      "credential-store-unavailable",
      "The macOS Keychain is unavailable; use --token-file.",
    );
  return deps.keychain().get(credential.account, deps.signal);
}

/** Validates the token against the service, then stores it and records the connection. */
export async function saveLogin(
  config: ConnectionConfig,
  deps: CliDeps,
  name: string,
  origin: string,
  token: string,
  tokenFile: string | undefined,
  signal?: AbortSignal,
) {
  // Validate before storing anything.
  const identity = await new ServiceClient(
    origin,
    token,
    deps.fetch,
    // The `signal` parameter below is the storage bound for Keychain calls, not for this check.
    deps.signal,
  ).identity(["cli.identity"]);
  const current: CliConfig = await config.read();
  const keychain = deps.keychain();
  const priorKeychain =
    current.connections[name]?.credential?.kind === "keychain";
  // A failure from here on must leave the prior connection's Keychain token in place. Only
  // "not found" means there is none; any other read failure stops before anything is replaced.
  let prior: string | undefined;
  if (!tokenFile && priorKeychain)
    try {
      prior = await keychain.get(name, signal);
    } catch (error) {
      if (!(error instanceof CliError && error.code === "credential-not-found"))
        throw error;
    }
  current.connections[name] = {
    url: origin,
    installationId: identity.service.installationId,
    credential: tokenFile
      ? { kind: "token-file", path: tokenFile }
      : { kind: "keychain", account: name },
  };
  try {
    if (!tokenFile) await keychain.set(name, token, signal);
    await config.write(current);
  } catch (error) {
    if (!tokenFile) {
      // The restore must finish even after an interrupt, so it has its own bound.
      const bound = AbortSignal.timeout(KEYCHAIN_CLEANUP_MS);
      await (prior === undefined
        ? keychain.delete(name, bound)
        : keychain.set(name, prior, bound)
      ).catch(() =>
        deps.stderr.write(
          `The previous ${name} login could not be restored in the Keychain; run 'cab auth login --connection ${name} --url ${origin}' again.\n`,
        ),
      );
    }
    throw error;
  }
  // Best effort, and it stops with the storage signal: the new login is already in place.
  if (tokenFile && priorKeychain)
    await keychain.delete(name, signal).catch(() => undefined);
  return identity;
}

/** The CLI half of `service install`: password prompt, login and doctor. */
export function installCli(deps: CliDeps): InstallCli {
  return {
    interactive: Boolean(deps.stdin.isTTY && deps.stderr.isTTY),
    readPassword: (prompt, signal) =>
      readHiddenPassword(deps.stdin, deps.stderr, prompt, signal),
    login: async (name, origin, token, tokenFile, signal) => {
      rejectManaged(deps.env);
      // The identity check stops with the install's timeout or interrupt.
      const cancellable: CliDeps = {
        ...deps,
        fetch: (input, init) => deps.fetch(input, { ...init, signal }),
      };
      if (tokenFile)
        writeFileSync(tokenFile, `${token}\n`, { flag: "wx", mode: 0o600 });
      try {
        await saveLogin(
          new ConnectionConfig(configDirectory(deps.env)),
          cancellable,
          name,
          origin,
          token,
          tokenFile,
          signal,
        );
      } catch (error) {
        // The token is revoked on failure; do not leave a dead one on disk.
        if (tokenFile) rmSync(tokenFile, { force: true });
        throw error;
      }
    },
    doctor: async (name, signal) => {
      await main(["doctor", "--connection", name], {
        ...deps,
        stdout: deps.stderr,
        signal,
        fetch: (input, init) => deps.fetch(input, { ...init, signal }),
      });
    },
  };
}

async function login(
  config: ConnectionConfig,
  values: Values,
  deps: CliDeps,
): Promise<Result> {
  const requested = values.connection ?? deps.env.CAB_CONNECTION;
  const nameResult = connectionNameSchema.safeParse(
    requested ?? DEFAULT_CONNECTION,
  );
  if (!nameResult.success)
    throw new CliError(
      "usage",
      `${values.connection === undefined ? "CAB_CONNECTION" : "--connection"} must be a connection name: letters, digits, . _ - starting with a letter or digit.`,
    );
  if (!values.url) throw new CliError("usage", tokenSource(DEFAULT_ORIGIN));
  const name = nameResult.data;
  const origin = connectionOrigin(values.url);
  // A name nobody chose must not quietly re-point a connection that exists, add a second
  // connection for a service that already has one, or leave several connections with no
  // default (every later command would then fail `connection-ambiguous`). It never
  // changes the default itself.
  if (requested === undefined) {
    const { connections, default: chosen } = await config.read();
    const existing = connections[name];
    const same = Object.keys(connections)
      .filter((other) => connections[other]?.url === origin)
      .sort();
    // Another connection already has this origin: replace it, or add a second on purpose.
    const sameFix = `Run ${same.map((other) => `'cab auth login --url ${origin} --connection ${other}'`).join(" or ")} to replace the token, or pass --connection OTHER to add a second connection (then run 'cab connection use NAME' to pick the default).`;
    if (existing && existing.url !== origin)
      throw new CliError(
        "usage",
        `Connection ${name} already points at ${existing.url}.`,
        {
          fix: same.length
            ? `${same.join(", ")} already ${same.length === 1 ? "has" : "have"} ${origin}. ${sameFix}`
            : `Pass --connection NAME to log in to ${origin}, or --connection ${name} to replace it.`,
        },
      );
    if (!existing && same.length)
      throw new CliError(
        "usage",
        `${same.length === 1 ? "Connection" : "Connections"} ${same.join(", ")} already ${same.length === 1 ? "points" : "point"} at ${origin}.`,
        { fix: sameFix },
      );
    const saved = Object.keys(connections).sort();
    if (!existing && saved.length && !(chosen && connections[chosen]))
      throw new CliError(
        "usage",
        `${saved.length === 1 ? "Connection" : "Connections"} ${saved.join(", ")} ${saved.length === 1 ? "is" : "are"} saved and no default connection is set, so adding ${name} would make every command ask for --connection.`,
        {
          fix: `Choose a default with 'cab connection use NAME' (${saved.join(", ")}) and run this again, or pass --connection NAME to add ${origin}, then choose a default with 'cab connection use NAME'.`,
        },
      );
  }
  const tokenFile = values["token-file"] && resolve(values["token-file"]);
  if (!tokenFile && deps.platform !== "darwin")
    throw new CliError(
      "credential-store-unavailable",
      "The macOS Keychain is unavailable on this system; use --token-file PATH.",
    );
  let token: string;
  if (tokenFile) token = await readTokenFile(tokenFile);
  else if (deps.stdin.isTTY && deps.stderr.isTTY) {
    deps.stderr.write(`${tokenSource(origin)}\n`);
    token = (
      await readHiddenPassword(deps.stdin, deps.stderr, "cab CLI token: ")
    ).trim();
  } else
    throw new CliError(
      "usage",
      "Enter the token in an interactive terminal, or pass --token-file PATH.",
    );
  if (!operatorCredentialTokenSchema.safeParse(token).success)
    throw new CliError("invalid-input", "That is not a cab CLI token.");
  const identity = await saveLogin(
    config,
    deps,
    name,
    origin,
    token,
    tokenFile,
  );
  return {
    connection: name,
    service: {
      installationId: identity.service.installationId,
      origin: identity.service.origin,
      apiVersion: identity.apiVersion,
      accessMode: "token",
      url: origin,
    },
    data: { ...identity, accessMode: "token" },
    human: `Logged in to ${name} (${origin}) as ${identity.credential.name} (${identity.credential.scope}); expires ${new Date(identity.credential.expiresAt ?? 0).toISOString()}.\n${nextLine(await doctorCommandFor(config, name, deps))}`,
  };
}

/** The doctor command that reaches `name`: bare when that is what a bare command selects. */
async function doctorCommandFor(
  config: ConnectionConfig,
  name: string,
  deps: CliDeps,
) {
  try {
    const { name: selected } = config.select(
      await config.read(),
      deps.env.CAB_CONNECTION,
    );
    if (selected === name) return "cab doctor";
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
  }
  return `cab doctor --connection ${shellWord(name)}`;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const interrupt = new AbortController();
  process.once("SIGINT", () => interrupt.abort());
  process.exitCode = await main(process.argv.slice(2), {
    ...defaultDeps(),
    signal: interrupt.signal,
  });
}
