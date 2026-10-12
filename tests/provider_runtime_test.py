"""Runtime regression checks; uses synthetic credentials and no model requests."""
import importlib.util
import base64
import contextlib
import io
import json
import os
import pathlib
import runpy
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("hp_remote", pathlib.Path(__file__).parents[1] / "resources" / "hp_remote.py")
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


class ReplacedProcess(Exception):
    pass


class ProviderRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="hp-provider-runtime-")
        self.root = pathlib.Path(self.directory.name)
        self.config = {"kind": "claude", "remotePath": str(self.root), "runtimeDir": str(self.root),
                       "helperPath": "/synthetic/hp_remote.py", "tmuxName": "hp-synthetic-test",
                       "sessionId": "ccd5dcec-8b53-4160-b5db-27306854c881", "nodeId": "test"}

    def tearDown(self):
        self.directory.cleanup()

    def exec_cli(self, config):
        captured = {}

        def replace(executable, args, env):
            captured.update(args=args, env=env)
            raise ReplacedProcess()

        with patch.object(pathlib.Path, "home", return_value=self.root), patch.object(remote.os, "chdir"), \
             patch.object(remote.os.path, "isfile", return_value=True), patch.object(remote.os, "execve", side_effect=replace), \
             patch.dict(os.environ, {"ANTHROPIC_AUTH_TOKEN": "old-synthetic-token", "ANTHROPIC_API_KEY": "old-key", "CLAUDE_CODE_USE_BEDROCK": "1"}):
            with self.assertRaises(ReplacedProcess):
                remote.run_cli(config)
        return captured

    def test_switch_and_official_reset_remove_conflicting_inherited_credentials(self):
        self.config["provider"] = {"fingerprint": "second:1", "env": {"ANTHROPIC_BASE_URL": "https://synthetic.example.com",
                                   "ANTHROPIC_API_KEY": "synthetic-$()-quote-'", "ANTHROPIC_MODEL": "gateway-model"}}
        actual = self.exec_cli(self.config)
        self.assertEqual(actual["env"]["ANTHROPIC_AUTH_TOKEN"], "")
        self.assertEqual(actual["env"]["CLAUDE_CODE_USE_BEDROCK"], "")
        self.assertEqual(actual["env"]["ANTHROPIC_API_KEY"], "synthetic-$()-quote-'")
        self.assertNotIn("synthetic-$()-quote-'", " ".join(actual["args"]))
        self.assertEqual(actual["args"][-2:], ["--model", "gateway-model"])
        self.config["provider"] = {"fingerprint": "official", "env": {}}
        official = self.exec_cli(self.config)
        for name in ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"]:
            self.assertEqual(official["env"][name], "")

    def test_trusted_claude_sessions_skip_permission_classification_for_all_providers(self):
        for provider in [None, {"fingerprint": "gateway:1", "env": {}}]:
            with self.subTest(provider=provider):
                self.config["provider"] = provider
                args = self.exec_cli(self.config)["args"]
                self.assertIn("--dangerously-skip-permissions", args)
                self.assertIn("--session-id", args)

    def test_bootstrap_limits_trusted_permission_settings_to_claude_sessions(self):
        resources = pathlib.Path(__file__).parents[1] / "resources"
        for kind in ["claude", "login", "shell"]:
            with self.subTest(kind=kind):
                config = dict(self.config, kind=kind, remotePort=12345, token="synthetic-bridge-token",
                              remotePath=str(self.root / ".local/share/happypanda/workspaces/test"))
                payload = {"config": config, "helper": base64.b64encode((resources / "hp_remote.py").read_bytes()).decode()}
                with patch.object(pathlib.Path, "home", return_value=self.root), \
                     patch.object(remote.sys, "stdin", io.StringIO(json.dumps(payload))), \
                     patch.object(os, "fchmod", create=True), contextlib.redirect_stdout(io.StringIO()):
                    runpy.run_path(str(resources / "bootstrap.py"))
                settings = json.loads((self.root / ".local/share/happypanda/runtime" / self.config["sessionId"] / "settings.json").read_text())
                self.assertIn("SessionStart", settings["hooks"])
                self.assertIn("env", settings)
                if kind == "claude":
                    self.assertEqual(settings["permissions"]["defaultMode"], "bypassPermissions")
                    self.assertFalse(settings["sandbox"]["enabled"])
                else:
                    self.assertNotIn("permissions", settings)
                    self.assertNotIn("sandbox", settings)

    def test_resume_uses_latest_forked_conversation_before_original_import(self):
        actual_id = "80c33e38-cbaf-4dd8-ad65-7861cd331844"
        project = self.root / ".claude" / "projects" / "test"
        project.mkdir(parents=True)
        (project / (actual_id + ".jsonl")).write_text("{}\n")
        (self.root / "resume.json").write_text(json.dumps({"sessionId": actual_id}))
        self.config["transcriptPath"] = "/synthetic/original-import.jsonl"
        actual = self.exec_cli(self.config)
        self.assertEqual(actual["args"][actual["args"].index("--resume") + 1], actual_id)
        self.assertNotIn("--fork-session", actual["args"])

    def test_reconnect_is_idempotent_but_changed_provider_restarts_only_its_pane(self):
        self.config["provider"] = {"fingerprint": "first:1", "env": {}}
        (self.root / "applied-provider.json").write_text(json.dumps({"provider": "first:1", "reload": None,
                                                                  "permissionMode": "bypassPermissions", "sandbox": False}))
        calls = []
        dead = False

        def tmux(*args, **kwargs):
            calls.append(args)
            return SimpleNamespace(returncode=0, stdout="43210" if args[-1] == "#{pane_pid}" else "1" if dead else "0")

        def stop(pid, signal):
            nonlocal dead
            self.assertEqual(pid, 43210)
            dead = True

        def persist(path, value):
            path.write_text(json.dumps(value))

        with patch.object(remote, "tmux", side_effect=tmux), patch.object(remote, "private_json", side_effect=persist), patch.object(remote.os, "kill", side_effect=stop) as kill:
            remote.ensure_session(self.config, "/synthetic/config.json")
            self.assertFalse(any(call[0] == "respawn-pane" for call in calls))
            self.config["provider"]["fingerprint"] = "second:1"
            remote.ensure_session(self.config, "/synthetic/config.json")
            restarts = [call for call in calls if call[0] == "respawn-pane"]
            self.assertEqual(len(restarts), 1)
            self.assertIn("hp-synthetic-test:0.0", restarts[0])
            kill.assert_called_once()
            dead = False
            remote.ensure_session(self.config, "/synthetic/config.json")
            self.assertEqual(len([call for call in calls if call[0] == "respawn-pane"]), 1)

    def test_existing_auto_session_migrates_once_then_reconnects_without_restart(self):
        applied = self.root / "applied-provider.json"
        applied.write_text(json.dumps({"provider": "official", "reload": None, "nodeEgress": False}))
        calls = []
        dead = False

        def tmux(*args, **kwargs):
            nonlocal dead
            calls.append(args)
            if args[0] == "respawn-pane":
                dead = False
            return SimpleNamespace(returncode=0, stdout="43210" if args[-1] == "#{pane_pid}" else "1" if dead else "0")

        def stop(pid, signal):
            nonlocal dead
            self.assertEqual(pid, 43210)
            dead = True

        with patch.object(remote, "tmux", side_effect=tmux), \
             patch.object(remote, "private_json", side_effect=lambda path, value: path.write_text(json.dumps(value))), \
             patch.object(remote.os, "kill", side_effect=stop) as kill:
            remote.ensure_session(self.config, "/synthetic/config.json")
            self.assertEqual(json.loads(applied.read_text())["permissionMode"], "bypassPermissions")
            self.assertFalse(json.loads(applied.read_text())["sandbox"])
            remote.ensure_session(self.config, "/synthetic/config.json")
            self.assertEqual(len([call for call in calls if call[0] == "respawn-pane"]), 1)
            kill.assert_called_once()

    def test_shell_starts_without_api_credentials_and_login_clears_them(self):
        self.config["kind"] = "login"
        self.config["provider"] = {"env": {"ANTHROPIC_AUTH_TOKEN": "synthetic"}}
        with patch.object(pathlib.Path, "home", return_value=self.root), patch.object(remote.os, "chdir"), patch.object(remote.os.path, "isfile", return_value=True), patch.object(remote, "run_login") as login:
            remote.run_cli(self.config)
        self.assertEqual(login.call_args.args[2]["ANTHROPIC_AUTH_TOKEN"], "")

    def test_official_node_route_clears_inherited_proxy_settings(self):
        self.config["nodeEgress"] = True
        with patch.dict(os.environ, {"HTTPS_PROXY": "http://old-proxy.invalid", "all_proxy": "socks5://old-proxy.invalid"}):
            actual = self.exec_cli(self.config)
        self.assertEqual(actual["env"]["HTTPS_PROXY"], "")
        self.assertEqual(actual["env"]["all_proxy"], "")

    def test_login_completion_requires_successful_official_authentication(self):
        self.config.update(kind="login", loginAttempt="test-attempt")
        settings = self.root / "settings.json"
        settings.write_text(json.dumps({"env": {}, "hooks": {}}))
        for exit_code, logged_in, method, expected in [(1, True, "claude.ai", False), (0, False, "none", False), (0, True, "api_key", False), (0, True, "claude.ai", True)]:
            with self.subTest(exit_code=exit_code, method=method):
                child = SimpleNamespace(wait=lambda: exit_code)
                status = SimpleNamespace(returncode=0, stdout=json.dumps({"loggedIn": logged_in, "authMethod": method}))
                with patch.object(remote.subprocess, "Popen", return_value=child) as start, patch.object(remote.subprocess, "run", return_value=status), \
                     patch.object(remote, "private_json", side_effect=lambda path, value: path.write_text(json.dumps(value))), patch.object(remote, "post") as post:
                    remote.run_login(self.config, "/synthetic/claude", {"PATH": "/usr/bin"})
                event = post.call_args.args[1]
                self.assertEqual(event["success"], expected)
                self.assertEqual(event["attemptId"], "test-attempt")
                self.assertEqual(start.call_args.kwargs["env"]["BROWSER"], str(self.root / "browser" / "xdg-open"))
                self.assertNotIn("--dangerously-skip-permissions", start.call_args.args[0])
                self.assertNotIn("url", json.loads((self.root / "login-result.json").read_text()))

    def test_first_workspace_launch_waits_for_a_verified_ready_marker(self):
        marker = self.root / "workspace-ready.json"
        self.config.update(waitForWorkspace=True, workspaceStatePath=str(marker))
        marker.write_text(json.dumps({"ready": True, "remotePath": "/different-project"}))
        def finish(_seconds):
            marker.write_text(json.dumps({"ready": True, "remotePath": self.config["remotePath"]}))
        with patch.object(remote.time, "sleep", side_effect=finish) as sleep:
            remote.wait_for_workspace(self.config)
        sleep.assert_called_once()
        with patch.object(remote.time, "sleep") as sleep:
            remote.wait_for_workspace(self.config)
        sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
