import { pathToFileURL } from "node:url";

export function ciFailures(jobs, run = true) {
  const result = run ? "success" : "skipped";
  const expected = {
    changes: "success",
    quality: result,
    suites: result,
    service: result,
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
  if (!["true", "false"].includes(process.env.RUN_CHECKS))
    throw Error("RUN_CHECKS must be true or false");
  if (
    process.env.RUN_CHECKS === "false" &&
    !["schedule", "pull_request"].includes(process.env.GITHUB_EVENT_NAME)
  )
    throw Error("Only scheduled and pull request checks can be skipped");
  const failures = ciFailures(
    JSON.parse(process.env.RESULTS ?? "null"),
    process.env.RUN_CHECKS === "true",
  );
  for (const failure of failures) console.error(failure);
  if (failures.length) process.exitCode = 1;
}
