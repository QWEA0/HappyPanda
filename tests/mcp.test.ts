import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ActivityEvent, Workspace } from '../src/shared/types';
import { LocalMcpBridge, type LocalMcpBridgeOptions } from '../src/main/mcp';
import { OUTPUT_LIMIT } from '../src/main/mcp/jobs';

type Data = Record<string, unknown>;
interface Fixture {
  root: string;
  workspace: Workspace;
  workspaces: Map<string, Workspace>;
  options: LocalMcpBridgeOptions;
  bridge: LocalMcpBridge;
  url: string;
  activities: Omit<ActivityEvent, 'id' | 'time'>[];
  clients: Client[];
}
const fixtures: Fixture[] = [];
const tools = ['local_list_files', 'local_read_file', 'local_write_file', 'local_exec', 'local_job_status', 'local_job_output', 'local_job_cancel'];

async function fixture(overrides: Partial<LocalMcpBridgeOptions> = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'happypanda-mcp-'));
  const localPath = path.join(root, 'workspace with spaces');
  await mkdir(localPath);
  const workspace: Workspace = { id: 'workspace-a', nodeId: 'node-a', name: 'Temporary test workspace', localPath, remotePath: '/unused', localAccess: true, syncSessionName: 'unused', createdAt: '' };
  const workspaces = new Map([[workspace.id, workspace]]);
  const activities: Omit<ActivityEvent, 'id' | 'time'>[] = [];
  const options: LocalMcpBridgeOptions = { token: randomBytes(32).toString('hex'), dataDir: path.join(root, 'app-data'), resolveWorkspace: id => workspaces.get(id), onActivity: event => activities.push(event), ...overrides };
  const bridge = new LocalMcpBridge(options);
  const fx: Fixture = { root, workspace, workspaces, options, bridge, url: '', activities, clients: [] };
  fixtures.push(fx);
  fx.url = (await bridge.start()).url;
  return fx;
}

async function connect(fx: Fixture): Promise<Client> {
  const client = new Client({ name: 'official-sdk-test', version: '1.0.0' });
  client.onerror = () => undefined;
  fx.clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(fx.url), { requestInit: { headers: { Authorization: `Bearer ${fx.options.token}` } } }));
  return client;
}

async function call(client: Client, name: string, args: Data = {}): Promise<{ data: Data; isError: boolean }> {
  const reply = await client.callTool({ name, arguments: args });
  expect(reply.structuredContent).toBeTypeOf('object');
  const data = reply.structuredContent as Data;
  const text = (reply.content as { type: string; text?: string }[]).find(item => item.type === 'text')?.text;
  expect(JSON.parse(text!)).toEqual(data);
  return { data, isError: reply.isError === true };
}

async function until<T>(operation: () => Promise<T>, ready: (value: T) => boolean, deadlineMs = 9000): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  while (true) {
    const value = await operation();
    if (ready(value)) return value;
    if (Date.now() >= deadline) throw new Error('Temporary MCP test operation did not finish in time.');
    await delay(40);
  }
}

async function finished(client: Client, workspaceId: string, jobId: unknown): Promise<Data> {
  return until(async () => (await call(client, 'local_job_status', { workspace_id: workspaceId, job_id: jobId })).data, data => !['requested', 'running'].includes(String(data.status)));
}

async function command(fx: Fixture, basename: string, source: string): Promise<string> {
  const filename = `${basename}.cjs`;
  await writeFile(path.join(fx.workspace.localPath, filename), source);
  const quote = (value: string) => process.platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\"'\"'")}'`;
  return `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(filename)}`;
}

async function restart(fx: Fixture): Promise<void> {
  for (const client of fx.clients) await client.close();
  fx.clients.length = 0;
  await fx.bridge.stop();
  fx.bridge = new LocalMcpBridge(fx.options);
  fx.url = (await fx.bridge.start()).url;
}

afterEach(async () => {
  for (const fx of fixtures.splice(0)) {
    for (const client of fx.clients) await client.close();
    await fx.bridge.stop();
    const absolute = path.resolve(fx.root);
    if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('happypanda-mcp-')) throw new Error('Refusing unsafe test cleanup.');
    await rm(absolute, { recursive: true, force: true });
  }
});

