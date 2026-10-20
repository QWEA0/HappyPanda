import { LogIn, Plus, Terminal, X } from 'lucide-react';
import type { OpenSessionState, ServiceNode, Workspace } from '../../../shared/types';
import { connectionLabels, connectionTone } from '../format';

interface SessionTabsProps {
  sessions: OpenSessionState[];
  activeId?: string;
  nodes: ServiceNode[];
  workspaces: Workspace[];
  newDisabled: boolean;
  onFocus: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onNew: () => void;
}

/** Tabs for sessions whose terminals run concurrently. Labels repeat only when they would be ambiguous. */
export function SessionTabs({ sessions, activeId, nodes, workspaces, newDisabled, onFocus, onClose, onNew }: SessionTabsProps) {
  const multipleNodes = new Set(sessions.map(session => session.nodeId)).size > 1;
  const seen = new Map<string, number>();
  const tabs = sessions.map(session => {
    const node = nodes.find(item => item.id === session.nodeId);
    const workspace = workspaces.find(item => item.id === session.workspaceId);
    const base = (multipleNodes && node ? node.name + ' · ' : '') + (session.title || workspace?.name || 'Claude Code');
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { session, base, count, detail: [node?.name, workspace?.localPath, connectionLabels[session.phase]].filter(Boolean).join(' · ') };
  });
  const duplicated = new Set(tabs.filter(tab => tab.count > 1).map(tab => tab.base));
  const move = (from: number, step: number) => {
    const next = tabs[(from + step + tabs.length) % tabs.length];
    if (next) { onFocus(next.session.sessionId); document.getElementById('session-tab-' + next.session.sessionId)?.focus(); }
  };
  return <div className="session-tabs" role="tablist" aria-label="会话标签">
    {tabs.map(({ session, base, count, detail }, index) => {
      const active = session.sessionId === activeId;
      const label = duplicated.has(base) ? `${base} ${count}` : base;
      const Icon = session.kind === 'login' ? LogIn : Terminal;
      return <div key={session.sessionId} className={`session-tab${active ? ' is-active' : ''}`}
        onAuxClick={event => { if (event.button === 1) { event.preventDefault(); onClose(session.sessionId); } }}>
        <button id={'session-tab-' + session.sessionId} role="tab" className="session-tab-main" aria-selected={active}
          aria-controls={'terminal-' + session.sessionId} tabIndex={active ? 0 : -1} title={detail}
          onClick={() => onFocus(session.sessionId)}
          onKeyDown={event => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); move(index, event.key === 'ArrowRight' ? 1 : -1); }
            else if (event.key === 'Delete') { event.preventDefault(); onClose(session.sessionId); }
          }}>
          <span className={`session-tab-dot tone-${connectionTone(session.phase)}`} aria-hidden="true" />
          <Icon size={13} aria-hidden="true" />
          <span className="session-tab-label">{label}</span>
          {session.unread && !active && <span className="session-tab-unread" role="img" aria-label="有新输出" />}
        </button>
        <button className="session-tab-close" aria-label={`关闭 ${label}`} title="关闭标签（服务器上的会话继续运行）" tabIndex={-1}
          onClick={() => onClose(session.sessionId)}><X size={13} aria-hidden="true" /></button>
      </div>;
    })}
    <button className="session-tab-new" aria-label="新建 Claude 会话" title="新建 Claude 会话" disabled={newDisabled} onClick={onNew}><Plus size={15} aria-hidden="true" /></button>
  </div>;
}
