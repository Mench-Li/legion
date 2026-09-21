// ============================================================================
// `sse-tail-guard.mjs` 的判据。
//
// ★ 本套件要防的**不是**"守卫写错了"，而是**守卫自己长了一个洞**：
//   切片 45/49 各出过一次（判据的模式太窄 ⇒ 一片"过期 0"的假绿），
//   切片 51 出过一次（回归选择器这个**代理判据**把新套件静默排除）。
//   ⇒ 所以每条判据都**两个方向**都断言，并且对真实文件也断言。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  SSE_PAIR, MUTABLE_BINDING, RULING_MARKER,
  remainingRouteConditions, mutableModuleBindings, writeCount, mutationCount, byValueInjection, checkSseTail,
} from './sse-tail-guard.mjs'

const REAL = readFileSync('team-hub/server.mjs', 'utf8')

// ───────────────────────── 真实文件 ─────────────────────────

test('① ★★★ 真实 `server.mjs`：守卫通过，且剩下**恰好**那对 SSE', () => {
  const rest = remainingRouteConditions(REAL)
  assert.deepEqual(rest, SSE_PAIR,
    '★★★ 真实文件的剩余路由就是那对 SSE（顺序也钉住）—— 若你刚提取了它们，'
    + '这条会红，那正是要你**有意识**地更新守卫与它的测试')
  assert.deepEqual(checkSseTail(REAL), [], '真实文件上守卫必须无诊断')
})

test('② ★★★ 真实文件：那个绑定确实是**模块级 `let`** 且**真的被写过**', () => {
  assert.ok(mutableModuleBindings(REAL).has(MUTABLE_BINDING), '★ 必须是模块级 let')
  const n = writeCount(REAL, MUTABLE_BINDING)
  assert.ok(n >= 3, `★★★ 至少三处写（L4575 / L4732 / L5492），实测 ${n}`)
})

// ───────────────────────── 谓词本身 ─────────────────────────

test('③ ★★★ `writeCount` 只数写，不把 `==` / `===` / `=>` 当写', () => {
  assert.equal(writeCount('x += 1', 'x'), 1)
  assert.equal(writeCount('x = 1', 'x'), 1)
  assert.equal(writeCount('x++', 'x'), 1)
  assert.equal(writeCount('x--', 'x'), 1)
  assert.equal(writeCount('x *= 2', 'x'), 1)
  // ★ 这些**不是**写
  assert.equal(writeCount('if (x == 1) {}', 'x'), 0, '★★ `==` 不是写')
  assert.equal(writeCount('if (x === 1) {}', 'x'), 0, '★★ `===` 不是写')
  assert.equal(writeCount('const f = (x) => x', 'x'), 0, '★★ `=>` 不是写')
  assert.equal(writeCount('a.x += 1', 'x'), 0, '★ 属性写不算这个名字的写')
  assert.equal(writeCount('y += 1', 'x'), 0, '★ 别的名字不算')
  assert.equal(writeCount('xx += 1', 'x'), 0, '★ 前缀相同的别的名字不算')
})

test('④ ★★★ `byValueInjection`：简写属性算按值，`key: () => …` **不算**', () => {
  assert.equal(byValueInjection('{ json, deliveryBookkeepingFailures, db }', MUTABLE_BINDING), MUTABLE_BINDING,
    '★★★ 裸的简写属性 = 按值注入 ⇒ 必须报')
  assert.equal(byValueInjection('{ json, deliveryBookkeepingFailures }', MUTABLE_BINDING), MUTABLE_BINDING,
    '★ 以 `}` 结尾的简写属性也算')
  // ★★★★★ 这一条是我第一版**判错方向**的地方：名字在 `=>` 右边、后面也跟逗号，
  //   旧判据（"名字后面跟着 , 或 }"）会把它**报成错误** —— 把对的判成错的。
  assert.equal(byValueInjection('{ json, bookkeepingFailures: () => deliveryBookkeepingFailures, db }', MUTABLE_BINDING), null,
    '★★★★★ 按访问器 ⇒ 名字由 `> ` 领着、不是简写属性 ⇒ **不许报**')
  assert.equal(byValueInjection('{ json, db }', MUTABLE_BINDING), null, '★ 根本不注入 ⇒ 不报')
  // ★ 简写属性在前 / 在后都要认出来
  assert.equal(byValueInjection('{ deliveryBookkeepingFailures, json }', MUTABLE_BINDING), MUTABLE_BINDING, '★ 第一个属性')
  assert.equal(byValueInjection('{\n  json,\n  deliveryBookkeepingFailures,\n}', MUTABLE_BINDING), MUTABLE_BINDING, '★ 多行写法')
})

