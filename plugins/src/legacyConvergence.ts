// plugins/src/legacyConvergence.ts
// ============================================================================
// legacy 合入通道收敛（S6 / R-6）
//
// 设计 §12：每个受管仓库只有一个集成入口（integration worker）。autoPromote 与
// 公共调解员 mediation 原有的 direct merge 必须收敛——本模块是那个**纯函数闸门**：
// autoPromote / mediation 在真正 git merge 之前先问它。
//
// 模式：
//   legacy      —— 沿用旧通道（默认，保证未灰度仓库行为不变）
//   observation —— 只记录"本应走集成 worker"的模拟判定，**不改派工**
//   integration —— 新集成阶段启用；旧 direct merge 一律拒绝并转唯一入口
// ============================================================================

export const INTEGRATION_MODES = Object.freeze(['legacy', 'observation', 'integration'] as const)
export type IntegrationMode = typeof INTEGRATION_MODES[number]

export interface IntegrationDecision {
  mode: IntegrationMode
  source: string
  action: 'allow-legacy' | 'simulate' | 'refuse-legacy'
  code: string
  enqueueIntegration: boolean
  simulated: boolean
  message: string
}

export function resolveIntegrationMode(env: Record<string, string | undefined> = process.env): IntegrationMode {
  const raw = env.LEGION_INTEGRATION_MODE
  return (INTEGRATION_MODES as readonly string[]).includes(String(raw)) ? (raw as IntegrationMode) : 'legacy'
}

/** autoPromote / mediation 共用的唯一判定。 */
export function decideIntegrationPath(input: { mode: IntegrationMode, source: string, taskId?: string | null }): IntegrationDecision {
  const { mode, source, taskId } = input
  if (mode === 'integration') {
    return Object.freeze({
      mode, source, action: 'refuse-legacy', code: 'LEGACY_INTEGRATION_DISABLED',
      enqueueIntegration: true, simulated: false,
      message: `旧直合并通道已停用：任务 ${taskId ?? '(unknown)'} 的 ${source} 必须走唯一集成 worker，不能直接 git merge`,
    })
  }
  if (mode === 'observation') {
    return Object.freeze({
      mode, source, action: 'simulate', code: 'OBSERVE_ONLY',
      enqueueIntegration: false, simulated: true,
      message: `观察模式：${source} 本应改走集成 worker（模拟判定，不改变派工）`,
    })
  }
  return Object.freeze({
    mode, source, action: 'allow-legacy', code: 'LEGACY_ALLOWED',
    enqueueIntegration: false, simulated: false, message: '',
  })
}

/** 多空间绑定同一仓库时，模式必须收敛到仓库级一个值。 */
export function resolveRepoMode(bindings: Array<{ spaceId: string, mode: IntegrationMode }>): { ok: true, mode: IntegrationMode } | { ok: false, code: 'REPO_MODE_CONFLICT', message: string } {
  const modes = [...new Set((bindings ?? []).map((b) => b.mode))]
  if (modes.length <= 1) return Object.freeze({ ok: true, mode: modes[0] ?? 'legacy' })
  return Object.freeze({
    ok: false, code: 'REPO_MODE_CONFLICT',
    message: `同一仓库被多个空间以不同模式绑定（${modes.join(', ')}）：必须收敛到一个仓库级模式，避免两个集成入口同时运行`,
  })
}

/** done 只能由「交付子状态 integrated + 任务原有验收通过」产生。 */
export function canProduceDone({ deliveryState, acceptancePassed }: { deliveryState: string | null, acceptancePassed: boolean }): boolean {
  return deliveryState === 'integrated' && acceptancePassed === true
}

/** 观察模式的标志：模拟判定，不改派工。 */
export function observationMarker(mode: IntegrationMode): { simulated: boolean, changesDispatch: false } {
  return Object.freeze({ simulated: mode === 'observation', changesDispatch: false })
}

/** 回滚：只关新任务自动认领/集成，不删除数据、分支或临时工作区，并做在途 job 对账。 */
export function planRollback(input: { inFlightJobs?: string[] } = {}): Record<string, unknown> {
  const jobs = input.inFlightJobs ?? []
  return Object.freeze({
    disableAutoClaimForNewTasks: true,
    deleteDbRecords: false,
    deleteBranches: false,
    deleteTempWorkspaces: false,
    reconcileJobs: jobs.map((id) => Object.freeze({ jobId: id, action: 'pause-and-account' })),
  })
}
