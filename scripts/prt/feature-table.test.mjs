// scripts/prt/feature-table.test.mjs
// ============================================================================
// F-01～F-25 对照表的守卫（逻辑在 `feature-table.mjs`）
//
// ★ 本组的意义：那条判据的正常输出是「**0 条问题**」，而"0 条问题"与
//   "我的解析器什么都没看见"在只打印结论的输出里长得一模一样。
//   所以这组用例的重点**不是**再跑一遍真文档（①a 就干那个），
//   而是**证明它会咬**——每一条断言都配一个"改坏了必须红"的反面控制。
//
// ★★ 反面控制的写法有个陷阱（本会话栽过两次）：把坏形状写进**字符串字面量**
//   就会让"我这个文件里有这个坏形状"变成真——好在这条判据只扫**一个指定的
//   文档字符串**（`docText`），不扫源码，所以夹具是安全的。
//   反过来说：**这正是不该让判据去扫源码的原因**。
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  FEATURE_IDS, STATUS_DOC, OPTIMIZATION_DOC,
  analyze, parseFeatureTables, refsIn, resolveRef, trackedFiles,
} from './feature-table.mjs'

const REAL = analyze()

/**
 * 造一份最小文档：一张 §1 形状的表（6 列）。
 *
 * ★★ 传进来的行**只覆盖**它点名的那些编号，其余 24 条**自动补成合法行**。
 *   第一版没有这个补齐，于是"想测状态闭集"的用例里，`problems` 里
 *   还混着 24 条"缺 F-xx" ⇒ 断言的 `deepEqual(problems, [])` 全红，
 *   而红的原因与被测的那件事**毫无关系**。
 *
 *   > 一个"这条控制没咬住"与一个"我的夹具顺带造了 24 个别的错"，
 *   > 在只看红没红的输出里是同一个东西——而后者会让你去改**判据**。
 *
 *   ⇒ 夹具的职责是**只让一个变量动**。
 */
function docOf(rows, { omit = [] } = {}) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const full = FEATURE_IDS.filter((id) => !omit.includes(id)).map((id) => byId.get(id) ?? {
    id, status: '✅', loc: '`product/launcher/launcher.mjs`',
  })
  // 不是 F-01～F-25 的行（拆分行 `F-05 前半`、子行 `F-18 缺口①`）追加在后面
  const extra = rows.filter((r) => !FEATURE_IDS.includes(r.id))
  const head = [
    '## 1. P0',
    '',
    '| 编号 | 名称 | 状态 | 代码落点 | 判据 / 证据 | 还差什么 |',
    '|---|---|---|---|---|---|',
  ]
  const body = [...full, ...extra].map(
    (r) => `| ${r.id} | ${r.name ?? '名'} | ${r.status} | ${r.loc} | ${r.ev ?? '—'} | ${r.gap ?? '—'} |`,
  )
  return [...head, ...body, ''].join('\n')
}

/** 一个够用的假文件清单：真的存在几个文件，外加本测试自己点的。 */
const FILES = new Set([
  'product/launcher/launcher.mjs',
  'runtime/dsh-composition/tool-request.mjs',
  'runtime/contracts/adapter.mjs',
  'runtime/contracts/run.mjs',
  'runtime/contracts/errors.mjs',
])

// ── ① 真文档 ────────────────────────────────────────────────────────────────

test('①a 真文档：25 条全在、状态是闭集、每行至少一条落点解析得到', () => {
  assert.ok(REAL.parsedRows > 0,
    `解析出 ${REAL.parsedRows} 行 ⇒ 这条判据其实什么都没看（表头认不出来了？）`)
  assert.deepEqual(REAL.missing, [],
    `优化文档点名了这些编号，而对照表里没有：${REAL.missing.join(', ')}`)
  assert.deepEqual(REAL.problems, [],
    '★ 对照表有这些问题（每一条都该被当成"这一格在说一件不成立的事"）：\n  '
    + REAL.problems.join('\n  '))
})

