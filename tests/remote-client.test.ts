import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteClient } from '../src/renderer/src/remote-client';
import { DESKTOP_OWNER, type RemoteSessionInfo } from '../src/shared/remote';
import type { AppEvent, AppState } from '../src/shared/types';

const phone = { id: 'phone-1', name: 'Pixel' };
const session: RemoteSessionInfo = { deviceId: phone.id, deviceName: phone.name, owner: phone };

function appState(sessionId = 'session-a', terminalBuffer = 'initial output\r\n'): AppState {
  return {
    providers: [], nodes: [], workspaces: [], sessions: [], activities: [], metrics: null,
    connection: {
      phase: 'connected', message: 'Connected', retryAttempt: 0,
      activeNodeId: 'node-a', activeSessionId: sessionId,
    },
    sync: { phase: 'none', message: '', conflicts: [], updatedAt: '2026-10-17T00:00:00.000Z' },
    terminalBuffer, version: 'test',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly withCredentials = false;
  readyState = FakeEventSource.CONNECTING;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }

  close() { this.readyState = FakeEventSource.CLOSED; }

  send(type: 'snapshot' | 'app' | 'session', data: unknown) {
    // Closed sources can still deliver events queued before close().
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }

  fail() {
    const event = new Event('error');
    this.dispatchEvent(event);
    this.onerror?.(event);
  }
}

interface PendingRequest {
  path: string;
  init: RequestInit;
  body: Record<string, unknown> | undefined;
  resolve: (response: Response) => void;
  reject: (reason: unknown) => void;
}

let requests: PendingRequest[];
let clients: RemoteClient[];
let browserWindow: EventTarget & { location: { pathname: string; search: string; hash: string } };
let browserDocument: EventTarget & { visibilityState: string };
let browserHistory: { replaceState: ReturnType<typeof vi.fn> };

const pending = (path: string) => requests.filter(request => request.path === path);
function request(path: string, index = 0) {
  const found = pending(path)[index];
  expect(found, `Expected request ${index + 1} to ${path}`).toBeDefined();
  return found!;
}
function respond(target: PendingRequest, result: unknown, status = 200) {
  target.resolve(Response.json(status < 400 ? { result } : { error: result }, { status }));
}
const flush = () => vi.advanceTimersByTimeAsync(0);
function createClient() {
  const client = new RemoteClient();
  clients.push(client);
  return client;
}
function latestSource() {
  const source = FakeEventSource.instances.at(-1);
  expect(source).toBeDefined();
  return source!;
}
async function connected(state = appState(), info = session) {
  const client = createClient();
  client.start();
  respond(request('/session'), info);
  await flush();
  const source = latestSource();
  source.send('snapshot', state);
  expect(client.getStatus()).toMatchObject({ phase: 'connected', authenticated: true, owner: info.owner });
  return { client, source };
}
async function reconnect(client: RemoteClient, state = appState()) {
  const count = pending('/session').length;
  browserWindow.dispatchEvent(new Event('online'));
  expect(pending('/session')).toHaveLength(count + 1);
  respond(request('/session', count), session);
  await flush();
  latestSource().send('snapshot', state);
  expect(client.getStatus().phase).toBe('connected');
  return latestSource();
}

function pausedImageDecode() {
  const bitmap = { width: 1, height: 1, close: vi.fn() };
  const decoding = deferred<typeof bitmap>();
  const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
  const drawImage = vi.fn();
  const decode = vi.fn(() => decoding.promise);
  vi.stubGlobal('createImageBitmap', decode);
  Object.assign(browserDocument, {
    createElement: vi.fn((tag: string) => {
      expect(tag).toBe('canvas');
      return {
        width: 0, height: 0, getContext: () => ({ drawImage }),
        toBlob: (callback: (blob: Blob) => void) => callback(png),
      };
    }),
  });
  vi.stubGlobal('FileReader', class {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    async readAsDataURL(blob: Blob) {
      this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
      this.onload?.();
    }
  });
  return { bitmap, decoding, decode, drawImage };
}

