import { useId, useState, type FormEvent } from 'react';
import { ArrowLeftRight, Plus, Trash2, ExternalLink } from 'lucide-react';
import type { PortForward } from '../../../shared/types';
import { validPort } from '../format';
import type { RunAction } from '../useAppState';
import { IconButton, Modal, SubmitButton, type DialogFeedback } from './ui';

export function PortDialog({ nodeId, forwards, pending, run, onAdded, onRemoved, onClose, ...feedback }: DialogFeedback & {
  nodeId: string; forwards: PortForward[]; pending: Set<string>; run: RunAction;
  onAdded: (forward: PortForward) => void; onRemoved: (id: string) => void; onClose: () => void;
}) {
  const baseId = useId();
  const [remote, setRemote] = useState('');
  const [local, setLocal] = useState('');
  const [error, setError] = useState('');
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!validPort(remote) || (local.trim() && (!validPort(local) || Number(local) < 1024))) {
      setError('服务器端口范围是 1–65535，本机端口范围是 1024–65535。');
      return;
    }
    setError('');
    const result = await run('add-forward', '建立端口转发', (api) => api.addPortForward(Number(remote), local.trim() ? Number(local) : undefined), { refresh: false });
    if (result.ok) {
      onAdded(result.value);
      setRemote('');
      setLocal('');
    }
  };
  const remove = async (forward: PortForward) => {
    const result = await run(`remove-forward:${forward.id}`, '关闭端口转发', (api) => api.removePortForward(forward.id), { refresh: false });
    if (result.ok) onRemoved(forward.id);
  };
  const visible = forwards.filter((forward) => forward.nodeId === nodeId);
  return <Modal title="端口转发" onClose={onClose} {...feedback}>
    <form className="dialog-form" onSubmit={(event) => { void add(event); }} noValidate>
      <div className="dialog-body form-fields">
        <div className="field-pair port-fields">
          <div className="field"><label htmlFor={`${baseId}-remote`}>服务器端口</label><input id={`${baseId}-remote`} data-autofocus type="number" min={1} max={65535} step={1}
            inputMode="numeric" value={remote} onChange={(event) => setRemote(event.target.value)} placeholder="例如：3000" required aria-invalid={Boolean(error)} aria-describedby={error ? `${baseId}-error` : undefined} /></div>
          <div className="field"><label htmlFor={`${baseId}-local`}>本机端口</label><input id={`${baseId}-local`} type="number" min={1024} max={65535} step={1}
            inputMode="numeric" value={local} onChange={(event) => setLocal(event.target.value)} placeholder="自动分配" aria-invalid={Boolean(error)} aria-describedby={error ? `${baseId}-error` : undefined} /></div>
        </div>
        {error && <p id={`${baseId}-error`} className="field-error" role="alert">{error}</p>}
        {visible.length > 0 && <section className="forward-section" aria-label="本次建立的端口转发"><h3>本次建立的转发</h3><ul className="forward-list">
          {visible.map((forward) => <li key={forward.id}><ArrowLeftRight size={15} aria-hidden="true" /><span className="forward-address mono">127.0.0.1:{forward.localPort}<span className="muted"> → </span>服务器:{forward.remotePort}</span>
            <IconButton icon={ExternalLink} label="打开本机预览" onClick={() => { void run('preview-forward', '打开预览', (api) => api.openExternal('http://127.0.0.1:' + forward.localPort), { refresh: false }); }} />
            <IconButton icon={Trash2} label={`关闭端口 ${forward.localPort} 的转发`} busy={pending.has(`remove-forward:${forward.id}`)} onClick={() => { void remove(forward); }} /></li>)}
        </ul></section>}
      </div>
      <footer className="dialog-footer"><button type="button" className="button" onClick={onClose}>关闭</button>
        <SubmitButton busy={pending.has('add-forward')}><Plus size={15} aria-hidden="true" />{pending.has('add-forward') ? '建立中…' : '建立转发'}</SubmitButton></footer>
    </form>
  </Modal>;
}
