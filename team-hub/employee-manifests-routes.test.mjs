// ============================================================================
// PRT-316 切片 24：岗位清单三件套 —— `GET /api/employee-manifest`（读一份）
//                                  `GET /api/employee-manifests`（列一版）
//                                  `POST /api/employee-manifests`（存一版）
//
// ★ 破验第一轮读数：**10/22 咬住，12 条真缺口**。既有的
//   `orchestrator/worker/sources-loader.test.mjs`（58 例、两路径共 10 个请求点）
//   守住了**路径存在性**与**role/employeeId 二选一**那道守卫，但漏了 12 条：
//     M5  scope 必填 · M10 错误码 · M11 limit 下钳位 · M12 limit 上钳位 ·
//     M13 limit 缺省 · M15 `count` · M16 `serverTimeMs` · M17 直接给 body ·
//     M18 `created` · M19 `created` 第二次为 false · M20 `by` 兜底 · M22 不 await 写门面
//   ⇒ 本文件就是来补这 12 条的。
//
// ★ 有意思的一对：**M6 咬住了、M5 没有**。
//   `if (scope === null || scope.trim() === '')` 与
//   `if ((role === null …) && (employeeId === null …))` 是**相邻两道守卫**，
//   既有判据只守了后面那道。
//   *一个"这两道守卫都有人管"的印象，与一个"用例只碰过其中一道"的事实，
//     在我没有把它们**分开**各咬一次的时候是同一个东西。*
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mod
let base
let dbDir

const get = async (path) => {
  const res = await fetch(base + path, { agent: false })
  let payload = null
  try { payload = await res.json() } catch { /* 无正文 */ }
  return { status: res.status, body: payload }
}
const post = async (payload) => {
  const res = await fetch(base + '/api/employee-manifests', {
    method: 'POST', agent: false, headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  let body = null
  try { body = await res.json() } catch { /* 无正文 */ }
  return { status: res.status, body }
}
/** 直接落库，用来造 limit 上钳位要的 501 行（走 HTTP 太慢）。 */
const insertRaw = (scope, role, employeeId) => {
  const at = Date.now()
  mod.db.prepare(
    `INSERT INTO employee_manifests
       (scope, role, employee_id, display_name, responsibilities_json, allowed_tools_json,
        denied_tools_json, approval_policy, limits_json, version, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, '[]', '[]', '[]', 'auto', '{}', 1, ?, ?)`,
  ).run(scope, role, employeeId, role, at, at)
}

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-empmroutes-'))
  process.env.TEAM_HUB_DB = join(dbDir, 'team.db')
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dbDir, { recursive: true, force: true })
})

// ── 读一份：两道**相邻**守卫必须分开各咬一次 ──────────────────────────────
test('① 读一份：`scope` 缺失 ⇒ 400 MISSING_PARAM（★ M5 真缺口）', async () => {
  const r = await get('/api/employee-manifest?role=dev')
  assert.equal(r.status, 400, '★ 没有 scope 就取不到"我的边界" —— 放行等于让模型照别人的约束干活')
  assert.equal(r.body.code, 'MISSING_PARAM')
})

test('② 读一份：`scope` 只有空白也算缺失（不是 `length > 0`）', async () => {
  for (const s of ['', '   ', '%20']) {
    const r = await get(`/api/employee-manifest?scope=${s}&role=dev`)
    assert.equal(r.status, 400, `scope=${JSON.stringify(s)} 应当算缺失`)
  }
})

test('③ 读一份：`role` 与 `employeeId` **都不给** ⇒ 400（★ M6，既有判据已守）', async () => {
  const r = await get('/api/employee-manifest?scope=default')
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'MISSING_PARAM')
  // 给一个空串也一样
  assert.equal((await get('/api/employee-manifest?scope=default&role=&employeeId=%20')).status, 400)
})

test('④ 读一份：给 `role` 或 `employeeId` **之一**即可（不是两个都要）', async () => {
  // ★ `scope` 是 POST body 的**顶层**字段（`{ scope: body.scope, … }`），
  //   不在 manifest 里面 —— 第一版我漏了它，于是这条以及依赖它的 ⑤⑥ 一起红了。
  //   *一个"我给了 role 和 employeeId 就够了吧"的假设，与一个"scope 走的是另一条路"的事实，
  //     在我没有把回执也打出来看一眼的时候是同一个东西。*
  const w = await post({ scope: 'default', role: 'dev-4', employeeId: 'e-4', displayName: '四号' })
  assert.equal(w.status, 200, `写入没成功，回执是 ${JSON.stringify(w.body)}`)
  assert.equal((await get('/api/employee-manifest?scope=default&role=dev-4')).body.manifest.role, 'dev-4')
  assert.equal((await get('/api/employee-manifest?scope=default&employeeId=e-4')).body.manifest.role, 'dev-4',
    '只给 employeeId 也要能读到同一份')
})

