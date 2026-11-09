/** Retained only for historical qualification fixtures; production uses native harness configuration. */
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  lstat,
  opendir,
  realpath,
  mkdir,
  mkdtemp,
  rename,
  rm,
  open,
  access,
} from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import {
  type ProfileSkills,
  profileSkillsSchema,
  skillNameSchema,
} from "../../../src/core/execution-runtime.js";
import { resolveInstalledPlugin } from "./installed-plugins.js";
import { realHome } from "./codex-home.js";
import {
  frontmatterName,
  maxPluginFiles,
  maxPluginBytes,
  maxPluginDepth,
  inspectionTimeoutMs,
  SkillPluginError,
  readRegular,
  unchangedFile,
  digestPlugin,
  type LoadedPlugin,
  readPlugin,
} from "./skill-plugins.js";

export const globalSkillPluginName = "cab-global-skills";
export interface GlobalSkillListing {
  status: "available" | "missing" | "unreadable";
  skills: Array<{ name: string; available: boolean }>;
}
interface Candidate {
  name: string;
  source: string;
  directory: string;
  file: string;
  info: Stats | undefined;
  available: boolean;
}
const contained = (root: string, path: string) =>
  path.startsWith(`${root}${sep}`);

async function discover(environment: NodeJS.ProcessEnv, signal: AbortSignal) {
  const root = join(realHome(environment), ".agents", "skills");
  let entries: Awaited<ReturnType<typeof opendir>>;
  try {
    entries = await opendir(root);
  } catch (error) {
    return {
      status:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? ("missing" as const)
          : ("unreadable" as const),
      candidates: [] as Candidate[],
    };
  }
  const candidates: Candidate[] = [];
  let count = 0;
  for await (const entry of entries) {
    signal.throwIfAborted();
    if (++count > maxPluginFiles)
      throw new SkillPluginError("Global skills root is too large");
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const directory = await realpath(join(root, entry.name)).catch(() => "");
    const file = directory
      ? await realpath(join(directory, "SKILL.md")).catch(() => "")
      : "";
    const info =
      file && contained(directory, file)
        ? await lstat(file).catch(() => undefined)
        : undefined;
    const header = info?.isFile()
      ? await frontmatterName(file).then(
          (name) => ({ name, readable: true }),
          () => ({ name: undefined, readable: false }),
        )
      : { name: undefined, readable: false };
    const name =
      header.name ?? (header.readable ? basename(directory) : entry.name);
    if (!skillNameSchema.safeParse(name).success) continue;
    // Category directories are not global skills. Broken/unsafe links remain unavailable.
    if (!file && entry.isDirectory()) continue;
    candidates.push({
      name,
      source: join(root, entry.name),
      directory,
      file,
      info,
      available: header.readable,
    });
  }
  return { status: "available" as const, candidates };
}

async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new SkillPluginError("Global skills took too long to read"));
        }, inspectionTimeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof SkillPluginError) throw error;
    throw new SkillPluginError("Global skills cannot be read");
  } finally {
    clearTimeout(timer);
  }
}

export const listGlobalSkills = (
  environment: NodeJS.ProcessEnv = process.env,
): Promise<GlobalSkillListing> =>
  bounded(async (signal) => {
    const { status, candidates } = await discover(environment, signal);
    const names = [...new Set(candidates.map((c) => c.name))].sort();
    const skills: GlobalSkillListing["skills"] = [];
    for (const name of names) {
      signal.throwIfAborted();
      const matches = candidates.filter((c) => c.name === name);
      let available = matches.length === 1 && matches[0]!.available;
      if (available) {
        try {
          await readSources(matches, signal, false);
        } catch {
          signal.throwIfAborted();
          available = false;
        }
      }
      skills.push({ name, available });
    }
    return { status, skills };
  }).catch(() => ({ status: "unreadable", skills: [] }));

async function resolveSelected(
  skills: ProfileSkills,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  const names = profileSkillsSchema.parse(skills).global ?? [];
  if (!names.length) return [];
  const { status, candidates } = await discover(environment, signal);
  if (status === "unreadable")
    throw new SkillPluginError("Global skills root is unreadable");
  const files = new Set<string>();
  return names.map((name) => {
    const matches = candidates.filter((c) => c.name === name);
    const candidate = matches[0];
    const identity = candidate?.info
      ? `${candidate.info.dev}:${candidate.info.ino}`
      : "";
    if (matches.length !== 1 || !candidate?.available || files.has(identity))
      throw new SkillPluginError(
        `Global skill ${name} is unavailable or ambiguous`,
      );
    files.add(identity);
    return candidate;
  });
}

