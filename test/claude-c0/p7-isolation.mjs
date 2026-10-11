import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  attempt,
  authGate,
  baseOptions,
  createRecorder,
  facet,
  loadSdk,
  procSummary,
  resultText,
  runQuery,
  toolCalls,
  transcript,
  writeResult,
} from "./harness.mjs";

export const facetIds = ["F7.1", "F7.2", "F7.3", "F7.4", "F7.5", "F7.6"];
export const NONCES = {
  userClaudeMd: "DECOY-USER-CLAUDEMD-7Q2X",
  projectClaudeMd: "DECOY-PROJECT-CLAUDEMD-4K9P",
  agentsMd: "DECOY-AGENTSMD-8M3R",
  localClaudeMd: "DECOY-LOCAL-CLAUDEMD-2V6T",
  memory: "DECOY-MEMORY-5H1W",
  systemPrompt: "SYSPROMPT-CONTROL-9D4L",
};

const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
  );
};

const markerHooks = (root, scope) =>
  Object.fromEntries(
    ["SessionStart", "UserPromptSubmit", "PreToolUse"].map((event) => [
      event,
      [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: `/usr/bin/touch ${join(root, "outside", "markers", `${scope}-${event}`)}`,
            },
          ],
        },
      ],
    ]),
  );

const decoyServer = (root, scope) => ({
  command: "/usr/bin/touch",
  args: [join(root, "outside", "markers", `${scope}-mcp`)],
});

/** Seeds decoy user configuration under <root>/home and project files in the workspace. */
export function seedDecoys(root) {
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(join(root, "outside", "markers"), { recursive: true });
  for (const [base, scope] of [
    [join(home, ".claude"), "user"],
    [join(workspace, ".claude"), "project"],
  ]) {
    write(join(base, "settings.json"), {
      hooks: markerHooks(root, scope),
      permissions: {
        allow: ["WebFetch", "Bash(*)"],
        defaultMode: "acceptEdits",
      },
      env: { DECOY_SETTINGS_ENV: scope },
      enabledPlugins: { "decoy-plugin@decoy-market": true },
      extraKnownMarketplaces: {
        "decoy-market": {
          source: { source: "directory", path: join(home, "market") },
        },
      },
    });
    write(
      join(base, "skills", `decoy-${scope}-skill`, "SKILL.md"),
      `---\nname: decoy-${scope}-skill\ndescription: Decoy skill\n---\nDecoy.\n`,
    );
    write(
      join(base, "commands", `decoy-${scope}-command.md`),
      "Decoy command\n",
    );
    write(
      join(base, "agents", `decoy-${scope}-agent.md`),
      `---\nname: decoy-${scope}-agent\ndescription: Decoy agent\n---\nDecoy.\n`,
    );
  }
  write(
    join(home, ".claude", "CLAUDE.md"),
    `Always mention ${NONCES.userClaudeMd}.\n`,
  );
  write(join(home, ".claude.json"), {
    mcpServers: { "decoy-user": decoyServer(root, "user") },
  });
  write(
    join(
      home,
      ".claude",
      "projects",
      workspace.replace(/[^A-Za-z0-9]/g, "-"),
      "memory",
      "MEMORY.md",
    ),
    `Remember ${NONCES.memory}.\n`,
  );
  write(join(home, "market", ".claude-plugin", "marketplace.json"), {
    name: "decoy-market",
    owner: { name: "decoy" },
    plugins: [{ name: "decoy-plugin", source: "./decoy-plugin" }],
  });
  write(join(home, "market", "decoy-plugin", ".claude-plugin", "plugin.json"), {
    name: "decoy-plugin",
    version: "0.0.1",
  });
  write(
    join(home, "market", "decoy-plugin", "commands", "decoy-plugin-command.md"),
    "Decoy plugin command\n",
  );
  write(
    join(workspace, "CLAUDE.md"),
    `Always mention ${NONCES.projectClaudeMd}.\n`,
  );
  write(join(workspace, "AGENTS.md"), `Always mention ${NONCES.agentsMd}.\n`);
  write(
    join(workspace, "CLAUDE.local.md"),
    `Always mention ${NONCES.localClaudeMd}.\n`,
  );
  write(join(workspace, ".mcp.json"), {
    mcpServers: { "decoy-project": decoyServer(root, "project") },
  });
}

