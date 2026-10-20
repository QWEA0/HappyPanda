# Workspace Synchronization

Import `WorkspaceSync` from `src/main/sync/index.ts`. The required constructor
accepts `dataDir`, `onState`, `runRemote`, and optional `onActivity`. Main can
provide `mutagenPath` for packaged CLI/agent resources. No dependency or binary
installation is performed by the class.

The daemon uses only `<dataDir>/mutagen`. Sessions use two-way-safe with an
explicit ignore list and no global Mutagen configuration. Both directions
exclude Git internals, dependencies, virtual environments and caches. `dist`
and other deliverables remain eligible unless Git currently ignores them.
`git ls-files --others --ignored --exclude-standard --directory` supplies a
snapshot of ignored, untracked paths at connection/manual-sync time. Literal
path escaping avoids changing glob semantics, and tracked files remain eligible
even under ignore rules. A changed scope pauses the previous session and creates
a named replacement; it never resets or deletes session history or endpoint data.
Git initialization
and baseline/fetch operations belong to main's separate Git module. The
controller checks remote commits after readiness, periodically while files are
ready, after remote tool completion, and on manual synchronization. Incremental
bundles update a separate tracking ref; a fast-forward updates the current local
branch and only index entries changed by the commit, without rewriting files.
The original index is backed up. Divergence, active Git operations, busy indexes
and overlapping staging that does not match the commit remain pending for review.
`SyncState.git` reports these outcomes separately from file synchronization.

`ensure` reuses sessions only when their name, endpoint orientation, paths,
SSH settings, mode and exclusions match. Mismatches return an error state and
preserve the session. One WorkspaceSync manages one workspace. The desktop
creates one per workspace that has an open session, so several workspaces
synchronize at the same time; a workspace's session is paused only after its
last open tab closes. Within one instance, switching workspaces still pauses the
previous session.
`status` uses the official `sync list --template '{{ json . }}'` schema; scan,
write, connection and root-halt errors cannot become ready. `flush` returns the
observed state; main must require ready before starting dependent commands.
`waitUntilReady` observes polling without holding the CLI operation queue or
imposing a two-minute scan deadline, and accepts cancellation and session-name
scoping. SSH attaches before synchronization. A per-workspace readiness marker
keeps new remote Claude/Shell processes waiting until the initial successful
cycle and Git bootstrap complete. Login sessions remain usable during scanning.
Disposal drains pending work, pauses the active session and stops only the
isolated daemon, preserving session definitions.

Connections can use a user-configured system OpenSSH alias. Explicit user
and port use Mutagen's supported `[user@]host:[port:]path` syntax. An explicit
identity must resolve through system SSH configuration (`ssh -G`) unless
`prepareSsh` supplies a transport with `managesIdentity`. The desktop supplies
an SSH/SCP wrapper that applies IdentityFile overrides and password authentication
through system OpenSSH. It never reads private keys. Passwords remain encrypted
in the inventory; the askpass helper obtains them from a token-protected loopback
service without putting them in process arguments or environment variables.
Every CLI call uses the prepared executable directory, including the first list
that can launch the daemon. The desktop restarts only its isolated daemon before
first use of this transport so an older daemon cannot retain the previous
environment. Session definitions are preserved. `daemon stop` exits 1 with
"unable to connect to daemon" when no daemon is running; that case counts as
already stopped, both for this restart and at shutdown. Other stop failures are
reported. A custom prepared system binary
directory alone does not bypass the IdentityFile check. IPv6 endpoints require
an SSH alias. Host keys must already be trusted by system OpenSSH.

Remote roots are absolute POSIX paths or normalized Windows drive paths such as
`C:/Users/user/project`; native Windows nodes use the bundled agent for their
architecture. The app verifies and uploads that agent to its own user directory,
then launches it with native Windows arguments, avoiding locale-dependent shell
errors during agent discovery. The SSH wrapper also launches the absolute native
SFTP server path when the server PATH cannot resolve its configured subsystem.
Literal `$HOME/` and `~/` prefixes are
resolved remotely without interpolating user input in the shell. Remote path
checks and conflict verification require Python 3 on the node. CLI/SCP calls
use argv and do not use a local shell. Default SCP requires modern OpenSSH's
SFTP transport. Optional `uploadFile`/`downloadFile` callbacks can reuse main's
transport; both signatures are `(node, localPath, remotePath)`.

Conflict resolution requires a current, explicit conflict path strictly inside
both roots. It supports regular files and a preferred single-file deletion,
checks SHA-256 and detects changes during review/transfer. Directories and
symbolic links require manual review; no recursive conflict deletion occurs.
Failures after pausing keep the session paused. Incomplete conflict `.part`
files can remain remotely and are excluded from synchronization.

Install the official CLI and its adjacent `mutagen-agents.tar.gz` with
`node scripts/install-mutagen.mjs`. The installer selects Windows ZIP or
macOS/Linux tar.gz assets by architecture and verifies the published SHA-256
when supplied. It aborts on checksum mismatch or unavailable published sums;
if a release publishes no digest at all, its JSON result explicitly reports
`verified: false` and a warning.

## Performance behavior

- `MutagenCli` (`mutagen.ts`) is the shared daemon client. Pass it as `cli` to
  let several `WorkspaceSync` instances share binary discovery, the one-time
  transport restart and polling reads; the owner then calls `stopDaemon()`.
  Without `cli` an instance creates and owns its own client, as before.
- Background status polls from several workspaces share one `sync list` for up
  to 1.5 s. A shared result is discarded if any pause/resume/create/flush started
  or finished while it was in flight. Reads that follow a mutation never share.
- `ensure(workspace, node, { reuse: true })` reuses a session prepared earlier in
  the same run (up to `reuseMaxAgeMs`, default 10 minutes) after verifying it still
  exists and matches; it skips the remote setup call and Git ignore recomputation.
  Manual synchronization calls `ensure` without `reuse` and refreshes the scope.
- Status polling runs every 2 s while not ready or recently active, then every 10 s.
- Concurrent `flush()` callers that arrive before a flush starts share it.
- Set `HAPPYPANDA_PERF=1` to log durations of SSH, Mutagen and `ensure` calls.
