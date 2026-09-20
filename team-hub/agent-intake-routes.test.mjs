// ============================================================================
// PRT-316 切片 46：智能体登记 + 选人入编 —— 2 条
//   POST /api/agents                登记/更新编队岗位（PRT-402：与岗位清单**同事务**）
//   POST /api/spaces/:id/agents     选人入编（★ 本族唯一的 `prefix+suffix` 匹配）
//
// ★★★ 本片两处"宁可少写，也不写假话"的纪律：
//   ① **调用方没给边界内容就不写清单** —— 替它写一份空的，`allowedTools: []`
//      会被模型读成"这个岗位不允许使用任何工具"，那是一条**假规则**；
//   ② `employeeId` 缺省是 `${scope}/${role}`（岗位在空间里的**地址**），不是"某个人"。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgentIntakeRoutes } from './routes/agent-intake.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-agent-intake-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const post = async (p, body) => {
  const res = await fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  })
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}

const reset = () => {
  mod.db.prepare('DELETE FROM roster').run()
  mod.db.prepare('DELETE FROM audit').run()
}
const roster = (scope) => mod.db.prepare('SELECT * FROM roster WHERE scope = ? ORDER BY sort').all(scope)
const audits = () => mod.db.prepare('SELECT * FROM audit ORDER BY rowid').all()
// ★ 清单落在 `employee_manifests` 表（键是 `(scope, role)`，另有 `employee_id` 列）。
//   `contextPlanStore` **没有导出** —— 第一版我用 `mod.contextPlanStore()` 去读，
//   `TypeError: mod.contextPlanStore is not a function`。直接查表更实在。
const manifests = () => mod.db.prepare('SELECT * FROM employee_manifests').all()
const manifestFor = (role) => manifests().find((m) => m.role === role) ?? null

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关 */ }
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

// ══════════════════════ POST /api/agents ══════════════════════

test('① ★★ 登记成功 ⇒ 200 带 `{scope,role,name,employeeManifest}`，且真的落 roster', async () => {
  reset()
  const r = await post('/api/agents', { by: 'general', role: 'dev', name: '开发' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.ok, true)
  assert.deepEqual(r.body.task, { scope: 'default', role: 'dev', name: '开发', employeeManifest: null },
    '★★ 没给边界内容 ⇒ `employeeManifest` 是 **null**')
  const rows = roster('default')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].role, 'dev'); assert.equal(rows[0].name, '开发')
  assert.equal(rows[0].avatar, '🤖', '★ avatar 缺省是 🤖')
  assert.equal(rows[0].kind, '', '★ kind 缺省是空串')
})

test('② ★★ `role` 必须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`', async () => {
  reset()
  for (const role of ['', 'Dev', '-x', 'x_y', 'x y', 'x'.repeat(65)]) {
    const r = await post('/api/agents', { by: 'general', role, name: 'n' })
    assert.equal(r.status, 400, `★★ role=${JSON.stringify(role)} 应当被拒`)
    assert.match(String(r.body.error), /智能体 role 非法/)
  }
  assert.equal((await post('/api/agents', { by: 'general', role: 'ok-1', name: 'n' })).status, 200)
  assert.equal((await post('/api/agents', { by: 'general', role: 'x'.repeat(64), name: 'n' })).status, 200, '★ 64 字符要过')
})

test('③ ★★ 缺 / 空白 `name` ⇒ 400', async () => {
  reset()
  for (const name of [undefined, '', '   ']) {
    const r = await post('/api/agents', { by: 'general', role: 'r', name })
    assert.equal(r.status, 400, `★★ name=${JSON.stringify(name)}`)
    assert.match(String(r.body.error), /缺少参数 name/)
  }
})

test('④ ★★ 幂等 upsert + `sort` 递增 + 审计 `agent:create`', async () => {
  reset()
  await post('/api/agents', { by: 'general', role: 'a', name: 'A' })
  await post('/api/agents', { by: 'general', role: 'b', name: 'B' })
  await post('/api/agents', { by: 'general', role: 'a', name: 'A2' })
  const rows = roster('default')
  assert.equal(rows.length, 2, '★★ 同一个 (scope,role) 不新增行')
  assert.deepEqual(rows.map((r) => r.role), ['a', 'b'])
  assert.deepEqual(rows.map((r) => r.sort), [0, 1], '★ sort 从 0 递增')
  assert.equal(rows.find((r) => r.role === 'a').name, 'A2', '★ 覆盖 name')
  assert.deepEqual(audits().filter((a) => a.action === 'agent:create').length, 3, '★ 每次登记都记一条审计')
})

