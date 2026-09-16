// runtime/dsh-composition/employee-preset.mjs
// ============================================================================
// PRT-214：**员工 agent preset** 的渲染与安装。
//
// spec §6.9 把强制面分成两个平面，本模块负责第二个：
//
//   | Legion 员工 agent preset | agent 平面，按 session 挂载 |
//   |   岗位工具集、persona、提示段、skill 引用                  |
//
// 补丁层（`patch-layer.mjs` / `legion-host.patch.yml`）已经做完了 host 平面那一半；
// 这里是另一半——把一份**员工清单**渲染成一个 DSH 认得出来的 agent preset 目录：
//
//     <presetRoot>/<presetId>/agent.cordis.yml
//     <presetRoot>/<presetId>/preset.yml
//
// ## ① 为什么工具行必须**由授权推导**，不能手写
//
// 手写一份"岗位工具集"有两条都很难发现的错法：
//
//   · 写多了 → 员工拿到清单外的工具。运行期会被强制面按 grant 拒掉，
//     所以**看起来**是安全的；但"一个被拒绝了三次的员工"与"一个没被授予这个工具的员工"
//     在读数上不同，而排查的人会去查权限，真因却在 preset 里多了一行。
//   · 写少了 → 员工干不了活。**这个更坏**，因为它不报错：模型只是没有那个工具，
//     于是它用别的办法绕，或者干脆说做不到。
//
//     > 一个"清单给了权限、preset 没给工具"的 preset，
//     > 与一个"这个岗位本来就没有这个权限"的 preset，在模型那里是同一个东西——
//     > 只不过前者会让一次本该成功的工作变成一句"我做不到"。
//
// 所以：**行是从 grant 推导出来的**，而且清单里每一项都要有一个交代。
//
// ## ② 覆盖不到的工具必须**说出来**，不能静默丢掉
//
// Legion 的工具登记表里有 14 个工具（`tool-capability.mjs` 的 `TOOL_CATALOG`），
// 但 DSH 随部署分发的 preset 行只能提供其中一部分——
// `read-secret`、`send-message`、`mcp-invoke` 这些是 **Legion 自己的**工具，
// 由宿主平面注册，preset 里**找不到对应的包**。
//
//     > 一个"清单里要什么、preset 就装什么"的渲染器，
//     > 与一个"清单要 A、preset 装了 B、而两者都不报错"的渲染器，
//     > 在生成的 YAML 上看起来是同一个东西——只不过后者的员工少了一半工具。
//
// 因此 `coverageOf()` 对**每一个**被授予的工具给出 `covered` / `hosted` / `missing`，
// 而 `missing` 会让渲染**失败**（不是 warn）——那是接线缺口，不是配置选择。
//
// ## ③ 不得携带强制面
//
// `EMPLOYEE_PRESET_CONTRACT.mayCarryEnforcement === false`（spec §6.9 line 493）。
// 本模块不仅拒绝渲染强制面字段，还拒绝**任何会发布服务的行**——
// 一个发布服务的行落在 preset 里、又没有 `isolate` realm，
// 第二个 session 挂载时会在 root realm 撞名（见 skill `editing-cordis-compositions`）。
// ============================================================================

import { EMPLOYEE_PRESET_CONTRACT } from './patch-layer.mjs'
import { FORBIDDEN_MANIFEST_FIELDS, MANIFEST_CODES, narrowToGrant, permitsTool } from './employee-manifest.mjs'
import { TOOL_CATALOG } from './tool-capability.mjs'

export const EMPLOYEE_PRESET_VERSION = 'legion/employee-preset@1'

/** 渲染/安装期的失败码。 */
export const EMPLOYEE_PRESET_CODES = Object.freeze({
  /** preset id 不合法（它要当目录名）。 */
  BAD_ID: 'EMPLOYEE_PRESET_BAD_ID',
  /** 没有清单或授权。 */
  NO_MANIFEST: 'EMPLOYEE_PRESET_NO_MANIFEST',
  /** 清单里出现了强制面字段（spec §6.9 line 493）。 */
  ENFORCEMENT_ON_AGENT_PLANE: 'EMPLOYEE_PRESET_ENFORCEMENT_ON_AGENT_PLANE',
  /** 被授予的工具在 DSH preset 里**没有对应行**，而且是 Legion 也没托管的。 */
  TOOL_UNCOVERED: 'EMPLOYEE_PRESET_TOOL_UNCOVERED',
  /** 试图塞一行会发布服务的行、却没有 isolate realm。 */
  SERVICE_WITHOUT_REALM: 'EMPLOYEE_PRESET_SERVICE_WITHOUT_REALM',
  /** preset id 与随部署分发的 preset 撞名。 */
  SHIPPED_ID_COLLISION: 'EMPLOYEE_PRESET_SHIPPED_ID_COLLISION',
  /** 安装根目录没给。 */
  NO_ROOT: 'EMPLOYEE_PRESET_NO_ROOT',
})

