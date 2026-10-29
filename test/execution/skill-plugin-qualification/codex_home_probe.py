"""Model-free probe of Codex skill and plugin discovery under an isolated home.

Usage: codex_home_probe.py <not-yet-existing cab-codex-home-* directory>

Starts no model turn and supplies no credential: the isolated CODEX_HOME holds no
login, the API-key variables are removed, and no login method is invoked. Prints
redacted JSONL (one line per fact or facet) to stdout and removes the directory.
"""

import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time

PREFIX = "cab-codex-home-"
root = os.path.abspath(sys.argv[1])
if not os.path.basename(root).startswith(PREFIX):
    sys.exit(f"refusing a directory not named {PREFIX}*")
os.makedirs(root, exist_ok=False)

REAL_HOME = os.path.expanduser("~")
LABELS = [(os.path.realpath(root), "<disposable-root>"), (root, "<disposable-root>"), (REAL_HOME, "<user-home>")]


def clean(value):
    text = json.dumps(value)
    for path, label in LABELS:
        text = text.replace(path, label)
    return text


def emit(**data):
    print(clean(data), flush=True)


def run(args, env):
    result = subprocess.run(args, cwd=root, env=env, capture_output=True, text=True, timeout=30)
    return result.returncode, (result.stdout + result.stderr).strip()


def write_skill(directory, name, description):
    os.makedirs(directory)
    with open(os.path.join(directory, "SKILL.md"), "w") as file:
        file.write(f"---\nname: {name}\ndescription: {description}\n---\nProbe skill.\n")


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as file:
        json.dump(value, file)


