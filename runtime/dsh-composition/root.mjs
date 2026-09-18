// runtime/dsh-composition/root.mjs
// ============================================================================
// PRT-214：组合根（composition root）——**那个缺失的生产调用方**。
//
// ## 这个文件补的是哪一截
//
// 三件东西都已完整实现、各有套件、全绿，而**没有任何生产调用方**：
//
//   · `assembleEnforcement()`（`./assemble.mjs`）——造桥 + 一份共享登记簿 + 两行插件
//   · `bootstrapDshRuntime()`（`./bootstrap.mjs`）——自检 + 注册宿主端口
//   · `bindDshRuntime()`（`../../orchestrator/worker/executor-binding.mjs`）——注册口
//
// 后果不是"少了个便利函数"，而是 worker 的 `executor` 永远是
// `HOST_PORT_REQUIRED`，于是 PRT-253 的执行引擎与 PRT-510 的预算闸门
// **都不会被激活**：
//
//   > 一个从来没有人调用的装配函数，
//   > 与一个不存在的装配函数，在运行的部署上是同一个东西。
//
// 本模块是那条调用链上的一环：**补丁层的行模块 → 组合根 → assemble / bootstrap / bind**。
//
// ## 为什么是"根"而不是又一层便利包装
//
// `assemble.mjs` 存在的全部理由是**两行共用一份桥与一本登记簿**。
// 而"共用"只有在**整个进程只装配一次**时才成立：装配两次会得到两份桥、
// 两本登记簿，而行各自认领其中一份——组合树上看起来完全正常，
// 直到某一次 `ask` 留下的投影在审批那一侧查不到，于是审批永远问不到人。
//
//   > 一个"每个调用点各自装配一次"的部署，
//   > 与一个"三个强制点看到三个不同目标"的部署，是同一个东西——
//   > 只不过前者的失败只发生在真的有人要审批的时候。
//
// 所以本模块**只装配一次**并把那一份交出去（`installEnforcementRoot` 幂等，
// 已装好时再装返回 `ENFORCEMENT_ROOT_ALREADY_INSTALLED` 加**同一个** root）。
//
// ## 配置的权威来源还没定，所以本模块**不猜**
//
// `assemble.mjs` 的文件头已经写死这条：hub 地址 / scope / actor 的权威来源
// 未定（`docs/STATUS.md` 的 PRT-505 未决问题），猜出来的默认值会让
// 「没配」与「配对了」在读数上同形。本模块沿用同一立场，并且把它做成
// **可判定的三种处境**：
//
//   · `ENFORCEMENT_ROOT_CONFIG_MISSING`     —— 没有任何配置来源（没人配）
//   · `ENFORCEMENT_ROOT_CONFIG_EMPTY`       —— 来源在，但一个字段都没给（配了个空）
//   · `ENFORCEMENT_ROOT_CONFIG_UNREADABLE`  —— 来源在，但读不出来（坏的 JSON / 不是对象）
//
// 三者必须分开，因为修法不同：第一个要去找部署方要配置，第二个要看是不是
// 变量名写错或漏填了，第三个要去修那份坏掉的文件。合成一个码的话，
// 一份**解析失败**的配置会长成一份**从未被设置**的配置。
//
// 字段级同样：`hubUrl` / `actor` / `scope` / `action` / `cwd` 缺哪个报哪个，
// **一个都不补默认值**。缺 `actor` 就报 `ENFORCEMENT_ROOT_NO_ACTOR`——
// 一个默认 actor 会让审计里的授权主体变成一个谁也不是的名字。
//
// ## 端口只能注入，不能在本模块里造
//
//   · `decide`（策略门）由调用方注入。★ 本行**曾经**写着"全仓库只有测试实现，
//     没有生产实现"——**那句话现在是错的**：`plugins/root-row.mjs` 的
//     `createPolicyDecide()` 就是生产实现，而 `root-row.mjs:484` 在没显式给
//     `decide` 时用它。留这段订正记录是因为它不是一处笔误，而是本仓库
//     反复出现的形状：
//
//       > 一条"某能力只有测试实现"的断言，在实现被补上之后**不会自己失效**——
//       > 它只是从"事实"变成了"注释"，而注释不参与任何门禁。
//
//     仍然成立的那半句：`decide` 在本模块里**不许**造。它是策略门，
//     而策略属于部署配置（`LEGION_APPROVAL_POLICY` / `LEGION_ATTENDED`），
//     不是一个库文件能替调用方决定的东西。
//   · `requestApproval` 的真实实现是 `team-hub/approval-port.mjs`，
//     而 `team-hub/` → `runtime/dsh-composition/` 是**既有依赖方向**
//     （`scripts/ci/run-ci.mjs` 里记着：反向实测 0 处），本目录 import 它会成环。
//
// 所以两个端口一律由调用方注入（或缺 `requestApproval` 时注入一个
// `createRequestApproval(resolvedConfig)` 工厂——它同样由调用方提供，
// 于是"用哪个 hub 客户端"这件事仍然留在依赖方向允许的那一侧）。
//
// ## 本模块**不写**补丁层，也不 mount 任何东西
//
// 与 `index.mjs` 同一条纪律：DSH 的用户 profile 是 `patchReload: 'live'`，
// 往运行中的 profile 写入会立刻改掉**正在跑的 harness 的强制面，包括本会话自己**。
// 本模块只解析配置、装配一次、把 `mount(ctx)` / `bootstrap(deps)` / `bind(args)`
// 交给调用方，调用时机由调用方决定并留痕。
// ============================================================================

