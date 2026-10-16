import {
  CircleQuestionMark,
  Diamond,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { InboxItem } from "../../src/operator/contracts.js";
import { requestActionLabel, requestKindLabel } from "./inbox-presentation.js";
export { requestActionLabel, requestKindLabel };
/** One symbol per request kind, shared by the Inbox and the Overview cards. */
export const requestKindIcons: Record<InboxItem["kind"], LucideIcon> = {
  question: CircleQuestionMark,
  approval: Diamond,
  intervention: TriangleAlert,
};
type Request = Pick<
  InboxItem,
  "id" | "kind" | "taskId" | "destination" | "requesterName" | "createdAt"
>;
/** A question opens in the Inbox's own selection; other kinds go to their exact destination. */
export const requestHref = (item: Request) =>
  item.kind === "question"
    ? `/app/inbox?task=${item.taskId}&request=${encodeURIComponent(item.id)}`
    : item.destination;
/** Who is responsible for an uncertain execution: only an intervention request names that. */
export const interventionRequester = (
  items: readonly Pick<InboxItem, "taskId" | "kind" | "requesterName">[],
  taskId: string,
) =>
  items.find((i) => i.taskId === taskId && i.kind === "intervention")
    ?.requesterName ?? null;
/** A count is a total only when the whole Inbox was read and the last read succeeded. */
export function inboxSummaryOf(state: {
  data: {
    complete: boolean;
    unavailable: boolean;
    items: readonly Pick<InboxItem, "projectId">[];
  } | null;
  error: string | null;
}) {
  return state.data?.complete && !state.data.unavailable && !state.error
    ? {
        count: state.data.items.length,
        projects: new Set(state.data.items.map((item) => item.projectId)).size,
      }
    : null;
}
