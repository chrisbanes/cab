import { randomUUID } from "node:crypto";
import { ConversationHistoryStore } from "../../src/standalone/conversation-history.js";
import type { createOperatorFixture } from "./operator-web.js";

export const instructionSecret = "routing-synthetic-value-895";
const credentialEnv = "CLI2_SYNTHETIC_ROUTING";

/**
 * One shared profile P (revisions 1→3) and projects A (1→2) and B (1). A's lead is bound
 * to revision 1/1 before the changes; B's lead is created after them. Later revisions
 * mix shareable text with a control path, a credential value and a token pattern.
 */
export async function seedInstructionHistory(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  controlPath = f.directory,
) {
  const d = f.service.domain(),
    profileId = randomUUID(),
    projectA = randomUUID(),
    projectB = randomUUID(),
    taskA = randomUUID(),
    taskB = randomUUID();
  process.env[credentialEnv] = instructionSecret;
  const private_ = `${controlPath}/notes ${instructionSecret} env:${credentialEnv} token=hunter2`;
  const text = {
    profile: [
      "Profile revision one guidance",
      "Profile revision two guidance",
      `Profile revision three guidance ${private_}`,
    ],
    project: ["Project A revision one", `Project A revision two ${private_}`],
  };
  const run = (command: Record<string, unknown>) =>
    d.execute({ actor: "operator", key: randomUUID(), ...command } as never);
  run({
    type: "profile.create",
    profileId,
    name: "Shared lead",
    instructions: text.profile[0],
    capabilities: "coordinate",
  });
  run({
    type: "project.create",
    projectId: projectA,
    name: "Alpha",
    leadProfileId: profileId,
    instructions: text.project[0],
  });
  run({
    type: "routing.configure",
    projectId: projectA,
    expectedVersion: Number(d.routing(projectA).version),
    enabled: false,
    credentialRef: `env:${credentialEnv}`,
    candidateProfileIds: [],
  });
  run({
    type: "task.create",
    projectId: projectA,
    taskId: taskA,
    title: "Stale lead",
    outcome: `Restate: ${text.profile[0]}`,
    ready: false,
  });
  const leadA = d.ensureLeadAssignment(taskA);
  if (!leadA) throw Error("Fixture lead absent");
  for (const instructions of text.profile.slice(1))
    run({
      type: "profile.configure",
      profileId,
      expectedVersion: Number(d.profile(profileId).version),
      instructions,
    });
  run({
    type: "project.configure",
    projectId: projectA,
    expectedVersion: Number(d.project(projectA).version),
    instructions: text.project[1],
  });
  run({
    type: "project.create",
    projectId: projectB,
    name: "Beta",
    leadProfileId: profileId,
    instructions: "Project B only",
  });
  run({
    type: "task.create",
    projectId: projectB,
    taskId: taskB,
    title: "Current lead",
    outcome: "Current",
    ready: false,
  });
  const leadB = d.ensureLeadAssignment(taskB);
  if (!leadB) throw Error("Fixture lead absent");
  const assignmentA = String(leadA.id),
    workId = randomUUID();
  f.seedPersistedState((db) =>
    new ConversationHistoryStore(db).record(
      {
        workId,
        taskId: taskA,
        assignmentId: assignmentA,
        assignmentVersion: Number(leadA.version),
        instructionsRevision: 1,
        profileRevision: 1,
        conversationRevision: 1,
        workRevision: 1,
        threadId: workId,
        turnId: workId,
      },
      {
        kind: "completed",
        threadId: workId,
        turnId: workId,
        itemId: "echo",
        text: `I read: ${text.profile[0]}`,
      },
      [],
    ),
  );
  return {
    profileId,
    projectA,
    projectB,
    taskA,
    taskB,
    assignmentA,
    assignmentB: String(leadB.id),
    text,
    cleanup: () => {
      delete process.env[credentialEnv];
    },
  };
}
