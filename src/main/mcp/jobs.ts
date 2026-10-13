import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ActivityEvent } from '../../shared/types';
import { atomicJson, hash, LocalToolError } from './files';

export const OUTPUT_LIMIT = 256 * 1024;
export const shellSchema = z.enum(['powershell', 'pwsh', 'bash', 'sh']);
export const profileSchema = z.enum(['default', 'no-profile']);
export const execRequestSchema = z.object({
  workspace_id: z.string().min(1).max(256),
  relativecwd: z.string().min(1).max(4096).default('.'),
  command: z.string().min(1).max(65536),
  shell: shellSchema.default(process.platform === 'win32' ? 'powershell' : 'sh'),
  profile: profileSchema.default('no-profile'),
  op_id: z.string().min(1).max(256),
  timeout_ms: z.number().int().min(1).max(86400000).default(60000),
});
export type ExecRequest = z.infer<typeof execRequestSchema>;
const errorSchema = z.object({ code: z.string(), message: z.string() });
const statusSchema = z.enum(['requested', 'running', 'completed', 'cancelled', 'timed_out', 'failed', 'unknown']);
const journalSchema = z.object({
  version: z.literal(1), job_id: z.string().uuid(), fingerprint: z.string(), request: execRequestSchema,
  root: z.string(), cwd: z.string(), platform: z.string(), status: statusSchema,
  requested_at: z.string(), started_at: z.string().nullable(), finished_at: z.string().nullable(),
  pid: z.number().int().positive().nullable(), exit_code: z.number().int().nullable(), signal: z.string().nullable(),
  stdout_base64: z.string().max(Math.ceil(OUTPUT_LIMIT / 3) * 4),
  stderr_base64: z.string().max(Math.ceil(OUTPUT_LIMIT / 3) * 4),
  stdout_bytes: z.number().int().nonnegative(), stderr_bytes: z.number().int().nonnegative(),
  cancellation_requested: z.boolean(), cancellation_reason: z.enum(['cancel', 'timeout', 'stop']).nullable(),
  cancellation_error: z.string().nullable(), error: errorSchema.nullable(),
}).strict();
type Journal = z.infer<typeof journalSchema>;
interface Runtime {
  record: Journal;
  stdout: Buffer;
  stderr: Buffer;
  child?: ChildProcess;
  timeout?: NodeJS.Timeout;
  flushTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  persistence: Promise<void>;
  done: Promise<void>;
  resolveDone: () => void;
  finishing?: Promise<void>;
  cancellation?: Promise<void>;
  settled: boolean;
}
interface JobOptions {
  dataDir: string;
  resolveCwd: (request: ExecRequest) => Promise<{ root: string; cwd: string }>;
  beforeOperation?: (workspaceId: string) => Promise<void>;
  afterOperation?: (workspaceId: string, info?: { mutates: boolean }) => Promise<void>;
  onActivity: (event: Omit<ActivityEvent, 'id' | 'time'>) => void;
}
const terminal = (record: Journal): boolean => record.status !== 'requested' && record.status !== 'running';
const message = (error: unknown): string => error instanceof Error ? error.message : 'Operation failed.';
const cancellationMethod = process.platform === 'win32' ? 'taskkill /PID <pid> /T /F' : 'process group SIGTERM, then SIGKILL';
const cancellationLimitations = process.platform === 'win32'
  ? 'taskkill cannot guarantee termination of detached descendants or processes requiring additional privileges; Windows Job Objects are not used.'
  : 'Process group cancellation cannot reach descendants that create a new session/process group or require additional privileges.';

export function shellArgv(shell: ExecRequest['shell'], profile: ExecRequest['profile'], command: string) {
  if (process.platform === 'win32') {
    if (shell !== 'powershell' && shell !== 'pwsh') throw new LocalToolError('UNSUPPORTED_SHELL', 'Windows jobs require powershell or pwsh; Git Bash and WSL are not configured.');
    return { executable: shell === 'powershell' ? 'powershell.exe' : 'pwsh.exe', argv: [...(profile === 'no-profile' ? ['-NoProfile'] : []), '-NonInteractive', '-Command', command] };
  }
  if (shell !== 'bash' && shell !== 'sh') throw new LocalToolError('UNSUPPORTED_SHELL', 'Unix jobs require bash or sh.');
  return { executable: shell === 'bash' ? '/bin/bash' : '/bin/sh', argv: shell === 'bash'
    ? (profile === 'no-profile' ? ['--noprofile', '--norc', '-c', command] : ['-l', '-c', command])
    : (profile === 'no-profile' ? ['-c', command] : ['-l', '-c', command]) };
}

