// ============================================================================
// PRT-316 切片 41：任务上的五张记录表 —— 5 条，全 `exact`
//   POST /api/progress      上报进度（claimedAt）
//   POST /api/patch         改动补丁（patches）
//   POST /api/review-notes  逐文件验收意见（review_notes，按 file 覆盖）
//   POST /api/artifact      产物登记（artifacts）
//   POST /api/test-report   测试报告（testReport）
//
// ★★★ **本片搬走的 5 条里有 4 条此前一条判据都没有**
//   （`progress` / `patch` / `review-notes` / `test-report`）——
//   它们的"存在"本身都没被任何既有判据确认过。
//
// ★★★ 本片还是"**一个族 = 一个前缀**"彻底不成立的那一片：
//   这 5 条**跨 5 个不同前缀**，但它们在**行号上连续**（L5206–L5295，中间没有接缝）。
//   `wire-family` 要的从来不是"同前缀"，而是**任意一段连续的条件块**。
//
//   > 一个「按前缀分组就能看出哪些能凑成一段」的印象，
//   > 与一个「两个**不同**前缀的路由恰好紧挨着、本来就该一起搬」的事实，
//   > 在我按前缀而不是按**行号相邻**去分组的时候是同一个东西。
//
// ★ 它们还是**同一个形状**：`handleWrite` → 校验 → 改一张 JSON 记录表 → `version+1` → 回任务。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTaskRecordsRoutes } from './routes/task-records.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-task-records-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const call = async (m, p, b) => {
  const res = await fetch(base + p, {
    method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b),
  })
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}
const post = (p, b) => call('POST', p, b)
// ★★ 实测：**回复里的这些字段已经是解析好的**数组/对象，不是 JSON 字符串 ——
//   我第一版对它们 `JSON.parse`，于是 6 条判据红在 `"[object Object]" is not valid JSON`。
//   写两个两边都认的取用器，省得再猜。
const asArr = (v) => (Array.isArray(v) ? v : (() => { try { const x = JSON.parse(v ?? '[]'); return Array.isArray(x) ? x : [] } catch { return [] } })())
const asObj = (v) => (v && typeof v === 'object' ? v : (() => { try { return JSON.parse(v ?? '{}') } catch { return {} } })())
const taskOf = (r) => r.body?.task
const PATHS = ['/api/progress', '/api/patch', '/api/review-notes', '/api/artifact', '/api/test-report']

const mk = (id, role, status = 'in_progress') => {
  const iso = new Date().toISOString()
  mod.db.prepare('INSERT OR REPLACE INTO tasks (id,title,priority,status,scope,role,hold,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, id, 'medium', status, 'default', role, 0, iso, iso)
}

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关 */ }
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

// ── 1. 五条共有的闸门 ───────────────────────────────────────────────────
test('① ★★★ 五条都要 `id`，且都排在其它校验**之前**', async () => {
  for (const p of PATHS) {
    const r = await post(p, { by: 'general' })
    assert.equal(r.status, 400, `${p} 空 body 应当 400`)
    assert.match(String(r.body.error), /缺少参数 id/,
      `★★ ${p}：应当先报缺 id，实际 ${JSON.stringify(r.body)}`)
  }
})

test('①b ★★★ 未知任务 ⇒ 400「未知任务 X」（五条一致；id 合法但库里有没查）', async () => {
  mk('r41-a', 'dev')
  const r = await post('/api/progress', { by: 'general', id: 'no-such-task' })
  assert.equal(r.status, 400)
  assert.match(String(r.body.error), /未知任务/)
})

test('①c ★★★ 五条都走 `handleWrite` 的操作者闸（`by` 排在最前）', async () => {
  for (const p of PATHS) {
    const r = await post(p, {})
    assert.equal(r.status, 400, `${p} 无 by 应当 400`)
    assert.match(String(r.body.error), /缺少操作者身份 by/, `★★ ${p} 实际 ${JSON.stringify(r.body)}`)
  }
})

