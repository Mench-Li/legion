// scripts/prt/doc-table-integrity.test.mjs
// ============================================================================
// 判据：文档表格的**列数一致性**（PRT-610 续 / 第 22 轮）。
//
//   · ① 检查器**能被真的触发**（负向对照）：制造那个真缺陷，它必须红
//   · ② ★ 假阳性护栏：`\|`（字面竖线）**不许**被判成列分隔符
//   · ③ ★★★ 权威文档必须 **0 处**——那份表承载裁决，错位 = 把"后果"读成"决定"
//   · ④ ★ 清单里的文件必须**真的被 git 跟踪**（改名/未跟踪 ⇒ 红，而不是静默跳过）
//   · ⑤ ★★ 全仓棘轮：已跟踪 md 的处数**不许超过**基线（过期只报警，不判红）
//
// ★ ② 不是"顺手多写一条"：第 22 轮第一版检查器**没有**处理 `\|`，
//   于是全仓报出 934 处——而其中 847 处是**假红**。一个"到处都是假红"的检查，
//   与一个"找不出真的那一处"的检查，在"它能不能挡住回归"上是同一个东西。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AUTHORITATIVE_DOCS,
  DOC_TABLE_INTEGRITY_CHECKED,
  REPO_WIDE_BASELINE,
  auditFiles,
  findTableDefects,
  groupByFile,
  isSeparatorRow,
  splitRow,
  trackedMarkdownFiles,
} from './doc-table-integrity.mjs'

// ★ 不用 `new URL(...).pathname`：在 Windows 上它给出 `/D:/...`，
//   于是 `existsSync` 永远 false ⇒ ③ 变成一次**空洞的绿**（"所有文件都读不到"）。
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const THREE_COL_DEFECT = [
  '| a | b | c |',
  '|---|---|---|',
  '| 1 | 2 |',
  '| 1 | 2 | 3 |',
].join('\n')

// ══════════════════════════════════════════════════════════════════════════
// ① 检查器能被真的触发
// ══════════════════════════════════════════════════════════════════════════

test('① ★★★ 负向对照：代码跨度里的未转义竖线必须被抓住（第 23 条那个真缺陷）', () => {
  // 这就是 2026-09-18 在决策表第 23 条上真的发生的事，逐字复现：
  const DEFECTIVE = [
    '| # | 事项 | 需要谁 | 具体决定 | 不决定的后果 |',
    '|---|---|---|---|---|',
    '| 23 | 命名空间认不出来 | 产品 | 值域是 `string|null`，装不下"拒" | 未登记的服务器把工具放过去 |',
  ].join('\n')
  const found = findTableDefects(DEFECTIVE)
  assert.equal(found.length, 1, '必须抓住一处')
  assert.equal(found[0].line, 3)
  assert.equal(found[0].got, 6, '那一行被切成 6 格（表头 5 格）')
  assert.equal(found[0].want, 5)
  assert.equal(found[0].kind, 'row')

  // 修好之后必须干净（用**换记号**的写法，不是转义——代码跨度里反斜杠不转义）
  const FIXED = DEFECTIVE.replace('`string|null`', '`string` 或 `null`')
  assert.deepEqual(findTableDefects(FIXED), [], '换掉竖线之后必须 0 处')

  // 另外两种真缺陷形状
  assert.equal(findTableDefects(THREE_COL_DEFECT).length, 1, '少一格要抓')
  assert.equal(
    findTableDefects('| a | b |\n|---|---|---|\n| 1 | 2 |').length, 1,
    '**分隔行**与表头不一致也要抓（那种表整张都会错位）',
  )
})

test('①b 干净的表格不许被判红（含多张表、跨表边界、3/4/5 列混排）', () => {
  const CLEAN = [
    '| a | b | c |',
    '|---|---|---|',
    '| 1 | 2 | 3 |',
    '',
    '普通段落。',
    '',
    '| x | y |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '| p | q | r | s |',
    '|---|---|---|---|',
    '| 1 | 2 | 3 | 4 |',
    '| 5 | 6 | 7 | 8 |',
  ].join('\n')
  assert.deepEqual(findTableDefects(CLEAN), [], '三张不同的表、各自列数都对 ⇒ 0 处')
})

