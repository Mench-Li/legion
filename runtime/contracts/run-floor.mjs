// runtime/contracts/run-floor.mjs
// ============================================================================
// PRT-214 缺口①的**搬运形状**：Run 的静态 hard floor 在契约上长什么样
//（spec §6.8 line 437-440：控制面「生成 Run 权限档位、静态 hard floor 和动态策略」，
//  → `DshRuntimeAdapter` 安装到目标 Agent/Session）。
//
// ## 为什么这份形状必须住在 `runtime/contracts/`
//
// 「权限档位」那一半早就在 `RunRequest.permissions` 上（preset + tools），而它**过得了
// 两个进程**（worker 造 → `/execute` 的 body → Runtime 进程的适配器），靠的正是
// 本目录里这份契约：`validateRunRequest` 在两处被调（服务端与适配器），
// 于是"能过契约"与"能被解释"在每个进程里是同一句话。
//
// 下限那一半此前**没有形状**：`bootstrapDshRuntime({floor})` 从第一天起就接受一份
// 装配级的下限，而它只能由**本进程**的补丁层/装配方给出——一个 Run 的下限**根本
// 没有一条路**从控制面走到执行面的那个进程里。
//
//   > 一个"装配期塞进去、于是全进程只有一个"的下限，
//   > 与一个"每个 Run 各有一份、但只能用进程内变量传"的下限，
//   > 在只有一个 Run 的那些用例里是同一个东西——
//   > 只不过前者会让第二个 Run 继承第一个 Run 的规则。
//
// 所以下限必须先有**能过线的形状**，才谈得上"按 Run 安装"。本模块只做这一件事：
// 读一份线上下限载荷，判定它是「没有给」「给清楚了」「解释不了」三者中的哪一个。
// 判定逻辑（guard）不在这里，安装点也不在这里。
//
// ## ★ 三种处境必须互相可分（本模块存在的全部理由）
//
// 生产侧（`team-hub/run-floor.mjs`）已经把一个区别做出来了：派生不出来时
// `derived === false` 且 **`floor === null`**，而不是给一个空数组。这条区别如果在
// 搬运时被抹平，代价是**没有告警的**：
//
//   > 一个"派生出来的空下限"，
//   > 与一个"这次没有任何东西该被禁止"，
//   > 在空数组这个读数上是同一个东西——
//   > 只不过前者意味着强制面整段不在，而没有任何人会收到告警。
//
// 于是三个状态各有名字与修法：
//
//   · `absent`   —— 字段**不在**。这是"没有人给我下限"，不是"没有东西要禁止"。
//                   它**不许**被折叠成空下限，也**不许**被折叠成一份按名字禁的名单：
//                   安装点（`runtime/dsh-composition/run-floor.mjs`）按 spec §6.8 `:479`
//                   的**发布前姿态**拒绝一切工具调用——因为静态下限比的是**执行面的
//                   工具名**，而 Legion 派生出来的名单写的是 Legion 的**能力名**，
//                   两个名字空间不相交，按名字装进来一个真工具名都拦不住。
//                   **名字名单不是 fail closed**（不在名单里的一律放行）。
//   · `installed` —— `derived === true` 且 `floor` 是一份形状合法的对象。
//                   **空数组在这里是合法的**：它是"派生了、而这次确实没有东西该被禁止"
//                   这个**陈述**，与上面的 absent 是两件事。
//   · `refused`  —— 解释不了（不是对象 / 版本不认识 / 有我不认识的键 / `derived` 不是
//                   true / 形状不对 / 名字或前缀不是非空字符串）。
//                   修法是**改生产者**，不是"补一个空下限继续跑"。
//
// ## 为什么键集合是闭的（多一个键就拒绝）
//
// 这一层是**跨进程边界**：对面递过来的东西如果带着一个我不认识的字段，我只能猜它
// 是不是更严格的约束。猜"它是装饰"的代价恰好落在安全侧：
//
//   > 一个"忽略自己不认识的字段"的解析器，
//   > 与一个"把更严格的下限静默降级成默认"的解析器，是同一个东西——
//   > 只不过前者在载荷多一个键的那天开始说谎。
//
// 所以未知键 → `UNKNOWN_KEY` 具名拒绝。代价是加字段必须同时改两边，而那是**有意的**：
// 契约版本（`RUN_FLOOR_WIRE_VERSION`）就是为这件事存在的。
//
// ## `null` 为什么也是拒绝而不是"没有给"
//
// `undefined`（键不在）与 `null`（键在、值是空的）在 JS 里长得像，含义却相反：
// 前者是"没人说过下限"，后者是"有人打算说，但什么也没说出来"——而生产侧的
// `floor: null` 恰恰是**派生失败**的那个读数。把它读成"没有给"会把一次失败
// 洗成一次缺席。所以 `null` → `NOT_OBJECT` 具名拒绝。
// ============================================================================

