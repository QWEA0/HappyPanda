import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CHANNEL_SERVER, SshChannel } from '../src/main/ssh';

// Runs the real command server locally (no network); needs a POSIX shell and python3.
const python = process.platform === 'win32' ? undefined : 'python3';
const launch = () => spawn(python!, ['-u', '-c', CHANNEL_SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });

describe.skipIf(!python)('persistent SSH command channel', () => {
  it('runs commands over one connection with stdin, stderr and exit codes', async () => {
    const channel = new SshChannel(launch);
    try {
      expect(await channel.run('echo hello', undefined, 5000)).toBe('hello\n');
      expect(await channel.run('cat', 'héllo wörld', 5000)).toBe('héllo wörld');
      await expect(channel.run('echo bad >&2; exit 3', undefined, 5000)).rejects.toThrow('bad');
      const results = await Promise.all([channel.run('sleep 0.3; echo slow', undefined, 5000), channel.run('echo fast', undefined, 5000)]);
      expect(results).toEqual(['slow\n', 'fast\n']);
      expect(channel.usable).toBe(true);
    } finally { channel.close(); }
  });
  it('rejects pending work and becomes unusable when the connection drops, and after a timeout', async () => {
    const dropped = new SshChannel(launch);
    const pending = dropped.run('sleep 5', undefined, 10000);
    await new Promise(resolve => setTimeout(resolve, 200));
    dropped.close();
    await expect(pending).rejects.toThrow('SSH connection closed');
    expect(dropped.usable).toBe(false);
    const slow = new SshChannel(launch);
    await expect(slow.run('sleep 5', undefined, 300)).rejects.toThrow('timed out');
    expect(slow.usable).toBe(false);
  });
  it('reports a channel that cannot start so callers can fall back', async () => {
    const channel = new SshChannel(() => spawn('definitely-not-a-real-binary', [], { stdio: ['pipe', 'pipe', 'pipe'] }));
    await expect(channel.run('true', undefined, 1000)).rejects.toThrow();
    expect(channel.usable).toBe(false);
  });
});
