// orchestrator/worker/executor-binding.mjs
// ============================================================================
// 生产执行引擎的**绑定**（PRT-253 的入口侧）
//
// ## 这个文件为什么存在
//
// `createProductionExecutor`（`./executor.mjs`）已经能把一个真实的执行引擎
// 接起来，但它需要两样外部东西：
//
//   ① **DSH 宿主端口**（`startRun` / `probeRuntime`）——引擎的唯一通道
//   ② **启动自检结论**——补丁层 / 运行时能力 / 沙箱管制是否真的生效
//
// 这两样都只能由**跑在 DSH 进程里**的那一层提供（`runtime/dsh-composition/`，
// PRT-214/215 的地盘）。而 orchestrator worker 是一个**独立进程**。
//
// 于是有两种做法，本文件选后者：
//
//   ✗ worker 自己去 import DSH 包、自己去探测。
//     那会让 `orchestrator/` 依赖引擎的具体形状（阶段 1 的努力是
//     「不启动 DSH 即可测完整编排」），而且两处探测会漂移。
//   ✓ worker 留一个**注册口**，由 DSH 侧那一层把端口与自检装进来。
//     注册口是窄的、可假的、可脚本化的——与 `runtime/adapters/dsh/port.mjs`
//     同一条设计取舍（注入端口，不 import 引擎包）。
//
// ## 今天它是空的时候，行为是什么
//
// **拒绝，并说清缺什么。** 不是"降级成一个能干活的引擎"：
//
//   > 一个强制面没生效却能跑的引擎，与一个正常的引擎在行为上完全一样——
//   > 直到它执行了第一次真实的写操作。
//
// 所以 `productionExecutorProvider()` 在没有注册时返回
// `HOST_PORT_REQUIRED` / `SELF_CHECK_INCOMPATIBLE`，而 worker
// **照常启动、写状态文件、不认领任何任务**，并把这条理由带进启动结果。
//
// 这条理由是会**变**的：DSH 侧装上端口之后，同一个入口不需要改一行代码
// 就开始真的执行了。这正是"注册口"而不是"写死一条拒绝"的意义。
// ============================================================================

import { createProductionExecutor, EXECUTOR_CODES } from './executor.mjs'

/**
 * 已注册的绑定。**一个栈，不是一个槽。**
 *
 * ## 为什么不能用"当前值 + previous 链"
 *
 * 前两版都是单槽 + `previous` 链，两次都错在同一个地方：
 *
 * ```js
 * binding = mine
 * return () => { if (binding === mine) binding = previous }
 * ```
 *
 * 问题出在**注销顺序**上。装配 A、再装配 B，然后注销 A：
 * `binding` 是 B、不等于 A 的 `mine`，所以什么都不做——看起来对。
 * 但 A 的注销**没有留下任何痕迹**。等 B 被注销时，它把 `binding` 写回
 * `previous`，也就是 A——**于是一份已经被自己主人注销掉的绑定复活了**。
 *
 * 具体后果：`productionExecutorProvider()` 会返回 `ok: true` 与 A 的宿主端口，
 * 而 A 的主人已经拆掉了它那一侧。这正是"拒绝、却仍然递给 worker 一个能用的引擎"
 * 那一类里最坏的一种——**没有东西会报错**。
 *
 * 一个栈没有这个问题：注销是"把自己从活跃集合里删掉"，
 * 与顺序无关、幂等、且不会复活任何东西。
 */
let bindingStack = []

/** 当前生效的绑定（栈顶）。 */
function currentBinding() {
  return bindingStack.length === 0 ? null : bindingStack[bindingStack.length - 1]
}

/**
 * 由 DSH 侧那一层调用，把宿主端口与自检装进来。
 *
 * 返回一个**注销函数**：绑定是进程级的副作用，而"装上了但卸载不掉"
 * 会让同一个进程里的第二次启动带着上一次的残留状态跑。
 * 注销函数**幂等**，且与调用顺序无关。
 *
 * @param {object} input
 * @param {object} input.host DSH 宿主端口（`startRun` / `probeRuntime`）。
 * @param {() => Promise<object>} input.selfCheck 启动自检。
 * @param {(meta: object) => any} input.canRead 装配阶段的权限判定。
 * @param {object} [input.rest] 其余透传给 `createProductionExecutor`。
 */
