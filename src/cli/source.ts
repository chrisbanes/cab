import {
  ruleText,
  selectionCountsText,
  zeroMatchWarning,
} from "../operator/readiness-text.js";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { sourceCredentialReference } from "../core/credential-reference.js";
import {
  closedIssuesSchema,
  type Readiness,
  readinessSchema,
  selectionSchema,
} from "../core/github-source-contracts.js";
import {
  type CommandReceipt,
  readinessCommandValue,
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
  checkOut,
  writePrepared,
} from "./configure.js";
import { openFailure } from "./change-document.js";
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
const ruleSummary = (r: Readiness | null) =>
  r ? `${r.mode} of ${conditions(r.conditions.length)}` : "No readiness rule";
const readinessText = (r: Source["readiness"]) =>
  r.kind === "unavailable"
    ? "(unavailable)"
    : r.kind === "rule"
      ? `${ruleSummary(r)}: ${ruleText(r)}`
      : ruleSummary(null);
const sourceCredentialReasons: SourceCredentialReason[] = [
  "missing-credential",
  "invalid-credential-reference",
  "gh-not-installed",
  "gh-not-signed-in",
  "gh-unreadable",
];

const readObservedProject = (client: ServiceClient, projectId: string) =>
  client
    .get(`${API}/source-observations`, sourceObservationSchema)
    .then((r) => r.data.projects.find((p) => p.projectId === projectId));
const readObservations = (client: ServiceClient, projectId: string) =>
  readObservedProject(client, projectId).then((p) => p?.selections ?? []);

const requireWriteScope = (session: Session) => {
  if (session.identity.credential.scope !== "read-write")
    throw new CliError(
      "insufficient-scope",
      "This connection's credential is read-only.",
    );
};

/** Saved rows this read cannot name; a CLI edit could not keep them. */
const unnamed = (source: Source) =>
  source.selections.some((s) => s.id === null);

