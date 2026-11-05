import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeSkillPlugin } from "./skill-plugin.js";

/**
 * Disposable Claude Code and Codex homes under `root`, holding the install records cab
 * reads (as observed on Claude Code 2.1.318 and codex-cli 0.166.0). `environment` points
 * the resolver at them. Each install writes its plugin with `write` (default: a Claude
 * manifest plugin named after the id) and returns the install directory.
 */
export function installedPluginHomes(root: string) {
  const claudeHome = join(root, "claude");
  const codexHome = join(root, "codex");
  const installs: Record<string, unknown[]> = {};
  const claudeEnabled: Record<string, boolean> = {};
  const codexEnabled: Record<string, boolean> = {};
  const writeClaude = () => {
    mkdirSync(join(claudeHome, "plugins"), { recursive: true });
    writeFileSync(
      join(claudeHome, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: installs }),
    );
    writeFileSync(
      join(claudeHome, "settings.json"),
      JSON.stringify({ theme: "dark", enabledPlugins: claudeEnabled }),
    );
  };
  const writeCodex = () => {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        'model = "unit"',
        "",
        ...Object.entries(codexEnabled).flatMap(([id, enabled]) => [
          `[plugins."${id}"]`,
          `enabled = ${enabled}`,
          "",
        ]),
      ].join("\n"),
    );
  };
  const parts = (id: string) => id.split("@") as [string, string];
  const defaultWrite =
    (id: string, skills: readonly string[]) =>
    (directory: string): unknown =>
      writeSkillPlugin(directory, skills, parts(id)[0]);
  return {
    environment: {
      HOME: join(root, "home"),
      CLAUDE_CONFIG_DIR: claudeHome,
      CODEX_HOME: codexHome,
    } as NodeJS.ProcessEnv,
    claudeHome,
    codexHome,
    /** Installs `<plugin>@<marketplace>` at user scope, replacing any earlier version's record. */
    installClaude(
      id: string,
      {
        version = "1.0.0",
        skills = ["probe-skill"] as readonly string[],
        enabled = true,
        write = defaultWrite(id, skills),
        extra = [] as unknown[],
      } = {},
    ): string {
      const [plugin, marketplace] = parts(id);
      const directory = join(
        claudeHome,
        "plugins",
        "cache",
        marketplace,
        plugin,
        version,
      );
      write(directory);
      installs[id] = [
        ...extra,
        { scope: "user", installPath: directory, version },
      ];
      claudeEnabled[id] = enabled;
      writeClaude();
      return directory;
    },
    setClaudeEnabled(id: string, enabled: boolean): void {
      claudeEnabled[id] = enabled;
      writeClaude();
    },
    /** Installs `<plugin>@<marketplace>` as Codex does, removing earlier version directories. */
    installCodex(
      id: string,
      {
        version = "1.0.0",
        skills = ["probe-skill"] as readonly string[],
        enabled = true,
        write = defaultWrite(id, skills),
        keepOld = false,
      } = {},
    ): string {
      const [plugin, marketplace] = parts(id);
      const cache = join(codexHome, "plugins", "cache", marketplace, plugin);
      if (!keepOld) rmSync(cache, { recursive: true, force: true });
      const directory = join(cache, version);
      write(directory);
      codexEnabled[id] = enabled;
      writeCodex();
      return directory;
    },
    setCodexEnabled(id: string, enabled: boolean): void {
      codexEnabled[id] = enabled;
      writeCodex();
    },
  };
}
