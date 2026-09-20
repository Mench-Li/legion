// ============================================================================
// PRT-316 切片 28：模型配置迁移（`/api/model-migration` 两条）
//   GET  /api/model-migration/plan    算一份计划（只读）
//   POST /api/model-migration/apply   按**确认过的指纹**执行
//
// ★ 本族搬走之前，这两条**路由**一把判据都没有（`survey-judges2` 报"强判据 0 套"）。
//   域模块 `team-hub/model-migration.mjs` 自己有 17 例（测的是**函数**），
//   但**没有任何一本用例把这条路走通过** —— 缺口在**那根线**上。
//
// ★★★ 本片钉住一处已验证的真缺陷（只钉现状、不修）：
//   `handleRun` 的 catch 是一个**定形白名单**信封（error/code/stateMachineCode/
//   missing/currentSettlement/currentVersion/state/…/field/fields/serverTimeMs）。
//   而这两条路由**刻意**往 err 上挂了两个不在名单里的东西：
//     · `err.plan = plan`          （计划不可执行时，用户该重看哪一份计划）
//     · `err.migration = result`   （半途失败时，**已经写进去了哪几个**）
//   ⇒ 两者**都被静默丢掉**。
//   第二条尤其重：域模块自己的注释写着
//   「半途失败必须**如实报告已写入的部分**：报成"整体失败"会让用户重跑，
//     而重跑会因为"已存在"而跳过——于是他永远不知道第一次到底做成了什么。」
//   ——**意图写下来了、代码写下来了、信封把它吃了**。
//   这与切片 24（`code: undefined` 被 JSON.stringify 丢掉）、切片 26
//   （模型配置警告被丢）是**同一类**：一个路由刻意挂上的结构化字段，
//   被一个固定形状的信封静默丢弃。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyModelMigration, MIGRATION_CODES } from './model-migration.mjs'
import { createModelStore } from './model-store.mjs'
import { createBindingStore } from './binding-store.mjs'

let mod
let base
let dbDir

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method, agent: false,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  let payload = null
  try { payload = await res.json() } catch { /* 无正文 */ }
  return { status: res.status, body: payload }
}
const plan = (qs = '') => call('GET', '/api/model-migration/plan' + qs)
const apply = (body) => call('POST', '/api/model-migration/apply', body)

/** 把老数据与档案都清空，让每条用例从同一个地方出发。 */
const reset = () => {
  mod.db.exec('DELETE FROM agent_models')
  mod.db.exec('DELETE FROM model_profiles')
  mod.db.exec('DELETE FROM employee_model_bindings')
}
const seedLegacy = (scope, role, provider, model) => mod.db.prepare(
  'INSERT INTO agent_models (scope, role, provider, model, updatedAt) VALUES (?, ?, ?, ?, ?)',
).run(scope, role, provider, model, new Date().toISOString())
const count = (t) => mod.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n

// ★ 顺序要紧：`TEAM_HUB_DB` 必须在**导入 server.mjs 之前**设好 ——
//   静态 `import` 会被提升到文件最前面，所以 server.mjs 只能用动态 import。
dbDir = mkdtempSync(join(tmpdir(), 'legion-migroutes-'))
process.env.TEAM_HUB_DB = join(dbDir, 'team.db')
mod = await import('./server.mjs')
await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
base = 'http://127.0.0.1:' + mod.server.address().port

// ★ 清理必须走 `after()`，不能挂 `process.on('exit')`：
//   服务器开着的时候事件循环**永不空**、`exit` 于是**永不触发** ⇒ 整个进程挂死。
//   （一个"我保证了收尾"的印象，与一个"那个收尾挂在永远不会到来的事件上"的事实，
//     在我没有让它自己跑完一次的时候是同一个东西。）
after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dbDir, { recursive: true, force: true })
})

// ── 计划（只读） ──────────────────────────────────────────────────────────
test('① ★ 不给 `runtimeType` **刻意不报 400** —— 200 + 一份"不可执行"的计划', async () => {
  reset()
  const r = await plan()
  assert.equal(r.status, 200, '★ 这是一个只读的"报告"：它要能告诉前端"你必须选一种协议"，而不是先撞一个 400')
  assert.equal(r.body.plan.ok, false)
  assert.equal(r.body.plan.code, MIGRATION_CODES.RUNTIME_TYPE_REQUIRED)
  assert.equal(r.body.plan.empty, true)
  assert.equal(r.body.legacyRowCount, 0)
})

