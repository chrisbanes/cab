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
      "Request an exact policy-authorized code-host action. Intent precedes effect; uncertain actions hold this task. Never run git push: commit in your worktree, then request branch.push (or branch.force-push after rewriting history) with that commit SHA. cab pushes it to this task's assigned branch and the receipt names the branch; use that branch as the pr.create headRef. A GitLab merge request is a pr.* target (IID as number, the receipt's nodeId); on GitLab a body line starting with / and a letter, or a draft-prefixed title, is held. Uncommitted changes are never pushed. After an outside change on the branch, recover with the operator's approval of the exact material {branch, outsideHeadSha, lastPushedSha}: branch.adopt keeps the outside head as the branch's recorded head (merge or rebase it in your worktree, then push), and branch.force-push with that material and your commit overwrites it.",
    inputSchema: z.toJSONSchema(externalActionArgumentsSchema),
  },
  {
    type: "function",
    name: "cab_register_pr",
    description:
      "Bind an existing identity-verified PR or merge request (its IID as prNumber and the pr.create receipt's nodeId as expectedPrNodeId) to this task and retain its lead for delivery feedback.",
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
    name: "cab_report_result",
    description: "Persist the result of this assignment for its requester.",
    inputSchema: object(
      { summary: text, review: z.toJSONSchema(reviewMetadataSchema) },
      ["summary"],
    ),
  },
  {
    type: "function",
    name: "cab_ask_question",
    description: "Create a durable question for operator attention.",
    inputSchema: z.toJSONSchema(questionToolArgumentsSchema),
  },
  {
    type: "function",
    name: "cab_request_approval",
    description:
      "Request operator approval for a specific action and material.",
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
    default:
      return { text: "Unknown coordination tool", success: false };
  }
}
