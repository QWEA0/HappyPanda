import { useEffect, useId, useState, type FormEvent } from 'react';
import { ChevronDown, KeyRound, Pencil, Plus, Settings2, Trash2 } from 'lucide-react';
import type { ApiProvider, AppState, ProviderInput, ServiceNode } from '../../../shared/types';
import type { RunAction } from '../useAppState';
import { IconButton, Modal, SubmitButton, type DialogFeedback } from './ui';

export function ProviderPanel({ state, node, pending, run, onManage }: {
  state: AppState; node: ServiceNode; pending: Set<string>; run: RunAction; onManage: () => void;
}) {
  const id = useId();
  const [selected, setSelected] = useState(node.providerId || '');
  useEffect(() => setSelected(node.providerId || ''), [node.id, node.providerId]);
  const active = state.connection.activeNodeId === node.id;
  const busy = pending.has('select-provider');
  const blocked = busy || pending.has('new-session') || pending.has('connect') ||
    (active && ['preparing', 'connecting', 'retrying'].includes(state.connection.phase));
  const provider = state.providers.find(item => item.id === node.providerId);
  return <section className="sidebar-section provider-section">
    <div className="section-heading"><h2>API 提供商</h2><IconButton icon={Settings2} label="管理 API 提供商" onClick={onManage} disabled={busy} /></div>
    <label className="sr-only" htmlFor={id}>当前服务器的 API 提供商</label>
    <select id={id} value={selected} disabled={blocked} onChange={event => setSelected(event.target.value)}>
      <option value="">官方账号</option>
      {state.providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select>
    <p className="provider-description muted">{provider ? `${provider.name} · API 接入已配置` : '使用服务器上的 Claude 官方账号'}</p>
    {provider && <p className="provider-endpoint mono muted" title={provider.baseUrl}>{provider.baseUrl}</p>}
    <button className="button provider-apply" disabled={blocked} aria-busy={busy} onClick={() => {
      void run('select-provider', '切换提供商', api => api.selectProvider(node.id, selected || null), {
        success: active ? 'Claude 已重载，提供商配置已应用' : '已保存此服务器的提供商配置',
      });
    }}>{busy ? '正在重载 Claude…' : active ? '应用并重载 Claude' : '应用提供商'}</button>
    <p className="provider-description muted">{active ? '重载会中断当前任务，并继续已保存的对话。' : '下次连接时生效。'}</p>
    {!state.providers.length && <button className="provider-add" onClick={onManage}><Plus size={13} aria-hidden="true" />添加第三方 API</button>}
  </section>;
}

export function ProvidersDialog({ providers, nodes, pending, run, onClose, ...feedback }: DialogFeedback & {
  providers: ApiProvider[]; nodes: ServiceNode[]; pending: Set<string>; run: RunAction; onClose: () => void;
}) {
  const [editing, setEditing] = useState<ApiProvider | 'new' | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const busy = pending.has('save-provider') || pending.has('remove-provider') || pending.has('select-provider');
  const changeView = (provider: ApiProvider | 'new' | null) => { feedback.dismissFeedback?.(); setEditing(provider); setDeleting(null); };
  if (editing) return <ProviderForm key={editing === 'new' ? 'new' : editing.id} provider={editing === 'new' ? undefined : editing}
    pending={pending} run={run} onClose={() => changeView(null)} {...feedback} />;
  return <Modal title="API 提供商" onClose={onClose} {...feedback}>
    <div className="dialog-body">
      <p className="provider-intro muted">保存多个兼容 Anthropic 接口的服务，在服务器侧栏选择并应用。</p>
      <ul className="provider-list">
        <li className="provider-row"><KeyRound size={17} aria-hidden="true" /><div className="option-text"><strong>官方账号</strong><span className="muted">使用服务器上已登录的 Claude 账号</span></div><span className="muted">默认</span></li>
        {providers.map(provider => {
          const usedBy = nodes.filter(node => node.providerId === provider.id).map(node => node.name);
          return <li key={provider.id} className="provider-list-item"><div className="provider-row">
            <KeyRound size={17} aria-hidden="true" /><div className="option-text"><strong title={provider.name}>{provider.name}</strong>
              <span className="muted provider-endpoint" title={provider.baseUrl}>{provider.baseUrl}</span>
              <span className="muted">{usedBy.length ? `使用中：${usedBy.join('、')}` : '密钥已加密保存'}</span></div>
            <IconButton icon={Pencil} label={`编辑 ${provider.name}`} disabled={busy} onClick={() => changeView(provider)} />
            <IconButton icon={Trash2} label={`删除 ${provider.name}`} disabled={busy || usedBy.length > 0} tooltip={usedBy.length ? '先切换使用此提供商的服务器，再删除' : `删除 ${provider.name}`}
              onClick={() => setDeleting(provider.id)} />
          </div>{deleting === provider.id && <div className="provider-delete"><span>删除此提供商及其密钥？</span>
            <button className="button" disabled={busy} onClick={() => setDeleting(null)}>取消</button>
            <button className="button danger" disabled={busy} onClick={() => {
              void run('remove-provider', '删除提供商', api => api.removeProvider(provider.id), { success: '提供商已删除' }).then(result => { if (result.ok) setDeleting(null); });
            }}>删除</button></div>}</li>;
        })}
      </ul>
    </div>
    <footer className="dialog-footer"><button className="button" onClick={onClose}>关闭</button>
      <button className="button primary" disabled={busy} onClick={() => changeView('new')}><Plus size={15} aria-hidden="true" />新增提供商</button></footer>
  </Modal>;
}

function ProviderForm({ provider, pending, run, onClose, ...feedback }: DialogFeedback & {
  provider?: ApiProvider; pending: Set<string>; run: RunAction; onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(provider?.name || '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl || '');
  const [token, setToken] = useState('');
  const [authType, setAuthType] = useState<ProviderInput['authType']>(provider?.authType || 'auth-token');
  const [model, setModel] = useState(provider?.model || '');
  const [disableTraffic, setDisableTraffic] = useState(provider?.disableNonessentialTraffic ?? true);
  const [error, setError] = useState('');
  const busy = pending.has('save-provider');
  const save = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (!name.trim() || !baseUrl.trim() || (!provider && !token.trim())) { setError('请填写名称、API 地址和密钥。'); return; }
    try { const url = new URL(baseUrl.trim()); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(); }
    catch { setError('请输入完整的 HTTP(S) API 地址，不要包含密钥或查询参数。'); return; }
    const result = await run('save-provider', '保存提供商', api => api.saveProvider({
      id: provider?.id, name: name.trim(), baseUrl: baseUrl.trim(), token: token.trim() || undefined,
      authType, model: model.trim() || undefined, disableNonessentialTraffic: disableTraffic,
    }), { success: '提供商已保存，请在服务器侧栏应用' });
    if (result.ok) { setToken(''); onClose(); }
  };
  return <Modal title={provider ? '编辑提供商' : '新增提供商'} onClose={onClose} {...feedback}>
    <form className="dialog-form" onSubmit={event => { void save(event); }}>
      <div className="dialog-body form-fields"><fieldset className="provider-fields" disabled={busy}>
        <div className="field"><label htmlFor={`${id}-name`}>提供商名称</label><input id={`${id}-name`} data-autofocus required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="例如：主用 API / 备用 API" autoComplete="off" /></div>
        <div className="field"><label htmlFor={`${id}-url`}>API 地址</label><input id={`${id}-url`} type="url" required maxLength={2048} value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.example.com" autoComplete="off" spellCheck={false} />
          <span className="field-hint">填写提供商给出的 Base URL，无需添加 /messages。</span></div>
        <div className="field"><label htmlFor={`${id}-token`}>API 密钥</label><input id={`${id}-token`} type="password" required={!provider} maxLength={8192} value={token} onChange={event => setToken(event.target.value)} placeholder={provider ? '留空保留已保存的密钥' : '输入 API Key / Token'} autoComplete="new-password" spellCheck={false} />
          <span className="field-hint">密钥在本机加密保存。</span></div>
        <details className="advanced-fields"><summary><ChevronDown size={14} aria-hidden="true" />高级设置</summary><div className="form-fields">
          <div className="field"><label htmlFor={`${id}-auth`}>认证方式</label><select id={`${id}-auth`} value={authType} onChange={event => setAuthType(event.target.value as ProviderInput['authType'])}>
            <option value="auth-token">Bearer Token（默认）</option><option value="api-key">API Key（x-api-key）</option></select></div>
          <div className="field"><label htmlFor={`${id}-model`}>模型名称（可选）</label><input id={`${id}-model`} value={model} maxLength={160} onChange={event => setModel(event.target.value)} placeholder="使用 Claude 默认模型" autoComplete="off" spellCheck={false} /></div>
          <label className="provider-checkbox"><input type="checkbox" checked={disableTraffic} onChange={event => setDisableTraffic(event.target.checked)} />关闭非必要网络请求</label>
        </div></details>
      </fieldset>{error && <p className="field-error" role="alert">{error}</p>}</div>
      <footer className="dialog-footer"><button type="button" className="button" disabled={busy} onClick={onClose}>返回</button><SubmitButton busy={busy}>{busy ? '保存中…' : '保存提供商'}</SubmitButton></footer>
    </form>
  </Modal>;
}
