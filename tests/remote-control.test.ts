import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { RemoteControlServer, type RemoteControlServerOptions } from '../src/main/remote-control';
import { DESKTOP_OWNER, REMOTE_RPC_READ_METHODS, REMOTE_RPC_WRITE_METHODS, type RemoteControlState, type RemoteSessionInfo } from '../src/shared/remote';
import { emptySync, type AppEvent, type AppState } from '../src/shared/types';

vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, networkInterfaces: vi.fn(actual.networkInterfaces) };
});
const actualInterfaces = networkInterfaces();

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=', 'base64');
const context = { nodeId: 'node-a', sessionId: 'session-a' };
interface Fixture {
  root: string;
  options: RemoteControlServerOptions;
  server: RemoteControlServer;
  state: AppState;
  url: string;
  invoke: Mock<RemoteControlServerOptions['invoke']>;
  input: Mock<RemoteControlServerOptions['writeTerminal']>;
  resize: Mock<RemoteControlServerOptions['resizeTerminal']>;
  states: RemoteControlState[];
  streams: Stream[];
}
interface Reply { status: number; headers: IncomingHttpHeaders; text: string; json: { result?: any; error?: string } }
interface RequestOptions {
  method?: string;
  cookie?: string;
  body?: unknown;
  raw?: string | Buffer;
  headers?: Record<string, string | undefined>;
  localAddress?: string;
}
interface Stream {
  events: { name: string; data: any }[];
  comments: string[];
  closed: boolean;
  close: () => void;
  pause: () => void;
}
const fixtures: Fixture[] = [];

async function fixture(overrides: Partial<RemoteControlServerOptions> = {}, enabled = true): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'happypanda-remote-'));
  const rendererDir = join(root, 'renderer');
  await mkdir(join(rendererDir, 'assets'), { recursive: true });
  await writeFile(join(rendererDir, 'index.html'), '<!doctype html><script type="module" src="./assets/app.js"></script>');
  await writeFile(join(rendererDir, 'assets', 'app.js'), 'document.title="HappyPanda";');
  const state: AppState = {
    nodes: [{ id: context.nodeId, name: 'PC SSH', sshTarget: 'unused', createdAt: '' }], providers: [], workspaces: [],
    sessions: [{ id: context.sessionId, nodeId: context.nodeId, title: 'Shell', kind: 'shell', tmuxName: 'unused', createdAt: '', lastActiveAt: '' }],
    connection: { phase: 'connected', message: '', retryAttempt: 0, activeNodeId: context.nodeId, activeSessionId: context.sessionId },
    metrics: null, sync: emptySync(), activities: [], terminalBuffer: 'initial terminal\r\n', terminalSize: { cols: 80, rows: 24 }, version: 'test',
  };
  const states: RemoteControlState[] = [];
  const invoke = vi.fn<RemoteControlServerOptions['invoke']>(async (method, args) => method === 'getState' ? structuredClone(state) : { method, args });
  const input = vi.fn<RemoteControlServerOptions['writeTerminal']>(() => undefined);
  const resize = vi.fn<RemoteControlServerOptions['resizeTerminal']>(() => undefined);
  const options: RemoteControlServerOptions = {
    dataDir: join(root, 'data'), rendererDir, host: '127.0.0.1', port: 0,
    getState: () => structuredClone(state), invoke, writeTerminal: input, resizeTerminal: resize,
    onState: state => states.push(state), ...overrides,
  };
  const server = new RemoteControlServer(options);
  const fx: Fixture = { root, options, server, state, url: '', invoke, input, resize, states, streams: [] };
  fixtures.push(fx);
  await server.initialize();
  if (enabled) await server.setEnabled(true);
  fx.url = `http://127.0.0.1:${server.snapshot().port}`;
  return fx;
}

function send(fx: Fixture, path: string, options: RequestOptions = {}): Promise<Reply> {
  const method = options.method ?? (options.body !== undefined || options.raw !== undefined ? 'POST' : 'GET');
  const data = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  const headers: Record<string, string | undefined> = {
    ...(method === 'GET' || method === 'HEAD' ? {} : { Origin: fx.url }),
    ...(options.cookie ? { Cookie: options.cookie } : {}),
    ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) }),
    ...options.headers,
  };
  for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
  return new Promise((done, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: fx.server.snapshot().port, method, path, headers, agent: false, localAddress: options.localAddress }, response => {
      const chunks: Buffer[] = [];
      response.on('error', reject);
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = {};
        try { json = JSON.parse(text); } catch { /* Static assets are not JSON. */ }
        done({ status: response.statusCode!, headers: response.headers, text, json });
      });
    });
    request.on('error', reject);
    request.end(data);
  });
}

async function pair(fx: Fixture, name = 'Android', withToken = false) {
  const pairing = (await fx.server.createPairing()).pairing!;
  const response = await send(fx, '/api/remote/pair', { body: { name, ...(withToken ? { token: pairing.token } : { code: pairing.code }) } });
  expect(response.status).toBe(200);
  const cookieHeader = response.headers['set-cookie']![0];
  return { cookie: cookieHeader.split(';')[0], cookieHeader, info: response.json.result as RemoteSessionInfo, pairing };
}

async function claim(fx: Fixture, cookie: string): Promise<Reply> {
  return send(fx, '/api/remote/control', { cookie, body: { action: 'claim' } });
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Remote HTTP test did not reach the expected state.');
    await delay(5);
  }
}

