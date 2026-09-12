// runtime/dsh-composition/bootstrap.mjs
// ============================================================================
// DSH 侧的**装配入口**：把宿主端口与启动自检结论交给 orchestrator worker
// （PRT-215 的落地 + PRT-257 的「应用自检和修复入口」）
//
// ## 这个文件补的是哪一截
//
// 三件东西此前**都只在自己的模块里存在，没有任何调用者**：
//
//   · `startupSelfCheck()`（PRT-215）——强制面是否真的生效
//   · `probeSandbox()`（PRT-213）——沙箱的实际管制程度
//   · `bindDshRuntime()`（PRT-253）——把宿主端口交给 worker 的注册口
//
// 于是：
//   · worker 的 `executor` 永远是 `EXECUTOR_HOST_PORT_REQUIRED`
//     （PRT-253 的执行引擎、PRT-510 的预算闸门**都不会被激活**）；
//   · 「强制面未生效时禁止自动执行」这条保证**从未被行使过**——
//     它写在文档里、写在代码里，而从没拦过任何一次执行。
//
//   > 一个宣言从没被行使过，与这个宣言不存在，在行为上完全一样。
//
// 本文件就是那个行使它的地方。
//
// ## 零 DSH import（与 `port.mjs` / `selfcheck.mjs` 同一条取舍）
//
// 组合树观察、沙箱 `confine`、运行时探测三者都由**注入**给出。
// 好处是整条装配路径能在**不启动 DSH** 的前提下被完整测到——
// 包括"补丁层没挂上时到底会不会拦住执行"这一条，
// 而它恰恰是最需要用假件测的一条（真 DSH 上很难稳定复现"没挂上"）。
//
// ## 装配是**两段**的，且顺序不能反
//
//   ① 自检：强制面生效吗？
//   ② 只有①通过，才去注册端口。
//
// 反过来的话，一个先注册好、随后自检失败的进程会**留下一个已注册的端口**——
// 而 worker 是独立进程、可能已经开始认领任务了。
// 所以注册必须在自检**之后**，且自检失败时**什么都不注册**。
// ============================================================================

import { startupSelfCheck, SELFCHECK_STATES } from './selfcheck.mjs'
import { probeRuntime } from '../adapters/dsh/probe.mjs'
import { assertHostPort } from '../adapters/dsh/port.mjs'
import { bindDshRuntime } from '../../orchestrator/worker/executor-binding.mjs'

/** 本模块的具名码。 */
export const BOOTSTRAP_CODES = Object.freeze({
  /** 自检判定强制面未生效：禁止自动执行。 */
  SELF_CHECK_INCOMPATIBLE: 'BOOTSTRAP_SELF_CHECK_INCOMPATIBLE',
  /** 运行时探测未通过（版本/能力协商）。 */
  RUNTIME_PROBE_FAILED: 'BOOTSTRAP_RUNTIME_PROBE_FAILED',
  /** 接线错误。 */
  BAD_WIRING: 'BOOTSTRAP_BAD_WIRING',
  /** 宿主端口不完整：注册它等于注册一个用不了的东西。 */
  PORT_INCOMPLETE: 'BOOTSTRAP_PORT_INCOMPLETE',
  /** 已经装配过。 */
  ALREADY_BOUND: 'BOOTSTRAP_ALREADY_BOUND',
})

/**
 * 修复入口：把自检的失败项翻成**可执行的动作**。
 *
 * PRT-257 要求 Launcher 提供"修复入口"。而"修不了"往往不是因为没有修法，
 * 是因为**报告只说了哪一项没过，没说下一步做什么**，
 * 于是用户能做的只有把产品重装一遍。
 *
 * 每一项都带 `check` / `action` / `why`：`check` 对得上自检输出，
 * `action` 是一条具体的下一步，`why` 说明为什么这一项非修不可。
 */
