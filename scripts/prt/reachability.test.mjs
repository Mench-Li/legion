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

import { analyze, ignoredFiles, loadBaseline, REPO, SCAN_DIRS, PROCESS_ENTRIES, dirtyFiles, inFlightViolations, matrixItems, gapPointerViolations } from './reachability.mjs'

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
  //      `module` 的**文件相对**写法（`./` 开头）
  //      `entry.path` 的**仓库相对**写法
  //      两次实测都是漏了其中一种，把正在跑的进程/行报成死代码。
  // ★★ 这两行原来把形状**连真路径一起照抄**了——而 `MANIFEST_PATTERNS` 读的是
  //      源码文本、分不清注释 ⇒ **注释里的例子变成了真声明**，给它多加了一个假入口。
  //      （判据 `criteria-files-do-not-impersonate-manifests` 现在盯着这件事。）
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
// ③b ★★★ 基线的**另一个方向**：判成 gap 的模块后来被接上了 ⇒ 那一条在说谎
// ══════════════════════════════════════════════════════════════════════════

test('③b ★★★ 基线里判成 `gap` 的模块**不许已经变成可达**（否则那条记录在说谎）', () => {
  // ★★★ 这一条是 2026-09-18 第 20 轮**实测出来的洞**，不是设计时想到的。
  //
  //   上面 ② 只管一个方向（"当前不可达的，基线里必须有分类"），
  //   ③ 只管另一个（"基线里的文件必须还在"）。**两个方向都不管这一件事**：
  //   一个模块被接上了、于是离开了 `a.unreachable`，而基线里那条
  //   `class: 'gap'` 还在——它继续在报告里说"这个模块到不了生产"。
  //
  //   口径上，②③ 合起来读起来像"基线与现实一致"，而实际是**单边**的：
  //     基线 ⊆ 现实（② 保证了"不多"？不，② 只保证"现实的每一条都有分类"）。
  //     ⇒ 基线里可以**多**出条目来，而且**没有任何读数会发现**。
  //
  //   > 一个「只检查'有没有漏掉'的基线闸」，
  //   > 与一个「可以无限积累过期条目、而每一条都长得像一条读数」的基线闸，
  //   > 是同一个东西——只不过后者会让"死代码还有多少"这个数**只会涨不会跌**。
  //
  //   ★ 实测：本轮接上 PRT-606 之后，基线里有**两条**这样的过期条目——
  //     `external-api-scope.mjs`（本轮接上）与 `execution-scope.mjs`（**第 19 轮**
  //     就接上了，而它的基线条目一直留到今天）。第 19 轮那条更值得记：
  //     当时从 READINGS 里删掉了它（④ 因此红过、也按规矩补了替身），
  //     却**没有**动基线——因为**没有任何判据要求动它**。
  //
  //   ⇒ 这条用例把那个方向补上。它红的时候，正确的应对是**删掉基线里那条**
  //     （`node scripts/prt/reachability.mjs --record` 会重算），
  //     而**不是**把这条用例放宽。
  const stale = baseline.unreachable
    .filter((x) => x.class === 'gap' && a.known.has(x.file) && a.reach.has(x.file))
    .map((x) => x.file)
  assert.deepEqual(stale, [],
    `★ 基线里有 ${stale.length} 条 \`gap\` 已经**不再不可达**了——`
    + '也就是说有人把它们接上了，而那几条记录还在说"到不了生产"：\n'
    + stale.map((f) => `    ${f}`).join('\n')
    + '\n  处理：删掉基线里这几条（`node scripts/prt/reachability.mjs --record` 重算），'
    + '并更新 ④ 的 READINGS 与 `docs/MULTI-AGENT-FEATURE-STATUS.md` §5 里对应的裁决。'
    + '\n  ⚠️ **不要**把这条用例放宽成"只报 class 不是 gap 的"——'
    + '那正是"接上了而账上写着没接"这一族错误的藏身处。')
})

// ══════════════════════════════════════════════════════════════════════════
// ④ ★ 读数：本批认定的 gap 逐条仍然不可达 —— **接上了它会红**
// ══════════════════════════════════════════════════════════════════════════

