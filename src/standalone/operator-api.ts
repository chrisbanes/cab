import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { setImmediate as yieldTraversal } from "node:timers/promises";
import { z } from "zod";
import {
  CommandResultValidationError,
  type DomainCommandResultMap,
  LinkedRepositoryValidationError,
  parseDomainCommandOutcome,
} from "../core/command-results.js";
import type {
  CoordinationInteraction,
  TaskCompletionRequest,
} from "../core/coordination.js";
import type { OperatorCommentReview } from "../core/delivery.js";
import { isOperatorDeliveryCaller, materialDigest } from "../core/delivery.js";
import {
  type DomainCommand,
  DomainCommands,
  DomainConflictError,
  DomainNotFoundError,
  DomainOperationError,
  DomainPolicyError,
  ProjectNameTakenError,
  TaskNotOpenError,
} from "../core/domain.js";
import {
  LocalReviewAnchorRequiredError,
  LocalReviewBatchTooLargeError,
  LocalReviewRecipientUnavailableError,
  type LocalReviewRequest,
  type LocalReviewSyncIdentity,
} from "../core/local-review.js";
import {
  nativeQuestionForm,
  type QuestionAnswers,
  type QuestionForm,
  questionFormSchema,
} from "../core/question-forms.js";
import {
  executionHarnessLabels,
  executionIntentStateSchema,
} from "../core/execution-runtime.js";
import {
  runtimeInboxHeadline,
  runtimeInboxReason,
  runtimeSettingsPath,
} from "../operator/runtime-restart-copy.js";
import type { StructuredQuestionSet } from "../core/structured-questions.js";
import type { Readiness } from "../core/github-source-contracts.js";
import type { TaskReadiness } from "../core/github-source.js";
import { taskReviewReadSchema } from "../core/task-review.js";
import {
  admissionSchema,
  assignmentDetailSchema,
  assignmentHistorySchema,
  assignmentInstructionsSchema,
  assignmentRecoverySchema,
  checkoutVerificationSchema,
  checkoutVerifyRequestSchema,
  claudeTokenStatusSchema,
  commandReceiptSchema,
  composerOptionsSchema,
  draftingRunReadSchema,
  configurationImpactSchema,
  deliveryReadSchema,
  discoveryBranchesSchema,
  discoveryProjectFieldsSchema,
  discoveryProjectsSchema,
  discoveryRepositoriesSchema,
  discoveryStatusSchema,
  type Execution,
  executionDetailSchema,
  executionEventsSchema,
  executionInputsSchema,
  executionListSchema,
  folderListingSchema,
  folderListRequestSchema,
  type InboxItem,
  type TaskInboxItem,
  inboxReadSchema,
  instructionProvenance,
  materialSchema,
  operationReadSchema,
  operationScopeSchema,
  operationTypeSchema,
  operatorCommandSchema,
  profileConfigurationSchema,
  profilePrivateValuesSchema,
  profileInstructionsSchema,
  projectConfigurationSchema,
  projectPrivateValuesSchema,
  projectInstructionsSchema,
  projectSchema,
  questionReadSchema,
  setupHomeSchema,
  recoveryObservationSchema,
  retainedEvidenceItemContentReadSchema,
  retainedResultEvidenceReadSchema,
  retainedReviewAnchorReadSchema,
  reviewReadSchema,
  runtimeSettingsSchema,
  searchQuerySchema,
  searchReadSchema,
  sourceObservationSchema,
  taskListPageSchema,
  taskListQuerySchema,
  taskMessagePageSchema,
  taskRecordQuerySchema,
  taskResultPageSchema,
  taskSchema,
  unsupportedRuntimeField,
  uuid,
  workIdSchema,
  workspaceComparisonReadRequestSchema,
  workspaceComparisonReadSchema,
  workspaceDirectoryReadSchema,
  workspacePreviewReadSchema,
  workspaceSchema,
} from "../operator/contracts.js";
import {
  type CommentReasonCode,
  issueEditReasonSentences,
} from "../operator/github-reasons.js";
import { deriveWaits } from "../operator/wait-reasons.js";
import {
  type AttentionCode,
  attentionNext,
  interventionCode,
} from "../operator/attention.js";
import {
  claudeTokenExclusions,
  claudeTokenSource,
  readClaudeToken,
} from "./claude-token.js";
import {
  type ConversationHistoryBinding,
  isDisclosable,
  prepareExclusions,
  sanitizeConversationText,
} from "./conversation-history.js";
import type {
  CoordinationTaskView,
  CoordinationView,
} from "./coordination-view.js";
import { DraftTurnUnavailableError } from "./draft-turn.js";
import {
  boundDetail,
  DiagnosticCursorError,
  type DiagnosticExecution,
  type DiagnosticItem,
  type ExecutionDiagnosticsStore,
} from "./execution-diagnostics.js";
import {
  credentialReferenceExclusions,
  GhLoginScope,
  type GhOptions,
  ghEnvironment,
  ghToken,
} from "./gh-credential.js";
import {
  DiscoveryFailure,
  type DiscoveryReader,
  GitHubDiscoveryReader,
} from "./github-discovery.js";
import type { GitHubSourceReader } from "./github-source.js";
import type { SourceCredentialReason } from "./github-source-credential.js";
import { commandReceipt, ReceiptShapeError } from "./operator-receipts.js";
import {
  executeRecovery,
  isRecoveryCommand,
  isRecoveryType,
  readRecoveryOperation,
  recoveryOptions,
} from "./operator-recovery.js";
import { selectAssignmentExecution } from "./operator-runtime.js";
import {
  FolderAccessError,
  listHomeFolders,
  type OperatorSetupSeams,
  resolveHomePath,
  verifyCheckout,
} from "./operator-setup.js";
import { RecoveryRejectedError } from "./recovery-types.js";
import { retainedReviewAnchorStageRequestSchema } from "./retained-evidence.js";
import {
  RuntimeConfigurationRefusedError,
  type StandaloneService,
} from "./service.js";
import { refusedRevisionPrefix } from "./state.js";
import { ArtifactUnavailable, previewRecordedArtifact } from "./task-review.js";
import {
  compareRepository,
  type WorkspaceComparisonSideContent,
  type WorkspaceComparisonSnapshot,
  type WorkspaceTurnCaptureRecord,
} from "./workspace-comparison.js";
import {
  listWorkspaceDirectory,
  previewRetainedBytes,
  previewWorkspaceFile,
  retainedPathExcluded,
  type WorkspaceInspectionCurrent,
  WorkspaceInspectionInputError,
  type WorkspaceInspectionPathReference,
  type WorkspaceInspectionRequest,
  workspaceInspectionBindingIdentity,
  workspaceInspectionPathsExcluded,
} from "./workspace-inspection.js";

type ReadinessByTask = ReadonlyMap<string, TaskReadiness>;
type Row =
  ReturnType<StandaloneService["domain"]> extends { task(id: string): infer R }
    ? R
    : never;
type RecoveryHoldScope = "task-wide" | "selected-assignment";
type RetainedReadPolicy = {
  taskId: string;
  projectId: string;
  taskVersion: number;
  visibility: string;
  workspaceVisibility: string;
  excluded: readonly string[];
  controlPaths: readonly string[];
  authorizedRepositoryIds: readonly string[];
  fingerprint: string;
  /** File-access inputs only; review drafts survive unrelated version changes. */
  accessFingerprint: string;
};
type RetainedDiffPayload = {
  version: 1;
  repositoryId: string | null;
  path: string;
  previousPath?: string;
  left: { state: "absent" } | { state: "text"; text: string };
  right: { state: "absent" } | { state: "text"; text: string };
};
const relativePolicySegments = (path: string): string[] | undefined => {
  if (
    !path ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[a-z]:/i.test(path) ||
    path.includes("\\")
  )
    return undefined;
  const segments = path.split("/");
  return segments.length <= 32 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !/\p{Cc}/u.test(segment),
    ) &&
    Buffer.byteLength(path, "utf8") <= 2048
    ? segments
    : undefined;
};
function parseRetainedDiff(bytes: Buffer): RetainedDiffPayload | undefined {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    const source = value as Record<string, unknown>;
    if (
      source.version !== 1 ||
      (source.repositoryId !== null &&
        typeof source.repositoryId !== "string") ||
      typeof source.path !== "string" ||
      (source.previousPath !== undefined &&
        typeof source.previousPath !== "string")
    )
      return undefined;
    const parseSide = (
      side: unknown,
    ): RetainedDiffPayload["left"] | undefined => {
      if (!side || typeof side !== "object" || Array.isArray(side))
        return undefined;
      const record = side as Record<string, unknown>;
      if (record.state === "absent" && Object.keys(record).length === 1)
        return { state: "absent" };
      if (record.state === "text" && typeof record.text === "string")
        return { state: "text", text: record.text };
      return undefined;
    };
    const left = parseSide(source.left);
    const right = parseSide(source.right);
    if (!left || !right) return undefined;
    return {
      version: 1,
      repositoryId: source.repositoryId as string | null,
      path: source.path,
      ...(source.previousPath
        ? { previousPath: source.previousPath as string }
        : {}),
      left,
      right,
    };
  } catch {
    return undefined;
  }
}
function retainedAnchorRange(
  source: Buffer,
  startLine: number,
  endLine: number,
) {
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  )
    return undefined;
  const lines: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === 0x0a) {
      lines.push({ start, end: index + 1 });
      start = index + 1;
    }
  }
  if (start < source.length) lines.push({ start, end: source.length });
  if (endLine > lines.length) return undefined;
  const byteStart = lines[startLine - 1]?.start;
  const byteEnd = lines[endLine - 1]?.end;
  if (byteStart === undefined || byteEnd === undefined) return undefined;
  return {
    byteStart,
    byteEnd,
    bytes: source.subarray(byteStart, byteEnd),
  };
}
function exactRetainedAnchorExcerpt(
  anchor: NonNullable<
    ReturnType<
      ReturnType<StandaloneService["retainedEvidence"]>["reviewAnchor"]
    >
  >["anchor"],
  source: Buffer,
  excerpt: Buffer,
) {
  const range = retainedAnchorRange(source, anchor.startLine, anchor.endLine);
  return Boolean(
    range &&
      range.byteStart === anchor.byteStart &&
      range.byteEnd === anchor.byteEnd &&
      range.bytes.equals(excerpt) &&
      range.bytes.byteLength === anchor.size &&
      createHash("sha256").update(range.bytes).digest("hex") ===
        anchor.excerptSha256,
  );
}
function retainedTextLineCount(text: string) {
  if (!text) return 0;
  let count = 0;
  for (const character of text) if (character === "\n") count++;
  return text.endsWith("\n") ? count : count + 1;
}
export class OperatorApiError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | "not-found"
      | "invalid-input"
      | "forbidden"
      | "conflict"
      | "unavailable"
      | "unauthenticated"
      | "command-outcome-unknown"
      | "local-review-batch-too-large"
      | "local-review-recipient-unavailable"
      | "local-review-comment-anchor-required"
      | "runtime-executable-missing"
      | "runtime-confirmation-required",
    readonly fieldPaths?: readonly string[],
    readonly credentialReason?: SourceCredentialReason,
    /** Fixed copy that replaces the code's generic public message. */
    readonly publicMessage?: string,
  ) {
    super(code);
  }
}

function domainApiError(error: unknown): OperatorApiError | undefined {
  if (error instanceof LinkedRepositoryValidationError)
    return new OperatorApiError(503, "unavailable");
  // Any other result failed validation after its command ran, so its effect is unknown.
  if (error instanceof CommandResultValidationError)
    return new OperatorApiError(503, "command-outcome-unknown");
  if (error instanceof DomainOperationError)
    return new OperatorApiError(503, "command-outcome-unknown");
  if (error instanceof DomainConflictError)
    return new OperatorApiError(409, "conflict");
  if (error instanceof DomainNotFoundError)
    return new OperatorApiError(404, "not-found");
  if (error instanceof ProjectNameTakenError) {
    const named = `Another project is named ${error.existingName}. Choose a different name.`;
    return new OperatorApiError(
      400,
      "invalid-input",
      ["name"],
      undefined,
      // The response schema bounds a message to 256 characters.
      named.length <= 256
        ? named
        : "Another project has this name. Choose a different name.",
    );
  }
  if (error instanceof DomainPolicyError)
    return new OperatorApiError(
      error.code === "forbidden" ? 403 : 400,
      error.code,
      error.fieldPaths,
    );
  return undefined;
}

/** The refusal's fixed public copy; the CLI prints it and the web names the same cause. */
function runtimeRefusal(error: RuntimeConfigurationRefusedError) {
  const label = executionHarnessLabels[error.harness];
  if (error.code === "unavailable")
    return new OperatorApiError(503, "unavailable");
  if (error.code === "runtime-executable-missing")
    return new OperatorApiError(
      409,
      error.code,
      undefined,
      undefined,
      `${label} was not turned on: \`${error.harness}\` not found on the service PATH.`,
    );
  const n = error.boundTasks;
  return new OperatorApiError(
    409,
    error.code,
    undefined,
    undefined,
    `${n} ${n === 1 ? "task uses" : "tasks use"} ${label}. Running turns finish; their next turns wait until ${label} is enabled again.`,
  );
}

export type OperatorReviewSessionContext = {
  ownerKey: string;
  current: () => boolean;
};

type LocalReviewCommand = Extract<
  z.infer<typeof operatorCommandSchema>,
  {
    type:
      | "review.anchor.stage"
      | "review.draft.save"
      | "review.draft.discard"
      | "review.send"
      | "review.send.reconcile";
  }
>;
function githubIssueUrl(repositoryName: string | null, number: number | null) {
  return repositoryName && number
    ? `https://github.com/${repositoryName}/issues/${number}`
    : null;
}

/**
 * The pull request's link, built only from a name verified for the PR's own repository:
 * the source's name counts only when its repository id is the PR's, and neither path
 * segment may be a dot segment.
 */
export function githubPullUrl(
  repositoryName: string | null,
  sourceRepositoryId: string | null,
  pullRequestRepositoryId: string,
  number: number,
) {
  if (
    !repositoryName ||
    sourceRepositoryId !== pullRequestRepositoryId ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryName) ||
    repositoryName.split("/").some((part) => part === "." || part === "..")
  )
    return null;
  return `https://github.com/${repositoryName}/pull/${number}`;
}

/** See `OperatorApi.exclusionBase`; one read attempt owns it. */
type ExclusionBase = {
  readonly values: readonly (readonly [tag: string | null, value: string])[];
  readonly covered: ReadonlySet<string>;
} | null;

