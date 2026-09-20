// scripts/prt/feature-landing-paths.test.mjs
// ============================================================================
// 判据自己的判据。三类控制都要有：
//   · 正向：带目录的路径不存在 ⇒ 必须红
//   · 正向：裸名全仓有 2 个同名 ⇒ 必须红（**这是这条判据存在的理由**）
//   · 反向：裸名全仓唯一 ⇒ **不许**红（这一列的简写是合法的）
//   · 反向：沿本格目录继承解得开 ⇒ **不许**红
//   · "什么都没查" ⇒ 不许报绿
// 全部注入文本 + 注入 tracked 清单，秒级；只有 ① 读真仓库。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  checkLandingPaths, checkRepo, parseLandingCells, tokensOf, expandBraces, PATH_RE,
  REPO, STATUS_DOC,
} from './feature-landing-paths.mjs'

/** 造一行功能表行（6 列，落点在第 4 格）。 */
const row = (id, landing) => `| ${id} | 名称 | ✅ | ${landing} | 证据 | — |`

const docOf = (rows) => [
  '| 编号 | 名称 | 状态 | 代码落点 | 判据 / 证据 | 还差什么 |',
  '|---|---|---|---|---|---|',
  ...rows,
  '',
].join('\n')

const check = (statusText, tracked) => checkLandingPaths({ statusText, tracked })

test('① 真仓库：29 行 / 59 个落点，全部让读者找得到', () => {
  const r = checkRepo()
  assert.equal(r.ok, true, '真仓库红了：' + JSON.stringify(r.violations, null, 1))
  assert.equal(r.rows, 29, `功能行应 29 行，实际 ${r.rows} ⇒ 解析器跑偏了`)
  assert.ok(r.scanned > 40, `落点引用只解析出 ${r.scanned} 个，期望 >40`)
  // ★ 三种解法都要各有命中，否则某一支规则从没被真数据走过
  assert.ok(r.exact > 20, `原样解得开的只有 ${r.exact}`)
  assert.ok(r.inherited > 5, `沿本格目录继承的只有 ${r.inherited}`)
  assert.ok(r.viaUniqueName > 5, `靠"全仓唯一同名"的只有 ${r.viaUniqueName}`)
})

test('② ★★ 回归：真仓库里 F-21 那处 `plugins/connector-feedback.mjs` 已改成全路径', () => {
  // 第 28 轮发现的正是这一处：`plugins/` 读起来像**顶层** plugins/，而文件在
  // `runtime/dsh-composition/plugins/`。第 31 轮判据量出来，是**唯一**一处真缺陷。
  const t = readFileSync(resolve(REPO, STATUS_DOC), 'utf8')
  assert.ok(t.includes('runtime/dsh-composition/plugins/connector-feedback.mjs'),
    '全路径没写进功能表 ⇒ 那条修复被回退了')
  assert.equal(t.includes('（`outcome-port.mjs` → `plugins/connector-feedback.mjs`'), false,
    '旧的短路径写法还在文档里')
})

test('③ ★ 正向控制：带目录的路径不存在 ⇒ 必须红', () => {
  const r = check(docOf([row('F-99', '`runtime/nope/missing.mjs`')]), ['runtime/real.mjs'])
  assert.equal(r.ok, false, '带目录的路径不存在却没红')
  assert.ok(r.violations.some((v) => v.id === 'landing-path-missing'),
    JSON.stringify(r.violations))
})

test('④ ★★★ 正向控制（本判据存在的理由）：裸名全仓有 2 个同名 ⇒ 必须红', () => {
  // 这正是第 25/28 轮那类问题的机器形状：
  // 名字没错、文件也都在，而**读者解析不出指的是哪一个**。
  // ★ 夹具必须让"沿本格目录继承"**也**解不开，否则它会被继承那一条合法解掉
  //   （第一版夹具把 `thing.mjs` 放进 `a/` 里，于是 `a/thing.mjs` 正好继承得到 ⇒ 不该红）。
  const r = check(
    docOf([row('F-99', '`a/thing.mjs`、`dup.mjs`')]),
    ['a/thing.mjs', 'b/dup.mjs', 'c/dup.mjs'],
  )
  assert.equal(r.ok, false, '裸名有 2 个同名却没红 ⇒ 这列简写可以随便写了')
  assert.ok(r.violations.some((v) => v.id === 'landing-path-ambiguous'),
    JSON.stringify(r.violations))
})

