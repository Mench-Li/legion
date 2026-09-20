// scripts/prt/intervention-coverage.test.mjs
// ============================================================================
// 「没有任何人在等它」的门禁：台账里每一条**非 ✅** 的行，都要被 §5 点到名。
//
// ## 为什么这条判据必须存在（本仓实测过两次，同一个形状）
//
//   · 第一次：`runtime-contract-server-row.mjs` 那一族被标着 `in-flight`
//     （正确动作那一格写的是一个字「等」），而真实内容是"接不上、要人裁决"，
//     且**不在** §5 上 ⇒ 立为 §5 第 20 条。
//   · 第二次：`PRT-256` 与 `PRT-910` 两条 ⏸ 的"缺口"那一列逐字写着
//     `需真实外部用户` / `需真实用户项目`，而它们**不在** §5 上
//     ⇒ 立为 §5 第 21 条。
//
// 两次都不是"代码写错了"，而是**两份清单之间没人交叉核对**：
//
//   > 一份"谁也没在看"的待办，与一份"已经做完"的待办，
//   > 在只看其中一份清单时是同一个东西。
//
// ## 三条判据
//
//   ① 正对照：解析器活着（台账认得出 145 行、§5 认得出 ≥21 条），
//      否则下面的检查会在空集上通过。
//   ② 读数：台账里**没有**孤儿（非 ✅ 且不在 §5 上）。
//   ③ 反方向：**✅ 的行不许被当成需要点名的**——判据只管辖非 ✅，
//      否则"已完成"会被拖进人工清单，清单会被稀释到没人读。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ledgerRows, ledgerNotDone, sectionFive, uncoveredLedgerRows, NON_DONE_STATUSES,
  checkBrief, checkBriefCount, decisionItemNumbers, briefStatedCounts,
  boundaryCoverageGaps, ledgerRowTexts, BOUNDARY_CITE, BOUNDARY_LIST_MARKER } from './intervention-coverage.mjs'

const rows = ledgerRows()
const notDone = ledgerNotDone()
const section = sectionFive()

// ══════════════════════════════════════════════════════════════════════════
// ① 正对照：解析器必须活着
// ══════════════════════════════════════════════════════════════════════════

test('① ★★★ 正对照：台账与 §5 都解析得出来（否则下面的检查在空集上通过）', () => {
  // 台账：本仓现在是 145 行（140 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜）。
  // ★ 不写死 145：台账会加行。取一个"明显小于真实值"的下界，
  //   它红的时候说明解析器坏了，而不是说明台账变了。
  // ★ 第 44 轮订正：这里原本写的是「138 ✅ / 4 🟡 / 2 ⏸ / 1 ⬜」——**和真实分布不符**
  //   （四个数加起来正好 145，所以它看起来像一份读数）。
  //   它是注释、不是断言，所以没有任何判据会红——
  //   ⇒ 一个错的**注释**比一个错的断言更耐久：断言会红，注释只会被下一个人当真。
  assert.ok(rows.length >= 100,
    `台账只解析出 ${rows.length} 行 PRT 行（期望 ≥100）。` +
    '解析器坏了时，"没有孤儿"会**恒真**——这条用例正是为了让那不可能')

  // 状态必须落在封闭词表里（否则 `notDone` 的分母是错的）
  for (const r of rows) {
    assert.ok(['✅', ...NON_DONE_STATUSES].includes(r.status),
      `${r.prt} 的状态是 ${JSON.stringify(r.status)}，不在词表里`)
  }

  // ★ 台账里**必须真的存在**非 ✅ 的行。若哪天全 ✅ 了，这条会红——
  //   那时要人来确认"是真的全做完了"还是"状态被批量改绿了"。
  //   这两种在"孤儿数 = 0"上是同一个东西。
  assert.ok(notDone.length > 0,
    '台账里一条非 ✅ 的行都没有。要么真的全做完了（那是大新闻，请有人来看一眼），' +
    '要么是状态被批量改绿了——无论哪种，"没有孤儿"这句检查都失去了意义')

  // §5：正文取到了，而且条号解析得出（第 21 条是本批加的）
  assert.ok(section.length > 2000, `§5 正文只取到 ${section.length} 字符（期望 >2000）`)
  assert.ok(section.includes('PRT-'), '§5 正文里一个 PRT 编号都没有——取区间取错了？')
})

