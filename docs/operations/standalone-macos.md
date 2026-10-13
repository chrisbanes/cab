# Standalone macOS operations

This procedure applies to the standalone Ensemble service only. It does not
read or migrate the installed Haze prototype, install a persistent service on
its own, or authorize production deployment or cutover. Keep all data, auth,
snapshot, restore, plist and log paths separate, absolute and lexically
canonical, with every existing path component a real directory (not a symlink),
and private to the operator.

## Runtime and authentication

Use the Node.js version in `.node-version` and the npm version in `packageManager`
(`package.json`). Node.js `26.9.0` has passed the checks
and the fixture service/operator journey
([evidence](../evidence/node-26-compatibility-2026-10-09.md)) but is not the
deployment baseline; later majors are not qualified. Build from a reviewed
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
independent Ensemble operator password. The command reads the password from a
hidden terminal prompt; do not put it in shell history, argv, a plist or logs.
The auth file contains a password verifier, not the password, and is mode
`0600`:

```sh
npm run operator-auth -- init /absolute/private/auth/operator-auth.json
```

Create an empty private standalone data directory and a private log directory.
The first service start creates `.ensemble-standalone` and acquires
`.ensemble-owner.sqlite`. Do not point the service at a prototype, an
unmarked non-empty directory, a symlink, or an existing unrelated install.

## Generate and review a per-user LaunchAgent

Choose a unique reverse-DNS label, an available loopback port, and private
stdout/stderr paths whose parent directories already exist. Render the plist
using the built CLI; the renderer validates its absolute paths and writes only
the exact `${label}.plist` destination, exclusively, with mode `0600`:

```sh
npm run operations -- render-launch-agent \
  com.example.ensemble \
  /absolute/path/to/node \
  /absolute/path/to/ensemble/dist/src/standalone/cli.js \
  /absolute/private/ensemble-data \
  /absolute/private/auth/operator-auth.json \
  http://127.0.0.1:8787 8787 \
  /absolute/private/logs/operator.stdout.log \
  /absolute/private/logs/operator.stderr.log \
  /absolute/private/launch-agents/com.example.ensemble.plist
```

The current renderer sets `RunAtLoad=true` and `KeepAlive=false`; launchctl,
not automatic crash relaunch, owns restart. The plist contains the Node/CLI,
operator command, data directory, port, separate auth-file path, canonical
origin, fixed non-secret PATH, and private log paths. It contains no password
or shell wrapper. Before bootstrap, inspect and lint the exact plist:

```sh
/usr/bin/plutil -lint /absolute/private/launch-agents/com.example.ensemble.plist
/usr/bin/plutil -p /absolute/private/launch-agents/com.example.ensemble.plist
```

The `PATH` is deliberately fixed to
`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`; launchctl's observed GUI
domain does not provide the interactive shell's PATH, while `CodexRuntime`
starts the installed `codex` executable by name and the runtime may use `git`
or `caffeinate`. This avoids inheriting arbitrary interactive environment
variables. Confirm `codex`, Node, the compiled CLI, `git`, and `caffeinate`
resolve to the intended installed executables before loading the job. A host
whose Codex installation is outside this fixed PATH needs a reviewed renderer
change; do not patch launchctl's shared environment or add arbitrary plist
variables locally.

The service uses the logged-in user's existing Codex login; it does not copy,
read, or alter Codex credentials. The separate Ensemble auth file is not that
login. The launchd proof starts App Server and verifies authentication/config
initialization without requesting a model turn.

### GitHub discovery credential

Project setup discovers repositories with the installation discovery credential.
On a host with an authenticated GitHub CLI (`gh auth login`), choose **GitHub CLI**
in Settings, or **Use GitHub CLI login** in setup. The service runs `gh` by name
from the LaunchAgent's fixed `PATH`, without prompts, for each discovery read.

A launchd job in the user's GUI domain reads the keychain-backed gh login without
prompting
([evidence](../evidence/942-gh-discovery-credential-2026-10-12.md)). If Settings
shows "gh login unreadable from the service", check `gh auth status` as the service
user. Alternatively, use an environment variable reference that names a token in
the service environment.

The service removes the discovery credential from the Codex runtime, Claude turns
and helper processes. A reference configured while the service runs is excluded
from the Codex runtime after the next restart.

### GitHub source credential

Each project's GitHub source configuration chooses its own `gh:github.com` or
`env:NAME` reference. Discovery configuration does not select a source credential
or provide a fallback. Configure the source in project settings, preview its
current version to activate it, then refresh observations to import tasks.
Preview activation and successful import are separate evidence.

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
is not a separate Ensemble execution sandbox.

Before reverting to older env-only source-reader code, Clear gh source references
or change them to available environment references using the current operator
surface. Older code cannot consume a persisted gh source reference; this is a
reader compatibility limitation, not a demonstrated startup schema failure.
Take the normal verified snapshot before reverting.

### Disposable source qualification

