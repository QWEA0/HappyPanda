"""Native Windows adapter regressions; no model or account requests."""
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('native_remote', pathlib.Path(__file__).parents[1] / 'resources' / 'hp_remote.py')
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


class WindowsRuntimeTests(unittest.TestCase):
    def test_discovers_the_current_npm_native_binary_from_package_metadata(self):
        with tempfile.TemporaryDirectory(prefix='hp-native-package-') as directory:
            root = pathlib.Path(directory)
            package = root / 'npm' / 'node_modules' / '@anthropic-ai' / 'claude-code'
            (package / 'bin').mkdir(parents=True)
            executable = package / 'bin' / 'claude.exe'
            executable.touch()
            (package / 'package.json').write_text(json.dumps({'bin': {'claude': 'bin/claude.exe'}}))
            with patch.dict(os.environ, {'APPDATA': directory}), patch.object(remote.shutil, 'which', return_value=None), patch.object(remote.pathlib.Path, 'home', return_value=root):
                self.assertEqual(remote.claude_command({'platform': 'windows'}), [str(executable.resolve())])

    def test_launches_claude_with_native_arguments_and_windows_context(self):
        with tempfile.TemporaryDirectory(prefix='hp-native-cli-') as directory:
            root = pathlib.Path(directory)
            config = {'platform': 'windows', 'kind': 'claude', 'remotePath': directory, 'runtimeDir': directory,
                      'workspaceId': 'fixture', 'sessionId': 'b4f615fd-c219-4d04-99f6-1bac52bcdd8b'}
            with patch.object(remote, 'claude_command', return_value=['C:/Native/claude.exe']), patch.object(remote.os, 'chdir'), \
                 patch.object(remote.pathlib.Path, 'home', return_value=root), patch.object(remote.subprocess, 'call', return_value=0) as call:
                self.assertEqual(remote.run_cli(config), 0)
            args = call.call_args.args[0]
            self.assertEqual(args[0], 'C:/Native/claude.exe')
            self.assertIn('--session-id', args)
            self.assertIn('native Windows server', args[args.index('--append-system-prompt') + 1])
            self.assertNotIn('Linux VPS', ' '.join(args))

    @unittest.skipUnless(os.name == 'nt', 'Windows APIs')
    def test_windows_metrics_and_supervisor_liveness_use_native_apis(self):
        memory, uptime = remote.windows_memory()
        self.assertGreater(memory['MemTotal'], 0)
        self.assertGreaterEqual(memory['MemAvailable'], 0)
        self.assertGreater(uptime, 0)
        with tempfile.TemporaryDirectory(prefix='hp-native-process-') as directory:
            state = pathlib.Path(directory) / 'windows-session.json'
            state.write_text(json.dumps({'pid': os.getpid()}))
            self.assertTrue(remote.windows_session_alive({'runtimeDir': directory}))
            state.write_text(json.dumps({'pid': 0}))
            self.assertFalse(remote.windows_session_alive({'runtimeDir': directory}))


if __name__ == '__main__':
    unittest.main()
