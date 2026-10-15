import type { ComposerOptions } from "../../src/operator/contracts.js";
import type { ComposerInput } from "./composer-state.js";

/** The optional composer fields; they share the one Optional settings disclosure. */
export const optionalFields = {
  context: "context",
  links: "link",
  profileId: "assignee",
  blockerTaskIds: "dependency",
} as const;

const excerpt = (text: string) =>
  text.length > 40 ? `${text.slice(0, 40)}…` : text;

/** Collapsed summary of Optional settings: a chip per supplied value; errors win the count. */
export function optionalSummary(
  input: ComposerInput,
  options: ComposerOptions["data"] | undefined,
  unavailable: Record<string, string>,
  errors: Record<string, string>,
) {
  const failed = Object.keys(optionalFields).filter(
    (f) => errors[f] ?? unavailable[f],
  ) as (keyof typeof optionalFields)[];
  const links = input.links.filter((l) => l.trim());
  const profile = options?.profiles.find((p) => p.id === input.profileId);
  const titles = input.blockerTaskIds.map(
    (id) =>
      options?.dependencies.find((d) => d.id === id)?.title ??
      "unavailable task",
  );
  const chips = (
    [
      [
        "context",
        input.context.trim() && `Context · ${excerpt(input.context.trim())}`,
      ],
      [
        "links",
        links.length &&
          `Reference · ${excerpt(links[0] ?? "")}${links.length > 1 ? ` +${links.length - 1}` : ""}`,
      ],
      [
        "profileId",
        input.profileId &&
          `Assignee · ${profile ? `${profile.name ?? "Name unavailable"} (permitted)` : "unavailable"}`,
      ],
      [
        "blockerTaskIds",
        titles.length && `Depends on · ${titles.map(excerpt).join(", ")}`,
      ],
    ] as const
  ).flatMap(([field, text]) =>
    text ? [{ field, text, invalid: failed.includes(field) }] : [],
  );
  return {
    summary: failed.length
      ? `Optional settings · ${failed.length} ${failed.length === 1 ? "error" : "errors"}`
      : `Optional settings · ${chips.length ? `${chips.length} supplied` : "none supplied"}`,
    chips,
    fix:
      failed.length === 1
        ? `Open settings to fix the ${optionalFields[failed[0]!]}.`
        : failed.length
          ? `Open settings to fix ${failed.length} fields.`
          : null,
  };
}