function presetError(code, message, extra = {}) {
  const err = new Error(message)
  err.code = code
  Object.assign(err, extra)
  return err
}

// ─────────────────────────────────────────────────────────── DSH preset 行

/**
 * DSH 随部署分发的 preset 行里，Legion 允许员工 preset 引用的那些。
 *
 * **每一个 `provides` 都是读出来的，不是猜的**（读的是 `DSH_CHECKOUT` 里的源码）：
 *
 *   `@deepseek-ai/dsh-tool-fs`           → read, write, edit, read_image
 *       （packages/fs/tool-fs/src/{read,write,edit,read-image}.ts 的 `name:`）
 *   `@deepseek-ai/dsh-tool-fs-search`    → glob, grep
 *   `@deepseek-ai/dsh-tool-bash`         → bash
 *   `@deepseek-ai/dsh-tool-pwsh`         → pwsh
 *   `@deepseek-ai/dsh-tool-web`          → web_fetch, web_search
 *
 * `platform` 用来生成 `disabled: !!js ...`——DSH 的 loader 支持 `!!js`，
 * 而 `standard` preset 就是这么写 shell 行的（`tool-bash` 在 win32 上 disabled）。
 * 不生成这一行的后果不是报错而是**装了一个跑不起来的东西**。
 */
export const DSH_PRESET_ROWS = Object.freeze({
  'tool-fs': Object.freeze({
    pkg: '@deepseek-ai/dsh-tool-fs', provides: Object.freeze(['read', 'write', 'edit', 'read_image']), platform: null,
  }),
  'tool-fs-search': Object.freeze({
    pkg: '@deepseek-ai/dsh-tool-fs-search', provides: Object.freeze(['glob', 'grep']), platform: null,
    /**
     * ★ `sampleOverCapGlobResults` **必填，且没有兜底值**。
     *
     * DSH 那边的 schema 是 `z.boolean().required()`，它的 README 明说
     * 「是必填项且没有回退值：部署必须显式选择超过上限时的排序约定」。
     * 兜底只写在**宿主**行上（`dsh-base` 的 `cordis.patch.yml` 与三个 shipped
     * preset 各写了一次 `false`）——**preset 里的行不继承宿主行的 config**。
     *
     * 于是漏掉这一行的后果是：`read-file`（→ 行集含 `tool-fs-search`）一被授权，
     * 这个 preset 就**挂不上**，而**发现层仍然报它健康**。
     *
     *   > 一个"能被解析器读进去"的 preset，
     *   > 与一个"能真的挂上"的 preset，
     *   > 在渲染器的用例里是同一个东西——
     *   > 只不过前者的用例是绿的，而它从未被任何 mount 读过。
     *
     * 取 `false` 与 `dsh-base`、`standard`、`ptc`、`cordis` 四处**逐字一致**：
     * 这不是我们发明的默认值，是跟着部署已有的选择走。
     * （这一行是破验式的：一套只断言"渲染文本 == 声明"的用例看不见它。）
     */
    config: Object.freeze({ sampleOverCapGlobResults: false }),
  }),
  'tool-bash': Object.freeze({
    pkg: '@deepseek-ai/dsh-tool-bash', provides: Object.freeze(['bash']), platform: 'posix',
  }),
  'tool-pwsh': Object.freeze({
    pkg: '@deepseek-ai/dsh-tool-pwsh', provides: Object.freeze(['pwsh']), platform: 'win32',
  }),
  'tool-web': Object.freeze({
    pkg: '@deepseek-ai/dsh-tool-web', provides: Object.freeze(['web_fetch', 'web_search']), platform: null,
  }),
})

/**
 * Legion 工具名 → 提供它的 DSH preset 行 / 或说明为什么不由 preset 提供。
 *
 * `hosted: true` 表示这个工具由 **Legion 宿主平面**注册（不在 preset 里），
 * 这正是 spec §6.9 那条平面规则的直接后果：
 * 强制面与跨 session 能力归 host，员工 preset 只承载**岗位能力**。
 */
