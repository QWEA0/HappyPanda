import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, FileText, Folder, LoaderCircle, Play, RotateCw, Upload } from 'lucide-react';
import type { ImportResult, LocalHistoryProject, Workspace } from '../../../shared/types';
import { errorText, requireDesktop } from '../api';
import { fileName, formatBytes, formatTime } from '../format';
import type { RunAction } from '../useAppState';
import { IconButton, Modal, SubmitButton, type DialogFeedback } from './ui';

function ProjectCheckbox({ label, checked, partial, disabled, onChange }: {
  label: string; checked: boolean; partial: boolean; disabled: boolean; onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = partial; }, [partial]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked} disabled={disabled}
    onClick={(event) => event.stopPropagation()} onChange={onChange} />;
}

export function ImportDialog({ workspace, pending, run, onResume, onClose, ...feedback }: DialogFeedback & {
  workspace: Workspace; pending: Set<string>; run: RunAction;
  onResume: (workspaceId: string, transcriptPath: string) => void; onClose: () => void;
}) {
  const [projects, setProjects] = useState<LocalHistoryProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<ImportResult | null>(null);
  const aliveRef = useRef(true);
  const loadingRef = useRef(false);
  const busy = pending.has('import-history');

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setLoadError('');
    try {
      const items = await requireDesktop().listLocalHistory();
      if (aliveRef.current) { setProjects(items); setSelected(new Set()); }
    } catch (error) {
      if (aliveRef.current) setLoadError(errorText(error));
    } finally {
      loadingRef.current = false;
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => { aliveRef.current = false; };
  }, [load]);

  const toggleSession = (path: string) => setSelected((previous) => {
    const next = new Set(previous);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const toggleProject = (project: LocalHistoryProject) => setSelected((previous) => {
    const next = new Set(previous);
    const remove = project.sessions.every((session) => next.has(session.path));
    for (const session of project.sessions) { if (remove) next.delete(session.path); else next.add(session.path); }
    return next;
  });
  const importSelected = async () => {
    if (!selected.size) return;
    const imported = await run('import-history', '导入会话', (api) => api.importHistory({ workspaceId: workspace.id, sessionPaths: [...selected] }));
    if (imported.ok && aliveRef.current) setResult(imported.value);
  };
  const selectedBytes = projects.flatMap((project) => project.sessions).filter((session) => selected.has(session.path)).reduce((sum, session) => sum + session.bytes, 0);

  return <Modal title="导入本机会话" onClose={onClose} wide {...feedback}>
    <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); void importSelected(); }}>
      <div className="dialog-body import-body">
        <div className="import-context"><Folder size={15} aria-hidden="true" /><span className="truncate" title={workspace.remotePath}>目标工作区：{workspace.name}</span>
          {!result && <IconButton icon={RotateCw} label="刷新本机会话" busy={loading} disabled={busy} onClick={() => { void load(); }} />}</div>
        {result ? <div className="import-result">
          <div className="import-summary"><CheckCircle2 size={19} className="success-text" aria-hidden="true" /><strong>已导入 {result.imported} 个会话</strong><span className="muted">{formatBytes(result.bytes)}</span></div>
          {result.warnings.length > 0 && <div className="import-warnings" role="status"><AlertTriangle size={16} aria-hidden="true" /><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
          {result.remotePaths.length ? <ul className="imported-list">{result.remotePaths.map((path) => <li key={path}>
            <FileText size={16} aria-hidden="true" /><span className="option-text"><strong>{fileName(path)}</strong><span className="muted mono break-word">{path}</span></span>
            <button type="button" className="button compact" onClick={() => { onClose(); onResume(workspace.id, path); }}><Play size={14} aria-hidden="true" />续接</button>
          </li>)}</ul> : <p className="empty-inline">没有返回可续接的记录路径</p>}
        </div> : loading ? <div className="import-empty" role="status"><LoaderCircle size={21} className="spin" aria-hidden="true" /><p>正在读取本机会话</p></div>
          : loadError ? <div className="import-empty" role="alert"><AlertTriangle size={21} aria-hidden="true" /><p>{loadError}</p>
            <button type="button" className="button" onClick={() => { void load(); }}><RotateCw size={14} aria-hidden="true" />重试</button></div>
            : projects.length === 0 ? <p className="empty-inline">未找到本地 Claude 会话记录</p>
              : <div className="history-projects">{projects.map((project) => {
                const count = project.sessions.filter((session) => selected.has(session.path)).length;
                return <details className="history-project" key={project.id} open={projects.length === 1 ? true : undefined}>
                  <summary><ProjectCheckbox label={`选择 ${project.name} 的全部会话`} checked={project.sessions.length > 0 && count === project.sessions.length}
                    partial={count > 0 && count < project.sessions.length} disabled={busy || project.sessions.length === 0} onChange={() => toggleProject(project)} />
                    <Folder size={16} aria-hidden="true" /><span className="option-text"><strong>{project.name}</strong><span className="muted mono truncate" title={project.path}>{project.path}</span></span>
                    <span className="muted">{project.sessions.length}</span><ChevronDown size={14} className="disclosure-icon" aria-hidden="true" /></summary>
                  <ul className="history-sessions">{project.sessions.map((session) => <li key={session.path}><label>
                    <input type="checkbox" checked={selected.has(session.path)} disabled={busy} onChange={() => toggleSession(session.path)} aria-label={`选择会话 ${session.title || session.id}`} />
                    <FileText size={15} aria-hidden="true" /><span className="option-text"><strong title={session.title || session.id}>{session.title || session.id}</strong>
                      <span className="muted">{formatTime(session.modifiedAt, true)} · {formatBytes(session.bytes)}{session.writerVersion ? ` · ${session.writerVersion}` : ''}</span>
                      {session.cwd && <span className="muted mono truncate" title={session.cwd}>{session.cwd}</span>}
                    </span></label></li>)}</ul>
                </details>;
              })}</div>}
      </div>
      <footer className="dialog-footer import-footer">
        {!result && <span className="selection-summary muted">已选 {selected.size} 个 · {formatBytes(selectedBytes)}</span>}
        <button type="button" className="button" onClick={onClose}>{result ? '完成' : busy ? '关闭' : '取消'}</button>
        {!result && <SubmitButton busy={busy} disabled={loading || Boolean(loadError) || selected.size === 0}><Upload size={15} aria-hidden="true" />{busy ? '导入中…' : '导入会话'}</SubmitButton>}
      </footer>
    </form>
  </Modal>;
}
