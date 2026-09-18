// product/lifecycle/data-classes.mjs
// ============================================================================
// PRT-904 / PRT-908 共用的**数据分类台账**。
//
// spec §10 line 748–749：
//   「日志、事件和产物设置容量上限与保留策略。」
//   「卸载时明确区分删除程序、保留数据和彻底删除数据。」
//
// ## 为什么这两条任务共用一份台账
//
// 它们问的是同一个问题：**这份数据属于哪一类，因此该拿它怎么办？**
// 保留策略按类定上限，卸载按类定去留。如果两处各写一张类表，它们迟早不一样——
// 而"卸载时删掉的东西"与"保留策略里说要保留的东西"不一致，就是数据丢失。
//
//   > 一个「保留策略按一张类表、卸载按另一张类表」的实现，
//   > 与一个「某一天卸载会删掉保留策略承诺保留的东西」的实现，是同一个东西——
//   > 只不过前者在任何单独一张表上都是自洽的。
//
// ## 为什么"数据"不能是一个整体
//
// spec line 749 把"保留数据"与"彻底删除数据"分开，但它们之间还有一个
// 没人明说的东西：**密钥**。用户的业务数据可以保留，密钥不该跟着留；
// 反之"彻底删除"如果漏掉密钥文件，就删得不彻底。
//
// 本仓库的实际布局（`product/paths.mjs:212`）让这件事**可做**：
// `secretsFile` 在 `productHome/.secrets/` 下，**不在** `dataDir` 下。
// 所以"保留 dataDir、删掉 secretsFile"是一个能表达的动作，而不是一句口号。
// ============================================================================

/** 台账版本。改动分类或去留语义时递增。 */
export const DATA_CLASSES_VERSION = 'legion/data-classes@1'

/**
 * 数据分类。
 *
 * 每一类都必须指定 `onUninstall`——**没有默认值**。
 * 一个"忘了写去留"的类会变成"卸载时什么都不做"，而那与"保留"不可区分。
 */
export const DATA_CLASSES = Object.freeze({
  /** 程序本体。它是**唯一**在"保留数据"时也必须删的东西。 */
  program: Object.freeze({
    id: 'program',
    label: '程序本体',
    onUninstall: 'remove',
    why: '卸载的定义就是删掉它；保留数据指的是保留**非程序**的数据',
  }),
  /** 产品配置（JSON/YAML 配置，不含密钥）。 */
  config: Object.freeze({
    id: 'config',
    label: '产品配置',
    onUninstall: 'keep',
    why: '重新安装后配置通常还想用；它不含密钥（密钥是单独一类）',
  }),
  /** 业务数据库（team-hub、whiteboard 等）。 */
  database: Object.freeze({
    id: 'database',
    label: '业务数据库',
    onUninstall: 'keep',
    why: '这是"保留数据"里最核心的那部分——用户的业务事实',
  }),
  /** 日志。 */
  log: Object.freeze({
    id: 'log',
    label: '日志',
    onUninstall: 'keep',
    why: '排障需要历史日志；但受容量上限约束，见 retention.mjs',
  }),
  /** Run 事件。spec §6.x：大体量 delta 可按保留策略压缩。 */
  event: Object.freeze({
    id: 'event',
    label: 'Run 事件',
    onUninstall: 'keep',
    why: '审计与复盘需要；体量最大，受保留策略约束',
  }),
  /** 产物（artifact）。 */
  artifact: Object.freeze({
    id: 'artifact',
    label: '产物',
    onUninstall: 'keep',
    why: '交付物本身；但可能被用户移走，因此"删不掉"是可接受的',
  }),
  /** 缓存。可重建，因此不保留。 */
  cache: Object.freeze({
    id: 'cache',
    label: '缓存',
    onUninstall: 'remove',
    why: '全部可重建——保留它只是在磁盘上留垃圾，且可能让重装后读到旧缓存',
  }),
  /**
   * 密钥库。
   *
   * ★ 这是唯一一类**在"保留数据"时也要问一句**的数据。
   *   保留用户业务数据 ≠ 把凭据留在磁盘上。
   */
  secret: Object.freeze({
    id: 'secret',
    label: '密钥库',
    onUninstall: 'ask',
    why: '业务数据可以保留，但凭据留在磁盘上是另一回事——必须由用户明确选择',
  }),
  /** 工作区（用户自己的代码）。**永远不删。** */
  workspace: Object.freeze({
    id: 'workspace',
    label: '工作区',
    onUninstall: 'never',
    why: '这是用户自己的代码，不是产品数据；无论选哪种卸载都不该碰它',
  }),
})

