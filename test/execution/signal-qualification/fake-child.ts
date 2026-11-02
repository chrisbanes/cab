import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { record } from "./trace.js";
const file = process.env.SIGNAL_TRACE;
if (!file) throw new Error("Missing owned trace");
let preempted = false;
// Opt-in per-process turn script ("complete,hold"): unique turn IDs; a held turn shows activity and never ends.
const script = process.env.SIGNAL_TURNS?.split(",");
let turns = 0;
let currentTurn = "signal-turn";
const ownGroup = Number(
  execFileSync("ps", ["-p", String(process.pid), "-o", "pgid="], {
    encoding: "utf8",
    timeout: 3000,
  }).trim(),
);
record(
  file,
  process.argv.includes("--version") || process.env.SIGNAL_PROBE
    ? "probe-start"
    : "child-start",
  {
    ppid: process.ppid,
    pgid: ownGroup,
    birth: execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim(),
    boot: execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
      encoding: "utf8",
    }).trim(),
  },
);
process.on("SIGINT", () => {
  record(file, "child-SIGINT");
  preempted = true;
  // A quiet interval deliberately precedes an observable effect and eventual exit.
  setTimeout(() => record(file, "delayed-effect"), 120);
  setTimeout(() => process.exit(130), 250);
});
process.on("SIGTERM", () => {
  record(file, "child-SIGTERM");
  process.exit(0);
});
process.on("exit", (code) => record(file, "child-exit", { code }));
const write = (message: unknown) =>
  process.stdout.write(`${JSON.stringify(message)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === "sdk-active") {
    record(file, "child-active");
    continue;
  }
  if (m.method === undefined) {
    if (script && typeof m.id === "number" && m.id >= 700) {
      record(file, "result-saved", m.result);
      write({
        method: "turn/completed",
        params: {
          threadId: "signal-thread",
          turn: { id: `script-turn-${m.id - 700}`, status: "completed" },
        },
      });
      continue;
    }
    if (m.id === 700) {
      record(file, "result-saved", m.result);
      write({
        method: "turn/completed",
        params: {
          threadId: "signal-thread",
          turn: { id: "signal-successor", status: "completed" },
        },
      });
    }
    continue;
  }
  if (m.id === undefined) continue;
  let result: unknown = {};
  if (m.method === "account/read") result = { account: { type: "chatgpt" } };
  if (m.method === "config/read")
    result = {
      config: { approval_policy: "never", sandbox_mode: "workspace-write" },
    };
  if (m.method === "model/list") result = { data: [] };
  if (m.method === "skills/list") result = { data: [] };
  if (m.method === "thread/list") result = { data: [], nextCursor: null };
  if (m.method === "thread/start" || m.method === "thread/resume")
    record(file, "conversation-open", {
      method: m.method,
      threadId: m.params.threadId ?? "signal-thread",
    });
  if (m.method === "thread/start" || m.method === "thread/resume")
    result = {
      thread: { id: "signal-thread" },
      approvalPolicy: "never",
      sandbox: { type: "workspaceWrite" },
    };
  if (m.method === "turn/start" && script) {
    const n = turns++;
    currentTurn = `script-turn-${n}`;
    const mode = script[n] ?? "complete";
    write({ id: m.id, result: { turn: { id: currentTurn } } });
    record(file, "child-active", { turn: currentTurn, mode });
    const turnId = currentTurn;
    setTimeout(
      () =>
        write(
          mode === "hold"
            ? {
                method: "item/started",
                params: {
                  threadId: "signal-thread",
                  turnId,
                  item: { id: `script-item-${n}`, type: "agentMessage" },
                },
              }
            : {
                id: 700 + n,
                method: "item/tool/call",
                params: {
                  threadId: "signal-thread",
                  turnId,
                  callId: `script-result-${n}`,
                  tool: "cab_report_result",
                  arguments: { summary: "Offline scripted turn settled" },
                },
              },
        ),
      30,
    );
    continue;
  }
  if (m.method === "turn/start") {
    result = {
      turn: {
        id:
          process.env.SIGNAL_RESUME === "1"
            ? "signal-successor"
            : "signal-turn",
      },
    };
    record(file, "child-active");
  }
  if (m.method === "turn/interrupt") {
    record(file, "child-protocol-interrupt");
    if (preempted || process.env.SIGNAL_SILENT === "1") continue;
    record(file, "child-ack");
    write({ id: m.id, result: {} });
    record(file, "child-terminal");
    write({
      method: "turn/completed",
      params: {
        threadId: "signal-thread",
        turn: { id: currentTurn, status: "failed" },
      },
    });
    continue;
  }
  write({ id: m.id, result });
  if (m.method === "turn/start" && process.env.SIGNAL_RESUME === "1")
    setTimeout(
      () =>
        write({
          id: 700,
          method: "item/tool/call",
          params: {
            threadId: "signal-thread",
            turnId: "signal-successor",
            callId: "successor-result",
            tool: "cab_report_result",
            arguments: { summary: "Offline successor settled" },
          },
        }),
      30,
    );
}
