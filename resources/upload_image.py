"""Store a clipboard PNG outside workspaces; publish only after content verification."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys
import uuid

MAX_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 40_000_000


def checked_directory(target):
    try:
        target.mkdir(mode=0o700)
    except FileExistsError:
        pass
    if not stat.S_ISDIR(target.lstat().st_mode):
        raise ValueError("Image directory must not be a symbolic link or file")


def store_image(metadata, data, home=None):
    session_key, digest = metadata.get("sessionKey", ""), metadata.get("sha256", "")
    if not isinstance(session_key, str) or not re.fullmatch(r"[a-f0-9]{64}", session_key):
        raise ValueError("Invalid image session")
    if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("Invalid image checksum")
    if len(data) > MAX_BYTES or len(data) != metadata.get("bytes") or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("Image size/checksum verification failed")
    if len(data) < 33 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[8:16] != b"\x00\x00\x00\rIHDR":
        raise ValueError("Invalid PNG")
    width, height = struct.unpack(">II", data[16:24])
    if not width or not height or width * height > MAX_PIXELS:
        raise ValueError("Invalid image dimensions")

    root = (Path(home) if home is not None else Path.home()).resolve(strict=True)
    for segment in (".local", "share", "happypanda", "attachments", session_key):
        root = root / segment
        checked_directory(root)
    destination = root / (digest + ".png")

    def verify_existing():
        info = destination.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size != len(data):
            raise ValueError("Existing image is different; preserved without overwriting")
        with destination.open("rb") as saved:
            if hashlib.sha256(saved.read(MAX_BYTES + 1)).hexdigest() != digest:
                raise ValueError("Existing image checksum mismatch; preserved")

    if os.path.lexists(destination):
        verify_existing()
    else:
        temporary = root / (".upload-" + uuid.uuid4().hex + ".part")
        try:
            with temporary.open("xb") as output:
                os.chmod(temporary, 0o600)
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            # An exclusive hard-link publish also makes simultaneous identical pastes safe.
            try:
                os.link(temporary, destination)
            except FileExistsError:
                verify_existing()
        finally:
            temporary.unlink(missing_ok=True)
    return {"path": str(destination), "sha256": digest, "bytes": len(data)}


if __name__ == "__main__":
    try:
        print(json.dumps(store_image(json.loads(sys.argv[1]), sys.stdin.buffer.read(MAX_BYTES + 1))))
    except Exception as error:
        print("Image upload failed: " + str(error), file=sys.stderr)
        sys.exit(1)
