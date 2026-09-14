// runtime/dsh-composition/plugins/root-row.mjs
// ============================================================================
// PRT-214（续）：`legion-enforcement-root` 那一行的**可加载模块**——
// 补丁层里**第一个真的会去调 `installEnforcementRoot()` 的生产调用方**。
//
// ## 它补的是哪一截
//
// `root.mjs` 把"缺生产调用方"这件事解决到"有人可以调"为止，而**没有任何东西调它**：
//
//   · 静态补丁层里没有这一行；
//   · 两行运行期模块（`pre-execute-row` / `approval-answerer-row`）先要组合根装好
//     才挂得上，而"装组合根"这一步本身没有调用方。
//
//   > 一个"写好了、也验证过能被调用"的组合根，
//   > 与一个"从未被任何进程调用过"的组合根，在运行的部署上是同一个东西——
//   > 只不过前者的用例是绿的。
//
// 本文件是那一行的模块：它**在 DSH 进程里**读环境、造端口、装配一次、把服务发布出去。
//
// ## ★ 为什么这一行敢进静态补丁层，而另外两行不
//
// `patch-layer.mjs` 里另外两行写的是 `module: null` + `runtimeModule`，理由是
// "它们要的是桥与端口（函数），YAML 装不下"。本行**不**需要 YAML 携带任何函数：
//
//   · 身份 / hub 地址 / cwd 来自**进程环境**（Launcher 注入，见 `product/launcher/`）；
//   · `decide` 由本文件从 `approval-policy.mjs` 的 `decideApproval` 造（同目录，方向干净）；
//   · `requestApproval` 由**注入的工厂**造——不能由本目录 import `team-hub/`。
//
// 第三条是本批次唯一一处"接线还没到位"的地方，写清楚：
//
//   `team-hub/` → `runtime/dsh-composition/` 是本仓库既有的分层方向
//   （`team-hub/tool-call-log.mjs`、`permission-engine.mjs`、`tool-request-bridge.mjs`
//   都这样 import，反向实测 0 处）。而 `team-hub/approval-port.mjs` 自己 import
//   `team-hub/tool-request-bridge.mjs`，后者又 import 本目录的 `tool-args.mjs`——
//   所以本目录 import 它**不只是反转一条约定，而是造一个真实的模块环**。
//
//   > 一个"能跑、但把一条已经一致的分层方向反转过来"的 import，
//   > 与一个"下次改动时在同一对目录之间来回打转"的 import，是同一个东西——
//   > 只不过前者在今天就跑得通。
//
// 所以端口工厂走**注入**（`setApprovalPortFactory` / `createRootRow({createRequestApproval})`），
// 注册方留在依赖方向允许的那一侧。**注册方已经交付**（PRT-214 续）：它就是
// `team-hub/approval-registrar-row.mjs`，也**就是本行在补丁层里的那个模块**——
// 它在模块求值期注册工厂，并默认导出本文件的 `default`（`===`，不是替身）。
//
//   > 一个"注册方是另一行、靠补丁行顺序先求值"的接线，
//   > 与一个"注册方与本行同处一个模块图、求值必然在前"的接线，
//   > 在前者碰巧顺序对的那次运行里是同一个东西——只不过前者会在别人的机器上偶发地红。
//
// 没有工厂时本行仍然**拒绝装配**，而不是装一个"没有审批口"的半根——一个批不准
// 问人的强制面，与一个"审批永远问不到人"的强制面，是同一个东西。这条拒绝在
// 真 DSH 进程里是**可达的**：`root-row-dsh-process.test.mjs` 把本文件当成一行的
// 模块直接挂（不带注册方），读的就是它。
//
// ## ★ 为什么本行**发布一个服务**，而不只是把自己装好
//
// `patch-layer.mjs` 的文件头写死了：**行顺序不携带加载语义**。三行谁先谁后由 DSH
// 的组合顺序决定，我们不得假设。所以"组合根先装好、两行再挂"这件事**不能靠顺序**，
// 只能靠 Cordis 自己的机制：本行 `ctx.provide(ENFORCEMENT_ROOT_SERVICE, …)`，
// 另外两行 `inject: [ENFORCEMENT_ROOT_SERVICE]`——依赖没到位时它们进 **pending**，
// 服务一出现 Cordis 自己把它们激活。
//
// 反过来说：如果本行**没有**进补丁层（或它在 `apply` 期抛了），那两行会一直
// pending。这不是静默——DSH 的挂载审计会报 `N row(s) did not activate`，
// 而那正是 `reconcilePatchLayer()` 的 `ROW_NOT_ACTIVATED` 判据读的东西。
//
// ## 配置读不出来时：**在 apply 期抛**，不装半根
//
// 与 `hard-floor.mjs` 的 `NO_GUARD_SEAM`、两行运行期模块同一条口径。三条理由：
//
//   ① 抛出来的码说得清是哪一件（没配 / 配了个空 / 缺哪个字段），而"装了个半根"
//      只会在第一次有人要审批的时候以别的形式暴露；
//   ② 本行**在**静态补丁层里，所以它的失败是启动路径上的失败——那正是我们想要的：
//      一个"被要求装上、却没装上"的强制面必须拦启动，不能只写一行日志；
//   ③ 一个默认值（hub 地址 / actor）会让"没配"与"配对了"在读数上完全同形。
// ============================================================================

