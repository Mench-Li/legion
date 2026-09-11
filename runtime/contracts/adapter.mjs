// runtime/contracts/adapter.mjs
// ============================================================================
// RuntimeAdapter 契约、能力协商与版本兼容（PRT-101 / PRT-109）
//
// 纯模块，不依赖 Cordis/DSH。这是 Legion 与执行引擎之间**唯一允许的调用边界**
// （spec §6.1）。Fake Adapter 与 DshRuntimeAdapter 都必须满足同一形状。
//
// 版本策略（spec §6.1 / PRT-109）：
//   首版使用**精确主版本匹配**。产品清单声明唯一支持的 runtimeContractVersion，
//   由 Runtime Manager 判定兼容。次版本能力一律经 `RuntimeCapabilities` 探测，
//   任何必需能力缺失都返回 UNSUPPORTED_CAPABILITY，**不得静默降级**。
// ============================================================================

/** 本契约的主版本。任何破坏性改动都必须递增它。 */
export const RUNTIME_CONTRACT_VERSION = 1

/** 契约要求的 Adapter 方法（spec §6.1 的 7 个方法）。 */
export const ADAPTER_METHODS = Object.freeze([
  'getHealth',
  'getCapabilities',
  'listModels',
  'validateProfile',
  'execute',
  'cancel',
  'recover',
])

/** Runtime 健康状态（spec §6.3 表）。 */
export const RUNTIME_HEALTH_STATES = Object.freeze([
  'starting',
  'ready',
  'degraded',
  'unavailable',
  'incompatible',
  'upgrading',
])

/** 执行器**必须**声明支持的能力键。缺失即无法执行受约束的任务。 */
export const REQUIRED_CAPABILITIES = Object.freeze([
  /** 能按 RunRequest.permissions 约束工具与文件范围。 */
  'tool-permission-enforcement',
  /** 能在超时/取消时真正终止执行并回收资源。 */
  'cancel-and-timeout',
  /** 能输出结构化结果供机器验收。 */
  'structured-result',
  /** 能上报 token 用量（预算与审计依赖它）。 */
  'usage-reporting',
])

/** 可选能力：缺失时应禁用对应产品功能，而不是报错（spec §6.14 的同类口径）。 */
export const OPTIONAL_CAPABILITIES = Object.freeze([
  'streaming-deltas',
  'artifact-emission',
  'session-resume',
  'sandbox-enforcement',
  'mcp-tools',
])

/**
 * 校验一个对象是否满足 RuntimeAdapter 形状。
 *
 * 同时校验 `runtimeContractVersion`：契约要求 Adapter 自报版本，否则
 * Runtime Manager 无法拒绝未经验证的组合（spec §6.3）。
 *
 * @param {unknown} adapter
 * @returns {{ok: boolean, errors: string[]}}
 */
