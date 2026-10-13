import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { sourceCredentialReference } from "../core/credential-reference.js";
import {
  readinessSchema,
  repositoryLinkSchema,
  selectionSchema,
} from "../core/github-source-contracts.js";
import {
  type CommandReceipt,
  sourceObservationSchema,
  taskSchema,
} from "../operator/contracts.js";
import {
  type SourceCredentialReason,
  sourceCredentialExplanation,
} from "../operator/source-credential.js";
import {
  type BrowseCommand,
  browseOutput,
  type CoverageGap,
  uuidArg,
} from "./browse.js";
import {
  type Change,
  checkExpected,
  positiveIntFlag,
  requireOut,
  writePrepared,
} from "./configure.js";
import { readProject } from "./configure-project.js";
import { CliError } from "./connections.js";
import { receiptLines } from "./operation.js";
import { keyValues, table, unavailable } from "./render.js";
import type { ServiceClient } from "./transport.js";
import {
  requestKey,
  type Session,
  sendCommand,
  type WriteCommand,
  type WriteContext,
} from "./write.js";

const API = "/api/operator";
type Source = Awaited<ReturnType<typeof readProject>>["data"]["source"];

const MAX_EDIT_BYTES = 64 * 1024;
const kindLabel = (kind: string) =>
  kind === "repository"
    ? "Repository"
    : kind === "project"
      ? "GitHub Project"
      : "Search";
const conditions = (n: number) => `${n} condition${n === 1 ? "" : "s"}`;
const readinessText = (r: Source["readiness"]) =>
  r ? `${r.mode} of ${conditions(r.conditions.length)}` : "(unavailable)";
const sourceCredentialReasons: SourceCredentialReason[] = [
  "missing-credential",
  "invalid-credential-reference",
  "gh-not-installed",
  "gh-not-signed-in",
  "gh-unreadable",
];

const readObservations = (client: ServiceClient, projectId: string) =>
  client
    .get(`${API}/source-observations`, sourceObservationSchema)
    .then(
      (r) =>
        r.data.projects.find((p) => p.projectId === projectId)?.selections ??
        [],
    );

const requireWriteScope = (session: Session) => {
  if (session.identity.credential.scope !== "read-write")
    throw new CliError(
      "insufficient-scope",
      "This connection's credential is read-only.",
    );
};

/** Saved rows this read cannot name; a CLI edit could not keep them. */
const unnamed = (source: Source) =>
  source.selections.some((s) => s.id === null) ||
  source.repositories.some((r) => r.repositoryId === null || r.ref === null);

const sourcesCommand: BrowseCommand = {
  usage: "project sources PROJECT_ID",
  positionals: 1,
  capabilities: ["cli.identity", "workspace.read"],
  async run(ctx) {
    const id = uuidArg(ctx.positionals[2] ?? "", "PROJECT_ID");
    const client = await ctx.connect();
    const read = await readProject(client, id);
    const observations = await readObservations(client, id);
    const { source, placements } = read.data;
    const observed = (selectionId: string | null) =>
      observations.find((o) => o.selectionId === selectionId);
    const gaps: CoverageGap[] = [];
    if (
      unnamed(source) ||
      source.readiness === null ||
      source.selections.some((s) => s.kind !== "search" && !s.descriptor)
    )
      gaps.push("content-unavailable");
    if (observations.some((o) => o.state === "partial"))
      gaps.push("evidence-gap");
    if (observations.some((o) => o.state === "unavailable"))
      gaps.push("redaction-unavailable");
    return browseOutput(ctx, {
      data: { projectId: id, source, placements, observations },
      observedAt: read.observedAt,
      gaps,
      human: [
        keyValues([
          ["Project", id],
          ["Source version", String(source.version)],
          [
            "Credential",
            source.credential?.source === "gh"
              ? "GitHub CLI"
              : source.credential?.source === "env"
                ? "environment variable"
                : source.credentialConfigured
                  ? "configured"
                  : "not configured",
          ],
          ...(source.credential
            ? [
                [
                  "Credential usable",
                  source.credential.usable ? "yes" : "no",
                ] as [string, string],
                ...(source.credential.reason
                  ? [
                      [
                        "Credential reason",
                        sourceCredentialExplanation(source.credential.reason),
                      ] as [string, string],
                    ]
                  : []),
                ...(source.credential.gh.state === "signed-in"
                  ? [
                      [
                        "Detected GitHub CLI account",
                        `@${source.credential.gh.login}`,
                      ] as [string, string],
                    ]
                  : []),
              ]
            : []),
          ["Readiness", readinessText(source.readiness)],
        ] as [string, string][]),
        "",
        source.selections.length
          ? table(
              [
                "Selection",
                "Kind",
                "Descriptor",
                "Active",
                "Observed",
                "Last success",
              ],
              source.selections.map((s) => {
                const o = observed(s.id);
                return [
                  unavailable(s.id),
                  kindLabel(s.kind),
                  s.kind === "search"
                    ? "(query private)"
                    : unavailable(s.descriptor),
                  s.active ? "yes" : "no",
                  o
                    ? `${o.state}${o.lastAttemptAt ? ` ${o.lastAttemptAt}` : ""}`
                    : "-",
                  o?.lastSuccessfulAt ?? "-",
                ];
              }),
            )
          : "No selections.",
        "",
        source.repositories.length
          ? table(
              ["Repository", "Ref"],
              source.repositories.map((r) => [
                unavailable(r.repositoryId),
                unavailable(r.ref),
              ]),
            )
          : "No linked repositories.",
        ...(placements.length
          ? [
              "",
              "Placement conflicts (choose with 'ensemble project place-task'):",
              table(
                ["Task", "Version", "Title", "Choices"],
                placements.map((p) => [
                  p.taskId,
                  String(p.version),
                  unavailable(p.title),
                  p.choices.map((c) => c.id).join(", "),
                ]),
              ),
            ]
          : []),
      ].join("\n"),
    });
  },
};