import { APPROVAL_POLICIES, decideApproval } from '../approval-policy.mjs'
import {
  ENFORCEMENT_ROOT_CODES,
  enforcementInstallation,
  installEnforcementRoot,
} from '../root.mjs'

/** 改动绑定方式时递增。 */
export const ROOT_ROW_VERSION = 1

/** 补丁层的行 id 与插件名**必须逐字相同**（挂载审计按它对号）。 */
export const ROOT_ROW_PLUGIN_NAME = 'legion-enforcement-root'

/**
 * 本行发布的服务名。
 *
 * 另外两行 `inject` 它。名字是**产品自己的**服务名，不是 DSH 的——DSH 不认识它，
 * 只负责在它出现之前把依赖它的行摁在 pending 上。
 */
export const ENFORCEMENT_ROOT_SERVICE = 'legionEnforcementRoot'

/** 本行的失败码（全部在 `apply` 期抛，不吞）。 */
export const ROOT_ROW_CODES = Object.freeze({
  /** `ctx.provide` / `ctx.plugin` 不在——挂到了一个不是 Context 的东西上。 */
  NO_CONTEXT: 'ENFORCEMENT_ROOT_ROW_NO_CONTEXT',
  /** 拿不到进程环境（注入的 env 不是普通对象，或进程里根本没有 `process.env`）。 */
  NO_ENV: 'ENFORCEMENT_ROOT_ROW_NO_ENV',
  /** 组合根拒绝了这次装配——理由码透传在消息里（配置缺失 / 读不出来 / 缺字段）。 */
  CONFIG_UNRESOLVED: 'ENFORCEMENT_ROOT_ROW_CONFIG_UNRESOLVED',
  /** 没有任何审批端口工厂可用（也没给 `requestApproval`）。见文件头"为什么是注入"。 */
  NO_APPROVAL_PORT_FACTORY: 'ENFORCEMENT_ROOT_ROW_NO_APPROVAL_PORT_FACTORY',
  /** 工厂抛了 / 返回的东西不是审批端口。 */
  APPROVAL_PORT_UNUSABLE: 'ENFORCEMENT_ROOT_ROW_APPROVAL_PORT_UNUSABLE',
  /** `decide` 需要的策略输入没配（或不在闭集里）——**在判定期**抛，见 `createPolicyDecide`。 */
  DECIDE_INPUT_MISSING: 'ENFORCEMENT_ROOT_ROW_DECIDE_INPUT_MISSING',
  /** `decideApproval` 的 ① 分支不再与 policy/attended 无关——`createPolicyDecide` 的捷径失效。 */
  NONE_SHORTCUT_DRIFTED: 'ENFORCEMENT_ROOT_ROW_NONE_SHORTCUT_DRIFTED',
})

