import { fileURLToPath, pathToFileURL } from "node:url";
import { diagnosticLimitsFromEnv } from "./execution-diagnostics.js";
import { ROOT_REFUSAL } from "./launchd.js";
import { OperatorApi } from "./operator-api.js";
import { OperatorWebBundle, OperatorWebBoundary } from "./operator-web.js";
import { serviceReadiness } from "./readiness.js";
import { ServiceLog } from "./service-log.js";
import { releaseVersion } from "./startup-snapshot.js";
import {
  StandaloneService,
  type BackgroundFailureDiagnostic,
} from "./service.js";
import { LocalOperatorHttp, LocalOperatorUi } from "./operator.js";
import { OperatorAuth } from "./operator-auth.js";
import { OperatorPush } from "./operator-push.js";
import { dirname, join } from "node:path";
import { OperatorRouteRegistry } from "./operator-routes.js";
import { runtimeOperatorRoutes } from "./operator-runtime.js";

export type ServiceExitReason = "signal" | "background-failure";

/**
 * Keeps a SIGINT or SIGTERM during asynchronous startup from taking Node's default exit,
 * which would write no exit line. The first one is carried to `waitForServiceExit`.
 */
export function captureStartupSignals() {
  let first: NodeJS.Signals | undefined;
  const release = () => {
    process.removeListener("SIGINT", record);
    process.removeListener("SIGTERM", record);
  };
  // Only the first signal is held: a second one, or a hung startup, takes the default exit.
  const record = (signal: NodeJS.Signals) => {
    first ??= signal;
    release();
  };
  process.on("SIGINT", record);
  process.on("SIGTERM", record);
  return { received: () => first, release };
}
export type StartupSignals = ReturnType<typeof captureStartupSignals>;

/** Wait for one operator signal or this exact service generation's fatal signal. */
export async function waitForServiceExit(
  service: Pick<
    StandaloneService,
    "waitForBackgroundFailure" | "waitForBackgroundShutdown"
  >,
  failureNotification?: Promise<BackgroundFailureDiagnostic>,
  hooks: {
    /** Signals caught during startup; released once this wait's own handlers are installed. */
    startup?: StartupSignals | undefined;
    /** Runs once the signal handlers are installed: a start line then means a signal exits cleanly. */
    onListening?: () => void;
    onSignal?: (signal: NodeJS.Signals) => void;
  } = {},
): Promise<ServiceExitReason> {
  const notification =
    failureNotification ?? service.waitForBackgroundFailure();
  const reason = await new Promise<ServiceExitReason>((resolve) => {
    let settled = false;
    const cleanup = () => {
      process.removeListener("SIGINT", onSignalReceived);
      process.removeListener("SIGTERM", onSignalReceived);
    };
    const finish = (value: ServiceExitReason) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onSignalReceived = (signal: NodeJS.Signals) => {
      if (!settled) hooks.onSignal?.(signal);
      finish("signal");
    };
    process.once("SIGINT", onSignalReceived);
    process.once("SIGTERM", onSignalReceived);
    void notification.then(() => finish("background-failure"));
    const early = hooks.startup?.received();
    hooks.startup?.release();
    hooks.onListening?.();
    if (early) onSignalReceived(early);
  });
  if (reason === "background-failure") {
    process.exitCode = 1;
    try {
      await service.waitForBackgroundShutdown(notification);
    } catch {
      // The service emitted its fixed safe-shutdown diagnostic; do not expose its error.
    }
  }
  return reason;
}

/** Both harnesses run in production; profiles still default to Codex (ADR-1008, #827). */
export const productionRuntimeHarnesses = ["codex", "claude"] as const;

export const productionService = (dataDir: string) =>
  // Invalid retention variables fail startup rather than using defaults.
  new StandaloneService(dataDir, undefined, undefined, {
    diagnostics: { limits: diagnosticLimitsFromEnv(process.env) },
    runtimeHarnesses: productionRuntimeHarnesses,
    // Control paths like OperatorApi's: failure records must not disclose them.
    failureRedactionPaths: process.env.CAB_OPERATOR_AUTH_FILE
      ? [process.env.CAB_OPERATOR_AUTH_FILE]
      : [],
  });

