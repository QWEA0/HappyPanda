import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BrowserLoginState, ServiceNode } from '../shared/types';
import { sshArgs, sshExecutable } from './ssh';
import { sshEnvironment } from './ssh-auth';
import type { LoginNetworkCheck } from './login-network';

const authorizationHosts = new Set(['claude.com', 'claude.ai', 'console.anthropic.com', 'platform.claude.com']);
export function authorizationUrl(input: string): string {
  try {
    if (input.length > 16384 || /[\s\x00-\x1f\x7f]/.test(input)) throw new Error();
    const url = new URL(input);
    if (url.protocol !== 'https:' || !authorizationHosts.has(url.hostname) || url.port || url.username || url.password || url.hash ||
        !/^\/(?:cai\/)?oauth\/authorize\/?$/.test(url.pathname) || url.searchParams.get('response_type') !== 'code' ||
        !url.searchParams.get('state') || !url.searchParams.get('code_challenge')) throw new Error();
    const callback = new URL(url.searchParams.get('redirect_uri') || '');
    if (!(callback.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname)) &&
        !(callback.protocol === 'https:' && authorizationHosts.has(callback.hostname))) throw new Error();
    if (callback.username || callback.password) throw new Error();
    return url.href;
  } catch { throw new Error('授权链接无效，请重新发起官方登录。'); }
}

export function isAuthorizationLink(input: string) {
  try { const url = new URL(input); return authorizationHosts.has(url.hostname) && /^\/(?:cai\/)?oauth\/authorize\/?$/.test(url.pathname); }
  catch { return false; }
}

export function browserArguments(profile: string, proxyPort: number, routeUrl: string) {
  return [`--user-data-dir=${profile}`, `--proxy-server=socks5://127.0.0.1:${proxyPort}`,
    '--proxy-bypass-list=<-loopback>',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-quic',
    '--no-first-run', '--no-default-browser-check', '--new-window', routeUrl];
}

export function findLoginBrowser() {
  const candidates = [process.env.HAPPYPANDA_BROWSER_PATH,
    ...(process.platform === 'win32' ? [
      join(process.env.ProgramFiles || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
      join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
      join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'Google/Chrome/Application/chrome.exe'),
      join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
      join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
    ] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] :
      ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'])];
  const path = candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  if (!path) throw new Error('未找到 Chrome 或 Edge，请安装其中一个浏览器后再登录。');
  return { path, name: /edge/i.test(path) ? 'Microsoft Edge' : /chromium/i.test(path) ? 'Chromium' : 'Google Chrome' };
}

/** Keeps the browser endpoint bound even while SSH is down. Never dials a destination directly. */
export class ProxyGate {
  readonly server: Server;
  private sockets = new Set<Socket>();
  private upstream?: number;
  constructor() {
    this.server = createServer(client => {
      if (!this.upstream) { client.destroy(); return; }
      const upstream = createConnection({ host: '127.0.0.1', port: this.upstream });
      this.sockets.add(client); this.sockets.add(upstream);
      const close = () => { this.sockets.delete(client); this.sockets.delete(upstream); client.destroy(); upstream.destroy(); };
      client.on('error', close); upstream.on('error', close); client.on('close', close); upstream.on('close', close);
      client.pipe(upstream).pipe(client);
    });
  }
  async listen(port: number) {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen({ host: '127.0.0.1', port, exclusive: true }, () => { this.server.removeListener('error', reject); resolve(); });
    });
    return (this.server.address() as { port: number }).port;
  }
  enable(port: number) { this.block(); this.upstream = port; }
  block() { this.upstream = undefined; for (const socket of this.sockets) socket.destroy(); this.sockets.clear(); }
  async close() { this.block(); if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve())); }
}

export async function openPersistentProxyGate(dataDir: string, identity: string) {
  const directory=join(dataDir,'login-proxy-ports');
  const target=join(directory,identity+'.json');
  let savedPort:number|undefined;
  try{
    const record=JSON.parse(await readFile(target,'utf8'));
    if(!Number.isInteger(record.port)||record.port<1024||record.port>65535)throw new Error('invalid');
    savedPort=record.port;
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('节点登录代理端口配置无效，原文件已保留。');}
  const gate=new ProxyGate();
  let port:number;
  try{port=await gate.listen(savedPort??0);}catch{throw new Error('节点登录代理端口被占用，已停止登录。请关闭旧客户端后重试。');}
  try{
    if(savedPort===undefined){
      await mkdir(directory,{recursive:true,mode:0o700});
      const temporary=target+'.'+randomBytes(8).toString('hex')+'.tmp';
      await writeFile(temporary,JSON.stringify({port}),{mode:0o600});
      await rename(temporary,target);
    }
    return {gate,port};
  }catch(error){await gate.close();throw error;}
}