function rowError(code, message, extra = {}) {
  const err = new Error(message)
  err.code = code
  Object.assign(err, extra)
  return err
}

/**
 * `decide` 适配器要读的环境键名（闭集，`root-row.test.mjs` 钉住它）。
 *
 * ⚠️ 与 `LEGION_ACTOR` 那一组同一个处境：**本批次之前没有任何权威来源**，
 * 而且 `runtime/` 不在 `scripts/config/scan.mjs` 的 `PROCESSES` 里，
 * 所以 `scan --check` 看不见这几个键名（详见文件末尾与 PRT-214 文档的诚实边界）。
 */
export const DECIDE_ENV_KEYS = Object.freeze({
  policy: 'LEGION_APPROVAL_POLICY',
  attended: 'LEGION_ATTENDED',
  preset: 'LEGION_PERMISSION_PRESET',
})

/** 一个投影"要不要人"→ `decideApproval` 的 `requirement` 闭集里的一个值。 */
export const REQUIREMENT_OF = Object.freeze({
  needsHuman: 'ask',
  none: 'none',
})

/**
 * `decideApproval` 的 ① 分支（不需要人 → `allow-by-policy`）**不读** policy/attended。
 *
 * 本模块的 `decide` 适配器靠这一条对"不需要人的调用"短路——否则一个没配
 * `LEGION_APPROVAL_POLICY` 的进程会**把每一次只读工具调用也拒掉**，
 * 而那与"强制面正常工作"在读数上分不开（都是"什么都没执行"）。
 *
 * 但"① 分支不读 policy/attended"是**别人的契约**，不是本模块的假设。所以这里
 * 在装载期把它**测一遍**：两种 policy × 两种 attended 都必须得到 `allow-by-policy`。
 * 一旦 `decideApproval` 改了这条，本模块当场抛——一个靠契约的捷径，
 * 与一个靠注释的捷径，区别就在这里。
 */
export function assertNoneShortcutHolds(decide = decideApproval) {
  for (const policy of APPROVAL_POLICIES) {
    for (const attended of [true, false]) {
      const v = decide({ policy, requirement: 'none', attended })
      if (v?.decision !== 'allow-by-policy') {
        throw rowError(ROOT_ROW_CODES.NONE_SHORTCUT_DRIFTED,
          `${ROOT_ROW_PLUGIN_NAME} 的 decide 适配器假设「requirement=none ⇒ allow-by-policy」` +
          `与 policy/attended 无关，而 decideApproval({policy:${policy}, attendant:${attended}}) 返回了 ` +
          `${JSON.stringify(v?.decision)}。捷径已失效：必须改成把 policy/attended 传进去`)
      }
    }
  }
  return true
}

/** 装载期结论（`true`；不成立就抛）。 */
export const NONE_SHORTCUT_CHECKED = assertNoneShortcutHolds()

/** `approval-policy` 的判定词 → DSH `PreToolDecision` 的 `kind`。 */
function kindOfDecision(decision) {
  if (decision === 'allow-by-policy') return { kind: 'allow' }
  if (decision === 'ask') return { kind: 'ask' }
  if (decision === 'deny') return { kind: 'deny' }
  // `hold`（策略说 ask、而现场没人）在 DSH 的闭集里**没有对应值**。
  //
  // 这里选 `ask`：DSH 会把请求交给审批 waterfall，而审批口在没人/连不上时
  // 返回 `unavailable` → **工具不执行**。也就是"保持等待"，而不是"记成一次拒绝"。
  //
  //   > 一个「把 hold 记成 deny」的映射，
  //   > 与一个「把'我们问不到人'记成'人拒绝了'」的审计，是同一个东西。
  //
  // ⚠️ 这是一个**判断**，不是从两边契约推出来的：DSH 没有 hold 语义，
  //    只能选一个最不坏的。理由进 `reasonVisibleHint`，见 PRT-214 的诚实边界。
  if (decision === 'hold') return { kind: 'ask' }
  return null
}

