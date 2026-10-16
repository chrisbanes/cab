#!/usr/bin/env node
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readinessSchema } from "../operator/readiness.js";
import {
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
  SERVICE_USAGE,
  serviceCommand,
  snapshotCommand,
} from "./service.js";
import { jsonLine, terminalSafe } from "./render.js";
import { RequestJournal } from "./request-journal.js";
import { closureSuffix, waitLines } from "./task-write.js";
import { unmetReason } from "../operator/readiness-text.js";
import { connectionOrigin, ServiceClient } from "./transport.js";
import type { CliDeps, Result, Values } from "./types.js";
import { rejectUnusedFlags } from "./write.js";

export type { CliDeps } from "./types.js";

const SCHEMA = "ensemble.cli/v1";
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
  "output-exists": [2, "usage"],
  "output-failed": [2, "usage"],
  conflict: [4, "conflict"],
  "policy-denied": [4, "conflict"],
  "change-document-invalid": [2, "usage"],
  "wrong-service": [2, "usage"],
  "journal-unavailable": [5, "unavailable"],
  "cursor-stale": [4, "conflict"],
  unavailable: [5, "unavailable"],
  "integrity-mismatch": [5, "unavailable"],
  "tls-verification-failed": [5, "unavailable"],
  "redirect-rejected": [5, "unavailable"],
  "command-outcome-unknown": [6, "uncertain"],
  "unsupported-service": [7, "unsupported"],
};

const USAGE = `Usage: ensemble <command> [options]

Commands:
  auth login --connection NAME --url ORIGIN [--token-file PATH]
  auth status [--connection NAME]
  auth logout [--connection NAME]
  connection list
  connection use NAME
  connection remove NAME
  task get TASK_ID [--connection NAME]
${[...browseCommands.values(), ...writeCommands.values()].map((c) => `  ${c.usage}`).join("\n")}

${SERVICE_USAGE}
Options:
  --output human|json   Result format (default human)
  --limit N             Page size, 1-200 (default 50; some reads cap lower)
  --cursor TOKEN        Continue from the More: line of the previous page
  --output jsonl        logs only: one ensemble.cli/v1 record per line
  --follow              logs only: poll every --interval S (1-30, default 2)
                        for at most --max-duration S (default 900, max 86400)
  --help                Show this help
  --version             Show the Ensemble version

Task operations: task create, task message, task follow-up, question answer and
approval decide cannot be undone. Reverse pairs: task stop/resume (Stop is
best-effort cancellation of an open task; Resume clears only the operator
Stop),
add-dependency/remove-dependency and task configure --ready true/false.

Runtimes: runtime enable and runtime disable are a reverse pair. Disabling never
cancels a running turn; work bound to that runtime waits until it is enabled again,
and disabling one that bound tasks use needs --yes.

Sources and delivery: delivery send-comment posts a public GitHub comment that
Ensemble cannot edit or retract, and a confirm-comment decision is final (deny
is the counterpart of approve). Removing a source selection discards its saved
definition. preview-source has no deactivate command; saving any source change
deactivates every selection. place-task is final once the task has an
assignment. delivery refresh is installation-wide. send-comment --review-id
first replays that review to check it is approved; an ID that is not an existing
review records a new pending review instead, and nothing is posted.

Recovery: recovery prepare writes an owner-only document from the observed
generation identity plus your --evidence-file; nothing is inferred, defaulted or
confirmed by a flag. recovery submit sends it once. Adoption, recovery and
conversation replacement cannot be undone, and none of them resumes the task or
dispatches work; continue with a new task message after replacement. Adoption
here records evidence and is unrelated to assignment apply-current.

ORIGIN is https://HOST[:PORT], or http://127.0.0.1:PORT for a service on this machine.
`;

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

export async function main(
  argv: string[],
  deps: CliDeps = defaultDeps(),
): Promise<number> {
  // Local commands on the service's own Mac, outside the operator CLI's options.
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
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        connection: { type: "string" },
        url: { type: "string" },
        "token-file": { type: "string" },
        output: { type: "string" },
        help: { type: "boolean" },
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
        "instructions-file": { type: "string" },
        "capabilities-file": { type: "string" },
        "restore-revision": { type: "string" },
        revoked: { type: "string" },
        paused: { type: "string" },
        "lead-profile": { type: "string" },
        "diagnostic-capture": { type: "string" },
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
        "review-id": { type: "string" },
        work: { type: "string" },
        "evidence-file": { type: "string" },
        "expected-conversation-revision": { type: "string" },
      },
    });
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
      deps.stdout.write(`ensemble ${pkg.version}\n`);
      return 0;
    }
    if (values.help || positionals.length === 0) {
      deps.stdout.write(USAGE);
      return values.help ? 0 : 2;
    }
    const result = await run(positionals, values, deps);
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
          ? new CliError("usage", `${raw.message}\n\n${USAGE}`)
          : new CliError("unavailable", "Unexpected CLI failure.");
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
    else
      deps.stderr.write(
        `ensemble: ${terminalSafe(error.message)} (${error.code}${error.extra.requestId ? `, request ${error.extra.requestId}` : ""})\n`,
      );
    return exit;
  }
}

