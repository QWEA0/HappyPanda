import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

export class LocalToolError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'LocalToolError';
  }
}

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

export interface CanonicalPath { root: string; target: string; relative: string }

export async function canonicalPath(localRoot: string, relative = '.', allowNewFile = false): Promise<CanonicalPath> {
  if (!relative || relative.includes('\0') || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || /^[a-z]:/i.test(relative)) {
    throw new LocalToolError('PATH_OUTSIDE_WORKSPACE', 'Use a relative path inside the workspace.');
  }
  const parts = relative.replace(/\\/g, '/').split('/').filter(part => part && part !== '.');
  if (parts.some(part => part === '..')) throw new LocalToolError('PATH_OUTSIDE_WORKSPACE', 'Parent traversal is not allowed.');
  if (process.platform === 'win32' && parts.some(part => /[:<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new LocalToolError('INVALID_PATH', 'Windows device paths and alternate streams are not allowed.');
  }
  const root = await realpath(localRoot);
  if (!(await stat(root)).isDirectory()) throw new LocalToolError('INVALID_WORKSPACE_ROOT', 'Workspace root is not a directory.');
  let target = root;
  for (let index = 0; index < parts.length; index++) {
    const next = path.join(target, parts[index]);
    try {
      const entry = await lstat(next);
      if (allowNewFile && index === parts.length - 1 && entry.isSymbolicLink()) {
        throw new LocalToolError('SYMLINK_WRITE', 'Writing through a symbolic link is not supported.');
      }
      target = await realpath(next);
      if (!inside(root, target)) throw new LocalToolError('PATH_OUTSIDE_WORKSPACE', 'A symbolic link escapes the workspace.');
      if (index < parts.length - 1 && !(await stat(target)).isDirectory()) {
        throw new LocalToolError('INVALID_PATH', 'A parent component is not a directory.');
      }
    } catch (error) {
      if (!allowNewFile || index !== parts.length - 1 || !missing(error)) throw error;
      target = next;
    }
  }
  return { root, target, relative: parts.join('/') || '.' };
}

async function recheckParent(file: CanonicalPath): Promise<void> {
  const parent = path.dirname(file.target);
  const current = await realpath(parent);
  if (!inside(file.root, current) || path.relative(parent, current) !== '') {
    throw new LocalToolError('PATH_CHANGED', 'The canonical parent changed during the operation.');
  }
}

async function boundedRead(file: CanonicalPath): Promise<Buffer> {
  await recheckParent(file);
  const handle = await open(file.target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new LocalToolError('NOT_A_FILE', 'Path is not a regular file.');
    if (metadata.size > MAX_FILE_BYTES) throw new LocalToolError('FILE_TOO_LARGE', `File exceeds ${MAX_FILE_BYTES} bytes.`);
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = await handle.read(buffer, count, buffer.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count > MAX_FILE_BYTES) throw new LocalToolError('FILE_TOO_LARGE', `File exceeds ${MAX_FILE_BYTES} bytes.`);
    return buffer.subarray(0, count);
  } finally { await handle.close(); }
}

export async function readLocalFile(localRoot: string, relative: string) {
  const file = await canonicalPath(localRoot, relative);
  const bytes = await boundedRead(file);
  return { path: file.relative, content: bytes.toString('utf8'), hash: hash(bytes), bytes: bytes.length };
}

export async function writeLocalFile(localRoot: string, relative: string, content: string, expectedHash?: string | null) {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > MAX_FILE_BYTES) throw new LocalToolError('FILE_TOO_LARGE', `Content exceeds ${MAX_FILE_BYTES} bytes.`);
  const file = await canonicalPath(localRoot, relative, true);
  const checkHash = async () => {
    let actual: string | null = null;
    try { actual = hash(await boundedRead(file)); } catch (error) { if (!missing(error)) throw error; }
    if (expectedHash !== undefined && actual !== expectedHash) {
      throw new LocalToolError('HASH_CONFLICT', 'File changed; read it again before writing.', { expected_hash: expectedHash, actual_hash: actual });
    }
  };
  await checkHash();
  let mode = 0o600;
  try { mode = (await stat(file.target)).mode & 0o777; } catch (error) { if (!missing(error)) throw error; }
  await recheckParent(file);
  const temporary = path.join(path.dirname(file.target), `.happypanda-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', mode);
  try { await handle.writeFile(bytes); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(temporary).catch(() => undefined); throw error; }
  await handle.close();
  try {
    await recheckParent(file);
    // Recheck after preparing the replacement; bridge writes are serialized per workspace.
    await canonicalPath(localRoot, relative, true);
    await checkHash();
    await rename(temporary, file.target);
  } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
  return { path: file.relative, hash: hash(bytes), bytes: bytes.length };
}

export async function listLocalFiles(localRoot: string, relative: string, recursive: boolean, limit: number) {
  const directory = await canonicalPath(localRoot, relative);
  if (!(await stat(directory.target)).isDirectory()) throw new LocalToolError('NOT_A_DIRECTORY', 'Path is not a directory.');
  const entries: { path: string; type: 'file' | 'directory' | 'symlink' | 'other'; bytes: number }[] = [];
  let truncated = false;
  const walk = async (current: CanonicalPath): Promise<void> => {
    const verified = await realpath(current.target);
    if (!inside(directory.root, verified) || path.relative(current.target, verified) !== '') {
      throw new LocalToolError('PATH_CHANGED', 'Directory changed during listing.');
    }
    const children = await readdir(current.target, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (entries.length >= limit) { truncated = true; return; }
      const childRelative = current.relative === '.' ? child.name : `${current.relative}/${child.name}`;
      // List links as links, and never traverse their targets recursively.
      const info = await lstat(path.join(current.target, child.name));
      const type = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
      entries.push({ path: childRelative, type, bytes: info.size });
      if (recursive && type === 'directory') await walk(await canonicalPath(localRoot, childRelative));
      if (truncated) return;
    }
  };
  await walk(directory);
  return { path: directory.relative, entries, truncated };
}

export async function atomicJson(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(temporary).catch(() => undefined); throw error; }
  await handle.close();
  try { await rename(temporary, filename); }
  finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
  if (process.platform !== 'win32') {
    const directory = await open(path.dirname(filename), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
