// ============================================================================
// PRT-708 系统托盘与「打开 Workbench」
//
// spec §6.10：「系统托盘入口和打开 Workbench」。
//
// ── 本模块唯一真正要紧的那条纪律 ──
//
// **托盘上的「退出」必须真的把产品停掉，而不只是把图标藏起来。**
//
// 这是托盘类功能最经典的失败：用户右键 → 退出 → 图标消失了。
// 他合理地认为"产品关了"。而实际上子进程还在跑、还在占端口、
// 还在花他的钱（如果模型调用在跑）。等他下次启动，会看到
// 「端口被其他进程占用」——一句与他的操作毫无关系的话。
//
//   > 一个把图标藏起来、进程还在跑的「退出」，
//   > 与一个根本没有退出按钮的托盘，
//   > 在"用户以为关了的时候产品还在不在跑"上是同一个东西。
//
// 所以 `quit` 不是「关闭窗口」，而是一次**有结果的停止动作**：
// 调 `stop()` → **重新看一眼**产品是不是真的都不在了 → 观测到确实停了
// 才让进程退出；没停就**报出来**，并继续保持托盘在（用户还能再试一次）。
//
// ── 第二条纪律：菜单项的可用性必须来自**观测**，不能来自假设 ──
//
// "我记得我启动过了"不是一个可以拿来决定按钮灰不灰的依据——
// 用户可能在任务管理器里把进程杀了、可能上一次启动就失败了、
// 可能有别的实例在跑。菜单是用户与产品之间最短的那条反馈回路，
// 而它一旦说了假话，用户就失去了唯一的判断依据。
//
// ── 第三条纪律：打开 Workbench 要用**观测到的**地址 ──
//
// 用配置里的默认端口去拼 URL，在端口被占用而产品改用了别的端口时，
// 会打开一个打不开的页面。用户看到的是"浏览器打不开"，
// 而真正的原因在产品这边。
// ============================================================================

import { PRODUCT_STATE_TEXT } from './launcher.mjs'

/** 托盘动作的诊断码。 */
export const TRAY_CODES = Object.freeze({
  UNKNOWN_ACTION: 'TRAY_UNKNOWN_ACTION',
  ACTION_FAILED: 'TRAY_ACTION_FAILED',
  /** 退出时没能确认产品已停 —— 这是本模块存在的理由。 */
  QUIT_UNCONFIRMED: 'TRAY_QUIT_UNCONFIRMED',
  /** Workbench 地址还没观测到（打开一个打不开的页面比不打开更糟）。 */
  WORKBENCH_NOT_READY: 'TRAY_WORKBENCH_NOT_READY',
  OBSERVE_FAILED: 'TRAY_OBSERVE_FAILED',
  OPEN_FAILED: 'TRAY_OPEN_FAILED',
  BUSY: 'TRAY_BUSY',
  NOT_SUPPORTED: 'TRAY_NOT_SUPPORTED',
})

/** 菜单项 id。**顺序即菜单顺序。** */
export const TRAY_MENU_IDS = Object.freeze([
  'open-workbench', 'status', 'start', 'stop', 'quit',
])

/** 每个动作的标签。`quit` 的标签刻意不是「退出」而是更明确的一句。 */
export const TRAY_LABELS = Object.freeze({
  'open-workbench': '打开 Workbench',
  status: '查看状态',
  start: '启动',
  stop: '停止',
  // 「退出」两个字会被读成"关掉窗口"。托盘上真正发生的是"把产品停掉"。
  quit: '退出 Legion（会停止所有组件）',
})

/**
 * 观测到的运行时状态是否算「在跑」。
 *
 * **`unavailable` 不算。** 一个所有进程都死了、只是托盘图标还在的情况，
 * 必须被说成"没在跑"——否则用户会对着一个图标以为产品活着。
 */
export const RUNNING_STATES = Object.freeze(['ready', 'starting', 'degraded', 'upgrading'])

/** 观测到的运行时状态是否算「停下来了」。退出时要看到这个才算数。 */
export const STOPPED_STATES = Object.freeze(['unavailable'])

