import type { JsonValue } from "./contracts.js";
import { deliveryActionCopy } from "./delivery-action-copy.js";

export type ApprovalMaterialView = {
  facts: { label: string; value: string }[];
  /** Full text, Markdown-capable on the web. */
  texts: { label: string; text: string }[];
  diffs: { label: string; before: string; after: string }[];
  /** Not an action's material: show its top-level fields instead. */
  unrecognized: boolean;
};

type JsonObject = { [key: string]: JsonValue };
const object = (value: JsonValue | undefined): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
const textFields = [
  ["title", "Title"],
  ["body", "Body"],
] as const;

/**
 * The approval's bound material as the operator reads it: rendered text, before/after diffs for
 * edits, and named facts. Display only: the decision still sends the material unchanged. Only an
 * approval whose action is the material's kind is read as an action, because the service then
 * validated it strictly against that action (and its target against the approval's); any other
 * material is unrecognized and lists its fields. No value import from the delivery store (web).
 */
export function approvalMaterialView(
  material: JsonValue,
  action: string | null,
): ApprovalMaterialView {
  const view: ApprovalMaterialView = {
    facts: [],
    texts: [],
    diffs: [],
    unrecognized: false,
  };
  const m = object(material);
  if (
    typeof m?.kind !== "string" ||
    m.kind !== action ||
    !Object.hasOwn(deliveryActionCopy, m.kind)
  )
    return { ...view, unrecognized: true };
  const target = object(m.target);
  const fact = (label: string, value: JsonValue | undefined) => {
    if (value !== undefined)
      view.facts.push({
        label,
        value: typeof value === "string" ? value : JSON.stringify(value),
      });
  };
  const text = (label: string, value: JsonValue | undefined) => {
    if (typeof value === "string") view.texts.push({ label, text: value });
  };
  const count = (value: JsonValue | undefined) =>
    Array.isArray(value) ? String(value.length) : undefined;
  const number = (value: JsonValue | undefined) =>
    typeof value === "number" ? `#${value}` : undefined;
  switch (m.kind) {
    case "issue.edit":
    case "pr.edit": {
      const fields = object(m.fields),
        expected = object(m.expected);
      for (const [key, label] of textFields) {
        const after = fields?.[key],
          before = expected?.[key];
        if (typeof after !== "string") continue;
        if (typeof before === "string")
          view.diffs.push({ label, before, after });
        else text(label, after);
      }
      break;
    }
    case "issue.create":
      text("Title", m.title);
      fact("Labels", Array.isArray(m.labels) ? m.labels.join(", ") : m.labels);
      text("Body", m.body);
      break;
    case "issue.comment":
    case "pr.thread.reply":
      text("Body", m.body);
      break;
    case "pr.create":
      text("Title", m.title);
      text("Body", m.body);
      fact(
        "Draft",
        typeof m.draft === "boolean" ? (m.draft ? "yes" : "no") : m.draft,
      );
      if (target)
        fact(
          "Branches",
          `${String(target.baseRef)} ← ${String(target.headRef)}`,
        );
      break;
    case "pr.merge":
      fact("Pull request", number(target?.number));
      fact("Merge method", m.method);
      fact("Reviewed results", count(m.reviewedResultIds));
      break;
    case "issue.close":
      fact("Issue", number(target?.number));
      fact("Reviewed results", count(m.reviewedResultIds));
      break;
    case "branch.force-push":
    case "branch.adopt":
      fact("Branch", m.branch);
      fact("Commit", m.commitSha);
      fact("Outside head", m.outsideHeadSha);
      fact("Last pushed", m.lastPushedSha === null ? "never" : m.lastPushedSha);
      break;
    default:
      for (const [key, value] of Object.entries(m))
        if (key !== "kind" && key !== "target") fact(key, value);
  }
  return view;
}
