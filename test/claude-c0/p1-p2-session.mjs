import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  abortOutcome,
  abortPassed,
  attempt,
  authGate,
  baseOptions,
  createRecorder,
  delay,
  descendantIdentities,
  facet,
  loadSdk,
  resultText,
  runQuery,
  terminateExact,
  toolCalls,
  transcript,
  verifyExit,
  writeResult,
} from "./harness.mjs";

export const facetIds = [
  "F1.1",
  "F1.2",
  "F1.3",
  "F1.4",
  "F2.1",
  "F2.2",
  "F2.3",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASH = { tools: ["Bash"], allowedTools: ["Bash"] };

const readText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

export async function run({ root, token }) {
  const { sdk } = await loadSdk(root);
  const recorder = createRecorder(root, "p1", token);
  const gate = authGate(root, token);
  const identities = [];
  const query = async (label, prompt, extra = {}, onMessage) => {
    const result = await runQuery({
      sdk,
      root,
      recorder,
      label,
      prompt,
      options: baseOptions(root, token, extra),
      modelBacked: true,
      onMessage,
    });
    identities.push(
      ...result.procs.map((proc) => proc.identity).filter(Boolean),
    );
    return result;
  };
  const nonce = (label) => `${label}-${randomUUID().slice(0, 8).toUpperCase()}`;

  let first = null;
  const word1 = nonce("WORD");
  const f11 = await attempt("F1.1", true, gate, async () => {
    first = await query(
      "p1-start",
      `Remember the code word ${word1}. Reply with exactly: OK`,
    );
    const observation = {
      initSessionId: first.init?.session_id,
      resultSessionId: first.result?.session_id,
      isUuid: UUID.test(first.init?.session_id ?? ""),
    };
    const ok =
      observation.isUuid &&
      observation.initSessionId === observation.resultSessionId;
    return facet("F1.1", true, ok ? "passed" : "failed", observation);
  });

  const f12 = await attempt(
    "F1.2",
    true,
    gate ?? (first?.init ? null : "F1.1 produced no session"),
    async () => {
      const sessionId = first.init.session_id;
      const resumed = await query(
        "p1-resume",
        "What code word did I ask you to remember? Reply with only the code word.",
        { resume: sessionId },
      );
      const observation = {
        recalled: resultText(resumed).includes(word1),
        initSessionIdSame: resumed.init?.session_id === sessionId,
        resultSessionIdSame: resumed.result?.session_id === sessionId,
        separateProcess: resumed.procs[0]?.pid !== first.procs[0]?.pid,
      };
      const ok =
        observation.recalled &&
        observation.initSessionIdSame &&
        observation.resultSessionIdSame;
      return facet("F1.2", true, ok ? "passed" : "failed", observation);
    },
  );

  const f13 = await attempt("F1.3", false, gate, async () => {
    const minted = randomUUID();
    const word = nonce("MINT");
    const start = await query(
      "p1-minted",
      `Remember the code word ${word}. Reply with exactly: OK`,
      {
        sessionId: minted,
      },
    );
    const resumed = await query(
      "p1-minted-resume",
      "What code word did I ask you to remember? Reply with only the code word.",
      { resume: minted },
    );
    const observation = {
      accepted:
        start.result?.subtype === "success" && start.result.is_error === false,
      initSessionIdIsMinted: start.init?.session_id === minted,
      resumedSessionIdIsMinted: resumed.init?.session_id === minted,
      recalled: resultText(resumed).includes(word),
    };
    return facet(
      "F1.3",
      false,
      Object.values(observation).every(Boolean) ? "passed" : "failed",
      observation,
    );
  });

  const f14 = await attempt("F1.4", false, gate, async () => {
    const unknown = await query("p1-unknown", "Reply with exactly: OK", {
      resume: randomUUID(),
    });
    return facet("F1.4", false, "passed", {
      thrown: unknown.error,
      result: unknown.result && {
        subtype: unknown.result.subtype,
        is_error: unknown.result.is_error,
        terminal_reason: unknown.result.terminal_reason,
        errors: unknown.result.errors,
      },
      initEmitted: unknown.init !== undefined,
      cliExit: unknown.procs[0]?.exitStatus,
    });
  });

  const f21 = await attempt("F2.1", true, gate, async () => {
    const aborted = await query(
      "p2-abort-turn",
      "Write a 500-word story about a lighthouse keeper.",
      { includePartialMessages: true },
      (message, { abortController }) => {
        if (
          !abortController.signal.aborted &&
          (message.type === "stream_event" || message.type === "assistant")
        )
          abortController.abort();
      },
    );
    const outcome = abortOutcome(aborted);
    const sessionId = aborted.init?.session_id;
    const observation = {
      ...outcome,
      transcript: sessionId ? transcript(root, sessionId)?.records : null,
    };
    if (outcome.abortedAt !== "yes")
      return facet(
        "F2.1",
        true,
        "untested",
        observation,
        "turn ended before the abort trigger",
      );
    return facet(
      "F2.1",
      true,
      abortPassed(outcome) ? "passed" : "failed",
      observation,
    );
  });

  let toolSession = null;
  const f22 = await attempt("F2.2", true, gate, async () => {
    const marker = join(root, "workspace", `m-${randomUUID().slice(0, 8)}`);
    let tool = [];
    let poll;
    const aborted = await query(
      "p2-abort-tool",
      `Run this exact Bash command once, then reply DONE: echo started >> ${marker}; sleep 12; echo finished >> ${marker}`,
      BASH,
      (message, { abortController, run }) => {
        const usesBash = toolCalls([message]).some(
          (call) => call.name === "Bash",
        );
        if (!usesBash || poll) return;
        poll = setInterval(async () => {
          if (
            abortController.signal.aborted ||
            !readText(marker).includes("started")
          )
            return;
          clearInterval(poll);
          tool = await descendantIdentities(run.procs[0].pid);
          abortController.abort();
        }, 100);
      },
    );
    clearInterval(poll);
    toolSession = aborted.init?.session_id;
    const outcome = abortOutcome(aborted);
    const survivorsAtSettle = [];
    for (const item of tool)
      if (
        item.identity &&
        (await verifyExit(item.identity)).kind !== "verified"
      )
        survivorsAtSettle.push(item.command);
    let finishedWithin15s = false;
    for (let waited = 0; waited < 15_000 && !finishedWithin15s; waited += 500) {
      finishedWithin15s = readText(marker).includes("finished");
      if (!finishedWithin15s) await delay(500);
    }
    const terminated = [];
    for (const item of tool)
      if (
        item.identity &&
        (await verifyExit(item.identity)).kind !== "verified"
      ) {
        terminated.push(item.command);
        await terminateExact(item.identity, recorder, "p2-abort-tool:survivor");
      }
    identities.push(...tool.map((item) => item.identity).filter(Boolean));
    const observation = {
      ...outcome,
      toolProcessesBeforeAbort: tool.map((item) => item.command),
      survivorsAtSettle,
      finishedWithin15s,
      survivorsTerminatedByHarness: terminated,
      transcript: toolSession ? transcript(root, toolSession)?.records : null,
    };
    if (outcome.abortedAt !== "yes")
      return facet(
        "F2.2",
        true,
        "untested",
        observation,
        "tool never wrote started before the turn ended",
      );
    return facet(
      "F2.2",
      true,
      abortPassed(outcome) ? "passed" : "failed",
      observation,
    );
  });

  const f23 = await attempt(
    "F2.3",
    false,
    gate ?? (toolSession ? null : "no aborted session to resume"),
    async () => {
      const resumed = await query(
        "p2-resume-after-abort",
        "Reply with exactly: OK",
        {
          resume: toolSession,
        },
      );
      const observation = {
        subtype: resumed.result?.subtype,
        is_error: resumed.result?.is_error,
        sameSession: resumed.init?.session_id === toolSession,
        transcript: transcript(root, toolSession)?.records,
      };
      const ok =
        observation.subtype === "success" && observation.is_error === false;
      return facet("F2.3", false, ok ? "passed" : "failed", observation);
    },
  );

  const facets = [f11, f12, f13, f14, f21, f22, f23];
  writeResult(root, "p1", facets, { identities });
  return facets;
}
