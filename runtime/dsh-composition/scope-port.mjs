// runtime/dsh-composition/scope-port.mjs
// ============================================================================
// **范围表 → 执行面端口**的那一截（第 19 条 §9.2 第 4 步）。
//
// ## 它填的是哪个洞
//
// `tool-request.mjs` 的 `scopeGuard()` 长这样（`:639`）：
//
//     if (pathScope === null) return undefined      // ← 放行
//
// 而 `scopeGuard` 是 `pathScope(projection) -> {allowed, code, reason}` 的**唯一**消费者。
// 全仓库到本模块之前，**没有任何地方**把一份范围表变成这样一个函数：
//
//   · `path-scope.mjs` 有 `checkPathScope({target, scope, direction, realpath, exists})`
//     ——判定写好了，它要的是一份表加上一次具体调用；
//   · `scope-table-binding.mjs` 把**部署配置**装配成那份表（三条拒绝 + 收窄 + cwd）；
//   · 而两者中间的那一步（表 + 一次投影 → 一个判定）原先不存在。
//
// ⇒ 于是生产装配传不进 `pathScope`（`root-row.mjs` 的调用里没有这个键），
//   端口恒为 `null`，**每一次工具调用都从那一行放行**。
//   这是 §9.3 量出来的同一个形状：**缺表 = 放行**。
//
// ## ★ 本模块**不推导路径**——它只读投影上已经算好的那两个字段
//
// `tool-request.mjs:378` 那条纪律是写给本模块的：
//
//   > 它们**只摆放**，不再推导。任何在这里出现的 `arguments.path ?? arguments.file_path`
//   > 都是漂移的来源：一个「在适配器里顺手补一次字段兜底」的桥，
//   > 与一个「两个强制点看到两个不同目标」的桥，是同一个东西。
//
// 所以本模块**只**读两样东西，且都在投影里现成的：
//   · `projection.canonicalTarget` —— 已按 cwd/platform 归一化的目标（不是 `arguments`）；
//   · `projection.direction` —— `'read' | 'write' | null`。
//
// ## ★ 三个 fail-closed 决定
//
// ① **方向未知 ⇒ 按 `write` 判**。与投影自己那条注释同一个理由（`tool-request.mjs:365`）：
//    "`unknown` 工具的方向是 `write`（fail closed）"。
//    用 `=== 'write'` 会让未登记工具被读成"不是写"。
// ② **目标缺失 ⇒ 拒绝**。投影成功时目标一定在（`deriveTarget()` 推不出来就**抛**），
//    所以这个分支在正常路径上不可达——正因为不可达，它只可能是接线坏了，
//    而"证明不了它在范围内"必须是拒绝。
// ③ **表在装配期就校验**（`normalizeScope` 跑一遍）。一个"第一次工具调用时才炸"的范围表，
//    与一个"装配时就拒绝"的范围表，区别在于前者把错误推迟到**已经有副作用的那一刻**。
// @module runtime/dsh-composition/scope-port
// ============================================================================

import { existsSync, realpathSync } from 'node:fs'

import { SCOPE_CODES, checkPathScope, normalizeScope } from './path-scope.mjs'
import { bindScopeTable } from './scope-table-binding.mjs'

export const SCOPE_PORT_VERSION = 'legion/scope-port@1'

/**
 * 部署配置把范围表交给 Runtime 子进程用的环境键。
 *
 * ★ 走环境而不是补丁 YAML：范围表要经 `normalizeScope` 归一化，而
 *   `PatchOptions.config` 是**数据**——它装不下归一化后的函数与解析器
 *   （`pre-execute.mjs:180` 记的是同一条理由）。环境是既有的投递渠道：
 *   `runtime.env` 这个部署配置键的注释就是"注入 Runtime 子进程的额外环境变量"。
 */
export const SCOPE_PORT_ENV_KEY = 'LEGION_PATH_SCOPE'

/** 范围表缺席时用的工作区根环境键（`ENFORCEMENT_IDENTITY_ENV.cwd` 是同一个字符串）。 */
export const SCOPE_PORT_CWD_ENV_KEY = 'LEGION_CWD'

