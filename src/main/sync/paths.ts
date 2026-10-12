import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export function isWithin(root: string, candidate: string, allowRoot = false): boolean {
  const relative = path.relative(root, candidate);
  return (allowRoot || relative !== '') && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function conflictRelativePath(value: string): string {
  if (!value || value.includes('\\') || /[\0\r\n:]/.test(value) || path.posix.isAbsolute(value)) throw new Error('Conflict path must be relative to the workspace');
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')) throw new Error('Conflict path escapes the workspace or targets Git internals');
  return value;
}

export async function checkedLocalPath(root: string, relative: string): Promise<string> {
  conflictRelativePath(relative);
  if (await realpath(root) !== root) throw new Error('Workspace root changed');
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if (!isWithin(root, current)) throw new Error('Path is outside the workspace');
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Symbolic links are not allowed for conflict resolution');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return current;
}

export async function fileFingerprint(file: string): Promise<{ exists: boolean; sha256?: string; bytes?: number }> {
  let info;
  try { info = await lstat(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Only individual regular files or deletions can be resolved; directories require manual review');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const after = await lstat(file);
  if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ino !== after.ino) throw new Error('File changed while reading; retry when its writer is idle');
  return { exists: true, sha256: hash.digest('hex'), bytes: info.size };
}

export function sameFingerprint(a: { exists: boolean; sha256?: string; bytes?: number }, b: { exists: boolean; sha256?: string; bytes?: number }): boolean {
  return a.exists === b.exists && a.sha256 === b.sha256 && a.bytes === b.bytes;
}
