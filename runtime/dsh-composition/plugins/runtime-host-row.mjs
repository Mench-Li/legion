// runtime/dsh-composition/plugins/runtime-host-row.mjs
// ============================================================================
// PRT-253（续）：`bindDshRuntime()` 的**生产调用方**——在 DSH 进程里把宿主端口
// 与自检交给 orchestrator worker 的那一行。
//
// ## 它补的是哪一截
//
// `orchestrator/worker/executor-binding.mjs` 的 `bindDshRuntime()` 早就写好了、
// 也早就被用例钉住了，而 `runtime/dsh-composition/bootstrap.mjs` 的
// `bootstrapDshRuntime()` 是它的**两步装配**（先自检、通过才注册）。两样东西
// 的共同处境是同一句话（PRT-253 文档 §6 第一条）：
//
//   > `bindDshRuntime` 的定义在这里，**调用者还不存在**。
//
// 于是 worker 侧的 `productionExecutorProvider()` 永远是
// `EXECUTOR_HOST_PORT_REQUIRED`——「强制面未生效时禁止自动执行」这条保证
// 与 PRT-510 的预算闸门**从未被行使过**。
//
//   > 一个"写好了、也验证过被调用"的注册口，
//   > 与一个"没有任何生产代码调用它"的注册口，在运行的部署上是同一个东西——
//   > 只不过前者的用例是绿的。
//
// 本文件是那一行：它在 `apply` 期从**进程里真实存在的来源**取四样输入，
// 调 `root.bootstrap()`（→ `bootstrapDshRuntime()` → `bindDshRuntime()`），
// 并把结论作为服务发布出去。四样输入各有来源，**一样都没有默认值**。
//
// ## ★ 四样输入各自的来源（这是本批要回答的问题）
//
// | 输入 | 来源 | 没有来源时 |
// | --- | --- | --- |
// | `composition` | **真 DSH 组合树**：`ctx.loader.entries()` 的 `options.id` + `fiber.state` | `..._NO_COMPOSITION` |
// | `sandbox` | **真 DSH 服务**：`ctx.sandbox`（`probeSandbox` 要的 `confine`） | `..._NO_SANDBOX_PORT` |
// | `runtimeHost` | **注册缝**（见下）：本目录造不出一个真的 | `..._NO_HOST_PORT` |
// | `canRead` | **可选**：缺席是合法的，被**如实**记成 `null` 交下去 | 只有"给了一个不是函数的"才拒（`..._NO_CAN_READ`） |
//
// `composition` 与 `sandbox` 有真来源，本行**自己读**，不要求调用方重复给一遍
// （重复给一遍只会得到两个会漂移的副本）。读数上的依据是实测的，不是推的：
//
//   · 补丁行的声明 `id` **确实**出现在 `entry.options.id` 上，加载完的行的
//     `entry.fiber.state === 2`（ACTIVE）——所以 `reconcilePatchLayer()` 要的
//     `{rows:[{id, activated}]}` 能由本行自己从树里读出来；
//   · `permissionPresets` 从 `permission` 那一行的 `options.config.presets` 的键读。
//     这一条是刻意的：判据是「Legion 的 preset 名解析得到」，不是「permission 行存在」。
//
// ## ★ 为什么 `runtimeHost` / `canRead` 走**注册缝**，而不是本行自己造
//
// 因为本目录**造不出一个真的**，而编一个假的正是这个仓库反复写下的那条禁令。
// 具体到这两样：
//
//   · `runtimeHost` 要 `{startRun, probeRuntime}`。`startRun` 的真来源是 DSH 的
//     `subagents` 服务上的 `start(provider, options)`（Legion 自己的 DSH 插件就是这么
//     调的：`plugins/src/index.ts`）。**而 `probeRuntime` 要报 version 与四项必需能力**
//     （`runtime/contracts/adapter.mjs` 的 `REQUIRED_CAPABILITIES`），
//     全仓库**没有任何生产实现**：实测过一个真 DSH 进程里能看见的服务，
//     没有版本服务、也没有能力服务（探针读数见文档 §3）。
//     给一个"全 true"的能力表就是**编**——它会让 `checkCompatibility` 在一个
//     从未验过的引擎上判"兼容"。
//
//     （这里刻意**不写**那个服务访问的完整记号：`patch-layer.mjs` 的文件头写着
//      "本目录不 import 任何 DSH 包、棘轮里 adapterPrefixes 的豁免**存在但不用**"。
//      第一版这段话里写了完整记号，于是本目录的 DSH 记号数从 0 变成 1——
//      一次"豁免可用所以顺手用了"的漂移，在门禁上**恰好是绿的**。）
//   · `canRead` 是**装配阶段**的权限判定，而它的合法性**只在消费它的那个进程里**
//     才成立：本行跑在 DSH Runtime 进程，那里没有任何东西读它（PRT-253 授权批的
//     四条测量写在 `runtime-host-registrar-row.mjs` 的文件头）。所以本批起它的取值
//     是**可选**：**缺席如实记成 `null`**（不是放行、不是拒绝、不是替身），
//     而真正要执行的那一侧（worker 的 `productionExecutorProvider`）读到缺席
//     仍然 `EXECUTOR_CAN_READ_REQUIRED`。**挂一个不是函数的** → 本行当场拒
//     （`..._NO_CAN_READ`）：静默丢掉它会让"有人试图挂它"这件事消失。
//
// 所以两样都只能由**知道答案的那一侧**注册进来。这与 `root-row.mjs` 的
// `setApprovalPortFactory()` 是同一条取舍，理由也相同（方向见下）。
//
// ## ★ 方向：注册方在 `team-hub/` / `product/` 一侧，本目录不 import 它们
//
// `runtime/` **不得** import `team-hub/`（`scripts/ci/dsh-boundary.mjs` 的实际
// import 图，本批验证过）。所以端口工厂走**注入**，注册方留在依赖方向允许的那一侧——
// 与审批端口工厂（`team-hub/approval-registrar-row.mjs`）同一个形状。
//
//   ⚠️ 上一版这里写着「**今天没有生产注册方**」。那句话在注册方落地的那一批之后
//   就不再成立，本批顺手改掉：生产注册方在
//   `runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs`（模块求值期
//   注册、默认导出**就是这个**插件对象）。它现在给得出 `runtimeHost`（`startRun`
//   按引用转发到 `subagents`、`probeRuntime` 读现场安装、`currentModelSelection`
//   读 `agentDefaultModel`）与"如实为 null 的 `canRead`"。
//   仍然缺的是**能力表**：`probeRuntime` 里三项必需能力在这个进程里没有可确认的
//   来源，于是启动自检判不兼容——那是本批之后的**下一个**阻塞点，不是接线缝。
//   没有工厂时本行照旧以 `..._NO_INPUTS_FACTORY` 当场拒绝。
//
// ## ★ 为什么本行**故意不进**静态补丁层（`PATCH_LAYER_ROWS`）
//
// 一行"挂上去、然后在 `apply` 期以具名码拒绝"的行，进静态补丁层的后果是
// **每一个 DSH Runtime 进程都起不来**（PRT-214 文档 §9 的读数 C 就是这个形状：
// root 行在真补丁层里拒绝了，于是启动失败）。那在 root 行上是**对的**——
// 被要求装上的强制面不能只写一行日志。
//
// 但本行不是强制面：没有引擎绑定时，员工 harness 仍然可用，而 worker 侧照旧
// 报 `EXECUTOR_HOST_PORT_REQUIRED` 且**不认领任何任务**——那是**可见**的降级，
// 不是静默失效。让整个 harness 因为"编排器绑不上引擎"而起不来，是拿一个大得多的
// 故障去换一个小得多的故障。
//
// 所以本行的挂载被留成一个**显式步骤**：等真的端口工厂落地，它连同
// `PATCH_LAYER_ROWS` 的登记与 `dshCompositionPatchVersion` 的递增一起做。
//   本批**不做**那两件事的理由还有一条，是本批量出来的：递增补丁层版本会连带
//   要求 `runtime/packs/builtin/software-delivery.mjs` 那几处 host 版本跟着走，
//   而那是打包权威面（`runtime/packs/authority.mjs`）的地盘——不属于本批。
// ============================================================================