test('①b ★ 真文档的落点判定**确实开着**（不许"因为没文件所以全绿"）', () => {
  // 这一条守的是本判据最容易变成"假绿"的那个模式：
  // 拿不到文件清单 ⇒ 解析不出任何东西 ⇒ 如果实现是"解析不到就放行"，
  // 那么它在**任何**环境里都是绿的，包括文档指着月球的时候。
  assert.equal(REAL.pathCheckAvailable, true,
    '拿不到已跟踪文件清单 ⇒ 落点那一整段被跳过了。'
    + '本机应当能跑 `git ls-files`；若这是在干净检出里跑的，请把这一条的期望改成"显式记成无法判定"')
  const checked = REAL.rows.filter((r) => Array.isArray(r.paths) && r.paths.length > 0)
  assert.ok(checked.length >= 20,
    `只有 ${checked.length} 行的落点被真的看过 ⇒ 覆盖面比表本身小得多`)
  assert.ok(checked.every((r) => r.resolved >= 1),
    '★ 有行的落点一条都没解析到（①a 应当已经报出来了）')
})

// ── ② 状态词表**归别人管**：本模块不判，但必须钉住那个所有者还在 ─────────────
//
// ★★★ 这一组是本批**最贵的一课**。本判据的第一版自己抄了一份状态词表，
//   并据此"订正"了真文档里三格箭头写法（`🟡→✅` → `✅（原 🟡，…）`），
//   理由是"机器读不出箭头两头的哪一个"。
//
//   全量 CI 立刻红了 —— 红在 `progress-check.test.mjs` 的**用例 ⑥**上，
//   而那条判据**明确许可箭头**：
//
//     const okStatus = (s) => legend.includes(s) || /^[✅🟡⬜⏸]+→[✅🟡⬜⏸]+$/.test(s)
//
//   > 一道看不见某类改动的闸门，比没有闸门更危险；
//   > 而**一道看得见的闸门，比我以为"没有闸门"更常见**。
//
//   ⇒ 处置有两条，都记在这里：
//     ① **回退**那三格（原文是对的，我的"订正"没有依据）；
//     ② 本模块**不再判状态词表**，改为**钉住那个所有者还在**——
//        *两份词表并存必然漂移，而漂移的那一天没人知道该信哪一份。*

/** 状态词表的**所有者**：那个文件 + 它必须仍然含有的判据文本。 */
const OWNER = 'scripts/prt/progress-check.test.mjs'
const OWNER_MARKERS = [
  '对照表里每个 F-行都必须用图例里的状态标记', // 用例名
  "const legend = ['✅', '🟡', '⬜', '⏸']", // 词表本身
  '^[✅🟡⬜⏸]+→[✅🟡⬜⏸]+$', // 箭头写法的许可形状
]

test('② ★★★ 状态词表的**所有者**还在（本模块不判它，但要知道谁判）', () => {
  const src = readFileSync(OWNER, 'utf8')
  const missing = OWNER_MARKERS.filter((m) => !src.includes(m))
  assert.deepEqual(missing, [],
    `状态词表的所有者「${OWNER}」里这些标记不见了：\n  ${missing.join('\n  ')}\n`
    + '⇒ 要么那条判据被删了（那么状态列**再没有任何东西在管**），'
    + '要么它换了写法（那么本模块钉的这句要跟着改）。两种都不许静默发生。')
})

