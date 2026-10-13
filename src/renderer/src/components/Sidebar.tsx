import { useRef, useState, type CSSProperties } from 'react';
import {
  Activity, AlertTriangle, Clock3, Cpu, ExternalLink, FolderOpen, GitCompare, HardDrive,
  LogIn, MemoryStick, Pause, Play, RotateCw, Terminal, Trash2, Wrench, X, BookOpen,
} from 'lucide-react';
import type { ActivityEvent, AppState, ServiceNode, SessionInfo, SshAlias, SyncConflict } from '../../../shared/types';
import { connectionLabels, connectionTone, fileName, formatBytes, formatTime, formatUptime, nodeAddress, workspaceSyncLabel, workspaceSyncTone } from '../format';
import type { RunAction } from '../useAppState';
import { IconButton, Status, useFocusScope } from './ui';
import { ProviderPanel } from './ProviderDialogs';

interface SidebarProps {
  state: AppState;
  node: ServiceNode;
  aliases: SshAlias[];
  pending: Set<string>;
  run: RunAction;
  narrow: boolean;
  modalOpen: boolean;
  width: number;
  onWidth: (width: number) => void;
  onClose: () => void;
  onWorkspace: () => void;
  onLogin: () => void;
  onProviders: () => void;
  onResume: (session: SessionInfo) => void;
  onConflict: (conflict: SyncConflict) => void;
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  const Icon = event.kind === 'error' ? AlertTriangle : event.kind === 'tool' ? Wrench : event.kind === 'command' ? Terminal : Activity;
  const content = <><Icon size={14} className={event.kind === 'error' ? 'danger-text' : 'muted'} aria-hidden="true" />
    <span className="activity-title">{event.title}</span><time dateTime={event.time} title={event.time}>{formatTime(event.time)}</time></>;
  return <li className="activity-row">{event.detail || event.location ? <details><summary>{content}</summary>
    <div className="activity-detail">{event.location && <span className="activity-location">{event.location === 'local' ? '本机' : '服务器'}</span>}
      {event.detail && <p>{event.detail}</p>}</div></details> : <div className="activity-summary">{content}</div>}</li>;
}

