import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { InventoryStore } from './store';
import type { ServiceNode } from '../shared/types';
import {knownRemoteRuntime} from './remote-platform';

const environments = new Map<string, () => NodeJS.ProcessEnv>();
const transports = new Map<string,string>();
export const sshTransportDirectory = (node:ServiceNode) => transports.get(node.id);
export function sshEnvironment(node: ServiceNode): NodeJS.ProcessEnv {
  if (node.authType !== 'password') return { ...process.env };
  const environment = environments.get(node.id);
  if (!environment) throw new Error('SSH password authentication is not initialized');
  return environment();
}

export function authenticationArgs(node: Pick<ServiceNode, 'authType'>): string[] {
  return node.authType === 'password'
    ? ['-o', 'BatchMode=no', '-o', 'PreferredAuthentications=password,keyboard-interactive',
      '-o', 'PasswordAuthentication=yes', '-o', 'KbdInteractiveAuthentication=yes',
      '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1']
    : ['-o', 'BatchMode=yes'];
}

// Only parse transport options before the SSH destination, never the remote command.
export function transportAddress(kind: 'ssh' | 'scp', args: string[]) {
  let user: string | undefined, port: number | undefined;
  const values = kind === 'ssh' ? 'BbcDEeFIiJLlmOopQRSWw' : 'cDFiJloPSX';
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg.startsWith('-') && arg !== '--') {
      const option = arg[1];
      if (values.includes(option)) {
        const value = arg.length > 2 ? arg.slice(2) : args[++index];
        if (option === 'l' && kind === 'ssh') user = value;
        if (option === (kind === 'ssh' ? 'p' : 'P')) port = Number(value);
      }
      continue;
    }
    if (arg === '--') continue;
    if (kind === 'scp' && !/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9_.-]+:(?![\\/])/.test(arg) &&
      !/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9_.-]{2,}:\//.test(arg)) continue;
    const target = kind === 'scp' ? arg.slice(0, arg.indexOf(':')) : arg;
    const parts = target.split('@');
    return { host: parts.at(-1)!, user: user ?? (parts.length === 2 ? parts[0] : undefined), port: port ?? 22 };
  }
  throw new Error('SSH destination is missing');
}

interface Options {
  dataDir: string;
  resourcesDir: string;
  store: InventoryStore;
  sshExecutable: string;
  scpExecutable: string;
}

