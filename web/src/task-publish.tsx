import { useCallback, useEffect, useRef, useState } from "react";
import type { OperatorCommand } from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { Button, StatusBadge } from "./components.js";
import { Input } from "./ui/input.js";
import {
  createStep,
  emptyLocal,
  firstEnabled,
  type PublicationLatest,
  type PublicationPolicy,
  type PublicationReceipt,
  type PublicationReview,
  type PublishLocal,
  type PublishView,
  publishCopy,
  publishView,
  readyWord,
  rejectionSentence,
  targetSummary,
} from "./task-publish-model.js";
import "./issue-improve.css";
import "./task-publish.css";

const badges: Record<
  PublishView,
  [string, "idle" | "warning" | "success" | "error" | "neutral"]
> = {
  unavailable: ["Unavailable", "idle"],
  choose: ["Ready to publish", "idle"],
  reviewing: ["Reviewing", "neutral"],
  sending: ["Publishing", "warning"],
  waiting: ["Publishing", "warning"],
  uncertain: ["Outcome unknown", "error"],
  published: ["Published", "success"],
  failed: ["Not created", "error"],
  abandoned: ["Abandoned", "warning"],
};

const stepLabels = {
  "issue.create": "Create the issue",
  "project.item.add": "Add it to the GitHub Project",
  "project.field": "Set a Project field",
} as const;

const stepStates: Record<string, string> = {
  prepared: "recorded, not sent yet",
  attempting: "in progress",
  uncertain: "outcome unknown",
  "confirmed-success": "done",
  "confirmed-failure": "failed",
  denied: "refused",
};