export class LocalJobs {
  private directory: string;
  private readonly operations = new Map<string, Runtime>();
  private readonly jobs = new Map<string, Runtime>();
  private readonly starting = new Map<string, Promise<Record<string, unknown>>>();
  private stopping = false;

  constructor(private readonly options: JobOptions) { this.directory = path.join(options.dataDir, 'mcp-jobs'); }

  async initialize(): Promise<void> {
    this.stopping = false;
    this.operations.clear();
    this.jobs.clear();
    this.starting.clear();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.directory = await realpath(this.directory);
    for (const filename of await readdir(this.directory)) {
      if (!filename.endsWith('.json')) continue;
      const location = path.join(this.directory, filename);
      if ((await stat(location)).size > 2 * 1024 * 1024) throw new LocalToolError('INVALID_JOURNAL', 'Job journal exceeds its size limit.');
      const record = journalSchema.parse(JSON.parse(await readFile(location, 'utf8')));
      if (filename !== `${hash(record.request.op_id)}.json` || record.fingerprint !== hash(JSON.stringify(record.request)) || this.jobs.has(record.job_id)) {
        throw new LocalToolError('INVALID_JOURNAL', 'Job journal identity does not match its request.');
      }
      const runtime = this.runtime(record);
      if (runtime.stdout.length > OUTPUT_LIMIT || runtime.stderr.length > OUTPUT_LIMIT || record.stdout_bytes < runtime.stdout.length || record.stderr_bytes < runtime.stderr.length) {
        throw new LocalToolError('INVALID_JOURNAL', 'Job journal output cursors are invalid.');
      }
      if (!terminal(record)) {
        record.status = 'unknown';
        record.finished_at = new Date().toISOString();
        record.error = { code: 'OUTCOME_UNKNOWN', message: 'Bridge restarted before a durable final receipt. The command will not be rerun; reconcile its artifacts and processes manually.' };
        await this.persist(runtime);
      }
      runtime.settled = true;
      runtime.resolveDone();
      this.operations.set(record.request.op_id, runtime);
      this.jobs.set(record.job_id, runtime);
    }
  }

  private runtime(record: Journal): Runtime {
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    return { record, stdout: Buffer.from(record.stdout_base64, 'base64'), stderr: Buffer.from(record.stderr_base64, 'base64'), persistence: Promise.resolve(), done, resolveDone, settled: false };
  }

  private persist(runtime: Runtime): Promise<void> {
    const write = runtime.persistence.catch(() => undefined).then(async () => {
      runtime.record.stdout_base64 = runtime.stdout.toString('base64');
      runtime.record.stderr_base64 = runtime.stderr.toString('base64');
      await atomicJson(path.join(this.directory, `${hash(runtime.record.request.op_id)}.json`), runtime.record);
    });
    runtime.persistence = write.catch(error => {
      runtime.record.error = { code: 'JOURNAL_WRITE_FAILED', message: message(error) };
      throw error;
    });
    return runtime.persistence;
  }

  private activity(runtime: Runtime, title: string): void {
    try {
      this.options.onActivity({ kind: 'command', title, detail: `job_id=${runtime.record.job_id}; status=${runtime.record.status}`, location: 'local', workspaceId: runtime.record.request.workspace_id });
    } catch {
      runtime.record.error = { code: 'ACTIVITY_CALLBACK_FAILED', message: 'Activity callback failed.' };
    }
  }