import { assembleEnforcement } from './assemble.mjs'
import { bootstrapDshRuntime } from './bootstrap.mjs'
import { bindDshRuntime } from '../../orchestrator/worker/executor-binding.mjs'

/** 接口（字段名 / 码语义）变化时递增。 */
export const ENFORCEMENT_ROOT_VERSION = 1

/** 本模块的具名码。 */
export const ENFORCEMENT_ROOT_CODES = Object.freeze({
  // ── 配置来源的三种处境（必须互相可分）──────────────────────────────────
  /** 没有任何配置来源：`env` 与 `config` 都没给。 */
  CONFIG_MISSING: 'ENFORCEMENT_ROOT_CONFIG_MISSING',
  /** 来源给了、也读得出来，但一个字段都没有。 */
  CONFIG_EMPTY: 'ENFORCEMENT_ROOT_CONFIG_EMPTY',
  /** 来源给了，但读不出来（坏 JSON / 不是普通对象）。 */
  CONFIG_UNREADABLE: 'ENFORCEMENT_ROOT_CONFIG_UNREADABLE',
  // ── 字段级：缺哪个报哪个，**不补默认值** ────────────────────────────────
  /** 没有 hub 地址。**不给 `http://127.0.0.1:8787`**：猜出来的地址会让"没配"与"配对了"同形。 */
  NO_HUB_URL: 'ENFORCEMENT_ROOT_NO_HUB_URL',
  /** 没有授权主体 actor。**不给默认身份**。 */
  NO_ACTOR: 'ENFORCEMENT_ROOT_NO_ACTOR',
  /** 没有空间 scope。**不给默认空间**。 */
  NO_SCOPE: 'ENFORCEMENT_ROOT_NO_SCOPE',
  /** 没有授权动作 action。**不给默认动作**：它会进 canonical 授权哈希。 */
  NO_ACTION: 'ENFORCEMENT_ROOT_NO_ACTION',
  /** 没有 cwd。路径范围与规范化都靠它，缺了就没有"界内"可言。 */
  NO_CWD: 'ENFORCEMENT_ROOT_NO_CWD',
  // ── 端口 ────────────────────────────────────────────────────────────────
  /** 没给策略端口 `decide`，也没有可用的生产实现。 */
  NO_DECIDE_PORT: 'ENFORCEMENT_ROOT_NO_DECIDE_PORT',
  /** 没给审批端口 `requestApproval`，也没给 `createRequestApproval` 工厂。 */
  NO_APPROVAL_PORT: 'ENFORCEMENT_ROOT_NO_APPROVAL_PORT',
  /** 端口工厂抛错（例如 hub 客户端造不出来）。 */
  BAD_WIRING: 'ENFORCEMENT_ROOT_BAD_WIRING',
  // ── 单例 ────────────────────────────────────────────────────────────────
  /**
   * 进程里已经装好一份了。
   *
   * **不是**"取回旧的那一份"：它带着 `root`，因为调用方要的通常是"那一份"，
   * 而这个码要说的是"你这次给的参数**没有被使用**"——静默换掉实现会让
   * 已挂上的行继续用第一份桥，那就又回到"每处各自一份"了。
   */
  ALREADY_INSTALLED: 'ENFORCEMENT_ROOT_ALREADY_INSTALLED',
  /** `assembleEnforcement` 自己抛了（透传它的码）。 */
  ASSEMBLY_FAILED: 'ENFORCEMENT_ROOT_ASSEMBLY_FAILED',
})

