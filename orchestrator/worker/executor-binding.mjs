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

/** 已注册的绑定（进程内单例）。一台机器同时只会有一个 DSH 运行时。 */
let binding = null

/**
 * 由 DSH 侧那一层调用，把宿主端口与自检装进来。
 *
 * 返回一个**注销函数**：绑定是进程级的副作用，而"装上了但卸载不掉"
 * 会让同一个进程里的第二次启动带着上一次的残留状态跑。
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
  const previous = binding
  // 记住**自己装上的那一份**（按引用比较），而不是拿 `previous` 去比：
  // 第一版写成 `binding === previous`，于是"从没绑定过 → 绑定 → 注销"
  // 这条最常见的路径反而注销不掉（`obj === null` 为假），
  // 而它在下一次绑定时表现为"上一个绑定没清干净"——一个只在特定顺序下出现的脏状态。
  const mine = Object.freeze({ ...input })
  binding = mine
  return function unbind() {
    // 只撤销自己装上的那一份：后装的那一份不该被先装的那份的注销函数抹掉。
    if (binding === mine) binding = previous
  }
}

/** 当前是否已绑定。诊断用——"没绑定"与"绑定了但端口坏了"是两件事。 */
export function dshRuntimeBound() {
  return binding !== null
}

/** 仅供用例：清空绑定，避免用例之间互相污染。 */
export function resetDshRuntimeBinding() {
  binding = null
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
  if (binding === null) {
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
  const { host, selfCheck, canRead, ...rest } = binding
  void env
  return createProductionExecutor({ host, selfCheck, canRead, post, get, ...rest })
}

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
