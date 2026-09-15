// runtime/dsh-composition/patch-layer.mjs
// ============================================================================
// Legion DSH 组合补丁层定义（PRT-214）
//
// ## 这一层解决什么问题
//
// §6.8 的强制面映射要成为**安全保证**，前提是强制面挂载在正确的组合平面上。
// DSH 逐层 patch 组合：`dsh-base` 打底，模式 bundle 覆盖其上，用户 profile 层再覆盖。
// 静态 hard floor / 策略 listener / approval answerer / preset 表**必须**在 host 组合层，
// 不能只放在 agent preset —— preset 按 session 挂载、可替换、可被 shadow，
// 把安全下限放在其中，等于让「不可绕过的下限」取决于当前 session 恰好挂了哪个 preset。
//
// ## 本文件是**声明**，不是执行
//
// 这里只描述「这一层由哪些行组成、每行挂什么、锚点在哪、版本是多少」，
// 以及**自检要按什么判据认定「已生效」**。真正的行挂载由宿主组合加载器完成。
//
// 之所以把声明与挂载分开：补丁层的**定义**可以在没有 DSH 的环境里被测试、
// 被逐条审阅、被版本比对；而挂载只能在装了 DSH 的环境里发生。
// 若两者写在一起，这一层就又变成「只能在 DSH 在场时才能验证」的东西 ——
// 而它恰恰是安全下限，最需要能独立审阅。
//
// ## 零 DSH import
//
// 本目录**不 import 任何 DSH 包**（`dsh-boundary` 对本目录的依赖计数为 0）。
// 与 `runtime/adapters/dsh/port.mjs` 同一立场：耦合方式改为**注入**。
// 结果是本目录的 DSH 记号数为 0，棘轮里 `adapterPrefixes` 的豁免**存在但不用**。
// ============================================================================

/**
 * 组合补丁层版本（PRT-214 / spec §6 的 `dshCompositionPatchVersion`）。
 *
 * 它与 `dshVersion` **强绑定**：补丁层通过 patch 锚点作用于 DSH bundle，
 * 锚点随 DSH 版本变化。因此两者必须成对验证，
 * 不允许出现「DSH 已升级但补丁层仍是旧锚点」的组合。
 *
 * 版本号只在**锚点或行组成发生实质变化**时递增。
 * 改动文案、注释、错误消息不递增 —— 否则这个号会变成噪音，
 * 而噪音版本号等于没有版本号。
 */
export const DSH_COMPOSITION_PATCH_VERSION = 1

/**
 * Legion 自有 permission preset 表。
 *
 * **不复用 DSH 默认表**。默认表把 `workspace-write`↔`ask` 与
 * `danger-full-access`↔`never` 绑定；若按默认表实现「无人值守 = never」，
 * 沙箱会**同时**被降级为 `danger-full-access`，与最小权限要求直接冲突。
 *
 * 注意这里的键名是**产品语义**（attended / unattended），不是沙箱模式名。
 * 用沙箱模式名当 preset 名会把「谁在看着」这个决策维度藏进「能写多少」里，
 * 于是「无人值守」在 UI 上看起来像「权限更大」。
 */
export const LEGION_PERMISSION_PRESETS = Object.freeze({
  'legion-attended': Object.freeze({
    sandbox: 'workspace-write',
    approval: 'ask',
    name: 'Legion · 有人值守',
    description: '在 workspace 内可写；越界写入需要人工批准。',
  }),
  'legion-unattended': Object.freeze({
    sandbox: 'workspace-write',
    approval: 'never',
    name: 'Legion · 无人值守',
    description: '在 workspace 内可写；越界写入直接拒绝（无人可问，不降级为放行）。',
  }),
})

/** DSH 默认 preset 表里那个**必须被覆盖**的默认（记录它，才能证明我们没在用它）。 */
export const DSH_DEFAULT_PRESETS = Object.freeze({
  'workspace-write': Object.freeze({ sandbox: 'workspace-write', approval: 'ask' }),
  'danger-full-access': Object.freeze({ sandbox: 'danger-full-access', approval: 'never' }),
})

/** 补丁层行 id 前缀。用来在组合树里认出「哪些行是 Legion 注入的」。 */
export const LEGION_ROW_PREFIX = 'legion-enforcement-'

