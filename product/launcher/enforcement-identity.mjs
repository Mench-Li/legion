// product/launcher/enforcement-identity.mjs
// ============================================================================
// 把 Legion 的身份**注入 Runtime 子进程**（PRT-214 续：组合根的生产调用方的输入）
//
// ## 这个文件补的是哪一截
//
// `runtime/dsh-composition/root.mjs` 的组合根要求六项输入（hub 地址 / actor /
// scope / action / cwd / 可选 taskId），而它们**只从进程环境读**——
// 组合根刻意不读配置文件、不给默认值。于是有一个必须回答的问题：
// **在一个真实部署里，是谁把这几项放进 DSH Runtime 的环境的？**
//
// 在本文件之前：没有人。所以即使 root-row 挂进了补丁层，它也会以
// `CONFIG_MISSING` 拒绝——而那条拒绝出现在 DSH 进程里，离"产品配置少了什么"很远。
//
//   > 一个"配置从环境来"的组合根，与一个"没有任何东西往环境里放配置"的装配，
//   > 在部署上是同一个东西——只不过前者的接口写得清清楚楚。
//
// ## 三项来源，每一项都必须说得出出处
//
// 1. **派生值**（`derived`）——Launcher 是唯一知道这两件事的进程：
//    · `TEAM_HUB_URL` ← `http://127.0.0.1:<本次启动的 team-hub 端口>`。
//      与 workbench 的 `DSH_HUB_UPSTREAM` **同一条理由**（`launcher.mjs`
//      那段注释是实测出来的）：让每个进程按各自的默认值去猜，会在端口被改掉时
//      静默指向**另一个** hub。所以这里也不接受配置覆盖。
//    · `LEGION_CWD` ← Runtime 进程计划里的 `cwd`（`supervisor.mjs` 用它当 `spawn` 的
//      `cwd`）。这不是"猜一个工作目录"，就是那个进程真正的工作目录。
//
// 2. **配置值**（`config`）——`runtime.env`（`product/config.mjs` 的既有键：
//    「注入 Runtime 子进程的额外环境变量（不含密钥）」）。
//    `actor` / `scope` / `action` / `taskId` 只能从这里来：
//    **本批次找不到任何权威来源**，所以不发明一个——没有就是没有，
//    由下面的判据拦下并说清该往哪里写。
//
// 3. **没有来源** → `ENFORCEMENT_IDENTITY_MISSING`，**拦启动**。
//
// ## 为什么"缺身份"要拦启动，而不是报个 warn
//
// 与 `dsh-overlay.mjs` 的 `PATCH_FILE_MISSING` 是**同一条判据**：
// 强制面是被要求装上的（`runtime.enforcementOverlay` 默认 true），而它现在装不上。
// 只报 warn 的话，得到的是一个"看起来装了强制面"的部署；而它要么在 DSH 进程里
// 以一条**别处**的错误收场（用户会去查 runtime 为什么起不来），
// 要么更糟——DSH 把补丁行 warn-and-skip 掉，运行时照常起来，强制面为零。
//
//   > 一个"启动时报错的强制面"，与一个"运行时不存在的强制面"，
//   > 在事故复盘里是两件完全不同的事；而在"产品起没起来"这一个读数上，
//   > 它们长得很像。
//
// ## 关掉时**刻意沉默**
//
// `enabled === false` 时本模块不产出任何诊断。理由不是"少说少错"：
// 关掉这件事**已经**由 `resolveDshOverlay()` 的 `DSH_OVERLAY_DISABLED_BY_CONFIG`
// 说了一次。再说一次会让"同一件事有两个判定点"，
// 而两份口径总有一天会不一致（一条说关掉了，另一条说缺 actor）。
//
// ## 与另外那两个键的关系：`LEGION_APPROVAL_POLICY` / `LEGION_ATTENDED`
//
// `root-row.mjs` 的 `decide` 适配器还要这两项（session 级的审批策略与"现场有没有人"）。
// 本模块**不**给它们派生值，也**不**把它们列进必填——它们同样只能经 `runtime.env` 来。
// 理由：Launcher 是进程监督者，它没有"现场有没有人"这个事实的任何来源；
// 编一个默认值正是 `product/` 里反复写下的那条禁令。
// 缺了它们时 `decide` 在**判定期**抛具名码，由 `createPreExecutePolicy`
// 接成 **deny（fail closed）**——只影响需要人的调用，不影响只读调用。
// ============================================================================

