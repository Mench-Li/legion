// workbench/src/components/ModelTransferPanel.tsx
// ============================================================================
// 「配置搬家」面板：迁移老配置（PRT-506）+ 配置包导入导出（PRT-508）
//
// 两件事放在一起，是因为它们共用同一条产品纪律：
// **先预演、再执行**，而且执行时要回传"用户看过的那一份"的凭证。
//
//   · 迁移：`plan` 是只读的；`apply` 必须回传用户确认过的 `expectedDigest`，
//     服务端会重新算一遍并要求两者一致，不一致报 409 `MIGRATION_PLAN_STALE`。
//     不回传就等于"执行一份用户可能没看过的计划"。
//   · 导入：`plan` 什么都不写；`apply` 只写计划里 create/update 的那些，
//     **不删除**包里没有的档案（否则一份不完整的包会清空这台机器）。
//
// 三处必须分开渲染的东西（合并任何两个都会让用户做错事）：
//   ① 「包里没有需要变更的内容」≠「包不合法」；
//   ② `keptLocal`（策略 keep 下被跳过）≠ `conflicts`——只报 conflicts 时，
//      keep 策略看起来是"零冲突、全成功"，而实际一条都没导入；
//   ③ 「预演失败」≠「执行失败」——前者的下一步是改包，后者是看服务端状态。
// ============================================================================

import { useState } from 'react'
import { applyConfigBundle, applyMigration, fetchConfigBundle, fetchMigrationPlan, planConfigBundle } from '../api'
import type { HubMigrationPlan } from '../api'
import { bundlePlanView, migrationPlanView, panelErrorFrom } from '../modelSettingsUi'
import type { BundlePlanView, PanelError } from '../modelSettingsUi'
import type { ImportPlanView } from '../modelSettings'
import { Notice } from './settingsBits'

const ACTOR = 'general'

type Policy = 'fail' | 'skip' | 'overwrite'
type Kind = 'full' | 'model-profiles' | 'model-bindings'