interface SnapshotFile {
  bytes: Buffer;
  mode: number;
}
interface Snapshot {
  skills: string[];
  files: Map<string, SnapshotFile>;
}
const manifestPath = ".claude-plugin/plugin.json";

/** Reads the selected trees once, retaining a bounded snapshot rather than rereading into a copy. */
async function snapshot(
  skills: ProfileSkills,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<Snapshot> {
  const selected = await resolveSelected(skills, environment, signal);
  if (!selected.length) return { skills: [], files: new Map() };
  for (const plugin of skills.plugins) {
    signal.throwIfAborted();
    const path =
      "path" in plugin
        ? plugin.path
        : await resolveInstalledPlugin(plugin.plugin, environment);
    if ((await readPlugin(path))?.name === globalSkillPluginName)
      throw new SkillPluginError(
        `Global skills reserve plugin name ${globalSkillPluginName}`,
      );
  }
  return readSources(selected, signal, true);
}

/** Metadata-only discovery shares containment/bounds checks without reading resource contents. */
async function readSources(
  selected: Candidate[],
  signal: AbortSignal,
  contents: boolean,
): Promise<Snapshot> {
  const names = selected.map((c) => c.name).sort();
  const files = new Map<string, SnapshotFile>();
  let bytes = 0,
    directories = 0;
  const checks = new Map<string, Stats>();
  const destinations = new Set<string>();
  const executable: string[] = [];
  const remember = (path: string, info: Stats) => {
    const previous = checks.get(path);
    if (previous && !unchangedFile(previous, info))
      throw new SkillPluginError("Global skill changed while it was read");
    checks.set(path, info);
  };
  for (const candidate of selected) {
    const root = candidate.directory;
    remember(candidate.file, candidate.info!);
    const ancestors = new Set<string>();
    const walk = async (
      path: string,
      destination: string,
      depth: number,
    ): Promise<void> => {
      signal.throwIfAborted();
      const key = destination.toLowerCase();
      if (destinations.has(key))
        throw new SkillPluginError(
          "Global skills contain names that collide on case-insensitive filesystems",
        );
      destinations.add(key);
      const linkInfo = await lstat(path);
      remember(path, linkInfo);
      const real = await realpath(path);
      if (real !== root && !contained(root, real))
        throw new SkillPluginError("Global skill contains an escaping link");
      const info = await lstat(real);
      remember(real, info);
      if (info.isDirectory()) {
        if (depth > maxPluginDepth)
          throw new SkillPluginError("Global skills tree is too deep");
        if (++directories > maxPluginFiles)
          throw new SkillPluginError("Global skills tree is too large");
        if (ancestors.has(real))
          throw new SkillPluginError("Global skill contains a cyclic link");
        ancestors.add(real);
        for await (const entry of await opendir(real))
          await walk(
            join(real, entry.name),
            join(destination, entry.name),
            depth + 1,
          );
        ancestors.delete(real);
      } else if (info.isFile()) {
        bytes += info.size;
        if (bytes > maxPluginBytes || files.size + 2 > maxPluginFiles)
          throw new SkillPluginError("Global skills tree is too large");
        const chunks: Buffer[] = [];
        if (contents)
          await readRegular(
            real,
            info.size,
            maxPluginBytes,
            (chunk) => chunks.push(Buffer.from(chunk)),
            info,
          );
        else await access(real, constants.R_OK);
        const mode = 0o600 | (info.mode & 0o111);
        files.set(destination, { bytes: Buffer.concat(chunks), mode });
        if (mode & 0o111) executable.push(`${destination}\0${mode & 0o111}`);
      } else throw new SkillPluginError("Global skill contains a special file");
    };
    await walk(root, join("skills", candidate.name), 0);
    // Discovery and copying must agree on which skill was selected.
    if (
      (await realpath(candidate.source)) !== root ||
      (await realpath(join(root, "SKILL.md"))) !== candidate.file
    )
      throw new SkillPluginError("Global skill changed while it was read");
  }
  // Include mode identity in standard manifest text so content digests capture chmod changes.
  const manifest = Buffer.from(
    JSON.stringify({
      name: globalSkillPluginName,
      version: "1.0.0",
      description: `Selected global skills (${createHash("sha256").update(executable.sort().join("\0")).digest("hex")})`,
    }),
  );
  bytes += manifest.length;
  if (bytes > maxPluginBytes || files.size + 1 > maxPluginFiles)
    throw new SkillPluginError("Global skills tree is too large");
  files.set(manifestPath, { bytes: manifest, mode: 0o600 });
  for (const [path, info] of checks) {
    signal.throwIfAborted();
    if (!unchangedFile(info, await lstat(path)))
      throw new SkillPluginError("Global skill changed while it was read");
  }
  return { skills: names, files };
}

/** Validates current sources without creating cache entries. */
export const inspectGlobalSkills = (
  skills: ProfileSkills,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ skills: string[] }> =>
  bounded(async (signal) => ({
    skills: (await snapshot(skills, environment, signal)).skills,
  }));

const ownedDirectory = async (path: string) => {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    (info.mode & 0o7777) !== 0o700 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new SkillPluginError("Global skill cache is unsafe");
  return info;
};

async function verifyCache(
  path: string,
  expected: Snapshot,
  signal: AbortSignal,
) {
  const seen = new Set<string>();
  const directories = new Set<string>([""]);
  for (const name of expected.files.keys()) {
    let directory = dirname(name);
    while (directory !== ".") {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  const walk = async (directory: string): Promise<void> => {
    signal.throwIfAborted();
    const before = await ownedDirectory(directory);
    for await (const entry of await opendir(directory)) {
      signal.throwIfAborted();
      const full = join(directory, entry.name);
      const name = relative(path, full);
      const info = await lstat(full);
      if (info.isDirectory() && directories.has(name)) await walk(full);
      else {
        const file = expected.files.get(name);
        if (
          !file ||
          !info.isFile() ||
          info.nlink !== 1 ||
          (info.mode & 0o7777) !== file.mode ||
          (process.getuid && info.uid !== process.getuid())
        )
          throw new SkillPluginError("Global skill cache is unsafe");
        const chunks: Buffer[] = [];
        await readRegular(
          full,
          file.bytes.length,
          maxPluginBytes,
          (c) => chunks.push(Buffer.from(c)),
          info,
        );
        if (!Buffer.concat(chunks).equals(file.bytes))
          throw new SkillPluginError("Global skill cache is corrupt");
        seen.add(name);
      }
    }
    if (!unchangedFile(before, await lstat(directory)))
      throw new SkillPluginError(
        "Global skill cache changed while it was read",
      );
  };
  await walk(path);
  if (seen.size !== expected.files.size)
    throw new SkillPluginError("Global skill cache is incomplete");
}

/** Completed adapters are retained across stops/restarts; automatic cache collection is out of scope. */
export const prepareGlobalSkills = (
  dataDir: string,
  skills: ProfileSkills,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LoadedPlugin | undefined> =>
  bounded(async (signal) => {
    const current = await snapshot(skills, environment, signal);
    if (!current.skills.length) return undefined;
    signal.throwIfAborted();
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const cache = join(await realpath(dataDir), "global-skill-cache");
    await mkdir(cache, { mode: 0o700 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    await ownedDirectory(cache);
    const temporary = await mkdtemp(join(cache, ".prepare-"));
    try {
      for (const [name, file] of current.files) {
        signal.throwIfAborted();
        const path = join(temporary, name);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const handle = await open(path, "wx", file.mode);
        try {
          await handle.writeFile(file.bytes);
          await handle.chmod(file.mode);
        } finally {
          await handle.close();
        }
      }
      const digest = await digestPlugin(temporary, current.skills);
      signal.throwIfAborted();
      const destination = join(cache, digest);
      if (
        await lstat(destination).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        })
      )
        await verifyCache(destination, current, signal);
      else {
        signal.throwIfAborted();
        await rename(temporary, destination).catch(
          async (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")
              throw error;
            await verifyCache(destination, current, signal);
          },
        );
      }
      signal.throwIfAborted();
      return {
        path: destination,
        name: globalSkillPluginName,
        skills: current.skills,
        digest,
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