test('② ★★ 顶层**刻意不放 `ok`**（两个 `ok` 在不同层级会读错）', async () => {
  reset()
  const r = await plan('?runtimeType=openai-compatible')
  assert.deepEqual(Object.keys(r.body).sort(), ['legacyRowCount', 'plan', 'serverTimeMs', 'summary'])
  assert.equal('ok' in r.body, false,
    '★ 一个说"这次查询成功了"，一个说"这份计划能不能执行" —— 同名不同义，放在两层就会读错')
  assert.deepEqual(Object.keys(r.body.plan).sort(),
    ['code', 'conflicts', 'digest', 'empty', 'hasAttention', 'message', 'needsAttention', 'ok', 'refused', 'skipped', 'toBind', 'toCreate'])
})

test('③ `runtimeType` 缺参数与全空白走同一条路；给了就用它', async () => {
  reset()
  for (const qs of ['', '?runtimeType=', '?runtimeType=%20%20']) {
    assert.equal((await plan(qs)).body.plan.code, MIGRATION_CODES.RUNTIME_TYPE_REQUIRED, `qs=${qs}`)
  }
  const ok = await plan('?runtimeType=x')
  assert.equal(ok.body.plan.ok, true)
  assert.equal(ok.body.plan.code, MIGRATION_CODES.OK)
})

test('④ 空库给协议：`empty:true` + 一句"没有需要迁移的"', async () => {
  reset()
  const r = await plan('?runtimeType=openai-compatible')
  assert.equal(r.body.plan.empty, true)
  assert.equal(r.body.plan.hasAttention, false)
  assert.equal(r.body.summary, '没有需要迁移的模型配置。')
  assert.equal(r.body.plan.digest, '0.0.4b6234d0', '★ 空计划的指纹是定的（`<档案数>.<绑定数>.<8位十六进制>`）')
})

test('⑤ 造老数据：同 `(provider,model)` 只建一个档案、每个岗位一条绑定', async () => {
  reset()
  seedLegacy('default', 'planner', 'provA', 'modelA')
  seedLegacy('default', 'writer', 'provA', 'modelA')
  seedLegacy('sp2', 'planner', 'provB', 'modelB')
  const r = await plan('?runtimeType=openai-compatible')
  assert.equal(r.body.legacyRowCount, 3)
  assert.deepEqual(r.body.plan.toCreate.map((x) => x.id), ['provA.modelA', 'provB.modelB'],
    '★ 三行老数据压成两个档案（同 provider+model 复用）')
  assert.deepEqual(r.body.plan.toBind.map((x) => `${x.scope}/${x.employeeRole}`), ['default/planner', 'default/writer', 'sp2/planner'],
    '★ 绑定**不**去重：两个岗位各一条')
  assert.match(r.body.plan.digest, /^2\.3\.[0-9a-f]{8}$/, '指纹是 `<档案数>.<绑定数>.<哈希>`')
  assert.match(r.body.summary, /将新建 2 个模型档案，建立 3 个岗位绑定/)
})

test('⑥ `needsAttention` 逐条说清"缺什么、为什么不能猜"', async () => {
  reset()
  seedLegacy('default', 'planner', 'provA', 'modelA')
  const p = (await plan('?runtimeType=openai-compatible')).body.plan
  assert.equal(p.hasAttention, true)
  assert.equal(p.needsAttention.length, 1)
  assert.deepEqual(p.needsAttention[0].missing, ['endpoint', 'credential'])
  assert.match(p.needsAttention[0].why, /不猜/)
  assert.match((await plan('?runtimeType=openai-compatible')).body.summary, /需要补 endpoint 与凭证/)
})

test('⑦ ★★ `ID_COLLISION`：两个不同的模型压成同一个 id ⇒ 拒绝（但列表还在）', async () => {
  reset()
  seedLegacy('s1', 'r1', 'a.b', 'c')
  seedLegacy('s1', 'r2', 'a', 'b.c')
  const p = (await plan('?runtimeType=openai-compatible')).body.plan
  assert.equal(p.ok, false)
  assert.equal(p.code, MIGRATION_CODES.ID_COLLISION)
  assert.deepEqual(p.conflicts, [{ id: 'a.b.c', a: { provider: 'a.b', model: 'c' }, b: { provider: 'a', model: 'b.c' } }])
  // ★ 拒了，但 `toCreate` **仍然列着一个** —— 计划只是"报告"，不是"命令"。
  //   真正拦住它的是 `apply` 那一句 `plan.ok !== true`（见 ⑯）。
  assert.deepEqual(p.toCreate.map((x) => x.id), ['a.b.c'],
    '★ 被拒的计划**仍然带着动作列表** ⇒ 谁要是只看 `toCreate` 而不看 `plan.ok`，就会照着它去建')
})

