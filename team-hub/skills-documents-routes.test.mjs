// ============================================================================
// PRT-316 切片 32：技能写面 + 文档写面（`/api/skills/{register,review,grant,revoke}`
// 与 `POST /api/documents{,/delete}`，共 6 条）
//
// ★ 本片**不是**为了"补一套判据"才写的。这一族已经有**三套**判据：
//   `team-hub/context-prt406-trust.test.mjs`（真 HTTP，两个命名空间都覆盖）、
//   `team-hub/skills.test.mjs`（域层，describe/it）、
//   `orchestrator/worker/sources-loader.test.mjs`（58 例）。
//   本文件是**破验量出来的 13 个缺口**的补丁：拿上面三套当判据、把路由层逐条改坏，
//   **22 条里只有 9 条会红** —— 下面就是"剩下那 13 条"各自的一格。
//
//   > 一个"这一族有三套用例守着"的印象，与一个"三套里没有一格在看这 13 件事"的事实，
//   > 在我没有把它们**逐条改坏一次、看谁变红**的时候是同一个东西。
//
// 逐条量出来的读数（都不是猜的；探针见 `.worktrees/_prt-handoff/probe32*.mjs`）：
//
//   · `POST /api/skills/registerX` → **404**（松成 prefix 会变成 400「缺少参数 id」）
//   · `register` 的 name：缺失/全空白 → **400 「缺少参数 name」**，正常值**会 trim**
//   · `body.scope ?? scope` 的三分：**缺席→`default`、`null`→`default`、空串→`''`**
//     （★ 空串**不**被 `??` 顶掉 —— 这是"写路径解析出来的 scope"唯一会输的情形）
//   · 带空白的删除 id → **`deleted:true` 且 `id` 已 trim**
//   · 审计表叫 **`audit`**（不是 `audit_log`），`detail` 是 JSON 字符串
//     · `document:register` → `{title,path,version,sha256,docScope,bodyBytes}`
//     · `document:delete`   → `{deleted,title,version}`，行的 `scope` 取**文档自己**的空间
//   · 无人值守的 grant → **202** + `{error:'权限审批待处理', requestId, permission}`
//   · 非 general 的成员调 review/grant/revoke → **400**（三条独立门禁）
//
// ◆ 顺带钉住一处**pre-existing 不对称**（本片没修，只记录）：
//   `getDocument(id)` 用的是**没去空白**的 id，而 `deleteDocument(id.trim())` 用去空白的 ——
//   于是 `{id:'  aud-3  '}` 会**删掉**那个文档，但审计里的 `title`/`version` 变成 `null`、
//   行的 `scope` 退回写路径的空间。见「⑧b」。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSkillsDocumentsRoutes } from './routes/skills-documents.mjs'

let mod
let base = ''
const dbDir = mkdtempSync(join(tmpdir(), 'legion-sdroutes-'))

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method, agent: false,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  let payload = null
  try { payload = await res.json() } catch { /* 无正文 */ }
  return { status: res.status, body: payload }
}
const post = (p, b) => call('POST', p, b)

process.env.TEAM_HUB_DB = join(dbDir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
mod = await import('./server.mjs')
await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
base = 'http://127.0.0.1:' + mod.server.address().port

const auditRows = (action) => mod.db
  .prepare('SELECT * FROM audit WHERE action = ? ORDER BY seq').all(action)
  .map((r) => ({ ...r, detail: JSON.parse(r.detail) }))

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dbDir, { recursive: true, force: true })
})

// ── ① exact：多一个字符就不是这条路 ────────────────────────────────────────
test('① ★★★ `POST /api/skills/registerX` 必须 404（不能落进 register 的体）', async () => {
  const r = await post('/api/skills/registerX', { id: 'x', name: 'n', by: 'general' })
  assert.equal(r.status, 404,
    '★ 若变成 400「缺少参数 id」，说明 `match` 从 exact 松成了 prefix —— ' +
    '那会让任何 `/api/skills/register…` 都被当成登记')
})

test('①b ★★★ `POST /api/documents` 不许吃掉 `/api/documents/delete`', async () => {
  // 两条都是 exact 且前缀相同；`/api/documents` 在前。
  // 如果它松成 prefix，`/api/documents/delete` 会先撞上**登记**那条。
  await post('/api/documents', { id: 'exact-probe', title: 't', body: 'x', by: 'general' })
  const del = await post('/api/documents/delete', { id: 'exact-probe', by: 'general' })
  assert.equal(del.status, 200)
  assert.deepEqual(del.body.task, { deleted: true, id: 'exact-probe' },
    '★ 走到了**登记**那条的话，这里会是一个文档对象、而且文档没被删掉')
})