`test/944/live-source-credential.mjs` supports preparation separately from launch.
The lead supplies exact private root/label/Node/compiled-CLI/port and already-read
complete one-page Project metadata: one issue identity, narrow repository/issue/
ready-for-agent filter, readiness label and candidate SHA. Preparation performs
no provider, gh, model or launchctl calls:

```sh
/absolute/pinned/node test/944/live-source-credential.mjs --prepare-only /absolute/private/input.json
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
/absolute/pinned/node test/944/live-source-credential.mjs --live --one-attempt --max-seconds 300 --prepared /absolute/private/prepared.json --consumed-record /absolute/private/root-consumed.json
```

The outer monotonic 300 second deadline starts before bootstrap. Startup and
operator authentication have 60 seconds; preview has 60 seconds with at most one
same-key 30 second reconciliation after an unknown reply; refresh has 90 seconds.
The final 30 seconds are reserved for cleanup. A private exclusive attempt marker
prevents a second bootstrap from the same preparation. The exported bootstrap
boundary also requires a callback, which offline tests exercise without launching.

Cleanup boots out only the exact created GUI job. After label absence, recorded
owned process exit and closed loopback port are proved, inspect only the two owned
stdout/stderr logs for standard GitHub token prefixes and fixed qualification
canaries. A failed inspection returns controlled metadata and retains the private
fixture and original protected logs for recovery; matched content is never
extracted, copied, printed or included in public evidence. Delete the exact
disposable root only after that inspection passes within the cleanup deadline.
Uncertain ownership or an exhausted cleanup deadline retains private state and
reports an unknown hold. Never kill a process by name or infer stopped
provider reads from synchronizer shutdown. Production and Haze installations
remain separate. Live qualification is pending until dated evidence records the
actual preview, import and cleanup outcome.

### Claude subscription token

Claude profiles need the operator's own subscription token from
`claude setup-token`. The installed service reads it from an owner-only file, so
the plist and its environment need no Claude variable. Create a private real
directory (not a symbolic link) and an empty mode `0600` file, then put the token
in it without shell history or argv, for example from the clipboard:

```sh
mkdir -m 700 /absolute/private/claude
install -m 600 /dev/null /absolute/private/claude/claude-token
pbpaste > /absolute/private/claude/claude-token
stat -f '%Su %Lp' /absolute/private/claude/claude-token
```

`stat` must show the service user and `600`. In Settings, set the Claude token
reference to `file:/absolute/private/claude/claude-token`. The file is checked
whenever a Claude turn needs it: a symbolic link, a file owned by another user, any
group or other permission bit, more than 4096 bytes, a missing or empty file, or
content other than one token makes Claude work wait with a visible reason, and
the row shows the token unavailable. To rotate, write the new token to a new mode
`0600` file in the same directory and `mv` it over the old one; the next turn uses
it without a restart. A launchd-installed Claude turn with a real token is
untested; the bounded live journeys ran the service outside launchd.

## Start, inspect, restart and stop

Run these commands in the logged-in user's GUI launchd domain, using the exact
label and plist you just reviewed:

```sh
launchctl bootstrap "gui/$(id -u)" /absolute/private/launch-agents/com.example.ensemble.plist
launchctl print "gui/$(id -u)/com.example.ensemble"
launchctl kickstart -k "gui/$(id -u)/com.example.ensemble"
launchctl print "gui/$(id -u)/com.example.ensemble"
launchctl bootout "gui/$(id -u)/com.example.ensemble"
launchctl print "gui/$(id -u)/com.example.ensemble"  # must fail after bootout
```

After bootstrap, request the configured loopback `/login` page and authenticate
with the separate Ensemble password. Do not expose this local HTTP listener
through a tunnel or network proxy as part of this procedure. After
`kickstart -k`, expect in-memory operator sessions to reset and log in again.
Before deleting a plist or fixture, wait for the exact service process to exit
and verify that the label is absent. An active service holds the data-directory
owner lock, so offline backup refuses rather than racing it.

After a host restart, the per-user LaunchAgent is available when that user logs
into the GUI session. Inspect the exact label; if it is absent, review the same
plist and manually bootstrap it, then verify the loopback operator page and
service state. This is the documented fallback only; the procedure does not claim
unattended pre-login service startup or recovery after a host reboot.

If the Codex App Server process exits while the service runs, the operator
workspace and `/runtime` page show "Codex runtime unavailable — restart the
service". Queued requests stay queued with that reason and nothing new is
admitted; turns already running are held for recovery. Nothing restarts the
App Server automatically, so recover with `launchctl kickstart -k` on the exact
label; startup reconciliation and the usual admission checks then apply.

## Execution diagnostic retention

