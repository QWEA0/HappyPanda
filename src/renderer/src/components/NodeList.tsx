import { FolderOpen, Pencil, Plus, Server, Trash2, ChevronRight, LoaderCircle } from 'lucide-react';
import type { AppState, ServiceNode, SshAlias } from '../../../shared/types';
import { connectionLabels, connectionTone, formatTime, nodeAddress } from '../format';
import { IconButton, Status } from './ui';

interface NodeListProps {
  state: AppState;
  aliases: SshAlias[];
  loading: boolean;
  connecting: boolean;
  onConnect: (node: ServiceNode) => void;
  onAdd: () => void;
  onEdit: (node: ServiceNode) => void;
  onDelete: (node: ServiceNode) => void;
  onWorkspace: (node: ServiceNode) => void;
}

export function NodeList({ state, aliases, loading, connecting, onConnect, onAdd, onEdit, onDelete, onWorkspace }: NodeListProps) {
  return <main className="home-main">
    <div className="node-list-heading"><h1>SSH 节点</h1><span className="muted">{loading ? '正在读取…' : `${state.nodes.length} 个节点`}</span></div>
    {loading ? <div className="empty-list" role="status"><LoaderCircle size={22} className="spin" aria-hidden="true" /><p>正在读取保存的节点</p></div>
      : state.nodes.length === 0 ? <div className="empty-list"><Server size={25} aria-hidden="true" /><p>尚未保存 SSH 节点</p>
        <button className="button" onClick={onAdd}><Plus size={15} aria-hidden="true" />新增节点</button></div>
        : <div className="node-list">
          <div className="node-table-heading" aria-hidden="true"><span>节点 / SSH 目标</span><span>工作区</span><span>最近会话</span><span /></div>
          <ul>
            {state.nodes.map((node) => {
              const workspace = state.workspaces.find((item) => item.id === node.lastWorkspaceId);
              const session = state.sessions.find((item) => item.id === node.lastSessionId)
                || state.sessions.filter((item) => item.nodeId === node.id).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0];
              const phase = state.connection.activeNodeId === node.id ? state.connection.phase : 'disconnected';
              return <li className="node-row" key={node.id}>
                <button className="node-open" onClick={() => onConnect(node)} disabled={connecting}
                  aria-label={`连接 ${node.name}`} title={`连接 ${nodeAddress(node, aliases)}`}>
                  <span className="node-identity">
                    <span className="node-icon"><Server size={19} aria-hidden="true" /></span>
                    <span className="node-text"><span className="node-name">{node.name}</span>
                      <span className="node-address mono" title={nodeAddress(node, aliases)}>{nodeAddress(node, aliases)}</span>
                      <span className="node-alias muted">{node.sshTarget}</span>
                    </span>
                  </span>
                  <span className="node-workspace"><span className="mobile-field-label">工作区</span>
                    <span className="truncate" title={workspace?.localPath}>{workspace?.name || (node.lastWorkspaceId ? '工作区信息不可用' : '未选择工作区')}</span>
                    {workspace && <span className="muted truncate" title={workspace.localPath}>{workspace.localPath}</span>}
                  </span>
                  <span className="node-session"><span className="mobile-field-label">最近会话</span>
                    <span className="truncate" title={session?.title}>{session?.title || '尚无会话'}</span>
                    {session && <span className="muted">{formatTime(session.lastActiveAt, true)}</span>}
                  </span>
                  <span className="node-connection"><Status tone={connectionTone(phase)} busy={['preparing', 'connecting', 'retrying'].includes(phase)}>{connectionLabels[phase]}</Status>
                    <ChevronRight size={15} aria-hidden="true" /></span>
                </button>
                <div className="node-actions">
                  <IconButton icon={FolderOpen} label={`选择 ${node.name} 的工作区`} onClick={() => onWorkspace(node)} disabled={connecting} />
                  <IconButton icon={Pencil} label={`编辑 ${node.name}`} onClick={() => onEdit(node)} />
                  <IconButton icon={Trash2} label={`删除 ${node.name}`} className="danger-hover" onClick={() => onDelete(node)} />
                </div>
              </li>;
            })}
          </ul>
        </div>}
  </main>;
}
