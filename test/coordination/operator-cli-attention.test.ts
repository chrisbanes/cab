import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { nativeQuestionForm } from "../../src/core/question-forms.js";
import { fakeServer, harness } from "../fixtures/cli-harness.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import { startCliOperator } from "../fixtures/operator-cli.js";
import { mixedAnswers } from "../fixtures/question-data.js";
import {
  finishOwnWork,
  seedOwnApproval,
  seedOwnIntervention,
  seedOwnQuestion,
  startOwnWork,
} from "../fixtures/questions.js";
import { exhaustibleRuntime } from "../fixtures/runtime-exhaustion.js";

type Operator = Awaited<ReturnType<typeof startCliOperator>>;
const posts = (o: Operator) =>
  o.h.fetches.filter((u) => u.endsWith("/api/operator/commands")).length;

/** One interaction raised by a running lead turn through its coordination tool. */
async function ownInteraction(
  o: Operator,
  tool: string,
  args: Record<string, unknown>,
  title: string,
) {
  const started = await startOwnWork(o.s.f, title, `${title} project`);
  const { a, work } = started;
  const call = await o.s.f.runtime.callTool({
    threadId: work.threadId!,
    turnId: work.turnId!,
    callId: randomUUID(),
    tool,
    arguments: args,
  });
  assert.equal(call.success, true, call.text);
  await finishOwnWork(o.s.f, started);
  const view = o.s.f.service.coordinationView().readTask(a.taskId);
  const interaction = [...view.questions, ...view.approvals][0]!;
  return { ...a, interactionId: interaction.interactionId };
}

test("inbox list filters and pages on the server with read-only credentials", async (t) => {
  const o = await startCliOperator(t);
  const { cli, s } = o;
  const q = await seedOwnQuestion(s.f);
  const ap = await seedOwnApproval(s.f);
  const iv = await seedOwnIntervention(s.f);
  const before = databaseDigest(s.f);
  let r = await cli("ro", ["inbox", "list"]);
  assert.equal(r.code, 0, r.err + r.out);
  const items = r.json().data.items as { kind: string; taskId: string }[];
  assert.deepEqual(
    new Set(items.map((i) => i.kind)),
    new Set(["question", "approval", "intervention"]),
  );
  r = await cli("ro", ["inbox", "list", "--kind", "approval"]);
  assert.deepEqual(
    r.json().data.items.map((i: { interactionId: string }) => i.interactionId),
    [ap.interactionId],
  );
  r = await cli("ro", ["inbox", "list", "--project", q.projectId]);
  assert.deepEqual(
    r.json().data.items.map((i: { taskId: string }) => i.taskId),
    [q.taskId],
  );
  // --limit 1 walks every item through More: and pagination.nextCursor.
  const walked: string[] = [];
  let cursor: string | null = null;
  do {
    r = await cli("ro", [
      "inbox",
      "list",
      "--limit",
      "1",
      ...(cursor ? ["--cursor", cursor] : []),
    ]);
    assert.equal(r.code, 0, r.out);
    walked.push(...r.json().data.items.map((i: { id: string }) => i.id));
    cursor = r.json().pagination.nextCursor;
  } while (cursor);
  assert.equal(walked.length, 3);
  const human = await o.h.run([
    "inbox",
    "list",
    "--limit",
    "1",
    "--connection",
    "ro",
  ]);
  assert.equal(databaseDigest(s.f), before, "reads change nothing");
  assert.match(human.out, /More: ensemble inbox list .*--limit 1 --cursor /);
  assert.match(human.out, new RegExp(`ensemble task get ${iv.taskId}`));
  // A token from other filters is refused locally; one the service rejects is stale.
  const first = await cli("ro", ["inbox", "list", "--limit", "1"]);
  const token = first.json().pagination.nextCursor;
  r = await cli("ro", [
    "inbox",
    "list",
    "--limit",
    "1",
    "--kind",
    "question",
    "--cursor",
    token,
  ]);
  assert.equal(r.code, 2);
  await seedOwnQuestion(s.f, undefined, "Later", "Later project");
  r = await cli("ro", ["inbox", "list", "--limit", "1", "--cursor", token]);
  assert.equal(r.code, 4, r.out);
  assert.equal(r.json().error.code, "cursor-stale");
});

