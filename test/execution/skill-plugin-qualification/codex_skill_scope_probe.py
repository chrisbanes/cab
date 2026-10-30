"""Authenticated Codex proof: per-thread skill scoping on one App Server, persistence across
resume, the restored real HOME in a model-driven shell, and the login link kept intact.

Usage: codex_skill_scope_probe.py --live <not-yet-existing cab-codex-scope-* directory>

The disposable CODEX_HOME holds only `auth.json`, a symlink to the operator's own Codex login
(`$CODEX_HOME/auth.json`, else `~/.codex/auth.json`), exactly as cab links it. Only `lstat`/`stat`
metadata of that file is read: never its contents, a token or a hash. The API-key variables are
removed. At most 12 model turns run, on the cheapest model at low effort. Prints redacted JSONL
and removes the directory (the link, never its target).

Facets (S1-S5 gate the Codex skill delivery; S6 is information only and never enables subagents):
  S1 extra root lists both fixture skills with plugins disabled
  S2 thread A (other-skill and bundled skills disabled by config) vs thread B (nothing disabled)
  S3 thread/resume with the same config keeps the scope; without it is recorded
  S4 a model-driven shell prints the real HOME; skill discovery loads nothing from it
  S5 the login link is intact after every turn
  S6 subagents (a separate App Server with multi_agent=true): outside write, network, interrupt, survivors

Exit codes: 0 pass, 3 link-replaced (stop: decision pause, never copy), 5 scope-failed or
home-failed (stop: replan), 2 operator login unavailable.
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

PREFIX = "cab-codex-scope-"
MODEL, EFFORT = "gpt-6-luna", "low"
MAX_TURNS = 12
LINK_REPLACED, SCOPE_FAILED = 3, 5

parser = argparse.ArgumentParser()
parser.add_argument("--live", action="store_true", required=True)
parser.add_argument("directory")
args = parser.parse_args()
root = os.path.abspath(args.directory)
if not os.path.basename(root).startswith(PREFIX):
    sys.exit(f"refusing a directory not named {PREFIX}*")
os.makedirs(root, exist_ok=False)

REAL_HOME = os.path.expanduser("~")
LABELS = [
    (os.path.realpath(root), "<disposable-root>"),
    (root, "<disposable-root>"),
    (os.path.realpath(REAL_HOME), "<real-home>"),
    (REAL_HOME, "<real-home>"),
]
home = os.path.join(root, "home")  # CODEX_HOME
user = os.path.join(root, "user")  # HOME of Codex itself
workspace = os.path.join(root, "ws")
fixture = os.path.join(root, "fx", "plugin", "skills")
link = os.path.join(home, "auth.json")
SKILLS = ("probe-skill", "other-skill")


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


def write_skill(name):
    directory = os.path.join(fixture, name)
    os.makedirs(directory)
    with open(os.path.join(directory, "SKILL.md"), "w") as file:
        file.write(
            f"---\nname: {name}\ndescription: Run the {name} probe. Use when asked to use {name}.\n---\n"
            f"Run exactly this shell command and report its output: echo ran > {workspace}/{name}-ran\n"
        )


def link_state(target):
    """Metadata only."""
    entry = os.lstat(link)
    return {
        "isSymlink": stat.S_ISLNK(entry.st_mode),
        "targetUnchanged": stat.S_ISLNK(entry.st_mode) and os.readlink(link) == target,
        "inode": os.stat(target).st_ino,
        "regular": stat.S_ISREG(os.stat(target).st_mode),
    }


class Server:
    def __init__(self, env, extra=()):
        self.process = subprocess.Popen(
            [
                "codex", "app-server", "--stdio",
                "-c", "approval_policy=never",
                "-c", "sandbox_mode=workspace-write",
                "-c", "cli_auth_credentials_store=file",
                "-c", "features.multi_agent=false",
                "-c", "features.plugins=false",
                "-c", "features.skill_mcp_dependency_install=false",
                "-c", f"shell_environment_policy.set.HOME={json.dumps(REAL_HOME)}",
                *extra,
            ],
            cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1, start_new_session=True,
        )
        self.events = queue.Queue()
        threading.Thread(
            target=lambda: [self.events.put(json.loads(line)) for line in self.process.stdout],
            daemon=True,
        ).start()
        self.ids = iter(range(1, 100000))
        self.pending = []
        self.turns = 0
        self.ask("initialize", {"clientInfo": {"name": "cab_skill_scope_probe", "title": "cab skill scope probe", "version": "0.1.0"}})
        self.process.stdin.write('{"method":"initialized","params":{}}\n')
        self.process.stdin.flush()

    def ask(self, method, params, timeout=60):
        rid = next(self.ids)
        self.process.stdin.write(json.dumps({"id": rid, "method": method, "params": params}) + "\n")
        self.process.stdin.flush()
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            try:
                event = self.events.get(timeout=1)
            except queue.Empty:
                continue
            if event.get("id") == rid:
                if "error" in event:
                    raise Stop(1, f"{method} failed: {event['error'].get('message')}")
                return event["result"]
            self.pending.append(event)
        raise TimeoutError(method)

    def skills(self):
        listed = self.ask("skills/list", {"cwds": [workspace], "forceReload": True})["data"]
        return [item for entry in listed for item in entry["skills"]]

    def start_thread(self, config):
        return self.ask("thread/start", {
            "cwd": workspace, "approvalPolicy": "never", "sandbox": "workspace-write",
            "ephemeral": False, "model": MODEL, "config": config,
        })["thread"]["id"]

    def resume_thread(self, thread, config):
        self.ask("thread/resume", {
            "threadId": thread, "approvalPolicy": "never", "sandbox": "workspace-write",
            "model": MODEL, **({"config": config} if config is not None else {}),
        })

    def turn(self, thread, text, wait=150, interrupt_after=None):
        """Runs one model turn; returns agent messages and commands. Counts against the turn cap."""
        self.turns += 1
        if self.turns > MAX_TURNS:
            raise Stop(1, "model turn cap reached")
        started = self.ask("turn/start", {"threadId": thread, "input": [{"type": "text", "text": text}], "effort": EFFORT})
        turn_id = started["turn"]["id"]
        messages, commands, kinds = [], [], []
        end = time.monotonic() + wait
        interrupted = False
        begun = time.monotonic()
        while time.monotonic() < end:
            if interrupt_after is not None and not interrupted and time.monotonic() - begun > interrupt_after:
                self.ask("turn/interrupt", {"threadId": thread, "turnId": turn_id})
                interrupted = True
            try:
                event = self.pending.pop(0) if self.pending else self.events.get(timeout=1)
            except queue.Empty:
                continue
            method = event.get("method")
            if method == "item/completed":
                item = event["params"]["item"]
                kinds.append(item["type"])
                if item["type"] == "agentMessage":
                    messages.append(item["text"])
                if item["type"] == "commandExecution":
                    commands.append({"command": item.get("command"), "output": item.get("aggregatedOutput")})
            if method == "turn/completed":
                return {"messages": messages, "commands": commands, "kinds": kinds, "interrupted": interrupted}
        raise TimeoutError("turn")

    def tree(self):
        """Exact identities (pid, start) below the App Server."""
        table = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,lstart="], capture_output=True, text=True).stdout.splitlines()
        rows = []
        for line in table:
            parts = line.split(None, 2)
            rows.append((int(parts[0]), int(parts[1]), parts[2].strip()))
        found, queue_ = [], [self.process.pid]
        while queue_:
            parent = queue_.pop(0)
            for pid, ppid, started in rows:
                if ppid == parent:
                    found.append((pid, started))
                    queue_.append(pid)
        return found

    def close(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGKILL)
        self.process.wait(timeout=5)
        try:
            os.kill(self.process.pid, 0)
            gone = False
        except ProcessLookupError:
            gone = True
        emit(event="server-exit", pid=self.process.pid, exit=self.process.returncode, gone=gone)


def alive(identity):
    pid, started = identity
    result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart="], capture_output=True, text=True)
    return result.stdout.strip() == started


def names_in(messages):
    return sorted({line.split(":", 1)[1].strip() for text in messages for line in text.splitlines() if line.startswith("SKILL:")})


LIST = "List the exact names of every skill available to you in this session, one per line as 'SKILL: name'. Run no command."


def use(name):
    return f"Use the skill named {name} now. If you have no skill by that name, reply exactly NOT-AVAILABLE and run no command."


def marker(name):
    return os.path.exists(os.path.join(workspace, f"{name}-ran"))


def clear_markers():
    for name in SKILLS:
        path = os.path.join(workspace, f"{name}-ran")
        if os.path.exists(path):
            os.unlink(path)


def run_facets(server, target):
    def link_check(label):
        state = link_state(target)
        intact = state["isSymlink"] and state["targetUnchanged"] and state["regular"]
        emit(facet="S5", after=label, linkIntact=intact, inode=state["inode"])
        if not intact:
            raise Stop(LINK_REPLACED, "link-replaced")
        return state["inode"]

    inode = link_state(target)["inode"]
    # S1
    server.ask("skills/extraRoots/set", {"extraRoots": [fixture]})
    listed = server.skills()
    by_scope = {}
    for item in listed:
        by_scope.setdefault(item["scope"], []).append(item["name"])
    bundled = [i for i in listed if i["scope"] == "system"]
    s1 = all(name in by_scope.get("user", []) for name in SKILLS)
    emit(facet="S1", disposition="demonstrated" if s1 else "failed", userSkills=sorted(by_scope.get("user", [])),
         bundledSkills=sorted(i["name"] for i in bundled), pluginsFeature="disabled")
    # S4 (discovery half): nothing from the real home is loaded.
    outside = [i["name"] for i in listed if os.path.realpath(i["path"]).startswith(os.path.realpath(REAL_HOME))
               and not os.path.realpath(i["path"]).startswith(os.path.realpath(root))]
    emit(event="home-discovery", skillsFromRealHome=len(outside))

    path_of = {i["name"]: i["path"] for i in listed}
    disabled = [{"path": path_of["other-skill"], "enabled": False}] + [
        {"path": i["path"], "enabled": False} for i in bundled
    ]
    config_a = {"skills": {"config": disabled}}

    # S2: thread A (scoped) then thread B (not).
    clear_markers()
    thread_a = server.start_thread(config_a)
    list_a = server.turn(thread_a, LIST)
    seen_a = names_in(list_a["messages"])
    server.turn(thread_a, use("probe-skill"))
    a_probe = marker("probe-skill")
    server.turn(thread_a, use("other-skill"))
    a_other = marker("other-skill")
    link_check("thread A")
    clear_markers()
    thread_b = server.start_thread({})
    seen_b = names_in(server.turn(thread_b, LIST)["messages"])
    server.turn(thread_b, use("other-skill"))
    b_other = marker("other-skill")
    s2 = (
        seen_a == ["probe-skill"] and a_probe and not a_other
        and "other-skill" in seen_b and "probe-skill" in seen_b and b_other
    )
    emit(facet="S2", disposition="demonstrated" if s2 else "failed", threadASkills=seen_a, threadAProbeRan=a_probe,
         threadAOtherRan=a_other, threadBSkills=seen_b, threadBOtherRan=b_other)
    clear_markers()

    # S3: resume A with the same config; then without it (information).
    server.resume_thread(thread_a, config_a)
    seen_resumed = names_in(server.turn(thread_a, LIST)["messages"])
    server.turn(thread_a, use("other-skill"))
    resumed_other = marker("other-skill")
    s3 = seen_resumed == ["probe-skill"] and not resumed_other
    emit(facet="S3", disposition="demonstrated" if s3 else "failed", resumedWithConfigSkills=seen_resumed,
         resumedWithConfigOtherRan=resumed_other)
    clear_markers()
    link_check("resume")

    # S4: a model-driven shell prints the real HOME (thread A's sandbox, no network, no skill).
    shell_thread = server.start_thread(config_a)
    shell = server.turn(
        shell_thread,
        'Use your shell tool to run exactly this command, then show its output: printf "HOME=%s\\n" "$HOME"',
    )
    out = "\n".join(str(c["output"]) for c in shell["commands"])
    s4 = f"HOME={REAL_HOME}" in out or f"HOME={os.path.realpath(REAL_HOME)}" in out
    emit(facet="S4", disposition="demonstrated" if s4 and not outside else "failed", shellHomeIsRealHome=s4,
         skillsFromRealHome=len(outside), shellOutput=out.strip()[:200], itemKinds=sorted(set(shell["kinds"])),
         reply=" ".join(shell["messages"])[:200])

    inode_after = link_check("all turns")
    emit(facet="S5", disposition="demonstrated" if inode_after == inode else "failed", inodeUnchanged=inode_after == inode)
    return s1, s2, s3, s4


def subagent_info(env, target):
    """S6, information only: multi_agent=true on one thread; never enables subagents in cab."""
    # A separate App Server with the feature on; cab's own server never has it.
    server = Server(env, extra=("-c", "features.multi_agent=true"))
    try:
        # Outside the workspace and outside /tmp, which workspace-write allows; removed below.
        sentinel = os.path.join(REAL_HOME, f".{os.path.basename(root)}-outside-write")
        thread = server.start_thread({})
        before = {identity for identity in server.tree()}
        prompt = (
            "Use a subagent (spawn_agent or your delegation tool) to run these shell commands in order: "
            f"`echo x > {sentinel}`, then `curl -s -m 5 https://example.com -o /dev/null; echo curl-exit=$?`, "
            "then `/bin/sleep 90`. If you have no subagent tool, reply exactly NO-SUBAGENT-TOOL and run nothing."
        )
        result = server.turn(thread, prompt, interrupt_after=40)
        during = set(server.tree()) - before
        time.sleep(3)
        survivors = [identity for identity in during if alive(identity)]
        kinds = sorted(set(result["kinds"]))
        used = any("collab" in k.lower() or "agent" in k.lower() for k in kinds if k != "agentMessage")
        emit(facet="S6", disposition="demonstrated-subagent-activity" if used else "untested", subagentToolItems=used, itemKinds=kinds,
             outsideWriteLanded=os.path.exists(sentinel), interrupted=result["interrupted"],
             processesBelowServerDuringTurn=len(during), survivorsAfterInterrupt=len(survivors),
             note="recorded only; cab keeps Codex subagents disabled")
        if os.path.exists(sentinel):
            os.unlink(sentinel)
        for identity in survivors:
            try:
                os.kill(identity[0], signal.SIGKILL)
            except ProcessLookupError:
                pass
        link_state(target)
    except Stop as stop:
        emit(facet="S6", disposition="untested", reason=stop.reason)
    except TimeoutError:
        emit(facet="S6", disposition="untested", reason="timeout")
    finally:
        server.close()


def main():
    for directory in (home, user, workspace):
        os.makedirs(directory)
    for name in SKILLS:
        write_skill(name)
    env = {k: v for k, v in os.environ.items() if k not in ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME")}
    env.update(CODEX_HOME=home, HOME=user)
    version = subprocess.run(["codex", "--version"], env=env, capture_output=True, text=True).stdout.strip()
    emit(event="versions", codex=version, model=MODEL, effort=EFFORT)
    base = os.environ.get("CODEX_HOME") or os.path.join(REAL_HOME, ".codex")
    target = os.path.join(base, "auth.json")
    try:
        mode = os.lstat(target).st_mode
    except FileNotFoundError:
        raise Stop(2, "operator login is not file-backed at the resolved auth.json path")
    if not stat.S_ISREG(mode):
        raise Stop(2, "operator auth.json is not a regular file")
    os.symlink(target, link)
    server = Server(env)
    try:
        account = server.ask("account/read", {})["account"]
        emit(event="account", present=account is not None)
        if account is None:
            raise Stop(2, "no account behind the linked login")
        s1, s2, s3, s4 = run_facets(server, target)
    finally:
        server.close()
    subagent_info(env, target)
    state = link_state(target)
    emit(facet="S5", after="subagent probe", linkIntact=state["isSymlink"] and state["targetUnchanged"] and state["regular"])
    if not (state["isSymlink"] and state["targetUnchanged"] and state["regular"]):
        raise Stop(LINK_REPLACED, "link-replaced")
    if not (s1 and s2 and s3):
        raise Stop(SCOPE_FAILED, "scope-failed")
    if not s4:
        raise Stop(SCOPE_FAILED, "home-failed")
    emit(event="result", outcome="passed")


code = 0
try:
    main()
except Stop as stop:
    emit(event="result", outcome=stop.reason)
    code = stop.code
finally:
    # Remove the link first so the cleanup can never reach the target.
    if os.path.islink(link):
        os.unlink(link)
    shutil.rmtree(root, ignore_errors=True)
    emit(event="cleanup", directory_removed=not os.path.exists(root))
sys.exit(code)
