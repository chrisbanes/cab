import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import { holdPills } from "../../web/src/settings-view.js";
import {
  noPageOverflow,
  phone,
  savedOutcome,
  startSettings,
  trail,
  unpairedBadges,
} from "../fixtures/operator-settings.js";

const test = browserSuite("operator-runtime-recovery-browser");

test("Runtime saves a lowered capacity from a change list and lists recovery destinations", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/settings/runtime",
  );
  await page
    .getByRole("heading", { level: 1, name: "Runtime capacity and recovery" })
    .waitFor();
  assert.equal(await trail(page), "Settings / Runtime");
  await page
    .getByText(/\d+ of \d+ active turns in use; projects default to 2\./)
    .waitFor();
  const save = page.getByRole("button", { name: "Save capacity", exact: true });
  assert.equal(await save.isDisabled(), true);
  await page.getByLabel("Set capacity override for Relay").waitFor();
  await page
    .getByText("Usage 1 / effective limit 2 · Project paused", { exact: false })
    .waitFor();
  // Wait for the runtime rows too, so the guard does not run before their badges exist.
  await page.getByText("Available", { exact: true }).first().waitFor();
  assert.deepEqual(await unpairedBadges(page.locator("main")), []);
  await page
    .getByText(
      "may belong to a held execution; pausing or saving capacity does not release it",
      {
        exact: false,
      },
    )
    .waitFor();
  const global = page.getByLabel("Global active-turn cap", { exact: true });
  const before = await global.inputValue();
  await global.fill("1");
  await page
    .getByRole("region", { name: "Changes to save" })
    .getByText(`Global active-turn cap: ${before} → 1`)
    .waitFor();
  await save.click();
  await savedOutcome(page);
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent === "Save capacity" && b.disabled,
    ),
  );
  assert.equal(await global.inputValue(), "1");
  assert.equal(f.runtime.turns, 0);
  const card = page.locator("article", { hasText: "Restore webhook delivery" });
  await card.getByText("Execution hold recorded").waitFor();
  assert.equal(
    await card.getByRole("link", { name: "Task detail" }).getAttribute("href"),
    `/app/tasks/${ids.taskId}`,
  );
  assert.equal(
    await card
      .getByRole("link", { name: "Task controls" })
      .getAttribute("href"),
    `/runtime/task/${ids.taskId}`,
  );
  assert.equal(
    await card
      .getByRole("link", { name: "Worker: recovery evidence" })
      .getAttribute("href"),
    `/app/assignments/${ids.assignmentId}/recovery`,
  );
  await captureBrowserEvidence(page, "1366-runtime");
});