test("inbox list prints and filters the runtime item", async (t) => {
  const exhaustion = exhaustibleRuntime();
  const o = await startCliOperator(t, {
    runtimeFactory: exhaustion.factory,
    service: exhaustion.serviceOptions,
  });
  const { cli, s } = o;
  const q = await seedOwnQuestion(s.f);
  await exhaustion.exhaust(s.f.runtime);

  let r = await cli("ro", ["inbox", "list", "--kind", "runtime"]);
  assert.equal(r.code, 0, r.err + r.out);
  const [item, ...others] = r.json().data.items;
  assert.equal(item.kind, "runtime");
  assert.equal(item.harness, "codex");
  assert.equal("taskId" in item, false, "a runtime item names no task");
  assert.equal(others.length, 0);
  assert.equal(item.lastFailure, "start-failed");
  assert.equal(JSON.stringify(r.json()).includes("will not start"), false);

  const human = await o.h.run([
    "inbox",
    "list",
    "--kind",
    "runtime",
    "--connection",
    "ro",
  ]);
  assert.match(human.out, /runtime\s+codex\s+\(ensemble runtime list\)/);
  assert.match(human.out, /Restart retries exhausted/);

  // Unfiltered it leads the list; a project excludes it; an unknown kind names the choices.
  r = await cli("ro", ["inbox", "list"]);
  assert.deepEqual(
    r.json().data.items.map((i: { kind: string }) => i.kind),
    ["runtime", "question"],
  );
  const scoped = await o.h.run([
    "inbox",
    "list",
    "--kind",
    "runtime",
    "--project",
    q.projectId,
    "--connection",
    "ro",
  ]);
  assert.match(scoped.out, /Nothing needs attention\./);
  r = await cli("ro", ["inbox", "list", "--kind", "bogus"]);
  assert.equal(r.code, 2);
  assert.match(
    r.err + r.out,
    /--kind must be question, approval, intervention, runtime\./,
  );

  // `runtime list` carries the same state and, as JSON, the restart facts.
  r = await cli("ro", ["runtime", "list"]);
  assert.equal(r.code, 0, r.err + r.out);
  const codex = r
    .json()
    .data.runtimes.find((x: { harness: string }) => x.harness === "codex");
  assert.equal(codex.state, "unavailable");
  assert.equal(codex.restart.state, "exhausted");
  assert.equal(codex.restart.attempts.length, 3);
  const text = await o.h.run(["runtime", "list", "--connection", "ro"]);
  assert.match(text.out, /Unavailable \(retries exhausted\)/);
});

