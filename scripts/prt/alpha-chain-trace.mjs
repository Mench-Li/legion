// scripts/prt/alpha-chain-trace.mjs
// ============================================================================
// 目标文档 §9「商业 Alpha 完成标准」那条链，**逐节**投影到真实接线状态上。
//
// ---------------------------------------------------------------------------
// ★ 为什么要有这个文件
//
// 目标文档 §9 把"做完了"写成了一条链：
//
//     安装/配置 → Launcher 启动 Runtime → 创建空间与 TeamPlan
//     → 认领 Task / 生成 Snapshot → DshRuntimeAdapter 执行 Run
//     → 工具审批与 hard floor → 产物验收/交接/审计/用量
//     → Runtime 崩溃可恢复 → 升级失败可回滚且业务数据不丢失
//
// 而"还剩什么没做"在本仓散落在**四个**地方：台账 145 行（"任务完没完成"）、
// §5 的 29 条裁决项（"哪些要人回答"）、46 项不可达（"哪块代码没人挂"）、
// 以及 §5.1～§5.15 各节的散文。**没有一处回答"这条链断在哪一节"。**
//
// 于是同样的问题每次都要重新读一遍四个地方——而读者会停在最先读懂的那一个上。
//
//   > 一份"还剩 5 项"的台账，与一份"这条链断在第 5 节"的投影，
//   > 对"下一步该做什么"给出的答案不是同一个东西。
//
// ---------------------------------------------------------------------------
// ★ 它断言什么、不断言什么（这条边界必须写在最前面）
//
// **断言**：链上的每一节，它点名的模块**都还在**（文件名改动会红），
//   且每一节至少有一个模块**从真实入口走得到**——否则那一节**没有活着的实现**。
//
// **不断言**：链路**端到端跑通**。一个模块可达只说明"有人 import 它"，
//   不说明"配起来能work"。真正的端到端验证需要真进程、真凭据、真模型
//   ——那正是台账里 4 条 ⏸ 与 1 条 ⬜ 在等的东西。
//   ⇒ 所以本工具的结论用词是"**这一节有活实现 / 这一节没有任何活实现**"，
//     而**不是**"这一节能用"。两者在只看绿灯时长得一样。
// ============================================================================
// ============================================================================
// ★ 为什么每一节要分「核心」与「支撑」
//
// 第一版把"这一节有活实现"定义成"至少一个模块可达"——**那个判据太弱**：
// 九节全部通过，而它对"这条链断在哪一节"一个字都没说。九节里每一节都至少
// 有一个可达模块，因为每一节都有一半早就接好了。
//
//   > 一个"九节全绿"的读数，与一个"每一节都有一半接好了"的读数，
//   > 在只看那九行 ✔ 的时候是同一个东西。
//
// 所以每一节要显式写下：**哪几个模块是这一节的"核心"**（缺了它这一节就不成立），
// 以及**为什么**。核心缺席 ⇒ 硬断；支撑缺席 ⇒ 软缺口（这一节还能跑，但少一块）。
//
// ★ 这个分类是**人写的、可审计的**，不是正则猜的。每一条 `coreWhy` 都要能指着代码说清。
// ============================================================================
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REPO, BASELINE_PATH, MATRIX_PATH } from './reachability.mjs'
// ★ 转手 §5 正文的区间规则与裁决表解析器——**不重写**。
//   两份各写一遍、然后漂移到"一个说从 `## 5.` 起、另一个说从 `## 5 ` 起"，
//   是本仓见过的失效形状（`intervention-coverage.mjs` 的文件头记着这条）。
import { sectionFive, decisionItemNumbers } from './intervention-coverage.mjs'

export { REPO }

