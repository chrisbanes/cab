import { browserTest } from "../fixtures/browser-engines.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout, clearTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import { chromium, webkit } from "playwright";
import {
  killBrowser,
  launchedBrowserProcess,
  runBrowserJourney,
} from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { tmpdir } from "../fixtures/temp.js";

browserTest(
  "timed-out execution preserves a live client and writes sanitized bounded diagnostics",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cab-browser-diagnostics-"));
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const secret = "SYNTHETIC_SECRET_MUST_NOT_BE_ARTIFACTED";
    let finish!: () => void;
    let cleanups = 0;
    let callbackFinished!: () => void;
    const callbackDone = new Promise<void>((resolve) => {
      callbackFinished = resolve;
    });
    let guardian: ReturnType<typeof setTimeout> | number | undefined;
    // Generous overall headroom keeps slow setup under load from shrinking the execution limit under test.
    const executionMs = 500;
    const overallMs = 3000;
    const started = performance.now();
    const pending = runBrowserJourney(
      "diagnostics",
      "synthetic stalled action",
      async (journey) => {
        journey.observe(page);
        journey.cleanup(async () => {
          cleanups++;
          await browser.close();
        });
        const pageError = page.waitForEvent("pageerror");
        await page.evaluate((marker) => {
          console.error(`fixture-console-error ${marker}`);
          setTimeout(() => {
            throw new TypeError(`fixture-page-error ${marker}`);
          }, 0);
        }, secret);
        await pageError;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        assert.equal(await journey.capture(page, "late-screenshot"), undefined);
        callbackFinished();
      },
      {
        executionMs,
        overallMs,
        cleanupStepMs: 100,
        evidenceRoot: root,
      },
    );
    try {
      const failure = await Promise.race([
        pending.then(
          () => undefined,
          (error: unknown) => error,
        ),
        new Promise<undefined>((resolve) => {
          guardian = setTimeout(resolve, overallMs + 1000);
        }),
      ]);
      assert.ok(
        failure instanceof Error,
        "Journey must stop waiting at its own deadline",
      );
      assert.match(failure.message, /execution.*timed-out.*\d+ ms/);
      assert.ok(performance.now() - started < overallMs);
      assert.equal(cleanups, 0);
      assert.equal(browser.isConnected(), true);
      const directory = (failure as Error & { evidenceDirectory: string })
        .evidenceDirectory;
      const manifest = await readFile(join(directory, "manifest.json"), "utf8");
      assert.doesNotMatch(manifest, new RegExp(secret));
      const evidence = JSON.parse(manifest);
      assert.equal(evidence.phases.execution.status, "timed-out");
      assert.ok(evidence.phases.execution.elapsedMs >= executionMs - 1);
      assert.equal(evidence.cleanup.incomplete, true);
      assert.equal(evidence.cleanup.steps[0].status, "dependency-skipped");
      assert.match(manifest, /console-error|pageerror-TypeError/);
      finish();
      await callbackDone;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const phases = (
        failure as Error & {
          phases?: {
            execution: { status: string; eventual?: { status: string } };
          };
        }
      ).phases;
      assert.ok(
        phases,
        "The underlying operation outcome must remain observable",
      );
      assert.equal(phases?.execution.status, "timed-out");
      assert.equal(phases.execution.eventual?.status, "completed");
      assert.equal(
        await readFile(join(directory, "manifest.json"), "utf8"),
        manifest,
      );
      assert.equal(
        (await readdir(directory)).includes("late-screenshot.png"),
        false,
      );
      assert.equal(cleanups, 0);
    } finally {
      clearTimeout(guardian);
      finish?.();
      await pending.catch(() => {});
      await browser.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

browserTest(
  "screenshot failure remains secondary and a non-diagnostic root is rejected",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cab-screenshot-failure-"));
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.close();
    const original = Error("Original assertion after screenshot failure");
    try {
      await assert.rejects(
        runBrowserJourney(
          "diagnostics",
          "closed synthetic page",
          async (journey) => {
            await journey.capture(page, "closed-page");
            throw original;
          },
          { evidenceRoot: root },
        ),
        (error: unknown) => {
          assert.equal(error, original);
          assert.ok(original.cause instanceof AggregateError);
          assert.match(
            String(original.cause.errors[1]),
            /evidence.screenshot: failed/,
          );
          return true;
        },
      );
      const privateRoot = await mkdtemp(join(root, "fixture-"));
      await writeFile(
        join(privateRoot, "private-fixture.sqlite"),
        "SYNTHETIC_PRIVATE_FIXTURE",
      );
      let ran = false;
      await assert.rejects(
        runBrowserJourney(
          "diagnostics",
          "unowned root",
          async () => {
            ran = true;
          },
          { evidenceRoot: privateRoot },
        ),
        /dedicated to test diagnostics/,
      );
      assert.equal(ran, false);
      assert.deepEqual(await readdir(privateRoot), ["private-fixture.sqlite"]);
    } finally {
      await browser.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("local listener rejection preserves the assertion and backing state while other listeners close", async () => {
  const root = await mkdtemp(join(tmpdir(), "cab-local-cleanup-"));
  const calls: string[] = [];
  const original = Error("Original local fixture assertion");
  try {
    await assert.rejects(
      runBrowserJourney(
        "diagnostics",
        "local listener failure",
        async (journey) => {
          journey.ownLocal({
            browser: async () => {
              calls.push("browser");
            },
            listeners: [
              {
                name: "first.close",
                close: async () => {
                  calls.push("first");
                  throw Error("Injected listener rejection");
                },
              },
              {
                name: "second.close",
                close: async () => {
                  calls.push("second");
                },
              },
            ],
            auth: () => {
              calls.push("auth");
            },
            state: async () => {
              calls.push("state");
            },
            directory: () => {
              calls.push("directory");
            },
          });
          throw original;
        },
        { evidenceRoot: root },
      ),
      (error: unknown) => {
        assert.equal(error, original);
        assert.ok(original.cause instanceof AggregateError);
        assert.match(
          String((original.cause.errors[1] as Error).cause),
          /first.close: failed|state.close: dependency-skipped/,
        );
        return true;
      },
    );
    assert.deepEqual(calls, ["browser", "first", "second"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A local journey whose browser.close never settles; kill decides what follows. */
async function stalledBrowserClose(kill: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "cab-stalled-browser-"));
  const calls: string[] = [];
  const original = Error("Original assertion before a stalled browser close");
  try {
    const started = performance.now();
    await assert.rejects(
      runBrowserJourney(
        "diagnostics",
        "stalled browser close",
        async (journey) => {
          journey.ownLocal({
            browser: () => {
              calls.push("browser");
              return new Promise<void>(() => {});
            },
            killBrowser: async () => {
              calls.push("kill");
              await kill();
            },
            listeners: [
              {
                name: "http.stop",
                close: async () => {
                  calls.push("http");
                },
              },
            ],
            auth: () => {
              calls.push("auth");
            },
            state: async () => {
              calls.push("state");
            },
            directory: () => {
              calls.push("directory");
            },
          });
          throw original;
        },
        { evidenceRoot: root, cleanupStepMs: 50, overallMs: 3000 },
      ),
      (error: unknown) => error === original,
    );
    assert.ok(performance.now() - started < 2000);
    const directory = (original as Error & { evidenceDirectory: string })
      .evidenceDirectory;
    const evidence = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    ) as { cleanup: { steps: Array<{ name: string; status: string }> } };
    const steps = Object.fromEntries(
      evidence.cleanup.steps.map((step) => [step.name, step.status]),
    );
    return { calls, steps };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a stalled browser close is killed before the remaining local cleanup runs", async () => {
  const { calls, steps } = await stalledBrowserClose(async () => {});
  assert.deepEqual(calls, [
    "browser",
    "kill",
    "http",
    "auth",
    "state",
    "directory",
  ]);
  assert.deepEqual(steps, {
    "browser.close": "timed-out",
    "browser.kill": "completed",
    "http.stop": "completed",
    "auth.close": "completed",
    "state.close": "completed",
    "directory.remove": "completed",
    "local-fixture.close": "failed",
  });
});

test("an unconfirmed browser kill keeps listeners, auth and backing state held", async () => {
  const { calls, steps } = await stalledBrowserClose(
    () => new Promise<void>(() => {}),
  );
  assert.deepEqual(calls, ["browser", "kill"]);
  assert.deepEqual(steps, {
    "browser.close": "timed-out",
    "browser.kill": "timed-out",
    "http.stop": "dependency-skipped",
    "auth.close": "dependency-skipped",
    "state.close": "dependency-skipped",
    "directory.remove": "dependency-skipped",
    "local-fixture.close": "failed",
  });
});

test("a test file holding a stalled journey's state exits promptly under the runner's flags", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cab-held-journey-"));
  const harness = join(directory, "held.test.mjs");
  const fixture = new URL(
    "../fixtures/browser-diagnostics.js",
    import.meta.url,
  );
  // The interval stands in for a listener the unconfirmed client may still use.
  await writeFile(
    harness,
    `import { test } from "node:test";
import { runBrowserJourney } from ${JSON.stringify(fixture.href)};
const held = setInterval(() => {}, 1000);
test("held journey", () =>
  runBrowserJourney("diagnostics", "held journey", async (journey) => {
    journey.ownLocal({
      browser: () => new Promise(() => {}),
      killBrowser: () => new Promise(() => {}),
      listeners: [{ name: "http.stop", close: async () => clearInterval(held) }],
    });
    throw Error("Original held journey failure");
  }, { evidenceRoot: ${JSON.stringify(join(directory, "evidence"))}, cleanupStepMs: 50, overallMs: 3000 }));
`,
  );
  const { testFileFlags } = (await import(
    pathToFileURL(resolve("scripts/run-tests.mjs")).href
  )) as { testFileFlags: string[] };
  // An inherited NODE_TEST_CONTEXT makes the nested `node --test` skip its files.
  const { NODE_TEST_CONTEXT: _context, ...environment } = process.env;
  const child = spawn(process.execPath, [...testFileFlags, harness], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  try {
    const [code] = await once(child, "exit", {
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(code, 1, output);
    assert.match(output, /Original held journey failure/);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
] as const)
  browserTest(
    `killBrowser ends a ${engine} browser whose close has stalled`,
    { browserEngine: engine },
    async () => {
      const browser = await type.launch();
      const child = launchedBrowserProcess(browser);
      let closing: Promise<unknown> | undefined;
      try {
        assert.ok(child?.pid);
        // A stopped browser never answers close, as in the stalled WebKit runs.
        process.kill(-child.pid, "SIGSTOP");
        closing = browser.close().catch(() => undefined);
        const stalled = await Promise.race([
          closing.then(() => false),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(true), 500),
          ),
        ]);
        assert.ok(stalled);
        await killBrowser(browser);
        assert.notEqual(child.signalCode ?? child.exitCode, null);
        assert.throws(() => process.kill(child.pid as number, 0), {
          code: "ESRCH",
        });
        await closing;
        assert.equal(browser.isConnected(), false);
      } finally {
        await killBrowser(browser).catch(() => undefined);
        await closing;
      }
    },
  );

test("evidence write failure remains secondary to the original assertion", async () => {
  const root = await mkdtemp(join(tmpdir(), "cab-write-diagnostics-"));
  const original = Error("Original synthetic assertion must remain primary");
  try {
    await assert.rejects(
      runBrowserJourney(
        "diagnostics",
        "synthetic evidence failure",
        async () => {
          throw original;
        },
        {
          evidenceRoot: root,
          writeEvidence: async () => {
            throw Error("Injected evidence write rejection");
          },
        },
      ),
      (error: unknown) => {
        assert.equal(error, original);
        assert.match(original.message, /Original synthetic assertion/);
        assert.ok(original.cause instanceof AggregateError);
        assert.match(
          String(original.cause.errors[1]),
          /evidence.write: failed/,
        );
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stalled local listener leaves auth and backing state held while its sibling closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cab-stalled-local-"));
  const calls: string[] = [];
  let finish!: () => void;
  const original = Error("Original local assertion with pending listener");
  try {
    await assert.rejects(
      runBrowserJourney(
        "diagnostics",
        "stalled local listener",
        async (journey) => {
          journey.ownLocal({
            browser: async () => {
              calls.push("browser");
            },
            listeners: [
              {
                name: "first.close",
                close: () =>
                  new Promise<void>((resolve) => {
                    calls.push("first");
                    finish = resolve;
                  }),
              },
              {
                name: "second.close",
                close: async () => {
                  calls.push("second");
                },
              },
            ],
            auth: () => {
              calls.push("auth");
            },
            state: async () => {
              calls.push("state");
            },
            directory: () => {
              calls.push("directory");
            },
          });
          throw original;
        },
        { evidenceRoot: root, cleanupStepMs: 20, overallMs: 2000 },
      ),
      (error: unknown) => {
        assert.equal(error, original);
        assert.ok(original.cause instanceof AggregateError);
        assert.match(
          String((original.cause.errors[1] as Error).cause),
          /first.close: timed-out.*auth.close: dependency-skipped/,
        );
        return true;
      },
    );
    assert.deepEqual(calls, ["browser", "first", "second"]);
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["browser", "first", "second"]);
  } finally {
    finish?.();
    await rm(root, { recursive: true, force: true });
  }
});

browserTest(
  "screenshots stay in distinct configured suite evidence directories",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cab-screenshot-diagnostics-"));
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent("<h1>Synthetic browser fixture</h1>");
    const paths: string[] = [];
    try {
      for (const suite of [
        "operator-web",
        "operator-task",
        "operator-settings",
      ]) {
        const result = await runBrowserJourney(
          suite,
          "same synthetic screenshot",
          async (journey) => {
            const filename = await journey.capture(page, "synthetic-screen");
            assert.ok(filename);
            assert.ok(
              filename?.startsWith(join(root, `${suite}-${process.pid}`)),
            );
            paths.push(filename);
            const image = await readFile(filename);
            assert.equal(
              image.subarray(0, 8).toString("hex"),
              "89504e470d0a1a0a",
            );
          },
          { evidenceRoot: root },
        );
        assert.ok(result.evidenceDirectory.startsWith(root));
      }
      assert.equal(new Set(paths).size, 3);
    } finally {
      await browser.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("overall expiry bounds a stalled cleanup and labels its uncertain outcome", {
  timeout: 5000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cab-overall-diagnostics-"));
  let finish!: () => void;
  let entered!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const saved = new Map<string, string>();
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started = performance.now();
  try {
    const pending = runBrowserJourney(
      "diagnostics",
      "synthetic stalled cleanup",
      async (journey) => {
        journey.cleanup(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
              entered();
            }),
        );
      },
      {
        executionMs: 50,
        overallMs: 150,
        cleanupStepMs: 1000,
        evidenceRoot: root,
        writeEvidence: async (filename, data) => {
          saved.set(
            filename,
            typeof data === "string"
              ? data
              : Buffer.from(data).toString("utf8"),
          );
        },
      },
    );
    let settled = false;
    const ended = pending.then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await cleanupStarted;
    now = 134;
    t.mock.timers.tick(134);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    now = 135; // The 150ms overall budget reserves its last 15ms for evidence.
    t.mock.timers.tick(1);
    const failure = await ended;
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /overall.*timed-out.*\d+ ms/);
    assert.ok(performance.now() - started < 250);
    const directory = (failure as Error & { evidenceDirectory: string })
      .evidenceDirectory;
    const snapshot = saved.get(join(directory, "manifest.json"));
    assert.ok(snapshot);
    const evidence = JSON.parse(snapshot);
    assert.equal(evidence.phases.execution.status, "completed");
    assert.equal(evidence.phases.overall.status, "timed-out");
    assert.equal(evidence.limits.overallMs, 150);
    assert.equal(evidence.phases.overall.elapsedMs, 135);
    assert.equal(evidence.cleanup.incomplete, true);
    assert.equal(evidence.cleanup.steps[0].status, "timed-out");
    const phases = (
      failure as Error & {
        phases: {
          cleanup: Array<{
            outcome: { status: string; eventual?: { status: string } };
          }>;
        };
      }
    ).phases;
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(phases.cleanup[0]?.outcome.status, "timed-out");
    assert.equal(phases.cleanup[0]?.outcome.eventual?.status, "completed");
    assert.equal(saved.get(join(directory, "manifest.json")), snapshot);
  } finally {
    finish?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.reset();
    t.mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("partial shared startup retains its original owner and reports rejected cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "cab-partial-diagnostics-"));
  let original: (Error & { fixture?: { directory: string } }) | undefined;
  try {
    let failure: unknown;
    try {
      await runBrowserJourney(
        "diagnostics",
        "partial fixture startup",
        async (journey) => {
          await journey.start("fixture.create", async () => {
            try {
              return await createOperatorFixture(null, undefined, undefined, {
                operation: async (name, operation) => {
                  if (name === "service.start" || name === "directory.remove")
                    throw Error(`Injected ${name} rejection`);
                  await operation();
                },
              });
            } catch (error) {
              original = error as Error & { fixture?: { directory: string } };
              throw error;
            }
          });
        },
        { evidenceRoot: root },
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(original?.fixture);
    assert.equal(failure, original);
    const directory = (failure as Error & { evidenceDirectory: string })
      .evidenceDirectory;
    const evidence = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    );
    assert.equal(evidence.cleanup.incomplete, true);
    assert.ok(
      evidence.cleanup.steps.some(
        (step: { name: string; status: string }) =>
          step.name === "directory.remove" && step.status === "failed",
      ),
    );
  } finally {
    // The injected removal rejected before touching the known synthetic directory.
    if (original?.fixture)
      await rm(original.fixture.directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
