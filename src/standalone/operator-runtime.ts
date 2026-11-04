import type { StandaloneService } from "./service.js";
import type { RecoveryRecord } from "./recovery-types.js";

/** The turn request, recovery record and execution intent that describe an assignment's current execution. */
export function selectAssignmentExecution(
  assignment: { id?: unknown; version?: unknown },
  api: Pick<
    StandaloneService,
    "currentTurnRequest" | "recoveryFor" | "executionForWork"
  >,
) {
  const id = String(assignment.id);
  const request = api.currentTurnRequest(id, Number(assignment.version));
  const requestVersion =
    request?.assignmentVersion ?? Number(assignment.version);
  const record = request
    ? api.recoveryFor(id, requestVersion, request.workId)[0]
    : api
        .recoveryFor(id, requestVersion)
        .reduce<RecoveryRecord | undefined>(
          (latest, candidate) =>
            !latest ||
            candidate.generation.requestSequence >
              latest.generation.requestSequence
              ? candidate
              : latest,
          undefined,
        );
  const intent = request ? api.executionForWork(request.workId) : undefined;
  return { request, record, intent };
}
