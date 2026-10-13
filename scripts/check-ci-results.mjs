import { pathToFileURL } from "node:url";

export function ciFailures(jobs, full) {
  const expected = {
    quality: "success",
    suites: "success",
    "service-node26": full ? "skipped" : "success",
    "compatibility-node26": full ? "success" : "skipped",
  };
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs))
    return ["CI needs must be an object"];
  const failures = Object.keys(jobs)
    .filter((name) => !Object.hasOwn(expected, name))
    .map((name) => `Unexpected aggregate dependency: ${name}`);
  for (const [name, result] of Object.entries(expected))
    if (jobs[name]?.result !== result)
      failures.push(
        `${name}: expected ${result}, observed ${jobs[name]?.result ?? "missing"}`,
      );
  return failures;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!["true", "false"].includes(process.env.FULL_COMPATIBILITY))
    throw Error("FULL_COMPATIBILITY must be true or false");
  const failures = ciFailures(
    JSON.parse(process.env.RESULTS ?? "null"),
    process.env.FULL_COMPATIBILITY === "true",
  );
  for (const failure of failures) console.error(failure);
  if (failures.length) process.exitCode = 1;
}