const editSchema = z
  .object({
    addSelections: z
      .array(z.record(z.string(), z.unknown()))
      .max(30)
      .optional(),
    removeSelections: z.array(z.string().min(1).max(512)).max(30).optional(),
    readiness: readinessSchema.optional(),
    linkRepositories: z.array(repositoryLinkSchema).max(20).optional(),
    unlinkRepositories: z.array(z.string().min(1).max(512)).max(20).optional(),
    setRefs: z.record(z.string(), z.string().trim().min(1).max(512)).optional(),
    credentialRef: sourceCredentialReference.nullable().optional(),
    confirmUnlinkAll: z.literal(true).optional(),
  })
  .strict();
export type SourceEdit = z.infer<typeof editSchema>;

/** Reads the edit file: owner's regular file, no symlink, at most 64 KiB of strict JSON. */
async function readEdit(path: string | undefined): Promise<SourceEdit> {
  if (!path) throw new CliError("usage", "--edit-file FILE is required.");
  const invalid = (why: string) =>
    new CliError("invalid-input", `--edit-file ${why}.`);
  let text: string;
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_EDIT_BYTES)
        throw invalid("must be a regular file of at most 64 KiB");
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw invalid("must be a readable regular file, not a symlink");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid("is not JSON");
  }
  const parsed = editSchema.safeParse(value);
  if (!parsed.success)
    throw invalid(
      `is not a valid source edit: ${[...new Set(parsed.error.issues.map((i) => i.path.join(".") || i.message))].join(", ")}`,
    );
  return parsed.data;
}

const duplicates = (values: string[]) =>
  values.filter((v, i) => values.indexOf(v) !== i);

