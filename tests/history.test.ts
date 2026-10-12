import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServiceNode, Workspace } from '../src/shared/types';
import { HistoryImporter, listLocalHistory } from '../src/main/history';
import { METADATA_HEAD_BYTES, METADATA_TAIL_BYTES, readTranscriptMetadata, validateHistoryFile, versionWarnings } from '../src/main/history/metadata';

const directories: string[] = [];
const node: ServiceNode = { id: 'node', name: 'Node', sshTarget: 'test-host', createdAt: '' };
const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex');
const jsonl = (...records: object[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n';

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'happypanda-history-'));
  directories.push(directory);
  const configDir = path.join(directory, 'config');
  const project = path.join(configDir, 'projects', '-C-Develop-Example');
  await mkdir(project, { recursive: true });
  const primary = path.join(project, 'session-uuid.jsonl');
  const content = jsonl({ type: 'user', sessionId: 'session-uuid', uuid: 'message-uuid', parentUuid: null,
    cwd: 'C:\\Develop\\Example', version: '2.1.292', message: { content: 'Keep C:\\Develop\\Example in this historical message' } });
  await writeFile(primary, content);
  const workspace: Workspace = { id: 'workspace', nodeId: node.id, name: 'Example', localPath: 'C:\\Develop\\Example',
    remotePath: '/home/test/.local/share/happypanda/workspaces/workspace', localAccess: false, syncSessionName: 'hp-workspace', createdAt: '' };
  const remote = new Map<string, Buffer>();
  const events: string[] = [];
  const runRemote = vi.fn(async (_node: ServiceNode, command: string) => {
    if (command === 'claude --version') { events.push('version'); return '2.1.287 (Claude Code)'; }
    const encoded = command.match(/'([A-Za-z\d+/=]+)'$/)![1];
    const payload = JSON.parse(Buffer.from(encoded, 'base64').toString());
    events.push(payload.action);
    const root = `/home/test/.local/share/happypanda/history/${payload.workspaceKey}/${payload.manifestHash}`;
    if (payload.action === 'init') return JSON.stringify({ root });
    const file = payload.file;
    const target = `${root}/${file.relativePath}`;
    const part = `${target}.part`;
    const matches = (entry?: Buffer) => Boolean(entry && entry.length === file.bytes && hash(entry) === file.sha256);
    if (remote.has(target)) {
      if (!matches(remote.get(target))) throw new Error('Existing content-addressed archive is corrupt');
      return JSON.stringify({ root, path: target, part, ready: true });
    }
    if (payload.action === 'probe') {
      const ready = matches(remote.get(part));
      if (ready) { remote.set(target, remote.get(part)!); remote.delete(part); }
      return JSON.stringify({ root, path: target, part, ready, recoveredPart: ready });
    }
    if (!matches(remote.get(part))) throw new Error('Uploaded .part failed SHA256/size verification');
    remote.set(target, remote.get(part)!); remote.delete(part);
    return JSON.stringify({ root, path: target, part, ready: true });
  });
  const uploadFile = vi.fn(async (_node: ServiceNode, local: string, target: string) => {
    events.push('upload'); remote.set(target, await readFile(local));
  });
  const importer = new HistoryImporter({ dataDir: path.join(directory, 'app'), configDir, runRemote, uploadFile });
  return { directory, configDir, project, primary, content, workspace, remote, events, runRemote, uploadFile, importer };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('bounded local history inventory', () => {
  it('uses saved metadata for actual project transcripts and excludes agents/configuration', async () => {
    const f = await fixture();
    await writeFile(path.join(f.project, 'sessions-index.json'), JSON.stringify({ originalPath: 'C:\\Develop\\Example', entries: [
      { sessionId: 'session-uuid', summary: 'Saved session title', fullPath: 'C:\\credentials.json' },
      { sessionId: 'missing', summary: 'Stale entry' },
    ] }));
    await writeFile(path.join(f.configDir, '.credentials.json'), 'not json and must not be read');
    await writeFile(path.join(f.project, 'agent-other.jsonl'), jsonl({ sessionId: 'session-uuid' }));
    await mkdir(path.join(f.project, 'session-uuid', 'subagents'), { recursive: true });
    await writeFile(path.join(f.project, 'session-uuid', 'subagents', 'agent-a.jsonl'), jsonl({ version: '2.1.292' }));
    const projects = await listLocalHistory(f.configDir);
    expect(projects).toHaveLength(1); expect(projects[0].name).toBe('Example');
    expect(projects[0].sessions).toHaveLength(1);
    expect(projects[0].sessions[0]).toMatchObject({ id: 'session-uuid', title: 'Saved session title', cwd: 'C:\\Develop\\Example', writerVersion: '2.1.292' });
    expect(projects[0].sessions[0].path).toBe(await realpath(f.primary));
    expect(projects[0].sessions[0].bytes).toBe(Buffer.byteLength(f.content));
  });
  it('falls back to JSONL metadata and a saved custom title without reading the middle', async () => {
    const f = await fixture();
    const padding = jsonl({ type: 'system', data: 'x'.repeat(METADATA_HEAD_BYTES + METADATA_TAIL_BYTES + 64) });
    await writeFile(f.primary, f.content + padding + jsonl({ type: 'custom-title', customTitle: 'Edited title' }));
    const metadata = await readTranscriptMetadata(f.primary);
    expect(metadata.title).toBe('Edited title'); expect(metadata.cwd).toBe('C:\\Develop\\Example');
    expect(metadata.writerVersions).toContain('2.1.292');
  });
  it('returns an empty inventory for a missing projects root', async () => {
    const f = await fixture(); expect(await listLocalHistory(path.join(f.directory, 'empty'))).toEqual([]);
  });
});

