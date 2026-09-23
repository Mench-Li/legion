// scripts/prt/ledger-evidence.test.mjs
// 台账每一条 ✅ 的"可复跑证据"必须解得开（第 35 轮）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'

import {
  NAME_RE,
  extractMentions,
  checkEvidence,
  checkRepo,
  ledgerEvidenceRows,
} from './ledger-evidence.mjs'

/**
 * 把一段文字写成临时台账，返回它的路径。
 *
 * ★ 本套件其余用例读的都是**真台账**；这一条要的是一份**毒药输入**
 *   （一个今天不存在的状态标记），所以必须能喂自己的文件。
 */
function writeLedger(text) {
  const p = joinPath(mkdtempSync(joinPath(tmpdir(), 'ledger-ev-')), 'ledger.md')
  writeFileSync(p, text)
  return p
}

test('① ★★ 正对照：真仓库里每一条 ✅ 的证据都解得开', () => {
  const res = checkRepo()
  assert.equal(res.ok, true, '真仓库有解不开的证据：' + JSON.stringify(res.violations, null, 1))
  // 它必须**真的查了东西**，而不是在空集上通过
  const r = res.reading
  assert.ok(r.suiteMentions >= 80, `套件点名只读到 ${r.suiteMentions} 处——解析器坏了？`)
  assert.ok(r.pathMentions >= 25, `带目录的用例只读到 ${r.pathMentions} 处`)
  assert.ok(r.bareMentions >= 30, `裸名只读到 ${r.bareMentions} 处`)
})

test('② ★★★ 正向控制：点名一个不存在的套件 ⇒ 必须红（"这份证据不可复跑"）', () => {
  const rows = [{ prt: 'PRT-999', status: '✅', line: 1, evidence: '新增 `x.mjs`，套件 `no-such-suite`（12 例）' }]
  const res = checkEvidence({ rows, suiteFiles: new Map([['real-suite', ['a.test.mjs']]]), tracked: ['a.test.mjs'] })
  assert.equal(res.ok, false, '套件不存在却报绿 ⇒ 证据可以点名空气')
  assert.equal(res.violations[0].id, 'suite-not-a-ci-row')
})

test('③ ★★★ 正向控制：点名一个不存在的用例路径 ⇒ 必须红', () => {
  const rows = [{ prt: 'PRT-999', status: '✅', line: 1, evidence: '见 `product/nope/x.test.mjs`' }]
  const res = checkEvidence({ rows, suiteFiles: new Map(), tracked: ['product/really/y.test.mjs'] })
  assert.equal(res.ok, false)
  assert.equal(res.violations[0].id, 'test-path-missing')
})

test('④ ★★★ 裸名歧义：全仓有 3 个同名 ⇒ 必须红（这正是第 35 轮抓到的 3 处）', () => {
  const rows = [{ prt: 'PRT-999', status: '✅', line: 1, evidence: '本批 `config.test.mjs` 37 → 42 例' }]
  const tracked = ['plugins/tests/config.test.mjs', 'product/config.test.mjs', 'scripts/config/config.test.mjs']
  const res = checkEvidence({ rows, suiteFiles: new Map(), tracked })
  assert.equal(res.ok, false, '3 个同名却报绿 ⇒ 读者找不开也能通过')
  assert.equal(res.violations[0].id, 'bare-test-ambiguous')
  assert.match(res.violations[0].message, /3/)
})

test('⑤ ★★ 反向控制：裸名**唯一**时不许红（"简写合法"的条件就是唯一）', () => {
  const rows = [{ prt: 'PRT-999', status: '✅', line: 1, evidence: '见 `supervisor.test.mjs`' }]
  const res = checkEvidence({
    rows,
    suiteFiles: new Map(),
    tracked: ['product/launcher/supervisor.test.mjs'],
  })
  assert.deepEqual(res.violations, [], '唯一同名被判红：' + JSON.stringify(res.violations))
})

