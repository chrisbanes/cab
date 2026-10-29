# npm service lifecycle, bounded live run (#1327)

Date: 2026-10-29. Source commit: `d6503084a6cc79f6c4046adbe85737675694de8c` on branch
`cb/issue-1327-npm-package`. Harness:
`node test/operations/service-lifecycle-qualification/live-service-lifecycle.mjs --npm`.
Result: pass, exit 0, about 65 s.

## Setup

- One Mac (Apple silicon, macOS), Node `v24.22.1`, npm `11.19.1` for the installs.
- Two local tarballs packed from the built checkout with `npm pack`; nothing was published:
  - `0.1.0`: `sha512-Ghjl19vJhDtiq5FwP2tGwKpsQPHabKPFTJ/wypHDjHvv75+NFLh+rtZvAaVp2pHN1J/rI1xPGO4rE1YhlJsOww==`
  - `0.1.1-live.1327`: `sha512-skkdsrM4meLTDVzv/sp02AG1U7AUE0z9aeTYJzhTaWjsMQjEfTOYhqNobRuBUKk4jfQiPIVwTQpNhB5RtlRM1w==`
- A throwaway label (`local.cab.validation-<random>`) and a fresh private root for the
  state, logs, LaunchAgents directory, CLI config, `HOME` and the npm prefix. The default
  label, the real `~/Library` folders, the login Keychain and the browser were not used
  (the token went to a file, `--no-open`). The installed Haze prototype was not touched.

## Results

1. Preflight: the throwaway label was not loaded.
2. `npm install -g --prefix` of `0.1.0` created no `STATE` or `HOME/Library` and loaded no
   job; `prefix/bin/cab --version` printed `cab 0.1.0`.
3. `prefix/bin/cab service install` (password typed once on a pseudo-terminal, read
   credential to a token file, doctor) bound the real path of the CLI's Node.js, staged
   `STATE/versions/0.1.0` with a `cab.npm-stage/v1` manifest, rendered a plist whose
   program arguments are that Node.js and the stage's `dist/src/standalone/cli.js`, served
   `/app` with 200 and answered an authenticated CLI read. Neither the password nor a token
   appeared on the terminal.
4. `npm install -g` of `0.1.1-live.1327` and then `npm uninstall -g`: the stage's tree
   digest, the service's pid and `/app` were unchanged, and the process command ran from the
   stage.
5. `npm install -g` again, then `prefix/bin/cab service upgrade` (no `VERSION_DIR`): exit 0,
   version `0.1.1-live.1327`, no readiness check failed, the old process exited, the new
   process ran from the new stage, and the service-taken snapshot
   `startup.0.1.0-to-0.1.1-live.1327.*` passed `cab snapshot verify`. `versions/0.1.0` stayed.
6. `service uninstall`: `launchctl print` returned 113, every observed process exited, and
   the data directory, auth file, snapshot, both stages and logs were kept.
7. Reinstall from the same prefix: the existing auth file was unchanged (the prompt asked
   for the existing password), `/app` served 200 on `0.1.1-live.1327`.
8. A final uninstall left the label unloaded; the listing of launchd labels, LaunchAgents,
   `~/Library/Application Support/cab` and the top-level `~/Library/Logs` entries was
   identical before and after, and the private root was removed.

## Limits

Local tarballs, not a published package, and one Mac with one Node.js (the harness's own
`process.execPath`). A Node.js removed after install (nvm, a Homebrew cellar) was not
exercised live; it is a disclosed limit with `cab service upgrade STATE/versions/<version> --node PATH` as the
re-bind. Dependencies were resolved from the npm registry and cache by `npm install -g`,
not from the repository lockfile. Trusted publishing, the first publish and the first
tag are not exercised here.
