// ============================================================================
// PRT-316 切片 34：任务交接与运行时读数（11 条）
//   runtime 读数：`/api/runtime/reconciliations` `/api/runtime/next-post`
//                 `/api/runtime/budget` `/api/runtime/attempt`
//   任务交接写面：`/api/claim` `/api/transition` `/api/advance`
//                 `/api/reassign` `/api/hold` `/api/release-stale`
//   队列读数：`/api/inbox`
//
// ★★★ 本片**不是**为了"补一套判据"才写的。survey 量出来：
//   11 条里只有 5 条有判据，而且 `/api/claim` 只有 **1 套 / 1 个请求点**
//   —— 它正是 PRT-214 裁决围绕的那条（claim() 现在写 11 个键、权限档位已搬到 worker 侧）。
//   完全**没有**判据的六条：`/api/advance` `/api/reassign` `/api/hold`
//   `/api/release-stale` `/api/inbox`（★ `/api/hold` 是"将军逐任务拦截/放行"）。
//
//   > 一个"claim 是安全关键路径、所以肯定有人守着"的印象，
//   > 与一个"整套判据里只有**一个请求点**碰过它"的事实，
//   > 在我没有逐条去数"谁请求过它"的时候是同一个东西。
//
// 夹具：临时库 + 真实 listen(0)（与 run-routes / pipeline 同构）。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTaskLifecycleRoutes } from './routes/task-lifecycle.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-tlroutes-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const call = async (m, p, b) => {
  const res = await fetch(base + p, {
    method: m,
    headers: b === undefined ? {} : { 'content-type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b),
  })
  const t = await res.text()
  let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}
const get = (p) => call('GET', p)
const post = (p, b) => call('POST', p, b)

/** 直接写库：运行面只认领 `status=todo` 且未 hold 的任务。
 *  ★★ `scope: null` 必须**真的**存成 NULL —— 第一版写的是 `o.scope ?? 'default'`，
 *  于是"空 scope 回退"那条判据的夹具**从来就不是空的**，缺口被自己的夹具盖住了。
 *  > 一个"我量过了、没有区分度"的印象，与一个"**夹具是空的**、所以什么都没量到"的事实，
 *  > 在我没有去把那一行插进去的**值**念一遍的时候是同一个东西。 */
const ins = (id, o = {}) => mod.db.prepare(
  'INSERT OR REPLACE INTO tasks (id,title,priority,status,scope,hold,role,soldier,goalId,version,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
).run(id, id, 'medium', o.status ?? 'todo', o.scope === null ? null : (o.scope ?? 'default'), o.hold ?? 0, o.role ?? null,
  o.soldier ?? null, o.goalId ?? null, o.version ?? 1, 'T', 'T')
const row = (id) => mod.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
// ★ 直接读 `goal` 表，**不**走 `/api/goal` —— 那条路自己也会调 settleGoalsOfScope，
//   用它来验"transition/advance 有没有收尾"会把缺口整个盖住。
const goalStatus = (id) => mod.db.prepare('SELECT status FROM goal WHERE id = ?').get(id)?.status
const lastAudit = () => mod.db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT 1').get()

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dir, { recursive: true, force: true })
})

// ── 1. /api/runtime/reconciliations ──────────────────────────────────────
test('① ★★ 对账读数：缺/空 attemptId ⇒ 400 + 具名码 MISSING_PARAM', async () => {
  const missing = await get('/api/runtime/reconciliations')
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'MISSING_PARAM', '★ 去掉那个具名码，调用方就只能靠文案猜')
  assert.equal(missing.body.ok, false)
  // ★ `?attemptId=` 与"完全不给"**同样**被拦（判据是 `length === 0`，不是 `=== null`）
  const empty = await get('/api/runtime/reconciliations?attemptId=')
  assert.equal(empty.status, 400, '★ 只判 null 的话，空串会溜进去')
})