/** 改动环境变量名或来源时递增。 */
export const ENFORCEMENT_IDENTITY_VERSION = 1

/**
 * 字段 → 注入 Runtime 子进程时用的环境变量名。
 *
 * ★ 必须与 `runtime/dsh-composition/root.mjs` 的 `ENFORCEMENT_CONFIG_FIELDS`
 *   的 `envKeys` 逐字相同。`product/` **不能** import 那个模块（依赖方向：
 *   `runtime/dsh-composition/` 才 import `product/`，反之会把生成器与
 *   `product/launcher/` 缠在一起），所以两处是**同一份事实的两个副本**——
 *   由 `enforcement-identity.test.mjs` 的一条用例逐项钉住。
 *
 *   > 一个"注入端与读取端各写一遍键名、而没有任何判据说它们相同"的接线，
 *   > 与一个"注入了一个没人读的变量"的接线，在运行时的表现完全一样——
 *   > 只不过前者的代码看起来是通的。
 */
export const ENFORCEMENT_IDENTITY_ENV = Object.freeze({
  hubUrl: 'TEAM_HUB_URL',
  actor: 'LEGION_ACTOR',
  scope: 'LEGION_SCOPE',
  action: 'LEGION_ENFORCEMENT_ACTION',
  cwd: 'LEGION_CWD',
  taskId: 'LEGION_TASK_ID',
})

/**
 * 组合根**要求**的字段（`root.mjs` 的 `REQUIRED_ENFORCEMENT_CONFIG`）。
 * 顺序逐字相同：两边对"缺了什么"必须给出同一份清单。
 * `taskId` 不在里面——组合根允许它是 `null`（进程级装配时常常还没有任务）。
 */
export const ENFORCEMENT_IDENTITY_REQUIRED = Object.freeze([
  'hubUrl', 'actor', 'scope', 'action', 'cwd',
])

/**
 * `decide` 适配器要的两项（`runtime/dsh-composition/plugins/root-row.mjs`
 * 的 `DECIDE_ENV_KEYS`）。**可选**：见文件头最后一段。
 */
export const ENFORCEMENT_DECIDE_ENV_KEYS = Object.freeze([
  'LEGION_APPROVAL_POLICY', 'LEGION_ATTENDED', 'LEGION_PERMISSION_PRESET',
])

export const ENFORCEMENT_IDENTITY_CODES = Object.freeze({
  /** 被要求装上（`runtime.enforcementOverlay !== false`），而有字段没有来源。**拦启动**。 */
  IDENTITY_MISSING: 'ENFORCEMENT_IDENTITY_MISSING',
})

/** 只有这个进程吃这几项。与 `DSH_OVERLAY_PROCESS_KEY` 是同一个进程。 */
export const ENFORCEMENT_IDENTITY_PROCESS_KEY = 'runtime'

/**
 * **强制面的表**——与上面两组**不同的一类**，但同样只能来自产品配置
 * `runtime.env`（第 113 轮补上）。
 *
 * ## 为什么它们需要一个自己的清单，而不是塞进上面两组
 *
 * 上面两组回答的是"**这个运行时以谁的名义做事**"（身份）与"**要不要问人**"
 * （审批策略）。这一组回答的是"**这个岗位被允许做什么**"——它是**策略数据**，
 * 不是身份。三类混成一张表之后，"我该往 `runtime.env` 里写什么"就再也没法
 * 从名单本身读出来了。
 *
 * ## ★★★ 为什么必须有这一条（实测的缺陷，第 113 轮）
 *
 * 上一批把这五把键加进了 `product/process-manifest.mjs` 的 runtime `envNames`。
 * 那一批的措辞是"四道范围检查第一次真的能到执行面"。**那句话只对了一半**：
 *
 *   · `envNames` 管的是**继承 `baseEnv`**那条路（宿主环境里有，才过得去）；
 *   · 而"运维把它写进**产品配置文件**"（`runtime.env`）走的是**本文件**这条路。
 *
 * 实测（`scratch/_probe-r113-permit-delivery.mjs`）：五把键都写进 `runtime.env`
 * ⇒ `resolveEnforcementIdentity().values` 里**一把都没有**，而 `ok === true`、
 * `missing === []` ⇒ **静默丢掉**。于是四道范围检查在真实部署里读到的仍是"没配"，
 * **而在它们那一侧"没配"是放行**。
 *
 *   > 一个"配了、`ok:true`、而值没到"的配置面，
 *   > 与一个"这一格本来就没人配"的部署，在读数上是同一个东西——
 *   > 只不过前者让运维以为他配了。
 *
 * ★ 与 `runtime/config-schema.mjs` 那五条 `fields` 的关系：那五条声明的是
 *   "**Runtime 子进程**可以从它的环境里读这些键"，而本清单声明的是
 *   "**Launcher 会把这些键写进那个环境**"。**两句话都写下来了，才叫接线**——
 *   只有前一句时，配置表上写着可用，而子进程永远收不到。
 */
