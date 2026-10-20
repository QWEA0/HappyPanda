import type { AppEvent, AppState, HappyPandaAPI, TerminalPasteRequest, TerminalPasteResult } from '../../shared/types';
import { DESKTOP_OWNER, REMOTE_RPC_WRITE_METHODS, type RemoteClientStatus, type RemoteSessionInfo, type RemoteTerminalContext } from '../../shared/remote';
import { terminalPaste } from '../../shared/terminal';

export const isRemotePage = () => window.location.pathname.startsWith('/remote/');

class RemoteRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function copyBrowserText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Fall back on LAN HTTP. */ }
  }
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.append(area);
  try {
    area.select();
    if (!document.execCommand('copy')) throw new Error('复制失败，请长按选中文本后复制。');
  } finally { area.remove(); previous?.focus({ preventScroll: true }); }
}

export class RemoteClient {
  private status: RemoteClientStatus = { phase: 'connecting', authenticated: false, owner: DESKTOP_OWNER };
  private statusListeners = new Set<() => void>();
  private eventListeners = new Set<(event: AppEvent) => void>();
  private source?: EventSource;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private snapshot?: AppState;
  private revision = 0;
  private generation = 0;
  private inputGeneration = 0;
  private sessionRevision = 0;
  private inputTail: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private retries = 0;
  private started = false;
  private pairingToken?: string;
  private readonly writeMethods = new Set<string>(REMOTE_RPC_WRITE_METHODS);

  readonly subscribe = (listener: () => void) => {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  };
  readonly getStatus = () => this.status;