/**
 * 造 `decide` 端口（策略门）——**生产实现**，此前全仓库只有测试实现。
 *
 * 签名与 `createEnforcementBridge({decide})` 要的一致：`(projection) => decision`。
 *
 * 输入里 policy / attended 缺了会**在判定期抛**（不是装载期）：
 *   · 装载期抛会让"没配审批策略"变成"整个强制面装不上"，连只读工具都被拒；
 *   · 判定期抛由 `createPreExecutePolicy` 接住并转成 **deny（fail closed）**，
 *     而且理由里带着"策略门不可用"——审计上不会被读成"策略说不"。
 *
 * @param {object} [o]
 * @param {string|null} [o.policy]     `'ask' | 'never'`（`LEGION_APPROVAL_POLICY`）
 * @param {boolean|null} [o.attended]  现场有没有人（`LEGION_ATTENDED`）
 * @param {string|null} [o.preset]     权限档位名（可选，给了就一起校验）
 * @param {Function} [o.decideApprovalImpl] 仅供用例注入
 */
export function createPolicyDecide({
  policy = null, attended = null, preset = null, decideApprovalImpl = decideApproval,
} = {}) {
  if (typeof decideApprovalImpl !== 'function') {
    throw rowError(ROOT_ROW_CODES.DECIDE_INPUT_MISSING, 'createPolicyDecide 需要一个 decideApproval 实现')
  }

  return function decide(projection) {
    // 与 `tool-request.mjs` 的投影同源：`requiresApproval` 是桥从工具能力表算出来的**事实**，
    // 不是本适配器猜的。缺字段时按"需要人"处理（fail closed），不按"不需要"。
    const requiresApproval = projection?.requiresApproval === true
    const requirement = requiresApproval ? REQUIREMENT_OF.needsHuman : REQUIREMENT_OF.none

    if (requirement === REQUIREMENT_OF.none) {
      // 见 `NONE_SHORTCUT_CHECKED`：这一条的正确性由装载期检查守着。
      return { kind: 'allow' }
    }

    if (typeof policy !== 'string' || !APPROVAL_POLICIES.includes(policy)) {
      throw rowError(ROOT_ROW_CODES.DECIDE_INPUT_MISSING,
        `这次调用需要人（requiresApproval），而进程里没有可用的审批策略：` +
        `环境变量 ${DECIDE_ENV_KEYS.policy} 必须是 ${JSON.stringify([...APPROVAL_POLICIES])} 之一，` +
        `当前是 ${JSON.stringify(policy)}。**不猜**：默认 ask 会让无人值守的进程去问一个不在场的人，` +
        `默认 never 会把"没配"静默变成"一律拒绝"`)
    }
    if (typeof attended !== 'boolean') {
      throw rowError(ROOT_ROW_CODES.DECIDE_INPUT_MISSING,
        `这次调用需要人（requiresApproval），而进程里没有说清现场有没有人：` +
        `环境变量 ${DECIDE_ENV_KEYS.attended} 必须是 'true' 或 'false'，当前是 ${JSON.stringify(attended)}。` +
        '**不猜**：一个"默认现场有人"的输入，与一个"去问一个不在场的人"的实现，是同一个东西')
    }

    const verdict = decideApprovalImpl({
      policy, requirement, attended, preset,
      // 高风险写是 spec §6.6 line 466 的类别；投影里没有就直接算"不是"，
      // 因为 `highRisk` 只影响 `decideApproval` 的附加信息，不影响 allow/deny 分支
      // （决策来自 policy 与 attended 两件事）。
      highRisk: projection?.risk === 'high',
    })
    const kind = kindOfDecision(verdict?.decision)
    if (kind === null) {
      throw rowError(ROOT_ROW_CODES.DECIDE_INPUT_MISSING,
        `decideApproval 返回了本适配器不认识的判定 ${JSON.stringify(verdict?.decision)}`)
    }
    const reason = typeof verdict?.reason === 'string' && verdict.reason !== ''
      ? verdict.reason
      : `策略判定 ${verdict?.decision}`
    return kind.kind === 'allow' ? kind : { ...kind, reason }
  }
}

