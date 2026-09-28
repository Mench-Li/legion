// team-hub/routes/write-intent.mjs
// ============================================================================

import { entriesWithinDomain } from '../../packages/shared/src/path-domain.mjs'
// 写入意图 / 预约 / 实时冲突视图的 HTTP 契约（S4 / R-2 · R-3 · R-7）
//
// 服务端权威：仓库身份与 target ref 由服务端按 scope 解析；浏览器传来绝对路径、
// 非 refs/ 目标、任意 shell 字符串一律拒绝（400），不接受"可执行提示词当范围"。
//
// 等待语义（设计 §3.1 / AC-R3-1）：预约冲突不是执行失败——
//   · HTTP 200 + { ok:false, code:'FILE_CONTENTION', paths, holderTaskId }；
//   · tasks.status 保持 todo、scheduling_state=waiting-file、fixCount 不增。
// ============================================================================

export function createWriteIntentRoutes({
  json, readBody, authorized, writeIntentStore, db,
  resolveRepoBinding,
  setSchedulingState = null, now = () => Date.now(),
}) {
  const handlers = []
  const on = (method, re, run) => handlers.push({ method, re, run })

  const taskRow = (id) => db.prepare('SELECT id, status, scope, fixCount, fileDomain, scheduling_state FROM tasks WHERE id = ?').get(id)
  const requireTaskDomain = (res, task, paths) => {
    let domain
    try { domain = JSON.parse(task.fileDomain) } catch { domain = null }
    if (!Array.isArray(domain) || domain.length === 0 || entriesWithinDomain(paths, domain, { caseInsensitive: process.platform === 'win32' })) return true
    json(res, 422, { ok: false, code: 'OUT_OF_FILE_DOMAIN', message: '计划写入范围超出任务允许修改的文件域' })
    return false
  }
  const mark = (id, state) => {
    if (typeof setSchedulingState === 'function') return setSchedulingState(id, state)
    try { db.prepare('UPDATE tasks SET scheduling_state = ? WHERE id = ?').run(state, id) } catch { /* 列缺失时忽略 */ }
    return undefined
  }

  async function readAuthorizedBody(req, res) {
    if (!authorized(req)) { json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '缺少或错误的 token' }); return null }
    let body
    try { body = await readBody(req) } catch { json(res, 400, { ok: false, code: 'BAD_JSON', message: '请求体不是合法 JSON' }); return null }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) { json(res, 400, { ok: false, code: 'BAD_BODY', message: '请求体必须是对象' }); return null }
    const by = typeof body.by === 'string' ? body.by.trim() : ''
    if (by === '') { json(res, 400, { ok: false, code: 'MISSING_ACTOR', message: '缺少操作者身份 by' }); return null }
    const scope = typeof body.scope === 'string' ? body.scope.trim() : ''
    if (scope === '') { json(res, 400, { ok: false, code: 'MISSING_SCOPE', message: '缺少 scope' }); return null }
    return { body, by, scope }
  }

  function bindingFor(req, res, task, auth) {
    if (task.scope !== auth.scope) {
      json(res, 403, { ok: false, code: 'SCOPE_MISMATCH', message: '任务不属于请求空间' })
      return null
    }
    const binding = resolveRepoBinding(auth.scope)
    if (binding?.error || !binding?.repoId) {
      json(res, 409, { ok: false, code: 'REPO_UNBOUND', message: binding?.error ?? '仓库未绑定' })
      return null
    }
    if (auth.body.repoId !== undefined && auth.body.repoId !== binding.repoId) {
      json(res, 400, { ok: false, code: 'INVALID_REPO', message: 'repoId 与服务器绑定的物理仓库不一致' })
      return null
    }
    if (auth.body.targetRef !== undefined && auth.body.targetRef !== binding.targetRef) {
      json(res, 400, { ok: false, code: 'INVALID_TARGET_REF', message: 'targetRef 与绑定工作区当前分支不一致' })
      return null
    }
    return binding
  }

  // POST /api/tasks/:id/write-intent
  on('POST', /^\/api\/tasks\/([^/]+)\/write-intent$/, async (req, res, m) => {
    const auth = await readAuthorizedBody(req, res); if (!auth) return
    const task = taskRow(m[1])
    if (!task) { json(res, 404, { ok: false, code: 'TASK_NOT_FOUND', message: '任务不存在' }); return }
    const repo = bindingFor(req, res, task, auth); if (!repo) return
    if (!requireTaskDomain(res, task, auth.body.paths)) return
    const r = writeIntentStore.upsertIntent({
      repoId: repo.repoId, taskId: task.id, attemptId: auth.body.attemptId ?? null, targetRef: repo.targetRef,
      paths: auth.body.paths, source: auth.body.source ?? 'planner', expectedRevision: auth.body.expectedRevision ?? null,
    })
    if (!r.ok && r.code === 'REVISION_CONFLICT') { json(res, 409, r); return }
    if (!r.ok) { json(res, 400, r); return }
    json(res, 200, { ok: true, intent: r.intent })
  })

  // POST /api/tasks/:id/write-intent/expand
  on('POST', /^\/api\/tasks\/([^/]+)\/write-intent\/expand$/, async (req, res, m) => {
    const auth = await readAuthorizedBody(req, res); if (!auth) return
    const task = taskRow(m[1])
    if (!task) { json(res, 404, { ok: false, code: 'TASK_NOT_FOUND' }); return }
    const repo = bindingFor(req, res, task, auth); if (!repo) return
    if (!requireTaskDomain(res, task, auth.body.paths)) return
    const r = writeIntentStore.expandIntent({
      repoId: repo.repoId, taskId: task.id, attemptId: auth.body.attemptId ?? null, epoch: auth.body.epoch,
      addPaths: auth.body.paths, expectedRevision: auth.body.expectedRevision ?? null,
    })
    if (r.ok) { json(res, 200, r); return }
    if (r.code === 'REVISION_CONFLICT' || r.code === 'FILE_CONTENTION') { json(res, 409, r); return }
    json(res, 400, r)
  })

  // POST /api/tasks/:id/reservation
  on('POST', /^\/api\/tasks\/([^/]+)\/reservation$/, async (req, res, m) => {
    const auth = await readAuthorizedBody(req, res); if (!auth) return
    const task = taskRow(m[1])
    if (!task) { json(res, 404, { ok: false, code: 'TASK_NOT_FOUND' }); return }
    const repo = bindingFor(req, res, task, auth); if (!repo) return
    if (!requireTaskDomain(res, task, auth.body.paths)) return
    if (auth.body.epoch === undefined || auth.body.epoch === null) { json(res, 400, { ok: false, code: 'MISSING_EPOCH', message: '缺少 epoch' }); return }
    const r = writeIntentStore.reserve({
      repoId: repo.repoId, taskId: task.id, attemptId: auth.body.attemptId ?? null, epoch: auth.body.epoch,
      paths: auth.body.paths, targetRef: repo.targetRef, leaseMs: auth.body.leaseMs ?? null,
      capability: repo.capability,
    })
    if (r.ok) {
      mark(task.id, 'reserved')
      json(res, 200, { ok: true, reservation: r.reservation, intent: r.intent })
      return
    }
    if (r.code === 'FILE_CONTENTION' || r.code === 'SINGLE_WRITER_REQUIRED') {
      mark(task.id, 'waiting-file')
      const fresh = taskRow(task.id)
      json(res, 200, {
        ok: false, code: r.code, reason: r.reason, paths: r.paths ?? [], holderTaskId: r.holderTaskId ?? null,
        schedulingState: 'waiting-file',
        task: { id: task.id, status: fresh.status, fixCount: fresh.fixCount, schedulingState: 'waiting-file' },
      })
      return
    }
    json(res, 400, r)
  })

  // POST /api/tasks/:id/reservation/release
  on('POST', /^\/api\/tasks\/([^/]+)\/reservation\/release$/, async (req, res, m) => {
    const auth = await readAuthorizedBody(req, res); if (!auth) return
    const task = taskRow(m[1])
    if (!task) { json(res, 404, { ok: false, code: 'TASK_NOT_FOUND' }); return }
    const repo = bindingFor(req, res, task, auth); if (!repo) return
    if (process.env.LEGION_INTEGRATION_MODE === 'integration' && ['in_progress', 'in_review'].includes(task.status)) {
      json(res, 409, { ok: false, code: 'TASK_STILL_ACTIVE', message: '执行或交付尚未结束，不能手工释放写入占用' })
      return
    }
    const r = writeIntentStore.release({ repoId: repo.repoId, taskId: task.id, attemptId: auth.body.attemptId ?? null, epoch: auth.body.epoch })
    if (r.ok) { mark(task.id, 'released'); json(res, 200, { ok: true, reservation: r.reservation }); return }
    if (r.code === 'EPOCH_STALE') { json(res, 409, r); return }
    if (r.code === 'NO_ACTIVE_RESERVATION') { json(res, 404, r); return }
    json(res, 400, r)
  })

  // GET /api/tasks/:id/write-intent
  on('GET', /^\/api\/tasks\/([^/]+)\/write-intent$/, async (req, res, m) => {
    if (!authorized(req)) { json(res, 401, { ok: false, code: 'UNAUTHORIZED' }); return }
    const intent = writeIntentStore.getIntent(m[1])
    if (!intent) { json(res, 404, { ok: false, code: 'NO_INTENT' }); return }
    json(res, 200, { ok: true, intent })
  })

  on('GET', /^\/api\/tasks\/([^/]+)\/reservation$/, async (req, res, m) => {
    if (!authorized(req)) { json(res, 401, { ok: false, code: 'UNAUTHORIZED' }); return }
    const task = taskRow(m[1])
    if (!task) { json(res, 404, { ok: false, code: 'TASK_NOT_FOUND' }); return }
    const repo = resolveRepoBinding(task.scope)
    if (repo.error) { json(res, 409, { ok: false, code: 'REPO_UNBOUND' }); return }
    const reservation = writeIntentStore.listActiveReservations(repo.repoId).find((item) => item.taskId === task.id)
    const intent = writeIntentStore.getIntent(task.id)
    if (!reservation || !intent) { json(res, 404, { ok: false, code: 'NO_ACTIVE_RESERVATION' }); return }
    json(res, 200, { ok: true, reservation, intent })
  })

  // Manual recovery after an interrupted worker has actually stopped. The
  // frozen lock remains in place until this explicit confirmation arrives.
  on('POST', /^\/api\/tasks\/([^/]+)\/reservation\/confirm-stopped$/, async (req, res, m) => {
    const auth = await readAuthorizedBody(req, res); if (!auth) return
    const task = taskRow(m[1])
    if (!task) { json(res, 404, { ok: false, code: 'TASK_NOT_FOUND' }); return }
    const repo = bindingFor(req, res, task, auth); if (!repo) return
    if (auth.by !== 'general' || auth.body.confirm !== `stopped:${task.id}` || !['todo', 'blocked', 'canceled'].includes(task.status)) {
      json(res, 403, { ok: false, code: 'STOP_CONFIRMATION_REQUIRED', message: '请确认该任务的执行进程已经停止' }); return
    }
    const row = writeIntentStore.listActiveReservations(repo.repoId).find((item) => item.taskId === task.id && item.state === 'reconciling')
    if (!row) { json(res, 404, { ok: false, code: 'NO_RECONCILING_RESERVATION' }); return }
    const released = writeIntentStore.release({ repoId: repo.repoId, taskId: task.id, attemptId: row.attemptId, epoch: row.leaseEpoch })
    if (!released.ok) { json(res, 409, released); return }
    mark(task.id, 'released')
    json(res, 200, { ok: true, reservation: released.reservation })
  })

  // GET /api/tasks/:id/contention —— server-side path matching, including
  // unplanned whole-repository reservations; no duplicate UI path algorithm.
  on('GET', /^\/api\/tasks\/([^/]+)\/contention$/, async (req, res, m) => {
    if (!authorized(req)) { json(res, 401, { ok: false, code: 'UNAUTHORIZED' }); return }
    const task = taskRow(m[1])
    if (!task) { json(res, 404, { ok: false, code: 'TASK_NOT_FOUND' }); return }
    const binding = resolveRepoBinding(task.scope)
    if (binding.error) { json(res, 409, { ok: false, code: 'REPO_UNBOUND', message: binding.error }); return }
    const intent = writeIntentStore.getIntent(task.id)
    const paths = intent?.paths ?? []
    const conflict = writeIntentStore.inspectContention({ repoId: binding.repoId, taskId: task.id, paths, exclusive: paths.length === 0 })
    json(res, 200, { ...conflict, repoId: binding.repoId, schedulingState: task.scheduling_state ?? 'unplanned', integrationMode: process.env.LEGION_INTEGRATION_MODE === 'integration' })
  })

  // GET /api/repositories/:id/contention —— 只读视图（不写库、不改派工）
  on('GET', /^\/api\/repositories\/([^/]+)\/contention$/, async (req, res, m) => {
    if (!authorized(req)) { json(res, 401, { ok: false, code: 'UNAUTHORIZED' }); return }
    const repoId = decodeURIComponent(m[1])
    const active = writeIntentStore.listActiveReservations(repoId)
    const scan = writeIntentStore.assertNoActiveOverlap(repoId)
    json(res, 200, {
      ok: true, repoId, readOnly: true,
      active: active.map((r) => ({ taskId: r.taskId, attemptId: r.attemptId, paths: r.paths, state: r.state, leaseEpoch: r.leaseEpoch, expiresAtMs: r.expiresAtMs })),
      overlaps: scan.conflicts,
    })
  })

  return {
    id: 'write-intent',
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