async function events(fx: Fixture, cookie: string, lastEventId?: string): Promise<Stream> {
  return new Promise((done, reject) => {
    const stream: Stream = { events: [], comments: [], closed: false, close: () => request.destroy(), pause: () => undefined };
    const request = httpRequest({ host: '127.0.0.1', port: fx.server.snapshot().port, path: '/api/remote/events', headers: { Cookie: cookie, ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) }, agent: false }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`SSE status ${response.statusCode}`)); return; }
      let pending = '';
      stream.pause = () => response.pause();
      response.setEncoding('utf8');
      response.on('data', chunk => {
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf('\n\n')) !== -1) {
          const packet = pending.slice(0, end); pending = pending.slice(end + 2);
          if (packet.startsWith(':')) stream.comments.push(packet);
          else {
            const name = packet.split('\n').find(line => line.startsWith('event: '))?.slice(7);
            const data = packet.split('\n').find(line => line.startsWith('data: '))?.slice(6);
            if (name && data) stream.events.push({ name, data: JSON.parse(data) });
          }
        }
        if (stream.events.length >= 2) done(stream);
      });
      response.on('close', () => { stream.closed = true; });
      response.on('error', () => { stream.closed = true; });
    });
    request.on('error', error => { stream.closed = true; reject(error); });
    fx.streams.push(stream);
    request.end();
  });
}

async function delayedBody(fx: Fixture, path: string, cookie: string, body: unknown) {
  const data = JSON.stringify(body);
  let finish!: () => void;
  const reply = new Promise<Reply>((done, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: fx.server.snapshot().port, path, method: 'POST', agent: false,
      headers: { Cookie: cookie, Origin: fx.url, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', data => { text += data; });
      response.on('error', reject);
      response.on('end', () => done({ status: response.statusCode!, headers: response.headers, text, json: JSON.parse(text) }));
    });
    request.on('error', reject);
    request.write(data.slice(0, -1));
    finish = () => request.end(data.slice(-1));
  });
  await delay(15);
  await send(fx, '/api/remote/session', { cookie });
  return { finish, reply };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(networkInterfaces).mockReturnValue(actualInterfaces);
  for (const fx of fixtures.splice(0)) {
    for (const stream of fx.streams) stream.close();
    await fx.server.dispose();
    const target = resolve(fx.root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('happypanda-remote-')) throw new Error('Unsafe test cleanup.');
    await rm(target, { recursive: true, force: true });
  }
});

describe('remote pairing and device credentials', () => {
  it('starts disabled, pairs once by numeric code, and only persists a digest', async () => {
    const fx = await fixture({}, false);
    expect(fx.server.snapshot()).toMatchObject({ enabled: false, devices: [], addresses: [], owner: DESKTOP_OWNER });
    await expect(fx.server.createPairing()).rejects.toThrow();
    await fx.server.setEnabled(true);
    fx.url = `http://127.0.0.1:${fx.server.snapshot().port}`;
    const paired = await pair(fx, 'My Android');
    expect(paired.pairing.code).toMatch(/^\d{8}$/);
    expect(Buffer.from(paired.pairing.token, 'base64url')).toHaveLength(32);
    expect(paired.cookie).toMatch(/^hp_remote=[A-Za-z0-9_-]{43}$/);
    expect(paired.cookieHeader).toContain('HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000');
    expect(paired.info).toEqual({ deviceId: expect.any(String), deviceName: 'My Android', owner: DESKTOP_OWNER });
    expect(fx.server.snapshot().pairing).toBeUndefined();
    expect((await send(fx, '/api/remote/pair', { body: { code: paired.pairing.code, name: 'Replay' } })).status).toBe(401);
    expect((await send(fx, '/api/remote/pair', { body: { token: paired.pairing.token, name: 'Replay' } })).status).toBe(401);
    const session = await send(fx, '/api/remote/session', { cookie: paired.cookie });
    expect(session.json).toEqual({ result: paired.info });
    const stored = await readFile(join(fx.options.dataDir, 'remote-control.json'), 'utf8');
    expect(stored).not.toContain(paired.cookie.slice('hp_remote='.length));
    expect(stored).not.toContain(paired.pairing.token);
    expect(JSON.parse(stored).devices[0]).toMatchObject({ id: paired.info.deviceId, tokenDigest: createHash('sha256').update(paired.cookie.slice('hp_remote='.length)).digest('hex') });
    expect(await readdir(fx.options.dataDir)).toEqual(['remote-control.json']);
    if (process.platform !== 'win32') expect((await stat(join(fx.options.dataDir, 'remote-control.json'))).mode & 0o777).toBe(0o600);
  });

  it('replaces and expires pairing codes, supports QR tokens, and prevents concurrent reuse', async () => {
    const fx = await fixture();
    const old = (await fx.server.createPairing()).pairing!;
    const current = (await fx.server.createPairing()).pairing!;
    expect((await send(fx, '/api/remote/pair', { body: { name: 'old', token: old.token } })).status).toBe(401);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(current.expiresAt));
    expect(fx.server.snapshot().pairing).toBeUndefined();
    expect((await send(fx, '/api/remote/pair', { body: { name: 'expired', code: current.code } })).status).toBe(401);
    clock.mockRestore();
    const pairing = (await fx.server.createPairing()).pairing!;
    const replies = await Promise.all(['one', 'two'].map(name => send(fx, '/api/remote/pair', { body: { name, token: pairing.token } })));
    expect(replies.map(reply => reply.status).sort()).toEqual([200, 401]);
    expect(fx.server.snapshot().devices).toHaveLength(1);
  });

  it('rejects absent, malformed, duplicated and expired cookies without accepting bearer or URL credentials', async () => {
    const fx = await fixture();
    const paired = await pair(fx, 'Android', true);
    for (const cookie of ['', 'hp_remote=wrong', `${paired.cookie}; ${paired.cookie}`]) {
      expect((await send(fx, '/api/remote/session', { cookie })).status).toBe(401);
    }
    expect((await send(fx, `/api/remote/session?token=${paired.cookie.slice(10)}`, { headers: { Authorization: `Bearer ${paired.cookie.slice(10)}` } })).status).toBe(401);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect((await send(fx, '/api/remote/session', { cookie: paired.cookie })).status).toBe(401);
    clock.mockRestore();
    expect(fx.invoke).not.toHaveBeenCalled();
  });

  it('limits pairing attempts using the socket IP even when forwarding headers change', async () => {
    const fx = await fixture();
    await fx.server.createPairing();
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await send(fx, '/api/remote/pair', { body: { code: 'bad', name: 'Android' }, headers: { 'X-Forwarded-For': `192.168.1.${attempt}` } })).status).toBe(400);
    }
    expect((await send(fx, '/api/remote/pair', { body: { code: '00000000', name: 'Android' } })).status).toBe(429);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60001);
    expect((await send(fx, '/api/remote/pair', { body: { code: 'bad', name: 'Android' } })).status).toBe(400);
    clock.mockRestore();
  });

  it('also bounds aggregate guesses across independent client IPs', async () => {
    const fx = await fixture();
    for (let address = 2; address < 8; address++) {
      for (let attempt = 0; attempt < 10; attempt++) {
        expect((await send(fx, '/api/remote/pair', { localAddress: `127.0.0.${address}`, body: { code: 'bad', name: 'Android' } })).status).toBe(400);
      }
    }
    expect((await send(fx, '/api/remote/pair', { localAddress: '127.0.0.8', body: { code: 'bad', name: 'Android' } })).status).toBe(429);
  });

  it('automatically clears expired pairing information from desktop state', async () => {
    const fx = await fixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const created = (await fx.server.createPairing()).pairing!;
    expect(Date.parse(created.expiresAt) - Date.now()).toBe(5 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(fx.server.snapshot().pairing).toBeUndefined();
    expect(fx.states.at(-1)?.pairing).toBeUndefined();
  });
});

