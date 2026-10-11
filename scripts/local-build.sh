#!/usr/bin/env bash
# Builds one commit into an immutable local directory; see "Local stable build"
# in docs/operations/standalone-macos.md.
set -euo pipefail

sha=$(git rev-parse --verify "${1:?Usage: scripts/local-build.sh COMMIT}^{commit}")
root="$HOME/.config/ensemble-dev"
build="$root/builds/$sha"
partial="$build.partial"

for path in "$build" "$partial"; do
  if [[ -e "$path" ]]; then
    echo "$path already exists; remove it to rebuild" >&2
    exit 1
  fi
done

dirs=("$root" "$root"/{builds,data,auth,snapshots})
mkdir -p "${dirs[@]}"
chmod 700 "${dirs[@]}"

mkdir "$partial"
git archive "$sha" | tar -x -C "$partial"

node_version=$(<"$partial/.node-version")
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# nvm does not support nounset.
set +u
source "$NVM_DIR/nvm.sh"
nvm install "$node_version"
node=$(nvm which "$node_version")
set -u

(
  cd "$partial"
  npm_pin=$(node -p 'require("./package.json").packageManager')
  # Ignore ~/.npmrc like CI, which has none: npm 12 rejects a user-level
  # allow-scripts in project installs, even when cleared through the environment.
  export NPM_CONFIG_USERCONFIG=/dev/null
  npx --yes --package "$npm_pin" -c 'npm --version && npm ci && npm run build'
)
mv "$partial" "$build"

cat <<EOF
Built $sha
Node: $node
Start:
  ENSEMBLE_OPERATOR_AUTH_FILE="$root/auth/operator-auth.json" \\
  ENSEMBLE_OPERATOR_ORIGIN=http://127.0.0.1:8787 \\
  "$node" "$build/dist/src/standalone/cli.js" operator "$root/data" 8787
EOF
