// product/update/state.mjs
// ============================================================================
// 更新状态机 —— 设计 §8 line 166 的显式化
//
// 设计给的主链是：
//
//   idle → checking → available → downloading → verifying → ready
//        → waiting-for-tasks → preparing → installing → validating → committed
//
// 加上两句约束：
//   · 「网络与准备失败进入可重试状态」；
//   · 「程序切换后失败进入 `rolled-back` 或 `recovery-required`」；
//   · 以及一句最容易被实现忽略的：
//     **「检查失败不能覆盖已经准备好的更新状态」**。
//
// ## 为什么这句最容易被忽略
//
// 自动检查每 6 小时跑一次。用户发现新版、点"下载更新"、下到一半，这时
// 后台的周期检查失败了（离线、托管抖动）——一个把 `check` 的结果直接写成
// 状态的实现会在这里把 `downloading` 换成 `check-failed`，于是：
//
//   · 界面从"正在下载 63%"变成"检查更新失败"；
//   · 用户点"重试"重跑的是**检查**，而不是继续下载；
//   · 那个已经下好的 63% 与正在写的 `.part` 变成没有主人的文件。
//
// 所以这里把"检查的发生"与"检查的结论"分开：
//   `result` 只记在 `lastCheck` 读数里；**只有**在"没有在途更新事务"的
//   状态上，结论才被允许改变主状态。
//
// ## 转移表是显式的
//
// 与 `product/upgrade/index.mjs` 里 `RESULT_BY_VERDICT` 的理由相同：一串
// `if/else` 在有人加了一个新状态的那天会静默把新状态落进最后一个分支。
// 表里的每个入口都要写明，缺一个就是装载期的问题。
// ============================================================================

/** 主链（顺序即设计 §8 的顺序）。 */
export const UPDATE_CHAIN = Object.freeze([
  'idle', 'checking', 'available', 'downloading', 'verifying', 'ready',
  'waiting-for-tasks', 'preparing', 'installing', 'validating', 'committed',
])

/**
 * 主链之外的落点，每一个都必须**可区分**：
 *
 *   · `up-to-date`         —— 检查成功、没有更新。不是失败，也不该显示错误。
 *   · `check-failed`       —— 检查失败。可重试，且**只在没有候选时**出现。
 *   · `download-failed`    —— 下载失败。可重试；候选身份保持不变（设计 §6 line 138）。
 *   · `cancelled`          —— 用户取消了下载。不是失败，不进失败退避。
 *   · `install-blocked`    —— 预检/等待任务失败，还没动过程序。
 *   · `rolled-back`        —— 换过程序但已退回旧版本。
 *   · `recovery-required`  —— 换过程序且不能自动恢复，需要人工/向前修复。
 */
export const UPDATE_OFFCHAIN = Object.freeze([
  'up-to-date', 'check-failed', 'download-failed', 'cancelled',
  'install-blocked', 'rolled-back', 'recovery-required',
])

export const UPDATE_STATES = Object.freeze([...UPDATE_CHAIN, ...UPDATE_OFFCHAIN])

/** 可以重试的状态（界面显示"重试"按钮）。 */
export const RETRYABLE_STATES = Object.freeze(['check-failed', 'download-failed', 'install-blocked'])

/** 终态：不再自动变化。 */
export const TERMINAL_STATES = Object.freeze(['up-to-date', 'committed', 'rolled-back', 'recovery-required'])

/**
 * 处于这些状态时，**检查的结论不许覆盖主状态**（设计 §8 line 166 那句话）。
 *
 * `checking` 不在其中：它本来就是"检查中"，结论当然应该改变它。
 */
export const PROTECTED_STATES = Object.freeze([
  'available', 'downloading', 'verifying', 'ready',
  'waiting-for-tasks', 'preparing', 'installing', 'validating',
])

