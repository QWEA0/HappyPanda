import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, HappyPandaAPI, SshAlias } from '../../shared/types';
import { errorText, initialState, requireDesktop } from './api';

export interface Notice {
  id: number;
  kind: 'error' | 'success' | 'info';
  title: string;
  detail?: string;
}

export type ActionResult<T> = { ok: true; value: T } | { ok: false };
export type RunAction = <T>(
  key: string,
  title: string,
  action: (api: HappyPandaAPI) => Promise<T>,
  options?: { refresh?: boolean; success?: string },
) => Promise<ActionResult<T>>;

export function useAppState() {
  const [state, setState] = useState<AppState>(initialState);
  const [loading, setLoading] = useState(Boolean(window.happyPanda));
  const [aliases, setAliases] = useState<SshAlias[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const pendingRef = useRef(new Set<string>());
  const revisionRef = useRef(0);
  const mountedRef = useRef(true);
  const noticeId = useRef(0);
  // Main sends scrollback only via getState; between those, rebuild it from terminal events.
  const bufferRef = useRef('');
  const contextRef = useRef('');

  const notify = useCallback((kind: Notice['kind'], title: string, detail?: string) => {
    if (mountedRef.current) setNotice({ id: ++noticeId.current, kind, title, detail });
  }, []);

  const refresh = useCallback(async (api: HappyPandaAPI) => {
    const revision = revisionRef.current;
    const next = await api.getState();
    if (mountedRef.current && revision === revisionRef.current) {
      bufferRef.current = next.terminalBuffer;
      contextRef.current = `${next.connection.activeNodeId || ''}/${next.connection.activeSessionId || ''}`;
      setState(next);
    }
  }, []);

  const run: RunAction = useCallback(async (key, title, action, options = {}) => {
    if (pendingRef.current.has(key)) return { ok: false };
    pendingRef.current.add(key);
    if (mountedRef.current) setPending(new Set(pendingRef.current));
    try {
      const api = requireDesktop();
      const value = await action(api);
      if (options.refresh !== false) {
        try {
          await refresh(api);
        } catch (error) {
          notify('error', '操作已完成，但状态刷新失败', errorText(error));
          return { ok: true, value };
        }
      }
      if (options.success) notify('success', options.success);
      return { ok: true, value };
    } catch (error) {
      notify('error', `${title}失败`, errorText(error));
      return { ok: false };
    } finally {
      pendingRef.current.delete(key);
      if (mountedRef.current) setPending(new Set(pendingRef.current));
    }
  }, [notify, refresh]);

  const loadAliases = useCallback(async () => {
    const result = await run('ssh-aliases', '读取 SSH 配置', (api) => api.listSshAliases(), { refresh: false });
    if (result.ok && mountedRef.current) setAliases(result.value);
  }, [run]);

  const reloadState = useCallback(() => run('refresh-state', '读取桌面状态', (api) => refresh(api), { refresh: false }), [refresh, run]);

  useEffect(() => {
    mountedRef.current = true;
    const api = window.happyPanda;
    if (!api) return () => { mountedRef.current = false; };
    let alive = true;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = api.onEvent((event) => {
        if (!alive) return;
        if (event.type === 'terminal') {
          bufferRef.current = (bufferRef.current + event.data).slice(-512000);
        } else if (event.type === 'state') {
          revisionRef.current += 1;
          const context = `${event.state.connection.activeNodeId || ''}/${event.state.connection.activeSessionId || ''}`;
          if (context !== contextRef.current) { contextRef.current = context; bufferRef.current = ''; }
          setState({ ...event.state, terminalBuffer: bufferRef.current });
        } else if (event.type === 'activity') {
          setState((previous) => ({
            ...previous,
            activities: [...previous.activities.filter((item) => item.id !== event.activity.id), event.activity].slice(-100),
          }));
        }
      });
    } catch (error) {
      notify('error', '订阅桌面事件失败', errorText(error));
    }
    void refresh(api).catch((error: unknown) => {
      if (alive) notify('error', '读取桌面状态失败', errorText(error));
    }).finally(() => { if (alive) setLoading(false); });
    void api.listSshAliases().then((items) => {
      if (alive) setAliases(items);
    }).catch((error: unknown) => {
      if (alive) notify('error', '读取 SSH 配置失败', errorText(error));
    });
    return () => {
      alive = false;
      mountedRef.current = false;
      unsubscribe?.();
    };
  }, [notify, refresh]);

  useEffect(() => {
    if (!notice || notice.kind === 'error') return;
    const timer = window.setTimeout(() => setNotice((current) => current?.id === notice.id ? null : current), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return {
    state, loading, aliases, notice, pending, run, notify, loadAliases, reloadState,
    dismissNotice: () => setNotice(null),
    hasDesktop: Boolean(window.happyPanda),
  };
}
