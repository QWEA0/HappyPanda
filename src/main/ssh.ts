import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import SSHConfig from 'ssh-config';
import { existsSync, mkdirSync } from 'node:fs';
import type { ServiceNode, SshAlias } from '../shared/types';
import { timed } from './perf';

export const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
export function sshExecutable(){
  const candidate=process.platform==='win32'?join(process.env.SystemRoot??'C:\\Windows','System32','OpenSSH','ssh.exe'):'/usr/bin/ssh';
  return existsSync(candidate)?candidate:'ssh';
}
export function scpExecutable(){
  const candidate=process.platform==='win32'?join(process.env.SystemRoot??'C:\\Windows','System32','OpenSSH','scp.exe'):'/usr/bin/scp';
  return existsSync(candidate)?candidate:'scp';
}
export function sshArgs(node: ServiceNode) {
  const args = ['-o','BatchMode=yes','-o','ConnectTimeout=12','-o','StrictHostKeyChecking=yes','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3'];
  if (node.user) args.push('-l',node.user);
  if (node.port) args.push('-p',String(node.port));
  if (node.identityFile) args.push('-i',node.identityFile);
  return args;
}
// One-shot commands (remote helpers, git, scp) share a persistent SSH connection.
// The interactive PTY, -R/-L forwards and login routing deliberately do NOT use
// it: a forward bound by a lingering master would outlive its session.
let muxPath:string|null|undefined;
export function muxArgs():string[] {
  if(process.platform==='win32'||process.env.HAPPYPANDA_SSH_MUX==='0')return [];
  if(muxPath===undefined){
    try{
      const directory=join(tmpdir(),'hp-ssh-'+(process.getuid?.()??'u'));
      mkdirSync(directory,{recursive:true,mode:0o700});
      muxPath=join(directory,'%C');
    }catch{muxPath=null;}
  }
  return muxPath?['-o','ControlMaster=auto','-o','ControlPath='+muxPath,'-o','ControlPersist=120']:[];
}
export function runProcess(executable: string, args: string[], input?: string|Buffer, timeoutMs=45000): Promise<string> {
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',settled=false;
    const finish=(error?:Error)=>{ if(settled)return; settled=true; clearTimeout(timer); if(error)reject(error);else resolve(stdout); };
    const timer=setTimeout(()=>{child.kill();finish(new Error(executable+' timed out'));},timeoutMs);
    child.stdout.on('data',data=>{stdout+=data.toString();if(stdout.length>8*1024*1024){child.kill();finish(new Error('Command output exceeded limit'));}});
    child.stderr.on('data',data=>{stderr=(stderr+data.toString()).slice(-16384);});
    child.on('error',error=>finish(error));
    child.stdin.on('error',()=>{});
    child.on('close',code=>finish(code===0?undefined:new Error(stderr.trim()||executable+' exited with '+code)));
    child.stdin.end(input);
  });
}
// ---- Persistent command channel -------------------------------------------------
// Opening an SSH connection costs seconds on some links and Windows OpenSSH has no
// ControlMaster. One long-lived `ssh` runs a tiny command server on the node; every
// runRemote call is a JSON line over that connection instead of a new handshake.
// Anything that goes wrong before the channel is ready falls back to a one-shot ssh.
export const CHANNEL_SERVER = String.raw`
import sys, os, json, base64, subprocess, threading
lock = threading.Lock()
shell = os.environ.get("SHELL") or "/bin/sh"
def reply(value):
    data = (json.dumps(value) + "\n").encode()
    with lock:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
def handle(request):
    ident = request.get("id")
    try:
        done = subprocess.run([shell, "-c", request["command"]], input=base64.b64decode(request.get("input") or ""),
                              capture_output=True)
        reply({"id": ident, "code": done.returncode, "stdout": base64.b64encode(done.stdout).decode(),
               "stderr": base64.b64encode(done.stderr[-16384:]).decode()})
    except Exception as error:
        reply({"id": ident, "error": str(error)})
reply({"ready": True})
for line in sys.stdin.buffer:
    try:
        request = json.loads(line)
    except ValueError:
        continue
    threading.Thread(target=handle, args=(request,), daemon=True).start()
`;

