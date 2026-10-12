import type { SyncState } from '../../shared/types';

export interface MutagenProblem { path: string; error: string }
export interface MutagenEndpoint {
  protocol: string;
  path: string;
  host?: string;
  user?: string;
  port?: number;
  connected: boolean;
  scanned?: boolean;
  scanProblems?: MutagenProblem[];
  excludedScanProblems?: number;
  transitionProblems?: MutagenProblem[];
  excludedTransitionProblems?: number;
  stagingProgress?: { totalReceivedSize?: number };
  ignore?: { paths?: string[]; vcs?: string };
}
export interface MutagenSession {
  identifier: string;
  name?: string;
  mode?: string;
  paused: boolean;
  status: string;
  lastError?: string;
  successfulCycles?: number;
  conflicts?: { root: string; alphaChanges?: unknown[]; betaChanges?: unknown[] }[];
  excludedConflicts?: number;
  alpha: MutagenEndpoint;
  beta: MutagenEndpoint;
  ignore?: { paths?: string[]; vcs?: string };
}

export const JSON_TEMPLATE = '{{ json . }}';

export function parseMutagenSessions(output: string): MutagenSession[] {
  const value: unknown = JSON.parse(output.replace(/^\uFEFF/, '').trim());
  const endpointValid = (endpoint: MutagenEndpoint) => endpoint && typeof endpoint.path === 'string' &&
    typeof endpoint.protocol === 'string' && typeof endpoint.connected === 'boolean' && (!endpoint.connected || typeof endpoint.scanned === 'boolean');
  if (!Array.isArray(value) || value.some(item => !item || typeof item.identifier !== 'string' || typeof item.status !== 'string' ||
    typeof item.paused !== 'boolean' || !endpointValid(item.alpha) || !endpointValid(item.beta) ||
    (item.conflicts !== undefined && (!Array.isArray(item.conflicts) || item.conflicts.some((c: { root?: unknown }) => typeof c?.root !== 'string'))))) {
    throw new Error('Invalid Mutagen structured session response');
  }
  return value as MutagenSession[];
}

export function normalizeMutagenState(session?: MutagenSession): SyncState {
  const state: SyncState = {
    phase: 'none', message: 'No synchronization session', conflicts: [], updatedAt: new Date().toISOString(),
  };
  if (!session) return state;
  state.sessionName = session.name ?? session.identifier;
  state.conflicts = (session.conflicts ?? []).map(conflict => ({ path: conflict.root, description: 'Local and remote changes conflict' }));
  const problems: string[] = [];
  for (const [side, endpoint] of [['local', session.alpha], ['remote', session.beta]] as const) {
    for (const issue of endpoint.scanProblems ?? []) problems.push(`${side} scan: ${issue.path || '.'}: ${issue.error}`);
    for (const issue of endpoint.transitionProblems ?? []) problems.push(`${side} write: ${issue.path || '.'}: ${issue.error}`);
    if (endpoint.excludedScanProblems) problems.push(`${side}: ${endpoint.excludedScanProblems} more scan problems`);
    if (endpoint.excludedTransitionProblems) problems.push(`${side}: ${endpoint.excludedTransitionProblems} more write problems`);
  }
  state.bytesTransferred = (session.alpha.stagingProgress?.totalReceivedSize ?? 0) + (session.beta.stagingProgress?.totalReceivedSize ?? 0);
  if (session.lastError) problems.unshift(session.lastError);
  if (session.status.startsWith('halted-')) problems.unshift(`Mutagen ${session.status}`);
  if (problems.length) { state.phase = 'error'; state.message = problems.join('\n'); }
  else if (session.paused) { state.phase = 'paused'; state.message = 'Synchronization paused'; }
  else if (state.conflicts.length || session.excludedConflicts) {
    state.phase = 'conflict';
    state.message = `${state.conflicts.length + (session.excludedConflicts ?? 0)} synchronization conflicts${session.excludedConflicts ? ' (list truncated)' : ''}`;
  } else if (session.status === 'disconnected' || session.alpha.connected === false || session.beta.connected === false) {
    state.phase = session.status.startsWith('connecting-') ? 'preparing' : 'disconnected'; state.message = 'Waiting for SSH synchronization connection';
  } else if (['scanning', 'waiting-for-rescan'].includes(session.status)) {
    state.phase = 'scanning'; state.message = 'Scanning workspace files';
  } else if (['reconciling', 'staging-alpha', 'staging-beta', 'transitioning', 'saving'].includes(session.status)) {
    state.phase = 'syncing'; state.message = 'Synchronizing workspace files';
  } else if (session.status === 'watching' && session.successfulCycles && session.alpha.scanned === true && session.beta.scanned === true) {
    state.phase = 'ready'; state.message = 'Workspace synchronized';
  } else if (session.status.startsWith('connecting-') || session.status === 'watching') {
    state.phase = 'preparing'; state.message = 'Preparing workspace synchronization';
  } else { state.phase = 'error'; state.message = `Unrecognized Mutagen status: ${session.status}`; }
  return state;
}