import { ENFORCEMENT_ROOT_SERVICE } from './root-row.mjs'
import { BOOTSTRAP_CODES } from '../bootstrap.mjs'
import { SELFCHECK_STATES } from '../selfcheck.mjs'
import { PATCH_LAYER_ROWS } from '../patch-layer.mjs'

/** 改动输入来源、拒绝码或发布形状时递增。 */
export const RUNTIME_HOST_ROW_VERSION = 1

/** 插件名（挂载审计按它对号）。 */
export const RUNTIME_HOST_ROW_PLUGIN_NAME = 'legion-runtime-host'

/**
 * 本行发布的**服务名**：绑定结论。
 *
 * 发布它是为了让"到底绑上了没有"在进程内可读——一个只写日志的结论会随文案变更
 * 而碎，而这是运维与用例都需要读的事实。服务名是**产品自己的**，DSH 不认识它。
 */
export const RUNTIME_HOST_BINDING_SERVICE = 'legionRuntimeHostBinding'

/**
 * Cordis Fiber 的 ACTIVE 状态值。
 *
 * 不写死在这个命名里的数字来源是实测：一个补丁行 `apply` 跑完之后
 * `entry.fiber.state === 2`（`root-row-dsh-process.test.mjs` 的 `MOUNT` 读数
 * 与 `runtime/dsh-composition/plugins/runtime-host-row-dsh-process.test.mjs` 的
 * 探针读数都用同一个值）。除 ACTIVE 之外的一切（pending / loading / failed）
 * 一律按**未激活**处理——`reconcilePatchLayer()` 的 `ROW_NOT_ACTIVATED` 判据
 * 要的正是这个区分。
 */
export const ACTIVE_FIBER_STATE = 2

/** 本行的拒绝码。每一个都对应**一样具体的输入**，不是一个笼统的"接线不对"。 */
export const RUNTIME_HOST_ROW_CODES = Object.freeze({
  /** 挂到了一个不是 Cordis Context 的东西上。 */
  NO_CONTEXT: 'RUNTIME_HOST_ROW_NO_CONTEXT',
  /** 组合根服务不在（本行 `inject` 它；到了 `apply` 还没有就是接线错了）。 */
  NO_ENFORCEMENT_ROOT: 'RUNTIME_HOST_ROW_NO_ENFORCEMENT_ROOT',
  /** 服务在，但它是一份**拒绝**（`ok !== true`）。与"从来没装过"必须分开。 */
  ENFORCEMENT_ROOT_REFUSED: 'RUNTIME_HOST_ROW_ENFORCEMENT_ROOT_REFUSED',
  /**
   * 服务在、也不是拒绝，但**形状不对**（没有 `root.bootstrap`）。
   *
   * 这个码是补出来的：第一版直接把服务值当组合根用（`service.bootstrap`），
   * 而 `root-row.mjs` 发布的其实是 `installEnforcementRoot()` 的**安装结果**
   * ——`{ok, code, message, root}`，`bootstrap` 在 `root.bootstrap` 上。
   * 在**假服务**（`{bootstrap(){}}`）上这条接线是全绿的，一到真 DSH 进程里
   * 就变成 `NO_ENFORCEMENT_ROOT`，把"形状读错了"报成了"服务不在"。
   *
   *   > 一个形状读错的接线，与一个根本没接的接线，
   *   > 在替身上分不开——而它们的修法不同。
   */
  ROOT_SHAPE_INVALID: 'RUNTIME_HOST_ROW_ROOT_SHAPE_INVALID',
  /** 端口工厂没注册。**唯一**还缺的那一件，见文件头。 */
  NO_INPUTS_FACTORY: 'RUNTIME_HOST_ROW_NO_INPUTS_FACTORY',
  /** 工厂自己抛了。带上它抛了什么，不吞。 */
  INPUTS_FACTORY_THREW: 'RUNTIME_HOST_ROW_INPUTS_FACTORY_THREW',
  /** 工厂没给出宿主端口（`{startRun, probeRuntime}`）。 */
  NO_HOST_PORT: 'RUNTIME_HOST_ROW_NO_HOST_PORT',
  /**
   * 工厂**试图挂一个不是函数的** `canRead`。
   *
   * ⚠️ 含义本批收窄了：它**不再**表示"工厂没给 `canRead`"——缺席现在是合法的
   * （如实记成 `null` 交下去，由 worker 侧那一侧具名拒绝）。它只表示"给了一个
   * 不是函数、也不是 null/undefined 的值"。静默把那种值丢掉，会让"有人试图挂它"
   * 从读数上消失，而那正是最该被看见的一种接线错误。
   */
  NO_CAN_READ: 'RUNTIME_HOST_ROW_NO_CAN_READ',
  /** 组合树读不出来或读到零行。**"没读到"不等于"没生效"**，两者不许同形。 */
  NO_COMPOSITION: 'RUNTIME_HOST_ROW_NO_COMPOSITION',
  /** 沙箱服务不在（`ctx.sandbox`）。 */
  NO_SANDBOX_PORT: 'RUNTIME_HOST_ROW_NO_SANDBOX_PORT',
  /** `bootstrapDshRuntime()` 拒绝了。内层码原样带在 `innerCode` 上。 */
  BIND_REFUSED: 'RUNTIME_HOST_ROW_BIND_REFUSED',
  /**
   * 自检判定**强制面未生效**（补丁层没应用 / 沙箱不够 / 可用性探不通）。
   *
   * ★ 与 `BIND_REFUSED` **必须分开**，因为 spec 对这两件事的要求不同：
   *   · `line 854`：「补丁层应用与强制面生效的启动自检；**未生效时 Runtime Manager
   *     按 `incompatible` 处理并禁止自动执行**」；
   *   · §6.3（`line 275`）：`incompatible` 的产品状态是「组件版本不兼容」，
   *     Orchestrator 行为是「禁止自动执行，**提示修复或回滚**」。
   *
   * 这两个码在**旧实现里是同一个东西**：`bootstrap` 拒绝 → `apply` 抛 →
   * 整棵插件树加载失败 → Runtime 进程死。于是 spec 要的两条读数都拿不到：
   *   · 拿不到 `incompatible`（进程死了，没人能报状态）；
   *   · 拿不到「提示修复或回滚」（`line 278` 明确要求 Runtime 不可用时
   *     只读界面**继续开放**——进程死了就只剩一个崩溃）。
   *
   *   > 一个"强制面没生效就整个产品起不来"的部署，把一条**可修复**的读数
   *   > 换成了一个**不可用**的现象——而 `line 854` 要的恰恰是前者。
   *
   * 安全方向**没有**放松：宿主端口**照样不注册**，所以没有任何执行路径被打开；
   * 变的只是"这份拒绝**能不能被看见**"。
   */
  SELF_CHECK_INCOMPATIBLE: 'RUNTIME_HOST_ROW_SELF_CHECK_INCOMPATIBLE',
})

