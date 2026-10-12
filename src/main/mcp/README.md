# Local MCP Integration

Import `LocalMcpBridge` from `./mcp`. The owner supplies the random Bearer
token, vault persistence, appData `dataDir`, dynamic workspace resolver, SSH
reverse tunnel and remote MCP configuration. This module creates no SSH
processes and never writes credentials. Keep `dataDir` outside all workspaces.

`start()` returns the local IPv4 loopback port and `/mcp` URL. Every HTTP
request requires the exact `Authorization: Bearer <token>` header. MCP
initialize/tools/list remain available when local access is disabled.
All seven local tools require the resolved workspace's `localAccess === true`.
Omitted `workspace_id` uses the optional `defaultWorkspaceId()` at call time.
`POST /events` accepts JSON objects up to 256 KiB, calls `onRemoteEvent`, and
does not require workspace access. It does not persist payloads itself.

`local_exec` accepts `workspace_id`, `relativecwd` (default `.`), `command`,
`shell`, `profile`, `op_id` and `timeout_ms` (default 60000; maximum 86400000).
Windows shells are `powershell` and `pwsh`; Unix shells are `bash` and `sh`.
`profile` is `no-profile` (default) or `default`. Commands and inherited local
environment variables are not rewritten. Noninteractive child processes and
taskkill all use `windowsHide: true`. The returned exit code is the shell's
actual exit code: PowerShell callers that need a native child's exact code
must explicitly include `exit $LASTEXITCODE` in their own command.

Jobs are shared across MCP sessions. `op_id` is global to this appData journal;
the same normalized request reuses its job, while a different command,
workspace, cwd, shell, profile or timeout is rejected. Completed retries
return the original receipt. An interrupted requested/running receipt becomes
`unknown` on restart and never launches again. A dropped HTTP connection or
MCP request cancellation does not cancel or replay the OS process; use
`local_job_cancel` and then poll for its final status.

`completed` means the process exited. A nonzero exit or failed synchronization
sets MCP `isError`; synchronization errors remain visible in structured
`error`. No final receipt is exposed until afterOperation and journal writing
finish. File writes whose afterOperation fails return `operation_completed`
and the applied write receipt inside the structured error.

Each stream keeps its last 256 KiB; output tools use independent byte cursors
and report dropped prefixes. Journals retain commands and bounded output,
are written atomically with mode 0600, and stay under `dataDir/mcp-jobs`.
POSIX mode 0600 applies on Unix; Windows access control depends on appData ACLs.
Activity events contain fixed tool/state labels and job/workspace IDs only.

Cancellation uses Windows taskkill /T /F or Unix process-group TERM/KILL.
Detached descendants and privilege boundaries are explicit result limitations.
`stop()` closes SDK transports and HTTP sockets and requests job cancellation.
Unconfirmed termination or unfinished synchronization becomes `unknown`.
The bridge does not use Windows Job Objects or adopt old PIDs after restart.

File tools restrict canonical paths and symlink traversal to the workspace,
reject absolute paths and `..`, and replace files through a same-directory
temporary file. `expected_hash` is the SHA-256 from read_file; null means
create only. Bridge writes are serialized per workspace, but a separate OS
process changing the path/file after the last check is not an OS transaction.
