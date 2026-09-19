// product/execution-plane-config.mjs
// ============================================================================
// **同一个部署配置读取点**（第 19 条 §9.2 第 3 步）。
//
// 连接目标与路径范围表两样执行面数据的**家**是同一条：运维 / 部署配置
// （业主 2026-09-18 两次裁决）。本模块是它们**唯一**的读取点，
// 免得同一个决定被两处各读一遍、各判一次。
//
// ## 它不判定，它只是把"配了没有"如实交出去
//
// 两半的组装规则各自已经在自己的模块里钉好了，本模块**不重写**：
//
//   · 连接目标 → `runtime/connectors/target-binding.mjs`（`bindConnectorTargets`）
//     策略声明来自控制面（team-hub 的连接器记录），连接目标来自部署配置。
//     组装不上是**部分失败**：进 `refusals`，不静默跳过。
//   · 范围表 → `runtime/dsh-composition/scope-table-binding.mjs`（`bindScopeTable`）
//     它是**一张**表，所以缺表**抛**具名错误、不返回半成品。
//
// 本模块加的那一层只有一件事：**把"这个键压根没配"与"配了但解释不通"分开**。
//
// ## ★ 为什么"没配"必须是一个**可读出来的状态**，而不是 `null`
//
// 这与 `runtime/contracts/run.mjs:97-125` 给 `enforcementFloor` 定的那一条是
// **同一条纪律**：
//
//   > 给了就必须解释得通，不给就如实缺席。
//
// 那里的 `absent` 由安装点（`run-floor.mjs`）fail closed 处置；
// 这里的 `absent` 同样只负责**如实**，处置留给消费点。理由是同一个：
//
//   · `tool-request.mjs` 的 `scopeGuard`（`if (pathScope === null) return undefined`）**放行**。
//     所以把"没配"读成"没有范围表"就是**放行一切**。
//   · 而把"没配"读成"拒绝一切"也不对——那会让一个还没配过的部署**整个起不来**，
//     于是操作者学会的做法是"随便填一张表让它闭嘴"。
//
//   > 一个"没配就当作没有限制"的读取点，
//   > 与一个"没配就当作全部禁止"的读取点，
//   > 在汇总表里都很干脆——只不过前者把漏配洗成了放行，后者把漏配洗成了严格。
//
// 所以 `state` 是一个**字段**，不是一个空值：消费点必须**显式**处理它，
// 而处理方式（拒绝派发 / 记诊断 / 按发布前姿态）属于它自己的 fail-closed 决定。
//
// ## ★ 一条实测出来的机制（别把它当巧合）
//
// `product/config.mjs` 的 `validateConfigValues` **不会**递归走**已登记**的对象键
// （递归只发生在"键没登记"那一支）。所以把 `runtime.pathScope` 登记成 `object`
// 之后，它内部的 `platform` / `read` / `write` **不会**各自报 `CONFIG_UNKNOWN_KEY`。
// `runtime.secretRefs` 用的就是同一个机制。用例⑦⑧把这条钉住——
// 免得下一个人"顺手"把子键也登记一遍（那会得到两份互相漂移的说明）。
// @module product/execution-plane-config
// ============================================================================

import { configValueAt } from './config.mjs'
import { bindConnectorTargets } from '../runtime/connectors/target-binding.mjs'
import { bindScopeTable } from '../runtime/dsh-composition/scope-table-binding.mjs'

export const EXECUTION_PLANE_CONFIG_VERSION = 'legion/execution-plane-config@1'

/**
 * 两半在部署配置里的键名。
 *
 * ★ 导出成常量，免得字符串散落：读取点、键登记、文档、用例都指同一处。
 */
export const EXECUTION_PLANE_CONFIG_KEYS = Object.freeze({
  PATH_SCOPE: 'runtime.pathScope',
  CONNECTOR_TARGETS: 'runtime.connectorTargets',
})

export const EXECUTION_PLANE_CONFIG_CODES = Object.freeze({
  BAD_INPUT: 'execution-plane-config-bad-input',
  TARGETS_MALFORMED: 'execution-plane-connector-targets-malformed',
})

/** 两半各自的两种状态。 */
export const EXECUTION_PLANE_STATES = Object.freeze({
  CONFIGURED: 'configured',
  ABSENT: 'absent',
})

