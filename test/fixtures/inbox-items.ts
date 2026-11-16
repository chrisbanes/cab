import { isTaskInboxItem } from "../../src/operator/attention.js";
import type { InboxItem, TaskInboxItem } from "../../src/operator/contracts.js";

/** The task-bound items of an Inbox read: every one but a runtime or maintenance problem. */
export const taskItems = (items: readonly InboxItem[]): TaskInboxItem[] =>
  items.filter((item): item is TaskInboxItem => isTaskInboxItem(item));
