import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Command, CornerDownLeft,
  ImagePlus, Keyboard, Maximize, Minimize, Minus, Monitor, MousePointer2, PanelTop, Play, Plus, Save, Send, Settings2, Trash2, X,
} from 'lucide-react';
import type { RemoteClientStatus } from '../../../shared/remote';
import { parseQuickCommands, QUICK_COMMANDS, TERMINAL_KEYS, toggleRemoteFullscreen, type QuickCommand } from '../remote-terminal-tools';
import { IconButton } from './ui';
import '../remote.css';

export interface MobileTerminalControlsProps {
  status: RemoteClientStatus;
  connected: boolean;
  navigationOpen: boolean;
  onToggleNavigation: () => void;
  fontSize: number;
  onFontSize: (value: number) => void;
  fitToViewport: boolean;
  onFitToViewport: (value: boolean) => void;
  onClaim: () => Promise<void>;
  onRelease: () => Promise<void>;
  onSend: (data: string) => Promise<void>;
  onSendText: (text: string) => Promise<void>;
  onImage: (file: File) => Promise<void>;
}

type PendingAction = 'claim' | 'release' | 'key' | 'text' | 'image' | 'fullscreen';
type Panel = 'input' | 'shortcuts' | 'display' | null;
type ShortcutTab = 'keys' | 'claude' | 'shell' | 'custom';
const storageKey = 'happypanda.remote.commands.v1';