/** 从注入的 env 里读 `decide` 的三个输入。取不到就是 `null`（**不是默认值**）。 */
export function decideInputsFromEnv(env) {
  const str = (k) => (typeof env?.[k] === 'string' && env[k].trim() !== '' ? env[k].trim() : null)
  const rawAttended = str(DECIDE_ENV_KEYS.attended)
  return Object.freeze({
    policy: str(DECIDE_ENV_KEYS.policy),
    // 只认字面 'true' / 'false'：'1' / 'yes' / 'on' 一律当"没说清"，
    // 因为"说清了但拼错"与"没说"必须走同一条 fail closed 的路。
    attended: rawAttended === 'true' ? true : rawAttended === 'false' ? false : null,
    preset: str(DECIDE_ENV_KEYS.preset),
  })
}

// ── 审批端口工厂的注册缝 ────────────────────────────────────────────────────
//
// 注册方必须住在 `team-hub/` 那一侧（依赖方向），本模块只留一个口。
// 已交付的注册方是 `team-hub/approval-registrar-row.mjs`：它在**模块求值期**调
// `setApprovalPortFactory(...)`，并且**就是本行在补丁层里的模块**——这样
// "注册先于 `apply`"由 ESM 的求值顺序保证，而不是由补丁行顺序保证。
// 这里不留任何默认实现：一个自带的默认端口会把"没人注册"变成"装上了一个
// 永远问不到人的端口"。

let registeredFactory = null

/**
 * 注册审批端口工厂（由 `team-hub/` 侧调用）。
 *
 * @param {(resolved: object) => object|Function} factory
 *   收到解析好的身份配置，返回 `{requestApproval}` 或直接返回 `requestApproval` 函数。
 * @returns {() => void} 注销（幂等）。后注册的覆盖先注册的，注销只撤掉自己那一次。
 */
export function setApprovalPortFactory(factory) {
  if (factory !== null && typeof factory !== 'function') {
    throw rowError(ROOT_ROW_CODES.NO_APPROVAL_PORT_FACTORY,
      'setApprovalPortFactory 需要函数（或 null 表示"没有工厂"）')
  }
  const previous = registeredFactory
  registeredFactory = factory
  let done = false
  return () => {
    if (done) return
    done = true
    if (registeredFactory === factory) registeredFactory = previous
  }
}

/** 当前注册的工厂（`null` = 没有）——给用例与诊断读。 */
export function approvalPortFactory() {
  return registeredFactory
}

/** 把工厂的返回值翻成审批端口；形状不对就抛（不静默降级成"没有端口"）。 */
function requestApprovalOf(factoryResult, resolved) {
  const candidate = typeof factoryResult === 'function' ? factoryResult : factoryResult?.requestApproval
  if (typeof candidate !== 'function') {
    throw rowError(ROOT_ROW_CODES.APPROVAL_PORT_UNUSABLE,
      `${ROOT_ROW_PLUGIN_NAME} 的审批端口工厂没有给出可用的 requestApproval` +
      `（收到 ${factoryResult === null ? 'null' : typeof factoryResult}）。` +
      '一个"工厂接上了、但端口是空的"接线，与一个"根本没接"的接线，在运行时的表现一样——' +
      '只不过前者看起来是配好的')
  }
  void resolved
  return candidate
}

/**
 * 造出补丁层那一行要加载的插件。
 *
 * 默认（`default` 导出）用**进程环境**与已注册的工厂；用例可以逐项注入。
 *
 * @param {object} [o]
 * @param {object|null} [o.env] `undefined` = 在 `apply` 期读 `process.env`；`null` = 明确没有环境。
 * @param {Function|null} [o.createRequestApproval] 显式给的审批端口工厂（优先于注册缝）。
 * @param {Function|null} [o.decide] 显式给的策略端口（优先于由 `decideApproval` 造的）。
 */
