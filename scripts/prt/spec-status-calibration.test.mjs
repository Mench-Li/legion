// scripts/prt/spec-status-calibration.test.mjs
// ============================================================================
// 判据自己的判据。三类控制一样重要：
//   · 正向：注记说没做完 + 表里全 ✅ + 校准表里没有 ⇒ **必须红**
//   · 反向：注记**仍然成立**（表里还是 🟡）⇒ **不许**要求它进校准表
//   · 反向：校准表里的状态与表不一致 ⇒ 必须红（校准表自己过期）
// 全部用注入文本，秒级；只有 ① 读真仓库。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  checkCalibration, checkRepo, parseSpecHeadings, parseStatusTable, parseCalibration,
  assertsIncomplete, endState, SPEC_DOC, STATUS_DOC, REPO,
} from './spec-status-calibration.mjs'

/**
 * 造一小段规格：标题 + §1.2 校准表。
 *
 * ★ `filler`（默认开）会加一对**自洽的**填充项（F-90，注记说没做完 + 表里 ✅
 *   + 校准表里有它）。这是刻意的：判据有两条"什么都没查 ⇒ 不许报绿"的守卫
 *   （扫到 0 条注记 / 校准表为空），如果不加填充，**每条控制测试都会红在那两条
 *   守卫上**，于是测不到它自己那条规则——控制测试就假了。
 *   要测那两条守卫本身，传 `{ filler: false }`。
 */
const FILLER_HEADING = '#### F-90 填充功能（基础已落地，收口中）'
const FILLER_CALIB = '| F-90 | 基础已落地，收口中 | ✅ | 填充 |'

const specOf = (headings, calibRows = [], { filler = true } = {}) => [
  '# 规格',
  '',
  ...(filler ? [FILLER_HEADING] : []),
  ...headings,
  '',
  '## 1.2 状态注记校准',
  '',
  '| 功能 | 原注记 | 当前状态 | 依据 |',
  '|---|---|---|---|',
  ...(filler ? [FILLER_CALIB] : []),
  ...calibRows,
  '',
  '## 2. 架构基线',
  '',
].join('\n')

/**
 * 造一小段状态表（主表 6 列）。`filler` 同上（F-90 = ✅）。
 */
const statusOf = (rows, { filler = true } = {}) => [
  '| 编号 | 名称 | 状态 | 代码落点 | 判据 / 证据 | 还差什么 |',
  '|---|---|---|---|---|---|',
  ...(filler ? ['| F-90 | 填充 | ✅ | `a.mjs` | 证据 | — |'] : []),
  ...rows.map(([id, st]) => `| ${id} | 名称 | ${st} | \`a.mjs\` | 证据 | — |`),
  '',
].join('\n')

const check = (specText, statusText) => checkCalibration({ specText, statusText })

/** 这些违规里有没有一条**点名 F-99** 的。 */
const aboutF99 = (r) => r.violations.filter((v) => JSON.stringify(v).includes('F-99'))

test('① 真实仓库：7 条被取代的注记都在校准表里，且与状态表一致', () => {
  const r = checkRepo()
  assert.equal(r.ok, true, '真仓库红了：' + JSON.stringify(r.violations, null, 1))
  assert.equal(r.headings, 14, `规格标题应 14 条，实际 ${r.headings} ⇒ 解析器跑偏了`)
  assert.equal(r.annotated, 8, `带"没做完"注记的应 8 条，实际 ${r.annotated}`)
  assert.equal(r.superseded, 7, `已被取代的应 7 条，实际 ${r.superseded}`)
  assert.equal(r.calib, 7, `校准表应 7 条，实际 ${r.calib}`)
  // ★ 7 = 8 − 1：F-04 的注记仍然成立（它今天还是 🟡）
  assert.equal(r.annotated - r.superseded, 1, '差额应当恰好是那个仍然没做完的 F-04')
})

