import type { InboxItem, TaskInboxItem } from "../../src/operator/contracts.js";

/** The task-bound items of an Inbox read: every one but a runtime problem. */
export const taskItems = (items: readonly InboxItem[]): TaskInboxItem[] =>
  items.filter((item): item is TaskInboxItem => item.kind !== "runtime");
