import { useState } from 'react';
import { Check, Folder, FolderOpen, Laptop, Server } from 'lucide-react';
import type { ServiceNode, SyncConflict, Workspace } from '../../../shared/types';
import type { RunAction } from '../useAppState';
import { Modal, SubmitButton, type DialogFeedback } from './ui';

export function WorkspaceDialog({ node, workspaces, activeId, pending, run, onConnect, onClose, ...feedback }: DialogFeedback & {
  node: ServiceNode; workspaces: Workspace[]; activeId?: string; pending: Set<string>; run: RunAction;
  onConnect: (node: ServiceNode, workspaceId: string) => void; onClose: () => void;
}) {
  const chooseNew = async () => {
    const result = await run('choose-workspace', '选择本地目录', (api) => api.chooseWorkspace(node.id));
    if (result.ok && result.value) {
      onClose();
      onConnect(node, result.value.id);
    }
  };
  const available = workspaces.filter((workspace) => workspace.nodeId === node.id);
  return <Modal title="选择工作区" onClose={onClose} {...feedback}>
    <div className="dialog-body workspace-picker">
      <div className="dialog-context"><Server size={15} aria-hidden="true" /><span>{node.name}</span></div>
      {available.length ? <ul className="workspace-list">{available.map((workspace) => <li key={workspace.id}>
        <button className="workspace-option" disabled={pending.has('connect') || pending.has('choose-workspace')} onClick={() => { onClose(); onConnect(node, workspace.id); }}>
          <Folder size={18} aria-hidden="true" /><span className="option-text"><strong>{workspace.name}</strong><span className="muted mono" title={workspace.localPath}>{workspace.localPath}</span></span>
          {workspace.id === activeId && <Check size={16} className="success-text" aria-label="当前工作区" />}
        </button></li>)}</ul> : <p className="empty-inline">尚未保存工作区</p>}
    </div>
    <footer className="dialog-footer"><button className="button" onClick={onClose}>取消</button>
      <button className="button primary" disabled={pending.has('choose-workspace')} aria-busy={pending.has('choose-workspace')} onClick={() => { void chooseNew(); }}>
        <FolderOpen size={15} aria-hidden="true" />{pending.has('choose-workspace') ? '正在选择…' : '选择本地目录'}</button></footer>
  </Modal>;
}

export function ConflictDialog({ conflict, pending, run, onClose, ...feedback }: DialogFeedback & {
  conflict: SyncConflict; pending: Set<string>; run: RunAction; onClose: () => void;
}) {
  const [prefer, setPrefer] = useState<'local' | 'remote' | null>(null);
  const key = `resolve-conflict:${conflict.path}`;
  const resolve = async () => {
    if (!prefer) return;
    const result = await run(key, '解决同步冲突', (api) => api.resolveConflict(conflict.path, prefer), { success: '冲突处理已提交' });
    if (result.ok) onClose();
  };
  return <Modal title="处理同步冲突" onClose={onClose} {...feedback}>
    <form onSubmit={(event) => { event.preventDefault(); void resolve(); }} className="dialog-form">
      <div className="dialog-body form-fields">
        <div className="field"><span className="field-label">冲突文件</span><code className="conflict-path">{conflict.path}</code></div>
        {conflict.description && <p className="conflict-description">{conflict.description}</p>}
        <fieldset className="version-choices"><legend>保留版本</legend>
          <label><input type="radio" name="conflict-preference" value="local" checked={prefer === 'local'} onChange={() => setPrefer('local')} /><Laptop size={17} aria-hidden="true" /><span>本机版本</span></label>
          <label><input type="radio" name="conflict-preference" value="remote" checked={prefer === 'remote'} onChange={() => setPrefer('remote')} /><Server size={17} aria-hidden="true" /><span>服务器版本</span></label>
        </fieldset>
        <p className="muted">将以所选版本解决此文件的同步冲突。</p>
      </div>
      <footer className="dialog-footer"><button type="button" className="button" onClick={onClose}>{pending.has(key) ? '关闭' : '取消'}</button>
        <SubmitButton busy={pending.has(key)} disabled={!prefer}>{pending.has(key) ? '处理中…' : '确认处理'}</SubmitButton></footer>
    </form>
  </Modal>;
}