test('④b ★★ 反向控制：裸名全仓唯一 ⇒ **不许**红（简写是合法的）', () => {
  // ★ 这里刻意让唯一同名文件**不在**本格已确立的目录下，
  //   这样命中的是 R2（全仓唯一）而不是 R3（继承）——两支柱子要分别被走到。
  const r = check(
    docOf([row('F-99', '`a/thing.mjs`、`other.mjs`')]),
    ['a/thing.mjs', 'z/other.mjs'],
  )
  assert.deepEqual(r.violations, [], '全仓唯一的裸名被判红了：' + JSON.stringify(r.violations))
  assert.equal(r.viaUniqueName, 1)
})

test('⑤ ★★ 反向控制：沿本格已确立的目录解得开 ⇒ 不许红', () => {
  // 这一列的惯例：第一个带目录的路径确立目录，后面的裸名继承它。
  // 判据必须懂这个惯例，否则会红在**正确**的行上（第一版探针就报了 23 处假的）。
  const r = check(
    docOf([row('F-01', '`runtime/contracts/adapter.mjs`、`run.mjs`、`errors.mjs`')]),
    ['runtime/contracts/adapter.mjs', 'runtime/contracts/run.mjs', 'runtime/contracts/errors.mjs',
      'somewhere/else/run.mjs', 'another/errors.mjs'],
  )
  assert.deepEqual(r.violations, [],
    '沿本格目录继承被误判：' + JSON.stringify(r.violations))
  assert.equal(r.inherited, 2, `应有 2 个靠继承，实际 ${r.inherited}`)
})

test('⑥ ★★ 控制：扫到 0 行 / 0 个路径 ⇒ 都不许报绿（"什么都没查"≠"全对"）', () => {
  const r1 = check('没有任何功能行\n', ['a/b.mjs'])
  assert.equal(r1.ok, false, '一行都没扫到却报绿 ⇒ 判据被架空了')
  assert.ok(r1.violations.some((v) => v.id === 'landing-scan-empty-rows'))

  const r2 = check(docOf([row('F-99', '这里没有任何反引号路径')]), ['a/b.mjs'])
  assert.equal(r2.ok, false, '一个路径都没解析出却报绿')
  assert.ok(r2.violations.some((v) => v.id === 'landing-scan-empty-paths'))
})

test('⑦ 列数不是 5/6 的表（§2 投影表等）不归这条判据管', () => {
  const text = [
    '| 架构阶段 | 当前状态 | 可核对落点 |',
    '|---|---|---|',
    '| 阶段 0 | 已建立 | `nope/missing.mjs` |',
    '',
  ].join('\n')
  const r = check(text, ['a/b.mjs'])
  assert.equal(parseLandingCells(text).length, 0, '3 列的表被当成功能行读进来了')
  assert.ok(r.violations.every((v) => v.id.startsWith('landing-scan-empty')),
    '3 列表格的落点被拿去核对了：' + JSON.stringify(r.violations))
})

test('⑧ 通配符不算"解不开"（`approval-*.mjs` 这类），但要数出来', () => {
  const r = check(
    docOf([row('F-99', '`a/thing.mjs`、`approval-*.mjs`')]),
    ['a/thing.mjs'],
  )
  assert.deepEqual(r.violations, [], '通配被当成坏引用：' + JSON.stringify(r.violations))
  assert.equal(r.globbed, 1, `通配应数出 1 个，实际 ${r.globbed}`)
})

test('⑨ 非路径的反引号内容（函数名、字段名）不参与核对', () => {
  const r = check(
    docOf([row('F-99', '`a/thing.mjs` 的 `freezeDeclaration`/`connectorIncidents` 都接在路由上')]),
    ['a/thing.mjs'],
  )
  assert.equal(r.scanned, 1, `只该扫 1 个路径，实际 ${r.scanned}`)
  assert.deepEqual(r.violations, [])
})

test('⑩ `{a,b}.mjs` 花括号展开成两个具体路径，各自都要解得开', () => {
  assert.deepEqual(expandBraces('orchestrator/worker/{executor,main}.mjs'),
    ['orchestrator/worker/executor.mjs', 'orchestrator/worker/main.mjs'])
  // 两个都存在 ⇒ 绿
  const ok = check(
    docOf([row('F-99', '`orchestrator/worker/{executor,main}.mjs`')]),
    ['orchestrator/worker/executor.mjs', 'orchestrator/worker/main.mjs'],
  )
  assert.deepEqual(ok.violations, [])
  // 只存在一个 ⇒ 另一个必须红（展开不许把两个当成一个）
  const bad = check(
    docOf([row('F-99', '`orchestrator/worker/{executor,main}.mjs`')]),
    ['orchestrator/worker/executor.mjs'],
  )
  assert.equal(bad.ok, false, '花括号展开后漏了一个没核')
  assert.ok(bad.violations.some((v) => v.token === 'orchestrator/worker/main.mjs'),
    JSON.stringify(bad.violations))
})