  readonly api: HappyPandaAPI = {
    getState: () => this.getState(),
    listSshAliases: () => this.rpc('listSshAliases'),
    saveNode: input => this.rpc('saveNode', input),
    removeNode: id => this.rpc('removeNode', id),
    saveProvider: input => this.rpc('saveProvider', input),
    removeProvider: id => this.rpc('removeProvider', id),
    selectProvider: (nodeId, providerId) => this.rpc('selectProvider', nodeId, providerId),
    chooseWorkspace: async () => { throw new Error('请先在 PC 上添加本地工作区，再在手机上选择已有工作区。'); },
    connect: (...args) => this.rpc('connect', ...args),
    disconnect: () => this.rpc('disconnect'),
    reconnect: () => this.rpc('reconnect'),
    focusSession: id => this.rpc('focusSession', id),
    closeSession: id => this.rpc('closeSession', id),
    // The phone mirrors the focused session only; its scrollback arrives with state snapshots.
    getTerminalBuffer: async () => ({ generation: this.snapshot?.terminalGeneration ?? 0, data: this.snapshot?.terminalBuffer ?? '', end: 0 }),
    newSession: kind => this.rpc('newSession', kind),
    removeSession: id => this.rpc('removeSession', id),
    writeTerminal: data => this.writeTerminal(data),
    resizeTerminal: (cols, rows) => this.resizeTerminal(cols, rows),
    copyText: text => copyBrowserText(text),
    pasteClipboard: request => this.pasteClipboard(request),
    setLocalAccess: (id, enabled) => this.rpc('setLocalAccess', id, enabled),
    setWorkspaceMode: (id, mode) => this.rpc('setWorkspaceMode', id, mode),
    syncNow: () => this.rpc('syncNow'),
    pauseSync: () => this.rpc('pauseSync'),
    resolveConflict: (path, prefer) => this.rpc('resolveConflict', path, prefer),
    openLocalPath: async () => { throw new Error('本地目录位于 PC，请在 PC 上打开。'); },
    openExternal: async url => {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('仅支持 HTTP 或 HTTPS 链接。');
      if (['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('此链接位于 PC 本机，请在 PC 上打开。');
      window.open(parsed.href, '_blank', 'noopener,noreferrer');
    },
    listLocalHistory: () => this.rpc('listLocalHistory'),
    importHistory: request => this.rpc('importHistory', request),
    resumeImported: (id, path) => this.rpc('resumeImported', id, path),
    importProjectMemory: id => this.rpc('importProjectMemory', id),
    addPortForward: (remote, local) => this.rpc('addPortForward', remote, local),
    removePortForward: id => this.rpc('removePortForward', id),
    onEvent: callback => {
      this.eventListeners.add(callback);
      return () => { this.eventListeners.delete(callback); };
    },
  };

  private update(patch: Partial<RemoteClientStatus>) {
    this.status = { ...this.status, ...patch };
    for (const listener of this.statusListeners) listener();
  }

  private emit(event: AppEvent) {
    this.revision += 1;
    if (event.type === 'state') {
      const sameSession = this.snapshot && this.contextKey(this.snapshot) === this.contextKey(event.state);
      if (event.resetTerminal || !this.snapshot || this.terminalKey(this.snapshot) !== this.terminalKey(event.state)) this.inputGeneration += 1;
      this.snapshot = { ...event.state, terminalBuffer: event.resetTerminal ? event.state.terminalBuffer : sameSession ? this.snapshot!.terminalBuffer : event.state.terminalBuffer };
    } else if (event.type === 'terminal' && this.snapshot) {
      this.snapshot.terminalBuffer = (this.snapshot.terminalBuffer + event.data).slice(-512000);
    } else if (event.type === 'terminal-size' && this.snapshot) {
      this.snapshot.terminalSize = { cols: event.cols, rows: event.rows };
    } else if (event.type === 'activity' && this.snapshot) {
      this.snapshot.activities = [...this.snapshot.activities.filter(item => item.id !== event.activity.id), event.activity].slice(-100);
    }
    for (const listener of this.eventListeners) listener(event);
  }

  private contextKey(state: AppState) {
    return `${state.connection.activeNodeId || ''}/${state.connection.activeSessionId || ''}`;
  }

  private terminalKey(state: AppState) {
    return JSON.stringify([this.contextKey(state), state.connection.phase, state.terminalGeneration, state.sessions.find(session => session.id === state.connection.activeSessionId)?.reloadToken]);
  }

  private async request<T>(path: string, body?: unknown, timeout = 30000): Promise<T> {
    const generation = this.generation;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    try {
      const response = await fetch('/api/remote' + path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: abort.signal,
      });
      const data = await response.json() as { result?: T; error?: string };
      if (!response.ok) {
        if (response.status === 401 && path !== '/session' && path !== '/pair' && generation === this.generation) this.unauthorized();
        throw new RemoteRequestError(data.error || '请求失败，请重试。', response.status);
      }
      return data.result as T;
    } catch (error) {
      if (error instanceof RemoteRequestError) throw error;
      throw new Error(body === undefined ? '暂时无法连接 PC，请检查 PC 和网络连接。' : '连接中断，操作结果尚未确认。请恢复连接后查看当前状态。');
    } finally { clearTimeout(timer); }
  }

  private unauthorized() {
    const authenticated = this.status.authenticated;
    this.stopConnection();
    this.snapshot = undefined;
    this.update({ phase: authenticated ? 'revoked' : 'unpaired', authenticated: false, deviceId: undefined, owner: DESKTOP_OWNER, message: authenticated ? '配对已失效，请使用新的配对码重新连接。' : undefined });
  }

  private applySession(session: RemoteSessionInfo) {
    this.sessionRevision += 1;
    const lostControl = this.status.owner.id === this.status.deviceId && session.owner.id !== session.deviceId;
    if (lostControl) this.inputGeneration += 1;
    this.update({ authenticated: true, deviceId: session.deviceId, deviceName: session.deviceName, owner: session.owner });
  }

  start() {
    if (this.started) return;
    this.started = true;
    const parameters = new URLSearchParams(window.location.hash.slice(1));
    this.pairingToken = parameters.get('pair') || undefined;
    if (this.pairingToken) history.replaceState(null, '', window.location.pathname + window.location.search);
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.reconnect);
    void this.connect();
  }

  private readonly onVisible = () => {
    if (document.visibilityState === 'visible' && this.status.phase === 'reconnecting') this.reconnect();
  };

  private stopConnection() {
    ++this.generation;
    ++this.inputGeneration;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.source?.close();
    this.source = undefined;
  }

