import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServiceNode, Workspace } from '../src/shared/types';
import { WorkspaceSync, MutagenCli, SYNC_IGNORES, createSyncArguments } from '../src/main/sync';
import { checkedLocalPath, conflictRelativePath } from '../src/main/sync/paths';
import { normalizeMutagenState, parseMutagenSessions, type MutagenSession } from '../src/main/sync/state';
import { mutagenRemoteEndpoint, scpArguments, verifySystemIdentity, type CommandOptions } from '../src/main/sync/transport';

const node: ServiceNode = { id: 'node', name: 'Node', sshTarget: 'test-host', createdAt: '' };
const directories: string[] = [];
const instances: WorkspaceSync[] = [];
const digest = (content: Buffer) => createHash('sha256').update(content).digest('hex');

function sample(overrides: Partial<MutagenSession> = {}): MutagenSession {
  return { identifier: 'sync_123', name: 'hp-workspace', mode: 'two-way-safe', paused: false, status: 'watching', successfulCycles: 1,
    alpha: { protocol: 'local', path: path.resolve('work'), connected: true, scanned: true },
    beta: { protocol: 'ssh', path: '/srv/project', host: node.sshTarget, connected: true, scanned: true },
    ignore: { paths: [...SYNC_IGNORES], vcs: 'ignore' }, ...overrides };
}

async function fixture(initial = true) {
  const directory = await mkdtemp(path.join(tmpdir(), 'happypanda-sync-'));
  directories.push(directory);
  const local = path.join(directory, 'local project');
  await mkdir(local);
  const workspace: Workspace = { id: 'workspace', nodeId: node.id, name: 'Project', localPath: local,
    remotePath: '/srv/remote project', localAccess: false, syncSessionName: 'hp-workspace', createdAt: '' };
  let session: MutagenSession | undefined = initial ? sample({ alpha: { protocol: 'local', path: await realpath(local), connected: true, scanned: true },
    beta: { protocol: 'ssh', host: node.sshTarget, path: workspace.remotePath, connected: true, scanned: true } }) : undefined;
  const commands: { file:string; args: string[]; options?: CommandOptions }[] = [];
  const remote = new Map<string, Buffer>();
  const runner = vi.fn(async (_file: string, args: string[], options?: CommandOptions) => {
    commands.push({ file:_file, args, options });
    if (_file === 'ssh') return 'identityfile ~/.ssh/id_ed25519\n';
    if (args[1] === 'list') return JSON.stringify(session ? [session] : []);
    if (args[1] === 'create') session = sample({ name:args[args.indexOf('--name')+1],ignore:{paths:args.includes('--configuration-file')?JSON.parse(await readFile(args[args.indexOf('--configuration-file')+1],'utf8')).sync.defaults.ignore.paths:args.flatMap((value,index)=>value==='--ignore'?[args[index+1]]:[])},alpha: { protocol: 'local', path: args.at(-2)!, connected: true, scanned: true },
      beta: { protocol: 'ssh', host: node.sshTarget, path: workspace.remotePath, connected: true, scanned: true } });
    if (args[1] === 'pause' && session) session.paused = true;
    if (args[1] === 'resume' && session) session.paused = false;
    return '';
  });
  const runRemote = vi.fn(async (_node: ServiceNode, command: string) => {
    const encoded = command.match(/'([A-Za-z\d+/=]+)'$/)![1];
    const payload = JSON.parse(Buffer.from(encoded, 'base64').toString());
    if (payload.action === 'ensure') return JSON.stringify({ root: workspace.remotePath });
    const file = path.posix.join(workspace.remotePath, payload.relative);
    const content = remote.get(file);
    const fingerprint = content ? { exists: true, bytes: content.length, sha256: digest(content) } : { exists: false };
    if (payload.action === 'inspect') return JSON.stringify(fingerprint);
    if (payload.action === 'prepare') return JSON.stringify({ part: path.posix.join(workspace.remotePath, payload.part) });
    expect(payload.expected).toEqual(fingerprint);
    if (payload.action === 'delete') remote.delete(file);
    else if (payload.action === 'replace') {
      const part = path.posix.join(workspace.remotePath, payload.part);
      const data = remote.get(part)!;
      expect(payload.source).toEqual({ exists: true, bytes: data.length, sha256: digest(data) });
      remote.set(file, data); remote.delete(part);
    }
    if (session) session.conflicts = [];
    return JSON.stringify({ ok: true });
  });
  const onState = vi.fn();
  const sync = new WorkspaceSync({ dataDir: path.join(directory, 'app'), onState, runRemote, runCommand: runner, pollIntervalMs: 0,
    uploadFile: async (_node, source, target) => { remote.set(target, await readFile(source)); },
    downloadFile: async (_node, target, source) => { await writeFile(target, remote.get(source)!); } });
  instances.push(sync);
  return { directory, local, workspace, sync, runner, commands, remote, runRemote, onState,
    get session() { return session!; }, set session(value: MutagenSession) { session = value; } };
}

