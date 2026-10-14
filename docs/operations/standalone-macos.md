# Standalone macOS operations

This procedure applies to the standalone Ensemble service only. It does not
read or migrate the installed Haze prototype or authorize production deployment
or cutover. `ensemble service install` installs the service as a per-user
LaunchAgent; nothing installs it implicitly.

## Install, upgrade and uninstall

The service runs from an unpacked [release](#release-build) under the state
directory. The defaults are:

| Path | Default |
| --- | --- |
| State (`STATE`) | `~/Library/Application Support/Ensemble` |
| Data | `STATE/data` |
| Operator auth | `STATE/auth/operator-auth.json` |
| Snapshots | `STATE/snapshots` |
| Install records | `STATE/launchd/<label>.json` |
| Releases | `STATE/versions/<version>` |
| Logs | `~/Library/Logs/Ensemble/<label>.<version>.<UTC time>.{out,err}.log` |
| LaunchAgent | `~/Library/LaunchAgents/<label>.plist` |

The label defaults to `local.ensemble.service` and the port to `8787`
(`http://127.0.0.1:8787`). `--state-dir`, `--log-dir`, `--launch-agents-dir`,
`--label` and, at install only, `--port` override them; upgrade keeps the
installed port. `--diagnostic-retention-days` and `--diagnostic-storage-mib`
(install and upgrade) set the [diagnostic retention](#execution-diagnostic-retention)
limits. Pass the same directory and label options to `upgrade` and
`uninstall` as to `install`. The state and LaunchAgents directories must
be real directories you own that no one else can write; the data, snapshot,
install-record and log directories are created with mode `0700` and must stay
private. The state directory may already hold unrelated files, such as the
earlier pipeline implementation's `config.yaml` and `state/`; the commands read
and change only the entries above.

Unpack a release into its version directory, then initialize the operator
password once. `init-auth` reads the password from a hidden terminal prompt and
writes a mode `0600` verifier, not the password:

```sh
STATE="$HOME/Library/Application Support/Ensemble"
mkdir -p "$STATE/versions/0.1.0"
tar -xzf ensemble-0.1.0-darwin-arm64.tar.gz --strip-components 1 -C "$STATE/versions/0.1.0"
"$STATE/versions/0.1.0/bin/ensemble" service init-auth
```

### Install

```sh
"$STATE/versions/0.1.0/bin/ensemble" service install
```

Install binds the LaunchAgent to the release it runs from. It refuses, changing
nothing, unless that release sits directly in `STATE/versions` with a
`manifest.json` naming the same version, the label is not loaded, no install
record or LaunchAgent for the label exists, the auth file exists, and the port is
free. It then renders the plist with the same validation as before (absolute
canonical paths, no symlinks, new log files, the fixed `PATH`, `RunAtLoad=true`,
`KeepAlive=false`, no secrets), lints it with `plutil -lint`, records it, moves it
into `~/Library/LaunchAgents`, runs `launchctl bootstrap` and waits up to 120
seconds for `/app`. The plist names the release's own `node/bin/node` and
`dist/src/standalone/cli.js`, so each version keeps its exact executable.

If bootstrap or the wait fails, install boots out the job it started, confirms
the process exited, removes the LaunchAgent and its record, keeps the data, auth
and logs, reports the log paths and exits 1. Run it again after fixing the cause.
If the exit cannot be confirmed, it reports `"jobStopped":false` and keeps the
record so that `service uninstall` can finish.

Then log in the operator CLI with a read credential issued in Settings →
Credentials. Upgrade reads readiness through this connection, and `ensemble
doctor` shows the same checks:

```sh
"$STATE/versions/0.1.0/bin/ensemble" auth login --connection local --url http://127.0.0.1:8787
"$STATE/versions/0.1.0/bin/ensemble" doctor
```

### Upgrade

Unpack the new release beside the old one and run its `upgrade`:

```sh
mkdir "$STATE/versions/0.2.0"
tar -xzf ensemble-0.2.0-darwin-arm64.tar.gz --strip-components 1 -C "$STATE/versions/0.2.0"
"$STATE/versions/0.2.0/bin/ensemble" service upgrade "$STATE/versions/0.2.0" --connection local
```

Before it changes anything, upgrade reads the install record, checks the target
release as install does, checks that the running job is the one the record
describes, and loads the connection's token (`--connection`,
`ENSEMBLE_CONNECTION` or the default connection), which must be for the
installed origin. It then runs these stages:

1. `stop`: boots out the job and confirms that its process exited, within 30
   seconds.
2. `snapshot`: writes `STATE/snapshots/<label>.<from>-to-<to>.<UTC time>` and
   verifies it. The data directory's owner lock refuses if any process still
   holds the data.
3. `render`: renders, lints and records the new plist, with new log files.
4. `start`: `launchctl bootstrap`.
5. `health`: waits up to 120 seconds for `/app`.
6. `readiness`: reads readiness until no check reports Fail, for up to 120
   seconds. Not configured is accepted, so an unused GitHub discovery or Claude
   does not block it. The identity check confirms the same installation.

On success it prints the version, snapshot, log paths and each readiness
status. On a failure from `stop` onward it leaves the job stopped: it boots out
the new job if it started, with its exit confirmed, and removes the LaunchAgent
so nothing starts at login. It keeps the install record and prints
`{"ok":false,"operation":"upgrade","stage",…,"jobStopped","snapshot","logs"}`.
`jobStopped` is false only when a process exit could not be confirmed. There is
no rollback command. Recover by running `upgrade` again, with a fixed release or
the same one once the cause is fixed, or restore the reported snapshot (see
[Offline snapshot and restore](#offline-snapshot-and-restore)). An older release
refuses a newer database schema, so going back to an older release needs that
restore.

### Uninstall

```sh
"$STATE/versions/0.2.0/bin/ensemble" service uninstall
```

Uninstall boots out the job, confirms its process exited, and removes the
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

### Restart and host restarts

Restart the installed job with `launchctl kickstart -k
"gui/$(id -u)/local.ensemble.service"`; operator sessions reset and you log in
again. If the Codex App Server process exits while the service runs, the
operator workspace and `/runtime` page show "Codex runtime unavailable — turn it
off and on in Settings → Runtime, or restart the service". Queued requests stay
queued with that reason and nothing new is admitted; turns already running are
held for recovery. Nothing restarts the App Server automatically. Turning the
runtime off and on in Settings → Runtime replaces it with a fresh one; if it
stays unavailable, the same `kickstart -k` recovers it. Startup reconciliation
and the usual admission checks then apply.

The LaunchAgent in `~/Library/LaunchAgents` is meant to start the service when
the user logs into the GUI session; the procedure does not claim unattended
pre-login startup. If the label is absent after a login, run
`launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/local.ensemble.service.plist`
and check `/app`.

### Not yet proven

The [bounded live run](../evidence/980-service-lifecycle-2026-10-14.md) used a
throwaway label and temporary directories. These still need the maintainer:

- the first install with the default label into the real
  `~/Library/LaunchAgents` and `~/Library/Application Support/Ensemble`, beside
  the earlier pipeline files;
- launchd starting the job at login from the LaunchAgent after a logout or reboot;
- an upgrade over a real data directory with projects, workspaces or a running
  turn, where the bootout interrupts work and recovery holds apply;
- installing from a CI-built tagged release, or from a browser-downloaded tarball
  with quarantine attributes;
- Claude turns under launchd;
- the [#761](https://github.com/chrisbanes/ensemble/issues/761) cutover.

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

After the service starts, run `ensemble doctor` or open Settings → Readiness. Both
show what the running service sees: Codex executable and login, git, GitHub
discovery, the Claude executable and token, runtime harness and data and auth paths, each as Pass,
Fail or Not configured with one fix line and no token value or path. The checks
change nothing and request no model turn; re-run them after any fix.

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

The offered GitHub CLI account uses the same candidate environment as an
explicit gh source selection: `GH_TOKEN` takes precedence over `GITHUB_TOKEN`,
then the stored login. An invalid overriding token does not fall back to the
stored account. This status-only offer does not select credentials or activate a
source, and does not run `gh auth token` for a null/env source. Status uses the
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
is not a separate Ensemble execution sandbox.

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
service's fixed `PATH`; Ensemble does not redistribute it. Install it so it
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
instead. Readiness shows the Claude executable as Not configured while Claude is
unused, and as Fail with the fix once a token reference or an active Claude profile
needs it.

Ensemble reports the version `claude --version` prints and never compares it. Only
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
mkdir -m 700 -p "$HOME/.ensemble/claude"
install -m 600 /dev/null "$HOME/.ensemble/claude/claude-token"
```

Then copy the token printed by `claude setup-token` and write it from the clipboard
without shell history or argv. Type these two lines; do not copy them with the
commands above, because `pbpaste` reads the clipboard and a copied command replaces
the token:

```sh
pbpaste > "$HOME/.ensemble/claude/claude-token"
stat -f '%Su %Lp' "$HOME/.ensemble/claude/claude-token"
```

`stat` must show the service user and `600`. In Add Claude (or the Claude token
row in Settings), set the reference to `file:` followed by the absolute path, for
example `file:/Users/you/.ensemble/claude/claude-token`, and save; the Token
readable row then shows Pass, or the unsafe-file reason without the path or value.
The file is checked
whenever a Claude turn needs it: a symbolic link, a file owned by another user, any
group or other permission bit, more than 4096 bytes, a missing or empty file, or
content other than one token makes Claude work wait with a visible reason, and
the row shows the token unavailable. To rotate, write the new token to a new mode
`0600` file in the same directory and `mv` it over the old one; the next turn uses
it without a restart. A launchd-installed Claude turn with a real token is
untested; the bounded live journeys ran the service outside launchd.

## Execution diagnostic retention

Execution diagnostics expire after `ENSEMBLE_DIAGNOSTIC_RETENTION_DAYS` days
(1–365, default 30), checked hourly; past `ENSEMBLE_DIAGNOSTIC_STORAGE_MIB` (16–1048576,
default 1024) the oldest items are evicted. An invalid value stops the service
at startup. The supported LaunchAgent route is
`service install` or `service upgrade` with `--diagnostic-retention-days N|default`
and `--diagnostic-storage-mib N|default`. A value is written into the
LaunchAgent environment and recorded, so a later upgrade keeps it unless an
option changes it; `default` removes the variable and the service default
applies. An out-of-range value is refused before anything changes. To change a
value on an installed service, run `service upgrade` with the installed release
directory and the new option: it stops the job, takes a verified snapshot,
re-renders the plist, restarts the job and checks readiness. A hand-edited
plist is unsupported: upgrade refuses an activation that no longer matches its
recorded hash. A release built before these options rejects an install record
that holds them, so before moving to such a release run `service upgrade` with
`default` for each value.

The quota counts stored diagnostic payload text only, not the database, WAL or
filesystem. Pruning deletes payload items only and keeps per-execution gap
counts. There is no manual purge, and older snapshots keep any payloads they
held until those snapshots are deleted.

## Offline snapshot and restore

`service upgrade` takes and verifies a snapshot itself. For a separate backup,
stop the job with `launchctl bootout "gui/$(id -u)/local.ensemble.service"`,
wait for its process to exit, and confirm the label is absent (`launchctl print`
fails). Then back up to a new snapshot directory and verify it before relying on
it, and start the job again with `launchctl bootstrap "gui/$(id -u)"
~/Library/LaunchAgents/local.ensemble.service.plist`:

```sh
ensemble snapshot create "$STATE/data" "$STATE/snapshots/manual-<date>"
ensemble snapshot verify "$STATE/snapshots/manual-<date>"
```

`ensemble` here is any release's `bin/ensemble`; from a checkout,
`npm run operations -- backup|verify|restore` runs the same operations.

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
ensemble snapshot restore SNAPSHOT /absolute/private/ensemble-data-restored
ensemble snapshot verify SNAPSHOT
```

The restore command verifies the snapshot and restored database, creates a
fresh empty `.ensemble-owner.sqlite` as destination installation metadata, then
promotes its incomplete sentinel to `.ensemble-standalone` as its final commit.
It never copies the source owner file or SQLite WAL/journal files. The
second `verify` checks the snapshot, not the restored directory. Do not start a
restore destination unless `restore` exits successfully; successful restore
returns the matching manifest identity. To run the installed service on
restored data, `ensemble service uninstall`, move `STATE/data` aside, restore
into `STATE/data` and `ensemble service install` again. Service startup performs normal
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

## Release build

`scripts/package-release.mjs` builds the self-contained `darwin-arm64` release
([ADR-1011](../adr/1011-packaging-and-distribution.md)). CI uses it for tagged
releases, and it also builds a chosen commit into an immutable local directory for a
personal instance. A local build is for testing and evidence; it is not the Haze
cutover and must not take over projects the prototype owns. Cite the commit with
any evidence it produces.

Run it from a checkout on an Apple silicon Mac with any Node 24 or later:

```sh
node scripts/package-release.mjs build COMMIT
```

The script archives exactly `COMMIT` and downloads the official
`node-v<.node-version>-darwin-arm64.tar.gz` from `nodejs.org`. It refuses that Node
unless the tarball's SHA-256 matches the single entry for that file in the release's
`SHASUMS256.txt`. Verification happens before extraction, and there is no way to skip
it. With that Node and the pinned npm, it runs `npm ci`, `npm run build` and
`npm prune --omit=dev`. Like CI, it ignores `~/.npmrc`, so user registry, proxy or auth
settings do not apply. It then removes the Claude Agent SDK's platform packages,
which bundle a `claude` binary that the release does not redistribute, and fails if
any of them or any dev-only package from the lockfile remains.

By default the output goes to `~/.config/ensemble-dev/builds/<sha>/`. The script
creates private `data/`, `auth/` and `snapshots/` directories beside `builds/`,
refuses symlinks there, and prints the start command. `--out DIR` writes the output
to `DIR` instead and creates no state directories. Work is staged in
`<output>.partial` and renamed on success; the script refuses an existing output or
partial directory, so remove it to rebuild. The output contains:

- `ensemble-<version>-darwin-arm64.tar.gz`, the release;
- `ensemble-<version>-darwin-arm64/`, the same release unpacked;
- `manifest.json`, a copy of the release manifest;
- `SHA256SUMS` for the tarball and manifest, checked with `shasum -a 256 -c SHA256SUMS`.

A release directory contains `bin/ensemble` (the operator CLI), `node/bin/node` and
its licence, `dist/src`, `dist/operator`, the production `node_modules`,
`package.json`, `package-lock.json`, `LICENSE` and `manifest.json`. It needs `codex`
on `PATH` like a checkout build. It does not include `claude`: a release without one
on the service `PATH` shows Claude as Not enabled, and installing `claude` on that
`PATH` enables it once Claude is turned off and on in Settings → Runtime, or after a
restart (see [Claude executable](#claude-executable)).
Codex remains the default harness.

`manifest.json` records the schema `ensemble.release/v1`, name, version, platform,
commit, the Node version with the official tarball's SHA-256, and a tree digest.
The `ensemble-tree-sha256/v1` digest walks the release directory, excluding the
root `manifest.json`, and sorts relative POSIX paths by byte order. Each regular
file contributes `file <mode> <sha256> <path>\n`, where `<mode>` is `0755` when any
execute bit is set and `0644` otherwise. Each symlink contributes
`link <target> <path>\n`. Any other entry type is an error. The digest is the
SHA-256 of the concatenated lines.

To check a release, run:

```sh
node scripts/package-release.mjs verify PATH/TO/ensemble-<version>-darwin-arm64.tar.gz
```

`verify` checks `SHA256SUMS` when it sits beside the tarball, unpacks into a fresh
temporary directory whose path contains a space, recomputes the tree digest, and
repeats the package checks. It then uses a temporary `HOME` and a `PATH` of only the
system directories plus a generated fake `codex`, with no `node`. In that
environment it runs `bin/ensemble --version`, initializes operator auth, starts the
service against a fresh data directory, and expects the operator UI and one of its
assets within 120 seconds before stopping that service. It does not exercise a real
Codex login.

To run a release as the service, unpack it into `STATE/versions/<version>` and
use [`ensemble service install`](#install) or [`upgrade`](#upgrade).

### Tagged releases

`.github/workflows/release.yml` publishes a release when a `v*` tag is pushed. It runs
the CI `check` job, refuses a tag other than `v` plus the `package.json` version,
builds and verifies the release on a macOS arm64 runner, and attaches the tarball,
`SHA256SUMS` and `manifest.json` to a GitHub Release for that tag. Rerunning a failed
release job finishes a draft release that the failed run left behind; it refuses to
replace a published release. Manual runs and pull requests that change the packaging
files build and verify the same tarball and upload it only as a workflow artifact. No
release has been published yet.

## Checkout and low-level procedure

`ensemble service` is the supported route. From a checkout, or to inspect each
step, the pieces run directly. Keep all data, auth, snapshot, restore, plist and
log paths separate, absolute and lexically canonical, with every existing path
component a real directory (not a symlink), and private to the operator.
`npm run operations` and `npm run operator-auth` remain available and behave as
before.

### Build and authenticate from a checkout

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

### Render a LaunchAgent by hand

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

To set the diagnostic retention limits, append the two optional flags after the
plist path (1–365 days, 16–1048576 MiB); omitted, the service defaults apply.
Malformed or out-of-range values print usage and exit 2:

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
  /absolute/private/launch-agents/com.example.ensemble.plist \
  --diagnostic-retention-days 14 --diagnostic-storage-mib 512
```

The current renderer sets `RunAtLoad=true` and `KeepAlive=false`; launchctl,
not automatic crash relaunch, owns restart. The plist contains the Node/CLI,
operator command, data directory, port, separate auth-file path, canonical
origin, fixed non-secret PATH, the diagnostic retention variables when set,
and private log paths. It contains no password
or shell wrapper. Before bootstrap, inspect and lint the exact plist:

```sh
/usr/bin/plutil -lint /absolute/private/launch-agents/com.example.ensemble.plist
/usr/bin/plutil -p /absolute/private/launch-agents/com.example.ensemble.plist
```

### Start, inspect, restart and stop by hand

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
