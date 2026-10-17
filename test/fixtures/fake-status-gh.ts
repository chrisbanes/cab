import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "./temp.js";

/** A fake `gh` that logs how it was run and answers `auth status` from FAKE_GH. */
export function fakeStatusGh(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-fake-gh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "argv.log");
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/sh
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
  return { dir, log, env };
}