export class SshAuthentication {
  private server?: Server;
  private token = randomBytes(32).toString('hex');
  private preferred = new Map<string, string>();
  private registered = new Set<string>();
  private installed?: Promise<void>;
  readonly directory: string;
  private configPath: string;
  private helperPath: string;
  constructor(private options: Options) {
    this.directory = resolve(options.dataDir, 'ssh-transport');
    this.configPath = join(this.directory, 'config.json');
    this.helperPath = join(this.directory, process.platform === 'win32' ? 'askpass.exe' : 'askpass');
  }
  private key(address: ReturnType<typeof transportAddress>) { return JSON.stringify(address); }
  register(node: ServiceNode) {
    transports.set(node.id,this.directory);
    this.registered.add(node.id);
    if (node.authType !== 'password') { environments.delete(node.id); return; }
    environments.set(node.id, () => {
      this.options.store.password(node.id);
      return {...process.env, SSH_ASKPASS:this.helperPath, SSH_ASKPASS_REQUIRE:'force', DISPLAY:'happypanda',
        HAPPYPANDA_SSH_CONFIG:this.configPath, HAPPYPANDA_SSH_NODE:node.id};
    });
  }
  private route(kind: 'ssh' | 'scp', args: string[]) {
    const address = transportAddress(kind, args);
    const candidates = this.options.store.nodes.filter(node => {
      const parts = node.sshTarget.split('@');
      return parts.at(-1) === address.host && (node.user ?? (parts.length === 2 ? parts[0] : undefined)) === address.user &&
        (node.port ?? 22) === address.port;
    });
    const node = candidates.find(item => item.id === this.preferred.get(this.key(address))) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (candidates.length > 1 && !node) throw new Error('SSH destination matches multiple nodes; reconnect the intended node');
    const options = node ? authenticationArgs(node) : ['-o', 'BatchMode=yes'];
    options.push('-o', 'StrictHostKeyChecking=yes');
    if (node?.authType !== 'password' && node?.identityFile) options.push('-i', node.identityFile);
    const runtime=node?knownRemoteRuntime(node):undefined;
    if(runtime?.platform==='windows'){
      if(kind==='scp')options.push('-S',join(this.directory,process.platform==='win32'?'ssh.exe':'ssh'));
      if(kind==='ssh'&&runtime.sftp&&args.includes('-s')&&args.at(-1)==='sftp'){
        args=args.filter(value=>value!=='-s').slice(0,-1).concat(runtime.sftp);
      }
      if(kind==='ssh'&&runtime.mutagenAgent){
        const agent=args.at(-1)?.match(/^["']?\.mutagen[\\/]agents[\\/][A-Za-z0-9_.-]+[\\/]mutagen-agent(?:\.exe)?["']?\s+(synchronizer|forwarder)(?:\s+(--log-level=[a-z]+))?$/);
        if(agent)args=args.slice(0,-1).concat(runtime.mutagenAgent,...agent.slice(1).filter((value):value is string=>Boolean(value)));
      }
    }
    return {executable:kind === 'ssh' ? this.options.sshExecutable : this.options.scpExecutable,
      args:[...options, ...args], nodeId:node?.authType === 'password' ? node.id : undefined};
  }
  private async install() {
    await mkdir(this.directory, {recursive:true, mode:0o700});
    const script = join(this.directory, 'ssh-helper.cjs');
    await copyFile(join(this.options.resourcesDir, 'ssh-helper.cjs'), script);
    for (const name of ['ssh', 'scp', 'askpass']) {
      const target = join(this.directory, name + (process.platform === 'win32' ? '.exe' : ''));
      if (process.platform === 'win32') {
        const source = [join(this.options.resourcesDir, '../tools/ssh-launcher.exe'),
          join(this.options.resourcesDir, '../.local/tools/ssh-launcher.exe')].find(existsSync);
        if (!source) throw new Error('SSH authentication helper is missing; rebuild the application');
        const previous = await readFile(target).catch(() => undefined);
        if (!previous?.equals(await readFile(source))) await copyFile(source, target);
      } else {
        const quote = (value:string) => "'" + value.replaceAll("'", "'\\''") + "'";
        await writeFile(target, '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ' + quote(process.execPath) + ' ' + quote(script) + ' ' + quote(this.configPath) + ' ' + name + ' "$@"\n', {mode:0o700});
      }
    }
  }
  async start() {
    this.server = createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const supplied = request.headers.authorization;
      if (request.method !== 'POST' || request.headers.origin || typeof supplied !== 'string' ||
        Buffer.byteLength(supplied) !== Buffer.byteLength(this.token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token))) {
        response.writeHead(403).end(); return;
      }
      try {
        let body = '';
        for await (const chunk of request) {body += chunk; if (body.length > 128 * 1024) throw new Error();}
        const input = JSON.parse(body);
        if (request.url === '/password') {
          const {nodeId, prompt} = z.object({nodeId:z.string(),prompt:z.string().max(4096)}).parse(input);
          if (!/password:\s*$/i.test(prompt) || /one.time|verification|otp|passphrase/i.test(prompt)) throw new Error();
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({password:this.options.store.password(nodeId)}));
        } else if (request.url === '/transport') {
          const {kind,args} = z.object({kind:z.enum(['ssh','scp']),args:z.array(z.string().max(32768)).max(256)}).parse(input);
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(this.route(kind,args)));
        } else response.writeHead(404).end();
      } catch { response.writeHead(400).end('SSH authentication request failed'); }
    });
    this.server.requestTimeout = 10000;
    this.server.headersTimeout = 10000;
    await new Promise<void>((resolve,reject) => {this.server!.once('error',reject);this.server!.listen(0,'127.0.0.1',resolve);});
    await mkdir(this.directory, {recursive:true, mode:0o700});
    const temporary = this.configPath + '.tmp';
    await writeFile(temporary, JSON.stringify({url:'http://127.0.0.1:'+(this.server.address() as import('node:net').AddressInfo).port,
      token:this.token, executable:process.execPath, script:join(this.directory,'ssh-helper.cjs')}), {mode:0o600});
    await rename(temporary,this.configPath);
    for (const node of this.options.store.nodes) this.register(node);
  }
  async prepare(node: ServiceNode) {
    this.installed ??= this.install().catch(error => {this.installed=undefined;throw error;});
    await this.installed;
    this.register(node);
    this.preferred.set(this.key(transportAddress('ssh', [...(node.port ? ['-p',String(node.port)] : []),
      ...(node.user ? ['-l',node.user] : []),node.sshTarget])),node.id);
    return this.directory;
  }
  async dispose() {
    for (const id of this.registered) {environments.delete(id);transports.delete(id);}
    if (this.server) {this.server.closeAllConnections();await new Promise<void>(resolve => this.server!.close(() => resolve()));}
  }
}
