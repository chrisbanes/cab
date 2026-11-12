#!/usr/bin/env node
// Scripted App Server for the offline harness contract. Each turn asks for approval of the
// last `node chromium.mjs <label>` in its prompt, after one unexpected permissions request on
// turn 1; it writes `<label>-result.json` only when accepted. Every client message is
// appended to the log file named by argv[2]. With argv[3] "failed-turns", every turn fails.
// A turn with reviewer `auto_review` is reviewed instead: approved, or with argv[3] "deny",
// denied until the client overrules it, then retried under a fresh review.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const logPath = process.argv[2];
const turnStatus = process.argv[3] === "failed-turns" ? "failed" : "completed";
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let turns = 0;
let active;
let denied;
function review(reviewId, status, { threadId, turnId, cwd, label }) {
  const base = {
    threadId,
    turnId,
    reviewId,
    targetItemId: `item-${reviewId}`,
    action: {
      type: "command",
      source: "shell",
      command: `/bin/zsh -lc 'node chromium.mjs ${label}'`,
      cwd,
    },
  };
  write({
    method: "item/autoApprovalReview/started",
    params: { ...base, startedAtMs: 1, review: { status: "inProgress" } },
  });
  write({
    method: "item/autoApprovalReview/completed",
    params: {
      ...base,
      startedAtMs: 1,
      completedAtMs: 2,
      decisionSource: "agent",
      review: { status, riskLevel: "low", rationale: "fake" },
    },
  });
  if (status !== "approved") return;
  writeFileSync(
    join(cwd, `${label}-result.json`),
    JSON.stringify({ chromium: "ok" }),
  );
  write({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: {
        type: "commandExecution",
        id: base.targetItemId,
        command: base.action.command,
        status: "completed",
        exitCode: 0,
        durationMs: 5,
      },
    },
  });
  write({
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status: turnStatus } },
  });
}
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  appendFileSync(logPath, `${line}\n`);
  if (message.method === undefined) {
    if (message.id === active?.requestId) {
      const accepted = message.result?.decision === "accept";
      if (accepted)
        writeFileSync(
          join(active.cwd, `${active.label}-result.json`),
          JSON.stringify({ chromium: "ok" }),
        );
      const { turnId, threadId, label } = active;
      write({
        method: "serverRequest/resolved",
        params: { threadId, requestId: active.requestId },
      });
      write({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "commandExecution",
            id: `item-${turns}`,
            command: `node chromium.mjs ${label}`,
            status: accepted ? "completed" : "declined",
          },
        },
      });
      write({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: turnStatus } },
      });
      active = undefined;
    }
    continue;
  }
  if (message.method === "thread/approveGuardianDeniedAction") {
    const own = denied && message.params.event?.id === denied.reviewId;
    write(
      own
        ? { id: message.id, result: {} }
        : {
            id: message.id,
            error: { code: -32600, message: "unknown review" },
          },
    );
    if (own) review("r2", "approved", denied.turn);
    denied = undefined;
  } else if (message.method === "initialize")
    write({ id: message.id, result: {} });
  else if (message.method === "account/read")
    write({ id: message.id, result: { account: { type: "chatgpt" } } });
  else if (message.method === "thread/start")
    write({
      id: message.id,
      result: {
        thread: { id: "thread-1" },
        model: "fake-model",
        approvalPolicy: "never",
      },
    });
  else if (message.method === "turn/start") {
    turns += 1;
    const { threadId, cwd } = message.params;
    const turnId = `turn-${turns}`;
    write({
      id: message.id,
      result: { turn: { id: turnId, status: "inProgress" } },
    });
    write({
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } },
    });
    const labels = [
      ...message.params.input[0].text.matchAll(/node chromium\.mjs ([a-z-]+)/g),
    ].map((m) => m[1]);
    if (labels.includes("control")) {
      writeFileSync(
        join(cwd, "control-result.json"),
        JSON.stringify({ chromium: "sandbox blocked launch" }),
      );
      write({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "commandExecution",
            id: `control-${turns}`,
            command: "node chromium.mjs control",
            status: "completed",
          },
        },
      });
    }
    if (turns === 1)
      write({
        id: "p1",
        method: "item/permissions/requestApproval",
        params: { threadId, turnId, itemId: "x" },
      });
    const label = labels.at(-1);
    if (message.params.approvalsReviewer === "auto_review") {
      const turn = { threadId, turnId, cwd, label };
      const deny = process.argv[3] === "deny";
      if (deny) denied = { reviewId: "r1", turn };
      review("r1", deny ? "denied" : "approved", turn);
      continue;
    }
    if (!label) {
      write({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: { type: "agentMessage", id: "m", text: "NO_PERMISSION_TOOL" },
        },
      });
      write({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: turnStatus } },
      });
      continue;
    }
    active = { requestId: `c${turns}`, turnId, threadId, cwd, label };
    write({
      id: active.requestId,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId,
        itemId: `item-${turns}`,
        command: `node chromium.mjs ${label}`,
        cwd,
        reason: "probe: needs host Chromium",
      },
    });
  }
}
