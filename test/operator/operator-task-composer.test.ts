import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OperatorClient } from "../../web/src/api.js";
import { ComposerState, storageKey } from "../../web/src/composer-state.js";

test("frozen recovery persistence is a prerequisite to every task creation POST", async () => {
  let posts = 0;
  const saved = new Map<string, string>();
  let fail = false;
  const storage = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (fail) throw Error("quota");
      saved.set(k, v);
    },
    removeItem: (k: string) => saved.delete(k),
  };
  const client = new OperatorClient(async () => {
    posts++;
    return new Response("{}", { status: 503 });
  });
  const state = new ComposerState(storage);
  state.edit({
    projectId: randomUUID(),
    title: "Last saved",
    outcome: "A useful outcome",
  });
  const last = saved.get(storageKey);
  assert.ok(last);
  fail = true;
  state.edit({ title: "Newer unsaved edit" });
  await state.submit(client, "csrf", false);
  assert.equal(posts, 0);
  assert.equal(state.phase, "editable");
  assert.equal(state.input.title, "Newer unsaved edit");
  assert.equal(saved.get(storageKey), last);
  assert.match(state.notice, /nothing was sent/);
  const restored = new ComposerState(storage);
  assert.equal(restored.input.title, "Last saved");
});

test("only an exact original task receipt confirms a frozen submission", async () => {
  for (const mismatch of [
    "key",
    "task",
    "project",
    "ready",
    "version",
    "kind",
  ]) {
    const storage = memoryStorage();
    const state = new ComposerState(storage);
    state.edit({ projectId: randomUUID(), title: "Task", outcome: "Finish" });
    const client = new OperatorClient(async (_path, init) => {
      const command = JSON.parse(String(init?.body));
      const receipt =
        mismatch === "kind"
          ? {
              kind: "coordination",
              key: command.key,
              recorded: true,
              eventId: randomUUID(),
              taskId: command.taskId,
              recipientAssignmentId: randomUUID(),
              eventType: "message",
              createdAt: 1,
            }
          : {
              kind: "domain",
              key: mismatch === "key" ? randomUUID() : command.key,
              recorded: true,
              result: {
                id: mismatch === "task" ? randomUUID() : command.taskId,
                projectId:
                  mismatch === "project" ? randomUUID() : command.projectId,
                version: mismatch === "version" ? 2 : 1,
                state: "open",
                ready: mismatch === "ready" ? !command.ready : command.ready,
              },
            };
      return new Response(JSON.stringify(receipt), { status: 200 });
    });
    await state.submit(client, "csrf", true);
    assert.equal(state.phase, "unknown", mismatch);
    assert.ok(state.frozen);
    assert.ok(storage.getItem(storageKey));
  }
});
function memoryStorage() {
  const bytes = new Map<string, string>();
  return {
    getItem: (key: string) => bytes.get(key) ?? null,
    setItem: (key: string, value: string) => {
      bytes.set(key, value);
    },
    removeItem: (key: string) => {
      bytes.delete(key);
    },
  };
}

import { OperatorApi } from "../../src/standalone/operator-api.js";
import {
  briefNearLimit,
  byteLength,
  composeOutcome,
  emptyInput,
  encodeOutcome,
  encodeRecovery,
  readRecovery,
  recoveryLimit,
} from "../../web/src/composer-state.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";

