import type {
  DomainCommandOutcome,
  DomainCommandResultMap,
} from "../src/core/command-results.js";
import type { DomainCommand } from "../src/core/domain.js";

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
