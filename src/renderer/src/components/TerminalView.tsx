import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { AlertTriangle, LoaderCircle, Terminal as TerminalIcon } from 'lucide-react';
import type { AppEvent, AppState, OpenSessionState } from '../../../shared/types';
import { errorText, requireDesktop } from '../api';
import { connectionLabels } from '../format';
import { lastTerminalSizeMark, parseTerminalSize, TERMINAL_SIZE_OSC, terminalHasOutput, terminalPaste } from '../../../shared/terminal';
import { terminalDisplayScale } from '../remote-terminal-tools';
import { attachTouchScroll, terminalScrollTarget } from '../terminal-touch-scroll';

export interface TerminalHandle {
  copy(): Promise<void>;
  paste(): Promise<void>;
  focus(): void;
  sendText(text: string): Promise<void>;
  bracketedPaste(): boolean;
}

interface TerminalProps {
  state: AppState;
  onError: (title: string, detail: string) => void;
  onInfo: (title: string) => void;
  inputEnabled?: boolean;
  mobile?: boolean;
  fontSize?: number;
  fitToViewport?: boolean;
  onImage?: (file: File) => Promise<void>;
  /** Bind the view to one open session (desktop tabs). Without it the view follows the focused session. */
  session?: OpenSessionState;
  /** A bound view that is not active stays mounted but hidden; xterm keeps parsing output without rendering it. */
  active?: boolean;
}

function contextId(state: AppState): string {
  return `${state.connection.activeNodeId || ''}/${state.connection.activeSessionId || ''}`;
}
function target(props: TerminalProps) {
  if (props.session) return { nodeId: props.session.nodeId, sessionId: props.session.sessionId, phase: props.session.phase, message: props.session.message };
  const { activeNodeId, activeSessionId, phase, message } = props.state.connection;
  return { nodeId: activeNodeId, sessionId: activeSessionId, phase, message };
}
const targetContext = (props: TerminalProps) => { const { nodeId, sessionId } = target(props); return `${nodeId || ''}/${sessionId || ''}`; };
/** Only the visible view of the controlling side sizes the PTY; every other view follows the size marks in the output. */
const decidesSize = (props: TerminalProps) => Boolean(window.happyPanda) && props.inputEnabled !== false && (!props.session || Boolean(props.active));