// ══════════════════════════════════════════════════════════════════════════
// ② ★★★ 读数：台账里不许有"没有任何人在等"的行
// ══════════════════════════════════════════════════════════════════════════

test('② ★★★ 每一条非 ✅ 的台账行都必须被 §5 点到名（治"没有任何人在等它"）', () => {
  const orphans = uncoveredLedgerRows(notDone, section)

  assert.deepEqual(orphans.map((r) => r.prt), [],
    `★ 有 ${orphans.length} 条台账行**既不是 ✅、又不在 §5 上**：\n` +
    orphans.map((r) => `    ${r.prt}  ${r.status}  L${r.line}  ${r.desc}`).join('\n') +
    '\n  它们的处境是「**没有任何人在等它**」：读台账的人以为 §5 在管，' +
    '\n  读 §5 的人以为台账已闭环。本仓已经这样漏过两次（§5 第 20 / 21 条）。' +
    '\n' +
    '\n  两条路，选一条：' +
    '\n    ① 它其实是**要人回答的** ⇒ 给 §5 加一条，并在那一格里写它的 PRT 编号；' +
    '\n    ② 它其实是**已完成**的 ⇒ 把台账那一行改成 ✅（并补上证据）。' +
    '\n  不要停在"它自己那一格写着 ⏸/🟡"——那一格不会自己去找人。')
})

// ══════════════════════════════════════════════════════════════════════════
// ③ 反方向：✅ 的行不许被要求点名
// ══════════════════════════════════════════════════════════════════════════

test('③ ★★ ✅ 的行不受本判据管辖（否则人工清单会被稀释到没人读）', () => {
  // 规则函数只拿 `notDone` 当输入。这里用**人造条目**把这条语义钉住：
  // 一个 ✅ 的 PRT 编号即使不在 §5 里，也**不该**被报成孤儿。
  const FIXTURE = [
    { prt: 'PRT-900', status: '✅', line: 1, desc: '已完成' },
    { prt: 'PRT-901', status: '🟡', line: 2, desc: '进行中' },
    { prt: 'PRT-902', status: '⏸', line: 3, desc: '暂停' },
    { prt: 'PRT-903', status: '⬜', line: 4, desc: '未开始' },
  ]
  // 规则只看"传进来的这一批"——所以传入时就不该包含 ✅。
  // ★ 这里同时钉住 `NON_DONE_STATUSES` 的内容：它必须**不含** ✅。
  assert.equal(NON_DONE_STATUSES.includes('✅'), false,
    '`NON_DONE_STATUSES` 里含 ✅ —— 那会把已完成的拖进人工清单')

  const asNotDone = FIXTURE.filter((r) => NON_DONE_STATUSES.includes(r.status))
  assert.deepEqual(asNotDone.map((r) => r.prt), ['PRT-901', 'PRT-902', 'PRT-903'],
    '非 ✅ 的过滤把 ✅ 也留下了，或者漏掉了某一种非 ✅ 状态')

  // 只有当 §5 里一个都没提到时，三条才都是孤儿
  assert.deepEqual(uncoveredLedgerRows(asNotDone, '§5 里什么都没提').map((r) => r.prt),
    ['PRT-901', 'PRT-902', 'PRT-903'])
  // 提到其中一条 ⇒ 只报另外两条（**逐条**分辨，不是"要么全报要么不报"）
  assert.deepEqual(uncoveredLedgerRows(asNotDone, '这里提到了 PRT-902').map((r) => r.prt),
    ['PRT-901', 'PRT-903'],
    '规则不能逐条分辨：它把提到的与没提到的一起放过或一起报，等于没有判据')
  // 三条都被提到 ⇒ 一条都不报
  assert.deepEqual(uncoveredLedgerRows(asNotDone, 'PRT-901 PRT-902 PRT-903'), [])

  // ── 读数：✅ 的那些确实**没有**参与上面的 ② ──────────────────────
  const done = rows.filter((r) => r.status === '✅')
  assert.ok(done.length > 0, '一条 ✅ 的行都没有——台账格式变了？')
  const doneAsOrphans = uncoveredLedgerRows(done, section)
  assert.equal(doneAsOrphans.length > 0, true,
    '把 ✅ 的行也拿去查 §5 时会报出孤儿——本用例的 ③ 正是要说明**不该**这么用')
})