  async execute(request: ExecRequest): Promise<Record<string, unknown>> {
    if (this.stopping) throw new LocalToolError('BRIDGE_STOPPING', 'Bridge is stopping.');
    const fingerprint = hash(JSON.stringify(request));
    const existing = this.operations.get(request.op_id);
    if (existing) {
      if (existing.record.fingerprint !== fingerprint) throw new LocalToolError('OP_ID_CONFLICT', 'op_id already belongs to a different request. Use a new op_id for a different command, workspace, cwd, shell, profile or timeout.');
      return this.starting.get(request.op_id) ?? this.snapshot(existing);
    }
    // Reserve the operation before any asynchronous path/sync work; concurrent sessions share it.
    const record: Journal = {
      version: 1, job_id: randomUUID(), fingerprint, request, root: '', cwd: '', platform: process.platform,
      status: 'requested', requested_at: new Date().toISOString(), started_at: null, finished_at: null,
      pid: null, exit_code: null, signal: null, stdout_base64: '', stderr_base64: '', stdout_bytes: 0, stderr_bytes: 0,
      cancellation_requested: false, cancellation_reason: null, cancellation_error: null, error: null,
    };
    const runtime = this.runtime(record);
    this.operations.set(request.op_id, runtime);
    this.jobs.set(record.job_id, runtime);
    const pending = this.launch(runtime);
    this.starting.set(request.op_id, pending);
    try { return await pending; } finally { this.starting.delete(request.op_id); }
  }