/**
 * 补丁层的行清单。
 *
 * `anchor` 是 patch 目标：`insert` 表示新增行，`patch-over` 表示按 id 覆盖既有行
 * （DSH 的 patch 语义：**替换目标行的整个 config**，而不是合并进去）。
 *
 * ## ★ `module` 字段（PRT-214 补记）
 *
 * `insert` 在 DSH 的 `PatchOptions` 里是 **`EntryOptions[]`**，而一个
 * `EntryOptions` 必须带 `name`（要加载的模块）。DSH 对**匹配不到任何东西**的
 * 补丁行是 **warn-and-skip**：它不会报错，只是什么也不做。
 *
 *   > 一个"能被 DSH 接受、然后被 warn-and-skip 掉"的补丁行，
 *   > 与一个"从未被写进补丁层"的补丁行，在组合树里长得一模一样——
 *   > 只不过前者的文件看起来是装好的。
 *
 * 所以每一行**显式**记下自己的模块。`null` 的意思是"这个模块还不存在"，
 * 于是 `toPatchDocument()` 会把这一行归到 `unbuildable` 而不是造一个
 * 加载不了的空壳。这个字段让"PRT-214 没做完"变成一件**机械可查**的事，
 * 而不是一句散文。
 *
 * ## ★ `runtimeModule` 字段（PRT-214 组合根补记）
 *
 * 后两行（`pre-execute` / `approval-answerer`）**有模块了**，但那两个模块
 * 需要一个**进程内装配好的组合根**才挂得上（`root.mjs` 的
 * `installEnforcementRoot`）——DSH 加载补丁行时给的是 `config`（数据），
 * 而它们要的是桥、策略端口、审批端口（函数）。
 *
 * 于是这两个字段要分成两件事，**不能合成一件**：
 *
 *   · `module: null`       —— 静态补丁层里**没有**可加载的模块；
 *   · `runtimeModule: '…'` —— 模块**存在**，但只能由组合根在进程内挂载。
 *
 * 把 `module` 直接填成那个路径是**假话**：DSH 会去加载它，而它在组合根
 * 没装配好时会在 `apply` 期抛出（那是刻意的，见
 * `plugins/pre-execute-row.mjs` 的文件头）——一行"文件里写着、加载时就炸"
 * 的行，比缺行更坏。
 *
 * `toPatchDocument()` 因此对这类行报 `moduleState: 'runtime-only'` +
 * `runtimeModule`，`renderPatchReport()` 再把它单列一份 `runtimeOnly`。
 * 缺行与"有运行期模块但静态层装不了"在读数上**必须不同形**：
 * 前者是"模块还没写"，后者是"装配路径还没被接上"，修法完全不同。
 */