test("unknown task creation freezes original command across reload and cannot rekey after authentication failure", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const d = f.service.domain(),
    projectId = randomUUID(),
    profileId = randomUUID(),
    blocker = randomUUID();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Lead",
    instructions: "private",
    capabilities: "coordinate",
  });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Project",
    leadProfileId: profileId,
  });
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId: blocker,
    title: "Blocker",
    outcome: "Finish",
    ready: false,
  });
  let api = new OperatorApi(f.service, [f.directory]);
  const storage = memoryStorage(),
    state = new ComposerState(storage);
  state.edit({
    projectId,
    title: "One task",
    outcome: "Ship",
    blockerTaskIds: [blocker],
    profileId,
  });
  let posts = 0;
  const sent: string[] = [];
  const lost = new OperatorClient(async (_path, init) => {
    posts++;
    sent.push(String(init?.body));
    await api.execute(JSON.parse(String(init?.body)));
    throw Error("lost response");
  });
  await state.submit(lost, "csrf", true);
  assert.equal(state.phase, "unknown");
  assert.equal(posts, 1);
  const original = JSON.stringify(state.frozen);
  const restored = new ComposerState(storage);
  assert.equal(posts, 1);
  assert.equal(restored.phase, "unknown");
  assert.equal(JSON.stringify(restored.frozen), original);
  restored.edit({ title: "Must not change" });
  assert.equal(restored.input.title, "One task");
  for (const [status, code] of [
    [401, "unauthenticated"],
    [403, "forbidden"],
    [503, "unavailable"],
    [400, "invalid-input"],
    [409, "conflict"],
  ] as const) {
    const rejected = new OperatorClient(async (_path, init) => {
      posts++;
      sent.push(String(init?.body));
      return new Response(
        JSON.stringify({ error: { code, message: "Safe failure" } }),
        { status },
      );
    });
    await restored.submit(rejected, "csrf", false);
    assert.equal(restored.phase, "unknown");
    assert.equal(JSON.stringify(restored.frozen), original);
  }
  await f.service.stop();
  await f.service.start();
  api = new OperatorApi(f.service, [f.directory]);
  const replay = new OperatorClient(async (_path, init) => {
    posts++;
    sent.push(String(init?.body));
    return new Response(
      JSON.stringify(await api.execute(JSON.parse(String(init?.body)))),
      { status: 200 },
    );
  });
  await restored.submit(replay, "csrf", false);
  assert.equal(restored.phase, "recorded");
  assert.ok(sent.every((bytes) => bytes === original));
  assert.equal(storage.getItem(storageKey), null);
  const tasks = f.service.domain().tasks(projectId);
  assert.equal(tasks.length, 2);
  const taskId = restored.frozen?.taskId;
  assert.ok(taskId);
  assert.deepEqual(f.service.domain().dependencies(taskId), [blocker]);
  assert.equal(f.service.domain().assignments(taskId).length, 1);
  assert.equal(f.runtime.turns, 0);
});
test("composer validates encoded command bytes and preserves editable invalid fields", async () => {
  const storage = memoryStorage(),
    state = new ComposerState(storage);
  let posts = 0;
  const client = new OperatorClient(async () => {
    posts++;
    throw Error("not expected");
  });
  state.edit({
    projectId: randomUUID(),
    title: " ",
    outcome: " ",
    links: ["file:///private"],
  });
  await state.submit(client, "csrf", false);
  assert.equal(posts, 0);
  assert.ok(state.errors.title);
  assert.ok(state.errors.outcome);
  assert.ok(state.errors.links);
  assert.equal(state.input.links[0], "file:///private");
  state.edit({ title: "x".repeat(512), outcome: "x".repeat(16000), links: [] });
  assert.equal(encodeOutcome(state.input).length, 16000);
  await state.submit(client, "csrf", false);
  assert.equal(posts, 1);
  const frozen = state.frozen;
  assert.ok(frozen);
  assert.ok(byteLength(JSON.stringify(frozen)) <= 65536);
  assert.ok(
    byteLength(
      encodeRecovery({
        version: 1,
        status: "unknown",
        input: state.input,
        command: frozen,
      }),
    ) < recoveryLimit,
  );
  const wide = new ComposerState(memoryStorage());
  wide.edit({
    projectId: randomUUID(),
    title: "Task",
    outcome: "\u0000".repeat(16000),
  });
  await wide.submit(client, "csrf", false);
  assert.equal(posts, 1);
  assert.match(wide.errors.outcome ?? "", /64 KiB/);
  const combined = new ComposerState(memoryStorage());
  combined.edit({
    projectId: randomUUID(),
    title: "Task",
    outcome: "x".repeat(16000),
    context: "extra",
  });
  await combined.submit(client, "csrf", false);
  assert.equal(posts, 1);
  assert.match(combined.errors.outcome ?? "", /16,000/);
});
test("recovery has symmetric UTF-8 bounds and rejects malformed unknown versions", () => {
  const storage = memoryStorage();
  for (const bytes of [
    "{bad",
    JSON.stringify({ version: 2, status: "unfinished", input: {} }),
    "x".repeat(recoveryLimit + 1),
  ]) {
    storage.setItem(storageKey, bytes);
    assert.equal(readRecovery(storage), null);
  }
  const state = new ComposerState(memoryStorage());
  const base = {
    version: 1 as const,
    status: "unfinished" as const,
    input: state.input,
  };
  const overhead = byteLength(encodeRecovery(base));
  const exact = {
    ...base,
    input: { ...base.input, outcome: "x".repeat(recoveryLimit - overhead) },
  };
  assert.equal(byteLength(encodeRecovery(exact)), recoveryLimit);
  assert.throws(
    () =>
      encodeRecovery({
        ...exact,
        input: { ...exact.input, outcome: `${exact.input.outcome}x` },
      }),
    /recovery-too-large/,
  );
  storage.setItem(storageKey, encodeRecovery(exact));
  assert.ok(readRecovery(storage));
});

