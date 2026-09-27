// team-hub/routes/write-intent.mjs
// ============================================================================
// 写入意图 / 预约 / 实时冲突视图的 HTTP 契约（S4 / R-2 · R-3 · R-7）
//
// 服务端权威：仓库身份与 target ref 由服务端按 scope 解析；浏览器传来绝对路径、
// 非 refs/ 目标、任意 shell 字符串一律拒绝（400），不接受"可执行提示词当范围"。
//
// 等待语义（设计 §3.1 / AC-R3-1）：预约冲突不是执行失败——
//   · HTTP 200 + { ok:false, code:'FILE_CONTENTION', paths, holderTaskId }；
//   · tasks.status 保持 todo、scheduling_state=waiting-file、fixCount 不增。
// ============================================================================

const ABSOLUTE_RE = /^[A-Za-z]:/
const SHELLY_RE = /[;&|><`$]/

function isAbsoluteLike(s) {
  return ABSOLUTE_RE.test(s) || s.startsWith('/') || s.startsWith('\\\\')
}
function isFullRef(s) {
  return typeof s === 'string' && /^refs\//.test(s)
}

export function createWriteIntentRoutes({
  json, readBody, authorized, writeIntentStore, db,
  setSchedulingState = null, now = () => Date.now(),
}) {
  const handlers = []
  const on = (method, re, run) => handlers.push({ method, re, run })

  const taskRow = (id) => db.prepare('SELECT id, status, scope, fixCount, scheduling_state FROM tasks WHERE id = ?').get(id)
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

  function resolveRepoId(body, scope) {
    const requested = body.repoId
    if (requested === undefined || requested === null || requested === '') return { repoId: 'scope:' + scope }
    if (typeof requested !== 'string') return { error: 'repoId 必须是字符串' }
    const s = requested.trim()
    if (s === '' || isAbsoluteLike(s) || SHELLY_RE.test(s)) {
      return { error: '仓库身份必须由服务端解析：不接受浏览器传入的绝对路径 / 含 shell 元字符的 repoId' }
    }
    return { repoId: s }
  }

  function resolveTargetRef(body) {
    const ref = body.targetRef
    if (ref === undefined || ref === null) return { targetRef: 'refs/heads/main' }
    if (!isFullRef(ref) || SHELLY_RE.test(ref)) return { error: 'targetRef 必须是完整 ref（refs/...）' }
    return { targetRef: ref }
  }

  // POST /api/tasks/:id/write-intent
  on('POST', /^\/api\/tasks\/([^/]+)\/write-intent$/, async (req, res, m) => {
    const auth = await readAuthorizedBody(req, res); if (!auth) return
    const task = taskRow(m[1])
    if (!task) { json(res, 404, { ok: false, code: 'TASK_NOT_FOUND', message: '任务不存在' }); return }
    const repo = resolveRepoId(auth.body, auth.scope)
    if (repo.error) { json(res, 400, { ok: false, code: 'INVALID_REPO', message: repo.error }); return }
    const ref = resolveTargetRef(auth.body)
    if (ref.error) { json(res, 400, { ok: false, code: 'INVALID_TARGET_REF', message: ref.error }); return }
    const r = writeIntentStore.upsertIntent({
      repoId: repo.repoId, taskId: task.id, attemptId: auth.body.attemptId ?? null, targetRef: ref.targetRef,
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
    const repo = resolveRepoId(auth.body, auth.scope)
    if (repo.error) { json(res, 400, { ok: false, code: 'INVALID_REPO', message: repo.error }); return }
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
    const repo = resolveRepoId(auth.body, auth.scope)
    if (repo.error) { json(res, 400, { ok: false, code: 'INVALID_REPO', message: repo.error }); return }
    const ref = resolveTargetRef(auth.body)
    if (ref.error) { json(res, 400, { ok: false, code: 'INVALID_TARGET_REF', message: ref.error }); return }
    if (auth.body.epoch === undefined || auth.body.epoch === null) { json(res, 400, { ok: false, code: 'MISSING_EPOCH', message: '缺少 epoch' }); return }
    const r = writeIntentStore.reserve({
      repoId: repo.repoId, taskId: task.id, attemptId: auth.body.attemptId ?? null, epoch: auth.body.epoch,
      paths: auth.body.paths, targetRef: ref.targetRef, leaseMs: auth.body.leaseMs ?? null,
      capability: auth.body.capability === 'degraded' ? 'degraded' : 'git',
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
    const repo = resolveRepoId(auth.body, auth.scope)
    if (repo.error) { json(res, 400, { ok: false, code: 'INVALID_REPO', message: repo.error }); return }
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