/**
 * 载荷形状或状态语义变化时递增。它**独立于**契约版本：搬运方式变了不必动 Run 契约。
 *
 * ★ 1 → 2（PRT-214 第二步）：**`denyTools` 里那些字符串的名字空间变了**。
 *
 * 载荷的形状一个字节都没变（还是 `{version, derived, floor:{denyTools,...}}`），
 * 变的是 `denyTools` 每一项**指的到底是什么**：以前是 **Legion 能力名**
 * （`git-push` / `delete-file`），现在是**执行面（DSH）工具名**（`bash` / `pwsh`）。
 * 这正是本条注释说的"状态语义变化"，所以它必须动。
 *
 *   > 一个"形状没变就不动版本号"的约定，
 *   > 与一个"升级完 Runtime 之后，老 worker 递过来的名单里全是执行面上
 *   > 不存在的名字、而新 Runtime 照单全收"的约定，是同一个东西——
 *   > 只不过前者会让这次升级**看起来**是成功的，而下限一个真工具都没拦住。
 *
 * 递增的代价是有意写进契约的（见文件头「为什么键集合是闭的」）：新旧两侧必须
 * 一起升，滚动升级中途会**具名拒绝**而不是静默地装上一份拦不住东西的名单。
 *
 * ★ 2 → 3（PRT-214 续）：**载荷多了一个键 `notices`**。
 *
 * 这一版升的是**形状**，与 1 → 2 那次升的**语义**不同，但按本条注释的口径两者
 * 都算（"形状或状态语义变化"）。加键这件事本来就归这个号管——见文件头那句
 * 「加字段必须同时改两边，而那是**有意的**：契约版本就是为这件事存在的」。
 *
 *   > 一个"键集合是闭的、所以加字段不必升版本号"的推论，
 *   > 与一个"老读者会把新载荷整个拒掉、于是滚动升级中途每一个 Run 都停住"
 *   > 的事实，是同一个东西——只不过前者以为闭集已经保证了安全，
 *   > 而安全与**可用**是两件事：版本号让"拒掉"这件事**可归因**，
 *   > 而不是让值班的人先怀疑是不是自己配错了。
 *
 * `notices` 跨线的理由见 `RUN_FLOOR_PAYLOAD_KEYS` 那段：成功的派生没有失败可以搭车。
 */
export const RUN_FLOOR_WIRE_VERSION = 3

/** 线上字段名。写在一处，免得服务端、适配器与用例各写一遍字符串。 */
export const RUN_FLOOR_WIRE_FIELD = 'enforcementFloor'

/**
 * 读取结果的三个状态。**闭集**：调用方要么按名字分流，要么就是在猜。
 *
 * 与 `RUN_FLOOR_CODES` 分开：状态决定**处置**（装 / 拒绝 / 按缺席处理），
 * 码决定**归因**（该改哪一侧）。合成一个字段会让"这次为什么被拒"退化成一句出错了。
 */
export const RUN_FLOOR_STATES = Object.freeze({
  /** 载荷不在（`undefined`）。**不是**"空下限"。 */
  ABSENT: 'absent',
  /** 形状合法，可以安装（**允许**是空的：那是"这次没有东西要禁止"这个陈述）。 */
  INSTALLED: 'installed',
  /** 解释不了。**不安装**，也**不**降级成空下限。 */
  REFUSED: 'refused',
})