export const DATA_CLASS_IDS = Object.freeze(Object.keys(DATA_CLASSES))

/**
 * 去留动作的语义。
 *
 * `never` 与 `keep` 的区别要紧：`keep` 是"这次留下，但用户可以选择删"，
 * `never` 是"任何模式下都不删"。把它们合成一个会让某个模式悄悄删掉工作区。
 */
export const UNINSTALL_ACTIONS = Object.freeze(['remove', 'keep', 'ask', 'never'])

/** 三种卸载模式（spec line 749 要求的"明确区分"）。 */
export const UNINSTALL_MODES = Object.freeze({
  /**
   * 只删程序：数据、日志、事件、产物、密钥**全部保留**。
   * 对应 spec 的"删除程序"。
   */
  'program-only': Object.freeze({
    id: 'program-only',
    label: '只删除程序（保留全部数据）',
    removes: Object.freeze(['program', 'cache']),
    // 密钥在这一模式下保留——但报表必须**明说**它留下了。
    keepsSecrets: true,
    why: '最小动作；适合"我想重装，别动我的东西"',
  }),
  /**
   * 保留数据（但清掉凭据与缓存）。
   * 对应 spec 的"保留数据"——这是最常用的那一个，也是最需要说清的那个。
   */
  'keep-data': Object.freeze({
    id: 'keep-data',
    label: '保留业务数据，清除凭据与缓存',
    removes: Object.freeze(['program', 'cache', 'secret']),
    keepsSecrets: false,
    why: '业务数据留下、凭据不留——"保留数据"不该被读成"把密码也留着"',
  }),
  /**
   * 彻底删除。对应 spec 的"彻底删除数据"。
   * 工作区仍然**不删**（`never`）——它是用户的代码，不是产品数据。
   */
  purge: Object.freeze({
    id: 'purge',
    label: '彻底删除全部产品数据',
    removes: Object.freeze(['program', 'cache', 'secret', 'config', 'database', 'log', 'event', 'artifact']),
    keepsSecrets: false,
    why: '除工作区外全删；工作区是用户自己的代码，任何模式下都不碰',
  }),
})

export const UNINSTALL_MODE_IDS = Object.freeze(Object.keys(UNINSTALL_MODES))

/**
 * 分类一份数据落点。
 *
 * @param {{path: string, layout?: object}} store
 * @param {object} layout `resolveLayout` 的 `layout`
 * @returns {{classId: string|null, reason: string}}
 *
 * ⚠️ 认不出的路径返回 `classId: null`，**不是**猜一个默认类。
 *    猜一个会让"我不知道这是什么"变成一个看起来正常的决定。
 */
export function classifyPath(store, layout = {}) {
  const p = String(store?.path ?? '')
  if (p === '') return Object.freeze({ classId: null, reason: '空路径' })

  const norm = (x) => (typeof x === 'string' ? x.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : null)
  const target = norm(p)
  const insideOf = (base) => {
    const b = norm(base)
    return b !== null && (target === b || target.startsWith(`${b}/`))
  }

  // ★ 顺序要紧：先判**更窄**的类，再判更宽的容器。
  //   `secretsFile` 若恰好落在 dataDir 下（用户可能这么配），
  //   先判 dataDir 就会把密钥归成"业务数据库"，于是"保留数据"会留下凭据。
  //
  //   > 一个「先判容器、再判容器里那个更敏感的东西」的分类器，
  //   > 与一个「密钥被归进"业务数据"、于是被保留」的分类器，是同一个东西——
  //   > 只不过它在绝大多数路径上都是对的。
  if (insideOf(layout.secretsFile)) return Object.freeze({ classId: 'secret', reason: '在密钥库路径下' })
  if (insideOf(layout.workspaceDir)) return Object.freeze({ classId: 'workspace', reason: '在工作区下' })
  if (insideOf(layout.cacheDir)) return Object.freeze({ classId: 'cache', reason: '在缓存目录下' })
  if (insideOf(layout.logDir)) return Object.freeze({ classId: 'log', reason: '在日志目录下' })
  if (insideOf(layout.installDir)) return Object.freeze({ classId: 'program', reason: '在安装目录下' })
  if (insideOf(layout.productConfigPath)) {
    // productConfigPath 是一个文件；它的父目录算配置，但只有它自己算配置。
    return Object.freeze({ classId: 'config', reason: '是产品配置文件' })
  }

  // 显式标注优先于路径推断（数据库可能配在任意位置）。
  if (typeof store?.classId === 'string' && DATA_CLASS_IDS.includes(store.classId)) {
    return Object.freeze({ classId: store.classId, reason: `调用方显式标注为 ${store.classId}` })
  }
  if (insideOf(layout.dataDir)) {
    return Object.freeze({ classId: null, reason: '在 dataDir 下但未标注具体类——需要调用方说明它是数据库、事件还是产物' })
  }
  return Object.freeze({ classId: null, reason: '不在任何已知落点下，且未标注类别' })
}