test("recovered frozen commands must agree with their validated input", () => {
  const state = new ComposerState(memoryStorage());
  const input = {
    ...state.input,
    projectId: randomUUID(),
    title: "Task",
    outcome: "Finish",
  };
  const command = {
    type: "task.create" as const,
    key: randomUUID(),
    projectId: input.projectId,
    taskId: randomUUID(),
    title: "Different title",
    outcome: "Finish",
    ready: true,
  };
  assert.throws(() =>
    encodeRecovery({ version: 1, status: "unknown", input, command }),
  );
});
test("failed frozen readback sends no POST and reconciliation also requires storage readback", async () => {
  const storage = memoryStorage(),
    state = new ComposerState(storage);
  state.edit({ projectId: randomUUID(), title: "Task", outcome: "Finish" });
  let posts = 0,
    broken = false;
  const originalGet = storage.getItem;
  storage.getItem = (k) => (broken ? null : originalGet(k));
  broken = true;
  await state.submit(
    new OperatorClient(async () => {
      posts++;
      throw Error("unexpected");
    }),
    "csrf",
    true,
  );
  assert.equal(posts, 0);
  assert.equal(state.phase, "editable");
  assert.equal(state.input.title, "Task");
  broken = false;
  const unknown = new ComposerState(storage);
  assert.equal(unknown.phase, "unknown");
  const frozen = JSON.stringify(unknown.frozen);
  broken = true;
  await unknown.submit(
    new OperatorClient(async () => {
      posts++;
      throw Error("unexpected");
    }),
    "csrf",
    false,
  );
  assert.equal(posts, 0);
  assert.equal(unknown.phase, "unknown");
  assert.equal(JSON.stringify(unknown.frozen), frozen);
  // The unconfirmed creation keeps its one warning and its request key.
  assert.equal(unknown.failed, false);
  assert.match(
    unknown.notice,
    /^We couldn't check whether the task was created/,
  );
  assert.equal(unknown.details.requestKey, unknown.frozen?.key);
});

