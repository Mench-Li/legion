import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchWorkflowPackAssets, fetchWorkflowPacks, installWorkflowPack, previewWorkflowPack, type InstalledWorkflowPack, type WorkflowPackAsset, type WorkflowPackFile, type WorkflowPackPreview } from '../api'

interface WorkflowPacksPanelProps { hubMode: boolean }

export function WorkflowPacksPanel({ hubMode }: WorkflowPacksPanelProps): React.JSX.Element {
  const [installed, setInstalled] = useState<InstalledWorkflowPack[]>([])
  const [candidate, setCandidate] = useState<WorkflowPackFile | null>(null)
  const [preview, setPreview] = useState<WorkflowPackPreview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [assetsByPack, setAssetsByPack] = useState<Record<string, WorkflowPackAsset[] | null>>({})
  const fileRef = useRef<HTMLInputElement | null>(null)

  const refresh = useCallback(async () => {
    if (!hubMode) return
    try { setInstalled(await fetchWorkflowPacks()) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法读取已安装流程包') }
  }, [hubMode])

  useEffect(() => { void refresh() }, [refresh])

  const chooseFile = async (file: File | undefined): Promise<void> => {
    setCandidate(null)
    setPreview(null)
    setError('')
    if (!file) return
    if (file.size > 2_000_000) { setError('流程包超过 2 MB 限制。'); return }
    setBusy(true)
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('文件内容不是流程包对象')
      const pack = parsed as WorkflowPackFile
      const next = await previewWorkflowPack(pack)
      setCandidate(pack)
      setPreview(next)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '流程包校验失败') }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = '' }
  }

  const apply = async (): Promise<void> => {
    if (!candidate || !preview || !['install', 'upgrade'].includes(preview.action)) return
    setBusy(true)
    setError('')
    try {
      await installWorkflowPack(candidate)
      setCandidate(null)
      setPreview(null)
      await refresh()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '流程包安装失败') }
    finally { setBusy(false) }
  }

  const toggleAssets = async (item: InstalledWorkflowPack): Promise<void> => {
    if (assetsByPack[item.id] !== undefined) {
      setAssetsByPack(current => ({ ...current, [item.id]: current[item.id] === null ? [] : null }))
      return
    }
    setBusy(true)
    setError('')
    try {
      const assets = await fetchWorkflowPackAssets(item.scope, item.id)
      setAssetsByPack(current => ({ ...current, [item.id]: assets }))
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法读取流程包内容') }
    finally { setBusy(false) }
  }

  return (
    <section style={{ padding: 24, maxWidth: 960, margin: '0 auto', color: 'var(--text)' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>流程包</h2>
          <p style={{ color: 'var(--muted)', lineHeight: 1.6 }}>按场景安装和升级 Legion 工作流。流程包只包含声明式角色、阶段、技能和文档内容，不会运行包内脚本。</p>
        </div>
        <button className="btn primary" disabled={!hubMode || busy} onClick={() => fileRef.current?.click()}>
          {busy ? '正在校验…' : '导入 .legionpack'}
        </button>
        <input ref={fileRef} type="file" accept=".legionpack,application/json" hidden onChange={event => void chooseFile(event.currentTarget.files?.[0])} />
      </header>

      {!hubMode && <p role="status">数据中枢连接后即可管理流程包。</p>}
      {error && <p role="alert" style={{ color: 'var(--danger, #d55)' }}>{error}</p>}

      <h3>已安装</h3>
      {installed.length === 0 ? <p style={{ color: 'var(--muted)' }}>当前没有可显示的已安装流程包。</p> : (
        <div style={{ display: 'grid', gap: 10 }}>
          {installed.map(item => <article key={item.id} style={{ padding: 14, border: '1px solid var(--border, #445)', borderRadius: 8 }}>
            <strong>{item.id}</strong> <span>v{item.version}</span>
            <div style={{ color: 'var(--muted)', marginTop: 4 }}>空间：{item.scope} · 安装时间：{new Date(item.installedAt).toLocaleString()}</div>
            <button className="btn" disabled={busy} style={{ marginTop: 10 }} onClick={() => void toggleAssets(item)}>
              {assetsByPack[item.id] === undefined || assetsByPack[item.id] === null ? '查看包内内容' : '收起包内内容'}
            </button>
            {assetsByPack[item.id] && <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
              {assetsByPack[item.id]?.length === 0 && <span style={{ color: 'var(--muted)' }}>此流程包没有附带文档或模板。</span>}
              {assetsByPack[item.id]?.map(asset => <details key={asset.id} style={{ borderTop: '1px solid var(--border, #445)', paddingTop: 8 }}>
                <summary>{asset.title} · {asset.type} · {asset.path}</summary>
                <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 420, overflow: 'auto' }}>{asset.content}</pre>
              </details>)}
            </div>}
          </article>)}
        </div>
      )}

      {preview && candidate && <article style={{ marginTop: 24, padding: 18, border: '1px solid var(--border, #445)', borderRadius: 10 }}>
        <h3 style={{ marginTop: 0 }}>导入预览</h3>
        <strong>{preview.name}</strong> <span>v{preview.version}</span>
        <p>{preview.description}</p>
        <p>目标空间：{preview.scope} · 角色 {preview.roles} · 流程阶段 {preview.stages} · 附带内容 {preview.assets}</p>
        <p role="status">{preview.action === 'install' ? '将创建新的流程空间。' : preview.action === 'upgrade' ? '将升级此包；系统已检查受管内容没有被本地修改。' : preview.action === 'current' ? '此版本已安装，无需变更。' : `无法安全导入：${preview.reason ?? '存在冲突'}。`}</p>
        {['install', 'upgrade'].includes(preview.action) && <button className="btn primary" disabled={busy} onClick={() => void apply()}>
          {busy ? '正在安装…' : preview.action === 'upgrade' ? '确认升级' : '确认安装'}
        </button>}
        <button className="btn" disabled={busy} style={{ marginLeft: 8 }} onClick={() => { setCandidate(null); setPreview(null) }}>取消</button>
      </article>}
    </section>
  )
}
