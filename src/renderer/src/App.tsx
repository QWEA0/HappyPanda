import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowLeft, ArrowLeftRight, ClipboardPaste, Copy, FolderOpen, History, LogIn, MoreHorizontal,
  PanelRightClose, PanelRightOpen, Plus, RotateCw, Terminal, Unplug, KeyRound, Smartphone, Monitor, X,
} from 'lucide-react';
import type { PortForward, ServiceNode, SessionInfo, SyncConflict, Workspace } from '../../shared/types';
import type { RemoteControlState } from '../../shared/remote';
import { connectionLabels, connectionTone, workspaceSyncLabel, workspaceSyncTone } from './format';
import { useAppState } from './useAppState';
import { NodeList } from './components/NodeList';
import { TerminalView, type TerminalHandle } from './components/TerminalView';
import { SessionTabs } from './components/SessionTabs';
import { Sidebar } from './components/Sidebar';
import { NodeDialog, DeleteNodeDialog } from './components/NodeDialogs';
import { WorkspaceDialog, ConflictDialog } from './components/WorkspaceDialogs';
import { PortDialog } from './components/PortDialog';
import { ImportDialog } from './components/ImportDialog';
import { ProvidersDialog } from './components/ProviderDialogs';
import { RemoteDialog } from './components/RemoteDialog';
import { MobileTerminalControls } from './components/MobileTerminalControls';
import { isRemotePage, remoteClient } from './remote-client';
import { IconButton, NoticeBanner, Status } from './components/ui';

type ModalContent =
  | { kind: 'node'; node?: ServiceNode }
  | { kind: 'delete'; node: ServiceNode }
  | { kind: 'workspace'; node: ServiceNode }
  | { kind: 'conflict'; conflict: SyncConflict }
  | { kind: 'ports'; nodeId: string }
  | { kind: 'providers' }
  | { kind: 'remote' }
  | { kind: 'import'; workspace: Workspace };
type ModalState = ModalContent & { key: number };

function useNarrowLayout(forceNarrow = false) {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 880px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 880px)');
    const update = () => setNarrow(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return forceNarrow || narrow;
}

