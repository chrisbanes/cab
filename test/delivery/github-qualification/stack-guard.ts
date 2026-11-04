import { createHash } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const text = z.string().min(1).max(512);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const request = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().startsWith("/"),
    body: z.string().max(64 * 1024),
  })
  .strict();
const resource = z
  .object({
    account: text,
    accountNodeId: text,
    repository: text,
    repositoryNodeId: text,
    projectId: z.string().uuid(),
    taskIds: z.array(z.string().uuid()).length(2),
    branchPrefix: z.string().regex(/^cab-fixture-[a-z0-9-]+\/$/),
    visibility: z.enum(["public", "private"]),
    base: text,
    baseSha: sha,
    refs: z
      .array(z.object({ name: text, sha }).strict())
      .min(2)
      .max(8),
    prs: z
      .array(
        z
          .object({
            id: text,
            number: z.number().int().positive(),
            head: text,
            base: text,
          })
          .strict(),
      )
      .min(2)
      .max(8),
    stack: z.array(text).min(2).max(8),
    materialSha256: digest,
  })
  .strict();
export const stackManifestSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().uuid(),
    resource,
    credentialRef: z.string().regex(/^env:[A-Z][A-Z0-9_]*$/),
    maxWrites: z.number().int().min(1).max(32),
    runtimeTurns: z.number().int().min(1).max(12),
    operations: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(/^[a-z][a-z0-9-]*$/)
              .refine((id) => !["constructor", "prototype"].includes(id)),
            cleanup: z.boolean(),
            send: request,
            readback: request.extend({
              method: z.literal("GET"),
              body: z.literal(""),
            }),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict()
  .superRefine((m, c) => {
    if (
      new Set(m.operations.map((o) => o.id)).size !== m.operations.length ||
      m.operations.some((o) => o.send.method === "GET") ||
      m.resource.refs.some(
        (r) =>
          r.name === m.resource.base ||
          !r.name.startsWith(m.resource.branchPrefix),
      ) ||
      new Set(m.resource.stack).size !== m.resource.stack.length
    )
      c.addIssue({ code: "custom", message: "Ambiguous fixture identities" });
    for (const op of m.operations)
      for (const r of [op.send, op.readback]) {
        const url = new URL(r.path, "https://api.github.com");
        if (
          url.origin !== "https://api.github.com" ||
          url.username ||
          url.password ||
          url.hash ||
          !url.pathname.startsWith(`/repos/${m.resource.repository}/`) ||
          url.pathname.includes("%")
        )
          c.addIssue({
            code: "custom",
            message: "Unexpected fixture endpoint",
          });
      }
  });
const grantSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().uuid(),
    manifestSha256: digest,
    expiresAt: z.iso.datetime(),
    resource,
    credentialRef: text,
    maxWrites: z.number().int().min(1).max(32),
    runtimeTurns: z.number().int().min(1).max(12),
    cleanup: z.boolean(),
  })
  .strict();
const checkpointSchema = z
  .object({
    expiresAt: z.iso.datetime(),
    version: z.literal(1),
    manifestSha256: digest,
    runId: z.string().uuid(),
    resource,
    readbacks: z.number().int().nonnegative(),
    readbackPhase: z.enum(["idle", "intent", "confirmed", "unknown"]),
    writes: z.number().int().nonnegative(),
    turns: z.number().int().nonnegative(),
    operations: z.record(
      z.string(),
      z
        .object({
          requestSha256: digest,
          phase: z.enum(["intent", "sent", "confirmed"]),
        })
        .strict(),
    ),
  })
  .strict();
type Manifest = z.output<typeof stackManifestSchema>;
type Checkpoint = z.output<typeof checkpointSchema>;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Proposed manifests confer no authority. No credential lookup or transport occurs in this guard. */
export class StackFixtureGuard {
  private readonly parsedManifest: Manifest;
  get manifest(): Manifest {
    return structuredClone(this.parsedManifest);
  }
  readonly manifestSha256: string;
  get expiresAt() {
    return this.grant.expiresAt;
  }
  private readonly grant: z.output<typeof grantSchema>;
  constructor(
    raw: string,
    grant: unknown,
    private readonly now = Date.now,
  ) {
    this.parsedManifest = stackManifestSchema.parse(JSON.parse(raw));
    this.manifestSha256 = hash(raw);
    this.grant = grantSchema.parse(grant);
    const m = this.manifest,
      g = this.grant;
    if (
      g.manifestSha256 !== this.manifestSha256 ||
      g.runId !== m.runId ||
      JSON.stringify(g.resource) !== JSON.stringify(m.resource) ||
      g.credentialRef !== m.credentialRef ||
      g.maxWrites !== m.maxWrites ||
      g.runtimeTurns !== m.runtimeTurns ||
      (!g.cleanup && m.operations.some((o) => o.cleanup))
    )
      throw new Error("Grant mismatch");
    this.current();
  }
  current() {
    if (this.now() >= Date.parse(this.grant.expiresAt))
      throw new Error("Grant expired");
  }
  assertObserved(observed: unknown) {
    this.current();
    if (
      JSON.stringify(resource.parse(observed)) !==
      JSON.stringify(this.manifest.resource)
    )
      throw new Error("Observed fixture identity mismatch");
  }
  operation(id: string, method: string, path: string, body: string) {
    this.current();
    const op = this.manifest.operations.find((o) => o.id === id);
    if (
      !op ||
      method !== op.send.method ||
      path !== op.send.path ||
      body !== op.send.body
    )
      throw new Error("Unexpected operation material");
    return op;
  }
}

