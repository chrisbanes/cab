import { questionToolArgumentsSchema } from "../core/question-forms.js";
import { reviewMetadataSchema } from "../core/task-review.js";
import { z } from "zod";
import { externalActionArgumentsSchema } from "../core/delivery.js";
import type {
  CoordinationStore,
  CoordinationCall,
  CoordinationToolResponse,
} from "../core/coordination.js";
import type { RuntimeToolDefinition } from "./codex.js";

const uuid = { type: "string", format: "uuid" };
const text = { type: "string", minLength: 1, maxLength: 16000 };
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const coordinationTools: readonly RuntimeToolDefinition[] = [
  {
    type: "function",
    name: "cab_external_action",
    description:
      "Request a policy-authorized code-host action. Intent precedes effect; uncertain actions hold this task. operationId: a fresh UUID v4 for every request, even after a refusal. Never run git push: commit locally, then request branch.push (branch.force-push after rewriting) with its SHA. branch.push takes only target.repositoryId; cab pushes committed changes to the task branch it assigns and names in the receipt; use it as pr.create headRef. Stacked dependents must use the blocker task branch as baseRef; another base is refused before provider calls. GitLab pr.* uses the IID as number and receipt nodeId; slash-command body lines and draft-prefixed titles are held. Jira repositoryId is project ID, nodeId is issue ID; titles start with its key; no Closes/Fixes beside a key. For an outside branch change, operator approval must cover exact {branch, outsideHeadSha, lastPushedSha}: branch.adopt records that head (merge/rebase locally, then push); branch.force-push with that material and your commit overwrites it.",
    inputSchema: z.toJSONSchema(externalActionArgumentsSchema),
  },
  {
    type: "function",
    name: "cab_register_pr",
    description:
      "Confirmed pr.create automatically binds when this task has no bound PR; a binding failure preserves the confirmed create and its receipt. Manually bind an existing identity-verified PR or merge request (its IID as prNumber and the pr.create receipt's nodeId as expectedPrNodeId) to this task and retain its task lead for delivery feedback. Only the task lead or the same-task assignment whose confirmed pr.create produced the exact repository/number/node identity may register.",
    inputSchema: object(
      {
        repositoryId: text,
        prNumber: { type: "integer", minimum: 1 },
        expectedPrNodeId: text,
        expectedHeadSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
      },
      ["repositoryId", "prNumber", "expectedPrNodeId", "expectedHeadSha"],
    ),
  },
  {
    type: "function",
    name: "cab_delegate",
    description: "Assign a scoped task to a permitted project profile.",
    inputSchema: object({ profileId: uuid, brief: text }, [
      "profileId",
      "brief",
    ]),
  },
  {
    type: "function",
    name: "cab_withdraw_delegate",
    description:
      "Withdraw an idle delegate you requested that will not finish, so it stops holding back your report. Final: no result and no restore; delegate again to redo the work. Refused while it has a live, held or uncertain execution, an ownership or recovery hold, an open question or approval, or unfinished delegates of its own.",
    inputSchema: object(
      {
        assignmentId: uuid,
        reason: { type: "string", minLength: 1, maxLength: 2000 },
      },
      ["assignmentId", "reason"],
    ),
  },
  {
    type: "function",
    name: "cab_report_result",
    description:
      "Persist the assignment's final result for its requester. This is not a progress update: finish work and ask any needed cab questions before reporting. Result persistence does not end the runtime turn; the assignment completes only after a successful terminal with no outstanding questions or delegated work. End your turn after reporting unless you still need a durable cab action. Use cab_ask_question for questions, never native asynchronous input tools.",
    inputSchema: object(
      { summary: text, review: z.toJSONSchema(reviewMetadataSchema) },
      ["summary"],
    ),
  },
  {
    type: "function",
    name: "cab_ask_question",
    description:
      "Create a durable question for operator attention. Write for a person: state the decision in one plain sentence (at most 120 characters, one line, no IDs, SHAs or failure codes) and put background in `description` or plain `context`. For any decision with known alternatives pass `form` (version 1): one question per decision, kind single-choice or multiple-choice, concrete options whose labels are at most 80 characters, each with a description saying what choosing it causes, and a `recommended` option id; never bundle several decisions into one plain question. Pass plain `question` only for open-ended input with no fixed choices. Do not ask the operator to diagnose cab refusals; fix the input from the refusal message. Rule-breaking questions are refused with the field to fix.",
    inputSchema: z.toJSONSchema(questionToolArgumentsSchema),
  },
  {
    type: "function",
    name: "cab_request_approval",
    description:
      "Request operator approval for a specific action and material. A known delivery action kind such as `branch.force-push` is shown with cab's own headline; any other `action` is the headline, so write it as one plain sentence of at most 120 characters with no IDs, SHAs or failure codes.",
    inputSchema: object(
      {
        action: { type: "string", minLength: 1, maxLength: 512 },
        target: { type: "string", minLength: 1, maxLength: 2000 },
        material: { type: "object" },
      },
      ["action", "material"],
    ),
  },
  {
    type: "function",
    name: "cab_request_follow_up",
    description:
      "Request a new revision of a completed result from its assignee.",
    inputSchema: object({ resultId: uuid, instructions: text }, [
      "resultId",
      "instructions",
    ]),
  },
  {
    type: "function",
    name: "cab_request_completion",
    description: "Ask cab to validate completion of this task.",
    inputSchema: object(
      { reviewedResultIds: { type: "array", items: uuid, maxItems: 1000 } },
      ["reviewedResultIds"],
    ),
  },
];

export function isCoordinationTool(name: string): boolean {
  return coordinationTools.some((tool) => tool.name === name);
}

export function dispatchCoordinationTool(
  store: CoordinationStore,
  call: CoordinationCall,
  externalAdmission: () => boolean = () => true,
): CoordinationToolResponse {
  switch (call.tool) {
    case "cab_delegate":
      return store.delegate(call, externalAdmission);
    case "cab_ask_question":
      return store.requestQuestion(call);
    case "cab_request_approval":
      return store.requestApproval(call);
    case "cab_request_follow_up":
      return store.requestFollowUp(call);
    case "cab_request_completion":
      return store.requestTaskCompletion(call);
    case "cab_withdraw_delegate":
      return store.withdrawDelegate(call);
    default:
      return { text: "Unknown coordination tool", success: false };
  }
}
