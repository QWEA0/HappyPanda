# HappyPanda MVP Implementation

This document describes the implemented MVP and the reported validation
snapshot on 2026-10-11. The complete fixture-based VPS regression has passed.
The validation entries below describe specific probes, not complete desktop
or model workflow acceptance.

## Architecture

The Electron renderer uses React and the original xterm.js terminal. Its
typed `window.happyPanda` API is exposed by the preload bridge. The main
process owns saved node/workspace/session records, SSH processes, node-pty,
Mutagen synchronization, the optional local MCP service, history transfer,
and port forwarding.

```text
Electron renderer / xterm
  -> typed preload IPC
  -> main process / node-pty / system SSH
  -> remote tmux / original Claude Code CLI

Local project <-> Mutagen <-> remote project mirror

Optional local MCP tools <-> SSH forwarding <-> remote CLI

Local browser -> local forwarded port -> remote preview port
```

Default project development and execution are remote. Enabling local MCP is
an explicit workspace choice. Claude itself and its account login remain on
the selected remote node. Local browser authorization has its own network
route; a remote CLI does not automatically move local browser traffic to the
VPS exit.

## Implemented desktop workflows

| Workflow | Implemented behavior |
| --- | --- |
| Saved nodes | The home screen lists stored SSH nodes. Add/edit/delete forms use the desktop API and discovered SSH configuration aliases. Optional user, port, and IdentityFile overrides are supported. |
| Connection | Selecting a node calls the connection API. Workspace selection and remembered workspace/session identities are available. Connection state and errors come from the main process. |
| CLI terminal | xterm displays raw SSH PTY output. Input, fit/resize, copy/paste, and web links are wired. Login opens an isolated node-routed browser; new Claude/Shell sessions and reconnect call the desktop API. |
| Session continuity | The main process attaches to remote tmux sessions. Recent-session selection and reconnect use actual session identities. |
| API providers | A shared local list stores named Anthropic-compatible endpoints and encrypted credentials. Each SSH node selects its own provider. Applying the selection reloads the current Claude session and resumes its saved transcript. Bearer Token and x-api-key authentication, an optional model, and the nonessential-traffic setting are supported. |
| Workspace synchronization | A local project maps to a remote mirror managed by bidirectional Mutagen synchronization. SSH attaches immediately while initial sync and Git preparation run in the background; new Claude/Shell processes wait for the first ready marker. Git's current ignored/untracked paths are excluded while tracked files remain eligible. The UI exposes synchronization status, sync/pause actions, conflict records, and explicit local/remote conflict resolution. |
| Server and activity | The sidebar displays measured server metrics, sampling times, recorded activity, and recent sessions. Missing metrics stay unavailable. |
| Local MCP | Disabled by default. The workspace gate takes effect immediately. Explicit workspace IDs prevent an old session from operating on a newly selected project. Stateless SDK HTTP and durable operation IDs support transport recovery. |
| Local directory | The workspace action opens its local directory through the desktop API. |
| Port previews | The port dialog calls the add/remove forwarding APIs. Server ports are forwarded to local loopback ports for browser previews. |
| History import | The import dialog lists local history, selects sessions, submits import requests, shows returned results/warnings, and calls the imported-session continuation API. |
| Project memory | The workspace action imports Markdown auto-memory from the local Claude project directory into the remote project's native memory directory. SHA-256 verifies every file. Identical files are skipped; different remote files are retained and reported. The memory index is published after topic files. |

The toolbar is compact, the terminal is the primary work surface, and the
272px sidebar can collapse into a drawer at narrow widths. Dialogs support
closing, Escape, and keyboard focus handling. API errors are visible.
Closing a dialog after submitting an operation does not cancel the already
issued API request.

Active preview forwards are reported in application state. The dialog follows
their current lifecycle, waits for the SSH listener to bind, and offers a
local browser action. Forward configurations are not persisted across exit.

The browser renderer at `http://127.0.0.1:5173` has no Electron IPC. It can
display the UI and the real configured initial node in a disconnected state.
Desktop-dependent operations return an explicit error. It does not simulate
SSH connections, server metrics, or Claude conversations.

