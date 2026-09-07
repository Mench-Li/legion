import { useCallback, useEffect, useState } from 'react'
import { fetchAgents, fetchSkills, grantSkill, hubBase, registerSkill, reviewSkill, revokeSkill } from '../api'
import type { AgentCatalogItem, SkillInfo, SpaceInfo } from '../types'
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

// 技能中心（R-1/S2）：本空间技能 + 跨空间共享。空间视图以 general 复审视角取本 scope 全状态（register→review 流程）；
// 「全部空间」聚合视图不请求 include=pending（服务端收口，仅 published，TC-S2-02/06）。渲染安全（I-5）：纯文本节点。

export function SkillsPanel({ scope, hubMode, spaces = [] }: SkillsPanelProps): React.JSX.Element {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showGrants, setShowGrants] = useState<string | null>(null)
  /** 智能体目录（/api/agents，按 role 去重；供授权智能体搜索/名称标注；失败降级为手输）。 */
  const [catalog, setCatalog] = useState<AgentCatalogItem[] | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  /** 本次授权新增的智能体（存 roster role，如 coder/reviewer——守护以 member=role 查询命中）。 */
  const [newMembers, setNewMembers] = useState<string[]>([])
  const [memberQ, setMemberQ] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
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

  // 智能体目录：面板加载时拉一次（供已授权名称标注 + 授权弹窗搜索下拉；失败降级为手输 id）。
  useEffect(() => {
    let live = true
    fetchAgents()
      .then(list => {
        if (live) setCatalog(list)
      })
      .catch(() => { /* 降级：授权弹窗内提示可直接输入 role/id */ })
      .finally(() => {
        if (live) setCatalogLoading(false)
      })
    return () => {
      live = false
    }
  }, [])

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
    // 授权弹窗只做「新增授权」：当前已授权（空间/智能体）单独只读列出，新目标从空白选择，
    // 避免「取消勾选已授权却并未撤销」的误导。撤销统一走技能卡片上的 ✕。
    setGrantScopes([])
    setNewMembers([])
    setMemberQ('')
    setPickerOpen(false)
    setShowGrants(s.id)
  }

  /** 把 grants 按「空间授权（scope:*）」「智能体授权」分组，便于区分展示与授权弹窗当前态。 */
  const groupGrants = (s: SkillInfo): { space: string[]; member: string[] } => {
    const space: string[] = []
    const member: string[] = []
    for (const g of s.grants) (g.startsWith('scope:') ? space : member).push(g)
    return { space, member }
  }

  /** 智能体目录查找（role 精确命中；用于把 role → 名称展示）。 */
  const agentOf = (role: string): AgentCatalogItem | undefined => catalog?.find(a => a.role === role)
  /** 成员授权展示名：命中目录则 avatar+名称，否则原样（general/自定义 id）。 */
  const memberLabel = (m: string): string => {
    const a = agentOf(m)
    return a ? `${a.avatar} ${a.name}` : m
  }

  /** 添加一个「将授权」的智能体 role（去重；与已在展示里禁选，重复提交服务端幂等）。 */
  const addMember = (role: string): void => {
    setNewMembers(cur => (cur.includes(role) ? cur : [...cur, role]))
    setMemberQ('')
    setPickerOpen(false)
  }

  /** 输入框回车：优先精确 role/名称命中 → 模糊命中第一个 → 否则作为自定义成员 id 加入。 */
  const commitMemberQuery = (): void => {
    const q = memberQ.trim()
    if (!q) return
    const gSkill = skills.find(s => s.id === showGrants) ?? null
    const alreadyMembers = gSkill ? gSkill.grants.filter(g => !g.startsWith('scope:')) : []
    const already = new Set([...alreadyMembers, ...newMembers])
    if (catalog && catalog.length > 0) {
      const exactRole = catalog.find(a => a.role === q)
      const exactName = catalog.find(a => a.name === q)
      const target = exactRole ?? exactName
      if (target) {
        if (already.has(target.role)) {
          toast('err', `智能体「${target.name}」已在授权列表`)
        } else {
          addMember(target.role)
        }
        return
      }
      const ql = q.toLowerCase()
      const fuzzy = catalog.find(a => a.name.toLowerCase().includes(ql) || a.role.toLowerCase().includes(ql) || a.kind.toLowerCase().includes(ql))
      if (fuzzy) {
        if (already.has(fuzzy.role)) {
          toast('err', `智能体「${fuzzy.name}」已在授权列表`)
        } else {
          addMember(fuzzy.role)
        }
        return
      }
    }
    // 无目录/无匹配：按自定义成员 id 直接加入（保留原「soldier-a」式手输能力）
    if (!already.has(q)) addMember(q)
    else toast('err', `「${q}」已在授权列表`)
  }

  const doGrant = async (id: string): Promise<void> => {
    const scopeGrants = grantScopes.map(x => `scope:${x}`)
    const grants = [...scopeGrants, ...newMembers]
    if (grants.length === 0) {
      toast('err', '请选择目标空间或授权智能体（授权对象不能为空）')
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
            <div key={s.id} className={`panel skill-card ${s.status}${isShared(s) ? ' shared' : ''}`}>
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
                <div className="skill-origin">🤝 来自空间「{s.scope}」的共享技能 · 源空间维护 · 此处只读</div>
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
                  <span className="skill-grant-label">已授权：</span>
                  {(() => {
                    const g = groupGrants(s)
                    return (
                      <>
                        {g.space.length > 0 && (
                          <span className="skill-grant-group">
                            <span className="skill-grant-kind">空间</span>
                            {g.space.map(raw => (
                              <span key={raw} className="skill-grant-tag space">
                                🏛 {raw.slice('scope:'.length)}
                                {isOwn(s) && s.status === 'published' && (
                                  <button
                                    className="chip-x"
                                    title="撤销对该空间的授权"
                                    disabled={busyId === s.id + '|' + raw}
                                    onClick={() => void doRevoke(s, raw)}
                                  >✕</button>
                                )}
                              </span>
                            ))}
                          </span>
                        )}
                        {g.member.length > 0 && (
                          <span className="skill-grant-group">
                            <span className="skill-grant-kind">智能体</span>
                            {g.member.map(m => (
                              <span key={m} className="skill-grant-tag member" title={`成员授权：${m}`}>
                                👤 {memberLabel(m)}
                                {isOwn(s) && s.status === 'published' && (
                                  <button
                                    className="chip-x"
                                    title="撤销对该智能体的授权"
                                    disabled={busyId === s.id + '|' + m}
                                    onClick={() => void doRevoke(s, m)}
                                  >✕</button>
                                )}
                              </span>
                            ))}
                          </span>
                        )}
                      </>
                    )
                  })()}
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
      {showGrants && (() => {
        const gSkill = skills.find(s => s.id === showGrants) ?? null
        const already = gSkill ? groupGrants(gSkill) : { space: [], member: [] }
        const alreadyScopes = already.space.map(x => x.slice('scope:'.length))
        const grantableSpaces = spaces.filter(sp => sp.id !== scope && !alreadyScopes.includes(sp.id)).map(sp => sp.id)
        return (
          <div className="modal-mask" onClick={() => setShowGrants(null)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-head">
                🔑 授权技能「{showGrants}」
                <span className="x" onClick={() => setShowGrants(null)}>✕</span>
              </div>
              {!gSkill ? null : (
                <div className="modal-body">
                  {(alreadyScopes.length > 0 || already.member.length > 0) && (
                    <div className="field">
                      <label>当前已授权（只读；撤销请到技能卡片上点 ✕）</label>
                      <div className="skill-grant-group">
                        {alreadyScopes.map(sc => (
                          <span key={sc} className="skill-grant-tag space">🏛 {sc}</span>
                        ))}
                        {already.member.map(m => (
                          <span key={m} className="skill-grant-tag member" title={`成员授权：${m}`}>👤 {memberLabel(m)}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {grantableSpaces.length > 0 && (
                    <div className="field">
                      <label>新授权目标空间（勾选后该空间的士兵可直接使用）</label>
                      <div className="skill-grant-group">
                        {grantableSpaces.map(sp => (
                          <label key={sp} className={`grant-space-pill${grantScopes.includes(sp) ? ' selected' : ''}`}>
                            <input type="checkbox" style={{ display: 'none' }}
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
                    <label>授权智能体（可搜索名称/角色；多选逐个添加。如输入「代码审查」可搜到「代码审查员」）</label>
                    {(() => {
                      const ql = memberQ.trim().toLowerCase()
                      const matched = !catalog
                        ? []
                        : catalog
                            .filter(a => !ql || a.name.toLowerCase().includes(ql) || a.role.toLowerCase().includes(ql) || a.kind.toLowerCase().includes(ql) || a.scopes.some(s => s.toLowerCase().includes(ql)))
                            .slice(0, 8)
                      return (
                        <div className="agent-picker">
                          <input
                            className="agent-picker-input"
                            value={memberQ}
                            autoComplete="off"
                            placeholder={catalogLoading ? '正在加载智能体目录…' : '输入名称/角色搜索，回车添加；也可直接输入自定义成员 id（如 soldier-a）'}
                            onChange={e => setMemberQ(e.target.value)}
                            onFocus={() => setPickerOpen(true)}
                            onBlur={() => window.setTimeout(() => setPickerOpen(false), 160)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                commitMemberQuery()
                              }
                            }}
                          />
                          {pickerOpen && !catalogLoading && (ql.length > 0 || (catalog !== null && catalog.length > 0)) && (
                            <div className="agent-picker-list">
                              {matched.length === 0 ? (
                                <div className="agent-picker-empty">
                                  {ql ? <>无匹配智能体。按回车可添加自定义成员 id「{ql}」</> : '暂无智能体目录'}
                                </div>
                              ) : (
                                matched.map(a => {
                                  const picked = newMembers.includes(a.role) || already.member.includes(a.role)
                                  return (
                                    <button
                                      key={a.role}
                                      type="button"
                                      className={`agent-opt${picked ? ' picked' : ''}`}
                                      onMouseDown={e => {
                                        e.preventDefault() // 先于 blur 触发选择
                                        if (!picked) addMember(a.role)
                                      }}
                                    >
                                      <span className="agent-opt-main">{a.avatar} <b>{a.name}</b> <code>{a.role}</code></span>
                                      <span className="agent-opt-sub">{a.kind}{a.scopes.length > 0 ? ` · 所在空间：${a.scopes.join('、')}` : ''}</span>
                                      <span className="agent-opt-act">{picked ? '✓ 已选' : '＋ 添加'}</span>
                                    </button>
                                  )
                                })
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })()}
                    {newMembers.length > 0 && (
                      <div className="skill-grant-group" style={{ marginTop: 6 }}>
                        {newMembers.map(r => {
                          const a = agentOf(r)
                          return (
                            <span key={r} className="skill-grant-tag member">
                              👤 {a ? `${a.avatar} ${a.name}` : r}
                              {a && <code style={{ fontSize: 9, opacity: 0.75 }}>{r}</code>}
                              <button
                                className="chip-x"
                                title="移除"
                                onClick={() => setNewMembers(cur => cur.filter(x => x !== r))}
                              >✕</button>
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="modal-foot">
                <button className="btn ghost" onClick={() => setShowGrants(null)}>取消</button>
                <button className="btn primary" disabled={busyId === showGrants} onClick={() => void doGrant(showGrants)}>
                  {busyId === showGrants ? '提交中…' : '确认授权'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}
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