test('⑤ 读一份：读到 ⇒ 200 `{ok, manifest, serverTimeMs}`', async () => {
  const r = await get('/api/employee-manifest?scope=default&role=dev-4')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.manifest.role, 'dev-4')
  assert.equal(r.body.manifest.employeeId, 'e-4')
  assert.equal(typeof r.body.serverTimeMs, 'number', '★ M16 真缺口：缺了它界面就没有"这份清单什么时候读的"')
})

test('⑥ 读一份：这个空间里没有 ⇒ 404，且**当前没有** `code`（★ 一条真缺陷，本片只钉住现状）', async () => {
  const r = await get('/api/employee-manifest?scope=nowhere&role=dev-4')
  assert.equal(r.status, 404)
  assert.equal(r.body.ok, false)
  assert.equal(typeof r.body.serverTimeMs, 'number')

  // ★★★ 下面这一格钉的是**一条真缺陷**，不是"这里本该如此"。
  //
  //   模块 L80 写的是：
  //       code: CONTEXT_PLAN_ERRORS.EMPLOYEE_MANIFEST_NOT_FOUND,
  //   而 `CONTEXT_PLAN_ERRORS` 的键叫 **`MANIFEST_NOT_FOUND`**
  //   （它的**值**才是字符串 `'EMPLOYEE_MANIFEST_NOT_FOUND'`）——
  //   于是 `CONTEXT_PLAN_ERRORS.EMPLOYEE_MANIFEST_NOT_FOUND` 是 **`undefined`**，
  //   而 `JSON.stringify` 会把 `undefined` **整个丢掉** ⇒ 回执里根本没有 `code`。
  //
  //   ★ 这条缺陷**不是本片引入的**：`git show df698a6:team-hub/server.mjs` 的
  //     L5467 一字不差就是这个写法（生成器逐字抄的体）。同型还有**第二处**：
  //     `server.mjs` L5437 的 `CONTEXT_PLAN_ERRORS.TEAM_PLAN_NOT_FOUND`
  //     （正确键是 `PLAN_NOT_FOUND`），对应还没搬走的 `/api/team-plan`。
  //
  //   ★ 为什么它躲了这么久：**`undefined` 在 JSON 里是看不见的**。
  //     `team-hub/config-schema.mjs` L474-475 把 `'EMPLOYEE_MANIFEST_NOT_FOUND'`
  //     列成了**合法错误码** —— 也就是说契约上它是"存在的"，只是永远发不出来。
  //
  //   > 一个"我写了 `code: <那个码>`"的判据，与一个"那个键名不存在、
  //   > 于是 `undefined` 被 `JSON.stringify` 静默丢掉"的事实，
  //   > 在我不把回执打出来、只看见源码里那行字的时候是同一个东西。
  //
  //   ⇒ 处理方式与切片 22 的 `limit=2.7` 相同：**钉住现状**，并让它在被修好时**变红**。
  assert.equal(r.body.code, undefined,
    '现状是**没有** code（见上）。若这条红了：说明有人把这个键名修对了 —— ' +
    '请把它改成断言 `r.body.code === "EMPLOYEE_MANIFEST_NOT_FOUND"`，' +
    '并顺手把 `server.mjs` 里 `/api/team-plan` 的同一处（`TEAM_PLAN_NOT_FOUND` → `PLAN_NOT_FOUND`）一起处理。')
})

test('⑦ 读一份：跨空间读不到（scope 是硬边界）', async () => {
  await post({ scope: 'space-x', role: 'dev-x', employeeId: 'e-x' })
  assert.equal((await get('/api/employee-manifest?scope=space-x&role=dev-x')).status, 200)
  assert.equal((await get('/api/employee-manifest?scope=default&role=dev-x')).status, 404)
})

