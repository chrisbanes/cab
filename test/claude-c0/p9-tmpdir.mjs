// #825 T1: bounded live proof of how the sandbox TMPDIR (/tmp/claude-<uid>) is
// handled (redirect or deny), plus the model-free gated-prompt facet.
// Evidence: docs/evidence/issue-825-claude-tmpdir-proof-*.md.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  attempt,
  BudgetExhausted,
  baseOptions,
  createRecorder,
  delay,
  facet,
  loadSdk,
  queryCount,
  runQuery,
  spawnWrapper,
  terminateExact,
  toolCalls,
  verifyExit,
  writeResult,
} from "./harness.mjs";

export const facetIds = ["F9.0", "F9.1", "F9.2", "F9.3"];
export const P9_QUERY_CAP = 12;
export const FACET_ATTEMPTS = 3;
const SETTLE_MS = 30_000;

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** Judges one TMPDIR facet from what the sandboxed commands left on disk. */
export function judge(id, o) {
  if (!o.ran) return ["untested", "the model did not run every command"];
  if (id === "F9.3")
    return [
      o.insideWritten &&
      o.insideResultClean &&
      o.reportedIsShared &&
      o.tmpdirWriteLanded &&
      o.sharedWriteLanded
        ? "passed"
        : "failed",
    ];
  if (id === "F9.1")
    return [
      o.insideWritten &&
      o.insideResultClean &&
      o.reportedIsTaskRoot &&
      o.tmpdirWriteLanded &&
      !o.sharedWriteLanded
        ? "passed"
        : "failed",
    ];
  return [
    o.insideWritten &&
    o.insideResultClean &&
    o.reportedIsShared &&
    !o.tmpdirWriteLanded &&
    !o.sharedWriteLanded
      ? "passed"
      : "failed",
  ];
}

/** R passes first, then D, else the disclosed shared write root (only once both were tried). */
export function selectOutcome(facets) {
  const by = (id) => facets.find((item) => item.id === id)?.disposition;
  if (by("F9.1") === "passed") return "redirect";
  if (by("F9.2") === "passed") return "deny";
  return by("F9.1") === "failed" && by("F9.2") === "failed"
    ? "shared"
    : "undetermined";
}

/** F9.0: no model call; the gate is never released. */
async function modelFree({ sdk, root, token, recorder }) {
  const wrapper = spawnWrapper(recorder);
  const controller = new AbortController();
  const gate = new Promise((release) =>
    controller.signal.addEventListener("abort", release),
  );
  const seen = { yielded: 0, procsAtFirstPull: null, messages: 0 };
  // An iterable that yields nothing: its first pull records the spawn state, then waits for abort.
  const prompt = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        seen.procsAtFirstPull ??= wrapper.procs.length;
        await gate;
        return { done: true, value: undefined };
      },
    }),
  };
  let drainError = null;
  const q = sdk.query({
    prompt,
    options: {
      ...baseOptions(root, token),
      abortController: controller,
      spawnClaudeCodeProcess: wrapper.spawnClaudeCodeProcess,
      stderr: () => {},
    },
  });
  const drain = (async () => {
    try {
      for await (const _ of q) seen.messages++;
    } catch (error) {
      drainError = String(error?.message ?? error).slice(0, 200);
    }
  })();
  const bounded = (promise) =>
    Promise.race([
      promise.then(
        (value) => ({ value }),
        (error) => ({ error: String(error?.message ?? error).slice(0, 200) }),
      ),
      delay(SETTLE_MS).then(() => ({ error: "timed out" })),
    ]);
  const models = await bounded(q.supportedModels());
  const init = await bounded(q.initializationResult());
  const proc = wrapper.procs[0];
  const identity = proc ? await proc.identity : null;
  const aliveBeforeAbort = identity
    ? (await verifyExit(identity)).kind !== "verified"
    : false;
  const abortedAt = Date.now();
  controller.abort();
  const exit = proc
    ? await Promise.race([proc.exit, delay(15_000).then(() => null)])
    : null;
  if (proc && !exit) await terminateExact(identity, recorder, "p9-f90");
  const settledMs = Date.now() - abortedAt;
  await Promise.race([drain, delay(10_000)]);
  const verification = identity ? (await verifyExit(identity)).kind : "unknown";
  const list = models.value ?? [];
  const observation = {
    procsAtFirstPull: seen.procsAtFirstPull,
    promptsYielded: seen.yielded,
    messagesBeforeAbort: seen.messages,
    identityCaptured: identity !== null,
    cliAliveBeforeAbort: aliveBeforeAbort,
    supportedModelsError: models.error ?? null,
    models: list.map((model) => ({
      value: model.value,
      resolvedModel: model.resolvedModel,
      supportsEffort: model.supportsEffort,
      supportedEffortLevels: model.supportedEffortLevels,
    })),
    initError: init.error ?? null,
    initClaudeCodeVersion: init.value?.claude_code_version ?? null,
    abortSettledMs: settledMs,
    cliExit: exit,
    killedByHarness: proc ? !exit : false,
    exitVerification: verification,
    drainError,
    modelBackedQueries: 0,
  };
  const ok =
    identity !== null &&
    seen.yielded === 0 &&
    list.length > 0 &&
    typeof observation.initClaudeCodeVersion === "string" &&
    verification === "verified" &&
    exit !== null;
  recorder.record("f90", observation);
  return {
    result: facet("F9.0", false, ok ? "passed" : "failed", observation),
    identities: identity ? [identity] : [],
  };
}