// ══════════════════════════════════════════════════════════════════════════
// ② ★ 假阳性护栏
// ══════════════════════════════════════════════════════════════════════════

test('② ★★★ `\\|`（字面竖线）不许被当成列分隔符——否则这个检查就是一片假红', () => {
  assert.deepEqual(splitRow('| a \\| b | c |'), [' a \\| b ', ' c '], '转义竖线留在同一格')
  const WITH_ESCAPES = [
    '| 写法 | 结果 |',
    '| --- | --- |',
    "| `'allow' \\| 'deny'` | 闭集 |",
    '| `a \\| b \\| c` | 同上 |',
  ].join('\n')
  assert.deepEqual(findTableDefects(WITH_ESCAPES), [],
    '带 `\\|` 的行必须算 2 格——不处理它，这个检查器会在全仓报出几百处假红')

  // ★ 反向：**真的**未转义竖线与之只差一个反斜杠，两者必须被分开
  const UNESCAPED = WITH_ESCAPES.replace('\\|', '|')
  assert.equal(findTableDefects(UNESCAPED).length, 1, '拿掉那个反斜杠就必须红')
})

// ══════════════════════════════════════════════════════════════════════════
// ③ ★★★ 权威文档必须 0 处
// ══════════════════════════════════════════════════════════════════════════

test('③ ★★★ 八份**权威文档**的表格列数全部一致（0 处）', () => {
  const { defects, total } = auditFiles({ cwd: ROOT, files: AUTHORITATIVE_DOCS })
  if (total > 0) {
    const listing = defects
      .map((d) => `      ${d.file}:${d.line}  ${d.got} 格（表头 ${d.want} 格，${d.kind}）`)
      .join('\n')
    assert.fail(
      `权威文档里有 ${total} 处表格列数不一致：\n${listing}\n` +
      '      ★ 修法**不是**把竖线转义（CommonMark 的代码跨度里反斜杠不转义），\n' +
      '        要换记号：`或` / `｜`（全角）/ `{a,b}`。',
    )
  }
  assert.equal(total, 0)
})

