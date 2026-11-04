import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath, rename } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import type {
  GitHubDeliveryRequest,
  GitHubDeliveryRequestBoundary,
} from "../../../src/standalone/github-delivery.js";
import { deliveryDocuments } from "../../../src/standalone/github-delivery.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const text = z.string().min(1).max(512);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const path = text.refine(isAbsolute);
const pin = z.object({ path, sha256: digest }).strict();
const request = z
  .object({
    url: z.string().url(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    body: z.string().max(65536),
    version: z.enum(["2022-11-28", "2026-03-10"]),
  })
  .strict();
const calls = z.enum([
  "service.start",
  "service.stop",
  "service.refresh",
  "service.unstack.preview",
  "service.unstack.execute",
  "service.unstack.reconcile",
  "service.operation.read",
  "runtime.start",
  "runtime.stop",
  "runtime.thread.start",
  "runtime.thread.resume",
  "runtime.turn",
  "runtime.wait",
  "runtime.interrupt",
  "git.prove",
  "git.adopt",
]);
export const stackAuthoritySchema = z
  .object({
    reads: z
      .array(z.object({ id: text, request, maxCalls: count }).strict())
      .max(128),
    writes: z
      .array(z.object({ id: text, request, maxCalls: count.max(1) }).strict())
      .max(32),
    serviceCalls: z
      .array(
        z
          .object({ id: calls, materialSha256: digest, maxCalls: count })
          .strict(),
      )
      .max(32),
    captures: z
      .object({
        mergeRuleId: text.nullable(),
        maxFreshHeads: z.literal(1),
        maxFreshBases: z.literal(1),
      })
      .strict(),
    host: z
      .object({
        runRoot: path,
        dataDirectory: path,
        scratchParent: path,
        files: z.array(pin).min(1).max(256),
        directories: z
          .array(
            z
              .object({ path, dev: count, ino: z.number().int().nonnegative() })
              .strict(),
          )
          .min(1)
          .max(32),
        gitExecutable: pin,
        runtimeExecutable: pin,
        runtimeVersion: text,
        settingsSha256: digest,
        configSha256: digest,
        writes: z.array(path).max(64),
        teardownDeadline: z.iso.datetime(),
      })
      .strict(),
    gitFetch: z
      .object({
        repositoryUrl: z.string().url(),
        workspace: path,
        commonDirectory: path,
        executable: pin,
        scratchParent: path,
        commits: z.array(sha).min(2).max(8),
        branch: text,
        maxFetches: count,
        maxObjectBytes: count.max(536870912),
        maxElapsedMs: count.max(120000),
      })
      .strict(),
    runtime: z
      .array(
        z
          .object({
            taskId: z.string().uuid(),
            assignmentId: z.string().uuid(),
            workspace: path,
            settingsSha256: digest,
            maxTurns: count.max(12),
          })
          .strict(),
      )
      .length(2),
    limits: z
      .object({
        reads: count.max(128),
        writes: count.max(32),
        credentials: count.max(32),
        turns: count.max(12),
        firstEffects: count,
        serviceCalls: count,
        gitFetches: count,
      })
      .strict(),
  })
  .strict();
export const stackV2ManifestSchema = z
  .object({
    version: z.literal(2),
    runId: z.string().uuid(),
    scenario: z.enum(["merge-adoption", "unstack-healthy", "unstack-failed"]),
    resource: z
      .object({
        projectId: z.string().uuid(),
        repository: text,
        repositoryNodeId: text,
        actor: text,
        actorNodeId: text,
        lowerTask: z.string().uuid(),
        upperTask: z.string().uuid(),
        lowerPr: z.number().int().positive(),
        upperPr: z.number().int().positive(),
        lowerPrId: text,
        upperPrId: text,
        lowerRef: text,
        upperRef: text,
        lowerHead: sha,
        upperHead: sha,
        base: text,
        baseSha: sha,
        stackNumber: z.number().int().positive(),
        stackId: text,
        operationKey: text,
        unstackCommandSha256: digest,
      })
      .strict(),
    credentialRef: text,
    readinessSha256: digest,
    authority: stackAuthoritySchema,
  })
  .strict();
export const stackV2GrantSchema = z
  .object({
    version: z.literal(2),
    runId: z.string().uuid(),
    manifestSha256: digest,
    readinessSha256: digest,
    authoritySha256: digest,
    resourceSha256: digest,
    credentialRef: text,
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    teardownDeadline: z.iso.datetime(),
  })
  .strict();
export const stackV2ReadinessSchema = z
  .object({
    version: z.literal(2),
    runId: z.string().uuid(),
    observedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    resourceSha256: digest,
    authoritySha256: digest,
    source: z.array(pin).min(1).max(256),
    configSha256: digest,
    settingsSha256: digest,
    runtimeVersion: text,
    credentialRef: text,
    hostId: text,
  })
  .strict();
export const authorityHash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export const materialHash = (value: unknown): string =>
  authorityHash(JSON.stringify(canonical(value)));
type Manifest = z.output<typeof stackV2ManifestSchema>;
const journalSchema = z
  .object({
    version: z.literal(2),
    runId: text,
    manifestSha256: digest,
    grantSha256: digest,
    counts: z.record(text, count),
    effects: z.record(
      text,
      z
        .object({
          material: digest,
          state: z.enum(["reserved", "confirmed", "unknown"]),
          receipt: text.nullable(),
        })
        .strict(),
    ),
    captures: z.record(text, text),
    closed: z.boolean(),
  })
  .strict();
type Journal = z.output<typeof journalSchema>;

/** One run owns one durable journal. A leftover lock requires operator investigation, never reset. */
export class StackV2Authority implements GitHubDeliveryRequestBoundary {
  private journal!: Journal;
  private lock: Awaited<ReturnType<typeof open>> | undefined;
  private queue = Promise.resolve();
  private fault = false;
  readonly manifest: Manifest;
  readonly grant: z.output<typeof stackV2GrantSchema>;
  readonly readiness: z.output<typeof stackV2ReadinessSchema>;
  readonly manifestSha256: string;
  private readonly grantSha256: string;
  constructor(
    raw: string,
    grantRaw: string,
    readinessRaw: string,
    private readonly resultPath: string,
    private readonly now = Date.now,
  ) {
    if (
      [raw, grantRaw, readinessRaw].some((v) => Buffer.byteLength(v) > 262144)
    )
      throw Error("v2-input-bound");
    this.manifest = stackV2ManifestSchema.parse(JSON.parse(raw));
    this.grant = stackV2GrantSchema.parse(JSON.parse(grantRaw));
    this.readiness = stackV2ReadinessSchema.parse(JSON.parse(readinessRaw));
    this.manifestSha256 = authorityHash(raw);
    this.grantSha256 = authorityHash(grantRaw);
    const m = this.manifest,
      g = this.grant,
      r = this.readiness;
    if (
      !isAbsolute(resultPath) ||
      m.runId !== g.runId ||
      m.runId !== r.runId ||
      g.manifestSha256 !== this.manifestSha256 ||
      g.readinessSha256 !== authorityHash(readinessRaw) ||
      m.readinessSha256 !== g.readinessSha256 ||
      g.authoritySha256 !== materialHash(m.authority) ||
      r.authoritySha256 !== g.authoritySha256 ||
      g.resourceSha256 !== materialHash(m.resource) ||
      r.resourceSha256 !== g.resourceSha256 ||
      g.credentialRef !== m.credentialRef ||
      r.credentialRef !== m.credentialRef ||
      r.configSha256 !== m.authority.host.configSha256 ||
      r.settingsSha256 !== m.authority.host.settingsSha256 ||
      r.runtimeVersion !== m.authority.host.runtimeVersion ||
      g.teardownDeadline !== m.authority.host.teardownDeadline ||
      Date.parse(g.issuedAt) > now() ||
      Date.parse(r.observedAt) > now() ||
      now() - Date.parse(r.observedAt) > 300000 ||
      Date.parse(r.expiresAt) > Date.parse(g.expiresAt) ||
      Date.parse(g.teardownDeadline) < Date.parse(g.expiresAt)
    )
      throw Error("v2-authority-mismatch");
    const rules = [...m.authority.reads, ...m.authority.writes];
    if (
      new Set(rules.map((v) => v.id)).size !== rules.length ||
      new Set(rules.map((v) => materialHash(v.request))).size !==
        rules.length ||
      new Set(
        m.authority.serviceCalls.map((v) => `${v.id}:${v.materialSha256}`),
      ).size !== m.authority.serviceCalls.length ||
      new Set(m.authority.runtime.map((v) => v.taskId)).size !== 2 ||
      !m.authority.runtime.some((v) => v.taskId === m.resource.lowerTask) ||
      !m.authority.runtime.some((v) => v.taskId === m.resource.upperTask)
    )
      throw Error("v2-ambiguous-scope");
    for (const rule of rules) {
      const u = new URL(rule.request.url);
      if (
        u.origin !== "https://api.github.com" ||
        u.username ||
        u.password ||
        u.hash ||
        u.href !== rule.request.url ||
        (!["/user", "/graphql"].includes(u.pathname) &&
          !u.pathname.startsWith(`/repos/${m.resource.repository}/`))
      )
        throw Error("v2-request-origin");
      if (rule.request.method === "GET" && rule.request.body !== "")
        throw Error("v2-get-body");
      if (m.authority.reads.includes(rule) && rule.request.method !== "GET") {
        const body = JSON.parse(rule.request.body) as {
          query?: string;
          variables?: unknown;
        };
        if (
          u.pathname !== "/graphql" ||
          rule.request.method !== "POST" ||
          ![
            deliveryDocuments.CabDeliveryRepository,
            deliveryDocuments.CabDeliveryPr,
          ].some((document) => document === body.query) ||
          Object.keys(body).sort().join(",") !== "query,variables"
        )
          throw Error("v2-graphql-scope");
      }
    }
    this.current();
  }
  current(teardown = false) {
    const deadline = teardown
      ? this.grant.teardownDeadline
      : this.grant.expiresAt;
    if (
      this.fault ||
      this.journal?.closed ||
      this.now() >= Date.parse(deadline) ||
      (!teardown && this.now() >= Date.parse(this.readiness.expiresAt))
    )
      throw Error("v2-authority-closed");
  }
  async preflight(teardown = false) {
    this.current(teardown);
    const { host, gitFetch } = this.manifest.authority;
    for (const p of [
      host.runRoot,
      host.dataDirectory,
      host.scratchParent,
      gitFetch.workspace,
      gitFetch.commonDirectory,
      gitFetch.scratchParent,
    ])
      if ((await realpath(p)) !== p || !(await lstat(p)).isDirectory())
        throw Error("v2-host-path");
    for (const p of host.directories) {
      const s = await lstat(p.path);
      if (
        s.isSymbolicLink() ||
        !s.isDirectory() ||
        s.dev !== p.dev ||
        s.ino !== p.ino
      )
        throw Error("v2-host-ownership");
    }
    for (const p of [
      ...host.files,
      host.gitExecutable,
      host.runtimeExecutable,
      gitFetch.executable,
      ...this.readiness.source,
    ]) {
      const s = await lstat(p.path);
      if (
        !s.isFile() ||
        s.isSymbolicLink() ||
        authorityHash(await readFile(p.path)) !== p.sha256
      )
        throw Error("v2-source-pin");
    }
    if (
      gitFetch.repositoryUrl !==
        `https://github.com/${this.manifest.resource.repository}.git` ||
      gitFetch.scratchParent !== host.scratchParent ||
      materialHash(gitFetch.executable) !== materialHash(host.gitExecutable)
    )
      throw Error("v2-git-scope");
    this.current(teardown);
  }
  async open() {
    await this.preflight();
    this.lock = await open(`${this.resultPath}.lock`, "wx", 0o600);
    try {
      const raw = await readFile(this.resultPath, "utf8").catch(
        (e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") return null;
          throw e;
        },
      );
      if (raw !== null && Buffer.byteLength(raw) > 1048576)
        throw Error("v2-journal-bound");
      this.journal =
        raw === null
          ? {
              version: 2,
              runId: this.manifest.runId,
              manifestSha256: this.manifestSha256,
              grantSha256: this.grantSha256,
              counts: {},
              effects: {},
              captures: {},
              closed: false,
            }
          : journalSchema.parse(JSON.parse(raw));
      if (
        this.journal.runId !== this.manifest.runId ||
        this.journal.manifestSha256 !== this.manifestSha256 ||
        this.journal.grantSha256 !== this.grantSha256
      )
        throw Error("v2-journal-mismatch");
      this.current();
      await this.save();
    } catch (e) {
      this.fault = true;
      throw e;
    }
  }
  private async save() {
    const file = await open(`${this.resultPath}.tmp`, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(this.journal));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(`${this.resultPath}.tmp`, this.resultPath);
    const directory = await open(dirname(this.resultPath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run);
    this.queue = result.then(
      () => {},
      () => {
        this.fault = true;
      },
    );
    return result;
  }
  private increment(name: string, cap: number) {
    const n = this.journal.counts[name] ?? 0;
    if (n >= cap) throw Error("v2-budget");
    this.journal.counts[name] = n + 1;
  }
  private expanded(request: GitHubDeliveryRequest): GitHubDeliveryRequest {
    let url = request.url;
    for (const [token, name] of [
      ["__CAB_MERGE_REQUEST__", "mergeRequest"],
      ["__CAB_UPPER_HEAD__", "upperHead"],
      ["__CAB_BASE_SHA__", "baseSha"],
    ]) {
      if (url.includes(token!)) {
        const captured = this.journal?.captures[name!];
        if (!captured) return request;
        url = url.replaceAll(token!, encodeURIComponent(captured));
      }
    }
    return { ...request, url };
  }
  private rule(request: GitHubDeliveryRequest) {
    this.current();
    const read = this.manifest.authority.reads.find(
      (v) => materialHash(this.expanded(v.request)) === materialHash(request),
    );
    const write = this.manifest.authority.writes.find(
      (v) => materialHash(this.expanded(v.request)) === materialHash(request),
    );
    const rule = read ?? write;
    if (!rule) throw Error("v2-unlisted-request");
    return { rule, category: read ? ("reads" as const) : ("writes" as const) };
  }
  async beforeCredential(request: GitHubDeliveryRequest) {
    await this.preflight();
    this.rule(request);
  }
  beforeCredentialLookup() {
    return this.serial(async () => {
      this.current();
      this.increment("credentials", this.manifest.authority.limits.credentials);
      await this.save();
      this.current();
    });
  }
  beforeDispatch(request: GitHubDeliveryRequest) {
    return this.serial(async () => {
      await this.preflight();
      const { rule, category } = this.rule(request);
      this.increment(`http:${rule.id}`, rule.maxCalls);
      this.increment(category, this.manifest.authority.limits[category]);
      if (category === "writes")
        this.increment(
          "firstEffects",
          this.manifest.authority.limits.firstEffects,
        );
      await this.save();
      this.current();
    });
  }
  reserve(
    call: z.output<typeof calls>,
    material: unknown,
    key: string,
    teardown = false,
  ) {
    return this.serial(async () => {
      this.current(teardown);
      await this.preflight(teardown);
      this.current(teardown);
      const rule = this.manifest.authority.serviceCalls.find(
        (v) => v.id === call && v.materialSha256 === materialHash(material),
      );
      if (
        !rule ||
        this.journal.effects[key] ||
        Object.values(this.journal.effects).some(
          (v) =>
            v.material === materialHash(material) && v.state !== "confirmed",
        )
      )
        throw Error("v2-call-unlisted-or-spent");
      this.increment(`call:${call}`, rule.maxCalls);
      this.increment(
        "serviceCalls",
        this.manifest.authority.limits.serviceCalls,
      );
      if (call === "runtime.turn") {
        this.increment("turns", this.manifest.authority.limits.turns);
        const taskId = z.object({ taskId: z.string() }).parse(material).taskId;
        const scope = this.manifest.authority.runtime.find(
          (v) => v.taskId === taskId,
        );
        if (!scope) throw Error("v2-turn-task");
        this.increment(`task-turns:${taskId}`, scope.maxTurns);
      }
      if (call === "git.prove" || call === "git.adopt")
        this.increment(
          "gitFetches",
          Math.min(
            this.manifest.authority.limits.gitFetches,
            this.manifest.authority.gitFetch.maxFetches,
          ),
        );
      if (
        [
          "service.start",
          "service.unstack.execute",
          "runtime.start",
          "runtime.thread.start",
          "runtime.turn",
          "git.prove",
          "git.adopt",
        ].includes(call)
      )
        this.increment(
          "firstEffects",
          this.manifest.authority.limits.firstEffects,
        );
      this.journal.effects[key] = {
        material: materialHash(material),
        state: "reserved",
        receipt: null,
      };
      await this.save();
      this.current(teardown);
    });
  }
  confirm(key: string, receipt: string) {
    return this.serial(async () => {
      this.current();
      const effect = this.journal.effects[key];
      if (effect?.state !== "reserved" || receipt.length > 512)
        throw Error("v2-effect-binding");
      effect.state = "confirmed";
      effect.receipt = receipt;
      await this.save();
      this.current();
    });
  }
  async afterResponse(request: GitHubDeliveryRequest, response: Response) {
    await this.serial(async () => {
      this.current();
      const { rule } = this.rule(request);
      if (
        response.redirected ||
        [301, 302, 303, 307, 308].includes(response.status) ||
        /rel="?next/.test(response.headers.get("link") ?? "")
      )
        throw Error("v2-response-page-or-redirect");
      if (response.status === 204 || response.status === 404) return;
      const reader = response.body?.getReader();
      if (!reader) throw Error("v2-empty-response");
      let raw = "",
        bytes = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 65536) throw Error("v2-response-bound");
          raw += decoder.decode(part.value, { stream: true });
        }
        raw += decoder.decode();
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      this.current();
      const body: unknown = JSON.parse(raw),
        resource = this.manifest.resource;
      const capture = (name: string, value: string) => {
        const prior = this.journal.captures[name];
        if (prior && prior !== value) throw Error("v2-capture-changed");
        this.journal.captures[name] = value;
      };
      if (
        rule.id === this.manifest.authority.captures.mergeRuleId &&
        [202, 409].includes(response.status)
      ) {
        const parsed = z
          .object({
            details: z.object({
              uuid: z
                .string()
                .trim()
                .min(1)
                .max(512)
                .refine((value) =>
                  [...value].every(
                    (char) =>
                      char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127,
                  ),
                ),
            }),
          })
          .parse(body);
        capture("mergeRequest", parsed.details.uuid);
      }
      const u = new URL(request.url),
        repo = `/repos/${resource.repository}`;
      if (u.pathname === "/user") {
        const v = z.object({ login: text, node_id: text }).parse(body);
        if (v.login !== resource.actor || v.node_id !== resource.actorNodeId)
          throw Error("v2-actor");
      }
      const candidate = (
        kind: "head" | "base",
        producer: "rest" | "graph" | "ref",
        value: string,
      ) => {
        sha.parse(value);
        const initial = kind === "head" ? resource.upperHead : resource.baseSha;
        const name = kind === "head" ? "upperHead" : "baseSha";
        // Repeated observations may progress from initial to one fresh value, never to a second.
        const committed = this.journal.captures[name];
        if (committed && committed !== value) throw Error("v2-sha-moved-again");
        this.journal.captures[`${kind}:${producer}`] = value;
        if (
          ["rest", "graph", "ref"].every(
            (p) => this.journal.captures[`${kind}:${p}`] === value,
          ) &&
          value !== initial
        )
          capture(name, value);
      };
      if (u.pathname === `${repo}/pulls/${resource.upperPr}`) {
        const v = z
          .object({
            node_id: text,
            number: z.number(),
            head: z.object({
              ref: text,
              sha,
              repo: z.object({ node_id: text }),
            }),
            base: z.object({
              ref: text,
              sha,
              repo: z.object({ node_id: text }),
            }),
          })
          .parse(body);
        if (
          v.node_id !== resource.upperPrId ||
          v.number !== resource.upperPr ||
          v.head.ref !== resource.upperRef ||
          ![resource.lowerRef, resource.base].includes(v.base.ref) ||
          v.head.repo.node_id !== resource.repositoryNodeId ||
          v.base.repo.node_id !== resource.repositoryNodeId
        )
          throw Error("v2-pr-identity");
        candidate("head", "rest", v.head.sha);
        if (v.base.ref === resource.base) candidate("base", "rest", v.base.sha);
      }
      if (u.pathname === "/graphql") {
        const v = z
          .object({
            data: z.object({ node: z.record(z.string(), z.unknown()) }),
          })
          .parse(body).data.node;
        const requested = JSON.parse(request.body) as {
          variables: { id: string; after?: unknown };
        };
        if (v.id !== requested.variables.id) throw Error("v2-graph-identity");
        if (v.id === resource.upperPrId) {
          const pr = z
            .object({
              repository: z.object({ id: text }),
              headRefName: text,
              baseRefName: text,
              headRefOid: sha,
              baseRefOid: sha,
              closingIssuesReferences: z.object({
                nodes: z.array(z.unknown()).length(0),
                pageInfo: z.object({ hasNextPage: z.literal(false) }),
              }),
              reviewThreads: z.object({
                pageInfo: z.object({ hasNextPage: z.literal(false) }),
              }),
            })
            .parse(v);
          if (
            pr.repository.id !== resource.repositoryNodeId ||
            pr.headRefName !== resource.upperRef ||
            ![resource.lowerRef, resource.base].includes(pr.baseRefName)
          )
            throw Error("v2-graph-pr");
          candidate("head", "graph", pr.headRefOid);
          if (pr.baseRefName === resource.base)
            candidate("base", "graph", pr.baseRefOid);
        }
      }
      for (const [kind, ref] of [
        ["head", resource.upperRef],
        ["base", resource.base],
      ] as const) {
        const path = `${repo}/git/ref/heads/${ref.split("/").map(encodeURIComponent).join("/")}`;
        if (u.pathname === path) {
          const v = z
            .object({ ref: text, object: z.object({ sha }) })
            .parse(body);
          if (v.ref !== `refs/heads/${ref}`) throw Error("v2-ref-identity");
          candidate(kind, "ref", v.object.sha);
        }
      }
      await this.save();
      this.current();
    });
  }
  async beforeGit(
    operation: "prove" | "adopt",
    request: Readonly<Record<string, unknown>>,
  ) {
    this.current();
    const scope = this.manifest.authority.gitFetch;
    if (
      request.host !== "github.com" ||
      `https://github.com/${request.nameWithOwner}.git` !==
        scope.repositoryUrl ||
      request.workspacePath !== scope.workspace ||
      request.branch !== scope.branch ||
      ![
        request.oldBase,
        request.oldHead,
        request.newBase,
        request.newHead,
        request.baseCommit,
        request.commitSha,
      ]
        .filter((v) => v !== undefined)
        .every(
          (v) =>
            typeof v === "string" &&
            [
              ...scope.commits,
              this.journal.captures.upperHead,
              this.journal.captures.baseSha,
            ].includes(v),
        )
    )
      throw Error("v2-git-material");
    const key = `git:${operation}:${materialHash(request)}`;
    await this.reserve(
      operation === "prove" ? "git.prove" : "git.adopt",
      request,
      key,
    );
    const signal = AbortSignal.timeout(
      Math.min(
        scope.maxElapsedMs,
        Math.max(1, Date.parse(this.grant.expiresAt) - this.now()),
      ),
    );
    return {
      executable: scope.executable.path,
      maxFetchBytes: scope.maxObjectBytes,
      signal,
      fixtureBoundary: {
        scratchParent: scope.scratchParent,
        commonDirectory: scope.commonDirectory,
        beforeEffect: async (phase: string) => {
          await this.preflight(phase === "teardown");
          this.current(phase === "teardown");
          if (signal.aborted && phase !== "teardown")
            throw Error("v2-git-deadline");
        },
      },
    };
  }
  async close() {
    await this.queue;
    await this.lock?.close();
    this.lock = undefined;
    // Retain the durable lock/checkpoint for root's original-identity recovery audit.
  }
  snapshot() {
    return structuredClone(this.journal);
  }
}
