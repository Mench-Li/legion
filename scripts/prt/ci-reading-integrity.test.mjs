// scripts/prt/ci-reading-integrity.test.mjs
// ============================================================================
// 判据自己的判据：报告没说"跑在哪棵树上"时必须红，
// 而**说了**的时候不许红（否则会红在一个完全正确的报告上）。
//
// 两层分开测：
//   · 文档层 —— 纯文本注入，秒级，**能进 CI**；
//   · 产物层 —— 用临时目录造 summary.json，**只在本机**（`.ci/` 不进版本库）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkDocDisclosure, checkArtifacts, parseCiCitations, readSummaryTree,
  HANDOVER_DOC, REPO,
} from './ci-reading-integrity.mjs'
import { resolve } from 'node:path'

const row = (extra, dir = 'r28') => '| 全量 CI（**交付 HEAD**） | **9/9 PASS，exit 0**'
  + `（HEAD \`dd6eb8f\`，\`.ci/${dir}\`${extra}） | \`test\` 873171ms |`

const docWith = (...rows) => [
  '| 项 | 值 | 备注 |',
  '| --- | --- | --- |',
  '| 套件清单完备 | 361 个 | `stageTest` |',
  ...rows,
  '',
].join('\n')

test('① 真实报告：那一行必须写出树的状态（★★ 本轮就是靠这条红的）', () => {
  const text = readFileSync(resolve(REPO, HANDOVER_DOC), 'utf8')
  const r = checkDocDisclosure({ text })
  assert.equal(r.ok, true,
    '真报告里「交付 HEAD」那一行没说树的状态：' + JSON.stringify(r.violations, null, 1))
  assert.equal(r.headRows, 1, `应恰好 1 行「交付 HEAD」读数，实际 ${r.headRows}`)
})

test('② ★ 正向控制：说了 sha 但没说树 ⇒ 必须红', () => {
  const r = checkDocDisclosure({ text: docWith(row('')) })
  assert.equal(r.ok, false, '只写了 HEAD sha 却没写树，没红 ⇒ 判据没在查')
  assert.equal(r.violations[0].id, 'ci-head-row-tree-undisclosed')
  assert.match(r.violations[0].message, /git head/)
})

test('②b ★★ 反向控制：写了 `干净树` **或** `脏树 N 改 + M 未跟踪` ⇒ 都不许红', () => {
  for (const tok of ['，干净树', '，脏树 13 改 + 441 未跟踪']) {
    const r = checkDocDisclosure({ text: docWith(row(tok)) })
    assert.deepEqual(r.violations, [],
      `写了 ${JSON.stringify(tok)} 却红了 ⇒ 判据钉的是某一种写法而不是"说清楚树"`)
    assert.equal(r.headRows, 1)
  }
})

test('③ ★★ 自由文本不算"说清楚了" —— 封闭词表是刻意的', () => {
  // 这些都是**看起来**提了树、其实没有可核对的形状
  for (const vague of ['，已确认工作树', '，工作树状态已知', '，dirty', '，tree ok']) {
    const r = checkDocDisclosure({ text: docWith(row(vague)) })
    assert.equal(r.ok, false,
      `${JSON.stringify(vague)} 被当成了"说了树" ⇒ 词表不封闭，判据可以被糊过去`)
  }
})

test('④b ★★★ 回归：**提到「交付 HEAD」这个标签的散文行**不算读数行', () => {
  // ★ 这一条是第一版**当场红在正确地方**的那个假阳性。
  //   第十四节自己那张对照表里有一行：
  //     | 文档层 | 「交付 HEAD」那一行必须用**封闭词表**写树 | **能**（纯文本） |
  //   ——那是在**说这条规则**，不是在**报告一次读数**。
  //   这是第 26 轮 `ANCHOR_AMBIGUOUS` 坑的新形态：
  //   *一段解释"这个标签为什么要被检查"的文字，自己变成了第二个匹配。*
  const prose = docWith(
    '| 层 | 查什么 | 能不能进 CI |',
    '| --- | --- | --- |',
    '| 文档层 | 「交付 HEAD」那一行必须用**封闭词表**写树 | **能**（纯文本） |',
    row('，脏树 13 改 + 441 未跟踪'),
  )
  const r = checkDocDisclosure({ text: prose })
  assert.equal(r.headRows, 1,
    `把"提到标签的散文行"也算成了读数行（headRows=${r.headRows}）⇒ 判据会红在正确的地方`)
  assert.deepEqual(r.violations, [], '散文行不该产生违规：' + JSON.stringify(r.violations))

  // 而**真的**读数行仍然必须被抓住（不给漏洞）
  const real = checkDocDisclosure({ text: docWith(row('')) })
  assert.equal(real.ok, false, '真读数行没写树却没红 ⇒ 谓词放宽过头了')
})

