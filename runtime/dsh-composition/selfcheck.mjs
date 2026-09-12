// runtime/dsh-composition/selfcheck.mjs
// ============================================================================
// 强制面生效自检（PRT-213 沙箱实际执行 + PRT-215 启动自检）
//
// ## 为什么必须是「自检」而不是「配置检查」
//
// 这一层最危险的失效方式是**静默失效**：DSH 升级会改变 bundle 结构与 patch 锚点，
// 补丁层可能挂不上却没有任何报错；沙箱可能因为后端不支持而退化成**不限制**。
// 两者的共同点是——**配置看起来完全正常**。
//
// 所以本文件不读配置、不看名字，只做两件事：
//   1. 让 `confine()` **真的去管制一次执行**，读它报告的 enforcement；
//   2. 让组合树**自报**每一行是否激活、preset 表里到底有哪些键。
//
// ## 一条硬规则：`partial` 不等于可用
//
// `ConfinedArgv.enforcement` 是 `'full' | 'partial'`。`partial` 的字面意思是
// 「这个后端对这条 argv 只做到了部分管制」——而那正意味着**存在不被管制的路径**。
// 把 `partial` 当可用，等于在一个已知有漏洞的沙箱上宣称「已限制」。
// 因此本文件的判据是 `enforcement === 'full'`，`partial` 一律判未生效。
//
// ## 零 DSH import
//
// `probeSandbox` 只调用注入进来的 `confine`。真实接线在 install.mjs。
// ============================================================================

import { DSH_COMPOSITION_PATCH_VERSION, reconcilePatchLayer } from './patch-layer.mjs'
import { assertMappingConsistent, checkGuardApprovalConsistency } from './enforcement-mapping.mjs'
import { probeTwoPhaseAvailability } from './enforcement.mjs'

/** 自检结论。`enforcement-effective` 之外的一切都不允许自动执行。 */
export const SELFCHECK_STATES = Object.freeze({
  effective: 'enforcement-effective',
  incompatible: 'incompatible',
})

/**
 * 用于探测的代表性 argv。
 *
 * 选用 `['node', '-e', 'process.exit(0)']` 而不是空数组或 `['true']`：
 *   · 空数组无法被任何后端管制，会得到一个无意义的 `partial`；
 *   · `'true'` 在不同平台解析不同（Windows 上没有这个可执行文件），
 *     会把「平台不支持」误判成「沙箱不生效」。
 * 用一个**跨平台且必然存在**的解释器调用，才能让探测结果只反映沙箱本身。
 */
export const PROBE_ARGV = Object.freeze(['node', '-e', 'process.exit(0)'])

/**
 * 探测沙箱后端与其**实际**执行程度（PRT-213）。
 *
 * @param {{confine?: Function, mode?: string, workspaceRoot?: string}} port
 * @returns {Promise<{effective: boolean, enforcement: string|null, backend: string|null, reasons: string[]}>}
 */
export async function probeSandbox(port = {}, { argv = PROBE_ARGV, mode = 'workspace-write', workspaceRoot = process.cwd() } = {}) {
  const reasons = []

  if (port === null || typeof port !== 'object' || typeof port.confine !== 'function') {
    return {
      effective: false,
      enforcement: null,
      backend: null,
      reasons: ['未挂载沙箱服务：`ctx.sandbox.confine` 不可用（仅有配置名不算生效）'],
    }
  }

  let confined
  try {
    confined = await port.confine(argv, { mode, workspaceRoot })
  } catch (err) {
    // confine 抛出 = 后端**明确拒绝**。DSH 的契约是「必须返回管制后的 argv
    // 或在 wrap / 执行期 fail closed，禁止静默放行」——抛出属于合规的 fail closed，
    // 但它仍然意味着现在不能自动执行。
    return {
      effective: false,
      enforcement: null,
      backend: null,
      reasons: [`confine() 拒绝为探针提供管制（fail closed）：${err?.message ?? String(err)}`],
    }
  }

  if (confined === null || typeof confined !== 'object') {
    return {
      effective: false,
      enforcement: null,
      backend: null,
      reasons: [`confine() 未返回对象（收到 ${confined === null ? 'null' : typeof confined}），无法判定管制程度`],
    }
  }

  const enforcement = typeof confined.enforcement === 'string' ? confined.enforcement : null
  const backend = typeof confined.backend === 'string' ? confined.backend : null

  if (enforcement === null) {
    reasons.push('confine() 未报告 enforcement；「没报告」不等于「已完全管制」，按未生效处理')
  } else if (enforcement !== 'full') {
    reasons.push(
      `沙箱仅提供 \`${enforcement}\` 级管制：存在未被管制的执行路径，不能据此宣称已限制（本判据要求 \`full\`）`,
    )
  }

  // 返回的 argv 必须**真的变了**。若后端原样返回输入 argv，
  // 那它没有做任何包装 —— 这是「配置了沙箱但没生效」最直接的证据。
  const returned = Array.isArray(confined.argv) ? confined.argv : null
  if (returned === null) {
    reasons.push('confine() 未返回管制后的 argv 数组')
  } else if (returned.length === argv.length && returned.every((v, i) => v === argv[i])) {
    reasons.push('confine() 原样返回了输入 argv：未做任何包装，沙箱未生效')
  }

  // denialSignatures 是「被拒绝长什么样」的判据。空集合意味着
  // 即使沙箱拒绝了，调用方也无法把它识别为拒绝 —— 拒绝会被当成普通失败。
  const denialSignatures = Array.isArray(confined.denialSignatures) ? confined.denialSignatures : null
  if (denialSignatures === null || denialSignatures.length === 0) {
    reasons.push('confine() 未提供非空 denialSignatures：沙箱拒绝无法被识别，拒绝会退化成普通失败')
  }

  return {
    effective: reasons.length === 0,
    enforcement,
    backend,
    probeArgv: [...argv],
    reasons,
  }
}