export function createRootRow({
  env = undefined, createRequestApproval = null, decide = null,
} = {}) {
  const plugin = {
    name: ROOT_ROW_PLUGIN_NAME,

    // 本行**不 inject 任何东西**：它是被依赖的那一端。装配只需要进程环境与注入的端口，
    // 而"哪些服务该在场"不是它的依赖——它是那两行 enforcement 行的依赖。
    inject: [],

    apply(ctx) {
      if (ctx === null || typeof ctx !== 'object' || typeof ctx.provide !== 'function') {
        throw rowError(ROOT_ROW_CODES.NO_CONTEXT,
          `${ROOT_ROW_PLUGIN_NAME} 需要一个 Cordis Context（要能 ctx.provide 发布组合根服务）`)
      }

      const effectiveEnv = env === undefined ? processEnv() : env
      if (effectiveEnv === null || typeof effectiveEnv !== 'object' || Array.isArray(effectiveEnv)) {
        throw rowError(ROOT_ROW_CODES.NO_ENV,
          `${ROOT_ROW_PLUGIN_NAME} 拿不到进程环境（${effectiveEnv === null ? 'null' : typeof effectiveEnv}）。` +
          '身份配置只从环境来，**不读配置文件、不给默认值**——一个凭空来的 actor ' +
          '会让审计里的授权主体变成一个谁也不是的名字')
      }

      const inputs = decideInputsFromEnv(effectiveEnv)
      const effectiveDecide = decide ?? createPolicyDecide(inputs)

      const installed = installEnforcementRoot({
        env: effectiveEnv,
        decide: effectiveDecide,
        // ★ 传的是**工厂**，不是端口：端口的真实实现住在 team-hub 那一侧，
        //   而组合根在装配期拿到的是一份解析好的身份配置。
        createRequestApproval: (resolved) => {
          const factory = createRequestApproval ?? registeredFactory
          if (typeof factory !== 'function') {
            throw rowError(ROOT_ROW_CODES.NO_APPROVAL_PORT_FACTORY,
              `${ROOT_ROW_PLUGIN_NAME} 没有可用的审批端口工厂：本目录**不能** import ` +
              '`team-hub/approval-port.mjs`（那会反转既有分层方向并造出真实的模块环，见文件头）。' +
              '注册方（team-hub 侧）用 `setApprovalPortFactory()` 注入，或调用方用 ' +
              '`createRootRow({createRequestApproval})` 显式给。**不装半根**：' +
              '一个没有审批口的强制面，与一个"审批永远问不到人"的强制面，是同一个东西')
          }
          let produced
          try {
            produced = factory(resolved)
          } catch (err) {
            throw rowError(ROOT_ROW_CODES.APPROVAL_PORT_UNUSABLE,
              `${ROOT_ROW_PLUGIN_NAME} 的审批端口工厂抛了：${err?.message ?? err}`)
          }
          return requestApprovalOf(produced, resolved)
        },
      })

      if (installed.ok !== true && installed.code !== ENFORCEMENT_ROOT_CODES.ALREADY_INSTALLED) {
        // 组合根自己已经记下了这次拒绝（`enforcementInstallation()`），
        // 所以即使有人绕过本行去读单例，读到的也是"拒绝"而不是"从来没装过"。
        throw rowError(ROOT_ROW_CODES.CONFIG_UNRESOLVED,
          `${ROOT_ROW_PLUGIN_NAME} 拒绝装配：组合根给的是 ${installed.code}——${installed.message}` +
          `。缺的字段：${(installed.missing ?? []).join(', ') || '（未列出）'}`)
      }
      // `ALREADY_INSTALLED` 是幂等路径：本进程已经有一份好根（例如本行被挂了两次），
      // 这时**不重建**，直接发布那一份。服务值是**那一份真的安装结果**，
      // 不是本次调用的返回值——否则下游读到的是"拒绝"而根其实好好的。
      const published = installed.ok === true ? installed : enforcementInstallation()

      // ★ 发布服务：另外两行 `inject` 它。顺序语义由 Cordis 提供，不由补丁层的行序提供。
      //
      //   幂等：同一进程里第二次挂本行时服务已在，不再 provide（`ctx.provide` 对
      //   重复注册是抛错，而不是覆盖）。
      const already = typeof ctx.get === 'function' ? ctx.get(ENFORCEMENT_ROOT_SERVICE, false) : undefined
      if (already === undefined) {
        ctx.provide(ENFORCEMENT_ROOT_SERVICE, published)
      }

      ctx.logger?.info?.(
        `[${ROOT_ROW_PLUGIN_NAME}] v${ROOT_ROW_VERSION} 已装配组合根并发布服务 ` +
        `${ENFORCEMENT_ROOT_SERVICE}（另外两行靠它决定何时激活；顺序不靠补丁层的行序）`,
      )
    },
  }

  // 诊断用（**不可枚举**）：本行实际用到的环境与端口工厂。
  // 与 `pre-execute.mjs` 同一条理由——"记录了我传了什么"与"记录了行实际闭包到什么"
  // 在传错参数时是同一个东西，只不过前者用例照样绿。
  Object.defineProperty(plugin, 'env', { value: env, enumerable: false })
  Object.defineProperty(plugin, 'policyDecideInputs', {
    value: () => decideInputsFromEnv(env === undefined ? processEnv() : env),
    enumerable: false,
  })
  Object.defineProperty(plugin, 'approvalPortFactory', {
    value: () => createRequestApproval ?? registeredFactory,
    enumerable: false,
  })
  return plugin
}