/** 事件枚举。与 `client.mjs` 的调用点一一对应。 */
export const UPDATE_EVENTS = Object.freeze([
  'check-started',
  'check-available',
  'check-up-to-date',
  'check-failed',
  'download-started',
  'download-complete',
  'download-verified',
  'download-failed',
  'download-cancelled',
  'install-requested',
  /**
   * 安装前重查通道时发现目标已被撤回（设计 §9 line 204）。
   *
   * ★ 它是一条**状态迁移**而不是"保持原状态"：撤回的意义是"这个候选不算数
   *   了"。停在 `ready` 会让界面继续显示"可以安装"，而每一次点击都会再失败
   *   一次——用户会以为按钮坏了。落回 `available` 说的是"通道上有东西，但
   *   不是你已经下载的那一个"；下一次检查会取回真正的候选。
   */
  'recall-discarded',
  'tasks-wait-started',
  'tasks-wait-failed',
  'prepare-started',
  'prepare-failed',
  'install-started',
  'validate-started',
  'commit',
  'rollback',
  'recovery-required',
  /** 用户"稍后"：只收起提醒，状态不变（设计 §7 line 146）。 */
  'snooze',
])

const T = Object.freeze({
  'check-started': Object.freeze({
    idle: 'checking', 'up-to-date': 'checking', 'check-failed': 'checking',
    // ★ 有候选时的重复检查**不改变状态**：界面不该从"发现 1.2.0"退回"正在检查"。
    available: 'available', downloading: 'downloading', verifying: 'verifying',
    ready: 'ready', 'waiting-for-tasks': 'waiting-for-tasks', preparing: 'preparing',
    installing: 'installing', validating: 'validating',
  }),
  'check-available': Object.freeze({ checking: 'available' }),
  'check-up-to-date': Object.freeze({ checking: 'up-to-date', idle: 'up-to-date' }),
  'check-failed': Object.freeze({
    checking: 'check-failed',
    idle: 'check-failed',
    // 这两条也允许：把一个"没有候选的终态"换成"检查失败"是信息量的提升。
    'up-to-date': 'check-failed',
    // ★ PROTECTED_STATES 里的任何状态都不在这里 —— 缺省即"保持不变"。
    //   这不是省略，是设计 §8 line 166 那条约束的**唯一**落点。
  }),
  'download-started': Object.freeze({ available: 'downloading', 'download-failed': 'downloading', cancelled: 'downloading' }),
  // ★ 两个事件而不是一个。`download-complete` 说的是"字节完整"，
  //   `download-verified` 说的是"签名与摘要都过了"。合成一个事件的实现
  //   会在"下完了但验签失败"时无法表达"我已经有完整字节，但它是坏的"。
  'download-complete': Object.freeze({ downloading: 'verifying' }),
  'download-verified': Object.freeze({ verifying: 'ready' }),
  'download-failed': Object.freeze({ downloading: 'download-failed', verifying: 'download-failed' }),
  'download-cancelled': Object.freeze({ downloading: 'cancelled', verifying: 'cancelled' }),
  'install-requested': Object.freeze({ ready: 'waiting-for-tasks' }),
  // ★ 从 `ready` 落回 `available`：候选还在通道上（所以不是 `up-to-date`），
  //   只是**不是你已经下载的那一个**了。`waiting-for-tasks` 与 `preparing`
  //   也允许——撤回可能正好发生在交接进行到一半的时候。
  'recall-discarded': Object.freeze({
    ready: 'available', 'waiting-for-tasks': 'available', preparing: 'available',
  }),
  'tasks-wait-started': Object.freeze({ ready: 'waiting-for-tasks' }),
  'tasks-wait-failed': Object.freeze({ 'waiting-for-tasks': 'install-blocked' }),
  'prepare-started': Object.freeze({ 'waiting-for-tasks': 'preparing' }),
  'prepare-failed': Object.freeze({ preparing: 'install-blocked' }),
  'install-started': Object.freeze({ preparing: 'installing' }),
  'validate-started': Object.freeze({ installing: 'validating' }),
  commit: Object.freeze({ validating: 'committed' }),
  rollback: Object.freeze({ validating: 'rolled-back', installing: 'rolled-back', preparing: 'rolled-back' }),
  'recovery-required': Object.freeze({
    validating: 'recovery-required', installing: 'recovery-required', preparing: 'recovery-required',
    'install-blocked': 'recovery-required',
  }),
  // ★ 空表 = 任何状态下都不改变主状态。这正是设计 §7 line 146 的
  //   「稍后仅收起提醒，设置页仍可见」：收起是**提醒层**的事，
  //   不是更新状态的事。
  snooze: Object.freeze({}),
})

