// team-hub/routes/metrics.mjs
// ============================================================================
// 指标只读端点（S4 / R-8）
//
// 口径（设计 §11）：指标按仓库与版本记录；**不可读时返回 available:false + reason，
// value 不为 0**（把"没有读数"画成 0 会被当成"没有冲突"）。等待时长 P50/P95 必须
// 给出明确样本窗口与可复算口径。
//
// ★ 2026-10-27（决策 #6 方案 B）：失败分类的归一化在
//   `orchestrator/state-machine/failure-kind.mjs`（只读纯函数，8 条单测）。
//   本文件只负责"取样本 + 调它"，不重复一套判据——两份判据会在某个角落分叉，
//   而分叉的表现是"同一个失败在页面和指标里说两件事"。
// ============================================================================

import { failureKindOf, failureRate } from '../../orchestrator/state-machine/failure-kind.mjs'

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
    // ★ 2026-10-27（T3.1）：`postIntegrationValidationFailureRate` 这个名字是错的。
    //
    //   验证跑在**候选合并提交**上、fast-forward **之前**（`integration-worker.mjs`），
    //   应用之后只核对 ancestor 关系——所以"集成**后**验证失败率"这个读法不成立。
    //
    //   ★ 两个字段**同时返回且同值**，不是失误：删掉旧字段会让外部消费方静默拿到
    //     undefined，而"没有读数"与"0"必须区分。所以先加新名 + 标注废弃，删除另立任务。
    const deprecation = {
      deprecated: true,
      deprecatedBy: 'preIntegrationCandidateValidationFailureRate',
      deprecationNote: '验证发生在候选合并提交上、fast-forward 之前，不是"合入后再验一遍"；请改用 preIntegrationCandidateValidationFailureRate',
    }
    if (vDen === 0) {
      // ★ 没有样本时旧字段**也必须带废弃标记**：否则消费方只能在"有数据"时才被告知改名，
      //   而那恰好是最不可能踩坑的时刻。
      metrics.postIntegrationValidationFailureRate = { ...unavailable('没有集成后验证样本'), ...deprecation }
      metrics.preIntegrationCandidateValidationFailureRate = unavailable('没有候选验证样本')
    } else {
      const rate = failedValidations.length / vDen
      const window = { numerator: 'error_code=VALIDATION_FAILED', denominator: vDen }
      // 旧字段名保留但带上废弃标记（`unavailable`/`available` 都返回冻结对象，所以标记随构造一起给）。
      metrics.postIntegrationValidationFailureRate = { ...available(rate, { window }), ...deprecation }
      metrics.preIntegrationCandidateValidationFailureRate = available(rate, { window })
    }

    if (deliveries.length === 0) metrics.manualDecisionRate = unavailable('没有交付样本')
    else metrics.manualDecisionRate = available(deliveries.filter((d) => d.decisionId).length / deliveries.length, { window: { denominator: deliveries.length } })

    const recovered = integrationEvents.filter((e) => typeof e.detail_json === 'string' && e.detail_json.includes('record-only'))
    const paused = integrationEvents.filter((e) => e.to_state === 'paused')
    const rDen = recovered.length + paused.length
    if (rDen === 0) metrics.integrationRecoverySuccessRate = unavailable('没有恢复/暂停样本')
    else metrics.integrationRecoverySuccessRate = available(recovered.length / rDen, { window: { numerator: 'record-only 恢复', denominator: rDen } })

    // ── 决策 #6：失败分类分布（只读归一化，分母排除"不是失败"的类别）───────────
    //
    // 样本从集成事件与写入预约取：这两处是当前能批量拿到具名码的地方。
    // ★ 没有样本时返回 available:false —— 不返回 0，也不用 0 当"很健康"。
    const failureSamples = []
    for (const event of integrationEvents) {
      const code = typeof event.error_code === 'string' ? event.error_code : null
      if (code === null) continue
      failureSamples.push(failureKindOf({ errorCode: code }))
    }
    const byKind = {}
    for (const verdict of failureSamples) byKind[verdict.kind] = (byKind[verdict.kind] ?? 0) + 1
    const rate = failureRate(failureSamples)
    if (!rate.available) {
      metrics.failureKindRate = unavailable('没有可判定的失败样本')
      metrics.failureKindCounts = unavailable('没有可判定的失败样本')
    } else {
      metrics.failureKindRate = available(rate.value, {
        window: {
          numerator: 'isFailure=true 的样本', denominator: rate.total,
          excluded: 'none / waiting / rework（流程正常，不是失败）',
        },
      })
      metrics.failureKindCounts = available(byKind, { window: { sampleSize: rate.total } })
    }

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
