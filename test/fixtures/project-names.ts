import { projectNameKey } from "../../src/core/project-names.js";
import type { DomainStore } from "../../src/core/domain.js";

/** Project names are unique by their name key, so a repeated fixture name gets a counter. */
export function uniqueProjectName(domain: DomainStore, name: string) {
  const taken = new Set(
    domain.projects().map((p) => projectNameKey(String(p.name))),
  );
  let unique = name;
  for (let n = 2; taken.has(projectNameKey(unique)); n++)
    unique = `${name} ${n}`;
  return unique;
}
