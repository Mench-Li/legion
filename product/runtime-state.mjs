// ============================================================================
// PRT-711 Runtime 健康状态 → 产品状态 → **Orchestrator 行为**
//
// spec §6.3 给了这样一张表（三列）：
//
//   | Runtime 状态   | 产品状态         | Orchestrator 行为                     |
//   | starting      | 正在启动执行引擎 | 不认领新任务；已有 lease 不延长为无限期 |
//   | ready         | 执行引擎可用     | 正常认领和执行                         |
//   | degraded      | 部分能力不可用   | 只认领其必需能力全部满足的任务          |
//   | unavailable   | 执行引擎不可用   | 停止认领；在途 Attempt 进入恢复判断     |
//   | incompatible  | 组件版本不兼容   | 禁止自动执行，提示修复或回滚            |
//   | upgrading     | 正在升级         | 停止认领，等待在途运行安全收敛          |
//
// `productStateOf`（在 `launcher.mjs` 里）已经把**前两列**做出来了。
// 本模块补的是**第三列**——而那一列才是这张表真正要决定的事。
//
// ── 为什么第三列非有不可 ──
//
// 「产品状态是 `unavailable`」这句话本身不改变任何行为。真正需要回答的是：
//
//   · 现在**能不能认领新任务**？
//   · 已经认领的怎么办——继续跑、进入恢复判断、还是等它收敛？
//   · lease 要不要继续延长？
//
// 不去回答它，结果是每个调用点各自解释一遍。而"各自的解释"里，
// 最省事、也最危险的那一种是：**出错时不认领这件事没做，于是照常认领。**
//
// ── 本模块的绝对纪律 ──
//
// 认不出状态时，**不许当成"可以认领"**。
//
// 一个没见过的状态字符串（版本不匹配、有人手改了状态文件、以后新增了状态）
// 如果落到"默认可以干活"，那么产品的每一次"状态不明"都会变成一次
// **在坏掉的产品上执行的自动化**——而执行是有代价的：它花用户的钱、
// 改用户的代码、发用户的消息。
//
//   > 一个在状态不明时"默认照常执行"的系统，与一个在状态不明时
//   > 随机执行一部分任务的系统，在"用户的钱会不会被乱花"上是同一个东西。
//
// 所以 `orchestratorPolicyFor` 对认不出的状态返回**最保守**的那一档，
// 并把它标成 `unrecognized: true`——不抛错（抛错会让调用方写 try/catch
// 然后 fallback 到"照常执行"），而是给出一份诚实的、拒绝干活的策略。
// ============================================================================

/** spec §6.3 表格第一列的六个 Runtime 状态。**顺序即表格顺序。** */
export const RUNTIME_STATES = Object.freeze([
  'starting', 'ready', 'degraded', 'unavailable', 'incompatible', 'upgrading',
])

/** 认领范围。三档对应表格第三列的三种"认领"说法。 */
export const CLAIM_SCOPE = Object.freeze({
  /** 一个都不认领。 */
  NONE: 'none',
  /** 全部认领（就是"正常认领和执行"）。 */
  ALL: 'all',
  /** 只认领其**必需能力全部满足**的任务。 */
  REQUIRED_CAPABILITIES_ONLY: 'required-capabilities-only',
})

/** 在途 Attempt 该怎么办。表格第二/三列里三种不同的处置。 */
export const IN_FLIGHT = Object.freeze({
  /** 没有在途（或不受影响）。 */
  UNCHANGED: 'unchanged',
  /** 进入恢复判断。 */
  RECOVERY_JUDGEMENT: 'recovery-judgement',
  /** 等它安全收敛（不再开新的，也不打断正在收尾的）。 */
  DRAIN: 'drain',
})

/**
 * 表格第三列。**这是一张全表**，"没写"是不允许的——
 * `assertClaimPolicyTotal()` 会在模块加载时检查这件事。
 */
