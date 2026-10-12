import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ActivityEvent, Workspace } from '../../shared/types';
import { canonicalPath, listLocalFiles, LocalToolError, MAX_FILE_BYTES, readLocalFile, writeLocalFile } from './files';
import { execRequestSchema, LocalJobs, profileSchema, shellSchema } from './jobs';

export interface LocalMcpBridgeOptions {
  token: string;
  dataDir: string;
  resolveWorkspace: (id: string) => Workspace | undefined;
  onActivity: (event: Omit<ActivityEvent, 'id' | 'time'>) => void;
  beforeOperation?: (workspaceId: string) => Promise<void>;
  afterOperation?: (workspaceId: string) => Promise<void>;
  defaultWorkspaceId?: () => string | undefined;
  onRemoteEvent?: (payload: Record<string, unknown>) => void;
  statefulTransport?: boolean;
}
interface Session { server: McpServer; transport: StreamableHTTPServerTransport }
interface Endpoint { port: number; url: string }
const EVENT_LIMIT = 256 * 1024;
const workspaceShape = { workspace_id: z.string().min(1).max(256).optional().describe('Workspace ID; when omitted, use the current default workspace configured by the desktop.') };
const jobShape = { ...workspaceShape, job_id: z.string().uuid() };
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
export const remoteBridgePort = (nodeId: string, clientSecret: string): number => 22000 + createHash('sha256').update(nodeId + '\0' + clientSecret).digest().readUInt16BE(0) % 8000;
const result = (data: Record<string, unknown>, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, ...(isError ? { isError: true } : {}),
});
const errorResult = (error: unknown): CallToolResult => result({ error: {
  code: error instanceof LocalToolError ? error.code : 'LOCAL_OPERATION_FAILED',
  message: error instanceof Error ? error.message : 'Local operation failed.',
  ...(error instanceof LocalToolError && error.details ? error.details : {}),
} }, true);

export class LocalMcpBridge {
  private readonly authDigest: Buffer;
  private readonly jobs: LocalJobs;
  private readonly sessions = new Map<string, Session>();
  private readonly transports = new Set<Session>();
  private readonly workspaceQueues = new Map<string, Promise<unknown>>();
  private http?: Server;
  private endpoint?: Endpoint;
  private starting?: Promise<Endpoint>;
  private stopping?: Promise<void>;
  private closing = false;

  constructor(private readonly options: LocalMcpBridgeOptions) {
    if (!options.token || /[\s\x00-\x1f\x7f]/.test(options.token)) throw new Error('A nonempty, whitespace-free Bearer token is required.');
    this.authDigest = digest(`Bearer ${options.token}`);
    this.jobs = new LocalJobs({
      ...options,
      resolveCwd: async request => {
        const workspace = this.workspace(request.workspace_id);
        const directory = await canonicalPath(workspace.localPath, request.relativecwd);
        if (!(await stat(directory.target)).isDirectory()) throw new LocalToolError('NOT_A_DIRECTORY', 'relativecwd must refer to a directory.');
        return { root: directory.root, cwd: directory.target };
      },
    });
  }