/**
 * 从一份**观测结果**构造菜单。纯函数。
 *
 * `observation` 形状：`{ runtimeState, workbenchUrl|null, detail? }`。
 *
 * 可用性全部由观测推出，且**停与启动互斥**——两个都能点会让用户
 * 点到一个与当前状态相反的动作。
 */
export function buildTrayMenu(observation = {}, { platform = process.platform } = {}) {
  const state = observation?.runtimeState ?? null
  const running = RUNNING_STATES.includes(state)
  const known = typeof state === 'string' && state !== ''
  const url = typeof observation?.workbenchUrl === 'string' && observation.workbenchUrl !== ''
    ? observation.workbenchUrl
    : null

  const stateText = known
    ? (PRODUCT_STATE_TEXT[state] ?? `未知状态（${state}）`)
    : '状态未知（还没读到）'

  return Object.freeze([
    Object.freeze({
      id: 'open-workbench',
      label: TRAY_LABELS['open-workbench'],
      // ★ 地址没观测到就**不可点**。打开一个打不开的页面，
      //   用户看到的是"浏览器打不开"，而原因在产品这边。
      enabled: url !== null,
      // 不可点时给出**为什么**——一个灰掉的菜单项不解释自己，
      // 用户只会以为坏了。
      disabledReason: url === null
        ? 'Workbench 地址还没探测到：现在打开只会得到一个打不开的页面'
        : null,
    }),
    Object.freeze({
      id: 'status',
      label: `${TRAY_LABELS.status}：${stateText}`,
      enabled: true,
      disabledReason: null,
    }),
    Object.freeze({
      id: 'start',
      label: TRAY_LABELS.start,
      // 状态未知时**允许**启动：那正是"用户觉得没跑"的时候，
      // 而 `start()` 自己会对已在跑的情况给出结论。
      enabled: known ? !running : true,
      disabledReason: known && running ? '已经在运行了' : null,
    }),
    Object.freeze({
      id: 'stop',
      label: TRAY_LABELS.stop,
      enabled: running,
      disabledReason: !running ? '当前没有在运行' : null,
    }),
    Object.freeze({
      id: 'quit',
      label: TRAY_LABELS.quit,
      // 退出**永远可点**：一个"因为状态不明所以退不出去"的托盘，
      // 会把用户困在一个他无法关闭的产品里。
      enabled: true,
      disabledReason: null,
    }),
  ])
}

/**
 * 托盘。
 *
 * `observe()` 每次动作**之前与之后**都会被调用——这是本模块的核心：
 * 菜单与结论都来自观测，而不是来自"我记得我做过什么"。
 */
