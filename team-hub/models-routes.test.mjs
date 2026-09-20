// ============================================================================
// PRT-316 切片 26：智能体默认模型配置（`/api/models` 三条）
//   GET  /api/models         读一版（可按 scope 过滤）
//   POST /api/models         配一个（PRT-252 产品化校验 + 结构化错误）
//   POST /api/models/clear   清一个
//
// ★ 本族在搬走之前**一把判据都没有**（`survey-judges2` 对三个路径全报"强判据 0 套"）。
//   形状全部是先量出来的（`probe26-models.mjs`）：
//     · 读是**裸数组**，每行恰好 `{scope, role, provider, model}`（**没有 updatedAt**）
//     · 写走 `handleWrite` ⇒ 信封是 `{ok:true, task:{…}}`
//     · 校验有四档、**每一档的 `code` 不同**，且未知供应商/型号会**点名候选**
//     · `scope` 缺省落 `'default'`、`role` 与 `scope` 都会 trim
//     · `clear` 是**幂等**的（清不存在的也 200）
//
// ★★★ 而本族挖出一条**真缺陷**（第三个同族缺口，见 ⑩⑪ 两条）：
//   `runtime/contracts/model-config.mjs` 的段首写着，逐字：
//     「**不允许存在"看起来成功了但跑不了"的沉默状态。**」
//   它确实为"档案没配凭证"算出 `MODEL_CONFIG_NO_CREDENTIAL` 警告（⑪ 直接量给你看），
//   而路由 `if (verdict.ok !== true) throw modelConfigErrorFor(verdict)` 之后
//   **再也没有读过 `verdict`** ⇒ 警告被丢掉，回执只有 `{scope, role, provider, model}`。
//   而唯一会用到警告的那个函数（`describeModelConfigResult`）**只在失败路径上被调用**：
//   它的警告分支有用例守着（`runtime/contracts/model-config.test.mjs` 里
//   `assert.match(describeModelConfigResult(warned), /运行会失败/)`），
//   却**没有任何路由**会把一个带警告的结果递进去。
//   ⇒ 那条用例证明的是**函数**对；缺口在**那根线**上。
//   本片**只搬路由、只钉住现状**（同切片 22 的 `limit=2.7`、切片 24 的 `code: undefined`）。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const W = (body) => ({ by: 'tester', ...body })
const get = (p) => call('GET', p)
const post = (p, body) => call('POST', p, body)

/**
 * 直接落库登记一个模型档案。
 * ★ 本族**先**要库里**有档案**才走得到"配得上去"那条路：一个档案都没有时，
 *   校验器一律给 `NO_PROFILES`（它刻意把"还没登记"与"供应商未知"分开）。
 */
const seedProfile = (id, provider, model, { secretRef = 'ref-' + id, displayName = '档案 ' + id } = {}) => {
  const t = Date.now()
  mod.db.prepare(`INSERT OR IGNORE INTO model_profiles
    (id, display_name, runtime_type, provider, model, endpoint, secret_ref,
     reasoning_effort, limits_json, version, created_at_ms, updated_at_ms, deleted_at_ms)
    VALUES (?, ?, 'openai-compatible', ?, ?, NULL, ?, 'medium', '{}', 1, ?, ?, NULL)`)
    .run(id, displayName, provider, model, secretRef, t, t)
}

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-modelroutes-'))
  process.env.TEAM_HUB_DB = join(dbDir, 'team.db')
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
  // ★ 本族**先**要库里有档案，才走得到"配得上去"那条路：一个档案都没有时，
  //   校验器一律给 `NO_PROFILES`（它刻意把"还没登记"与"供应商未知"分开）。
  //   所以这两条必须**在任何写用例之前**就位 —— 放到某条用例里会让它前面的用例全红。
  seedProfile('mp-a', 'prov-a', 'model-x')
  seedProfile('mp-b', 'prov-b', 'model-y')
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dbDir, { recursive: true, force: true })
})

// ── 读 ────────────────────────────────────────────────────────────────────
test('① 读：空库是**裸数组** `[]`（不是 `{ok, models}`）', async () => {
  const r = await get('/api/models')
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.body), '`GET /api/models` 直接给数组')
  assert.deepEqual(r.body, [])
})

test('② 读：每行恰好四格 `{scope, role, provider, model}` —— **没有 `updatedAt`**', async () => {
  await post('/api/models', W({ role: 'r-shape', provider: 'prov-a', model: 'model-x' }))
  const rows = await get('/api/models')
  assert.equal(rows.body.length, 1)
  assert.deepEqual(Object.keys(rows.body[0]).sort(), ['model', 'provider', 'role', 'scope'],
    '★ 库里那张表有 `updatedAt` 一列，但这条 SELECT **没选它** —— ' +
    '照表结构去猜回执形状就会多断言一格')
})

