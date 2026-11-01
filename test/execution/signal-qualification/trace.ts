import { appendFileSync, readFileSync, statSync } from "node:fs";

export interface Event {
  event: string;
  pid: number;
  at: string;
  detail: unknown;
}
export function record(file: string, event: string, detail: unknown = null) {
  if (statSync(file).size > 1024 * 1024)
    throw new Error("Trace bound exceeded");
  appendFileSync(
    file,
    `${JSON.stringify({ event, pid: process.pid, at: new Date().toISOString(), detail })}\n`,
  );
}
export function events(file: string): Event[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Event);
}
export async function until(
  predicate: () => boolean,
  label: string,
  ms = 10000,
) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Calibration failed: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
