/**
 * Removes the named variables and every variable holding their nonempty values in either
 * environment, or holding one of `excludedValues`.
 */
export function credentialFreeEnvironment(
  environment: NodeJS.ProcessEnv,
  keys: readonly string[],
  current: NodeJS.ProcessEnv = environment,
  excludedValues: readonly string[] = [],
): NodeJS.ProcessEnv {
  const result = { ...environment };
  const values = new Set(
    [
      ...keys.flatMap((k) => [environment[k], current[k]]),
      ...excludedValues,
    ].filter((v): v is string => Boolean(v)),
  );
  for (const key of Object.keys(result)) {
    const value = result[key];
    if (keys.includes(key) || (value !== undefined && values.has(value)))
      delete result[key];
  }
  return result;
}

interface CredentialExclusions {
  names: readonly string[];
  values: readonly string[];
}
let excluded: () => CredentialExclusions = () => ({ names: [], values: [] });
let lastExcluded: CredentialExclusions = { names: [], values: [] };

/** The running service's credentials (by name or value) no helper child process may inherit. */
export function setChildCredentialExclusions(
  exclusions: () => CredentialExclusions,
): void {
  excluded = exclusions;
}

/** Environment for non-runtime children (git, ps, pmset, …): the service's excluded credentials removed. */
export function childProcessEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  try {
    lastExcluded = excluded();
  } catch {
    // A closed store keeps the last known exclusions rather than none.
  }
  return credentialFreeEnvironment(
    base,
    lastExcluded.names,
    process.env,
    lastExcluded.values,
  );
}

/** Environment for every Git child: no inherited `GIT_*`, no prompts, lazy fetches or transports. */
export function gitEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = childProcessEnvironment(base);
  for (const key of Object.keys(environment))
    if (key.startsWith("GIT_")) delete environment[key];
  environment.GIT_ALLOW_PROTOCOL = "";
  environment.GIT_NO_LAZY_FETCH = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}