// ───────────────────────────────────────────────────────────────────────────
// 注册缝：`{runtimeHost, canRead}` 由知道答案的那一侧装进来。**没有默认值。**
// ───────────────────────────────────────────────────────────────────────────

let inputsFactory = null

/** 缝上现在的工厂（`null` = 没人注册）。给用例与自检读，不给生产判定用。 */
export function dshRuntimeInputsFactory() {
  return inputsFactory
}

/**
 * 注册一个输入工厂：`(ctx) => ({runtimeHost, canRead})`。
 *
 * 返回**注销函数**，幂等，且只撤掉**自己**那一次注册——与
 * `executor-binding.mjs` 的绑定栈是同一个理由：撤销顺序不该复活任何东西。
 *
 * 工厂在**本行 `apply` 时**被调用（不是注册时），并收到**本行这一侧的 Context**：
 * 真的 `runtimeHost` 只能从现场服务上取（`ctx.get('subagents').start` 是
 * `startRun` 的唯一真来源），而注册可能发生在更早的模块求值期——那时还没有树。
 *
 * 上一批的零参工厂仍然合法（多余实参被忽略），但从此**拿不到现场**：
 * 新的生产注册方应当用 `runtime-host-registrar-row.mjs` 的
 * `createRuntimeHostInputsFactory()`（它就是要 `ctx` 的那个形状）。
 */
export function setDshRuntimeInputsFactory(factory) {
  if (typeof factory !== 'function') {
    const err = new TypeError(
      `setDshRuntimeInputsFactory 需要一个函数，收到 ${factory === null ? 'null' : typeof factory}。` +
      '一个"注册了个空的"与"没人注册"在读数上必须分得开，所以这里当场拒收',
    )
    err.code = RUNTIME_HOST_ROW_CODES.NO_INPUTS_FACTORY
    throw err
  }
  const mine = factory
  inputsFactory = mine
  let undone = false
  return function undoInputsFactory() {
    if (undone) return false
    undone = true
    if (inputsFactory === mine) inputsFactory = null
    return true
  }
}

/** 把缝恢复成"没人注册"（**用例专用**：反向对照要在同一进程里做）。 */
export function resetDshRuntimeInputsFactory() {
  inputsFactory = null
}

// ───────────────────────────────────────────────────────────────────────────
// 组合树观察：**真**来源（不是注入的替身）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 从 DSH 自己的加载器树读出 `reconcilePatchLayer()` 要的形状。
 *
 * ## ★ 为什么不能只按 `options.id` 一对一地读
 *
 * `reconcilePatchLayer()` 是按**声明里的行 id**（`PATCH_LAYER_ROWS[].id`）去树里找的，
 * 而声明里的两种行在树里**不是同一种东西**：
 *
 *   · `insert` 行：树条目 id **就是**声明的 id（`legion-enforcement-hard-floor` …）；
 *   · `patch-over` 行：补丁文件顶层的 `id` 是**被覆盖的目标**（`permission`），
 *     Legion 自己的行 id 刻意不出现——`composition.test.mjs` 把这一条写成了断言
 *     （"id 出现才说明我们写错了，会打不到靶子"）。
 *
 * 所以只按 `options.id` 读的观察器**永远**会为 `patch-over` 那一行报 `ROW_MISSING`，
 * 于是启动自检永远判"强制面未生效"，于是 `bootstrapDshRuntime()` 永远拒绝注册——
 * **任何**生产调用方都再也绑不上。这条读数是在真 DSH 进程里量到的：
 * `legion-enforcement-permission-presets: 补丁层行未出现在组合树中`
 * （本批文档 §4）。
 *
 *   > 一个"按声明的 id 逐行对账"的观察器，
 *   > 与一个"永远对不上账"的观察器，在只看它自己的用例里是同一个东西。
 *
 * 因此这里按**声明**做一次映射：`patch-over` 行报成它的 `mount.target` 那一条树条目的
 * 激活状态，但**行 id 用声明里的那个**。这个映射必须说清它的分量：
 * 它读的是"被覆盖的那一行在不在、活没活"，**不是**"覆盖真的落上去了"——
 * 后者由上面 `permissionPresets` 那一条**独立**判定（preset 名解析得到才算）。
 * 两个读数分开，是因为它们会分别坏掉。
 *
 * 读不出来的情形一律返回 `null`（由调用方拒成 `..._NO_COMPOSITION`），
 * **不返回 `{rows: []}`**：一个"读到零行"的观察结果与一个"根本没读到"的
 * 观察结果在这一层的用途上必须分得开——`bootstrapDshRuntime()` 的
 * `BOOTSTRAP_COMPOSITION_UNOBSERVED` 那段注释写的就是这条。
 *
 * ## `inProcessMounted`：运行期行（`module: null`）的**唯一**证据
 *
 * 返回的观察结果多一个字段，由下面的 `mountedEnforcementRows(ctx)` 从组合根服务里读。
 * 它缺席（`null`）是**正常**的——没装组合根、或者根还没挂过——此时
 * `reconcilePatchLayer()` 会为那两行报 `ROW_MISSING`（fail closed）。
 * 为什么这份证据不能用 `enforcementSurfaces()` 顶替，见那个函数的注释。
 */
