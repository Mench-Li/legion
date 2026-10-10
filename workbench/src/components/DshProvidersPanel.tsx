import { useEffect, useState } from 'react'
import { hubRequest } from '../api'

// ★ 这一页读写的是 **Legion 自己的模型库**（`/api/model-providers`），
//   不再经过 DSH 的 `/api`（那条路要宿主自己的浏览器会话，见 docs/DECISION-legion-owns-model-config.md）。
//   用户在这一页看到、改动的东西都属于 Legion；把它同步给引擎是 Legion **运行时**的事
//   （P3 的物化，默认关；见页面底部的说明）。
//
//   为什么要写这段注释：这一页**曾经**是"DSH 配置页的代理"（`llm/listConfigurableProviders` +
//   `settings/describe` + `settings/mutate` + `credentials/set`），
//   于是"谁能打开这一页"取决于"谁能登进 DSH"。产品的边界是 Legion，不是引擎。

interface Provider {
  id: string
  displayName: string
  api: string | null
  baseURL: string | null
  secretRef: string | null
  credentialConfigured: boolean
  models: { id: string; name?: string }[]
  source: string
  version: number
}
interface Form { provider: string; name: string; endpoint: string; protocol: string; models: string; key: string }
const empty: Form = { provider: '', name: '', endpoint: '', protocol: 'openai-completions', models: '', key: '' }