afterEach(async () => {
  for (const sync of instances.splice(0)) await sync.dispose();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('Mutagen structured status', () => {
  it('parses the official JSON template and reports readiness only after a cycle', () => {
    const parsed = parseMutagenSessions(JSON.stringify([sample()]));
    expect(normalizeMutagenState(parsed[0]).phase).toBe('ready');
    expect(normalizeMutagenState(sample({ successfulCycles: 0 })).phase).toBe('preparing');
    expect(() => parseMutagenSessions('No sessions found')).toThrow();
    expect(() => parseMutagenSessions(JSON.stringify([{ status: 'watching' }]))).toThrow('Invalid');
    expect(normalizeMutagenState(sample({ alpha: { ...sample().alpha, scanned: undefined } })).phase).toBe('preparing');
  });
  it.each([['scanning', 'scanning'], ['waiting-for-rescan', 'scanning'], ['staging-alpha', 'syncing'], ['transitioning', 'syncing'],
    ['connecting-beta', 'preparing'], ['disconnected', 'disconnected'], ['halted-on-root-deletion', 'error'], ['future-status', 'error']])('normalizes %s to %s', (status, phase) => {
    expect(normalizeMutagenState(sample({ status })).phase).toBe(phase);
  });
  it('preserves explicit conflicts while surfacing scan/write failures and truncation', () => {
    const state = normalizeMutagenState(sample({ conflicts: [{ root: 'src/a.ts' }], excludedConflicts: 2,
      alpha: { ...sample().alpha, scanProblems: [{ path: 'locked', error: 'permission denied' }], excludedScanProblems: 5 },
      beta: { ...sample().beta, transitionProblems: [{ path: 'full', error: 'no space left' }] } }));
    expect(state.phase).toBe('error');
    expect(state.message).toContain('local scan: locked');
    expect(state.message).toContain('remote write: full');
    expect(state.message).toContain('5 more scan');
    expect(state.conflicts[0].path).toBe('src/a.ts');
    expect(normalizeMutagenState(sample({ conflicts: [{ root: 'a' }], excludedConflicts: 2 })).message).toContain('3 synchronization conflicts');
  });
  it('does not treat last errors, disconnected endpoints or a paused session as ready', () => {
    expect(normalizeMutagenState(sample({ lastError: 'SSH failed' })).phase).toBe('error');
    expect(normalizeMutagenState(sample({ beta: { ...sample().beta, connected: false } })).phase).toBe('disconnected');
    expect(normalizeMutagenState(sample({ paused: true })).phase).toBe('paused');
  });
});

describe('sync args, isolation and session ownership', () => {
  it('uses safe mode, mandatory exclusions, literal paths and configured SSH user/port', async () => {
    const f = await fixture();
    const connection = { ...node, user: 'ubuntu', port: 2222 };
    const args = createSyncArguments(f.workspace, f.local, f.workspace.remotePath, connection);
    expect(args).toContain('two-way-safe'); expect(args).toContain('--ignore-vcs'); expect(args).toContain('--no-global-configuration');
    expect(args.slice(-3)).toEqual(['--', f.local, 'ubuntu@test-host:2222:/srv/remote project']);
    expect(SYNC_IGNORES).toContain('.git'); expect(SYNC_IGNORES).toContain('.venv'); expect(SYNC_IGNORES).not.toContain('dist');
    const scp = scpArguments({ ...connection, identityFile: 'C:\\key path\\id' }, f.local, '/srv/file with space.part', 'upload');
    expect(scp.slice(-3)).toEqual(['--', f.local, 'ubuntu@test-host:/srv/file with space.part']);
    expect(scp).toContain('C:\\key path\\id'); expect(scp).toContain('2222');
    expect(() => mutagenRemoteEndpoint(node, 'C:\\local')).toThrow('POSIX');
    expect(() => mutagenRemoteEndpoint({ ...node, sshTarget: '-oProxyCommand=x' }, '/srv/project')).toThrow();
  });
  it('creates once then reuses the same session in an app data directory', async () => {
    const f = await fixture(false);
    expect((await f.sync.ensure(f.workspace, node)).phase).toBe('ready');
    expect((await f.sync.ensure(f.workspace, node)).phase).toBe('ready');
    expect(f.commands.filter(command => command.args[1] === 'create')).toHaveLength(1);
    expect(f.commands.some(command => ['terminate', 'reset'].includes(command.args[1]))).toBe(false);
    expect(f.commands[0].options?.env?.MUTAGEN_DATA_DIRECTORY).toBe(path.join(f.directory, 'app', 'mutagen'));
    expect(f.commands.find(command => command.args[1] === 'list')?.args).toContain('{{ json . }}');
  });
  it('pauses the original session and creates a scoped replacement when Git exclusions are discovered',async()=>{
    const f=await fixture();const original=f.session;
    const runner=f.runner.getMockImplementation()!;
    f.runner.mockImplementation(async(file,args,options)=>{
      if(file==='git')return args.includes('rev-parse')?f.local:args.includes('--ignored')?'data/\0.env\0':args.includes('check-ignore')?'data\0':'src/main.ts\0';
      return runner(file,args,options);
    });
    expect((await f.sync.ensure(f.workspace,node)).phase).toBe('ready');
    expect(original.paused).toBe(true);
    expect(f.workspace.syncSessionName).toMatch(/-scope-[a-f0-9]{12}$/);
    expect(f.workspace.syncGitIgnores).toEqual(['/.env','/data/']);
    expect(f.session.ignore?.paths).toContain('/data/');
    expect(f.commands.some(command=>['reset','terminate'].includes(command.args[1]))).toBe(false);
    await f.sync.ensure(f.workspace,node);
    expect(f.commands.filter(command=>command.args[1]==='create')).toHaveLength(1);
  });
  it('waits for a scan without a blocking flush and allows cancellation during preparation',async()=>{
    const f=await fixture();f.session.status='scanning';f.session.successfulCycles=0;
    await f.sync.ensure(f.workspace,node);
    const abort=new AbortController();let finished=false;
    const ready=f.sync.waitUntilReady(abort.signal,()=>f.workspace.syncSessionName).then(()=>{finished=true;});
    await f.sync.status();expect(finished).toBe(false);
    expect(f.commands.some(command=>command.args[1]==='flush')).toBe(false);
    f.session.status='watching';f.session.successfulCycles=1;await f.sync.status();await ready;
    f.session.status='scanning';await f.sync.status();
    const cancelled=f.sync.waitUntilReady(abort.signal);const rejected=expect(cancelled).rejects.toThrow('cancelled');abort.abort();await rejected;
  });
  it('preserves a session with different endpoints or unsafe exclusions', async () => {
    const f = await fixture();
    f.session.beta.path = '/srv/unrelated';
    expect((await f.sync.ensure(f.workspace, node)).message).toContain('different local/remote targets');
    expect(f.commands.some(command => command.args[1] === 'create')).toBe(false);
    f.session.beta.path = f.workspace.remotePath;
    f.session.ignore = { paths: ['dist'] };
    expect((await f.sync.ensure(f.workspace, node)).message).toContain('required safe mode');
  });
  it('reuses a prepared session without recomputing remote setup or Git scope', async () => {
    const f = await fixture();
    expect((await f.sync.ensure(f.workspace, node)).phase).toBe('ready');
    const remoteCalls = f.runRemote.mock.calls.length;
    const gitCalls = f.commands.filter(command => command.file === 'git').length;
    expect((await f.sync.ensure(f.workspace, node, { reuse: true })).phase).toBe('ready');
    expect(f.runRemote.mock.calls.length).toBe(remoteCalls);
    expect(f.commands.filter(command => command.file === 'git').length).toBe(gitCalls);
    await f.sync.ensure(f.workspace, node);
    expect(f.runRemote.mock.calls.length).toBeGreaterThan(remoteCalls);
  });
  it('shares one flush between callers that arrive before it starts', async () => {
    const f = await fixture();
    await f.sync.ensure(f.workspace, node);
    const before = f.commands.filter(command => command.args[1] === 'flush').length;
    await Promise.all([f.sync.flush(), f.sync.flush(), f.sync.flush()]);
    expect(f.commands.filter(command => command.args[1] === 'flush').length - before).toBe(1);
    await f.sync.flush();
    expect(f.commands.filter(command => command.args[1] === 'flush').length - before).toBe(2);
  });
  it('reports an unsupported explicit identity rather than ignoring it', async () => {
    const f = await fixture();
    const state = await f.sync.ensure(f.workspace, { ...node, identityFile: path.join(f.directory, 'unconfigured key') });
    expect(state.phase).toBe('error'); expect(state.message).toContain('IdentityFile');
    expect(f.runRemote).not.toHaveBeenCalled();
    expect(f.commands.some(command => command.args[1] === 'create')).toBe(false);
  });
  it('provides the prepared SSH directory to the first daemon-starting list and every later CLI call', async () => {
    const f = await fixture(false);
    const sshDirectory = 'C:\\Windows\\System32\\OpenSSH';
    const sync = new WorkspaceSync({ dataDir: path.join(f.directory, 'prepared-app'), onState: vi.fn(), runRemote: f.runRemote,
      runCommand: f.runner, pollIntervalMs: 0, prepareSsh: async target => ({ target: target.sshTarget, mutagenSshPath: sshDirectory }) });
    instances.push(sync);
    await sync.ensure(f.workspace, node);
    expect(f.commands[0].args[1]).toBe('list');
    expect(f.commands[0].options?.env?.MUTAGEN_SSH_PATH).toBe(sshDirectory);
    await sync.status(); await sync.flush(); await sync.pause(); await sync.dispose();
    expect(f.commands.filter(command=>command.file!=='git').every(command => command.options?.env?.MUTAGEN_SSH_PATH === sshDirectory)).toBe(true);
    expect(f.commands.at(-1)?.args).toEqual(['daemon', 'stop']);
  });
  it('does not let a prepared system directory silently bypass an explicit identity', async () => {
    const f = await fixture();
    const prepared = { target: node.sshTarget, mutagenSshPath: 'C:\\Windows\\System32\\OpenSSH' };
    const runner = vi.fn(async () => 'identityfile ~/.ssh/id_ed25519\n');
    await expect(verifySystemIdentity({ ...node, identityFile: path.join(f.directory, 'custom key') }, runner, prepared)).rejects.toThrow('IdentityFile');
    expect(runner.mock.calls).toHaveLength(1);
    const args = scpArguments({ ...node, identityFile: 'custom key' }, f.local, '/srv/file', 'upload', prepared);
    expect(args).toContain('-i'); expect(args).toContain('custom key');
  });
  it('restarts only the isolated daemon before first use of the app transport', async () => {
    const f = await fixture(false);
    const sync = new WorkspaceSync({dataDir:path.join(f.directory,'app-transport'),onState:vi.fn(),runRemote:f.runRemote,
      runCommand:f.runner,pollIntervalMs:0,restartDaemonOnTransportChange:true,
      prepareSsh:async target=>({target:target.sshTarget,mutagenSshPath:path.join(f.directory,'ssh-transport'),managesIdentity:true})});
    instances.push(sync);
    await sync.ensure(f.workspace,node);await sync.status();await sync.flush();
    expect(f.commands[0].args).toEqual(['daemon','stop']);
    expect(f.commands[1].args[1]).toBe('list');
    expect(f.commands.filter(command=>command.args[0]==='daemon')).toHaveLength(1);
    await expect(verifySystemIdentity({...node,identityFile:'custom key'},f.runner,{target:node.sshTarget,managesIdentity:true})).resolves.toBeUndefined();
  });
  it('pauses without destroying the session and does not flush a conflict', async () => {
    const f = await fixture();
    await f.sync.ensure(f.workspace, node);
    await f.sync.pause(); expect((await f.sync.status()).phase).toBe('paused');
    await f.sync.ensure(f.workspace, node); expect(f.session.paused).toBe(false);
    f.session.conflicts = [{ root: 'a' }];
    expect((await f.sync.flush()).phase).toBe('conflict');
    expect(f.commands.some(command => command.args[1] === 'flush')).toBe(false);
  });
  it('drains outstanding work during disposal and rejects new operations', async () => {
    const f = await fixture();
    const ensured = f.sync.ensure(f.workspace, node);
    const disposal = f.sync.dispose();
    await expect(f.sync.status()).rejects.toThrow('disposed');
    expect((await ensured).phase).toBe('ready');
    await disposal;
    expect(f.commands.at(-1)?.args).toEqual(['daemon', 'stop']);
    await f.sync.dispose();
    expect(f.commands.filter(command => command.args[0] === 'daemon')).toHaveLength(1);
  });
});

describe('single-file conflict boundaries', () => {
  it.each(['', '..', '../a', '/absolute', 'C:/a', 'a/../b', '.git/config', 'x/.git/config', 'a\\b'])('rejects unsafe path %j', value => {
    expect(() => conflictRelativePath(value)).toThrow();
  });
  it('rejects a junction escaping the workspace', async () => {
    const f = await fixture();
    const outside = path.join(f.directory, 'outside'); await mkdir(outside);
    await symlink(outside, path.join(f.local, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(checkedLocalPath(await realpath(f.local), 'link/file')).rejects.toThrow('Symbolic');
  });
  it('copies the explicitly preferred local file through a verified part', async () => {
    const f = await fixture();
    await writeFile(path.join(f.local, 'file with space.txt'), 'local UUID');
    f.remote.set('/srv/remote project/file with space.txt', Buffer.from('remote UUID'));
    f.session.conflicts = [{ root: 'file with space.txt' }, { root: 'unrelated.txt' }];
    await f.sync.ensure(f.workspace, node);
    await f.sync.resolveConflict('file with space.txt', 'local');
    expect(f.remote.get('/srv/remote project/file with space.txt')?.toString()).toBe('local UUID');
    expect(await readFile(path.join(f.local, 'file with space.txt'), 'utf8')).toBe('local UUID');
    expect(f.commands.some(command => command.args[1] === 'reset')).toBe(false);
  });
  it('selects a remote file and honors a preferred deletion without recursive removal', async () => {
    const f = await fixture();
    const file = path.join(f.local, 'a.txt'); await writeFile(file, 'local');
    f.remote.set('/srv/remote project/a.txt', Buffer.from('remote'));
    f.session.conflicts = [{ root: 'a.txt' }];
    await f.sync.ensure(f.workspace, node); await f.sync.resolveConflict('a.txt', 'remote');
    expect(await readFile(file, 'utf8')).toBe('remote');
    f.session.conflicts = [{ root: 'a.txt' }]; f.remote.delete('/srv/remote project/a.txt');
    await f.sync.resolveConflict('a.txt', 'remote');
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects unreported paths and directory conflicts', async () => {
    const f = await fixture(); await f.sync.ensure(f.workspace, node);
    await expect(f.sync.resolveConflict('arbitrary.txt', 'local')).rejects.toThrow('selected current conflict');
    await mkdir(path.join(f.local, 'directory')); f.session.conflicts = [{ root: 'directory' }];
    await expect(f.sync.resolveConflict('directory', 'local')).rejects.toThrow('directories require manual');
    expect(f.commands.some(command => command.args[1] === 'pause')).toBe(false);
  });
});

describe('shared Mutagen daemon client', () => {
  const transport = (directory: string) => ({ target: node.sshTarget, mutagenSshPath: path.join(directory, 'ssh-transport'), managesIdentity: true });
  it('treats a daemon that is not running as already stopped when restarting or shutting down', async () => {
    const f = await fixture(false);
    const runner = vi.fn(async (file: string, args: string[], options?: CommandOptions) => {
      if (args[0] !== 'daemon') return f.runner(file, args, options);
      f.commands.push({ file, args, options });
      throw new Error('mutagen.exe failed (1): Error: unable to connect to daemon: connection timed out (is the daemon running?)');
    });
    const sync = new WorkspaceSync({ dataDir: path.join(f.directory, 'stopped-daemon'), onState: vi.fn(), runRemote: f.runRemote, runCommand: runner,
      pollIntervalMs: 0, restartDaemonOnTransportChange: true, prepareSsh: async () => transport(f.directory) });
    expect((await sync.ensure(f.workspace, node)).phase).toBe('ready');
    await expect(sync.dispose()).resolves.toBeUndefined();
    expect(f.commands.filter(command => command.args[0] === 'daemon')).toHaveLength(2);
  });
  it('still reports other failures to stop the daemon', async () => {
    const f = await fixture(false);
    const runner = vi.fn(async (file: string, args: string[], options?: CommandOptions) => {
      if (args[0] === 'daemon') throw new Error('mutagen.exe failed (1): Error: access is denied');
      return f.runner(file, args, options);
    });
    const sync = new WorkspaceSync({ dataDir: path.join(f.directory, 'denied'), onState: vi.fn(), runRemote: f.runRemote, runCommand: runner,
      pollIntervalMs: 0, restartDaemonOnTransportChange: true, prepareSsh: async () => transport(f.directory) });
    const state = await sync.ensure(f.workspace, node);
    expect(state.phase).toBe('error'); expect(state.message).toContain('access is denied');
  });
  it('shares one transport restart and coalesces polling reads across workspaces, leaving the daemon to its owner', async () => {
    const f = await fixture();
    const cli = new MutagenCli({ dataDir: path.join(f.directory, 'shared'), runCommand: f.runner, restartDaemonOnTransportChange: true });
    const connection = transport(f.directory);
    await Promise.all([cli.run(['sync', 'pause', 'a'], connection), cli.run(['sync', 'pause', 'b'], connection)]);
    expect(f.commands.filter(command => command.args[0] === 'daemon')).toHaveLength(1);
    const lists = () => f.commands.filter(command => command.args[1] === 'list').length;
    const [first, second] = await Promise.all([cli.pollList(connection), cli.pollList(connection)]);
    expect(first).toBe(second); expect(lists()).toBe(1);
    await cli.pollList(connection); expect(lists()).toBe(1);
    await cli.run(['sync', 'resume', 'a'], connection);
    await cli.pollList(connection); expect(lists()).toBe(2);
    const sync = new WorkspaceSync({ dataDir: path.join(f.directory, 'shared'), onState: vi.fn(), runRemote: f.runRemote, runCommand: f.runner, pollIntervalMs: 0, cli });
    expect((await sync.ensure(f.workspace, node)).phase).toBe('ready');
    await sync.dispose();
    expect(f.commands.filter(command => command.args[0] === 'daemon')).toHaveLength(1);
    await cli.stopDaemon();
    expect(f.commands.at(-1)?.args).toEqual(['daemon', 'stop']);
    expect(f.commands.at(-1)?.options?.env?.MUTAGEN_SSH_PATH).toBe(connection.mutagenSshPath);
  });
});