test('④c 谓词：`PASS` 是读数行的必要特征（没写 `.ci/` 引用的读数行仍要查）', () => {
  // 一条**不引 `.ci/`** 的读数行也必须被查，否则那是漏洞
  const noCitation = docWith('| 全量 CI（**交付 HEAD**） | **9/9 PASS，exit 0**（HEAD `abc1234`） | `test` 900s |')
  const r = checkDocDisclosure({ text: noCitation })
  assert.equal(r.ok, false, '不引 `.ci/` 的读数行逃过了 ⇒ 谓词有漏洞')
  assert.equal(r.headRows, 1)
})

test('④ ★ 控制：只约束「交付 HEAD」那一行，历史轮次的行不受约束', () => {  const text = docWith(
    '| 全量 CI（第 26 轮收口） | 9/9 PASS（HEAD `4ccdf86`，`.ci/r26b`） | `test` 937905ms |',
    row('，脏树 13 改 + 441 未跟踪'),
  )
  const r = checkDocDisclosure({ text })
  assert.deepEqual(r.violations, [],
    '历史轮次那一行没有树说明却被要求 ⇒ 会红在正确的地方（那些是当年的快照）')
  assert.equal(r.headRows, 1, '只应认「交付 HEAD」那一行')
})

test('⑤ ★★ 控制：一行「交付 HEAD」都没有 ⇒ 不许报绿（扫到 0 行也是失败）', () => {
  const r = checkDocDisclosure({ text: '| 项 | 值 | 备注 |\n| --- | --- | --- |\n| 套件总数 | 361 | x |\n' })
  assert.equal(r.ok, false, '报告里没有「交付 HEAD」行却报绿 ⇒ "什么都没查"被当成了"全对"')
  assert.equal(r.violations[0].id, 'ci-head-row-missing')
  assert.equal(r.headRows, 0)
})

test('⑥ 解析：`.ci/<dir>` 引用去重且保序', () => {
  const t = '见 `.ci/r28`、`.ci/r27b`，还有 `.ci/r28` 重复一次'
  assert.deepEqual(parseCiCitations(t), ['r28', 'r27b'])
})