describe('official SDK HTTP bridge and workspace authorization', () => {
  it('initializes, lists all tools and performs actual structured file calls', async () => {
    const fx = await fixture();
    const client = await connect(fx);
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([...tools].sort());
    expect(new URL(fx.url).hostname).toBe('127.0.0.1');
    const wrote = await call(client, 'local_write_file', { workspace_id: fx.workspace.id, path: 'hello.txt', content: 'hello', expected_hash: null });
    expect(wrote.isError).toBe(false);
    const read = await call(client, 'local_read_file', { workspace_id: fx.workspace.id, path: 'hello.txt' });
    expect(read.data.content).toBe('hello');
    expect(read.data.hash).toBe(wrote.data.hash);
    const listed = await call(client, 'local_list_files', { workspace_id: fx.workspace.id });
    expect(listed.data.entries).toEqual([expect.objectContaining({ path: 'hello.txt', type: 'file' })]);
    const secondRoot = path.join(fx.root, 'second');
    await mkdir(secondRoot);
    fx.workspaces.set('workspace-b', { ...fx.workspace, id: 'workspace-b', localPath: secondRoot });
    const secondClient = await connect(fx);
    await call(secondClient, 'local_write_file', { workspace_id: 'workspace-b', path: 'hello.txt', content: 'second' });
    expect((await call(client, 'local_read_file', { workspace_id: fx.workspace.id, path: 'hello.txt' })).data.content).toBe('hello');
  });

  it('rejects missing, incorrect and duplicated tokens on every route', async () => {
    const fx = await fixture();
    for (const route of ['/mcp', '/events']) {
      for (const authorization of [undefined, `Bearer ${fx.options.token}extra`, `bearer ${fx.options.token}`]) {
        const response = await fetch(new URL(route, fx.url), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) }, body: '{}' });
        expect(response.status).toBe(401);
      }
    }
    const duplicateStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(fx.url, { method: 'POST', headers: { Authorization: [`Bearer ${fx.options.token}`, `Bearer ${fx.options.token}`] } }, response => { response.resume(); resolve(response.statusCode!); });
      request.on('error', reject);
      request.end('{}');
    });
    expect(duplicateStatus).toBe(401);
    const response = await fetch(fx.url, { method: 'POST', headers: { Authorization: `Bearer ${fx.options.token}`, Origin: 'https://untrusted.invalid' }, body: '{}' });
    expect(response.status).toBe(403);
    const unauthorizedClient = new Client({ name: 'no-token', version: '1' });
    await expect(unauthorizedClient.connect(new StreamableHTTPClientTransport(new URL(fx.url)))).rejects.toThrow();
    await unauthorizedClient.close();
  });

  it('keeps initialization healthy while all local tools are disabled, and checks the resolver on every call', async () => {
    const fx = await fixture();
    fx.workspace.localAccess = false;
    const client = await connect(fx);
    expect((await client.listTools()).tools).toHaveLength(7);
    const inputs: Data[] = [{}, { path: 'x' }, { path: 'x', content: 'x' }, { command: 'exit 0', op_id: 'disabled' }, { job_id: randomUUID() }, { job_id: randomUUID() }, { job_id: randomUUID() }];
    for (let index = 0; index < tools.length; index++) {
      const reply = await call(client, tools[index], { workspace_id: fx.workspace.id, ...inputs[index] });
      expect(reply.isError).toBe(true);
      expect(reply.data.error).toMatchObject({ code: 'LOCAL_ACCESS_DISABLED' });
    }
    expect(await readdir(fx.workspace.localPath)).toEqual([]);
    fx.workspace.localAccess = true;
    expect((await call(client, 'local_list_files', { workspace_id: fx.workspace.id })).isError).toBe(false);
    fx.workspaces.delete(fx.workspace.id);
    expect((await call(client, 'local_list_files', { workspace_id: fx.workspace.id })).data.error).toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
  });

  it('resolves the optional default dynamically and fails clearly without one', async () => {
    let active: string | undefined;
    const fx = await fixture({ defaultWorkspaceId: () => active });
    const client = await connect(fx);
    expect((await call(client, 'local_list_files')).data.error).toMatchObject({ code: 'WORKSPACE_REQUIRED' });
    active = fx.workspace.id;
    expect((await call(client, 'local_list_files')).data.workspace_id).toBe(active);
    fx.workspace.localAccess = false;
    expect((await call(client, 'local_list_files')).data.error).toMatchObject({ code: 'LOCAL_ACCESS_DISABLED' });
  });
});

