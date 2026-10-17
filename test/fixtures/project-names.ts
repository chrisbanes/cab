import type { DomainStore } from "../../src/core/domain.js";

/** Project names are unique ignoring case, so a repeated fixture name gets a counter. */
export function uniqueProjectName(domain: DomainStore, name: string) {
  const taken = new Set(
    domain.projects().map((p) => String(p.name).toLowerCase()),
  );
  let unique = name;
  for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = `${name} ${n}`;
  return unique;
}