test("Assignment recovery is read-only, shows the uncertainty alert and five independent holds", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/app/assignments/:assignment/recovery",
  );
  const siblingId = randomUUID();
  f.service.domain().execute({
    type: "assignment.create",
    key: randomUUID(),
    actor: "operator",
    projectId: ids.relay,
    taskId: ids.taskId,
    assignmentId: siblingId,
    profileId: ids.profiles.Worker as string,
    brief: "Sibling work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  } as never);
  f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE execution_intents SET reason = 'Codex runtime unavailable; restart the service' WHERE workId = 'recovery-generation-1'",
    ).run();
    db.prepare(
      "INSERT INTO turn_requests (requestKey,workId,kind,taskId,projectId,assignmentId,taskVersion,assignmentVersion,instructionsRevision,profileRevision,prompt,state,reason) VALUES ('recovery-generation-1-key','recovery-generation-1','assignment',?,?,?,1,1,1,1,'p','held','Codex runtime unavailable; restart the service')",
    ).run(ids.taskId, ids.relay, ids.assignmentId);
    const move = db.prepare(
      "UPDATE task_execution_bindings SET assignmentId = ? WHERE workId = ?",
    );
    for (let n = 2; n <= 21; n++)
      move.run(siblingId, `recovery-generation-${n}`);
    const workId = "sibling-generation-21";
    db.prepare(
      "INSERT INTO execution_intents (id,workId,prompt,workspace,state,reason,threadId,turnId,accountType,sandbox,approval) VALUES (?,?,'p','/w','completed','r',NULL,NULL,'chatgpt','workspaceWrite','never')",
    ).run(randomUUID(), workId);
    db.prepare(
      "INSERT INTO execution_recovery_identities (workId,workRevision,requestSequence,processId,processStartedAt,bootId,threadId,turnId) VALUES (?,1,1000,'p','s','b',NULL,NULL)",
    ).run(workId);
    db.prepare(
      "INSERT INTO task_execution_bindings (workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision) VALUES (?,?,?,1,1,1,1)",
    ).run(workId, ids.taskId, siblingId);
  });
  await page.reload();
  await page
    .getByRole("heading", { level: 1, name: "Assignment recovery evidence" })
    .waitFor();
  assert.equal(await trail(page), "Settings / Runtime / Assignment recovery");
  const read = (await (
    await page.request.get(
      `${web.origin}/api/operator/assignments/${ids.assignmentId}/recovery`,
    )
  ).json()) as {
    data: {
      holds: Parameters<typeof holdPills>[0];
      omittedCount: number;
      records: Array<{
        workId: string | null;
        generation: { requestSequence: number | null };
      }>;
    };
  };
  assert.equal(read.data.holds.uncertainty, true);
  assert.deepEqual(
    read.data.records.map((r) => r.generation.requestSequence),
    [1],
  );
  assert.equal(read.data.omittedCount, 0);
  await page.getByText("Execution may still be active.").waitFor();
  assert.deepEqual(await unpairedBadges(page.locator("main")), []);
  const pills = await page
    .locator(".settings-pill")
    .evaluateAll((es) => es.map((e) => e.textContent));
  assert.deepEqual(
    pills,
    holdPills(read.data.holds).map((h) => `${h.label}${h.value}`),
  );
  await page.getByText("Versions and generation in use").waitFor();
  assert.doesNotMatch(
    await page.locator("main").innerText(),
    /admitted generation|instruction revision|profile revision/,
  );
  await page.getByRole("heading", { name: "Task-wide holds" }).waitFor();
  await page
    .getByRole("heading", { name: "Selected assignment evidence" })
    .waitFor();
  assert.equal(
    await page.getByText("Generation 1; request 1", { exact: true }).count(),
    1,
  );
  assert.equal(
    await page
      .getByRole("link", { name: "Inspect execution" })
      .getAttribute("href"),
    `/app/tasks/${ids.taskId}?assignment=${ids.assignmentId}`,
  );
  const hrefs = await page
    .getByRole("complementary", {
      name: "Advanced destinations · desktop-first",
    })
    .getByRole("link")
    .evaluateAll((es) => es.map((e) => e.getAttribute("href")));
  assert.deepEqual(hrefs, [
    `/runtime/assignment/${ids.assignmentId}`,
    `/runtime/task/${ids.taskId}`,
    `/app/tasks/${ids.taskId}?assignment=${ids.assignmentId}#history`,
    `/app/tasks/${ids.taskId}?assignment=${ids.assignmentId}`,
    `/assignment/${ids.assignmentId}`,
  ]);
  assert.equal(await page.locator("main form").count(), 0);
  assert.deepEqual(await page.locator("main button").allInnerTexts(), [
    "Refresh",
  ]);
  assert.equal((await page.content()).includes("PRIVATE"), false);

  await page
    .getByRole("link", { name: "Inspect execution", exact: true })
    .click();
  const recoveryLink = page
    .getByRole("link", { name: "Recovery", exact: true })
    .first();
  await recoveryLink.waitFor();
  assert.equal(
    await recoveryLink.getAttribute("href"),
    `/app/assignments/${ids.assignmentId}/recovery`,
  );
  await recoveryLink.click();
  await page
    .getByRole("heading", { name: "Selected assignment evidence" })
    .waitFor();
  assert.equal(
    await page.getByText("Generation 1; request 1", { exact: true }).count(),
    1,
  );

  await page.goto(`${web.origin}/app/settings/runtime`);
  await page
    .locator(`a[href="/app/assignments/${siblingId}/recovery"]`)
    .first()
    .click();
  await page.getByRole("heading", { name: "Task-wide holds" }).waitFor();
  await page
    .getByRole("heading", { name: "Selected assignment evidence" })
    .waitFor();
  const siblingRead = (await (
    await page.request.get(
      `${web.origin}/api/operator/assignments/${siblingId}/recovery`,
    )
  ).json()) as {
    data: {
      holds: Parameters<typeof holdPills>[0];
      omittedCount: number;
      records: Array<{
        workId: string | null;
        generation: { requestSequence: number | null };
      }>;
    };
  };
  assert.equal(siblingRead.data.records.length, 20);
  assert.ok(
    siblingRead.data.records.every(
      (r) =>
        r.workId?.startsWith("recovery-generation-") ||
        r.workId === "sibling-generation-21",
    ),
  );
  assert.equal(siblingRead.data.omittedCount, 1);
  assert.equal(siblingRead.data.holds.writer, true);
  assert.equal(siblingRead.data.holds.capacity, true);
  assert.equal(siblingRead.data.holds.uncertainty, true);
  await page.getByText("Execution may still be active.").waitFor();
  assert.equal(
    await page.getByText("Generation 1; request 1", { exact: true }).count(),
    0,
  );
  assert.match(
    await page.getByText(/for this assignment omitted/).innerText(),
    /task-wide holds above include verified sibling and omitted generations/,
  );
  // Identical older generations collapse under one expandable summary; the newest stays shown.
  const evidence = page.locator("section", {
    has: page.getByRole("heading", { name: "Selected assignment evidence" }),
  });
  const cards = evidence.locator("article.settings-row:visible");
  const summary = evidence.locator("summary", {
    hasText: /^\d+ older records?, same state$/,
  });
  assert.equal(await summary.count(), 1);
  const olderCount = Number(
    (await summary.innerText()).match(/^(\d+) older/)?.[1],
  );
  const total = siblingRead.data.records.length;
  assert.ok(olderCount > 0);
  assert.equal((await cards.count()) + olderCount, total);
  const newest = siblingRead.data.records.at(-1) as unknown as {
    generation: { workRevision: number | null; requestSequence: number };
  };
  await evidence
    .getByRole("heading", {
      name: `Generation ${newest.generation.workRevision}; request ${newest.generation.requestSequence}`,
      exact: true,
    })
    .first()
    .waitFor();
  await summary.click();
  assert.equal(await cards.count(), total);
  assert.equal(
    await page
      .getByRole("link", { name: "Task detail", exact: true })
      .getAttribute("href"),
    `/app/tasks/${ids.taskId}?assignment=${siblingId}`,
  );
  const siblingHrefs = await page
    .getByRole("complementary", {
      name: "Advanced destinations · desktop-first",
    })
    .getByRole("link")
    .evaluateAll((es) => es.map((e) => e.getAttribute("href")));
  assert.deepEqual(siblingHrefs, [
    `/runtime/assignment/${siblingId}`,
    `/runtime/task/${ids.taskId}`,
    `/app/tasks/${ids.taskId}?assignment=${siblingId}#history`,
    `/app/tasks/${ids.taskId}?assignment=${siblingId}`,
    `/assignment/${siblingId}`,
  ]);
  await captureBrowserEvidence(page, "1366-recovery");
});

