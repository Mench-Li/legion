import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchAgents, fetchSkills, getSkillSource, grantSkill, hubBase, importSkillCandidates, registerSkill, reviewSkill, revokeSkill, saveSkillSource, scanSkillsDir, scanSkillsGithub, syncSkills, type SkillCandidate, type SkillSource, type SkillSyncReport } from '../api'
import type { AgentCatalogItem, SkillBundle, SkillInfo, SkillPart, SpaceInfo } from '../types'
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
  /** 主提示（SKILL.md）。兼容旧 prompt 语义，提交时映射为 bundle.main。 */
  main: string
  config: string
  scripts: SkillPart[]
  cases: SkillPart[]
  scope: string
}

/** 空的多部件表单初值（脚本/案例各一行占位）。 */
function emptyScripts(): SkillPart[] {
  return [{ name: '', content: '' }]
}

/** 从已存在技能构造编辑态表单初值（bundle 兼容旧 prompt）。 */
function formFromSkill(s: SkillInfo): RegisterForm {
  const b: SkillBundle = s.bundle ?? { main: s.prompt ?? '', config: '', scripts: [], cases: [] }
  return {
    id: s.id,
    name: s.name,
    description: s.description ?? '',
    main: b.main ?? '',
    config: b.config ?? '',
    scripts: (b.scripts ?? []).length > 0 ? (b.scripts ?? []) : emptyScripts(),
    cases: (b.cases ?? []).length > 0 ? (b.cases ?? []) : emptyScripts(),
    scope: s.scope,
  }
}

// 技能中心（R-1/S2）：本空间技能 + 跨空间共享。空间视图以 general 复审视角取本 scope 全状态（register→review 流程）；
// 「全部空间」聚合视图不请求 include=pending（服务端收口，仅 published，TC-S2-02/06）。渲染安全（I-5）：纯文本节点。