/** 进程环境。**只在这里读**，且只在 `apply` 期读（模块顶层不碰 `process`）。 */
function processEnv() {
  try {
    return typeof process !== 'undefined' && process?.env !== undefined && process.env !== null
      ? process.env
      : null
  } catch {
    return null
  }
}

/** 补丁层那一行加载的就是它。 */
export default createRootRow()

/**
 * ⚠️ 本行与本目录另外两行的**唯一区别**在这里，值得写死：
 *
 *   · 本行在 `legion-host.patch.yml` 里（`module: '../../team-hub/approval-registrar-row.mjs'`
 *     ——注册方模块，它默认导出本文件的 `default`），
 *     因为它的输入是进程环境 + 注入的端口工厂，YAML 带得动；
 *   · 另外两行不在（`module: null`），因为它们要的是**装配好的那一份根**，
 *     而那必须先在同一个进程里被装配出来。
 *
 * 于是"这一层到底装上了没有"的读法变成三段，**不能混成一段**：
 *   ① 根行没进文档   → 组合根永远不会被装配（本行的 `module` 字段决定）；
 *   ② 根行在、但抛了 → 配置不可解析（一个具名码，启动路径上可见）；
 *   ③ 根行装好了     → 另外两行由服务依赖决定何时激活（pending ≠ 装上）。
 *
 * `enforcementInstallation()` 只回答 ② 与 ③ 之间的那一格；① 由
 * `renderPatchReport()` 的 `renderedRowIds` 回答。两者都要看。
 */
export const ROOT_ROW_DOES_NOT_PUBLISH_A_LISTENER = Object.freeze({
  code: 'ENFORCEMENT_ROOT_ROW_IS_A_COMPOSITION_ROW',
  detail: '本行只装配组合根并发布服务，不注册任何 listener；'
    + '策略门与审批应答者分别在 ./pre-execute-row.mjs 与 ./approval-answerer-row.mjs，'
    + '它们 inject 本行发布的服务',
})

/** `enforcementInstallation` 在这里重导出，方便调用方只 import 本行就能读装配结果。 */
export { enforcementInstallation }