export default function App() {
  const remoteMode = isRemotePage();
  const { state, loading, aliases, notice, pending, run, notify, loadAliases, reloadState, dismissNotice, hasDesktop } = useAppState();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // The node list can be shown while sessions keep running in the background.
  const [showHome, setShowHome] = useState(false);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => !remoteMode && !window.matchMedia('(max-width: 880px)').matches);
  const [sidebarWidth, setSidebarWidth] = useState(272);
  const [remoteNavigationOpen, setRemoteNavigationOpen] = useState(false);
  const [remoteFontSize, setRemoteFontSize] = useState(12);
  const [remoteFitToViewport, setRemoteFitToViewport] = useState(true);
  const forwards = state.portForwards ?? [];
  const openSessions = state.openSessions ?? [];
  const activeSessionId = state.connection.activeSessionId;
  const modalKey = useRef(0);
  const terminalRef = useRef<TerminalHandle>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const narrow = useNarrowLayout(remoteMode);
  const remoteAPI = window.happyPanda?.remoteControl;
  const [remoteState, setRemoteState] = useState<RemoteControlState | null>(null);
  const remoteStatus = useSyncExternalStore(remoteClient.subscribe, remoteClient.getStatus);
  const inputEnabled = remoteMode
    ? remoteStatus.phase === 'connected' && remoteStatus.owner.id === remoteStatus.deviceId
    : !remoteState || remoteState.owner.id === 'desktop';
  const node = showHome ? undefined : state.nodes.find((item) => item.id === selectedNodeId);
  const workspace = state.workspaces.find((item) => item.id === state.connection.activeWorkspaceId && item.nodeId === node?.id);
  const connected = Boolean(node && state.connection.activeNodeId === node.id && state.connection.phase === 'connected');
  const viewingRemoteTerminal = remoteMode && Boolean(node);
  const connectionBusy = pending.has('connect') || pending.has('select-provider') || pending.has('workspace-mode') || ['preparing', 'connecting', 'retrying'].includes(state.connection.phase);

  useEffect(() => {
    if (remoteMode && !viewingRemoteTerminal && document.fullscreenElement) {
      void document.exitFullscreen().catch(error => notify('error', '退出全屏失败', String(error)));
    }
  }, [remoteMode, viewingRemoteTerminal, notify]);

  useEffect(() => {
    if (!remoteAPI) return;
    let active = true;
    let receivedState = false;
    const unsubscribe = remoteAPI.onState(next => { if (active) { receivedState = true; setRemoteState(next); } });
    void remoteAPI.getState().then(next => { if (active && !receivedState) setRemoteState(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [remoteAPI]);

  useEffect(() => {
    const activeId = state.connection.activeNodeId;
    if (activeId && state.connection.phase !== 'disconnected') setSelectedNodeId(activeId);
    if (selectedNodeId && !loading && !state.nodes.some((item) => item.id === selectedNodeId)) setSelectedNodeId(null);
  }, [state.connection.activeNodeId, state.connection.phase, state.nodes, selectedNodeId, loading]);

  useEffect(() => { if (!openSessions.length) setShowHome(false); }, [openSessions.length]);

  useEffect(() => { setSidebarOpen(!narrow); }, [narrow]);

  useEffect(() => {
    const closeMenu = (event: PointerEvent) => {
      if (menuRef.current?.open && !menuRef.current.contains(event.target as Node)) menuRef.current.open = false;
    };
    const escapeMenu = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menuRef.current?.open) {
        menuRef.current.open = false;
        menuRef.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', closeMenu);
    document.addEventListener('keydown', escapeMenu);
    return () => { document.removeEventListener('pointerdown', closeMenu); document.removeEventListener('keydown', escapeMenu); };
  }, []);

  const openModal = (content: ModalContent) => {
    dismissNotice();
    if (menuRef.current) menuRef.current.open = false;
    setModal({ ...content, key: ++modalKey.current });
  };
  const closeModal = () => setModal((current) => current === modal ? null : current);
  const feedback = { feedback: notice, dismissFeedback: dismissNotice };

  const connectNode = useCallback(async (target: ServiceNode, workspaceId?: string, sessionId?: string) => {
    const result = await run('connect', '连接节点', (api) => api.connect(target.id, workspaceId, sessionId));
    if (result.ok) { setSelectedNodeId(target.id); setShowHome(false); terminalRef.current?.focus(); }
  }, [run]);

  // Focus events carry the new session's state; skip the full refresh (it includes up to 512 KB of scrollback).
  const focusSession = useCallback((sessionId: string) => {
    if (sessionId === activeSessionId) return;
    void run('focus-session', '切换会话', (api) => api.focusSession(sessionId), { refresh: false });
  }, [run, activeSessionId]);
  const closeSession = useCallback((sessionId: string) => {
    void run('close-session-' + sessionId, '关闭会话', (api) => api.closeSession(sessionId), { refresh: false });
  }, [run]);

  const tabCycle = useRef<(step: number) => void>(() => {});
  tabCycle.current = (step) => {
    if (openSessions.length < 2) return;
    const index = openSessions.findIndex(session => session.sessionId === activeSessionId);
    focusSession(openSessions[(index + step + openSessions.length) % openSessions.length].sessionId);
  };
  useEffect(() => {
    if (remoteMode) return;
    // Capture phase: runs before xterm sees the key.
    const cycle = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.key !== 'Tab' || modal) return;
      event.preventDefault(); event.stopPropagation();
      tabCycle.current(event.shiftKey ? -1 : 1);
    };
    window.addEventListener('keydown', cycle, true);
    return () => window.removeEventListener('keydown', cycle, true);
  }, [remoteMode, modal]);

  const newSession = async (kind: 'claude' | 'login' | 'shell' = 'claude') => {
    const result = await run('new-session', kind === 'login' ? '通过当前服务器登录' : '新建会话', (api) => api.newSession(kind));
    if (result.ok) terminalRef.current?.focus();
  };

  const backToNodes = async () => {
    if (state.connection.phase === 'disconnected' && !openSessions.length) { setSelectedNodeId(null); return; }
    const result = await run('disconnect', '断开全部会话', (api) => api.disconnect());
    if (result.ok) setSelectedNodeId(null);
  };
  const goHome = () => { if (openSessions.length) setShowHome(true); else void backToNodes(); };

  const resumeSession = (session: SessionInfo) => {
    const target = state.nodes.find((item) => item.id === session.nodeId);
    if (target) { if (narrow) setSidebarOpen(false); void connectNode(target, session.workspaceId, session.id); }
  };
  const resumeImported = (workspaceId: string, path: string) => {
    void run('resume-imported', '续接导入会话', (api) => api.resumeImported(workspaceId, path)).then((result) => {
      if (result.ok) terminalRef.current?.focus();
    });
  };
  const menuAction = (action: () => void) => {
    if (menuRef.current) menuRef.current.open = false;
    action();
  };
  const showWorkspace = () => { if (node) openModal({ kind: 'workspace', node }); };
  const showImport = () => { if (workspace) openModal({ kind: 'import', workspace }); };
  const showPorts = () => { if (node) openModal({ kind: 'ports', nodeId: node.id }); };
  const reconnect = () => {
    if (!node) return;
    if (openSessions.some(session => session.sessionId === activeSessionId)) void run('connect', '重新连接', (api) => api.reconnect());
    else void connectNode(node, workspace?.id || node.lastWorkspaceId, node.lastSessionId);
  };
  const busySession = pending.has('new-session') || pending.has('resume-imported') || pending.has('select-provider') || pending.has('workspace-mode');
  const terminalProps = { state, inputEnabled, mobile: remoteMode, fontSize: remoteMode ? remoteFontSize : undefined, fitToViewport: remoteMode && remoteFitToViewport,
    onImage: (file: File) => remoteClient.uploadImage(file, terminalRef.current?.bracketedPaste()),
    onError: (title: string, detail: string) => notify('error', title, detail), onInfo: (title: string) => notify('info', title) };

  return <div className={`app-shell${remoteMode && node ? ' remote-terminal' : ''}${remoteNavigationOpen ? ' remote-navigation-open' : ''}`}>
    <div className="app-body" inert={Boolean(modal)}>
      <header className={`toolbar ${node ? 'connected-toolbar' : ''}`} inert={narrow && sidebarOpen && Boolean(node)}>
        {node ? <>
          <IconButton icon={ArrowLeft} label={openSessions.length ? '返回节点列表（会话在后台继续运行）' : '返回节点列表'} busy={pending.has('disconnect')} onClick={goHome} />
          <div className="toolbar-title"><strong className="truncate" title={node.name}>{node.name}</strong>
            <span className="toolbar-workspace truncate" title={workspace?.localPath}>{workspace?.name || node.sshTarget}</span></div>
          <div className="toolbar-connection"><Status tone={connectionTone(state.connection.phase)} busy={connectionBusy}>{connectionLabels[state.connection.phase]}</Status></div>
          <nav className="toolbar-actions" aria-label="会话操作">
            {remoteAPI && <IconButton icon={Smartphone} label="手机远控" onClick={() => openModal({ kind: 'remote' })} />}
            <IconButton icon={Plus} label="新建 Claude 会话" busy={busySession} disabled={!connected} onClick={() => { void newSession(); }} />
            <IconButton icon={FolderOpen} label="选择工作区" className="toolbar-secondary" disabled={connectionBusy} onClick={showWorkspace} />
            <IconButton icon={History} label="导入本机会话" className="toolbar-secondary" disabled={!connected || !workspace} onClick={showImport} />
            <IconButton icon={ArrowLeftRight} label="端口转发" className="toolbar-secondary" disabled={!connected} onClick={showPorts} />
            <IconButton icon={LogIn} label="通过当前服务器登录" tooltip={node.providerId ? '切换到官方账号后可登录' : '通过当前服务器登录'} className="toolbar-secondary" disabled={!connected || busySession || Boolean(node.providerId)} onClick={() => { void newSession('login'); }} />
            <span className="toolbar-divider" aria-hidden="true" />
            <IconButton icon={RotateCw} label="重新连接" busy={connectionBusy} disabled={pending.has('disconnect')} onClick={reconnect} />
            <details ref={menuRef} className="toolbar-menu"><summary className="icon-button" aria-label="更多操作" title="更多操作"><MoreHorizontal size={17} aria-hidden="true" /></summary>
              <div className="toolbar-menu-panel" role="group" aria-label="更多会话操作">
                <button disabled={pending.has('select-provider')} onClick={() => menuAction(() => openModal({ kind: 'providers' }))}><KeyRound size={15} aria-hidden="true" />API 提供商</button>
                <button disabled={!connected || busySession || Boolean(node.providerId)} onClick={() => menuAction(() => { void newSession('login'); })}><LogIn size={15} aria-hidden="true" />通过当前服务器登录</button>
                <button disabled={!connected || busySession} onClick={() => menuAction(() => { void newSession('shell'); })}><Terminal size={15} aria-hidden="true" />新建 Shell 会话</button>
                <button disabled={connectionBusy} onClick={() => menuAction(showWorkspace)}><FolderOpen size={15} aria-hidden="true" />选择工作区</button>
                <button disabled={!workspace} onClick={() => menuAction(() => { if (workspace) void run('open-local-path', '打开本地目录', (api) => api.openLocalPath(workspace.id), { refresh: false }); })}><FolderOpen size={15} aria-hidden="true" />打开本地目录</button>
                <button disabled={!connected || !workspace} onClick={() => menuAction(showImport)}><History size={15} aria-hidden="true" />导入本机会话</button>
                <button disabled={!connected} onClick={() => menuAction(showPorts)}><ArrowLeftRight size={15} aria-hidden="true" />端口转发</button>
                <hr />
                <button onClick={() => menuAction(() => { void terminalRef.current?.copy(); })}><Copy size={15} aria-hidden="true" />复制终端选区</button>
                <button disabled={!connected} onClick={() => menuAction(() => { void terminalRef.current?.paste(); })}><ClipboardPaste size={15} aria-hidden="true" />粘贴到终端</button>
                <hr />
                <button disabled={!activeSessionId || !openSessions.length} onClick={() => menuAction(() => { if (activeSessionId) closeSession(activeSessionId); })}><X size={15} aria-hidden="true" />关闭当前会话标签</button>
                <button disabled={pending.has('disconnect')} onClick={() => menuAction(() => { void backToNodes(); })}><Unplug size={15} aria-hidden="true" />断开全部会话</button>
              </div>
            </details>
            <IconButton icon={sidebarOpen ? PanelRightClose : PanelRightOpen} label={sidebarOpen ? '收起侧栏' : '展开侧栏'} aria-expanded={sidebarOpen} onClick={() => setSidebarOpen((open) => !open)} />
          </nav>
        </> : <>
          <div className="app-brand"><Terminal size={19} aria-hidden="true" /><strong>HappyPanda</strong></div>
          <div className="toolbar-spacer" />
          {openSessions.length > 0
            ? <button className="button compact home-session-return" onClick={() => setShowHome(false)}><Terminal size={14} aria-hidden="true" /><span className="truncate">返回会话 · {openSessions.length}</span></button>
            : <span className="desktop-state"><Status>{hasDesktop ? '未连接' : '桌面 IPC 未连接'}</Status></span>}
          {remoteAPI && <IconButton icon={Smartphone} label="手机远控" onClick={() => openModal({ kind: 'remote' })} />}
          <IconButton icon={KeyRound} label="管理 API 提供商" onClick={() => openModal({ kind: 'providers' })} disabled={loading} />
          <IconButton icon={RotateCw} label="刷新节点列表" busy={pending.has('refresh-state') || loading}
            onClick={() => { void reloadState(); }} />
          <IconButton icon={Plus} label="新增 SSH 节点" onClick={() => openModal({ kind: 'node' })} disabled={loading} />
        </>}
      </header>
      {notice && !modal && <NoticeBanner notice={notice} onDismiss={dismissNotice} />}
      {remoteAPI && remoteState && remoteState.owner.id !== 'desktop' && <div className="desktop-remote-owner" role="status">
        <Smartphone size={15} aria-hidden="true" /><span className="truncate">{remoteState.owner.name} 正在控制</span>
        <button className="button compact" onClick={() => { void remoteAPI.takeControl().catch(error => notify('error', '收回控制权失败', String(error))); }}><Monitor size={14} aria-hidden="true" />收回控制权</button>
      </div>}
      {node ? <div className="workspace-surface">
        <main className="terminal-column" inert={narrow && sidebarOpen}>
          {openSessions.length > 0 && <SessionTabs sessions={openSessions} activeId={activeSessionId} nodes={state.nodes} workspaces={state.workspaces}
            newDisabled={!connected || busySession} onFocus={focusSession} onClose={closeSession} onNew={() => { void newSession(); }} />}
          {/* Desktop keeps one live terminal per tab, so switching is instant and lossless. The phone mirrors the focused session. */}
          {remoteMode || !openSessions.length
            ? <TerminalView ref={terminalRef} {...terminalProps} />
            : openSessions.map(session => <TerminalView key={session.sessionId} ref={session.sessionId === activeSessionId ? terminalRef : undefined}
              session={session} active={session.sessionId === activeSessionId} {...terminalProps} />)}
          <footer className="terminal-statusbar">
            <Status tone={connectionTone(state.connection.phase)} busy={connectionBusy}>{connectionLabels[state.connection.phase]}</Status>
            <span className="connection-message truncate" title={state.connection.message}>{state.connection.message}</span>
            {workspace && <span className="footer-sync" title={state.sync.git?.message || state.sync.message}><Status tone={workspace.mode==='mcp-only'?'neutral':workspaceSyncTone(state.sync)} busy={workspace.mode!=='mcp-only'&&state.sync.git?.phase==='syncing'}>{workspace.mode==='mcp-only'?'仅本机 MCP':workspaceSyncLabel(state.sync)}</Status></span>}
            <div className="footer-tools"><IconButton icon={Copy} label="复制终端选区" onClick={() => { void terminalRef.current?.copy(); }} />
              <IconButton icon={ClipboardPaste} label="粘贴到终端" disabled={!connected} onClick={() => { void terminalRef.current?.paste(); }} /></div>
          </footer>
        </main>
        {sidebarOpen && <Sidebar state={state} node={node} aliases={aliases} pending={pending} run={run} narrow={narrow} modalOpen={Boolean(modal)}
          width={sidebarWidth} onWidth={setSidebarWidth} onClose={() => setSidebarOpen(false)} onWorkspace={showWorkspace}
          onProviders={() => openModal({ kind: 'providers' })}
          onLogin={() => { void newSession('login'); }} onResume={resumeSession} onConflict={(conflict) => openModal({ kind: 'conflict', conflict })} />}
      </div> : <>
        <NodeList state={state} aliases={aliases} loading={loading} connecting={openSessions.length ? pending.has('connect') : connectionBusy} onConnect={(target) => { void connectNode(target); }}
          onAdd={() => openModal({ kind: 'node' })} onEdit={(target) => openModal({ kind: 'node', node: target })}
          onDelete={(target) => openModal({ kind: 'delete', node: target })} onWorkspace={(target) => openModal({ kind: 'workspace', node: target })} />
        <footer className="home-footer"><Status>{hasDesktop ? openSessions.length ? `${openSessions.length} 个会话在后台运行` : state.connection.message || '尚未连接' : '浏览器预览 · 桌面 IPC 未连接'}</Status>
          {state.version && <span className="muted">v{state.version}</span>}</footer>
      </>}
      {remoteMode && <div className="mobile-controls-host" hidden={!node} inert={narrow && sidebarOpen && Boolean(node)}>
        <MobileTerminalControls status={remoteStatus} connected={connected} onClaim={remoteClient.claim} onRelease={remoteClient.release}
          navigationOpen={remoteNavigationOpen} onToggleNavigation={() => { setRemoteNavigationOpen(value => !value); setSidebarOpen(false); }}
          fontSize={remoteFontSize} onFontSize={setRemoteFontSize} fitToViewport={remoteFitToViewport} onFitToViewport={setRemoteFitToViewport}
          onSend={async data => { await remoteClient.writeTerminal(data); }}
          onSendText={async text => { if (!terminalRef.current) throw new Error('终端尚未连接。'); await terminalRef.current.sendText(text); }}
          onImage={file => remoteClient.uploadImage(file, terminalRef.current?.bracketedPaste())} />
      </div>}
    </div>
    {modal?.kind === 'node' && <NodeDialog key={modal.key} node={modal.node} aliases={aliases} pending={pending} run={run} loadAliases={loadAliases} onClose={closeModal} {...feedback} />}
    {modal?.kind === 'delete' && <DeleteNodeDialog key={modal.key} node={modal.node} pending={pending} run={run} onClose={closeModal} {...feedback} />}
    {modal?.kind === 'workspace' && <WorkspaceDialog key={modal.key} node={modal.node} workspaces={state.workspaces} activeId={state.connection.activeWorkspaceId}
      pending={pending} run={run} onConnect={(target, id) => { void connectNode(target, id); }} onClose={closeModal} {...feedback} />}
    {modal?.kind === 'conflict' && <ConflictDialog key={modal.key} conflict={modal.conflict} pending={pending} run={run} onClose={closeModal} {...feedback} />}
    {modal?.kind === 'ports' && <PortDialog key={modal.key} nodeId={modal.nodeId} forwards={forwards} pending={pending} run={run}
      onAdded={() => {}} onRemoved={() => {}} onClose={closeModal} {...feedback} />}
    {modal?.kind === 'import' && <ImportDialog key={modal.key} workspace={modal.workspace} pending={pending} run={run} onResume={resumeImported} onClose={closeModal} {...feedback} />}
    {modal?.kind === 'providers' && <ProvidersDialog key={modal.key} providers={state.providers} nodes={state.nodes} pending={pending} run={run} onClose={closeModal} {...feedback} />}
    {modal?.kind === 'remote' && remoteAPI && <RemoteDialog key={modal.key} api={remoteAPI} onClose={closeModal} />}
  </div>;
}