async function sparePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

/** The destination is sent to SOCKS as a domain; it is never resolved on this computer. */
export async function socksRequest(proxyPort: number, host: string, port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: proxyPort });
    let buffer = Buffer.alloc(0), stage = 0, response = '', settled = false;
    const timer = setTimeout(() => finish(new Error('SSH 登录路由探测超时。')), 12000);
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(response);
    };
    socket.on('error', () => finish(new Error('SSH 登录代理连接失败。')));
    socket.on('connect', () => socket.write(Buffer.from([5, 1, 0])));
    socket.on('end', () => stage === 2 ? finish() : finish(new Error('SSH 登录代理未完成握手。')));
    socket.on('close', () => { if (!settled) finish(new Error('SSH 登录代理连接中断。')); });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 65536) { finish(new Error('登录路由探测响应过大。')); return; }
      if (stage === 0 && buffer.length >= 2) {
        if (buffer[0] !== 5 || buffer[1] !== 0) { finish(new Error('SSH 登录代理握手失败。')); return; }
        buffer = buffer.subarray(2); stage = 1;
        const domain = Buffer.from(host), destination = Buffer.alloc(2); destination.writeUInt16BE(port);
        socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, domain.length]), domain, destination]));
      }
      if (stage === 1 && buffer.length >= 5) {
        if (buffer[0] !== 5 || buffer[1] !== 0) { finish(new Error('SSH 登录代理无法到达节点回调端口。')); return; }
        const bytes = buffer[3] === 1 ? 10 : buffer[3] === 4 ? 22 : buffer[3] === 3 ? 7 + buffer[4] : 0;
        if (!bytes) { finish(new Error('无效的 SSH 登录代理响应。')); return; }
        if (buffer.length < bytes) return;
        buffer = buffer.subarray(bytes); stage = 2; socket.write(request);
      }
      if (stage === 2) { response += buffer.toString('utf8'); buffer = Buffer.alloc(0); if (response.length > 65536) finish(new Error('登录路由探测响应过大。')); }
    });
  });
}

interface Route {
  node: ServiceNode; gate: ProxyGate; port: number; profile: string;
  proof?: HttpServer; ssh?: ChildProcess; browser?: ChildProcess; remoteProofPort?: number;
  pending?: { nonce: string; url: string; expires: number; timer: ReturnType<typeof setTimeout> };
  lastUrl?: string;
  networkCheck?: AbortController;
  authorizationTimer?: ReturnType<typeof setTimeout>;
}
interface BrowserLoginOptions {
  dataDir: string;
  onState: (state: BrowserLoginState) => void;
  spawnProcess?: typeof spawn;
  findBrowser?: typeof findLoginBrowser;
  checkNetwork?: (proxyPort: number, signal: AbortSignal) => Promise<LoginNetworkCheck>;
}

