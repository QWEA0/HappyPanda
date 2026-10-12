import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import SSHConfig from 'ssh-config';
import { existsSync } from 'node:fs';
import type { ServiceNode, SshAlias } from '../shared/types';

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
export const runRemote = (node:ServiceNode,command:string,input?:string|Buffer,timeoutMs=45000) => runProcess(sshExecutable(),[...sshArgs(node),node.sshTarget,command],input,timeoutMs);
export async function uploadFile(node:ServiceNode,localPath:string,remotePath:string,timeoutMs=180000) {
  const args=['-q','-o','BatchMode=yes','-o','ConnectTimeout=12','-o','StrictHostKeyChecking=yes'];
  if(node.port)args.push('-P',String(node.port));
  if(node.identityFile)args.push('-i',node.identityFile);
  const target=(node.user?node.user+'@':'')+node.sshTarget;
  await runProcess(scpExecutable(),[...args,localPath,target+':'+remotePath],undefined,timeoutMs);
}
export async function downloadFile(node:ServiceNode,localPath:string,remotePath:string) {
  const args=['-q','-o','BatchMode=yes','-o','ConnectTimeout=12','-o','StrictHostKeyChecking=yes'];
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