test('③b 这八份是**真的**被读到了内容（不是"路径不对所以 0 处"）', () => {
  // ★ 一个"所有文件都打不开、于是 0 处"的检查，与一个"全都干净"的检查，
  //   在读数上是同一个东西——只不过前者永远绿。
  const { defects, files } = auditFiles({ cwd: ROOT, files: AUTHORITATIVE_DOCS })
  assert.equal(files, AUTHORITATIVE_DOCS.length)
  assert.equal(defects.filter((d) => d.kind === 'missing').length, 0,
    '不许有"文件不存在"——那会让 ③ 变成一次空洞的绿')
  for (const rel of AUTHORITATIVE_DOCS) {
    assert.ok(existsSync(join(ROOT, rel)), `${rel} 必须存在`)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// ④ 清单本身要可核对
// ══════════════════════════════════════════════════════════════════════════

test('④ ★ 权威文档清单：路径唯一、非空、且都被 git 跟踪', () => {
  assert.ok(AUTHORITATIVE_DOCS.length >= 8)
  assert.equal(new Set(AUTHORITATIVE_DOCS).size, AUTHORITATIVE_DOCS.length, '不许重复')
  for (const rel of AUTHORITATIVE_DOCS) {
    assert.ok(!rel.startsWith('/') && !rel.includes('..'), `${rel} 必须是仓库相对路径`)
  }
  const tracked = new Set(trackedMarkdownFiles({ cwd: ROOT }))
  // ★ 未跟踪的文件在这份清单里是**危险**的：它可能在别人的工作区里，
  //   于是"权威文档 0 处"这句话在 CI 上会因为读不到而变成空洞的绿。
  const untracked = AUTHORITATIVE_DOCS.filter((r) => !tracked.has(r))
  assert.deepEqual(untracked, [], `这些权威文档没有被 git 跟踪：${untracked.join(', ')}`)
})

test('④b ★★★ 文件清单必须能打开**非 ASCII 路径**的文件（git 默认会转义+加引号）', () => {
  // ★ 第 22 轮真发生过：`git ls-files` 默认按 `core.quotePath` 把非 ASCII 路径
  //   转义成 C 风格八进制并**加双引号**，于是 `whiteboard/docs/adr/ADR-0001-同步引擎.md`
  //   回来的是 `"…ADR-0001-\345\220\214…"`，**打不开**。本仓有 8 个这样的文件。
  //   后果不是"少查 8 个"：那 8 个会变成 8 条 `missing`（总数虚高），
  //   而它们自己的真缺陷**一处都数不到**——真正危险的方向藏在"总数偏高"里。
  const files = trackedMarkdownFiles({ cwd: ROOT })
  const nonAscii = files.filter((f) => /[^\x00-\x7F]/.test(f))
  assert.ok(nonAscii.length > 0, '本仓确实有非 ASCII 路径的 md——这条断言才有意义')
  const quoted = files.filter((f) => f.includes('"'))
  assert.deepEqual(quoted, [], '清单里不许出现带引号的路径（那是 git 的转义残留）')
  // 每一个都必须真的打得开
  const unreadable = nonAscii.filter((f) => !existsSync(join(ROOT, f)))
  assert.deepEqual(unreadable, [], `这些非 ASCII 路径打不开：${unreadable.join(', ')}`)

  // 并且它们要被 auditFiles 真的读到内容（不是记一条 missing 了事）
  const { defects } = auditFiles({ cwd: ROOT, files: nonAscii })
  assert.equal(defects.filter((d) => d.kind === 'missing').length, 0,
    '非 ASCII 文件不许被记成 missing')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑤ ★★ 全仓棘轮
// ══════════════════════════════════════════════════════════════════════════

test('⑤ ★★ 全仓已跟踪 md 的表格缺陷**不许超过**基线（新增判红，减少只报警）', () => {
  const files = trackedMarkdownFiles({ cwd: ROOT })
  const { total, defects } = auditFiles({ cwd: ROOT, files })

  if (total > REPO_WIDE_BASELINE) {
    const groups = [...groupByFile(defects).entries()].sort((a, b) => b[1] - a[1])
    const listing = groups.map(([f, n]) => `      ${String(n).padStart(3)}  ${f}`).join('\n')
    assert.fail(
      `表格缺陷从基线 ${REPO_WIDE_BASELINE} 涨到了 ${total}（+${total - REPO_WIDE_BASELINE}）：\n${listing}\n` +
      '      ★ 只许减少。修好之后**把基线改小**（`REPO_WIDE_BASELINE`）。\n' +
      '      ★ 排除法提示：`\\|` 是字面竖线、不算分隔符；真缺陷是**未转义**的那些。',
    )
  }

  // ★ 基线过期（好消息）**不判红**，只报警——与可达性探针同一条纪律：
  //   在共享工作树上，一个"把别人修好的事判成回归"的闸门会天天红。
  if (total < REPO_WIDE_BASELINE) {
    console.log(
      `  ⚠ 基线过期：实测 ${total} 处 < 基线 ${REPO_WIDE_BASELINE} 处——`
      + '好消息，请把 `REPO_WIDE_BASELINE` 降到实测值把它锁住（本检查**不**因此判红）',
    )
  }
  assert.ok(total <= REPO_WIDE_BASELINE)
  assert.ok(files.length > 100, `已跟踪 md 只有 ${files.length} 个——清单读取可能坏了`)
})

test('⑤b 检查器自身是纯函数（同一输入两次结果相同），且不自带状态', () => {
  const text = '| a | b |\n|---|---|\n| 1 | 2 | 3 |\n'
  const once = findTableDefects(text)
  const twice = findTableDefects(text)
  assert.deepEqual(once, twice)
  assert.equal(once.length, 1)
  // 分隔行判定的边界
  assert.equal(isSeparatorRow(['---', ':--:', '---']), true)
  assert.equal(isSeparatorRow(['---', '', '---']), false)
  assert.equal(isSeparatorRow([]), false)
  // 纯函数：不因为"调用过"而改变后续结果
  assert.equal(findTableDefects(text).length, 1)
})

test('⑤c 装载时读数存在（供门禁读）', () => {
  assert.equal(DOC_TABLE_INTEGRITY_CHECKED.authoritativeDocs, AUTHORITATIVE_DOCS.length)
  assert.equal(DOC_TABLE_INTEGRITY_CHECKED.repoWideBaseline, REPO_WIDE_BASELINE)
})