/** The exact `github.configure` the edit makes of the saved source, with its preview. */
export function sourceEditCommand(
  projectId: string,
  source: Source,
  edit: SourceEdit,
) {
  const bad = (why: string) => new CliError("invalid-input", why);
  if (unnamed(source))
    throw new CliError(
      "conflict",
      "A saved selection or repository link cannot be named in this read, so the CLI cannot keep it. Nothing was prepared.",
    );
  if (source.readiness === null && !edit.readiness)
    throw new CliError(
      "conflict",
      'The saved readiness cannot be read; replace it with "readiness" in the edit file. Nothing was prepared.',
    );
  const saved = source.selections.map((s) => ({ ...s, id: String(s.id) }));
  const remove = edit.removeSelections ?? [];
  const unlink = edit.unlinkRepositories ?? [];
  const links = edit.linkRepositories ?? [];
  const refs = edit.setRefs ?? {};
  const linked = source.repositories.map((r) => String(r.repositoryId));
  for (const [what, list] of [
    ["removeSelections", remove],
    ["unlinkRepositories", unlink],
    ["linkRepositories", links.map((l) => l.repositoryId)],
  ] as const)
    if (duplicates(list).length)
      throw bad(`${what} lists ${duplicates(list).join(", ")} more than once.`);
  for (const id of remove)
    if (!saved.some((s) => s.id === id))
      throw bad(`removeSelections: ${id} is not a saved selection.`);
  for (const id of unlink)
    if (!linked.includes(id))
      throw bad(`unlinkRepositories: ${id} is not linked.`);
  for (const { repositoryId } of links)
    if (linked.includes(repositoryId))
      throw bad(
        `linkRepositories: ${repositoryId} is already linked; use setRefs to change its ref.`,
      );
  for (const id of Object.keys(refs))
    if (!linked.includes(id) || unlink.includes(id))
      throw bad(`setRefs: ${id} is not a kept linked repository.`);

  let next = Math.max(
    0,
    ...saved.map((s) => Number(/^S-(\d+)$/.exec(s.id)?.[1] ?? 0)),
  );
  const added = (edit.addSelections ?? []).map((definition) => {
    if ("id" in definition)
      throw bad(
        "addSelections entries are given the next free S-n id; omit id.",
      );
    const parsed = selectionSchema.safeParse({
      id: `S-${++next}`,
      ...definition,
    });
    if (!parsed.success)
      throw bad(
        `addSelections: invalid selection (${[...new Set(parsed.error.issues.map((i) => i.path.join(".") || i.message))].join(", ")}).`,
      );
    return parsed.data;
  });
  const repositories = [
    ...source.repositories
      .filter((r) => !unlink.includes(String(r.repositoryId)))
      .map((r) => ({
        repositoryId: String(r.repositoryId),
        ref: refs[String(r.repositoryId)] ?? String(r.ref),
      })),
    ...links.map((l) => ({
      repositoryId: l.repositoryId,
      path: l.path,
      ref: l.ref,
    })),
  ];
  if (
    source.repositories.length > 0 &&
    repositories.length === 0 &&
    !edit.confirmUnlinkAll
  )
    throw bad(
      'This edit removes every repository link, so no task can be checked out. Add "confirmUnlinkAll": true to confirm.',
    );
  const readiness = edit.readiness ?? source.readiness;
  const command: Record<string, unknown> = {
    type: "github.configure",
    projectId,
    expectedVersion: source.version,
    selections: [
      ...saved
        .filter((s) => !remove.includes(s.id))
        .map((s) => ({ id: s.id, keep: true })),
      ...added,
    ],
    readiness,
    repositories,
    ...(edit.credentialRef === undefined
      ? {}
      : { credentialRef: edit.credentialRef }),
  };

  // Preview lines follow the operator UI and never carry a query, filter, path or reference.
  const diff: string[] = [];
  for (const s of saved)
    if (remove.includes(s.id))
      diff.push(
        `− ${s.id} · ${kindLabel(s.kind)}${s.descriptor ? ` ${s.descriptor}` : ""}`,
      );
  for (const s of added)
    diff.push(
      `+ ${s.id} · ${s.kind === "repository" ? `Repository ${s.owner}/${s.name}` : s.kind === "project" ? `GitHub Project ${s.projectNodeId} · filter private` : "Search (query private)"} · added inactive`,
    );
  const readinessChanged =
    edit.readiness !== undefined &&
    JSON.stringify(edit.readiness) !== JSON.stringify(source.readiness);
  if (readinessChanged)
    diff.push(
      `Readiness: ${edit.readiness?.mode} of ${conditions(edit.readiness?.conditions.length ?? 0)}${source.readiness ? "" : " (replaces unavailable readiness)"}`,
    );
  for (const id of unlink) diff.push(`− Repository access: ${id}`);
  for (const l of links)
    diff.push(`+ Repository access: ${l.repositoryId} · ${l.ref}`);
  for (const r of source.repositories) {
    const ref = refs[String(r.repositoryId)];
    if (ref !== undefined && ref !== r.ref)
      diff.push(`Ref for ${r.repositoryId}: ${r.ref} → ${ref}`);
  }
  if (edit.credentialRef !== undefined)
    diff.push(
      edit.credentialRef === null
        ? "Credential reference: cleared"
        : `Credential reference: set new ${edit.credentialRef.startsWith("gh:") ? "GitHub CLI" : "environment variable"} reference`,
    );

  const ids = (list: { id: string }[]) =>
    list.map((s) => s.id).join(",") || "none";
  const kept = saved.filter((s) => !remove.includes(s.id));
  const changes: Change[] = [];
  if (remove.length || added.length)
    changes.push({
      field: "selections",
      from: ids(saved),
      to: ids([...kept, ...added]),
    });
  if (readinessChanged)
    changes.push({
      field: "readiness",
      from: source.readiness ? readinessText(source.readiness) : null,
      to: readinessText(readiness),
    });
  if (unlink.length || links.length)
    changes.push({
      field: "repositories",
      from: linked.join(",") || "none",
      to: repositories.map((r) => r.repositoryId).join(",") || "none",
    });
  for (const r of source.repositories) {
    const ref = refs[String(r.repositoryId)];
    if (ref !== undefined && ref !== r.ref)
      changes.push({ field: `ref ${r.repositoryId}`, from: r.ref, to: ref });
  }
  if (edit.credentialRef !== undefined)
    changes.push({
      field: "credentialRef",
      from: source.credentialConfigured ? "configured" : "none",
      to: edit.credentialRef === null ? "none" : "set (reference not shown)",
    });
  const notes = [
    "Saving makes every selection inactive until it is previewed again at the new version with 'ensemble project preview-source'; new selections are added inactive.",
    "Saving marks this project's source observations incomplete until the next sync refresh, and imported blockers become unknown.",
    ...(remove.length
      ? [
          "Removing a selection discards its saved definition (query, filter or repository); the CLI cannot restore it, and re-adding needs the original text.",
        ]
      : []),
    ...(unlink.length
      ? [
          "Unlinking discards the saved local path; linking again needs the path.",
        ]
      : []),
  ];
  return { command, changes, diff, notes };
}

