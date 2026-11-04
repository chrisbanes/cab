import { auditPreparedStack } from "./stack-audit.js";
import { bindStackRuntime } from "./stack-runtime.js";
import { verifyPreparedStackResources } from "./stack-resource-preflight.js";
import { CodexRuntime, type Runtime } from "../../../src/standalone/codex.js";
import {
  StandaloneService,
  type RuntimeSpawnContext,
} from "../../../src/standalone/service.js";
import { OperatorApi } from "../../../src/standalone/operator-api.js";
import { GitHubHttpDeliveryProvider } from "../../../src/standalone/github-delivery.js";
import { unstackReceiptSchema } from "../../../src/operator/unstack-contracts.js";
import {
  operationReadSchema,
  operatorCommandSchema,
} from "../../../src/operator/contracts.js";
import { type StackV2Authority, materialHash } from "./stack-authority.js";

/** Real constructors are reached only after independently supplied v2 scope and host pins pass. */
export async function createRealStackAdapter(
  authority: StackV2Authority,
  credential: (reference: string) => Promise<string | undefined>,
  transport: typeof fetch = fetch,
) {
  await authority.open();
  try {
    await verifyPreparedStackResources(authority);
  } catch (error) {
    await authority.close();
    throw error;
  }
  const m = authority.manifest;
  let service: StandaloneService;
  let runtime: Runtime | undefined;
  const boundaryFor = (role: "script" | "service") =>
    new Proxy(authority, {
      get(target, property) {
        if (property === "fixtureRole") return role;
        if (property === "beforeCredential" || property === "beforeDispatch")
          return async (
            request: Parameters<StackV2Authority["beforeCredential"]>[0],
          ) => {
            const write = m.authority.writes.some(
              (rule) =>
                rule.request.url === request.url &&
                rule.request.method === request.method,
            );
            if (
              write &&
              (role === "service"
                ? request.method === "PUT"
                : request.method !== "PUT")
            )
              throw Error("v2-provider-effect-owner");
            return target[property](request);
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const provider = (role: "script" | "service" = "service") =>
    new GitHubHttpDeliveryProvider(
      () => credential(m.credentialRef),
      transport,
      async () => {
        throw Error("v2-git-publication-denied");
      },
      undefined,
      "github.com",
      boundaryFor(role),
    );
  // Identity bootstrap uses the exact same HTTP/credential boundaries as later calls,
  // and completes before constructing a service that can migrate or schedule work.
  const fixtureProvider = provider("script");
  try {
    await fixtureProvider.readFixtureIdentity(m.resource.repositoryNodeId);
  } catch (error) {
    await authority.close();
    throw error;
  }
  service = new StandaloneService(
    m.authority.host.dataDirectory,
    (context: RuntimeSpawnContext, harness) => {
      authority.current();
      if (harness !== "codex" || runtime)
        throw Error("v2-runtime-factory-refused");
      runtime = bindStackRuntime(
        new CodexRuntime(m.authority.host.runtimeExecutable.path, context),
        authority,
        () => service,
      );
      return runtime;
    },
    undefined,
    {
      runtimeHarnesses: ["codex"],
      routingClient: null,
      power: { enabled: false },
      workspaceManager: { gitExecutable: m.authority.host.gitExecutable.path },
      resolveExecutable: async () => {
        authority.current();
        return true;
      },
      delivery: {
        issueTrackerFactories: {
          github: (projectId, policy, host) => {
            authority.current();
            if (
              projectId !== m.resource.projectId ||
              policy.credentialRef !== m.credentialRef ||
              host !== "github.com"
            )
              throw Error("v2-issue-tracker-binding");
            return provider();
          },
          jira: () => {
            throw Error("v2-jira-not-granted");
          },
        },
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
        intervalMs: 3_600_000,
        readerFactories: {
          jira: () => {
            throw Error("v2-jira-not-granted");
          },
          github: () => {
            throw Error("v2-source-discovery-denied");
          },
        },
      },
    },
  );
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
  let api: OperatorApi | undefined;
  const operator = () => {
    authority.current();
    if (!api) throw Error("v2-service-not-started");
    return api;
  };
  const task = m.resource.upperTask;
  const scoped = (taskId: string) => {
    authority.current();
    if (taskId !== task) throw Error("v2-task-scope");
  };
  let refreshes = 0;
  let reconciles = 0;
  let observations = 0;
  let polls = 0;
  let audits = 0;
  return {
    authority,
    image: () => authority.workspaceImage(),
    async observeProvider() {
      const material = {
        repositoryId: m.resource.repositoryNodeId,
        lowerPr: m.resource.lowerPr,
        upperPr: m.resource.upperPr,
      };
      const key = `fixture:observe:${++observations}`;
      await authority.reserve("fixture.observe", material, key);
      const observed = await invoke(key, async () => {
        const lower = await fixtureProvider.observeFixturePr(
          m.resource.repositoryNodeId,
          m.resource.lowerPr,
          m.resource.lowerPrId,
        );
        const upper = await fixtureProvider.observeFixturePr(
          m.resource.repositoryNodeId,
          m.resource.upperPr,
          m.resource.upperPrId,
        );
        return { lower, upper };
      });
      authority.current();
      await authority.confirm(key, materialHash(observed));
      return observed;
    },
    async mergeLower() {
      if (m.scenario !== "merge-adoption") throw Error("v2-merge-scenario");
      const rule = m.authority.writes.find(
        (value) => value.id === m.authority.captures.mergeRuleId,
      );
      if (!rule) throw Error("v2-merge-not-granted");
      const method = JSON.parse(rule.request.body).merge_method as
        | "merge"
        | "squash"
        | "rebase";
      const action = {
        kind: "pr.merge" as const,
        method,
        reviewedResultIds: [],
        target: {
          repositoryId: m.resource.repositoryNodeId,
          number: m.resource.lowerPr,
          nodeId: m.resource.lowerPrId,
          headRef: m.resource.lowerRef,
          baseRef: m.resource.base,
          expectedHeadSha: m.resource.lowerHead,
        },
      };
      await authority.reserve("fixture.merge", action, "fixture:merge");
      const result = await invoke("fixture:merge", () =>
        fixtureProvider.mergeFixtureLower(
          action,
          service.delivery().configuration(m.resource.projectId),
        ),
      );
      authority.current();
      if (
        !result.uuid ||
        result.uuid !== authority.snapshot().captures.mergeRequest
      )
        throw Error("v2-merge-receipt-unproved");
      await authority.confirm(
        "fixture:merge",
        materialHash({ uuid: result.uuid, status: result.status }),
      );
      return { uuid: result.uuid, status: result.status };
    },
    async pollMerge() {
      const uuid = authority.snapshot().captures.mergeRequest;
      if (m.scenario !== "merge-adoption" || !uuid)
        throw Error("v2-original-merge-required");
      const material = {
        repositoryId: m.resource.repositoryNodeId,
        number: m.resource.lowerPr,
        operationKey: m.resource.operationKey,
      };
      const key = `fixture:poll:${++polls}`;
      await authority.reserve("fixture.poll", material, key);
      const result = await invoke(key, () =>
        fixtureProvider.pollFixtureMerge(
          m.resource.repositoryNodeId,
          m.resource.lowerPr,
          uuid,
        ),
      );
      authority.current();
      await authority.confirm(
        key,
        materialHash({ uuid, status: result.status }),
      );
      return result.status;
    },
    executions() {
      authority.current();
      return service.list().map((intent) => ({
        workId: intent.workId,
        state: intent.state,
        threadId: intent.threadId,
        turnId: intent.turnId,
      }));
    },
    async refresh() {
      const key = `service:refresh:${++refreshes}`;
      await authority.reserve(
        "service.refresh",
        { projectId: m.resource.projectId },
        key,
      );
      await invoke(key, () => service.refreshGitHub());
      authority.current();
      await authority.confirm(key, m.resource.projectId);
    },
    async preview(taskId: string) {
      scoped(taskId);
      const key = "service:unstack:preview";
      await authority.reserve("service.unstack.preview", { taskId }, key);
      const result = await invoke(key, () => operator().readUnstack(taskId));
      authority.current();
      await authority.confirm(key, materialHash(result));
      return result;
    },
    async unstack(command: unknown) {
      const parsed = operatorCommandSchema.parse(command);
      if (
        parsed.type !== "task.unstack" ||
        parsed.taskId !== task ||
        parsed.key !== m.resource.operationKey ||
        materialHash(command) !== m.resource.unstackCommandSha256
      )
        throw Error("v2-unstack-command");
      if (service.taskUnstackOperation(task, m.resource.operationKey))
        throw Error("v2-original-unstack-readback-only");
      await authority.reserve(
        "service.unstack.execute",
        command,
        "service:unstack:execute",
      );
      const result = await invoke("service:unstack:execute", () =>
        operator().execute(parsed),
      );
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
      const result = await invoke(key, () =>
        service.reconcileTaskUnstack(operationKey),
      );
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
      const result = operationReadSchema.parse(
        await invoke(key, () =>
          operator().readOperation(new URLSearchParams(material)),
        ),
      );
      if (result.data.state === "recorded") {
        const receipt = unstackReceiptSchema.parse(result.data.receipt);
        if (receipt.key !== m.resource.operationKey || receipt.taskId !== task)
          throw Error("v2-original-receipt-binding");
      }
      authority.current();
      await authority.confirm(key, materialHash(result));
      return result;
    },
    async audit() {
      scoped(task);
      const key = `service:observe:${++audits}`;
      await authority.reserve(
        "service.observe",
        { taskId: task, operationKey: m.resource.operationKey },
        key,
      );
      const result = await invoke(key, async () =>
        auditPreparedStack(authority),
      );
      authority.current();
      await authority.confirm(key, materialHash(result));
      return result;
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
      await invoke(key, () => service.stop());
      authority.current(true);
      await authority.confirm(
        key,
        materialHash({
          stopped: true,
          processExit: authority.snapshot().processExit,
        }),
        true,
      );
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
      await invoke("service:start", () => service.start());
      authority.current();
      api = new OperatorApi(service);
      await authority.confirm("service:start", m.resource.projectId);
    },
  };
}
