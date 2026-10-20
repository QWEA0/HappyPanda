import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import * as pty from 'node-pty';
import { RemoteControlServer } from '../../src/main/remote-control';
import { LocalMcpBridge } from '../../src/main/mcp';
import { terminalPaste, validateClipboardPng } from '../../src/main/clipboard';
import { emptySync, type AppState, type Workspace } from '../../src/shared/types';

export async function createRemoteRuntime() {
  const root = await mkdtemp(join(tmpdir(), 'hp-remote-runtime-'));
  const localPath = join(root, 'workspace');
  await mkdir(localPath);
  await writeFile(join(localPath, 'pc-marker.txt'), 'PC_LOCAL_MCP_FILE', 'utf8');
  const workspace: Workspace = { id: 'pc-workspace', nodeId: 'pc-node', name: 'PC runtime test', localPath, remotePath: '/pc-runtime', localAccess: true, syncSessionName: '', createdAt: new Date().toISOString() };
  const state: AppState = {
    version: 'test', nodes: [{ id: 'pc-node', name: 'PC runtime test', sshTarget: 'local-test', lastWorkspaceId: workspace.id, lastSessionId: 'pc-session', createdAt: workspace.createdAt }],
    providers: [], workspaces: [workspace], sessions: [{ id: 'pc-session', nodeId: 'pc-node', workspaceId: workspace.id, title: 'PC PowerShell', tmuxName: '', createdAt: workspace.createdAt, lastActiveAt: workspace.createdAt, kind: 'shell' }],
    connection: { phase: 'connected', message: 'Isolated PC terminal', retryAttempt: 0, activeNodeId: 'pc-node', activeWorkspaceId: workspace.id, activeSessionId: 'pc-session' },
    openSessions: [{ sessionId: 'pc-session', nodeId: 'pc-node', workspaceId: workspace.id, title: 'PC PowerShell', kind: 'shell', phase: 'connected', message: 'Isolated PC terminal', generation: 0, unread: false }],
    metrics: null, sync: { ...emptySync(), phase: 'ready' }, activities: [], terminalBuffer: '', terminalSize: { cols: 100, rows: 32 }, terminalGeneration: 0,
  };
  const terminal = pty.spawn(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : [], { cwd: localPath, cols: 100, rows: 32, name: 'xterm-256color', env: process.env as Record<string, string>, useConptyDll: true });
  let server: RemoteControlServer;
  terminal.onData(data => {
    state.terminalBuffer = (state.terminalBuffer + data).slice(-512000);
    server?.publish({ type: 'terminal', data });
  });
  const options = {
    dataDir: join(root, 'remote'), rendererDir: resolve('out/renderer'), host: '127.0.0.1', port: 0,
    getState: () => structuredClone(state), onState: () => {},
    invoke: async (method: string, args: unknown[] = []) => {
      if (method === 'getState') return structuredClone(state);
      if (method === 'listSshAliases' || method === 'listLocalHistory') return [];
      if (method === 'disconnect') {
        state.terminalGeneration!++;
        state.connection.phase = 'disconnected';
        Object.assign(state.openSessions![0], { phase: 'disconnected', generation: state.terminalGeneration });
        server.publish({ type: 'state', state: { ...state, terminalBuffer: '' } });
        return;
      }
      if (method === 'connect') {
        state.terminalGeneration!++;
        state.connection.phase = 'connected';
        Object.assign(state.openSessions![0], { phase: 'connected', generation: state.terminalGeneration });
        server.publish({ type: 'state', state: { ...state, terminalBuffer: '' } });
        return state.sessions[0];
      }
      if (method === 'pasteImage') {
        const png = Buffer.from(args[1] as string, 'base64');
        validateClipboardPng(png);
        await writeFile(join(localPath, 'phone-image.png'), png);
        terminal.write(terminalPaste(' # phone-image.png ', Boolean((args[0] as { bracketedPaste: boolean }).bracketedPaste)));
        return { kind: 'image' };
      }
      throw new Error('This isolated fixture only supports its existing PC terminal.');
    },
    writeTerminal: (data: string) => terminal.write(data),
    resizeTerminal: (cols: number, rows: number) => { terminal.resize(cols, rows); state.terminalSize = { cols, rows }; server.publish({ type: 'terminal-size', cols, rows }); },
  };
  server = new RemoteControlServer(options);
  await server.initialize();
  await server.setEnabled(true);
  await server.createPairing();
  const token = randomBytes(32).toString('hex');
  const bridge = new LocalMcpBridge({ token, dataDir: join(root, 'mcp'), resolveWorkspace: id => id === workspace.id ? workspace : undefined, onActivity: () => {} });
  const endpoint = await bridge.start();
  let closed = false;
  return {
    root, workspace, state, terminal, bridge, token, endpoint,
    get server() { return server; },
    get base() { return `http://127.0.0.1:${server.snapshot().port}`; },
    async restart() { await server.dispose(); server = new RemoteControlServer({ ...options, port: undefined }); await server.initialize(); },
    async close() {
      if (closed) return;
      closed = true;
      await server.dispose();
      await bridge.stop();
      const exit = new Promise<void>(resolveExit => { const timer = setTimeout(() => { terminal.kill(); resolveExit(); }, 2000); terminal.onExit(() => { clearTimeout(timer); resolveExit(); }); });
      terminal.write('exit\r');
      await exit;
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('hp-remote-runtime-')) throw new Error('Unsafe runtime fixture cleanup.');
      await rm(root, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifestPath = resolve('.local/remote-control-runtime.json');
  if (process.argv[2] === '--command') {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { root: string };
    if (dirname(resolve(manifest.root)) !== resolve(tmpdir()) || !basename(manifest.root).startsWith('hp-remote-runtime-')) throw new Error('Unsafe runtime control path.');
    const commandId = randomUUID();
    await writeFile(join(manifest.root, 'command.json'), JSON.stringify({ id: commandId, command: process.argv[3] }));
    for (let attempt = 0; attempt < 200; attempt++) {
      const next = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (next.commandId === commandId) { console.log(JSON.stringify(next)); process.exit(0); }
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    throw new Error('Runtime fixture command timed out.');
  }
  const runtime = await createRemoteRuntime();
  await mkdir(dirname(manifestPath), { recursive: true });
  const report = async (commandId?: string) => {
    const status = { root: runtime.root, pid: process.pid, url: runtime.base + '/remote/', code: runtime.server.snapshot().pairing?.code, owner: runtime.server.snapshot().owner, devices: runtime.server.snapshot().devices.length, commandId };
    await writeFile(manifestPath, JSON.stringify(status));
    console.log(JSON.stringify(status));
  };
  await report();
  let activeCommand = '';
  let executing = false;
  const controlTimer = setInterval(() => {
    if (executing) return;
    executing = true;
    void (async () => {
      let request: { id: string; command: string };
      try { request = JSON.parse(await readFile(join(runtime.root, 'command.json'), 'utf8')); }
      catch { return; }
      if (request.id === activeCommand) return;
      activeCommand = request.id;
      if (request.command === 'desktop') runtime.server.takeControl();
      if (request.command === 'restart') await runtime.restart();
      if (request.command === 'revoke') for (const device of runtime.server.snapshot().devices) await runtime.server.revokeDevice(device.id);
      if (request.command === 'pair') await runtime.server.createPairing();
      await report(request.id);
      if (request.command === 'quit') { clearInterval(controlTimer); await runtime.close(); process.exit(0); }
    })().catch(console.error).finally(() => { executing = false; });
  }, 100);
  const input = createInterface({ input: process.stdin });
  input.on('line', line => {
    void (async () => {
      if (line === 'desktop') runtime.server.takeControl();
      if (line === 'restart') await runtime.restart();
      if (line === 'revoke') for (const device of runtime.server.snapshot().devices) await runtime.server.revokeDevice(device.id);
      if (line === 'pair') await runtime.server.createPairing();
      if (line === 'quit') { input.close(); await runtime.close(); process.exit(0); }
      console.log(JSON.stringify({ owner: runtime.server.snapshot().owner, code: runtime.server.snapshot().pairing?.code, devices: runtime.server.snapshot().devices.length }));
    })().catch(console.error);
  });
  process.once('SIGINT', () => { void runtime.close().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void runtime.close().finally(() => process.exit(0)); });
}