test('② ★★ 回归：真仓库里 F-04 的注记仍然成立 ⇒ **不许**进校准表', () => {
  const specText = readFileSync(resolve(REPO, SPEC_DOC), 'utf8')
  const statusText = readFileSync(resolve(REPO, STATUS_DOC), 'utf8')
  const calib = parseCalibration(specText)
  assert.equal(calib.some((c) => c.id === 'F-04'), false,
    'F-04 还没做完，却进了"已被取代"的校准表 ⇒ 那张表不再回答它该回答的问题')
  // 而它的状态确实是 🟡（即注记仍成立）
  const st = parseStatusTable(statusText).get('F-04')
  assert.equal(st.aggregate, '🟡', `F-04 今天应是 🟡，实际 ${st.aggregate}`)
})

test('③ ★ 正向控制：注记说没做完 + 表里全 ✅ + 校准表里没有 ⇒ 必须红', () => {
  const spec = specOf(['#### F-99 某个功能（基础已落地，收口中）'])
  const status = statusOf([['F-99', '✅']])
  const r = check(spec, status)
  assert.equal(r.ok, false, '没红 ⇒ 判据没在比对')
  assert.ok(r.violations.some((v) => v.id === 'spec-note-superseded-unlisted'),
    '红的不是"未登记"：' + JSON.stringify(r.violations))
})

test('③b ★★ 反向控制：注记说没做完 + 表里还是 🟡 ⇒ **不许**要求它进校准表', () => {
  const spec = specOf(['#### F-99 某个功能（尚未完成大规模提取）'])
  const status = statusOf([['F-99', '🟡']])
  const r = check(spec, status)
  assert.deepEqual(aboutF99(r), [],
    '注记仍然成立却被要求登记 ⇒ 会红在正确的地方（F-04 就是这样）')
  assert.equal(r.ok, true, '整体也该是绿的：' + JSON.stringify(r.violations))
  assert.equal(r.superseded, 1, '只有填充项 F-90 算被取代')
})

test('③c 反向控制：注记**没**说没做完 ⇒ 不许要求它进校准表', () => {
  const spec = specOf(['#### F-99 某个功能（已交付）'])
  const status = statusOf([['F-99', '✅']])
  const r = check(spec, status)
  assert.deepEqual(aboutF99(r), [],
    '注记没说完却被要求校准：' + JSON.stringify(r.violations))
  assert.equal(r.ok, true)
})

test('④ ★★ 反向控制：校准表里的状态与状态表不一致 ⇒ 必须红（校准表自己过期）', () => {
  const spec = specOf(
    ['#### F-99 某个功能（基础已落地，收口中）'],
    ['| F-99 | 基础已落地，收口中 | ✅ | x |'],
  )
  // 状态表说 F-99 退回 🟡 ⇒ 校准表宣称的 ✅ 过期了
  const r = check(spec, statusOf([['F-99', '🟡']]))
  assert.equal(r.ok, false, '校准表过期却没红 ⇒ 它成了一句新的、没人核的话')
  assert.ok(r.violations.some((v) => v.id === 'calibration-status-mismatch'),
    JSON.stringify(r.violations))
  // 对称：状态表说 ✅ 而校准表写 🟡，同样必须红
  const spec2 = specOf(
    ['#### F-99 某个功能（基础已落地，收口中）'],
    ['| F-99 | 基础已落地，收口中 | 🟡 | x |'],
  )
  const r2 = check(spec2, statusOf([['F-99', '✅']]))
  assert.equal(r2.ok, false, '校准表说没做完而表说 ✅，没红')
})

test('⑤ ★★ 控制：校准表里不许有"注记还没被取代"的条目', () => {
  // 注记没说完，却给它写了一条校准 ⇒ 那是新写的一句没人对照的话
  const r = check(
    specOf(['#### F-99 某个功能（已交付）'], ['| F-99 | 已交付 | ✅ | x |']),
    statusOf([['F-99', '✅']]),
  )
  assert.equal(r.ok, false, '给"没说没做完"的功能写校准却没红')
  assert.ok(r.violations.some((v) => v.id === 'calibration-not-superseded'),
    JSON.stringify(r.violations))
})

