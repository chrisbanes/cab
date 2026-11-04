import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubHttpDeliveryProvider,
  type GitHubDeliveryRequestBoundary,
} from "../../src/standalone/github-delivery.js";

function fixture(boundary: GitHubDeliveryRequestBoundary) {
  let lookups = 0;
  let dispatches = 0;
  const provider = new GitHubHttpDeliveryProvider(
    async () => {
      lookups++;
      return "offline-marker";
    },
    async () => {
      dispatches++;
      throw Error("offline-transport-stop");
    },
    undefined,
    undefined,
    "github.com",
    boundary,
  );
  return { provider, counts: () => ({ lookups, dispatches }) };
}
const allowed = async () => {};

test("unexpected HTTP request refuses before credential lookup", async () => {
  const f = fixture({
    beforeCredential: async (request) => {
      assert.equal(request.url, "https://api.github.com/graphql");
      assert.equal(request.method, "POST");
      assert.equal(request.version, "2022-11-28");
      assert.deepEqual(JSON.parse(request.body).variables, { id: "R1" });
      assert.ok(Object.isFrozen(request));
      throw Error("unlisted-request");
    },
    beforeCredentialLookup: allowed,
    beforeDispatch: allowed,
  });
  await assert.rejects(
    f.provider.readRebaseHead("R1", "upper"),
    /unlisted-request/,
  );
  assert.deepEqual(f.counts(), { lookups: 0, dispatches: 0 });
});

test("credential allowance failure cannot reach credential resolver", async () => {
  const f = fixture({
    beforeCredential: allowed,
    beforeCredentialLookup: async () => {
      throw Error("lookup-budget");
    },
    beforeDispatch: allowed,
  });
  await assert.rejects(f.provider.readRebaseHead("R1", "upper"));
  assert.deepEqual(f.counts(), { lookups: 0, dispatches: 0 });
});

test("post-credential authority failure refuses actual dispatch", async () => {
  const order: string[] = [];
  const f = fixture({
    beforeCredential: async () => {
      order.push("request");
    },
    beforeCredentialLookup: async () => {
      order.push("lookup");
    },
    beforeDispatch: async () => {
      order.push("dispatch");
      throw Error("expired");
    },
  });
  await assert.rejects(f.provider.readRebaseHead("R1", "upper"), /expired/);
  assert.deepEqual(order, ["request", "lookup", "dispatch"]);
  assert.deepEqual(f.counts(), { lookups: 1, dispatches: 0 });
});

test("cached credential does not bypass a newly closed request boundary", async () => {
  let open = true;
  const f = fixture({
    beforeCredential: async () => {
      if (!open) throw Error("closed");
    },
    beforeCredentialLookup: allowed,
    beforeDispatch: allowed,
  });
  await assert.rejects(
    f.provider.readRebaseHead("R1", "upper"),
    /offline-transport-stop/,
  );
  open = false;
  await assert.rejects(f.provider.readRebaseHead("R1", "upper"), /closed/);
  assert.deepEqual(f.counts(), { lookups: 1, dispatches: 1 });
});