/** 凭证引用名的约定：`<ID>_API_KEY`（与 DSH 的 `refs` 键空间同形：POSIX 标识符）。 */
function defaultKeyRef(id: string): string {
  return `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}
function asProviders(v: unknown): Provider[] {
  const list = (v as { providers?: unknown })?.providers
  return Array.isArray(list) ? list as Provider[] : []
}

export function DshProvidersPanel(): React.JSX.Element {
  const [providers, setProviders] = useState<Provider[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Provider | null>(null)
  const [open, setOpen] = useState(false)
  const [removing, setRemoving] = useState<Provider | null>(null)
  const [form, setForm] = useState<Form>(empty)
  /** 密钥库的可用性（`GET /api/secrets/status`）。`null` = 还没问出来。 */
  const [keyStore, setKeyStore] = useState<{ ok: boolean; message: string } | null>(null)

  async function load(): Promise<void> {
    setLoading(true); setError('')
    try {
      setProviders(asProviders(await hubRequest('GET', '/api/model-providers')))
      // ★ 顺带问一次密钥库能不能用，**在用户动手之前**。
      //   实测（2026-10-09 真实部署）：`GET /api/secrets` → 503 `SECRETS_LAYOUT_BLOCKED`
      //   （产品目录布局未确定 ⇒ 不知道密钥库在哪）。那时"填密钥"这条路是坏的，
      //   而只在保存时吐一段 503 会让人以为是自己的输入有问题。
      //   提前显示 = 用户在打字之前就知道这一栏现在存不了。
      try {
        const s = await hubRequest('GET', '/api/secrets/status') as { status?: { ok?: boolean; message?: string } }
        setKeyStore({ ok: s?.status?.ok === true, message: String(s?.status?.message ?? '') })
      } catch { setKeyStore(null) }
    } catch (e) {
      // 失败就如实说。**不给**"连接某个服务"的按钮 —— 那是把引擎的鉴权搬到产品表面（BUG-014 第二版）。
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const set = (key: keyof Form, value: string): void => setForm(previous => ({ ...previous, [key]: value }))

  function edit(provider: Provider): void {
    setEditing(provider); setNotice(''); setError(''); setOpen(true)
    setForm({
      provider: provider.id,
      name: provider.displayName,
      endpoint: provider.baseURL ?? '',
      protocol: provider.api ?? 'openai-completions',
      models: provider.models.map(m => m.id).join('\n'),
      key: '',
    })
  }

  async function remove(): Promise<void> {
    if (!removing) return
    setBusy(true); setError('')
    try {
      await hubRequest('DELETE', `/api/model-providers/${encodeURIComponent(removing.id)}`, { actor: 'general', version: removing.version })
      setRemoving(null); setNotice('供应商已删除。'); await load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setRemoving(null) }
    finally { setBusy(false) }
  }

  async function discover(): Promise<void> {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await hubRequest('POST', '/api/model-providers/discover', {
        actor: 'general', baseURL: form.endpoint.trim(), ...(form.key ? { apiKey: form.key } : {}),
      }) as { models?: { id: string }[] }
      const ids = (result.models ?? []).map(m => m.id)
      if (!ids.length) { setNotice('供应商未返回模型目录，请手动填写模型 ID。'); return }
      setForm(previous => ({ ...previous, models: [...new Set([...previous.models.split('\n').map(id => id.trim()).filter(Boolean), ...ids])].join('\n') }))
      setNotice(`已读取 ${ids.length} 个模型，保存供应商后生效。`)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  async function save(): Promise<void> {
    setBusy(true); setError(''); setNotice('')
    // 服务端会告诉我们这次是"新建"还是"复活了一条同名墓碑"（见下面的 setNotice）
    let revived = false
    try {
      const id = form.provider.trim()
      if (!/^[a-z][a-z0-9_-]*$/.test(id)) throw new Error('供应商 ID 须以小写字母开头，仅包含小写字母、数字、横线或下划线。')
      const ids = [...new Set(form.models.split('\n').map(x => x.trim()).filter(Boolean))]
      if (!ids.length) throw new Error('请至少填写一个模型 ID。')
      if (!form.endpoint.trim()) throw new Error('自定义供应商需要 API 地址。')
      const endpoint = new URL(form.endpoint.trim())
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
        throw new Error('API 地址需使用 HTTP(S)，且不能内嵌账号密码。')
      }
      const keyRef = editing?.secretRef ?? defaultKeyRef(id)

      // ★ 先写凭证、再写供应商 —— 顺序不能反。
      //   反过来的话"供应商写成功、凭证写失败"会留下一条**声称有密钥、其实没有**的配置，
      //   而那正是旧实现里的部分成功状态（它当时只能在界面上补一句"凭证写入失败"）。
      //   先写凭证则失败时什么都没落库，用户可以原样重试。
      if (form.key) {
        await hubRequest('POST', '/api/secrets', { ref: keyRef, value: form.key, purpose: `模型供应商 ${id}` })
      }
      const provider = {
        id, displayName: form.name.trim() || id, api: form.protocol,
        baseURL: form.endpoint.trim(), secretRef: form.key || editing?.secretRef ? keyRef : null,
        credentialConfigured: Boolean(form.key) || editing?.credentialConfigured === true,
        models: ids.map(modelId => editing?.models.find(m => m.id === modelId) ?? { id: modelId }),
      }
      if (editing) {
        await hubRequest('POST', `/api/model-providers/${encodeURIComponent(id)}`, { actor: 'general', version: editing.version, provider })
      } else {
        // ★ 同名墓碑会**复活**（服务端返回 `revived`）。说"已恢复"而不是"已保存"：
        //   用户刚做过一次删除，他需要知道"那条又回来了"，而不是"又新建了一条"。
        const created = await hubRequest('POST', '/api/model-providers', { actor: 'general', provider }) as { revived?: boolean }
        revived = created?.revived === true
      }

      setForm(empty); setOpen(false); setEditing(null)
      setNotice(revived
        ? '已**恢复**同名供应商（它此前被删除过），运行时会在下一轮同步给引擎。'
        : '供应商已保存到模型库，运行时会在下一轮同步给引擎。')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  const modelCount = providers.reduce((sum, p) => sum + p.models.length, 0)
  const readyCount = providers.filter(p => p.credentialConfigured).length

  return <div className="set-panel dsh-providers-panel">
    <div className="model-config-intro"><div><h2>模型</h2><p>填入模型供应商的 API 密钥即可使用其模型。配置适用于所有空间。</p></div><button className="btn" disabled={loading || busy} onClick={() => void load()}>刷新配置</button></div>
    {loading && <p>正在读取模型配置…</p>}
    {error && <div className="set-notice bad" role="alert">{error}</div>}
    {notice && <div className="set-notice ok" role="status">{notice}</div>}
    {keyStore?.ok === false && <div className="set-notice warn" role="status">
      <p><strong>密钥暂时存不进来</strong>：模型的密钥要存进 Legion 自己的受保护密钥库，而这台机器上它现在打不开。</p>
      <p>{keyStore.message || '密钥库的存放位置还没有确定。'}</p>
      <p>供应商的名称、地址与模型列表**不受影响**，可以正常保存；等密钥库就绪后再回来补密钥即可。</p>
    </div>}
    {!loading && !error && <p className="model-catalog-summary">已配置 {providers.length} 个供应商 · {modelCount} 个模型 · {readyCount} 个已填密钥</p>}
    <div className="provider-settings-list">
      {!loading && providers.map(p => <div className="provider-settings-row" key={p.id}>
        <strong>{p.displayName}</strong>
        {p.source === 'dsh-import' && <span className="provider-custom-badge">自运行环境导入</span>}
        <span className={`provider-state-dot${p.credentialConfigured && p.models.length > 0 ? ' ready' : ''}`} role="img"
          aria-label={p.credentialConfigured && p.models.length > 0 ? '模型已就绪' : '待配置'}
          title={p.credentialConfigured ? `${p.models.length} 个模型 · 密钥已配置` : '还没有填密钥'} />
        <button className="btn" disabled={busy} onClick={() => edit(p)}>编辑</button>
        <button className="btn provider-delete" disabled={busy} onClick={() => setRemoving(p)}>删除</button>
      </div>)}
      <button className="provider-add" disabled={busy} onClick={() => { setEditing(null); setForm(empty); setOpen(true); setNotice(''); setError('') }}>＋ 添加模型供应商</button>
    </div>
    {removing && <div className="provider-editor-mask"><div className="provider-editor-dialog" role="alertdialog" aria-label="删除供应商"><h3>删除 {removing.displayName}？</h3><p>删除后，使用该供应商的岗位需要重新选择模型。已存储的密钥不会被删除。</p><button className="btn provider-delete" disabled={busy} onClick={() => void remove()}>确认删除</button><button className="btn" disabled={busy} onClick={() => setRemoving(null)}>取消</button></div></div>}
    {open && <div className="provider-editor-mask"><form role="dialog" aria-modal="true" aria-label={editing ? `编辑 ${editing.displayName}` : '添加模型供应商'} className="set-form model-provider-form" onSubmit={e => { e.preventDefault(); void save() }}><h3>{editing ? `编辑 ${editing.displayName}` : '添加自定义供应商'}</h3>{error && <div className="set-notice bad" role="alert">{error}</div>}{notice && <div className="set-notice ok" role="status">{notice}</div>}<div className="set-grid">
      <label className="field"><span>供应商 ID</span><input className="set-input" value={form.provider} disabled={!!editing || busy} onChange={e => set('provider', e.target.value)} required placeholder="例如 company-gateway" /></label>
      <label className="field"><span>显示名称</span><input className="set-input" value={form.name} disabled={busy} onChange={e => set('name', e.target.value)} /></label>
      <label className="field"><span>API 地址</span><input className="set-input" value={form.endpoint} disabled={busy} onChange={e => set('endpoint', e.target.value)} placeholder="https://gateway.example/v1" /></label>
      <label className="field"><span>API 协议</span><select className="set-input" value={form.protocol} disabled={busy} onChange={e => set('protocol', e.target.value)}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
      <label className="field"><span>API 密钥（留空保留原凭证）</span><input type="password" autoComplete="new-password" className="set-input" value={form.key} disabled={busy} onChange={e => set('key', e.target.value)} placeholder="密钥安全存储，保存后不回显" /></label>
    </div><label className="field"><span>模型 ID（每行一个）</span><textarea aria-label="模型 ID（每行一个）" className="set-textarea" value={form.models} disabled={busy} onChange={e => set('models', e.target.value)} rows={5} placeholder="填写该供应商实际支持的模型 ID" /></label><div className="set-row-space"><button className="btn" type="button" disabled={busy || !form.endpoint.trim()} onClick={() => void discover()}>获取可用模型</button><button className="btn primary" disabled={busy} type="submit">{busy ? '正在保存…' : '保存供应商'}</button><button className="btn" type="button" disabled={busy} onClick={() => { setOpen(false); setForm(empty) }}>取消</button></div></form></div>}
  </div>
}
