// team-hub/routes/metrics.mjs
// ============================================================================
// 指标只读端点（S4 / R-8）
//
// 口径（设计 §11）：指标按仓库与版本记录；**不可读时返回 available:false + reason，
// value 不为 0**（把"没有读数"画成 0 会被当成"没有冲突"）。等待时长 P50/P95 必须
// 给出明确样本窗口与可复算口径。
// ============================================================================

function percentile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null
  const rank = Math.ceil((p / 100) * sorted.length)
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[idx]
}

export function createMetricsRoutes({ json, authorized, db, writeIntentStore = null, deliveryStore = null }) {
  function unavailable(reason) { return Object.freeze({ available: false, value: null, reason }) }
  function available(value, extra = {}) { return Object.freeze({ available: true, value, reason: null, ...extra }) }

  function compute(repoId) {
    const metrics = {}
    let events = []
    if (writeIntentStore && repoId) {
      try { events = writeIntentStore.listWriteIntentEvents(repoId) } catch { events = [] }
    }
    const blocked = events.filter((e) => e.kind === 'FILE_CONTENTION')
    if (!writeIntentStore || !repoId) metrics.sameFileWriteBlocked = unavailable('缺少 repoId 或事件源不可用')
    else metrics.sameFileWriteBlocked = available(blocked.length, { window: { kind: 'write_intent_events', repoId } })

    const waits = blocked.map((e) => e.wait_ms).filter((v) => typeof v === 'number' && v >= 0).sort((a, b) => a - b)
    const window = { kind: 'append-only write_intent_events', repoId, sampleSize: waits.length, formula: 'wait_ms = 成功预约时刻 - 最近一次 CONTENTION 时刻；P 为升序样本的第 ceil(P/100*n) 个' }
    if (waits.length === 0) {
      metrics.waitDurationP50 = unavailable('窗口内没有已结束的等待样本（没有任何一次等待最终成功预约）')
      metrics.waitDurationP95 = unavailable('窗口内没有已结束的等待样本（没有任何一次等待最终成功预约）')
    } else {
      metrics.waitDurationP50 = available(percentile(waits, 50), { window })
      metrics.waitDurationP95 = available(percentile(waits, 95), { window })
    }

    let jobs = []
    let integrationEvents = []
    let deliveries = []
    try { if (deliveryStore && repoId) jobs = deliveryStore.listIntegrationJobs(repoId) } catch { jobs = [] }
    try { if (deliveryStore) integrationEvents = deliveryStore.listIntegrationEvents() } catch { integrationEvents = [] }
    try { if (deliveryStore) deliveries = deliveryStore.listDeliveries() } catch { deliveries = [] }

    if (!deliveryStore || !repoId || jobs.length === 0) {
      metrics.integrationConflictRate = unavailable(jobs.length === 0 ? '该仓库还没有集成 job 样本' : '缺少 repoId 或集成账不可用')
    } else {
      const conflicted = new Set(integrationEvents.filter((e) => e.error_code === 'GIT_CONFLICT').map((e) => e.job_id))
      const rateDen = jobs.length
      metrics.integrationConflictRate = available(conflicted.size / rateDen, { window: { numerator: 'error_code=GIT_CONFLICT 的 job 数', denominator: rateDen } })
    }

    const integratedEvents = integrationEvents.filter((e) => e.to_state === 'integrated')
    const failedValidations = integrationEvents.filter((e) => e.error_code === 'VALIDATION_FAILED')
    const vDen = integratedEvents.length + failedValidations.length
    if (vDen === 0) metrics.postIntegrationValidationFailureRate = unavailable('没有集成后验证样本')
    else metrics.postIntegrationValidationFailureRate = available(failedValidations.length / vDen, { window: { numerator: 'error_code=VALIDATION_FAILED', denominator: vDen } })

    if (deliveries.length === 0) metrics.manualDecisionRate = unavailable('没有交付样本')
    else metrics.manualDecisionRate = available(deliveries.filter((d) => d.decisionId).length / deliveries.length, { window: { denominator: deliveries.length } })

    const recovered = integrationEvents.filter((e) => typeof e.detail_json === 'string' && e.detail_json.includes('record-only'))
    const paused = integrationEvents.filter((e) => e.to_state === 'paused')
    const rDen = recovered.length + paused.length
    if (rDen === 0) metrics.integrationRecoverySuccessRate = unavailable('没有恢复/暂停样本')
    else metrics.integrationRecoverySuccessRate = available(recovered.length / rDen, { window: { numerator: 'record-only 恢复', denominator: rDen } })

    return metrics
  }

  return {
    id: 'metrics',
    routes: [{ method: 'GET', path: '/api/metrics/repository' }],
    async dispatch(req, res, ctx) {
      if (req.method !== 'GET' || ctx.path !== '/api/metrics/repository') return false
      if (!authorized(req)) { json(res, 401, { ok: false, code: 'UNAUTHORIZED' }); return true }
      const repoId = new URL(req.url ?? '/', 'http://x').searchParams.get('repoId')
      if (!repoId) {
        const all = compute(null)
        json(res, 200, { ok: false, code: 'MISSING_REPO', repoId: null, metrics: all, available: false, reason: '缺少 repoId' })
        return true
      }
      const metrics = compute(repoId)
      json(res, 200, { ok: true, repoId, metrics })
      return true
    },
  }
}
