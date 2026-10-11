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

/** Collapsed summary of Optional settings: supplied values, or the errors, which win. */
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
  const first = [
    input.context.trim() && `Context: ${excerpt(input.context.trim())}`,
    links.length &&
      `Reference: ${excerpt(links[0] ?? "")}${links.length > 1 ? ` +${links.length - 1}` : ""}`,
  ].filter(Boolean);
  const second = [
    input.profileId &&
      `Assignee: ${profile ? `${profile.name ?? "Name unavailable"} (permitted)` : "unavailable"}`,
    titles.length && `Depends on: ${titles.map(excerpt).join(", ")}`,
  ].filter(Boolean);
  const supplied = [
    input.context.trim(),
    links.length,
    input.profileId,
    input.blockerTaskIds.length,
  ].filter(Boolean).length;
  return {
    summary: failed.length
      ? `Optional settings · ${failed.length} ${failed.length === 1 ? "error" : "errors"}`
      : `Optional settings · ${supplied ? `${supplied} supplied` : "none supplied"}`,
    lines: [first.join(" · "), second.join(" · ")].filter(Boolean),
    fix:
      failed.length === 1
        ? `Open settings to fix the ${optionalFields[failed[0]!]}.`
        : failed.length
          ? `Open settings to fix ${failed.length} fields.`
          : null,
  };
}
