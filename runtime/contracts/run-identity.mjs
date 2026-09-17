// runtime/contracts/run-identity.mjs
// ============================================================================
// PRT-214 缺口②的**搬运形状**：一次 Run 的**授权身份**在契约上长什么样。
//
// ## 缺口是什么
//
// `assembleEnforcement()` 是**进程级、只装一次**的（`root.mjs:351` 的 `let installation`），
// 于是它从 `runtime.env` 读到的 `scope` 是**整个 Runtime 进程**的身份，
// 而 Runtime 进程是**长命的**、会服务很多次 Run、很多个空间。
//
// 一个 Runtime 进程服务多个空间时，别的空间的执行会被盖上**这一个**空间的 `scope`——
// 而它进的是 `canonicalOperationHash`（`enforcement.mjs:86` 的 `CANONICAL_OP_KEYS`），
// 也就是**审批绑定与审计归属**。**不报错，只是错标。**
//
//   > 一个"把甲空间的事记在乙空间名下"的运行时，
//   > 与一个"拒绝执行乙空间任务"的运行时，在"乙空间的任务跑没跑"这个读数上是相反的，
//   > 而在"乙空间的审计还能不能用来追责"上是同一个东西。
//
// hard floor 已经解过**同一类**问题（PRT-214 缺口①）：它的落点是
// 「那个 Run 的目标 Agent 自己的 Cordis 作用域」。身份要走同一条路，
// 所以它也必须先有**能过线的形状**——本模块只做这一件事。
//
// ## ★ 为什么是「覆盖」而不是「完整身份」
//
// 身份里有两类东西，粒度**不一样**，把它们合成一份会掩盖这件事：
//
//   · **随 Run 变的**：`scope`（哪个空间）、`taskId`（哪条任务）、`cwd`（在哪个目录里跑）。
//     这三项的权威在**控制面**：`RunRequest.workspaceId` / `taskId` / `workdir`。
//   · **属于这次安装的**：`actor`（谁负责）与 `action`（哪一类动作）。
//     它们的权威是**部署配置**，不是某一次 Run。
//
// 所以本载荷**只装前者**，`actor` / `action` 一律沿用进程级那一份。这不是省事，
// 而是一条安全判断：`RunRequest` 里**没有任何一个字段**能权威地assert"这次由别人负责"，
// 于是允许它覆盖 `actor` 等于让**审计归属变成请求方自填**——
//
//   > 一个"允许 Run 自带 actor"的载荷，
//   > 与一个"审计里的责任人可以由图省事的调用方指定"的实现，是同一个东西——
//   > 只不过前者的错法是把责任记到一个**别人**头上，而它看起来完全正常。
//
// ## ★ 三种处境必须互相可分（同 `run-floor.mjs` 的理由）
//
//   · `absent`   —— 字段**不在**。这不是"这次没有身份"，而是"没有人给我这次的身份"——
//                   安装点因此回落到**进程级**身份，并把这件事**记下来**
//                   （`state: 'absent'` 是一个读数，不是一句"用默认值"）。
//   · `installed` —— 三个（或更少的）覆盖项形状合法，可以安装。
//   · `refused`  —— 解释不了。修法是**改生产者**，不是"回落到进程级继续跑"：
//                   一次形状读不懂的载荷完全可能是"想覆盖但写错了字段名"，
//                   回落会让它**看起来**成功了。
//
// ## 为什么键集合是闭的（多一个键就拒绝）
//
// 同 `run-floor.mjs`：这一层是**跨进程边界**。对面递来的东西如果带着一个我不认识的
// 字段，我只能猜它是不是更严格的约束——而猜"它是装饰"的代价落在**归属**上。
// 未知键 → 具名拒绝；加字段必须同时改两边，那由契约版本号管。
// ============================================================================

/**
 * 载荷形状或状态语义变化时递增。独立于 Run 契约版本：搬运方式变了不必动 Run 契约。
 */
export const RUN_IDENTITY_WIRE_VERSION = 1