/**
 * 一个状态在两个事件之间的转移是否合法。
 *
 * @returns {{ok: boolean, state: string, changed: boolean, code: string, reason: string}}
 */
export function transition(currentState, event) {
  if (!UPDATE_EVENTS.includes(event)) {
    return Object.freeze({
      ok: false, state: currentState, changed: false, code: 'update-unknown-event',
      reason: `未知事件：${JSON.stringify(event)}`,
    })
  }
  if (!UPDATE_STATES.includes(currentState)) {
    return Object.freeze({
      ok: false, state: currentState, changed: false, code: 'update-unknown-state',
      reason: `未知状态：${JSON.stringify(currentState)}`,
    })
  }
  const table = T[event]
  const next = table[currentState]
  if (next === undefined) {
    // 保持原状态是**合法**结论（例如"ready 时检查失败"），不是错误。
    return Object.freeze({
      ok: true, state: currentState, changed: false, code: 'update-state-unchanged',
      reason: `在 ${currentState} 上收到 ${event}：保持原状态`,
    })
  }
  if (next === currentState) {
    return Object.freeze({ ok: true, state: next, changed: false, code: 'update-state-unchanged', reason: `仍是 ${next}` })
  }
  return Object.freeze({ ok: true, state: next, changed: true, code: 'update-state-changed', reason: `${currentState} → ${next}` })
}

/** 状态的可读标签（界面文案；错误码不在这里）。 */
export const STATE_LABELS = Object.freeze({
  idle: '待检查',
  checking: '正在检查更新',
  available: '发现新版本',
  downloading: '正在下载',
  verifying: '正在验证更新',
  ready: '更新已就绪',
  'waiting-for-tasks': '等待在途任务结束',
  preparing: '正在准备更新',
  installing: '正在安装',
  validating: '正在验证新版本',
  committed: '升级完成',
  'up-to-date': '已是最新版本',
  'check-failed': '检查更新失败',
  'download-failed': '下载失败',
  cancelled: '已取消下载',
  'install-blocked': '安装被阻止',
  'rolled-back': '已回退到旧版本',
  'recovery-required': '需要人工恢复',
})

/** 该状态是否允许用户发起"下载更新"（设计 §7 line 146）。 */
export function canDownload(state) {
  return state === 'available' || state === 'download-failed' || state === 'cancelled'
}

/** 该状态是否允许用户发起"安装并重启"（设计 §7 line 148）。 */
export function canInstall(state) {
  return state === 'ready' || state === 'install-blocked'
}

