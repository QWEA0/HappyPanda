import type { ConnectionPhase, ServiceNode, SshAlias, SyncPhase } from '../../shared/types';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger';

export const connectionLabels: Record<ConnectionPhase, string> = {
  disconnected: '未连接',
  preparing: '准备中',
  connecting: '连接中',
  connected: '已连接',
  retrying: '重连中',
  failed: '连接失败',
};

export const syncLabels: Record<SyncPhase, string> = {
  none: '尚未同步',
  preparing: '准备同步',
  scanning: '扫描中',
  syncing: '同步中',
  ready: '已同步',
  conflict: '存在冲突',
  paused: '已暂停',
  disconnected: '同步已断开',
  error: '同步失败',
};

export function connectionTone(phase: ConnectionPhase): Tone {
  if (phase === 'connected') return 'success';
  if (phase === 'failed') return 'danger';
  if (phase === 'disconnected') return 'neutral';
  return 'warning';
}

export function syncTone(phase: SyncPhase): Tone {
  if (phase === 'ready') return 'success';
  if (phase === 'error') return 'danger';
  if (['conflict', 'syncing', 'scanning', 'preparing', 'paused'].includes(phase)) return 'warning';
  return 'neutral';
}

export function nodeAddress(node: ServiceNode, aliases: SshAlias[] = []): string {
  const alias = aliases.find((item) => item.name === node.sshTarget);
  const destination = alias?.hostname || node.sshTarget;
  const separator = destination.lastIndexOf('@');
  const hostname = separator >= 0 ? destination.slice(separator + 1) : destination;
  const user = node.user || alias?.user || (separator >= 0 ? destination.slice(0, separator) : '');
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return `${user ? `${user}@` : ''}${host}:${node.port || alias?.port || 22}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '不可用';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}

export function formatTime(value: string, detailed = false): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间不可用';
  return date.toLocaleString('zh-CN', detailed
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '不可用';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days > 0 ? `${days} 天 ${hours} 小时` : hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

export function validPort(value: string): boolean {
  const number = Number(value);
  return value.trim() !== '' && Number.isInteger(number) && number >= 1 && number <= 65535;
}
