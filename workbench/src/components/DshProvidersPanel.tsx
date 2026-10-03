import { useEffect, useState } from 'react'
import { dshModelsRpc } from '../api'
import type { DshModelCatalog } from '../api'

interface Provider { provider: string; displayName: string; settingsNs: string; settingsPath: string[]; declared?: boolean }
interface Namespace { ns: string; revision: number; value: Record<string, unknown> }
interface Settings { writable: boolean; namespaces: Namespace[] }
interface Form { provider: string; name: string; endpoint: string; protocol: string; models: string; key: string }
const empty: Form = { provider: '', name: '', endpoint: '', protocol: 'openai-completions', models: '', key: '' }
function profileAt(ns: Namespace | undefined, path: string[]): Record<string, unknown> {
  let value: unknown = ns?.value
  for (const part of path) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}
export function DshProvidersPanel(): React.JSX.Element {
  const [providers, setProviders] = useState<Provider[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [catalog, setCatalog] = useState<DshModelCatalog | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Provider | null>(null)
  const [open, setOpen] = useState(false)
  const [removing, setRemoving] = useState<Provider | null>(null)
  const [form, setForm] = useState<Form>(empty)
  async function load(): Promise<void> {
    setLoading(true); setError('')
    try {
      const [directory, current, models] = await Promise.all([
        dshModelsRpc<Provider[]>('llm/listConfigurableProviders'), dshModelsRpc<Settings>('settings/describe'), dshModelsRpc<DshModelCatalog>('session/modelCatalog'),
      ])
      setProviders(directory); setSettings(current); setCatalog(models)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const set = (key: keyof Form, value: string): void => setForm(previous => ({ ...previous, [key]: value }))
  function edit(provider: Provider): void {
    const profile = profileAt(settings?.namespaces.find(ns => ns.ns === provider.settingsNs), provider.settingsPath)
    const models = Array.isArray(profile.models) ? profile.models : catalog?.groups.find(g => g.id === provider.provider)?.models ?? []
    setEditing(provider); setNotice(''); setOpen(true)
    setForm({ provider: provider.provider, name: String(profile.displayName ?? provider.displayName), endpoint: String(profile.baseURL ?? ''), protocol: String(profile.api ?? 'openai-completions'), models: models.map(m => typeof m === 'string' ? m : String(m.id)).join('\n'), key: '' })
  }
  async function remove(): Promise<void> {
    if (!removing?.declared || removing.settingsNs !== 'llm-pi-ai') return
    const ns = settings?.namespaces.find(n => n.ns === removing.settingsNs)
    if (!ns || !settings?.writable) return
    setBusy(true); setError('')
    try {
      await dshModelsRpc('settings/mutate', { ns: ns.ns, expectedRevision: ns.revision, ops: [{ op: 'unset', path: removing.settingsPath }] })
      setRemoving(null); setNotice('供应商已删除。'); await load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setRemoving(null) }
    finally { setBusy(false) }
  }
  async function discover(): Promise<void> {
    setBusy(true); setError(''); setNotice('')
    try {
      const models = await dshModelsRpc<{ id: string }[]>('llm/discoverModels', { settingsNs: editing?.settingsNs ?? 'llm-pi-ai', request: { ...(editing ? { provider: editing.provider } : {}), ...(form.endpoint.trim() ? { baseURL: form.endpoint.trim() } : {}), api: form.protocol, ...(form.key ? { apiKey: form.key } : {}) } })
      if (!models.length) { setNotice('供应商未返回模型目录，请手动填写模型 ID。'); return }
      setForm(previous => ({ ...previous, models: [...new Set([...previous.models.split('\n').map(id => id.trim()).filter(Boolean), ...models.map(m => m.id)])].join('\n') }))
      setNotice(`已读取 ${models.length} 个模型，保存供应商后生效。`)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  async function save(): Promise<void> {
    setBusy(true); setError(''); setNotice('')
    let profileSaved = false
    try {
      const provider = form.provider.trim()
      if (!/^[a-z][a-z0-9_-]*$/.test(provider)) throw new Error('供应商 ID 须以小写字母开头，仅包含小写字母、数字、横线或下划线。')
      if (!editing && providers.some(p => p.provider === provider)) throw new Error('供应商已存在，请从列表编辑。')
      const namespace = settings?.namespaces.find(ns => ns.ns === (editing?.settingsNs ?? 'llm-pi-ai'))
      if (!namespace || !settings?.writable) throw new Error('当前模型配置不可写，请检查服务连接。')
      const ids = [...new Set(form.models.split('\n').map(id => id.trim()).filter(Boolean))]
      if (!ids.length && !editing) throw new Error('请至少填写一个模型 ID。')
      if (form.endpoint.trim()) { const endpoint = new URL(form.endpoint.trim()); if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('API 地址需使用 HTTP(S)，且不能内嵌账号密码。') }
      if (!editing && !form.endpoint.trim()) throw new Error('自定义供应商需要 API 地址。')
      const path = editing?.settingsPath ?? ['providers', provider]
      const current = profileAt(namespace, path)
      const keyRef = String(current.apiKeyEnv ?? `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`)
      const oldModels = Array.isArray(current.models) ? current.models : []
      const values: Record<string, unknown> = {
        ...(namespace.ns === 'llm-pi-ai' ? { displayName: form.name.trim(), ...(!editing || editing.declared || typeof current.api === 'string' ? { api: form.protocol } : {}) } : {}),
        ...(form.endpoint.trim() ? { baseURL: form.endpoint.trim() } : {}),
        ...(ids.length ? { models: ids.map(id => oldModels.find(m => typeof m === 'object' && m.id === id) ?? { id }) } : {}),
        ...(form.key ? { apiKeyEnv: keyRef } : {}),
      }
      const ops = editing ? Object.entries(values).map(([key, value]) => ({ op: 'set', path: [...path, key], value })) : [{ op: 'set', path, value: values }]
      await dshModelsRpc('settings/mutate', { ns: namespace.ns, ops, expectedRevision: namespace.revision }); profileSaved = true
      if (form.key) await dshModelsRpc('credentials/set', { ref: keyRef, value: form.key })
      setForm(empty); setOpen(false); setEditing(null)
      setNotice('供应商配置已保存，下一次模型请求生效。')
      await load()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (profileSaved) { await load(); setError(`供应商配置已保存，但凭证写入失败：${message}。请重新编辑该供应商补充密钥。`); setForm(previous => ({ ...previous, key: '' })); setOpen(false) }
      else setError(message)
    } finally { setBusy(false) }
  }
  return <div className="set-panel dsh-providers-panel">
    <div className="model-config-intro"><div><h2>模型</h2><p>填入模型供应商的 API 密钥即可使用其模型。配置适用于所有空间。</p></div><button className="btn" disabled={loading || busy} onClick={() => void load()}>刷新配置</button></div>
    {loading && <p>正在读取模型配置…</p>}
    {error && <div className="set-notice bad" role="alert">{error}</div>}
    {notice && <div className="set-notice ok" role="status">{notice}</div>}
    {!loading && !error && catalog && <p className="model-catalog-summary">已配置 {catalog.groups.length} 个供应商 · {catalog.groups.reduce((sum, g) => sum + g.models.length, 0)} 个模型 · 默认：{catalog.default.provider} / {catalog.default.model}</p>}
    <div className="provider-settings-list">
    {!loading && settings && providers.filter(p => ['llm-pi-ai', 'llm-deepseek'].includes(p.settingsNs)).filter(p => p.settingsNs === 'llm-deepseek' || p.provider === 'deepseek' || p.declared || catalog?.groups.some(g => g.id === p.provider) || Object.keys(profileAt(settings.namespaces.find(ns => ns.ns === p.settingsNs), p.settingsPath)).length > 0).map(p => {
      const group = catalog?.groups.find(g => g.id === p.provider)
      return <div className="provider-settings-row" key={p.provider}><strong>{p.displayName}</strong>{p.declared && <span className="provider-custom-badge">自定义</span>}<span className={`provider-state-dot${group?.models.length ? ' ready' : ''}`} role="img" aria-label={group?.models.length ? '模型已就绪' : '待配置'} title={group?.models.length ? `${group.models.length} 个可用模型` : '待配置'} /><button className="btn" disabled={busy || !settings.writable} onClick={() => edit(p)}>编辑</button>{p.declared && <button className="btn provider-delete" disabled={busy || !settings.writable} onClick={() => setRemoving(p)}>删除</button>}</div>
    })}
    <button className="provider-add" disabled={!settings?.writable || busy} onClick={() => { setEditing(null); setForm(empty); setOpen(true); setNotice('') }}>＋ 添加模型供应商</button>
    </div>
    {removing && <div className="provider-editor-mask"><div className="provider-editor-dialog" role="alertdialog" aria-label="删除供应商"><h3>删除 {removing.displayName}？</h3><p>删除后，使用该供应商的岗位需要重新选择模型。已存储的密钥不会被删除。</p><button className="btn provider-delete" disabled={busy} onClick={() => void remove()}>确认删除</button><button className="btn" disabled={busy} onClick={() => setRemoving(null)}>取消</button></div></div>}
    {catalog?.failures?.map(f => <div className="set-notice warn" key={f.id}>{f.id}：{f.message}</div>)}
    {open && <div className="provider-editor-mask"><form role="dialog" aria-modal="true" aria-label={editing ? `编辑 ${editing.displayName}` : '添加模型供应商'} className="set-form model-provider-form" onSubmit={e => { e.preventDefault(); void save() }}><h3>{editing ? `编辑 ${editing.displayName}` : '添加自定义供应商'}</h3>{error && <div className="set-notice bad" role="alert">{error}</div>}{notice && <div className="set-notice ok" role="status">{notice}</div>}<div className="set-grid">
      {!editing && <label className="field"><span>选择供应商</span><select className="set-input" value="" onChange={e => { const provider = providers.find(p => p.provider === e.target.value); if (provider) edit(provider) }}><option value="">自定义供应商</option>{providers.filter(p => ['llm-pi-ai', 'llm-deepseek'].includes(p.settingsNs) && !p.declared).map(p => <option key={p.provider} value={p.provider}>{p.displayName}</option>)}</select></label>}
      <label className="field"><span>供应商 ID</span><input className="set-input" value={form.provider} disabled={!!editing || busy} onChange={e => set('provider', e.target.value)} required placeholder="例如 company-gateway" /></label>
      <label className="field"><span>显示名称</span><input className="set-input" value={form.name} disabled={busy} onChange={e => set('name', e.target.value)} /></label>
      <label className="field"><span>API 地址</span><input className="set-input" value={form.endpoint} disabled={busy} onChange={e => set('endpoint', e.target.value)} placeholder="https://gateway.example/v1" /></label>
      {(!editing || editing.declared || typeof profileAt(settings?.namespaces.find(ns => ns.ns === editing.settingsNs), editing.settingsPath).api === 'string') && <label className="field"><span>API 协议</span><select className="set-input" value={form.protocol} disabled={busy} onChange={e => set('protocol', e.target.value)}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>}
      <label className="field"><span>API 密钥（留空保留原凭证）</span><input type="password" autoComplete="new-password" className="set-input" value={form.key} disabled={busy} onChange={e => set('key', e.target.value)} placeholder="密钥安全存储，保存后不回显" /></label>
    </div><label className="field"><span>模型 ID（每行一个）</span><textarea aria-label="模型 ID（每行一个）" className="set-textarea" value={form.models} disabled={busy} onChange={e => set('models', e.target.value)} rows={5} placeholder="填写该供应商实际支持的模型 ID" /></label><div className="set-row-space"><button className="btn" type="button" disabled={busy} onClick={() => void discover()}>获取可用模型</button><button className="btn primary" disabled={busy} type="submit">{busy ? '正在保存…' : '保存供应商'}</button><button className="btn" type="button" disabled={busy} onClick={() => { setOpen(false); setForm(empty) }}>取消</button></div></form></div>}
  </div>
}
