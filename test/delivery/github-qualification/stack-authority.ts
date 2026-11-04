import { unstackCommandSchema } from "../../../src/core/unstack.js";
import { StackPinnedFiles } from "./stack-files.js";
import {
  runGit,
  gitChildExited,
  type GitRunResult,
} from "../../../src/standalone/git-process.js";
import type { RuntimeToolCall } from "../../../src/standalone/codex.js";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
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
  "host.source",
  "host.workspace.image",
  "fixture.observe",
  "fixture.merge",
  "fixture.poll",
  "service.start",
  "service.stop",
  "service.refresh",
  "service.unstack.preview",
  "service.unstack.execute",
  "service.unstack.reconcile",
  "service.operation.read",
  "service.observe",
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
        resultPath: path,
        sourceRoot: path,
        sourceBranch: text,
        sourceHeadFile: path,
        sourceRefFile: path,
        toolchain: z
          .object({
            nodeExecutable: pin,
            nodeVersion: text,
            nvmrc: pin,
            packageJson: pin,
            lockfile: pin,
            packageManager: z.literal("npm@12.2.1"),
          })
          .strict(),
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
        runtimeCredential: z
          .object({
            home: path,
            userHome: path,
            authTarget: path,
            dev: count,
            ino: count,
          })
          .strict(),
        runtimeVersion: text,
        settingsSha256: digest,
        configSha256: digest,
        databaseFiles: z.array(pin).max(3),
        schemaFingerprint: digest,
        writes: z.array(path).max(64),
        workspaceImage: z
          .object({
            maxFiles: z.number().int().positive().max(4096),
            maxBytes: z.number().int().positive().max(33554432),
          })
          .strict(),
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
        maxChildren: count.max(2048),
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
            threadId: text.nullable(),
            workspace: path,
            model: text,
            effort: text,
            settingsSha256: digest,
            policySha256: digest,
            taskVersions: z.array(z.number().int().positive()).min(1).max(12),
            assignmentVersions: z
              .array(z.number().int().positive())
              .min(1)
              .max(12),
            instructionsRevision: z.number().int().positive(),
            profileRevision: z.number().int().positive(),
            maxPromptBytes: z.number().int().min(1).max(262144),
            maxTurns: count.max(12),
            maxCallbacks: count.max(64),
          })
          .strict(),
      )
      .length(2),
    limits: z
      .object({
        reads: count.max(128),
        writes: count.max(32),
        credentials: count.max(32),
        credentialCallbacks: count.max(256),
        callbacks: count.max(128),
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
        visibility: z.enum(["public", "private"]),
        repositoryDefaultBranch: text,
        mergeCapabilities: z
          .object({
            allow_merge_commit: z.boolean(),
            allow_squash_merge: z.boolean(),
            allow_rebase_merge: z.boolean(),
          })
          .strict(),
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
        operationKey: z.string().uuid(),
        unstackCommandSha256: digest,
      })
      .strict(),
    journey: z
      .object({
        maxObservations: z.number().int().min(1).max(8),
        settlePolls: z.number().int().min(1).max(60),
        pollIntervalMs: z.number().int().min(250).max(1000),
      })
      .strict(),
    unstackCommand: unstackCommandSchema
      .extend({ type: z.literal("task.unstack") })
      .strict()
      .nullable(),
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
    sourceCommit: sha,
    sourceTree: sha,
    configSha256: digest,
    settingsSha256: digest,
    runtimeVersion: text,
    runtimeCredentialRef: text,
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
const processIdentitySchema = z
  .object({ processId: text, processStartedAt: text, bootId: text })
  .strict();
export const stackRuntimeIntentSchema = z
  .object({
    taskId: z.string().uuid(),
    assignmentId: z.string().uuid(),
    workId: text,
    threadId: text,
    workspace: path,
    promptSha256: digest,
    requestPromptSha256: digest,
    argumentsPolicySha256: digest,
    settingsSha256: digest,
    policySha256: digest,
    taskVersion: z.number().int().positive(),
    assignmentVersion: z.number().int().positive(),
    instructionsRevision: z.number().int().positive(),
    profileRevision: z.number().int().positive(),
    requestSequence: z.number().int().positive(),
  })
  .strict();