/**
 * 台账（每类的 `onUninstall`）与模式表（每个模式的 `removes` / `keepsSecrets`）
 * 之间的**交叉**判据。
 *
 * ## 这一整块此前**一条都没有**
 *
 * 两个表都是手写的、都在同一个文件里、都带着"为什么这么定"的说明——
 * 于是它们**看起来**像已经互相核对过了。
 *
 *   > 两份都写得很认真的表，与两份已经互相对过的表，在只读其中一份时
 *   > 是同一个东西——只不过前者会在有人只改了一边的时候安静地错下去。
 *
 * 最尖锐的一处是 `keepsSecrets`：它声明了**三处**、被读了**零处**
 * （`git grep keepsSecrets` 只有那三行声明）。而它正是"`ask` 类（密钥）
 * 被明确表态过"的唯一表达方式——`planUninstall` 自己只按 `removes` 执行。
 * 于是"有人忘了写"与"决定了要保留"在数据上完全一样。
 *
 * ## 四种动作的**强制力是不一样的**（有意的，写下来免得下一个人以为漏了）
 *
 *   · `never` —— **硬底**：任何模式的 `removes` 里都不许出现它。
 *   · `remove` —— **硬**：卸载的定义就是删掉它，所以**每个**模式都得删。
 *   · `ask`    —— **必须被明确表态**：由该模式自己的 `keepsSecrets` 表达。
 *   · `keep`   —— **只是默认值，可以被模式显式推翻**。`purge` 就推翻了
 *                config/database/log/event/artifact 五个 `keep` 类。
 *                ⇒ 这里**故意不查** `keep`：查它会让 `purge` 变成非法，
 *                  而"彻底删除全部产品数据"正是 spec line 749 要的那一档。
 *                  不写清这一条，下一个人会把它当成漏掉的一条判据补上，
 *                  然后发现 `purge` 红了。
 *
 * ## 为什么是纯函数
 *
 * 真表今天是自洽的。只用真表验，等于用"没有反例"证明"没有反例"。
 * 拆出来之后，用例可以拿**人造表**逐条把边界钉红。
 *
 * @param {object} [classes] `DATA_CLASSES` 形状
 * @param {object} [modes] `UNINSTALL_MODES` 形状
 * @param {ReadonlyArray<string>} [covered] 已经有**更具体**判据的类 id。
 *   `auditLedger` 会传 `['program','workspace']`（它那两句带具体理由的话更有用），
 *   于是同一个缺陷不会被报成两条。**默认空**——人造表要能逐条全查，
 *   否则"跳过某几类"会让本该红的用例安静地绿。
 * @returns {ReadonlyArray<string>} 问题清单（空 = 自洽）
 */
export function crossCheckLedger(
  { classes = DATA_CLASSES, modes = UNINSTALL_MODES, covered = [] } = {},
) {
  const problems = []

  for (const [id, m] of Object.entries(modes)) {
    const removes = m.removes ?? []
    // ① `keepsSecrets` 必须是一个**真布尔**——它是 `ask` 类的表态。
    if (typeof m.keepsSecrets !== 'boolean') {
      problems.push(`模式 ${id} 的 keepsSecrets 是 ${JSON.stringify(m.keepsSecrets)}，不是布尔——`
        + '而"ask 类（密钥）被明确表态过"这句话就是靠它表达的。缺了它，'
        + '"有人忘了写"与"决定了要保留"在数据上完全一样')
    } else {
      // ② 声明必须与 `removes` 一致——否则读声明的人（报表、确认框）
      //    会得到与即将发生的事**相反**的结论。
      const actual = !removes.includes('secret')
      if (m.keepsSecrets !== actual) {
        problems.push(`模式 ${id} 声明 keepsSecrets=${m.keepsSecrets}，而 removes `
          + `${actual ? '不含' : '含'} secret——声明与行为相反时，`
          + '读声明的人（报表、确认框）会得到与即将发生的事相反的结论')
      }
    }

    for (const [cid, c] of Object.entries(classes)) {
      // 已经有更具体判据的类跳过（免得同一个缺陷被报成两条）。
      if (covered.includes(cid)) continue
      // ③ `remove` 的类每个模式都得删。
      if (c.onUninstall === 'remove' && !removes.includes(cid)) {
        problems.push(`分类 ${cid} 的 onUninstall 是 remove（${c.why}），而模式 ${id} 不删它——`
          + '台账说卸载就该删它，模式却留下了，两边只有一个是对的')
      }
      // ④ `never` 的类任何模式都不许删。
      if (c.onUninstall === 'never' && removes.includes(cid)) {
        problems.push(`分类 ${cid} 的 onUninstall 是 never（${c.why}），而模式 ${id} 要删它`)
      }
    }
  }

  return Object.freeze(problems)
}