test('④b ★★★★★ `mutationCount` **排除声明**：`let x = 0` 本身不算一次"写"', () => {
  // ★ 这是我第一版守卫**永远不响**的原因：`writeCount` 把声明的 `=` 也算进去了。
  assert.equal(writeCount('let x = 0', 'x'), 1, '★ writeCount 把声明算成 1（这正是陷阱）')
  assert.equal(mutationCount('let x = 0', 'x'), 0, '★★★★★ mutationCount 必须把它排掉 ⇒ 0')
  assert.equal(mutationCount('let x = 0\nx += 1', 'x'), 1)
  assert.equal(mutationCount('let x = 0\nx += 1\nx += 1', 'x'), 2)
  assert.equal(mutationCount('const x = 0', 'x'), 0, '★ const 声明同样排除')
  assert.equal(mutationCount('var x = 0', 'x'), 0, '★ var 声明同样排除')
  assert.equal(mutationCount('x = 1', 'x'), 1, '★ 不是声明的纯赋值仍是写')
  assert.equal(mutationCount('let y = 0\nx += 1', 'x'), 1, '★ 别的名字的声明不参与')
})

test('⑤ ★★★ `remainingRouteConditions` 认得两种形态、且顺序即出现顺序', () => {
  const src = [
    "if (req.method === 'GET' && path === '/a') {",
    "if (req.method === 'POST' && path.startsWith('/b/')) {",
    "if (req.method === 'DELETE' && path === '/c') {",
  ].join('\n')
  assert.deepEqual(remainingRouteConditions(src), ['GET /a', 'POST /b/', 'DELETE /c'])
  assert.deepEqual(remainingRouteConditions(''), [], '★ 空源 ⇒ 空')
  // ★ 不许把 `dispatch` 那行也算成条件
  assert.deepEqual(remainingRouteConditions("if (await router.dispatch(req, res, { path, url })) return"), [],
    '★★ `dispatch` 那一行不是路由条件')
})

// ───────────────────────── 守卫的两个方向 ─────────────────────────

test('⑥ ★★★ 剩下的不是那对 ⇒ 报（多一条、少一条、换一条都报）', () => {
  const extra = REAL.replace(/^/m, '') // 原样
  const withThird = extra + "\nif (req.method === 'GET' && path === '/api/extra') { }\n"
  const p1 = checkSseTail(withThird)
  assert.equal(p1.length, 1, '★★★ 多出第三条 ⇒ 必须报')
  assert.match(p1[0], /不是那对 SSE/)
  assert.match(p1[0], /GET \/api\/extra/, '★★ 报里要列出**实际**是什么（不是只说不匹配）')

  const onlyOne = extra.replace("if (req.method === 'GET' && path === '/api/event-delivery') {", 'if (0) {')
  const p2 = checkSseTail(onlyOne)
  assert.ok(p2.length >= 1, '★★★ 少一条 ⇒ 必须报')
})

test('⑦ ★★★ `let` 变成 `const` ⇒ 报（写法前提变了）', () => {
  const c = REAL.replace(`let ${MUTABLE_BINDING} = 0`, `const ${MUTABLE_BINDING} = 0`)
  assert.notEqual(c, REAL, '★ 替换要真的发生（否则这条判据是空跑）')
  const p = checkSseTail(c)
  assert.equal(p.length, 1)
  assert.match(p[0], /不再是模块级 `let`/)
})

test('⑧ ★★★ 绑定还在、但一次都不写 ⇒ 报', () => {
  // ★ 把所有 `+= 1` 删掉，只留声明
  const noWrite = REAL.split(`${MUTABLE_BINDING} += 1`).join(`${MUTABLE_BINDING} + 1`)
  assert.notEqual(noWrite, REAL, '★ 替换要真的发生')
  assert.equal(writeCount(noWrite, MUTABLE_BINDING), 1, '★ writeCount 只剩声明那一处 `= 0`')
  assert.equal(mutationCount(noWrite, MUTABLE_BINDING), 0, '★★★★★ 真写次数必须是 0 —— 守卫该在这条上响')
  const p = checkSseTail(noWrite)
  assert.equal(p.length, 1, '★★★ 必须报（第一版因为用 writeCount<1 而**永远不响**）')
  assert.match(p[0], /除了声明之外一次都没被写过/)
})

test('⑨ ★★★ 那对**已搬走**、模块也还没建 ⇒ 不报（"还没做"不是"做错了"）', () => {
  const gone = REAL
    .replace("if (req.method === 'GET' && path === '/api/events') {", 'if (0) {')
    .replace("if (req.method === 'GET' && path === '/api/event-delivery') {", 'if (0) {')
  assert.deepEqual(remainingRouteConditions(gone), [], '★ 前提：改完应当 0 条')
  const p = checkSseTail(gone, { files: [['events', '/nonexistent/events.mjs']] })
  assert.deepEqual(p, [], '★★ 那对不在、但模块也还没建 ⇒ 不报')
})

