import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import { runtimeOperatorRoutes } from "../../src/standalone/operator-runtime.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { holdPills } from "../../web/src/settings-view.js";
import { openOverviewCard } from "../fixtures/task-tabs.js";
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
    `/app/tasks/${ids.taskId}?section=execution`,
  );
  assert.equal(
    await card
      .getByRole("link", { name: "Worker: recovery evidence" })
      .getAttribute("href"),
    `/app/assignments/${ids.assignmentId}/recovery`,
  );
  await captureBrowserEvidence(page, "1366-runtime");
  // Task controls opens the task's Execution tab, which keeps the recorded holds in view.
  await card.getByRole("link", { name: "Task controls" }).click();
  await page.getByRole("tab", { name: "Execution", selected: true }).waitFor();
  const execution = page.locator("section#execution");
  await execution.getByText("Writer ownership", { exact: true }).waitFor();
  await captureBrowserEvidence(page, "1366-task-execution-held");
});

test("Assignment recovery shows the uncertainty alert and five independent holds", async (_t, journey) => {
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
  await page.getByRole("heading", { name: "Execution and assignment" }).waitFor();
  await page.getByText(/This does not confirm admission/).waitFor();
  await page.getByText(/Effects may continue while an execution is stopping/).waitFor();
  await page.getByText(/they do not prove that a process has terminated/).waitFor();
  await page.getByText(/through the CLI recovery-options read/).waitFor();
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
    `/app/tasks/${ids.taskId}?section=execution`,
    `/app/tasks/${ids.taskId}?assignment=${ids.assignmentId}`,
    `/app/tasks/${ids.taskId}?assignment=${ids.assignmentId}`,
    `/assignment/${ids.assignmentId}`,
  ]);
  assert.equal(await page.locator("main form").count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "Review reconciliation", exact: true })
      .isDisabled(),
    true,
  );
  // Options now deliberately expose exact opaque process/thread/turn identities;
  // private prompt, reason and workspace prose must still never reach the page.
  assert.doesNotMatch(
    await page.content(),
    /PRIVATE (?:RECOVERY PROMPT|RECOVERY REASON|OBSERVATION REASON)|\/PRIVATE\/RECOVERY\/PATH/,
  );

  await page
    .getByRole("link", { name: "Inspect execution", exact: true })
    .click();
  // The assignment's execution notices, with its Recovery link, sit in the Assignments card.
  await openOverviewCard(page, "assignments");
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
    `/app/tasks/${ids.taskId}?section=execution`,
    `/app/tasks/${ids.taskId}?assignment=${siblingId}`,
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

