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
  /**
   * ★ 通道上**有**更新的版本，但发行方声明它不支持从**本机这个版本**升
   *   （设计 §5 的 `supportedFromVersions`）。
   *
   *   它与 `up-to-date` **必须分开**，因为用户该做的事完全相反：
   *
   *   | 状态 | 用户看到 | 用户该做什么 |
   *   |---|---|---|
   *   | `up-to-date` | 已是最新版本 | 什么都不用做 |
   *   | 这一条 | 这个版本不支持从你的版本升级 | 先升到声明的那个版本 |
   *
   *   > 把"有一个你装不上的新版"显示成"已是最新版本"，
   *   > 与把"没有新版"显示成"检查失败"，是同一类错误：
   *   > 两种情形的**下一步动作**不同，而界面把它们说成了同一件事。
   *
   *   ★ 它同时也**不是** `check-failed`：没有失败。检查成功、结论明确。
   *     用失败去表达它会让用户去点"重试"，而重试会得到同一个答案。
   */
  'source-unsupported',
])

export const UPDATE_STATES = Object.freeze([...UPDATE_CHAIN, ...UPDATE_OFFCHAIN])

/** 可以重试的状态（界面显示"重试"按钮）。 */
export const RETRYABLE_STATES = Object.freeze(['check-failed', 'download-failed', 'install-blocked'])

/** 终态：不再自动变化。 */
export const TERMINAL_STATES = Object.freeze([
  'up-to-date', 'committed', 'rolled-back', 'recovery-required',
  // ★ 与 `up-to-date` 同档：这个结论不会自己变。它会因为一次**新的检查**
  //   （`check-started`）离开，而不是因为等待——"终态"说的是"不再自动变化"，
  //   不是"不能再检查"。
  'source-unsupported',
])

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
  /**
   * 通道上有新版，但**发行方声明不支持从本机版本升**（设计 §5 的
   * `supportedFromVersions`）。
   *
   * ★ 它与 `check-up-to-date` 是两条事件而不是一条带参数的事件：
   *   落点状态不同，而落点决定用户在界面上看到什么、下一步该做什么。
   */
  'check-source-unsupported',
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
    // ★ 与 `up-to-date` 同档：一个"没有可安装候选"的终态，重新检查当然要能离开它
    //   （用户可能刚手动升到了声明的那个版本，于是下一次检查就该给出候选）。
    'source-unsupported': 'checking',
    // ★ 有候选时的重复检查**不改变状态**：界面不该从"发现 1.2.0"退回"正在检查"。
    available: 'available', downloading: 'downloading', verifying: 'verifying',
    ready: 'ready', 'waiting-for-tasks': 'waiting-for-tasks', preparing: 'preparing',
    installing: 'installing', validating: 'validating',
  }),
  'check-available': Object.freeze({ checking: 'available' }),
  'check-up-to-date': Object.freeze({ checking: 'up-to-date', idle: 'up-to-date' }),
  // 与 `check-up-to-date` 同形：只在"没有候选"的状态上成立。
  // ★ 它**不**从 `available` 迁移——一个有候选的状态不该被一个"装不上"的结论
  //   覆盖掉（那会丢掉用户已经看到的那条候选）。与 PROTECTED_STATES 同一条纪律。
  'check-source-unsupported': Object.freeze({
    checking: 'source-unsupported', idle: 'source-unsupported', 'up-to-date': 'source-unsupported',
  }),
  'check-failed': Object.freeze({
    checking: 'check-failed',
    idle: 'check-failed',
    // 这两条也允许：把一个"没有候选的终态"换成"检查失败"是信息量的提升。
    'up-to-date': 'check-failed',
    'source-unsupported': 'check-failed',
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

// ★★★ 这里原先有一张 `STATE_LABELS`（"状态的可读标签（界面文案）"）。
//   已删除。理由：**全仓没有任何界面读它**——它只出现在自己的自检与
//   `index.mjs` 的再导出里。用户真正看到的那句话在
//   `desktop/update-panel.mjs` 的 `STATE_TEXT` 里（由 `projectView` → `render`
//   消费），而那才是"改了文案用户会不会看到"这个问题的答案。
//
//   ★ 这不是理论风险：本轮加 `source-unsupported` 时，**我先把文案加进了
//     这张表**，以为那就是用户文案——直到去查"谁读它"才发现没有任何人读。
//
//   > 一张名字叫"界面文案"、注释也写着"界面文案"的表，
//   > 与一张界面真的会读的表，在"改了文案用户会不会看到"上不是同一个东西。
//
//   覆盖率那一条判据**没有丢**，它搬到了真正的表所在的地方：
//   `desktop/update-panel.test.mjs` 里有一条跨模块接缝判据
//   （`UPDATE_STATES` 与 `STATE_TEXT` 必须逐个对齐，两个方向都查）。
//   搬到那边比留在这里更强：留在这里只能保证"两张表都覆盖了词汇表"，
//   而搬过去之后保证的是"**用户看到的**那张覆盖了词汇表"。

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

  // ②b ★★ 新增的落点必须**可达**，而且必须真的与 `up-to-date` 分开。
  //
  //   ★ 为什么这一条要单独写：`UPDATE_OFFCHAIN` 里加一个名字、`STATE_LABELS`
  //     里加一句文案，这两件事都**不会**让那个状态变得可达——它照样是一个
  //     "声明了、有文案、但没有任何迁移指向它"的状态，而那正是本次会话反复
  //     遇到的那一类（声明了没人读）。所以可达性要有一条判据。
  {
    const reachable = transition('checking', 'check-source-unsupported')
    if (reachable.state !== 'source-unsupported') {
      problems.push(`source-unsupported 不可达：checking --check-source-unsupported--> ${reachable.state}`)
    }
    if (reachable.state === transition('checking', 'check-up-to-date').state) {
      problems.push('source-unsupported 与 up-to-date 落到了同一个状态——两者的用户文案不同，不该合并')
    }
    // 重新检查必须能离开它（用户可能刚手动升到了声明的那个版本）。
    if (transition('source-unsupported', 'check-started').state !== 'checking') {
      problems.push('source-unsupported 无法通过重新检查离开')
    }
    // 而它不该被一个"检查失败"以外的任何东西悄悄顶掉。
    for (const event of ['check-available']) {
      const r = transition('source-unsupported', event)
      if (r.state !== 'source-unsupported') {
        problems.push(`source-unsupported 被 ${event} 改变了：${r.state}`)
      }
    }
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

  // ⑤ 每个事件都在表里有一条入口。
  //
  //   ★ 这里原先还有一条"每个状态都有标签"（查 `STATE_LABELS` 的覆盖）。
  //     那张表已删除（见上面的注释），于是这条判据搬到了**真正会被渲染的
  //     那张表**所在的地方：`desktop/update-panel.test.mjs` 里有一条跨模块
  //     接缝判据，断言 `UPDATE_STATES` 与面板的 `STATE_TEXT` 逐个对齐。
  //
  //     > 覆盖率的判据应当挂在**用户真的会看到**的那张表上；
  //     > 挂在一张没人读的表上，它保证的是一句与界面无关的话。
  //
  //     ★ 留在这里的那半（词汇表本身自洽）由下面 ⑥ 与 ②b 承担。
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