// ══════════════════════════════════════════════════════════════════════════
// ④ 两条路径都存在（判据的输入是文件，不是快照）
// ══════════════════════════════════════════════════════════════════════════

test('④ ★ 台账与 §5 的来源文件都存在，且台账是被跟踪的', () => {
  assert.equal(existsSync('docs/superpowers/prt/PRT-PROGRESS.md'), true,
    '台帐文件不在——`ledgerRows()` 会抛，而不是"报 0 个孤儿"')
  // ★ 这一条防的是"文件缺失被读成干净"：
  //   如果 `ledgerRows()` 哪天改成 catch 后返回 `[]`，② 会变成恒真。
  //   本用例把它钉在这里：文件必须在，且解析必须有内容（① 已断言 ≥100）。
})

// ══════════════════════════════════════════════════════════════════════════
// ⑤–⑨ 第二格：§5 的裁决项条数 ↔ 决策简报里写的那个数（第 32 轮加）
//
// ★ 加它的原因就是它当天抓到的那件事：第 30 轮我往 §5 加第 29 条时，
//   把它插在了一个**空行之后**——于是那一行在 Markdown 里**不属于那张表**
//   （空行结束表格）。行在、编号对、内容对，而**它不是表的一行**。
//   已有的那道闸（②）查的是 `section.includes('PRT-…')`——
//   子串在不在，与"它是不是表的一行"无关，所以它绿灯放行。
//
//   > 一行"插在表格外面"的裁决项，与一行"插在表格里面"的裁决项，
//   > 在读者用 Ctrl-F 找它的编号时，是同一个东西。
// ══════════════════════════════════════════════════════════════════════════

/** 造一段 §5：一张 5 列裁决表。 */
const sectionOf = (nums) => [
  '## 5. 需要裁决的清单',
  '',
  '| # | 事项 | 需要谁 | 具体决定 | 不决定的后果 |',
  '|---|---|---|---|---|',
  ...nums.map((n) => `| ${n} | 事项${n} | 产品 | 决定${n} | 后果${n} |`),
  '',
  '## 5.1 边界',
  '',
].join('\n')

test('⑤ ★★ 正对照：真 §5 与真简报对得上（29 条），且编号连续', () => {
  const r = checkBrief()
  assert.equal(r.ok, true, '真文档红了：' + JSON.stringify(r.violations))
  assert.equal(r.count, 29, `§5 裁决表应 29 条，实际 ${r.count} ⇒ 解析器跑偏或表格被拆开了`)
  assert.deepEqual(r.stated, [29])
})

test('⑥ ★★★ 回归：§5 的第 29 条**必须在那张表里**（不许被空行隔开）', () => {
  // 这正是第 30 轮犯的错：把第 29 条插在一个空行之后 ⇒ 它在表外面。
  // ★ 断言的是"解析器数到 29"，而不是"第 754 行长什么样"——
  //   行号会漂，而"表里有几条"是这个判据真正关心的事。
  const { found, numbers } = decisionItemNumbers(sectionFive())
  assert.equal(found, true, '§5 的裁决表头没找到')
  assert.equal(numbers.length, 29, `表里只有 ${numbers.length} 条 ⇒ 有一条掉到表外面了`)
  assert.equal(numbers.at(-1), 29, `表里最大的编号是 ${numbers.at(-1)}，不是 29`)
})