test('⑧ 幂等：档案已存在 ⇒ 进 `skipped` 且**不覆盖**', async () => {
  reset()
  seedLegacy('s2', 'r1', 'provX', 'modelX')
  mod.db.prepare(`INSERT INTO model_profiles
    (id, display_name, runtime_type, provider, model, endpoint, secret_ref, reasoning_effort, limits_json, version, created_at_ms, updated_at_ms)
    VALUES ('provX.modelX','x','openai-compatible','provX','modelX',NULL,NULL,'medium','{}',1,1,1)`).run()
  const p = (await plan('?runtimeType=openai-compatible')).body.plan
  assert.equal(p.code, MIGRATION_CODES.OK)
  assert.deepEqual(p.toCreate, [], '★ 同 id 的档案不重建')
  assert.deepEqual(p.toBind.map((x) => `${x.scope}/${x.employeeRole}`), ['s2/r1'], '档案不用建，但绑定还缺')
  assert.equal(p.skipped.length, 1)
  assert.match(p.skipped[0].reason, /不覆盖/)
})

test('⑨ 源里疑似密钥 ⇒ `SECRET_IN_SOURCE` + `refused` 说清是哪一行', async () => {
  reset()
  seedLegacy('s3', 'r1', 'provY', 'sk-live-abcdefghijklmnopqrstuvwxyz')
  const p = (await plan('?runtimeType=openai-compatible')).body.plan
  assert.equal(p.ok, false)
  assert.equal(p.code, MIGRATION_CODES.SECRET_IN_SOURCE)
  assert.deepEqual(p.refused, [{ index: 0, code: MIGRATION_CODES.SECRET_IN_SOURCE, reason: '这一行的 model 看起来是密钥值。迁移只搬非敏感配置' }])
  assert.deepEqual(p.toCreate, [])
})

test('⑩ `GET plan` 是只读的：查完库里的行数不变', async () => {
  reset()
  seedLegacy('s4', 'r1', 'p', 'm')
  const before = [count('agent_models'), count('model_profiles'), count('employee_model_bindings')]
  await plan('?runtimeType=x')
  await plan('?runtimeType=x')
  assert.deepEqual([count('agent_models'), count('model_profiles'), count('employee_model_bindings')], before)
})

// ── 执行 ──────────────────────────────────────────────────────────────────
/** 造一份"可执行"的计划，返回它的指纹。 */
const actionable = async (scope = 'default') => {
  reset()
  seedLegacy(scope, 'planner', 'provA', 'modelA')
  return (await plan('?runtimeType=openai-compatible')).body.plan.digest
}

test('⑪ `apply` 需要 `actor`：谁改的配置必须留痕', async () => {
  const digest = await actionable()
  const r = await apply({ runtimeType: 'openai-compatible', expectedDigest: digest })
  assert.equal(r.status, 409)
  assert.equal(r.body.code, 'ACTOR_REQUIRED')
  assert.match(String(r.body.error), /actor|留痕/)
  assert.equal(count('model_profiles'), 0, '★ 留痕要求是在**写库那一步**拦住的 ⇒ 一个档案都没建')
})