/**
 * 台账自检：每一类都要有去留动作，且三种模式都要**能被表达**。
 *
 * 留下算出来的值（每类的动作、每模式删哪些），不是一个 `ok` 布尔。
 */
function auditLedger() {
  const problems = []
  for (const [id, c] of Object.entries(DATA_CLASSES)) {
    if (c.id !== id) problems.push(`分类 ${id} 的 id 字段是 ${JSON.stringify(c.id)}`)
    if (!UNINSTALL_ACTIONS.includes(c.onUninstall)) {
      problems.push(`分类 ${id} 的 onUninstall=${JSON.stringify(c.onUninstall)} 不在合法动作里`)
    }
    if (typeof c.why !== 'string' || c.why === '') problems.push(`分类 ${id} 没有说明为什么这么定`)
  }
  for (const [id, m] of Object.entries(UNINSTALL_MODES)) {
    if (m.id !== id) problems.push(`模式 ${id} 的 id 字段是 ${JSON.stringify(m.id)}`)
    for (const c of m.removes) {
      if (!DATA_CLASS_IDS.includes(c)) problems.push(`模式 ${id} 要删一个不存在的类 ${JSON.stringify(c)}`)
    }
    // 每个模式都必须删程序——否则"卸载"什么也没卸。
    if (!m.removes.includes('program')) problems.push(`模式 ${id} 不删程序`)
    // 每个模式都必须保留工作区。
    if (m.removes.includes('workspace')) problems.push(`模式 ${id} 会删工作区——那是用户的代码`)
  }

  // ── 台账（`onUninstall`）与模式表（`removes`）之间的**交叉**判据 ──────
  // 实现在下面那个纯函数里；`auditLedger` 只是拿**真表**调它一次。
  // 拆出来是为了让边界能被**人造表**钉住（真表今天是自洽的，
  // 只用真表验，等于用"没有反例"验"没有反例"）。
  // ★ `covered` 里是上面已经有**更具体**判据的两个类——它们那两句带着
  //   "否则'卸载'什么也没卸"与"那是用户的代码"，比通用句子有用，
  //   所以通用判据跳过它们，避免同一个缺陷被报成两条。
  problems.push(...crossCheckLedger({ covered: ['program', 'workspace'] }))
  // 密钥那一类的去留必须是 `ask`：它是"保留数据"与"彻底删除"之间那条线。
  if (DATA_CLASSES.secret.onUninstall !== 'ask') {
    problems.push('secret 类的 onUninstall 必须是 ask——否则"保留数据"会静默地留下凭据，或静默地删掉它')
  }
  // ★ 三种模式必须**两两不同**。三个名字指向同一组动作，就等于只提供了一种选择。
  const shapes = new Map()
  for (const m of Object.values(UNINSTALL_MODES)) {
    const key = [...m.removes].sort().join(',')
    if (shapes.has(key)) problems.push(`模式 ${m.id} 与 ${shapes.get(key)} 删的东西完全一样——"明确区分"没做到`)
    shapes.set(key, m.id)
  }
  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    version: DATA_CLASSES_VERSION,
    classCount: DATA_CLASS_IDS.length,
    modeCount: UNINSTALL_MODE_IDS.length,
    actions: Object.freeze(Object.fromEntries(Object.entries(DATA_CLASSES).map(([k, v]) => [k, v.onUninstall]))),
    modeRemovals: Object.freeze(Object.fromEntries(Object.entries(UNINSTALL_MODES).map(([k, v]) => [k, v.removes]))),
    secretsInEachMode: Object.freeze(Object.fromEntries(
      Object.entries(UNINSTALL_MODES).map(([k, v]) => [k, v.removes.includes('secret') ? 'removed' : 'kept']),
    )),
  })
}

export const DATA_CLASSES_CHECKED = auditLedger()