export function MobileTerminalControls({ status, connected, navigationOpen, onToggleNavigation, fontSize, onFontSize, fitToViewport, onFitToViewport, onClaim, onRelease, onSend, onSendText, onImage }: MobileTerminalControlsProps) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const [shortcutTab, setShortcutTab] = useState<ShortcutTab>('keys');
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [error, setError] = useState('');
  const [customCommands, setCustomCommands] = useState(() => {
    try { return parseQuickCommands(localStorage.getItem(storageKey)); } catch { return []; }
  });
  const [customName, setCustomName] = useState('');
  const [customText, setCustomText] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(false);
  const composing = useRef(false);
  const pendingRef = useRef<PendingAction | null>(null);
  const remoteConnected = status.authenticated && status.phase === 'connected';
  const ownsControl = Boolean(status.deviceId && status.owner.id === status.deviceId);
  const canWrite = remoteConnected && ownsControl && connected;
  const permission = useRef({ remoteConnected, canWrite });
  permission.current = { remoteConnected, canWrite };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!canWrite) composing.current = false; }, [canWrite]);
  useEffect(() => {
    const update = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  const run = async (key: PendingAction, action: () => Promise<void>) => {
    if (pendingRef.current) return false;
    pendingRef.current = key;
    setPending(key);
    setError('');
    try { await action(); return true; }
    catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '操作失败，请重试。');
      return false;
    } finally {
      pendingRef.current = null;
      if (mounted.current) setPending(null);
    }
  };
  const sendKey = (data: string) => {
    if (!permission.current.canWrite || pendingRef.current) return;
    void run('key', () => onSend(data));
  };
  const sendText = async () => {
    if (!permission.current.canWrite || pendingRef.current || composing.current || !draft.trim()) return;
    const text = draft;
    if (await run('text', () => onSendText(text))) {
      if (mounted.current) setDraft(current => current === text ? '' : current);
    }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void sendText(); };
  const claim = () => {
    if (!permission.current.remoteConnected || pendingRef.current) return;
    void run(ownsControl ? 'release' : 'claim', ownsControl ? onRelease : onClaim);
  };
  const sendImage = (file: File) => {
    if (!permission.current.canWrite || pendingRef.current) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) && !(file.type === '' && /\.(png|jpe?g|webp)$/i.test(file.name))) {
      setError('请选择 PNG、JPEG 或 WebP 图片。'); return;
    }
    void run('image', () => onImage(file));
  };
  const showPanel = (next: Exclude<Panel, null>) => {
    setPanel(panel === next ? null : next);
    if (next === 'input' && panel !== 'input' && canWrite) window.requestAnimationFrame(() => textarea.current?.focus());
  };
  const prepareCommand = (command: QuickCommand) => {
    setDraft(command.command); setPanel('input');
    if (canWrite) window.requestAnimationFrame(() => textarea.current?.focus());
  };
  const executeCommand = async (command: QuickCommand) => {
    if (!permission.current.canWrite || pendingRef.current) return;
    if (await run('text', () => onSendText(command.command))) { if (mounted.current) setPanel(null); }
  };
  const persistCommands = (commands: QuickCommand[]) => {
    try { localStorage.setItem(storageKey, JSON.stringify(commands)); setCustomCommands(commands); return true; }
    catch { setError('浏览器未能保存快捷命令。'); return false; }
  };
  const addCommand = (event: FormEvent) => {
    event.preventDefault();
    if (!customName.trim() || !customText.trim() || customCommands.length >= 24) return;
    if (persistCommands([...customCommands, { id: `custom-${Date.now()}`, label: customName.trim(), command: customText.trim() }])) { setCustomName(''); setCustomText(''); }
  };
  const disabled = !canWrite || Boolean(pending);
  const commands = shortcutTab === 'claude' || shortcutTab === 'shell' ? QUICK_COMMANDS[shortcutTab] : customCommands;
  const arrows = [
    { icon: ArrowUp, label: '方向键：上', data: '\x1b[A' }, { icon: ArrowDown, label: '方向键：下', data: '\x1b[B' },
    { icon: ArrowLeft, label: '方向键：左', data: '\x1b[D' }, { icon: ArrowRight, label: '方向键：右', data: '\x1b[C' },
    { icon: CornerDownLeft, label: '终端回车', data: '\r' },
  ];
  const keyButton = (key: { label: string; data: string }) => <button key={key.label} type="button" className="remote-terminal-key" title={key.label} aria-label={key.label} disabled={disabled} onClick={() => sendKey(key.data)}><kbd>{key.label}</kbd></button>;

  return <section className="mobile-terminal-controls remote-compact-controls" aria-label="终端输入控制">
    <div id={`${id}-input`} className="remote-input-panel" hidden={panel !== 'input'}>
      <div className="remote-key-toolbar" role="toolbar" aria-label="终端按键" onMouseDown={event => event.preventDefault()}>
        {[TERMINAL_KEYS[0], TERMINAL_KEYS[1], TERMINAL_KEYS[3]].map(keyButton)}
        {arrows.map(key => <IconButton key={key.label} className="remote-terminal-key" icon={key.icon} label={key.label} disabled={disabled} onClick={() => sendKey(key.data)} />)}
      </div>
      <form className="remote-composer" onSubmit={submit}>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={disabled} aria-label="选择终端图片"
          onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) sendImage(file); }} />
        <IconButton icon={ImagePlus} label="发送图片" busy={pending === 'image'} disabled={disabled} onClick={() => fileInput.current?.click()} />
        <label htmlFor={`${id}-draft`} className="remote-visually-hidden">终端输入</label>
        <textarea ref={textarea} id={`${id}-draft`} value={draft} rows={1} disabled={!canWrite} placeholder={ownsControl ? '输入内容' : '接管后输入'}
          autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="send" aria-describedby={error ? `${id}-error` : undefined}
          onChange={event => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || composing.current || event.nativeEvent.keyCode === 229) return;
            event.preventDefault(); void sendText();
          }} />
        <IconButton type="submit" icon={Send} label="发送输入" className="remote-send" busy={pending === 'text'} disabled={disabled || !draft.trim()} onMouseDown={event => event.preventDefault()} />
      </form>
    </div>
    {panel === 'shortcuts' && <div id={`${id}-shortcuts`} className="remote-tool-panel" aria-label="快捷命令">
      <div className="remote-shortcut-tabs" role="tablist" aria-label="快捷操作分类">
        {([['keys', '按键'], ['claude', 'Claude'], ['shell', 'Shell'], ['custom', '自定义']] as const).map(([value, label]) =>
          <button key={value} id={`${id}-tab-${value}`} role="tab" type="button" aria-selected={shortcutTab === value} aria-controls={`${id}-shortcut-content`} onClick={() => setShortcutTab(value)}>{label}</button>)}
      </div>
      <div id={`${id}-shortcut-content`} role="tabpanel" aria-labelledby={`${id}-tab-${shortcutTab}`} className="remote-shortcut-content">
        {shortcutTab === 'keys' ? <div className="remote-shortcut-keys" onMouseDown={event => event.preventDefault()}>
          {TERMINAL_KEYS.map(keyButton)}
          {arrows.map(key => <IconButton key={key.label} className="remote-terminal-key" icon={key.icon} label={key.label} disabled={disabled} onClick={() => sendKey(key.data)} />)}
        </div> : <>
          <ul className="remote-command-list">{commands.map(command => <li key={command.id}>
            <button type="button" className="remote-command-name" title={command.command} aria-label={`填入 ${command.label}`} onClick={() => prepareCommand(command)}><code>{command.label}</code></button>
            <IconButton icon={Play} label={`执行 ${command.label}`} disabled={disabled} onClick={() => { void executeCommand(command); }} />
            {shortcutTab === 'custom' && <IconButton icon={Trash2} label={`删除 ${command.label}`} onClick={() => persistCommands(customCommands.filter(item => item.id !== command.id))} />}
          </li>)}</ul>
          {shortcutTab === 'custom' && <form className="remote-custom-command" onSubmit={addCommand}>
            <label className="remote-visually-hidden" htmlFor={`${id}-command-name`}>快捷命令名称</label>
            <input id={`${id}-command-name`} placeholder="名称" value={customName} maxLength={64} onChange={event => setCustomName(event.target.value)} />
            <label className="remote-visually-hidden" htmlFor={`${id}-command-text`}>快捷命令内容</label>
            <input id={`${id}-command-text`} placeholder="命令" value={customText} maxLength={4096} autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={event => setCustomText(event.target.value)} />
            <IconButton type="submit" icon={Save} label="保存快捷命令" disabled={!customName.trim() || !customText.trim() || customCommands.length >= 24} />
          </form>}
        </>}
      </div>
    </div>}
    {panel === 'display' && <div id={`${id}-display`} className="remote-tool-panel remote-display-panel" aria-label="终端显示设置">
      <label className="remote-fit-toggle"><input type="checkbox" checked={fitToViewport} onChange={event => onFitToViewport(event.target.checked)} />完整画面适配</label>
      <div className="remote-font-size"><label htmlFor={`${id}-font`}>字号</label>
        <IconButton icon={Minus} label="缩小终端字号" disabled={fontSize <= 8} onClick={() => onFontSize(fontSize - 1)} />
        <input id={`${id}-font`} type="range" min={8} max={20} step={1} value={fontSize} onChange={event => onFontSize(Number(event.target.value))} />
        <output htmlFor={`${id}-font`}>{fontSize}</output>
        <IconButton icon={Plus} label="放大终端字号" disabled={fontSize >= 20} onClick={() => onFontSize(fontSize + 1)} />
      </div>
    </div>}
    {error && <div id={`${id}-error`} className="remote-input-error" role="alert"><AlertTriangle size={14} aria-hidden="true" /><span>{error}</span><IconButton icon={X} label="关闭输入提示" onClick={() => setError('')} /></div>}
    <div className="remote-terminal-dock" role="toolbar" aria-label="终端工具">
      <span className="remote-visually-hidden" role="status">{!remoteConnected ? '与 PC 连接已断开' : `${status.owner.name} 控制中`}</span>
      <IconButton icon={ownsControl ? Monitor : MousePointer2} className={ownsControl ? 'remote-owns-control' : ''} label={ownsControl ? '释放控制' : '接管控制'} tooltip={`${ownsControl ? '释放控制' : '接管控制'} · ${status.owner.name}`} disabled={!remoteConnected || Boolean(pending)} busy={pending === 'claim' || pending === 'release'} onClick={claim} />
      <IconButton icon={Keyboard} label={panel === 'input' ? '收起输入区' : '展开输入区'} aria-expanded={panel === 'input'} aria-controls={`${id}-input`} onClick={() => showPanel('input')} />
      <IconButton icon={Command} label={panel === 'shortcuts' ? '收起快捷命令' : '快捷命令'} aria-expanded={panel === 'shortcuts'} aria-controls={`${id}-shortcuts`} onClick={() => showPanel('shortcuts')} />
      <IconButton icon={Settings2} label="终端显示设置" aria-expanded={panel === 'display'} aria-controls={`${id}-display`} onClick={() => showPanel('display')} />
      <IconButton icon={PanelTop} label={navigationOpen ? '收起会话导航' : '展开会话导航'} aria-expanded={navigationOpen} onClick={onToggleNavigation} />
      <IconButton icon={fullscreen ? Minimize : Maximize} label={fullscreen ? '退出全屏' : '进入全屏'} busy={pending === 'fullscreen'} onClick={() => { void run('fullscreen', () => toggleRemoteFullscreen()); }} />
    </div>
  </section>;
}
