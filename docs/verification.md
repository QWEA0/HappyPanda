# Verification Evidence

Date: 2026-10-10, Asia/Shanghai.

Server identifiers and local paths below are illustrative. Personal usage
statistics and deployment-specific environment details are omitted.

## Local Checkout

- Workspace: project checkout (personal absolute path omitted).
- Node: v22.22.1. System OpenSSH is available.
- System OpenSSH authenticates using the configured SSH identity.

## Remote Node

- SSH alias: example-vps (placeholder).
- Connected with BatchMode=yes and StrictHostKeyChecking=yes.
- Platform: Linux x86_64.
- Required tools: tmux, Python 3, Git, and Claude Code CLI.
- SSH forwarding is required for the MCP bridge and preview tunnels.

## Claude Installation

Reviewed the official installer, then ran the stable native installation as
the SSH account, without sudo. It verifies the downloaded binary against the
published manifest checksum. Reported installation:

    2.1.287 (Claude Code)
    ~/.local/bin/claude

Verified --version and --help. The current noninteractive SSH PATH does not
include ~/.local/bin; use the absolute executable path in the client bootstrap.
No shell startup-file changes were made by HappyPanda during this turn.

Claude auth status:

    loggedIn: false
    authMethod: none
    apiProvider: firstParty

The account has not been authenticated and no model request was made.

## Actual Local Execution Probe

Command:

    node research/verify-local-execution.mjs example-vps

Path tested:

    remote Python -> remote loopback HTTP -> SSH reverse forwarding
      -> local authenticated loopback handler -> local Node process
      -> real stdout/stderr/exit code -> remote Python -> assertion

Observed result (SSH destination and working directory replaced with placeholders):

    ok: true
    sshDestination: example-vps
    transport: SSH reverse forwarding
    authenticationCheck: unauthorized request rejected
    platform: win32
    cwd: <project checkout>
    node: v22.22.1
    stdout: JSON with the local platform/cwd/Node version
    stderr: empty
    exitCode: 0
    executor: local

The temporary tunnel, listeners and child processes were closed when the
script finished. The test does not install a remote bridge or expose a public
local port. Its random token is passed through SSH stdin and not stored/logged.

## Evidence Boundaries

Passed: real SSH authentication, native CLI installation/version/help,
forwarding capability, remote-to-local transport, authentication rejection,
real local process output and cleanup on the successful path.

Not yet tested: desktop UI, PTY/TUI rendering, Mutagen synchronization, MCP
initialize/tool execution inside Claude, authenticated Claude edit/test cycle,
command cancellation/streaming, conflicts, checkpoint semantics, or macOS/Linux
desktop packages. Transport success is not Claude end-to-end success.

## 2026-10-11 Follow-Up

The remote CLI remains unauthenticated. Its installed login help confirms
subscription --claudeai and separate Console --console flows. Remote selected
proxy/API base URL environment and settings overrides were absent.

SSH application echoes and unauthenticated API reachability probes completed.
These establish transport/service reachability, not authenticated inference
performance. Unanswered ICMP probes cannot establish TCP packet loss.

Local history inspection confirmed that transcript-writer and installed CLI
versions can differ. Verify compatibility before resuming imported history.
No authentication, transcript migration, credential transfer, model call,
fault-injection test, or UI implementation was performed.


## Implemented MVP Acceptance, 2026-10-11

The TypeScript/Electron desktop, typed isolated preload, original SSH PTY,
remote tmux helper, Mutagen synchronization, local MCP service, selective
history archive, preview forwarding, and live sidebar are implemented.

Latest checks: 73 tests passed, TypeScript check passed, production build and
Windows x64 unpacked packaging passed. The app is running in development at
http://127.0.0.1:5173/ with its actual Electron window. The browser URL provides
renderer preview only; desktop operations require Electron IPC.

The complete real-server fixture regression passed on 2026-10-11.
It demonstrated both file-transfer directions, remote access to
local MCP read/exec tools, real local stdout/exit status, operation-ID
deduplication, a usable forwarded TCP port, the original CLI text, same-session
reconnect, real server metrics, and exact fixture-history/hash-skipping behavior.
The recorded account state was unauthenticated. No model request was made.

The terminal clarity defect was a foreground-color override on xterm's
accessibility layer. It made duplicate text visible above the renderer. The
override is removed, accessibility remains enabled, and the default terminal
font is 14px. A browser regression fixture verified one transparent accessibility
layer, no horizontal overflow, and legible normal/bold sample text. Its image is
stored locally under .local/screenshots/terminal-clear.png.

MCP uses official SDK stateless HTTP by default; job journals and stable
client/node reverse endpoints are independent of transport sessions. A test
confirmed an authenticated request can continue after a bridge restart with an
obsolete transport-session header. Explicit workspace IDs prevent implicit
operations in a newly selected project. Windows local UTF-8 output was sampled.

Remaining boundaries: native-account login and real model editing/generation,
full automated packaged-GUI acceptance, macOS/Linux real-machine validation,
bandwidth/packet-loss fault injection, attachment/checkpoint/runtime restoration,
and byte-level history upload continuation are not established by these checks.
Only synthetic history fixtures were uploaded; original user history and
credentials were preserved. The native desktop-control channel was unavailable,
so browser renderer tests and backend network probes were kept distinct from
automated desktop interaction.
