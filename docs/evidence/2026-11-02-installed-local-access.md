# Installed and foreground local CLI access, bounded live run (#1414)

Date: 2026-11-02. Source commit: `8b144a64492e0b3d4f1885a88d9cdcff0309339f` on branch
`cb/issue-1414-automatic-local-access`. Harness:
`node test/operations/service-lifecycle-qualification/live-service-lifecycle.mjs --local-access --live`.
Result: pass, exit 0, about 89 s, one run. Sanitized harness output:
[2026-11-02-installed-local-access.json](2026-11-02-installed-local-access.json).

## Setup

- One Mac (Apple silicon, macOS), Node `v26.13.0`, npm `12.2.1`.
- Two local tarballs packed from the built checkout with `npm pack`; nothing was published:
  - `0.1.0`: `sha512-srrP09pIHZ3zMqgsy6GEAFZAeQh8VJhHB7hglqjhCSEDnYslpzDT4UeJkVb50Z1ewgo7qdIlsMHIAl0NeRPgbw==`
  - `0.1.1-live.1414`: `sha512-2JYuYwn5QwIZzoTsESoaY+fubsIZNpb6nAoNbKgciqbwo8NkwFBWE9VxZGbYf9sf76CJZZVZKpjm139TsuhWGA==`
- The disposable label `local.cab.validation-1414-cdd67ad6`, two free loopback ports other
  than 8787, and one fresh private root for the state, logs, LaunchAgents directory, npm
  prefix, CLI `HOME` and CLI config, plus a separate foreground data, auth, `HOME` and CLI
  config. Every CLI environment was built from scratch: no saved connection, token, token
  file or Keychain item was read or written. The default label `local.cab.service`, port
  8787, the real `~/Library/Application Support/cab` state and the installed Haze
  prototype were not touched; `--no-open` kept the browser closed. The LaunchAgent runs
  with launchd's fixed environment, so its readiness read the account's existing runtime
  logins read-only, as earlier lifecycle runs did.

## Installed service

1. Preflight: the label was not loaded; real-folder and launchd-label baselines taken.
2. `npm install -g --prefix` of `0.1.0`.
3. `prefix/bin/cab service install --no-open` with the disposable label, state and port.
   The only prompt was the hidden new browser password (no auth file existed); it was
   typed once and never appeared in output. Install reported `"accessMode":"local"`,
   `"connection":null`, `"credentialActive":false`, `"sessionOpen":false`, printed the
   doctor table and saved no CLI connection. `/app` answered 200 from the job's process.
4. `cab auth status --local --local-installation STATE/launchd/LABEL.json`: local,
   read-write, no expiry. `cab connection local smoke --local-installation ...` and
   `cab connection use smoke` saved the reference deliberately; bare `cab auth status`
   then reported connection `smoke`, the same installation. `cab project list`, one
   `project prepare-create` / `project apply` of a project with no lead profile or
   repository and its `project get` readback, and `cab doctor` all exited 0 with no login.
5. Equal-version reload, `cab service upgrade STATE/versions/0.1.0`: the old process
   exited, readiness reported no failed check, and the same `smoke` connection then
   read the project back and ran doctor with the same installation ID and no login.
6. `npm install -g` of `0.1.1-live.1414`, then `cab service upgrade`: version
   `0.1.1-live.1414`, `"snapshot":null` (no migration pending), every readiness check
   `pass` or `not-configured`, the old process exited, and the saved local connection
   kept working against the same installation.
7. `cab service uninstall`: `launchctl print` reported the label unloaded, every recorded
   process exited, the LaunchAgent was removed, and data, auth and versions were kept.

## Foreground server

8. `prefix/bin/cab service operator DATA PORT` as this run's own child, with its own auth
   file and `HOME`. `cab auth status --local --local-state DATA` (local, read-write, no
   expiry), `project list`, a project create, apply and readback, and `doctor` exited 0.
   The child stopped on SIGTERM and its exit was confirmed; a restart on the same data
   reported the same installation, read the project back and ran doctor without a login,
   then stopped the same way. A foreground server has no installed upgrade; doctor and the
   restart are its applicable readiness path.

## Cleanup and invariance

9. The launchd label list, `~/Library/LaunchAgents`, `~/Library/Application Support/cab`
   and the top level of `~/Library/Logs` were unchanged against the baseline. The label
   was unloaded, no owned process remained, and the disposable root was removed. After
   the run, `launchctl print gui/$UID/local.cab.validation-1414-cdd67ad6` exited 113 (not
   loaded), no process referenced the label or root, and no disposable directory remained.

## Limits

- No model turn ran, no task was created and no project was linked to a repository or
  provider; runtime execution is outside this feature.
- The default-label automatic lookup was not exercised live, to avoid installing the
  real default label; `test/operations/installation-discovery.test.ts` covers it offline
  against real services.
- The upgrade had no pending migration; snapshot-before-migration and failed-upgrade
  handling are covered by the automated lifecycle tests, not this run.
- A published npm upgrade, a LaunchDaemon install, another device and a production
  cutover were not qualified.
