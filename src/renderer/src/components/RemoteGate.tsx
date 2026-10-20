import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, LoaderCircle, LogOut, RefreshCw, Terminal } from 'lucide-react';
import type { RemoteClientStatus } from '../../../shared/remote';
import { IconButton, NoticeBanner, Status, SubmitButton } from './ui';
import '../remote.css';

export interface RemoteGateProps {
  status: RemoteClientStatus;
  onPair: (code: string, name: string) => Promise<void>;
  onReconnect: () => void;
  onLogout: () => Promise<void>;
  children: ReactNode;
}

export function RemoteGate({ status, onPair, onReconnect, onLogout, children }: RemoteGateProps) {
  const id = useId();
  const [name, setName] = useState('Android');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<'pair' | 'logout' | null>(null);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const pendingRef = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (status.authenticated) { setCode(''); setError(''); } }, [status.authenticated]);

  const run = async (key: 'pair' | 'logout', action: () => Promise<void>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(key);
    setError('');
    try { await action(); }
    catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : key === 'pair' ? '配对失败，请重试。' : '取消配对失败，请重试。');
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(null);
    }
  };
  const reconnect = () => {
    setError('');
    try { onReconnect(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '重新连接失败，请重试。'); }
  };
  const pair = (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{8}$/.test(code)) { setError('请输入 8 位数字配对码。'); return; }
    void run('pair', () => onPair(code, name.trim() || 'Android'));
  };
  const connecting = status.phase === 'connecting' || status.phase === 'reconnecting';

  if (status.authenticated) return <div className="remote-client">
    <div className={`remote-connection-banner ${status.phase === 'connected' ? '' : 'remote-connection-interrupted'}`}>
      <div className="remote-connection-row"><div className="remote-connection-text">
        <Status tone={status.phase === 'connected' ? 'success' : 'warning'} busy={connecting}>
          {status.phase === 'connected' ? '已连接 PC' : connecting ? '正在重新连接 PC' : '与 PC 的连接已断开'}</Status>
        {status.phase !== 'connected' && status.message && <p>{status.message}</p>}
      </div>
      {status.phase !== 'connected' && <IconButton icon={RefreshCw} label="重新连接 PC" disabled={Boolean(pending)} onClick={reconnect} />}
      <IconButton icon={LogOut} label="取消此设备的配对" busy={pending === 'logout'} disabled={Boolean(pending)} onClick={() => { void run('logout', onLogout); }} /></div>
      {error && <p className="field-error remote-banner-error" role="alert">{error}</p>}
    </div>
    <div className="remote-client-content">{children}</div>
  </div>;

  const message = error || status.message || (status.phase === 'revoked' ? '此设备的配对已取消，请重新配对。' : '');
  return <main className="remote-gate">
    <div className="remote-gate-content">
      <div className="app-brand remote-gate-brand"><Terminal size={20} aria-hidden="true" /><strong>HappyPanda</strong></div>
      <h1>{connecting ? '正在连接 PC' : '连接 PC'}</h1>
      {connecting ? <div className="remote-gate-progress">
        <div className="remote-gate-progress-status" role="status"><LoaderCircle size={21} className="spin" aria-hidden="true" /><span>正在连接</span></div>
        {message && <p className={error ? 'field-error' : 'muted'} role={error ? 'alert' : undefined}>{message}</p>}
        <button type="button" className="button" disabled={Boolean(pending)} onClick={reconnect}><RefreshCw size={15} aria-hidden="true" />重新连接</button>
      </div> : <form className="remote-pair-form" onSubmit={pair} noValidate>
        {message && <NoticeBanner notice={{ id: 0, kind: 'error', title: message }} />}
        <div className="field"><label htmlFor={`${id}-name`}>设备名称</label><input id={`${id}-name`} value={name} maxLength={80} autoComplete="off" disabled={Boolean(pending)} onChange={(event) => setName(event.target.value)} /></div>
        <div className="field"><label htmlFor={`${id}-code`}>8 位配对码</label><input id={`${id}-code`} className="remote-code-input mono" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" maxLength={8}
          value={code} placeholder="00000000" required spellCheck={false} disabled={Boolean(pending)} aria-invalid={Boolean(error)}
          onChange={(event) => { setCode(event.target.value.replace(/\D/g, '').slice(0, 8)); setError(''); }} /></div>
        <SubmitButton busy={pending === 'pair'} disabled={Boolean(pending) || code.length !== 8}>
          {pending !== 'pair' && <KeyRound size={16} aria-hidden="true" />}{pending === 'pair' ? '正在配对' : '配对并连接'}</SubmitButton>
      </form>}
    </div>
  </main>;
}