/** 该状态是否允许取消下载。 */
export function canCancelDownload(state) {
  return state === 'downloading' || state === 'verifying'
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export function selfCheckState() {
  const problems = []

  // ① 主链上每一步都有事件能走通，且顺序与设计 §8 一致。
  const walk = [
    ['idle', 'check-started', 'checking'],
    ['checking', 'check-available', 'available'],
    ['checking', 'check-up-to-date', 'up-to-date'],
    ['available', 'download-started', 'downloading'],
    ['downloading', 'download-complete', 'verifying'],
    ['verifying', 'download-verified', 'ready'],
    ['ready', 'install-requested', 'waiting-for-tasks'],
    ['waiting-for-tasks', 'prepare-started', 'preparing'],
    ['preparing', 'install-started', 'installing'],
    ['installing', 'validate-started', 'validating'],
    ['validating', 'commit', 'committed'],
  ]
  for (const [from, event, expected] of walk) {
    const result = transition(from, event)
    if (!result.ok || result.state !== expected) {
      problems.push(`转移失败：${from} --${event}--> 期望 ${expected}，实际 ${result.state}（${result.code}）`)
    }
  }

  // ② 每一步都能重试。
  for (const [from, event, expected] of [
    ['checking', 'check-failed', 'check-failed'],
    ['downloading', 'download-failed', 'download-failed'],
    ['preparing', 'prepare-failed', 'install-blocked'],
    ['waiting-for-tasks', 'tasks-wait-failed', 'install-blocked'],
  ]) {
    const result = transition(from, event)
    if (result.state !== expected) problems.push(`${from} --${event}--> 期望 ${expected}，实际 ${result.state}`)
  }

  // ③ ★ 设计 §8 line 166：检查失败不能覆盖已经准备好的更新状态。
  for (const state of PROTECTED_STATES) {
    const result = transition(state, 'check-failed')
    if (result.state !== state) {
      problems.push(`检查失败覆盖了受保护状态 ${state} → ${result.state}`)
    }
  }
  // 而在没有候选的状态上，检查失败必须被记下来。
  for (const state of ['idle', 'checking', 'up-to-date']) {
    if (transition(state, 'check-failed').state !== 'check-failed') {
      problems.push(`${state} 上的检查失败没有被记录`)
    }
  }

  // ④ 程序切换之后的两个失败落点必须可达且**可区分**。
  if (transition('validating', 'rollback').state !== 'rolled-back') problems.push('回退落点不可达')
  if (transition('validating', 'recovery-required').state !== 'recovery-required') problems.push('人工恢复落点不可达')

  // ⑤ 每个状态都有标签；每个事件都在表里有一条入口。
  const missingLabels = UPDATE_STATES.filter((state) => typeof STATE_LABELS[state] !== 'string')
  if (missingLabels.length > 0) problems.push(`这些状态没有标签：${missingLabels.join('/')}`)
  const missingEvents = UPDATE_EVENTS.filter((event) => T[event] === undefined)
  if (missingEvents.length > 0) problems.push(`这些事件没有转移表：${missingEvents.join('/')}`)

  // ⑥ 表里出现的每个目标状态都必须是已声明的状态。
  for (const event of Object.keys(T)) {
    for (const [from, to] of Object.entries(T[event])) {
      if (!UPDATE_STATES.includes(to)) problems.push(`事件 ${event} 从 ${from} 指向未声明的状态 ${to}`)
      if (!UPDATE_STATES.includes(from) && from !== 'verifying_alt') problems.push(`事件 ${event} 的来源状态未声明：${from}`)
    }
  }

  // ⑦ 未知事件/未知状态一律明确拒绝（不能静默保持）。
  if (transition('idle', 'nope').ok) problems.push('未知事件被接受了')
  if (transition('nope', 'check-started').ok) problems.push('未知状态被接受了')

  // ⑧ 操作门禁与状态一致。
  if (!canDownload('available') || canDownload('ready')) problems.push('下载门禁与状态不一致')
  if (!canInstall('ready') || canInstall('available')) problems.push('安装门禁与状态不一致')
  if (!canCancelDownload('downloading') || canCancelDownload('ready')) problems.push('取消门禁与状态不一致')

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    chain: UPDATE_CHAIN,
    offchain: UPDATE_OFFCHAIN,
    protectedStates: PROTECTED_STATES,
    sample: Object.freeze({
      protectedOnCheckFailed: Object.freeze(PROTECTED_STATES.map((state) => Object.freeze({
        state, after: transition(state, 'check-failed').state,
      }))),
      chainLength: UPDATE_CHAIN.length,
      eventCount: UPDATE_EVENTS.length,
    }),
  })
}

export const STATE_CHECKED = selfCheckState()
