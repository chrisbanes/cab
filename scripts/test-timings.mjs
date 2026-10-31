import { relative, resolve } from "node:path";

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

export function measuredProfile(records, files, existing, profile, nodeMajor) {
  const measured = {};
  for (const record of records) {
    if (
      record.profile !== profile ||
      Number(record.nodeVersion.split(".")[0].slice(1)) !== nodeMajor
    )
      continue;
    // Unsuccessful or invalid receipts keep the file's previous weight.
    if (
      record.passed !== true ||
      !Number.isFinite(record.milliseconds) ||
      record.milliseconds < 0
    )
      continue;
    if (Object.hasOwn(measured, record.file))
      throw Error(`Duplicate timing receipt: ${record.file}`);
    measured[record.file] = record.milliseconds;
  }
  const previous = existing?.milliseconds ?? {};
  const milliseconds = {};
  for (const file of [...files].sort())
    if (Object.hasOwn(measured, file)) milliseconds[file] = measured[file];
    else if (Object.hasOwn(previous, file)) milliseconds[file] = previous[file];
  return {
    measurement:
      "Node outer file test:complete duration, including startup and imports",
    nodeMajor,
    milliseconds,
  };
}
