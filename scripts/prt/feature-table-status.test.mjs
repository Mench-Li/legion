// scripts/prt/feature-table-status.test.mjs
// ============================================================================
// 判据自己的判据：状态格与「还差什么」格不相容时**必须红**，
// 而在 **23 个正确的地方**（✅/⏸ 配 `—`）**不许红**。
//
// 两类控制一样重要：
//   · 正向：🟡/⬜ 配空 => 必须红（否则判据没用）；
//   · 反向：✅/⏸ 配 `—` 不许红（**表中 22 行正是这样**；
//     一条"任何状态下都不许 `—`"的规则会红在正确的地方，然后被人整体关掉）。
//
// ★ 全部用**注入的文本**，不起子进程 ⇒ 秒级。只有 ① 读真仓库。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  checkFeatureTable, checkRepo, parseFeatureRows, isEmptyGap, endState, STATUS_DOC, REPO,
} from './feature-table-status.mjs'
import { resolve } from 'node:path'

/** 造一张最小主表（6 列）。 */
const mainRow = (id, status, gap) =>
  `| ${id} | 名称 | ${status} | \`a.mjs\` | 证据 | ${gap} |`

/** 造一张最小 P1 表（5 列）。 */
const fiveRow = (id, status, gap) => `| ${id} | 名称 | ${status} | \`a.mjs\` | ${gap} |`

const doc = (...rows) => [
  '| 编号 | 名称 | 状态 | 代码落点 | 判据 / 证据 | 还差什么 |',
  '| --- | --- | --- | --- | --- | --- |',
  ...rows,
  '',
].join('\n')

const check = (text) => checkFeatureTable({ text })

test('① 真实仓库：没有一行「没做完却说不差什么」，且扫描面与跳过面都报出来', () => {
  const r = checkRepo()
  assert.equal(r.ok, true, `真仓库有不相容的行：${JSON.stringify(r.violations, null, 1)}`)
  // 扫描面不许空，也不许缩水（29 是第 27 轮实测，只许涨）
  assert.ok(r.rows >= 29, `只解析到 ${r.rows} 行功能表 ⇒ 解析器跑偏了`)
  // ★ 三个数分开报：受约束 / 豁免 / 跳过。
  //   "豁免 22 行"与"22 行都合规"在只报 ok 的输出里长得一样。
  assert.ok(r.checked >= 7, `受规则约束的只有 ${r.checked} 行 ⇒ 规则被架空了`)
  assert.ok(r.exempt >= 20, `豁免行只有 ${r.exempt} 行 ⇒ ✅/⏸ 的识别坏了`)
  assert.equal(r.checked + r.exempt, r.rows, '`checked + exempt` 必须等于总行数')
  // 跳过的必须是**没有状态列**的表（§2 缺口投影表、§5.1 边界表），不是功能行
  assert.ok(r.skipped.length > 0, '一行都没跳过 ⇒ 列数判定坏了（那些表确实不是功能表）')
  for (const s of r.skipped) {
    assert.notEqual(s.cols, 5, `5 列的行被跳过了：${s.id}`)
    assert.notEqual(s.cols, 6, `6 列的行被跳过了：${s.id}`)
  }
})

test('② ★ 正向控制：🟡 / ⬜ 配一个空占位 ⇒ **那一行**必须红', () => {
  for (const gap of ['—', '', '   ', '-', '–']) {
    const r = check(doc(mainRow('F-22', '🟡', gap), mainRow('F-01', '✅', '—')))
    assert.equal(r.ok, false, `状态 🟡 配 ${JSON.stringify(gap)} 却没红 ⇒ 判据没在查`)
    assert.equal(r.violations.length, 1, `红了 ${r.violations.length} 条，应恰好 1 条`)
    assert.match(r.violations[0].message, /F-22/)
  }
  // ⬜（完全没做）同理
  const r = check(doc(mainRow('F-30', '⬜', '—')))
  assert.equal(r.ok, false, '⬜ 配 `—` 没红')
})