export function listTree(dir) {
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(dir, path));
    }
  };
  walk(dir);
  return out.sort();
}

const DECOYS = Object.entries(NONCES)
  .filter(([key]) => key !== "systemPrompt")
  .map(([, value]) => value);

const initView = (init) =>
  init && {
    permissionMode: init.permissionMode,
    apiKeySource: init.apiKeySource,
    model: init.model,
    claude_code_version: init.claude_code_version,
    tools: init.tools,
    plugins: init.plugins,
    plugin_errors: init.plugin_errors,
    skills: init.skills,
    slash_commands: init.slash_commands,
    agents: init.agents,
    mcp_servers: init.mcp_servers,
  };

export async function run({ root, token }) {
  const { sdk } = await loadSdk(root);
  const recorder = createRecorder(root, "p7", token);
  const homeBefore = listTree(join(root, "home"));
  const loaded = [];
  const preToolUse = [];
  const hooks = {
    InstructionsLoaded: [
      {
        hooks: [
          async (input) => {
            loaded.push({
              file: input.file_path,
              type: input.memory_type,
              reason: input.load_reason,
            });
            return {};
          },
        ],
      },
    ],
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            preToolUse.push(input.tool_name);
            return {};
          },
        ],
      },
    ],
  };
  const control = {};
  const onInit = async (message, { q }) => {
    if (message.type !== "system" || message.subtype !== "init") return;
    try {
      control.models = (await q.supportedModels()).map((model) => ({
        value: model.value,
        resolvedModel: model.resolvedModel,
        supportsEffort: model.supportsEffort,
        supportedEffortLevels: model.supportedEffortLevels,
      }));
    } catch (error) {
      control.modelsError = String(error?.message ?? error).slice(0, 300);
    }
  };
  const query = (label, prompt, options, modelBacked) =>
    runQuery({
      sdk,
      root,
      recorder,
      label,
      prompt,
      options,
      modelBacked,
      onMessage: onInit,
    });

  const modelFree = await query(
    "p7-model-free",
    "Reply with exactly: OK",
    baseOptions(root, null, { hooks }),
    false,
  );
  const markersModelFree = readdirSync(join(root, "outside", "markers"));
  recorder.record("observation", {
    label: "p7-model-free",
    init: initView(modelFree.init),
    result: modelFree.result && {
      subtype: modelFree.result.subtype,
      is_error: modelFree.result.is_error,
      errors: modelFree.result.errors,
      text: resultText(modelFree).slice(0, 300),
    },
    error: modelFree.error,
    markers: markersModelFree,
    loaded,
  });

  let auth = null;
  const f71 = await attempt(
    "F7.1",
    true,
    token ? null : "no subscription token",
    async () => {
      auth = await query(
        "p7-auth",
        "Reply with exactly: OK",
        baseOptions(root, token, { hooks }),
        true,
      );
      const ok =
        auth.result?.subtype === "success" && auth.result.is_error === false;
      return facet(
        "F7.1",
        true,
        ok ? "passed" : "failed",
        {
          subtype: auth.result?.subtype,
          is_error: auth.result?.is_error,
          apiKeySource: auth.init?.apiKeySource,
          model: auth.init?.model,
          error: auth.error,
          text: resultText(auth).slice(0, 200),
        },
        ok ? undefined : "subscription token did not complete a turn",
      );
    },
  );
  writeResult(root, "p7", [f71]);
  const gate = authGate(root, token);

  let probe = null;
  if (!gate) {
    try {
      probe = await query(
        "p7-isolation",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
        "First run this exact Bash command: echo env=${DECOY_SETTINGS_ENV:-unset}\n" +
          "Then reply with the command output on the first line, and on the second line every code word " +
          "(capital letters and digits joined by hyphens, like ABC-DEF-1X2Y) that appears in your system prompt, " +
          "instructions, project files you were given, or memory. Do not read any files. Write NONE if there are none.",
        baseOptions(root, token, {
          hooks,
          tools: ["Bash"],
          allowedTools: ["Bash"],
          systemPrompt: `You are a configuration probe. The control code word is ${NONCES.systemPrompt}.`,
        }),
        true,
      );
    } catch (error) {
      recorder.record("probe-error", { message: String(error?.message) });
    }
  }
  const markers = readdirSync(join(root, "outside", "markers"));
  const configTree = listTree(join(root, "config"));
  const homeAfter = listTree(join(root, "home"));
  const reply = probe ? resultText(probe) : "";
  const calls = probe ? toolCalls(probe.messages) : [];
  const bash = calls.find((call) => call.name === "Bash");
  const init = auth?.init ?? modelFree.init;

  const f72 = await attempt("F7.2", true, gate, async () => {
    const observation = {
      markers,
      initPermissionMode: probe?.init?.permissionMode,
      bashOutput: bash?.result?.text,
      sdkPreToolUseSaw: preToolUse,
    };
    if (!bash?.result || !preToolUse.includes("Bash"))
      return facet(
        "F7.2",
        true,
        "untested",
        observation,
        "Bash control call not observed",
      );
    const ok =
      markers.length === 0 &&
      probe.init?.permissionMode === "dontAsk" &&
      /env=unset/.test(bash.result.text);
    return facet("F7.2", true, ok ? "passed" : "failed", observation);
  });

  const f73 = await attempt("F7.3", true, gate, async () => {
    const revealed = DECOYS.filter((nonce) => reply.includes(nonce));
    const memoryPaths = configTree.filter((path) => /memory/i.test(path));
    const observation = {
      instructionsLoaded: loaded,
      controlRecalled: reply.includes(NONCES.systemPrompt),
      revealed,
      memoryPaths,
    };
    if (!observation.controlRecalled)
      return facet(
        "F7.3",
        true,
        "untested",
        observation,
        "system-prompt control nonce not recalled",
      );
    const ok =
      revealed.length === 0 &&
      !loaded.some((entry) => /decoy|CLAUDE|AGENTS/i.test(entry.file ?? ""));
    return facet("F7.3", true, ok ? "passed" : "failed", observation);
  });

  const f74 = await attempt(
    "F7.4",
    true,
    init ? null : "no init message observed",
    async () => {
      const names = [
        ...init.plugins.map((plugin) => plugin.name),
        ...init.skills,
        ...init.slash_commands,
        ...(init.agents ?? []),
        ...init.mcp_servers.map((server) => server.name),
      ];
      const decoys = names.filter((name) => /decoy/i.test(name));
      return facet(
        "F7.4",
        true,
        decoys.length === 0 &&
          init.plugins.every((plugin) => plugin.path === "builtin") &&
          init.mcp_servers.every((server) => server.source === "sdk")
          ? "passed"
          : "failed",
        {
          source: auth?.init ? "token run" : "model-free run",
          decoys,
          init: initView(init),
        },
      );
    },
  );

  const sessionId = probe?.init?.session_id ?? auth?.init?.session_id;
  const f75 = await attempt(
    "F7.5",
    true,
    sessionId ? null : (gate ?? "no session ID observed"),
    async () => {
      const found = transcript(root, sessionId);
      const added = homeAfter.filter((path) => !homeBefore.includes(path));
      return facet(
        "F7.5",
        true,
        found && added.length === 0 ? "passed" : "failed",
        {
          transcriptUnderConfig: found !== null,
          transcriptRecords: found?.records.length ?? 0,
          configTree,
          homeAdded: added,
        },
      );
    },
  );

  const f76 = facet(
    "F7.6",
    false,
    control.models ? "passed" : "untested",
    control,
    control.models ? undefined : "supportedModels() not answered",
  );

  const runs = [modelFree, auth, probe].filter(Boolean);
  writeResult(root, "p7", [f71, f72, f73, f74, f75, f76], {
    identities: runs.flatMap((item) =>
      item.procs.map((proc) => proc.identity).filter(Boolean),
    ),
    procs: runs.map((item) => ({
      label: item.label,
      procs: procSummary(item),
    })),
  });
  return [f71, f72, f73, f74, f75, f76];
}