/** §9 那条链（逐字取目标文档 §9 的九个箭头段）。 */
export const ALPHA_CHAIN = Object.freeze([
  Object.freeze({
    id: 'L1',
    title: '安装/配置',
    modules: Object.freeze([
      'product/launcher/cli.mjs',
      'product/init.mjs',
      'product/config-schema.mjs',
    ]),
    core: Object.freeze(['product/launcher/cli.mjs']),
    coreWhy: '`cli.mjs` 是产品层唯一的进程入口（`install`/`configure` 两个子命令都在它里面）。',
  }),
  Object.freeze({
    id: 'L2',
    title: 'Launcher 启动 Runtime',
    modules: Object.freeze([
      'product/launcher/launcher.mjs',
      'product/launcher/supervisor.mjs',
      'product/process-manifest.mjs',
      'product/launcher/readiness.mjs',
    ]),
    core: Object.freeze(['product/launcher/launcher.mjs', 'product/process-manifest.mjs']),
    coreWhy: '`launcher.mjs` 是唯一的启动装配点；`process-manifest.mjs` 是"哪些进程、什么 argv、'
      + '什么环境"的唯一来源——它同时是第 0 条那 5 把键卡住的地方。',
  }),
  Object.freeze({
    id: 'L3',
    title: '创建空间与 TeamPlan',
    modules: Object.freeze(['team-hub/server.mjs']),
    core: Object.freeze(['team-hub/server.mjs']),
    coreWhy: 'team-hub 是任务/空间/TeamPlan 的**唯一事实源**（目标文档 §1 明写），它的 HTTP 面就是这一节。',
  }),
  Object.freeze({
    id: 'L4',
    title: '认领 Task / 生成 Snapshot',
    modules: Object.freeze([
      'orchestrator/worker/main.mjs',
      'orchestrator/worker/context-stage.mjs',
    ]),
    core: Object.freeze(['orchestrator/worker/main.mjs', 'orchestrator/worker/context-stage.mjs']),
    coreWhy: '`main.mjs` 是认领循环，`context-stage.mjs` 是 Snapshot 组装——这一节的两半。',
  }),
  Object.freeze({
    id: 'L5',
    title: 'DshRuntimeAdapter 执行 Run',
    modules: Object.freeze([
      'runtime/adapters/dsh/index.mjs',
      'orchestrator/worker/executor.mjs',
      // ★ 跨进程那一截：worker 与 DSH Runtime 是**两个进程**，
      //   所以 `bindDshRuntime()`（同进程注册口）填多好都改变不了 worker 的读数
      //   （`runtime-contract-server-row.mjs:9-10` 自己写着这句）。
      //   这一节的"活实现"因此**取决于**下面这三个文件挂着没有。
      'runtime/dsh-composition/plugins/runtime-contract-server-row.mjs',
      'runtime/dsh-composition/runtime-contract-server.mjs',
      'runtime/dsh-composition/plugins/runtime-host-row.mjs',
    ]),
    core: Object.freeze(['runtime/dsh-composition/plugins/runtime-contract-server-row.mjs']),
    coreWhy: 'worker（`product/orchestrator/worker.mjs`）与 DSH Runtime 是**两个进程**，'
      + '所以同进程的 `bindDshRuntime()` **填多好都不会改变 worker 的读数**'
      + '（`runtime-contract-server-row.mjs:9-10` 逐字写着这句）。'
      + '这一行就是那条缝上唯一的监听器 ⇒ 不挂 = worker 报 `EXECUTOR_HOST_PORT_REQUIRED`、'
      + '**不认领任何任务**（`同文件:24`）。',
    // ★★ 断点归属：**已删**（第 44 轮，随 §5 第 20 条结清）。
    //
    // 这里曾写 `owner: 20` —— 因为当时这一节的**核心模块没人挂**，
    // 是 §9 九节链上**唯一的硬断**。
    //
    // `2f5a4b3`（§5 第 20 条 · 甲）把那一行挂进了补丁层并实测了三条降级路径，
    // 于是本探针的读数变成：L5 **全部模块可达**、`最先硬断的一节：（没有）`。
    // 而 `owner-stale` 那条判据随即报：
    //
    //     L5 今天**没有断点**，却还写着归属第 20 条 ⇒ 这一节已经通了，那个指针该删
    //
    //   > 一个"有人认领的断点"，与一个"已经通了的断点"，
    //   > 在**只读那一行归属**的时候是同一个东西——
    //   > 只不过前者还算有人在看，后者是**指针指着一个不存在的问题**。
    //
    // ⇒ 按它说的删掉。归属是给**断点**写的，不是给节写的；
    //   这一节通了，就不该再挂着那个指针（那会让"谁在看"这件事看起来还在进行）。
  }),
  Object.freeze({
    id: 'L6',
    title: '工具审批与 hard floor',
    modules: Object.freeze([
      'runtime/dsh-composition/plugins/hard-floor.mjs',
      'runtime/dsh-composition/plugins/pre-execute.mjs',
      'runtime/dsh-composition/plugins/approval-answerer.mjs',
      'runtime/dsh-composition/approval-policy.mjs',
      'team-hub/approval-ttl.mjs',
    ]),
    core: Object.freeze([
      'runtime/dsh-composition/plugins/hard-floor.mjs',
      'runtime/dsh-composition/plugins/pre-execute.mjs',
      'runtime/dsh-composition/plugins/approval-answerer.mjs',
    ]),
    coreWhy: '这三条是 spec §6.6 的三个强制点（guard / pre-execute / approval），'
      + '目标文档 §6 的 P0 退出条件是「hard floor 不可绕过」。',
  }),
  Object.freeze({
    id: 'L7',
    title: '产物验收/交接/审计/用量',
    modules: Object.freeze([
      'orchestrator/acceptance/index.mjs',
      'runtime/toolcall/spool.mjs',
      'orchestrator/worker/toolcall-drain.mjs',
    ]),
    core: Object.freeze(['orchestrator/acceptance/index.mjs']),
    coreWhy: '验收是这一节的名字。★ `spool`/`toolcall-drain` 是**支撑**：'
      + '它们管的是「一次工具调用在哪一层落账」那条车道（§5 第 28 条），'
      + '缺了它 Run 照跑，缺的是**审计的完整性**——两者不该用同一个词报。'
      + '★★ 第 118 轮第七轮：这两条已由 hub 的**收账 tick**接上'
      + '（`team-hub/toolcall-sweep.mjs`；端到端实测过：真 hub 进程 + 真 `LEGION_DATA_DIR`'
      + ' ⇒ spool 文件真的被收进 `tool_calls`），于是这一节在**模块可达性**上转 ✔，'
      + '`owner: 28` 随之被 `owner-stale` 判掉（第 28 条已由业主授权本会话定：'
      + '丙的机制 + 目录锚在既有配置量上）。'
      + '⚠️ **但它没有全好**：车道的**写入侧**（执行面按 Run 调 `appendSpoolRecord`）'
      + '今天仍然没有调用点 ⇒ 生产里 `tool_calls` 还是不会被写。'
      + '那是**调用点**缺口，而可达性**按构造看不见**它 —— 模块可达 ≠ 有人调那个函数。'
      + '⇒ 这一节的 ✔ 读作"**有活实现**"，**不**读作"审计完整性已达成"。'
      + '残余施工项记在 `docs/superpowers/prt/PRT-TAKEOVER-QUEUE-2026-09-23.md` 的 P1-1。',
  }),
  Object.freeze({
    id: 'L8',
    title: 'Runtime 崩溃可恢复',
    modules: Object.freeze([
      'orchestrator/state-machine/index.mjs',
      'orchestrator/state-machine/failure.mjs',
      'runtime/adapters/dsh/index.mjs',
    ]),
    core: Object.freeze(['orchestrator/state-machine/index.mjs', 'runtime/adapters/dsh/index.mjs']),
    coreWhy: '状态机是恢复的判据来源；`recover()` 在 adapter 里（目标文档 F-01/F-06：'
      + '`recover()` 只返回判断，不直接改 Task）。',
  }),
  Object.freeze({
    id: 'L9',
    title: '升级失败可回滚且业务数据不丢失',
    modules: Object.freeze([
      'product/upgrade/switchover.mjs',
      'product/upgrade/migration.mjs',
      'product/lifecycle/retention.mjs',
    ]),
    core: Object.freeze(['product/upgrade/switchover.mjs', 'product/upgrade/migration.mjs']),
    coreWhy: '切换与迁移是"回滚"这一节的两半（两者都属 `deliberate` 不可达——'
      + '它们由 CLI 按路径调用，不由模块 import）。'
      + '★ `retention.mjs` 是**支撑**：它是生命周期产品动作（§5 第 16 条），'
      + '不是"回滚"本身。',
    owner: 16,
    ownerWhy: '第 16 条把这一批模块列成"**全部自带用例、全部 ✅、全部零生产入口**"，'
      + '其中「保留策略」就是 `product/lifecycle/retention.mjs`。'
      + '★ 注意 §5 用**中文名**（保留策略）指它，不用文件名——'
      + '所以归属必须是**声明**的，不能靠正则去散文里找文件名（见 `checkOwners` 的说明）。',
  }),
])

