---
status: accepted
---

# Use native harness configuration and retain in-turn subagents

cab runs the service user's existing coding environment. Authentication, personal
instructions, skills, plugins, MCP servers and hooks belong to the native harness;
cab owns assignments, workspaces, role instructions, model/effort settings,
conversation bindings, capacity, durable questions, Stop/recovery and delivery.
Delivery scope is [#1569](https://github.com/chrisbanes/cab/issues/1569).

## Decision

Preserve the service environment's `HOME`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR`.
Use native subscription login, without copying credentials, forcing file storage,
linking login files or writing personal configuration. API billing and provider
fallback are unavailable. cab continues to exclude its delivery/service credentials
from runtime and helper environments and to redact retained credential references.

Native extensions are trusted. Their MCP requests and hooks may have effects outside
cab's tools; command sandbox controls do not contain every extension effect.
External task content grants no new authority. cab enforces action policy in its own
tools and integrations and provides no independent host sandbox.

Codex retains explicit approval policy `never`, workspace-write, the plan tool and
disabled subagents. Native tools that require approval are unavailable under that
policy. Configuration refresh follows the App Server lifecycle; restart the runtime
after changing its configuration.

Claude retains `dontAsk`, its explicit built-in tool policy, sandbox self-test,
command network denial, no unsandboxed retry and file-edit checks. Native Skill and
MCP tools are admitted alongside cab's SDK server. Before releasing a prompt, verify
native subscription metadata and that the connected reserved `cab` MCP server has
SDK provenance. A project/user server named `cab` that replaces it refuses the turn;
cab tool hooks also require SDK provenance. Do not rebuild user configuration to
resolve a collision. Native configuration is loaded anew by each Claude query.

Claude's `Agent` tool remains available in-turn under the existing execution and
recovery boundary. cab rejects isolation, model, effort and permission-mode overrides.
Named-agent settings and background subagent Stop/resume remain disclosed limits;
native loading adds no new delegation authority.

## Transition and ownership

New cab conversations persist `native` configuration origin in the existing
qualification storage. A legacy or unknown origin is refused before resume and
before assignment writer/capacity acquisition: “Started under the previous harness
setup; reset the task”. Explicit **Reset task** can create a new conversation after
normal recovery requirements. Existing holds, history and sessions remain intact;
cab neither copies rollouts nor imports personal sessions.

Archival and project cleanup operate only on attributable native-origin Codex
conversations with settled work and no unresolved ownership, pending effects or
callbacks. Legacy archive requests and old harness homes remain retained and inactive.
Unrelated personal conversations are never cleanup candidates.

Legacy profile skill JSON, immutable revisions, selected-plugin evidence, token
references and completed command receipts remain readable and replayable. They do
not control execution. New skill-selection and token-reference writes are rejected
with native setup guidance. The CLI flag and operator editing forms are removed;
existing setup links explain native login. Historical helpers remain only in test
fixtures for retained qualification records.

## Consequences

There is one configuration authority, maintained through each harness's own tools.
A change in native extensions can change unattended execution, including external
hook/MCP effects. Runtime process controls and conservative Stop/recovery still
apply within their qualified limits; they do not establish universal descendant
containment or external-effect rollback.

The earlier selected-skill/home evidence remains historical under `docs/evidence/`.
Native start/resume compatibility has passed; integrated lifecycle qualification and
final-head automated/review gates are required before delivery is called ready.
The installed Haze prototype is retained until a separately authorised cutover.
