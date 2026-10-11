import { createHash } from "node:crypto";
import { type FileHandle, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import {
  retainedEvidenceItemContentReadSchema,
  retainedResultEvidenceReadSchema,
  reviewReadSchema,
  taskResultPageSchema,
} from "../operator/contracts.js";
import {
  anyNull,
  type BrowseCommand,
  browseOutput,
  type CoverageGap,
  cursorQuery,
  decodeCursor,
  pageLimit,
  readWithCursor,
  uuidArg,
} from "./browse.js";
import { CliError } from "./connections.js";
import { isoTime, keyValues, oneLine, table, unavailable } from "./render.js";

const API = "/api/operator";
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** Writes verified bytes to a new owner-only file; any failure leaves no file. */
async function writeOut(path: string, body: Buffer) {
  const target = resolve(path);
  let handle: FileHandle;
  try {
    handle = await open(target, "wx", 0o600);
  } catch (error) {
    throw (error as { code?: string }).code === "EEXIST"
      ? new CliError("output-exists", `${target} already exists.`)
      : new CliError("output-failed", `Cannot create ${target}.`);
  }
  try {
    await handle.writeFile(body);
    await handle.close();
  } catch {
    await handle.close().catch(() => undefined);
    await unlink(target).catch(() => undefined);
    throw new CliError("output-failed", `Cannot write ${target}.`);
  }
  return target;
}

function verify(body: Buffer, expected: string | null, size?: number) {
  if (
    expected === null ||
    sha256(body) !== expected ||
    (size !== undefined && body.byteLength !== size)
  )
    throw new CliError(
      "integrity-mismatch",
      "The received bytes do not match their recorded digest; nothing was written.",
      { retryable: true },
    );
}

const resultList: BrowseCommand = {
  usage: "result list TASK_ID [--limit N] [--cursor TOKEN]",
  positionals: 1,
  capabilities: ["cli.identity", "result.read"],
  async run(ctx) {
    const id = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
    const limit = pageLimit(ctx.values, { serverMax: 200 });
    const q = cursorQuery({ task: id });
    const cursor = decodeCursor(ctx.values.cursor, "result list", q);
    const client = await ctx.connect();
    const params = new URLSearchParams({ limit: String(limit.limit) });
    if (cursor) params.set("cursor", cursor.c);
    const read = await readWithCursor(!!cursor, () =>
      client.get(
        `${API}/tasks/${encodeURIComponent(id)}/results?${params}`,
        taskResultPageSchema,
      ),
    );
    const { nextCursor, ...page } = read.data;
    return browseOutput(ctx, {
      data: page,
      observedAt: read.observedAt,
      gaps: anyNull(...page.results.map((r) => r.summary))
        ? ["content-unavailable"]
        : [],
      page: {
        kind: "result list",
        query: q,
        limit,
        returned: page.results.length,
        next: nextCursor,
      },
      human: [
        `${page.total} results`,
        page.results.length
          ? table(
              ["Result", "Created", "Assignment", "Work", "Summary"],
              page.results.map((r) => [
                r.resultId,
                isoTime(r.createdAt),
                r.assignmentId,
                `${r.workId} r${r.workRevision}`,
                oneLine(r.summary),
              ]),
            )
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  },
};

const resultGet: BrowseCommand = {
  usage: "result get TASK_ID RESULT_ID",
  positionals: 2,
  capabilities: ["cli.identity", "result.read"],
  async run(ctx) {
    const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
    const resultId = uuidArg(ctx.positionals[3] ?? "", "RESULT_ID");
    const client = await ctx.connect();
    const task = `${API}/tasks/${encodeURIComponent(taskId)}`;
    // A result without a review record has no evidence manifest to read.
    const [results, reviewRead, evidence] = await Promise.all([
      client.get(`${task}/results?resultId=${resultId}`, taskResultPageSchema),
      client.get(`${task}/review?resultId=${resultId}`, reviewReadSchema),
      client
        .get(
          `${task}/results/${resultId}/evidence`,
          retainedResultEvidenceReadSchema,
        )
        .catch((error: unknown) => {
          if (error instanceof CliError && error.extra.status === 404)
            return undefined;
          throw error;
        }),
    ]);
    const result = results.data.results[0];
    if (!result) throw new CliError("not-found", "Result not found.");
    const review =
      reviewRead.data.results.find((r) => r.resultId === resultId) ?? null;
    const e = evidence?.data ?? null;
    const items = !e || e.state === "unavailable" ? [] : e.items;
    const gaps: CoverageGap[] = [];
    if (!review) gaps.push("review-unavailable");
    if (
      !e ||
      e.state === "unavailable" ||
      items.some((i) => i.state === "unavailable")
    )
      gaps.push("evidence-unavailable");
    if (
      e?.state === "gap" ||
      e?.state === "partial" ||
      items.some((i) => i.state === "gap")
    )
      gaps.push("evidence-gap");
    if (result.summary === null) gaps.push("content-unavailable");
    const m = review?.metadata;
    return browseOutput(ctx, {
      data: { result, review, evidence: e },
      observedAt: Math.min(
        results.observedAt,
        reviewRead.observedAt,
        evidence?.observedAt ?? reviewRead.observedAt,
      ),
      notes: ["retained records only"],
      gaps,
      human: [
        keyValues([
          ["Result", result.resultId],
          ["Task", result.taskId],
          ["Assignment", result.assignmentId],
          [
            "Work",
            `${result.workId} revision ${result.workRevision}, assignment version ${result.assignmentVersion}`,
          ],
          ["Created", isoTime(result.createdAt)],
          ["Destination", result.destinationDisposition],
        ]),
        "",
        unavailable(result.summary),
        ...(m
          ? [
              "",
              ...m.criteria.map(
                (c) =>
                  `Criterion ${c.criterionId}: ${c.outcome} (${oneLine(c.scope)})`,
              ),
              ...m.validations.map(
                (v) => `Validation ${oneLine(v.label, 60)}: ${v.outcome}`,
              ),
              ...m.decisions.map(
                (d) =>
                  `Decision: ${oneLine(d.text)} (${oneLine(d.attribution, 40)})`,
              ),
              ...m.artifacts.map(
                (a) =>
                  `Artifact ${a.artifactId}: ${oneLine(a.label, 60)} [${a.availability}]`,
              ),
            ]
          : []),
        "",
        !e
          ? "Evidence: none recorded"
          : e.state === "unavailable"
            ? `Evidence: unavailable (${e.reason})`
            : `Evidence: ${e.state}, captured ${isoTime(e.capturedAt)}`,
        ...(items.length
          ? [
              table(
                ["Item", "State", "Kind", "Path or reason", "Size"],
                items.map((i) =>
                  i.state === "available"
                    ? [i.itemId, i.state, i.kind, i.path, String(i.size)]
                    : [i.itemId, i.state, i.kind, i.reason, ""],
                ),
              ),
            ]
          : []),
      ].join("\n"),
    });
  },
};

const resultEvidence: BrowseCommand = {
  usage: "result evidence TASK_ID RESULT_ID ITEM_ID [--out PATH]",
  positionals: 3,
  capabilities: ["cli.identity", "result.read"],
  async run(ctx) {
    const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
    const resultId = uuidArg(ctx.positionals[3] ?? "", "RESULT_ID");
    const itemId = uuidArg(ctx.positionals[4] ?? "", "ITEM_ID");
    const client = await ctx.connect();
    const read = await client.get(
      `${API}/tasks/${encodeURIComponent(taskId)}/results/${resultId}/evidence/${itemId}`,
      retainedEvidenceItemContentReadSchema,
    );
    const d = read.data;
    if (d.state !== "available") {
      if (ctx.values.out !== undefined)
        throw new CliError(
          "unavailable",
          `Evidence item is ${d.state} (${d.reason}); nothing was written.`,
        );
      return browseOutput(ctx, {
        data: d,
        observedAt: read.observedAt,
        gaps: [d.state === "gap" ? "evidence-gap" : "evidence-unavailable"],
        human: `Evidence item ${d.itemId}: ${d.state} (${d.reason})`,
      });
    }
    const body =
      d.preview.kind === "text"
        ? Buffer.from(d.preview.text, "utf8")
        : Buffer.from(d.preview.data, "base64");
    verify(body, d.item.sha256, d.item.size);
    const written =
      ctx.values.out === undefined
        ? undefined
        : await writeOut(ctx.values.out, body);
    return browseOutput(ctx, {
      data: { ...d, ...(written ? { out: written } : {}) },
      observedAt: read.observedAt,
      human: [
        keyValues([
          ["Item", d.itemId],
          ["Path", d.item.path],
          ["Source", d.item.source],
          ["Type", d.item.mime],
          ["Size", String(d.item.size)],
          ["SHA-256", d.item.sha256],
          ["Captured", isoTime(d.item.capturedAt)],
          ...(written ? ([["Written", written]] as [string, string][]) : []),
        ]),
        ...(!written && d.preview.kind === "text" ? ["", d.preview.text] : []),
      ].join("\n"),
    });
  },
};

const artifactGet: BrowseCommand = {
  usage: "artifact get TASK_ID ARTIFACT_ID --out PATH",
  positionals: 2,
  capabilities: ["cli.identity", "artifact.read"],
  async run(ctx) {
    const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
    const artifactId = uuidArg(ctx.positionals[3] ?? "", "ARTIFACT_ID");
    const out = ctx.values.out;
    if (out === undefined)
      throw new CliError("usage", "artifact get requires --out PATH.");
    const client = await ctx.connect();
    const file = await client.getBytes(
      `${API}/tasks/${encodeURIComponent(taskId)}/artifacts/${artifactId}`,
    );
    const digest = file.headers.get("x-ensemble-sha256");
    verify(file.body, digest);
    const source = file.headers.get("x-ensemble-evidence-source");
    const path = await writeOut(out, file.body);
    return browseOutput(ctx, {
      data: {
        artifactId,
        path,
        size: file.body.byteLength,
        sha256: digest,
        mime: file.type,
        source,
      },
      // Byte reads have no envelope; the response Date is the service's read time.
      observedAt: Date.parse(file.headers.get("date") ?? "") || Date.now(),
      human: keyValues([
        ["Artifact", artifactId],
        ["Written", path],
        ["Size", String(file.body.byteLength)],
        ["SHA-256", String(digest)],
        ["Source", String(source)],
      ]),
    });
  },
};

export const evidenceCommands: [string, BrowseCommand][] = [
  ["result list", resultList],
  ["result get", resultGet],
  ["result evidence", resultEvidence],
  ["artifact get", artifactGet],
];