// ── 2. ★★★ progress 的状态闸（**注释里没写**）──────────────────────────
test('② ★★★ `progress` 只收 `in_progress` 任务', async () => {
  mk('r41-todo', 'dev', 'todo')
  const bad = await post('/api/progress', { by: 'general', id: 'r41-todo' })
  assert.equal(bad.status, 400, JSON.stringify(bad.body))
  assert.match(String(bad.body.error), /仅 in_progress 任务可上报进度/,
    '★★★ 这条状态闸源码注释里一个字都没写，是本片实测出来的')
  assert.match(String(bad.body.error), /当前 todo/, '★ 错误里要带上当前状态')
  // 换成 in_progress 就能过
  mk('r41-run', 'dev', 'in_progress')
  const ok = await post('/api/progress', { by: 'general', id: 'r41-run' })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.ok(taskOf(ok).claimedAt, '★★ 上报进度要落 `claimedAt`')
})

// ── 3. ★★★ patch：文件清单的归一化 ─────────────────────────────────────
test('③ ★★★ `patch` 归一化文件清单（status 只认 AMDRCUX、add/del 取非负、path 截 500）', async () => {
  mk('r41-p', 'dev')
  const longPath = 'x'.repeat(600)
  const r = await post('/api/patch', {
    by: 'general', id: 'r41-p', diff: '@@ -1 +1 @@',
    files: [
      { path: 'a.mjs', status: 'M', add: 3, del: 1 },        // 正常
      { path: 'b.mjs', status: 'ZZZ', add: -5, del: 'nope' }, // status 非法 → M；add/del 非法 → 0
      { path: longPath, status: 'A' },                        // path 过长 → 截 500
      null,                                                   // 空项
      'garbage',                                              // 非对象
    ],
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const list = asArr(taskOf(r).patches)
  assert.equal(list.length, 1, '★ 每次 patch 追加**一条**记录（不是每个文件一条）')
  const files = list[0].files
  assert.equal(files[0].path, 'a.mjs')
  assert.equal(files[0].status, 'M')
  assert.equal(files[0].add, 3)
  assert.equal(files[0].del, 1)
  assert.equal(files[1].status, 'M', '★★ 非法 status 必须回落成 M，不许原样落库')
  assert.equal(files[1].add, 0, '★★ 负数/非数字 add 必须归零')
  assert.equal(files[1].del, 0)
  assert.equal(files[2].path.length, 500, '★ path 截到 500')
  // ★★ 实测：`null` / `'garbage'` 这两项被**丢掉**了，不是归一化成空形状。
  //   我第一版按"空项也要有形状（不许炸）"写，红在我自己的预期上。
  assert.equal(files.length, 3, `★★ 非法项应当被**丢弃**（不是补形状），实际 ${files.length} 项`)
  assert.ok(files.every((f) => typeof f.path === 'string' && typeof f.status === 'string'))
})

// ── 3b. ★★★ patch 的另外三条分支（破验第一遍漏掉的）──────────────────
test('③b ★★★ `patch` 的 `files` 也收 **CSV 字符串**（另一条输入分支）', async () => {
  mk('r41-csv', 'dev')
  const r = await post('/api/patch', { by: 'general', id: 'r41-csv', files: ' a.mjs , b.mjs ,, c.mjs ' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const files = asArr(taskOf(r).patches).at(-1).files
  assert.deepEqual(files.map((f) => f.path), ['a.mjs', 'b.mjs', 'c.mjs'],
    '★★★ 字符串形态要按逗号切开、去空白、丢空段')
  for (const f of files) {
    assert.equal(f.status, 'M', '★ 字符串形态一律记 M')
    assert.equal(f.add, 0)
    assert.equal(f.del, 0)
  }
  // 非数组、非字符串 ⇒ 空表（不炸）
  const bad = await post('/api/patch', { by: 'general', id: 'r41-csv', files: 123 })
  assert.equal(bad.status, 200)
  assert.deepEqual(asArr(taskOf(bad).patches).at(-1).files, [])
})

test('③c ★★ `patch` 的 `diff` 有 200KB 上限', async () => {
  mk('r41-big', 'dev')
  const okDiff = await post('/api/patch', { by: 'general', id: 'r41-big', diff: 'x'.repeat(200000), files: [] })
  assert.equal(okDiff.status, 200, '★ 正好 200000 应当放行（判据是 `>` 不是 `>=`）')
  const tooBig = await post('/api/patch', { by: 'general', id: 'r41-big', diff: 'x'.repeat(200001), files: [] })
  assert.equal(tooBig.status, 400, JSON.stringify(tooBig.body))
  assert.match(String(tooBig.body.error), /diff 过大/, '★★ 实际 ' + JSON.stringify(tooBig.body))
})

test('③d ★★ `patch` 的文件清单最多留 200 条', async () => {
  mk('r41-many', 'dev')
  const many = Array.from({ length: 250 }, (_, i) => ({ path: 'f' + i + '.mjs', status: 'M', add: 1, del: 1 }))
  const r = await post('/api/patch', { by: 'general', id: 'r41-many', files: many })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const files = asArr(taskOf(r).patches).at(-1).files
  assert.equal(files.length, 200, `★★ 应当截到 200，实际 ${files.length}`)
  assert.equal(files[0].path, 'f0.mjs', '★ 截的是**尾部**（保留前 200）')
  assert.equal(files[199].path, 'f199.mjs')
})

// ── 4. ★★★ review-notes：按 file 覆盖 ─────────────────────────────────
test('④ ★★★ `review-notes` 的 `verdict` 只认 `ok|issue|clear`（不是 pass/fail）', async () => {
  mk('r41-r', 'dev')
  for (const v of [undefined, 'pass', 'fail', 'OK', null]) {
    const r = await post('/api/review-notes', { by: 'general', id: 'r41-r', file: 'a.mjs', verdict: v, note: 'x' })
    assert.equal(r.status, 400, `verdict=${JSON.stringify(v)} 应当 400`)
    assert.match(String(r.body.error), /verdict 必须是 ok\|issue\|clear/,
      `★★ 错误里要**逐个列出**合法取值，实际 ${JSON.stringify(r.body)}`)
  }
  const ok = await post('/api/review-notes', { by: 'general', id: 'r41-r', file: 'a.mjs', verdict: 'ok', note: '好' })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
})

test('④b ★★★ 【实测出一个既有缺陷，本片只钉不修】逐文件意见**攒不起来**', async () => {
  // ★★★ 这一条是本片加判据时**当场发现的源码缺陷**，不是本片引入的
  //   （逐字对拍证明提取是忠实的）：
  //
  //     模块 L127：`const list = parseJson(t.review_notes ?? '[]', [])`
  //     而 `getTask()` 回的是**接口形状**的任务 —— 它的字段叫 **`reviewNotes`**（驼峰），
  //     **没有** `review_notes` 这个键（实测：34 个键里有 `reviewNotes`，`review_notes` 是 undefined）。
  //     ⇒ `t.review_notes` **恒为 undefined** ⇒ `list` **恒为 `[]`** ⇒ `others` 也恒为 `[]`
  //     ⇒ L129 只 push 这**一条**新意见，L130 再把它整张写回去。
  //
  //   **净效果**：所谓"逐文件验收意见"**根本不逐文件** ——
  //     每写一条就把**之前所有文件**的意见冲掉；`verdict='clear'` 更是把整张表**清空**。
  //
  //   实测（三连击）：
  //     put a.mjs/ok    ⇒ `[{a}]`
  //     put b.mjs/issue ⇒ `[{b}]`     ← a.mjs 没了
  //     put a.mjs/clear ⇒ `[]`        ← b.mjs 也没了
  //
  //   ★ 根因是**列名与接口字段名不一致**：路由从"接口形状的对象"上读**数据库列名**。
  //   ★ 这条路由此前**一条判据都没有** —— 缺陷就住在没人看的地方。
  //   ★ 本片**不修**：改它等于改行为，要业主裁决（已进台账的"钉住未修"清单）。
  mk('r41-r2', 'dev')
  const put = async (file, verdict, note) => {
    const r = await post('/api/review-notes', { by: 'general', id: 'r41-r2', file, verdict, note })
    assert.equal(r.status, 200, `${file}/${verdict} 应当 200：${JSON.stringify(r.body)}`)
    return asArr(taskOf(r).reviewNotes)
  }
  const after1 = await put('a.mjs', 'ok', '第一版')
  assert.deepEqual(after1.map((x) => x.file), ['a.mjs'], '第一条：只有 a.mjs')
  const after2 = await put('b.mjs', 'issue', '有问题')
  // ★★★ 正确行为应当是 ['a.mjs','b.mjs']；实测是 ['b.mjs'] —— 这里**如实钉住缺陷**
  assert.deepEqual(after2.map((x) => x.file), ['b.mjs'],
    '★★★ 缺陷：写 b.mjs 把 a.mjs 冲掉了（应当两条并存）—— 修好之后这条断言必须改成 [a,b]')
  const after3 = await put('a.mjs', 'clear', '改好了')
  assert.deepEqual(after3, [],
    '★★★ 缺陷：`clear` 把整张表清空了（本该只清 a.mjs）—— 修好之后这条断言必须改')
  // ★ 不传 file ⇒ 落到通配 '*'
  const t = taskOf(await post('/api/review-notes', { by: 'general', id: 'r41-r2', verdict: 'ok', note: '总评' }))
  assert.deepEqual(asArr(t.reviewNotes).map((x) => x.file), ['*'], "★ 不传 file 时落到 `'*'`")
})

// ── 5. artifact ─────────────────────────────────────────────────────────
test('⑤ ★★★ `artifact` 的 `kind` 只认 `html|file|url`，且 `path` 必填', async () => {
  mk('r41-art', 'dev')
  const bad = await post('/api/artifact', { by: 'general', id: 'r41-art', kind: 'nope', path: 'x' })
  assert.equal(bad.status, 400)
  assert.match(String(bad.body.error), /kind 必须是 html\|file\|url/)
  const noPath = await post('/api/artifact', { by: 'general', id: 'r41-art', kind: 'file' })
  assert.equal(noPath.status, 400)
  assert.match(String(noPath.body.error), /缺少产物路径 path/)
  for (const k of ['html', 'file', 'url']) {
    const r = await post('/api/artifact', { by: 'general', id: 'r41-art', kind: k, path: `p-${k}` })
    assert.equal(r.status, 200, `kind=${k} 应当 200`)
  }
  const list = asArr(taskOf(await post('/api/artifact', { by: 'general', id: 'r41-art', kind: 'file', path: 'z' })).artifacts)
  assert.equal(list.length, 4, '★ 每次登记**追加**一条')
  for (const e of list) {
    assert.ok(e.by, '★ 每条要记是谁登记的')
    assert.ok(e.at, '★ 每条要记时间')
  }
})

test('⑤b ★★ `digest` 只在形如十六进制长度 ≥16 时才落库', async () => {
  mk('r41-art2', 'dev')
  const good = 'a'.repeat(16)
  const t1 = taskOf(await post('/api/artifact', { by: 'general', id: 'r41-art2', kind: 'file', path: 'a', digest: good }))
  assert.equal(asArr(t1.artifacts).at(-1).digest, good, '★ 合法 digest 原样落库')
  for (const d of ['short', 'ZZZZZZZZZZZZZZZZ', 'a'.repeat(15)]) {
    const t = taskOf(await post('/api/artifact', { by: 'general', id: 'r41-art2', kind: 'file', path: 'b', digest: d }))
    assert.equal(asArr(t.artifacts).at(-1).digest, undefined,
      `★★ digest=${JSON.stringify(d)} 不许落库（读取期缺省不比对）`)
  }
})

// ── 6. test-report ──────────────────────────────────────────────────────
test('⑥ ★★★ `test-report` 只有 `tester` 任务能写（注释写了），且任务要在办（**注释没写**）', async () => {
  mk('r41-dev2', 'dev', 'in_progress')
  const wrongRole = await post('/api/test-report', { by: 'general', id: 'r41-dev2', passed: true })
  assert.equal(wrongRole.status, 400)
  assert.match(String(wrongRole.body.error), /仅 tester 任务可写/, `★★ 实际 ${JSON.stringify(wrongRole.body)}`)
  assert.match(String(wrongRole.body.error), /role=dev/, '★ 错误里要带上实际 role')
  // ★★★ 这一条状态闸注释里没写
  mk('r41-t-todo', 'tester', 'todo')
  const wrongStatus = await post('/api/test-report', { by: 'general', id: 'r41-t-todo', passed: true })
  assert.equal(wrongStatus.status, 400)
  assert.match(String(wrongStatus.body.error), /仅 in_progress\/in_review 可写报告/,
    '★★★ 这条状态闸源码注释里一个字都没写，是本片实测出来的')
  // 两个条件都满足
  mk('r41-t-run', 'tester', 'in_progress')
  const ok = await post('/api/test-report', { by: 'general', id: 'r41-t-run', passed: true, failures: [], summary: 'ok' })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  const rep = asObj(taskOf(ok).testReport)
  assert.equal(rep.passed, true)
  assert.ok(Array.isArray(rep.failures))
  assert.ok(rep.at, '★ 要记时间')
})

test('⑥b ★★★ `passed` 严格 `=== true`；且 `passed=false` 时**必须**给出 `failures`', async () => {
  mk('r41-t2', 'tester', 'in_progress')
  // ★★★ 实测出来的**第二条**规则（注释里只写了"仅 tester 任务可写"）：
  //   `passed` 不是 `true` 时，**必须**带 `failures` —— 否则 400。
  const noFailures = await post('/api/test-report', { by: 'general', id: 'r41-t2', passed: 1 })
  assert.equal(noFailures.status, 400, JSON.stringify(noFailures.body))
  assert.match(String(noFailures.body.error), /passed=false 时必须给出 failures/,
    '★★ 实际 ' + JSON.stringify(noFailures.body))
  // 带上**非空** failures 之后：`1` / `'true'` / `'yes'` / `{}` 都不算通过（严格 === true）
  // ★★ 注意是"非空" —— L185 是 `if (!passed && failures.length === 0) throw`，
  //   传 `failures: []` **一样 400**（我第一版就栽在这儿）。
  const FAIL = [{ name: 'boom' }]
  for (const v of [1, 'true', 'yes', {}, undefined, null]) {
    const r = await post('/api/test-report', { by: 'general', id: 'r41-t2', passed: v, failures: FAIL })
    assert.equal(r.status, 200, `passed=${JSON.stringify(v)} 应当 200：${JSON.stringify(r.body)}`)
    assert.equal(asObj(taskOf(r).testReport).passed, false,
      `★★ passed=${JSON.stringify(v)} 必须当作 false（严格 === true）`)
  }
  // 而 `passed: true` 时**不需要** failures
  const withTrue = await post('/api/test-report', { by: 'general', id: 'r41-t2', passed: true })
  assert.equal(withTrue.status, 200, '★★ passed=true 时不要求 failures')
  assert.equal(asObj(taskOf(withTrue).testReport).passed, true)
})

test('⑥c ★★ `failures` 会被归一化：对象取三个字段并截断、非对象包成对象、最多 200 条', async () => {
  mk('r41-t3', 'tester', 'in_progress')
  const r = await post('/api/test-report', {
    by: 'general', id: 'r41-t3', passed: false,
    failures: [
      { name: 'n', log: 'l', repro: 'r', extra: '丢掉' },
      'plain-string',
      { name: 'x'.repeat(300), log: 'y'.repeat(5000), repro: 'z'.repeat(3000) },
      ...Array.from({ length: 300 }, (_, i) => ({ name: 'f' + i })),
    ],
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const rep = asObj(taskOf(r).testReport)
  assert.equal(rep.failures.length, 200, '★★ 最多留 200 条')
  assert.deepEqual(rep.failures[0], { name: 'n', log: 'l', repro: 'r' }, '★ 只留三个字段')
  assert.deepEqual(rep.failures[1], { name: 'plain-string', log: '', repro: '' }, '★★ 非对象也要包成对象')
  assert.equal(rep.failures[2].name.length, 200, '★ name 截 200')
  assert.equal(rep.failures[2].log.length, 4000, '★ log 截 4000')
  assert.equal(rep.failures[2].repro.length, 2000, '★ repro 截 2000')
  assert.ok(rep.by, '★ 要记是谁写的')
})

// ── 7. ★★★ 五条共有的形状：`version+1`（乐观锁）────────────────────────
test('⑦ ★★★ 五条**都**把 `version` 自增 1（调用方拿它做乐观锁）', async () => {
  mk('r41-v', 'tester', 'in_progress')
  const v0 = taskOf(await post('/api/patch', { by: 'general', id: 'r41-v', files: [] })).version
  const steps = [
    ['/api/patch', { files: [] }],
    ['/api/artifact', { kind: 'file', path: 'p' }],
    ['/api/review-notes', { file: 'f', verdict: 'ok', note: 'n' }],
    ['/api/test-report', { passed: true }],
    ['/api/progress', {}],
  ]
  let v = v0
  for (const [p, extra] of steps) {
    const t = taskOf(await post(p, { by: 'general', id: 'r41-v', ...extra }))
    assert.ok(t, `${p} 应当成功（base ${JSON.stringify(t)}）`)
    assert.equal(t.version, v + 1, `★★★ ${p} 必须让 version +1（${v} → ${t.version}）`)
    v = t.version
  }
})

// ── 8. 接缝契约 ─────────────────────────────────────────────────────────
const stub = (over = {}) => createTaskRecordsRoutes({
  json: (res, code, p) => { res.sent = { code, payload: p } },
  handleWrite: async (req, res, fn) => {
    const body = req.body ?? {}
    if (body.by !== 'general') { res.sent = { code: 400, payload: { error: '缺少操作者身份 by' } }; return }
    try { res.sent = { code: 200, payload: await fn(body, 'general', 'sc') } }
    catch (e) { res.sent = { code: 400, payload: { error: e instanceof Error ? e.message : String(e) } } }
  },
  getTask: () => ({ id: 't', scope: 's', patches: '[]', review_notes: '[]', artifacts: '[]', testReport: 'null' }),
  db: { prepare: () => ({ run: () => {}, get: () => undefined }) },
  now: () => 'T', parseJson: (s, d) => { try { return JSON.parse(s) } catch { return d } },
  audit: () => {},
  ...over,
})

test('⑧ ★★★ dispatch 契约：看方法、命中回 true、不命中回 false', async () => {
  const router = stub()
  const ctx = (p) => ({ path: p, url: new URL('http://x' + p) })
  for (const p of PATHS) {
    assert.equal(await router.dispatch({ method: 'GET', body: { by: 'general' } }, {}, ctx(p)), false, `★★ ${p} 只认 POST`)
    assert.equal(await router.dispatch({ method: 'POST', body: { by: 'general' } }, {}, ctx(p)), true, `★★ ${p} 应当被认领`)
  }
  assert.equal(await router.dispatch({ method: 'POST', body: {} }, {}, ctx('/api/nope')), false)
  assert.equal(await router.dispatch({ method: 'POST', body: {} }, {}, ctx('/api/progressX')), false, '★ exact 不许退化成 startsWith')
  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.match} ${r.path}`), PATHS.map((p) => `POST exact ${p}`))
  assert.equal(router.id, 'task-records')
})

test('⑨ ★★★ 本族**不许**吃掉同前缀下那条兄弟 `GET /api/artifact/content`', async () => {
  // ★ 它与本族的 `/api/artifact` 同前缀，但在 L6047、孤在很远的另一段 ⇒ 不属本片。
  const router = stub()
  const ctx = (p) => ({ path: p, url: new URL('http://x' + p) })
  assert.equal(await router.dispatch({ method: 'GET', body: {} }, {}, ctx('/api/artifact/content')), false,
    '★★★ 吃了它会让"读产物内容"走错域函数')
  assert.equal(await router.dispatch({ method: 'POST', body: {} }, {}, ctx('/api/artifact/content')), false)
})

test('⑩ ★★ 缺注入项 ⇒ **构造时**就抛（fail closed）', async () => {
  const full = {
    json: () => {}, handleWrite: async () => {}, getTask: () => ({}),
    db: {}, now: () => 0, parseJson: () => [], audit: () => {},
  }
  for (const k of Object.keys(full)) {
    const partial = { ...full }
    delete partial[k]
    assert.throws(() => createTaskRecordsRoutes(partial), /缺注入项/, `★★ 少了 ${k} 必须在构造时就抛`)
  }
})