export const LEGION_TOOL_ROUTING = Object.freeze({
  'read-file': Object.freeze({ rows: ['tool-fs', 'tool-fs-search'], dshTools: ['read', 'glob', 'grep'] }),
  'write-file': Object.freeze({ rows: ['tool-fs'], dshTools: ['write', 'edit'] }),
  'delete-file': Object.freeze({
    rows: [], hosted: true,
    reason: 'DSH 随部署分发的 preset 里没有删除工具；删除由 Legion 宿主平面的 file 能力提供',
  }),
  'run-command': Object.freeze({ rows: ['tool-bash', 'tool-pwsh'], dshTools: ['bash', 'pwsh'] }),
  'fetch-url': Object.freeze({ rows: ['tool-web'], dshTools: ['web_fetch'] }),
  'git-status': Object.freeze({
    rows: ['tool-bash', 'tool-pwsh'], dshTools: ['bash', 'pwsh'],
    reason: 'git 通过 shell 调用，DSH 没有专门的 git 工具行',
  }),
  'git-commit': Object.freeze({
    rows: ['tool-bash', 'tool-pwsh'], dshTools: ['bash', 'pwsh'],
    reason: '同上',
  }),
  'git-push': Object.freeze({
    rows: ['tool-bash', 'tool-pwsh'], dshTools: ['bash', 'pwsh'],
    reason: '同上',
  }),
  'mcp-invoke': Object.freeze({
    rows: [], hosted: true, reason: 'MCP 客户端注册在 Legion 宿主平面（跨 session 共享连接池）',
  }),
  'read-secret': Object.freeze({
    rows: [], hosted: true, reason: '密钥存储属于 Legion 宿主平面（PRT-505）',
  }),
  'write-secret': Object.freeze({
    rows: [], hosted: true, reason: '同上',
  }),
  'send-message': Object.freeze({
    rows: [], hosted: true, reason: '团队消息走 team-hub，是 Legion 宿主平面能力',
  }),
  'call-external-api': Object.freeze({
    rows: ['tool-web'], dshTools: ['web_fetch'], reason: '只读外部调用映射到 web_fetch',
  }),
  'post-external-api': Object.freeze({
    rows: [], hosted: true, reason: '写外部 API 需要 Legion 的 external-api 范围判定，不在 preset 里',
  }),
})

/**
 * **把映射读出来的那一份读数**：一组 Legion 工具名 → 它们真正落到执行面的工具名。
 *
 * ## 为什么它必须存在（而不是只活在注释里）
 *
 * 有一条可验证、而且**会静默失效**的名字空间事实：
 *
 *   · 静态下限 `createHardFloorGuard()`（`enforcement.mjs`）比对的是
 *     **执行面（DSH）的工具名**——它只看 `execution.name`，中间没有翻译；
 *   · Legion 的高风险名单（`tool-capability.mjs` 的 `HIGH_RISK_TOOL_NAMES`）写的是
 *     **能力名**（`read-secret` / `run-command` / …）。
 *
 * 两个名字空间不相交。把后者直接当 `denyTools` 装上去，实际拒绝集是**这个函数
 * 返回的并集**，而不是那九个能力名——对 `HIGH_RISK_TOOL_NAMES` 它只有 shell 那一对
 * （`bash` / `pwsh`）。**六个宿主平面能力连一个执行面名字都没有**（`hosted: true`），
 * 另外几个能力又**共用**同一批名字（`run-command` / `git-commit` / `git-push` /
 * 低风险的 `git-status` 都走 shell）。
 *
 *   > 一份「写的是能力名、比的是工具名」的名单，
 *   > 与一份「写的是工具名、于是真的拦得住」的名单，
 *   > 在用例只喂 Legion 名字的那些日子里是同一个东西（手写的 probe 都能被拒）——
 *   > 只不过真工具名进来时，前者一个都拦不住，却在摘要里看起来在生效。
 *
 * ⚠️ 这个函数是**读数**，不是安装路径：`run-floor.mjs` 的 `absent` 档**不**用它装
 * guard——接线完成前那一档的 fail closed 姿态是"拒绝一切"（名字名单做不到 fail
 * closed：不在名单里的一律放行）。把映射算出来是为了让"名单对不上号"这件事**可被
 * 断言**，而不是只活在注释里；它**不改变** `absent` 拦什么。
 *
 * @param {string[]} [legionToolNames] Legion 工具名，默认取整张路由表
 * @returns {readonly string[]} 去重后的执行面工具名（`hosted` 的不产生名字）
 */
export function dshToolNamesOf(legionToolNames = Object.keys(LEGION_TOOL_ROUTING)) {
  const out = []
  for (const name of legionToolNames) {
    const route = LEGION_TOOL_ROUTING[name]
    // 不在表里的名字**不猜**：猜一个执行面名字就是凭空造一条禁不掉的规则。
    if (route === undefined || route.hosted === true) continue
    for (const dsh of route.dshTools ?? []) {
      if (!out.includes(dsh)) out.push(dsh)
    }
  }
  return Object.freeze(out)
}