test('⑥ ★★ 裸名一个都没有时也不许红（那是"文件不存在"，不是"歧义"）', () => {
  const rows = [{ prt: 'PRT-999', status: '✅', line: 1, evidence: '见 `ghost.test.mjs`' }]
  const res = checkEvidence({ rows, suiteFiles: new Map(), tracked: ['a/b.test.mjs'] })
  assert.equal(res.ok, false)
  assert.equal(res.violations[0].id, 'bare-test-missing', '把"不存在"报成了"歧义"')
})

test('⑦ ★★ 只判 ✅ 行：🟡/⏸/⬜ 的证据栏不受这条判据约束', () => {
  const rows = [
    { prt: 'PRT-901', status: '⏸', line: 1, evidence: '套件 `no-such-suite` 待外部环境' },
    { prt: 'PRT-902', status: '✅', line: 2, evidence: '套件 `real-suite`' },
  ]
  const res = checkEvidence({ rows, suiteFiles: new Map([['real-suite', ['a.test.mjs']]]), tracked: ['a.test.mjs'] })
  assert.deepEqual(res.violations, [], '非 ✅ 行被判红：' + JSON.stringify(res.violations))
})

test('⑧ ★ 运行器摘要那句话不是套件名（自然中文里的一句话）', () => {
  // 真例：PRT-509 那句「同套件 `<运行器摘要>`」。
  // ★★ 而这条用例的**名字**里曾经真的写了那句话的字面量——node 会把用例名
  //    打进 stdout，于是 CI 的摘要解析器（当时取的是**第一个**匹配）把这一行
  //    读成了那句字面量里的数字，而它真实是 10/10/0。
  //    **一个用例的名字改写了一次 CI 的读数。** 故这里只留一句话，不留字面量；
  //    夹具放在**函数体**里（成功时不会被打进输出）。
  const fixture = '同套件 `' + ['tests', '21', '/', 'pass', '20', '/', 'skipped', '1'].join(' ') + '`。**故…**'
  const m = extractMentions(fixture)
  assert.deepEqual(m.suites, [], `把运行器摘要当成了套件名：${JSON.stringify(m.suites)}`)
  assert.equal(m.proseSpans.length, 1)
  // 而正常的套件名要被认出来
  assert.deepEqual(extractMentions('套件 `product-secrets`（23 例）').suites, ['product-secrets'])
  // ★ 名字形状：字母开头、只含 [\w./-]
  assert.equal(NAME_RE.test('product-secrets'), true)
  assert.equal(NAME_RE.test('tests 21 / pass 20'), false)
})

test('⑨ ★★ 没有点名任何套件的 ✅ 行只作**读数**，不判红', () => {
  const rows = [{ prt: 'PRT-999', status: '✅', line: 1, evidence: '实测：`run_attempts` 有 UNIQUE 约束，无法改历史' }]
  const res = checkEvidence({ rows, suiteFiles: new Map(), tracked: [] })
  assert.deepEqual(res.violations, [], '把"实测证据"判红了——口径允许它')
  assert.deepEqual(res.reading.noPointer, ['PRT-999'])
})

