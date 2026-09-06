import { useCallback, useEffect, useState } from 'react'
import { fetchSkills, grantSkill, hubBase, registerSkill, reviewSkill, revokeSkill } from '../api'
import type { SkillInfo, SpaceInfo } from '../types'
import { toast } from './Toast'

const STATUS_TEXT: Record<SkillInfo['status'], string> = {
  published: '已发布',
  pending: '待复审',
  rejected: '已驳回',
}

interface SkillsPanelProps {
  scope: string | null
  hubMode: boolean
  /** 全部空间列表（供授权目标空间选择器/来源标注用；缺省时退化为文本授权）。 */
  spaces?: SpaceInfo[]
}

interface RegisterForm {
  id: string
  name: string
  description: string
  prompt: string
  scope: string
}

function splitTokens(raw: string): string[] {
  return raw.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
}

// 技能中心（R-1/S2）：本空间技能 + 跨空间共享。空间视图以 general 复审视角取本 scope 全状态（register→review 流程）；
// 「全部空间」聚合视图不请求 include=pending（服务端收口，仅 published，TC-S2-02/06）。渲染安全（I-5）：纯文本节点。

export function SkillsPanel({ scope, hubMode, spaces = [] }: SkillsPanelProps): React.JSX.Element {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showGrants, setShowGrants] = useState<string | null>(null)
  const [grantsInput, setGrantsInput] = useState('')
  const [grantScopes, setGrantScopes] = useState<string[]>([])

  const load = useCallback(async (): Promise<void> => {
    try {
      const list = scope
        ? await fetchSkills({ scope, member: 'general', includePending: true })
        : await fetchSkills({ scope: null, member: 'general' })
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

  const openGrant = (s: SkillInfo): void => {
    const scopeGrants = s.grants.filter(g => g.startsWith('scope:')).map(g => g.slice('scope:'.length))
    const memberGrants = s.grants.filter(g => !g.startsWith('scope:'))
    setGrantScopes(scope === null ? scopeGrants : scopeGrants.filter(x => x !== scope))
    setGrantsInput(memberGrants.join(', '))
    setShowGrants(s.id)
  }

  const doGrant = async (id: string): Promise<void> => {
    const memberGrants = splitTokens(grantsInput)
    const scopeGrants = grantScopes.map(x => `scope:${x}`)
    const grants = [...scopeGrants, ...memberGrants]
    if (grants.length === 0) {
      toast('err', '请选择目标空间或输入成员 id（授权对象不能为空）')
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

  const doRevoke = async (s: SkillInfo, target: string): Promise<void> => {
    setBusyId(s.id + '|' + target)
    try {
      await revokeSkill(s.id, [target])
      toast('ok', `「${s.id}」已撤销对 ${target} 的授权`)
      void load()
    } catch (e) {
      toast('err', `撤销失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyId(null)
    }
  }

  const isOwn = (s: SkillInfo): boolean => scope === null || s.scope === scope
  const isShared = (s: SkillInfo): boolean => scope !== null && s.scope !== scope
  const pendingCount = skills.filter(s => s.status === 'pending').length
  const grantableSpaces = spaces.filter(sp => sp.id !== scope).map(sp => sp.id)

  return (
    <div className="center-col">
      <div className="panel goal-card">
        <span className="tag" style={{ color: 'var(--muted)', fontSize: 11 }}>🧩 团队共享技能</span>
        <span style={{ fontSize: 12, color: 'var(--text)' }}>
          {scope ? `空间「${scope}」` : '全部空间'}
          <span style={{ color: 'var(--muted-2)', fontSize: 11 }}> · 共 {skills.length} 项{pendingCount > 0 ? ` · ${pendingCount} 项待复审` : ''}</span>
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <button className="btn primary" onClick={() => setShowForm(true)}>＋ 注册新技能</button>
        </span>
      </div>

      {loading ? (
        <div className="scene-loading" style={{ position: 'static', padding: 40 }}>⏳ 正在同步技能库…</div>
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
              {isShared(s) && (
                <div style={{ fontSize: 11, color: 'var(--blue)', padding: '2px 0' }}>
                  🤝 来自空间「{s.scope}」的共享技能（源空间维护 · 此处只读）
                </div>
              )}
              {s.description && <div className="skill-desc">{s.description}</div>}
              {s.prompt && (
                <details className="skill-prompt">
                  <summary>查看 prompt（{s.prompt.length} 字）</summary>
                  <pre>{s.prompt}</pre>
                </details>
              )}
              {s.grants.length > 0 && (
                <div className="skill-grants">
                  <span style={{ color: 'var(--muted-2)', fontSize: 11 }}>已授权：</span>
                  {s.grants.map(g => (
                    <span key={g} className="chip">
                      {g}
                      {isOwn(s) && s.status === 'published' && (
                        <button
                          className="chip-x"
                          title={`撤销对 ${g} 的授权`}
                          disabled={busyId === s.id + '|' + g}
                          onClick={() => void doRevoke(s, g)}
                        >✕</button>
                      )}
                    </span>
                  ))}
                </div>
              )}
              <div className="skill-actions">
                {isOwn(s) && s.status === 'pending' && (
                  <>
                    <button className="btn small ok" disabled={busyId === s.id} onClick={() => void review(s.id, 'publish')}>
                      {busyId === s.id ? '…' : '✅ 发布'}
                    </button>
                    <button className="btn small danger" disabled={busyId === s.id} onClick={() => void review(s.id, 'reject')}>驳回</button>
                  </>
                )}
                {isOwn(s) && s.status === 'published' && (
                  <button className="btn small" disabled={busyId === s.id} onClick={() => openGrant(s)}>🔑 授权</button>
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
              {grantableSpaces.length > 0 && (
                <div className="field">
                  <label>授权目标空间（勾选后士兵在对应空间可直接使用）</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {grantableSpaces.map(sp => (
                      <label key={sp} className="chip" style={{ cursor: 'pointer', userSelect: 'none', background: grantScopes.includes(sp) ? 'var(--blue)' : undefined, color: grantScopes.includes(sp) ? '#fff' : undefined }}>
                        <input type="checkbox" style={{ marginRight: 4, display: 'none' }}
                          checked={grantScopes.includes(sp)}
                          onChange={() => setGrantScopes(cur => (cur.includes(sp) ? cur.filter(x => x !== sp) : [...cur, sp]))}
                        />
                        🏛 {sp}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <div className="field">
                <label>授权成员（可选；成员 id，逗号分隔）</label>
                <input value={grantsInput} onChange={e => setGrantsInput(e.target.value)} placeholder="例如：soldier-a, reviewer-1（或留空只授空间）" />
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
        数据源：team-hub v2（{hubBase()}）· 跨空间授权后，目标空间士兵/守护自动同步已发布技能；撤销即时生效
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
      toast('err', '请填写技能 id（小写字母/数字开头，可含连字符）')
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