test('⑥ ★★ 控制：扫到 0 条注记 / 空校准表 ⇒ 都不许报绿（"什么都没查"≠"全对"）', () => {
  // 一条"说没做完"的注记都没有（填充也关掉，否则扫面不为空）
  const r1 = check(
    specOf(['#### F-99 某个功能'], [], { filler: false }),
    statusOf([['F-99', '✅']], { filler: false }),
  )
  assert.equal(r1.ok, false, '一条"说没做完"的注记都没有却报绿 ⇒ 判据被架空了')
  assert.ok(r1.violations.some((v) => v.id === 'spec-headings-empty'),
    JSON.stringify(r1.violations))

  // 校准表是空的（填充也关掉）
  const r2 = check(
    specOf(['#### F-99 某个功能（基础已落地，收口中）'], [], { filler: false }),
    statusOf([['F-99', '✅']], { filler: false }),
  )
  assert.equal(r2.ok, false, '校准表为空却报绿')
  assert.ok(r2.violations.some((v) => v.id === 'calibration-empty'),
    JSON.stringify(r2.violations))
})

test('⑦ 迁移写法取终点：`🟡→✅` 算 ✅；`⬜→🟡` 不算', () => {
  assert.equal(endState('🟡→✅'), '✅')
  assert.equal(endState('⬜→🟡'), '🟡')
  // 多行聚合：一 ✅ 一 ✅ ⇒ ✅
  const m = parseStatusTable(statusOf([['F-05 前半', '✅'], ['F-05 后半', '✅']]))
  assert.equal(m.get('F-05').aggregate, '✅')
  // 一 ✅ 一 🟡 ⇒ 🟡（注记仍部分成立）
  const m2 = parseStatusTable(statusOf([['F-05 前半', '✅'], ['F-05 后半', '🟡']]))
  assert.equal(m2.get('F-05').aggregate, '🟡')
  assert.deepEqual(m2.get('F-05').rows, ['F-05 前半', 'F-05 后半'])
})

test('⑧ 封闭词表：命中即算"说没做完"（宁可多要求几条校准）', () => {
  for (const t of ['待补', '收口中', '待完成', '尚未做', '未完成', '部分已落地']) {
    assert.equal(assertsIncomplete(t), true, `${t} 应被算成"说没做完"`)
  }
  for (const t of ['已交付', '已落地', '完成', '']) {
    assert.equal(assertsIncomplete(t), false, `${t} 不该被算成"说没做完"`)
  }
  assert.equal(assertsIncomplete(null), false)
})

test('⑨ 解析器：`F-05 前半` 这种带后缀的行归到 `F-05`', () => {
  const m = parseStatusTable(statusOf([['F-05 前半', '✅']]))
  assert.ok(m.has('F-05'), '带后缀的行没归到 F-05')
  assert.equal(m.get('F-05').rows[0], 'F-05 前半')
})

test('⑩ 解析器：只认 §1.2 里的表，别处的 F-* 表格不许读进来', () => {
  const spec = [
    '## 1.1 别的节',
    '',
    '| 功能 | 原注记 | 状态 | 依据 |',
    '|---|---|---|---|',
    '| F-98 | 不该被读进来 | ✅ | x |',
    '',
    '## 1.2 状态注记校准',
    '',
    '| 功能 | 原注记 | 当前状态 | 依据 |',
    '|---|---|---|---|',
    '| F-99 | 基础已落地，收口中 | ✅ | x |',
    '',
  ].join('\n')
  const calib = parseCalibration(spec)
  assert.deepEqual(calib.map((c) => c.id), ['F-99'],
    '读到了 §1.1 里的表 ⇒ 会把别处的表格当成校准表')
})