const sourcesCommand: BrowseCommand = {
  usage: "project sources PROJECT_ID",
  positionals: 1,
  capabilities: ["cli.identity", "workspace.read"],
  async run(ctx) {
    const id = uuidArg(ctx.positionals[2] ?? "", "PROJECT_ID");
    const client = await ctx.connect();
    const read = await readProject(client, id);
    const project = await readObservedProject(client, id);
    const observations = project?.selections ?? [];
    const rule = project?.readiness ?? { kind: "unavailable" as const };
    const { source, placements } = read.data;
    const observed = (selectionId: string | null) =>
      observations.find((o) => o.selectionId === selectionId);
    const gaps: CoverageGap[] = [];
    if (
      unnamed(source) ||
      source.readiness.kind === "unavailable" ||
      source.selections.some((s) => s.kind !== "search" && !s.descriptor)
    )
      gaps.push("content-unavailable");
    if (observations.some((o) => o.state === "partial"))
      gaps.push("evidence-gap");
    if (observations.some((o) => o.state === "unavailable"))
      gaps.push("redaction-unavailable");
    return browseOutput(ctx, {
      data: {
        projectId: id,
        source,
        placements,
        observations,
        readinessRule: rule,
      },
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
          ["Closed issues", closedIssueLabels[source.closedIssues]],
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
                "Items",
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
                  o?.counts ? selectionCountsText(o.counts, rule) : "-",
                ];
              }),
            )
          : "No selections.",
        ...observations.flatMap((o) => {
          const warning = zeroMatchWarning(o.counts, rule);
          return warning
            ? [
                `${unavailable(o.selectionId)}: ${warning} Change readiness with 'cab project prepare-source'.`,
              ]
            : [];
        }),
        // Each option's node IDs are what a project-field readiness condition names.
        ...(observations.some((o) => o.projectFields?.fields.length)
          ? [
              "",
              table(
                ["Selection", "Field", "Option", "Open", "Condition IDs"],
                observations.flatMap((o) =>
                  (o.projectFields?.fields ?? []).flatMap((f) =>
                    f.options.map((option) => [
                      unavailable(o.selectionId),
                      f.name,
                      option.name,
                      String(option.open),
                      `${o.projectFields?.projectNodeId} ${f.fieldNodeId} ${option.optionNodeId}`,
                    ]),
                  ),
                ),
              ),
            ]
          : []),
        ...(placements.length
          ? [
              "",
              "Placement conflicts (choose with 'cab project place-task'):",
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

const closedIssueLabels = {
  skip: "Skip closed issues",
  done: "Treat closure as Done",
} as const;

const editSchema = z
  .object({
    addSelections: z
      .array(z.record(z.string(), z.unknown()))
      .max(30)
      .optional(),
    removeSelections: z.array(z.string().min(1).max(512)).max(30).optional(),
    /** A rule replaces, `null` removes the rule, omitted keeps the saved one. */
    readiness: readinessSchema.nullable().optional(),
    closedIssues: closedIssuesSchema.optional(),
    credentialRef: sourceCredentialReference.nullable().optional(),
  })
  .strict();
export type SourceEdit = z.infer<typeof editSchema>;

/** Reads the edit file: owner's regular file, no symlink, at most 64 KiB of strict JSON. */
export async function readEditFile<T>(
  path: string | undefined,
  schema: z.ZodType<T>,
  what: string,
  rejectKeys: { keys: string[]; why: string; fix: string } | null = null,
): Promise<T> {
  if (!path) throw new CliError("usage", "--edit-file FILE is required.");
  const invalid = (why: string, fix?: string) =>
    new CliError("invalid-input", `--edit-file ${why}.`, {
      ...(fix ? { fix } : {}),
    });
  let text: string;
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_EDIT_BYTES)
        throw invalid(
          "must be a regular file of at most 64 KiB",
          "Pass a regular file of at most 64 KiB.",
        );
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    const { why, fix } = openFailure(
      error,
      path,
      "Check the path given to --edit-file.",
    );
    throw new CliError(
      "invalid-input",
      `Cannot read --edit-file ${JSON.stringify(path)}: ${why}.`,
      { fix },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid("is not JSON", "Write the edit as one JSON object.");
  }
  if (
    rejectKeys &&
    typeof value === "object" &&
    value !== null &&
    rejectKeys.keys.some((key) => key in value)
  )
    throw invalid(rejectKeys.why, rejectKeys.fix);
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw invalid(
      `is not a valid ${what} edit: ${[...new Set(parsed.error.issues.map((i) => i.path.join(".") || i.message))].join(", ")}`,
    );
  return parsed.data;
}

/** The source edit keys that moved to the project's repository links. */
const repositoryEditKeys = [
  "linkRepositories",
  "unlinkRepositories",
  "setRefs",
  "confirmUnlinkAll",
];
const readEdit = (path: string | undefined) =>
  readEditFile(path, editSchema, "source", {
    keys: repositoryEditKeys,
    why: "carries repository link keys; repository links are project configuration, so edit them with 'cab project prepare-repositories PROJECT_ID --edit-file FILE'",
    fix: "Edit repository links with 'cab project prepare-repositories PROJECT_ID --edit-file FILE'.",
  });

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
      "A saved selection cannot be named in this read, so the CLI cannot keep it. Nothing was prepared.",
      {
        fix: `Review the saved source with 'cab project sources ${projectId}'.`,
      },
    );
  const unavailableRule = source.readiness.kind === "unavailable";
  if (unavailableRule && edit.readiness === undefined)
    throw new CliError(
      "conflict",
      'The saved readiness cannot be read; replace it with "readiness" in the edit file. Nothing was prepared.',
      {
        fix: `Add a "readiness" rule to the edit file, then run 'cab project prepare-source ${projectId}' again.`,
      },
    );
  const saved = source.selections.map((s) => ({ ...s, id: String(s.id) }));
  const remove = edit.removeSelections ?? [];
  if (duplicates(remove).length)
    throw bad(
      `removeSelections lists ${duplicates(remove).join(", ")} more than once.`,
    );
  for (const id of remove)
    if (!saved.some((s) => s.id === id))
      throw bad(`removeSelections: ${id} is not a saved selection.`);

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
  const savedRule = readinessCommandValue(source.readiness);
  const readiness = edit.readiness !== undefined ? edit.readiness : savedRule;
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
    closedIssues: edit.closedIssues ?? source.closedIssues,
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
    (unavailableRule ||
      JSON.stringify(edit.readiness) !== JSON.stringify(savedRule));
  if (readinessChanged)
    diff.push(
      `Readiness: ${edit.readiness ? ruleSummary(edit.readiness) : "no readiness rule"}${unavailableRule ? " (replaces unavailable readiness)" : ""}`,
    );
  const closedIssuesChanged =
    edit.closedIssues !== undefined &&
    edit.closedIssues !== source.closedIssues;
  if (closedIssuesChanged)
    diff.push(
      `Closed issues: ${closedIssueLabels[edit.closedIssues ?? "skip"]}`,
    );
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
      from: unavailableRule ? null : readinessText(source.readiness),
      to: ruleSummary(readiness),
    });
  if (closedIssuesChanged)
    changes.push({
      field: "closedIssues",
      from: source.closedIssues,
      to: edit.closedIssues ?? source.closedIssues,
    });
  if (edit.credentialRef !== undefined)
    changes.push({
      field: "credentialRef",
      from: source.credentialConfigured ? "configured" : "none",
      to: edit.credentialRef === null ? "none" : "set (reference not shown)",
    });
  const notes = [
    "Saving makes every selection inactive until it is previewed again at the new version with 'cab project preview-source'; new selections are added inactive.",
    "Saving marks this project's source observations incomplete until the next sync refresh, and imported blockers become unknown.",
    ...(remove.length
      ? [
          "Removing a selection discards its saved definition (query, filter or repository); the CLI cannot restore it, and re-adding needs the original text.",
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
        "project prepare-source PROJECT_ID [--out FILE] --edit-file FILE [--expected-version N]",
      positionals: 1,
      expects:
        "--expected-version: the source configuration's version ('Source version' in 'cab project sources PROJECT_ID'); omitted, the version this command reads.",
      flags: ["out", "edit-file", "expected-version"],
      async run(ctx) {
        const id = uuidArg(ctx.positionals[2] ?? "", "PROJECT_ID");
        checkOut(ctx);
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
      expects:
        "--expected-version: the source configuration's version ('Source version' in 'cab project sources PROJECT_ID'); required.",
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
          checkExpected(source.version, expected, "run this command again");
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
            throw new CliError(
              "conflict",
              sourceCredentialExplanation(reason),
              {
                fix: `Fix the credential as described above, then run 'cab project preview-source ${projectId}' again.`,
              },
            );
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
              {
                ...error.extra,
                fix: `Fix the credential as described above, then run 'cab project preview-source ${projectId}' again.`,
              },
            );
          if (error instanceof CliError && error.code === "conflict")
            throw new CliError(
              "conflict",
              "Not activated: the source version changed, the selection is unknown, or the provider read was incomplete. Nothing is active from this request.",
              {
                ...error.extra,
                fix: `Run 'cab project sources ${projectId}', then preview again with --expected-version set to its version.`,
              },
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
        ).result as { configVersion: number; alreadyActive?: boolean };
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
            // An absent flag is a receipt recorded before the prior state was reported.
            ...(result.alreadyActive === undefined
              ? []
              : [
                  result.alreadyActive
                    ? `${selectionId} was already active at source version ${result.configVersion}.`
                    : `Activated ${selectionId} at source version ${result.configVersion}.`,
                ]),
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
      expects:
        "--expected-version: the placement conflict's version (the Version column of 'cab project sources PROJECT_ID' for the task's current project); required.",
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
              {
                fix: `Run 'cab task get ${taskId}' to see where the task is placed.`,
              },
            );
          checkExpected(placement.version, expected, "run this command again");
          if (!placement.choices.some((c) => c.id === to))
            throw new CliError(
              "conflict",
              `--to ${to} is not one of the task's matching projects (${placement.choices.map((c) => c.id).join(", ")}). Nothing was sent.`,
              { fix: "Choose --to from the matching projects listed above." },
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
            {
              ...error.extra,
              fix: `Run 'cab task get ${taskId}', then place it again with the version shown by 'cab project sources ${before.projectId}'.`,
            },
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