/**
 * 读可达性基线：文件 → `{class, reason}`。
 *
 * ★ 用**基线**而不是现算：基线的每一条都带 `class` 与 `reason`
 *   （那是有人判过的），而现算只能给出"可达/不可达"这个二值。
 *   "不可达"与"不可达且**没人打算接**"不是同一个东西。
 */
export function loadClassMap(path = BASELINE_PATH) {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const map = new Map()
  for (const e of raw.unreachable ?? []) {
    const f = e.file ?? e.path
    if (f !== undefined) map.set(String(f).replace(/\\/g, '/'), { cls: e.class ?? e.cls ?? '?', reason: e.reason ?? '' })
  }
  return map
}

/**
 * 逐节核对。
 *
 * @param {{classMap?: Map, exists?: (p: string) => boolean}} [opts]
 */
export function traceChain({ classMap = loadClassMap(), exists = (p) => existsSync(join(REPO, p)) } = {}) {
  const sections = ALPHA_CHAIN.map((s) => {
    const coreSet = new Set(s.core)
    const mods = s.modules.map((m) => {
      const present = exists(m)
      const cls = classMap.get(m)?.cls ?? null
      // 坏 = 文件不在，或"不可达且没人打算接"
      const bad = !present || cls === 'gap'
      return {
        module: m,
        present,
        unreachableClass: cls,
        reason: classMap.get(m)?.reason ?? '',
        core: coreSet.has(m),
        bad,
      }
    })
    const brokenCore = mods.filter((m) => m.core && m.bad)
    const brokenSupport = mods.filter((m) => !m.core && m.bad)
    return {
      ...s,
      modules: mods,
      brokenCore,
      brokenSupport,
      // 硬断 = 核心模块缺席；软缺口 = 只有支撑模块缺席
      hardBroken: brokenCore.length > 0,
      softGap: brokenCore.length === 0 && brokenSupport.length > 0,
    }
  })
  const firstHardBreak = sections.find((s) => s.hardBroken) ?? null
  const softGaps = sections.filter((s) => s.softGap)
  // ★ "九节全绿"必须是**算出来**的，而不是"没有硬断就算全绿"
  const allGreen = sections.every((s) => !s.hardBroken && !s.softGap)
  return { sections, firstHardBreak, softGaps, allGreen }
}

