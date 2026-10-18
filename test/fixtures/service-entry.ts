import { runServiceEntry } from "../../src/standalone/cli.js";
import type { Runtime } from "../../src/standalone/codex.js";
import { StandaloneService } from "../../src/standalone/service.js";

/** Process fixture: `service-entry.js MODE serve|operator DATA_DIR` runs the real service entry point. */
const [mode, ...argv] = process.argv.slice(2);
const secret = process.env.FIXTURE_SECRET ?? "";

function failure(): Error {
  const error = new Error(`${mode} failed with ${secret} in ${argv[1]}`, {
    cause: new Error(`cause ${secret}`),
  });
  error.stack = `Error: ${error.message}\n    at fixture (${argv[1]}/fixture.js:1:1)`;
  return error;
}

// The stub runtime holds no handle; production's runtime process keeps the loop alive.
const keepAlive = setInterval(() => {}, 60_000);
await runServiceEntry(argv, (dataDir) => {
  const service = new StandaloneService(
    dataDir,
    () =>
      ({
        async start() {},
        async stop() {},
        onUnexpectedRequest() {},
      }) as unknown as Runtime,
  );
  const start = service.start.bind(service);
  service.start = async () => {
    if (mode === "open-handle") setInterval(() => {}, 60_000);
    if (mode === "start-failure" || mode === "open-handle") throw failure();
    await start();
    // After the start line: the failure lands in a running service.
    if (mode === "uncaught")
      setTimeout(() => {
        throw failure();
      }, 100);
    if (mode === "rejection")
      setTimeout(() => void Promise.reject(failure()), 100);
  };
  return service;
});
clearInterval(keepAlive);
