import { lstat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { z } from "zod";
import {
  type ExecutionHarness,
  executionHarnessLabels,
  type ProfileRuntime,
  type SupportedRuntimeSettings,
  unsupportedRuntimeField,
} from "../core/execution-runtime.js";
import type {
  discoveryStatusSchema,
  HarnessStatus,
  RuntimeRestart,
} from "../operator/contracts.js";
import { readinessFix } from "../operator/runtime-restart-copy.js";
import {
  type ClaudeTokenCheckResult,
  claudeTokenCheckSchema,
  readinessCheckSchema,
  type ReadinessCheck,
  type ReadinessCheckId,
  type ReadinessResult,
  readinessCheckIds,
  readinessSchema,
} from "../operator/readiness.js";
import { claudeTokenSource, readClaudeToken } from "./claude-token.js";
import { assertExistingCanonicalDirectoryPath } from "./data-directory.js";
import { printVersion, resolveOnPath } from "./executable-path.js";
import type { OperatorApi } from "./operator-api.js";
import type { StandaloneService } from "./service.js";

type Discovery = Pick<
  z.infer<typeof discoveryStatusSchema>["data"],
  "configured" | "available"
>;

/** An active-or-revoked profile's execution runtime; its name never enters readiness. */
export type ReadinessProfile = {
  revoked: boolean;
  runtime: ProfileRuntime;
};

export type ReadinessDeps = {
  /** Where `PATH` is read; the service's own environment. */
  env: NodeJS.ProcessEnv;
  /** The service user, for ownership rules. */
  uid: number | undefined;
  dataDir: string;
  authFile: string;
  /** Re-runs the running App Server's authentication initialization; no model turn. */
  codexLogin: () => Promise<"verified" | "policy" | "failed" | "unavailable">;
  discovery: () => Promise<Discovery>;
  claudeTokenReference: () => string | null;
  claudeTokenStatus: () => {
    state:
      | "not-configured"
      | "missing-value"
      | "restart-required"
      | "available";
  };
  harnessStatuses: () => (Pick<
    HarnessStatus,
    "harness" | "state" | "enabled"
  > & {
    reason?: "disabled" | "executable-missing";
    restart?: RuntimeRestart | undefined;
  })[];
  harnessSettings: (
    harness: ExecutionHarness,
  ) => SupportedRuntimeSettings | null;
  profiles: () => ReadinessProfile[];
  now?: () => number;
  /** Bound on the Codex login and GitHub discovery checks; defaults to 10 s. */
  timeoutMs?: number;
  /** Bound on `claude --version`; defaults to 5 s. */
  versionTimeoutMs?: number;
};

const labels: Record<ReadinessCheckId, string> = {
  "runtime-enabled": "An execution runtime is enabled",
  "codex-executable": "Codex executable",
  "codex-login": "Codex login",
  git: "Git",
  "github-discovery": "GitHub discovery",
  "claude-executable": "Claude executable",
  "claude-token": "Claude token",
  "runtime-harness": "Runtime harness",
  "data-paths": "Data and auth paths",
};

const pass = (id: ReadinessCheckId): ReadinessCheck => ({
  id,
  label: labels[id],
  status: "pass",
  reason: null,
  fix: null,
});
const outcome = (
  id: ReadinessCheckId,
  status: "fail" | "not-configured",
  reason: string,
  fix: string,
): ReadinessCheck => ({
  id,
  label: labels[id],
  status,
  // A reason that outgrew the schema would otherwise invalidate the whole read.
  reason: reason.length > 500 ? `${reason.slice(0, 499)}…` : reason,
  fix,
});

const fixes = {
  codex:
    "Install Codex into the fixed PATH, then turn Codex off and on in Settings → Runtime",
  codexLogin: "Run `codex login` as the service user",
  git: "Install git",
  discovery: "Run `gh auth login`, or Settings → discovery credential",
  claudeInstall:
    "Install Claude Code into the fixed PATH, then turn Claude off and on in Settings → Runtime",
  claudeVersion:
    "Run `claude --version` as the service user, or reinstall Claude Code, then restart the service",
  claudeAdd: "Add a Claude token in Settings → Add Claude",
  claudeRestart: "Restart the service",
  claudeVariable:
    "Set the variable in the service environment and restart the service, or clear the reference in Add Claude",
  claudeFile:
    "Make the token file a private regular file you own (mode 600), or clear the reference in Add Claude",
  codexPolicy:
    "Set Codex's approval policy to never and its sandbox mode to workspace-write, then restart the service",
  harness:
    "Restart the service, or edit the profile's model or reasoning effort",
  harnessSettings:
    "Run a Claude task; supported models are read before its first turn, then run the check again",
  unknown: "Run the check again, or restart the service",
  runtimeEnabled: "Enable a runtime in Settings → Runtime",
  runtimeBinary:
    "Install Codex or Claude Code into the fixed PATH, then turn it off and on in Settings → Runtime",
};

/** The fix for an enabled runtime whose executable is missing from the PATH. */
const notEnabledFixes: Record<ExecutionHarness, string> = {
  codex: fixes.codex,
  claude: fixes.claudeInstall,
};
const enableFix = (harness: ExecutionHarness) =>
  `Enable ${executionHarnessLabels[harness]} in Settings → Runtime`;

class TimedOut extends Error {}

/** Settles with the promise or rejects after `ms`; the timer never outlives the race. */
function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimedOut()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A release number such as `2.1.296`, possibly with a suffix; short enough to fit the label. */
const versionToken = /^\d{1,4}\.\d{1,4}\.\d{1,6}[0-9A-Za-z.+-]{0,32}$/;

/**
 * Nine read-only readiness checks. Nothing here writes, spawns a model turn or caches; each
 * `read()` runs fresh, and the only spawn is the bounded `claude --version` probe. Reasons and
 * fixes are literals, never a caught error or a path; the one dynamic string is the version
 * that probe printed, which is shown and never compared.
 */
export class Readiness {
  constructor(private readonly deps: ReadinessDeps) {}

  async read(): Promise<ReadinessResult> {
    const checks = await Promise.all(
      readinessCheckIds.map((id) => this.run(id)),
    );
    return readinessSchema.parse({
      data: { checks },
      observedAt: this.now(),
    });
  }

  /** The Claude token check alone, for the Add Claude panel. */
  async claudeToken(): Promise<ClaudeTokenCheckResult> {
    return claudeTokenCheckSchema.parse({
      data: await this.run("claude-token"),
      observedAt: this.now(),
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** One check; a throw or an invalid result degrades to that check's fixed failure. */
  private async run(id: ReadinessCheckId): Promise<ReadinessCheck> {
    try {
      return readinessCheckSchema.parse(await this.check(id));
    } catch {
      return outcome(id, "fail", "The check could not complete", fixes.unknown);
    }
  }

  private async check(id: ReadinessCheckId): Promise<ReadinessCheck> {
    switch (id) {
      case "runtime-enabled": {
        // A missing binary is a cause of not enabled too (CONTEXT.md, ADR-1012).
        const statuses = this.deps.harnessStatuses();
        if (
          statuses.some((s) => s.enabled && s.reason !== "executable-missing")
        )
          return pass(id);
        return statuses.some((s) => s.enabled)
          ? outcome(
              id,
              "fail",
              "No enabled runtime's binary is on the service PATH",
              fixes.runtimeBinary,
            )
          : outcome(
              id,
              "fail",
              "No execution runtime is enabled",
              fixes.runtimeEnabled,
            );
      }
      case "codex-executable":
        return (
          this.notEnabled(id, "codex") ??
          this.executable(id, "codex", fixes.codex)
        );
      case "git":
        return this.executable(id, "git", fixes.git);
      case "codex-login":
        return this.notEnabled(id, "codex") ?? this.codexLogin();
      case "github-discovery":
        return this.discovery();
      case "claude-executable":
        return (
          this.notEnabled(id, "claude") ??
          this.unavailableRuntime("claude", id) ??
          this.claudeExecutable()
        );
      case "claude-token":
        return this.notEnabled(id, "claude") ?? this.claudeTokenCheck();
      case "runtime-harness":
        return this.runtimeHarness();
      case "data-paths":
        return this.dataPaths();
    }
  }

  /**
   * A runtime's own checks report Not configured while the operator has it disabled, or while
   * its executable is not on the service PATH (ADR-1012); only an enabled runtime can fail.
   */
  private notEnabled(
    id: ReadinessCheckId,
    harness: ExecutionHarness,
  ): ReadinessCheck | undefined {
    const status = this.deps
      .harnessStatuses()
      .find((s) => s.harness === harness);
    if (status?.reason === "disabled")
      return outcome(
        id,
        "not-configured",
        "Disabled in Settings",
        enableFix(harness),
      );
    if (status?.reason === "executable-missing")
      return outcome(
        id,
        "not-configured",
        `\`${harness}\` not found on PATH`,
        notEnabledFixes[harness],
      );
    return undefined;
  }

  private async executable(
    id: "codex-executable" | "git",
    name: string,
    fix: string,
  ): Promise<ReadinessCheck> {
    if (await resolveOnPath(name, this.deps.env)) return pass(id);
    return id === "git"
      ? outcome(id, "fail", `${labels[id]} is not on the service PATH`, fix)
      : outcome(id, "not-configured", `\`${name}\` not found on PATH`, fix);
  }

  private restartOf(harness: ExecutionHarness) {
    return this.deps.harnessStatuses().find((s) => s.harness === harness)
      ?.restart;
  }

  /** A failed check when the runtime is running no longer, with the fix its restart state calls for. */
  private unavailableRuntime(harness: ExecutionHarness, id: ReadinessCheckId) {
    const status = this.deps
      .harnessStatuses()
      .find((s) => s.harness === harness);
    return status?.state === "unavailable"
      ? outcome(
          id,
          "fail",
          `The ${executionHarnessLabels[harness]} runtime is not running`,
          readinessFix(harness, status.restart),
        )
      : undefined;
  }

  private async codexLogin(): Promise<ReadinessCheck> {
    const id = "codex-login";
    let result: "verified" | "policy" | "failed" | "unavailable" | "timeout";
    try {
      result = await bounded(
        this.deps.codexLogin(),
        this.deps.timeoutMs ?? 10_000,
      );
    } catch (error) {
      result = error instanceof TimedOut ? "timeout" : "failed";
    }
    if (result === "verified") return pass(id);
    if (result === "policy")
      return outcome(
        id,
        "fail",
        "Codex's approval policy or sandbox mode is not the one Ensemble requires",
        fixes.codexPolicy,
      );
    const reason = {
      failed: "Codex is not signed in on the running service",
      unavailable: "The Codex runtime is not running",
      timeout: "Codex did not answer in time",
    }[result];
    return outcome(
      id,
      "fail",
      reason,
      result === "unavailable"
        ? readinessFix("codex", this.restartOf("codex"))
        : fixes.codexLogin,
    );
  }

  private async discovery(): Promise<ReadinessCheck> {
    const id = "github-discovery";
    let status: Discovery;
    try {
      status = await bounded(
        this.deps.discovery(),
        this.deps.timeoutMs ?? 10_000,
      );
    } catch {
      return outcome(
        id,
        "fail",
        "GitHub discovery could not be read",
        fixes.discovery,
      );
    }
    if (!status.configured)
      return outcome(
        id,
        "not-configured",
        "No GitHub discovery credential is configured",
        fixes.discovery,
      );
    return status.available
      ? pass(id)
      : outcome(
          id,
          "fail",
          "The GitHub discovery credential is not readable",
          fixes.discovery,
        );
  }

  /**
   * A missing `claude` is Not configured (ADR-1012); an active Claude profile fails the runtime
   * harness check instead. Found must mean runnable, but the version is only reported (ADR-1011).
   */
  private async claudeExecutable(): Promise<ReadinessCheck> {
    const id = "claude-executable";
    const path = await resolveOnPath("claude", this.deps.env);
    if (path === null)
      return outcome(
        id,
        "not-configured",
        "`claude` not found on PATH",
        fixes.claudeInstall,
      );
    const timeout = this.deps.versionTimeoutMs ?? 5000;
    let version: string | undefined;
    try {
      const stdout = await printVersion(
        path,
        this.deps.env.PATH ?? "",
        timeout,
      );
      const token = stdout.split("\n", 1)[0]?.trim().split(/\s+/, 1)[0];
      if (token !== undefined && versionToken.test(token)) version = token;
    } catch {
      // Falls through to the single unrunnable failure.
    }
    return version === undefined
      ? outcome(
          id,
          "fail",
          "Claude Code did not report a version",
          fixes.claudeVersion,
        )
      : { ...pass(id), label: `${labels[id]} (${version})` };
  }

  private claudeTokenCheck(): ReadinessCheck {
    const id = "claude-token";
    const reference = this.deps.claudeTokenReference();
    if (reference === null)
      return outcome(
        id,
        "not-configured",
        "No Claude token reference is configured",
        fixes.claudeAdd,
      );
    const { state } = this.deps.claudeTokenStatus();
    if (state === "available") return pass(id);
    const source = claudeTokenSource(reference);
    if (state === "restart-required")
      return outcome(
        id,
        "fail",
        source.kind === "env"
          ? "Restart the service to use this variable"
          : "Restart the service to use this token",
        fixes.claudeRestart,
      );
    if (source.kind === "env")
      return outcome(
        id,
        "fail",
        "Token variable is unavailable",
        fixes.claudeVariable,
      );
    const read = readClaudeToken(source, this.deps.env, this.deps.uid);
    return outcome(
      id,
      "fail",
      "problem" in read ? `Token file ${read.problem}` : "Token is unavailable",
      fixes.claudeFile,
    );
  }

  private runtimeHarness(): ReadinessCheck {
    const id = "runtime-harness";
    const used = this.deps.profiles().filter((p) => !p.revoked);
    if (used.length === 0)
      return outcome(
        id,
        "not-configured",
        "No active profile uses a runtime",
        "Add a profile in Settings",
      );
    const statuses = this.deps.harnessStatuses();
    const states = new Map(statuses.map((s) => [s.harness, s.state]));
    const reasons: string[] = [];
    let rejected = 0;
    let unknownSettings = false;
    // A runtime that failed, or a profile it rejects: only these call for a restart.
    let other = false;
    let notEnabledFix: string | undefined;
    let unavailableFix: string | undefined;
    for (const harness of new Set(used.map((p) => p.runtime.harness))) {
      const state = states.get(harness);
      if (state === "available") continue;
      const label = executionHarnessLabels[harness];
      if (state === "not-configured") {
        // Disabled is fixed in Settings; a missing executable by installing, not restarting.
        reasons.push(`${label} runtime is not enabled on this service`);
        notEnabledFix =
          statuses.find((s) => s.harness === harness)?.reason === "disabled"
            ? enableFix(harness)
            : notEnabledFixes[harness];
      } else {
        other = true;
        reasons.push(`${label} runtime is not running`);
        const restart = statuses.find((s) => s.harness === harness)?.restart;
        if (restart) unavailableFix ??= readinessFix(harness, restart);
      }
    }
    const settings =
      states.get("claude") === "available"
        ? this.deps.harnessSettings("claude")
        : null;
    for (const profile of used) {
      const { runtime } = profile;
      if (runtime.harness !== "claude" || states.get("claude") !== "available")
        continue;
      if (settings === null) {
        unknownSettings = true;
        continue;
      }
      const field = unsupportedRuntimeField(runtime, settings);
      if (field) {
        other = true;
        rejected++;
      }
    }
    // Names are operator-controlled text that the redaction boundary of the other reads
    // covers; readiness only counts, so no profile name can reach its output.
    if (rejected > 0)
      reasons.push(
        `${rejected} ${rejected === 1 ? "profile uses" : "profiles use"} a model or reasoning effort the runtime does not accept`,
      );
    if (unknownSettings)
      reasons.push("Claude's supported models are not known yet");
    if (reasons.length === 0) return pass(id);
    return outcome(
      id,
      "fail",
      reasons.join("; "),
      other
        ? unavailableFix
          ? rejected > 0
            ? `${unavailableFix}; or edit the profile's model or reasoning effort`
            : unavailableFix
          : fixes.harness
        : (notEnabledFix ??
            (unknownSettings ? fixes.harnessSettings : fixes.harness)),
    );
  }

  private async dataPaths(): Promise<ReadinessCheck> {
    const id = "data-paths";
    const { uid, dataDir, authFile } = this.deps;
    const broken: { reason: string; fix: string }[] = [];
    const rule = (reason: string, fix: string) => broken.push({ reason, fix });

    const canonical = async (path: string) => {
      try {
        await assertExistingCanonicalDirectoryPath(path, "Path");
        return true;
      } catch {
        return false;
      }
    };
    const state = async (path: string) => {
      try {
        return await lstat(path);
      } catch {
        return null;
      }
    };

    const data = (await canonical(dataDir)) ? await state(dataDir) : null;
    if (!data?.isDirectory())
      rule(
        "Data directory must be an absolute, canonical directory",
        "Set the data directory to a real directory without symlinks",
      );
    else {
      if (uid === undefined || data.uid !== uid)
        rule(
          "Data directory must be owned by the service user",
          "Give the data directory to the service user",
        );
      if ((data.mode & 0o077) !== 0)
        rule(
          "Data directory must not permit group or other access",
          "Run chmod 700 on the data directory",
        );
    }

    const auth =
      isAbsolute(authFile) && (await canonical(dirname(authFile)))
        ? await state(authFile)
        : null;
    if (!auth?.isFile())
      rule(
        "Operator auth file must be a regular file under a canonical directory",
        "Create the operator auth file with `npm run operator-auth`",
      );
    else {
      if (uid === undefined || auth.uid !== uid)
        rule(
          "Operator auth file must be owned by the service user",
          "Give the operator auth file to the service user",
        );
      if ((auth.mode & 0o777) !== 0o600)
        rule(
          "Operator auth file must have mode 600",
          "Run chmod 600 on the operator auth file",
        );
    }

    return broken.length === 0
      ? pass(id)
      : outcome(
          id,
          "fail",
          broken.map((b) => b.reason).join("; "),
          (broken[0] as { fix: string }).fix,
        );
  }
}

/** Readiness over a running service, reading what the service itself sees. */
export function serviceReadiness(
  service: StandaloneService,
  api: Pick<OperatorApi, "readDiscoveryStatus">,
  paths: { dataDir: string; authFile: string },
): Readiness {
  return new Readiness({
    env: process.env,
    uid: process.getuid?.(),
    ...paths,
    codexLogin: () => service.verifyCodexLogin(),
    discovery: async () => {
      // Only a `gh:` reference needs the `gh` probe; a stalled `gh` must not fail `env:`.
      const ref = service.domain().discoveryCredentialReference();
      if (ref?.startsWith("gh:")) return (await api.readDiscoveryStatus()).data;
      return {
        configured: ref !== null,
        available: ref !== null && Boolean(process.env[ref.slice(4)]),
      };
    },
    claudeTokenReference: () => service.domain().claudeTokenReference(),
    claudeTokenStatus: () => service.claudeTokenStatus(),
    harnessStatuses: () => service.harnessStatuses(),
    harnessSettings: (harness) => service.harnessSettings(harness),
    profiles: () =>
      service
        .domain()
        .profiles()
        .map((row) => ({
          revoked: Number(row.revoked) !== 0,
          runtime: service.domain().profileRuntime(String(row.id)),
        })),
  });
}
