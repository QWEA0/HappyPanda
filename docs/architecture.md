# Architecture and Implementation Proposal

Research date: 2026-10-10. Status: approved and implemented as a Windows MVP.
See implementation.md and verification.md for current validation and limits.
Revised 2026-10-11: default execution moved to the VPS after the user clarified
that stable overseas inference and runtime routing is a primary objective.

## Product Contract

HappyPanda opens with saved service nodes. Selecting a configured node opens
the original remote Claude Code terminal in its remembered workspace/session.
A sidebar shows the server, workspace state, recent sessions, and tool events.
Connection setup, synchronization, execution routing, and recovery are system
responsibilities. Advanced infrastructure choices do not appear on the main
screen.

The client targets Windows, macOS, and Linux. Windows is the first development
and verification platform. Cross-platform packaging is an explicit validation
task, not something the Windows proof establishes.

## Recommended First Version

Use TypeScript, Electron, React, and Vite for the desktop client. Use the
system OpenSSH client to preserve existing IdentityFile, Include, ProxyJump,
and ProxyCommand behavior. Embed its PTY with node-pty and render the original
terminal with xterm.js. Use remote tmux for reconnectable foreground sessions.

Use a Mutagen-managed remote workspace mirror for native Claude file tools.
Default project commands to the VPS. Expose optional local command tools over
standard MCP HTTP through an authenticated SSH reverse tunnel. Native Bash
remains remote in this MVP; explicitly named local MCP tools provide optional
local operations. Exclusive local execution is a future profile, not the
current workspace switch. Local access is disabled by default.

    Local Electron client
      + xterm.js <-> node-pty <-> system SSH <-> tmux <-> Claude Code TUI
      + local workspace <-> Mutagen SSH sync <-> remote workspace mirror
      + local MCP executor <-> SSH reverse forwarding <-> Claude MCP client

This preserves native file tools and makes the default project runtime use the
VPS operating system, dependencies, and network. Optional local execution uses
the local operating system and environment instead. Claude itself, its
internal helper processes, and configured remote plugins still run on the VPS.
The product must describe the location of project commands precisely.
An overseas inference endpoint does not guarantee account availability or
change subscription allowances or API unit pricing. Browser authorization and
optional local commands have their own network paths. See operations.md.

Electron is preferred over Tauri for this version because PTY handling,
terminal rendering, MCP, and process orchestration fit one language ecosystem.
Tauri/Rust remains viable if installation size later justifies maintaining a
second language and additional terminal/IPC adapters. Wails/Go is another
viable shell, but offers less direct reuse of the selected Node terminal stack.

## Workspace Access Research

| Approach | Practical fit | Decision |
| --- | --- | --- |
| Reverse SSHFS/SFTP | A real remote mount, but requires a local SFTP endpoint and remote FUSE. Metadata-heavy operations cross the network; caching, watch behavior, and reconnects need care. | Optional later mode. |
| Mutagen | Windows/macOS/Linux support, system SSH transport, remote local-disk mirror, incremental bidirectional synchronization, conflict reporting and reconnects. | Recommended default. |
| Syncthing | Mature daemon and block synchronization; separate device configuration and weaker Windows symlink semantics. | Alternative, not the first integration. |
| rsync plus Git | Useful explicit transfer/execute/collect batches; no continuous bidirectional conflict management. Windows needs an appropriate rsync distribution. | Recovery or batch fallback. |
| Full local MCP workspace | Local file and process tools share one directory and need no mirror. Native workspace-dependent CLI features require separate adaptation. | Future optional mode. |

Mutagen sessions use two-way-safe after the initial local-to-empty-remote
bootstrap. Treat conflicts and scan/write failures as visible state, not as
successful synchronization. Integrate the official CLI as a supervised
subprocess rather than relying on its experimental embedded daemon API.
Isolate its data directory from other applications' Mutagen installations.

Each workspace has an opaque ID, a canonical local root, a generated remote
root under the ubuntu account, and one authoritative shell profile. Never map
two independent sessions to a remote directory merely by its display name.

