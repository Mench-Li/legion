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
      if (!namespace || !settings?.writable) throw new Error('当前 DSH 未提供可写的模型配置。')
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
      setNotice('DSH 供应商配置已保存，下一次模型请求生效。')
      await load()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (profileSaved) { await load(); setError(`供应商配置已保存，但凭证写入失败：${message}。请重新编辑该供应商补充密钥。`); setForm(previous => ({ ...previous, key: '' })); setOpen(false) }
      else setError(message)
    } finally { setBusy(false) }
  }
  return <div className="set-panel dsh-providers-panel">
    <div className="model-config-intro"><div><h2>供应商与模型</h2><p>沿用 DSH 的供应商目录、配置和凭证库。这里修改的是 DSH 全局配置，适用于所有空间。</p></div><div className="set-row-space"><a className="btn" href="http://127.0.0.1:3080/" target="_blank" rel="noreferrer">打开 DSH</a><button className="btn" disabled={loading || busy} onClick={() => void load()}>刷新配置</button><button className="btn primary" disabled={!settings?.writable || busy} onClick={() => { setEditing(null); setForm(empty); setOpen(true); setNotice('') }}>添加供应商</button></div></div>
    {loading && <p>正在读取 DSH 配置…</p>}
    {error && <div className="set-notice bad" role="alert"><div className="set-notice-title">{error}</div>{error.includes('登录') && <div className="set-notice-text">DSH 使用独立登录会话。请用 DSH 启动时提供的登录链接登录，再点击刷新配置。</div>}</div>}
    {notice && <div className="set-notice ok" role="status">{notice}</div>}
    {!loading && !error && catalog && <p className="model-catalog-summary">已配置 {catalog.groups.length} 个供应商 · {catalog.groups.reduce((sum, g) => sum + g.models.length, 0)} 个模型 · 默认：{catalog.default.provider} / {catalog.default.model}</p>}
    {!loading && settings && providers.filter(p => ['llm-pi-ai', 'llm-deepseek'].includes(p.settingsNs)).map(p => {
      const group = catalog?.groups.find(g => g.id === p.provider)
      const profile = profileAt(settings.namespaces.find(ns => ns.ns === p.settingsNs), p.settingsPath)
      const configured = Object.keys(profile).length > 0
      return <div className="set-card" key={p.provider}><div className="set-card-head"><strong>{p.displayName}</strong><span className="chip">{p.provider}</span><span className="model-provider-status">{group ? `${group.models.length} 个模型` : configured ? '已配置 · 暂无可用模型' : '尚未配置'}</span><button className="btn" disabled={busy || !settings.writable} onClick={() => edit(p)}>{configured ? '编辑供应商' : '配置供应商'}</button></div><div className="set-card-sub">{String(profile.baseURL ?? '使用供应商默认地址')} · {String(profile.api ?? '供应商默认协议')}</div>{group && <div className="model-provider-models">{group.models.map(m => <span key={m.id} title={m.id}>{m.name || m.id}</span>)}</div>}</div>
    })}
    {catalog?.failures?.map(f => <div className="set-notice warn" key={f.id}>{f.id}：{f.message}</div>)}
    {open && <form className="set-form model-provider-form" onSubmit={e => { e.preventDefault(); void save() }}><h3>{editing ? `编辑 ${editing.displayName}` : '添加自定义供应商'}</h3><div className="set-grid">
      <label className="field"><span>供应商 ID</span><input className="set-input" value={form.provider} disabled={!!editing || busy} onChange={e => set('provider', e.target.value)} required placeholder="例如 company-gateway" /></label>
      <label className="field"><span>显示名称</span><input className="set-input" value={form.name} disabled={busy} onChange={e => set('name', e.target.value)} /></label>
      <label className="field"><span>API 地址</span><input className="set-input" value={form.endpoint} disabled={busy} onChange={e => set('endpoint', e.target.value)} placeholder="https://gateway.example/v1" /></label>
      {(!editing || editing.declared || typeof profileAt(settings?.namespaces.find(ns => ns.ns === editing.settingsNs), editing.settingsPath).api === 'string') && <label className="field"><span>API 协议</span><select className="set-input" value={form.protocol} disabled={busy} onChange={e => set('protocol', e.target.value)}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>}
      <label className="field"><span>API 密钥（留空保留原凭证）</span><input type="password" autoComplete="new-password" className="set-input" value={form.key} disabled={busy} onChange={e => set('key', e.target.value)} placeholder="密钥仅写入 DSH 凭证库" /></label>
    </div><label className="field"><span>模型 ID（每行一个）</span><textarea aria-label="模型 ID（每行一个）" className="set-textarea" value={form.models} disabled={busy} onChange={e => set('models', e.target.value)} rows={5} placeholder="填写该供应商实际支持的模型 ID" /></label><div className="set-row-space"><button className="btn" type="button" disabled={busy} onClick={() => void discover()}>获取可用模型</button><button className="btn primary" disabled={busy} type="submit">{busy ? '正在保存…' : '保存供应商'}</button><button className="btn" type="button" disabled={busy} onClick={() => { setOpen(false); setForm(empty) }}>取消</button></div></form>}
  </div>
}