describe('history selection boundaries', () => {
  it('rejects sibling directories, credential files, subagent selection and workspace mismatches before remote access', async () => {
    const f = await fixture();
    const outside = path.join(f.directory, 'outside.jsonl'); await writeFile(outside, f.content);
    const root = await realpath(path.join(f.configDir, 'projects'));
    await expect(validateHistoryFile(root, outside, true)).rejects.toThrow('actual local projects root');
    await expect(validateHistoryFile(root, path.join(f.configDir, '.credentials.json'), true)).rejects.toThrow('actual local projects root');
    await expect(f.importer.import({ workspaceId: f.workspace.id, sessionPaths: [outside] }, f.workspace, node)).rejects.toThrow('actual local projects root');
    await expect(f.importer.import({ workspaceId: 'other', sessionPaths: [f.primary] }, f.workspace, node)).rejects.toThrow('mismatch');
    await expect(f.importer.import({ workspaceId: f.workspace.id, sessionPaths: [] }, f.workspace, node)).rejects.toThrow('Select');
    expect(f.runRemote).not.toHaveBeenCalled(); expect(f.uploadFile).not.toHaveBeenCalled();
  });
  it('rejects junctions even if the linked file is a JSONL transcript', async () => {
    const f = await fixture();
    const outside = path.join(f.directory, 'outside'); await mkdir(outside);
    await writeFile(path.join(outside, 'escape.jsonl'), f.content);
    const link = path.join(f.configDir, 'projects', 'linked');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.importer.import({ workspaceId: f.workspace.id, sessionPaths: [path.join(link, 'escape.jsonl')] }, f.workspace, node)).rejects.toThrow(/projects root|symbolic/);
    expect(f.runRemote).not.toHaveBeenCalled();
    expect(await listLocalHistory(f.configDir)).toHaveLength(1);
  });
});

