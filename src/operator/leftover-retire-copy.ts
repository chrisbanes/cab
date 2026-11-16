import type { LeftoverExecution } from "./contracts.js";

type Item = LeftoverExecution["items"][number];
type Hold = Pick<
  Extract<Item, { kind: "hold" }>,
  "hold" | "reason" | "workspaceEffects"
>;

/** Why retiring a task's leftover execution is refused, shared by the service, CLI and web. */
export const leftoverRetireRefusalText: Record<
  NonNullable<LeftoverExecution["refusal"]>,
  string
> = {
  "task-not-closed":
    "Only a done or cancelled task's leftovers can be retired.",
  "live-turn": "Execution is still live; wait for it to end, then list again.",
  "nothing-to-retire": "Nothing is left to retire.",
};

export const leftoverRetireNote =
  "Retiring cannot be undone. Each request is kept as history with its writer and capacity freed, and each hold is deleted. cab cannot prove a listed process has stopped.";

const holdNames = {
  writer: "Writer",
  ambiguity: "Ambiguity",
  archival: "Archival",
} as const;

/** One task hold as the listing and the receipt name it. */
export const leftoverHoldText = (h: Hold) =>
  `${holdNames[h.hold]} hold: ${h.reason}${h.workspaceEffects ? " (workspace effects unresolved)" : ""}`;

/** One leftover as the listing names it. */
export const leftoverItemText = (item: Item) =>
  item.kind === "request"
    ? `${item.status === "live" ? "Live" : "Unsettled"} request ${item.workId} (${item.profile}): ${item.reason}`
    : leftoverHoldText(item);