export const CLAIM_POLICY = Object.freeze({
  starting: Object.freeze({
    mayClaim: false,
    claimScope: CLAIM_SCOPE.NONE,
    inFlight: IN_FLIGHT.UNCHANGED,
    // 「已有 lease 不延长为无限期」：一个无限延长的 lease 会让
    // "引擎还在启动"变成一件无限期的事，而任务看起来一直在被处理。
    renewLeasesIndefinitely: false,
    blockAutoExecution: false,
    digitalWorkerOnline: false,
    userText: '执行引擎正在启动：现在不会认领新任务，已认领的任务不会被无限期延长。',
  }),
  ready: Object.freeze({
    mayClaim: true,
    claimScope: CLAIM_SCOPE.ALL,
    inFlight: IN_FLIGHT.UNCHANGED,
    renewLeasesIndefinitely: true,
    blockAutoExecution: false,
    digitalWorkerOnline: true,
    userText: '执行引擎可用：正常认领和执行。',
  }),
  degraded: Object.freeze({
    mayClaim: true,
    claimScope: CLAIM_SCOPE.REQUIRED_CAPABILITIES_ONLY,
    inFlight: IN_FLIGHT.UNCHANGED,
    renewLeasesIndefinitely: true,
    blockAutoExecution: false,
    // 「部分能力不可用」时**不能报"数字员工在线"**：那是 ready 的说法。
    digitalWorkerOnline: false,
    userText: '部分能力不可用：只认领其必需能力全部满足的任务，其余任务会留在队列里等能力恢复。',
  }),
  unavailable: Object.freeze({
    mayClaim: false,
    claimScope: CLAIM_SCOPE.NONE,
    inFlight: IN_FLIGHT.RECOVERY_JUDGEMENT,
    renewLeasesIndefinitely: false,
    blockAutoExecution: false,
    digitalWorkerOnline: false,
    userText: '执行引擎不可用：停止认领，在途 Attempt 进入恢复判断。查看与导出仍然可用。',
  }),
  incompatible: Object.freeze({
    mayClaim: false,
    claimScope: CLAIM_SCOPE.NONE,
    inFlight: IN_FLIGHT.RECOVERY_JUDGEMENT,
    renewLeasesIndefinitely: false,
    // 「禁止自动执行」比"不认领"多一层：连重试、续跑这类自发动作也停。
    // 因为在不兼容的组件上重试，只是把同一个错误再犯一次。
    blockAutoExecution: true,
    digitalWorkerOnline: false,
    userText: '组件版本不兼容：已禁止自动执行。请修复或回滚到已验证的组合后再继续。',
  }),
  upgrading: Object.freeze({
    mayClaim: false,
    claimScope: CLAIM_SCOPE.NONE,
    inFlight: IN_FLIGHT.DRAIN,
    renewLeasesIndefinitely: false,
    blockAutoExecution: false,
    digitalWorkerOnline: false,
    userText: '正在升级：已停止认领，等待在途运行安全收敛。',
  }),
})

/**
 * 认不出的状态用哪一档。
 *
 * 取 `incompatible` 的保守面，但**不冒充**它是 `incompatible`：
 * `unrecognized: true` 会让上层知道"这不是一个已知状态"，
 * 而不是把"组件不兼容"这个具体结论安到一个我们并不理解的输入上。
 *
 * 为什么不是 `unavailable`：`unavailable` 只停认领，而 `incompatible`
 * 还额外禁止自动执行。状态不明时该选更严的那一个——
 * **"我不知道出了什么事"不是"事情还可以继续"的理由。**
 */
const UNRECOGNIZED_POLICY = Object.freeze({
  ...CLAIM_POLICY.incompatible,
  unrecognized: true,
  userText: '执行引擎状态无法识别（收到的是一个未知状态）：已按最保守的方式处理——'
    + '停止认领并禁止自动执行。**这不是一个已知的故障结论**，请检查版本是否匹配。',
})

/**
 * 自检：六个状态一个都不能漏，且每一档自身不能自相矛盾。
 *
 * `table` / `states` 可注入。这不是为了灵活性，是为了**让这道守卫可被观测**：
 * 它默认检查的就是真表，而真表当前是完备的——把检查语句改弱，结果依然是
 * 「没有问题」。只有能喂它一份**故意做坏的**表，才能证明它真的会发现问题。
 *
 *   > 一个只能对「当前恰好正确的那份输入」作答的校验，
 *   > 与一个恒真的校验，在「它能不能发现错误」上同形。
 */
export function assertClaimPolicyTotal(table = CLAIM_POLICY, states = RUNTIME_STATES) {
  const problems = []
  for (const s of states) {
    const p = table[s]
    if (p === undefined) { problems.push(`状态 ${s} 没有认领策略`); continue }
    // 认领与"禁止自动执行"合起来必须给出一个明确答案
    if (typeof p.mayClaim !== 'boolean') problems.push(`${s}.mayClaim 不是布尔`)
    if (!Object.values(CLAIM_SCOPE).includes(p.claimScope)) problems.push(`${s}.claimScope 不认识`)
    if (!Object.values(IN_FLIGHT).includes(p.inFlight)) problems.push(`${s}.inFlight 不认识`)
    // 「可以认领」与「认领范围是 none」是自相矛盾的
    if (p.mayClaim === true && p.claimScope === CLAIM_SCOPE.NONE) {
      problems.push(`${s} 说可以认领，却把认领范围写成 none`)
    }
    if (p.mayClaim === false && p.claimScope !== CLAIM_SCOPE.NONE) {
      problems.push(`${s} 说不认领，却给了非 none 的认领范围`)
    }
  }
  for (const k of Object.keys(table)) {
    if (!states.includes(k)) problems.push(`策略表里有未知状态 ${k}`)
  }
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) })
}

/**
 * 产品状态 → Orchestrator 行为。**总函数。**
 *
 * 认不出的状态返回保守策略并标 `unrecognized: true`，
 * **绝不返回"可以认领"**。
 */
export function orchestratorPolicyFor(state) {
  const p = CLAIM_POLICY[state]
  if (p !== undefined) return Object.freeze({ state, ...p, unrecognized: false })
  return Object.freeze({ state: String(state), ...UNRECOGNIZED_POLICY })
}