test('⑦ ★★ 产物层：报告说"干净树"而产物说脏 ⇒ 张冠李戴，必须红', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-read-'))
  try {
    mkdirSync(join(dir, '.ci', 'r28'), { recursive: true })
    writeFileSync(join(dir, '.ci', 'r28', 'summary.json'), JSON.stringify({
      failed: 0, tree: { known: true, head: 'dd6eb8f', dirty: true, modifiedCount: 13, untrackedCount: 441 },
    }), 'utf8')
    const text = docWith(row('，干净树'))
    const r = checkArtifacts({ cwd: dir, text })
    assert.equal(r.ok, false, '产物说脏、报告说干净，没红 ⇒ 没有交叉核对')
    assert.ok(r.violations.some((v) => v.id === 'ci-reading-clean-but-dirty'),
      '红的不是"张冠李戴"：' + JSON.stringify(r.violations))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑦b ★★ 对称控制：报告说"脏树 13 改 + 441 未跟踪"而产物也脏 ⇒ 不许红', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-read-'))
  try {
    mkdirSync(join(dir, '.ci', 'r28'), { recursive: true })
    writeFileSync(join(dir, '.ci', 'r28', 'summary.json'), JSON.stringify({
      tree: { known: true, head: 'dd6eb8f', dirty: true, modifiedCount: 13, untrackedCount: 441 },
    }), 'utf8')
    const r = checkArtifacts({ cwd: dir, text: docWith(row('，脏树 13 改 + 441 未跟踪')) })
    assert.deepEqual(r.violations, [],
      '如实披露了脏树却红了 ⇒ 这条判据在惩罚诚实记账')
    assert.equal(r.dirty, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑧ ★ 产物层：老 summary 没有 `tree` 字段 ⇒ 报"没记"，**不许当成干净**', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-read-'))
  try {
    mkdirSync(join(dir, '.ci', 'old'), { recursive: true })
    writeFileSync(join(dir, '.ci', 'old', 'summary.json'),
      JSON.stringify({ failed: 0 }), 'utf8')  // ← 第 28 轮之前的形状
    const r = checkArtifacts({ cwd: dir, text: docWith(row('，脏树 13 改 + 441 未跟踪', 'old')) })
    assert.equal(r.unknown, 1, '缺 `tree` 字段没被算成"没记"')
    assert.ok(r.violations.some((v) => v.id === 'ci-reading-tree-unknown'))
    // 而它**不能**被当成干净
    assert.equal(r.clean, 0, '缺字段被当成了"干净" ⇒ 这正是这条判据要防的事')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑧b ★★★ 控制：**历史**产物没记树 ⇒ 报数但**不判红**（否则红在 6 个改不动的地方）', () => {
  // 第一版要求"引用的**每一份** summary 都要记树"，于是它报了 6 条红——
  // 全是第 22～27 轮的老产物，**当年根本没记，今天补不上**。
  // 一条会红在改不动的地方的规则，下场就是被整体关掉。
  const dir = mkdtempSync(join(tmpdir(), 'ci-read-'))
  try {
    // 当前那份：记了树（脏）
    mkdirSync(join(dir, '.ci', 'r28'), { recursive: true })
    writeFileSync(join(dir, '.ci', 'r28', 'summary.json'), JSON.stringify({
      tree: { known: true, head: 'x', dirty: true, modifiedCount: 26, untrackedCount: 432 },
    }), 'utf8')
    // 两份历史：没记树
    for (const old of ['r22a', 'r23b']) {
      mkdirSync(join(dir, '.ci', old), { recursive: true })
      writeFileSync(join(dir, '.ci', old, 'summary.json'), JSON.stringify({ failed: 0 }), 'utf8')
    }
    const text = [
      '| 项 | 读数 | 出处 |', '| --- | --- | --- |',
      row('，脏树 26 改 + 432 未跟踪', 'r28'),
      `| 全量 CI（第 22 轮） | 9/9 PASS（HEAD \`466239d\`，\`.ci/r22a\`） | x |`,
      `| 全量 CI（第 23 轮） | 9/9 PASS（HEAD \`3624e96\`，\`.ci/r23b\`） | x |`,
      '',
    ].join('\n')
    const r = checkArtifacts({ cwd: dir, text })
    assert.deepEqual(r.violations, [],
      '历史产物没记树却判红了 ⇒ 会红在 2 个改不动的地方：' + JSON.stringify(r.violations))
    assert.equal(r.historical, 2, `历史引用应报 2 份，实际 ${r.historical}`)
    assert.equal(r.historicalUnrecorded, 2)
    assert.equal(r.dirty, 1, '当前那份是脏的，要数出来')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑧c ★★ 但**当前**那条没记树 ⇒ 必须红（历史豁免不许变成漏洞）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-read-'))
  try {
    mkdirSync(join(dir, '.ci', 'r28'), { recursive: true })
    writeFileSync(join(dir, '.ci', 'r28', 'summary.json'), JSON.stringify({ failed: 0 }), 'utf8')
    const r = checkArtifacts({ cwd: dir, text: docWith(row('，脏树 26 改 + 432 未跟踪', 'r28')) })
    assert.equal(r.ok, false, '当前那条没记树却没红 ⇒ 豁免过头了')
    assert.ok(r.violations.some((v) => v.id === 'ci-reading-tree-unknown'),
      '红的不是"当前没记树"：' + JSON.stringify(r.violations))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑨ ★ 产物层：引用指不到产物 ⇒ 红（一句无法复核的话）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-read-'))
  try {
    const r = checkArtifacts({ cwd: dir, text: docWith(row('，脏树 13 改 + 441 未跟踪')) })
    assert.equal(r.available, false, '空目录里怎么会有产物')
    assert.ok(r.violations.some((v) => v.id === 'ci-reading-artifact-missing'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑩ 读不出来要说"读不出来"，不许静默返回干净', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-read-'))
  try {
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{ 这不是 JSON', 'utf8')
    const r = readSummaryTree(bad)
    assert.equal(r.known, false)
    assert.match(r.reason, /解析失败/)
    const missing = readSummaryTree(join(dir, 'nope.json'))
    assert.equal(missing.known, false)
    assert.match(missing.reason, /不存在/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
