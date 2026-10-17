import { Agent, request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { wrapTaskExclusions } from "../fixtures/exclusions-hook.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import {
  finishOwnWork,
  seedOwnApproval,
  seedOwnIntervention,
  seedOwnQuestion,
  startOwnWork,
} from "../fixtures/questions.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import {
  choiceForm,
  mixedAnswers,
  mixedForm,
} from "../fixtures/question-data.js";
import {
  nativeQuestionForm,
  nativeQuestionAnswers,
} from "../../src/core/question-forms.js";
import {
  questionCommandRawLimit,
  operatorCommandSchema,
  questionReadSchema,
  inboxReadSchema,
} from "../../src/operator/contracts.js";
test("action Inbox is cross-project summary-only, selected form is exact and answer replay precedes changed eligibility", async () => {
  const f = await createOperatorFixture();
  try {
    const a = await seedOwnQuestion(f),
      b = await seedOwnQuestion(f, mixedForm, "Second task"),
      api = new OperatorApi(f.service, [f.directory]);
    const queue = await api.readInbox();
    assert.equal(queue.data.items.length, 2);
    assert.equal(queue.data.complete, true);
    assert.equal(
      queue.data.items.some((i) => i.projectId === a.projectId),
      true,
    );
    assert.equal(JSON.stringify(queue).includes("options"), false);
    // The queue leads with the first question's label, matching the exact read.
    assert.deepEqual(
      queue.data.items.map((i) => i.headline),
      [mixedForm.questions[0]!.label, mixedForm.questions[0]!.label],
    );
    const full = await api.readQuestion(a.taskId, a.interactionId);
    assert.deepEqual(full.data.form, mixedForm);
    assert.equal(full.data.status, "pending");
    questionReadSchema.parse(full);
    inboxReadSchema.parse(queue);
    const command = {
      type: "question.form.answer" as const,
      key: randomUUID(),
      taskId: a.taskId,
      interactionId: a.interactionId,
      expectedRevision: 1,
      answers: mixedAnswers,
    };
    const receipt = await api.execute(command);
    assert.equal(receipt.kind, "coordination");
    assert.equal((await api.readInbox()).data.items.length, 1);
    f.seedPersistedState((db) => {
      db.prepare(
        "UPDATE assignment_conversations SET revision=revision+1 WHERE assignmentId=?",
      ).run(a.assignmentId);
    });
    assert.deepEqual(await api.execute(command), receipt);
    await assert.rejects(api.execute({ ...command, key: randomUUID() }));
    assert.equal(
      (await api.readQuestion(b.taskId, b.interactionId)).data.form?.questions
        .length,
      4,
    );
  } finally {
    await f.close();
  }
});
test("privacy exclusions withhold an entire exact form or stored answer without relabeling options", async () => {
  const f = await createOperatorFixture();
  try {
    const a = await seedOwnQuestion(f),
      api = new OperatorApi(f.service, ["Blue"]);
    const full = await api.readQuestion(a.taskId, a.interactionId);
    assert.equal(full.data.form, null);
    assert.equal(full.data.status, "unavailable");
    assert.equal(JSON.stringify(full).includes("Blue"), false);
    // The queue withholds the headline exactly when the exact read withholds the form.
    const queue = await api.readInbox();
    assert.equal(queue.data.items.length, 1);
    assert.equal(queue.data.items[0]!.headline, null);
    assert.equal(JSON.stringify(queue).includes("Blue"), false);
    await assert.rejects(
      api.execute({
        type: "question.form.answer",
        key: randomUUID(),
        taskId: a.taskId,
        interactionId: a.interactionId,
        expectedRevision: 1,
        answers: mixedAnswers,
      }),
    );
    assert.equal(
      f.service.coordinationView().readTask(a.taskId).questions[0]?.status,
      "open",
    );
  } finally {
    await f.close();
  }
});
test("Inbox headlines are the approval action, a plain prompt, or null for an intervention, and an excluded approval action is withheld", async () => {
  const f = await createOperatorFixture();
  try {
    const approval = await seedOwnApproval(f),
      intervention = await seedOwnIntervention(f);
    const started = await startOwnWork(f, "Plain ask", "Plain project");
    const call = await f.runtime.callTool({
      threadId: started.work.threadId!,
      turnId: started.work.turnId!,
      callId: randomUUID(),
      tool: "ensemble_ask_question",
      arguments: { question: "Which release channel should we use?" },
    });
    assert.equal(call.success, true, call.text);
    await finishOwnWork(f, started);
    const headlineOf = (
      items: Awaited<ReturnType<OperatorApi["readInbox"]>>["data"]["items"],
      taskId: string,
    ) => items.find((i) => i.taskId === taskId)?.headline;
    const items = (await new OperatorApi(f.service, [f.directory]).readInbox())
      .data.items;
    assert.equal(
      headlineOf(items, approval.taskId),
      "Create a pull request. No merge or deployment.",
    );
    assert.equal(
      headlineOf(items, started.a.taskId),
      "Which release channel should we use?",
    );
    assert.equal(headlineOf(items, intervention.taskId), null);
    assert.equal(
      items.find((i) => i.taskId === intervention.taskId)?.kind,
      "intervention",
    );
    const withheld = await new OperatorApi(f.service, [
      "pull request",
    ]).readInbox();
    assert.equal(headlineOf(withheld.data.items, approval.taskId), null);
    assert.equal(JSON.stringify(withheld).includes("pull request"), false);
  } finally {
    await f.close();
  }
});
test("a corrupt stored form leaves its row without a headline and the rest of the queue listed", async () => {
  const f = await createOperatorFixture();
  try {
    const bad = await seedOwnQuestion(f),
      good = await seedOwnQuestion(f, choiceForm, "Second task");
    f.seedPersistedState((db) => {
      db.prepare(
        "UPDATE coordination_question_forms SET schemaJson='{}' WHERE interactionId=?",
      ).run(bad.interactionId);
    });
    const queue = await new OperatorApi(f.service, [f.directory]).readInbox();
    assert.equal(queue.data.unavailable, false);
    const byTask = new Map(queue.data.items.map((i) => [i.taskId, i]));
    assert.equal(byTask.size, 2);
    assert.equal(byTask.get(bad.taskId)?.headline, null);
    assert.equal(
      byTask.get(good.taskId)?.headline,
      choiceForm.questions[0]!.label,
    );
  } finally {
    await f.close();
  }
});
test("a native question whose recorded answer is withheld has no headline, as its exact read has no form", async () => {
  const f = await createOperatorFixture();
  try {
    const started = await startOwnWork(f, "Native ask", "Native project");
    const call = await f.runtime.callTool({
      threadId: started.work.threadId!,
      turnId: started.work.turnId!,
      callId: randomUUID(),
      tool: "ensemble_ask_question",
      arguments: { question: "Where should this run?" },
    });
    assert.equal(call.success, true, call.text);
    await finishOwnWork(f, started);
    const q = f.service.coordinationView().readTask(started.a.taskId)
      .questions[0]!;
    const native = {
      request: {
        questions: [
          {
            id: "q",
            header: "Location",
            question: "Where?",
            isOther: true,
            isSecret: false,
            options: [{ label: "Local", description: "This machine" }],
          },
        ],
      },
      answers: { q: { answers: ["Hunter2 cluster"] } },
    };
    const headline = (excluded: string[]) =>
      (
        new OperatorApi(f.service, excluded) as unknown as {
          requestHeadline(
            q: unknown,
            native: unknown,
            excluded: string[],
          ): string | null;
        }
      ).requestHeadline(q, native, excluded);
    assert.equal(headline(["Nothing relevant"]), "Location");
    assert.equal(headline(["Hunter2"]), null);
  } finally {
    await f.close();
  }
});
test("native adaptation preserves labels/custom and all 32 grouped identities without extending codec shapes", () => {
  const questions = Array.from({ length: 32 }, (_, i) => ({
    id: String(i),
    header: "Place",
    question: "Choose",
    isOther: true,
    isSecret: false as const,
    options: [{ label: "Literal label", description: "Description" }],
  }));
  const form = nativeQuestionForm(questions),
    answers = Object.fromEntries(
      questions.map((q) => [q.id, { optionIds: ["0"], text: "" }]),
    );
  assert.deepEqual(
    nativeQuestionAnswers(form, answers),
    Object.fromEntries(
      questions.map((q) => [q.id, { answers: ["Literal label"] }]),
    ),
  );
  answers["0"] = { optionIds: [], text: " exact custom " };
  assert.equal(
    nativeQuestionAnswers(form, answers)["0"]?.answers[0],
    " exact custom ",
  );
  assert.equal(
    questionCommandRawLimit,
    256 * 1024 +
      new TextEncoder().encode(
        JSON.stringify({
          type: "question.native.answer",
          key: "f".repeat(36),
          taskId: "f".repeat(36),
          interactionId: "f".repeat(36),
          expectedRevision: Number.MAX_SAFE_INTEGER,
          answers: {},
        }),
      ).byteLength -
      2,
  );
  assert.throws(() =>
    operatorCommandSchema.parse({
      type: "question.form.answer",
      key: randomUUID(),
      taskId: randomUUID(),
      interactionId: randomUUID(),
      expectedRevision: Number.MAX_SAFE_INTEGER + 1,
      answers,
    }),
  );
});

