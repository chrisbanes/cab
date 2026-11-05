import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import {
  type ExecutionHarness,
  type InstalledPluginRef,
  pluginToolLabels,
  installedPluginRefSchema,
} from "../core/execution-runtime.js";
import { realHome } from "./codex-home.js";

/**
 * Plugins the operator installed and enabled in Claude Code or Codex (ADR-1021, "Installed
 * plugins"). Only these records are read; neither format is a documented interface, so each
 * is validated here and anything unexpected fails closed. Nothing is ever written.
 */
export type PluginTool = ExecutionHarness;

/** A plugin that cannot be resolved. The message names the plugin and never a path. */
export class InstalledPluginError extends Error {}

/** Larger records are refused rather than read. */
const maxRecordBytes = 4 * 1024 * 1024;

/** `$CLAUDE_CONFIG_DIR` from the service environment, else `~/.claude`. */
const claudeHome = (environment: NodeJS.ProcessEnv) =>
  environment.CLAUDE_CONFIG_DIR || join(realHome(environment), ".claude");
/** `$CODEX_HOME` from the service environment, else `~/.codex`, as for the login link. */
const codexHome = (environment: NodeJS.ProcessEnv) =>
  environment.CODEX_HOME || join(realHome(environment), ".codex");

const absolutePath = z
  .string()
  .max(1024)
  .regex(/^\/[^\0]*[^/\0]$/)
  .refine((path) => !/\/\/|\/\.{1,2}(\/|$)/.test(path));

const claudeSettingsSchema = z.looseObject({
  enabledPlugins: z.record(z.string(), z.unknown()).optional(),
});
const claudeInstalledSchema = z.looseObject({
  version: z.literal(2),
  plugins: z.record(z.string(), z.unknown()),
});
const claudeInstallsSchema = z.array(
  z.looseObject({ scope: z.string(), installPath: z.unknown() }),
);
const codexConfigSchema = z.looseObject({
  plugins: z.record(z.string(), z.unknown()).optional(),
});
const codexPluginSchema = z.looseObject({ enabled: z.boolean() });

class Unrecognised extends Error {}

/** A record's text, `undefined` when it does not exist; `Unrecognised` when it cannot be read. */
async function readRecord(file: string): Promise<string | undefined> {
  const info = await stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw new Unrecognised();
  });
  if (!info) return undefined;
  if (!info.isFile() || info.size > maxRecordBytes) throw new Unrecognised();
  return readFile(file, "utf8").catch(() => {
    throw new Unrecognised();
  });
}

function parseRecord<T>(
  text: string,
  parse: (text: string) => unknown,
  schema: z.ZodType<T>,
): T {
  let value: unknown;
  try {
    value = parse(text);
  } catch {
    throw new Unrecognised();
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Unrecognised();
  return parsed.data;
}

const claudeInstalled = async (environment: NodeJS.ProcessEnv) => {
  const text = await readRecord(
    join(claudeHome(environment), "plugins", "installed_plugins.json"),
  );
  return text === undefined
    ? undefined
    : parseRecord(text, JSON.parse, claudeInstalledSchema).plugins;
};
const claudeEnabled = async (environment: NodeJS.ProcessEnv) => {
  const text = await readRecord(join(claudeHome(environment), "settings.json"));
  return text === undefined
    ? {}
    : (parseRecord(text, JSON.parse, claudeSettingsSchema).enabledPlugins ??
        {});
};
const codexPlugins = async (environment: NodeJS.ProcessEnv) => {
  const text = await readRecord(join(codexHome(environment), "config.toml"));
  return text === undefined
    ? undefined
    : (parseRecord(text, parseToml, codexConfigSchema).plugins ?? {});
};

type Resolution =
  | { kind: "ok"; path: string }
  | { kind: "not-installed" | "disabled" | "unrecognised" | "ambiguous" };

/** The single user-scope install of a Claude Code plugin. */
function claudeInstall(entry: unknown): Resolution {
  if (entry === undefined) return { kind: "not-installed" };
  const installs = claudeInstallsSchema.safeParse(entry);
  if (!installs.success) return { kind: "unrecognised" };
  // Project and local installs are enabled by a repository's own settings, not the operator's.
  const user = installs.data.filter((install) => install.scope === "user");
  if (user.length === 0) return { kind: "not-installed" };
  if (user.length > 1) return { kind: "ambiguous" };
  const path = absolutePath.safeParse(user[0]!.installPath);
  return path.success
    ? { kind: "ok", path: path.data }
    : { kind: "unrecognised" };
}

/** The version directories of a Codex plugin's cache, ignoring Codex's in-progress installs. */
async function codexVersions(
  environment: NodeJS.ProcessEnv,
  plugin: string,
  marketplace: string,
): Promise<string[]> {
  const directory = join(
    codexHome(environment),
    "plugins",
    "cache",
    marketplace,
    plugin,
  );
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        !entry.name.startsWith("plugin-install-"),
    )
    .map((entry) => join(directory, entry.name));
}