test('⑫ ★★★ 半途报告被丢掉：域函数**明明**返回了 `created`/`bound`，回执里没有', async () => {
  const digest = await actionable()
  const r = await apply({ runtimeType: 'openai-compatible', expectedDigest: digest })
  assert.equal(r.status, 409)
  // ★ 路由在 `err.migration = result` 上挂了域层的返回；`handleRun` 的 catch 是**定形白名单**，
  //   `migration` 不在名单里 ⇒ 一个字节都没出去。
  assert.equal('migration' in r.body, false,
    '★ 若这条红了说明信封开始透传 `migration` 了 —— 那是**接线修对了**，' +
    '请改成断言 `r.body.migration.created` 之类。')
  // ★★ 这里**不能**放 `assert.equal('plan' in r.body, false)`：
  //   这一条走的是"计划**是**可执行的、域层写库时才抛"那条路，
  //   而 `err.plan` **只在那条计划被拒的路上**才被挂上（见 ⑯/⑰）。
  //   放在这里的话它**永远为真** —— 是一句不可能失败的断言。
  //   （这是反方向破验 R2 抓出来的：往信封里加 `plan` 之后这里**没有变红**，
  //     因为 `plan: undefined` 会被 `JSON.stringify` 丢掉。真该放的地方是 ⑯。）

  // 两边对照：**同一个域函数**对一份**非空**计划，确实返回了那个被丢掉的字段。
  // ★ 第一版我传的是 `toCreate: []` —— 空计划什么都不做、于是**根本走不到** actor 那一步，
  //   它就顺顺当当地 `ok:true` 了。对照实验必须让**同一条路**被走到。
  //   > 一个"我拿同一个函数对了一遍"的印象，与一个"我喂给它的是一份**什么都不做**的计划、
  //   > 于是它压根没经过那个会抛的分支"的事实，在我没有把计划造出内容的时候是同一个东西。
  const realModelStore = createModelStore({ db: mod.db, clock: () => Date.now() })
  const realBindingStore = createBindingStore({ db: mod.db, clock: () => Date.now(), readProfiles: () => [] })
  const direct = await applyModelMigration(
    {
      ok: true, digest, code: MIGRATION_CODES.OK,
      toCreate: [{ id: 'provA.modelA', displayName: 'provA / modelA', runtimeType: 'openai-compatible', provider: 'provA', model: 'modelA' }],
      toBind: [],
    },
    { modelStore: realModelStore, bindingStore: realBindingStore, actor: null, expectedDigest: null },
  )
  assert.equal(direct.ok, false)
  assert.equal(direct.code, 'ACTOR_REQUIRED')
  assert.deepEqual(Object.keys(direct).sort(), ['bound', 'code', 'created', 'failed', 'message', 'ok'],
    '★ 域函数返回了 `created`/`bound`/`failed` 三格 —— 而这**正是**回执里缺掉的那些')
  assert.deepEqual(direct.failed, { created: 0, bound: 0 },
    '★ `failed.created`/`failed.bound` 就是"第一次到底做成了什么"的答案，用户拿不到')
})

test('⑬ `apply` 成功：`{ok:true, migration, plan}`，且**真的写进了库**', async () => {
  const digest = await actionable()
  const r = await apply({ runtimeType: 'openai-compatible', expectedDigest: digest, actor: '业主' })
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.body).sort(), ['migration', 'ok', 'plan'])
  assert.equal(r.body.ok, true)
  assert.deepEqual(r.body.migration.created, ['provA.modelA'])
  assert.deepEqual(r.body.migration.bound, ['default/planner'])
  assert.equal(r.body.migration.failed, null)
  assert.equal(Object.keys(r.body.plan).length, 12, '★ 成功时顶层**有** `plan`（失败时没有）')
  assert.deepEqual(mod.db.prepare('SELECT id FROM model_profiles').all().map((x) => x.id), ['provA.modelA'])
  // ★ `node:sqlite` 的 `.all()` 返回的是**无原型对象**，而 `deepStrictEqual` **比原型** ——
  //   两边打印出来一模一样，却会红。所以先摊平成普通对象再比。
  //   （一个"两行看起来完全相同"的判据，与一个"它们差在**原型**上"的事实，
  //     在我只把两边打印出来看的时候是同一个东西。）
  const rows = mod.db.prepare('SELECT scope, employee_role, primary_profile FROM employee_model_bindings').all()
  assert.deepEqual(rows.map((r) => ({ ...r })),
    [{ scope: 'default', employee_role: 'planner', primary_profile: 'provA.modelA' }])
  assert.equal((await plan('?runtimeType=openai-compatible')).body.plan.empty, true, '★ 迁移完再算：没有要做的了')
})

test('⑭ ★★ 指纹不对 ⇒ `PLAN_STALE`，而**纠正它的那个数**恰好不在回执里', async () => {
  const digest = await actionable()
  const r = await apply({ runtimeType: 'openai-compatible', expectedDigest: '0.0.deadbeef', actor: '业主' })
  assert.equal(r.status, 409)
  assert.equal(r.body.code, MIGRATION_CODES.PLAN_STALE)
  assert.equal(count('model_profiles'), 0, '★ 指纹不符 ⇒ 一个字节都不写')
  // 域层返回里带着 `expectedDigest` 与 `actualDigest`——后者正是"你该重新确认哪一个"的答案
  assert.equal('migration' in r.body, false)
  assert.equal('actualDigest' in r.body, false,
    '★ 用户收到的是"计划变了，请重新看一眼"，而**变到哪个指纹**这个数被信封吃了')
  assert.notEqual(digest, '0.0.deadbeef')
})

