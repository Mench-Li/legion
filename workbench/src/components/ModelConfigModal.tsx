// DSH owns provider configuration and credentials; Legion owns per-space role assignments.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { dshModelsRpc, clearAgentModel, fetchAgentModels, saveAgentModel } from '../api'
import type { DshModelCatalog } from '../api'
import type { AgentModelCfg, RosterAgent } from '../types'
import { toast } from './Toast'
import { ModelProfilesPanel } from './ModelProfilesPanel'
import { ModelBindingsPanel } from './ModelBindingsPanel'
import { DshProvidersPanel } from './DshProvidersPanel'
import { AgentAvatar } from '../avatar'

interface ModelConfigModalProps {
  scope: string
  roster: RosterAgent[] | null
  onClose: () => void
  embedded?: boolean
}

type Tab = 'providers' | 'quick' | 'profiles' | 'bindings'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'providers', label: '供应商与模型' },
  { id: 'quick', label: '⚡ 快速分配' },
  { id: 'profiles', label: '🗂 模型档案' },
  { id: 'bindings', label: '🔗 岗位绑定' },
  // ★★ 2026-10-12：这里原本还有第三个「配置搬家」页签，装着**两件事**：
  //   ① 迁移老配置（PRT-506）、② 导出/导入配置包（PRT-508）。两件都已拆除：
  //     · ① 的产物（岗位绑定）当时没有活的消费者，那批意图已经用一次迁移搬完，
  //       消费者也接上了（`plugins/src/dispatchModel.ts`）；
  //     · ② 在单机部署里没有用处 —— 那 10 条档案 + 17 条绑定本来就在**每一次整库备份**里，
  //       而凭证值从来不在包里（在本机 DPAPI 密钥库），换机器无论如何都要重填。
  //   现在"配置能不能搬"由**备份/恢复**负责（`product/server/backup.mjs`）。
  //   ⇒ 这个弹窗只剩四件事，每件都是这台机器上真实要做的。
  //
  // ★★ 2026-10-12（同上一条的历史之后）：这里最后一个「🔑 凭证库」页签也拆了
  //   （面板文件 `SecretVaultPanel.tsx` 一并删除）。它是 P1 时期的脚手架：
  //   那时「把钥匙写进 DSH」这条线还没接通，钥匙只能在 Legion 里存着、只能让人**看着**，
  //   所以必须先有一页能录入、能看见。
  //   架构决定现在变了 —— 钥匙由用户在**上面第一个「供应商与模型」页填一次**，
  //   Legion 存下来后**写进 DSH（运行时）**，用户**不需要再看见**那个库
  //   （一页看得见却什么也决定不了的凭证列表，只会让人以为钥匙还得自己管）。
  //   ⚠ 删的只是**这一页**，底层存储与后端路由**原样保留**（写入正要用它，
  //     而且 `BUG-029` 的判据住在 `team-hub/secret-routes.test.mjs` 里）。
  //     「密钥库暂时存不进来」这件事仍然要在**填钥匙的那一页**说清（`DshProvidersPanel` 的 `keyStore`）。
]

/** ① 快速分配：原有的 per-agent 角色→模型选择（**行为不变**）。
 *
 *  唯一改动是失败/成功仍然走原有的 `toast` —— 因为这一页的写路径
 *  （`POST /api/models`）返回的就是一句错误，没有结构化字段可渲染。
 *  其余三个面板一律就地渲染具体失败。 */
