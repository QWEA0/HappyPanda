import datetime
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time
import urllib.request
import uuid
import hashlib
import signal
import tempfile
import urllib.parse

def private_json(path, value):
    fd, temporary = tempfile.mkstemp(dir=str(path.parent), prefix=".hp-")
    try:
        if hasattr(os, 'fchmod'):
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def provider_environment(config):
    # Both the process environment and --settings must agree: settings env wins
    # over inherited shell variables and tmux keeps an old environment alive.
    names = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY",
             "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
             "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",
             "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
             "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]
    environment = {name: "" for name in names}
    if config["kind"] == "claude":
        for name, value in (config.get("provider") or {}).get("env", {}).items():
            if name not in environment or not isinstance(value, str) or "\0" in value:
                raise ValueError("Invalid provider environment")
            environment[name] = value
    if config.get("nodeEgress"):
        for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"]:
            environment[name] = ""
    return environment

def load(path):
    with open(path, encoding="utf-8") as stream:
        return json.load(stream)

def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def tmux(*args, **kwargs):
    return subprocess.run(["tmux", "-L", "happypanda", *args], **kwargs)

def claude_command(config):
    if config.get('platform') != 'windows':
        return [str(pathlib.Path.home() / '.local' / 'bin' / 'claude')]
    native = shutil.which('claude.exe')
    local = pathlib.Path.home() / '.local' / 'bin' / 'claude.exe'
    if native or local.is_file():
        return [native or str(local)]
    node = config.get('nodeExecutable') or shutil.which('node.exe')
    roots = [pathlib.Path(os.environ.get('APPDATA', '')) / 'npm']
    shim = shutil.which('claude.cmd')
    if shim:
        roots.insert(0, pathlib.Path(shim).parent)
    for root in roots:
        package = root / 'node_modules' / '@anthropic-ai' / 'claude-code'
        try:
            declared = load(package / 'package.json').get('bin', {})
            entry = declared.get('claude') if isinstance(declared, dict) else declared
            if not isinstance(entry, str):
                continue
            target = (package / entry).resolve()
            if not target.is_relative_to(package.resolve()) or not target.is_file():
                continue
            if target.suffix.lower() == '.exe':
                return [str(target)]
            if target.suffix.lower() in ['.js', '.cjs', '.mjs'] and node:
                return [node, str(target)]
        except (OSError, ValueError):
            continue
    raise RuntimeError('Claude Code is not installed for this Windows SSH user. Install Claude Code, then reconnect.')

def windows_wait(args, environment=None):
    # The child owns Ctrl+C; the Python supervisor must not exit on the same console event.
    previous = {}
    for name in ['SIGINT', 'SIGBREAK']:
        value = getattr(signal, name, None)
        if value is not None:
            previous[value] = signal.signal(value, lambda signum, frame: None)
    try:
        return subprocess.call(args, env=environment)
    finally:
        for value, handler in previous.items():
            signal.signal(value, handler)

def windows_memory():
    import ctypes
    from ctypes import wintypes
    class Memory(ctypes.Structure):
        _fields_ = [('length', wintypes.DWORD), ('load', wintypes.DWORD)] + [(name, ctypes.c_ulonglong) for name in
            ['total', 'available', 'pageTotal', 'pageAvailable', 'virtualTotal', 'virtualAvailable', 'extended']]
    value = Memory()
    value.length = ctypes.sizeof(value)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(value)):
        raise OSError('Windows memory information is unavailable')
    ctypes.windll.kernel32.GetTickCount64.restype = ctypes.c_ulonglong
    return {'MemTotal': value.total, 'MemAvailable': value.available}, ctypes.windll.kernel32.GetTickCount64() / 1000

def windows_load(cache):
    import ctypes
    from ctypes import wintypes
    idle, kernel, user = wintypes.FILETIME(), wintypes.FILETIME(), wintypes.FILETIME()
    if not ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)):
        return 0
    value = lambda item: (item.dwHighDateTime << 32) | item.dwLowDateTime
    current = (value(idle), value(kernel) + value(user))
    previous = cache.get('cpuTimes')
    cache['cpuTimes'] = current
    if not previous or current[1] <= previous[1]:
        return 0
    busy = 1 - (current[0] - previous[0]) / (current[1] - previous[1])
    return max(0, min(1, busy)) * (os.cpu_count() or 1)

def windows_session_alive(config):
    try:
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.windll.kernel32
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        descriptor = load(pathlib.Path(config['runtimeDir']) / 'windows-session.json')
        handle = kernel.OpenProcess(0x1000, False, descriptor['pid'])
        if not handle:
            return False
        try:
            code = wintypes.DWORD()
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally:
            kernel.CloseHandle(handle)
    except (OSError, ValueError, KeyError):
        return False

