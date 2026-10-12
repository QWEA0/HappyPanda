# Network, Authentication, and Session Migration

Date: 2026-10-11. This document combines the initial research snapshot with
implementation requirements. The core desktop, recovery, MCP, and selective
history transfer are now implemented; see implementation.md and verification.md.
No user account authentication or real user-history migration was performed.

## Objective and Routing Boundaries

The default profile centralizes Claude sessions and project commands on a
selected remote node to provide a consistent runtime and network path.
Local execution remains optional.

| Activity | Default network/runtime location |
| --- | --- |
| Claude process, inference, CLI updates | VPS, subject to effective process configuration. |
| Project commands and dependency downloads | VPS in the default profile. |
| Desktop UI and workspace files | Local computer. |
| Workspace transfer and terminal interaction | Local-to-VPS SSH. |
| OAuth browser authorization | The node-login action uses a dedicated browser through the selected node's SSH proxy; an ordinary browser uses its own network settings. |
| Optional local MCP commands | Local environment and local command network path. |

Remote shell proxy variables and ~/.claude/settings.json proxy/base-URL
overrides can affect routing. Check the effective configuration on the selected
node. An IP database report is not independent proof of physical server
location or the account holder's location.

A remote-node egress design does not guarantee that every activity or identity
signal uses the same route. Confirm effective routing with a real
authenticated Claude process before claiming end-to-end inference behavior.
An IP address alone does not establish why an account was restricted or
guarantee protection from account enforcement. The provider's supported-region
rules also refer to user location and do not become different through a VPS.

## Cost Boundaries

A single person's saved projects and sessions can use their selected account
on the remote node. Moving that account does not increase plan allowances or
lower subscription/API unit pricing. Subscription allowances remain shared
across Claude and Claude Code; Console/API usage is a separate billing path.

The client can help avoid unnecessary repeat turns after disconnects, accidental
duplicate jobs, and accidental API-key billing instead of the selected
subscription. It must not advertise guaranteed cost savings or guaranteed
account survival. Node settings clearly distinguish subscription OAuth from
Console/API configuration. Do not copy local credential-bearing environment
variables when initializing a remote node.

## Network Probe Results

These short diagnostic probes establish reachability. Environment-specific
timings are omitted; the probes are not sustained throughput, packet-loss,
or model-stream benchmarks.

| Path | Observation | Limit |
| --- | --- | --- |
| Established local-to-VPS SSH echo | Application-level echoes completed. | Includes scheduling and SSH transport. |
| SSH startup to remote echo-ready | Authentication and remote Python startup completed. | Does not establish sustained connection performance. |
| VPS-to-api.anthropic.com root GET | Unauthenticated requests returned HTTP 404. | No inference or account test. |
| ICMP ping from local computer | Probes received no replies. | Cannot distinguish ICMP filtering from loss; not a TCP loss estimate. |

SSH latency and jitter favor remote local-disk workspaces over filesystem calls
that cross the link for every stat/read. Remote execution also avoids repeated
local command RPCs in the default remote-runtime profile.

## Weak-Network and Retry Policy

The implementation includes tmux restoration, synchronization state checks,
and durable local-job receipts. The following describes the intended recovery
policy; remaining fault-injection and platform checks are listed below.

| Layer | Recovery rule |
| --- | --- |
| SSH connection | Keepalive, bounded deadlines, and exponential backoff with jitter; proposed delay cap 30 seconds. |
| Terminal | Reattach the same tmux session. Do not resend keystrokes, prompts, or launch a second Claude process merely because the client disconnected. |
| Workspace | Resume the same Mutagen session; verify scan errors/conflicts and changed-file hashes before dependent tools proceed. |
| Read-only RPCs | Bounded retry when the operation is known to have no side effect. |
| App-managed command jobs | Reuse the original operation ID and query the persistent journal/job before attempting any recovery. |
| Native Claude Bash | Observe tool/session events; do not implement client-side command replay. An incomplete receipt is an unknown outcome, not permission to rerun. |
| Claude model/API turns | Leave protocol retries to Claude. Do not add a second outer layer that resubmits the user's prompt or automatically changes billing providers. |
| Authentication failure | Stop the affected workflow and request account recovery/login; reconnection does not fix authentication. |

Persist app-managed job identity and states: requested, running, completed,
cancelled, and outcome-unknown. Preserve output cursors and return an existing
result for the same completed operation ID. A crash between starting an OS
process and recording its state cannot be made exactly-once by an HTTP retry;
reconcile process identity and artifacts, or leave the outcome unknown.

The bridge uses the SDK's stateless HTTP mode by default. Durable operation
IDs remain independent of transport state. Its reverse endpoint is stable for
the client/node pair and its generated credential is persisted locally.
Reconnecting the SSH tunnel restores that endpoint. Authenticated requests
with obsolete transport-session headers do not trigger command replay.
Native authenticated-Claude recovery still requires separate account testing.

