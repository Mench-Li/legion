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

import { REPO, BASELINE_PATH } from './reachability.mjs'

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
      + '缺了它 Run 照跑，缺的是**审计的完整性**——两者不该用同一个词报。',
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

// ── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/')

if (isMain) {
  const { sections, firstHardBreak, softGaps, allGreen } = traceChain()
  console.log('目标文档 §9 商业 Alpha 链 —— 逐节投影\n')
  for (const s of sections) {
    const mark = s.hardBroken ? '✖' : s.softGap ? '△' : '✔'
    const tag = s.hardBroken ? '硬断（核心模块没人挂）' : s.softGap ? '软缺口（支撑模块没人挂）' : '有活实现'
    console.log(`${mark} ${s.id}  ${s.title}  —— ${tag}`)
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
  process.exit(0)
}
