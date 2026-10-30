"""Probe whether Codex keeps a symlinked auth.json when it refreshes the login.

Usage: codex_auth_link_probe.py --stage dummy|operator [--live] <not-yet-existing cab-codex-auth-* directory>

The disposable CODEX_HOME holds only `auth.json`, a symlink to a target file.
Codex must write refreshed credentials through the link and never replace it.

- `dummy` (model-free, no network): the target is a placeholder in the disposable
  directory, populated by a fake API-key login.
- `operator` (authenticated, needs --live): the target is the operator's own Codex
  `auth.json` (`$CODEX_HOME/auth.json`, else `~/.codex/auth.json`). A proactive
  refresh is forced through App Server `account/read {refreshToken: true}`.

Only `lstat`/`stat` metadata of the operator's file is ever read: never its
contents, a token, or a hash. The API-key variables are removed from the
environment. Prints redacted JSONL to stdout and removes the directory (the link,
never its target).

Exit codes: 0 pass, 3 `link-replaced` (stop: record a decision pause, never copy),
4 `refresh-not-observed` (untested: do not ship).
"""

import argparse
import json
import os
import queue
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time

PREFIX = "cab-codex-auth-"
FAKE_KEY = "sk-cab-probe-not-a-real-key"
LINK_REPLACED, REFRESH_NOT_OBSERVED = 3, 4

parser = argparse.ArgumentParser()
parser.add_argument("--stage", choices=("dummy", "operator"), required=True)
parser.add_argument("--live", action="store_true")
parser.add_argument("directory")
args = parser.parse_args()
root = os.path.abspath(args.directory)
if not os.path.basename(root).startswith(PREFIX):
    sys.exit(f"refusing a directory not named {PREFIX}*")
if args.stage == "operator" and not args.live:
    sys.exit("the operator stage touches the operator's login and requires --live")
os.makedirs(root, exist_ok=False)

REAL_HOME = os.path.expanduser("~")
LABELS = [(os.path.realpath(root), "<disposable-root>"), (root, "<disposable-root>"), (REAL_HOME, "<user-home>")]
home = os.path.join(root, "home")  # CODEX_HOME
link = os.path.join(home, "auth.json")


def clean(value):
    text = json.dumps(value)
    for path, label in LABELS:
        text = text.replace(path, label)
    return text


def emit(**data):
    print(clean(data), flush=True)


class Stop(Exception):
    def __init__(self, code, reason):
        self.code, self.reason = code, reason


def snapshot(target):
    """Metadata only: the link's type and target, and the target's inode, mtime, mode and emptiness."""
    link_stat = os.lstat(link)
    target_stat = os.stat(target)
    return {
        "linkIsSymlink": stat.S_ISLNK(link_stat.st_mode),
        "linkTargetUnchanged": stat.S_ISLNK(link_stat.st_mode) and os.readlink(link) == target,
        "inode": target_stat.st_ino,
        "mtimeNs": target_stat.st_mtime_ns,
        "mode": oct(stat.S_IMODE(target_stat.st_mode)),
        "nonEmpty": target_stat.st_size > 0,
        "regular": stat.S_ISREG(target_stat.st_mode),
    }


def compare(name, before, after):
    intact = after["linkIsSymlink"] and after["linkTargetUnchanged"]
    inode_same = before["inode"] == after["inode"]
    written = after["mtimeNs"] > before["mtimeNs"]
    emit(
        facet=name,
        linkIntact=intact,
        inodeUnchanged=inode_same,
        modeUnchanged=before["mode"] == after["mode"],
        refreshWritten=written,
        mtimeAdvancedMs=round((after["mtimeNs"] - before["mtimeNs"]) / 1e6, 1),
        nonEmpty=after["nonEmpty"],
    )
    if not intact or not inode_same or not after["regular"]:
        raise Stop(LINK_REPLACED, "link-replaced")
    return written


def run(argv, env, stdin=None):
    result = subprocess.run(argv, cwd=root, env=env, input=stdin, capture_output=True, text=True, timeout=30)
    return result.returncode, (result.stdout + result.stderr).strip()


