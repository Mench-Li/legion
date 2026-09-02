import { useCallback, useEffect, useMemo, useState } from 'react'
import { MODEL_OPTIONS, MODEL_TIER_TEXT, clearAgentModel, fetchAgentModels, saveAgentModel } from '../api'
import type { AgentModelCfg, RosterAgent } from '../types'
import { toast } from './Toast'

interface ModelConfigModalProps {
  scope: string
  roster: RosterAgent[] | null
  onClose: () => void
}

const TIER_ORDER = ['light', 'balanced', 'heavy', 'vision'] as const

export function ModelConfigModal({ scope, roster, onClose }: ModelConfigModalProps): React.JSX.Element {
  const [cfgs, setCfgs] = useState<Record<string, AgentModelCfg>>({})
  const [busyRole, setBusyRole] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const rows = await fetchAgentModels(scope)
      const map: Record<string, AgentModelCfg> = {}
      for (const r of rows) map[r.role] = r
      setCfgs(map)
    } catch (e) {
      toast('err', e instanceof Error ? e.message : String(e))
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
    <div className="modal-mask" onClick={onClose}>
      <div className="modal model-config-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          ⚙️ 模型 × 智能体配置
          <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--muted-2)' }}>{scope}</span>
          <span className="x" onClick={onClose}>✕</span>
        </div>
        <div className="modal-body">
          <div className="mc-tip">
            💡 每个智能体(角色)默认用不同模型:日常/分析/写码用轻量模型省 token,复杂推理/旗舰任务用强模型。未配置的智能体走平台默认(<b>custom-ds / deepseek-v4-flash-openai</b>)。配置在 AI 执行该角色任务时生效。
          </div>
          <div className="mc-legend">
            {TIER_ORDER.map(t => (
              <span key={t} className="mc-tier-hint">{MODEL_TIER_TEXT[t]}</span>
            ))}
          </div>
          {roles.length === 0 && (
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
        </div>
      </div>
    </div>
  )
}