/** A project's live source state after a write, for the receipt's caller. */
async function liveSource(session: Session, projectId: string) {
  const [read, observations] = await Promise.all([
    readProject(session.client, projectId),
    readObservations(session.client, projectId),
  ]);
  return {
    source: read.data.source,
    placements: read.data.placements,
    observations,
  };
}

const requiredVersion = (ctx: WriteContext) => {
  const v = positiveIntFlag(ctx.values["expected-version"], "expected-version");
  if (v === undefined)
    throw new CliError("usage", "--expected-version N is required.");
  return v;
};

export const sourceBrowseCommands: [string, BrowseCommand][] = [
  ["project sources", sourcesCommand],
];

export const sourceWriteCommands = new Map<string, WriteCommand>([
  [
    "project prepare-source",
    {
      usage:
        "project prepare-source PROJECT_ID --out FILE --edit-file FILE [--expected-version N]",
      positionals: 1,
      flags: ["out", "edit-file", "expected-version"],
      async run(ctx) {
        const id = uuidArg(ctx.positionals[2] ?? "", "PROJECT_ID");
        requireOut(ctx);
        const expected = positiveIntFlag(
          ctx.values["expected-version"],
          "expected-version",
        );
        const edit = await readEdit(ctx.values["edit-file"]);
        const session = await ctx.connect(["cli.identity", "workspace.read"]);
        const read = await readProject(session.client, id);
        checkExpected(read.data.source.version, expected);
        const prepared = sourceEditCommand(id, read.data.source, edit);
        return writePrepared(ctx, session, {
          kind: "github.configure",
          ...prepared,
          gaps: [],
        });
      },
    },
  ],
  [
    "project preview-source",
    {
      usage:
        "project preview-source PROJECT_ID --selection ID --expected-version N [--request-id UUID]",
      positionals: 1,
      flags: ["selection", "expected-version", "request-id"],
      async run(ctx) {
        const projectId = uuidArg(ctx.positionals[2] ?? "", "PROJECT_ID");
        const selectionId = ctx.values.selection?.trim();
        if (!selectionId)
          throw new CliError("usage", "--selection ID is required.");
        const expected = requiredVersion(ctx);
        const session = await ctx.connect([
          "cli.identity",
          "workspace.read",
          "source.write",
        ]);
        requireWriteScope(session);
        const identity = {
          scope: `project:${projectId}`,
          type: "github.preview",
        };
        const {
          key,
          digest,
          reached: reused,
        } = await requestKey(ctx, session, identity, [selectionId, expected]);
        // Advisory gates; an earlier attempt with this key replays whatever it recorded.
        if (!reused) {
          const { source } = (await readProject(session.client, projectId))
            .data;
          checkExpected(source.version, expected);
          if (!source.selections.some((s) => s.id === selectionId))
            throw new CliError(
              "invalid-input",
              `--selection ${selectionId} is not a saved selection of this project.`,
            );
          if (
            !source.credentialConfigured ||
            source.credential?.usable === false
          ) {
            const reason = source.credential?.reason ?? "missing-credential";
            throw new CliError("conflict", sourceCredentialExplanation(reason));
          }
        }
        const { receipt, request } = await sendCommand(ctx, session, {
          ...identity,
          key,
          digest,
          resource: projectId,
          command: {
            type: "github.preview",
            key,
            projectId,
            selectionId,
            expectedVersion: expected,
          },
        }).catch((error: unknown) => {
          if (
            error instanceof CliError &&
            error.code === "conflict" &&
            error.extra.credentialReason &&
            sourceCredentialReasons.includes(error.extra.credentialReason)
          )
            throw new CliError(
              "conflict",
              sourceCredentialExplanation(error.extra.credentialReason),
              error.extra,
            );
          if (error instanceof CliError && error.code === "conflict")
            throw new CliError(
              "conflict",
              "Not activated: the source version changed, the selection is unknown, or the provider read was incomplete. Nothing is active from this request.",
              error.extra,
            );
          throw error;
        });
        const live = await liveSource(session, projectId);
        const selection = live.source.selections.find(
          (s) => s.id === selectionId,
        );
        const observation = live.observations.find(
          (o) => o.selectionId === selectionId,
        );
        const result = (
          receipt as Extract<CommandReceipt, { kind: "configuration" }>
        ).result as { configVersion: number };
        const active = selection?.active === true;
        return {
          request,
          data: {
            receipt,
            current: {
              version: live.source.version,
              active,
              observation: observation ?? null,
            },
          },
          human: [
            `Recorded preview of ${selectionId} in project ${projectId} (request ${key}).`,
            keyValues(receiptLines(receipt)),
            `Now: source version ${live.source.version}; ${selectionId} is ${active ? "active" : "NOT active"}; observation ${observation?.state ?? "unavailable"}.`,
            ...(active
              ? []
              : [
                  `The receipt activated version ${result.configVersion}; the configuration has changed since. Preview again with --expected-version ${live.source.version}.`,
                ]),
            "Activation reads the selection once; it imports no tasks and does not prove a sync. The next sync refresh imports matching issues.",
            "There is no deactivate command: saving any source change deactivates every selection.",
          ].join("\n"),
        };
      },
    },
  ],
  [
    "project place-task",
    {
      usage:
        "project place-task TASK_ID --to PROJECT_ID --expected-version N [--request-id UUID]",
      positionals: 1,
      flags: ["to", "expected-version", "request-id"],
      async run(ctx) {
        const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
        const to = uuidArg(ctx.values.to ?? "", "--to");
        const expected = requiredVersion(ctx);
        const session = await ctx.connect([
          "cli.identity",
          "workspace.read",
          "task.read",
          "source.write",
        ]);
        requireWriteScope(session);
        const task = async () =>
          (
            await session.client.get(
              `${API}/tasks/${encodeURIComponent(taskId)}`,
              taskSchema,
            )
          ).data.task;
        const before = await task();
        // The task's project changes when this applies, so the request is scoped to the task.
        const identity = { scope: `task:${taskId}`, type: "github.place" };
        const {
          key,
          digest,
          reached: reused,
        } = await requestKey(ctx, session, identity, [taskId, to, expected]);
        if (!reused) {
          const placement = (
            await readProject(session.client, before.projectId)
          ).data.placements.find((p) => p.taskId === taskId);
          if (!placement)
            throw new CliError(
              "conflict",
              "The task has no placement conflict to resolve. Nothing was sent.",
            );
          checkExpected(placement.version, expected);
          if (!placement.choices.some((c) => c.id === to))
            throw new CliError(
              "conflict",
              `--to ${to} is not one of the task's matching projects (${placement.choices.map((c) => c.id).join(", ")}). Nothing was sent.`,
            );
        }
        const sent = await sendCommand(ctx, session, {
          ...identity,
          key,
          digest,
          resource: taskId,
          command: {
            type: "github.place",
            key,
            projectId: before.projectId,
            taskId,
            chosenProjectId: to,
            expectedVersion: expected,
          },
        }).catch(async (error: unknown) => {
          if (!(error instanceof CliError) || error.code !== "conflict")
            throw error;
          // An earlier attempt with this key moved the task, so its receipt is under the old project.
          if (reused && before.projectId === to) return undefined;
          throw new CliError(
            "conflict",
            "Not placed: the task changed, already has an assignment, or the chosen project no longer matches it. The task is unchanged.",
            error.extra,
          );
        });
        const after = await task();
        const request = sent?.request ?? {
          service: session.identity.service.installationId,
          ...identity,
          key,
        };
        return {
          request,
          data: {
            receipt: sent?.receipt ?? null,
            current: { projectId: after.projectId, version: after.version },
          },
          human: [
            sent
              ? `Placed task ${taskId} in project ${to} (request ${key}).`
              : `An earlier attempt with request ${key} already placed task ${taskId} in project ${to}; nothing more was changed. Its receipt is not readable for placements.`,
            ...(sent ? [keyValues(receiptLines(sent.receipt))] : []),
            `Now: project ${after.projectId}, version ${after.version}.`,
            "Placement neither starts work nor grants repository access. It can be changed again until the task has an assignment, then it is final.",
          ].join("\n"),
        };
      },
    },
  ],
]);
