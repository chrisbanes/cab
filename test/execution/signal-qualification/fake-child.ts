import { createInterface } from "node:readline";
import { record } from "./trace.js";
const file = process.env.SIGNAL_TRACE;
if (!file) throw new Error("Missing owned trace");
let preempted = false;
record(file, "child-start", { ppid: process.ppid });
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
  if (m.id === undefined) continue;
  let result: unknown = {};
  if (m.method === "account/read") result = { account: { type: "chatgpt" } };
  if (m.method === "config/read")
    result = {
      config: { approval_policy: "never", sandbox_mode: "workspace-write" },
    };
  if (m.method === "model/list") result = { data: [] };
  if (m.method === "thread/start")
    result = {
      thread: { id: "signal-thread" },
      approvalPolicy: "never",
      sandbox: { type: "workspaceWrite" },
    };
  if (m.method === "turn/start") {
    result = { turn: { id: "signal-turn" } };
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
        turn: { id: "signal-turn", status: "failed" },
      },
    });
    continue;
  }
  write({ id: m.id, result });
}
