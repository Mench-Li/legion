// scripts/prt/suite-counts.test.mjs
// ============================================================================
// 判据自己的判据：`suite-counts` 必须**在该红的时候红**，而且**只在该红的地方红**。
//
// 这个套件里两类控制一样重要：
//   · **正向**：数错了必须报（否则判据没用）；
//   · **反向**：历史读数、非主表的行、解析不到的名字**不许**报
//     （否则判据会在真实仓库上立刻红，然后被人整体关掉 —— 那比没有还坏）。
//
// ★ 除 ① 之外全部用**注入的 `counts` 映射**，不起子进程 ⇒ 这个套件是秒级的。
//   只有一个用例真跑仓库，用来证明"注入的那套东西与真实的那套是同一个"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseCountClaims, resolveTargets, checkSuiteCounts, checkRepo,
  suiteFilesFromCi, MAIN_ROW_RE,
} from './suite-counts.mjs'

/** 造一份最小主表 + 一些非主表内容。 */
function docWith(rows, extra = '') {
  return [
    '# 状态',
    '',
    '| 编号 | 名称 | 状态 | 代码落点 | 判据 / 证据 | 还差什么 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    extra,
  ].join('\n')
}

const TRACKED = [
  'team-hub/run-events.test.mjs',
  'team-hub/budget-alert.test.mjs',
  'runtime/adapters/dsh/adapter.test.mjs',
  'runtime/contracts/contract.test.mjs',
  'runtime/contracts/fake-adapter.test.mjs',
]
const SUITES = new Map([
  ['runtime-contract', ['runtime/contracts/contract.test.mjs', 'runtime/contracts/fake-adapter.test.mjs']],
  ['dsh-adapter', ['runtime/adapters/dsh/adapter.test.mjs']],
])
const COUNTS = new Map([
  ['team-hub/run-events.test.mjs', 18],
  ['team-hub/budget-alert.test.mjs', 20],
  ['runtime/adapters/dsh/adapter.test.mjs', 98],
  ['runtime/contracts/contract.test.mjs', 45],
  ['runtime/contracts/fake-adapter.test.mjs', 19],
])

const check = (doc) => checkSuiteCounts({
  docText: doc, trackedTests: TRACKED, suiteFiles: SUITES, counts: COUNTS,
})

test('① 真实仓库：主表计数与实测一致，且**没有一条被静默跳过**', () => {
  const r = checkRepo()
  assert.equal(r.ok, true, `主表有计数声明过期：${JSON.stringify(r.violations, null, 1)}`)
  // 扫描面不许是空的，也不许悄悄缩水（32 是今天的实测，只许涨）
  assert.ok(r.total >= 30, `只解析到 ${r.total} 条计数声明 ⇒ 提取器跑偏了`)
  // ★ 这一条是关键：`checked + skipped === total`，且 skipped 必须为 0。
  //   否则"跳过 30 条"与"32 条全对"在只有 ok 的输出里是同一个读数。
  assert.equal(r.skipped.length, 0, `有 ${r.skipped.length} 条声明被跳过：${JSON.stringify(r.skipped)}`)
  assert.equal(r.checked, r.total, `已核 ${r.checked} ≠ 声明 ${r.total}`)
})

test('② ★ 反向控制：把一个数改错 ⇒ **那一条**必须红，而且带得出正确值', () => {
  for (const [bad, good, name] of [[17, 18, 'team-hub/run-events.test.mjs'], [999, 98, 'runtime/adapters/dsh/adapter.test.mjs']]) {
    const doc = docWith([`| F-01 | 甲 | ✅ | \`x.mjs\` | 套件 \`${name}\`（${bad} 例） | — |`])
    const r = check(doc)
    assert.equal(r.ok, false, `把 ${name} 的例数改成 ${bad} 却没红 ⇒ 判据没在查`)
    assert.equal(r.violations.length, 1, `红了 ${r.violations.length} 条，应恰好 1 条`)
    assert.equal(r.violations[0].real, good, '报出来的实测值不对')
    assert.match(r.violations[0].message, new RegExp(`${bad} 例`))
  }
})

