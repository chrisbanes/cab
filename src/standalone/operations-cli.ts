import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createSnapshot,
  restoreSnapshot,
  verifySnapshot,
} from "./operations.js";
import {
  renderLaunchAgent,
  writeLaunchAgent,
  type LaunchAgentConfiguration,
} from "./launchd.js";

const USAGE =
  "Usage: npm run operations -- <backup SOURCE SNAPSHOT | verify SNAPSHOT | restore SNAPSHOT DESTINATION | render-launch-agent LABEL NODE CLI DATA AUTH ORIGIN PORT STDOUT STDERR PLIST [--diagnostic-retention-days N] [--diagnostic-storage-mib N]>\n";

function parsePort(value: string): number {
  if (!/^(?:[1-9]\d{0,4})$/.test(value)) throw new Error("invalid port");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535)
    throw new Error("invalid port");
  return port;
}

function parseDecimal(value: string): number {
  if (!/^\d{1,10}$/.test(value)) throw new Error("invalid number");
  return Number(value);
}

function parseRenderArgs(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      "diagnostic-retention-days": { type: "string" },
      "diagnostic-storage-mib": { type: "string" },
    },
  });
}

type Io = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };

/** Runs one operation and returns its exit code; `ensemble snapshot` shares it. */
export async function runOperations(
  argv: string[],
  io: Io = process,
): Promise<number> {
  try {
    return await operate(argv, io);
  } catch {
    // Causes can contain local paths. The CLI intentionally emits no raw error.
    io.stderr.write('{"ok":false,"error":"operation failed"}\n');
    return 1;
  }
}

async function operate(argv: string[], io: Io): Promise<number> {
  const writeResult = (value: unknown) =>
    io.stdout.write(`${JSON.stringify(value)}\n`);
  const [command, ...args] = argv;
  if (command === "backup" && args.length === 2) {
    writeResult({
      ok: true,
      operation: "backup",
      manifest: await createSnapshot(args[0] as string, args[1] as string),
    });
    return 0;
  }
  if (command === "verify" && args.length === 1) {
    writeResult({
      ok: true,
      operation: "verify",
      manifest: await verifySnapshot(args[0] as string),
    });
    return 0;
  }
  if (command === "restore" && args.length === 2) {
    writeResult({
      ok: true,
      operation: "restore",
      manifest: await restoreSnapshot(args[0] as string, args[1] as string),
    });
    return 0;
  }
  if (command === "render-launch-agent" && args.length >= 10) {
    let parsed: ReturnType<typeof parseRenderArgs>;
    try {
      parsed = parseRenderArgs(args);
    } catch {
      io.stderr.write(USAGE);
      return 2;
    }
    const { values, positionals } = parsed;
    if (positionals.length !== 10) {
      io.stderr.write(USAGE);
      return 2;
    }
    const retention = values["diagnostic-retention-days"];
    const storage = values["diagnostic-storage-mib"];
    const configuration: LaunchAgentConfiguration = {
      label: positionals[0] as string,
      nodePath: positionals[1] as string,
      cliPath: positionals[2] as string,
      dataDirectory: positionals[3] as string,
      authFile: positionals[4] as string,
      origin: positionals[5] as string,
      port: parsePort(positionals[6] as string),
      stdoutPath: positionals[7] as string,
      stderrPath: positionals[8] as string,
      ...(retention === undefined
        ? {}
        : { diagnosticRetentionDays: parseDecimal(retention) }),
      ...(storage === undefined
        ? {}
        : { diagnosticStorageMib: parseDecimal(storage) }),
    };
    const plistPath = positionals[9] as string;
    // Validate before creating the destination. The rendered text is written
    // with exclusive mode by the same renderer used by tests and the CLI.
    renderLaunchAgent(configuration);
    writeLaunchAgent(configuration, plistPath);
    writeResult({
      ok: true,
      operation: "render-launch-agent",
      label: configuration.label,
    });
    return 0;
  }

  io.stderr.write(USAGE);
  return 2;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await runOperations(process.argv.slice(2));
