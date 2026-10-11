import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attempt,
  authGate,
  baseOptions,
  captureProcessIdentity,
  createRecorder,
  delay,
  descendantIdentities,
  facet,
  loadSdk,
  readJson,
  resultText,
  runQuery,
  terminateExact,
  transcript,
  verifyExit,
  writeResult,
} from "./harness.mjs";

export const facetIds = ["F3.1", "F3.2", "F3.3", "F3.4"];
const PARENT = join(dirname(fileURLToPath(import.meta.url)), "p3-parent.mjs");
const OBSERVE_MS = 30_000;
const readText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** Classifies the agent's account of the cut-off command by fixed substrings. */
export function classifyReply(text) {
  if (
    /interrupt|cut off|did(n't| not) (finish|complete)|incomplete|killed|terminated|aborted|was stopped/i.test(
      text,
    )
  )
    return "knows-interrupted";
  if (/complet|succe|finished/i.test(text)) return "assumes-success";
  return "unaware";
}

async function waitFor(check, ms) {
  for (let waited = 0; waited < ms; waited += 100) {
    const value = check();
    if (value) return value;
    await delay(100);
  }
  return null;
}

/** Runs the parent, kills it at the trigger, observes orphans, then terminates survivors. */
async function crash(root, recorder, mode, counter, nonce) {
  const state = join(root, "traces", `p3-${mode}-state.json`);
  rmSync(state, { force: true });
  const child = spawn(process.execPath, [PARENT, root, mode, counter, nonce], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  const parentIdentity = await captureProcessIdentity(child.pid);
  const exited = new Promise((done) => child.once("exit", done));
  const triggered = await waitFor(() => {
    if (!existsSync(state)) return null;
    const value = readJson(state);
    if (!value.cliIdentity) return null;
    if (mode === "tool")
      return readText(counter).includes(`started:${nonce}`) && value;
    return value.streaming && value;
  }, 90_000);
  if (!triggered) {
    await terminateExact(
      parentIdentity,
      recorder,
      `p3-${mode}:parent-untriggered`,
    );
    await exited;
    return { triggered: false, parentIdentity };
  }
  const cli = triggered.cliIdentity;
  const tools = await descendantIdentities(Number(cli.processId));
  const killedAt = Date.now();
  const kill = await terminateExact(
    parentIdentity,
    recorder,
    `p3-${mode}:parent`,
    {
      signals: ["SIGKILL"],
    },
  );
  await exited;
  let cliExitMs = null;
  const toolAlive = {};
  for (let waited = 0; waited < OBSERVE_MS; waited += 250) {
    if (cliExitMs === null && (await verifyExit(cli)).kind === "verified")
      cliExitMs = Date.now() - killedAt;
    if (cliExitMs !== null && waited >= 2000) break;
    await delay(250);
  }
  for (const item of tools)
    toolAlive[item.command] =
      item.identity !== null &&
      (await verifyExit(item.identity)).kind !== "verified";
  const survivors = [];
  for (const [label, identity] of [
    ["cli", cli],
    ...tools.map((item) => [item.command, item.identity]),
  ])
    if (identity && (await verifyExit(identity)).kind !== "verified") {
      survivors.push(label);
      await terminateExact(identity, recorder, `p3-${mode}:survivor:${label}`);
    }
  return {
    triggered: true,
    sessionId: triggered.sessionId,
    parentKill: kill,
    cliExitMsAfterKill: cliExitMs,
    toolProcesses: tools.map((item) => item.command),
    toolAliveAfterObservation: toolAlive,
    survivorsTerminated: survivors,
    finishedWritten: readText(counter).includes(`finished:${nonce}`),
    identities: [
      parentIdentity,
      cli,
      ...tools.map((item) => item.identity),
    ].filter(Boolean),
  };
}

export async function run({ root, token }) {
  const { sdk } = await loadSdk(root);
  const recorder = createRecorder(root, "p3", token);
  const gate = authGate(root, token);
  const identities = [];
  const resume = (label, sessionId, prompt) =>
    runQuery({
      sdk,
      root,
      recorder,
      label,
      prompt,
      options: baseOptions(root, token, {
        tools: ["Bash"],
        allowedTools: ["Bash"],
        resume: sessionId,
      }),
      modelBacked: true,
    });

  let toolCrash = null;
  let followUp = null;
  const nonce = randomUUID().slice(0, 8);
  const counter = join(root, "workspace", `counter-${nonce}`);
  const f31 = await attempt("F3.1", true, gate, async () => {
    toolCrash = await crash(root, recorder, "tool", counter, nonce);
    identities.push(...(toolCrash.identities ?? []));
    if (!toolCrash.triggered)
      return facet(
        "F3.1",
        true,
        "untested",
        toolCrash,
        "tool never started before the parent exited",
      );
    const resumed = await resume(
      "p3-tool-resume",
      toolCrash.sessionId,
      "Reply with exactly: OK",
    );
    followUp = await resume(
      "p3-tool-follow-up",
      toolCrash.sessionId,
      "What happened to the earlier Bash command you ran? Answer in one sentence without running any tools.",
    );
    identities.push(
      ...[resumed, followUp].flatMap((item) =>
        item.procs.map((proc) => proc.identity),
      ),
    );
    // The orphaned CLI may finish the tool before the survivor window ends.
    const cutOff = !toolCrash.finishedWritten;
    const started = readText(counter)
      .split("\n")
      .filter((line) => line === `started:${nonce}`).length;
    const observation = {
      resumeSubtype: resumed.result?.subtype,
      resumeIsError: resumed.result?.is_error,
      resumeReason: resumed.result?.resume_reason ?? null,
      toolCutOffBeforeResume: cutOff,
      startedLines: started,
      finishedWrittenAfterResume: readText(counter).includes(
        `finished:${nonce}`,
      ),
    };
    if (!cutOff)
      return facet(
        "F3.1",
        true,
        "untested",
        observation,
        "the orphaned CLI finished the tool, so nothing was cut off",
      );
    if (resumed.result?.subtype !== "success")
      return facet(
        "F3.1",
        true,
        "untested",
        observation,
        "resume after the crash did not complete",
      );
    return facet(
      "F3.1",
      true,
      started === 1 ? "passed" : "failed",
      observation,
    );
  });

  let turnCrash = null;
  const f32 = await attempt("F3.2", true, gate, async () => {
    turnCrash = await crash(
      root,
      recorder,
      "turn",
      join(root, "workspace", "unused"),
      nonce,
    );
    identities.push(...(turnCrash.identities ?? []));
    if (!turnCrash.triggered)
      return facet(
        "F3.2",
        true,
        "untested",
        turnCrash,
        "no streaming output before the parent exited",
      );
    const resumed = await resume(
      "p3-turn-resume",
      turnCrash.sessionId,
      "Reply with exactly: OK",
    );
    identities.push(...resumed.procs.map((proc) => proc.identity));
    const observation = {
      subtype: resumed.result?.subtype,
      is_error: resumed.result?.is_error,
      thrown: resumed.error,
      sameSession: resumed.init?.session_id === turnCrash.sessionId,
      transcript: transcript(root, turnCrash.sessionId)?.records,
    };
    const ok =
      observation.subtype === "success" && observation.is_error === false;
    return facet("F3.2", true, ok ? "passed" : "failed", observation);
  });

  const f33 = facet(
    "F3.3",
    false,
    toolCrash?.triggered || turnCrash?.triggered ? "passed" : "untested",
    {
      tool: toolCrash && { ...toolCrash, identities: undefined },
      turn: turnCrash && { ...turnCrash, identities: undefined },
    },
    toolCrash?.triggered || turnCrash?.triggered
      ? undefined
      : (gate ?? "no crash was triggered"),
  );

  const reply = followUp ? resultText(followUp) : "";
  const f34 = facet(
    "F3.4",
    false,
    followUp?.result ? "passed" : "untested",
    followUp?.result && {
      transcript: transcript(root, toolCrash.sessionId)?.records,
      replyClass: classifyReply(reply),
      reply: reply.slice(0, 300),
    },
    followUp?.result ? undefined : (gate ?? "no follow-up turn completed"),
  );

  const facets = [f31, f32, f33, f34];
  writeResult(root, "p3", facets, { identities: identities.filter(Boolean) });
  return facets;
}
