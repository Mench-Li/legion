// runtime/dsh-composition/scope-table-binding.mjs
// ============================================================================
// 把「部署配置给的路径范围表」装配成执行面 `pathScope` 端口能收的那一份。
//
// ## 为什么需要这一步
//
// `path-scope.mjs`（863 行）**判定逻辑已经齐了**：`normalizeScope` 逐字段闭合校验、
// `narrowScopeToWorkspace` 把写范围收进工作区、`checkPathScope` 做包含判定
// （含符号链接逃逸、设备命名空间、UNC、ADS、大小写规则）。
//
// 缺的**不是判定，是那份表的出处**：全仓 `narrowScopeToWorkspace` **零生产调用方**
// （只有它自己的自证段与用例）。而 `tool-request.mjs:731` 是：
//
//     if (pathScope === null) return undefined      // ← 放行
//     verdict = pathScope(projection)
//
// 于是"这份表没配上"在**今天**的表现不是"拒绝一切"，而是**放行一切**：
//
//   > 一个"因为没配范围表所以什么都没限制"的位点，
//   > 与一个"这次确实没有东西要限制"的位点，在读数上是同一个东西——
//   > 只不过前者看起来像有保护（端口在、函数在、用例绿），而它一个真路径都没拦过。
//
// 所以本文件的**第一职责**不是算范围，而是**把"没配上"变成一件必须被处置的事**。
//
// ## 形状为什么与 `runtime/connectors/target-binding.mjs` **故意不同**
//
// `bindConnectorTargets` 返回 `{declarations, refusals}`——**部分成功**，
// 因为连接器是**多条**，而"某一条没配上"的安全后果是**权限变少**（那一条不在数组里），
// 是安全的。
//
// 本文件**抛**具名错误、不返回部分结果。因为范围表只有**一张**，而"没有表"的安全后果
// 是**权限变多**（放行一切）。一个"把缺表表达成 `scope: null`"的返回值，
// 与一个"允许调用方把 null 原样传下去"的返回值，是同一个东西——
// 只不过前者会在 `tool-request.mjs` 里**静默变成放行**。
//
//   > 两条装配线，一条可以"少几条"，另一条只能"要么有、要么当场停"。
//   > 把它们写成同一个形状，是为了整齐，而不是为了安全。
//
// 这也与 `path-scope.mjs` 自己那一家的风格一致：`normalizeScope` /
// `narrowScopeToWorkspace` / `checkPathScope` 都是**抛具名错误**，从不返回半成品。
//
// ## 三条装配期拒绝（都不许"猜一个"）
//
//   ① **没有表**（`declaration` 缺席）→ 拒绝。
//      不许退化成"没有范围表"——那在同一位点上读作**放行一切**（见上）。
//   ② **有表但没有读根** → 拒绝。
//      读者不妨问"能不能就让它去跑"：能，`checkPathScope` 在 `roots.length === 0` 时
//      返回 `allowed: false`（fail closed），所以它不是安全漏洞——但它把一次
//      **配置错误**表现成每一次调用一句"这个岗位的读范围是空的"，
//      而那句话读起来像**工具坏了**，不像"表没配"。本仓对同形状的写侧已有先例：
//      `narrowScopeToWorkspace` 抛 `OUT_OF_SCOPE` 时原话是"配置一定是错的"。
//   ③ **有写根但没给工作区根** → 拒绝。
//      `narrowScopeToWorkspace` 在 `workspaceRoot` 为空时**原样返回**（不收窄），
//      于是"写范围被限制在工作区内"这条边界**静默消失**——而表的字段、
//      `checkPathScope` 的返回、用例的绿，一样都不会变。
//
// ★ 读根**允许**在工作区之外：`narrowScopeToWorkspace` 只收窄 `write`
//   （`read` 原样保留），那是刻意的设计（读共享资料是正当需求）。
//   本文件**不**加一条"读根必须在工作区内"的检查——那会把一个正当声明判成非法。
//   这条是实测出来的：先按"读根也必须在工作区内"写，用真函数一跑就发现收窄**不会**
//   动 `read`，于是那条检查是自造的、与实现不符的约束。
//
// ## 边界
//
// 本文件**不**读环境变量、**不** import 控制面：它收的是**普通对象**。
// "表从哪读"（部署配置 / 运维入口）是调用方的事，而那一层今天仍被
// `product/process-manifest.mjs` 与 `product/config-schema.mjs` 的**他人在制品**挡着。
// 分开之后，本文件的判据不受那边进度影响。
// @module runtime/dsh-composition/scope-table-binding
// ============================================================================

import { PATH_SCOPE_VERSION, normalizeScope, narrowScopeToWorkspace } from './path-scope.mjs'

export const SCOPE_TABLE_BINDING_VERSION = 'legion/scope-table-binding@1'

export const SCOPE_TABLE_CODES = Object.freeze({
  BAD_INPUT: 'scope-table-binding-bad-input',
  TABLE_MISSING: 'scope-table-missing',
  TABLE_EMPTY: 'scope-table-empty',
  WORKSPACE_MISSING: 'scope-table-workspace-missing',
})