test('③ 读：`?scope=` 过一版，未知空间给空数组（不是 404）', async () => {
  await post('/api/models', W({ role: 'r-s1', provider: 'prov-a', model: 'model-x', scope: 'sc1' }))
  await post('/api/models', W({ role: 'r-s2', provider: 'prov-a', model: 'model-x', scope: 'sc2' }))
  const sc1 = await get('/api/models?scope=sc1')
  assert.equal(sc1.status, 200)
  assert.deepEqual(sc1.body.map((x) => x.role), ['r-s1'])
  assert.deepEqual((await get('/api/models?scope=never')).body, [])
})

// ── 写的四道门 ────────────────────────────────────────────────────────────
test('④ 写：要 `body.by`（缺了 400，且**什么都没写进去**）', async () => {
  const r = await post('/api/models', { role: 'r-by', provider: 'prov-a', model: 'model-x' })
  assert.equal(r.status, 400)
  assert.match(String(r.body.error), /by/)
  assert.ok(!(await get('/api/models')).body.some((x) => x.role === 'r-by'))
})

test('⑤ 写：`role` 会 trim；缺了或全空白 ⇒ 400「缺少参数 role」', async () => {
  for (const v of [undefined, '', '   ', 123, null]) {
    const r = await post('/api/models', W({ role: v, provider: 'prov-a', model: 'model-x' }))
    assert.equal(r.status, 400, `role=${JSON.stringify(v)} 应当被拒`)
    assert.match(String(r.body.error), /role/)
  }
  const ok = await post('/api/models', W({ role: '  r-trim  ', provider: 'prov-a', model: 'model-x' }))
  assert.equal(ok.body.task.role, 'r-trim')
})

test('⑥ 写：`provider`/`model` 缺一不可 ⇒ 400「缺少 provider 或 model」', async () => {
  for (const body of [{ role: 'r6' }, { role: 'r6', provider: 'p' }, { role: 'r6', model: 'm' }, { role: 'r6', provider: '  ', model: 'm' }]) {
    const r = await post('/api/models', W(body))
    assert.equal(r.status, 400, `${JSON.stringify(body)} 应当被拒`)
    assert.match(String(r.body.error), /provider|model/)
    // ★ 光比"错误文案里有 provider/model"是不够的：校验器的 `EMPTY_SELECTION` 文案
    //   （`没有选择模型：缺少 provider/model`）**也**含这两个词。
    //   两条拒绝路径真正的差别在**信封**上：
    //     · 这一条是手写的 `throw new Error(...)` ⇒ 只有 `{error}`，**没有 code/field/hint**
    //     · 校验器那条经 `modelConfigErrorFor` ⇒ 带 `code` / `field` / `hint` / `candidates`
    //   > 一个"我把缺参数的情况也断言过了"的印象，与一个"我的正则同时匹配了**另一条**路径的文案、
    //   > 于是把它删掉也不会红"的事实，在我只比那一句话的时候是同一个东西。
    assert.equal(r.body.code, undefined, '这一档是手写守卫，不带结构化 code（带 code 的是校验器那一档）')
    assert.equal(r.body.field, undefined)
    assert.equal(r.body.hint, undefined)
  }
})

// ── 产品化校验的四档（PRT-252） ────────────────────────────────────────────
test('⑦ ★ 库里**一个档案都没有** ⇒ `NO_PROFILES`（**不是**"未知供应商"）', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'legion-models-empty-'))
  // 另起一个进程内实例做不到（模块是单例），改用量校验器本身 + 清空那张表两种办法：
  // 这里直接把档案全部置成墓碑，验证 `list()` 过滤掉它们之后的那一档。
  const saved = mod.db.prepare('SELECT id FROM model_profiles WHERE deleted_at_ms IS NULL').all()
  mod.db.prepare('UPDATE model_profiles SET deleted_at_ms = ? WHERE deleted_at_ms IS NULL').run(Date.now())
  try {
    const r = await post('/api/models', W({ role: 'r7', provider: '随便', model: '随便' }))
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'MODEL_CONFIG_NO_PROFILES',
      '★ 说"未知供应商"会把用户引向查拼写，而真正该做的是"先去登记一个" —— 两件事必须分开')
    assert.deepEqual(r.body.candidates, [])
    assert.ok(r.body.hint, '这一档要带"下一步做什么"')
  } finally {
    mod.db.prepare('UPDATE model_profiles SET deleted_at_ms = NULL').run()
    assert.ok(saved.length > 0)
  }
  rmSync(empty, { recursive: true, force: true })
})

