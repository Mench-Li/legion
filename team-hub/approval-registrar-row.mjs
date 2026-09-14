// team-hub/approval-registrar-row.mjs
// ============================================================================
// PRT-214（续）：把**审批端口工厂**注册进 DSH 进程的那一段接线。
//
// ## 补的是哪一截
//
// `runtime/dsh-composition/plugins/root-row.mjs` 早就把"缺一个生产注册方"这件事
// 做成了**具名拒绝**：没有工厂时它在 `apply` 期抛
// `ENFORCEMENT_ROOT_ROW_NO_APPROVAL_PORT_FACTORY`，不装一个没有审批口的半根。
// 真 DSH 进程里的读数就是这样（原文见
// `docs/superpowers/prt/PRT-214-enforcement-composition-root.md` §9）：
//
//     exit=1  identity env set, no approval-port factory
//       ENFORCEMENT_ROOT_BAD_WIRING（内层 ENFORCEMENT_ROOT_ROW_NO_APPROVAL_PORT_FACTORY）
//       at rowError (root-row.mjs:110) ← Object.apply (root-row.mjs:379)
//
// 也就是说：**拒绝是对的，而生产部署上这一行永远装不上**。
//
//   > 一个"写好了、也验证过会拒绝"的注册缝，
//   > 与一个"没有任何东西去注册"的注册缝，在运行的部署上是同一个东西——
//   > 只不过前者的用例是绿的。
//
// 本模块是那个注册方：它住在 `team-hub/` 这一侧（方向见下），在**模块求值期**
// 调用 `setApprovalPortFactory(...)`，并默认导出**真的那个** root row 插件对象。
//
// ## ★ 为什么它是"root 行自己的模块"，而不是补丁层里的第二行
//
// 直觉写法是再加一行 `legion-enforcement-approval-registrar`，在模块求值期注册。
// 它**不安全**，而且这不是推测——是在**真 DSH 进程**里量出来的 2×2 矩阵
// （探针脚本与原始读数见 `docs/superpowers/prt/PRT-214-enforcement-composition-root.md` §10）：
//
//   | 装配方式 | 注册前挂起 | root-first | registrar-first |
//   | --- | --- | --- | --- |
//   | 补丁层第二行 | 无 | 6/6 装上 | 6/6 装上 |
//   | 补丁层第二行 | 顶层 `await` 500ms | **6/6 拒绝** | **6/6 拒绝** |
//   | **root 行自己的模块图** | 顶层 `await` 500ms | 6/6 装上 | 6/6 装上 |
//
// 两行都要读清楚：
//
//   · 第二行那一路之所以在"无挂起"时看着好好的，是因为 Loader 用
//     `await Promise.allSettled(config.map((o) => this.create(o)))` **并发**创建所有行
//     （`@deepseek-ai/cordis-plugin-loader/lib/index.js:97`），两个模块都不挂起时
//     它们几乎同时求值完，于是**碰巧**注册先于 `apply`。行序甚至都不是那个变量：
//     挂起之后 root-first 与 registrar-first **一样**拒绝。
//   · 而注册行只要做一次**合法的**顶层 `await`（占位、读配置、连一个慢端口——都合法），
//     root 行就先 `apply` 并拒绝。也就是说：第二行那条路的成立条件是
//     "注册行的模块求值不挂起"，而这条条件**没有任何东西保证**。
//
// 换成本文件这种形状，注册就在 root 行**自己的模块图**里。Node 的 ESM 语义保证
// 被 import 的模块先求值完，才轮到 import 它的那个模块——所以无论补丁层怎么排、
// 无论 Loader 怎么并发、无论中间挂起多久，`setApprovalPortFactory()` 都已经执行过了。
// 矩阵的第三行就是这条保证的读数：**同样的 500ms 挂起，换成同模块图就 6/6 装上**。
//
//   > 一个"靠补丁行顺序 / 靠兄弟模块不挂起才成立"的注册，
//   > 与一个"靠 ESM 求值顺序成立"的注册，在前者碰巧对的那次运行里是同一个东西——
//   > 只不过前者会在别人的机器上偶发地红。
//
// 第三条候选（注册行发布服务、root 行 `inject` 它）是行序无关的，但要**放弃**一样东西：
// root 行会停在 `pending (waiting for service: …)`，于是"注册方没挂上"从 root 行自己
// 那条具名拒绝（`ENFORCEMENT_ROOT_ROW_NO_APPROVAL_PORT_FACTORY`）变成一句挂载审计。
// 两者要值班的人去查的东西不同，而且 /G 那条反向对照也就测不出来了。
//
// 所以 `runtime/dsh-composition/patch-layer.mjs` 的 root 行 `module` 指向本文件，
// 本文件默认导出 `plugins/root-row.mjs` 的 default——**不是替身**，是同一次模块
// 求值里同一个对象（`team-hub/approval-registrar-row.test.mjs` 按 `===` 钉住）。
//
// ## ★ 方向：team-hub/ → runtime/dsh-composition/（不是反过来）
//
// 本文件 import `runtime/dsh-composition/plugins/root-row.mjs`。反过来的那条
// （`runtime/` import `team-hub/`）会成环：`team-hub/approval-port.mjs` →
// `team-hub/tool-request-bridge.mjs` → `runtime/dsh-composition/tool-args.mjs`。
// 这正是注册方必须住在 `team-hub/` 这一侧的理由。
//
// ## ★ hub 客户端：用既有的 `hubIo`，因为它允许**没有 token**
//
// `createHubApprovalPort` 要的是 `{read, write}`，而生产里这个形状的同源实现是
// `orchestrator/worker/executor-binding.mjs` 的 `hubIo()`（`{get, post}`，返回
// `{status, body}`；`team-hub/approval-port.test.mjs` 的注释已经把这条"同源"写死）。
//
// 这里**不能**改用 `orchestrator/worker/run.mjs` 的 `createHubClient()`：它要求
// 非空 token，而 DSH Runtime 进程**拿不到** hub 凭证——
// `product/launcher/enforcement-identity.test.mjs` 有一条用例专门守着
// "`runtime.env` 不是凭证的后门"（凭证键不在 Runtime 的 `envNames` 里，
// `buildChildEnv()` 也不会传）。hub 自己的鉴权口径是"token 非空时才要求"
// （`team-hub/server.mjs` 的 `authorized()`），所以正确的做法是带上**进程真有的**
// 那个 token（可能是 null，即空串），而不是发明一个。
//
//   > 一个"猜一个 token 好让客户端造得出来"的注册方，
//   > 与一个"把 401 记成审批箱不可达"的注册方，是同一个东西——
//   > 只不过前者还会把一次配置缺失写成一次鉴权失败。
//
// 代价是**明确的**：若部署方给 hub 配了 token，DSH 进程里的审批请求会以
// `APPROVAL_PORT_CHECK_FAILED`（故障，不是"没人批"）收场，工具调用被拒（fail closed）。
// 这条写进 `docs/superpowers/prt/PRT-214-enforcement-composition-root.md` §10 的诚实边界。
// ============================================================================