export class SshChannel {
  private child?: ChildProcess;
  private pending = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = '';
  private nextId = 1;
  private dead = false;
  private readonly ready: Promise<void>;
  constructor(launch: () => ChildProcess, readyTimeoutMs = 30000) {
    this.ready = new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try { child = launch(); } catch (error) { this.dead = true; reject(error as Error); return; }
      this.child = child;
      const timer = setTimeout(() => { this.close(); reject(new Error('SSH channel did not become ready')); }, readyTimeoutMs);
      let isReady = false;
      child.stdout!.on('data', (data: Buffer) => {
        this.buffer += data.toString('utf8');
        if (this.buffer.length > 64 * 1024 * 1024) { this.close(); return; }
        for (let newline = this.buffer.indexOf('\n'); newline >= 0; newline = this.buffer.indexOf('\n')) {
          const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
          if (!line.startsWith('{')) continue; // login banners and shell noise
          let message: { ready?: boolean; id?: number; code?: number; stdout?: string; stderr?: string; error?: string };
          try { message = JSON.parse(line); } catch { continue; }
          if (message.ready) { isReady = true; clearTimeout(timer); resolve(); continue; }
          const entry = message.id === undefined ? undefined : this.pending.get(message.id);
          if (!entry) continue;
          this.pending.delete(message.id!); clearTimeout(entry.timer);
          const stderr = Buffer.from(message.stderr ?? '', 'base64').toString('utf8').trim();
          if (message.error) entry.reject(new Error(message.error));
          else if (message.code !== 0) entry.reject(new Error(stderr || 'ssh exited with ' + message.code));
          else entry.resolve(Buffer.from(message.stdout ?? '', 'base64').toString('utf8'));
        }
      });
      child.stdin!.on('error', () => {});
      child.stderr?.on('data', () => {});
      const ended = (error?: Error) => {
        this.dead = true; clearTimeout(timer);
        if (!isReady) reject(error ?? new Error('SSH channel closed before it was ready'));
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('SSH connection closed')); }
        this.pending.clear();
      };
      child.once('error', ended);
      child.once('close', () => ended());
    });
    this.ready.catch(() => {});
  }
  get usable() { return !this.dead; }
  async run(command: string, input: string | Buffer | undefined, timeoutMs: number): Promise<string> {
    await this.ready;
    if (this.dead || !this.child?.stdin?.writable) throw new Error('SSH connection closed');
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      // A call that timed out may have wedged the connection: don't reuse it.
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('ssh timed out')); this.close(); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const encoded = input === undefined ? '' : Buffer.from(input).toString('base64');
      this.child!.stdin!.write(JSON.stringify({ id, command, input: encoded }) + '\n', error => {
        if (error && this.pending.delete(id)) { clearTimeout(timer); reject(error); }
      });
    });
  }
  close() { this.dead = true; try { this.child?.kill(); } catch { /* already gone */ } }
}

const channels = new Map<string, SshChannel>();
const channelKey = (node: ServiceNode) => [node.sshTarget, node.user ?? '', node.port ?? '', node.identityFile ?? ''].join('|');
function channelFor(node: ServiceNode): SshChannel {
  const key = channelKey(node);
  let channel = channels.get(key);
  if (!channel || !channel.usable) {
    const script = 'import base64;exec(base64.b64decode(' + JSON.stringify(Buffer.from(CHANNEL_SERVER).toString('base64')) + '))';
    channel = new SshChannel(() => spawn(sshExecutable(), [...sshArgs(node), node.sshTarget, 'python3 -u -c ' + shellQuote(script)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
    channels.set(key, channel);
  }
  return channel;
}
export function closeSshChannels() {
  for (const channel of channels.values()) channel.close();
  channels.clear();
}
const channelDisabled = () => process.env.HAPPYPANDA_SSH_CHANNEL === '0';

async function remoteCommand(node: ServiceNode, command: string, input?: string | Buffer, timeoutMs = 45000): Promise<string> {
  if (!channelDisabled()) {
    const channel = channelFor(node);
    try { return await channel.run(command, input, timeoutMs); }
    catch (error) {
      // Only a channel that never became usable falls back; a command that ran and
      // failed (or a dropped connection mid-command) must not be executed twice.
      if (channel.usable || (error as Error).message === 'SSH connection closed' || (error as Error).message === 'ssh timed out') throw error;
      channels.delete(channelKey(node));
    }
  }
  return runProcess(sshExecutable(), [...sshArgs(node), ...muxArgs(), node.sshTarget, command], input, timeoutMs);
}
export const runRemote = (node:ServiceNode,command:string,input?:string|Buffer,timeoutMs=45000) => timed('ssh '+command.slice(0,48).replace(/\s+/g,' '),()=>remoteCommand(node,command,input,timeoutMs));
export async function uploadFile(node:ServiceNode,localPath:string,remotePath:string,timeoutMs=180000) {
  const args=['-q','-o','BatchMode=yes','-o','ConnectTimeout=12','-o','StrictHostKeyChecking=yes',...muxArgs()];
  if(node.port)args.push('-P',String(node.port));
  if(node.identityFile)args.push('-i',node.identityFile);
  const target=(node.user?node.user+'@':'')+node.sshTarget;
  await runProcess(scpExecutable(),[...args,localPath,target+':'+remotePath],undefined,timeoutMs);
}
export async function downloadFile(node:ServiceNode,localPath:string,remotePath:string) {
  const args=['-q','-o','BatchMode=yes','-o','ConnectTimeout=12','-o','StrictHostKeyChecking=yes',...muxArgs()];
  if(node.port)args.push('-P',String(node.port));
  if(node.identityFile)args.push('-i',node.identityFile);
  const target=(node.user?node.user+'@':'')+node.sshTarget;
  await runProcess(scpExecutable(),[...args,target+':'+remotePath,localPath],undefined,180000);
}
export async function listSshAliases():Promise<SshAlias[]> {
  try {
    const config=SSHConfig.parse(await readFile(join(homedir(),'.ssh','config'),'utf8'));
    const names=new Set<string>();
    for(const entry of config) {
      if(entry.type===1 && entry.param?.toLowerCase()==='host') {
        const values=Array.isArray(entry.value)?entry.value.map(value=>value.val):[entry.value];
        for(const name of values) if(typeof name==='string'&&!/[*!?]/.test(name)&&/^[A-Za-z0-9_.-]+$/.test(name))names.add(name);
      }
    }
    return [...names].map(name=>({name}));
  }catch{return [];}
}
export async function remoteHome(node:ServiceNode) {
  const home=(await runRemote(node,'printf "%s" "$HOME"')).trim();
  if(!home.startsWith('/')||/[\r\n\0]/.test(home))throw new Error('Unsupported remote home path');
  return home;
}
