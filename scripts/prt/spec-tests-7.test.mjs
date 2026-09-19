// scripts/prt/spec-tests-7.test.mjs
// 目标文档 §7「测试与指标」的逐条投影：归属（§6 退出条件 / 观测）+ 可复跑落点（第 37 轮）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  KINDS,
  SPEC7_PROJECTION,
  checkSpec7,
  checkRepo,
  exitConditions,
  sectionLines,
  specBullets,
} from './spec-tests-7.mjs'

const BULLETS = [
  'Runtime Contract 用 Fake Adapter 覆盖 health、execute、cancel、recover、终态和错误码。',
  '静态检查禁止 Adapter 外新增 DSH API 直接调用。',
]
const EXITS = [{ priority: 'P0', scope: 'x', exit: 'Fake/真实 Adapter 对拍通过；并发、重试、崩溃可恢复' }]
const SUITES = new Map([['a-suite', ['a/a.test.mjs']]])
const TRACKED = ['a/a.test.mjs']

/** 一个形状正确的最小投影（基准）；各用例只改一处。 */
const base = (over = {}) => ([
  {
    key: 'k1', excerpt: BULLETS[0], kind: 'exit-condition',
    exit: 'Fake/真实 Adapter 对拍通过；并发、重试、崩溃可恢复',
    evidence: '套件 `a-suite`', ...over.o1,
  },
  {
    key: 'k2', excerpt: BULLETS[1], kind: 'observational',
    whyNotExitCondition: '§6 五条退出条件里没有一条提到它，所以它是观测要求而不是发布闸门。',
    evidence: '`a/a.test.mjs`', ...over.o2,
  },
])

const run = (over = {}, extra = {}) => checkSpec7({
  bullets: BULLETS, exits: EXITS, projection: base(over),
  suiteFiles: SUITES, tracked: TRACKED, ...extra,
})

test('① ★★ 正对照：真仓库里 §7 每一条都有归属，且落点解得开', () => {
  const r = checkRepo()
  assert.equal(r.ok, true, JSON.stringify(r.violations, null, 1))
  assert.equal(r.reading.bullets, 6, `§7 读到 ${r.reading.bullets} 条要求`)
  assert.equal(r.reading.projection, 6)
  assert.ok(r.reading.pointers >= 15, `落点只有 ${r.reading.pointers} 处`)
  assert.deepEqual(r.reading.byKind, { 'exit-condition': 5, observational: 1 })
})

test('② ★★★ 正向控制：§7 里有一条**没人认领** ⇒ 必须红', () => {
  const r = checkSpec7({
    bullets: BULLETS, exits: EXITS,
    projection: [base()[0]], // 只投影第一条
    suiteFiles: SUITES, tracked: TRACKED,
  })
  assert.equal(r.ok, false, '一条要求没人认领却报绿')
  assert.ok(r.violations.some((v) => v.id === 'bullet-unprojected'),
    JSON.stringify(r.violations))
})

test('③ ★★ 反向控制：投影行**过期**（对应不到 §7 任何一条）⇒ 必须红', () => {
  const p = base()
  p[1] = { ...p[1], excerpt: '这一条 §7 正文里已经删掉了。' }
  const r = checkSpec7({ bullets: BULLETS, exits: EXITS, projection: p, suiteFiles: SUITES, tracked: TRACKED })
  assert.equal(r.ok, false, '过期投影行却报绿')
  assert.ok(r.violations.some((v) => v.id === 'stale-projection'), JSON.stringify(r.violations))
})

test('④ ★★★ 正向控制：声明的退出条件在 §6 里**找不到** ⇒ 必须红', () => {
  // 这条防的是"托着某条退出条件"只是一句话：
  // 一条真的托着 §6 的要求，与一条只是**声称**托着它的要求，在表里长得一样。
  const r = run({ o1: { exit: '我随口编的一条退出条件，§6 里没有' } })
  assert.equal(r.ok, false, '编的退出条件却报绿')
  assert.ok(r.violations.some((v) => v.id === 'exit-link-not-in-section-6'),
    JSON.stringify(r.violations))
})

test('⑤ ★★★ 正向控制：观测档没写"为什么不是退出条件" ⇒ 必须红（不许"记了一笔"）', () => {
  for (const why of ['', '记了一笔', '不是退出条件']) {
    const r = run({ o2: { whyNotExitCondition: why } })
    assert.equal(r.ok, false, `${JSON.stringify(why)} 却报绿`)
    assert.ok(r.violations.some((v) => v.id === 'observational-without-why'),
      JSON.stringify(r.violations))
  }
})

test('⑥ ★★ 反向控制：`whyNotExitCondition` 写够 20 字就不许红', () => {
  const r = run({ o2: { whyNotExitCondition: '§6 那五条退出条件逐字读过，没有一条提指标，所以它是观测要求。' } })
  assert.deepEqual(r.violations, [], JSON.stringify(r.violations))
})