/** Single-writer checkpoint, persisted before effect. Unknown sends are read back only, never resent. */
export class StackFixtureRunner {
  constructor(
    private readonly guard: StackFixtureGuard,
    private readonly checkpointPath: string,
  ) {}
  private async exclusive<T>(
    work: (state: Checkpoint, save: () => Promise<void>) => Promise<T>,
  ) {
    const lockPath = `${this.checkpointPath}.lock`;
    const lock = await open(lockPath, "wx", 0o600);
    try {
      const g = this.guard,
        m = g.manifest;
      let state: Checkpoint;
      try {
        state = checkpointSchema.parse(
          JSON.parse(await readFile(this.checkpointPath, "utf8")),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        state = {
          expiresAt: g.expiresAt,
          version: 1,
          manifestSha256: g.manifestSha256,
          runId: m.runId,
          resource: m.resource,
          readbacks: 0,
          readbackPhase: "idle",
          writes: 0,
          turns: 0,
          operations: {},
        };
      }
      if (
        state.expiresAt !== g.expiresAt ||
        state.manifestSha256 !== g.manifestSha256 ||
        state.runId !== m.runId ||
        JSON.stringify(state.resource) !== JSON.stringify(m.resource) ||
        state.writes !== Object.keys(state.operations).length ||
        state.writes > m.maxWrites ||
        state.turns > m.runtimeTurns ||
        Object.entries(state.operations).some(([id, entry]) => {
          const op = m.operations.find((o) => o.id === id);
          return !op || entry.requestSha256 !== hash(JSON.stringify(op));
        })
      )
        throw new Error("Checkpoint mismatch");
      const save = async () => {
        const temporary = `${this.checkpointPath}.tmp`;
        const file = await open(temporary, "w", 0o600);
        try {
          await file.writeFile(JSON.stringify(state));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, this.checkpointPath);
        const dir = await open(dirname(this.checkpointPath), "r");
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      };
      return await work(state, save);
    } finally {
      await lock.close();
      await rm(lockPath);
    }
  }
  async beginRuntimeTurn() {
    return this.exclusive(async (s, save) => {
      this.guard.current();
      if (s.turns >= this.guard.manifest.runtimeTurns)
        throw new Error("Runtime budget exhausted");
      s.turns++;
      await save();
      return s.turns;
    });
  }
  async send(
    id: string,
    method: string,
    path: string,
    body: string,
    credential: (reference: string) => Promise<string>,
    transport: typeof fetch,
  ) {
    const op = this.guard.operation(id, method, path, body);
    return this.exclusive(async (s, save) => {
      this.guard.current();
      if (Object.hasOwn(s.operations, id))
        throw new Error("Unknown or completed send must not repeat");
      if (s.writes >= this.guard.manifest.maxWrites)
        throw new Error("Write limit exhausted");
      s.operations[id] = {
        requestSha256: hash(JSON.stringify(op)),
        phase: "intent",
      };
      s.writes++;
      await save();
      const token = await credential(this.guard.manifest.credentialRef);
      this.guard.current();
      s.operations[id]!.phase = "sent";
      await save();
      this.guard.current();
      // Response text and credentials never enter the checkpoint.
      return transport(`https://api.github.com${path}`, {
        method,
        ...(body ? { body } : {}),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    });
  }
  async readback(
    id: string,
    credential: (reference: string) => Promise<string>,
    transport: typeof fetch,
    confirms: (response: Response) => Promise<boolean>,
  ) {
    return this.exclusive(async (s, save) => {
      this.guard.current();
      const op = this.guard.manifest.operations.find((o) => o.id === id);
      if (!op || !Object.hasOwn(s.operations, id))
        throw new Error("No recorded intent");
      if (s.readbacks >= 128) throw new Error("Readback budget exhausted");
      s.readbacks++;
      s.readbackPhase = "intent";
      await save();
      const token = await credential(this.guard.manifest.credentialRef);
      this.guard.current();
      const response = await transport(
        `https://api.github.com${op.readback.path}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (await confirms(response)) {
        s.operations[id]!.phase = "confirmed";
        s.readbackPhase = "confirmed";
      } else s.readbackPhase = "unknown";
      await save();
      return s.operations[id]!.phase;
    });
  }
}