async function resolve(
  tool: PluginTool,
  id: string,
  environment: NodeJS.ProcessEnv,
): Promise<Resolution> {
  try {
    if (tool === "claude") {
      const install = claudeInstall((await claudeInstalled(environment))?.[id]);
      if (install.kind !== "ok") return install;
      const enabled = (await claudeEnabled(environment))[id];
      if (enabled !== undefined && typeof enabled !== "boolean")
        return { kind: "unrecognised" };
      return enabled === true ? install : { kind: "disabled" };
    }
    const [plugin, marketplace] = id.split("@") as [string, string];
    const versions = await codexVersions(environment, plugin, marketplace);
    if (versions.length === 0) return { kind: "not-installed" };
    const entry = (await codexPlugins(environment))?.[id];
    if (entry === undefined) return { kind: "disabled" };
    const config = codexPluginSchema.safeParse(entry);
    if (!config.success) return { kind: "unrecognised" };
    if (!config.data.enabled) return { kind: "disabled" };
    return versions.length === 1
      ? { kind: "ok", path: versions[0]! }
      : { kind: "ambiguous" };
  } catch (error) {
    if (error instanceof Unrecognised) return { kind: "unrecognised" };
    throw error;
  }
}

const splitRef = (ref: InstalledPluginRef) => {
  const colon = ref.indexOf(":");
  return {
    tool: ref.slice(0, colon) as PluginTool,
    id: ref.slice(colon + 1),
  };
};

/**
 * The install directory of an installed and enabled plugin, resolved now. Throws an
 * `InstalledPluginError` naming the plugin, its tool and why, never a path.
 */
export async function resolveInstalledPlugin(
  ref: InstalledPluginRef,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const { tool, id } = splitRef(ref);
  const result = await resolve(tool, id, environment).catch(() => ({
    kind: "unrecognised" as const,
  }));
  if (result.kind === "ok") return result.path;
  const label = pluginToolLabels[tool];
  throw new InstalledPluginError(
    `Skill plugin ${ref} ${
      result.kind === "not-installed"
        ? `is not installed in ${label}`
        : result.kind === "disabled"
          ? `is disabled in ${label}`
          : result.kind === "ambiguous"
            ? `has more than one installed version in ${label}`
            : `has an unrecognised install record in ${label}`
    }`,
  );
}

export type InstalledToolStatus = "available" | "none" | "unreadable";

/** Every plugin each tool records as installed and enabled, by ref; each still needs resolving. */
export async function enabledInstalledPlugins(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{
  refs: InstalledPluginRef[];
  status: Record<PluginTool, InstalledToolStatus>;
}> {
  const refs: InstalledPluginRef[] = [];
  const status: Record<PluginTool, InstalledToolStatus> = {
    claude: "none",
    codex: "none",
  };
  try {
    const installed = await claudeInstalled(environment);
    if (installed) {
      const enabled = await claudeEnabled(environment);
      status.claude = "available";
      for (const id of Object.keys(installed).sort())
        if (enabled[id] === true) refs.push(`claude:${id}`);
    }
  } catch {
    status.claude = "unreadable";
  }
  try {
    const plugins = await codexPlugins(environment);
    if (plugins) {
      status.codex = "available";
      for (const [id, entry] of Object.entries(plugins).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ))
        if (codexPluginSchema.safeParse(entry).data?.enabled === true)
          refs.push(`codex:${id}`);
    }
  } catch {
    status.codex = "unreadable";
  }
  // An id outside the profile grammar can never be named by a profile.
  return {
    refs: refs.filter((ref) => installedPluginRefSchema.safeParse(ref).success),
    status,
  };
}