test('②b 反向控制（对称）：数**对**了就不许红 —— 否则判据是狼来了', () => {
  const doc = docWith([`| F-01 | 甲 | ✅ | \`x.mjs\` | 套件 \`team-hub/run-events.test.mjs\`（18 例） | — |`])
  const r = check(doc)
  assert.deepEqual(r.violations, [], `数对了却红了：${JSON.stringify(r.violations)}`)
  assert.equal(r.checked, 1)
})

test('③ ★★ 套件级声明要把该套件的**所有文件**加起来（分母不能只取一个）', () => {
  // runtime-contract = contract(45) + fake-adapter(19) = 64
  const okDoc = docWith([`| F-01 | 甲 | ✅ | \`x.mjs\` | 套件 \`runtime-contract\`（64 例） | — |`])
  assert.deepEqual(check(okDoc).violations, [], '把套件总数算对了却红了')

  // 只算第一个文件（45）就会漏判 —— 这条是"分母错"的回归
  const badDoc = docWith([`| F-01 | 甲 | ✅ | \`x.mjs\` | 套件 \`runtime-contract\`（45 例） | — |`])
  const r = check(badDoc)
  assert.equal(r.ok, false, '只算了套件里第一个文件 ⇒ 这是"分母错"，必须红')
  assert.equal(r.violations[0].real, 64)
})

test('④ ★★ 非主表的行**不许**被查（否则会红在历史上，然后被人关掉）', () => {
  const doc = [
    '| 编号 | 名称 | 状态 | 代码落点 | 判据 / 证据 | 还差什么 |',
    '| --- | --- | --- | --- | --- | --- |',
    '| F-01 | 甲 | ✅ | `x.mjs` | 套件 `team-hub/run-events.test.mjs`（18 例） | — |',
    '',
    '> 本轮把 `team-hub/run-events.test.mjs` 从 5 例做到 9 例。',   // 历史读数（错，但必须留着）
    '',
    '## §5 裁决表',
    '| 条 | 决定 | 具体 | 状态 | 后果 |',
    '| --- | --- | --- | --- | --- |',
    '| 7 | 某事 | 套件 `team-hub/run-events.test.mjs`（3 例） | 待裁 | — |',
  ].join('\n')
  const r = checkSuiteCounts({ docText: doc, trackedTests: TRACKED, suiteFiles: SUITES, counts: COUNTS })
  assert.equal(r.total, 1, `只该提取 1 条（主表那条），实际 ${r.total} ⇒ 提取器扫到了非主表的行`)
  assert.deepEqual(r.violations, [], '历史读数被当成"过期声明"报了 ⇒ 这条判据会红在正确的地方')
})

test('⑤ ★ 行首是 `| F-05 前半 |` / `| F-19 缺口① |` 的主表行必须被认出来', () => {
  // 回归：`/^\|\s*(F-\d+)\s*\|/` 认不出带后缀的行 ⇒ 只认到 20 条而实际 33 条。
  assert.ok(MAIN_ROW_RE.test('| F-05 前半 | 运行明细 | ✅ | `a.mjs` | 套件 `x`（1 例） | — |'))
  assert.ok(MAIN_ROW_RE.test('| F-19 缺口① | 七类版本 | 🟡 | `a.mjs` | 套件 `x`（1 例） | — |'))
  assert.ok(MAIN_ROW_RE.test('| F-21 | 连接器 | 🟡 | `a.mjs` | 套件 `x`（1 例） | — |'))
  // 非主表行不许认
  assert.ok(!MAIN_ROW_RE.test('| 7 | 某事 | 具体 | 状态 | 后果 |'))
  assert.ok(!MAIN_ROW_RE.test('| --- | --- | --- | --- | --- | --- |'))
  const doc = docWith([
    '| F-05 前半 | 运行明细 | ✅ | `a.mjs` | 套件 `team-hub/run-events.test.mjs`（18 例） | — |',
    '| F-19 缺口① | 七类版本 | 🟡 | `a.mjs` | 套件 `team-hub/budget-alert.test.mjs`（20 例） | — |',
  ])
  assert.equal(check(doc).total, 2, '带后缀的行没被提取到')
})

