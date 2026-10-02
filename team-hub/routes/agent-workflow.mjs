// team-hub/routes/agent-workflow.mjs
// Typed review outcomes and atomic rework creation for stage Agent workflows.

export function createAgentWorkflowRoutes({ json, handleWrite, submitReview, readHistory, readInstances, beginStageAttempt, reportStageAttempt, reconcileStageAttempt } = {}) {
  const deps = { json, handleWrite, submitReview, readHistory, readInstances, beginStageAttempt, reportStageAttempt, reconcileStageAttempt }
  for (const [key, value] of Object.entries(deps)) {
    if (value === undefined || value === null) throw new TypeError(`createAgentWorkflowRoutes 缺注入项：${key}`)
  }
  const routes = [{
    method: 'GET',
    match: 'exact',
    path: '/api/agent-workflow/instances',
    async run(_req, res, { url }) {
      const scope = url.searchParams.get('scope')
      if (!scope) { json(res, 400, { error: '缺少参数 scope' }); return }
      const rawLimit = Number(url.searchParams.get('limit') ?? 20)
      const rawOffset = Number(url.searchParams.get('offset') ?? 0)
      const limit = Number.isSafeInteger(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 20
      const offset = Number.isSafeInteger(rawOffset) ? Math.max(0, rawOffset) : 0
      const status = url.searchParams.get('status') ?? 'all'
      if (!['all', 'active', 'done', 'paused', 'canceled'].includes(status)) {
        json(res, 400, { error: 'status 仅支持 all、active、done、paused、canceled' }); return
      }
      const search = (url.searchParams.get('search') ?? '').trim().slice(0, 200)
      json(res, 200, await readInstances({ scope, limit, offset, status, search }))
    },
  }, {
    method: 'GET',
    match: 'exact',
    path: '/api/agent-workflow/history',
    async run(_req, res, { url }) {
      const taskId = url.searchParams.get('taskId')
      const scope = url.searchParams.get('scope')
      if (!taskId) { json(res, 400, { error: '缺少参数 taskId' }); return }
      if (!scope) { json(res, 400, { error: '缺少参数 scope' }); return }
      json(res, 200, await readHistory({ taskId, scope }))
    },
  }, {
    method: 'POST',
    match: 'exact',
    path: '/api/agent-workflow/stage-attempts/start',
    async run(req, res) {
      await handleWrite(req, res, (body, by, scope) => beginStageAttempt({
        taskId: body?.taskId,
        stageId: body?.stageId,
        providerName: body?.providerName,
        workspaceDir: body?.workspaceDir,
        idempotencyKey: body?.idempotencyKey,
        by,
        scope,
      }))
    },
  }, {
    method: 'POST',
    match: 'exact',
    path: '/api/agent-workflow/stage-attempts/report',
    async run(req, res) {
      await handleWrite(req, res, (body, by, scope) => reportStageAttempt({
        attemptId: body?.attemptId,
        providerRunId: body?.providerRunId,
        state: body?.state,
        stopReason: body?.stopReason,
        error: body?.error,
        result: body?.result,
        by,
        scope,
      }))
    },
  }, {
    method: 'POST',
    match: 'exact',
    path: '/api/agent-workflow/stage-attempts/reconcile',
    async run(req, res) {
      await handleWrite(req, res, (body, by, scope) => reconcileStageAttempt({
        attemptId: body?.attemptId,
        disposition: body?.disposition,
        note: body?.note,
        idempotencyKey: body?.idempotencyKey,
        by,
        scope,
      }))
    },
  }, {
    method: 'POST',
    match: 'exact',
    path: '/api/agent-workflow/review',
    async run(req, res) {
      await handleWrite(req, res, (body, by, scope) => submitReview({
        taskId: body?.taskId,
        by,
        scope,
        findings: body?.findings,
        summary: body?.summary,
        evidence: body?.evidence,
      }))
    },
  }]
  return {
    id: 'agent-workflow',
    routes,
    async dispatch(req, res, ctx) {
      const route = routes.find((item) => item.method === req.method && item.path === ctx.path)
      if (route === undefined) return false
      await route.run(req, res, ctx)
      return true
    },
  }
}