/**
 * 必填字段，**按这个顺序**报第一个缺的。
 *
 * 顺序是"先地址、后身份、再动作、最后工作目录"：先报 hub 地址是因为
 * 它决定了这份配置是不是给对了部署；`actor` 在 `scope` 之前是因为
 * "谁"比"在哪个空间"更常被漏填。
 */
export const REQUIRED_ENFORCEMENT_CONFIG = Object.freeze([
  'hubUrl', 'actor', 'scope', 'action', 'cwd',
])

/**
 * 字段 → 可接受的名字。
 *
 * `configKeys` 是**显式注入的配置对象**上的键；`envKeys` 是**显式注入的
 * env 对象**上的键（本模块不读 `process.env`，见文件头）。
 *
 * ⚠️ 诚实边界：`TEAM_HUB_URL` / `TEAM_HUB_TOKEN` 是仓库既有约定
 * （`orchestrator/worker/run.mjs` 的 `WORKER_ENV`，且已在
 * `orchestrator/config-schema.mjs` 的 `ENV_NAMES` 里声明）；而
 * `LEGION_ACTOR` / `LEGION_SCOPE` / `LEGION_ENFORCEMENT_ACTION` / `LEGION_CWD` /
 * `LEGION_TASK_ID` **在本批次之前没有任何权威来源**——它们是本模块选的键名，
 * 不是从 spec 里读出来的。理由见
 * `docs/superpowers/prt/PRT-214-enforcement-composition-root.md` 的「诚实边界」。改名只需改这一处。
 *
 * ⚠️ 而且：`runtime/` **不是** `scripts/config/scan.mjs` 登记的进程目录
 * （`scripts/config/check.mjs` 的 `SCHEMA_FILES` 里只有 team-hub / workbench /
 * whiteboard / plugins / board-plugin / services-plugin / product / orchestrator），
 * 所以 `scan --check` **看不见**这几个键名——本仓库"每个 SCREAMING_SNAKE_CASE
 * 字面量都要在所属进程的 config-schema.mjs 里声明"那条硬规矩，
 * 在这里**没有所属 schema 可声明**。
 *
 * 在把 `runtime` 登记进 `SCHEMA_FILES`（那是另一件事）之前，
 * 唯一会拦住"悄悄多读一个环境变量"的判据是
 * `root.test.mjs` 里那条"env 键名是闭集"的用例。
 *
 *   > 一个没有机器判据的规矩，与一条不存在的规矩，
 *   > 在"它到底拦住了什么"上是同一个东西。
 */
export const ENFORCEMENT_CONFIG_FIELDS = Object.freeze({
  hubUrl: Object.freeze({ configKeys: Object.freeze(['hubUrl']), envKeys: Object.freeze(['TEAM_HUB_URL']) }),
  hubToken: Object.freeze({ configKeys: Object.freeze(['hubToken']), envKeys: Object.freeze(['TEAM_HUB_TOKEN']) }),
  actor: Object.freeze({ configKeys: Object.freeze(['actor']), envKeys: Object.freeze(['LEGION_ACTOR']) }),
  scope: Object.freeze({ configKeys: Object.freeze(['scope']), envKeys: Object.freeze(['LEGION_SCOPE']) }),
  action: Object.freeze({ configKeys: Object.freeze(['action']), envKeys: Object.freeze(['LEGION_ENFORCEMENT_ACTION']) }),
  cwd: Object.freeze({ configKeys: Object.freeze(['cwd']), envKeys: Object.freeze(['LEGION_CWD']) }),
  taskId: Object.freeze({ configKeys: Object.freeze(['taskId']), envKeys: Object.freeze(['LEGION_TASK_ID']) }),
  platform: Object.freeze({ configKeys: Object.freeze(['platform']), envKeys: Object.freeze([]) }),
})

