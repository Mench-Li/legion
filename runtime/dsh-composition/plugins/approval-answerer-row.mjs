// runtime/dsh-composition/plugins/approval-answerer-row.mjs
// ============================================================================
// PRT-214：`legion-enforcement-approval-answerer` 那一行的**可加载模块**。
//
// 与 `plugins/pre-execute-row.mjs` **逐条同构**，理由也一样：
//
//   · `approval-answerer.mjs` 的插件需要一个接在 team-hub 上的审批端口，
//     端口是**函数**，`PatchOptions.config` 是数据——YAML 装不下；
//   · 于是那一行在 `PATCH_LAYER_ROWS` 里仍然是 `module: null`
//     （见 `patch-layer.mjs` 的 `runtimeModule` 字段）；
//   · 本文件是它的运行期入口，由组合根装配好之后才挂得上。
//
// 三条判断与 pre-execute 那一行相同，不重复论证，只列结论：
//
//   ① **组合根没装好 → apply 期抛具名码**，不挂空 listener。
//      "不挂 + 打日志"会让组合树里出现一行装好的行，而启动自检
//      （`reconcilePatchLayer`）报的是 waiting，不是 inert——它不会发现。
//      ⚠️ 前提是**服务在场而里面装的是拒绝**：纯粹"根行没加载"那条路是 pending
//      （见 ④），两条路的读法不同、修法也不同。
//   ② 依赖（`approval` 服务）**声明式**表达（`inject`），让 DSH 的挂载审计看见。
//   ③ 真正的 listener 是组合根里那一行（`assemble.mjs` 的 `rows.approvalAnswerer`），
//      带着与 pre-execute 行**同一本**在飞登记簿——那正是它们唯一的会合点。
//      `ctx.plugin()` 会把新 fiber 登记成当前 fiber 的 effect，所以本行卸载时
//      里面那一行跟着卸载。
//   ④ `ENFORCEMENT_ROOT_SERVICE`（`./root-row.mjs` 发布）也进 `inject`：
//      **行顺序不携带加载语义**（`patch-layer.mjs` 写死了这条），所以"根先装好"
//      只能由 Cordis 的服务依赖保证，不能由补丁层的行序保证。根行缺席时本行进
//      pending，由 DSH 的挂载审计报未激活。
// ============================================================================

import { enforcementInstallation } from '../root.mjs'
import { ENFORCEMENT_ROOT_SERVICE } from './root-row.mjs'
import { APPROVAL_ANSWERER_PLUGIN_NAME } from './approval-answerer.mjs'

/** 改动绑定方式时递增。 */
export const APPROVAL_ANSWERER_ROW_VERSION = 1

/** 本行的失败码（全部在 apply 期抛，不吞）。 */
export const APPROVAL_ANSWERER_ROW_CODES = Object.freeze({
  /** `ctx.plugin` 不在——挂到了一个不是 Context 的东西上。 */
  NO_CONTEXT: 'APPROVAL_ANSWERER_ROW_NO_CONTEXT',
  /** 从来没有人装过组合根。 */
  NO_COMPOSITION_ROOT: 'APPROVAL_ANSWERER_ROW_NO_COMPOSITION_ROOT',
  /** 装过，但组合根拒绝了——理由透传在消息里。 */
  COMPOSITION_ROOT_REFUSED: 'APPROVAL_ANSWERER_ROW_COMPOSITION_ROOT_REFUSED',
  /** 组合根是好的，但它手里没有 answerer 那一行。 */
  NO_ASSEMBLED_ROW: 'APPROVAL_ANSWERER_ROW_NO_ASSEMBLED_ROW',
})

function rowError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/** 补丁层那一行加载的就是它。 */
export default {
  name: APPROVAL_ANSWERER_PLUGIN_NAME,

  // `approval` 服务不在场时进 waiting，而不是 apply —— 让"没接进来"这件事
  // 出现在 DSH 的挂载审计里（`ROW_NOT_ACTIVATED`），而不是悄悄过去。
  // `ENFORCEMENT_ROOT_SERVICE` 同上：它保证组合根先装好，与补丁层的行序无关。
  inject: ['approval', ENFORCEMENT_ROOT_SERVICE],

  apply(ctx) {
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.plugin !== 'function') {
      throw rowError(APPROVAL_ANSWERER_ROW_CODES.NO_CONTEXT,
        `${APPROVAL_ANSWERER_PLUGIN_NAME} 需要一个 Cordis Context（要能 ctx.plugin）`)
    }

    const served = typeof ctx.get === 'function' ? ctx.get(ENFORCEMENT_ROOT_SERVICE) : undefined
    const installed = served ?? enforcementInstallation()
    if (installed === null) {
      throw rowError(APPROVAL_ANSWERER_ROW_CODES.NO_COMPOSITION_ROOT,
        `${APPROVAL_ANSWERER_PLUGIN_NAME} 找不到组合根：本进程**从来没有**装过它` +
        '（runtime/dsh-composition/root.mjs 的 installEnforcementRoot）。' +
        '**不挂一个空 listener**：一个"挂上了但什么都没接管"的 answerer，' +
        '与一个根本没接进来的 answerer 在组合树上长得一样，只不过前者看起来是装好的')
    }
    if (installed.ok !== true) {
      throw rowError(APPROVAL_ANSWERER_ROW_CODES.COMPOSITION_ROOT_REFUSED,
        `${APPROVAL_ANSWERER_PLUGIN_NAME} 挂不上：组合根装过，但拒绝了` +
        `（${installed.code}）：${installed.message}。` +
        `原因逐条：${(installed.reasons ?? []).join(' / ') || '（未给出）'}`)
    }

    const row = installed.root?.rows?.approvalAnswerer
    if (row === null || typeof row !== 'object') {
      throw rowError(APPROVAL_ANSWERER_ROW_CODES.NO_ASSEMBLED_ROW,
        `${APPROVAL_ANSWERER_PLUGIN_NAME} 挂不上：组合根里没有 rows.approvalAnswerer —— 装配被改坏了`)
    }

    ctx.plugin(row)
    ctx.logger?.info?.(
      `[${APPROVAL_ANSWERER_PLUGIN_NAME}] v${APPROVAL_ANSWERER_ROW_VERSION} 已挂上组合根装配好的审批应答者` +
      '（与 pre-execute 行共用同一本在飞登记簿）',
    )
  },
}
