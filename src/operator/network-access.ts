import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { checkPrivateDirectory } from "./local-access.js";

const schema = z
  .object({
    schema: z.literal("cab.operator-network/v1"),
    lan: z
      .object({ address: z.string(), origin: z.string().optional() })
      .strict()
      .nullable(),
  })
  .strict();
export type OperatorNetworkSettings = z.infer<typeof schema>;
export const networkSettingsPath = (dataDir: string) =>
  `${resolve(dataDir)}.operator-network.json`;

export function validateNetworkSettings(
  value: unknown,
  port: number,
): OperatorNetworkSettings {
  const settings = schema.parse(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid operator network port");
  if (settings.lan) {
    if (port === 80)
      throw new Error(
        "LAN access does not support port 80; use another service port",
      );
    const { address, origin } = settings.lan;
    const parts = address.split(".").map(Number);
    if (
      isIP(address) !== 4 ||
      parts[0] === 0 ||
      parts[0] === 127 ||
      (parts[0] ?? 256) >= 224 ||
      address === "255.255.255.255"
    )
      throw new Error("Invalid operator network address");
    if (origin !== undefined) {
      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        throw new Error("Invalid operator network origin");
      }
      if (
        url.origin !== origin ||
        url.protocol !== "http:" ||
        url.username ||
        url.password ||
        !port ||
        Number(url.port || 80) !== port ||
        url.hostname.startsWith("[") ||
        (isIP(url.hostname) !== 0 && url.hostname !== address) ||
        (isIP(url.hostname) === 0 &&
          !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
            url.hostname.replace(/\.$/, ""),
          ))
      )
        throw new Error("Invalid operator network origin");
    }
  }
  return settings;
}

async function existing(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function safeFile(stat: Stats, uid: number | undefined) {
  return (
    uid !== undefined &&
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.uid === uid &&
    !(stat.mode & 0o077) &&
    stat.nlink === 1 &&
    stat.size <= 4096
  );
}

type SafeFile = { bytes: Buffer; stat: Stats };

async function readSafe(path: string): Promise<SafeFile | undefined> {
  const before = await existing(path);
  if (!before) return undefined;
  const uid = process.getuid?.();
  const dir = dirname(path);
  await checkPrivateDirectory(dir, uid);
  const dirBefore = await lstat(dir);
  const canonical = await realpath(dir);
  if (!safeFile(before, uid))
    throw new Error("Unsafe operator network settings");
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (
      !safeFile(stat, uid) ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev
    )
      throw new Error("Unsafe operator network settings");
    const bytes = Buffer.alloc(4097);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > 4096) throw new Error("Unsafe operator network settings");
    const contents = Buffer.from(bytes.subarray(0, length));
    await checkPrivateDirectory(dir, uid);
    const after = await lstat(path);
    const dirAfter = await lstat(dir);
    if (
      contents.length > 4096 ||
      !safeFile(after, uid) ||
      after.ino !== stat.ino ||
      after.dev !== stat.dev ||
      dirBefore.ino !== dirAfter.ino ||
      dirBefore.dev !== dirAfter.dev ||
      (await realpath(dir)) !== canonical
    )
      throw new Error("Unsafe operator network settings");
    return { bytes: contents, stat };
  } finally {
    await file.close();
  }
}

export async function readNetworkSettings(
  dataDir: string,
  port: number,
): Promise<OperatorNetworkSettings> {
  const file = await readSafe(networkSettingsPath(dataDir));
  return file === undefined
    ? { schema: "cab.operator-network/v1", lan: null }
    : validateNetworkSettings(JSON.parse(file.bytes.toString("utf8")), port);
}

function sameFile(
  left: SafeFile | undefined,
  right: SafeFile | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined &&
        left.stat.ino === right.stat.ino &&
        left.stat.dev === right.stat.dev &&
        left.bytes.equals(right.bytes);
}

async function replaceSettings(
  path: string,
  bytes: Buffer,
  prior: SafeFile | undefined,
): Promise<SafeFile> {
  const dir = dirname(path);
  await checkPrivateDirectory(dir, process.getuid?.());
  const initialDirectory = await lstat(dir);
  const temporary = join(
    dir,
    `.${basename(path)}.${randomBytes(16).toString("hex")}.tmp`,
  );
  let renamed = false;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(bytes);
    await file.sync();
    const written = await file.stat();
    await file.close();
    await checkPrivateDirectory(dir, process.getuid?.());
    const current = await readSafe(path);
    const currentDirectory = await lstat(dir);
    if (
      currentDirectory.ino !== initialDirectory.ino ||
      currentDirectory.dev !== initialDirectory.dev ||
      !sameFile(current, prior)
    )
      throw new Error("Operator network settings path changed");
    await rename(temporary, path);
    renamed = true;
    const directory = await open(dir, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    const result = await readSafe(path);
    if (
      !result ||
      result.stat.dev !== written.dev ||
      result.stat.ino !== written.ino ||
      !result.bytes.equals(bytes)
    )
      throw new Error("Readback mismatch");
    return result;
  } catch (error) {
    if (renamed)
      throw new Error(
        "Operator network settings persistence is uncertain; inspect saved settings before retrying",
        { cause: error },
      );
    throw error;
  } finally {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export async function writeNetworkSettings(
  dataDir: string,
  port: number,
  value: unknown,
): Promise<OperatorNetworkSettings> {
  const settings = validateNetworkSettings(value, port);
  const path = networkSettingsPath(dataDir);
  await checkPrivateDirectory(dirname(path), process.getuid?.());
  const prior = await readSafe(path);
  if (prior && settings.lan !== null)
    validateNetworkSettings(JSON.parse(prior.bytes.toString("utf8")), port);
  await replaceSettings(
    path,
    Buffer.from(`${JSON.stringify(settings)}\n`),
    prior,
  );
  return settings;
}

/** Retains exactly what this install replaced; rollback refuses a changed path or contents. */
export async function updateNetworkSettingsForInstall(
  dataDir: string,
  port: number,
  value: unknown,
): Promise<() => Promise<void>> {
  const settings = validateNetworkSettings(value, port);
  const path = networkSettingsPath(dataDir);
  const dir = dirname(path);
  await checkPrivateDirectory(dir, process.getuid?.());
  const prior = await readSafe(path);
  if (prior && settings.lan !== null)
    validateNetworkSettings(JSON.parse(prior.bytes.toString("utf8")), port);
  const written = await replaceSettings(
    path,
    Buffer.from(`${JSON.stringify(settings)}\n`),
    prior,
  );
  return async () => {
    await checkPrivateDirectory(dir, process.getuid?.());
    if (!sameFile(await readSafe(path), written))
      throw new Error("Operator network settings changed; rollback refused");
    if (prior) {
      await replaceSettings(path, prior.bytes, written);
    } else {
      await unlink(path);
      const directory = await open(dir, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      await checkPrivateDirectory(dir, process.getuid?.());
      if (await existing(path))
        throw new Error(
          "Operator network settings removal could not be verified",
        );
    }
  };
}