export const ENFORCEMENT_TABLE_ENV_KEYS = Object.freeze([
  'LEGION_PATH_SCOPE',
  'LEGION_CONNECTOR_DECLARATIONS',
  'LEGION_EXECUTION_SCOPE',
  'LEGION_EXTERNAL_API_SCOPE',
  // 第 113 轮新增（PRT-603 岗位白名单）。★ 它**必须**与上面四道一起在这里——
  //   只把它接进 `root-row.mjs` 而不接这里，等于"第四道接了、而它配不进去"。
  'LEGION_EMPLOYEE_PERMIT',
])

/**
 * `runtime.env` 里允许经本模块透传的键（闭集；多一个就要在这里加上并说明理由）。
 *
 * ★ 三类各有主的清单：身份（`ENFORCEMENT_IDENTITY_ENV`，含派生的 hub/cwd）、
 *   审批策略（`ENFORCEMENT_DECIDE_ENV_KEYS`）、强制面的表（`ENFORCEMENT_TABLE_ENV_KEYS`）。
 *   前两类是**必填/可选的身份与策略**，第三类是**策略数据**——所以它们被
 *   分别记在三个常量里，而闭集是三者之和。
 */
export const ENFORCEMENT_IDENTITY_PASSTHROUGH = Object.freeze([
  ...Object.values(ENFORCEMENT_IDENTITY_ENV),
  ...ENFORCEMENT_DECIDE_ENV_KEYS,
  ...ENFORCEMENT_TABLE_ENV_KEYS,
])

function identityDiag(severity, code, message, extra = {}) {
  return Object.freeze({
    severity,
    code,
    process: ENFORCEMENT_IDENTITY_PROCESS_KEY,
    message,
    ...extra,
  })
}