export const PATCH_LAYER_ROWS = Object.freeze([
  Object.freeze({
    id: `${LEGION_ROW_PREFIX}hard-floor`,
    plane: 'host',
    kind: 'guard',
    purpose: '静态 hard floor：同步、确定性、最终单调拒绝',
    mount: Object.freeze({ anchor: 'insert', after: 'tools' }),
    // 依据 §6.8：guard 只有降级语义、没有 allow 语义。
    // 因此这一行**永远不能**成为唯一防线 —— 它只负责「不可能被说成可以」的那部分。
    registrations: Object.freeze(['ctx.tools.guard']),
    // ★ 路径是**相对于补丁文件自己所在目录**的。
    //
    // 这不是我挑的写法：DSH 的 `parsePatchList` 会调
    // `anchorInsertedPluginNames(patches, file)`，把 `./` 或 `../` 开头的
    // `name` 按 `dirname(patchFile)` 解析成 file:// URL
    // （`packages/boot/app-boot/src/index.ts:326-336`）。
    //
    //   > 一个"写成机器绝对路径"的模块引用，
    //   > 与一个"换台机器就加载不到"的补丁层，是同一个东西——
    //   > 只不过前者在作者自己的机器上跑得通。
    //
    // 所以这里用相对路径，补丁层连同 `plugins/` 一起搬走仍然有效。
    module: './plugins/hard-floor.mjs',
  }),
  Object.freeze({
    id: `${LEGION_ROW_PREFIX}root`,
    plane: 'host',
    kind: 'composition-root',
    purpose: '在 DSH 进程内装配**一次**组合根（桥 + 共享登记簿），并发布服务供另两行按依赖激活',
    mount: Object.freeze({ anchor: 'insert', after: 'tools' }),
    // 这一行**不注册任何 listener**：它只装配 + 发布服务。真正的强制面在
    // 另外两行里，而那两行的挂载时机由这个服务决定（Cordis 的 inject 语义），
    // **不由补丁层的行序决定**——行顺序不携带加载语义，见文件头。
    registrations: Object.freeze(["ctx.provide('legionEnforcementRoot')"]),
    // ★ 本行是**静态可加载**的：它的输入是进程环境 + 一个注入的审批端口工厂，
    //   没有一样是 YAML 带不动的东西。所以它进 `legion-host.patch.yml`——
    //   这也是 `installEnforcementRoot()` 在全仓库的第一个生产调用方。
    //
    //   代价说清楚：配置不可解析时本行在 `apply` 期抛具名码，于是**启动路径上
    //   的失败**。那正是要的（被要求装上的强制面不能只写一行日志），而且
    //   `product/launcher/` 会在更早一步用一条带修法的 error 拦下同一种处境。
    //
    //   ⚠️ 审批端口工厂（`team-hub/approval-port.mjs` 的 `createHubApprovalPort`）
    //   由 `team-hub/` 侧经 `setApprovalPortFactory()` 注册进来：本目录**不能**
    //   import 它（会反转既有分层方向并造出真实的模块环，见 `root.mjs` 文件头）。
    //
    //   ★ PRT-214 续：注册方已交付，它就是下面这个模块
    //   （`team-hub/approval-registrar-row.mjs`）——所以本行的 `module` **不是**
    //   `./plugins/root-row.mjs`，补丁层加载的是**注册方**，它默认导出的仍然是
    //   真的那个 root row 插件对象（`===`，`approval-registrar-row.test.mjs` 钉住）。
    //
    //   为什么不另起一行 `legion-enforcement-approval-registrar`：
    //   Loader 用 `Promise.allSettled(config.map(create))` **并发**创建所有补丁行
    //   （`@deepseek-ai/cordis-plugin-loader/lib/index.js:97`），所以"注册行先求值、
    //   root 行后 apply"只在两个模块都**不挂起**时碰巧成立。真 DSH 进程里量到的
    //   2×2 矩阵（§10）：注册行做一次合法的顶层 await（500ms），root-first 与
    //   registrar-first **都** 6/6 拒绝——行序甚至都不是那个变量。
    //   而把注册放进 root 行自己的模块图后，**同样的 500ms 挂起** 6/6 装上：
    //   被 import 的模块必先求值完，才轮到 import 它的那个插件的 `apply`。
    //
    //   把它做成服务依赖（root 行 inject 注册行发布的服务）也能行序无关，但会让
    //   "注册行缺了"从 root 行那条具名拒绝变成一句 pending 审计——两者要值班的人
    //   去查的东西不同。完整对照见 PRT-214 文档 §10。
    //
    //   代价说清楚：这个模块住在 `team-hub/`，所以本补丁层**不再能连同
    //   `plugins/` 一起单独搬走**（相对路径要跨到仓库的 `team-hub/`）。
    module: '../../team-hub/approval-registrar-row.mjs',
  }),
  Object.freeze({
    id: `${LEGION_ROW_PREFIX}pre-execute`,
    plane: 'host',
    kind: 'listener',
    purpose: '动态 allow / deny / ask，team-hub 不可达或策略异常时 deny（fail closed）',
    mount: Object.freeze({ anchor: 'insert', after: 'tools' }),
    registrations: Object.freeze(["ctx.on('tools/pre-execute')"]),
    // ⚠️ 静态层里**没有**可加载的模块（它要一条桥，YAML 装不下），
    //    但运行期模块**存在**：组合根装配好之后由它挂上。见上面 `runtimeModule` 一段。
    module: null,
    runtimeModule: './plugins/pre-execute-row.mjs',
  }),
  Object.freeze({
    id: `${LEGION_ROW_PREFIX}approval-answerer`,
    plane: 'host',
    kind: 'answerer',
    purpose: '把审批请求写入审批箱；只有 allowed-once 执行；双段超时 fail closed',
    mount: Object.freeze({ anchor: 'insert', after: 'approval' }),
    registrations: Object.freeze(["ctx.on('approval/request')"]),
    // ⚠️ 同上：静态层没有模块，运行期模块存在。
    module: null,
    runtimeModule: './plugins/approval-answerer-row.mjs',
  }),
  Object.freeze({
    id: `${LEGION_ROW_PREFIX}permission-presets`,
    plane: 'host',
    kind: 'config-override',
    purpose: '用 Legion 自有 preset 表**替换** DSH 默认表（不合并）',
    mount: Object.freeze({ anchor: 'patch-over', target: 'permission' }),
    registrations: Object.freeze(['config.presets']),
    // patch-over **不需要**模块：它按 id 覆盖既有行的 config（`permission` 行本来就在）。
    module: null,
  }),
])

