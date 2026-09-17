// runtime/dsh-composition/run-identity.mjs
// ============================================================================
// PRT-214 缺口②的**安装点**：把一次 Run 的授权身份装到**那个 Run 的 Agent** 上。
//
// ## 这一格缺的是什么
//
// `assembleEnforcement()` 只装一次（`root.mjs:351`），于是 `scope` 是**进程**的身份。
// 而 `scope` 进的是 `canonicalOperationHash`（`enforcement.mjs:86`），
// 也就是审批绑定与审计归属——一个进程服务多个空间时，别的空间的事被记在**这一个**
// 空间名下，不报错、只是错标。
//
// ## 为什么落点与 hard floor **逐字相同**
//
// `run-floor.mjs` 已经把这一整条解法写过一遍（PRT-214 缺口①），本模块照抄它：
//
//   · 装配级是进程级的，而 Runtime 进程长命、会服务很多次 Run；
//   · DSH 的 `ctx.tools.guard()` 文档逐字写着「a plain-context guard applies globally;
//     one registered through `agent.ctx` applies only to that agent」
//     （`packages/core/tools/src/index.ts:1108`）；而 `ToolRuntime.guardReason()`
//     读的是 `exec.agent`（同文件 `:1128`）；
//   · 一次 Run 的目标 Agent 恰好只有一个 ⇒「按 Run 分开」与「按 Agent 分开」
//     在这里是**构造上**同一件事，不是靠纪律；
//   · Agent preset / 会话级挂载**不许**用（spec §6.9 `:500`）：preset 可替换、可
//     shadow，把不可绕过的判定放进去等于让判定取决于当前挂了哪个 preset。
//
// ## 与 hard floor 的一处**实质差别**：这里不需要 ctx 缝合点
//
// floor 要装两个面（`ctx.tools.guard` + `tools/pre-execute`），所以它的安装会因
// "目标 Agent 的作用域里没有那个缝合点"而失败并**拒绝让这个 Run 起跑**。
//
// 身份不是这样：它不新增任何判定点，只是**改一份已经存在的判定读到的值**
// （桥投影时的 `context`）。所以本模块的安装只需要 Agent 的**对象身份**，
// 不需要 ctx 上的任何服务。这带来一个好处与一条纪律：
//
//   · 好处：它**没有**"装一半"的中间态，于是也不需要 floor 那套 fail-closed 的
//     拒绝起跑——一个装不上的身份覆盖不会让强全面少一个面。
//   · 纪律：正因为装得上，**"装上去了但桥没读"**才是这里唯一会静默失效的形状。
//     所以桥那一侧有一条按对象身份取覆盖的缝（`identityOverlayForExecution`），
//     而它有一条"两个 Run 各带各的身份"的判据（见 `.test.mjs` 例④）。
//
// ## ★ 载体为什么走 `agentOptions`（同 floor，理由也一样）
//
// 引擎发布子 Agent 的顺序是 `agents.create()`（内部 `setup` → `agent/created`）
// → `create()` 返回 → `followup(prompt)` 启动第一轮。也就是说**第一轮在 `start()`
// 结算之前就开始了**——"拿回句柄之后立刻装"落在第一轮开始之后。
//
// 于是载荷走 `agentOptions`：`resolveChildAgentOptions()` 把 `requested` 原样摊开，
// Legion 的 `agent/created` 监听器在**创建窗口内**就把它装上——那是**顺序**保证，
// 不是时序侥幸。按**对象身份**配对因此是精确的：并发两个 Run 各带各的载荷，
// 不可能串台；长命父级的第二个 Run 也不可能继承第一个 Run 的身份。
// ============================================================================

import {
  RUN_IDENTITY_CODES,
  RUN_IDENTITY_STATES,
  RUN_IDENTITY_WIRE_VERSION,
  readRunIdentity,
} from '../contracts/run-identity.mjs'

/** 安装方式或读法变化时递增。 */
export const RUN_IDENTITY_INSTALL_VERSION = 1

/** 安装点的**构造期/安装期**失败码。闭集：每种修法不同。 */
export const RUN_IDENTITY_INSTALL_CODES = Object.freeze({
  /** 端口载荷不是对象。 */
  NOT_AN_OBJECT: 'RUN_IDENTITY_INSTALL_NOT_AN_OBJECT',
  /** 端口载荷的 `state` 不在闭集里。 */
  UNKNOWN_STATE: 'RUN_IDENTITY_INSTALL_UNKNOWN_STATE',
  /** 端口载荷上有我不认识的键。 */
  UNKNOWN_KEY: 'RUN_IDENTITY_INSTALL_UNKNOWN_KEY',
  /** 要装身份的那个东西不是 Agent（拿不到对象身份）。 */
  NOT_AN_AGENT: 'RUN_IDENTITY_INSTALL_NOT_AN_AGENT',
})

