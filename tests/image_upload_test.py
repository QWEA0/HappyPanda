"""PNG attachment storage checks, using only temporary directories."""
import base64
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("upload_image", Path(__file__).parents[1] / "resources" / "upload_image.py")
images = importlib.util.module_from_spec(spec)
spec.loader.exec_module(images)
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=")


class ImageUploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hp-images-")
        self.home = Path(self.temp.name)
        self.metadata = {"sessionKey": "a" * 64, "sha256": hashlib.sha256(PNG).hexdigest(), "bytes": len(PNG)}

    def tearDown(self):
        self.temp.cleanup()

    def save(self, metadata=None, data=PNG):
        return images.store_image(metadata or self.metadata, data, self.home)

    def test_verified_image_lives_outside_workspace_and_duplicate_is_reused(self):
        workspace = self.home / "project"
        workspace.mkdir()
        first = self.save()
        destination = Path(first["path"])
        before = destination.stat().st_mtime_ns
        self.assertEqual(destination.read_bytes(), PNG)
        self.assertEqual(self.save(), first)
        self.assertEqual(destination.stat().st_mtime_ns, before)
        self.assertEqual(list(workspace.iterdir()), [])
        self.assertEqual(list(destination.parent.glob("*.part")), [])
        if os.name != "nt":
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
            self.assertEqual(destination.parent.stat().st_mode & 0o777, 0o700)

    def test_sessions_are_isolated(self):
        first = self.save()
        second = self.save({**self.metadata, "sessionKey": "b" * 64})
        self.assertNotEqual(first["path"], second["path"])

    def test_corrupt_existing_file_is_preserved(self):
        destination = Path(self.save()["path"])
        destination.write_bytes(b"different content")
        with self.assertRaises(ValueError):
            self.save()
        self.assertEqual(destination.read_bytes(), b"different content")

    def test_truncation_or_invalid_image_does_not_publish(self):
        with self.assertRaises(ValueError):
            self.save(data=PNG[:-1])
        bad = b"not a PNG image" * 5
        with self.assertRaises(ValueError):
            self.save({**self.metadata, "sha256": hashlib.sha256(bad).hexdigest(), "bytes": len(bad)}, bad)
        self.assertFalse((self.home / ".local").exists())

    def test_path_traversal_is_rejected_before_writing(self):
        with self.assertRaises(ValueError):
            self.save({**self.metadata, "sessionKey": "../../project"})
        self.assertFalse((self.home / ".local").exists())

    def test_symlinked_attachment_directory_is_rejected(self):
        root = self.home / ".local" / "share" / "happypanda"
        root.mkdir(parents=True)
        outside = self.home / "outside"
        outside.mkdir()
        try:
            (root / "attachments").symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("Creating symbolic links is unavailable")
        with self.assertRaises(ValueError):
            self.save()
        self.assertEqual(list(outside.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