function QuickAssignTab({ scope, roster }: { scope: string; roster: RosterAgent[] | null }): React.JSX.Element {
  const [cfgs, setCfgs] = useState<Record<string, AgentModelCfg>>({})
  const [busyRole, setBusyRole] = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [catalog, setCatalog] = useState<DshModelCatalog | null>(null)
  const [catalogError, setCatalogError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      const rows = await fetchAgentModels(scope)
      const map: Record<string, AgentModelCfg> = {}
      for (const r of rows) map[r.role] = r
      setCfgs(map)
      setLoadErr(null)
    } catch (e) {
      // **读不出来 ≠ 没有配置**：这里显式说清，而不是渲染成一个"全都是默认"的列表。
      setLoadErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoaded(true)
    }
  }, [scope])

  useEffect(() => {
    void load()
    void dshModelsRpc<DshModelCatalog>('session/modelCatalog').then(value => { setCatalog(value); setCatalogError('') }).catch(e => setCatalogError(e instanceof Error ? e.message : String(e)))
  }, [load])

  const roles = useMemo(
    () => (roster ?? []).filter(a => !a.external && a.scope === scope).map(a => ({ role: a.role, name: a.name, avatar: a.avatar })),
    [roster, scope],
  )

  const apply = async (role: string, provider: string, model: string): Promise<void> => {
    setBusyRole(role)
    try {
      await saveAgentModel(scope, role, provider, model)
      setCfgs(prev => ({ ...prev, [role]: { scope, role, provider, model } }))
    } catch (e) {
      toast('err', e instanceof Error ? e.message : String(e))
    } finally {
      setBusyRole(null)
    }
  }

  const clearRole = async (role: string): Promise<void> => {
    setBusyRole(role)
    try {
      await clearAgentModel(scope, role)
      setCfgs(prev => {
        const next = { ...prev }
        delete next[role]
        return next
      })
      toast('ok', `${role} 已恢复平台默认模型`)
    } catch (e) {
      toast('err', e instanceof Error ? e.message : String(e))
    } finally {
      setBusyRole(null)
    }
  }

  const selected = (role: string): AgentModelCfg | undefined => cfgs[role]

  return (
    <>
      <div className="mc-tip">
        为每个岗位选择已配置的模型。未单独配置的岗位使用平台默认{catalog ? `（${catalog.default.provider} / ${catalog.default.model}）` : '模型'}，下一次 AI 执行该岗位任务时生效。
      </div>
      {loadErr !== null && (
        <div className="set-notice bad">
          <div className="set-notice-title">读不出来这个空间的模型配置 —— 这不等于「全都是平台默认」</div>
          <div className="set-notice-text">{loadErr}</div>
          <div className="set-notice-action">下一步：先确认中枢可达，再重新打开这个窗口；**不要**照着这份看不清的列表重配一遍。</div>
        </div>
      )}
      {catalogError && <div className="set-notice warn">无法读取模型目录：{catalogError} 已保存的岗位配置仍显示在下方；请检查模型服务连接后重试。</div>}
      {loaded && loadErr === null && roles.length === 0 && (
        <div style={{ color: 'var(--muted-2)', fontSize: 12, padding: '14px 0' }}>该空间暂无编队智能体(发布目标或先选具体工作空间)。</div>
      )}
      <div className="mc-list">
        {roles.map(({ role, name, avatar }) => {
          const cfg = selected(role)
          return (
            <div key={role} className="mc-row">
              <div className="mc-agent">
                <span className="agent-avatar"><AgentAvatar token={avatar} /></span>
                <div>
                  <div className="mc-name">{name}</div>
                  <div className="mc-role">{role}</div>
                </div>
              </div>
              <div className="mc-pick">
                <select
                  aria-label={`${name}的模型`}
                  value={cfg ? JSON.stringify([cfg.provider, cfg.model]) : ''}
                  disabled={busyRole === role || !catalog}
                  onChange={e => {
                    if (!e.target.value) { void clearRole(role); return }
                    const [provider, model] = JSON.parse(e.target.value) as [string, string]
                    if (provider && model) void apply(role, provider, model)
                  }}
                >
                  <option value="">⚪ 默认(平台路由)</option>
                  {cfg && !catalog?.groups.some(g => g.id === cfg.provider && g.models.some(m => m.id === cfg.model)) && <option value={JSON.stringify([cfg.provider, cfg.model])}>{cfg.provider} / {cfg.model}（已保存 · 目录未确认）</option>}
                  {catalog?.groups.map(group => <optgroup key={group.id} label={`${group.name}（${group.id}）`}>{group.models.map(model => <option key={model.id} value={JSON.stringify([group.id, model.id])}>{model.name || model.id}</option>)}</optgroup>)}
                </select>
                {cfg && (
                  <button className="btn ghost" style={{ padding: '1px 8px', fontSize: 11 }} onClick={() => void clearRole(role)} title="恢复平台默认">
                    清除
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

export function ModelConfigModal({ scope, roster, onClose, embedded = false }: ModelConfigModalProps): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('providers')
  const roles = useMemo(() => (roster ?? []).map(a => a.role), [roster])

  return (
    <div className={embedded ? 'model-settings-inline' : 'modal-mask'} onClick={embedded ? undefined : onClose}>
      <div className="modal model-config-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          ⚙️ 模型与凭证设置
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted-2)' }}>{scope || '全局配置'}</span>
          {!embedded && <span className="x" onClick={onClose}>✕</span>}
        </div>
        <div className="set-tabs">
          {TABS.map(t => (
            <button key={t.id} className={`set-tab${tab === t.id ? ' on' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {tab === 'providers' && <DshProvidersPanel />}
          {tab === 'quick' && (scope ? <QuickAssignTab scope={scope} roster={roster} /> : <div className="set-notice muted">请在左侧选择具体工作空间，再分配岗位模型。</div>)}
          {tab === 'profiles' && <ModelProfilesPanel />}
          {tab === 'bindings' && (scope ? <ModelBindingsPanel scope={scope} rosterRoles={roles} /> : <div className="set-notice muted">请在左侧选择具体工作空间，再配置岗位绑定。</div>)}
        </div>
      </div>
    </div>
  )
}
