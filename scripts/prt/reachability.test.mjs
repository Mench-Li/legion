// scripts/prt/reachability.test.mjs
// ============================================================================
// PRT-611 续：**可达性**门禁。
//
// ## 它补的是哪一格（这是本套件存在的全部理由）
//
// 台账与对照表的 ✅ 口径是「有代码落点 + 可复跑的判据」。那条口径里**没有**
// "这个落点在生产里到得了"这一格。于是下面这种读数可以长期存在：
//
//   · `runtime/packs/store.mjs`（PRT-1003 安装/启用/停用/升级记录，✅）
//     有 **1** 个非测试导入者 ⇒ 在"有几个导入者"这个读数上它是**活的**；
//   · 而那 1 个是 `runtime/packs/builtin/software-delivery.mjs`，
//     它自己有 **0** 个导入者。
//
//   > 一个「唯一的导入者也是死的」的模块，
//   > 与一个「真的有人在用」的模块，在"有几个非测试导入者"上是同一个东西。
//
// 所以要看的是**传递**问题：从真实进程入口出发，走得到它吗。
//
// ## 本套件的五条判据
//
//   ① **正对照**：探针本身活着（入口认得出、已知接上的可达、清单声明的行可达、
//      用例不被当入口）。少了这一条，下面所有"不可达"的结论都不可信——
//      一个坏掉的探针与一个"全都可达"的世界，在输出上是同一个东西。
//   ② **没有未分类的不可达模块**：新出现的"已交付但到不了"必须有人给它定性。
//   ③ **基线里不许有已被删除的文件**：否则基线会烂掉（条目永远清不掉）。
//   ④ ★ **读数**：本批认定的 `gap` 逐条仍然不可达——**接上了它会红**。
//   ⑤ 基线自身的形状（每条都有 class 与 reason；class 在封闭词表里）。
//
// ★ 关于"基线过期"：**不判红**。模块变成可达从来不是回归，
//   把它判成回归等于惩罚正在接线的人（本仓库有另一个 agent 进程在并发提交）。
//   过期项由 CLI 打成醒目警告，并由 `--record` 清掉。这条取舍写在基线文件头。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { analyze, ignoredFiles, loadBaseline, REPO, SCAN_DIRS, PROCESS_ENTRIES } from './reachability.mjs'

const a = analyze()
const baseline = loadBaseline()
const isTest = (f) => f.endsWith('.test.mjs')

// ══════════════════════════════════════════════════════════════════════════
// ① 正对照：探针必须活着
// ══════════════════════════════════════════════════════════════════════════