  private async connect() {
    this.stopConnection();
    const generation = this.generation;
    this.update({ phase: this.status.authenticated ? 'reconnecting' : 'connecting', message: undefined });
    try {
      let session: RemoteSessionInfo;
      try { session = await this.request<RemoteSessionInfo>('/session'); }
      catch (error) {
        if (!(error instanceof RemoteRequestError) || error.status !== 401 || !this.pairingToken) throw error;
        session = await this.request<RemoteSessionInfo>('/pair', { token: this.pairingToken, name: 'Android' });
        this.pairingToken = undefined;
      }
      if (generation !== this.generation) return;
      this.applySession(session);
      this.openEvents();
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof RemoteRequestError && [400, 401, 403, 429].includes(error.status)) {
        if (error.status === 401 && !this.pairingToken) {
          this.unauthorized();
          return;
        }
        if (this.pairingToken && error.status !== 429) this.pairingToken = undefined;
        this.update({ phase: 'unpaired', authenticated: false, message: error.status === 401 ? undefined : error.message });
      } else if (generation === this.generation) this.scheduleReconnect(error instanceof Error ? error.message : String(error));
    }
  }

  readonly reconnect = () => {
    if (this.status.phase === 'unpaired' || this.status.phase === 'revoked') return;
    void this.connect();
  };

  readonly pair = async (code: string, name: string) => {
    this.stopConnection();
    const generation = this.generation;
    this.update({ phase: 'connecting', message: undefined });
    try {
      const session = await this.request<RemoteSessionInfo>('/pair', { code: code.replace(/[\s-]/g, ''), name: name.trim() || 'Android' });
      if (generation !== this.generation) return;
      this.applySession(session);
      this.pairingToken = undefined;
      this.openEvents();
    } catch (error) {
      if (generation !== this.generation) return;
      this.update({ phase: 'unpaired', authenticated: false, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };

  private openEvents() {
    this.source?.close();
    const source = new EventSource('/api/remote/events');
    this.source = source;
    const live = () => this.source === source;
    source.addEventListener('snapshot', event => {
      if (!live()) return;
      try {
        const state = JSON.parse((event as MessageEvent<string>).data) as AppState;
        this.emit({ type: 'state', state, resetTerminal: true });
        this.retries = 0;
        this.update({ phase: 'connected', message: undefined });
      } catch { this.scheduleReconnect('状态同步失败，正在重新连接。'); }
    });
    source.addEventListener('app', event => {
      if (!live()) return;
      try { this.emit(JSON.parse((event as MessageEvent<string>).data) as AppEvent); }
      catch { this.scheduleReconnect('状态同步失败，正在重新连接。'); }
    });
    source.addEventListener('session', event => {
      if (!live()) return;
      try { this.applySession(JSON.parse((event as MessageEvent<string>).data) as RemoteSessionInfo); }
      catch { this.scheduleReconnect('控制状态同步失败，正在重新连接。'); }
    });
    source.onerror = () => {
      if (live()) this.scheduleReconnect('与 PC 的连接已中断，正在重新连接。');
    };
  }

  private scheduleReconnect(message: string) {
    this.stopConnection();
    this.update({ phase: 'reconnecting', message });
    this.retryTimer = setTimeout(() => { void this.connect(); }, Math.min(15000, 800 * 2 ** Math.min(this.retries++, 5)));
  }

  private requireControl() {
    if (this.status.phase !== 'connected') throw new Error('手机尚未连接 PC，输入未发送。');
    if (this.status.owner.id !== this.status.deviceId) throw new Error(`${this.status.owner.name} 正在控制，请先接管控制权。`);
  }

  private terminalContext(): RemoteTerminalContext {
    const connection = this.snapshot?.connection;
    if (connection?.phase !== 'connected' || !connection.activeNodeId || !connection.activeSessionId) throw new Error('终端尚未连接。');
    return { nodeId: connection.activeNodeId, sessionId: connection.activeSessionId, ...(this.snapshot?.terminalGeneration === undefined ? {} : { generation: this.snapshot.terminalGeneration }) };
  }

  private async rpc<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.writeMethods.has(method)) this.requireControl();
    return this.request<T>('/rpc', { method, args }, method === 'getState' ? 30000 : 180000);
  }

  private async getState(): Promise<AppState> {
    const revision = this.revision;
    const state = await this.rpc<AppState>('getState');
    if (revision === this.revision || !this.snapshot) {
      if (this.snapshot && this.terminalKey(this.snapshot) !== this.terminalKey(state)) this.inputGeneration += 1;
      this.snapshot = state;
    }
    return structuredClone(this.snapshot);
  }

  readonly claim = async () => {
    if (this.status.phase !== 'connected') throw new Error('请等待手机连接 PC 后再接管控制权。');
    const generation = this.generation, revision = this.sessionRevision;
    const session = await this.request<RemoteSessionInfo>('/control', { action: 'claim' });
    if (generation === this.generation && revision === this.sessionRevision) this.applySession(session);
  };

  readonly release = async () => {
    if (this.status.phase !== 'connected') throw new Error('请等待手机连接 PC 后再交回控制权。');
    const generation = this.generation, revision = this.sessionRevision;
    const session = await this.request<RemoteSessionInfo>('/control', { action: 'release' });
    if (generation === this.generation && revision === this.sessionRevision) this.applySession(session);
  };

  readonly logout = async () => {
    const generation = this.generation;
    await this.request('/logout', {});
    if (generation !== this.generation) return;
    this.unauthorized();
    this.update({ phase: 'unpaired', message: undefined });
  };

  readonly writeTerminal = (data: string): Promise<void> => {
    this.requireControl();
    const context = this.terminalContext();
    const terminalKey = this.terminalKey(this.snapshot!);
    if (data.length > 65536 || this.queuedBytes + data.length > 131072) return Promise.reject(new Error('待发送内容过多，请稍候再试。'));
    const generation = this.inputGeneration;
    this.queuedBytes += data.length;
    const operation = this.inputTail.then(async () => {
      if (generation !== this.inputGeneration) throw new Error('连接或控制权已变更，输入未发送。');
      this.requireControl();
      if (!this.snapshot || this.terminalKey(this.snapshot) !== terminalKey) throw new Error('会话已切换，输入未发送。');
      await this.request('/terminal', { data, ...context });
    }).finally(() => { this.queuedBytes -= data.length; });
    this.inputTail = operation.catch(() => { this.inputGeneration += 1; });
    return operation;
  };

  private async resizeTerminal(cols: number, rows: number): Promise<void> {
    if (this.status.phase !== 'connected' || this.status.owner.id !== this.status.deviceId) return;
    const context = this.terminalContext();
    await this.request('/resize', { cols, rows, ...context });
  }

  private async pasteClipboard(request: TerminalPasteRequest): Promise<TerminalPasteResult> {
    if (!navigator.clipboard?.readText) throw new Error('请长按下方输入框粘贴文字，或使用图片按钮上传图片。');
    this.requireControl();
    const generation = this.inputGeneration;
    const text = await navigator.clipboard.readText();
    if (generation !== this.inputGeneration) throw new Error('连接、会话或控制权已变更，请重新粘贴。');
    const context = this.terminalContext();
    if (request.nodeId !== context.nodeId || request.sessionId !== context.sessionId) throw new Error('会话已切换，请重新粘贴。');
    if (!text) return { kind: 'empty' };
    await this.writeTerminal(terminalPaste(text, request.bracketedPaste));
    return { kind: 'text' };
  }

  readonly uploadImage = async (file: File, bracketedPaste = false): Promise<void> => {
    this.requireControl();
    const generation = this.inputGeneration;
    const context = this.terminalContext();
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) && !(file.type === '' && /\.(png|jpe?g|webp)$/i.test(file.name))) throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
    if (file.size > 20 * 1024 * 1024) throw new Error('图片超过 20 MiB，请缩小后再上传。');
    const bitmap = await createImageBitmap(file);
    let png: Blob;
    try {
      if (bitmap.width * bitmap.height > 40_000_000) throw new Error('图片尺寸过大，请缩小后再上传。');
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const drawing = canvas.getContext('2d');
      if (!drawing) throw new Error('图片处理失败，请重新选择。');
      drawing.drawImage(bitmap, 0, 0);
      png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片处理失败。')), 'image/png'));
    } finally { bitmap.close(); }
    if (png.size > 20 * 1024 * 1024) throw new Error('图片转换后超过 20 MiB，请缩小后再上传。');
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('图片读取失败。'));
      reader.readAsDataURL(png);
    });
    if (generation !== this.inputGeneration || !this.snapshot || this.contextKey(this.snapshot) !== `${context.nodeId}/${context.sessionId}`) throw new Error('连接、会话或控制权已变更，图片未发送。');
    await this.rpc('pasteImage', { ...context, bracketedPaste }, base64);
  };

  dispose() {
    this.stopConnection();
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.reconnect);
    this.started = false;
  }
}

export const remoteClient = new RemoteClient();