test('⑤ ★★ `body.scope` 覆盖写作用域', async () => {
  reset()
  const r = await post('/api/agents', { by: 'general', role: 'r', name: 'n', scope: 'A' })
  assert.equal(r.body.task.scope, 'A')
  assert.equal(roster('A').length, 1)
  assert.equal(roster('default').length, 0, '★★ 不能顺手落到写作用域')
})

test('⑥ ★★★ **没给边界内容 ⇒ 一份清单都不写**（写空清单 = 一条假规则）', async () => {
  reset()
  const r = await post('/api/agents', { by: 'general', role: 'nob', name: 'N' })
  assert.equal(r.body.task.employeeManifest, null, '★★★ manifestRef 必须是 null')
  // ★★★ 真规则是「不写」：`allowedTools: []` 会被模型读成"这个岗位不能用任何工具"
  const m = manifestFor('nob')
  assert.equal(m, null,
    `★★★ 没给边界就**不该有清单**，但查到了：${JSON.stringify(m)}`)
})

test('⑦ ★★★ 给了边界内容 ⇒ 写清单，并把 `{role,version,created}` 回给调用方', async () => {
  reset()
  const r = await post('/api/agents', {
    by: 'general', role: 'bound', name: 'B',
    responsibilities: ['写代码'], allowedTools: ['read', 'edit'], deniedTools: ['deploy'],
    approvalPolicy: 'ask', limits: { maxFiles: 5 },
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const ref = r.body.task.employeeManifest
  assert.ok(ref, '★★★ 给了边界就**必须**写清单（否则 PRT-402 的生产触发点断了）')
  assert.equal(ref.role, 'bound')
  assert.ok(ref.version !== undefined && ref.version !== null, '★ 要带版本')
  assert.equal(typeof ref.created, 'boolean', '★ `created` 是布尔（新建 vs 更新）')
})

test('⑦b ★★★ 边界的任一字段出现就算"给了"（哪怕只是 `limits: {}`）', async () => {
  reset()
  // `null` / `undefined` 不算"给了"；其余值都算
  const notGiven = await post('/api/agents', { by: 'general', role: 'n1', name: 'N', responsibilities: null, allowedTools: undefined })
  assert.equal(notGiven.body.task.employeeManifest, null, '★★ null/undefined 不算给了边界')
  const emptyLimits = await post('/api/agents', { by: 'general', role: 'n2', name: 'N', limits: {} })
  assert.ok(emptyLimits.body.task.employeeManifest, '★★ `limits: {}` 是**给了**（非 null/undefined）')
})

test('⑦c ★★ `employeeId` 缺省是 `${scope}/${role}`（岗位的地址，不是人）；显式传则照用', async () => {
  reset()
  await post('/api/agents', { by: 'general', role: 'addr', name: 'N', scope: 'S', allowedTools: ['read'] })
  const m1 = manifestFor('addr')
  assert.ok(m1, '★★ 缺省也要写清单')
  assert.equal(m1.employee_id, 'S/addr',
    '★★★ `employeeId` 是**岗位在这个空间里的地址**（`${scope}/${role}`），不是"某个人"')
  // ★ 调用方显式给真身份 ⇒ 照用，不再拼地址
  await post('/api/agents', { by: 'general', role: 'addr2', name: 'N', scope: 'S', allowedTools: ['read'], employeeId: 'human-7' })
  assert.equal(manifestFor('addr2').employee_id, 'human-7', '★ 显式传就照用')
  // ★ 空白字符串按"没给"处理 ⇒ 回到地址
  await post('/api/agents', { by: 'general', role: 'addr3', name: 'N', scope: 'S', allowedTools: ['read'], employeeId: '   ' })
  assert.equal(manifestFor('addr3').employee_id, 'S/addr3', '★ 全空白等于没给')
})

test('⑦d ★★★ 清单里**没给的字段要被规范化**，不能把 `undefined` 写进去', async () => {
  reset()
  // ★ 只给 `responsibilities`，其余全不给 —— 落库的必须是**规范化的缺省**。
  //   破验 M10/M11/M12 就是在这里漏的（去掉 `?? []` / `?? null` / `?? {}`）。
  await post('/api/agents', { by: 'general', role: 'norm', name: 'N', responsibilities: ['写代码'] })
  const m = manifestFor('norm')
  assert.ok(m, '★★ 要写清单')
  assert.equal(m.responsibilities_json, JSON.stringify(['写代码']), '★ 给的要存进去')
  assert.equal(m.allowed_tools_json, '[]', '★★★ 没给 `allowedTools` ⇒ 存 `[]`（不是 undefined/NULL）')
  assert.equal(m.denied_tools_json, '[]', '★★★ 没给 `deniedTools` ⇒ 存 `[]`')
  assert.equal(m.approval_policy, null, '★★★ 没给 `approvalPolicy` ⇒ 存 null')
  assert.equal(m.limits_json, '{}', '★★★ 没给 `limits` ⇒ 存 `{}`')
  // ★ 反方向：给全了也要原样存
  await post('/api/agents', {
    by: 'general', role: 'full', name: 'F',
    responsibilities: ['a'], allowedTools: ['read'], deniedTools: ['deploy'],
    approvalPolicy: 'always', limits: { n: 1 },
  })
  const f = manifestFor('full')
  assert.equal(f.allowed_tools_json, JSON.stringify(['read']))
  assert.equal(f.denied_tools_json, JSON.stringify(['deploy']))
  assert.equal(f.approval_policy, 'always')
  assert.equal(f.limits_json, JSON.stringify({ n: 1 }))
})

test('⑧ ★★ 非法 role 时**一行都不该落库**', async () => {
  reset()
  await post('/api/agents', { by: 'general', role: 'Dev', name: 'n' })
  assert.equal(roster('default').length, 0, '★★ 校验在建行之前')
})

test('⑨ ★ 缺操作者身份 ⇒ 400（`handleWrite` 的第一道闸）', async () => {
  reset()
  const r = await post('/api/agents', { role: 'r', name: 'n' })
  assert.equal(r.status, 400)
  assert.match(String(r.body.error), /缺少操作者身份 by/)
})

// ══════════════════════ POST /api/spaces/:id/agents ══════════════════════

test('⑩ ★★★ 选人入编：从**全局目录**按 role 复制进该空间', async () => {
  reset()
  // 先在别的空间建两个岗位（全局目录来源）
  await post('/api/agents', { by: 'general', role: 'src1', name: '源一', scope: 'lib', kind: 'ai', avatar: '🅰' })
  await post('/api/agents', { by: 'general', role: 'src2', name: '源二', scope: 'lib', kind: 'ai', avatar: '🅱' })
  const r = await post('/api/spaces/target/agents', { by: 'general', roles: ['src1', 'src2'] })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.task, { space: 'target', added: 2, roles: ['src1', 'src2'] })
  const rows = roster('target')
  assert.deepEqual(rows.map((x) => x.role), ['src1', 'src2'], '★★ 按角色的顺序放进去')
  assert.equal(rows[0].name, '源一'); assert.equal(rows[0].avatar, '🅰', '★★ 连 name/kind/avatar 一起复制过来')
})

test('⑪ ★★★ 目录里**没有**的 role 静默跳过，且不计入 `added`', async () => {
  reset()
  await post('/api/agents', { by: 'general', role: 'real', name: 'R', scope: 'lib' })
  const r = await post('/api/spaces/t/agents', { by: 'general', roles: ['real', 'ghost1', 'ghost2'] })
  assert.equal(r.body.task.added, 1, '★★★ 只有真存在的那个算数')
  assert.deepEqual(roster('t').map((x) => x.role), ['real'])
})

test('⑫ ★★★ `roles` 会**去重 + String()**（同一个 role 传两次只算一次）', async () => {
  reset()
  await post('/api/agents', { by: 'general', role: 'dup', name: 'D', scope: 'lib' })
  const r = await post('/api/spaces/t/agents', { by: 'general', roles: ['dup', 'dup', 'dup'] })
  assert.equal(r.body.task.added, 1, '★★★ 去重后只加一次')
  assert.equal(roster('t').length, 1)
  // ★ 数字会被 String() —— `String(1)` 在目录里查不到，所以 added=0 而不是崩
  const n = await post('/api/spaces/t2/agents', { by: 'general', roles: [1] })
  assert.equal(n.status, 200, '★ 非字符串不报错（`map(String)`）')
  assert.equal(n.body.task.added, 0)
  // ★★★ 破验 M24 教我补的这一条：上面那个 `[1]` **分不出**有没有 `String()` ——
  //   两种写法都查不到、都 added=0。真正分得开的是**数字形的 role**：
  //   role 正则是 `^[a-z0-9]...`，所以 `'123'` 是个**合法**的角色名。
  //   传数字 `123` 时：`String(123) === '123'` ⇒ 命中；
  //   不 `String()` ⇒ SQLite 拿 INTEGER 去比 TEXT 列 ⇒ **匹配不上**。
  await post('/api/agents', { by: 'general', role: '123', name: '数字岗', scope: 'lib' })
  const num = await post('/api/spaces/t3/agents', { by: 'general', roles: [123] })
  assert.equal(num.body.task.added, 1,
    '★★★ 数字形的 role 必须靠 `String()` 才对得上（TEXT 列不会等于 INTEGER）')
  assert.deepEqual(roster('t3').map((x) => x.role), ['123'])
})

test('⑬ ★★ `roles` 必须是非空数组', async () => {
  reset()
  for (const roles of [undefined, null, [], 'nope', 42, {}]) {
    const r = await post('/api/spaces/t/agents', { by: 'general', roles })
    assert.equal(r.status, 400, `★★ roles=${JSON.stringify(roles)} 应当被拒`)
    assert.match(String(r.body.error), /缺少参数 roles/)
  }
})

test('⑭ ★★ 空间 id 取自**路径**（含 `decodeURIComponent`）；非法 id ⇒ 400', async () => {
  reset()
  await post('/api/agents', { by: 'general', role: 'r', name: 'R', scope: 'lib' })
  const bad = await post('/api/spaces/Bad_Id/agents', { by: 'general', roles: ['r'] })
  assert.equal(bad.status, 400, JSON.stringify(bad.body))
  assert.match(String(bad.body.error), /空间 id 非法/)
  // ★ 合法的要过
  assert.equal((await post('/api/spaces/ok-id/agents', { by: 'general', roles: ['r'] })).status, 200)
})

test('⑮ ★★ 入编是**只增不减**（不像流水线那样删没提交的），且 sort 接着排', async () => {
  reset()
  await post('/api/agents', { by: 'general', role: 'x1', name: 'X1', scope: 'lib' })
  await post('/api/agents', { by: 'general', role: 'x2', name: 'X2', scope: 'lib' })
  await post('/api/spaces/t/agents', { by: 'general', roles: ['x1'] })
  await post('/api/spaces/t/agents', { by: 'general', roles: ['x2'] })
  const rows = roster('t')
  assert.deepEqual(rows.map((r) => r.role), ['x1', 'x2'], '★★ 第二次入编**没有删掉** x1')
  assert.deepEqual(rows.map((r) => r.sort), [0, 1], '★ sort 接着上一次的最大值往后排')
})

test('⑯ ★★ 审计写的是目标空间的 `space:add-agents`', async () => {
  reset()
  await post('/api/agents', { by: 'general', role: 'r', name: 'R', scope: 'lib' })
  await post('/api/spaces/aud/agents', { by: 'general', roles: ['r'] })
  const a = audits().find((x) => x.action === 'space:add-agents')
  assert.ok(a, '★ 要记一条审计')
  assert.equal(a.scope, 'aud', '★★ 记在**目标空间**上（不是来源空间）')
})

// ══════════════════════ 接缝契约 ══════════════════════

const stub = (over = {}) => createAgentIntakeRoutes({
  json: (res, code, p) => { res.sent = { code, payload: p } },
  db: { prepare: () => ({ get: () => undefined, all: () => [], run: () => {} }) },
  handleWrite: async () => {},
  withTx: (f) => f(),
  audit: () => {},
  contextPlanStore: () => ({ putEmployeeManifest: () => ({ manifest: {}, created: true }) }),
  ...over,
})

test('⑰ ★★★ dispatch 契约：`exact` 一条 + `prefix+suffix` 一条，都不许越界', async () => {
  const router = stub()
  const ctx = (p) => ({ path: p, url: new URL('http://x' + p) })
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/agents')), true)
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/agentsX')), false, '★ exact 不许退化成 startsWith')
  // ★★★ prefix+suffix：**必须两端都对上**
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/spaces/t/agents')), true)
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/spaces/t/other')), false, '★★ 后缀不对不算命中')
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/other/t/agents')), false, '★★ 前缀不对不算命中')
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/spaces/t/agents/')), false, '★ 多一个斜杠不算')
  // ★ 方法
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/agents')), false, '★ 只认 POST')
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/spaces/t/agents')), false)
  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.match} ${r.path}${r.suffix ?? ''}`),
    ['POST exact /api/agents', 'POST prefix+suffix /api/spaces//agents'])
  assert.equal(router.id, 'agent-intake')
})

test('⑱ ★★ 缺注入项 ⇒ **构造时**就抛（fail closed）', async () => {
  const full = {
    json: () => {}, db: {}, handleWrite: async () => {}, withTx: (f) => f(),
    audit: () => {}, contextPlanStore: () => ({}),
  }
  for (const k of Object.keys(full)) {
    const partial = { ...full }
    delete partial[k]
    assert.throws(() => createAgentIntakeRoutes(partial), /缺注入项/, `★★ 少了 ${k} 必须在构造时就抛`)
  }
})
