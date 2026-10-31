import { globSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { measuredProfile } from "./test-timings.mjs";

const [profile, major, root, ...extra] = process.argv.slice(2);
if (
  !["all", "chromium", "service"].includes(profile) ||
  !/^\d+$/.test(major ?? "") ||
  !root ||
  extra.length
)
  throw Error(
    "Usage: node scripts/update-test-timings.mjs <all|chromium|service> <node-major> <evidence-root>",
  );
const records = globSync("**/file-timings.ndjson", { cwd: root }).flatMap(
  (file) =>
    readFileSync(resolve(root, file), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
);
const files = globSync("test/**/*.test.ts");
const path = new URL("./test-timings.json", import.meta.url);
const document = JSON.parse(readFileSync(path, "utf8"));
document.profiles[profile] = measuredProfile(
  records,
  files,
  document.profiles[profile],
  profile,
  Number(major),
);
writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
console.log(
  `Updated ${profile} timings for ${files.length} files on Node ${major}`,
);
