# UI Proposal

Status: approved on 2026-10-11; the first desktop implementation is available.

## Appearance

A compact desktop work surface. Light neutral navigation and sidebar, a dark
charcoal terminal, restrained green status indicators, readable system type,
and one-pixel dividers. No landing page, hero, decorative cards, or separate
chat interface. Keep the original Claude terminal as the main interaction.

Suggested colors: chrome #F5F6F7, sidebar #FFFFFF, text #24272B,
dividers #E3E5E8, terminal #191B1E, active accent #16856B, warning #B77916.
Use fixed text sizes appropriate to the surface, zero letter spacing, and
lucide icons with tooltips. Keep rows/buttons stable while status changes.

## First Screen: Saved Nodes

A 48px toolbar with the app name and an add-node icon. Below it, a plain list
of saved nodes: display name, address, remembered workspace and last session.
Selecting a configured node connects directly and resumes its last session.

New installations start with an empty node list. An illustrative saved node is:

    Name: Example VPS
    SSH destination: example-vps
    Effective address: user@192.0.2.10:22
    Identity: existing SSH configuration

On its first workspace connection, show the native folder picker. Remember
the chosen folder. A node with no Claude authentication opens the actual CLI
setup flow in the terminal, keeping the same app layout.

The add-node sheet asks for a name and SSH destination, with discovered
configuration aliases available for selection. User/port/identity overrides
are in an advanced disclosure. No copied private key contents are requested.

## Connected Screen

    +---------------------------------------------------------------+
    | Back | Node / Workspace                 New session | Settings |
    +--------------------------------------------+------------------+
    |                                            | Server           |
    |                                            | Address, load,   |
    |          Original Claude Code TUI          | memory, uptime   |
    |                                            +------------------+
    |                                            | Workspace        |
    |                                            | Local path/state |
    |                                            +------------------+
    |                                            | Recent sessions  |
    |                                            +------------------+
    |                                            | Activity         |
    +--------------------------------------------+------------------+

The terminal takes the remaining space; the sidebar is 272px wide and
resizable/collapsible. The top bar is 48px high. At narrow desktop widths the
sidebar collapses into an accessible drawer rather than shrinking the terminal
until text overlaps. Sections are unframed regions separated by dividers.

Sidebar content:

- Server: address, current connection state, CPU/memory and last update.
- Workspace: selected folder and Ready/Syncing/Conflict/Disconnected state.
- Recent sessions: short title, last activity and resumable session identity.
- Activity: concise tool names, changed files, command location and outcomes.

The terminal remains the place to converse with Claude. Activity does not
duplicate every model token or depend on parsing ANSI cursor operations.

## Daily Flow and States

Select node -> remembered workspace -> restored CLI. For a new workspace,
select folder -> automatic preparation -> CLI. Infrastructure work is shown
as one compact status line with useful progress when available.

New session, folder selection, reconnect, sidebar toggle and settings use
standard icon controls with tooltips. Execution location is a workspace setting
with server execution as the default. The remembered local MCP switch permits
explicit local operations without changing where native Bash runs. Its access
gate takes effect immediately. Shell profiles are MCP tool arguments.

Disconnect preserves the remote tmux session. Reconnect restores its terminal
and reestablishes execution/synchronization services. A queued command stays
pending or returns an explicit unavailable result until the bridge is ready.

Conflicts show the affected file and a comparison/action view. They never
silently overwrite either side. Session sidebar information may lag terminal
output; show its actual state instead of fabricated summaries or metrics.

## Scope of Approval

The user approved this layout and VPS execution architecture on 2026-10-11.
The implementation retains optional local MCP tools and the original CLI.
The terminal accessibility text layer remains transparent; overriding its
foreground color previously caused the duplicate-text clarity defect.