export class OperatorApi {
  private readonly commands: DomainCommands;
  private readonly activeReviewSends = new Map<string, string>();
  private readonly activeReviewStages = new Map<string, string>();
  constructor(
    private readonly service: StandaloneService,
    private readonly controlPaths: readonly string[] = [],
    private readonly coordination: () => CoordinationView = () =>
      service.coordinationView(),
    private readonly previewReader: (
      credentialRef: string,
    ) => Pick<GitHubSourceReader, "readSelection"> = (ref) =>
      service.gitHubSourceReader(ref),
    private readonly setup: OperatorSetupSeams = {},
  ) {
    this.commands = new DomainCommands(service.domain());
  }
  private visibilityToken() {
    const d = this.domain();
    return createHash("sha256")
      .update(
        JSON.stringify({
          profiles: d.profiles().map((p) => [p.id, p.version, p.revoked]),
          projects: d
            .projects()
            .map((p) => [
              p.id,
              p.version,
              p.instructionsRevision,
              d.githubConfiguration(String(p.id)).version,
              d.routing(String(p.id)).version,
              this.service.delivery().configuration(String(p.id)).version,
            ]),
          credentials: Object.entries(process.env).filter(([key]) =>
            /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/.test(key),
          ),
          references: this.referenceFence(),
        }),
      )
      .digest("hex");
  }
  /**
   * Every credential reference the exclusions read, with a digest of its resolved value, so
   * a read fences when a reference or its value changes whatever the variable is named.
   */
  private referenceFence() {
    const d = this.domain(),
      claude = d.claudeTokenReference(),
      digest = (text: string) =>
        createHash("sha256").update(text).digest("hex");
    // A file reference fences on its value, or on why there is none.
    const claudeRead = claude && readClaudeToken(claudeTokenSource(claude));
    const discovery = d.discoveryCredentialReference();
    return JSON.stringify([
      digest(this.service.gitHubCredentialExclusions().values.join("\0")),
      // Discovery reference also fences identity.
      discovery
        ? [
            discovery,
            digest(credentialReferenceExclusions(discovery).values.join("\0")),
          ]
        : null,
      claude && claudeRead
        ? [
            claude,
            digest(
              "value" in claudeRead
                ? claudeRead.value
                : `problem:${claudeRead.problem}`,
            ),
          ]
        : null,
      ...[
        ...d
          .projects()
          .flatMap((p) => [
            d.routingCredentialReference(String(p.id)),
            d.githubConfiguration(String(p.id)).credentialRef,
            d.deliveryCredentialReference(String(p.id)),
          ]),
      ].map((ref) =>
        ref
          ? [
              ref,
              digest(
                ref.startsWith("env:") ? (process.env[ref.slice(4)] ?? "") : "",
              ),
            ]
          : null,
      ),
    ]);
  }
  private domain() {
    return this.service.domain();
  }
  private requireProject(id: string) {
    uuid.parse(id);
    if (
      !this.domain()
        .projects()
        .some((p) => p.id === id)
    )
      throw new OperatorApiError(404, "not-found");
    return this.domain().project(id);
  }
  /** Maps only a missing domain record to 404; other failures propagate. */
  private existing<T>(read: () => T): T {
    try {
      return read();
    } catch (error) {
      if (error instanceof DomainNotFoundError)
        throw new OperatorApiError(404, "not-found");
      throw error;
    }
  }
  /** The bounded task catalogue; 503 above ten thousand identities. */
  private catalog() {
    const catalog = this.domain().taskCatalog();
    if (catalog.length > 10000) throw new OperatorApiError(503, "unavailable");
    return catalog;
  }
  /** Readable only while `projects()` lists the task's project. */
  private requireTask(id: string) {
    uuid.parse(id);
    const d = this.domain(),
      task = this.existing(() => d.task(id));
    if (!d.projectListed(String(task.projectId)))
      throw new OperatorApiError(404, "not-found");
    return task;
  }
  /**
   * One read's global exclusion inputs: instruction revisions tagged for dedicated
   * disclosure, credentials and repository paths, read once and null past a bound.
   * Pass it to every `exclusions` call of the read; post-await fences stay live.
   */
  private exclusionBase(): ExclusionBase {
    try {
      const d = this.domain(),
        profiles = d.profiles(),
        projects = d.projects();
      const values: [tag: string | null, value: string][] = [],
        covered = new Set<string>(),
        add = (...items: string[]) => {
          for (const value of items) values.push([null, value]);
        };
      add(...this.controlPaths);
      const claude = d.claudeTokenReference();
      add(...this.service.gitHubCredentialExclusions().redactions);
      if (claude) add(...claudeTokenExclusions(claude).redactions);
      // Bound retained-revision lookups before iterating persisted counters.
      let remaining = 128;
      if (profiles.length + projects.length > remaining) return null;
      for (const profile of profiles) {
        const count = Number(profile.version);
        if (!Number.isSafeInteger(count) || count < 1 || count > remaining)
          return null;
        remaining -= count;
        for (let revision = 1; revision <= count; revision++) {
          values.push([
            `profile:${profile.id}`,
            String(
              d.profileRevision(String(profile.id), revision).instructions,
            ),
          ]);
          covered.add(`profile:${profile.id}:${revision}`);
        }
      }
      for (const project of projects) {
        const id = String(project.id),
          count = Number(project.instructionsRevision);
        if (!Number.isSafeInteger(count) || count < 1 || count > remaining)
          return null;
        remaining -= count;
        for (let revision = 1; revision <= count; revision++) {
          values.push([`project:${id}`, d.instructionRevision(id, revision)]);
          covered.add(`project:${id}:${revision}`);
        }
        const g = d.githubConfiguration(id);
        for (const ref of [
          d.routingCredentialReference(id),
          d.deliveryCredentialReference(id),
        ])
          if (ref) {
            const envKey = ref.slice(4);
            add(ref, envKey);
            const value = process.env[envKey];
            if (value) add(value);
          }
        if (g.repositories.length > 128) return null;
        for (const repo of g.repositories)
          add(repo.path, repo.gitCommonDirectory);
      }
      return { values, covered };
    } catch {
      return null;
    }
  }
  /** A prepared list from `base` plus the task's own captured-revision checks and paths. */
  private async exclusions(
    projectId?: string,
    taskId?: string,
    historyBindings: readonly ConversationHistoryBinding[] = [],
    /** Only for dedicated instruction views: `profile:ID`/`project:ID` texts to leave unredacted. */
    disclose: readonly string[] = [],
    base: ExclusionBase = this.exclusionBase(),
  ): Promise<readonly string[] | undefined> {
    if (!base) return undefined;
    try {
      const d = this.domain(),
        { covered } = base;
      const values = base.values.flatMap(([tag, value]) =>
        tag !== null && disclose.includes(tag) ? [] : [value],
      );
      if (taskId) {
        // The 128-row bound is this task's own retained rows, counted before any row is read.
        if (this.service.taskRetainedRowsExceed(taskId, 128)) return undefined;
        const assignments = d.assignments(taskId);
        if (assignments.length > 128 || historyBindings.length > 400)
          return undefined;
        const retained = [
          ...this.service.turnRequestsForTask(taskId),
          ...this.service
            .recoveryForTask(taskId)
            .flatMap((r) => (r.binding ? [r.binding] : [])),
          ...historyBindings,
        ];
        const assignmentIds = new Set(assignments.map((a) => String(a.id)));
        if (
          retained.some(
            (r) =>
              r.assignmentId === null || !assignmentIds.has(r.assignmentId),
          )
        )
          return undefined;
        for (const a of assignments) {
          for (const snapshot of [
            a,
            ...retained.filter((r) => r.assignmentId === a.id),
          ]) {
            // Missing or inconsistent captured revisions cannot be ignored.
            if (
              !covered.has(
                `project:${projectId}:${snapshot.instructionsRevision}`,
              ) ||
              !covered.has(`profile:${a.profileId}:${snapshot.profileRevision}`)
            )
              return undefined;
          }
        }
        // Polled reads use the stored binding; identity validation happens at recovery,
        // execution and explicit inspection.
        values.push(...this.service.taskWorkspaceRedactionPaths(taskId));
      }
      return prepareExclusions([...new Set(values.filter(Boolean))]);
    } catch {
      return undefined;
    }
  }
  private safe(
    value: unknown,
    excluded: readonly string[] | undefined,
    limit = 16000,
  ): string | null {
    if (value === null || value === undefined) return null;
    const prose = String(value);
    if (prose.length > limit) return null;
    const sanitized = excluded
      ? sanitizeConversationText(prose, excluded)
      : null;
    return sanitized && sanitized.length > limit ? null : (sanitized ?? null);
  }
  private disclosable(
    value: unknown,
    excluded: readonly string[] | undefined,
    limit = 16000,
  ): boolean {
    return this.safe(value, excluded, limit) === value;
  }
  private exact(
    value: unknown,
    excluded: readonly string[] | undefined,
    limit = 16000,
  ) {
    const safe = this.safe(value, excluded, limit);
    return safe === String(value) ? safe : null;
  }
  async retainedEvidencePolicy(taskId: string) {
    const visibility = this.visibilityToken();
    const task = this.requireTask(taskId);
    const projectId = String(task.projectId);
    const workspaceVisibility = this.service.taskWorkspaceVisibility(taskId);
    const excluded = await this.exclusions(projectId, taskId);
    if (!excluded) return undefined;
    const repositories = this.domain()
      .githubConfiguration(projectId)
      .repositories.map((repository) => repository.repositoryId)
      .sort();
    const current = this.requireTask(taskId);
    if (
      current.projectId !== task.projectId ||
      current.version !== task.version ||
      visibility !== this.visibilityToken() ||
      workspaceVisibility !== this.service.taskWorkspaceVisibility(taskId)
    )
      return undefined;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          taskId,
          projectId,
          taskVersion: task.version,
          visibility,
          workspaceVisibility,
          repositories,
          excluded,
          controlPaths: this.controlPaths,
        }),
      )
      .digest("hex");
    return {
      taskId,
      projectId,
      taskVersion: Number(task.version),
      visibility,
      workspaceVisibility,
      excluded,
      controlPaths: [...this.controlPaths],
      authorizedRepositoryIds: repositories,
      fingerprint,
      accessFingerprint: createHash("sha256")
        .update(
          JSON.stringify({
            taskId,
            projectId,
            workspaceVisibility,
            repositories,
            excluded,
            controlPaths: this.controlPaths,
          }),
        )
        .digest("hex"),
    };
  }
  private sameRetainedPolicy(
    current: RetainedReadPolicy | undefined,
    initial: RetainedReadPolicy,
  ) {
    return Boolean(
      current &&
        current.taskId === initial.taskId &&
        current.projectId === initial.projectId &&
        current.taskVersion === initial.taskVersion &&
        current.fingerprint === initial.fingerprint,
    );
  }
  private async retainedPathUnavailable(
    policy: RetainedReadPolicy,
    originRoot: string,
    repositoryId: string | null,
    path: string,
  ): Promise<"excluded" | "unavailable" | undefined> {
    const segments = relativePolicySegments(path);
    if (!segments || !isAbsolute(originRoot)) return "unavailable";
    if (
      (repositoryId !== null &&
        !policy.authorizedRepositoryIds.includes(repositoryId)) ||
      !isDisclosable(path, policy.excluded)
    )
      return "excluded";
    if (await retainedPathExcluded(originRoot, segments, policy.controlPaths))
      return "excluded";
    return undefined;
  }
  private async retainedItemUnavailable(
    item: {
      kind: "file" | "diff";
      repositoryId: string | null;
      path: string | null;
      mime?: string;
    },
    bytes: Buffer,
    originRoot: string,
    policy: RetainedReadPolicy,
  ): Promise<"excluded" | "unavailable" | undefined> {
    if (!item.path) return "unavailable";
    const sourcePath = await this.retainedPathUnavailable(
      policy,
      originRoot,
      item.repositoryId,
      item.path,
    );
    if (sourcePath) return sourcePath;
    if (item.kind === "file") {
      if (
        (item.mime?.startsWith("text/") ||
          item.mime === "application/json; charset=utf-8" ||
          item.mime === "application/sql; charset=utf-8") &&
        !isDisclosable(bytes.toString("utf8"), policy.excluded)
      )
        return "excluded";
      return undefined;
    }
    const diff = parseRetainedDiff(bytes);
    if (
      !diff ||
      diff.path !== item.path ||
      diff.repositoryId !== item.repositoryId
    )
      return "unavailable";
    for (const path of [
      diff.path,
      ...(diff.previousPath ? [diff.previousPath] : []),
    ]) {
      const unavailable = await this.retainedPathUnavailable(
        policy,
        originRoot,
        diff.repositoryId,
        path,
      );
      if (unavailable) return unavailable;
    }
    const sourceText = bytes.toString("utf8");
    if (!isDisclosable(sourceText, policy.excluded)) return "excluded";
    for (const side of [diff.left, diff.right])
      if (side.state === "text" && !isDisclosable(side.text, policy.excluded))
        return "excluded";
    return undefined;
  }
  private async workspaceInspectionCurrent(
    taskId: string,
  ): Promise<WorkspaceInspectionCurrent> {
    this.requireTask(taskId);
    const binding = await this.service.taskWorkspace(taskId, {
      reuseRecentIdentity: true,
    });
    const task = this.requireTask(taskId);
    return {
      taskId,
      taskVersion: Number(task.version),
      visibility: JSON.stringify({
        operator: this.visibilityToken(),
        workspace: this.service.taskWorkspaceVisibility(taskId),
      }),
      ...(binding ? { binding } : {}),
      controlPaths: [...this.controlPaths],
    };
  }
  private workspaceInspectionFailure(error: unknown): never {
    if (error instanceof OperatorApiError) throw error;
    if (error instanceof WorkspaceInspectionInputError)
      throw new OperatorApiError(400, "invalid-input");
    throw new OperatorApiError(503, "unavailable");
  }
  async readWorkspaceDirectory(
    taskId: string,
    request: Omit<WorkspaceInspectionRequest, "taskId">,
  ) {
    this.requireTask(taskId);
    try {
      const result = await listWorkspaceDirectory({ ...request, taskId }, () =>
        this.workspaceInspectionCurrent(taskId),
      );
      const { observedAt, ...data } = result;
      return workspaceDirectoryReadSchema.parse({ data, observedAt });
    } catch (error) {
      return this.workspaceInspectionFailure(error);
    }
  }
  async readWorkspacePreview(
    taskId: string,
    request: Omit<WorkspaceInspectionRequest, "taskId">,
  ) {
    this.requireTask(taskId);
    try {
      const result = await previewWorkspaceFile({ ...request, taskId }, () =>
        this.workspaceInspectionCurrent(taskId),
      );
      const { observedAt, ...data } = result;
      return workspacePreviewReadSchema.parse({ data, observedAt });
    } catch (error) {
      return this.workspaceInspectionFailure(error);
    }
  }
  async readRetainedResultEvidence(taskId: string, resultId: string) {
    uuid.parse(resultId);
    const task = this.requireTask(taskId);
    const policy = await this.retainedEvidencePolicy(taskId);
    const unavailable = (reason: "not-retained" | "excluded" | "unavailable") =>
      retainedResultEvidenceReadSchema.parse({
        data: { taskId, resultId, state: "unavailable", reason },
        observedAt: Date.now(),
      });
    if (
      !policy ||
      policy.projectId !== task.projectId ||
      policy.taskVersion !== Number(task.version)
    )
      return unavailable("unavailable");
    const store = this.service.retainedEvidence();
    const manifest = store.result(taskId, resultId);
    if (!manifest) {
      let exists = false;
      try {
        exists =
          this.service.taskReview().result(taskId, resultId) !== undefined;
      } catch {
        exists = false;
      }
      if (!exists) throw new OperatorApiError(404, "not-found");
      const latest = await this.retainedEvidencePolicy(taskId);
      return this.sameRetainedPolicy(latest, policy)
        ? unavailable("not-retained")
        : unavailable("unavailable");
    }
    const items = [];
    let hidden = false;
    for (const item of manifest.items) {
      if (item.state === "gap") {
        items.push({
          itemId: item.itemId,
          kind: item.kind,
          state: "gap" as const,
          reason: item.reason ?? "unavailable",
        });
        continue;
      }
      const content = store.item(taskId, resultId, item.itemId);
      const pathReason = content
        ? await this.retainedItemUnavailable(
            item,
            content.bytes,
            content.originRoot,
            policy,
          )
        : "unavailable";
      const preview = content
        ? previewRetainedBytes(content.bytes, item.mime ?? "")
        : undefined;
      if (
        pathReason ||
        !content ||
        !preview ||
        preview.sha256 !== item.sha256 ||
        preview.size !== item.size
      ) {
        hidden = true;
        items.push({
          itemId: item.itemId,
          kind: item.kind,
          state: "unavailable" as const,
          reason: pathReason ?? "unavailable",
        });
      } else {
        items.push({ ...item, state: "available" as const });
      }
    }
    const latest = await this.retainedEvidencePolicy(taskId);
    if (!this.sameRetainedPolicy(latest, policy))
      return unavailable("unavailable");
    try {
      return retainedResultEvidenceReadSchema.parse({
        data: {
          taskId,
          resultId,
          state: hidden ? "partial" : manifest.state,
          evidenceId: manifest.evidenceId,
          identity: {
            taskVersion: manifest.taskVersion,
            captureTaskVersion: manifest.captureTaskVersion,
            assignmentId: manifest.assignmentId,
            assignmentVersion: manifest.assignmentVersion,
            workId: manifest.workId,
            workRevision: manifest.workRevision,
            requestSequence: manifest.requestSequence,
            conversationRevision: manifest.conversationRevision,
            instructionsRevision: manifest.instructionsRevision,
            profileRevision: manifest.profileRevision,
            profileId: manifest.profileId,
            threadId: manifest.threadId,
            turnId: manifest.turnId,
          },
          capturedAt: manifest.capturedAt,
          sourceObservation: manifest.sourceObservation,
          items,
        },
        observedAt: Date.now(),
      });
    } catch {
      throw new OperatorApiError(503, "unavailable");
    }
  }
  async readRetainedEvidenceItem(
    taskId: string,
    resultId: string,
    itemId: string,
  ) {
    uuid.parse(resultId);
    uuid.parse(itemId);
    const task = this.requireTask(taskId);
    const policy = await this.retainedEvidencePolicy(taskId);
    const unavailable = (reason: "excluded" | "unavailable") =>
      retainedEvidenceItemContentReadSchema.parse({
        data: { taskId, resultId, itemId, state: "unavailable", reason },
        observedAt: Date.now(),
      });
    if (
      !policy ||
      policy.projectId !== task.projectId ||
      policy.taskVersion !== Number(task.version)
    )
      return unavailable("unavailable");
    const store = this.service.retainedEvidence();
    const manifest = store.result(taskId, resultId);
    if (!manifest) {
      try {
        if (!this.service.taskReview().result(taskId, resultId))
          throw new OperatorApiError(404, "not-found");
      } catch (error) {
        if (error instanceof OperatorApiError) throw error;
        throw new OperatorApiError(404, "not-found");
      }
      // Re-read for its task-existence check; the answer is the same either way.
      await this.retainedEvidencePolicy(taskId);
      return unavailable("unavailable");
    }
    const item = manifest.items.find(
      (candidate) => candidate.itemId === itemId,
    );
    if (!item) throw new OperatorApiError(404, "not-found");
    if (item.state === "gap") {
      const latest = await this.retainedEvidencePolicy(taskId);
      if (!this.sameRetainedPolicy(latest, policy))
        return unavailable("unavailable");
      return retainedEvidenceItemContentReadSchema.parse({
        data: {
          taskId,
          resultId,
          itemId,
          state: "gap",
          reason: item.reason ?? "unavailable",
        },
        observedAt: Date.now(),
      });
    }
    const content = store.item(taskId, resultId, itemId);
    if (!content) return unavailable("unavailable");
    const reason = await this.retainedItemUnavailable(
      item,
      content.bytes,
      content.originRoot,
      policy,
    );
    if (reason) return unavailable(reason);
    const preview = previewRetainedBytes(content.bytes, item.mime ?? "");
    if (
      !preview ||
      preview.sha256 !== item.sha256 ||
      preview.size !== item.size
    )
      return unavailable("unavailable");
    const latest = await this.retainedEvidencePolicy(taskId);
    if (!this.sameRetainedPolicy(latest, policy))
      return unavailable("unavailable");
    return retainedEvidenceItemContentReadSchema.parse({
      data: {
        taskId,
        resultId,
        itemId,
        state: "available",
        item: { ...item, state: "available" },
        preview,
      },
      observedAt: Date.now(),
    });
  }
  private async retainedAnchorOriginRoot(
    taskId: string,
    repositoryId: string | null,
    retainedRoot?: string,
  ) {
    if (retainedRoot) return retainedRoot;
    const binding = await this.service.taskWorkspace(taskId);
    if (!binding) return undefined;
    if (!repositoryId) return binding.path;
    return binding.repositories.find(
      (repository) => repository.repositoryId === repositoryId,
    )?.workspacePath;
  }
  private async retainedAnchorStatus(
    anchor: NonNullable<
      ReturnType<
        ReturnType<StandaloneService["retainedEvidence"]>["reviewAnchor"]
      >
    >["anchor"],
    bytes: Buffer,
    policy: RetainedReadPolicy,
    originRoot: string,
  ): Promise<"current" | "outdated" | "unknown" | "excluded" | "unavailable"> {
    if (anchor.sourceKind === "workspace-file") {
      const current = await this.workspaceInspectionCurrent(anchor.taskId);
      if (
        current.binding?.state !== "ready" ||
        current.taskVersion !== policy.taskVersion
      )
        return "unknown";
      const path = relativePolicySegments(anchor.path);
      if (!path) return "unknown";
      const scope = anchor.repositoryId
        ? { kind: "repository" as const, repositoryId: anchor.repositoryId }
        : { kind: "workspace" as const };
      const preview = await previewWorkspaceFile(
        { taskId: anchor.taskId, scope, path, showIgnored: true },
        () => this.workspaceInspectionCurrent(anchor.taskId),
      );
      let latestWorkspace: WorkspaceInspectionCurrent | undefined;
      let latestPolicy: RetainedReadPolicy | undefined;
      try {
        [latestWorkspace, latestPolicy] = await Promise.all([
          this.workspaceInspectionCurrent(anchor.taskId),
          this.retainedEvidencePolicy(anchor.taskId),
        ]);
      } catch {
        return "unknown";
      }
      if (
        latestWorkspace.binding?.state !== "ready" ||
        latestWorkspace.taskVersion !== current.taskVersion ||
        workspaceInspectionBindingIdentity(latestWorkspace) !==
          workspaceInspectionBindingIdentity(current) ||
        !this.sameRetainedPolicy(latestPolicy, policy)
      )
        return "unknown";
      if (preview.state === "missing") return "outdated";
      if (preview.state !== "ready" || preview.preview?.kind !== "text")
        return "unknown";
      const currentBytes = Buffer.from(preview.preview.text, "utf8");
      if (
        currentBytes.byteLength !== preview.preview.size ||
        createHash("sha256").update(currentBytes).digest("hex") !==
          preview.preview.sha256
      )
        return "unknown";
      if (preview.preview.sha256 !== anchor.sourceSha256) return "outdated";
      return exactRetainedAnchorExcerpt(anchor, currentBytes, bytes)
        ? "current"
        : "unavailable";
    }
    if (anchor.sourceKind === "result-evidence") {
      if (!anchor.resultId || !anchor.resultItemId) return "unknown";
      const store = this.service.retainedEvidence();
      const manifest = store.result(anchor.taskId, anchor.resultId);
      const item = manifest?.items.find(
        (candidate) => candidate.itemId === anchor.resultItemId,
      );
      const content = store.item(
        anchor.taskId,
        anchor.resultId,
        anchor.resultItemId,
      );
      if (
        !manifest ||
        !item ||
        !content ||
        manifest.taskId !== anchor.taskId ||
        manifest.workId !== anchor.workId ||
        item.state !== "available" ||
        item.kind !== "file" ||
        item.path !== anchor.path ||
        item.repositoryId !== anchor.repositoryId ||
        item.sha256 !== anchor.sourceSha256 ||
        createHash("sha256").update(content.bytes).digest("hex") !==
          anchor.sourceSha256
      )
        return "unknown";
      return exactRetainedAnchorExcerpt(anchor, content.bytes, bytes)
        ? "current"
        : "unavailable";
    }

    if (!anchor.comparisonId || anchor.side === "file") return "unknown";
    const exported = this.service.workspaceComparisonExport(
      anchor.taskId,
      anchor.comparisonId,
    );
    if (!exported) return "unknown";
    const comparison = exported.comparison;
    if (
      comparison.taskId !== anchor.taskId ||
      comparison.comparisonId !== anchor.comparisonId ||
      comparison.target !== anchor.context
    )
      return "unknown";
    if (anchor.context === "turn") {
      if (
        exported.captureState !== "finished" ||
        comparison.target !== "turn" ||
        comparison.state !== "available" ||
        comparison.outcome !== "completed" ||
        comparison.workId !== anchor.workId ||
        comparison.threadId !== anchor.threadId ||
        comparison.turnId !== anchor.turnId
      )
        return "unknown";
    } else if (comparison.state !== "available") {
      return "unknown";
    }
    const matches = comparison.entries.filter((entry) => {
      const selectedPath =
        anchor.side === "left"
          ? (entry.previousPath ?? entry.path)
          : entry.path;
      const repositoryId =
        comparison.target === "turn"
          ? (entry.repositoryId ?? null)
          : comparison.repositoryId;
      return (
        selectedPath === anchor.path && repositoryId === anchor.repositoryId
      );
    });
    if (matches.length !== 1) return "unknown";
    const entry = matches[0];
    if (entry?.state !== "text") return "unknown";
    for (const path of [
      entry.path,
      ...(entry.previousPath ? [entry.previousPath] : []),
    ]) {
      const reason = await this.retainedPathUnavailable(
        policy,
        originRoot,
        anchor.repositoryId,
        path,
      );
      if (reason === "excluded") return "excluded";
      if (reason) return "unknown";
    }
    const selectedSide = anchor.side === "left" ? "left" : "right";
    const content = entry[selectedSide];
    const exportedSide = exported.sides.find(
      (side) => side.entryIndex === comparison.entries.indexOf(entry),
    );
    const sideText =
      selectedSide === "left"
        ? exportedSide?.leftText
        : exportedSide?.rightText;
    if (
      !content?.sha256 ||
      sideText === undefined ||
      content.size !== Buffer.byteLength(sideText, "utf8") ||
      content.lineCount !== retainedTextLineCount(sideText) ||
      createHash("sha256")
        .update(Buffer.from(sideText, "utf8"))
        .digest("hex") !== content.sha256
    )
      return "unknown";
    if (content.sha256 !== anchor.sourceSha256) return "outdated";
    return exactRetainedAnchorExcerpt(
      anchor,
      Buffer.from(sideText, "utf8"),
      bytes,
    )
      ? "current"
      : "unavailable";
  }
  async readRetainedReviewAnchor(taskId: string, anchorId: string) {
    uuid.parse(anchorId);
    const task = this.requireTask(taskId);
    const policy = await this.retainedEvidencePolicy(taskId);
    const unavailable = (reason: "excluded" | "unavailable") =>
      retainedReviewAnchorReadSchema.parse({
        data: { taskId, anchorId, state: "unavailable", reason },
        observedAt: Date.now(),
      });
    if (
      !policy ||
      policy.projectId !== task.projectId ||
      policy.taskVersion !== Number(task.version)
    )
      return unavailable("unavailable");
    const retained = this.service
      .retainedEvidence()
      .reviewAnchor(taskId, anchorId);
    if (!retained) throw new OperatorApiError(404, "not-found");
    const { anchor, bytes } = retained;
    const originRoot = await this.retainedAnchorOriginRoot(
      taskId,
      anchor.repositoryId,
      retained.originRoot,
    );
    if (!originRoot) return unavailable("unavailable");
    const latestPath = await this.retainedPathUnavailable(
      policy,
      originRoot,
      anchor.repositoryId,
      anchor.path,
    );
    if (latestPath) return unavailable(latestPath);
    if (anchor.state === "gap" || !bytes) {
      const latest = await this.retainedEvidencePolicy(taskId);
      if (!this.sameRetainedPolicy(latest, policy))
        return unavailable("unavailable");
      try {
        return retainedReviewAnchorReadSchema.parse({
          data: {
            taskId,
            anchorId,
            state: "gap",
            status: "unavailable",
            anchor,
          },
          observedAt: Date.now(),
        });
      } catch {
        throw new OperatorApiError(503, "unavailable");
      }
    }
    const contentReason = await this.retainedItemUnavailable(
      {
        kind: "file",
        repositoryId: anchor.repositoryId,
        path: anchor.path,
        ...(anchor.mime ? { mime: anchor.mime } : {}),
      },
      bytes,
      originRoot,
      policy,
    );
    if (contentReason) return unavailable(contentReason);
    if (
      bytes.byteLength !== anchor.size ||
      createHash("sha256").update(bytes).digest("hex") !== anchor.excerptSha256
    )
      return unavailable("unavailable");
    const preview = previewRetainedBytes(bytes, anchor.mime ?? "");
    if (!preview) return unavailable("unavailable");
    const status = await this.retainedAnchorStatus(
      anchor,
      bytes,
      policy,
      originRoot,
    );
    if (status === "excluded") return unavailable("excluded");
    if (status === "unavailable") return unavailable("unavailable");
    const latest = await this.retainedEvidencePolicy(taskId);
    if (!this.sameRetainedPolicy(latest, policy))
      return unavailable("unavailable");
    try {
      return retainedReviewAnchorReadSchema.parse({
        data: {
          taskId,
          anchorId,
          state: "available",
          status,
          anchor,
          preview,
        },
        observedAt: Date.now(),
      });
    } catch {
      throw new OperatorApiError(503, "unavailable");
    }
  }
  private comparisonRead(
    data: z.input<typeof workspaceComparisonReadSchema>["data"],
  ) {
    try {
      return workspaceComparisonReadSchema.parse({
        data,
        observedAt: Date.now(),
      });
    } catch {
      throw new OperatorApiError(503, "unavailable");
    }
  }
  private comparisonResponse(
    taskId: string,
    target: "branch" | "uncommitted" | "last-turn",
    comparison:
      | WorkspaceComparisonSnapshot
      | NonNullable<WorkspaceTurnCaptureRecord["comparison"]>,
  ) {
    if (comparison.state === "available")
      return this.comparisonRead({
        taskId,
        target,
        state: "available",
        comparisonId: comparison.comparisonId,
        comparison,
      });
    if (comparison.state === "gap")
      return this.comparisonRead({
        taskId,
        target,
        state: "gap",
        comparisonId: comparison.comparisonId,
        comparison,
        ...(comparison.reason ? { reason: comparison.reason } : {}),
      });
    return this.comparisonRead({
      taskId,
      target,
      state: "unavailable",
      comparisonId: comparison.comparisonId,
      comparison,
      reason: comparison.reason ?? "comparison-unavailable",
      ...(comparison.target === "branch"
        ? { availableBaseBranches: comparison.availableBaseBranches }
        : {}),
    });
  }
  private pendingTurnProjection(
    capture: WorkspaceTurnCaptureRecord,
    includeComparison = true,
  ) {
    const {
      before,
      after,
      sides: _sides,
      comparison,
      ...identityAndState
    } = capture;
    return {
      ...identityAndState,
      ...(includeComparison && comparison ? { comparison } : {}),
      captureState:
        capture.captureState === "finished"
          ? "unsettled"
          : capture.captureState,
      ...(before
        ? { beforeState: before.state, beforeObservedAt: before.observedAt }
        : {}),
      ...(after
        ? { afterState: after.state, afterObservedAt: after.observedAt }
        : {}),
    };
  }
  private async storedComparisonVisible(
    initial: WorkspaceInspectionCurrent,
    comparison:
      | WorkspaceComparisonSnapshot
      | NonNullable<WorkspaceTurnCaptureRecord["comparison"]>,
  ) {
    if (comparison.taskId !== initial.taskId) return false;
    const repositoryTarget =
      comparison.target === "turn" ? undefined : comparison.repositoryId;
    const references: WorkspaceInspectionPathReference[] = [];
    for (const entry of comparison.entries) {
      let repositoryId = entry.repositoryId;
      if (repositoryId === undefined && repositoryTarget !== undefined)
        repositoryId = repositoryTarget;
      if (repositoryId === undefined) {
        const anchorRepositoryIds = new Set(
          entry.hunks.flatMap((hunk) =>
            [hunk.leftAnchor, hunk.rightAnchor]
              .filter((anchor) => anchor !== undefined)
              .map((anchor) => anchor.repositoryId),
          ),
        );
        if (anchorRepositoryIds.size !== 1) return false;
        const inferredRepositoryId = anchorRepositoryIds.values().next()
          .value as string | null | undefined;
        if (inferredRepositoryId === undefined) return false;
        repositoryId = inferredRepositoryId;
      }
      if (repositoryTarget !== undefined && repositoryId !== repositoryTarget)
        return false;
      const scope =
        repositoryId === null
          ? ({ kind: "workspace" } as const)
          : ({ kind: "repository", repositoryId } as const);
      const paths = new Set<string>([
        entry.path,
        ...(entry.previousPath ? [entry.previousPath] : []),
        ...entry.hunks.flatMap((hunk) =>
          [hunk.leftAnchor, hunk.rightAnchor]
            .filter((anchor) => anchor !== undefined)
            .map((anchor) => {
              if (anchor.repositoryId !== repositoryId) return "";
              return anchor.path;
            }),
        ),
      ]);
      if (paths.has("")) return false;
      for (const path of paths)
        references.push({ scope, path: path.split("/") });
    }
    return !(await workspaceInspectionPathsExcluded(
      initial.taskId,
      references,
      initial,
      () => this.workspaceInspectionCurrent(initial.taskId),
    ));
  }
  async readWorkspaceComparison(taskId: string, untrustedRequest: unknown) {
    const request =
      workspaceComparisonReadRequestSchema.parse(untrustedRequest);
    this.requireTask(taskId);
    const initial = await this.workspaceInspectionCurrent(taskId);
    const taskVersion = initial.taskVersion;
    const visibility = initial.visibility;
    const stillVisible = async () => {
      const current = await this.workspaceInspectionCurrent(taskId);
      return (
        current.taskVersion === taskVersion && current.visibility === visibility
      );
    };
    const unavailable = (
      target: "branch" | "uncommitted" | "last-turn",
      reason: string,
      comparisonId?: string,
      availableBaseBranches?: readonly string[],
    ) =>
      this.comparisonRead({
        taskId,
        target,
        state: "unavailable",
        reason,
        ...(comparisonId ? { comparisonId } : {}),
        ...(availableBaseBranches
          ? { availableBaseBranches: [...availableBaseBranches] }
          : {}),
      });

    if ("comparisonId" in request) {
      const target = request.target;
      if (target === "last-turn") {
        const slots = this.service.workspaceTurnCaptureSlots(taskId);
        if (slots.pending?.comparisonId === request.comparisonId) {
          if (!(await stillVisible()))
            throw new OperatorApiError(503, "unavailable");
          const includePendingComparison =
            !slots.pending.comparison ||
            (await this.storedComparisonVisible(
              initial,
              slots.pending.comparison,
            ));
          const includeLatestFinished =
            !slots.latestFinished?.comparison ||
            (await this.storedComparisonVisible(
              initial,
              slots.latestFinished.comparison,
            ));
          const latestSlots = this.service.workspaceTurnCaptureSlots(taskId);
          if (latestSlots.pending?.comparisonId !== request.comparisonId)
            return unavailable(
              target,
              "comparison-stale",
              request.comparisonId,
            );
          const includeLatestStillCurrent =
            slots.latestFinished?.comparisonId ===
            latestSlots.latestFinished?.comparisonId;
          const includeStoredComparisons =
            includePendingComparison && includeLatestFinished;
          return this.comparisonRead({
            taskId,
            target,
            state: "unsettled",
            pending: this.pendingTurnProjection(
              slots.pending,
              includeStoredComparisons,
            ),
            ...(slots.latestFinished?.comparison &&
            includeStoredComparisons &&
            includeLatestStillCurrent
              ? { latestFinished: slots.latestFinished.comparison }
              : {}),
          });
        }
        const finished = slots.latestFinished;
        if (
          finished?.comparisonId === request.comparisonId &&
          finished.comparison
        ) {
          if (!(await stillVisible()))
            throw new OperatorApiError(503, "unavailable");
          if (
            !(await this.storedComparisonVisible(initial, finished.comparison))
          )
            return unavailable(
              target,
              "comparison-unavailable",
              request.comparisonId,
            );
          if (
            this.service.workspaceTurnCaptureSlots(taskId).latestFinished
              ?.comparisonId !== request.comparisonId
          )
            return unavailable(
              target,
              "comparison-stale",
              request.comparisonId,
            );
          return this.comparisonResponse(taskId, target, finished.comparison);
        }
        if (!(await stillVisible()))
          throw new OperatorApiError(503, "unavailable");
        return unavailable(
          target,
          "comparison-unavailable",
          request.comparisonId,
        );
      }
      const exported = this.service.workspaceComparisonById(
        taskId,
        request.comparisonId,
      );
      const comparison = exported?.comparison;
      if (
        !comparison ||
        comparison.target !== target ||
        !initial.binding?.repositories.some(
          (repository) => repository.repositoryId === comparison.repositoryId,
        )
      ) {
        if (!(await stillVisible()))
          throw new OperatorApiError(503, "unavailable");
        return unavailable(
          target,
          "comparison-unavailable",
          request.comparisonId,
        );
      }
      if (!(await stillVisible()))
        throw new OperatorApiError(503, "unavailable");
      if (!(await this.storedComparisonVisible(initial, comparison)))
        return unavailable(
          target,
          "comparison-unavailable",
          request.comparisonId,
        );
      const stillCurrent = this.service.workspaceComparisonById(
        taskId,
        request.comparisonId,
      );
      if (
        !stillCurrent ||
        stillCurrent.comparison.comparisonId !== comparison.comparisonId ||
        stillCurrent.comparison.target !== target
      )
        return unavailable(target, "comparison-stale", request.comparisonId);
      return this.comparisonResponse(taskId, target, comparison);
    }

    if (request.target === "last-turn") {
      const slots = this.service.workspaceTurnCaptureSlots(taskId);
      if (slots.pending) {
        if (!(await stillVisible()))
          throw new OperatorApiError(503, "unavailable");
        const includePendingComparison =
          !slots.pending.comparison ||
          (await this.storedComparisonVisible(
            initial,
            slots.pending.comparison,
          ));
        const includeLatestFinished =
          !slots.latestFinished?.comparison ||
          (await this.storedComparisonVisible(
            initial,
            slots.latestFinished.comparison,
          ));
        const latestSlots = this.service.workspaceTurnCaptureSlots(taskId);
        if (latestSlots.pending?.comparisonId !== slots.pending.comparisonId)
          return unavailable("last-turn", "capture-unavailable");
        const includeLatestStillCurrent =
          slots.latestFinished?.comparisonId ===
          latestSlots.latestFinished?.comparisonId;
        const includeStoredComparisons =
          includePendingComparison && includeLatestFinished;
        return this.comparisonRead({
          taskId,
          target: "last-turn",
          state: "unsettled",
          pending: this.pendingTurnProjection(
            slots.pending,
            includeStoredComparisons,
          ),
          ...(slots.latestFinished?.comparison &&
          includeStoredComparisons &&
          includeLatestStillCurrent
            ? { latestFinished: slots.latestFinished.comparison }
            : {}),
        });
      }
      if (slots.latestFinished?.comparison) {
        if (!(await stillVisible()))
          throw new OperatorApiError(503, "unavailable");
        if (
          !(await this.storedComparisonVisible(
            initial,
            slots.latestFinished.comparison,
          ))
        )
          return unavailable(
            "last-turn",
            "capture-unavailable",
            slots.latestFinished.comparisonId,
          );
        if (
          this.service.workspaceTurnCaptureSlots(taskId).latestFinished
            ?.comparisonId !== slots.latestFinished.comparisonId
        )
          return unavailable("last-turn", "capture-unavailable");
        return this.comparisonResponse(
          taskId,
          "last-turn",
          slots.latestFinished.comparison,
        );
      }
      if (!(await stillVisible()))
        throw new OperatorApiError(503, "unavailable");
      return unavailable("last-turn", "capture-unavailable");
    }

    const current = initial.binding;
    if (
      current?.state !== "ready" ||
      !current.repositories.some(
        (repository) => repository.repositoryId === request.repositoryId,
      )
    ) {
      return unavailable(request.target, "repository-unavailable");
    }
    const existing = this.service.currentWorkspaceComparison(
      taskId,
      request.repositoryId,
      request.target,
    );
    const snapshot = existing?.comparison;
    // The binding's configured ref is only a default; compareRepository applies
    // it solely when it names a listed local branch.
    const configuredRef =
      request.target === "branch" && request.baseBranch === undefined
        ? current.repositories
            .find(
              (repository) => repository.repositoryId === request.repositoryId,
            )
            ?.ref.replace(/^refs\/heads\//, "")
        : undefined;
    const defaultListed =
      !!configuredRef &&
      !!snapshot &&
      "availableBaseBranches" in snapshot &&
      snapshot.availableBaseBranches.includes(configuredRef);
    // Rows stored before `baseBranch` existed carry the branch only in the baseline.
    const attemptedBranch =
      snapshot?.target === "branch"
        ? (snapshot.baseBranch ?? snapshot.baseline?.branch)
        : undefined;
    // A read that failed before any branch was listed records no selection, so
    // it answers the default read like any other stored outcome.
    const failedBeforeListing =
      snapshot?.target === "branch" &&
      attemptedBranch === undefined &&
      snapshot.availableBaseBranches.length === 0 &&
      snapshot.reason !== "base-branch-unavailable";
    const selectionMatches = snapshot
      ? request.target === "branch"
        ? snapshot.target === "branch" &&
          (request.baseBranch === undefined
            ? (!!configuredRef && attemptedBranch === configuredRef) ||
              (snapshot.reason === "base-branch-required" && !defaultListed) ||
              failedBeforeListing
            : attemptedBranch === request.baseBranch)
        : snapshot.target === "uncommitted" &&
          snapshot.changeSet === (request.changeSet ?? "all")
      : false;
    if (snapshot && !request.refresh && selectionMatches) {
      if (!(await this.storedComparisonVisible(initial, snapshot)))
        return unavailable(
          request.target,
          "comparison-unavailable",
          snapshot.comparisonId,
        );
      const stillCurrent = this.service.currentWorkspaceComparison(
        taskId,
        request.repositoryId,
        request.target,
      );
      if (stillCurrent?.comparison.comparisonId !== snapshot.comparisonId)
        return unavailable(
          request.target,
          "comparison-stale",
          snapshot.comparisonId,
        );
      return this.comparisonResponse(taskId, request.target, snapshot);
    }
    if (
      request.target === "branch" &&
      request.baseBranch === undefined &&
      !defaultListed &&
      snapshot &&
      (snapshot.target !== "branch" ||
        snapshot.reason !== "base-branch-required") &&
      !request.refresh
    ) {
      return unavailable(
        "branch",
        "base-branch-required",
        undefined,
        snapshot && "availableBaseBranches" in snapshot
          ? snapshot.availableBaseBranches
          : [],
      );
    }

    const sideContent = new Map<number, WorkspaceComparisonSideContent>();
    const comparison = await compareRepository(
      {
        taskId,
        repositoryId: request.repositoryId,
        target: request.target,
        ...(request.target === "branch" && request.baseBranch
          ? { baseBranch: request.baseBranch }
          : {}),
        ...(configuredRef ? { defaultBaseBranch: configuredRef } : {}),
        ...(request.target === "uncommitted" && request.changeSet
          ? { changeSet: request.changeSet }
          : {}),
      },
      () => this.workspaceInspectionCurrent(taskId),
      {
        captureSideContent: (entryIndex, side, text) => {
          const value = sideContent.get(entryIndex) ?? { entryIndex };
          if (side === "left") value.leftText = text;
          else value.rightText = text;
          sideContent.set(entryIndex, value);
        },
      },
    );
    if (!(await stillVisible())) throw new OperatorApiError(503, "unavailable");
    if (!(await this.storedComparisonVisible(initial, comparison)))
      return unavailable(
        request.target,
        "comparison-unavailable",
        comparison.comparisonId,
      );
    this.service.replaceWorkspaceComparison(
      comparison,
      [...sideContent.values()].sort(
        (left, right) => left.entryIndex - right.entryIndex,
      ),
    );
    return this.comparisonResponse(taskId, request.target, comparison);
  }
  private project(row: Row, excluded: readonly string[] | undefined) {
    return {
      id: String(row.id),
      name: this.safe(row.name, excluded),
      version: Number(row.version),
      paused: Boolean(row.paused),
      leadProfileId:
        row.leadProfileId === null ? null : String(row.leadProfileId),
    };
  }
  private profiles(excluded: readonly string[] | undefined) {
    return this.domain()
      .profiles()
      .map((p) => ({
        id: String(p.id),
        name: this.safe(p.name, excluded),
        summary: this.safe(p.summary, excluded),
        version: Number(p.version),
        revoked: Boolean(p.revoked),
      }));
  }
  async readWorkspace() {
    const excluded = await this.exclusions();
    return workspaceSchema.parse({
      data: {
        projects: this.domain()
          .projects()
          .map((p) => this.project(p, excluded)),
        profiles: this.profiles(excluded).map((p) => ({
          ...p,
          runtime: this.domain().profileRuntime(p.id),
        })),
        runtime: this.service.runtimeStatus(),
        harnesses: this.service.harnessStatuses(),
        gettingStarted: {
          turnStarted: this.service.taskTurnStarted(),
          dismissed: this.domain().gettingStartedDismissed(),
        },
      },
      observedAt: Date.now(),
    });
  }
  /** Only a held Claude execution's failure is reported; Codex presentation is unchanged. */
  private generation(
    request: {
      workId: string;
      assignmentVersion: number;
      sequence: number;
      instructionsRevision: number;
      profileRevision: number;
    },
    held: boolean,
  ) {
    const harness = this.service.bindingHarness(request.workId);
    return {
      workId: request.workId,
      assignmentVersion: request.assignmentVersion,
      requestSequence: request.sequence,
      instructionsRevision: request.instructionsRevision,
      profileRevision: request.profileRevision,
      harness,
      commandNetworkAccess: this.service.commandNetworkAccessFor(
        request.workId,
      ),
      failure:
        harness === "claude" && held
          ? this.service.terminalFailure(request.workId)
          : null,
    };
  }
  private selection(a: Row) {
    return selectAssignmentExecution(a, this.service);
  }
  private nonStopTaskHold(
    taskId: string,
    excluded: readonly string[] | undefined,
  ) {
    const reason = this.service.nonStopTaskHoldReason(taskId);
    return reason === undefined
      ? null
      : { reason: this.safe(reason, excluded) };
  }
  private execution(task: Row): Execution {
    const selections = this.domain()
      .assignments(String(task.id))
      .map((a) => this.selection(a));
    const holds = {
      stop:
        this.service.isTaskStopped(String(task.id)) ||
        selections.some((s) => s.record?.holds.stop),
      writer: selections.some((s) => s.record?.holds.writer),
      capacity: selections.some((s) => s.record?.holds.capacity),
      uncertainty: selections.some((s) => s.record?.holds.uncertainty),
      task:
        Boolean(this.service.taskHold(String(task.id))) ||
        selections.some((s) => s.record?.holds.task),
    };
    let state: Execution["state"] = "idle";
    const reasonCodes: Execution["reasonCodes"] = [];
    if (holds.stop) state = "stopping";
    else if (
      holds.uncertainty ||
      holds.task ||
      selections.some((s) => s.request?.state === "held") ||
      selections.some(
        (s) =>
          (s.record?.holds.writer || s.record?.holds.capacity) &&
          !(
            s.request?.state === "active" &&
            ["running", "submitting"].includes(s.intent?.state ?? "")
          ),
      )
    ) {
      state = "uncertain";
      reasonCodes.push(holds.task ? "task-held" : "recovery-held");
    } else if (
      selections.some(
        (s) => s.request?.state === "active" && s.intent?.state === "running",
      )
    )
      state = "running";
    else if (
      selections.some(
        (s) =>
          s.request?.state === "active" && s.intent?.state === "submitting",
      )
    )
      state = "starting";
    else if (selections.some((s) => s.request?.state === "active")) {
      state = "uncertain";
      reasonCodes.push("runtime-unconfirmed");
    } else if (task.state === "done") state = "completed";
    else if (task.state === "cancelled") state = "cancelled";
    else if (this.domain().project(String(task.projectId)).paused) {
      state = "paused";
      reasonCodes.push("project-paused");
    } else if (!this.domain().admission(String(task.id)).eligible) {
      state = "waiting";
      reasonCodes.push("admission-blocked");
    } else if (selections.some((s) => s.request?.state === "queued"))
      state = "queued";
    else if (
      this.domain()
        .assignments(String(task.id))
        .some((a) => a.state === "pending")
    )
      state = "selected";
    else {
      const view = this.coordination().readTask(String(task.id));
      if (
        [...view.questions, ...view.approvals].some((i) => i.status === "open")
      )
        state = "waiting";
    }
    return { state, reasonCodes, holds };
  }
  private identity(taskId: string) {
    const imported = this.domain().importedTask(taskId);
    return imported
      ? {
          provider: "github.com" as const,
          nodeId: String(imported.nodeId),
          repositoryId: String(imported.repositoryId),
        }
      : null;
  }
  /** Instruction revisions and linked repositories: the exclusion base inputs no other fence covers. */
  private exclusionFence() {
    const d = this.domain();
    return JSON.stringify({
      profiles: d.profiles().map((p) => [p.id, p.version]),
      projects: d
        .projects()
        .map((p) => [
          p.id,
          p.instructionsRevision,
          d.githubConfiguration(String(p.id)).version,
        ]),
    });
  }
  /** Rebuild projections once if their instruction or repository exclusions changed across an await. */
  private async readWithExclusionFence<T>(read: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const fence = this.exclusionFence();
      try {
        const response = await read();
        if (fence === this.exclusionFence()) return response;
      } catch (error) {
        // Nested reads can reject the same instruction or repository race before we reach the fence.
        if (
          !(error instanceof OperatorApiError) ||
          error.status !== 503 ||
          fence === this.exclusionFence()
        )
          throw error;
      }
    }
    throw new OperatorApiError(503, "unavailable");
  }
  private sourceFence(projectId?: string) {
    if (projectId !== undefined) this.requireProject(projectId);
    const d = this.domain();
    const ids =
      projectId === undefined
        ? d
            .projects()
            .map((p) => String(p.id))
            .sort()
        : [projectId];
    return JSON.stringify(
      ids.map((id) => {
        const configuration = d.githubConfiguration(id);
        return [
          id,
          configuration.version,
          configuration.credentialRef,
          d.githubActiveSelectionIds(id).sort(),
        ];
      }),
    );
  }
  /** Rebuild once when source identity or activation changes across a credential check. */
  private async readWithSourceFence<T>(
    read: () => Promise<T>,
    projectId?: string,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const source = this.sourceFence(projectId);
      const response = await read();
      if (source === this.sourceFence(projectId)) return response;
    }
    throw new OperatorApiError(503, "unavailable");
  }
  /** Workspace fences per task plus the credential reference fence, checked before a read returns. */
  private workspaceSnapshot(taskIds: readonly string[]) {
    return {
      // Instruction revisions are fenced by readWithExclusionFence.
      references: this.referenceFence(),
      workspaces: new Map(
        taskIds.map((id) => [id, this.service.taskWorkspaceVisibility(id)]),
      ),
    };
  }
  private requireWorkspaceSnapshot(
    snapshot: ReturnType<OperatorApi["workspaceSnapshot"]>,
  ) {
    if (snapshot.references !== this.referenceFence())
      throw new OperatorApiError(503, "unavailable");
    for (const [id, fingerprint] of snapshot.workspaces)
      if (this.service.taskWorkspaceVisibility(id) !== fingerprint)
        throw new OperatorApiError(503, "unavailable");
  }
  async readProject(projectId: string) {
    return this.readWithExclusionFence(() => this.readProjectOnce(projectId));
  }
  private async readProjectOnce(projectId: string) {
    const p = this.requireProject(projectId),
      rows = this.domain().tasks(projectId),
      snapshot = this.workspaceSnapshot(rows.map((t) => String(t.id))),
      base = this.exclusionBase(),
      excluded = await this.exclusions(projectId, undefined, [], [], base);
    const response = {
      data: {
        project: this.project(p, excluded),
        profiles: this.profiles(excluded),
        tasks: await Promise.all(
          rows.map(async (t) => ({
            id: String(t.id),
            projectId,
            title: this.safe(
              t.title,
              await this.exclusions(projectId, String(t.id), [], [], base),
            ),
            version: Number(t.version),
            state: t.state,
            ready: Boolean(t.ready),
            execution: this.execution(t),
            sourceIdentity: this.identity(String(t.id)),
          })),
        ),
      },
      observedAt: Date.now(),
    };
    this.requireWorkspaceSnapshot(snapshot);
    return projectSchema.parse(response);
  }
  private capacity(projectId: string) {
    const c = this.domain().capacityLimits([projectId]);
    return {
      globalUsage: c.currentUsage.global,
      globalLimit: c.globalLimit,
      projectUsage: c.currentUsage.projects[projectId] ?? 0,
      projectLimit:
        c.effectiveProjectLimits[projectId] ?? c.defaultProjectLimit,
    };
  }
  /**
   * The runtime facts of the profile that will execute, mirroring the ready check; none for
   * a missing or revoked profile. `revision` is an assignment's bound profile revision.
   */
  private profileWaitFacts(profileId: string | undefined, revision?: number) {
    if (!profileId) return undefined;
    const d = this.domain();
    let runtime: ReturnType<typeof d.profileRuntime>;
    try {
      if (d.profile(profileId).revoked) return undefined;
      runtime = d.profileRuntime(profileId, revision);
    } catch {
      return undefined;
    }
    const status = this.service
      .harnessStatuses()
      .find((h) => h.harness === runtime.harness);
    return {
      profileId,
      runtimeUnavailable: status?.state === "unavailable",
      runtimeNotConfigured:
        status?.state === "not-configured" ||
        (!!status?.settings &&
          unsupportedRuntimeField(runtime, status.settings) !== null),
      claudeTokenUnavailable:
        runtime.harness === "claude" &&
        this.service.claudeTokenStatus().state !== "available",
    };
  }
  /**
   * The assignments waiting to run: each whose current turn request is queued, each pending
   * assignment not yet requested, each `refused` for stale captured revisions, which holds
   * it until it is re-bound, and each held assignment whatever its last request. Only the
   * queued or unrequested (`runtime`) run next on their profile's runtime. Each
   * assignment's current request only, so the read stays bounded by assignments.
   */
  private nextAssignments(taskId: string) {
    return this.domain()
      .assignments(taskId)
      .flatMap((assignment) => {
        const request = this.service.currentTurnRequest(
          String(assignment.id),
          Number(assignment.version),
        );
        const runtime =
          request?.state === "queued" ||
          (assignment.state === "pending" && !request);
        const refused =
          request?.state === "held" &&
          !!request.reason?.startsWith(refusedRevisionPrefix);
        return runtime || refused || assignment.state === "held"
          ? [{ assignment, request, runtime }]
          : [];
      });
  }
  /**
   * Runtime facts of the profiles whose turns are next: the queued or unrequested of
   * `next`, at the request's bound profile revision or else the assignment's. With none,
   * the lead takes the next turn. The first candidate with a runtime wait is reported.
   */
  private executingWaitFacts(
    t: Row,
    excluded: readonly string[] | undefined,
    next: ReturnType<OperatorApi["nextAssignments"]>,
  ) {
    const candidates = next
      .filter((w) => w.runtime)
      .map(({ assignment, request }) =>
        this.profileWaitFacts(
          String(assignment.profileId),
          request?.profileRevision ?? Number(assignment.profileRevision),
        ),
      );
    if (!candidates.length)
      return this.profileWaitFacts(this.taskLead(t, excluded)?.profileId);
    return (
      candidates.find(
        (f) =>
          f &&
          (f.runtimeUnavailable ||
            f.runtimeNotConfigured ||
            f.claudeTokenUnavailable),
      ) ?? candidates[0]
    );
  }
  /**
   * What stops each of the `next` assignments beyond the task's own admission, which the
   * task waits already carry (the lead's own reasons are a subset of them), with its
   * profile's name. A revoked lead keeps its assignment's wait beside `project-lead-revoked`:
   * choosing another lead clears the task's reason, not the bound assignment's.
   */
  private assignmentWaitFacts(
    taskId: string,
    excluded: readonly string[] | undefined,
    next: ReturnType<OperatorApi["nextAssignments"]>,
  ) {
    if (!next.length) return [];
    const d = this.domain(),
      task = new Set(d.admission(taskId).reasons);
    return next.flatMap(({ assignment, request }) => {
      const assignmentId = String(assignment.id);
      const reasons = [
        ...d
          .assignmentAdmission(assignmentId)
          .reasons.filter((r) => !task.has(r)),
        // Scheduler-only: the same check admission runs for the queued request.
        ...(this.service.recoveryContinuationUnresolved(
          assignmentId,
          request?.workId ?? "",
        )
          ? ["recovery-continuation-unresolved"]
          : []),
      ];
      return reasons.length
        ? [
            {
              assignmentId,
              profileId: String(assignment.profileId),
              profileName: this.exact(
                d.profile(String(assignment.profileId)).name,
                excluded,
              ),
              reasons,
            },
          ]
        : [];
    });
  }
  /** What is using capacity when the project or installation is at its limit. */
  private capacityWait(projectId: string) {
    const c = this.capacity(projectId);
    return c.projectUsage >= c.projectLimit
      ? `${c.projectUsage} of ${c.projectLimit} project turns running`
      : c.globalUsage >= c.globalLimit
        ? `${c.globalUsage} of ${c.globalLimit} turns running`
        : null;
  }
  /** Set while the power supervisor holds admission; null when held by nothing or unsupervised. */
  private powerHold() {
    const status = this.service.powerStatus();
    return status?.admissionHeld ? { reason: status.admissionReason } : null;
  }
  /** Waits a new task in this project would have before its own dependencies. */
  private projectWaits(p: Row) {
    const projectId = String(p.id);
    let lead: Row | undefined;
    try {
      lead = p.leadProfileId
        ? this.domain().profile(String(p.leadProfileId))
        : undefined;
    } catch {}
    return deriveWaits({
      projectId,
      admissionReasons: [
        ...(p.paused ? ["project-paused"] : []),
        ...(!lead
          ? ["project-lead-unconfigured"]
          : lead.revoked
            ? ["project-lead-revoked"]
            : []),
      ],
      lead: this.profileWaitFacts(
        p.leadProfileId ? String(p.leadProfileId) : undefined,
      ),
      capacity: this.capacityWait(projectId),
      powerHold: this.powerHold(),
    });
  }
  /** The task's ordered waits; a closed task has none. Labels pass the exclusion check. */
  private taskWaits(
    t: Row,
    admission: ReturnType<OperatorApi["admission"]>,
    execution: Execution,
    excluded: readonly string[] | undefined,
    approvals: readonly CoordinationInteraction[],
  ) {
    if (t.state !== "open") return [];
    const d = this.domain(),
      taskId = String(t.id),
      projectId = String(t.projectId),
      identity = this.identity(taskId),
      // As the source summary discloses it: a valid name that passes the exclusions.
      repository = (value: unknown) =>
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(value)) &&
        this.disclosable(value, excluded)
          ? String(value)
          : null,
      waiting = ["idle", "queued", "selected", "waiting"].includes(
        execution.state,
      ),
      next = this.nextAssignments(taskId);
    return deriveWaits({
      projectId,
      admissionReasons: admission.reasons,
      lead: this.executingWaitFacts(t, excluded, next),
      assignments: this.assignmentWaitFacts(taskId, excluded, next),
      // The same predicate as admission, so an imported blocker marked done keeps its link.
      dependencies: d.blockingDependencies(taskId).map((id) => ({
        id,
        label: this.safe(d.task(id).title, excluded) ?? "Unavailable task",
      })),
      nativeBlockers: identity
        ? this.service
            .githubSources()
            .nativeBlockers(identity.nodeId)
            .filter((b) => b.status === "open")
            .map((b) => {
              const name = repository(b.repositoryName);
              return {
                url: githubIssueUrl(name, Number(b.issueNumber) || null),
                label: `${name ?? "GitHub"}#${Number(b.issueNumber)}`,
              };
            })
        : [],
      sourceUrl: this.sourceSummary(taskId, excluded)?.url ?? null,
      approvals: approvals
        .filter((a) => a.status === "open")
        .map((a) => ({
          id: a.interactionId,
          label: "Review material & decide",
        })),
      capacity:
        admission.eligible && waiting ? this.capacityWait(projectId) : null,
      powerHold: this.powerHold(),
      repositoryAccessRevoked: this.service.repositoryAccessRevoked(taskId),
    });
  }
  private admission(taskId: string) {
    const a = this.domain().admission(taskId);
    return {
      eligible: a.eligible,
      reasons: a.reasons.map((r) =>
        admissionSchema.shape.reasons.element.safeParse(r).success
          ? r
          : r.startsWith("source-")
            ? "source-held"
            : "admission-blocked",
      ),
    };
  }
  private taskLead(task: Row, excluded: readonly string[] | undefined) {
    const d = this.domain(),
      projectId = String(task.projectId);
    const binding = d
      .leadBindings()
      .find((b) => b.taskId === task.id && b.projectId === projectId);
    if (binding) {
      let name: string | null = null;
      try {
        name = this.safe(
          d.profileRevision(
            String(binding.profileId),
            Number(binding.profileRevision),
          ).name,
          excluded,
        );
      } catch {}
      return { profileId: String(binding.profileId), name };
    }
    const project = d.project(projectId);
    if (!project.leadProfileId) return null;
    let name: string | null = null;
    try {
      name = this.safe(d.profile(String(project.leadProfileId)).name, excluded);
    } catch {}
    return { profileId: String(project.leadProfileId), name };
  }
  /** Collection reads pass `readiness` preloaded for all their tasks. */
  private sourceSummary(
    taskId: string,
    excluded: readonly string[] | undefined,
    readiness?: ReadinessByTask,
  ) {
    const identity = this.identity(taskId);
    if (!identity) return null;
    const issue = this.service.githubSources().issue(identity.nodeId);
    const rawName = issue?.repositoryName;
    const repositoryName =
      rawName &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(rawName)) &&
      this.disclosable(rawName, excluded)
        ? String(rawName)
        : null;
    const number =
      issue &&
      Number.isSafeInteger(Number(issue.issueNumber)) &&
      Number(issue.issueNumber) > 0
        ? Number(issue.issueNumber)
        : null;
    return {
      identity,
      repositoryName,
      number,
      url: githubIssueUrl(repositoryName, number),
      state: issue?.observedState ?? null,
      closure: this.domain().providerClosure(taskId),
      readiness: this.taskReadiness(
        () => String(this.domain().task(taskId).projectId),
        taskId,
        excluded,
        readiness,
      ),
    };
  }
  /** A stored null rule is `none`; a rule the exclusions withhold is `unavailable`. */
  private readinessRuleView(
    rule: Readiness | null,
    excluded: readonly string[] | undefined,
  ) {
    if (rule === null) return { kind: "none" as const };
    if (this.exact(JSON.stringify(rule), excluded) === null)
      return { kind: "unavailable" as const };
    return { kind: "rule" as const, ...rule };
  }
  private taskReadiness(
    projectId: () => string,
    taskId: string | undefined,
    excluded: readonly string[] | undefined,
    preloaded?: ReadinessByTask,
  ) {
    const store = this.service.githubSources(),
      result = taskId
        ? (preloaded ?? store.readinessByTask([taskId])).get(taskId)
        : undefined,
      rule = this.readinessRuleView(
        result ? result.rule : store.readinessRule(projectId()),
        excluded,
      );
    return rule.kind === "unavailable" || !result
      ? { rule, outcome: "not-evaluated" as const, unmet: [] }
      : { rule, outcome: result.outcome, unmet: result.unmet };
  }
  private async taskSummary(
    taskId: string,
    base?: ExclusionBase,
    readiness?: ReadinessByTask,
  ) {
    return (await this.taskSummaryRead(taskId, base, readiness)).summary;
  }
  /** The List's attention codes, shared by the task summary, the task read and the Inbox. */
  private taskAttention(
    task: Row,
    view: CoordinationTaskView,
    execution: Execution,
    assignments: ReturnType<
      ReturnType<StandaloneService["domain"]>["assignments"]
    >,
  ) {
    const taskId = String(task.id);
    const codes: AttentionCode[] = [];
    let count = 0;
    const add = (code: AttentionCode, n: number) => {
      if (n) {
        codes.push(code);
        count += n;
      }
    };
    add("question", view.questions.filter((i) => i.status === "open").length);
    // An answer recorded for a native question that Ensemble has not yet confirmed delivering.
    add(
      "question-delivery",
      view.questions.filter(
        (i) =>
          i.status === "answered" &&
          view.runtimeQuestions?.some(
            (q) =>
              q.interactionId === i.interactionId &&
              q.deliveryState !== "confirmed",
          ),
      ).length,
    );
    add("approval", view.approvals.filter((i) => i.status === "open").length);
    add("unresolved-result", view.unresolvedResults.length);
    add(
      "completion-rejected",
      view.completionRequests.filter(
        (c) =>
          c.status === "rejected" && c.taskVersion === Number(task.version),
      ).length,
    );
    const uncertain =
      execution.holds.uncertainty ||
      this.service.hasNonStopTaskHold(taskId) ||
      assignments.some((a) => {
        const s = this.selection(a);
        const confirmed =
          s.request?.state === "active" &&
          ["running", "submitting"].includes(s.intent?.state ?? "");
        return (
          s.request?.state === "held" ||
          (s.request?.state === "active" && !confirmed) ||
          Boolean(
            (s.record?.holds.writer || s.record?.holds.capacity) && !confirmed,
          )
        );
      });
    add("execution-uncertain", uncertain ? 1 : 0);
    add(
      "lead-review",
      assignments.length === 0 &&
        view.routing.attempts.some(
          (a) =>
            a.taskVersion === Number(task.version) &&
            a.status === "lead-review",
        )
        ? 1
        : 0,
    );
    return { codes, count };
  }
  /** The summary plus the coordination view and exclusions it was derived from. */
  private async taskSummaryRead(
    taskId: string,
    base?: ExclusionBase,
    readiness?: ReadinessByTask,
  ) {
    const d = this.domain(),
      task = d.task(taskId),
      projectId = String(task.projectId),
      excluded = await this.exclusions(projectId, taskId, [], [], base),
      view = this.coordination().readTask(taskId),
      execution = this.execution(task),
      assignments = d.assignments(taskId);
    const summary = {
      id: taskId,
      projectId,
      title: this.safe(task.title, excluded),
      version: Number(task.version),
      state: task.state,
      ready: Boolean(task.ready),
      project: this.project(d.project(projectId), excluded),
      lead: this.taskLead(task, excluded),
      execution,
      admission: this.admission(taskId),
      capacity: this.capacity(projectId),
      source: this.sourceSummary(taskId, excluded, readiness),
      attention: this.taskAttention(task, view, execution, assignments),
    };
    return { summary, view, excluded };
  }
  async readTaskListPage(params = new URLSearchParams()) {
    return this.readWithExclusionFence(() => this.readTaskListPageOnce(params));
  }
  private async readTaskListPageOnce(params = new URLSearchParams()) {
    const values: Record<string, string> = {};
    for (const [key, value] of params) {
      if (key in values) throw new OperatorApiError(400, "invalid-input");
      values[key] = value;
    }
    const query = taskListQuerySchema.parse(values);
    if (query.projectId) this.requireProject(query.projectId);
    const catalog = this.catalog().filter(
      (t) =>
        (!query.projectId || t.projectId === query.projectId) &&
        (!query.state || t.state === query.state),
    );
    const catalogFingerprint = createHash("sha256")
      .update(JSON.stringify(catalog.map((t) => [t.id, t.projectId])))
      .digest("hex");
    const index = query.cursor
      ? catalog.findIndex((t) => t.id === query.cursor)
      : -1;
    // An unknown cursor is stale, not an empty page.
    if (query.cursor && index < 0) throw new OperatorApiError(409, "conflict");
    const page = catalog.slice(index + 1, index + 1 + query.limit),
      snapshot = this.workspaceSnapshot(page.map((t) => t.id)),
      base = this.exclusionBase(),
      readiness = this.service
        .githubSources()
        .readinessByTask(page.map((t) => t.id)),
      tasks = await Promise.all(
        page.map((t) => this.taskSummary(t.id, base, readiness)),
      );
    this.requireWorkspaceSnapshot(snapshot);
    return taskListPageSchema.parse({
      data: {
        tasks,
        nextCursor:
          index + 1 + page.length < catalog.length
            ? (page.at(-1)?.id ?? null)
            : null,
        catalogFingerprint,
      },
      observedAt: Date.now(),
    });
  }
  /** A drafting run for the composer to reattach to; its proposal is redacted like any agent text. */
  async readDraftingRun(runId: string) {
    return this.readWithExclusionFence(() => this.readDraftingRunOnce(runId));
  }
  private async readDraftingRunOnce(runId: string) {
    if (!uuid.safeParse(runId).success)
      throw new OperatorApiError(404, "not-found");
    const run = this.service.readDrafting(runId);
    if (!run) throw new OperatorApiError(404, "not-found");
    const current = await this.exclusions(run.projectId);
    if (current === undefined) throw new OperatorApiError(503, "unavailable");
    // The paths this run was built from stay private even after the project unlinks them.
    const excluded = prepareExclusions([
      ...current,
      ...this.service.draftingGrantPaths(runId),
    ]);
    // Text the exclusions would change is withheld whole, never shown altered or empty.
    // An issue run keeps its body in `outcome`; it is read with the issue body's limit.
    const issueRun = run.kind === "issue";
    const title = run.proposal && this.exact(run.proposal.title, excluded);
    const outcome =
      run.proposal &&
      this.exact(run.proposal.outcome, excluded, issueRun ? 64_000 : 16000);
    const shown =
      run.proposal && title !== null && outcome !== null
        ? { title, outcome }
        : null;
    return draftingRunReadSchema.parse({
      data: {
        runId: run.runId,
        projectId: run.projectId,
        state: run.state,
        reason: run.reason,
        kind: run.kind,
        proposal: shown && !issueRun ? shown : null,
        issueProposal:
          shown && issueRun
            ? { title: shown.title, body: shown.outcome }
            : null,
        proposalWithheld: run.proposal !== null && shown === null,
        leadName: this.safe(
          this.domain().profileRevision(run.profileId, run.profileRevision)
            .name,
          excluded,
        ),
        createdAt: run.createdAt,
        expiresAt: run.expiresAt,
      },
      observedAt: Date.now(),
    });
  }

  async readComposerOptions(projectId: string) {
    return this.readWithExclusionFence(() =>
      this.readComposerOptionsOnce(projectId),
    );
  }
  private async readComposerOptionsOnce(projectId: string) {
    const p = this.requireProject(projectId),
      d = this.domain(),
      catalog = this.catalog();
    const snapshot = this.workspaceSnapshot(
      catalog.filter((t) => t.projectId === projectId).map((t) => t.id),
    );
    const base = this.exclusionBase(),
      excluded = await this.exclusions(projectId, undefined, [], [], base);
    const permitted = new Set(
      d.routingCandidates(projectId).map((p) => String(p.profileId)),
    );
    if (p.leadProfileId) permitted.add(String(p.leadProfileId));
    const profiles = this.profiles(excluded).filter(
      (p) => !p.revoked && permitted.has(p.id),
    );
    const lead = p.leadProfileId
      ? {
          profileId: String(p.leadProfileId),
          name: this.safe(d.profile(String(p.leadProfileId)).name, excluded),
        }
      : null;
    const own = catalog.filter((t) => t.projectId === projectId),
      readiness = this.service
        .githubSources()
        .readinessByTask(own.map((t) => t.id));
    const dependencies = await Promise.all(
      own.map(async (t) => {
        const row = d.task(t.id),
          safe = await this.exclusions(projectId, t.id, [], [], base);
        return {
          id: t.id,
          title: this.safe(row.title, safe),
          state: row.state,
          source: this.sourceSummary(t.id, safe, readiness),
          blocking: d.blocksDependents(t.id),
        };
      }),
    );
    this.requireWorkspaceSnapshot(snapshot);
    return composerOptionsSchema.parse({
      data: {
        project: this.project(p, excluded),
        lead,
        profiles,
        dependencies,
        capacity: this.capacity(projectId),
        routingEnabled: Boolean(d.routing(projectId).enabled),
        waits: this.projectWaits(p),
        assigneeWaits: Object.fromEntries(
          profiles.map((profile) => [
            profile.id,
            deriveWaits({
              projectId,
              admissionReasons: [],
              lead: this.profileWaitFacts(profile.id),
            }),
          ]),
        ),
      },
      observedAt: Date.now(),
    });
  }
  private intactQuestion(
    value: unknown,
    excluded: readonly string[] | undefined,
  ): boolean {
    if (!excluded) return false;
    const serialized = JSON.stringify(value);
    if (excluded.some((v) => v.length > 0 && serialized.includes(v)))
      return false;
    const visit = (v: unknown): boolean =>
      typeof v === "string"
        ? this.exact(v, excluded) === v
        : Array.isArray(v)
          ? v.every(visit)
          : v !== null && typeof v === "object"
            ? Object.entries(v).every(([k, entry]) => visit(k) && visit(entry))
            : true;
    return visit(value);
  }
  // One composition for the exact read and the queue headline, so they cannot disagree.
  private composedQuestion(
    interaction: Pick<CoordinationInteraction, "prompt" | "response">,
    own:
      | { form: QuestionForm; answers: QuestionAnswers | null }
      | null
      | undefined,
    native:
      | {
          request: { questions: StructuredQuestionSet };
          answers?: Record<string, { answers: string[] }> | null | undefined;
        }
      | undefined,
  ) {
    const source = native ? "native" : own ? "ensemble" : "plain";
    const form =
      own?.form ??
      (native
        ? nativeQuestionForm(native.request.questions)
        : questionFormSchema.parse({
            version: 1,
            questions: [
              {
                id: "answer",
                kind: "free-text",
                label: "Answer",
                description: interaction.prompt,
                required: true,
                minLength: 1,
              },
            ],
          }));
    let answers: QuestionAnswers | null = own?.answers ?? null;
    if (native?.answers)
      answers = Object.fromEntries(
        native.request.questions.map((q) => {
          const text = native.answers?.[q.id]?.answers[0] ?? "",
            index = q.options.findIndex((o) => o.label === text);
          return [
            q.id,
            {
              optionIds: index < 0 ? [] : [String(index)],
              text: index < 0 ? text : "",
            },
          ];
        }),
      );
    if (source === "plain" && interaction.response !== null)
      answers = { answer: { optionIds: [], text: interaction.response } };
    return { source, form, answers } as const;
  }
  async readQuestion(taskId: string, interactionId: string) {
    uuid.parse(interactionId);
    const visibility = this.visibilityToken(),
      workspaceVisibility = this.service.taskWorkspaceVisibility(taskId),
      task = this.requireTask(taskId),
      excluded = await this.exclusions(String(task.projectId), taskId);
    const view = this.coordination(),
      v = view.readTask(taskId),
      interaction = v.questions.find((q) => q.interactionId === interactionId);
    if (!interaction) throw new OperatorApiError(404, "not-found");
    const own = view.questionForm(interactionId),
      native = v.runtimeQuestions?.find(
        (q) => q.interactionId === interactionId,
      );
    const { source, form, answers } = this.composedQuestion(
      interaction,
      own,
      native,
    );
    const intact =
      this.intactQuestion(form, excluded) &&
      this.intactQuestion(answers, excluded);
    const unavailable =
      (own?.requestState !== undefined && own.requestState !== "available") ||
      native?.requestState === "unavailable";
    const status = !intact
      ? "unavailable"
      : interaction.status === "answered"
        ? "recorded"
        : unavailable
          ? own?.requestState === "cancelled"
            ? "cancelled"
            : "unsupported"
          : !native && !view.ownQuestionEligibility(interactionId)
            ? "stale"
            : "pending";
    if (
      visibility !== this.visibilityToken() ||
      workspaceVisibility !== this.service.taskWorkspaceVisibility(taskId) ||
      this.requireTask(taskId).version !== task.version
    )
      throw new OperatorApiError(503, "unavailable");
    return questionReadSchema.parse({
      data: {
        taskId,
        interactionId,
        requestingAssignmentId: interaction.requestingAssignmentId,
        conversationRevision: interaction.conversationRevision,
        revision: interaction.revision,
        source,
        status,
        form: intact ? form : null,
        answers: intact ? answers : null,
        reason: !intact
          ? "Exact question unavailable under current privacy coverage"
          : unavailable && status === "recorded"
            ? "Answer recorded. Request closed; the retained answer is read-only."
            : unavailable
              ? "Request is unavailable; no answer can be submitted"
              : null,
        deliveryState:
          native?.deliveryState ??
          (answers ? "Recorded; admission remains subject to holds" : null),
      },
      observedAt: Date.now(),
    });
  }
  // The queue's headline discloses only what the exact read would: null under privacy exclusions.
  private requestHeadline(
    q: CoordinationInteraction,
    native: { request: { questions: StructuredQuestionSet } } | undefined,
    excluded: readonly string[] | undefined,
  ): string | null {
    if (q.kind === "approval") {
      const approval = this.interaction(q, excluded);
      return approval.approvable ? approval.action : null;
    }
    // A corrupt stored form must not take the task's other rows down with it.
    try {
      const { source, form, answers } = this.composedQuestion(
        q,
        this.coordination().questionForm(q.interactionId),
        native,
      );
      if (
        !this.intactQuestion(form, excluded) ||
        !this.intactQuestion(answers, excluded)
      )
        return null;
      return source === "plain"
        ? this.safe(q.prompt, excluded)
        : (form.questions[0]?.label ?? null);
    } catch {
      return null;
    }
  }
  private runtimeInboxItems(): InboxItem[] {
    return this.service.harnessStatuses().flatMap((status) =>
      status.state === "unavailable" && status.restart?.state === "exhausted"
        ? [
            {
              id: `runtime:${status.harness}`,
              kind: "runtime" as const,
              urgency: 0 as const,
              createdAt: status.restart.since,
              harness: status.harness,
              since: status.restart.since,
              headline: runtimeInboxHeadline(status.harness),
              reason: runtimeInboxReason,
              lastFailure: status.restart.lastFailure,
              attempts: status.restart.attempts,
              destination: runtimeSettingsPath,
            },
          ]
        : [],
    );
  }
  async readInbox(params = new URLSearchParams()) {
    const allowed = ["cursor", "limit", "kind", "project"];
    if (
      [...params.keys()].some((k) => !allowed.includes(k)) ||
      allowed.some((k) => params.getAll(k).length > 1)
    )
      throw new OperatorApiError(400, "invalid-input");
    const filter = z
      .object({
        limit: z
          .string()
          .regex(/^[1-9][0-9]{0,2}$/)
          .transform(Number)
          .pipe(z.number().max(100))
          .optional(),
        kind: z
          .enum(["question", "approval", "intervention", "runtime"])
          .optional(),
        project: uuid.optional(),
      })
      .safeParse({
        limit: params.get("limit") ?? undefined,
        kind: params.get("kind") ?? undefined,
        project: params.get("project") ?? undefined,
      });
    if (!filter.success) throw new OperatorApiError(400, "invalid-input");
    const { limit = 100, kind, project } = filter.data;
    const visibility = this.visibilityToken(),
      items: TaskInboxItem[] = [];
    const catalog = this.catalog();
    const tasks = catalog.map((t) => this.requireTask(t.id)),
      snapshot = this.workspaceSnapshot(catalog.map((t) => t.id)),
      exclusionBase = this.exclusionBase(),
      readiness = this.service
        .githubSources()
        .readinessByTask(catalog.map((t) => t.id));
    let unavailable = false;
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]!;
      const taskId = String(task.id);
      try {
        const { summary, view, excluded } = await this.taskSummaryRead(
          taskId,
          exclusionBase,
          readiness,
        );
        if (!excluded) unavailable = true;
        const base = {
          taskId,
          projectId: String(task.projectId),
          projectName: summary.project.name,
          taskTitle: summary.title,
          evidence: `/app/tasks/${taskId}#history`,
        };
        const attentionCode = interventionCode(summary.attention.codes);
        if (attentionCode)
          items.push({
            ...base,
            id: `intervention:${taskId}`,
            kind: "intervention",
            urgency: 0,
            createdAt: null,
            requestingAssignmentId: null,
            requesterName: null,
            interactionId: null,
            revision: null,
            reason: attentionNext[attentionCode].reason,
            attentionCode,
            destination: `/app/tasks/${taskId}?section=decisions`,
            conversation: null,
            headline: null,
          });
        for (const q of [...view.questions, ...view.approvals]) {
          const native = view.runtimeQuestions?.find(
            (n) => n.interactionId === q.interactionId,
          );
          if (
            q.status !== "open" &&
            (!native || native.deliveryState === "confirmed")
          )
            continue;
          // A recorded answer whose native delivery is unresolved stays listed, as Ensemble's.
          const delivering = q.status === "answered";
          const requester = this.domain()
            .assignments(taskId)
            .find((a) => a.id === q.requestingAssignmentId);
          const name = requester
            ? this.safe(
                this.domain().profile(String(requester.profileId)).name,
                excluded,
              )
            : null;
          items.push({
            ...base,
            id: q.interactionId,
            headline: this.requestHeadline(q, native, excluded),
            kind: q.kind,
            urgency: 1,
            createdAt: q.createdAt * 1000, // coordination SQLite timestamps are unix seconds.
            requestingAssignmentId: q.requestingAssignmentId,
            requesterName: name,
            interactionId: q.interactionId,
            revision: q.revision,
            reason:
              q.kind === "approval"
                ? "Review exact approval material"
                : delivering
                  ? "Answer recorded; native delivery remains unresolved"
                  : "Operator answer requested",
            attentionCode: delivering ? "question-delivery" : null,
            destination:
              q.kind === "question"
                ? `/app/tasks/${taskId}?request=${q.interactionId}`
                : `/coordination/task/${taskId}#${q.interactionId}`,
            conversation: `/app/tasks/${taskId}?assignment=${q.requestingAssignmentId}#history`,
          });
        }
        if (this.requireTask(taskId).version !== task.version)
          throw new OperatorApiError(503, "unavailable");
      } catch (error) {
        if (error instanceof OperatorApiError) throw error;
        unavailable = true;
      }
      if (i % 20 === 19) await yieldTraversal();
    }
    if (visibility !== this.visibilityToken())
      throw new OperatorApiError(503, "unavailable");
    this.requireWorkspaceSnapshot(snapshot);
    for (const task of tasks) {
      const current = this.requireTask(String(task.id));
      if (
        current.version !== task.version ||
        current.projectId !== task.projectId
      )
        throw new OperatorApiError(503, "unavailable");
    }
    // Derived on every read from in-memory restart state; no row stores it. They belong to
    // no project, so a project filter excludes them.
    const filtered: InboxItem[] = [
      ...this.runtimeInboxItems(),
      ...items,
    ].filter(
      (item) =>
        (!kind || item.kind === kind) &&
        (!project || (item.kind !== "runtime" && item.projectId === project)),
    );
    filtered.sort(
      (a, b) =>
        a.urgency - b.urgency ||
        (a.createdAt ?? Number.MAX_SAFE_INTEGER) -
          (b.createdAt ?? Number.MAX_SAFE_INTEGER) ||
        a.id.localeCompare(b.id),
    );
    // Filters join the fingerprint, so a cursor never continues another view.
    const filters = { limit, kind, project };
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          [...params.keys()].every((k) => k === "cursor")
            ? filtered
            : [filters, filtered],
        ),
      )
      .digest("hex")
      .slice(0, 24);
    const cursor = params.get("cursor");
    let offset = 0;
    if (cursor) {
      const match = cursor.match(/^([a-f0-9]{24}):([0-9]+)$/);
      if (!match || match[1] !== fingerprint)
        throw new OperatorApiError(409, "conflict");
      offset = Number(match[2]);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > filtered.length
      )
        throw new OperatorApiError(400, "invalid-input");
    }
    const next =
      offset + limit < filtered.length
        ? `${fingerprint}:${offset + limit}`
        : null;
    return inboxReadSchema.parse({
      data: {
        items: filtered.slice(offset, offset + limit),
        nextCursor: next,
        complete: next === null && !unavailable,
        unavailable,
      },
      observedAt: Date.now(),
    });
  }
  private interaction(
    i: CoordinationInteraction,
    excluded: readonly string[] | undefined,
  ) {
    let material = null;
    let materialUnavailable = i.kind === "approval";
    if (i.materialJson !== null && excluded) {
      try {
        const parsed = materialSchema.parse(JSON.parse(i.materialJson));
        if (this.disclosable(i.materialJson, excluded)) {
          material = parsed;
          materialUnavailable = false;
        }
      } catch {}
    }
    return {
      interactionId: i.interactionId,
      taskId: i.taskId,
      requestingAssignmentId: i.requestingAssignmentId,
      requestingWorkId: i.requestingWorkId,
      requestingWorkRevision: i.requestingWorkRevision,
      requestingAssignmentVersion: i.requestingAssignmentVersion,
      conversationRevision: i.conversationRevision,
      kind: i.kind,
      status: i.status,
      prompt: this.safe(i.prompt, excluded),
      action: this.safe(i.action, excluded),
      target: this.safe(i.target, excluded),
      materialHash: i.materialHash,
      material,
      approvable:
        i.kind === "approval" &&
        !materialUnavailable &&
        this.disclosable(i.action, excluded) &&
        this.disclosable(i.target, excluded),
      materialUnavailable,
      response: this.safe(i.response, excluded),
      revision: i.revision,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    };
  }
  private completion(c: TaskCompletionRequest) {
    return {
      requestId: c.requestId,
      taskId: c.taskId,
      leadAssignmentId: c.leadAssignmentId,
      leadWorkId: c.leadWorkId,
      leadWorkRevision: c.leadWorkRevision,
      taskVersion: c.taskVersion,
      reviewedResultIds: c.reviewedResultIds,
      status: c.status,
      rejectionReasons: c.rejectionReasons.map(() => "completion-rejected"),
      revision: c.revision,
      createdAt: c.createdAt,
      finalizedAt: c.finalizedAt,
    };
  }
  async readTask(
    taskId: string,
    selection: {
      resultId?: string | undefined;
      sourceId?: string | undefined;
    } = {},
  ) {
    const visibility = this.visibilityToken();
    const workspaceVisibility = this.service.taskWorkspaceVisibility(taskId);
    const t = this.requireTask(taskId),
      projectId = String(t.projectId),
      d = this.domain(),
      p = d.project(projectId),
      excluded = await this.exclusions(projectId, taskId),
      view = this.coordination().readTask(taskId),
      assignments = d.assignments(taskId),
      lead = d
        .leadBindings()
        .find((b) => b.taskId === taskId && b.projectId === projectId);
    const profile = p.leadProfileId ? d.profile(String(p.leadProfileId)) : null;
    const identity = this.identity(taskId),
      issue = identity
        ? this.service.githubSources().issue(identity.nodeId)
        : undefined;
    const messages = view.messages.map((m) => ({
      eventId: m.eventId,
      eventType: m.eventType,
      recipientAssignmentId: m.recipientAssignmentId,
      deliveryState: m.deliveryState,
      createdAt: m.createdAt,
      ...(m.text === undefined ? {} : { text: this.safe(m.text, excluded) }),
      ...(m.decision === undefined ? {} : { decision: m.decision }),
      ...(m.action === undefined
        ? {}
        : { action: this.safe(m.action, excluded) }),
      ...(m.target === undefined
        ? {}
        : { target: this.safe(m.target, excluded) }),
      ...(m.resultId === undefined ? {} : { resultId: m.resultId }),
      ...(m.routingOperationId === undefined
        ? {}
        : { routingOperationId: m.routingOperationId }),
      ...(m.routingReason === undefined
        ? {}
        : { routingReason: this.safe(m.routingReason, excluded) }),
      ...(m.questionAnswers && this.intactQuestion(m.questionAnswers, excluded)
        ? { questionAnswers: m.questionAnswers }
        : {}),
      ...(m.reference ? { reference: m.reference } : {}),
      ...(m.requester ? { requester: m.requester } : {}),
      ...(m.interactionId === undefined
        ? {}
        : { interactionId: m.interactionId }),
    }));
    const admission = this.admission(taskId),
      execution = this.execution(t);
    const leadAssignmentId =
      this.domain()
        .leadBindings()
        .find((b) => String(b.taskId) === taskId)?.assignmentId ?? null;
    const data = {
      task: {
        id: taskId,
        projectId,
        title: this.safe(t.title, excluded),
        outcome: this.safe(t.outcome, excluded),
        version: Number(t.version),
        state: t.state,
        ready: Boolean(t.ready),
      },
      lead: profile
        ? {
            profileId: String(profile.id),
            name: this.safe(profile.name, excluded),
          }
        : null,
      leadAssignmentId,
      ...(leadAssignmentId
        ? {
            leadFeedback: {
              mode: this.coordination().leadFeedbackMode(
                taskId,
                String(leadAssignmentId),
              ),
              awaitingRecoveryMessage:
                this.coordination().leadAwaitsRecoveryMessage(
                  taskId,
                  String(leadAssignmentId),
                ),
            },
          }
        : {}),
      draftTurn: this.service.draftTurnAvailability(taskId),
      assignments: assignments.map((a) => {
        const s = this.selection(a),
          request = s.request;
        return {
          assignmentId: String(a.id),
          profileId: String(a.profileId),
          name: this.safe(d.profile(String(a.profileId)).name, excluded),
          brief: this.safe(a.brief, excluded),
          requesterAssignmentId: a.requesterAssignmentId
            ? String(a.requesterAssignmentId)
            : null,
          resultDestination: this.safe(a.resultDestination, excluded),
          resultRecipientAssignmentId: a.resultRecipientAssignmentId
            ? String(a.resultRecipientAssignmentId)
            : null,
          resultRecipientDisposition: this.safe(
            a.resultRecipientDisposition,
            excluded,
          ),
          waitReason: this.safe(
            s.intent?.reason ??
              (d.assignmentAdmission(String(a.id)).reasons.join("; ") || null),
            excluded,
          ),
          version: Number(a.version),
          state: a.state,
          profileRevision: Number(a.profileRevision),
          instructionsRevision: Number(a.instructionsRevision),
          currentProfileRevision: Number(
            d.profile(String(a.profileId)).version,
          ),
          currentInstructionsRevision: Number(p.instructionsRevision),
          runtime: d.profileRuntime(
            String(a.profileId),
            Number(a.profileRevision),
          ),
          executionGeneration:
            request?.assignmentVersion &&
            request.instructionsRevision &&
            request.profileRevision
              ? this.generation(
                  {
                    workId: request.workId,
                    sequence: request.sequence,
                    assignmentVersion: request.assignmentVersion,
                    instructionsRevision: request.instructionsRevision,
                    profileRevision: request.profileRevision,
                  },
                  s.intent?.state === "held",
                )
              : null,
        };
      }),
      admission,
      waits: this.taskWaits(t, admission, execution, excluded, view.approvals),
      execution,
      taskHold: this.nonStopTaskHold(taskId, excluded),
      localDependencies: d.dependencies(taskId).map((id) => {
        const b = d.task(id);
        return { id, title: this.safe(b.title, excluded), state: b.state };
      }),
      source: identity
        ? this.source(identity, issue, projectId, excluded)
        : null,
      messages,
      results: view.results.map((r) => ({
        resultId: r.resultId,
        taskId: r.taskId,
        assignmentId: r.assignmentId,
        workId: r.workId,
        workRevision: r.workRevision,
        assignmentVersion: r.assignmentVersion,
        summary: this.safe(r.summary, excluded),
        recipientAssignmentId: r.recipientAssignmentId,
        destinationDisposition: r.destinationDisposition,
        createdAt: r.createdAt,
      })),
      unresolvedResults: view.unresolvedResults.map((u) => {
        const a = assignments.find((a) => a.id === u.assignmentId);
        const desired =
          a?.requesterAssignmentId ??
          (assignments.some((b) => b.id === a?.resultDestination)
            ? a?.resultDestination
            : lead?.assignmentId);
        const recipient = assignments.find((b) => b.id === desired);
        const retained = lead?.assignmentId === desired ? lead : undefined;
        const permitted = recipient ?? retained;
        return {
          resultId: u.resultId,
          taskId: u.taskId,
          assignmentId: u.assignmentId,
          revision: u.revision,
          reasonCode: "unresolved-destination",
          permittedRecipient: permitted
            ? {
                assignmentId: String(desired),
                name: this.safe(
                  d.profile(String(permitted.profileId)).name,
                  excluded,
                ),
              }
            : null,
          availability: permitted ? "available" : "recipient-unavailable",
        };
      }),
      questions: view.questions.map((i) => this.interaction(i, excluded)),
      approvals: view.approvals.map((i) => this.interaction(i, excluded)),
      completionRequests: view.completionRequests.map((c) =>
        this.completion(c),
      ),
      attention: {
        interactions: view.attention.interactions.map((a) => ({
          attentionId: a.attentionId,
          interactionId: a.interactionId,
          status: a.status,
          revision: a.revision,
          createdAt: a.createdAt,
          resolvedAt: a.resolvedAt,
        })),
        completions: view.attention.completions.map((c) => ({
          requestId: c.requestId,
          status: c.status,
          revision: c.revision,
        })),
        routingFallbacks: view.attention.routingFallbacks.map((f) => ({
          eventId: f.eventId,
          operationId: f.operationId,
          reasonCode: "routing-fallback",
          createdAt: f.createdAt,
        })),
        ...this.taskAttention(t, view, execution, assignments),
      },
      review: await this.reviewProjection(taskId, excluded, selection),
      delivery: this.deliveryProjection(taskId, excluded),
      commentPolicy: this.commentPolicy(taskId),
      issueEdit: this.issueEditPolicy(taskId, excluded),
      repositoryLinked:
        this.domain().githubConfiguration(String(t.projectId)).repositories
          .length > 0,
      contentUnavailable:
        excluded === undefined ||
        [
          t.title,
          t.outcome,
          issue?.observedBody,
          issue?.observedTitle,
          ...view.messages.map((m) => m.text),
          ...view.results.map((r) => r.summary),
          ...view.questions.map((i) => i.prompt),
          ...view.approvals.map((i) => i.prompt),
        ].some(
          (v) =>
            v !== null && v !== undefined && this.safe(v, excluded) === null,
        ),
    };
    if (
      visibility !== this.visibilityToken() ||
      workspaceVisibility !== this.service.taskWorkspaceVisibility(taskId) ||
      this.requireTask(taskId).version !== t.version
    )
      throw new OperatorApiError(503, "unavailable");
    return taskSchema.parse({ data, observedAt: Date.now() });
  }
  /** Pages `readTask` results or messages, so projections and redaction match `task get`. */
  async readTaskRecordPage(
    taskId: string,
    kind: "results" | "messages",
    params: URLSearchParams,
  ) {
    const values: Record<string, string> = {};
    for (const [key, value] of params) {
      if (key in values) throw new OperatorApiError(400, "invalid-input");
      values[key] = value;
    }
    const query = taskRecordQuerySchema.parse(values);
    if (kind === "messages" && query.resultId)
      throw new OperatorApiError(400, "invalid-input");
    const { data, observedAt } = await this.readTask(taskId);
    const records: { id: string; value: unknown }[] =
      kind === "results"
        ? data.results.map((r) => ({ id: r.resultId, value: r }))
        : data.messages.map((m) => ({ id: m.eventId, value: m }));
    let page = records;
    let nextCursor: string | null = null;
    if (query.resultId) {
      page = records.filter((r) => r.id === query.resultId);
      if (!page.length) throw new OperatorApiError(404, "not-found");
    } else {
      const index = query.cursor
        ? records.findIndex((r) => r.id === query.cursor)
        : -1;
      if (query.cursor && index < 0)
        throw new OperatorApiError(409, "conflict");
      page = records.slice(index + 1, index + 1 + query.limit);
      if (index + 1 + page.length < records.length)
        nextCursor = page.at(-1)?.id ?? null;
    }
    const body = {
      [kind]: page.map((r) => r.value),
      total: records.length,
      nextCursor,
    };
    return kind === "results"
      ? taskResultPageSchema.parse({ data: body, observedAt })
      : taskMessagePageSchema.parse({ data: body, observedAt });
  }
  /** One retained instruction revision, sanitized with the disclosure exclusions. */
  private instructionBody(
    revision: number,
    raw: string,
    excluded: readonly string[] | undefined,
  ) {
    const text = excluded ? sanitizeConversationText(raw, excluded) : undefined;
    return text === undefined || text.length > 16000
      ? {
          revision,
          state: "omitted" as const,
          reason: "redaction-unavailable" as const,
          text: null,
          redacted: false,
        }
      : {
          revision,
          state: "available" as const,
          reason: null,
          text,
          redacted: text !== raw,
        };
  }
  private profileInstructionBody(
    profileId: string,
    revision: number,
    excluded: readonly string[] | undefined,
  ) {
    const row = this.domain().profileRevision(profileId, revision);
    return {
      ...this.instructionBody(revision, String(row.instructions), excluded),
      name: this.safe(row.name, excluded),
      capabilities: this.safe(row.capabilities, excluded),
      revoked: Boolean(row.revoked),
      runtime: this.domain().profileRuntime(profileId, revision),
    };
  }
  private revisionList(current: number, text: (revision: number) => string) {
    return Array.from({ length: current }, (_, i) => ({
      revision: i + 1,
      current: i + 1 === current,
      instructionChars: text(i + 1).length,
    }));
  }
  private parseRevision(query: URLSearchParams, current: number) {
    for (const key of query.keys())
      if (key !== "revision" || query.getAll(key).length !== 1)
        throw new OperatorApiError(400, "invalid-input");
    const value = query.get("revision");
    if (value === null) return current;
    if (!/^[1-9][0-9]{0,8}$/.test(value))
      throw new OperatorApiError(400, "invalid-input");
    const revision = Number(value);
    if (revision > current) throw new OperatorApiError(404, "not-found");
    return revision;
  }
  /** Fails closed when instruction or credential visibility changes across the await. */
  private async instructionExclusions(
    disclose: string[],
    projectId?: string,
    taskId?: string,
    base?: ExclusionBase,
  ) {
    const visibility = this.visibilityToken();
    const excluded = await this.exclusions(
      projectId,
      taskId,
      [],
      disclose,
      base,
    );
    if (visibility !== this.visibilityToken())
      throw new OperatorApiError(503, "unavailable");
    return excluded;
  }
  async readProfileInstructions(profileId: string, query: URLSearchParams) {
    uuid.parse(profileId);
    const d = this.domain(),
      row = d.profiles().find((p) => p.id === profileId);
    if (!row) throw new OperatorApiError(404, "not-found");
    const current = Number(row.version),
      revision = this.parseRevision(query, current),
      excluded = await this.instructionExclusions([`profile:${profileId}`]);
    return profileInstructionsSchema.parse({
      data: {
        summary: this.profiles(excluded).find((p) => p.id === profileId),
        currentRevision: current,
        revisions: this.revisionList(current, (r) =>
          String(d.profileRevision(profileId, r).instructions),
        ),
        selected: this.profileInstructionBody(profileId, revision, excluded),
        provenance: instructionProvenance,
      },
      observedAt: Date.now(),
    });
  }
  async readProjectInstructions(projectId: string, query: URLSearchParams) {
    const p = this.requireProject(projectId),
      d = this.domain(),
      current = Number(p.instructionsRevision),
      revision = this.parseRevision(query, current),
      excluded = await this.instructionExclusions(
        [`project:${projectId}`],
        projectId,
      );
    return projectInstructionsSchema.parse({
      data: {
        summary: this.project(d.project(projectId), excluded),
        currentRevision: current,
        revisions: this.revisionList(current, (r) =>
          d.instructionRevision(projectId, r),
        ),
        selected: this.instructionBody(
          revision,
          d.instructionRevision(projectId, revision),
          excluded,
        ),
        provenance: instructionProvenance,
      },
      observedAt: Date.now(),
    });
  }
  private requireAssignment(assignmentId: string) {
    uuid.parse(assignmentId);
    const a = this.existing(() => this.domain().assignment(assignmentId));
    const task = this.requireTask(String(a.taskId));
    return { a, taskId: String(task.id), projectId: String(task.projectId) };
  }
  async readAssignment(assignmentId: string) {
    const { taskId, projectId } = this.requireAssignment(assignmentId);
    const { data, observedAt } = await this.readTask(taskId);
    const entry = data.assignments.find((x) => x.assignmentId === assignmentId);
    if (!entry) throw new OperatorApiError(503, "unavailable");
    return assignmentDetailSchema.parse({
      data: {
        ...entry,
        taskId,
        projectId,
        taskVersion: data.task.version,
        lead: data.leadAssignmentId === assignmentId,
        execution: data.execution,
      },
      observedAt,
    });
  }
  async readAssignmentInstructions(assignmentId: string) {
    const { a, taskId, projectId } = this.requireAssignment(assignmentId),
      d = this.domain(),
      profileId = String(a.profileId),
      bound = {
        profile: Number(a.profileRevision),
        project: Number(a.instructionsRevision),
      },
      current = {
        profile: Number(d.profile(profileId).version),
        project: Number(d.project(projectId).instructionsRevision),
      },
      request = this.selection(a).request;
    const excluded = await this.instructionExclusions(
      [`profile:${profileId}`, `project:${projectId}`],
      projectId,
      taskId,
    );
    const pair = (r: typeof bound) => ({
      profile: this.profileInstructionBody(profileId, r.profile, excluded),
      project: this.instructionBody(
        r.project,
        d.instructionRevision(projectId, r.project),
        excluded,
      ),
    });
    const boundView = pair(bound),
      currentView = pair(current);
    const sameContent = (
      kind: "profile" | "project",
      left: { state: string },
      right: { state: string },
    ) =>
      left.state === "omitted" || right.state === "omitted"
        ? null
        : kind === "profile"
          ? d.profileRevision(profileId, bound.profile).instructions ===
            d.profileRevision(profileId, current.profile).instructions
          : d.instructionRevision(projectId, bound.project) ===
            d.instructionRevision(projectId, current.project);
    if (Number(d.assignment(assignmentId).version) !== Number(a.version))
      throw new OperatorApiError(503, "unavailable");
    return assignmentInstructionsSchema.parse({
      data: {
        assignmentId,
        taskId,
        projectId,
        profileId,
        bound: boundView,
        current: currentView,
        comparison: {
          profile: {
            sameRevision: bound.profile === current.profile,
            sameContent: sameContent(
              "profile",
              boundView.profile,
              currentView.profile,
            ),
          },
          project: {
            sameRevision: bound.project === current.project,
            sameContent: sameContent(
              "project",
              boundView.project,
              currentView.project,
            ),
          },
          boundIsCurrent:
            bound.profile === current.profile &&
            bound.project === current.project,
        },
        execution:
          request?.profileRevision && request.instructionsRevision
            ? {
                workId: request.workId,
                requestSequence: request.sequence,
                profileRevision: request.profileRevision,
                instructionsRevision: request.instructionsRevision,
                matchesBound:
                  request.profileRevision === bound.profile &&
                  request.instructionsRevision === bound.project,
              }
            : null,
        provenance: instructionProvenance,
      },
      observedAt: Date.now(),
    });
  }
  /** Task-bound work the caller can see; direct runs and unknown ids are 404. */
  private requireExecution(workId: string) {
    if (!workIdSchema.safeParse(workId).success)
      throw new OperatorApiError(400, "invalid-input");
    const request = this.service.turnRequest(workId);
    if (
      request?.kind !== "assignment" ||
      !request.taskId ||
      !request.assignmentId
    )
      throw new OperatorApiError(404, "not-found");
    const task = this.requireTask(request.taskId);
    return {
      request,
      taskId: request.taskId,
      assignmentId: request.assignmentId,
      projectId: String(task.projectId),
      record: this.service.executionDiagnostics()?.execution(workId),
    };
  }
  private executionSummary(
    request: ReturnType<StandaloneService["turnRequests"]>[number],
    projectId: string,
    record: DiagnosticExecution | undefined,
    excluded: readonly string[] | undefined,
  ) {
    return {
      workId: request.workId,
      requestSequence: request.sequence,
      taskId: String(request.taskId),
      projectId,
      assignmentId: String(request.assignmentId),
      state: request.state,
      reason: this.safe(request.reason, excluded),
      capture: !record
        ? ("not-captured" as const)
        : record.mode === "baseline"
          ? ("baseline" as const)
          : ("captured" as const),
      threadId: this.safe(record?.threadId, excluded),
      turnId: this.safe(record?.turnId, excluded),
      startedAt: record?.startedAt ?? null,
      finishedAt: record?.finishedAt ?? null,
    };
  }
  private captureHealth(record: DiagnosticExecution | undefined) {
    return {
      mode: record?.mode ?? null,
      eventSource: record?.eventSource ?? null,
      toolObservation: "incomplete" as const,
      reasoning: "not-collected" as const,
      gaps: (record?.gaps ?? []).map((g) => ({
        code: g.code,
        count: g.count,
        bytes: g.bytes,
        firstAt: g.firstAt,
        lastAt: g.lastAt,
      })),
      unrecorded: this.service.executionDiagnostics()?.health().unrecorded ?? 0,
    };
  }
  /** Stored payloads are sanitised again with current exclusions; unavailable fails closed. */
  private diagnosticItem(
    item: DiagnosticItem,
    excluded: readonly string[] | undefined,
  ) {
    // General views never show captured instruction segments; only `inputs` discloses them.
    const instruction =
      item.kind === "input" && item.name.endsWith("-instructions");
    const payload =
      item.state !== "available"
        ? null
        : instruction && excluded
          ? { ...(item.payload as object), text: "[redacted]" }
          : boundDetail(item.payload, excluded);
    const unavailable = item.state === "available" && payload === undefined;
    return {
      sequence: item.sequence,
      kind: item.kind,
      name: this.safe(item.name, excluded) ?? "[redacted]",
      severity: (["info", "warn", "error"].includes(item.severity)
        ? item.severity
        : "info") as "info" | "warn" | "error",
      itemId: this.safe(item.itemId, excluded),
      state: unavailable ? ("omitted" as const) : item.state,
      reason: unavailable ? ("redaction-unavailable" as const) : item.reason,
      payload: unavailable ? null : payload,
      redacted: JSON.stringify(payload ?? null).includes("[redacted]"),
      createdAt: item.createdAt,
    };
  }
  private exactQuery(query: URLSearchParams, allowed: readonly string[]) {
    for (const key of query.keys())
      if (!allowed.includes(key) || query.getAll(key).length !== 1)
        throw new OperatorApiError(400, "invalid-input");
  }
  private boundedInt(
    raw: string | null,
    min: number,
    max: number,
  ): number | undefined {
    if (raw === null) return undefined;
    if (!/^[0-9]{1,16}$/.test(raw))
      throw new OperatorApiError(400, "invalid-input");
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new OperatorApiError(400, "invalid-input");
    return value;
  }
  /** Newest first, one task, assignment or project; primary-key lookups only. */
  readExecutionList(query: URLSearchParams) {
    this.exactQuery(query, [
      "task",
      "assignment",
      "project",
      "limit",
      "before",
    ]);
    const scopes = (["task", "assignment", "project"] as const).filter((k) =>
      query.has(k),
    );
    const scope = scopes[0];
    const id = scope ? query.get(scope) : null;
    if (scopes.length !== 1 || !scope || !id || !uuid.safeParse(id).success)
      throw new OperatorApiError(400, "invalid-input");
    const limit = this.boundedInt(query.get("limit"), 1, 200) ?? 50;
    const before = this.boundedInt(
      query.get("before"),
      1,
      Number.MAX_SAFE_INTEGER,
    );
    return this.readWithExclusionFence(async () => {
      if (scope === "task") this.requireTask(id);
      else if (scope === "assignment") this.requireAssignment(id);
      else this.requireProject(id);
      const rows = this.service.turnRequestPage(
        scope === "task"
          ? "taskId"
          : scope === "assignment"
            ? "assignmentId"
            : "projectId",
        id,
        before,
        limit + 1,
      );
      const page = rows.slice(0, limit);
      const store = this.service.executionDiagnostics();
      const excludedByTask = new Map<string, readonly string[] | undefined>(),
        references = this.referenceFence(),
        base = this.exclusionBase();
      const executions = [];
      for (const request of page) {
        const taskId = String(request.taskId);
        const projectId = String(this.requireTask(taskId).projectId);
        if (!excludedByTask.has(taskId))
          excludedByTask.set(
            taskId,
            await this.exclusions(projectId, taskId, [], [], base),
          );
        executions.push(
          this.executionSummary(
            request,
            projectId,
            store?.execution(request.workId),
            excludedByTask.get(taskId),
          ),
        );
      }
      // Credential references and values fence the shared base here; no workspace snapshot does.
      if (references !== this.referenceFence())
        throw new OperatorApiError(503, "unavailable");
      return executionListSchema.parse({
        data: {
          executions,
          nextBefore:
            rows.length > limit ? (page.at(-1)?.sequence ?? null) : null,
        },
        observedAt: Date.now(),
      });
    });
  }
  async readExecution(workId: string) {
    return this.readWithExclusionFence(async () => {
      const { request, taskId, projectId, record } =
        this.requireExecution(workId);
      const excluded = await this.exclusions(projectId, taskId);
      const store = this.service.executionDiagnostics();
      const setting = record
        ? store?.events(workId, { kind: "setting" }).items[0]
        : undefined;
      const entries = setting
        ? (
            this.diagnosticItem(setting, excluded).payload as {
              entries?: { name: unknown; value: unknown; source: unknown }[];
            } | null
          )?.entries
        : undefined;
      const settings = Array.isArray(entries)
        ? entries.map((e) => ({
            name: String(e.name).slice(0, 64),
            value: settingValue(e.value),
            source: ["service-admitted", "runtime-reported"].includes(
              String(e.source),
            )
              ? (e.source as "service-admitted" | "runtime-reported")
              : ("unknown" as const),
          }))
        : null;
      return executionDetailSchema.parse({
        data: {
          execution: this.executionSummary(
            request,
            projectId,
            record,
            excluded,
          ),
          identity: record
            ? {
                assignmentVersion: record.assignmentVersion,
                instructionsRevision: record.instructionsRevision,
                profileRevision: record.profileRevision,
                conversationRevision: record.conversationRevision,
                harness: record.harness,
              }
            : null,
          settings,
          counts: {
            items: record ? (store?.itemCount(workId) ?? 0) : 0,
            payloadBytes: record?.payloadBytes ?? 0,
          },
          health: this.captureHealth(record),
        },
        observedAt: Date.now(),
      });
    });
  }
  /**
   * The dedicated projection of supplied inputs: only here do the execution's own
   * profile and project instruction texts stay readable.
   */
  async readExecutionInputs(workId: string, query: URLSearchParams) {
    this.exactQuery(query, ["compare"]);
    const compare = query.get("compare");
    if (compare !== null && compare !== "current")
      throw new OperatorApiError(400, "invalid-input");
    return this.readWithExclusionFence(async () => {
      const { request, taskId, projectId, assignmentId, record } =
        this.requireExecution(workId);
      const d = this.domain(),
        profileId = String(d.assignment(assignmentId).profileId);
      // The visibility fence must span the shared base, not only the disclosing derivation.
      const visibility = this.visibilityToken(),
        base = this.exclusionBase(),
        general = await this.exclusions(projectId, taskId, [], [], base);
      const disclosing = await this.instructionExclusions(
        [`profile:${profileId}`, `project:${projectId}`],
        projectId,
        taskId,
        base,
      );
      if (visibility !== this.visibilityToken())
        throw new OperatorApiError(503, "unavailable");
      const items = record
        ? (this.service.executionDiagnostics()?.inputs(workId) ?? [])
        : [];
      const segmentNames = [
        "request",
        "role",
        "review-references",
        "project-instructions",
        "profile-instructions",
      ] as const;
      const segments = items.flatMap((item) => {
        const name = segmentNames.find((n) => n === item.name);
        if (!name) return [];
        const payload = item.payload as { text?: unknown; revision?: unknown };
        const excluded = name.endsWith("-instructions") ? disclosing : general;
        const bounded =
          item.state === "available" && typeof payload?.text === "string"
            ? boundDetail(payload.text, excluded, 64 * 1024)
            : undefined;
        const text = typeof bounded === "string" ? bounded : undefined;
        const unavailable = item.state === "available" && text === undefined;
        return [
          {
            name,
            revision:
              typeof payload?.revision === "number" ? payload.revision : null,
            state: unavailable ? ("omitted" as const) : item.state,
            reason: unavailable
              ? ("redaction-unavailable" as const)
              : item.reason,
            text: text ?? null,
            redacted: Boolean(text?.includes("[redacted]")),
          },
        ];
      });
      const submitted = items.find((i) => i.name === "submitted")?.payload as
        | { bytes?: unknown; sha256?: unknown }
        | undefined;
      const instructionCaptured = segments.some((x) =>
        x.name.endsWith("-instructions"),
      );
      const bound = {
        profile: request.profileRevision,
        project: request.instructionsRevision,
      };
      const reconstructed =
        !instructionCaptured && bound.profile && bound.project
          ? {
              provenance: instructionProvenance,
              profile: this.instructionBody(
                bound.profile,
                String(
                  d.profileRevision(profileId, bound.profile).instructions,
                ),
                disclosing,
              ),
              project: this.instructionBody(
                bound.project,
                d.instructionRevision(projectId, bound.project),
                disclosing,
              ),
            }
          : null;
      let comparison = null;
      if (compare === "current" && bound.profile && bound.project) {
        const current = {
          profile: Number(d.profile(profileId).version),
          project: Number(d.project(projectId).instructionsRevision),
        };
        const omitted = (name: string) =>
          segments.find((x) => x.name === name)?.state !== "available" &&
          instructionCaptured;
        const runtime = (revision: number) =>
          d.profileRuntime(profileId, revision) as Record<string, unknown>;
        const captured = runtime(bound.profile),
          now = runtime(current.profile);
        comparison = {
          instructions: [
            {
              name: "project-instructions" as const,
              boundRevision: bound.project,
              currentRevision: current.project,
              sameRevision: bound.project === current.project,
              sameContent: omitted("project-instructions")
                ? null
                : d.instructionRevision(projectId, bound.project) ===
                  d.instructionRevision(projectId, current.project),
            },
            {
              name: "profile-instructions" as const,
              boundRevision: bound.profile,
              currentRevision: current.profile,
              sameRevision: bound.profile === current.profile,
              sameContent: omitted("profile-instructions")
                ? null
                : d.profileRevision(profileId, bound.profile).instructions ===
                  d.profileRevision(profileId, current.profile).instructions,
            },
          ],
          settings: ["harness", "model", "reasoningEffort"].map((name) => {
            const a = settingValue(captured[name]),
              b = settingValue(now[name]);
            return { name, captured: a, current: b, same: a === b };
          }),
        };
      }
      return executionInputsSchema.parse({
        data: {
          workId,
          capture: this.executionSummary(request, projectId, record, general)
            .capture,
          provenance: {
            source: segments.length ? "captured-submission" : "not-captured",
            effectivePrompt: "not-captured",
          },
          segments,
          submitted:
            typeof submitted?.bytes === "number" &&
            typeof submitted.sha256 === "string"
              ? { bytes: submitted.bytes, sha256: submitted.sha256 }
              : null,
          reconstructed,
          comparison,
        },
        observedAt: Date.now(),
      });
    });
  }
  /** Ascending, bounded and resumable by global sequence; never claims completeness. */
  async readExecutionEvents(workId: string, query: URLSearchParams) {
    this.exactQuery(query, [
      "after",
      "limit",
      "kind",
      "severity",
      "since",
      "until",
    ]);
    const after =
      this.boundedInt(query.get("after"), 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const limit = this.boundedInt(query.get("limit"), 1, 200) ?? 200;
    const since = this.boundedInt(
      query.get("since"),
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const until = this.boundedInt(
      query.get("until"),
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const kind = query.get("kind");
    const severity = query.get("severity");
    if (
      (kind !== null &&
        !["input", "setting", "runtime", "tool", "service"].includes(kind)) ||
      (severity !== null && !["info", "warn", "error"].includes(severity))
    )
      throw new OperatorApiError(400, "invalid-input");
    return this.readWithExclusionFence(async () => {
      const { taskId, projectId, record } = this.requireExecution(workId);
      const excluded = await this.exclusions(projectId, taskId);
      const store = this.service.executionDiagnostics();
      let page: ReturnType<ExecutionDiagnosticsStore["events"]> | undefined;
      try {
        page = record
          ? store?.events(workId, {
              after,
              ...(kind ? { kind: kind as DiagnosticItem["kind"] } : {}),
              ...(severity ? { severity } : {}),
              ...(since === undefined ? {} : { since }),
              ...(until === undefined ? {} : { until }),
            })
          : undefined;
      } catch (error) {
        if (error instanceof DiagnosticCursorError)
          throw new OperatorApiError(409, "conflict");
        throw error;
      }
      const items = (page?.items ?? []).slice(0, limit);
      return executionEventsSchema.parse({
        data: {
          workId,
          capture: !record
            ? "not-captured"
            : record.mode === "baseline"
              ? "baseline"
              : "captured",
          items: items.map((item) => this.diagnosticItem(item, excluded)),
          gaps: (page?.gaps ?? []).map((g) => ({
            code: g.code,
            count: g.count,
            bytes: g.bytes,
            firstAt: g.firstAt,
            lastAt: g.lastAt,
            maxPrunedSequence: g.maxPrunedSequence,
          })),
          resumeAfter: items.at(-1)?.sequence ?? after,
          more: Boolean(page && (page.more || page.items.length > limit)),
          finished: !record || record.finishedAt !== null,
          health: this.captureHealth(record),
        },
        observedAt: Date.now(),
      });
    });
  }
  private source(
    identity: NonNullable<ReturnType<OperatorApi["identity"]>>,
    issue: Row | undefined,
    projectId: string,
    excluded: readonly string[] | undefined,
  ) {
    const store = this.service.githubSources(),
      repositoryName =
        issue &&
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(issue.repositoryName))
          ? String(issue.repositoryName)
          : null;
    const number =
      issue &&
      Number.isSafeInteger(Number(issue.issueNumber)) &&
      Number(issue.issueNumber) > 0
        ? Number(issue.issueNumber)
        : null;
    const review = store.review(identity.nodeId),
      hold = store.hold(identity.nodeId);
    return {
      identity,
      repositoryName,
      number,
      url: githubIssueUrl(repositoryName, number),
      title: this.safe(issue?.observedTitle, excluded),
      body: this.safe(issue?.observedBody, excluded),
      state: issue?.observedState ?? null,
      closure: issue
        ? this.domain().providerClosure(String(issue.taskId))
        : null,
      readiness: this.taskReadiness(
        () => projectId,
        issue ? String(issue.taskId) : undefined,
        excluded,
      ),
      memberships: store
        .memberships(identity.nodeId)
        .filter((m) => m.projectId === projectId)
        .map((m) => {
          const sync = store.syncState(projectId, String(m.selectionId));
          const complete = sync ? Boolean(sync.complete) : null;
          const active = this.domain()
            .githubActiveSelectionIds(projectId)
            .includes(String(m.selectionId));
          const fields = z
            .array(
              z
                .object({
                  projectNodeId: z.string().max(512),
                  fieldNodeId: z.string().max(512),
                  optionNodeId: z.string().max(512),
                })
                .strict(),
            )
            .parse(JSON.parse(String(m.projectFields)));
          return {
            selectionId: String(m.selectionId),
            projectFields: fields,
            sync: {
              lastAttemptAt: sync ? String(sync.refreshedAt) : null,
              lastSuccessfulAt:
                complete && active ? String(sync?.refreshedAt) : null,
              complete: active ? complete : false,
              reasonCode: sync
                ? complete && active
                  ? null
                  : "partial-sync"
                : "sync-unavailable",
            },
          };
        }),
      nativeBlockers: store.nativeBlockers(identity.nodeId).map((b) => ({
        nodeId: String(b.blockerNodeId),
        repositoryId: String(b.repositoryId),
        repositoryName: String(b.repositoryName),
        number: Number(b.issueNumber),
        state: b.status,
      })),
      review: review
        ? {
            observedDigest: String(review.observedDigest),
            acceptedDigest: String(review.acceptedDigest),
            decision: this.safe(review.decision, excluded),
            decidedAt:
              review.decidedAt === null ? null : String(review.decidedAt),
          }
        : null,
      hold: hold
        ? {
            active: Boolean(hold.active),
            revision: Number(hold.generation),
            reasonCode: "source-held",
          }
        : null,
    };
  }
  async readAssignmentHistory(
    assignmentId: string,
    beforeSequence?: number,
    beforeOmissionSequence?: number,
    limit?: number,
  ) {
    const visibility = this.visibilityToken();
    uuid.parse(assignmentId);
    for (const p of this.domain().projects())
      for (const task of this.domain().tasks(String(p.id)))
        if (
          this.domain()
            .assignments(String(task.id))
            .some((a) => a.id === assignmentId)
        ) {
          const workspaceVisibility = this.service.taskWorkspaceVisibility(
            String(task.id),
          );
          const history = this.coordination().readAssignmentHistory(
            assignmentId,
            beforeSequence,
            beforeOmissionSequence,
            limit,
          );
          const excluded = await this.exclusions(
            String(p.id),
            String(task.id),
            [...history.items, ...history.turnOmissions],
          );
          if (
            visibility !== this.visibilityToken() ||
            workspaceVisibility !==
              this.service.taskWorkspaceVisibility(String(task.id)) ||
            this.requireTask(String(task.id)).version !== task.version
          )
            throw new OperatorApiError(503, "unavailable");
          return assignmentHistorySchema.parse({
            data: {
              ...history,
              visibilityRevision: createHash("sha256")
                .update(`${visibility}:${task.version}:${workspaceVisibility}`)
                .digest("hex"),
              items: history.items.map((item) => {
                if (item.lifecycle !== "completed") return item;
                const text =
                  excluded === undefined
                    ? undefined
                    : sanitizeConversationText(item.text ?? "", excluded);
                return text === undefined
                  ? {
                      ...item,
                      lifecycle: "omitted",
                      text: null,
                      omissionReason: "redaction-unavailable",
                    }
                  : { ...item, text };
              }),
            },
            observedAt: Date.now(),
          });
        }
    throw new OperatorApiError(404, "not-found");
  }
  private commentPolicy(taskId: string) {
    const task = this.requireTask(taskId),
      source = this.identity(taskId),
      policy = this.service.delivery().configuration(String(task.projectId)),
      grant = source
        ? policy.grants.find(
            (g) =>
              g.action === "issue.comment" &&
              g.repositoryId === source.repositoryId,
          )
        : undefined,
      held =
        this.service.taskHold(taskId) ||
        !this.domain().admission(taskId).eligible ||
        this.service.delivery().actionBlockers(taskId).length;
    // The first reason that applies, in the order `reason` reports them.
    const reasonCode: CommentReasonCode | null = !source
      ? "no-source-issue"
      : !grant
        ? "no-comment-grant"
        : held
          ? "held"
          : policy.credentialRef === null
            ? "no-delivery-credential"
            : null;
    return {
      available: Boolean(source && grant && !held),
      mode: grant?.mode ?? null,
      reason: !source
        ? "Task has no bound GitHub issue"
        : !grant
          ? "No project grant for issue comments"
          : held
            ? "Task admission or delivery is held"
            : null,
      // `available` stays true without a delivery credential (the CLI reports it at send time);
      // the code lets the web refuse the send instead.
      reasonCode,
    };
  }
  /** Whether the operator can improve and edit the issue, with the newest such edit. */
  private issueEditPolicy(
    taskId: string,
    excluded: readonly string[] | undefined,
  ) {
    const { available, reasonCode } =
      this.service.issueEditAvailability(taskId);
    const latest = this.service
      .delivery()
      .actions(taskId)
      .filter(
        (a) =>
          isOperatorDeliveryCaller(a.binding) &&
          a.request.action.kind === "issue.edit",
      )
      .at(-1);
    return {
      available,
      reasonCode,
      reason: reasonCode ? issueEditReasonSentences[reasonCode] : null,
      latest: latest
        ? {
            operationId: latest.operationId,
            state: latest.state,
            reason: this.safe(latest.observation?.reason, excluded),
          }
        : null,
    };
  }
  private editReviewReceipt(
    key: string,
    review: OperatorCommentReview,
    excluded: readonly string[] | undefined,
  ) {
    const action = review.action;
    if (action.kind !== "issue.edit" || !action.expected)
      throw new OperatorApiError(403, "forbidden");
    const text = {
      title: action.fields.title ?? action.expected.title,
      body: action.fields.body ?? action.expected.body,
    };
    // The operator cannot review a replacement of text that would have to be hidden.
    const shown = (value: string) => this.exact(value, excluded, 64_000);
    const current = {
      title: shown(action.expected.title),
      body: shown(action.expected.body),
    };
    const proposed = {
      title: shown(text.title),
      body: shown(text.body),
    };
    if (
      current.title === null ||
      current.body === null ||
      proposed.title === null ||
      proposed.body === null
    )
      throw new OperatorApiError(403, "forbidden");
    return commandReceiptSchema.parse({
      kind: "edit-review",
      key,
      recorded: true,
      taskId: review.taskId,
      reviewId: review.reviewId,
      operationId: review.operationId,
      revision: review.revision,
      materialHash: review.materialHash,
      decision: review.decision,
      current,
      proposed,
      target: action.target,
      taskVersion: review.caller.taskVersion,
      sourceId: review.caller.sourceId,
      sourceRevision: review.caller.sourceRevision,
      sourceDigest: review.caller.sourceDigest,
      policyVersion: review.caller.policyVersion,
    });
  }
  private commentReviewReceipt(
    key: string,
    review: OperatorCommentReview,
    excluded: readonly string[] | undefined,
  ) {
    if (review.action.kind !== "issue.comment")
      throw new OperatorApiError(403, "forbidden");
    return commandReceiptSchema.parse({
      kind: "comment-review",
      key,
      recorded: true,
      taskId: review.taskId,
      reviewId: review.reviewId,
      operationId: review.operationId,
      revision: review.revision,
      materialHash: review.materialHash,
      decision: review.decision,
      body: this.safe(review.action.body, excluded),
      target: review.action.target,
      taskVersion: review.caller.taskVersion,
      sourceId: review.caller.sourceId,
      sourceRevision: review.caller.sourceRevision,
      sourceDigest: review.caller.sourceDigest,
      policyVersion: review.caller.policyVersion,
    });
  }
  private async reviewProjection(
    taskId: string,
    excluded: readonly string[] | undefined,
    selection: {
      resultId?: string | undefined;
      sourceId?: string | undefined;
    } = {},
  ) {
    const read = (() => {
      try {
        return this.service.taskReview().read(taskId, selection);
      } catch {
        throw new OperatorApiError(404, "not-found");
      }
    })();
    return taskReviewReadSchema.parse({
      ...read,
      sources: read.sources.map((source) => ({
        ...source,
        title: this.safe(source.title, excluded),
        body: this.safe(source.body, excluded),
        criteria: source.criteria.map((c) => ({
          ...c,
          text: this.safe(c.text, excluded) ?? "[Content unavailable]",
        })),
      })),
      contexts: read.contexts.map((c) => ({
        ...c,
        brief: this.safe(c.brief, excluded),
      })),
      results: read.results.map((result) => ({
        ...result,
        metadata: {
          ...result.metadata,
          criteria: result.metadata.criteria.map((c) => ({
            ...c,
            scope: this.safe(c.scope, excluded) ?? "[Content unavailable]",
            provenance:
              this.safe(c.provenance, excluded) ?? "[Content unavailable]",
          })),
          validations: result.metadata.validations.map((v) => ({
            ...v,
            label: this.safe(v.label, excluded) ?? "[Content unavailable]",
            scope: this.safe(v.scope, excluded) ?? "[Content unavailable]",
            provenance:
              this.safe(v.provenance, excluded) ?? "[Content unavailable]",
          })),
          decisions: result.metadata.decisions.map((d) => ({
            text: this.safe(d.text, excluded) ?? "[Content unavailable]",
            attribution:
              this.safe(d.attribution, excluded) ?? "[Content unavailable]",
          })),
          ...(result.metadata.changes
            ? {
                changes: {
                  ...result.metadata.changes,
                  files: result.metadata.changes.files.map(
                    (file) =>
                      this.safe(file, excluded) ?? "[Content unavailable]",
                  ),
                  ...(result.metadata.changes.diff
                    ? {
                        diff:
                          this.safe(result.metadata.changes.diff, excluded) ??
                          "[Content unavailable]",
                      }
                    : {}),
                  reference:
                    result.metadata.changes.reference &&
                    ["http:", "https:"].includes(
                      new URL(result.metadata.changes.reference).protocol,
                    ) &&
                    this.disclosable(
                      result.metadata.changes.reference,
                      excluded,
                    )
                      ? result.metadata.changes.reference
                      : undefined,
                  findings: result.metadata.changes.findings.map((f) => ({
                    ...f,
                    finding:
                      this.safe(f.finding, excluded) ?? "[Content unavailable]",
                  })),
                },
              }
            : {}),
          artifacts: result.metadata.artifacts.map((artifact) => {
            const { file: _file, url, ...rest } = artifact;
            return {
              ...rest,
              label:
                this.safe(artifact.label, excluded) ?? "Content unavailable",
              availability:
                excluded === undefined ||
                !this.disclosable(artifact.label, excluded)
                  ? "redacted"
                  : artifact.availability,
              ...(url && this.disclosable(url, excluded) ? { url } : {}),
            };
          }),
        },
      })),
    });
  }
  private deliveryProjection(
    taskId: string,
    excluded: readonly string[] | undefined,
  ) {
    const v = this.service.delivery().publicTask(taskId),
      b = v.binding;
    // The source's name is the PR's repository name only when `githubPullUrl` verifies it is the PR's own.
    const source =
      b || v.branches.length ? this.sourceSummary(taskId, excluded) : null;
    const url = b
      ? githubPullUrl(
          source?.repositoryName ?? null,
          source?.identity.repositoryId ?? null,
          b.observation.repositoryId,
          b.observation.number,
        )
      : null;
    return deliveryReadSchema.parse({
      mode: v.mode,
      policyVersion: v.policyVersion,
      blockers: v.blockers.slice(0, 128),
      omittedBlockerCount: Math.max(0, v.blockers.length - 128),
      omittedActionCount: Math.max(0, v.actions.length - 128),
      branches: v.branches.slice(0, 20).map((r) => ({
        repositoryName:
          source?.identity.repositoryId === r.repositoryId
            ? (source.repositoryName ?? r.repositoryId)
            : r.repositoryId,
        branch: this.safe(r.branch, excluded),
        lastPushedSha: r.lastPushedSha,
        outsideHeadSha: r.outsideHeadSha,
      })),
      binding: b
        ? {
            revision: b.revision,
            number: b.observation.number,
            repositoryName: url
              ? (source?.repositoryName ?? b.observation.repositoryId)
              : b.observation.repositoryId,
            ...(url ? { url } : {}),
            draft: b.observation.draft,
            headSha: b.observation.headSha,
            state: b.observation.state,
            observedAt: b.observedAt,
            readError: this.safe(b.readError, excluded),
            omittedCheckCount: Math.max(0, b.observation.checks.length - 128),
            omittedFeedbackCount: Math.max(
              0,
              (b.observation.feedback?.length ?? 0) - 128,
            ),
            checks: b.observation.checks.slice(0, 128).map((c) => ({
              name: this.safe(c.name, excluded),
              sha: c.sha,
              status: c.status,
            })),
            feedback: (b.observation.feedback ?? []).slice(0, 128).map((f) => ({
              ...f,
              author: this.safe(f.author, excluded),
              body: this.safe(f.body, excluded),
              commitSha: f.commitSha,
            })),
          }
        : null,
      actions: v.actions.slice(-128).map((a) => ({
        operationId: a.operationId,
        kind: a.kind,
        state: a.state,
        reason: this.safe(a.reason, excluded),
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
    });
  }
  async readReview(
    taskId: string,
    selection: {
      resultId?: string | undefined;
      sourceId?: string | undefined;
    } = {},
  ) {
    const visibility = this.visibilityToken();
    const workspaceVisibility = this.service.taskWorkspaceVisibility(taskId);
    const t = this.requireTask(taskId),
      excluded = await this.exclusions(String(t.projectId), taskId);
    const data = await this.reviewProjection(taskId, excluded, selection);
    if (
      visibility !== this.visibilityToken() ||
      workspaceVisibility !== this.service.taskWorkspaceVisibility(taskId) ||
      this.requireTask(taskId).version !== t.version
    )
      throw new OperatorApiError(503, "unavailable");
    return reviewReadSchema.parse({
      data,
      observedAt: Date.now(),
    });
  }
  async readSearch(params: URLSearchParams) {
    const visibility = this.visibilityToken();
    const query = searchQuerySchema.parse(Object.fromEntries(params));
    if (query.projectId) this.requireProject(query.projectId);
    if (
      query.cursor &&
      !this.service.taskReview().hasSearchRecord(query.cursor)
    )
      throw new OperatorApiError(409, "conflict");
    const rows = await this.service.taskReview().search(query);
    if (visibility !== this.visibilityToken())
      throw new OperatorApiError(503, "unavailable");
    const page = rows.slice(0, query.limit),
      matches = [],
      versions = new Map<string, number>(),
      workspaceVisibilities = new Map<string, string>(),
      base = this.exclusionBase();
    let omittedCount = 0;
    for (const row of page) {
      try {
        const taskId = String(row.taskId),
          t = this.requireTask(taskId),
          p = this.requireProject(String(t.projectId)),
          workspaceVisibility = this.service.taskWorkspaceVisibility(taskId),
          snapshot = workspaceVisibilities.get(taskId) ?? workspaceVisibility;
        workspaceVisibilities.set(taskId, snapshot);
        const excluded = await this.exclusions(
            String(t.projectId),
            taskId,
            [],
            [],
            base,
          ),
          view = this.coordination().readTask(taskId),
          resultId = row.resultId === null ? null : String(row.resultId),
          sourceId = row.sourceId === null ? null : String(row.sourceId),
          source = sourceId
            ? this.service.taskReview().source(taskId, sourceId)
            : undefined,
          reviewResult = resultId
            ? this.service.taskReview().result(taskId, resultId)
            : undefined,
          decision =
            row.type === "decision"
              ? reviewResult?.metadata.decisions.find(
                  (_, position) =>
                    row.recordId === `${resultId}:decision:${position}`,
                )
              : undefined,
          retained = resultId
            ? view.results.some((r) => r.resultId === resultId)
            : source !== undefined;
        const current = this.requireTask(taskId);
        if (
          current.version !== t.version ||
          current.projectId !== t.projectId ||
          (query.projectId && current.projectId !== query.projectId)
        )
          throw new OperatorApiError(503, "unavailable");
        if (snapshot !== this.service.taskWorkspaceVisibility(taskId)) {
          omittedCount++;
          continue;
        }
        const excerpt = this.safe(row.excerpt, excluded);
        if (
          !retained ||
          excerpt === null ||
          excerpt !== row.excerpt ||
          (row.type === "decision" &&
            (!decision ||
              excerpt !==
                `${decision.attribution}: ${decision.text}`.slice(0, 16000) ||
              (reviewResult?.metadata.sourceId ?? null) !== sourceId ||
              [decision.attribution, decision.text].some(
                (value) => !this.disclosable(value, excluded),
              ))) ||
          (source &&
            [source.title, source.body].some(
              (value) => value !== null && !this.disclosable(value, excluded),
            ))
        ) {
          omittedCount++;
          continue;
        }
        const historical = resultId
          ? view.results.at(-1)?.resultId !== resultId
          : this.service.taskReview().sources(taskId).at(-1)?.sourceId !==
            sourceId;
        versions.set(taskId, Number(t.version));
        matches.push({
          recordId: row.recordId,
          type: row.type,
          taskId,
          projectId: String(t.projectId),
          projectName: this.safe(p.name, excluded),
          taskTitle: this.safe(t.title, excluded),
          sourceId,
          resultId,
          excerpt,
          createdAt: Number(row.createdAt),
          historical,
          href: `/app/tasks/${taskId}?section=${row.type === "task" ? "brief" : "review"}&record=${encodeURIComponent(String(row.recordId))}${resultId ? `&result=${resultId}` : ""}${sourceId ? `&source=${sourceId}` : ""}`,
        });
      } catch (error) {
        if (error instanceof OperatorApiError) {
          omittedCount++;
          continue;
        }
        throw error;
      }
    }
    if (visibility !== this.visibilityToken())
      throw new OperatorApiError(503, "unavailable");
    const eligibleRecords = new Set(
      (await this.service.taskReview().search(query)).map(
        (row) => row.recordId,
      ),
    );
    if (visibility !== this.visibilityToken())
      throw new OperatorApiError(503, "unavailable");
    const permitted = matches.filter((m) => {
      try {
        const current = this.requireTask(m.taskId);
        if (
          Number(current.version) !== versions.get(m.taskId) ||
          workspaceVisibilities.get(m.taskId) !==
            this.service.taskWorkspaceVisibility(m.taskId) ||
          String(current.projectId) !== m.projectId ||
          (query.projectId && String(current.projectId) !== query.projectId)
        )
          return false;
        this.requireProject(m.projectId);
        if (!eligibleRecords.has(m.recordId)) return false;
        const currentRecord = this.service
          .taskReview()
          .isCurrentSearchRecord(m.taskId, m.sourceId, m.resultId);
        m.historical = !currentRecord;
        return query.historical || currentRecord;
      } catch {
        return false;
      }
    });
    return searchReadSchema.parse({
      data: {
        matches: permitted,
        nextCursor:
          rows.length > query.limit ? String(page.at(-1)?.recordId) : null,
        coverage: "retained-records-only",
        omittedCount: omittedCount + matches.length - permitted.length,
      },
      observedAt: Date.now(),
    });
  }
  async readArtifact(taskId: string, artifactId: string) {
    uuid.parse(artifactId);
    this.requireTask(taskId);
    const owner = this.service.taskReview().artifactOwner(taskId, artifactId);
    if (owner) {
      const manifest = this.service
        .retainedEvidence()
        .result(taskId, owner.resultId);
      if (manifest) {
        const item = manifest.items.find(
          (candidate) => candidate.artifactId === artifactId,
        );
        if (item?.state !== "available" || item.source !== "artifact-file")
          throw new OperatorApiError(503, "unavailable");
        const response = await this.readRetainedEvidenceItem(
          taskId,
          owner.resultId,
          item.itemId,
        );
        const data = response.data;
        if (
          data.state !== "available" ||
          data.item.artifactId !== artifactId ||
          data.item.source !== "artifact-file"
        )
          throw new OperatorApiError(503, "unavailable");
        const body =
          data.preview.kind === "text"
            ? Buffer.from(data.preview.text, "utf8")
            : Buffer.from(data.preview.data, "base64");
        if (
          body.byteLength !== data.item.size ||
          createHash("sha256").update(body).digest("hex") !== data.item.sha256
        )
          throw new OperatorApiError(503, "unavailable");
        return {
          body,
          type: data.preview.mime,
          source: "retained" as const,
          sha256: data.item.sha256,
        };
      }
    }
    try {
      const file = await previewRecordedArtifact(async () => {
        const visibility = this.visibilityToken();
        const workspaceVisibility =
          this.service.taskWorkspaceVisibility(taskId);
        const t = this.requireTask(taskId),
          excluded = await this.exclusions(String(t.projectId), taskId),
          workspace = await this.service.taskWorkspace(taskId);
        const current = this.requireTask(taskId),
          record = this.service.taskReview().artifactOwner(taskId, artifactId),
          artifact = record?.metadata.artifacts.find(
            (a) => a.artifactId === artifactId,
          );
        if (
          visibility !== this.visibilityToken() ||
          workspaceVisibility !==
            this.service.taskWorkspaceVisibility(taskId) ||
          !workspace ||
          workspace.state !== "ready" ||
          !record ||
          !artifact ||
          excluded === undefined ||
          !this.disclosable(artifact.label, excluded)
        )
          return undefined;
        return {
          artifact,
          workspace: workspace.path,
          identity: JSON.stringify({
            taskId,
            taskVersion: current.version,
            workspaceVisibility,
            workspaceId: workspace.workspaceId,
            workspaceState: workspace.state,
            resultId: record.resultId,
            workId: record.workId,
            workRevision: record.workRevision,
            artifact,
            excluded,
          }),
        };
      });
      return {
        ...file,
        source: "recorded-workspace" as const,
        sha256: createHash("sha256").update(file.body).digest("hex"),
      };
    } catch (error) {
      if (error instanceof OperatorApiError) throw error;
      throw new OperatorApiError(
        error instanceof ArtifactUnavailable && error.reason === "mismatch"
          ? 409
          : 404,
        error instanceof ArtifactUnavailable && error.reason === "mismatch"
          ? "conflict"
          : "not-found",
      );
    }
  }
  /** Bounded, informational list of assignments bound to a project or profile. */
  readConfigurationImpact(
    kind: "project" | "profile",
    targetId: string,
    query: URLSearchParams,
  ) {
    if (
      [...query.keys()].some((k) => k !== "limit") ||
      query.getAll("limit").length > 1
    )
      throw new OperatorApiError(400, "invalid-input");
    const raw = query.get("limit");
    const limit = raw === null ? 200 : Number(raw);
    if (!/^[0-9]{1,3}$/.test(raw ?? "200") || limit < 1 || limit > 200)
      throw new OperatorApiError(400, "invalid-input");
    if (!uuid.safeParse(targetId).success)
      throw new OperatorApiError(400, "invalid-input");
    return this.readWithExclusionFence(async () => {
      const d = this.domain();
      if (kind === "project") this.requireProject(targetId);
      else if (!d.profiles().some((p) => p.id === targetId))
        throw new OperatorApiError(404, "not-found");
      const { rows, total } = d.assignmentsBoundTo(
        kind === "project" ? "projectId" : "profileId",
        targetId,
        limit + 1,
      );
      return configurationImpactSchema.parse({
        data: {
          target: { kind, id: targetId },
          assignments: rows.slice(0, limit).map((r) => ({
            assignmentId: String(r.id),
            taskId: String(r.taskId),
            projectId: String(r.projectId),
            profileId: String(r.profileId),
            state: r.state,
            lead: Boolean(r.lead),
            bound: {
              profileRevision: Number(r.profileRevision),
              instructionsRevision: Number(r.instructionsRevision),
            },
            current: {
              profileRevision: Number(r.currentProfileRevision),
              instructionsRevision: Number(r.currentInstructionsRevision),
            },
            stale: {
              profile: r.profileRevision !== r.currentProfileRevision,
              instructions:
                r.instructionsRevision !== r.currentInstructionsRevision,
            },
          })),
          total,
          truncated: total > limit,
          limit,
        },
        observedAt: Date.now(),
      });
    });
  }
  /** Reads back one configuration, adoption or source receipt by scope, type and key. */
  async readOperation(query: URLSearchParams) {
    const names = ["scope", "type", "key"];
    if (
      [...query.keys()].some((k) => !names.includes(k)) ||
      names.some((k) => query.getAll(k).length !== 1)
    )
      throw new OperatorApiError(400, "invalid-input");
    const scope = operationScopeSchema.safeParse(query.get("scope")),
      type = operationTypeSchema.safeParse(query.get("type")),
      key = uuid.safeParse(query.get("key"));
    if (!scope.success || !type.success || !key.success)
      throw new OperatorApiError(400, "invalid-input");
    const [kind, id = ""] = scope.data.split(":");
    if (isRecoveryType(type.data)) {
      if (kind !== "assignment")
        throw new OperatorApiError(400, "invalid-input");
      try {
        return operationReadSchema.parse({
          data: readRecoveryOperation(this.service, type.data, key.data, id),
          observedAt: Date.now(),
        });
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof SyntaxError)
          throw new OperatorApiError(409, "conflict");
        throw error;
      }
    }
    const expected =
      type.data === "capacity.configure" || type.data === "runtime.configure"
        ? "system"
        : type.data.startsWith("profile.")
          ? "profile"
          : "project";
    if (kind !== expected) throw new OperatorApiError(400, "invalid-input");
    // Domain receipt scopes: the bare project ID, `profile:<id>`, `system:capacity`.
    const receiptType =
      type.data === "github.preview" ? "github.activate" : type.data;
    let data: unknown = { state: "not-recorded" };
    try {
      if (
        (type.data === "runtime.configure") !==
        scope.data.startsWith("system:runtime:")
      )
        throw new OperatorApiError(400, "invalid-input");
      const raw = this.domain().recordedResult(
        kind === "project" ? id : scope.data,
        key.data,
        receiptType,
      );
      if (raw !== undefined) {
        const receipt = commandReceipt(raw, key.data, id);
        // A selection ID is operator text; disclose it only as the POST receipt does.
        if (
          receipt.kind === "configuration" &&
          receipt.result.commandType === "github.preview" &&
          !this.disclosable(
            receipt.result.selectionId,
            await this.exclusions(id),
          )
        )
          throw new OperatorApiError(503, "unavailable");
        data = { state: "recorded", receipt };
      }
    } catch (error) {
      if (
        error instanceof ReceiptShapeError ||
        error instanceof CommandResultValidationError
      )
        throw new OperatorApiError(409, "conflict");
      throw error;
    }
    return operationReadSchema.parse({ data, observedAt: Date.now() });
  }
  async readProfileConfiguration(profileId: string) {
    uuid.parse(profileId);
    const row = this.domain()
      .profiles()
      .find((p) => p.id === profileId);
    if (!row) throw new OperatorApiError(404, "not-found");
    const runtime = this.domain().profileRuntime(profileId);
    const excluded = await this.exclusions();
    return profileConfigurationSchema.parse({
      data: {
        profile: {
          ...this.profiles(excluded).find((p) => p.id === profileId),
          name: this.exact(row.name, excluded),
          summary: this.exact(row.summary, excluded),
        },
        instructionPresent: Boolean(row.instructions),
        instructionRevision: Number(row.version),
        capabilities: this.safe(row.capabilities, excluded),
        runtime,
      },
      observedAt: Date.now(),
    });
  }
  /** Exact private text for a signed-in web session only; nothing here is logged, recorded or redacted. */
  readProjectPrivateValues(
    projectId: string,
    context?: OperatorReviewSessionContext,
  ) {
    this.requireReviewSession(context);
    const p = this.requireProject(projectId),
      d = this.domain(),
      r = d.routing(projectId),
      g = d.githubConfiguration(projectId);
    return projectPrivateValuesSchema.parse({
      data: {
        project: {
          version: Number(p.version),
          instructionsRevision: Number(p.instructionsRevision),
          instructions: String(p.instructions),
        },
        routing: { version: Number(r.version), guidance: String(r.guidance) },
        source: {
          version: g.version,
          searches: g.selections.flatMap((s) =>
            s.kind === "search" ? [{ id: s.id, query: s.query }] : [],
          ),
          repositories: g.repositories.map((x) => ({
            repositoryId: x.repositoryId,
            path: x.path,
          })),
        },
      },
      observedAt: Date.now(),
    });
  }
  readProfilePrivateValues(
    profileId: string,
    context?: OperatorReviewSessionContext,
  ) {
    this.requireReviewSession(context);
    uuid.parse(profileId);
    const row = this.domain()
      .profiles()
      .find((p) => p.id === profileId);
    if (!row) throw new OperatorApiError(404, "not-found");
    return profilePrivateValuesSchema.parse({
      data: {
        profile: {
          version: Number(row.version),
          instructions: String(
            this.domain().profileRevision(profileId, Number(row.version))
              .instructions,
          ),
        },
      },
      observedAt: Date.now(),
    });
  }
  async readProjectConfiguration(projectId: string) {
    return this.readWithSourceFence(
      () => this.readProjectConfigurationOnce(projectId),
      projectId,
    );
  }
  private async readProjectConfigurationOnce(projectId: string) {
    const p = this.requireProject(projectId),
      d = this.domain(),
      g = d.githubConfiguration(projectId),
      credential = await this.service.gitHubSourceCredentialStatus(projectId),
      excluded = await this.exclusions(projectId),
      r = d.routing(projectId),
      active = d.githubActiveSelectionIds(projectId);
    return projectConfigurationSchema.parse({
      data: {
        project: {
          ...this.project(p, excluded),
          name: this.exact(p.name, excluded),
        },
        profiles: this.profiles(excluded),
        instructionsRevision: Number(p.instructionsRevision),
        instructionPresent: Boolean(p.instructions),
        diagnosticCapture: d.diagnosticCaptureMode(projectId),
        commandNetworkAccess: d.commandNetworkAccess(projectId),
        placements: this.service
          .githubSources()
          .conflicts()
          .filter((c) => c.projectIds.includes(projectId))
          .map((c) => {
            const task = d.task(c.taskId);
            return {
              taskId: c.taskId,
              projectId: String(task.projectId),
              version: Number(task.version),
              title: this.safe(task.title, excluded),
              choices: c.projectIds.map((id) =>
                this.project(d.project(id), excluded),
              ),
            };
          }),
        routing: {
          version: Number(r.version),
          enabled: Boolean(r.enabled),
          candidateProfileIds: JSON.parse(String(r.candidateProfileIds)),
          credentialConfigured:
            d.routingCredentialReference(projectId) !== null,
          availability:
            this.service.routingAvailability(projectId).reason ?? "available",
        },
        source: {
          version: g.version,
          credentialConfigured: g.credentialRef !== null,
          credential,
          selections: g.selections.map((s) => ({
            id: this.exact(s.id, excluded),
            kind: s.kind,
            descriptor: this.safe(
              s.kind === "repository"
                ? `${s.owner}/${s.name}`
                : s.kind === "project"
                  ? s.projectNodeId
                  : null,
              excluded,
            ),
            active: active.includes(s.id),
          })),
          readiness: this.readinessRuleView(g.readiness, excluded),
          closedIssues: g.closedIssues,
          repositories: g.repositories.map((r) => ({
            repositoryId: this.safe(r.repositoryId, excluded),
            ref: this.safe(r.ref, excluded),
          })),
        },
      },
      observedAt: Date.now(),
    });
  }
  async readRuntimeSettings() {
    return this.readWithExclusionFence(() => this.readRuntimeSettingsOnce());
  }
  private async readRuntimeSettingsOnce() {
    const d = this.domain(),
      projects = d.projects(),
      taskRows = new Map(
        projects.map((p) => [String(p.id), d.tasks(String(p.id))]),
      ),
      snapshot = this.workspaceSnapshot(
        [...taskRows.values()].flatMap((rows) => rows.map((t) => String(t.id))),
      ),
      base = this.exclusionBase(),
      excluded = await this.exclusions(undefined, undefined, [], [], base),
      limits = this.service.capacityLimits(projects.map((p) => String(p.id)));
    const response = {
      data: {
        runtimes: this.service.runtimeSettings(),
        globalLimit: limits.globalLimit,
        defaultProjectLimit: limits.defaultProjectLimit,
        globalUsage: limits.currentUsage.global,
        projects: await Promise.all(
          projects.map(async (p) => {
            const id = String(p.id);
            return {
              project: this.project(p, excluded),
              limit: limits.effectiveProjectLimits[id],
              usage: limits.currentUsage.projects[id] ?? 0,
              override: limits.projectOverrides[id] ?? null,
              tasks: await Promise.all(
                (taskRows.get(id) ?? []).map(async (t) => {
                  const taskId = String(t.id),
                    assignments = d.assignments(taskId),
                    known = new Set(assignments.map((a) => String(a.id))),
                    taskExcluded = await this.exclusions(
                      id,
                      taskId,
                      [],
                      [],
                      base,
                    );
                  const records = this.service
                    .recoveryForTask(taskId)
                    .filter(
                      (r) =>
                        r.binding?.taskId === taskId &&
                        known.has(r.binding.assignmentId),
                    );
                  return {
                    taskId,
                    title: this.safe(t.title, taskExcluded),
                    paused: Boolean(p.paused),
                    held:
                      this.service.taskHold(taskId) !== undefined ||
                      records.some(
                        (r) =>
                          r.holds.stop ||
                          r.holds.writer ||
                          r.holds.capacity ||
                          r.holds.uncertainty ||
                          r.holds.task !== null,
                      ),
                    assignments: assignments.map((a) => ({
                      assignmentId: String(a.id),
                      name: this.safe(
                        d.profile(String(a.profileId)).name,
                        taskExcluded,
                      ),
                    })),
                  };
                }),
              ),
            };
          }),
        ),
      },
      observedAt: Date.now(),
    };
    this.requireWorkspaceSnapshot(snapshot);
    return runtimeSettingsSchema.parse(response);
  }
  async readAssignmentRecovery(assignmentId: string) {
    return this.readWithExclusionFence(() =>
      this.readAssignmentRecoveryOnce(assignmentId, "task-wide"),
    );
  }
  /** The exact identity and advisory eligibility each recovery command needs. */
  async readRecoveryOptions(assignmentId: string) {
    return this.readWithExclusionFence(async () => {
      const base = await this.readAssignmentRecoveryOnce(
        assignmentId,
        "selected-assignment",
      );
      const { projectId } = this.requireAssignment(assignmentId);
      const excluded = await this.exclusions(projectId, base.data.taskId);
      return recoveryOptions(this.service, base, projectId, excluded, (v) =>
        this.exact(v, excluded),
      );
    });
  }
  /** Shared verified record projection with an explicit recovery hold scope. */
  private async readAssignmentRecoveryOnce(
    assignmentId: string,
    holdScope: RecoveryHoldScope,
  ) {
    const d = this.domain(),
      { taskId, projectId } = this.requireAssignment(assignmentId),
      snapshot = this.workspaceSnapshot([taskId]),
      task = await this.readTask(taskId),
      assignment = task.data.assignments.find(
        (a) => a.assignmentId === assignmentId,
      );
    if (!assignment) throw new OperatorApiError(404, "not-found");
    const selected = this.selection(d.assignment(assignmentId)).request,
      known = new Set(d.assignments(taskId).map((a) => String(a.id))),
      excluded = await this.exclusions(projectId, taskId);
    const taskRecords = this.service
      .recoveryForTask(taskId, selected?.workId)
      .filter((r) =>
        r.binding
          ? r.binding.taskId === taskId &&
            known.has(r.binding.assignmentId) &&
            uuid.safeParse(r.binding.assignmentId).success
          : selected?.workId === r.workId &&
            selected.assignmentId === assignmentId &&
            selected.taskId === taskId &&
            r.request?.assignmentId === assignmentId,
      );
    const records = taskRecords.filter(
      (r) => !r.binding || r.binding.assignmentId === assignmentId,
    );
    const holdRecords = holdScope === "task-wide" ? taskRecords : records;
    const taskHold = this.service.taskHold(taskId);
    const holds = {
      stop:
        this.service.isTaskStopped(taskId) ||
        taskRecords.some((r) => r.holds.stop),
      writer: holdRecords.some((r) => r.holds.writer),
      capacity: holdRecords.some((r) => r.holds.capacity),
      uncertainty: holdRecords.some((r) => r.holds.uncertainty),
      task:
        taskHold !== undefined ||
        taskRecords.some((r) => r.holds.task !== null),
    };
    const visible = records.slice(-20);
    const intentStates = new Set<string>(executionIntentStateSchema.options),
      requestStates = new Set(["queued", "active", "completed", "held"]);
    this.requireWorkspaceSnapshot(snapshot);
    return assignmentRecoverySchema.parse({
      data: {
        assignment,
        taskId,
        project:
          task.data.task.projectId === projectId
            ? this.project(d.project(projectId), excluded)
            : null,
        held: Object.values(holds).some(Boolean),
        holds,
        evidenceAvailable: records.length > 0,
        omittedCount: records.length - visible.length,
        records: visible.map((r) => ({
          workId: this.safe(r.workId, excluded),
          generation: r.generation,
          binding: r.binding
            ? {
                assignmentId: r.binding.assignmentId,
                assignmentVersion: r.binding.assignmentVersion,
                instructionsRevision: r.binding.instructionsRevision,
                profileRevision: r.binding.profileRevision,
              }
            : null,
          intentState: intentStates.has(r.intent.state)
            ? r.intent.state
            : "unknown",
          requestState: r.request
            ? requestStates.has(r.request.state)
              ? r.request.state
              : "unknown"
            : null,
          holds: {
            stop: r.holds.stop,
            writer: r.holds.writer,
            capacity: r.holds.capacity,
            uncertainty: r.holds.uncertainty,
            task: r.holds.task !== null,
          },
          observations: [
            ...new Set(
              r.observations.map((o) => {
                const parsed = recoveryObservationSchema.safeParse(o.kind);
                return parsed.success ? parsed.data : "unknown";
              }),
            ),
          ],
          pendingEffectCount: r.pendingEffects.length,
          ...(r.noTurnSubmission
            ? { noTurnSubmission: r.noTurnSubmission }
            : {}),
          ...(r.preTurnRejection
            ? {
                preTurnRejection: {
                  ...r.preTurnRejection,
                  predecessorThreadId: this.safe(
                    r.preTurnRejection.predecessorThreadId,
                    excluded,
                  ),
                },
              }
            : {}),
          receiptRecorded: r.receipt !== null,
          workspace:
            r.receipt?.workspaceDisposition === "preserved"
              ? "preserved"
              : r.receipt?.workspaceDisposition === "reconciled"
                ? "reconciled"
                : "unknown",
        })),
      },
      observedAt: Date.now(),
    });
  }
  async readSourceObservations() {
    return this.readWithSourceFence(() => this.readSourceObservationsOnce());
  }
  private async readSourceObservationsOnce() {
    const d = this.domain();
    const pending = d.projects();
    const scope = new GhLoginScope();
    const projects: {
      projectId: string;
      credential: Awaited<
        ReturnType<StandaloneService["gitHubSourceCredentialStatus"]>
      >;
    }[] = new Array(pending.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (next < pending.length) {
          const index = next++;
          const projectId = String(pending[index]!.id);
          projects[index] = {
            projectId,
            credential: await this.service.gitHubSourceCredentialStatus(
              projectId,
              scope,
            ),
          };
        }
      }),
    );
    const excluded = await this.exclusions();
    return sourceObservationSchema.parse({
      data: {
        projects: projects.map(({ projectId, credential }) => {
          const readiness = this.readinessRuleView(
              this.service.githubSources().readinessRule(projectId),
              excluded,
            ),
            counted = this.service.githubSources().selectionCounts(projectId);
          return {
            projectId,
            credential,
            readiness,
            selections: d.githubConfiguration(projectId).selections.map((s) => {
              const store = this.service.githubSources(),
                sync = store.syncState(projectId, s.id);
              const at =
                sync?.refreshedAt === undefined
                  ? null
                  : String(sync.refreshedAt);
              const state =
                excluded === undefined || !credential.usable
                  ? "unavailable"
                  : sync
                    ? sync.complete
                      ? "complete"
                      : "partial"
                    : "never";
              // Counts only for stored reads; never and unavailable claim nothing.
              const counts =
                state === "complete" || state === "partial"
                  ? (counted.get(s.id) ?? null)
                  : null;
              return {
                selectionId: this.safe(s.id, excluded),
                state,
                credentialReason: credential.reason,
                lastAttemptAt: at,
                lastSuccessfulAt:
                  sync?.complete && credential.usable ? at : null,
                counts: counts && {
                  ...counts,
                  matching:
                    readiness.kind === "unavailable" ? null : counts.matching,
                },
              };
            }),
          };
        }),
      },
      observedAt: Date.now(),
    });
  }
  async refreshSources() {
    await this.service.refreshGitHub();
    return this.readSourceObservations();
  }
  private async previewGitHubSelection(
    c: Extract<
      z.infer<typeof operatorCommandSchema>,
      { type: "github.preview" }
    >,
  ) {
    const command = {
      ...c,
      type: "github.activate" as const,
      actor: "operator" as const,
    };
    let raw = this.domain().recordedCommand(command);
    if (raw === undefined) {
      const config = this.domain().githubConfiguration(c.projectId);
      if (config.version !== c.expectedVersion)
        throw new DomainConflictError("Preview configuration conflict");
      if (!config.credentialRef) {
        this.service.githubSources().invalidateCredentialFailure(
          {
            projectId: c.projectId,
            configVersion: config.version,
            credentialRef: config.credentialRef,
          },
          "missing-credential",
        );
        throw new OperatorApiError(
          409,
          "conflict",
          ["credentialRef"],
          "missing-credential",
        );
      }
      const selection = config.selections.find((s) => s.id === c.selectionId);
      if (!selection) throw new DomainConflictError("Unknown GitHub selection");
      const preview = await this.previewReader(
        config.credentialRef,
      ).readSelection(selection);
      if (!preview.complete) {
        if (
          [
            "missing-credential",
            "invalid-credential-reference",
            "gh-not-installed",
            "gh-not-signed-in",
            "gh-unreadable",
          ].includes(preview.reason)
        ) {
          this.service.githubSources().invalidateCredentialFailure(
            {
              projectId: c.projectId,
              configVersion: config.version,
              credentialRef: config.credentialRef,
            },
            preview.reason as SourceCredentialReason,
          );
          throw new OperatorApiError(
            409,
            "conflict",
            ["credentialRef"],
            preview.reason as SourceCredentialReason,
          );
        }
        throw new DomainConflictError("Preview incomplete");
      }
      raw = await this.executeDomain(command);
    }
    const excluded = await this.exclusions(c.projectId);
    if (!this.disclosable(c.selectionId, excluded))
      throw new Error("Receipt unavailable");
    return commandReceipt(
      parseDomainCommandOutcome("github.activate", raw),
      c.key,
      c.projectId,
    );
  }
  private home() {
    return this.setup.home ?? homedir();
  }
  /**
   * The home folder for Add Claude's suggested token path, for a signed-in session only: the
   * absolute path is local-path data, so it is never recorded, logged or placed in a bearer read.
   * Null when the suggested reference would not pass the `claude-token.configure` input.
   */
  readSetupHome(context?: OperatorReviewSessionContext) {
    this.requireReviewSession(context);
    const raw = this.home();
    const home = isAbsolute(raw) ? resolve(raw) : "";
    const usable =
      home !== "" &&
      operatorCommandSchema.safeParse({
        type: "claude-token.configure",
        key: randomUUID(),
        credentialRef: `file:${home}/.ensemble/claude/claude-token`,
      }).success;
    return setupHomeSchema.parse({
      data: { home: usable ? home : null },
      observedAt: Date.now(),
    });
  }
  readClaudeTokenStatus() {
    return claudeTokenStatusSchema.parse({
      data: this.service.claudeTokenStatus(),
      observedAt: Date.now(),
    });
  }
  private gh(): GhOptions {
    return {
      executable: this.setup.ghExecutable,
      environment: ghEnvironment(this.domain()),
    };
  }
  /**
   * Detects the `gh` login on every read, so the choice is offered even when unconfigured.
   * `sourceGh` is the login a new project's `gh:github.com` source would use, detected in
   * that source environment (`GH_TOKEN`/`GITHUB_TOKEN` overrides included); status only.
   */
  async readDiscoveryStatus() {
    const ref = this.domain().discoveryCredentialReference();
    const scope = new GhLoginScope();
    const [gh, sourceGh] = await Promise.all([
      scope.detect(this.gh()),
      scope.detect({
        executable: this.setup.ghExecutable,
        environment: ghEnvironment(this.domain(), {
          reference: "gh:github.com",
        }),
      }),
    ]);
    const source = ref === null ? null : ref.startsWith("gh:") ? "gh" : "env";
    return discoveryStatusSchema.parse({
      data: {
        configured: ref !== null,
        available:
          source === "gh"
            ? gh.state === "signed-in"
            : ref !== null && Boolean(process.env[ref.slice(4)]),
        source,
        gh,
        sourceGh,
      },
      observedAt: Date.now(),
    });
  }
  /**
   * What a discovery result was read with: an `env:` reference and a digest of its value, or
   * a `gh:` reference alone (an account switch during one read is not detected).
   */
  private discoveryFence() {
    const ref = this.domain().discoveryCredentialReference();
    if (ref?.startsWith("gh:")) return JSON.stringify([ref]);
    return JSON.stringify([
      ref,
      createHash("sha256")
        .update(ref ? (process.env[ref.slice(4)] ?? "") : "")
        .digest("hex"),
    ]);
  }
  /** The reference's token, resolved on every read; a `gh` failure is its reason. */
  private async discoveryToken(ref: string): Promise<string | undefined> {
    if (!ref.startsWith("gh:")) return process.env[ref.slice(4)] || undefined;
    const resolved = await ghToken(this.gh());
    if ("token" in resolved) return resolved.token;
    throw new DiscoveryFailure(`gh-${resolved.state}`);
  }
  /** Run one discovery read; every failure is an `unavailable` reason, never a message. */
  private async discoveryRead<T extends z.ZodType>(
    schema: T,
    read: (reader: DiscoveryReader) => Promise<object>,
  ): Promise<z.infer<T>> {
    let data: object = { state: "unavailable", reason: "unreadable" };
    // A result read with a credential that changed meanwhile is discarded and read once more
    // with the current one; a second change in flight leaves it unavailable.
    for (let attempt = 0; attempt < 2; attempt++) {
      const fence = this.discoveryFence();
      const ref = this.domain().discoveryCredentialReference();
      let current: object;
      if (!ref) current = { state: "unavailable", reason: "unconfigured" };
      else
        try {
          const reader = (
            this.setup.discovery ??
            ((_: string, token: string | undefined) =>
              new GitHubDiscoveryReader(token))
          )(ref, await this.discoveryToken(ref));
          current = { state: "ready", ...(await read(reader)) };
        } catch (error) {
          current = {
            state: "unavailable",
            reason:
              error instanceof DiscoveryFailure ? error.reason : "unreadable",
          };
        }
      if (fence === this.discoveryFence()) {
        data = current;
        break;
      }
    }
    const parsed = schema.safeParse({ data, observedAt: Date.now() });
    return parsed.success
      ? parsed.data
      : schema.parse({
          data: { state: "unavailable", reason: "unreadable" },
          observedAt: Date.now(),
        });
  }
  private discoveryRepository(query: URLSearchParams) {
    const value = query.get("repository") ?? "";
    const match = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(
      value,
    );
    if (
      [...query.keys()].some((k) => k !== "repository") ||
      query.getAll("repository").length !== 1 ||
      !match?.[1] ||
      !match[2] ||
      [match[1], match[2]].some((part) => /^\.{1,2}$/.test(part))
    )
      throw new OperatorApiError(400, "invalid-input");
    return [match[1], match[2]] as const;
  }
  readDiscoveryRepositories() {
    return this.discoveryRead(discoveryRepositoriesSchema, (r) =>
      r.repositories(),
    );
  }
  readDiscoveryBranches(query: URLSearchParams) {
    const [owner, name] = this.discoveryRepository(query);
    return this.discoveryRead(discoveryBranchesSchema, (r) =>
      r.branches(owner, name),
    );
  }
  readDiscoveryProjects(query: URLSearchParams) {
    const [owner, name] = this.discoveryRepository(query);
    return this.discoveryRead(discoveryProjectsSchema, (r) =>
      r.projects(owner, name),
    );
  }
  readDiscoveryProjectFields(query: URLSearchParams) {
    const project = query.get("project") ?? "";
    if (
      [...query.keys()].some((k) => k !== "project") ||
      query.getAll("project").length !== 1 ||
      !/^[A-Za-z0-9_=-]{1,512}$/.test(project)
    )
      throw new OperatorApiError(400, "invalid-input");
    return this.discoveryRead(discoveryProjectFieldsSchema, (r) =>
      r.projectFields(project),
    );
  }
  /** Folder names and Git status under the operator's home folder (authenticated POST only). */
  async listFolders(body: unknown) {
    const input = folderListRequestSchema.parse(body);
    try {
      return folderListingSchema.parse({
        data: await listHomeFolders(this.home(), input),
        observedAt: Date.now(),
      });
    } catch (error) {
      if (error instanceof FolderAccessError)
        throw new OperatorApiError(
          error.status,
          error.status === 400
            ? "invalid-input"
            : error.status === 403
              ? "forbidden"
              : "not-found",
        );
      throw new OperatorApiError(503, "unavailable");
    }
  }
  async verifyCheckout(body: unknown) {
    const input = checkoutVerifyRequestSchema.parse(body);
    return checkoutVerificationSchema.parse({
      data: await verifyCheckout(this.home(), input),
      observedAt: Date.now(),
    });
  }
  private async executeDomain<C extends DomainCommand>(
    c: C,
  ): Promise<DomainCommandResultMap[C["type"]]> {
    try {
      return await this.commands.execute(c);
    } catch (error) {
      const mapped = domainApiError(error);
      if (mapped) throw mapped;
      throw error;
    }
  }
  private requireReviewSession(
    context: OperatorReviewSessionContext | undefined,
  ): OperatorReviewSessionContext {
    // Bearer credentials carry no browser review session: that is a refusal, not a login failure.
    if (!context) throw new OperatorApiError(403, "forbidden");
    if (!context.current()) throw new OperatorApiError(401, "unauthenticated");
    if (context.ownerKey.length < 32 || context.ownerKey.length > 128)
      throw new OperatorApiError(403, "forbidden");
    return context;
  }

  purgeLocalReviewDrafts(ownerKey: string): void {
    if (ownerKey.length < 32 || ownerKey.length > 128) return;
    this.service.localReviews().purgeEditableDrafts(ownerKey);
  }

  private reviewSyncIdentity(taskId: string): LocalReviewSyncIdentity {
    const task = this.requireTask(taskId);
    this.requireProject(String(task.projectId));
    return {
      projectId: String(task.projectId),
      taskVersion: Number(task.version),
      visibility: this.visibilityToken(),
      workspaceVisibility: this.service.taskWorkspaceVisibility(taskId),
    };
  }

  private reviewTaskIsOpen(taskId: string): boolean {
    const task = this.requireTask(taskId);
    this.requireProject(String(task.projectId));
    return task.state === "open";
  }

  private async currentReviewPolicy(
    taskId: string,
    session: OperatorReviewSessionContext,
  ) {
    const policy = await this.retainedEvidencePolicy(taskId);
    if (!policy) throw new OperatorApiError(503, "unavailable");
    if (!session.current()) throw new OperatorApiError(401, "unauthenticated");
    this.assertReviewPolicy(taskId, policy);
    return policy;
  }

  private assertReviewPolicy(
    taskId: string,
    policy: NonNullable<
      Awaited<ReturnType<OperatorApi["retainedEvidencePolicy"]>>
    >,
  ) {
    const current = this.reviewSyncIdentity(taskId);
    if (
      current.projectId !== policy.projectId ||
      current.taskVersion !== policy.taskVersion ||
      current.visibility !== policy.visibility ||
      current.workspaceVisibility !== policy.workspaceVisibility
    )
      throw new OperatorApiError(409, "conflict");
  }

  /** Each anchor still exists and its repository, path and excerpt are permitted. */
  private reviewAnchorsPermitted(
    taskId: string,
    anchorIds: readonly string[],
    policy: {
      excluded: readonly string[];
      authorizedRepositoryIds: readonly string[];
    },
  ) {
    const retained = this.service.retainedEvidence();
    return anchorIds.every((anchorId) => {
      let content: ReturnType<typeof retained.reviewAnchor>;
      try {
        content = retained.reviewAnchor(taskId, anchorId);
      } catch {
        return false; // An unreadable anchor is not permitted.
      }
      if (!content) return false;
      const { anchor, bytes } = content;
      const excerpt = bytes?.toString("utf8");
      return (
        (anchor.repositoryId === null ||
          policy.authorizedRepositoryIds.includes(anchor.repositoryId)) &&
        this.disclosable(anchor.path, policy.excluded) &&
        (excerpt === undefined || this.disclosable(excerpt, policy.excluded))
      );
    });
  }

  async readLocalReviewDraft(
    taskId: string,
    context?: OperatorReviewSessionContext,
  ) {
    const session = this.requireReviewSession(context);
    const policy = await this.currentReviewPolicy(taskId, session);
    const store = this.service.localReviews();
    let draft = store.readDraft(taskId, session.ownerKey);
    if (
      draft.accessFingerprint &&
      draft.accessFingerprint !== policy.accessFingerprint
    ) {
      // Keep the draft unless its text or anchors are now actually excluded.
      const allowed =
        draft.state === "editable" &&
        [
          draft.draft.summary,
          ...draft.draft.comments.map((comment) => comment.body),
        ].every((value) => this.disclosable(value, policy.excluded)) &&
        this.reviewAnchorsPermitted(
          taskId,
          draft.groups.flatMap((group) => group.anchorIds),
          policy,
        );
      if (allowed)
        store.refreshAccessFingerprint(
          taskId,
          session.ownerKey,
          draft.version,
          policy.accessFingerprint,
        );
      else store.purgeEditableDrafts(session.ownerKey, taskId);
      draft = store.readDraft(taskId, session.ownerKey);
    }
    return { data: draft, observedAt: Date.now() };
  }

  async readLocalReviewList(
    taskId: string,
    context?: OperatorReviewSessionContext,
  ) {
    const session = this.requireReviewSession(context);
    uuid.parse(taskId);
    const policy = await this.retainedEvidencePolicy(taskId);
    if (!policy) throw new OperatorApiError(503, "unavailable");
    if (!session.current()) throw new OperatorApiError(401, "unauthenticated");
    this.assertReviewPolicy(taskId, policy);
    const reviews = this.service.localReviews().listRecorded(taskId);
    const latest = await this.retainedEvidencePolicy(taskId);
    if (!session.current()) throw new OperatorApiError(401, "unauthenticated");
    if (!this.sameRetainedPolicy(latest, policy))
      throw new OperatorApiError(503, "unavailable");
    return { data: { taskId, reviews }, observedAt: Date.now() };
  }

  async readLocalReviewOperation(
    taskId: string,
    operationId: string,
    context?: OperatorReviewSessionContext,
  ) {
    const session = this.requireReviewSession(context);
    uuid.parse(operationId);
    const policy = await this.retainedEvidencePolicy(taskId);
    if (!policy) throw new OperatorApiError(404, "not-found");
    if (!session.current()) throw new OperatorApiError(401, "unauthenticated");
    this.assertReviewPolicy(taskId, policy);
    const value = this.service.localReviews().operationMaterial(operationId);
    if (!value || value.response.taskId !== taskId)
      throw new OperatorApiError(404, "not-found");
    // Definitively unsent text stays with its own session. Prepared operations
    // remain visible for re-authenticated reconciliation.
    const unsent =
      value.response.state === "rejected" ||
      value.response.state === "not-recorded";
    const payload =
      !unsent || value.ownerKey === session.ownerKey
        ? value.payload
        : undefined;
    const comments = payload?.comments.map((comment) => {
      const body = this.safe(comment.body, policy.excluded);
      return {
        commentId: comment.commentId,
        body: body === comment.body ? body : null,
        anchorGroupIds: comment.anchorGroupIds,
      };
    });
    const groups = [];
    for (const group of payload?.groups ?? []) {
      const anchors = [];
      for (const anchorId of group.anchorIds) {
        try {
          const read = await this.readRetainedReviewAnchor(taskId, anchorId);
          const data = read.data;
          anchors.push(
            data.state === "unavailable"
              ? { anchorId, state: data.state, reason: data.reason }
              : {
                  anchorId,
                  state: data.state,
                  ...(data.state === "available"
                    ? { status: data.status }
                    : {}),
                  path: data.anchor.path,
                  context: data.anchor.context,
                  startLine: data.anchor.startLine,
                  endLine: data.anchor.endLine,
                },
          );
        } catch {
          anchors.push({
            anchorId,
            state: "unavailable" as const,
            reason: "unavailable" as const,
          });
        }
      }
      groups.push({ groupId: group.groupId, anchors });
    }
    const latest = await this.retainedEvidencePolicy(taskId);
    if (!session.current()) throw new OperatorApiError(401, "unauthenticated");
    if (!this.sameRetainedPolicy(latest, policy))
      throw new OperatorApiError(503, "unavailable");
    return {
      data: {
        ...value.response,
        ...(payload
          ? {
              summary: this.safe(payload.summary, policy.excluded),
              comments,
              groups,
            }
          : {}),
      },
      observedAt: Date.now(),
    };
  }

  private async executeLocalReview(
    c: LocalReviewCommand,
    context?: OperatorReviewSessionContext,
  ) {
    const session = this.requireReviewSession(context);
    const store = this.service.localReviews();
    if (c.type === "review.anchor.stage") {
      const parsed = retainedReviewAnchorStageRequestSchema.parse({
        taskId: c.taskId,
        operationId: randomUUID(),
        anchors: c.anchors,
      });
      const requestHash = materialDigest({
        taskId: c.taskId,
        expectedDraftVersion: c.expectedDraftVersion,
        anchors: parsed.anchors,
      });
      const active = this.activeReviewStages.get(c.key);
      if (active) {
        if (active !== requestHash) throw new OperatorApiError(409, "conflict");
        throw new OperatorApiError(503, "command-outcome-unknown");
      }
      const replay = store.replayStage({
        commandKey: c.key,
        taskId: c.taskId,
        ownerKey: session.ownerKey,
        requestHash,
      });
      if (replay)
        return commandReceiptSchema.parse({
          kind: "local-review-anchor",
          key: c.key,
          taskId: c.taskId,
          groupId: replay.groupId,
          anchorIds: replay.anchorIds,
          draftVersion: replay.draftVersion,
          state: "staged",
        });
      this.activeReviewStages.set(c.key, requestHash);
      try {
        const result = await this.service.stageLocalReviewAnchorGroup({
          commandKey: c.key,
          taskId: c.taskId,
          ownerKey: session.ownerKey,
          expectedDraftVersion: c.expectedDraftVersion,
          requestHash,
          anchors: parsed.anchors,
        });
        if (!session.current()) {
          store.purgeEditableDrafts(session.ownerKey, c.taskId);
          throw new OperatorApiError(401, "unauthenticated");
        }
        return commandReceiptSchema.parse({
          kind: "local-review-anchor",
          key: c.key,
          taskId: c.taskId,
          groupId: result.groupId,
          anchorIds: result.anchorIds,
          draftVersion: result.draftVersion,
          state: "staged",
        });
      } finally {
        this.activeReviewStages.delete(c.key);
      }
    }

    if (c.type === "review.send") return this.sendLocalReview(c, session);
    if (c.type === "review.send.reconcile")
      return this.reconcileLocalReview(c, session);

    const policy = await this.currentReviewPolicy(c.taskId, session);
    if (c.type === "review.draft.save") {
      const values = [
        c.draft.summary,
        ...c.draft.comments.map((comment) => comment.body),
      ];
      if (values.some((value) => !this.disclosable(value, policy.excluded)))
        throw new OperatorApiError(403, "forbidden");
      // A stale tab must not stamp the current policy onto now-excluded anchors.
      const groupIds = c.draft.comments.flatMap(
        (comment) => comment.anchorGroupIds,
      );
      if (
        !this.reviewAnchorsPermitted(
          c.taskId,
          store.groupAnchorIds(c.taskId, session.ownerKey, groupIds),
          policy,
        )
      )
        throw new OperatorApiError(403, "forbidden");
      const requestHash = materialDigest({
        taskId: c.taskId,
        expectedDraftVersion: c.expectedDraftVersion,
        draft: c.draft,
      });
      const result = store.saveDraft({
        commandKey: c.key,
        taskId: c.taskId,
        ownerKey: session.ownerKey,
        expectedDraftVersion: c.expectedDraftVersion,
        draft: c.draft,
        requestHash,
        accessFingerprint: policy.accessFingerprint,
      });
      return commandReceiptSchema.parse({
        kind: "local-review-draft",
        key: c.key,
        taskId: c.taskId,
        version: result.version,
        state: "editable",
      });
    }
    const requestHash = materialDigest({
      taskId: c.taskId,
      expectedDraftVersion: c.expectedDraftVersion,
    });
    const result = store.discardDraft({
      commandKey: c.key,
      taskId: c.taskId,
      ownerKey: session.ownerKey,
      expectedDraftVersion: c.expectedDraftVersion,
      requestHash,
      accessFingerprint: policy.accessFingerprint,
    });
    return commandReceiptSchema.parse({
      kind: "local-review-draft",
      key: c.key,
      taskId: c.taskId,
      version: result.version,
      state: "discarded",
    });
  }

  private async sendLocalReview(
    c: Extract<LocalReviewCommand, { type: "review.send" }>,
    session: OperatorReviewSessionContext,
  ) {
    const { request, requestHash } = this.localReviewRequest(c);
    this.reviewSyncIdentity(c.taskId);
    if (!session.current()) throw new OperatorApiError(401, "unauthenticated");
    const store = this.service.localReviews();
    const active = this.activeReviewSends.get(c.key);
    if (active) {
      await this.currentReviewPolicy(c.taskId, session);
      if (active !== requestHash) throw new OperatorApiError(409, "conflict");
      return this.activeLocalReviewReceipt(c, requestHash);
    }
    const existing = store.operationMaterial(c.key);
    if (
      existing &&
      (existing.response.taskId !== c.taskId ||
        existing.requestHash !== requestHash)
    ) {
      await this.currentReviewPolicy(c.taskId, session);
      throw new OperatorApiError(409, "conflict");
    }
    if (existing && existing.response.state !== "prepared") {
      await this.currentReviewPolicy(c.taskId, session);
      return this.localReviewReceipt(c.key, existing.response);
    }
    if (!existing && !this.reviewTaskIsOpen(c.taskId))
      throw new OperatorApiError(409, "conflict");
    this.activeReviewSends.set(c.key, requestHash);
    try {
      const prepared = store.prepareSend({
        request,
        ownerKey: session.ownerKey,
        requestHash,
      });
      if (prepared.response.state !== "prepared") {
        await this.currentReviewPolicy(c.taskId, session);
        return this.localReviewReceipt(c.key, prepared.response);
      }
      if (!prepared.payload)
        throw new OperatorApiError(503, "command-outcome-unknown");
      const initial = await this.currentReviewPolicy(c.taskId, session);
      if (prepared.accessFingerprint !== initial.accessFingerprint) {
        return this.rejectLocalReview(c.key, requestHash, "policy-changed");
      }
      if (!this.reviewTaskIsOpen(c.taskId)) {
        return this.rejectLocalReview(c.key, requestHash, "task-not-open");
      }
      if (!this.disclosable(prepared.payload.message, initial.excluded)) {
        return this.rejectLocalReview(c.key, requestHash, "excluded-content");
      }
      for (const group of prepared.payload.groups)
        for (const anchorId of group.anchorIds) {
          let read: Awaited<
            ReturnType<OperatorApi["readRetainedReviewAnchor"]>
          >;
          try {
            read = await this.readRetainedReviewAnchor(c.taskId, anchorId);
          } catch {
            await this.currentReviewPolicy(c.taskId, session);
            return this.localReviewReceipt(c.key, prepared.response);
          }
          if (!session.current())
            throw new OperatorApiError(401, "unauthenticated");
          if (read.data.state === "unavailable")
            return this.rejectLocalReview(
              c.key,
              requestHash,
              read.data.reason === "excluded"
                ? "excluded-anchor"
                : "anchor-unavailable",
            );
          if (
            read.data.state === "available" &&
            !this.disclosable(read.data.anchor.path, initial.excluded)
          ) {
            return this.rejectLocalReview(
              c.key,
              requestHash,
              "excluded-anchor",
            );
          }
        }
      const latest = await this.retainedEvidencePolicy(c.taskId);
      if (!latest || !session.current())
        throw new OperatorApiError(503, "unavailable");
      this.assertReviewPolicy(c.taskId, latest);
      if (!this.sameRetainedPolicy(latest, initial))
        return this.localReviewReceipt(c.key, prepared.response);
      if (
        prepared.accessFingerprint !== latest.accessFingerprint ||
        !this.reviewTaskIsOpen(c.taskId)
      ) {
        return this.rejectLocalReview(
          c.key,
          requestHash,
          this.reviewTaskIsOpen(c.taskId) ? "policy-changed" : "task-not-open",
        );
      }
      let committed: ReturnType<typeof store.commitSend>;
      try {
        committed = store.commitSend({
          request,
          requestHash,
          payload: prepared.payload,
          accessFingerprint: latest.accessFingerprint,
          expectedIdentity: {
            projectId: latest.projectId,
            taskVersion: latest.taskVersion,
            visibility: latest.visibility,
            workspaceVisibility: latest.workspaceVisibility,
          },
          currentIdentity: () => this.reviewSyncIdentity(c.taskId),
        });
      } catch (error) {
        try {
          const observed = store.operationMaterial(c.key)?.response;
          if (observed?.state === "prepared") {
            const rejected = store.rejectSend(
              c.key,
              requestHash,
              "commit-transaction-rolled-back",
            );
            if (rejected) return this.localReviewReceipt(c.key, rejected);
          } else if (observed) {
            return this.localReviewReceipt(c.key, observed);
          }
        } catch {
          // An unreadable or still-open transaction remains frozen for exact reconciliation.
        }
        throw error;
      }
      if (committed.response.state === "recorded")
        await this.coordination().notifyOperatorCommand();
      return this.localReviewReceipt(c.key, committed.response);
    } finally {
      this.activeReviewSends.delete(c.key);
    }
  }

  private async reconcileLocalReview(
    c: Extract<LocalReviewCommand, { type: "review.send.reconcile" }>,
    session: OperatorReviewSessionContext,
  ) {
    const { request, requestHash } = this.localReviewRequest(c);
    this.reviewSyncIdentity(c.taskId);
    if (!session.current()) throw new OperatorApiError(401, "unauthenticated");
    const store = this.service.localReviews();
    const active = this.activeReviewSends.get(c.key);
    if (active) {
      const policy = await this.currentReviewPolicy(c.taskId, session);
      if (active !== requestHash) throw new OperatorApiError(409, "conflict");
      if (this.activeReviewSends.get(c.key) === requestHash)
        return this.activeLocalReviewReceipt(c, requestHash);
      const result = store.reconcileSend({
        request,
        ownerKey: session.ownerKey,
        requestHash,
        currentIdentity: this.reviewSyncIdentity(c.taskId),
        currentAccessFingerprint: policy.accessFingerprint,
      });
      return this.localReviewReceipt(c.key, result);
    }
    const policy = await this.currentReviewPolicy(c.taskId, session);
    const activeAfterPolicy = this.activeReviewSends.get(c.key);
    if (activeAfterPolicy) {
      if (activeAfterPolicy !== requestHash)
        throw new OperatorApiError(409, "conflict");
      return this.activeLocalReviewReceipt(c, requestHash);
    }
    const result = store.reconcileSend({
      request,
      ownerKey: session.ownerKey,
      requestHash,
      currentIdentity: this.reviewSyncIdentity(c.taskId),
      currentAccessFingerprint: policy.accessFingerprint,
    });
    return this.localReviewReceipt(c.key, result);
  }

  private localReviewRequest(
    c: Extract<
      LocalReviewCommand,
      { type: "review.send" | "review.send.reconcile" }
    >,
  ) {
    const material = {
      taskId: c.taskId,
      expectedDraftVersion: c.expectedDraftVersion,
      recipientAssignmentId: c.recipientAssignmentId,
      expectedAssignmentVersion: c.expectedAssignmentVersion,
    };
    const request: LocalReviewRequest = { key: c.key, ...material };
    return { request, requestHash: materialDigest(material) };
  }

  /** Another request of this process is mid-send: report what is stored without touching it. */
  private activeLocalReviewReceipt(
    c: { key: string; taskId: string },
    requestHash: string,
  ) {
    const current = this.service.localReviews().operationMaterial(c.key);
    if (
      current?.response.taskId === c.taskId &&
      current.requestHash === requestHash
    )
      return this.localReviewReceipt(c.key, current.response);
    throw new OperatorApiError(503, "command-outcome-unknown");
  }

  private rejectLocalReview(key: string, requestHash: string, reason: string) {
    const rejected = this.service
      .localReviews()
      .rejectSend(key, requestHash, reason);
    if (!rejected) throw new OperatorApiError(503, "command-outcome-unknown");
    return this.localReviewReceipt(key, rejected);
  }

  private localReviewReceipt(
    key: string,
    response: {
      taskId: string;
      reviewId: string;
      state: string;
      eventId?: string | undefined;
      recipientAssignmentId?: string | undefined;
      resumedLead?: true | undefined;
    },
  ) {
    return commandReceiptSchema.parse({
      kind: "local-review-operation",
      key,
      taskId: response.taskId,
      reviewId: response.reviewId,
      state: response.state,
      ...(response.eventId ? { eventId: response.eventId } : {}),
      ...(response.recipientAssignmentId
        ? { recipientAssignmentId: response.recipientAssignmentId }
        : {}),
      ...(response.resumedLead ? { resumedLead: true } : {}),
    });
  }

  /** Review, confirm and send of an operator issue edit, fenced like the comment commands. */
  private async executeIssueEdit(
    c: Extract<
      z.output<typeof operatorCommandSchema>,
      { type: "issue.edit.review" | "issue.edit.confirm" | "issue.edit.send" }
    >,
  ) {
    const task = this.requireTask(c.taskId),
      visibility = this.visibilityToken(),
      excluded = await this.exclusions(String(task.projectId), c.taskId);
    if (
      visibility !== this.visibilityToken() ||
      this.requireTask(c.taskId).version !== task.version
    )
      throw new OperatorApiError(409, "conflict");
    if (c.type === "issue.edit.review") {
      if (
        !this.disclosable(c.title, excluded) ||
        !this.disclosable(c.body, excluded, 64_000)
      )
        throw new OperatorApiError(403, "forbidden");
      const run = this.service.readDrafting(c.runId);
      // The text the draft started from is what the edit replaces; only a used draft of this task qualifies.
      if (
        run?.kind !== "issue" ||
        run.taskId !== c.taskId ||
        !["proposed", "accepted"].includes(run.state) ||
        run.observedTitle === null ||
        run.observedBody === null
      )
        throw new OperatorApiError(409, "conflict");
      // The operator must see the whole text being replaced, so hidden text is refused before
      // anything is recorded.
      if (
        !this.disclosable(run.observedTitle, excluded, 64_000) ||
        !this.disclosable(run.observedBody, excluded, 64_000)
      )
        throw new OperatorApiError(403, "forbidden");
      return this.editReviewReceipt(
        c.key,
        this.service.reviewOperatorEdit({
          key: c.key,
          taskId: c.taskId,
          operationId: c.operationId,
          expectedTaskVersion: c.expectedTaskVersion,
          title: c.title,
          body: c.body,
          expected: { title: run.observedTitle, body: run.observedBody },
        }),
        excluded,
      );
    }
    const review = this.service.delivery().operatorReview(c.reviewId);
    if (
      !review ||
      review.taskId !== c.taskId ||
      review.action.kind !== "issue.edit"
    )
      throw new OperatorApiError(403, "forbidden");
    if (c.type === "issue.edit.confirm")
      return this.editReviewReceipt(
        c.key,
        this.service.confirmOperatorComment(c),
        excluded,
      );
    // One send per review: its key is the review's operation id.
    if (c.key !== review.operationId)
      throw new OperatorApiError(409, "conflict");
    const saved = await this.service.postOperatorEdit({
      key: c.key,
      taskId: c.taskId,
      reviewId: c.reviewId,
      expectedTaskVersion: c.expectedTaskVersion,
    });
    const receiptVisibility = this.visibilityToken(),
      receiptTask = this.requireTask(c.taskId),
      receiptExcluded = await this.exclusions(String(task.projectId), c.taskId);
    if (
      receiptVisibility !== this.visibilityToken() ||
      this.requireTask(c.taskId).version !== receiptTask.version
    )
      throw new OperatorApiError(409, "conflict");
    return commandReceiptSchema.parse({
      kind: "delivery",
      key: c.key,
      recorded: true,
      taskId: c.taskId,
      operationId: saved.operationId,
      state: saved.state,
      reason: this.safe(saved.observation?.reason, receiptExcluded),
    });
  }

  async execute(input: unknown, reviewSession?: OperatorReviewSessionContext) {
    const c = operatorCommandSchema.parse(input);
    try {
      if (
        c.type === "drafting.start" ||
        c.type === "drafting.stop" ||
        c.type === "drafting.settle"
      ) {
        if (c.type === "drafting.start") this.requireProject(c.projectId);
        else if (!this.service.readDrafting(c.runId))
          throw new OperatorApiError(404, "not-found");
        return commandReceiptSchema.parse(
          await this.service.draftingCommand(c),
        );
      }
      if (c.type === "issue.draft.start") {
        const task = this.requireTask(c.taskId),
          excluded = await this.exclusions(String(task.projectId), c.taskId);
        if (!this.disclosable(c.note, excluded))
          throw new OperatorApiError(403, "forbidden");
        return commandReceiptSchema.parse(
          await this.service.draftingCommand(c),
        );
      }
      if (
        c.type === "issue.edit.review" ||
        c.type === "issue.edit.confirm" ||
        c.type === "issue.edit.send"
      )
        return this.executeIssueEdit(c);
      if (
        c.type === "review.anchor.stage" ||
        c.type === "review.draft.save" ||
        c.type === "review.draft.discard" ||
        c.type === "review.send" ||
        c.type === "review.send.reconcile"
      )
        return await this.executeLocalReview(
          c as LocalReviewCommand,
          reviewSession,
        );
      if (
        c.type === "comment.review" ||
        c.type === "comment.confirm" ||
        c.type === "comment.send"
      ) {
        const task = this.requireTask(c.taskId),
          visibility = this.visibilityToken(),
          excluded = await this.exclusions(String(task.projectId), c.taskId);
        if (
          visibility !== this.visibilityToken() ||
          this.requireTask(c.taskId).version !== task.version
        )
          throw new OperatorApiError(409, "conflict");
        if ("body" in c && !this.disclosable(c.body, excluded))
          throw new OperatorApiError(403, "forbidden");
        if (c.type === "comment.review")
          return this.commentReviewReceipt(
            c.key,
            this.service.reviewOperatorComment(c),
            excluded,
          );
        if (c.type === "comment.confirm") {
          const r = this.service.delivery().operatorReview(c.reviewId);
          if (
            !r ||
            r.taskId !== c.taskId ||
            r.action.kind !== "issue.comment" ||
            !this.disclosable(r.action.body, excluded)
          )
            throw new OperatorApiError(403, "forbidden");
          return this.commentReviewReceipt(
            c.key,
            this.service.confirmOperatorComment(c),
            excluded,
          );
        }
        const saved = await this.service.postOperatorComment(c);
        const receiptVisibility = this.visibilityToken(),
          receiptTask = this.requireTask(c.taskId),
          workspace = this.service.taskWorkspaceVisibility(c.taskId),
          receiptExcluded = await this.exclusions(
            String(task.projectId),
            c.taskId,
          );
        if (
          receiptVisibility !== this.visibilityToken() ||
          this.requireTask(c.taskId).version !== receiptTask.version ||
          workspace !== this.service.taskWorkspaceVisibility(c.taskId)
        )
          throw new OperatorApiError(409, "conflict");
        return commandReceiptSchema.parse({
          kind: "delivery",
          key: c.key,
          recorded: true,
          taskId: c.taskId,
          operationId: saved.operationId,
          state: saved.state,
          reason: this.safe(saved.observation?.reason, receiptExcluded),
        });
      }
      if (c.type === "review.view") {
        this.requireTask(c.taskId);
        const excluded = await this.exclusions(
          String(this.requireTask(c.taskId).projectId),
          c.taskId,
        );
        if (excluded === undefined)
          throw new OperatorApiError(503, "unavailable");
        this.requireTask(c.taskId);
        this.service
          .taskReview()
          .recordViewed(c.taskId, c.key, c.sourceId, c.resultIds);
        return commandReceiptSchema.parse({
          kind: "review",
          key: c.key,
          recorded: true,
          taskId: c.taskId,
          operation: c.type,
        });
      }
      if (c.type === "delivery.refresh") {
        this.requireTask(c.taskId);
        await this.coordination().refreshDelivery(c.taskId);
        this.requireTask(c.taskId);
        return commandReceiptSchema.parse({
          kind: "review",
          key: c.key,
          recorded: true,
          taskId: c.taskId,
          operation: c.type,
        });
      }
      if (c.type === "capacity.configure") {
        const command = { ...c, actor: "operator" as const };
        let raw = this.domain().recordedCommand(command);
        if (raw === undefined) {
          for (const id of Object.keys(c.projectOverrides))
            this.requireProject(id);
          raw = await this.service.configureCapacity({
            key: c.key,
            globalLimit: c.globalLimit,
            projectOverrides: c.projectOverrides,
            ...(c.expectedCurrent
              ? { expectedCurrent: c.expectedCurrent }
              : {}),
          });
        }
        return commandReceipt(
          parseDomainCommandOutcome("capacity.configure", raw),
          c.key,
          "system:capacity",
        );
      }
      if (c.type === "claude-token.configure") {
        const outcome = await this.executeDomain({ ...c, actor: "operator" });
        return commandReceipt(
          parseDomainCommandOutcome("claude-token.configure", outcome),
          c.key,
          "system:claude-token",
        );
      }
      if (c.type === "runtime.configure") {
        const result = await this.service
          .configureRuntime(c)
          .catch((error: unknown) => {
            throw error instanceof RuntimeConfigurationRefusedError
              ? runtimeRefusal(error)
              : (domainApiError(error) ?? error);
          });
        return commandReceipt(
          { type: "runtime.configure", result },
          c.key,
          `system:runtime:${c.harness}`,
        );
      }
      if (c.type === "getting-started.configure") {
        const outcome = await this.executeDomain({ ...c, actor: "operator" });
        return commandReceipt(
          parseDomainCommandOutcome("getting-started.configure", outcome),
          c.key,
          "system:getting-started",
        );
      }
      if (c.type === "discovery.configure") {
        const outcome = await this.executeDomain({ ...c, actor: "operator" });
        return commandReceipt(
          parseDomainCommandOutcome("discovery.configure", outcome),
          c.key,
          "system:discovery",
        );
      }
      if (c.type === "github.preview")
        return await this.previewGitHubSelection(c);
      if (
        c.type === "project.create" ||
        c.type === "project.configure" ||
        c.type === "profile.create" ||
        c.type === "profile.configure" ||
        c.type === "routing.configure" ||
        c.type === "github.configure" ||
        c.type === "github.place"
      ) {
        // Supported values are authoritative once the runtime has read them.
        if (
          (c.type === "profile.create" || c.type === "profile.configure") &&
          c.runtime
        ) {
          const supported = this.service.harnessSettings(c.runtime.harness);
          const field =
            supported && unsupportedRuntimeField(c.runtime, supported);
          // An exact replay returns its recorded receipt whatever is supported now.
          if (
            field &&
            this.domain().recordedCommand({ ...c, actor: "operator" }) ===
              undefined
          )
            throw new OperatorApiError(400, "invalid-input", [field]);
        }
        // Setup paths may be home-relative; the domain verifies and records absolute ones.
        const command =
          c.type === "project.create" && c.repositories
            ? {
                ...c,
                repositories: c.repositories.map((r) => ({
                  ...r,
                  path: resolveHomePath(r.path, this.home()),
                })),
              }
            : c;
        const raw = await this.executeDomain({ ...command, actor: "operator" });
        return commandReceipt(
          parseDomainCommandOutcome(c.type, raw),
          c.key,
          c.type === "routing.configure" || c.type === "github.configure"
            ? c.projectId
            : "",
        );
      }
      if (isRecoveryCommand(c)) {
        this.requireAssignment(c.assignmentId);
        try {
          return await executeRecovery(this.service, c);
        } catch (error) {
          // Definite refusals only; infrastructure failures stay uncertain below.
          if (error instanceof RecoveryRejectedError)
            throw new OperatorApiError(409, "conflict");
          throw error;
        }
      }
      if (c.type === "task.stop" || c.type === "task.resume") {
        this.requireTask(c.taskId);
        try {
          return commandReceiptSchema.parse(await this.service.controlTask(c));
        } catch (error) {
          if (error instanceof TaskNotOpenError)
            throw new OperatorApiError(
              409,
              "conflict",
              undefined,
              undefined,
              `Only an open task can be stopped. This task is ${error.taskState === "done" ? "Done" : "Cancelled"}.`,
            );
          throw error;
        }
      }
      if (c.type === "task.draft-turn") {
        this.requireTask(c.taskId);
        try {
          return commandReceiptSchema.parse(
            await this.service.startDraftTurn(c),
          );
        } catch (error) {
          if (error instanceof DraftTurnUnavailableError)
            throw new OperatorApiError(
              409,
              "conflict",
              undefined,
              undefined,
              error.message,
            );
          throw error;
        }
      }
      if ("projectId" in c) {
        this.requireProject(c.projectId);
        const raw = await this.executeDomain({ ...c, actor: "operator" });
        return commandReceipt(
          parseDomainCommandOutcome(c.type, raw),
          c.key,
          c.projectId,
        );
      }
      this.requireTask(c.taskId);
      const view = this.coordination();
      const { type, ...submitted } = c;
      let command: typeof submitted = submitted;
      if (
        c.type === "approval.decide" &&
        c.decision === "denied" &&
        c.material === undefined
      ) {
        const retained = view
          .readTask(c.taskId)
          .approvals.find((i) => i.interactionId === c.interactionId);
        if (
          retained?.materialJson !== null &&
          retained?.materialJson !== undefined
        ) {
          command = {
            ...submitted,
            // Display bounds deliberately exclude some core-valid retained JSON.
            // The existing command compares these immutable bytes canonically.
            material: JSON.parse(retained.materialJson),
          };
        }
      }
      if (c.type === "approval.decide" && c.decision === "approved") {
        const approval = (await this.readTask(c.taskId)).data.approvals.find(
          (a) => a.interactionId === c.interactionId,
        );
        if (!approval?.approvable && approval?.status !== "approved")
          throw new OperatorApiError(403, "forbidden");
      }
      if (
        type === "question.form.answer" ||
        type === "question.native.answer"
      ) {
        if (c.type === "question.form.answer") {
          const prior = view.recordedQuestionFormAnswer({
            taskId: c.taskId,
            key: c.key,
            interactionId: c.interactionId,
            expectedRevision: c.expectedRevision,
            answers: c.answers,
          });
          if (prior)
            return commandReceiptSchema.parse({
              kind: "coordination",
              key: c.key,
              recorded: true,
              eventId: prior.eventId,
              taskId: prior.taskId,
              recipientAssignmentId: prior.recipientAssignmentId,
              eventType: prior.eventType,
              createdAt: prior.createdAt,
            });
        }
        if (c.type === "question.native.answer") {
          const { type: _type, ...input } = c;
          const prior = view.recordedRuntimeQuestionAnswer(input);
          if (prior)
            return commandReceiptSchema.parse({
              kind: "native-question",
              key: c.key,
              taskId: c.taskId,
              ...prior,
            });
        }
        const current = await this.readQuestion(c.taskId, c.interactionId);
        if (!current.data.form) throw new OperatorApiError(403, "forbidden");
        if (type === "question.native.answer") {
          const receipt = await view.answerRuntimeQuestion(
            command as Parameters<typeof view.answerRuntimeQuestion>[0],
          );
          return commandReceiptSchema.parse({
            kind: "native-question",
            key: c.key,
            taskId: c.taskId,
            ...receipt,
          });
        }
        const receipt = await view.answerQuestionForm(
          command as Parameters<typeof view.answerQuestionForm>[0],
        );
        return commandReceiptSchema.parse({
          kind: "coordination",
          key: c.key,
          recorded: true,
          ...receipt,
        });
      }
      const saved =
        type === "message"
          ? await view.postOperatorMessage(
              command as Parameters<typeof view.postOperatorMessage>[0],
            )
          : type === "question.answer"
            ? await view.answerQuestion(
                command as Parameters<typeof view.answerQuestion>[0],
              )
            : type === "approval.decide"
              ? await view.decideApproval(
                  command as Parameters<typeof view.decideApproval>[0],
                )
              : await view.reconcileResultRecipient(
                  command as Parameters<
                    typeof view.reconcileResultRecipient
                  >[0],
                );
      return commandReceiptSchema.parse({
        kind: "coordination",
        key: c.key,
        recorded: true,
        eventId: saved.eventId,
        taskId: saved.taskId,
        recipientAssignmentId: saved.recipientAssignmentId,
        eventType: saved.eventType,
        createdAt: saved.createdAt,
        ...(saved.resumedLead ? { resumedLead: true } : {}),
      });
    } catch (error) {
      if (error instanceof OperatorApiError || error instanceof z.ZodError)
        throw error;
      if (error instanceof LocalReviewAnchorRequiredError)
        throw new OperatorApiError(400, "local-review-comment-anchor-required");
      if (error instanceof LocalReviewBatchTooLargeError)
        throw new OperatorApiError(400, "local-review-batch-too-large");
      if (error instanceof LocalReviewRecipientUnavailableError)
        throw new OperatorApiError(409, "local-review-recipient-unavailable");
      const mapped = domainApiError(error);
      if (mapped) throw mapped;
      throw new OperatorApiError(503, "command-outcome-unknown");
    }
  }
}

/** A setting value as display text, or null when absent or too long. */
function settingValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > 1024 ? null : text;
}