  start(): Promise<Endpoint> {
    if (this.stopping) return this.stopping.then(() => this.start());
    if (this.endpoint) return Promise.resolve({ ...this.endpoint });
    if (this.starting) return this.starting;
    this.starting = this.listen().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async listen(): Promise<Endpoint> {
    await this.jobs.initialize();
    this.closing = false;
    const http = createServer((request, response) => {
      void this.handle(request, response).catch(() => this.reply(response, 500, 'Internal bridge error.'));
    });
    http.requestTimeout = 30000;
    http.headersTimeout = 10000;
    this.http = http;
    try {
      await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
      });
    } catch (error) { this.http = undefined; throw error; }
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Local MCP bridge has no TCP address.');
    this.endpoint = { port: address.port, url: `http://127.0.0.1:${address.port}/mcp` };
    return { ...this.endpoint };
  }

  private authenticated(request: IncomingMessage): boolean {
    const count = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'authorization').length;
    return count === 1 && typeof request.headers.authorization === 'string' && timingSafeEqual(this.authDigest, digest(request.headers.authorization));
  }

  private reply(response: ServerResponse, status: number, text: string): void {
    if (response.writableEnded || response.destroyed) return;
    if (response.headersSent) { response.end(); return; }
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: text }));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authenticated(request)) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="HappyPanda"');
      this.reply(response, 401, 'Unauthorized.');
      request.resume();
      return;
    }
    if (this.closing) { this.reply(response, 503, 'Bridge is stopping.'); return; }
    const host = request.headers.host;
    if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) { this.reply(response, 403, 'Host is not loopback.'); request.resume(); return; }
    if (request.headers.origin) {
      try {
        const origin = new URL(request.headers.origin);
        if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)) throw new Error();
      } catch { this.reply(response, 403, 'Origin is not loopback.'); request.resume(); return; }
    }
    const route = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (route === '/events') {
      if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); this.reply(response, 405, 'POST required.'); return; }
      await this.remoteEvent(request, response);
      return;
    }
    if (route !== '/mcp') { this.reply(response, 404, 'Route not found.'); return; }
    if (!['POST', 'GET', 'DELETE'].includes(request.method ?? '')) { response.setHeader('Allow', 'POST, GET, DELETE'); this.reply(response, 405, 'Method not allowed.'); return; }
    if (!this.options.statefulTransport && request.method !== 'POST') { response.setHeader('Allow', 'POST'); this.reply(response, 405, 'Stateless MCP uses POST.'); return; }
    const sessionId = request.headers['mcp-session-id'];
    if (this.options.statefulTransport && sessionId !== undefined) {
      const session = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined;
      if (!session) { this.reply(response, 404, 'MCP session not found. Initialize a new session.'); return; }
      await session.transport.handleRequest(request, response);
      return;
    }
    if (this.transports.size >= 128) { this.reply(response, 503, 'MCP session limit reached.'); return; }
    const session = await this.createSession();
    try { await session.transport.handleRequest(request, response); }
    finally {
      if (!session.transport.sessionId) {
        await session.server.close();
        this.transports.delete(session);
      }
    }
  }

  private async remoteEvent(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const contentType = request.headers['content-type'] ?? '';
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) { this.reply(response, 415, 'application/json required.'); request.resume(); return; }
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > EVENT_LIMIT) { this.reply(response, 413, 'Event exceeds 256KB.'); request.resume(); return; }
    const body = await new Promise<Buffer | undefined>(resolve => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const cleanup = () => { request.removeListener('data', ondata); request.removeListener('end', onend); request.removeListener('aborted', onabort); request.removeListener('error', onabort); };
      const onabort = () => { cleanup(); this.reply(response, 400, 'Incomplete event body.'); resolve(undefined); };
      const onend = () => { cleanup(); resolve(Buffer.concat(chunks)); };
      const ondata = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > EVENT_LIMIT) {
          cleanup();
          this.reply(response, 413, 'Event exceeds 256KB.');
          request.resume();
          resolve(undefined);
        } else { chunks.push(chunk); }
      };
      request.on('data', ondata);
      request.once('end', onend);
      request.once('aborted', onabort);
      request.once('error', onabort);
    });
    if (!body) return;
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      payload = parsed as Record<string, unknown>;
    } catch { this.reply(response, 400, 'Event body must be a JSON object.'); return; }
    try { this.options.onRemoteEvent?.(payload); }
    catch { this.reply(response, 500, 'Event receiver failed.'); return; }
    response.writeHead(204, { 'Cache-Control': 'no-store' });
    response.end();
  }

  private workspace(id?: string): Workspace {
    const resolved = id ?? this.options.defaultWorkspaceId?.();
    if (!resolved) throw new LocalToolError('WORKSPACE_REQUIRED', 'Specify workspace_id or configure a default workspace.');
    const workspace = this.options.resolveWorkspace(resolved);
    if (!workspace || workspace.id !== resolved) throw new LocalToolError('WORKSPACE_NOT_FOUND', 'Workspace is not configured.');
    if (workspace.localAccess !== true) throw new LocalToolError('LOCAL_ACCESS_DISABLED', 'Local access is disabled for this workspace. Enable it in the desktop before using local tools.');
    return workspace;
  }

  private async fileOperation(workspace: Workspace, operation: (current: Workspace) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const prior = this.workspaceQueues.get(workspace.id) ?? Promise.resolve();
    const pending = prior.catch(() => undefined).then(async () => {
      const before = this.workspace(workspace.id);
      try { await this.options.beforeOperation?.(before.id); }
      catch (error) { throw new LocalToolError('BEFORE_OPERATION_FAILED', error instanceof Error ? error.message : 'Before-operation synchronization failed.'); }
      const data = await operation(this.workspace(workspace.id));
      try { await this.options.afterOperation?.(workspace.id); }
      catch (error) { throw new LocalToolError('AFTER_OPERATION_FAILED', error instanceof Error ? error.message : 'After-operation synchronization failed.', { operation_completed: true, result: data }); }
      return data;
    });
    this.workspaceQueues.set(workspace.id, pending);
    try { return await pending; } finally { if (this.workspaceQueues.get(workspace.id) === pending) this.workspaceQueues.delete(workspace.id); }
  }

  private async tool(name: string, input: { workspace_id?: string }, operation: (workspace: Workspace) => Promise<Record<string, unknown>>): Promise<CallToolResult> {
    let workspace: Workspace | undefined;
    try {
      if (this.closing) throw new LocalToolError('BRIDGE_STOPPING', 'Bridge is stopping.');
      workspace = this.workspace(input.workspace_id);
      const data = await operation(workspace);
      const failed = Boolean(data.error || data.cancellation_error || ['unknown', 'failed', 'timed_out'].includes(String(data.status)) || (data.status === 'completed' && 'exit_code' in data && data.exit_code !== 0));
      this.options.onActivity({ kind: 'tool', title: name, location: 'local', workspaceId: workspace.id, detail: failed ? 'Tool returned an error.' : 'Tool completed.' });
      return result({ workspace_id: workspace.id, ...data }, failed);
    } catch (error) {
      this.options.onActivity({ kind: 'tool', title: name, location: 'local', workspaceId: workspace?.id, detail: error instanceof LocalToolError ? error.code : 'LOCAL_OPERATION_FAILED' });
      return errorResult(error);
    }
  }

  private async createSession(): Promise<Session> {
    const server = new McpServer({ name: 'happypanda-local', version: '0.1.0' });
    const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
    server.registerTool('local_list_files', { description: 'List canonical workspace entries. Recursive listings never follow symbolic links.', inputSchema: { ...workspaceShape, path: z.string().min(1).max(4096).default('.'), recursive: z.boolean().default(false), limit: z.number().int().min(1).max(5000).default(1000) }, annotations: readOnly }, args => this.tool('local_list_files', args, workspace => this.fileOperation(workspace, current => listLocalFiles(current.localPath, args.path, args.recursive, args.limit))));
    server.registerTool('local_read_file', { description: 'Read a UTF-8 workspace file with a SHA-256 hash for optimistic writes.', inputSchema: { ...workspaceShape, path: z.string().min(1).max(4096) }, annotations: readOnly }, args => this.tool('local_read_file', args, workspace => this.fileOperation(workspace, current => readLocalFile(current.localPath, args.path))));
    server.registerTool('local_write_file', { description: 'Atomically replace a UTF-8 workspace file. expected_hash must match its SHA-256; null means create only. Parent directories must exist.', inputSchema: { ...workspaceShape, path: z.string().min(1).max(4096), content: z.string().max(MAX_FILE_BYTES), expected_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional() }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, args => this.tool('local_write_file', args, workspace => this.fileOperation(workspace, current => writeLocalFile(current.localPath, args.path, args.content, args.expected_hash))));
    server.registerTool('local_exec', { description: 'Run an unchanged command in the local environment and return a persistent job ID for polling. Reuse op_id on retries; a different request with the same ID is rejected. Windows: powershell/pwsh. Unix: bash/sh. profile=no-profile suppresses shell startup files; default enables them. HTTP disconnect/cancellation never replays a job.', inputSchema: { ...execRequestSchema.omit({ workspace_id: true }).shape, ...workspaceShape }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, args => this.tool('local_exec', args, workspace => this.jobs.execute(execRequestSchema.parse({ ...args, workspace_id: workspace.id }))));
    server.registerTool('local_job_status', { description: 'Get a job receipt including its actual exit code, synchronization errors and cancellation limits. unknown jobs are never rerun.', inputSchema: jobShape, annotations: readOnly }, args => this.tool('local_job_status', args, async workspace => this.jobs.status(workspace.id, args.job_id)));
    server.registerTool('local_job_output', { description: 'Read bounded stdout/stderr using independent byte cursors. truncated indicates that earlier output was dropped.', inputSchema: { ...jobShape, stdout_offset: z.number().int().nonnegative().default(0), stderr_offset: z.number().int().nonnegative().default(0), max_bytes: z.number().int().min(1).max(65536).default(65536) }, annotations: readOnly }, args => this.tool('local_job_output', args, async workspace => this.jobs.output(workspace.id, args.job_id, args.stdout_offset, args.stderr_offset, args.max_bytes)));
    server.registerTool('local_job_cancel', { description: 'Request process tree cancellation and poll until a final receipt. Windows uses taskkill /T /F; Unix uses a process group. Detached descendants may survive. Cancellation never reruns the command.', inputSchema: jobShape, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, args => this.tool('local_job_cancel', args, workspace => this.jobs.cancel(workspace.id, args.job_id)));
    let session!: Session;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: this.options.statefulTransport ? () => randomUUID() : undefined, enableJsonResponse: true,
      // Host/Origin protection is applied to both routes before entering the SDK.
      onsessioninitialized: id => { this.sessions.set(id, session); },
    });
    session = { server, transport };
    await server.connect(transport);
    const onclose = transport.onclose;
    transport.onclose = () => {
      onclose?.();
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
      this.transports.delete(session);
    };
    this.transports.add(session);
    return session;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.shutdown().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    if (this.starting) await this.starting;
    this.closing = true;
    const http = this.http;
    const closed = http ? new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); }) : Promise.resolve();
    const outcomes = await Promise.allSettled([
      this.jobs.stop(),
      ...[...this.transports].map(session => session.server.close()),
      ...[...this.workspaceQueues.values()],
    ]);
    http?.closeAllConnections();
    await closed;
    this.http = undefined;
    this.endpoint = undefined;
    this.sessions.clear();
    this.transports.clear();
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
