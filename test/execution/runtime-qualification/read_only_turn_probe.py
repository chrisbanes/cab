"""Draft-turn read-only probe: per-turn readOnly sandboxPolicy on a workspace-write thread.

Usage: read_only_turn_probe.py ROOT [--exec-only]
Set CODEX_BIN to the approved launcher. Without --exec-only it makes ONE model
attempt (turn A read-only, turn B workspace-write on the same thread). Disposable
targets only; credentials and config are never read or printed.
"""

import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import uuid

codex = os.environ.get("CODEX_BIN", "codex")
root = os.path.abspath(sys.argv[1])
exec_only = "--exec-only" in sys.argv[2:]
work = os.path.join(root, "work")
os.makedirs(work)
marker = "DRAFT_TURN_" + uuid.uuid4().hex[:12].upper()
with open(os.path.join(work, "marker"), "w") as f:
    f.write(marker)
read_only = {"type": "readOnly", "networkAccess": False}
# Mirrors executionPolicy(workspace) in src/standalone/codex.ts.
workspace_write = {"type": "workspaceWrite", "writableRoots": [work], "networkAccess": False,
                   "excludeSlashTmp": True, "excludeTmpdirEnvVar": True}
trace = open(os.path.join(root, "trace.jsonl"), "w")
events = queue.Queue()
summary = {}


def emit(**fields):
    trace.write(json.dumps({"wall": time.time(), **fields}) + "\n")
    trace.flush()


server = subprocess.Popen(
    [codex, "app-server", "-c", "approval_policy=never", "-c", "sandbox_mode=workspace-write", "--stdio"],
    cwd=work, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    text=True, bufsize=1, start_new_session=True)
threading.Thread(target=lambda: [events.put(json.loads(x)) for x in server.stdout], daemon=True).start()


def receive(predicate, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            event = events.get(timeout=0.1)
        except queue.Empty:
            if server.poll() is not None:
                raise RuntimeError("App Server exited")
            continue
        item = (event.get("params") or {}).get("item") or {}
        if item.get("type") == "commandExecution":
            emit(event=event["method"], command=item.get("command"), status=item.get("status"),
                 exitCode=item.get("exitCode"), output=item.get("aggregatedOutput"))
        if predicate(event):
            if "error" in event:
                raise RuntimeError(event["error"])
            return event
    raise TimeoutError("protocol response")


def call(rid, method, params, timeout=30):
    server.stdin.write(json.dumps({"id": rid, "method": method, "params": params}) + "\n")
    server.stdin.flush()
    emit(request=method, id=rid)
    return receive(lambda e: e.get("id") == rid, timeout)["result"]


def exec_case(rid, policy, argv):
    return call(rid, "command/exec", {"command": argv, "cwd": work, "sandboxPolicy": policy,
                                      "timeoutMs": 5000, "env": {}})


def run_turn(rid, thread_id, policy, command):
    prompt = ("In this disposable fixture, use the foreground shell tool once to run exactly `"
              + command + "` and wait for it. Report the result without another tool.")
    turn = call(rid, "turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": prompt}],
                                    "cwd": work, "sandboxPolicy": policy, "approvalPolicy": "never"})["turn"]
    done = receive(lambda e: e.get("method") == "turn/completed"
                   and e["params"]["turn"]["id"] == turn["id"], 120)
    return done["params"]["turn"]["status"]


failure = None
try:
    call(1, "initialize", {"clientInfo": {"name": "cab_draft_turn_probe",
                                          "title": "Draft turn read-only probe", "version": "0.1.0"}})
    server.stdin.write('{"method":"initialized","params":{}}\n')
    server.stdin.flush()
    summary["codexVersion"] = subprocess.run([codex, "--version"], capture_output=True, text=True).stdout.strip()
    summary["policy"] = read_only
    # Offline step: no model call.
    write = exec_case(2, read_only, ["/bin/sh", "-c", "printf BAD > exec-write"])
    read = exec_case(3, read_only, ["/bin/cat", "marker"])
    control = exec_case(4, workspace_write, ["/bin/sh", "-c", "printf OK > exec-control"])
    summary["policyAccepted"] = True
    summary["execWriteDenied"] = write["exitCode"] != 0 and not os.path.exists(os.path.join(work, "exec-write"))
    summary["readAllowed"] = read["exitCode"] == 0 and read.get("stdout", "").strip() == marker
    summary["execControlWrites"] = control["exitCode"] == 0 and os.path.exists(os.path.join(work, "exec-control"))
    if not exec_only:
        thread = call(5, "thread/start", {"cwd": work, "sandbox": "workspace-write",
                                          "approvalPolicy": "never", "ephemeral": False})["thread"]
        status_a = run_turn(6, thread["id"], read_only, "sh -c 'touch probe-a; cat marker'")
        summary["turnAStatus"] = status_a
        summary["turnAWriteAbsent"] = status_a == "completed" and not os.path.exists(os.path.join(work, "probe-a"))
        status_b = run_turn(7, thread["id"], workspace_write, "touch probe-b")
        summary["turnBStatus"] = status_b
        summary["turnBWritePresent"] = status_b == "completed" and os.path.exists(os.path.join(work, "probe-b"))
        summary["turnAMarkerRead"] = any(
            marker in (json.loads(l).get("output") or "") and "probe-a" in (json.loads(l).get("command") or "")
            for l in open(os.path.join(root, "trace.jsonl")))
        # A turn whose command never ran proves nothing: record whether A tried the write.
        summary["turnAAttemptedWrite"] = any(
            "probe-a" in (json.loads(l).get("command") or "") for l in open(os.path.join(root, "trace.jsonl")))
except Exception as error:
    failure = error
    summary["error"] = repr(error)
finally:
    if server.poll() is None:
        os.killpg(server.pid, signal.SIGTERM)
        server.wait(timeout=10)
    print(json.dumps(summary, indent=2))
    trace.close()
if failure:
    raise failure
