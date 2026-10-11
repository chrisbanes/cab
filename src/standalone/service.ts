import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  credentialFreeEnvironment,
  setChildCredentialExclusions,
} from "../core/child-environment.js";
import {
  type CoordinationCall,
  type CoordinationReceipt,
  CoordinationStore,
  type CoordinationToolResponse,
  type InboxDelivery,
  type RuntimeQuestionRecord,
} from "../core/coordination.js";
import {
  canonicalMaterial,
  type DeliveryActionRecord,
  type DeliveryCaller,
  type DeliveryPolicy,
  DeliveryStore,
  isOperatorDeliveryCaller,
  materialDigest,
  type OperatorCommentReview,
  type OperatorDeliveryCaller,
  type RuntimeDeliveryCaller,
} from "../core/delivery.js";
import {
  type CapacityConfigureCommand,
  type CapacityLimits,
  DomainStore,
} from "../core/domain.js";
import {
  GitHubSourceStore,
  verifiedRepository,
} from "../core/github-source.js";
import { Store } from "../core/store.js";
import { reviewMetadataSchema } from "../core/task-review.js";
import { ClaudeRuntime, releaseClaudeTemporaryBase } from "./claude.js";
import {
  CodexRuntime,
  parseFailureEvidence,
  type Runtime,
  type RuntimeConversationEvent,
  type RuntimeDiagnosticEvent,
  type RuntimeToolCall,
  type RuntimeToolResult,
  type RuntimeTurnSettings,
} from "./codex.js";
import { SqliteWorkspaceComparisonStore } from "./comparison-store.js";
import type { ConversationHistoryAssignmentRead } from "./conversation-history.js";
import {
  ConversationHistoryCapture,
  ConversationHistoryStore,
} from "./conversation-history.js";
import {
  coordinationTools,
  dispatchCoordinationTool,
  isCoordinationTool,
} from "./coordination-tools.js";
import { CoordinationView } from "./coordination-view.js";
import {
  STANDALONE_MARKER_CONTENTS,
  StandaloneDataDirectory,
} from "./data-directory.js";
import { DeliveryCoordinator } from "./delivery.js";
import {
  type DiagnosticKind,
  type DiagnosticLimits,
  ExecutionDiagnosticsCapture,
  ExecutionDiagnosticsStore,
} from "./execution-diagnostics.js";
import {
  defaultExecutionHarness,
  type ExecutionHarness,
  executionHarnessSchema,
} from "./execution-harness.js";
import type { GitHubDeliveryProvider } from "./github-delivery.js";
import { type GitHubReaderFactory, GitHubSynchronizer } from "./github-sync.js";
import { InboxStartupReconciliation } from "./inbox-startup.js";
import {
  encodeNativeInputReply,
  nativeEndpointKey,
  type RuntimeUserInputOutcome,
  type RuntimeUserInputRequest,
} from "./native-input.js";
import { OperatorApi } from "./operator-api.js";
import {
  managedAssignmentEnvironment,
  OperatorCredentialStore,
} from "./operator-credentials.js";
import {
  CaffeinateAssertion,
  ExecutionPower,
  MacPowerEventSource,
  type PowerEventSource,
} from "./power.js";
import {
  ArchivedResumeRejectedError,
  type HistoricalNoTurnAdoption,
  type HistoricalPreTurnAdoption,
  type NoTurnRecoveryCommand,
  noTurnRecoveryCommandSchema,
  type PreTurnRecoveryCommand,
  preTurnRecoveryCommandSchema,
  type ReplaceConversationCommand,
} from "./pre-turn-recovery.js";
import type {
  RecoveryReceipt,
  RecoveryRecord,
  TerminationVerifier,
} from "./recovery-types.js";
import {
  captureRetainedResultEvidence,
  captureRetainedReviewAnchor,
  failedRetainedResultEvidenceCandidate,
  type RetainedReviewAnchorStageRequest,
  retainedReviewAnchorMaterialHash,
  retainedReviewAnchorStageRequestSchema,
} from "./retained-evidence.js";
import {
  RoutingAttemptStore,
  type RoutingChoiceClient,
  RoutingCoordinator,
  RoutingOperationStaleError,
  type RoutingOutcome,
  type RoutingSnapshot,
  type RoutingStaleReason,
  routingClientFromEnvironment,
  routingModel,
} from "./routing.js";
import type { RuntimeSafetyPort } from "./runtime-retention.js";
import {
  SchedulerStore,
  type TurnRequest,
  TurnScheduler,
} from "./scheduler.js";
import {
  type CoordinationExecutionBinding,
  type ExecutionIntent,
  ExecutionState,
  harnessRetrySupported,
  type TaskExecutionBinding,
  type TaskExecutionBindingRecord,
  type TaskExecutionContext,
} from "./state.js";
import {
  ExecutionSupervisor,
  type ExecutionSupervisorOptions,
  type StopObservation,
} from "./supervisor.js";
import { MacProcessTerminationVerifier } from "./termination.js";
import {
  compareWorkspaceTurnObservations,
  observeWorkspaceTurn,
  type WorkspaceComparisonExport,
  type WorkspaceComparisonSideContent,
  type WorkspaceComparisonSnapshot,
  type WorkspaceTurnCaptureReason,
  type WorkspaceTurnCaptureRecord,
  type WorkspaceTurnObservation,
} from "./workspace-comparison.js";
import {
  isWithin,
  type WorkspaceInspectionCurrent,
} from "./workspace-inspection.js";
import {
  SqliteWorkspaceBindingStore,
  type TaskWorkspaceRepositoryInput,
  type WorkspaceCleanupEvidence,
  WorkspaceManager,
  type WorkspaceManagerOptions,
} from "./workspaces.js";

const immutableRevisionMismatches = new Set([
  "assignment-revision-changed",
  "assignment-instructions-changed",
  "assignment-profile-changed",
  "assignment-instructions-revision-stale",
  "assignment-profile-revision-stale",
  "task-revision-changed",
]);

/** The Claude turn's base environment and token, or why no turn may start. */
export type ClaudeTurnEnvironment =
  | { env: NodeJS.ProcessEnv; token: string }
  | { unavailable: string };

export interface RuntimeSpawnContext {
  spawnEnvironment: () => NodeJS.ProcessEnv;
  safety: RuntimeSafetyPort;
  claude?: {
    configDirectory: string;
    turnEnvironment: () => ClaudeTurnEnvironment;
  };
}
export function createRuntime(
  context: RuntimeSpawnContext,
  harness: ExecutionHarness,
): Runtime {
  const parsed = executionHarnessSchema.safeParse(harness);
  if (!parsed.success)
    throw new Error(`Unsupported execution harness: ${String(harness)}`);
  // Exhaustive: a new harness fails to compile until it is constructed here.
  switch (parsed.data) {
    case "codex":
      return new CodexRuntime("codex", context);
    case "claude":
      if (!context.claude)
        throw new Error("Claude runtime context unavailable");
      return new ClaudeRuntime({
        safety: context.safety,
        claude: context.claude,
      });
  }
}

/** Real harness runtimes are power-supervised; injected fakes stay unsupervised unless asked. */
export function powerSupervisionEnabled(
  power: StandaloneServiceOptions["power"],
  runtime: Pick<Runtime, "harness">,
): boolean {
  return (
    power?.enabled ??
    (power?.eventSource !== undefined || runtime.harness !== undefined)
  );
}

/** A synchronous throw from stop() becomes a rejection like any other. */
const stopRuntime = (runtime: Runtime) =>
  new Promise<void>((resolve) => resolve(runtime.stop()));

const runtimeFailedError = (): never => {
  throw new Error("Runtime failed");
};

/** Runtime-issued identities are only unique within one harness. */
const runtimeKey = (harness: ExecutionHarness, identity: string) =>
  JSON.stringify([harness, identity]);

const harnessLabel: Record<ExecutionHarness, string> = {
  codex: "Codex",
  claude: "Claude",
};

interface PromptPart {
  name:
    | "request"
    | "role"
    | "review-references"
    | "project-instructions"
    | "profile-instructions";
  text: string;
  revision?: number;
}

const serviceItem = (
  name: string,
  severity: string,
  payload: Record<string, unknown>,
) => ({
  turnId: undefined,
  kind: "service" as DiagnosticKind,
  name,
  severity,
  itemId: undefined,
  payload,
});

/** Both lists or none: either missing fails closed to redaction-unavailable. */
const unionExclusions = (
  start: readonly string[] | undefined,
  current: readonly string[] | undefined,
) => (start && current ? [...new Set([...start, ...current])] : undefined);

/** The exact submitted prompt; captured segments cannot drift from it. */
const joinPromptParts = (parts: readonly PromptPart[]) =>
  parts.map((part) => part.text).join("\n\n");

export interface StandaloneServiceOptions {
  /** Harnesses whose runtime this service starts; must include the default. */
  runtimeHarnesses?: readonly ExecutionHarness[];
  /** Secondary startup cannot block healthy default work; defaults to 10 seconds. */
  secondaryRuntimeStartTimeoutMs?: number;
  delivery?: {
    fetcher?: typeof fetch;
    providerFactory?: (
      projectId: string,
      policy: DeliveryPolicy,
    ) => GitHubDeliveryProvider;
  };
  github?: { readerFactory?: GitHubReaderFactory; intervalMs?: number };
  routingClient?: RoutingChoiceClient | null;
  /** Test-only values remain in memory and are never persisted. */
  conversationHistoryExclusions?: () => readonly string[];
  supervisor?: ExecutionSupervisorOptions;
  terminationVerifier?: TerminationVerifier;
  workspaceManager?: WorkspaceManagerOptions;
  power?: {
    enabled?: boolean;
    eventSource?: PowerEventSource;
    assertion?: CaffeinateAssertion;
    pollIntervalMs?: number;
  };
  retry?: {
    now?: () => number;
    fallbackBackoffMs?: number;
    maxFallbackBackoffMs?: number;
  };
  /** Execution diagnostic retention; `cli.ts` passes the environment limits. */
  diagnostics?: {
    limits?: Partial<DiagnosticLimits>;
    pruneIntervalMs?: number;
    now?: () => number;
  };
  /** Controlled fixtures may replace the bounded, redacted service diagnostic sink. */
  backgroundDiagnosticSink?: (
    diagnostic: BackgroundFailureDiagnostic,
  ) => void | Promise<void>;
}

export type BackgroundFailureOperation =
  | "github-poll"
  | "power-poll"
  | "domain-wake"
  | "post-turn-wake"
  | "scheduler-drain"
  | "safe-shutdown";

export type BackgroundFailureCode =
  | "unexpected-background-failure"
  | "shutdown-failed"
  | "diagnostic-writer-failed";

export interface BackgroundFailureDiagnostic {
  serviceId: string;
  incident: number;
  operation: BackgroundFailureOperation;
  errorCode: BackgroundFailureCode;
}

interface ServiceGeneration {
  id: string;
  accepting: boolean;
  fatal: boolean;
  shutdownFailureReported: boolean;
  incident: number;
  failureNotification: Promise<BackgroundFailureDiagnostic>;
  resolveFailure: (diagnostic: BackgroundFailureDiagnostic) => void;
  shutdown?: Promise<void>;
  diagnosticQueue: Promise<void>;
}

const backgroundDiagnosticTimeoutMs = 50;
const backgroundDiagnosticFallback =
  '{"errorCode":"diagnostic-writer-failed"}\n';

export type RoutingAvailabilityReason =
  | "disabled"
  | "missing-client-credentials"
  | "no-eligible-candidates"
  | null;

export interface RoutingAvailability {
  enabled: boolean;
  credentialReferenceConfigured: boolean;
  routingClientAvailable: boolean;
  eligibleCandidateCount: number;
  available: boolean;
  reason: RoutingAvailabilityReason;
}
/** Owns only standalone.sqlite in a marked data directory. No import or attach path exists. */
export class StandaloneService {
  private owner: StandaloneDataDirectory | undefined;
  private db: DatabaseSync | undefined;
  private state: ExecutionState | undefined;
  private domainState: DomainStore | undefined;
  private githubSourceStore: GitHubSourceStore | undefined;
  private githubSynchronizer: GitHubSynchronizer | undefined;
  private githubPollTimer: NodeJS.Timeout | undefined;
  private coordination: CoordinationStore | undefined;
  private deliveryStore: DeliveryStore | undefined;
  private deliveryCoordinator: DeliveryCoordinator | undefined;
  private runtimeSpawnSnapshot: NodeJS.ProcessEnv | undefined;
  private routingAttempts: RoutingAttemptStore | undefined;
  private workspaces: WorkspaceManager | undefined;
  private workspaceBindings: SqliteWorkspaceBindingStore | undefined;
  private workspaceComparisons: SqliteWorkspaceComparisonStore | undefined;
  private operatorCredentialStore: OperatorCredentialStore | undefined;
  private schedulerStore: SchedulerStore | undefined;
  private inboxStartup: InboxStartupReconciliation | undefined;
  private scheduler: TurnScheduler | undefined;
  private supervisor: ExecutionSupervisor | undefined;
  private power: ExecutionPower | undefined;
  private powerPollTimer: NodeJS.Timeout | undefined;
  private readonly runtimes = new Map<ExecutionHarness, Runtime>();
  private readonly runtimeUnavailableSince = new Map<
    ExecutionHarness,
    number
  >();
  private readonly runtimeHarnesses: readonly ExecutionHarness[];
  /** Settles when a non-default runtime reports failure; see untilFailure. */
  private readonly runtimeFailed = new WeakMap<Runtime, Promise<void>>();
  /** A failed secondary runtime's cleanup; shutdown awaits and reports it. */
  private readonly detachedRuntimeStops = new Set<Promise<void>>();
  private conversationHistory: ConversationHistoryStore | undefined;
  private diagnosticsStore: ExecutionDiagnosticsStore | undefined;
  private diagnosticPruneTimer: NodeJS.Timeout | undefined;
  /** Keyed like conversation captures; finished ones stay to count late events. */
  private readonly diagnosticCaptures = new Map<
    string,
    ExecutionDiagnosticsCapture
  >();
  private readonly conversationCaptures = new Map<
    string,
    ConversationHistoryCapture
  >();
  /** Per harness, so an unidentified anomaly can only retract its own work. */
  private readonly lastCompletedWorkId = new Map<ExecutionHarness, string>();
  private canonicalDataDir: string | undefined;
  private readonly active = new Set<Promise<ExecutionIntent>>();
  private readonly activeByWorkId = new Map<string, Promise<ExecutionIntent>>();
  private readonly nativeWaiters = new Map<
    string,
    { workId: string; interactionId: string; resolve: () => void }
  >();
  private readonly callbacks = new Map<string, Set<Promise<unknown>>>();
  private readonly routingCoordinators = new Map<string, RoutingCoordinator>();
  private readonly retryNow: () => number;
  private readonly fallbackBackoffMs: number;
  private readonly maxFallbackBackoffMs: number;
  private generation: ServiceGeneration | undefined;
  private stopPromise: Promise<void> | undefined;
  private readonly backgroundRuns = new Set<Promise<void>>();
  private readonly generationsByNotification = new WeakMap<
    Promise<BackgroundFailureDiagnostic>,
    ServiceGeneration
  >();