test("curated command stream accepts exactly 256KiB answer plus strict envelope and rejects raw whitespace, escapes and non-question overflow before effects", async () => {
  const f = await createOperatorFixture();
  try {
    const form = {
      version: 1 as const,
      questions: Array.from({ length: 17 }, (_, i) => ({
        id: String(i),
        kind: "free-text" as const,
        label: `Text ${i}`,
        required: true,
      })),
    };
    const a = await seedOwnQuestion(f, form),
      web = await f.startWeb();
    let response = await fetch(`${web.origin}/api/operator/session`),
      cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "",
      session = (await response.json()) as { csrfToken: string };
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    let originalSocket: Socket | undefined;
    const send = async (path: string, body: string) => {
      try {
        return await new Promise<Response>((resolve, reject) => {
          const request = httpRequest(
            web.origin + path,
            {
              method: "POST",
              agent,
              headers: {
                cookie,
                origin: web.origin,
                "x-csrf-token": session.csrfToken,
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              },
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
              response.on("error", reject);
              response.on("end", () =>
                resolve(
                  new Response(Buffer.concat(chunks), {
                    status: response.statusCode ?? 503,
                    headers: Object.fromEntries(
                      Object.entries(response.headers).map(([key, value]) => [
                        key,
                        Array.isArray(value)
                          ? value.join(",")
                          : String(value ?? ""),
                      ]),
                    ),
                  }),
                ),
              );
            },
          );
          request.on("socket", (socket) => {
            if (originalSocket)
              assert.equal(
                socket,
                originalSocket,
                "Rejected upload must drain before next request on this exact keepalive connection",
              );
            else originalSocket = socket;
          });
          request.on("error", reject);
          request.end(body);
        });
      } catch (error) {
        throw new Error(
          `HTTP boundary ${path} rawBytes=${Buffer.byteLength(body)} prefix=${body.slice(0, 45)} failed`,
          { cause: error },
        );
      }
    };
    try {
      response = await send(
        "/api/operator/login",
        JSON.stringify({ password: web.password }),
      );
      assert.equal(response.status, 200);
      cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
      session = (await response.json()) as { csrfToken: string };
      const answers = Object.fromEntries(
        form.questions.map((q) => [
          q.id,
          { optionIds: [], text: "a".repeat(15000) },
        ]),
      );
      const missing = 256 * 1024 - Buffer.byteLength(JSON.stringify(answers));
      // Distribute exact remaining bytes across legal lower per-field maxima.
      let remaining = missing;
      for (const q of form.questions) {
        const v = answers[q.id]!;
        const add = Math.min(16000 - v.text.length, remaining);
        v.text += "b".repeat(add);
        remaining -= add;
      }
      assert.equal(remaining, 0);
      assert.equal(Buffer.byteLength(JSON.stringify(answers)), 256 * 1024);
      const command = {
        type: "question.form.answer",
        key: randomUUID(),
        taskId: a.taskId,
        interactionId: a.interactionId,
        expectedRevision: 1,
        answers,
      };
      const bytes = JSON.stringify(command);
      for (const raw of [
        bytes +
          " ".repeat(questionCommandRawLimit - Buffer.byteLength(bytes) + 1),
        bytes.replaceAll("a", "\\u0061"),
        JSON.stringify({
          type: "message",
          key: randomUUID(),
          taskId: a.taskId,
          recipientAssignmentId: a.assignmentId,
          expectedAssignmentVersion: 1,
          message: "x",
        }) + " ".repeat(65536),
      ]) {
        assert.equal((await send("/api/operator/commands", raw)).status, 413);
        assert.equal(
          f.service.coordinationView().readTask(a.taskId).questions[0]?.status,
          "open",
        );
      }
      const overflow = structuredClone(command);
      overflow.answers["0"]!.text += "x";
      assert.notEqual(
        (await send("/api/operator/commands", JSON.stringify(overflow))).status,
        200,
      );
      assert.equal(
        f.service.coordinationView().readTask(a.taskId).questions[0]?.status,
        "open",
      );
      response = await send("/api/operator/commands", bytes);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(
        ((await response.json()) as { kind: string }).kind,
        "coordination",
      );
      response = await send("/api/operator/commands", bytes);
      assert.equal(response.status, 200);
      assert.equal(
        f.service
          .coordinationView()
          .readTask(a.taskId)
          .messages.filter((m) => m.eventType === "question-answer").length,
        1,
      );
      assert.equal(
        (await send("/api/operator/source-refresh", `{}${" ".repeat(65536)}`))
          .status,
        413,
      );
      assert.equal((await send("/api/operator/commands", bytes)).status, 200);
    } finally {
      agent.destroy();
    }
  } finally {
    await f.close();
  }
});