export class BrowserLoginManager {
  private routes = new Map<string, Route>();
  private active?: Route;
  private generation = 0;
  private state: BrowserLoginState = { phase: 'idle', message: '', routeVerified: false };
  private spawnProcess: typeof spawn;
  constructor(private options: BrowserLoginOptions) { this.spawnProcess = options.spawnProcess || spawn; }
  snapshot() { return { ...this.state }; }
  private publish(patch: Partial<BrowserLoginState>) { this.state = { ...this.state, ...patch }; this.options.onState(this.snapshot()); }
  private clearPending(route: Route) { if (route.pending) clearTimeout(route.pending.timer); route.pending = undefined; }
  block(message = '节点已断开，登录浏览器连接已阻断。') {
    ++this.generation;
    for (const route of this.routes.values()) {
      route.gate.block(); this.clearPending(route); route.lastUrl = undefined;
      route.networkCheck?.abort();route.networkCheck=undefined;
      if(route.authorizationTimer)clearTimeout(route.authorizationTimer);route.authorizationTimer=undefined;
      const ssh = route.ssh; route.ssh = undefined; ssh?.kill();
      route.proof?.closeAllConnections(); route.proof?.close(); route.proof = undefined; route.remoteProofPort = undefined;
    }
    if (this.active) this.publish({ phase: 'blocked', message, routeVerified: false, network: undefined });
  }
  fail(message: string) { this.block(message); this.publish({ phase: 'failed', message, routeVerified: false }); }
  authenticated() { if(this.active?.authorizationTimer)clearTimeout(this.active.authorizationTimer);this.active?.networkCheck?.abort();this.publish({ phase: 'authenticated', network: undefined, message: '官方账号登录完成，浏览器仍通过当前节点连接。' }); }
  private async inspectNetwork(route:Route){
    route.networkCheck?.abort();
    if(!this.options.checkNetwork)return;
    const controller=new AbortController();route.networkCheck=controller;
    this.publish({network:{phase:'checking',message:'正在检查授权站点和入口脚本…'}});
    try{
      const result=await this.options.checkNetwork(route.port,controller.signal);
      if(controller.signal.aborted||this.active!==route||route.networkCheck!==controller||!route.ssh)return;
      this.publish({network:result});
    }catch{
      if(!controller.signal.aborted&&this.active===route)this.publish({network:{phase:'failed',message:'网页连接检查未完成，请重新登录后再试。'}});
    }
  }
  async prepare(node: ServiceNode) {
    this.block(); const generation = this.generation;
    const browser = (this.options.findBrowser || findLoginBrowser)();
    this.publish({ phase: 'preparing', nodeId: node.id, browserName: browser.name, message: '正在建立节点登录通道…', routeVerified: false, network: undefined });
    let route = this.routes.get(node.id);
    let ownedProof:HttpServer|undefined,ownedSsh:ChildProcess|undefined;
    try {
      if (!route) {
        const identity = createHash('sha256').update(this.options.dataDir + '\0' + node.id).digest();
        // Let the OS pick a usable port once, then pin it across restarts for this node.
        const {gate,port}=await openPersistentProxyGate(this.options.dataDir,identity.toString('hex'));
        route = { node, gate, port, profile: join(this.options.dataDir, 'login-browser', identity.toString('hex').slice(0, 24)) };
        this.routes.set(node.id, route);
      }
      this.active = route; route.node = node;
      // A retry starts one fresh window, rather than reusing a stale authorization page.
      if(route.browser&&route.browser.exitCode===null){
        const child=route.browser;
        await new Promise<void>((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error('旧登录浏览器尚未关闭，请关闭该窗口后重试。')),4000);
          child.once('exit',()=>{clearTimeout(timer);resolve();});
          if(!child.kill()){clearTimeout(timer);if(child.exitCode!==null)resolve();else reject(new Error('无法关闭旧登录浏览器，请关闭该窗口后重试。'));}
        });
      }
      route.browser=undefined;
      if (generation !== this.generation) throw new Error('登录已取消。');
      await mkdir(route.profile, { recursive: true, mode: 0o700 });
      if (generation !== this.generation) throw new Error('登录已取消。');
      const healthNonce = randomBytes(24).toString('hex');
      const current = route;
      const proof = createHttpServer((request, response) => {
        response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer');
        if (request.method !== 'GET') { response.writeHead(405).end(); return; }
        if (request.url === '/tunnel/' + healthNonce) { response.writeHead(200).end(healthNonce); return; }
        const pending = current.pending;
        if (this.active === current && current.ssh && pending && request.url === '/route/' + pending.nonce && pending.expires > Date.now()) {
          this.clearPending(current);
          this.publish({ phase: 'ready', message: '节点通道已连通，正在等待浏览器完成授权。', routeVerified: true });
          void this.inspectNetwork(current);
          if(current.authorizationTimer)clearTimeout(current.authorizationTimer);
          current.authorizationTimer=setTimeout(()=>{
            if(this.active===current&&this.state.phase==='ready')this.publish({message:'尚未收到登录结果。如果网页持续空白或转圈，请点击重新登录；如果页面给出授权码，请粘贴到终端。'});
          },90000);
          response.writeHead(302, { Location: pending.url }).end(); return;
        }
        response.writeHead(410).end('This login link has expired. Start login again in HappyPanda.');
      });
      route.proof = proof;
      ownedProof = proof;
      await new Promise<void>((resolve, reject) => { proof.once('error', reject); proof.listen(0, '127.0.0.1', resolve); });
      const proofPort = (proof.address() as { port: number }).port;
      const upstream = await sparePort();
      if (generation !== this.generation) throw new Error('登录已取消。');
      const args = [...sshArgs(node), '-S', 'none', '-v', '-o', 'ExitOnForwardFailure=yes', '-N',
        '-D', `127.0.0.1:${upstream}`, '-R', `127.0.0.1:0:127.0.0.1:${proofPort}`, node.sshTarget];
      const ssh = this.spawnProcess(sshExecutable(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env:sshEnvironment(node) });
      route.ssh = ssh;
      ownedSsh = ssh;
      const remotePort = await new Promise<number>((resolve, reject) => {
        let output = '', localReady = false, remote = 0, done = false;
        const timer = setTimeout(() => finish(new Error('SSH 登录通道建立超时。')), 25000);
        const finish = (error?: Error) => {
          if (done) return; done = true; clearTimeout(timer);
          if (error) reject(error); else resolve(remote);
        };
        ssh.stderr?.on('data', data => {
          output = (output + data.toString()).slice(-16384);
          localReady ||= output.includes(`Local forwarding listening on 127.0.0.1 port ${upstream}.`);
          const match = output.match(/Allocated port (\d+) for remote forward/); if (match) remote = Number(match[1]);
          if (localReady && remote > 0 && remote < 65536) finish();
        });
        ssh.once('error', () => finish(new Error('无法启动 SSH 登录通道。')));
        ssh.once('exit', () => {
          finish(new Error('SSH 登录通道已断开。'));
          if (current.ssh === ssh) this.block('SSH 登录通道已断开，浏览器连接已阻断。');
        });
      });
      if (remotePort === proofPort || remotePort === route.port) throw new Error('登录路由端口冲突，已停止登录，请重试。');
      const response = await socksRequest(upstream, '127.0.0.1', remotePort, `GET /tunnel/${healthNonce} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n`);
      if (!response.includes(healthNonce) || !/^HTTP\/1\.[01] 200\b/.test(response)) throw new Error('节点登录路由验证失败。');
      if (generation !== this.generation || route.ssh !== ssh) throw new Error('登录已取消。');
      route.remoteProofPort = remotePort; route.gate.enable(upstream);
      this.publish({ phase: 'waiting', message: '节点通道已就绪，正在等待 Claude 授权链接。', routeVerified: false });
    } catch (error) {
      if (generation === this.generation) this.fail(error instanceof Error ? error.message : '节点登录通道建立失败。');
      else { ownedSsh?.kill(); ownedProof?.closeAllConnections(); ownedProof?.close(); }
      throw error;
    }
  }
  async openAuthorization(nodeId: string, input: string) {
    const url = authorizationUrl(input), route = this.active;
    if (!route || route.node.id !== nodeId || !route.ssh || !route.remoteProofPort) throw new Error('节点登录通道不可用，请重新发起登录。');
    if (route.lastUrl === url && route.browser?.exitCode === null) return;
    const browser = (this.options.findBrowser || findLoginBrowser)();
    this.clearPending(route); route.lastUrl = url;
    const nonce = randomBytes(32).toString('hex');
    const timer = setTimeout(() => {
      if (route.pending?.nonce === nonce) this.fail('浏览器未通过节点路由验证，已阻断登录。请关闭该节点的登录浏览器后重试。');
    }, 45000);
    route.pending = { nonce, url, expires: Date.now() + 45000, timer };
    const probe = `http://127.0.0.1:${route.remoteProofPort}/route/${nonce}`;
    this.publish({ phase: 'opening', message: '正在验证浏览器是否通过当前节点连接…', routeVerified: false });
    try {
      const child = this.spawnProcess(browser.path, browserArguments(route.profile, route.port, probe), { windowsHide: true, stdio: 'ignore' });
      // Reusing this isolated profile may forward the URL to its already-running browser process.
      if (!route.browser || route.browser.exitCode !== null) route.browser = child;
      child.once('error', () => { if (route.pending?.nonce === nonce) this.fail('登录浏览器启动失败。'); });
      child.once('exit', code => {
        if (code && route.pending?.nonce === nonce) this.fail('登录浏览器启动失败。');
        if(route.browser===child&&!route.pending&&this.state.phase==='ready')this.publish({message:'登录浏览器已关闭，尚未完成授权。请点击重新登录。'});
      });
    } catch { this.fail('登录浏览器启动失败。'); throw new Error('登录浏览器启动失败。'); }
  }
  async dispose() {
    this.block();
    for (const route of this.routes.values()) { route.browser?.kill(); await route.gate.close(); }
    this.routes.clear(); this.active = undefined;
  }
}
