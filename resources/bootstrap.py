import base64
import json
import os
import pathlib
import re
import sys
import tempfile
import runpy

payload = json.load(sys.stdin)
config = payload["config"]
windows = config.get('platform') == 'windows'
session_id = config["sessionId"]
if not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", session_id):
    raise ValueError("Invalid session ID")
base = pathlib.Path.home() / ".local" / "share" / "happypanda"
base.mkdir(parents=True, exist_ok=True, mode=0o700)
runtime = base / "runtime" / session_id
runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
helper = base / "hp_remote.py"

def atomic_write(path, content):
    fd, temporary = tempfile.mkstemp(dir=str(path.parent), prefix=".hp-")
    try:
        if hasattr(os, 'fchmod'):
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

atomic_write(helper, base64.b64decode(payload["helper"]))
mcp_only = config.get("workspaceMode") == "mcp-only"
workspace = str(runtime / "workspace") if mcp_only else config.get("remotePath") or str(base / "workspaces" / ("node-" + config["nodeId"]))
root = pathlib.Path(workspace)
allowed_root = runtime if mcp_only else base / "workspaces"
if not root.is_absolute() or not root.resolve().is_relative_to(allowed_root.resolve()):
    raise ValueError("Remote workspace outside application namespace")
root.mkdir(parents=True, exist_ok=True)
config["remotePath"] = str(root)
config["helperPath"] = str(helper)
config["runtimeDir"] = str(runtime)
config["configPath"] = str(runtime / "bridge.json")
if windows:
    import gzip
    import hashlib
    packed = base64.b64decode(payload['windowsRuntime'], validate=True)
    version = hashlib.sha256(packed).hexdigest()
    native = base / 'windows' / version
    marker = native / 'ready'
    if not marker.exists():
        native.mkdir(parents=True, exist_ok=True)
        bundle = json.loads(gzip.decompress(packed))
        for entry in bundle['files']:
            relative = pathlib.PurePosixPath(entry['path'])
            if relative.is_absolute() or '..' in relative.parts or '\\' in entry['path']:
                raise ValueError('Invalid Windows runtime entry')
            target = native.joinpath(*relative.parts)
            if not target.resolve().is_relative_to(native.resolve()):
                raise ValueError('Windows runtime escapes its directory')
            target.parent.mkdir(parents=True, exist_ok=True)
            atomic_write(target, base64.b64decode(entry['content'], validate=True))
        atomic_write(marker, version.encode())
    config.update(platform='windows', windowsAgent=str(native / 'agent.cjs'), pythonExecutable=sys.executable)
if config.get("workspaceId"):
    if not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", config["workspaceId"]):
        raise ValueError("Invalid workspace ID")
    state_dir = base / "workspace-state"
    state_dir.mkdir(exist_ok=True, mode=0o700)
    config["workspaceStatePath"] = str(state_dir / (config["workspaceId"] + ".json"))
atomic_write(runtime / "bridge.json", json.dumps(config).encode())
mcp = {"mcpServers": {"happypanda_local": {
    "type": "http", "url": "http://127.0.0.1:" + str(config["remotePort"]) + "/mcp",
    "headers": {"Authorization": "Bearer " + config["token"]}
}}}
atomic_write(runtime / "mcp.json", json.dumps(mcp).encode())
hook_command = (('"' + sys.executable.replace('\\','/') + '" "' + str(helper).replace('\\','/') + '" hook "' + config['configPath'].replace('\\','/') + '"') if windows else
                "python3 " + __import__("shlex").quote(str(helper)) + " hook " + __import__("shlex").quote(config["configPath"]))
hooks = {event: [{"hooks": [{"type": "command", "command": hook_command, "timeout": 5}]}]
         for event in ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "Notification"]}
environment = runpy.run_path(str(helper))["provider_environment"](config)
if windows and config['kind'] != 'shell':
    runpy.run_path(str(helper))['claude_command'](config)
settings = {"hooks": hooks, "env": environment, "apiKeyHelper": ""}
if config["kind"] == "claude":
    settings.update(permissions={"defaultMode": "bypassPermissions"}, sandbox={"enabled": False})
    if mcp_only:
        settings["autoMemoryEnabled"] = False
atomic_write(runtime / "settings.json", json.dumps(settings).encode())
if config["kind"] == "login":
    browser_dir = runtime / "browser"
    browser_dir.mkdir(exist_ok=True, mode=0o700)
    browser_script = "#!/bin/sh\nexec python3 " + __import__("shlex").quote(str(helper)) + " browser " + __import__("shlex").quote(config["configPath"]) + ' "$@"\n'
    if windows:
        atomic_write(browser_dir / 'browser.cmd', ('@echo off\r\n"' + sys.executable + '" "' + str(helper) + '" browser "' + config['configPath'] + '" %*\r\n').encode())
    for browser_name in ["xdg-open", "sensible-browser"]:
        browser_path = browser_dir / browser_name
        atomic_write(browser_path, browser_script.encode())
        browser_path.chmod(0o700)
print(json.dumps({"home": pathlib.Path.home().as_posix(), "helperPath": helper.as_posix(),
                  "configPath": pathlib.Path(config["configPath"]).as_posix(), "remotePath": root.as_posix()}))