test("logout during an authenticated held upload rejects before answer persistence and effect", async () => {
  const f = await createOperatorFixture();
  try {
    const a = await seedOwnQuestion(f),
      web = await f.startWeb();
    let response = await fetch(`${web.origin}/api/operator/session`),
      cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "",
      session = (await response.json()) as { csrfToken: string };
    const headers = () => ({
      cookie,
      origin: web.origin,
      "x-csrf-token": session.csrfToken,
      "content-type": "application/json",
    });
    response = await fetch(`${web.origin}/api/operator/login`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ password: web.password }),
    });
    assert.equal(response.status, 200);
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    session = (await response.json()) as { csrfToken: string };
    const command = {
        type: "question.form.answer",
        key: randomUUID(),
        taskId: a.taskId,
        interactionId: a.interactionId,
        expectedRevision: 1,
        answers: mixedAnswers,
      },
      bytes = JSON.stringify(command);
    let upload!: ReturnType<typeof httpRequest>;
    let continued!: () => void;
    const initial = new Promise<void>((resolve) => {
      continued = resolve;
    });
    const completed = new Promise<number>((resolve, reject) => {
      upload = httpRequest(
        `${web.origin}/api/operator/commands`,
        {
          method: "POST",
          headers: {
            ...headers(),
            expect: "100-continue",
            "content-length": Buffer.byteLength(bytes),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 503));
          res.on("error", reject);
        },
      );
      upload.on("error", reject);
      upload.on("continue", continued);
      upload.flushHeaders();
    });
    await initial;
    upload.write(bytes.slice(0, 40));
    response = await fetch(`${web.origin}/api/operator/logout`, {
      method: "POST",
      headers: headers(),
      body: "{}",
    });
    assert.equal(response.status, 200);
    await response.text();
    upload.end(bytes.slice(40));
    assert.equal(await completed, 401);
    assert.equal(
      f.service.coordinationView().readTask(a.taskId).questions[0]?.status,
      "open",
    );
    assert.equal(
      f.service
        .coordinationView()
        .readTask(a.taskId)
        .messages.filter((m) => m.eventType === "question-answer").length,
      0,
    );
    f.seedPersistedState((db) => {
      const count = db
        .prepare(
          "SELECT COUNT(*) AS n FROM coordination_operator_receipts WHERE commandKey=?",
        )
        .get(command.key) as { n: number };
      assert.equal(count.n, 0);
    });
    assert.equal(f.runtime.turns, 1);
  } finally {
    await f.close();
  }
});

