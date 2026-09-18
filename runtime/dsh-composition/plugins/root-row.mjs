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
// ## ★★（PRT-214 收口）`mount()` 的**第一个生产调用方**就在本行的 `apply` 里
//
// 上面那段"靠服务依赖等对面激活"是**设计意图**，而它此前从未在生产里成立过：
//
//   · `installEnforcementRoot()` 造出的 `mount(ctx)`（`root.mjs:482`）在**全仓库
//     没有任何调用方**——对 `.mount(` 的其余出现全是注释，`root.mjs` 那一行只是转发；
//   · 两行运行期模块（`pre-execute-row` / `approval-answerer-row`）又**不在**
//     `legion-host.patch.yml` 里（`module: null`，只出现在注释块里）。
//
// 于是 `assembleEnforcement()` 每次都跑、每次都造出一个**能挂**的装配，
// 而两行 enforcement **从来没有进过任何真 DSH 进程**：
//
//   > 一个"装配好了、也验证过能被挂载"的强制面，
//   > 与一个"从来没有被挂载过"的强制面，在运行的部署上是同一个东西——
//   > 只不过前者的用例是绿的。
//
// 所以本行在**发布服务之后自己调** `mount(ctx)`。它是那条路径上唯一的生产调用方，
// 于是"两行到底挂上了没有"从此有一条不读注释的读数：
// 真 `tools/pre-execute` 瀑布被认领（`GATE-DENIED`，见
// `root-row-dsh-process.test.mjs` 的场景 I）。
//
// 三段读数因此变成四段，仍然**不能混成一段**（文件末尾
// `ROOT_ROW_DOES_NOT_PUBLISH_A_LISTENER` 的说明照旧成立）：
//
//   ① 根行没进文档     → 组合根永远不会被装配（`renderedRowIds` 回答）；
//   ② 根行在、但配置抛  → 启动路径上的失败，具名码（`enforcementInstallation()` 回答）；
//   ③ 根行装好了、但**挂载失败** → 服务被收回、已挂的行被拆掉，依赖它的行退回
//      pending（记的是 `ENFORCEMENT_ROOT_ASSEMBLY_FAILED` + 一段说清是**挂载**的文本）；
//   ④ 根行装好了、也挂上了 → 两行 enforcement 真的在听（这一条**现在才可达**）。
//
// ⚠️ 诚实边界，**不许把 ④ 读成"强制面已生效"**：`legion-host.patch.yml` 里仍然
// **没有**这两行（它们的 `module` 是 `null`，理由见 `patch-layer.mjs`），因此
// `reconcilePatchLayer()` 依旧把它们报成 `ROW_MISSING`、启动自检依旧判这一层未生效
// 并拒绝注册（fail closed）。"两行挂上了"是 ④；"这一层被启动自检判为生效"是**另一件事**，
// 本批次没有动那一件。两者在报告里必须分开写。
//
// ## ★★ 为什么 `apply` **保持同步**（本批实测出来的，不是风格）
//
// 直觉上"`apply` 改成 async 并 `await mount(ctx)`"更强：挂载失败会直接让本行 fiber
// 失败。**但它会改掉激活时序，而那个时序是有读者的**——本批实测（一次真 DSH 进程，
// 补丁层与既有用例同形：两行运行期模块作为条目存在，另加一个"只 inject 组合根服务、
// 在自己的 `apply` 里读一次组合树"的观察者，也就是 `runtime-host-row.mjs` 的
// `observeComposition` 所做的那件事）：
//
//   · 本行 `apply` **同步**：那两行 patch 条目 `activated=true`（与既有基线一致）；
//   · 本行 `apply` **async 且 `await mount`**：**同一次观察**读到它们 `activated=false`，
//     下一个 tick 之后才变 true。
//
// 原因是 Cordis 的激活是**微任务级联**：组合根服务"可读"（`strict` 要求提供方 fiber
// 已 ACTIVE）与"依赖方被通知"发生在同一瞬间，而 patch 条目与本行的观察者是**同一批**
// 被通知的——谁先跑 `apply`，取决于组合根**何时**激活。同步 `apply` 让组合根在观察者的
// loader 条目被建出来**之前**就激活（观察者于是是后来者，读到的是已收敛的树）；
// 异步 `apply` 把它推迟到条目建好之后，两者于是挤在同一批里，观察者读到**还没收敛**的树。
//
//   > 一个"更强"的失败语义，
//   > 与一个"把安全自检的读数从已收敛改成未收敛"的改动，是同一个东西——
//   > 只不过前者写在注释里，后者写在读数里。
//
// 而那个自检的判据正是"组合树里这几行激活了没有"：读数一变，`bootstrapDshRuntime()`
// 就判"强制面未生效"并**拒绝注册**（fail closed）——`await` 换来的那点强度，
// 代价是把一条**本来成立的**启动路径变成不成立。所以本行不 `await`：
// 挂载**同步发起**，失败走下面那条"具名 + 收回服务"的路。
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
import { SCOPE_PORT_ENV_KEY, scopePortFromEnv } from '../scope-port.mjs'
import { CONNECTOR_PORT_ENV_KEY, connectorPortFromEnv } from '../connector-port.mjs'
import {
  ENFORCEMENT_ROOT_CODES,
  enforcementInstallation,
  installEnforcementRoot,
} from '../root.mjs'

