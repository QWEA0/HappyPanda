import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { strict as assert } from 'node:assert';
import { BrowserLoginManager, socksRequest } from '../src/main/login-browser';
import { smokeNode } from './smoke-node';

const node = smokeNode();
await mkdir(resolve('.local'), { recursive: true });
const directory = await mkdtemp(join(resolve('.local'), 'login-browser-smoke-'));
const launches: string[][] = [];
const manager = new BrowserLoginManager({ dataDir: directory, onState: () => {},
  findBrowser: () => ({ path: 'synthetic-browser', name: 'Synthetic browser' }),
  spawnProcess: ((executable, args, options) => {
    if (executable !== 'synthetic-browser') return spawn(executable, args ?? [], options ?? {});
    launches.push(args as string[]);
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, 'exitCode', { value: null }); child.kill = () => true;
    return child;
  }) as typeof spawn,
});
try {
  await manager.prepare(node);
  assert.equal(manager.snapshot().phase, 'waiting');
  assert.equal(manager.snapshot().routeVerified, false);
  const url = 'https://claude.com/cai/oauth/authorize?response_type=code&state=synthetic-state&code_challenge=synthetic-challenge&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fcallback';
  await manager.openAuthorization(node.id, url);
  const args = launches[0], proxy = Number(args.find(value => value.startsWith('--proxy-server='))!.split(':').at(-1));
  const probe = new URL(args.at(-1)!);
  assert(!args.join(' ').includes('synthetic-state'));
  // Emulates the browser's HTTP navigation through the actual SSH SOCKS and reverse forwards.
  const response = await socksRequest(proxy, 'localhost', Number(probe.port), `GET ${probe.pathname} HTTP/1.0\r\nHost: localhost\r\n\r\n`);
  assert.match(response, /^HTTP\/1\.[01] 302/); assert(response.includes(url));
  assert.equal(manager.snapshot().routeVerified, true);
  manager.block();
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: proxy });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Blocked proxy did not close')); }, 3000);
    socket.on('connect', () => socket.write(Buffer.from([5, 1, 0])));
    socket.on('error', () => {});
    socket.on('data', () => { clearTimeout(timer); socket.destroy(); reject(new Error('Blocked proxy accepted traffic')); });
    socket.on('close', () => { clearTimeout(timer); resolve(); });
  });
  assert.equal(manager.snapshot().routeVerified, false);
  await assert.rejects(manager.openAuthorization(node.id, url));
  const result = { passed: true, checks: ['real_ssh_socks_and_reverse_forward', 'remote_loopback_callback_routing', 'browser_probe_separate_from_tunnel_readiness', 'no_oauth_url_in_process_arguments', 'disconnect_closes_proxy_traffic', 'stale_authorization_blocked'], realBrowser: false, realOAuthLogin: false, completedAt: new Date().toISOString() };
  await writeFile(resolve('.local/login-browser-smoke-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await manager.dispose(); }
