export interface QuickCommand { id: string; label: string; command: string }

export const TERMINAL_KEYS = [
  { label: 'Esc', data: '\x1b' }, { label: 'Tab', data: '\t' }, { label: 'Shift+Tab', data: '\x1b[Z' },
  { label: 'Ctrl+C', data: '\x03' }, { label: 'Ctrl+D', data: '\x04' }, { label: 'Ctrl+L', data: '\x0c' },
  { label: 'Ctrl+A', data: '\x01' }, { label: 'Ctrl+E', data: '\x05' }, { label: 'Ctrl+U', data: '\x15' },
  { label: 'Ctrl+K', data: '\x0b' }, { label: 'Ctrl+Z', data: '\x1a' },
  { label: 'Home', data: '\x1b[H' }, { label: 'End', data: '\x1b[F' },
  { label: 'PgUp', data: '\x1b[5~' }, { label: 'PgDn', data: '\x1b[6~' },
];

export const QUICK_COMMANDS: Record<'claude' | 'shell', QuickCommand[]> = {
  claude: ['/help', '/compact', '/clear', '/model', '/status', '/resume'].map(command => ({ id: command, label: command, command })),
  shell: ['pwd', 'ls', 'git status', 'git diff', 'git log --oneline -5', 'git branch'].map(command => ({ id: command, label: command, command })),
};

export function parseQuickCommands(raw: string | null): QuickCommand[] {
  try {
    const value: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(value)) return [];
    const ids = new Set<string>();
    return value.filter((item): item is QuickCommand => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || ids.has(item.id)
        || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 64
        || typeof item.command !== 'string' || !item.command.trim() || item.command.length > 4096) return false;
      ids.add(item.id);
      return true;
    }).slice(0, 24);
  } catch { return []; }
}

export function terminalDisplayScale(viewport: { width: number; height: number }, screen: { width: number; height: number }) {
  if (![viewport.width, viewport.height, screen.width, screen.height].every(value => Number.isFinite(value) && value > 0)) return 1;
  return Math.min(1, viewport.width / screen.width, viewport.height / screen.height);
}

export async function toggleRemoteFullscreen(target: Document = document) {
  if (target.fullscreenElement) { await target.exitFullscreen(); return; }
  if (!target.fullscreenEnabled || !target.documentElement.requestFullscreen) throw new Error('当前浏览器不支持全屏，请使用 Chrome 或 Edge 打开。');
  try { await target.documentElement.requestFullscreen({ navigationUI: 'hide' }); }
  catch (cause) { throw new Error('浏览器未允许进入全屏。', { cause }); }
}