test("Inbox revalidates earlier workspace and task binding after later row awaits", async () => {
  for (const mutation of ["workspace", "task"] as const) {
    const f = await createOperatorFixture();
    try {
      const a = await seedOwnQuestion(f),
        b = await seedOwnQuestion(f, mixedForm, "Later row");
      const catalog = f.service.domain().taskCatalog(),
        first = catalog[0]!,
        last = catalog.at(-1)!;
      const api = new OperatorApi(f.service, [f.directory]);
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((r) => {
          enter = r;
        }),
        barrier = new Promise<void>((r) => {
          release = r;
        });
      let held = false;
      wrapTaskExclusions(api, async (id, run) => {
        if (id === last.id && !held) {
          held = true;
          enter();
          await barrier;
        }
        return run();
      });
      const read = api.readInbox();
      await entered;
      if (mutation === "workspace")
        f.seedPersistedState((db) => {
          db.prepare("DELETE FROM task_workspace_bindings WHERE taskId=?").run(
            first.id,
          );
        });
      else
        f.service.domain().execute({
          type: "task.configure",
          actor: "operator",
          key: randomUUID(),
          projectId: first.projectId,
          taskId: first.id,
          expectedVersion: Number(f.service.domain().task(first.id).version),
          title: "Changed while later row held",
        });
      release();
      await assert.rejects(read, /unavailable/);
      assert.notEqual(a.taskId, b.taskId);
    } finally {
      await f.close();
    }
  }
});

