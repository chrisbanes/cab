import { type SyntheticEvent, useState } from "react";
import type { z } from "zod";
import type { feedbackReferenceSchema } from "../../src/core/task-review-contracts.js";
import type { TaskRead } from "../../src/operator/contracts.js";
import { ActionLink, Button, ShortId } from "./components.js";
import { reviewHeadComparison } from "./delivery-presentation.js";
import { criterionRows } from "./task-overview.js";

/** Result criteria and evidence, shared by task detail's Latest result and the result review panel. */
type Reference = z.infer<typeof feedbackReferenceSchema>;
export const sourceGap =
  "Retained source body and checklist coverage are unavailable. Source fields are retained only up to 16,000 characters; private or missing material may also be unavailable. Consult the external source or ask the lead.";

export function ChecklistCoverage({
  source,
}: {
  source:
    | NonNullable<TaskRead["data"]["review"]>["sources"][number]
    | undefined;
}) {
  if (!source || source.body === null) return <p>{sourceGap}</p>;
  if (source.criteriaOmittedCount === null)
    return (
      <p>
        Additional literal checklist coverage is unknown for this retained
        source.
      </p>
    );
  if (source.criteriaOmittedCount > 0)
    return (
      <p>
        Checklist coverage is partial: {source.criteria.length} literal
        checklist records retained; {source.criteriaOmittedCount} additional
        records omitted. Consult the full retained brief.
      </p>
    );
  return null;
}

export function Literal({ text }: { text: string | null | undefined }) {
  return (
    <pre className="literal-text">{text ?? "Unavailable or redacted"}</pre>
  );
}