test("valid multibyte selected input fits recovery and exact HTTP byte boundary rejects one byte over", async () => {
  let posts = 0;
  const client = new OperatorClient(async () => {
    posts++;
    throw Error("Fixture lost response");
  });
  const state = new ComposerState(memoryStorage());
  state.edit({
    projectId: randomUUID(),
    title: "😀".repeat(256),
    outcome: "界".repeat(6000),
    context: "é".repeat(2000),
    links: Array.from(
      { length: 32 },
      (_, i) => `https://example.com/reference/${i}`,
    ),
    profileId: randomUUID(),
    blockerTaskIds: Array.from({ length: 128 }, () => randomUUID()),
  });
  await state.submit(client, "csrf", true);
  assert.equal(posts, 1);
  assert.equal(state.phase, "unknown");
  assert.ok(state.frozen);
  assert.equal(state.frozen.blockerTaskIds?.length, 128);
  assert.ok(byteLength(JSON.stringify(state.frozen)) <= 65536);
  assert.ok(
    byteLength(
      encodeRecovery({
        version: 1,
        status: "unknown",
        input: state.input,
        command: state.frozen,
      }),
    ) < recoveryLimit,
  );
  const projectId = randomUUID(),
    title = "Byte boundary",
    base = {
      type: "task.create",
      key: randomUUID(),
      projectId,
      taskId: randomUUID(),
      title,
      outcome: "",
      ready: true,
    };
  const control = "\u0000".repeat(10800),
    padding = 65536 - byteLength(JSON.stringify({ ...base, outcome: control }));
  assert.ok(padding > 0);
  const outcome = control + "x".repeat(padding);
  const exactStorage = memoryStorage();
  const exact = new ComposerState(exactStorage);
  exact.edit({ projectId, title, outcome });
  await exact.submit(client, "csrf", true);
  assert.equal(posts, 2);
  assert.equal(exact.phase, "unknown");
  assert.equal(byteLength(JSON.stringify(exact.frozen)), 65536);
  assert.ok(readRecovery(exactStorage));
  const over = new ComposerState(memoryStorage());
  over.edit({ projectId, title, outcome: `${outcome}x` });
  await over.submit(client, "csrf", true);
  assert.equal(posts, 2);
  assert.equal(over.phase, "editable");
  assert.match(over.errors.outcome ?? "", /64 KiB/);
});
test("detached creation cannot clear the recovery owned by a replacement composer or publish its receipt", async () => {
  const storage = memoryStorage();
  let notifications = 0;
  const old = new ComposerState(storage, () => notifications++);
  old.edit({ projectId: randomUUID(), title: "Original", outcome: "Finish" });
  let release!: (r: Response) => void;
  const client = new OperatorClient(
    () =>
      new Promise<Response>((done) => {
        release = done;
      }),
  );
  const pending = old.submit(client, "old", false);
  const command = old.frozen;
  assert.ok(command);
  const saved = storage.getItem(storageKey);
  old.dispose();
  const replacement = new ComposerState(storage);
  const count = notifications;
  release(
    Response.json({
      kind: "domain",
      key: command.key,
      recorded: true,
      result: {
        id: command.taskId,
        projectId: command.projectId,
        state: "open",
        ready: false,
        version: 1,
      },
    }),
  );
  await pending;
  assert.equal(notifications, count);
  assert.equal(old.receipt, null);
  assert.equal(storage.getItem(storageKey), saved);
  assert.equal(replacement.phase, "unknown");
  assert.deepEqual(replacement.frozen, command);
  const exposed = replacement.frozen;
  assert.ok(exposed);
  exposed.title = "Redirect attempt";
  const replay = new OperatorClient(async (_url, init) => {
    assert.equal(String(init?.body), JSON.stringify(command));
    return Response.json({
      kind: "domain",
      key: command.key,
      recorded: true,
      result: {
        id: command.taskId,
        projectId: command.projectId,
        state: "open",
        ready: false,
        version: 1,
      },
    });
  });
  await replacement.submit(replay, "new", true);
  assert.equal(replacement.phase, "recorded");
  assert.equal(storage.getItem(storageKey), null);
});
test("initial definite 400 403 and 409 permit correction without an automatic retry", async () => {
  for (const [status, code] of [
    [400, "invalid-input"],
    [403, "forbidden"],
    [409, "conflict"],
  ] as const) {
    const state = new ComposerState(memoryStorage());
    state.edit({
      projectId: randomUUID(),
      title: "Original",
      outcome: "Finish",
    });
    let posts = 0;
    await state.submit(
      new OperatorClient(async () => {
        posts++;
        return Response.json(
          { error: { code, message: "Safe failure" } },
          { status },
        );
      }),
      "csrf",
      false,
    );
    assert.equal(posts, 1);
    assert.equal(state.phase, "editable");
    assert.equal(state.frozen, null);
    state.edit({ title: "Correction" });
    assert.equal(state.input.title, "Correction");
  }
});
test("an assignment-shaped domain receipt cannot confirm task creation", async () => {
  const state = new ComposerState(memoryStorage());
  state.edit({ projectId: randomUUID(), title: "Task", outcome: "Finish" });
  await state.submit(
    new OperatorClient(async (_url, init) => {
      const c = JSON.parse(String(init?.body));
      return Response.json({
        kind: "domain",
        recorded: true,
        key: c.key,
        result: {
          id: c.taskId,
          taskId: c.taskId,
          projectId: c.projectId,
          version: 1,
          profileRevision: 1,
          instructionsRevision: 1,
        },
      });
    }),
    "csrf",
    false,
  );
  assert.equal(state.phase, "unknown");
  assert.equal(state.receipt, null);
});
test("effect reactivation never restores authority to a detached response", async () => {
  const storage = memoryStorage(),
    state = new ComposerState(storage);
  state.edit({ projectId: randomUUID(), title: "Task", outcome: "Finish" });
  let release!: (r: Response) => void;
  const sending = state.submit(
    new OperatorClient(
      () =>
        new Promise<Response>((done) => {
          release = done;
        }),
    ),
    "csrf",
    false,
  );
  const command = state.frozen;
  assert.ok(command);
  state.dispose();
  let notifications = 0;
  state.activate(() => notifications++);
  release(
    Response.json({
      kind: "domain",
      recorded: true,
      key: command.key,
      result: {
        id: command.taskId,
        projectId: command.projectId,
        state: "open",
        ready: false,
        version: 1,
      },
    }),
  );
  await sending;
  assert.equal(notifications, 0);
  assert.equal(state.phase, "unknown");
  assert.ok(storage.getItem(storageKey));
});

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DomainPolicyError, DomainStore } from "../../src/core/domain.js";
import { OperatorApiError } from "../../src/standalone/operator-api.js";