def server_session(env, steps):
    """Starts an App Server in its own process group, runs steps(ask), then kills exactly that group."""
    server = subprocess.Popen(
        ["codex", "app-server", "--stdio", "-c", "cli_auth_credentials_store=file"],
        cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=True, bufsize=1, start_new_session=True,
    )
    events = queue.Queue()
    threading.Thread(target=lambda: [events.put(json.loads(line)) for line in server.stdout], daemon=True).start()
    ids = iter(range(1, 1000))

    def ask(method, params):
        rid = next(ids)
        server.stdin.write(json.dumps({"id": rid, "method": method, "params": params}) + "\n")
        server.stdin.flush()
        end = time.monotonic() + 45
        while time.monotonic() < end:
            try:
                event = events.get(timeout=1)
            except queue.Empty:
                continue
            if event.get("id") == rid:
                return event
        raise TimeoutError(method)

    try:
        ask("initialize", {"clientInfo": {"name": "cab_auth_link_probe", "title": "cab auth link probe", "version": "0.1.0"}})
        server.stdin.write('{"method":"initialized","params":{}}\n')
        server.stdin.flush()
        return steps(ask)
    finally:
        if server.poll() is None:
            os.killpg(server.pid, signal.SIGKILL)
        server.wait(timeout=5)
        try:
            os.kill(server.pid, 0)
            gone = False
        except ProcessLookupError:
            gone = True
        emit(event="server-exit", pid=server.pid, exit=server.returncode, gone=gone)


def refresh(env):
    """Forces a proactive refresh through App Server and reports whether an account is present."""
    def step(ask):
        result = ask("account/read", {"refreshToken": True})
        error = result.get("error")
        account = (result.get("result") or {}).get("account")
        return {"accountPresent": account is not None, "error": error.get("message") if error else None}

    return server_session(env, step)


def stage_dummy(env):
    target = os.path.join(root, "target", "auth.json")
    os.makedirs(os.path.dirname(target))
    with open(target, "w") as file:
        json.dump({"placeholder": True}, file)
    os.symlink(target, link)
    before = snapshot(target)
    time.sleep(0.05)
    code, _ = run(["codex", "login", "--with-api-key", "-c", "cli_auth_credentials_store=file"], env, stdin=FAKE_KEY + "\n")
    emit(event="fake-login", exit=code)
    compare("dummy-login-write", before, snapshot(target))
    if not snapshot(target)["nonEmpty"]:
        raise Stop(1, "target empty after login")

    before = snapshot(target)
    time.sleep(0.05)
    outcome = refresh(env)
    after = snapshot(target)
    written = compare("dummy-refresh", before, after)
    emit(event="dummy-refresh-note", refreshWriteExpected=False, refreshWriteObserved=written, **outcome)


def stage_operator(env):
    base = os.environ.get("CODEX_HOME") or os.path.join(REAL_HOME, ".codex")
    target = os.path.join(base, "auth.json")
    try:
        target_lstat = os.lstat(target)
    except FileNotFoundError:
        raise Stop(2, "operator login is not file-backed at the resolved auth.json path")
    if not stat.S_ISREG(target_lstat.st_mode):
        raise Stop(2, "operator auth.json is not a regular file")
    os.symlink(target, link)
    before = snapshot(target)
    emit(event="operator-before", operatorFileRegular=True, mode=before["mode"], nonEmpty=before["nonEmpty"])
    outcome = refresh(env)
    after = snapshot(target)
    written = compare("operator-refresh", before, after)
    emit(event="operator-account", **outcome)
    if not written:
        raise Stop(REFRESH_NOT_OBSERVED, "refresh-not-observed")
    if not outcome["accountPresent"]:
        raise Stop(1, "account-absent")


def main():
    user = os.path.join(root, "user")  # HOME
    os.makedirs(home)
    os.makedirs(user)
    env = {k: v for k, v in os.environ.items() if k not in ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME")}
    env.update(CODEX_HOME=home, HOME=user)
    emit(event="versions", codex=run(["codex", "--version"], env)[1], stage=args.stage)
    (stage_dummy if args.stage == "dummy" else stage_operator)(env)
    emit(event="result", stage=args.stage, outcome="passed")


code = 0
try:
    main()
except Stop as stop:
    emit(event="result", stage=args.stage, outcome=stop.reason)
    code = stop.code
finally:
    # Remove the link first so the cleanup can never reach the target.
    if os.path.islink(link):
        os.unlink(link)
    shutil.rmtree(root, ignore_errors=True)
    emit(event="cleanup", directory_removed=not os.path.exists(root))
sys.exit(code)