describe('manifest, writer compatibility and verified transfer', () => {
  it('archives only the selection and matching subagents, preserving JSON, UUIDs and Windows paths', async () => {
    const f = await fixture();
    const agents = path.join(f.project, 'session-uuid', 'subagents'); await mkdir(agents, { recursive: true });
    const agentContent = jsonl({ type: 'assistant', sessionId: 'session-uuid', uuid: 'agent-message', parentUuid: 'message-uuid', version: '2.1.292' });
    await writeFile(path.join(agents, 'agent-a.jsonl'), agentContent);
    await writeFile(path.join(f.project, 'agent-unrelated.jsonl'), jsonl({ sessionId: 'other-session', version: '2.1.292' }));
    const result = await f.importer.import({ workspaceId: f.workspace.id, sessionPaths: [f.primary, f.primary] }, f.workspace, node);
    expect(result.imported).toBe(1); expect(result.remotePaths).toHaveLength(1); expect(f.uploadFile).toHaveBeenCalledTimes(3);
    expect(f.remote.get(result.remotePaths[0])?.toString()).toBe(f.content);
    expect([...f.remote.entries()].find(([name]) => name.endsWith('/subagents/agent-a.jsonl'))?.[1].toString()).toBe(agentContent);
    expect([...f.remote.keys()].some(name => name.includes('agent-unrelated'))).toBe(false);
    const manifest = JSON.parse([...f.remote.entries()].find(([name]) => name.endsWith('/manifest.json'))![1].toString());
    expect(manifest.formatVersion).toBe(1); expect(manifest.files).toHaveLength(2);
    expect(manifest.workspace.localRoot).toBe('C:\\Develop\\Example'); expect(manifest.workspace.remoteRoot).toBe(f.workspace.remotePath);
    expect(manifest.files[0].writerVersions).toContain('2.1.292');
    expect(result.warnings.join('\n')).toContain('newer than remote Claude 2.1.287');
    expect(result.warnings.join('\n')).toContain('byte-level resume is not implemented');
    expect(f.events.indexOf('version')).toBeLessThan(f.events.indexOf('upload'));
    expect(f.runRemote.mock.calls.some(([, command]) => /auth|--resume|--print/.test(command))).toBe(false);
    expect(await readdir(path.join(f.directory, 'app', 'history-staging'))).toEqual([]);
  });
  it('skips an existing matching manifest and transcripts without transferring bytes again', async () => {
    const f = await fixture(); const request = { workspaceId: f.workspace.id, sessionPaths: [f.primary] };
    const first = await f.importer.import(request, f.workspace, node);
    f.uploadFile.mockClear();
    const second = await f.importer.import(request, f.workspace, node);
    expect(second.imported).toBe(0); expect(second.bytes).toBe(0); expect(second.remotePaths).toEqual(first.remotePaths);
    expect(f.uploadFile).not.toHaveBeenCalled();
  });
  it('streams the full selection for versions outside the inventory head/tail window', async () => {
    const f = await fixture();
    const first = jsonl({ type: 'user', sessionId: 'session-uuid', version: '2.1.198', message: { content: 'First prompt' } });
    const padding = jsonl({ type: 'system', data: 'x'.repeat(METADATA_HEAD_BYTES + METADATA_TAIL_BYTES + 64) });
    await writeFile(f.primary, first + padding + jsonl({ type: 'assistant', version: '2.1.292' }) + padding);
    expect((await readTranscriptMetadata(f.primary)).writerVersions).toEqual(['2.1.198']);
    const result = await f.importer.import({ workspaceId: f.workspace.id, sessionPaths: [f.primary] }, f.workspace, node);
    expect(result.warnings.join('\n')).toContain('Transcript writer 2.1.292 is newer');
    expect(f.remote.get(result.remotePaths[0])?.length).toBe(Buffer.byteLength(first + padding + jsonl({ type: 'assistant', version: '2.1.292' }) + padding));
  });
  it('preserves oversized records and reports incomplete version scanning', async () => {
    const f = await fixture();
    const content = jsonl({ type: 'assistant', sessionId: 'session-uuid', version: '2.1.292', data: 'x'.repeat(1024 * 1024 + 64) });
    await writeFile(f.primary, content);
    const result = await f.importer.import({ workspaceId: f.workspace.id, sessionPaths: [f.primary] }, f.workspace, node);
    expect(f.remote.get(result.remotePaths[0])?.toString()).toBe(content);
    expect(result.warnings.join('\n')).toContain('oversized metadata records were preserved');
    expect(result.warnings.join('\n')).toContain('No transcript writer version was found');
  });
  it('recovers a complete .part after interruption without claiming byte resume', async () => {
    const f = await fixture();
    f.uploadFile.mockImplementationOnce(async (_node, local, target) => {
      f.remote.set(target, await readFile(local)); throw new Error('Connection interrupted before commit');
    });
    const request = { workspaceId: f.workspace.id, sessionPaths: [f.primary] };
    await expect(f.importer.import(request, f.workspace, node)).rejects.toThrow('Connection interrupted');
    f.uploadFile.mockClear();
    const result = await f.importer.import(request, f.workspace, node);
    expect(result.imported).toBe(1); expect(f.uploadFile).toHaveBeenCalledTimes(1);
    expect(f.uploadFile.mock.calls[0][2]).toMatch(/manifest\.json\.part$/);
    expect(f.remote.get(result.remotePaths[0])?.toString()).toBe(f.content);
  });
  it('retransmits an incomplete part and rejects corrupt committed archives', async () => {
    const f = await fixture(); const request = { workspaceId: f.workspace.id, sessionPaths: [f.primary] };
    f.uploadFile.mockImplementationOnce(async (_node, _local, target) => {
      f.remote.set(target, Buffer.from('incomplete')); throw new Error('Network interrupted');
    });
    await expect(f.importer.import(request, f.workspace, node)).rejects.toThrow('Network interrupted');
    const result = await f.importer.import(request, f.workspace, node);
    expect(f.remote.get(result.remotePaths[0])?.toString()).toBe(f.content);
    f.remote.set(result.remotePaths[0], Buffer.from('tampered'));
    f.uploadFile.mockClear();
    await expect(f.importer.import(request, f.workspace, node)).rejects.toThrow('corrupt');
    expect(f.uploadFile).not.toHaveBeenCalled();
  });
  it('makes unknown/equal/older writer versions explicit', () => {
    expect(versionWarnings(['2.1.292'], '2.1.287').join()).toContain('newer');
    expect(versionWarnings(['2.1.292'], '2.1.292')).toEqual([]);
    expect(versionWarnings(['2.1.198'], '2.1.287').join()).toContain('differs');
    expect(versionWarnings([], '2.1.287').join()).toContain('No transcript writer');
    expect(versionWarnings(['2.1.292']).join()).toContain('could not be checked');
  });
});