/** 字段缺省时对应的码。**一处定义**：`REQUIRED_ENFORCEMENT_CONFIG` 与它必须同步。 */
const MISSING_FIELD_CODES = Object.freeze({
  hubUrl: ENFORCEMENT_ROOT_CODES.NO_HUB_URL,
  actor: ENFORCEMENT_ROOT_CODES.NO_ACTOR,
  scope: ENFORCEMENT_ROOT_CODES.NO_SCOPE,
  action: ENFORCEMENT_ROOT_CODES.NO_ACTION,
  cwd: ENFORCEMENT_ROOT_CODES.NO_CWD,
})

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function describe(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

/** 从一份来源里按名单取"非空白字符串"，取不到返回 `null`（**不是空串**）。 */
function readString(source, keys) {
  if (source === null) return null
  for (const key of keys) {
    const v = source[key]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return null
}

function configRefusal(code, message, extra = {}) {
  const missing = Object.freeze([...(extra.missing ?? [])])
  return Object.freeze({
    ok: false,
    code,
    message,
    missing,
    reasons: Object.freeze([...(extra.reasons ?? [message])]),
  })
}

/**
 * 解析 Legion enforcement 配置。
 *
 * **纯函数**：只读传进来的 `env` / `config`，不读 `process.env`，不碰文件系统。
 * 这是本批次能被测的前提——"没配 / 配了个空 / 配坏了"三种处境都能在进程内造出来。
 *
 * @param {object} [input]
 * @param {object} [input.env] 显式注入的 env 对象（**不给就不读任何环境**）。
 * @param {object|string} [input.config] 显式注入的配置对象，或一份 JSON 文本。
 * @returns {{ok: true, values: object, sources: object}
 *   | {ok: false, code: string, message: string, missing: string[], reasons: string[]}}
 */
export function resolveEnforcementConfig({ env, config } = {}) {
  const hasEnv = env !== undefined && env !== null
  const hasConfig = config !== undefined && config !== null
  if (!hasEnv && !hasConfig) {
    return configRefusal(ENFORCEMENT_ROOT_CODES.CONFIG_MISSING,
      '没有给任何配置来源（env / config 都缺席）。' +
      '**本模块不读 process.env、也不给默认值**：一个凭空来的 hub 地址或 actor ' +
      '会让"没配"与"配对了"在读数上完全同形')
  }

  let fromEnv = null
  if (hasEnv) {
    if (!isPlainObject(env)) {
      return configRefusal(ENFORCEMENT_ROOT_CODES.CONFIG_UNREADABLE,
        `env 必须是普通对象（键值对），收到 ${describe(env)}`)
    }
    fromEnv = env
  }

  let fromConfig = null
  if (hasConfig) {
    if (typeof config === 'string') {
      // ★ 空白字符串 = "配了个空"，不是"读不出来"，也不是"没配"。
      if (config.trim() !== '') {
        let parsed
        try {
          parsed = JSON.parse(config)
        } catch (e) {
          return configRefusal(ENFORCEMENT_ROOT_CODES.CONFIG_UNREADABLE,
            `config 文本不是合法 JSON：${e?.message ?? String(e)}。` +
            '**这不是"没配"**：一份解析失败的配置与一份从未设置的配置，修法完全不同')
        }
        if (!isPlainObject(parsed)) {
          return configRefusal(ENFORCEMENT_ROOT_CODES.CONFIG_UNREADABLE,
            `config 文本解析出来是 ${describe(parsed)}，而配置必须是一个普通对象（命名项）`)
        }
        fromConfig = parsed
      }
    } else if (isPlainObject(config)) {
      fromConfig = config
    } else {
      return configRefusal(ENFORCEMENT_ROOT_CODES.CONFIG_UNREADABLE,
        `config 必须是普通对象或 JSON 文本，收到 ${describe(config)}`)
    }
  }

  const values = {}
  const sources = {}
  for (const [field, spec] of Object.entries(ENFORCEMENT_CONFIG_FIELDS)) {
    const fromC = readString(fromConfig, spec.configKeys)
    if (fromC !== null) {
      values[field] = fromC
      sources[field] = 'config'
      continue
    }
    const fromE = readString(fromEnv, spec.envKeys)
    values[field] = fromE
    sources[field] = fromE === null ? null : 'env'
  }

  if (Object.values(values).every((v) => v === null)) {
    return configRefusal(ENFORCEMENT_ROOT_CODES.CONFIG_EMPTY,
      '配置来源存在，但一个字段都没有给（全是空白或未设置）。' +
      '**与"没给来源"分开**：这一种更像是变量名写错或漏填，而不是部署方忘了配')
  }

  const missing = REQUIRED_ENFORCEMENT_CONFIG.filter((f) => values[f] === null)
  if (missing.length > 0) {
    const first = missing[0]
    return configRefusal(MISSING_FIELD_CODES[first],
      `配置缺少必填字段 ${first}（还缺：${missing.join(', ')}）。` +
      '**一个都不补默认值**：默认 hub 地址 / actor / action 会让"没配"与"配对了"同形，' +
      '而默认 action 还会进 canonical 授权哈希',
      { missing })
  }

  return Object.freeze({
    ok: true,
    code: null,
    values: Object.freeze({ ...values }),
    sources: Object.freeze({ ...sources }),
  })
}

/**
 * 把解析结果翻成 `assembleEnforcement` 要的 Legion 上下文。
 *
 * `taskId` 允许是 `null`（桥只拒绝 `undefined`）：进程级装配时常常还没有任务。
 * `platform` 缺省**不传**，让桥回落 `process.platform`——那是桥自己的既有行为，
 * 本模块不替它决定。
 */
export function enforcementContextOf(values) {
  return Object.freeze({
    scope: values.scope,
    actor: values.actor,
    action: values.action,
    taskId: values.taskId ?? null,
    cwd: values.cwd,
    ...(values.platform === null || values.platform === undefined ? {} : { platform: values.platform }),
  })
}

// ---------------------------------------------------------------------------
// 进程级单例
// ---------------------------------------------------------------------------

/**
 * 进程级的**唯一**一份装配。
 *
 * 三种取值必须互相可分：
 *   · `null`            —— 从来没装过（`enforcementInstallation()` 也返回 null）；
 *   · `{ ok: false }`   —— 装过、**拒绝了**，带着码与理由；
 *   · `{ ok: true }`    —— 装好了，`root` 就是那一份。
 *
 * "没装"与"装了但拒绝"合成一个的话，行模块只能说"没有组合根"，
 * 而真正的原因（缺 actor？坏 JSON？缺 decide 端口？）会被吞掉。
 */
let installation = null

/** 当前的安装结果（含拒绝）。没有装过返回 `null`。 */
export function enforcementInstallation() {
  return installation
}

/** 装好的那一份组合根；没装好（含拒绝）返回 `null`。 */
export function enforcementRoot() {
  return installation !== null && installation.ok === true ? installation.root : null
}

/** 丢掉进程级单例。**给用例用的**：不做这一步，测的是前面所有步骤的累积效果。 */
export function resetEnforcementRoot() {
  installation = null
}

function rememberRefusal(code, message, extra = {}) {
  const refused = Object.freeze({
    ok: false,
    code,
    message,
    missing: Object.freeze([...(extra.missing ?? [])]),
    reasons: Object.freeze([...(extra.reasons ?? [message])]),
    root: null,
  })
  installation = refused
  return refused
}

/**
 * 装配**一次**，并把那一份交出去。
 *
 * @param {object} input
 * @param {object} [input.env] 显式注入的 env 对象。
 * @param {object|string} [input.config] 显式注入的配置对象或 JSON 文本。
 * @param {(projection: object) => Promise<object>|object} input.decide 策略端口。
 * @param {(projection: object, opts: object) => Promise<string>} [input.requestApproval]
 *   team-hub 审批端口。
 * @param {(values: object) => Function} [input.createRequestApproval]
 *   端口工厂：拿解析好的配置去造审批端口。**由调用方提供**——真实的 hub 客户端
 *   住在 `team-hub/`，而 `runtime/` import 它会成环（见文件头）。
 * @param {object} [input.floor] / [input.whitelist] / [input.pathScope]
 *   透传给 `assembleEnforcement` 的静态下限 / 岗位白名单 / 路径范围。
 * @param {() => number} [input.now] 时间源（用例要能拨表）。
 * @param {(e: object) => void} [input.onDecision] 观测点，**不参与判定**。
 * @param {number} [input.connectTimeoutMs] / [input.responseTimeoutMs]
 *   / [input.approvalConnectTimeoutMs] / [input.approvalResponseTimeoutMs]
 * @returns {{ok: true, code: null, root: object}
 *   | {ok: false, code: string, message: string, missing: string[], reasons: string[], root: object|null}}
 */
export function installEnforcementRoot(input = {}) {
  if (installation !== null && installation.ok === true) {
    return Object.freeze({
      ok: false,
      code: ENFORCEMENT_ROOT_CODES.ALREADY_INSTALLED,
      message: '本进程已经装好一份组合根了。' +
        '**刻意不重建**：两次装配会得到两份桥与两本登记簿，' +
        '而行各自认领其中一份——组合树上看不出区别，直到一次 ask 留下的投影在审批侧查不到',
      missing: Object.freeze([]),
      reasons: Object.freeze(['已经有安装好的组合根；本次参数未被使用']),
      root: installation.root,
    })
  }
  if (input === null || typeof input !== 'object') {
    return rememberRefusal(ENFORCEMENT_ROOT_CODES.BAD_WIRING,
      `installEnforcementRoot 需要一个参数对象，收到 ${describe(input)}`)
  }

  const resolved = resolveEnforcementConfig({ env: input.env, config: input.config })
  if (!resolved.ok) {
    return rememberRefusal(resolved.code, resolved.message, {
      missing: resolved.missing, reasons: resolved.reasons,
    })
  }

  if (typeof input.decide !== 'function') {
    return rememberRefusal(ENFORCEMENT_ROOT_CODES.NO_DECIDE_PORT,
      '组合根需要 decide 端口（策略门）。' +
      '**不给默认值**：默认放行是静默降级，默认拒绝是静默停摆，两者都不会报错；' +
      '而全仓库目前**只有测试实现**，没有生产实现')
  }

  let requestApproval = null
  if (typeof input.requestApproval === 'function') {
    requestApproval = input.requestApproval
  } else if (typeof input.createRequestApproval === 'function') {
    try {
      requestApproval = input.createRequestApproval(resolved.values)
    } catch (e) {
      return rememberRefusal(ENFORCEMENT_ROOT_CODES.BAD_WIRING,
        `createRequestApproval 造端口时抛错：${e?.message ?? String(e)}` +
        (e?.code === undefined ? '' : `（code=${e.code}）`))
    }
    if (typeof requestApproval !== 'function') {
      return rememberRefusal(ENFORCEMENT_ROOT_CODES.BAD_WIRING,
        `createRequestApproval 返回了 ${describe(requestApproval)}，而它必须返回一个函数`)
    }
  }
  if (requestApproval === null) {
    return rememberRefusal(ENFORCEMENT_ROOT_CODES.NO_APPROVAL_PORT,
      '组合根需要 requestApproval 端口（team-hub 审批箱），或一个 createRequestApproval 工厂。' +
      '**不给默认值**：默认端口要么静默放行、要么永远问不到人')
  }

  const context = enforcementContextOf(resolved.values)

  let assembly
  try {
    assembly = assembleEnforcement({
      context,
      decide: input.decide,
      requestApproval,
      floor: input.floor,
      whitelist: input.whitelist,
      pathScope: input.pathScope,
      now: input.now,
      onDecision: input.onDecision,
      connectTimeoutMs: input.connectTimeoutMs,
      responseTimeoutMs: input.responseTimeoutMs,
      approvalConnectTimeoutMs: input.approvalConnectTimeoutMs,
      approvalResponseTimeoutMs: input.approvalResponseTimeoutMs,
    })
  } catch (e) {
    return rememberRefusal(ENFORCEMENT_ROOT_CODES.ASSEMBLY_FAILED,
      `assembleEnforcement 装配失败：${e?.code === undefined ? '' : `[${e.code}] `}${e?.message ?? String(e)}`,
      { reasons: [e?.code ?? 'unknown', e?.message ?? String(e)] })
  }

  const root = Object.freeze({
    version: ENFORCEMENT_ROOT_VERSION,
    /** 解析出来的配置（含 `hubToken` / `taskId` / `platform`，缺省为 `null`）。 */
    config: resolved.values,
    /** 每个字段是**从哪一份来源**读出来的（`'config'` / `'env'` / `null`）。 */
    configSources: resolved.sources,
    /** 交给桥的 Legion 身份。 */
    context,
    bridge: assembly.bridge,
    registry: assembly.registry,
    rows: assembly.rows,

    /** 把两行挂到一个 Context 上（转 `assembleEnforcement().mount`）。 */
    mount: (ctx) => assembly.mount(ctx),
    /** 反序卸载两行。 */
    dispose: () => assembly.dispose(),
    /**
     * ★★ 这份组合根的**进程内挂载账**：当前进程里真的挂上去的行名
     * （逐字等于补丁层声明里的行 id）。
     *
     * 它不是一件便利方法，而是**运行期行唯一的证据来源**：
     * `pre-execute` / `approval-answerer` 在补丁层声明里是 `module: null`
     * （YAML 装不了桥与端口），所以它们**永远不会**是 loader 条目——
     * `reconcilePatchLayer()` 若按组合树查它们，得到的那条红永远修不掉。
     *
     * 为什么这个读数**不能**用 `enforcementSurfaces()` 顶替：那个报的是"桥是用哪几个
     * 端口造出来的"，`assembleEnforcement()` 一跑就是 true/满的，与有没有人调
     * `mount()` 一点关系都没有。拿它当证据会让"删掉挂载"这件事在读数上消失。
     *
     * 账由 `mount()` 这个动作本身写（见 `assemble.mjs` 的 `mountedRowNames`）：
     * 没挂过 / 挂载失败 / 已拆装 / **这次挂载还没 settle** ⇒ **空数组**，
     * 调用方必须按未生效处理。
     *
     * ★ 最后那一项是本批补的：本读数此前是"挂载**发起**时覆盖的行"，
     * 于是 `mount()` 一返回它就已经是满的——而那一刻两个 `apply` 一个都还没跑。
     */
    mountedEnforcementRows: () => assembly.mountedRowNames(),

    /**
     * 这次挂载**覆盖**了哪几行（诊断读数，**不是**生效证据）。
     *
     * 与 `mountedEnforcementRows()` 分成两个口是刻意的：一个说"打算挂这两行"，
     * 一个说"真的挂上了"。合成一个就是本批修掉的那个假绿。
     */
    coveredEnforcementRows: () => assembly.coveredRowNames(),

    /**
     * 等当前这次挂载 settle（成功或失败都算）。**永不 reject**。
     *
     * 观察方（`plugins/runtime-host-row.mjs`）在读账**之前**等它：
     * 不等就会在窗口里读到空账 ⇒ `ROW_MISSING` ⇒ 自检判未生效 ⇒ 拒绝注册 ⇒
     * **一个健康的部署起不来**。把假绿修成假红，与什么都没修，在"产品能不能起来"
     * 这件事上是同一个东西。
     */
    mountSettled: () => assembly.mountSettled(),

    /** 强制面到底挂了几道——证据是"装上了什么"，不是"配置里写了什么"。 */
    enforcementSurfaces: () => assembly.enforcementSurfaces(),

    /**
     * 自检 + 注册宿主端口（转 `bootstrapDshRuntime`）。
     *
     * **不替调用方补任何输入**：组合树观察、沙箱端口、运行时宿主、`canRead`
     * 一律由调用方显式给。少给 `canRead` 时 `bootstrapDshRuntime` 自己会拒绝
     * （`BOOTSTRAP_BAD_WIRING`），而它拒绝时**什么都不注册**——这正是要保住的性质。
     */
    bootstrap: (deps) => bootstrapDshRuntime(deps),

    /**
     * 直接注册宿主端口（转 `bindDshRuntime`）。
     *
     * 返回的注销函数**幂等**且与调用顺序无关（栈语义，见 `executor-binding.mjs`）。
     * 缺 `selfCheck` 时 `bindDshRuntime` 当场抛——本模块**不补一个假的**：
     * 一个默认"自检通过"会让「强制面未生效时禁止自动执行」这条保证失效。
     */
    bind: (args) => bindDshRuntime(args),
  })

  installation = Object.freeze({ ok: true, code: null, message: null, root })
  return installation
}
