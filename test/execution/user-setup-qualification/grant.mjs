import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const PLAN =
  "https://github.com/chrisbanes/cab/issues/1569#issuecomment-6720804732";
export const TURN_MS = 4 * 60_000;

/** Initialization must never release a prompt before its turn is durably reserved. */
export function gatedInput(message) {
  let admitted = false;
  let closed = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    async *prompt() {
      await gate;
      if (admitted && !closed) yield message;
    },
    admit() {
      assert.ok(!closed, "Input already closed");
      admitted = true;
      release();
    },
    close() {
      closed = true;
      release();
    },
  };
}

export function readGrant(path) {
  const grant = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(grant.plan, PLAN);
  assert.ok([12, 13, 14].includes(grant.limit));
  if (grant.limit >= 13) {
    assert.equal(grant.allowanceRevision, "consolidated-2026-11-09");
    assert.deepEqual(grant.harnessLimits, {
      claude: grant.limit === 14 ? 8 : 7,
      codex: 6,
    });
    assert.deepEqual(grant.nativeAttemptLimits, { claude: 3, codex: 2 });
    assert.deepEqual(grant.nativeTurnLimits, { claude: 3, codex: 2 });
    assert.equal(grant.phaseWindows?.native?.durationMs, 15 * 60_000);
    assert.equal(grant.phaseWindows?.lifecycle?.durationMs, 30 * 60_000);
  }
  if (grant.limit === 14) {
    assert.equal(grant.claudeRecovery?.durationMs, 15 * 60_000);
    assert.equal(grant.claudeRecovery?.turnLimit, 3);
    assert.match(
      grant.claudeRecovery?.stopEvidenceDigest ?? "",
      /^[a-f0-9]{64}$/,
    );
    assert.deepEqual(grant.lifecycleAttemptLimits, { claude: 3, codex: 1 });
  } else assert.equal(grant.claudeRecovery, undefined);
  if (grant.lifecycleAttemptLimits !== undefined) {
    assert.deepEqual(grant.lifecycleAttemptLimits, {
      claude: grant.limit === 14 ? 3 : 2,
      codex: 1,
    });
  }
  assert.equal(grant.perHarness, 6);
  assert.ok(Array.isArray(grant.turns));
  assert.ok(Array.isArray(grant.attempts));
  assert.ok([1, 2].includes(grant.nativeAttemptsPerHarness ?? 1));
  return grant;
}

export function saveGrant(path, grant) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(grant, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(`${path}.tmp`, path);
}

export function phaseWindow(grant, harness, facet) {
  return harness === "claude" && facet === "lifecycle" && grant.claudeRecovery
    ? grant.claudeRecovery
    : grant.phaseWindows?.[facet];
}

function assertWindow(grant, harness, facet, now, requireStarted = false) {
  const phase = phaseWindow(grant, harness, facet);
  const started = phase
    ? phase.startedAt
    : (grant.liveWindowStartedAt ?? grant.startedAt);
  if (started === undefined) {
    assert.ok(!requireStarted, "Live allowance expired or not started");
    return;
  }
  assert.ok(
    Number.isSafeInteger(started) &&
      now < started + (phase?.durationMs ?? 45 * 60_000),
    "Live allowance expired",
  );
}

export function assertAttemptAvailable(
  grant,
  harness,
  facet,
  now = Date.now(),
) {
  assert.ok(["codex", "claude"].includes(harness));
  assert.ok(["native", "lifecycle"].includes(facet));
  assertWindow(grant, harness, facet, now);
  const limit =
    facet === "native"
      ? (grant.nativeAttemptLimits?.[harness] ??
        grant.nativeAttemptsPerHarness ??
        1)
      : (grant.lifecycleAttemptLimits?.[harness] ?? 1);
  assert.ok(
    grant.attempts.filter((a) => a.harness === harness && a.facet === facet)
      .length < limit,
    "Attempt already consumed",
  );
}

export function beginAttempt(path, harness, facet, now = Date.now()) {
  const grant = readGrant(path);
  assertAttemptAvailable(grant, harness, facet, now);
  grant.startedAt ??= now;
  const phase = phaseWindow(grant, harness, facet);
  if (phase) phase.startedAt ??= now;
  grant.attempts.push({
    harness,
    facet,
    startedAt: now,
    state: "active",
    firstTurnIndex: grant.turns.length,
  });
  saveGrant(path, grant);
}

export function reserveTurn(path, harness, facet, now = Date.now()) {
  const grant = readGrant(path);
  assertWindow(grant, harness, facet, now, true);
  assert.ok(
    grant.attempts.some(
      (a) => a.harness === harness && a.facet === facet && a.state === "active",
    ),
    "No active attempt",
  );
  assert.ok(grant.turns.length < grant.limit, "Total turn cap exhausted");
  assert.ok(
    grant.turns.filter((t) => t.harness === harness).length <
      (grant.harnessLimits?.[harness] ?? grant.perHarness),
    "Harness turn cap exhausted",
  );
  const recovery =
    harness === "claude" && facet === "lifecycle" && grant.claudeRecovery;
  if (recovery) {
    const attempt = grant.attempts.findLast(
      (a) => a.harness === harness && a.facet === facet && a.state === "active",
    );
    assert.ok(
      Number.isSafeInteger(attempt.firstTurnIndex) &&
        attempt.firstTurnIndex >= 0 &&
        attempt.firstTurnIndex <= grant.turns.length,
    );
    assert.ok(
      grant.turns.length - attempt.firstTurnIndex < recovery.turnLimit,
      "Recovery attempt turn cap exhausted",
    );
  }
  const facetLimit =
    facet === "native"
      ? (grant.nativeTurnLimits?.[harness] ?? 2)
      : recovery
        ? 5
        : 4;
  assert.ok(
    grant.turns.filter((t) => t.harness === harness && t.facet === facet)
      .length < facetLimit,
    "Facet turn cap exhausted",
  );
  grant.turns.push({ harness, facet, reservedAt: now });
  saveGrant(path, grant);
}
