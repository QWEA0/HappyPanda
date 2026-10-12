import { randomUUID, createHash } from 'node:crypto';
import { access, copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ActivityEvent, ServiceNode, SyncState, Workspace } from '../../shared/types';
import { emptySync } from '../../shared/types';
import { checkedLocalPath, conflictRelativePath, fileFingerprint, isWithin, sameFingerprint } from './paths';
import { remoteFileOperation, type Fingerprint, type RunRemote } from './remote';
import { JSON_TEMPLATE, normalizeMutagenState, parseMutagenSessions, type MutagenSession } from './state';
import { gitIgnorePaths } from './git-ignores';
import { mutagenRemoteEndpoint, remoteRoot, runCommand, scpTransfer, sshAddress, verifySystemIdentity,
  type CommandRunner, type FileTransfer, type PrepareSsh, type SshPreparation } from './transport';

export { normalizeMutagenState, parseMutagenSessions } from './state';
export type { FileTransfer, PrepareSsh, SshPreparation } from './transport';

export const SYNC_IGNORES = ['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache', '.happypanda-sync-*'];

export interface WorkspaceSyncOptions {
  dataDir: string;
  onState: (state: SyncState) => void;
  onActivity?: (event: Omit<ActivityEvent, 'id' | 'time'>) => void;
  runRemote: RunRemote;
  uploadFile?: FileTransfer;
  downloadFile?: FileTransfer;
  prepareSsh?: PrepareSsh;
  mutagenPath?: string;
  runCommand?: CommandRunner;
  pollIntervalMs?: number;
  onWorkspaceUpdated?: (workspace:Workspace)=>Promise<void>;
}

export function orderedSyncIgnores(ignores:string[]):string[]{
  return [...new Set(ignores.filter(value=>!SYNC_IGNORES.includes(value))),...SYNC_IGNORES];
}

export function syncConfiguration(ignores:string[]):string {
  return JSON.stringify({sync:{defaults:{ignore:{paths:orderedSyncIgnores(ignores)}}}});
}

export function createSyncArguments(workspace: Workspace, localRoot: string, remotePath: string, connection: ServiceNode | SshPreparation, ignores: string[]=SYNC_IGNORES, configurationFile?:string): string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspace.syncSessionName)) throw new Error('Invalid Mutagen session name');
  if (!path.isAbsolute(localRoot)) throw new Error('Local workspace must be absolute');
  return ['sync', 'create', '--name', workspace.syncSessionName, '--no-global-configuration', '--mode', 'two-way-safe',
    '--ignore-vcs', '--ignore-syntax', 'mutagen', ...(configurationFile?['--configuration-file',configurationFile]:orderedSyncIgnores(ignores).flatMap(ignore => ['--ignore', ignore])),
    '--', localRoot, mutagenRemoteEndpoint(connection, remotePath)];
}

export function assertReusableSession(session: MutagenSession, localRoot: string, remotePath: string, connection: ServiceNode | SshPreparation, generatedIgnores:string[]=[]): void {
  const { host, user, port } = sshAddress(connection);
  const sameLocal = process.platform === 'win32' ? path.resolve(session.alpha.path).toLowerCase() === localRoot.toLowerCase() : path.resolve(session.alpha.path) === localRoot;
  if (session.alpha.protocol !== 'local' || !sameLocal || session.beta.protocol !== 'ssh' || session.beta.host !== host ||
    (session.beta.user ?? '') !== (user ?? '') || (session.beta.port ?? 0) !== (port ?? 0) || session.beta.path !== remotePath) {
    throw new Error('Existing Mutagen session has different local/remote targets; it was preserved');
  }
  const ignores = session.ignore?.paths ?? [];
  const lastInclusion=ignores.reduce((last,ignore,index)=>ignore.startsWith('!')?index:last,-1);
  if (session.mode !== 'two-way-safe' || !SYNC_IGNORES.every(ignore => ignores.includes(ignore)) ||
    ignores.some(ignore=>ignore.startsWith('!')&&!generatedIgnores.includes(ignore)) ||
    (lastInclusion>=0&&!SYNC_IGNORES.every(ignore=>ignores.lastIndexOf(ignore)>lastInclusion)) ||
    [...(session.alpha.ignore?.paths ?? []), ...(session.beta.ignore?.paths ?? [])].some(ignore => ignore.startsWith('!'))) {
    throw new Error('Existing Mutagen session lacks the required safe mode or exclusions; it was preserved');
  }
}