/**
 * 拒绝码闭集。每种拒绝的修法不同，所以每种一个码。
 *
 * `NOT_SUPPLIED` 是**状态码而不是错误码**：它同时是 `absent` 状态在 guard 拒绝理由里
 * 的那个名字（"这次 Run 没有下限"要被看得见、能被日志检索），而它**不**出现在
 * `refused` 的 `errors` 里——缺席不是载荷的错误。
 */
export const RUN_FLOOR_CODES = Object.freeze({
  /** 没有给下限。**不许**当成空下限（见文件头）。 */
  NOT_SUPPLIED: 'RUN_FLOOR_NOT_SUPPLIED',
  /** 载荷不是普通对象（含 `null`、数组、字符串）。 */
  NOT_OBJECT: 'RUN_FLOOR_NOT_OBJECT',
  /** `version` 不是本模块认识的那一版。 */
  VERSION_UNSUPPORTED: 'RUN_FLOOR_VERSION_UNSUPPORTED',
  /** 载荷（或 `floor`）里有本模块不认识的键。见文件头"为什么键集合是闭的"。 */
  UNKNOWN_KEY: 'RUN_FLOOR_UNKNOWN_KEY',
  /** `derived` 不是 `true`（含 `false`、缺失，以及 `floor: null`）——**派生失败**。 */
  NOT_DERIVED: 'RUN_FLOOR_NOT_DERIVED',
  /** `floor` 不是普通对象，或 `denyTools` / `denyPathPrefixes` / `cwd` / `platform` 形态不对。 */
  BAD_SHAPE: 'RUN_FLOOR_BAD_SHAPE',
  /** `denyTools` 里有一条不是非空字符串。 */
  BAD_TOOL_NAME: 'RUN_FLOOR_BAD_TOOL_NAME',
  /** `denyPathPrefixes` 里有一条不是非空字符串。 */
  BAD_PATH_PREFIX: 'RUN_FLOOR_BAD_PATH_PREFIX',
  /** `notices` 不是数组，或其中一条的形状不对。 */
  BAD_NOTICE: 'RUN_FLOOR_BAD_NOTICE',
})

// ★ 这里**没有**"前缀规范化不幂等"那个码，尽管生产侧确实在查它
//（`team-hub/run-floor.mjs` 的 `PATH_PREFIX_NOT_IDEMPOTENT`）。
// 理由是这个判定做不到、而且**不归这一层做**：它需要 `canonicalizePath`，
// 而那个函数住在执行面的 `runtime/dsh-composition/enforcement.mjs` 里；
// 让 `runtime/contracts/` 依赖执行面的模块，会把"过线的形状"与"执行面怎么归一"
// 绑成一件事——而这一层的全部价值恰恰是**不依赖执行引擎**就能被穷举。
// 幂等性在派生点（有规范化函数的那一侧）检查；这一层只检查"是不是非空字符串"。
// 一个声明了却没有任何代码会产生的拒绝码，比没有这个码更坏：它让读者以为查过了。

/**
 * 载荷允许出现的键，**逐字**。多一个就 `UNKNOWN_KEY`。
 *
 * ## 为什么 `refusals` 与 `notices` 都在这里，而它们的**读者**不同
 *
 *   · `refusals` —— 派生**失败**时的归因码。它跨线是为了让远端读得出"为什么没有下限"，
 *     但它在**本进程内**已经有一个更近的读者：`executor.mjs` 的 `execute()` 拿它
 *     拼出那次具名拒绝（`RUN_FLOOR_NOT_DERIVED`）。所以这一层只放行、不解析它。
 *   · `notices` —— 下限**装上去之后仍然成立**的告诫（连带禁止、政策禁令落不了地）。
 *     它没有"失败"可以搭车：派生是成功的、Run 会照跑，所以**载荷是它唯一的载体**。
 *     因此本层既放行、**也解析**（见下面 `notices` 那一段），好让安装点读到它。
 *
 *   > 一个"把告诫挂在一次成功派生的旁边、而没有任何人读"的下限，
 *   > 与一个"根本没产生这条告诫"的下限，在库里和日志里是同一个东西——
 *   > 只不过前者会让人以为"连带禁止这件事有人知道"。
 */
export const RUN_FLOOR_PAYLOAD_KEYS = Object.freeze([
  'version',
  'derived',
  'floor',
  'runId',
  'refusals',
  'notices',
])