/** 端口载荷允许出现的键。**闭合**：多一个就拒（同 `readRunIdentity` 的理由）。 */
export const RUN_IDENTITY_PORT_KEYS = Object.freeze(['state', 'identity'])

/**
 * 适配器→宿主端口那一层的选项名（`startRun(provider, { enforcementIdentity })`）。
 *
 * 与 floor 的同名常量对称：它属于**Legion 自己的端口契约**
 * （`runtime/adapters/dsh/port.mjs` 的文件头），不在 DSH 的 `SubagentStartRequest` 里。
 */
export const RUN_IDENTITY_RUN_OPTION_KEY = 'enforcementIdentity'

/**
 * 身份**随子 Agent 的创建请求**一起走的那个键（放在 `agentOptions` 里）。
 *
 * 与 `RUN_FLOOR_CHILD_OPTION_KEY` 平行的两个键，而不是一个合并的对象：
 * 合并之后"这次没给下限"与"这次没给身份"会共用一个缺席读数，
 * 而两者的处置完全不同（前者 fail closed 拒绝一切工具，后者回落进程级身份）。
 */
export const RUN_IDENTITY_CHILD_OPTION_KEY = 'legionRunIdentity'

function installError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 读适配器交给端口的**已解析**载荷。
 *
 * 形状判定**不在这里另写一份**：它被重新包成一份线上载荷交给 `readRunIdentity()`——
 * 于是"什么算一份合法身份覆盖"全仓库只有一处定义。
 *
 * @param {unknown} payload
 * @returns {{state: string, overlay: Readonly<object>|null, code: string|null, message: string|null}}
 */
export function readRunIdentityPortPayload(payload) {
  const refuse = (code, message) => Object.freeze({
    state: RUN_IDENTITY_STATES.REFUSED, overlay: null, code, message,
  })
  if (!isPlainObject(payload)) {
    return refuse(RUN_IDENTITY_INSTALL_CODES.NOT_AN_OBJECT,
      `端口上的身份载荷必须是对象，收到 ${payload === null ? 'null' : Array.isArray(payload) ? 'array' : typeof payload}`)
  }
  for (const key of Object.keys(payload)) {
    if (!RUN_IDENTITY_PORT_KEYS.includes(key)) {
      return refuse(RUN_IDENTITY_INSTALL_CODES.UNKNOWN_KEY,
        `端口上的身份载荷有我不认识的键 ${JSON.stringify(key)}（只认识 ${RUN_IDENTITY_PORT_KEYS.join(' / ')}）。`
        + '忽略它等于猜它是装饰，而猜错的代价落在**归属**上')
    }
  }
  if (payload.state === RUN_IDENTITY_STATES.ABSENT) {
    if (payload.identity !== undefined) {
      return refuse(RUN_IDENTITY_INSTALL_CODES.UNKNOWN_STATE,
        '端口上的身份载荷说 state 是 absent，却又带了一份 identity——'
        + '"没有"与"有一份、只是它不生效"必须分得开')
    }
    return Object.freeze({
      state: RUN_IDENTITY_STATES.ABSENT,
      overlay: null,
      code: RUN_IDENTITY_CODES.NOT_SUPPLIED,
      message: '这次 Run 没有身份覆盖（`enforcementIdentity` 不在 RunRequest 上）',
    })
  }
  if (payload.state !== RUN_IDENTITY_STATES.INSTALLED) {
    return refuse(RUN_IDENTITY_INSTALL_CODES.UNKNOWN_STATE,
      `端口上的身份载荷 state 是 ${JSON.stringify(payload.state)}，本实现只认识 `
      + `${JSON.stringify(Object.values(RUN_IDENTITY_STATES))}`)
  }
  // 借用线上那一份形状判定（**同一份实现**，不是抄一份）。
  const asWire = readRunIdentity({
    version: RUN_IDENTITY_WIRE_VERSION, ...(isPlainObject(payload.identity) ? payload.identity : {}),
  })
  if (asWire.state !== RUN_IDENTITY_STATES.INSTALLED) {
    return refuse(RUN_IDENTITY_INSTALL_CODES.UNKNOWN_STATE,
      `端口上的身份载荷说 state 是 installed，但其中的 identity 解释不通（${asWire.code}）：${asWire.message}`)
  }
  return Object.freeze({
    state: RUN_IDENTITY_STATES.INSTALLED,
    overlay: asWire.overlay,
    code: null,
    message: null,
  })
}