  constructor(
    private readonly dataDir: string,
    private readonly runtimeFactory: (
      context: RuntimeSpawnContext,
      harness: ExecutionHarness,
    ) => Runtime = createRuntime,
    private readonly markerWriter: (path: string, flag: "wx" | "w") => void = (
      path,
      flag,
    ) => writeFileSync(path, STANDALONE_MARKER_CONTENTS, { flag, mode: 0o600 }),
    private readonly options: StandaloneServiceOptions = {},
  ) {
    this.retryNow = options.retry?.now ?? Date.now;
    const fallback = options.retry?.fallbackBackoffMs ?? 1000;
    const maximum = options.retry?.maxFallbackBackoffMs ?? 30_000;
    if (
      !Number.isSafeInteger(fallback) ||
      fallback < 0 ||
      !Number.isSafeInteger(maximum) ||
      maximum < 0 ||
      maximum > 30_000
    )
      throw new Error(
        "Retry fallback backoff must be a bounded non-negative integer",
      );
    this.maxFallbackBackoffMs = maximum;
    this.fallbackBackoffMs = Math.min(fallback, maximum);
    const harnesses = z
      .array(executionHarnessSchema)
      .parse(options.runtimeHarnesses ?? [defaultExecutionHarness]);
    if (
      !harnesses.includes(defaultExecutionHarness) ||
      new Set(harnesses).size !== harnesses.length
    )
      throw new Error(
        "Runtime harnesses must include the default harness once each",
      );
    this.runtimeHarnesses = harnesses;
    const startupTimeout = options.secondaryRuntimeStartTimeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(startupTimeout) ||
      startupTimeout <= 0 ||
      startupTimeout > 30_000
    )
      throw new Error(
        "Secondary runtime startup timeout must be between 1 and 30000 ms",
      );
  }

  async start(): Promise<void> {
    if (this.db || this.owner)
      throw new Error("Service already started or shutdown is incomplete");
    this.lastCompletedWorkId.clear();
    this.canonicalDataDir = undefined;
    const dataDirectory = StandaloneDataDirectory.openExclusive(this.dataDir, {
      markerWriter: this.markerWriter,
    });
    this.owner = dataDirectory;
    const generation = this.createGeneration();
    this.generation = generation;
    this.stopPromise = undefined;
    const { databasePath: database, workspacePath } = dataDirectory;
    try {
      const db = new DatabaseSync(database);
      this.db = db;
      db.exec(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL",
      );
      new Store(db).ensureHost("standalone-codex");
      this.workspaceComparisons = new SqliteWorkspaceComparisonStore(db);
      this.operatorCredentialStore = new OperatorCredentialStore(db);
      this.conversationHistory = new ConversationHistoryStore(db);
      try {
        const diagnostics = new ExecutionDiagnosticsStore(db, {
          ...(this.options.diagnostics?.limits
            ? { limits: this.options.diagnostics.limits }
            : {}),
          ...(this.options.diagnostics?.now
            ? { now: this.options.diagnostics.now }
            : {}),
        });
        diagnostics.reconcile();
        diagnostics.closeOpen();
        this.diagnosticsStore = diagnostics;
      } catch {
        // Diagnostics are additive; without the store executions run uncaptured.
        this.diagnosticsStore = undefined;
      }
      const domain = new DomainStore(db, () =>
        this.observeBackgroundFailure(generation, "domain-wake", () =>
          this.wakeScheduler(0, generation),
        ),
      );
      domain.migrate();
      this.domainState = domain;
      const githubSources = new GitHubSourceStore(db);
      githubSources.migrate();
      githubSources.invalidateProviderObservations();
      this.githubSourceStore = githubSources;
      this.githubSynchronizer = new GitHubSynchronizer(
        domain,
        githubSources,
        this.options.github?.readerFactory,
      );
      const routingAttempts = new RoutingAttemptStore(db);
      routingAttempts.migrate();
      this.routingAttempts = routingAttempts;
      const schedulerStore = new SchedulerStore(db);
      this.schedulerStore = schedulerStore;
      const workspaceBindings = new SqliteWorkspaceBindingStore(db);
      this.workspaceBindings = workspaceBindings;
      const workspaces = new WorkspaceManager(
        workspaceBindings,
        workspacePath,
        this.options.workspaceManager,
      );
      this.workspaces = workspaces;
      await workspaces.recover();
      workspaces.assertNotCancelled();
      const state = new ExecutionState(db);
      let afterWorkspaceRowId = 0;
      for (;;) {
        const page = state.workspaceNormalizationPage(afterWorkspaceRowId);
        if (page.length === 0) break;
        for (const item of page) {
          afterWorkspaceRowId = item.cursor;
          const bindingRootMismatch =
            item.workspacePath !== null &&
            item.workspaceId !== null &&
            item.workspacePath !== join(workspacePath, item.workspaceId);
          if (bindingRootMismatch) continue;
          this.options.workspaceManager?.beforePathAccess?.(item.workspace);
          let workspaceKey: string;
          try {
            workspaceKey = realpathSync(item.workspace);
          } catch {
            workspaceKey = resolve(item.workspace);
          }
          if (workspaceKey !== item.workspace)
            state.setWorkspaceKey(item.id, workspaceKey);
        }
      }
      state.holdUnfinishedOnOpen();
      this.state = state;
      const coordination = new CoordinationStore(
        db,
        domain,
        (workId) => state.isNeverAdmittedRefusedAssignmentWork(workId),
        (workId) =>
          (this.callbacks.get(workId)?.size ?? 0) === 0
            ? state.reconciledAssignmentProof(workId)
            : undefined,
      );
      coordination.migrate();
      coordination.localReviews().purgeEditableDrafts();
      this.inboxStartup = new InboxStartupReconciliation(db, domain);
      coordination.invalidateRuntimeQuestions(
        "Service restarted; native endpoints cannot be reconstructed",
      );
      this.coordination = coordination;
      // A runtime never reads or extends another harness's retained evidence.
      const own = <T extends { harness: ExecutionHarness } | null>(
        harness: ExecutionHarness,
        evidence: T,
      ): T => {
        if (evidence && evidence.harness !== harness)
          throw new Error("Runtime evidence belongs to another harness");
        return evidence;
      };
      // Checked before any write, so a foreign identity leaves no side effect.
      const ownIdentity = (harness: ExecutionHarness, threadId: string) => {
        if (
          state
            .runtimeIdentityHarnesses(threadId)
            .some((bound) => bound !== harness)
        )
          throw new Error("Runtime evidence belongs to another harness");
      };
      const runtimeSafety = (harness: ExecutionHarness): RuntimeSafetyPort => ({
        recordTerminal: (input) => {
          ownIdentity(harness, input.threadId);
          return state.recordRuntimeTerminal(input, harness);
        },
        terminal: (threadId, turnId, runtimeGeneration) =>
          own(
            harness,
            state.runtimeTerminal(threadId, turnId, runtimeGeneration),
          ),
        terminalForWait: (threadId, turnId, runtimeGeneration) =>
          own(
            harness,
            state.runtimeTerminalForWait(threadId, turnId, runtimeGeneration),
          ),
        registerThreadTools: (threadId, toolDigest) => {
          ownIdentity(harness, threadId);
          state.registerRuntimeThreadTools(threadId, toolDigest, harness);
        },
        threadQualification: (threadId) =>
          own(harness, state.runtimeThreadQualification(threadId)),
        recordThreadQualification: (input) => {
          ownIdentity(harness, input.threadId);
          own(harness, state.runtimeThreadQualification(input.threadId));
          state.recordRuntimeThreadQualification(input);
        },
        nativeEndpointHistory: (identity) =>
          coordination.runtimeNativeEndpointHistory(identity),
        recordTurnProcess: ({ threadId, processIdentity }) => {
          ownIdentity(harness, threadId);
          return state.recordTurnProcess(threadId, processIdentity);
        },
      });
      const deliveryStore = new DeliveryStore(db);
      deliveryStore.migrate();
      this.deliveryStore = deliveryStore;
      this.deliveryCoordinator = new DeliveryCoordinator(deliveryStore, {
        ...(this.options.delivery?.fetcher
          ? { fetcher: this.options.delivery.fetcher }
          : {}),
        ...(this.options.delivery?.providerFactory
          ? { providerFactory: this.options.delivery.providerFactory }
          : {}),
        authorize: (caller, exceptOperationId, request) => {
          this.authorizeDelivery(caller, exceptOperationId);
          if (isOperatorDeliveryCaller(caller)) {
            if (request && request.action.kind !== "issue.comment")
              throw Error("Operator delivery only permits issue.comment");
            return;
          }
          if (
            request &&
            (request.action.kind === "pr.merge" ||
              request.action.kind === "issue.close")
          ) {
            const reasons = coordination.deliveryActionBlockers(
              caller,
              request.action.reviewedResultIds,
              request.operationId,
            );
            if ((this.callbacks.get(caller.workId)?.size ?? 0) > 1)
              reasons.push("unfinished-callback");
            if (request.action.kind === "pr.merge") {
              const binding = deliveryStore.delivery(caller.taskId),
                target = request.action.target;
              if (
                !binding ||
                binding.observation.nodeId !== target.nodeId ||
                binding.observation.repositoryId !== target.repositoryId ||
                binding.observation.number !== target.number ||
                binding.observation.headSha !== target.expectedHeadSha
              )
                reasons.push("merge-target-not-current-delivery");
              if (!String(domain.project(caller.projectId).instructions).trim())
                reasons.push("merge-instructions-unconfigured");
            } else {
              const imported = domain.importedTask(caller.taskId);
              if (
                !imported ||
                imported.nodeId !== request.action.target.nodeId ||
                imported.repositoryId !== request.action.target.repositoryId
              )
                reasons.push("closure-target-not-task-issue");
            }
            if (reasons.length) throw new Error("Completion action held");
          }
        },
        taskVersion: (taskId) => Number(domain.task(taskId).version),
        leadAssignmentId: (taskId) =>
          String(
            domain.leadBindings().find((b) => b.taskId === taskId)
              ?.assignmentId ?? "",
          ),
        feedback: (taskId, reason, identity) =>
          coordination.ensureDeliveryEventWithinTransaction(
            taskId,
            reason,
            identity,
          ),
        approved: (request, caller) =>
          isOperatorDeliveryCaller(caller)
            ? deliveryStore.operatorApprovalCurrent(request, caller)
            : Boolean(
                request.approval &&
                  deliveryStore.approvalCurrent(
                    request.approval.interactionId,
                    caller,
                    request.action,
                    request.operationId,
                  ) &&
                  coordination.authorizationFor({
                    assignmentId: caller.assignmentId,
                    ...request.approval,
                    action: request.action.kind,
                    target: canonicalMaterial(request.action.target),
                    material: request.action,
                  }),
              ),
        activationAllowed: (policy) =>
          !policy.credentialRef ||
          (!this.runtimeSpawnSnapshot?.[policy.credentialRef.slice(4)] &&
            !Object.values(this.runtimeSpawnSnapshot ?? {}).includes(
              process.env[policy.credentialRef.slice(4)] ?? "",
            )),
      });
      const deliveryCredentialNames = () =>
        domain.projects().flatMap((p) => {
          const ref = deliveryStore.configuration(String(p.id)).credentialRef;
          return ref ? [ref.slice(4)] : [];
        });
      const claudeTokenName = () =>
        domain.claudeTokenReference()?.slice(4) ?? null;
      // Helper children (git, ps, pmset, …) never inherit the Claude token either.
      setChildCredentialExclusions(() => {
        const name = claudeTokenName();
        return name ? [name] : [];
      });
      const spawnEnvironment = {
        spawnEnvironment: () => {
          const claude = claudeTokenName();
          const snapshot = managedAssignmentEnvironment(
            credentialFreeEnvironment(process.env, [
              ...deliveryCredentialNames(),
              ...(claude ? [claude] : []),
            ]),
          );
          this.runtimeSpawnSnapshot = snapshot;
          return { ...snapshot };
        },
      };
      const unavailable = (reason: string) => ({
        unavailable: `Claude runtime unavailable: ${reason}`,
      });
      // Never wider than what the running runtimes inherited at start.
      const claude = {
        configDirectory: join(this.dataDir, "claude", "config"),
        turnEnvironment: (): ClaudeTurnEnvironment => {
          const name = claudeTokenName();
          if (!name) return unavailable("subscription token is not configured");
          const snapshot = this.runtimeSpawnSnapshot ?? {};
          const token = process.env[name];
          if (
            snapshot[name] !== undefined ||
            (token && Object.values(snapshot).includes(token))
          )
            return unavailable(
              "Claude token reference was configured after the service started; restart the service",
            );
          if (!token) return unavailable("subscription token is unavailable");
          return {
            env: credentialFreeEnvironment(
              snapshot,
              [...deliveryCredentialNames(), name],
              process.env,
            ),
            token,
          };
        },
      };
      // Preserve the snapshot even for injected runtimes which do not spawn a child.
      spawnEnvironment.spawnEnvironment();
      this.runtimeUnavailableSince.clear();
      for (const harness of this.runtimeHarnesses) {
        let runtime: Runtime;
        try {
          // Keyed by the requested harness: test fakes do not declare one.
          runtime = this.runtimeFactory(
            { ...spawnEnvironment, safety: runtimeSafety(harness), claude },
            harness,
          );
        } catch (error) {
          if (harness === defaultExecutionHarness) throw error;
          this.runtimeUnavailableSince.set(harness, Date.now());
          continue;
        }
        this.runtimes.set(harness, runtime);
        this.attachRuntime(harness, runtime, state);
      }
      this.supervisor = new ExecutionSupervisor(
        state,
        // A failed harness is never awaited for inspection or interrupts.
        (workId) => {
          const runtime = this.runtimeUnavailableSince.has(
            this.harnessForWork(workId),
          )
            ? undefined
            : this.runtimeForWork(workId);
          if (!runtime) return undefined;
          const inspect = runtime.inspectExecution?.bind(runtime);
          return {
            ...(inspect
              ? {
                  inspectExecution: (identity: Parameters<typeof inspect>[0]) =>
                    this.untilFailure(
                      runtime,
                      inspect(identity),
                      runtimeFailedError,
                    ),
                }
              : {}),
            interruptTurn: (threadId: string, turnId: string) =>
              this.untilFailure(
                runtime,
                runtime.interruptTurn(threadId, turnId),
                runtimeFailedError,
              ),
          };
        },
        this.options.supervisor,
        this.options.terminationVerifier ?? new MacProcessTerminationVerifier(),
      );
      for (const [harness, runtime] of this.runtimes) {
        let startup: Promise<void> | undefined;
        let startupSettled = false;
        try {
          startup = runtime.start().finally(() => {
            startupSettled = true;
          });
          await this.startRuntime(harness, runtime, startup);
        } catch (error) {
          if (harness === defaultExecutionHarness) throw error;
          this.runtimes.delete(harness);
          this.runtimeUnavailableSince.set(harness, Date.now());
          // Healthy start-up never waits on a failed secondary's cleanup.
          const cleanup = stopRuntime(runtime);
          cleanup.catch(() => {});
          this.detachedRuntimeStops.add(cleanup);
          if (startup && !startupSettled) {
            // stop() need not cancel start(). Retain ownership until startup
            // settles, then stop any resources it created after the first stop.
            const lateCleanup = Promise.allSettled([startup, cleanup]).then(
              () => stopRuntime(runtime),
            );
            lateCleanup.catch(() => {});
            this.detachedRuntimeStops.add(lateCleanup);
          }
        }
      }
      await this.supervisor.reconcileOnStart();
      await this.deliveryCoordinator.refresh();
      await this.reconcileOwnDeliveryClosures();
      await this.githubSynchronizer.refresh();
      this.emitSourceHoldNotices();
      // The scheduler is deliberately absent until provider reconciliation and
      // queued-inbox supersession finish; domain notifications cannot admit work.
      this.inboxStartup.reconcile();
      const powerOptions = this.options.power;
      if (
        [...this.runtimes.values()].some((runtime) =>
          powerSupervisionEnabled(powerOptions, runtime),
        )
      ) {
        const pollIntervalMs = powerOptions?.pollIntervalMs ?? 60_000;
        if (
          !Number.isSafeInteger(pollIntervalMs) ||
          pollIntervalMs <= 0 ||
          pollIntervalMs > 60_000
        )
          throw new Error(
            "Power-event poll interval must be a positive integer no greater than 60000",
          );
        const power = new ExecutionPower(
          state,
          powerOptions?.eventSource ?? new MacPowerEventSource(),
          powerOptions?.assertion ?? new CaffeinateAssertion(),
          () => this.requireSupervisor().reconcileOnStart(),
          () => this.wakeScheduler(0, generation),
        );
        this.power = power;
        await power.start();
        await power.poll();
        this.powerPollTimer = setInterval(() => {
          this.observeBackgroundFailure(generation, "power-poll", () =>
            power.poll(),
          );
        }, pollIntervalMs);
        this.powerPollTimer.unref();
      }
      const scheduler = new TurnScheduler(
        schedulerStore,
        (request) => this.attemptRequest(request, generation),
        this.retryNow,
        (error) =>
          this.handleBackgroundFailure(generation, "scheduler-drain", error),
      );
      this.scheduler = scheduler;
      scheduler.start();
      await this.wakeScheduler();
      const githubInterval = this.options.github?.intervalMs ?? 300_000;
      if (
        !Number.isSafeInteger(githubInterval) ||
        githubInterval < 1000 ||
        githubInterval > 3_600_000
      )
        throw new Error(
          "GitHub refresh interval must be between 1000 and 3600000 milliseconds",
        );
      this.githubPollTimer = setInterval(() => {
        this.observeBackgroundFailure(generation, "github-poll", () =>
          this.refreshGitHub(),
        );
      }, githubInterval);
      this.githubPollTimer.unref();
      const diagnostics = this.diagnosticsStore;
      if (diagnostics) {
        // prune() catches its own failures; it never stops or holds anything.
        void diagnostics.prune();
        this.diagnosticPruneTimer = setInterval(
          () => void diagnostics.prune(),
          this.options.diagnostics?.pruneIntervalMs ?? 3_600_000,
        );
        this.diagnosticPruneTimer.unref();
      }
    } catch (error) {
      generation.accepting = false;
      const scheduler = this.scheduler;
      const workspaces = this.workspaces;
      workspaces?.cancelGitWork();
      scheduler?.stop();
      this.scheduler = undefined;
      try {
        this.state?.holdReadyOnStartupFailure(
          "Runtime or login unavailable during startup",
        );
      } finally {
        try {
          if (this.powerPollTimer) clearInterval(this.powerPollTimer);
          if (this.githubPollTimer) clearInterval(this.githubPollTimer);
          this.githubPollTimer = undefined;
          if (this.diagnosticPruneTimer)
            clearInterval(this.diagnosticPruneTimer);
          this.diagnosticPruneTimer = undefined;
          this.powerPollTimer = undefined;
          await this.power?.stop().catch(() => {});
          this.power = undefined;
          this.supervisor?.cancelObservations();
          await this.githubSynchronizer?.stop().catch(() => {});
          await this.deliveryCoordinator?.stop().catch(() => {});
          await Promise.all([
            ...[...this.runtimes.values()].map((runtime) =>
              stopRuntime(runtime).catch(() => {}),
            ),
            ...[...this.detachedRuntimeStops].map((cleanup) =>
              cleanup.catch(() => {}),
            ),
          ]);
          this.detachedRuntimeStops.clear();
          await workspaces?.settle();
          try {
            await scheduler?.settle();
          } catch (cleanupError) {
            if (error instanceof Error && error.cause === undefined)
              error.cause = cleanupError;
          }
          await this.supervisor?.settle();
        } finally {
          this.runtimes.clear();
          this.supervisor = undefined;
          this.domainState = undefined;
          this.githubSourceStore = undefined;
          this.githubSynchronizer = undefined;
          this.coordination = undefined;
          this.deliveryCoordinator = undefined;
          this.deliveryStore = undefined;
          this.runtimeSpawnSnapshot = undefined;
          this.routingAttempts = undefined;
          this.routingCoordinators.clear();
          this.schedulerStore = undefined;
          this.scheduler = undefined;
          this.workspaces = undefined;
          this.workspaceBindings = undefined;
          this.workspaceComparisons = undefined;
          this.operatorCredentialStore = undefined;
          this.clearConversationCaptures();
          this.conversationHistory = undefined;
          this.state = undefined;
          try {
            this.db?.close();
          } finally {
            this.db = undefined;
            dataDirectory.close();
            this.owner = undefined;
            if (this.generation === generation) this.generation = undefined;
          }
        }
      }
      throw error;
    }
  }

  private async startRuntime(
    harness: ExecutionHarness,
    runtime: Runtime,
    startup: Promise<void>,
  ): Promise<void> {
    if (harness === defaultExecutionHarness) return startup;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.untilFailure(runtime, startup, runtimeFailedError),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Secondary runtime startup timed out")),
            this.options.secondaryRuntimeStartTimeoutMs ?? 10_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Listeners act only on work bound to the emitting runtime's harness. */
  private attachRuntime(
    harness: ExecutionHarness,
    runtime: Runtime,
    state: ExecutionState,
  ): void {
    const ownWork = (workId: string) =>
      (state.taskBinding(workId)?.harness ?? defaultExecutionHarness) ===
      harness;
    /** A callback naming another harness's execution is rejected, not acted on. */
    const foreign = (threadId: string, turnId: string) => {
      try {
        return state
          .executionsForRuntimeIdentity(threadId, turnId)
          .some((item) => !ownWork(item.workId));
      } catch {
        return true;
      }
    };
    let failed = () => {};
    // After a non-default runtime fails, new inbound callbacks from it are
    // refused; outcomes for work it already registered may still settle.
    let refuseNew = false;
    if (harness !== defaultExecutionHarness)
      this.runtimeFailed.set(
        runtime,
        new Promise<void>((resolve) => {
          failed = resolve;
        }),
      );
    runtime.onFailure?.(() => {
      refuseNew = harness !== defaultExecutionHarness;
      failed();
      if (
        this.runtimes.get(harness) === runtime &&
        !this.runtimeUnavailableSince.has(harness)
      )
        this.runtimeUnavailableSince.set(harness, Date.now());
    });
    const acceptsNew = () =>
      !refuseNew &&
      this.runtimes.get(harness) === runtime &&
      (harness === defaultExecutionHarness ||
        !this.runtimeUnavailableSince.has(harness));
    runtime.onUnexpectedRequest((request) => {
      if (!acceptsNew()) return;
      const active = state
        .activeExecutions()
        .filter((item) => ownWork(item.workId));
      // A runtime naming another harness's execution is misbehaving: hold only
      // its own active work and leave the named harness's work untouched.
      if (
        request.threadId &&
        request.turnId &&
        foreign(request.threadId, request.turnId)
      ) {
        for (const item of active) {
          state.hold(
            item.id,
            `Runtime reported another harness's execution: ${request.method}`,
          );
          this.supervisor?.noteAnomaly(item.workId);
        }
        return;
      }
      const bound =
        request.threadId && request.turnId
          ? state
              .executionsForTerminalIdentity(request.threadId, request.turnId)
              .filter(
                (item) =>
                  ownWork(item.workId) &&
                  ["completed", "held", "submitting", "running"].includes(
                    item.state,
                  ),
              )
          : [];
      if (bound.length === 0 && request.threadId && request.turnId) {
        const awaiting = state
          .executionsForRuntimeIdentity(request.threadId, request.turnId)
          .filter(
            (item) =>
              item.turnId === null &&
              ownWork(item.workId) &&
              ["completed", "held", "submitting", "running"].includes(
                item.state,
              ),
          );
        const pending = awaiting.length === 1 ? awaiting[0] : undefined;
        if (
          pending &&
          state.holdPendingTurn(
            pending.id,
            request.threadId,
            request.turnId,
            `Unexpected App Server request denied: ${request.method}`,
          )
        ) {
          this.supervisor?.turnBound(
            pending.workId,
            request.threadId,
            request.turnId,
          );
          return;
        }
      }
      if (bound.length === 1 && bound[0]?.state === "completed") {
        this.retractWriterAndSuccessors(
          bound[0],
          `Unexpected App Server request denied: ${request.method}`,
        );
        return;
      }
      const affected = bound.length === 1 ? bound : active;
      for (const item of affected) {
        state.hold(
          item.id,
          `Unexpected App Server request denied: ${request.method}`,
        );
        this.supervisor?.noteAnomaly(item.workId);
        this.diagnosticServiceEvent(item.workId, "unexpected-request", "warn", {
          method: request.method,
        });
      }
    });
    runtime.onUserInputRequest?.((request) => {
      if (
        !acceptsNew() ||
        foreign(request.identity.threadId, request.identity.turnId)
      )
        runtime.cancelUserInput?.(
          request.identity,
          "Native callback binding failed",
        );
      else this.handleUserInputRequest(request, runtime);
    });
    runtime.onUserInputOutcome?.((outcome) => {
      if (!foreign(outcome.threadId, outcome.turnId))
        this.handleUserInputOutcome(outcome);
    });
    runtime.onToolCall?.((call) =>
      !acceptsNew() || foreign(call.threadId, call.turnId)
        ? Promise.resolve({
            text: "Coordination call is not bound to current task work",
            success: false,
          })
        : this.observeToolCall(call, harness, this.handleToolCall(call)),
    );
    const generation = this.generation;
    runtime.onAdmissionChange?.(() => {
      if (acceptsNew() && generation)
        this.observeBackgroundFailure(generation, "domain-wake", () =>
          this.wakeScheduler(0, generation),
        );
    });
    runtime.onConversationEvent?.((event) => {
      if (acceptsNew() && !foreign(event.threadId, event.turnId))
        this.receiveConversationEvent(event, harness);
    });
    runtime.onDiagnosticEvent?.((event: RuntimeDiagnosticEvent) => {
      if (acceptsNew() && !foreign(event.threadId, event.turnId))
        this.diagnosticCaptures
          .get(runtimeKey(harness, event.threadId))
          ?.receive(event);
    });
    runtime.onTerminalAnomaly?.((anomaly) => {
      if (!acceptsNew()) return;
      const matched =
        anomaly.threadId && anomaly.turnId
          ? state
              .executionsForTerminalIdentity(anomaly.threadId, anomaly.turnId)
              .filter((item) => ownWork(item.workId))
          : state
              .activeOrLastCompleted(this.lastCompletedWorkId.get(harness))
              .filter((item) => ownWork(item.workId));
      for (const item of matched) {
        this.retractWriterAndSuccessors(item, anomaly.reason);
        this.supervisor?.noteAnomaly(item.workId);
        this.diagnosticServiceEvent(item.workId, "terminal-anomaly", "warn", {
          reason: anomaly.reason,
        });
      }
    });
  }

  private harnessForWork(workId: string): ExecutionHarness {
    return (
      this.requireState().taskBinding(workId)?.harness ??
      defaultExecutionHarness
    );
  }

  private runtimeForWork(workId: string): Runtime | undefined {
    return this.runtimes.get(this.harnessForWork(workId));
  }

  /**
   * Shared paths never wait on a failed non-default runtime: its pending call
   * settles as `onFailure` decides. The default runtime keeps its own bounds.
   */
  private untilFailure<T>(
    runtime: Runtime,
    work: Promise<T>,
    onFailure: () => T,
  ): Promise<T> {
    const failed = this.runtimeFailed.get(runtime);
    return failed ? Promise.race([work, failed.then(onFailure)]) : work;
  }

  /** Why work bound to this harness cannot be admitted now, if anything. */
  private runtimeWaitReason(harness: ExecutionHarness): string | undefined {
    if (!this.runtimeHarnesses.includes(harness))
      return `${harnessLabel[harness]} runtime is not configured`;
    if (this.runtimeUnavailableSince.has(harness))
      return `${harnessLabel[harness]} runtime unavailable; restart the service`;
    return undefined;
  }

  waitForBackgroundFailure(): Promise<BackgroundFailureDiagnostic> {
    if (!this.generation) throw new Error("Service is not started");
    return this.generation.failureNotification;
  }

  async waitForBackgroundShutdown(
    failureNotification?: Promise<BackgroundFailureDiagnostic>,
  ): Promise<void> {
    const generation = failureNotification
      ? this.generationsByNotification.get(failureNotification)
      : this.generation;
    const shutdown = generation?.shutdown;
    if (!generation) return;
    let failed = false;
    let failure: unknown;
    if (generation.fatal && shutdown) {
      try {
        await shutdown;
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
    await generation.diagnosticQueue;
    if (failed) throw failure;
  }

  backgroundFailureObserved(
    failureNotification?: Promise<BackgroundFailureDiagnostic>,
  ): boolean {
    const generation = failureNotification
      ? this.generationsByNotification.get(failureNotification)
      : this.generation;
    return generation?.fatal ?? false;
  }

  stop(): Promise<void> {
    const generation = this.generation;
    if (generation) generation.accepting = false;
    if (this.stopPromise) return this.stopPromise;
    const stopping = this.stopOwned();
    this.stopPromise = stopping;
    void stopping.then(
      () => {},
      () => {
        if (this.stopPromise === stopping) this.stopPromise = undefined;
        const diagnostic =
          generation &&
          this.generation === generation &&
          !generation.shutdownFailureReported
            ? this.nextBackgroundDiagnostic(
                generation,
                "safe-shutdown",
                "shutdown-failed",
              )
            : undefined;
        if (diagnostic && generation) {
          generation.shutdownFailureReported = true;
          void this.writeBackgroundDiagnostic(generation, diagnostic).catch(
            () => {},
          );
        }
      },
    );
    return stopping;
  }

  private async stopOwned(): Promise<void> {
    const scheduler = this.scheduler;
    const supervisor = this.supervisor;
    const synchronizer = this.githubSynchronizer;
    const delivery = this.deliveryCoordinator;
    const runtimes = new Map(this.runtimes);
    const power = this.power;
    const workspaces = this.workspaces;
    const db = this.db;
    const failures: Array<{ stage: string; error: unknown }> = [];
    const recordFailure = (stage: string, error: unknown) => {
      failures.push({ stage, error });
    };
    const attempt = async (stage: string, action: () => unknown) => {
      try {
        await action();
      } catch (error) {
        recordFailure(stage, error);
      }
    };

    try {
      workspaces?.cancelGitWork();
    } catch (error) {
      recordFailure("workspace Git cancellation", error);
    }
    try {
      scheduler?.stop();
    } catch (error) {
      recordFailure("scheduler stop", error);
    }
    if (this.githubPollTimer) clearInterval(this.githubPollTimer);
    this.githubPollTimer = undefined;
    if (this.diagnosticPruneTimer) clearInterval(this.diagnosticPruneTimer);
    this.diagnosticPruneTimer = undefined;
    if (this.powerPollTimer) clearInterval(this.powerPollTimer);
    this.powerPollTimer = undefined;
    try {
      supervisor?.cancelObservations();
    } catch (error) {
      recordFailure("supervisor observation cancellation", error);
    }

    await attempt("GitHub synchronization stop", () => synchronizer?.stop());
    await attempt("delivery stop", () => delivery?.stop());
    await attempt("runtime-question invalidation", () => {
      if (this.db?.isOpen)
        this.coordination?.invalidateRuntimeQuestions(
          "Service stopped; native endpoints lost",
        );
    });
    await attempt("conversation-capture cleanup", () =>
      this.clearConversationCaptures(),
    );
    this.runtimes.clear();
    const detachedStops = [...this.detachedRuntimeStops];
    this.detachedRuntimeStops.clear();
    // Concurrent, so a hung runtime of one harness cannot keep another running.
    await Promise.all([
      ...[...runtimes.values()].map((runtime) =>
        attempt("runtime stop", () => runtime.stop()),
      ),
      ...detachedStops.map((cleanup) => attempt("runtime stop", () => cleanup)),
    ]);
    await attempt("workspace settlement", () => workspaces?.settle());
    await attempt("scheduler settlement", () => scheduler?.settle());
    await attempt("active-work settlement", async () => {
      const settled = await Promise.allSettled([...this.active]);
      for (const result of settled)
        if (result.status === "rejected")
          recordFailure("active-work settlement", result.reason);
    });
    await attempt("power stop", () => power?.stop());
    await attempt("background callback settlement", async () => {
      await Promise.all([...this.backgroundRuns]);
    });
    await attempt("supervisor settlement", () => supervisor?.settle());

    if (db?.isOpen) await attempt("service database close", () => db.close());
    if (!db?.isOpen) {
      if (this.db === db) this.db = undefined;
      const owner = this.owner;
      if (owner) {
        let released = false;
        await attempt("data-directory owner release", () => {
          owner.close();
          released = true;
        });
        if (released && this.owner === owner) this.owner = undefined;
      }

      this.state = undefined;
      this.domainState = undefined;
      this.githubSourceStore = undefined;
      this.githubSynchronizer = undefined;
      this.coordination = undefined;
      this.deliveryCoordinator = undefined;
      this.deliveryStore = undefined;
      this.runtimes.clear();
      this.runtimeSpawnSnapshot = undefined;
      this.routingAttempts = undefined;
      this.routingCoordinators.clear();
      this.schedulerStore = undefined;
      this.scheduler = undefined;
      this.supervisor = undefined;
      this.power = undefined;
      this.workspaces = undefined;
      this.workspaceBindings = undefined;
      this.workspaceComparisons = undefined;
      this.operatorCredentialStore = undefined;
      this.conversationHistory = undefined;
      this.activeByWorkId.clear();
      this.nativeWaiters.clear();
      this.callbacks.clear();
    } else {
      // Keep the runtimes available for another stop attempt while the database
      // and its data-directory owner remain held.
      for (const [harness, runtime] of runtimes)
        this.runtimes.set(harness, runtime);
    }

    if (failures.length === 1) {
      const [failure] = failures;
      if (failure) throw failure.error;
    }
    if (failures.length > 1)
      throw new AggregateError(
        failures.map(({ error }) => error),
        `Service shutdown failed during ${failures.map(({ stage }) => stage).join(", ")}`,
      );
  }

  private createGeneration(): ServiceGeneration {
    let resolveFailure!: (diagnostic: BackgroundFailureDiagnostic) => void;
    const failureNotification = new Promise<BackgroundFailureDiagnostic>(
      (resolve) => {
        resolveFailure = resolve;
      },
    );
    const generation: ServiceGeneration = {
      id: randomUUID(),
      accepting: true,
      fatal: false,
      shutdownFailureReported: false,
      incident: 0,
      failureNotification,
      resolveFailure,
      diagnosticQueue: Promise.resolve(),
    };
    this.generationsByNotification.set(failureNotification, generation);
    return generation;
  }

  private observeBackgroundFailure(
    generation: ServiceGeneration,
    operation: Exclude<BackgroundFailureOperation, "safe-shutdown">,
    action: () => Promise<unknown>,
  ): void {
    if (this.generation !== generation || !generation.accepting) return;
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(action());
    } catch (error) {
      this.handleBackgroundFailure(generation, operation, error);
      return;
    }
    const observed = pending.then(
      () => {},
      (error: unknown) =>
        this.handleBackgroundFailure(generation, operation, error),
    );
    this.backgroundRuns.add(observed);
    void observed.then(() => this.backgroundRuns.delete(observed));
  }

  private handleBackgroundFailure(
    generation: ServiceGeneration,
    operation: Exclude<BackgroundFailureOperation, "safe-shutdown">,
    _error: unknown,
  ): void {
    if (this.generation !== generation || generation.fatal) return;
    generation.accepting = false;
    generation.fatal = true;
    const shutdown = this.stop();
    generation.shutdown = shutdown;
    void shutdown.catch(() => {});
    const diagnostic = this.nextBackgroundDiagnostic(
      generation,
      operation,
      "unexpected-background-failure",
    );
    if (diagnostic)
      void this.writeBackgroundDiagnostic(generation, diagnostic).catch(
        () => {},
      );
    generation.resolveFailure(diagnostic!);
  }

  private nextBackgroundDiagnostic(
    generation: ServiceGeneration,
    operation: BackgroundFailureOperation,
    errorCode: BackgroundFailureCode,
  ): BackgroundFailureDiagnostic {
    generation.incident = Math.min(generation.incident + 1, 2);
    return {
      serviceId: generation.id,
      incident: generation.incident,
      operation,
      errorCode,
    };
  }

  private writeBackgroundDiagnostic(
    generation: ServiceGeneration,
    diagnostic: BackgroundFailureDiagnostic,
  ): Promise<void> {
    const write = generation.diagnosticQueue.then(async () => {
      const sink =
        this.options.backgroundDiagnosticSink ??
        ((event: BackgroundFailureDiagnostic) => {
          process.stderr.write(`${JSON.stringify(event)}\n`);
        });
      const result = Promise.resolve().then(() => sink(diagnostic));
      void result.catch(() => {});
      let timer: NodeJS.Timeout | undefined;
      const completed = await Promise.race([
        result.then(
          () => true,
          () => false,
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(
            () => resolve(false),
            backgroundDiagnosticTimeoutMs,
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (!completed && this.generation === generation) {
        try {
          process.stderr.write(backgroundDiagnosticFallback);
        } catch {
          // The static fallback is best-effort and never calls the sink again.
        }
      }
    });
    generation.diagnosticQueue = write.catch(() => {});
    return generation.diagnosticQueue;
  }

  list(): ExecutionIntent[] {
    return this.requireState().list();
  }

  recoveryView(): RecoveryRecord[] {
    return this.requireState().recoveryView();
  }

  powerStatus() {
    return this.power?.status() ?? null;
  }

  /** The persisted harness of a bound work, or null before binding. */
  bindingHarness(workId: string): ExecutionHarness | null {
    return this.requireState().taskBinding(workId)?.harness ?? null;
  }

  /** In-memory only: a manual service restart is the recovery path. */
  runtimeStatus():
    | { state: "available" }
    | { state: "unavailable"; since: number } {
    // ponytail: reports the default harness only; per-harness status is C4.
    const since = this.runtimeUnavailableSince.get(defaultExecutionHarness);
    return since === undefined
      ? { state: "available" }
      : { state: "unavailable", since };
  }

  resolveHeldExecution(receipt: RecoveryReceipt) {
    return this.requireSupervisor().resolveHeldExecution(receipt);
  }
  adoptHistoricalPreTurnRejection(command: HistoricalPreTurnAdoption) {
    return this.requireState().adoptHistoricalPreTurnRejection(command);
  }
  recoverPreTurnExecution(command: PreTurnRecoveryCommand) {
    const value = preTurnRecoveryCommandSchema.parse(command);
    const replay = this.requireState().preTurnCommandReplay("recover", value);
    if (replay)
      return Promise.resolve(
        z
          .object({
            id: z.string().uuid(),
            workId: z.string().min(1),
            state: z.literal("reconciled"),
          })
          .strict()
          .parse(replay),
      );
    return this.requireSupervisor().resolveHeldExecution(value.receipt, value);
  }
  adoptHistoricalNoTurnSubmission(command: HistoricalNoTurnAdoption) {
    return this.requireState().adoptHistoricalNoTurnSubmission(command);
  }
  recoverNoTurnExecution(command: NoTurnRecoveryCommand) {
    const value = noTurnRecoveryCommandSchema.parse(command);
    const replay = this.requireState().preTurnCommandReplay(
      "recover-no-turn",
      value,
    );
    if (replay)
      return Promise.resolve(
        z
          .object({
            id: z.string().uuid(),
            workId: z.string().min(1),
            state: z.literal("reconciled"),
          })
          .strict()
          .parse(replay),
      );
    return this.requireSupervisor().resolveHeldExecution(value.receipt, value);
  }
  replaceConversationCommand(command: ReplaceConversationCommand) {
    return this.requireState().replaceConversationCommand(command);
  }

  /** Bounded execution list reads; see SchedulerStore.assignmentPage. */
  turnRequestPage(
    scope: "taskId" | "assignmentId" | "projectId",
    id: string,
    before: number | undefined,
    limit: number,
  ): TurnRequest[] {
    if (!this.schedulerStore) throw new Error("Service is not started");
    return this.schedulerStore.assignmentPage(scope, id, before, limit);
  }

  turnRequest(workId: string): TurnRequest | undefined {
    if (!this.schedulerStore) throw new Error("Service is not started");
    return this.schedulerStore.find(workId);
  }

  turnRequests(): TurnRequest[] {
    if (!this.schedulerStore) throw new Error("Service is not started");
    return this.schedulerStore.list();
  }

  taskReview() {
    if (!this.coordination) throw Error("Service not started");
    return this.coordination.taskReview();
  }

  localReviews() {
    if (!this.coordination) throw Error("Service not started");
    return this.coordination.localReviews();
  }

  retainedEvidence() {
    if (!this.coordination) throw Error("Service not started");
    return this.coordination.retainedEvidence();
  }

  async stageReviewAnchorDraft(input: RetainedReviewAnchorStageRequest) {
    const request = retainedReviewAnchorStageRequestSchema.parse(input);
    this.domain().task(request.taskId);
    const evidence = this.retainedEvidence();
    const materialHash = retainedReviewAnchorMaterialHash(request);
    const prior = evidence.reviewAnchorOperation(
      request.taskId,
      request.operationId,
      "stage",
      materialHash,
    );
    if (prior) {
      if (prior.state !== "staged")
        throw new Error("Review anchor operation response kind mismatch");
      return prior;
    }

    const { candidates } = await this.captureReviewAnchors(request);
    return evidence.stageReviewAnchorDraft(
      request.taskId,
      request.operationId,
      materialHash,
      candidates,
    );
  }

  /** Captures anchors under one policy and workspace binding, rechecked after capture. */
  private async captureReviewAnchors(
    request: RetainedReviewAnchorStageRequest,
  ) {
    const task = this.domain().task(request.taskId);
    const evidence = this.retainedEvidence();
    const operatorApi = new OperatorApi(this, [
      this.dataDir,
      process.env.ENSEMBLE_OPERATOR_AUTH_FILE ?? "",
    ]);
    const currentPolicy = async () => {
      const policy = await operatorApi.retainedEvidencePolicy(request.taskId);
      return policy
        ? {
            taskVersion: policy.taskVersion,
            fingerprint: policy.fingerprint,
            accessFingerprint: policy.accessFingerprint,
            excluded: policy.excluded,
            authorizedRepositoryIds: policy.authorizedRepositoryIds,
          }
        : undefined;
    };
    const currentWorkspace = () =>
      this.turnWorkspaceInspectionCurrent(request.taskId);
    const initialWorkspace = await currentWorkspace();
    if (initialWorkspace.taskVersion !== Number(task.version))
      throw new Error("Review anchor task version changed");
    const initialPolicy = await currentPolicy();
    if (!initialPolicy || initialPolicy.taskVersion !== Number(task.version))
      throw new Error("Review anchor policy is unavailable");
    const candidates = [];
    for (const selection of request.anchors)
      candidates.push(
        await captureRetainedReviewAnchor({
          selection,
          identity: {
            taskId: request.taskId,
            captureTaskVersion: Number(task.version),
          },
          currentWorkspace,
          currentPolicy,
          exportComparison: (comparisonId) =>
            this.workspaceComparisonExport(request.taskId, comparisonId),
          comparisonOwner: (comparisonId) =>
            this.workspaceComparisons?.comparisonOwner(comparisonId),
          retainedEvidence: evidence,
        }),
      );
    const [latestPolicy, latestWorkspace] = await Promise.all([
      currentPolicy(),
      currentWorkspace(),
    ]);
    if (
      !latestPolicy ||
      latestPolicy.taskVersion !== initialPolicy.taskVersion ||
      latestPolicy.fingerprint !== initialPolicy.fingerprint ||
      latestWorkspace.taskVersion !== initialWorkspace.taskVersion ||
      latestWorkspace.visibility !== initialWorkspace.visibility
    )
      throw new Error(
        "Review anchor task or access binding changed during capture",
      );
    return { candidates, accessFingerprint: initialPolicy.accessFingerprint };
  }

  async stageLocalReviewAnchorGroup(input: {
    commandKey: string;
    taskId: string;
    ownerKey: string;
    expectedDraftVersion: number;
    requestHash: string;
    anchors: RetainedReviewAnchorStageRequest["anchors"];
  }) {
    const command = {
      commandKey: input.commandKey,
      taskId: input.taskId,
      ownerKey: input.ownerKey,
      requestHash: input.requestHash,
    };
    const prior = this.localReviews().replayStage(command);
    if (prior) return prior;
    const request = retainedReviewAnchorStageRequestSchema.parse({
      taskId: input.taskId,
      operationId: randomUUID(),
      anchors: input.anchors,
    });
    const { candidates, accessFingerprint } =
      await this.captureReviewAnchors(request);
    return this.localReviews().stageGroup({
      commandKey: input.commandKey,
      taskId: request.taskId,
      ownerKey: input.ownerKey,
      expectedDraftVersion: input.expectedDraftVersion,
      requestHash: input.requestHash,
      stageOperationId: request.operationId,
      stageMaterialHash: retainedReviewAnchorMaterialHash(request),
      candidates,
      accessFingerprint,
    });
  }

  sealReviewAnchorDraft(input: {
    taskId: string;
    draftId: string;
    operationId: string;
    anchorIds: readonly string[];
  }) {
    this.domain().task(input.taskId);
    const materialHash = materialDigest({
      taskId: input.taskId,
      draftId: input.draftId,
      anchorIds: [...input.anchorIds],
    });
    return this.retainedEvidence().sealReviewAnchorDraft(
      input.taskId,
      input.draftId,
      input.operationId,
      materialHash,
      input.anchorIds,
    );
  }

  discardReviewAnchorDraft(input: {
    taskId: string;
    draftId: string;
    operationId: string;
  }) {
    this.domain().task(input.taskId);
    const materialHash = materialDigest({
      taskId: input.taskId,
      draftId: input.draftId,
    });
    return this.retainedEvidence().discardReviewAnchorDraft(
      input.taskId,
      input.draftId,
      input.operationId,
      materialHash,
    );
  }

  domain(): DomainStore {
    if (!this.domainState) throw new Error("Service is not started");
    return this.domainState;
  }

  operatorCredentials(): OperatorCredentialStore {
    if (!this.operatorCredentialStore)
      throw new Error("Service is not started");
    return this.operatorCredentialStore;
  }

  githubSources(): GitHubSourceStore {
    if (!this.githubSourceStore) throw new Error("Service is not started");
    return this.githubSourceStore;
  }

  async settleHandback(input: unknown) {
    if (!this.deliveryCoordinator) throw new Error("Service is not started");
    const result = await this.deliveryCoordinator.settleHandback(input);
    await this.wakeScheduler();
    return result;
  }
  private async finalizeDeliveryCompletion(requestId: string, workId: string) {
    const coordination = this.coordination;
    if (!coordination) throw new Error("Service is not started");
    const request = coordination
      .completionRequests()
      .find((r) => r.requestId === requestId);
    if (!request) throw new Error("Unknown completion request");
    const deliveryValidation =
      await this.requireDeliveryCoordinator().qualifyCompletion(request.taskId);
    await this.reconcileOwnDeliveryClosures();
    return coordination.finalizeTaskCompletion({
      requestId,
      workId,
      terminal: "completed",
      deliveryValidation,
    });
  }
  private requireDeliveryCoordinator(): DeliveryCoordinator {
    if (!this.deliveryCoordinator) throw new Error("Service is not started");
    return this.deliveryCoordinator;
  }
  delivery(): DeliveryStore {
    if (!this.deliveryStore) throw new Error("Service is not started");
    return this.deliveryStore;
  }
  private authorizeDelivery(
    caller: DeliveryCaller,
    exceptOperationId?: string,
  ): void {
    if (isOperatorDeliveryCaller(caller)) {
      this.delivery().validateOperatorCaller(caller);
      if (
        this.requireState().taskHold(caller.taskId) ||
        this.domain()
          .admission(caller.taskId)
          .reasons.filter((reason) => !reason.startsWith("external-action-"))
          .length ||
        this.delivery().actionBlockers(caller.taskId, exceptOperationId).length
      )
        throw Error("Task admission is held");
      return;
    }
    const state = this.requireState(),
      coordination = this.coordination,
      intent = state.byWorkId(caller.workId);
    if (
      !coordination ||
      !intent?.threadId ||
      !intent.turnId ||
      intent.state !== "running"
    )
      throw new Error("Delivery caller is stale");
    const current = coordination.deliveryCaller({
      threadId: intent.threadId,
      turnId: intent.turnId,
      callId: "delivery-authority",
      tool: "ensemble_external_action",
      arguments: {},
    });
    if (canonicalMaterial(current) !== canonicalMaterial(caller))
      throw new Error("Delivery caller revision changed");
    if (state.taskHold(caller.taskId)) throw new Error("Task is held");
    const reasons = this.domain()
      .assignmentAdmission(caller.assignmentId)
      .reasons.filter((reason) => !reason.startsWith("external-action-"));
    if (
      reasons.length ||
      this.delivery().actionBlockers(caller.taskId, exceptOperationId).length
    )
      throw new Error("Task admission is held");
  }
  operatorCommentCaller(taskId: string): OperatorDeliveryCaller {
    const d = this.domain(),
      task = d.task(taskId),
      imported = d.importedTask(taskId),
      source = this.taskReview().sources(taskId).at(-1),
      review = imported
        ? this.githubSources().review(String(imported.nodeId))
        : undefined;
    if (!imported || !source || !review)
      throw Error("Imported task source unavailable");
    return {
      actor: "operator",
      principal: "installation-operator",
      projectId: String(task.projectId),
      taskId,
      taskVersion: Number(task.version),
      sourceId: source.sourceId,
      sourceRevision: source.revision,
      sourceDigest: String(review.observedDigest),
      sourceNodeId: String(imported.nodeId),
      sourceRepositoryId: String(imported.repositoryId),
      policyVersion: this.delivery().configuration(String(task.projectId))
        .version,
    };
  }
  private operatorCommentAction(caller: OperatorDeliveryCaller, body: string) {
    const issue = this.githubSources().issue(caller.sourceNodeId);
    if (!issue) throw Error("Imported task issue unavailable");
    return {
      kind: "issue.comment" as const,
      target: {
        nodeId: caller.sourceNodeId,
        repositoryId: caller.sourceRepositoryId,
        number: Number(issue.issueNumber),
      },
      body,
    };
  }
  reviewOperatorComment(command: {
    key: string;
    taskId: string;
    operationId: string;
    expectedTaskVersion: number;
    body: string;
  }): OperatorCommentReview {
    const prior = this.delivery().operatorReview(command.key);
    if (prior) {
      if (prior.commandHash !== materialDigest(command))
        throw Error("Operator review key reused with different material");
      return prior;
    }
    const caller = this.operatorCommentCaller(command.taskId);
    return this.delivery().reviewOperatorComment(
      command,
      caller,
      this.operatorCommentAction(caller, command.body),
    );
  }
  confirmOperatorComment(command: {
    key: string;
    taskId: string;
    reviewId: string;
    expectedRevision: number;
    materialHash: string;
    decision: "approved" | "denied";
  }) {
    return this.delivery().confirmOperatorComment(command, () => {
      const record = this.delivery().operatorReview(command.reviewId);
      if (!record) throw Error("Operator review unavailable");
      this.authorizeDelivery(record.caller);
    });
  }
  async postOperatorComment(command: {
    key: string;
    taskId: string;
    expectedTaskVersion: number;
    body: string;
    reviewId?: string | undefined;
  }): Promise<DeliveryActionRecord> {
    const prior = this.delivery()
      .actions(command.taskId)
      .find((a) => a.operationId === command.key);
    if (prior) {
      if (
        !isOperatorDeliveryCaller(prior.binding) ||
        prior.request.action.kind !== "issue.comment" ||
        prior.request.action.body !== command.body ||
        prior.binding.taskVersion !== command.expectedTaskVersion ||
        prior.request.operatorReviewId !== command.reviewId
      )
        throw Error("Operation key used with different material or caller");
      return prior;
    }
    const caller = this.operatorCommentCaller(command.taskId);
    if (caller.taskVersion !== command.expectedTaskVersion)
      throw Error("Operator task revision conflict");
    return this.requireDeliveryCoordinator().submit(
      {
        operationId: command.key,
        action: this.operatorCommentAction(caller, command.body),
        ...(command.reviewId ? { operatorReviewId: command.reviewId } : {}),
      },
      caller,
    );
  }
  async refreshGitHub(): Promise<void> {
    if (!this.githubSynchronizer) throw new Error("Service is not started");
    await this.deliveryCoordinator?.refresh();
    await this.reconcileOwnDeliveryClosures();
    await this.githubSynchronizer.refresh();
    this.emitSourceHoldNotices();
    await this.wakeScheduler();
  }

  private async reconcileOwnDeliveryClosures(): Promise<void> {
    for (const project of this.domain().projects())
      for (const task of this.domain().tasks(String(project.id))) {
        const imported = this.domain().importedTask(String(task.id));
        if (
          !imported ||
          !this.delivery().ownsConfirmedClosure(
            String(task.id),
            String(imported.nodeId),
          )
        )
          continue;
        const source = this.githubSources().issue(String(imported.nodeId));
        if (!source) continue;
        const config = this.domain().githubConfiguration(String(project.id));
        try {
          const proof =
            await this.requireDeliveryCoordinator().inspectOwnClosure(
              String(task.id),
              {
                repositoryId: String(source.repositoryId),
                nodeId: String(source.nodeId),
                number: Number(source.issueNumber),
              },
            );
          this.githubSources().recordDeliveryClosure(
            String(project.id),
            config.version,
            proof.snapshot,
            proof.operationId,
            proof.closerPrNodeId,
          );
        } catch {
          this.githubSources().recordDeliveryClosureUnavailable(
            String(imported.nodeId),
          );
        }
      }
  }

  private emitSourceHoldNotices(): void {
    const sources = this.githubSourceStore;
    const domain = this.domainState;
    const coordination = this.coordination;
    if (!sources || !domain || !coordination) return;
    const leadByTask = new Map(
      domain
        .leadBindings()
        .map((binding) => [
          String(binding.taskId),
          String(binding.assignmentId),
        ]),
    );
    for (const hold of sources.activeHolds()) {
      const recipients = new Set(
        domain
          .assignments(hold.taskId)
          .filter(
            (assignment) =>
              assignment.state === "pending" || assignment.state === "running",
          )
          .map((assignment) => String(assignment.id)),
      );
      const leadId = leadByTask.get(hold.taskId);
      if (leadId) recipients.add(leadId);
      for (const recipientAssignmentId of recipients)
        coordination.ensureSourceHoldEvent({ ...hold, recipientAssignmentId });
    }
  }

  routingAvailability(projectId: string): RoutingAvailability {
    const domain = this.domain();
    const routing = domain.routing(projectId);
    const credentialReference = domain.routingCredentialReference(projectId);
    const credentialReferenceConfigured = credentialReference !== null;
    const routingClientAvailable =
      this.options.routingClient === undefined
        ? routingClientFromEnvironment(credentialReference) !== undefined
        : this.options.routingClient !== null;
    const enabled = Number(routing.enabled) === 1;
    const eligibleCandidateCount = domain.routingCandidates(projectId).length;
    const reason: RoutingAvailabilityReason = !enabled
      ? "disabled"
      : !credentialReferenceConfigured || !routingClientAvailable
        ? "missing-client-credentials"
        : eligibleCandidateCount === 0
          ? "no-eligible-candidates"
          : null;
    return {
      enabled,
      credentialReferenceConfigured,
      routingClientAvailable,
      eligibleCandidateCount,
      available: reason === null,
      reason,
    };
  }

  coordinationView(): CoordinationView {
    if (
      !this.coordination ||
      !this.routingAttempts ||
      !this.state ||
      !this.domainState
    )
      throw new Error("Service is not started");
    return new CoordinationView(
      this.domainState,
      this.coordination,
      this.state,
      this.routingAttempts,
      () => this.wakeScheduler(),
      (taskId, assignmentId, beforeSequence, beforeOmissionSequence, limit) =>
        this.readConversationHistory(
          taskId,
          assignmentId,
          beforeSequence,
          beforeOmissionSequence,
          limit,
        ),
      {
        readTask: (taskId) => this.delivery().publicTask(taskId),
        settleHandback: (command) => this.settleHandback(command),
        refresh: () => this.refreshGitHub(),
      },
    );
  }

  capacityLimits(projectIds: string[] = []): CapacityLimits {
    return this.domain().capacityLimits(projectIds);
  }

  async configureCapacity(
    command: Omit<CapacityConfigureCommand, "actor" | "type">,
  ): Promise<CapacityLimits> {
    const result = this.domain().execute({
      ...command,
      type: "capacity.configure",
      actor: "operator",
    });
    await this.wakeScheduler();
    return result as CapacityLimits;
  }

  /** The task command owns identity; provisioning never follows a conversation ID. */
  async provisionTask(
    taskId: string,
    repositories: TaskWorkspaceRepositoryInput[] = [],
  ) {
    const task = this.domain().task(taskId);
    const imported = this.domain().importedTask(taskId);
    if (imported) {
      const config = this.domain().githubConfiguration(String(task.projectId));
      const linked = config.repositories;
      for (const repository of repositories) {
        const match = linked.find(
          (candidate) => candidate.repositoryId === repository.repositoryId,
        );
        if (
          !match ||
          repository.path !== match.path ||
          (repository.ref ?? "HEAD") !== match.ref
        )
          throw new Error(
            "Imported task requires an exact linked repository binding",
          );
        const current = await verifiedRepository({
          repositoryId: match.repositoryId,
          path: match.path,
          ref: match.ref,
        });
        if (
          current.gitCommonDirectory !== match.gitCommonDirectory ||
          current.path !== match.path
        )
          throw new Error("Linked repository identity changed");
      }
      const latestTask = this.domain().task(taskId);
      const latestImported = this.domain().importedTask(taskId);
      const latestConfig = this.domain().githubConfiguration(
        String(task.projectId),
      );
      if (
        latestTask.version !== task.version ||
        latestTask.projectId !== task.projectId ||
        latestImported?.nodeId !== imported.nodeId ||
        latestImported?.repositoryId !== imported.repositoryId ||
        latestConfig.version !== config.version ||
        JSON.stringify(latestConfig.repositories) !== JSON.stringify(linked)
      )
        throw new Error(
          "Imported task repository grant changed during verification",
        );
    }
    const binding = await this.requireWorkspaces().provision(
      taskId,
      repositories,
    );
    await this.wakeScheduler();
    return binding;
  }

  taskWorkspaceVisibility(taskId: string) {
    if (!this.workspaceBindings) throw Error("Service not started");
    const binding = this.workspaceBindings.get(taskId);
    return createHash("sha256")
      .update(
        JSON.stringify(
          binding
            ? {
                workspaceId: binding.workspaceId,
                path: binding.path,
                repositories: binding.repositories.map((r) => [
                  r.repositoryId,
                  r.sourcePath,
                  r.workspacePath,
                  r.gitCommonDir,
                ]),
              }
            : null,
        ),
      )
      .digest("hex");
  }
  taskWorkspace(taskId: string, options?: { reuseRecentIdentity?: boolean }) {
    this.domain().task(taskId);
    return this.requireWorkspaces().get(taskId, options);
  }

  replaceWorkspaceComparison(
    comparison: WorkspaceComparisonSnapshot,
    sides: readonly WorkspaceComparisonSideContent[],
  ): void {
    this.domain().task(comparison.taskId);
    const store = this.workspaceComparisons;
    if (!store) throw new Error("Workspace comparison store unavailable");
    store.replaceCurrentComparison(comparison, sides);
  }

  currentWorkspaceComparison(
    taskId: string,
    repositoryId: string,
    target: WorkspaceComparisonSnapshot["target"],
  ): WorkspaceComparisonExport | undefined {
    this.domain().task(taskId);
    return this.workspaceComparisons?.currentComparison(
      taskId,
      repositoryId,
      target,
    );
  }

  workspaceComparisonById(
    taskId: string,
    comparisonId: string,
  ): WorkspaceComparisonExport | undefined {
    this.domain().task(taskId);
    return this.workspaceComparisons?.comparisonById(taskId, comparisonId);
  }

  workspaceComparisonExport(
    taskId: string,
    comparisonId: string,
  ): WorkspaceComparisonExport | undefined {
    this.domain().task(taskId);
    return this.workspaceComparisons?.exportComparison(taskId, comparisonId);
  }

  workspaceComparisonOwner(comparisonId: string): string | undefined {
    return this.workspaceComparisons?.comparisonOwner(comparisonId);
  }

  workspaceTurnCaptureSlots(taskId: string) {
    this.domain().task(taskId);
    return this.workspaceComparisons?.latestTurnCaptures(taskId) ?? {};
  }

  private async turnWorkspaceInspectionCurrent(
    taskId: string,
  ): Promise<WorkspaceInspectionCurrent> {
    const task = this.domain().task(taskId);
    const binding = await this.taskWorkspace(taskId, {
      reuseRecentIdentity: true,
    });
    return {
      taskId,
      taskVersion: Number(task.version),
      visibility: this.taskWorkspaceVisibility(taskId),
      ...(binding ? { binding } : {}),
      controlPaths: [
        this.dataDir,
        process.env.ENSEMBLE_OPERATOR_AUTH_FILE ?? "",
      ],
    };
  }

  private async observeTurnWorkspace(
    taskId: string,
  ): Promise<WorkspaceTurnObservation> {
    try {
      return await observeWorkspaceTurn(taskId, () =>
        this.turnWorkspaceInspectionCurrent(taskId),
      );
    } catch {
      return {
        observedAt: Date.now(),
        state: "gap",
        reason: "workspace-unavailable",
        files: [],
        truncated: false,
      };
    }
  }

  private async recordTurnCaptureAfter(
    capture: WorkspaceTurnCaptureRecord,
    outcome: "completed" | "failed" | "unknown",
    captureState: "pending" | "unsettled",
    reason?: WorkspaceTurnCaptureReason,
  ): Promise<WorkspaceTurnCaptureRecord | undefined> {
    const before = capture.before;
    const store = this.workspaceComparisons;
    if (!before || !store) return undefined;
    const after = await this.observeTurnWorkspace(capture.identity.taskId);
    const sideContent = new Map<number, WorkspaceComparisonSideContent>();
    const identity = {
      ...capture.identity,
      ...(capture.threadId ? { threadId: capture.threadId } : {}),
      ...(capture.turnId ? { turnId: capture.turnId } : {}),
    };
    let comparison: ReturnType<typeof compareWorkspaceTurnObservations>;
    try {
      comparison = compareWorkspaceTurnObservations(
        identity,
        capture.comparisonId,
        capture.startedAt,
        before,
        after,
        outcome,
        (entryIndex, side, text) => {
          const item = sideContent.get(entryIndex) ?? { entryIndex };
          if (side === "left") item.leftText = text;
          else item.rightText = text;
          sideContent.set(entryIndex, item);
        },
      );
    } catch {
      return undefined;
    }
    const { before: _before, after: _after, ...withoutObservations } = capture;
    const next = {
      ...withoutObservations,
      captureState,
      outcome,
      observedAt: after.observedAt,
      comparison,
      sides: [...sideContent.values()].sort(
        (a, b) => a.entryIndex - b.entryIndex,
      ),
      ...((reason ?? after.reason ?? capture.reason)
        ? { reason: reason ?? after.reason ?? capture.reason }
        : {}),
    } satisfies WorkspaceTurnCaptureRecord;
    try {
      return store.updatePendingTurnCapture(next) ? next : undefined;
    } catch {
      return undefined;
    }
  }

  private persistUnsettledTurnCapture(
    capture: WorkspaceTurnCaptureRecord,
    reason: WorkspaceTurnCaptureReason,
  ): WorkspaceTurnCaptureRecord | undefined {
    const store = this.workspaceComparisons;
    if (!store) return undefined;
    const next = {
      ...capture,
      captureState: "unsettled" as const,
      reason,
    } satisfies WorkspaceTurnCaptureRecord;
    try {
      return store.updatePendingTurnCapture(next) ? next : undefined;
    } catch {
      return undefined;
    }
  }

  private finishTurnCapture(capture: WorkspaceTurnCaptureRecord): void {
    const store = this.workspaceComparisons;
    if (!store) return;
    const {
      before: _before,
      after: _after,
      comparison: _comparison,
      sides: _sides,
      ...identityOnly
    } = capture;
    let finished = false;
    try {
      finished = store.finishTurnCapture({
        ...identityOnly,
        ...(capture.comparison ? { comparison: capture.comparison } : {}),
        ...(capture.sides ? { sides: capture.sides } : {}),
        captureState: "finished",
        outcome: "completed",
      });
    } catch {
      // A capture write must not change the observed runtime terminal or hold.
    }
    if (!finished) {
      this.persistUnsettledTurnCapture(
        {
          ...identityOnly,
          captureState: "unsettled",
          outcome: "completed",
          observedAt: Date.now(),
        },
        "capture-store-failed",
      );
    }
  }

  async archiveTask(taskId: string, evidence: WorkspaceCleanupEvidence) {
    this.domain().task(taskId);
    const state = this.requireState();
    const acquired =
      evidence.writerOwnershipResolved && state.beginArchive(taskId);
    if (!acquired)
      return this.requireWorkspaces().archiveAndCleanup(taskId, {
        ...evidence,
        writerOwnershipResolved: false,
      });
    let releaseArchiveHold = false;
    try {
      const path = this.workspaceBindings?.get(taskId)?.path;
      const workspace = path && existsSync(path) ? realpathSync(path) : path;
      const result = await this.requireWorkspaces().archiveAndCleanup(
        taskId,
        evidence,
        () => state.confirmArchive(taskId),
      );
      // The Claude sandbox temporary base lives exactly as long as the workspace.
      if (result.outcome === "cleaned" && workspace)
        await releaseClaudeTemporaryBase(workspace).catch(() => {});
      releaseArchiveHold =
        result.outcome === "cleaned" ||
        (result.outcome === "retained" &&
          result.binding.state === "ready" &&
          !result.binding.gitUncertain);
      return result;
    } finally {
      if (releaseArchiveHold) state.endArchive(taskId);
      await this.wakeScheduler();
    }
  }

  /** A replacement keeps the durable assignment and its captured revisions. */
  replaceConversation(assignmentId: string): number {
    this.domain().assignment(assignmentId);
    return this.requireState().replaceConversation(assignmentId);
  }

  isCurrentResult(workId: string): boolean {
    return this.requireState().isCurrentResult(workId);
  }

  recordTaskResult(workId: string, payload: string): boolean {
    return this.requireState().recordResult(workId, payload);
  }

  stopTask(taskId: string): Promise<StopObservation> {
    this.domain().task(taskId);
    const state = this.requireState();
    const targets = state.stopTask(taskId);
    for (const target of targets) {
      const runtime = this.runtimeForWork(target.workId);
      const runtimeGeneration = runtime?.currentUserInputGeneration?.();
      if (!runtimeGeneration) continue;
      for (const question of this.coordination?.runtimeQuestionsForWork(
        target.workId,
        true,
        runtimeGeneration,
      ) ?? [])
        runtime?.cancelUserInput?.(
          question.identity,
          "Task stopped before native receipt",
        );
    }
    return this.requireSupervisor().observeStop(taskId, targets);
  }

  async resumeTask(taskId: string): Promise<void> {
    this.domain().task(taskId);
    this.requireState().resumeTask(taskId);
    await this.wakeScheduler();
  }

  taskHold(taskId: string): string | undefined {
    return this.requireState().taskHold(taskId);
  }

  isTaskStopped(taskId: string): boolean {
    return this.taskHold(taskId) === "Task stopped";
  }

  /** A known survivor or unfinished tool callback keeps ownership held. */
  holdKnownSurvivor(workId: string, reason: string): void {
    const state = this.requireState();
    const intent = state.byWorkId(workId);
    if (!intent || intent.state === "ready")
      throw new Error("No active execution to hold");
    const holdReason = `Known unfinished execution: ${reason}`;
    this.supervisor?.noteSurvivor(workId);
    if (
      intent.state === "reconciled" &&
      this.coordination?.recoveryDispositionForWork(workId) ===
        "operator-reconciled"
    ) {
      state.holdReconciledContinuationSurvivor(workId, holdReason);
    }
    this.retractWriterAndSuccessors(intent, holdReason);
  }

  private retractWriterAndSuccessors(
    writer: ExecutionIntent,
    reason: string,
  ): void {
    const state = this.requireState();
    for (const item of state.writerAndSuccessors(writer.workId))
      if (
        item.state === "completed" ||
        item.state === "submitting" ||
        item.state === "running"
      )
        state.holdTerminalConflict(item.id, reason);
  }

  registerExecutionCallback(workId: string, callback: Promise<unknown>): void {
    const state = this.requireState().byWorkId(workId)?.state;
    if (
      state === "completed" ||
      (state === "reconciled" &&
        this.coordination?.recoveryDispositionForWork(workId) ===
          "operator-reconciled")
    )
      this.holdKnownSurvivor(workId, "late Ensemble callback");
    const set = this.callbacks.get(workId) ?? new Set<Promise<unknown>>();
    set.add(callback);
    this.callbacks.set(workId, set);
    void callback
      .finally(() => {
        set.delete(callback);
        if (set.size === 0) this.callbacks.delete(workId);
      })
      .catch(() => {});
  }

  private handleUserInputRequest(
    call: RuntimeUserInputRequest,
    runtime: Runtime,
  ): void {
    const state = this.requireState();
    const coordination = this.coordination;
    if (!coordination) return;
    try {
      if (
        runtime.currentUserInputGeneration?.() !==
        call.identity.runtimeGeneration
      )
        throw new Error("Native process generation mismatch");
      let binding = state.runtimeQuestionBinding(
        call.identity.threadId,
        call.identity.turnId,
      );
      if (!binding) {
        const snapshot = state.nativeTurnPrebinding(
          call.identity.threadId,
          call.identity.turnId,
          call.identity.runtimeGeneration,
        );
        if (!snapshot || !state.prebindNativeTurn(snapshot))
          throw new Error("Native callback has no exact admitted binding");
        this.requireSupervisor().turnBound(
          snapshot.workId,
          call.identity.threadId,
          call.identity.turnId,
        );
        binding = state.runtimeQuestionBinding(
          call.identity.threadId,
          call.identity.turnId,
        );
      }
      if (!binding) throw new Error("Native callback binding unavailable");
      const recovery = state.recoveryIdentity(binding.workId);
      const currentProcess = runtime.processIdentity?.();
      if (
        !recovery?.processIdentity ||
        !currentProcess ||
        currentProcess instanceof Promise ||
        JSON.stringify(currentProcess) !==
          JSON.stringify(recovery.processIdentity)
      )
        throw new Error("Native admitted process identity mismatch");
      const question = coordination.recordRuntimeQuestion(call);
      const key = nativeEndpointKey(call.identity);
      if (this.nativeWaiters.has(key)) return;
      let resolve!: () => void;
      const pending = new Promise<void>((done) => {
        resolve = done;
      });
      this.nativeWaiters.set(key, {
        workId: binding.workId,
        interactionId: question.interactionId,
        resolve,
      });
      this.registerExecutionCallback(binding.workId, pending);
    } catch {
      const executions = state.executionsForRuntimeIdentity(
        call.identity.threadId,
        call.identity.turnId,
      );
      for (const execution of executions) {
        state.hold(execution.id, "Native callback could not be durably bound");
        this.supervisor?.noteAnomaly(execution.workId);
      }
      runtime.cancelUserInput?.(
        call.identity,
        "Native callback binding failed",
      );
    }
  }
  private handleUserInputOutcome(outcome: RuntimeUserInputOutcome): void {
    const waiter = this.nativeWaiters.get(nativeEndpointKey(outcome));
    const coordination = this.coordination;
    if (!coordination) return;
    try {
      const record = coordination.recordRuntimeReplyOutcome(outcome);
      if (record.deliveryState === "confirmed" && waiter) {
        this.nativeWaiters.delete(nativeEndpointKey(outcome));
        waiter.resolve();
      } else if (
        outcome.outcome === "uncertain" ||
        outcome.outcome === "unavailable"
      ) {
        const execution = this.state?.byWorkId(record.requestingWorkId);
        if (execution) {
          this.state?.hold(
            execution.id,
            "Native input delivery unavailable or uncertain",
          );
          this.supervisor?.noteAnomaly(execution.workId);
        }
      }
    } catch {
      const record = coordination.runtimeQuestionByEndpoint({
        requestId: outcome.requestId,
        runtimeGeneration: outcome.runtimeGeneration,
        threadId: outcome.threadId,
        turnId: outcome.turnId,
        itemId: outcome.itemId,
      });
      if (
        record &&
        !["confirmed", "uncertain", "unavailable"].includes(
          record.deliveryState,
        )
      )
        try {
          coordination.recordRuntimeReplyOutcome({
            ...record.identity,
            ...(record.replyIntentId
              ? {
                  replyIntentId: record.replyIntentId,
                  answerDigest: record.answerDigest ?? undefined,
                }
              : {}),
            outcome: record.replyIntentId ? "uncertain" : "unavailable",
            reason: "Native outcome could not be durably committed",
          });
        } catch {
          // Keep the writer held if the uncertainty update fails too.
        }
      const workId = waiter?.workId ?? record?.requestingWorkId;
      const execution = workId ? this.state?.byWorkId(workId) : undefined;
      if (execution) {
        this.retractWriterAndSuccessors(
          execution,
          "Native receipt could not be durably committed",
        );
        this.supervisor?.noteAnomaly(execution.workId);
      }
    }
  }
  private runtimeAnswerEligibility(question: RuntimeQuestionRecord): string[] {
    const state = this.requireState(),
      runtime = this.runtimeForWork(question.requestingWorkId),
      domain = this.domain();
    const reasons: string[] = [
      ...domain.admission(question.taskId, false).reasons,
    ];
    const binding = state.runtimeQuestionBinding(
      question.identity.threadId,
      question.identity.turnId,
    );
    const recovery = state.recoveryIdentity(question.requestingWorkId);
    const intent = state.byWorkId(question.requestingWorkId);
    if (
      !binding ||
      binding.workId !== question.requestingWorkId ||
      binding.assignmentId !== question.requestingAssignmentId ||
      intent?.state !== "running"
    )
      reasons.push("requesting-generation-not-running");
    if (
      runtime?.currentUserInputGeneration?.() !==
      question.identity.runtimeGeneration
    )
      reasons.push("native-process-generation-changed");
    const process = runtime?.processIdentity?.();
    if (
      !process ||
      process instanceof Promise ||
      JSON.stringify(process) !== JSON.stringify(recovery?.processIdentity)
    )
      reasons.push("native-process-identity-changed");
    if (binding) {
      reasons.push(...domain.assignmentAdmission(binding.assignmentId).reasons);
      const assignment = domain.assignment(binding.assignmentId);
      if (
        Number(assignment.version) !== binding.assignmentVersion ||
        Number(assignment.instructionsRevision) !==
          binding.instructionsRevision ||
        Number(assignment.profileRevision) !== binding.profileRevision
      )
        reasons.push("native-immutable-revision-changed");
    }
    const hold = state.taskHold(question.taskId);
    if (hold) reasons.push(hold);
    if (state.stopTarget(question.requestingWorkId))
      reasons.push("task-stopped");
    if (state.powerAdmissionState().held) reasons.push("power-held");
    if (this.supervisor?.hasKnownRisk(question.requestingWorkId))
      reasons.push("known-execution-risk");
    if (
      state.hasCompetingTaskExecution(
        question.taskId,
        question.requestingWorkId,
      )
    )
      reasons.push("competing-task-generation");
    if (!this.nativeWaiters.has(nativeEndpointKey(question.identity)))
      reasons.push("native-endpoint-unavailable");
    return reasons;
  }
  private flushRuntimeAnswers(): void {
    for (const runtime of this.runtimes.values())
      this.flushRuntimeAnswersFor(runtime);
  }
  private flushRuntimeAnswersFor(runtime: Runtime): void {
    const coordination = this.coordination;
    const runtimeGeneration = runtime.currentUserInputGeneration?.();
    if (!coordination || !runtimeGeneration || !runtime.replyUserInput) return;
    let cursor = "";
    for (;;) {
      const page = coordination.pendingRuntimeAnswersPage(
        runtimeGeneration,
        cursor,
      );
      if (page.length === 0) break;
      for (const question of page) {
        cursor = question.interactionId;
        // Generations are not unique across harnesses: reply only through the
        // runtime the question's work is bound to; its own flush delivers it.
        if (this.runtimeForWork(question.requestingWorkId) !== runtime)
          continue;
        if (
          !question.answers ||
          question.replyIntentId ||
          question.requestState !== "available"
        )
          continue;
        const reasons = this.runtimeAnswerEligibility(question);
        if (reasons.length) {
          coordination.holdRuntimeAnswer(
            question.interactionId,
            reasons.join("; "),
          );
          continue;
        }
        void runtime
          .replyUserInput(
            question.identity,
            encodeNativeInputReply(question.request, question.answers),
            () => {
              const reasons = this.runtimeAnswerEligibility(question);
              if (reasons.length) {
                coordination.holdRuntimeAnswer(
                  question.interactionId,
                  reasons.join("; "),
                );
                throw new Error("Native reply held");
              }
              return coordination.beginRuntimeReply(
                question.interactionId,
                question.identity,
              );
            },
          )
          .catch(() => {
            const current = this.coordination?.runtimeQuestionByInteractionId(
              question.interactionId,
              question.taskId,
            );
            if (
              current?.replyIntentId &&
              [...this.runtimes.values()].includes(runtime)
            ) {
              runtime.cancelUserInput?.(
                question.identity,
                "Native reply failed",
              );
            }
          });
      }
    }
  }

  private handleToolCall(call: RuntimeToolCall): Promise<RuntimeToolResult> {
    const coordination = this.coordination;
    const state = this.state;
    if (!coordination || !state || !isCoordinationTool(call.tool))
      return Promise.resolve({
        text: "Coordination tool is unavailable for this execution",
        success: false,
      });
    let receipt: CoordinationReceipt | undefined;
    try {
      receipt = coordination.receipt(call as CoordinationCall);
    } catch (error) {
      return Promise.resolve({
        text: String(error).slice(0, 1000),
        success: false,
      });
    }
    if (receipt) return Promise.resolve(receipt.response);

    let binding: CoordinationExecutionBinding | undefined;
    try {
      binding = state.coordinationBinding(call.threadId, call.turnId);
    } catch (error) {
      return Promise.resolve({
        text: String(error).slice(0, 1000),
        success: false,
      });
    }
    if (!binding)
      return Promise.resolve({
        text: "Coordination call is not bound to current task work",
        success: false,
      });
    if (
      call.tool === "ensemble_report_result" &&
      (binding.requestSequence === null || binding.admittedTaskVersion === null)
    )
      return Promise.resolve({
        text: "Result callback is missing its exact admitted request identity",
        success: false,
      });

    let capturedDeliveryCaller: RuntimeDeliveryCaller | undefined;
    const pending = Promise.resolve()
      .then(async () => {
        if (call.tool === "ensemble_external_action") {
          const caller = coordination.deliveryCaller(call as CoordinationCall);
          capturedDeliveryCaller = caller;
          const result = await this.requireDeliveryCoordinator().submit(
            call.arguments,
            caller,
          );
          if (
            result.state === "confirmed-success" &&
            result.request.action.kind.startsWith("pr.")
          )
            await this.requireDeliveryCoordinator().refresh();
          if (
            result.state === "confirmed-success" &&
            (result.request.action.kind === "pr.merge" ||
              result.request.action.kind === "issue.close")
          )
            await this.refreshGitHub();
          const response = coordination.recordAsyncReceipt(
            call as CoordinationCall,
            caller,
            {
              text: `External action ${result.operationId}: ${result.state}${result.observation?.reason ? ` (${result.observation.reason})` : ""}${result.observation?.receipt ? `; confirmed provider receipt ${JSON.stringify(result.observation.receipt)}` : ""}`,
              success: result.state === "confirmed-success",
            },
          );
          await this.wakeScheduler();
          return response;
        }
        if (call.tool === "ensemble_register_pr") {
          const caller = coordination.deliveryCaller(call as CoordinationCall);
          capturedDeliveryCaller = caller;
          const result = await this.requireDeliveryCoordinator().registerPr(
            call.arguments,
            caller,
          );
          return coordination.recordAsyncReceipt(
            call as CoordinationCall,
            caller,
            {
              text: `PR delivery retained ${result.observation.nodeId} at ${result.observation.headSha}`,
              success: true,
            },
          );
        }
        let response: CoordinationToolResponse;
        if (call.tool === "ensemble_report_result") {
          const resultCall = call as CoordinationCall;
          let candidate:
            | Awaited<ReturnType<typeof captureRetainedResultEvidence>>
            | undefined;
          const review = reviewMetadataSchema.safeParse(
            resultCall.arguments.review,
          );
          if (
            binding.requestSequence !== null &&
            binding.admittedTaskVersion !== null &&
            !coordination.hasResultForWork(
              binding.workId,
              binding.workRevision,
            ) &&
            (resultCall.arguments.review === undefined || review.success)
          ) {
            const api = new OperatorApi(this, [
              this.dataDir,
              process.env.ENSEMBLE_OPERATOR_AUTH_FILE ?? "",
            ]);
            const policy = () =>
              api.retainedEvidencePolicy(binding.taskId).then((value) =>
                value
                  ? {
                      taskVersion: value.taskVersion,
                      fingerprint: value.fingerprint,
                      excluded: value.excluded,
                      authorizedRepositoryIds: value.authorizedRepositoryIds,
                    }
                  : undefined,
              );
            const identity = {
              taskId: binding.taskId,
              taskVersion: binding.admittedTaskVersion,
              captureTaskVersion: binding.taskVersion,
              assignmentId: binding.assignmentId,
              assignmentVersion: binding.assignmentVersion,
              workId: binding.workId,
              workRevision: binding.workRevision,
              requestSequence: binding.requestSequence,
              conversationRevision: binding.conversationRevision,
              instructionsRevision: binding.instructionsRevision,
              profileRevision: binding.profileRevision,
              profileId: binding.profileId,
              threadId: call.threadId,
              turnId: call.turnId,
            };
            const retainedReview = review.success ? review.data : undefined;
            try {
              candidate = await captureRetainedResultEvidence({
                identity,
                review: retainedReview,
                currentWorkspace: () =>
                  this.turnWorkspaceInspectionCurrent(binding.taskId),
                currentPolicy: policy,
                turnCaptures: this.workspaceTurnCaptureSlots(binding.taskId),
                exportComparison: (comparisonId) =>
                  this.workspaceComparisonExport(binding.taskId, comparisonId),
              });
            } catch {
              candidate = failedRetainedResultEvidenceCandidate(
                identity,
                retainedReview,
              );
            }
            const latestBinding = state.coordinationBinding(
              call.threadId,
              call.turnId,
            );
            const exactBindingFields = [
              "taskId",
              "taskVersion",
              "admittedTaskVersion",
              "assignmentId",
              "assignmentVersion",
              "workId",
              "workRevision",
              "requestSequence",
              "conversationRevision",
              "instructionsRevision",
              "profileRevision",
              "profileId",
            ] as const;
            if (
              !latestBinding ||
              exactBindingFields.some(
                (field) => latestBinding[field] !== binding[field],
              )
            )
              throw new Error(
                "Coordination callback binding changed during result capture",
              );
          }
          response = coordination.recordResult(resultCall, candidate, {
            nativeResultCallback: true,
          }).response;
        } else {
          response = dispatchCoordinationTool(
            coordination,
            call as CoordinationCall,
            () => !state.taskHold(binding.taskId),
          );
        }
        if (response.success) await this.wakeScheduler();
        return response;
      })
      .catch((error: unknown) => {
        const deliveryCall =
          call.tool === "ensemble_external_action" ||
          call.tool === "ensemble_register_pr";
        const response = {
          text: deliveryCall
            ? "Delivery request rejected or held"
            : String(error).slice(0, 1000),
          success: false,
        };
        if (deliveryCall && capturedDeliveryCaller)
          return coordination.recordAsyncReceipt(
            call as CoordinationCall,
            capturedDeliveryCaller,
            response,
          );
        return response;
      });
    this.registerExecutionCallback(binding.workId, pending);
    return pending;
  }

  async submitTask(
    workId: string,
    assignmentId: string,
    prompt: string,
    previousWorkId?: string,
  ): Promise<ExecutionIntent> {
    const domain = this.domain();
    const assignment = domain.assignment(assignmentId);
    const taskId = String(assignment.taskId);
    const task = domain.task(taskId);
    this.requireSchedulerStore().ensure({
      requestKey: `task:${workId}`,
      workId,
      kind: "assignment",
      taskId,
      projectId: String(assignment.projectId),
      assignmentId,
      taskVersion: Number(task.version),
      assignmentVersion: Number(assignment.version),
      instructionsRevision: Number(assignment.instructionsRevision),
      profileRevision: Number(assignment.profileRevision),
      prompt,
      workspace: null,
      previousWorkId: previousWorkId ?? null,
    });
    return this.dispatchAndRead(workId);
  }

  /** One explicit dispatch; same work ID never submits twice, including after errors. */
  async submit(
    workId: string,
    prompt: string,
    workspace: string,
    previousWorkId?: string,
  ): Promise<ExecutionIntent> {
    const workspaceKey = this.validateDirectWorkspace(workspace);
    if (previousWorkId) {
      const previous = this.requireState().byWorkId(previousWorkId);
      if (
        previous?.state !== "completed" ||
        !previous.threadId ||
        previous.workspace !== workspaceKey
      )
        throw new Error(
          "Previous work is not a completed binding in this workspace",
        );
    }
    this.requireSchedulerStore().ensure({
      requestKey: `direct:${workId}`,
      workId,
      kind: "direct",
      taskId: null,
      projectId: null,
      assignmentId: null,
      taskVersion: null,
      assignmentVersion: null,
      instructionsRevision: null,
      profileRevision: null,
      prompt,
      workspace: workspaceKey,
      previousWorkId: previousWorkId ?? null,
    });
    this.requireState().create(workId, prompt, workspaceKey, previousWorkId);
    return this.dispatchAndRead(workId);
  }

  private async dispatchAndRead(workId: string): Promise<ExecutionIntent> {
    await this.wakeScheduler();
    const active = this.activeByWorkId.get(workId);
    if (active) return active;
    const intent = this.requireState().byWorkId(workId);
    if (intent) return intent;
    throw new Error("Turn request is queued until its task workspace is ready");
  }

  private routingStaleReason(
    domain: DomainStore,
    state: ExecutionState,
    snapshot: RoutingSnapshot,
  ): RoutingStaleReason | undefined {
    if (state.taskHold(snapshot.taskId)) return "task-held";
    const task = domain.task(snapshot.taskId);
    if (Number(task.version) !== snapshot.taskVersion)
      return "task-revision-changed";
    const routing = domain.routing(snapshot.projectId);
    if (
      Number(routing.version) !== snapshot.guidanceRevision ||
      Number(routing.enabled) !== 1
    )
      return "routing-revision-changed";
    const candidates = domain.routingCandidates(snapshot.projectId);
    const capturedIds = snapshot.candidates
      .map((candidate) => candidate.profileId)
      .sort();
    const currentIds = candidates
      .map((candidate) => String(candidate.profileId))
      .sort();
    if (JSON.stringify(currentIds) !== JSON.stringify(capturedIds))
      return "candidate-set-changed";
    if (
      candidates.some((candidate) => {
        const captured = snapshot.candidates.find(
          (item) => item.profileId === candidate.profileId,
        );
        return Number(candidate.profileRevision) !== captured?.profileRevision;
      })
    )
      return "candidate-profile-changed";
    if (!domain.admission(snapshot.taskId).eligible) return "admission-held";
    if (domain.assignments(snapshot.taskId).length > 0)
      return "assignment-already-exists";
    return undefined;
  }

  private async wakeScheduler(
    refusalRebindPass = 0,
    generation = this.generation,
  ): Promise<void> {
    if (!generation || this.generation !== generation || !generation.accepting)
      return;
    const scheduler = this.scheduler;
    const store = this.schedulerStore;
    const domain = this.domainState;
    const state = this.state;
    const coordination = this.coordination;
    const routingAttempts = this.routingAttempts;
    if (
      !scheduler ||
      !store ||
      !domain ||
      !state ||
      !coordination ||
      !routingAttempts
    )
      return;
    this.flushRuntimeAnswers();
    const deliveryWorkCompleted = (delivery: InboxDelivery): boolean => {
      const intent = state.byWorkId(delivery.deliveryWorkId);
      const binding = state.taskBinding(delivery.deliveryWorkId);
      return Boolean(
        intent?.state === "completed" &&
          binding?.workId === delivery.deliveryWorkId &&
          binding.taskId === delivery.taskId &&
          binding.assignmentId === delivery.recipientAssignmentId &&
          binding.assignmentVersion === delivery.assignmentVersion,
      );
    };
    for (const delivery of coordination.queuedDeliveries())
      if (deliveryWorkCompleted(delivery))
        coordination.completeDeliveryBatch(delivery.deliveryWorkId);

    const withdrawStaleRefusedDeliveries = (): number => {
      let withdrawn = 0;
      for (const delivery of coordination.queuedDeliveries())
        if (coordination.withdrawStaleRefusedDelivery(delivery.deliveryWorkId))
          withdrawn++;
      return withdrawn;
    };
    withdrawStaleRefusedDeliveries();

    for (const completion of coordination.completionRequests()) {
      if (completion.status !== "pending") continue;
      const intent = state.byWorkId(completion.leadWorkId);
      const binding = state.taskBinding(completion.leadWorkId);
      if (
        intent?.state !== "completed" ||
        !binding ||
        binding.taskId !== completion.taskId ||
        binding.assignmentId !== completion.leadAssignmentId
      )
        continue;
      await this.finalizeDeliveryCompletion(
        completion.requestId,
        completion.leadWorkId,
      );
    }
    for (const workId of coordination.completedWorkNeedingDisposition())
      coordination.recordSuccessfulTerminal(workId);

    for (const operation of domain.routingOperations()) {
      const disposition = String(operation.disposition);
      if (!disposition.startsWith("lead-review:")) continue;
      const taskId = String(operation.taskId);
      const leadAssignment = domain.ensureLeadAssignment(taskId);
      if (!leadAssignment) continue;
      coordination.ensureRoutingFallbackEvent({
        routingOperationId: String(operation.id),
        taskId,
        recipientAssignmentId: String(leadAssignment.id),
        brief: String(operation.brief),
        reason: disposition.slice("lead-review:".length),
        evidence: String(operation.judgment ?? ""),
      });
    }

    const committedRoutingIds = new Set(
      domain.routingOperations().map((operation) => String(operation.id)),
    );
    for (const operation of routingAttempts.operations()) {
      if (
        operation.status === "stale" ||
        committedRoutingIds.has(operation.operationId)
      )
        continue;
      const staleReason = this.routingStaleReason(
        domain,
        state,
        operation.snapshot,
      );
      if (staleReason)
        routingAttempts.markStale(operation.operationId, staleReason);
    }

    for (const task of domain.readyTasksWithLead()) {
      const taskId = String(task.id);
      const taskAssignments = domain.assignments(taskId);
      if (taskAssignments.length > 0) continue;
      const route = domain.routing(String(task.projectId));
      if (Number(route.enabled) !== 1) {
        domain.ensureLeadAssignment(taskId);
        continue;
      }
      if (!domain.admission(taskId).eligible || state.taskHold(taskId))
        continue;
      const leadBinding = domain.ensureLeadBinding(taskId);
      if (!leadBinding) continue;

      const projectId = String(task.projectId);
      const currentTask = domain.task(taskId);
      const candidates = domain
        .routingCandidates(projectId)
        .map((candidate) => ({
          profileId: String(candidate.profileId),
          name: String(candidate.name),
          capabilities: String(candidate.capabilities),
          profileRevision: Number(candidate.profileRevision),
        }));
      const snapshot: RoutingSnapshot = {
        projectId,
        taskId,
        taskVersion: Number(currentTask.version),
        guidanceRevision: Number(route.version),
        brief: String(currentTask.outcome),
        findings: "",
        guidance: String(route.guidance),
        candidates,
      };
      const existingAttempt = routingAttempts.operation(
        projectId,
        taskId,
        snapshot.taskVersion,
      );
      if (existingAttempt?.status === "stale") continue;
      if (
        existingAttempt &&
        JSON.stringify(existingAttempt.snapshot) !== JSON.stringify(snapshot)
      ) {
        routingAttempts.markStale(
          existingAttempt.operationId,
          this.routingStaleReason(domain, state, existingAttempt.snapshot) ??
            "domain-disposition-rejected",
        );
        continue;
      }
      const attempt =
        existingAttempt ?? routingAttempts.ensureOperation(snapshot);
      if (attempt.status === "stale") continue;

      let outcome: RoutingOutcome;
      if (candidates.length === 0) {
        outcome = routingAttempts.completeFallback(attempt.operationId, {
          kind: "lead-review",
          reason: "no-candidates",
          requestedModel: routingModel,
        });
      } else if (!snapshot.brief.trim()) {
        outcome = routingAttempts.completeFallback(attempt.operationId, {
          kind: "lead-review",
          reason: "missing-context",
          requestedModel: routingModel,
        });
      } else {
        const credentialReference =
          domain.routingCredentialReference(projectId);
        const client =
          this.options.routingClient === undefined
            ? routingClientFromEnvironment(credentialReference)
            : (this.options.routingClient ?? undefined);
        if (!route.credentialAvailable || !client) {
          outcome = routingAttempts.completeFallback(attempt.operationId, {
            kind: "lead-review",
            reason: "missing-credentials",
            requestedModel: routingModel,
          });
        } else {
          const cacheKey =
            this.options.routingClient === undefined
              ? (credentialReference ?? "missing-credential-reference")
              : "injected-routing-client";
          let coordinator = this.routingCoordinators.get(cacheKey);
          if (!coordinator) {
            coordinator = new RoutingCoordinator(routingAttempts, client);
            this.routingCoordinators.set(cacheKey, coordinator);
          }
          try {
            outcome = await coordinator.route(snapshot);
          } catch (error) {
            if (error instanceof RoutingOperationStaleError) continue;
            throw error;
          }
        }
      }

      const staleReason = this.routingStaleReason(domain, state, snapshot);
      if (staleReason) {
        routingAttempts.markStale(attempt.operationId, staleReason);
        continue;
      }
      const disposition =
        outcome.kind === "assigned"
          ? "assigned"
          : `lead-review:${outcome.reason}`;
      let recorded: ReturnType<DomainStore["recordRouting"]>;
      try {
        recorded = domain.recordRouting(
          {
            id: attempt.operationId,
            projectId,
            taskId,
            taskVersion: snapshot.taskVersion,
            assignmentId:
              outcome.kind === "assigned" ? attempt.operationId : null,
            candidateRevisions: Object.fromEntries(
              candidates.map((candidate) => [
                candidate.profileId,
                candidate.profileRevision,
              ]),
            ),
            guidanceRevision: snapshot.guidanceRevision,
            model: outcome.requestedModel,
            question:
              "Choose the best eligible initial assignee, or return for lead review.",
            judgment: JSON.stringify(outcome),
            disposition,
            resultDestination: "lead:task",
            brief: snapshot.brief,
            ...(outcome.kind === "assigned"
              ? {
                  assignment: {
                    profileId: outcome.profileId,
                    brief: snapshot.brief,
                    requesterAssignmentId: null,
                  },
                }
              : {}),
          },
          () => !state.taskHold(taskId),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const staleReason =
          this.routingStaleReason(domain, state, snapshot) ??
          (message === "External admission rejected routing disposition"
            ? "task-held"
            : /stale|held|candidate|revision|already assigned/i.test(message)
              ? "domain-disposition-rejected"
              : undefined);
        if (!staleReason) throw error;
        routingAttempts.markStale(attempt.operationId, staleReason);
        continue;
      }
      if (outcome.kind === "lead-review") {
        const leadAssignment = domain.ensureLeadAssignment(taskId);
        if (!leadAssignment)
          throw new Error("Routing fallback requires a configured task lead");
        coordination.ensureRoutingFallbackEvent({
          routingOperationId: String(recorded.id),
          taskId,
          recipientAssignmentId: String(leadAssignment.id),
          brief: snapshot.brief,
          reason: outcome.reason,
          evidence: JSON.stringify(outcome),
        });
      }
    }
    for (const assignment of domain.pendingAssignments()) {
      const taskId = String(assignment.taskId);
      const task = domain.task(taskId);
      if (Number(task.ready) !== 1 || task.state !== "open") continue;
      const assignmentId = String(assignment.id);
      const initialWorkId = `assignment:${assignmentId}:initial`;
      if (store.list().some((item) => item.workId === initialWorkId)) continue;
      const queued = coordination
        .queuedDeliveries()
        .find((item) => item.recipientAssignmentId === assignmentId);
      let delivery: InboxDelivery | undefined = queued;
      if (!delivery && coordination.pendingEvents(assignmentId).length > 0)
        delivery = coordination.bindDeliveryBatch(
          assignmentId,
          initialWorkId,
          Number(assignment.version),
        );
      const requestWorkId = delivery?.deliveryWorkId ?? initialWorkId;
      try {
        store.createAssignment(
          {
            taskId,
            projectId: String(assignment.projectId),
            assignmentId,
            taskVersion: Number(task.version),
            assignmentVersion: Number(assignment.version),
            instructionsRevision: Number(assignment.instructionsRevision),
            profileRevision: Number(assignment.profileRevision),
            prompt: this.assignmentPrompt(String(assignment.brief), delivery),
            previousWorkId: delivery
              ? (state.latestCompletedAssignmentWork(assignmentId) ?? null)
              : null,
          },
          delivery
            ? { requestKey: requestWorkId, workId: requestWorkId }
            : undefined,
        );
      } catch (error) {
        const existing = store
          .list()
          .find((item) => item.assignmentId === assignment.id);
        if (existing)
          store.hold(
            existing.workId,
            `Assignment request became obsolete: ${String(error)}`,
          );
      }
    }

    const requests = store.list();
    for (const delivery of coordination.queuedDeliveries()) {
      if (deliveryWorkCompleted(delivery)) {
        coordination.completeDeliveryBatch(delivery.deliveryWorkId);
        continue;
      }
      if (requests.some((item) => item.workId === delivery.deliveryWorkId))
        continue;
      let assignment: ReturnType<DomainStore["assignment"]>;
      try {
        assignment = domain.assignment(delivery.recipientAssignmentId);
      } catch {
        continue;
      }
      const task = domain.task(delivery.taskId);
      if (
        Number(assignment.version) !== delivery.assignmentVersion ||
        (assignment.state !== "pending" && assignment.state !== "running") ||
        (Number(task.ready) !== 1 &&
          !domain.hasOwnDeliveryClosure(String(task.id))) ||
        task.state !== "open"
      )
        continue;
      const workId = delivery.deliveryWorkId;
      store.createAssignment(
        {
          taskId: delivery.taskId,
          projectId: String(assignment.projectId),
          assignmentId: delivery.recipientAssignmentId,
          taskVersion: Number(task.version),
          assignmentVersion: delivery.assignmentVersion,
          instructionsRevision: Number(assignment.instructionsRevision),
          profileRevision: Number(assignment.profileRevision),
          prompt: this.assignmentPrompt(String(assignment.brief), delivery),
          previousWorkId:
            state.latestCompletedAssignmentWork(
              delivery.recipientAssignmentId,
            ) ?? null,
        },
        { requestKey: workId, workId },
      );
    }

    for (const recipientAssignmentId of coordination.pendingEventRecipients()) {
      if (
        coordination
          .queuedDeliveries()
          .some((item) => item.recipientAssignmentId === recipientAssignmentId)
      )
        continue;
      let assignment: ReturnType<DomainStore["assignment"]>;
      try {
        assignment = domain.assignment(recipientAssignmentId);
      } catch {
        const pendingLeadResult = coordination
          .pendingEvents(recipientAssignmentId)
          .find((event) => {
            if (event.eventType !== "assignment-result" || !event.resultId)
              return false;
            const leadBinding = domain
              .leadBindings()
              .find(
                (binding) =>
                  binding.taskId === event.taskId &&
                  binding.assignmentId === recipientAssignmentId,
              );
            if (!leadBinding) return false;
            return coordination
              .results(event.taskId)
              .some(
                (result) =>
                  result.resultId === event.resultId &&
                  result.recipientAssignmentId === recipientAssignmentId &&
                  result.destinationDisposition === "delivered",
              );
          });
        if (!pendingLeadResult) continue;
        const leadAssignment = domain.ensureLeadAssignment(
          pendingLeadResult.taskId,
        );
        if (
          !leadAssignment ||
          String(leadAssignment.id) !== recipientAssignmentId
        )
          continue;
        assignment = leadAssignment;
      }
      const task = domain.task(String(assignment.taskId));
      if (
        (assignment.state !== "pending" && assignment.state !== "running") ||
        (Number(task.ready) !== 1 &&
          !domain.hasOwnDeliveryClosure(String(task.id))) ||
        task.state !== "open" ||
        state.taskHold(String(assignment.taskId)) !== undefined ||
        state.assignmentHasUnfinishedExecution(recipientAssignmentId) ||
        store
          .list()
          .some(
            (item) =>
              item.assignmentId === recipientAssignmentId &&
              (item.state === "queued" ||
                item.state === "active" ||
                item.state === "held") &&
              !coordination.isHistoricalWorkResolved(item.workId),
          )
      )
        continue;
      const pending = coordination.pendingEvents(recipientAssignmentId);
      const first = pending[0];
      if (!first) continue;
      const version = Number(assignment.version);
      const workId = `assignment:${recipientAssignmentId}:v${version}:inbox:${first.eventId}`;
      const delivery = coordination.bindDeliveryBatch(
        recipientAssignmentId,
        workId,
        version,
      );
      if (!delivery) continue;
      store.createAssignment(
        {
          taskId: delivery.taskId,
          projectId: String(assignment.projectId),
          assignmentId: recipientAssignmentId,
          taskVersion: Number(task.version),
          assignmentVersion: version,
          instructionsRevision: Number(assignment.instructionsRevision),
          profileRevision: Number(assignment.profileRevision),
          prompt: this.assignmentPrompt(
            String(assignment.brief),
            delivery,
            state.isNeverAdmittedRefusedAssignmentWork(
              `assignment:${recipientAssignmentId}:initial`,
            )
              ? {
                  version: Number(task.version),
                  title: String(task.title),
                  outcome: String(task.outcome),
                }
              : undefined,
          ),
          previousWorkId:
            state.latestCompletedAssignmentWork(recipientAssignmentId) ?? null,
        },
        { requestKey: workId, workId },
      );
    }

    for (const repair of coordination.reportingRepairs()) {
      if (repair.state !== "queued") continue;
      if (store.list().some((item) => item.workId === repair.repairWorkId))
        continue;
      let assignment: ReturnType<DomainStore["assignment"]>;
      try {
        assignment = domain.assignment(repair.assignmentId);
      } catch {
        continue;
      }
      const task = domain.task(repair.taskId);
      if (
        Number(assignment.version) !== repair.assignmentVersion ||
        assignment.state === "held" ||
        (Number(task.ready) !== 1 &&
          !domain.hasOwnDeliveryClosure(String(task.id))) ||
        task.state !== "open"
      )
        continue;
      const prompt = `${String(assignment.brief)}\n\nReporting repair: the previous successful turn ended without a saved result or durable waiting action. Continue this assignment and record a result or request a durable next action before ending.`;
      store.createAssignment(
        {
          taskId: repair.taskId,
          projectId: String(assignment.projectId),
          assignmentId: repair.assignmentId,
          taskVersion: Number(task.version),
          assignmentVersion: repair.assignmentVersion,
          instructionsRevision: Number(assignment.instructionsRevision),
          profileRevision: Number(assignment.profileRevision),
          prompt,
          previousWorkId:
            state.latestCompletedAssignmentWork(repair.assignmentId) ??
            repair.missedWorkId,
        },
        { requestKey: repair.repairWorkId, workId: repair.repairWorkId },
      );
    }
    for (const queued of store.queued()) this.inboxStartup?.capture(queued);
    if (this.generation !== generation || !generation.accepting) return;
    await scheduler.wake();
    if (refusalRebindPass === 0 && withdrawStaleRefusedDeliveries() > 0)
      await this.wakeScheduler(1, generation);
  }

  private assignmentPrompt(
    brief: string,
    delivery?: InboxDelivery,
    currentTask?: { version: number; title: string; outcome: string },
  ): string {
    if (!delivery) return brief;
    const events = delivery.events.map(
      (event) => `- ${event.eventType}: ${event.payload}`,
    );
    const context = currentTask
      ? `Current task (revision ${currentTask.version}): ${currentTask.title}\nCurrent outcome: ${currentTask.outcome}\n\nPreserved assignment brief:\n`
      : "";
    return `${context}${brief}\n\nDurable assignment inbox through event ${delivery.highWaterSequence}:\n${events.join("\n")}`;
  }

  /** The submitted prompt's Ensemble-supplied segments, in submission order. */
  private executionPromptParts(request: TurnRequest): PromptPart[] {
    if (
      request.kind !== "assignment" ||
      request.taskId === null ||
      request.projectId === null ||
      request.assignmentId === null
    )
      return [{ name: "request", text: request.prompt }];

    const state = this.requireState();
    const domain = this.domain();
    const binding = state.taskBinding(request.workId);
    if (
      !binding ||
      binding.taskId !== request.taskId ||
      binding.assignmentId !== request.assignmentId
    )
      throw new Error(
        "Assignment prompt is missing its exact execution binding",
      );
    const assignment = domain.assignment(binding.assignmentId);
    const projectId = String(assignment.projectId);
    if (
      String(assignment.taskId) !== binding.taskId ||
      projectId !== request.projectId
    )
      throw new Error("Assignment prompt binding no longer matches its task");

    const leadBinding = domain
      .leadBindings()
      .find(
        (item) =>
          item.taskId === binding.taskId &&
          item.projectId === projectId &&
          item.assignmentId === binding.assignmentId,
      );
    const profileInstructions = String(
      domain.profileRevision(
        String(assignment.profileId),
        binding.profileRevision,
      ).instructions,
    );
    const projectInstructions = domain.instructionRevision(
      projectId,
      binding.instructionsRevision,
    );
    const roleContext = leadBinding
      ? "Assignment role: project lead. You are accountable for coordinating this task, reviewing its results, and deciding whether to request completion."
      : "Assignment role: project assignee. The project lead remains accountable for coordinating this task and reviewing its results before completion. Report your result and durable next action through Ensemble.";
    const capture = (() => {
      try {
        return this.taskReview().contextForWork(
          binding.taskId,
          binding.assignmentId,
          request.workId,
          binding.assignmentVersion,
        );
      } catch {
        return undefined;
      }
    })();
    const source = capture?.sourceId
      ? this.taskReview().source(binding.taskId, capture.sourceId)
      : undefined;
    const reviewReferences = source
      ? JSON.stringify({
          sourceId: source.sourceId,
          sourceRevision: source.revision,
          criteriaOmittedCount: source.criteriaOmittedCount,
          criteria: source.criteria,
        })
      : "Unavailable: no retained source capture for this work";
    return [
      { name: "request", text: request.prompt },
      { name: "role", text: roleContext },
      {
        name: "review-references",
        text: `Captured review references (JSON): ${reviewReferences}`,
      },
      {
        name: "project-instructions",
        revision: binding.instructionsRevision,
        text: `Captured project instructions (revision ${binding.instructionsRevision}):\n${projectInstructions || "(none)"}`,
      },
      {
        name: "profile-instructions",
        revision: binding.profileRevision,
        text: `Captured profile instructions (revision ${binding.profileRevision}):\n${profileInstructions || "(none)"}`,
      },
    ];
  }

  private async attemptRequest(
    request: TurnRequest,
    generation = this.generation,
  ): Promise<void> {
    if (!generation || this.generation !== generation || !generation.accepting)
      return;
    const state = this.requireState();
    const store = this.requireSchedulerStore();
    let workspaceKey: string;
    let context: TaskExecutionContext | undefined;
    let validateAssignment: (() => string[]) | undefined;
    try {
      if (request.taskId && request.assignmentId && request.projectId) {
        // Initial local tasks need no repository grant. Existing bindings,
        // including held/missing workspaces, remain the recovery authority.
        if (
          !this.workspaceBindings?.get(request.taskId) &&
          !this.domain().importedTask(request.taskId) &&
          !state.taskHold(request.taskId) &&
          !state.hasTaskWorkspaceEvidence(request.taskId)
        )
          await this.requireWorkspaces().provision(request.taskId, []);
        const binding = await this.requireWorkspaces().forExecution(
          request.taskId,
        );
        workspaceKey = realpathSync(binding.path);
        if (
          request.taskVersion === null ||
          request.assignmentVersion === null ||
          request.instructionsRevision === null ||
          request.profileRevision === null
        )
          throw new Error("Task request is missing captured revisions");
        context = {
          taskId: request.taskId,
          assignmentId: request.assignmentId,
          assignmentVersion: request.assignmentVersion,
          instructionsRevision: request.instructionsRevision,
          profileRevision: request.profileRevision,
        };
        const {
          assignmentId,
          taskVersion,
          assignmentVersion,
          instructionsRevision,
          profileRevision,
        } = request;
        if (
          assignmentId === null ||
          taskVersion === null ||
          assignmentVersion === null ||
          instructionsRevision === null ||
          profileRevision === null
        )
          throw new Error("Task request is missing captured revisions");
        validateAssignment = () => {
          const domain = this.domain();
          const reasons = domain.assignmentAdmission(assignmentId, {
            taskVersion,
            assignmentVersion,
            instructionsRevision,
            profileRevision,
          }).reasons;
          if (
            this.requireSchedulerStore()
              .heldWorkIds(assignmentId, request.workId)
              .some(
                (olderWorkId) =>
                  this.coordination?.recoveryDispositionForWork(olderWorkId) ===
                    "operator-reconciled" &&
                  !this.coordination.hasRecoveryContinuation(olderWorkId),
              )
          )
            reasons.push("recovery-continuation-unresolved");
          if (domain.importedTask(binding.taskId)) {
            const task = domain.task(binding.taskId);
            const linked = domain.githubConfiguration(
              String(task.projectId),
            ).repositories;
            if (
              binding.repositories.some(
                (repository) =>
                  !linked.some(
                    (link) =>
                      link.repositoryId === repository.repositoryId &&
                      link.path === repository.sourcePath &&
                      link.ref === repository.ref &&
                      link.gitCommonDirectory === repository.gitCommonDir,
                  ),
              )
            )
              reasons.push("repository-access-revoked");
          }
          return reasons;
        };
      } else if (request.workspace) {
        workspaceKey = this.validateDirectWorkspace(request.workspace);
      } else throw new Error("Turn request has no workspace or task binding");
      if (!isAbsolute(workspaceKey) || !lstatSync(workspaceKey).isDirectory())
        throw new Error("Workspace must be an existing real directory");
      store.setWorkspace(request.workId, workspaceKey);
    } catch (error) {
      const reason = `Workspace admission waiting: ${String(error)}`;
      store.wait(request.workId, reason);
      const queuedIntent = state.byWorkId(request.workId);
      if (queuedIntent?.state === "ready") state.wait(queuedIntent.id, reason);
      return;
    }
    let previous: ExecutionIntent | undefined;
    let priorBinding: TaskExecutionBinding | undefined;
    let waitsForPredecessor = false;
    if (request.previousWorkId) {
      previous = state.byWorkId(request.previousWorkId);
      priorBinding = state.taskBinding(request.previousWorkId);
      waitsForPredecessor = Boolean(
        context &&
          previous &&
          previous.state !== "completed" &&
          previous.workspace === workspaceKey &&
          priorBinding?.taskId === context.taskId &&
          priorBinding.assignmentId === context.assignmentId,
      );
      if (
        !previous ||
        (!waitsForPredecessor &&
          (previous.state !== "completed" ||
            !previous.threadId ||
            previous.workspace !== workspaceKey ||
            (context &&
              (priorBinding?.taskId !== context.taskId ||
                priorBinding.assignmentId !== context.assignmentId))))
      ) {
        store.hold(
          request.workId,
          "Previous work is not a completed binding in this workspace",
        );
        const queuedIntent = state.byWorkId(request.workId);
        if (queuedIntent)
          state.hold(
            queuedIntent.id,
            "Previous work is not a completed binding in this workspace",
          );
        return;
      }
    }
    let intent: ExecutionIntent;
    let binding: TaskExecutionBindingRecord | undefined;
    try {
      intent = state.create(
        request.workId,
        request.prompt,
        workspaceKey,
        request.previousWorkId ?? undefined,
      );
      binding = context
        ? state.bindTask(
            request.workId,
            context,
            this.domain().profileRuntime(
              String(this.domain().assignment(context.assignmentId).profileId),
              context.profileRevision,
            ).harness,
          )
        : undefined;
    } catch (error) {
      store.hold(request.workId, `Request binding refused: ${String(error)}`);
      return;
    }
    if (intent.state !== "ready" && intent.state !== "capacity-waiting") return;
    if (waitsForPredecessor) {
      state.wait(intent.id, "Waiting for the prior turn to complete");
      return;
    }
    if (
      binding &&
      priorBinding?.conversationRevision !== binding.conversationRevision
    )
      previous = undefined;
    // Shutdown may finish while workspace or process admission is awaiting.
    // A request with no admitted effect remains queued for ordinary restart.
    const harness = binding?.harness ?? defaultExecutionHarness;
    const runtime = this.runtimes.get(harness);
    // Never falls back to another harness's runtime. Queued work stays queued:
    // nothing is admitted or held until restart.
    const waitForRuntime = () => {
      const unavailable = this.runtimeWaitReason(harness);
      if (unavailable) {
        state.wait(intent.id, unavailable);
        store.wait(request.workId, unavailable);
      }
      return unavailable !== undefined;
    };
    try {
      // Known-unavailable runtimes are never awaited: the scheduler is serial.
      if (waitForRuntime()) return;
      const processIdentity = await (runtime
        ? this.untilFailure(
            runtime,
            Promise.resolve(runtime.processIdentity?.() ?? null),
            () => null,
          )
        : Promise.resolve(null)
      ).catch(() => null);
      if (
        this.runtimes.get(harness) !== runtime ||
        this.generation !== generation ||
        !generation.accepting
      )
        return;
      if (waitForRuntime()) return;
      if (!runtime) return;
      if (runtime.preflightTurn) {
        const preflight = runtime.preflightTurn.bind(runtime);
        const failed = `${harnessLabel[harness]} runtime unavailable: preflight failed`;
        // A settings lookup failure waits like any other preflight failure.
        const reason = await this.untilFailure(
          runtime,
          (async () => {
            const settings = this.turnSettings(request);
            return preflight({
              workspace: workspaceKey,
              ...(settings ? { settings } : {}),
            });
          })(),
          () => failed,
        ).catch(() => failed);
        if (
          this.runtimes.get(harness) !== runtime ||
          this.generation !== generation ||
          !generation.accepting
        )
          return;
        if (waitForRuntime()) return;
        if (reason !== undefined) {
          state.wait(intent.id, reason);
          store.wait(request.workId, reason);
          return;
        }
      }
      // A sleep/wake during a turn that ended before now must be observed
      // first. No await may separate this check from state.begin.
      const power = this.power;
      if (power && !power.observedForAdmission()) {
        const reason = "Waiting for power-event observation";
        state.wait(intent.id, reason);
        store.wait(request.workId, reason);
        this.pollPowerThenWake(power, generation);
        return;
      }
      const admitted = state.begin(intent.id, {
        projectId: request.projectId,
        requestSequence: store.sequence(request.workId),
        processIdentity,
        ...(validateAssignment
          ? {
              validate: validateAssignment,
              refuse: (reasons) =>
                reasons.some((reason) =>
                  immutableRevisionMismatches.has(reason),
                ),
            }
          : {}),
      });
      if (!admitted) {
        const current = state.get(intent.id);
        if (current.state === "ready") {
          state.wait(intent.id, current.reason ?? "Waiting for admission");
          store.wait(request.workId, current.reason ?? "Waiting for admission");
        }
        return;
      }
    } catch (error) {
      state.hold(
        intent.id,
        `Storage failure before submission: ${String(error)}`,
      );
      return;
    }
    this.startExecution(request, intent, workspaceKey, previous);
  }

  /** Model settings of the bound profile revision; only Claude profiles carry them. */
  private turnSettings(request: TurnRequest): RuntimeTurnSettings | undefined {
    if (!request.assignmentId || request.profileRevision === null)
      return undefined;
    const domain = this.domain();
    const runtime = domain.profileRuntime(
      String(domain.assignment(request.assignmentId).profileId),
      request.profileRevision,
    );
    return runtime.harness === "claude"
      ? { model: runtime.model, reasoningEffort: runtime.reasoningEffort }
      : undefined;
  }

  /** Never awaited by admission: admissionResumed wakes the scheduler drain. */
  private pollPowerThenWake(
    power: ExecutionPower,
    generation: ServiceGeneration,
  ): void {
    this.observeBackgroundFailure(generation, "power-poll", async () => {
      await power.poll();
      await this.wakeScheduler(0, generation);
    });
  }

  private startExecution(
    request: TurnRequest,
    intent: ExecutionIntent,
    workspace: string,
    previous?: ExecutionIntent,
  ): void {
    const power = this.power;
    const generation = this.generation;
    const action = (async () => {
      try {
        await power?.executionStarted(request.workId);
        return await this.executeAdmitted(
          request,
          intent,
          workspace,
          previous,
          generation,
        );
      } finally {
        await power?.executionEnded(request.workId).catch(() => {});
      }
    })();
    this.active.add(action);
    this.activeByWorkId.set(request.workId, action);
    void action
      .finally(() => {
        this.active.delete(action);
        this.activeByWorkId.delete(request.workId);
        if (generation)
          this.observeBackgroundFailure(generation, "post-turn-wake", () =>
            this.wakeScheduler(0, generation),
          );
      })
      .catch(() => {});
  }

  private async executeAdmitted(
    request: TurnRequest,
    intent: ExecutionIntent,
    workspace: string,
    previous?: ExecutionIntent,
    generation?: ServiceGeneration,
  ): Promise<ExecutionIntent> {
    const state = this.requireState();
    const harness = this.harnessForWork(request.workId);
    const runtime = this.runtimes.get(harness);
    if (!runtime) throw new Error("Runtime unavailable");
    // Shutdown settles active work, so a failed runtime must not leave it pending.
    const guard = <T>(work: Promise<T>) =>
      this.untilFailure(runtime, work, runtimeFailedError);
    let submissionStage: "resume" | "thread" | "bound" | "turn" = "thread";
    let captureThreadId: string | undefined;
    let turnCapture: WorkspaceTurnCaptureRecord | undefined;
    let conversationCapture: ConversationHistoryCapture | undefined;
    let diagnostics: ExecutionDiagnosticsCapture | undefined;
    const comparisonStore = this.workspaceComparisons;
    if (
      comparisonStore &&
      request.kind === "assignment" &&
      request.taskId &&
      request.assignmentId
    ) {
      try {
        const identity = state.taskTurnCaptureIdentity(request.workId);
        if (
          identity &&
          identity.taskId === request.taskId &&
          identity.assignmentId === request.assignmentId &&
          identity.assignmentVersion === request.assignmentVersion &&
          identity.instructionsRevision === request.instructionsRevision &&
          identity.profileRevision === request.profileRevision
        ) {
          const startedAt = Date.now();
          const before = await this.observeTurnWorkspace(request.taskId);
          const capture: WorkspaceTurnCaptureRecord = {
            comparisonId: randomUUID(),
            identity: {
              taskId: identity.taskId,
              taskVersion: identity.taskVersion,
              workId: identity.workId,
              workRevision: identity.workRevision,
              requestSequence: identity.requestSequence,
              assignmentId: identity.assignmentId,
              assignmentVersion: identity.assignmentVersion,
              instructionsRevision: identity.instructionsRevision,
              profileRevision: identity.profileRevision,
              profileId: identity.profileId,
            },
            captureState: "pending",
            outcome: "running",
            startedAt,
            observedAt: before.observedAt,
            before,
          };
          comparisonStore.beginTurnCapture(capture);
          turnCapture = capture;
        }
      } catch {
        // Capture is observational; its storage failure cannot change admission.
      }
    }
    try {
      if (
        !generation ||
        this.generation !== generation ||
        !generation.accepting ||
        this.runtimes.get(harness) !== runtime
      )
        throw new Error(
          "Runtime generation changed before task turn submission",
        );
      if (state.get(intent.id).state !== "submitting")
        throw new Error("Execution admission was held");
      let threadId: string;
      const tools =
        request.kind === "assignment" && request.assignmentId
          ? coordinationTools
          : undefined;
      if (previous?.threadId) {
        if (state.get(intent.id).state !== "submitting")
          throw new Error("Execution admission was held");
        submissionStage = "resume";
        await guard(runtime.resumeThread(previous.threadId, tools));
        threadId = previous.threadId;
      } else {
        if (state.get(intent.id).state !== "submitting")
          throw new Error("Execution admission was held");
        threadId = await guard(runtime.startThread(workspace, tools));
      }
      submissionStage = "bound";
      const threadBound = state.bindThread(intent.id, threadId);
      this.requireSupervisor().threadBound(request.workId, threadId);
      if (!threadBound) throw new Error("Thread binding was held or changed");
      captureThreadId = threadId;
      if (state.get(intent.id).state !== "submitting")
        throw new Error("Execution admission was held");
      conversationCapture = this.beginConversationCapture(
        request,
        workspace,
        runtimeKey(harness, threadId),
        threadId,
      );
      diagnostics = this.beginDiagnosticCapture(
        request,
        intent,
        workspace,
        harness,
        runtime,
        threadId,
      );
      submissionStage = "turn";
      const prebindingGeneration = runtime.currentUserInputGeneration?.();
      const settings = this.turnSettings(request);
      const promptParts = this.executionPromptParts(request);
      const prompt = joinPromptParts(promptParts);
      // Synchronous and caught: recorded before submission, never delaying it.
      if (diagnostics)
        this.recordDiagnosticInputs(
          diagnostics,
          request,
          workspace,
          promptParts,
          prompt,
        );
      const turnId = await guard(
        settings
          ? runtime.startTurn(threadId, workspace, prompt, settings)
          : runtime.startTurn(threadId, workspace, prompt),
      );
      const runtimeGeneration = runtime.currentUserInputGeneration?.();
      let turnBound = runtimeGeneration
        ? state.bindTurn(intent.id, turnId, runtimeGeneration)
        : state.bindTurn(intent.id, turnId);
      let nativeRejected = false;
      if (!turnBound) {
        const reconciliation = state.reconcileNativeTurnStartResponse({
          intentId: intent.id,
          workId: request.workId,
          threadId,
          turnId,
          runtimeGeneration: runtime.currentUserInputGeneration?.(),
        });
        turnBound = reconciliation.status === "matched";
        if (reconciliation.status === "rejected") {
          nativeRejected = true;
          const proof = reconciliation.prebinding;
          const binding = state.runtimeQuestionBinding(
            proof.threadId,
            proof.turnId,
          );
          const bindingMatchesProof =
            proof.workId === request.workId &&
            proof.intentId === intent.id &&
            proof.threadId === threadId &&
            proof.runtimeGeneration === prebindingGeneration &&
            binding !== undefined &&
            (
              [
                "workId",
                "taskId",
                "assignmentId",
                "assignmentVersion",
                "instructionsRevision",
                "profileRevision",
                "conversationRevision",
              ] as const
            ).every((key) => binding[key] === proof[key]);
          const rejectedQuestions = bindingMatchesProof
            ? (
                this.coordination?.runtimeQuestionsForWork(request.workId) ?? []
              ).filter(
                (question) =>
                  question.requestingWorkId === proof.workId &&
                  question.requestingAssignmentId === proof.assignmentId &&
                  question.identity.threadId === proof.threadId &&
                  question.identity.turnId === proof.turnId &&
                  question.identity.runtimeGeneration ===
                    proof.runtimeGeneration &&
                  !["confirmed", "uncertain", "unavailable"].includes(
                    question.deliveryState,
                  ),
              )
            : [];
          state.hold(
            intent.id,
            "Native turn start response disagrees with admitted prebinding",
          );
          for (const question of rejectedQuestions) {
            runtime.cancelUserInput?.(
              question.identity,
              "Native prebinding rejected",
            );
            const current = this.coordination?.runtimeQuestionByEndpoint(
              question.identity,
            );
            if (
              current &&
              !["confirmed", "uncertain", "unavailable"].includes(
                current.deliveryState,
              )
            )
              this.handleUserInputOutcome({
                ...current.identity,
                ...(current.replyIntentId
                  ? {
                      replyIntentId: current.replyIntentId,
                      answerDigest: current.answerDigest ?? undefined,
                    }
                  : {}),
                outcome: current.replyIntentId ? "uncertain" : "unavailable",
                reason: "Native prebinding rejected",
              });
          }
        }
      }
      if (!nativeRejected)
        this.requireSupervisor().turnBound(request.workId, threadId, turnId);
      if (turnBound) {
        diagnostics?.bind(turnId);
        diagnostics?.add(serviceItem("turn-bound", "info", { turnId }));
      }
      if (!turnBound) {
        conversationCapture?.discard();
        if (conversationCapture)
          this.removeConversationCapture(
            runtimeKey(harness, threadId),
            conversationCapture,
          );
        throw new Error("Turn binding was held or changed");
      }
      if (turnCapture && comparisonStore) {
        try {
          if (
            comparisonStore.bindTurnCapture(
              turnCapture.comparisonId,
              threadId,
              turnId,
            )
          )
            turnCapture = { ...turnCapture, threadId, turnId };
          else
            turnCapture = this.persistUnsettledTurnCapture(
              turnCapture,
              "capture-store-failed",
            );
        } catch {
          turnCapture = undefined;
        }
      }
      const exactBinding = this.safeConversationHistoryBinding(
        state,
        request.workId,
        threadId,
        turnId,
      );
      if (exactBinding) conversationCapture?.bind(exactBinding);
      else conversationCapture?.discard();
      const outcome = await guard(runtime.waitForTurn(threadId, turnId));
      diagnostics?.add(serviceItem("terminal-observed", "info", { outcome }));
      conversationCapture?.finish();
      if (conversationCapture)
        this.removeConversationCapture(
          runtimeKey(harness, threadId),
          conversationCapture,
        );
      this.requireSupervisor().terminalObserved(
        request.workId,
        threadId,
        turnId,
        outcome,
      );
      if (turnCapture) {
        const admittedCapture = turnCapture;
        try {
          turnCapture =
            (await this.recordTurnCaptureAfter(
              admittedCapture,
              outcome,
              outcome === "completed" ? "pending" : "unsettled",
            )) ??
            this.persistUnsettledTurnCapture(
              {
                ...admittedCapture,
                outcome,
                observedAt: Date.now(),
              },
              "workspace-unavailable",
            );
        } catch {
          turnCapture = this.persistUnsettledTurnCapture(
            {
              ...admittedCapture,
              outcome,
              observedAt: Date.now(),
            },
            "workspace-unavailable",
          );
        }
      }
      if (
        outcome === "completed" &&
        (this.callbacks.get(request.workId)?.size ?? 0) > 0
      ) {
        state.hold(
          intent.id,
          "Ensemble callback is unfinished at terminal status",
        );
        if (turnCapture)
          turnCapture = this.persistUnsettledTurnCapture(
            turnCapture,
            "callback-unfinished",
          );
      } else if (outcome === "completed") {
        state.complete(intent.id, threadId, turnId);
        if (turnCapture?.comparison) this.finishTurnCapture(turnCapture);
        this.lastCompletedWorkId.set(harness, request.workId);
        const coordination = this.coordination;
        const binding = state.taskBinding(request.workId);
        if (coordination) {
          const delivery = coordination.deliveryForWork(request.workId);
          if (delivery?.state === "queued")
            coordination.completeDeliveryBatch(request.workId);
          if (binding) {
            for (const completion of coordination.completionRequests(
              binding.taskId,
            ))
              if (
                completion.leadWorkId === request.workId &&
                completion.status === "pending"
              )
                await this.finalizeDeliveryCompletion(
                  completion.requestId,
                  request.workId,
                );
            coordination.recordSuccessfulTerminal(request.workId);
          }
        }
      } else {
        state.hold(intent.id, "Bound turn failed or was interrupted");
        const evidence = parseFailureEvidence(
          runtime.failureEvidence?.(threadId, turnId),
        );
        const identity = state.recoveryIdentity(request.workId);
        const callbacksEnded =
          (this.callbacks.get(request.workId)?.size ?? 0) === 0;
        const backoffMs = evidence?.retryAfterMs ?? this.fallbackBackoffMs;
        const now = this.retryNow();
        const nextEligibleAt = now + backoffMs;
        if (
          evidence?.status === "failed" &&
          evidence.threadId === threadId &&
          evidence.turnId === turnId &&
          evidence.classification === "transient" &&
          (evidence.reasonCode === "serverOverloaded" ||
            evidence.reasonCode === "rateLimitExceeded") &&
          evidence.source === "harness" &&
          evidence.harnessRetries !== null &&
          harnessRetrySupported(harness) &&
          callbacksEnded &&
          !this.requireSupervisor().hasKnownRisk(request.workId) &&
          !state.stopTarget(request.workId) &&
          identity?.threadId === threadId &&
          identity.turnId === turnId &&
          Number.isSafeInteger(now) &&
          now >= 0 &&
          Number.isSafeInteger(nextEligibleAt) &&
          nextEligibleAt >= now
        ) {
          state.resolveFailedGeneration({
            workId: request.workId,
            workRevision: identity.workRevision,
            requestSequence: identity.requestSequence,
            threadId,
            turnId,
            terminalStatus: "failed",
            classification: "transient",
            reasonCode: evidence.reasonCode,
            harness,
            source: "harness",
            harnessRetries: evidence.harnessRetries,
            callbacksEnded: true,
            noSurvivor: true,
            effects: "settled",
            nextEligibleAt,
          });
        }
      }
    } catch (error) {
      if (
        submissionStage === "resume" &&
        error instanceof ArchivedResumeRejectedError &&
        previous?.threadId === error.rejection.threadId &&
        state.get(intent.id).state === "submitting"
      )
        state.capturePreTurnRejection(request.workId, error.rejection);
      if (state.get(intent.id).state !== "held")
        state.hold(
          intent.id,
          `Runtime submission or observation uncertain: ${String(error)}`,
        );
      if (turnCapture) {
        const admittedCapture = turnCapture;
        try {
          if (admittedCapture.comparison) {
            this.persistUnsettledTurnCapture(
              admittedCapture,
              admittedCapture.turnId ? "runtime-uncertain" : "turn-unbound",
            );
          } else {
            turnCapture =
              (await this.recordTurnCaptureAfter(
                admittedCapture,
                "unknown",
                "unsettled",
                admittedCapture.turnId ? "runtime-uncertain" : "turn-unbound",
              )) ??
              this.persistUnsettledTurnCapture(
                {
                  ...admittedCapture,
                  outcome: "unknown",
                  observedAt: Date.now(),
                },
                admittedCapture.turnId ? "runtime-uncertain" : "turn-unbound",
              );
          }
        } catch {
          this.persistUnsettledTurnCapture(
            {
              ...admittedCapture,
              outcome: "unknown",
              observedAt: Date.now(),
            },
            admittedCapture.turnId ? "runtime-uncertain" : "turn-unbound",
          );
        }
      }
    } finally {
      if (conversationCapture) {
        conversationCapture.discard();
        if (captureThreadId)
          this.removeConversationCapture(
            runtimeKey(harness, captureThreadId),
            conversationCapture,
          );
      }
      if (diagnostics) {
        try {
          const settled = state.get(intent.id);
          diagnostics.add(
            serviceItem(
              "execution-settled",
              settled.state === "completed" ? "info" : "warn",
              { state: settled.state, reason: settled.reason },
            ),
          );
        } catch {
          // Display only; the settled state stays authoritative in its own table.
        }
        diagnostics.finish();
      }
    }
    return state.get(intent.id);
  }

  private beginConversationCapture(
    request: TurnRequest,
    workspace: string,
    captureKey: string,
    threadId: string,
  ): ConversationHistoryCapture | undefined {
    try {
      const history = this.conversationHistory;
      const state = this.state;
      if (!history || !state || !request.taskId) return undefined;
      const binding = state.taskBinding(request.workId);
      if (!binding || binding.taskId !== request.taskId) return undefined;
      const capture = new ConversationHistoryCapture({
        store: history,
        workId: request.workId,
        threadId,
        captureStartExclusions: this.conversationExclusions(
          binding,
          workspace,
          true,
        ),
        currentExclusions: () =>
          this.conversationExclusions(binding, workspace, false),
      });
      const previous = this.conversationCaptures.get(captureKey);
      previous?.discard();
      this.conversationCaptures.set(captureKey, capture);
      return capture;
    } catch {
      return undefined;
    }
  }

  /** Diagnostic store for operator reads; undefined until started or when unavailable. */
  executionDiagnostics(): ExecutionDiagnosticsStore | undefined {
    return this.diagnosticsStore;
  }

  /**
   * Starts capture for a task-bound execution once its thread is bound. Baseline
   * projects get an execution row and a `capture-baseline` gap only. Never throws.
   */
  private beginDiagnosticCapture(
    request: TurnRequest,
    intent: ExecutionIntent,
    workspace: string,
    harness: ExecutionHarness,
    runtime: Runtime,
    threadId: string,
  ): ExecutionDiagnosticsCapture | undefined {
    try {
      const store = this.diagnosticsStore;
      const binding = this.state?.taskBinding(request.workId);
      if (!store || !binding || !request.projectId) return undefined;
      const domain = this.domain();
      const mode = domain.diagnosticCaptureMode(request.projectId);
      store.begin({
        workId: request.workId,
        taskId: binding.taskId,
        projectId: request.projectId,
        assignmentId: binding.assignmentId,
        assignmentVersion: binding.assignmentVersion,
        instructionsRevision: binding.instructionsRevision,
        profileRevision: binding.profileRevision,
        conversationRevision: binding.conversationRevision,
        harness,
        mode,
        eventSource: runtime.onDiagnosticEvent ? "supported" : "unsupported",
      });
      store.bindThread(request.workId, threadId);
      if (mode === "baseline") {
        store.gap(request.workId, "capture-baseline");
        store.finish(request.workId);
        return undefined;
      }
      const start = this.conversationExclusions(binding, workspace, true);
      const capture = new ExecutionDiagnosticsCapture({
        store,
        workId: request.workId,
        threadId,
        exclusions: () =>
          unionExclusions(
            start,
            this.conversationExclusions(binding, workspace, false),
          ),
      });
      const key = runtimeKey(harness, threadId);
      this.diagnosticCaptures.delete(key);
      this.diagnosticCaptures.set(key, capture);
      for (const old of this.diagnosticCaptures.keys()) {
        if (this.diagnosticCaptures.size <= 128) break;
        this.diagnosticCaptures.delete(old);
      }
      capture.add(serviceItem("thread-bound", "info", { threadId }));
      capture.add({
        turnId: undefined,
        kind: "setting",
        name: "settings",
        severity: "info",
        itemId: undefined,
        payload: {
          entries: this.diagnosticSettings(
            request,
            intent,
            harness,
            runtime,
            threadId,
          ),
        },
      });
      return capture;
    } catch {
      return undefined;
    }
  }

  private diagnosticSettings(
    request: TurnRequest,
    intent: ExecutionIntent,
    harness: ExecutionHarness,
    runtime: Runtime,
    threadId: string,
  ) {
    const admitted = (name: string, value: unknown) => ({
      name,
      value,
      source: "service-admitted",
    });
    const entries = [
      admitted("harness", harness),
      admitted("sandbox", intent.sandbox),
      admitted("approval", intent.approval),
      admitted("accountType", intent.accountType),
    ];
    try {
      const domain = this.domain();
      if (request.assignmentId && request.profileRevision !== null) {
        const configured = domain.profileRuntime(
          String(domain.assignment(request.assignmentId).profileId),
          request.profileRevision,
        );
        if (configured.harness === "claude")
          entries.push(
            admitted("profile.model", configured.model),
            admitted("profile.reasoningEffort", configured.reasoningEffort),
          );
      }
    } catch {
      // A missing profile revision leaves only the intent's settings.
    }
    let observed: Record<string, unknown> | undefined;
    try {
      observed = runtime.observedSettings?.(threadId) as
        | Record<string, unknown>
        | undefined;
    } catch {
      observed = undefined;
    }
    for (const name of [
      "model",
      "modelProvider",
      "reasoningEffort",
      "serviceTier",
    ])
      entries.push(
        observed && name in observed
          ? { name, value: observed[name], source: "runtime-reported" }
          : { name, value: null, source: "unknown" },
      );
    return entries;
  }

  /**
   * Records each supplied segment and the submitted size and digest. Instruction
   * segments keep the execution's own profile and project instruction texts
   * readable; every other value stays redacted.
   */
  private recordDiagnosticInputs(
    capture: ExecutionDiagnosticsCapture,
    request: TurnRequest,
    workspace: string,
    parts: readonly PromptPart[],
    prompt: string,
  ): void {
    try {
      const binding = this.requireState().taskBinding(request.workId);
      if (!binding) throw new Error("Execution binding unavailable");
      const general = unionExclusions(
        this.conversationExclusions(binding, workspace, true),
        this.conversationExclusions(binding, workspace, false),
      );
      const domain = this.domain();
      const assignment = domain.assignment(binding.assignmentId);
      const projectId = String(assignment.projectId),
        profileId = String(assignment.profileId);
      const own = new Set([
        String(
          domain.profileRevision(profileId, binding.profileRevision)
            .instructions ?? "",
        ),
        String(domain.profile(profileId).instructions ?? ""),
        domain.instructionRevision(projectId, binding.instructionsRevision),
        domain.instructionRevision(
          projectId,
          Number(domain.project(projectId).instructionsRevision),
        ),
      ]);
      const disclosing = general?.filter((value) => !own.has(value));
      for (const part of parts)
        capture.recordNow(
          "input",
          part.name,
          {
            text: part.text,
            ...(part.revision === undefined ? {} : { revision: part.revision }),
          },
          part.name.endsWith("-instructions") ? disclosing : general,
        );
      capture.recordNow(
        "input",
        "submitted",
        {
          bytes: Buffer.byteLength(prompt, "utf8"),
          sha256: createHash("sha256").update(prompt).digest("hex"),
        },
        [],
      );
      capture.add(
        serviceItem("input-captured", "info", { segments: parts.length }),
      );
    } catch {
      capture.gap("input-failed");
    }
  }

  /** Returns the listener's own result or rejection untouched. */
  private observeToolCall(
    call: RuntimeToolCall,
    harness: ExecutionHarness,
    result: Promise<RuntimeToolResult>,
  ): Promise<RuntimeToolResult> {
    const record = (payload: Record<string, unknown>, severity: string) => {
      try {
        this.diagnosticCaptures.get(runtimeKey(harness, call.threadId))?.add({
          turnId: call.turnId,
          kind: "tool",
          name: call.tool,
          severity,
          itemId: call.callId,
          payload: { arguments: call.arguments, ...payload },
        });
      } catch {
        // Diagnostics never change the tool response.
      }
    };
    return result.then(
      (value) => {
        record(
          { success: value.success, result: value.text },
          value.success ? "info" : "warn",
        );
        return value;
      },
      (error: unknown) => {
        record({ success: false, error: "rejected" }, "error");
        throw error;
      },
    );
  }

  private diagnosticServiceEvent(
    workId: string,
    name: string,
    severity: string,
    payload: Record<string, unknown>,
  ): void {
    try {
      for (const capture of this.diagnosticCaptures.values())
        if (capture.workId === workId)
          capture.add(serviceItem(name, severity, payload));
    } catch {
      // Diagnostics never change anomaly handling.
    }
  }

  private safeConversationHistoryBinding(
    state: ExecutionState,
    workId: string,
    threadId: string,
    turnId: string,
  ) {
    try {
      return state.conversationHistoryBinding(workId, threadId, turnId);
    } catch {
      return undefined;
    }
  }

  private receiveConversationEvent(
    event: RuntimeConversationEvent,
    harness: ExecutionHarness,
  ): void {
    this.conversationCaptures
      .get(runtimeKey(harness, event.threadId))
      ?.receive(event);
  }

  private removeConversationCapture(
    captureKey: string,
    capture: ConversationHistoryCapture,
  ): void {
    if (this.conversationCaptures.get(captureKey) === capture)
      this.conversationCaptures.delete(captureKey);
  }

  private clearConversationCaptures(): void {
    for (const capture of this.conversationCaptures.values()) capture.discard();
    this.conversationCaptures.clear();
    // Unfinished rows are marked interrupted by closeOpen at the next start.
    this.diagnosticCaptures.clear();
  }

  private conversationExclusions(
    binding: TaskExecutionBinding,
    workspace: string,
    captureStart: boolean,
  ): readonly string[] | undefined {
    return this.conversationExclusionsForAssignment(
      binding.taskId,
      binding.assignmentId,
      captureStart
        ? {
            profileRevision: binding.profileRevision,
            instructionsRevision: binding.instructionsRevision,
          }
        : undefined,
      [workspace],
    );
  }

  private readConversationHistory(
    taskId: string,
    assignmentId: string,
    beforeSequence?: number,
    beforeOmissionSequence?: number,
    limit = 200,
  ): ConversationHistoryAssignmentRead {
    const history = this.conversationHistory;
    if (!history) throw new Error("Service is not started");
    return history.readAssignment(
      taskId,
      assignmentId,
      limit,
      this.conversationExclusionsForAssignment(taskId, assignmentId),
      beforeSequence,
      beforeOmissionSequence,
    );
  }

  private conversationExclusionsForAssignment(
    taskId: string,
    assignmentId: string,
    revisions?: { profileRevision: number; instructionsRevision: number },
    additionalPaths: readonly string[] = [],
  ): readonly string[] | undefined {
    const domain = this.domainState;
    if (!domain) return undefined;
    try {
      const assignment = domain.assignment(assignmentId);
      if (String(assignment.taskId) !== taskId) return undefined;
      const projectId = String(assignment.projectId);
      const profileId = String(assignment.profileId);
      const profileInstructions = revisions
        ? domain.profileRevision(profileId, revisions.profileRevision)
            .instructions
        : domain.profile(profileId).instructions;
      const project = domain.project(projectId);
      const projectInstructions = domain.instructionRevision(
        projectId,
        revisions?.instructionsRevision ?? Number(project.instructionsRevision),
      );
      const discovery = domain.discoveryCredentialReference();
      const fixtureValues =
        this.options.conversationHistoryExclusions?.() ?? [];
      const workspace = this.workspaceBindings?.get(taskId);
      const managedPaths = workspace
        ? [
            workspace.path,
            ...workspace.repositories.flatMap((repository) => [
              repository.sourcePath,
              repository.workspacePath,
              ...(repository.gitCommonDir ? [repository.gitCommonDir] : []),
            ]),
          ]
        : [];
      this.canonicalDataDir ??= existsSync(this.dataDir)
        ? realpathSync(this.dataDir)
        : this.dataDir;
      const values = [
        String(profileInstructions ?? ""),
        projectInstructions,
        this.dataDir,
        this.canonicalDataDir,
        ...managedPaths,
        ...additionalPaths,
        ...Object.entries(process.env).flatMap(([name, value]) =>
          /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/.test(name) && value
            ? [value]
            : [],
        ),
        ...[discovery, domain.claudeTokenReference()].flatMap((ref) =>
          ref ? [ref, ref.slice(4), process.env[ref.slice(4)] ?? ""] : [],
        ),
        ...fixtureValues,
        ...domain.projects().flatMap((p) => {
          const id = String(p.id);
          return [
            domain.routingCredentialReference(id),
            domain.githubConfiguration(id).credentialRef,
            this.deliveryStore?.configuration(id).credentialRef,
          ].flatMap((ref) =>
            ref ? [ref, ref.slice(4), process.env[ref.slice(4)] ?? ""] : [],
          );
        }),
      ];
      return values.filter((value) => value.length > 0);
    } catch {
      return undefined;
    }
  }

  private validateDirectWorkspace(workspace: string): string {
    if (
      !isAbsolute(workspace) ||
      !existsSync(workspace) ||
      !lstatSync(workspace).isDirectory()
    )
      throw new Error("Workspace must be an existing real directory");
    const workspaceKey = realpathSync(workspace);
    const managedRoot = join(realpathSync(this.dataDir), "workspaces");
    if (isWithin(managedRoot, workspaceKey))
      throw new Error("Task workspaces require a durable assignment binding");
    return workspaceKey;
  }

  private requireSchedulerStore(): SchedulerStore {
    if (!this.schedulerStore) throw new Error("Service is not started");
    return this.schedulerStore;
  }

  private requireSupervisor(): ExecutionSupervisor {
    if (!this.supervisor) throw new Error("Service is not started");
    return this.supervisor;
  }

  private requireState(): ExecutionState {
    if (!this.state) throw new Error("Service is not started");
    return this.state;
  }

  private requireWorkspaces(): WorkspaceManager {
    if (!this.workspaces) throw new Error("Service is not started");
    return this.workspaces;
  }
}