import { createHubApprovalPort } from './approval-port.mjs'
import { hubIo } from '../orchestrator/worker/executor-binding.mjs'
import realRootRow, { setApprovalPortFactory } from '../runtime/dsh-composition/plugins/root-row.mjs'

/** 改动 hub 客户端装配 / 注册时机时递增。 */
export const APPROVAL_REGISTRAR_VERSION = 1

/** 本模块的具名码。全部在**造端口**时抛，由 root 行原样带进它的拒绝消息。 */
export const APPROVAL_REGISTRAR_CODES = Object.freeze({
  /**
   * 组合根交来的配置里没有 hub 地址。
   *
   * 这一条在真部署里通常到不了（组合根的配置解析先以 `ENFORCEMENT_ROOT_NO_HUB_URL`
   * 拒绝），保留它是为了**直接调工厂**的调用方（用例 / 将来的别的宿主）也能拿到
   * 一个说得清是"缺 hub 地址"的码，而不是一个 `TypeError`。
   */
  HUB_URL_MISSING: 'APPROVAL_REGISTRAR_HUB_URL_MISSING',
  /** `hubIo` 的形状被换掉了（返回的不是 `{status, body}`）——接线错，不是"审批箱答了"。 */
  HUB_IO_BAD_RESPONSE: 'APPROVAL_REGISTRAR_HUB_IO_BAD_RESPONSE',
})

function registrarError(code, message) {
  const error = new Error(message)
  error.name = 'ApprovalRegistrarError'
  error.code = code
  return error
}

/**
 * 把 `hubIo()` 的 `{get, post}` 绑成审批端口要的 `{read, write}`。
 *
 * ## 为什么必须**在非 2xx 上抛**，不能把 `{status, body}` 原样交出去
 *
 * `createHubApprovalPort` 的 `hub.read` / `hub.write` 契约是"失败就抛"：
 * 它把抛出翻成 `CHECK_FAILED` / `INBOX_FAILED`（**故障**），把"答了但读不懂"
 * 翻成 `UNKNOWN_STATUS` / `ROW_MALFORMED`（**协议缺陷**）。两种处置的排查方向相反。
 *
 * 而 `hubIo()` 的设计是**不抛**：它把非 2xx 也解成 `{status, body}`。
 * 直接把它当 `read`/`write` 交出去，一次 401 就会变成"审批箱答了一个我们不认识的
 * status"——把**鉴权失败**记成**协议缺陷**。
 *
 *   > 一个"把 401 当正文交给端口"的适配，
 *   > 与一个"审批箱回了一个新状态串"的适配，在屏幕上都是 `UNKNOWN_STATUS`——
 *   > 只不过前者要值班的人去翻 hub 的鉴权配置，而 prompt 指的是错的那份代码。
 *
 * 所以这里只做一件事：`status >= 400` 就抛，并把 `status` / `code` / `body` 挂在
 * 错误上（与 `run.mjs` 的 `HubHttpError` 同一组字段），让故障信息不丢。
 */
