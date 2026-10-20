import { spawn, type ChildProcess } from 'node:child_process';
import type { ServiceNode } from '../shared/types';
import { sshArgs, sshExecutable } from './ssh';
import { sshEnvironment } from './ssh-auth';

export interface TunnelLease { ready(): Promise<void>; release(): void }

const READY_TIMEOUT_MS = 25_000;
const FATAL = /Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Bad configuration/;

// The remote MCP port is per node, so several terminals on one node cannot each
// carry their own -R forward. One dedicated `ssh -N -R` per node serves all of
// them; it lives while any session holds a lease and reconnects if it drops.
class BridgeTunnel {
  refs = 0;
  private child?: ChildProcess;
  private established = false;
  private waiters: { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private restartTimer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private closed = false;

  constructor(private readonly node: ServiceNode, private readonly remotePort: number, private readonly localPort: () => number) {}

  ready(): Promise<void> {
    if (this.established) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(waiter => waiter.timer !== timer);
        reject(new Error('MCP bridge tunnel did not start'));
      }, READY_TIMEOUT_MS);
      this.waiters.push({ resolve, reject, timer });
      if (!this.child && !this.restartTimer) this.start();
    });
  }

  private settle(error?: Error) {
    const waiters = this.waiters; this.waiters = [];
    for (const waiter of waiters) { clearTimeout(waiter.timer); if (error) waiter.reject(error); else waiter.resolve(); }
  }

  private start() {
    if (this.closed) return;
    this.restartTimer = undefined;
    const marker = 'remote forward success for: listen 127.0.0.1:' + this.remotePort;
    const child = spawn(sshExecutable(), [...sshArgs(this.node), '-v', '-N', '-o', 'ExitOnForwardFailure=yes',
      '-R', '127.0.0.1:' + this.remotePort + ':127.0.0.1:' + this.localPort(), this.node.sshTarget],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: sshEnvironment(this.node) });
    this.child = child;
    let output = '';
    child.stderr!.on('data', (data: Buffer) => {
      if (this.established) return;
      output = (output + data.toString()).slice(-8192);
      if (output.includes(marker)) { this.established = true; this.attempt = 0; this.settle(); }
    });
    const ended = (error?: Error) => {
      if (this.child !== child) return;
      this.child = undefined;
      const wasEstablished = this.established;
      this.established = false;
      const detail = output.split(/\r?\n/).filter(line => line && !line.startsWith('debug')).slice(-3).join('\n');
      if (!wasEstablished) this.settle(error ?? new Error(detail || 'MCP bridge tunnel closed'));
      // Retry a dropped tunnel in the background; a tunnel that never came up is retried by the next ready().
      if (this.closed || this.refs === 0 || FATAL.test(output) || (!wasEstablished && !this.waiters.length)) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.attempt++);
      this.restartTimer = setTimeout(() => this.start(), delay);
      this.restartTimer.unref?.();
    };
    child.once('error', ended);
    child.once('exit', () => ended());
  }

  close() {
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.settle(new Error('MCP bridge tunnel closed'));
    const child = this.child; this.child = undefined; this.established = false;
    try { child?.kill(); } catch { /* already gone */ }
  }
}

export class BridgeTunnels {
  private tunnels = new Map<string, BridgeTunnel>();
  constructor(private readonly localPort: () => number) {}

  acquire(node: ServiceNode, remotePort: number): TunnelLease {
    const key = [node.id, node.sshTarget, node.user ?? '', node.port ?? '', node.identityFile ?? '', node.authType ?? 'key', remotePort].join('|');
    let tunnel = this.tunnels.get(key);
    if (!tunnel) { tunnel = new BridgeTunnel({ ...node }, remotePort, this.localPort); this.tunnels.set(key, tunnel); }
    tunnel.refs++;
    let released = false;
    const leased = tunnel;
    return {
      ready: () => released ? Promise.reject(new Error('MCP bridge tunnel lease was released')) : leased.ready(),
      release: () => {
        if (released) return;
        released = true;
        if (--leased.refs === 0 && this.tunnels.get(key) === leased) { this.tunnels.delete(key); leased.close(); }
      },
    };
  }

  dispose() {
    for (const tunnel of this.tunnels.values()) tunnel.close();
    this.tunnels.clear();
  }
}