const journalSchema = z
  .object({
    version: z.literal(2),
    runId: text,
    manifestSha256: digest,
    grantSha256: digest,
    counts: z.record(text, count),
    httpRequests: z
      .array(
        z
          .object({
            ruleId: text,
            requestSha256: digest,
            phase: z.enum([
              "reserved",
              "dispatch-reserved",
              "invoked",
              "responded",
            ]),
            reservedAt: count,
            invokedAt: count.nullable(),
            responseAt: count.nullable(),
            responseStatus: z.number().int().min(100).max(599).nullable(),
            responseSha256: digest.nullable(),
          })
          .strict(),
      )
      .max(160),
    effects: z.record(
      text,
      z
        .object({
          material: digest,
          call: calls,
          invoked: z.boolean(),
          state: z.enum(["reserved", "confirmed", "unknown"]),
          receipt: text.nullable(),
          runtimeIntent: stackRuntimeIntentSchema.nullable(),
          boundaryIntentSha256: digest.nullable(),
        })
        .strict(),
    ),
    process: processIdentitySchema.nullable(),
    processExit: z.boolean(),
    terminals: z.record(text, z.enum(["completed", "failed"])),
    gitChildren: z
      .array(
        z
          .object({
            sequence: z.number().int().positive(),
            operation: text,
            state: z.enum(["reserved", "exited", "unknown"]),
            spawned: z.boolean().nullable(),
            status: z.enum(["ok", "exit", "interrupted"]).nullable(),
          })
          .strict(),
      )
      .max(2048),
    callbacks: z
      .array(
        z
          .object({
            key: digest,
            workId: text,
            callId: text,
            tool: z.enum(["cab_register_pr", "cab_report_result"]),
            argumentsSha256: digest,
            invoked: z.boolean(),
            state: z.enum(["reserved", "ended"]),
            succeeded: z.boolean().nullable(),
          })
          .strict(),
      )
      .max(128),
    runtimeBindings: z
      .array(
        z
          .object({
            taskId: text,
            assignmentId: text,
            workId: text,
            threadId: text,
            turnId: text,
            processSha256: digest,
          })
          .strict(),
      )
      .max(12),
    captures: z.record(text, text),
    captureEvidence: z.record(
      text,
      z
        .object({
          ruleId: text,
          requestSha256: digest,
          responseSha256: digest,
          observedAt: count,
        })
        .strict(),
    ),
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
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private readonly pinnedFiles = new StackPinnedFiles();
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
    private readonly inputPaths?: {
      manifest: string;
      grant: string;
      readiness: string;
    },
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
      resultPath !== m.authority.host.resultPath ||
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
      Date.parse(g.expiresAt) - Date.parse(g.issuedAt) > 1200000 ||
      Date.parse(g.teardownDeadline) - Date.parse(g.expiresAt) > 300000 ||
      Date.parse(r.observedAt) > now() ||
      now() - Date.parse(r.observedAt) > 300000 ||
      Date.parse(r.expiresAt) > Date.parse(g.expiresAt) ||
      Date.parse(g.teardownDeadline) < Date.parse(g.expiresAt)
    )
      throw Error("v2-authority-mismatch");
    const resource = m.resource;
    if (
      m.authority.gitFetch.branch !== resource.upperRef ||
      m.authority.gitFetch.commits.some(
        (value) =>
          ![resource.lowerHead, resource.upperHead, resource.baseSha].includes(
            value,
          ),
      ) ||
      new Set(m.authority.gitFetch.commits).size !==
        m.authority.gitFetch.commits.length
    )
      throw Error("v2-git-commit-scope");
    const repo = `/repos/${resource.repository}`;
    if (
      !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(resource.repository) ||
      resource.lowerTask === resource.upperTask ||
      resource.lowerPr === resource.upperPr ||
      resource.lowerPrId === resource.upperPrId ||
      new Set([resource.base, resource.lowerRef, resource.upperRef]).size !== 3
    )
      throw Error("v2-resource-identity");
    const belowRoot = (target: string) => {
      const suffix = relative(m.authority.host.runRoot, target);
      return (
        suffix !== "" &&
        suffix !== ".." &&
        !suffix.startsWith(`..${sep}`) &&
        !isAbsolute(suffix)
      );
    };
    if (
      m.authority.host.runRoot === sep ||
      ![
        m.authority.host.dataDirectory,
        m.authority.host.scratchParent,
        m.authority.gitFetch.workspace,
        m.authority.gitFetch.commonDirectory,
        resultPath,
        ...m.authority.runtime.map((scope) => scope.workspace),
      ].every(belowRoot)
    )
      throw Error("v2-resource-root");
    const segment = (ref: string) =>
      ref.split("/").map(encodeURIComponent).join("/");
    const refs = [resource.base, resource.lowerRef, resource.upperRef];
    const heads = [
      resource.lowerHead,
      resource.upperHead,
      resource.baseSha,
      "__CAB_UPPER_HEAD__",
      "__CAB_BASE_SHA__",
    ];
    const allowedReads = new Set(
      [
        "/user",
        repo,
        ...[resource.lowerPr, resource.upperPr].map(
          (n) => `${repo}/pulls/${n}`,
        ),
        ...[resource.lowerPr, resource.upperPr].flatMap((n) => [
          `${repo}/issues/${n}/comments?per_page=100`,
          `${repo}/pulls/${n}/reviews?per_page=100`,
          `${repo}/pulls/${n}/comments?per_page=100`,
        ]),
        `${repo}/stacks/${resource.stackNumber}`,
        ...refs.map((ref) => `${repo}/git/ref/heads/${segment(ref)}`),
        ...[resource.base, resource.lowerRef].flatMap((ref) => [
          `${repo}/rules/branches/${encodeURIComponent(ref)}`,
          `${repo}/branches/${encodeURIComponent(ref)}/protection`,
        ]),
        ...heads.flatMap((head) => [
          `${repo}/commits/${head}/check-runs?per_page=100&filter=latest`,
          `${repo}/commits/${head}/statuses?per_page=100`,
        ]),
        `${repo}/pulls?state=all&head=${encodeURIComponent(`${resource.repository.split("/")[0]}:${resource.lowerRef}`)}&per_page=100`,
        `${repo}/pulls/${resource.lowerPr}/merge-async/__CAB_MERGE_REQUEST__`,
      ].map((path) => `https://api.github.com${path}`),
    );
    for (const rule of m.authority.reads) {
      if (
        rule.request.method === "GET" &&
        (!allowedReads.has(rule.request.url) || rule.request.body !== "")
      )
        throw Error("v2-read-surface");
      if (rule.request.method === "GET") {
        const url = new URL(rule.request.url);
        const currentStackApi =
          url.pathname === `${repo}/stacks/${resource.stackNumber}` ||
          [resource.lowerPr, resource.upperPr].some(
            (n) => url.pathname === `${repo}/pulls/${n}`,
          );
        if (
          rule.request.version !==
          (currentStackApi ? "2026-03-10" : "2022-11-28")
        )
          throw Error("v2-read-api-version");
      }
      if (rule.request.method === "POST") {
        const body = JSON.parse(rule.request.body) as {
          query: string;
          variables: unknown;
        };
        if (body.query === deliveryDocuments.CabDeliveryRepository) {
          if (
            materialHash(body.variables) !==
            materialHash({ id: resource.repositoryNodeId })
          )
            throw Error("v2-repository-variables");
        } else if (body.query === deliveryDocuments.CabDeliveryPr) {
          if (
            ![resource.lowerPrId, resource.upperPrId].some(
              (id) =>
                materialHash(body.variables) ===
                materialHash({ id, after: null }),
            )
          )
            throw Error("v2-pr-variables");
        }
      }
    }
    for (const rule of m.authority.writes) {
      const q = rule.request;
      if (
        q.url ===
          `https://api.github.com${repo}/pulls/${resource.lowerPr}/merge-async` &&
        q.method === "PUT"
      ) {
        const body = z
          .object({
            sha: z.literal(resource.lowerHead),
            merge_method: z.enum(["merge", "squash", "rebase"]),
            bypass_rules: z.literal(false),
            merge_action: z.literal("direct_merge").optional(),
          })
          .strict()
          .parse(JSON.parse(q.body));
        if (
          q.body !== JSON.stringify(JSON.parse(q.body)) ||
          (q.version === "2026-03-10" &&
            body.merge_action !== "direct_merge") ||
          (q.version === "2022-11-28" && body.merge_action !== undefined) ||
          m.authority.captures.mergeRuleId !== rule.id ||
          m.scenario !== "merge-adoption"
        )
          throw Error("v2-merge-context");
      } else if (
        q.url ===
          `https://api.github.com${repo}/stacks/${resource.stackNumber}/unstack` &&
        q.method === "POST" &&
        q.body === "" &&
        q.version === "2026-03-10" &&
        m.scenario !== "merge-adoption"
      ) {
        // The service's original fenced journal remains the sole sender.
      } else if (
        !(
          q.url === `https://api.github.com${repo}/pulls/${resource.upperPr}` &&
          q.method === "PATCH" &&
          q.body === JSON.stringify({ base: resource.base }) &&
          q.version === "2026-03-10" &&
          m.scenario !== "merge-adoption"
        )
      )
        throw Error("v2-write-surface");
    }
    if (
      m.authority.captures.mergeRuleId !== null &&
      !m.authority.writes.some(
        (rule) =>
          rule.id === m.authority.captures.mergeRuleId &&
          rule.request.method === "PUT",
      )
    )
      throw Error("v2-merge-producer");
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
          u.pathname !== `/repos/${m.resource.repository}` &&
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
          Object.keys(body).sort().join(",") !== "query,variables" ||
          rule.request.body !== JSON.stringify(body) ||
          rule.request.version !== "2022-11-28"
        )
          throw Error("v2-graphql-scope");
      }
    }
    const freeze = (value: unknown): void => {
      if (value && typeof value === "object") {
        for (const item of Object.values(value)) freeze(item);
        Object.freeze(value);
      }
    };
    freeze(this.manifest);
    freeze(this.grant);
    freeze(this.readiness);
    this.current();
  }
  hold() {
    this.fault = true;
  }
  current(teardown = false) {
    const deadline = teardown
      ? this.grant.teardownDeadline
      : this.grant.expiresAt;
    if (
      (!teardown &&
        (this.fault ||
          this.journal?.gitChildren.some(
            (child) => child.state === "unknown",
          ))) ||
      this.closing ||
      this.journal?.closed ||
      this.now() >= Date.parse(deadline) ||
      (!teardown && this.now() >= Date.parse(this.readiness.expiresAt))
    )
      throw Error("v2-authority-closed");
  }
  assertCurrent(request?: GitHubDeliveryRequest) {
    if (request) this.rule(request);
    this.current();
  }
  private observing() {
    // Evidence for an already-invoked effect may finish before the queued close.
    // This never authorizes another credential lookup, dispatch or native call.
    if (
      !this.journal ||
      this.journal.closed ||
      this.now() >= Date.parse(this.grant.teardownDeadline)
    )
      throw Error("v2-observation-closed");
  }
  hasBoundInputs() {
    return this.inputPaths !== undefined;
  }
  async preflight(teardown = false) {
    this.current(teardown);
    const { host, gitFetch } = this.manifest.authority;
    for (const p of teardown
      ? [host.runRoot, host.dataDirectory]
      : [
          host.runRoot,
          host.dataDirectory,
          host.scratchParent,
          gitFetch.workspace,
          gitFetch.commonDirectory,
          gitFetch.scratchParent,
          dirname(this.resultPath),
          ...this.manifest.authority.runtime.map((scope) => scope.workspace),
        ])
      if ((await realpath(p)) !== p || !(await lstat(p)).isDirectory())
        throw Error("v2-host-path");
    for (const p of host.directories.filter(
      (pin) =>
        !teardown || [host.runRoot, host.dataDirectory].includes(pin.path),
    )) {
      const s = await lstat(p.path);
      if (
        s.isSymbolicLink() ||
        !s.isDirectory() ||
        s.dev !== p.dev ||
        s.ino !== p.ino
      )
        throw Error("v2-host-ownership");
    }
    // Original teardown remains available after input/source revocation, solely for
    // already-owned runtime/service stop calls. Canonical ownership is still checked.
    if (!teardown) {
      if (this.inputPaths) {
        const login = host.runtimeCredential;
        const metadata = await lstat(login.authTarget);
        if (
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          metadata.dev !== login.dev ||
          metadata.ino !== login.ino
        )
          throw Error("v2-runtime-credential-changed");
      }
      if (this.inputPaths) {
        for (const pin of [
          { path: this.inputPaths.manifest, sha256: this.manifestSha256 },
          { path: this.inputPaths.grant, sha256: this.grantSha256 },
          {
            path: this.inputPaths.readiness,
            sha256: this.grant.readinessSha256,
          },
        ])
          await this.pinnedFiles.verify(pin, () => this.current(), 262144);
      }
      for (const pin of [
        ...host.files,
        host.gitExecutable,
        host.runtimeExecutable,
        gitFetch.executable,
        ...this.readiness.source,
        host.toolchain.nodeExecutable,
        host.toolchain.nvmrc,
        host.toolchain.packageJson,
        host.toolchain.lockfile,
      ])
        await this.pinnedFiles.verify(pin, () => this.current());
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
      const info = await lstat(this.resultPath).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (
        info &&
        (!info.isFile() || info.isSymbolicLink() || info.size > 1048576)
      )
        throw Error("v2-journal-file");
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
              httpRequests: [],
              effects: {},
              process: null,
              processExit: false,
              terminals: {},
              gitChildren: [],
              callbacks: [],
              runtimeBindings: [],
              captures: {},
              captureEvidence: {},
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
      await this.lock?.close();
      this.lock = undefined;
      throw e;
    }
  }
  private async save() {
    const raw = JSON.stringify(journalSchema.parse(this.journal));
    if (Buffer.byteLength(raw) > 1048576) throw Error("v2-journal-bound");
    const file = await open(`${this.resultPath}.tmp`, "wx", 0o600);
    try {
      await file.writeFile(raw);
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
    if (
      ["__CAB_MERGE_REQUEST__", "__CAB_UPPER_HEAD__", "__CAB_BASE_SHA__"].some(
        (token) => request.url.includes(token),
      )
    )
      throw Error("v2-unresolved-capture");
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
  private mergeMarker() {
    return join(
      this.manifest.authority.host.dataDirectory,
      `stack-fixture-merge-${this.manifest.resource.operationKey}.json`,
    );
  }
  beforeCredential(request: GitHubDeliveryRequest) {
    return this.serial(async () => {
      await this.preflight();
      const { rule, category } = this.rule(request);
      if (category === "writes" && request.method === "PUT") {
        const exists = await lstat(this.mergeMarker()).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (exists) throw Error("v2-original-merge-readback-only");
      }
      this.increment(`http-reserved:${rule.id}`, rule.maxCalls);
      this.increment(
        category === "reads" ? "readReservations" : "writeReservations",
        this.manifest.authority.limits[category],
      );
      this.journal.httpRequests.push({
        ruleId: rule.id,
        requestSha256: materialHash(request),
        phase: "reserved",
        reservedAt: this.now(),
        invokedAt: null,
        responseAt: null,
        responseStatus: null,
        responseSha256: null,
      });
      await this.save();
      this.current();
    });
  }
  beforeCredentialAccess() {
    return this.serial(async () => {
      this.current();
      this.increment(
        "credentialCallbacks",
        this.manifest.authority.limits.credentialCallbacks,
      );
      await this.save();
      this.current();
    });
  }
  afterCredentialLookup() {
    return this.serial(async () => {
      this.observing();
      this.increment(
        "credentialResolverInvocations",
        this.journal.counts.credentials ?? 0,
      );
      await this.save();
      this.observing();
    });
  }
  transportInvoked(request: GitHubDeliveryRequest) {
    return this.serial(async () => {
      this.observing();
      const ticket = this.journal.httpRequests.find(
        (value) =>
          value.requestSha256 === materialHash(request) &&
          value.phase === "dispatch-reserved",
      );
      if (!ticket) throw Error("v2-transport-without-reservation");
      ticket.phase = "invoked";
      ticket.invokedAt = this.now();
      this.increment(
        `transport:${ticket.ruleId}`,
        this.journal.counts[`http:${ticket.ruleId}`] ?? 0,
      );
      const read = this.manifest.authority.reads.some(
        (value) => value.id === ticket.ruleId,
      );
      this.increment(
        read ? "readTransportInvocations" : "writeTransportInvocations",
        this.manifest.authority.limits[read ? "reads" : "writes"],
      );
      await this.save();
      this.observing();
    });
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
      const ticket = this.journal.httpRequests.find(
        (value) =>
          value.requestSha256 === materialHash(request) &&
          value.phase === "reserved",
      );
      if (!ticket) throw Error("v2-dispatch-without-request-reservation");
      if (category === "writes") {
        const u = new URL(request.url);
        if (
          (request.method === "PUT" || u.pathname.endsWith("/unstack")) &&
          this.journal.captures.stackFull !== "yes"
        )
          throw Error("v2-initial-stack-unproved");
        if (
          request.method === "PUT" &&
          this.journal.captures[
            `emptyClosingIssues:${this.manifest.resource.lowerPrId}`
          ] !== "yes"
        )
          throw Error("v2-closing-issues-unproved");
      }
      ticket.phase = "dispatch-reserved";
      this.increment(`http:${rule.id}`, rule.maxCalls);
      this.increment(category, this.manifest.authority.limits[category]);
      if (category === "writes")
        this.increment(
          "firstEffects",
          this.manifest.authority.limits.firstEffects,
        );
      await this.save();
      this.current();
      if (category === "writes" && request.method === "PUT") {
        const marker = await open(this.mergeMarker(), "wx", 0o600);
        try {
          await marker.writeFile(
            JSON.stringify({
              version: 2,
              operationKey: this.manifest.resource.operationKey,
              manifestSha256: this.manifestSha256,
              contextSha256: materialHash(request),
              resultPath: this.resultPath,
            }),
          );
          await marker.sync();
        } finally {
          await marker.close();
        }
        const directory = await open(
          this.manifest.authority.host.dataDirectory,
          "r",
        );
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        this.current();
      }
    });
  }
  reserve(
    call: z.output<typeof calls>,
    material: unknown,
    key: string,
    teardown = false,
    runtimeIntent?: z.output<typeof stackRuntimeIntentSchema>,
    boundaryIntent?: unknown,
  ) {
    return this.serial(async () => {
      if (
        teardown &&
        !["service.stop", "runtime.stop", "runtime.interrupt"].includes(call)
      )
        throw Error("v2-teardown-call");
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
            v.call === call &&
            v.material === materialHash(material) &&
            v.state !== "confirmed",
        )
      )
        throw Error("v2-call-unlisted-or-spent");
      this.increment(`call:${call}:${rule.materialSha256}`, rule.maxCalls);
      this.increment(`call-total:${call}`, Number.MAX_SAFE_INTEGER);
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
      if ((call === "runtime.turn") !== (runtimeIntent !== undefined))
        throw Error("v2-runtime-intent-required-or-unexpected");
      if (
        runtimeIntent &&
        materialHash({
          taskId: runtimeIntent.taskId,
          assignmentId: runtimeIntent.assignmentId,
          workspace: runtimeIntent.workspace,
          settingsSha256: runtimeIntent.settingsSha256,
          policySha256: runtimeIntent.policySha256,
        }) !== materialHash(material)
      )
        throw Error("v2-runtime-intent-material");
      if (
        ["git.prove", "git.adopt", "runtime.thread.resume"].includes(call) !==
        (boundaryIntent !== undefined)
      )
        throw Error("v2-boundary-intent-required-or-unexpected");
      this.journal.effects[key] = {
        boundaryIntentSha256:
          boundaryIntent === undefined ? null : materialHash(boundaryIntent),
        runtimeIntent: runtimeIntent
          ? stackRuntimeIntentSchema.parse(runtimeIntent)
          : null,
        material: materialHash(material),
        call,
        invoked: false,
        state: "reserved",
        receipt: null,
      };
      await this.save();
      this.current(teardown);
    });
  }
  invoked(key: string) {
    return this.serial(async () => {
      this.observing();
      const effect = this.journal.effects[key];
      if (effect?.state !== "reserved" || effect.invoked)
        throw Error("v2-invocation-binding");
      effect.invoked = true;
      this.increment(
        `invocations:${effect.call}`,
        this.journal.counts[`call-total:${effect.call}`] ?? 0,
      );
      await this.save();
      this.observing();
    });
  }
  confirm(key: string, receipt: string, teardown = false) {
    return this.serial(async () => {
      this.current(teardown);
      const effect = this.journal.effects[key];
      if (effect?.state !== "reserved" || receipt.length > 512)
        throw Error("v2-effect-binding");
      effect.state = "confirmed";
      effect.receipt = receipt;
      await this.save();
      this.current(teardown);
    });
  }
  async afterResponse(request: GitHubDeliveryRequest, response: Response) {
    await this.serial(async () => {
      this.current();
      const { rule } = this.rule(request);
      const ticket = this.journal.httpRequests.find(
        (value) =>
          value.requestSha256 === materialHash(request) &&
          value.phase === "invoked",
      );
      if (!ticket) throw Error("v2-response-without-invocation");
      const responded = (raw: string) => {
        ticket.phase = "responded";
        ticket.responseAt = this.now();
        ticket.responseStatus = response.status;
        ticket.responseSha256 = authorityHash(raw);
      };
      if (
        response.redirected ||
        [301, 302, 303, 307, 308].includes(response.status) ||
        (response.headers.get("link") ?? "").trim() !== ""
      )
        throw Error("v2-response-page-or-redirect");
      if (response.status === 204 || response.status === 404) {
        responded("");
        await this.save();
        this.current();
        return;
      }
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
      responded(raw);
      const body: unknown = JSON.parse(raw),
        resource = this.manifest.resource;
      const u = new URL(request.url),
        repo = `/repos/${resource.repository}`;
      const capture = (name: string, value: string) => {
        const prior = this.journal.captures[name];
        if (prior && prior !== value) throw Error("v2-capture-changed");
        this.journal.captures[name] = value;
        if (!prior)
          this.journal.captureEvidence[name] = {
            ruleId: rule.id,
            requestSha256: materialHash(request),
            responseSha256: authorityHash(raw),
            observedAt: this.now(),
          };
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

      if (u.pathname === `${repo}/stacks/${resource.stackNumber}`) {
        const stack = z
          .object({
            id: z.number().int().positive(),
            number: z.literal(resource.stackNumber),
            base: z.object({ ref: z.literal(resource.base) }),
            pull_requests: z
              .array(
                z.object({
                  node_id: text,
                  number: z.number().int().positive(),
                  head: z.object({ ref: text, sha }),
                  state: z.enum(["open", "closed"]),
                  merged_at: z.string().nullable(),
                }),
              )
              .max(2),
          })
          .parse(body);
        if (
          String(stack.id) !== resource.stackId ||
          stack.pull_requests.some((pr, index, all) => {
            const lower = pr.node_id === resource.lowerPrId;
            const heads = lower
              ? [resource.lowerHead]
              : [
                  resource.upperHead,
                  this.journal.captures.upperHead,
                  this.journal.captures["head:proposed"],
                ];
            return (
              ![resource.lowerPrId, resource.upperPrId].includes(pr.node_id) ||
              pr.number !== (lower ? resource.lowerPr : resource.upperPr) ||
              pr.head.ref !== (lower ? resource.lowerRef : resource.upperRef) ||
              !heads.includes(pr.head.sha) ||
              all.findIndex((value) => value.node_id === pr.node_id) !== index
            );
          }) ||
          (stack.pull_requests.length === 2 &&
            (stack.pull_requests[0]?.node_id !== resource.lowerPrId ||
              stack.pull_requests[1]?.node_id !== resource.upperPrId))
        )
          throw Error("v2-stack-membership");
        this.journal.captures.stackFull =
          stack.pull_requests.length === 2 ? "yes" : "no";
      }
      if (u.pathname.endsWith("/check-runs"))
        z.object({
          total_count: z.number().int().nonnegative().max(100),
          check_runs: z.array(z.unknown()).max(100),
        }).parse(body);
      if (u.pathname.endsWith("/statuses"))
        z.array(z.unknown()).max(100).parse(body);
      if (
        [resource.lowerPr, resource.upperPr].some((n) =>
          [
            `${repo}/issues/${n}/comments`,
            `${repo}/pulls/${n}/reviews`,
            `${repo}/pulls/${n}/comments`,
          ].includes(u.pathname),
        )
      ) {
        // Feedback is bounded data, never captured as authority or copied into evidence.
        const entries = z
          .array(
            z.object({
              node_id: text,
              user: z.object({ node_id: text }),
              body: z.string().nullable(),
            }),
          )
          .max(100)
          .parse(body);
        if (
          new Set(entries.map((entry) => entry.node_id)).size !== entries.length
        )
          throw Error("v2-feedback-duplicate");
      }
      if (u.pathname === `${repo}/pulls`) {
        const rows = z
          .array(
            z.object({
              node_id: z.literal(resource.lowerPrId),
              number: z.literal(resource.lowerPr),
              head: z.object({
                ref: z.literal(resource.lowerRef),
                repo: z.object({
                  node_id: z.literal(resource.repositoryNodeId),
                }),
              }),
              base: z.object({ ref: z.literal(resource.base) }),
            }),
          )
          .max(1)
          .parse(body);
        if (!rows.length) throw Error("v2-prior-merge-unproved");
      }
      if (u.pathname === `${repo}/pulls/${resource.lowerPr}`) {
        const pr = z
          .object({
            node_id: z.literal(resource.lowerPrId),
            number: z.literal(resource.lowerPr),
            head: z.object({
              ref: z.literal(resource.lowerRef),
              sha: z.literal(resource.lowerHead),
              repo: z.object({ node_id: z.literal(resource.repositoryNodeId) }),
            }),
            base: z.object({
              ref: z.literal(resource.base),
              repo: z.object({ node_id: z.literal(resource.repositoryNodeId) }),
            }),
            stack: z
              .object({
                id: z.number(),
                number: z.literal(resource.stackNumber),
              })
              .nullable(),
          })
          .parse(body);
        if (pr.stack && String(pr.stack.id) !== resource.stackId)
          throw Error("v2-lower-stack");
      }
      if (u.pathname === repo) {
        const v = z
          .object({
            node_id: text,
            full_name: text,
            visibility: z.enum(["public", "private"]),
            default_branch: text,
            allow_merge_commit: z.boolean(),
            allow_squash_merge: z.boolean(),
            allow_rebase_merge: z.boolean(),
          })
          .parse(body);
        if (
          v.node_id !== resource.repositoryNodeId ||
          v.full_name !== resource.repository ||
          v.visibility !== resource.visibility ||
          v.default_branch !== resource.repositoryDefaultBranch ||
          [
            "allow_merge_commit",
            "allow_squash_merge",
            "allow_rebase_merge",
          ].some(
            (key) =>
              v[key as keyof typeof v] !==
              resource.mergeCapabilities[
                key as keyof typeof resource.mergeCapabilities
              ],
          )
        )
          throw Error("v2-repository-identity");
      }
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
        const proposed = this.journal.captures[`${kind}:proposed`];
        if (value !== initial) {
          if (proposed && proposed !== value)
            throw Error("v2-second-fresh-sha");
          this.journal.captures[`${kind}:proposed`] = value;
        }
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
            stack: z
              .object({
                id: z.number(),
                number: z.literal(resource.stackNumber),
              })
              .nullable(),
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
          (v.stack !== null && String(v.stack.id) !== resource.stackId) ||
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
        if (
          v.id === resource.repositoryNodeId &&
          v.nameWithOwner !== resource.repository
        )
          throw Error("v2-graph-repository");
        if (v.id === resource.lowerPrId) {
          z.object({
            repository: z.object({ id: z.literal(resource.repositoryNodeId) }),
            number: z.literal(resource.lowerPr),
            headRefName: z.literal(resource.lowerRef),
            baseRefName: z.literal(resource.base),
            headRefOid: z.literal(resource.lowerHead),
          }).parse(v);
        }
        if ([resource.lowerPrId, resource.upperPrId].includes(String(v.id))) {
          z.object({
            closingIssuesReferences: z.object({
              nodes: z.array(z.unknown()).length(0),
              pageInfo: z.object({ hasNextPage: z.literal(false) }),
            }),
            reviewThreads: z.object({
              pageInfo: z.object({ hasNextPage: z.literal(false) }),
            }),
          }).parse(v);
          this.journal.captures[`emptyClosingIssues:${String(v.id)}`] = "yes";
        }
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
  get fixtureMergeApiVersion(): "2026-03-10" | undefined {
    const rule = this.manifest.authority.writes.find(
      (value) => value.id === this.manifest.authority.captures.mergeRuleId,
    );
    return rule?.request.version === "2026-03-10" ? "2026-03-10" : undefined;
  }
  async workspaceImage() {
    const scope = this.manifest.authority.gitFetch,
      host = this.manifest.authority.host;
    const key = `host:workspace:image:${this.journal.counts["call-total:host.workspace.image"] ?? 0}`;
    await this.reserve(
      "host.workspace.image",
      { workspace: scope.workspace },
      key,
    );
    await this.invoked(key);
    const git = async (args: string[]) => {
      const sequence = await this.beginGitChild(key);
      this.current();
      const result = await runGit({
        executable: host.gitExecutable.path,
        cwd: scope.workspace,
        args,
        timeoutMs: 3000,
        terminationGraceMs: 500,
        observationMs: 1000,
        maxOutputBytes: 4096,
        observeSettlement: true,
      });
      await this.endGitChild(key, sequence, result);
      this.current();
      if (result.status !== "ok") throw Error("v2-workspace-image-git");
      return result.stdout.toString("utf8").trim();
    };
    const head = sha.parse(await git(["rev-parse", "--verify", "HEAD"]));
    const indexPath = await git([
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ]);
    if (
      (await realpath(indexPath)) !== indexPath ||
      !indexPath.startsWith(`${scope.commonDirectory}${sep}`)
    )
      throw Error("v2-workspace-index-scope");
    let files = 0,
      bytes = 0;
    const digestFile = async (filePath: string) => {
      this.current();
      const info = await lstat(filePath, { bigint: true });
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        ++files > host.workspaceImage.maxFiles ||
        info.size > BigInt(host.workspaceImage.maxBytes - bytes)
      )
        throw Error("v2-workspace-image-bound");
      const file = await open(
        filePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const opened = await file.stat({ bigint: true });
        if (
          opened.dev !== info.dev ||
          opened.ino !== info.ino ||
          opened.size !== info.size
        )
          throw Error("v2-workspace-image-race");
        const hash = createHash("sha256");
        let length = 0;
        for await (const chunk of file.createReadStream({
          autoClose: false,
          highWaterMark: 65536,
        })) {
          this.current();
          length += chunk.byteLength;
          if (
            length > Number(info.size) ||
            bytes + length > host.workspaceImage.maxBytes
          )
            throw Error("v2-workspace-image-bound");
          hash.update(chunk);
        }
        const ended = await file.stat({ bigint: true });
        if (
          ended.size !== info.size ||
          ended.mtimeNs !== info.mtimeNs ||
          ended.ctimeNs !== info.ctimeNs ||
          length !== Number(info.size)
        )
          throw Error("v2-workspace-image-race");
        bytes += length;
        return hash.digest("hex");
      } finally {
        await file.close();
      }
    };
    const index = await digestFile(indexPath),
      entries: unknown[] = [];
    const walk = async (directory: string): Promise<void> => {
      this.current();
      if ((await realpath(directory)) !== directory)
        throw Error("v2-workspace-image-directory");
      const children = await readdir(directory);
      children.sort();
      if (children.length + entries.length > host.workspaceImage.maxFiles)
        throw Error("v2-workspace-image-bound");
      for (const name of children) {
        if (directory === scope.workspace && name === ".git") continue;
        const target = join(directory, name),
          info = await lstat(target);
        if (info.isSymbolicLink()) {
          if (++files > host.workspaceImage.maxFiles)
            throw Error("v2-workspace-image-bound");
          entries.push([
            relative(scope.workspace, target),
            "link",
            authorityHash(await readlink(target)),
          ]);
        } else if (info.isDirectory()) {
          entries.push([
            relative(scope.workspace, target),
            "directory",
            info.mode,
          ]);
          await walk(target);
        } else
          entries.push([
            relative(scope.workspace, target),
            "file",
            info.mode,
            await digestFile(target),
          ]);
      }
    };
    await walk(scope.workspace);
    if ((await git(["rev-parse", "--verify", "HEAD"])) !== head)
      throw Error("v2-workspace-head-race");
    const result = { head, index, files: materialHash(entries) };
    await this.confirm(key, materialHash(result));
    return result;
  }
  async verifySourceIdentity() {
    const host = this.manifest.authority.host;
    const material = {
      root: host.sourceRoot,
      branch: host.sourceBranch,
      commit: this.readiness.sourceCommit,
      tree: this.readiness.sourceTree,
    };
    const key = "host:source";
    await this.reserve("host.source", material, key);
    await this.invoked(key);
    const values: string[] = [];
    for (const args of [
      ["rev-parse", "--verify", "HEAD"],
      ["rev-parse", "--verify", "HEAD^{tree}"],
      ["symbolic-ref", "--quiet", "HEAD"],
    ]) {
      const sequence = await this.beginGitChild(key);
      this.current();
      const result = await runGit({
        executable: host.gitExecutable.path,
        cwd: host.sourceRoot,
        args,
        timeoutMs: 3000,
        terminationGraceMs: 500,
        observationMs: 1000,
        maxOutputBytes: 4096,
        observeSettlement: true,
      });
      await this.endGitChild(key, sequence, result);
      this.current();
      if (result.status !== "ok") throw Error("v2-source-identity-unproved");
      values.push(result.stdout.toString("utf8").trim());
    }
    if (
      values[0] !== material.commit ||
      values[1] !== material.tree ||
      values[2] !== `refs/heads/${material.branch}`
    )
      throw Error("v2-source-identity-changed");
    await this.confirm(key, materialHash(material));
  }
  async afterGit(
    operation: "prove" | "adopt",
    request: Readonly<Record<string, unknown>>,
    result: unknown,
  ) {
    const key = `git:${operation}:${materialHash(request)}`;
    if (
      this.journal.gitChildren.some(
        (child) => child.operation === key && child.state !== "exited",
      )
    )
      throw Error("v2-git-owned-child-unfinished");
    await this.confirm(key, materialHash(result));
  }
  async beforeGit(
    operation: "prove" | "adopt",
    request: Readonly<Record<string, unknown>>,
  ) {
    request = Object.freeze({ ...request });
    this.current();
    const scope = this.manifest.authority.gitFetch;
    if (
      request.host !== "github.com" ||
      (operation === "prove"
        ? request.repositoryId !== this.manifest.resource.repositoryNodeId
        : `https://github.com/${request.nameWithOwner}.git` !==
          scope.repositoryUrl) ||
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
      {
        repositoryId: this.manifest.resource.repositoryNodeId,
        repositoryUrl: scope.repositoryUrl,
        workspacePath: scope.workspace,
        commonDirectory: scope.commonDirectory,
        branch: scope.branch,
        commits: scope.commits,
      },
      key,
      false,
      undefined,
      request,
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
        beforeChild: () => this.beginGitChild(key),
        afterChild: async (sequence: number, result: GitRunResult) => {
          await this.endGitChild(key, sequence, result);
          if (!gitChildExited(result))
            throw Error("v2-git-child-exit-unproved");
        },
        beforeEffect: async (phase: string) => {
          if (
            phase === "teardown" &&
            this.journal.gitChildren.some((child) => child.state !== "exited")
          )
            throw Error("v2-git-teardown-unproved");
          if (phase === "teardown") {
            for (const path of [scope.scratchParent, scope.commonDirectory]) {
              const pin = this.manifest.authority.host.directories.find(
                (value) => value.path === path,
              );
              const info = await lstat(path);
              if (
                !pin ||
                (await realpath(path)) !== path ||
                !info.isDirectory() ||
                info.dev !== pin.dev ||
                info.ino !== pin.ino
              )
                throw Error("v2-git-teardown-ownership");
            }
          }
          if (!this.journal.effects[key]!.invoked) await this.invoked(key);
          await this.preflight(phase === "teardown");
          this.current(phase === "teardown");
          if (signal.aborted && phase !== "teardown")
            throw Error("v2-git-deadline");
        },
      },
    };
  }
  private beginGitChild(operation: string) {
    return this.serial(async () => {
      this.current();
      await this.preflight();
      if (!this.journal.effects[operation]) throw Error("v2-git-child-intent");
      this.increment(
        "gitChildren",
        this.manifest.authority.gitFetch.maxChildren,
      );
      this.increment(
        "firstEffects",
        this.manifest.authority.limits.firstEffects,
      );
      const sequence = this.journal.counts.gitChildren!;
      this.journal.gitChildren.push({
        sequence,
        operation,
        state: "reserved",
        spawned: null,
        status: null,
      });
      await this.save();
      this.current();
      return sequence;
    });
  }
  private endGitChild(
    operation: string,
    sequence: number,
    result: GitRunResult,
  ) {
    return this.serial(async () => {
      this.observing();
      const child = this.journal.gitChildren.find(
        (value) => value.operation === operation && value.sequence === sequence,
      );
      if (child?.state !== "reserved") throw Error("v2-git-child-binding");
      child.state = gitChildExited(result) ? "exited" : "unknown";
      child.spawned = result.status === "interrupted" ? result.spawned : true;
      child.status = result.status;
      await this.save();
      this.observing();
    });
  }
  beginCallback(call: RuntimeToolCall) {
    return this.serial(async () => {
      this.current();
      const binding = this.journal.runtimeBindings.find(
        (value) =>
          value.threadId === call.threadId && value.turnId === call.turnId,
      );
      const scope =
        binding &&
        this.manifest.authority.runtime.find(
          (value) =>
            value.taskId === binding.taskId &&
            value.assignmentId === binding.assignmentId,
        );
      const tool = z
        .enum(["cab_register_pr", "cab_report_result"])
        .parse(call.tool);
      if (!binding || !scope) throw Error("v2-callback-binding");
      text.parse(call.callId);
      const key = materialHash({ workId: binding.workId, callId: call.callId });
      if (this.journal.callbacks.some((value) => value.key === key))
        throw Error("v2-callback-already-attempted");
      this.increment("callbacks", this.manifest.authority.limits.callbacks);
      this.increment(`callbacks:${scope.taskId}`, scope.maxCallbacks);
      this.increment(
        "firstEffects",
        this.manifest.authority.limits.firstEffects,
      );
      this.journal.callbacks.push({
        key,
        workId: binding.workId,
        callId: call.callId,
        tool,
        argumentsSha256: materialHash(call.arguments),
        invoked: false,
        state: "reserved",
        succeeded: null,
      });
      await this.save();
      this.current();
      return key;
    });
  }
  callbackInvoked(key: string) {
    return this.serial(async () => {
      this.observing();
      const callback = this.journal.callbacks.find(
        (value) => value.key === key,
      );
      if (callback?.state !== "reserved" || callback.invoked)
        throw Error("v2-callback-invocation-binding");
      callback.invoked = true;
      this.increment("callbackInvocations", this.journal.counts.callbacks ?? 0);
      await this.save();
      this.observing();
    });
  }
  endCallback(key: string, succeeded: boolean) {
    return this.serial(async () => {
      this.observing();
      const callback = this.journal.callbacks.find(
        (value) => value.key === key,
      );
      if (callback?.state !== "reserved")
        throw Error("v2-callback-end-binding");
      callback.state = "ended";
      callback.succeeded = succeeded;
      await this.save();
      this.observing();
    });
  }
  async captureProcess(
    identity: z.output<typeof processIdentitySchema>,
    teardown = false,
  ) {
    await this.serial(async () => {
      this.current(teardown);
      const parsed = processIdentitySchema.parse(identity);
      if (
        this.journal.process &&
        materialHash(this.journal.process) !== materialHash(parsed)
      )
        throw Error("v2-process-replacement");
      this.journal.process = parsed;
      await this.save();
      this.current(teardown);
    });
  }
  async bindTurn(binding: Journal["runtimeBindings"][number]) {
    await this.serial(async () => {
      this.current();
      if (
        !this.journal.process ||
        materialHash(this.journal.process) !== binding.processSha256 ||
        this.journal.runtimeBindings.some(
          (v) => v.workId === binding.workId || v.turnId === binding.turnId,
        )
      )
        throw Error("v2-runtime-binding");
      this.journal.runtimeBindings.push(binding);
      journalSchema.parse(this.journal);
      await this.save();
      this.current();
    });
  }
  async proveProcessExit(identity: z.output<typeof processIdentitySchema>) {
    await this.serial(async () => {
      this.current(true);
      if (materialHash(this.journal.process) !== materialHash(identity))
        throw Error("v2-process-exit-identity");
      this.journal.processExit = true;
      await this.save();
      this.current(true);
    });
  }
  async terminal(workId: string, status: "completed" | "failed") {
    await this.serial(async () => {
      this.current();
      if (
        !this.journal.runtimeBindings.some((v) => v.workId === workId) ||
        (this.journal.terminals[workId] &&
          this.journal.terminals[workId] !== status)
      )
        throw Error("v2-terminal-identity");
      this.journal.terminals[workId] = status;
      await this.save();
      this.current();
    });
  }
  close() {
    this.closePromise ??= this.finishClose();
    return this.closePromise;
  }
  private async finishClose() {
    this.closing = true;
    const close = this.queue.then(async () => {
      this.fault = true;
      if (this.journal) {
        this.journal.closed = true;
        try {
          await this.save();
        } finally {
          await this.lock?.close();
          this.lock = undefined;
        }
      } else {
        await this.lock?.close();
        this.lock = undefined;
      }
      // Retain the durable lock/checkpoint for original-identity recovery.
    });
    this.queue = close.then(
      () => {},
      () => {
        this.fault = true;
      },
    );
    await close;
  }

  snapshot() {
    return structuredClone(this.journal);
  }
}
