# Local History Import

Import `listLocalHistory` and `HistoryImporter` from
`src/main/history/index.ts`. Constructor options are `dataDir`, `runRemote`
and optional `uploadFile`, `configDir`, `prepareSsh`. The main callbacks are
`runRemote(node, command)` and `uploadFile(node, localPath, remotePath)`.

The default config directory is `CLAUDE_CONFIG_DIR` or `~/.claude`.
Inventory reads only `projects`: bounded saved session indexes and at most
256 KiB of each JSONL head plus 128 KiB of its tail. Directory enumeration is
streamed. It does not open credential/configuration files. The returned
project/session paths refer to actual local history paths, not remote roots
or stale paths stored in indexes. Only existing top-level session JSONL files
inside the real projects root can be selected. Agents are associated by the
session's subagents directory or a matching legacy agent session ID. Nested
discovery is limited to eight levels and 10,000 entries.

Import streams only the selection and associated subagents into app-owned
local snapshots, computing SHA-256 and scanning writer versions before upload.
Changing source files are rejected. Record parsing is bounded to 1 MiB per
line; malformed/oversized records are preserved byte-for-byte and generate
an explicit incomplete-metadata warning. Original content, UUIDs, parent links
and historical Windows paths are not rewritten.

The remote archive is
`$HOME/.local/share/happypanda/history/<node-workspace-key>/<manifest-hash>`.
Its versioned manifest records original source paths and the selected local
workspace/remote workspace mapping. Python 3 validates remote paths, hashes
and sizes. Files upload to `.part`, then atomically rename after verification.
The manifest completes last. Existing corrupt committed archives are rejected
and preserved for review.

Retries hash-check and skip complete files. A fully uploaded `.part` can be
verified and finalized after interruption. **Actual byte-level resume is not
implemented**: an incomplete `.part` is retransmitted using SCP/main's upload
callback. Default SCP expects modern OpenSSH with SFTP transport. Results
state this limitation explicitly. `imported` counts newly completed selected
transcripts, `remotePaths` includes all successful selected transcripts, and
`bytes` counts uploaded payload bytes including the manifest. Re-importing
the same complete manifest returns zero imported/bytes with reusable paths.

Only `claude --version` is invoked to check target writer compatibility. For
example, writer 2.1.292 versus target 2.1.287 generates a downgrade warning;
unknown versions also warn. No login, model request, historical tool replay,
credential transfer, project index replacement or automatic resume occurs.
Attachments, checkpoints and runtime state are not migrated. Main implements
explicit transcript resume; successful archival does not prove resume or
cross-version runtime compatibility.

Project auto-memory is handled separately by `ProjectMemoryImporter` in
`src/main/memory.ts` and the workspace's memory-import action. Transcript import
alone does not populate the remote project's `memory/` directory.