test('②a ★★ 所有者那条判据**在 CI 里真的会跑**（"谁判"不够，还要"判的人在场"）', () => {
  // ⚠️ 本用例**不去 spawn 那个套件**，这是实测后的决定：
  //   套件里再起一个 `node --test` 会继承 `NODE_TEST_CONTEXT=child-v8`，
  //   于是那个子进程**挂到父 runner 上**、**stdout 一个字节都不打**。
  //   实测：不清理 → **0 字节**；清掉 → 16 字节。
  //
  //     > 一个"嵌套套件跑绿了"的读数，与一个"它根本没在打印"的读数，
  //     > 在只看 `execFileSync` 没抛异常的判据里是同一个东西。
  //
  //   ⇒ 两条更稳的替代：① ② 已经核了所有者文件的**判据文本还在**；
  //     ② 这里核**它被登记进 run-ci** ⇒ 它不会静默停止运行。
  //     而"它现在对真文档是绿的"由**全量 CI 自己**回答（两套都在里面跑）。
  const ci = readFileSync('scripts/ci/run-ci.mjs', 'utf8')
  assert.ok(ci.includes(`'${OWNER}'`),
    `所有者「${OWNER}」没被登记进 run-ci ⇒ 它**不会跑**，`
    + '那么状态列实际上仍然没有任何东西在管（而 ② 会因为文件里还留着那几行字而继续变绿）')
})

test('②b 本模块**确实不判**状态词表（否则两份词表会漂移）', () => {
  // ★ 判据：把真文档里某一格的状态改成图例之外的词，**本模块不该红**——
  //   因为那不是它的职责，红了就说明它又抄了一份词表回来。
  const r = analyze({
    docText: docOf([{ id: 'F-01', status: '进行中', loc: '`product/launcher/launcher.mjs`' }]),
    files: FILES,
  })
  assert.deepEqual(r.problems, [],
    '本模块开始判状态词表了 ⇒ 它与 progress-check ⑥ 会各有一份词表，'
    + `迟早一份说合法、另一份说非法：${JSON.stringify(r.problems)}`)
  // 但状态**要原样读出来**（供报告与人工核对）——不评价 ≠ 不读。
  const row = r.rows.find((x) => x.id === 'F-01')
  assert.equal(row.status, '进行中', '状态没被读进 rows ⇒ 报告里会看不见它')
})

// ── ③ 25 条覆盖 ────────────────────────────────────────────────────────────

test('③ ★ 控制：少一条（缺 F-07）必须红，且**点名**是缺哪一条', () => {
  // ★ 这里**必须**用 `omit`：夹具默认会把 24 条补齐，所以"把 F-07 从数组里去掉"
  //   其实是**什么都没去掉**——第一版就是这么写的，于是这条控制根本没咬住，
  //   而红出来的原因（`missing` 是空数组）看起来像判据坏了。
  //   *一个"夹具自动补齐了我要制造的那个缺口"与一个"判据抓不住缺口"，
  //   在只看红没红的输出里是同一个东西。*
  const r = analyze({ docText: docOf([], { omit: ['F-07'] }), files: FILES })
  assert.deepEqual(r.missing, ['F-07'], `缺的那条报错了：${JSON.stringify(r.missing)}`)
  assert.ok(r.problems.some((p) => p.includes('F-07')), JSON.stringify(r.problems))
})

test('③b ★ 控制：拆分行（`F-05 前半` / `F-05 后半`）**算**覆盖到 F-05', () => {
  // 真文档就是这么写的：F-05 被拆成两行，没有一行叫 `F-05`。
  // 只认精确写法会把这条报成"缺 F-05"——而表里明明有两行在讲它。
  //
  // ★★ 这里**必须** `omit: ['F-05']`。第一版我没写，于是夹具的自动补齐
  //    替我把一个**规规矩矩的 `F-05 ✅` 行**补了进来 ⇒ 这条用例描述的是
  //    "拆分行也算覆盖"，实际测的是"自动补齐也算覆盖"，**它从来没咬过**。
  //    变异验证逐条跑出来才看见（M4 只红了 ①a，没红 ③b）。
  //
  //    > 一个"我的夹具替我补上了我要制造的那个缺口"，与一个"判据抓住了缺口"，
  //    > 在只看红没红的输出里是同一个东西——**而且它会连着骗过两轮**：
  //    > ③ 的第一版已经栽过一次同样的跟头（见上面那段注释）。
  const rows = [
    { id: 'F-05 前半', status: '✅', loc: '`product/launcher/launcher.mjs`' },
    { id: 'F-05 后半', status: '✅', loc: '`product/launcher/launcher.mjs`' },
  ]
  const r = analyze({ docText: docOf(rows, { omit: ['F-05'] }), files: FILES })
  assert.deepEqual(r.missing, [], `拆分行没被算成覆盖：${JSON.stringify(r.missing)}`)
  // 反向对照：**只去掉拆分行**（还是 omit F-05）⇒ 必须报缺 F-05。
  // 少了它，上面那句在"判据永远不报 missing"时也是绿的。
  const bare = analyze({ docText: docOf([], { omit: ['F-05'] }), files: FILES })
  assert.deepEqual(bare.missing, ['F-05'], '把拆分行去掉之后仍不报缺 ⇒ 上面那条没在测覆盖')
})