## Terminal copy and clipboard image paste

Terminal selection copy uses the typed preload IPC and Electron's native
`clipboard.writeText` in the main process, with the same trusted-frame validation
as other application IPC. This avoids renderer clipboard focus requirements.
Ctrl+C copies when text is selected and sends the normal terminal interrupt when
there is no selection. Ctrl+Shift+C, Cmd+C and the existing toolbar/menu actions
also copy through this path. Copy remains available after disconnect and preserves
Unicode, whitespace and line endings.

After building, `npm run smoke:clipboard-copy` checks these paths against the real
system clipboard and built renderer without SSH or model requests, including a
native paste into a regular text field. It also checks empty selections, interrupts
and text paste, and restores the original clipboard unless the user has copied
new content during the check.

The terminal paste action handles Ctrl+V, Ctrl+Shift+V, Cmd+V, Shift+Insert,
native paste events and the existing toolbar/menu button. Electron 44's asynchronous
clipboard API supplies a snapshot of PNG or text content to the main process.
PNG bytes travel through SSH stdin to a session-specific attachment directory under
`~/.local/share/happypanda/attachments/`, outside every synchronized workspace.
Files are content-addressed, verified by SHA-256 and stored with mode 0600; duplicate
images are reused. Attachments remain available when a saved conversation is resumed.

Only after verification does the main process insert the quoted image path into
the original PTY, using the terminal's bracketed-paste mode. It adds no Enter key.
Node/session IDs, connection generation and PTY identity are checked around the
asynchronous operations, so failed transfers, reconnects and session switches cannot
paste into a different terminal. Text paste keeps xterm's line-ending behavior.
Current bounds are 20 MiB and 40 million pixels per PNG. Copying an image file in
Explorer is distinct from copying its pixels to the system clipboard.

`npm run smoke:clipboard` uses the built renderer, native Windows clipboard and an
isolated SSH shell to check image/text keyboard shortcuts, the paste button and
remote checksums without a model request. It restores the previous clipboard from
memory unless the user has copied something else during the check. The Python
attachment tests also cover corrupt files, session separation and symlink rejection.

## Provider configuration and reload