/**
 * 改动绑定方式时递增。
 *
 * v2（PRT-214 收口）：本行的 `apply` 除了"装配 + 发布服务"之外，**自己把装配好的
 * 两行挂上当前 Context**（`mount()` 的第一个生产调用方），并登记拆装。这是绑定方式
 * 的实质变化，所以递增——不是文案改动。
 */
export const ROOT_ROW_VERSION = 2

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

// ⚠️ 这里**刻意没有**给"服务已发布、但挂载失败"新造一个 `ROOT_ROW_CODES.*`。
//
// 想造，而且本来已经造了（`ENFORCEMENT_ROOT_ROW_ROWS_NOT_MOUNTED`）。它被拿掉是因为
// 它过不了本仓自己的配置面门禁：`scripts/config/scan.mjs` 会把 `runtime/` 里**每一个**
// 新字面量扫出来，而"登记"只发生在 `runtime/config-schema.mjs` 的 `NON_ENV_LITERALS`
// 里（PRT-254 那条"漏登 ⇒ 红"）。本批次不碰那个文件，所以新造的字面量没有合法的登记处。
//
//   > 一个"把新码悄悄塞进日志"的改动，
//   > 与一个"码没登记、于是门禁当场红"的改动，是同一个东西——
//   > 只不过前者要靠下一个人发现。
//
// 于是失败路径复用**已登记**的 `ENFORCEMENT_ROOT_CODES.ASSEMBLY_FAILED`
// （`root.mjs:118`，语义是"装配这一侧失败了"），而"这一条说的是挂载而不是配置"
// 由**消息文本**与调用点承担。要真正分开这两个码，需要一次一行的 schema 登记——
// 那是独立的改动，报告里已标出。

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

// ── 组合根的**挂载账**（`mount()` 的生产调用方） ──────────────────────────────
//
// ★ 为什么键是**组合根本身**，既不是一个模块级布尔量、也不是 `ctx`：
//
//   ① `assembleEnforcement()` 的 `mounted` 数组与 `dispose()` 是**装配级**的：
//      同一份根挂两次 → `mounted` 里躺着 4 个 fiber，而任何一次 `dispose()` 都会把
//      它们**全部**拆掉——另一个挂载者于是留下一句"我装了"、实际上一根 listener 都没有。
//      所以"这份根挂过没有"的粒度只能是这份根自己。
//      `installEnforcementRoot()` 本来就是**进程级单例**（第二次装配被
//      `ALREADY_INSTALLED` 挡掉），两边的粒度因此是对齐的。
//      用 `ctx` 作键会漏掉"同一份根挂到两个 Context 上"这条同样会双挂的路。
//   ② 真 DSH 的 Loader 用 `Promise.allSettled(config.map((o) => this.create(o)))`
//      **并发**创建补丁行（`@deepseek-ai/cordis-plugin-loader`），所以两次 `apply`
//      可以真的交错。因此"先查再写"必须是**同步的**——本行的 `apply` 就是同步的
//      （这也是它不 `await mount` 的第二个理由：`await` 会把这段变成有窗口的）。
//
// ★ 为什么存的是**那个挂载 Promise**，而不是一个 `true`：
//   后到的 `apply` 等的是**同一次**挂载的结果。存 `true` 会让"第一次挂到一半失败"
//   被第二次读成"已经挂好了"——那正是本行最想避免的那种"看起来装好了"。
//
// WeakMap 而不是 Map：键是活对象；`resetEnforcementRoot()`（用例专用）换掉根之后
// 旧条目自己可回收，不需要在别处再写第二份清理。
const mountedRows = new WeakMap()

