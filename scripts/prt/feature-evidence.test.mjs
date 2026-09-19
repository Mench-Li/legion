// scripts/prt/feature-evidence.test.mjs
// 目标文档的实现投影表：点名的证据必须解得开，且 🟡 行必须说清还差什么（第 36 轮）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  STATUS_RE,
  MUST_SAY_MISSING,
  featureRows,
  checkFeatureEvidence,
  checkRepo,
} from './feature-evidence.mjs'

/** 造一行状态行。`missing` 是最后一格（"还差什么"）。 */
const row = (id, status, body = 'PRT-101', missing = '还差一件具体的事，一句话说完') => ({
  id: id.split(/\s+/)[0],
  label: id,
  name: '名字',
  status,
  line: 1,
  citers: [body],
  missing,
})

const LEDGER = new Set(['PRT-101', 'PRT-102'])
const SUITES = new Map([['runtime-contract', ['runtime/contracts/contract.test.mjs']]])
const TRACKED = ['runtime/contracts/contract.test.mjs', 'whiteboard/packages/shared/test/contract.test.mjs']

test('① ★★ 正对照：真仓库里每一条点名的证据都解得开', () => {
  const r = checkRepo()
  assert.equal(r.ok, true, JSON.stringify(r.violations, null, 1))
  // 它必须**真的查了东西**（第一版读到 0 行却报绿，见 ⑧）
  assert.ok(r.reading.rows >= 25, `只读到 ${r.reading.rows} 条 F 状态行`)
  assert.ok(r.reading.pointers >= 40, `只读到 ${r.reading.pointers} 处证据指针`)
})

test('② ★★★ 正向控制：引用一个台账里不存在的 PRT ⇒ 必须红（两份文档各说各话）', () => {
  const r = checkFeatureEvidence({
    rows: [row('F-99', '✅', 'PRT-777')],
    ledgerPrts: LEDGER, suiteFiles: SUITES, tracked: TRACKED,
  })
  assert.equal(r.ok, false, '引用了不存在的编号却报绿')
  assert.equal(r.violations[0].id, 'feature-cites-unknown-prt')
})

test('③ ★★★ 正向控制：🟡 行的「还差什么」是 `—` ⇒ 必须红（与 ✅ 同形）', () => {
  // ★ 这是本仓第 27 轮**真发生过**的形状：F-22/F-24 的缺口写在「依据」格里，
  //   而「还差什么」是 `—`。格子里有信息、放错了格子，按这一列读表的人读不到它。
  for (const dash of ['—', '–', '-', '']) {
    const r = checkFeatureEvidence({
      rows: [row('F-99', '🟡', 'PRT-101', dash)],
      ledgerPrts: LEDGER, suiteFiles: SUITES, tracked: TRACKED,
    })
    assert.equal(r.ok, false, `🟡 行的"还差什么"是 ${JSON.stringify(dash)} 却报绿`)
    assert.equal(r.violations[0].id, 'partial-row-says-nothing-missing')
  }
})

test('④ ★★ 反向控制：✅ 行的「还差什么」可以是 `—`（那**就是**"不差"）', () => {
  const r = checkFeatureEvidence({
    rows: [row('F-99', '✅', 'PRT-101', '—')],
    ledgerPrts: LEDGER, suiteFiles: SUITES, tracked: TRACKED,
  })
  assert.deepEqual(r.violations, [], '把 ✅ 行的破折号判红了：' + JSON.stringify(r.violations))
})

test('⑤ ★★ 反向控制：⏸/⬜ 行的破折号**不**判红（理由可以正当写在别处）', () => {
  for (const st of ['⏸', '⬜']) {
    const r = checkFeatureEvidence({
      rows: [row('F-99', st, 'PRT-101', '—')],
      ledgerPrts: LEDGER, suiteFiles: SUITES, tracked: TRACKED,
    })
    assert.deepEqual(r.violations, [], `${st} 行被判红：${JSON.stringify(r.violations)}`)
  }
  // ★ 而"要求说清缺口"的状态词表**只**含那三个——写下来是为了让下一个人
  //   不必重新论证"为什么 ⏸ 可以是 `—`"。
  assert.deepEqual([...MUST_SAY_MISSING], ['🟡', '🟡→✅', '✅→🟡'])
})

