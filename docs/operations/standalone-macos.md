# Standalone macOS operations

This procedure applies to the standalone cab service only. It does not
read or migrate the installed Haze prototype or authorize production deployment
or cutover. `cab service install` installs the service as a per-user
LaunchAgent; nothing installs it implicitly. `--mode daemon` instead prepares a
[LaunchDaemon](#launchdaemon-mode) that starts at boot; it is opt-in and the
LaunchAgent stays the default.

## Install, upgrade and uninstall

The primary first-release channel is one npm package, `@chrisbanes/cab`, with
Node.js installed separately ([ADR-1011](../adr/1011-packaging-and-distribution.md)).
`cab service install` and `cab service upgrade` support it
([from npm](#install-and-upgrade-from-npm)) and automated tests cover it. No version has
been published and the sequence is not qualified on a published package.
The bundled-Node tarball channel stays supported and is described first. Desktop and
Homebrew distribution are deferred.

The service runs from an unpacked [release](#release-build) or a staged copy of the
npm package under the state directory. The defaults are:

| Path | Default |
| --- | --- |
| State (`STATE`) | `~/Library/Application Support/cab` |
| Data | `STATE/data` |
| Operator auth | `STATE/auth/operator-auth.json` |
| Notification key | `STATE/auth/operator-push-vapid.json` |
| Snapshots | `STATE/snapshots` |
| Install records | `STATE/launchd/<label>.json` |
| Releases | `STATE/versions/<version>` |
| Logs | `~/Library/Logs/cab/<label>.<version>.<UTC time>.{out,err}.log` |
| LaunchAgent | `~/Library/LaunchAgents/<label>.plist` |
| LaunchDaemon (`--mode daemon`) | staged as `STATE/launchd/<label>.plist`, installed by you as `/Library/LaunchDaemons/<label>.plist` |

Commands below use `STATE="$HOME/Library/Application Support/cab"`.
The label defaults to `local.cab.service` and the port to `8787`
(`http://127.0.0.1:8787`). `--state-dir`, `--log-dir`, `--launch-agents-dir`,
`--label` and, at install only, `--port` and `--mode agent|daemon` override
them; upgrade keeps the installed port. `--diagnostic-retention-days` and `--diagnostic-storage-mib`
(install and upgrade) set the [diagnostic retention](#execution-diagnostic-retention)
limits. Pass the same directory and label options to `upgrade` and
`uninstall` as to `install`. The state and LaunchAgents directories must
be real directories you own that no one else can write; the data, snapshot,
install-record and log directories are created with mode `0700` and must stay
private. The state directory may already hold unrelated files, such as the
earlier pipeline implementation's `config.yaml` and `state/`; the commands read
and change only the entries above.

### Install

Install a release tarball with one command. It unpacks the tarball, installs the
service, signs the CLI in and opens the app:

```sh
tar -xzf cab-0.1.0-darwin-arm64.tar.gz
cab-0.1.0-darwin-arm64/bin/cab service install cab-0.1.0-darwin-arm64.tar.gz
```

The first `tar` only makes the tarball's own `cab` available to run. Install
unpacks the tarball again into `STATE/versions/<version>` through a staging
directory. If that version directory already exists with the same
`manifest.json`, it is reused; with a different complete one, install refuses and
changes nothing. The release is published only once it holds `node/bin/node` and
`dist/src/standalone/cli.js`, and an incomplete version directory (for example
from an interrupted hand unpack) is replaced. A later failure keeps the unpacked
version, so a rerun reuses it, and a leftover `.staging-<pid>-*` directory from a
killed install is removed by the next one.
`service install` with no tarball binds to the release it runs from, which must
already sit in `STATE/versions` (for example one you unpacked there with
`tar -xzf FILE --strip-components 1 -C "$STATE/versions/0.1.0"`).

Install refuses, changing nothing beyond creating an empty `STATE` (mode `0700`), unless the tarball is a readable file (or the
release sits directly in `STATE/versions` with a `manifest.json` naming the same
version), the label is not loaded, no install record, LaunchAgent or LaunchDaemon
artifact for the label exists (an install in the other mode is refused until you
uninstall it), and the port is free. With `--token-file`, the path must not exist and its
directory must. A missing auth file also refuses outside an
interactive terminal; run install in one, or run `cab service init-auth`
first. It then asks once, on a hidden prompt, for the operator password (a new
password when the auth file is missing, which it creates as a mode `0600`
verifier, not the password). It renders the plist with the same validation as
before (absolute canonical paths, no symlinks, new log files, the fixed `PATH`,
`RunAtLoad=true`, `KeepAlive=false`, no secrets), lints it with `plutil -lint`,
records it, moves it into `~/Library/LaunchAgents`, runs `launchctl bootstrap` and
waits up to 120 seconds for `/app`. The plist names the release's own
`node/bin/node` and `dist/src/standalone/cli.js`, so each version keeps its exact
executable.

If unpacking fails, install exits 1 before any job exists. If bootstrap or the
wait fails, install boots out the job it started, confirms the process exited,
removes the LaunchAgent and its record, keeps the data, auth and logs, reports the
log paths and exits 1. Either way it keeps what it already created: the unpacked
version, and the auth file once created, so a rerun asks for the existing password
instead of a new one. Run it again after fixing the cause. If the exit cannot be confirmed, it reports `"jobStopped":false` and
keeps the record so that `service uninstall` can finish.

Once `/app` answers, the service stays installed whatever follows. Install signs
in with the password over the session API the UI uses, issues one `read`
credential named `install · <hostname>` that expires in 90 days, and stores it as
the CLI connection `local` (`--connection NAME` renames it). The token goes to the
login Keychain, or with `--token-file PATH` to a new `0600` file at that path
(an existing file is refused). Install then runs `cab doctor` for that
connection, prints its table and `Fix` lines on stderr, and opens
`http://127.0.0.1:PORT/app` unless you pass `--no-open`. The JSON result stays on
stdout and gains `"connection":"local"`, or `null` when the CLI was not logged in,
plus `"credentialActive"` and `"sessionOpen"`. `credentialActive` is true when the
minted credential could not be confirmed revoked (the revoke is tried twice) or its
creation was not confirmed; install then prints its name and tells you to revoke it in
Settings → CLI credentials. `sessionOpen` is true when the sign-in logout was not
confirmed or the login reply was lost. The exit status stays 0 because the service is installed.
The password and token are never printed or put on a command line.

If the prompt is cancelled (the Ctrl-C keypress there skips sign-in; it does not
stop the install, whereas a SIGINT sent from outside stops it before anything changes)
or skipped, the password is wrong (one attempt only),
the credential cannot be stored (it is then revoked), or doctor or the browser
open fails, install still exits 0 with the service running. It prints the manual
step and you finish it yourself, using a read credential issued in Settings → CLI
credentials:

```sh
cab auth login --connection local --url http://127.0.0.1:8787
cab doctor
```

The issued credential widens nothing: whoever runs install as the service user
already holds the auth file and the data directory. It is listed, rotatable and
revocable in Settings → CLI credentials like any other. Upgrade never signs in or
issues a credential; it reads readiness through this connection, so an expired or
revoked credential stops upgrade with the existing message until you log in again.

### Install and upgrade from npm

`npm install -g @chrisbanes/cab` puts the `cab` CLI on your `PATH` and starts nothing:
the package has no install scripts, and neither installing, updating nor removing it
touches `STATE`, the logs or the LaunchAgents. It needs Node.js 24 or a later
even-numbered (LTS) release; an odd-numbered release is refused. Then run:

```sh
cab service install [--node PATH]
```

`service install` run from a global npm installation (a package root ending in
`node_modules/@chrisbanes/cab`) copies that package, with its production
`node_modules`, `dist/src` and `dist/operator`, into `STATE/versions/<version>` through
the same staging directory as a tarball and writes a `manifest.json` with schema
`cab.npm-stage/v1` and the copy's `cab-tree-sha256/v1` digest. The Claude Agent SDK's
platform packages are left out, as in the tarball; `claude` comes from the service
`PATH`. An existing version with the same manifest is reused, and one with a different
manifest, or a tarball release of that version, is refused. The service then
runs from that copy, so a later `npm install -g` or `npm uninstall -g` does not change
the files it runs. Everything after staging is as for a tarball: the same preflight
refusals, plist, start, health check and sign-in. A checkout is not an npm
installation and is still refused.

The plist names a Node.js, not a bundled one. Install binds the one running the CLI, or
`--node PATH`, which must be an absolute path to an executable even-numbered release at
or above the package's `engines.node`. It is checked, by running `--version`, before
anything is staged or stopped, and recorded as its real path in the install record; it is
never looked up on `PATH` again. If that Node.js is removed (for example an nvm version or
a Homebrew cellar the next upgrade deletes) the service fails to start until you re-bind
it with `cab service upgrade "$STATE/versions/<version>" --node PATH`, which re-binds the
staged copy without staging again. `--node` is refused with a TARBALL or any
other tarball release.

To update, install the new version, then upgrade:

```sh
npm install -g @chrisbanes/cab@0.2.0
cab service upgrade --connection local
```

`service upgrade` with no `VERSION_DIR` must run from a global npm installation. After
the usual checks and the readiness read, and before it stops the job, it stages the
running package as `STATE/versions/<version>`. A staging or Node.js failure therefore
leaves the old job running. The stages and failure handling are those of
[Upgrade](#upgrade). The binding recorded at install is kept unless `--node PATH` changes
it. To re-bind without a version change, pass the staged copy as `VERSION_DIR` with
`--node`; running the package's upgrade again re-stages it, which is refused when a reinstall
resolved other dependency versions for the same package version. A package that does not
hold its dependencies under it (a project-local or `npx` install) is refused. An explicit
`VERSION_DIR` also takes a staged npm version. Uninstall is unchanged and keeps every staged version. The
sequence is automated in `test/operations/npm-service-lifecycle.test.ts` (a launchd
stand-in that runs the rendered plist as a real process) and had one bounded live run
on local tarballs under a throwaway label
([evidence](../evidence/2026-10-29-npm-service-lifecycle.md)).

A LaunchDaemon install from npm uses the same staging and binding. The verify command it
prints runs `NODE STATE/versions/<version>/dist/src/cli/main.js service install ...`,
because an npm stage has no `bin/cab`.

### Upgrade

Unpack the new release beside the old one and run its `upgrade`:

```sh
mkdir "$STATE/versions/0.2.0"
tar -xzf cab-0.2.0-darwin-arm64.tar.gz --strip-components 1 -C "$STATE/versions/0.2.0"
"$STATE/versions/0.2.0/bin/cab" service upgrade "$STATE/versions/0.2.0" --connection local
```

The first release that gives Codex its own home refuses to resume Codex
conversations started before it: the request is refused, naming "Started under
the previous Codex home; restart the task", and Reset task starts a new conversation.
Finish or restart open Codex work before upgrading; conversation history stays
readable.

Before it changes anything, upgrade reads the install record, checks the target
release as install does, checks that the running job is the one the record
describes, and loads the connection's token (`--connection`,
`CAB_CONNECTION` or the default connection), which must be for the
installed origin. It also makes one readiness read with that token while the old
job still runs, and refuses if the read fails (an expired or revoked token, or one
without `diagnostics.read`), and it refuses a target older than the installed
release. It then runs these stages:

1. `stop`: boots out the job and confirms that its process exited, within 30
   seconds.
2. `render`: renders, lints and records the new plist, with new log files.
3. `start`: `launchctl bootstrap`. The starting service takes and verifies the
   [startup snapshot](#startup-snapshot) before it applies pending migrations, or
   refuses to start.
4. `health`: waits up to 120 seconds for `/app`.
5. `readiness`: reads readiness until no check reports Fail, for up to 120
   seconds. Not configured is accepted, so an unused GitHub discovery, GitLab
   credential or Claude does not block it. A configured GitLab credential that
   fails, or a `glab` login shadowed by `GITLAB_TOKEN`, does block it, as a failing configured GitHub discovery credential does. The identity check confirms the same installation.

On success it prints the version, the startup snapshot, log paths and each readiness
status. The snapshot is null when this start had no pending migrations, as when it
reloads the release that last started or the new release applies none, and when a retry
reuses the snapshot a failed attempt took, which that attempt already reported. On a
failure from `stop` onward it leaves the job stopped: it boots out
the new job if it started, with its exit confirmed, and removes the LaunchAgent
so nothing starts at login. It keeps the install record and prints
`{"ok":false,"operation":"upgrade","stage",…,"jobStopped","snapshot","logs"}`.
`jobStopped` is false only when a process exit could not be confirmed. There is
no rollback command. Recover by running `upgrade` again, with a fixed release or
the same one once the cause is fixed, or restore the reported snapshot (see
[Offline snapshot and restore](#offline-snapshot-and-restore)). A build
refuses data at a higher migration level than it applies, so going back to an older
release needs that restore.

Upgrade refuses a [LaunchDaemon](#launchdaemon-mode) install at its first check,
before it stops anything; that section gives the switch-back procedure.

### Uninstall

```sh
"$STATE/versions/0.2.0/bin/cab" service uninstall
```

Uninstall of a LaunchAgent boots out the job, confirms its process exited, and removes the
LaunchAgent and the install record. It keeps the data, auth file, snapshots,
release versions and logs, so a later install reuses them. It refuses, changing
nothing, when the loaded job or the LaunchAgent file is not the one the record
describes (a different plist path or a changed plist hash). If the exit cannot be
confirmed, it removes the LaunchAgent once the label is gone, keeps the record and
exits 1; run it again. A re-run cannot recheck the earlier process, so confirm
with `launchctl print` and `ps` that it is gone. With nothing installed it reports
`"installed":false`.

Install, upgrade and uninstall each hold `STATE/.<label>.lock` (mode `0600`,
recording the command's pid) while they run, so a second command for the same label
fails at once and changes nothing. A lock is never taken over: if the command that
made it was killed, confirm with `ps -p <pid>` that the pid it names is gone,
remove the lock file and run the command again. The plist is staged in a private
`.<label>.staging-*` directory inside the LaunchAgents directory and moved into
place within that directory; a failed command removes it.

Ctrl-C during an install or upgrade wait fails it at that stage, and the failure
handling above still runs. If a command is killed outright, or the install record
is unreadable, `upgrade` and `uninstall` refuse rather than guess. Recover by
hand: boot out the label only after `launchctl print` shows the expected
`~/Library/LaunchAgents/<label>.plist` path, confirm its process exited, then
remove that plist and `STATE/launchd/<label>.json` and install again.

### LaunchDaemon mode

The LaunchAgent starts when you log in to the Mac's GUI session. To have the
service running after a reboot with nobody logged in, install it as a
LaunchDaemon, which launchd starts at boot. This is opt-in:

```sh
cab service install --mode daemon
```

cab never runs as root, in either mode, and the commands above refuse to run
as root (`cab does not run as root; run it as the account that owns the
service`). Run them as the account that owns the service. Daemon mode runs the
service as that account too: the plist sets `UserName` to it and `HOME` to its
home directory, so the data, auth, logs and credentials stay yours. What needs
root is only copying the plist into `/Library/LaunchDaemons` and loading it, and
cab does not do that for you. Install does the same preflight, unpack,
password prompt (only when the auth file is missing), render and `plutil -lint` as
the LaunchAgent, records the install, and then prints two commands for you to run
with `sudo`:

```sh
sudo /usr/bin/install -m 0644 -o root -g wheel "$STATE/launchd/local.cab.service.plist" /Library/LaunchDaemons/local.cab.service.plist
sudo /bin/launchctl bootstrap system /Library/LaunchDaemons/local.cab.service.plist
```

The printed commands quote paths that need it. Install exits 0 with `"mode":"daemon"`,
`"started":false` and the two commands in `"steps"`. In daemon mode it only ever calls
`launchctl print`; it never writes under `/Library`, never runs `bootstrap` or
`bootout`, and does not sign in or run `doctor`. A first install creates, when absent,
`STATE/data`, `STATE/launchd` and the log directory (default `~/Library/Logs/cab`,
outside `STATE`, with any missing parents), and writes the staged plist and the install
record in `STATE/launchd`; it also creates `STATE/auth/operator-auth.json` when that file
is missing (after the password prompt) and, with a TARBALL, `STATE` itself (mode `0700`,
with any missing parents) and the unpacked `STATE/versions/<version>`. It creates no
`STATE/snapshots` (the LaunchAgent flow creates it; a daemon's first start against older
data creates it, owned by the service account). Transient files (`STATE/.<label>.lock`, a staging directory in
`STATE/launchd`, the record's temporary file) are removed again. It creates no
LaunchAgents directory and writes nothing under `/Library` or `/Library/LaunchDaemons`.
launchd, not cab, creates the log files, as the daemon account; that ownership is
untested here and left to [#1149](https://github.com/chrisbanes/cab/issues/1149). A
test asserts this set, from a home that has only the release and the auth file, and from
one that has only a tarball. The first
command copies the staged file as it is at that moment (and follows a symbolic
link at that path), and launchd then runs what the copied plist says, so run it
soon after install and first check that `shasum -a 256` of the staged file equals
`plistSha256` in the install record; anything that can write `STATE` as you could
change the file. Then run the same install command again to verify, with the same
options and no TARBALL, from the installed release (`"$STATE/versions/<version>/bin/cab" service install`
with `--state-dir`, `--log-dir`, `--launch-agents-dir`, `--label`, `--port`, `--connection`
and `--mode daemon` as you gave them; the TARBALL is dropped, `--token-file` is refused in
daemon mode, and `--diagnostic-*` and `--no-open` mean nothing to a re-run; install prints
the exact line). Use the same
`--state-dir` and label in both modes: the exclusion between modes checks the
record and `/Library`, and a record in another state directory is invisible to it.
If the copy ran but the job is not loaded, the re-run prints only the `launchctl
bootstrap` step. The re-run compares `system/<label>` and
`/Library/LaunchDaemons/<label>.plist` with the install record: the plist must be a
regular file (not a symbolic link) owned by root that others cannot write, with
the recorded sha256, and the loaded job's path must be that plist. It reports
`"started":true` (exit 0, no steps) only when `launchctl print` shows the loaded job with a
process, that process's identity can be read, and the process listening on the port
(read with `lsof -nP -iTCP:PORT -sTCP:LISTEN`) is that same pid and no other, and
`/app` answers 200 from it, and after that last wait the job's pid and every listener on the port are read again and are in full (pid, start time and boot session) the process that was first observed. A reused pid or a new boot is another process, and an identity that can no longer be read never matches. `"started":true` describes the moment of that last read. A loaded job with no
process, an unreadable identity, another or an unknown listener on the port, or a
process that never serves, exits 1 with a message that keeps the record and gives the
read-only checks. It never trusts a 200 from whatever else holds the port. After it reports
started it prints the
manual `cab auth login` line, `cab doctor` and the app URL (it never opens
the browser), as the LaunchAgent install does when it could not sign in. When the job is not loaded it
prints the steps again with `"started":false`. When the plist or job differs from
the record it refuses and changes nothing; so does a different release, a tarball
or a different port. The re-run never writes under `/Library`, never changes launchd
and never signals a process. Its only write is to the install record: when it finds the
daemon loaded it stores the running process (see the
uninstall paragraphs below), and only when that differs from what the
record holds, atomically with a temporary file and rename in the same directory. If the
record cannot be written, the re-run fails with a fixed message and leaves the record as
it was. Repeating it is safe.

The daemon plist is the LaunchAgent's plus `UserName` and `HOME`: the same
`ProgramArguments`, the fixed `PATH`, the auth-file path and origin, the optional
diagnostic values, `RunAtLoad=true` and `KeepAlive=false`, and no other
environment variable and no secret. It is world-readable in `/Library/LaunchDaemons`.
Logs stay in the log directory, `<label>.<version>.<UTC time>.{out,err}.log`.
Install and the service refuse `root` as the account.

**What the logs contain.** The service logs only at its process edges; SQLite state
and the execution diagnostics stay the debugging record, and per-request, per-poll
and access activity is not logged. `<label>…out.log` holds the operator URL line
that `operator` prints once it is listening. `<label>…err.log` holds one JSON object
per line:

- `{"event":"service-start","version","mode","port","serviceId"}` once the service is
  serving (`port` is `null` for `serve`).
- A background-failure diagnostic when a background loop (`github-poll`, which also
  covers the GitHub refresh after a confirmed delivery action,
  `power-poll`, `domain-wake`, `post-turn-wake`, `scheduler-drain`) fails
  unexpectedly, and a `safe-shutdown` diagnostic when the service cannot stop
  cleanly. Both carry `error`, the failure's `name`, `code` when it has one, its
  `message`, up to 10 stack frames and its `cause` chain, redacted as described below.
- `{"event":"service-failure","stage":"service-shutdown"|"listener-shutdown","error"}`
  when the service or the operator listener fails to shut down.
- `{"event":"service-exit","reason"}`, exactly once at the end. `reason` is `signal`
  (with `signal`), `background-failure` (with `operation`), `shutdown-failure`, or
  `crash` (with `error`) for a startup failure such as a port already in use, an
  uncaught exception or an unhandled rejection; a crash exits unsuccessfully
  without Node's default stack print. A line from a crash during startup can
  appear without a `service-start` line.
- `{"errorCode":"diagnostic-writer-failed"}` when the diagnostic sink stalls or
  fails, and the fixed root-refusal message when the service is started as root.

Every `error` is redacted before it is written: the data directory, the operator
auth file, GitHub, Claude, routing and delivery credentials, credential-named
environment values and repository paths become `[redacted]`, as do values after
`token=`, `password=`, `secret=` or `api_key=`, `Authorization:` header values,
`Bearer` values and credentials inside URLs. A secret outside these forms that is
not a configured credential is not recognised.
The message is cut at 2 KiB, each stack frame at 512 bytes and the `cause` chain at
three levels (`messageTruncated`, `causeOmitted`). `"redaction":"unavailable"` marks
a failure from before the redaction inputs were available: only `name` and `code`
are shown, never the message or stack. In every record, a `name` or `code` that is
not identifier-shaped, holds an excluded value or matches a redaction form above is
replaced by `Error` or left out.

There is one install record per label (`STATE/launchd/<label>.json`), which
carries `"mode"`: `agent` or `daemon`. The modes are never both active. Install in
one mode refuses, changing nothing, while a record, loaded job or plist of the other
exists, and tells you to uninstall first. A record without `mode` is read as a
LaunchAgent. A CLI that predates `mode` refuses a record that carries `mode`
as invalid and changes nothing, so do not manage a daemon (or a newer LaunchAgent)
install with an older release's CLI.

`service upgrade` refuses a daemon install before it stops anything, because
upgrading stops the job and cab cannot do that without sudo. To upgrade, switch back:

```sh
cab service uninstall            # prints the sudo steps; run them, then run it again
cab service install              # the LaunchAgent
cab service upgrade "$STATE/versions/0.2.0" --connection local
cab service uninstall
cab service install --mode daemon  # then the sudo steps and the verify re-run
```

`service uninstall` reads the mode from the record. For a daemon it verifies that
the loaded job and the plist are the recorded ones, prints the matching commands
for whatever is still present, and exits 0 with `"complete":false`:

```sh
sudo /bin/launchctl bootout system/local.cab.service
sudo /bin/rm -f /Library/LaunchDaemons/local.cab.service.plist
```

It keeps the record and staged plist; run `service uninstall` again after the
commands. Removing the job does not stop its process at once, so the record also
keeps what cab has seen of the service (`observed`). `service install --mode daemon`
re-runs, and `service uninstall` while the job is loaded, read `launchctl print` and
fold it in: the pid, start time and boot session of each process seen, and whether a
loaded job had no process yet or one whose identity could not be read. What is
recorded only moves up. A job seen with no pid is treated as maybe-started, never as
never-started, because launchd may start it a moment later; a recorded identity is
dropped only once its exit is confirmed, so a restarted job keeps the earlier process
until that is confirmed too; an unreadable identity is kept for good (only removing the
record by hand clears it). That is the only thing either command writes, and only
when it changes: under `STATE/launchd`, never under `/Library`, and uninstall does it
before it prints the steps, so a record that cannot be written fails the command
(exit 1, fixed message, record unchanged) and no steps are printed. Nothing is ever
signalled. The confirmation covers only the main service processes seen, not their
descendants, so run the printed commands right after the `uninstall` that printed
them; if the host rebooted or the job restarted in between, run `service uninstall`
again first so that it observes the running process.

When the job and the plist are gone, uninstall clears the record only if all of these
hold, and otherwise exits 1 and keeps it:

- every recorded process is confirmed gone: its pid is absent, belongs to a process
  with another start time, or predates this boot;
- no process was left unidentified;
- `127.0.0.1:PORT` is free;
- if no process was ever identified (the job was never seen, or only seen without a
  pid), neither log file exists. A job that was installed but never started has no log, so
  uninstall completes at once. That inference needs launchd to create the log files when
  it starts the job, which [#1149](https://github.com/chrisbanes/cab/issues/1149)
  checks.

The message names the unmet condition and the read-only checks (`launchctl print
system/<label>` exits 113, `lsof -nP -iTCP:PORT -sTCP:LISTEN` prints nothing,
`ps -axo pid,lstart,command` shows no release `cli.js` process). Run uninstall again
once the process has exited, or, after confirming nothing runs, delete the record and
the staged plist by hand. When it completes it removes the staged plist and the record and
exits 0 with `"complete":true`; that is also the point from which `service install`
restores the LaunchAgent, and until then install in the other mode, and upgrade, stay
refused. It refuses, changing nothing, when a daemon job or plist exists without a
record, or differs from it. Data, auth, snapshots, releases and logs are kept as with
the LaunchAgent.

The JSON results include `"mode"` on install and uninstall; daemon install adds
`"started"` and `"steps"`, and daemon uninstall adds `"complete"` and, while it is
false, `"steps"`.

**Credentials on a daemon host.** A daemon starts before anyone logs in, so it
cannot read the login keychain. The Codex login must be file-based
(`~/.codex/auth.json`) so cab can link it; a keychain-backed Codex login cannot be
used. A Claude token configured as a
[`file:` reference](#claude-subscription-token) stays readable; a Claude or Codex
login that lives only in the keychain does not. For GitHub, use a file-based
`gh` login: run `gh auth login --insecure-storage` on the Mac. That keeps the token
in plaintext in `~/.config/gh/hosts.yml` (mode `0600`) instead of the keychain, and
it serves discovery, source reads and agents' `git push` through the existing
`gh:github.com` reference and gh's git-credential helper. The plaintext token at
rest is the cost; anything running as you can read it. Install in daemon mode,
and `cab doctor` on a host with a daemon install record under the default
state directory, warn on stderr (exit status and stdout unchanged) when
`gh auth status --json hosts` reports the keychain as the token source, without
reading the token. The probe runs `gh` in exactly the environment the plist gives the
job (its fixed `PATH`, so `gh` must be in `/opt/homebrew/bin` or `/usr/local/bin`, and the
daemon account's `HOME`), not your shell's: `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, `GH_TOKEN`
and the rest do not apply, because launchd passes none of them, so the daemon reads
`~/.config/gh/hosts.yml` of its own account. Run `gh auth login --insecure-storage` as
that account with those variables unset, and the warning names the HOME it checked. A host that installed with a custom `--state-dir` gets only
the install-time warning. The delivery credential is `env:` only and neither plist
carries an environment variable, so delivery cannot be configured under either mode
yet. This is a known gap.

**Reboots.** With FileVault on, the disk stays locked after a power cut or an
ordinary restart until someone enters the password at the console, so nothing,
daemon included, starts. A planned restart or an OS update that must come back
unattended uses `sudo fdesetup authrestart`, which unlocks once for the next
boot. After a power cut the service stays down until someone unlocks the disk;
cab does not recover that case.

#### Real-host qualification procedure (#1149)

Nothing in the automated tests or the bounded evidence installs a real
LaunchDaemon, uses `sudo`, reboots, or reads before a GUI login. The
[evidence record](../evidence/1144-launchdaemon-mode-2026-10-17.md) marks those
untested. [#1149](https://github.com/chrisbanes/cab/issues/1149) runs them on the
maintainer's Mac:

1. Switch the gh login to file storage (`gh auth login --insecure-storage`) and
   confirm `gh auth status --json hosts --jq '.hosts["github.com"][]|.tokenSource'`
   prints a path, not `keyring`.
2. If the LaunchAgent is installed, run `cab service uninstall`. Then run
   `cab service install --mode daemon`, the two printed `sudo` commands, and
   the install command again from the installed release's `bin/cab` with no
   TARBALL; it must report `"started":true`.
3. Run `sudo fdesetup authrestart`. Without logging in, collect from another
   machine or after the later login: `sudo launchctl print system/local.cab.service`
   state and pid; `ps -o lstart= -p <pid>` against the login time from `last -1 $USER`
   taken after you log in; the owner of the new files in `~/Library/Logs/cab`
   (launchd creates them, so this checks they belong to the account); the service
   log; and the first GitHub discovery or source-sync time, which must be before the
   login time.
4. After logging in, run `cab doctor`, and push a branch to a disposable
   repository with `git push` using `gh auth git-credential`.
5. Switch back: `cab service uninstall` with its steps, then
   `cab service install`.

Paste the commands and sanitized outputs back on the issue; never paste a token.

### Restart and host restarts

Restart the installed job with `launchctl kickstart -k
"gui/$(id -u)/local.cab.service"`; operator sessions reset and you log in
again. If the Codex App Server process exits while the service runs, the
operator workspace and `/runtime` page show "Codex runtime unavailable —
Restarting · attempt 1 of 3 · next at HH:MM". The service restarts only the
App Server, after 30 seconds, then 2 minutes, then 10 minutes; a start that
fails at boot follows the same schedule, and a restarted runtime that stays up
for 10 minutes starts a fresh count. Queued requests stay queued with the
unavailable reason and nothing new is admitted until the new App Server passes
startup and the usual admission checks; turns already running are held for
recovery and are never relaunched or resumed by the restart. After the third
failed attempt the service stops retrying, the alert reads "Retries exhausted;
turn it off and on in Settings → Runtime, or restart the service", and one
Codex runtime item appears first in the Inbox (`cab inbox list --kind
runtime`). Turning the runtime off and on in Settings → Runtime replaces it with
a fresh one and begins a new schedule; if it stays unavailable, the same
`kickstart -k` recovers it. Turning the runtime off cancels pending retries.
A planned service restart (`kickstart -k` sends SIGTERM, and Ctrl-C sends SIGINT)
differs from a crash for work in flight. The service stops admitting work,
interrupts each running task turn, lets a submission in progress finish or fail, and
waits up to five seconds. A turn it interrupts and sees end is released and queued
again once on the same thread, so the next start resumes it without a hold and
without using retries. Anything it could not see end keeps the hold described under
recovery, as does a crash or kill. That includes a runtime that stays silent and a
turn so new that App Server still refuses the interrupt ("no active turn to
interrupt"). Drafting runs and direct `run` turns keep that hold too. The wait
plus runtime stop stays under launchd's default 20-second exit timeout.

Restart state lives in memory, so a service restart starts afresh. The "next at"
time is the service's local time on the `/runtime` page and the browser's or
CLI's local time elsewhere. A browser subscribed to
[notifications](#browser-notifications) gets one notification when a runtime's retries
run out, and none again for the same episode.

The LaunchAgent in `~/Library/LaunchAgents` is meant to start the service when
the user logs into the GUI session; it does not start before login. The
[LaunchDaemon](#launchdaemon-mode) is the opt-in route to pre-login startup, whose
real-host behavior is not yet proven. Restart a daemon with
`sudo /bin/launchctl kickstart -k system/local.cab.service`; cab does not
run it. If the label is absent after a login, run
`launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/local.cab.service.plist`
and check `/app`.

### Not yet proven

The bounded live runs ([lifecycle](../evidence/980-service-lifecycle-2026-10-14.md),
[one-command install](../evidence/1080-one-command-install-2026-10-16.md)) used a
throwaway label and temporary directories. These still need the maintainer:

- the first install with the default label into the real
  `~/Library/LaunchAgents` and `~/Library/Application Support/cab`, beside
  the earlier pipeline files;
- launchd starting the job at login from the LaunchAgent after a logout or reboot;
- the LaunchDaemon on a real host: the `sudo` install, a start before any GUI login,
  GitHub discovery and an agent push using the file-based gh login at that point,
  the owner of the log files launchd creates under `UserName`, and
  `sudo fdesetup authrestart` ([#1149](https://github.com/chrisbanes/cab/issues/1149));
- an upgrade over a real data directory with projects, workspaces or a running
  turn, where the bootout interrupts work and recovery holds apply;
- installing from a CI-built tagged release, or from a browser-downloaded tarball
  with quarantine attributes;
- the install's Keychain write and browser open, which the live run replaced with
  `--token-file` and `--no-open`;
- Claude turns under launchd;
- the [#761](https://github.com/chrisbanes/cab/issues/761) cutover.

## LaunchAgent environment

The rendered LaunchAgent's `PATH` is deliberately fixed to
`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`; launchctl's observed GUI
domain does not provide the interactive shell's PATH, while `CodexRuntime`
starts the installed `codex` executable by name, `ClaudeRuntime` resolves
`claude` from the same `PATH` once when the service starts, and the runtime may
use `git` or `caffeinate`. This avoids inheriting arbitrary interactive
environment variables. Confirm `codex`, `claude` (if Claude is used), Node, the
compiled CLI, `git`, and `caffeinate` resolve to the intended installed
executables before installing. A host whose Codex or Claude installation is
outside this fixed PATH, such as Claude Code's native installer in `~/.local/bin`,
needs a Homebrew install in `/opt/homebrew/bin` or a reviewed renderer change; do
not patch launchctl's shared environment or add arbitrary plist variables locally.

After the service starts, run `cab doctor` or open Settings → Readiness. Both
show what the running service sees: Codex executable and login, git, GitHub
discovery, GitLab credentials, the Claude executable and token, runtime harness and data and auth paths, each as Pass,
Fail or Not configured with one fix line and no token value or path. The checks
change nothing and request no model turn; re-run them after any fix.

The service runs Codex in its own Codex home under the data directory
(`DATA/codex/home`) with an isolated `HOME`; `auth.json` there is a symlink to the
logged-in user's file-backed Codex login (`$CODEX_HOME/auth.json` from the service
environment, else `~/.codex/auth.json`). It does not copy, read or hash Codex
credentials, and Codex refreshes the login through the link. If readiness reports the
link replaced, remove `auth.json` from `DATA/codex/home` and restart the service; if
it reports the login file missing, run `codex login` as the service user. The separate
cab auth file is not that login. The launchd proof starts App Server and verifies authentication/config
initialization without requesting a model turn.

### GitLab credentials

Each GitLab host has one installation credential, set in Settings → GitLab
credentials: the GitLab CLI login (`glab auth login --hostname <host>`) or an
environment variable. The service runs `glab auth status --hostname <host>
--show-token` by name from the fixed `PATH` for each read, without prompts, and
never stores the token. A `GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN` or `OAUTH_TOKEN` in
the service environment overrides the stored login, and `cab doctor` reports it as
a failed GitLab credentials check: unset it, or choose an environment variable
reference. A [LaunchDaemon](#launchdaemon-mode) cannot read a keychain-backed glab
login before login; use a login glab keeps in its config file, or an environment
variable. A host that does not answer is reported as unreachable (glab within 8
seconds), not as signed out. A credential added or changed after the service started
applies at once to helper, `gh`, `glab` and Claude turn environments; a running Codex
runtime that inherited its variable or value keeps it, and `cab doctor` and Settings
report that a restart is needed until the service restarts.

### GitHub discovery credential

Project setup discovers repositories with the installation discovery credential.
On a host with an authenticated GitHub CLI (`gh auth login`), choose **GitHub CLI**
in Settings, or **Use GitHub CLI login** on the Settings GitHub discovery credential
row, on the Settings → Readiness GitHub discovery row or in project setup. The service runs `gh` by name
from the LaunchAgent's fixed `PATH`, without prompts, for each discovery read.

A launchd job in the user's GUI domain reads the keychain-backed gh login without
prompting
([evidence](../evidence/942-gh-discovery-credential-2026-10-12.md)). A
[LaunchDaemon](#launchdaemon-mode) cannot read the login keychain before login;
there, run `gh auth login --insecure-storage` so the login is file-based (a
plaintext token in `~/.config/gh/hosts.yml`, mode `0600`). If Settings
shows "gh login unreadable from the service", check `gh auth status` as the service
user. Alternatively, use an environment variable reference that names a token in
the service environment.

The service removes the discovery credential from the Codex runtime, Claude turns
and helper processes. A reference configured while the service runs is excluded
from the Codex runtime after the next restart.

### GitHub source credential

Each project's GitHub source configuration chooses its own `gh:github.com` or
`env:NAME` reference. On a [LaunchDaemon](#launchdaemon-mode) host, `gh:github.com`
works through a file-based gh login, which also serves agents' `git push` through
gh's git-credential helper; there is no `file:` GitHub reference. Discovery configuration does not select a source credential
or provide a fallback. When guided setup detects a signed-in GitHub CLI account in
the source's candidate environment and the new project has a repository, it shows
the account and records `gh:github.com` for the new project's source; otherwise the
source starts without a credential (a project with a repository says so in its ready
check; a repository-free project shows none). Change or Clear it in the project's GitHub
source settings; a cleared source stays cleared. Configure the source in project settings, preview its
current version to activate it, then refresh observations to import tasks.
Preview activation and successful import are separate evidence.

The offered GitHub CLI account, in setup and source settings, uses the same
candidate environment as an explicit gh source selection: `GH_TOKEN` takes precedence over `GITHUB_TOKEN`,
then the stored login. An invalid overriding token does not fall back to the
stored account, so setup records no default. This status-only detection does not
activate a source, and does not run `gh auth token` for a null/env source. Status uses the
candidate environment credentials to identify the offered account. Current
env-source usability remains independent of an unavailable candidate gh account.
Configured unrelated credentials, their aliases and lifetime old-token aliases
remain excluded; only the two current gh token variables are restored for this
candidate detection.

Missing or unusable credentials make source knowledge incomplete. Change or
Clear retains source definitions and task history; a fresh preview and successful
provider reads are needed for the new source version. Exact recorded commands
can still be reconciled under their original keys after Clear.

Source values and aliases are excluded from Codex spawn environments, both Claude
credential branches, helper environments and public diagnostics. Codex retains
its existing spawn snapshot until service restart after configuration changes.
Successfully resolved gh values are remembered for process-lifetime exclusion
and redaction only, never reused for credential reads or persisted. Each value is
bounded to 512 bytes; distinct rotations grow this in-memory exclusion set until
restart. Agents able to reach the host keychain can run gh independently; this
is not a separate cab execution sandbox.

Before reverting to older env-only source-reader code, Clear gh source references
or change them to available environment references using the current operator
surface. Older code cannot consume a persisted gh source reference; this is a
reader compatibility limitation, not a demonstrated startup schema failure.
Take the normal verified snapshot before reverting.

Credential-aware synchronization keeps rate-limit pauses in memory by resolved
token identity. A rotated token can recover immediately, while the same token
waits until its reset; each read resolves freshly before checking that pause.
Operator previews do not inherit sync pauses. Source observation readbacks use
four request-local workers and share a login probe only across identical captured
gh contexts, with a fresh token command per selected-gh status. Each request and
source-version fence retry gets a fresh probe scope. These bounds do not establish
aggregate process or host keychain containment.

### Disposable source qualification

`test/sources/credential-qualification/live-source-credential.mjs` supports preparation separately from launch.
The lead supplies exact private root/label/Node/compiled-CLI/port and already-read
complete one-page Project metadata: one issue identity, narrow repository/issue/
ready-for-agent filter, readiness label and candidate SHA. Preparation performs
no provider, gh, model or launchctl calls:

```sh
/absolute/pinned/node test/sources/credential-qualification/live-source-credential.mjs --prepare-only /absolute/private/input.json
```

Preparation creates an exclusive 0700 root with private data/auth/log/plist paths,
initializes the protected auth verifier and a 0600 temporary password file, and
renders/lints the exact plist. Password/token/cookie values never enter argv,
plist, manifest or logs. Review the returned manifest path/digest, candidate,
label and bound paths before launch. The harness verifies plist/auth/compiled
tree digests again before execution.

Immediately before the first bootstrap, the lead records the single allowance
consumed durably and creates a separate private record with `consumed:true`,
`attempt:1`, `maxSeconds:300`, `maxModelTurns:0`, `maxGitHubWrites:0`, and exact
`root`, `manifest`, `manifestDigest`, `label` and `candidateSha` bindings. The
harness never edits or resets the lead's allowance ledger:

```sh
/absolute/pinned/node test/sources/credential-qualification/live-source-credential.mjs --live --one-attempt --max-seconds 300 --prepared /absolute/private/prepared.json --consumed-record /absolute/private/root-consumed.json
```

The outer monotonic 300 second deadline starts before bootstrap. Startup and
operator authentication have 60 seconds; preview has 60 seconds with at most one
same-key 30 second reconciliation after an unknown reply; refresh has 90 seconds.
The final 30 seconds are reserved for cleanup. A private exclusive attempt marker
prevents a second bootstrap from the same preparation. The exported bootstrap
boundary also requires a callback, which offline tests exercise without launching.

A bootstrap rejection or unknown result never establishes job ownership. Before
any bootout, reconcile the exact job's private plist path, program arguments and
observed PID's command against the prepared Node/CLI/data/port bindings, within
the existing deadline. This reconciliation also applies when startup failed
before its first PID capture. Foreign or unproved ownership retains the fixture
without bootout or signals; label presence or preflight absence is insufficient.

Only proved ownership permits stopping the exact created GUI job. After label
absence, recorded owned process exit and closed loopback port are proved, inspect
only the two owned stdout/stderr logs for standard GitHub token prefixes and fixed
qualification canaries. A failed inspection returns controlled metadata and retains the private
fixture and original protected logs for recovery; matched content is never
extracted, copied, printed or included in public evidence. Delete the exact
disposable root only after that inspection passes within the cleanup deadline.
Uncertain ownership or an exhausted cleanup deadline retains private state and
reports an unknown hold. Never kill a process by name or infer stopped
provider reads from synchronizer shutdown. Production and Haze installations
remain separate. The bounded source qualification passed on candidate
`9395520e1cb23937f0e7f399b5c3d7bef67c4d89`: real preview and activation preceded
the separate import, with zero model turns/GitHub writes and proved cleanup. See
[the dated evidence](../evidence/944-gh-source-credential-2026-10-13.md) for
exact results and limits. Later sync-pause/status-fanout/account-offer repairs
use controlled fake and full-check evidence; they have not received another live
run. Its single allowance is consumed; rerunning requires separate authorization
and a fresh bound preparation.

### Claude executable

Claude profiles run the `claude` command (Claude Code) that resolves on the
service's fixed `PATH`; cab does not redistribute it. Install it so it
resolves there (Homebrew puts it in `/opt/homebrew/bin`), then turn Claude off and
on in Settings → Runtime (or restart the service) after installing or upgrading it:
the runtime looks `claude` up when it starts.
A `claude` that does not resolve on the `PATH` when the service starts leaves the
Claude runtime not enabled for that run. Settings → Runtime shows it as Not enabled,
with no alert, as if Claude were not configured, and Claude work waits visibly with
the not-enabled reason; it never falls back to another runtime. Codex and the
service are unaffected. The Claude switch can already be on: after installing
`claude`, turn Claude off and on in Settings → Runtime (or restart the service) to
start it. A `claude` that resolves but whose runtime fails shows as unavailable
instead. Readiness shows the Claude executable as Not configured while `claude` is
missing or Claude is disabled in Settings → Runtime; an active Claude profile then
fails Runtime harness instead.

cab reports the version `claude --version` prints and never compares it. Only
the Claude Code version the pinned SDK declares was qualified; another version may
fail at startup or enforce the sandbox, tool and permission controls differently.
That is a disclosed limit, not a fail-closed boundary
([ADR-1011](../adr/1011-packaging-and-distribution.md)).

### Claude subscription token

Claude profiles need the operator's own subscription token from
`claude setup-token`. The installed service reads it from an owner-only file, so
the plist and its environment need no Claude variable. Settings → Runtime → Add
Claude shows these commands and a suggested path. Create a private real directory
(not a symbolic link) and an empty mode `0600` file:

```sh
mkdir -m 700 -p "$HOME/.cab/claude"
install -m 600 /dev/null "$HOME/.cab/claude/claude-token"
```

Then copy the token printed by `claude setup-token` and write it from the clipboard
without shell history or argv. Type these two lines; do not copy them with the
commands above, because `pbpaste` reads the clipboard and a copied command replaces
the token:

```sh
pbpaste > "$HOME/.cab/claude/claude-token"
stat -f '%Su %Lp' "$HOME/.cab/claude/claude-token"
```

`stat` must show the service user and `600`. In Add Claude, click Set: the field
starts with the reference for this path, for example
`file:/Users/you/.cab/claude/claude-token`, so you can save it as it stands. In
the Claude token row in Settings, or when the field opens empty, enter `file:`
followed by the absolute path; `~` and `$HOME` are not expanded and are refused. The
Token readable row then shows Pass, or the unsafe-file reason without the path or value.
The file is checked
whenever a Claude turn needs it: a symbolic link, a file owned by another user, any
group or other permission bit, more than 4096 bytes, a missing or empty file, or
content other than one token makes Claude work wait with a visible reason, and
the row shows the token unavailable. To rotate, write the new token to a new mode
`0600` file in the same directory and `mv` it over the old one; the next turn uses
it without a restart. A launchd-installed Claude turn with a real token is
untested; the bounded live journeys ran the service outside launchd.

### Browser notifications

Settings → Notifications turns on browser notifications, one browser at a time.
Nothing is sent or read, and no subscription is stored, until the operator does that. While at least one browser
is subscribed, the operator process reads the same Inbox as the UI every 15 seconds and
sends one encrypted Web Push per newly seen alert to each active browser; with none, it
reads nothing. A push carries a title ("Question in Relay: 2 waiting", "Codex runtime
unavailable") and an Inbox link, no question text, task content, error text or credential.
Opening it shows that request after sign-in. It never answers or approves anything.
Alerts already in the Inbox when a first browser subscribes are recorded silently; that
start ends with the first complete Inbox read, or after three partial reads in a row.

- **Key.** The operator process creates `STATE/auth/operator-push-vapid.json` (mode `0600`,
  owner-only, beside the operator auth file) when it first starts. It is the same for
  a LaunchAgent and a [LaunchDaemon](#launchdaemon-mode) install, a fresh or an upgraded
  one: the daemon runs as the same non-root account and uses the same auth directory, so
  nothing changes in either plist. A key file
  that is a symbolic link, owned by another user, readable by others, oversized or corrupt
  is refused: Settings → Notifications then reads "Unavailable on the service" and the rest
  of the operator UI keeps running. The private key lives only in this file, never in the
  database, the environment, logs or any API response.
- **Rotation.** There is no command. Stop the service, delete the key file, start the
  service, then turn notifications on again in each browser. At startup, subscriptions
  made under the old key are marked revoked ("Key changed — turn on again").
- **Network.** The service makes outbound HTTPS requests only to the browsers' push
  services: `fcm.googleapis.com`, `updates.push.services.mozilla.com`,
  `web.push.apple.com` and subdomains of `push.apple.com` and `notify.windows.com`. It
  accepts no other host, port, IP address or redirect, sends at most four requests at a
  time with a 10-second timeout, and retries a throttled or unavailable push service after
  30 seconds and 2 minutes. A push service that says a subscription no longer exists
  (404 or 410) revokes it; a request it rejects (400, 401, 403, 413) is recorded on the
  device and retried never.
- **Limits.** Delivery is at most once: an alert is recorded before it is sent, so a crash
  between the two loses that push and never repeats one, and the retry queue is in memory.
  The Inbox remains the source of truth. A browser that rotates its push endpoint is not
  followed; its next push answers 404 or 410, the row is revoked as removed by the push
  service, and Settings offers Turn on again. Runtime restart state is in memory too, so a
  runtime that fails again after a service restart is a new episode and notifies again.
- **Backups.** A snapshot holds the subscriptions (the push endpoint and keys are needed to
  send) and the record of alerts already sent, not the key file. Restored on a host
  without the key file, the service creates a new key and revokes the restored
  subscriptions as key changed.
- **Qualification.** The [host browser check](../evidence/2026-10-17-web-push-host-browser.md)
  covers Chrome on the host only. Phone delivery and other-device delivery are not qualified
  ([#1150](https://github.com/chrisbanes/cab/issues/1150)).

## Execution diagnostic retention

Execution diagnostics expire after `CAB_DIAGNOSTIC_RETENTION_DAYS` days
(1–365, default 30), checked hourly; past `CAB_DIAGNOSTIC_STORAGE_MIB` (16–1048576,
default 1024) the oldest items are evicted. An invalid value stops the service
at startup. The supported LaunchAgent route is
`service install` or `service upgrade` with `--diagnostic-retention-days N|default`
and `--diagnostic-storage-mib N|default`. A value is written into the
LaunchAgent environment and recorded, so a later upgrade keeps it unless an
option changes it; `default` removes the variable and the service default
applies. An out-of-range value is refused before anything changes. To change a
value on an installed service, run `service upgrade` with the installed release
directory and the new option: it stops the job,
re-renders the plist, restarts the job and checks readiness. A hand-edited
plist is unsupported: upgrade refuses an activation that no longer matches its
recorded hash. A release built before these options rejects an install record
that holds them, so before moving to such a release run `service upgrade` with
`default` for each value.

The quota counts stored diagnostic payload text only, not the database, WAL or
filesystem. Pruning deletes payload items only and keeps per-execution gap
counts. There is no manual purge, and older snapshots keep any payloads they
held until those snapshots are deleted.

## Startup snapshot

Whenever the service starts against an existing database with migrations pending, it
takes and verifies an offline snapshot before anything migrates, while it holds the data
directory's exclusive owner lock. Pending is decided by the migration level, not the
package version: the build has a `MIGRATION_LEVEL` (`src/standalone/startup-snapshot.ts`),
and the database records, in its `startup_migration_level` table, the level its last
completed start reached. A lower recorded level (or none, for data an earlier build wrote)
is pending; an equal level takes no snapshot, so two builds of one version snapshot each
other's data only when the newer one raises the level, and a version change alone takes
none. A developer bumps the level with any schema change, and for a data-only migration
too, which no test can detect; a guard test pins the schema each level creates and fails
until the level is bumped for a schema change.
The snapshot is `STATE/snapshots/startup.<from>-to-<to>.<UTC time>-<id>` (the levels), in a
private directory beside the data directory (`0700`, owned by the service account;
the service creates it and refuses to start if it is anything else). If creating or
verifying the snapshot fails, the service refuses to start and the database stays
unmigrated; a partial snapshot is never reused or deleted, and the next start takes a
new one. The level is recorded only after every migration has run, so an interrupted start
leaves the old level. `STATE/data/startup-state.json` (format `cab-startup-state-v2`) records
the verified snapshot for the latest level change, so repeated or interrupted starts reuse it
rather than taking another; a state file of the earlier release-keyed format is accepted
and rewritten, but names no snapshot to reuse. The same applies to a LaunchDaemon. A fresh
data directory takes no snapshot. The level lives in the database, so a directory restored
from a snapshot already at the current level takes none either; a snapshot from before a
migration is behind the build and is snapshotted again.

A service refuses to start, before it writes anything, on a database at a higher migration
level than the build applies, or whose schema version it does not support. The refusal
reaches the launchd log as a `StartupRefusedError` with a stable `code`
(`startup-schema-newer`, `startup-snapshot-failed`, `startup-snapshot-directory`,
`startup-state-invalid`, `startup-database-invalid`), and `service upgrade` reports the
stage and logs, so a refusal is readable with no service endpoint running.

## Offline snapshot and restore

For a separate backup,
stop the job with `launchctl bootout "gui/$(id -u)/local.cab.service"`,
wait for its process to exit, and confirm the label is absent (`launchctl print`
fails). Then back up to a new snapshot directory and verify it before relying on
it, and start the job again with `launchctl bootstrap "gui/$(id -u)"
~/Library/LaunchAgents/local.cab.service.plist`:

```sh
cab snapshot create "$STATE/data" "$STATE/snapshots/manual-<date>"
cab snapshot verify "$STATE/snapshots/manual-<date>"
```

`cab` here is any release's `bin/cab`; from a checkout,
`npm run operations -- backup|verify|restore` runs the same operations.

The snapshot is a private directory containing only `standalone.sqlite` and a
strict `manifest.json` commit marker. Node's SQLite backup API captures the
whole database without table-specific export. The manifest records the creating
Node version as provenance; snapshots from Node 24 or later, including those made
before Node 26 became the minimum, verify and restore on any supported runtime. Verification
checks SQLite integrity, schema version/fingerprint, database bytes, and a deterministic
typed logical-content digest. A database owner lock is required; no process ID
or timestamp is treated as ownership evidence. The owner must already be a
regular, non-symlink file: offline backup never creates installation metadata
in the source. A marked directory without an owner file is refused before
modification.

Restore only to a distinct, nonexistent data-directory path whose parent is
already private:

```sh
cab snapshot restore SNAPSHOT /absolute/private/cab-data-restored
cab snapshot verify SNAPSHOT
```

The restore command verifies the snapshot and restored database, creates a
fresh empty `.cab-owner.sqlite` as destination installation metadata, then
promotes its incomplete sentinel to `.cab-standalone` as its final commit.
It never copies the source owner file or SQLite WAL/journal files. The
second `verify` checks the snapshot, not the restored directory. Do not start a
restore destination unless `restore` exits successfully; successful restore
returns the matching manifest identity. To run the installed service on
restored data, `cab service uninstall`, move `STATE/data` aside, restore
into `STATE/data` and `cab service install` again. Service startup performs normal
migrations and workspace/execution reconciliation before scheduler admission;
restore itself neither clears holds nor upgrades domain state.

The SQLite snapshot includes retained result-evidence and review-anchor BLOBs,
their manifests and their draft/submitted references. Workspace archive or
cleanup removes managed files but does not remove evidence still referenced by
a result or submitted context. Logical retained-payload limits are 32 MiB per
result, 128 MiB of result payload per task, 16 MiB of review context per task,
and 512 MiB for retained result and review payloads per installation; individual
text, image/PDF, diff and anchor limits are recorded in `docs/SPEC.md`. These
limits count BLOB content, not SQLite pages, indexes, WAL files or filesystem
overhead. A snapshot preserves database evidence only; it does not restore the
managed workspace needed for live-file inspection.

The database snapshot excludes managed worktree contents, repository state,
operator auth files, Codex/provider records, logs and external effects. Stored
workspace paths remain evidence. A managed workspace restored under a different
installation root is rejected by identity before access to the old path and
remains held for operator recovery; external workspace contents are not copied.
Recovery receipts still need to match the persisted execution generation and
independent Stop, writer and capacity holds. A deterministic fixture proves exact
receipt reconciliation and one post-restore admission. The disposable launchd
proof instead preserves a paused project and unready task across restore/restart
and admits no work; it does not inject a live recovery receipt.

If backup fails, the source is not changed; a missing owner file is rejected
before it can be created. An operation-created snapshot path may remain
incomplete and is never a valid backup. If restore fails after its
sentinel is created, the destination retains
`.cab-restore-incomplete`, and both verification and service startup refuse
it. Inspect and remove only the exact private path created by that failed
operation, after confirming no process owns or uses it. Restore atomically
reserves the exact destination name with `mkdir`; there is an unavoidable
interval after that reservation and before sentinel creation when a killed
restore can leave an empty directory indistinguishable from a deliberately
created fresh installation. Track the intended path out-of-band and never
start it until restore succeeds and the snapshot is verified.

[Final recovery evidence](../evidence/s08b-final-recovery.md) covers complete macOS
identity under the rendered environment, an exact owned-child recovery receipt,
and current-schema CLI restore checks. See the [named Haze cutover
proposal](standalone-cutover-proposal.md) for the separate execution gates. These
checks do not establish deployment or cutover.

Production deployment and actual cutover need separate authorisation, including
safe disposition of old work, preservation/rollback and verification that no
competing scheduler or writer remains ([#761](https://github.com/chrisbanes/cab/issues/761)).
Physical sleep/wake proof ([#732](https://github.com/chrisbanes/cab/issues/732))
remains required before operational use on the Mac. Do not migrate old work or
enable competing production work based only on this snapshot or on recovery
qualification. A separately authorised host-restart test may be needed for final
recovery qualification.

## Release build

`scripts/package-release.mjs` builds the self-contained `darwin-arm64` release
([ADR-1011](../adr/1011-packaging-and-distribution.md)). CI uses it for tagged
releases, and it also builds a chosen commit into an immutable local directory for a
personal instance. A local build is for testing and evidence; it is not the Haze
cutover and must not take over projects the prototype owns. Cite the commit with
any evidence it produces.

Run it from a checkout on an Apple silicon Mac with any Node 26 or later:

```sh
node scripts/package-release.mjs build COMMIT
```

The script archives exactly `COMMIT` and downloads the official
`node-v<.nvmrc>-darwin-arm64.tar.gz` from `nodejs.org`. It refuses that Node
unless the tarball's SHA-256 matches the single entry for that file in the release's
`SHASUMS256.txt`. Verification happens before extraction, and there is no way to skip
it. With that Node and the pinned npm, it runs `npm ci`, `npm run build` and
`npm prune --omit=dev`. Like CI, it ignores `~/.npmrc`, so user registry, proxy or auth
settings do not apply. It then removes the Claude Agent SDK's platform packages,
which bundle a `claude` binary that the release does not redistribute, and fails if
any of them or any dev-only package from the lockfile remains.

By default the output goes to `~/.config/cab-dev/builds/<sha>/`. The script
creates private `data/`, `auth/` and `snapshots/` directories beside `builds/`,
refuses symlinks there, and prints the start command. `--out DIR` writes the output
to `DIR` instead and creates no state directories. Work is staged in
`<output>.partial` and renamed on success; the script refuses an existing output or
partial directory, so remove it to rebuild. The output contains:

- `cab-<version>-darwin-arm64.tar.gz`, the release;
- `cab-<version>-darwin-arm64/`, the same release unpacked;
- `manifest.json`, a copy of the release manifest;
- `SHA256SUMS` for the tarball and manifest, checked with `shasum -a 256 -c SHA256SUMS`.

A release directory contains `bin/cab` (the operator CLI), `node/bin/node` and
its licence, `dist/src`, `dist/operator`, the production `node_modules`,
`package.json`, `package-lock.json`, `LICENSE` and `manifest.json`. It needs `codex`
on `PATH` like a checkout build. It does not include `claude`: a release without one
on the service `PATH` shows Claude as Not enabled, and installing `claude` on that
`PATH` enables it once Claude is turned off and on in Settings → Runtime, or after a
restart (see [Claude executable](#claude-executable)).
Codex remains the default harness.

`manifest.json` records the schema `cab.release/v1`, name, version, platform,
commit, the Node version with the official tarball's SHA-256, and a tree digest.
The `cab-tree-sha256/v1` digest walks the release directory, excluding the
root `manifest.json`, and sorts relative POSIX paths by byte order. Each regular
file contributes `file <mode> <sha256> <path>\n`, where `<mode>` is `0755` when any
execute bit is set and `0644` otherwise. Each symlink contributes
`link <target> <path>\n`. Any other entry type is an error. The digest is the
SHA-256 of the concatenated lines.

To check a release, run:

```sh
node scripts/package-release.mjs verify PATH/TO/cab-<version>-darwin-arm64.tar.gz
```

`verify` checks `SHA256SUMS` when it sits beside the tarball, unpacks into a fresh
temporary directory whose path contains a space, recomputes the tree digest, and
repeats the package checks. It then uses a temporary `HOME` and a `PATH` of only the
system directories plus a generated fake `codex`, with no `node`. In that
environment it runs `bin/cab --version`, initializes operator auth, starts the
service against a fresh data directory, and expects the operator UI and one of its
assets within 120 seconds, then `/app/service-worker.js` as uncached JavaScript with a
push handler and no scope wider than `/app/`, before stopping that service. It does not exercise a real
Codex login.

To run a release as the service, use [`cab service install`](#install) with its
tarball, or [`upgrade`](#upgrade) with a release unpacked into
`STATE/versions/<version>`.

### Tagged releases

`.github/workflows/release.yml` publishes a release when a `v*` tag is pushed. It runs
the CI `check` job, refuses a tag other than `v` plus the `package.json` version,
builds and verifies the release on a macOS arm64 runner, and attaches the tarball,
`SHA256SUMS` and `manifest.json` to a GitHub Release for that tag. Rerunning a failed
release job finishes a draft release that the failed run left behind; it refuses to
replace a published release. Manual runs and pull requests that change the packaging
files build and verify the same tarball and upload it only as a workflow artifact. No
release has been published yet.

The same workflow packs the npm package once on the macOS runner
(`package-release.mjs pack-npm --out DIR`: a clean `npm ci` and build of the commit, one
`npm pack`, and `npm-package.json` with the name, version, `integrity`, `shasum`, file
name and commit), installs that `.tgz` into a temporary prefix and `HOME`, and serves
the operator UI from it (`verify-npm`). Pull requests and manual runs stop there and
upload the `.tgz` and record as an artifact. For a pushed `v*` tag, after CI and the
package job, the `npm` job runs in the `npm` GitHub environment with `id-token: write`,
re-checks the record against the downloaded `.tgz` (`check-npm`) and publishes exactly
that file with `npm publish FILE --access public`, using npm trusted publishing (OIDC)
with provenance and no stored token. A rerun publishes nothing when `npm view` shows the
same `integrity` and fails on a version that holds other content. The GitHub Release job
then attaches `npm-package.json`.

The npmjs.com side is configured by the maintainer, not by the workflow: a trusted
publisher for `@chrisbanes/cab` (repository `chrisbanes/cab`, workflow `release.yml`,
environment `npm`), optionally with required reviewers on the `npm` environment. If npm
needs the package to exist before a trusted publisher can be added, the first version is a
one-time maintainer bootstrap. No version has been published, and a tag push is the
publication. Rerun a failed publish with "Re-run failed jobs": a full rerun packs again,
and the publish check passes only if the registry's integrity matches the new bytes.

## Checkout and low-level procedure

`cab service` is the supported route. From a checkout, or to inspect each
step, the pieces run directly. Keep all data, auth, snapshot, restore, plist and
log paths separate, absolute and lexically canonical, with every existing path
component a real directory (not a symlink), and private to the operator.
`npm run operations` and `npm run operator-auth` remain available and behave as
before.

### Build and authenticate from a checkout

Use the Node.js version in `.nvmrc` and the npm version in `packageManager`
(`package.json`); later majors are not qualified. Build from a reviewed
checkout and keep the Node executable and compiled CLI at stable absolute paths that remain
available to the logged-in user:

```sh
node --version
npm --version
npm ci
npm run check
npm run build
```

Create the auth parent directory with mode `0700`, then initialize an
independent cab operator password. The command reads the password from a
hidden terminal prompt; do not put it in shell history, argv, a plist or logs.
The auth file contains a password verifier, not the password, and is mode
`0600`:

```sh
npm run operator-auth -- init /absolute/private/auth/operator-auth.json
```

Create an empty private standalone data directory and a private log directory.
The first service start creates `.cab-standalone` and acquires
`.cab-owner.sqlite`. Do not point the service at a prototype, an
unmarked non-empty directory, a symlink, or an existing unrelated install.

### Render a LaunchAgent by hand

Choose a unique reverse-DNS label, an available loopback port, and private
stdout/stderr paths whose parent directories already exist. Render the plist
using the built CLI; the renderer validates its absolute paths and writes only
the exact `${label}.plist` destination, exclusively, with mode `0600`:

```sh
npm run operations -- render-launch-agent \
  com.example.cab \
  /absolute/path/to/node \
  /absolute/path/to/cab/dist/src/standalone/cli.js \
  /absolute/private/cab-data \
  /absolute/private/auth/operator-auth.json \
  http://127.0.0.1:8787 8787 \
  /absolute/private/logs/operator.stdout.log \
  /absolute/private/logs/operator.stderr.log \
  /absolute/private/launch-agents/com.example.cab.plist
```

To set the diagnostic retention limits, append the two optional flags after the
plist path (1–365 days, 16–1048576 MiB); omitted, the service defaults apply.
Malformed or out-of-range values print usage and exit 2:

```sh
npm run operations -- render-launch-agent \
  com.example.cab \
  /absolute/path/to/node \
  /absolute/path/to/cab/dist/src/standalone/cli.js \
  /absolute/private/cab-data \
  /absolute/private/auth/operator-auth.json \
  http://127.0.0.1:8787 8787 \
  /absolute/private/logs/operator.stdout.log \
  /absolute/private/logs/operator.stderr.log \
  /absolute/private/launch-agents/com.example.cab.plist \
  --diagnostic-retention-days 14 --diagnostic-storage-mib 512
```

The current renderer sets `RunAtLoad=true` and `KeepAlive=false`; launchctl,
not automatic crash relaunch, owns restart. The plist contains the Node/CLI,
operator command, data directory, port, separate auth-file path, canonical
origin, fixed non-secret PATH, the diagnostic retention variables when set,
and private log paths. It contains no password
or shell wrapper. Before bootstrap, inspect and lint the exact plist:

```sh
/usr/bin/plutil -lint /absolute/private/launch-agents/com.example.cab.plist
/usr/bin/plutil -p /absolute/private/launch-agents/com.example.cab.plist
```

### Foreground local CLI access

The shared startup path creates installation-bound local CLI material at
`DATA_DIR.local-access/connection.json`, outside snapshots and task workspaces.
With a foreground `operator` server running under the same OS account:

```sh
cab auth status --local --local-state /absolute/private/cab-data
cab project list --local --local-state /absolute/private/cab-data
cab connection local foreground --local-state /absolute/private/cab-data
cab connection use foreground
```

This grants supported CLI read/write authority through live HTTP; it needs no
token or Keychain login. Keep the sidecar directory 0700 and its file 0600,
owned by the service account, with real private parent paths. Restart publishes
fresh material without a new login. Missing, unsafe, malformed, stale or
wrong-installation material fails with a repair instruction. Never copy it into
workspaces, snapshots or support output. Local logout explains OS-account access
and cannot disable it. Existing selected token connections retain their scope,
expiry, revocation and logout; adopting an existing connection is deliberate,
checks its installation and preserves prior config/token/file on failure.

The browser still requires its password; local CLI access retains all route,
revision, receipt, approval and hold checks. It trusts the OS account, without
process isolation; managed assignments are refused before local reads or HTTP.
Installed-service record discovery and lifecycle integration remain outstanding
in the sibling of #1413. The installation and upgrade instructions above retain
their existing token workflow until that integration ships.

### Start, inspect, restart and stop by hand

Run these commands in the logged-in user's GUI launchd domain, using the exact
label and plist you just reviewed:

```sh
launchctl bootstrap "gui/$(id -u)" /absolute/private/launch-agents/com.example.cab.plist
launchctl print "gui/$(id -u)/com.example.cab"
launchctl kickstart -k "gui/$(id -u)/com.example.cab"
launchctl print "gui/$(id -u)/com.example.cab"
launchctl bootout "gui/$(id -u)/com.example.cab"
launchctl print "gui/$(id -u)/com.example.cab"  # must fail after bootout
```

After bootstrap, request the configured loopback `/login` page and authenticate
with the separate cab password. Do not expose this local HTTP listener
through a tunnel or network proxy as part of this procedure. After
`kickstart -k`, expect in-memory operator sessions to reset and log in again.
Before deleting a plist or fixture, wait for the exact service process to exit
and verify that the label is absent. An active service holds the data-directory
owner lock, so offline backup refuses rather than racing it.
