import { sourceCredentialReference } from "../core/credential-reference.js";
import { mergeMethods, validBranchPrefix } from "../core/delivery.js";
import {
  applyRepositoryLevel,
  deliveryModeFor,
  repositoryDeliveryLevel,
  type RepositoryDeliveryLevel,
} from "../core/delivery-levels.js";
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
import type { WriteCommand } from "./write.js";

const levels = ["open-prs", "merge-with-approval", "merge-when-ready"] as const;
const methods = [...mergeMethods, "none"] as const;
type Level = (typeof levels)[number];
type Method = (typeof methods)[number];

const choice = <T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined => {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value))
    throw new CliError(
      "invalid-input",
      `--${flag} must be ${allowed.join(", ")}.`,
    );
  return value as T;
};

/** A saved row the read withheld stays as it is: the service keeps it by its opaque reference. */
const keep = <T extends object>(row: T) =>
  "savedRow" in row
    ? { savedRow: (row as { savedRow: unknown }).savedRow, keep: true as const }
    : row;
const checkName = (row: object) => ("name" in row ? String(row.name) : null);

export const deliveryConfigureCommands = new Map<string, WriteCommand>([
  [
    "delivery configure",
    {
      usage:
        "delivery configure PROJECT_ID [--out FILE] [--expected-version N] [--repository REPO_ID]... [--level open-prs|merge-with-approval|merge-when-ready] [--merge-method merge|squash|rebase|none] [--required-check NAME]... [--required-checks none] [--credential-ref env:NAME|gh:github.com|none] [--branch-prefix PREFIX | --branch-prefix-default]",
      positionals: 1,
      expects:
        "--expected-version: the delivery policy's version (delivery.version in 'cab project get PROJECT_ID --output json'); omitted, the version this command reads. --level, --merge-method and the required checks apply to each --repository, and replace what it had.",
      flags: [
        "out",
        "expected-version",
        "repository",
        "level",
        "merge-method",
        "required-check",
        "required-checks",
        "credential-ref",
        "branch-prefix",
        "branch-prefix-default",
      ],
      async run(ctx) {
        const id = uuidArg(ctx.positionals[2] ?? "", "PROJECT_ID");
        checkOut(ctx);
        const expected = positiveIntFlag(
          ctx.values["expected-version"],
          "expected-version",
        );
        const repositories = ctx.values.repository ?? [];
        const level = choice<Level>(ctx.values.level, levels, "level");
        const method = choice<Method>(
          ctx.values["merge-method"],
          methods,
          "merge-method",
        );
        const named = ctx.values["required-check"];
        if (ctx.values["required-checks"] !== undefined) {
          if (ctx.values["required-checks"] !== "none")
            throw new CliError(
              "invalid-input",
              "--required-checks must be none.",
            );
          if (named !== undefined)
            throw new CliError(
              "usage",
              "Use either --required-check NAME or --required-checks none, not both.",
            );
        }
        const checks =
          named ?? (ctx.values["required-checks"] === "none" ? [] : undefined);
        for (const name of checks ?? [])
          if (!name.trim() || name.length > 512)
            throw new CliError(
              "invalid-input",
              "--required-check must be a name of 1 to 512 characters.",
            );
        const perRepository =
          level !== undefined || method !== undefined || checks !== undefined;
        if (perRepository && repositories.length === 0)
          throw new CliError(
            "usage",
            "--level, --merge-method and the required-check flags apply to a repository; name one or more with --repository REPO_ID.",
          );
        if (!perRepository && repositories.length > 0)
          throw new CliError(
            "usage",
            "--repository needs --level, --merge-method or a required-check flag.",
          );
        if (new Set(repositories).size !== repositories.length)
          throw new CliError(
            "invalid-input",
            "--repository is repeated; name each repository once.",
          );
        const ref = ctx.values["credential-ref"];
        if (
          ref !== undefined &&
          ref !== "none" &&
          !sourceCredentialReference.safeParse(ref).success
        )
          throw new CliError(
            "invalid-input",
            "--credential-ref must be env:NAME, gh:github.com or none.",
          );
        const prefix = ctx.values["branch-prefix"];
        if (prefix !== undefined && ctx.values["branch-prefix-default"])
          throw new CliError(
            "usage",
            "Use either --branch-prefix or --branch-prefix-default, not both.",
          );
        if (prefix !== undefined && !validBranchPrefix(prefix))
          throw new CliError("invalid-input", "--branch-prefix is not valid.");

        const session = await ctx.connect(["cli.identity", "workspace.read"]);
        const { delivery } = (await readProject(session.client, id)).data;
        if (!delivery?.repositories)
          throw new CliError(
            "unsupported-service",
            "This service does not report delivery configuration.",
          );
        checkExpected(delivery.version, expected);
        const settings = delivery.repositories;
        for (const repositoryId of repositories)
          if (!settings.some((r) => r.repositoryId === repositoryId))
            throw new CliError(
              "invalid-input",
              `--repository ${repositoryId} is not a linked repository of this project.`,
              { fix: `Read them with 'cab project get ${id}'.` },
            );

        const changes: Change[] = [];
        const notes: string[] = [];
        let mode = delivery.mode;
        let grants = delivery.grants;
        if (level !== undefined) {
          const visible = grants.flatMap((g) => ("action" in g ? [g] : []));
          if (visible.length !== grants.length)
            throw new CliError(
              "invalid-input",
              "A saved grant is withheld from this read, so a level cannot be applied safely. Nothing was prepared.",
              { fix: "Review the saved grants in the web UI." },
            );
          let next = visible;
          for (const repositoryId of repositories) {
            const from: RepositoryDeliveryLevel = repositoryDeliveryLevel(
              next,
              repositoryId,
            );
            if (from === level) continue;
            changes.push({
              field: `level ${repositoryId}`,
              from,
              to: level,
            });
            next = applyRepositoryLevel(next, repositoryId, level);
          }
          grants = next;
          mode = deliveryModeFor(next);
          if (mode !== delivery.mode)
            changes.push({ field: "mode", from: delivery.mode, to: mode });
          if (level === "merge-when-ready")
            notes.push(
              "Merge when ready lets the lead merge without asking once the merge gate reports no blockers; cab cannot unmerge.",
            );
        }

        const rows = settings.map((row) => {
          if (!repositories.includes(row.repositoryId)) return row;
          let { mergeMethod, additionalChecks } = row;
          if (method !== undefined) {
            const next = method === "none" ? null : method;
            if (next !== mergeMethod)
              changes.push({
                field: `mergeMethod ${row.repositoryId}`,
                from: mergeMethod ?? "none",
                to: method,
              });
            mergeMethod = next;
          }
          if (checks !== undefined) {
            const before = additionalChecks.map(checkName).filter(Boolean);
            // A name already required keeps its row, App ID included.
            additionalChecks = checks.map(
              (name) =>
                additionalChecks.find((c) => checkName(c) === name) ?? {
                  name,
                },
            );
            if (before.join("\n") !== checks.join("\n"))
              changes.push({
                field: `requiredChecks ${row.repositoryId}`,
                from: before.join(",") || "none",
                to: checks.join(",") || "none",
              });
          }
          return { ...row, mergeMethod, additionalChecks };
        });

        const command: Record<string, unknown> = {
          type: "delivery.configure",
          projectId: id,
          expectedVersion: delivery.version,
          mode,
          grants: grants.map(keep),
          // The first save with per-repository settings moves the project-wide list into them.
          requiredChecks: rows.length ? [] : delivery.requiredChecks.map(keep),
          ...(rows.length
            ? {
                repositories: rows.map((r) => ({
                  repositoryId: r.repositoryId,
                  ...(r.mergeMethod ? { mergeMethod: r.mergeMethod } : {}),
                  requiredChecks: r.additionalChecks.map(keep),
                })),
              }
            : {}),
        };
        if (ref !== undefined) {
          const from = delivery.credentialConfigured
            ? delivery.credential?.source === "gh"
              ? "gh:github.com"
              : "configured"
            : "none";
          command.credentialRef = ref === "none" ? null : ref;
          if (from !== ref)
            changes.push({ field: "credentialRef", from, to: ref });
          if (ref === "gh:github.com")
            notes.push(
              "Agents running as the same OS user can reach this host's GitHub CLI login.",
            );
        }
        if (prefix !== undefined) command.branchPrefix = prefix;
        else if (!ctx.values["branch-prefix-default"]) {
          if (delivery.branchPrefix === null)
            command.preserveBranchPrefix = true;
          else if (delivery.branchPrefix !== undefined)
            command.branchPrefix = delivery.branchPrefix;
        }
        const wanted = prefix ?? undefined;
        if (
          (prefix !== undefined && prefix !== delivery.branchPrefix) ||
          (ctx.values["branch-prefix-default"] &&
            delivery.branchPrefix !== undefined)
        )
          changes.push({
            field: "branchPrefix",
            from:
              delivery.branchPrefix === undefined
                ? "none"
                : (delivery.branchPrefix ?? "(withheld)"),
            to: wanted ?? "none",
          });
        return writePrepared(ctx, session, {
          kind: "delivery.configure",
          command,
          changes,
          diff: [],
          notes,
          gaps: [],
        });
      },
    },
  ],
]);
