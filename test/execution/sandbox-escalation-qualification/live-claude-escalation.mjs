// One bounded live run of both Claude escalate levels through the real service (#1682 T4):
//   approval: a task at escalate-approval runs a sandboxed Chromium control, then the same
//             command flagged, which the operator approves through the operator API, then a
//             flagged `declined` launch, which the operator declines;
//   review:   a task at escalate-auto-review runs a control, then the flagged command, which
//             Claude's classifier decides. A call it leaves undecided is approved in the Inbox.
// One turn per task. It observes the real SDK query (hook, canUseTool and stream records by
// tool_use_id, never command output) and cab's stored escalations and reviews, prints sanitised
// evidence JSON and removes its fixture. Claude runs on the service user's native Claude Code
// login: the harness reads no secret.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, homedir, release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--live" || args[1] !== "--one-attempt") {
  process.stderr.write(
    "Refusing live execution without exactly --live --one-attempt.\n",
  );
  process.exit(2);
}
const refuse = (reason) => {
  process.stderr.write(`Refusing Claude escalation live run: ${reason}.\n`);
  process.exit(2);
};
// The repository this harness belongs to, whatever directory it was started from.
const repository = fileURLToPath(new URL("../../..", import.meta.url));
const git = (...argv) =>
  execFileSync("git", argv, { encoding: "utf8", cwd: repository }).trim();
// Evidence names its candidate SHA, so it must run from exactly that tree.
if (git("status", "--porcelain") !== "")
  refuse("the checkout has uncommitted changes");
const pin = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
).dependencies["@anthropic-ai/claude-agent-sdk"];
const sdkVersion = JSON.parse(
  readFileSync(
    new URL(
      "../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json",
      import.meta.url,
    ),
    "utf8",
  ),
).version;
if (sdkVersion !== pin)
  refuse(`the installed Claude Agent SDK is not the ${pin} pin`);
let claudeVersion;
try {
  claudeVersion = execFileSync("claude", ["--version"], {
    encoding: "utf8",
  }).trim();
} catch {
  refuse("claude is not on the PATH");
}
// Launching once on the host shows the stimulus works outside any sandbox.
const { chromium } = await import("playwright");
await chromium
  .launch({ headless: true, timeout: 60_000 })
  .then((browser) => browser.close())
  .catch(() => refuse("Playwright's headless Chromium does not launch"));

const { ClaudeRuntime, releaseClaudeTemporaryBase } = await import(
  "../../../dist/src/standalone/claude.js"
);
const { OperatorApi } = await import(
  "../../../dist/src/standalone/operator-api.js"
);
const { StandaloneService } = await import(
  "../../../dist/src/standalone/service.js"
);
const claudeSdk = await import("@anthropic-ai/claude-agent-sdk");
const { chromiumScript } = await import("./chromium-script.mjs");
const { classifyRun, labelOf, requiredCells } = await import(
  "./claude-escalation-outcomes.mjs"
);