export function Sidebar({ state, node, aliases, pending, run, narrow, modalOpen, width, onWidth, onClose, onWorkspace, onLogin, onProviders, onResume, onConflict }: SidebarProps) {
  const panelRef = useRef<HTMLElement>(null);
  const [memoryResult,setMemoryResult]=useState<{workspaceId:string;message:string;conflicts:string[]}|null>(null);
  const dragRef = useRef<{ x: number; width: number } | null>(null);
  useFocusScope(panelRef, narrow && !modalOpen, onClose);
  const isActive = state.connection.activeNodeId === node.id;
  const phase = isActive ? state.connection.phase : 'disconnected';
  const connected = phase === 'connected';
  const metrics = isActive ? state.metrics : null;
  const browserLogin = state.browserLogin?.nodeId === node.id ? state.browserLogin : undefined;
  const loginBusy = pending.has('new-session') || pending.has('select-provider');
  const workspace = state.workspaces.find((item) => item.id === state.connection.activeWorkspaceId && item.nodeId === node.id);
  const sync = isActive ? state.sync : null;
  const memoryUsed = metrics ? Math.max(0, metrics.memoryTotal - metrics.memoryAvailable) : 0;
  const memoryPercent = metrics && metrics.memoryTotal > 0 ? Math.min(100, Math.round(memoryUsed / metrics.memoryTotal * 100)) : null;
  const sessions = state.sessions.filter((session) => session.nodeId === node.id).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)).slice(0, 12);
  const activities = state.activities.filter((event) => !event.workspaceId || !workspace || event.workspaceId === workspace.id)
    .sort((a, b) => b.time.localeCompare(a.time)).slice(0, 30);
  const clampWidth = (value: number) => Math.max(232, Math.min(420, window.innerWidth - 360, value));

  return <>
    {narrow && <button className="sidebar-scrim" aria-label="关闭侧栏" onClick={onClose} tabIndex={-1} />}
    <aside ref={panelRef} className={`sidebar ${narrow ? 'sidebar-drawer' : ''}`} style={{ '--sidebar-width': `${width}px` } as CSSProperties}
      role={narrow ? 'dialog' : 'complementary'} aria-modal={narrow ? true : undefined} aria-label="服务器与工作区" tabIndex={-1} inert={modalOpen}>
      {!narrow && <div className="sidebar-resizer" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical"
        aria-valuemin={232} aria-valuemax={420} aria-valuenow={width} tabIndex={0}
        onPointerDown={(event) => { dragRef.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
        onPointerMove={(event) => { if (dragRef.current) onWidth(clampWidth(dragRef.current.width + dragRef.current.x - event.clientX)); }}
        onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}
        onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onWidth(clampWidth(width + (event.key === 'ArrowLeft' ? 16 : -16))); } }} />}
      {narrow && <div className="drawer-heading"><strong>工作区状态</strong><IconButton icon={X} label="关闭侧栏" onClick={onClose} /></div>}
      <div className="sidebar-scroll">
        <section className="sidebar-section server-section">
          <div className="section-heading"><h2>服务器</h2><Status tone={connectionTone(phase)}>{connectionLabels[phase]}</Status></div>
          <p className="server-name" title={metrics?.hostname || node.name}>{metrics?.hostname || node.name}</p>
          <p className="server-address mono" title={metrics?.address || nodeAddress(node, aliases)}>{metrics?.address || nodeAddress(node, aliases)}</p>
          {metrics ? <>
            <dl className="metric-list">
              <div><dt><Cpu size={13} aria-hidden="true" />系统负载</dt><dd>{Number.isFinite(metrics.load) ? metrics.load.toFixed(2) : '不可用'}<span className="muted"> / {metrics.cpuCount} 核</span></dd></div>
              <div><dt><MemoryStick size={13} aria-hidden="true" />内存使用</dt><dd>{formatBytes(memoryUsed)}<span className="muted"> / {formatBytes(metrics.memoryTotal)}</span></dd></div>
              {memoryPercent !== null && <div className="memory-meter-row"><progress max={100} value={memoryPercent} aria-label={`内存使用率 ${memoryPercent}%`} /><span className="muted">{memoryPercent}%</span></div>}
              <div><dt><HardDrive size={13} aria-hidden="true" />磁盘可用</dt><dd>{formatBytes(metrics.diskAvailable)}</dd></div>
              <div><dt><Clock3 size={13} aria-hidden="true" />运行时间</dt><dd>{formatUptime(metrics.uptime)}</dd></div>
            </dl>
            <p className="server-system" title={metrics.os}>{metrics.os}</p>
            <div className="claude-status"><Status tone={node.providerId ? 'neutral' : metrics.authenticated ? 'success' : 'warning'}>{node.providerId ? 'Claude · 第三方 API' : metrics.authenticated ? 'Claude 已登录' : 'Claude 未登录'}</Status>
            </div>
            {metrics.claudeVersion && <p className="sample-time muted">Claude {metrics.claudeVersion}</p>}
            <p className="sample-time muted" title={metrics.sampledAt}>采样于 {formatTime(metrics.sampledAt)}</p>
          </> : <p className="empty-inline">尚未收到服务器指标</p>}
          {!node.providerId && <div className="browser-login-panel">
            <button className="button browser-login-button" disabled={!connected || loginBusy} aria-busy={loginBusy} onClick={onLogin}>
              <LogIn size={14} aria-hidden="true" />{loginBusy ? '正在准备登录…' : browserLogin && ['ready','failed','blocked'].includes(browserLogin.phase) ? '重新登录' : '通过当前服务器登录'}</button>
            {browserLogin && <div className="browser-login-state" role="status"><Status
              tone={browserLogin.network?.phase==='failed'||['blocked', 'failed'].includes(browserLogin.phase) ? 'warning' : browserLogin.phase==='authenticated' ? 'success' : 'neutral'}
              busy={['preparing', 'opening'].includes(browserLogin.phase)}>
              {browserLogin.network?.phase==='failed' ? '网页连接检查未通过' : browserLogin.phase==='authenticated' ? '官方账号已登录' : browserLogin.routeVerified ? '通道已连通，等待授权' : browserLogin.phase === 'blocked' ? '登录连接已阻断' : browserLogin.phase === 'failed' ? '登录连接失败' : '正在准备登录环境'}
            </Status><p className="muted">{browserLogin.message}</p>{browserLogin.network&&<p className={browserLogin.network.phase==='failed'?'warning-text':'muted'}>{browserLogin.network.message}</p>}</div>}
            <p className="browser-login-hint muted">独立浏览器使用当前服务器网络。登录完成后自动重载并返回 Claude。</p>
          </div>}
        </section>
        <ProviderPanel state={state} node={node} pending={pending} run={run} onManage={onProviders} />
        <section className="sidebar-section workspace-section">
          <div className="section-heading"><h2>工作区</h2><div className="section-tools">
            <IconButton icon={FolderOpen} label="选择工作区" onClick={onWorkspace} disabled={pending.has('connect')} />
            <IconButton icon={ExternalLink} label="打开本地目录" disabled={!workspace} busy={pending.has('open-local-path')}
              onClick={() => { if (workspace) void run('open-local-path', '打开本地目录', (api) => api.openLocalPath(workspace.id), { refresh: false }); }} /></div></div>
          {workspace ? <>
            <p className="workspace-name">{workspace.name}</p>
            <p className="workspace-path mono" title={workspace.localPath}>{workspace.localPath}</p>
            <p className="remote-path muted mono" title={workspace.remotePath}>{workspace.remotePath}</p>
            {state.workspacePreparation?.workspaceId===workspace.id&&state.workspacePreparation.phase!=='ready'&&<p className={`sync-message ${state.workspacePreparation.phase==='error'?'danger-text':'muted'}`} role="status">{state.workspacePreparation.message}</p>}
            <button className="button memory-import-button" disabled={!connected||pending.has('import-memory')} aria-busy={pending.has('import-memory')} onClick={()=>{
              void run('import-memory','导入项目记忆',api=>api.importProjectMemory(workspace.id)).then(result=>{
                if(result.ok)setMemoryResult({workspaceId:workspace.id,message:`已导入 ${result.value.imported} 份记忆，${result.value.unchanged} 份内容相同。新会话会自动读取，当前会话可重新读取 MEMORY.md。`,conflicts:result.value.conflicts});
              });
            }}><BookOpen size={14} aria-hidden="true" />{pending.has('import-memory')?'正在导入记忆…':'导入本机项目记忆'}</button>
            {memoryResult?.workspaceId===workspace.id&&<div className="memory-import-result" role="status"><p>{memoryResult.message}</p>{Boolean(memoryResult.conflicts.length)&&<p className="warning-text">以下文件与远端不同，已保留远端版本：{memoryResult.conflicts.join('、')}</p>}</div>}
            <div className="local-access-row"><span>本机 MCP</span><button type="button" className="switch" role="switch" aria-label="本机 MCP" aria-checked={workspace.localAccess}
              title={workspace.localAccess ? '关闭本机 MCP' : '启用本机 MCP'} disabled={!connected || pending.has('local-access')}
              onClick={() => { void run('local-access', '设置本机 MCP', (api) => api.setLocalAccess(workspace.id, !workspace.localAccess)); }}><span /></button></div>
            <div className="sync-heading"><Status tone={workspaceSyncTone(sync)} busy={['preparing', 'scanning', 'syncing'].includes(sync?.phase || '')||sync?.git?.phase==='syncing'}>{workspaceSyncLabel(sync)}</Status>
              <div className="section-tools"><IconButton icon={RotateCw} label="立即同步" disabled={!connected} busy={pending.has('sync-now')}
                onClick={() => { void run('sync-now', '同步工作区', (api) => api.syncNow()); }} />
                <IconButton icon={sync?.phase === 'paused' ? Play : Pause} label={sync?.phase === 'paused' ? '恢复同步' : '暂停同步'} disabled={!connected || !sync || sync.phase === 'none'} busy={pending.has('pause-sync')}
                  onClick={() => { if (sync?.phase === 'paused') void run('sync-now', '恢复同步', (api) => api.syncNow()); else void run('pause-sync', '暂停同步', (api) => api.pauseSync()); }} /></div></div>
            {sync?.message && <p className={`sync-message ${sync.phase === 'error' ? 'danger-text' : ''}`}>{sync.message}</p>}
            {sync?.git && <p className={`sync-message ${sync.git.phase==='error'?'danger-text':sync.git.phase==='blocked'?'warning-text':''}`}>{sync.git.message}</p>}
            {sync?.bytesTransferred !== undefined && <p className="sample-time muted">已传输 {formatBytes(sync.bytesTransferred)}</p>}
            {sync?.updatedAt && <p className="sample-time muted" title={sync.updatedAt}>更新于 {formatTime(sync.updatedAt)}</p>}
            {Boolean(sync?.conflicts.length) && <ul className="conflict-list">{sync?.conflicts.map((conflict) => <li key={conflict.path}>
              <AlertTriangle size={14} className="warning-text" aria-hidden="true" /><span title={conflict.path}>{fileName(conflict.path)}</span>
              <IconButton icon={GitCompare} label={`处理 ${conflict.path} 的冲突`} onClick={() => onConflict(conflict)} disabled={!connected} /></li>)}</ul>}
          </> : <p className="empty-inline">尚未选择工作区</p>}
        </section>
        <section className="sidebar-section sessions-section"><div className="section-heading"><h2>最近会话</h2><span className="muted">{sessions.length}</span></div>
          {sessions.length ? <ul className="session-list">{sessions.map((session) => <li key={session.id} className="session-item">
            <button className={`session-option ${session.id === state.connection.activeSessionId ? 'is-current' : ''}`} onClick={() => onResume(session)} disabled={pending.has('connect') || pending.has('new-session') || pending.has('select-provider')}
              aria-current={session.id === state.connection.activeSessionId ? 'true' : undefined} title={`续接 ${session.title || session.id}`}>
              {session.kind === 'login' ? <LogIn size={14} aria-hidden="true" /> : <Terminal size={14} aria-hidden="true" />}
              <span className="option-text"><strong>{session.title || '未命名会话'}</strong><span className="muted">{formatTime(session.lastActiveAt, true)}{session.kind === 'login' ? ' · 登录' : session.kind === 'shell' ? ' · Shell' : ''}</span></span>
              {session.id === state.connection.activeSessionId && <span className="current-session-dot" aria-label="当前会话" />}
            </button>
            {session.id !== state.connection.activeSessionId && <IconButton icon={Trash2} label="删除会话" tooltip="删除会话并结束服务器上的 tmux 会话" className="session-remove"
              busy={pending.has('remove-session-' + session.id)}
              onClick={() => { void run('remove-session-' + session.id, '删除会话', (api) => api.removeSession(session.id)); }} />}
          </li>)}</ul> : <p className="empty-inline">暂无会话</p>}
        </section>
        <section className="sidebar-section activity-section"><div className="section-heading"><h2>活动</h2></div>
          {activities.length ? <ul className="activity-list">{activities.map((event) => <ActivityRow event={event} key={event.id} />)}</ul> : <p className="empty-inline">暂无活动记录</p>}
        </section>
      </div>
    </aside>
  </>;
}