test('⑧ ★ 未知供应商 ⇒ `UNKNOWN_PROVIDER`，`field=provider`，并**点名已登记的供应商**', async () => {
  const r = await post('/api/models', W({ role: 'r8', provider: '不存在的供应商', model: 'model-x' }))
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'MODEL_CONFIG_UNKNOWN_PROVIDER')
  assert.equal(r.body.field, 'provider', '前端要靠 field 把错误落到具体输入框')
  assert.deepEqual([...r.body.candidates].sort(), ['prov-a', 'prov-b'],
    '★ 候选要来自**这台机器上真的登记过**的档案，不是前端那份硬编码表')
  assert.match(String(r.body.error), /不存在的供应商/)
})

test('⑨ ★ 供应商对、型号不对 ⇒ `UNKNOWN_MODEL`，`field=model`，候选是**该供应商下**的型号', async () => {
  const r = await post('/api/models', W({ role: 'r9', provider: 'prov-a', model: '不存在的型号' }))
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'MODEL_CONFIG_UNKNOWN_MODEL')
  assert.equal(r.body.field, 'model')
  assert.deepEqual(r.body.candidates, ['model-x'], '只列这个供应商下的，不列别的供应商的型号')
})

test('⑩ 配得上 ⇒ `{ok:true, task:{scope, role, provider, model}}`', async () => {
  const r = await post('/api/models', W({ role: 'r10', provider: 'prov-a', model: 'model-x' }))
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.deepEqual(r.body.task, { scope: 'default', role: 'r10', provider: 'prov-a', model: 'model-x' })
})