/**
 * **要在一个执行面上禁掉某个 Legion 工具，必须在执行面上禁掉哪些名字**（含代价）。
 *
 * ## 为什么 `dshToolNamesOf()` 不够
 *
 * `dshToolNamesOf()` 回答的是"这一组 Legion 工具会落到哪些执行面名字上"——
 * 它是**读数**，用来让"名单对不上号"可被断言。而派生下限那一侧要回答的是另一个
 * 问题，而且必须**逐个工具**回答，因为答案有三种形状、修法完全不同：
 *
 *   · **可表达**（`git-push`）→ 要禁的执行面名字是 `['bash','pwsh']`。
 *     代价是这两个名字**同时承载**别的 Legion 工具（`run-command` / `git-status` /
 *     `git-commit`），于是禁掉它们会**连带**禁掉那些工具。这个代价必须能被读出来
 *     （`collateral`），否则一次"为了拦一个推送而关掉整个 shell"的决定
 *     在读数上与"只拦了推送"是同一个东西。
 *   · **不可表达**（`delete-file` / `write-secret`）→ `hosted: true`，执行面**没有**
 *     这个工具，因此**没有一个名字可以让 guard 去拒**。这不是"不用禁"，
 *     是"这一层禁不了"——两种读数必须分得开。
 *   · **不知道**（路由表里没有这一条）→ 同上不可表达，但理由不同：
 *     前者是"它由别的平面提供"，这里是"我们不知道它是什么"。
 *     两种理由都指向"这一层禁不了"，但修法一个是接线、一个是登记路由表。
 *
 *   > 一个"三个硬底线里能表达的那一个被翻译了、另两个被静默跳过"的下限，
 *   > 与一份"三个都覆盖了"的下限，在 `denyTools` 的长度上是同一个读数——
 *   > 只不过前者漏掉的恰好是 `file:delete` 与 `credential:write`，
 *   > 也就是"删文件回不来、写密钥会让已录入的凭证无法恢复"那两个。
 *
 * ## 为什么它属于本模块
 *
 * 答案完全由 `LEGION_TOOL_ROUTING` 决定，而那张表住在这里；把答案抄到
 * `run-floor.mjs` 会造出第二份映射（那张表的注释里写着：两处名单今天恰好同名
 * 有一致性，与来自同一个来源的一致性，在没有人只改一边的那些日子里是同一个东西）。
 * `run-floor.mjs` 只**接收**这个函数的结论（注入），不 import 它——那会是一个
 * 真实的模块环（见那个模块的文件头）。
 *
 * @param {string} legionToolName
 * @param {{routing?: object, catalog?: object}} [o] 只给用例用；生产走默认的两张表
 * @returns {Readonly<{legionTool: string, dshTools: readonly string[], hosted: boolean,
 *   unrouted: boolean, collateral: readonly string[], reason: string|null}>}
 */
export function executionDenialFor(legionToolName, { routing = LEGION_TOOL_ROUTING, catalog = TOOL_CATALOG } = {}) {
  const name = typeof legionToolName === 'string' ? legionToolName : String(legionToolName)
  const route = routing[name]

  if (route === undefined) {
    return Object.freeze({
      legionTool: name, dshTools: Object.freeze([]), hosted: false, unrouted: true,
      collateral: Object.freeze([]),
      reason: '路由表里没有这个工具：不知道它在执行面上叫什么，于是没有名字可以让 guard 去拒',
    })
  }
  if (route.hosted === true) {
    return Object.freeze({
      legionTool: name, dshTools: Object.freeze([]), hosted: true, unrouted: false,
      collateral: Object.freeze([]),
      reason: route.reason ?? '由 Legion 宿主平面提供，不在执行面的 preset 里',
    })
  }

  const dshTools = Object.freeze([...(route.dshTools ?? [])])

  // 连带代价：**别的** Legion 工具里，有哪些也落到这批名字上。
  // 只用目录判"是不是另一个硬底线"——不是硬底线的那些才是代价；
  // 是硬底线的那些本来就该被禁，把它们算进代价会把代价说大。
  const collateral = []
  for (const other of Object.keys(routing)) {
    if (other === name) continue
    const r = routing[other]
    if (r === undefined || r.hosted === true) continue
    if (!(r.dshTools ?? []).some((d) => dshTools.includes(d))) continue
    if (catalog[other]?.hardFloor === true) continue
    if (!collateral.includes(other)) collateral.push(other)
  }

  return Object.freeze({
    legionTool: name,
    dshTools,
    hosted: false,
    unrouted: false,
    collateral: Object.freeze(collateral),
    reason: null,
  })
}