for (const engine of ["chromium", "webkit"] as const) {
  test(
    `bound-turn review keeps proof on cancel, refusal and lost reply (${engine})`,
    { browserEngine: engine },
    async (_t, journey) => {
      const { webkit, chromium } = await import("playwright");
      const { page, f, ids } = await startSettings(
        journey,
        "/app/assignments/:assignment/recovery",
        { width: 1366, height: 900 },
        () => (engine === "webkit" ? webkit : chromium).launch(),
      );
      let posts: Array<Record<string, unknown>> = [],
        reads = 0,
        recorded = false,
        refuse = true,
        readUnavailable = true;
      const responseReceipt = (c: Record<string, unknown>) => ({
        kind: "recovery-resolution",
        key: c.key,
        recorded: true,
        path: "bound-turn-recover",
        assignmentId: c.assignmentId,
        workId: (c.receipt as { workId: string }).workId,
        receiptId: "14f1b0e1-3597-4469-9489-c3685e36684b",
        state: "reconciled",
      });
      await page.route("**/recovery-options", async (route) => {
        const result = await route.fetch();
        const body = await result.json();
        const record = body.data.records[0];
        body.data.gaps = [];
        record.workId = "reviewed-work";
        record.threadId = "exact-thread";
        record.turnId = "exact-turn";
        record.process = {
          processId: "12345",
          processStartedAt: "exact-birth",
          bootId: "exact-boot",
        };
        record.paths = [
          { path: "bound-turn-recover", eligible: true, blockedBy: [] },
        ];
        body.data.records = [record];
        await route.fulfill({ json: body });
      });
      await page.route("**/api/operator/commands", async (route) => {
        const c = route.request().postDataJSON();
        posts.push(c);
        if (refuse)
          await route.fulfill({
            status: 409,
            json: { error: { code: "conflict", message: "State changed" } },
          });
        else {
          recorded = true;
          await route.abort("failed");
        }
      });
      await page.route("**/api/operator/operations?**", async (route) => {
        reads++;
        const query = new URL(route.request().url()).searchParams;
        assert.equal(query.get("scope"), `assignment:${ids.assignmentId}`);
        assert.equal(query.get("key"), posts[0]?.key);
        if (readUnavailable) {
          await route.fulfill({
            status: 503,
            json: {
              error: { code: "unavailable", message: "Read unavailable" },
            },
          });
          return;
        }
        await route.fulfill({
          json: {
            data: recorded
              ? { state: "recorded", receipt: responseReceipt(posts[0]!) }
              : { state: "not-recorded" },
            observedAt: Date.now(),
          },
        });
      });
      await page.reload();
      const panel = page.locator(".settings-panel").filter({
        has: page.getByRole("heading", {
          name: "Reconcile a bound turn",
          exact: true,
        }),
      });
      await panel.getByText(/Eligible for review/).waitFor();
      await panel
        .getByLabel("I independently confirmed this exact process exited")
        .check();
      await panel.getByLabel("All effects and callbacks are settled").check();
      await panel.getByLabel("Workspace disposition").selectOption("preserved");
      const review = panel.getByRole("button", {
        name: "Review reconciliation",
        exact: true,
      });
      await review.click();
      const dialog = page.getByRole("alertdialog");
      await dialog
        .getByRole("button", { name: "Cancel", exact: true })
        .waitFor();
      assert.equal(
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .evaluate((e) => e === document.activeElement),
        true,
      );
      await captureBrowserEvidence(page, `1366-bound-review-${engine}`);
      await page.setViewportSize(phone);
      await noPageOverflow(page);
      await captureBrowserEvidence(page, `390-bound-review-${engine}`);
      await page.keyboard.press("Enter");
      await dialog.waitFor({ state: "hidden" });
      assert.equal(posts.length, 0);
      await page.setViewportSize({ width: 1366, height: 900 });
      await page.waitForFunction(
        () => document.activeElement?.textContent === "Review reconciliation",
      );
      assert.equal(
        await review.evaluate((e) => e === document.activeElement),
        true,
      );
      assert.equal(
        await panel
          .getByLabel("All effects and callbacks are settled")
          .isChecked(),
        true,
      );
      await review.click();
      await dialog
        .getByRole("button", { name: "Confirm reconciliation" })
        .click();
      await panel.getByText(/Recovery refused/).waitFor();
      assert.equal(posts.length, 1);
      assert.equal(
        await panel.getByLabel("Workspace disposition").isDisabled(),
        true,
      );
      assert.equal(
        await panel
          .getByRole("button", { name: "Retry exact recovery" })
          .count(),
        0,
      );
      await panel
        .getByRole("button", { name: "Check original receipt" })
        .click();
      await panel.getByText(/Receipt readback unavailable/).waitFor();
      assert.equal(
        await panel
          .getByRole("button", { name: "Retry exact recovery" })
          .count(),
        0,
      );
      readUnavailable = false;
      await panel
        .getByRole("button", { name: "Check original receipt" })
        .click();
      await panel
        .getByRole("button", { name: "Retry exact recovery" })
        .waitFor();
      assert.equal(reads, 2);
      refuse = false;
      await panel.getByRole("button", { name: "Retry exact recovery" }).click();
      await panel.getByText(/Outcome unknown/).waitFor();
      assert.deepEqual(posts[1], posts[0]);
      assert.equal(
        await panel
          .getByRole("button", { name: "Retry exact recovery" })
          .count(),
        0,
      );
      await panel.locator("details").evaluate((e) => {
        (e as HTMLDetailsElement).open = true;
      });
      await captureBrowserEvidence(page, `1366-bound-recovery-${engine}`);
      await page.setViewportSize(phone);
      await panel.scrollIntoViewIfNeeded();
      await noPageOverflow(page);
      await captureBrowserEvidence(page, `390-bound-recovery-${engine}`);
      await page.route("**/recovery-options", async (route) => {
        const result = await route.fetch(),
          body = await result.json();
        body.data.records = [];
        await route.fulfill({ json: body });
      });
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await panel.getByText(/identity changed/).waitFor();
      assert.equal(
        await panel
          .getByRole("button", { name: "Check original receipt" })
          .count(),
        1,
      );
      await panel
        .getByRole("button", { name: "Check original receipt" })
        .click();
      await panel.getByText(/Execution reconciled/).waitFor();
      assert.equal(reads, 3);
      assert.equal(posts.length, 2);
      assert.equal(f.runtime.turns, 0);
      assert.equal(
        await panel
          .getByRole("button", { name: "Check original receipt" })
          .count(),
        0,
      );
    },
  );
}