Exclude .git internals, node_modules, virtual environments, and caches from
bidirectional file synchronization. Do not blindly reuse .gitignore: outputs
such as dist/ or build/ may be requested deliverables. Keep local dependencies
in place for local execution. A remote execution profile installs its own
platform-specific dependencies.

Git writes follow the workspace's selected execution host: remote by default,
local in local execution mode. Bootstrap a separate repository metadata
baseline from local commits and transfer subsequent commits through Git
transport. Do not synchronize lock files, indexes, refs, or credential-bearing
Git configuration bidirectionally. Use a single writer, pause synchronization
around branch changes, and check local concurrent edits before updating the
local baseline. Repositories with no commits and dirty worktrees need explicit
acceptance coverage. Only fast-forward the local baseline, preserving unrelated
staging and all working files. Back up the original index and report divergent
histories or overlapping staged edits for review; never force-reset local work.

Preflight checks cover case-only name collisions, symlinks outside the root,
Windows symlink capabilities, executable bits, and files that fail to transfer.
The supported mapping is workspace-relative; shell command strings are not
automatically converted between POSIX paths and Windows paths.

## Optional Local Command Routing

Run an official MCP TypeScript SDK HTTP server bound to local loopback. SSH
publishes it on remote loopback only. Authenticate every bridge session with
an unpredictable, expiring token, kept out of logs and repository files.
Existing SSH keys remain in the user's SSH configuration.

Register exec, job_status, job_output, and cancel_job tools. Include the
workspace ID, relative cwd, shell profile, command, timeout, session ID, and
operation ID in the application protocol. Results carry separate stdout and
stderr, the original exit code, cancellation state, and optional job ID.
These fields are a proposed HappyPanda API, not pre-existing Claude fields.

Every local command follows this sequence:

1. Resolve the workspace and canonical local working directory.
2. Request a synchronization cycle; inspect conflicts and endpoint errors.
3. Verify local hashes of files changed by the preceding Claude tool calls.
4. Execute with the selected local shell and environment profile.
5. Propagate file changes back and verify the affected artifacts.
6. Return the real command result and its workspace revision to Claude.

Mutagen flush alone is not a multi-file transaction. Record relevant content
hashes and mark results stale when concurrent edits change their inputs.
If synchronization is conflicted, disconnected, or incomplete, wait or return
an explicit error. Never silently execute against a known stale mirror.

Windows profiles distinguish PowerShell, Git Bash, and WSL; macOS/Linux
profiles select an available shell. Inform Claude of the selected execution
host and shell. Do not inherit the VPS PATH/HOME or pretend Linux Bash syntax
can be mechanically translated to PowerShell.

Track long-running jobs explicitly. Cancelling a remote wrapper does not
automatically terminate the local process tree. The implementation needs
platform-appropriate process-group or Windows Job Object handling, bounded
output, timeouts, and cancellation acknowledgements. Account for stdin, Ctrl+C,
and terminals separately from noninteractive MCP command calls.

## Hooks, Mods, and SDK Findings

PreToolUse.updatedInput can replace a Bash command with a fixed relay call;
the relay, not the hook, supplies remote execution. PostToolUse result
replacement happens after the original tool's side effects. Headless defer
does not provide the corresponding interactive TUI behavior.

The installed stable version is 2.1.287. The current hook documentation says
onFailure block handling requires 2.1.295 or later. Therefore hook-based Bash
rewriting is not the sole execution boundary for this installed version.
Use CLI tool restrictions and an explicitly configured MCP tool instead.

Current mods documentation provides tool.call middleware that can return a
replacement result without running the original tool. This is a promising
native-tool adapter, but build-specific result schemas, authorization,
startup failure behavior, and the target version must be verified before it
becomes the default. It is not assumed to work on the installed version.

Use ordinary external HTTP MCP with the original CLI. Agent SDK in-process
tools are useful for an application-owned conversation UI, but are not a
drop-in execution provider for the independent Claude terminal. SDK/CLI session
interchange is not a prerequisite or an established guarantee in this plan.

