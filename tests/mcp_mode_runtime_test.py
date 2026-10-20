"""MCP-only launch regressions; no account, SSH or model requests."""
import base64
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import runpy
import tempfile
import unittest
from unittest.mock import patch

resources = pathlib.Path(__file__).parents[1] / 'resources'
spec = importlib.util.spec_from_file_location('mcp_remote', resources / 'hp_remote.py')
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


class McpOnlyRuntimeTests(unittest.TestCase):
    def test_bootstrap_keeps_existing_mirror_untouched_and_creates_only_a_runtime_directory(self):
        with tempfile.TemporaryDirectory(prefix='hp-mcp-bootstrap-') as directory:
            home = pathlib.Path(directory)
            base = home / '.local/share/happypanda'
            mirror = base / 'workspaces/fixture'
            mirror.mkdir(parents=True)
            (mirror / 'project.txt').write_text('previous-mirror')
            config = {'kind': 'claude', 'sessionId': 'mcp-test', 'nodeId': 'fixture', 'workspaceId': 'fixture',
                      'workspaceMode': 'mcp-only', 'remotePath': str(mirror), 'remotePort': 12345, 'token': 'synthetic'}
            payload = {'config': config, 'helper': base64.b64encode((resources / 'hp_remote.py').read_bytes()).decode()}
            with (patch.object(pathlib.Path, 'home', return_value=home),
                  patch.object(remote.sys, 'stdin', io.StringIO(json.dumps(payload))),
                  patch.object(os, 'fchmod', create=True), contextlib.redirect_stdout(io.StringIO())):
                runpy.run_path(str(resources / 'bootstrap.py'))
            runtime = base / 'runtime/mcp-test'
            saved = json.loads((runtime / 'bridge.json').read_text())
            self.assertEqual(pathlib.Path(saved['remotePath']), runtime / 'workspace')
            self.assertEqual(list((runtime / 'workspace').iterdir()), [])
            self.assertEqual((mirror / 'project.txt').read_text(), 'previous-mirror')
            settings = json.loads((runtime / 'settings.json').read_text())
            self.assertFalse(settings['autoMemoryEnabled'])
            mcp = json.loads((runtime / 'mcp.json').read_text())
            self.assertEqual(list(mcp['mcpServers']), ['happypanda_local'])

    def test_mcp_mode_disables_builtin_tools_and_other_mcp_sources_on_both_platforms(self):
        with tempfile.TemporaryDirectory(prefix='hp-mcp-launch-') as directory:
            for platform in ['posix', 'windows']:
                with self.subTest(platform=platform):
                    config = {'kind': 'claude', 'platform': platform, 'workspaceMode': 'mcp-only', 'workspaceId': 'fixture',
                              'sessionId': 'ccd5dcec-8b53-4160-b5db-27306854c881', 'remotePath': directory, 'runtimeDir': directory,
                              'localPath': 'C:/Local/project', 'localPlatform': 'win32', 'waitForWorkspace': True}
                    with (patch.object(remote, 'claude_command', return_value=['synthetic-claude']),
                          patch.object(remote.os, 'chdir'), patch.object(remote.os.path, 'isfile', return_value=True),
                          patch.object(pathlib.Path, 'home', return_value=pathlib.Path(directory)),
                          patch.object(remote.os, 'execve') as execute,
                          patch.object(remote, 'windows_wait', return_value=0) as native):
                        remote.run_cli(config)
                    args = native.call_args.args[0] if platform == 'windows' else execute.call_args.args[1]
                    self.assertEqual(args[args.index('--tools') + 1], '')
                    self.assertIn('--strict-mcp-config', args)
                    self.assertEqual(args[args.index('--setting-sources') + 1], '')
                    self.assertNotIn('--disable-slash-commands', args)
                    prompt = args[args.index('--append-system-prompt') + 1]
                    self.assertIn('C:/Local/project', prompt)
                    self.assertIn('workspace_id fixture', prompt)
                    self.assertIn('local_exec', prompt)
                    self.assertNotIn('Working files synchronize', prompt)
                    self.assertNotIn('Linux VPS by default', prompt)

    def test_mode_change_restarts_an_existing_tmux_pane_once(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory(prefix='hp-mcp-reload-') as directory:
            config = {'kind': 'claude', 'runtimeDir': directory, 'remotePath': directory, 'helperPath': '/synthetic/helper',
                      'tmuxName': 'hp-test', 'workspaceMode': 'mcp-only'}
            applied = pathlib.Path(directory) / 'applied-provider.json'
            applied.write_text(json.dumps({'provider': 'official', 'reload': None, 'nodeEgress': False,
                                           'permissionMode': 'bypassPermissions', 'sandbox': False}))
            dead = False
            def tmux(*args, **kwargs):
                return SimpleNamespace(returncode=0, stdout='43210' if args[-1] == '#{pane_pid}' else '1' if dead else '0')
            def stop(*args):
                nonlocal dead
                dead = True
            with patch.object(remote, 'tmux', side_effect=tmux) as calls, patch.object(remote.os, 'kill', side_effect=stop):
                remote.ensure_session(config, '/synthetic/config')
                self.assertEqual(sum(call.args[0] == 'respawn-pane' for call in calls.call_args_list), 1)
                dead = False
                remote.ensure_session(config, '/synthetic/config')
                self.assertEqual(sum(call.args[0] == 'respawn-pane' for call in calls.call_args_list), 1)


if __name__ == '__main__':
    unittest.main()
