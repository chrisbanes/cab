import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { constants } from "node:fs";
import { z } from "zod";
import { operatorCredentialTokenSchema } from "../operator/contracts.js";
import type { RequestIdentity } from "./types.js";

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly extra: {
      requestId?: string;
      retryable?: boolean;
      status?: number;
      /** Set on write failures so the envelope carries the receipt identity. */
      request?: RequestIdentity;
    } = {},
  ) {
    super(message);
  }
}

export const connectionNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

const credentialRefSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("keychain"), account: connectionNameSchema })
    .strict(),
  z.object({ kind: z.literal("token-file"), path: z.string().min(1) }).strict(),
]);
export type CredentialRef = z.infer<typeof credentialRefSchema>;
const connectionSchema = z
  .object({
    url: z.string(),
    installationId: z.uuid(),
    credential: credentialRefSchema.optional(),
  })
  .strict();
export type Connection = z.infer<typeof connectionSchema>;
const configSchema = z
  .object({
    default: connectionNameSchema.optional(),
    connections: z.record(connectionNameSchema, connectionSchema),
  })
  .strict();
export type CliConfig = z.infer<typeof configSchema>;

export function configDirectory(env: NodeJS.ProcessEnv): string {
  return env.ENSEMBLE_CLI_CONFIG_DIR || join(homedir(), ".config", "ensemble");
}

/** connections.json holds names, origins and credential references, never tokens. */
export class ConnectionConfig {
  constructor(readonly directory: string) {}

  private get file() {
    return join(this.directory, "connections.json");
  }

  async read(): Promise<CliConfig> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { connections: {} };
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
    const parsed = configSchema.safeParse(value);
    if (!parsed.success)
      throw new CliError("invalid-configuration", `Invalid ${this.file}`);
    return parsed.data;
  }

  async write(config: CliConfig): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = join(this.directory, `.connections.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify(configSchema.parse(config), null, 2)}\n`,
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.file);
  }

  /** --connection, then the default, then the sole connection. */
  select(config: CliConfig, requested: string | undefined) {
    const name =
      requested ??
      config.default ??
      (Object.keys(config.connections).length === 1
        ? Object.keys(config.connections)[0]
        : undefined);
    if (!name) {
      const names = Object.keys(config.connections).sort();
      throw names.length
        ? new CliError(
            "connection-ambiguous",
            `Choose a connection with --connection or 'ensemble connection use': ${names.join(", ")}`,
          )
        : new CliError(
            "connection-not-found",
            "No connection. Run 'ensemble auth login'.",
          );
    }
    const connection = config.connections[name];
    if (!connection)
      throw new CliError("connection-not-found", `Unknown connection ${name}`);
    return { name, connection };
  }
}

export interface CredentialStore {
  set(account: string, token: string): Promise<void>;
  get(account: string): Promise<string>;
  delete(account: string): Promise<void>;
}

export type SecurityRunner = (
  args: string[],
  input?: string,
) => Promise<{ code: number; stdout: string }>;

export const runSecurity: SecurityRunner = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout }));
    child.stdin.end(input ?? "");
  });

const unavailable = () =>
  new CliError(
    "credential-store-unavailable",
    "The macOS Keychain is unavailable.",
  );

/** macOS Keychain generic passwords; the token reaches `security` only on stdin. */
export class KeychainCredentialStore implements CredentialStore {
  constructor(
    private readonly service = "ensemble-cli",
    private readonly run: SecurityRunner = runSecurity,
  ) {}

  async set(account: string, token: string): Promise<void> {
    const name = connectionNameSchema.parse(account);
    operatorCredentialTokenSchema.parse(token);
    // `security -i` reads the command from stdin, keeping the token out of argv.
    const result = await this.run(
      ["-i"],
      `add-generic-password -U -s ${this.service} -a ${name} -w ${token}\n`,
    ).catch(() => {
      throw unavailable();
    });
    if (result.code !== 0) throw unavailable();
    if ((await this.get(name)) !== token) throw unavailable();
  }

  async get(account: string): Promise<string> {
    const result = await this.run([
      "find-generic-password",
      "-s",
      this.service,
      "-a",
      connectionNameSchema.parse(account),
      "-w",
    ]).catch(() => {
      throw unavailable();
    });
    if (result.code === 44)
      throw new CliError(
        "credential-not-found",
        "No stored credential for this connection. Run 'ensemble auth login'.",
      );
    if (result.code !== 0) throw unavailable();
    return result.stdout.replace(/\n$/, "");
  }

  async delete(account: string): Promise<void> {
    const result = await this.run([
      "delete-generic-password",
      "-s",
      this.service,
      "-a",
      connectionNameSchema.parse(account),
    ]).catch(() => {
      throw unavailable();
    });
    if (result.code !== 0 && result.code !== 44) throw unavailable();
  }
}

/** Reads one token from a user-owned regular file with no group/other access. */
export async function readTokenFile(
  path: string,
  uid = process.getuid?.(),
): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // O_NOFOLLOW refuses a symlink; O_NONBLOCK keeps a FIFO from hanging until isFile() rejects it.
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw new CliError(
      "invalid-token-file",
      "Token file must be a readable regular file, not a symlink.",
    );
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new CliError(
        "invalid-token-file",
        "Token file must be a regular file.",
      );
    if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0)
      throw new CliError(
        "invalid-token-file",
        "Token file must be owned by you with mode 0600 or stricter.",
      );
    if (stat.size > 4096)
      throw new CliError("invalid-token-file", "Token file is too large.");
    const token = (await handle.readFile("utf8")).trim();
    if (!operatorCredentialTokenSchema.safeParse(token).success)
      throw new CliError(
        "invalid-token-file",
        "Token file does not hold one Ensemble token.",
      );
    return token;
  } finally {
    await handle.close();
  }
}
