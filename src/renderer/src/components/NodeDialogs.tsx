import { useId, useState, type FormEvent } from 'react';
import { ChevronDown, RotateCw, Trash2 } from 'lucide-react';
import type { NodeInput, ServiceNode, SshAlias } from '../../../shared/types';
import { validPort } from '../format';
import type { RunAction } from '../useAppState';
import { IconButton, Modal, SubmitButton, type DialogFeedback } from './ui';

interface NodeDialogProps extends DialogFeedback {
  node?: ServiceNode;
  aliases: SshAlias[];
  pending: Set<string>;
  run: RunAction;
  loadAliases: () => Promise<void>;
  onClose: () => void;
}

export function NodeDialog({ node, aliases, pending, run, loadAliases, onClose, ...feedback }: NodeDialogProps) {
  const baseId = useId();
  const [name, setName] = useState(node?.name || '');
  const [target, setTarget] = useState(node?.sshTarget || '');
  const [user, setUser] = useState(node?.user || '');
  const [port, setPort] = useState(node?.port?.toString() || '');
  const [identity, setIdentity] = useState(node?.identityFile || '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState(Boolean(node?.user || node?.port || node?.identityFile));
  const busy = pending.has('save-node');
  const aliasValue = aliases.some((alias) => alias.name === target) ? target : '';

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (!name.trim()) nextErrors.name = '请输入节点名称。';
    if (!target.trim()) nextErrors.target = '请输入 SSH 配置 alias 或主机地址。';
    else if (/\s/.test(target.trim()) || target.trim().startsWith('-')) nextErrors.target = 'SSH 目标不能包含空格或以短横线开头。';
    if (port.trim() && !validPort(port)) nextErrors.port = '端口必须是 1 到 65535 的整数。';
    setErrors(nextErrors);
    if (nextErrors.port) setAdvanced(true);
    if (Object.keys(nextErrors).length) return;
    const input: NodeInput = {
      ...(node ? { id: node.id } : {}),
      name: name.trim(),
      sshTarget: target.trim(),
      user: user.trim() || undefined,
      port: port.trim() ? Number(port) : undefined,
      identityFile: identity.trim() || undefined,
    };
    const result = await run('save-node', '保存节点', (api) => api.saveNode(input), { success: '节点已保存' });
    if (result.ok) onClose();
  };

  return <Modal title={node ? '编辑 SSH 节点' : '新增 SSH 节点'} onClose={onClose} {...feedback}>
    <form onSubmit={(event) => { void save(event); }} noValidate className="dialog-form">
      <div className="dialog-body form-fields">
        <div className="field"><label htmlFor={`${baseId}-name`}>节点名称</label>
          <input id={`${baseId}-name`} data-autofocus value={name} onChange={(event) => { setName(event.target.value); setErrors((current) => ({ ...current, name: '' })); }}
            autoComplete="off" placeholder="例如：开发服务器" required aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? `${baseId}-name-error` : undefined} />
          {errors.name && <span className="field-error" id={`${baseId}-name-error`}>{errors.name}</span>}
        </div>
        <div className="field"><label htmlFor={`${baseId}-alias`}>SSH 配置 alias</label>
          <div className="input-with-action"><select id={`${baseId}-alias`} value={aliasValue} disabled={aliases.length === 0 || pending.has('ssh-aliases')}
            onChange={(event) => { if (event.target.value) { setTarget(event.target.value); setErrors((current) => ({ ...current, target: '' })); } }}>
            <option value="">{aliases.length ? '选择 alias' : '暂无可用 alias'}</option>
            {aliases.map((alias) => <option key={alias.name} value={alias.name}>{alias.name}{alias.hostname ? ` · ${alias.hostname}` : ''}</option>)}
          </select><IconButton icon={RotateCw} label="重新读取 SSH 配置" busy={pending.has('ssh-aliases')} onClick={() => { void loadAliases(); }} /></div>
        </div>
        <div className="field"><label htmlFor={`${baseId}-target`}>SSH 目标</label>
          <input id={`${baseId}-target`} value={target} onChange={(event) => { setTarget(event.target.value); setErrors((current) => ({ ...current, target: '' })); }} className="mono" autoComplete="off" spellCheck={false}
            placeholder="SSH 别名或 user@host" required aria-invalid={Boolean(errors.target)} aria-describedby={errors.target ? `${baseId}-target-error` : undefined} />
          {errors.target && <span className="field-error" id={`${baseId}-target-error`}>{errors.target}</span>}
        </div>
        <details className="advanced-fields" open={advanced}>
          <summary onClick={(event) => { event.preventDefault(); setAdvanced((current) => !current); }}><ChevronDown size={14} aria-hidden="true" />高级设置</summary>
          <div className="form-fields">
            <div className="field-pair">
              <div className="field"><label htmlFor={`${baseId}-user`}>用户覆盖</label><input id={`${baseId}-user`} value={user} onChange={(event) => setUser(event.target.value)} placeholder="使用 SSH 配置" autoComplete="off" /></div>
              <div className="field"><label htmlFor={`${baseId}-port`}>端口覆盖</label><input id={`${baseId}-port`} type="number" min={1} max={65535} step={1} inputMode="numeric"
                value={port} onChange={(event) => { setPort(event.target.value); setErrors((current) => ({ ...current, port: '' })); }} placeholder="使用 SSH 配置" aria-invalid={Boolean(errors.port)} aria-describedby={errors.port ? `${baseId}-port-error` : undefined} />
                {errors.port && <span className="field-error" id={`${baseId}-port-error`}>{errors.port}</span>}
              </div>
            </div>
            <div className="field"><label htmlFor={`${baseId}-identity`}>IdentityFile 路径覆盖</label><input id={`${baseId}-identity`} value={identity} onChange={(event) => setIdentity(event.target.value)}
              className="mono" placeholder="使用 SSH 配置" autoComplete="off" spellCheck={false} /></div>
          </div>
        </details>
      </div>
      <footer className="dialog-footer"><button type="button" className="button" onClick={onClose}>{busy ? '关闭' : '取消'}</button><SubmitButton busy={busy}>{busy ? '保存中…' : '保存节点'}</SubmitButton></footer>
    </form>
  </Modal>;
}

export function DeleteNodeDialog({ node, pending, run, onClose, ...feedback }: DialogFeedback & {
  node: ServiceNode; pending: Set<string>; run: RunAction; onClose: () => void;
}) {
  const remove = async () => {
    const result = await run('remove-node', '删除节点', (api) => api.removeNode(node.id), { success: '节点已删除' });
    if (result.ok) onClose();
  };
  return <Modal title="删除节点" onClose={onClose} {...feedback}>
    <div className="dialog-body"><p className="confirmation">删除本机保存的节点 <strong>{node.name}</strong>？</p><p className="muted mono break-word">{node.sshTarget}</p><p className="deletion-detail muted">关联的工作区和会话记录也会移除。</p></div>
    <footer className="dialog-footer"><button className="button" onClick={onClose} data-autofocus>{pending.has('remove-node') ? '关闭' : '取消'}</button>
      <button className="button danger" disabled={pending.has('remove-node')} aria-busy={pending.has('remove-node')} onClick={() => { void remove(); }}>
        <Trash2 size={15} aria-hidden="true" />{pending.has('remove-node') ? '删除中…' : '删除节点'}</button></footer>
  </Modal>;
}
