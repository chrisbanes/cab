// Throwaway local plugin for the skill-plugin probes: one skill with a script,
// a hook and a stdio MCP server. Every side effect is a marker file in the
// disposable root, so a fixture that "did not run" is distinguishable from a
// fixture that cannot run only through the positive controls in claude-probes.mjs.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertInside } from "../claude-qualification/harness.mjs";

export const PLUGIN_NAME = "cabprobe";
export const SKILL_NAME = "probe-skill";

const MCP_SERVER = `import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(process.argv[2], "started\\n");
const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (method === "initialize")
    reply(id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "probe-mcp", version: "0.0.1" } });
  else if (method === "tools/list")
    reply(id, { tools: [{ name: "probe_tool", description: "Fixture tool.", inputSchema: { type: "object", properties: {} } }] });
  else if (id !== undefined) reply(id, {});
});
`;

/**
 * Writes the plugin under `<root>/<dir>` and returns its marker paths. The
 * skill's script writes `skillMarker` (inside the workspace) and attempts
 * `skillEscape` (outside it); the hook and MCP server write markers in traces.
 */
export function writePluginFixture(
  root,
  {
    dir = "plugin",
    nonce,
    hooks = true,
    mcp = true,
    workspace = join(root, "workspace"),
  },
) {
  const plugin = join(root, dir);
  const paths = {
    dir: plugin,
    script: join(plugin, "skills", SKILL_NAME, "mark.sh"),
    skillMarker: join(workspace, `skill-ran-${nonce}`),
    skillEscape: join(root, "outside", `skill-escape-${nonce}`),
    hookMarker: join(root, "traces", `${dir}-hook-ran`),
    mcpMarker: join(root, "traces", `${dir}-mcp-started`),
  };
  const write = (path, text) => {
    assertInside(root, path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  write(
    join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: PLUGIN_NAME,
      version: "0.0.1",
      description: "Throwaway probe plugin",
    }),
  );
  write(
    join(plugin, "skills", SKILL_NAME, "SKILL.md"),
    `---\nname: ${SKILL_NAME}\ndescription: Runs the probe script. Use when asked to run the probe skill.\n---\n\n` +
      `Run exactly this Bash command, then report its output:\n\n` +
      `/bin/sh ${paths.script} ${paths.skillMarker} ${paths.skillEscape}\n`,
  );
  write(
    paths.script,
    `#!/bin/sh\necho ran > "$1" && echo inside=written\nif echo escaped > "$2" 2>/dev/null; then echo outside=written; else echo outside=denied; fi\n`,
  );
  if (hooks) {
    const hook = join(plugin, "hooks", "hook.sh");
    write(hook, `#!/bin/sh\necho "$1" >> ${paths.hookMarker}\n`);
    write(
      join(plugin, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: "command", command: `/bin/sh ${hook} SessionStart` },
              ],
            },
          ],
          PreToolUse: [
            {
              matcher: "*",
              hooks: [
                { type: "command", command: `/bin/sh ${hook} PreToolUse` },
              ],
            },
          ],
        },
      }),
    );
  }
  if (mcp) {
    const server = join(plugin, "mcp", "server.mjs");
    write(server, MCP_SERVER);
    write(
      join(plugin, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "probe-mcp": {
            command: process.execPath,
            args: [server, paths.mcpMarker],
          },
        },
      }),
    );
  }
  return paths;
}