test('②b ★★ 反向控制（对称）：✅ 与 ⏸ 配 `—` **不许**红 —— 否则判据红在 22 个正确的地方', () => {
  const r = check(doc(
    mainRow('F-01', '✅', '—'),
    fiveRow('F-23', '⏸', '—'),
    fiveRow('F-25', '⏸', '—'),
  ))
  assert.deepEqual(r.violations, [],
    `✅/⏸ 配 \`—\` 被误报了 ⇒ 这条判据会在真实表上立刻红（21 行 ✅ 都这么写），`
    + '然后被人整体关掉。那比没有更坏。')
  assert.equal(r.checked, 0)
  assert.equal(r.exempt, 3)
})

test('③ ★★ 迁移写法取**终点**：`🟡→✅` 豁免，`⬜→🟡` 受约束', () => {
  assert.equal(endState('🟡→✅'), '✅')
  assert.equal(endState('⬜→🟡'), '🟡')
  assert.equal(endState('🟡'), '🟡')

  // 🟡→✅ 的终点是 ✅ ⇒ 空 `—` 合法（真表里 F-18/F-20 就是这么写的）
  const ok = check(doc(fiveRow('F-18', '🟡→✅', '—')))
  assert.deepEqual(ok.violations, [], '🟡→✅ 配 `—` 被误报 ⇒ 终点没取对')

  // ⬜→🟡 的终点是 🟡 ⇒ 空 `—` 必须红
  const bad = check(doc(fiveRow('F-21', '⬜→🟡', '—')))
  assert.equal(bad.ok, false, '⬜→🟡 配 `—` 没红 ⇒ 起点被当成了终点')
})

test('④ ★ 控制：列数不是 5/6 的表**跳过**，不误报（§2 缺口投影表 / §5.1 边界表）', () => {
  const text = [
    '| 编号 | 缺口描述 | 证据 |',
    '| --- | --- | --- |',
    '| F-05 前半 | 11 种读完即弃 | `run-events.test.mjs` 18 例 |',
    '| F-21 | 四条能力全部不存在 | `registry.test.mjs` 37 例 |',
    '',
    '| 项 | 已做到 | 还差 |',
    '| --- | --- | --- |',
    '| F-21 连接器 | 未声明即拒绝 | 没有连过任何一个真的 MCP server |',
    '',
  ].join('\n')
  const r = check(text)
  assert.deepEqual(r.violations, [], '把没有状态列的表当功能表查了 ⇒ 会红在正确的地方')
  assert.equal(r.rows, 0, '这些行不该进受管集合')
  assert.equal(r.skipped.length, 3, `应跳过 3 行，实际 ${r.skipped.length}`)
})

test('⑤ ★★ 回归：本轮修掉的两行（F-22 / F-24）**不许**再退回 `—`', () => {
  // 这两行就是第 27 轮的发现：🟡 配 `—`。把它们的缺口格改回 `—` 必须红。
  for (const id of ['F-22', 'F-24']) {
    const r = check(doc(fiveRow(id, '🟡', '—')))
    assert.equal(r.ok, false, `${id} 的缺口格退回 \`—\` 却没红`)
    assert.match(r.violations[0].message, new RegExp(id))
  }
  // 而真仓库里它们今天**不是** `—`
  const real = checkRepo()
  const rows = parseFeatureRows(readFileSync(resolve(REPO, STATUS_DOC), 'utf8')).rows
  for (const id of ['F-22', 'F-24']) {
    const row = rows.find((x) => x.id.trim() === id)
    assert.ok(row !== undefined, `真表里找不到 ${id}`)
    assert.equal(isEmptyGap(row.gap), false, `真表里 ${id} 的缺口格仍是空的`)
  }
  assert.equal(real.ok, true)
})

test('⑥ 空格/全角破折号都算「空」——不许靠写一个空格过关', () => {
  assert.equal(isEmptyGap(''), true)
  assert.equal(isEmptyGap('   '), true)
  assert.equal(isEmptyGap('—'), true)
  assert.equal(isEmptyGap(' - '), true)
  assert.equal(isEmptyGap('–'), true)
  // 有内容就不算空（哪怕只有一个字）
  assert.equal(isEmptyGap('缺'), false)
  assert.equal(isEmptyGap('未做：多用户写面 ACL'), false)
})

test('⑦ 解析器：`F-05 前半` / `F-19 缺口①` 这种带后缀的行也要认出来', () => {
  const r = check(doc(mainRow('F-05 前半', '🟡', '—')))
  assert.equal(r.rows, 1, '带后缀的行没被认出来 ⇒ 与 suite-counts 坑 A 同形')
  assert.equal(r.ok, false)
})