def session(env, steps):
    """Starts an App Server in its own process group, runs steps(ask), then kills the group."""
    server = subprocess.Popen(
        ["codex", "app-server", "--stdio"],
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
        end = time.monotonic() + 15
        while time.monotonic() < end:
            try:
                event = events.get(timeout=1)
            except queue.Empty:
                continue
            if event.get("id") == rid:
                return event
        raise TimeoutError(method)

    try:
        init = ask("initialize", {"clientInfo": {"name": "cab_skill_plugin_probe", "title": "cab skill plugin probe", "version": "0.1.0"}})
        server.stdin.write('{"method":"initialized","params":{}}\n')
        server.stdin.flush()
        return steps(ask, init)
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


def skills(ask, **params):
    listed = ask("skills/list", {"forceReload": True, **params})["result"]["data"]
    return [(item["name"], item["scope"], item["path"], item.get("pluginId")) for entry in listed for item in entry["skills"]]


def main():
    home = os.path.join(root, "home")
    user_home = os.path.join(root, "userhome")
    extra = os.path.join(root, "fx", "extra")
    plugin = os.path.join(root, "fx", "plug")
    for directory in (home, user_home):
        os.makedirs(directory)
    write_skill(os.path.join(home, "skills", "home-skill"), "home-skill", "probe skill in the Codex home")
    write_skill(os.path.join(extra, "extra-skill"), "extra-skill", "probe skill in an extra root")
    write_skill(os.path.join(plugin, "skills", "plug-skill"), "plug-skill", "probe skill from a plugin")
    write_json(os.path.join(plugin, ".codex-plugin", "plugin.json"), {"name": "probeplug", "version": "0.0.1", "description": "probe", "skills": "./skills/"})
    marketplace = os.path.join(root, "fx", ".agents", "plugins", "marketplace.json")
    write_json(marketplace, {"name": "probemk", "plugins": [{"name": "probeplug", "source": {"source": "local", "path": "./plug"}, "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"}}]})

    env = {k: v for k, v in os.environ.items() if k not in ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME")}
    isolated = {**env, "CODEX_HOME": home, "HOME": user_home}
    emit(event="versions", codex=run(["codex", "--version"], env)[1])

    code, status = run(["codex", "login", "status"], isolated)
    emit(event="login-status", exit=code, status=status)
    if code != 1 or "Not logged in" not in status:
        raise AssertionError("isolated home did not report unavailable login")

    def discover(ask, init):
        account = ask("account/read", {})
        account_null = account.get("result", {}).get("account") is None
        emit(event="account", account_null=account_null, requires_openai_auth=account["result"].get("requiresOpenaiAuth"), codex_home=init["result"].get("codexHome"))
        if not account_null:
            raise AssertionError("isolated App Server account was unexpectedly available")
        found = {"homeOnly": skills(ask)}
        ask("skills/extraRoots/set", {"extraRoots": [extra]})
        found["withExtraRoot"] = skills(ask)
        listed = ask("plugin/list", {"cwds": [os.path.join(root, "fx")]})["result"]
        found["marketplaces"] = [m["name"] for m in listed["marketplaces"]]
        install = ask("plugin/install", {"pluginName": "probeplug", "marketplacePath": marketplace})
        found["installError"] = install.get("error", {}).get("message")
        found["afterInstall"] = skills(ask)
        return found

    found = session(isolated, discover)
    names = lambda key, scope=None: sorted(n for n, s, _, _ in found[key] if scope is None or s == scope)
    discovered = {
        "homeSkillsDir": "home-skill" in names("homeOnly", "user"),
        "extraRoot": "extra-skill" in names("withExtraRoot", "user"),
        "pluginSkill": "probeplug:plug-skill" in names("afterInstall"),
        "systemSkillsBundled": names("homeOnly", "system"),
        "pluginInstallDir": sorted(os.path.relpath(p, home) for p, _, _ in os.walk(os.path.join(home, "plugins", "cache")) if p.endswith("0.0.1")),
        "marketplaces": found["marketplaces"],
        "installError": found["installError"],
    }
    emit(
        facet="C4.1",
        disposition="demonstrated" if all([discovered["homeSkillsDir"], discovered["extraRoot"], discovered["pluginSkill"]]) else "untested surface",
        observation=discovered,
    )

    # Control: the same listing with only CODEX_HOME isolated shows whether HOME leaks skills.
    leaked = session({**env, "CODEX_HOME": home}, lambda ask, _init: skills(ask))
    outside = [(s, os.path.dirname(os.path.dirname(p))) for _, s, p, _ in leaked if not os.path.realpath(p).startswith(os.path.realpath(root))]
    emit(
        event="home-leak-control",
        skills_outside_probe=len(outside),
        roots=sorted({f"{s}:{p}" for s, p in outside}),
    )

    help_text = run(["codex", "login", "--help"], isolated)[1]
    methods = sorted({m for m in ("--with-api-key", "--with-access-token", "--device-auth") if m in help_text})
    schema = os.path.join(root, "schema")
    run(["codex", "app-server", "generate-json-schema", "--out", schema], isolated)
    with open(os.path.join(schema, "codex_app_server_protocol.v2.schemas.json")) as file:
        definitions = json.load(file)["definitions"]
    login_types = sorted(t for branch in definitions["LoginAccountParams"]["oneOf"] for t in branch["properties"]["type"]["enum"])
    emit(
        facet="C4.2",
        disposition="untested surface",
        reason="no login method was invoked: copying or creating a credential is outside the probe's authority",
        observation={"cliLoginMethods": methods, "appServerLoginTypes": login_types, "isolatedHomeLoginStatus": status},
    )

    features = {}
    for line in run(["codex", "features", "list"], isolated)[1].splitlines():
        parts = line.split()
        if len(parts) >= 3 and "multi_agent" in parts[0]:
            features[parts[0]] = {"stage": " ".join(parts[1:-1]), "enabled": parts[-1]}
    protocol = json.dumps(definitions)
    emit(
        facet="C4.3",
        disposition="untested surface",
        reason="subagent existence is read from the binary; sandbox and Stop coverage need a model-backed turn, which needs a login",
        observation={"multiAgentFeatures": features, "protocolHasCollabAgentToolCall": "CollabAgentTool" in protocol},
    )


try:
    main()
finally:
    shutil.rmtree(root, ignore_errors=True)
    emit(event="cleanup", directory_removed=not os.path.exists(root))
