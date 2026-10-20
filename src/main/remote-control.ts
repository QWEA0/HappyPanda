import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { isIP, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { MAX_CLIPBOARD_IMAGE_BYTES, validateClipboardPng } from './clipboard';
import type { AppEvent, AppState } from '../shared/types';
import {
  DESKTOP_OWNER, REMOTE_RPC_READ_METHODS, REMOTE_RPC_WRITE_METHODS,
  type RemoteControlState, type RemoteOwner, type RemotePairing, type RemoteSessionInfo, type RemoteTerminalContext,
} from '../shared/remote';

export interface RemoteControlServerOptions {
  dataDir: string;
  rendererDir: string;
  getState: () => AppState;
  invoke: (method: string, args: unknown[]) => unknown | Promise<unknown>;
  writeTerminal: (data: string, context: RemoteTerminalContext) => unknown | Promise<unknown>;
  resizeTerminal: (cols: number, rows: number, context: RemoteTerminalContext) => unknown | Promise<unknown>;
  onState: (state: RemoteControlState) => void;
  host?: string;
  port?: number;
}

const DEFAULT_PORT = 41739;
const BODY_LIMIT = 256 * 1024;
const IMAGE_BODY_LIMIT = 28 * 1024 * 1024;
const COOKIE_AGE_SECONDS = 30 * 24 * 60 * 60;
const PAIRING_LIFETIME = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL = 15000;
const STREAM_BUFFER_LIMIT = 2 * 1024 * 1024;
const MAX_DEVICES = 64;
const hash = (value: string): Buffer => createHash('sha256').update(value).digest();
const equal = (a: string, b: string): boolean => timingSafeEqual(hash(a), hash(b));
const clean = (max: number) => z.string().min(1).max(max).regex(/^[^\x00-\x1f\x7f]+$/);
const id = clean(256).regex(/^\S+$/);
const path = clean(32768);
const port = z.number().int().min(1).max(65535);
const optionalId = id.nullish().transform(value => value ?? undefined);
const contextSchema = z.strictObject({ nodeId: id, sessionId: id, generation: z.number().int().nonnegative().optional() });
const pasteSchema = contextSchema.extend({ bracketedPaste: z.boolean() });
const timestamp = z.string().datetime();
const deviceSchema = z.strictObject({
  id, name: clean(80), pairedAt: timestamp, lastSeenAt: timestamp, expiresAt: timestamp,
  tokenDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const storedSchema = z.strictObject({
  version: z.literal(1), enabled: z.boolean(), port: port.optional(), devices: z.array(deviceSchema).max(MAX_DEVICES),
});
type StoredDevice = z.infer<typeof deviceSchema>;

// Validate the complete positional signature before any controller call.
const rpcSchemas: Record<string, z.ZodType> = {
  getState: z.tuple([]), listSshAliases: z.tuple([]), listLocalHistory: z.tuple([]),
  saveNode: z.tuple([z.strictObject({
    id: id.optional(), name: clean(128), sshTarget: clean(512), user: clean(128).optional(),
    port: port.optional(), identityFile: path.optional(),
    authType: z.enum(['key', 'password']).optional(), password: z.string().max(1023).regex(/^[^\r\n\0]*$/).optional(),
  })]),
  removeNode: z.tuple([id]),
  saveProvider: z.tuple([z.strictObject({
    id: id.optional(), name: clean(128),
    baseUrl: clean(2048).url().refine(value => /^https?:\/\//i.test(value)),
    authType: z.enum(['auth-token', 'api-key']), token: clean(16384).optional(), model: clean(256).optional(),
    disableNonessentialTraffic: z.boolean(),
  })]),
  removeProvider: z.tuple([id]), selectProvider: z.tuple([id, id.nullable()]),
  connect: z.tuple([id, optionalId, optionalId]), disconnect: z.tuple([]),
  reconnect: z.tuple([]), focusSession: z.tuple([id]), closeSession: z.tuple([id]),
  newSession: z.tuple([z.enum(['claude', 'login', 'shell']).nullish().transform(value => value ?? undefined)]),
  removeSession: z.tuple([id]), setLocalAccess: z.tuple([id, z.boolean()]),
  setWorkspaceMode: z.tuple([id, z.enum(['sync', 'mcp-only'])]),
  syncNow: z.tuple([]), pauseSync: z.tuple([]), resolveConflict: z.tuple([path, z.enum(['local', 'remote'])]),
  importHistory: z.tuple([z.strictObject({ workspaceId: id, sessionPaths: z.array(path).min(1).max(1000) })]),
  resumeImported: z.tuple([id, path]), importProjectMemory: z.tuple([id]),
  addPortForward: z.tuple([port, z.number().int().min(1024).max(65535).nullish().transform(value => value ?? undefined)]),
  removePortForward: z.tuple([id]),
  pasteImage: z.tuple([pasteSchema, z.string().min(44).max(Math.ceil(MAX_CLIPBOARD_IMAGE_BYTES / 3) * 4)]),
};
const readMethods = new Set<string>(REMOTE_RPC_READ_METHODS);
const writeMethods = new Set<string>(REMOTE_RPC_WRITE_METHODS);
const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
interface EventStream {
  deviceId: string;
  response: ServerResponse;
  drainTimer?: ReturnType<typeof setTimeout>;
}
interface RateWindow { since: number; count: number }
const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const contained = (root: string, target: string): boolean => {
  const child = relative(root, target);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('..\\') && !child.startsWith('../'));
};
const hostName = (address: string): string => new URL(`http://${isIP(address) === 6 ? `[${address}]` : address}`).hostname;

export class RemoteControlServer {
  private readonly devices = new Map<string, StoredDevice>();
  private readonly streams = new Set<EventStream>();
  private readonly sockets = new Set<Socket>();
  private readonly pairAttempts = new Map<string, RateWindow>();
  private aggregateAttempts: RateWindow = { since: 0, count: 0 };
  private owner: RemoteOwner = { ...DESKTOP_OWNER };
  private controlEpoch = 0;
  private pairing?: RemotePairing;
  private pairingTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private initialization?: Promise<void>;
  private disposal?: Promise<void>;
  private operations: Promise<unknown> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private http?: Server;
  private enabled = false;
  private configuredEnabled = false;
  private assignedPort?: number;
  private error?: string;
  private closed = false;
  private settingsValid = true;
  private stopping = false;
  private generation = 0;
  private terminalEpoch = 0;
  private terminalSignature?: string;

  constructor(private readonly options: RemoteControlServerOptions) {
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new Error('远控端口无效。');
  }

  initialize(): Promise<void> {
    this.initialization ??= this.exclusive(async () => {
      try {
        const stored = storedSchema.parse(JSON.parse(await readFile(join(this.options.dataDir, 'remote-control.json'), 'utf8')));
        if (new Set(stored.devices.map(device => device.id)).size !== stored.devices.length || new Set(stored.devices.map(device => device.tokenDigest)).size !== stored.devices.length) throw new Error('Duplicate enrolled devices.');
        this.configuredEnabled = stored.enabled;
        this.assignedPort = stored.port;
        for (const device of stored.devices) this.devices.set(device.id, device);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.settingsValid = false;
          this.error = '无法读取远控设置，请检查本机配置文件。';
          this.notify();
          return;
        }
      }
      if (this.configuredEnabled && !this.closed) {
        try { await this.start(); await this.save(); }
        catch (error) { await this.stop(); this.error = this.message(error); }
      }
      this.notify();
    });
    return this.initialization;
  }

  snapshot(): RemoteControlState {
    const now = Date.now();
    return {
      enabled: this.enabled,
      ...(this.assignedPort === undefined ? {} : { port: this.assignedPort }),
      addresses: this.enabled ? this.addresses() : [],
      ...(this.pairing && Date.parse(this.pairing.expiresAt) > now ? { pairing: { ...this.pairing } } : {}),
      devices: [...this.devices.values()].map(({ id, name, pairedAt, lastSeenAt }) => ({
        id, name, pairedAt, lastSeenAt, connected: [...this.streams].some(stream => stream.deviceId === id),
      })),
      owner: { ...this.owner },
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async setEnabled(enabled: boolean): Promise<RemoteControlState> {
    if (typeof enabled !== 'boolean') throw new Error('远控设置无效。');
    await this.initialize();
    return this.exclusive(async () => {
      this.assertOpen();
      this.error = undefined;
      try {
        if (enabled) {
          await this.start();
          this.configuredEnabled = true;
          await this.save();
        } else {
          this.configuredEnabled = false;
          await this.stop();
          await this.save();
        }
      } catch (error) {
        this.error = this.message(error);
        if (enabled) { this.configuredEnabled = false; await this.stop(); }
        throw new Error(this.error);
      } finally { this.notify(); }
      return this.snapshot();
    });
  }

  async createPairing(): Promise<RemoteControlState> {
    await this.initialize();
    return this.exclusive(async () => {
      this.assertOpen();
      if (!this.enabled) throw new Error('请先开启手机远控，再配对设备。');
      this.clearPairing();
      this.pairing = {
        code: randomInt(100000000).toString().padStart(8, '0'), token: randomBytes(32).toString('base64url'),
        expiresAt: new Date(Date.now() + PAIRING_LIFETIME).toISOString(),
      };
      this.pairingTimer = setTimeout(() => { this.clearPairing(); this.notify(); }, PAIRING_LIFETIME);
      this.pairingTimer.unref();
      this.notify();
      return this.snapshot();
    });
  }

  async revokeDevice(deviceId: string): Promise<RemoteControlState> {
    if (!id.safeParse(deviceId).success) throw new Error('设备标识无效。');
    await this.initialize();
    return this.exclusive(async () => {
      this.assertOpen();
      try { await this.revoke(deviceId); }
      catch (error) { this.error = this.message(error); this.notify(); throw new Error(this.error); }
      return this.snapshot();
    });
  }

  takeControl(): RemoteControlState {
    this.setOwner(DESKTOP_OWNER);
    this.broadcastSessions();
    this.notify();
    return this.snapshot();
  }

  assertDesktopControl(): void {
    if (!this.isDesktopOwner()) throw new Error(`${this.owner.name} 正在控制电脑，请先在电脑端收回控制权。`);
  }

  isDesktopOwner(): boolean { return this.owner.id === DESKTOP_OWNER.id; }
  getControlEpoch(): number { return this.controlEpoch; }

  private setOwner(owner: RemoteOwner): void {
    this.owner = { ...owner };
    this.controlEpoch++;
  }

  publish(event: AppEvent): void {
    if (event.type === 'state') this.recordTerminalState(event.state);
    if (this.enabled && this.streams.size) this.broadcast(frame('app', event));
  }

  private recordTerminalState(state: AppState): void {
    const { phase, activeNodeId, activeSessionId } = state.connection;
    const reloadToken = state.sessions.find(session => session.id === activeSessionId)?.reloadToken;
    const signature = JSON.stringify([phase, activeNodeId, activeSessionId, reloadToken, state.terminalGeneration]);
    if (signature !== this.terminalSignature) { this.terminalSignature = signature; this.terminalEpoch++; }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.disposal = (async () => {
      await this.initialization;
      await this.exclusive(async () => {
        await this.stop();
        if (this.initialization && this.settingsValid) await this.save();
        this.notify();
      });
      await this.writes;
    })();
    return this.disposal;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operations.catch(() => undefined).then(operation);
    this.operations = pending;
    return pending;
  }

  private assertOpen(): void { if (this.closed) throw new Error('远控服务已关闭。'); }
  private message(error: unknown): string {
    return error instanceof Error && /[\u3400-\u9fff]/.test(error.message) ? error.message : '远控操作失败，请检查连接和本机配置。';
  }
  private notify(): void { this.options.onState(this.snapshot()); }
  private clearPairing(): void {
    if (this.pairingTimer) clearTimeout(this.pairingTimer);
    this.pairingTimer = undefined;
    this.pairing = undefined;
  }

  private async save(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const data = JSON.stringify({ version: 1, enabled: this.configuredEnabled, port: this.assignedPort, devices: [...this.devices.values()] });
    this.writes = this.writes.catch(() => undefined).then(async () => {
      await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
      const target = join(this.options.dataDir, 'remote-control.json');
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
        await rename(temporary, target);
      } finally { await unlink(temporary).catch(() => undefined); }
    });
    await this.writes;
    this.settingsValid = true;
  }

  private touch(device: StoredDevice): void {
    if (Date.now() - Date.parse(device.lastSeenAt) < 60000) return;
    device.lastSeenAt = new Date().toISOString();
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined;
        void this.save().catch(error => { this.error = this.message(error); this.notify(); });
      }, 5000);
      this.saveTimer.unref();
    }
  }

  private localHosts(): Set<string> {
    const hosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    for (const interfaces of Object.values(networkInterfaces())) {
      for (const entry of interfaces ?? []) {
        if (entry.address.includes('%')) continue;
        try { hosts.add(hostName(entry.address)); } catch { /* Browsers do not support scoped IPv6 URLs. */ }
      }
    }
    return hosts;
  }

  private addresses(): string[] {
    const bind = this.options.host ?? '0.0.0.0';
    const hosts = bind === '0.0.0.0' ? [...this.localHosts()].filter(value => !value.includes(':') && value !== 'localhost')
      : bind === '::' ? [...this.localHosts()].filter(value => value !== 'localhost') : [hostName(bind)];
    const rank = (host: string) => {
      if (host === '127.0.0.1' || host === '[::1]' || host === 'localhost') return 50;
      if (/^(198\.(18|19)\.|169\.254\.)/.test(host) || /^\[fe[89ab]/i.test(host)) return 40;
      const privateAddress = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || /^\[f[cd]/i.test(host);
      let virtual = false;
      for (const [name, entries] of Object.entries(networkInterfaces())) {
        if (!entries?.some(entry => !entry.address.includes('%') && hostName(entry.address) === host)) continue;
        if (/tun|tap|clash|mihomo|wintun/i.test(name)) return 40;
        if (/virtual|vethernet|hyper-v|vmware|vbox|docker|wsl|vpn|tailscale/i.test(name)) virtual = true;
      }
      return privateAddress ? virtual ? 10 : 0 : virtual ? 30 : 20;
    };
    return [...new Set(hosts)].sort((a, b) => rank(a) - rank(b)).map(host => `http://${host}:${this.assignedPort}/remote/`);
  }

  private async start(): Promise<void> {
    if (this.enabled) return;
    this.assertOpen();
    const renderer = await realpath(this.options.rendererDir);
    const index = await realpath(join(renderer, 'index.html'));
    if (!contained(renderer, index)) throw new Error('远控页面不在应用资源目录内。');
    const indexFile = await open(index, 'r');
    try { if (!(await indexFile.stat()).isFile()) throw new Error('远控页面不可用，请先构建应用。'); }
    finally { await indexFile.close(); }
    this.recordTerminalState(this.options.getState());
    const server = createServer((request, response) => {
      const generation = this.generation, epoch = this.terminalEpoch;
      void this.handle(request, response, generation, epoch).catch(error => {
        request.resume();
        if (error instanceof HttpError && error.status === 413 && !response.headersSent) response.setHeader('Connection', 'close');
        this.reply(response, error instanceof HttpError ? error.status : 500, { error: this.message(error) });
      });
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    server.keepAliveTimeout = 5000;
    server.maxHeadersCount = 64;
    server.on('connection', socket => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      if (this.sockets.size > 128) socket.destroy();
    });
    const listen = (port: number) => new Promise<void>((done, reject) => {
      const onError = (error: Error) => { server.removeListener('listening', onListen); reject(error); };
      const onListen = () => { server.removeListener('error', onError); done(); };
      server.once('error', onError);
      server.once('listening', onListen);
      server.listen(port, this.options.host ?? '0.0.0.0');
    });
    try { await listen(this.assignedPort ?? this.options.port ?? DEFAULT_PORT); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      await listen(0);
    }
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); throw new Error('远控服务未获取到监听地址。'); }
    this.assignedPort = address.port;
    this.http = server;
    this.enabled = true;
    this.generation++;
    server.on('error', error => { this.error = this.message(error); this.notify(); });
    this.heartbeat = setInterval(() => {
      for (const stream of this.streams) {
        const device = this.devices.get(stream.deviceId);
        if (!device || Date.parse(device.expiresAt) <= Date.now()) { this.closeStream(stream); continue; }
        this.touch(device);
        this.send(stream, ': heartbeat\n\n');
      }
    }, HEARTBEAT_INTERVAL);
    this.heartbeat.unref();
  }

  private async stop(): Promise<void> {
    this.stopping = true;
    this.enabled = false;
    this.generation++;
    this.clearPairing();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.setOwner(DESKTOP_OWNER);
    this.broadcastSessions();
    for (const stream of [...this.streams]) this.closeStream(stream);
    const server = this.http;
    this.http = undefined;
    const stopped = server ? new Promise<void>(done => server.close(() => done())) : Promise.resolve();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await stopped;
    this.stopping = false;
  }

  private validateOrigin(request: IncomingMessage): void {
    const count = (name: string) => request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === name).length;
    const authority = request.headers.host;
    if (count('host') !== 1 || !authority || authority.length > 256 || /[\s\\/@?#%,]/.test(authority)) throw new HttpError(403, '请求的主机地址不受信任。');
    let url: URL;
    try { url = new URL(`http://${authority}`); } catch { throw new HttpError(403, '请求的主机地址不受信任。'); }
    if (!this.localHosts().has(url.hostname) || Number(url.port || 80) !== this.assignedPort) throw new HttpError(403, '请求的主机地址不受信任。');
    const origin = request.headers.origin;
    if (count('origin') > 1 || (origin !== undefined && origin !== url.origin)) throw new HttpError(403, '请从当前电脑的远控页面发起请求。');
    if (request.method !== 'GET' && request.method !== 'HEAD' && origin === undefined) throw new HttpError(403, '请求缺少同源校验信息。');
    if (request.url?.startsWith('/api/remote') && request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))) throw new HttpError(403, '不允许跨站访问远控接口。');
  }

  private active(generation: number): void {
    if (!this.enabled || generation !== this.generation || this.closed) throw new HttpError(503, '手机远控已关闭。');
  }

  private authenticate(request: IncomingMessage): StoredDevice {
    const cookies = (request.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.split('=', 1)[0] === 'hp_remote');
    const token = cookies.length === 1 ? cookies[0].slice('hp_remote='.length) : '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(401, '请先在电脑端配对此设备。');
    const digest = hash(token);
    const device = [...this.devices.values()].find(device => timingSafeEqual(digest, Buffer.from(device.tokenDigest, 'hex')));
    if (!device || Date.parse(device.expiresAt) <= Date.now()) throw new HttpError(401, '设备授权已到期或已被撤销，请重新配对。');
    this.touch(device);
    return device;
  }

  private assertOwner(device: StoredDevice): void {
    if (this.owner.id !== device.id) throw new HttpError(409, `${this.owner.name} 正在控制电脑，请先接管控制权。`);
  }

  private assertTerminal(context: RemoteTerminalContext, epoch: number): void {
    const state = this.options.getState(), connection = state.connection;
    if (epoch !== this.terminalEpoch || connection.phase !== 'connected' || connection.activeNodeId !== context.nodeId || connection.activeSessionId !== context.sessionId
      || (state.terminalGeneration !== undefined && context.generation !== state.terminalGeneration)
      || !state.nodes.some(node => node.id === context.nodeId) || !state.sessions.some(session => session.id === context.sessionId && session.nodeId === context.nodeId)) {
      throw new HttpError(409, '终端连接或会话已变更，请在当前会话重新操作。');
    }
  }

  private session(device: StoredDevice): RemoteSessionInfo {
    return { deviceId: device.id, deviceName: device.name, owner: { ...this.owner } };
  }

  private rateLimit(request: IncomingMessage): void {
    const now = Date.now(), ip = request.socket.remoteAddress ?? 'unknown';
    for (const [address, window] of this.pairAttempts) if (now - window.since >= 60000) this.pairAttempts.delete(address);
    if (now - this.aggregateAttempts.since >= 60000) this.aggregateAttempts = { since: now, count: 0 };
    const local = this.pairAttempts.get(ip) ?? { since: now, count: 0 };
    if (local.count >= 10 || this.aggregateAttempts.count >= 60) throw new HttpError(429, '配对尝试过于频繁，请一分钟后重试。');
    this.pairAttempts.set(ip, local);
    local.count++;
    this.aggregateAttempts.count++;
  }

  private async pair(request: IncomingMessage, response: ServerResponse, generation: number): Promise<void> {
    this.rateLimit(request);
    const { value } = await this.body(request, BODY_LIMIT);
    const parsed = z.strictObject({ code: z.string().regex(/^\d{8}$/).optional(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(), name: clean(80).trim().min(1) })
      .refine(value => (value.code !== undefined) !== (value.token !== undefined)).safeParse(value);
    if (!parsed.success) throw new HttpError(400, '请提供设备名称，以及配对码或扫码凭据中的一种。');
    await this.exclusive(async () => {
      this.active(generation);
      const pairing = this.pairing;
      if (!pairing || Date.parse(pairing.expiresAt) <= Date.now() || !equal(parsed.data.code ?? parsed.data.token!, parsed.data.code !== undefined ? pairing.code : pairing.token)) throw new HttpError(401, '配对码无效、已过期或已使用。');
      if (this.devices.size >= MAX_DEVICES) throw new HttpError(409, '配对设备数量已达上限，请先移除不再使用的设备。');
      this.clearPairing();
      const token = randomBytes(32).toString('base64url'), now = new Date().toISOString();
      const device: StoredDevice = { id: randomUUID(), name: parsed.data.name, tokenDigest: hash(token).toString('hex'), pairedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + COOKIE_AGE_SECONDS * 1000).toISOString() };
      this.devices.set(device.id, device);
      try { await this.save(); }
      catch (error) { this.devices.delete(device.id); this.notify(); throw error; }
      response.setHeader('Set-Cookie', this.cookie(token));
      this.notify();
      this.reply(response, 200, { result: this.session(device) });
    });
  }

  private cookie(token: string): string {
    return `hp_remote=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? COOKIE_AGE_SECONDS : 0}`;
  }

  private async revoke(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) return;
    this.devices.delete(deviceId);
    // Revoke in memory before awaiting disk so in-flight bodies cannot act.
    if (this.owner.id === deviceId) this.setOwner(DESKTOP_OWNER);
    for (const stream of [...this.streams]) if (stream.deviceId === deviceId) this.closeStream(stream);
    this.broadcastSessions();
    this.notify();
    await this.save();
  }

  private async handle(request: IncomingMessage, response: ServerResponse, generation: number, epoch: number): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    this.active(generation);
    this.validateOrigin(request);
    const rawPath = request.url?.split('?', 1)[0] ?? '';
    if (!rawPath.startsWith('/') || rawPath.startsWith('//')) throw new HttpError(400, '请求路径无效。');
    if (rawPath === '/remote' || rawPath.startsWith('/remote/')) { await this.staticFile(rawPath, request, response, generation); return; }
    const methods: Record<string, string> = {
      '/api/remote/pair': 'POST', '/api/remote/session': 'GET', '/api/remote/logout': 'POST',
      '/api/remote/control': 'POST', '/api/remote/rpc': 'POST', '/api/remote/terminal': 'POST',
      '/api/remote/resize': 'POST', '/api/remote/events': 'GET',
    };
    if (!Object.hasOwn(methods, rawPath)) throw new HttpError(404, '远控接口不存在。');
    if (request.method !== methods[rawPath]) { response.setHeader('Allow', methods[rawPath]); throw new HttpError(405, '此接口不支持当前请求方法。'); }
    if (rawPath === '/api/remote/pair') { await this.pair(request, response, generation); return; }
    let device = this.authenticate(request);
    if (rawPath === '/api/remote/session') { this.reply(response, 200, { result: this.session(device) }); return; }
    if (rawPath === '/api/remote/events') { this.openEvents(device, response); return; }
    const controlEpoch = this.controlEpoch;
    const { value, bytes } = await this.body(request, rawPath === '/api/remote/rpc' && this.owner.id === device.id ? IMAGE_BODY_LIMIT : BODY_LIMIT);
    this.active(generation);
    device = this.authenticate(request);
    if (rawPath === '/api/remote/logout') {
      if (!z.strictObject({}).safeParse(value).success) throw new HttpError(400, '退出请求无效。');
      await this.exclusive(async () => { this.active(generation); await this.revoke(device.id); });
      response.setHeader('Set-Cookie', this.cookie(''));
      this.reply(response, 200, { result: null });
      return;
    }
    if (rawPath === '/api/remote/control') {
      if (controlEpoch !== this.controlEpoch) throw new HttpError(409, '控制权已变更，请重新操作。');
      const parsed = z.strictObject({ action: z.enum(['claim', 'release']) }).safeParse(value);
      if (!parsed.success) throw new HttpError(400, '控制权操作无效。');
      if (parsed.data.action === 'claim') {
        if (!this.isDesktopOwner() && this.owner.id !== device.id) throw new HttpError(409, `${this.owner.name} 正在控制电脑，请先释放控制权。`);
        this.setOwner({ id: device.id, name: device.name });
      } else { this.assertOwner(device); this.setOwner(DESKTOP_OWNER); }
      this.broadcastSessions();
      this.notify();
      this.reply(response, 200, { result: this.session(device) });
      return;
    }
    if (rawPath === '/api/remote/rpc') {
      const parsed = z.strictObject({ method: z.string().min(1).max(64), args: z.array(z.unknown()).max(8) }).safeParse(value);
      if (!parsed.success) throw new HttpError(400, '远控请求无效。');
      const { method, args } = parsed.data;
      if (bytes > BODY_LIMIT && method !== 'pasteImage') throw new HttpError(413, '普通请求不能超过 256 KiB。');
      if (!readMethods.has(method) && !writeMethods.has(method)) throw new HttpError(403, '此操作不支持手机远控。');
      if (writeMethods.has(method)) {
        this.assertOwner(device);
        if (controlEpoch !== this.controlEpoch) throw new HttpError(409, '控制权已变更，操作未执行。');
      }
      const validated = rpcSchemas[method]?.safeParse(args);
      if (!validated?.success) throw new HttpError(400, '远控操作参数无效。');
      const arguments_ = validated.data as unknown[];
      if (method === 'pasteImage') {
        const encoded = arguments_[1] as string;
        if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new HttpError(400, '请上传 Base64 编码的 PNG 图片。');
        const png = Buffer.from(encoded, 'base64');
        try { validateClipboardPng(png); } catch (error) { throw new HttpError(400, this.message(error)); }
        this.assertTerminal(arguments_[0] as RemoteTerminalContext, epoch);
      }
      const result = await this.options.invoke(method, arguments_);
      this.reply(response, 200, { result: result ?? null });
      return;
    }
    this.assertOwner(device);
    if (controlEpoch !== this.controlEpoch) throw new HttpError(409, '控制权已变更，输入未发送。');
    if (rawPath === '/api/remote/terminal') {
      const parsed = contextSchema.extend({ data: z.string().min(1).max(BODY_LIMIT) }).safeParse(value);
      if (!parsed.success) throw new HttpError(400, '终端输入参数无效。');
      const { data, ...context } = parsed.data;
      this.assertTerminal(context, epoch);
      await this.options.writeTerminal(data, context);
    } else {
      const parsed = contextSchema.extend({ cols: z.number().int().min(10).max(500), rows: z.number().int().min(3).max(300) }).safeParse(value);
      if (!parsed.success) throw new HttpError(400, '终端尺寸无效，列数需为 10 至 500，行数需为 3 至 300。');
      const { cols, rows, ...context } = parsed.data;
      this.assertTerminal(context, epoch);
      await this.options.resizeTerminal(cols, rows, context);
    }
    this.reply(response, 200, { result: null });
  }

  private async body(request: IncomingMessage, limit: number): Promise<{ value: unknown; bytes: number }> {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, '请求必须使用 JSON 格式。');
    if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new HttpError(415, '不支持压缩请求内容。');
    if (Number(request.headers['content-length']) > limit) throw new HttpError(413, '请求内容超出大小限制。');
    const data = await new Promise<Buffer>((done, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const cleanup = () => { clearTimeout(timer); request.removeListener('data', onData); request.removeListener('end', onEnd); request.removeListener('aborted', onAbort); request.removeListener('error', onAbort); };
      const fail = (error: HttpError) => { cleanup(); request.resume(); reject(error); };
      const onData = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limit) fail(new HttpError(413, '请求内容超出大小限制。'));
        else chunks.push(chunk);
      };
      const onEnd = () => { cleanup(); done(Buffer.concat(chunks, bytes)); };
      const onAbort = () => fail(new HttpError(400, '请求内容不完整，请重试。'));
      const timer = setTimeout(() => fail(new HttpError(408, '接收请求超时，请重试。')), 30000);
      timer.unref();
      request.on('data', onData);
      request.once('end', onEnd);
      request.once('aborted', onAbort);
      request.once('error', onAbort);
    });
    try { return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)), bytes: data.length }; }
    catch { throw new HttpError(400, '请求内容不是有效的 JSON。'); }
  }

  private reply(response: ServerResponse, status: number, value: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) { response.destroy(); return; }
    const json = JSON.stringify(value);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(json);
  }

  private openEvents(device: StoredDevice, response: ServerResponse): void {
    if (this.streams.size >= 64 || [...this.streams].filter(stream => stream.deviceId === device.id).length >= 8) throw new HttpError(429, '远控页面数量过多，请关闭多余标签页。');
    // Capture and write both initial events before onState can publish updates.
    const initial = frame('snapshot', this.options.getState()) + frame('session', this.session(device));
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
    const stream: EventStream = { deviceId: device.id, response };
    response.on('error', () => this.closeStream(stream));
    response.once('close', () => this.closeStream(stream));
    response.on('drain', () => { if (stream.drainTimer) clearTimeout(stream.drainTimer); stream.drainTimer = undefined; });
    this.streams.add(stream);
    this.send(stream, initial);
    this.notify();
  }

  private send(stream: EventStream, data: string): void {
    if (stream.response.destroyed || stream.response.writableLength + Buffer.byteLength(data) > STREAM_BUFFER_LIMIT) { this.closeStream(stream); return; }
    if (!stream.response.write(data) && !stream.drainTimer) {
      stream.drainTimer = setTimeout(() => this.closeStream(stream), HEARTBEAT_INTERVAL);
      stream.drainTimer.unref();
    }
  }

  private closeStream(stream: EventStream): void {
    if (!this.streams.delete(stream)) return;
    if (stream.drainTimer) clearTimeout(stream.drainTimer);
    stream.response.destroy();
    if (this.stopping) return;
    if (this.owner.id === stream.deviceId && ![...this.streams].some(other => other.deviceId === stream.deviceId)) {
      this.setOwner(DESKTOP_OWNER);
      this.broadcastSessions();
    }
    this.notify();
  }

  private broadcast(data: string): void { for (const stream of [...this.streams]) this.send(stream, data); }
  private broadcastSessions(): void {
    for (const stream of [...this.streams]) {
      const device = this.devices.get(stream.deviceId);
      if (device) this.send(stream, frame('session', this.session(device)));
    }
  }

  private async staticFile(rawPath: string, request: IncomingMessage, response: ServerResponse, generation: number): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); throw new HttpError(405, '此接口不支持当前请求方法。'); }
    if (rawPath === '/remote') { response.writeHead(308, { Location: '/remote/' }); response.end(); return; }
    let decoded: string;
    try { decoded = decodeURIComponent(rawPath.slice('/remote/'.length)); } catch { throw new HttpError(400, '页面资源路径无效。'); }
    if (/[\x00-\x1f\x7f\\:]/.test(decoded) || /%[a-f0-9]{2}/i.test(decoded) || decoded.split('/').some(part => part.startsWith('.'))) throw new HttpError(403, '禁止访问应用资源目录以外的文件。');
    const root = resolve(this.options.rendererDir), target = resolve(root, decoded || 'index.html');
    if (!contained(root, target)) throw new HttpError(403, '禁止访问应用资源目录以外的文件。');
    let actualRoot: string, actualTarget: string;
    try { actualRoot = await realpath(root); actualTarget = await realpath(target); }
    catch { throw new HttpError(404, '远控页面资源不可用，请先构建应用。'); }
    if (!contained(actualRoot, actualTarget)) throw new HttpError(403, '禁止访问应用资源目录以外的文件。');
    const file = await open(actualTarget, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new HttpError(404, '远控页面资源不可用，请先构建应用。');
      this.active(generation);
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
      response.writeHead(200, { 'Content-Type': mimeTypes[extname(target).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': info.size });
      if (request.method === 'HEAD') { response.end(); await file.close(); return; }
      const source = file.createReadStream();
      source.on('error', () => response.destroy());
      response.once('close', () => source.destroy());
      source.pipe(response);
    } catch (error) { await file.close(); throw error; }
  }
}
