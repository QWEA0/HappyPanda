import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, opendir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ImportRequest, ImportResult, ServiceNode, Workspace } from '../../shared/types';
import { isWithin } from '../sync/paths';
import type { RunRemote } from '../sync/remote';
import { scpTransfer, type FileTransfer, type PrepareSsh } from '../sync/transport';
import { historyProjectsRoot, readTranscriptMetadata, snapshotTranscript, validateHistoryFile, versionWarnings } from './metadata';
import { archiveOperation, type ArchiveFile, type ArchiveProbe } from './remote';

export { listLocalHistory } from './inventory';

export interface HistoryImporterOptions {
  dataDir: string;
  runRemote: RunRemote;
  uploadFile?: FileTransfer;
  configDir?: string;
  prepareSsh?: PrepareSsh;
}

export interface HistoryManifestFile extends ArchiveFile {
  sourcePath: string;
  sessionId: string;
  selected: boolean;
  writerVersions: string[];
}
export interface HistoryManifest {
  formatVersion: 1;
  workspace: { id: string; nodeId: string; localRoot: string; remoteRoot: string };
  files: HistoryManifestFile[];
}

export function manifestHash(manifest: HistoryManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

async function subagentFiles(root: string, primary: string, sessionId: string): Promise<string[]> {
  const project = path.dirname(primary);
  const stem = path.basename(primary, '.jsonl');
  const found = new Set<string>();
  let visited = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8 || visited > 10_000) throw new Error('Subagent archive exceeds the bounded discovery limit');
    let info;
    try { info = await lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink() || !info.isDirectory() || !isWithin(root, await realpath(directory))) throw new Error('Subagent directory is outside the actual projects root');
    for await (const entry of await opendir(directory)) {
      if (++visited > 10_000) throw new Error('Subagent archive exceeds the bounded discovery limit');
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Subagent symbolic links are not allowed');
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.add(await validateHistoryFile(root, file));
    }
  };
  const ids = new Set([stem, sessionId].filter(value => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) && value !== '..'));
  for (const id of ids) await walk(path.join(project, id, 'subagents'), 0);
  // Older Claude versions store agent transcripts next to the primary session.
  for await (const entry of await opendir(project)) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.startsWith('agent-') || !entry.name.endsWith('.jsonl')) continue;
    const file = await validateHistoryFile(root, path.join(project, entry.name));
    if ((await readTranscriptMetadata(file)).sessionId === sessionId) found.add(file);
  }
  return [...found].sort();
}

function relativeArchivePath(project: string, primary: string, file: string): string {
  const projectKey = createHash('sha256').update(project).digest('hex').slice(0, 24);
  const stem = path.basename(primary, '.jsonl');
  if (file === primary) return `projects/${projectKey}/${path.basename(file)}`;
  const relative = path.relative(project, file).split(path.sep).join('/');
  if (relative.startsWith('agent-')) return `projects/${projectKey}/${stem}/subagents/${relative}`;
  const offset = relative.indexOf('/subagents/');
  if (offset < 0) throw new Error('Subagent is not associated with the selected transcript');
  return `projects/${projectKey}/${stem}/subagents/${relative.slice(offset + 11)}`;
}