/**
 * 认领决策，供 Orchestrator 的扫描循环直接使用。
 *
 * 与 `orchestratorPolicyFor` 分开，是因为调用方真正要问的是一个**是/否 + 范围**，
 * 而不是一整张策略表。把"该不该认领"单独做成一个函数，
 * 可以让"默认照常认领"这条最危险的捷径**没有地方可写**。
 */
export function mayClaimTasks(state, { satisfiedCapabilities = null } = {}) {
  const p = orchestratorPolicyFor(state)
  if (p.mayClaim !== true) {
    return Object.freeze({
      claim: false, scope: CLAIM_SCOPE.NONE, reason: p.userText, state: p.state, unrecognized: p.unrecognized,
    })
  }
  if (p.claimScope === CLAIM_SCOPE.ALL) {
    return Object.freeze({ claim: true, scope: CLAIM_SCOPE.ALL, reason: p.userText, state: p.state })
  }
  // `degraded`：只认领**其必需能力全部满足**的任务。
  // 调用方必须把"这一批任务里哪些的能力满足了"告诉我们；不给就一个都不认领——
  // 那正是 `degraded` 的含义（"部分能力不可用"），而不是"大概都行"。
  if (!Array.isArray(satisfiedCapabilities)) {
    return Object.freeze({
      claim: false, scope: CLAIM_SCOPE.NONE, state: p.state,
      reason: '部分能力不可用，但没有给出"哪些任务的必需能力已满足"，因此一个都不认领。'
        + '**不给判据不等于判据都满足。**',
    })
  }
  return Object.freeze({
    claim: satisfiedCapabilities.length > 0,
    scope: CLAIM_SCOPE.REQUIRED_CAPABILITIES_ONLY,
    eligible: Object.freeze([...satisfiedCapabilities]),
    reason: p.userText,
    state: p.state,
  })
}

/**
 * 把"进程层面算出来的状态"抬到"产品状态"。
 *
 * 两个外部信号会把状态**往上抬**（更保守的方向），而不是往下：
 *
 *   · `upgrading`：升级进行中。**优先级最高**——升级期间即使所有进程都报 ready，
 *     也不能认领：那正是"一边换零件一边开工"。
 *   · `selfCheck.state === 'incompatible'`：补丁层没生效（PRT-215）。
 *     强制面没生效的 Runtime 不能因为"进程都起来了"就报 `ready`——
 *     那等于**用一个健康检查为真的结论，去覆盖一个能力层为假的结论。**
 *
 * 抬升一定伴随一条诊断。一个悄悄变了的、用户看不懂的状态，
 * 会被当成"产品又抽风了"，而不是"有一个具体的原因"。
 */
export function liftProductState(processState, { selfCheck = null, upgrading = false } = {}) {
  if (upgrading === true && processState !== 'upgrading') {
    return Object.freeze({
      state: 'upgrading',
      liftedFrom: processState,
      reason: '升级进行中：即使各进程已就绪也不认领新任务',
    })
  }
  if (selfCheck !== null && selfCheck?.state === 'incompatible' && processState !== 'incompatible') {
    return Object.freeze({
      state: 'incompatible',
      liftedFrom: processState,
      reason: '启动自检判定强制面未生效（补丁层未应用）：'
        + '**进程都起来了不等于能力层生效了**。已按 incompatible 处理并禁止自动执行',
      detail: selfCheck.reasons ?? selfCheck.detail ?? null,
    })
  }
  return Object.freeze({ state: processState, liftedFrom: null, reason: null })
}

/**
 * 一条给界面用的完整读数：状态 + 文案 + Orchestrator 该怎么做 + 只读面还开不开。
 *
 * spec §6.3 末尾那句单独说明：「只读 Workbench 和 team-hub 在 Runtime 不可用时
 * 继续开放，用户仍可查看、导出和处理任务，但不能伪装为数字员工在线。」
 * 所以 `readOnlySurfacesOpen` **恒为 true**，而 `digitalWorkerOnline`
 * 只在 `ready` 为 true——这两个字段放在一起，就是为了不让
 * "产品还能用" 被读成 "数字员工在上班"。
 */
export function runtimeStatusReport(processState, { selfCheck = null, upgrading = false } = {}) {
  const lifted = liftProductState(processState, { selfCheck, upgrading })
  const policy = orchestratorPolicyFor(lifted.state)
  return Object.freeze({
    runtimeState: lifted.state,
    processState,
    liftedFrom: lifted.liftedFrom,
    liftReason: lifted.reason,
    text: policy.userText,
    orchestrator: Object.freeze({
      mayClaim: policy.mayClaim,
      claimScope: policy.claimScope,
      inFlight: policy.inFlight,
      renewLeasesIndefinitely: policy.renewLeasesIndefinitely,
      blockAutoExecution: policy.blockAutoExecution,
      unrecognized: policy.unrecognized,
    }),
    // 只读面在**任何**状态都开着：一个在引擎挂掉时连任务列表都看不了的产品，
    // 会让用户在最需要看一眼的时候什么也看不到。
    readOnlySurfacesOpen: true,
    digitalWorkerOnline: policy.digitalWorkerOnline,
  })
}