function expectArgs(positionals: string[], count: number) {
  if (positionals.length !== count)
    throw new CliError("usage", `Unexpected arguments.\n\n${USAGE}`);
}

function rejectManaged(env: NodeJS.ProcessEnv) {
  // Prevents accidental privilege crossing only; it is not OS isolation.
  if (env.ENSEMBLE_MANAGED_ASSIGNMENT)
    throw new CliError(
      "managed-assignment",
      "Operator credentials are unavailable inside an Ensemble-managed assignment.",
    );
}

async function run(
  positionals: string[],
  values: Values,
  deps: CliDeps,
): Promise<Result> {
  const config = new ConnectionConfig(configDirectory(deps.env));
  const [area, action, argument] = positionals;
  const requested = values.connection ?? deps.env.ENSEMBLE_CONNECTION;
  // `logs` and `doctor` are the only single-word commands.
  const singleWord = area === "logs" || area === "doctor";
  const key = singleWord ? area : `${area} ${action}`;
  if (key === "auth login") {
    expectArgs(positionals, 2);
    rejectManaged(deps.env);
    return login(config, values, deps);
  }
  if (key === "auth status") {
    expectArgs(positionals, 2);
    rejectManaged(deps.env);
    const session = await connect(config, requested, deps, []);
    const { identity } = session;
    const expires = new Date(identity.credential.expiresAt).toISOString();
    return {
      ...session.result,
      data: identity,
      human: [
        `Connection:   ${session.name}`,
        `Service:      ${identity.service.origin}`,
        `Installation: ${identity.service.installationId}`,
        `Credential:   ${identity.credential.name} (${identity.credential.scope}), expires ${expires}`,
        `API:          version ${identity.apiVersion}; ${identity.capabilities.join(", ")}`,
      ].join("\n"),
    };
  }
  if (key === "auth logout") {
    expectArgs(positionals, 2);
    const current = await config.read();
    const { name, connection } = config.select(current, requested);
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
      data: { connection: name, loggedOut: true },
      human: `Removed the local credential for ${name}. The server credential stays active until it is revoked in Settings or expires.`,
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
        default: current.default === name,
      }));
    return {
      data: { connections: rows },
      human: rows.length
        ? rows
            .map(
              (r) =>
                `${r.default ? "*" : " "} ${r.name}  ${r.url}  ${r.credential ?? "logged out"}`,
            )
            .join("\n")
        : "No connections. Run 'ensemble auth login'.",
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
        `State:   ${task.state}${closureSuffix(read.data.source?.closure)}${task.ready ? " (ready)" : ""}`,
        `Version: ${task.version}`,
        ...(readiness ? [`Readiness: ${readiness}`] : []),
        ...waitLines(read.data.waits, task.id),
        ...(task.outcome ? ["", task.outcome] : []),
      ].join("\n"),
    };
  }
  const write = writeCommands.get(key);
  if (write) {
    expectArgs(positionals, 2 + write.positionals);
    rejectUnusedFlags(values, write.flags);
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
  if (!command) throw new CliError("usage", `Unknown command.\n\n${USAGE}`);
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
function operatorConnection(
  deps: CliDeps,
  name: string | undefined,
): OperatorConnection {
  const config = new ConnectionConfig(configDirectory(deps.env));
  const requested = name ?? deps.env.ENSEMBLE_CONNECTION;
  return {
    async origin() {
      rejectManaged(deps.env);
      const { connection } = config.select(await config.read(), requested);
      await loadToken(connection, deps);
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

async function connect(
  config: ConnectionConfig,
  requested: string | undefined,
  deps: CliDeps,
  capabilities: readonly string[],
) {
  const { name, connection } = config.select(await config.read(), requested);
  const token = await loadToken(connection, deps);
  const client = new ServiceClient(
    connectionOrigin(connection.url),
    token,
    deps.fetch,
  );
  const identity = await client.identity(capabilities);
  if (identity.service.installationId !== connection.installationId)
    throw new CliError(
      "service-identity-changed",
      `The service at ${connection.url} is a different installation than when ${name} logged in. Run 'ensemble auth login' again if this is expected.`,
    );
  return {
    name,
    client,
    identity,
    result: {
      connection: name,
      service: {
        installationId: identity.service.installationId,
        origin: identity.service.origin,
        apiVersion: identity.apiVersion,
      },
    },
  };
}

async function loadToken(connection: Connection, deps: CliDeps) {
  const credential = connection.credential;
  if (!credential)
    throw new CliError(
      "credential-not-found",
      "This connection is logged out. Run 'ensemble auth login'.",
    );
  if (credential.kind === "token-file") return readTokenFile(credential.path);
  if (deps.platform !== "darwin")
    throw new CliError(
      "credential-store-unavailable",
      "The macOS Keychain is unavailable; use --token-file.",
    );
  return deps.keychain().get(credential.account);
}

/** Validates the token against the service, then stores it and records the connection. */
async function saveLogin(
  config: ConnectionConfig,
  deps: CliDeps,
  name: string,
  origin: string,
  token: string,
  tokenFile: string | undefined,
) {
  // Validate before storing anything.
  const identity = await new ServiceClient(origin, token, deps.fetch).identity([
    "cli.identity",
  ]);
  const current: CliConfig = await config.read();
  if (!tokenFile) await deps.keychain().set(name, token);
  else if (current.connections[name]?.credential?.kind === "keychain")
    await deps.keychain().delete(name);
  current.connections[name] = {
    url: origin,
    installationId: identity.service.installationId,
    credential: tokenFile
      ? { kind: "token-file", path: tokenFile }
      : { kind: "keychain", account: name },
  };
  await config.write(current);
  return identity;
}

/** The CLI half of `service install`: password prompt, login and doctor. */
export function installCli(deps: CliDeps): InstallCli {
  return {
    interactive: Boolean(deps.stdin.isTTY && deps.stderr.isTTY),
    readPassword: (prompt) =>
      readHiddenPassword(deps.stdin, deps.stderr, prompt),
    login: async (name, origin, token, tokenFile) => {
      rejectManaged(deps.env);
      if (tokenFile)
        writeFileSync(tokenFile, `${token}\n`, { flag: "wx", mode: 0o600 });
      try {
        await saveLogin(
          new ConnectionConfig(configDirectory(deps.env)),
          deps,
          name,
          origin,
          token,
          tokenFile,
        );
      } catch (error) {
        // The token is revoked on failure; do not leave a dead one on disk.
        if (tokenFile) rmSync(tokenFile, { force: true });
        throw error;
      }
    },
    doctor: async (name) => {
      await main(["doctor", "--connection", name], {
        ...deps,
        stdout: deps.stderr,
      });
    },
  };
}

async function login(
  config: ConnectionConfig,
  values: Values,
  deps: CliDeps,
): Promise<Result> {
  const nameResult = connectionNameSchema.safeParse(values.connection);
  if (!nameResult.success || !values.url)
    throw new CliError(
      "usage",
      "auth login requires --connection NAME (letters, digits, . _ -) and --url ORIGIN.",
    );
  const name = nameResult.data;
  const origin = connectionOrigin(values.url);
  const tokenFile = values["token-file"] && resolve(values["token-file"]);
  if (!tokenFile && deps.platform !== "darwin")
    throw new CliError(
      "credential-store-unavailable",
      "The macOS Keychain is unavailable on this system; use --token-file PATH.",
    );
  let token: string;
  if (tokenFile) token = await readTokenFile(tokenFile);
  else if (deps.stdin.isTTY && deps.stderr.isTTY)
    token = (
      await readHiddenPassword(deps.stdin, deps.stderr, "Ensemble CLI token: ")
    ).trim();
  else
    throw new CliError(
      "usage",
      "Enter the token in an interactive terminal, or pass --token-file PATH.",
    );
  if (!operatorCredentialTokenSchema.safeParse(token).success)
    throw new CliError("invalid-input", "That is not an Ensemble CLI token.");
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
    },
    data: identity,
    human: `Logged in to ${name} (${origin}) as ${identity.credential.name} (${identity.credential.scope}); expires ${new Date(identity.credential.expiresAt).toISOString()}.`,
  };
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