test('① ★★★ 正对照：入口认得出、已知接上的可达、清单声明的行可达、用例不当入口', () => {
  // ①-1 进程入口自己必须可达（且是入口）
  for (const e of PROCESS_ENTRIES) {
    if (!a.known.has(e)) continue
    assert.equal(a.reach.has(e), true, `${e} 是进程入口却不可达——BFS 坏了`)
    assert.ok(a.entries.has(e), `${e} 没有被算作入口`)
  }

  // ①-2 已知接在生产上的模块必须可达。**四个不同接线方式各一条**，
  //      否则对照本身有盲区（本仓库被这个坑咬过：只覆盖已知路径的正对照等于没有）。
  const live = [
    ['team-hub/tool-call-log.mjs', '被 hub 服务端 import'],
    ['runtime/contracts/run.mjs', '跨目录 import'],
    ['product/compliance/inventory.mjs', '被 scripts/ 下的生产脚本 import'],
    ['runtime/dsh-composition/tool-request.mjs', '被执行面组合根 import'],
    ['runtime/packs/manifest.mjs', '被 Launcher 的安装路径 import'],
  ]
  for (const [f, why] of live) {
    assert.equal(a.reach.has(f), true,
      `★ 正对照失败：${f}（${why}）本该可达。这说明探针坏了，"不可达"的结论不可信`)
  }

  // ①-3 ★ 清单声明的行必须可达。两种路径写法各一条：
  //      `module: './plugins/hard-floor.mjs'`（相对声明文件）
  //      `path: 'product/orchestrator/worker.mjs'`（仓库相对）
  //      两次实测都是漏了其中一种，把正在跑的进程/行报成死代码。
  for (const [f, why] of [
    ['runtime/dsh-composition/plugins/hard-floor.mjs', 'patch-layer 的 module:（文件相对）'],
    ['product/orchestrator/worker.mjs', 'process-manifest 的 entry.path（仓库相对）'],
  ]) {
    assert.equal(a.reach.has(f), true,
      `★ 正对照失败：${f}（${why}）是被**清单字符串**加载的，探针没有认出来`)
  }

  // ①-4 用例**不许**被当入口。这一条最要紧：用例一算入口，
  //      任何"只被自己的用例 import"的模块都会变成可达，整个探针当场反转。
  const testEntries = [...a.entries.keys()].filter(isTest)
  assert.deepEqual(testEntries, [],
    `★ 用例被当成了入口：${testEntries.join(', ')}。` +
    '用例按定义就是"被按路径跑、不被 import"，把它们算进去会让本探针什么也查不出来')

  // ①-5 ★★★ 第五种入口写法：**不在 `scripts/` 下的按路径启动的服务**。
  //
  //  前四种（进程入口表 / `scripts/` / package.json bin·main / 清单声明）都覆盖到了，
  //  而 `scrum/serve.mjs` 一种都不占——它既不 `scripts/` 开头、也不含 `/scripts/`，
  //  而且 `scrum/` 当时**整个不在 SCAN_DIRS 里**。
  //
  //  代价是一处**假阳性**，方向正是本探针最忌讳的那一种：
  //  `scrum/serve.mjs:38` import 的 `packages/shared/src/artifact-policy.mjs`
  //  被报成 `[gap] 只被自己的用例 import`——而它有两个真实消费者
  //  （另一个是 `board-plugin/src/index.ts:18`，编成未跟踪的 `lib/`）。
  //
  //  权威来源不是猜的：`scripts/ci/run-ci.mjs:3748` 的 `tracked` 清单
  //  （stage 阶段算 SHA256SUMS 的那一份）逐字列着 `scrum/serve.mjs`。
  //
  //  > 一个"把在跑的服务报成死代码"的探针，
  //  > 比一个"什么都没查"的探针更坏——因为**它的结论会被当成读数用**。
  for (const [f, why] of [
    ['scrum/serve.mjs', '不在 scripts/ 下、按路径启动的服务（run-ci 的 SHA256SUMS 清单里）'],
    ['scrum/taskctl.mjs', '被 serve.mjs 按路径 spawn（`:153`）——不可能出现在 import 图里'],
    ['scrum/render.mjs', '同上（`:176`）'],
  ]) {
    assert.ok(a.known.has(f),
      `★ 正对照失败：${f}（${why}）根本**没有被扫描**——它所在的目录不在 SCAN_DIRS 里。` +
      '\n一个漏扫整个目录的探针，会把那个目录里的模块全报成死代码')
    assert.ok(a.entries.has(f), `★ 正对照失败：${f}（${why}）没有被算作入口`)
  }
  // 而它 import 的那个共享策略模块**必须**因此可达：这是上面那条假阳性的**具体形态**，
  // 也是唯一一条能证明"补上入口之后读数真的变了"的断言。
  assert.equal(a.reach.has('packages/shared/src/artifact-policy.mjs'), true,
    '★ `packages/shared/src/artifact-policy.mjs` 不可达——`scrum/serve.mjs` 这条入口又丢了，' +
    '它会以 `[gap] 只被自己的用例 import` 的形式出现在报告里（而它明明有两个真实消费者）')
})

// ══════════════════════════════════════════════════════════════════════════
// ② 没有未分类的不可达模块
// ══════════════════════════════════════════════════════════════════════════

test('② ★★ 每个不可达模块都必须在基线里被分类（新出现的必须有人定性）', () => {
  const classified = new Map(baseline.unreachable.map((x) => [x.file, x]))
  const unclassified = a.unreachable.filter((f) => {
    const b = classified.get(f)
    return b === undefined || b.class === 'UNCLASSIFIED'
  })
  assert.deepEqual(unclassified, [],
    `★ 有 ${unclassified.length} 个不可达模块没有被分类：\n` +
    unclassified.map((f) => `    ${f}`).join('\n') +
    '\n  不可达不等于缺陷，但**必须**有人写清它是哪一类（by-design / deliberate / gap / in-flight）。' +
    '\n  若确认是新缺口，给每条写 class 与 reason 后运行：node scripts/prt/reachability.mjs --record')
})

// ══════════════════════════════════════════════════════════════════════════
// ③ 基线不许有已被删除的文件（否则基线永远清不掉，会烂掉）
// ══════════════════════════════════════════════════════════════════════════

