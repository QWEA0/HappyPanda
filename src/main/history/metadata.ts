import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isWithin } from '../sync/paths';

export const METADATA_HEAD_BYTES = 256 * 1024;
export const METADATA_TAIL_BYTES = 128 * 1024;
export const MAX_METADATA_LINE = 1024 * 1024;

export interface TranscriptMetadata {
  sessionId?: string;
  cwd?: string;
  title?: string;
  titleKind?: 'custom' | 'summary' | 'prompt';
  writerVersions: string[];
  skippedRecords: number;
}

export function compactTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/\s+/g, ' ').trim().slice(0, 160) || undefined;
}

class MetadataScanner {
  private pending = '';
  private pendingBytes = 0;
  private discarding = false;
  private readonly versions = new Set<string>();
  private readonly decoder = new StringDecoder('utf8');
  private prompt?: string;
  private customTitle?: string;
  private summary?: string;
  sessionId?: string;
  cwd?: string;
  skippedRecords = 0;

  constructor(discardFirst = false) { this.discarding = discardFirst; }

  private record(line: string): void {
    if (!line.trim()) return;
    let value;
    try { value = JSON.parse(line); } catch { this.skippedRecords++; return; }
    if (!value || typeof value !== 'object') return;
    if (typeof value.sessionId === 'string') this.sessionId ??= value.sessionId;
    if (typeof value.cwd === 'string') this.cwd ??= value.cwd;
    if (typeof value.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.version)) this.versions.add(value.version);
    if (typeof value.writerVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.writerVersion)) this.versions.add(value.writerVersion);
    if (value.type === 'custom-title') this.customTitle = compactTitle(value.customTitle) ?? this.customTitle;
    if (value.type === 'summary') this.summary = compactTitle(value.summary) ?? this.summary;
    if (!this.prompt && value.type === 'user') {
      const content = value.message?.content;
      if (typeof content === 'string') this.prompt = compactTitle(content);
      else if (Array.isArray(content)) this.prompt = compactTitle(content.find(item => item?.type === 'text' && typeof item.text === 'string')?.text);
    }
  }

  private text(text: string): void {
    let position = 0;
    while (position < text.length) {
      const newline = text.indexOf('\n', position);
      const end = newline < 0 ? text.length : newline;
      const fragment = text.slice(position, end);
      if (!this.discarding) {
        const bytes = Buffer.byteLength(fragment);
        if (this.pendingBytes + bytes > MAX_METADATA_LINE) {
          this.pending = ''; this.pendingBytes = 0; this.discarding = true; this.skippedRecords++;
        } else { this.pending += fragment; this.pendingBytes += bytes; }
      }
      if (newline < 0) break;
      if (!this.discarding) this.record(this.pending);
      this.pending = ''; this.pendingBytes = 0; this.discarding = false; position = newline + 1;
    }
  }

  feed(chunk: Buffer): void { this.text(this.decoder.write(chunk)); }
  finish(): TranscriptMetadata {
    this.text(this.decoder.end());
    if (this.pending && !this.discarding) this.record(this.pending);
    return { sessionId: this.sessionId, cwd: this.cwd, title: this.customTitle ?? this.summary ?? this.prompt,
      titleKind: this.customTitle ? 'custom' : this.summary ? 'summary' : this.prompt ? 'prompt' : undefined,
      writerVersions: [...this.versions].sort(compareVersions), skippedRecords: this.skippedRecords };
  }
}