export function bindDshRuntime(input = {}) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('bindDshRuntime 需要对象')
  }
  if (typeof input.selfCheck !== 'function') {
    // **自检是必填的，不给默认值。** 一个"没给自检就当通过"的默认值
    // 会让这个注册口本身变成绕过 PRT-215 的入口。
    throw new TypeError('bindDshRuntime 需要 selfCheck：不给默认值——"没检查"不等于"没问题"')
  }
  if (typeof input.canRead !== 'function') {
    throw new TypeError('bindDshRuntime 需要 canRead：权限判定由调用方显式给出，不猜')
  }
  const mine = Object.freeze({ ...input })
  bindingStack = [...bindingStack, mine]
  return function unbind() {
    // 按引用删掉自己那一份。**只删自己**，于是：
    //   · 后装的那一份不会被先装的那份抹掉；
    //   · 先装的那一份的注销也不会在栈里留下一个"稍后复活"的洞；
    //   · 重复调用是 no-op（幂等）。
    const i = bindingStack.indexOf(mine)
    if (i === -1) return
    bindingStack = [...bindingStack.slice(0, i), ...bindingStack.slice(i + 1)]
  }
}

/** 当前是否已绑定。诊断用——"没绑定"与"绑定了但端口坏了"是两件事。 */
export function dshRuntimeBound() {
  return currentBinding() !== null
}

/** 仅供用例：清空绑定，避免用例之间互相污染。 */
export function resetDshRuntimeBinding() {
  bindingStack = []
}

/**
 * 生产入口用的执行引擎提供者。
 *
 * 返回判别式联合，形状与 `runWorkerProcess` 的 `executorProvider` 一致。
 *
 * @param {object} io
 * @param {(path: string, body: object) => Promise<{status:number, body:object}>} io.post
 * @param {(path: string) => Promise<{status:number, body:object}>} io.get
 * @param {object} [io.env] 环境变量（用于从进程环境构造 hub 的 post/get）
 */
export async function productionExecutorProvider(io = {}) {
  const { post, get, env = process.env } = io
  if (currentBinding() === null) {
    return Object.freeze({
      ok: false,
      code: EXECUTOR_CODES.HOST_PORT_REQUIRED,
      message: 'DSH 运行时尚未绑定（没有宿主端口，也没有启动自检结论）。' +
        '绑定由 runtime/dsh-composition 在 DSH 进程内完成——' +
        'worker 在一个独立进程里，import 不到也探测不到那台引擎',
      reasons: Object.freeze([]),
    })
  }
  if (typeof post !== 'function' || typeof get !== 'function') {
    return Object.freeze({
      ok: false,
      code: EXECUTOR_CODES.BAD_WIRING,
      message: 'productionExecutorProvider 需要 post 与 get：前者冻结上下文，后者读回冻结的正文',
      reasons: Object.freeze([]),
    })
  }
  const { host, selfCheck, canRead, ...rest } = currentBinding()

  // 记账主体，按**可信度**从高到低取：
  //   ① 调用方显式传入（部署可以点名一个非 worker 身份）
  //   ② `LEGION_BUDGET_ACTOR`（想换成一个业务身份时用它）
  //   ③ `LEGION_WORKER_ID`（这个进程本来就被赋予的身份，真实且可追溯）
  //   ④ 都没有 → **不建闸门**，且 `budgetState` 会是 `'not-gated'`
  //
  // ①② 缺省不影响正确性，只是"谁花的钱"记得粗一点；
  // ③ 是让闸门在真实部署里**真的会被建起来**的那一层（见上面的说明）。
  // ④ 是"没接"，它必须可见——不与"预算充足"同形。
  const clean = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
  const budgetActor = clean(io.budgetActor)
    ?? clean(env?.[BUDGET_ACTOR_ENV])
    ?? clean(env?.[BUDGET_ACTOR_FALLBACK_ENV])

  return createProductionExecutor({
    host, selfCheck, canRead, post, get, ...rest,
    ...(budgetActor === null ? {} : { budgetActor }),
  })
}

/**
 * 预算账本的**记账主体**（谁花的钱）来自这个环境变量。
 *
 * 这是接缝上补出来的一个真问题：PRT-510 的套件把 `budgetActor` 直接传给
 * `createProductionExecutor`，而**生产路径根本不经过那一步**——
 * `productionExecutorProvider` 只从 binding 里取 `{host, selfCheck, canRead}`，
 * `budgetActor` 没有来源。于是：闸门代码是对的、套件是全绿的、
 * 而**通过生产路径它永远不会被建起来**。
 *
 *   > 「注册了、跑了、过了」≠「这条路被测过」。
 *
 * 名字用 `LEGION_` 前缀：这是 Legion 自己的配置面，
 * 而 `TEAM_HUB_*` 是共享变量族（见 `orchestrator/config-schema.mjs`）。
 */