/**
 * 一条告诫（notice）允许出现的键，**逐字**。多一个就 `BAD_NOTICE`。
 *
 * 为什么 `message` 也跨线（而 `refusals` 只跨码）：拒绝码是给**程序**分流的，
 * 而告诫是给**人**看的——"为了拦一个推送而关掉了整个 shell"这句话的措辞
 * 由知道原因的那一侧（派生点）写，安装点只负责把它记下来。
 * 让安装点按码现场拼一句话，等于把同一条告诫的措辞抄成两份。
 */
export const RUN_FLOOR_NOTICE_KEYS = Object.freeze([
  'code', 'tool', 'message', 'dshTools', 'collateral',
])

/**
 * 适配器交给宿主端口的**已解析**载荷状态（`startRun(provider, {enforcementFloor})`）。
 *
 * 与线上载荷（`{version, derived, floor, ...}`，控制面产出、`readRunFloor()` 读）
 * 刻意是两个形状：线上那一份是**判定输入**，这一份是**判定结果**。
 * 两层分开，才有"适配器解释不了、于是原地拒收"的位置——若端口也去解释线上形状，
 * 一条坏载荷会在两个地方各被解释一次，而两边解释得不一样的那一天
 * 只表现为"这条 Run 的行为跟别的不同"。
 *
 * ⚠️ `refused` 不在这里：`refused` 的处置是**拒收这次 Run**，于是它根本走不到端口——
 * 适配器在起跑前就抛了（`runtime/adapters/dsh/index.mjs`）。端口只可能收到
 * "有下限"或"没有下限"这两种。
 */
export const RUN_FLOOR_PORT_STATES = Object.freeze({
  /** 有下限（**允许为空数组**：那是"这次没有东西要禁止"这个陈述）。 */
  INSTALLED: 'installed',
  /** 没有下限（字段缺席）。**不是**空下限。 */
  ABSENT: 'absent',
})

/** `floor` 允许出现的键，**逐字**。这就是 `createHardFloorGuard()` 消费的那四个。 */
export const RUN_FLOOR_FLOOR_KEYS = Object.freeze([
  'denyTools',
  'denyPathPrefixes',
  'cwd',
  'platform',
])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * 冻结的读取结果。调用方按 `state` 分流，按 `code` 归因。
 *
 * `notices` 默认是**空数组**而不是 `null`：它是"这次有几条告诫"的读数，
 * 而 `absent` / `refused` 两档**根本没有**"有几条告诫"这回事——
 * 用空数组统一表示"没有告诫要报"，比让调用方在两处判 `null` 更不容易漏。
 * 只有 `installed` 那一档会把它填成派生点真正产出的那些。
 */
function result(state, { code = null, message = null, floor = null, runId = null, notices = [], errors = [] } = {}) {
  return Object.freeze({
    state,
    code,
    message,
    floor,
    runId,
    notices: Object.freeze([...notices]),
    errors: Object.freeze([...errors]),
  })
}

/**
 * 读一份线上下限载荷。
 *
 * **纯函数、零 IO、零 Cordis/DSH 依赖**——与 `validateRunRequest` 同一条纪律：
 * 这条判定要能在不启动任何执行引擎的环境里被穷举（三种状态 × 九种拒绝）。
 *
 * @param {unknown} payload `RunRequest` 上那个字段的值（原样，不做预处理）
 * @param {{field?: string}} [o] `field` 只影响错误文案里的字段名
 * @returns {{state: string, code: string|null, message: string|null,
 *            floor: object|null, runId: string|null,
 *            notices: readonly object[], errors: string[]}}
 */