test('③c 控制：子行（`F-18 缺口①`）**不参与落点判定**，且它的「状态」格是散文不算状态', () => {
  // 真文档里子行长这样：
  //   `| F-18 缺口① | 摩擦分无法被证伪… | \`friction.test.mjs\` 23 例…，8 处守卫已**变异验证** |`
  // —— 它的第三格（本题的「状态」位）是**证据描述**，不是状态。
  //
  // ★ 子行**还**必须跳过**落点**判定：它指的是"哪条证据守住了这个缺口"，
  //   不是"这个缺口落在哪个文件"，把路径解析器架在散文上会得到噪声。
  //   ⇒ 这里故意给子行一个**不存在的路径**：跳过了 ⇒ 不报；没跳过 ⇒ 必红。
  //   （第一版只断言"散文不算状态"，而状态判定已经移交出去之后，
  //    那条断言就**变成了空转** —— 变异 M3 逐条跑出来的。）
  const rows = FEATURE_IDS.map((id) => ({ id, status: '✅', loc: '`product/launcher/launcher.mjs`' }))
  rows.push({ id: 'F-18 缺口①', status: '`friction.test.mjs` 23 例（含…），8 处守卫已变异验证', loc: '`definitely/not/here.mjs`' })
  const r = analyze({ docText: docOf(rows), files: FILES })
  assert.deepEqual(r.problems, [],
    `子行被当成了普通数据行（它的散文状态或证据路径被拿去判了）：${JSON.stringify(r.problems)}`)
  assert.deepEqual(r.soft, [], `子行进了解析报告：${JSON.stringify(r.soft)}`)
  // 反向对照：把同一条**去掉子行后缀**（变成普通 `F-19`）⇒ 那个不存在的路径必须红。
  // 少了它，上面那句在"落点判定整个失效"时也是绿的。
  const asData = analyze({
    docText: docOf([{ id: 'F-19', status: '✅', loc: '`definitely/not/here.mjs`' }]),
    files: FILES,
  })
  assert.ok(asData.problems.some((p) => p.includes('一条都解析不到')),
    `同一个路径当普通行时都不报 ⇒ 上面那条没在测"跳过"：${JSON.stringify(asData.problems)}`)
})

// ── ④ 落点必须至少有一条是真的 ──────────────────────────────────────────────

test('④ ★ 控制：整行落点全解析不到 ⇒ 必须红', () => {
  const r = analyze({
    docText: docOf([{ id: 'F-01', status: '✅', loc: '`definitely/not/here.mjs`' }]),
    files: FILES,
  })
  assert.ok(r.problems.some((p) => p.includes('一条都解析不到')),
    `指着空的一行没被报出来：${JSON.stringify(r.problems)}`)
})