export function observeComposition(ctx) {
  // 用 `ctx.get('loader')` 而不是 `ctx.loader`：实测过（本批文档 §3）——
  // 在一个**真 DSH 进程**里 `ctx.get('loader')` 拿到的是那个 loader 对象，
  // 而 `ctx.loader` 在一个没有 loader 的 Context 上会**抛**
  // （"cannot get property \"loader\" without inject"）。两种访问方式在读数上
  // 分成"读到"与"抛"，而本函数要的是"读到"与"没有"。
  //
  // 第二个参数**不要传**：真 cordis 里它是 `strict`，不是 fallback
  // （见 `absent()` 那段）。服务缺席时拿到的是 `undefined`。
  const loader = ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function'
    ? null
    : ctx.get('loader')
  if (absent(loader) || typeof loader !== 'object' || typeof loader.entries !== 'function') return null

  // 声明 → 树条目 id。`insert` 行是自己，`patch-over` 行是它的靶子。
  // 从声明推导，不写死 'permission'：写死的那一份会在补丁层加一行的当天变成假话。
  const declaredToTreeId = new Map()
  const presetSourceTreeId = new Map()
  for (const row of PATCH_LAYER_ROWS) {
    const treeId = row.mount?.anchor === 'patch-over' && typeof row.mount.target === 'string'
      ? row.mount.target
      : row.id
    declaredToTreeId.set(row.id, treeId)
    if (row.mount?.anchor === 'patch-over') presetSourceTreeId.set(treeId, row.id)
  }

  const byTreeId = new Map()
  try {
    for (const entry of loader.entries()) {
      const options = entry?.options
      if (options === null || typeof options !== 'object') continue
      const id = typeof options.id === 'string' && options.id !== '' ? options.id : null
      if (id === null) continue
      byTreeId.set(id, { entry, options })
    }
  } catch {
    // 树读了一半抛错：**不给部分结果**。半份观察会让自检按"少了几行"拒绝，
    // 而真因是"读的时候炸了"——那不是同一件事。
    return null
  }

  // 一棵**零条目**的树不是"读到了一份空组合"，而是"没读到组合"。
  // 真 profile 里永远至少有 `cordis:include` 那一行，所以这里为零只可能是
  // 读错了东西；把它报成"读到零行"会让自检去逐行判未生效，而真因是读错了。
  if (byTreeId.size === 0) return null

  const rows = []
  for (const [declaredId, treeId] of declaredToTreeId.entries()) {
    const hit = byTreeId.get(treeId)
    if (hit === undefined) {
      rows.push({ id: declaredId, activated: false, treeId, present: false })
      continue
    }
    rows.push({ id: declaredId, activated: hit.entry?.fiber?.state === ACTIVE_FIBER_STATE, treeId, present: true })
  }

  // preset 表从 `patch-over` 的**靶子**那一条上读。`declaredToTreeId` 里只有一个
  // patch-over 行（permission），但这里不假设只有一个：全都读，取第一个非空。
  let permissionPresets = null
  for (const treeId of presetSourceTreeId.keys()) {
    const hit = byTreeId.get(treeId)
    const presets = hit?.options?.config?.presets
    if (presets !== null && typeof presets === 'object') {
      permissionPresets = Object.keys(presets)
      break
    }
  }

  return { rows, permissionPresets, inProcessMounted: mountedEnforcementRows(ctx) }
}

/**
 * 从组合根服务里读**进程内挂载账**（`assemble.mjs` 的 `mountedRowNames`）。
 *
 * ## 它补的是哪一截（★ 这一条是本文件里唯一的"新证据源"，别把它读成便利方法）
 *
 * `PATCH_LAYER_ROWS` 里有两行是 `module: null` + `runtimeModule`（`pre-execute` /
 * `approval-answerer`）：它们**永远不会**作为 loader 条目出现——只能由组合根在进程内
 * `mount()` 上去，而 Cordis 的 fiber 不是 loader 条目。于是按组合树逐行对账的
 * `reconcilePatchLayer()` 对这两行**永远**报 `ROW_MISSING`，启动自检永远判
 * "强制面未生效"并拒绝注册：
 *
 *   > 一个"读一个结构上不可能装着它的地方"的检查，
 *   > 与一个"它真的没装"的检查，给出同一条红——只有后者能被接线修好。
 *
 * 所以这里去问**唯一知道答案的那一侧**：组合根本身。它手里那份账**只有 `mount()`
 * 写得出来**（见 `assemble.mjs`），所以"删掉挂载"会立刻在这里变成"读不到"。
 *
 * ## ★ 为什么**不能**改用 `enforcementSurfaces()`
 *
 * 那个读数报的是"桥是用哪几个端口造出来的"（hardFloor / pathScope / whitelist /
 * policy / approval）——`assembleEnforcement()` 一跑就是满的，**与有没有人调
 * `mount()` 完全无关**。拿它当证据，会让"把 `mount(ctx)` 那一行删掉"在读数上
 * 完全消失：一套删掉挂载也照样全绿的用例，与一套真的验过挂载的用例，
 * 在绿的输出上长得一模一样。
 *
 *   > 一个证明得了任何东西的证据，与一个什么都证明不了的证据，
 *   > 在"门禁是绿的"这件事上是同一个东西——只不过前者在改动之后还会红。
 *
 * ## 失败一律返回 `null`（fail closed），**不返回空数组**
 *
 * 服务缺席 / 是一份拒绝（`ok !== true`）/ `root` 形状不对 / 账不是函数 /
 * 账抛了 / 返回值不是字符串数组 / 数组里一行都没有 —— 全部按"**没有证据**"处理。
 * 上层（`reconcilePatchLayer`）于是把那两行报成 `ROW_MISSING`：
 * 「没观察到挂载」不等于「已挂上」，与 `PRESETS_UNOBSERVED` 同一条口径。
 */