test("typed post-commit notification failure remains unknown through creation consumer and exact API replay records once", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const domain = f.service.domain(),
    projectId = randomUUID();
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Postcommit project",
    leadProfileId: null,
  });
  const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
  t.after(() => db.close());
  let failing = true;
  const injected = new DomainStore(db, () => {
    if (failing)
      throw new DomainPolicyError("forbidden", "SYNTHETIC CALLBACK ERROR");
  });
  const originalExecute = domain.execute;
  domain.execute = (command) => injected.execute(command);
  t.after(() => {
    domain.execute = originalExecute;
  });
  const api = new OperatorApi(f.service, [f.directory]);
  const bodies: string[] = [];
  const client = new OperatorClient(async (_path, init) => {
    bodies.push(String(init?.body));
    try {
      return Response.json(await api.execute(JSON.parse(String(init?.body))));
    } catch (error) {
      assert.ok(error instanceof OperatorApiError);
      assert.equal(error.code, "command-outcome-unknown");
      return Response.json(
        { error: { code: error.code, message: "Outcome unknown" } },
        { status: error.status },
      );
    }
  });
  const state = new ComposerState(memoryStorage());
  state.edit({ projectId, title: "One postcommit task", outcome: "Finish" });
  await state.submit(client, "csrf", false);
  assert.equal(state.phase, "unknown");
  assert.equal(domain.tasks(projectId).length, 1);
  const command = state.frozen;
  assert.ok(command);
  assert.ok(injected.recordedCommand({ ...command, actor: "operator" }));
  failing = false;
  await state.submit(client, "csrf", true);
  assert.equal(state.phase, "recorded");
  assert.deepEqual(bodies, [bodies[0], bodies[0]]);
  assert.equal(domain.tasks(projectId).length, 1);
  assert.equal(domain.task(command.taskId).version, 1);
  await assert.rejects(
    api.execute({ ...command, title: "Different payload" }),
    (error) => error instanceof OperatorApiError && error.status === 409,
  );
  assert.equal(f.runtime.turns, 0);
});
test("savedOnDevice is claimed only after a successful on-device write", () => {
  let fail = false;
  const saved = new Map<string, string>();
  const state = new ComposerState({
    getItem: (k) => saved.get(k) ?? null,
    setItem: (k, v) => {
      if (fail) throw Error("quota");
      saved.set(k, v);
    },
    removeItem: (k) => saved.delete(k),
  });
  assert.equal(state.savedOnDevice, false);
  state.edit({ title: "Saved" });
  assert.equal(state.savedOnDevice, true);
  fail = true;
  state.edit({ title: "Not saved" });
  assert.equal(state.savedOnDevice, false);
  fail = false;
  state.edit({ title: "Saved again" });
  state.discard();
  assert.equal(state.savedOnDevice, false);
});
test("savedOnDevice follows every recovery write around a submission", async () => {
  const saved = new Map<string, string>();
  let failUnfinished = false,
    failUnknown = false;
  const storage = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => {
      const status = JSON.parse(v).status;
      if (
        (failUnfinished && status === "unfinished") ||
        (failUnknown && status === "unknown")
      )
        throw Error("quota");
      saved.set(k, v);
    },
    removeItem: (k: string) => saved.delete(k),
  };
  const rejecting = new OperatorClient(
    async () =>
      new Response(
        JSON.stringify({
          error: { code: "invalid-input", message: "Safe failure" },
        }),
        { status: 400 },
      ),
  );
  const state = new ComposerState(storage);
  state.edit({
    projectId: randomUUID(),
    title: "Saved",
    outcome: "A useful outcome",
  });
  assert.equal(state.savedOnDevice, true);
  // A rejected submission whose recovery write fails clears the claim.
  failUnfinished = true;
  await state.submit(rejecting, "csrf", true);
  assert.equal(state.phase, "editable");
  assert.match(state.notice, /reloading may lose it\.$/);
  assert.equal(state.savedOnDevice, false);
  // A rejected submission whose recovery write succeeds restores it.
  failUnfinished = false;
  await state.submit(rejecting, "csrf", true);
  assert.equal(state.phase, "editable");
  assert.equal(state.savedOnDevice, true);
  // A failed frozen write sends nothing and claims nothing.
  failUnknown = true;
  await state.submit(rejecting, "csrf", true);
  assert.match(state.notice, /nothing was sent/);
  assert.equal(state.savedOnDevice, false);
});