/** Supplied criteria as C1/C2 rows with the result's recorded outcome; no overall pass. */
export function CriteriaRows({
  data,
  resultId,
  sourceId,
  ask,
  more,
}: {
  data: TaskRead["data"];
  resultId: string;
  sourceId: string | undefined;
  /** Offers Ask lead about criterion; a surface with its own feedback form omits it. */
  ask?: ((r: Reference, label: string) => void) | undefined;
  /** The "N more" disclosure's open state, kept on the history entry like the Overview cards. */
  more: {
    open: boolean;
    onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => void;
  };
}) {
  const s = data.review?.sources.find((s) => s.sourceId === sourceId),
    latest = data.review?.sources.at(-1),
    rows = criterionRows(data, resultId, sourceId);
  const criterionRow = (row: (typeof rows)[number]) => (
    <div
      key={row.criterionId}
      className="criterion-row"
      data-record-id={row.criterionId}
    >
      <p>
        {row.label} · {row.status}
        {row.stale ? " · stale source revision" : ""}
      </p>
      <p>{row.text}</p>
      <p className="metadata muted">
        {[
          `Source revision ${row.revision}`,
          row.record?.scope,
          row.record?.provenance,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {row.records.length > 1 && (
        <div>
          <p>Duplicate criterion identity; overall outcome unknown.</p>
          <Literal
            text={row.records
              .map((record) =>
                [record.outcome, record.scope, record.provenance]
                  .filter(Boolean)
                  .join(" · "),
              )
              .join("\n")}
          />
        </div>
      )}
      {ask && (
        <Button
          variant="secondary"
          onClick={() =>
            ask(
              {
                resultId,
                sourceId: sourceId as string,
                criterionId: row.criterionId,
              },
              `criterion ${row.position + 1} in source revision ${row.revision}`,
            )
          }
        >
          Ask lead about criterion
        </Button>
      )}
    </div>
  );
  return (
    <div className="criteria-rows">
      <h4 className="small-heading">
        {!s || s.body === null
          ? "Supplied criteria — coverage unavailable"
          : "Supplied criteria"}
      </h4>
      <ChecklistCoverage source={s} />
      {s && s.body !== null && !s.criteria.length && (
        <p>
          No literal checklist records. Consult the supplied brief prose for
          requirements.
        </p>
      )}
      {rows.slice(0, 3).map(criterionRow)}
      {rows.length > 3 && (
        <details className="criteria-more" {...more}>
          <summary>{rows.length - 3} more</summary>
          {rows.slice(3).map(criterionRow)}
        </details>
      )}
      {latest && s && latest.sourceId !== s.sourceId && (
        <p>
          Newer source revision {latest.revision} has requirements not covered
          by this historical result.
        </p>
      )}
      {latest && s && latest.sourceId !== s.sourceId && (
        <div>
          <h4>
            Current supplied criteria not covered by this historical result
          </h4>
          {latest.criteria.map((c) => (
            <p key={c.criterionId}>
              {c.text} · unverified for source revision {latest.revision}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
export function ReviewEvidence({
  data,
  resultId,
  sourceId,
  ask,
  headComparison,
}: {
  data: TaskRead["data"];
  resultId: string;
  sourceId: string | undefined;
  /** Offers Ask lead about artifact; a surface with its own feedback form omits it. */
  ask?: ((r: Reference, label: string) => void) | undefined;
  /** How a validation's checked head compares; by default against the bound PR's head. */
  headComparison?: ((checkedHead: string | undefined) => string) | undefined;
}) {
  const metadata = data.review?.results.find(
    (r) => r.resultId === resultId,
  )?.metadata;
  if (!metadata) return null;
  return (
    <>
      {metadata.decisions
        .map((d, i) => ({ d, recordId: `${resultId}:decision:${i}` }))
        .map(({ d, recordId }) => (
          <div key={recordId} data-record-id={recordId}>
            <h4>Recorded decision</h4>
            <p>{d.attribution}</p>
            <Literal text={d.text} />
          </div>
        ))}
      <h4>Validation records</h4>
      {metadata.validations.length ? (
        metadata.validations.map((v) => {
          const head = data.delivery?.binding?.headSha,
            unknown =
              !v.checkedHead || !head || data.delivery?.binding?.readError;
          return (
            <p key={`${v.label}:${v.scope}:${v.provenance}`}>
              {v.label}: {v.outcome} · {v.scope} · {v.provenance} ·{" "}
              {v.checkedHead && (
                <>
                  checked head <ShortId value={v.checkedHead} /> ·{" "}
                </>
              )}
              {headComparison
                ? headComparison(v.checkedHead)
                : unknown
                  ? "Head comparison unknown"
                  : v.checkedHead === head
                    ? reviewHeadComparison(
                        true,
                        data.delivery?.binding?.codeHost,
                      )
                    : reviewHeadComparison(
                        false,
                        data.delivery?.binding?.codeHost,
                      )}
            </p>
          );
        })
      ) : (
        <p>No supplied validation record. No overall pass is inferred.</p>
      )}
      <h4>Recorded comparisons and evidence</h4>
      {!metadata.artifacts.length && <p>No artifact evidence supplied.</p>}
      {[
        ...new Set(
          metadata.artifacts.map((a) => a.pairId ?? `unpaired:${a.artifactId}`),
        ),
      ].map((pair) => {
        const group = metadata.artifacts.filter(
          (a) => (a.pairId ?? `unpaired:${a.artifactId}`) === pair,
        );
        return (
          <section key={pair} data-artifact-pair={pair}>
            <h5>
              {pair.startsWith("unpaired:")
                ? "Unpaired recorded evidence"
                : `Recorded pair ${pair}`}
            </h5>
            <div className="artifact-comparisons">
              {["before", "after", "evidence"].map((role) => (
                <div key={role} data-artifact-role={role}>
                  {group
                    .filter((a) => a.role === role)
                    .map((a) =>
                      metadata.artifacts.filter(
                        (v) => v.artifactId === a.artifactId,
                      ).length > 1 ? (
                        <p key={`${a.artifactId}:${role}:${a.label}`}>
                          Duplicate artifact identity {a.artifactId}; preview
                          and feedback unavailable.
                        </p>
                      ) : (
                        <Artifact
                          key={a.artifactId}
                          taskId={data.task.id}
                          artifact={a}
                          ask={
                            ask &&
                            (() =>
                              ask(
                                {
                                  resultId,
                                  artifactId: a.artifactId,
                                  ...(sourceId ? { sourceId } : {}),
                                },
                                `${a.role} artifact ${a.label}`,
                              ))
                          }
                        />
                      ),
                    )}
                  {!pair.startsWith("unpaired:") &&
                    role !== "evidence" &&
                    !group.some((a) => a.role === role) && (
                      <p>{role}: recorded side missing.</p>
                    )}
                </div>
              ))}
            </div>
          </section>
        );
      })}
      <p>
        Before/after labels and pairing are producer records. Missing sides and
        preview failures are not replaced with another revision.
      </p>
      {metadata.artifacts
        .filter((a) => a.pairId)
        .map(
          (a) =>
            !metadata.artifacts.some(
              (b) => b.pairId === a.pairId && b.role !== a.role,
            ) && (
              <p key={a.artifactId}>
                Pair {a.pairId}: opposite side unavailable.
              </p>
            ),
        )}
    </>
  );
}
function Artifact({
  taskId,
  artifact,
  ask,
}: {
  taskId: string;
  artifact: NonNullable<
    TaskRead["data"]["review"]
  >["results"][number]["metadata"]["artifacts"][number];
  ask: (() => void) | undefined;
}) {
  const [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0);
  return (
    <figure data-record-id={artifact.artifactId}>
      <figcaption>
        {artifact.role}: {artifact.label} · revision {artifact.revision} · pair{" "}
        {artifact.pairId ?? "none recorded"}
      </figcaption>
      {artifact.availability === "available" ? (
        <>
          <img
            key={retry}
            loading="lazy"
            src={`/api/operator/tasks/${taskId}/artifacts/${artifact.artifactId}`}
            alt={`${artifact.role}: ${artifact.label}`}
            onError={() => setFailed(true)}
            hidden={failed}
          />
          {failed && (
            <>
              <p>
                Preview unavailable or mismatched. Recorded identity retained.
              </p>
              <Button
                variant="secondary"
                onClick={() => {
                  setFailed(false);
                  setRetry((n) => n + 1);
                }}
              >
                Retry recorded preview
              </Button>
            </>
          )}
          {artifact.url && (
            <ActionLink href={artifact.url}>
              Open recorded artifact link
            </ActionLink>
          )}
        </>
      ) : (
        <p>{artifact.availability}</p>
      )}
      {ask && (
        <Button variant="secondary" onClick={ask}>
          Ask lead about artifact
        </Button>
      )}
    </figure>
  );
}