test('⑥ ★★★ 回归守卫（我自己的假阳性）：`F-05 前半` 与 `F-05 后半` **不是**重复行', () => {
  // ★ 第一版把标签削成编号再比 ⇒ `F-05 前半`/`F-05 后半`（同一件事的两半）
  //   与 `F-18 缺口①/②/③`（每个缺口各一行）全部被报成"重复"，4 处**全是假阳性**。
  //   > 一个把限定词削掉再去重的编号，
  //   > 会把「同一件事的两半」与「同一件事写了两遍」看成同一个东西。
  const r = checkFeatureEvidence({
    rows: [
      row('F-05 前半', '✅', 'PRT-101', '—'),
      row('F-05 后半', '✅', 'PRT-101', '—'),
      row('F-18 缺口①', '✅', 'PRT-101', '—'),
      row('F-18 缺口②', '✅', 'PRT-101', '—'),
    ],
    ledgerPrts: LEDGER, suiteFiles: SUITES, tracked: TRACKED,
  })
  assert.deepEqual(r.violations, [], '限定词被削掉了：' + JSON.stringify(r.violations))
})

test('⑦ ★★★ 正向控制：**同名**状态行出现两次 ⇒ 必须红（两份声明，不知道哪份算）', () => {
  const r = checkFeatureEvidence({
    rows: [row('F-15', '✅', 'PRT-101', '—'), row('F-15', '🟡', 'PRT-101', '缺汇总')],
    ledgerPrts: LEDGER, suiteFiles: SUITES, tracked: TRACKED,
  })
  assert.equal(r.ok, false, '同名行重复却报绿')
  assert.equal(r.violations[0].id, 'feature-label-duplicated')
})

test('⑧ ★★★ "什么都没查"不许报绿（第一版在我自己手里犯过这个错）', () => {
  // 第一版状态列写成 `cells[1]`（那是**名称**）⇒ 读到 **0 行**，
  // 而 CLI 印出「✅ 每一条点名的证据都解得开」。**判据在作者手里犯了一次
  // 它专门要抓的那个形状。**
  const none = checkFeatureEvidence({ rows: [], ledgerPrts: LEDGER, suiteFiles: SUITES, tracked: TRACKED })
  assert.equal(none.ok, false, '一行都没读到却报绿')
  assert.equal(none.violations[0].id, 'no-feature-rows')

  const noLedger = checkFeatureEvidence({
    rows: [row('F-01', '✅')], ledgerPrts: new Set(), suiteFiles: SUITES, tracked: TRACKED,
  })
  assert.equal(noLedger.ok, false, '台账一条都没读到却报绿')
  assert.ok(noLedger.violations.some((v) => v.id === 'no-ledger'))
})

test('⑨ ★★★ 真仓库里那条**真的**歧义引用已被修掉，且判据现在只认全路径', () => {
  // 第 36 轮的真读数：F-01 此前点的是裸名，而全仓有 2 个同名
  // （`runtime/contracts/contract.test.mjs` 45 例 / `whiteboard/.../contract.test.mjs` 26 例）。
  const r = checkRepo()
  assert.deepEqual(r.violations, [], '真仓库还有解不开的引用：' + JSON.stringify(r.violations))
  const bare = checkFeatureEvidence({
    rows: [row('F-01', '✅', '见 `contract.test.mjs`')],
    ledgerPrts: LEDGER, suiteFiles: SUITES, tracked: TRACKED,
  })
  assert.equal(bare.ok, false, '裸名歧义没被抓住')
  assert.equal(bare.violations[0].id, 'feature-cites-ambiguous-test')
})

test('⑩ ★ 只认**状态列落在封闭词表里**的行（文档里还有别的表）', () => {
  // 同一份文档里有若干 3 列的表（例如 §2「关掉的缺口」），它们的"第三格"是证据文本。
  // 不靠封闭词表分，就会把那 12 行读成"状态是 `run-events.test.mjs 18 例…`"。
  assert.equal(STATUS_RE.test('✅'), true)
  assert.equal(STATUS_RE.test('🟡→✅'), true)
  assert.equal(STATUS_RE.test('⬜→🟡'), true)
  assert.equal(STATUS_RE.test('`run-events.test.mjs` 18 例；三条出口都带明细'), false)
  assert.equal(STATUS_RE.test('判据'), false)
  // 真仓库的读数必须是**两个表**的并集（P0 的 14 行 + P1/P2 的 15 行）
  const rows = featureRows()
  assert.ok(rows.length >= 25, `只读到 ${rows.length} 行`)
  const ids = new Set(rows.map((r) => r.id))
  for (const want of ['F-01', 'F-04', 'F-11', 'F-15', 'F-21', 'F-25']) {
    assert.ok(ids.has(want), `主表里的 ${want} 没读到`)
  }
})