/** The panel for one local task, shown while the task page has it open. */
export function PublishToGitHub({
  client,
  csrfToken,
  taskId,
  taskVersion,
  policy,
  onChanged,
  onClose,
}: {
  client: OperatorClient;
  csrfToken: string;
  taskId: string;
  taskVersion: number;
  policy: PublicationPolicy;
  onChanged: () => void;
  /** Hides the panel once an ended publication has been read. */
  onClose: () => void;
}) {
  const [local, setLocal] = useState<PublishLocal>(emptyLocal);
  const [targetId, setTargetId] = useState<string | null>(() =>
    firstEnabled(policy),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [issue, setIssue] = useState("");
  const [abandoning, setAbandoning] = useState(false);
  // One key per review and per send, so a retry of either replays instead of repeating.
  const keys = useRef({
    review: crypto.randomUUID(),
    send: crypto.randomUUID(),
  });
  const view = publishView(policy, local);
  const latest = policy.latest;
  const [label, tone] = badges[view];
  const selected = policy.targets.find((t) => t.id === targetId) ?? null;

  useEffect(() => {
    if (targetId === null) setTargetId(firstEnabled(policy));
  }, [policy, targetId]);

  const send = useCallback(
    async (command: OperatorCommand) => client.command(command, csrfToken),
    [client, csrfToken],
  );
  const failure = (state: string, code?: string) => {
    setMessage(
      state === "unknown"
        ? publishCopy.unknown
        : rejectionSentence(code ?? "conflict"),
    );
    onChanged();
  };

  const review = async () => {
    if (!selected) return;
    setBusy(true);
    setMessage(null);
    const result = await send({
      type: "task.publish.review",
      key: keys.current.review,
      taskId,
      targetId: selected.id,
      expectedTaskVersion: taskVersion,
    });
    setBusy(false);
    if (
      result.state === "recorded" &&
      result.receipt.kind === "publication-review"
    )
      setLocal({ ...emptyLocal, review: result.receipt });
    else
      failure(
        result.state,
        result.state === "rejected" ? result.code : undefined,
      );
    // A new review is a new request, so a changed choice never replays an old one.
    keys.current = { review: crypto.randomUUID(), send: crypto.randomUUID() };
  };

  const publish = async (reviewed: PublicationReview) => {
    setBusy(true);
    setMessage(null);
    setLocal({ ...local, sending: true });
    const confirmed = await send({
      type: "task.publish.confirm",
      key: crypto.randomUUID(),
      taskId,
      reviewId: reviewed.reviewId,
      expectedRevision: reviewed.revision,
      materialHash: reviewed.materialHash,
      decision: "approved",
    });
    if (
      confirmed.state !== "recorded" ||
      confirmed.receipt.kind !== "publication-review" ||
      confirmed.receipt.decision !== "approved"
    ) {
      setBusy(false);
      setLocal({ ...local, review: reviewed, sending: false });
      return failure(
        confirmed.state,
        confirmed.state === "rejected" ? confirmed.code : undefined,
      );
    }
    const sent = await send({
      type: "task.publish.send",
      key: keys.current.send,
      taskId,
      reviewId: reviewed.reviewId,
      expectedTaskVersion: reviewed.taskVersion,
    });
    setBusy(false);
    if (sent.state === "recorded" && sent.receipt.kind === "publication") {
      const state = (sent.receipt as PublicationReceipt).state;
      setLocal({
        review: null,
        sending: false,
        ended:
          state === "converted"
            ? "published"
            : state === "failed"
              ? "failed"
              : null,
      });
    } else {
      setLocal({ ...emptyLocal });
      setMessage(publishCopy.unknown);
    }
    onChanged();
  };

  const act = async (
    command: OperatorCommand,
    ended: PublishLocal["ended"],
  ) => {
    setBusy(true);
    setMessage(null);
    const result = await send(command);
    setBusy(false);
    if (result.state === "recorded") {
      setLocal({ ...emptyLocal, ended });
      setAbandoning(false);
      setIssue("");
    } else
      failure(
        result.state,
        result.state === "rejected" ? result.code : undefined,
      );
    onChanged();
  };

  const checkAgain = async () => {
    setBusy(true);
    await send({ type: "delivery.refresh", key: crypto.randomUUID(), taskId });
    setBusy(false);
    onChanged();
  };

  return (
    <section
      className="issue-improve task-publish"
      aria-labelledby="task-publish-heading"
    >
      <div className="issue-improve-head">
        <h2 id="task-publish-heading" className="small-heading">
          Publish to GitHub
        </h2>
        <StatusBadge tone={tone}>{label}</StatusBadge>
      </div>

      {view === "unavailable" && (
        <p className="body" role="status">
          {policy.reason ?? "This task can’t be published."}
        </p>
      )}

      {view === "choose" && (
        <>
          <p className="body muted">{publishCopy.intro}</p>
          <fieldset className="task-publish-targets">
            <legend className="body issue-improve-strong">Publish to</legend>
            {policy.targets.map((t) => (
              <label
                key={t.id}
                className="task-publish-target body"
                data-disabled={!t.enabled || undefined}
              >
                <input
                  type="radio"
                  name="publish-target"
                  value={t.id}
                  checked={targetId === t.id}
                  disabled={!t.enabled}
                  aria-describedby={`publish-target-${t.id}`}
                  onChange={() => setTargetId(t.id)}
                />
                <span className="task-publish-target-text">
                  <span className="issue-improve-strong">
                    {targetSummary(t)}
                  </span>
                  <span
                    id={`publish-target-${t.id}`}
                    className="metadata muted"
                  >
                    {t.enabled
                      ? `The new issue is selected here, and the task stays ${readyWord(t.predictedReady)}.${t.labels.length ? ` Adds the label ${t.labels.map((l) => l ?? "(hidden)").join(", ")}.` : ""}`
                      : (t.reason ?? "Can’t publish here.")}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="issue-improve-actions">
            <Button
              type="button"
              disabled={!selected?.enabled || busy}
              onClick={() => void review()}
            >
              Review
            </Button>
          </div>
        </>
      )}

      {(view === "reviewing" || view === "sending") && local.review && (
        <ReviewDetails
          review={local.review}
          sending={view === "sending"}
          busy={busy}
          onBack={() => setLocal({ ...emptyLocal })}
          onPublish={() => void publish(local.review as PublicationReview)}
        />
      )}

      {(view === "waiting" || view === "uncertain") && latest && (
        <>
          <p className="body" role={view === "uncertain" ? "alert" : "status"}>
            {view === "uncertain" ? publishCopy.uncertain : publishCopy.waiting}
          </p>
          <Steps latest={latest} />
          <div className="issue-improve-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => void checkAgain()}
            >
              Check GitHub again
            </Button>
          </div>
          {view === "uncertain" && (
            <>
              <div className="task-publish-link">
                <label className="field body" htmlFor="task-publish-issue">
                  Issue number
                  <Input
                    id="task-publish-issue"
                    className="control"
                    inputMode="numeric"
                    value={issue}
                    onChange={(e) =>
                      setIssue(e.target.value.replace(/[^0-9]/g, ""))
                    }
                  />
                </label>
                <span className="metadata muted">{publishCopy.linkHelp}</span>
                <div className="issue-improve-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!/^[1-9][0-9]{0,8}$/.test(issue) || busy}
                    onClick={() =>
                      void act(
                        {
                          type: "task.publish.link",
                          key: crypto.randomUUID(),
                          taskId,
                          reviewId: latest.publicationId,
                          issueNumber: Number(issue),
                        },
                        "published",
                      )
                    }
                  >
                    Link issue
                  </Button>
                </div>
              </div>
              {abandoning ? (
                <div className="issue-improve-note" role="alert">
                  <span aria-hidden="true">!</span>
                  <span className="body">{publishCopy.abandonWarning}</span>
                </div>
              ) : null}
              <div className="issue-improve-actions">
                {abandoning ? (
                  <>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          {
                            type: "task.publish.abandon",
                            key: crypto.randomUUID(),
                            taskId,
                            reviewId: latest.publicationId,
                          },
                          "abandoned",
                        )
                      }
                    >
                      Abandon and accept a possible duplicate
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setAbandoning(false)}
                    >
                      Keep waiting
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setAbandoning(true)}
                  >
                    Abandon…
                  </Button>
                )}
              </div>
            </>
          )}
        </>
      )}

      {(view === "published" || view === "failed" || view === "abandoned") && (
        <>
          <p className="body" role="status">
            {publishCopy[view]}
          </p>
          <div className="issue-improve-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setLocal({ ...emptyLocal });
                onClose();
              }}
            >
              Done
            </Button>
          </div>
        </>
      )}

      {message && (
        <p className="body" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

function Steps({ latest }: { latest: PublicationLatest }) {
  const create = createStep(latest);
  return (
    <ol className="task-publish-steps" aria-label="Publication steps">
      {latest.steps.map((step) => (
        <li key={step.operationId} className="body">
          {stepLabels[step.kind]}:{" "}
          <span className="issue-improve-strong">
            {stepStates[step.state] ?? step.state}
          </span>
          {step === create && latest.issueNumber
            ? ` (issue #${latest.issueNumber})`
            : ""}
        </li>
      ))}
    </ol>
  );
}

function ReviewDetails({
  review,
  sending,
  busy,
  onBack,
  onPublish,
}: {
  review: PublicationReview;
  sending: boolean;
  busy: boolean;
  onBack: () => void;
  onPublish: () => void;
}) {
  const repository = review.repository ?? "this repository";
  return (
    <>
      <p className="body" role="status">
        {sending
          ? `Publishing to ${repository}…`
          : "Review what will be created. Nothing has been sent."}
      </p>
      <dl className="task-publish-facts body">
        <dt>Repository</dt>
        <dd className="issue-improve-strong">{repository}</dd>
        <dt>Title</dt>
        <dd>{review.title}</dd>
        <dt>Body</dt>
        <dd className="task-publish-body">{review.body || "(empty)"}</dd>
        <dt>Labels</dt>
        <dd>
          {review.labels.length
            ? review.labels.map((l) => l ?? "(hidden)").join(", ")
            : "None"}
        </dd>
        <dt>GitHub Project</dt>
        <dd>
          {review.addsToProject
            ? `Added${review.projectFields.length ? `, with ${review.projectFields.length} readiness field${review.projectFields.length === 1 ? "" : "s"} set` : ""}`
            : "Not added"}
        </dd>
        <dt>Afterwards</dt>
        <dd>
          Matches the selection: {review.predictedSelected ? "yes" : "no"}. The
          task stays {readyWord(review.predictedReady)}.
        </dd>
      </dl>
      <div className="issue-improve-note" role="note">
        <span aria-hidden="true">!</span>
        <span className="body">{publishCopy.irreversible(repository)}</span>
      </div>
      <p className="metadata muted">{publishCopy.guard}</p>
      <div className="issue-improve-actions">
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onBack}
        >
          Back
        </Button>
        <Button type="button" disabled={busy} onClick={onPublish}>
          {sending ? "Publishing…" : `Publish to ${repository}`}
        </Button>
      </div>
    </>
  );
}