export function assertAdapter(adapter) {
  const errors = []
  if (adapter === null || typeof adapter !== 'object') {
    return { ok: false, errors: ['Adapter 必须是对象'] }
  }
  for (const m of ADAPTER_METHODS) {
    if (typeof adapter[m] !== 'function') errors.push(`缺少方法 ${m}()`)
  }
  if (adapter.runtimeContractVersion !== RUNTIME_CONTRACT_VERSION) {
    errors.push(
      `runtimeContractVersion 必须是 ${RUNTIME_CONTRACT_VERSION}（实际 ${String(adapter.runtimeContractVersion)}）`,
    )
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 兼容性判定：精确主版本匹配 + 必需能力探测。
 *
 * @param {object} input
 * @param {number} input.adapterContractVersion Adapter 自报的契约版本
 * @param {object} input.capabilities Adapter 自报能力表
 * @param {number} [input.supportedContractVersion] 产品清单声明的受支持版本
 * @returns {{compatible: boolean, code: string|null, userMessage: string|null, reason: string, missingRequired: string[]}}
 */
export function checkCompatibility({
  adapterContractVersion,
  capabilities,
  supportedContractVersion = RUNTIME_CONTRACT_VERSION,
}) {
  if (adapterContractVersion !== supportedContractVersion) {
    return {
      compatible: false,
      code: 'UNSUPPORTED_CAPABILITY',
      userMessage: '执行引擎与当前产品版本不兼容，已停止自动执行。',
      reason: `契约版本不匹配：产品支持 ${supportedContractVersion}，执行引擎为 ${String(adapterContractVersion)}`,
      missingRequired: [],
    }
  }
  const caps = capabilities && typeof capabilities === 'object' ? capabilities : {}
  const missingRequired = REQUIRED_CAPABILITIES.filter((c) => caps[c] !== true)
  if (missingRequired.length > 0) {
    // spec §6.1：必需能力缺失必须报错，不得静默降级
    return {
      compatible: false,
      code: 'UNSUPPORTED_CAPABILITY',
      userMessage: '当前执行引擎缺少任务所需的能力，已停止自动执行。',
      reason: `缺少必需能力：${missingRequired.join(', ')}`,
      missingRequired,
    }
  }
  const missingOptional = OPTIONAL_CAPABILITIES.filter((c) => caps[c] !== true)
  return {
    compatible: true,
    code: null,
    userMessage: null,
    reason:
      missingOptional.length === 0
        ? '契约版本与全部能力均满足'
        : `契约版本匹配；可选能力缺失（应禁用对应功能，不报错）：${missingOptional.join(', ')}`,
    missingRequired: [],
  }
}

/**
 * 健康状态 → 产品状态 → Orchestrator 行为（spec §6.3 表）。
 * 把它做成常量是为了让「Runtime 不可用时 Orchestrator 做什么」有唯一答案，
 * 而不是散落在调度循环的 if 里。
 */
export const HEALTH_BEHAVIOR = Object.freeze({
  starting: Object.freeze({
    productState: '正在启动执行引擎',
    claimNewTasks: false,
    detail: '不认领新任务；已有 lease 不延长为无限期',
  }),
  ready: Object.freeze({
    productState: '执行引擎可用',
    claimNewTasks: true,
    detail: '正常认领和执行',
  }),
  degraded: Object.freeze({
    productState: '部分能力不可用',
    claimNewTasks: true,
    detail: '只认领其必需能力全部满足的任务',
  }),
  unavailable: Object.freeze({
    productState: '执行引擎不可用',
    claimNewTasks: false,
    detail: '停止认领；在途 Attempt 进入恢复判断',
  }),
  incompatible: Object.freeze({
    productState: '组件版本不兼容',
    claimNewTasks: false,
    detail: '禁止自动执行，提示修复或回滚',
  }),
  upgrading: Object.freeze({
    productState: '正在升级',
    claimNewTasks: false,
    detail: '停止认领，等待在途运行安全收敛',
  }),
})

/**
 * 取某健康状态下是否可认领任务。
 * 未知状态一律 **不认领**（fail closed）：新增状态时忘记更新本表，
 * 后果应是「暂时不干活」，而不是「绕过检查继续执行」。
 */
export function canClaimTasks(healthState) {
  const entry = HEALTH_BEHAVIOR[healthState]
  if (!entry) return false
  return entry.claimNewTasks === true
}

/** 构造 RuntimeHealth。 */
export function runtimeHealth({ state, contractVersion = RUNTIME_CONTRACT_VERSION, runtimeVersion = null, detail = '' }) {
  if (!RUNTIME_HEALTH_STATES.includes(state)) {
    throw new Error(`未知 Runtime 健康状态：${String(state)}`)
  }
  return Object.freeze({
    state,
    contractVersion,
    runtimeVersion: runtimeVersion === null ? null : String(runtimeVersion),
    detail: String(detail ?? ''),
    productState: HEALTH_BEHAVIOR[state].productState,
  })
}