test("Inbox combines approval/question age across 100-row pages and exact selection outside page", async () => {
  const f = await createOperatorFixture();
  try {
    const a = await seedOwnQuestion(f),
      b = await seedOwnQuestion(f, mixedForm, "Other project queue"),
      api = new OperatorApi(f.service, [f.directory]);
    const generated: string[] = [];
    f.seedPersistedState((db) => {
      const insert = db.prepare(
        "INSERT INTO coordination_interactions(interactionId,taskId,requestingAssignmentId,requestingWorkId,requestingWorkRevision,requestingAssignmentVersion,conversationRevision,kind,status,prompt,action,materialHash,revision,createdAt,updatedAt) SELECT ?,taskId,requestingAssignmentId,requestingWorkId,requestingWorkRevision,requestingAssignmentVersion,conversationRevision,?,'open','Page fixture',?, ?,1,?,? FROM coordination_interactions WHERE interactionId=?",
      );
      for (let i = 0; i < 101; i++) {
        const id = randomUUID();
        generated.push(id);
        insert.run(
          id,
          i % 2 ? "approval" : "question",
          i % 2 ? "Review fixture" : null,
          i % 2 ? "a".repeat(64) : null,
          i + 1,
          i + 1,
          a.interactionId,
        );
      }
    });
    const first = await api.readInbox();
    assert.equal(first.data.items.length, 100);
    assert.equal(first.data.complete, false);
    assert.ok(first.data.nextCursor);
    assert.deepEqual(
      first.data.items.slice(0, 3).map((item) => item.kind),
      ["question", "approval", "question"],
    );
    assert.deepEqual(
      first.data.items.slice(0, 3).map((item) => item.createdAt),
      [1000, 2000, 3000],
    );
    const second = await api.readInbox(
      new URLSearchParams({ cursor: first.data.nextCursor! }),
    );
    assert.equal(second.data.items.length, 3);
    assert.equal(second.data.complete, true);
    assert.equal(
      new Set(
        [...first.data.items, ...second.data.items].map((item) => item.id),
      ).size,
      103,
    );
    assert.ok(!first.data.items.some((item) => item.id === b.interactionId));
    assert.equal(
      (await api.readQuestion(b.taskId, b.interactionId)).data.form?.questions
        .length,
      4,
    );
    await api.execute({
      type: "question.form.answer",
      key: randomUUID(),
      taskId: a.taskId,
      interactionId: a.interactionId,
      expectedRevision: 1,
      answers: mixedAnswers,
    });
    await assert.rejects(
      api.readInbox(new URLSearchParams({ cursor: first.data.nextCursor! })),
      /conflict/,
    );
  } finally {
    await f.close();
  }
});

