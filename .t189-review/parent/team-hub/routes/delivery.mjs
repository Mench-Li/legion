// team-hub/routes/delivery.mjs
// ============================================================================
// 交付子状态 / 集成 job / 裁决的 HTTP 契约（S4 / R-4 · R-5 · R-6）
//
// version CAS：裁决提交携带页面看到的 delivery.version，过期返回 409 且内容不落库。
// 权限：裁决只对具备裁决职责的岗位开放（沿用 F-02 的授权口径，负例 403）。
// ============================================================================

export const DECISION_ROLES = Object.freeze(['general', 'reviewer', 'operator', 'human', 'owner'])

function isFullRef(s) { return typeof s === 'string' && /^refs\//.test(s) }
const SHA_RE = /^[0-9a-f]{7,64}$/i

export function createDeliveryRoutes({ json, readBody, authorized, deliveryStore, db, checkPermission = null, submitVerifiedDelivery = null, runIntegrationInThread = null, recoverIntegrationJob = null }) {
  const handlers = []
  const on = (method, re, run) => handlers.push({ method, re, run })

  async function readBodyOr(res, req) {
    let body
    try { body = await readBody(req) } catch { json(res, 400, { ok: false, code: 'BAD_JSON' }); return null }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) { json(res, 400, { ok: false, code: 'BAD_BODY' }); return null }
    return body
  }
  function requireActor(body, res) {
    const by = typeof body.by === 'string' ? body.by.trim() : ''
    if (by === '') { json(res, 400, { ok: false, code: 'MISSING_ACTOR', message: '缺少操作者身份 by' }); return null }
    return by
  }

  // Production entry: the server derives repository, target ref and final diff,
  // then runs the verified integration in a separate worker thread.
  on('POST', /^\/api\/deliveries\/submit$/, async (req, res) => {
    if (!authorized(req)) { json(res, 401, { ok: false, code: 'UNAUTHORIZED' }); return }
    const body = await readBodyOr(res, req); if (!body) return
    const by = requireActor(body, res); if (!by) return
    if (typeof submitVerifiedDelivery !== 'function' || typeof runIntegrationInThread !== 'function') {
      json(res, 503, { ok: false, code: 'INTEGRATION_NOT_WIRED' }); return
    }
    const submitted = submitVerifiedDelivery({ body, by })
    if (!submitted.ok) { json(res, submitted.status ?? 409, submitted); return }
    const result = submitted.delivery.state === 'integrated'
      ? { ok: true, outcome: 'integrated', integratedCommit: submitted.delivery.integratedCommit }
      : await runIntegrationInThread(submitted.delivery.id, submitted.binding)
    const delivery = deliveryStore.getDelivery(submitted.delivery.id)
    json(res, result.ok ? 200 : 409, { ...result, delivery })
  })

  on('POST', /^\/api\/deliveries\/approve$/, async (req, res) => {
    if (!authorized(req)) { json(res, 401, { ok: false, code: 'UNAUTHORIZED' }); return }
    const body = await readBodyOr(res, req); if (!body) return
    const by = requireActor(body, res); if (!by) return
    if (by !== 'general') { json(res, 403, { ok: false, code: 'GENERAL_APPROVAL_REQUIRED' }); return }
    if (typeof submitVerifiedDelivery !== 'function' || typeof runIntegrationInThread !== 'function') {
      json(res, 503, { ok: false, code: 'INTEGRATION_NOT_WIRED' }); return
    }
    const submitted = submitVerifiedDelivery({ body, by, humanApproval: true })
    if (!submitted.ok) { json(res, submitted.status ?? 409, submitted); return }
    const result = submitted.delivery.state === 'integrated'
      ? { ok: true, outcome: 'integrated', integratedCommit: submitted.delivery.integratedCommit }
      : await runIntegrationInThread(submitted.delivery.id, submitted.binding)
    const delivery = deliveryStore.getDelivery(submitted.delivery.id)
    json(res, result.ok ? 200 : 409, { ...result, delivery })
  })

  on('POST', /^\/api\/integration\/recover$/, async (req, res) => {
    if (!authorized(req)) { json(res, 401, { ok: false, code: 'UNAUTHORIZED' }); return }
    const body = await readBodyOr(res, req); if (!body) return
    const by = requireActor(body, res); if (!by) return
    if (by !== 'general' || typeof body.jobId !== 'string' || body.confirm !== `recover:${body.jobId}`) {
      json(res, 403, { ok: false, code: 'RECOVERY_CONFIRMATION_REQUIRED', message: '请确认上一个集成进程已停止，并指明 jobId' })
      return
    }
    if (typeof recoverIntegrationJob !== 'function') { json(res, 503, { ok: false, code: 'INTEGRATION_NOT_WIRED' }); return }
    const result = await recoverIntegrationJob(body.jobId)
    json(res, result.ok ? 200 : 409, result)
  })

  // POST /api/deliveries —— 创建交付，可选带门禁直接入队
  on('POST', /^\/api\/deliveries$/, async (req, res) => {
    if (process.env.LEGION_INTEGRATION_MODE === 'integration') { json(res, 409, { ok: false, code: 'USE_VERIFIED_SUBMISSION' }); return }
    if (!authorized(req)) { json(res, 401, { ok: false, code: 'UNAUTHORIZED' }); return }
    const body = await readBodyOr(res, req); if (!body) return
    const by = requireActor(body, res); if (!by) return
    if (!isFullRef(body.targetRef)) { json(res, 400, { ok: false, code: 'INVALID_TARGET_REF', message: 'targetRef 必须是完整 ref（refs/...）' }); return }
    if (typeof body.sourceCommit !== 'string' || !SHA_RE.test(body.sourceCommit)) { json(res, 400, { ok: false, code: 'INVALID_SOURCE_COMMIT', message: 'sourceCommit 必须是 git 提交哈希' }); return }
    const created = deliveryStore.createDelivery({
      taskId: body.taskId, attemptId: body.attemptId ?? null, sourceCommit: body.sourceCommit,
      baseCommit: body.baseCommit ?? null, targetRef: body.targetRef, actor: by,
    })
    if (!created.ok) { json(res, 400, created); return }
    if (body.gates && typeof body.gates === 'object') {
      const enq = deliveryStore.enqueueDelivery({ id: created.delivery.id, version: created.delivery.version, gates: body.gates, actor: by })
      if (!enq.ok && enq.code === 'ENQUEUE_GATE') { json(res, 422, { ok: false, code: 'ENQUEUE_GATE', reasons: enq.reasons, delivery: created.delivery }); return }
      json(res, 200, { ok: true, delivery: enq.delivery ?? created.delivery })
      return
    }
    json(res, 200, { ok: true, delivery: created.delivery })
  })

  // GET /api/deliveries/:id 或 /api/deliveries?taskId=
  on('GET', /^\/api\/deliveries(?:\/([^/]+))?$/, async (req, res, m) => {
    if (!authorized(req)) { json(res, 401, { ok: false, code: 'UNAUTHORIZED' }); return }
    if (m[1]) {
      const d = deliveryStore.getDelivery(m[1])
      if (!d) { json(res, 404, { ok: false, code: 'NOT_FOUND' }); return }
      json(res, 200, { ok: true, delivery: d, events: deliveryStore.listIntegrationEvents({ deliveryId: d.id }) })
      return
    }
    const taskId = new URL(req.url ?? '/', 'http://x').searchParams.get('taskId')
    if (!taskId) { json(res, 400, { ok: false, code: 'MISSING_TASK_ID' }); return }
    const d = deliveryStore.getDeliveryByTask(taskId)
    if (!d) { json(res, 404, { ok: false, code: 'NOT_FOUND' }); return }
    json(res, 200, { ok: true, delivery: d, events: deliveryStore.listIntegrationEvents({ deliveryId: d.id }) })
  })

  // POST /api/integration/claim —— 同仓库同 target ref 至多一个活跃 job
  on('POST', /^\/api\/integration\/claim$/, async (req, res) => {
    if (process.env.LEGION_INTEGRATION_MODE === 'integration') { json(res, 409, { ok: false, code: 'USE_VERIFIED_SUBMISSION' }); return }
    if (!authorized(req)) { json(res, 401, { ok: false, code: 'UNAUTHORIZED' }); return }
    const body = await readBodyOr(res, req); if (!body) return
    const by = requireActor(body, res); if (!by) return
    if (typeof body.repoId !== 'string' || body.repoId.trim() === '') { json(res, 400, { ok: false, code: 'MISSING_REPO' }); return }
    if (!isFullRef(body.targetRef)) { json(res, 400, { ok: false, code: 'INVALID_TARGET_REF' }); return }
    const r = deliveryStore.claimIntegrationJob({
      repoId: body.repoId, targetRef: body.targetRef, deliveryId: body.deliveryId ?? null,
      owner: body.owner ?? by, expectedHead: body.expectedHead ?? null, leaseEpoch: body.leaseEpoch ?? 1,
    })
    if (!r.ok) { json(res, 409, r); return }
    json(res, 200, r)
  })

  // POST /api/integration/transition
  on('POST', /^\/api\/integration\/transition$/, async (req, res) => {
    if (process.env.LEGION_INTEGRATION_MODE === 'integration') { json(res, 409, { ok: false, code: 'USE_VERIFIED_SUBMISSION' }); return }
    if (!authorized(req)) { json(res, 401, { ok: false, code: 'UNAUTHORIZED' }); return }
    const body = await readBodyOr(res, req); if (!body) return
    const by = requireActor(body, res); if (!by) return
    const r = deliveryStore.transitionIntegrationJob({
      id: body.jobId, leaseEpoch: body.leaseEpoch ?? null, to: body.to ?? null, phase: body.phase ?? null,
      preparedCommit: body.preparedCommit ?? null, expectedHead: body.expectedHead ?? null,
      gitSha: body.gitSha ?? null, actor: by, errorCode: body.errorCode ?? null, detail: body.detail ?? null,
    })
    if (r.ok) { json(res, 200, r); return }
    if (r.code === 'EPOCH_STALE' || r.code === 'NOT_FOUND') { json(res, r.code === 'EPOCH_STALE' ? 409 : 404, r); return }
    json(res, 400, r)
  })

  // POST /api/deliveries/:id/decision —— 裁决（version CAS）
  on('POST', /^\/api\/deliveries\/([^/]+)\/decision$/, async (req, res, m) => {
    if (process.env.LEGION_INTEGRATION_MODE === 'integration') {
      json(res, 409, { ok: false, code: 'USE_VERIFIED_SUBMISSION', message: '请通过任务验收或重新提交经过验证的候选版本' })
      return
    }
    if (!authorized(req)) { json(res, 401, { ok: false, code: 'UNAUTHORIZED' }); return }
    const body = await readBodyOr(res, req); if (!body) return
    const by = requireActor(body, res); if (!by) return
    if (typeof checkPermission === 'function') {
      const perm = checkPermission({ action: 'delivery:decide', by, role: body.role ?? null })
      if (perm !== true && !(perm && perm.allowed === true)) { json(res, 403, { ok: false, code: 'FORBIDDEN', message: '该岗位没有裁决权限' }); return }
    } else if (body.role !== undefined && body.role !== null && !DECISION_ROLES.includes(body.role)) {
      json(res, 403, { ok: false, code: 'FORBIDDEN', message: '该岗位没有裁决权限' })
      return
    }
    const r = deliveryStore.requestDecision({
      id: m[1], version: body.version ?? null, decision: body.decision, decider: by, reason: body.reason ?? null,
    })
    if (r.ok) { json(res, 200, r); return }
    if (r.code === 'VERSION_CONFLICT') { json(res, 409, { ok: false, code: 'VERSION_CONFLICT', currentVersion: r.currentVersion, message: '交付版本已变化：请刷新后重试' }); return }
    if (r.code === 'NOT_FOUND') { json(res, 404, r); return }
    json(res, 400, r)
  })

  return {
    id: 'delivery',
    routes: handlers.map((h) => ({ method: h.method, path: h.re.source })),
    async dispatch(req, res, ctx) {
      for (const h of handlers) {
        if (req.method !== h.method) continue
        const m = h.re.exec(ctx.path)
        if (!m) continue
        await h.run(req, res, m)
        return true
      }
      return false
    },
  }
}