export function readRunFloor(payload, { field = RUN_FLOOR_WIRE_FIELD } = {}) {
  if (payload === undefined) {
    return result(RUN_FLOOR_STATES.ABSENT, {
      code: RUN_FLOOR_CODES.NOT_SUPPLIED,
      message: `${field} 不在这次 RunRequest 上：这是一次**没有下限**的 Run，`
        + '不是一次"没有任何东西该被禁止"的 Run。安装点必须把这两件事分开处理。',
    })
  }

  const refuse = (code, message) => result(RUN_FLOOR_STATES.REFUSED, {
    code,
    message,
    errors: [`${field} 无法解释（${code}）：${message}`],
  })

  if (!isPlainObject(payload)) {
    return refuse(RUN_FLOOR_CODES.NOT_OBJECT,
      `${field} 必须是对象，收到 ${payload === null ? 'null' : Array.isArray(payload) ? 'array' : typeof payload}。`
      + '**`null` 不是"没有给"**：它是"有人打算说、却什么也没说出来"，'
      + '而生产侧的 `floor: null` 恰恰是派生失败的那个读数——把它读成缺席会把一次失败洗成一次没有')
  }

  for (const key of Object.keys(payload)) {
    if (!RUN_FLOOR_PAYLOAD_KEYS.includes(key)) {
      return refuse(RUN_FLOOR_CODES.UNKNOWN_KEY,
        `${field} 上有我不认识的键 ${JSON.stringify(key)}（只认识 ${RUN_FLOOR_PAYLOAD_KEYS.join(' / ')}）。`
        + '忽略不认识的键就等于猜它是装饰，而猜错的代价落在安全侧')
    }
  }

  if (payload.version !== RUN_FLOOR_WIRE_VERSION) {
    return refuse(RUN_FLOOR_CODES.VERSION_UNSUPPORTED,
      `${field}.version 是 ${JSON.stringify(payload.version)}，本实现只认识 ${RUN_FLOOR_WIRE_VERSION}。`
      + '版本对不上说明对端按另一版协议说话——按它解释出来的下限可能比它以为的宽')
  }

  if (payload.derived !== true) {
    return refuse(RUN_FLOOR_CODES.NOT_DERIVED,
      `${field}.derived 是 ${JSON.stringify(payload.derived)}（要求 true）：这次 Run 的下限**没有被派生出来**。`
      + '派生的失败原因由生产方列在 refusals 里；**不在这里补一份空下限**——'
      + '一个"派生出来的空下限"与一个"这次没有任何东西该被禁止"在空数组上是同一个读数，'
      + '只不过前者意味着强制面整段不在')
  }

  const floor = payload.floor
  if (!isPlainObject(floor)) {
    return refuse(RUN_FLOOR_CODES.BAD_SHAPE,
      `${field}.floor 必须是对象，收到 ${floor === null ? 'null' : Array.isArray(floor) ? 'array' : typeof floor}`)
  }
  for (const key of Object.keys(floor)) {
    if (!RUN_FLOOR_FLOOR_KEYS.includes(key)) {
      return refuse(RUN_FLOOR_CODES.UNKNOWN_KEY,
        `${field}.floor 上有我不认识的键 ${JSON.stringify(key)}（只认识 ${RUN_FLOOR_FLOOR_KEYS.join(' / ')}）`)
    }
  }
  if (!Array.isArray(floor.denyTools)) {
    return refuse(RUN_FLOOR_CODES.BAD_SHAPE, `${field}.floor.denyTools 必须是数组，收到 ${typeof floor.denyTools}`)
  }
  const denyTools = []
  for (const raw of floor.denyTools) {
    const name = nonEmptyString(raw)
    if (name === null) {
      return refuse(RUN_FLOOR_CODES.BAD_TOOL_NAME,
        `${field}.floor.denyTools 里有一条不是非空字符串：${JSON.stringify(raw === undefined ? 'undefined' : String(raw).slice(0, 128))}`)
    }
    if (!denyTools.includes(name)) denyTools.push(name)
  }
  if (!Array.isArray(floor.denyPathPrefixes)) {
    return refuse(RUN_FLOOR_CODES.BAD_SHAPE, `${field}.floor.denyPathPrefixes 必须是数组，收到 ${typeof floor.denyPathPrefixes}`)
  }
  const denyPathPrefixes = []
  for (const raw of floor.denyPathPrefixes) {
    const prefix = nonEmptyString(raw)
    if (prefix === null) {
      return refuse(RUN_FLOOR_CODES.BAD_PATH_PREFIX,
        `${field}.floor.denyPathPrefixes 里有一条不是非空字符串：${JSON.stringify(raw === undefined ? 'undefined' : String(raw).slice(0, 128))}`)
    }
    denyPathPrefixes.push(prefix)
  }
  // `cwd` 可以缺席：生产方在没给 cwd 时就是缺席，而它的**全部前缀都是绝对路径**
  //（生产方在派生时就用同一个规范化函数拒了相对路径），所以 cwd 不参与前缀匹配。
  // 它只在"某次调用的参数是相对路径"时被 guard 用到，而那时 guard 会因为规范化
  // 失败而**拒绝**（fail closed）——缺席不会把下限放宽，只会让相对路径的调用被拒。
  if (floor.cwd !== undefined && floor.cwd !== null && nonEmptyString(floor.cwd) === null) {
    return refuse(RUN_FLOOR_CODES.BAD_SHAPE, `${field}.floor.cwd 给了，但不是非空字符串（收到 ${typeof floor.cwd}）`)
  }
  // `platform` **必须给**：它决定路径匹配是否做大小写归并（`canonicalizePath` 只对
  // win32 归并）。缺席时由运行时进程自己补一个 `process.platform` 看着无害——两个
  // 进程在同一台机器上——但那时"控制面说了"与"我们猜的和它一样"就成了同一个读数，
  // 而它们下一次分岔的地方正是**大小写**：`C:\Work` 与 `c:\work` 在 win32 上是同一个
  // 目录，在别的平台规则下不是。所以这里要求它显式给。
  if (nonEmptyString(floor.platform) === null) {
    return refuse(RUN_FLOOR_CODES.BAD_SHAPE,
      `${field}.floor.platform 必须是非空字符串（收到 ${JSON.stringify(floor.platform)}）：`
      + '它决定路径匹配是否做大小写归并，缺席时"控制面说了"与"我们猜的一样"会长得一模一样')
  }

  const runId = payload.runId === undefined || payload.runId === null ? null : String(payload.runId)

  // ── 告诫（`notices`）─────────────────────────────────────────────────────
  //
  // 形状不对就**具名拒绝**，而不是"忽略这条读不懂的告诫继续装"。
  // 理由是这条载荷的下限本身仍然可用，所以"忽略"看起来无害——但告诫的全部
  // 价值就是它会被读到：
  //
  //   > 一个"读不懂就跳过"的告诫解析器，与一个"把这条告诫变成不存在"的解析器，
  //   > 是同一个东西——只不过前者在载荷多写坏一个字段的那天开始说谎。
  //
  // 缺席（`undefined`）是**合法**的：它的意思是"这次派生没有任何告诫"，
  // 与"有告诫但读不出来"必须分开。空数组同理，是"派生了、这次没有告诫"。
  let notices = Object.freeze([])
  if (payload.notices !== undefined) {
    if (!Array.isArray(payload.notices)) {
      return refuse(RUN_FLOOR_CODES.BAD_NOTICE,
        `${field}.notices 必须是数组，收到 ${payload.notices === null ? 'null' : typeof payload.notices}`)
    }
    const out = []
    for (const raw of payload.notices) {
      if (!isPlainObject(raw)) {
        return refuse(RUN_FLOOR_CODES.BAD_NOTICE, `${field}.notices 里有一条不是对象`)
      }
      for (const key of Object.keys(raw)) {
        if (!RUN_FLOOR_NOTICE_KEYS.includes(key)) {
          return refuse(RUN_FLOOR_CODES.BAD_NOTICE,
            `${field}.notices 里有一条带了我不认识的键 ${JSON.stringify(key)}`
            + `（只认识 ${RUN_FLOOR_NOTICE_KEYS.join(' / ')}）`)
        }
      }
      if (nonEmptyString(raw.code) === null) {
        return refuse(RUN_FLOOR_CODES.BAD_NOTICE, `${field}.notices 里有一条没有可读的 code`)
      }
      if (nonEmptyString(raw.tool) === null) {
        return refuse(RUN_FLOOR_CODES.BAD_NOTICE,
          `${field}.notices 里有一条没有点名是哪个工具：一条说不出它关于什么的告诫没法被处理`)
      }
      if (nonEmptyString(raw.message) === null) {
        return refuse(RUN_FLOOR_CODES.BAD_NOTICE, `${field}.notices 里有一条没有可读的 message`)
      }
      const lists = {}
      for (const key of ['dshTools', 'collateral']) {
        const v = raw[key] === undefined ? [] : raw[key]
        if (!Array.isArray(v)) {
          return refuse(RUN_FLOOR_CODES.BAD_NOTICE, `${field}.notices 里的 ${key} 必须是数组`)
        }
        const names = []
        for (const n of v) {
          const name = nonEmptyString(n)
          if (name === null) {
            return refuse(RUN_FLOOR_CODES.BAD_NOTICE, `${field}.notices 里的 ${key} 有一条不是非空字符串`)
          }
          if (!names.includes(name)) names.push(name)
        }
        lists[key] = Object.freeze(names)
      }
      out.push(Object.freeze({
        code: raw.code, tool: raw.tool, message: raw.message,
        dshTools: lists.dshTools, collateral: lists.collateral,
      }))
    }
    notices = Object.freeze(out)
  }

  return result(RUN_FLOOR_STATES.INSTALLED, {
    code: null,
    notices,
    floor: Object.freeze({
      denyTools: Object.freeze(denyTools),
      denyPathPrefixes: Object.freeze(denyPathPrefixes),
      // 缺席就**如实缺席**（`undefined`），不写成空串：空串是一个"有值"的读数，
      // 而 `canonicalizePath('')` 会退化成"以 / 开头"这类靠巧合成立的东西。
      cwd: floor.cwd === undefined || floor.cwd === null ? undefined : floor.cwd,
      platform: floor.platform,
    }),
    runId,
  })
}

