import { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, LoaderCircle, Monitor, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import QRCode from 'qrcode';
import { DESKTOP_OWNER, type DesktopRemoteControlAPI, type RemoteControlState } from '../../../shared/remote';
import { formatTime } from '../format';
import { IconButton, Modal, NoticeBanner, Status } from './ui';
import '../remote.css';

export interface RemoteDialogProps {
  api: DesktopRemoteControlAPI;
  onClose: () => void;
}

async function copyLink(text: string) {
  try {
    if (window.happyPanda?.copyText) {
      await window.happyPanda.copyText(text);
      return;
    }
  } catch { /* Fall through when the desktop clipboard is unavailable. */ }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch { /* LAN HTTP pages may need the selection-based fallback. */ }
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const input = document.createElement('textarea');
  input.value = text;
  input.readOnly = true;
  input.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
  document.body.append(input);
  try {
    input.focus();
    input.select();
    input.setSelectionRange(0, text.length);
    if (!document.execCommand('copy')) throw new Error('复制失败，请重试。');
  } finally {
    input.remove();
    previous?.focus({ preventScroll: true });
  }
}

export function RemoteDialog({ api, onClose }: RemoteDialogProps) {
  const id = useId();
  const [state, setState] = useState<RemoteControlState | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [address, setAddress] = useState('');
  const [copied, setCopied] = useState('');
  const [now, setNow] = useState(Date.now);
  const [qr, setQr] = useState<{ link: string; image: string } | null>(null);
  const [qrError, setQrError] = useState('');
  const mounted = useRef(false);
  const pendingRef = useRef<string | null>(null);
  const revisionRef = useRef(0);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    let receivedState = false;
    setLoading(true);
    setState(null);
    setError('');
    const unsubscribe = api.onState((next) => {
      if (!active) return;
      receivedState = true;
      revisionRef.current += 1;
      setState(next);
      setLoading(false);
    });
    void api.getState().then((next) => {
      if (active && !receivedState) setState(next);
    }).catch((cause: unknown) => {
      if (active && !receivedState) setError(cause instanceof Error ? cause.message : '获取远控状态失败，请重试。');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; mounted.current = false; unsubscribe(); };
  }, [api]);

  const pairing = state?.enabled ? state.pairing : undefined;
  useEffect(() => {
    setNow(Date.now());
    if (!pairing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pairing?.expiresAt]);
  const expiresAt = pairing ? Date.parse(pairing.expiresAt) : NaN;
  const remaining = Number.isFinite(expiresAt) ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0;
  const pairingActive = Boolean(pairing && remaining > 0);
  const addresses = state?.addresses || [];
  const selectedAddress = addresses.includes(address) ? address : addresses[0] || '';
  const link = pairingActive && selectedAddress && pairing ? `${selectedAddress}#pair=${pairing.token}` : '';
  const busy = loading || Boolean(pending);

  useEffect(() => {
    let active = true;
    setQr(null);
    setQrError('');
    setCopied('');
    if (link) void QRCode.toDataURL(link, {
      width: 176, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' },
    }).then((image) => { if (active) setQr({ link, image }); }).catch(() => {
      if (active) setQrError('二维码生成失败，可复制配对链接。');
    });
    return () => { active = false; };
  }, [link]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(''), 2500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const run = async (key: string, action: () => Promise<RemoteControlState>) => {
    if (pendingRef.current) return;
    pendingRef.current = key;
    const revision = revisionRef.current;
    setPending(key);
    setError('');
    try {
      const next = await action();
      if (mounted.current) { if (revision === revisionRef.current) setState(next); setNow(Date.now()); }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '操作失败，请重试。');
    } finally {
      pendingRef.current = null;
      if (mounted.current) setPending(null);
    }
  };

  const toggle = () => run('toggle', async () => {
    const next = await api.setEnabled(!state?.enabled);
    return next.enabled && !next.pairing ? api.createPairing() : next;
  });

  const copy = async () => {
    if (!link || busy || pendingRef.current || Date.now() >= expiresAt) return;
    pendingRef.current = 'copy';
    setPending('copy');
    setError('');
    try {
      await copyLink(link);
      if (mounted.current) setCopied(link);
    } catch {
      if (mounted.current) setError('复制失败，请重试。');
    } finally {
      pendingRef.current = null;
      if (mounted.current) setPending(null);
    }
  };

  const message = error || state?.error;
  return <Modal title="手机远控" onClose={onClose}>
    <div className="dialog-body remote-admin">
      {message && <NoticeBanner notice={{ id: 0, kind: 'error', title: message }} />}
      {loading && !state ? <div className="remote-admin-loading" role="status"><LoaderCircle size={18} className="spin" aria-hidden="true" />正在获取远控状态</div>
        : !state ? <div className="remote-admin-loading"><span className="muted">远控状态暂不可用</span>
          <button type="button" className="button" disabled={busy} onClick={() => { void run('load', () => api.getState()); }}>
            <RefreshCw size={15} className={pending === 'load' ? 'spin' : undefined} aria-hidden="true" />重新加载</button></div>
        : <>
          <div className="remote-admin-toggle"><div><strong id={`${id}-enabled`}>允许手机远控</strong><Status tone={state.enabled ? 'success' : 'neutral'} busy={pending === 'toggle'}>{state.enabled ? '已开启' : '已关闭'}</Status></div>
            <button type="button" className="switch" role="switch" aria-labelledby={`${id}-enabled`} aria-checked={state.enabled}
              aria-busy={pending === 'toggle' || undefined} disabled={busy} onClick={() => { void toggle(); }}><span aria-hidden="true" /></button></div>
          {state.enabled && <section className="remote-admin-section" aria-labelledby={`${id}-pairing`}>
            <div className="remote-section-heading"><h3 id={`${id}-pairing`}>配对手机</h3>
              <button type="button" className="button compact" disabled={busy} aria-busy={pending === 'pairing' || undefined} onClick={() => { void run('pairing', () => api.createPairing()); }}>
                <RefreshCw size={14} className={pending === 'pairing' ? 'spin' : undefined} aria-hidden="true" />{pairing ? '刷新配对' : '生成配对码'}</button></div>
            <div className="field remote-address-field"><label htmlFor={addresses.length > 1 ? `${id}-address` : undefined}>连接地址</label>
              {addresses.length > 1 ? <select id={`${id}-address`} value={selectedAddress} disabled={busy} onChange={(event) => setAddress(event.target.value)}>
                {addresses.map((item) => <option key={item} value={item}>{item}</option>)}</select>
                : <p className="remote-address mono">{selectedAddress || '暂无可用地址'}</p>}</div>
            <div className="remote-pairing">
              <div className="remote-pairing-qr" aria-busy={Boolean(link && !qr && !qrError)}>
                {link && qr?.link === link ? <img src={qr.image} alt="手机远控配对二维码" width={176} height={176} />
                  : link && !qrError ? <LoaderCircle size={22} className="spin" aria-label="正在生成二维码" />
                    : <span>{qrError ? '二维码暂不可用' : pairingActive ? '暂无可用地址' : pairing ? '配对已过期' : '尚未生成配对码'}</span>}
              </div>
              <div className="remote-pairing-details"><span className="field-label">8 位配对码</span>
                <output className={`remote-pairing-code mono ${pairingActive ? '' : 'remote-pairing-expired'}`} aria-label={pairingActive ? `配对码 ${pairing?.code}` : '配对码不可用'} aria-disabled={!pairingActive}>
                  {pairingActive && pairing ? `${pairing.code.slice(0, 4)} ${pairing.code.slice(4)}` : '---- ----'}</output>
                <span className={`remote-pairing-countdown ${pairing && !pairingActive ? 'warning-text' : 'muted'}`} role="timer" aria-label="配对码剩余时间">
                  {pairingActive ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} 后过期` : pairing ? '已过期，请刷新配对' : '尚未生成配对码'}</span>
                <button type="button" className="button" disabled={!link || busy} aria-busy={pending === 'copy' || undefined} onClick={() => { void copy(); }}>
                  {pending === 'copy' ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : copied === link && link ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                  {copied === link && link ? '已复制链接' : '复制配对链接'}</button>
                {qrError && <p className="field-error" role="alert">{qrError}</p>}
              </div>
            </div>
          </section>}
          <section className="remote-admin-section" aria-labelledby={`${id}-owner`}>
            <div className="remote-owner-row"><div className="remote-owner-label"><Monitor size={16} aria-hidden="true" /><div><h3 id={`${id}-owner`}>当前输入控制</h3><p>{state.owner.name}</p></div></div>
              {state.owner.id !== DESKTOP_OWNER.id && <button type="button" className="button compact" disabled={busy} onClick={() => { void run('reclaim', () => api.takeControl()); }}>
                {pending === 'reclaim' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Monitor size={14} aria-hidden="true" />}由 PC 接管</button>}</div>
          </section>
          <section className="remote-admin-section" aria-labelledby={`${id}-devices`}>
            <div className="remote-section-heading"><h3 id={`${id}-devices`}>已配对设备</h3><span className="muted">{state.devices.length}</span></div>
            {state.devices.length ? <ul className="remote-device-list">{state.devices.map((device) => <li key={device.id}>
              <Smartphone size={17} aria-hidden="true" /><div className="remote-device-details"><strong className="truncate" title={device.name}>{device.name}</strong>
                <span className="muted">最近在线 {formatTime(device.lastSeenAt, true)}</span></div>
              <Status tone={device.connected ? 'success' : 'neutral'}>{device.connected ? '在线' : '离线'}</Status>
              <IconButton icon={Trash2} label={`取消 ${device.name} 的配对`} className="danger-hover" disabled={busy} busy={pending === `revoke:${device.id}`} onClick={() => { void run(`revoke:${device.id}`, () => api.revokeDevice(device.id)); }} />
            </li>)}</ul> : <p className="empty-inline">暂无已配对设备</p>}
          </section>
        </>}
    </div>
    <footer className="dialog-footer"><button type="button" className="button" onClick={onClose}>关闭</button></footer>
  </Modal>;
}