  private async launch(runtime: Runtime): Promise<Record<string, unknown>> {
    const record = runtime.record;
    try {
      const initial = await this.options.resolveCwd(record.request);
      Object.assign(record, initial);
      const relativeJournal = path.relative(initial.root, path.resolve(this.directory));
      if (relativeJournal === '' || (!path.isAbsolute(relativeJournal) && relativeJournal !== '..' && !relativeJournal.startsWith(`..${path.sep}`))) {
        throw new LocalToolError('JOURNAL_IN_WORKSPACE', 'dataDir must be app-owned storage outside the workspace.');
      }
      const { executable, argv } = shellArgv(record.request.shell, record.request.profile, record.request.command);
      await this.persist(runtime);
      if (this.options.beforeOperation) {
        try { await this.options.beforeOperation(record.request.workspace_id); }
        catch (error) { throw new LocalToolError('BEFORE_OPERATION_FAILED', message(error)); }
      }
      const current = await this.options.resolveCwd(record.request);
      if (this.stopping || record.cancellation_requested) throw new LocalToolError('CANCELLED_BEFORE_START', 'Job was cancelled before starting.');
      if (current.root !== record.root || current.cwd !== record.cwd) throw new LocalToolError('WORKSPACE_CHANGED', 'Workspace or working directory changed during the synchronization barrier.');
      const child = spawn(executable, argv, { cwd: record.cwd, env: { ...process.env }, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      runtime.child = child;
      child.stdout!.on('data', (chunk: Buffer) => this.append(runtime, 'stdout', chunk));
      child.stderr!.on('data', (chunk: Buffer) => this.append(runtime, 'stderr', chunk));
      child.on('error', error => { record.error = { code: 'PROCESS_ERROR', message: message(error) }; });
      child.once('close', (code, signal) => { void this.finish(runtime, code, signal); });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      record.pid = child.pid ?? null;
      record.started_at = new Date().toISOString();
      if (!runtime.finishing) record.status = 'running';
      this.activity(runtime, 'Local command started');
      await this.persist(runtime);
      if (!runtime.finishing) {
        runtime.timeout = setTimeout(() => { void this.cancelRuntime(runtime, 'timeout').catch(error => { record.cancellation_error = message(error); }); }, record.request.timeout_ms);
        runtime.timeout.unref();
      }
    } catch (error) {
      if (runtime.settled) return this.snapshot(runtime);
      record.error = { code: error instanceof LocalToolError ? error.code : 'JOB_START_FAILED', message: message(error) };
      if (runtime.child?.pid && !runtime.finishing) {
        await this.cancelRuntime(runtime, 'stop').catch(killError => { record.cancellation_error = message(killError); });
      } else if (!runtime.finishing) {
        record.status = record.cancellation_requested ? 'cancelled' : 'failed';
        record.finished_at = new Date().toISOString();
        this.activity(runtime, 'Local command did not start');
        if (!(error instanceof LocalToolError && error.code === 'JOURNAL_IN_WORKSPACE')) {
          try { await this.persist(runtime); } catch { /* persist exposes its error in the result. */ }
        }
        runtime.settled = true;
        runtime.resolveDone();
      }
    }
    return this.snapshot(runtime);
  }

  private append(runtime: Runtime, stream: 'stdout' | 'stderr', chunk: Buffer): void {
    if (runtime.settled) return;
    runtime.record[`${stream}_bytes`] += chunk.length;
    runtime[stream] = chunk.length >= OUTPUT_LIMIT ? Buffer.from(chunk.subarray(chunk.length - OUTPUT_LIMIT))
      : Buffer.concat([runtime[stream].subarray(Math.max(0, runtime[stream].length + chunk.length - OUTPUT_LIMIT)), chunk]);
    if (!runtime.flushTimer) {
      runtime.flushTimer = setTimeout(() => {
        runtime.flushTimer = undefined;
        void this.persist(runtime).catch(() => undefined);
      }, 250);
      runtime.flushTimer.unref();
    }
  }

  private finish(runtime: Runtime, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (runtime.finishing) return runtime.finishing;
    runtime.finishing = this.finalize(runtime, code, signal);
    return runtime.finishing;
  }

  private async finalize(runtime: Runtime, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    clearTimeout(runtime.timeout);
    clearTimeout(runtime.flushTimer);
    clearTimeout(runtime.killTimer);
    const record = runtime.record;
    record.exit_code = code;
    record.signal = signal;
    // Keep status running until the after-operation barrier and final journal receipt are ready.
    if (record.pid && this.options.afterOperation) {
      try { await this.options.afterOperation(record.request.workspace_id); }
      catch (error) { record.error = { code: 'AFTER_OPERATION_FAILED', message: message(error) }; }
    }
    if (runtime.settled) return;
    record.status = record.cancellation_reason === 'timeout' ? 'timed_out' : record.cancellation_requested ? 'cancelled' : record.error?.code === 'PROCESS_ERROR' ? 'failed' : 'completed';
    record.finished_at = new Date().toISOString();
    this.activity(runtime, record.status === 'completed' ? 'Local command completed' : 'Local command stopped');
    try { await this.persist(runtime); } catch { /* Journal errors remain explicit on this receipt. */ }
    runtime.settled = true;
    runtime.resolveDone();
  }

  private lookup(workspaceId: string, jobId: string): Runtime {
    const runtime = this.jobs.get(jobId);
    if (!runtime || runtime.record.request.workspace_id !== workspaceId) throw new LocalToolError('JOB_NOT_FOUND', 'Job does not belong to this workspace.');
    return runtime;
  }

  status(workspaceId: string, jobId: string): Record<string, unknown> { return this.snapshot(this.lookup(workspaceId, jobId)); }

  output(workspaceId: string, jobId: string, stdoutOffset: number, stderrOffset: number, maxBytes: number): Record<string, unknown> {
    const runtime = this.lookup(workspaceId, jobId);
    const slice = (stream: 'stdout' | 'stderr', offset: number) => {
      const total = runtime.record[`${stream}_bytes`];
      if (offset > total) throw new LocalToolError('INVALID_OUTPUT_CURSOR', 'Output cursor is beyond the end of the stream.');
      const base = total - runtime[stream].length;
      const start = Math.max(offset, base);
      const bytes = runtime[stream].subarray(start - base, start - base + maxBytes);
      return { text: bytes.toString('utf8'), offset: start, next_offset: start + bytes.length, total_bytes: total, truncated: offset < base };
    };
    return { job_id: jobId, workspace_id: workspaceId, status: this.publicStatus(runtime), stdout: slice('stdout', stdoutOffset), stderr: slice('stderr', stderrOffset) };
  }

  async cancel(workspaceId: string, jobId: string): Promise<Record<string, unknown>> {
    const runtime = this.lookup(workspaceId, jobId);
    await this.cancelRuntime(runtime, 'cancel');
    return this.snapshot(runtime);
  }

  private cancelRuntime(runtime: Runtime, reason: 'cancel' | 'timeout' | 'stop'): Promise<void> {
    if (runtime.settled || runtime.finishing) return Promise.resolve();
    if (runtime.cancellation) return runtime.cancellation;
    runtime.record.cancellation_requested = true;
    runtime.record.cancellation_reason = reason;
    runtime.cancellation = this.terminate(runtime);
    return runtime.cancellation;
  }

  private async terminate(runtime: Runtime): Promise<void> {
    let journalFailure: unknown;
    try { await this.persist(runtime); } catch (error) { journalFailure = error; }
    const child = runtime.child;
    try {
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
        if (journalFailure) throw new LocalToolError('JOURNAL_WRITE_FAILED', 'Cancellation journal failed; its receipt remains an error.');
        return;
      }
      if (process.platform === 'win32') {
        await new Promise<void>((resolve, reject) => {
          execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000, maxBuffer: 16384 }, error => {
            if (error && !runtime.finishing && !runtime.settled) reject(error); else resolve();
          });
        });
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        if (!runtime.finishing && !runtime.settled) {
          runtime.killTimer = setTimeout(() => {
            try { process.kill(-child.pid!, 'SIGKILL'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') runtime.record.cancellation_error = message(error); }
          }, 1500);
          runtime.killTimer.unref();
        }
      }
    } catch (error) {
      runtime.record.cancellation_error = message(error);
      try { await this.persist(runtime); } catch { /* The receipt retains JOURNAL_WRITE_FAILED. */ }
      throw new LocalToolError('CANCEL_FAILED', 'Process tree cancellation failed. Poll the original job; do not rerun it.');
    }
    // An unavailable journal must not prevent terminating an already-running OS process.
    if (journalFailure) throw new LocalToolError('JOURNAL_WRITE_FAILED', 'Process cancellation was attempted, but its journal could not be saved.');
  }

  private snapshot(runtime: Runtime): Record<string, unknown> {
    const record = runtime.record;
    return {
      job_id: record.job_id, op_id: record.request.op_id, workspace_id: record.request.workspace_id,
      status: this.publicStatus(runtime), cwd: record.cwd, shell: record.request.shell, profile: record.request.profile, platform: record.platform,
      timeout_ms: record.request.timeout_ms, pid: record.pid, requested_at: record.requested_at,
      started_at: record.started_at, finished_at: record.finished_at, exit_code: record.exit_code, signal: record.signal,
      stdout: runtime.stdout.toString('utf8'), stderr: runtime.stderr.toString('utf8'),
      stdout_bytes: record.stdout_bytes, stderr_bytes: record.stderr_bytes,
      stdout_dropped_bytes: record.stdout_bytes - runtime.stdout.length, stderr_dropped_bytes: record.stderr_bytes - runtime.stderr.length,
      cancellation_requested: record.cancellation_requested, cancellation_reason: record.cancellation_reason,
      cancellation_method: cancellationMethod, cancellation_limitations: cancellationLimitations,
      cancellation_error: record.cancellation_error, error: record.error,
    };
  }

  private publicStatus(runtime: Runtime): Journal['status'] {
    return terminal(runtime.record) && !runtime.settled ? (runtime.record.pid ? 'running' : 'requested') : runtime.record.status;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const active = [...this.jobs.values()].filter(runtime => !runtime.settled);
    await Promise.all(active.map(async runtime => {
      await this.cancelRuntime(runtime, 'stop').catch(error => { runtime.record.cancellation_error = message(error); });
      let timer!: NodeJS.Timeout;
      await Promise.race([runtime.done, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]);
      clearTimeout(timer);
      if (!runtime.settled) {
        clearTimeout(runtime.timeout);
        clearTimeout(runtime.flushTimer);
        clearTimeout(runtime.killTimer);
        runtime.record.status = 'unknown';
        runtime.record.finished_at = new Date().toISOString();
        runtime.record.error = { code: 'OUTCOME_UNKNOWN', message: 'Shutdown could not confirm process termination and synchronization. Do not rerun this operation automatically.' };
        runtime.settled = true;
        try { await this.persist(runtime); }
        finally {
          runtime.resolveDone();
          runtime.child?.stdout?.destroy();
          runtime.child?.stderr?.destroy();
          runtime.child?.unref();
        }
      }
      await runtime.persistence;
    }));
  }
}