test('⑦ ★★ 正向控制：`kind` 不在那两档里 ⇒ 必须红', () => {
  const r = run({ o1: { kind: 'maybe' } })
  assert.equal(r.ok, false, '乱写的 kind 却报绿')
  assert.ok(r.violations.some((v) => v.id === 'bad-kind'), JSON.stringify(r.violations))
  assert.deepEqual([...KINDS], ['exit-condition', 'observational'])
})

test('⑧ ★★ 正向控制：落点解不开 ⇒ 必须红（读者按它去复核会找不到）', () => {
  const r = run({ o1: { evidence: '套件 `no-such-suite`' } })
  assert.equal(r.ok, false, '不存在的套件却报绿')
  assert.ok(r.violations.some((v) => v.id === 'no-resolvable-evidence'), JSON.stringify(r.violations))
})

test('⑨ ★★★ 正向控制（第 37 轮的真事）：套件别名**漏了 `套件 ` 前缀** ⇒ 必须红', () => {
  // 本表第一版就栽过：`budget-alert` 漏了前缀 ⇒ 解析器不把它当指针 ⇒
  // **它看起来是证据、实际谁都没查**。
  //   > 一个漏了前缀的套件引用，与一个真的解得开的套件引用，
  //   > 在这一格里长得一模一样——只不过前者的绿来自**没被解析**。
  const r = run({ o1: { evidence: '`a-suite`（少了前缀）' } })
  assert.equal(r.ok, false, '漏前缀的套件引用却报绿')
  assert.ok(r.violations.some((v) => v.id === 'pointer-without-suite-prefix'),
    JSON.stringify(r.violations))
})

test('⑩ ★ 反向控制：不构成指针的后引号 token **不许**误报', () => {
  // `mkdtempSync(tmpdir())` / `--check` / 阶段名 `boundary` 都不是套件别名
  const r = run({
    o1: { evidence: '套件 `a-suite`；`--check`、`mkdtempSync(tmpdir())`、`boundary`、`product/heartbeat.mjs`' },
  })
  assert.deepEqual(r.violations, [], '把非套件 token 误报成漏前缀：' + JSON.stringify(r.violations))
})

test('⑪ ★★★ "什么都没查"不许报绿：§7 一条都没读到 / 投影表是空的', () => {
  const noBullets = checkSpec7({ bullets: [], exits: EXITS, projection: base(), suiteFiles: SUITES, tracked: TRACKED })
  assert.equal(noBullets.ok, false, '§7 一条都没读到却报绿')
  assert.equal(noBullets.violations[0].id, 'no-bullets')

  const noProj = checkSpec7({ bullets: BULLETS, exits: EXITS, projection: [], suiteFiles: SUITES, tracked: TRACKED })
  assert.equal(noProj.ok, false, '投影表空的却报绿')
  assert.equal(noProj.violations[0].id, 'no-projection')
})

test('⑫ ★★ 小节解析：§7 与 §6 的条数，以及"取不到小节"与"取到 0 条"要分得开', () => {
  assert.equal(specBullets().length, 6, `§7 读到 ${specBullets().length} 条要求`)
  assert.equal(exitConditions().length, 5, `§6 读到 ${exitConditions().length} 条退出条件`)
  for (const e of exitConditions()) {
    assert.ok(e.exit.length > 10, `退出条件格是空的：${JSON.stringify(e)}`)
    assert.match(e.priority, /^P[0-2]$/)
  }
  // ★ 标题逐字不存在时返回 **null**，而不是空数组：
  //   「这一节没有要求」与「我压根没找到这一节」是两件事——
  //   后者是配置问题（标题改了），前者是内容问题，处置完全不同。
  assert.equal(sectionLines('- a\n- b', '## 7. 测试与指标'), null)
  assert.equal(sectionLines('## 7. 测试与指标\n- a\n- b\n\n## 8. x\n- c', '## 7. 测试与指标').length > 0, true)
  // 小节必须在下一个 `## ` 处停下（不许把 §8 的正文算进来）
  assert.deepEqual(
    sectionLines('## 7. 测试与指标\n- a\n\n## 8. 代码参考\n- b\n', '## 7. 测试与指标')
      .map((l) => l.trim()).filter(Boolean),
    ['- a'],
  )
})

test('⑬ ★★ 真仓库的观测档读数是**如实的**：那一条明说"尚未全部实现"', () => {
  // ⚠️ 这一条刻意是**反向**的：如果哪天 §7 第 6 条真的做完了，
  //   这里会红，而修法是把"尚未全部实现"改成完成状态并补上指标出口的落点——
  //   而不是把这句断言删掉。
  const obs = SPEC7_PROJECTION.find((p) => p.kind === 'observational')
  assert.ok(obs !== undefined, '没有观测档了？')
  assert.match(obs.covered, /未.*实现/, `观测档的读数不再是如实的：${obs.covered}`)
  assert.ok(obs.whyNotExitCondition.length >= 20)
})