export function ModelTransferPanel(): React.JSX.Element {
  // ── 迁移 ──
  const [runtimeType, setRuntimeType] = useState('')
  const [plan, setPlan] = useState<{ plan: HubMigrationPlan; summary: string; legacyRowCount: number } | null>(null)
  const [planView, setPlanView] = useState<ImportPlanView | null>(null)
  const [planErr, setPlanErr] = useState<PanelError | null>(null)
  const [applyMsg, setApplyMsg] = useState<{ tone: 'ok' | 'bad'; title: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  // ── 配置包 ──
  const [kind, setKind] = useState<Kind>('full')
  const [exported, setExported] = useState<string>('')
  const [exportErr, setExportErr] = useState<PanelError | null>(null)
  const [draft, setDraft] = useState('')
  const [draftErr, setDraftErr] = useState<string | null>(null)
  const [policy, setPolicy] = useState<Policy>('fail')
  const [bundleView, setBundleView] = useState<BundlePlanView | null>(null)
  const [bundleErr, setBundleErr] = useState<PanelError | null>(null)
  const [bundleResult, setBundleResult] = useState<{ tone: 'ok' | 'bad'; title: string; text: string } | null>(null)

  const runPlan = async (): Promise<void> => {
    setBusy(true)
    setPlanErr(null)
    setApplyMsg(null)
    setPlan(null)
    setPlanView(null)
    try {
      const r = await fetchMigrationPlan(runtimeType.trim() === '' ? undefined : runtimeType.trim())
      setPlan(r)
      // 形状适配 + 判定都在 `modelSettingsUi.migrationPlanView`（复用 importPlanView）。
      setPlanView(migrationPlanView(r.plan))
    } catch (e) {
      setPlanErr(panelErrorFrom(e))
    } finally {
      setBusy(false)
    }
  }

  const runApply = async (): Promise<void> => {
    if (plan === null) return
    const rt = runtimeType.trim()
    if (rt === '') {
      // 只有"协议已选"时才可能走到这里（服务端对缺协议的计划回 `ok:false`，
      // 那种计划根本不会渲染出执行按钮）。仍然显式拦住，不猜协议。
      setApplyMsg({ tone: 'bad', title: '不能执行迁移', text: '还没有选协议（runtimeType）：源数据里没有它，猜一个会让档案看起来配好了直到第一次运行。' })
      return
    }
    setBusy(true)
    setApplyMsg(null)
    try {
      const r = await applyMigration({
        runtimeType: rt,
        // **必须**回传用户确认过的指纹。不回传＝执行一份可能用户没看过的计划。
        expectedDigest: plan.plan.digest,
        actor: ACTOR,
      })
      setApplyMsg({ tone: 'ok', title: '迁移已执行', text: JSON.stringify(r).slice(0, 400) })
      setPlan(null)
      setPlanView(null)
    } catch (e) {
      const p = panelErrorFrom(e)
      setApplyMsg({
        tone: 'bad',
        title: '迁移执行失败',
        text: `${p.text}${p.code === null ? '' : ` 服务端码：${p.code}`}${p.hint === null ? '' : ` ${p.hint}`}`,
      })
    } finally {
      setBusy(false)
    }
  }

  const doExport = async (): Promise<void> => {
    setExportErr(null)
    setExported('')
    try {
      const r = await fetchConfigBundle(kind)
      const body = (r ?? {}) as { bundle?: unknown }
      setExported(JSON.stringify(body.bundle ?? body, null, 2))
    } catch (e) {
      // 导出被拒（配置里混进了密钥形态）是 400 + 码 + hits，**不是**"服务端出错"。
      setExportErr(panelErrorFrom(e))
    }
  }

  const parseDraft = (): unknown | null => {
    if (draft.trim() === '') {
      setDraftErr('先把配置包粘贴进来（或先点「导出当前配置」再复制）。')
      return null
    }
    try {
      const parsed: unknown = JSON.parse(draft)
      setDraftErr(null)
      return parsed
    } catch (e) {
      // JSON 解析失败与"包不合法"是两件事：前者根本没到服务端。
      setDraftErr(`这不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  const runBundlePlan = async (): Promise<void> => {
    const parsed = parseDraft()
    if (parsed === null) return
    setBusy(true)
    setBundleErr(null)
    setBundleResult(null)
    setBundleView(null)
    try {
      const r = await planConfigBundle(parsed, policy, ACTOR) as { plan?: unknown; applicable?: unknown }
      setBundleView(bundlePlanView(r.plan, r.applicable))
    } catch (e) {
      setBundleErr(panelErrorFrom(e))
    } finally {
      setBusy(false)
    }
  }

  const runBundleApply = async (): Promise<void> => {
    const parsed = parseDraft()
    if (parsed === null) return
    setBusy(true)
    setBundleResult(null)
    try {
      const r = await applyConfigBundle(parsed, policy, ACTOR)
      setBundleResult({ tone: 'ok', title: '导入已执行', text: JSON.stringify(r).slice(0, 400) })
    } catch (e) {
      const p = panelErrorFrom(e)
      setBundleResult({
        tone: 'bad',
        title: '导入执行失败',
        text: `${p.text}${p.code === null ? '' : ` 服务端码：${p.code}`}${p.hint === null ? '' : ` ${p.hint}`}`,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="set-panel">
      <div className="mc-tip">
        💡 两件事都**先预演、再执行**。执行时会回传"你看过的那一份"的指纹；中间源数据变了，
        服务端会以 409 拒绝，而不是按一份可能已经过期的计划动手。
      </div>

      <div className="set-section">
        <div className="set-form-title">① 迁移老配置（`agent_models` 表 → 模型档案 + 岗位绑定）</div>
        <div className="mc-legend">
          它**只增不改**：已存在的档案与绑定一律跳过。协议（runtimeType）**必须选**：源数据里没有它，猜错会让档案看起来配好了直到第一次运行。
        </div>
        <div className="set-row-space">
          <input className="set-input" value={runtimeType} onChange={e => setRuntimeType(e.target.value)}
            placeholder="runtimeType，例如 openai-compatible（留空 = 让服务端告诉你要选一种）" style={{ minWidth: 360 }} />
          <button className="btn" disabled={busy} onClick={() => void runPlan()}>预演迁移</button>
        </div>

        {planErr !== null && (
          <Notice tone="bad" title="预演失败（不是「没有需要迁移的东西」）" text={planErr.text} action={planErr.hint} field={planErr.field} />
        )}

        {plan !== null && planView !== null && (
          <Notice
            tone={planView.ok ? 'ok' : 'warn'}
            title={plan.summary}
            text={`源数据 ${plan.legacyRowCount} 行。`}
            lines={planView.lines}
            action={planView.blocked}
          />
        )}
        {plan !== null && planView !== null && planView.ok && planView.needsConfirm && (
          <div className="set-row-space">
            <button className="btn primary" disabled={busy} onClick={() => void runApply()}>确认并执行迁移</button>
            <span className="mc-legend">指纹：{plan.plan.digest}</span>
          </div>
        )}
        {applyMsg !== null && <Notice tone={applyMsg.tone} title={applyMsg.title} text={applyMsg.text} />}
      </div>

      <div className="set-section">
        <div className="set-form-title">② 导出配置包</div>
        <div className="mc-legend">
          导出物**永远不含密钥，也不含 `secretRef`**（契约层强制）：`credentialRequired` 只说"这条档案需要凭证"，
          不说"从哪台机器的哪个槽位取"——后者跨机器没有意义。
        </div>
        <div className="set-row-space">
          <select className="set-input" value={kind} onChange={e => setKind(e.target.value as Kind)}>
            <option value="full">全部</option>
            <option value="model-profiles">只有模型档案</option>
            <option value="model-bindings">只有岗位绑定</option>
          </select>
          <button className="btn" onClick={() => void doExport()}>导出</button>
          {exported !== '' && (
            <button className="btn small" onClick={() => setDraft(exported)}>填入下面的导入框</button>
          )}
        </div>
        {exportErr !== null && (
          <Notice tone="bad" title="导出被拒绝（这是配置本身的问题，不是服务端出错）" text={exportErr.text} action={exportErr.hint} field={exportErr.field} />
        )}
        {exported !== '' && <textarea className="set-textarea" readOnly value={exported} rows={6} />}
      </div>

      <div className="set-section">
        <div className="set-form-title">③ 导入配置包</div>
        <div className="mc-legend">
          导入**不会删除**包里没有的档案：一份不完整的包（比如只导出一条做灰度）不该清空这台机器。
          `fail` 遇到冲突就拒绝；`skip` 保留本机；`overwrite` 用包里那份覆盖。
        </div>
        <textarea className="set-textarea" value={draft} onChange={e => setDraft(e.target.value)} rows={6}
          placeholder="把导出的 JSON 粘贴到这里" />
        <div className="set-row-space">
          <select className="set-input" value={policy} onChange={e => setPolicy(e.target.value as Policy)}>
            <option value="fail">冲突策略：fail（拒绝）</option>
            <option value="skip">冲突策略：skip（保留本机）</option>
            <option value="overwrite">冲突策略：overwrite（覆盖本机）</option>
          </select>
          <button className="btn" disabled={busy} onClick={() => void runBundlePlan()}>预演导入</button>
          <button className="btn primary" disabled={busy || bundleView === null || !bundleView.applicable} onClick={() => void runBundleApply()}>执行导入</button>
        </div>
        {draftErr !== null && <Notice tone="bad" title="还到不了服务端" text={draftErr} />}
        {bundleErr !== null && (
          <Notice tone="bad" title="预演失败（不是「包是空的」）" text={bundleErr.text} action={bundleErr.hint} field={bundleErr.field} />
        )}
        {bundleView !== null && (
          <Notice
            tone={bundleView.applicable ? 'ok' : 'warn'}
            title={bundleView.headline}
            lines={bundleView.lines}
            action={bundleView.blocked}
          />
        )}
        {bundleResult !== null && <Notice tone={bundleResult.tone} title={bundleResult.title} text={bundleResult.text} />}
      </div>
    </div>
  )
}