export const REPAIR_ACTIONS = Object.freeze({
  'composition-patch-layer': Object.freeze({
    action: 'reapply-composition-patch',
    label: '重新应用组合补丁层',
    why: '补丁层未生效时，ToolGuard 硬底线、pre-execute 策略与审批应答者都不在，' +
      '而配置看起来完全正常——「行存在」与「行生效」是两件事',
  }),
  'runtime-probe': Object.freeze({
    action: 'install-supported-runtime',
    label: '安装受支持的 DSH 运行时版本',
    why: '版本或能力协商未过：补丁层按主版本固定，认不出的运行时上它可能挂不上却没有任何报错',
  }),
  'sandbox-enforcement': Object.freeze({
    action: 'fix-sandbox-backend',
    label: '修好沙箱后端到 full 级管制',
    why: '`partial` 的字面意思是「存在不被管制的路径」。把 partial 当可用，' +
      '等于在一个已知有漏洞的沙箱上宣称「已限制」',
  }),
})

/**
 * 把一次自检结论翻成修复计划。
 *
 * @param {object} check `startupSelfCheck` 的返回
 * @returns {{ok: boolean, items: Array<{check: string, action: string, label: string, why: string, reasons: string[]}>}}
 */
export function repairPlanFor(check) {
  const failed = (check?.checks ?? []).filter((c) => c?.ok !== true)
  const items = failed.map((c) => {
    const known = REPAIR_ACTIONS[c.name] ?? null
    return Object.freeze({
      check: c.name,
      action: known?.action ?? 'inspect-manually',
      label: known?.label ?? `人工排查 ${c.name}`,
      // 未知项**也**要出现在计划里。把它丢掉会让"有三项没过"
      // 变成"修了这两项就好了"——而第三项仍然拦着执行。
      why: known?.why ?? '这一项没有预置修法：它的失败原因需要人工判断，' +
        '但**它仍然在阻止执行**，不能因为计划里没有它就当作已解决',
      reasons: Object.freeze([...(c.reasons ?? [])]),
    })
  })
  return Object.freeze({ ok: failed.length === 0, items: Object.freeze(items) })
}

/**
 * 装配 DSH 运行时并把它交给 orchestrator worker。
 *
 * @param {object} deps
 * @param {object} deps.runtimeHost 运行时宿主（至少要有 `probeRuntime`）
 * @param {object} [deps.composition] 组合树观察结果（`{rows, permissionPresets}`，注入）
 * @param {object} [deps.sandbox] 沙箱端口（`{confine}`，注入）
 * @param {() => object} deps.canRead 装配阶段的权限判定（**必给**，不给默认值）
 * @param {object} [deps.selfCheck] 覆盖自检实现（用例用）
 * @param {(input: object) => Function} [deps.bind] 覆盖注册口（用例用）
 */
