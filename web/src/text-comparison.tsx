import { useMemo } from "react";
import { type DiffRow, lineDiff } from "./issue-improve-model.js";
import "./issue-improve.css";

function DiffColumn({ label, rows }: { label: string; rows: DiffRow[] }) {
  return (
    <div className="issue-improve-diff-column">
      <span className="metadata muted issue-improve-diff-label">{label}</span>
      <div className="issue-improve-diff-rows">
        {rows.map((row, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reordered.
            key={index}
            className="issue-improve-diff-row"
            data-kind={row.kind}
          >
            <span aria-hidden="true" className="issue-improve-diff-mark">
              {row.kind === "removed" ? "−" : row.kind === "added" ? "+" : ""}
            </span>
            <span className="issue-improve-diff-text">
              {row.kind === "removed" ? (
                <span className="issue-improve-sr">Removed: </span>
              ) : null}
              {row.kind === "added" ? (
                <span className="issue-improve-sr">Added: </span>
              ) : null}
              {row.text || " "}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TextComparison({
  name,
  currentLabel,
  current,
  proposed,
}: {
  name: string;
  currentLabel: string;
  current: string;
  proposed: string;
}) {
  const diff = useMemo(() => lineDiff(current, proposed), [current, proposed]);
  return (
    <div className="issue-improve-compare">
      <span className="body issue-improve-strong">{name}</span>
      <div className="issue-improve-diff">
        <DiffColumn label={currentLabel} rows={diff.current} />
        <DiffColumn label="Proposed" rows={diff.proposed} />
      </div>
    </div>
  );
}