export async function main(
  commandLine = process.argv.slice(2),
  serviceFactory: (dataDir: string) => StandaloneService = productionService,
  /** Only `serve` and `operator` pass one: it adds their start and exit lines. */
  log?: ServiceLog,
  startup?: StartupSignals,
): Promise<void> {
  const [command, dataDir, ...args] = commandLine;
  if (!command || !dataDir)
    throw new Error(
      "Usage: cab <serve|operator|run|list> ABSOLUTE_DATA_DIR [workId prompt workspace previousWorkId]",
    );
  const service = serviceFactory(dataDir);
  const records = log ?? new ServiceLog();
  records.attach(service);
  let receivedSignal: NodeJS.Signals | undefined;
  let shutdownFailed = false;
  const operatorAuth =
    command === "operator"
      ? await OperatorAuth.open({
          authFile: process.env.CAB_OPERATOR_AUTH_FILE ?? "",
          origin: process.env.CAB_OPERATOR_ORIGIN ?? "",
        })
      : undefined;
  // Called where main completes, never on a throw: that exit line is the entry point's.
  const writeExit = async () => {
    if (!log) return;
    if (
      failureNotification &&
      service.backgroundFailureObserved(failureNotification)
    )
      log.exited({
        reason: "background-failure",
        operation: (await failureNotification).operation,
      });
    else if (shutdownFailed) log.exited({ reason: "shutdown-failure" });
    else if (receivedSignal)
      log.exited({ reason: "signal", signal: receivedSignal });
  };
  let fatalBackgroundFailure = false;
  let failureNotification: Promise<BackgroundFailureDiagnostic> | undefined;
  /** True after joining a background failure that predates the next startup step. */
  const consumeFatalFailure = async () => {
    const notification = failureNotification;
    if (!notification || !service.backgroundFailureObserved(notification))
      return false;
    fatalBackgroundFailure = true;
    process.exitCode = 1;
    try {
      await service.waitForBackgroundShutdown(notification);
    } catch {
      // The service emitted its fixed safe-shutdown diagnostic; do not expose its error.
    }
    await writeExit();
    return true;
  };
  try {
    await service.start();
    failureNotification = service.waitForBackgroundFailure();
    if (command === "operator" && (await consumeFatalFailure())) return;
    if (command === "run") {
      const [workId, prompt, workspace, previousWorkId] = args;
      if (!workId || !prompt || !workspace)
        throw new Error("run requires workId, prompt and workspace");
      const result = await service.submit(
        workId,
        prompt,
        workspace,
        previousWorkId,
      );
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.state !== "completed") process.exitCode = 1;
    } else if (command === "list") {
      process.stdout.write(`${JSON.stringify(service.list())}\n`);
    } else if (command === "serve") {
      fatalBackgroundFailure =
        (await waitForServiceExit(service, failureNotification, {
          startup,
          onListening: () =>
            log?.started({
              version: releaseVersion(),
              mode: "serve",
              port: null,
              serviceId: service.serviceId(),
            }),
          onSignal: (signal) => {
            receivedSignal = signal;
          },
        })) === "background-failure";
    } else if (command === "operator") {
      if (!operatorAuth)
        throw new Error("Operator authentication is unavailable");
      const routes = new OperatorRouteRegistry();
      routes.registerSlot("runtime", runtimeOperatorRoutes(service));
      const bundle = await OperatorWebBundle.open(
        fileURLToPath(new URL("../../operator", import.meta.url)),
      );
      if (await consumeFatalFailure()) return;
      const authFile = process.env.CAB_OPERATOR_AUTH_FILE ?? "";
      const api = new OperatorApi(service, [dataDir, authFile]);
      const readiness = serviceReadiness(service, api, { dataDir, authFile });
      // The VAPID key sits beside the operator auth file; an unusable one only turns push off.
      const push = await OperatorPush.open({
        store: service.operatorPush(),
        keyFile: join(dirname(authFile), "operator-push-vapid.json"),
        readInbox: (query) => api.readInbox(query),
      });
      // A failure while push loaded has already cleared the domain the UI needs.
      if (await consumeFatalFailure()) return;
      const ui = new LocalOperatorHttp(
        new LocalOperatorUi(
          service.domain(),
          (reference) => service.gitHubSourceReader(reference),
          service.githubSources(),
          () => service.refreshGitHub(),
          (projectId) => service.gitHubSourceCredentialStatus(projectId),
        ),
        operatorAuth,
        {
          routes,
          credentials: service.operatorCredentials(),
          push,
          web: new OperatorWebBoundary(bundle, api, readiness),
        },
      );
      const port = await ui.start(args[0] ? Number(args[0]) : 8787);
      process.stdout.write(`${operatorAuth.origin}/app\n`);
      try {
        fatalBackgroundFailure =
          (await waitForServiceExit(service, failureNotification, {
            startup,
            onListening: () =>
              log?.started({
                version: releaseVersion(),
                mode: "operator",
                port,
                serviceId: service.serviceId(),
              }),
            onSignal: (signal) => {
              receivedSignal = signal;
            },
          })) === "background-failure";
      } finally {
        try {
          await ui.stop();
        } catch (error) {
          process.exitCode = 1;
          shutdownFailed = true;
          records.failure("listener-shutdown", error);
        }
      }
    } else throw new Error(`Unknown command ${command}`);
  } finally {
    try {
      if (!fatalBackgroundFailure) await service.stop();
    } catch (error) {
      process.exitCode = 1;
      shutdownFailed = true;
      records.failure("service-shutdown", error);
    } finally {
      if (failureNotification) {
        try {
          await service.waitForBackgroundShutdown(failureNotification);
        } catch {
          process.exitCode = 1;
        }
        if (service.backgroundFailureObserved(failureNotification))
          process.exitCode = 1;
      }
      operatorAuth?.close();
    }
  }
  await writeExit();
}

/**
 * The process entry: `serve` and `operator` log one start and one exit line, and a crash
 * (an error escaping main, an uncaught exception, an unhandled rejection) writes the
 * sanitised record instead of Node's default stack. Other commands keep Node's behaviour.
 */
export async function runServiceEntry(
  argv = process.argv.slice(2),
  factory: (dataDir: string) => StandaloneService = productionService,
): Promise<void> {
  if (argv[0] !== "serve" && argv[0] !== "operator")
    return await main(argv, factory);
  const log = new ServiceLog();
  // No graceful stop: process state is unknown, and the exit releases the data directory.
  const crash = (error: unknown) => {
    log.exited({ reason: "crash", error });
    process.exit(1);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  const startup = captureStartupSignals();
  try {
    await main(argv, factory, log, startup);
  } catch (error) {
    // Like a default uncaught error, never wait on handles that cleanup left open.
    crash(error);
  } finally {
    startup.release();
    process.removeListener("uncaughtException", crash);
    process.removeListener("unhandledRejection", crash);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  // The service's own entry point, as launchd starts it, never runs as root.
  // A fixed message on stderr, not a stack trace, in the launchd log.
  if (process.getuid?.() === 0 || process.geteuid?.() === 0) {
    process.stderr.write(`${ROOT_REFUSAL}\n`);
    process.exit(1);
  }
  await runServiceEntry();
}