export async function bootstrapDshRuntime(deps = {}) {
  const {
    runtimeHost, composition, sandbox, canRead,
    selfCheck, bind = bindDshRuntime,
    // 探测实现的**注入点**。默认真实现；用例用它走到"探测自己抛错 /
    // 返回畸形结果"那两条分支——真 `probeRuntime` 内部把宿主异常都
    // 归一化成了 `{ok:false}`，所以那两条**用真实现永远走不到**。
    //
    // 这与 `adapterFactory`、`bind` 是同一个手法，理由也一样：
    // 一条没人走过的分支与一条不存在的分支，在"用例全绿"这个读数上完全一样。
    probeFactory = probeRuntime,
  } = deps

  if (typeof canRead !== 'function') {
    // 与本仓库其他几处同一条口径：不替调用方决定权限。
    // 一个"默认都能读"的默认值会让一次接线遗漏变成一次静默越权。
    return refuse(BOOTSTRAP_CODES.BAD_WIRING,
      'bootstrapDshRuntime 需要 canRead：装配阶段的权限判定必须由调用方显式给出，不给默认值')
  }

  // ① 运行时探测（版本 + 必需能力）。
  // 探测本身失败**也算未通过**——"没探测"不等于"没问题"。
  let probed = null
  let probeFailed = null
  try {
    probed = await probeFactory(runtimeHost ?? {})
  } catch (e) {
    probeFailed = e
  }
  if (probeFailed !== null) {
    return refuse(BOOTSTRAP_CODES.RUNTIME_PROBE_FAILED,
      `运行时探测抛错：${probeFailed?.message ?? probeFailed}`, { reasons: [] })
  }
  if (probed === null || typeof probed !== 'object') {
    return refuse(BOOTSTRAP_CODES.RUNTIME_PROBE_FAILED,
      '运行时探测没有返回结论。**「没探测」不等于「没问题」**：' +
      '自检需要一个明确的是/否，而 undefined 在读出来是"未通过"之前先在别处是"假"',
      { reasons: [] })
  }

  // ② 启动自检。探测结论**原样**交给它，不在这里重新解释一遍——
  // 解释逻辑有两份就会漂移，而漂移的那一天表现为"自检说通过了，而强制面没生效"。
  const run = typeof selfCheck === 'function' ? selfCheck : startupSelfCheck
  const check = await run({
    composition: composition ?? {},
    sandbox: sandbox ?? {},
    runtime: { ok: probed.ok === true, version: probed.version ?? null, reason: probed.reason ?? null },
  })

  if (check === null || typeof check !== 'object' || typeof check.autoExecutionForbidden !== 'boolean') {
    return refuse(BOOTSTRAP_CODES.BAD_WIRING,
      '自检结果缺少布尔字段 autoExecutionForbidden：' +
      '缺了它，「禁止执行」这个判定读出来是 false——形状错误会被当成通过')
  }

  if (check.autoExecutionForbidden === true) {
    // **什么都不注册。** 顺序是刻意的：先注册端口再自检，会留下一个已注册的
    // 端口，而 worker 是独立进程、可能已经开始认领任务了。
    return refuse(BOOTSTRAP_CODES.SELF_CHECK_INCOMPATIBLE,
      '启动自检判定强制面未生效：禁止自动执行，**不注册宿主端口**',
      {
        reasons: [...(check.reasons ?? [])],
        state: check.state ?? null,
        patchVersion: check.patchVersion ?? null,
        checks: check.checks ?? [],
        repair: repairPlanFor(check),
      })
  }

  // ③ 自检通过，才注册。注册失败（缺 selfCheck/canRead）会抛——
  // 那是接线错误，必须**当场**炸，而不是让 worker 带着一个假端口跑起来。
  //
  // 但在注册**之前**还要先确认这个端口是**完整的**。
  //
  // 这一条是补出来的：第一版直接把 `runtimeHost` 当端口注册，而假件只有
  // `probeRuntime`（探测只需要它）。于是注册"成功"了一个**用不了的端口**，
  // 失败被推迟到 worker 构造执行引擎时——那里报的是
  // `EXECUTOR_HOST_PORT_REQUIRED: 缺少必需方法 startRun`。
  //
  // 报得不算差，但**层级错了**：装配这一步明明可以当场说清"这个端口不完整"，
  // 却让它变成一个"worker 起不来"的现象——排障会从 worker 那边开始找，
  // 而真因在这里。
  //
  //   > 一个注册得上、却没人能用的端口，与一个没注册的端口，
  //   > 只在"状态显示已接线"这一点上不同——而那是更坏的一种。
  const portCheck = assertHostPort(runtimeHost)
  if (!portCheck.ok) {
    return refuse(BOOTSTRAP_CODES.PORT_INCOMPLETE,
      `宿主端口不完整，**不注册**：\n  - ${portCheck.errors.join('\n  - ')}\n` +
      '注册一个缺方法的端口，会让失败推迟到 worker 构造执行引擎时——' +
      '那里看起来像"worker 起不来"，而真因是这里给的东西不全',
      { reasons: portCheck.errors })
  }

  let unbind
  try {
    unbind = bind({
      host: runtimeHost,
      // 把**已经算完的结论**包成函数交过去：worker 在构造执行引擎时会再要一次。
      // 这里不重新探测——一次装配对应一次结论，
      // 而"两次探测得到不同答案"会让 worker 的判定与 Launcher 的判定不一致。
      selfCheck: async () => check,
      canRead,
    })
  } catch (e) {
    return refuse(BOOTSTRAP_CODES.BAD_WIRING,
      `注册宿主端口失败：${e?.message ?? e}`)
  }

  return Object.freeze({
    ok: true,
    state: check.state ?? SELFCHECK_STATES.effective,
    patchVersion: check.patchVersion ?? null,
    checks: Object.freeze([...(check.checks ?? [])]),
    repair: repairPlanFor(check),
    unbind,
  })
}

function refuse(code, message, extra = {}) {
  const reasons = Object.freeze([...(extra.reasons ?? [])])
  return Object.freeze({
    ok: false, code, message, reasons,
    repair: extra.repair ?? repairPlanFor({ checks: [] }),
    ...extra,
    reasons,
  })
}
