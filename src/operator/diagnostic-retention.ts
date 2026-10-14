/** Dependency-free so the LaunchAgent renderer and the service share one definition. */
export const diagnosticRetentionDays = {
  name: "ENSEMBLE_DIAGNOSTIC_RETENTION_DAYS",
  min: 1,
  max: 365,
  fallback: 30,
} as const;

export const diagnosticStorageMib = {
  name: "ENSEMBLE_DIAGNOSTIC_STORAGE_MIB",
  min: 16,
  max: 1048576,
  fallback: 1024,
} as const;

type Bound = { name: string; min: number; max: number; fallback: number };

export function isInBound(value: unknown, bound: Bound): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= bound.min &&
    value <= bound.max
  );
}

export function integerFromEnv(
  env: NodeJS.ProcessEnv,
  { name, min, max, fallback }: Bound,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d{1,10}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= min && value <= max))
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
