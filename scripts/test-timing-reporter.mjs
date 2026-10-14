import { timingInputDigest, timingRecord } from "./test-timings.mjs";

export default async function* timingReporter(source) {
  const metadata = {
    profile: process.env.ENSEMBLE_TEST_PROFILE,
    nodeVersion: process.version,
    inputDigest: timingInputDigest(),
  };
  for await (const event of source) {
    const record = timingRecord(event, metadata);
    if (record) yield `${JSON.stringify(record)}\n`;
  }
}