test("own form prototype-shaped IDs survive curated command validation, SQLite receipt and exact readback", async () => {
  const f = await createOperatorFixture();
  try {
    const form = {
        version: 1 as const,
        questions: ["__proto__", "constructor", "toString"].map((id) => ({
          id,
          kind: "free-text" as const,
          label: id,
          required: true,
        })),
      },
      a = await seedOwnQuestion(f, form),
      api = new OperatorApi(f.service, [f.directory]);
    const answers = Object.fromEntries(
        form.questions.map((q) => [
          q.id,
          { optionIds: [], text: `Exact ${q.id}` },
        ]),
      ),
      command = {
        type: "question.form.answer" as const,
        key: randomUUID(),
        taskId: a.taskId,
        interactionId: a.interactionId,
        expectedRevision: 1,
        answers,
      };
    const receipt = await api.execute(JSON.parse(JSON.stringify(command)));
    assert.equal(receipt.kind, "coordination");
    assert.deepEqual(
      (await api.readQuestion(a.taskId, a.interactionId)).data.answers,
      answers,
    );
    assert.deepEqual(await api.execute(command), receipt);
    assert.equal(
      f.service
        .coordinationView()
        .readTask(a.taskId)
        .messages.filter((m) => m.eventType === "question-answer").length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("Inbox limit, kind and project filter before paging and bind their cursors", async () => {
  const f = await createOperatorFixture();
  try {
    const a = await seedOwnQuestion(f),
      b = await seedOwnApproval(f),
      c = await seedOwnQuestion(f, mixedForm, "Third task", "Third project"),
      api = new OperatorApi(f.service, [f.directory]);
    const read = (q: Record<string, string>) =>
      api.readInbox(new URLSearchParams(q));
    const all = (await api.readInbox()).data.items.map((i) => i.id);
    assert.equal(all.length, 3);
    // limit=1 walks every item once.
    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await read({ limit: "1", ...(cursor ? { cursor } : {}) });
      assert.ok(page.data.items.length <= 1);
      walked.push(...page.data.items.map((i) => i.id));
      cursor = page.data.nextCursor;
      assert.equal(page.data.complete, cursor === null);
    } while (cursor);
    assert.deepEqual(walked, all);
    assert.deepEqual(
      (await read({ kind: "approval" })).data.items.map((i) => i.id),
      [b.interactionId],
    );
    assert.deepEqual(
      (await read({ project: c.projectId })).data.items.map((i) => i.id),
      [c.interactionId],
    );
    assert.deepEqual(
      (await read({ kind: "question", project: a.projectId })).data.items.map(
        (i) => i.id,
      ),
      [a.interactionId],
    );
    assert.deepEqual(
      (await read({ kind: "intervention", project: a.projectId })).data.items,
      [],
    );
    // A cursor issued under other filters does not continue this view.
    const first = await read({ limit: "1" });
    await assert.rejects(
      read({ limit: "1", kind: "question", cursor: first.data.nextCursor! }),
      /conflict/,
    );
    for (const bad of [
      "limit=0",
      "limit=101",
      "limit=x",
      "kind=other",
      "project=nope",
      "limit=1&limit=2",
      "kind=question&kind=approval",
      "other=1",
    ])
      await assert.rejects(
        api.readInbox(new URLSearchParams(bad)),
        /invalid-input/,
        bad,
      );
  } finally {
    await f.close();
  }
});
