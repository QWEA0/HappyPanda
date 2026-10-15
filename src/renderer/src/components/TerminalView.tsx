import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { AlertTriangle, LoaderCircle, Terminal as TerminalIcon } from 'lucide-react';
import type { AppState } from '../../../shared/types';
import { errorText, requireDesktop } from '../api';
import { connectionLabels } from '../format';

export interface TerminalHandle {
  copy(): Promise<void>;
  paste(): Promise<void>;
  focus(): void;
}

interface TerminalProps {
  state: AppState;
  onError: (title: string, detail: string) => void;
  onInfo: (title: string) => void;
}

function contextId(state: AppState): string {
  return `${state.connection.activeNodeId || ''}/${state.connection.activeSessionId || ''}`;
}

export const TerminalView = forwardRef<TerminalHandle, TerminalProps>(function TerminalView(props, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [hasOutput, setHasOutput] = useState(Boolean(props.state.terminalBuffer));
  const [pastingContext,setPastingContext]=useState<string|null>(null);
  const pasteRef=useRef<{context:string}|null>(null);

  const copy = useCallback(async () => {
    const selection = terminalRef.current?.getSelection();
    if (!selection) { propsRef.current.onInfo('请先选中要复制的终端内容。'); return; }
    try {
      await requireDesktop().copyText(selection);
    } catch (error) {
      propsRef.current.onError('复制失败', errorText(error));
    }
  }, []);

  const paste = useCallback(async () => {
    const state=propsRef.current.state;
    const context=contextId(state);
    if(pasteRef.current?.context===context)return;
    const operation={context};pasteRef.current=operation;
    try {
      const api=requireDesktop();
      const terminal=terminalRef.current;
      if (!terminal||state.connection.phase !== 'connected'||!state.connection.activeNodeId||!state.connection.activeSessionId) {
        throw new Error('终端尚未连接，暂时无法粘贴。');
      }
      setPastingContext(context);
      const result=await api.pasteClipboard({nodeId:state.connection.activeNodeId,sessionId:state.connection.activeSessionId,bracketedPaste:terminal.modes.bracketedPasteMode});
      if(terminalRef.current===terminal&&contextId(propsRef.current.state)===context){
        terminal.focus();
        if(result.kind==='image')propsRef.current.onInfo('图片已粘贴，可以补充说明后按 Enter 发送。');
        else if(result.kind==='empty')propsRef.current.onInfo('剪贴板里没有图片或文字。');
      }
    } catch (error) {
      propsRef.current.onError('粘贴失败', errorText(error));
    } finally {if(pasteRef.current===operation){pasteRef.current=null;setPastingContext(null);}}
  }, []);

  useImperativeHandle(ref, () => ({ copy, paste, focus: () => terminalRef.current?.focus() }), [copy, paste]);

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({
      fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      fontWeight: 'normal',
      fontWeightBold: 'bold',
      lineHeight: 1.2,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10000,
      screenReaderMode: true,
      rightClickSelectsWord: true,
      disableStdin: !window.happyPanda || propsRef.current.state.connection.phase !== 'connected',
      theme: {
        background: '#191B1E',
        foreground: '#E5E7EB',
        cursor: '#E5E7EB',
        cursorAccent: '#191B1E',
        selectionBackground: '#465053',
        selectionInactiveBackground: '#353C40',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon((event, url) => {
      event.preventDefault();
      try {
        const protocol = new URL(url).protocol;
        if (!['http:', 'https:'].includes(protocol)) throw new Error('仅支持打开 HTTP 或 HTTPS 链接。');
        void requireDesktop().openExternal(url).catch((error: unknown) => propsRef.current.onError('打开链接失败', errorText(error)));
      } catch (error) {
        propsRef.current.onError('打开链接失败', errorText(error));
      }
    }));
    terminal.open(hostRef.current);
    terminalRef.current = terminal;
    let currentContext = contextId(propsRef.current.state);
    let outputReceived = Boolean(propsRef.current.state.terminalBuffer);
    if (propsRef.current.state.terminalBuffer) terminal.write(propsRef.current.state.terminalBuffer);
    let disposed = false;
    let frame = 0;

    const scheduleFit = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (disposed || !hostRef.current || hostRef.current.clientWidth < 1 || hostRef.current.clientHeight < 1) return;
        try { fit.fit(); } catch (error) { propsRef.current.onError('终端尺寸更新失败', errorText(error)); }
      });
    };
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(hostRef.current);
    scheduleFit();
    void document.fonts.ready.then(() => { if (!disposed) scheduleFit(); });

    const input = terminal.onData((data) => {
      try { requireDesktop().writeTerminal(data); }
      catch (error) { propsRef.current.onError('终端输入失败', errorText(error)); }
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      if (!window.happyPanda) return;
      try { window.happyPanda.resizeTerminal(cols, rows); }
      catch (error) { propsRef.current.onError('调整远程终端失败', errorText(error)); }
    });
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const copyShortcut = !event.altKey && (event.metaKey || (event.ctrlKey && (event.shiftKey || terminal.hasSelection())));
      if (copyShortcut && event.code === 'KeyC') {
        event.preventDefault();
        if (!event.repeat) void copy();
        return false;
      }
      if (!event.altKey&&((event.code==='KeyV'&&(event.ctrlKey||event.metaKey))||(event.code==='Insert'&&event.shiftKey))) {
        event.preventDefault();
        if(!event.repeat)void paste();
        return false;
      }
      return true;
    });
    // Catch native/context-menu paste before xterm's text-only handler.
    const host=hostRef.current;
    const pasteEvent=(event:ClipboardEvent)=>{event.preventDefault();event.stopImmediatePropagation();void paste();};
    host.addEventListener('paste',pasteEvent,true);

    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = window.happyPanda?.onEvent((event) => {
        if (disposed) return;
        if (event.type === 'terminal') {
          terminal.write(event.data);
          if (event.data && !outputReceived) { outputReceived = true; setHasOutput(true); }
        } else if (event.type === 'state') {
          const nextContext = contextId(event.state);
          if (nextContext !== currentContext) {
            currentContext = nextContext;
            terminal.reset();
            outputReceived = Boolean(event.state.terminalBuffer);
            setHasOutput(outputReceived);
            if (event.state.terminalBuffer) terminal.write(event.state.terminalBuffer);
            scheduleFit();
          } else if (!outputReceived && event.state.terminalBuffer) {
            terminal.write(event.state.terminalBuffer);
            outputReceived = true;
            setHasOutput(true);
          }
        }
      });
    } catch (error) {
      propsRef.current.onError('订阅终端输出失败', errorText(error));
    }
    terminal.focus();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribe?.();
      host.removeEventListener('paste',pasteEvent,true);
      input.dispose();
      resize.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [copy, paste]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.disableStdin = !window.happyPanda || props.state.connection.phase !== 'connected';
    }
  }, [props.state.connection.phase]);

  const phase = props.state.connection.phase;
  const busy = ['preparing', 'connecting', 'retrying'].includes(phase);
  const showEmptyState = !hasOutput && phase !== 'connected';
  return <div className="terminal-view">
    <div ref={hostRef} className="terminal-host" aria-label="远程 SSH 终端" />
    {pastingContext===contextId(props.state)&&<div className="terminal-paste-status" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" />正在粘贴…</div>}
    {showEmptyState && <div className="terminal-empty" role="status" aria-live="polite">
      {busy ? <LoaderCircle size={25} className="spin" aria-hidden="true" />
        : phase === 'failed' ? <AlertTriangle size={25} aria-hidden="true" /> : <TerminalIcon size={25} aria-hidden="true" />}
      <h2>{connectionLabels[phase]}</h2>
      {props.state.connection.message && <p>{props.state.connection.message}</p>}
    </div>}
  </div>;
});