def post(config, event):
    request = urllib.request.Request(
        "http://127.0.0.1:" + str(config["remotePort"]) + "/events",
        data=json.dumps(event).encode(),
        headers={"Authorization": "Bearer " + config["token"], "Content-Type": "application/json"},
        method="POST")
    with urllib.request.urlopen(request, timeout=3) as response:
        return response.status in (200, 204)

def metrics(config, auth_cache):
    memory = {}
    windows = config.get('platform') == 'windows'
    if windows:
        memory, uptime = windows_memory()
    else:
        with open("/proc/meminfo") as stream:
            for line in stream:
                key, value = line.split(":", 1)
                memory[key] = int(value.strip().split()[0]) * 1024
        with open("/proc/uptime") as stream:
            uptime = float(stream.read().split()[0])
    if time.time() - auth_cache.get("time", 0) > 60:
        try:
            command = claude_command(config)
            environment = dict(os.environ)
            environment.update(provider_environment(config))
            status_args = command.copy()
            if config.get("runtimeDir"):
                status_args += ["--settings", str(pathlib.Path(config["runtimeDir"]) / "settings.json")]
            status = subprocess.run(status_args + ["auth", "status"], env=environment, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=8)
            info = json.loads(status.stdout)
            auth_cache["authenticated"] = bool(info.get("loggedIn")) and info.get("authMethod") in ["claude.ai", "oauth"]
            version = subprocess.run(command + ["--version"], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=8)
            auth_cache["version"] = version.stdout.strip()
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
            auth_cache["authenticated"] = False
            auth_cache["version"] = None
        auth_cache["time"] = time.time()
    head = None
    try:
        probe = subprocess.run(["git", "-C", config["remotePath"], "rev-parse", "--verify", "HEAD"],
                               capture_output=True, text=True, timeout=3)
        if probe.returncode == 0:
            head = probe.stdout.strip() or None
    except (OSError, subprocess.TimeoutExpired):
        pass
    platform = __import__('platform')
    return {"hostname": platform.node() if windows else os.uname().nodename, "os": platform.platform() if windows else "Linux " + os.uname().release,
            "cpuCount": os.cpu_count() or 1, "load": windows_load(auth_cache) if windows else os.getloadavg()[0],
            "memoryTotal": memory.get("MemTotal", 0), "memoryAvailable": memory.get("MemAvailable", 0),
            "diskAvailable": shutil.disk_usage(config["remotePath"]).free, "uptime": uptime,
            "claudeVersion": auth_cache.get("version"), "authenticated": auth_cache.get("authenticated", False),
            "address": config.get("sshTarget", ""), "gitHead": head, "sampledAt": timestamp()}

