import { z } from "zod";
import {
  describeLinkBase,
  linkBaseChangeNote,
  repositoryBaseModeSchema,
  repositoryLinkSchema,
} from "../core/github-source-contracts.js";
import {
  gitLabHostSchema,
  gitLabProjectPathSchema,
  gitLabRepositoryId,
  linkBaseFields,
  linkBaseIssue,
} from "../core/repository-links.js";
import { uuidArg } from "./browse.js";
import {
  type Change,
  checkExpected,
  checkOut,
  positiveIntFlag,
  writePrepared,
} from "./configure.js";
import { readProject } from "./configure-project.js";
import { CliError } from "./connections.js";
import { readEditFile } from "./source.js";
import type { WriteCommand } from "./write.js";

/** A new link: GitHub unless it names `codeHost: "gitlab"` with its host and project path. */
const linkRowSchema = z.union([
  repositoryLinkSchema
    .extend({
      codeHost: z.literal("github").optional(),
      host: z.literal("github.com").optional(),
    })
    .strict(),
  repositoryLinkSchema
    .extend({
      codeHost: z.literal("gitlab"),
      host: gitLabHostSchema,
      projectPath: gitLabProjectPathSchema,
      repositoryId: gitLabRepositoryId,
    })
    .strict(),
]);

const editSchema = z
  .object({
    linkRepositories: z.array(linkRowSchema).max(20).optional(),
    unlinkRepositories: z.array(z.string().min(1).max(512)).max(20).optional(),
    setRefs: z.record(z.string(), z.string().trim().min(1).max(512)).optional(),
    /** A kept link's base mode, its branch (`ref`) and fetch policy; omitted fields keep the saved ones. */
    setBases: z
      .record(
        z.string(),
        z
          .object({
            baseMode: repositoryBaseModeSchema,
            ref: z.string().trim().min(1).max(512).optional(),
            fetchBeforeProvisioning: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    confirmUnlinkAll: z.literal(true).optional(),
  })
  .strict();
type RepositoryEdit = z.infer<typeof editSchema>;
type Links = Awaited<ReturnType<typeof readProject>>["data"]["repositories"];

const duplicates = (values: string[]) =>
  values.filter((v, i) => values.indexOf(v) !== i);

/** The exact `repositories.configure` the edit makes of the saved links, with its preview. */
function repositoriesEditCommand(
  projectId: string,
  saved: Links,
  edit: RepositoryEdit,
) {
  const bad = (why: string) => new CliError("invalid-input", why);
  if (saved.links.some((r) => r.repositoryId === null || r.ref === null))
    throw new CliError(
      "conflict",
      "A saved repository link cannot be named in this read, so the CLI cannot keep it. Nothing was prepared.",
      { fix: `Review the saved links with 'cab project get ${projectId}'.` },
    );
  const unlink = edit.unlinkRepositories ?? [];
  const links = edit.linkRepositories ?? [];
  const refs = edit.setRefs ?? {};
  const bases = edit.setBases ?? {};
  const linked = saved.links.map((r) => String(r.repositoryId));
  for (const [what, list] of [
    ["unlinkRepositories", unlink],
    ["linkRepositories", links.map((l) => l.repositoryId)],
  ] as const)
    if (duplicates(list).length)
      throw bad(`${what} lists ${duplicates(list).join(", ")} more than once.`);
  for (const id of unlink)
    if (!linked.includes(id))
      throw bad(`unlinkRepositories: ${id} is not linked.`);
  for (const { repositoryId } of links)
    if (linked.includes(repositoryId))
      throw bad(
        `linkRepositories: ${repositoryId} is already linked; use setRefs to change its ref.`,
      );
  for (const [what, ids] of [
    ["setRefs", Object.keys(refs)],
    ["setBases", Object.keys(bases)],
  ] as const)
    for (const id of ids)
      if (!linked.includes(id) || unlink.includes(id))
        throw bad(`${what}: ${id} is not a kept linked repository.`);
  for (const [id, base] of Object.entries(bases))
    if (base.ref !== undefined && refs[id] !== undefined)
      throw bad(`setBases: ${id} names its ref there and in setRefs.`);
  // Each kept link's new base, checked by the rule the service applies.
  const based = new Map(
    saved.links.map((r) => {
      const id = String(r.repositoryId);
      const base = bases[id];
      const next = {
        ref: base?.ref ?? refs[id] ?? String(r.ref),
        baseMode: base?.baseMode ?? r.baseMode,
        fetchBeforeProvisioning:
          base?.fetchBeforeProvisioning ?? r.fetchBeforeProvisioning,
      };
      const issue = base ? linkBaseIssue(next) : null;
      if (issue) throw bad(`setBases: ${id}: ${issue}.`);
      return [id, next] as const;
    }),
  );
  for (const l of links) {
    const issue = linkBaseIssue(l);
    if (issue) throw bad(`linkRepositories: ${l.repositoryId}: ${issue}.`);
  }

  // A kept link is sent with its saved code host but without its private path.
  const repositories = [
    ...saved.links
      .filter((r) => !unlink.includes(String(r.repositoryId)))
      .map((r) => {
        const id = String(r.repositoryId);
        // Only a changed base is sent; the service keeps omitted base fields.
        const base = bases[id] ? linkBaseFields(based.get(id)!) : {};
        return {
          codeHost: r.codeHost,
          host: r.host,
          repositoryId: id,
          ref: based.get(id)!.ref,
          ...base,
        };
      }),
    ...links.map((l) =>
      l.codeHost === "gitlab"
        ? {
            codeHost: l.codeHost,
            host: l.host,
            projectPath: l.projectPath,
            repositoryId: l.repositoryId,
            path: l.path,
            ref: l.ref,
            ...linkBaseFields(l),
          }
        : {
            codeHost: "github",
            host: "github.com",
            repositoryId: l.repositoryId,
            path: l.path,
            ref: l.ref,
            ...linkBaseFields(l),
          },
    ),
  ];
  if (
    saved.links.length > 0 &&
    repositories.length === 0 &&
    !edit.confirmUnlinkAll
  )
    throw bad(
      'This edit removes every repository link, so no task can be checked out. Add "confirmUnlinkAll": true to confirm.',
    );
  const command: Record<string, unknown> = {
    type: "repositories.configure",
    projectId,
    expectedVersion: saved.version,
    repositories,
  };

  // Preview lines name links by the IDs this command takes, and never carry a path.
  const diff: string[] = [];
  for (const id of unlink) diff.push(`− Repository access: ${id}`);
  for (const l of links)
    diff.push(
      `+ Repository access: ${l.repositoryId} · ${l.baseMode === undefined || (l.baseMode === "ref" && !l.fetchBeforeProvisioning) ? l.ref : describeLinkBase(l)}${
        l.codeHost === "gitlab" ? ` · GitLab ${l.host}` : ""
      }`,
    );
  const changes: Change[] = [];
  if (unlink.length || links.length)
    changes.push({
      field: "repositories",
      from: linked.join(",") || "none",
      to: repositories.map((r) => r.repositoryId).join(",") || "none",
    });
  let baseChanged = false;
  for (const r of saved.links) {
    const id = String(r.repositoryId);
    const ref = refs[id];
    if (ref !== undefined && ref !== r.ref) {
      diff.push(`Ref for ${r.repositoryId}: ${r.ref} → ${ref}`);
      changes.push({ field: `ref ${r.repositoryId}`, from: r.ref, to: ref });
    }
    const from = describeLinkBase({ ...r, ref: String(r.ref) });
    const to = describeLinkBase(based.get(id)!);
    if (bases[id] && from !== to) {
      baseChanged = true;
      diff.push(`Base for ${r.repositoryId}: ${from} → ${to}`);
      changes.push({ field: `base ${r.repositoryId}`, from, to });
    }
  }
  const notes = [
    "Saving verifies every checkout before anything is recorded; a kept link keeps its saved path.",
    ...(unlink.length
      ? [
          "Unlinking discards the saved local path; linking again needs the path.",
        ]
      : []),
    ...(baseChanged ? [linkBaseChangeNote] : []),
  ];
  return { command, changes, diff, notes };
}

export const repositoryWriteCommands = new Map<string, WriteCommand>([
  [
    "project prepare-repositories",
    {
      usage:
        "project prepare-repositories PROJECT_ID [--out FILE] --edit-file FILE [--expected-version N]",
      positionals: 1,
      expects:
        "--expected-version: the repository links' version (repositories.version in 'cab project get PROJECT_ID --output json'); omitted, the version this command reads.",
      flags: ["out", "edit-file", "expected-version"],
      async run(ctx) {
        const id = uuidArg(ctx.positionals[2] ?? "", "PROJECT_ID");
        checkOut(ctx);
        const expected = positiveIntFlag(
          ctx.values["expected-version"],
          "expected-version",
        );
        const edit = await readEditFile(
          ctx.values["edit-file"],
          editSchema,
          "repository",
        );
        const session = await ctx.connect(["cli.identity", "workspace.read"]);
        const read = await readProject(session.client, id);
        checkExpected(read.data.repositories.version, expected);
        return writePrepared(ctx, session, {
          kind: "repositories.configure",
          ...repositoriesEditCommand(id, read.data.repositories, edit),
          gaps: [],
        });
      },
    },
  ],
]);