interface ActiveWorkspace {
  workspace: Workspace;
  node: ServiceNode;
  localRoot: string;
  remotePath: string;
  connection: ServiceNode | SshPreparation;
  prepared?: SshPreparation;
  identifier: string;
}

export class WorkspaceSync {
  private readonly options: WorkspaceSyncOptions;
  private readonly runner: CommandRunner;
  private readonly mutagenDataDir: string;
  private binary?: string;
  private active?: ActiveWorkspace;
  private state: SyncState = emptySync();
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private pending = 0;
  private disposed = false;
  private disposing = false;
  private disposal?: Promise<void>;
  private started = false;
  private listeners=new Set<(state:SyncState)=>void>();

  constructor(options: WorkspaceSyncOptions) {
    this.options = options;
    this.runner = options.runCommand ?? runCommand;
    this.mutagenDataDir = path.resolve(options.dataDir, 'mutagen');
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed || this.disposing) return Promise.reject(new Error('WorkspaceSync is disposed'));
    this.pending++;
    const result = this.queue.then(async () => {
      if (this.disposed) throw new Error('WorkspaceSync is disposed');
      return operation();
    });
    this.queue = result.catch(() => undefined);
    return result.finally(() => { this.pending--; });
  }

  private publish(state: SyncState): SyncState {
    const previous = this.state;
    this.state = state;
    this.options.onState(state);
    for(const listener of this.listeners)listener(state);
    if (previous.phase !== state.phase || previous.message !== state.message) {
      this.options.onActivity?.({ kind: state.phase === 'error' ? 'error' : 'sync', title: state.message,
        workspaceId: this.active?.workspace.id, location: 'local' });
    }
    return state;
  }

  private failed(error: unknown): SyncState {
    return this.publish({ phase: 'error', message: error instanceof Error ? error.message : String(error), conflicts: this.state.conflicts,
      sessionName: this.active?.workspace.syncSessionName, updatedAt: new Date().toISOString() });
  }

  private async cli(args: string[], prepared?: SshPreparation): Promise<string> {
    await mkdir(this.mutagenDataDir, { recursive: true });
    if (!this.binary) {
      const executable = process.platform === 'win32' ? 'mutagen.exe' : 'mutagen';
      const candidate = path.resolve('.local', 'tools', executable);
      try { await access(candidate); this.binary = this.options.mutagenPath ?? candidate; }
      catch { this.binary = this.options.mutagenPath ?? executable; }
    }
    const env = { ...process.env, MUTAGEN_DATA_DIRECTORY: this.mutagenDataDir };
    const connection = prepared ?? this.active?.prepared;
    if (connection?.mutagenSshPath) Object.assign(env, { MUTAGEN_SSH_PATH: connection.mutagenSshPath });
    this.started = true;
    return this.runner(this.binary, args, { env, timeoutMs: args[1] === 'flush' ? 120_000 : 60_000 });
  }

  private async sessions(prepared?: SshPreparation): Promise<MutagenSession[]> {
    return parseMutagenSessions(await this.cli(['sync', 'list', '--template', JSON_TEMPLATE], prepared));
  }

  private async readStatus(): Promise<SyncState> {
    if (!this.active) return this.publish(emptySync());
    const sessions = await this.sessions();
    const session = sessions.find(item => item.identifier === this.active!.identifier);
    if (!session) throw new Error('The workspace synchronization session no longer exists');
    assertReusableSession(session, this.active.localRoot, this.active.remotePath, this.active.connection, this.active.workspace.syncGitIgnores);
    return this.publish(normalizeMutagenState(session));
  }

  private startPolling(): void {
    if (this.timer || this.options.pollIntervalMs === 0) return;
    this.timer = setInterval(() => {
      if (this.polling || this.pending || this.disposed || this.disposing) return;
      this.polling = true;
      void this.status().catch(() => undefined).finally(() => { this.polling = false; });
    }, this.options.pollIntervalMs ?? 2000);
    this.timer.unref();
  }

  ensure(workspace: Workspace, node: ServiceNode): Promise<SyncState> {
    return this.serialize(async () => {
      try {
        if (workspace.nodeId !== node.id) throw new Error('Workspace belongs to a different service node');
        if (!path.isAbsolute(workspace.localPath)) throw new Error('Local workspace must be absolute');
        const remoteInput = workspace.remotePath.startsWith('$HOME/') ? `/home/${workspace.remotePath.slice(6)}` :
          workspace.remotePath.startsWith('~/') ? `/home/${workspace.remotePath.slice(2)}` : workspace.remotePath;
        remoteRoot(remoteInput);
        const localRoot = await realpath(workspace.localPath);
        if (!(await lstat(localRoot)).isDirectory() || localRoot.split(path.sep).some(segment => segment.toLowerCase() === '.git')) throw new Error('Local workspace is not a project directory');
        const prepared = await this.options.prepareSsh?.(node);
        const connection = prepared ?? node;
        sshAddress(connection);
        await verifySystemIdentity(node, this.runner, prepared);
        // Expand only a literal home prefix on the remote; no shell expansion of user input.
        const remote = await remoteFileOperation<{ root: string }>(this.options.runRemote, node, { action: 'ensure', root: workspace.remotePath });
        const remotePath = remoteRoot(remote.root);
        const sessions = await this.sessions(prepared);
        const matching = sessions.filter(item => item.name === workspace.syncSessionName);
        if (matching.length > 1) throw new Error('Multiple Mutagen sessions use this name; explicit cleanup is required');
        let session:MutagenSession|undefined = matching[0];
        if (session) assertReusableSession(session, localRoot, remotePath, connection, workspace.syncGitIgnores);
        const gitIgnores=await gitIgnorePaths(localRoot,this.runner,SYNC_IGNORES);
        const previousGenerated=new Set(workspace.syncGitIgnores??[]);
        const preserved=(session?.ignore?.paths??[]).filter(value=>!previousGenerated.has(value));
        const ignores=orderedSyncIgnores([...preserved,...gitIgnores]);
        let selectedName=workspace.syncSessionName;
        if(session&&JSON.stringify(session.ignore?.paths)!==JSON.stringify(ignores)){
          // A replacement starts with no ancestor. Drain managed sessions while their
          // history still exists; never turn pending edits/conflicts into add/add conflicts.
          if(this.active&&this.active.identifier!==session.identifier)await this.cli(['sync','pause',this.active.identifier]);
          this.active={workspace:{...workspace},node:{...node},localRoot,remotePath,connection,prepared,identifier:session.identifier};
          this.startPolling();
          if(session.paused&&(workspace.syncGitIgnores!==undefined||session.conflicts?.length||session.excludedConflicts))await this.cli(['sync','resume',session.identifier],prepared);
          if(session.conflicts?.length||session.excludedConflicts)return await this.readStatus();
          if(workspace.syncGitIgnores!==undefined){
            await this.cli(['sync','flush',session.identifier],prepared);
            const current=(await this.sessions(prepared)).find(item=>item.identifier===session!.identifier);
            if(!current)throw new Error('The previous synchronization session no longer exists');
            assertReusableSession(current,localRoot,remotePath,connection,workspace.syncGitIgnores);
            if(normalizeMutagenState(current).phase!=='ready')return this.publish(normalizeMutagenState(current));
            session=current;
          }
          const digest=createHash('sha256').update(JSON.stringify(ignores)).digest('hex').slice(0,12);
          selectedName=workspace.syncSessionName.replace(/-scope-[a-f0-9]{12}$/,'').slice(0,90)+'-scope-'+digest;
          await this.cli(['sync','pause',session.identifier],prepared);
          session=sessions.find(item=>item.name===selectedName);
          if(session){assertReusableSession(session,localRoot,remotePath,connection,gitIgnores);if(JSON.stringify(session.ignore?.paths)!==JSON.stringify(ignores))throw new Error('Existing scoped session has different ignore rules; it was preserved');}
        }
        if (this.active && this.active.identifier !== session?.identifier) await this.cli(['sync', 'pause', this.active.identifier]);
        this.publish({ phase: 'preparing', message: 'Preparing workspace synchronization', conflicts: [], sessionName: selectedName, updatedAt: new Date().toISOString() });
        if (!session) {
          // A tracked tree can have thousands of exceptions, exceeding Windows argv limits.
          const configurationRoot=path.resolve(this.options.dataDir,'sync-config');
          await mkdir(configurationRoot,{recursive:true});
          const configurationFile=path.join(configurationRoot,createHash('sha256').update(syncConfiguration(ignores)).digest('hex')+'.json');
          await writeFile(configurationFile,syncConfiguration(ignores),{mode:0o600});
          const args=createSyncArguments({...workspace,syncSessionName:selectedName},localRoot,remotePath,connection,ignores,configurationFile);
          await this.cli(args, prepared);
          session = (await this.sessions(prepared)).find(item => item.name === selectedName)!;
          if (!session) throw new Error('Mutagen did not report the created session');
          assertReusableSession(session, localRoot, remotePath, connection, gitIgnores);
        }
        workspace.syncSessionName=selectedName;workspace.syncGitIgnores=gitIgnores;
        await this.options.onWorkspaceUpdated?.(workspace);
        this.active = { workspace: { ...workspace }, node: { ...node }, localRoot, remotePath, connection, prepared, identifier: session.identifier };
        if (session.paused) await this.cli(['sync', 'resume', session.identifier]);
        this.startPolling();
        return await this.readStatus();
      } catch (error) { return this.failed(error); }
    });
  }

  status(): Promise<SyncState> {
    return this.serialize(async () => { try { return await this.readStatus(); } catch (error) { return this.failed(error); } });
  }

  waitUntilReady(signal:AbortSignal,sessionName?:()=>string):Promise<SyncState>{
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{this.listeners.delete(changed);signal.removeEventListener('abort',aborted);};
      const aborted=()=>{cleanup();reject(new Error('Workspace preparation cancelled'));};
      const changed=(state:SyncState)=>{if(this.disposed||this.disposing){aborted();return;}if(state.phase==='ready'&&(!sessionName||state.sessionName===sessionName())){cleanup();resolve(state);}};
      if(signal.aborted){aborted();return;}
      this.listeners.add(changed);signal.addEventListener('abort',aborted,{once:true});changed(this.state);
    });
  }

  flush(): Promise<SyncState> {
    return this.serialize(async () => {
      try {
        if (!this.active) return this.publish(emptySync());
        const state = await this.readStatus();
        if (['error', 'conflict', 'paused', 'disconnected'].includes(state.phase)) return state;
        await this.cli(['sync', 'flush', this.active.identifier]);
        return await this.readStatus();
      } catch (error) { return this.failed(error); }
    });
  }

  pause(): Promise<void> {
    return this.serialize(async () => {
      if (!this.active) return;
      try { await this.cli(['sync', 'pause', this.active.identifier]); await this.readStatus(); }
      catch (error) { this.failed(error); throw error; }
    });
  }

  resolveConflict(relative: string, prefer: 'local' | 'remote'): Promise<void> {
    return this.serialize(async () => {
      conflictRelativePath(relative);
      if (prefer !== 'local' && prefer !== 'remote') throw new Error('Conflict preference must be local or remote');
      const active = this.active;
      if (!active) throw new Error('No workspace synchronization session');
      const session = (await this.sessions()).find(item => item.identifier === active.identifier);
      if (!session) throw new Error('Synchronization session no longer exists');
      assertReusableSession(session, active.localRoot, active.remotePath, active.connection, active.workspace.syncGitIgnores);
      if (!session.conflicts?.some(conflict => conflict.root === relative)) throw new Error('Only an explicitly selected current conflict can be resolved');
      const localFile = await checkedLocalPath(active.localRoot, relative);
      const local = await fileFingerprint(localFile);
      const remote = await remoteFileOperation<Fingerprint>(this.options.runRemote, active.node, { action: 'inspect', root: active.remotePath, relative });
      await this.cli(['sync', 'pause', active.identifier]);
      let temporaryDirectory: string | undefined;
      try {
        const stagingRoot = path.resolve(this.options.dataDir, 'sync-staging');
        await mkdir(stagingRoot, { recursive: true });
        temporaryDirectory = await mkdtemp(path.join(stagingRoot, 'conflict-'));
        const temporaryFile = path.join(temporaryDirectory, 'content');
        if (prefer === 'local') {
          if (!local.exists) await remoteFileOperation(this.options.runRemote, active.node, { action: 'delete', root: active.remotePath, relative, expected: remote });
          else {
            await copyFile(localFile, temporaryFile);
            if (!sameFingerprint(local, await fileFingerprint(temporaryFile)) || !sameFingerprint(local, await fileFingerprint(await checkedLocalPath(active.localRoot, relative)))) throw new Error('Local conflict file changed; review it again');
            const part = path.posix.join(path.posix.dirname(relative), `.happypanda-sync-${randomUUID()}.part`);
            const result = await remoteFileOperation<{ part: string }>(this.options.runRemote, active.node, { action: 'prepare', root: active.remotePath, relative, part });
            if (this.options.uploadFile) await this.options.uploadFile(active.node, temporaryFile, result.part);
            else await scpTransfer(active.node, temporaryFile, result.part, 'upload', this.runner, active.prepared);
            await remoteFileOperation(this.options.runRemote, active.node, { action: 'replace', root: active.remotePath, relative, part, expected: remote, source: local });
          }
        } else {
          if (remote.exists) {
            const remoteFile = path.posix.join(active.remotePath, relative);
            if (this.options.downloadFile) await this.options.downloadFile(active.node, temporaryFile, remoteFile);
            else await scpTransfer(active.node, temporaryFile, remoteFile, 'download', this.runner, active.prepared);
            if (!sameFingerprint(remote, await fileFingerprint(temporaryFile))) throw new Error('Downloaded conflict file failed SHA256 verification');
          }
          if (!sameFingerprint(local, await fileFingerprint(await checkedLocalPath(active.localRoot, relative)))) throw new Error('Local destination changed; review the conflict again');
          if (remote.exists) {
            const destination = await checkedLocalPath(active.localRoot, relative);
            await mkdir(path.dirname(destination), { recursive: true });
            await checkedLocalPath(active.localRoot, relative);
            const part = path.join(path.dirname(destination), `.happypanda-sync-${randomUUID()}.part`);
            try { await copyFile(temporaryFile, part); await checkedLocalPath(active.localRoot, relative); await rename(part, destination); }
            finally { await unlink(part).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
          } else if (local.exists) await unlink(await checkedLocalPath(active.localRoot, relative));
        }
        if (!session.paused) { await this.cli(['sync', 'resume', active.identifier]); await this.cli(['sync', 'flush', active.identifier]); }
        await this.readStatus();
      } catch (error) { this.failed(error); throw error; }
      finally {
        if (temporaryDirectory) {
          const root = await realpath(path.resolve(this.options.dataDir, 'sync-staging'));
          const target = await realpath(temporaryDirectory);
          if (isWithin(root, target) && path.basename(target).startsWith('conflict-')) await rm(target, { recursive: true });
        }
      }
    });
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposing = true;
    for(const listener of this.listeners)listener(this.state);
    if (this.timer) clearInterval(this.timer);
    this.disposal = this.queue.then(async () => {
      try {
        try { if (this.active) await this.cli(['sync', 'pause', this.active.identifier]); }
        finally { if (this.started) await this.cli(['daemon', 'stop']); }
      } finally { this.disposed = true; }
    });
    return this.disposal;
  }
}