// ── 列一版 ────────────────────────────────────────────────────────────────
test('⑧ 列一版：200 `{ok, manifests, count, serverTimeMs}`，`count` 与数组长度一致（★ M15/M16）', async () => {
  const r = await get('/api/employee-manifests?scope=default')
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.body.manifests))
  assert.equal(r.body.count, r.body.manifests.length,
    '★ 少了 `count` 调用方就得自己数；数错与不数看起来一样')
  assert.equal(typeof r.body.serverTimeMs, 'number')
})

test('⑨ 列一版：不传 `scope` 就是**全体**（不是空）', async () => {
  const all = await get('/api/employee-manifests')
  const one = await get('/api/employee-manifests?scope=default')
  assert.ok(all.body.count >= one.body.count)
  assert.ok(all.body.manifests.some((m) => m.scope === 'space-x'), '不传 scope 要能看见别的空间')
})

test('⑩ ★ 列一版：`limit` 下钳位到 1（0 / 负数 / 非数字都落到 1）（M11 真缺口）', async () => {
  // 先保证这个空间里至少有 2 份
  await post({ scope: 'lim', role: 'r1', employeeId: 'l1' })
  await post({ scope: 'lim', role: 'r2', employeeId: 'l2' })
  for (const raw of ['0', '-5', 'abc']) {
    const r = await get(`/api/employee-manifests?scope=lim&limit=${raw}`)
    assert.equal(r.status, 200, `limit=${raw} 不该报错`)
    assert.equal(r.body.count, 1,
      `★ limit=${raw} 要钳到 **1** —— 钳到 0 的话"这个范围里没有清单"与"你不要清单"看起来一样`)
  }
})

test('⑪ ★ 列一版：`limit` 上钳位到 500（M12 真缺口）', async () => {
  mod.db.prepare('DELETE FROM employee_manifests').run()
  for (let i = 0; i < 501; i++) insertRaw('big', `role-${String(i).padStart(4, '0')}`, `e-${i}`)
  const r = await get('/api/employee-manifests?scope=big&limit=10000')
  assert.equal(r.status, 200)
  assert.equal(r.body.count, 500,
    '★ 上钳位是 500：不钳的话一次请求能把整张表拉进内存，而它"看起来只是多返回了几行"')
  assert.equal((await get('/api/employee-manifests?scope=big')).body.count, 100,
    '缺省 100（★ M13 真缺口）')
})