test('⑦ ★★★ 正向控制：简报写的条数与 §5 不符 ⇒ 必须红', () => {
  const r = checkBriefCount({ section: sectionOf([1, 2, 3]), briefText: '把 §5 里那 **5 条**裁决项读一遍' })
  assert.equal(r.ok, false, '简报写了 5、§5 有 3，却没红 ⇒ 摘要可以和来源脱钩')
  assert.ok(r.violations.some((v) => v.id === 'brief-count-stale'), JSON.stringify(r.violations))
})

test('⑧ ★★ 正向控制：编号有缺号 ⇒ 必须红（读者按号找会找不到）', () => {
  const r = checkBriefCount({ section: sectionOf([1, 2, 4]), briefText: '**3 条**裁决项' })
  assert.ok(r.violations.some((v) => v.id === 'decision-numbers-not-contiguous'),
    '编号 1,2,4 没被报成缺号：' + JSON.stringify(r.violations))
})

test('⑨ ★★ "什么都没查"不许报绿：表头找不到 / 简报一处都没声明', () => {
  const noHeader = checkBriefCount({ section: '## 5. 什么表都没有\n', briefText: '**29 条**裁决项' })
  assert.equal(noHeader.ok, false)
  assert.ok(noHeader.violations.some((v) => v.id === 'decision-table-missing'))

  const noCount = checkBriefCount({ section: sectionOf([1, 2]), briefText: '这份简报没写条数' })
  assert.equal(noCount.ok, false, '简报没声明条数却报绿 ⇒ 判据可以靠沉默通过')
  assert.ok(noCount.violations.some((v) => v.id === 'brief-states-no-count'))
})

test('⑨b ★★ 反向控制：条数一致时**不许**红（含表头/分隔行不被当成条目）', () => {
  const r = checkBriefCount({ section: sectionOf([1, 2, 3]), briefText: '那 3 条裁决项 / 另有 3 条裁决项' })
  assert.deepEqual(r.violations, [], '一致时被判红：' + JSON.stringify(r.violations))
  assert.equal(r.count, 3, '`|---|---|` 分隔行被当成了一条裁决项')
  assert.deepEqual(r.stated, [3, 3], '同一条数写两遍应当都被收进来（它们必须一致）')
})

test('⑨c ★★★ 序数不是计数：「第 20 条裁决项」不许被读成"有 20 条"', () => {
  // ★ 这是第 33 轮**真发生过**的误报：我在简报里加了一句指路的话
  //   （「它正好就是第 20 条裁决项」），判据立刻报「简报写着 20 条、§5 有 29 条」。
  //
  //   > 一个分不清"第 20 条"与"20 条"的计数器，
  //   > 会在**引用**某一条的时候，报出一个**条数**上的错误。
  assert.deepEqual(briefStatedCounts('它正好就是第 20 条裁决项'), [],
    '序数被读成了计数')
  assert.deepEqual(briefStatedCounts('第20条裁决项'), [], '不带空格的序数也被读成了计数')
  assert.deepEqual(briefStatedCounts('§5 里那 29 条裁决项'), [29], '真正的计数没被读出来')
  // 序数与计数在同一段里并存时，只收计数那一个
  assert.deepEqual(briefStatedCounts('第 20 条裁决项 与 §5 里那 29 条裁决项'), [29])
  // ★ `\s*` 会吃换行 ⇒ 隔着空行的序数也必须仍然被排除
  assert.deepEqual(briefStatedCounts('第 20\n\n条裁决项'), [], '跨行的序数没被排除')
  // 而真文档必须仍然对得上（否则这次修正就变成了"把判据关掉"）
  const r = checkBrief()
  assert.equal(r.ok, true, '真文档红了：' + JSON.stringify(r.violations))
  assert.deepEqual(r.stated, [29])
})

// ══════════════════════════════════════════════════════════════════════════
// ⑩ ★ 第三格：§4 第 15 条那份"还对谁成立"的名单 ↔ 台账里引用它的行
//
// 起因与本文件开头那两次**同形**，但这次漏人的是**名单自己**：
// `docs/STATUS.md` §4 第 15 条自带一份名单，2026-09-20 发现它漏了 `PRT-253`，
// 而那一行的"缺口"栏逐字写着"§4 第 15 条……与 PRT-009 是同一条"。
// 漏掉的代价是可量化的：有人照着名单读了一遍，得出"PRT-253 不归它管"，
// 于是去查别的原因——**白查一轮**。
// ══════════════════════════════════════════════════════════════════════════

