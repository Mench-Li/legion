// runtime/dsh-composition/plugins/pre-execute-row.mjs
// ============================================================================
// PRT-214：`legion-enforcement-pre-execute` 那一行的**可加载模块**。
//
// ## 它为什么与 `plugins/pre-execute.mjs` 是两个文件
//
// DSH 的补丁行只能加载一个 `default` 导出，而 `PatchOptions.config` 是**数据**：
//
//   · `pre-execute.mjs` 的插件需要一条 `createEnforcementBridge(...)` 造的桥；
//   · 桥的参数里有 Legion 身份（scope / actor / action）、策略端口 `decide`、
//     岗位白名单、路径范围——**函数与运行时数据**，YAML 装不下。
//
// 所以那一行没有可静态加载的模块：`PATCH_LAYER_ROWS` 里它仍然是 `module: null`
// （见 `patch-layer.mjs` 的 `runtimeModule` 字段）。本文件是它的**运行期**入口——
// 由组合根（`../root.mjs`）在进程内装配好之后才挂得上。
//
// ## ★ 组合根没装好时：**在 apply 期抛**，不挂一个空的 listener
//
// 这是本批次最要紧的一条判断，所以把两条路都写出来再选：
//
//   ✗ 「不挂、只打一条诊断」——看起来更温和，实际更坏。
//     DSH 判断这一行在不在，看的就是它的 `apply` 有没有跑完；一个 apply 成功、
//     却什么都没注册的行，在组合树里**就是一行装好的行**。而
//     `reconcilePatchLayer()` 的 `ROW_NOT_ACTIVATED` 判的是 **waiting**
//     （依赖服务还没到位），不是"挂上了但没接管"——它**不会**报这种情况。
//     于是启动自检会说这一行已生效，而强制面根本不存在。
//
//       > 一个"挂上了、但什么都没接管"的行，
//       > 与一个"从来没有被写进补丁层"的行，在组合树里长得一模一样——
//       > 只不过前者的文件看起来是装好的。
//
//   ✓ 「apply 期抛具名码」——与 `hard-floor.mjs` 的 `NO_GUARD_SEAM` 同一条口径，
//     而且这条口径在本仓库是**已被证明可观测**的：真运行时用例用
//     `assert.rejects(await ctx.plugin(...))` 钉住了它。
//
// 代价说清楚：抛会让加载它的那次 `ctx.plugin()` 失败。这是**想要**的——
// 本行**不在** `legion-host.patch.yml` 里（静态层装不了它），所以这个失败
// 只可能由"某处显式地把这一行挂进一个没装配过的进程"触发；
// 那种处境下唯一正确的行为就是响亮地失败。
//
// ## ★ 为什么还要 `inject` 组合根服务（PRT-214 续）
//
// `patch-layer.mjs` 写死了：**行顺序不携带加载语义**。所以"组合根先装好、本行再挂"
// 不能靠补丁层的行序，只能靠 Cordis：根行（`./root-row.mjs`）`ctx.provide()` 一个服务，
// 本行 `inject` 它——依赖没到位时本行进 **pending**，服务一出现 Cordis 自己激活。
//
// 于是"根行压根没在补丁层里"这条路的读法是 **pending**（DSH 的挂载审计报
// `N row(s) did not activate`，`reconcilePatchLayer()` 读的是它），而不是抛。
// 而"服务在、但里面装的是拒绝"这条路仍然是**抛具名码**——两条路必须可分：
// 前者要去看补丁层少了哪一行，后者要去看配置缺了哪个字段。
//
// ## 为什么还要再 `ctx.plugin(row)` 一次
//
// 本文件是**薄绑定的薄绑定**：真正的 listener 是组合根里那一行
// （`assemble.mjs` 的 `rows.preExecute`），它带着共享的桥与共享的登记簿。
// 这里只做一件事：把那一行挂到当前的 Context 上。
//
// Cordis 的 `ctx.plugin()` 会把新 fiber 登记成**当前 fiber 的 effect**
// （`cordis/lib/index.js`：`this.dispose = parent.fiber.effect(...)`），
// 于是本行卸载时里面那一行跟着卸载——不需要我们再写一遍生命周期。
// ============================================================================

import { enforcementInstallation } from '../root.mjs'
import { ENFORCEMENT_ROOT_SERVICE } from './root-row.mjs'
import { PRE_EXECUTE_PLUGIN_NAME } from './pre-execute.mjs'

