import base64
import hashlib
import json
import os
import pathlib
import re
import sys
import tempfile


def import_files(payload):
    workspace = pathlib.Path(payload["workspacePath"])
    managed = pathlib.Path.home() / ".local" / "share" / "happypanda" / "workspaces"
    if not workspace.is_absolute() or not workspace.resolve().is_relative_to(managed.resolve()):
        raise ValueError("Workspace is outside HappyPanda")
    config = pathlib.Path(os.environ.get("CLAUDE_CONFIG_DIR") or pathlib.Path.home() / ".claude")
    project_name = os.environ.get("CLAUDE_CODE_PROJECT_DIR_NAME") or re.sub(r"[^a-zA-Z0-9]", "-", str(workspace))
    if not project_name or "/" in project_name or "\\" in project_name or project_name in [".", ".."]:
        raise ValueError("Invalid project memory directory")
    projects = config / "projects"
    projects.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination = projects / project_name / "memory"
    if (projects / project_name).is_symlink() or destination.is_symlink() or not destination.resolve().is_relative_to(projects.resolve()):
        raise ValueError("Memory directory escapes Claude projects")
    validated = []
    total = 0
    names = set()
    files = payload["files"]
    if not isinstance(files, list) or not files or len(files) > 2000:
        raise ValueError("Invalid memory file list")
    for entry in files:
        relative = pathlib.PurePosixPath(entry["path"])
        if relative.is_absolute() or ".." in relative.parts or "\\" in entry["path"] or relative.suffix.lower() != ".md":
            raise ValueError("Invalid memory file path")
        if str(relative) in names:
            raise ValueError("Duplicate memory file")
        names.add(str(relative))
        content = base64.b64decode(entry["content"], validate=True)
        total += len(content)
        if len(content) > 2 * 1024 * 1024 or total > 16 * 1024 * 1024 or len(content) != entry["bytes"] or hashlib.sha256(content).hexdigest() != entry["sha256"]:
            raise ValueError("Memory snapshot verification failed")
        target = destination.joinpath(*relative.parts)
        if not target.resolve().is_relative_to(destination.resolve()) or target.is_symlink():
            raise ValueError("Memory path is a symbolic link")
        validated.append((relative, target, content, entry["sha256"]))
    # Publish the index after its topic files are available.
    validated.sort(key=lambda entry: (str(entry[0]).lower() == "memory.md", str(entry[0])))
    imported = 0
    unchanged = 0
    conflicts = []
    for relative, target, content, digest in validated:
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not target.parent.resolve().is_relative_to(destination.resolve()):
            raise ValueError("Memory parent escapes destination")
        fd, temporary = tempfile.mkstemp(dir=str(target.parent), prefix=".hp-memory-")
        try:
            os.chmod(temporary, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            try:
                os.link(temporary, target)
            except FileExistsError:
                if target.is_symlink() or not target.is_file():
                    conflicts.append(str(relative))
                elif hashlib.sha256(target.read_bytes()).hexdigest() == digest:
                    unchanged += 1
                else:
                    conflicts.append(str(relative))
                continue
        finally:
            os.unlink(temporary)
        if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            raise ValueError("Imported memory verification failed")
        imported += 1
    return {"destinationPath": str(destination), "imported": imported, "unchanged": unchanged, "conflicts": conflicts}


if __name__ == "__main__":
    print(json.dumps(import_files(json.load(sys.stdin))))