/**
 * 造出补丁层那一行要加载的插件。
 *
 * 默认（`default` 导出）用**进程环境**与已注册的工厂；用例可以逐项注入。
 *
 * ⚠️ `apply` **是同步的**（见文件头"为什么 apply 保持同步"：async + `await mount`
 * 会把组合自检的读数从"已收敛"改成"未收敛"，于是本来成立的启动路径变红）。
 * 它保证的顺序是确定的，而且是同步可观察的：
 *
 *   · `installEnforcementRoot()` → `ctx.provide(服务)` → **挂上两行**（同步发起）
 *     → 登记拆装 —— 发布**先于**挂载，且发布**不依赖**挂载成功；
 *   · `apply` 返回时，两行的 `ctx.plugin(...)` **已经被调用过**（挂载已开始），
 *     但**不保证**它们的 fiber 已经 ACTIVE——那是它们的 `ctx.plugin` 自己的时序，
 *     本行不去等（等了就是上面那条读数倒退）。
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
      // ★ `ctx.effect` 也在这里要求，而不是"挂上去了再说"：挂载**必须**配上拆装登记。
      //   一个"挂上了、却没人负责拆"的强制面，会让本行比它挂上去的 Context 活得久——
      //   那与本文件「不装半根」的口径是同一条（半根不只是少一行，也包括"收不回来"）。
      if (ctx === null || typeof ctx !== 'object' || typeof ctx.provide !== 'function'
        || typeof ctx.effect !== 'function') {
        throw rowError(ROOT_ROW_CODES.NO_CONTEXT,
          `${ROOT_ROW_PLUGIN_NAME} 需要一个 Cordis Context（要能 ctx.provide 发布组合根服务、` +
          'ctx.effect 把挂上去的两行登记成本行的 effect，否则没人负责拆）')
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

      // ★ 第 19 条 §9.2 第 4 步：执行面的**路径范围表**。
      //
      //   在此之前 `installEnforcementRoot` 的入参里**没有** `pathScope`，
      //   于是桥的端口恒为 `null`，而 `tool-request.mjs:731`
      //   （`if (pathScope === null) return undefined`）**放行一切路径**。
      //   ⇒ 那次缺席落到的是"放行"，不是"拒绝"。
      //
      //   现在：配了就接上；**没配仍然是没配**（`port` 为 `null`）。
      //   不补默认值——一个"凭空造出来的空表"会让这次放行看起来像"有范围表"。
      let scope
      try {
        scope = scopePortFromEnv({ env: effectiveEnv })
      } catch (err) {
        // 配了却解释不通 ⇒ **拦装配**，与"根本没配"分开。
        //   > 一个"读不出来就当作没配"的组合根，
        //   > 与一个"这个部署确实没有范围限制"的部署，在强制面读数上长得一样。
        throw rowError(ROOT_ROW_CODES.CONFIG_UNRESOLVED,
          `${ROOT_ROW_PLUGIN_NAME} 读不出路径范围表「${SCOPE_PORT_ENV_KEY}」：` +
          `${err?.message ?? err}。**不**按"没配"处理——` +
          '那会让一次配置错误与一次真实的"无范围限制"在强制面读数上同形')
      }

      // ★ 第 19 条 §9.2 第 5 步：执行面的**连接器声明**（F-21 判定面的最后一条缝）。
      //
      //   在此之前 `installEnforcementRoot` 的两个连接器参数
      //   （`connectorDeclarations` + `resolveConnectorId`）**从来没有任何
      //   生产调用方**——`assemble.mjs` 收它们、也成对校验，而生产入参里
      //   一个都没有 ⇒ `enforcementSurfaces().connectorJudgment` 恒为 `false`。
      //   那正是台账 F-21 那一行点名的形状：能力齐全、用例全绿、生产调用方 0。
      //
      //   现在：配了就接上；**没配仍然是没配**（`declarations` 为 `null`，
      //   两个参数一起不给）。不补默认值——一个"凭空造出来的空表"会让
      //   组合根建出一份**零连接器**的登记表，于是那一格报 `true`
      //   而它一次判定都不会做（`connector-port.mjs` 文件头 ①/② 记的就是这条）。
      let connectors
      try {
        connectors = connectorPortFromEnv({ env: effectiveEnv })
      } catch (err) {
        // 配了却解释不通 ⇒ **拦装配**，与"根本没配"分开。
        //   > 一个"读不出来就当作没配"的组合根，
        //   > 与一个"这个部署确实没有连接器策略"的部署，在强制面读数上长得一样。
        throw rowError(ROOT_ROW_CODES.CONFIG_UNRESOLVED,
          `${ROOT_ROW_PLUGIN_NAME} 读不出连接器声明「${CONNECTOR_PORT_ENV_KEY}」：` +
          `${err?.message ?? err}。**不**按"没配"处理——` +
          '那会让一次配置错误与一次真实的"此部署没有连接器"在强制面读数上同形')
      }

      const installed = installEnforcementRoot({
        env: effectiveEnv,
        decide: effectiveDecide,
        // ★ 缺席时这里是 `null`，而"传了 null"与"没传"在组合根那一侧的读数相同
        //   （`assemble.mjs` 的默认值就是 `null`）——所以这一行**不改变**没配时的行为，
        //   它只让"配了"这件事有了一条能走通的路。
        pathScope: scope.port,
        // ★ 与上面 `pathScope` **同一个形状**：键恒在，缺席时值是 `null`。
        //
        //   ⚠️ 我第一版写的是条件展开（`...(configured ? {a,b} : {})`）。
        //   那是**错**的，而且错得有价值：`production-scope-wiring.test.mjs` ①
        //   用**文本解析**读这组键（它要能回答"生产装配到底传了哪几个键"），
        //   条件展开会让解析器在中途停下 ⇒ 判据红在"解析锚点坏了"。
        //   ⇒ 而它红得对：这一行的既有形状（`pathScope: scope.port`）本来就是
        //     "键恒在、缺席为 null"，`assemble.mjs` 也正是这么读的
        //     （`:219` 两个都为 `null` 时才不建登记表）。条件展开不但多余，
        //     还让这组键**不再是一份可被读出来的清单**。
        //
        //   > 一个"用条件展开来表达缺席"的装配点，
        //   > 与一个"键恒在、缺席为 null"的装配点，在**行为上**完全相同——
        //   > 只不过前者的键集**不可文本化**，于是任何"数一数传了哪几个键"的
        //   > 判据都会静静地少看见几个。
        connectorDeclarations: connectors.declarations,
        resolveConnectorId: connectors.resolveConnectorId,
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

      // ★ 发布服务：另外两行 `inject` 它。
      //
      //   幂等：同一进程里第二次挂本行时服务已在，不再 provide（`ctx.provide` 对
      //   重复注册是抛错，而不是覆盖）。
      //
      //   留住 `provide` 的拆装句柄（`ctx.provide` 返回一个 effect 拆装器）：
      //   下面"挂载失败"那一条要**把服务收回去**，而那必须用**同一个**它——
      //   再写一份"删掉服务"的代码就会与 Cordis 的 effect 账分家。
      const already = typeof ctx.get === 'function' ? ctx.get(ENFORCEMENT_ROOT_SERVICE, false) : undefined
      const unprovide = already === undefined
        ? ctx.provide(ENFORCEMENT_ROOT_SERVICE, published)
        : null

      ctx.logger?.info?.(
        `[${ROOT_ROW_PLUGIN_NAME}] v${ROOT_ROW_VERSION} 已装配组合根并发布服务 ` +
        `${ENFORCEMENT_ROOT_SERVICE}（另外两行靠它决定何时激活；顺序不靠补丁层的行序）`,
      )

      // ── ★★ 把装配好的两行**真的挂上去**：`mount()` 的生产调用方 ────────────
      //
      // 来龙去脉见文件头两节。这里只留四条决定：
      const assemblyRoot = published.root

      // ① 幂等：查的是"**这份组合根**挂过没有"。`get` 与下面的 `set` 之间
      //    **没有 `await`**（本函数是同步的），所以并发创建的第二次 `apply`
      //    不可能同时通过——真 Loader 用 `Promise.allSettled(config.map(create))`
      //    并发创建补丁行，这条竞态是真的存在。
      let mounting = mountedRows.get(assemblyRoot)
      const started = mounting === undefined
      if (started) {
        // ② 生命周期：**先登记拆装，再开始挂**。用的是装配自己那一个
        //    `dispose()`（反序卸载，见 `assemble.mjs`）——不另写第二份 teardown，
        //    两份 teardown 会漂移，而漂移的那一份只在真的卸载那天才暴露。
        //    账与挂载同生共死：拆掉之后同一进程里再挂必须能真的重挂。
        ctx.effect(() => () => {
          mountedRows.delete(assemblyRoot)
          return assemblyRoot.dispose()
        }, `${ROOT_ROW_PLUGIN_NAME}.mount`)

        // ③ **挂载同步发起**（`mount()` 是 async，但它一直到第一个 `await` 之前
        //    都是同步跑的：两个 `ctx.plugin(...)` 里第一个已经被调用）。
        //    这里**不 `await`**——理由在文件头"为什么 apply 保持同步"。
        mounting = assemblyRoot.mount(ctx)
        // 先占坑再挂：从上面的 `get` 到这里没有 `await`。
        mountedRows.set(assemblyRoot, mounting)

        // ④ 失败方向：**整根不装 + 服务收回**，不留下半根。
        //
        //    `mount()` 抛得出来的一共有两类，而它们**分别**处理、不能合成一条：
        //
        //      · 同步那一类（`ctx.plugin` 在第一个 `await` 之前抛，例如插件对象不合法）
        //        **不在这里**：它是 `mount()` 那个 async 函数内部的抛，会变成返回的
        //        promise 被拒——也就是说它也会落到下面这个 `.catch` 里。
        //        所以本行**不会**再往 `apply` 外面抛：`apply` 的失败面只剩"配置期"，
        //        而那一条保持"抛 ⇒ 启动失败"（见文件头第三节）。
        //      · 异步那一类（某一行自己的 `apply` 抛）本来就没有同步抛点。
        //
        //    处理动作是三件，按顺序：
        //      1. **收回服务**（`unprovide()`）。依赖它的行会由 Cordis 重新求值
        //         （`provide` 的拆装器自己 `notify`）→ 退回 pending。于是
        //         "根行在、服务也在"这个读数**不会**留下来；
        //      2. 拆掉已经挂上的部分（同一份 `dispose()`，反序、幂等）；
        //      3. 释放占坑 + 大声记一笔（具名码），好让排查不必翻两层。
        //
        //    落到实处是什么：真 DSH 里依赖那两行会一直 pending，DSH 自己的
        //    `assertEntriesActivated` 报 `did not activate` ⇒ **启动失败**
        //    （那条读数在 `root-row-dsh-process.test.mjs` 场景 E 量过）。
        //    也就是说失败的方向是**关闸**（fail closed），不是"少挂一行照样跑"。
        //
        //    为什么不"留着 pre-execute 单独守着"：`assemble.mjs` 记过，
        //    pre-execute 单独在场时 ask 会落到 DSH 的兜底 `unavailable` ⇒ 工具不执行
        //    （fail closed），那一侧**确实**更安全；但它是**半根**，而半根的死法是
        //    "下一个人以为 answerer 还在"，与本行「不装半根」的口径直接冲突。
        mounting.catch((err) => {
          mountedRows.delete(assemblyRoot)
          let retracted = false
          try {
            if (typeof unprovide === 'function') { unprovide(); retracted = true }
          } catch (e) {
            ctx.logger?.error?.(`[${ROOT_ROW_PLUGIN_NAME}] 收回服务时又抛了：${e?.message ?? e}`)
          }
          Promise.resolve(assemblyRoot.dispose()).catch(() => {})
          // 码用已登记的 `ASSEMBLY_FAILED`（理由见 `ROOT_ROW_CODES` 后面那段）；
          // "是挂载而不是配置"由这段文本承担。
          ctx.logger?.error?.(
            `[${ROOT_ROW_PLUGIN_NAME}] ${ENFORCEMENT_ROOT_CODES.ASSEMBLY_FAILED}：` +
            `服务已发布，但挂载装配好的两行 enforcement 失败：` +
            `${err?.code === undefined ? '' : `[${err.code}] `}${err?.message ?? String(err)}。` +
            `**不装半根**：服务${retracted ? '已收回' : '收回失败（见上一条）'}、已挂的行已拆，` +
            '依赖它的行会退回未激活（DSH 的挂载审计会报 did not activate ⇒ 启动失败）',
          )
        })
      }

      // 这条日志必须说清**本次 apply 干了什么**：幂等路径下它**没有**发起挂载，
      // 只是接上了已经发起的那一次。写成"已发起挂载"会让"两次 apply"看起来
      // 挂了两次——而排查的人正是靠这条日志判断有没有双挂。
      ctx.logger?.info?.(
        started
          ? `[${ROOT_ROW_PLUGIN_NAME}] v${ROOT_ROW_VERSION} 已发起挂载组合根装配好的两行`
            + `（${Object.keys(assemblyRoot.rows).join(' / ')}；两行共享同一份桥与同一本在飞登记簿）`
          : `[${ROOT_ROW_PLUGIN_NAME}] v${ROOT_ROW_VERSION} 本次 apply **没有**再挂一次：`
            + '这份组合根已经发起过挂载（幂等路径），本次只是发布/复用了服务',
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
 * 于是"这一层到底装上了没有"的读法变成**四段**，**不能混成一段**：
 *   ① 根行没进文档     → 组合根永远不会被装配（本行的 `module` 字段决定）；
 *   ② 根行在、但配置抛 → 配置不可解析（一个具名码，启动路径上可见）；
 *   ③ 根行装好了、但**挂载失败** → 服务被收回、已挂的行被拆掉，依赖它的行退回 pending
 *      （日志里是 `ENFORCEMENT_ROOT_ASSEMBLY_FAILED` + 一段说清"是挂载"的文本；
 *      为什么没给这一格单独一个 `ROOT_ROW_CODES.*` 见那个常量后面的说明）；
 *   ④ 根行装好了、也挂上了 → 两行 enforcement 真的在听（`mount()` 由本行调用）。
 *
 * `enforcementInstallation()` 只回答 ②（装配有没有成功）；① 由
 * `renderPatchReport()` 的 `renderedRowIds` 回答；③ 由具名日志回答；④ 由真
 * `tools/pre-execute` 瀑布被认领回答（`root-row-dsh-process.test.mjs` 场景 I）。几者都要看。
 *
 * ⚠️ ④ 成立**不等于**"这一层被启动自检判为生效"：那两行仍然不是补丁层的条目，
 * `reconcilePatchLayer()` 照旧报 `ROW_MISSING`（见文件头"诚实边界"）。
 */
export const ROOT_ROW_DOES_NOT_PUBLISH_A_LISTENER = Object.freeze({
  code: 'ENFORCEMENT_ROOT_ROW_IS_A_COMPOSITION_ROW',
  detail: '本行自己不注册任何 listener：它装配组合根、发布服务，并把装配好的两行'
    + '（./pre-execute-row.mjs 与 ./approval-answerer-row.mjs 会挂的那两个 listener）'
    + '直接挂到当前 Context 上；两行的 listener 本体在 ./pre-execute.mjs 与'
    + ' ./approval-answerer.mjs（由 assemble.mjs 装配，两行共享一份桥与一本登记簿）',
})

/** `enforcementInstallation` 在这里重导出，方便调用方只 import 本行就能读装配结果。 */
export { enforcementInstallation }
