import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { timed } from '../perf';
import { JSON_TEMPLATE } from './state';
import { runCommand, type CommandRunner, type SshPreparation } from './transport';

export interface MutagenCliOptions {
  dataDir: string;
  mutagenPath?: string;
  runCommand?: CommandRunner;
  /** Stop the isolated daemon once before first use of an app SSH transport so it adopts MUTAGEN_SSH_PATH. */
  restartDaemonOnTransportChange?: boolean;
}

/** `daemon stop` exits 1 with this message when no daemon is running; there is nothing to restart then. */
export function isDaemonNotRunning(error: unknown): boolean {
  return /unable to connect to daemon|is the daemon running/i.test(error instanceof Error ? error.message : String(error));
}

/**
 * One isolated Mutagen daemon shared by every workspace synchronizer in the app.
 * Owns binary discovery, the transport restart and coalescing of polling reads.
 */
export class MutagenCli {
  readonly dataDir: string;
  private readonly runner: CommandRunner;
  private binary?: string;
  private transportDirectory?: string;
  private restart?: Promise<void>;
  private started = false;
  private lastConnection?: SshPreparation;
  private mutations = 0;
  private polled?: { key: string; at: number; result: Promise<string> };

  constructor(private readonly options: MutagenCliOptions) {
    this.runner = options.runCommand ?? runCommand;
    this.dataDir = path.resolve(options.dataDir, 'mutagen');
  }

  private async resolveBinary(): Promise<string> {
    if (!this.binary) {
      const executable = process.platform === 'win32' ? 'mutagen.exe' : 'mutagen';
      const candidate = path.resolve('.local', 'tools', executable);
      try { await access(candidate); this.binary = this.options.mutagenPath ?? candidate; }
      catch { this.binary = this.options.mutagenPath ?? executable; }
    }
    return this.binary;
  }

  private environment(connection?: SshPreparation): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, MUTAGEN_DATA_DIRECTORY: this.dataDir };
    if (connection?.mutagenSshPath) env.MUTAGEN_SSH_PATH = connection.mutagenSshPath;
    return env;
  }

  async run(args: string[], connection?: SshPreparation): Promise<string> {
    await mkdir(this.dataDir, { recursive: true });
    const binary = await this.resolveBinary();
    // Calls without a transport (daemon stop) keep the environment the daemon was started with.
    connection ??= this.lastConnection;
    if (connection) this.lastConnection = connection;
    const env = this.environment(connection);
    const directory = connection?.mutagenSshPath;
    if (this.options.restartDaemonOnTransportChange && directory && this.transportDirectory !== directory) {
      // Concurrent first calls from several workspaces share one restart.
      this.transportDirectory = directory;
      this.restart = this.runner(binary, ['daemon', 'stop'], { env, timeoutMs: 15_000 }).then(() => undefined, error => {
        if (isDaemonNotRunning(error)) return;
        if (this.transportDirectory === directory) this.transportDirectory = undefined;
        throw error;
      });
    }
    if (this.restart) await this.restart;
    this.started = true;
    const mutating = args[1] !== 'list';
    if (mutating) { this.mutations++; this.polled = undefined; }
    try {
      return await timed('mutagen ' + args.slice(0, 2).join(' '), () => this.runner(binary, args, { env, timeoutMs: args[1] === 'flush' ? 120_000 : 60_000 }));
    } finally { if (mutating) this.mutations++; }
  }

  list(connection?: SshPreparation): Promise<string> {
    return this.run(['sync', 'list', '--template', JSON_TEMPLATE], connection);
  }

  /**
   * Background status polls from several workspaces share one `sync list` within
   * `maxAgeMs`. A result is reused only if no mutation started or finished while
   * it was in flight, so a poll never reports state from before a pause/resume.
   */
  pollList(connection?: SshPreparation, maxAgeMs = 1500): Promise<string> {
    const key = connection?.mutagenSshPath ?? '';
    const cached = this.polled;
    if (cached && cached.key === key && Date.now() - cached.at < maxAgeMs) return cached.result;
    const epoch = this.mutations;
    const entry = { key, at: Date.now(), result: this.list(connection) };
    this.polled = entry;
    entry.result.then(() => { if (this.mutations !== epoch && this.polled === entry) this.polled = undefined; },
      () => { if (this.polled === entry) this.polled = undefined; });
    return entry.result;
  }

  async stopDaemon(): Promise<void> {
    if (!this.started) return;
    try { await this.run(['daemon', 'stop']); }
    catch (error) { if (!isDaemonNotRunning(error)) throw error; }
  }
}