/**
 * 本模块从环境读取的键（**表**形态）。
 *
 * ★ 这张表是给 `scripts/config/config.test.mjs` 用的：那条判据要求
 *   `runtime/config-schema.mjs` 的 `fields` **恰好等于**源码里几张键名表的并集
 *   （不许多、不许少）。手抄一份进 schema 会在两个方向上撒谎——
 *   所以这里导出一张表，让判据从**源码**反查，而不是从我的记忆里。
 */
export const SCOPE_PORT_ENV_KEYS = Object.freeze([SCOPE_PORT_ENV_KEY, SCOPE_PORT_CWD_ENV_KEY])

export const SCOPE_PORT_CODES = Object.freeze({
  BAD_INPUT: 'scope-port-bad-input',
  /** 环境里那份文本不是合法 JSON。 */
  BAD_TABLE_TEXT: 'scope-port-bad-table-text',
  /** 投影里没有可用的目标——正常路径上不可达，只可能是接线坏了。 */
  NO_TARGET: 'scope-port-no-target',
})

/** 与 `product/execution-plane-config.mjs` 同一套状态词：缺席是一件事，不是一个空值。 */
export const SCOPE_PORT_STATES = Object.freeze({
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
 * 真实文件系统的解析器（`checkPathScope` 要的两个函数）。
 *
 * `realpathSync.native` 而不是 `realpathSync`：Windows 上后者**不展开**短名与
 * 某些 junction，而那正是"根被换成一个链接之后整片失效"最容易被漏掉的一类。
 * 取不到就返回 `null`（**不抛**）——"解析不了"由 `resolveReal` 变成一次具名拒绝，
 * 而不是把强制面炸掉。
 */
export function createFsResolver({ realpath = realpathSync.native, exists = existsSync } = {}) {
  return Object.freeze({
    realpath: (p) => {
      try { return realpath(p) } catch { return null }
    },
    exists: (p) => {
      try { return exists(p) === true } catch { return false }
    },
  })
}

/**
 * 表 → 端口。
 *
 * @param {object} p
 * @param {object} p.table      已装配的范围表（`bindScopeTable()` 的产物）
 * @param {string} [p.platform]
 * @param {function} [p.realpath] / [p.exists]  真实实现来自 `createFsResolver()`
 * @returns {(projection: object) => {allowed: boolean, code: string|null, reason: string|null}}
 * @throws {Error} 表不合法时（`path-scope-*`，**原样上抛**）——装配期就拒，不留到第一次调用
 */
export function createScopePort({ table, platform, realpath, exists } = {}) {
  if (!isPlainObject(table)) {
    throw fail(SCOPE_PORT_CODES.BAD_INPUT, 'createScopePort 需要一份范围表对象')
  }
  if (typeof realpath !== 'function' || typeof exists !== 'function') {
    // ★ 不给默认值：一个"没给解析器于是每个目标都解析不了"的端口，
    //   会在**每一次**调用上返回拒绝，而它看起来像"范围表很严"。
    throw fail(
      SCOPE_PORT_CODES.BAD_INPUT,
      'createScopePort 需要 realpath 与 exists 两个函数（真实实现用 createFsResolver()）。'
      + '不给默认值：一个"解析不了所以全拒"的端口，看起来像"范围表很严"',
    )
  }
  // ★ 装配期归一化：表不合法**现在**就抛，而不是等第一次工具调用。
  const scope = normalizeScope(table)
  const plat = platform ?? scope.platform

  return function pathScopePort(projection) {
    if (!isPlainObject(projection)) {
      return Object.freeze({
        allowed: false, code: SCOPE_CODES.BAD_SCOPE, reason: '路径范围检查收到一个不是对象的投影',
      })
    }
    const target = typeof projection.canonicalTarget === 'string' && projection.canonicalTarget.trim() !== ''
      ? projection.canonicalTarget
      : null
    if (target === null) {
      // ② 目标缺失 ⇒ 拒绝。"证明不了它在范围内"与"它在范围内"不是同一个读数。
      return Object.freeze({
        allowed: false,
        code: SCOPE_PORT_CODES.NO_TARGET,
        reason: '投影里没有可用目标（canonicalTarget 为空）。投影成功时目标一定在，'
          + '所以这里只可能是接线坏了——而"证明不了它在范围内"必须是拒绝',
      })
    }
    // ① 方向未知 ⇒ 按 write 判（fail closed），与投影自己的口径一致。
    const direction = projection.direction === 'read' ? 'read' : 'write'

    let verdict
    try {
      verdict = checkPathScope({ target, scope, direction, realpath, exists })
    } catch (err) {
      // 判定本身出错 ⇒ 拒绝，且**带上码**。不把强制面炸掉。
      return Object.freeze({
        allowed: false,
        code: err?.code ?? SCOPE_CODES.UNRESOLVED,
        reason: `路径范围检查本身出错：${err?.message ?? String(err)}`,
      })
    }
    return Object.freeze({
      allowed: verdict.allowed === true,
      code: verdict.allowed === true ? null : (verdict.code ?? SCOPE_CODES.OUTSIDE_READ),
      reason: verdict.allowed === true ? null : (verdict.reason ?? '没有给出理由'),
      targetResolved: verdict.targetResolved ?? null,
      rootMatched: verdict.rootMatched ?? null,
      direction,
      platform: plat,
    })
  }
}

/**
 * 从 Runtime 子进程的环境里取那份范围表。
 *
 * ★ 缺席**如实**记成 `absent`（与 `product/execution-plane-config.mjs` 同一条纪律）：
 *   没配不等于"没有限制"，处置归组合根——组合根拿到 `port: null` 时，
 *   生产读数就还是 `pathScope: false`（**没接就是没接**，不是"接了个空的"）。
 *
 * ★ 而配了却解释不通 ⇒ **抛**：那是配置错误，不是"没配"。
 *
 * @param {object} p
 * @param {object} p.env
 * @param {string} [p.workspaceRoot] 收窄写范围用的工作区根；默认取 `LEGION_CWD`
 * @returns {{state: string, port: Function|null, table: object|null, reason: string|null}}
 */
export function scopePortFromEnv({ env, workspaceRoot, realpath, exists } = {}) {
  if (!isPlainObject(env)) {
    throw fail(SCOPE_PORT_CODES.BAD_INPUT, 'scopePortFromEnv 需要一个环境对象')
  }
  const resolver = realpath === undefined || exists === undefined ? createFsResolver() : { realpath, exists }

  const raw = env[SCOPE_PORT_ENV_KEY]
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return Object.freeze({
      state: SCOPE_PORT_STATES.ABSENT,
      port: null,
      table: null,
      reason: `环境里没有「${SCOPE_PORT_ENV_KEY}」。这**不是**"没有路径限制"——`
        + '执行面在端口为 null 时是放行，所以这个缺席要由组合根显式处置',
    })
  }

  let declaration = raw
  if (typeof raw === 'string') {
    try {
      declaration = JSON.parse(raw)
    } catch (err) {
      throw fail(
        SCOPE_PORT_CODES.BAD_TABLE_TEXT,
        `「${SCOPE_PORT_ENV_KEY}」不是合法 JSON（${err?.message ?? err}）。`
        + '不忽略这一段：一个被静默丢掉的范围表，与一张"什么都没限制"的范围表，读数一样',
      )
    }
  }

  const root = workspaceRoot ?? env[SCOPE_PORT_CWD_ENV_KEY] ?? null
  // 装配规则只有一处（`scope-table-binding.mjs`）：三条拒绝 + 归一化 + 收窄 + cwd 派生。
  const table = bindScopeTable({ declaration, workspaceRoot: root })
  return Object.freeze({
    state: SCOPE_PORT_STATES.CONFIGURED,
    port: createScopePort({ table, realpath: resolver.realpath, exists: resolver.exists }),
    table,
    reason: null,
  })
}