test("question get and answer require every answer explicitly and record once", async (t) => {
  const o = await startCliOperator(t);
  const { cli, s, file, lostReply } = o;
  const q = await seedOwnQuestion(s.f);
  let r = await o.h.run([
    "question",
    "get",
    q.taskId,
    q.interactionId,
    "--connection",
    "ro",
  ]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /notes \[free-text; required, min 2 chars/);
  assert.match(r.out, /blue: Blue \(recommended; information only\)/);
  assert.match(r.out, /red: Red \(preselected; information only\)/);
  assert.match(r.out, /Answers file shape: \{"notes":/);
  const answer = (
    path: string,
    extra: string[] = [],
    connection: "rw" | "ro" = "rw",
  ) =>
    cli(connection, [
      "question",
      "answer",
      q.taskId,
      q.interactionId,
      "--expected-revision",
      "1",
      "--answers-file",
      path,
      ...extra,
    ]);
  const sent = posts(o);
  // A recommendation is never an answer: omitting the question fails locally.
  const { color: _omitted, ...withoutColor } = mixedAnswers;
  for (const [name, answers, id] of [
    ["omit.json", withoutColor, "color"],
    [
      "option.json",
      { ...mixedAnswers, color: { optionIds: ["green"], text: "" } },
      "color",
    ],
    [
      "short.json",
      { ...mixedAnswers, notes: { optionIds: [], text: "x" } },
      "notes",
    ],
    [
      "count.json",
      { ...mixedAnswers, places: { optionIds: ["home", "work"], text: "x" } },
      "places",
    ],
  ] as const) {
    r = await answer(file(name, JSON.stringify(answers)));
    assert.equal(r.code, 2, name);
    assert.match(r.json().error.message, new RegExp(id), name);
  }
  r = await answer(file("bad.json", "{"));
  assert.equal(r.code, 2);
  assert.equal(posts(o), sent, "invalid answers send nothing");
  // A stale revision is refused before sending.
  r = await cli("rw", [
    "question",
    "answer",
    q.taskId,
    q.interactionId,
    "--expected-revision",
    "2",
    "--answers-file",
    file("ok.json", JSON.stringify(mixedAnswers)),
  ]);
  assert.equal(r.code, 4);
  assert.equal(posts(o), sent);
  // Read-only is refused with no change.
  const digest = databaseDigest(s.f);
  r = await answer(file("ok.json", JSON.stringify(mixedAnswers)), [], "ro");
  assert.equal(r.code, 3);
  assert.equal(databaseDigest(s.f), digest);

  // A lost reply then rerun reuses the key and records once, across a restart.
  r = await answer(
    file("ok.json", JSON.stringify(mixedAnswers)),
    [],
    "rw",
  ).then(() => cli("rw", ["question", "get", q.taskId, q.interactionId]));
  assert.equal(r.json().data.status, "recorded");
  const q2 = await seedOwnQuestion(s.f, undefined, "Second", "Second project");
  const answer2 = () =>
    cli(
      "rw",
      [
        "question",
        "answer",
        q2.taskId,
        q2.interactionId,
        "--expected-revision",
        "1",
        "--answers-file",
        file("ok.json", JSON.stringify(mixedAnswers)),
      ],
      {},
    );
  r = await cli(
    "rw",
    [
      "question",
      "answer",
      q2.taskId,
      q2.interactionId,
      "--expected-revision",
      "1",
      "--answers-file",
      file("ok.json", JSON.stringify(mixedAnswers)),
    ],
    { fetch: lostReply },
  );
  assert.equal(r.code, 6, r.out);
  await s.restart();
  r = await answer2();
  assert.equal(r.code, 0, r.out);
  assert.equal(
    r.json().data.reusedRequest,
    true,
    "status gate does not block the replay",
  );
  assert.equal(r.json().data.receipt.kind, "coordination");
  r = await answer2();
  assert.equal(r.code, 4, "a second answer is refused");
  const recorded = (await (
    await s.sessionGet(
      `/api/operator/tasks/${q2.taskId}/questions/${q2.interactionId}`,
    )
  ).json()) as {
    data: { status: string; answers: unknown };
  };
  assert.equal(recorded.data.status, "recorded");
  assert.deepEqual(recorded.data.answers, mixedAnswers);
});

test("a plain question sends question.answer; the same answer over the session API matches", async (t) => {
  const o = await startCliOperator(t);
  const plain = await ownInteraction(
    o,
    "ensemble_ask_question",
    { question: "Which branch?" },
    "Plain question",
  );
  let r = await o.cli("rw", [
    "question",
    "get",
    plain.taskId,
    plain.interactionId,
  ]);
  assert.equal(r.json().data.source, "plain");
  const id = r.json().data.form.questions[0].id;
  r = await o.cli("rw", [
    "question",
    "answer",
    plain.taskId,
    plain.interactionId,
    "--expected-revision",
    String(r.json().data.revision),
    "--answers-file",
    o.file(
      "plain.json",
      JSON.stringify({ [id]: { optionIds: [], text: "main" } }),
    ),
  ]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json().request.type, "question.answer");
  const viaCli = r.json().data.receipt;
  const other = await ownInteraction(
    o,
    "ensemble_ask_question",
    { question: "Which tag?" },
    "Plain session",
  );
  const session = await o.s.sessionPost("/api/operator/commands", {
    type: "question.answer",
    key: randomUUID(),
    taskId: other.taskId,
    interactionId: other.interactionId,
    expectedRevision: 1,
    answer: "v1",
  });
  assert.equal(session.status, 200);
  assert.deepEqual(
    Object.keys(await session.json()).sort(),
    Object.keys(viaCli).sort(),
  );
});

test("a native question is answered with the React mapping", async (t) => {
  const taskId = randomUUID(),
    interactionId = randomUUID(),
    key = randomUUID(),
    installationId = randomUUID(),
    credentialId = randomUUID();
  const form = nativeQuestionForm([
    {
      id: "q",
      header: "Location",
      question: "Where?",
      isOther: true,
      isSecret: false,
      options: [{ label: "Local", description: "This machine" }],
    },
  ] as never);
  let posted: Record<string, unknown> | undefined;
  const server = await fakeServer(t, (request, response) => {
    let body = "";
    request.on("data", (c) => {
      body += c;
    });
    request.on("end", () => {
      const json = (value: unknown) =>
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(value));
      if (request.url === "/api/operator/cli")
        return json({
          apiVersion: 1,
          capabilities: ["cli.identity", "attention.read", "attention.write"],
          service: { installationId, origin: server.origin },
          credential: {
            id: credentialId,
            name: "native",
            scope: "read-write",
            createdAt: 0,
            expiresAt: Date.now() + 1e9,
          },
        });
      if (request.url?.includes("/questions/"))
        return json({
          data: {
            taskId,
            interactionId,
            requestingAssignmentId: randomUUID(),
            conversationRevision: 1,
            revision: 3,
            source: "native",
            status: "pending",
            form,
            answers: null,
            reason: null,
            deliveryState: "pending",
          },
          observedAt: Date.now(),
        });
      posted = JSON.parse(body);
      json({
        kind: "native-question",
        key: (posted as { key: string }).key,
        taskId,
        interactionId,
        revision: 4,
        recorded: true,
        deliveryState: "recorded",
      });
    });
  });
  const h = harness(t);
  const token = `ens_${randomUUID()}_${"a".repeat(43)}`;
  const login = await h.run([
    "auth",
    "login",
    "--connection",
    "n",
    "--url",
    server.origin,
    "--token-file",
    h.tokenFile(token),
  ]);
  assert.equal(login.code, 0, login.err);
  const answers = join(h.dir, "a.json");
  writeFileSync(answers, JSON.stringify({ q: { optionIds: ["0"], text: "" } }));
  const r = await h.run([
    "question",
    "answer",
    taskId,
    interactionId,
    "--expected-revision",
    "3",
    "--answers-file",
    answers,
    "--request-id",
    key,
    "--connection",
    "n",
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(posted, {
    type: "question.native.answer",
    key,
    taskId,
    interactionId,
    expectedRevision: 3,
    answers: { q: { answers: ["Local"] } },
  });
  assert.match(
    r.out,
    /delivery to the runtime and any new work remain subject to holds/,
  );
});

test("approval get lists task holds in the UI's words", async (t) => {
  const o = await startCliOperator(t);
  const ap = await seedOwnApproval(o.s.f);
  const get = (args: string[] = []) =>
    o.h.run([
      "approval",
      "get",
      ap.taskId,
      ap.interactionId,
      "--connection",
      "ro",
      ...args,
    ]);
  const holdsLine = (out: string) =>
    out.split("\n").find((l) => l.startsWith("Task holds:"));
  assert.deepEqual(holdsLine((await get()).out)?.split(/ {2,}/), [
    "Task holds:",
    "none",
  ]);
  await o.s.f.service.stopTask(ap.taskId);
  const human = await get();
  assert.equal(human.code, 0, human.err);
  assert.deepEqual(holdsLine(human.out)?.split(/ {2,}/), [
    "Task holds:",
    "Stop requested",
  ]);
  const json = (await get(["--output", "json"])).json().data.holds;
  assert.equal(json.stop, true);
  assert.deepEqual(Object.keys(json).sort(), [
    "capacity",
    "stop",
    "task",
    "uncertainty",
    "writer",
  ]);
});

test("approval get and decide bind the exact action, revision and material", async (t) => {
  const o = await startCliOperator(t);
  const { cli, s, d } = o;
  const ap = await seedOwnApproval(s.f);
  let r = await o.h.run([
    "approval",
    "get",
    ap.taskId,
    ap.interactionId,
    "--connection",
    "ro",
  ]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Action:\s+Create a pull request/);
  assert.match(r.out, /Material:\s+\{"scope":"fixture"\}/);
  r = await cli("ro", ["approval", "get", ap.taskId, ap.interactionId]);
  const approval = r.json().data.approval;
  const hash = approval.materialHash as string;
  const decide = (
    decision: string,
    extra: string[],
    connection: "rw" | "ro" = "rw",
  ) =>
    cli(connection, [
      "approval",
      "decide",
      ap.taskId,
      ap.interactionId,
      "--decision",
      decision,
      ...extra,
    ]);
  const sent = posts(o);
  r = await decide("approved", [
    "--expected-revision",
    String(approval.revision),
  ]);
  assert.equal(r.code, 2, "material hash required");
  r = await decide("approved", [
    "--expected-revision",
    String(approval.revision),
    "--material-hash",
    "b".repeat(64),
  ]);
  assert.equal(r.code, 4, "wrong hash");
  r = await decide("approved", [
    "--expected-revision",
    String(approval.revision + 1),
    "--material-hash",
    hash,
  ]);
  assert.equal(r.code, 4, "wrong revision");
  assert.equal(posts(o), sent);
  const digest = databaseDigest(s.f);
  r = await decide(
    "approved",
    ["--expected-revision", String(approval.revision), "--material-hash", hash],
    "ro",
  );
  assert.equal(r.code, 3);
  assert.equal(databaseDigest(s.f), digest);
  // A command altered over HTTP is refused by the service.
  const altered = await s.sessionPost("/api/operator/commands", {
    type: "approval.decide",
    key: randomUUID(),
    taskId: ap.taskId,
    interactionId: ap.interactionId,
    expectedRevision: approval.revision,
    decision: "approved",
    action: approval.action,
    target: approval.target,
    material: { scope: "changed" },
  });
  assert.equal(altered.status, 409);
  // Lost reply, then rerun: one decision.
  r = await cli(
    "rw",
    [
      "approval",
      "decide",
      ap.taskId,
      ap.interactionId,
      "--decision",
      "approved",
      "--expected-revision",
      String(approval.revision),
      "--material-hash",
      hash,
    ],
    { fetch: o.lostReply },
  );
  assert.equal(r.code, 6, r.out);
  r = await decide("approved", [
    "--expected-revision",
    String(approval.revision),
    "--material-hash",
    hash,
  ]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json().data.reusedRequest, true);
  r = await decide("denied", [
    "--expected-revision",
    String(approval.revision),
    "--material-hash",
    hash,
  ]);
  assert.equal(r.code, 4, "a second decision is refused");
  const after = s.f.service.coordinationView().readTask(ap.taskId)
    .approvals[0]!;
  assert.equal(after.status, "approved");

  // Withheld material can only be denied.
  const withheld = await ownInteraction(
    o,
    "ensemble_request_approval",
    {
      action: "Push the branch",
      target: "acme/atlas",
      material: { note: "PRIVATE REVIEW INSTRUCTIONS" },
    },
    "Withheld approval",
  );
  r = await cli("rw", [
    "approval",
    "get",
    withheld.taskId,
    withheld.interactionId,
  ]);
  const w = r.json().data.approval;
  assert.equal(w.approvable, false);
  assert.equal(w.material, null);
  const wArgs = (decision: string) => [
    "approval",
    "decide",
    withheld.taskId,
    withheld.interactionId,
    "--decision",
    decision,
    "--expected-revision",
    String(w.revision),
    "--material-hash",
    w.materialHash,
  ];
  r = await cli("rw", wArgs("approved"));
  assert.equal(r.code, 4);
  assert.equal(r.json().error.code, "policy-denied");
  r = await cli("rw", wArgs("denied"));
  assert.equal(r.code, 0, r.out);

  // A legacy approval with no recorded material can only be denied.
  const legacy = await ownInteraction(
    o,
    "ensemble_request_approval",
    {
      action: "Tag a release",
      target: "acme/atlas",
      material: { scope: "legacy" },
    },
    "Legacy approval",
  );
  s.f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE coordination_interactions SET materialJson = NULL WHERE interactionId = ?",
      )
      .run(legacy.interactionId),
  );
  const legacyHash = (
    await cli("ro", ["approval", "get", legacy.taskId, legacy.interactionId])
  ).json().data.approval.materialHash;
  const lArgs = (decision: string) => [
    "approval",
    "decide",
    legacy.taskId,
    legacy.interactionId,
    "--decision",
    decision,
    "--expected-revision",
    "1",
    "--material-hash",
    legacyHash,
  ];
  r = await cli("rw", lArgs("approved"));
  assert.equal(r.code, 4, r.out);
  r = await cli("rw", lArgs("denied"));
  assert.equal(r.code, 0, r.out);
  assert.ok(d.task(legacy.taskId));
});