/** 改动绑定方式时递增。 */
export const PRE_EXECUTE_ROW_VERSION = 1

/** 本行的失败码（全部在 apply 期抛，不吞）。 */
export const PRE_EXECUTE_ROW_CODES = Object.freeze({
  /** `ctx.on` / `ctx.plugin` 不在——挂到了一个不是 Context 的东西上。 */
  NO_CONTEXT: 'PRE_EXECUTE_ROW_NO_CONTEXT',
  /** 从来没有人装过组合根。**与"装了但被拒绝"分开**：修法不同。 */
  NO_COMPOSITION_ROOT: 'PRE_EXECUTE_ROW_NO_COMPOSITION_ROOT',
  /** 装过，但组合根拒绝了（配置缺失 / 读不出来 / 端口没给）——理由透传在消息里。 */
  COMPOSITION_ROOT_REFUSED: 'PRE_EXECUTE_ROW_COMPOSITION_ROOT_REFUSED',
  /** 组合根是好的，但它手里没有 preExecute 那一行（装配被改坏了）。 */
  NO_ASSEMBLED_ROW: 'PRE_EXECUTE_ROW_NO_ASSEMBLED_ROW',
})

function rowError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/** 补丁层那一行加载的就是它。 */
export default {
  name: PRE_EXECUTE_PLUGIN_NAME,

  // ★ 与 `hard-floor.mjs` 同一条理由：依赖必须**声明式**表达，让 DSH 的挂载审计
  //   把 `N row(s) did not activate` 报出来（`reconcilePatchLayer()` 读的是它）。
  //   自己偷偷检查端口、于是永远不进 waiting 的写法，会让坏接线只在运行时暴露。
  //
  // ★ `ENFORCEMENT_ROOT_SERVICE`：组合根那一行发布的服务。**顺序不靠行序**——
  //   见文件头。少了它，"根行最后加载"就会让本行在根还没装好时 apply 并抛。
  inject: ['tools', ENFORCEMENT_ROOT_SERVICE],

  apply(ctx) {
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.plugin !== 'function') {
      throw rowError(PRE_EXECUTE_ROW_CODES.NO_CONTEXT,
        `${PRE_EXECUTE_PLUGIN_NAME} 需要一个 Cordis Context（要能 ctx.plugin）`)
    }

    // 服务优先：真运行时上它一定在场（`inject` 保证）。模块级单例是**同一条信息**
    // 的另一条读法，留给不建模 `inject` 的假 Context——两者读的是同一份安装结果。
    const served = typeof ctx.get === 'function' ? ctx.get(ENFORCEMENT_ROOT_SERVICE) : undefined
    const installed = served ?? enforcementInstallation()
    if (installed === null) {
      throw rowError(PRE_EXECUTE_ROW_CODES.NO_COMPOSITION_ROOT,
        `${PRE_EXECUTE_PLUGIN_NAME} 找不到组合根：本进程**从来没有**装过它` +
        '（runtime/dsh-composition/root.mjs 的 installEnforcementRoot）。' +
        '**不挂一个空 listener**：一个"挂上了但没接管"的强制面，' +
        '比一个缺席的强制面更坏，因为组合树里看得见它')
    }
    if (installed.ok !== true) {
      throw rowError(PRE_EXECUTE_ROW_CODES.COMPOSITION_ROOT_REFUSED,
        `${PRE_EXECUTE_PLUGIN_NAME} 挂不上：组合根装过，但拒绝了` +
        `（${installed.code}）：${installed.message}。` +
        `原因逐条：${(installed.reasons ?? []).join(' / ') || '（未给出）'}`)
    }

    const row = installed.root?.rows?.preExecute
    if (row === null || typeof row !== 'object') {
      throw rowError(PRE_EXECUTE_ROW_CODES.NO_ASSEMBLED_ROW,
        `${PRE_EXECUTE_PLUGIN_NAME} 挂不上：组合根里没有 rows.preExecute —— 装配被改坏了`)
    }

    ctx.plugin(row)
    ctx.logger?.info?.(
      `[${PRE_EXECUTE_PLUGIN_NAME}] v${PRE_EXECUTE_ROW_VERSION} 已挂上组合根装配好的策略门` +
      '（allow 让路 / deny·ask 认领；桥与在飞登记簿都是组合根那一份）',
    )
  },
}