test('④b ★★ 控制：同目录**裸名**要解析得到（这是我第一版报的 22 条假红的主因）', () => {
  // 单元格真实写法：`runtime/contracts/adapter.mjs`、`run.mjs`、`errors.mjs`
  // —— 后两个是**同目录的裸文件名**。
  //
  // ★★ 裸名必须**有歧义**才测得到"当前目录推进"这件事：
  //    `run.mjs` 在真仓里有 `runtime/contracts/run.mjs` 与 `orchestrator/worker/run.mjs`
  //    两个，所以**离开当前目录**它就该是 ambiguous。第一版我在这个夹具里
  //    只放了一个 `run.mjs`，于是后缀唯匹规则照样解析得到 ⇒ 这条用例
  //    **在"当前目录"被整个删掉之后仍然全绿**（变异 M6 逐条跑出来的）。
  //
  //    > 一个"唯一后缀恰好也指对了"的夹具，与一个"上下文推导真的生效"的夹具，
  //    > 在只看绿没绿的输出里是同一个东西——只不过前者的通过**不依赖**被测机制。
  const files = new Set([...FILES, 'orchestrator/worker/run.mjs'])
  const r = analyze({
    docText: docOf([{ id: 'F-01', status: '✅', loc: '`runtime/contracts/adapter.mjs`、`run.mjs`、`errors.mjs`' }]),
    files,
  })
  assert.deepEqual(r.problems, [],
    '同目录裸名被报成"解析不到" ⇒ 这条判据会**红在正确的地方**，'
    + `而下一个人会把它删掉：${JSON.stringify(r.problems)}`)
  assert.deepEqual(r.soft, [],
    '裸名进了"只报告"桶 ⇒ 上下文目录没有推导出来'
    + '（run.mjs 在这一步应当是 unambiguous 的）：' + JSON.stringify(r.soft))
  // 反向对照：**去掉**那句给出上下文的引用 ⇒ `run.mjs` 必然歧义。
  // ★ 而且它**只能**进"只报告"桶，不许判红：两个候选里可能有一个是对的，
  //   我**无法判定**——"我认不出"与"它指着空"不是同一句话。
  const noCtx = analyze({
    docText: docOf([{ id: 'F-01', status: '✅', loc: '`run.mjs`' }]),
    files,
  })
  assert.ok(noCtx.soft.some((s) => s.includes('多候选')),
    `没有上下文时 run.mjs 应当是 ambiguous，实测：${JSON.stringify(noCtx.soft)}`)
  assert.deepEqual(noCtx.problems, [],
    '只有歧义**不能**判红 —— 否则这条判据会去改一份其实是对的文档：'
    + JSON.stringify(noCtx.problems))
})

test('④c ★★ 控制：`dir/*` 与 `dir/` 都是合法写法，要算解析到', () => {
  for (const loc of ['`product/launcher/*`', '`runtime/contracts/`']) {
    const r = analyze({ docText: docOf([{ id: 'F-01', status: '✅', loc }]), files: FILES })
    assert.deepEqual(r.problems, [], `${loc} 被误报：${JSON.stringify(r.problems)}`)
  }
  // ★ 反向：目录**不存在**时必须红（不是"只要写了 `/*` 就放行"）
  const bad = analyze({ docText: docOf([{ id: 'F-01', status: '✅', loc: '`nope/never/*`' }]), files: FILES })
  assert.ok(bad.problems.some((p) => p.includes('一条都解析不到')),
    `不存在的目录通配没被报出来：${JSON.stringify(bad.problems)}`)
})

test('④d 控制：大括号展开与路由不算错', () => {
  const ok = analyze({
    docText: docOf([{ id: 'F-01', status: '✅', loc: '`runtime/contracts/{adapter,run}.mjs`、`/api/event-delivery`' }]),
    files: FILES,
  })
  assert.deepEqual(ok.problems, [], JSON.stringify(ok.problems))
})

test('④e 多候选（ambiguous）**不算**"不存在"——它进"只报告"桶', () => {
  const more = new Set([...FILES, 'other/run.mjs'])
  const r = analyze({ docText: docOf([{ id: 'F-01', status: '✅', loc: '`runtime/contracts/adapter.mjs`、`zzz.mjs`' }]), files: more })
  // zzz.mjs 哪里都没有 ⇒ 但 adapter.mjs 解析到了 ⇒ **整行不该红**
  assert.deepEqual(r.problems, [], JSON.stringify(r.problems))
  assert.ok(r.soft.some((s) => s.includes('zzz.mjs')), `无法判定的那条没进"只报告"桶：${JSON.stringify(r.soft)}`)
})