test('③ 基线里每一条都必须对应一个**仍然存在**的文件', () => {
  const dangling = baseline.unreachable.filter((x) => !existsSync(join(REPO, x.file)))
  assert.deepEqual(dangling.map((x) => x.file), [],
    `★ 基线里有 ${dangling.length} 条指向不存在的文件（模块被删/改名了）。` +
    '基线不清掉这些条目就会烂掉，而烂掉的基线读起来像"这些模块还在"。' +
    '\n  运行：node scripts/prt/reachability.mjs --record')
})

// ══════════════════════════════════════════════════════════════════════════
// ④ ★ 读数：本批认定的 gap 逐条仍然不可达 —— **接上了它会红**
// ══════════════════════════════════════════════════════════════════════════

test('④ ★★ 读数：四族 gap 仍然不可达（谁把它们接上，这条就红）', () => {
  // 这一条是**读数**不是缺陷清单：它把"已交付而生产里到不了"这件事钉成
  // 一个会变红的断言，所以接线的人**必然**会经过这里改一次分类。
  const READINGS = [
    // 族一：PRT-604/605/606 的三道范围检查（台账 ✅；见状态文档 §5.2）
    ['runtime/dsh-composition/path-scope.mjs', '§5.2 三道范围检查之一'],
    ['runtime/dsh-composition/execution-scope.mjs', '§5.2'],
    ['runtime/dsh-composition/external-api-scope.mjs', '§5.2'],
    // 族二：能力包这一条链（PRT-1002..1006，台账 ✅）
    ['runtime/packs/store.mjs', 'PRT-1003 安装/升级记录'],
    ['runtime/packs/builtin/software-delivery.mjs', 'PRT-1006 首个内置包'],
    ['runtime/packs/authority.mjs', 'PRT-1005'],
    ['runtime/packs/compiled-plan.mjs', 'PRT-1004'],
    // 族三：F-18 / F-19 的**执行面**一半（hub 侧已接，执行面没有路径）
    ['runtime/experience/friction.mjs', 'F-18 摩擦分没有生产调用方'],
    ['runtime/experience/graph.mjs', 'F-18 关系图'],
    ['runtime/employee/role-pack.mjs', 'F-19 岗位包'],
    // 族四：F-21 判定面 + PRT-707 死的那份实现
    ['runtime/connectors/registry.mjs', '§4.2 F-21 判定面零调用方'],
    ['product/launcher/first-run.mjs', '§5.3.1 PRT-707 死的那份'],
  ]

  const stillUnreachable = []
  const becameReachable = []
  for (const [f, why] of READINGS) {
    if (!a.known.has(f)) { becameReachable.push(`${f}（文件已不存在——${why}）`); continue }
    if (a.reach.has(f)) becameReachable.push(`${f}（${why}）`)
    else stillUnreachable.push(f)
  }

  // 逐条断言"仍不可达"，红的报告里能直接看出是哪一族被接上了。
  for (const f of stillUnreachable) {
    assert.equal(a.reach.has(f), false, `${f} 竟然可达了（内部逻辑错误）`)
  }
  assert.deepEqual(becameReachable, [],
    '★ 下面这些**已经变成可达**了——也就是说有人把它们接上了：\n' +
    becameReachable.map((x) => `    ${x}`).join('\n') +
    '\n  这是好消息。请：① 确认接线端到端真的通（不是只加了个 import）；' +
    '\n  ② 从本用例的 READINGS 里删掉对应条目；③ 更新状态文档 §5 里对应的那条裁决；' +
    '\n  ④ 运行 node scripts/prt/reachability.mjs --record 清掉基线里的过期项。')

  // ★ 反过来也要防：如果 READINGS 一条都不在了，说明这个用例已经空了。
  assert.ok(READINGS.length >= 10, `读数条目只剩 ${READINGS.length} 条，本用例形同虚设`)
})

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 基线自身的形状
// ══════════════════════════════════════════════════════════════════════════

