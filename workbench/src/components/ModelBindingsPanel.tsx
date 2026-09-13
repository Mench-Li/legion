// workbench/src/components/ModelBindingsPanel.tsx
// ============================================================================
// 岗位绑定面板（PRT-502 的界面一半）
//
// `(scope, 岗位) → 主档案 + fallback 链`。
//
// 这一面板存在的意义由后端的一条纪律决定（`server.mjs` 的绑定路由注释）：
// **写入时就要验主档案能解析**——等到运行时才发现 `primaryProfile` 打错了，
// 那次运行已经认领了任务、烧掉一次尝试，而错误出现在运行日志里，
// 不是在"保存配置"这个动作上。所以这个界面上的每一次保存都必须把
// 服务端的拒绝**原样**显示出来（409 `PRIMARY_UNRESOLVED` 等），
// 而不是一句"保存失败"。
//
// 另外两处具体的读法：
//   · 「这个岗位没有绑定」是 **404**（不是空链），与"绑定了但主档案被删了"不同；
//   · fallback 链里**被跳过的候选**也要显示并带上原因，
//     只显示能用的会让用户以为链条比实际短（`chainView`）。
// ============================================================================

import { useCallback, useEffect, useState } from 'react'
import { deleteModelBinding, fetchModelBindings, fetchModelProfiles, resolveModelBinding, saveModelBinding } from '../api'
import type { HubModelBinding, HubModelProfile } from '../api'
import { profileRowView } from '../modelSettings'
import { collectionView, failedState, loadingState, panelErrorFrom, readyState, resolutionView } from '../modelSettingsUi'
import type { AsyncState, CollectionCopy, PanelError, ResolutionView } from '../modelSettingsUi'
import { Notice, StateBox } from './settingsBits'

const ACTOR = 'general'

const COPY_BINDINGS: CollectionCopy = {
  noun: '岗位绑定',
  emptyHint: '这个空间还没有任何岗位绑定：所有岗位都走平台默认路由。用下面的表单绑第一条。',
  readFailedHint: '这不代表"没有绑定"：中枢这一趟没答上来，此时不要照着重绑一遍。',
}