/**
 * 造一次 Run 的身份装置。
 *
 * ★ 与 floor 不同，这里**没有**"拒绝一切"那一档，理由写在文件头：
 * 身份不新增判定点，只改一份既有判定读到的值，所以它没有可以 fail closed 的面。
 * `refused` 那一档的处置是**不安装**，并且**带码**——桥那一侧因此读到的是
 * 进程级身份，而这次"想覆盖但读不懂"会出现在安装读数里，不是无声无息。
 *
 * @param {unknown} payload 适配器交给端口的已解析载荷
 * @returns {{state: string, code: string|null, message: string|null, overlay: Readonly<object>|null}}
 */
export function createRunIdentityInstallation(payload) {
  const reading = readRunIdentityPortPayload(payload)
  return Object.freeze({
    state: reading.state,
    code: reading.code,
    message: reading.message,
    // `overlay: null` 是**"这次没有身份覆盖"**这个读数本身，不许被一份
    // 合成的进程级身份冒名顶替：那会让"没人给"与"给的就是进程级"变成同一个东西。
    overlay: reading.overlay,
  })
}

/**
 * 把一个已造好的身份装置装到**那个 Agent** 上。
 *
 * 只按**对象身份**登记（`WeakMap`），所以：
 *   · 第二个 Run 是另一个 Agent ⇒ 另一份身份，**不可能**继承第一个 Run 的；
 *   · Agent 被回收时条目自然消失，没有需要手工释放的资源。
 *
 * 幂等：同一个 Agent 上重复安装返回**第一次**那份读数。重装会让"这次 Run 的身份"
 * 取决于安装顺序，而那是并发下最难查的一类错：
 *
 *   > 一个"后装的覆盖先装的"的登记簿，
 *   > 与一个"并发两个 Run 互相改对方身份"的实现，是同一个东西——
 *   > 只不过前者在串行跑的时候完全正常。
 *
 * @param {object} o
 * @param {object} o.agent 引擎交回来的 in-process 子 Agent
 * @param {object} o.installation `createRunIdentityInstallation()` 的产物
 * @param {(e: string) => void} [o.log] 诊断输出口（默认不输出）
 * @returns {{state: string, code: string|null, overlay: Readonly<object>|null, agentId: string|null,
 *            dispose: () => void}}
 */
export function installRunIdentityIntoAgent({ agent, installation, log = null } = {}) {
  if (installation === null || typeof installation !== 'object' || !('overlay' in installation)) {
    throw installError(RUN_IDENTITY_INSTALL_CODES.NOT_AN_OBJECT,
      'installRunIdentityIntoAgent 需要 createRunIdentityInstallation() 的产物')
  }
  if (agent === null || typeof agent !== 'object') {
    throw installError(RUN_IDENTITY_INSTALL_CODES.NOT_AN_AGENT,
      '要装身份的那个东西不是 Agent（拿不到对象身份）：身份的落点就是这个对象本身')
  }

  const existing = INSTALLED.get(agent)
  if (existing !== undefined) return existing

  const reading = Object.freeze({
    state: installation.state,
    code: installation.code,
    overlay: installation.overlay,
    agentId: agent.id === undefined ? null : String(agent.id),
    dispose: () => { INSTALLED.delete(agent) },
  })
  INSTALLED.set(agent, reading)

  if (installation.state === RUN_IDENTITY_STATES.INSTALLED) {
    log?.(`[run-identity] v${RUN_IDENTITY_INSTALL_VERSION} 已把这次 Run 的身份装到 Agent `
      + `${reading.agentId ?? '<unknown>'}（覆盖 ${Object.keys(installation.overlay ?? {}).join(' / ')}）`)
  } else {
    // ★ 缺席与拒绝**都要打印**，而且打印的是码与理由：它们在桥那一侧的读数
    //   完全一样（都用进程级身份），所以日志是这两件事唯一分得开的地方。
    log?.(`[run-identity] v${RUN_IDENTITY_INSTALL_VERSION} Agent ${reading.agentId ?? '<unknown>'} `
      + `没有身份覆盖（state=${installation.state}`
      + `${installation.code === null ? '' : ` code=${installation.code}`}）：${installation.message ?? ''}`)
  }
  return reading
}

