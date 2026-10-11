import { assignmentCommands } from "./browse-assignment.js";
import type { BrowseCommand } from "./browse.js";
import { evidenceCommands } from "./browse-evidence.js";
import { workspaceCommands } from "./browse-workspace.js";
import { capacityWriteCommands } from "./configure-capacity.js";
import { profileWriteCommands } from "./configure-profile.js";
import { projectWriteCommands } from "./configure-project.js";
import { routingWriteCommands } from "./configure-routing.js";
import { operationCommands } from "./operation.js";
import type { WriteCommand } from "./write.js";

/** Read-only browse commands, keyed "area action". */
export const browseCommands = new Map<string, BrowseCommand>([
  ...workspaceCommands,
  ...assignmentCommands,
  ...evidenceCommands,
]);

/** Configuration, adoption and receipt commands, keyed "area action". */
export const writeCommands = new Map<string, WriteCommand>([
  ...profileWriteCommands,
  ...projectWriteCommands,
  ...routingWriteCommands,
  ...capacityWriteCommands,
  ...operationCommands,
]);
