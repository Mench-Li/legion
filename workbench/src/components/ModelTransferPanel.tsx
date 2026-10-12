// workbench/src/components/ModelTransferPanel.tsx
// ============================================================================
// 「配置包」面板：导出 / 导入模型档案与岗位绑定（PRT-508）
//
// ## 2026-10-12：另一半（「配置迁移」，PRT-506）被删掉了
//
// 曾经这里有**两件事**：① 把老表 `agent_models` 迁成模型档案 + 岗位绑定；
// ② 导出/导入配置包。① 被删了，理由不是"没人用"，而是**它做的那件事没有下游**：
//
//   · 迁移的产物是 `employee_model_bindings` 的行，而那张表当时**没有任何活的消费者**
//     （`plugins/src/**` 里 0 处引用，`run_attempts` 0 行）⇒ 搬完 17 行不改变任何行为；
//   · 而那 17 行**真实意图**已经用一次迁移搬完，消费者也接上了
//     （`plugins/src/dispatchModel.ts`：守护派工前按 (空间, 岗位) 读绑定）。
//
//   > 一座通往还没建好的房间的桥，
//   > 在房间建好、并且已经走过一次之后，就是**脚手架**。
//
// 所以这个面板只剩 ②：它服务的是"换一台机器"（导出 → 在另一台导入），
// 而**导出物永远不含密钥，也不含引用名**（契约层强制，见下面的说明）。
//
// ## 产品纪律：先预演、再执行
//
//   · `plan` 什么都不写；
//   · `apply` 只写计划里 create/update 的那些，**不删除**包里没有的档案
//     （否则一份不完整的包会清空这台机器）。
//
// 三处必须分开渲染的东西（合并任何两个都会让用户做错事）：
//   ① 「包里没有需要变更的内容」≠「包不合法」；
//   ② `keptLocal`（策略 keep 下被跳过）≠ `conflicts`——只报 conflicts 时，
//      keep 策略看起来是"零冲突、全成功"，而实际一条都没导入；
//   ③ 「预演失败」≠「执行失败」——前者的下一步是改包，后者是看服务端状态。
// ============================================================================

import { useState } from 'react'
import { applyConfigBundle, fetchConfigBundle, planConfigBundle } from '../api'
import { bundlePlanView, panelErrorFrom } from '../modelSettingsUi'
import type { BundlePlanView, PanelError } from '../modelSettingsUi'
import { Notice } from './settingsBits'

const ACTOR = 'general'

type Policy = 'fail' | 'skip' | 'overwrite'
type Kind = 'full' | 'model-profiles' | 'model-bindings'

export function ModelTransferPanel(): React.JSX.Element {
  const [kind, setKind] = useState<Kind>('full')
  const [exported, setExported] = useState<string>('')
  const [exportErr, setExportErr] = useState<PanelError | null>(null)
  const [draft, setDraft] = useState('')
  const [draftErr, setDraftErr] = useState<string | null>(null)
  const [policy, setPolicy] = useState<Policy>('fail')
  const [bundleView, setBundleView] = useState<BundlePlanView | null>(null)
  const [bundleErr, setBundleErr] = useState<PanelError | null>(null)
  const [bundleResult, setBundleResult] = useState<{ tone: 'ok' | 'bad'; title: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

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
        💡 换机器用：在这一台**导出**，到那一台**导入**。导入也**先预演、再执行** ——
        预演只读，执行时只写计划里那些，**不会删除**本机多出来的东西。
      </div>

      <div className="set-section">
        <div className="set-form-title">① 导出配置包</div>
        <div className="mc-legend">
          导出物**永远不含密钥，也不含 `secretRef`**（契约层强制）：`credentialRequired` 只说"这条档案需要凭证"，
          不说"从哪台机器的哪个槽位取"——后者跨机器没有意义。所以到新机器上要**重新填一次密钥**，
          这是**有意**的代价：少一次点击，换"跨机器导入时不会悄悄接上一把无关的钥匙"。
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
        <div className="set-form-title">② 导入配置包</div>
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
