import type {
  DomainCommandOutcome,
  DomainCommandResultMap,
} from "../src/core/command-results.js";
import type {
  DomainCommand,
  DomainCommands,
  DomainStore,
} from "../src/core/domain.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
type EveryCommandHasAResult = Assert<
  Equal<keyof DomainCommandResultMap, DomainCommand["type"]>
>;
type _MapHasExactlyEveryCommand = EveryCommandHasAResult;

declare const taskResult: DomainCommandResultMap["task.configure"];
declare const projectResult: DomainCommandResultMap["project.configure"];
const correlated: DomainCommandOutcome = {
  type: "task.configure",
  result: taskResult,
};
void correlated;

// @ts-expect-error A task command cannot carry a project result.
const mismatched: DomainCommandOutcome = {
  type: "task.configure",
  result: projectResult,
};
void mismatched;

declare const store: DomainStore;
declare const commands: DomainCommands;
declare const taskCommand: Extract<DomainCommand, { type: "task.configure" }>;
const synchronousTask = store.execute(taskCommand);
const taskState: "open" | "done" | "cancelled" = synchronousTask.state;
void taskState;
// @ts-expect-error A task command's synchronous result is not a project result.
const synchronousProject: DomainCommandResultMap["project.configure"] =
  synchronousTask;
void synchronousProject;

const replayedTask = store.recordedCommand(taskCommand);
if (replayedTask !== undefined) {
  const replayedState: "open" | "done" | "cancelled" = replayedTask.state;
  void replayedState;
  // @ts-expect-error A replayed task result has no project instructions.
  replayedTask.instructions;
}

const typedReceipt = store.recordedResult("scope", "key", "task.configure");
if (typedReceipt !== undefined) {
  const receiptType: "task.configure" = typedReceipt.type;
  const receiptState: "open" | "done" | "cancelled" = typedReceipt.result.state;
  void [receiptType, receiptState];
}

async function asynchronousCorrelation() {
  const result = await commands.execute(taskCommand);
  const state: "open" | "done" | "cancelled" = result.state;
  void state;
  // @ts-expect-error An in-flight task result cannot be assigned to a project result.
  const project: DomainCommandResultMap["project.configure"] = result;
  void project;
}
void asynchronousCorrelation;

function exhaustive(outcome: DomainCommandOutcome): string {
  switch (outcome.type) {
    case "delivery.configure":
    case "project.create":
    case "project.configure":
    case "task.create":
    case "task.configure":
    case "profile.create":
    case "profile.configure":
    case "routing.configure":
    case "github.configure":
    case "github.activate":
    case "github.place":
    case "source.review":
    case "assignment.create":
    case "assignment.apply":
    case "dependency.add":
    case "dependency.remove":
    case "imported-blockers.set":
    case "capacity.configure":
    case "discovery.configure":
      return outcome.type;
    default: {
      // @ts-expect-error Omitting claude-token.configure must break exhaustiveness.
      const missingVariant: never = outcome;
      return missingVariant;
    }
  }
}
void exhaustive;