/** 非空白字符串，取不到返回 `null`（**不是空串**）。 */
function textOf(v) {
  if (typeof v === 'string' && v.trim() !== '') return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

/**
 * 每一字段的来源说明。诊断文案里逐字段给出——"缺 actor"而不说"去哪写"，
 * 等于把排查工作留给用户。
 *
 * ★ 这里刻意**不**写成 `runtime.env` 后跟点号加键名的样子。
 *   `scripts/config/scan.mjs` 的规则②把 `env.<大写字面量>` 当作**直接读取点**
 *   （`\w*[Ee]nv\.([A-Z][A-Z0-9_]*)`），它扫的是源码文本，不看上下文——
 *   于是一句产品文案会被记成"Launcher 读了 `LEGION_ACTOR`"。
 *   而 Launcher **不读**它，只把它**写进子进程**：真按那个读数去 schema 里补声明，
 *   等于往配置面上写一条假的事实。
 *
 *   > 一条"为了哄过门禁而写进 schema"的读取点，与一条真实的读取点，
 *   > 在"这个进程到底吃什么配置"这个问题上是两个答案。
 *
 *   所以修的是文案，不是 schema。键名照样逐字给出（用「」括起来），
 *   用户仍然知道该往哪儿写；门禁也不再把它误读成读取点。
 */
const FIELD_SOURCES = Object.freeze({
  hubUrl: '派生值：本次启动的 team-hub 端口（无需配置；端口来自 ports.team-hub）',
  cwd: '派生值：Runtime 进程计划里的 cwd（就是 supervisor spawn 时用的工作目录）',
  actor: '只能来自产品配置的 runtime.env「LEGION_ACTOR」——本批次没有别的权威来源',
  scope: '只能来自产品配置的 runtime.env「LEGION_SCOPE」——本批次没有别的权威来源',
  action: '只能来自产品配置的 runtime.env「LEGION_ENFORCEMENT_ACTION」——本批次没有别的权威来源',
  taskId: '可选，来自产品配置的 runtime.env「LEGION_TASK_ID」',
})

/**
 * 解析要注入 Runtime 子进程的 Legion 身份。
 *
 * **纯函数**：不读 `process.env`、不碰文件系统、不看时钟。
 * 因此"端口没定 / 配置没写 / 关掉了"三种处境都能在进程内造出来。
 *
 * @param {object} [o]
 * @param {boolean} [o.enabled]        `runtime.enforcementOverlay`（默认 true）
 * @param {number|null} [o.teamHubPort] 本次启动的 team-hub 端口（`plan.processes` 里那个）
 * @param {string|null} [o.cwd]        Runtime 进程计划里的 `cwd`
 * @param {object} [o.configured]      `runtime.env`（产品配置；**不含密钥**）
 * @returns {{version:number, enabled:boolean, values:object, sources:object,
 *            missing:Array<{field:string, env:string, why:string}>,
 *            diagnostics:object[], ok:boolean}}
 *   `ok === false` 表示**不得继续启动**（`preflight()` 会因 `severity: 'error'` 拦下）。
 */
export function resolveEnforcementIdentity({
  enabled = true,
  teamHubPort = null,
  cwd = null,
  configured = {},
} = {}) {
  const on = enabled !== false
  const base = Object.freeze({
    version: ENFORCEMENT_IDENTITY_VERSION,
    enabled: on,
  })

  // 关掉时**刻意沉默**（文件头有理由）：关掉这件事已经由覆盖层那条 warn 说过一次。
  if (!on) {
    return Object.freeze({
      ...base,
      values: Object.freeze({}),
      sources: Object.freeze({}),
      missing: Object.freeze([]),
      diagnostics: Object.freeze([]),
      ok: true,
    })
  }

  const explicit = configured !== null && typeof configured === 'object' && !Array.isArray(configured)
    ? configured
    : {}
  const configuredFrom = (key) => textOf(explicit[key])

  const values = {}
  const sources = {}
  const missing = []

  // ── 派生：hub 地址 ─────────────────────────────────────────────────────
  const port = Number.isInteger(teamHubPort) && teamHubPort > 0 ? teamHubPort : null
  const derivedHub = port === null ? null : `http://127.0.0.1:${port}`
  const hub = derivedHub ?? configuredFrom(ENFORCEMENT_IDENTITY_ENV.hubUrl)
  if (hub === null) {
    missing.push(Object.freeze({
      field: 'hubUrl',
      env: ENFORCEMENT_IDENTITY_ENV.hubUrl,
      why: port === null
        ? '本次启动没有定下 team-hub 端口，派生不出 hub 地址'
        : `派生被跳过且产品配置 runtime.env 里没有可用的 ${ENFORCEMENT_IDENTITY_ENV.hubUrl}`,
    }))
  } else {
    values[ENFORCEMENT_IDENTITY_ENV.hubUrl] = hub
    sources.hubUrl = derivedHub === null ? 'config' : 'derived'
  }

  // ── 派生：工作目录 ─────────────────────────────────────────────────────
  //
  // ★ 与 hub 地址同一条纪律：**派生值优先**。`cwd` 就是那个进程真正的工作目录，
  //   而工具调用投影出来的目标路径按这个 cwd 展开（`tool-request.mjs`）。
  //   允许配置覆盖会让"授权时的路径"与"执行时的路径"落在两个根上。
  const derivedCwd = textOf(cwd)
  const effectiveCwd = derivedCwd ?? configuredFrom(ENFORCEMENT_IDENTITY_ENV.cwd)
  if (effectiveCwd === null) {
    missing.push(Object.freeze({
      field: 'cwd',
      env: ENFORCEMENT_IDENTITY_ENV.cwd,
      why: derivedCwd === null
        ? `Runtime 进程计划里没有 cwd，且产品配置里没有 ${ENFORCEMENT_IDENTITY_ENV.cwd}`
        : `产品配置里没有可用的 ${ENFORCEMENT_IDENTITY_ENV.cwd}`,
    }))
  } else {
    values[ENFORCEMENT_IDENTITY_ENV.cwd] = effectiveCwd
    sources.cwd = derivedCwd === null ? 'config' : 'derived'
  }

  // ── 只能来自配置的四项 ──────────────────────────────────────────────────
  for (const field of ['actor', 'scope', 'action', 'taskId']) {
    const env = ENFORCEMENT_IDENTITY_ENV[field]
    const v = configuredFrom(env)
    if (v !== null) {
      values[env] = v
      sources[field] = 'config'
      continue
    }
    sources[field] = null
    // `taskId` 不是必填：组合根允许 `null`（进程级装配时常常还没有任务）。
    if (ENFORCEMENT_IDENTITY_REQUIRED.includes(field)) {
      missing.push(Object.freeze({ field, env, why: `产品配置 runtime.env 里没有 ${env}` }))
    }
  }

  // ── 透传：`decide` 适配器要的两项（可选，缺了由判定期 fail closed） ──────
  for (const env of ENFORCEMENT_DECIDE_ENV_KEYS) {
    const v = configuredFrom(env)
    if (v !== null) values[env] = v
  }

  // ── 透传：强制面的**表**（第 113 轮补；可选，缺了由各自端口 fail closed） ──
  //
  // ★ 与上面那一轮**逐字同形**：给了就写、没给就不写（**不补默认值**）。
  //   一个"凭空造出来的空范围表"会让 `enforcementSurfaces()` 那一格报 `true`
  //   而它一条规则都没有——那正是 `scope-port.mjs` 文件头决定 ③ 要避免的形状。
  //
  // ★★ 而"没给"这件事的后果**各道不同**，值得写下来（它决定了这一条有多要紧）：
  //   · `pathScope` / `executionScope` / `externalApiScope` 缺席 ⇒ 那一段**放行**；
  //   · `whitelist` 缺席 ⇒ 桥那一整段**根本不进入**（也是放行）；
  //   · `connectorDeclarations` 缺席 ⇒ 如实报 `false`（不建登记表）。
  //   ⇒ 前三者与第四个的后果都是"**该拦的没拦**"。所以这一条不是便利，是接线。
  for (const env of ENFORCEMENT_TABLE_ENV_KEYS) {
    const v = configuredFrom(env)
    if (v !== null) values[env] = v
  }

  if (missing.length === 0) {
    return Object.freeze({
      ...base,
      values: Object.freeze({ ...values }),
      sources: Object.freeze({ ...sources }),
      missing: Object.freeze([]),
      diagnostics: Object.freeze([]),
      ok: true,
    })
  }

  // 逐字段给出"缺了什么"与"去哪写"——两件事都说不出来时，这条诊断只是噪声。
  const lines = missing.map((m) => `  · ${m.field}（${m.env}）：${m.why}。来源：${FIELD_SOURCES[m.field]}`)
  const diagnostic = identityDiag(
    'error',
    ENFORCEMENT_IDENTITY_CODES.IDENTITY_MISSING,
    `DSH 强制面覆盖层被要求装上（runtime.enforcementOverlay 默认为 true），` +
    `但注入 Runtime 子进程的 Legion 身份不完整，缺 ${missing.length} 项：\n` +
    `${lines.join('\n')}\n` +
    '**不降级为警告**：身份不全时 `runtime/dsh-composition/plugins/root-row.mjs` ' +
    '会在 DSH 进程里以 `CONFIG_MISSING` / `CONFIG_EMPTY` 拒绝装配，' +
    '而那条错误离"产品配置该写什么"有好几层；' +
    '更坏的一种是它被 warn-and-skip 掉，于是运行时照常起来、强制面为零。' +
    'actor / scope / action 写进产品配置的 runtime.env（**不放密钥**）。' +
    '要接受"这个运行时没有 Legion 安全下限"，把 runtime.enforcementOverlay 设为 false——' +
    '那是一个被允许、且会被记录下来的决定。',
    {
      missing: Object.freeze(missing.map((m) => m.field)),
      envKeys: Object.freeze(missing.map((m) => m.env)),
    },
  )

  return Object.freeze({
    ...base,
    values: Object.freeze({ ...values }),
    sources: Object.freeze({ ...sources }),
    missing: Object.freeze(missing),
    diagnostics: Object.freeze([diagnostic]),
    ok: false,
  })
}