export function SkillsPanel({ scope, hubMode, spaces = [] }: SkillsPanelProps): React.JSX.Element {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  /** 编辑目标：非 null 表示「编辑已有技能」（预填 + id 只读），null 表示「注册新技能」。 */
  const [editTarget, setEditTarget] = useState<SkillInfo | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showGrants, setShowGrants] = useState<string | null>(null)
  /** 技能安装弹窗（技能仓库：本地目录 / GitHub）。 */
  const [showInstall, setShowInstall] = useState(false)
  const [installMode, setInstallMode] = useState<'dir' | 'github'>('dir')
  const [installPath, setInstallPath] = useState('')
  const [installUrl, setInstallUrl] = useState('')
  const [installLoading, setInstallLoading] = useState(false)
  const [installCandidates, setInstallCandidates] = useState<SkillCandidate[] | null>(null)
  const [installError, setInstallError] = useState('')
  const [installImporting, setInstallImporting] = useState(false)
  /** 技能来源（团队技能仓库）+ 一键拉取同步。 */
  const [source, setSource] = useState<SkillSource | null>(null)
  const [repoUrl, setRepoUrl] = useState('')
  const [repoBranch, setRepoBranch] = useState('')
  const [repoStrategy, setRepoStrategy] = useState<'upgrade' | 'skip'>('upgrade')
  const [repSyncing, setRepoSyncing] = useState(false)
  const [repoReport, setRepoReport] = useState<SkillSyncReport | null>(null)
  const [repoError, setRepoError] = useState('')
  /** 智能体目录（/api/agents，按 role 去重；供授权智能体搜索/名称标注；失败降级为手输）。 */
  const [catalog, setCatalog] = useState<AgentCatalogItem[] | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  /** 本次授权新增的智能体（存 roster role，如 coder/reviewer——守护以 member=role 查询命中）。 */
  const [newMembers, setNewMembers] = useState<string[]>([])
  const [memberQ, setMemberQ] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  /** 两级联动：授权智能体时先按所在空间筛选（null=全部空间）。 */
  const [agentScope, setAgentScope] = useState<string | null>(null)
  /** 下拉固定于视口坐标（浮于弹窗之上，避免被 .modal{overflow:auto} 裁切）；up=向上弹出。 */
  const [pickerPos, setPickerPos] = useState<{ left: number; top: number; width: number; up: boolean; height: number } | null>(null)
  const pickerInputRef = useRef<HTMLInputElement | null>(null)
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

  // 技能来源：进入某空间时读取已绑定的团队技能仓库，回填 url/branch。
  useEffect(() => {
    let live = true
    setSource(null)
    setRepoReport(null)
    setRepoError('')
    if (!scope) { setRepoUrl(''); setRepoBranch(''); return () => { live = false } }
    getSkillSource(scope)
      .then(s => { if (live) { setSource(s); setRepoUrl(s.url); setRepoBranch(s.branch) } })
      .catch(() => { if (live) setRepoError('未能读取技能来源') })
    return () => { live = false }
  }, [scope])

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
    const isEdit = editTarget !== null
    try {
      const res = await registerSkill({
        id: form.id.trim(),
        name: form.name.trim(),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        main: form.main,
        prompt: form.main, // 兼容旧 team-hub（仅读 prompt 时主文本也不丢失；新端 normalizeBundle 优先用 main）
        ...(form.config.trim() ? { config: form.config.trim() } : {}),
        scripts: form.scripts.filter(x => x.content.trim().length > 0).map(x => ({ name: x.name.trim() || x.content.trim().slice(0, 20), content: x.content.trim() })),
        cases: form.cases.filter(x => x.content.trim().length > 0).map(x => ({ name: x.name.trim() || x.content.trim().slice(0, 20), content: x.content.trim() })),
        scope: form.scope.trim() || 'default',
      })
      const v = (res as { task?: { version?: number } })?.task?.version
      toast('ok', isEdit ? `技能已更新（v${v ?? 1}），回到待复审` : `技能已提交（v${v ?? 1}），等待复审发布`)
      setShowForm(false)
      setEditTarget(null)
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
    setPickerPos(null)
    setAgentScope(null) // 默认「全部空间」
    setShowGrants(s.id)
  }

  /** 打开编辑弹窗：预填技能内容，id 只读，提交后 version+1 回待审。 */
  const openEdit = (s: SkillInfo): void => {
    setEditTarget(s)
    setShowForm(true)
  }

  const openInstall = (): void => {
    setInstallMode('dir')
    setInstallPath('')
    setInstallUrl('')
    setInstallCandidates(null)
    setInstallError('')
    setShowInstall(true)
  }

  const closeInstall = (): void => {
    setShowInstall(false)
    setInstallCandidates(null)
    setInstallError('')
  }

  /** 扫描本地目录 / GitHub → 候选列表（不写中枢）。 */
  const runInstallScan = async (): Promise<void> => {
    if (!scope) {
      toast('err', '请在具体空间内安装技能（先进入某空间）')
      return
    }
    setInstallLoading(true)
    setInstallError('')
    setInstallCandidates(null)
    try {
      const cands = installMode === 'dir'
        ? await scanSkillsDir(scope, installPath.trim())
        : (await scanSkillsGithub(scope, installUrl.trim())).candidates
      if (cands.length === 0) {
        toast('err', installMode === 'dir' ? '该目录下没检测到技能（需含 SKILL.md 的文件夹）' : '该仓库内没检测到技能（需含 SKILL.md 的文件夹）')
      }
      setInstallCandidates(cands)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setInstallError(msg)
      toast('err', `扫描失败：${msg}`)
    } finally {
      setInstallLoading(false)
    }
  }

  /** 把选中的候选注册到中枢（→ pending 待复审）。 */
  const runInstallImport = async (): Promise<void> => {
    if (!scope || !installCandidates || installCandidates.length === 0) return
    setInstallImporting(true)
    setInstallError('')
    try {
      const { results } = await importSkillCandidates(scope, installCandidates)
      const failed = results.filter(r => !r.ok)
      if (failed.length === 0) toast('ok', `已导入 ${results.length} 个技能到待复审`)
      else toast('err', `导入 ${results.length - failed.length}/${results.length} 成功；失败 ${failed.map(f => f.id).join('、')}`)
      setInstallCandidates(null)
      setShowInstall(false)
      void load()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setInstallError(msg)
      toast('err', `导入失败：${msg}`)
    } finally {
      setInstallImporting(false)
    }
  }

  /** 一键拉取同步：先存来源，再从技能仓库扫描并按其冲突策略注册/跳过。 */
  const runSync = async (): Promise<void> => {
    if (!scope) {
      toast('err', '请先在具体空间内同步（先进入某空间）')
      return
    }
    if (!repoUrl.trim()) {
      toast('err', '请填写技能来源 GitHub 仓库地址')
      return
    }
    setRepoSyncing(true)
    setRepoError('')
    setRepoReport(null)
    try {
      await saveSkillSource(scope, repoUrl.trim(), repoBranch.trim())
      const out = await syncSkills(scope, repoUrl.trim(), repoBranch.trim(), repoStrategy)
      setRepoReport(out.report)
      setSource(out.source)
      setRepoUrl(out.source.url)
      setRepoBranch(out.source.branch)
      toast('ok', `同步完成：新增 ${out.report.added.length} · 更新 ${out.report.updated.length} · 未变 ${out.report.unchanged.length} · 跳过 ${out.report.skipped.length}`)
      void load()
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      setRepoError(m)
      toast('err', `同步失败：${m}`)
    } finally {
      setRepoSyncing(false)
    }
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

  /** 当前生效的智能体候选池：两级联动——先按所在空间筛（agentScope），再按输入文本搜。 */
  const catalogPool = useCallback((): AgentCatalogItem[] => {
    if (!catalog) return []
    return agentScope ? catalog.filter(a => a.scopes.includes(agentScope)) : catalog
  }, [catalog, agentScope])

  /** 把下拉锚定到输入框的视口坐标（fixed），必要时向上弹出；避免被 .modal 的 overflow 裁切。 */
  const positionPicker = useCallback((): void => {
    const el = pickerInputRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vh = window.innerHeight
    const H_MAX = 280
    const GAP = 6
    const spaceBelow = vh - r.bottom - GAP
    const spaceAbove = r.top - GAP
    // 下方放得下 → 默认向下（输入框保持可见，可继续输入）；下方不足且上方有余 → 向上，但整块置于输入框上方，绝不盖住输入框。
    const up = spaceBelow < 120 && spaceAbove > Math.min(160, H_MAX)
    const height = Math.max(90, Math.min(H_MAX, up ? spaceAbove : spaceBelow))
    const top = up ? r.top - height - GAP : r.bottom + GAP
    setPickerPos({ left: r.left, top, width: r.width, up, height })
  }, [])

  // 下拉打开/状态变化时重新锚定视口坐标（每次渲染后 input 尺寸/位置稳定）。
  useEffect(() => {
    if (pickerOpen) positionPicker()
  }, [pickerOpen, memberQ, agentScope, catalog, positionPicker])

  /** 输入框回车：优先精确 role/名称命中 → 模糊命中第一个 → 否则作为自定义成员 id 加入。 */
  const commitMemberQuery = (): void => {
    const q = memberQ.trim()
    if (!q) return
    const gSkill = skills.find(s => s.id === showGrants) ?? null
    const alreadyMembers = gSkill ? gSkill.grants.filter(g => !g.startsWith('scope:')) : []
    const already = new Set([...alreadyMembers, ...newMembers])
    const pool = catalogPool()
    if (pool.length > 0) {
      const exactRole = pool.find(a => a.role === q)
      const exactName = pool.find(a => a.name === q)
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
      const fuzzy = pool.find(a => a.name.toLowerCase().includes(ql) || a.role.toLowerCase().includes(ql) || a.kind.toLowerCase().includes(ql) || a.scopes.some(s => s.toLowerCase().includes(ql)))
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
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn" onClick={openInstall}>⬇️ 安装技能</button>
          <button className="btn primary" onClick={() => { setEditTarget(null); setShowForm(true) }}>＋ 注册新技能</button>
        </span>
      </div>

      {scope && (
        <div className="panel skill-repo">
          <div className="sr-top">
            <span className="tag" style={{ color: 'var(--muted)', fontSize: 11 }}>📦 技能仓库（团队技能源）</span>
            <span className="sr-hint">{source?.url ? `来源：${source.url}${source.branch ? ` @ ${source.branch}` : ''}` : (repoError || '尚未绑定团队技能来源')}</span>
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <select className="sr-select" value={repoStrategy} onChange={e => setRepoStrategy(e.target.value as 'upgrade' | 'skip')}>
                <option value="upgrade">冲突：升级（版本+1 待审）</option>
                <option value="skip">冲突：跳过（保留已有）</option>
              </select>
              <button className="btn ok" disabled={repSyncing} onClick={() => void runSync()}>{repSyncing ? '同步中…' : '🔄 拉取同步'}</button>
            </span>
          </div>
          <div className="sr-fields">
            <input className="sr-input" value={repoUrl} onChange={e => setRepoUrl(e.target.value)} placeholder="https://github.com/owner/repo（团队技能源仓库）" />
            <input className="sr-input sr-branch" value={repoBranch} onChange={e => setRepoBranch(e.target.value)} placeholder="分支（默认 HEAD）" />
          </div>
          {repoError && <div className="skill-install-error">⚠ {repoError}</div>}
          {repoReport && (
            <div className="sr-report">
              <span className="sr-line ok">新增 {repoReport.added.length}</span>
              <span className="sr-line">更新 {repoReport.updated.length}</span>
              <span className="sr-line">未变 {repoReport.unchanged.length}</span>
              <span className="sr-line">跳过 {repoReport.skipped.length}</span>
              {repoReport.foreign.length > 0 && <span className="sr-line warn">他空间已存在 {repoReport.foreign.length}</span>}
              {[...repoReport.added, ...repoReport.updated].length > 0 && (
                <span className="sr-names">→ {[...repoReport.added, ...repoReport.updated].map(x => x.name).join('、')}</span>
              )}
            </div>
          )}
        </div>
      )}

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
              {(s.bundle?.config?.trim() || s.bundle?.scripts?.length || s.bundle?.cases?.length) && (
                <div className="skill-parts">
                  {s.bundle?.config?.trim() && <span className="skill-part-badge">⚙️ 配置</span>}
                  {!!(s.bundle?.scripts?.length) && <span className="skill-part-badge">🧩 脚本 ×{s.bundle!.scripts.length}</span>}
                  {!!(s.bundle?.cases?.length) && <span className="skill-part-badge">📁 案例 ×{s.bundle!.cases.length}</span>}
                </div>
              )}
              {s.prompt && (
                <details className="skill-prompt">
                  <summary>查看主提示（{s.prompt.length} 字）{s.bundle?.config ? ` · 配置 ${s.bundle.config.length} 字` : ''}</summary>
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
                {isOwn(s) && (
                  <button className="btn small" disabled={busyId === s.id} onClick={() => openEdit(s)}>✏️ 编辑</button>
                )}
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

      {showForm && (
        <SkillForm
          scope={scope}
          edit={editTarget}
          onSubmit={submit}
          onClose={() => { setShowForm(false); setEditTarget(null) }}
        />
      )}
      {showInstall && (
        <div className="modal-mask" onClick={closeInstall}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              ⬇️ 安装技能（技能仓库）
              <span className="x" onClick={closeInstall}>✕</span>
            </div>
            <div className="modal-body">
              <div className="field">
                <div className="skill-install-mode">
                  <span className={`mode-pill${installMode === 'dir' ? ' active' : ''}`} onClick={() => { setInstallMode('dir'); setInstallCandidates(null); setInstallError('') }}>📍 本地目录</span>
                  <span className={`mode-pill${installMode === 'github' ? ' active' : ''}`} onClick={() => { setInstallMode('github'); setInstallCandidates(null); setInstallError('') }}>🐙 GitHub 仓库</span>
                </div>
              </div>
              {installMode === 'dir' ? (
                <div className="field">
                  <label>本地目录路径（相对当前空间工作区，含 SKILL.md 的文件夹=一枚技能）</label>
                  <input value={installPath} onChange={e => setInstallPath(e.target.value)} placeholder="例如：skills/ 或 . （留空=工作区根）" />
                </div>
              ) : (
                <div className="field">
                  <label>GitHub 仓库地址（如 https://github.com/owner/repo，支持 /tree/分支）</label>
                  <input value={installUrl} onChange={e => setInstallUrl(e.target.value)} placeholder="https://github.com/owner/repo" />
                </div>
              )}
              <div className="skill-install-actions">
                <button className="btn primary" disabled={installLoading || installImporting} onClick={() => void runInstallScan()}>
                  {installLoading ? '扫描中…' : '🔎 扫描检测'}
                </button>
                {installCandidates !== null && installCandidates.length > 0 && (
                  <button className="btn ok" disabled={installImporting} onClick={() => void runInstallImport()}>
                    {installImporting ? '导入中…' : `⬆️ 导入选中（注册为待审）`}
                  </button>
                )}
              </div>
              {installError && <div className="skill-install-error">⚠ {installError}</div>}
              {installCandidates !== null && (
                <div className="field">
                  <label>检测到 {installCandidates.length} 个技能（导入后进入待复审，由将军发布）</label>
                  <div className="skill-install-list">
                    {installCandidates.length === 0 ? (
                      <div className="skill-install-empty">未检测到技能：所选位置下没有含 SKILL.md 的文件夹。</div>
                    ) : installCandidates.map(c => (
                      <div key={c.id} className="skill-install-item">
                        <div className="si-main"><b>{c.name}</b> <code>{c.id}</code></div>
                        {c.description && <div className="si-desc">{c.description}</div>}
                        <div className="si-parts">
                          {c.config ? <span className="skill-part-badge">⚙️ 配置</span> : null}
                          {c.scripts.length > 0 && <span className="skill-part-badge">🧩 脚本 ×{c.scripts.length}</span>}
                          {c.cases.length > 0 && <span className="skill-part-badge">📁 案例 ×{c.cases.length}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={closeInstall}>取消</button>
            </div>
          </div>
        </div>
      )}
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
                    <label>授权智能体（先选空间，再在列表中点选；也可直接输入名称/角色快速定位，如「代码审查」）</label>
                    {(() => {
                      // 两级联动第一级：空间筛选（全部空间 + 智能体实际所在空间并集）
                      const allSpaces = Array.from(new Set([
                        ...(catalog ? catalog.flatMap(a => a.scopes) : []),
                        ...spaces.map(s => s.id).filter(Boolean),
                      ])).sort()
                      const ql = memberQ.trim().toLowerCase()
                      const matched = catalogPool()
                        .filter(a => !ql || a.name.toLowerCase().includes(ql) || a.role.toLowerCase().includes(ql) || a.kind.toLowerCase().includes(ql) || a.scopes.some(s => s.toLowerCase().includes(ql)))
                        .slice(0, 8)
                      return (
                        <>
                          {allSpaces.length > 0 && (
                            <div className="agent-space-filter">
                              <span
                                className={`agent-space-pill${agentScope === null ? ' active' : ''}`}
                                onClick={() => setAgentScope(null)}
                              >全部空间</span>
                              {allSpaces.map(sp => (
                                <span
                                  key={sp}
                                  className={`agent-space-pill${agentScope === sp ? ' active' : ''}`}
                                  onClick={() => setAgentScope(sp)}
                                >{sp}</span>
                              ))}
                            </div>
                          )}
                          <div className="agent-picker">
                            <input
                              ref={pickerInputRef}
                              className="agent-picker-input"
                              value={memberQ}
                              autoComplete="off"
                              placeholder={catalogLoading ? '正在加载智能体目录…' : '输入名称/角色搜索，回车添加；也可直接输入自定义成员 id（如 soldier-a）'}
                              onChange={e => setMemberQ(e.target.value)}
                              onFocus={() => { setPickerOpen(true); positionPicker() }}
                              onBlur={() => window.setTimeout(() => setPickerOpen(false), 160)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  commitMemberQuery()
                                }
                              }}
                            />
                            {pickerOpen && !catalogLoading && pickerPos && (ql.length > 0 || matched.length > 0) && (
                              <div
                                className="agent-picker-list fixed"
                                style={{ left: pickerPos.left, top: pickerPos.top, width: pickerPos.width, maxHeight: pickerPos.height }}
                              >
                                {matched.length === 0 ? (
                                  <div className="agent-picker-empty">
                                    {agentScope === null
                                      ? (ql ? <>无匹配智能体。按回车可添加自定义成员 id「{ql}」</> : '暂无智能体目录')
                                      : (ql ? <>空间「{agentScope}」内无匹配智能体。按回车可添加自定义成员 id「{ql}」</> : <>空间「{agentScope}」暂无编队智能体，可切回「全部空间」或直接输入自定义成员 id</>)}
                                  </div>
                                ) : (
                                  matched.map(a => {
                                    const picked = newMembers.includes(a.role) || already.member.includes(a.role)
                                    const scopesTxt = a.scopes.length > 0 ? a.scopes.join('、') : ''
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
                                        <span className="agent-opt-sub">{a.kind}{agentScope === null && scopesTxt ? ` · ${scopesTxt}` : (a.scopes.length > 1 ? ` · 亦在 ${a.scopes.filter(s => s !== agentScope).join('、')}` : '')}</span>
                                        <span className="agent-opt-act">{picked ? '✓ 已选' : '＋ 添加'}</span>
                                      </button>
                                    )
                                  })
                                )}
                              </div>
                            )}
                          </div>
                        </>
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

function SkillForm({ scope, edit, onSubmit, onClose }: {
  scope: string | null
  edit: SkillInfo | null
  onSubmit: (form: RegisterForm) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const isEdit = edit !== null
  const [form, setForm] = useState<RegisterForm>(() =>
    edit
      ? formFromSkill(edit)
      : { id: '', name: '', description: '', main: '', config: '', scripts: emptyScripts(), cases: emptyScripts(), scope: scope ?? 'default' },
  )
  const [busy, setBusy] = useState(false)
  const set = (k: 'id' | 'name' | 'description' | 'main' | 'config' | 'scope', v: string): void => setForm(f => ({ ...f, [k]: v }))
  const setParts = (k: 'scripts' | 'cases', next: SkillPart[]): void => setForm(f => ({ ...f, [k]: next }))
  const onParts = (k: 'scripts' | 'cases', idx: number, patch: Partial<SkillPart>): void =>
    setParts(k, form[k].map((p, i) => (i === idx ? { ...p, ...patch } : p)))
  const addPart = (k: 'scripts' | 'cases'): void => setParts(k, [...form[k], { name: '', content: '' }])

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
          {isEdit ? `✏️ 编辑技能「${edit!.name}」` : '＋ 注册新技能'}
          <span className="x" onClick={onClose}>✕</span>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>技能 id *（小写字母/数字开头，可含连字符；编辑态不可改）</label>
            <input
              value={form.id}
              onChange={e => set('id', e.target.value)}
              placeholder="例如：code-review-checklist"
              autoFocus={!isEdit}
              disabled={isEdit}
              style={isEdit ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}
            />
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
            <label>SKILL.md 主提示 *（士兵实际使用的主指引；主线必须遵守）</label>
            <textarea
              className="mono"
              value={form.main}
              onChange={e => set('main', e.target.value)}
              placeholder="详细的操作步骤、检查项、输出格式…（这是主要注入给模型的主技能正文）"
            />
          </div>
          <div className="field">
            <label>config.yaml 配置（可选，YAML 文本）</label>
            <textarea
              className="mono"
              value={form.config}
              onChange={e => set('config', e.target.value)}
              placeholder={[
                '# 可选：技能配置 / 元信息',
                'name: code-review-checklist',
                'version: 1',
                'tags: [review, quality]',
              ].join('\n')}
            />
          </div>
          <SkillPartsEditor
            title="脚本 scripts（可选；名称 + 代码/内容）"
            items={form.scripts}
            addLabel="＋ 添加脚本"
            onChange={next => setParts('scripts', next)}
            onOne={(idx, patch) => onParts('scripts', idx, patch)}
            onAdd={() => addPart('scripts')}
          />
          <SkillPartsEditor
            title="案例 examples（可选；名称 + 示例/案例内容）"
            items={form.cases}
            addLabel="＋ 添加案例"
            onChange={next => setParts('cases', next)}
            onOne={(idx, patch) => onParts('cases', idx, patch)}
            onAdd={() => addPart('cases')}
          />
          <div className="field">
            <label>所属空间（scope）</label>
            <input value={form.scope} onChange={e => set('scope', e.target.value)} placeholder="default" />
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '提交中…' : isEdit ? '提交改版（回待审）' : '提交（待复审）'}
          </button>
        </div>
      </div>
    </div>
  )
}

function SkillPartsEditor({ title, items, addLabel, onChange, onOne, onAdd }: {
  title: string
  items: SkillPart[]
  addLabel: string
  onChange: (next: SkillPart[]) => void
  onOne: (idx: number, patch: Partial<SkillPart>) => void
  onAdd: () => void
}): React.JSX.Element {
  return (
    <div className="field">
      <label>{title}</label>
      <div className="part-editor">
        {items.map((p, i) => (
          <div className="part-row" key={i}>
            <input
              className="part-name"
              value={p.name}
              placeholder="名称（如 fetch_listings.py / 代码审查示例）"
              onChange={e => onOne(i, { name: e.target.value })}
            />
            <textarea
              className="part-content mono"
              value={p.content}
              placeholder="该部件的内容 / 代码 / 案例正文"
              onChange={e => onOne(i, { content: e.target.value })}
            />
            <button className="btn small ghost" title="删除该部件" onClick={() => onChange(items.filter((_, x) => x !== i))}>✕</button>
          </div>
        ))}
        <button className="btn small" onClick={onAdd}>{addLabel}</button>
      </div>
    </div>
  )
}
