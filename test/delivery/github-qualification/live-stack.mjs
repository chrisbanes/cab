// Source composition only. Import and an invocation without --live are inert.
// No real host/service/runtime adapter is installed by this entrypoint.
import { open, lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const refusal =
  "Refusing execution: require --live --manifest ABS --grant ABS --readiness ABS --result ABS; no real adapter is installed";
export function stackArguments(args) {
  if (args.length !== 9 || args[0] !== "--live") throw Error(refusal);
  const values = {};
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i],
      path = args[i + 1];
    if (
      !["--manifest", "--grant", "--readiness", "--result"].includes(flag) ||
      values[flag] ||
      !path ||
      !isAbsolute(path)
    )
      throw Error(refusal);
    values[flag] = resolve(path);
  }
  if (
    Object.keys(values).length !== 4 ||
    new Set(Object.values(values)).size !== 4
  )
    throw Error(refusal);
  const result = values["--result"];
  if (
    Object.entries(values).some(
      ([flag, path]) =>
        flag !== "--result" &&
        [
          result,
          `${result}.lock`,
          `${result}.tmp`,
          `${result}.provider`,
          `${result}.provider.lock`,
          `${result}.provider.tmp`,
        ].includes(path),
    )
  )
    throw Error(refusal);
  return values;
}
async function readInput(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144)
    throw Error("Unsafe or oversized composition input");
  const file = await open(path, "r");
  try {
    const actual = await file.stat();
    if (
      actual.dev !== stat.dev ||
      actual.ino !== stat.ino ||
      actual.size > 262144
    )
      throw Error("Composition input changed");
    const raw = await file.readFile("utf8");
    if (Buffer.byteLength(raw) > 262144)
      throw Error("Composition input bound exceeded");
    return raw;
  } finally {
    await file.close();
  }
}
/** Dependency injection is for deterministic offline qualification, not a new source of authority. */
export async function main(args, injected) {
  const paths = stackArguments(args);
  const manifest = await readInput(paths["--manifest"]);
  const grant = JSON.parse(await readInput(paths["--grant"]));
  const readiness = await readInput(paths["--readiness"]);
  const module = await import(
    "../../../dist/test/delivery/github-qualification/stack-journey.js"
  );
  module.authorizeStackComposition(manifest, grant, readiness, injected?.now);
  // Even valid provider authority cannot authorize missing lifecycle/identity/bootstrap adapters.
  if (!injected?.factory)
    throw Error(
      "Unsupported real stack adapter: explicit service/runtime/identity-read authority contract required",
    );
  const result = await module.runStackComposition({
    manifest,
    grant,
    readiness,
    resultPath: paths["--result"],
    factory: injected.factory,
    ...(injected.now ? { now: injected.now } : {}),
  });
  // Secret-free bounded projection only. A synthetic run is never reported as live acceptance.
  return {
    mode: result.mode,
    disposition: result.disposition,
    runId: result.runId,
    manifestSha256: result.manifestSha256,
    stage: result.stage,
    writes: result.writes,
    turns: result.turns,
    reads: result.reads,
    platformRebase: result.platformRebase,
    adoption: result.adoption,
    cleanup: result.cleanup,
  };
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const result = await main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.disposition === "recorded" ? 0 : 1;
  } catch {
    // No arbitrary provider/credential error text is printed.
    process.stderr.write(`${refusal}\n`);
    process.exitCode = 1;
  }
}