// ── ★★★ 真缺陷：警告被丢掉 ────────────────────────────────────────────────
test('⑪ ★★★ 校验器**会**为"没配凭证"算出警告 —— 先证明这半句', async () => {
  const { validateAgentModelSelection, MODEL_CONFIG_WARNINGS } = await import('../runtime/contracts/model-config.mjs')
  const verdict = validateAgentModelSelection({
    provider: 'prov-c', model: 'model-z',
    profiles: [{ id: 'mp-nocred', provider: 'prov-c', model: 'model-z', hasCredential: false }],
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.code, 'MODEL_CONFIG_OK')
  assert.equal(verdict.warnings.length, 1)
  assert.equal(verdict.warnings[0].code, MODEL_CONFIG_WARNINGS.NO_CREDENTIAL)
  assert.match(verdict.warnings[0].message, /运行会失败/)
})

test('⑫ ★★★ …而 `POST /api/models` 配一个**没凭证**的档案时，回执里**没有**警告', async () => {
  // 契约文件（`runtime/contracts/model-config.mjs` 段首）逐字写着：
  //   「**不允许存在"看起来成功了但跑不了"的沉默状态。**」
  // 而路由是 `if (verdict.ok !== true) throw modelConfigErrorFor(verdict)`，
  // 之后 `verdict` 再没被读过 —— 于是 `warnings` 被丢掉。
  seedProfile('mp-nocred', 'prov-c', 'model-z', { secretRef: null })
  const r = await post('/api/models', W({ role: 'r-nocred', provider: 'prov-c', model: 'model-z' }))
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  // ★ 判据钉住**现状**：回执的 `task` 恰好四格，`warnings` 连键都没有。
  assert.deepEqual(Object.keys(r.body.task).sort(), ['model', 'provider', 'role', 'scope'])
  assert.equal(r.body.warnings, undefined, '回执顶层也没有 warnings')
  assert.ok(!JSON.stringify(r.body).includes('NO_CREDENTIAL'))
  assert.ok(!JSON.stringify(r.body).includes('运行会失败'),
    '★ 若这条红了：说明有人把警告接出来了 —— 那是**修对了**。' +
    '请把断言改成"回执里有 NO_CREDENTIAL 警告"，并把本测试标题里的"没有"去掉。' +
    '（契约的原文是"不允许存在看起来成功了但跑不了的沉默状态"，' +
    '而这条路由现在**正是**那个状态：用户看到 200，跑的时候才发现没凭证。）')
})

test('⑬ ★ 那个唯一会用警告的函数，只在**失败**路径上被调到', async () => {
  // `describeModelConfigResult` 的警告分支是被用例守着的
  //（`runtime/contracts/model-config.test.mjs`：`assert.match(describeModelConfigResult(warned), /运行会失败/)`），
  // 但 `modelConfigErrorFor` 只在 `verdict.ok !== true` 时被调用 ——
  // 而警告只在 `ok === true` 时存在。两根线**接不上**。
  const { modelConfigErrorFor, describeModelConfigResult } = await import('../runtime/contracts/model-config.mjs')
  const warned = { ok: true, code: 'MODEL_CONFIG_OK', message: '模型配置有效。', warnings: [{ code: 'MODEL_CONFIG_NO_CREDENTIAL', message: 'x 还没有配置凭证，现在保存可以，但运行会失败。' }] }
  assert.match(describeModelConfigResult(warned), /运行会失败/, '函数本身是对的')
  const failed = { ok: false, code: 'MODEL_CONFIG_UNKNOWN_PROVIDER', message: 'm', hint: 'h', field: 'provider', candidates: [] }
  const err = modelConfigErrorFor(failed)
  assert.equal(err.code, 'MODEL_CONFIG_UNKNOWN_PROVIDER')
  assert.equal(err.field, 'provider')
  // ★ 失败路径上 `describeModelConfigResult` 走的是**失败分支**（message + hint），
  //   永远走不到警告分支 —— 所以那个分支在这条链上是死代码。
  assert.match(err.message, /m h/)
})

// ── upsert / scope / clear ────────────────────────────────────────────────
test('⑭ 写：同一个 `(scope, role)` 配两次是 upsert，只留一行、取后写的', async () => {
  await post('/api/models', W({ role: 'r-up', scope: 'up', provider: 'prov-a', model: 'model-x' }))
  const second = await post('/api/models', W({ role: 'r-up', scope: 'up', provider: 'prov-b', model: 'model-y' }))
  assert.equal(second.status, 200)
  const n = mod.db.prepare("SELECT COUNT(*) AS n FROM agent_models WHERE scope='up' AND role='r-up'").get().n
  assert.equal(n, 1, '★ 不 upsert 的话同一个角色会有两行，读出来是两份、谁生效取决于查询顺序')
  const rows = (await get('/api/models?scope=up')).body
  assert.deepEqual(rows, [{ scope: 'up', role: 'r-up', provider: 'prov-b', model: 'model-y' }])
})

test('⑮ 写：`scope` 缺或全空白 ⇒ 落 `"default"`；给了会 trim', async () => {
  const a = await post('/api/models', W({ role: 'r-sc1', provider: 'prov-a', model: 'model-x' }))
  assert.equal(a.body.task.scope, 'default')
  const b = await post('/api/models', W({ role: 'r-sc2', provider: 'prov-a', model: 'model-x', scope: '   ' }))
  assert.equal(b.body.task.scope, 'default', '全空白要落缺省，不能当成一个名叫空白的空间')
  const c = await post('/api/models', W({ role: 'r-sc3', provider: 'prov-a', model: 'model-x', scope: '  sX  ' }))
  assert.equal(c.body.task.scope, 'sX')
})

test('⑯ 清：缺 `role` ⇒ 400；清掉之后读不到', async () => {
  assert.equal((await post('/api/models/clear', W({}))).status, 400)
  await post('/api/models', W({ role: 'r-clr', scope: 'clr', provider: 'prov-a', model: 'model-x' }))
  assert.equal((await get('/api/models?scope=clr')).body.length, 1)
  const r = await post('/api/models/clear', W({ role: 'r-clr', scope: 'clr' }))
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, task: { scope: 'clr', role: 'r-clr' } })
  assert.deepEqual((await get('/api/models?scope=clr')).body, [])
})

test('⑰ 清：是**幂等**的 —— 清一个不存在的也 200（与"没配过"同一个结果）', async () => {
  const r = await post('/api/models/clear', W({ role: '从来没配过' }))
  assert.equal(r.status, 200, '★ 报 404 的话，调用方就得把"已经没了"当成错误处理')
  assert.equal(r.body.ok, true)
})

test('⑱ 清：`scope` 同样落 `"default"`（清的是那个空间的，不是全体的）', async () => {
  await post('/api/models', W({ role: 'r-same', scope: 'spaceA', provider: 'prov-a', model: 'model-x' }))
  await post('/api/models', W({ role: 'r-same', scope: 'spaceB', provider: 'prov-a', model: 'model-x' }))
  await post('/api/models/clear', W({ role: 'r-same', scope: 'spaceA' }))
  assert.deepEqual((await get('/api/models?scope=spaceA')).body, [])
  assert.equal((await get('/api/models?scope=spaceB')).body.length, 1, '★ 不带 scope 清会误伤别的空间')
})

test('⑲ 方法位：每条路径只认自己那个方法', async () => {
  for (const [m, p] of [['GET', '/api/models/clear'], ['DELETE', '/api/models'], ['PUT', '/api/models/clear'], ['DELETE', '/api/models/clear']]) {
    assert.equal((await call(m, p)).status, 404, `${m} ${p} 应当 404`)
  }
})
