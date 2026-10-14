import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  diagnosticRetentionDays,
  diagnosticStorageMib,
  isInBound,
} from "./diagnostic-retention.js";
import { canonicalLoopbackOrigin } from "./operator-auth.js";
import { isWithin } from "./workspace-inspection.js";

export type LaunchAgentConfiguration = {
  label: string;
  nodePath: string;
  cliPath: string;
  dataDirectory: string;
  authFile: string;
  origin: string;
  port: number;
  stdoutPath: string;
  stderrPath: string;
  /** Written only when set; the service's own defaults apply otherwise. */
  diagnosticRetentionDays?: number;
  diagnosticStorageMib?: number;
};

const LABEL =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const ROOT_LAUNCHD_DIRECTORIES = [
  "/Library/LaunchDaemons",
  "/Library/LaunchAgents",
  "/System/Library/LaunchDaemons",
  "/System/Library/LaunchAgents",
];
const LAUNCHD_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

function assertText(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || containsControl(value))
    throw new Error(`${label} is invalid`);
}

function containsControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function canonicalExistingPath(path: string, label: string): string {
  assertText(path, label);
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const canonical = realpathSync(path);
  if (canonical !== path)
    throw new Error(`${label} path must not use symlinks`);
  return canonical;
}

function requirePrivateDirectory(path: string, label: string): void {
  const canonical = canonicalExistingPath(path, label);
  const state = lstatSync(canonical);
  if (state.isSymbolicLink() || !state.isDirectory())
    throw new Error(`${label} must be a real directory`);
  if ((state.mode & 0o077) !== 0) throw new Error(`${label} must be private`);
}

function requireRegularFile(path: string, label: string, executable: boolean) {
  const canonical = canonicalExistingPath(path, label);
  const state = lstatSync(canonical);
  if (state.isSymbolicLink() || !state.isFile())
    throw new Error(`${label} must be a regular file`);
  if (executable && (state.mode & 0o111) === 0)
    throw new Error(`${label} must be executable`);
}

function requirePrivateOutputPath(path: string, label: string): void {
  assertText(path, label);
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const parent = dirname(path);
  requirePrivateDirectory(parent, `${label} parent`);
  const canonical = join(realpathSync(parent), basename(path));
  if (canonical !== path) throw new Error(`${label} path must be canonical`);
  try {
    lstatSync(path);
    throw new Error(`${label} already exists`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function validateOrigin(origin: string): void {
  assertText(origin, "Operator origin");
  let url: URL | undefined;
  try {
    url = canonicalLoopbackOrigin(origin);
  } catch {
    throw new Error("Operator origin is invalid");
  }
  if (!url)
    throw new Error("Operator origin must be canonical loopback HTTP or HTTPS");
}

function validateConfiguration(configuration: LaunchAgentConfiguration): void {
  if (!LABEL.test(configuration.label))
    throw new Error("LaunchAgent label is invalid");
  if (
    !Number.isInteger(configuration.port) ||
    configuration.port < 1 ||
    configuration.port > 65_535
  )
    throw new Error("Operator port is invalid");
  validateOrigin(configuration.origin);
  for (const [value, bound, label] of [
    [
      configuration.diagnosticRetentionDays,
      diagnosticRetentionDays,
      "Diagnostic retention days",
    ],
    [
      configuration.diagnosticStorageMib,
      diagnosticStorageMib,
      "Diagnostic storage MiB",
    ],
  ] as const)
    if (value !== undefined && !isInBound(value, bound))
      throw new Error(`${label} is invalid`);
  requireRegularFile(configuration.nodePath, "Node executable", true);
  requireRegularFile(configuration.cliPath, "Compiled CLI", false);
  requirePrivateDirectory(configuration.dataDirectory, "Data directory");
  requireRegularFile(configuration.authFile, "Operator auth file", false);
  if ((lstatSync(configuration.authFile).mode & 0o777) !== 0o600)
    throw new Error("Operator auth file must have mode 0600");
  requirePrivateDirectory(
    dirname(configuration.authFile),
    "Operator auth parent",
  );
  requirePrivateOutputPath(configuration.stdoutPath, "Standard output");
  requirePrivateOutputPath(configuration.stderrPath, "Standard error");

  const paths = [
    configuration.nodePath,
    configuration.cliPath,
    configuration.dataDirectory,
    configuration.authFile,
    configuration.stdoutPath,
    configuration.stderrPath,
  ];
  if (new Set(paths).size !== paths.length)
    throw new Error("LaunchAgent paths must be distinct");
}

function xml(value: string): string {
  assertText(value, "LaunchAgent value");
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stringElement(value: string): string {
  return `<string>${xml(value)}</string>`;
}

function diagnosticEntries(configuration: LaunchAgentConfiguration): string {
  return [
    [diagnosticRetentionDays.name, configuration.diagnosticRetentionDays],
    [diagnosticStorageMib.name, configuration.diagnosticStorageMib],
  ]
    .filter(([, value]) => value !== undefined)
    .map(
      ([name, value]) =>
        `\n    <key>${name}</key>\n    ${stringElement(String(value))}`,
    )
    .join("");
}

export function renderLaunchAgent(
  configuration: LaunchAgentConfiguration,
): string {
  validateConfiguration(configuration);
  const argumentsList = [
    configuration.nodePath,
    configuration.cliPath,
    "operator",
    configuration.dataDirectory,
    String(configuration.port),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${stringElement(configuration.label)}
  <key>ProgramArguments</key>
  <array>
${argumentsList.map((argument) => `    ${stringElement(argument)}`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${stringElement(LAUNCHD_PATH)}
    <key>ENSEMBLE_OPERATOR_AUTH_FILE</key>
    ${stringElement(configuration.authFile)}
    <key>ENSEMBLE_OPERATOR_ORIGIN</key>
    ${stringElement(configuration.origin)}${diagnosticEntries(configuration)}
  </dict>
  <key>StandardOutPath</key>
  ${stringElement(configuration.stdoutPath)}
  <key>StandardErrorPath</key>
  ${stringElement(configuration.stderrPath)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
`;
}

function assertNotSystemLaunchdTarget(path: string): void {
  const absolute = isAbsolute(path) ? path : "";
  if (
    ROOT_LAUNCHD_DIRECTORIES.some((directory) => isWithin(directory, absolute))
  )
    throw new Error(
      "LaunchAgent output must not target a root/system launchd directory",
    );
}

export function writeLaunchAgent(
  configuration: LaunchAgentConfiguration,
  plistPath: string,
): void {
  const contents = renderLaunchAgent(configuration);
  assertText(plistPath, "LaunchAgent output");
  if (!isAbsolute(plistPath))
    throw new Error("LaunchAgent output path must be absolute");
  assertNotSystemLaunchdTarget(plistPath);
  if (basename(plistPath) !== `${configuration.label}.plist`)
    throw new Error("LaunchAgent filename must match its label");
  requirePrivateOutputPath(plistPath, "LaunchAgent output");
  if (
    [
      configuration.nodePath,
      configuration.cliPath,
      configuration.dataDirectory,
      configuration.authFile,
      configuration.stdoutPath,
      configuration.stderrPath,
    ].includes(plistPath)
  )
    throw new Error("LaunchAgent paths must be distinct");

  writeFileSync(plistPath, contents, { flag: "wx", mode: 0o600 });
  chmodSync(plistPath, 0o600);
  const descriptor = openSync(plistPath, fsConstants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