// ── ② register 的参数校验 ────────────────────────────────────────────────
test('② ★★★ register 必须验 `name`（缺失 / 全空白都是 400）', async () => {
  for (const [label, body] of [
    ['name 缺失', { id: 'n1', by: 'general' }],
    ['name 是空格', { id: 'n2', name: '   ', by: 'general' }],
  ]) {
    const r = await post('/api/skills/register', body)
    assert.equal(r.status, 400, `${label} 应当被拒`)
    assert.match(String(r.body.error), /缺少参数 name/)
  }
  const gone = mod.db.prepare("SELECT COUNT(*) AS n FROM skills WHERE id IN ('n1','n2')").get()
  assert.equal(gone.n, 0, '★ 被拒的**一条都不该落库**')
})

test('②b ★★ register 的 `name` 会 trim（`好名字` 不带空白落库）', async () => {
  const r = await post('/api/skills/register', { id: 'trim-name', name: '  好名字  ', by: 'general' })
  assert.equal(r.status, 200)
  assert.equal(r.body.task.name, '好名字')
})

// ── ③ `body.scope ?? scope` 的三分 ────────────────────────────────────────
test('③ ★★★ 文档的 scope：缺席 / null → 写路径的 `default`；**空串 → 空串**', async () => {
  const seen = {}
  for (const [label, body] of [
    ['absent', { id: 'sc-absent', title: 't', body: 'x', by: 'general' }],
    ['empty', { id: 'sc-empty', title: 't', body: 'x', scope: '', by: 'general' }],
    ['null', { id: 'sc-null', title: 't', body: 'x', scope: null, by: 'general' }],
  ]) {
    const r = await post('/api/documents', body)
    assert.equal(r.status, 200, label)
    seen[label] = r.body.task.scope
  }
  assert.equal(seen.absent, 'default', '★ 缺席 ⇒ 用写路径解析出来的 scope')
  assert.equal(seen.null, 'default', '★ `null` 是"没给"，也退回 scope')
  assert.equal(seen.empty, '', '★ 空串**不**被 `??` 顶掉 —— 它是一次**显式**的空空间')
})

test('③b ★★ 技能的 scope 同理（缺席 → default，空串 → 空串）', async () => {
  const a = await post('/api/skills/register', { id: 'sk-a', name: 'A', by: 'general' })
  const b = await post('/api/skills/register', { id: 'sk-b', name: 'B', scope: '', by: 'general' })
  assert.equal(a.body.task.scope, 'default')
  assert.equal(b.body.task.scope, '')
})

