import {
  validateQuestionAnswers,
  type QuestionAnswers,
  type QuestionForm,
} from "../../src/core/question-forms.js";
import type {
  OperatorCommand,
  QuestionRead,
  CommandReceipt,
} from "../../src/operator/contracts.js";
import type { CommandState } from "./api.js";
import { CommandSend, CommandSends } from "./command-send.js";
import { failureCause, type ReceiptDetails } from "./outcome-copy.js";

/** Validation issues by question id (`""` for the form), empty when the answers are valid. */
function answerIssues(form: QuestionForm, answers: QuestionAnswers) {
  const errors: Record<string, string> = Object.create(null);
  try {
    validateQuestionAnswers(form, answers);
  } catch (error) {
    const parsed = error as {
      issues?: Array<{ path: PropertyKey[]; message: string }>;
    };
    for (const issue of parsed.issues ?? [])
      errors[String(issue.path[0] ?? "")] = issue.message;
    if (!Object.keys(errors).length) errors[""] = "Answer validation failed";
  }
  return errors;
}

/** Questions whose current answer is valid; an empty optional question counts as complete. */
export function completedQuestionCount(
  form: QuestionForm,
  answers: QuestionAnswers,
) {
  const errors = answerIssues(form, answers);
  return form.questions.filter((q) => !(q.id in errors)).length;
}

/** What the operator selected per question ("Q1 · Red + Home"), and the numbers that still need an answer. */
export function answerSummary(form: QuestionForm, answers: QuestionAnswers) {
  const errors = answerIssues(form, answers),
    lines: string[] = [],
    missing: string[] = [];
  form.questions.forEach((q, index) => {
    const answer = answers[q.id],
      parts = [
        ...(q.kind === "free-text"
          ? []
          : (answer?.optionIds ?? []).map(
              (id) => q.options.find((o) => o.id === id)?.label ?? id,
            )),
        ...(answer?.text ? [answer.text] : []),
      ];
    if (parts.length) lines.push(`Q${index + 1} · ${parts.join(" + ")}`);
    if (q.id in errors) missing.push(`Q${index + 1}`);
  });
  return { lines, missing };
}

/** The plain outcome copy of an answer; Details, not these lines, carry the codes. */
export const answerCopy = {
  sent: "Answer sent. It reaches the requester on its next turn.",
  unknown:
    "We couldn't confirm your answer was sent. Your answer is kept until you check.",
  conflict:
    "This question was already answered, changed or withdrawn. Your answer is still here.",
  failed: (code: string) =>
    `Couldn't send the answer: ${failureCause(code)}. Your answer is still here.`,
};

export type QuestionOutcome = "recorded" | "unknown" | "conflict" | "failed";
export class QuestionResponseState {
  readonly send: CommandSend;
  readonly form: QuestionForm;
  readonly revision: number;
  readonly interactionId: string;
  answers: QuestionAnswers;
  errors: Record<string, string> = Object.create(null);
  scrollTop = 0;
  focusId: string | null = null;
  constructor(data: QuestionRead["data"], send = new CommandSend()) {
    if (!data.form) throw Error("Unavailable form");
    this.send = send;
    // The task page checks this answer if its card is not shown.
    send.persistent = true;
    send.matches = (c, r) => this.matches(c, r);
    send.copy = {
      recorded: answerCopy.sent,
      conflict: answerCopy.conflict,
      unknown: answerCopy.unknown,
      failed: answerCopy.failed,
      details: { resource: data.interactionId, version: data.revision },
      review: "Review current request",
    };
    this.form = structuredClone(data.form);
    this.revision = data.revision;
    this.interactionId = data.interactionId;
    this.answers = data.answers
      ? structuredClone(data.answers)
      : Object.fromEntries(
          this.form.questions.map((q) => [
            q.id,
            {
              optionIds:
                q.kind === "free-text" ? [] : [...(q.preselected ?? [])],
              text: q.kind === "free-text" ? (q.preselected ?? "") : "",
            },
          ]),
        );
  }
  validate() {
    this.errors = answerIssues(this.form, this.answers);
    return !Object.keys(this.errors).length;
  }
  matches(command: OperatorCommand, receipt: CommandReceipt) {
    return (
      "taskId" in command &&
      "interactionId" in command &&
      receipt.key === command.key &&
      (receipt.kind === "native-question"
        ? receipt.taskId === command.taskId &&
          receipt.interactionId === command.interactionId
        : receipt.kind === "coordination" &&
          receipt.taskId === command.taskId &&
          receipt.eventType === "question-answer")
    );
  }
  get lifecycle() {
    return this.send.lifecycle;
  }
  get sending() {
    return Boolean(this.send.sending);
  }
  /** How the last submission ended; null until one settles. */
  get outcome(): QuestionOutcome | null {
    return this.send.outcome?.kind ?? null;
  }
  /** The plain message the last settled send left behind; empty while none has. */
  get notice() {
    const sent = this.send.outcome;
    if (!sent || this.sending) return "";
    return sent.kind === "recorded"
      ? answerCopy.sent
      : sent.kind === "unknown"
        ? answerCopy.unknown
        : sent.kind === "conflict"
          ? answerCopy.conflict
          : answerCopy.failed(sent.code ?? "command-outcome-unknown");
  }
  /** The receipt fields behind `notice`, shown only in its collapsed Details. */
  get details(): ReceiptDetails {
    const sent = this.send.outcome,
      receipt = this.lifecycle.receipt;
    if (!sent) return {};
    return {
      command: sent.command.type,
      resource: this.interactionId,
      version: this.revision,
      requestKey: sent.command.key,
      ...(receipt ? { kind: receipt.kind } : {}),
      ...(sent.code ? { code: sent.code } : {}),
    };
  }
  /** Settle the send of `command`; the message and receipt fields follow from its outcome. */
  settle(command: OperatorCommand, result: CommandState) {
    return this.send.settle(command, result, (c, r) => this.matches(c, r));
  }
  setAnswer(id: string, value: QuestionAnswers[string]) {
    if (this.sending || this.lifecycle.uncertain || this.lifecycle.receipt)
      return;
    this.answers = { ...this.answers, [id]: structuredClone(value) };
    delete this.errors[id];
  }
}
export class QuestionResponseStates {
  private states = new Map<string, QuestionResponseState>();
  private listeners = new Set<() => void>();
  /** Each answer's send lives in the session registry, so the task page can check it too. */
  constructor(private readonly sends = new CommandSends()) {}
  forQuestion(data: QuestionRead["data"]) {
    const key = `${data.taskId}:${data.interactionId}`;
    let state = this.states.get(key);
    if (!state) {
      state = new QuestionResponseState(
        data,
        this.sends.entry(`${data.taskId}:question:${data.interactionId}`),
      );
      this.states.set(key, state);
    }
    return state;
  }
  /** True once this session recorded the answer (not when another session did). */
  recordedHere(taskId: string, interactionId: string) {
    return (
      this.states.get(`${taskId}:${interactionId}`)?.outcome === "recorded"
    );
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    const stop = this.sends.subscribe(listener);
    return () => {
      this.listeners.delete(listener);
      stop();
    };
  }
  changed() {
    for (const listener of this.listeners) listener();
  }
  purge() {
    this.states.clear();
    this.changed();
  }
}