/**
 * 启动自检（PRT-215）。
 *
 * 三项各自独立判定、**逐项归因**：只说一句「未生效」会让人不知道
 * 该去修版本、修补丁层、还是修沙箱。三者的修复动作完全不同。
 *
 * @param {{composition?: object, sandbox?: object, runtime?: {ok?: boolean, version?: string|null, reason?: string}}} inputs
 */
export async function startupSelfCheck(inputs = {}) {
  const { composition, sandbox, runtime } = inputs
  const checks = []

  // ① 组合补丁层是否真的挂上并生效
  const reconciled = reconcilePatchLayer(composition ?? {})
  checks.push({
    name: 'composition-patch-layer',
    ok: reconciled.effective,
    detail: reconciled.effective
      ? `补丁层 v${reconciled.patchVersion} 的 ${reconciled.findings.length} 项全部生效`
      : `补丁层 v${reconciled.patchVersion} 未完全生效`,
    reasons: reconciled.reasons,
  })

  // ② DSH 版本与能力（由既有 probe.mjs 提供结论，本函数只做门禁判定）
  const runtimeOk = runtime?.ok === true
  checks.push({
    name: 'runtime-probe',
    ok: runtimeOk,
    detail: runtimeOk ? `运行时 ${runtime.version ?? '(未报版本)'} 通过能力与版本协商` : '运行时探测未通过',
    reasons: runtimeOk ? [] : [runtime?.reason ?? '未提供运行时探测结果：「没探测」不等于「没问题」'],
  })

  // ③ 沙箱的实际执行程度
  const sandboxResult = await probeSandbox(sandbox ?? {})
  checks.push({
    name: 'sandbox-enforcement',
    ok: sandboxResult.effective,
    detail: sandboxResult.effective
      ? `沙箱提供 full 级管制${sandboxResult.backend === null ? '' : `（后端 ${sandboxResult.backend}）`}`
      : '沙箱未提供 full 级管制',
    reasons: sandboxResult.reasons,
  })

  // ④ 权限语义到强制面的固定映射是否仍然自洽（PRT-612）
  //
  // 这一条与 ①②③ 问的是不同的事。①②③ 问的是"强制面**挂上并生效**了吗"，
  // 这一条问的是"**挂上的那几个点，与 spec 说的那张映射表还是同一回事吗**"。
  // 两者可以同时为真而仍然出问题：补丁层完整生效、沙箱真的在管制，而映射表里
  // `ask` 那一行被改成"pre-execute 直接放行"——三个点都绿，没有人会来报 bug。
  //
  //   > 一个「检查强制面挂上了没有」的启动自检，
  //   > 与一个「检查挂上的强制面是不是声明的那几个」的启动自检，不是同一个东西。
  //
  // `probeSandbox` 必须在这里注入：`selfcheck.mjs` 是 import
  // `enforcement-mapping.mjs` 的那一侧，反向 import 会成环。**注入而不是跳过**——
  // 模块自己的装载期自检会把这一条记进 `unresolvedPrimitives`，到这一行才补上，
  // 于是"全查过"这句话在两个调用点合起来才成立。
  const mapping = assertMappingConsistent({ primitives: { 'selfcheck.mjs': { probeSandbox } } })
  checks.push({
    name: 'enforcement-mapping',
    ok: mapping.ok && mapping.unresolvedPrimitives.length === 0,
    detail: mapping.ok
      ? `映射 v${mapping.version} 自洽：${mapping.routedModes.length} 个模式、` +
        `${mapping.decisionPoints.length} 个决定来源、${mapping.mappingLines.length} 行 spec 对照`
      : `映射自洽性检查未通过（${mapping.problems.length} 项）`,
    reasons: [
      ...mapping.problems.map((p) => `${p.code}: ${p.message}`),
      // 还有没解析到的原语 ⇒ 这一条**没查全**，不能算通过。
      ...mapping.unresolvedPrimitives.map((u) => `原语未验证：${u.point} → ${u.module} 的 ${u.name}（${u.why}）`),
    ],
  })

  // ⑤ 跨点一致性（PRT-620）：guard 只有降级语义 —— 放行过的调用不得被它拒绝。
  //
  // 这一条与 ④ 问的不是同一件事。④ 问"这张表自洽吗"；⑤ 问"**两个点合起来**说得通吗"：
  // 映射表可以完全自洽，而 pre-execute 侧压根没接静态下限——于是每个点单看都对，
  // 合起来却出现"人批了、guard 又拒了"，而那条记录在审计里没有修复动作。
  //
  //   > 一个「每个强制点单看都是绿的」的启动自检，
  //   > 与一个「点与点之间已经矛盾了」的启动自检，不是同一个东西。
  const guardConsistency = checkGuardApprovalConsistency()
  checks.push({
    name: 'guard-approval-consistency',
    ok: guardConsistency.ok,
    detail: guardConsistency.consistent.ok
      ? `跨点不变量成立：${guardConsistency.consistent.throughCount} 次放行中 0 次被 guard 拒绝、`
        + `探针下限 ${guardConsistency.probeFloor.executions} 个样本（guard 拦下 ${guardConsistency.consistent.guardDeniedCount} 个）`
      : `跨点不变量被违反（${guardConsistency.consistent.violations.length} 例），定位点 ${JSON.stringify(guardConsistency.consistent.points)}`,
    reasons: [
      ...guardConsistency.consistent.violations.map((v) => `${v.code} @ ${v.point} ${v.callId ?? ''}：${v.detail}`),
      // 反向控制没红 ⇒ 这条检查在坏输入上也不说话，等于一条不存在的检查。
      ...(guardConsistency.tamperedCaught
        ? []
        : ['反向控制**没有**报出违规：这条检查在坏输入上也不红，等于一条不存在的检查']),
    ],
    guardConsistency,
  })

  // ⑥ 可用性语义（PRT-617）：两段超时可独立观测，且故障一律 fail closed、一律结算。
  //
  // 前五项都是**静态**的：它们能证明"接线是对的"，不能证明"卡住的时候真的会结算"。
  // 这一项用真定时器把每一种成因跑一遍——没结算 = 工具调用会无限期挂起，
  // 而那正是 spec §6.8 line 476 描述的那个故障。
  const availability = await probeTwoPhaseAvailability()
  checks.push({
    name: 'enforcement-availability',
    ok: availability.ok,
    detail: availability.ok
      ? `两段超时各自可观测（${availability.rows.length} 个成因，预算 ${availability.budgetMs}ms），故障一律 fail closed`
      : `可用性语义实测未通过（${availability.reasons.length} 项）`,
    reasons: availability.reasons,
    availability,
  })

  const failed = checks.filter((c) => !c.ok)
  return {
    state: failed.length === 0 ? SELFCHECK_STATES.effective : SELFCHECK_STATES.incompatible,
    patchVersion: DSH_COMPOSITION_PATCH_VERSION,
    // 「禁止自动执行」是**判定的直接后果**，因此在这里就给出，
    // 而不是留给调用方各自记得去检查 state。
    autoExecutionForbidden: failed.length > 0,
    checks,
    reasons: failed.flatMap((c) => c.reasons.map((r) => `${c.name}: ${r}`)),
    sandbox: sandboxResult,
    // 第 ④ 项的完整结论（含它**没查到**的原语）——只给一个是/否，
    // 调用方就没法判断"通过了"与"没查全"的区别。
    mapping,
    // 第 ⑤⑥ 项的完整结论同理：`ok` 只说结论，计算值才说"这次到底查了什么"。
    guardConsistency,
    availability,
  }
}
