import type { AppState, HappyPandaAPI } from '../../shared/types';

export const DESKTOP_REQUIRED = '此操作需要 HappyPanda 桌面客户端。当前浏览器未连接桌面 IPC。';

export function requireDesktop(): HappyPandaAPI {
  if (!window.happyPanda) throw new Error(DESKTOP_REQUIRED);
  return window.happyPanda;
}

export function initialState(): AppState {
  return {
    nodes: [],
    providers: [],
    workspaces: [],
    sessions: [],
    connection: {
      phase: 'disconnected',
      message: window.happyPanda ? '尚未连接' : '浏览器预览 · 桌面 IPC 未连接',
      retryAttempt: 0,
    },
    metrics: null,
    sync: { phase: 'none', message: '', conflicts: [], updatedAt: '' },
    activities: [],
    terminalBuffer: '',
    version: '',
  };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
