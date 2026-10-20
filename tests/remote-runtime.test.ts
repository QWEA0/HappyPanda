import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createRemoteRuntime } from './fixtures/remote-control-runtime';

it('sends remote input to an actual PC PTY while local MCP keeps its own authenticated PC runtime', async () => {
  const runtime = await createRemoteRuntime();
  const client = new Client({ name: 'pc-runtime-test', version: '1' });
  const abort = new AbortController();
  try {
    const pair = await fetch(runtime.base + '/api/remote/pair', { method: 'POST', headers: { Origin: runtime.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.server.snapshot().pairing!.code, name: 'Android runtime test' }) });
    expect(pair.status).toBe(200);
    const cookie = pair.headers.get('set-cookie')!.split(';')[0];
    const headers = { Origin: runtime.base, Cookie: cookie, 'Content-Type': 'application/json' };
    const control = await fetch(runtime.base + '/api/remote/control', { method: 'POST', headers, body: JSON.stringify({ action: 'claim' }) });
    expect(control.status).toBe(200);
    const stream = await fetch(runtime.base + '/api/remote/events', { headers: { Cookie: cookie }, signal: abort.signal });
    const reader = stream.body!.getReader();
    const command = process.platform === 'win32' ? "Write-Output ('REMOTE_'+'PC_RUNTIME_OK')\r" : "printf '%s%s\\n' REMOTE_ PC_RUNTIME_OK\r";
    const response = await fetch(runtime.base + '/api/remote/terminal', { method: 'POST', headers, body: JSON.stringify({ data: command, nodeId: 'pc-node', sessionId: 'pc-session', generation: 0 }) });
    expect(response.status).toBe(200);
    let output = '';
    const timeout = setTimeout(() => abort.abort(), 15000);
    try {
      while (!output.includes('REMOTE_PC_RUNTIME_OK')) {
        const next = await reader.read();
        if (next.done) throw new Error('PC terminal stream ended before command output.');
        output += new TextDecoder().decode(next.value);
      }
    } finally { clearTimeout(timeout); }
    expect(output).toContain('REMOTE_PC_RUNTIME_OK');
    const resized = await fetch(runtime.base + '/api/remote/resize', { method: 'POST', headers, body: JSON.stringify({ cols: 42, rows: 16, nodeId: 'pc-node', sessionId: 'pc-session', generation: 0 }) });
    expect(resized.status).toBe(200);
    expect([runtime.terminal.cols, runtime.terminal.rows]).toEqual([42, 16]);

    expect(new URL(runtime.endpoint.url).hostname).toBe('127.0.0.1');
    const invalidMcpAuth = await fetch(runtime.endpoint.url, { method: 'POST', headers: { Authorization: `Bearer ${cookie.split('=')[1]}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(invalidMcpAuth.status).toBe(401);
    await client.connect(new StreamableHTTPClientTransport(new URL(runtime.endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${runtime.token}` } } }));
    const read = await client.callTool({ name: 'local_read_file', arguments: { workspace_id: runtime.workspace.id, path: 'pc-marker.txt' } });
    expect(read.isError, JSON.stringify(read.structuredContent)).not.toBe(true);
    expect((read.structuredContent as { content: string }).content).toBe('PC_LOCAL_MCP_FILE');
    let receipt = (await client.callTool({ name: 'local_exec', arguments: { workspace_id: runtime.workspace.id, command: process.platform === 'win32' ? "Write-Output ('MCP_'+'PC_RUNTIME_OK')" : "printf '%s%s\\n' MCP_ PC_RUNTIME_OK", shell: process.platform === 'win32' ? 'powershell' : 'sh', op_id: 'actual-pc-runtime' } })).structuredContent as Record<string, unknown>;
    for (let attempt = 0; ['requested', 'running'].includes(String(receipt.status)) && attempt < 200; attempt++) {
      await delay(30);
      receipt = (await client.callTool({ name: 'local_job_status', arguments: { workspace_id: runtime.workspace.id, job_id: receipt.job_id } })).structuredContent as typeof receipt;
    }
    expect(receipt.status).toBe('completed');
    expect(receipt.exit_code).toBe(0);
    expect(JSON.stringify(receipt)).toContain('MCP_PC_RUNTIME_OK');
    runtime.server.takeControl();
    const denied = await fetch(runtime.base + '/api/remote/terminal', { method: 'POST', headers, body: JSON.stringify({ data: 'denied', nodeId: 'pc-node', sessionId: 'pc-session' }) });
    expect([403, 409]).toContain(denied.status);
    expect(runtime.state.connection.phase).toBe('connected');
  } finally {
    abort.abort();
    await client.close();
    await runtime.close();
  }
}, 30000);
