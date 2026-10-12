import '@vitejs/plugin-react/preamble';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/styles.css';
import { ProvidersDialog, ProviderPanel } from '../../src/renderer/src/components/ProviderDialogs';
import { emptySync, type AppState, type HappyPandaAPI } from '../../src/shared/types';
import { TEST_NODE } from './node';
import type { RunAction } from '../../src/renderer/src/useAppState';

function Fixture() {
  const [state, setState] = useState<AppState>({ nodes: [{ ...TEST_NODE }], providers: [], workspaces: [], sessions: [],
    connection: { phase: 'connected', activeNodeId: TEST_NODE.id, retryAttempt: 0, message: '' }, metrics: null, sync: emptySync(), activities: [], terminalBuffer: '', version: 'fixture' });
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(new Set<string>());
  const run: RunAction = async (key, _title, action) => {
    setPending(new Set([key]));
    try {
      const api = {
        saveProvider: async (input) => {
          const { token: _, ...value } = input;
          const provider = { ...value, id: input.id || crypto.randomUUID(), revision: 1 };
          setState(previous => ({ ...previous, providers: previous.providers.some(item => item.id === provider.id) ? previous.providers.map(item => item.id === provider.id ? provider : item) : [...previous.providers, provider] }));
          return provider;
        },
        removeProvider: async id => { setState(previous => ({ ...previous, providers: previous.providers.filter(item => item.id !== id) })); },
        selectProvider: async (_nodeId, id) => { setState(previous => ({ ...previous, nodes: [{ ...previous.nodes[0], providerId: id || undefined }] })); },
      } as Pick<HappyPandaAPI, 'saveProvider' | 'removeProvider' | 'selectProvider'>;
      return { ok: true, value: await action(api as HappyPandaAPI) };
    } finally { setPending(new Set()); }
  };
  return <div className="app-shell"><header className="toolbar"><strong>提供商交互验证 · 合成数据</strong></header>
    <div className="workspace-surface" inert={open}><main className="terminal-column" style={{ background: '#191b1e' }} />
      <aside className="sidebar"><ProviderPanel state={state} node={state.nodes[0]} pending={pending} run={run} onManage={() => setOpen(true)} /></aside></div>
    {open && <ProvidersDialog providers={state.providers} nodes={state.nodes} pending={pending} run={run} onClose={() => setOpen(false)} />}</div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