/** 造一对最小的台账 / 状态文档，用来把"名单漏人"这一种形状钉住。 */
function boundaryFixture({ ledgerRows: rows, list }) {
  const dir = mkdtempSync(join(tmpdir(), 'icov-boundary-'))
  const ledgerPath = join(dir, 'LEDGER.md')
  const statusPath = join(dir, 'STATUS.md')
  writeFileSync(ledgerPath, rows.join('\n') + '\n', 'utf8')
  writeFileSync(statusPath, `15. 边界\n\n⇒ 所以正确的读法是：**${BOUNDARY_LIST_MARKER} ${list} 那半仍然成立**\n`, 'utf8')
  return { ledgerPath, statusPath }
}

/** 一条引用了 §4 第 15 条的台账行（形状与真台账一致）。 */
const citingRow = (prt, status) =>
  `| ${prt} 某个任务 | ${status} | 缺口：卡在 \`docs/STATUS.md\` ${BOUNDARY_CITE}（Windows 上不会有自动执行） |`

test('⑩ ★★★ 真仓库读数：台账里每一条"引用本条边界且非 ✅"的行都被名单点到名', () => {
  const r = boundaryCoverageGaps()
  assert.equal(r.ok, true, '真仓库红了：' + JSON.stringify(r.violations, null, 2))
  // ★ 正对照：两侧都必须**非空**，否则这条判据在空集上通过
  assert.ok(r.cited.length >= 1, '台账里没有一行引用这条边界 ⇒ 判据在空集上通过')
  assert.ok(r.named.length >= 1, `名单里一个编号都没解析出来（锚点 \`${BOUNDARY_LIST_MARKER}\` 还在吗）`)
  for (const p of r.cited) assert.ok(r.named.includes(p), `${p} 引用了本条边界却不在名单里`)
})

test('⑪ ★★★ 破验：名单漏掉一个引用它的非 ✅ 行 ⇒ 必须红（2026-09-20 真发生过的形状）', () => {
  // 复现订正前的名单：只点 PRT-009 与 PRT-257，而 PRT-253 引用了它却没被点到。
  const f = boundaryFixture({
    ledgerRows: [citingRow('PRT-009', '⏸'), citingRow('PRT-253', '⏸')],
    list: 'PRT-009 与 PRT-257',
  })
  const r = boundaryCoverageGaps(f)
  assert.equal(r.ok, false, '名单漏了 PRT-253 却报绿 ⇒ 下一个人还会白查一轮')
  assert.deepEqual(r.cited.sort(), ['PRT-009', 'PRT-253'])
  assert.ok(r.violations.some((v) => v.id === 'boundary-item-unnamed' && v.message.includes('PRT-253')),
    JSON.stringify(r.violations))
})

test('⑫ ★★★ 反向控制：✅ 的行引用了本条边界 ⇒ **不**要求被点名（判据只管辖未完成）', () => {
  // 真仓库里 PRT-214 / PRT-509 / PRT-610 / PRT-611 都引用过这条边界但已是 ✅。
  // 判据若把它们也拖进来，就会逼着名单去点一堆**已经做完**的事——
  // 名单会被稀释到没人读，而那正是它失效的方式。
  const f = boundaryFixture({
    ledgerRows: [citingRow('PRT-009', '⏸'), citingRow('PRT-509', '✅')],
    list: 'PRT-009',
  })
  const r = boundaryCoverageGaps(f)
  assert.deepEqual(r.violations, [], '✅ 的行被要求点名了：' + JSON.stringify(r.violations))
  assert.deepEqual(r.cited, ['PRT-009'], '✅ 的行不该进 cited')
})