test("Assignment recovery reads witnesses and missing evidence in plain words", async (_t, journey) => {
  const { page } = await startSettings(
    journey,
    "/app/assignments/:assignment/recovery",
  );
  await page
    .getByRole("heading", { level: 1, name: "Assignment recovery evidence" })
    .waitFor();
  const preTurn = randomUUID(),
    noTurn = randomUUID();
  // Witness adoption needs a held runtime generation; the copy only needs the read's fields.
  let evidence: "witnesses" | "none" = "witnesses";
  await page.route("**/api/operator/assignments/*/recovery", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (evidence === "witnesses") {
      assert.ok(body.data.records.length >= 2);
      body.data.records[0].preTurnRejection = {
        id: preTurn,
        source: "runtime",
        predecessorThreadId: "thread-1",
      };
      body.data.records[1].noTurnSubmission = {
        id: noTurn,
        source: "operator-adopted",
        idleThreadMayExist: true,
      };
    } else {
      body.data.evidenceAvailable = false;
      body.data.records = [];
      body.data.omittedCount = 0;
      body.data.assignment.executionGeneration = null;
    }
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  const witness = async (title: string) =>
    (
      await page.getByRole("region", { name: title, exact: true }).innerText()
    ).replace(/\s+/g, " ");
  assert.equal(
    await witness("Before-turn refusal"),
    `Before-turn refusal Witness ${preTurn} · from the runtime The runtime refused to resume the archived conversation before any turn was sent. This attempt never reached a turn. Evidence only. It doesn't recover the assignment or allow new work.`,
  );
  assert.equal(
    await witness("No turn sent"),
    `No turn sent Witness ${noTurn} · added by an operator An operator confirmed that no turn was sent for this attempt. An idle conversation may still exist that cab hasn't seen. Evidence only. It doesn't recover the assignment or allow new work.`,
  );
  evidence = "none";
  await page.reload();
  await page
    .getByText("We can't show recovery details for this assignment.", {
      exact: true,
    })
    .waitFor();
  await page
    .getByText(
      "No recovery record was found. That alone doesn't mean the execution ended or that its holds were released.",
      { exact: false },
    )
    .waitFor();
  await page
    .getByText(
      "Generation in use: Unavailable. No turn request for this assignment was accepted with its versions, so the generation in use can't be named. This doesn't mean the execution ended.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.getByText("Witness", { exact: false }).count(), 0);
});

test("phone recovery shows Recovery, current holds and the next step", async (_t, journey) => {
  const { page } = await startSettings(
    journey,
    "/app/assignments/:assignment/recovery",
    phone,
  );
  await page.getByRole("heading", { level: 1, name: "Recovery" }).waitFor();
  await page.getByRole("link", { name: "Back to Runtime" }).waitFor();
  await page.getByRole("complementary", { name: "Task-wide holds" }).waitFor();
  await page.getByRole("region", { name: "Next step" }).waitFor();
  const height = await page
    .getByRole("link", { name: "Inspect execution" })
    .evaluate((e) => e.getBoundingClientRect().height);
  assert.ok(height >= 44, `Inspect execution is ${height}px`);
  assert.equal(await page.getByText("Copy desktop link").count(), 0);
  await noPageOverflow(page);
  await captureBrowserEvidence(page, "390-recovery");
});