// ============================================================================
// ★★★ 第二格（第 34 轮）：链上的**每一个断点都必须有人认领**
//
// ---------------------------------------------------------------------------
// ## 它补的是哪一格
//
// §5 回答"哪些要人回答"，链投影回答"断在哪一节"。而**两者之间没有任何东西交叉核对**——
// 于是这条形状可以长期存在：**链上一个断点，而 §5 里没有任何一条在管它**。
// 它的处境与 `intervention-coverage` 治的那种完全一样，只是**高了一层**：
//
//   > 一个"谁也没在看"的断链，与一个"已经排上日程"的断链，
//   > 在只看那条链的投影时是同一个东西。
//
// ## ★★ 为什么归属必须是**声明的**，不能靠正则去散文里找文件名
//
// 第一版探针（`scratch/_probe-break-owners.mjs`）就是在 §5 每一格里搜文件名，
// 结果它报出 `product/lifecycle/retention.mjs` **"没有归属"**——**错的**：
// 第 16 条管着它，只是 §5 用的是**中文名**「保留策略」。
//
//   > 一个靠"文件名在不在散文里"判定的归属，
//   > 与一个靠"§5 里那个词恰好是中文还是英文"判定的归属，是同一个东西——
//   > 只不过前者会输出一个数字。
//
// 这正是本仓反复记过的那条：**闭集词表**是必需的，而"散文里找词"不是判据。
// ⇒ 归属写成 **§5 的条目编号**（唯一的、机器可核的最小单位），
//   与 `NOT_FORWARDED_YET` ↔ `ASSEMBLY_ANCHORS` 是同一种记账法：
//   一个**声明出来的指针**，由判据去核它**解得开**。
//
// ## 三条规则
//
//   ① `断点无归属` —— 有断点却没有 `owner` 的那一节，红。
//   ② `归属指到空处` —— `owner` 不是一个**存在**的 §5 条目号，红。
//   ③ `归属已过期` —— 没有断点、却还写着 `owner`，红（与 `NOT_FORWARDED_YET`
//      的 stale 那条同形：`ASSEMBLY_ANCHORS` 里留着一个已经放行的键）。
// ============================================================================

/** §5 裁决表里**存在**的条目号。 */
export function sectionFiveItemNumbers(path = MATRIX_PATH) {
  const { found, numbers } = decisionItemNumbers(sectionFive(path))
  return found ? new Set(numbers) : null
}

/**
 * 核对链上每个断点的归属。
 *
 * @param {{sections: Array, itemNumbers: Set|null}} input
 */
