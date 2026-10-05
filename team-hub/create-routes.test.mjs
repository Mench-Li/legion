// ============================================================================
// PRT-316 切片 20：`/api/create`（建任务）
//
// 这一族**没有**专属判据：既有那几把（v1v2-contract / team-hub-parity /
// context-replay-run）只钉住 `{ok:true, task}` 的形状、公开字段两端一致、
// 以及"没有 title 要 400"这几件事。破验一跑就露了：16 处变异里 **9 处没人管**。
// ⇒ 本套件补的就是那 9 处。
//
// ★ 所有断言里的字段**都是量出来的**（`probe20-create.mjs` / `probe20b-create.mjs`），
//   不是照着路由体想出来的。其中一条量出来和直觉相反：
//   **`fileDomain` 传什么读回来都是 `null`** —— 也就是说路由体里那一句
//   `fileDomain: body.fileDomain` 是**惰性**的，改掉它没有任何可观测差别。
//   不先量就会为它写一条**永远不可能失败**的断言。
//
// ★★ 2026-10-05 复核：**上面这条读数已经过期**，而且它过期的方式正是这条注释自己警告的那种。
//   当时量到的"传什么都读回 null"是真的（PRT-316 切片 20 那会儿），但现在
//   `createTaskInTx`（server.mjs:4519）确实把 `input.fileDomain` 落库了。实测（隔离 hub、不碰 live 库）：
//     回执 fileDomain = ["scripts/prt/","docs/"] · GET /api/task = 同值 · 库里的原始列 = 同值 JSON
//   ⇒ 惰性的是**这条注释**，不是那行代码。
//   而它比"少一条断言"更贵：`fileDomain` 是并行派工的唯一依据（空 ⇒ hub 下 `exclusive`
//   整仓独占，与任何任务都冲突），一句"传了也没用"足以让后来的人不再传——实测就是这么发生的：
//   software 空间 139 个任务里**声明过 fileDomain 的曾经是 0 个**。
//   下面 ⑪ 用断言把这个能力钉住（含"不相交域可并行 / 未申报则独占"的正反对照）。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mod
let base
let dbDir

const req = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method, agent: false,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try { payload = await res.json() } catch { /* 无正文 */ }
  return { status: res.status, body: payload }
}
const create = (extra) => req('POST', '/api/create', { title: '建一个', by: 'general', ...extra })
const readTask = async (id) => (await req('GET', '/api/task?id=' + encodeURIComponent(id))).body
const auditOf = async (id) => (await req('GET', '/api/activity?taskId=' + encodeURIComponent(id))).body

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-createroutes-'))
  process.env.TEAM_HUB_DB = join(dbDir, 'team.db')
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dbDir, { recursive: true, force: true })
})

test('① 建成功：`{ok:true, task}`，id 是 `T-n`，默认 status=backlog / priority=medium', async () => {
  const r = await create({})
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.match(r.body.task.id, /^T-\d+$/)
  assert.equal(r.body.task.status, 'backlog', '不传 status 时落到 backlog')
  assert.equal(r.body.task.priority, 'medium', '不传 priority 时落到 medium')
})

test('② title 四种坏法都要 400，且文案是 `缺少参数 title`', async () => {
  for (const [what, v] of [['只含空格', '   '], ['空串', ''], ['缺失', undefined], ['非字符串', 123]]) {
    const r = await create(v === undefined ? { title: undefined } : { title: v })
    assert.equal(r.status, 400, `${what} 应当 400`)
    assert.equal(r.body.error, '缺少参数 title', `${what} 的文案`)
  }
  // ★ "只含空格"是这一族最容易漏的一种：`title.length === 0` 挡不住它。
  //   *一个"空标题会被拒"的判据，与一个"只有**恰好为空**才会被拒"的实现，
  //    在没有人为空格写一条用例的时候是同一个东西。*
})

test('③ title 存进去之前被 trim（回执与读回一致）', async () => {
  const r = await create({ title: '  两边有空格  ' })
  assert.equal(r.body.task.title, '两边有空格', '回执里就该是 trim 过的')
  const t = await readTask(r.body.task.id)
  assert.equal(t.title, '两边有空格', '落库的也必须是 trim 过的')
})

test('④ scope 要跟着走：任务与审计都落在它上面，且能按它筛出来', async () => {
  const r = await create({ scope: 'slice20-scope' })
  const t = await readTask(r.body.task.id)
  assert.equal(t.scope, 'slice20-scope', '任务上的 scope')
  const a = await auditOf(r.body.task.id)
  assert.equal(a[0].scope, 'slice20-scope', '审计上的 scope')
  const filtered = await req('GET', '/api/activity?scope=slice20-scope')
  assert.ok(filtered.body.some((e) => e.taskId === r.body.task.id),
    '按 scope 筛必须能筛到 —— 否则"落到哪个范围"这件事查不出来')
})

test('⑤ goalId 要跟着走：任务与审计都要有它', async () => {
  const r = await create({ goalId: 'goal-slice20' })
  assert.equal((await readTask(r.body.task.id)).goalId, 'goal-slice20', '任务上的 goalId')
  const a = await auditOf(r.body.task.id)
  assert.equal(a[0].goalId, 'goal-slice20',
    '审计上的 goalId —— 少了它，"这条任务是为哪个目标建的"在审计里断掉')
})