/**
 * 这一行是不是**运行期行**：静态补丁层里装不了（`module: null`），
 * 只能由组合根在**进程内**挂载（`runtimeModule` 是它的真实模块）。
 *
 * ★ 判据必须与「`module` 是 null」分开看：`permission-presets` 那一行的 `module`
 * 也是 `null`，但它**不需要模块**（`patch-over` 按 id 覆盖既有行的 config），
 * 它生效与否的判据是「Legion 的 preset 名解析得到」，不是「有没有挂载」。
 *
 *   > 一个「凡 module 为 null 都按"没挂载"处理」的对账，
 *   > 与一个「把 patch-over 那一行也一起报 ROW_MISSING」的对账，是同一个东西——
 *   > 只不过后者会在真部署上多报一条永远修不掉的红。
 */
export function isRuntimeOnlyRow(row) {
  return row?.module === null && typeof row?.runtimeModule === 'string' && row.runtimeModule !== ''
}

/**
 * 声明里所有**只能进程内挂载**的行 id。
 *
 * 从 `PATCH_LAYER_ROWS` **推导**，不手抄：手抄一份会在补丁层加一行的当天变成假话，
 * 而那份假话只会让读到它的东西"更容易绿"。用例与组合根观察都用它。
 */
export const RUNTIME_ONLY_ROW_IDS = Object.freeze(
  PATCH_LAYER_ROWS.filter((row) => isRuntimeOnlyRow(row)).map((row) => row.id),
)

/** 员工 agent preset（agent 平面，按 session 挂载）。只承载岗位能力，不提供任何服务。 */
export const EMPLOYEE_PRESET_CONTRACT = Object.freeze({
  plane: 'agent',
  mayProvideServices: false,
  mayCarryEnforcement: false,
  carries: Object.freeze(['岗位工具集', 'persona', '提示段', 'skill 引用']),
})

/**
 * 一次组合树扫描结果与补丁层声明的对账。
 *
 * ## 为什么「行在不在」不足以判定生效
 *
 * 行挂上去了但**没激活**（等待某个服务）在组合树里看起来和成功挂载一模一样：
 * 都是「行存在」。DSH 的挂载审计会报 `N row(s) did not activate`，
 * 因此本函数要求调用方提供 `activated` 而不是只看 `present`。
 *
 * 同理，`permission` 行如果被 `patch-over` 覆盖成了 Legion 表，那是覆盖成功；
 * 如果它**根本没被覆盖**（还是 DSH 默认表），行也照样存在，
 * 但 `legion-unattended` 这个 preset 名会解析失败 —— 这才是判据。
 *
 * ## ★★ 运行期行（`module: null` + `runtimeModule`）的证据来源**不是组合树**
 *
 * `pre-execute` / `approval-answerer` 这两行**永远不会**作为 loader 条目出现：
 * 它们在声明里是 `module: null`（YAML 装不了桥与端口），只能由组合根在**进程内**
 * `mount()` 上去——而 Cordis 的 fiber **不是** loader 条目。
 *
 *   > 一个"读一个结构上不可能装着它的地方"的检查，
 *   > 与一个"它真的没装"的检查，给出的是同一条红——
 *   > 只不过只有后者能被接线修好。
 *
 * 所以这两行的判据换成一份**进程内挂载报告**：`observation.inProcessMounted`
 * （由 `plugins/runtime-host-row.mjs` 的 `observeComposition()` 从组合根服务里读出来，
 * 而那份账**只有 `assemble.mjs` 的 `mount()` 写得出来**）。
 *
 * 三件事因此**必须**成立，缺一条这条判据就会退化成恒真的装饰：
 *   ① 报告缺席 / 空 / 形状不对 ⇒ 该行 `ROW_MISSING`（与 `PRESETS_UNOBSERVED` 同一条口径：
 *      「没观察到」不等于「已挂上」）；
 *   ② 报告里**没有**这一行 ⇒ `ROW_MISSING`；
 *   ③ 报告**不能**由"端口装好了"推出来（`enforcementSurfaces()` 那类读数在
 *      `assembleEnforcement()` 一跑就是 true，与有没有 `mount()` 无关）。见
 *      `plugins/runtime-host-row.mjs` 里读那份账的那一段。
 *
 * ## `mountSource`：把"哪个宇宙"写成**字段**，不靠读者自己推
 *
 * 每条 finding 都带 `mountSource`，取值只有四个，都指"这一行的生效证据从哪来"：
 *
 *   · `'loader-entry'`    —— 静态补丁行（`module` 是字符串，或 `patch-over` 那一行）：
 *     证据是组合树里有这一条且已激活；
 *   · `'in-process-mount'` —— 上面说的运行期行：证据是组合根的**挂载账**；
 *   · `'effective-config'` —— `patch-over` 的 preset 表判据：证据是生效的 preset 表内容；
 *   · `null`              —— **没有证据**（`PRESETS_UNOBSERVED`）。
 *
 * 前两者都用 `code: 'OK'` 表示"生效"，但**来源是两个宇宙**：一个在静态补丁文件里、
 * 一个只存在于当前进程。把两者都写成光秃秃的 `OK`，读者就得回去看 `module` 字段
 * 才知道自己读到的是哪一种——而那正是这一批要修掉的那种"看着一样"。
 *
 * @param {{rows?: Array<{id: string, activated?: boolean}>,
 *          permissionPresets?: string[],
 *          inProcessMounted?: string[]}} observation
 *   组合树观察结果（由宿主侧注入，本模块不读文件、不 import DSH）。
 *   `inProcessMounted` 是**运行期行**的进程内挂载报告（行 id 数组）。
 */