export function checkOwners({ sections, itemNumbers }) {
  const violations = []
  if (itemNumbers === null) {
    violations.push({
      id: 'decision-table-missing',
      message: '§5 的裁决表解析不出来 ⇒ 归属无法核对（这条判据**什么都没查**）。',
    })
    return { ok: false, violations }
  }
  for (const s of sections) {
    const hasBreak = s.hardBroken || s.softGap
    const declared = s.owner
    if (hasBreak && declared === undefined) {
      violations.push({
        id: 'break-without-owner',
        message: `${s.id}「${s.title}」有断点（${s.hardBroken ? '硬断' : '软缺口'}：`
          + `${[...s.brokenCore, ...s.brokenSupport].map((m) => m.module).join('、')}），`
          + '而它**没有声明归属** ⇒ 这个断点**没有任何人在等它**。'
          + '要么在 §5 里给它立一条，要么把 `owner` 指到已经管它的那一条。',
      })
      continue
    }
    if (hasBreak && !Number.isInteger(declared)) {
      violations.push({
        id: 'owner-not-an-item-number',
        message: `${s.id} 的 \`owner\` 是 ${JSON.stringify(declared)}——`
          + '它必须是 §5 的**条目编号**（整数），不是一个文件路径或一句散文。',
      })
      continue
    }
    if (hasBreak && !itemNumbers.has(declared)) {
      violations.push({
        id: 'owner-item-missing',
        message: `${s.id} 的归属写着 §5 第 **${declared}** 条，而那张表里没有这一条 ⇒ `
          + '指针指到空处。' + (s.ownerWhy === undefined ? '（它也没写"为什么是这一条"）' : ''),
      })
      continue
    }
    if (hasBreak && (typeof s.ownerWhy !== 'string' || s.ownerWhy.length < 20)) {
      violations.push({
        id: 'owner-why-missing',
        message: `${s.id} 声明了归属却没写清**为什么是那一条**——`
          + '没有理由的归属标记，与"我随手指了一条"是同一个东西。',
      })
    }
    if (!hasBreak && declared !== undefined) {
      violations.push({
        id: 'owner-stale',
        message: `${s.id} 今天**没有断点**，却还写着归属第 ${declared} 条 ⇒ `
          + '这一节已经通了，那个指针该删（与 `NOT_FORWARDED_YET` 的 stale 同形）。',
      })
    }
  }
  return { ok: violations.length === 0, violations }
}

/** 从磁盘按真实仓库核对（链 + §5 一起读）。 */
export function checkChainOwners({ matrixPath = MATRIX_PATH, classMap, exists } = {}) {
  const { sections } = traceChain({ ...(classMap ? { classMap } : {}), ...(exists ? { exists } : {}) })
  return checkOwners({ sections, itemNumbers: sectionFiveItemNumbers(matrixPath) })
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/')

if (isMain) {
  const { sections, firstHardBreak, softGaps, allGreen } = traceChain()
  console.log('目标文档 §9 商业 Alpha 链 —— 逐节投影\n')
  for (const s of sections) {
    const mark = s.hardBroken ? '✖' : s.softGap ? '△' : '✔'
    const tag = s.hardBroken ? '硬断（核心模块没人挂）' : s.softGap ? '软缺口（支撑模块没人挂）' : '有活实现'
    const own = s.owner === undefined ? '' : `  ⇒ 归属 §5 第 ${s.owner} 条`
    console.log(`${mark} ${s.id}  ${s.title}  —— ${tag}${own}`)
    if (s.hardBroken) console.log(`      核心依据：${s.coreWhy}`)
    for (const m of s.modules) {
      const why = !m.present ? '**文件不存在**'
        : m.unreachableClass === 'gap' ? '不可达且分类为 gap'
          : m.unreachableClass === null ? '可达'
            : `不可达但属 ${m.unreachableClass}（正常）`
      console.log(`      ${m.bad ? '✖' : '·'} [${m.core ? '核心' : '支撑'}] ${m.module.padEnd(52)} ${why}`)
    }
  }
  console.log(`\n最先**硬断**的一节：${firstHardBreak === null ? '（没有）' : `${firstHardBreak.id} ${firstHardBreak.title}`}`)
  console.log(`软缺口：${softGaps.length === 0 ? '（没有）' : softGaps.map((s) => s.id).join('、')}`)
  console.log(`整条链全绿：${allGreen ? '是' : '**否**'}`)

  const owners = checkChainOwners()
  console.log(`\n断点归属（每个断点都必须有人认领）：${owners.ok ? '**全部有归属**' : '有问题'}`)
  for (const v of owners.violations) console.log(`  ✖ [${v.id}] ${v.message}`)
  process.exit(owners.ok ? 0 : 1)
}