export function approvalHubOf(io) {
  const unwrap = (result, path) => {
    const status = result?.status
    if (!Number.isInteger(status)) {
      throw registrarError(
        APPROVAL_REGISTRAR_CODES.HUB_IO_BAD_RESPONSE,
        `hub 客户端对 ${path} 返回的不是 {status, body}（拿到 ${JSON.stringify(result)?.slice(0, 120)}）——` +
        '这是接线错，不是"审批箱答了"',
      )
    }
    if (status >= 400) {
      const body = result.body ?? null
      const error = new Error(`${path} 返回 ${status}`)
      error.name = 'ApprovalHubHttpError'
      error.status = status
      error.code = body?.code ?? null
      error.body = body
      error.path = path
      throw error
    }
    return result.body
  }
  return Object.freeze({
    read: async (path) => unwrap(await io.get(path), path),
    write: async (path, body) => unwrap(await io.post(path, body), path),
  })
}

/**
 * 造一个 `setApprovalPortFactory()` 认的工厂：`(resolvedConfig) => ({ requestApproval })`。
 *
 * `resolvedConfig` 是 `runtime/dsh-composition/root.mjs` 解析出来的
 * `{ hubUrl, hubToken, actor, scope, action, cwd, taskId, platform }`——本工厂
 * **只读它**，不去读进程环境，也不补任何默认值：hub 地址与身份都是 root 行
 * 从环境里解析出来的那一份，这里再造一份就会有两个权威。
 *
 * `fetchImpl` 可注入，纯粹为了用例能在**不起 hub** 的情况下驱动端口（生产用 `globalThis.fetch`）。
 */
export function createApprovalPortFactory({ fetchImpl = globalThis.fetch, portOptions = {} } = {}) {
  return function approvalPortFactory(resolved) {
    const hubUrl = typeof resolved?.hubUrl === 'string' ? resolved.hubUrl.trim() : ''
    if (hubUrl === '') {
      throw registrarError(
        APPROVAL_REGISTRAR_CODES.HUB_URL_MISSING,
        '审批端口工厂拿到的组合根配置里没有 hub 地址——' +
        '没有 hub 就没有审批箱，"问不到人"与"没人问"是两件事，因此这里抛而不是造一个空端口',
      )
    }
    // 既有实现，不另写一份 HTTP：`hubIo()` 就是给"进程里有个 hub 地址、凭证可能为空"
    // 这一处境写的那个客户端。
    const io = hubIo({ hubUrl, hubToken: resolved?.hubToken ?? null, fetchImpl })
    const port = createHubApprovalPort({
      hub: approvalHubOf(io),
      caller: {
        scope: resolved?.scope ?? '',
        actor: resolved?.actor ?? '',
        action: resolved?.action ?? null,
        taskId: resolved?.taskId ?? null,
      },
      ...portOptions,
    })
    return Object.freeze({ requestApproval: port.requestApproval })
  }
}

/**
 * ★ 注册发生在**模块求值期**，这是本批最关键的一步。
 *
 * DSH 加载 root 行时拿到的是本模块的 default；而在 Node 的 ESM 语义里，
 * 一个模块的求值**必然**先于 import 它的那个模块的求值，也就必然先于挂载那个
 * 插件的 Fiber 的 `apply`。所以无论 root 行在补丁层里排第几、无论 Loader 并发
 * 创建多少行，`setApprovalPortFactory()` 都已经执行过了。
 *
 * `unregisterApprovalPortFactory()` 只给用例用（它把注册缝恢复成"没人注册"的状态，
 * 好让"没有工厂时仍然具名拒绝"这条反向对照在同一进程里可测）。
 */
export const registeredApprovalPortFactory = createApprovalPortFactory()

/** `setApprovalPortFactory()` 给的那次注销（幂等；只撤掉**自己**那一次注册）。 */
const undoRegistration = setApprovalPortFactory(registeredApprovalPortFactory)

/** 撤销上面那次注册（用例专用）。 */
export function unregisterApprovalPortFactory() {
  undoRegistration()
}

/**
 * ★ 默认导出就是**真的那个** root row 插件对象（`===`，不是形状相同的替身）。
 *
 * root 行那一行的 `id` 与插件名仍然是 `legion-enforcement-root`：换掉的只是
 * "这一行的模块从哪里加载"，挂载审计读的那两个字段一字未改。
 */
export default realRootRow
