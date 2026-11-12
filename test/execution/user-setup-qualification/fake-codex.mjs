#!/usr/bin/env node
// Model-free transport for the lifecycle driver's offline contract test.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  console.log("codex-cli offline-native-fixture");
  process.exit(0);
}
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const calls = new Map(),
  sleeps = new Map();
const terminal = (threadId, turnId, status = "completed") =>
  send({
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status } },
  });
const report = (threadId, turnId) => {
  const id = randomUUID();
  calls.set(id, [threadId, turnId]);
  setTimeout(
    () =>
      send({
        id,
        method: "item/tool/call",
        params: {
          threadId,
          turnId,
          callId: id,
          tool: "cab_report_result",
          arguments: { summary: "NATIVE_LIFECYCLE_DONE_1569" },
        },
      }),
    20,
  );
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (!m.method) {
    const call = calls.get(m.id);
    if (call) {
      calls.delete(m.id);
      terminal(...call);
    }
    return;
  }
  const p = m.params ?? {};
  if (m.method === "initialize") send({ id: m.id, result: {} });
  else if (m.method === "account/read")
    send({ id: m.id, result: { account: { type: "chatgpt" } } });
  else if (m.method === "config/read")
    send({
      id: m.id,
      result: {
        config: { approval_policy: "never", sandbox_mode: "workspace-write" },
      },
    });
  else if (m.method === "model/list")
    send({ id: m.id, result: { data: [], nextCursor: null } });
  else if (m.method === "thread/list")
    send({ id: m.id, result: { data: [], nextCursor: null } });
  else if (m.method === "thread/start" || m.method === "thread/resume")
    send({
      id: m.id,
      result: {
        thread: { id: p.threadId ?? randomUUID() },
        approvalPolicy: "never",
        sandbox: { type: "workspaceWrite" },
      },
    });
  else if (m.method === "turn/start") {
    const turnId = randomUUID(),
      threadId = p.threadId;
    send({ id: m.id, result: { turn: { id: turnId } } });
    const text = JSON.stringify(p.input);
    const seconds = /\/bin\/sleep (\d+)/.exec(text)?.[1];
    if (seconds) {
      const child = spawn("/bin/sleep", [seconds], { stdio: "ignore" });
      sleeps.set(turnId, child);
      // A sleep that ends by itself is followed by the result; an interrupted one is not.
      child.on("exit", (code) => {
        if (code !== 0 || sleeps.get(turnId) !== child) return;
        sleeps.delete(turnId);
        report(threadId, turnId);
      });
      send({
        method: "item/started",
        params: {
          threadId,
          turnId,
          item: {
            id: randomUUID(),
            type: "commandExecution",
            command: `/bin/sleep ${seconds}`,
            cwd: process.cwd(),
            status: "inProgress",
          },
        },
      });
    } else report(threadId, turnId);
  } else if (m.method === "turn/interrupt") {
    // Only a turn this process is running ends; another process's turn sends nothing.
    const running = sleeps.has(p.turnId);
    sleeps.get(p.turnId)?.kill("SIGTERM");
    sleeps.delete(p.turnId);
    send({ id: m.id, result: {} });
    if (running) terminal(p.threadId, p.turnId, "interrupted");
  } else if (m.id !== undefined) send({ id: m.id, result: {} });
});
process.on("SIGTERM", () => {
  for (const child of sleeps.values()) child.kill("SIGTERM");
  process.exit(0);
});