Execution diagnostics expire after `ENSEMBLE_DIAGNOSTIC_RETENTION_DAYS` days
(1–365, default 30), checked hourly; past `ENSEMBLE_DIAGNOSTIC_STORAGE_MIB` (16–1048576,
default 1024) the oldest items are evicted. An invalid value stops the service
at startup. The rendered LaunchAgent sets neither variable, so a LaunchAgent
service uses the defaults; changing them there needs a reviewed renderer change.
The quota counts stored diagnostic payload text only, not the database, WAL or
filesystem. Pruning deletes payload items only and keeps per-execution gap
counts. There is no manual purge, and older snapshots keep any payloads they
held until those snapshots are deleted.

## Offline snapshot and restore

Stop the exact per-user job with `launchctl bootout`, wait for its process to
exit, and confirm the exact label is absent. Then back up to a new snapshot
directory and verify it before relying on it:

```sh
npm run operations -- backup \
  /absolute/private/ensemble-data \
  /absolute/private/snapshots/ensemble-snapshot
npm run operations -- verify \
  /absolute/private/snapshots/ensemble-snapshot
```

The snapshot is a private directory containing only `standalone.sqlite` and a
strict `manifest.json` commit marker. Node's SQLite backup API (qualified on
Node 24.21.0 and 26.9.0) captures the whole database without table-specific
export. The manifest records the creating Node version as provenance; snapshots
from Node 24 or later verify and restore on any supported runtime. Verification
checks SQLite integrity, schema version/fingerprint, database bytes, and a deterministic
typed logical-content digest. A database owner lock is required; no process ID
or timestamp is treated as ownership evidence. The owner must already be a
regular, non-symlink file: offline backup never creates installation metadata
in the source. A marked directory without an owner file is refused before
modification.

Restore only to a distinct, nonexistent data-directory path whose parent is
already private:

```sh
npm run operations -- restore \
  /absolute/private/snapshots/ensemble-snapshot \
  /absolute/private/ensemble-data-restored
npm run operations -- verify \
  /absolute/private/snapshots/ensemble-snapshot
```

The restore command verifies the snapshot and restored database, creates a
fresh empty `.ensemble-owner.sqlite` as destination installation metadata, then
promotes its incomplete sentinel to `.ensemble-standalone` as its final commit.
It never copies the source owner file or SQLite WAL/journal files. The
second `verify` checks the snapshot, not the restored directory. Do not start a
restore destination unless `restore` exits successfully; successful restore
returns the matching manifest identity. Generate a new reviewed LaunchAgent
for that destination, then start it normally. Service startup performs normal
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
`.ensemble-restore-incomplete`, and both verification and service startup refuse
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
competing scheduler or writer remains ([#761](https://github.com/chrisbanes/ensemble/issues/761)).
Physical sleep/wake proof ([#732](https://github.com/chrisbanes/ensemble/issues/732))
remains required before operational use on the Mac. Do not migrate old work or
enable competing production work based only on this snapshot or on recovery
qualification. A separately authorised host-restart test may be needed for final
recovery qualification.

## Local stable build

To use Ensemble locally without running a moving checkout, build a chosen commit
into an immutable directory under `~/.config/ensemble-dev` and run it in the
foreground. This is a personal instance for testing and evidence; it is not the
Haze cutover and must not take over projects the prototype owns. Cite the build
SHA with any evidence it produces.

```sh
scripts/local-build.sh COMMIT
```

The script archives exactly `COMMIT` into `builds/<sha>/`, installs and selects the
commit's `.node-version` through nvm, and runs `npm ci` and `npm run build` with
the pinned npm. Like CI, it ignores `~/.npmrc`, so user registry, proxy or auth
settings do not apply. It refuses an existing build directory; remove it to
rebuild. It creates private `data/`, `auth/` and `snapshots/` directories beside
`builds/` and prints the absolute Node path and start command.

The commands below use these values:

```sh
ROOT="$HOME/.config/ensemble-dev"
NODE=/absolute/node/printed/by/the/script
BUILD="$ROOT/builds/<sha>"
```

Initialize the operator password once ([Runtime and
authentication](#runtime-and-authentication)). Call the build's CLI directly,
because `npm run operator-auth` rebuilds first:

```sh
"$NODE" "$BUILD/dist/src/standalone/operator-auth-cli.js" init "$ROOT/auth/operator-auth.json"
```

Start with the printed command, which serves the operator UI on
`http://127.0.0.1:8787`; stop it with Ctrl-C.

To upgrade, stop the service and take a verified snapshot with the current build
([Offline snapshot and restore](#offline-snapshot-and-restore)), then build and
start the new commit against the same `data/`. Startup migrates the data forward,
and an older build refuses a newer schema:

```sh
"$NODE" "$BUILD/dist/src/standalone/operations-cli.js" backup "$ROOT/data" "$ROOT/snapshots/<old-sha>-<date>"
"$NODE" "$BUILD/dist/src/standalone/operations-cli.js" verify "$ROOT/snapshots/<old-sha>-<date>"
scripts/local-build.sh NEW_COMMIT
```

Rollback is manual and discards everything after the upgrade: `restore` the
snapshot to a new data directory under `$ROOT` and start the old build against
it. Keep the previous build and its snapshot until the new build has proved
itself.