test('⑮ ★★ `expectedDigest` 省略 / `null` / 空串 一律**跳过**指纹比对', async () => {
  for (const v of [undefined, null, '']) {
    const digest = await actionable('s' + String(v))
    const body = { runtimeType: 'openai-compatible', actor: '业主', ...(v === undefined ? {} : { expectedDigest: v }) }
    const r = await apply(body)
    assert.equal(r.status, 200, `expectedDigest=${JSON.stringify(v)} 应当跳过比对并执行`)
    assert.equal(r.body.ok, true)
  }
  // ★ 这是**一个可以关掉的安全闸**：不传就是不比对。它不是"默认安全"，
  //   而是"谁不传谁就没有这层保护" —— 契约 `applyModelMigration` 里写得很清楚，
  //   但"这个闸能关"这件事本身值得被钉住：它是**故意的**，不是漏的。
})

test('⑯ 计划不可执行时 `apply` 也拒（`plan.ok !== true` 那一道）', async () => {
  reset()
  seedLegacy('s1', 'r1', 'a.b', 'c')
  seedLegacy('s1', 'r2', 'a', 'b.c')
  const r = await apply({ runtimeType: 'openai-compatible', actor: '业主' })
  assert.equal(r.status, 409)
  assert.equal(r.body.code, MIGRATION_CODES.ID_COLLISION)
  assert.equal(count('model_profiles'), 0, '★ ⑦ 里那个"被拒但 toCreate 还在"的计划，在这里被拦住了')
  // ★★ 这里才是 `err.plan` 真正被挂上、又真正被丢掉的地方：
  //   路由写了 `err.plan = plan`，而 `handleRun` 的定形信封里没有 `plan` ⇒ 一个字节都没出去。
  //   客户端因此拿不到"是哪份计划不可执行"，只能凭一句散文去猜。
  assert.equal('plan' in r.body, false,
    '★ 若这条红了说明信封开始透传 `plan` 了 —— 那是**接线修对了**，请改成断言 `r.body.plan.code` 之类。')
  assert.equal('migration' in r.body, false, '这条路上 `err.migration` 也没被挂（域层还没开始写）')
})

test('⑰ 源里有密钥 ⇒ `apply` 也拒，且不写任何东西', async () => {
  reset()
  seedLegacy('s3', 'r1', 'provY', 'sk-live-abcdefghijklmnopqrstuvwxyz')
  const r = await apply({ runtimeType: 'openai-compatible', actor: '业主' })
  assert.equal(r.status, 409)
  assert.equal(r.body.code, MIGRATION_CODES.SECRET_IN_SOURCE)
  assert.equal(count('model_profiles'), 0)
})

test('⑱ 空计划也能 apply（幂等重放）：建 0 个、绑 0 个，且**不是错误**', async () => {
  reset()
  const r = await apply({ runtimeType: 'openai-compatible', actor: '业主' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.deepEqual(r.body.migration.created, [])
  assert.deepEqual(r.body.migration.bound, [])
  assert.equal(r.body.migration.failed, null, '★ "无事可做"与"做到一半失败"必须分得开')
})

test('⑲ 迁移跑过之后旧指纹必然陈旧（库变了 ⇒ 计划也变了）', async () => {
  const digest = await actionable()
  assert.equal((await apply({ runtimeType: 'openai-compatible', expectedDigest: digest, actor: '业主' })).status, 200)
  const again = await apply({ runtimeType: 'openai-compatible', expectedDigest: digest, actor: '业主' })
  assert.equal(again.status, 409)
  assert.equal(again.body.code, MIGRATION_CODES.PLAN_STALE,
    '★ 这正是指纹要防的事：重放一份已经执行过的确认，必须被挡住而不是"再跑一遍"')
})

test('⑳ 方法位：每条路径只认自己那个方法', async () => {
  for (const [m, p] of [['POST', '/api/model-migration/plan'], ['GET', '/api/model-migration/apply'], ['DELETE', '/api/model-migration/plan']]) {
    assert.equal((await call(m, p)).status, 404, `${m} ${p} 应当 404`)
  }
  assert.equal((await fetch(base + '/api/model-migration/plan?runtimeType=x', { agent: false })).status, 200,
    '★ 读路径不查授权（与别的读路径一致）')
})
