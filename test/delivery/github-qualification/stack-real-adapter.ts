import {
  CodexRuntime,
  type Runtime,
  type RuntimeTurnSettings,
  type RuntimeTurnPolicy,
  type RuntimeToolDefinition,
} from "../../../src/standalone/codex.js";
import {
  StandaloneService,
  type RuntimeSpawnContext,
} from "../../../src/standalone/service.js";
import { OperatorApi } from "../../../src/standalone/operator-api.js";
import { GitHubHttpDeliveryProvider } from "../../../src/standalone/github-delivery.js";
import { operatorCommandSchema } from "../../../src/operator/contracts.js";
import { type StackV2Authority, materialHash } from "./stack-authority.js";

/** Real constructors are reached only after independently supplied v2 scope and host pins pass. */
export async function createRealStackAdapter(
  authority: StackV2Authority,
  credential: (reference: string) => Promise<string | undefined>,
  transport: typeof fetch = fetch,
) {
  await authority.open();
  const m = authority.manifest;
  let service: StandaloneService;
  let runtime: Runtime | undefined;
  const scopeFor = (workspace: string) => {
    const scopes = m.authority.runtime.filter((v) => v.workspace === workspace);
    if (scopes.length !== 1) throw Error("v2-runtime-workspace");
    return scopes[0]!;
  };
  const settingsFor = (workspace: string, settings?: RuntimeTurnSettings) => {
    const scope = scopeFor(workspace);
    if (materialHash(settings ?? null) !== scope.settingsSha256)
      throw Error("v2-runtime-settings");
    return scope;
  };
  class BoundRuntime extends CodexRuntime {
    private readonly threadScopes = new Map<string, string>();
    override async start() {
      const material = {
        executable: m.authority.host.runtimeExecutable,
        version: m.authority.host.runtimeVersion,
      };
      await authority.reserve("runtime.start", material, "runtime:start");
      authority.current();
      await super.start();
      authority.current();
      const identity = this.processIdentity();
      if (!identity) throw Error("v2-runtime-process-unproved");
      await authority.confirm("runtime:start", materialHash(identity));
    }
    override async startThread(
      workspace: string,
      tools: readonly RuntimeToolDefinition[] = [],
      settings?: RuntimeTurnSettings,
    ) {
      const scope = settingsFor(workspace, settings);
      const key = `runtime:thread:${scope.assignmentId}`;
      await authority.reserve(
        "runtime.thread.start",
        { ...scope, toolsSha256: materialHash(tools) },
        key,
      );
      authority.current();
      const threadId = await super.startThread(workspace, tools, settings);
      authority.current();
      if (!threadId || this.threadScopes.has(threadId))
        throw Error("v2-thread-binding");
      this.threadScopes.set(threadId, workspace);
      await authority.confirm(key, threadId);
      return threadId;
    }
    override async resumeThread(
      threadId: string,
      tools?: readonly RuntimeToolDefinition[],
      settings?: RuntimeTurnSettings,
      workspace?: string,
    ) {
      // A resume may only follow this run's own successful thread creation.
      if (!workspace || this.threadScopes.get(threadId) !== workspace)
        throw Error("v2-historical-thread-refused");
      const scope = settingsFor(workspace, settings);
      const key = `runtime:resume:${scope.assignmentId}`;
      await authority.reserve(
        "runtime.thread.resume",
        { ...scope, threadId, toolsSha256: materialHash(tools ?? []) },
        key,
      );
      authority.current();
      await super.resumeThread(threadId, tools, settings, workspace);
      authority.current();
      await authority.confirm(key, threadId);
    }
    override async startTurn(
      threadId: string,
      workspace: string,
      prompt: string,
      settings?: RuntimeTurnSettings,
      policy?: RuntimeTurnPolicy,
    ) {
      const scope = settingsFor(workspace, settings);
      if (this.threadScopes.get(threadId) !== workspace)
        throw Error("v2-turn-thread-binding");
      const intents = service
        .list()
        .filter(
          (v) =>
            v.state === "submitting" &&
            v.threadId === threadId &&
            v.workspace === workspace &&
            v.prompt === prompt,
        );
      if (intents.length !== 1) throw Error("v2-turn-intent-ambiguous");
      const intent = intents[0]!;
      const request = service.turnRequest(intent.workId);
      if (
        !request ||
        request.taskId !== scope.taskId ||
        request.assignmentId !== scope.assignmentId ||
        request.projectId !== m.resource.projectId ||
        request.workspace !== workspace ||
        request.prompt !== prompt
      )
        throw Error("v2-turn-request-binding");
      const material = {
        taskId: scope.taskId,
        assignmentId: scope.assignmentId,
        workspace,
        promptSha256: materialHash(prompt),
        settingsSha256: materialHash(settings ?? null),
        policySha256: materialHash(policy ?? null),
        taskVersion: request.taskVersion,
        assignmentVersion: request.assignmentVersion,
        instructionsRevision: request.instructionsRevision,
        profileRevision: request.profileRevision,
      };
      const key = `runtime:turn:${intent.workId}`;
      await authority.reserve("runtime.turn", material, key);
      authority.current();
      const current = service
        .list()
        .filter(
          (v) =>
            v.workId === intent.workId &&
            v.state === "submitting" &&
            v.threadId === threadId &&
            v.workspace === workspace &&
            v.prompt === prompt,
        );
      if (
        current.length !== 1 ||
        materialHash(service.turnRequest(intent.workId)) !==
          materialHash(request)
      )
        throw Error("v2-turn-intent-changed");
      const turnId = await super.startTurn(
        threadId,
        workspace,
        prompt,
        settings,
        policy,
      );
      authority.current();
      if (!turnId) throw Error("v2-turn-result-unproved");
      await authority.confirm(
        key,
        materialHash({ threadId, turnId, process: this.processIdentity() }),
      );
      return turnId;
    }
    override async stop() {
      const process = this.processIdentity();
      const key = "runtime:stop";
      await authority.reserve("runtime.stop", { process }, key, true);
      authority.current(true);
      await super.stop();
      authority.current(true);
      // The service's supervisor and termination verifier remain responsible for exact exit proof.
    }
  }
  const provider = () =>
    new GitHubHttpDeliveryProvider(
      () => credential(m.credentialRef),
      transport,
      async () => {
        throw Error("v2-git-publication-denied");
      },
      undefined,
      "github.com",
      authority,
    );
  service = new StandaloneService(
    m.authority.host.dataDirectory,
    (context: RuntimeSpawnContext, harness) => {
      authority.current();
      if (harness !== "codex" || runtime)
        throw Error("v2-runtime-factory-refused");
      runtime = new BoundRuntime(
        m.authority.host.runtimeExecutable.path,
        context,
      );
      return runtime;
    },
    undefined,
    {
      runtimeHarnesses: ["codex"],
      routingClient: null,
      power: { enabled: false },
      resolveExecutable: async () => {
        authority.current();
        return true;
      },
      delivery: {
        providerFactories: {
          github: (projectId, policy, host) => {
            authority.current();
            if (
              projectId !== m.resource.projectId ||
              policy.credentialRef !== m.credentialRef ||
              host !== "github.com"
            )
              throw Error("v2-provider-binding");
            return provider();
          },
        },
      },
      issueTrackers: {
        readerFactories: {
          github: () => {
            throw Error("v2-source-discovery-denied");
          },
        },
      },
    },
  );
  const api = new OperatorApi(service);
  const task = m.resource.upperTask;
  const scoped = (taskId: string) => {
    authority.current();
    if (taskId !== task) throw Error("v2-task-scope");
  };
  let refreshes = 0;
  let reconciles = 0;
  return {
    authority,
    async refresh() {
      const key = `service:refresh:${++refreshes}`;
      await authority.reserve(
        "service.refresh",
        { projectId: m.resource.projectId },
        key,
      );
      await service.refreshGitHub();
      authority.current();
      await authority.confirm(key, m.resource.projectId);
    },
    async preview(taskId: string) {
      scoped(taskId);
      const key = "service:unstack:preview";
      await authority.reserve("service.unstack.preview", { taskId }, key);
      const result = await api.readUnstack(taskId);
      authority.current();
      await authority.confirm(key, materialHash(result));
      return result;
    },
    async unstack(command: unknown) {
      const parsed = operatorCommandSchema.parse(command);
      if (
        parsed.type !== "task.unstack" ||
        parsed.taskId !== task ||
        materialHash(command) !== m.resource.unstackCommandSha256
      )
        throw Error("v2-unstack-command");
      await authority.reserve(
        "service.unstack.execute",
        command,
        "service:unstack:execute",
      );
      const result = await api.execute(parsed);
      authority.current();
      await authority.confirm("service:unstack:execute", materialHash(result));
      return result;
    },
    async reconcile(operationKey: string) {
      authority.current();
      if (operationKey !== m.resource.operationKey)
        throw Error("v2-original-operation");
      const key = `service:unstack:reconcile:${++reconciles}`;
      await authority.reserve(
        "service.unstack.reconcile",
        { operationKey },
        key,
      );
      const result = await service.reconcileTaskUnstack(operationKey);
      authority.current();
      await authority.confirm(key, materialHash(result ?? null));
      return result;
    },
    async receipt() {
      const material = {
        scope: `task:${task}`,
        type: "task.unstack",
        key: m.resource.operationKey,
      };
      const key = "service:operation:read";
      await authority.reserve("service.operation.read", material, key);
      const result = await api.readOperation(new URLSearchParams(material));
      authority.current();
      await authority.confirm(key, materialHash(result));
      return result;
    },
    audit() {
      scoped(task);
      return {
        delivery: service.delivery().delivery(task),
        edge: service.domain().activeStackedDependency(task),
        journal: service.taskUnstackOperation(task, m.resource.operationKey),
      };
    },
    async stop() {
      const key = "service:stop";
      await authority.reserve(
        "service.stop",
        { dataDirectory: m.authority.host.dataDirectory },
        key,
        true,
      );
      authority.current(true);
      await service.stop();
      authority.current(true);
    },
    async start() {
      await authority.reserve(
        "service.start",
        {
          dataDirectory: m.authority.host.dataDirectory,
          configSha256: m.authority.host.configSha256,
        },
        "service:start",
      );
      authority.current();
      await service.start();
      authority.current();
      await authority.confirm("service:start", m.resource.projectId);
    },
  };
}
