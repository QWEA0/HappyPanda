import { createHash } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { LocalHistoryProject, LocalHistorySession } from '../../shared/types';
import { compactTitle, historyProjectsRoot, readSmallJson, readTranscriptMetadata, validateHistoryFile } from './metadata';
import { isWithin } from '../sync/paths';

interface IndexEntry { sessionId?: string; summary?: string; firstPrompt?: string; customTitle?: string; projectPath?: string }
interface SessionIndex { originalPath?: string; entries?: IndexEntry[] }

function projectName(value: string): string {
  return (/^[A-Za-z]:[\\/]/.test(value) ? path.win32.basename(value) : path.basename(value)) || value;
}

export async function listLocalHistory(configDir?: string): Promise<LocalHistoryProject[]> {
  let root: string;
  try { root = await historyProjectsRoot(configDir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const projects: LocalHistoryProject[] = [];
  for await (const directory of await opendir(root)) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
    const projectPath = await realpath(path.join(root, directory.name));
    if (!isWithin(root, projectPath)) continue;
    let index: SessionIndex = {};
    try {
      const value = await readSmallJson(path.join(projectPath, 'sessions-index.json'));
      if (value && typeof value === 'object') index = value as SessionIndex;
    } catch { /* Missing, stale, or oversized indexes fall back to bounded JSONL metadata. */ }
    const indexed = new Map((Array.isArray(index.entries) ? index.entries : []).filter(entry => entry && typeof entry.sessionId === 'string').map(entry => [entry.sessionId!, entry]));
    const sessions: LocalHistorySession[] = [];
    let originalPath = typeof index.originalPath === 'string' ? index.originalPath : undefined;
    for await (const entry of await opendir(projectPath)) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.jsonl') || entry.name.startsWith('agent-')) continue;
      const file = path.join(projectPath, entry.name);
      try {
        const canonical = await validateHistoryFile(root, file, true);
        const info = await lstat(canonical);
        const metadata = await readTranscriptMetadata(canonical);
        const id = path.basename(entry.name, '.jsonl');
        const saved = indexed.get(id) ?? indexed.get(metadata.sessionId ?? '');
        originalPath ??= metadata.cwd ?? saved?.projectPath;
        sessions.push({ id: metadata.sessionId ?? id, path: canonical,
          title: compactTitle(saved?.customTitle) ?? compactTitle(saved?.summary) ?? metadata.title ?? compactTitle(saved?.firstPrompt) ?? id,
          cwd: metadata.cwd ?? saved?.projectPath ?? originalPath, writerVersion: metadata.writerVersions.at(-1),
          modifiedAt: info.mtime.toISOString(), bytes: info.size });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.id.localeCompare(b.id));
    if (sessions.length) projects.push({ id: createHash('sha256').update(projectPath).digest('hex').slice(0, 24),
      name: projectName(originalPath ?? directory.name), path: projectPath, sessions });
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}
