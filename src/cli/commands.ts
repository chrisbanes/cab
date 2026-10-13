import { adoptCommands } from "./adopt.js";
import {
  attentionBrowseCommands,
  attentionWriteCommands,
} from "./attention.js";
import { assignmentCommands } from "./browse-assignment.js";
import type { BrowseCommand } from "./browse.js";
import { evidenceCommands } from "./browse-evidence.js";
import { executionCommands } from "./browse-execution.js";
import { doctorCommand } from "./doctor.js";
import { logsCommand } from "./logs-follow.js";
import { workspaceCommands } from "./browse-workspace.js";
import { capacityWriteCommands } from "./configure-capacity.js";
import { profileWriteCommands } from "./configure-profile.js";
import { projectWriteCommands } from "./configure-project.js";
import { routingWriteCommands } from "./configure-routing.js";
import { deliveryBrowseCommands, deliveryWriteCommands } from "./delivery.js";
import { operationCommands } from "./operation.js";
import { recoveryBrowseCommands, recoveryWriteCommands } from "./recovery.js";
import { sourceBrowseCommands, sourceWriteCommands } from "./source.js";
import { taskControlCommands } from "./task-control.js";
import { taskWriteCommands } from "./task-write.js";
import type { WriteCommand } from "./write.js";

/** Read-only browse commands, keyed "area action". */
export const browseCommands = new Map<string, BrowseCommand>([
  ...workspaceCommands,
  ...assignmentCommands,
  ...evidenceCommands,
  ...executionCommands,
  ["logs", logsCommand],
  ["doctor", doctorCommand],
  ...attentionBrowseCommands,
  ...sourceBrowseCommands,
  ...deliveryBrowseCommands,
  ...recoveryBrowseCommands,
]);

/** Configuration, adoption and receipt commands, keyed "area action". */
export const writeCommands = new Map<string, WriteCommand>([
  ...profileWriteCommands,
  ...projectWriteCommands,
  ...routingWriteCommands,
  ...capacityWriteCommands,
  ...adoptCommands,
  ...operationCommands,
  ...taskWriteCommands,
  ...attentionWriteCommands,
  ...taskControlCommands,
  ...sourceWriteCommands,
  ...deliveryWriteCommands,
  ...recoveryWriteCommands,
]);