it('accepts authenticated requests after restart without a stale transport session', async () => {
  const fx=await fixture();
  await writeFile(path.join(fx.workspace.localPath,'restart.txt'),'restart probe');
  expect((await call(await connect(fx),'local_read_file',{workspace_id:fx.workspace.id,path:'restart.txt'})).isError).toBe(false);
  await restart(fx);
  const response=await fetch(fx.url,{method:'POST',headers:{Authorization:'Bearer '+fx.options.token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','Mcp-Session-Id':'old-transport-session','MCP-Protocol-Version':'2025-03-26'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'local_read_file',arguments:{workspace_id:fx.workspace.id,path:'restart.txt'}}})});
  expect(response.status).toBe(200);
  const result=await response.json();expect(result.result.isError).not.toBe(true);expect(JSON.stringify(result.result.structuredContent)).toContain('restart probe');
});

it('derives stable bounded reverse ports for independent clients', async () => {
  const {remoteBridgePort}=await import('../src/main/mcp');
  const first=remoteBridgePort('personal-node','client-one');
  expect(first).toBe(remoteBridgePort('personal-node','client-one'));
  expect(first).toBeGreaterThanOrEqual(22000);expect(first).toBeLessThan(30000);
  expect(first).not.toBe(remoteBridgePort('personal-node','client-two'));
});
describe('canonical workspace files and synchronization barriers', () => {
  it('blocks parent, absolute, symlink/junction and working-directory escapes', async () => {
    const fx = await fixture();
    const outside = path.join(fx.root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'outside-data');
    await symlink(outside, path.join(fx.workspace.localPath, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const client = await connect(fx);
    for (const relative of ['../outside/secret.txt', '..\\outside\\secret.txt', path.join(outside, 'secret.txt'), 'escape/secret.txt']) {
      expect((await call(client, 'local_read_file', { workspace_id: fx.workspace.id, path: relative })).isError).toBe(true);
      expect((await call(client, 'local_write_file', { workspace_id: fx.workspace.id, path: relative, content: 'bad' })).isError).toBe(true);
    }
    expect((await call(client, 'local_list_files', { workspace_id: fx.workspace.id, path: 'escape' })).isError).toBe(true);
    expect((await call(client, 'local_exec', { workspace_id: fx.workspace.id, relativecwd: 'escape', command: 'exit 0', op_id: 'escape-cwd' })).isError).toBe(true);
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside-data');
    expect(await readdir(outside)).toEqual(['secret.txt']);
  });

  it('enforces create-only/hash conflicts and serializes concurrent optimistic replacements', async () => {
    const fx = await fixture();
    const client = await connect(fx);
    const initial = await call(client, 'local_write_file', { workspace_id: fx.workspace.id, path: 'file.txt', content: 'initial', expected_hash: null });
    const other = await connect(fx);
    const replies = await Promise.all([client, other].map((current, index) => call(current, 'local_write_file', { workspace_id: fx.workspace.id, path: 'file.txt', content: `changed-${index}`, expected_hash: initial.data.hash })));
    expect(replies.filter(reply => reply.isError)).toHaveLength(1);
    expect(replies.find(reply => reply.isError)?.data.error).toMatchObject({ code: 'HASH_CONFLICT' });
    expect((await call(client, 'local_write_file', { workspace_id: fx.workspace.id, path: 'file.txt', content: 'bad', expected_hash: null })).data.error).toMatchObject({ code: 'HASH_CONFLICT' });
    expect(await readdir(fx.workspace.localPath)).toEqual(['file.txt']);
  });

  it('exposes an after-write synchronization failure with an applied-operation receipt', async () => {
    const fx = await fixture({ afterOperation: async () => { throw new Error('sync unavailable'); } });
    const client = await connect(fx);
    const reply = await call(client, 'local_write_file', { workspace_id: fx.workspace.id, path: 'file.txt', content: 'applied' });
    expect(reply.isError).toBe(true);
    expect(reply.data.error).toMatchObject({ code: 'AFTER_OPERATION_FAILED', operation_completed: true });
    expect(await readFile(path.join(fx.workspace.localPath, 'file.txt'), 'utf8')).toBe('applied');
  });
});

describe('durable local processes', () => {
  it('returns real cwd/output/exit code, deduplicates across sessions and restart, and rejects conflicting IDs', async () => {
    const fx = await fixture();
    const scriptCommand = await command(fx, 'result', "require('node:fs').appendFileSync('runs.txt', 'once\\n'); process.stdout.write('SECRET_ACTIVITY_SENTINEL\\n' + process.platform + '\\n' + process.cwd()); process.stderr.write('stderr-marker'); process.exit(7);");
    // PowerShell requires the caller to explicitly propagate a native program's exit code.
    const commandText = process.platform === 'win32' ? `${scriptCommand}; exit $LASTEXITCODE` : scriptCommand;
    const client = await connect(fx);
    const other = await connect(fx);
    const args = { workspace_id: fx.workspace.id, command: commandText, op_id: 'same-operation', timeout_ms: 10000 };
    const starts = await Promise.all([client, other].map(current => call(current, 'local_exec', args)));
    expect(starts[0].data.job_id).toBe(starts[1].data.job_id);
    const receipt = await finished(client, fx.workspace.id, starts[0].data.job_id);
    expect(receipt.status).toBe('completed');
    expect(receipt.exit_code).toBe(7);
    expect(receipt.stdout).toContain(process.platform);
    expect(receipt.stdout).toContain(await realpath(fx.workspace.localPath));
    expect(receipt.stderr).toBe('stderr-marker');
    expect(await readFile(path.join(fx.workspace.localPath, 'runs.txt'), 'utf8')).toBe('once\n');
    expect((await call(other, 'local_exec', args)).data).toEqual(receipt);
    expect((await call(client, 'local_exec', { ...args, command: 'exit 0' })).data.error).toMatchObject({ code: 'OP_ID_CONFLICT' });
    expect((await call(client, 'local_exec', { ...args, timeout_ms: 11000 })).data.error).toMatchObject({ code: 'OP_ID_CONFLICT' });
    const journalDirectory = path.join(fx.options.dataDir, 'mcp-jobs');
    const journals = await readdir(journalDirectory);
    expect(journals).toHaveLength(1);
    const serialized = await readFile(path.join(journalDirectory, journals[0]), 'utf8');
    expect(JSON.parse(serialized).request.command).toBe(commandText);
    expect(serialized).not.toContain(fx.options.token);
    if (process.platform !== 'win32') expect((await stat(path.join(journalDirectory, journals[0]))).mode & 0o777).toBe(0o600);
    const activities = JSON.stringify(fx.activities);
    expect(activities).not.toContain(commandText);
    expect(activities).not.toContain('SECRET_ACTIVITY_SENTINEL');
    expect(activities).not.toContain(fx.options.token);
    await restart(fx);
    expect((await call(await connect(fx), 'local_exec', args)).data).toEqual(receipt);
    expect(await readFile(path.join(fx.workspace.localPath, 'runs.txt'), 'utf8')).toBe('once\n');
  });

  it('never executes a failed before-operation barrier and never retries a failed after barrier', async () => {
    let beforeFails = true;
    let afterCalls = 0;
    const fx = await fixture({ beforeOperation: async () => { if (beforeFails) throw new Error('before-sync failed'); }, afterOperation: async () => { afterCalls++; throw new Error('after-sync failed'); } });
    const commandText = await command(fx, 'barrier', "require('node:fs').appendFileSync('runs.txt', 'once\\n');");
    const client = await connect(fx);
    const args = { workspace_id: fx.workspace.id, command: commandText, op_id: 'before-failure' };
    const denied = await call(client, 'local_exec', args);
    expect(denied.data.error).toMatchObject({ code: 'BEFORE_OPERATION_FAILED' });
    await expect(readFile(path.join(fx.workspace.localPath, 'runs.txt'))).rejects.toThrow();
    beforeFails = false;
    expect((await call(client, 'local_exec', args)).data).toEqual(denied.data);
    const start = await call(client, 'local_exec', { ...args, op_id: 'after-failure' });
    const receipt = await finished(client, fx.workspace.id, start.data.job_id);
    expect(receipt.exit_code).toBe(0);
    expect(receipt.status).toBe('completed');
    expect(receipt.error).toMatchObject({ code: 'AFTER_OPERATION_FAILED' });
    const status = await call(client, 'local_job_status', { workspace_id: fx.workspace.id, job_id: start.data.job_id });
    expect(status.isError).toBe(true);
    const replay = await call(client, 'local_exec', { ...args, op_id: 'after-failure' });
    expect(replay.isError).toBe(true);
    expect(replay.data).toEqual(receipt);
    expect(afterCalls).toBe(1);
    expect(await readFile(path.join(fx.workspace.localPath, 'runs.txt'), 'utf8')).toBe('once\n');
  });

  it('keeps bounded independent output streams with resumable byte cursors', async () => {
    const fx = await fixture();
    const commandText = await command(fx, 'output', `process.stdout.write('a'.repeat(${OUTPUT_LIMIT + 8192})); process.stderr.write('b'.repeat(${OUTPUT_LIMIT + 4096}));`);
    const client = await connect(fx);
    const start = await call(client, 'local_exec', { workspace_id: fx.workspace.id, command: commandText, op_id: 'bounded-output' });
    const receipt = await finished(client, fx.workspace.id, start.data.job_id);
    expect(Buffer.byteLength(String(receipt.stdout))).toBe(OUTPUT_LIMIT);
    expect(Buffer.byteLength(String(receipt.stderr))).toBe(OUTPUT_LIMIT);
    expect(receipt.stdout_bytes).toBe(OUTPUT_LIMIT + 8192);
    expect(receipt.stderr_dropped_bytes).toBe(4096);
    const first = await call(client, 'local_job_output', { workspace_id: fx.workspace.id, job_id: start.data.job_id, max_bytes: 512 });
    expect(first.isError).toBe(false);
    expect(first.data.stdout).toMatchObject({ offset: 8192, next_offset: 8704, truncated: true, text: 'a'.repeat(512) });
    const second = await call(client, 'local_job_output', { workspace_id: fx.workspace.id, job_id: start.data.job_id, stdout_offset: 8704, stderr_offset: 4608, max_bytes: 512 });
    expect(second.isError).toBe(false);
    expect(second.data.stdout).toMatchObject({ offset: 8704, next_offset: 9216, truncated: false });
  });

  it('preserves a job over client disconnect and cancels its real descendant process tree without replay', async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.workspace.localPath, 'child.cjs'), "const fs = require('node:fs'); setInterval(() => fs.appendFileSync('heartbeat.txt', '.'), 40);");
    const commandText = await command(fx, 'parent', "const fs = require('node:fs'); fs.appendFileSync('runs.txt', 'once\\n'); const child = require('node:child_process').spawn(process.execPath, ['child.cjs'], {windowsHide:true}); fs.writeFileSync('child-pid.txt', String(child.pid)); setInterval(() => {}, 1000);");
    const client = await connect(fx);
    const args = { workspace_id: fx.workspace.id, command: commandText, op_id: 'cancel-operation', timeout_ms: 20000 };
    const start = await call(client, 'local_exec', args);
    await until(async () => readFile(path.join(fx.workspace.localPath, 'heartbeat.txt'), 'utf8').catch(() => ''), value => value.length > 0);
    await client.close();
    const replacement = await connect(fx);
    expect((await call(replacement, 'local_exec', args)).data.job_id).toBe(start.data.job_id);
    const cancelled = await call(replacement, 'local_job_cancel', { workspace_id: fx.workspace.id, job_id: start.data.job_id });
    expect(cancelled.data.cancellation_requested).toBe(true);
    const receipt = await finished(replacement, fx.workspace.id, start.data.job_id);
    expect(receipt.status).toBe('cancelled');
    expect(receipt.cancellation_limitations).toBeTypeOf('string');
    const heartbeat = await readFile(path.join(fx.workspace.localPath, 'heartbeat.txt'), 'utf8');
    await delay(200);
    expect(await readFile(path.join(fx.workspace.localPath, 'heartbeat.txt'), 'utf8')).toBe(heartbeat);
    expect(await readFile(path.join(fx.workspace.localPath, 'runs.txt'), 'utf8')).toBe('once\n');
    expect((await call(replacement, 'local_exec', args)).data).toEqual(receipt);
  });

  it('terminates a timed-out job and stop closes transports and cancels running jobs', async () => {
    const fx = await fixture();
    const commandText = await command(fx, 'wait', 'setInterval(() => {}, 1000);');
    const client = await connect(fx);
    const start = await call(client, 'local_exec', { workspace_id: fx.workspace.id, command: commandText, op_id: 'timeout', timeout_ms: 700 });
    const receipt = await finished(client, fx.workspace.id, start.data.job_id);
    expect(receipt.status).toBe('timed_out');
    expect(receipt.cancellation_reason).toBe('timeout');
    const stopCommand = await command(fx, 'stop', "const fs = require('node:fs'); fs.writeFileSync('active-pid.txt', String(process.pid)); setInterval(() => fs.appendFileSync('stop-heartbeat.txt', '.'), 40);");
    const args = { workspace_id: fx.workspace.id, command: stopCommand, op_id: 'shutdown', timeout_ms: 20000 };
    const running = await call(client, 'local_exec', args);
    await until(async () => readFile(path.join(fx.workspace.localPath, 'stop-heartbeat.txt'), 'utf8').catch(() => ''), value => value.length > 0);
    const workerPid = Number(await readFile(path.join(fx.workspace.localPath, 'active-pid.txt'), 'utf8'));
    await fx.bridge.stop();
    await expect(fetch(fx.url)).rejects.toThrow();
    expect(() => process.kill(Number(running.data.pid), 0)).toThrow();
    expect(() => process.kill(workerPid, 0)).toThrow();
    const heartbeat = await readFile(path.join(fx.workspace.localPath, 'stop-heartbeat.txt'), 'utf8');
    await delay(150);
    expect(await readFile(path.join(fx.workspace.localPath, 'stop-heartbeat.txt'), 'utf8')).toBe(heartbeat);
    fx.bridge = new LocalMcpBridge(fx.options);
    fx.url = (await fx.bridge.start()).url;
    const restored = await call(await connect(fx), 'local_exec', args);
    expect(restored.data.job_id).toBe(running.data.job_id);
    expect(restored.data.status).toBe('cancelled');
  });

  it('marks a persisted incomplete receipt unknown on restart and never reruns it', async () => {
    const fx = await fixture();
    const commandText = await command(fx, 'crash', "require('node:fs').appendFileSync('runs.txt', 'once\\n');");
    const client = await connect(fx);
    const args = { workspace_id: fx.workspace.id, command: commandText, op_id: 'crash-recovery' };
    const start = await call(client, 'local_exec', args);
    await finished(client, fx.workspace.id, start.data.job_id);
    await fx.bridge.stop();
    const directory = path.join(fx.options.dataDir, 'mcp-jobs');
    const location = path.join(directory, (await readdir(directory))[0]);
    const journal = JSON.parse(await readFile(location, 'utf8'));
    Object.assign(journal, { status: 'running', exit_code: null, finished_at: null, error: null });
    await writeFile(location, JSON.stringify(journal), { mode: 0o600 });
    fx.bridge = new LocalMcpBridge(fx.options);
    fx.url = (await fx.bridge.start()).url;
    const restored = await call(await connect(fx), 'local_exec', args);
    expect(restored.data.status).toBe('unknown');
    expect(restored.data.error).toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(restored.data.job_id).toBe(start.data.job_id);
    expect(await readFile(path.join(fx.workspace.localPath, 'runs.txt'), 'utf8')).toBe('once\n');
  });
});

describe('authenticated remote telemetry', () => {
  it('accepts metrics and tool records independently of localAccess and rejects malformed/large bodies', async () => {
    const events: Data[] = [];
    const fx = await fixture({ onRemoteEvent: payload => events.push(payload) });
    fx.workspace.localAccess = false;
    const headers = { Authorization: `Bearer ${fx.options.token}`, 'Content-Type': 'application/json' };
    const url = new URL('/events', fx.url);
    for (const payload of [{ type: 'metrics', nodeId: 'node-a', sessionId: 'session-a', metrics: { cpuCount: 4 } }, { type: 'tool', nodeId: 'node-a', sessionId: 'session-a', workspaceId: fx.workspace.id, tool: 'Read', event: 'completed', id: 'e1', time: '2026-10-11T00:00:00Z', path: 'file.txt' }]) {
      expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) })).status).toBe(204);
    }
    expect(events).toHaveLength(2);
    for (const body of ['{', '[]', 'null']) expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(400);
    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ text: 'x'.repeat(256 * 1024) }) })).status).toBe(413);
    const chunked = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(url, { method: 'POST', headers }, response => { response.resume(); resolve(response.statusCode!); });
      request.on('error', reject);
      request.write('{"text":"');
      request.write('x'.repeat(256 * 1024));
      request.end('"}');
    });
    expect(chunked).toBe(413);
    expect(events).toHaveLength(2);
    expect((await fetch(url, { method: 'GET', headers })).status).toBe(405);
  });
});
