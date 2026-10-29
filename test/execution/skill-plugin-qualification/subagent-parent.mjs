// Probe-owned "service" for q3-crash: runs one subagent query and records its
// CLI identity so the driver can SIGKILL this process mid-subagent. The state
// file name and shape follow claude-qualification/p3-parent.mjs, whose crash()
// driver consumes them.
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertCleanupRoot,
  createRecorder,
  loadSdk,
  loadToken,
  runQuery,
} from "../claude-qualification/harness.mjs";
import { newLog, policy } from "../claude-qualification/p5-policy.mjs";
import {
  sandboxFor,
  subagentOptions,
  subagentPrompt,
} from "./claude-probes.mjs";

const [root, mode, counter, nonce] = process.argv.slice(2);
assertCleanupRoot(root);
const token = loadToken();
const loaded = await loadSdk(root);
const state = join(root, "traces", `p3-${mode}-state.json`);
await runQuery({
  sdk: loaded.sdk,
  root,
  recorder: createRecorder(root, "q3-parent", token),
  label: "q3-parent",
  prompt: subagentPrompt(
    { root, workspace: join(root, "workspace") },
    { counter, nonce },
  ),
  options: policy(loaded, root, token, newLog(), {
    sandbox: sandboxFor(root),
    ...subagentOptions,
  }),
  modelBacked: true,
  onMessage: async (message, { run }) => {
    if (message.type === "system" && message.subtype === "init") {
      // Atomic so the driver never reads a partial file.
      writeFileSync(
        `${state}.tmp`,
        JSON.stringify({
          sessionId: message.session_id,
          cliIdentity: await run.procs[0].identity,
        }),
      );
      renameSync(`${state}.tmp`, state);
    }
  },
});