test('⑤ 基线每一条都带 class 与 reason，且 class 在封闭词表里', () => {
  const allowed = new Set(['by-design', 'deliberate', 'gap', 'in-flight'])
  const bad = []
  for (const x of baseline.unreachable) {
    if (!allowed.has(x.class)) bad.push(`${x.file}: class=${x.class}`)
    else if (typeof x.reason !== 'string' || x.reason.trim() === '') bad.push(`${x.file}: 没有 reason`)
  }
  assert.deepEqual(bad, [],
    `★ 基线的分类不完整（class 必须是 ${[...allowed].join(' / ')}，且每条都要有 reason）：\n` +
    bad.map((b) => `    ${b}`).join('\n') +
    '\n  分类是**判断**，所以每条都要能读到"为什么"——批量套一个词等于没分类。')

  // 基线必须真的覆盖当前全部不可达项（否则 ② 会红，但这里先给出更清楚的读数）
  const nowSet = new Set(a.unreachable)
  const baseSet = new Set(baseline.unreachable.map((x) => x.file))
  const missing = [...nowSet].filter((f) => !baseSet.has(f))
  assert.deepEqual(missing, [],
    `基线缺 ${missing.length} 条（运行 --record 补）：\n${missing.map((f) => `    ${f}`).join('\n')}`)

  // 探针的音量：本套件报的是"生产模块"，用例不属于这一面
  assert.equal(a.unreachable.some(isTest), false, '不可达名单里不该出现用例文件')
  assert.ok(a.known.size > 300, `扫到的文件只有 ${a.known.size} 个，探针可能没在扫全仓`)
  assert.ok(SCAN_DIRS.includes('scripts'), 'scripts/ 必须在扫描范围内（有模块只被生产脚本 import）')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑤b ★★ 判据只看**被 git 跟踪**的模块（共享工作树上不许因别人未提交而红）
// ══════════════════════════════════════════════════════════════════════════

test('⑤b ★★ 不可达名单只含被跟踪的文件；未跟踪的另列且不参与判据', () => {
  // 本仓库有另一个 agent 进程在并发提交。若判据把"工作树里新出现的不可达模块"
  // 也算进去，别人当轮刚建、还没提交的模块会让本门禁红，于是：
  //
  //   > 一个「把别人未提交的在飞产物判成回归」的闸门，
  //   > 与一个「逼着人去查一个与自己无关的红」的闸门，是同一个东西。
  //
  // （本会话实测过同族事故：`prt-churn` 因共享工作树的瞬时状态报红，
  //   被读成回归。见状态文档 §6.1。）
  //
  // 语义与本探针自己的 `in-flight` 分类一致：**没提交就不算"已交付"**。
  assert.notEqual(a.tracked, null, 'git ls-files 读不出来——本仓库应当始终是 git 仓库')
  const untrackedInJudged = a.unreachable.filter((f) => !a.tracked.has(f))
  assert.deepEqual(untrackedInJudged, [],
    `★ 判据里混进了未跟踪文件（${untrackedInJudged.join(', ')}）：` +
    '别人当轮新建、还没提交的模块会让本门禁误红')

  // 两个集合必须互斥且并集 = 全部生产不可达
  const both = a.unreachable.filter((f) => a.untrackedUnreachable.includes(f))
  assert.deepEqual(both, [], '同一文件同时出现在判据与未跟踪列表里')

  // 未跟踪的那一列**必须被报出来**（不能静默丢掉——静默丢掉就是把探针关掉了）
  const reachableProd = a.files.filter((f) => !isTest(f) && !a.reach.has(f))
  assert.equal(a.unreachable.length + a.untrackedUnreachable.length, reachableProd.length,
    '判据 + 未跟踪 必须恰好覆盖全部不可达生产模块（不许有文件被静默漏掉）')

  // 基线里**不许**出现未跟踪文件（否则基线会随别人的工作树抖动）
  const baseFiles = new Set(baseline.unreachable.map((x) => x.file))
  const drift = a.untrackedUnreachable.filter((f) => baseFiles.has(f))
  assert.deepEqual(drift, [],
    `★ 基线里有未跟踪文件（${drift.join(', ')}）——基线必须只描述**已提交**的世界，` +
    '否则别的 agent 一提交/一改名它就漂移')

  // ★ 被 `.gitignore` 排除的**本地产物**不许进扫描面。
  //   它们在扫描面里有两个害处：进基线是永远清不掉的噪声；
  //   更坏的是本地文件 import 了谁，谁就**假**报成可达。
  //   （实测咬到过一次：`team-hub/.watch.mjs`（`.gitignore:32`）曾在基线里。）
  //
  //   ★ 注意必须把 **`a.files` 当候选传进去**：不带参数的 `ignoredFiles()` 会走
  //   `git ls-files --others --ignored`，那会把 `node_modules/`（本身也被 ignore）
  //   几万个文件全列一遍——实测直接把本套件拖到 2 分钟超时。
  const ignored = ignoredFiles(a.files)
  {
    const inScan = a.files.filter((f) => ignored.has(f))
    assert.deepEqual(inScan, [],
      `★ 扫描面里有被 gitignore 的本地产物（${inScan.join(', ')}）：` +
      '它们永远不是"已交付"，而且本地文件 import 谁就会让谁假报成可达')
    assert.equal(a.unreachable.some((f) => ignored.has(f)), false,
      '不可达名单里出现了被 ignore 的本地产物')
    // 正对照：`check-ignore` 必须真的能认出那条已知规则。
    // ★ 必须**显式**把那个路径当候选传进去——`a.files` 里已经没有它了
    //   （它已经被 `collectFiles()` 过滤掉），拿 `a.files` 去问等于
    //   "在一份已经排除干净的名单里找被排除的人"，永远找不到。
    const ctl = ignoredFiles(['team-hub/.watch.mjs', 'runtime/contracts/run.mjs'])
    assert.equal(ctl.has('team-hub/.watch.mjs'), true,
      'check-ignore 认不出 `.gitignore:32` 那条规则——本判据会静默失效')
    assert.equal(ctl.has('runtime/contracts/run.mjs'), false,
      'check-ignore 把一条**已跟踪**的源码报成了被忽略——判据过宽，会把真源码排除掉')
  }
})

// ══════════════════════════════════════════════════════════════════════════
// ⑥ ★★ `evidenceFrom:` **不是**入口声明 —— 别"顺手"把它加进去
// ══════════════════════════════════════════════════════════════════════════

test('⑥ ★★ `evidenceFrom:` 只是存在性断言，不是加载指令（加进去会假报 8 个可达）', () => {
  // 背景：探针支持两种"按字符串加载"的清单写法（`module:` / `runtimeModule:` /
  // `path:` / `entryFile:`），所以很自然会有人看到
  // `product/release/checklist.mjs` 里的
  //
  //     evidenceFrom: 'product/diagnostics/crash-report.mjs'
  //
  // 就以为"又漏了一种入口机制"，把它加进 MANIFEST_PATTERNS。
  //
  // ★ **不能加。** `evidenceFrom` 的消费者只做一件事：
  //
  //     const sourceExists = deps.sourceExists ?? ((p) => existsSync(join(REPO, p)))
  //
  // 它是"**这个文件必须存在**"的断言，不是"这个文件会被加载"。
  // 加进去会让 8 个模块**假**报成可达（实测），而每一个都是"存在但没人跑"。
  //
  //   > 一个「把它当成入口声明」的探针，
  //   > 与一个「那些模块真的被用上了」的探针，在输出上是同一个东西——
  //   > 只不过前者会把"存在"读成"在用"。
  //
  // 存在性与可达性是**两条不同的契约**，本用例把它们钉开。
  const withEvidence = new Set()
  for (const f of a.files) {
    const text = readFileSync(join(REPO, f), 'utf8')
    for (const m of text.matchAll(/evidenceFrom:\s*'([^']+\.mjs)'/g)) {
      const p = m[1].replace(/^\.\//, '')
      if (a.known.has(p)) withEvidence.add(p)
    }
  }

  // 正方向：`evidenceFrom` 指的文件确实存在（所以这条纪律不是"没数据"）
  assert.ok(withEvidence.size > 0, '没有扫到任何 evidenceFrom：这条用例失去意义')
  for (const p of withEvidence) {
    assert.equal(existsSync(join(REPO, p)), true, `${p} 被 evidenceFrom 指着却不存在`)
  }

  // ★ 反方向：它们**不在**基线里被当成入口，且仍有 8 个是不可达的。
  //   如果哪天有人把 evidenceFrom 加进 MANIFEST_PATTERNS，这些会突然变可达 ⇒ 本用例红。
  const wouldFlip = [...withEvidence].filter((f) => a.unreachable.includes(f))
  assert.ok(wouldFlip.length >= 5,
    `★ 只有 ${wouldFlip.length} 个 evidenceFrom 目标当前不可达（期望 ≥5）。\n` +
    '  要么是有人把 `evidenceFrom` 当成了入口声明（把"存在"读成了"在用"），\n' +
    '  要么是这些模块真的被接上了——两种都必须先看清再改本用例。\n' +
    `  目标：${[...withEvidence].join(', ')}`)

  // 而且证据里**不许**出现"它被 import 了"这种混淆：
  //   evidenceFrom 的每一个目标，都不该因此出现在 entries 里
  for (const p of withEvidence) {
    const why = a.entries.get(p)
    assert.equal(why === undefined || !String(why).includes('evidenceFrom'), true,
      `${p} 被当成入口了（${why}）——evidenceFrom 是存在性断言，不是加载指令`)
  }
})
