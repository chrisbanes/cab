import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { z } from "zod";

const recordSchema = z
  .object({
    schema: z.literal("cab.local-access/v1"),
    installationId: z.uuid(),
    secret: z.string().regex(/^cab_local_[a-f0-9]{64}$/),
    createdAt: z.number().int().nonnegative(),
    origin: z.string().nullable(),
  })
  .strict();
export type LocalAccessRecord = z.infer<typeof recordSchema>;

export class LocalAccessError extends Error {
  constructor(reason: string) {
    super(
      `Local access unavailable: ${reason}. Start the intended service, check its private state permissions, and select its data directory with --local --local-state DATA_DIR.`,
    );
  }
}

export const defaultLocalState = () =>
  join(homedir(), "Library", "Application Support", "cab", "data");
export const localAccessDirectory = (dataDir: string) =>
  `${resolve(dataDir)}.local-access`;

/** Numeric IPv4 loopback only: no DNS, configured remote origin or URL decorations. */
export function localOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.origin === value &&
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port &&
      !url.username &&
      !url.password
    )
      return value;
  } catch {
    /* uniform safe error */
  }
  throw new LocalAccessError("the endpoint is not a canonical loopback origin");
}

/** Reject substituted parents as well as the final file. macOS temporary aliases are OS-owned. */
async function checkPath(path: string, uid: number | undefined): Promise<void> {
  if (uid === undefined || !isAbsolute(path) || resolve(path) !== path)
    throw new LocalAccessError(
      "use an absolute canonical state path on a supported OS",
    );
  let current = parse(path).root;
  for (const part of path.slice(current.length).split("/")) {
    current = join(current, part);
    const stat = await lstat(current);
    if (
      stat.isSymbolicLink() &&
      !(process.platform === "darwin" && ["/var", "/tmp"].includes(current))
    )
      throw new LocalAccessError("a state path component is a symlink");
    if (stat.uid !== 0 && stat.uid !== uid)
      throw new LocalAccessError("a state parent is owned by another account");
    if (
      stat.isDirectory() &&
      stat.mode & 0o022 &&
      !(stat.uid === 0 && stat.mode & 0o1000)
    )
      throw new LocalAccessError(
        "a state parent is writable by another account",
      );
  }
  const directory = await lstat(path);
  if (
    !directory.isDirectory() ||
    directory.uid !== uid ||
    directory.mode & 0o077
  )
    throw new LocalAccessError(
      "the local access directory must be owned by this account with mode 0700",
    );
}

async function readLocalRecord(
  dataDir: string,
  uid = process.getuid?.(),
): Promise<LocalAccessRecord> {
  const directory = localAccessDirectory(dataDir);
  try {
    await checkPath(directory, uid);
    const canonical = await realpath(directory);
    const directoryBefore = await lstat(directory);
    const file = join(directory, "connection.json");
    const before = await lstat(file);
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let text: string;
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.uid !== uid ||
        stat.mode & 0o077 ||
        stat.nlink !== 1 ||
        stat.size > 4096 ||
        stat.ino !== before.ino ||
        stat.dev !== before.dev
      )
        throw new LocalAccessError(
          "local material must be a small owner-only regular file",
        );
      text = await handle.readFile("utf8");
      if ((await realpath(directory)) !== canonical)
        throw new LocalAccessError("the state path changed while reading");
      await checkPath(directory, uid);
      const directoryAfter = await lstat(directory);
      const after = await lstat(file);
      if (
        directoryAfter.ino !== directoryBefore.ino ||
        directoryAfter.dev !== directoryBefore.dev ||
        after.ino !== stat.ino ||
        after.dev !== stat.dev ||
        after.isSymbolicLink() ||
        Buffer.byteLength(text) > 4096
      )
        throw new LocalAccessError("the local path changed while reading");
    } finally {
      await handle.close();
    }
    return recordSchema.parse(JSON.parse(text));
  } catch (error) {
    if (error instanceof LocalAccessError) throw error;
    throw new LocalAccessError(
      "local material is missing, malformed or unsafe",
    );
  }
}

export async function readLocalAccess(
  dataDir: string,
  uid = process.getuid?.(),
): Promise<LocalAccessRecord & { origin: string }> {
  const record = await readLocalRecord(dataDir, uid);
  if (record.origin === null)
    throw new LocalAccessError(
      "the service has not published a live HTTP endpoint",
    );
  return { ...record, origin: localOrigin(record.origin) };
}

/** Service-owned generation capability. Restart rotates the secret; connections bind the stable installation. */
export class LocalAccess {
  private constructor(
    readonly directory: string,
    private readonly record: LocalAccessRecord,
  ) {}
  static async create(
    dataDir: string,
    installationId: string,
  ): Promise<LocalAccess> {
    const directory = localAccessDirectory(dataDir);
    await mkdir(directory, { mode: 0o700 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    await checkPath(directory, process.getuid?.());
    const existing = await lstat(join(directory, "connection.json")).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      },
    );
    if (existing) {
      const prior = await readLocalRecord(dataDir);
      if (prior.installationId !== installationId)
        throw new LocalAccessError(
          "the retained local material belongs to another installation; preserve it and select the intended data directory before restarting",
        );
    }
    const access = new LocalAccess(directory, {
      schema: "cab.local-access/v1",
      installationId: z.uuid().parse(installationId),
      secret: `cab_local_${randomBytes(32).toString("hex")}`,
      createdAt: Date.now(),
      origin: null,
    });
    await access.write();
    return access;
  }
  exclusions(): string[] {
    return [this.directory, this.record.secret];
  }
  async publish(origin: string): Promise<void> {
    this.record.origin = localOrigin(origin);
    await this.write();
  }
  verify(secret: string): boolean {
    const digest = (s: string) => createHash("sha256").update(s).digest();
    return (
      this.record.origin !== null &&
      timingSafeEqual(digest(secret), digest(this.record.secret))
    );
  }
  credential() {
    return {
      id: this.record.installationId,
      name: "Local OS account",
      scope: "read-write" as const,
      createdAt: this.record.createdAt,
      expiresAt: null,
    };
  }
  private async write(): Promise<void> {
    await checkPath(this.directory, process.getuid?.());
    const target = join(this.directory, "connection.json");
    try {
      const before = await lstat(target);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.uid !== process.getuid?.() ||
        before.mode & 0o077 ||
        before.nlink !== 1
      )
        throw new LocalAccessError(
          "existing local material is unsafe; restore an owner-only regular file before restarting",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = join(
      this.directory,
      `.${randomBytes(16).toString("hex")}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(this.record)}\n`);
      await handle.sync();
      await handle.close();
      await rename(temporary, join(this.directory, "connection.json"));
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
}
