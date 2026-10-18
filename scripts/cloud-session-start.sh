#!/bin/bash
# SessionStart hook: install dependencies in Claude Code cloud sessions only. The toolchain
# comes from scripts/cloud-environment-setup.sh in the environment's setup script.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"

export PATH="/opt/node24/bin:$PATH"
# Later Bash commands start from the image default (Node 22) unless the hook persists PATH.
# shellcheck disable=SC2016 # expand $PATH when the env file is sourced
[ -z "${CLAUDE_ENV_FILE:-}" ] || echo 'export PATH="/opt/node24/bin:$PATH"' >>"$CLAUDE_ENV_FILE"

want="v$(cat .nvmrc)"
[ "$(node --version)" = "$want" ] ||
  echo "Cloud environment has Node $(node --version); .nvmrc wants $want. Update the environment setup script." >&2

[ -d node_modules ] || npm ci --no-audit --no-fund
# No-op when the setup script already installed this Playwright's browsers.
npx playwright install chromium webkit
