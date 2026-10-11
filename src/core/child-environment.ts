/** Removes the named variables and every variable holding their nonempty values in either environment. */
export function credentialFreeEnvironment(
  environment: NodeJS.ProcessEnv,
  keys: readonly string[],
  current: NodeJS.ProcessEnv = environment,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  const values = new Set(
    keys
      .flatMap((k) => [environment[k], current[k]])
      .filter((v): v is string => Boolean(v)),
  );
  for (const key of Object.keys(result)) {
    const value = result[key];
    if (keys.includes(key) || (value !== undefined && values.has(value)))
      delete result[key];
  }
  return result;
}

let excludedNames: () => readonly string[] = () => [];
let lastExcluded: readonly string[] = [];

/** The running service names credentials no helper child process may inherit. */
export function setChildCredentialExclusions(
  names: () => readonly string[],
): void {
  excludedNames = names;
}

/** Environment for non-runtime children (git, ps, pmset, …): the service's excluded credentials removed. */
export function childProcessEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  try {
    lastExcluded = excludedNames();
  } catch {
    // A closed store keeps the last known exclusions rather than none.
  }
  return credentialFreeEnvironment(base, lastExcluded, process.env);
}