function mountedEnforcementRows(ctx) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function') return null
  // 与 `runtimeHostRow.apply` 读的是**同一个**服务；但那一段的失败会以具名码拒绝，
  // 这里只负责"读得到就读、读不到就当没有证据"，所以不抛。
  const installed = ctx.get(ENFORCEMENT_ROOT_SERVICE)
  if (absent(installed) || typeof installed !== 'object') return null
  if (installed.ok !== true) return null
  const root = installed.root
  if (absent(root) || typeof root !== 'object') return null
  if (typeof root.mountedEnforcementRows !== 'function') return null
  let names = null
  try {
    names = root.mountedEnforcementRows()
  } catch {
    // 账读了一半抛错：**不给部分结果**（与上面 loader 树那条同一个理由）。
    return null
  }
  if (!Array.isArray(names)) return null
  const rows = names.filter((name) => typeof name === 'string' && name !== '')
  if (rows.length === 0) return null
  return Object.freeze(rows)
}

/**
 * ★★ 在**读挂载账之前**等这次挂载 settle（PRT-214 收口续二）。
 *
 * ## 为什么必须有这一步
 *
 * `assemble.mjs` 的挂载账原来只有一本，且写在第一个 `await` 之前。它同时承担了
 * 两个不同的职责，而这两个职责在"读的时刻"上要求相反：
 *
 *   · **诊断**："这次挂载覆盖了哪几行" —— 越早写越好；
 *   · **生效证据**："哪几行真的挂上了" —— 只有 `ctx.plugin` resolve 之后才为真。
 *
 * 合成一本的后果本批量到了，而且是**确定的**（不是时序巧合）：
 *
 *   ```js
 *   const mounting = root.mount(ctx)      // 同步返回
 *   root.mountedEnforcementRows()         // 已经宣布两行已挂载
 *   // ↑ 此刻两个 `apply` **一个都还没被调用**
 *   ```
 *
 * 顺着 `reconcilePatchLayer()` → `startupSelfCheck()` 第①项 →
 * `bootstrapDshRuntime()` 注册端口，这个窗口上开着的是**最关键的那条保证**：
 * 「强制面未生效时禁止自动执行」——那一刻强制面一行都没在听，判决却说"生效"。
 *
 *   > 一本"挂载一发起就宣布挂好了"的账，
 *   > 与一本"根本没记挂载"的账，在没有并发读者的世界里是同一个东西——
 *   > 只不过前者的假绿只在**读的时刻恰好在窗口里**才看得见。
 *
 * ## 为什么等待放在**这一侧**，而不是把账写晚一点
 *
 * 只把证据账写晚（本批已经这么改）会把假绿换成**假红**：观察者若在窗口里读，
 * 会读到空集 ⇒ `ROW_MISSING` ⇒ 自检判未生效 ⇒ 拒绝注册 ⇒ **一个健康的部署起不来**。
 *
 *   > 一个"把假绿换成假红"的修法，
 *   > 与一个"什么都没修"的修法，在"产品能不能起来"这件事上是同一个东西。
 *
 * 所以证据语义与读取时机必须**一起**改。本行的 `apply` 本来就是 async
 * （下面还要 `await root.bootstrap(...)`），多等一次不改变它的性质。
 *
 * ## 反过来会不会变得更糟：不会
 *
 * 本行的 `apply` 晚一点读完组合树，读到的是**更收敛**的树，不是更不收敛的。
 * `root-row.mjs` 文件头警告的那种"读数从已收敛变成未收敛"，来自把**根行**的
 * `apply` 改成 async（那会推迟服务发布、把观察者挤进同一批微任务）；本函数
 * 改的是观察者**自己**的时序，方向相反。
 *
 * ## ⚠️ 诚实边界：等待没有超时
 *
 * `mount()` 永不 settle（某一行永久 pending）时，本行会一直等下去。那在方向上
 * 是 fail closed（不注册 ⇒ 不自动执行），但**不可见**——比一次拒绝更难排查。
 * 不加超时的理由：超时需要一个凭空的常数，而超时之后仍然要决定"读到没收敛的账
 * 算不算数"——那等于把本批修掉的假绿重新放回来一次。这个取舍写在这里，
 * 而不是假装它不存在。
 */
async function settleEnforcementMount(ctx) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function') {
    return Object.freeze({ waited: false, reason: 'no-context' })
  }
  const installed = ctx.get(ENFORCEMENT_ROOT_SERVICE)
  if (absent(installed) || typeof installed !== 'object' || installed.ok !== true) {
    return Object.freeze({ waited: false, reason: 'no-installation' })
  }
  const root = installed.root
  if (absent(root) || typeof root !== 'object') {
    return Object.freeze({ waited: false, reason: 'no-root' })
  }
  // 形状不对 ⇒ 等不了。**不假装等过**：后面 `mountedEnforcementRows()` 会按
  // "读到什么算什么"处理，而缺这个口说明装配方不是本仓库的这一份。
  if (typeof root.mountSettled !== 'function') {
    return Object.freeze({ waited: false, reason: 'no-mount-settled' })
  }
  try {
    await root.mountSettled()
  } catch {
    // ★ 永远不该走到这里（`mountSettled()` 自己不 reject）。真走到了就当"没等到"，
    //   让证据账自己去说话——吞掉一个挂载异常会把它变成"观察者坏了"。
    return Object.freeze({ waited: false, reason: 'settle-threw' })
  }
  return Object.freeze({ waited: true, reason: null })
}

// ───────────────────────────────────────────────────────────────────────────

/**
 * "这个服务没挂"的判据：`ctx.get(name) === undefined`。
 *
 * ★ **第二个参数不是 fallback**。真 cordis 的签名是
 * `get(name, strict = true)`——`strict` 只决定"提供方 fiber 还没 ACTIVE 时算不算在场"，
 * 服务缺席时一律返回 `undefined`。
 *
 * 第一版这里写的是 `ctx.get('sandbox', NOT_MOUNTED)`（自造哨兵）+ `=== NOT_MOUNTED`，
 * 在一个"把第二个参数当 fallback"的假 Context 上全绿，到了真进程里那次判断
 * 永远不成立——**沙箱缺席会被读成沙箱在场**。
 *
 *   > 一个对着自己造的哨兵做判断的接线，
 *   > 与一个不做判断的接线，在真运行时上是同一个东西。
 */
