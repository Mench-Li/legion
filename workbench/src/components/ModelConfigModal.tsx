// workbench/src/components/ModelConfigModal.tsx
// ============================================================================
// 模型设置页（PRT-507）——**界面入口**
//
// ## 这个文件此前是什么
//
// 它只有一个硬编码列表（`MODEL_OPTIONS`）+ 一个 per-agent 快捷选择框。
// 而后端早就把六件事做完了：模型档案 CRUD、岗位绑定与 fallback、连通性探测、
// 非敏感配置迁移、配置导入导出、**凭证管理的增删改轮换**——
// `workbench/src/api.ts` 里连一个调用都没有。
//
//   > 功能在、测试在、文档在，**没有入口**。
//   > 而"一个功能没有入口"与"这个功能不存在"，对用户来说是同一件事。
//
// 现在它是一组页签：
//   ① 快速分配 —— **原有的** per-agent 角色→模型 快捷选择（未改动，不许回归）
//   ② 模型档案 —— CRUD + 测试连接（`ModelProfilesPanel`）
//   ③ 岗位绑定 —— `(scope, 岗位) → 主档案 + fallback`（`ModelBindingsPanel`）
//   ④ 配置搬家 —— 迁移 + 导入导出（`ModelTransferPanel`）
//   ⑤ 凭证库   —— 密钥库自检 + 增/轮换/删（`SecretVaultPanel`）
//
// ## 关于 `MODEL_OPTIONS`（它没有被删掉，理由要说清）
//
// 「快速分配」写的是**老的** `POST /api/models`（`{provider, model}` 对），
// 而模型档案是 `{profileId}` 的世界。两者不是同一个东西：
// `MODEL_OPTIONS` 是 DSH 部署的候选清单（来自 settings.yaml），
// 在档案页那条线上**不构成**任何判据。所以它继续留在快捷选择里，
// 而不是被替换成"档案列表"——换掉会把一个能用的下拉框换成一条不同的写路径，
// 而那条路径上"角色 → 档案 id"的绑定由「岗位绑定」页负责。
//
// 每个面板的失败都**就地**渲染（具体到码/字段/下一步），不弹一句通用 toast：
// 后端加了码、前端还是笼统提示，那条码就等于没加。
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import { MODEL_OPTIONS, MODEL_TIER_TEXT, clearAgentModel, fetchAgentModels, saveAgentModel } from '../api'
import type { AgentModelCfg, RosterAgent } from '../types'
import { toast } from './Toast'
import { ModelProfilesPanel } from './ModelProfilesPanel'
import { ModelBindingsPanel } from './ModelBindingsPanel'
import { ModelTransferPanel } from './ModelTransferPanel'
import { SecretVaultPanel } from './SecretVaultPanel'

interface ModelConfigModalProps {
  scope: string
  roster: RosterAgent[] | null
  onClose: () => void
}

const TIER_ORDER = ['light', 'balanced', 'heavy', 'vision'] as const

type Tab = 'quick' | 'profiles' | 'bindings' | 'transfer' | 'secrets'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'quick', label: '⚡ 快速分配' },
  { id: 'profiles', label: '🗂 模型档案' },
  { id: 'bindings', label: '🔗 岗位绑定' },
  { id: 'transfer', label: '📦 配置搬家' },
  { id: 'secrets', label: '🔑 凭证库' },
]

/** ① 快速分配：原有的 per-agent 角色→模型选择（**行为不变**）。
 *
 *  唯一改动是失败/成功仍然走原有的 `toast` —— 因为这一页的写路径
 *  （`POST /api/models`）返回的就是一句错误，没有结构化字段可渲染。
 *  其余四个面板一律就地渲染具体失败。 */
function QuickAssignTab({ scope, roster }: { scope: string; roster: RosterAgent[] | null }): React.JSX.Element {
  const [cfgs, setCfgs] = useState<Record<string, AgentModelCfg>>({})
  const [busyRole, setBusyRole] = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

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
  }, [load])

  const roles = useMemo(
    () => (roster ?? []).map(a => ({ role: a.role, name: a.name, avatar: a.avatar })),
    [roster],
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

  const tiers = useMemo(() => {
    const m: Record<string, { provider: string; model: string; name: string }[]> = { light: [], balanced: [], heavy: [], vision: [] }
    for (const o of MODEL_OPTIONS) m[o.tier].push(o)
    return m
  }, [])

  const selected = (role: string): AgentModelCfg | undefined => cfgs[role]

  return (
    <>
      <div className="mc-tip">
        💡 每个智能体(角色)默认用不同模型:日常/分析/写码用轻量模型省 token,复杂推理/旗舰任务用强模型。未配置的智能体走平台默认(<b>custom-ds / deepseek-v4-flash-openai</b>)。配置在 AI 执行该角色任务时生效。
      </div>
      {loadErr !== null && (
        <div className="set-notice bad">
          <div className="set-notice-title">读不出来这个空间的模型配置 —— 这不等于「全都是平台默认」</div>
          <div className="set-notice-text">{loadErr}</div>
          <div className="set-notice-action">下一步：先确认中枢可达，再重新打开这个窗口；**不要**照着这份看不清的列表重配一遍。</div>
        </div>
      )}
      <div className="mc-legend">
        {TIER_ORDER.map(t => (
          <span key={t} className="mc-tier-hint">{MODEL_TIER_TEXT[t]}</span>
        ))}
      </div>
      {loaded && loadErr === null && roles.length === 0 && (
        <div style={{ color: 'var(--muted-2)', fontSize: 12, padding: '14px 0' }}>该空间暂无编队智能体(发布目标或先选具体工作空间)。</div>
      )}
      <div className="mc-list">
        {roles.map(({ role, name, avatar }) => {
          const cfg = selected(role)
          return (
            <div key={role} className="mc-row">
              <div className="mc-agent">
                <span className="agent-avatar">{avatar}</span>
                <div>
                  <div className="mc-name">{name}</div>
                  <div className="mc-role">{role}</div>
                </div>
              </div>
              <div className="mc-pick">
                <select
                  value={cfg ? `${cfg.provider}/${cfg.model}` : ''}
                  disabled={busyRole === role}
                  onChange={e => {
                    const [provider, model] = e.target.value.split('/', 2)
                    if (provider && model) void apply(role, provider, model)
                  }}
                >
                  <option value="">⚪ 默认(平台路由)</option>
                  {TIER_ORDER.map(t => (
                    <optgroup key={t} label={MODEL_TIER_TEXT[t]}>
                      {tiers[t].map(o => (
                        <option key={`${o.provider}/${o.model}`} value={`${o.provider}/${o.model}`}>
                          {o.name}（{o.provider}）
                        </option>
                      ))}
                    </optgroup>
                  ))}
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

export function ModelConfigModal({ scope, roster, onClose }: ModelConfigModalProps): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('quick')
  const roles = useMemo(() => (roster ?? []).map(a => a.role), [roster])

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal model-config-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          ⚙️ 模型与凭证设置
          <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--muted-2)' }}>{scope}</span>
          <span className="x" onClick={onClose}>✕</span>
        </div>
        <div className="set-tabs">
          {TABS.map(t => (
            <button key={t.id} className={`set-tab${tab === t.id ? ' on' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {tab === 'quick' && <QuickAssignTab scope={scope} roster={roster} />}
          {tab === 'profiles' && <ModelProfilesPanel />}
          {tab === 'bindings' && <ModelBindingsPanel scope={scope} rosterRoles={roles} />}
          {tab === 'transfer' && <ModelTransferPanel />}
          {tab === 'secrets' && <SecretVaultPanel />}
        </div>
      </div>
    </div>
  )
}