// ── ④ 删除：id 会 trim ───────────────────────────────────────────────────
test('④ ★★ 删除的 id 会 trim（带空白也能删掉，回执里的 id 是去空白的）', async () => {
  await post('/api/documents', { id: 'trim-del', title: '待删', body: 'x', by: 'general' })
  const r = await post('/api/documents/delete', { id: '  trim-del  ', by: 'general' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.task, { deleted: true, id: 'trim-del' },
    '★ 不 trim 的话这里是 `deleted:false`（拿 `  trim-del  ` 去查库查不到）')
})

// ── ⑤ 审计：两条 action 的 detail ────────────────────────────────────────
test('⑤ ★★★ `document:register` 的审计 detail 里 `bodyBytes` 是**字节数**（CJK 3 字节）', async () => {
  await post('/api/documents', { id: 'byte-1', title: 'T', body: '正文三个字', by: 'general' })
  const [row] = auditRows('document:register').filter((r) => r.taskId === 'byte-1')
  assert.ok(row, '没有留下审计行')
  assert.equal(row.detail.bodyBytes, 15, '★ 五个汉字 = 15 字节；写死 0 或按字符数都会在这里红')
  assert.equal(row.detail.title, 'T')
  assert.equal(row.detail.docScope, 'default')
  assert.ok(Number.isInteger(row.detail.version))
  assert.match(row.detail.sha256, /^[0-9a-f]{64}$/)
})

test('⑤b ★★★ `document:delete` 的审计 detail 里带**删掉的是什么**（title/version）', async () => {
  await post('/api/documents', { id: 'keep-meta', title: '要留名字的', path: 'docs/k.md', body: 'x', by: 'general' })
  await post('/api/documents/delete', { id: 'keep-meta', by: 'general' })
  const [row] = auditRows('document:delete').filter((r) => r.taskId === 'keep-meta')
  assert.ok(row, '没有留下审计行')
  assert.equal(row.detail.deleted, true)
  assert.equal(row.detail.title, '要留名字的',
    '★ 删完再读就没有了 —— 这条只剩"删除前先读一次"能提供')
  assert.equal(row.detail.version, 1)
})

test('⑤c ★★★ `document:delete` 审计行的 scope 取**文档自己**的空间', async () => {
  await post('/api/documents', { id: 'own-scope', title: 'T', body: 'x', scope: 'software', by: 'general' })
  // 写入面不给 scope ⇒ 写路径解析出来的是 default；审计该用**文档的** software
  await post('/api/documents/delete', { id: 'own-scope', by: 'general' })
  const [row] = auditRows('document:delete').filter((r) => r.taskId === 'own-scope')
  assert.equal(row.scope, 'software',
    '★ 取写路径的 scope 会得到 default —— 跨空间的操作就归错账了')
})

test('⑤d ★★ 文档的审计 detail 里**不带正文**（只带字节数）', async () => {
  const secret = '这是一段不该进审计的正文'
  await post('/api/documents', { id: 'no-body', title: 'T', body: secret, by: 'general' })
  const [row] = auditRows('document:register').filter((r) => r.taskId === 'no-body')
  assert.ok(!JSON.stringify(row.detail).includes(secret),
    '★ 把正文塞进审计 = 给每一份文档另存一份全文（还包括被删掉的那些）')
})

// ── ⑥ 无人值守的 grant 权限闸 ───────────────────────────────────────────
test('⑥ ★★★ `unattended:true` 的 grant 走权限栈 ⇒ 202 待审批（不是直接授权）', async () => {
  await post('/api/skills/register', { id: 'gate-1', name: 'G', by: 'general' })
  const r = await post('/api/skills/grant', { id: 'gate-1', grants: ['scope-a'], by: 'general', unattended: true })
  assert.equal(r.status, 202,
    '★ 整段跳过权限检查就会变成 200 —— 无人值守的授权必须过权限栈')
  assert.equal(r.body.error, '权限审批待处理')
  assert.ok(r.body.requestId, '要给出可跟进的 requestId')
  assert.equal(r.body.permission.status, 'pending')
  assert.equal(r.body.permission.operation.action, 'skill:grant')
})

test('⑥b ★★★ 带 `permissionRequestId` 的 grant 同样走权限栈（202）', async () => {
  await post('/api/skills/register', { id: 'gate-2', name: 'G', by: 'general' })
  const r = await post('/api/skills/grant', {
    id: 'gate-2', grants: ['scope-a'], by: 'general', permissionRequestId: 'pr-x',
  })
  assert.equal(r.status, 202)
  assert.equal(r.body.permission.status, 'pending')
})

test('⑥c ★★ 无人值守但**技能不存在** ⇒ 400（先查存在，再谈权限）', async () => {
  const r = await post('/api/skills/grant', {
    id: 'no-such-skill', grants: ['a'], by: 'general', unattended: true,
  })
  assert.equal(r.status, 400)
  // ★★★ 这里量出来一件事：路由上写着
  //     `const skillForPermission = getSkill(id)` + `if (!skillForPermission) throw '技能不存在'`，
  //   但 `getSkill()` **自己就会 throw**（`未知技能 ${id}`），永远不返回假值 ——
  //   所以那句 `技能不存在` 是**够不到的死代码**，真正发出去的是域层那句「未知技能」。
  //
  //   > 一个"我在路由上守了一道存在性检查"的印象，与一个"域层**先**抛了、
  //   > 于是这道永远轮不到"的事实，在我没有把那条路真的走一次、看回执上写的是哪句话的时候
  //   > 是同一个东西。
  //
  //   （本片**不修**它：改错误文案会动到对外契约。只把它钉住，免得下次有人以为那句话会发出去。）
  assert.match(String(r.body.error), /未知技能 no-such-skill/)
})

test('⑥d ★★ 普通 grant（不带 unattended）**不**过权限栈，直接 200', async () => {
  await post('/api/skills/register', { id: 'gate-3', name: 'G', by: 'general' })
  const r = await post('/api/skills/grant', { id: 'gate-3', grants: ['scope-a'], by: 'general' })
  assert.equal(r.status, 200, '★ 与 ⑥ 成对：只有无人值守那条才进权限栈')
})

test('⑥e ★★ 空 `grants` 被拒（400），且不落任何授权', async () => {
  await post('/api/skills/register', { id: 'gate-4', name: 'G', by: 'general' })
  for (const bad of [undefined, [], 'not-array']) {
    const r = await post('/api/skills/grant', { id: 'gate-4', grants: bad, by: 'general' })
    assert.equal(r.status, 400, `grants=${JSON.stringify(bad)} 应当被拒`)
    assert.match(String(r.body.error), /缺少参数 grants/)
  }
})

// ── ⑦ 三条 general 门禁 ──────────────────────────────────────────────────
test('⑦ ★★★ review / grant / revoke 三条都只许 `general`（非 general → 400）', async () => {
  await post('/api/skills/register', { id: 'perm-1', name: 'P', by: 'general' })
  const cases = [
    ['/api/skills/review', { id: 'perm-1', action: 'publish' }, /skill:review/],
    ['/api/skills/grant', { id: 'perm-1', grants: ['a'] }, /skill:grant/],
    ['/api/skills/revoke', { id: 'perm-1', targets: ['a'] }, /skill:revoke/],
  ]
  for (const [p, body, re] of cases) {
    const r = await post(p, { ...body, by: 'member-1' })
    assert.equal(r.status, 400, `${p} 非 general 应当被拒`)
    assert.match(String(r.body.error), re)
  }
})

test('⑦b ★★ revoke 的 `targets` 空数组被拒（400）', async () => {
  await post('/api/skills/register', { id: 'perm-2', name: 'P', by: 'general' })
  const r = await post('/api/skills/revoke', { id: 'perm-2', targets: [], by: 'general' })
  assert.equal(r.status, 400)
  assert.match(String(r.body.error), /缺少参数 targets/)
})

// ── ⑧ 那处 pre-existing 不对称（**记录**，不修）─────────────────────────
test('⑧b ★★ 已知不对称：带空白的 id **删得掉**，但审计里的 title/version 变成 null、scope 退回写路径', async () => {
  await post('/api/documents', { id: 'asym-1', title: '有名字的', body: 'x', scope: 'software', by: 'general' })
  const r = await post('/api/documents/delete', { id: '  asym-1  ', by: 'general' })
  assert.equal(r.body.task.deleted, true, '删是删掉了（deleteDocument 用了 trim 后的 id）')
  const [row] = auditRows('document:delete').filter((r2) => r2.taskId === 'asym-1')
  assert.equal(row.detail.title, null, '★ `getDocument(id)` 用的是**没去空白**的 id ⇒ 读不到')
  assert.equal(row.detail.version, null)
  assert.equal(row.scope, 'default', '★ 于是 scope 退回写路径的 default —— 而文档其实属于 software')
})

// ── ⑨ 接缝契约（本片的交付物就是这根缝）────────────────────────────────
test('⑨ ★★★ dispatch 契约：命中 ⇒ 恰好跑一次并回 true；不命中 ⇒ false', async () => {
  const ran = []
  const deps = {
    json: (res, code, payload) => { res.sent = { code, payload } },
    handleWrite: async (req, res, fn) => {
      try { res.sent = { code: 200, payload: { ok: true, task: fn(req.body ?? {}, 'general', 'default') } } }
      catch (e) { res.sent = { code: 400, payload: { ok: false, error: e.message } } }
    },
    registerSkill: (a) => { ran.push('registerSkill'); return { id: a.id, name: a.name, scope: a.scope, version: 1 } },
    registerDocument: (a) => { ran.push('registerDocument'); return { id: a.id, title: a.title, scope: a.scope, version: 1 } },
    deleteDocument: (id) => { ran.push('deleteDocument'); return { deleted: true, id } },
    reviewSkill: () => { ran.push('reviewSkill'); return { scope: 'default', status: 'published' } },
    grantSkill: () => { ran.push('grantSkill'); return { scope: 'default' } },
    revokeSkill: () => { ran.push('revokeSkill'); return { scope: 'default' } },
    getSkill: () => null, checkPermission: () => ({ allowed: true }), getDocument: () => null,
    audit: () => {},
  }
  const router = createSkillsDocumentsRoutes(deps)

  // 不命中：路径对不上
  let res = {}
  assert.equal(await router.dispatch({ method: 'POST' }, res, { path: '/api/nope' }), false,
    '★ 不命中必须回 false —— 回 true 会把后面的接缝整段吃掉')
  assert.equal(ran.length, 0)

  // 不命中：方法对不上 ★★ 这条钉的是"dispatch 必须看方法"
  res = {}
  assert.equal(await router.dispatch({ method: 'GET' }, res, { path: '/api/skills/register' }), false,
    '★★ 不看方法的话 GET 也会撞进 POST 的体里')
  assert.equal(ran.length, 0)

  // 命中：恰好跑一次，并回 true
  res = {}
  assert.equal(await router.dispatch({ method: 'POST', body: { id: 's', name: 'n' } }, res, { path: '/api/skills/register' }), true,
    '★★ 命中必须回 true —— 回 false 会让 handle() 继续往下走、**再答复一次**')
  assert.deepEqual(ran, ['registerSkill'], '★ 恰好跑一次，不能因为认领而重复执行')

  // 命中：顺序不能乱 —— `/api/documents/delete` 不能被 `/api/documents` 抢先
  ran.length = 0
  res = {}
  assert.equal(await router.dispatch({ method: 'POST', body: { id: 'd' } }, res, { path: '/api/documents/delete' }), true)
  assert.deepEqual(ran, ['deleteDocument'], '★★ `/api/documents` 若松成 prefix，这里会是 registerDocument')

  // 六条路由的顺序 = 原来 handle 里那六条 if 的顺序
  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.path}`), [
    'POST /api/skills/register', 'POST /api/skills/review', 'POST /api/skills/grant',
    'POST /api/skills/revoke', 'POST /api/documents', 'POST /api/documents/delete',
  ])
  assert.equal(router.id, 'skills-documents')
})

// ── ⑩ 权限被**拒**那条路（本片最后一格）────────────────────────────────
//    这条放在最后，因为它要往 `permission_rules` 里塞一条**全局 deny**；
//    塞完在该用例内部删掉，免得污染前面那些"普通 grant 应当成功"的格子。
//
//    ★★★ 量出来的：全仓**没有任何一个用例**提到过 `权限拒绝` ——
//       也就是说这条路由上的拒绝分支，在补这一格之前**从来没被执行过**。
//    > 一个"权限栈拦不住就会出事"的印象，与一个"那条 if 从来没有人走到过"的事实，
//    > 在我没有去把它**真的走一次**的时候是同一个东西。
test('⑩ ★★★ 权限被拒 ⇒ 400「权限拒绝」，**不**继续授权', async () => {
  await post('/api/skills/register', { id: 'deny-1', name: 'D', by: 'general' })
  const rule = await post('/api/permissions/rules', {
    id: 'test-deny-grant', scope: 'default', actor: 'general',
    action: 'skill:grant', mode: 'deny', by: 'general',
  })
  assert.equal(rule.status, 200, JSON.stringify(rule.body))
  try {
    const r = await post('/api/skills/grant', {
      id: 'deny-1', grants: ['scope-a'], by: 'general', unattended: true,
    })
    assert.equal(r.status, 400, '★ 去掉那道 `if (!permission.allowed)` 之后这里会变成 200')
    assert.match(String(r.body.error), /权限拒绝/)
    // 授权**没有**落下去
    const row = mod.db.prepare('SELECT grants FROM skills WHERE id = ?').get('deny-1')
    assert.deepEqual(JSON.parse(row.grants), [],
      '★★ 被拒之后**一条授权都不能写进去** —— 这才是那道 if 存在的意义')
  } finally {
    // ★ DELETE 那条也要 `by`（`requireMember(body)`）—— 不带体的 DELETE 会 400，
    //   于是规则留着不走，下面那句"恢复"就会假红。
    const gone = await call('DELETE', '/api/permissions/rules/test-deny-grant', { by: 'general' })
    assert.equal(gone.status, 200, '清理没成功：' + JSON.stringify(gone.body))
  }
  // 删掉规则之后同一请求恢复正常（证明上面拦住它的确实是那条规则）
  const again = await post('/api/skills/grant', {
    id: 'deny-1', grants: ['scope-a'], by: 'general', unattended: true,
  })
  assert.equal(again.status, 202, '★ 规则删掉后应当回到"待审批"，而不是继续被拒')
})
