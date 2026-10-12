"""Isolated Linux/tmux integration check. Never calls a model provider."""
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import uuid
from unittest.mock import patch

payload = json.load(sys.stdin)
socket = "hp-provider-smoke-" + uuid.uuid4().hex
checks = []
with tempfile.TemporaryDirectory(prefix="hp-provider-smoke-") as directory:
    root = pathlib.Path(directory)
    executable = root / ".local" / "bin" / "claude"
    executable.parent.mkdir(parents=True)
    executable.write_text('''#!/usr/bin/env python3
import json, os, pathlib, signal, sys, time
root = pathlib.Path(os.environ["HP_PROVIDER_SMOKE_ROOT"])
session = sys.argv[sys.argv.index("--session-id")+1] if "--session-id" in sys.argv else sys.argv[sys.argv.index("--resume")+1]
project = root / ".claude" / "projects" / "smoke"
project.mkdir(parents=True, exist_ok=True)
(project / (session + ".jsonl")).write_text("{}\\n")
result = {"pid":os.getpid(), "args":sys.argv, "env":{key:value for key,value in os.environ.items() if key.startswith("ANTHROPIC_") or key.startswith("CLAUDE_CODE_")}}
(root / "observed.json").write_text(json.dumps(result))
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
while True: time.sleep(1)
''')
    executable.chmod(0o700)
    config = {"nodeId": "provider-smoke", "sessionId": str(uuid.uuid4()), "kind": "claude",
              "tmuxName": "hp-" + uuid.uuid4().hex, "remotePort": 12345, "token": "synthetic-bridge"}
    runner = root / "runner.py"
    observed = root / "observed.json"

    def prepare(fingerprint, environment):
        config["provider"] = {"fingerprint": fingerprint, "env": environment}
        captured = io.StringIO()
        with patch.object(pathlib.Path, "home", return_value=root), patch.object(sys, "stdin", io.StringIO(json.dumps({"helper": payload["helper"], "config": config}))), contextlib.redirect_stdout(captured):
            exec(compile(payload["bootstrap"], "bootstrap.py", "exec"), {"__name__": "provider_smoke"})
        result = json.loads(captured.getvalue())
        current = json.loads(pathlib.Path(result["configPath"]).read_text())
        current["helperPath"] = str(runner)
        pathlib.Path(result["configPath"]).write_text(json.dumps(current))
        return current, result

    current, location = prepare("first:1", {"ANTHROPIC_BASE_URL": "https://first.example.invalid", "ANTHROPIC_AUTH_TOKEN": "synthetic-first"})
    helper = pathlib.Path(location["helperPath"])
    runner.write_text("import importlib.util, os, pathlib, sys\n" +
                      "root = pathlib.Path(" + repr(str(root)) + ")\n" +
                      "pathlib.Path.home = classmethod(lambda cls: root)\n" +
                      "os.environ['HP_PROVIDER_SMOKE_ROOT'] = str(root)\n" +
                      "os.environ['ANTHROPIC_API_KEY'] = 'synthetic-stale-key'\n" +
                      "os.environ['CLAUDE_CODE_USE_BEDROCK'] = '1'\n" +
                      "spec = importlib.util.spec_from_file_location('hp_remote', " + repr(str(helper)) + ")\n" +
                      "module = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\n" +
                      "module.run_cli(module.load(sys.argv[2]))\n")
    spec = importlib.util.spec_from_file_location("hp_remote", helper)
    remote = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(remote)
    remote.tmux = lambda *args, **kwargs: subprocess.run(["tmux", "-L", socket, *args], **kwargs)

    def started(previous_pid=None):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            try:
                value = json.loads(observed.read_text())
                if value["pid"] != previous_pid:
                    return value
            except (OSError, ValueError):
                pass
            time.sleep(0.05)
        raise AssertionError("Synthetic CLI did not start")

    try:
        remote.ensure_session(current, location["configPath"])
        first = started()
        assert first["env"]["ANTHROPIC_AUTH_TOKEN"] == "synthetic-first"
        assert first["env"]["ANTHROPIC_API_KEY"] == ""
        assert first["env"]["CLAUDE_CODE_USE_BEDROCK"] == ""
        checks.append("initial_environment_and_conflict_reset")
        remote.ensure_session(current, location["configPath"])
        assert started()["pid"] == first["pid"]
        checks.append("reconnect_keeps_process")
        current, location = prepare("second:1", {"ANTHROPIC_BASE_URL": "https://second.example.invalid", "ANTHROPIC_API_KEY": "synthetic-second", "ANTHROPIC_MODEL": "second-model"})
        remote.ensure_session(current, location["configPath"])
        second = started(first["pid"])
        assert second["env"]["ANTHROPIC_API_KEY"] == "synthetic-second" and second["env"]["ANTHROPIC_AUTH_TOKEN"] == ""
        assert "--resume" in second["args"] and config["sessionId"] in second["args"]
        assert second["args"][-2:] == ["--model", "second-model"]
        checks.append("provider_switch_restarts_and_resumes_session")
        assert "synthetic-second" not in pathlib.Path("/proc", str(second["pid"]), "cmdline").read_text()
        checks.append("no_credential_in_process_arguments")
        settings_path = pathlib.Path(current["runtimeDir"]) / "settings.json"
        assert settings_path.stat().st_mode & 0o777 == 0o600
        assert pathlib.Path(location["configPath"]).stat().st_mode & 0o777 == 0o600
        assert json.loads(settings_path.read_text())["env"]["ANTHROPIC_AUTH_TOKEN"] == ""
        checks.append("private_settings_override_stale_authentication")
        remote.ensure_session(current, location["configPath"])
        assert started()["pid"] == second["pid"]
        checks.append("retry_does_not_repeat_reload")
        current, location = prepare("official", {})
        remote.ensure_session(current, location["configPath"])
        official = started(second["pid"])
        assert all(official["env"][name] == "" for name in ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"])
        checks.append("official_mode_removes_provider_environment")
        print(json.dumps({"passed": True, "checks": checks, "realModelRequest": False}))
    finally:
        subprocess.run(["tmux", "-L", socket, "kill-server"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
