# Add Claude

**Status:** native setup guidance is implemented on Settings → Runtime and through
the existing setup/readiness links. cab token-reference controls are retired.

## Goal

An operator can sign in to Claude Code as the service user and confirm that cab
can use that native subscription login.

## Entry points

- Settings → Runtime → Add Claude.
- [Project setup](project-setup.md) and [Getting started](getting-started.md)
  readiness links for Claude.
- A task's native-login Fix opens the same setup guidance.

## Steps

1. Sign in to Claude Code as the user running cab. The service must use the same
   `HOME` and `CLAUDE_CONFIG_DIR` as that native setup.
2. Restart Claude in Settings → Runtime, then run Readiness. The login check
   reads native account metadata without submitting a model prompt.
3. Manage instructions, skills, plugins, MCP servers and hooks in Claude Code's
   normal configuration. Configured extensions are trusted and may act outside
   cab's tools; command restrictions do not confine every extension effect.

cab neither accepts a setup token nor edits the user's configuration. API billing
and provider fallback are unavailable. See the
[operations guide](../operations/standalone-macos.md#native-coding-harness-setup)
for the service environment and separately approved migration/rollback procedure.

## Recovery

- If native authentication expires, sign in again as the service user and restart
  the runtime. Recover held work only through its existing recovery checks.
- Disabling Claude keeps bound work waiting; enabling it again is explicit and
  never substitutes another harness.
- Historical token references and old receipts remain retained. New token writes
  are refused; no personal credential file is deleted or rewritten by this flow.