test("every creation outcome reads in plain words and keeps the receipt fields for Details", async () => {
  const plain =
    /recorded|receipt|observation|admission|reconcile|submission|revision|\d|task\.create|conflict|invalid/i;
  const projectId = randomUUID();
  const run = async (
    ready: boolean,
    respond: (command: { key: string; taskId: string }) => Response,
  ) => {
    const state = new ComposerState(memoryStorage());
    state.edit({ projectId, title: "Task", outcome: "Finish" });
    await state.submit(
      new OperatorClient(async (_url, init) =>
        respond(JSON.parse(String(init?.body))),
      ),
      "csrf",
      ready,
    );
    return state;
  };
  const created = (ready: boolean) => (c: { key: string; taskId: string }) =>
    Response.json({
      kind: "domain",
      key: c.key,
      recorded: true,
      result: { id: c.taskId, projectId, version: 1, state: "open", ready },
    });
  const ready = await run(true, created(true));
  assert.equal(ready.phase, "recorded");
  assert.equal(ready.notice, "Task created.");
  assert.equal(ready.details.command, "task.create");
  assert.equal(ready.details.version, 1);
  assert.equal(ready.details.requestKey, ready.frozen?.key);
  assert.equal(ready.details.resource, ready.frozen?.taskId);
  const draft = await run(false, created(false));
  assert.equal(draft.notice, "Draft saved.");
  const refused = await run(true, () =>
    Response.json(
      { error: { code: "forbidden", message: "Safe failure" } },
      { status: 403 },
    ),
  );
  assert.equal(refused.phase, "editable");
  assert.equal(refused.failed, true);
  assert.equal(
    refused.notice,
    "Couldn't create the task: you don't have permission. Your input is still here.",
  );
  assert.equal(refused.details.code, "forbidden");
  const unknown = await run(false, () => Response.error());
  assert.equal(unknown.phase, "unknown");
  assert.equal(
    unknown.notice,
    "We couldn't confirm the draft was saved. Your input is kept until you check.",
  );
  assert.equal(unknown.details.code, "command-outcome-unknown");
  assert.equal(unknown.details.requestKey, unknown.frozen?.key);
  for (const state of [ready, draft, refused, unknown]) {
    assert.doesNotMatch(state.notice, plain, state.notice);
    assert.doesNotMatch(
      state.notice,
      new RegExp(state.details.requestKey ?? "no-key"),
    );
  }
  // A failed attempt says whether the input is kept, and an edit clears it.
  refused.edit({ title: "Again" });
  assert.equal(refused.failed, false);
  assert.equal(refused.notice, "");
});