/**
 * 从**授权**推导出这份 preset 需要哪些 DSH 行，以及覆盖情况。
 *
 * @param {{grant: object, allowedTools?: string[]}} input
 *   `grant` 是 `narrowToGrant()` 的结论（权威）；`allowedTools` 可选，用来
 *   表达"清单里点名了、但授权更窄"的情况——此时以 **grant 为准**，
 *   点名项记为 `not-granted`，因为强制面在运行期也是按 grant 判的。
 */
export function coverageOf({ grant, allowedTools = null } = {}) {
  if (grant === null || typeof grant !== 'object') {
    throw presetError(EMPLOYEE_PRESET_CODES.NO_MANIFEST, 'coverageOf 需要 narrowToGrant() 给出的 grant')
  }
  const grantedTools = Array.isArray(grant.allowedTools) ? [...grant.allowedTools] : []
  const grantedCaps = Array.isArray(grant.allowedCapabilities) ? [...grant.allowedCapabilities] : []

  const entries = grantedTools.map((toolName) => {
    const routing = LEGION_TOOL_ROUTING[toolName]
    if (routing === undefined) {
      // 登记表里没有这个名字。**不是**"不需要工具行"，而是我们不知道它是什么。
      return Object.freeze({
        toolName, status: 'unknown', rows: Object.freeze([]), dshTools: Object.freeze([]),
        reason: `工具登记表里没有 ${toolName}`,
      })
    }
    if (routing.hosted === true) {
      return Object.freeze({
        toolName, status: 'hosted', rows: Object.freeze([]), dshTools: Object.freeze([]),
        reason: routing.reason ?? '由 Legion 宿主平面提供',
      })
    }
    return Object.freeze({
      toolName, status: 'covered',
      rows: Object.freeze([...routing.rows]),
      dshTools: Object.freeze([...routing.dshTools]),
      ...(routing.reason === undefined ? {} : { reason: routing.reason }),
    })
  })

  // 清单点名了但 grant 没给的：如实列出，**不**因此装行
  const notGranted = Array.isArray(allowedTools)
    ? allowedTools.filter((t) => !grantedTools.includes(t))
    : []

  const rows = [...new Set(entries.filter((e) => e.status === 'covered').flatMap((e) => e.rows))].sort()
  const missing = entries.filter((e) => e.status === 'unknown')
  const hosted = entries.filter((e) => e.status === 'hosted')

  return Object.freeze({
    entries: Object.freeze(entries),
    rows: Object.freeze(rows),
    hosted: Object.freeze(hosted),
    missing: Object.freeze(missing),
    notGranted: Object.freeze(notGranted),
    capabilities: Object.freeze(grantedCaps),
    /** 每一个被授予的工具都有交代了，且没有"不认识"的。 */
    complete: missing.length === 0,
  })
}

// ────────────────────────────────────────────────────────────── 渲染

/**
 * 每个 `DSH_PRESET_ROWS` 里的行都必须**至少被一个** Legion 工具路由到。
 *
 * 这一条是补出来的。第一版 `read-file` 只路由到 `tool-fs`，于是
 * `tool-fs-search` 在整张表里**没有任何工具能到达它**——它是一行
 * "声明了、但永远不会被渲染出去"的行。
 *
 *   > 一个"声明了却永远装不上"的行，
 *   > 与一个"根本不在表里"的行，在产出的 preset 上是同一个东西——
 *   > 只不过前者会让读表的人以为 `glob`/`grep` 已经给了员工。
 *
 * 做成**可注入参数**的纯函数，是为了让用例能喂一张故意断链的表进来，
 * 验它真的会拦——一个只能对"当前恰好正确的那张表"作答的检查，
 * 与一个恒真的检查，在"它能不能发现错误"上同形。
 */
export function assertEveryRowReachable({
  rows = DSH_PRESET_ROWS,
  routing = LEGION_TOOL_ROUTING,
} = {}) {
  const reachable = new Set()
  for (const route of Object.values(routing)) {
    for (const r of route.rows ?? []) reachable.add(r)
  }
  const unreachable = Object.keys(rows).filter((k) => !reachable.has(k))
  return Object.freeze({
    rows: Object.freeze(Object.keys(rows)),
    reachable: Object.freeze([...reachable].sort()),
    unreachable: Object.freeze(unreachable),
    ok: unreachable.length === 0,
  })
}

/** preset id 会成为目录名，所以与 `copy()` 同一条规则：`[a-z0-9][a-z0-9-]*`。 */
export const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** 随部署分发的 preset id（**只读**，Legion 永不写入；见 skill 的 Off-limits）。 */
export const SHIPPED_PRESET_IDS = Object.freeze(['standard', 'ptc', 'minimal', 'cordis'])

