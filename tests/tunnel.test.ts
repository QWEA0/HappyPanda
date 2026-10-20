import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const children = vi.hoisted(() => [] as any[]);
const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn }));
import { BridgeTunnels } from '../src/main/tunnel';
import { TEST_NODE } from './fixtures/node';

function child() {
  const process = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn() });
  process.kill.mockImplementation(() => { process.emit('exit', null); return true; });
  children.push(process);
  return process;
}
const established = (index: number, port = 23000) => children[index].stderr.emit('data', Buffer.from('debug1: remote forward success for: listen 127.0.0.1:' + port + ', connect 127.0.0.1:5555\n'));

let tunnels: BridgeTunnels;
beforeEach(() => { children.length = 0; spawn.mockReset().mockImplementation(child); vi.useFakeTimers(); tunnels = new BridgeTunnels(() => 5555); });
afterEach(() => { tunnels.dispose(); vi.useRealTimers(); });

describe('per-node MCP bridge tunnel', () => {
  it('starts one forward for every session on a node and stops it with the last lease', async () => {
    const first = tunnels.acquire(TEST_NODE, 23000), second = tunnels.acquire(TEST_NODE, 23000);
    const ready = Promise.all([first.ready(), second.ready()]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['-N', '-R', '127.0.0.1:23000:127.0.0.1:5555', 'ExitOnForwardFailure=yes']));
    established(0); await ready;
    await first.ready(); expect(spawn).toHaveBeenCalledTimes(1);
    first.release(); expect(children[0].kill).not.toHaveBeenCalled();
    second.release(); expect(children[0].kill).toHaveBeenCalled();
    await expect(second.ready()).rejects.toThrow('released');
  });
  it('reconnects a dropped forward while sessions still use it', async () => {
    const lease = tunnels.acquire(TEST_NODE, 23000);
    const ready = lease.ready(); established(0); await ready;
    children[0].emit('exit', 255);
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawn).toHaveBeenCalledTimes(2);
    const again = lease.ready(); established(1); await again;
    lease.release();
  });
  it('reports a forward that never comes up and retries only when asked again', async () => {
    const lease = tunnels.acquire(TEST_NODE, 23000);
    const failed = expect(lease.ready()).rejects.toThrow('remote port forwarding failed');
    children[0].stderr.emit('data', Buffer.from('Error: remote port forwarding failed for listen port 23000\n'));
    children[0].emit('exit', 255); await failed;
    await vi.advanceTimersByTimeAsync(60000);
    expect(spawn).toHaveBeenCalledTimes(1);
    const retry = lease.ready(); expect(spawn).toHaveBeenCalledTimes(2);
    established(1); await retry;
    lease.release();
  });
  it('stops background reconnection when the server rejects authentication', async () => {
    const lease = tunnels.acquire(TEST_NODE, 23000);
    const ready = lease.ready(); established(0); await ready;
    children[0].emit('exit', 255);
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawn).toHaveBeenCalledTimes(2);
    children[1].stderr.emit('data', Buffer.from('fixture@host: Permission denied (publickey).\n'));
    children[1].emit('exit', 255);
    await vi.advanceTimersByTimeAsync(60000);
    expect(spawn).toHaveBeenCalledTimes(2);
    lease.release();
  });
});
