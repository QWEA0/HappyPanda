import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode, type RefObject } from 'react';
import { AlertTriangle, CheckCircle2, Info, LoaderCircle, X, type LucideIcon } from 'lucide-react';
import type { Tone } from '../format';
import type { Notice } from '../useAppState';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  busy?: boolean;
  tooltip?: string;
}

export function IconButton({ icon: Icon, label, busy, tooltip, className = '', disabled, ...props }: IconButtonProps) {
  return (
    <button type="button" className={`icon-button ${className}`} aria-label={label}
      title={tooltip || label} disabled={disabled || busy} aria-busy={busy || undefined} {...props}>
      {busy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Icon size={16} aria-hidden="true" />}
    </button>
  );
}

export function Status({ tone = 'neutral', children, busy = false }: { tone?: Tone; children: ReactNode; busy?: boolean }) {
  return <span className={`status tone-${tone}`}>
    {busy ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <span className="status-dot" aria-hidden="true" />}
    <span>{children}</span>
  </span>;
}

export function useFocusScope(ref: RefObject<HTMLElement | null>, active: boolean, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!active || !ref.current) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = ref.current;
    const selector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]';
    const available = () => Array.from(element.querySelectorAll<HTMLElement>(selector))
      .filter((item) => item.getClientRects().length > 0 && !item.closest('[inert]'));
    const frame = window.requestAnimationFrame(() => {
      if (element.contains(document.activeElement)) return;
      (element.querySelector<HTMLElement>('[data-autofocus]') || available()[0] || element).focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const items = available();
      const first = items[0];
      const last = items.at(-1);
      if (!first) {
        event.preventDefault();
        element.focus();
      } else if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown, true);
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus();
    };
  }, [ref, active]);
}

export interface DialogFeedback {
  feedback?: Notice | null;
  dismissFeedback?: () => void;
}

export function NoticeBanner({ notice, onDismiss }: { notice: Notice; onDismiss?: () => void }) {
  const Icon = notice.kind === 'error' ? AlertTriangle : notice.kind === 'success' ? CheckCircle2 : Info;
  return <div className={`notice notice-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
    <Icon size={16} aria-hidden="true" /><div className="notice-text"><strong>{notice.title}</strong>{notice.detail && <p>{notice.detail}</p>}</div>
    {onDismiss && <IconButton icon={X} label="关闭提示" onClick={onDismiss} />}
  </div>;
}

export function Modal({ title, children, onClose, wide = false, feedback, dismissFeedback }: DialogFeedback & {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  useFocusScope(ref, true, onClose);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={ref} className={`dialog ${wide ? 'dialog-wide' : ''}`} role="dialog" aria-modal="true"
        aria-labelledby={titleId} tabIndex={-1}>
        <header className="dialog-header"><h2 id={titleId}>{title}</h2><IconButton icon={X} label="关闭弹窗" onClick={onClose} /></header>
        {feedback && <NoticeBanner notice={feedback} onDismiss={dismissFeedback} />}
        {children}
      </section>
    </div>
  );
}

export function SubmitButton({ busy, children, disabled, className = 'button primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return <button type="submit" className={className} disabled={busy || disabled} aria-busy={busy || undefined} {...props}>
    {busy && <LoaderCircle size={15} className="spin" aria-hidden="true" />}{children}
  </button>;
}