test('⑥ ★ 名字归一化：三种写法都要落到同一个文件', () => {
  const variants = ['team-hub/run-events.test.mjs', 'run-events.test.mjs', 'run-events']
  for (const v of variants) {
    const doc = docWith([`| F-01 | 甲 | ✅ | \`x.mjs\` | 套件 \`${v}\`（18 例） | — |`])
    const r = check(doc)
    assert.equal(r.checked, 1, `\`${v}\` 没被解析到文件（checked=${r.checked}）`)
    assert.deepEqual(r.violations, [], `\`${v}\` 报了错：${JSON.stringify(r.violations)}`)
  }
  // 带扩展名的模块名（`budget-alert.mjs`）也要认 —— 第一版把它变成
  // `budget-alert.mjs.test.mjs` 而静默跳过。
  const doc = docWith([`| F-01 | 甲 | ✅ | \`x.mjs\` | 套件 \`budget-alert.mjs\`（20 例） | — |`])
  assert.equal(check(doc).checked, 1, '`budget-alert.mjs` 没被解析到（带扩展名的写法）')
})

test('⑦ 解析不到 / 有歧义的名字进 `skipped`，**不进** `checked`，也不静默算通过', () => {
  const r = resolveTargets(
    [{ row: 'F-01', line: 1, name: 'no-such-file-xyz', claim: 3 }],
    TRACKED, SUITES,
  )
  assert.equal(r[0].kind, 'unresolved')
  const r2 = resolveTargets(
    [{ row: 'F-01', line: 1, name: 'contract.test.mjs', claim: 3 }],
    TRACKED, SUITES,
  )
  assert.equal(r2[0].kind, 'file', '唯一同名文件应能解析')
  // 造一个歧义：两个同名 test 文件
  const amb = resolveTargets(
    [{ row: 'F-01', line: 1, name: 'dup.test.mjs', claim: 3 }],
    ['a/dup.test.mjs', 'b/dup.test.mjs'], new Map(),
  )
  assert.equal(amb[0].kind, 'ambiguous', '同名多文件必须记 ambiguous（不猜）')
})

test('⑧ ★ 假声明不许被提取：`\\`peakResource\\`，判据 47 例` 不是一条计数声明', () => {
  // 提取器原用 `[^。\n]{0,20}?`，于是把字段名后的"另一套判据的例数"也当成声明。
  const doc = docWith([
    '| F-15 | 甲 | 🟡 | `x.mjs` | （`run-record.mjs` 现在带 `peakResource`，判据 47 例、变异 6/6） | — |',
  ])
  const claims = parseCountClaims(doc)
  assert.deepEqual(claims, [], `提取器把字段名当成了套件名：${JSON.stringify(claims)}`)
  // 而真正的写法必须认
  const ok = parseCountClaims(docWith(['| F-01 | 甲 | ✅ | `x.mjs` | 套件 `a`（5 例） | — |']))
  assert.equal(ok.length, 1)
  assert.equal(ok[0].claim, 5)
})

test('⑨ 从 `run-ci.mjs` 读套件→文件：套件名后面**不带**括号时也要认', () => {
  const ci = [
    "  { label: 'plain-suite', files: ['a/plain-suite.test.mjs'], cwd: ROOT },",
    "  { label: 'with-paren（说明）', files: ['b/x.test.mjs', 'b/y.test.mjs'], cwd: ROOT },",
  ].join('\n')
  const m = suiteFilesFromCi(ci)
  assert.deepEqual(m.get('plain-suite'), ['a/plain-suite.test.mjs'])
  assert.deepEqual(m.get('with-paren'), ['b/x.test.mjs', 'b/y.test.mjs'])
})
