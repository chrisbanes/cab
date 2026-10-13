import { execFileSync } from "node:child_process";
import {
  attempt,
  authGate,
  baseOptions,
  createRecorder,
  descendants,
  facet,
  loadSdk,
  procSummary,
  runQuery,
  toolCalls,
  writeResult,
} from "./harness.mjs";

export const facetIds = ["F8.1", "F8.2", "F8.3", "F8.4"];
const SPAWN_KEYS = ["args", "command", "cwd", "env", "signal"];

const flagsOnly = (args) =>
  args.map((arg) => (arg.startsWith("-") ? arg : "<value>"));

export async function run({ root, token }) {
  const { sdk } = await loadSdk(root);
  const recorder = createRecorder(root, "p8", token);
  const gate = authGate(root, token);
  const ownGroup = Number(
    execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
      encoding: "utf8",
    }).trim(),
  );
  const atInit = new Map();
  const onMessage = async (message, { run }) => {
    if (message.type !== "system" || message.subtype !== "init") return;
    const proc = run.procs[0];
    if (!proc) return;
    atInit.set(run.label, {
      identityWhileAlive: (await proc.identity) !== null,
      idleDescendants: descendants(proc.pid).map((row) => row.command),
    });
  };
  const query = (label, prompt, options, modelBacked) =>
    runQuery({
      sdk,
      root,
      recorder,
      label,
      prompt,
      options,
      modelBacked,
      onMessage,
    });

  const runs = [];
  runs.push(
    await query(
      "p8-model-free",
      "Reply with exactly: OK",
      baseOptions(root, null),
      false,
    ),
  );
  let success = null;
  let large = null;
  if (!gate) {
    success = await query(
      "p8-success",
      "Reply with exactly: OK",
      baseOptions(root, token),
      true,
    );
    runs.push(success);
    large = await query(
      "p8-large",
      "Run this exact Bash command once and then reply DONE: head -c 1100000 /dev/zero | tr '\\0' a",
      baseOptions(root, token, { tools: ["Bash"], allowedTools: ["Bash"] }),
      true,
    );
    runs.push(large);
  }
  const procs = runs.flatMap((item) =>
    item.procs.map((proc) => ({ label: item.label, proc })),
  );

  const f81 = await attempt(
    "F8.1",
    true,
    procs.length ? null : "CLI never spawned",
    async () => {
      const observation = procs.map(({ label, proc }) => ({
        label,
        spawnOptionKeys: proc.optionKeys,
        pid: proc.pid,
        identityCaptured: proc.identity !== null,
        ...atInit.get(label),
        psCommandMatches: proc.ps?.command?.startsWith(proc.command) ?? false,
        processGroup:
          proc.ps?.pgid === ownGroup ? "harness group" : "own group",
      }));
      const ok = observation.every(
        (item) =>
          SPAWN_KEYS.every((key) => item.spawnOptionKeys.includes(key)) &&
          Number.isInteger(item.pid) &&
          item.pid > 0 &&
          item.identityCaptured &&
          item.psCommandMatches,
      );
      return facet("F8.1", true, ok ? "passed" : "failed", observation);
    },
  );

  const f82 = await attempt(
    "F8.2",
    true,
    procs.length ? null : "CLI never spawned",
    async () => {
      const observation = procs.map(({ label, proc }) => ({
        label,
        exit: proc.exitStatus,
        verification: proc.verification,
        killedByHarness: proc.killedByHarness === true,
      }));
      const ok = observation.every(
        (item) => item.verification === "verified" && !item.killedByHarness,
      );
      return facet("F8.2", true, ok ? "passed" : "failed", observation);
    },
  );

  const streams = runs.map((item) => ({
    label: item.label,
    procs: procSummary(item).map((proc) => ({
      stdout: proc.stdout,
      stderrBytes: proc.stderrBytes,
    })),
    stderrCallbackBytes: item.stderrCallbackBytes,
    resultSubtype: item.result?.subtype,
    isError: item.result?.is_error,
    largeToolResultChars:
      item === large
        ? toolCalls(item.messages).find((call) => call.name === "Bash")?.result
            ?.chars
        : undefined,
  }));
  const f83 = facet(
    "F8.3",
    false,
    large?.result ? "passed" : "untested",
    streams,
    large?.result ? undefined : (gate ?? "large-output turn did not complete"),
  );

  const first = procs[0]?.proc;
  const f84 = facet(
    "F8.4",
    false,
    first ? "passed" : "untested",
    first && {
      command: first.command,
      args: flagsOnly(first.args),
      envKeysByRun: procs.map(({ label, proc }) => ({
        label,
        keys: proc.envKeys,
      })),
      distinctArgsAcrossRuns: [
        ...new Set(procs.map(({ proc }) => flagsOnly(proc.args).join(" "))),
      ],
    },
    first ? undefined : "CLI never spawned",
  );

  const facets = [f81, f82, f83, f84];
  writeResult(root, "p8", facets, {
    identities: procs.map(({ proc }) => proc.identity).filter(Boolean),
  });
  return facets;
}