test('⑪ tokensOf 只认"像文件路径"的反引号内容', () => {
  assert.equal(PATH_RE.test('a/b.mjs'), true)
  assert.equal(PATH_RE.test('run_events'), false)
  assert.equal(PATH_RE.test('ctx.tools.guard'), false)
  // ★ 通配也算"像路径"——它要被数出来（`globbed`）再跳过，
  //   否则"跳过了 0 个通配"与"这一列根本没有通配"是同一个读数
  //   （第一版把 `*` 排除在字符集外，于是 `globbed` **永远**是 0，而用例没抓到）。
  assert.equal(PATH_RE.test('approval-*.mjs'), true)
  assert.deepEqual(tokensOf('`a/b.mjs`、`x.md`、`not-a-path`、`p/q.ts`'),
    ['a/b.mjs', 'x.md', 'p/q.ts'])
})

test('⑫ 一格里的裸名**先**试继承、再试全仓唯一；两者都能解时以继承为准', () => {
  // 同名文件有两个，但其中一个正好在本格已确立的目录下 ⇒ 读者能解析 ⇒ 不许红
  const r = check(
    docOf([row('F-99', '`a/thing.mjs`、`dup.mjs`')]),
    ['a/thing.mjs', 'a/dup.mjs', 'b/dup.mjs'],
  )
  assert.deepEqual(r.violations, [],
    '继承解得开却被判成歧义：' + JSON.stringify(r.violations))
  assert.equal(r.inherited, 1)
})

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 第 48 轮：本模块**不再自己认行**（交给 `progress-check.featureTableRow`）
//
// 它此前自己判行、自己分格、**自己定格子数**（`≠5 且 ≠6 ⇒ continue`）。
// 实测（`scratch/_probe-landing-owner.mjs`）：真文档上四个解析器**一致**
// （都是 29 行），但 **4 格与 7 格的行被静默跳过**，而所有者收下。
//
// ★★ 后果比第 47 轮那次**更重**：本模块的职责是
//   "功能表声明的代码落点必须指向**存在的文件**"。
//   一行被跳过 ⇒ **它声明的路径一个都不会被核**，而门禁报"全部通过"。
//
//   > 一个"这一行我没看懂所以跳过"的默认动作，
//   > 与"这一行真的没问题"，在输出里都是"没有报错"。
//   > 区别只在于：前者会让你**以为**你核过了。
// ══════════════════════════════════════════════════════════════════════════

test('⑬ ★★★ 4 格 / 7 格的功能行**也要读**（它们的落点必须被核）', () => {
  const withCols = (n) => `| ${['F-99', '名称', '✅', '`a/thing.mjs`', '证据', '—', '附注']
    .slice(0, n).join(' | ')} |`
  for (const n of [4, 5, 6, 7]) {
    const cells = parseLandingCells(docOf([withCols(n)]))
    assert.equal(cells.length, 1,
      `${n} 格的功能行被静默跳过 ⇒ 它声明的落点**一个都不会被核**，而门禁报"全部通过"`)
    assert.equal(cells[0].cell, '`a/thing.mjs`', `${n} 格时落点列取错了`)
  }
  // ★ 反面控制：**3 格**是**另一张表**，仍必须放过去（否则会拿它当功能行、假红）。
  assert.equal(parseLandingCells('| F-21 缺口 | 读数 | 判据 |').length, 0,
    '把另一张 3 格表当成了功能表 ⇒ 阈值放宽过头')
})

test('⑭ ★★ 认不出的状态格**抛**（本模块不再自己判，但它跟着所有者一起抛）', () => {
  // ★ 这条保证"交出行识别权"没有把 fail-closed 一起交掉。
  assert.throws(() => parseLandingCells(docOf([row('F-99', '`a/thing.mjs`').replace('✅', '🔵')])),
    /状态格不是已知形状/,
    '认不出的状态格被静默跳过 ⇒ 那一行的落点也不会被核')
  // ★ 反面控制：四个合法终态一个都不许抛。
  for (const st of ['✅', '🟡', '⬜', '⏸']) {
    assert.doesNotThrow(() => parseLandingCells(docOf([row('F-99', '`a/thing.mjs`').replace('✅', st)])),
      `${st} 是合法状态，却被判成非法`)
  }
})
