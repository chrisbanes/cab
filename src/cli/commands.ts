import { assignmentCommands } from "./browse-assignment.js";
import type { BrowseCommand } from "./browse.js";
import { evidenceCommands } from "./browse-evidence.js";
import { workspaceCommands } from "./browse-workspace.js";

/** Read-only browse commands, keyed "area action". */
export const browseCommands = new Map<string, BrowseCommand>([
  ...workspaceCommands,
  ...assignmentCommands,
  ...evidenceCommands,
]);