/**
 * 装载期自检。导出的是**算出来的产物**，不是一个布尔 ok：
 * 一个布尔可以被"删掉整段自检"的那一处补丁伪造。
 *
 * 三条读数各自钉着一件会静默失效的事：
 *   · `absent` 与 `installed`（空）**必须不同状态**——否则文件头那条区别在第一天就没了；
 *   · `null` 必须 `refused` 而不是 `absent`——否则"派生失败"会变成"没有给"；
 *   · 未知键必须 `refused`——否则"我不认识的更严格约束"会被静默降级。
 *
 * 第四条（`notices` 那一版）钉的是**告诫**：一条读不懂的告诫必须 `refused`，
 * 因为"跳过它继续装"与"这条告诫不存在"在读端是同一个东西。
 * `noticesAbsentIsEmpty` 是对照：**缺席是合法的**（"这次没有告诫"），
 * 于是"拒绝"这一档说的确实是"读不懂"，不是"没给"。
 */
export const RUN_FLOOR_CONTRACT_CHECKED = Object.freeze({
  version: RUN_FLOOR_WIRE_VERSION,
  absentState: readRunFloor(undefined).state,
  // 空下限是**合法**的，而且是 `installed`——这正是它与 absent 的分界
  emptyFloorState: readRunFloor({
    version: RUN_FLOOR_WIRE_VERSION, derived: true,
    floor: { denyTools: [], denyPathPrefixes: [], platform: 'linux' },
  }).state,
  nullRefusedWith: readRunFloor(null).code,
  unknownKeyRefusedWith: readRunFloor({ version: RUN_FLOOR_WIRE_VERSION, derived: true, floor: { denyTools: [], denyPathPrefixes: [], platform: 'linux' }, extra: 1 }).code,
  notDerivedRefusedWith: readRunFloor({ version: RUN_FLOOR_WIRE_VERSION, derived: false, floor: null }).code,
  // 告诫：读不懂 → 具名拒绝；缺席 → 合法的空（不是拒绝）。
  badNoticeRefusedWith: readRunFloor({
    version: RUN_FLOOR_WIRE_VERSION, derived: true,
    floor: { denyTools: [], denyPathPrefixes: [], platform: 'linux' },
    notices: [{ code: 'x' }],
  }).code,
  noticesAbsentIsEmpty: readRunFloor({
    version: RUN_FLOOR_WIRE_VERSION, derived: true,
    floor: { denyTools: [], denyPathPrefixes: [], platform: 'linux' },
  }).notices.length,
  states: Object.freeze(Object.values(RUN_FLOOR_STATES)),
  codes: Object.freeze(Object.values(RUN_FLOOR_CODES)),
})
