import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import type { AdoptOutcome } from "../../src/standalone/git-fetch.js";
import type { PushOutcome } from "../../src/standalone/git-push.js";
import { publicationWorld } from "./delivery-integration.js";
import { scriptedGitLabRemote } from "./gitlab-remote.js";

export const host = "gitlab.example.com";
export const projectPath = "group/sub/app";
export const repositoryId = "42";
const credentialVariable = "CAB_TEST_GITLAB_DELIVERY_TOKEN";
export const token = "glpat-synthetic-journey-token";

/** A task whose checkout is linked to a GitLab project that a scripted instance stands in for. */
export async function gitlabWorld(
  t: { after: (cleanup: () => void) => void },
  mode: "allow" | "approval" = "allow",
  options: { credential?: boolean } = {},
) {
  const remote = scriptedGitLabRemote({ repositoryId });
  remote.state.project = { id: 42, path_with_namespace: projectPath };
  const pushes: Array<Record<string, unknown>> = [];
  const adopts: Array<Record<string, unknown>> = [];
  const script = {
    push: "pushed" as PushOutcome,
    adopt: "adopted" as AdoptOutcome,
  };
  const prior = process.env[credentialVariable];
  process.env[credentialVariable] = token;
  t.after(() => {
    if (prior === undefined) delete process.env[credentialVariable];
    else process.env[credentialVariable] = prior;
  });
  const world = await publicationWorld(mode, {
    host,
    repositoryId,
    projectPath,
    origin: `https://${host}/${projectPath}.git`,
    delivery: {
      fetcher: remote.fetcher,
      push: async (request) => {
        pushes.push({ ...request });
        if (script.push === "pushed") remote.state.head = request.commitSha;
        return script.push;
      },
      adopt: async (request) => {
        adopts.push({ ...request });
        return script.adopt;
      },
    },
  });
  if (options.credential !== false)
    world.f.service.domain().execute({
      type: "code-host-credential.configure",
      actor: "operator",
      key: randomUUID(),
      codeHost: "gitlab",
      host,
      credentialRef: `env:${credentialVariable}`,
    });
  // GitLab reports one head pipeline, named `pipeline`, for the merge request.
  const delivery = world.f.service.delivery();
  world.f.service.domain().execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: world.f.projectId,
    expectedVersion: delivery.configuration(world.f.projectId).version,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: delivery.configuration(world.f.projectId).grants,
    requiredChecks: [{ name: "pipeline" }],
  });
  return { ...world, remote, pushes, adopts, script };
}

export const branchOf = (w: Awaited<ReturnType<typeof gitlabWorld>>) =>
  w.f.service.delivery().taskBranch(w.f.taskId, repositoryId);

/** Nothing the service shows or stores carries the token. */
export function assertNoToken(w: Awaited<ReturnType<typeof gitlabWorld>>) {
  const actions = w.f.service.delivery().actions(w.f.taskId);
  assert.equal(JSON.stringify(actions).includes(token), false);
  assert.equal(JSON.stringify(branchOf(w)).includes(token), false);
}
