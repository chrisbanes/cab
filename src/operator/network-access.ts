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

async function readSafe(path: string): Promise<string | undefined> {
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
    const text = bytes.subarray(0, length).toString("utf8");
    await checkPrivateDirectory(dir, uid);
    const after = await lstat(path);
    const dirAfter = await lstat(dir);
    if (
      Buffer.byteLength(text) > 4096 ||
      !safeFile(after, uid) ||
      after.ino !== stat.ino ||
      after.dev !== stat.dev ||
      dirBefore.ino !== dirAfter.ino ||
      dirBefore.dev !== dirAfter.dev ||
      (await realpath(dir)) !== canonical
    )
      throw new Error("Unsafe operator network settings");
    return text;
  } finally {
    await file.close();
  }
}

export async function readNetworkSettings(
  dataDir: string,
  port: number,
): Promise<OperatorNetworkSettings> {
  const text = await readSafe(networkSettingsPath(dataDir));
  return text === undefined
    ? { schema: "cab.operator-network/v1", lan: null }
    : validateNetworkSettings(JSON.parse(text), port);
}

export async function writeNetworkSettings(
  dataDir: string,
  port: number,
  value: unknown,
): Promise<OperatorNetworkSettings> {
  const settings = validateNetworkSettings(value, port);
  const path = networkSettingsPath(dataDir);
  const dir = dirname(path);
  await checkPrivateDirectory(dir, process.getuid?.());
  const initialDirectory = await lstat(dir);
  const initialFile = await existing(path);
  const prior = await readSafe(path);
  if (prior !== undefined && settings.lan !== null)
    validateNetworkSettings(JSON.parse(prior), port);
  const temporary = join(
    dir,
    `.${basename(path)}.${randomBytes(16).toString("hex")}.tmp`,
  );
  let renamed = false;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(`${JSON.stringify(settings)}\n`);
    await file.sync();
    await file.close();
    await checkPrivateDirectory(dir, process.getuid?.());
    await readSafe(path);
    const currentDirectory = await lstat(dir);
    const currentFile = await existing(path);
    if (
      currentDirectory.ino !== initialDirectory.ino ||
      currentDirectory.dev !== initialDirectory.dev ||
      currentFile?.ino !== initialFile?.ino ||
      currentFile?.dev !== initialFile?.dev
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
    const result = await readNetworkSettings(dataDir, port);
    if (JSON.stringify(result) !== JSON.stringify(settings))
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