// ── ⑤ 拿不到文件清单 ⇒ 不许伪装成"通过"也不许伪装成"失败" ──────────────────

test('⑤ ★★★ 控制：文件清单为空 ⇒ 落点判定整段跳过，**不是 29 行全红**', () => {
  // 干净检出 / 无 git ⇒ `trackedFiles()` 空集。
  // 若实现是"解析不到就红"，那一天 **每一行都红**，而那不是"文档错了"。
  // 若实现是"解析不到就放行"，那它在**任何**环境里都绿，包括文档指着月球时。
  // ⇒ 正确的处置是**显式记成"无法判定"**（与 boundary-facts 里
  //    "因 DSH 检出不在而无法判定"同一档）。
  const r = analyze({
    docText: docOf([{ id: 'F-01', status: '✅', loc: '`runtime/contracts/adapter.mjs`' }]),
    files: new Set(),
  })
  assert.equal(r.pathCheckAvailable, false)
  assert.deepEqual(r.problems.filter((p) => p.includes('一条都解析不到')), [],
    '没有文件清单时把每一行都判红了 ⇒ 干净检出里这套用例会全红')
  assert.ok(r.soft.some((s) => s.includes('跳过')), `"无法判定"没有被显式记出来：${JSON.stringify(r.soft)}`)
  // ★ 而**不依赖文件清单**的那条断言（25 条覆盖）**仍然生效**——
  //   *`跳过`不许变成`整条判据停摆`。*
  //   ⚠️ 第一版这里断言的是"状态仍要判"，而状态判定**已经移交给 progress-check ⑥**
  //   （见 ② 那一组），于是那条断言在模块删掉状态判定之后变成了**在测一个不存在的行为**。
  const missOne = analyze({ docText: docOf([], { omit: ['F-07'] }), files: new Set() })
  assert.deepEqual(missOne.missing, ['F-07'],
    '没有文件清单时连"25 条覆盖"也不判了 ⇒ "跳过"变成了"整条判据停摆"')
})

// ── ⑥ 解析器本身的守卫 ──────────────────────────────────────────────────────

test('⑥ 三张表都认得出来（列数不同：P0 六列 / P1 五列 / P2 四列）', () => {
  const text = readFileSync(STATUS_DOC, 'utf8')
  const tables = parseFeatureTables(text)
  assert.ok(tables.length >= 3, `只认出 ${tables.length} 张表（真文档有 P0/P1/P2 三张）`)
  const cols = tables.map((t) => t.header.length).sort((a, b) => a - b)
  assert.ok(new Set(cols).size >= 2, `三张表的列数应当不同，实测 ${JSON.stringify(cols)}`)
})

test('⑥b 优化文档确实点名了 F-01～F-25（本判据的"应有集合"有出处）', () => {
  const opt = readFileSync(OPTIMIZATION_DOC, 'utf8')
  for (const id of FEATURE_IDS) {
    assert.ok(opt.includes(id), `优化文档里找不到 ${id} —— 那么"缺 ${id}"这条断言就是凭空来的`)
  }
})

test('⑥c `refsIn` 只取反引号里像路径的东西', () => {
  assert.deepEqual(refsIn('`a/b.mjs`、`c.mjs`、`随便一句话`、`123`'),
    ['a/b.mjs', 'c.mjs'])
})

test('⑥d `resolveRef` 的空输入与路由不抛', () => {
  assert.equal(resolveRef('', { files: FILES }).kind, 'empty')
  assert.equal(resolveRef('/api/x', { files: FILES }).kind, 'route')
  assert.equal(resolveRef('`<产品家目录>/x.mjs`', { files: FILES }).kind, 'placeholder')
})

test('⑥e `trackedFiles()` 在真仓里拿得到东西（否则上面全是空转）', () => {
  const f = trackedFiles()
  assert.ok(f.size > 100, `只拿到 ${f.size} 个已跟踪文件 ⇒ 解析器的"仓库"是空的`)
  assert.ok([...f].includes(STATUS_DOC), '连本判据自己要读的那份文档都不在清单里')
})
