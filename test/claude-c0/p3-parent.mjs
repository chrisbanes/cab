// Probe-owned "parent" for P3: runs one query() and records its CLI identity
// and session ID so the driver can kill this process mid-turn or mid-tool.
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertCleanupRoot,
  baseOptions,
  createRecorder,
  loadSdk,
  loadToken,
  runQuery,
} from "./harness.mjs";

const [root, mode, counter, nonce] = process.argv.slice(2);
assertCleanupRoot(root);
const token = loadToken();
const { sdk } = await loadSdk(root);
const state = join(root, "traces", `p3-${mode}-state.json`);
// Atomic so the driver never reads a partial file.
const save = (value) => {
  writeFileSync(`${state}.tmp`, JSON.stringify(value));
  renameSync(`${state}.tmp`, state);
};
const current = {};
const prompt =
  mode === "tool"
    ? `Run this exact Bash command once, then reply DONE: echo started:${nonce} >> ${counter}; sleep 60; echo finished:${nonce} >> ${counter}`
    : "Write a 500-word story about a lighthouse keeper.";
await runQuery({
  sdk,
  root,
  recorder: createRecorder(root, `p3-parent-${mode}`, token),
  label: `p3-parent-${mode}`,
  prompt,
  options: baseOptions(root, token, {
    tools: ["Bash"],
    allowedTools: ["Bash"],
    includePartialMessages: true,
  }),
  modelBacked: true,
  onMessage: async (message, { run }) => {
    if (message.type === "system" && message.subtype === "init") {
      Object.assign(current, {
        sessionId: message.session_id,
        cliIdentity: await run.procs[0].identity,
      });
      save(current);
    }
    if (message.type === "stream_event" && !current.streaming) {
      current.streaming = true;
      save(current);
    }
  },
});