def record_hook(config):
    try:
        data = json.loads(sys.stdin.read(262144))
        event_name = data.get("hook_event_name", "")
        if event_name == "SessionStart" and data.get("session_id"):
            actual_id = str(uuid.UUID(data["session_id"]))
            private_json(pathlib.Path(config["runtimeDir"]) / "resume.json", {"sessionId": actual_id})
        inputs = data.get("tool_input") or {}
        event = {"type": "tool", "id": str(uuid.uuid4()), "time": timestamp(),
                 "nodeId": config["nodeId"], "sessionId": config["sessionId"],
                 "workspaceId": config.get("workspaceId"), "event": event_name,
                 "tool": data.get("tool_name"), "path": inputs.get("file_path")}
        journal = pathlib.Path(config["runtimeDir"]) / "events.jsonl"
        fd = os.open(str(journal), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a") as stream:
            stream.write(json.dumps(event) + "\n")
    except (ValueError, OSError):
        pass

def monitor(config_path):
    config = load(config_path)
    auth_cache = {}
    cursor = 0
    journal = pathlib.Path(config["runtimeDir"]) / "events.jsonl"
    while (windows_session_alive(config) if config.get('platform') == 'windows' else tmux("has-session", "-t", config["tmuxName"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0):
        try:
            config = load(config_path)
            login_result = pathlib.Path(config["runtimeDir"]) / "login-result.json"
            if config["kind"] == "login" and login_result.exists():
                result = load(login_result)
                if result.get("attemptId") == config.get("loginAttempt"):
                    post(config, result)
            if journal.exists():
                if journal.stat().st_size < cursor:
                    cursor = 0
                with open(journal, encoding="utf-8") as stream:
                    stream.seek(cursor)
                    for _ in range(60):
                        line = stream.readline()
                        if not line:
                            break
                        if not post(config, json.loads(line)):
                            break
                        cursor = stream.tell()
            post(config, {"type": "metrics", "nodeId": config["nodeId"],
                          "sessionId": config["sessionId"], "metrics": metrics(config, auth_cache)})
        except Exception:
            pass
        time.sleep(10)

def open_login_browser(config, url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in ["claude.com", "claude.ai", "console.anthropic.com", "platform.claude.com"] or parsed.path.rstrip("/") not in ["/oauth/authorize", "/cai/oauth/authorize"]:
        raise ValueError("Unsupported login URL")
    post(config, {"type": "login-url", "nodeId": config["nodeId"], "sessionId": config["sessionId"],
                  "attemptId": config.get("loginAttempt"), "url": url})

def run_login(config, executable, environment):
    settings = str(pathlib.Path(config["runtimeDir"]) / "settings.json")
    browser = pathlib.Path(config["runtimeDir"]) / "browser" / ('browser.cmd' if config.get('platform') == 'windows' else 'xdg-open')
    environment["BROWSER"] = str(browser)
    environment["PATH"] = str(browser.parent) + os.pathsep + environment.get("PATH", "/usr/bin:/bin")
    settings_data = load(settings)
    settings_data.setdefault("env", {}).update({"BROWSER": environment["BROWSER"], "PATH": environment["PATH"]})
    private_json(pathlib.Path(settings), settings_data)
    command = executable if isinstance(executable, list) else [executable]
    child = subprocess.Popen(command + ["--settings", settings, "auth", "login", "--claudeai"], env=environment)
    try:
        code = child.wait()
    except KeyboardInterrupt:
        child.terminate()
        code = child.wait()
    success = False
    if code == 0:
        try:
            status = subprocess.run(command + ["--settings", settings, "auth", "status"], env=environment,
                                    capture_output=True, text=True, timeout=15)
            info = json.loads(status.stdout)
            success = status.returncode == 0 and info.get("loggedIn") is True and info.get("authMethod") in ["claude.ai", "oauth"]
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
    result = {"type": "login-result", "nodeId": config["nodeId"], "sessionId": config["sessionId"],
              "attemptId": config.get("loginAttempt"), "success": success}
    private_json(pathlib.Path(config["runtimeDir"]) / "login-result.json", result)
    try:
        post(config, result)
    except Exception:
        pass
    return code

def run_cli(config):
    root = config["remotePath"]
    os.chdir(root)
    wait_for_workspace(config)
    if config["kind"] == "shell":
        if config.get('platform') == 'windows':
            return windows_wait(['powershell.exe', '-NoLogo', '-NoProfile'])
        os.execvp("bash", ["bash", "-l"])
    environment = dict(os.environ)
    environment.update(provider_environment(config))
    command = claude_command(config)
    executable = command[0]
    if config.get('platform') != 'windows' and not os.path.isfile(executable):
        print("Claude Code is not installed on this node.", flush=True)
        return
    if config["kind"] == "login":
        return run_login(config, command if config.get('platform') == 'windows' else executable, environment)
    args = command + ["--dangerously-skip-permissions", "--settings", config["runtimeDir"] + "/settings.json",
            "--mcp-config", config["runtimeDir"] + "/mcp.json"]
    if config.get("workspaceMode") == "mcp-only":
        # Built-in commands such as /clear must keep working; --disable-slash-commands removes them too.
        args += ["--tools", "", "--strict-mcp-config", "--setting-sources", ""]
    transcript = config.get("transcriptPath")
    resume_id = config["sessionId"]
    try:
        resume_id = str(uuid.UUID(load(pathlib.Path(config["runtimeDir"]) / "resume.json")["sessionId"]))
    except (OSError, ValueError, KeyError):
        pass
    projects = pathlib.Path(os.environ.get('CLAUDE_CONFIG_DIR') or pathlib.Path.home() / '.claude') / 'projects'
    saved = list(projects.glob("*/" + resume_id + ".jsonl"))
    if saved:
        args += ["--resume", resume_id]
    elif transcript:
        args += ["--resume", transcript, "--fork-session"]
    else:
        args += ["--session-id", config["sessionId"]]
    if config.get("workspaceId"):
        if config.get("workspaceMode") == "mcp-only":
            context = ("This is a HappyPanda local MCP workspace. The project exists ONLY on the user's computer at " +
                       str(config.get("localPath", "the configured local workspace")) + ". Local platform: " +
                       str(config.get("localPlatform", "unknown")) + ". Use workspace_id " + config["workspaceId"] +
                       " explicitly for EVERY happypanda_local tool call. There is no remote project mirror. "
                       "Use local_list_files, local_read_file and local_write_file for project files, and local_exec "
                       "for all searches, Git operations, builds, tests and development servers. Commands run on the user's "
                       "computer, not this server. Use powershell/pwsh on win32 and bash/sh on Linux/macOS. "
                       "Before editing, read project instructions such as AGENTS.md, CLAUDE.md, .claude/CLAUDE.md and "
                       "project memory through MCP when present; nothing is copied automatically. "
                       "local_write_file uses expected_hash from local_read_file; null creates a new file only. "
                       "Use a unique op_id for each new command and reuse it only when retrying that same command. "
                       "Poll local_job_status and local_job_output until the command finishes; do not rerun it when a request times out. "
                       "If local MCP is unavailable, stop and report the connection problem. Do not use a server-side fallback. "
                       "Do not clean up apparent modifications, stage, commit, reset, checkout branches or push unless requested.")
        else:
            context = (("Project commands run on this native Windows server by default. Use Windows paths and native Windows tools. The mirrored project root is " if config.get('platform') == 'windows' else "Project commands run on this Linux VPS by default. The mirrored project root is ") + root +
                   ". HappyPanda local MCP tools operate on workspace_id " + config["workspaceId"] +
                   " and the user's computer only when enabled. Use explicit local tools only for requested local operations. " +
                   ("Do not assume Linux or WSL is available. " if config.get('platform') == 'windows' else "Do not assume Windows command syntax works on this VPS. ") +
                   "Working files synchronize in both directions. Git metadata is not file-synchronized; "
                   "HappyPanda separately fetches remote commits and fast-forwards the local baseline when safe, preserving unrelated staging and working files. "
                   "The remote workspace branch is a baseline, not the local branch name. "
                   "Git operations that change working files also affect the mirrored local files. "
                   "Do not clean up apparent modifications, stage, commit, reset, checkout branches or push unless the user requested that Git action.")
        args += ["--append-system-prompt", context]
    model = (config.get("provider") or {}).get("env", {}).get("ANTHROPIC_MODEL")
    if model:
        args += ["--model", model]
    if config.get('platform') == 'windows':
        return windows_wait(args, environment)
    os.execve(executable, args, environment)

def wait_for_workspace(config):
    if config.get("workspaceMode") == "mcp-only" or not config.get("waitForWorkspace") or config["kind"] == "login":
        return
    path = config.get("workspaceStatePath")
    if not path:
        raise ValueError("Workspace readiness path is missing")
    announced = False
    while True:
        try:
            state = load(path)
            if state.get("ready") is True and state.get("remotePath") == config["remotePath"]:
                if announced:
                    print("\r\n[HappyPanda] Workspace is ready. Starting session...\r\n", flush=True)
                return
        except (OSError, ValueError):
            pass
        if not announced:
            print("\r\n[HappyPanda] SSH connected. Waiting for the first workspace synchronization.\r\n"
                  "Check synchronization progress in the sidebar. Claude starts automatically when the project is ready.\r\n", flush=True)
            announced = True
        time.sleep(1)

def mark_workspace_ready(config):
    if not config.get("workspaceStatePath") or not config.get("workspaceId"):
        raise ValueError("Workspace readiness path is missing")
    private_json(pathlib.Path(config["workspaceStatePath"]), {"ready": True, "remotePath": config["remotePath"]})

def ensure_session(config, config_path):
    name = config["tmuxName"]
    pane = name + ":0.0"
    exists = tmux("has-session", "-t", "=" + name, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    command = ["python3", config["helperPath"], "run", config_path]
    applied_path = pathlib.Path(config["runtimeDir"]) / "applied-provider.json"
    desired = {"provider": (config.get("provider") or {}).get("fingerprint", "official"),
               "reload": config.get("reloadToken"), "nodeEgress": bool(config.get("nodeEgress")),
               "workspaceMode": config.get("workspaceMode", "sync")}
    if config["kind"] == "claude":
        desired.update(permissionMode="bypassPermissions", sandbox=False)
        if desired["workspaceMode"] == "mcp-only":
            # Restarts panes launched with --disable-slash-commands once; the conversation resumes.
            desired["slashCommands"] = True
    try:
        applied = load(applied_path)
    except (OSError, ValueError):
        applied = {"provider": "official", "reload": None}
    applied.setdefault("nodeEgress", False)
    applied.setdefault("workspaceMode", "sync")
    if not exists:
        # Set remain-on-exit before Claude can exit, including login failures.
        tmux("new-session", "-d", "-s", name, "-c", config["remotePath"], "sleep", "86400", check=True)
        tmux("set-option", "-t", name, "remain-on-exit", "on", check=True)
        tmux("respawn-pane", "-k", "-t", pane, "-c", config["remotePath"], *command, check=True)
    else:
        dead = tmux("display-message", "-p", "-t", pane, "#{pane_dead}", capture_output=True, text=True)
        changed = (config["kind"] == "claude" and applied != desired) or applied["workspaceMode"] != desired["workspaceMode"]
        if changed and dead.stdout.strip() != "1":
            result = tmux("display-message", "-p", "-t", pane, "#{pane_pid}", capture_output=True, text=True, check=True)
            pid = int(result.stdout.strip())
            if pid <= 1:
                raise ValueError("Invalid Claude process")
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            for _ in range(25):
                if tmux("display-message", "-p", "-t", pane, "#{pane_dead}", capture_output=True, text=True).stdout.strip() == "1":
                    break
                time.sleep(0.2)
        if changed or dead.stdout.strip() == "1":
            tmux("respawn-pane", "-k", "-t", pane, "-c", config["remotePath"], *command, check=True)
    private_json(applied_path, desired)

def launch(config_path):
    config = load(config_path)
    if config.get('platform') == 'windows':
        return subprocess.call([config['nodeExecutable'], config['windowsAgent'], 'attach', config_path])
    import fcntl
    name = config["tmuxName"]
    with open(pathlib.Path(config["runtimeDir"]) / "launch.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        ensure_session(config, config_path)
    tmux("set-option", "-t", name, "status", "off", check=True)
    pidfile = pathlib.Path(config["runtimeDir"]) / "monitor.pid"
    monitor_running = False
    if pidfile.exists():
        try:
            pid = int(pidfile.read_text())
            os.kill(pid, 0)
            cmdline = pathlib.Path("/proc") / str(pid) / "cmdline"
            arguments = cmdline.read_bytes().decode(errors="replace").split("\0")
            monitor_running = len(arguments) > 2 and arguments[1] == config["helperPath"] and arguments[2] == "monitor"
            versionfile = pathlib.Path(config["runtimeDir"]) / "monitor.version"
            current_version = hashlib.sha256(pathlib.Path(config["helperPath"]).read_bytes()).hexdigest()
            if monitor_running and (not versionfile.exists() or versionfile.read_text() != current_version):
                os.kill(pid, 15)
                monitor_running = False
        except (ValueError, OSError):
            pass
    if not monitor_running:
        child = subprocess.Popen(["python3", config["helperPath"], "monitor", config_path],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
        pidfile.write_text(str(child.pid))
        (pathlib.Path(config["runtimeDir"]) / "monitor.version").write_text(hashlib.sha256(pathlib.Path(config["helperPath"]).read_bytes()).hexdigest())
    print("\033]777;happypanda-ready\007", end="", flush=True)
    os.execvp("tmux", ["tmux", "-L", "happypanda", "attach-session", "-t", name])

if __name__ == "__main__":
    mode = sys.argv[1]
    config = load(sys.argv[2])
    if mode == "hook":
        record_hook(config)
    elif mode == "monitor":
        monitor(sys.argv[2])
    elif mode == "run":
        sys.exit(run_cli(config) or 0)
    elif mode == "launch":
        sys.exit(launch(sys.argv[2]) or 0)
    elif mode == 'stop':
        if config.get('platform') == 'windows':
            sys.exit(subprocess.call([config['nodeExecutable'], config['windowsAgent'], 'stop', sys.argv[2]]))
        tmux('kill-session', '-t', config['tmuxName'])
    elif mode == 'windows-daemon':
        if config.get('platform') != 'windows':
            raise ValueError('Native Windows daemon requested on another platform')
        log = open(pathlib.Path(config['runtimeDir']) / 'windows-agent.log', 'ab')
        try:
            child = subprocess.Popen([config['nodeExecutable'], config['windowsAgent'], 'daemon', sys.argv[2]],
                cwd=config['runtimeDir'], stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True,
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | 0x01000000)
            print(child.pid)
        finally:
            log.close()
    elif mode == "metrics":
        print(json.dumps(metrics(config, {})))
    elif mode == "workspace-ready":
        mark_workspace_ready(config)
    elif mode == "browser":
        try:
            open_login_browser(config, sys.argv[3])
        except Exception:
            print("HappyPanda login browser is unavailable. Restart login in the desktop app.", file=sys.stderr)
            sys.exit(1)
