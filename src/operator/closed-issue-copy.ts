/** The closed-issue setting's options; the setting decides only first import. */
export const closedIssueLabels = {
  skip: "Skip",
  done: "Import as Done",
} as const;

/** What happens to an imported task when its issue closes, whatever the import setting. */
export const closureCompletionNote =
  "An imported task completes when its issue closes, once its work and delivery have settled.";

export type ClosureWait =
  | { kind: "change-request"; number: number }
  | { kind: "delivery-action"; action: string };

/** What a closure-held task waits on before it completes, as a clause. */
export const closureWaitClause = (wait: ClosureWait) =>
  wait.kind === "change-request"
    ? `completes when PR #${wait.number} merges or closes`
    : wait.action === "unstack"
      ? "completes when its unstack settles"
      : `completes when the outcome of its ${wait.action} action is known`;

/** The same, as a sentence. */
export const closureWaitText = (wait: ClosureWait) => {
  const clause = closureWaitClause(wait);
  return `${clause[0]?.toUpperCase()}${clause.slice(1)}.`;
};