export const BUDGET_ACTOR_ENV = 'LEGION_BUDGET_ACTOR'

/**
 * 记账主体的**兜底来源**：worker 自己的身份。
 *
 * ## 为什么这里可以给兜底，而 `budgetActor` 本身不给默认值
 *
 * 这两件事不一样：
 *
 *   · 一个编出来的占位符（`'anonymous'`、`'system'`）会让
 *     「没人签名」与「某人签了名」在账本里长得一样——所以不给。
 *   · `LEGION_WORKER_ID` 是**这个进程已经被赋予的身份**，
 *     它本来就要出现在 claim / heartbeat / transition 的每一笔记录里。
 *     用它当记账主体，记下的是一个**真实且可追溯**的主体。
 *
 * 而且不给这一层兜底的代价很具体：**闸门在真实部署里永远不会被建起来**
 * （Launcher 还没有往 worker 的环境里写 `LEGION_BUDGET_ACTOR`），
 * 于是一次预算都没预留过——那正是 PRT-510 要修的东西。
 *
 *   > 一个默认不生效的闸门，与一个不存在的闸门，在"有没有拦住过"上是同一个答案。
 *
 * 两个都没有时仍然**不建闸门**，并且这件事在结果里是可见的
 * （`budgetState: 'not-gated'`）。
 */
export const BUDGET_ACTOR_FALLBACK_ENV = 'LEGION_WORKER_ID'

/**
 * 从 worker 的环境变量造出 hub 的 `post` / `get`。
 *
 * 只做两件事：带 token、把响应解成 `{ status, body }`。
 * **不吞异常**：网络不通时抛出去，让上层按"路由不可达"处理——
 * 一次读不到快照与一次"快照里没有正文"是完全不同的故障。
 *
 * @param {object} input
 * @param {string|null} input.hubUrl `TEAM_HUB_URL`
 * @param {string|null} input.hubToken `TEAM_HUB_TOKEN`
 * @param {typeof fetch} [input.fetchImpl]
 */
export function hubIo({ hubUrl, hubToken, fetchImpl = globalThis.fetch } = {}) {
  if (typeof hubUrl !== 'string' || hubUrl.trim() === '') {
    // 没有 hub 就没有上下文可冻结，也就没有东西可执行。
    // 返回一个**会拒绝的** io，而不是一个"看起来能用"的空壳：
    // 空壳会让每一次执行都失败在一个与真因无关的地方。
    throw new TypeError('hubIo 需要 hubUrl（TEAM_HUB_URL）：执行引擎要凭它冻结上下文、读回冻结的正文')
  }
  const root = hubUrl.replace(/\/+$/, '')
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${hubToken ?? ''}` }

  async function decode(res) {
    const text = await res.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }
    return { status: res.status, body }
  }

  return Object.freeze({
    async post(path, body) {
      const res = await fetchImpl(root + path, { method: 'POST', headers, body: JSON.stringify(body) })
      return decode(res)
    },
    async get(path) {
      const res = await fetchImpl(root + path, { method: 'GET', headers })
      return decode(res)
    },
  })
}

/**
 * 入口直接用的一层：读环境 → 造 io → 交给 `productionExecutorProvider`。
 *
 * `TEAM_HUB_URL` 缺省时返回 `BAD_WIRING` 而不是抛错：worker 仍要能起来、
 * 写状态文件、如实报告自己干不了活。
 */
export async function productionExecutorProviderFromEnv({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const hubUrl = env.TEAM_HUB_URL ?? null
  const hubToken = env.TEAM_HUB_TOKEN ?? null
  if (hubUrl === null) {
    return Object.freeze({
      ok: false,
      code: EXECUTOR_CODES.BAD_WIRING,
      message: '未设置 TEAM_HUB_URL：执行引擎要凭它冻结上下文、读回冻结的正文。' +
        '没有数据面就没有可执行的上下文',
      reasons: Object.freeze([]),
    })
  }
  let io
  try {
    io = hubIo({ hubUrl, hubToken, fetchImpl })
  } catch (e) {
    return Object.freeze({ ok: false, code: EXECUTOR_CODES.BAD_WIRING, message: e.message, reasons: Object.freeze([]) })
  }
  return productionExecutorProvider({ post: io.post, get: io.get, env })
}
