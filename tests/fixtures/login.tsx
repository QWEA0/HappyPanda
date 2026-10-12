import '@vitejs/plugin-react/preamble';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/styles.css';
import { Sidebar } from '../../src/renderer/src/components/Sidebar';
import { emptySync, type AppState, type BrowserLoginState } from '../../src/shared/types';
import { TEST_NODE } from './node';

function Fixture() {
  const [phase, setPhase] = useState<BrowserLoginState['phase']>('idle');
  const [failed,setFailed]=useState(false);
  const [width, setWidth] = useState(272);
  const state: AppState = { providers: [], nodes: [{...TEST_NODE}], workspaces: [], sessions: [],
    connection: { phase: 'connected', activeNodeId: TEST_NODE.id, message: '', retryAttempt: 0 },
    metrics: null, sync: emptySync(), activities: [], terminalBuffer: '', version: 'test',
    browserLogin: { phase, nodeId: TEST_NODE.id, routeVerified: phase === 'ready', message: phase === 'ready' ? '节点通道已连通，正在等待浏览器完成授权。' : phase === 'blocked' ? 'SSH 登录通道已断开，浏览器连接已阻断。' : '正在建立节点登录通道…',network:failed?{phase:'failed',message:'claude.com 对连接检查返回 HTTP 403。请查看浏览器中的验证或错误提示。'}:undefined } };
  return <div className="app-shell"><header className="toolbar"><strong>节点登录验证 · 合成状态</strong>
    <button className="button" onClick={()=>{setPhase('ready');setFailed(false);}}>模拟路由验证通过</button><button className="button" onClick={()=>{setPhase('blocked');setFailed(false);}}>模拟隧道断开</button><button className="button" onClick={()=>{setPhase('ready');setFailed(true);}}>模拟网站拒绝检查</button></header>
    <div className="workspace-surface"><main className="terminal-column" style={{background:'#191b1e'}} />
      <Sidebar state={state} node={state.nodes[0]} aliases={[]} pending={new Set()} run={async()=>({ok:false})} narrow={false} modalOpen={false}
        width={width} onWidth={setWidth} onClose={()=>{}} onWorkspace={()=>{}} onLogin={()=>setPhase('preparing')} onProviders={()=>{}} onResume={()=>{}} onConflict={()=>{}} /></div></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