function absent(value) {
  return value === undefined || value === null
}

/**
 * 本行的拒绝错误。
 *
 * ## ★ 为什么码既要放 `err.code`、也要进**消息文本**（2026-09-16 补）
 *
 * 原来只做前者。于是**在真 DSH 进程里，本行的拒绝码根本不出现在 stderr 上**：
 * app-boot 打印的是 `err.stack` 的首行，形状是
 * `RuntimeHostRowError: <message>`，而 `err.code` **不在那一行里**
 * （实测：只有一个**内层**注册方码因为被 `INPUTS_FACTORY_THREW` 的消息引用而看见）。
 *
 * 两件事同时坏掉：
 *
 *   · **值班的人 grep 不到它**。拒绝的理由是"组合树没观察到"还是"没有人注册工厂"，
 *     只能靠读一整句中文去分辨——而 `code` 之所以存在，就是为了让这件事可 grep。
 *     这与 `a374a7f` 自己那句「拒绝**必须留下痕迹**」「提示得**出得去**才算提示」同向；
 *   · **一批用例因此变成空的**。它们写的是
 *     `assert.equal(r.stderr.includes(<本行的码>), false, '绑定没建立：读到了 …')`——
 *     一句"某码**不在** stderr 里"的断言，在该码**从来不会**进 stderr 时**恒真**。
 *     它本该抓住"绑定没建立"，实际上一句都抓不住。
 *
 *   > 一条"某个记号不出现"的断言，
 *   > 在那个记号**不可能**出现的世界上，与没有断言是同一个东西。
 *
 * 所以码进消息文本。`err.code` 照旧保留（进程内调用方读的是它，不是文本）。
 * 与本仓既有的写法一致：`root-row.mjs` 的装配失败消息里就写着
 * `组合根给的是 ENFORCEMENT_ROOT_CONFIG_EMPTY`——那一条一直是可 grep 的。
 *
 * @param {string} code 具名拒绝码；同时进 `err.code` 与消息文本。
 * @param {string} message 人读的理由。
 * @param {object} [extra] 附加字段（`checks` / `reasons` / `innerCode` 等）。
 * @returns {Error} `name` 为 `RuntimeHostRowError` 的错误。
 */
function rowError(code, message, extra = {}) {
  const err = new Error(`${RUNTIME_HOST_ROW_PLUGIN_NAME} 拒绝装配（code=${code}）：${message}`)
  err.name = 'RuntimeHostRowError'
  err.code = code
  Object.assign(err, extra)
  return err
}

function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `数组(${value.length})`
  return typeof value
}

/**
 * 这一行：把宿主端口与自检交给 worker 的**生产调用方**。
 *
 * 输入四样，来源见文件头的表；四样里少任何一样都以**具名码当场拒绝**，
 * 不装一个"半根"。`root.bootstrap()` 自己拒绝时（自检没过 / 端口不完整 /
 * 组合树只见了一半）本行把它的内层码原样带出来——两种"装不上"必须可分。
 */
