import { createHash } from "node:crypto";
import { globSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

export function timingInputDigest() {
  const files = [
    ...globSync("{src,test,web,scripts}/**/*").filter(
      (file) =>
        statSync(file).isFile() &&
        file !== "scripts/test-timings.json" &&
        !file.includes("/__pycache__/") &&
        !file.endsWith(".pyc"),
    ),
    ".node-version",
    "package-lock.json",
    "package.json",
    "tsconfig.json",
  ].sort();
  const hash = createHash("sha256");
  for (const file of files)
    hash.update(file).update("\0").update(readFileSync(file)).update("\0");
  return hash.digest("hex");
}

export function profileTimings(document, profile) {
  const weights = document.profiles?.[profile]?.milliseconds;
  if (!weights || typeof weights !== "object" || Array.isArray(weights))
    throw Error(`No timing weights for profile ${profile}`);
  return weights;
}

export function timingRecord(event, metadata) {
  const data = event.data;
  if (
    event.type !== "test:complete" ||
    data.nesting !== 0 ||
    data.entryFile ||
    resolve(data.name) !== resolve(data.file)
  )
    return null;
  const file = relative(resolve("dist"), resolve(data.file)).replaceAll(
    "\\",
    "/",
  );
  if (!file.startsWith("test/") || !file.endsWith(".test.js")) return null;
  if (
    !Number.isFinite(data.details.duration_ms) ||
    data.details.duration_ms < 0
  )
    throw Error("Invalid file timing");
  return {
    ...metadata,
    file: file.replace(/\.js$/, ".ts"),
    milliseconds: Math.ceil(data.details.duration_ms),
    passed: data.details.passed === true,
  };
}

export function measuredProfile(
  records,
  files,
  profile,
  nodeMajor,
  inputDigest,
) {
  const selected = records.filter(
    (record) =>
      record.profile === profile &&
      Number(record.nodeVersion.split(".")[0].slice(1)) === nodeMajor,
  );
  const milliseconds = {};
  for (const record of selected) {
    if (
      record.passed !== true ||
      record.inputDigest !== inputDigest ||
      !Number.isFinite(record.milliseconds) ||
      record.milliseconds < 0
    )
      throw Error(`Unsuccessful or stale timing receipt: ${record.file}`);
    if (Object.hasOwn(milliseconds, record.file))
      throw Error(`Duplicate timing receipt: ${record.file}`);
    milliseconds[record.file] = record.milliseconds;
  }
  if (
    JSON.stringify(Object.keys(milliseconds).sort()) !==
    JSON.stringify([...files].sort())
  )
    throw Error(
      "Timing receipts must cover the complete current source inventory",
    );
  return {
    measurement:
      "Node outer file test:complete duration, including startup and imports",
    nodeMajor,
    inputDigest,
    milliseconds: Object.fromEntries(
      Object.entries(milliseconds).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    ),
  };
}
