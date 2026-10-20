import { Component, useEffect, useRef, useSyncExternalStore, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, RotateCw } from 'lucide-react';
import App from './App';
import { RemoteGate } from './components/RemoteGate';
import { isRemotePage, remoteClient } from './remote-client';
import { observeRemoteViewport } from './remote-viewport';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import './remote.css';

function RemoteRoot() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const status = useSyncExternalStore(remoteClient.subscribe, remoteClient.getStatus);
  useEffect(() => {
    remoteClient.start();
    const stopObserving = viewportRef.current ? observeRemoteViewport(viewportRef.current) : undefined;
    return () => {
      remoteClient.dispose();
      stopObserving?.();
    };
  }, []);
  return <div ref={viewportRef} className="remote-app"><RemoteGate status={status} onPair={remoteClient.pair} onReconnect={remoteClient.reconnect} onLogout={remoteClient.logout}><App /></RemoteGate></div>;
}

class RendererBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Renderer error', error, info.componentStack); }

  render() {
    if (this.state.error) return <div className="renderer-error" role="alert">
      <AlertTriangle size={24} aria-hidden="true" /><h1>界面暂时不可用</h1><p>{this.state.error}</p>
      <button className="button" onClick={() => window.location.reload()}><RotateCw size={15} aria-hidden="true" />重新加载</button>
    </div>;
    return this.props.children;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('Renderer root is missing');
const remote = isRemotePage();
if (remote) Object.defineProperty(window, 'happyPanda', { value: remoteClient.api, configurable: true });
createRoot(root).render(<RendererBoundary>{remote ? <RemoteRoot /> : <App />}</RendererBoundary>);