// ★★★★★ 这一段是**补上一个真缺口**：我第一版只测了"模块不存在"，
//   于是 ③ 那条（提取后必须按访问器）**一条判据都碰不到** ——
//   破验当场量出 M5（把 ③ 整体关掉）**没咬住**。
//   ⇒ 用 `opts.files` 指向临时文件，把 ③ 真正跑到。
test('⑨b ★★★★★ 那对已搬走 + 新模块**按值**注入 ⇒ **必须报**', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'sse-guard-'))
  const gone = REAL
    .replace("if (req.method === 'GET' && path === '/api/events') {", 'if (0) {')
    .replace("if (req.method === 'GET' && path === '/api/event-delivery') {", 'if (0) {')
  try {
    const byValue = join(dir, 'ev.mjs')
    writeFileSync(byValue, [
      'export function createEventDeliveryRoutes({',
      '  json,',
      `  ${MUTABLE_BINDING},`,
      '  deliveryStore,',
      '}) { return { id: 1, routes: [], dispatch: async () => false } }',
    ].join('\n'), 'utf8')
    const p = checkSseTail(gone, { files: [['event-delivery', byValue]] })
    assert.equal(p.length, 1, '★★★★★ 按值注入 ⇒ 必须报（这正是"静默冻结"那个入口）')
    assert.match(p[0], /按值/)
    assert.match(p[0], /event-delivery/)

    const byAccessor = join(dir, 'ev2.mjs')
    writeFileSync(byAccessor, [
      'export function createEventDeliveryRoutes({',
      '  json,',
      '  bookkeepingFailures,',
      '  deliveryStore,',
      '}) { return { id: 1, routes: [], dispatch: async () => false } }',
    ].join('\n'), 'utf8')
    const p2 = checkSseTail(gone, { files: [['event-delivery', byAccessor]] })
    assert.deepEqual(p2, [], '★★★ 访问器形态（键名不同、值在装配处才是 `() => …`）⇒ 不报')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑨c ★★★ 注入面是**访问器**（`名字: () => …`）⇒ 不许报', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'sse-guard2-'))
  const gone = REAL
    .replace("if (req.method === 'GET' && path === '/api/events') {", 'if (0) {')
    .replace("if (req.method === 'GET' && path === '/api/event-delivery') {", 'if (0) {')
  try {
    const f = join(dir, 'ev.mjs')
    // ★ 装配处写成 `函数名({ json, bookkeepingFailures: () => deliveryBookkeepingFailures })`
    //   这一形态**会**被当成 deps 区域匹配；它是对的，不许报。
    writeFileSync(f, [
      'export function createEventDeliveryRoutes({',
      '  json,',
      `  bookkeepingFailures: () => ${MUTABLE_BINDING},`,
      '}) { return { id: 1, routes: [], dispatch: async () => false } }',
    ].join('\n'), 'utf8')
    assert.deepEqual(checkSseTail(gone, { files: [['event-delivery', f]] }), [],
      '★★★★★ 名字在 `=>` 右边、后面**也**跟逗号 —— 旧判据会把它判成错的')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑩ ★★★ 真实文件上，守卫**不会**因为"那对还在"就误报 ③ 那一条', () => {
  // ★ 反向自检：确保 ③ 只在 `rest.length === 0` 时生效。
  const p = checkSseTail(REAL)
  assert.deepEqual(p, [], '★★ 那对还在时，③ 那条（检查新模块注入面）**必须不生效**')
})

test('⑩b ★★★★★ 裁定标记必须**在源码里** —— 否则"裁定留下"与"还没做"读数相同', () => {
  assert.ok(REAL.includes(RULING_MARKER), '★★★ 真实 server.mjs 里必须落着那句裁定')
  // ★ 把裁定标记删掉 ⇒ 必须报（这是区分"裁定留下"与"还没做"的唯一机器可读线索）
  const noRuling = REAL.split(RULING_MARKER).join('（此处原有裁定，已删）')
  assert.notEqual(noRuling, REAL, '★ 替换要真的发生')
  assert.deepEqual(remainingRouteConditions(noRuling), SSE_PAIR, '★ 前提：那对还在')
  const p = checkSseTail(noRuling)
  assert.equal(p.length, 1, '★★★★★ 少了裁定标记 ⇒ 必须报')
  assert.match(p[0], /裁定标记/)
  assert.match(p[0], /长得一样/, '★ 报错要说清**为什么**要求它')
})
