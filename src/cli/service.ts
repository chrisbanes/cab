import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CliDeps } from "./types.js";

export const SERVICE_USAGE = `Local service commands (run on the service's Mac):
  service init-auth [AUTH_FILE]
  service serve|operator|run|list ABSOLUTE_DATA_DIR [ARGS...]
  snapshot create SOURCE_DATA_DIR SNAPSHOT
  snapshot verify SNAPSHOT
  snapshot restore SNAPSHOT DESTINATION_DATA_DIR
`;

// Service modules load on demand so the operator CLI never loads service state or SQLite.

const STATE_DIR = "Library/Application Support/Ensemble";

function usage(deps: CliDeps): number {
  deps.stderr.write(`Usage:\n${SERVICE_USAGE}`);
  return 2;
}

/** `ensemble service …`: argv starts after `service`. */
export async function serviceCommand(
  argv: string[],
  deps: CliDeps,
): Promise<number> {
  const [command, ...args] = argv;
  if (command === "init-auth") return initAuth(args, deps);
  if (
    command === "serve" ||
    command === "operator" ||
    command === "run" ||
    command === "list"
  ) {
    const standalone = await import("../standalone/cli.js");
    try {
      await standalone.main(argv);
      return Number(process.exitCode ?? 0);
    } catch {
      deps.stderr.write(`ensemble: service ${command} failed\n`);
      return 1;
    }
  }
  return usage(deps);
}

async function initAuth(args: string[], deps: CliDeps): Promise<number> {
  if (args.length > 1) return usage(deps);
  // Checked first so that a non-interactive run creates nothing.
  if (!deps.stdin.isTTY || !(deps.stdout as NodeJS.WriteStream).isTTY) {
    deps.stderr.write(
      "Operator authentication initialization failed: run it in an interactive terminal\n",
    );
    return 1;
  }
  let authFile = args[0];
  if (authFile === undefined) {
    if (!deps.env.HOME) return usage(deps);
    const auth = join(deps.env.HOME, STATE_DIR, "auth");
    mkdirSync(auth, { recursive: true, mode: 0o700 });
    authFile = join(auth, "operator-auth.json");
  }
  const { runOperatorAuth } = await import(
    "../standalone/operator-auth-cli.js"
  );
  return runOperatorAuth(["init", authFile], {
    stdin: deps.stdin,
    stdout: deps.stdout as NodeJS.WriteStream,
    stderr: deps.stderr,
  });
}

/** `ensemble snapshot create|verify|restore`, the offline operations. */
export async function snapshotCommand(
  argv: string[],
  deps: CliDeps,
): Promise<number> {
  const [command, ...args] = argv;
  const arity = { create: 2, verify: 1, restore: 2 }[command ?? ""];
  if (arity === undefined || args.length !== arity) return usage(deps);
  const { runOperations } = await import("../standalone/operations-cli.js");
  return runOperations(
    [command === "create" ? "backup" : (command as string), ...args],
    deps,
  );
}
