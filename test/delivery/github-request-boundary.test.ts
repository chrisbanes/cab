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

test("fixture redirects cannot trigger a second transport or credential lookup", async () => {
  let lookups = 0,
    dispatches = 0;
  const provider = new GitHubHttpDeliveryProvider(
    async () => {
      lookups++;
      return "offline-marker";
    },
    async () => {
      dispatches++;
      return new Response(null, {
        status: 302,
        headers: { location: "https://api.github.com/unlisted" },
      });
    },
    undefined,
    undefined,
    "github.com",
    {
      beforeCredential: allowed,
      beforeCredentialLookup: allowed,
      beforeDispatch: allowed,
    },
  );
  await assert.rejects(
    provider.readFixtureIdentity("OFFLINE_REPOSITORY"),
    /fixture-provider-redirect/,
  );
  assert.equal(lookups, 1);
  assert.equal(dispatches, 1);
});

test("closure after dispatch records the invoked transport and releases no later provider read", async () => {
  let lookups = 0,
    dispatches = 0,
    closed = false;
  let release!: (response: Response) => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const response = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const provider = new GitHubHttpDeliveryProvider(
    async () => {
      lookups++;
      return "offline-marker";
    },
    async () => {
      dispatches++;
      entered();
      return response;
    },
    undefined,
    undefined,
    "github.com",
    {
      assertCurrent: () => {
        if (closed) throw Error("offline-closed");
      },
      beforeCredential: allowed,
      beforeCredentialLookup: allowed,
      beforeDispatch: allowed,
      afterResponse: async () => {
        if (closed) throw Error("offline-closed");
      },
    },
  );
  const pending = provider.readFixtureIdentity("OFFLINE_REPOSITORY");
  void pending.catch(() => {});
  await started;
  closed = true;
  release(Response.json({ node_id: "OFFLINE_ACTOR", login: "offline" }));
  await assert.rejects(pending, /offline-closed/);
  assert.equal(lookups, 1);
  assert.equal(dispatches, 1);
});