/** 线上字段名。写在一处，免得服务端、适配器与用例各写一遍字符串。 */
export const RUN_IDENTITY_WIRE_FIELD = 'enforcementIdentity'

/**
 * 读取结果的三个状态。**闭集**：调用方要么按名字分流，要么就是在猜。
 *
 * 与 `RUN_IDENTITY_CODES` 分开：状态决定**处置**（装 / 回落 / 拒绝），
 * 码决定**归因**（该改哪一侧）。
 */
export const RUN_IDENTITY_STATES = Object.freeze({
  /** 载荷不在（`undefined`）。**不是**"这次没有身份"。 */
  ABSENT: 'absent',
  /** 形状合法，可以安装。 */
  INSTALLED: 'installed',
  /** 解释不了。修法是改生产者。 */
  REFUSED: 'refused',
})

/** 归因码。闭集：每种修法不同。 */
export const RUN_IDENTITY_CODES = Object.freeze({
  /** 字段不在 RunRequest 上。 */
  NOT_SUPPLIED: 'RUN_IDENTITY_NOT_SUPPLIED',
  /** 载荷不是普通对象（含 `null`：那是"有人打算说，但什么也没说出来"）。 */
  NOT_OBJECT: 'RUN_IDENTITY_NOT_OBJECT',
  /** 版本号不认识。 */
  BAD_VERSION: 'RUN_IDENTITY_BAD_VERSION',
  /** 有我不认识的键。 */
  UNKNOWN_KEY: 'RUN_IDENTITY_UNKNOWN_KEY',
  /** `scope` 不在，或不是非空字符串。 */
  SCOPE_REQUIRED: 'RUN_IDENTITY_SCOPE_REQUIRED',
  /** `taskId` / `cwd` 在，但形状不对。 */
  BAD_FIELD: 'RUN_IDENTITY_BAD_FIELD',
})

/**
 * 载荷允许出现的键。**闭合**：多一个就拒（理由见文件头）。
 *
 * ★ `actor` / `action` **不在**这张表里——它们**不被接受**，而不是"可选"。
 * 一个"接受但通常不用"的字段与一个"根本不接受"的字段，差别在于前者会在某一天
 * 被谁填上，而那一天没有任何东西会红（见文件头那段）。
 */
export const RUN_IDENTITY_PAYLOAD_KEYS = Object.freeze(['version', 'scope', 'taskId', 'cwd'])

/** 身份里**随 Run 变**的那几个字段名（闭集，别的键一律不接受）。 */
export const RUN_IDENTITY_OVERLAY_FIELDS = Object.freeze(['scope', 'taskId', 'cwd'])

/**
 * 适配器交给宿主端口的**已解析**载荷状态（`startRun(provider, {enforcementIdentity})`）。
 *
 * 与线上载荷（`{version, scope, ...}`，控制面产出、`readRunIdentity()` 读）
 * 刻意是两个形状：线上那一份是**判定输入**，这一份是**判定结果**。
 * 两层分开，才有"适配器解释不了、于是原地拒收"的位置——理由与
 * `RUN_FLOOR_PORT_STATES` 那段逐字相同（若端口也去解释线上形状，
 * 一条坏载荷会在两个地方各被解释一次，而两边解释得不一样的那一天
 * 只表现为"这条 Run 的行为跟别的不同"）。
 *
 * ⚠️ `refused` 不在这里：它的处置是**拒收这次 Run**，于是它根本走不到端口——
 * 适配器在起跑前就抛了（`runtime/adapters/dsh/index.mjs`）。
 *
 * ★ 与 floor 的一处**实质差别**：那一份的 `absent` 在安装点上等价于"拒绝一切工具"
 *   （fail closed），所以端口必须能把它与"调用方不支持下限"分开；
 *   这一份的 `absent` 是"沿用进程级身份"——一个**合法**的、接线之前就存在的语义。
 *   两者都要显式交出去，但理由不同：一个是 fail closed 的读数，
 *   一个是"这次没有覆盖"的读数。
 */