describe('same-origin isolation and RPC validation', () => {
  it('checks Origin and local Host explicitly, without CORS or forwarded-host trust', async () => {
    const fx = await fixture({ host: '0.0.0.0' });
    const paired = await pair(fx);
    const badOrigins = ['https://evil.example', 'null', 'http://localhost', `${fx.url}.evil.example`, fx.url.replace('http:', 'https:')];
    for (const Origin of badOrigins) {
      const reply = await send(fx, '/api/remote/session', { cookie: paired.cookie, headers: { Origin } });
      expect(reply.status).toBe(403);
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
      expect(reply.json.error).toMatch(/[\u3400-\u9fff]/);
    }
    for (const Host of [`attacker.example:${fx.server.snapshot().port}`, `127.0.0.1:1`, `127.0.0.1:${fx.server.snapshot().port}@attacker.example`, '192.0.2.12']) {
      expect((await send(fx, '/api/remote/session', { cookie: paired.cookie, headers: { Host, 'X-Forwarded-Host': new URL(fx.url).host } })).status).toBe(403);
    }
    expect((await send(fx, '/api/remote/control', { cookie: paired.cookie, body: { action: 'claim' }, headers: { Origin: undefined } })).status).toBe(403);
    expect((await send(fx, '/api/remote/session', { cookie: paired.cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    expect((await send(fx, '/api/remote/pair', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    const addresses = fx.server.snapshot().addresses;
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.every(address => /^http:\/\/.+:\d+\/remote\/$/.test(address))).toBe(true);
    for (const address of addresses) {
      const url = new URL(address);
      expect((await send(fx, '/api/remote/session', { cookie: paired.cookie, headers: { Host: url.host, Origin: url.origin } })).status).toBe(200);
    }
  });

  it('exposes only shared read methods to spectators and blocks arbitrary methods and invalid arguments', async () => {
    const fx = await fixture();
    const paired = await pair(fx);
    for (const method of REMOTE_RPC_READ_METHODS) {
      expect((await send(fx, '/api/remote/rpc', { cookie: paired.cookie, body: { method, args: [] } })).status).toBe(200);
    }
    expect(fx.invoke).toHaveBeenCalledTimes(REMOTE_RPC_READ_METHODS.length);
    for (const method of ['chooseWorkspace', 'openLocalPath', 'openExternal', 'pasteClipboard', 'writeTerminal', 'constructor', '__proto__', 'dispose', 'remote:setEnabled']) {
      expect((await send(fx, '/api/remote/rpc', { cookie: paired.cookie, body: { method, args: [] } })).status).toBe(403);
    }
    for (const method of REMOTE_RPC_WRITE_METHODS) {
      expect((await send(fx, '/api/remote/rpc', { cookie: paired.cookie, body: { method, args: [] } })).status).toBe(409);
    }
    await claim(fx, paired.cookie);
    const invalid = [
      { method: 'getState', args: [true] }, { method: 'getState' }, { method: 'connect', args: [1] },
      { method: 'getState', args: [], extra: true }, { method: 'setLocalAccess', args: ['workspace', 'true'] },
      { method: 'setWorkspaceMode', args: ['workspace', 'unknown'] },
      { method: 'saveNode', args: [{ name: 'PC', sshTarget: 'host', untrusted: true }] },
      { method: 'saveProvider', args: [{ name: 'Provider', baseUrl: 'file:///secret', authType: 'api-key', disableNonessentialTraffic: true }] },
      { method: 'addPortForward', args: [80, 1] }, { method: 'newSession', args: ['unknown'] },
      { method: 'removeSession', args: ['session', 'unexpected'] }, { method: 'resolveConflict', args: ['path', 'both'] },
      { method: 'importHistory', args: [{ workspaceId: 'w', sessionPaths: [], unwanted: true }] },
    ];
    for (const body of invalid) expect((await send(fx, '/api/remote/rpc', { cookie: paired.cookie, body })).status).toBe(400);
    expect(fx.invoke).toHaveBeenCalledTimes(REMOTE_RPC_READ_METHODS.length);
  });

  it('covers every permitted write signature and normalizes optional JSON nulls', async () => {
    const fx = await fixture();
    const paired = await pair(fx);
    await claim(fx, paired.cookie);
    const signatures: Record<string, unknown[]> = {
      saveNode: [{ name: 'PC', sshTarget: 'my-ssh-alias' }], removeNode: ['node-a'],
      saveProvider: [{ name: 'Provider', baseUrl: 'https://api.example', authType: 'api-key', token: 'test-token', disableNonessentialTraffic: true }],
      removeProvider: ['provider'], selectProvider: ['node-a', null], connect: ['node-a', null, 'session-a'],
      disconnect: [], reconnect: [], focusSession: ['session-b'], closeSession: ['session-b'], newSession: [null], removeSession: ['session-b'], setLocalAccess: ['workspace', true], setWorkspaceMode: ['workspace', 'mcp-only'],
      syncNow: [], pauseSync: [], resolveConflict: ['file.txt', 'local'], importHistory: [{ workspaceId: 'workspace', sessionPaths: ['/local/history.jsonl'] }],
      resumeImported: ['workspace', '/remote/history.jsonl'], importProjectMemory: ['workspace'],
      addPortForward: [8080, null], removePortForward: ['forward'], pasteImage: [{ ...context, bracketedPaste: true }, png.toString('base64')],
    };
    expect(Object.keys(signatures).sort()).toEqual([...REMOTE_RPC_WRITE_METHODS].sort());
    for (const [method, args] of Object.entries(signatures)) {
      const reply = await send(fx, '/api/remote/rpc', { cookie: paired.cookie, body: { method, args } });
      expect(reply.status, `${method}: ${reply.text}`).toBe(200);
    }
    expect(fx.invoke).toHaveBeenCalledWith('connect', ['node-a', undefined, 'session-a']);
    expect(fx.invoke).toHaveBeenCalledWith('newSession', [undefined]);
    expect(fx.invoke).toHaveBeenCalledWith('addPortForward', [8080, undefined]);
    for (const [method, args] of [['connect', ['node-a']], ['newSession', []], ['addPortForward', [8080]]] as const) {
      expect((await send(fx, '/api/remote/rpc', { cookie: paired.cookie, body: { method, args } })).status).toBe(200);
    }
  });

  it('bounds JSON input, validates the PNG exception, and propagates controller failures once', async () => {
    const fx = await fixture();
    const paired = await pair(fx);
    await claim(fx, paired.cookie);
    expect((await send(fx, '/api/remote/rpc', { cookie: paired.cookie, raw: '{' })).status).toBe(400);
    expect((await send(fx, '/api/remote/rpc', { cookie: paired.cookie, raw: '{}', headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect((await send(fx, '/api/remote/rpc', { cookie: paired.cookie, raw: '{}', headers: { 'Content-Encoding': 'gzip' } })).status).toBe(415);
    expect((await send(fx, '/api/remote/rpc', { cookie: paired.cookie, body: { method: 'getState', args: ['x'.repeat(256 * 1024)] } })).status).toBe(413);
    expect((await send(fx, '/api/remote/terminal', { cookie: paired.cookie, body: { ...context, data: 'x'.repeat(256 * 1024) } })).status).toBe(413);
    expect((await send(fx, '/api/remote/terminal', { cookie: paired.cookie, body: { ...context, data: 'x'.repeat(256 * 1024) }, headers: { 'Content-Length': undefined, 'Transfer-Encoding': 'chunked' } })).status).toBe(413);
    const largePng = Buffer.concat([png, Buffer.alloc(300 * 1024)]).toString('base64');
    expect((await send(fx, '/api/remote/rpc', { cookie: paired.cookie, body: { method: 'pasteImage', args: [{ ...context, bracketedPaste: true }, largePng] } })).status).toBe(200);
    expect(fx.invoke).toHaveBeenCalledExactlyOnceWith('pasteImage', [{ ...context, bracketedPaste: true }, largePng]);
    for (const data of ['data:image/png;base64,' + png.toString('base64'), Buffer.alloc(40).toString('base64'), png.toString('base64').slice(0, -1)]) {
      expect((await send(fx, '/api/remote/rpc', { cookie: paired.cookie, body: { method: 'pasteImage', args: [{ ...context, bracketedPaste: true }, data] } })).status).toBe(400);
    }
    expect((await send(fx, '/api/remote/rpc', { cookie: paired.cookie, raw: '{}', headers: { 'Content-Length': String(28 * 1024 * 1024 + 1) } })).status).toBe(413);
    fx.invoke.mockRejectedValueOnce(new Error('同步暂不可用'));
    const error = await send(fx, '/api/remote/rpc', { cookie: paired.cookie, body: { method: 'syncNow', args: [] } });
    expect(error.status).toBe(500);
    expect(error.json).toEqual({ error: '同步暂不可用' });
    expect(fx.invoke).toHaveBeenCalledTimes(2);
  });
});

describe('control ownership and terminal context', () => {
  it('arbitrates devices, permits desktop reclaim, and checks ownership for input and resize', async () => {
    const fx = await fixture();
    const first = await pair(fx, 'First Android'), second = await pair(fx, 'Second Android');
    expect(fx.server.isDesktopOwner()).toBe(true);
    expect(() => fx.server.assertDesktopControl()).not.toThrow();
    expect((await send(fx, '/api/remote/terminal', { cookie: first.cookie, body: { ...context, data: 'before claim' } })).status).toBe(409);
    expect((await claim(fx, first.cookie)).json.result.owner).toEqual({ id: first.info.deviceId, name: 'First Android' });
    expect(fx.server.isDesktopOwner()).toBe(false);
    expect(() => fx.server.assertDesktopControl()).toThrow('收回控制权');
    expect((await claim(fx, second.cookie)).status).toBe(409);
    expect((await send(fx, '/api/remote/control', { cookie: second.cookie, body: { action: 'release' } })).status).toBe(409);
    expect((await send(fx, '/api/remote/terminal', { cookie: first.cookie, body: { ...context, data: '\u4e2d\u6587\r\x03' } })).status).toBe(200);
    expect(fx.input).toHaveBeenCalledExactlyOnceWith('\u4e2d\u6587\r\x03', context);
    expect((await send(fx, '/api/remote/resize', { cookie: first.cookie, body: { ...context, cols: 80, rows: 24 } })).status).toBe(200);
    expect(fx.resize).toHaveBeenCalledExactlyOnceWith(80, 24, context);
    expect((await send(fx, '/api/remote/resize', { cookie: second.cookie, body: { ...context, cols: 90, rows: 30 } })).status).toBe(409);
    expect(fx.server.takeControl().owner).toEqual(DESKTOP_OWNER);
    expect(() => fx.server.assertDesktopControl()).not.toThrow();
    expect((await send(fx, '/api/remote/terminal', { cookie: first.cookie, body: { ...context, data: 'after reclaim' } })).status).toBe(409);
    await claim(fx, second.cookie);
    expect((await send(fx, '/api/remote/control', { cookie: second.cookie, body: { action: 'release' } })).json.result.owner).toEqual(DESKTOP_OWNER);
  });

  it('rejects stale node/session, disconnected terminals, invalid dimensions and unknown fields without replay', async () => {
    const fx = await fixture();
    const paired = await pair(fx);
    await claim(fx, paired.cookie);
    for (const changed of [{ nodeId: 'another' }, { sessionId: 'another' }]) {
      expect((await send(fx, '/api/remote/terminal', { cookie: paired.cookie, body: { ...context, ...changed, data: 'stale' } })).status).toBe(409);
      expect((await send(fx, '/api/remote/resize', { cookie: paired.cookie, body: { ...context, ...changed, cols: 80, rows: 24 } })).status).toBe(409);
    }
    for (const phase of ['disconnected', 'retrying', 'connecting', 'preparing', 'failed'] as const) {
      fx.state.connection.phase = phase;
      expect((await send(fx, '/api/remote/terminal', { cookie: paired.cookie, body: { ...context, data: 'not queued' } })).status).toBe(409);
    }
    fx.state.connection.phase = 'connected';
    for (const dims of [{ cols: 9, rows: 24 }, { cols: 501, rows: 24 }, { cols: 80, rows: 2 }, { cols: 80, rows: 301 }, { cols: 80.5, rows: 24 }]) {
      expect((await send(fx, '/api/remote/resize', { cookie: paired.cookie, body: { ...context, ...dims } })).status).toBe(400);
    }
    expect((await send(fx, '/api/remote/terminal', { cookie: paired.cookie, body: { ...context, data: 'input', extra: true } })).status).toBe(400);
    expect(fx.input).not.toHaveBeenCalled();
    expect(fx.resize).not.toHaveBeenCalled();
    expect((await send(fx, '/api/remote/terminal', { cookie: paired.cookie, body: { ...context, data: 'fresh' } })).status).toBe(200);
    expect(fx.input).toHaveBeenCalledExactlyOnceWith('fresh', context);
  });

  it('rechecks terminal generation, ownership and credentials after receiving delayed bodies', async () => {
    const fx = await fixture();
    const paired = await pair(fx);
    await claim(fx, paired.cookie);
    fx.server.publish({ type: 'state', state: fx.state });
    const reconnect = await delayedBody(fx, '/api/remote/terminal', paired.cookie, { ...context, data: 'before reconnect' });
    fx.state.connection.phase = 'retrying'; fx.server.publish({ type: 'state', state: fx.state });
    fx.state.connection.phase = 'connected'; fx.server.publish({ type: 'state', state: fx.state });
    reconnect.finish();
    expect((await reconnect.reply).status).toBe(409);
    const resize = await delayedBody(fx, '/api/remote/resize', paired.cookie, { ...context, cols: 90, rows: 30 });
    fx.server.takeControl(); resize.finish();
    expect((await resize.reply).status).toBe(409);
    await claim(fx, paired.cookie);
    const revoked = await delayedBody(fx, '/api/remote/rpc', paired.cookie, { method: 'disconnect', args: [] });
    await fx.server.revokeDevice(paired.info.deviceId); revoked.finish();
    expect((await revoked.reply).status).toBe(401);
    expect(fx.input).not.toHaveBeenCalled(); expect(fx.resize).not.toHaveBeenCalled(); expect(fx.invoke).not.toHaveBeenCalled();
  });

  it('does not mistake the first unchanged state publication for a terminal reconnect', async () => {
    const fx = await fixture();
    const paired = await pair(fx);
    await claim(fx, paired.cookie);
    const pending = await delayedBody(fx, '/api/remote/terminal', paired.cookie, { ...context, data: 'current input' });
    fx.server.publish({ type: 'state', state: fx.state });
    pending.finish();
    expect((await pending.reply).status).toBe(200);
    expect(fx.input).toHaveBeenCalledExactlyOnceWith('current input', context);
  });

  it('rejects buffered requests after control leaves and returns to the same device', async () => {
    const fx = await fixture();
    const paired = await pair(fx);
    await claim(fx, paired.cookie);
    const epoch = fx.server.getControlEpoch();
    const input = await delayedBody(fx, '/api/remote/terminal', paired.cookie, { ...context, data: 'old ownership interval' });
    fx.server.takeControl();
    await claim(fx, paired.cookie);
    expect(fx.server.getControlEpoch()).toBeGreaterThan(epoch);
    input.finish();
    expect((await input.reply).status).toBe(409);
    expect(fx.input).not.toHaveBeenCalled();
    const mutation = await delayedBody(fx, '/api/remote/rpc', paired.cookie, { method: 'disconnect', args: [] });
    fx.server.takeControl();
    await claim(fx, paired.cookie);
    mutation.finish();
    expect((await mutation.reply).status).toBe(409);
    expect(fx.invoke).not.toHaveBeenCalled();
  });

  it('rejects old input after an unobserved rebuild of the same terminal session', async () => {
    const fx = await fixture();
    const paired = await pair(fx);
    await claim(fx, paired.cookie);
    fx.state.terminalGeneration = 1;
    const pending = await delayedBody(fx, '/api/remote/terminal', paired.cookie, { ...context, generation: 1, data: 'old terminal' });
    fx.state.terminalGeneration = 3;
    pending.finish();
    expect((await pending.reply).status).toBe(409);
    expect((await send(fx, '/api/remote/terminal', { cookie: paired.cookie, body: { ...context, data: 'missing lifetime' } })).status).toBe(409);
    expect((await send(fx, '/api/remote/terminal', { cookie: paired.cookie, body: { ...context, generation: 3, data: 'new terminal' } })).status).toBe(200);
    expect(fx.input).toHaveBeenCalledExactlyOnceWith('new terminal', { ...context, generation: 3 });
  });
});

describe('ordered SSE events and device connection lifecycle', () => {
  it('starts with an atomic full snapshot and session, then broadcasts ordered app and owner updates without pairing secrets', async () => {
    const fx = await fixture();
    const first = await pair(fx, 'First Android'), second = await pair(fx, 'Second Android');
    const pairing = (await fx.server.createPairing()).pairing!;
    const a = await events(fx, first.cookie), b = await events(fx, second.cookie);
    expect(a.events).toEqual([{ name: 'snapshot', data: fx.state }, { name: 'session', data: first.info }]);
    const updates: AppEvent[] = [{ type: 'terminal', data: 'first\r\n' }, { type: 'terminal-size', cols: 96, rows: 32 }, { type: 'activity', activity: { id: 'activity', time: '', kind: 'tool', title: 'Executed on PC' } }, { type: 'terminal', data: 'second\r\n' }];
    for (const update of updates) fx.server.publish(update);
    await until(() => a.events.length >= 2 + updates.length && b.events.length >= 2 + updates.length);
    expect(a.events.slice(2).map(event => event.data)).toEqual(updates);
    expect(b.events.slice(2).map(event => event.data)).toEqual(updates);
    await claim(fx, first.cookie);
    await until(() => b.events.length >= 3 + updates.length);
    expect(a.events.at(-1)).toMatchObject({ name: 'session', data: { deviceId: first.info.deviceId, owner: { id: first.info.deviceId } } });
    expect(b.events.at(-1)).toMatchObject({ name: 'session', data: { deviceId: second.info.deviceId, owner: { id: first.info.deviceId } } });
    fx.server.takeControl();
    await until(() => b.events.length >= 4 + updates.length);
    expect(b.events.at(-1)?.data.owner).toEqual(DESKTOP_OWNER);
    const delivered = JSON.stringify([...a.events, ...b.events]);
    expect(delivered).not.toContain(pairing.token);
    expect(delivered).not.toContain('"pairing"');
    expect(delivered).not.toContain('tokenDigest');
  });

  it('delivers both initial events before updates triggered by the connected-device notification', async () => {
    const fx = await fixture();
    const paired = await pair(fx);
    let published = false;
    fx.options.onState = state => {
      fx.states.push(state);
      if (!published && state.devices.some(device => device.connected)) {
        published = true;
        fx.server.publish({ type: 'terminal', data: 'published during connection notification' });
      }
    };
    const stream = await events(fx, paired.cookie);
    await until(() => stream.events.length >= 3);
    expect(stream.events.map(event => event.name)).toEqual(['snapshot', 'session', 'app']);
    expect(stream.events[2].data).toEqual({ type: 'terminal', data: 'published during connection notification' });
  });

  it('counts all tabs and sends a fresh snapshot on reconnect instead of replaying stale output', async () => {
    const fx = await fixture();
    const paired = await pair(fx);
    const first = await events(fx, paired.cookie), second = await events(fx, paired.cookie);
    await claim(fx, paired.cookie);
    first.close();
    await until(() => first.closed);
    expect(fx.server.snapshot().devices[0].connected).toBe(true);
    expect(fx.server.snapshot().owner.id).toBe(paired.info.deviceId);
    second.close();
    await until(() => !fx.server.snapshot().devices[0].connected);
    expect(fx.server.snapshot().owner).toEqual(DESKTOP_OWNER);
    fx.state.terminalBuffer = 'current full buffer';
    fx.server.publish({ type: 'terminal', data: 'missed update' });
    const reconnect = await events(fx, paired.cookie, 'stale-cursor');
    expect(reconnect.events[0]).toMatchObject({ name: 'snapshot', data: { terminalBuffer: 'current full buffer' } });
    expect(reconnect.events.map(event => event.name)).toEqual(['snapshot', 'session']);
  });

  it('revokes every stream for the device, resets control, and keeps other devices connected', async () => {
    const fx = await fixture();
    const first = await pair(fx), second = await pair(fx, 'Other Android');
    const a = await events(fx, first.cookie), b = await events(fx, first.cookie), c = await events(fx, second.cookie);
    await claim(fx, first.cookie);
    await fx.server.revokeDevice(first.info.deviceId);
    await until(() => a.closed && b.closed && c.events.at(-1)?.data.owner?.id === 'desktop');
    expect(fx.server.snapshot().devices.map(device => device.id)).toEqual([second.info.deviceId]);
    expect(c.closed).toBe(false);
    expect((await send(fx, '/api/remote/session', { cookie: first.cookie })).status).toBe(401);
    expect((await send(fx, '/api/remote/logout', { cookie: second.cookie, body: {} })).status).toBe(200);
    await until(() => c.closed);
    expect((await send(fx, '/api/remote/session', { cookie: second.cookie })).status).toBe(401);
    expect(fx.server.snapshot().devices).toEqual([]);
  });

  it('sends automatic heartbeats and bounds the number of event streams per device', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fx = await fixture();
    const paired = await pair(fx);
    const stream = await events(fx, paired.cookie);
    await vi.advanceTimersByTimeAsync(15000);
    await until(() => stream.comments.length > 0);
    expect(stream.comments).toContain(': heartbeat');
    for (let tab = 1; tab < 8; tab++) await events(fx, paired.cookie);
    expect((await send(fx, '/api/remote/events', { cookie: paired.cookie })).status).toBe(429);
  });

  it('drops a stalled reader without retaining an unbounded output backlog for that device', async () => {
    const fx = await fixture();
    const slow = await pair(fx, 'Stalled Android'), healthy = await pair(fx, 'Healthy Android');
    const stalled = await events(fx, slow.cookie), active = await events(fx, healthy.cookie);
    stalled.pause();
    const connected = (id: string) => fx.server.snapshot().devices.find(device => device.id === id)?.connected;
    for (let count = 0; count < 256 && connected(slow.info.deviceId); count++) {
      fx.server.publish({ type: 'terminal', data: 'x'.repeat(256 * 1024) });
      await delay(2);
    }
    expect(connected(slow.info.deviceId)).toBe(false);
    expect(connected(healthy.info.deviceId)).toBe(true);
    expect(active.events.filter(event => event.name === 'app').length).toBeGreaterThan(0);
  });
});

describe('persistent settings, shutdown and renderer files', () => {
  it('preserves enrollment and the assigned port while disabling, restarting and automatically restoring', async () => {
    const fx = await fixture();
    const paired = await pair(fx);
    const port = fx.server.snapshot().port;
    const stream = await events(fx, paired.cookie);
    await claim(fx, paired.cookie);
    await fx.server.setEnabled(false);
    await until(() => stream.closed);
    expect(fx.server.snapshot()).toMatchObject({ enabled: false, port, owner: DESKTOP_OWNER, addresses: [], devices: [{ id: paired.info.deviceId, connected: false }] });
    expect(fx.invoke).not.toHaveBeenCalled();
    await expect(send(fx, '/api/remote/session', { cookie: paired.cookie })).rejects.toThrow();
    await fx.server.dispose();
    fx.server = new RemoteControlServer(fx.options);
    await fx.server.initialize();
    expect(fx.server.snapshot().enabled).toBe(false);
    expect(fx.server.snapshot().devices[0].id).toBe(paired.info.deviceId);
    await fx.server.setEnabled(true);
    expect(fx.server.snapshot().port).toBe(port);
    expect((await send(fx, '/api/remote/session', { cookie: paired.cookie })).status).toBe(200);
    await fx.server.createPairing();
    await fx.server.dispose();
    expect(JSON.parse(await readFile(join(fx.options.dataDir, 'remote-control.json'), 'utf8')).enabled).toBe(true);
    fx.server = new RemoteControlServer(fx.options);
    await fx.server.initialize();
    expect(fx.server.snapshot()).toMatchObject({ enabled: true, port, owner: DESKTOP_OWNER });
    expect(fx.server.snapshot().pairing).toBeUndefined();
    expect((await send(fx, '/api/remote/session', { cookie: paired.cookie })).status).toBe(200);
    await fx.server.revokeDevice(paired.info.deviceId);
    await fx.server.dispose();
    fx.server = new RemoteControlServer(fx.options);
    await fx.server.initialize();
    expect((await send(fx, '/api/remote/session', { cookie: paired.cookie })).status).toBe(401);
  });

  it('falls back from an occupied preferred port and remembers the replacement', async () => {
    const blocker = createServer();
    await new Promise<void>(done => blocker.listen(0, '127.0.0.1', done));
    const occupied = (blocker.address() as { port: number }).port;
    try {
      const fx = await fixture({ port: occupied });
      const selected = fx.server.snapshot().port;
      expect(selected).not.toBe(occupied);
      expect(selected).toBeGreaterThan(0);
      await fx.server.dispose();
      fx.server = new RemoteControlServer(fx.options);
      await fx.server.initialize();
      expect(fx.server.snapshot().port).toBe(selected);
      expect(fx.server.snapshot().enabled).toBe(true);
    } finally { await new Promise<void>(done => blocker.close(() => done())); }
  });

  it('reports restore failures as disabled Chinese errors without rejecting PC initialization', async () => {
    const fx = await fixture();
    await fx.server.dispose();
    await rm(join(fx.options.rendererDir, 'index.html'));
    fx.server = new RemoteControlServer(fx.options);
    await expect(fx.server.initialize()).resolves.toBeUndefined();
    expect(fx.server.snapshot()).toMatchObject({ enabled: false, owner: DESKTOP_OWNER, error: expect.stringMatching(/[\u3400-\u9fff]/) });
    expect(fx.states.at(-1)?.enabled).toBe(false);
    await writeFile(join(fx.options.rendererDir, 'index.html'), '<!doctype html>HappyPanda');
    await fx.server.dispose();
    fx.options.host = '192.0.2.123';
    fx.server = new RemoteControlServer(fx.options);
    await expect(fx.server.initialize()).resolves.toBeUndefined();
    expect(fx.server.snapshot()).toMatchObject({ enabled: false, error: expect.stringMatching(/[\u3400-\u9fff]/) });
    expect(fx.invoke).not.toHaveBeenCalled();
  });

  it('preserves a corrupt settings file and avoids per-request credential rewrites', async () => {
    const fx = await fixture();
    const paired = await pair(fx);
    const target = join(fx.options.dataDir, 'remote-control.json');
    const before = await stat(target);
    for (let count = 0; count < 5; count++) await send(fx, '/api/remote/session', { cookie: paired.cookie });
    expect((await stat(target)).mtimeMs).toBe(before.mtimeMs);
    vi.useFakeTimers({ toFake: ['Date'] });
    const seen = new Date(Date.parse(fx.server.snapshot().devices[0].lastSeenAt) + 61000);
    vi.setSystemTime(seen);
    await send(fx, '/api/remote/session', { cookie: paired.cookie });
    expect(fx.server.snapshot().devices[0].lastSeenAt).toBe(seen.toISOString());
    await fx.server.dispose();
    expect(JSON.parse(await readFile(target, 'utf8')).devices[0].lastSeenAt).toBe(seen.toISOString());
    vi.useRealTimers();
    await writeFile(target, '{corrupt');
    fx.server = new RemoteControlServer(fx.options);
    await expect(fx.server.initialize()).resolves.toBeUndefined();
    expect(fx.server.snapshot().error).toBeDefined();
    await fx.server.dispose();
    expect(await readFile(target, 'utf8')).toBe('{corrupt');
  });

  it('serves the unpaired renderer and relative assets, redirects its root, and rejects traversal and junction escapes', async () => {
    const fx = await fixture();
    const redirect = await send(fx, '/remote');
    expect(redirect.status).toBe(308);
    expect(redirect.headers.location).toBe('/remote/');
    const index = await send(fx, '/remote/');
    expect(index.status).toBe(200);
    expect(index.text).toContain('./assets/app.js');
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    const script = await send(fx, '/remote/assets/app.js?v=1');
    expect(script.status).toBe(200); expect(script.text).toBe('document.title="HappyPanda";');
    const head = await send(fx, '/remote/assets/app.js', { method: 'HEAD' });
    expect(head.status).toBe(200); expect(head.text).toBe('');
    expect(Number(head.headers['content-length'])).toBe(Buffer.byteLength(script.text));
    for (const target of ['/remote/../private.txt', '/remote/%2e%2e/private.txt', '/remote/%2f..%2fprivate.txt', '/remote/assets%5c..%5cprivate.txt', '/remote/%252e%252e/private.txt', '/remote/C:/private.txt', '/remote/assets/app.js:secret', '/remote/%00private.txt']) {
      expect((await send(fx, target)).status, target).toBe(403);
    }
    expect((await send(fx, '/remote/%')).status).toBe(400);
    expect((await send(fx, '/remote/assets/missing.js')).status).toBe(404);
    const outside = join(fx.root, 'outside');
    await mkdir(outside); await writeFile(join(outside, 'private.txt'), 'private');
    await symlink(outside, join(fx.options.rendererDir, 'assets', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await send(fx, '/remote/assets/escape/private.txt')).status).toBe(403);
    expect((await send(fx, '/remote/', { body: {} })).status).toBe(405);
  });

  it('selects physical private LAN before virtual, public, benchmark/TUN and loopback interfaces', async () => {
    const fx = await fixture({ host: '0.0.0.0' });
    const entry = (address: string) => [{ address, family: 'IPv4' as const, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', internal: address.startsWith('127.'), cidr: `${address}/24` }];
    vi.mocked(networkInterfaces).mockReturnValue({
      'Mihomo Wintun': entry('198.19.0.1'), 'Loopback': entry('127.0.0.1'),
      'Docker': entry('172.18.0.1'), 'Ethernet': entry('203.0.113.2'), 'Wi-Fi': entry('192.168.1.2'),
      'WSL vEthernet': entry('10.0.0.1'), 'TAP VPN': entry('10.8.0.1'), 'Link local': entry('169.254.10.1'),
      'VBox VMware': entry('192.168.56.1'),
    });
    const addresses = fx.server.snapshot().addresses;
    expect(addresses[0]).toBe(`http://192.168.1.2:${fx.server.snapshot().port}/remote/`);
    const position = (host: string) => addresses.findIndex(address => new URL(address).hostname === host);
    expect(position('172.18.0.1')).toBeLessThan(position('203.0.113.2'));
    expect(position('10.0.0.1')).toBeLessThan(position('203.0.113.2'));
    expect(position('192.168.56.1')).toBeLessThan(position('203.0.113.2'));
    expect(position('203.0.113.2')).toBeLessThan(position('198.19.0.1'));
    expect(position('203.0.113.2')).toBeLessThan(position('10.8.0.1'));
    expect(position('198.19.0.1')).toBeLessThan(position('127.0.0.1'));
    expect(addresses).toHaveLength(9);
  });

  it('serializes repeated lifecycle changes, closes streams and pending sockets, and makes disposal idempotent', async () => {
    const fx = await fixture();
    const paired = await pair(fx);
    const stream = await events(fx, paired.cookie);
    const changes = await Promise.all([fx.server.setEnabled(false), fx.server.setEnabled(true), fx.server.setEnabled(false)]);
    expect(changes.map(state => state.enabled)).toEqual([false, true, false]);
    await until(() => stream.closed);
    await fx.server.setEnabled(true);
    const fresh = await events(fx, paired.cookie);
    const slow = await delayedBody(fx, '/api/remote/terminal', paired.cookie, { ...context, data: 'not executed after shutdown' });
    const failure = slow.reply.catch(error => error);
    await Promise.all([fx.server.dispose(), fx.server.dispose()]);
    expect(await failure).toBeInstanceOf(Error);
    await until(() => fresh.closed);
    expect(fx.server.snapshot()).toMatchObject({ enabled: false, owner: DESKTOP_OWNER });
    expect(fx.invoke).not.toHaveBeenCalled(); expect(fx.input).not.toHaveBeenCalled();
    await expect(fx.server.setEnabled(true)).rejects.toThrow('关闭');
  });
});