test("bound recovery blocks redacted, missing and refreshed identities without transferring proof", async (_t, journey) => {
  const { page, f } = await startSettings(
    journey,
    "/app/assignments/:assignment/recovery",
  );
  let mode: "redacted" | "missing" | "eligible" | "changed" = "redacted",
    posts = 0;
  await page.route("**/recovery-options", async (route) => {
    const result = await route.fetch(),
      body = await result.json(),
      r = body.data.records[0];
    body.data.gaps = mode === "redacted" ? ["content-redacted"] : [];
    r.workId = "fixed-work";
    r.threadId = "fixed-thread";
    r.turnId = mode === "changed" ? "changed-turn" : "fixed-turn";
    r.process =
      mode === "missing"
        ? null
        : {
            processId: "12345",
            processStartedAt: "fixed-birth",
            bootId: "fixed-boot",
          };
    r.paths = [
      {
        path: "bound-turn-recover",
        eligible: mode !== "missing",
        blockedBy: mode === "missing" ? ["bound-identity-missing"] : [],
      },
    ];
    body.data.records = [r];
    await route.fulfill({ json: body });
  });
  await page.route("**/api/operator/commands", (route) => {
    posts++;
    return route.abort();
  });
  const panel = page.locator(".settings-panel").filter({
    has: page.getByRole("heading", {
      name: "Reconcile a bound turn",
      exact: true,
    }),
  });
  await page.reload();
  await panel.getByText(/content-redacted/).waitFor();
  await page.setViewportSize(phone);
  await noPageOverflow(page);
  await captureBrowserEvidence(page, "390-bound-blocked");
  await page.setViewportSize({ width: 1366, height: 900 });
  assert.equal(
    await panel
      .getByRole("button", { name: "Review reconciliation", exact: true })
      .isDisabled(),
    true,
  );
  mode = "missing";
  await page.reload();
  await panel.getByText(/bound-identity-missing/).waitFor();
  assert.equal(
    await panel
      .getByLabel("I independently confirmed this exact process exited")
      .isDisabled(),
    true,
  );
  mode = "eligible";
  await page.reload();
  await panel.getByText(/Eligible for review/).waitFor();
  await panel
    .getByLabel("I independently confirmed this exact process exited")
    .check();
  await panel.getByLabel("All effects and callbacks are settled").check();
  await panel.getByLabel("Workspace disposition").selectOption("preserved");
  await panel
    .getByRole("button", { name: "Review reconciliation", exact: true })
    .click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  mode = "changed";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await panel.getByText(/identity changed/).waitFor();
  assert.equal(
    await panel
      .getByRole("button", { name: "Review reconciliation", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await panel.getByLabel("All effects and callbacks are settled").isChecked(),
    true,
  );
  assert.equal(posts, 0);
  assert.equal(f.runtime.turns, 0);
});

test("retained HTML review cancels without a write and keeps the original request on refusal", async (_t, journey) => {
  const { page, f, ids, web } = await startSettings(
    journey,
    "/app/assignments/:assignment/recovery",
  );
  const api = new OperatorApi(f.service, [f.directory]);
  const options = await api.readRecoveryOptions(ids.assignmentId);
  const r = options.data.records[0]!;
  r.workId = "retained-review-work";
  r.threadId = "retained-thread";
  r.turnId = "retained-turn";
  r.process = {
    processId: "23456",
    processStartedAt: "retained-birth",
    bootId: "retained-boot",
  };
  r.paths = [{ path: "bound-turn-recover", eligible: true, blockedBy: [] }];
  options.data.records = [r];
  options.data.gaps = [];
  // Browser coverage of native HTML/forms. T3 and the adjacent retained-handler test own real mutation rules.
  const routes = runtimeOperatorRoutes(f.service, {
    readRecoveryOptions: async () => options,
    readOperation: (q) => api.readOperation(q),
  });
  const template = await (
    await page.request.get(
      `${web.origin}/runtime/assignment/${ids.assignmentId}`,
    )
  ).text();
  const submitted: string[] = [];
  await page.route("**/runtime/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    const matched = routes.find(
      (r) =>
        r.method === route.request().method() &&
        (r.path === path ||
          (r.path === "/runtime/assignment/:assignmentId" &&
            path === `/runtime/assignment/${ids.assignmentId}`)),
    );
    if (!matched) return route.continue();
    const fields = Object.fromEntries(
      new URLSearchParams(route.request().postData() ?? ""),
    );
    delete fields.csrfToken;
    if (path.endsWith("/recover")) submitted.push(fields.payload!);
    const result = await matched.handler({
      params: { assignmentId: ids.assignmentId },
      fields,
      csrfToken: "fixture-csrf",
    });
    assert.equal(result.kind, "html");
    if (result.kind !== "html") throw Error("Expected retained HTML");
    await route.fulfill({
      contentType: "text/html",
      body: template.replace(/<main>[\s\S]*<\/main>/, result.body),
    });
  });
  await page.goto(`${web.origin}/runtime/assignment/${ids.assignmentId}`);
  const prepare = async () => {
    await page
      .getByLabel("I independently confirmed this exact process exited")
      .check();
    await page.getByLabel("All effects and callbacks are settled").check();
    await page.getByLabel("Workspace disposition").selectOption("preserved");
    await page.getByRole("button", { name: "Review reconciliation" }).focus();
    await page.keyboard.press("Enter");
    await page
      .getByRole("heading", { name: "Bound-turn reconciliation" })
      .waitFor();
  };
  await prepare();
  await page.waitForFunction(
    () =>
      document.activeElement?.textContent === "Cancel and return to evidence",
  );
  await captureBrowserEvidence(page, "1366-retained-review");
  await page.setViewportSize(phone);
  await noPageOverflow(page);
  await captureBrowserEvidence(page, "390-retained-review");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Review reconciliation" }).waitFor();
  assert.equal(submitted.length, 0);
  await prepare();
  await page.getByRole("button", { name: "Confirm reconciliation" }).focus();
  await page.keyboard.press("Enter");
  await page.getByText(/Recovery refused or outcome unknown/).waitFor();
  assert.equal(submitted.length, 1);
  const original = JSON.parse(submitted[0]!);
  await page.getByRole("button", { name: "Check original receipt" }).click();
  await page.getByText(/No receipt is recorded/).waitFor();
  await page.getByRole("button", { name: "Confirm reconciliation" }).click();
  await page.getByText(/Recovery refused or outcome unknown/).waitFor();
  assert.deepEqual(JSON.parse(submitted[1]!), original);
  assert.equal(f.runtime.turns, 0);
});
