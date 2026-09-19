// scripts/prt/design-boundaries.test.mjs
// 目标文档 §2 那 5 条「不可突破的边界」：每条都必须声明怎么被守着（第 38 轮）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ANCHOR,
  CHECKS,
  BOUNDARY_DECLARATIONS,
  checkDesignBoundaries,
  checkRepo,
  designBoundaries,
} from './design-boundaries.mjs'

const B = ['甲边界', '乙边界']
const decl = (over = {}) => ([
  {
    key: 'k1', text: '甲边界', kind: 'mechanical', check: 'ok-a',
    how: '有一个真的判据在守它', ...over.d1,
  },
  {
    key: 'k2', text: '乙边界', kind: 'design',
    why: '它约束的是一个设计判断，没有可机械解析的形状，所以只能写成设计决定。', ...over.d2,
  },
])

/** 两个假判据：都把 `scanned` 与非空期望交出来。 */
const FAKE_CHECKS = {
  'ok-a': () => ({ scanned: 7, found: ['x'], expected: ['x'] }),
}

const run = (over = {}, extra = {}) => checkDesignBoundaries({
  boundaries: B, declarations: decl(over), checks: FAKE_CHECKS, ...extra,
})

test('① ★★ 正对照：真仓库里 5 条边界都有人认领，且机械判据真的查了东西', () => {
  const r = checkRepo()
  assert.equal(r.ok, true, JSON.stringify(r.violations, null, 1))
  assert.equal(r.reading.boundaries, 5)
  assert.equal(r.reading.declarations, 5)
  assert.equal(r.reading.mechanical, 4)
  // ★ 每个机械判据都要**报出扫了几个文件**，且都不是 0
  for (const [k, n] of Object.entries(r.reading.scanned)) {
    assert.ok(n > 0, `${k} 扫了 ${n} 个文件`)
  }
})

test('② ★★★ 正向控制：一条边界**没人认领** ⇒ 必须红', () => {
  const r = checkDesignBoundaries({
    boundaries: B, checks: FAKE_CHECKS,
    declarations: [decl()[0]], // 只认领「甲边界」
  })
  assert.equal(r.ok, false, '一条边界没人认领却报绿')
  assert.ok(r.violations.some((v) => v.id === 'boundary-unowned'), JSON.stringify(r.violations))
})

test('③ ★★ 反向控制：声明**过期**（指向一条已不存在的边界）⇒ 必须红', () => {
  const d = decl()
  d[1] = { ...d[1], text: '这条边界正文里已经删掉了' }
  const r = checkDesignBoundaries({ boundaries: B, declarations: d, checks: FAKE_CHECKS })
  assert.equal(r.ok, false, '过期声明却报绿')
  assert.ok(r.violations.some((v) => v.id === 'stale-declaration'), JSON.stringify(r.violations))
})

test('④ ★★★ 正向控制：声称有机械判据，而判据**解析不到** ⇒ 必须红', () => {
  // 一条声称有判据的边界，与一条真有判据的边界，在表里长得一模一样。
  const r = run({ d1: { check: 'no-such-check' } })
  assert.equal(r.ok, false, '声称的判据不存在却报绿')
  assert.ok(r.violations.some((v) => v.id === 'check-missing'), JSON.stringify(r.violations))
})

test('⑤ ★★★ 正向控制：判据**扫了 0 个文件** ⇒ 必须红（第 38 轮的真事）', () => {
  // 本轮的探针第一版整套假阴性：它调的 `rg` 不在 PATH 上，
  // 而 `catch { return [] }` 把 ENOENT 与"没有匹配"吞成了同一个值 ⇒ 5 条边界全报 0 命中。
  //   > 一个依赖缺失的检索器，与一个真的什么都没匹配到的仓库，
  //   > 在"零命中"这个读数下是同一个东西——只不过前者的 0 来自**没跑**。
  const r = checkDesignBoundaries({
    boundaries: B, declarations: decl(),
    checks: { 'ok-a': () => ({ scanned: 0, found: [], expected: [] }) },
  })
  assert.equal(r.ok, false, '扫了 0 个文件却报绿')
  assert.ok(r.violations.some((v) => v.id === 'check-scanned-nothing'), JSON.stringify(r.violations))
})

