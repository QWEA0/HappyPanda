import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { authorizationUrl, browserArguments, BrowserLoginManager, ProxyGate, socksRequest, openPersistentProxyGate } from '../src/main/login-browser';
import { TEST_NODE } from './fixtures/node';

const auth = 'https://claude.com/cai/oauth/authorize?response_type=code&state=synthetic-state&code_challenge=synthetic-challenge&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fcallback';
const servers: Server[] = [], sockets = new Set<Socket>();
const track = (socket: Socket) => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); return socket; };
const listen = (server: Server, port = 0): Promise<number> => new Promise((resolve, reject) => {
  servers.push(server); server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
});
afterEach(async () => { for (const socket of sockets) socket.destroy(); sockets.clear(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.listening ? server.close(() => resolve()) : resolve()))); });
const denied = (port: number) => new Promise<void>((resolve, reject) => {
  const socket = track(createConnection({ host: '127.0.0.1', port }));
  socket.on('connect', () => socket.write(Buffer.from([5, 1, 0])));
  socket.on('data', () => reject(new Error('Blocked gate accepted traffic')));
  socket.on('close', () => resolve());
});

describe('node login browser boundaries', () => {
  it('uses an available port on first use and preserves it across restarts without silently changing an occupied endpoint',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'hp-login-port-'));
    const first=await openPersistentProxyGate(directory,'node-a');
    const port=first.port;await first.gate.close();
    const second=await openPersistentProxyGate(directory,'node-a');
    expect(second.port).toBe(port);
    try{await expect(openPersistentProxyGate(directory,'node-a')).rejects.toThrow('被占用');}finally{await second.gate.close();}
    await mkdir(join(directory,'login-proxy-ports'),{recursive:true});
    await writeFile(join(directory,'login-proxy-ports','invalid.json'),'{"port":1}');
    await expect(openPersistentProxyGate(directory,'invalid')).rejects.toThrow('配置无效');
  });
  it('accepts only official OAuth authorization URLs and never puts them on the browser command line', () => {
    expect(authorizationUrl(auth)).toBe(auth);
    expect(authorizationUrl(auth.replace('claude.com/cai','claude.ai'))).toContain('claude.ai/oauth/authorize');
    for (const url of [auth.replace('claude.com', 'claude.com.evil.test'), auth.replace('https:', 'http:'), auth.replace('/oauth/authorize', '/api/login'),
      auth.replace('redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fcallback', 'redirect_uri=https%3A%2F%2Fevil.example%2Fcallback'),
      auth.replace('code_challenge=', 'unused='), 'javascript:alert(1)']) expect(() => authorizationUrl(url)).toThrow('授权链接无效');
    const args = browserArguments('C:\\Synthetic profile', 12345, 'http://127.0.0.1:4567/route/nonce');
    expect(args).toContain('--proxy-server=socks5://127.0.0.1:12345');
    expect(args).toContain('--proxy-bypass-list=<-loopback>');
    expect(args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    expect(args).toContain('--disable-quic');
    expect(args.some(value=>value.startsWith('--host-resolver-rules='))).toBe(false);
    expect(args.join(' ')).not.toMatch(/direct:\/\/|synthetic-state|ignore-certificate|disable-web-security/);
  });
  it('keeps its port bound and destroys existing traffic when the upstream tunnel is blocked', async () => {
    const echo = await listen(createServer(socket => { track(socket).pipe(socket); }));
    const gate = new ProxyGate(), port = await gate.listen(0);
    try {
      await denied(port); gate.enable(echo);
      const socket = track(createConnection({ host: '127.0.0.1', port }));
      await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.once('data', data => { expect(data.toString()).toBe('synthetic'); resolve(); }); socket.once('connect', () => socket.write('synthetic')); });
      const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
      gate.block(); await closed; await denied(port);
      expect(gate.server.listening).toBe(true);
    } finally { await gate.close(); }
  });
  it('verifies the browser route separately from SSH readiness and blocks stale URLs after disconnect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hp-login-test-'));
    const launches: string[][] = [];
    let remotePort = 0;
    const spawnProcess = ((executable: string, args: string[]) => {
      const child = new EventEmitter() as ChildProcess;
      child.stderr = new EventEmitter() as ChildProcess['stderr']; Object.defineProperty(child,'exitCode',{value:null});
      child.kill = () => { child.emit('exit', 0); return true; };
      if (executable === 'synthetic-browser') { launches.push(args); return child; }
      const upstream = Number(args[args.indexOf('-D') + 1].split(':').at(-1));
      const proofPort = Number(args[args.indexOf('-R') + 1].split(':').at(-1));
      void (async () => {
        remotePort = await listen(createServer(client => {
          track(client); const target = track(createConnection({ host: '127.0.0.1', port: proofPort })); client.pipe(target).pipe(client);
          client.on('close', () => target.destroy()); target.on('close', () => client.destroy());
        }));
        await listen(createServer(client => {
          track(client); let stage = 0, buffer = Buffer.alloc(0);
          const handle = (data: Buffer) => {
            buffer = Buffer.concat([buffer, data]);
            if (stage === 0 && buffer.length >= 3) { buffer = buffer.subarray(3); stage = 1; client.write(Buffer.from([5, 0])); }
            if (stage === 1 && buffer.length >= 7 && buffer.length >= 7 + buffer[4]) {
              const host = buffer.subarray(5, 5 + buffer[4]).toString(); const port = buffer.readUInt16BE(5 + buffer[4]);
              expect(host).toBe('127.0.0.1'); expect(port).toBe(remotePort);
              client.removeListener('data', handle);
              const target = track(createConnection({ host, port }, () => { client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); client.pipe(target).pipe(client); }));
              client.on('close', () => target.destroy()); target.on('close', () => client.destroy());
            }
          }; client.on('data', handle);
        }), upstream);
        child.stderr!.emit('data', Buffer.from(`Local forwarding listening on 127.0.0.1 port ${upstream}.\nAllocated port ${remotePort} for remote forward to 127.0.0.1:${proofPort}\n`));
      })();
      return child;
    }) as typeof spawn;
    const manager = new BrowserLoginManager({ dataDir: directory, onState: () => {}, spawnProcess, findBrowser: () => ({ path: 'synthetic-browser', name: 'Synthetic' }) });
    try {
      await manager.prepare(TEST_NODE);
      expect(manager.snapshot().phase).toBe('waiting'); expect(manager.snapshot().routeVerified).toBe(false);
      await expect(manager.openAuthorization('other-node', auth)).rejects.toThrow('不可用');
      await manager.openAuthorization(TEST_NODE.id, auth);
      const args = launches[0], gatePort = Number(args.find(value => value.startsWith('--proxy-server='))!.split(':').at(-1));
      const probe = new URL(args.at(-1)!);
      expect(args.join(' ')).not.toContain('synthetic-state');
      const result = await socksRequest(gatePort, '127.0.0.1', Number(probe.port), `GET ${probe.pathname} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n`);
      expect(result).toContain('302'); expect(result).toContain(auth);
      expect(manager.snapshot().routeVerified).toBe(true);
      await manager.openAuthorization(TEST_NODE.id, auth); expect(launches).toHaveLength(1);
      manager.block(); expect(manager.snapshot().routeVerified).toBe(false); await denied(gatePort);
      await expect(manager.openAuthorization(TEST_NODE.id, auth)).rejects.toThrow('不可用');
    } finally { await manager.dispose(); }
  });
});