export const TerminalView = forwardRef<TerminalHandle, TerminalProps>(function TerminalView(props, ref) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [hasOutput, setHasOutput] = useState(Boolean(!props.session && terminalHasOutput(props.state.terminalBuffer)));
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
    const current=target(propsRef.current);
    const context=targetContext(propsRef.current);
    if(pasteRef.current?.context===context)return;
    const operation={context};pasteRef.current=operation;
    try {
      const api=requireDesktop();
      const terminal=terminalRef.current;
      if (!terminal||current.phase !== 'connected'||!current.nodeId||!current.sessionId) {
        throw new Error('终端尚未连接，暂时无法粘贴。');
      }
      setPastingContext(context);
      const result=await api.pasteClipboard({nodeId:current.nodeId,sessionId:current.sessionId,bracketedPaste:terminal.modes.bracketedPasteMode});
      if(terminalRef.current===terminal&&targetContext(propsRef.current)===context){
        terminal.focus();
        if(result.kind==='image')propsRef.current.onInfo('图片已粘贴，可以补充说明后按 Enter 发送。');
        else if(result.kind==='empty')propsRef.current.onInfo('剪贴板里没有图片或文字。');
      }
    } catch (error) {
      propsRef.current.onError('粘贴失败', errorText(error));
    } finally {if(pasteRef.current===operation){pasteRef.current=null;setPastingContext(null);}}
  }, []);

  useImperativeHandle(ref, () => ({
    copy, paste, focus: () => { if (!propsRef.current.mobile) terminalRef.current?.focus(); },
    bracketedPaste: () => Boolean(terminalRef.current?.modes.bracketedPasteMode),
    sendText: async text => {
      if (!terminalRef.current || propsRef.current.inputEnabled === false || target(propsRef.current).phase !== 'connected') throw new Error('终端尚未连接或未取得控制权。');
      await requireDesktop().writeTerminal(terminalPaste(text, terminalRef.current.modes.bracketedPasteMode) + '\r', propsRef.current.session?.sessionId);
    },
  }), [copy, paste]);

  useEffect(() => {
    if (!hostRef.current) return;
    const bound = propsRef.current.session?.sessionId;
    const mobile = Boolean(propsRef.current.mobile);
    const terminal = new Terminal({
      cols: propsRef.current.state.terminalSize?.cols ?? 100,
      rows: propsRef.current.state.terminalSize?.rows ?? 32,
      fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: propsRef.current.fontSize ?? 14,
      fontWeight: 'normal',
      fontWeightBold: 'bold',
      lineHeight: 1.2,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10000,
      // The phone types through its own composer; the accessibility tree would double the DOM work of every scroll.
      screenReaderMode: !mobile,
      // Needed for the Unicode 11 width table below.
      allowProposedApi: true,
      // Ambiguous-width glyphs from fallback fonts are scaled into their cells instead of overlapping neighbours.
      rescaleOverlappingGlyphs: true,
      rightClickSelectsWord: true,
      disableStdin: !window.happyPanda || target(propsRef.current).phase !== 'connected' || propsRef.current.inputEnabled === false,
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
    // Claude Code measures emoji and CJK with modern width tables; xterm's default Unicode 6 widths misplace the cursor.
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = '11';
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
    // The GPU renderer keeps every glyph on the cell grid and scrolls without rebuilding DOM rows; fall back to DOM if it is lost.
    let webgl: WebglAddon | undefined;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => { webgl?.dispose(); webgl = undefined; });
      terminal.loadAddon(webgl);
    } catch { webgl?.dispose(); webgl = undefined; }
    terminalRef.current = terminal;
    let currentContext = contextId(propsRef.current.state);
    let outputReceived = false;
    let disposed = false;
    let frame = 0;
    // Size marks always apply while scrollback is replayed; live, only views that do not size the PTY follow them.
    let replaying = 0;
    let ptySize = bound ? undefined : propsRef.current.state.terminalSize;
    const sizeMarks = terminal.parser.registerOscHandler(TERMINAL_SIZE_OSC, payload => {
      const size = parseTerminalSize(payload);
      if (size && (replaying > 0 || !decidesSize(propsRef.current))) terminal.resize(size.cols, size.rows);
      return true;
    });
    const received = (data: string, replay = false) => {
      if (replay) { replaying++; terminal.write(data, () => { replaying--; scheduleFit(); }); }
      else terminal.write(data);
      if (!outputReceived && terminalHasOutput(data)) { outputReceived = true; setHasOutput(true); }
    };
    // A bound view tracks the PTY generation (a reattach starts a new terminal) and the
    // output offset, so scrollback fetched on mount splices exactly with streamed events.
    let generation = -1;
    let end = 0;
    let queued: Extract<AppEvent, { type: 'terminal' }>[] | null = bound ? [] : null;
    const restart = (next: number) => {
      generation = next; end = 0; terminal.reset();
      outputReceived = false; setHasOutput(false);
    };
    const boundOutput = (event: Extract<AppEvent, { type: 'terminal' }>) => {
      if (event.generation !== undefined && event.generation !== generation) {
        if (event.generation < generation) return;
        restart(event.generation);
      }
      const eventEnd = event.end ?? end + event.data.length;
      if (eventEnd <= end) return;
      const skip = Math.max(0, end - (eventEnd - event.data.length));
      end = eventEnd;
      received(skip ? event.data.slice(skip) : event.data);
    };
    if (bound) {
      void requireDesktop().getTerminalBuffer(bound).then(buffer => {
        if (disposed) return;
        const pending = queued ?? [];
        queued = null;
        generation = buffer.generation; end = buffer.end;
        if (buffer.cols && buffer.rows) ptySize = { cols: buffer.cols, rows: buffer.rows };
        if (buffer.data) received(buffer.data, true);
        for (const event of pending) boundOutput(event);
        scheduleFit();
      }).catch(error => {
        const pending = queued ?? [];
        queued = null;
        for (const event of pending) boundOutput(event);
        propsRef.current.onError('读取终端历史失败', errorText(error));
      });
    } else if (propsRef.current.state.terminalBuffer) received(propsRef.current.state.terminalBuffer, true);

    // The controlling view tells the PTY its size whenever they differ, not only when xterm itself resized:
    // after a phone hands control back, the desktop xterm may already have its own size while the PTY does not.
    const syncPtySize = () => {
      if (!decidesSize(propsRef.current) || replaying > 0) return;
      const { cols, rows } = terminal;
      if (ptySize?.cols === cols && ptySize.rows === rows) return;
      const previous = ptySize;
      ptySize = { cols, rows };
      try {
        void Promise.resolve(window.happyPanda!.resizeTerminal(cols, rows, bound)).catch(error => {
          if (ptySize?.cols === cols && ptySize.rows === rows) ptySize = previous;
          propsRef.current.onError('调整远程终端失败', errorText(error));
        });
      } catch (error) { ptySize = previous; propsRef.current.onError('调整远程终端失败', errorText(error)); }
    };
    const scheduleFit = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (disposed || !hostRef.current || hostRef.current.clientWidth < 1 || hostRef.current.clientHeight < 1) return;
        try {
          const host = hostRef.current;
          const viewport = viewportRef.current;
          host.style.width = '';
          host.style.height = '';
          host.style.transform = '';
          host.dataset.terminalScale = '1';
          if (decidesSize(propsRef.current)) {
            const size = fit.proposeDimensions();
            // Keep short keyboard viewports within the PTY's accepted dimensions.
            if (size) terminal.resize(Math.max(10, Math.min(500, size.cols)), Math.max(3, Math.min(300, size.rows)));
            syncPtySize();
          }
          const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
          if (propsRef.current.fitToViewport && viewport && screen) {
            const scale = terminalDisplayScale({ width: viewport.clientWidth, height: viewport.clientHeight }, { width: screen.offsetWidth, height: screen.offsetHeight });
            host.style.width = `${viewport.clientWidth / scale}px`;
            host.style.height = `${viewport.clientHeight / scale}px`;
            host.style.transform = `scale(${scale})`;
            host.dataset.terminalScale = String(scale);
          }
        } catch (error) { propsRef.current.onError('终端尺寸更新失败', errorText(error)); }
      });
    };
    fitRef.current = scheduleFit;
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(viewportRef.current ?? hostRef.current);
    scheduleFit();
    void document.fonts.ready.then(() => { if (!disposed) scheduleFit(); });

    const input = terminal.onData((data) => {
      try { void Promise.resolve(requireDesktop().writeTerminal(data, bound)).catch(error => propsRef.current.onError('终端输入失败', errorText(error))); }
      catch (error) { propsRef.current.onError('终端输入失败', errorText(error)); }
    });
    // A size mark changes the screen size, so the phone's fit-to-viewport scale must follow.
    const resize = terminal.onResize(() => scheduleFit());
    const host=hostRef.current;
    const stopTouchScroll = mobile && viewportRef.current ? attachTouchScroll(viewportRef.current, terminalScrollTarget(terminal, {
      viewport: viewportRef.current,
      scale: () => Number(host.dataset.terminalScale) || 1,
      canType: () => propsRef.current.inputEnabled !== false && target(propsRef.current).phase === 'connected',
    })) : undefined;
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
      // Ctrl+Tab switches session tabs (handled by the app); keep it out of the PTY.
      if (event.ctrlKey && event.key === 'Tab') return false;
      return true;
    });
    // Catch native/context-menu paste before xterm's text-only handler.
    const pasteEvent=(event:ClipboardEvent)=>{
      event.preventDefault();event.stopImmediatePropagation();
      if(propsRef.current.mobile&&event.clipboardData){
        const image=Array.from(event.clipboardData.files).find(file=>file.type.startsWith('image/'));
        const text=event.clipboardData.getData('text/plain');
        if(image&&propsRef.current.onImage){void propsRef.current.onImage(image).catch(error=>propsRef.current.onError('图片上传失败',errorText(error)));return;}
        if(text){
          try{void Promise.resolve(requireDesktop().writeTerminal(terminalPaste(text,terminal.modes.bracketedPasteMode),bound)).catch(error=>propsRef.current.onError('粘贴失败',errorText(error)));}
          catch(error){propsRef.current.onError('粘贴失败',errorText(error));}
          return;
        }
      }
      void paste();
    };
    host.addEventListener('paste',pasteEvent,true);

    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = window.happyPanda?.onEvent((event) => {
        if (disposed) return;
        if (bound) {
          if (event.type === 'terminal' && event.sessionId === bound) {
            if (queued) queued.push(event); else boundOutput(event);
          } else if (event.type === 'terminal-size' && event.sessionId === bound) {
            ptySize = { cols: event.cols, rows: event.rows };
          } else if (event.type === 'state' && !queued) {
            const next = event.state.openSessions?.find(item => item.sessionId === bound)?.generation;
            if (next !== undefined && next > generation) restart(next);
          }
          return;
        }
        if (event.type === 'terminal') {
          received(event.data);
        } else if (event.type === 'terminal-size') {
          // The xterm itself follows the size mark in the output stream, at the right byte.
          ptySize = { cols: event.cols, rows: event.rows };
        } else if (event.type === 'state') {
          const nextContext = contextId(event.state);
          if (nextContext !== currentContext || event.resetTerminal) {
            currentContext = nextContext;
            terminal.reset();
            ptySize = event.state.terminalSize;
            const size = event.state.terminalSize, buffer = event.state.terminalBuffer;
            if (!decidesSize(propsRef.current) && size && !lastTerminalSizeMark(buffer)) terminal.resize(size.cols, size.rows);
            outputReceived = false;
            setHasOutput(false);
            if (buffer) received(buffer, true);
            scheduleFit();
          } else if (!outputReceived && terminalHasOutput(event.state.terminalBuffer)) {
            received(event.state.terminalBuffer, true);
          }
        }
      });
    } catch (error) {
      propsRef.current.onError('订阅终端输出失败', errorText(error));
    }
    if (!propsRef.current.mobile && (!bound || propsRef.current.active)) terminal.focus();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribe?.();
      stopTouchScroll?.();
      host.removeEventListener('paste',pasteEvent,true);
      input.dispose();
      resize.dispose();
      sizeMarks.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [copy, paste]);

  const phase = target(props).phase;
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.disableStdin = !window.happyPanda || phase !== 'connected' || props.inputEnabled === false;
      terminalRef.current.options.fontSize = props.fontSize ?? 14;
      fitRef.current?.();
    }
  }, [phase, props.inputEnabled, props.state.terminalSize?.cols, props.state.terminalSize?.rows, props.fontSize, props.fitToViewport]);

  // Becoming the visible tab: size the PTY to the shared container and take keyboard focus.
  useEffect(() => {
    if (!props.session || !props.active) return;
    fitRef.current?.();
    if (!props.mobile) terminalRef.current?.focus();
  }, [props.session?.sessionId, props.active, props.mobile]);

  const message = target(props).message;
  const busy = ['preparing', 'connecting', 'retrying'].includes(phase);
  const showEmptyState = !hasOutput && phase !== 'connected';
  return <div className={`terminal-view${props.inputEnabled === false && props.state.terminalSize ? ' terminal-view-observer' : ''}${props.fitToViewport ? ' terminal-view-fit' : ''}`}
    hidden={props.session ? !props.active : undefined} role={props.session ? 'tabpanel' : undefined}
    id={props.session ? `terminal-${props.session.sessionId}` : undefined}>
    <div ref={viewportRef} className="terminal-viewport"><div ref={hostRef} className="terminal-host" aria-label="远程 SSH 终端" /></div>
    {pastingContext===targetContext(props)&&<div className="terminal-paste-status" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" />正在粘贴…</div>}
    {showEmptyState && <div className="terminal-empty" role="status" aria-live="polite">
      {busy ? <LoaderCircle size={25} className="spin" aria-hidden="true" />
        : phase === 'failed' ? <AlertTriangle size={25} aria-hidden="true" /> : <TerminalIcon size={25} aria-hidden="true" />}
      <h2>{connectionLabels[phase]}</h2>
      {message && <p>{message}</p>}
    </div>}
  </div>;
});