export class HistoryImporter {
  private readonly options: HistoryImporterOptions;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: HistoryImporterOptions) { this.options = options; }

  import(request: ImportRequest, workspace: Workspace, node: ServiceNode): Promise<ImportResult> {
    const operation = this.queue.then(() => this.performImport(request, workspace, node));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async performImport(request: ImportRequest, workspace: Workspace, node: ServiceNode): Promise<ImportResult> {
    if (request.workspaceId !== workspace.id || workspace.nodeId !== node.id) throw new Error('Import workspace/service node mismatch');
    if (!Array.isArray(request.sessionPaths) || request.sessionPaths.length === 0) throw new Error('Select at least one local session');
    const root = await historyProjectsRoot(this.options.configDir);
    const selected = new Set<string>();
    for (const requested of request.sessionPaths) selected.add(await validateHistoryFile(root, requested, true));
    const stagingRoot = path.resolve(this.options.dataDir, 'history-staging');
    await mkdir(stagingRoot, { recursive: true });
    const staging = await mkdtemp(path.join(stagingRoot, 'import-'));
    try {
      const files: HistoryManifestFile[] = [];
      const snapshots = new Map<string, string>();
      const warnings: string[] = [];
      const visited = new Set<string>();
      const add = async (primary: string, file: string, sessionId?: string): Promise<string> => {
        if (visited.has(file)) return sessionId ?? path.basename(file, '.jsonl');
        visited.add(file);
        const snapshot = path.join(staging, `${files.length}.jsonl`);
        const inspected = await snapshotTranscript(root, file, snapshot);
        const id = sessionId ?? inspected.metadata.sessionId ?? path.basename(primary, '.jsonl');
        const relativePath = relativeArchivePath(path.dirname(primary), primary, file);
        files.push({ relativePath, sourcePath: file, sessionId: id, selected: selected.has(file), sha256: inspected.sha256,
          bytes: inspected.bytes, writerVersions: inspected.metadata.writerVersions });
        snapshots.set(relativePath, snapshot);
        if (inspected.metadata.skippedRecords) warnings.push(`${path.basename(file)}: ${inspected.metadata.skippedRecords} malformed or oversized metadata records were preserved; writer-version scan may be incomplete`);
        return id;
      };
      for (const primary of [...selected].sort()) {
        const id = await add(primary, primary);
        for (const agent of await subagentFiles(root, primary, id)) await add(primary, agent, id);
      }
      files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      if (new Set(files.map(file => file.relativePath)).size !== files.length) throw new Error('Selected sessions collide in the archive mapping');
      let targetVersion: string | undefined;
      try { targetVersion = (await this.options.runRemote(node, 'claude --version')).match(/\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/)?.[1]; }
      catch { /* Archive preservation still works when Claude is not on PATH. */ }
      warnings.push(...versionWarnings(files.flatMap(file => file.writerVersions), targetVersion));
      warnings.push('Verified completed files are skipped on retry. Incomplete .part files are retransmitted; byte-level resume is not implemented');
      warnings.push('This archive preserves transcripts and subagents; attachment files, checkpoints, credentials and runtime state are not restored. Resume requires separate CLI validation');
      const manifest: HistoryManifest = { formatVersion: 1,
        workspace: { id: workspace.id, nodeId: node.id, localRoot: workspace.localPath, remoteRoot: workspace.remotePath }, files };
      const digest = manifestHash(manifest);
      const workspaceKey = createHash('sha256').update(`${node.id}\0${workspace.id}`).digest('hex').slice(0, 32);
      const context = { workspaceKey, manifestHash: digest };
      const archive = await archiveOperation<{ root: string }>(this.options.runRemote, node, { ...context, action: 'init' });
      if (!archive.root.startsWith('/') || archive.root.includes('\\') || !archive.root.endsWith(`/history/${workspaceKey}/${digest}`)) throw new Error('Remote archive returned an invalid app-owned root');
      const prepared = this.options.uploadFile ? undefined : await this.options.prepareSsh?.(node);
      const upload: FileTransfer = this.options.uploadFile ?? ((target, local, remote) => scpTransfer(target, local, remote, 'upload', undefined, prepared));
      const result: ImportResult = { imported: 0, bytes: 0, remotePaths: [], warnings: [...new Set(warnings)] };
      const transfer = async (entry: ArchiveFile, snapshot: string): Promise<{ path: string; newlyCompleted: boolean }> => {
        const expectedPath = path.posix.join(archive.root, entry.relativePath);
        const probe = await archiveOperation<ArchiveProbe>(this.options.runRemote, node, { ...context, action: 'probe', file: entry });
        if (probe.root !== archive.root || probe.path !== expectedPath || probe.part !== `${expectedPath}.part`) throw new Error('Remote transfer destination differs from the manifest');
        if (probe.ready) return { path: probe.path, newlyCompleted: Boolean(probe.recoveredPart) };
        await upload(node, snapshot, probe.part);
        const committed = await archiveOperation<ArchiveProbe>(this.options.runRemote, node, { ...context, action: 'commit', file: entry });
        if (!committed.ready || committed.path !== expectedPath) throw new Error('Remote archive did not confirm the verified file');
        result.bytes += entry.bytes;
        return { path: committed.path, newlyCompleted: true };
      };
      for (const file of files) {
        const transferred = await transfer(file, snapshots.get(file.relativePath)!);
        if (file.selected) {
          result.remotePaths.push(transferred.path);
          if (transferred.newlyCompleted) result.imported++;
        }
      }
      const manifestContent = Buffer.from(`${JSON.stringify({ ...manifest, manifestHash: digest }, null, 2)}\n`);
      const manifestFile = path.join(staging, 'manifest.json');
      await writeFile(manifestFile, manifestContent, { flag: 'wx', mode: 0o600 });
      await transfer({ relativePath: 'manifest.json', sha256: createHash('sha256').update(manifestContent).digest('hex'), bytes: manifestContent.length }, manifestFile);
      return result;
    } finally {
      const canonicalRoot = await realpath(stagingRoot);
      const canonicalStage = await realpath(staging);
      if (isWithin(canonicalRoot, canonicalStage) && path.basename(canonicalStage).startsWith('import-')) await rm(canonicalStage, { recursive: true });
    }
  }
}
