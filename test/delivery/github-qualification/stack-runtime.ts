import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { z } from "zod";
import { registerPrArgumentsSchema } from "../../../src/core/delivery.js";
import { reviewMetadataSchema } from "../../../src/core/task-review.js";
import type {
  Runtime,
  RuntimeTurnSettings,
} from "../../../src/standalone/codex.js";
import type { TerminationVerifier } from "../../../src/standalone/recovery-types.js";
import type { StandaloneService } from "../../../src/standalone/service.js";
import { MacProcessTerminationVerifier } from "../../../src/standalone/termination.js";
import {
  authorityHash,
  materialHash,
  type StackV2Authority,
} from "./stack-authority.js";

type Intent = ReturnType<StandaloneService["list"]>[number];
type Request = NonNullable<ReturnType<StandaloneService["turnRequest"]>>;
export interface StackRuntimeService {
  list(): Pick<
    Intent,
    "workId" | "state" | "threadId" | "turnId" | "workspace" | "prompt"
  >[];
  turnRequest(
    workId: string,
  ):
    | Pick<
        Request,
        | "taskId"
        | "assignmentId"
        | "projectId"
        | "workspace"
        | "prompt"
        | "taskVersion"
        | "assignmentVersion"
        | "instructionsRevision"
        | "profileRevision"
        | "sequence"
      >
    | undefined;
}
const bound = new WeakSet<Runtime>();
/** The real factory and offline doubles use this same boundary around every runtime call. */
export function bindStackRuntime(
  runtime: Runtime,
  authority: StackV2Authority,
  service: () => StackRuntimeService,
  verifier: TerminationVerifier = new MacProcessTerminationVerifier(),
): Runtime {
  authority.current();
  if (
    bound.has(runtime) ||
    !runtime.onToolCall ||
    !runtime.processIdentity ||
    (runtime.harness && runtime.harness !== "codex")
  )
    throw Error("v2-runtime-boundary");
  bound.add(runtime);
  const original = {
    start: runtime.start.bind(runtime),
    stop: runtime.stop.bind(runtime),
    startThread: runtime.startThread.bind(runtime),
    resumeThread: runtime.resumeThread.bind(runtime),
    startTurn: runtime.startTurn.bind(runtime),
    waitForTurn: runtime.waitForTurn.bind(runtime),
    interruptTurn: runtime.interruptTurn.bind(runtime),
  };
  const invoke = async <T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    let pending: Promise<T>;
    try {
      pending = operation();
      void pending.catch(() => {});
    } finally {
      await authority.invoked(key);
    }
    return pending;
  };
  const onToolCall = runtime.onToolCall!.bind(runtime);
  const m = authority.manifest,
    threads = new Map<string, string>();
  const submissions = new Map<string, Promise<string>>();
  let startInvoked = false;
  const lifecycle = {
    executable: m.authority.host.runtimeExecutable,
    version: m.authority.host.runtimeVersion,
  };
  const scopeFor = (workspace: string, settings?: RuntimeTurnSettings) => {
    authority.current();
    const scopes = m.authority.runtime.filter(
      (scope) => scope.workspace === workspace,
    );
    if (
      scopes.length !== 1 ||
      materialHash(settings ?? null) !== scopes[0]!.settingsSha256
    )
      throw Error("v2-runtime-workspace-or-settings");
    return scopes[0]!;
  };
  const process = async (teardown = false) => {
    authority.current(teardown);
    const identity = await runtime.processIdentity!();
    authority.current(teardown);
    if (
      !identity ||
      materialHash(identity) !== materialHash(authority.snapshot().process)
    )
      throw Error("v2-runtime-process-binding");
    return identity;
  };
  runtime.onToolCall = (listener) =>
    onToolCall(async (call) => {
      let identity = await process();
      const submission = submissions.get(call.threadId);
      if (submission) {
        const turnId = await submission;
        authority.current();
        if (turnId !== call.turnId)
          throw Error("v2-callback-current-execution");
        // Cab binds the returned turn synchronously after its start promise resolves.
        // A callback already emitted by the runtime waits for that handback, without
        // releasing a service callback before the durable exact-turn record exists.
        await yieldEventLoop();
        identity = await process();
      }
      const binding = authority
        .snapshot()
        .runtimeBindings.find(
          (value) =>
            value.threadId === call.threadId &&
            value.turnId === call.turnId &&
            value.processSha256 === materialHash(identity),
        );
      if (
        !binding ||
        service()
          .list()
          .filter(
            (intent) =>
              intent.workId === binding.workId &&
              intent.threadId === call.threadId &&
              intent.turnId === call.turnId &&
              intent.state === "running",
          ).length !== 1
      )
        throw Error("v2-callback-current-execution");
      if (call.tool === "cab_register_pr") {
        const args = registerPrArgumentsSchema.parse(call.arguments);
        const lower = binding.taskId === m.resource.lowerTask;
        const expectedHeads = lower
          ? [m.resource.lowerHead]
          : [
              m.resource.upperHead,
              authority.snapshot().captures.upperHead,
            ].filter((value) => value !== undefined);
        if (
          args.repositoryId !== m.resource.repositoryNodeId ||
          args.prNumber !== (lower ? m.resource.lowerPr : m.resource.upperPr) ||
          args.expectedPrNodeId !==
            (lower ? m.resource.lowerPrId : m.resource.upperPrId) ||
          !expectedHeads.includes(args.expectedHeadSha)
        )
          throw Error("v2-register-pr-material");
      } else if (call.tool === "cab_report_result") {
        z.object({
          summary: z.string().min(1).max(16000),
          review: reviewMetadataSchema.optional(),
        })
          .strict()
          .parse(call.arguments);
      } else throw Error("v2-cab-callback-not-granted");
      const key = await authority.beginCallback(call);
      authority.current();
      let succeeded = false;
      try {
        await process();
        await authority.preflight();
        authority.current();
        if (
          service()
            .list()
            .filter(
              (intent) =>
                intent.workId === binding.workId &&
                intent.threadId === call.threadId &&
                intent.turnId === call.turnId &&
                intent.state === "running",
            ).length !== 1
        )
          throw Error("v2-callback-intent-changed");
        let pending: ReturnType<typeof listener>;
        try {
          pending = listener(call);
          void pending.catch(() => {});
        } finally {
          await authority.callbackInvoked(key);
        }
        const result = await pending;
        succeeded = result.success;
        return result;
      } finally {
        await authority.endCallback(key, succeeded);
      }
    });
  runtime.start = async () => {
    await authority.reserve("runtime.start", lifecycle, "runtime:start");
    authority.current();
    startInvoked = true;
    await invoke("runtime:start", () => original.start());
    authority.current();
    const identity = await runtime.processIdentity!();
    authority.current();
    if (!identity) {
      authority.hold();
      throw Error("v2-runtime-process-unproved");
    }
    await authority.captureProcess(identity);
    await authority.confirm("runtime:start", materialHash(identity));
  };
  runtime.startThread = async (workspace, tools = [], settings) => {
    const scope = scopeFor(workspace, settings);
    if (scope.threadId !== null) throw Error("v2-thread-create-not-granted");
    const key = `runtime:thread:${scope.assignmentId}`;
    await authority.reserve(
      "runtime.thread.start",
      { ...scope, toolsSha256: materialHash(tools) },
      key,
    );
    await process();
    authority.current();
    const threadId = await invoke(key, () =>
      original.startThread(workspace, tools, settings),
    );
    authority.current();
    if (!threadId || threads.has(threadId)) throw Error("v2-thread-binding");
    threads.set(threadId, workspace);
    await authority.confirm(key, threadId);
    return threadId;
  };
  runtime.resumeThread = async (threadId, tools, settings, workspace) => {
    if (!workspace) throw Error("v2-resume-workspace");
    const scope = scopeFor(workspace, settings);
    if (threads.get(threadId) !== workspace && scope.threadId !== threadId)
      throw Error("v2-uncaptured-thread-refused");
    const key = `runtime:resume:${scope.assignmentId}:${authority.snapshot().counts["call-total:runtime.thread.resume"] ?? 0}`;
    await authority.reserve(
      "runtime.thread.resume",
      { ...scope, toolsSha256: materialHash(tools ?? []) },
      key,
      false,
      undefined,
      { threadId, workspace, assignmentId: scope.assignmentId },
    );
    await process();
    authority.current();
    await invoke(key, () =>
      original.resumeThread(threadId, tools, settings, workspace),
    );
    authority.current();
    if (threads.has(threadId) && threads.get(threadId) !== workspace)
      throw Error("v2-thread-binding");
    threads.set(threadId, workspace);
    await authority.confirm(key, threadId);
  };
  runtime.startTurn = async (threadId, workspace, prompt, settings, policy) => {
    const scope = scopeFor(workspace, settings);
    if (threads.get(threadId) !== workspace)
      throw Error("v2-turn-thread-binding");
    const candidates = service()
      .list()
      .filter(
        (intent) =>
          intent.state === "submitting" &&
          intent.threadId === threadId &&
          intent.workspace === workspace,
      );
    if (candidates.length !== 1) throw Error("v2-turn-intent-ambiguous");
    const intent = candidates[0]!,
      request = service().turnRequest(intent.workId);
    if (
      !request ||
      request.taskId !== scope.taskId ||
      request.assignmentId !== scope.assignmentId ||
      request.projectId !== m.resource.projectId ||
      request.workspace !== workspace ||
      request.prompt !== intent.prompt
    )
      throw Error("v2-turn-request-binding");
    const argumentPolicy = z
      .object({
        networkAccess: z.boolean(),
        access: z.literal("read-only").optional(),
        gitWritableRoots: z.array(z.string()).optional(),
      })
      .strict()
      .optional()
      .parse(policy);
    const effectivePolicy = {
      networkAccess: argumentPolicy?.networkAccess === true,
      ...(argumentPolicy?.access ? { access: argumentPolicy.access } : {}),
      ...(argumentPolicy?.gitWritableRoots
        ? { gitWritableRoots: argumentPolicy.gitWritableRoots }
        : {}),
    };
    if (
      request.taskVersion === null ||
      request.assignmentVersion === null ||
      !scope.taskVersions.includes(request.taskVersion) ||
      !scope.assignmentVersions.includes(request.assignmentVersion) ||
      request.instructionsRevision !== scope.instructionsRevision ||
      request.profileRevision !== scope.profileRevision ||
      Buffer.byteLength(prompt) > scope.maxPromptBytes ||
      effectivePolicy.networkAccess ||
      materialHash(effectivePolicy) !== scope.policySha256
    )
      throw Error("v2-turn-revision-or-policy");
    const material = {
      taskId: scope.taskId,
      assignmentId: scope.assignmentId,
      workspace,
      settingsSha256: scope.settingsSha256,
      policySha256: scope.policySha256,
    };
    const detail = {
      ...material,
      workId: intent.workId,
      threadId,
      promptSha256: authorityHash(prompt),
      requestPromptSha256: authorityHash(request.prompt),
      argumentsPolicySha256: materialHash(policy ?? null),
      taskVersion: request.taskVersion,
      assignmentVersion: request.assignmentVersion,
      instructionsRevision: scope.instructionsRevision,
      profileRevision: scope.profileRevision,
      requestSequence: request.sequence,
    };
    const key = `runtime:turn:${intent.workId}`;
    await authority.reserve("runtime.turn", material, key, false, detail);
    const identity = await process();
    const assertIntent = () => {
      const currentRequest = service().turnRequest(intent.workId);
      if (
        !currentRequest ||
        materialHash(currentRequest) !== materialHash(request) ||
        service()
          .list()
          .filter(
            (current) =>
              current.workId === intent.workId &&
              current.state === "submitting" &&
              current.threadId === threadId &&
              current.workspace === workspace &&
              current.prompt === intent.prompt,
          ).length !== 1
      )
        throw Error("v2-turn-intent-changed");
    };
    assertIntent();
    const submission = Promise.resolve().then(async () => {
      authority.current();
      assertIntent();
      const turnId = await invoke(key, () =>
        original.startTurn(threadId, workspace, prompt, settings, policy),
      );
      authority.current();
      if (!turnId || materialHash(await process()) !== materialHash(identity))
        throw Error("v2-turn-result-unproved");
      await authority.bindTurn({
        taskId: scope.taskId,
        assignmentId: scope.assignmentId,
        workId: intent.workId,
        threadId,
        turnId,
        processSha256: materialHash(identity),
      });
      await authority.confirm(
        key,
        materialHash({ threadId, turnId, process: identity }),
      );
      return turnId;
    });
    submissions.set(threadId, submission);
    void submission.catch(() => {});
    return submission;
  };
  runtime.waitForTurn = async (threadId, turnId) => {
    const identity = await process();
    const binding = authority
      .snapshot()
      .runtimeBindings.find(
        (item) =>
          item.threadId === threadId &&
          item.turnId === turnId &&
          item.processSha256 === materialHash(identity),
      );
    if (!binding) throw Error("v2-wait-identity");
    const key = `runtime:wait:${binding.workId}`;
    await authority.reserve(
      "runtime.wait",
      { taskId: binding.taskId, assignmentId: binding.assignmentId },
      key,
    );
    authority.current();
    const status = await invoke(key, () =>
      original.waitForTurn(threadId, turnId),
    );
    authority.current();
    await process();
    await authority.terminal(binding.workId, status);
    await authority.confirm(key, materialHash({ threadId, turnId, status }));
    return status;
  };
  runtime.interruptTurn = async (threadId, turnId) => {
    const identity = await process(true);
    const binding = authority
      .snapshot()
      .runtimeBindings.find(
        (item) =>
          item.threadId === threadId &&
          item.turnId === turnId &&
          item.processSha256 === materialHash(identity),
      );
    if (!binding) throw Error("v2-interrupt-identity");
    const key = `runtime:interrupt:${binding.workId}`;
    await authority.reserve(
      "runtime.interrupt",
      { taskId: binding.taskId, assignmentId: binding.assignmentId },
      key,
      true,
    );
    authority.current(true);
    await invoke(key, () => original.interruptTurn(threadId, turnId));
    authority.current(true);
    await authority.confirm(
      key,
      materialHash({ threadId, turnId, acknowledged: true }),
      true,
    );
  };
  runtime.stop = async () => {
    authority.current(true);
    if (!startInvoked) return;
    let identity: Awaited<ReturnType<NonNullable<Runtime["processIdentity"]>>> =
      null;
    try {
      identity = await runtime.processIdentity!();
    } catch {
      // Failed metadata capture cannot revoke cleanup of the runtime-owned handle.
      authority.hold();
    }
    authority.current(true);
    // The bound runtime owns its exact child handle even when startup identity
    // capture failed. Cleanup is permitted; successful termination proof is not.
    if (identity && !authority.snapshot().process)
      await authority.captureProcess(identity, true);
    const boundIdentity =
      identity &&
      materialHash(identity) === materialHash(authority.snapshot().process);
    if (!boundIdentity) authority.hold();
    const key = "runtime:stop";
    await authority.reserve("runtime.stop", lifecycle, key, true);
    authority.current(true);
    await invoke(key, () => original.stop());
    authority.current(true);
    if (!identity || !boundIdentity) throw Error("v2-stop-process-unproved");
    const verification = await verifier.verify(identity);
    authority.current(true);
    if (
      verification.kind !== "verified" ||
      materialHash(verification.processIdentity) !== materialHash(identity)
    )
      throw Error("v2-process-exit-unproved");
    await authority.proveProcessExit(identity);
    await authority.confirm(key, materialHash(verification), true);
  };
  // These optional capabilities are absent in this finite adapter. Advertising
  // an archiver that always throws would leave a requested archive which blocks
  // the service's next resume even though no native archive was sent.
  Object.defineProperty(runtime, "setThreadArchived", {
    value: undefined,
    configurable: true,
  });
  Object.defineProperty(runtime, "replyUserInput", {
    value: undefined,
    configurable: true,
  });
  return runtime;
}