export const RUN_IDENTITY_PORT_STATES = Object.freeze({
  /** 有身份覆盖（至少含 `scope`）。 */
  INSTALLED: 'installed',
  /** 没有覆盖（字段缺席）。**不是**空覆盖。 */
  ABSENT: 'absent',
})

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== ''
}

/**
 * 读一份线上的身份载荷。
 *
 * @param {unknown} payload `RunRequest` 上那个字段的值（可能是 `undefined`）
 * @returns {{state: string, overlay: Readonly<object>|null, code: string|null, message: string|null}}
 *   `overlay` **只含**随 Run 变的字段；`actor` / `action` 永远不在这里。
 */
export function readRunIdentity(payload) {
  const refuse = (code, message) => Object.freeze({
    state: RUN_IDENTITY_STATES.REFUSED, overlay: null, code, message,
  })

  // ★ 键**不在**与键**在但是 undefined** 是两件事——但只有前者是"没人给"。
  //   后者（`{enforcementIdentity: undefined}`）在序列化后与前者同形，
  //   所以这里按缺席处理，并在理由里说清楚它是缺席而不是空载荷。
  if (payload === undefined) {
    return Object.freeze({
      state: RUN_IDENTITY_STATES.ABSENT,
      overlay: null,
      code: RUN_IDENTITY_CODES.NOT_SUPPLIED,
      message: '这次 Run 没有带授权身份（`enforcementIdentity` 不在 RunRequest 上）：'
        + '安装点回落到**进程级**身份，并把这次回落记成一个读数',
    })
  }
  if (!isPlainObject(payload)) {
    return refuse(RUN_IDENTITY_CODES.NOT_OBJECT,
      `授权身份载荷必须是对象，收到 ${payload === null ? 'null' : Array.isArray(payload) ? 'array' : typeof payload}。`
      + '`null` **也是**拒绝而不是"没有给"：它是"有人打算说，但什么也没说出来"，'
      + '读成缺席会把一次写坏的生产者洗成一次没人给')
  }
  for (const key of Object.keys(payload)) {
    if (!RUN_IDENTITY_PAYLOAD_KEYS.includes(key)) {
      return refuse(RUN_IDENTITY_CODES.UNKNOWN_KEY,
        `授权身份载荷有我不认识的键 ${JSON.stringify(key)}（只认识 ${RUN_IDENTITY_PAYLOAD_KEYS.join(' / ')}）。`
        + (key === 'actor' || key === 'action'
          ? '★ `actor` / `action` 属于**这次安装**，不接受按 Run 覆盖：'
            + 'RunRequest 里没有任何字段能权威地assert"这次由别人负责"，'
            + '接受它等于让审计归属由请求方自填'
          : '忽略它等于猜它是装饰，而猜错的代价落在**归属**上'))
    }
  }
  if (payload.version !== RUN_IDENTITY_WIRE_VERSION) {
    return refuse(RUN_IDENTITY_CODES.BAD_VERSION,
      `授权身份载荷的 version 是 ${JSON.stringify(payload.version)}，本实现只认识 `
      + `${RUN_IDENTITY_WIRE_VERSION}。滚动升级中途具名拒绝，比装上一份读不懂的覆盖安全`)
  }
  if (!isNonEmptyString(payload.scope)) {
    return refuse(RUN_IDENTITY_CODES.SCOPE_REQUIRED,
      `授权身份载荷的 scope 必须是非空字符串，收到 ${JSON.stringify(payload.scope)}。`
      + '**不回落成进程级的那个 scope**——那正是本次要消灭的错标：'
      + '一份想覆盖、却写坏了空间名的载荷，回落之后会**看起来**成功了')
  }

  const overlay = { scope: payload.scope.trim() }
  for (const field of ['taskId', 'cwd']) {
    const v = payload[field]
    if (v === undefined) continue
    // `null` 在这里**是合法的**：`taskId` 的进程级值本来就允许是 null
    // （`root.mjs:321` 的理由：「进程级装配时常常还没有任务」）。
    // 于是"这次 Run 明确没有任务"必须能表达出来，不能被读成"沿用上一个任务"。
    if (v === null && field === 'taskId') { overlay[field] = null; continue }
    if (!isNonEmptyString(v)) {
      return refuse(RUN_IDENTITY_CODES.BAD_FIELD,
        `授权身份载荷的 ${field} 必须是非空字符串${field === 'taskId' ? '或 null' : ''}，`
        + `收到 ${JSON.stringify(v)}。**不忽略它**：忽略等于沿用进程级那个值，`
        + '而"这次没有这个字段"与"这次的这个字段是别的值"在授权哈希上是两回事')
    }
    overlay[field] = v.trim()
  }

  return Object.freeze({
    state: RUN_IDENTITY_STATES.INSTALLED,
    overlay: Object.freeze(overlay),
    code: null,
    message: null,
  })
}