export function reconcilePatchLayer(observation = {}) {
  const rows = Array.isArray(observation.rows) ? observation.rows : []
  const byId = new Map(rows.map((r) => [String(r?.id ?? ''), r]))

  /** 进程内挂载报告 → 集合；**没有证据**一律是 `null`（不是空集）。
   *
   *  三件事都算"没有证据"，按未生效处理：不是一个数组、数组里没有可用的行 id、
   *  或者它是一个空数组。空集与 `null` 在这里的行为**一样**是故意的：
   *  两者都表示"没有任何一行被报告为已挂载"——把它们分开只会多一个读者要学的区分。 */
  const inProcessMounted = Array.isArray(observation.inProcessMounted)
    ? observation.inProcessMounted.filter((x) => typeof x === 'string' && x !== '')
    : null
  const mountedInProcess = inProcessMounted !== null && inProcessMounted.length > 0
    ? new Set(inProcessMounted)
    : null

  /** 声明 id → 它**在组合树里的**条目 id。
   *
   *  ★ 这一层映射是必需的，不是防御性写法：`patch-over` 覆盖的是**靶子那一行自己**
   *  （DSH 的语义是「替换目标行的整个 config」），所以它在树里的条目 id 是
   *  `mount.target`（例如 `permission`），**Legion 自己的 id 刻意不出现**。
   *
   *  为什么必须在这里做、不能要求调用方先映射好：
   *  本函数的参数在 JSDoc 里写的是「组合树观察结果」——而**组合树里就是那个靶子 id**。
   *  按声明 id 去查，会为这一行**永远**报 `ROW_MISSING`。
   *
   *    > 一个"按声明的 id 逐行对账"的观察器，与一个"永远对不上账"的观察器，
   *    > 在只看它自己的用例里是同一个东西——因为夹具是照着声明造出来的树。
   *
   *  实测（本函数自己的夹具）：`GOOD_COMPOSITION` 用
   *  `PATCH_LAYER_ROWS.map((r) => ({ id: r.id, activated: true }))` 造行，
   *  而**真实**的树里那一行叫 `permission` ⇒ 夹具造出了一棵现实中不存在的树，
   *  于是这个缺陷在 12 条用例下活了很久。修法必须带一条**真实形状**的树进来。
   *
   *  `insert` 行的条目 id 就是声明 id，所以只有 `patch-over` 需要换。 */
  const treeIdFor = (spec) => (spec?.mount?.anchor === 'patch-over' && typeof spec.mount.target === 'string'
    ? spec.mount.target
    : spec.id)

  const findings = []
  for (const spec of PATCH_LAYER_ROWS) {
    // ── 运行期行：判据是**进程内挂载报告**，不是组合树 ────────────────────────
    //
    // 这两行在声明里 `module: null`，所以它们**不可能**是 loader 条目——按组合树
    // 查它们只会得到一条永远不变的红（见本函数 JSDoc 那一节）。这里刻意**只**看
    // 那份报告：loader 条目里恰好出现了同名行也**不算**（一个部署把运行期行静态
    // 挂进补丁层，与"组合根挂过它"是两件事，修法也不同）。
    if (isRuntimeOnlyRow(spec)) {
      if (mountedInProcess !== null && mountedInProcess.has(spec.id)) {
        findings.push({
          row: spec.id,
          treeId: null,
          code: 'OK',
          effective: true,
          mountSource: 'in-process-mount',
          detail: `行由组合根在**当前进程内**挂载（静态补丁层里没有它：module=null，`
            + `runtimeModule=${spec.runtimeModule}）。它与静态补丁行是**两个不同的来源**`,
        })
      } else {
        findings.push({
          row: spec.id,
          treeId: null,
          code: 'ROW_MISSING',
          effective: false,
          mountSource: 'in-process-mount',
          detail: `声明为运行期行（module=null，runtimeModule=${spec.runtimeModule}），`
            + '而进程内挂载报告里没有它：报告缺席 / 是空的 / 形状不对，或者里面没有这一行。'
            + '「没观察到挂载」不等于「已挂上」，按未生效处理',
        })
      }
      continue
    }

    const treeId = treeIdFor(spec)
    // 兼容两种输入：真实的树（`patch-over` 用靶子 id）与**已按声明重写过 id** 的观察结果
    // （`observeComposition()` 产出的就是后者，见 `runtime/dsh-composition/plugins/runtime-host-row.mjs`）。
    // 先查解析出来的树 id，再退回声明 id；两者都没有才算真的不在树里。
    const hit = byId.get(treeId) ?? (treeId === spec.id ? undefined : byId.get(spec.id))
    if (hit === undefined) {
      findings.push({
        row: spec.id,
        treeId,
        code: 'ROW_MISSING',
        effective: false,
        mountSource: 'loader-entry',
        detail: `补丁层行未出现在组合树中（声明 id：${spec.id}；树条目 id：${treeId}；预期锚点：${spec.mount.anchor}）`,
      })
      continue
    }
    // 行存在但未激活 = 没生效。这一条是 DSH 挂载审计里最容易漏掉的一类：
    // 「等待某服务」的行在树里是**存在**的，但什么也没做。
    if (hit.activated === false) {
      findings.push({
        row: spec.id,
        treeId,
        code: 'ROW_NOT_ACTIVATED',
        effective: false,
        mountSource: 'loader-entry',
        detail: '行已挂载但未激活（等待依赖服务），不产生任何强制效果',
      })
      continue
    }
    findings.push({
      row: spec.id,
      treeId,
      code: 'OK',
      effective: true,
      mountSource: 'loader-entry',
      detail: '行已挂载并激活',
    })
  }

  // preset 表是否真的被替换：判据是**Legion 的 preset 名能否解析**，
  // 而不是「permission 行存不存在」。后者在覆盖失败时同样成立。
  const names = Array.isArray(observation.permissionPresets) ? observation.permissionPresets.map(String) : null
  let presetsFinding
  if (names === null) {
    presetsFinding = {
      row: `${LEGION_ROW_PREFIX}permission-presets`,
      code: 'PRESETS_UNOBSERVED',
      effective: false,
      mountSource: null,
      detail: '未能读到生效的 preset 表；「没观察到」不等于「已替换」，按未生效处理',
    }
  } else {
    const missing = Object.keys(LEGION_PERMISSION_PRESETS).filter((n) => !names.includes(n))
    if (missing.length > 0) {
      presetsFinding = {
        row: `${LEGION_ROW_PREFIX}permission-presets`,
        code: 'PRESETS_NOT_OVERRIDDEN',
        effective: false,
        mountSource: 'effective-config',
        detail: `生效的 preset 表里缺少 Legion 自有项 [${missing.join(', ')}]：patch-over 未生效，仍在用 DSH 默认表`,
      }
    } else {
      presetsFinding = {
        row: `${LEGION_ROW_PREFIX}permission-presets`,
        code: 'OK',
        effective: true,
        mountSource: 'effective-config',
        detail: `Legion preset 表已生效：${names.join(', ')}`,
      }
    }
  }

  const all = [...findings, presetsFinding]
  return {
    patchVersion: DSH_COMPOSITION_PATCH_VERSION,
    effective: all.every((f) => f.effective),
    findings: all,
    reasons: all.filter((f) => !f.effective).map((f) => `${f.row}: ${f.detail}`),
  }
}