test("a creation interrupted mid-send restores as unconfirmed with its own request key", async () => {
  const state = new ComposerState(memoryStorage());
  state.edit({ projectId: randomUUID(), title: "Task", outcome: "Finish" });
  // An earlier refused attempt leaves its own key and code behind.
  await state.submit(
    new OperatorClient(async () =>
      Response.json(
        { error: { code: "forbidden", message: "No" } },
        { status: 403 },
      ),
    ),
    "csrf",
    true,
  );
  assert.equal(state.details.code, "forbidden");
  const sending = state.submit(
    new OperatorClient(() => new Promise<Response>(() => {})),
    "csrf",
    true,
  );
  assert.equal(state.phase, "pending");
  state.dispose();
  void sending;
  assert.equal(state.phase, "unknown");
  assert.equal(state.details.requestKey, state.frozen?.key);
  assert.equal(state.details.code, undefined);
});
test("brief limit note threshold counts the encoded outcome, context and links", () => {
  const near = (o: Partial<ReturnType<typeof emptyInput>>) =>
    briefNearLimit({ ...emptyInput(), ...o });
  for (const [length, expected] of [
    [14399, false],
    [14400, true],
    [16000, true],
    [16001, true],
  ] as const)
    assert.equal(near({ outcome: "x".repeat(length) }), expected, `${length}`);
  // The "\n\nContext:\n" separator (11 characters) counts toward the total.
  assert.equal(
    near({ outcome: "x".repeat(14000), context: "y".repeat(388) }),
    false,
  );
  assert.equal(
    near({ outcome: "x".repeat(14000), context: "y".repeat(389) }),
    true,
  );
  const links = [`https://example.com/${"a".repeat(200)}`];
  // The "\n\nReference links (passive context; no repository access):\n" header is 59 characters.
  const link = (n: number) => [`https://example.com/${"a".repeat(n - 20)}`];
  assert.equal(near({ outcome: "x".repeat(14000), links: link(340) }), false);
  assert.equal(near({ outcome: "x".repeat(14000), links: link(341) }), true);
  assert.equal(near({ outcome: "x".repeat(14300) }), false);
  assert.equal(near({ outcome: "x".repeat(14300), links }), true);
  // One length calculation serves the note and the submit check.
  const input = {
    ...emptyInput(),
    outcome: "x".repeat(14400),
    context: "c",
    links,
  };
  assert.equal(composeOutcome(input), encodeOutcome(input));
  assert.throws(
    () => encodeOutcome({ ...emptyInput(), outcome: "x".repeat(16001) }),
    /16,000/,
  );
});