test('⑥ ★★★ 正向控制：**边界被破了** ⇒ 必须红，且报出"扫了几个文件 + 期望 vs 实测"', () => {
  const r = checkDesignBoundaries({
    boundaries: B, declarations: decl(),
    checks: { 'ok-a': () => ({ scanned: 7, found: ['x', 'y'], expected: ['x'] }) },
  })
  assert.equal(r.ok, false, '边界被破了却报绿')
  const v = r.violations.find((x) => x.id === 'boundary-breached')
  assert.ok(v !== undefined, JSON.stringify(r.violations))
  assert.match(v.message, /扫了 7 个文件/)
  assert.match(v.message, /期望/)
  assert.match(v.message, /实测/)
})

test('⑦ ★★ 反向控制：设计档写够 20 字就不许红；不足 20 字必须红', () => {
  const ok = run({ d2: { why: '它约束的是设计判断，没有可机械解析的形状，只能写成设计决定并给出读数。' } })
  assert.deepEqual(ok.violations, [], JSON.stringify(ok.violations))
  for (const why of ['', '记了一笔', '没有形状']) {
    const bad = run({ d2: { why } })
    assert.equal(bad.ok, false, `${JSON.stringify(why)} 却报绿`)
    assert.ok(bad.violations.some((v) => v.id === 'design-without-why'), JSON.stringify(bad.violations))
  }
})

test('⑧ ★★ 正向控制：`kind` 不在那两档里 ⇒ 必须红', () => {
  const r = run({ d1: { kind: 'maybe' } })
  assert.equal(r.ok, false, '乱写的 kind 却报绿')
  assert.ok(r.violations.some((v) => v.id === 'bad-kind'), JSON.stringify(r.violations))
})

test('⑨ ★★★ "什么都没查"不许报绿：锚取不到 / 锚后面一条都没有', () => {
  const noAnchor = checkDesignBoundaries({ boundaries: null, declarations: decl(), checks: FAKE_CHECKS })
  assert.equal(noAnchor.ok, false, '锚取不到却报绿')
  assert.equal(noAnchor.violations[0].id, 'anchor-missing')

  const none = checkDesignBoundaries({ boundaries: [], declarations: decl(), checks: FAKE_CHECKS })
  assert.equal(none.ok, false, '锚后面一条都没有却报绿')
  assert.equal(none.violations[0].id, 'no-boundaries')
})

test('⑩ ★★ 锚解析：真文档切出**恰好 5 条**，且"取不到锚"返回 `null`、"文件不存在"抛错', () => {
  const b = designBoundaries()
  assert.equal(b.length, 5, `切出 ${b.length} 条：${JSON.stringify(b)}`)
  assert.equal(b[0], '不自研第二套 Agent Loop')
  assert.equal(b[4], '客户不需要单独安装或升级 DSH')
  // ★ 「这一节没有边界」与「我没找到那一节」是两件事，处置完全不同：
  //   前者返回 null（内容问题），后者抛错（路径问题）。
  const dir = mkdtempSync(join(tmpdir(), 'db-'))
  try {
    const noAnchor = join(dir, 'spec.md')
    writeFileSync(noAnchor, '## 1. x\n\n这里没有那句话。\n', 'utf8')
    assert.equal(designBoundaries(noAnchor), null, '文件在、但锚不在 ⇒ 应当返回 null')
    assert.throws(() => designBoundaries(join(dir, 'nope.md')), '文件不存在 ⇒ 应当抛错（不是静默 null）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑪ ★★ 声明与 §2 那一行**逐字**对齐（两侧都在仓库里，必须落在同一段文本上）', () => {
  const b = new Set(designBoundaries())
  for (const d of BOUNDARY_DECLARATIONS) {
    assert.ok(b.has(d.text), `声明的文本在 §2 里找不到：${d.text}`)
  }
  assert.equal(new Set(BOUNDARY_DECLARATIONS.map((d) => d.key)).size, 5, 'key 有重复')
  assert.ok(ANCHOR.length > 0)
})

test('⑫ ★★ 机械档的 `check` 必须都能解析到 `CHECKS` 里的实现', () => {
  const mech = BOUNDARY_DECLARATIONS.filter((d) => d.kind === 'mechanical')
  assert.equal(mech.length, 4, `机械档有 ${mech.length} 条`)
  for (const d of mech) {
    assert.equal(typeof CHECKS[d.check], 'function', `\`${d.check}\` 没有实现`)
  }
})
