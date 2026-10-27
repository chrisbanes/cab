/** The installation-wide bound on the private values redaction excludes; reaching it fails closed with a named reason. */
export const redactionExclusionLimits = {
  values: 4096,
  bytes: 16 * 1024 * 1024,
  valueBytes: 64 * 1024,
} as const;

export class RedactionLimitError extends Error {
  constructor() {
    super("Redaction exclusion limit exceeded");
  }
}

/** True when the distinct values fit the count and total UTF-8 size bounds. */
export function withinRedactionLimits(values: readonly string[]): boolean {
  const distinct = new Set(values);
  if (distinct.size > redactionExclusionLimits.values) return false;
  let bytes = 0;
  for (const value of distinct) {
    bytes += Buffer.byteLength(value);
    if (bytes > redactionExclusionLimits.bytes) return false;
  }
  return true;
}