beforeEach(() => {
  vi.useFakeTimers();
  requests = [];
  clients = [];
  FakeEventSource.instances = [];
  browserWindow = Object.assign(new EventTarget(), {
    location: { pathname: '/remote/', search: '', hash: '' }, open: vi.fn(),
  });
  browserDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  browserHistory = { replaceState: vi.fn() };
  vi.stubGlobal('window', browserWindow);
  vi.stubGlobal('document', browserDocument);
  vi.stubGlobal('history', browserHistory);
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', vi.fn<typeof fetch>((input, init = {}) => {
    const response = deferred<Response>();
    const abort = () => response.reject(new DOMException('Aborted', 'AbortError'));
    init.signal?.addEventListener('abort', abort, { once: true });
    requests.push({
      path: String(input).replace('/api/remote', ''), init,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      resolve: value => {
        init.signal?.removeEventListener('abort', abort);
        response.resolve(value);
      },
      reject: reason => {
        init.signal?.removeEventListener('abort', abort);
        response.reject(reason);
      },
    });
    return response.promise;
  }));
});

afterEach(() => {
  for (const client of clients) client.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('remote client authentication and connection lifecycle', () => {
  it('stays unpaired after an unauthenticated startup without retrying or sending input', async () => {
    const client = createClient();
    client.start();
    client.start();
    expect(pending('/session')).toHaveLength(1);
    expect(request('/session').init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    respond(request('/session'), 'Pair first', 401);
    await flush();
    expect(client.getStatus()).toMatchObject({ phase: 'unpaired', authenticated: false, owner: DESKTOP_OWNER });
    expect(() => client.writeTerminal('dangerous\r')).toThrow();
    await expect(client.api.newSession('shell')).rejects.toThrow();
    browserWindow.dispatchEvent(new Event('online'));
    browserDocument.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(30000);
    expect(requests).toHaveLength(1);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('removes the QR token from browser history and pairs after the session probe returns 401', async () => {
    browserWindow.location.hash = '#pair=qr%2Btoken';
    browserWindow.location.search = '?view=terminal';
    const client = createClient();
    client.start();
    expect(browserHistory.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/remote/?view=terminal');
    respond(request('/session'), 'Pair first', 401);
    await flush();
    expect(request('/pair').body).toEqual({ token: 'qr+token', name: 'Android' });
    expect(request('/pair').init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
    respond(request('/pair'), { ...session, owner: DESKTOP_OWNER });
    await flush();
    expect(latestSource().url).toBe('/api/remote/events');
    latestSource().send('snapshot', appState());
    expect(client.getStatus()).toMatchObject({ phase: 'connected', authenticated: true, deviceId: phone.id, owner: DESKTOP_OWNER });
    expect(requests.every(value => !value.path.includes('qr+token'))).toBe(true);
  });

  it('normalizes manual pairing and changes input permissions only after claim and release', async () => {
    const client = createClient();
    const pairing = client.pair('12 34-56', '  Pixel  ');
    expect(request('/pair').body).toEqual({ code: '123456', name: 'Pixel' });
    respond(request('/pair'), { ...session, owner: DESKTOP_OWNER });
    await pairing;
    expect(() => client.writeTerminal('before snapshot')).toThrow();
    latestSource().send('snapshot', appState());
    expect(() => client.writeTerminal('before claim')).toThrow(/PC/);
    const claiming = client.claim();
    expect(request('/control').body).toEqual({ action: 'claim' });
    respond(request('/control'), session);
    await claiming;
    const input = client.writeTerminal('allowed\r');
    await flush();
    respond(request('/terminal'), undefined);
    await input;
    const releasing = client.release();
    expect(request('/control', 1).body).toEqual({ action: 'release' });
    respond(request('/control', 1), { ...session, owner: DESKTOP_OWNER });
    await releasing;
    expect(client.getStatus().owner).toEqual(DESKTOP_OWNER);
    expect(() => client.writeTerminal('after release')).toThrow(/PC/);
    expect(pending('/terminal')).toHaveLength(1);
  });

  it.each((['claim', 'release'] as const).flatMap(action =>
    (['SSE ownership update', 'revocation', 'reconnect'] as const).map(change => ({ action, change })),
  ))('ignores a stale $action success after $change', async ({ action, change }) => {
    const staleSession = action === 'claim' ? session : { ...session, owner: DESKTOP_OWNER };
    const currentSession = action === 'claim' ? { ...session, owner: DESKTOP_OWNER } : session;
    const { client, source } = await connected(appState(), currentSession);
    const control = client[action]();
    expect(request('/control').body).toEqual({ action });
    let activeSource = source;
    if (change === 'SSE ownership update') {
      source.send('session', staleSession);
      source.send('session', currentSession);
    } else if (change === 'revocation') {
      const reading = client.api.getState();
      const rejected = expect(reading).rejects.toThrow('Device revoked');
      respond(request('/rpc'), 'Device revoked', 401);
      await rejected;
      expect(client.getStatus()).toMatchObject({ phase: 'revoked', authenticated: false, deviceId: undefined });
    } else {
      source.fail();
      activeSource = await reconnect(client);
      activeSource.send('session', currentSession);
    }
    const currentStatus = { ...client.getStatus() };
    respond(request('/control'), staleSession);
    await control;
    expect(client.getStatus()).toEqual(currentStatus);
    expect(pending('/control')).toHaveLength(1);
    if (change === 'revocation') {
      expect(activeSource.readyState).toBe(FakeEventSource.CLOSED);
      expect(() => client.writeTerminal('revoked input')).toThrow();
    } else {
      expect(activeSource.readyState).not.toBe(FakeEventSource.CLOSED);
      expect(client.getStatus()).toMatchObject({ phase: 'connected', authenticated: true, owner: currentSession.owner });
    }
  });

  it('retries a failed session probe and recovers when the PC is reachable again', async () => {
    const client = createClient();
    client.start();
    request('/session').reject(new TypeError('Network unavailable'));
    await flush();
    expect(client.getStatus().phase).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(799);
    expect(pending('/session')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    respond(request('/session', 1), session);
    await flush();
    latestSource().send('snapshot', appState());
    expect(client.getStatus().phase).toBe('connected');
    expect(pending('/session')).toHaveLength(2);
  });

  it('keeps a previously authenticated device revoked when its reconnect receives 401', async () => {
    const { client, source } = await connected();
    source.fail();
    await vi.advanceTimersByTimeAsync(800);
    respond(request('/session', 1), 'Device revoked', 401);
    await flush();
    expect(client.getStatus()).toMatchObject({ phase: 'revoked', authenticated: false, deviceId: undefined, owner: DESKTOP_OWNER });
    browserWindow.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(30000);
    expect(pending('/session')).toHaveLength(2);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('revokes a connected device on RPC 401 and ignores events from the closed source', async () => {
    const { client, source } = await connected();
    const onEvent = vi.fn();
    client.api.onEvent(onEvent);
    const reading = client.api.getState();
    const rejected = expect(reading).rejects.toThrow('Device revoked');
    respond(request('/rpc'), 'Device revoked', 401);
    await rejected;
    expect(client.getStatus()).toMatchObject({ phase: 'revoked', authenticated: false, owner: DESKTOP_OWNER });
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
    source.send('snapshot', appState('session-stale'));
    source.send('session', session);
    expect(onEvent).not.toHaveBeenCalled();
    expect(() => client.writeTerminal('revoked input')).toThrow();
    browserWindow.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(30000);
    expect(pending('/session')).toHaveLength(1);
  });

  it('does not open a stream when a pending session probe succeeds after disposal', async () => {
    const client = createClient();
    client.start();
    client.dispose();
    respond(request('/session'), session);
    await flush();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(client.getStatus().authenticated).toBe(false);
  });

  it.each(['success', '401'] as const)('ignores a stale session probe %s after a newer connection is active', async outcome => {
    const client = createClient();
    client.start();
    const older = request('/session');
    const activeSource = await reconnect(client, appState('session-new'));
    if (outcome === 'success') respond(older, { ...session, deviceId: 'stale-phone', owner: DESKTOP_OWNER });
    else respond(older, 'Expired old session', 401);
    await flush();
    expect(client.getStatus()).toMatchObject({ phase: 'connected', authenticated: true, deviceId: phone.id, owner: phone });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(activeSource.readyState).not.toBe(FakeEventSource.CLOSED);
  });

  it('disposes reconnect timers and browser listeners without accepting stale stream events', async () => {
    const { client, source } = await connected();
    const onEvent = vi.fn();
    client.api.onEvent(onEvent);
    source.fail();
    client.dispose();
    source.send('snapshot', appState());
    browserWindow.dispatchEvent(new Event('online'));
    browserDocument.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(30000);
    expect(onEvent).not.toHaveBeenCalled();
    expect(pending('/session')).toHaveLength(1);
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });
});

describe('remote client state ordering', () => {
  it('resets the same terminal from the reconnect snapshot and keeps the latest streamed buffer', async () => {
    const { client, source } = await connected(appState('session-a', 'old\r\n'));
    const onEvent = vi.fn<(event: AppEvent) => void>();
    client.api.onEvent(onEvent);
    source.send('app', { type: 'terminal', data: 'before disconnect\r\n' });
    source.fail();
    const recovered = appState('session-a', 'old\r\nbefore disconnect\r\nmissed offline\r\n');
    const activeSource = await reconnect(client, recovered);
    expect(onEvent).toHaveBeenLastCalledWith({ type: 'state', state: recovered, resetTerminal: true });
    const reading = client.api.getState();
    source.send('snapshot', appState('session-stale', 'wrong buffer'));
    source.send('app', { type: 'terminal', data: 'stale output' });
    activeSource.send('app', { type: 'terminal', data: 'latest output\r\n' });
    respond(request('/rpc'), appState('session-a', 'stale HTTP buffer'));
    const state = await reading;
    expect(state.connection.activeSessionId).toBe('session-a');
    expect(state.terminalBuffer).toBe(recovered.terminalBuffer + 'latest output\r\n');
    expect(onEvent).toHaveBeenCalledTimes(3);
  });

  it.each(['terminal', 'session'] as const)('does not let a late getState overwrite a newer %s event', async event => {
    const original = appState();
    const { client, source } = await connected(original);
    const reading = client.api.getState();
    const updated = appState('session-b', 'new session output');
    if (event === 'terminal') source.send('app', { type: 'terminal', data: 'new output' });
    else source.send('app', { type: 'state', state: updated });
    respond(request('/rpc'), original);
    const state = await reading;
    expect(state).toEqual(event === 'terminal' ? { ...original, terminalBuffer: original.terminalBuffer + 'new output' } : updated);
  });

  it('preserves live terminal output across same-session state events with an empty buffer', async () => {
    const { client, source } = await connected();
    const reading = client.api.getState();
    source.send('app', { type: 'terminal', data: 'streamed output' });
    const update = appState('session-a', '');
    update.connection.message = 'Workspace synchronized';
    source.send('app', { type: 'state', state: update });
    respond(request('/rpc'), appState());
    expect(await reading).toMatchObject({
      connection: { message: 'Workspace synchronized' },
      terminalBuffer: 'initial output\r\nstreamed output',
    });
  });

  it('honors an explicit same-session reset from an app event', async () => {
    const { client, source } = await connected();
    const reading = client.api.getState();
    source.send('app', { type: 'state', state: appState('session-a', 'fresh terminal'), resetTerminal: true });
    respond(request('/rpc'), appState());
    expect((await reading).terminalBuffer).toBe('fresh terminal');
  });
});

describe('remote client input ordering and no replay', () => {
  it('serializes terminal writes with their original node and session context', async () => {
    const { client } = await connected();
    const first = client.writeTerminal('first\r');
    const second = client.api.writeTerminal('second\r');
    await flush();
    expect(pending('/terminal')).toHaveLength(1);
    expect(request('/terminal').body).toEqual({ data: 'first\r', nodeId: 'node-a', sessionId: 'session-a' });
    respond(request('/terminal'), undefined);
    await first;
    await flush();
    expect(pending('/terminal')).toHaveLength(2);
    expect(request('/terminal', 1).body).toEqual({ data: 'second\r', nodeId: 'node-a', sessionId: 'session-a' });
    respond(request('/terminal', 1), undefined);
    await second;
  });

  it.each(['owner', 'network'] as const)('rejects queued input after losing %s even if control is restored before acknowledgement', async loss => {
    const { client, source } = await connected();
    const first = client.writeTerminal('already sent\r');
    const queued = client.writeTerminal('must not replay\r');
    const rejected = expect(queued).rejects.toThrow();
    await flush();
    if (loss === 'owner') {
      source.send('session', { ...session, owner: DESKTOP_OWNER });
      expect(() => client.writeTerminal('while PC owns')).toThrow(/PC/);
      source.send('session', session);
    } else {
      source.fail();
      expect(() => client.writeTerminal('while offline')).toThrow();
      await reconnect(client);
    }
    expect(client.getStatus()).toMatchObject({ phase: 'connected', owner: phone });
    respond(request('/terminal'), undefined);
    await first;
    await rejected;
    await flush();
    expect(pending('/terminal')).toHaveLength(1);
    const intentional = client.writeTerminal('new intentional input\r');
    await flush();
    expect(request('/terminal', 1).body?.data).toBe('new intentional input\r');
    respond(request('/terminal', 1), undefined);
    await intentional;
  });

  it('rejects queued input for the old session and sends subsequent input only to the new session', async () => {
    const { client, source } = await connected();
    const first = client.writeTerminal('session A\r');
    const queued = client.writeTerminal('stale session A input\r');
    const rejected = expect(queued).rejects.toThrow();
    await flush();
    source.send('app', { type: 'state', state: appState('session-b', 'session B') });
    respond(request('/terminal'), undefined);
    await first;
    await rejected;
    await flush();
    expect(pending('/terminal')).toHaveLength(1);
    const current = client.writeTerminal('session B\r');
    await flush();
    expect(request('/terminal', 1).body).toEqual({ data: 'session B\r', nodeId: 'node-a', sessionId: 'session-b' });
    respond(request('/terminal', 1), undefined);
    await current;
  });

  it('cancels queued input when getState reveals a new runtime generation for the same session', async () => {
    const { client } = await connected({ ...appState(), terminalGeneration: 7 });
    const first = client.writeTerminal('already sent\r');
    const queued = client.writeTerminal('obsolete runtime input\r');
    const outcome = queued.then(() => ({ ok: true }), error => ({ ok: false, error }));
    await flush();
    expect(request('/terminal').body).toEqual({
      data: 'already sent\r', nodeId: 'node-a', sessionId: 'session-a', generation: 7,
    });
    const reading = client.api.getState();
    respond(request('/rpc'), { ...appState(), terminalGeneration: 9 });
    expect(await reading).toMatchObject({ terminalGeneration: 9, connection: { activeSessionId: 'session-a', phase: 'connected' } });
    respond(request('/terminal'), undefined);
    await first;
    await flush();
    expect(pending('/terminal')).toHaveLength(1);
    expect(await outcome).toMatchObject({ ok: false, error: expect.any(Error) });
    const intentional = client.writeTerminal('new runtime input\r');
    await flush();
    expect(request('/terminal', 1).body).toEqual({
      data: 'new runtime input\r', nodeId: 'node-a', sessionId: 'session-a', generation: 9,
    });
    respond(request('/terminal', 1), undefined);
    await intentional;
  });

  it.each(['A -> B -> A', 'connected -> retrying -> connected', 'explicit terminal reset', 'session reload token change'] as const)(
    'cancels queued input after %s even though the final session ID is unchanged', async change => {
      const original = appState();
      original.sessions = [{
        id: 'session-a', nodeId: 'node-a', title: 'Shell', tmuxName: 'hp-a', kind: 'shell',
        createdAt: '', lastActiveAt: '', reloadToken: 'before',
      }];
      const { client, source } = await connected(original);
      const first = client.writeTerminal('already sent\r');
      const queued = client.writeTerminal('obsolete input\r');
      const outcome = queued.then(() => ({ ok: true }), error => ({ ok: false, error }));
      await flush();
      expect(pending('/terminal')).toHaveLength(1);
      if (change === 'A -> B -> A') {
        source.send('app', { type: 'state', state: appState('session-b') });
        source.send('app', { type: 'state', state: original });
      } else if (change === 'connected -> retrying -> connected') {
        const retrying = structuredClone(original);
        retrying.connection.phase = 'retrying';
        source.send('app', { type: 'state', state: retrying });
        source.send('app', { type: 'state', state: original });
      } else if (change === 'explicit terminal reset') {
        source.send('app', { type: 'state', state: original, resetTerminal: true });
      } else {
        const reloaded = structuredClone(original);
        reloaded.sessions[0].reloadToken = 'after';
        source.send('app', { type: 'state', state: reloaded });
      }
      expect(client.getStatus()).toMatchObject({ phase: 'connected', owner: phone });
      respond(request('/terminal'), undefined);
      await first;
      await flush();
      expect(pending('/terminal')).toHaveLength(1);
      expect(await outcome).toMatchObject({ ok: false, error: expect.any(Error) });
      const intentional = client.writeTerminal('new input\r');
      await flush();
      expect(request('/terminal', 1).body).toEqual({ data: 'new input\r', nodeId: 'node-a', sessionId: 'session-a' });
      respond(request('/terminal', 1), undefined);
      await intentional;
    },
  );

  it('does not replay an unconfirmed terminal write or its queue after a network failure and reconnect', async () => {
    const { client, source } = await connected();
    const first = client.writeTerminal('possibly executed\r');
    const queued = client.writeTerminal('must never execute\r');
    const firstRejected = expect(first).rejects.toThrow();
    const queuedRejected = expect(queued).rejects.toThrow();
    await flush();
    request('/terminal').reject(new TypeError('Network lost after sending'));
    await firstRejected;
    await queuedRejected;
    source.fail();
    await reconnect(client);
    await vi.advanceTimersByTimeAsync(30000);
    expect(pending('/terminal')).toHaveLength(1);
    expect(pending('/terminal').map(value => value.body?.data)).toEqual(['possibly executed\r']);
  });

  it.each(['network failure', 'timeout', 'server error'] as const)('does not retry a non-idempotent mutation after %s', async failure => {
    const { client, source } = await connected();
    const mutation = client.api.newSession('shell');
    const rejected = expect(mutation).rejects.toThrow();
    const rpc = request('/rpc');
    expect(rpc.body).toEqual({ method: 'newSession', args: ['shell'] });
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(180000);
    else if (failure === 'network failure') rpc.reject(new TypeError('Response lost'));
    else respond(rpc, 'Session creation failed', 503);
    await rejected;
    source.fail();
    await reconnect(client);
    await vi.advanceTimersByTimeAsync(30000);
    expect(pending('/rpc')).toHaveLength(1);
    expect(pending('/session')).toHaveLength(2);
  });
});

describe('remote client image preprocessing ownership', () => {
  it('uploads a converted image to the captured session while control remains unchanged', async () => {
    const { client } = await connected();
    const image = pausedImageDecode();
    const file = new File(['synthetic image'], 'capture.png', { type: 'image/png' });
    const upload = client.uploadImage(file, true);
    expect(image.decode).toHaveBeenCalledExactlyOnceWith(file);
    expect(pending('/rpc')).toHaveLength(0);
    image.decoding.resolve(image.bitmap);
    await flush();
    expect(request('/rpc').body).toEqual({
      method: 'pasteImage',
      args: [{ nodeId: 'node-a', sessionId: 'session-a', bracketedPaste: true }, 'iVBORw=='],
    });
    respond(request('/rpc'), { kind: 'image' });
    await upload;
    expect(image.drawImage).toHaveBeenCalledExactlyOnceWith(image.bitmap, 0, 0);
    expect(image.bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a paused image upload after control is lost and regained without sending an RPC', async () => {
    const { client, source } = await connected();
    const image = pausedImageDecode();
    const file = new File(['synthetic image'], 'capture.png', { type: 'image/png' });
    const upload = client.uploadImage(file);
    const outcome = upload.then(() => ({ ok: true }), error => ({ ok: false, error }));
    expect(image.decode).toHaveBeenCalledExactlyOnceWith(file);
    source.send('session', { ...session, owner: DESKTOP_OWNER });
    source.send('session', session);
    expect(client.getStatus()).toMatchObject({ phase: 'connected', authenticated: true, owner: phone });
    image.decoding.resolve(image.bitmap);
    await flush();
    expect(pending('/rpc')).toHaveLength(0);
    expect(await outcome).toMatchObject({ ok: false, error: expect.any(Error) });
    expect(image.bitmap.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(pending('/rpc')).toHaveLength(0);
  });
});