export function createTray({
  observe = null,
  start = null,
  stop = null,
  openExternal = null,
  platform = process.platform,
  logger = null,
  now = () => Date.now(),
} = {}) {
  const diagnostics = []
  let disposed = false
  // 动作串行化：两个动作同时跑（用户连点、或"退出"与"停止"撞上）
  // 会让观测与动作交错，得出的结论谁也不算数。
  let busy = false
  const history = []

  function note(severity, code, message) {
    const d = Object.freeze({ severity, code, message, at: now() })
    diagnostics.push(d)
    if (typeof logger === 'function') logger(`[tray] ${message}`)
    return d
  }

  /** 观测一次。**观测失败不算"没问题"** —— 返回 null 让调用方去处理。 */
  async function observeOnce() {
    if (typeof observe !== 'function') {
      return { ok: false, observation: null, reason: '没有配置观测方式' }
    }
    try {
      const o = await observe()
      if (o === null || o === undefined || typeof o !== 'object') {
        return { ok: false, observation: null, reason: `观测返回了无法判读的结果：${JSON.stringify(o)}` }
      }
      return { ok: true, observation: o, reason: null }
    } catch (e) {
      return { ok: false, observation: null, reason: String(e?.message ?? e) }
    }
  }

  async function invoke(id) {
    if (disposed === true) {
      return Object.freeze({ ok: false, code: TRAY_CODES.ACTION_FAILED, message: '托盘已经释放' })
    }
    if (!TRAY_MENU_IDS.includes(id)) {
      const m = `不认识的动作：${id}`
      note('error', TRAY_CODES.UNKNOWN_ACTION, m)
      return Object.freeze({ ok: false, code: TRAY_CODES.UNKNOWN_ACTION, message: m })
    }
    if (busy === true) {
      // 不排队：一个排队的"停止"会在"启动"之后才执行，而用户
      // 看到的是最终状态与他的操作相反。
      const m = '托盘正在处理上一个动作'
      note('warn', TRAY_CODES.BUSY, m)
      return Object.freeze({ ok: false, code: TRAY_CODES.BUSY, message: m })
    }
    busy = true
    try {
      const r = await dispatch(id)
      history.push(Object.freeze({ id, at: now(), ok: r.ok === true }))
      return r
    } finally {
      busy = false
    }
  }

  async function dispatch(id) {
    // 每个动作都先观测一次：菜单的可用性来自观测，动作的前置也来自观测。
    const before = await observeOnce()
    if (before.ok !== true && id !== 'quit') {
      // 观测失败时**除了退出以外的动作都不做**：
      // 在不知道产品处于什么状态的情况下点"启动"或"停止"，
      // 结果可能与用户的意图相反。
      note('warn', TRAY_CODES.OBSERVE_FAILED, `动作「${id}」前观测失败：${before.reason}`)
      return Object.freeze({
        ok: false, code: TRAY_CODES.OBSERVE_FAILED,
        message: `读不到产品状态，因此没有执行「${TRAY_LABELS[id] ?? id}」：${before.reason}`,
      })
    }

    if (id === 'status') {
      const state = before.observation?.runtimeState ?? null
      const running = RUNNING_STATES.includes(state)
      const text = PRODUCT_STATE_TEXT[state] ?? (state === null ? '状态未知' : `未知状态（${state}）`)
      return Object.freeze({
        ok: true, id, state, text, running,
        message: `${text}${running ? '' : '（未在运行）'}`,
      })
    }

    if (id === 'open-workbench') {
      const url = before.observation?.workbenchUrl
      if (typeof url !== 'string' || url === '') {
        // ★ 不开一个打不开的页面。
        const m = 'Workbench 地址还没探测到，因此没有打开浏览器'
          + '（打开一个打不开的页面，用户看到的是"浏览器有问题"，而原因在产品这边）'
        note('warn', TRAY_CODES.WORKBENCH_NOT_READY, m)
        return Object.freeze({ ok: false, code: TRAY_CODES.WORKBENCH_NOT_READY, message: m })
      }
      if (typeof openExternal !== 'function') {
        const m = '没有配置打开浏览器的方式'
        note('warn', TRAY_CODES.NOT_SUPPORTED, m)
        return Object.freeze({ ok: false, code: TRAY_CODES.NOT_SUPPORTED, message: m })
      }
      try {
        await openExternal(url)
        return Object.freeze({ ok: true, id, url, message: `已打开 ${url}` })
      } catch (e) {
        const m = `打开 Workbench 失败：${String(e?.message ?? e)}`
        note('error', TRAY_CODES.OPEN_FAILED, m)
        return Object.freeze({ ok: false, code: TRAY_CODES.OPEN_FAILED, message: m })
      }
    }

    if (id === 'start') {
      if (typeof start !== 'function') {
        const m = '没有配置启动方式'
        note('warn', TRAY_CODES.NOT_SUPPORTED, m)
        return Object.freeze({ ok: false, code: TRAY_CODES.NOT_SUPPORTED, message: m })
      }
      let r = null
      try { r = await start() } catch (e) {
        const m = `启动失败：${String(e?.message ?? e)}`
        note('error', TRAY_CODES.ACTION_FAILED, m)
        return Object.freeze({ ok: false, code: TRAY_CODES.ACTION_FAILED, message: m })
      }
      if (r === null || r?.ok !== true) {
        const m = `启动没有成功：${r?.message ?? r?.phase ?? '启动动作没有给出正面结论'}`
        note('error', TRAY_CODES.ACTION_FAILED, m)
        return Object.freeze({ ok: false, code: TRAY_CODES.ACTION_FAILED, message: m })
      }
      return Object.freeze({ ok: true, id, message: '已启动' })
    }

    if (id === 'stop') {
      if (typeof stop !== 'function') {
        const m = '没有配置停止方式'
        note('warn', TRAY_CODES.NOT_SUPPORTED, m)
        return Object.freeze({ ok: false, code: TRAY_CODES.NOT_SUPPORTED, message: m })
      }
      let r = null
      try { r = await stop() } catch (e) {
        const m = `停止失败：${String(e?.message ?? e)}`
        note('error', TRAY_CODES.ACTION_FAILED, m)
        return Object.freeze({ ok: false, code: TRAY_CODES.ACTION_FAILED, message: m })
      }
      // 「停止」同样要**看结果**，而不是看返回值。
      const after = await observeOnce()
      const state = after.ok === true ? (after.observation?.runtimeState ?? null) : null
      if (after.ok !== true || !STOPPED_STATES.includes(state)) {
        const m = `发出停止之后，产品看起来**还在运行**`
          + `（观测到的状态：${after.ok === true ? (state ?? '未知') : `观测失败（${after.reason}）`}）`
        note('error', TRAY_CODES.ACTION_FAILED, m)
        return Object.freeze({ ok: false, code: TRAY_CODES.ACTION_FAILED, message: m, state })
      }
      return Object.freeze({ ok: true, id, state, message: '已停止' })
    }

    // ── quit ──
    //
    // 这是本模块的核心。退出是一次**有结果的停止动作**：
    // 停 → 再看一眼 → 确认都停了才算退。
    if (typeof stop === 'function') {
      try { await stop() } catch (e) {
        note('warn', TRAY_CODES.ACTION_FAILED, `退出时停止组件报错：${String(e?.message ?? e)}`)
      }
    }
    const after = await observeOnce()
    const state = after.ok === true ? (after.observation?.runtimeState ?? null) : null
    const confirmed = after.ok === true && STOPPED_STATES.includes(state)
    if (confirmed !== true) {
      // ★ **不确认就退出** = 把图标藏起来而进程还在跑。
      const m = '退出**没有完成**：没能确认产品已经停下来'
        + `（${after.ok === true ? `观测到的状态：${state ?? '未知'}` : `观测失败：${after.reason}`}）。`
        + '托盘会继续留着——现在把图标藏起来，只会让用户以为产品关了。'
      note('error', TRAY_CODES.QUIT_UNCONFIRMED, m)
      return Object.freeze({ ok: false, code: TRAY_CODES.QUIT_UNCONFIRMED, message: m, state })
    }
    return Object.freeze({ ok: true, id, state, exited: true, message: '已停止所有组件，可以退出' })
  }

  const tray = {
    /** 当前菜单。**每次都重新观测** —— 一个缓存过的菜单会说假话。 */
    async menu() {
      const o = await observeOnce()
      if (o.ok !== true) {
        note('warn', TRAY_CODES.OBSERVE_FAILED, `读不到状态，菜单按"未知"渲染：${o.reason}`)
      }
      const items = buildTrayMenu(o.ok === true ? o.observation : {}, { platform })
      return Object.freeze({
        items,
        observed: o.ok === true,
        observation: o.ok === true ? o.observation : null,
        reason: o.reason,
      })
    },
    invoke,
    /** 释放：之后所有动作都拒绝（一个释放后仍能点"启动"的托盘很危险）。 */
    dispose() { disposed = true; return Object.freeze({ disposed: true }) },
    status() {
      return Object.freeze({
        disposed, busy,
        supported: platform === 'win32' || platform === 'darwin' || platform === 'linux',
        acted: Object.freeze([...history]),
      })
    },
    diagnostics() { return Object.freeze([...diagnostics]) },
  }

  return Object.freeze(tray)
}
