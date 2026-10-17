import type { z } from "zod";
import type { sourceObservationSchema } from "../../src/operator/contracts.js";
import {
  selectionCountsText,
  zeroMatchWarning,
} from "../../src/operator/readiness-text.js";
import { StatusBadge } from "./components.js";

type Project = z.infer<
  typeof sourceObservationSchema
>["data"]["projects"][number];

export const readinessAnchor = "source-readiness";

/** One selection's stored counts and zero-match warning, shared by Sync and GitHub source. */
export function ObservationCounts({
  projectId,
  rule,
  counts,
  label,
  sameTab = false,
  warningOnly = false,
  private: isPrivate = false,
}: {
  /** Names the selection where the row does not. */
  label?: string;
  projectId: string;
  rule: Project["readiness"];
  counts: Project["selections"][number]["counts"] | undefined;
  /** On the GitHub source tab the link moves focus to the Readiness panel in place. */
  sameTab?: boolean;
  /** The counts live in the row's Details; only the zero-match warning stays visible. */
  warningOnly?: boolean;
  /** The label is saved private text, so evidence masks it. */
  private?: boolean;
}) {
  if (!counts) return null;
  const warning = zeroMatchWarning(counts, rule);
  return (
    <>
      {!warningOnly && (
        <p className="body">
          {label && `${label}: `}
          {selectionCountsText(counts, rule)}
        </p>
      )}
      {warning && (
        <p className="body">
          <StatusBadge tone="warning">No match</StatusBadge>{" "}
          {warningOnly && label && (
            <>
              <span data-private={isPrivate || undefined}>{label}</span>:{" "}
            </>
          )}
          {warning}{" "}
          <a
            href={
              sameTab
                ? `#${readinessAnchor}`
                : `/app/projects/${projectId}/settings?tab=github#${readinessAnchor}`
            }
            onClick={
              sameTab
                ? () => document.getElementById(readinessAnchor)?.focus()
                : undefined
            }
          >
            Check readiness conditions
          </a>
        </p>
      )}
    </>
  );
}
