import { useEffect, useState } from 'react'
import { addSpaceAgents, createAgent, createSpace, fetchAgents } from '../api'
import type { AgentCatalogItem } from '../types'
import { toast } from './Toast'
import { FolderPickerField } from './FolderPickerField'

interface NewSpaceModalProps {
  onClose: () => void
  onCreated: (spaceId: string) => void
}

const AVATAR_CHOICES = ['🤖', '🧭', '🔍', '✂️', '🧪', '💻', '🔎', '🧹', '🚀', '📊', '✍️', '🎯', '📈', '💬', '🧩', '🖌️', '🎨', '🔬', '📐', '🗂️', '🎪', '🎧', '📉', '⚙️', '🎓']

export function NewSpaceModal({ onClose, onCreated }: NewSpaceModalProps): React.JSX.Element {
  const [step, setStep] = useState<'form' | 'agents'>('form')
  const [spaceId, setSpaceId] = useState('')
  const [spaceName, setSpaceName] = useState('')
  const [local, setLocal] = useState(false)
  const [localDir, setLocalDir] = useState('')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [catalog, setCatalog] = useState<AgentCatalogItem[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  // 新建智能体内联表单
  const [newAgent, setNewAgent] = useState({ role: '', name: '', kind: '', avatar: '🤖' })

  const loadCatalog = (): void => {
    setCatalogError('')
    void fetchAgents()
      .then(list => setCatalog(list))
      .catch(e => setCatalogError(e instanceof Error ? e.message : String(e)))
  }

  useEffect(() => {
    loadCatalog()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = (role: string): void => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(role)) next.delete(role)
      else next.add(role)
      return next
    })
  }

  const addNewAgent = async (): Promise<void> => {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(newAgent.role.trim())) {
      toast('err', 'role 非法：小写字母/数字开头，可含连字符')
      return
    }
    if (!newAgent.name.trim()) {
      toast('err', '请填写智能体名称')
      return
    }
    try {
      await createAgent({ ...newAgent, role: newAgent.role.trim(), name: newAgent.name.trim(), scope: spaceId })
      toast('ok', `已新建智能体「${newAgent.name.trim()}」（${newAgent.role.trim()}）`)
      setSelected(prev => new Set(prev).add(newAgent.role.trim()))
      setNewAgent({ role: '', name: '', kind: '', avatar: '🤖' })
      // 目录里补一条
      setCatalog(prev => [...prev.filter(c => c.role !== newAgent.role.trim()), {
        role: newAgent.role.trim(),
        name: newAgent.name.trim(),
        kind: newAgent.kind.trim(),
        avatar: newAgent.avatar,
        scopes: [spaceId],
      }])
    } catch (e) {
      toast('err', `新建失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const submit = async (): Promise<void> => {
    if (step === 'form') {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(spaceId.trim())) {
        toast('err', '空间 id 非法：小写字母/数字开头，可含连字符')
        return
      }
      if (!spaceName.trim()) {
        toast('err', '请填写空间名称')
        return
      }
      setStep('agents')
      return
    }
    // 创建空间 + 选人入编
    setBusy(true)
    try {
      await createSpace(spaceId.trim(), spaceName.trim(), local, { localDir: localDir.trim(), remoteUrl: remoteUrl.trim() })
      const roles = [...selected]
      if (roles.length > 0) {
        await addSpaceAgents(spaceId.trim(), roles)
      }
      toast('ok', `空间「${spaceName.trim()}」已创建${local ? '（🏠 本地/私有，仅本机）' : ''}${localDir.trim() ? `（本地文件夹 ${localDir.trim()}）` : ''}${roles.length > 0 ? `，编入 ${roles.length} 名智能体` : '（暂未配编队，可稍后从目录选人）'}`)
      onCreated(spaceId.trim())
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast('err', msg.includes('401') ? '令牌无效或缺失：请在右上角「🔑 令牌」设置' : `创建失败：${msg}`)
    } finally {
      setBusy(false)
    }
  }

  const filtered = catalog.filter(c => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return c.name.toLowerCase().includes(q) || c.role.toLowerCase().includes(q) || c.scopes.some(s => s.includes(q))
  })

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          {step === 'form' ? '＋ 新建工作空间' : '⚔ 配置编队 · 选择智能体'}
          <span className="step">{step === 'form' ? '1 / 2' : '2 / 2'}</span>
          <span className="x" onClick={onClose}>✕</span>
        </div>

        {step === 'form' ? (
          <div className="modal-body">
            <div className="field">
              <label>空间 id *（小写字母/数字开头，可含连字符，唯一）</label>
              <input value={spaceId} onChange={e => setSpaceId(e.target.value)} placeholder="例如：hr（人力资源部）" autoFocus />
            </div>
            <div className="field">
              <label>空间名称 *</label>
              <input value={spaceName} onChange={e => setSpaceName(e.target.value)} placeholder="例如：人力资源部空间" />
            </div>
            <label className="local-toggle">
              <input type="checkbox" checked={local} onChange={e => setLocal(e.target.checked)} />
              <span>🏠 本地/私有空间（仅在本机操作，不进共享 git 仓库）</span>
            </label>
            <FolderPickerField
              value={localDir}
              onChange={(path, hint) => {
                setLocalDir(path)
                if (hint?.remoteUrl && !remoteUrl.trim()) setRemoteUrl(hint.remoteUrl)
              }}
              onClear={() => {
                setLocalDir('')
                setRemoteUrl('')
              }}
            />
            <div className="field">
              <label>远程仓库 URL（git 远程地址；默认从所选仓库的 origin/首个 remote 自动填入，留空 = 仅本地 / 不进共享仓库）</label>
              <input value={remoteUrl} onChange={e => setRemoteUrl(e.target.value)} placeholder="例如：https://github.com/you/repo.git（或留空）" />
            </div>
          </div>
        ) : (
          <div className="modal-body">
            <div className="space-summary">
              🗂 <b>{spaceName.trim()}</b>（{spaceId.trim()}）· 已选 <b>{selected.size}</b> 名
            </div>
            <div className="field">
              <label>从现有智能体中选择（全局目录，含来源空间）</label>
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索名称 / role / 来源空间…" />
            </div>
            {catalogError && (
              <div className="catalog-error">
                ⚠ 智能体目录加载失败：{catalogError}
                <button className="btn small" onClick={loadCatalog}>重试</button>
                <span className="skip-hint">可跳过选人，先建空空间再补编队</span>
              </div>
            )}
            {!catalogError && (
              <div className="agent-picker">
                {filtered.map(c => (
                  <label key={c.role} className={`agent-option${selected.has(c.role) ? ' picked' : ''}`}>
                    <input type="checkbox" checked={selected.has(c.role)} onChange={() => toggle(c.role)} />
                    <span className="ao-avatar">{c.avatar}</span>
                    <span className="ao-name">{c.name}</span>
                    <span className="ao-role">{c.role}</span>
                    <span className="ao-scopes">{c.scopes.join(' / ')}</span>
                  </label>
                ))}
                {filtered.length === 0 && <div style={{ color: 'var(--muted-2)', fontSize: 11, padding: 8 }}>目录为空或没有匹配项</div>}
              </div>
            )}
            <div className="new-agent-block">
              <div className="new-agent-title">＋ 新建智能体（直接加入本空间）</div>
              <div className="new-agent-row">
                <input value={newAgent.role} onChange={e => setNewAgent(a => ({ ...a, role: e.target.value }))} placeholder="role：如 hr-analyst" />
                <input value={newAgent.name} onChange={e => setNewAgent(a => ({ ...a, name: e.target.value }))} placeholder="名称：如 人事分析员" />
                <input value={newAgent.kind} onChange={e => setNewAgent(a => ({ ...a, kind: e.target.value }))} placeholder="职责（可选）" />
                <select value={newAgent.avatar} onChange={e => setNewAgent(a => ({ ...a, avatar: e.target.value }))}>
                  {AVATAR_CHOICES.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
                <button className="btn small" onClick={() => void addNewAgent()}>加入</button>
              </div>
            </div>
          </div>
        )}

        <div className="modal-foot">
          {step === 'agents' && (
            <button className="btn ghost" onClick={() => setStep('form')}>← 上一步</button>
          )}
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '创建中…' : step === 'form' ? '下一步：配置编队' : selected.size > 0 ? `创建空间并配队（${selected.size}）` : '直接创建空间'}
          </button>
        </div>
      </div>
    </div>
  )
}