Keep any built-in non-Bash tools needed by the selected profile. Constrain
subagents to the same execution policy. Explicitly include Grep and Glob in
the synchronized profile: the current documented Linux/macOS/WSL default set
omits them, so merely removing Bash can otherwise remove practical search.
For example, an initial profile can specify Read,Write,Edit,Grep,Glob and load
the application MCP configuration with strict-mcp-config. Add further native
tools only after checking their workspace/execution behavior on the target
version. Native checkpoint/rewind, file mentions,
LSP, automatic project instructions, and worktree actions each need validation
against synchronized workspaces. Full MCP-only mode needs additional adapters.

## Reusable Components

| Area | Component | Integration |
| --- | --- | --- |
| Desktop | Electron + TypeScript | Main process owns processes, files and credentials; isolated renderer with typed IPC. |
| UI | React + Vite + lucide-react | Restrained node list, terminal layout, icon controls. |
| Terminal | node-pty + @xterm/xterm + fit/web-links addons | PTY, resize, Unicode, paste, copy, scrollback and terminal output. |
| SSH | System OpenSSH | Existing configuration and keys; ssh -G for effective settings. |
| Persistence | Validated JSON + atomic replacement | Small personal node/session inventory; no database requirement initially. |
| Secrets | Electron safeStorage where supported | Reference existing SSH keys; sensitive account setup remains on the selected node. |
| Synchronization | Mutagen official CLI | Managed daemon, isolated data directory, structured status and conflict handling. |
| Local tools | Official MCP TypeScript SDK + Zod | HTTP transport, tool schemas and structured process results. |
| Local search | ripgrep | Reuse a proven search engine; do not implement recursive project search by hand. |
| Remote sessions | tmux + Claude --resume | Recover terminal and logical session state; ownership is explicit. |
| Session sidebar | Claude hooks + MCP receipts | Structured prompt/tool/stop events; terminal escape sequences are not the event API. |

No license evaluation is part of this personal-software research.

## Implementation Order and Acceptance

1. Approved desktop layout, saved node import, real SSH PTY, terminal resize,
   copy/paste, disconnect and reconnect through tmux.
2. Workspace picker, remembered mapping, synchronization bootstrap, progress,
   conflict states and changed-file verification.
3. Local MCP executor, disabled remote Bash, command barriers, job lifecycle,
   structured sidebar events and Claude session restore.
4. Real authenticated Claude edit/test cycle, background jobs, local browser
   workflows, simultaneous edits, and packaging checks on all three platforms.

Acceptance must demonstrate that a remote Claude edit reaches the local file,
a local test runs against that exact edit, its real output reaches Claude, and
local generated artifacts become visible to the next remote tool call. Also
test SSH loss during a command, app restart, cancellation, conflicts, spaces
and CJK in paths, case/symlink differences, and two workspaces on one node.

The default VPS profile keeps native remote command tools; disabling remote
Bash applies to the optional local-execution profile. Reliability, account
login, pricing boundaries, and selective session migration are specified in
operations.md.

Claude authentication and model calls are not validated yet. Do not label a
transport probe, build, or screenshot as end-to-end Claude acceptance.

## Primary Sources

- [Claude setup](https://code.claude.com/docs/en/setup)
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude MCP integration](https://code.claude.com/docs/en/mcp)
- [Claude hooks](https://code.claude.com/docs/en/hooks)
- [Claude mods events](https://code.claude.com/docs/en/plugins/mods/events)
- [Claude subagents](https://code.claude.com/docs/en/sub-agents)
- [Mutagen synchronization](https://mutagen.io/documentation/synchronization/)
- [Mutagen daemon and embedding](https://mutagen.io/documentation/introduction/daemon/)
- [Mutagen ignores](https://mutagen.io/documentation/synchronization/ignores/)
- [Mutagen permissions](https://mutagen.io/documentation/synchronization/permissions/)
- [SSHFS](https://github.com/libfuse/sshfs)
- [Syncthing syncing](https://docs.syncthing.net/users/syncing.html)
- [rsync manual](https://rsync.samba.org/ftp/rsync/rsync.1.html)
- [node-pty](https://github.com/microsoft/node-pty)
- [xterm.js](https://github.com/xtermjs/xterm.js)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