export function ModelBindingsPanel({ scope, rosterRoles }: { scope: string; rosterRoles: readonly string[] }): React.JSX.Element {
  const [list, setList] = useState<AsyncState<HubModelBinding[]>>(loadingState())
  const [profiles, setProfiles] = useState<AsyncState<HubModelProfile[]>>(loadingState())
  const [role, setRole] = useState('')
  const [primary, setPrimary] = useState('')
  const [fallbacks, setFallbacks] = useState('')
  const [err, setErr] = useState<PanelError | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [resolved, setResolved] = useState<Record<string, ResolutionView & { failed: string | null }>>({})

  const load = useCallback(async (): Promise<void> => {
    setList(loadingState())
    setProfiles(loadingState())
    try {
      setList(readyState(await fetchModelBindings(scope)))
    } catch (e) {
      setList(failedState(e))
    }
    try {
      setProfiles(readyState(await fetchModelProfiles()))
    } catch (e) {
      setProfiles(failedState(e))
    }
  }, [scope])

  useEffect(() => { void load() }, [load])

  const save = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    setOk(null)
    try {
      await saveModelBinding({
        scope,
        employeeRole: role.trim(),
        primaryProfile: primary,
        // 逗号/顿号分隔都认；空串过滤掉，**不去猜**用户想要哪一条。
        fallbackProfiles: fallbacks.split(/[,，、\s]+/).map(s => s.trim()).filter(s => s !== ''),
        actor: ACTOR,
      })
      setOk(`已保存 ${scope} / ${role.trim()} 的绑定。`)
      setRole('')
      setPrimary('')
      setFallbacks('')
      await load()
    } catch (e) {
      setErr(panelErrorFrom(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (b: HubModelBinding): Promise<void> => {
    setBusy(true)
    setErr(null)
    setOk(null)
    try {
      await deleteModelBinding(b.scope, b.employeeRole, ACTOR)
      setOk(`已删除 ${b.scope} / ${b.employeeRole} 的绑定：这个岗位回到平台默认路由。`)
      await load()
    } catch (e) {
      setErr(panelErrorFrom(e))
    } finally {
      setBusy(false)
    }
  }

  const resolve = async (b: HubModelBinding): Promise<void> => {
    const key = `${b.scope}/${b.employeeRole}`
    try {
      const res = await resolveModelBinding(b.scope, b.employeeRole) as { resolution?: unknown }
      // 形状适配在 `resolutionView` 里（真实字段是 `id`/`message`，不是 `profileId`/`reason`）——
      // 直接把 `chain` 丢给 `chainView` 会让每一项都渲染成「（未知档案）」。
      setResolved(prev => ({ ...prev, [key]: { ...resolutionView(res.resolution), failed: null } }))
    } catch (e) {
      const p = panelErrorFrom(e)
      setResolved(prev => ({
        ...prev,
        [key]: {
          ok: false, code: p.code, message: null, entries: [],
          failed: `${p.text}${p.code === null ? '' : `（${p.code}）`}`,
        },
      }))
    }
  }

  const knownRoles = rosterRoles

  return (
    <div className="set-panel">
      <div className="mc-tip">
        💡 绑定 = 「这个空间里这个岗位**依次**用哪些模型」。主档案在保存时就会被解析：解析不出来服务端直接拒绝，
        不会留下一条要到运行时才爆炸的绑定。
      </div>

      <StateBox view={collectionView(list, COPY_BINDINGS)} onRetry={() => void load()} />

      {list.kind === 'ready' && list.data.map(b => {
        const key = `${b.scope}/${b.employeeRole}`
        const r = resolved[key]
        return (
          <div key={key} className="set-card">
            <div className="set-card-head">
              <span className="mc-name">{b.employeeRole}</span>
              <span className="chip muted">{b.scope}</span>
            </div>
            <div className="set-card-sub">主档案：{b.primaryProfile}</div>
            <div className="set-card-sub">
              fallback：{b.fallbackProfiles.length === 0 ? '（没有备用）' : b.fallbackProfiles.join(' → ')}
            </div>
            {r !== undefined && (
              <div className="set-card-detail">
                {r.failed !== null && <div>解析失败：{r.failed}</div>}
                {r.failed === null && r.ok !== true && (
                  <div>
                    ⛔ 这条绑定现在**跑不起来**：{r.message ?? '服务端没有说明原因'}
                    {r.code === null ? '' : `（${r.code}）`}
                  </div>
                )}
                {r.failed === null && r.entries.map(c => (
                  <div key={c.index}>
                    {c.role === 'unusable' ? '⛔' : c.role === 'primary' ? '①' : '↳'} {c.label}
                    {c.note === null ? '' : ` —— ${c.note}`}
                  </div>
                ))}
              </div>
            )}
            <div className="set-card-actions">
              <button className="btn small" onClick={() => void resolve(b)}>看解析链</button>
              <button className="btn small danger" disabled={busy} onClick={() => void remove(b)}>删除绑定</button>
            </div>
          </div>
        )
      })}

      {profiles.kind === 'failed' && (
        <Notice
          tone="bad"
          title="读不出来模型档案 —— 这不等于「还没有档案」"
          text={`${profiles.error.text}${profiles.error.code === null ? '' : ` 服务端码：${profiles.error.code}`}`}
          action="没有档案列表也可以手动填档案 id，但填错会被服务端以 409 PRIMARY_UNRESOLVED 拒绝。"
        />
      )}
      {profiles.kind === 'ready' && profiles.data.length === 0 && (
        <Notice tone="muted" title="还没有模型档案" text="先去「模型档案」页建一条，再来绑定——服务端拒绝绑定一条解析不出来的主档案。" />
      )}

      <div className="set-form">
        <div className="set-form-title">绑定岗位（空间 {scope}）</div>
        <div className="set-grid">
          <label className="field"><span>岗位 role</span>
            <input className={err?.field === 'employeeRole' ? 'set-input invalid' : 'set-input'} list="set-role-options"
              value={role} onChange={e => setRole(e.target.value)} placeholder="例如 reviewer" />
            <datalist id="set-role-options">
              {knownRoles.map(r => <option key={r} value={r} />)}
            </datalist>
          </label>
          <label className="field"><span>主档案</span>
            <select className={err?.field === 'primaryProfile' ? 'set-input invalid' : 'set-input'} value={primary} onChange={e => setPrimary(e.target.value)}>
              <option value="">（请选择）</option>
              {profiles.kind === 'ready' && profiles.data.map(p => (
                <option key={p.id} value={p.id}>{profileRowView(p).title}（{p.id}）</option>
              ))}
            </select>
          </label>
          <label className="field"><span>fallback（逗号分隔，可空）</span>
            <input className={err?.field === 'fallbackProfiles' ? 'set-input invalid' : 'set-input'}
              value={fallbacks} onChange={e => setFallbacks(e.target.value)} placeholder="p2, p3" />
          </label>
        </div>
        {err !== null && (
          <Notice tone="bad" title="保存绑定失败" text={err.text} action={err.hint} field={err.field}
            lines={err.candidates.length > 0 ? [`服务端给的候选：${err.candidates.join('、')}`] : []} />
        )}
        <div className="set-row-space">
          <button className="btn primary" disabled={busy || role.trim() === '' || primary === ''} onClick={() => void save()}>
            {busy ? '提交中…' : '保存绑定'}
          </button>
        </div>
      </div>

      {ok !== null && <Notice tone="ok" title={ok} />}
    </div>
  )
}