function quoteYaml(value) {
  // 单引号是最安全的一档：YAML 单引号串里只有 `'` 需要转义（写成 `''`）。
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * 一个标量在 YAML 里需不需要引号。
 *
 * 判据是"这个值写出去，读回来还是不是同一个串"，而不是"看起来危不危险"。
 * 于是 `true` / `123` / `null` / 前导空格 / 以 `>` 或 `|` 开头……
 * 全部按 YAML 的解析规则判定，而不是枚举一张"看着像危险"的名单。
 *
 *   > 一个"只在看起来危险时才加引号"的生成器，
 *   > 与一个"该加的时候恰好没加"的生成器，在它漏的那一天之前是同一个东西。
 */
export function needsQuoting(value) {
  const s = String(value)
  if (s === '') return true
  if (/^[\s]|[\s]$/.test(s)) return true // 前导/尾随空白会被吃掉
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true // YAML 指示符开头
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true // 会被读成布尔/null
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return true // 会被读成数字
  if (/[:#]\s/.test(s) || /\s#/.test(s)) return true // 值里出现注释/映射歧义
  if (/[\n\r\t]/.test(s)) return true // 控制字符
  return false
}

/** 按需加引号；`!!js` 那种 **表达式** 明确不走这里（它必须原样）。 */
export function yamlScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  return needsQuoting(value) ? quoteYaml(value) : String(value)
}

/** 一个 DSH preset 行 → YAML 片段。 */
function renderRow(row) {
  const out = [`- id: ${row.id}`, `  name: ${quoteYaml(row.pkg)}`]
  if (row.disabledJs !== undefined) out.push(`  disabled: !!js ${row.disabledJs}`)
  if (row.config !== undefined && Object.keys(row.config).length > 0) {
    out.push('  config:')
    for (const [k, v] of Object.entries(row.config)) out.push(`    ${k}: ${yamlScalar(v)}`)
  }
  return out.join('\n')
}

/**
 * 渲染一个员工 agent preset。
 *
 * @param {object} cfg
 * @param {string} cfg.id preset id（也用作目录名）
 * @param {object} cfg.manifest 员工清单（`normalizeManifest()` 之后）
 * @param {object} cfg.grant `narrowToGrant()` 的结论
 * @param {string} cfg.persona persona 正文（岗位身份）
 * @param {string} [cfg.personaSuffix]
 * @param {Array<{id: string, name: string, config?: object}>} [cfg.promptSections]
 *   额外提示段行。**不接受 `tools/pre-execute` 之类**——见 contract 检查。
 * @param {string[]} [cfg.skills] skill 引用（目录名），写进 agent-instructions 的注释里
 * @param {string} [cfg.displayName]
 * @param {string} [cfg.description]
 * @returns {{id: string, files: object, coverage: object, text: string}}
 */
export function renderEmployeePreset({
  id,
  manifest,
  grant,
  persona,
  personaSuffix = null,
  promptSections = [],
  skills = [],
  displayName = null,
  description = null,
} = {}) {
  if (typeof id !== 'string' || !PRESET_ID_PATTERN.test(id)) {
    throw presetError(EMPLOYEE_PRESET_CODES.BAD_ID,
      `preset id 不合法（要当目录名用，规则 ${PRESET_ID_PATTERN}）：${JSON.stringify(id)}`)
  }
  if (SHIPPED_PRESET_IDS.includes(id)) {
    throw presetError(EMPLOYEE_PRESET_CODES.SHIPPED_ID_COLLISION,
      `preset id ${id} 与随部署分发的 preset 撞名。` +
      'spec §6.9 line 496：补丁层不得编辑或覆盖 DSH 随部署分发的 preset 安装——' +
      '升级会把它换掉，而且覆盖 `cordis` 会让 preset 编写能力本身失效')
  }
  if (persona === undefined || typeof persona !== 'string' || persona.trim() === '') {
    throw presetError(EMPLOYEE_PRESET_CODES.NO_MANIFEST,
      'renderEmployeePreset 需要 persona 正文。**不给默认值**：' +
      '一个没有岗位身份的 preset 与一个身份模板没被填的 preset，在模型那里是同一个东西——' +
      '只不过后者会让员工用通用的口气去做一个专业岗位的事')
  }

  // ① 强制面字段：清单侧已经被 `assertManifestFieldsClosed` 拒绝，
  //    这里再查一次是因为**渲染器可能被单独调用**（比如从一份手写的 manifest 直接渲染）。
  if (manifest !== null && typeof manifest === 'object') {
    const leaked = FORBIDDEN_MANIFEST_FIELDS.filter((f) => manifest[f] !== undefined)
    if (leaked.length > 0) {
      throw presetError(EMPLOYEE_PRESET_CODES.ENFORCEMENT_ON_AGENT_PLANE,
        `员工清单里出现了强制面字段 ${JSON.stringify(leaked)}：` +
        `spec §6.9 line 493 —— 强制面必须在 host 组合补丁层，不能放在 agent preset。` +
        `清单侧规则码 ${MANIFEST_CODES.ENFORCEMENT_ON_AGENT_PLANE}`)
    }
  }
  if (EMPLOYEE_PRESET_CONTRACT.mayCarryEnforcement !== false) {
    throw presetError(EMPLOYEE_PRESET_CODES.ENFORCEMENT_ON_AGENT_PLANE,
      'EMPLOYEE_PRESET_CONTRACT 说 preset 可以携带强制面——那与 spec §6.9 line 493 冲突，拒绝渲染')
  }

  // ② 提示段：任何**会发布服务**或**名字带强制面意味**的行都拒绝。
  for (const section of promptSections) {
    if (section === null || typeof section !== 'object' || typeof section.name !== 'string') {
      throw presetError(EMPLOYEE_PRESET_CODES.NO_MANIFEST, `提示段行形状不对：${JSON.stringify(section)}`)
    }
    if (/pre-execute|tool-guard|approval|permission|hard-floor/i.test(section.name)) {
      throw presetError(EMPLOYEE_PRESET_CODES.ENFORCEMENT_ON_AGENT_PLANE,
        `提示段行 ${section.name} 看起来是强制面组件。` +
        'spec §6.9 line 493 要求强制面在 host 补丁层——' +
        'preset 按 session 挂载且可被 shadow，把下限放进去等于让它取决于当前 session 挂了什么')
    }
    if (section.provides !== undefined && section.isolate === undefined) {
      throw presetError(EMPLOYEE_PRESET_CODES.SERVICE_WITHOUT_REALM,
        `提示段行 ${section.name} 声明会发布服务 ${JSON.stringify(section.provides)}，却没有 isolate realm。` +
        '第二个 session 挂载时会在 root realm 撞名')
    }
  }

  // ③ 覆盖：**missing 一律失败**，不是 warn。
  const coverage = coverageOf({ grant, allowedTools: manifest?.allowedTools ?? null })
  if (!coverage.complete) {
    throw presetError(EMPLOYEE_PRESET_CODES.TOOL_UNCOVERED,
      `被授予的工具在 preset 里没有对应行，而且 Legion 宿主平面也不托管它们：` +
      `${JSON.stringify(coverage.missing.map((m) => m.toolName))}。` +
      '**失败而不是 warn**：一个静默丢掉的工具会让员工少一件工具，而这件事不报错',
      { coverage })
  }

  // ④ 组装行。
  const rows = []

  // persona 必须**第一个**：它 shadow 部署默认身份。
  const personaConfig = [`    prefix: ${quoteYaml(persona)}`]
  if (personaSuffix !== null) personaConfig.push(`    suffix: ${quoteYaml(personaSuffix)}`)
  rows.push(['- id: persona', "  name: '@deepseek-ai/dsh-persona'", '  config:', ...personaConfig].join('\n'))

  for (const section of promptSections) {
    rows.push(renderRow({ id: section.id ?? 'prompt-section', pkg: section.name, config: section.config }))
  }

  // 岗位工具集：行序**固定**（按 DSH_PRESET_ROWS 的键序），
  // 这样同一份授权渲染两次得到逐字节相同的文件。
  const wanted = new Set(coverage.rows)
  for (const key of Object.keys(DSH_PRESET_ROWS)) {
    if (!wanted.has(key)) continue
    const spec = DSH_PRESET_ROWS[key]
    const row = { id: key, pkg: spec.pkg }
    if (spec.platform === 'posix') row.disabledJs = "process.platform === 'win32'"
    if (spec.platform === 'win32') row.disabledJs = "process.platform !== 'win32'"
    // ★ 表的 `config` 必须**真的落到** YAML 上。
    // 漏这一行的话，`DSH_PRESET_ROWS` 里那份 config 就成了一句没人读的声明
    // ——而"表里写了"与"文件里有"，在只读表的用例上是同一个东西。
    if (spec.config !== undefined) row.config = spec.config
    rows.push(renderRow(row))
  }

  const header = [
    `# Legion 员工 agent preset：${id}`,
    '#',
    '# 由 runtime/dsh-composition/employee-preset.mjs 生成（legion/employee-preset@1）。',
    '# **不要手改**：下一次渲染会覆盖它，而手改的那一行不会出现在任何对账里。',
    '#',
    '# 平面：agent（spec §6.9 line 489）。只承载岗位能力，**不提供任何服务**。',
    '# 强制面（hard floor / pre-execute / approval answerer / preset 表）在 host 组合补丁层，',
    '# 见 runtime/dsh-composition/legion-host.patch.yml。',
    '#',
    `# 岗位工具集（由授权推导，不是手写）：`,
    // ★ **必须排序**。第一版按 `grant.allowedTools` 的顺序输出，
    //   于是同一份授权、只是清单里工具名换了顺序，就渲染出不同的文件。
    //
    //     > 一个"行序固定但表头随输入顺序变"的渲染器，
    //     > 与一个"每次渲染都产生一次伪变更"的渲染器，是同一个东西——
    //     > 只不过前者会让代码评审里出现一条没有实际内容的 diff。
    //
    //   表头与行序用**同一个**依据（工具名/能力名的字典序），
    //   这样"逐字节相同"这句话对整份文件成立，而不是只对下半部分成立。
    ...[...coverage.entries]
      .sort((a, b) => (a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0))
      .map((e) => {
        const how = e.status === 'covered'
          ? `preset 行 ${e.rows.join('+')}`
          : `host 平面（${e.reason ?? '宿主提供'}）`
        return `#   · ${e.toolName} — ${how}`
      }),
    ...(coverage.capabilities.length === 0
      ? []
      : [`# 能力：${[...coverage.capabilities].sort().join('、')}`]),
    ...(skills.length === 0 ? [] : [`# skill 引用：${[...skills].sort().join('、')}`]),
    '',
  ].join('\n')

  const composition = `${header}${rows.join('\n\n')}\n`

  const metadata = [
    `name: ${quoteYaml(displayName ?? manifest?.role ?? id)}`,
    `description: ${quoteYaml(description ?? `${manifest?.role ?? id} 岗位的 Legion 员工 agent preset。`)}`,
    '',
  ].join('\n')

  return Object.freeze({
    id,
    version: EMPLOYEE_PRESET_VERSION,
    coverage,
    files: Object.freeze({
      'agent.cordis.yml': composition,
      'preset.yml': metadata,
    }),
    text: composition,
  })
}

// ────────────────────────────────────────────────────────────── 安装

/**
 * 把一个渲染好的 preset 写到 preset 根目录下。
 *
 * **只写自己的目录**：`presetRoot` 是调用方给的（生产里是 Launcher 决定的
 * 用户 preset 根），本函数不猜路径、不读环境变量——
 * 一个自己去找 `$DSH_HOME` 的安装器与一个装到别处的安装器，
 * 在"装完了"这个读数上是同一个东西。
 *
 * 需要 `node:fs`，所以它是**宿主侧**能力；纯渲染（`renderEmployeePreset`）
 * 不依赖 fs，可以在任何地方跑。
 */
export async function installEmployeePreset({ presetRoot, preset, fs = null } = {}) {
  if (typeof presetRoot !== 'string' || presetRoot.trim() === '') {
    throw presetError(EMPLOYEE_PRESET_CODES.NO_ROOT,
      'installEmployeePreset 需要 presetRoot（不猜 $DSH_HOME：装到别处与装好了同形）')
  }
  if (preset === null || typeof preset !== 'object' || preset.files === undefined) {
    throw presetError(EMPLOYEE_PRESET_CODES.NO_MANIFEST, 'installEmployeePreset 需要 renderEmployeePreset() 的结论')
  }
  if (SHIPPED_PRESET_IDS.includes(preset.id)) {
    throw presetError(EMPLOYEE_PRESET_CODES.SHIPPED_ID_COLLISION,
      `拒绝往随部署分发的 preset 目录 ${preset.id} 写任何东西（spec §6.9 line 496）`)
  }

  const io = fs ?? await import('node:fs/promises')
  const { join } = await import('node:path')
  const dir = join(presetRoot, preset.id)
  await io.mkdir(dir, { recursive: true })

  const written = []
  for (const [name, body] of Object.entries(preset.files)) {
    const target = join(dir, name)
    await io.writeFile(target, body, 'utf8')
    written.push(target)
  }
  return Object.freeze({ id: preset.id, dir, files: Object.freeze(written) })
}

/** 对账读数：员工 preset 这一侧的"装上了什么"。 */
export const EMPLOYEE_PRESET_CHECKED = Object.freeze({
  version: EMPLOYEE_PRESET_VERSION,
  shippedIds: SHIPPED_PRESET_IDS,
  rows: Object.freeze(Object.keys(DSH_PRESET_ROWS)),
  contract: EMPLOYEE_PRESET_CONTRACT,
  /** 登记表里每一个工具都要有一个交代（否则渲染器会漏掉它）。 */
  routingCoversCatalog: Object.freeze(
    Object.keys(TOOL_CATALOG).filter((t) => LEGION_TOOL_ROUTING[t] === undefined),
  ),
  /** 表里每一行都要能被某个工具到达（否则它是一行永远装不上的行）。 */
  rowReachability: assertEveryRowReachable(),
  permitsTool,
})