test('⑬ ★★ "什么都没查"不许报绿：锚点找不到 / 台账里一条都不引用', () => {
  // ① 锚点找不到（名单被改写或搬走）
  const dir = mkdtempSync(join(tmpdir(), 'icov-nomarker-'))
  const lp = join(dir, 'L.md'); const sp = join(dir, 'S.md')
  writeFileSync(lp, citingRow('PRT-009', '⏸') + '\n', 'utf8')
  writeFileSync(sp, '15. 边界\n\n这句话里没有那个锚点。\n', 'utf8')
  const noMarker = boundaryCoverageGaps({ ledgerPath: lp, statusPath: sp })
  assert.equal(noMarker.ok, false, '锚点找不到却报绿 ⇒ 判据可以靠沉默通过')
  assert.ok(noMarker.violations.some((v) => v.id === 'boundary-list-missing'))

  // ② 左侧空集（没有一行引用它）
  const f2 = boundaryFixture({ ledgerRows: ['| PRT-999 无关任务 | ⏸ | 缺口：等日期 |'], list: 'PRT-009' })
  const empty = boundaryCoverageGaps(f2)
  assert.equal(empty.ok, false, '空集上通过 ⇒ 与没写这条判据长得一样')
  assert.ok(empty.violations.some((v) => v.id === 'boundary-nobody-cites'))
})

test('⑬b ★★ 台账行取法：ledgerRowTexts 与 ledgerRows 认出同一批 PRT 编号', () => {
  // ★ 两个取法各写一遍就会漂移——这正是本模块文件头警告的形状。
  //   这里把"同一批编号"钉住：形状变了就红，而不是让引用检查悄悄少看几行。
  const a = ledgerRowTexts().map((r) => r.prt).sort()
  const b = rows.map((r) => r.prt).sort()
  assert.deepEqual(a, b, 'ledgerRowTexts 与 ledgerRows 认出的编号集合不同')
})

test('⑬c ★★★ 认不出的状态格必须**抛**——两个取法都不许安静丢行', () => {
  // ★★ 第 45 轮实测（`scratch/_probe-status-poison.mjs`）：本模块把同一条状态正则
  //   写了**三**遍（`ledgerRows`、`ledgerRowTexts`，外加 `NON_DONE_STATUSES` 那张
  //   子集表），而它**自己的文件头**就在警告"两处各写一遍取法，正是本模块警告的
  //   那种漂移"。往合成台账里放一个第 5 个标记（🔵），它安静地少一行。
  //
  //   ★ 而 ⑬b 那条"两个取法认出同一批编号"**抓不到它**——两边以**同样的方式**
  //     各丢一行，所以左边 == 右边，判据照样绿。
  //
  //     > 一条"两个实现必须一致"的判据，在两个实现**一起错**的时候是绿的；
  //     > 而"一起错"恰恰是"同一份取法被抄了两遍"最常见的失效方式。
  //
  //   ⇒ 现在两者都走 `progress-check.ledgerTaskRow()`，认不出来就抛。
  const head = [
    '# PRT 任务进度表',
    '',
    '| 任务 | 状态 | 证据 |',
    '| --- | --- | --- |',
  ]
  const write = (mark) => {
    const p = join(mkdtempSync(join(tmpdir(), 'iv-')), 'ledger.md')
    writeFileSync(p, [...head, `| PRT-001 甲 | ${mark} | \`a.md\` |`].join('\n'))
    return p
  }

  // ★ 正对照：四个已知标记都要收下（否则下面那条"抛"可能是"它什么都抛"）。
  for (const mark of ['✅', '🟡', '⏸', '⬜']) {
    assert.equal(ledgerRows(write(mark)).length, 1, `ledgerRows 没收下 ${mark}`)
    assert.equal(ledgerRowTexts(write(mark)).length, 1, `ledgerRowTexts 没收下 ${mark}`)
  }

  // ★ 核心：第 5 个标记 ⇒ 两个取法都必须**抛**，不是"少一行"。
  assert.throws(() => ledgerRows(write('🔵')), /状态格不是已知标记/,
    'ledgerRows 认不出就跳过 ⇒ 那一行安静地消失')
  assert.throws(() => ledgerRowTexts(write('🔵')), /状态格不是已知标记/,
    'ledgerRowTexts 认不出就跳过 ⇒ 引用检查会悄悄少看一行')
})
