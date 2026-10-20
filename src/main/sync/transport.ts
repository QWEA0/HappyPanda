import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ServiceNode } from '../../shared/types';
import { authenticationArgs, sshEnvironment,sshTransportDirectory } from '../ssh-auth';
import {isWindowsRemote} from '../remote-platform';

export interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  input?: string;
  acceptedExitCodes?: number[];
}

export type CommandRunner = (file: string, args: string[], options?: CommandOptions) => Promise<string>;
export type FileTransfer = (node: ServiceNode, localPath: string, remotePath: string) => Promise<void>;

// Mutagen needs a directory containing the app's SSH transport, not an -F flag.
export interface SshPreparation {
  target: string;
  user?: string;
  port?: number;
  mutagenSshPath?: string;
  scpPath?: string;
  scpArgs?: string[];
  managesIdentity?: boolean;
}
export type PrepareSsh = (node: ServiceNode) => Promise<SshPreparation>;

export const runCommand: CommandRunner = (file, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, {
    shell: false, windowsHide: true, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: options.env ?? process.env, cwd: options.cwd,
  });
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  let size = 0;
  let failure: Error | undefined;
  const timer = setTimeout(() => {
    failure = new Error(`${path.basename(file)} timed out`);
    child.kill();
  }, options.timeoutMs ?? 60_000);
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    size += chunk.length;
    if (size > (options.maxOutputBytes ?? 8 * 1024 * 1024)) {
      failure = new Error(`${path.basename(file)} output exceeded the limit`);
      child.kill();
    } else target.push(chunk);
  };
  child.stdout!.on('data', collect(output));
  child.stderr!.on('data', collect(errors));
  child.stdin?.on('error', error => { failure = error; });
  child.stdin?.end(options.input);
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    if (failure) reject(failure);
    else if (code === null || !(options.acceptedExitCodes ?? [0]).includes(code)) reject(new Error(`${path.basename(file)} failed (${code ?? signal}): ${Buffer.concat(errors).toString('utf8').trim()}`));
    else resolve(Buffer.concat(output).toString('utf8'));
  });
});

export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('NUL is not allowed in shell arguments');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function sshAddress(node: ServiceNode | SshPreparation): { host: string; user?: string; port?: number } {
  const target = 'sshTarget' in node ? node.sshTarget : node.target;
  const parts = target.split('@');
  if (parts.length > 2) throw new Error('SSH target must be a host or an SSH alias');
  const host = parts.at(-1)!;
  const user = node.user ?? (parts.length === 2 ? parts[0] : undefined);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(host)) throw new Error('Use an SSH hostname or alias (use an alias for IPv6)');
  if (user !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(user)) throw new Error('Invalid SSH user');
  if (node.port !== undefined && (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535)) throw new Error('Invalid SSH port');
  return { host, user, port: node.port };
}

export function remoteRoot(value: string): string {
  if (/^[A-Za-z]:\//.test(value) && !/[\\\0\r\n]/.test(value)) {
    if(value.split('/').some(segment=>['..','.git'].includes(segment.toLowerCase())))throw new Error('Invalid Windows workspace path');
    const root=path.win32.normalize(value).replaceAll('\\','/').replace(/\/$/,'');
    if(/^[A-Za-z]:$/.test(root))throw new Error('Filesystem root is not a workspace');
    return root;
  }
  if (!value.startsWith('/') || value.includes('\\') || /[\0\r\n]/.test(value) || value.split('/').includes('..')) {
    throw new Error('Remote workspace must be an absolute POSIX path');
  }
  const root = path.posix.normalize(value);
  if (root === '/' || root.split('/').includes('.git')) throw new Error('Remote workspace root is not a project directory');
  return root.replace(/\/$/, '');
}

export function mutagenRemoteEndpoint(connection: ServiceNode | SshPreparation, root: string): string {
  const { host, user, port } = sshAddress(connection);
  return `${user ? `${user}@` : ''}${host}:${port ? `${port}:` : ''}${remoteRoot(root)}`;
}

export function scpArguments(node: ServiceNode, localFile: string, remoteFile: string, direction: 'upload' | 'download', prepared?: SshPreparation): string[] {
  const { host, user, port } = sshAddress(prepared ?? node);
  if (!path.isAbsolute(localFile)) throw new Error('SCP local path must be absolute');
  if ((!remoteFile.startsWith('/')&&!/^[A-Za-z]:\//.test(remoteFile)) || /[\0\r\n]/.test(remoteFile)) throw new Error('SCP remote path must be absolute');
  const args = [...authenticationArgs(node), '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
  const transport=sshTransportDirectory(node);if(isWindowsRemote(node)&&transport)args.push('-S',path.join(transport,process.platform==='win32'?'ssh.exe':'ssh'));
  if (prepared?.scpArgs) args.push(...prepared.scpArgs);
  if (port) args.push('-P', String(port));
  if (node.identityFile && node.authType !== 'password') args.push('-i', node.identityFile);
  const remote = `${user ? `${user}@` : ''}${host}:${remoteFile}`;
  args.push('--', ...(direction === 'upload' ? [localFile, remote] : [remote, localFile]));
  return args;
}

export async function scpTransfer(node: ServiceNode, localFile: string, remoteFile: string, direction: 'upload' | 'download', runner: CommandRunner = runCommand, prepared?: SshPreparation): Promise<void> {
  const executable = prepared?.scpPath ?? (prepared?.mutagenSshPath ? path.join(prepared.mutagenSshPath, process.platform === 'win32' ? 'scp.exe' : 'scp') : 'scp');
  await runner(executable, scpArguments(node, localFile, remoteFile, direction, prepared), { timeoutMs: 60 * 60_000, env:sshEnvironment(node) });
}

export async function verifySystemIdentity(node: ServiceNode, runner: CommandRunner, prepared?: SshPreparation): Promise<void> {
  if (!node.identityFile || node.authType === 'password' || prepared?.managesIdentity) return;
  const { host, user, port } = sshAddress(prepared ?? node);
  const args = ['-G'];
  if (user) args.push('-l', user);
  if (port) args.push('-p', String(port));
  args.push(host);
  const executable = prepared?.mutagenSshPath ? path.join(prepared.mutagenSshPath, process.platform === 'win32' ? 'ssh.exe' : 'ssh') : 'ssh';
  const configuration = await runner(executable, args);
  const expand = (value: string) => path.resolve(value.replace(/^~(?=[/\\]|$)/, homedir()));
  const requested = expand(node.identityFile);
  const identities = configuration.split(/\r?\n/).filter(line => line.startsWith('identityfile ')).map(line => expand(line.slice(13).trim()));
  const equal = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!identities.some(identity => equal(identity, requested))) {
    throw new Error('Mutagen requires an SSH alias with this IdentityFile in system config, or prepareSsh with an app SSH transport');
  }
}