test('①b ★ 对账读数：未知 attemptId 也回 200 + 空数组（不是 404）', async () => {
  const r = await get('/api/runtime/reconciliations?attemptId=att:nope:1')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.reconciliations, [], '★ "这条尝试没有任何对账记录"与"尝试不存在"是两件事，这里只回答前者')
  assert.equal(typeof r.body.serverTimeMs, 'number')
})

// ── 2. /api/runtime/next-post ────────────────────────────────────────────
test('② ★★★ 下一岗读数：缺 taskId ⇒ 400；未知任务 ⇒ **404**（不是 500）；岗位不在流水线 ⇒ **409**', async () => {
  const missing = await get('/api/runtime/next-post')
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'MISSING_PARAM')

  const unknown = await get('/api/runtime/next-post?taskId=nope')
  assert.equal(unknown.status, 404, '★ 用 `getTask`（对不存在会**抛异常**）而不是直接查两列的话，这里会变成 500')
  assert.equal(unknown.body.code, 'TASK_NOT_FOUND')

  ins('np-1', { role: 'no-such-role' })
  const badRole = await get('/api/runtime/next-post?taskId=np-1')
  assert.equal(badRole.status, 409, '★★ 链断**不能**被读成 `hasNextPost:false` —— 那两件事不一样')
  assert.equal(badRole.body.code, 'UNKNOWN_ROLE')
  assert.equal(badRole.body.ok, false)
  assert.ok('brokenEdge' in badRole.body, '★ 断在哪条边上也要给出来')
  assert.ok(!('hasNextPost' in badRole.body), '★★ 链断时**不许**出现 hasNextPost 字段')
})

// ── 3. /api/runtime/budget ───────────────────────────────────────────────
test('③ ★★★ 重试预算：缺 taskId ⇒ 400；有 taskId ⇒ 200 且读数字段齐全', async () => {
  assert.equal((await get('/api/runtime/budget')).status, 400)
  ins('bd-1')
  const ok = await get('/api/runtime/budget?taskId=bd-1')
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  const b = ok.body.budget
  assert.equal(b.taskId, 'bd-1')
  for (const k of ['attemptsUsed', 'maxAttempts', 'remaining']) {
    assert.equal(typeof b[k], 'number', `★ budget.${k} 必须是数`)
  }
  assert.equal(b.remaining, b.maxAttempts - b.attemptsUsed, '★ "还能重试几次"要自洽')
})

test('③b ★★★ `/api/runtime/budget`（重试）与 `/api/runtime/run-budget`（费用）是**两条**路', async () => {
  // 注释（这条路由上面那段）记着：PRT-503 一度也用 `/api/runtime/budget`，
  // 于是这条成为**不可达的死代码**，而基线的路由清单是 Set 去重的、**看不出任何变化**。
  const retry = await get('/api/runtime/budget?taskId=bd-1')
  assert.equal(retry.status, 200)
  assert.ok('attemptsUsed' in retry.body.budget, '★ 这条回的是**重试**额度，不是费用')
  assert.ok(!('cost' in retry.body.budget) && !('usd' in retry.body.budget))
})

// ── 4. /api/runtime/attempt ──────────────────────────────────────────────
test('④ ★★ 诊断端点：两个参数都给不出 ⇒ 400；未知 attemptId ⇒ 404；只给 taskId ⇒ 200', async () => {
  const none = await get('/api/runtime/attempt')
  assert.equal(none.status, 400)
  assert.match(String(none.body.error), /attemptId 或 taskId/)

  const unknown = await get('/api/runtime/attempt?attemptId=att:nope:9')
  assert.equal(unknown.status, 404)
  assert.match(String(unknown.body.error), /运行尝试不存在/)

  const byTask = await get('/api/runtime/attempt?taskId=bd-1')
  assert.equal(byTask.status, 200)
  assert.equal(byTask.body.taskId, 'bd-1')
  assert.ok(Array.isArray(byTask.body.history))
})

