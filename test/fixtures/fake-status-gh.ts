import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "./temp.js";

/**
 * A fake `gh` that answers `auth status`. With FAKE_GH set (even to nothing) it logs argv and the token
 * variables to GH_LOG and answers FAKE_GH as the token source. Unset, it behaves
 * like gh: the config directory is GH_CONFIG_DIR, else XDG_CONFIG_HOME/gh, else
 * $HOME/.config/gh; a hosts.yml there makes a file login, otherwise the keychain. It
 * then dumps its whole environment to $HOME/.gh-probe.log, so a test can see exactly
 * what the probe ran under.
 */
export function fakeStatusGh(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "cab-fake-gh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "argv.log");
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/sh
if [ -z "${"$"}{FAKE_GH+x}" ]; then
  if [ -n "${"$"}{GH_CONFIG_DIR:-}" ]; then dir="$GH_CONFIG_DIR"
  elif [ -n "${"$"}{XDG_CONFIG_HOME:-}" ]; then dir="$XDG_CONFIG_HOME/gh"
  else dir="${"$"}{HOME:-/nonexistent}/.config/gh"; fi
  env >> "${"$"}{HOME:-/nonexistent}/.gh-probe.log"
  if [ -f "$dir/hosts.yml" ]; then source="$dir/hosts.yml"; else source=keyring; fi
  echo "{\\"hosts\\":{\\"github.com\\":[{\\"active\\":true,\\"state\\":\\"success\\",\\"tokenSource\\":\\"$source\\"}]}}"
  exit 0
fi
echo "$*" >> "$GH_LOG"
for name in GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN; do
  eval "echo \\"$name=\\\${$name:-unset}\\" >> \\"\\$GH_LOG\\""
done
echo "GH_PROMPT_DISABLED=\${GH_PROMPT_DISABLED:-unset}" >> "$GH_LOG"
case "$FAKE_GH" in
  fail) exit 1 ;;
  garbage) echo "not json" ;;
  *) echo "{\\"hosts\\":{\\"github.com\\":[{\\"active\\":true,\\"state\\":\\"success\\",\\"tokenSource\\":\\"$FAKE_GH\\",\\"token\\":\\"canary-1144\\"}]}}" ;;
esac
`,
    { mode: 0o755 },
  );
  const env = (mode: string): NodeJS.ProcessEnv => ({
    PATH: `${dir}:/usr/bin:/bin`,
    GH_LOG: log,
    FAKE_GH: mode,
    GH_TOKEN: "canary-env",
    GITHUB_TOKEN: "canary-github-env",
    GH_ENTERPRISE_TOKEN: "canary-enterprise-env",
    GITHUB_ENTERPRISE_TOKEN: "canary-github-enterprise-env",
  });
  return { dir, log, env, exe: join(dir, "gh") };
}