export async function run({ root, token }) {
  // Claude Code falls back to /tmp/claude-<uid> when <CLAUDE_CODE_TMPDIR>/claude-<uid> exceeds 44 bytes,
  // so a per-task base must be short. The probe's own nonce-named directory is removed at the end.
  const taskBase = `/tmp/ens-${randomUUID().slice(0, 8)}`;
  mkdirSync(taskBase, { mode: 0o700 });
  try {
    return await probe({ root, token, taskBase });
  } finally {
    if (/^\/tmp\/ens-[0-9a-f]{8}$/.test(taskBase))
      rmSync(taskBase, { recursive: true, force: true });
  }
}

async function probe({ root, token, taskBase }) {
  const { sdk } = await loadSdk(root);
  const recorder = createRecorder(root, "p9", token);
  const identities = [];
  const workspace = join(root, "workspace");
  const uid = process.getuid();
  const taskRoot = join(taskBase, `claude-${uid}`);
  const shared = `/tmp/claude-${uid}`;
  let authFailed = null;

  const f90 = token
    ? await modelFree({ sdk, root, token, recorder })
    : { result: null, identities: [] };
  identities.push(...f90.identities);

  const configs = {
    "F9.3": { env: {}, allowWrite: [workspace], denyWrite: [] },
    "F9.1": {
      env: { CLAUDE_CODE_TMPDIR: taskBase },
      allowWrite: [workspace, taskBase],
      denyWrite: [],
    },
    "F9.2": { env: {}, allowWrite: [workspace], denyWrite: [shared] },
  };

  const once = async (id, number) => {
    if (queryCount(root) >= P9_QUERY_CAP) throw new BudgetExhausted(id);
    const config = configs[id];
    const nonce = randomUUID().slice(0, 8);
    const name = `p9-${nonce}`;
    const files = {
      inside: join(workspace, `${name}-inside.txt`),
      tmpdir: `${name}-tmpdir.txt`,
      shared: join(shared, `${name}-shared.txt`),
    };
    const options = baseOptions(root, token, {
      tools: ["Bash"],
      allowedTools: ["Bash"],
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: true,
        network: { allowedDomains: [] },
        filesystem: {
          allowWrite: config.allowWrite,
          ...(config.denyWrite.length ? { denyWrite: config.denyWrite } : {}),
        },
      },
    });
    options.env = { ...options.env, ...config.env };
    const label = `p9-${id}-${number}`;
    const result = await runQuery({
      sdk,
      root,
      recorder,
      label,
      prompt:
        "Run each of these Bash commands as a separate Bash call, in order, and report each output. Do not use any other tool.\n" +
        `1) echo inside > ${files.inside}\n` +
        `2) echo "tmpdir=$TMPDIR"; echo x > "$TMPDIR/${files.tmpdir}"; echo "write-exit=$?"\n` +
        `3) echo x > ${files.shared}; echo "write-exit=$?"\n` +
        "Then reply DONE.",
      options,
      modelBacked: true,
    });
    identities.push(
      ...result.procs.map((proc) => proc.identity).filter(Boolean),
    );
    const bash = toolCalls(result.messages).filter(
      (call) => call.name === "Bash",
    );
    const output = (needle) =>
      bash.find((call) => String(call.input?.command).includes(needle))?.result;
    const tmpdirOutput = output(files.tmpdir);
    const reported = /tmpdir=(\/\S+)/.exec(tmpdirOutput?.text ?? "")?.[1];
    const tmpdirFile = reported && join(reported, files.tmpdir);
    const observation = {
      attempt: number,
      subtype: result.result?.subtype,
      is_error: result.result?.is_error,
      reportedTmpdir: reported ?? null,
      insideWritten: existsSync(files.inside),
      insideResultClean: output(files.inside)?.isError === false,
      reportedIsShared: reported ? real(reported) === real(shared) : false,
      reportedIsTaskRoot: reported ? real(reported) === real(taskRoot) : false,
      tmpdirWriteLanded: tmpdirFile ? existsSync(tmpdirFile) : false,
      sharedWriteLanded: existsSync(files.shared),
      results: {
        inside: output(files.inside),
        tmpdir: tmpdirOutput,
        shared: output(files.shared),
      },
      bashCalls: bash.length,
      ran: Boolean(output(files.inside) && tmpdirOutput && reported),
    };
    // Delete only this attempt's own nonce files, at exact paths.
    for (const path of [files.inside, files.shared, tmpdirFile])
      if (path) rmSync(path, { force: true });
    if (result.result?.is_error && bash.length === 0)
      authFailed = `query failed before any command: ${result.result.subtype}`;
    return observation;
  };

  const run = (id) =>
    attempt(id, false, authFailed ?? (token ? null : "no token"), async () => {
      const tried = [];
      for (let number = 1; number <= FACET_ATTEMPTS; number++) {
        const observation = await once(id, number);
        const [disposition, reason] = judge(id, observation);
        tried.push(observation);
        if (authFailed)
          return facet(id, false, "untested", { tried }, authFailed);
        if (disposition !== "untested")
          return facet(id, false, disposition, { ...observation, tried });
        if (number === FACET_ATTEMPTS)
          return facet(id, false, "untested", { tried }, reason);
      }
    });

  const f93 = await run("F9.3");
  // Redirect and deny need the positive control: Bash runs and the shared dir is writable.
  const controlReady = f93.disposition === "passed";
  const f91 = controlReady
    ? await run("F9.1")
    : facet("F9.1", false, "untested", null, "control did not pass");
  const f92 = controlReady
    ? await run("F9.2")
    : facet("F9.2", false, "untested", null, "control did not pass");
  const facets = [
    f90.result ??
      facet("F9.0", false, "untested", null, "no subscription token"),
    f91,
    f92,
    f93,
  ];
  const outcome = selectOutcome(facets);
  writeResult(root, "p9", facets, {
    identities,
    outcome,
    modelBackedQueries: queryCount(root),
  });
  console.log(
    `p9 outcome: ${outcome}; model-backed queries ${queryCount(root)}`,
  );
  return facets;
}