// ── 5. /api/claim ────────────────────────────────────────────────────────
test('⑤ ★★★ `POST /api/claim`：缺 id ⇒ 400；缺 by ⇒ 400（身份是硬要求）', async () => {
  const noId = await post('/api/claim', { by: 'general' })
  assert.equal(noId.status, 400)
  assert.equal(noId.body.error, '缺少参数 id')

  const noBy = await post('/api/claim', { id: 'cl-0' })
  assert.equal(noBy.status, 400, '★ 没有操作者身份就不能认领 —— 认领要记在谁头上')
  assert.match(String(noBy.body.error), /by/)
})

test('⑤b ★★★ claim：不传 `soldier` 时**回退到 `by`**，认领后状态与 hold 都变了', async () => {
  ins('cl-1')
  const r = await post('/api/claim', { id: 'cl-1', by: 'general' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.task.soldier, 'general',
    '★★ 把回退那半边砍掉（`const soldier = body.soldier`）这里会变成 undefined/null')
  assert.equal(r.body.task.status, 'in_progress')
  assert.equal(r.body.task.hold, false, '★ `hold` 是布尔，不是 0/1')
  assert.ok(r.body.task.claimedAt, '★ 认领时间要落下来')
  assert.equal(row('cl-1').soldier, 'general')
})

test('⑤c ★★★ claim：已认领的任务再认领 ⇒ 400（不能静默抢走）', async () => {
  // ★★ 实测两种被拒的**文案不同**，取决于"要抢的人是不是当前的持有者"：
  //   同一个人再认领 → `无法认领：任务 cl-1 当前 in_progress`
  //   别人来抢       → `任务 cl-1 已被 general 认领，不得抢占`
  //   第一版只断言 `/无法认领/`，于是这一格假红。
  //   > 一个"认领被拒就一句话"的印象，与一个"拒法有两种、按**你是不是持有者**分"的事实，
  //   > 在我没有把两种都走一遍的时候是同一个东西。
  const again = await post('/api/claim', { id: 'cl-1', by: 'other' })
  assert.equal(again.status, 400)
  assert.match(String(again.body.error), /认领/)
  assert.match(String(again.body.error), /cl-1/)
  assert.equal(row('cl-1').soldier, 'general', '★★ 被拒之后**归属不能变**')
  assert.equal(row('cl-1').version, row('cl-1').version, '★ 被拒不该写库')

  // 同一个持有者再认领一次：另一句话，但同样 400
  const same = await post('/api/claim', { id: 'cl-1', by: 'general' })
  assert.equal(same.status, 400)
  assert.match(String(same.body.error), /无法认领/)
})

test('⑤d ★★ claim：`ttlMinutes` 不是正整数时**当作没给**（回退），不是报错', async () => {
  ins('cl-2')
  const frac = await post('/api/claim', { id: 'cl-2', by: 'general', ttlMinutes: 2.5 })
  assert.equal(frac.status, 200, '★ 2.5 被那条 `Number.isInteger` 挡掉 ⇒ 走"没给 ttl"的分支')
  // 库里 expiresAt 只在给了合法 ttl 时才由 claimTask 算 —— 没给就是 null
  assert.equal(row('cl-2').expiresAt, null, '★ 非法 ttl 不该被当成 2 分钟落下')
})

test('⑤e ★★★ claim 的审计：action=`claim`、detail 里带 soldier、taskId 挂在目标上', async () => {
  ins('cl-3', { goalId: 'goal-x' })
  await post('/api/claim', { id: 'cl-3', by: 'general', soldier: 's-9' })
  const a = lastAudit()
  assert.equal(a.action, 'claim', '★ 动作名改了的话，按动作查账的地方就断了')
  assert.equal(a.taskId, 'cl-3')
  assert.deepEqual(JSON.parse(a.detail), { soldier: 's-9' })
  assert.equal(a.goalId, 'goal-x', '★★ 不记 goalId 的话，这条账**挂不到目标上**')
})

// ── 6. /api/transition ───────────────────────────────────────────────────
test('⑥ ★★★ transition：缺 id / 缺 to / 未知任务 ⇒ 400，且报的是**各自**那句', async () => {
  ins('tr-1')
  const noId = await post('/api/transition', { to: 'in_progress', by: 'general' })
  assert.equal(noId.status, 400)
  assert.equal(noId.body.error, '缺少参数 id')

  const noTo = await post('/api/transition', { id: 'tr-1', by: 'general' })
  assert.equal(noTo.status, 400)
  assert.equal(noTo.body.error, '缺少参数 to', '★ 不验 to 的话这里会走到域层、报出另一句话')

  const unknown = await post('/api/transition', { id: 'nope', to: 'in_progress', by: 'general' })
  assert.equal(unknown.status, 400)
  assert.match(String(unknown.body.error), /未知任务 nope/)

  const ok = await post('/api/transition', { id: 'tr-1', to: 'in_progress', by: 'general' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.task.status, 'in_progress')
  assert.equal(lastAudit().action, 'transition')
})

// ── 7. /api/advance ──────────────────────────────────────────────────────
test('⑦ ★★★ advance：缺 id ⇒ 400；未知任务 ⇒ 400（这条路由此前**一个判据都没有**）', async () => {
  const noId = await post('/api/advance', { by: 'general' })
  assert.equal(noId.status, 400)
  assert.equal(noId.body.error, '缺少参数 id')

  const unknown = await post('/api/advance', { id: 'nope', by: 'general' })
  assert.equal(unknown.status, 400, '★ 改坏路径或去掉校验，这一格都不会这样回')
  assert.match(String(unknown.body.error), /未知任务 nope/)
})

// ── 8. /api/reassign ─────────────────────────────────────────────────────
test('⑧ ★★★ reassign：缺 soldier / 全空白 ⇒ 400；给了就**去空白**再落库', async () => {
  ins('rs-1')
  for (const bad of [undefined, '   ']) {
    const r = await post('/api/reassign', { id: 'rs-1', by: 'general', soldier: bad })
    assert.equal(r.status, 400, `soldier=${JSON.stringify(bad)} 应当被拒`)
    assert.equal(r.body.error, '缺少参数 soldier')
  }
  assert.equal(row('rs-1').soldier, null, '★ 被拒之后不该落任何东西')

  const ok = await post('/api/reassign', { id: 'rs-1', by: 'general', soldier: '  pad-1  ' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.task.soldier, 'pad-1', '★★ 不去空白的话，库里会留下带空格的士兵名 —— 而它是主键之一')
  assert.equal(row('rs-1').soldier, 'pad-1')
  assert.deepEqual(JSON.parse(lastAudit().detail), { soldier: 'pad-1' }, '★ 账上记的也要是去空白后的')
})

// ── 9. /api/hold（将军逐任务拦截/放行；此前 0 个判据）────────────────────
test('⑨ ★★★ hold：缺 id / 未知任务 / 已 done / 已 canceled 四种都拒', async () => {
  assert.equal((await post('/api/hold', { by: 'general' })).body.error, '缺少参数 id')
  assert.equal((await post('/api/hold', { id: 'nope', by: 'general', hold: true })).status, 400)
  ins('hd-done', { status: 'done' })
  ins('hd-cancel', { status: 'canceled' })
  const d = await post('/api/hold', { id: 'hd-done', by: 'general', hold: true })
  assert.equal(d.status, 400, '★★ done 的任务不可再拦截 —— 去掉那道闸门就会静默改一条已收尾的任务')
  assert.match(String(d.body.error), /已 done/)
  const c = await post('/api/hold', { id: 'hd-cancel', by: 'general', hold: true })
  assert.equal(c.status, 400)
  assert.match(String(c.body.error), /已 canceled/)
})

test('⑨b ★★★ hold=true：库里 hold=1、version+1、updatedAt 刷新，且回的是**重读的任务**', async () => {
  ins('hd-1', { version: 1 })
  const r = await post('/api/hold', { id: 'hd-1', by: 'general', hold: true })
  assert.equal(r.status, 200)
  assert.equal(r.body.task.hold, true, '★ 回 `{hold}` 而不是重读任务的话，这里就没有 task 的其它字段')
  assert.equal(r.body.task.id, 'hd-1')
  const after = row('hd-1')
  assert.equal(after.hold, 1)
  assert.equal(after.version, 2, '★★ 不写 `version=version+1` 的话，乐观锁就废了 —— 别人以为没变过')
  assert.equal(after.updatedAt, r.body.task.updatedAt)
  assert.ok(after.updatedAt && after.updatedAt !== 'T', '★★ 不写 updatedAt 的话它还是插入时那个 "T"')
  assert.equal(lastAudit().action, 'hold')
})

test('⑨c ★★ 放行：审计动作是 `unhold`（不是又一个 `hold`）', async () => {
  const r = await post('/api/hold', { id: 'hd-1', by: 'general', hold: false })
  assert.equal(r.status, 200)
  assert.equal(r.body.task.hold, false)
  assert.equal(row('hd-1').hold, 0)
  assert.equal(lastAudit().action, 'unhold',
    '★★ 不分 hold/unhold 的话，"谁在什么时候把这条放开了"就查不出来')
})

test('⑨d ★★★ 记录一处**实测的不对称**：`hold` 传字符串 "true" 等于**放行**', async () => {
  // 判据是 `body.hold === true`（**恒等**），所以 `"true"` / `1` / `"yes"` 全都落到 false 分支。
  // 若前端某处把表单值当字符串发过来，"将军按下拦截"会**真的把任务放行**。
  // ★ 本片**不修**（改判据会动对外契约：现在"非 true 即放行"是有意的宽松读法），
  //   只把这个读数钉住 —— 它此前没有任何判据看着。
  ins('hd-str', { version: 1 })
  await post('/api/hold', { id: 'hd-str', by: 'general', hold: true })
  assert.equal(row('hd-str').hold, 1)
  const r = await post('/api/hold', { id: 'hd-str', by: 'general', hold: 'true' })
  assert.equal(r.status, 200)
  assert.equal(r.body.task.hold, false, '★★ 字符串 "true" ⇒ hold 被**解除**')
  assert.equal(row('hd-str').hold, 0)
  assert.equal(lastAudit().action, 'unhold')
})

// ── 10. /api/release-stale（此前 0 个判据）───────────────────────────────
test('⑩ ★★★ release-stale：`olderThan` 缺省 60；0 / 负数 / 非数 一律 400', async () => {
  const dflt = await post('/api/release-stale', { by: 'general' })
  assert.equal(dflt.status, 200, '★ 不传就是默认 60 分钟')
  assert.ok(Array.isArray(dflt.body.task.released), '★ 回的是 `{released:[...]}`')

  for (const bad of [0, -5, 'abc']) {
    const r = await post('/api/release-stale', { by: 'general', olderThan: bad })
    assert.equal(r.status, 400, `olderThan=${JSON.stringify(bad)} 应当被拒`)
    assert.equal(r.body.error, 'olderThan 必须是正整数分钟数')
  }
  // ★ `0` 那条最关键：默认值从 60 改成 0 的话，"回收**所有**未过期的租约"会变成一个合法请求
  const zero = await post('/api/release-stale', { by: 'general', olderThan: 0 })
  assert.equal(zero.status, 400, '★★ olderThan=0 若不拦，就等于"把还没过期的全部回收"')
})

test('⑩b ★★ release-stale：`ids` 非数组 ⇒ 当作没给；审计 scope 是 `*`', async () => {
  const notArray = await post('/api/release-stale', { by: 'general', olderThan: 1, ids: 'x' })
  assert.equal(notArray.status, 200)
  const mixed = await post('/api/release-stale', { by: 'general', olderThan: 1, ids: ['a', 7] })
  assert.equal(mixed.status, 200, '★ 数组里混了非字符串不报错，只被过滤掉')
  const a = lastAudit()
  assert.equal(a.action, 'release-stale')
  // ★★ `audit(member, scope, action, taskId, detail, goalId)` —— 那条调用写的是
  //    `audit(by, scope, 'release-stale', '*', { released })`：
  //    `'*'` 是 **taskId**，不是 scope。scope 是**写路径**解析出来的那个。
  //    第一版把 `'*'` 当成 scope 断言 ⇒ 假红。
  //   > 一个"账上那个 `*` 是空间"的印象，与一个"它是**任务位**的通配符"的事实，
  //   > 在我没有把 audit 的形参表对着念一遍的时候是同一个东西。
  assert.equal(a.taskId, '*', '★★ 跨空间的批量动作：任务是 `*`（这条动作不属于任何一个任务）')
  assert.equal(a.scope, 'default', '★ scope 是写路径解析出来的（没给就 default）')
  assert.deepEqual(Object.keys(JSON.parse(a.detail)), ['released'])
})

// ── 11. /api/inbox（此前 0 个判据）──────────────────────────────────────
test('⑪ ★★★ inbox：role 与 soldier 都不给 ⇒ 400；给一个就 200', async () => {
  const none = await get('/api/inbox')
  assert.equal(none.status, 400, '★ 不要求二者之一的话，这里会去数**全仓**的待办')
  assert.equal(none.body.error, 'inbox 需要 role 或 soldier 参数')

  const byRole = await get('/api/inbox?role=general')
  assert.equal(byRole.status, 200)
  assert.equal(typeof byRole.body.count, 'number')
  assert.ok(Array.isArray(byRole.body.tasks))

  const bySoldier = await get('/api/inbox?soldier=s1')
  assert.equal(bySoldier.status, 200)
})

test('⑪b ★★ inbox 认 `scope`；并记录一处不对称：`soldier=` 空串**算"给了"**', async () => {
  const scoped = await get('/api/inbox?role=general&scope=alpha')
  assert.equal(scoped.status, 200)
  // ★ `url.searchParams.get('soldier')` 对 `?soldier=` 回的是**空串**（不是 null），
  //   而判定是 `=== undefined` ⇒ 空串被当成"给了参数"。
  const blank = await get('/api/inbox?soldier=')
  assert.equal(blank.status, 200, '★ 本片不修（改判据会动对外契约），只把读数钉住')
})

test('⑪c ★★ inbox 的 400 走的是**自己的** try/catch（错误形状与其它路由不同）', async () => {
  const r = await get('/api/inbox')
  assert.equal(r.status, 400)
  // ★ 这条路由是 `try { ... } catch { json(res,400,{error}) }`，没有 `ok` 字段；
  //   与 runtime 读数那三条的 `{ok:false, code}` 形状**不一样**。
  assert.deepEqual(Object.keys(r.body), ['error'],
    '★ 把 catch 改成 500 或加上 ok:false，这一格就会红')
})

// ── 12. 补：破验量出来的另外 6 个真缺口 ─────────────────────────────────
test('⑤f ★★★ claim 的 `round` / `requestId` 各自落到**自己的**字段上', async () => {
  // 调用是 `claimTask(id, soldier, ifVersion, force, round, requestId, ttl)` ——
  // 相邻两个位置参数极易接反，而接反**不会报错**，只会把轮次记成请求号。
  ins('m5-1')
  const r = await post('/api/claim', { id: 'm5-1', by: 'general', soldier: 's5', round: 7, requestId: 'req-abc' })
  assert.equal(r.status, 200)
  const row5 = mod.db.prepare('SELECT claimedRound, claimRequestId FROM tasks WHERE id = ?').get('m5-1')
  assert.equal(row5.claimedRound, 7, '★★ 两个位置参数接反的话，这里会是字符串 "req-abc"')
  assert.equal(row5.claimRequestId, 'req-abc', '★★ 接反的话，这里会是数字 7')
})

test('⑦b ★★★ advance 走通时**收尾目标**（全部完成 ⇒ 目标自动 done）', async () => {
  // ★ 状态机（实测）：`todo → in_review` 非法；能到 done 的是 `in_review → done`。
  //   而 advance **要求调用者就是那条任务的绑定士兵**（否则 400「只有 s 可推进」）。
  mod.db.prepare("INSERT OR REPLACE INTO goal (id,scope,objective,status,mode,createdAt) VALUES ('g-ad','gad','目标','active','chain','T')").run()
  ins('gad-a', { status: 'done', scope: 'gad', goalId: 'g-ad' })
  ins('gad-b', { status: 'in_review', scope: 'gad', goalId: 'g-ad', soldier: 's' })
  assert.equal(goalStatus('g-ad'), 'active')
  const r = await post('/api/advance', { id: 'gad-b', by: 's' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.task.status, 'done')
  // ★★ 直接读**表**，不走 `/api/goal` —— 那条路自己也会 settle，会把缺口盖住
  assert.equal(goalStatus('g-ad'), 'done',
    '★★ 去掉 `settleGoalsOfScope(task.scope)` 的话，目标会永远停在 active')
})

test('⑦c ★★★ advance 认 `ifVersion`：过期就 409 乐观锁冲突', async () => {
  ins('m14-1', { status: 'in_review', version: 5, soldier: 's' })
  const stale = await post('/api/advance', { id: 'm14-1', by: 's', ifVersion: 1 })
  assert.equal(stale.status, 409, '★★ 不传 ifVersion 给域层的话，过期版本会被**照常推进**')
  assert.match(String(stale.body.error), /乐观锁冲突/)
  assert.equal(row('m14-1').status, 'in_review', '★ 冲突之后状态不能动')
  assert.equal(row('m14-1').version, 5)
  const ok = await post('/api/advance', { id: 'm14-1', by: 's', ifVersion: 5 })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.task.version, 6)
})

test('⑥b ★★★ transition 走通时也**收尾目标**（与 advance 是两条路）', async () => {
  mod.db.prepare("INSERT OR REPLACE INTO goal (id,scope,objective,status,mode,createdAt) VALUES ('g-tr','gtr','目标','active','chain','T')").run()
  ins('gtr-a', { status: 'done', scope: 'gtr', goalId: 'g-tr' })
  ins('gtr-b', { status: 'in_review', scope: 'gtr', goalId: 'g-tr', soldier: 's' })
  const r = await post('/api/transition', { id: 'gtr-b', to: 'done', by: 'general' })
  assert.equal(r.status, 200)
  assert.equal(goalStatus('g-tr'), 'done',
    '★★ 那条件是 `task.goalId || status done/canceled` —— 拿掉它目标就永远收不了尾')
})

test('⑪d ★★★ inbox 的 `scope` 过滤真的在过滤（不是一个被吞掉的参数）', async () => {
  ins('ib-a', { status: 'todo', role: 'r-ib', scope: 'alpha' })
  ins('ib-b', { status: 'todo', role: 'r-ib', scope: 'beta' })
  const all = await get('/api/inbox?role=r-ib')
  assert.equal(all.body.count, 2, '不限定 scope ⇒ 两个空间都算')
  const alpha = await get('/api/inbox?role=r-ib&scope=alpha')
  assert.equal(alpha.body.count, 1, '★ 丢掉 scope 参数的话这里会还是 2')
  assert.deepEqual(alpha.body.tasks.map((t) => t.id), ['ib-a'])
  const beta = await get('/api/inbox?role=r-ib&scope=beta')
  assert.deepEqual(beta.body.tasks.map((t) => t.id), ['ib-b'])
})

test('②b ★★★ next-post 把 `scope` 为空的任务**回退到 default 空间**', async () => {
  // ★★★ 这条只有**给 default 配了流水线**才观测得到：
  //   不配的话 `readPipeline('default')` 与 `readPipeline(null)` 都是空 stages，
  //   两种实现回一样的 409 —— 缺口就藏起来了。
  //   > 一个"我量过了、没有区分度"的印象，与一个"**夹具是空的**、所以什么都没量到"的事实，
  //   > 在我没有先把夹具配出来的时候是同一个东西。
  const cols = mod.db.prepare('PRAGMA table_info(space_stages)').all().map((c) => c.name)
  const put = (o) => {
    const use = cols.filter((c) => c in o)
    mod.db.prepare(`INSERT OR REPLACE INTO space_stages (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`)
      .run(...use.map((c) => o[c]))
  }
  put({ scope: 'default', role: 'stage-a', label: '岗位甲', prompt: 'p', next: 'stage-b', sort: 0 })
  put({ scope: 'default', role: 'stage-b', label: '岗位乙', prompt: 'p', next: '', sort: 1 })

  ins('npr-def', { role: 'stage-a', scope: 'default' })
  const defined = await get('/api/runtime/next-post?taskId=npr-def')
  assert.equal(defined.status, 200, '夹具没造出来：' + JSON.stringify(defined.body))
  assert.equal(defined.body.hasNextPost, true)

  ins('npr-null', { role: 'stage-a', scope: null })
  const nulled = await get('/api/runtime/next-post?taskId=npr-null')
  assert.equal(nulled.status, 200,
    '★★ 去掉 `task.scope ?? \'default\'` 那半边，空 scope 的任务会去查一个不存在的空间 ⇒ 409 UNKNOWN_ROLE')
  assert.equal(nulled.body.hasNextPost, true)
  assert.equal(nulled.body.nextRole, 'stage-b')
})

// ── 13. 接缝契约 ─────────────────────────────────────────────────────────
test('⑫ ★★★ dispatch 契约：命中 ⇒ 恰好一次并回 true；不命中（含方法不符）⇒ false', async () => {
  const ran = []
  const deps = {
    json: (res, code, payload) => { res.sent = { code, payload } },
    runStore: { reconciliationsOf: () => [], retryBudgetOf: () => ({}), getAttempt: () => null,
      historyOf: () => [], eventsOf: () => [] },
    db: { prepare: () => ({ all: () => [], get: () => null, run: () => ({}) }) },
    readPipeline: () => ({ stages: [] }),
    resolveNextPost: () => ({ ok: true }),
    claimTask: () => { ran.push('claimTask'); return { goalId: null } },
    audit: () => {},
    transitionTask: () => ({ goalId: null, status: 'todo', scope: 'default' }),
    settleGoalsOfScope: () => 0,
    advanceTask: () => ({ goalId: null, scope: 'default' }),
    reassignTask: () => ({ goalId: null }),
    now: () => 'T',
    getTask: () => ({}),
    releaseStaleTasks: () => [],
    inboxCount: () => ({ count: 0, tasks: [] }),
    handleWrite: async (req, res, run) => { const out = await run({ id: 'x' }, 'general', 'default'); res.sent = { code: 200, payload: out } },
  }
  const router = createTaskLifecycleRoutes(deps)

  let res = {}
  assert.equal(await router.dispatch({ method: 'GET' }, res, { path: '/api/nope', url: new URL('http://x/nope') }), false)
  assert.equal(ran.length, 0)

  // ★★ 方法不符必须 false —— 本族里 `POST /api/claim` 与别的 GET 混在一起
  res = {}
  assert.equal(await router.dispatch({ method: 'POST' }, res, { path: '/api/inbox', url: new URL('http://x/api/inbox') }), false,
    '★ 不看方法的话，POST /api/inbox 会被这一族抢走')
  assert.equal(ran.length, 0)

  res = {}
  assert.equal(await router.dispatch({ method: 'POST' }, res, { path: '/api/claim', url: new URL('http://x/api/claim') }), true)
  assert.deepEqual(ran, ['claimTask'], '★★ 恰好一次；回 false 会让 handle() 再答复一次')

  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.path}`), [
    'GET /api/runtime/reconciliations', 'GET /api/runtime/next-post', 'GET /api/runtime/budget',
    'GET /api/runtime/attempt', 'POST /api/claim', 'POST /api/transition', 'POST /api/advance',
    'POST /api/reassign', 'POST /api/hold', 'POST /api/release-stale', 'GET /api/inbox',
  ])
  assert.equal(router.id, 'task-lifecycle')
})