test('⑩ ★★ 台账解析：145 行、状态口径与"第一格以 PRT- 开头"都还在', () => {
  const rows = ledgerEvidenceRows()
  assert.equal(rows.length, 145, `台账读到 ${rows.length} 行（期望 145）`)
  const by = {}
  for (const r of rows) by[r.status] = (by[r.status] ?? 0) + 1
  // ★★★ 第 44 轮：这里曾经断言 `{ '✅': 140, '⏸': 4, '⬜': 1 }`。
  //   `PRT-316` 由 ⬜ 转 **🟡**（切片 1 落地）之后，`ledger-evidence.mjs:76` 的
  //   口径**已经**跟着改成 `^(✅|🟡|⏸|⬜)$`，而**这一行期望没跟着改** ⇒ 判红。
  //
  //   > 一个"口径改了、期望没改"的陈旧断言，与"台账真的变了"，
  //   > 在 CI 上都是**同一条红**——
  //   > 只不过前者要改的是这一行，后者要查的是台账。
  //
  //   ★ 与同一批 `boundary-facts` 的 `tallyLedger` 是**同一个形状**：
  //   那边是**代码**认不出 🟡（连期望也一起写错，所以门禁替它背书）；
  //   这边是**代码**认得出、**期望**认不出。两处都因为 🟡 而在同一轮露出来。
  //
  //   ⇒ 期望改成真实分布，并把"四档之和 == 行数"写成一条**显式**判据：
  //   这样任何"某一档被漏数"都会红，而"某一档的数值合法地变了"只需改这一行。
  //
  // ★★★ 2026-09-21 第 113 轮：**同一件事又发生了一次**，而这一次可以点名是谁。
  //
  //   读数：`{ '✅': 141, '⏸': 4 }` —— 比上面那行期望多 1 个 ✅、少 1 个 🟡。
  //   来源是 `2967119`（2026-09-21 **08:43:35**）"PRT-316 收口：业主裁定那对 SSE
  //   不提取（读法乙）—— 本项 🟡 → ✅"：它改了**台账**，而**没有**改这一行
  //   （`git show 2967119 --stat` 里没有本文件）。
  //
  //   ⇒ 所以这一条红**不是**本批造成的，是"台账动了、期望没动"的**第二次**。
  //     而它之所以值得再记一次：上面那段注释已经把这个形状写得很清楚了，
  //     **写清楚并不能防止它再发生**——它只在"有人跑到了这一条"时才起作用，
  //     而收口 PRT-316 的那一轮显然没有跑到它。
  //
  //   > 一条"把教训写进注释"的判据，与一条"把教训写进**会红的读数**"的判据，
  //   > 在下一次有人只改台账的时候是同一个东西——
  //   > 只不过前者的红要等到**别人**跑 CI 时才出现。
  assert.deepEqual(by, { '✅': 141, '⏸': 4 }, JSON.stringify(by))
  const sum = Object.values(by).reduce((a, b) => a + b, 0)
  assert.equal(sum, rows.length,
    `四档之和 ${sum} 与台账行数 ${rows.length} 不符——有一档被漏数了`)
  // 证据栏必须非空——空证据栏的 ✅ 是"自称完成"
  for (const r of rows) {
    assert.ok(r.evidence.length > 0, `${r.prt} 的证据栏是空的`)
  }
})

test('⑪ ★★★ 认不出的状态格必须**抛**，不许把那一行安静地丢掉', () => {
  // ★★ 第 45 轮实测（`scripts/probes/_probe-status-poison.mjs`）：本模块原来自己写了一份
  //   `^(✅|🟡|⏸|⬜)$`，认不出就 `continue` ⇒ 往合成台账里放一个第 5 个标记（🔵），
  //   它安静地从 4 行变成 3 行，**一声不响**。
  //
  //   > 一个"认不出的标记就跳过"的解析器，在今天**不会**被任何真实输入触发，
  //   > 所以它与一个正确的解析器读数**完全一样**；
  //   > 而"要不要加第 5 个状态"这件事一旦发生，它会安静地少算——而不是报错。
  //
  //   ⇒ 现在取法收敛到 `progress-check.ledgerTaskRow()`（词表的唯一所有者），
  //     认不出来就抛。这条用例把那个行为钉住。
  const head = [
    '# PRT 任务进度表',
    '',
    '| 任务 | 状态 | 证据 |',
    '| --- | --- | --- |',
  ]
  const rowsOf = (mark) => [...head, `| PRT-001 甲 | ${mark} | \`a.md\` |`].join('\n')

  // ★ 正对照：**四个**已知标记都要收下（且证据栏就是第 3 格）。
  for (const mark of ['✅', '🟡', '⏸', '⬜']) {
    const r = ledgerEvidenceRows(writeLedger(rowsOf(mark)))
    assert.equal(r.length, 1, `${mark} 那一行没被收下`)
    assert.equal(r[0].status, mark)
    assert.equal(r[0].evidence, '`a.md`')
    assert.equal(r[0].prt, 'PRT-001')
  }

  // ★ 核心：第 5 个标记（今天不存在）⇒ **抛**，不是"少一行"。
  assert.throws(() => ledgerEvidenceRows(writeLedger(rowsOf('🔵'))),
    /状态格不是已知标记/,
    '认不出的状态被跳过了 ⇒ 那一行会安静地从每个读数里消失')
})