test('⑥ `docSync` 只有**字面 true** 才算开', async () => {
  for (const [v, want] of [[true, true], [false, false], ['true', false], [1, false], [undefined, false]]) {
    const r = await create({ title: 'ds-' + String(v), docSync: v })
    const t = await readTask(r.body.task.id)
    assert.equal(t.docSync, want, `传 ${JSON.stringify(v)} 应当存成 ${want}`)
  }
  // *一个"传了真值就算开"的实现，与一个"只有布尔 true 才算开"的契约，
  //  在调用方总是传布尔的时候是同一个东西 —— 而字符串 "false" 是真值。*
})

test('⑦ acceptance / blockedBy / description 都要落进去', async () => {
  const r = await create({ description: '描述', acceptance: ['A1', 'A2'], blockedBy: ['b1'] })
  const t = await readTask(r.body.task.id)
  assert.equal(t.description, '描述')
  assert.deepEqual([...t.acceptance], ['A1', 'A2'])
  assert.deepEqual([...t.blockedBy], ['b1'], 'blockedBy 少了，依赖关系就没登记上')
})

test('⑧ 只有 POST 认这条路径（写接口不该被 GET 读到）', async () => {
  for (const m of ['GET', 'PUT', 'DELETE']) {
    assert.equal((await req(m, '/api/create')).status, 404, `${m} /api/create 应当 404`)
  }
})

test('⑨ 同一个 title 建两次是两个任务（这条端点不去重）', async () => {
  const a = await create({ title: '重的' })
  const b = await create({ title: '重的' })
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  assert.notEqual(a.body.task.id, b.body.task.id)
})

test('⑪ ★★★ fileDomain 建任务时必须落库，且它真的决定并行还是独占', async () => {
  // 这条补的是本文件头部那条**过期读数**留下的坑（详见文件头 ★★）。
  // 它同时钉三件事，缺一条这个能力就会再退化成"没人传"：
  //   ① 回执 / GET 读回 / 库列三处一致（落库了，不是只回显）；
  //   ② 不相交域的两个任务**能同时认领**（并行真的成立）；
  //   ③ 未申报域的任务与**任何**已认领任务都冲突（整仓独占的代价看得见）。
  const dom = ['scripts/prt/', 'docs/']
  const r = await create({ title: '带文件域', fileDomain: dom })
  assert.equal(r.status, 200)
  assert.deepEqual([...r.body.task.fileDomain], dom, '回执里必须带上 fileDomain')
  const t = await readTask(r.body.task.id)
  assert.deepEqual([...t.fileDomain], dom, 'GET /api/task 必须读回同一个值（只回显不落库是另一种假象）')
  const raw = mod.db.prepare('SELECT fileDomain FROM tasks WHERE id=?').get(r.body.task.id)?.fileDomain
  assert.deepEqual(JSON.parse(raw), dom, '库里的原始列必须也是它')

  // 未传 → null（而不是 [] 或 undefined）：null 才是"没申报"这个事实的准确表达
  const bare = await create({ title: '不带文件域' })
  assert.equal(bare.body.task.fileDomain, null, '未申报应当是 null，不是空数组')

  // ② 不相交文件域 → 可并行
  const a = await create({ title: '并行A', status: 'todo', fileDomain: ['workbench/'] })
  const b = await create({ title: '并行B', status: 'todo', fileDomain: ['security/'] })
  const ca = await req('POST', '/api/claim', { id: a.body.task.id, by: 'w1', scope: 'default' })
  const cb = await req('POST', '/api/claim', { id: b.body.task.id, by: 'w2', scope: 'default' })
  assert.equal(ca.status, 200, 'A 应当认领成功：' + JSON.stringify(ca.body))
  assert.equal(cb.status, 200, 'B 与 A 文件域不相交，必须也能认领（否则并行能力等于不存在）')

  // ③ 未申报域 → 整仓独占：与上面两个**不相干**的任务也冲突
  const c = await create({ title: '独占C', status: 'todo' })
  const cc = await req('POST', '/api/claim', { id: c.body.task.id, by: 'w3', scope: 'default' })
  assert.equal(cc.status, 409, '未申报文件域的任务持整仓独占，必须被已在写的任务挡住')
  assert.match(String(cc.body?.error ?? cc.body?.reason ?? ''), /whole repository|整仓|占用/,
    '拒绝理由要说清是整仓占用：' + JSON.stringify(cc.body))
})

test('⑩ ★★★ 写门面炸了必须**向调用方抛出**，不能变成没人管的 promise', async () => {
  // 破验的 M13（把 `await handleWrite(...)` 的 await 去掉）**咬不住**，
  // 直到补上这一条 —— 因为 happy path 上有没有 await 看起来一样。
  //
  // 差别只在**写门面自己抛**的时候：`handleWrite` 内部有 try/catch，所以正常错误
  // 它自己会写成 400；但它**catch 块里那句 `json(...)`** 仍可能抛（比如客户端已经断开）。
  // 那时有 await ⇒ 异常沿 `run` → `dispatch` 传出来，调用方能处理；
  // 没有 await ⇒ 变成一个**未处理的 promise**，在 Node 15+ 默认**直接杀掉进程**。
  //
  //   *一个"这段代码看起来一样"的判据，与一个"差别只在这一路上没人走过"的事实，
  //    在我只跑 happy path 的时候是同一个东西。*
  const routes = await import('./routes/create.mjs')
  const built = routes.createCreateRoutes({
    json: () => {},
    createTask: () => ({ id: 'T-999', title: 'x' }),
    audit: () => {},
    handleWrite: async () => { throw new Error('写门面炸了') },
  })
  await assert.rejects(
    () => built.dispatch({ method: 'POST' }, {}, { path: '/api/create', url: new URL('http://127.0.0.1/api/create') }),
    /写门面炸了/,
    '写门面的异常必须传给调用方，而不是逃逸成未处理的 promise')
})
