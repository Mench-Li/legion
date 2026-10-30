// team-hub/handoff-route.test.mjs
// ---------------------------------------------------------------------------
// `POST /api/handoff/settle` 的**胶水契约**（2026-10-30）。
//
// 为什么要单独测胶水：这条路由几乎只是搬运参数，真正的活全在注入的 `settleHandoff`
// 里。而"搬错参数"（id/taskId 两种写法、by 丢失、envelope 包错）会让域层再正确也
// 白搭——仓库里已经有过一次"路由搬错参数、域层用例全绿"的先例。
//
// 运行：node --test team-hub/handoff-route.test.mjs
// ---------------------------------------------------------------------------
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHandoffRoutes } from './routes/handoff.mjs'

/** 最小 router 替身：只实现本族要用的两个入口。 */
function spyRouter(over = {}) {
  const calls = { settle: [], audit: [] }
  const json = (res, status, body) => { res.status = status; res.body = body }
  const handleWrite = async (req, res, run, opts) => {
    // 复刻真实行为：by 缺失直接拒；给了就交给回调，并把 scope 递进去。
    const by = req.body?.by
    if (typeof by !== 'string' || by.trim() === '') { json(res, 400, { error: '缺少操作者身份 by' }); return }
    try {
      const result = await run(req.body, by, 'scope-from-hub')
      if (!res.status) json(res, 200, opts?.envelope === null ? { ok: true, ...result } : { ok: true, task: result })
    } catch (e) {
      json(res, Number(e?.statusCode) || 400, { error: e instanceof Error ? e.message : String(e) })
    }
  }
  const router = createHandoffRoutes({
    json,
    handleWrite,
    settleHandoff: (...a) => { calls.settle.push(a); return { settled: true } },
    audit: (...a) => { calls.audit.push(a) },
    ...over,
  })
  return { router, calls }
}

const drive = async (router, path, body) => {
  const res = {}
  await router.dispatch({ method: 'POST', body }, res, { path, url: new URL('http://x') })
  return res
}

test('① 参数搬运：id 与 taskId 两种写法都认，by 原样下去', async () => {
  const { router, calls } = spyRouter()
  await drive(router, '/api/handoff/settle', { id: 'T-240', by: 'general' })
  await drive(router, '/api/handoff/settle', { taskId: 'T-241', by: 'general', reason: '接手交付' })
  assert.deepEqual(calls.settle[0], [{ taskId: 'T-240', by: 'general', reason: undefined }])
  assert.deepEqual(calls.settle[1], [{ taskId: 'T-241', by: 'general', reason: '接手交付' }])
})

test('② 没有 by 一律拒绝（与其它写路由同一条闸门）', async () => {
  const { router, calls } = spyRouter()
  const res = await drive(router, '/api/handoff/settle', { id: 'T-240' })
  assert.equal(res.status, 400)
  assert.equal(calls.settle.length, 0)
})

test('③ 缺任务 id 时明确报错，不落到"结算了空"', async () => {
  const { router } = spyRouter()
  const res = await drive(router, '/api/handoff/settle', { by: 'general' })
  assert.equal(res.status, 400)
  assert.match(res.body.error, /缺少参数 id/)
})

test('④ 响应是**展平**的结算报告（不是 {ok, task}）', async () => {
  const { router } = spyRouter()
  const res = await drive(router, '/api/handoff/settle', { id: 'T-240', by: 'general' })
  assert.equal(res.status, 200)
  assert.equal(res.body.task, undefined, '塞进 task 会让调用方以为改的是任务本身')
  assert.equal(res.body.settled, true)
})

test('⑤ 域层抛错时原样上抛状态码（判定失败要走 in_review，不是静默 200）', async () => {
  const { router } = spyRouter({
    settleHandoff: () => {
      throw Object.assign(new Error('独立验证未通过（退出码 1）'), { statusCode: 409, code: 'HANDOFF_SETTLE_FAILED' })
    },
  })
  const res = await drive(router, '/api/handoff/settle', { id: 'T-240', by: 'general' })
  assert.equal(res.status, 409)
  assert.match(res.body.error, /独立验证未通过/)
})

test('⑥ 结算结果进审计（谁在什么时候接了哪一环）', async () => {
  const { router, calls } = spyRouter({
    settleHandoff: () => ({ settlement: { state: 'passed' }, attempt: { id: 'wfa-9' }, sourceCommit: '717607bf' }),
  })
  await drive(router, '/api/handoff/settle', { id: 'T-240', by: 'general' })
  assert.equal(calls.audit.length, 1)
  assert.equal(calls.audit[0][2], 'handoff:settle')
  assert.deepEqual(calls.audit[0][4], { state: 'passed', attemptId: 'wfa-9', sourceCommit: '717607bf' })
})