export function localConfigDir(configDir?: string): string {
  return path.resolve(configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'));
}

export async function historyProjectsRoot(configDir?: string): Promise<string> {
  const root = await realpath(path.join(localConfigDir(configDir), 'projects'));
  if (!(await lstat(root)).isDirectory()) throw new Error('Local projects root is not a directory');
  return root;
}

export async function validateHistoryFile(root: string, requested: string, primary = false): Promise<string> {
  if (!path.isAbsolute(requested) || path.extname(requested).toLowerCase() !== '.jsonl') throw new Error('Select a JSONL file inside the actual local projects root');
  const canonical = await realpath(requested);
  if (!isWithin(root, canonical)) throw new Error('Selected transcript is outside the actual local projects root');
  const relative = path.relative(root, canonical);
  const parts = relative.split(path.sep);
  if (primary && (parts.length !== 2 || parts[1].startsWith('agent-'))) throw new Error('Select a top-level session transcript, not a subagent or configuration file');
  // Windows can spell a real directory using either its long or 8.3 name.
  // Retain the requested spelling when checking links, then compare real roots.
  let requestedRoot = path.resolve(requested);
  for (const _part of parts) requestedRoot = path.dirname(requestedRoot);
  if (await realpath(requestedRoot) !== root) throw new Error('Selected transcript is outside the actual local projects root');
  let current = requestedRoot;
  for (const part of path.relative(requestedRoot, requested).split(path.sep)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('History symbolic links are not allowed');
  }
  if (!isWithin(root, canonical) || !(await lstat(canonical)).isFile()) throw new Error('Selected transcript is outside the local projects root');
  return canonical;
}

async function scanRegion(file: string, start: number, end: number, discardFirst = false): Promise<TranscriptMetadata> {
  const scanner = new MetadataScanner(discardFirst);
  if (end >= start) for await (const chunk of createReadStream(file, { start, end, highWaterMark: 64 * 1024 })) scanner.feed(chunk as Buffer);
  return scanner.finish();
}

export async function readTranscriptMetadata(file: string): Promise<TranscriptMetadata> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Metadata source must be a regular file');
  if (!info.size) return { writerVersions: [], skippedRecords: 0 };
  const head = await scanRegion(file, 0, Math.min(info.size, METADATA_HEAD_BYTES) - 1);
  if (info.size <= METADATA_HEAD_BYTES) return head;
  const start = Math.max(METADATA_HEAD_BYTES, info.size - METADATA_TAIL_BYTES);
  const tail = await scanRegion(file, start, info.size - 1, true);
  const title = tail.titleKind === 'custom' || (tail.titleKind === 'summary' && head.titleKind !== 'custom') ? tail : head.title ? head : tail;
  return { sessionId: head.sessionId ?? tail.sessionId, cwd: head.cwd ?? tail.cwd, title: title.title, titleKind: title.titleKind,
    writerVersions: [...new Set([...head.writerVersions, ...tail.writerVersions])].sort(compareVersions),
    skippedRecords: head.skippedRecords + tail.skippedRecords };
}

export async function readSmallJson(file: string, limit = 4 * 1024 * 1024): Promise<unknown> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('Index is not a bounded metadata file');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('Index exceeds metadata limit');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
}

export async function snapshotTranscript(root: string, source: string, destination: string): Promise<{ sha256: string; bytes: number; metadata: TranscriptMetadata }> {
  const canonical = await validateHistoryFile(root, source);
  const input = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output;
  try {
    const before = await input.stat();
    if (!before.isFile()) throw new Error('Transcript is not a regular file');
    output = await open(destination, 'wx', 0o600);
    const scanner = new MetadataScanner();
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of input.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      const buffer = chunk as Buffer;
      bytes += buffer.length; hash.update(buffer); scanner.feed(buffer);
      await output.writeFile(buffer);
    }
    const after = await input.stat();
    const current = await lstat(await validateHistoryFile(root, canonical));
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== current.ino || before.size !== current.size || before.mtimeMs !== current.mtimeMs) {
      throw new Error('Transcript changed during export; retry when its writer is idle');
    }
    return { sha256: hash.digest('hex'), bytes, metadata: scanner.finish() };
  } finally { await output?.close(); await input.close(); }
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(/[.-]/).slice(0, 3).map(Number);
  const right = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return a.localeCompare(b);
}

export function versionWarnings(versions: string[], targetVersion?: string): string[] {
  const unique = [...new Set(versions)].sort(compareVersions);
  if (!targetVersion) return ['Remote Claude writer compatibility could not be checked; transcripts are archived without rewriting'];
  if (!unique.length) return [`No transcript writer version was found; compatibility with remote Claude ${targetVersion} is unverified`];
  const newer = unique.filter(version => compareVersions(version, targetVersion) > 0);
  if (newer.length) return [`Transcript writer ${newer.join(', ')} is newer than remote Claude ${targetVersion}; resume compatibility is unverified. Original content and UUIDs are preserved`];
  if (unique.some(version => version !== targetVersion)) return [`Transcript writer ${unique.join(', ')} differs from remote Claude ${targetVersion}; archive preservation does not prove resume compatibility`];
  return [];
}
