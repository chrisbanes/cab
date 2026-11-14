/** Dependency-free definitions shared by installation and service configuration. */
export const workspaceMaintenanceSettings = {
  idleHours: {
    name: "CAB_WORKSPACE_IDLE_HOURS",
    option: "workspace-idle-hours",
    fallback: 24,
    multiplier: 3_600_000,
  },
  deliveredRetentionHours: {
    name: "CAB_WORKSPACE_DELIVERED_RETENTION_HOURS",
    option: "workspace-delivered-retention-hours",
    fallback: 24,
    multiplier: 3_600_000,
  },
  mergedRetentionHours: {
    name: "CAB_WORKSPACE_MERGED_RETENTION_HOURS",
    option: "workspace-merged-retention-hours",
    fallback: 1,
    multiplier: 3_600_000,
  },
  diskCapGb: {
    name: "CAB_WORKSPACE_DISK_CAP_GB",
    option: "workspace-disk-cap-gb",
    fallback: 10,
    multiplier: 1_000_000_000,
  },
} as const;

export type WorkspaceMaintenanceLimit = number | "off";
export type WorkspaceMaintenanceSettings = {
  [K in keyof typeof workspaceMaintenanceSettings]: WorkspaceMaintenanceLimit;
};

export type WorkspaceMaintenanceConfiguration = {
  [K in keyof WorkspaceMaintenanceSettings]?:
    | WorkspaceMaintenanceLimit
    | undefined;
};

export function parseWorkspaceMaintenanceLimit(
  raw: unknown,
  definition: (typeof workspaceMaintenanceSettings)[keyof typeof workspaceMaintenanceSettings],
): WorkspaceMaintenanceLimit {
  if (raw === undefined) return definition.fallback;
  if (raw === "off") return raw;
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() === raw && /^\d+$/.test(raw)
        ? Number(raw)
        : Number.NaN;
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > Math.floor(Number.MAX_SAFE_INTEGER / definition.multiplier)
  )
    throw new Error(
      `${definition.name} must be a positive safe whole integer (including after conversion) or off`,
    );
  return value;
}

export function workspaceMaintenanceFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): WorkspaceMaintenanceSettings {
  return Object.fromEntries(
    Object.entries(workspaceMaintenanceSettings).map(([key, definition]) => [
      key,
      parseWorkspaceMaintenanceLimit(env[definition.name], definition),
    ]),
  ) as WorkspaceMaintenanceSettings;
}

export function workspaceMaintenanceFromOptions(
  values: Readonly<Record<string, unknown>>,
): WorkspaceMaintenanceConfiguration {
  return Object.fromEntries(
    Object.entries(workspaceMaintenanceSettings)
      .filter(([, definition]) => values[definition.option] !== undefined)
      .map(([key, definition]) => [
        key,
        parseWorkspaceMaintenanceLimit(values[definition.option], definition),
      ]),
  );
}

export function resolveWorkspaceMaintenanceSettings(
  input: WorkspaceMaintenanceConfiguration = {},
): WorkspaceMaintenanceSettings {
  for (const key of Object.keys(input))
    if (!Object.hasOwn(workspaceMaintenanceSettings, key))
      throw new Error("Unknown workspace maintenance setting");
  return Object.fromEntries(
    Object.entries(workspaceMaintenanceSettings).map(([key, definition]) => [
      key,
      parseWorkspaceMaintenanceLimit(
        input[key as keyof WorkspaceMaintenanceSettings],
        definition,
      ),
    ]),
  ) as WorkspaceMaintenanceSettings;
}
