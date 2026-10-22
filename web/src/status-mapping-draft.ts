import {
  type StatusMapping,
  statusMappingEvents,
} from "../../src/core/status-mapping-contracts.js";
import { statusEventLabels } from "../../src/operator/status-mapping-copy.js";
import type { ProjectConfigurationData, Values } from "./settings-changes.js";

type StatusView = NonNullable<ProjectConfigurationData["statusMapping"]>;
export type Field = {
  fieldNodeId: string;
  name: string;
  options: { optionNodeId: string; name: string }[];
};
/** The Project's single-select `Status` field as GitHub lists it now. */
export type FieldRead =
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "ready"; status: Field | null };

/**
 * The Status field a draft maps: only the one GitHub lists for the chosen Project right now. While
 * it is loading, unreadable or absent it is `undefined` even for the saved Project, so the draft
 * cannot be saved, and an unread field is never mistaken for a clear.
 */
export function statusFieldNodeId(read: FieldRead): string | undefined {
  return read.state === "ready" ? read.status?.fieldNodeId : undefined;
}

/** The draft's mapping, or `null` for none: no event names an option. */
export function draftMapping(
  v: Values,
  selection: StatusView["selections"][number] | undefined,
  fieldNodeId: string | undefined,
): StatusMapping | null {
  if (!selection || !fieldNodeId) return null;
  const events = Object.fromEntries(
    statusMappingEvents.map((e) => [e, String(v[e] ?? "") || null]),
  ) as StatusMapping["events"];
  return Object.values(events).every((o) => o === null)
    ? null
    : {
        selectionId: selection.id,
        projectNodeId: selection.projectNodeId,
        fieldNodeId,
        events,
      };
}

/** One line per event whose mapped option changed, naming the options. */
export function statusMappingChanges(
  saved: StatusMapping | null,
  next: StatusMapping | null,
  optionName: (id: string) => string,
  selectionName: (id: string) => string,
): string[] {
  if (!next) return saved ? ["Clears the status mapping."] : [];
  const lines: string[] = [];
  if (saved?.selectionId !== next.selectionId)
    lines.push(`Maps Status of ${selectionName(next.selectionId)}.`);
  for (const event of statusMappingEvents) {
    const was = saved?.events[event] ?? null,
      now = next.events[event];
    if (was !== now)
      lines.push(
        `${statusEventLabels[event]}: ${now ? `sets Status to ${optionName(now)}` : "writes nothing"}.`,
      );
  }
  return lines;
}

/**
 * What saving the editor would send. A mapping is cleared only on purpose: with the saved
 * Project gone, or with every event set to Nothing. While the chosen Project's Status field is
 * not known (loading, unreadable, or absent) the draft is neither a mapping nor a clear, and
 * `ready` is false so it cannot be saved.
 */
export function statusMappingPlan(i: {
  saved: StatusMapping | null;
  clearing: boolean;
  values: Values;
  selection: StatusView["selections"][number] | undefined;
  fieldNodeId: string | undefined;
  optionName: (id: string) => string;
  selectionName: (id: string) => string;
}): { mapping: StatusMapping | null; lines: string[]; ready: boolean } {
  if (i.clearing)
    return {
      mapping: null,
      lines: ["Clears the status mapping."],
      ready: true,
    };
  if (!i.selection || !i.fieldNodeId)
    return { mapping: null, lines: [], ready: false };
  const mapping = draftMapping(i.values, i.selection, i.fieldNodeId);
  // Another Project starts from Nothing: that is not a choice to clear the saved mapping.
  if (
    !mapping &&
    i.saved &&
    i.saved.projectNodeId !== i.selection.projectNodeId
  )
    return { mapping: null, lines: [], ready: false };
  return {
    mapping,
    lines: statusMappingChanges(
      i.saved,
      mapping,
      i.optionName,
      i.selectionName,
    ),
    ready: true,
  };
}
