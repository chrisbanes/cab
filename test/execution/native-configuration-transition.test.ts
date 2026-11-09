import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { coordinationFixture } from "../fixtures/coordination.js";

const profileId = "30000000-0000-4000-8000-000000000002";
const legacySkills = {
  plugins: [{ path: "/legacy/plugin", skills: ["old"] }],
  global: ["legacy"],
};
const tokenCommand = {
  type: "claude-token.configure",
  actor: "operator",
  key: "60000000-0000-4000-8000-000000000001",
  credentialRef: "env:LEGACY_CLAUDE_TOKEN",
} as const;
const profileCommand = {
  type: "profile.configure",
  actor: "operator",
  key: "60000000-0000-4000-8000-000000000002",
  profileId,
  expectedVersion: 1,
  skills: legacySkills,
} as const;

test("native transition preserves legacy revisions, exact receipts and unresolved ownership while refusing fresh retired writes", () => {
  const f = coordinationFixture();
  try {
    const prior = f.domain.profile(profileId);
    f.db
      .prepare("UPDATE profiles SET version=2,skills=? WHERE id=?")
      .run(JSON.stringify(legacySkills), profileId);
    f.db
      .prepare(
        "INSERT INTO profile_revisions SELECT profileId,2,name,instructions,capabilities,revoked,runtime,? FROM profile_revisions WHERE profileId=? AND revision=1",
      )
      .run(JSON.stringify(legacySkills), profileId);
    f.db
      .prepare(
        "UPDATE claude_runtime_credentials SET credentialRef=? WHERE singleton=1",
      )
      .run(tokenCommand.credentialRef);
    const receipt = {
      id: profileId,
      version: 2,
      name: prior.name,
      summary: prior.summary,
      instructions: prior.instructions,
      capabilities: prior.capabilities,
      revoked: prior.revoked,
    };
    // Digests from pre-native command fixtures, independent of today's write path.
    const insert = f.db.prepare(
      "INSERT INTO command_receipts(scope,key,payloadHash,result) VALUES(?,?,?,?)",
    );
    insert.run(
      "system:claude-token",
      tokenCommand.key,
      "a4ee43c8a020b0e53db4c0bc9223babbbfbfbc7b6c3f07c728e2438fbfcbdea8",
      JSON.stringify({ configured: true }),
    );
    insert.run(
      `profile:${profileId}`,
      profileCommand.key,
      "67824b113d751452595c92736801ac948de3847430aa53351cdfd37ac14cdabb",
      JSON.stringify(receipt),
    );
    const holds = f.db.prepare("SELECT * FROM execution_intents").all();
    const pending = f.db
      .prepare("SELECT * FROM execution_pending_effects")
      .all();
    f.reopen();
    assert.deepEqual(f.domain.profileSkills(profileId, 2), legacySkills);
    assert.equal(f.domain.claudeTokenReference(), tokenCommand.credentialRef);
    assert.deepEqual(f.domain.execute(tokenCommand), { configured: true });
    assert.deepEqual(f.domain.execute(profileCommand), receipt);
    for (const command of [tokenCommand, profileCommand])
      assert.throws(
        () => f.domain.execute({ ...command, key: randomUUID() }),
        /native setup/,
      );
    f.domain.execute({
      type: "profile.configure",
      actor: "operator",
      key: randomUUID(),
      profileId,
      expectedVersion: 2,
      name: "Native worker",
    });
    assert.deepEqual(f.domain.profileSkills(profileId, 2), legacySkills);
    assert.deepEqual(f.domain.profileSkills(profileId, 3), legacySkills);
    assert.deepEqual(
      f.db.prepare("SELECT * FROM execution_intents").all(),
      holds,
    );
    assert.deepEqual(
      f.db.prepare("SELECT * FROM execution_pending_effects").all(),
      pending,
    );
  } finally {
    f.close();
  }
});
