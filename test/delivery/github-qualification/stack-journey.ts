import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { rebaseProofSchema } from "../../../src/core/rebase-proof.js";
import { operatorCommandSchema } from "../../../src/operator/contracts.js";
import {
  unstackReadSchema,
  unstackReceiptSchema,
} from "../../../src/operator/unstack-contracts.js";
import type { OperatorApi } from "../../../src/standalone/operator-api.js";
import type { StandaloneService } from "../../../src/standalone/service.js";
import {
  StackFixtureGuard,
  StackFixtureRunner,
  stackManifestSchema,
} from "./stack-guard.js";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const oid = z.string().regex(/^[0-9a-f]{40}$/);
const text = z.string().min(1).max(512);
const id = z.string().uuid();
export const stackMaterialHash = (raw: string) =>
  createHash("sha256").update(raw).digest("hex");
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw Error("Missing bounded provider response");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 65536) throw Error("Provider output bound exceeded");
      chunks.push(part.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
const imageSchema = z
  .object({ head: oid, index: digest, files: digest })
  .strict();
const resourceSchema = stackManifestSchema.shape.resource.omit({
  materialSha256: true,
});
/** A proposed composition receipt, pinned byte-for-byte by resource.materialSha256. Not a grant. */
export const stackReadinessSchema = z
  .object({
    version: z.literal(1),
    runId: id,
    observedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    host: z
      .object({ id: text, runtime: text, version: text, credentialRef: text })
      .strict(),
    observed: resourceSchema,
    scenario: z.enum(["merge-adoption", "unstack"]),
    maxElapsedMs: z.number().int().min(1).max(1_200_000),
    // These operation ids must already occur in the independently supplied provider grant.
    mergeOperation: text.nullable(),
    equivalentRebaseOperation: text.nullable(),
    unstackCommand: operatorCommandSchema.nullable(),
    cleanupOperations: z.array(text).max(8),
  })
  .strict();
type Resource = z.output<typeof stackManifestSchema>["resource"];
const observationSchema = z
  .object({
    taskId: id,
    repositoryNodeId: text,
    prId: text,
    head: oid,
    baseRef: text,
    baseSha: oid,
    acceptedBaseRef: text,
    outsideHead: oid.nullable(),
    workspace: imageSchema,
    proofs: z.array(rebaseProofSchema).max(256),
    selectedEdgeActive: z.boolean(),
    restackSequence: z.number().int().nonnegative(),
  })
  .strict();
type Observation = z.output<typeof observationSchema>;
const mergeResponseSchema = z.object({
  status: z.enum(["pending", "enqueued", "merged", "failed"]),
  details: z.object({ uuid: z.string().min(1).max(128).optional() }),
});
const runtimeReceiptSchema = z
  .object({ taskId: id, operationId: text, threadId: text, turnId: text })
  .strict();
const effectSchema = z
  .object({
    identity: digest,
    phase: z.enum(["intent", "sent", "confirmed", "unknown"]),
  })
  .strict();
const resultSchema = z
  .object({
    version: z.literal(1),
    mode: z.literal("offline-injected"),
    runId: id,
    manifestSha256: digest,
    readinessSha256: digest,
    expiresAt: z.iso.datetime(),
    resource: stackManifestSchema.shape.resource,
    startedAt: z.number().int().nonnegative(),
    baseline: observationSchema.nullable(),
    stage: text,
    disposition: z.enum(["unfinished", "held", "recorded"]),
    writes: z.number().int().nonnegative(),
    turns: z.number().int().nonnegative(),
    reads: z.number().int().nonnegative(),
    effects: z.record(text, effectSchema),
    runtimeReceipts: z.record(text, runtimeReceiptSchema),
    mergeRequestId: z.string().min(1).max(128).nullable(),
    platformRebase: z.enum(["unobserved", "observed", "not-observed"]),
    adoption: z.enum(["unproved", "verified", "fixture-equivalent"]),
    cleanup: z.enum(["not-requested", "unfinished", "confirmed"]),
    failure: z
      .enum([
        "unknown-effect",
        "unproved-readback",
        "authority",
        "unsupported",
        "storage",
      ])
      .nullable(),
  })
  .strict();
type Result = z.output<typeof resultSchema>;

/** No default transport, credential implementation, host setup, process spawn or service constructor. */
export interface StackJourneyPorts {
  credential(reference: string): Promise<string>;
  transport: typeof fetch;
  // The implementation must apply `beforeTurn` to EVERY real runtime turn, not just requested ones.
  turn(
    taskId: string,
    operationId: string,
    beforeTurn: () => Promise<number>,
  ): Promise<void>;
  readTurn(taskId: string, operationId: string): Promise<unknown>;
  service: Pick<OperatorApi, "readUnstack" | "execute" | "readOperation"> &
    Pick<StandaloneService, "refreshGitHub" | "reconcileTaskUnstack">;
  observe(taskId: string): Promise<unknown>;
  // Exact operation identity plus count, from captured fixture ownership, never a receipt inference.
  restack(
    operationId: string,
  ): Promise<{ operationId: string; count: number; newBaseSha: string }>;
}
export type StackPortFactory = (scope: {
  resource: Resource;
  providerSend(id: string): Promise<Response>;
  providerReadback(
    id: string,
    confirms: (response: Response) => Promise<boolean>,
  ): Promise<string>;
}) => StackJourneyPorts;

/** All input/identity/expiry checks precede factory invocation and checkpoint/provider effects. */
export function authorizeStackComposition(
  raw: string,
  grant: unknown,
  readinessRaw: string,
  now = Date.now,
) {
  if (
    [raw, JSON.stringify(grant), readinessRaw].some(
      (value) => typeof value !== "string" || Buffer.byteLength(value) > 262144,
    )
  )
    throw Error("Missing or oversized composition input");
  const guard = new StackFixtureGuard(raw, grant, now),
    r = stackReadinessSchema.parse(JSON.parse(readinessRaw));
  const m = guard.manifest;
  if (
    stackMaterialHash(readinessRaw) !== m.resource.materialSha256 ||
    r.runId !== m.runId ||
    r.host.credentialRef !== m.credentialRef ||
    Date.parse(r.observedAt) > now() ||
    now() - Date.parse(r.observedAt) > 300_000 ||
    now() >= Date.parse(r.expiresAt) ||
    Date.parse(r.expiresAt) > Date.parse(guard.expiresAt)
  )
    throw Error("Readiness mismatch or expired");
  guard.assertObserved({
    ...r.observed,
    materialSha256: m.resource.materialSha256,
  });
  if (
    m.operations.some((op) => op.id.length > 64) ||
    new Set(m.resource.taskIds).size !== 2 ||
    new Set(m.resource.refs.map((ref) => ref.name)).size !==
      m.resource.refs.length ||
    new Set(m.resource.prs.map((pr) => pr.id)).size !== m.resource.prs.length ||
    new Set(m.resource.prs.map((pr) => pr.number)).size !==
      m.resource.prs.length ||
    m.resource.prs.some(
      (pr) => !m.resource.refs.some((ref) => ref.name === pr.head),
    ) ||
    m.resource.stack.length !== m.resource.prs.length ||
    m.resource.stack[0] !== m.resource.prs[0]!.id ||
    m.resource.stack[1] !== m.resource.prs[1]!.id ||
    m.resource.stack.some(
      (pr) => !m.resource.prs.some((member) => member.id === pr),
    ) ||
    m.resource.prs[0]!.base !== m.resource.base ||
    m.resource.prs[1]!.base !== m.resource.prs[0]!.head
  )
    throw Error("Ambiguous or incomplete two-layer fixture identity");
  const operation = (id: string) => {
    const op = m.operations.find((o) => o.id === id);
    if (!op) throw Error("Unlisted composition operation");
    return op;
  };
  for (const name of r.cleanupOperations) {
    const op = operation(name);
    const ref = m.resource.refs.find(
      (ref) =>
        op.send.path ===
        `/repos/${m.resource.repository}/git/refs/heads/${ref.name}`,
    );
    if (
      !op.cleanup ||
      op.send.method !== "DELETE" ||
      op.send.body !== "" ||
      !ref ||
      op.readback.path !==
        `/repos/${m.resource.repository}/git/ref/heads/${ref.name}`
    )
      throw Error("Cleanup is not an explicitly granted captured ref");
  }
  if (new Set(r.cleanupOperations).size !== r.cleanupOperations.length)
    throw Error("Duplicate cleanup");
  if (r.scenario === "merge-adoption") {
    if (!r.mergeOperation || r.unstackCommand !== null)
      throw Error("Wrong merge scenario material");
    const op = operation(r.mergeOperation),
      lower = m.resource.prs[0]!;
    if (
      op.cleanup ||
      op.send.method !== "PUT" ||
      op.send.path !==
        `/repos/${m.resource.repository}/pulls/${lower.number}/merge-async` ||
      op.readback.path !==
        `/repos/${m.resource.repository}/pulls/${lower.number}`
    )
      throw Error("Wrong lower merge operation");
    const body = z
      .object({
        sha: oid,
        merge_method: z.enum(["merge", "squash", "rebase"]),
        bypass_rules: z.literal(false),
      })
      .strict()
      .parse(JSON.parse(op.send.body));
    if (
      body.sha !== m.resource.refs.find((ref) => ref.name === lower.head)?.sha
    )
      throw Error("Wrong merge head");
    if (r.equivalentRebaseOperation) {
      const equivalent = operation(r.equivalentRebaseOperation),
        upper = m.resource.prs[1]!;
      if (
        equivalent.cleanup ||
        equivalent.send.method !== "PATCH" ||
        equivalent.send.path !==
          `/repos/${m.resource.repository}/git/refs/heads/${upper.head}` ||
        equivalent.readback.path !==
          `/repos/${m.resource.repository}/git/ref/heads/${upper.head}`
      )
        throw Error("Wrong fixture-equivalent scope");
      z.object({ sha: oid, force: z.literal(false) })
        .strict()
        .parse(JSON.parse(equivalent.send.body));
    }
  } else {
    const unstack = operation("unstack"),
      retarget = operation("retarget");
    const stackRoot = `/repos/${m.resource.repository}/stacks/`;
    const stackPath =
      unstack.send.path.startsWith(stackRoot) &&
      /^[1-9][0-9]*\/unstack$/.test(unstack.send.path.slice(stackRoot.length));
    if (
      !stackPath ||
      unstack.cleanup ||
      unstack.send.method !== "POST" ||
      unstack.send.body !== "" ||
      unstack.readback.path !==
        unstack.send.path.slice(0, -"/unstack".length) ||
      retarget.cleanup ||
      retarget.send.method !== "PATCH" ||
      retarget.send.path !==
        `/repos/${m.resource.repository}/pulls/${m.resource.prs[1]!.number}` ||
      retarget.send.body !== JSON.stringify({ base: m.resource.base }) ||
      retarget.readback.path !== retarget.send.path
    )
      throw Error("Wrong Unstack/retarget operation scope");
    if (
      r.mergeOperation ||
      r.equivalentRebaseOperation ||
      r.unstackCommand?.type !== "task.unstack" ||
      r.unstackCommand.taskId !== m.resource.taskIds[1]
    )
      throw Error("Wrong Unstack scenario material");
  }
  const used = new Set([
    ...(r.scenario === "merge-adoption"
      ? [
          r.mergeOperation!,
          ...(r.equivalentRebaseOperation ? [r.equivalentRebaseOperation] : []),
        ]
      : ["unstack", "retarget"]),
    ...r.cleanupOperations,
  ]);
  if (
    m.operations.some((op) => !used.has(op.id)) ||
    r.cleanupOperations.some(
      (name) =>
        name === r.mergeOperation ||
        name === r.equivalentRebaseOperation ||
        ["unstack", "retarget"].includes(name),
    )
  )
    throw Error("Unused or ambiguous composition operation");
  // Commands and refreshes count too; a provider-only allowance never becomes unlimited service work.
  const minimumEffects =
    (r.scenario === "merge-adoption"
      ? 4 + (r.equivalentRebaseOperation ? 2 : 0)
      : 1) +
    m.operations.length +
    r.cleanupOperations.length;
  if (
    minimumEffects > m.maxWrites ||
    m.runtimeTurns < (r.scenario === "merge-adoption" ? 2 : 1)
  )
    throw Error("Composition exceeds the existing finite write/turn allowance");
  return {
    guard,
    readiness: r,
    readinessSha256: stackMaterialHash(readinessRaw),
    now,
  };
}

/** Exact, already-created resources only; this composition invents no branch/PR/task identities. */
export async function runStackComposition(options: {
  manifest: string;
  grant: unknown;
  readiness: string;
  resultPath: string;
  factory: StackPortFactory;
  now?: () => number;
}): Promise<Result> {
  const authority = authorizeStackComposition(
      options.manifest,
      options.grant,
      options.readiness,
      options.now,
    ),
    { guard, readiness: r, now } = authority,
    m = guard.manifest;
  if (!isAbsolute(options.resultPath))
    throw Error("Absolute result path required");
  const lockPath = `${options.resultPath}.lock`;
  let state: Result;
  const identities = new Map<string, string>();
  const register = (name: string, material: unknown) => {
    if (identities.has(name)) throw Error("Ambiguous stage identity");
    identities.set(name, stackMaterialHash(JSON.stringify(material)));
  };
  for (const op of m.operations) register(`provider-${op.id}`, op);
  if (r.scenario === "merge-adoption") {
    for (const index of [0, 1])
      register(`runtime-${index}`, {
        taskId: m.resource.taskIds[index],
        operationId: `${m.runId}:runtime:${index}`,
      });
    register(
      r.mergeOperation!,
      m.operations.find((op) => op.id === r.mergeOperation),
    );
    register("refresh", {
      method: "StandaloneService.refreshGitHub",
      taskIds: m.resource.taskIds,
    });
    if (r.equivalentRebaseOperation) {
      register(
        r.equivalentRebaseOperation,
        m.operations.find((op) => op.id === r.equivalentRebaseOperation),
      );
      register("equivalent-refresh", {
        method: "StandaloneService.refreshGitHub",
        after: r.equivalentRebaseOperation,
      });
    }
  } else register("operator-unstack", r.unstackCommand);
  for (const name of r.cleanupOperations)
    register(
      name,
      m.operations.find((op) => op.id === name),
    );
  const secrets = new Set<string>();
  let active = true,
    cleanupAllowed = false;
  let deadline = Math.min(Date.parse(r.expiresAt), Date.parse(guard.expiresAt));
  const current = () => {
    if (!active) throw Error("Composition closed");
    guard.current();
    if (now() >= deadline) throw Error("Composition expired");
  };
  const save = async () => {
    current();
    const raw = JSON.stringify(resultSchema.parse(state));
    if (Buffer.byteLength(raw) > 1_048_576)
      throw Error("Checkpoint output bound exceeded");
    if ([...secrets].some((secret) => raw.includes(secret)))
      throw Error("Secret in checkpoint refused");
    const temporary = `${options.resultPath}.tmp`,
      file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(raw);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, options.resultPath);
    const directory = await open(dirname(options.resultPath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  };
  if (
    (await realpath(dirname(options.resultPath))) !==
    dirname(options.resultPath)
  )
    throw Error("Noncanonical result directory");
  for (const path of [options.resultPath, `${options.resultPath}.provider`]) {
    try {
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size > 1_048_576
      )
        throw Error("Unsafe checkpoint path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const path of [
    `${options.resultPath}.tmp`,
    `${options.resultPath}.provider.tmp`,
    `${options.resultPath}.provider.lock`,
  ]) {
    try {
      await lstat(path);
      throw Error("Unresolved checkpoint artifact");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  current();
  const lock = await open(lockPath, "wx", 0o600);
  try {
    try {
      const info = await lstat(options.resultPath);
      if (!info.isFile() || info.isSymbolicLink())
        throw Error("Unsafe result file");
      state = resultSchema.parse(
        JSON.parse(await readFile(options.resultPath, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = {
        version: 1,
        mode: "offline-injected",
        runId: m.runId,
        manifestSha256: guard.manifestSha256,
        readinessSha256: authority.readinessSha256,
        expiresAt: guard.expiresAt,
        resource: m.resource,
        startedAt: now(),
        baseline: null,
        stage: "prepared",
        disposition: "unfinished",
        writes: 0,
        turns: 0,
        reads: 0,
        effects: {},
        runtimeReceipts: {},
        mergeRequestId: null,
        platformRebase: "unobserved",
        adoption: "unproved",
        cleanup: "not-requested",
        failure: null,
      };
    }
    if (
      state.manifestSha256 !== guard.manifestSha256 ||
      state.readinessSha256 !== authority.readinessSha256 ||
      state.runId !== m.runId ||
      state.expiresAt !== guard.expiresAt ||
      JSON.stringify(state.resource) !== JSON.stringify(m.resource) ||
      state.writes !== Object.keys(state.effects).length ||
      (state.writes > 0 && !state.baseline) ||
      state.writes > m.maxWrites ||
      state.turns > m.runtimeTurns ||
      state.reads > 128 ||
      state.startedAt > now() ||
      Object.entries(state.effects).some(
        ([name, entry]) => identities.get(name) !== entry.identity,
      ) ||
      Object.entries(state.runtimeReceipts).some(
        ([key, receipt]) =>
          !m.resource.taskIds.some(
            (task, index) =>
              key === `${m.runId}:runtime:${index}` &&
              receipt.operationId === key &&
              receipt.taskId === task,
          ),
      ) ||
      Object.keys(state.runtimeReceipts).length > state.turns
    )
      throw Error("Composition checkpoint mismatch");
    deadline = Math.min(deadline, state.startedAt + r.maxElapsedMs);
    current();
    const localFault = (error: unknown) =>
      error &&
      typeof error === "object" &&
      "code" in error &&
      [
        "EIO",
        "ENOSPC",
        "EACCES",
        "EPERM",
        "EROFS",
        "EEXIST",
        "ENOENT",
      ].includes(String(error.code));
    // A restarted runtime or service command is read back, never sent with an old OR new key.
    const effect = async (
      name: string,
      material: unknown,
      send: () => Promise<void>,
      readback: () => Promise<boolean>,
    ) => {
      current();
      const identity = stackMaterialHash(JSON.stringify(material));
      if (identities.get(name) !== identity)
        throw Error("Unlisted stage material");
      const prior = state.effects[name];
      if (prior && prior.identity !== identity)
        throw Error("Frozen effect mismatch");
      if (prior?.phase === "confirmed") return true;
      if (!prior) {
        if (state.writes >= m.maxWrites)
          throw Error("Composition write budget exhausted");
        state.effects[name] = { identity, phase: "intent" };
        state.writes++;
        state.stage = name;
        await save();
        state.effects[name]!.phase = "sent";
        await save();
        current();
        try {
          await send();
        } catch (error) {
          if (localFault(error)) throw error;
          state.effects[name]!.phase = "unknown";
          state.failure = "unknown-effect";
          await save();
          return false;
        }
      }
      if (state.reads >= 128)
        throw Error("Composition readback budget exhausted");
      state.reads++;
      state.stage = `${name}-readback`;
      await save();
      current();
      let confirmed: boolean;
      try {
        confirmed = await readback();
      } catch (error) {
        if (localFault(error)) throw error;
        state.failure = "unproved-readback";
        await save();
        return false;
      }
      current();
      state.effects[name]!.phase = confirmed ? "confirmed" : "unknown";
      state.failure = confirmed ? null : "unproved-readback";
      await save();
      return confirmed;
    };
    const wait = async <T>(work: () => Promise<T>): Promise<T> => {
      current();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          work(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error("Bounded continuation outcome unknown")),
              Math.min(20000, Math.max(1, deadline - now())),
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const providerTransport: typeof fetch = async (input, init) => {
      current();
      const headers = new Headers(init?.headers);
      headers.set("accept", "application/vnd.github+json");
      headers.set("x-github-api-version", "2026-03-10");
      return wait(() => ports.transport(input, { ...init, headers }));
    };
    const provider = new StackFixtureRunner(
      guard,
      `${options.resultPath}.provider`,
    );
    let ports: StackJourneyPorts;
    const credential = async (reference: string) => {
      current();
      const token = await wait(() => ports.credential(reference));
      current();
      if (!token || JSON.stringify(m).includes(token))
        throw Error("Unsafe fixture credential");
      secrets.add(token);
      return token;
    };
    const providerSend = async (name: string) => {
      const op = m.operations.find((o) => o.id === name);
      if (!op) throw Error("Unlisted operation");
      current();
      if (
        op.cleanup &&
        (!cleanupAllowed || !r.cleanupOperations.includes(name))
      )
        throw Error("Cleanup is not currently authorized");
      const key = `provider-${name}`;
      if (state.effects[key])
        throw Error("Provider send cannot repeat; read original intent only");
      if (state.writes >= m.maxWrites)
        throw Error("Composition write budget exhausted");
      state.effects[key] = { identity: identities.get(key)!, phase: "intent" };
      state.writes++;
      await save();
      state.effects[key]!.phase = "sent";
      await save();
      current();
      return provider.send(
        name,
        op.send.method,
        op.send.path,
        op.send.body,
        credential,
        providerTransport,
      );
    };
    const providerReadback = async (
      name: string,
      confirms: (response: Response) => Promise<boolean>,
    ) => {
      const key = `provider-${name}`;
      if (!state.effects[key] || state.reads >= 128)
        throw Error("No provider intent or exhausted read budget");
      current();
      state.reads++;
      state.stage = `${key}-readback-intent`;
      await save();
      const phase = await provider.readback(
        name,
        credential,
        providerTransport,
        async (response) => {
          current();
          return wait(() => confirms(response));
        },
      );
      current();
      state.effects[key]!.phase =
        phase === "confirmed" ? "confirmed" : "unknown";
      state.stage = `${key}-readback-${phase}`;
      await save();
      return phase;
    };
    // The caller injects synthetic ports. There is deliberately no real adapter in the CLI.
    state.stage = "ports-binding";
    await save();
    current();
    ports = options.factory({
      resource: structuredClone(m.resource),
      providerSend,
      providerReadback,
    });
    const observe = async (): Promise<Observation> => {
      current();
      if (state.reads >= 128) throw Error("Read budget exhausted");
      state.reads++;
      state.stage = "task-observation-intent";
      await save();
      const value = observationSchema.parse(
        await wait(() => ports.observe(m.resource.taskIds[1]!)),
      );
      current();
      if (
        value.taskId !== m.resource.taskIds[1] ||
        value.repositoryNodeId !== m.resource.repositoryNodeId ||
        value.prId !== m.resource.prs[1]?.id
      )
        throw Error("Observed task/resource mismatch");
      state.stage = "task-observation-confirmed";
      await save();
      return value;
    };
    const turn = (index: number) => {
      const taskId = m.resource.taskIds[index]!,
        operationId = `${m.runId}:runtime:${index}`;
      return effect(
        `runtime-${index}`,
        { taskId, operationId },
        async () => {
          const priorTurns = state.turns;
          await wait(() =>
            ports.turn(taskId, operationId, async () => {
              current();
              if (state.turns >= m.runtimeTurns)
                throw Error("Runtime turn budget exhausted");
              state.turns++;
              await save();
              current();
              const permit = await provider.beginRuntimeTurn();
              current();
              return permit;
            }),
          );
          if (state.turns !== priorTurns + 1)
            throw Error("Runtime did not consume exactly its guarded turn");
        },
        async () => {
          const receipt = runtimeReceiptSchema.parse(
            await wait(() => ports.readTurn(taskId, operationId)),
          );
          if (receipt.taskId !== taskId || receipt.operationId !== operationId)
            return false;
          const prior = state.runtimeReceipts[operationId];
          if (prior && JSON.stringify(prior) !== JSON.stringify(receipt))
            throw Error("Runtime identity changed");
          state.runtimeReceipts[operationId] = receipt;
          await save();
          return true;
        },
      );
    };
    if (!state.baseline) {
      state.baseline = await observe();
      await save();
    }
    const before = state.baseline;
    const upper = m.resource.prs[1]!,
      originalHead = m.resource.refs.find(
        (ref) => ref.name === upper.head,
      )?.sha;
    if (
      before.taskId !== m.resource.taskIds[1] ||
      before.repositoryNodeId !== m.resource.repositoryNodeId ||
      before.prId !== upper.id ||
      before.head !== originalHead ||
      before.baseRef !== upper.base ||
      before.acceptedBaseRef !== upper.base ||
      before.outsideHead !== null ||
      !before.selectedEdgeActive
    )
      throw Error("Initial stack observation differs from granted material");
    let complete = false;
    if (r.scenario === "merge-adoption") {
      if (!(await turn(0)) || !(await turn(1))) {
        state.disposition = "held";
        await save();
        return state;
      }
      const name = r.mergeOperation!,
        merge = m.operations.find((o) => o.id === name)!;
      const merged = await effect(
        name,
        merge,
        async () => {
          const response = await providerSend(name);
          if (!response.ok) throw Error("Unknown merge result");
          const answer = mergeResponseSchema.parse(
            await wait(() => boundedJson(response)),
          );
          if (
            !["pending", "enqueued"].includes(answer.status) ||
            !answer.details.uuid
          )
            throw Error("Async merge observation unproved");
          state.mergeRequestId = answer.details.uuid;
          await save();
        },
        async () =>
          (await providerReadback(name, async (response) => {
            if (!response.ok) return false;
            const pr = z
              .object({
                node_id: text,
                number: z.number(),
                merged: z.literal(true),
                head: z.object({ ref: text, sha: oid }),
                base: z.object({
                  ref: text,
                  repo: z.object({ node_id: text }),
                }),
              })
              .parse(await wait(() => boundedJson(response)));
            return (
              pr.node_id === m.resource.prs[0]!.id &&
              pr.number === m.resource.prs[0]!.number &&
              pr.head.ref === m.resource.prs[0]!.head &&
              pr.head.sha ===
                m.resource.refs.find((ref) => ref.name === pr.head.ref)?.sha &&
              pr.base.ref === m.resource.prs[0]!.base &&
              pr.base.repo.node_id === m.resource.repositoryNodeId
            );
          })) === "confirmed",
      );
      if (
        merged &&
        state.mergeRequestId &&
        (await effect(
          "refresh",
          {
            method: "StandaloneService.refreshGitHub",
            taskIds: m.resource.taskIds,
          },
          () => wait(() => ports.service.refreshGitHub()),
          async () => {
            const observed = await observe();
            return (
              observed.baseRef === m.resource.base &&
              observed.acceptedBaseRef === m.resource.base
            );
          },
        ))
      ) {
        let after = await observe();
        if (
          state.platformRebase === "unobserved" ||
          (state.platformRebase === "not-observed" &&
            !state.effects[r.equivalentRebaseOperation ?? ""] &&
            after.head !== before.head)
        )
          state.platformRebase =
            after.head === before.head ? "not-observed" : "observed";
        await save();
        if (
          state.platformRebase === "not-observed" &&
          r.equivalentRebaseOperation
        ) {
          const op = m.operations.find(
            (o) => o.id === r.equivalentRebaseOperation,
          )!;
          if (
            !(await effect(
              op.id,
              op,
              async () => {
                await providerSend(op.id);
              },
              async () =>
                (await providerReadback(op.id, async (response) => {
                  const ref = z
                    .object({ object: z.object({ sha: oid }) })
                    .parse(await wait(() => boundedJson(response)));
                  return (
                    response.ok &&
                    ref.object.sha === JSON.parse(op.send.body).sha
                  );
                })) === "confirmed",
            ))
          ) {
            state.disposition = "held";
            await save();
            return state;
          }
          // Refresh is a distinct finite intent after the explicitly granted outside ref change.
          if (
            !(await effect(
              "equivalent-refresh",
              { method: "StandaloneService.refreshGitHub", after: op.id },
              () => wait(() => ports.service.refreshGitHub()),
              async () => {
                const observed = await observe();
                return (
                  observed.proofs.some(
                    (proof) =>
                      proof.oldHead === before.head &&
                      proof.newHead === observed.head &&
                      proof.newBase === observed.baseSha,
                  ) && observed.outsideHead === null
                );
              },
            ))
          ) {
            state.disposition = "held";
            await save();
            return state;
          }
          after = await observe();
        }
        const proof = after.proofs.find(
          (p) =>
            p.oldHead === before.head &&
            p.newHead === after.head &&
            p.newBase === after.baseSha,
        );
        complete =
          !!proof &&
          after.outsideHead === null &&
          after.baseRef === m.resource.base &&
          after.acceptedBaseRef === m.resource.base &&
          JSON.stringify(before.workspace) === JSON.stringify(after.workspace);
        if (complete)
          state.adoption =
            state.platformRebase === "observed"
              ? "verified"
              : "fixture-equivalent";
      }
    } else {
      const command = r.unstackCommand!;
      if (command.type !== "task.unstack")
        throw Error("Invalid Unstack command");
      const confirmed = await effect(
        "operator-unstack",
        command,
        async () => {
          const preview = unstackReadSchema.parse(
            await wait(() => ports.service.readUnstack(command.taskId)),
          ).data.preview;
          if (
            !preview ||
            preview.materialHash !== command.materialHash ||
            preview.expectedVersion !== command.expectedVersion ||
            preview.taskId !== command.taskId ||
            preview.repository !== m.resource.repository ||
            preview.selectedPr !== m.resource.prs[1]!.number ||
            preview.targetBase !== m.resource.base ||
            m.operations.find((op) => op.id === "unstack")!.send.path !==
              `/repos/${m.resource.repository}/stacks/${preview.stackNumber}/unstack` ||
            JSON.stringify(preview.members.map((member) => member.number)) !==
              JSON.stringify(
                m.resource.stack.map(
                  (pr) =>
                    m.resource.prs.find((member) => member.id === pr)?.number,
                ),
              )
          )
            throw Error("Unstack preview changed");
          const receipt = unstackReceiptSchema.parse(
            await wait(() => ports.service.execute(command)),
          );
          if (
            receipt.key !== command.key ||
            receipt.taskId !== command.taskId ||
            receipt.materialHash !== command.materialHash ||
            receipt.expectedVersion !== command.expectedVersion
          )
            throw Error("Unstack receipt mismatch");
        },
        async () => {
          // This is the existing coordinator continuation, NOT the pure operator status GET.
          // It may send only a not-yet-attempted next phase after original-identity readback proves removal.
          current();
          state.stage = "operator-unstack-reconcile";
          await save();
          await wait(() => ports.service.reconcileTaskUnstack(command.key));
          current();
          const read = await wait(() =>
            ports.service.readOperation(
              new URLSearchParams({
                scope: `task:${command.taskId}`,
                type: command.type,
                key: command.key,
              }),
            ),
          );
          if (read.data.state !== "recorded") return false;
          const receipt = unstackReceiptSchema.parse(read.data.receipt);
          return (
            receipt.key === command.key &&
            receipt.taskId === command.taskId &&
            receipt.expectedVersion === command.expectedVersion &&
            receipt.materialHash === command.materialHash &&
            receipt.phase === "confirmed"
          );
        },
      );
      if (confirmed) {
        const after = await observe(),
          restack = await wait(() => ports.restack(command.key));
        complete =
          after.head === before.head &&
          after.outsideHead === null &&
          !after.selectedEdgeActive &&
          after.acceptedBaseRef === m.resource.base &&
          after.baseRef === m.resource.base &&
          after.restackSequence === before.restackSequence + 1 &&
          restack.operationId === command.key &&
          restack.count === 1 &&
          oid.parse(restack.newBaseSha) === after.baseSha &&
          JSON.stringify(before.workspace) === JSON.stringify(after.workspace);
      }
    }
    const requiredProvider =
      r.scenario === "unstack"
        ? ["unstack", "retarget"]
        : [
            r.mergeOperation!,
            ...(r.equivalentRebaseOperation &&
            state.effects[r.equivalentRebaseOperation]
              ? [r.equivalentRebaseOperation]
              : []),
          ];
    if (
      complete &&
      requiredProvider.some(
        (name) => state.effects[`provider-${name}`]?.phase !== "confirmed",
      )
    )
      complete = false;
    if (complete) {
      cleanupAllowed = true;
      state.cleanup = r.cleanupOperations.length
        ? "unfinished"
        : "not-requested";
      for (const name of r.cleanupOperations) {
        const op = m.operations.find((o) => o.id === name)!;
        if (
          !(await effect(
            name,
            op,
            async () => {
              await providerSend(name);
            },
            async () =>
              (await providerReadback(
                name,
                async (response) =>
                  response.status === 404 || response.status === 204,
              )) === "confirmed",
          ))
        ) {
          complete = false;
          break;
        }
      }
      if (complete && r.cleanupOperations.length) state.cleanup = "confirmed";
    }
    state.disposition = complete ? "recorded" : "held";
    if (complete) state.failure = null;
    if (!complete && !state.failure) state.failure = "unproved-readback";
    await save();
    return structuredClone(state);
  } finally {
    active = false;
    await lock.close();
    await rm(lockPath);
  }
}
