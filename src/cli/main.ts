#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
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
import { coverage } from "./browse.js";
import { browseCommands } from "./commands.js";
import { connectionOrigin, ServiceClient } from "./transport.js";
import type { CliDeps, Result, Values } from "./types.js";

export type { CliDeps } from "./types.js";

const SCHEMA = "ensemble.cli/v1";
const TASK_CAPABILITIES = ["cli.identity", "task.read"] as const;

const EXIT: Record<string, [number, string]> = {
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
${[...browseCommands.values()].map((c) => `  ${c.usage}`).join("\n")}

Options:
  --output human|json   Result format (default human)
  --limit N             Page size, 1-200 (default 50; some reads cap lower)
  --cursor TOKEN        Continue from the More: line of the previous page
  --help                Show this help

ORIGIN is https://HOST[:PORT], or http://127.0.0.1:PORT for a service on this machine.
`;

export async function main(
  argv: string[],
  deps: CliDeps = {
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    fetch,
    platform: process.platform,
    keychain: () => new KeychainCredentialStore(),
    now: Date.now,
  },
): Promise<number> {
  let json = false;
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
      },
    });
    if (
      values.output !== undefined &&
      !["human", "json"].includes(values.output)
    )
      throw new CliError("usage", "--output must be human or json.");
    json = values.output === "json";
    if (values.help || positionals.length === 0) {
      deps.stdout.write(USAGE);
      return values.help ? 0 : 2;
    }
    const result = await run(positionals, values, deps);
    if (json)
      deps.stdout.write(
        `${JSON.stringify({
          schema: SCHEMA,
          observedAt: deps.now(),
          ...(result.connection ? { connection: result.connection } : {}),
          ...(result.service ? { service: result.service } : {}),
          data: result.data,
          ...(result.pagination ? { pagination: result.pagination } : {}),
          ...(result.coverage ? { coverage: result.coverage } : {}),
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
    if (json)
      deps.stdout.write(
        `${JSON.stringify({
          schema: SCHEMA,
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

/** Service text may hold terminal escape sequences; show only printable text and line breaks. */
function terminalSafe(text: string): string {
  return text.replace(/[^\P{Cc}\n\t]/gu, "\uFFFD");
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
  const key = `${area} ${action}`;
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
    const taskId = argument ?? "";
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        taskId,
      )
    )
      throw new CliError("invalid-input", "TASK_ID must be a task UUID.");
    const session = await connect(config, requested, deps, TASK_CAPABILITIES);
    const read = await session.client.get(
      `/api/operator/tasks/${encodeURIComponent(taskId)}`,
      taskSchema,
    );
    const { task } = read.data;
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
        `State:   ${task.state}${task.ready ? " (ready)" : ""}`,
        `Version: ${task.version}`,
        ...(task.outcome ? ["", task.outcome] : []),
      ].join("\n"),
    };
  }
  const command = browseCommands.get(key);
  if (!command) throw new CliError("usage", `Unknown command.\n\n${USAGE}`);
  expectArgs(positionals, 2 + command.positionals);
  rejectManaged(deps.env);
  let session: Awaited<ReturnType<typeof connect>> | undefined;
  const output = await command.run({
    positionals,
    values,
    connect: async () => {
      session = await connect(config, requested, deps, command.capabilities);
      return session.client;
    },
  });
  return { ...session?.result, ...output };
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
)
  process.exitCode = await main(process.argv.slice(2));