test('⑪ 解析器：同一个 F-NN 出现两次标题时只取第一条（不许重复计数）', () => {
  const h = parseSpecHeadings([
    '#### F-99 功能（基础已落地，收口中）',
    '',
    '#### F-99 功能（再次出现）',
    '',
  ].join('\n'))
  assert.equal(h.length, 1, `同一个 F-99 被解析成 ${h.length} 条`)
})

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 第 47 轮：`parseStatusTable` 是功能对照表的**第三个手写解析器**
//
// 它自己定格子数（`≠5 且 ≠6 ⇒ continue`）、自己取状态；而"认不出的状态"
// 会安静地落进 `aggregate` 的 **"其余 ⇒ 🟡"** 那一支。
//
//   > 一个"认不出就算部分完成"的默认值，与一份"真的有一部分没做完"的表，
//   > 在汇总里是同一个读数——
//   > 只不过前者会把**读不出来的东西**报成一个**看起来需要关注**的数。
//
// 实测（`scripts/probes/_probe-status-table-owner.mjs`）差异**今天不显形**
// （真文档 25 个 F-NN / 29 行，两个解析器**一致**）—— 而这正是修它的时候。
// ══════════════════════════════════════════════════════════════════════════

/** 造一张状态表，指定状态格与格子数。 */
const tableWith = (statusCell, extra = '') => [
  '| 编号 | 名称 | 状态 | 代码落点 | 判据 / 证据 | 还差什么 |',
  '|---|---|---|---|---|---|',
  `| F-99 | 名称 | ${statusCell} | \`a.mjs\` | 证据 | — |${extra}`,
  '',
].join('\n')

test('⑫ ★★★ 认不出的状态格必须**抛**，不许静默归成 🟡', () => {
  // ★ 旧行为：`🔵` 落进 `aggregate` 的"其余 ⇒ 🟡"⇒ 读不出来被报成"部分完成"。
  assert.throws(() => parseStatusTable(tableWith('🔵')), /状态格不是已知形状/,
    '认不出的状态被静默算成了某一档 ⇒ "读不出来"与"真的没做完"同形')
  // ★ 反面控制：**四个合法终态**一个都不许抛（否则上面那条可能只是"它什么都抛"）。
  for (const st of ['✅', '🟡', '⬜', '⏸']) {
    assert.doesNotThrow(() => parseStatusTable(tableWith(st)), `${st} 是合法状态，却被判成非法`)
  }
  // ★ 箭头写法也必须认（那是同一张词表的另一组许可形状）。
  assert.doesNotThrow(() => parseStatusTable(tableWith('🟡→✅')),
    '`🟡→✅` 是合法形状，却被判成非法')
})

test('⑬ ★★ 格子数：`parseStatusTable` 与 `parseCalibration` 必须用**同一条**阈值', () => {
  // ★ 修好之前：本函数 `≠5 且 ≠6 ⇒ continue`，而**同一个文件里**的
  //   `parseCalibration()` 用 `< 4` —— 同一张表、同一个文件、两条接受规则。
  //   后果：4 格 / 7 格的状态行被**静默跳过**（与"这一行不存在"同形）。
  const withCols = (n) => {
    const cells = ['F-99', '名称', '✅', '`a.mjs`', '证据', '—', '附注'].slice(0, n)
    return ['| 编号 | 名称 | 状态 | 代码落点 | 判据 / 证据 | 还差什么 |',
      '|---|---|---|---|---|---|', `| ${cells.join(' | ')} |`, ''].join('\n')
  }
  for (const n of [4, 5, 6, 7]) {
    const m = parseStatusTable(withCols(n))
    assert.ok(m.has('F-99'),
      `${n} 格的状态行被静默跳过了 —— 而"格子数变了"与"这一行不存在"在汇总里同形`)
  }
  // ★ 反面控制：**3 格**是**另一张表**（`| 缺口 | 读数 | 判据 |`），必须仍然跳过。
  const other = [
    '| 缺口 | 读数 | 判据 |',
    '| --- | --- | --- |',
    '| F-99 缺口 | 29 | 某判据 |',
    '',
  ].join('\n')
  assert.equal(parseStatusTable(other).size, 0,
    '把另一张 3 格表当成了功能对照表 ⇒ 阈值放宽过头了')
})