Separate interactive terminal/control traffic from bulk file transfers. Keep
connections alive rather than paying a new SSH handshake for each tool or
status poll. Batch file events, prioritize required source changes, use
incremental transfers, cap background sync bandwidth, and bound output
buffers. Terminal resize/output and sidebar events need throttling and
sequence-aware recovery; do not poll by spawning a fresh SSH command each time.

Do not declare a workspace ready from a successful flush alone. Block on
conflicts or transfer errors and verify the content version required by a
dependent command. Bind test results to that version and invalidate them if
files change concurrently. Preserve local edits made while offline.

For the default remote profile, losing the UI connection can leave remote
work running in tmux. For optional local mode, losing the reverse tunnel makes
local tools unavailable; do not silently fall back to executing on the VPS.

Before release, inject latency, jitter, bandwidth caps, disconnects during
uploads and command execution, and daemon/app crashes. Test that commands and
model turns are not duplicated, conflicts are visible, job cancellation reaches
the correct process tree, and the same session resumes. No fault-injection
test or sustained transfer benchmark has been completed yet.

## Official Account Login

For Pro/Max subscription usage, initiate the official login on the VPS:

    ssh -tt example-vps '~/.local/bin/claude auth login --claudeai'

Replace `example-vps` with your configured SSH alias.

The desktop's "通过当前服务器登录" action now opens this flow in a dedicated
Chrome/Edge profile through the node's SSH SOCKS tunnel. The browser's route
probe must succeed before the official authorization page opens. Complete any
account verification yourself; if a login code is shown, paste it in the current
remote terminal. Verify completion with:

    ~/.local/bin/claude auth status

Console/API usage is an explicit alternative, not a silent fallback. The
installed CLI also exposes auth login --console. Subscription mode must detect
conflicting API credentials/environment settings before using them.

The dedicated browser routes HTTP(S), remote DNS and localhost OAuth callbacks
through the node. A blocked SSH tunnel never falls back to the system browser or
a direct proxy entry. Its proxy gate remains listening and refuses traffic when
disconnected. The browser still runs on the local operating system. This does
not guarantee undetectability, account eligibility, or freedom from restrictions.
See implementation.md for the actual verification scope and remaining real OAuth
and SSO validation. Opening a URL manually in the ordinary browser still follows
that browser's own network settings.

The selected node's native Claude client manages its own login credentials.
Do not migrate local OAuth credentials, API keys, browser cookies, or keychain
data as part of history transfer. Account login is separate from conversation
history. No credentials were inspected or transferred during this research.

## Local Session Inventory and Migration

Local session records are stored under `~/.claude/projects` (on Windows,
`%USERPROFILE%\.claude\projects`). A read-only inventory covered project
directories, top-level and nested JSONL files, and aggregate size. Personal
paths, usage counts, and transcript contents are omitted from this document.

File counts do not establish the number of distinct resumable sessions. Only
a few record types/field names/version indicators were inspected; message
bodies were not reported. Local CLI, transcript writer, and remote CLI
versions can differ; verify compatibility against the versions that wrote
the selected transcripts before importing them.

Implement a selective importer rather than copying the entire ~/.claude tree:

1. Let the user select local projects and sessions; close or quiesce their
   active writers for a consistent export. Create a manifest with file hashes,
   sizes, session IDs, writer versions, and explicit local/remote root mappings.
2. Preserve original transcripts and UUID/parent links. Transfer selected
   transcripts, relevant subagent records, and required attachment dependencies
   into an app-owned remote archive with resumable, checksum-verified transfer.
3. Keep remote project/session indexes separate from credential/configuration
   files. Rebuild the desktop's search index from imported data; do not trust
   a copied Windows project-directory name as the Linux workspace mapping.
4. Start from the mapped remote workspace and test explicit transcript resume.
   Current official session docs support --resume with an absolute .jsonl path;
   confirm that behavior on the pinned target build. Use a forked session for
   the pilot so the archival source is preserved.
5. Provide the new workspace root, runtime/shell and tool configuration as
   current environment context. Do not replace path-like strings throughout
   historical messages, commands or source snippets. That would corrupt history.
6. Validate one short, one long, and one subagent-heavy session before enabling
   bulk import. Then import only the requested archive or active sessions.

History viewing, conversation resumption, and full runtime-state restoration
are distinct acceptance levels. Transfers can preserve conversation files
without proving that old checkpoints, Windows file snapshots, background
processes, old permissions, MCP endpoints, or expired temporary attachments
remain executable/recoverable on Linux. Expose unsupported records as viewable
archives instead of claiming complete restoration.

Never replay historical tool calls during import. A resumed turn may consume
fresh context allowance; copying transcripts does not transfer unused quota or
guarantee a cache hit. Importing the archive itself makes no model request.

## Primary Sources

- [Claude authentication](https://code.claude.com/docs/en/iam)
- [Subscription usage and API distinction](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan)
- [Supported countries and regions](https://www.anthropic.com/supported-countries)
- [Claude session storage and explicit resume](https://code.claude.com/docs/en/sessions)
- [Claude runtime and session behavior](https://code.claude.com/docs/en/how-claude-code-works)
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Mutagen synchronization](https://mutagen.io/documentation/synchronization/)
