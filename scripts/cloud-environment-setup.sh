#!/bin/bash
# Setup script for the cab Claude Code cloud environment. Paste this file into the
# environment's Setup script field; the cache rebuilds only when that pasted text changes.
# Keep the versions in step with .nvmrc, package.json packageManager and playwright.
set -euo pipefail
NODE=26.13.0 NPM=12.2.1 PLAYWRIGHT=1.64.1

curl -fsSL "https://nodejs.org/dist/v$NODE/node-v$NODE-linux-x64.tar.xz" | tar -xJ -C /opt
ln -sfn "/opt/node-v$NODE-linux-x64" /opt/node26
export PATH="/opt/node26/bin:$PATH"
npm install --global "npm@$NPM"
npx --yes "playwright@$PLAYWRIGHT" install --with-deps chromium webkit