/**
 * 把一次 Run 的身份覆盖**叠到**进程级上下文上，得到这次调用的有效上下文。
 *
 * 纯函数、无副作用，且**只认白名单里的字段**：一个"把 overlay 整个摊开"的实现
 * 会让载荷里任何一个没被 `readRunIdentity` 过滤掉的键**直接进授权主体**——
 * 而那正是 `SUBJECT_KEYS` 那条"缺一个就抛"的检查会被绕过的地方。
 *
 * @param {object} context 进程级 Legion 上下文（`enforcementContextOf()` 的产物）
 * @param {Readonly<object>|null} overlay `readRunIdentity()` 的 `overlay`
 * @returns {object} 新对象；`overlay` 为 null 时返回**原样**的 context
 */
export function applyIdentityOverlay(context, overlay) {
  if (overlay === null || overlay === undefined) return context
  const out = { ...context }
  for (const field of RUN_IDENTITY_OVERLAY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(overlay, field)) out[field] = overlay[field]
  }
  return out
}

/**
 * 装载期自检：**算出来的产物**，不是一个布尔（同 `run-floor.mjs` 的理由）。
 *
 * 三条读数各自钉着一件会静默失效的事：
 *   · 缺席与"带了一份空载荷"必须是**两个不同的状态**；
 *   · `actor` / `action` 必须**进不来**（它们不是可选，是不接受）；
 *   · `null` 的 `taskId` 必须能表达"这次没有任务"，而不是被当成"没给"。
 */
export const RUN_IDENTITY_CONTRACT_CHECKED = Object.freeze({
  version: RUN_IDENTITY_WIRE_VERSION,
  states: Object.freeze(Object.values(RUN_IDENTITY_STATES)),
  absentState: readRunIdentity(undefined).state,
  nullIsRefused: readRunIdentity(null).state === RUN_IDENTITY_STATES.REFUSED,
  minimalState: readRunIdentity({ version: RUN_IDENTITY_WIRE_VERSION, scope: 's' }).state,
  minimalOverlayScope: readRunIdentity({ version: RUN_IDENTITY_WIRE_VERSION, scope: 's' }).overlay.scope,
  // ★ 这两条是"不接受 actor/action"的判据本身。
  actorRefused: readRunIdentity({ version: RUN_IDENTITY_WIRE_VERSION, scope: 's', actor: 'someone-else' }).code,
  actionRefused: readRunIdentity({ version: RUN_IDENTITY_WIRE_VERSION, scope: 's', action: 'other' }).code,
  // `null` 的 taskId 是合法的覆盖（"这次没有任务"），并且它真的落进 overlay。
  nullTaskIdOverlay: readRunIdentity({ version: RUN_IDENTITY_WIRE_VERSION, scope: 's', taskId: null }).overlay.taskId,
  // 覆盖只碰白名单里的字段。
  overlayKeys: Object.freeze(Object.keys(readRunIdentity({ version: RUN_IDENTITY_WIRE_VERSION, scope: 's' }).overlay).sort()),
  overlaidScope: applyIdentityOverlay({ scope: 'proc', actor: 'a', action: 'b' }, { scope: 'run' }).scope,
  overlayKeepsActor: applyIdentityOverlay({ scope: 'proc', actor: 'a', action: 'b' }, { scope: 'run' }).actor,
})