const stage = (name) =>
  process.stderr.write(`[claude-escalation-live] ${name}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = performance.now();
const now = () => Math.round(performance.now() - started);
const short = (value, size = 200) =>
  typeof value === "string" ? value.slice(0, size) : null;
const suffix = randomUUID().slice(0, 8);
const markers = {
  approval: `claude-escalation-approval-${suffix}`,
  review: `claude-escalation-review-${suffix}`,
};
const blank = () => ({
  turnId: null,
  admittedLevel: null,
  init: null,
  result: null,
  intentState: null,
  events: [],
  results: {},
  escalations: [],
  reviews: [],
  taskRead: null,
  unexpected: [],
  refusedTurns: 0,
});
const cells = { approval: blank(), review: blank() };
let cell = "approval";

/** The real turn query, observed: hooks, canUseTool and stream messages by tool_use_id. */
function observe(options) {
  const label = cell;
  // Returns the stored record, so a later field (a hook's decision) lands on it, not a copy.
  const push = (event) => {
    const stored = { t: now(), ...event };
    cells[label].events.push(stored);
    return stored;
  };
  const pre = options.hooks.PreToolUse[0];
  const preHook = pre.hooks[0];
  pre.hooks = [
    async (input, id, context) => {
      const flag = input.tool_input?.dangerouslyDisableSandbox;
      const event = push({
        kind: "pre",
        toolUseId: input.tool_use_id,
        tool: input.tool_name,
        command: short(input.tool_input?.command),
        flagged: flag !== undefined && flag !== false,
      });
      const output = await preHook(input, id, context);
      event.decision = output?.hookSpecificOutput?.permissionDecision ?? "pass";
      event.returnedAt = now();
      return output;
    },
  ];
  for (const name of ["PostToolUse", "PostToolUseFailure"]) {
    const matcher = options.hooks[name][0];
    const hook = matcher.hooks[0];
    matcher.hooks = [
      async (input, id, context) => {
        push({
          kind: "post",
          event: input.hook_event_name,
          toolUseId: input.tool_use_id,
        });
        return hook(input, id, context);
      },
    ];
  }
  const canUseTool = options.canUseTool;
  options.canUseTool = async (tool, input, context) => {
    const id = context.toolUseID;
    push({ kind: "ask", toolUseId: id, tool, command: short(input?.command) });
    // A cancellation counts only while the ask is unanswered.
    const aborted = () => push({ kind: "askAborted", toolUseId: id });
    if (context.signal?.aborted) aborted();
    else context.signal?.addEventListener("abort", aborted, { once: true });
    try {
      const answer = await canUseTool(tool, input, context);
      push({ kind: "askResult", toolUseId: id, behavior: answer.behavior });
      return answer;
    } finally {
      context.signal?.removeEventListener("abort", aborted);
    }
  };
  return (message) => {
    if (message.type === "system" && message.subtype === "init")
      cells[label].init = { permissionMode: message.permissionMode ?? null };
    else if (
      message.type === "system" &&
      message.subtype === "permission_denied"
    )
      push({
        kind: "denied",
        toolUseId: message.tool_use_id,
        reasonType: message.decision_reason_type ?? null,
      });
    else if (message.type === "system")
      push({ kind: "system", subtype: message.subtype ?? null });
    else if (message.type === "result")
      cells[label].result = {
        subtype: message.subtype,
        isError: message.is_error === true,
      };
    else if (message.type === "assistant")
      for (const part of message.message?.content ?? [])
        if (part.type === "tool_use")
          push({
            kind: "toolUse",
            toolUseId: part.id,
            tool: part.name,
            command: short(part.input?.command),
          });
    if (message.type === "user" && Array.isArray(message.message?.content))
      for (const part of message.message.content)
        if (part.type === "tool_result")
          push({
            kind: "toolResult",
            toolUseId: part.tool_use_id,
            isError: part.is_error === true,
          });
  };
}

// Only the turn query carries cab's MCP server; the settings read and self-test pass through.
const observedSdk = {
  ...claudeSdk,
  query: (input) => {
    if (!input.options?.mcpServers?.cab) return claudeSdk.query(input);
    const seen = observe(input.options);
    const query = claudeSdk.query(input);
    const stream = (async function* () {
      for await (const message of query) {
        seen(message);
        yield message;
      }
    })();
    return Object.assign(stream, {
      accountInfo: () => query.accountInfo(),
      mcpServerStatus: () => query.mcpServerStatus(),
      supportedModels: () => query.supportedModels(),
    });
  },
};

const cache = join(homedir(), ".cache");
mkdirSync(cache, { recursive: true });
const root = realpathSync(
  mkdtempSync(join(cache, "cab-claude-escalation-live-")),
);
chmodSync(root, 0o700);
const evidence = {
  candidate: git("rev-parse", "HEAD"),
  candidateClean: true,
  host: {
    platform: process.platform,
    release: release(),
    arch: arch(),
    node: process.version,
  },
  claude: { installed: claudeVersion, sdk: sdkVersion },
  cells,
  outcomes: null,
  pass: false,
  failure: null,
  cleanup: {
    serviceStopped: false,
    temporaryReleased: false,
    fixtureRemoved: false,
  },
};
const workspaces = [];
let service;
try {
  stage("service-start");
  service = new StandaloneService(
    join(root, "data"),
    (context, harness) => {
      if (harness !== "claude")
        throw new Error("only the Claude runtime runs here");
      const runtime = new ClaudeRuntime({
        safety: context.safety,
        claude: context.claude,
        sdk: observedSdk,
      });
      const startTurn = runtime.startTurn.bind(runtime);
      // One turn per task, found by its marker; repair and other turns are refused.
      runtime.startTurn = (...call) => {
        if (
          !String(call[2]).includes(markers[cell]) ||
          cells[cell].turnId !== null
        ) {
          cells[cell].refusedTurns += 1;
          return Promise.reject(new Error("turn outside the budget"));
        }
        cells[cell].turnId = "";
        return startTurn(...call).then((turnId) => {
          cells[cell].turnId = turnId;
          return turnId;
        });
      };
      const onUnexpected = runtime.onUnexpectedRequest.bind(runtime);
      runtime.onUnexpectedRequest = (listener) =>
        onUnexpected((request) => {
          cells[cell].unexpected.push(request.method);
          listener(request);
        });
      return runtime;
    },
    undefined,
    {
      runtimeHarnesses: ["claude"],
      power: { enabled: false },
      routingClient: null,
    },
  );
  await service.start();
  const api = new OperatorApi(service, [join(root, "data")]);
  const exec = (body) =>
    service.domain().execute({ key: randomUUID(), actor: "operator", ...body });
  const profileId = randomUUID();
  exec({
    type: "profile.create",
    profileId,
    name: "Claude escalation live lead",
    instructions:
      "Run exactly the commands you are given, once each. Keep replies short.",
    capabilities: "shell",
    runtime: { harness: "claude", model: "sonnet", reasoningEffort: "low" },
  });
  const preamble =
    "This is a disposable sandbox-escalation check in a fixture workspace. Use only the Bash tool, run only the listed commands, one at a time, waiting for each result before the next, and never retry a call, whatever its result.";
  const flagged = (label) =>
    `\`node chromium.mjs ${label}\` with dangerouslyDisableSandbox set to true and description "live: needs host Chromium"`;
  const prompts = {
    approval: `Make exactly three Bash calls, in order: (1) \`node chromium.mjs control-approval\` normally, inside the sandbox; (2) ${flagged("approved")}; (3) ${flagged("declined")}.`,
    review: `Make exactly two Bash calls, in order: (1) \`node chromium.mjs control-review\` normally, inside the sandbox; (2) ${flagged("reviewed")}.`,
  };
  const levels = {
    approval: "escalate-approval",
    review: "escalate-auto-review",
  };
  for (const name of ["approval", "review"]) {
    cell = name;
    stage(`${name}: task`);
    const projectId = randomUUID(),
      taskId = randomUUID();
    exec({
      type: "project.create",
      projectId,
      name: `Claude escalation live ${name}`,
      leadProfileId: profileId,
    });
    exec({
      type: "project.configure",
      projectId,
      expectedVersion: Number(service.domain().project(projectId).version),
      paused: false,
      sandbox: levels[name],
    });
    exec({
      type: "task.create",
      projectId,
      taskId,
      title: `Claude escalation live ${name}`,
      outcome: [
        preamble,
        `Marker: ${markers[name]}`,
        prompts[name],
        "Then reply with one short sentence and end the turn. Do not call any cab tool.",
      ].join("\n"),
      ready: false,
    });
    await service.provisionTask(taskId);
    const workspace = (await service.taskWorkspace(taskId))?.path;
    if (!workspace) throw new Error("no task workspace");
    workspaces.push(workspace);
    writeFileSync(join(workspace, "chromium.mjs"), chromiumScript());
    exec({
      type: "task.configure",
      projectId,
      taskId,
      expectedVersion: Number(service.domain().task(taskId).version),
      ready: true,
    });
    stage(`${name}: operate`);
    // The operator answers each escalation through the API: `approved` and an undecided
    // `reviewed` are approved, anything else declined.
    const handled = new Set();
    const deadline = Date.now() + 15 * 60_000;
    const lead = (await api.readTask(taskId)).data.leadAssignmentId;
    if (!lead) throw new Error("no lead assignment");
    let intent;
    while (Date.now() < deadline) {
      for (const a of (await api.readTask(taskId)).data.approvals) {
        if (a.action !== "sandbox.escalate" || handled.has(a.interactionId))
          continue;
        if (a.status !== "open" || !a.approvable) continue;
        handled.add(a.interactionId);
        const label = labelOf(a.material?.command);
        await api.execute({
          type: "approval.decide",
          key: randomUUID(),
          taskId,
          interactionId: a.interactionId,
          expectedRevision: a.revision,
          decision:
            label === "approved" || label === "reviewed"
              ? "approved"
              : "denied",
          action: a.action,
          material: a.material,
        });
      }
      intent = service
        .list()
        .find((i) => i.workId.startsWith(`assignment:${lead}:`));
      if (
        intent &&
        ["completed", "held", "resolved-failed"].includes(intent.state)
      )
        break;
      await sleep(1000);
    }
    if (
      !intent ||
      !["completed", "held", "resolved-failed"].includes(intent.state)
    )
      throw new Error(`${name}: the turn did not end within 15 minutes`);
    const c = cells[name];
    c.intentState = intent.state;
    c.admittedLevel = service.sandboxLevelFor(intent.workId);
    for (const label of [
      "control-approval",
      "approved",
      "declined",
      "control-review",
      "reviewed",
    ]) {
      const file = join(workspace, `${label}-result.json`);
      if (existsSync(file))
        c.results[label] = JSON.parse(readFileSync(file, "utf8")).chromium;
    }
    const store = service.acquired.coordination;
    c.escalations = store.sandboxEscalations(taskId).map((e) => ({
      interactionId: e.interactionId,
      turnId: e.identity.turnId,
      itemId: e.identity.itemId,
      decider: e.decider,
      decision: e.decision,
      exitCode: e.exitCode,
      durationMs: e.durationMs,
      durationSource: e.durationSource,
    }));
    c.reviews = store.sandboxReviews(taskId).map((r) => ({
      reviewId: r.identity.reviewId,
      targetItemId: r.identity.targetItemId,
      turnId: r.identity.turnId,
      command: short(r.command),
      decider: r.decider,
      status: r.status,
      riskLevel: r.riskLevel,
      rationale: short(r.rationale),
      overrule: r.overrule,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      durationSource: r.durationSource,
    }));
    const read = (await api.readTask(taskId)).data;
    c.taskRead = {
      escalations: (read.sandboxEscalations ?? []).length,
      reviews: (read.sandboxReviews ?? []).length,
    };
  }
  stage("stop");
  await service.stop();
  service = undefined;
  evidence.cleanup.serviceStopped = true;
} catch (error) {
  evidence.failure = String(error?.message ?? error).slice(0, 500);
} finally {
  try {
    await service?.stop();
  } catch (error) {
    evidence.failure ??= `cleanup: ${String(error)}`;
  }
  const released = await Promise.all(
    workspaces.map((w) =>
      releaseClaudeTemporaryBase(w).catch(() => ({ outcome: "pending" })),
    ),
  );
  evidence.cleanup.temporaryReleased = released.every(
    (r) => r.outcome === "complete",
  );
  rmSync(root, { recursive: true, force: true });
  evidence.cleanup.fixtureRemoved = !existsSync(root);
}

evidence.outcomes = classifyRun(evidence);
evidence.pass =
  requiredCells.every((key) => evidence.outcomes[key]?.outcome === "proved") &&
  evidence.failure === null &&
  Object.values(evidence.cleanup).every(Boolean);
let output = JSON.stringify(evidence, null, 2);
// The per-user temporary directory appears in sandboxed failures, such as Playwright's mkdtemp.
for (const [secret, shown] of [
  [root, "<fixture>"],
  [realpathSync(tmpdir()), "<tmpdir>"],
  [tmpdir(), "<tmpdir>"],
  [homedir(), "~"],
])
  output = output.replaceAll(secret, shown);
process.stdout.write(`${output}\n`);
process.exitCode = evidence.pass ? 0 : 1;