// ── 存一版 ────────────────────────────────────────────────────────────────
test('⑫ ★ 存一版：回执是 `{ok, manifest, created}`，`created` 第一次为 true（M18 真缺口）', async () => {
  const r = await post({ scope: 'w', role: 'w1', employeeId: 'w1e' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.created, true, '★ 少了 `created`，调用方分不清"新建"和"覆盖了别人的"')
  assert.equal(r.body.manifest.role, 'w1')
})

test('⑬ ★ 存一版：同一个 `scope+role` 再存一次 ⇒ `created` 为 **false**（M19 真缺口）', async () => {
  const first = await post({ scope: 'w2', role: 'w2r', employeeId: 'w2e' })
  const second = await post({ scope: 'w2', role: 'w2r', employeeId: 'w2e' })
  assert.equal(first.body.created, true)
  assert.equal(second.body.created, false, '★ `created` 恒 true 的话，"新建"与"覆盖"就分不开了')
  assert.ok(second.body.manifest.version >= 2, '覆盖会让 version 递增（服务端说了算）')
})

test('⑭ ★ 存一版：可以直接给 body、不必裹 `{manifest: …}`（M17 真缺口）', async () => {
  const flat = await post({ scope: 'w3', role: 'w3r', employeeId: 'w3e' })
  assert.equal(flat.status, 200, '★ 直接给 body 也必须认 —— 只认 `body.manifest` 会让最自然的调用方式 400')
  assert.equal((await get('/api/employee-manifest?scope=w3&role=w3r')).body.manifest.employeeId, 'w3e')
  // 裹起来也要认
  const wrapped = await post({ scope: 'w4', manifest: { role: 'w4r', employeeId: 'w4e' } })
  assert.equal(wrapped.status, 200)
})

test('⑮ ★ 存一版：归属人走 `actor → by → null` 三级兜底（M20 真缺口）', async () => {
  await post({ scope: 'aud', role: 'aud-r', employeeId: 'aud-e', actor: 'alice' })
  await post({ scope: 'aud', role: 'aud-r2', employeeId: 'aud-e2', by: 'bob' })
  await post({ scope: 'aud', role: 'aud-r3', employeeId: 'aud-e3' })
  const rows = mod.db.prepare(
    "SELECT member FROM audit WHERE action LIKE 'employee-manifest.%' ORDER BY seq DESC LIMIT 3",
  ).all()
  // 最近三条是倒序：r3（无归属）、r2（by=bob）、r1（actor=alice）
  const members = rows.map((r) => r.member ?? null)
  assert.ok(members.includes('alice'), 'actor 要落进审计')
  assert.ok(members.includes('bob'), '★ 只认 `actor` 就会把 `by` 丢掉 —— 而审计里那个人会变成空')
  assert.ok(members.includes(null), '两个都不给就是没有归属，不是猜一个')
})

test('⑯ ★ 存一版：写门面是 **await** 的 —— 回执到手时库里已经有了（M22 真缺口）', async () => {
  const r = await post({ scope: 'sync', role: 'sync-r', employeeId: 'sync-e' })
  assert.equal(r.status, 200)
  // 回执回来的**同一个 tick 之后**立刻读，必须读得到：
  // 不 await 的话"回执先发、落库后到"，调用方 next 一句读就会扑空。
  const back = await get('/api/employee-manifest?scope=sync&role=sync-r')
  assert.equal(back.status, 200, '★ 回执说存好了，紧接着读就必须读得到')
  assert.equal(back.body.manifest.employeeId, 'sync-e')
})

test('⑰ 方法位：读一份只认 GET，写只认 POST', async () => {
  assert.equal((await fetch(base + '/api/employee-manifest', { method: 'POST', agent: false })).status, 404)
  assert.equal((await fetch(base + '/api/employee-manifests', { method: 'PUT', agent: false })).status, 404)
  assert.equal((await fetch(base + '/api/employee-manifests', { method: 'DELETE', agent: false })).status, 404)
})

test('⑱ 单数/复数**不是同一条**：单数要身份、复数不要', async () => {
  assert.equal((await get('/api/employee-manifests?scope=default')).status, 200, '复数列表不需要 role/employeeId')
  assert.equal((await get('/api/employee-manifest?scope=default')).status, 400, '单数没有身份就 400')
})

test('⑲ ★ 写门面抛错时要变成**一条干净的回执**，不是没回执（M22 真缺口）', async () => {
  // ★ 这一格是冲 M22（"不 await 写门面"）去的。
  //
  //   测试 ⑯ 咬不住 M22：因为**成功的**写入无论 await 与否，
  //   `handleRun` 都会把回执发出去，而我 `fetch` 等的是**回执**，
  //   等回执到手时库里早写完了 ⇒ 两者在 HTTP 上看起来完全一样。
  //
  //   > 一个"回执到手时库里已经有了"的判据，与一个"回执本来就要等写完才发"的事实，
  //   > 在我只测成功路径的时候是同一个东西。
  //
  //   真正的差别在**失败路径**上：`handleRun` 不加 await 时，
  //   它内部那次 reject 就没人接了（unhandled rejection）⇒
  //   调用方要么**收不到任何回执**（连接挂住），要么收到一个跟本请求无关的 500。
  //   库对疑似明文密钥是**抛**的（见 context-plan-store.test.mjs:272），正好用来逼出这条路。
  const r = await post({
    scope: 'sec', role: 'sec-r', employeeId: 'sec-e',
    limits: { apiKey: 'sk-live-abcdefghijklmnopqrstuvwxyz' },
  })
  assert.ok(r.status >= 400 && r.status < 500,
    `★ 拒收要变成一条 4xx 回执（实际 ${r.status}）—— 不 await 的话这里会挂住或变成 500`)
  assert.equal(r.body.code, 'CONTEXT_SOURCE_PLAINTEXT_SECRET', '错误码要能区分"含明文密钥"与别的失败')
  // ★ 顺带钉住一处**形状上的不对称**（量出来的，不是猜的）：
  //   成功回执有 `ok: true`，而**错误回执根本没有 `ok` 字段**（是 `{error, code, …}`）。
  //   *一个"回执总有 `ok`"的印象，与一个"错误那条路走的是另一个信封"的事实，
  //     在我只数成功路径的字段时是同一个东西。*
  assert.equal(r.body.ok, undefined, '错误信封没有 `ok` 字段（成功那条才有）')
  assert.equal(typeof r.body.error, 'string', '错误信封用 `error` 说人话')
})