export const runtimeHostRow = {
  name: RUNTIME_HOST_ROW_PLUGIN_NAME,
  // 组合根由 `root-row.mjs` 发布。**用依赖、不用行序**：Loader 并发创建补丁行
  // （`Promise.allSettled(config.map(create))`），所以"根行先 apply"是不得假设的。
  // 根行不在时本行停在 pending，由 DSH 自己的挂载审计报出来——不是静默 no-op。
  inject: [ENFORCEMENT_ROOT_SERVICE],

  async apply(ctx) {
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.provide !== 'function') {
      throw rowError(RUNTIME_HOST_ROW_CODES.NO_CONTEXT,
        '需要一个 Cordis Context（要能 ctx.provide 发布绑定结论、要能读 ctx.loader）')
    }

    // ★ 服务值是 `installEnforcementRoot()` 的**安装结果**（`{ok, code, message, root}`），
    //   不是组合根本身——`bootstrap` 在 `installed.root.bootstrap` 上。
    //   这不是猜的：`root-row.mjs` 那一行发布的就是 `enforcementInstallation()`，
    //   而 `pre-execute-row.mjs` 读的也是 `installed.root?.rows?.preExecute`。
    //   第一版把服务值当组合根用，在假服务上全绿、在真进程里报成"服务不在"。
    const installed = typeof ctx.get === 'function' ? ctx.get(ENFORCEMENT_ROOT_SERVICE) : undefined
    if (absent(installed)) {
      throw rowError(RUNTIME_HOST_ROW_CODES.NO_ENFORCEMENT_ROOT,
        `${ENFORCEMENT_ROOT_SERVICE} 服务不在。` +
        '本行 inject 它，所以这只能是接线错了——而**不**回落到一个可能晚到的值：' +
        '"服务还没到"与"服务永远不到"必须由 Cordis 的依赖机制分开，不能靠一个 `if`')
    }
    if (installed.ok !== true) {
      throw rowError(RUNTIME_HOST_ROW_CODES.ENFORCEMENT_ROOT_REFUSED,
        `组合根拒绝了（${installed.code ?? '(无码)'}）：${installed.message ?? '(无消息)'}。` +
        '**不装半根**：一个没有策略门 / 审批口的强制面，与一个"审批永远问不到人"的强制面，是同一个东西',
        {
          innerCode: installed.code ?? null,
          reasons: Object.freeze([...(installed.reasons ?? [])]),
        })
    }
    const root = installed.root
    if (root === null || typeof root !== 'object' || typeof root.bootstrap !== 'function') {
      throw rowError(RUNTIME_HOST_ROW_CODES.ROOT_SHAPE_INVALID,
        `${ENFORCEMENT_ROOT_SERVICE} 在，但它的 \`root.bootstrap\` 不是函数` +
        `（收到 root=${describe(root)}，bootstrap=${describe(root?.bootstrap)}）。` +
        '服务值是安装结果 `{ok, code, message, root}`，`bootstrap` 在 `root` 上——' +
        '把服务值当组合根用会在真进程里报成"服务不在"，而真因是形状读错了')
    }

    const factory = inputsFactory
    if (typeof factory !== 'function') {
      throw rowError(RUNTIME_HOST_ROW_CODES.NO_INPUTS_FACTORY,
        '没有人注册宿主端口工厂（setDshRuntimeInputsFactory）。' +
        '**本行不补一个假的**：一个"全 true 的能力表"会让这次绑定' +
        '在一个从未验过的引擎上判"兼容"；而一个编出来的 `canRead` 会让"没有来源"读成"有来源"。' +
        '真来源与缺失读数见本文件头与 PRT-253 文档')
    }

    let inputs = null
    try {
      // ★ 工厂拿得到**本行这一侧的** Context（PRT-253 续批二起）。
      //
      // 为什么非给它不可：真的 `runtimeHost` 只能从现场服务上取
      // （`ctx.get('subagents').start` 是 `startRun` 的唯一真来源），而模块求值期
      // 还没有树。上一批的文件头已经把意图写成「工厂在本行 `apply` 时被调用：
      // 它需要 DSH 进程的现场」——这一行让"现场"真的到手。
      //
      // 传参是**向后兼容**的：上一批那些零参工厂（`() => inputs`）在 JS 里
      // 忽略多余实参，行为一字不变。
      inputs = factory(ctx)
    } catch (e) {
      throw rowError(RUNTIME_HOST_ROW_CODES.INPUTS_FACTORY_THREW,
        `宿主端口工厂抛了：${e?.message ?? String(e)}` +
        (e?.code === undefined ? '' : `（code=${e.code}）`))
    }
    if (inputs === null || typeof inputs !== 'object') {
      throw rowError(RUNTIME_HOST_ROW_CODES.NO_HOST_PORT,
        `宿主端口工厂返回了 ${describe(inputs)}，而它必须返回 {runtimeHost, canRead}`)
    }

    const runtimeHost = inputs.runtimeHost
    if (runtimeHost === null || typeof runtimeHost !== 'object') {
      throw rowError(RUNTIME_HOST_ROW_CODES.NO_HOST_PORT,
        `宿主端口是 ${describe(runtimeHost)}，而它必须是 {startRun, probeRuntime} 对象`)
    }

    // ★ `canRead` **可以缺席**（PRT-253 授权批 + 本批）：本行跑在 DSH Runtime
    //   进程里，而那个进程里没有任何东西读它（四条测量见
    //   `runtime-host-registrar-row.mjs` 文件头）。所以缺席被**如实**记成 `null`
    //   原样交下去——不是替身、不是默认放行、也不是默认拒绝。
    //
    //   但"没有来源"与"挂了个坏的"是两件事：后者当场拒，**不静默丢掉**。
    //   （上一版这里要求"必须是函数"，那条要求拦的是一个没有读者的输入。）
    const canRead = inputs.canRead ?? null
    if (canRead !== null && typeof canRead !== 'function') {
      throw rowError(RUNTIME_HOST_ROW_CODES.NO_CAN_READ,
        `canRead 是 ${describe(canRead)}，而它要么是函数，要么是 null（表示"这个进程里没有来源"）。` +
        '权限判定由调用方显式给出——本行不猜；但**缺席是合法的**，它被如实交下去，' +
        '由真正要执行的那一侧（worker 的 productionExecutorProvider）以具名码拒绝。' +
        '把一个不是函数的值悄悄丢掉，会让"有人试图挂它"从读数上消失')
    }

    // ★★ 先等这次挂载 settle，再读账。理由见 `settleEnforcementMount()` 那一段：
    //    挂载账原来是"一发起就是满的"，而那一刻两个 `apply` 一个都还没跑——
    //    假绿正好落在「强制面未生效时禁止自动执行」这条保证上。
    const settled = await settleEnforcementMount(ctx)

    const composition = observeComposition(ctx)
    if (composition === null || composition.rows.length === 0) {
      const got = composition === null ? '读不到加载器树' : 'rows 为空'
      throw rowError(RUNTIME_HOST_ROW_CODES.NO_COMPOSITION,
        `没有拿到组合树观察结果（${got}）：**不注册**。` +
        '这不是「补丁层未生效」——那是"读了、说没生效"，而这是"没读到"。' +
        '混成一个码会让排查方向指向错的地方')
    }

    const sandbox = typeof ctx.get === 'function' ? ctx.get('sandbox') : undefined
    if (absent(sandbox)) {
      throw rowError(RUNTIME_HOST_ROW_CODES.NO_SANDBOX_PORT,
        '沙箱服务不在（`ctx.sandbox.confine` 不可用）。' +
        '**不注册**：一个没挂沙箱端口的进程，自检只能判"沙箱未生效"，' +
        '而那正是「强制面未生效时禁止自动执行」要拦的处境')
    }

    const bound = await root.bootstrap({ runtimeHost, composition, sandbox, canRead })
    if (bound === null || typeof bound !== 'object' || bound.ok !== true) {
      // ★ 逐条把**内层自检的归因**带出来。只报一个内层码，值班的人还得自己去把
      //   那六项重跑一遍才知道该修哪一项——而自检的全部意义就是"逐项归因"。
      const failedChecks = (bound?.checks ?? [])
        .filter((c) => c?.ok !== true)
        .map((c) => `  · ${c?.name ?? '(无名)'}：${(c?.reasons ?? []).join(' / ') || '(未给出原因)'}`)
      const innerReasons = (bound?.reasons ?? []).map((r) => `  · ${r}`)
      const detail = failedChecks.length === 0 && innerReasons.length === 0
        ? ''
        : `\n未通过的自检项 / 原因：\n${[...failedChecks, ...innerReasons].join('\n')}`
      const refusalExtra = {
        innerCode: bound?.code ?? null,
        missing: Object.freeze([...(bound?.missing ?? [])]),
        reasons: Object.freeze([...(bound?.reasons ?? [])]),
        checks: Object.freeze([...(bound?.checks ?? [])]),
      }

      // ★★★ **自检判定"强制面未生效"时不抛**——本批翻过来的那个取舍。
      //
      //   为什么这是对的（三条都是 spec 正文，不是我们的附录）：
      //     · `line 854`：未生效时「按 `incompatible` 处理并禁止自动执行」
      //       ——"处理"意味着**继续存在并处于那个状态**，而不是消失；
      //     · `line 275`（§6.3 表）：`incompatible` 的行为是
      //       「禁止自动执行，**提示修复或回滚**」——一个已经死掉的进程
      //       无法提示任何东西，也无法被回滚；
      //     · `line 278`：「只读 Workbench 和 team-hub 在 Runtime 不可用时
      //       **继续开放**」——这句话预设了产品**还在跑**。
      //
      //   而**安全方向一点没动**：宿主端口仍然不注册（下面这个 `return` 在
      //   `ctx.provide(RUNTIME_HOST_BINDING_SERVICE, ...)` 之前就结束了注册路径），
      //   所以 worker 那边拿不到端口、构造不出执行引擎、不认领任何任务。
      //   换掉的只是这份拒绝的**可见性**：从一个"进程崩了"变成一个
      //   "进程活着、明确说自己不能干活、并且能被上层读到"。
      //
      //   > 一个"因为强制面没生效而整个产品起不来"的部署，
      //   > 与一个"强制面没生效、产品照常在跑并明说自己不能自动执行"的部署，
      //   > 后者的失败面小得多——而**两者都禁止执行**，区别只在谁能被修。
      //
      //   这与 `runtime-contract-server-row.mjs` 的取舍同向（那个文件在自己的
      //   文件头里为**出口**写了同样的理由），而与本文件对**其他**拒绝
      //   （`BAD_WIRING` / `PORT_INCOMPLETE` / `COMPOSITION_UNOBSERVED`）的处理
      //   **故意不同**：那些是**我们自己的接线错误**，接线错了要当场响，
      //   而不是安静地降级成一个"产品看起来在跑"的状态。
      if (bound?.code === BOOTSTRAP_CODES.SELF_CHECK_INCOMPATIBLE) {
        const refusalMessage =
          `[${RUNTIME_HOST_ROW_PLUGIN_NAME}] 启动自检判定强制面未生效（内层码 ${bound.code}）：`
          + `${bound.message ?? '(无消息)'}——**不注册宿主端口**，运行时按 \`incompatible\` 处理并禁止自动执行`
          + detail
        // ★★ 拒绝**必须留下痕迹**：服务值只有"读得到它的人"才看得见，
        //   而一个"产品不能自动执行"的原因如果不在日志里，值班的人只能靠猜。
        //   spec §6.3 要的是「提示修复或回滚」——提示得**出得去**才算提示。
        //
        //   这一条不是装饰：把 `throw` 换成 `provide` 之后，
        //   拒绝就从"进程退出时的 stderr"搬到了"一个服务值上"——
        //   如果没有这条路，**同一个原因会从所有日志里消失**，
        //   而"进程活着"会把这件事伪装成"一切正常"。
        //
        //   > 一个"不再崩溃、但也不再说明为什么"的启动，
        //   > 与一个"正常启动"的启动，在日志里是同一个东西。
        const logFn = typeof ctx.logger?.warn === 'function'
          ? ctx.logger.warn
          : (typeof ctx.logger?.info === 'function' ? ctx.logger.info : null)
        if (logFn !== null) logFn.call(ctx.logger, refusalMessage)

        ctx.provide(RUNTIME_HOST_BINDING_SERVICE, Object.freeze({
          ok: false,
          code: RUNTIME_HOST_ROW_CODES.SELF_CHECK_INCOMPATIBLE,
          rowVersion: RUNTIME_HOST_ROW_VERSION,
          // 内层码原样带着走：上层要能分辨"自检不兼容"与别的 `BOOTSTRAP_*` 拒绝，
          // 而这一点从 `code` 上读不出来（`code` 是本行的码）。
          innerCode: refusalExtra.innerCode,
          message: refusalMessage,
          // `incompatible` 是 spec §6.3 表格里的那一个值，不是这里发明的字符串。
          state: bound.state ?? SELFCHECK_STATES.incompatible,
          patchVersion: bound.patchVersion ?? null,
          checks: refusalExtra.checks,
          reasons: refusalExtra.reasons,
          // 修法**跟着读数一起走**：只说"不兼容"而不给修复入口，
          // 就等于把 spec 要求的"提示修复或回滚"又丢了一次。
          repair: bound.repair ?? null,
          // `true` 是给下游（契约出口）的**显式**信号：这条拒绝的含义就是
          // "禁止自动执行"。让下游从 `ok:false` 去猜是不行的——
          // `ok:false` 也可能只是一个"出口没配好"的降级，那不该禁止执行。
          autoExecutionForbidden: true,
          mountSettled: settled.waited,
          mountSettledReason: settled.reason,
        }))
        return
      }

      throw rowError(RUNTIME_HOST_ROW_CODES.BIND_REFUSED,
        `bootstrapDshRuntime 拒绝了（内层码 ${bound?.code ?? '(无码)'}）：${bound?.message ?? '(无消息)'}` + detail,
        refusalExtra)
    }

    const published = Object.freeze({
      ok: true,
      code: null,
      rowVersion: RUNTIME_HOST_ROW_VERSION,
      state: bound.state ?? null,
      patchVersion: bound.patchVersion ?? null,
      checks: Object.freeze([...(bound.checks ?? [])]),
      // ★ "这次判决是在**已 settle 的**证据上做的吗"——写成字段，不靠读者推断。
      //   与 `reconcilePatchLayer()` 的 `mountSource` 同一个口径：把"哪个宇宙"
      //   写出来，读者就不用回去看代码才知道自己读到的是哪一种。
      //   `waited:false` + `reason:'no-installation'` 表示这个进程里根本没有组合根
      //   （那种情况下 `observeComposition` 早已按"没有证据"处理，判决是 fail closed）。
      mountSettled: settled.waited,
      mountSettledReason: settled.reason,
    })
    // 绑定是**进程级副作用**：本行被卸载（HMR / stop）时必须把它撤掉，
    // 否则同一个进程里的下一次启动带着上一次的残留状态跑。
    // `unbind` 自己幂等且与调用顺序无关（栈语义，见 `executor-binding.mjs`）。
    //
    // 形状照既有那几行：`ctx.effect` 收的是**返回 disposer 的回调**。
    // 写成 `ctx.effect(() => bound.unbind())` 会让 cordis 拿到一个布尔值
    // （`unbind` 的返回值）并报 `TypeError: Invalid effect`。
    if (typeof bound.unbind === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => bound.unbind)
    }
    ctx.provide(RUNTIME_HOST_BINDING_SERVICE, published)

    // ★ **不返回任何东西**。cordis 会把 `apply` 的返回值当**效果**收集：
    // 一个 async `apply` 解析出来的值会走 `effect.then(safeCollect)`，而一个
    // 既不是函数、又没有 `then` / `Symbol.iterator` 的对象会当场报
    // `TypeError: Invalid effect`——**并且它会连带把这一行已经 provide 出去的服务
    // 一起回滚掉**。第一版这里写的是 `return published`，是 `⑯`（真 Context）
    // 把它咬出来的：同一个实现，在假 Context 上全绿。
    //
    //   > "在替身上是对的"这句话，在"真运行时会因为返回一个对象而报错"这件事上
    //   > 一点帮助都没有。
  },
}

export default runtimeHostRow
