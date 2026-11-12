import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const runtimeNaming = /\bCodex\b|App Server/;

/** Where Codex naming is truthful runtime identity or disclosure. */
const allowed: Record<string, { reason: string; lines?: string[] }> = {
  [join("src", "standalone", "codex.ts")]: { reason: "the Codex runtime" },
  [join("src", "standalone", "readiness.ts")]: {
    reason: "the Codex readiness checks",
  },
  [join("src", "standalone", "execution-policy.ts")]: {
    reason: "Codex-specific execution policy disclosure",
  },
  [join("src", "operator", "command-network-copy.ts")]: {
    reason: "the setting applies only to Codex turns",
    lines: [
      '? "Command network access is enabled for this project\'s Codex turns; Claude Code turns keep it denied."',
    ],
  },
  [join("src", "operator", "local-listening-copy.ts")]: {
    reason:
      "the setting applies only to Claude Code turns because Codex has no loopback-only control",
    lines: [
      '"Codex has no loopback-only control: commands can listen on local ports, on any interface, only when command network access is enabled. The local listening setting does not change Codex turns.";',
      '? "Local listening is enabled for this project\'s Claude Code task turns; Codex turns can listen only with command network access."',
      ': "Local listening is disabled for this project\'s Claude Code task turns; Codex turns can listen only with command network access.";',
    ],
  },
  [join("src", "operator", "sandbox-level-copy.ts")]: {
    reason:
      "the Codex grant lines of the unsandboxed and escalate-approval sandbox levels",
    lines: [
      '"A project at the unsandboxed level runs its Codex task turns with sandbox policy dangerFullAccess; the approval policy stays never. Draft, read-only and unbound turns stay strict.";',
      '"A project at the escalate-approval level keeps its Codex task turns sandboxed, with an approval policy that allows only sandbox escalation: a turn can ask to run one command outside the sandbox. Draft, read-only and unbound turns stay strict.";',
      `? "The sandbox level is escalate-approval for this project's Codex task turns; its Claude Code task turns stay strict."`,
    ],
  },
  [join("src", "core", "execution-runtime.ts")]: {
    reason: "the shared harness label map",
    lines: ['codex: "Codex",'],
  },
  [join("src", "standalone", "state.ts")]: {
    reason: "legacy Stop reasons recognised only by the migration",
    lines: [
      '"Codex interrupt request outcome is uncertain";',
      'const legacyFailedInterruptReason = "Codex interrupt request failed";',
    ],
  },
};

function runtimeNamingLeaks(sources: Map<string, string>): string[] {
  const leaks: string[] = [];
  for (const [path, text] of sources) {
    const allowance = allowed[path];
    if (allowance && !allowance.lines) continue;
    text.split("\n").forEach((line, index) => {
      const code = line.trim();
      if (/^(\/\/|\/\*|\*)/.test(code) || !runtimeNaming.test(code)) return;
      if (allowance?.lines?.includes(code)) return;
      leaks.push(`${path}:${index + 1}: ${code}`);
    });
  }
  return leaks.sort();
}

function neutralSources(): Map<string, string> {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const sources = new Map<string, string>();
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name))
        sources.set(relative(root, path), readFileSync(path, "utf8"));
    }
  };
  walk(join(root, "src"));
  walk(join(root, "web", "src"));
  return sources;
}

test("the scan flags Codex naming outside its allowances", () => {
  const state = join("src", "standalone", "state.ts");
  assert.deepEqual(
    runtimeNamingLeaks(
      new Map([
        ["web/src/view.tsx", "// Codex note\n<p>Codex is down</p>"],
        ["src/notice.ts", 'const reason = "App Server denied";'],
        [join("src", "standalone", "codex.ts"), 'throw new Error("Codex");'],
        [
          state,
          'const legacyFailedInterruptReason = "Codex interrupt request failed";\nreturn "Codex failed";',
        ],
      ]),
    ),
    [
      'src/notice.ts:1: const reason = "App Server denied";',
      `${state}:2: return "Codex failed";`,
      "web/src/view.tsx:2: <p>Codex is down</p>",
    ],
  );
});

test("nothing outside the Codex runtime and its disclosure names Codex", () => {
  const sources = neutralSources();
  assert.ok(sources.size > 50, "the source tree was found");
  for (const path of Object.keys(allowed))
    assert.ok(sources.has(path), `allowance names an existing file: ${path}`);
  assert.deepEqual(runtimeNamingLeaks(sources), []);
});