/** 已安装的读数（按 Agent 身份；用例与诊断用，**不放活对象**）。 */
const INSTALLED = new WeakMap()

/** 该 Agent 上装过没有（只读观察）。 */
export function runIdentityInstalledOn(agent) {
  return INSTALLED.has(agent)
}

/** 读该 Agent 上的身份覆盖（没装过 → `undefined`）。 */
export function runIdentityOverlayOf(agent) {
  return INSTALLED.get(agent)?.overlay ?? undefined
}

/**
 * ★ 桥那一侧的**唯一取用缝**：按执行对象取这次调用的身份覆盖。
 *
 * 取不到（这次执行不属于任何装过身份的 Agent，例如进程级的全局判定的路径）
 * 就返回 `undefined`——调用方因此拿到**原样**的进程级上下文，
 * 而不是一个"空覆盖"。空覆盖与没有覆盖在授权哈希上是两回事。
 *
 * @param {unknown} execution DSH 的执行对象（`exec.agent` 指向它所属的 Agent）
 * @returns {Readonly<object>|undefined}
 */
export function identityOverlayForExecution(execution) {
  const agent = execution !== null && typeof execution === 'object' ? execution.agent : undefined
  if (agent === undefined || agent === null || typeof agent !== 'object') return undefined
  return runIdentityOverlayOf(agent)
}

/** 读端口选项上的身份载荷（**缺席就是 `undefined`**，不补默认值）。 */
export function runIdentityOptionOf(options) {
  if (options === null || typeof options !== 'object') return undefined
  return options[RUN_IDENTITY_RUN_OPTION_KEY]
}

/**
 * 把身份载荷挂到这次创建请求的 `agentOptions` 上，返回**新**的 options
 * （不改原对象：端口读到的与适配器交出去的必须能分别断言）。
 */
export function withRunIdentityCarrier(options, payload) {
  const base = options !== null && typeof options === 'object' ? options : {}
  const prior = base.agentOptions !== null && typeof base.agentOptions === 'object' ? base.agentOptions : {}
  return {
    ...base,
    agentOptions: { ...prior, [RUN_IDENTITY_CHILD_OPTION_KEY]: payload },
  }
}

/** 读一个**已创建**的 Agent 身上的身份载体（不在就是 `undefined`）。 */
export function runIdentityCarrierOf(agent) {
  const options = agent === null || typeof agent !== 'object' ? undefined : agent.options
  if (options === null || typeof options !== 'object') return undefined
  return options[RUN_IDENTITY_CHILD_OPTION_KEY]
}

/**
 * 装载期自检：**算出来的产物**，不是一个布尔。
 *
 * 三条读数各自钉着一件会静默失效的事：
 *   · `absent` 与"空覆盖"必须是**两个不同的 state**；
 *   · `absent` 的 `overlay` 必须是 `null`（不能被一份合成的进程级身份冒名顶替）；
 *   · 端口载荷里 `installed` 却解释不通的 identity，必须**具名拒绝**而不是被当成缺席。
 */
export const RUN_IDENTITY_INSTALL_CHECKED = Object.freeze({
  version: RUN_IDENTITY_INSTALL_VERSION,
  portStates: Object.freeze(Object.values(RUN_IDENTITY_STATES)),
  absentState: createRunIdentityInstallation({ state: RUN_IDENTITY_STATES.ABSENT }).state,
  absentOverlayIsNull: createRunIdentityInstallation({ state: RUN_IDENTITY_STATES.ABSENT }).overlay === null,
  installedState: createRunIdentityInstallation({
    state: RUN_IDENTITY_STATES.INSTALLED, identity: { version: RUN_IDENTITY_WIRE_VERSION, scope: 's' },
  }).state,
  installedOverlayScope: createRunIdentityInstallation({
    state: RUN_IDENTITY_STATES.INSTALLED, identity: { version: RUN_IDENTITY_WIRE_VERSION, scope: 's' },
  }).overlay.scope,
  // 说 installed 却带一份解释不通的 identity：**拒绝**，不是"当成缺席"。
  brokenInstalledCode: createRunIdentityInstallation({
    state: RUN_IDENTITY_STATES.INSTALLED, identity: { version: RUN_IDENTITY_WIRE_VERSION },
  }).code,
  // 未知键：拒绝。
  unknownKeyCode: createRunIdentityInstallation({
    state: RUN_IDENTITY_STATES.INSTALLED,
    identity: { version: RUN_IDENTITY_WIRE_VERSION, scope: 's' },
    extra: 1,
  }).code,
})
