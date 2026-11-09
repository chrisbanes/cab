import { Panel, type SettingsProps } from "./settings.js";

/** Keeps existing setup links useful after token-reference configuration is retired. */
export function AddClaudePanel(_p: SettingsProps) {
  return (
    <Panel
      id="add-claude"
      title="Add Claude"
      description="Use the service user's native Claude Code login and configuration."
    >
      <p className="body">
        Sign in to Claude Code as the user running cab. Keep the same HOME and
        CLAUDE_CONFIG_DIR when starting the service, then restart Claude in
        Settings → Runtime and run Readiness.
      </p>
      <p className="metadata muted">
        cab uses native subscription authentication. API billing is unavailable.
        Configured hooks and MCP servers are trusted and can act outside cab's
        tools.
      </p>
    </Panel>
  );
}