function fail(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 连接目标的形状校验：`{ [connectorId]: { transport?, command?, url? } }`。
 *
 * ★ 只校验**形状**，不校验"有没有配对"——配对要等控制面的声明，
 *   那一步是 `bindConnectorTargets` 的事。这里越权去判配对，
 *   会得到一个"看起来更严、其实判不了"的检查。
 */
function validateConnectorTargets(raw) {
  if (!isPlainObject(raw)) {
    throw fail(
      EXECUTION_PLANE_CONFIG_CODES.TARGETS_MALFORMED,
      `连接目标必须是对象（键是 connectorId），实际是 ${JSON.stringify(raw)?.slice(0, 60)}`,
    )
  }
  for (const [id, target] of Object.entries(raw)) {
    if (id.trim() === '') {
      throw fail(EXECUTION_PLANE_CONFIG_CODES.TARGETS_MALFORMED, '连接目标的键不能是空串——没有 id 就无法与声明配对')
    }
    if (!isPlainObject(target)) {
      throw fail(
        EXECUTION_PLANE_CONFIG_CODES.TARGETS_MALFORMED,
        `连接器 ${id} 的目标必须是对象，实际是 ${JSON.stringify(target)?.slice(0, 60)}`,
      )
    }
  }
  return raw
}

/** 读一半：缺席**如实**记成 `absent`，配了就必须解释得通（否则由各自模块具名上抛）。 */
function readHalf({ merged, key, assemble }) {
  const raw = configValueAt(merged, key)
  if (raw === undefined) {
    return Object.freeze({
      state: EXECUTION_PLANE_STATES.ABSENT,
      key,
      value: null,
      reason: `部署配置里没有「${key}」。这**不是**"没有限制"也不是"全部禁止"——`
        + '它是一个要由消费点显式处置的缺席',
    })
  }
  return Object.freeze({
    state: EXECUTION_PLANE_STATES.CONFIGURED,
    key,
    value: assemble(raw),
    reason: null,
  })
}

/**
 * 从**已合并**的部署配置里读出执行面那两半。
 *
 * @param {object} input
 * @param {object} input.merged  `loadProductConfig()` 的 `merged`（含 env 层）
 * @param {string} [input.workspaceRoot] 这次 Run 的工作区根（范围表要收窄写范围）
 * @returns {Readonly<{version: string, pathScope: object, connectorTargets: object, absentKeys: ReadonlyArray<string>}>}
 * @throws {Error} `BAD_INPUT`；或两半各自模块的具名错误
 *   （`path-scope-*` / `scope-table-*` / `connector-target-*`）——**原样上抛**，
 *   不包一层自己的码：把它们压成"读取失败"会让排障指向本文件，
 *   而真正的修法在配置的内容里。
 */
export function readExecutionPlaneConfig({ merged, workspaceRoot } = {}) {
  // ★★ 这一条是**实测**出来的，不是预防性写法：`configValueAt()` 走的是
  //    `merged.value`（它收的是 `loadProductConfig()` 的产物，一个**带 value 的对象**）。
  //    所以我第一版只判 `isPlainObject(merged)` 时，调用方传一份**裸配置对象**
  //    会让两半**都读成 `absent`**——
  //
  //      > 一个"传错了形状"的输入，与一个"这次部署确实没配"的输入，
  //      > 在 `absent` 上长得一样——只不过前者会安静地把执行面两半都判成缺席，
  //      > 而它的报错方式（如果有）是"没配"，不是"你传错了"。
  //
  //    所以这里要求 `value` 也是个普通对象：把"形状错了"变成一次**具名拒绝**，
  //    而不是一次看起来合理的缺席。
  if (!isPlainObject(merged) || !isPlainObject(merged.value)) {
    throw fail(
      EXECUTION_PLANE_CONFIG_CODES.BAD_INPUT,
      'merged 必须是 `loadProductConfig()` 的产物（一个**带 `value` 对象**的对象）。'
      + '传一份裸配置会让两半都读成 absent——而"传错了形状"与"这次没配"在 absent 上同形',
    )
  }

  const pathScope = readHalf({
    merged,
    key: EXECUTION_PLANE_CONFIG_KEYS.PATH_SCOPE,
    // ★ 形状类错误（非对象 / 不认识字段 / 写范围不在读范围内 / 平台没给）在这里具名上抛。
    assemble: (raw) => bindScopeTable({ declaration: raw, workspaceRoot }),
  })
  const connectorTargets = readHalf({
    merged,
    key: EXECUTION_PLANE_CONFIG_KEYS.CONNECTOR_TARGETS,
    assemble: validateConnectorTargets,
  })

  const absentKeys = Object.freeze(
    [pathScope, connectorTargets].filter((h) => h.state === EXECUTION_PLANE_STATES.ABSENT).map((h) => h.key),
  )

  return Object.freeze({
    version: EXECUTION_PLANE_CONFIG_VERSION,
    pathScope,
    connectorTargets,
    absentKeys,
  })
}

/**
 * 把读出来的两半与控制面的连接器声明**合起来**。
 *
 * 单独一个函数，因为它是本条唯一需要**两侧数据同时在场**的一步：
 * 读取点只管"部署这一侧配了什么"，配对要等策略声明。
 *
 * @param {object} input
 * @param {ReturnType<typeof readExecutionPlaneConfig>} input.plane
 * @param {ReadonlyArray<object>} [input.connectorDeclarations] 控制面（team-hub 连接器记录）
 * @returns {{connectors: object, refusals: ReadonlyArray<object>, pathScope: object|null}}
 */
export function joinExecutionPlane({ plane, connectorDeclarations = [] } = {}) {
  if (!isPlainObject(plane)) {
    throw fail(EXECUTION_PLANE_CONFIG_CODES.BAD_INPUT, 'plane 必须是 readExecutionPlaneConfig() 的产物')
  }
  const bound = bindConnectorTargets({
    declarations: connectorDeclarations,
    targets: plane.connectorTargets.value ?? {},
  })
  return Object.freeze({
    connectors: Object.freeze({
      version: bound.version,
      declarations: bound.declarations,
    }),
    refusals: bound.refusals,
    // 缺席**原样**传出去（`null` + 上面那半的 `state`），不在这里补默认值。
    pathScope: plane.pathScope.value,
  })
}