test('④ ★★ 读数：四族 gap 仍然不可达（谁把它们接上，这条就红）', () => {
  // 这一条是**读数**不是缺陷清单：它把"已交付而生产里到不了"这件事钉成
  // 一个会变红的断言，所以接线的人**必然**会经过这里改一次分类。
  const READINGS = [
    // 族一：PRT-604/605/606 的三道范围检查（台账 ✅；见状态文档 §5.2）
    //
    // ★★ 2026-09-18 本条红过一次——而那次红**一半是真的、一半是我自己造的**：
    //   报告说 path-scope 与 external-api-scope **都**被接上了。
    //   · `path-scope.mjs` —— **真的接上了**（见下），故从本表删除；
    //   · `external-api-scope.mjs` —— **假的**：`scripts/prt/boundary-facts.mjs` 里的
    //     「手钉坐标表」用的键名正好是 `reachability.mjs` 的 `MANIFEST_PATTERNS`
    //     认得的那一种，于是**一张记账表被读成了清单**，把一个**零生产 importer**
    //     的模块报成"已接线"。⇒ 那个键名已改，并在 `boundary-facts` 里加了判据
    //     「我方判据文件不得冒充清单」（借用**同一份** `MANIFEST_PATTERNS`）。
    //
    //   > 一个"某处声明了这个模块会被加载"与一个"某处**提到了**这个模块的坐标"，
    //   > 在只看那个键名 + `.mjs` 的判据里是同一个东西——
    //   > 而前者是**接线**，后者是**记账**；两者的处置**相反**。
    //
    //   ★ 这次的教训之所以值得写在**这一行**上：那条假消息的形状是**好消息**，
    //   而它下面的四条指示会让人**删掉本行、更新裁决、清基线**——
    //   也就是把一个没接的模块记成接上了。**判据说谎比判据变瞎更贵。**
    //
    // ── `path-scope.mjs` 为什么可以从这里删掉（① 端到端，不是只加了个 import）──
    //   实测的调用链（不是"有人 import 了它"）：
    //     `patch-layer.mjs`（PATCH_LAYER_ROWS）加载 `plugins/pre-execute-row.mjs`
    //       → `plugins/root-row.mjs:497` 调 `scopePortFromEnv({ env })`（**真调用**）
    //       → 失败时 `throw`（**fail closed**，不按"没配"处理）
    //       → `root-row.mjs:508-514` 把 `scope.port` 传进
    //         `installEnforcementRoot({ pathScope: scope.port })`
    //       → `scope-port.mjs:169` 调 `checkPathScope({ target, scope, direction, … })`
    //   ⇒ `path-scope.mjs` 的判据在**生产装配路径上真的会跑**。
    //   ⚠️ 仍然成立的边界：**没配**范围表时 `port` 是 `null`，
    //      而 `tool-request.mjs:731` 那句 `if (pathScope === null) return undefined`
    //      ⇒ 那次缺席落到的是**放行**。所以「三道范围检查」里这一道
    //      **从"一次都不跑"变成了"配了才跑"**，不是"默认就拦"。
    // ── `execution-scope.mjs` 为什么也可以从这里删掉（第 19 轮，2026-09-18）──
    //   与 `path-scope.mjs` **同一形状的端到端链**（不是"有人 import 了它"）：
    //     `patch-layer.mjs`（PATCH_LAYER_ROWS）加载 `plugins/pre-execute-row.mjs`
    //       → `plugins/root-row.mjs` 调 `executionScopePortFromEnv({ env })`（**真调用**）
    //       → 失败时 `throw`（**fail closed**，不按"没配"处理）
    //       → `installEnforcementRoot({ executionScope: execScope.port })`
    //       → `tool-request.mjs` 的 `executionGuard(projection)`
    //       → `execution-scope-port.mjs` 调 `checkCommand` / `checkNetwork` / `checkMcp`
    //   ⇒ `execution-scope.mjs` 的三个判定器在**生产装配路径上真的会跑**。
    //   ⚠️ 同一条边界照旧成立：**没配**授权表时 `port` 是 `null`，
    //      而 `executionGuard` 那句 `if (executionScope === null) return undefined`
    //      ⇒ 那次缺席落到的是**放行**。所以它也是**从"一次都不跑"变成"配了才跑"**。
    //   ★★ 而**本表这一格最初是红的**——红得对，且那条红**本身就是本轮的验收**：
    //      它是 2026-09-18 设计的"谁把这道接上，这条就红，于是接线的人**必然**
    //      会经过这里改一次分类"。⇒ 改动落在**两处**：本表删一行，以及
    //      `docs/MULTI-AGENT-FEATURE-STATUS.md` §5.2 的读数。
    //   *** 一条只在代码里变、账上不动的接线，会让下一个人照着旧账做判断。 ***
    // ── `external-api-scope.mjs` 为什么也可以从这里删掉（第 20 轮，2026-09-18）──
    //   ★★★ 与上面两条**同一形状的端到端链**，而且这一次的红是**预料之中的好消息**：
    //     `patch-layer.mjs`（PATCH_LAYER_ROWS）加载 `plugins/pre-execute-row.mjs`
    //       → `plugins/root-row.mjs` 调 `externalApiScopePortFromEnv({ env })`（**真调用**）
    //       → 失败时 `throw`（**fail closed**，不按"没配"处理）
    //       → `installEnforcementRoot({ externalApiScope: apiScope.port })`
    //       → `tool-request.mjs` 的 `externalApiGuard(projection)`
    //       → `external-api-scope-port.mjs` 的适配器
    //       → `external-api-scope.mjs` 的 `checkExternalApi`
    //   ⇒ `external-api-scope.mjs` 的 24 例判据在**生产装配路径上真的会跑**。
    //   ⚠️ 同一条边界第三次成立：**没配**授权表时 `port` 是 `null`，
    //      而 `externalApiGuard` 那句 `if (externalApiScope === null) return undefined`
    //      ⇒ 缺席落到**放行**。三道范围检查至此**全都**是"配了才跑"。
    //
    //   ★★ 这一条**第四次**证明了这张表的设计是对的：它上一轮的注释里逐字写着
    //      "谁把这道接上，这条就红，于是接线的人**必然**会经过这里改一次分类"。
    //      第 20 轮就是这样——我接上 PRT-606 之后，本条立刻报出
    //      `external-api-scope.mjs（§5.2）` 已变成可达。**判据不需要被记得。**
    //
    //   ★★★ 而它紧接着**又红了一次**，红的是下面那条 `READINGS.length >= 10`：
    //      删掉这一行之后只剩 9 条。**正确应对不是把阈值改小**——
    //      "把门槛降到刚好够"与"这一层本来就没在查什么"，在绿色的摘要里长得一样。
    //      ⇒ 去问"还有没有同样真实、同样今天不可达的成员"，而不是动那个数。
    //      有（见下面族六）——而且它比这里删掉的那一条**更值钱**：
    //      它记的是一个"消费侧接了、服务端没有挂点"的**断链**。
    //
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
    //
    // ★★ 2026-09-18：`runtime/connectors/registry.mjs` **已从这张表里删掉**——
    //    本批建了 F-21 的**第二半（反馈面）**（`runtime/connectors/outcome-port.mjs`
    //    ＋ `runtime/dsh-composition/plugins/connector-feedback.mjs`），
    //    由 `assemble.mjs` 在拿到连接器声明时**一次装齐两半**，
    //    于是它有了生产 importer，探针读数 47/26 → **46/25**。
    //
    //    ⚠️ **但上面那条"确认接线端到端真的通（不是只加了个 import）"没通过**，
    //    而且这一点必须写在这里，不能只写"已接线"：
    //    `createRegistry()` 在 `assembleEnforcement` 里是**条件调用**，
    //    而**今天没有任何生产路径**给 `connectorDeclarations`
    //    （来源是 §5 第 19 条那个部署配置键，`product/execution-plane-config.mjs`
    //    仍是零生产导入方）。
    //
    //      > 精确读数是：**从"没人 import"变成了"被 import、但那个函数从不被调用"。**
    //      > 一个"模块可达"的读数，与一个"这条链真的跑了"的读数，
    //      > 在只看探针汇总的时候是同一个东西——只不过前者会让一格归零。
    //
    //    ⇒ 所以这一条**不是**"F-21 接好了"，而是"这个模块不再零 import 了"。
    //    剩下的并进第 19 条。详见 `PRT-SESSION-REPORT-2026-09-17.md` §10.43。
    ['product/launcher/first-run.mjs', '§5.3.1 PRT-707 死的那份'],
    // 族五（第 19 轮补入）：**执行面那几份数据的投递读取器**。
    //
    //   ★ 为什么把它补进来：本轮把 `execution-scope.mjs` 从本表删掉之后
    //     `READINGS.length` 掉到 9，下面那条 `>= 10` 当场红了。
    //     那条红是**对的**——它问的是"本用例是不是正在被一点点掏空"。
    //     而正确的应对**不是**把阈值改小（那正是掏空的读法），
    //     是去问"这一族里还有没有同样真实、同样没人接的成员"——有，而且不止一个。
    //
    //   `product/execution-plane-config.mjs`：`readExecutionPlaneConfig` 的
    //   生产导入方**零处**。这不是我猜的——`root-row.mjs` 自己那段注释
    //   （连接器声明那一步）逐字写着"declarations 从哪来是第 14 条那个决定
    //   （`product/execution-plane-config.mjs` 今天零生产导入方）"。
    //
    //   它与本轮的三道范围表是**同一族**：*一个"读取器写好了、而没有任何生产
    //   调用方"的模块，与一个"这份配置根本不存在"的模块，在"范围表配了没有"
    //   这个问题上给出同一个答案：没配。* 差别只在前者的账上写着"已交付"。
    //
    //   ⇒ 归属第 19 条（执行面数据的投递：放进 `RunRequest`，已裁决、待施工）；
    //     与 §5.2 的三道范围检查是同一个决定的不同面。
    ['product/execution-plane-config.mjs', '§5 第 19 条 / §5.2（执行面数据投递，已裁决待施工）'],
    // 族六（第 20 轮补入）：**消费侧接了、服务端没有挂点**的断链。
    //
    //   ★ 为什么补它：上面族一删掉 `external-api-scope.mjs` 之后本表掉到 9 条，
    //     `>= 10` 当场红了。那条红问的是"这一层是不是正在被掏空"，
    //     而正确的应对是去找这一族里**还有没有**同样真实、同样没人接的成员。
    //
    //   `runtime/dsh-composition/runtime-contract-server.mjs` 的形态与族五**同形**，
    //   但比它更尖锐——族五是"读取器写好了、没有调用方"，这一条是：
    //     **消费侧已经接线，而服务端没有生产挂点。**
    //     `product/launcher/runtime-contract-endpoint.mjs` 会读回那份发布并注入
    //     `LEGION_RUNTIME_URL` / `LEGION_RUNTIME_TOKEN`——也就是说**有人已经在等它了**；
    //     而唯一的 import 者 `plugins/runtime-contract-server-row.mjs` 自己也不可达
    //     （它的挂载需要组合根那一行）。
    //
    //   > 一个「消费侧写好了、服务端没挂」的部署，
    //   > 与一个「这个部署没有 Runtime 契约服务」的部署，
    //   > 在"那份发布到底有没有被提供"这个问题上给出同一个答案：没有。
    //   > 差别只在前者的账上写着"已交付"。
    //
    //   ⇒ 归属 §5 第 20 条（与 registrar row / run-floor 同一条断链的三个环节）；
    //     基线里它已被判为 `gap` 而不是 `in-flight`（那几个文件早已提交、
    //     而模块仍不可达 ⇒ "正在接线"的前提过期了）。
    ['runtime/dsh-composition/runtime-contract-server.mjs', '§5 第 20 条（Runtime 契约服务端没有生产挂点）'],
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

// ══════════════════════════════════════════════════════════════════════════
// ⑦ ★★★ `in-flight` 是**带到期日**的断言：文件提交了却仍标 in-flight ⇒ 红
// ══════════════════════════════════════════════════════════════════════════

test('⑦ ★★★ in-flight 只在文件**确实还有未提交改动**时成立（否则必须改判 gap）', () => {
  // ## 这条规则是被一次真实的过期标签逼出来的
  //
  // 2026-09-18：4 条 `in-flight` 条目（`runtime-contract-server-row.mjs` /
  // `runtime-host-registrar-row.mjs` / `run-floor.mjs` / `runtime-contract-server.mjs`）
  // 的文件在 `e0b83af` / `69da8fd` / `5c1d698` 里**已经提交**，而模块**仍然不可达**。
  // 于是基线在说"另一个 agent 正在接线"，而事实是"那条线接不上、并且正等人裁决"。
  //
  //   > 一个把"已经停工"写成"正在进行"的标签，比一个写错的标签更坏：
  //   > 它会让人**不去催**——而这一条本来正等人裁决。
  //
  // ★ 而这条规则**不能**只对着当前基线断言。本批把 in-flight 清成了 0 条，
  //   于是"逐条检查 in-flight"是一句空话——一个什么都不检查的用例
  //   与一个检查通过了的用例，在输出上是同一个东西。
  //   所以先用**人造条目**证明这条规则真的会红，再拿它去查真实基线。

  // ── 正对照：规则函数本身必须有牙齿 ─────────────────────────────────
  const FIXTURE = [
    { file: 'a.mjs', class: 'in-flight' },
    { file: 'b.mjs', class: 'gap' },
    { file: 'c.mjs', class: 'in-flight' },
  ]
  // ① 两个 in-flight 文件都干净 ⇒ 两条都要被报出来（红）
  assert.deepEqual(inFlightViolations(FIXTURE, new Set()), ['a.mjs', 'c.mjs'],
    '规则没有报出"干净却仍标 in-flight"的条目——这条用例无论查什么都恒绿')
  // ② 只有一个干净 ⇒ 只报那一个（不是"要么全报要么不报"）
  assert.deepEqual(inFlightViolations(FIXTURE, new Set(['a.mjs'])), ['c.mjs'],
    '规则不能逐条分辨：它把干净的与脏的一起放过或一起报，等于没有判据')
  // ③ 两个都脏 ⇒ 一条都不报。★ 这一条防的是**过严**：
  //    真有人接线时判红，就是惩罚正在接线的人（本探针文件头明令禁止那一类）
  assert.deepEqual(inFlightViolations(FIXTURE, new Set(['a.mjs', 'c.mjs'])), [],
    '规则在"确实有人未提交地接线"时也报红——那会惩罚正在接线的人')
  // ④ `gap` 不受本规则管辖（它是另一个判据的事）
  assert.equal(inFlightViolations(FIXTURE, new Set()).includes('b.mjs'), false)

  // ── 读数：真实基线 ────────────────────────────────────────────────
  const dirty = dirtyFiles()
  assert.notEqual(dirty, null,
    '`git status --porcelain` 读不出来——本仓库应当始终是 git 仓库。读不出来时从严，不许跳过')
  const violations = inFlightViolations(baseline.unreachable, dirty)
  assert.deepEqual(violations, [],
    `★ 基线里有 ${violations.length} 条 in-flight 的文件**已经干净了**（改动已提交或已还原）：\n` +
    violations.map((f) => `    ${f}`).join('\n') +
    '\n  `in-flight` 的判据是「另一个 agent 当轮正在接线（工作树未提交）」。' +
    '\n  文件已提交而模块仍不可达 ⇒ 前提过期，它**不是"正在接"，是"接不上"**。' +
    '\n  请改判为 `gap` 并把真实阻塞原因写进 reason（这一条通常正等人裁决）。' +
    '\n  改完运行：node scripts/prt/reachability.mjs --diff 复核。')

  // ★ 本仓真的有过未提交改动时，`dirtyFiles()` 必须非空——
  //   否则上面的检查是在"空集上检查"，那与不检查同形。
  //   （本仓有另一个 agent 进程在并发提交，所以改动几乎总是存在；
  //     真出现全干净的工作树时这条会红，那时要人来确认这是不是正常状态。）
  assert.ok(dirty.size > 0,
    '`git status --porcelain` 一条改动都没有——要么工作树真的全干净（罕见），' +
    '要么这个读数坏了。无论哪种，上面的"逐条检查"都失去了意义，需要人看一眼')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑧ ★★★ 每一条 `gap` 都必须写出**能解析的裁决处指针**（§5 第 N 条）
// ══════════════════════════════════════════════════════════════════════════

test('⑧ ★★★ gap 必须指向一个**真实存在**的 §5 条号（治"没人会裁决它"）', () => {
  // ## 这条判据的由来（本仓实测过一次）
  //
  // `gap` 的 class 定义逐字是「真的没有生产路径，且台账/对照表说它已交付
  // **⇒ 需要在 §5 里裁决**」。所以一条 `gap` 的 reason 必须回答一个反问：
  //
  //   > 那么，**谁**在**哪一条**上裁决它？
  //
  // 2026-09-18 发现：`runtime-contract-server-row.mjs` 那一族被标着 `in-flight`
  // ——正确动作那一格写的是一个字「**等**」——而真实内容是"接不上、要人裁决"，
  // 且**不在** §5 的清单上。于是没有任何一处会被人读到，藏了三天。
  //
  // ⑦ 号用例治的是"标签过期"；本用例治的是另一半：
  // **标签正确、而这条缺口没有任何人在看**。
  //
  // ## 两种违反，都要能红
  //
  //   · 没有具体指针（只说"§5 裁决"不算——那没告诉人去**哪一条**）
  //   · 指针指向一个**不存在**的条号（表改了、指针没跟着改）
  //
  // 后者是指针**腐烂**：一个指向不存在条号的引用，与没有引用，
  // 对读的人是同一个结果——只不过前者看起来像已经归档过了。

  const items = matrixItems()
  // ★ 先钉住解析器本身：认不出条号的解析器会让下面的检查在空集上通过。
  assert.ok(items.size >= 20,
    `§5 里只解析出 ${items.size} 个条号（期望 ≥20）。` +
    '要么是清单被挪走了，要么是 `matrixItems()` 的位置规则失效了（标题不再是 `## 5. `？）。' +
    '解析不出条号时，"指针能解析"这句检查会**恒真**，等于没有这条用例')
  // ★ 反向：解析器**不许**把 §5 之前那张优先级表（1..5）当成 §5 的条号。
  //   本仓的教训：一个"会解析成功但指错地方"的判据比一个解析失败的判据更坏。
  //   两张表条号重叠，所以这里用**位置**性质验证：清单必须能解析出 20（只有它有 20）。
  assert.equal(items.has(20), true,
    '§5 里没有第 20 条——本判据的锚点没了。若清单被重排过，先确认本用例的取法')

  // ── 正对照：规则函数必须有牙齿（三种情形各一次）────────────────────
  const FIX = [
    { file: 'g1.mjs', class: 'gap', reason: '只说了 "§5 裁决"，没写第几条' },
    { file: 'g2.mjs', class: 'gap', reason: 'xxx ⇒ 裁决处：§5 第 999 条' },
    { file: 'g3.mjs', class: 'gap', reason: 'xxx ⇒ 裁决处：§5 第 20 条' },
    { file: 'g4.mjs', class: 'by-design', reason: 'by-design 不受本判据管辖' },
  ]
  const fv = gapPointerViolations(FIX, new Set([20]))
  // ① 没有具体指针 ⇒ missing
  assert.deepEqual(fv.missing, ['g1.mjs'],
    '规则没有报出"reason 里没有具体第几条"的 gap——这条用例无论查什么都恒绿')
  // ② 指向不存在的条号 ⇒ dangling（**不是** missing：两种违反分开报）
  assert.deepEqual(fv.dangling, [{ file: 'g2.mjs', item: 999 }],
    '规则没有报出"指针指向不存在的条号"——指针腐烂会一直烂下去')
  // ③ 指向真实条号 ⇒ 放过
  assert.equal(fv.missing.includes('g3.mjs') || fv.dangling.some((d) => d.file === 'g3.mjs'), false,
    '规则把一条**合法**的指针判红了——那会让人不敢写指针')
  // ④ 别的 class 不受管辖
  assert.equal(fv.missing.includes('g4.mjs'), false, 'by-design 也被要求写 §5 指针了')

  // ── 读数：真实基线 ────────────────────────────────────────────────
  const real = gapPointerViolations(baseline.unreachable, items)
  assert.deepEqual(real.missing, [],
    `★ 有 ${real.missing.length} 条 gap 没写出裁决处指针：\n` +
    real.missing.map((f) => `    ${f}`).join('\n') +
    '\n  `gap` 的定义就是"需要在 §5 里裁决"。写不出指针 ⇒ 它和"永远不会被裁决"是同一种东西。' +
    '\n  请在 reason 末尾补上：⇒ 裁决处：§5 第 N 条（N 必须是 §5 清单里真实存在的条号）。')
  assert.deepEqual(real.dangling, [],
    `★ 有 ${real.dangling.length} 条 gap 的指针指向不存在的条号：\n` +
    real.dangling.map((d) => `    ${d.file} → §5 第 ${d.item} 条`).join('\n') +
    '\n  这就是指针腐烂：§5 的清单改了（重排/删条），而引用没跟着改。' +
    '\n  一个指向不存在条号的引用，与没有引用，对读的人是同一个结果——' +
    '\n  只不过前者看起来像已经归档过了。')
})
