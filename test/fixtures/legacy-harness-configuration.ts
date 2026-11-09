import type { DatabaseSync } from "node:sqlite";
import type { DomainCommand, DomainStore } from "../../src/core/domain.js";
import { profileSkillsSchema } from "../../src/core/execution-runtime.js";

import type { DomainCommandResultMap } from "../../src/core/command-results.js";

/** Seeds pre-native settings for upgrade/security fixtures; new writes use DomainStore.execute. */
export function seedLegacyCommand<C extends DomainCommand>(
  domain: DomainStore,
  command: C,
): DomainCommandResultMap[C["type"]];
export function seedLegacyCommand(
  domain: DomainStore,
  command: DomainCommand,
): ReturnType<DomainStore["execute"]> {
  const db = (domain as unknown as { db: DatabaseSync }).db;
  if (command.type === "claude-token.configure") {
    db.prepare(
      "UPDATE claude_runtime_credentials SET credentialRef=? WHERE singleton=1",
    ).run(command.credentialRef);
    return { configured: command.credentialRef !== null };
  }
  if (
    (command.type === "profile.create" ||
      command.type === "profile.configure") &&
    command.skills !== undefined
  ) {
    const { skills, ...active } = command;
    const json = JSON.stringify(profileSkillsSchema.parse(skills));
    const result = domain.execute(active);
    db.prepare("UPDATE profiles SET skills=? WHERE id=?").run(
      json,
      command.profileId,
    );
    db.prepare(
      "UPDATE profile_revisions SET skills=? WHERE profileId=? AND revision=(SELECT version FROM profiles WHERE id=?)",
    ).run(json, command.profileId, command.profileId);
    return result;
  }
  return domain.execute(command);
}
