import { useCallback, useEffect, useState } from 'react'
import { fetchSkills, grantSkill, hubBase, registerSkill, reviewSkill } from '../api'
import type { SkillInfo } from '../types'
import { toast } from './Toast'

const STATUS_TEXT: Record<SkillInfo['status'], string> = {
  published: '已发布',
  pending: '待复审',
  rejected: '已驳回',
}

interface SkillsPanelProps {
  scope: string | null
  hubMode: boolean
}

interface RegisterForm {
  id: string
  name: string
  description: string
  prompt: string
  scope: string
}

export function SkillsPanel({ scope, hubMode }: SkillsPanelProps): React.JSX.Element {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showGrants, setShowGrants] = useState<string | null>(null)
  const [grantsInput, setGrantsInput] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      const list = await fetchSkills({ scope, includePending: true })
      setSkills(list)
    } catch (e) {
      toast('err', `技能列表加载失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [scope])

  useEffect(() => {
    setLoading(true)
    void load()
    const poll = window.setInterval(() => void load(), 15000)
    return () => window.clearInterval(poll)
  }, [load])

  if (!hubMode) {
    return (
      <div className="center-col">
        <div className="panel goal-card">
          <span style={{ color: 'var(--yellow)' }}>🧩 技能中心需要 team-hub v2（中枢）</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            启动 <code>node team-hub/server.mjs</code>（:8787）后本面板自动可用；右上角「🧭 中枢」可指定地址
          </span>
        </div>
      </div>
    )
  }

  const submit = async (form: RegisterForm): Promise<void> => {
    try {
      const res = await registerSkill({
        id: form.id.trim(),
        name: form.name.trim(),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        ...(form.prompt.trim() ? { prompt: form.prompt.trim() } : {}),
        scope: form.scope.trim() || 'default',
      })
      const v = (res as { task?: { version?: number } })?.task?.version
      toast('ok', `技能已提交（v${v ?? 1}），等待复审发布`)
      setShowForm(false)
      void load()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast('err', msg.includes('401') ? '令牌无效或缺失：请在右上角「🔑 令牌」设置' : `提交失败：${msg}`)
    }
  }

  const review = async (id: string, action: 'publish' | 'reject'): Promise<void> => {
    setBusyId(id)
    try {
      await reviewSkill(id, action)
      toast('ok', action === 'publish' ? `「${id}」已发布，士兵可同步使用` : `「${id}」已驳回`)
      void load()
    } catch (e) {
      toast('err', `复审失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyId(null)
    }
  }

  const doGrant = async (id: string): Promise<void> => {
    const grants = grantsInput.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
    if (grants.length === 0) {
      toast('err', '请输入授权对象（成员 id 或 scope:xxx，逗号分隔）')
      return
    }
    setBusyId(id)
    try {
      await grantSkill(id, grants)
      toast('ok', `「${id}」已授权给 ${grants.join('、')}`)
      setShowGrants(null)
      void load()
    } catch (e) {
      toast('err', `授权失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyId(null)
    }
  }

  const pendingCount = skills.filter(s => s.status === 'pending').length

  return (
    <div className="center-col">
      <div className="panel goal-card">
        <span className="tag" style={{ color: 'var(--muted)', fontSize: 11 }}>
          🧩 团队共享技能
        </span>
        <span style={{ fontSize: 12, color: 'var(--text)' }}>
          {scope ? `空间「${scope}」` : '全部空间'}
          <span style={{ color: 'var(--muted-2)', fontSize: 11 }}> · 共 {skills.length} 项{pendingCount > 0 ? ` · ${pendingCount} 项待复审` : ''}</span>
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <button className="btn primary" onClick={() => setShowForm(true)}>
            ＋ 注册新技能
          </button>
        </span>
      </div>

      {loading ? (
        <div className="scene-loading" style={{ position: 'static', padding: 40 }}>
          ⏳ 正在同步技能库…
        </div>
      ) : skills.length === 0 ? (
        <div className="panel" style={{ padding: 32, textAlign: 'center', color: 'var(--muted-2)', fontSize: 12 }}>
          暂无技能。注册第一个团队技能（提交后进入待复审，由将军发布）。
        </div>
      ) : (
        <div className="skills-grid">
          {skills.map(s => (
            <div key={s.id} className={`panel skill-card ${s.status}`}>
              <div className="skill-head">
                <span className="skill-name">{s.name}</span>
                <span className={`skill-status ${s.status}`}>{STATUS_TEXT[s.status]}</span>
              </div>
              <div className="skill-meta">
                <span className="chip">{s.id}</span>
                <span className="chip">v{s.version}</span>
                <span className="chip">🗂 {s.scope}</span>
                {s.owner && <span className="chip">👤 {s.owner}</span>}
              </div>
              {s.description && <div className="skill-desc">{s.description}</div>}
              {s.prompt && (
                <details className="skill-prompt">
                  <summary>查看 prompt（{s.prompt.length} 字）</summary>
                  <pre>{s.prompt}</pre>
                </details>
              )}
              {s.grants.length > 0 && (
                <div className="skill-grants">已授权：{s.grants.map(g => <code key={g}>{g}</code>)}</div>
              )}
              <div className="skill-actions">
                {s.status === 'pending' && (
                  <>
                    <button className="btn small ok" disabled={busyId === s.id} onClick={() => void review(s.id, 'publish')}>
                      {busyId === s.id ? '…' : '✅ 发布'}
                    </button>
                    <button className="btn small danger" disabled={busyId === s.id} onClick={() => void review(s.id, 'reject')}>
                      驳回
                    </button>
                  </>
                )}
                {s.status === 'published' && (
                  <button className="btn small" disabled={busyId === s.id} onClick={() => { setShowGrants(s.id); setGrantsInput(s.grants.join(', ')) }}>
                    🔑 授权
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && <SkillForm scope={scope} onSubmit={submit} onClose={() => setShowForm(false)} />}
      {showGrants && (
        <div className="modal-mask" onClick={() => setShowGrants(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              🔑 授权技能「{showGrants}」
              <span className="x" onClick={() => setShowGrants(null)}>✕</span>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>授权对象（成员 id 或 scope:xxx，逗号分隔）</label>
                <input value={grantsInput} onChange={e => setGrantsInput(e.target.value)} placeholder="例如：soldier-a, scope:software" />
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setShowGrants(null)}>取消</button>
              <button className="btn primary" disabled={busyId === showGrants} onClick={() => void doGrant(showGrants)}>
                {busyId === showGrants ? '提交中…' : '确认授权'}
              </button>
            </div>
          </div>
        </div>
      )}
      <div style={{ fontSize: 10, color: 'var(--muted-2)', padding: '0 4px' }}>
        数据源：team-hub v2（{hubBase()}）· 提交后需将军复审发布，士兵/守护只读取已发布技能
      </div>
    </div>
  )
}

function SkillForm({ scope, onSubmit, onClose }: {
  scope: string | null
  onSubmit: (form: RegisterForm) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [form, setForm] = useState<RegisterForm>({ id: '', name: '', description: '', prompt: '', scope: scope ?? 'default' })
  const [busy, setBusy] = useState(false)
  const set = (k: keyof RegisterForm, v: string): void => setForm(f => ({ ...f, [k]: v }))

  const submit = async (): Promise<void> => {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(form.id.trim())) {
      toast('err', '技能 id 非法：小写字母/数字开头，可含连字符，≤64 字符')
      return
    }
    if (!form.name.trim()) {
      toast('err', '请填写技能名称')
      return
    }
    setBusy(true)
    try {
      await onSubmit(form)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          ＋ 注册新技能
          <span className="x" onClick={onClose}>✕</span>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>技能 id *（小写字母/数字开头，可含连字符）</label>
            <input value={form.id} onChange={e => set('id', e.target.value)} placeholder="例如：code-review-checklist" autoFocus />
          </div>
          <div className="field">
            <label>名称 *</label>
            <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="例如：代码审查清单" />
          </div>
          <div className="field">
            <label>描述</label>
            <textarea value={form.description} onChange={e => set('description', e.target.value)} placeholder="这个技能解决什么问题…" />
          </div>
          <div className="field">
            <label>prompt（士兵实际使用的工作指引）</label>
            <textarea value={form.prompt} onChange={e => set('prompt', e.target.value)} placeholder="详细的操作步骤、检查项、输出格式…" />
          </div>
          <div className="field">
            <label>所属空间（scope）</label>
            <input value={form.scope} onChange={e => set('scope', e.target.value)} placeholder="default" />
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '提交中…' : '提交（待复审）'}
          </button>
        </div>
      </div>
    </div>
  )
}
