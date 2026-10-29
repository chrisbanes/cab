# ADR-1021 skill-plugin and subagent enforcement probes

Answers the open enforcement questions of
[ADR-1021](../adr/1021-profile-skill-plugins-and-subagents.md) for
[#1336](https://github.com/chrisbanes/cab/issues/1336). It is probe evidence only:
no product code changed, and ADR-1021 stays `proposed`.

Redacted traces: [Claude](skill-plugin-probes-claude-2026-10-29.jsonl) (one line per
message shape, query outcome and facet, plus the hook-attribution log) and
[Codex](skill-plugin-probes-codex-2026-10-29.jsonl). Neither contains a token,
user home path or disposable-root path.

## Environment and configuration

- Checkout `75d22ddcbf0edd7430bc9bf02ce5cf5dadb9575f`; macOS 27.0.1; Node 24.22.1;
  npm 11.19.1 (`package.json` pins npm 12.2.1; `npm ci` completed with it).
- Claude Agent SDK 0.3.310 (the `package.json` pin) with bundled Claude Code 2.1.310,
  reached through a disposable root's `sdk/node_modules` link to the checkout's
  installed dependencies; `init` fails if the installed version differs from the pin.
- Model `claude-haiku-5-5` at `low` effort, through the harness's subscription token
  allowlist (`CLAUDE_CODE_OAUTH_TOKEN` only). 17 model-backed queries of the 60 cap.
- Every query used the existing `baseOptions` (`settingSources: []`,
  `strictMcpConfig: true`, `permissionMode: "dontAsk"`, disposable `HOME`,
  `CLAUDE_CONFIG_DIR` and workspace), the cab fixture MCP server, the recording and
  denying `PreToolUse` callback from the permission-policy probe, and the Seatbelt
  sandbox from the sandbox probe (`allowWrite` the workspace only, no network
  domains, no unsandboxed retry). The built-in tools were `Read Glob Grep Write Edit
  Bash`, plus `Skill` for plugin runs and `Agent` for subagent runs.
- Fixture plugin `cabprobe`: a skill `probe-skill` whose script writes a marker in
  the workspace and attempts one outside it, a `SessionStart` and `PreToolUse` hook
  that append to a marker, and a stdio MCP server that writes a marker on start.
  All side effects are markers inside the disposable root.
- Codex CLI 0.164.0 with an empty disposable `CODEX_HOME` and `HOME`, no login, no
  API key and no model call.

Commands, from the repository root after `npm ci` and `npm run build:service`:

```text
node test/execution/skill-plugin-qualification/run.mjs --live init
node test/execution/skill-plugin-qualification/run.mjs --live q1 --root <root>
node test/execution/skill-plugin-qualification/run.mjs --live q2 --root <root>
node test/execution/skill-plugin-qualification/run.mjs --live q3 --root <root>
node test/execution/skill-plugin-qualification/run.mjs --live q3-crash --root <root>
node test/execution/skill-plugin-qualification/run.mjs summary --root <root>
node test/execution/skill-plugin-qualification/run.mjs export --root <root>
node test/execution/skill-plugin-qualification/run.mjs --live cleanup --root <root>
python3 test/execution/skill-plugin-qualification/codex_home_probe.py /tmp/cab-codex-home-<suffix>
```

Dispositions: `demonstrated` means the property held with its positive control;
`demonstrated failure` means it did not hold; `untested surface` means it was not
exercised, with the reason.

## Question 1: hooks, allowlist and skill invocation

The plugin, `skills: ["probe-skill"]` and `managedSettings: { disableAllHooks: true }`
were loaded together (`q1-managed`). The control (`q1-control`) is the same run
without `disableAllHooks`.

| Facet | Disposition | Observation |
| --- | --- | --- |
| F1.1 cab's callback still runs and denies | demonstrated | The callback saw `Skill`, `Bash`, an outside `Write` and an inside `Write`, identical to the control. The outside file was not created and the model received the policy denial. |
| F1.2 plugin hook does not run | demonstrated | No plugin hook marker under `disableAllHooks`. The control wrote 5 marker lines, so the fixture hook does run when hooks are enabled. |
| F1.3 agent invokes the skill and runs its script | demonstrated | The `Skill` tool ran `cabprobe:probe-skill`; its script wrote the workspace marker through sandboxed `Bash`. |
| F1.4 script cannot write outside | demonstrated | The script reported `outside=denied` (`Operation not permitted`) and the outside file does not exist. |

`disableAllHooks` therefore did not stop cab's in-process callback, so the ADR's
fallback (refuse hook-declaring plugins) was not needed and was not run.

Observations for the decision:

- The SDK `skills` option names the skill as `probe-skill` or `cabprobe:probe-skill`.
  `Skill` is not in the tool list unless it is listed in `tools`; the probe added it
  to both `tools` and `allowedTools`.
- The init message's `skills` list still names the CLI's bundled skills while
  `skills` is restricted. Whether the `Skill` tool can invoke them in that
  configuration was not tested.

## Question 2: plugin MCP servers

| Facet | Disposition | Observation |
| --- | --- | --- |
| F2.1 `strictMcpConfig` excludes the plugin's MCP server | demonstrated | With `strictMcpConfig: true` the init message listed only `cab`, advertised no plugin tool and the server never started. The control with `strictMcpConfig: false` listed `plugin:cabprobe:probe-mcp` as connected, advertised its tool and started it. |
| F2.2 managed `allowedMcpServers` naming only cab | untested surface | Not exercised: it is the ADR's alternative if F2.1 failed. The SDK also offers a per-plugin `skipMcpDiscovery`, which was not exercised either. |

## Question 3: subagents

`Agent` was added to `tools` and `allowedTools` and removed from `disallowedTools`.
`Task` must be removed as well: the first attempt left it disallowed and the CLI
reported `Agent is disabled for this session, in subagents as well as here`, with
`Agent` absent from the init tool list. Subagent type `general-purpose`.

| Facet | Disposition | Observation |
| --- | --- | --- |
| F3.1 subagent tool calls reach cab's callback and are denied | demonstrated | The callback received the subagent's `Write` (inside), `Write` (outside) and four `Bash` calls, each carrying `agent_id` and `agent_type: general-purpose`; the main thread's only call was `Agent`. The outside `Write` was denied and the file was not created. |
| F3.2 subagent Bash is sandboxed, including network | demonstrated | The inside write worked (control); the outside write failed with `operation not permitted`; loopback `curl` exited 7 with no `/probe` request at the listener; external `curl` exited 56 with a sandbox network denial. |
| F3.3 Stop mid-subagent leaves no process | demonstrated | The query was aborted once the subagent's `Bash` had written `started`; the query ended in 2.0 s, the CLI exited 143 without a harness signal, and the recorded `/bin/zsh` and `sleep` descendants were verified gone by identity. `finished` was not written. |
| F3.4 killing the service mid-subagent leaves no process | demonstrated failure | After SIGKILL of the probe-owned parent, the CLI, `/bin/zsh` and `sleep` were still alive 30 s later. The main-agent kill, run as the baseline in the same step, behaves identically and matches [issue-822 F3.3](issue-822-claude-sdk-probes-2026-10-11.md); terminating the CLI by its recorded identity also ended its tool processes. Subagents add no new class of survivor, and the same recovery boundary covers them. |

Harness findings during the run:

- A listener on loopback also receives two `GET /` requests (`user-agent: node`,
  `host: localhost`) from a local process outside the probe, independent of any
  agent request. The network facet counts only `/probe`, which the subagent's `curl`
  requests, and records the others as stray requests. A first counting scheme that
  included them mis-classified F3.2.
- Subagent transcripts are stored beside the session
  (`<session>/subagents/agent-<id>.jsonl`) in the dedicated config directory.

## Question 4: Codex under a cab-owned home

Model-free, with `CODEX_HOME` and `HOME` both set to disposable directories.
`codex login status` reported `Not logged in` and App Server `account/read`
returned a null account with `requiresOpenaiAuth: true`.

| Facet | Disposition | Observation |
| --- | --- | --- |
| C4.1 skill and plugin discovery | demonstrated | `skills/list` found a skill in `$CODEX_HOME/skills/<name>` (scope `user`). `skills/extraRoots/set` added a second root for the process. A local marketplace plus `plugin/install` copied the plugin to `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>` and its skill then listed as `<plugin>:<skill>` with the plugin ID. |
| C4.2 how login is supplied | untested surface | Nothing was invoked. The binary documents `codex login --with-api-key`, `--with-access-token` and `--device-auth`, and App Server `account/login/start` accepts `apiKey`, `chatgpt`, `chatgptDeviceCode`, `chatgptAuthTokens` and two Amazon Bedrock types. Whether any of them can be supplied to a cab-owned home without copying the operator's credential store needs a login decision. |
| C4.3 subagents | untested surface | The binary advertises `multi_agent` as stable and enabled, and the protocol has a `CollabAgentTool` tool call. Whether Codex subagents fall under the same sandbox and Stop coverage needs a model-backed turn, which needs a login. |

Findings for the decision:

- Overriding `CODEX_HOME` alone does not isolate skill discovery. With only
  `CODEX_HOME` overridden, `skills/list` also returned 9 user-scope skills from
  `~/.agents/skills` of the service user; with `HOME` overridden as well it returned
  none. A cab-owned home needs `HOME` isolated too. The control read skill metadata
  only; the record keeps the count and root, not names.
- The first App Server start in an empty home writes five bundled system skills
  (`imagegen`, `openai-docs`, `review-agent`, `skill-creator`, `skill-installer`)
  under `$CODEX_HOME/skills/.system`, so they are part of every cab-owned home's
  skill set unless disabled.
- Plugin marketplaces are found from `~/.agents/plugins` and from the repository
  directories passed in `cwds`; an isolated `HOME` has none.

## Cleanup

- The Claude driver's `summary` reported `recorded identities not verified gone: 0`
  before cleanup, and `cleanup` reported `0 survivor(s) handled`. Every CLI,
  `/bin/zsh`, `sleep` and parent identity was recorded and verified through the
  harness; processes were only ever signalled by exact recorded identity.
- The disposable roots `cab-claude-c0-*` and `cab-codex-home-*` were removed, and
  none remained under the temp directories afterwards. The SDK link was unlinked
  before removal, and the checkout's `node_modules` was intact.
- The Codex probe kills only its own App Server process group, then confirms the
  recorded PID is gone (`server-exit` events in the trace).

## Limits

- Only the pinned bundled Claude Code 2.1.310 was qualified, not independently
  installed CLI versions.
- Each facet is one run at `haiku` / `low`; model behaviour (for example which
  tool the model chooses) is not a security property.
- Codex model turns, login supply and subagent coverage are untested, pending the
  login decision.
- Skill network access, skills that publish pull requests, digests, profile
  settings and operator disclosure are out of scope and were not probed.
