import base64
import hashlib
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("import_memory", pathlib.Path(__file__).parents[1] / "resources" / "import_memory.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

def entry(name, content):
    value = content.encode()
    return {"path": name, "bytes": len(value), "sha256": hashlib.sha256(value).hexdigest(), "content": base64.b64encode(value).decode()}

class MemoryImportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hp-memory-runtime-")
        self.root = pathlib.Path(self.temporary.name)
        self.workspace = self.root / ".local" / "share" / "happypanda" / "workspaces" / "test"
        self.workspace.mkdir(parents=True)
        self.payload = {"workspacePath": str(self.workspace), "files": [entry("MEMORY.md", "[Topic](topics/project.md)\n"), entry("topics/project.md", "Synthetic note.\n")]}
        self.env = patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(self.root / ".claude"), "CLAUDE_CODE_PROJECT_DIR_NAME": "test-project"})
        self.env.start()
        self.home = patch.object(pathlib.Path, "home", return_value=self.root)
        self.home.start()
    def tearDown(self):
        self.home.stop(); self.env.stop(); self.temporary.cleanup()
    def test_import_is_verified_idempotent_and_preserves_remote_edits(self):
        first = worker.import_files(self.payload)
        self.assertEqual(first["imported"], 2)
        destination = pathlib.Path(first["destinationPath"])
        self.assertEqual((destination / "topics" / "project.md").read_text(), "Synthetic note.\n")
        second = worker.import_files(self.payload)
        self.assertEqual(second["unchanged"], 2)
        (destination / "topics" / "project.md").write_text("Remote edit\n")
        third = worker.import_files(self.payload)
        self.assertEqual(third["conflicts"], ["topics/project.md"])
        self.assertEqual((destination / "topics" / "project.md").read_text(), "Remote edit\n")
        self.assertEqual(list(destination.rglob(".hp-memory-*")), [])
    def test_rejects_traversal_bad_hashes_and_non_memory_files_before_writing(self):
        for name in ["../outside.md", "/outside.md", "credentials.json"]:
            with self.assertRaises(ValueError):
                worker.import_files({**self.payload, "files": [entry(name, "text")]})
        invalid = entry("MEMORY.md", "text"); invalid["sha256"] = "0" * 64
        with self.assertRaises(ValueError):
            worker.import_files({**self.payload, "files": [invalid]})

if __name__ == "__main__":
    unittest.main()