`providers.json` stores public metadata and OS-encrypted API credentials using
Electron `safeStorage`; plaintext storage is refused when encryption is
unavailable (including Linux's `basic_text` backend). IPC state excludes
credentials. An omitted key on edit retains its ciphertext. The home toolbar,
session menu, and sidebar provide management entry points. The sidebar has an
explicit Apply and reload action; edits alone do not restart an active session.
An in-use provider cannot be deleted until its nodes have selected another one.

Only Claude sessions receive the chosen provider. SSH transfers the configuration
over stdin to the private HappyPanda runtime directory, with mode 0600 files.
The process environment and session-scoped `--settings` environment agree, so
inherited tmux variables and lower-precedence Claude settings cannot retain an
old key, endpoint, cloud-provider switch, or model mapping. Managed organization
policy still has precedence. Shell profiles, project settings, and saved OAuth
credentials are preserved. These private remote runtime files necessarily
contain the key used by that session; local encryption does not encrypt a live
remote process's environment.

HappyPanda treats saved nodes and enabled local MCP workspaces as trusted.
Claude sessions start with `--dangerously-skip-permissions`, session settings
select `bypassPermissions`, and the Claude command sandbox is disabled. This
also avoids the auto-mode permission classifier. Login and shell sessions retain
their existing launch commands. The desktop local MCP access switch and SSH
host verification still apply.

Each runtime records the applied provider ID/revision, explicit reload token,
and Claude permission/sandbox configuration. Existing Claude processes migrate
to the trusted configuration once when next attached.
A changed selection gracefully terminates that pane's process, then respawns
the same tmux pane. A retry of the same configuration reattaches without another
restart. `SessionStart` records the actual Claude conversation ID, including
forked imports, so later restarts resume that saved conversation. Unsaved terminal
input and running work can be interrupted. Other detached sessions apply the
node's current choice when next attached. No model prompt is automatically sent.

The Apply action waits for the remote terminal readiness marker. A failed reload
leaves the selected configuration saved for a manual retry and reports an error.
The API status is "configured", not an assertion that the credential or model has
been successfully used. The isolated `smoke:providers` check passed on 2026-10-11
against real Linux/tmux with a synthetic CLI, including process replacement,
same-session resume, normal reconnect, private file permissions, absence of keys
in process arguments, and resetting to official mode. Real provider inference
and paid usage remain unverified.

## Runtime and packaging

Use Node.js 22.12 or newer, system OpenSSH, working SSH authentication, and a
trusted server host key. The remote node needs Python 3, tmux, the Claude
Code CLI, and SSH forwarding support.

```powershell
npm ci
npm run install:sync
npm run dev
npm run build
npm run pack
```

`scripts/desktop.mjs` clears `ELECTRON_RUN_AS_NODE` in the child environment
and invokes the Electron binary installer when the installation marker is
missing, then starts electron-vite. This prevents an inherited Node-mode
environment from selecting the wrong Electron runtime for development.

`npm run install:sync` installs the Mutagen CLI and agent archive in
`.local/tools`. Packaging includes the configured Mutagen resources as well
as the remote helper resources. Install the synchronization tools before
building the distribution.

The MVP uses the node-pty N-API prebuilt binary. electron-builder has
`npmRebuild: false`, and the native node-pty files are unpacked from the app
archive. Windows development PTY operation has been demonstrated with this
configuration.

Windows x64 has successfully produced:

```text
release/win-unpacked/HappyPanda.exe
```

This proves the unpacked build artifact was produced. Full automated
acceptance of the packaged GUI has not been completed. The source has
cross-platform paths and packaging targets, but macOS and Linux have not
been validated on real machines.

## Account and execution boundaries

The latest reported VPS snapshot has Claude Code CLI `2.1.287` installed,
with account login still incomplete. There has been no verified real model
generation, paid model request, or authenticated end-to-end Claude editing
workflow.

Use "通过当前服务器登录" for the official account/subscription flow. It prepares
a dedicated SSH SOCKS5 tunnel and launches installed Chrome/Edge with a separate
profile per node. Official authorization links are intercepted and never fall
back to the default browser. Only the installed CLI's browser hook opens a page
automatically; the terminal fallback URL can still be clicked manually. The CLI
emits different localhost and web-code callback URLs for the same OAuth state;
automatically opening both raced the authorization flow. The controller now
accepts a single automatic URL per login attempt. An isolated probe of CLI 2.1.287 verified its
actual `https://claude.com/cai/oauth/authorize` URL and browser hook on 2026-10-11;
legacy official authorization URLs are also accepted. No account login was
completed during that probe.

Before an authorization URL reaches the browser, the browser must navigate a
one-time probe through its SOCKS proxy to a dynamically allocated loopback port
on the VPS, then through a reverse SSH forward to the local verifier. Only that
successful request causes a redirect to the allowlisted OAuth URL. SSH readiness
alone is not reported as verified browser routing. No OAuth URL appears in the
browser process arguments, activity log, or verification state. Login completion
is scoped to the current node, session and attempt, requires verified routing
and official CLI authentication, and reloads the previous Claude conversation.

Chrome uses remote DNS for SOCKS5 without a global host-resolver failure rule.
Its implicit loopback proxy bypass is removed
so dynamic OAuth localhost callbacks reach the CLI on the VPS. The launch flags
disable QUIC and non-proxied WebRTC UDP. A stable, dedicated local proxy gate
remains bound and rejects traffic when SSH stops; active sockets are destroyed
and there is no DIRECT proxy fallback. Its port is allocated by the OS on first
use and recorded per node; a reused port is never silently moved if occupied.
This avoids selecting unavailable Windows port ranges by hash. Node switches and app shutdown block the
route. Browser profiles are not copied from the user's normal browser. The
profile is reused for that node, and the application's browser process is closed
on shutdown. Once enabled on a node, official CLI sessions clear inherited proxy
variables in both their process environment and session settings to use node
egress. Third-party provider sessions retain their existing network settings.

After the browser route probe, an isolated Chromium HTTP session checks the
public authorization page and the actual entry script through the same proxy.
It omits cookies and never uses the user's OAuth query. HTTP errors, explicit
site verification challenges and timeouts are reported separately from tunnel
readiness. This check does not establish browser rendering or complete a site
challenge. Pending authorization has a reminder after 90 seconds and can be
restarted; starting a new attempt closes the old application-owned login window.

This is routing isolation, not a remote operating system or device-identity
emulation. It does not promise undetectability or avoidance of account
restrictions. Managed browser/CLI policy and the actual identity provider still
need to be respected. Existing local credentials are not moved to the VPS;
the remote native CLI owns its OAuth credentials. Real OAuth consent, SSO and
authenticated model calls have not been exercised. The automated SSH smoke test
uses synthetic browser requests, while browser fixture checks cover status UI.

Local MCP is off by default. Its file tools enforce the workspace root.
Shell execution uses the local user's operating-system permissions, with
the workspace as its command context; it is not an OS sandbox and can access
resources allowed to that user.

Windows local command execution uses PowerShell/pwsh. Git Bash and WSL
integration have not been adapted. Unix local command execution uses
bash/sh. Local tool availability and remote execution are distinct from
the network route of an account authorization browser.

## History migration

Auto-memory is imported separately from JSONL transcripts. The importer uses
the local Git common directory to identify the shared repository memory when
working in a linked worktree. It supports the default Claude projects memory
layout (and the project-directory environment override), copies only Markdown,
rejects escaping paths/symlinks, and sends contents over SSH stdin. Each file is
staged privately and published without overwriting an existing destination.
No credentials, browser state, or global Claude settings are part of the import.
Active conversations can reread MEMORY.md; new conversations load its index.

A 2026-10-11 project import transferred its Markdown memory files
into its remote native memory directory with no conflicts. In the same audit,
local and remote HEADs matched. The local tree showed 8 changes while the remote
showed 581. Applying the local `core.filemode=false` and `core.autocrlf=true`
comparison rules reduced the remote result to the identical 8-item list without
changing files, refs or the index. A later live comparison showed identical
10-item lists as work continued. Bootstrap now aligns filemode/autocrlf/eol for
both new and existing mirrors. The remote `workspace` branch remains independent
of the local branch; staging and branch switches remain separate. Remote commits
are now checked automatically once files are ready and transferred in incremental
bundles. A fast-forward advances the current local branch and its committed index
entries, preserving unrelated staging and working files. The original index is
backed up; divergent histories or overlapping staged edits remain pending for
review. Git failures have their own state and cannot appear as fully synchronized.

The UI selects local session records and imports JSONL transcripts together
with their subagent records. It returns remote paths for continuation in the
remote CLI. Original local session files are not modified or removed, and
OAuth/account credentials are not copied.

Transfer behavior:

1. Calculate checksums for the selected records and transfer the required
   files to the remote import location.
2. Skip an already complete destination file when its checksum matches.
3. Upload pending content to a `.part` file, verify the complete content,
   and atomically replace the final file after verification.
4. Retry an interrupted `.part` transfer by uploading the entire file again.

This is checksum-based complete-file skipping and whole-file retry. It does
not resume a transfer from a byte offset. Session continuation through the
CLI is a separate operation from transfer retry.

Migration is limited to JSONL and subagent records. Attachment references,
rewind/checkpoint state, runtime state, dependencies, plugins, and the rest
of the original execution environment are not completely migrated. Imported
history is not a full environment backup.

## Terminal text rendering

A double-text rendering defect came from this renderer override:

```css
.terminal-host .xterm .xterm-accessibility {
  color: #e5e7eb;
}
```

The override made xterm's screen-reader text visible above its normal
terminal rendering, producing two overlapping text layers. It has been
removed so the official transparent accessibility layer is preserved.
Accessibility support remains enabled.

The default terminal font size is 14px. A global grayscale font-smoothing
override is no longer forced. Font readability and packaged GUI behavior
remain part of desktop visual acceptance.

## Validation scope

| Area | Recorded evidence or remaining boundary |
| --- | --- |
| Local to remote sync | A real VPS probe verified local file content reaching the remote mirror. |
| Remote to local sync | A real VPS probe verified remote changes reaching the local project. |
| Local MCP read/exec | Real reads and execution were exercised, including real stdout, exit status, operation IDs, and duplicate-operation handling. |
| Reconnect | A real VPS probe reconnected to the same session identity. |
| Fixture history | Fixture JSONL copying, SHA verification, atomic completion, and skipping a complete matching file were exercised. These fixtures are not model-generated conversation evidence. |
| Windows development PTY | The node-pty prebuilt worked in the development Windows runtime. |
| Windows x64 packaging | The unpacked HappyPanda executable was successfully built. Full packaged GUI automated acceptance remains incomplete. |
| Account and model use | CLI 2.1.287 is installed; account login and real model generation are not verified. |
| Node login routing | Real SSH SOCKS/reverse-forward probes passed, including remote localhost routing, disconnect blocking and stale authorization rejection. Browser state UI was checked with fixtures. An isolated native CLI probe confirmed the browser hook and current authorization URL; real browser OAuth consent remains unverified. |
| Full remote regression | Passed against the real VPS: both sync directions, local MCP reads/commands/output/deduplication, preview tunneling, original CLI rendering, same-session recovery, and fixture-history transfer/hash skipping. |
| Other operating systems | Source support exists; macOS/Linux real-machine validation is pending. |

Run the checks from the project root:

```powershell
npm run typecheck
npm run test
npm run smoke:remote
npm run smoke:login
python tests/provider_runtime_test.py
```

Unit coverage includes inventory and SSH handling, synchronization state and
CLI/install behavior, MCP path boundaries and operation/process lifecycle,
history metadata and transfer handling, and connection lifecycle behavior.
Use the actual test output for current results and counts; this document
does not freeze a passing test count.

An incident in a large workspace on 2026-10-11 exposed two coupled issues: a
large ignored directory remained in the synchronization scope, and session
attachment waited on a 120-second Mutagen flush before opening SSH. A timeout
therefore looked like a disconnected server while both sync endpoints were still connected.
The new initial-preparation path waits asynchronously for a completed sync cycle,
keeps sync failures separate from SSH status, and cancels obsolete preparation
when another session is selected. Selecting a session without a workspace now
uses that session's own scope instead of the node's last selected workspace.
The scoped inventory excludes the ignored data directory; the original broad
session was preserved in a paused state.

The affected workspace was recovered: all eligible files synchronized,
the partial Git baseline upload was prefix-verified and completed with a full
SHA-256 match, and the remote HEAD matched the local baseline. The original
session connected with workspace readiness, displayed Claude terminal output,
and reconnected to the same session. No model
prompt was sent. Detailed evidence remains in ignored local diagnostic files;
personal project and session identifiers are omitted from this document.

The subsequent two-file synchronization conflict came from divergent untracked
adapter files after an ignore-list change created a fresh session with no shared
ancestor. Both versions were backed up, the local additions were reviewed and
retained, and SHA-256 verification confirmed identical local/remote files.
Ignored directories now use stable child masks and literal tracked-file exceptions;
new ignored reports and caches do not replace their synchronization session.
Actual scope changes drain the existing managed session first, and conflicts or
errors defer replacement. Generated rules use an external configuration file to
avoid Windows command-line length limits. Real Mutagen regression coverage checks
tracked-file preservation, new ignored outputs, pending edits before replacement,
and concurrent edits that must keep the old session and conflict intact.

`smoke:remote` requires an SSH destination argument or `HAPPYPANDA_SMOKE_NODE`.
For example, use `npm run smoke:remote -- example-vps`, replacing the placeholder
with your configured SSH alias. It creates fixture workspaces and remote
synchronization/tmux sessions, performs real
operations, attempts cleanup, and records its result in
`.local/remote-smoke-result.json`. Individual recorded probes and a full
passing regression run are separate acceptance results.