function fail(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 装配一张路径范围表。
 *
 * @param {object} input
 * @param {object|null|undefined} input.declaration 部署配置给的范围表（原始形状）
 * @param {string|null|undefined} input.workspaceRoot 这次 Run 的工作区根
 * @returns {Readonly<object>} 已归一化、已收窄的范围表（可直接交给 `checkPathScope` 或
 *         作为 `pathScope` 端口的输入）
 * @throws {Error} 具名错误：见 `SCOPE_TABLE_CODES`；也可能上抛 `path-scope.mjs` 自己的
 *         具名错误（`BAD_SCOPE` / `OUT_OF_SCOPE` / `CASE_RULE_MISSING` / …）。
 *
 * ★ **形状类错误原样上抛，不包一层自己的码。** 那些错误已经足够具名、消息也已足够精确，
 *   把它们压成"装配失败"会让排障指向本文件，而真正的修法在范围表的内容里。
 *   这与 `executor.mjs` 那条注释同源：
 *
 *     > 一个"下游所有的失败都变成同一个码"的包装，
 *     > 与一个"排障永远指向接线、而真正的修法在另一张表里"的包装，是同一个东西。
 */
export function bindScopeTable({ declaration, workspaceRoot } = {}) {
  // ① 没有表。
  if (declaration === undefined || declaration === null) {
    throw fail(
      SCOPE_TABLE_CODES.TABLE_MISSING,
      '这次 Run 没有路径范围表。不按"没有范围表"处理——调用方拿到的 `pathScope` 若是 null，'
      + '`tool-request.mjs` 会**放行一切**，于是"没配上"会被读成"这次没有东西要限制"',
    )
  }
  if (!isPlainObject(declaration)) {
    throw fail(SCOPE_TABLE_CODES.BAD_INPUT, '范围表必须是对象')
  }

  // 先归一化一次，只为了读 `write` 的**原始条数**决定第 ③ 条是否适用。
  // `normalizeScope` 文档写明是幂等的（`normalizeScope(normalizeScope(x))` 成立），
  // 所以这里多归一化一次不改变结果。
  const normalized = normalizeScope(declaration)

  // ③ 有写根却没给工作区根 ⇒ 收窄不会发生，"写限制在工作区内"这条边界静默消失。
  const hasWorkspace = workspaceRoot !== undefined && workspaceRoot !== null
    && String(workspaceRoot).trim() !== ''
  if (!hasWorkspace && normalized.write.length > 0) {
    throw fail(
      SCOPE_TABLE_CODES.WORKSPACE_MISSING,
      `范围表声明了 ${normalized.write.length} 条写根，但没有给工作区根。`
      + '不收窄的话"写范围被限制在工作区内"这条边界会**静默消失**——'
      + '表的字段、判定函数的返回、用例的绿，一样都不会变',
    )
  }

  // 归一化 + 收窄 + `cwd` 派生。形状类错误在这里具名上抛。
  const scope = narrowScopeToWorkspace({ scope: normalized, workspaceRoot: hasWorkspace ? workspaceRoot : null })

  // ② 有表但没有读根。fail closed 是成立的，但那是"每一次调用都报一句像工具坏了的话"，
  //    不是"装配期就说清配置错了"。
  if (scope.read.length === 0) {
    throw fail(
      SCOPE_TABLE_CODES.TABLE_EMPTY,
      '范围表里一条读根都没有。放它过去不是安全漏洞（`checkPathScope` 在无读根时返回拒绝），'
      + '但它会把一次**配置错误**表现成每一次调用一句"这个岗位的读范围是空的"——'
      + '那句话读起来像工具坏了，不像表没配。本仓对同形状的写侧已有先例：'
      + '`narrowScopeToWorkspace` 抛 `OUT_OF_SCOPE` 时的原话是"配置一定是错的"',
    )
  }

  // ★ 产物**只含** `path-scope.mjs` 认得的那几个字段。
  //
  //   这一条是**实测**出来的、不是照抄的：我第一版多带了一个 `bindingVersion`，
  //   而 `checkPathScope` 内部**总是** `normalizeScope(scope)`，`normalizeScope` 又是
  //   **闭合字段校验** ⇒ 于是装配产物一交给真正的读者就抛
  //   `path-scope-malformed: 范围表里出现了不认识的字段 ["bindingVersion"]`。
  //
  //   最值得记的是**它没被什么抓住**：只看产物自己字段清单的用例是绿的
  //   （`bindingVersion` 就在清单里，看着很合理）。抓住它的只有
  //   "把产物交给**真的** `checkPathScope` 跑一遍"那一条。
  //
  //     > 一个"多带一个字段"的装配产物，与一个能用的装配产物，
  //     > 在它自己的字段清单上长得一样——只不过前者在**下一个**读它的人那里才炸。
  //
  //   所以版本号只以**导出常量**的形式存在，不进产物。
  return Object.freeze({
    version: PATH_SCOPE_VERSION,
    platform: scope.platform,
    read: scope.read,
    write: scope.write,
    cwd: scope.cwd,
  })
}
