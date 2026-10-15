export type ConnectionPhase = 'disconnected' | 'preparing' | 'connecting' | 'connected' | 'retrying' | 'failed';
export type SyncPhase = 'none' | 'preparing' | 'scanning' | 'syncing' | 'ready' | 'conflict' | 'paused' | 'disconnected' | 'error';

export interface ServiceNode {
  id: string;
  name: string;
  sshTarget: string;
  user?: string;
  port?: number;
  identityFile?: string;
  lastWorkspaceId?: string;
  lastSessionId?: string;
  providerId?: string;
  loginViaNode?: boolean;
  createdAt: string;
}
export interface Workspace {
  id: string;
  nodeId: string;
  name: string;
  localPath: string;
  remotePath: string;
  localAccess: boolean;
  syncSessionName: string;
  syncGitIgnores?: string[];
  createdAt: string;
}
export interface SessionInfo {
  id: string;
  nodeId: string;
  workspaceId?: string;
  title: string;
  tmuxName: string;
  createdAt: string;
  lastActiveAt: string;
  kind: 'claude' | 'login' | 'shell';
  transcriptPath?: string;
  reloadToken?: string;
}
export interface ServerMetrics {
  hostname: string;
  os: string;
  cpuCount: number;
  load: number;
  memoryTotal: number;
  memoryAvailable: number;
  diskAvailable: number;
  uptime: number;
  claudeVersion: string | null;
  authenticated: boolean;
  address: string;
  gitHead?: string | null;
  sampledAt: string;
}
export interface SyncConflict { path: string; description: string }
export interface SyncState {
  phase: SyncPhase;
  git?: {phase:'syncing'|'ready'|'blocked'|'error';message:string;head?:string;reference?:string};
  message: string;
  sessionName?: string;
  conflicts: SyncConflict[];
  updatedAt: string;
  bytesTransferred?: number;
}
export interface ActivityEvent {
  id: string;
  time: string;
  kind: 'connection' | 'sync' | 'tool' | 'command' | 'session' | 'error';
  title: string;
  detail?: string;
  location?: 'local' | 'remote';
  sessionId?: string;
  workspaceId?: string;
}
export interface ConnectionState {
  phase: ConnectionPhase;
  message: string;
  retryAttempt: number;
  activeNodeId?: string;
  activeWorkspaceId?: string;
  activeSessionId?: string;
}
export interface AppState {
  workspacePreparation?: {workspaceId:string;phase:'syncing'|'git'|'ready'|'error';message:string};
  browserLogin?: BrowserLoginState;
  providers: ApiProvider[];
  nodes: ServiceNode[];
  workspaces: Workspace[];
  sessions: SessionInfo[];
  connection: ConnectionState;
  metrics: ServerMetrics | null;
  sync: SyncState;
  activities: ActivityEvent[];
  terminalBuffer: string;
  version: string;
  portForwards?: PortForward[];
}
export interface BrowserLoginState {
  phase: 'idle' | 'preparing' | 'waiting' | 'opening' | 'ready' | 'authenticated' | 'blocked' | 'failed';
  nodeId?: string;
  browserName?: string;
  message: string;
  routeVerified: boolean;
  network?: { phase: 'checking' | 'reachable' | 'failed'; message: string; checkedAt?: string };
}
export interface ApiProvider {
  id: string;
  name: string;
  baseUrl: string;
  authType: 'auth-token' | 'api-key';
  model?: string;
  disableNonessentialTraffic: boolean;
  revision: number;
}
export interface ProviderInput {
  id?: string;
  name: string;
  baseUrl: string;
  authType: ApiProvider['authType'];
  token?: string;
  model?: string;
  disableNonessentialTraffic: boolean;
}
export interface NodeInput {
  id?: string;
  name: string;
  sshTarget: string;
  user?: string;
  port?: number;
  identityFile?: string;
}
export interface SshAlias { name: string; hostname?: string; user?: string; port?: number }
export interface LocalHistoryProject {
  id: string;
  name: string;
  path: string;
  sessions: LocalHistorySession[];
}
export interface LocalHistorySession {
  id: string;
  path: string;
  title: string;
  cwd?: string;
  writerVersion?: string;
  modifiedAt: string;
  bytes: number;
}
export interface ImportResult { imported: number; bytes: number; remotePaths: string[]; warnings: string[] }
export interface MemoryImportResult {sourcePath:string;destinationPath:string;totalFiles:number;bytes:number;imported:number;unchanged:number;conflicts:string[]}
export interface ImportRequest { workspaceId: string; sessionPaths: string[] }
export interface PortForward { id: string; localPort: number; remotePort: number; nodeId: string }
export interface TerminalPasteRequest {nodeId:string;sessionId:string;bracketedPaste:boolean}
export interface TerminalPasteResult {kind:'image'|'text'|'empty'}

export type AppEvent =
  | { type: 'state'; state: AppState }
  | { type: 'terminal'; data: string }
  | { type: 'activity'; activity: ActivityEvent };

export interface HappyPandaAPI {
  getState(): Promise<AppState>;
  saveProvider(input: ProviderInput): Promise<ApiProvider>;
  removeProvider(id: string): Promise<void>;
  selectProvider(nodeId: string, providerId: string | null): Promise<void>;
  listSshAliases(): Promise<SshAlias[]>;
  saveNode(input: NodeInput): Promise<ServiceNode>;
  removeNode(id: string): Promise<void>;
  chooseWorkspace(nodeId: string): Promise<Workspace | null>;
  connect(nodeId: string, workspaceId?: string, sessionId?: string): Promise<void>;
  disconnect(): Promise<void>;
  newSession(kind?: 'claude' | 'login' | 'shell'): Promise<void>;
  removeSession(id: string): Promise<void>;
  writeTerminal(data: string): void;
  copyText(text: string): Promise<void>;
  pasteClipboard(request:TerminalPasteRequest):Promise<TerminalPasteResult>;
  resizeTerminal(cols: number, rows: number): void;
  setLocalAccess(workspaceId: string, enabled: boolean): Promise<void>;
  syncNow(): Promise<SyncState>;
  pauseSync(): Promise<void>;
  resolveConflict(path: string, prefer: 'local' | 'remote'): Promise<void>;
  openLocalPath(workspaceId: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  listLocalHistory(): Promise<LocalHistoryProject[]>;
  importHistory(request: ImportRequest): Promise<ImportResult>;
  importProjectMemory(workspaceId:string):Promise<MemoryImportResult>;
  resumeImported(workspaceId: string, transcriptPath: string): Promise<void>;
  addPortForward(remotePort: number, localPort?: number): Promise<PortForward>;
  removePortForward(id: string): Promise<void>;
  onEvent(callback: (event: AppEvent) => void): () => void;
}

export const emptySync = (): SyncState => ({ phase: 'none', message: '', conflicts: [], updatedAt: new Date().toISOString() });
