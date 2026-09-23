// runtime/dsh-composition/whitelist-port.mjs
// ============================================================================
// **岗位白名单的端口**：把执行面（DSH）的工具名翻译回 Legion 能力名，再交给
// `permitsTool()` 判定。这是 PRT-603 那一族里**最后一道没接上的强制面**。
//
// ## 它填的是哪个洞
//
// `tool-request.mjs:1066` 的 `whitelist` 端口今天在生产里恒为 `null` ⇒ 那一段
// `if (whitelist !== null)` **一次都不进入** ⇒ 岗位白名单对每一次工具调用
// **完全不存在**。而它有端口、有判定器、有 20 条用例——三者都在，缺的是
// **一个能把真名字喂进判定器的人**。
//
//   > 一个「判定器写得很仔细、而生产里那个端口恒为 null」的白名单，
//   > 与一个「根本没有岗位白名单」的部署，在"这次调用被它拦住了吗"这个问题上
//   > 是同一个答案：没有。
//
// ## ★★★ 为什么需要"翻译"，而这不推翻任何既有教义
//
// 既有的三条教义（`tool-capability.mjs:465-492`、`employee-manifest.mjs:315-338`、
// `whitelist-limb.test.mjs` ③）说的是同一件事：
//
//   > **岗位清单里写的是 Legion 能力名**（`read-file` / `git-push` / …），
//   > 而执行面交进来的是 DSH 工具名（`read` / `bash` / `web_fetch` / …），
//   > **两个名字空间结构上不相交**。
//
// 它们推出的是「**不要**把 DSH 名直接喂进 `permitsTool`」——本模块**完全同意**，
// 而且本模块就是**因为**同意才存在的：它不改变任何一边的词汇表，
// 只在**两者之间的那一层**做一次具名翻译。
//
// ★ 那么"翻译是不是一个没人裁过的决定"？**不是**。仓库里早就有一张
// **唯一权威**的表回答它：`employee-preset.mjs` 的 `LEGION_TOOL_ROUTING`
// （Legion 工具名 → `dshTools` 执行面名）。本模块**不新增**映射，
// 只**反向读**那一张表：
//
//   · `read-file → ['read','glob','grep']` ⇒ 反推 `read → read-file`；
//   · `run-command / git-status / git-commit / git-push → ['bash','pwsh']`
//     ⇒ 反推 `bash → 四个候选` —— **一对多**。
//
//   > 一个「在强制面那一层另写一张 DSH→Legion 表」的实现，
//   > 与一个「反向读那张已经把两套名字对起来的表」的实现，
//   > 在**今天**的读数上是同一片 ✔——只不过前者在有人只改一边的第二天
//   > 会让白名单开始放行一个已经改名的工具，而没有任何判据会红。
//
// ## ★★★ 一对多**不是**靠猜解决的——它是一条具名拒绝
//
// `whitelist-limb.test.mjs` ④ 量出：`bash` / `pwsh` 的反推集合各含 **4** 个
// Legion 工具，而那一堆里**同时塌着低风险的 `git-status` 与高风险的 `git-push`**。
//
// ⇒ 本模块**拒绝**在那一格上猜。裁决是：
//
//   · 反推**恰好一个** ⇒ 用那一个（`read` → `read-file`）；
//   · 反推**多于一个** ⇒ **拒绝**，并具名列出**是哪几个候选**
//     （`whitelist-limb-ambiguous` + `candidates`）。*值班的人必须拿到
//     "是哪几个"，否则"歧义"这个词本身给不出任何下一步*；
//   · 反推**零个**（未登记路由的执行面工具）⇒ **拒绝**
//     （`whitelist-limb-unrouted`）；
//   · 工具名**不在路由表里**（如 DSH 核心的 `todowrite`）⇒ **拒绝**
//     （`whitelist-limb-unknown-dsh-tool`）。
//
// ★ 后两条**不是**"没配"，是"这一层表达不出来"——与 `executionDenialFor()`
//   的 `hosted` / `unrouted` 两种理由同形（`employee-preset.mjs:248-253`）。
//   把"表达不出来"记成"放行"会让白名单在有 shell 的调用上**永远开着**；
//   记成"拒绝"是严格更严的方向，且**理由可归因**。
//
//   > 一个「一对多时按最宽的那个候选判定」的白名单，
//   > 与一个「只读岗位能跑 `git push`」的白名单，是同一个东西——
//   > 只不过前者在用例里写着"歧义已处理"。
//
// ## 与三道范围检查的**形状一致**
//
// `scope-port.mjs` / `execution-scope-port.mjs` / `external-api-scope-port.mjs`
// 三道的形状是"环境里配了才生效、缺席如实报 absent、配了却解释不通 ⇒ 抛"。
// 本模块**照抄那个形状**（不另发明一套），于是 `root-row.mjs` 里它是**第四行**
// 同形的接线，而 `enforcementSurfaces()` 那 9 格读数不需要新增格子。
// @module runtime/dsh-composition/whitelist-port
// ============================================================================

import { LEGION_TOOL_ROUTING } from './employee-preset.mjs'
import { permitsTool } from './employee-manifest.mjs'
import { normalizeManifest } from './employee-manifest.mjs'

export const WHITELIST_PORT_VERSION = 'legion/whitelist-port@1'

/**
 * 部署配置把**员工岗位清单**交给 Runtime 子进程用的环境键。
 *
 * ★ 与另外三道范围检查**不同的一点**，值得写下来：那三道配的是"范围表"，
 *   而这一道配的是**某一份岗位清单**。清单的字段闭合由 `normalizeManifest()`
 *   在**端口装配期**就查一遍——一个"第一次工具调用时才炸"的清单，
 *   与一个"装配时就拒绝"的清单，区别在于前者把错误推迟到**已经有副作用的那一刻**
 *   （与 `scope-port.mjs` 的决定 ③ 同一条理由）。
 */
export const WHITELIST_PORT_ENV_KEY = 'LEGION_EMPLOYEE_PERMIT'

/** 本模块从环境读取的键（**表**形态，供 `scripts/config/config.test.mjs` 反查）。 */
export const WHITELIST_PORT_ENV_KEYS = Object.freeze([WHITELIST_PORT_ENV_KEY])

/** 与 `scope-port.mjs` 同一套状态词：缺席是一件事，不是一个空值。 */
export const WHITELIST_PORT_STATES = Object.freeze({
  CONFIGURED: 'configured',
  ABSENT: 'absent',
})

export const WHITELIST_PORT_CODES = Object.freeze({
  BAD_INPUT: 'whitelist-port-bad-input',
  /** 环境里那份文本不是合法 JSON。 */
  BAD_PERMIT_TEXT: 'whitelist-port-bad-permit-text',
  /** 环境里那份清单过不了字段闭合 / 归一化。 */
  BAD_PERMIT: 'whitelist-port-bad-permit',
  /** 执行面工具名在 `LEGION_TOOL_ROUTING` 里**没有任何** Legion 工具与之对应。 */
  UNROUTED: 'whitelist-limb-unrouted',
  /** 执行面工具名对应**多个** Legion 工具 —— 拒绝，并给出候选集。 */
  AMBIGUOUS: 'whitelist-limb-ambiguous',
  /** 执行面工具名不在路由表里（既不是任何路由的 `dshTools`，也不是任何 Legion 工具名）。 */
  UNKNOWN_DSH_TOOL: 'whitelist-limb-unknown-dsh-tool',
  /** 部署给的归属裁决指向了候选之外的名字 —— 那会让这道检查对这次调用**静默失效**。 */
  BAD_DECISION: 'whitelist-limb-bad-decision',
  /** 投影里没有可用的工具名 —— 正常路径上不可达，只可能是接线坏了。 */
  NO_TOOL_NAME: 'whitelist-limb-no-tool-name',
})

function fail(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 反向读 `LEGION_TOOL_ROUTING`：DSH 工具名 → 可能承载它的 Legion 工具名（**升序**）。
 *
 * ★ 顺序**按 Legion 工具名排序**而不是按表里的出现顺序：一个"候选顺序取决于
 *   路由表书写顺序"的读数，在有人重排那张表之后会让**同一份歧义**给出不同的首选，
 *   而"首选"正是最容易被误用成"就按它判"的东西。
 *
 * @param {object} [routing]
 * @returns {ReadonlyMap<string, readonly string[]>}
 */
export function reverseRouting(routing = LEGION_TOOL_ROUTING) {
  if (!isPlainObject(routing)) {
    throw fail(WHITELIST_PORT_CODES.BAD_INPUT, 'reverseRouting 需要一份路由表对象')
  }
  const back = new Map()
  for (const legionName of Object.keys(routing)) {
    const route = routing[legionName]
    if (!isPlainObject(route)) continue
    // `hosted: true` 的行**没有**执行面名字（`employee-preset.mjs:226` 的同一处置）：
    // 猜一个名字就是凭空造一条永远命中不了的规则。
    if (route.hosted === true) continue
    for (const dsh of route.dshTools ?? []) {
      if (!back.has(dsh)) back.set(dsh, [])
      const bucket = back.get(dsh)
      if (!bucket.includes(legionName)) bucket.push(legionName)
    }
  }
  for (const [k, v] of back) back.set(k, Object.freeze([...v].sort()))
  return back
}

/**
 * 一次调用的**翻译**结果。
 *
 * 四态而不是布尔：`unique` 之外的三种**修法各不相同**
 * （去登记路由表 / 去裁决歧义 / 去补投影），合并成一个"不通过"会让下一个人
 * 从一个错的起点开始改。
 *
 * @param {object} p
 * @param {string} p.toolName 执行面工具名（投影里的 `projection.toolName`）
 * @param {object} [p.routing]
 * @param {object} [p.registry] **部署裁决过的**一对多归属表（DSH 名 → Legion 名）。
 *   只允许登记**确实歧义**的那些键（`bash` / `pwsh` / `web_fetch`）——
 *   给 `read` 登记一个归属是把一个已经确定的事实重新变成一次可被改错的裁决。
 * @returns {Readonly<{state: string, legionTool: string|null, candidates: readonly string[],
 *   code: string|null, reason: string|null}>}
 */
export function translateToolName({ toolName, routing = LEGION_TOOL_ROUTING, registry = {} } = {}) {
  const name = typeof toolName === 'string' ? toolName.trim() : ''
  if (name === '') {
    return Object.freeze({
      state: 'missing', legionTool: null, candidates: Object.freeze([]),
      code: WHITELIST_PORT_CODES.NO_TOOL_NAME,
      reason: '投影里没有工具名。正常路径上不可达（投影成功时一定有名字）——'
        + '只可能是接线坏了，而"证明不了它在白名单之内"必须是拒绝',
    })
  }
  const back = reverseRouting(routing)
  const candidates = back.get(name)

  if (candidates === undefined) {
    // ★ 两条"零候选"要分开：一种是**路由表里存在的 Legion 工具但 hosted**
    //   （`delete-file` / `read-secret` …），另一种是**谁都不认识这个名字**。
    //   两者的修法不同（前者这一层表达不出来，后者是路由表缺一条）。
    const hosted = Object.keys(routing).filter(
      (n) => routing[n]?.hosted === true && n === name,
    )
    if (hosted.length > 0) {
      return Object.freeze({
        state: 'hosted', legionTool: null, candidates: Object.freeze([]),
        code: WHITELIST_PORT_CODES.UNROUTED,
        reason: `工具 ${name} 是**宿主平面**能力（\`hosted: true\`），执行面上没有它的工具名——`
          + '因此这一层既翻译不出、也拦不住它。这不是"不用管"，是"这一层表达不出来"',
      })
    }
    return Object.freeze({
      state: 'unrouted', legionTool: null, candidates: Object.freeze([]),
      code: WHITELIST_PORT_CODES.UNKNOWN_DSH_TOOL,
      reason: `执行面工具 ${name} 在 LEGION_TOOL_ROUTING 里没有任何归属——`
        + '既不是任何一条路由的 `dshTools`，也不是被 `hosted` 排除掉的那几个。'
        + '⇒ 要么它是 DSH 自带的核心工具（不该由这份路由表管），'
        + '要么路由表缺了一条。**先查是哪一种**：猜一个归属就是凭空造一条规则',
    })
  }
  if (candidates.length > 1) {
    // ★★★ 先看**部署裁决过**的归属表。一对多不是"永远无解"——它是
    //   "本模块不猜，而部署可以**具名**裁决一次"。裁决必须落在**歧义键**上。
    const decided = isPlainObject(registry) ? registry[name] : undefined
    if (decided !== undefined) {
      if (typeof decided !== 'string' || !candidates.includes(decided)) {
        return Object.freeze({
          state: 'ambiguous', legionTool: null, candidates,
          code: WHITELIST_PORT_CODES.BAD_DECISION,
          reason: `「${name}」的归属裁决 ${JSON.stringify(decided)} 不是它的候选之一`
            + `（候选是 ${JSON.stringify(candidates)}）——`
            + '一个指向候选之外的裁决，与一条永远命中不了的规则，是同一个东西：'
            + '它看起来把歧义解决了，而实际效果是这道检查对这一次调用**静默失效**',
        })
      }
      return Object.freeze({
        state: 'decided', legionTool: decided, candidates,
        code: null, reason: null,
      })
    }
    return Object.freeze({
      state: 'ambiguous', legionTool: null, candidates,
      code: WHITELIST_PORT_CODES.AMBIGUOUS,
      reason: `执行面工具 ${name} 对应**多个** Legion 工具（${JSON.stringify(candidates)}）——`
        + '本模块**不猜**：那些候选里可能同时塌着低风险与高风险的命令'
        + '（`bash` 就是这一形：`git-status` 与 `git-push` 共用它）。'
        + '按"最宽的那个"判定会让只读岗位能跑 `git push`；按"最严的那个"判定'
        + '会让一次 `git status` 被拒。⇒ 这一格需要一次裁决，不是一次兜底'
        + `（裁决写在「${name}」的归属表里，只许指向上面那组候选之一）`,
    })
  }
  return Object.freeze({
    state: 'unique', legionTool: candidates[0], candidates,
    code: null, reason: null,
  })
}

/**
 * 清单 + 一次投影 → 白名单端口。
 *
 * @param {object} p
 * @param {object} p.permit 已归一化的**有效许可**（`narrowToGrant()` 的产物）
 * @param {object} [p.routing]
 * @param {object} [p.registry] 部署裁决的**一对多**归属表（见 `translateToolName`）。
 * @returns {(projection: object) => {allowed: boolean, rule: string|null, reason: string|null}}
 * @throws {Error} `permit` 过不了归一化时（装配期就拒，不留到第一次调用）
 */
export function createWhitelistPort({ permit, routing = LEGION_TOOL_ROUTING, registry = {} } = {}) {
  if (!isPlainObject(permit)) {
    throw fail(WHITELIST_PORT_CODES.BAD_INPUT, 'createWhitelistPort 需要一份许可对象（permit）')
  }
  // ★ 装配期归一化：字段闭合与取值合法性**现在**就查。`normalizeManifest` 对
  //   不合法的清单会**抛**（不是返回 null），这里**原样上抛**——
  //   一个"第一次工具调用时才炸"的白名单，看起来像"这一次调用有问题"。
  const normalized = normalizeManifest({ ...permit, version: permit.version ?? 'legion/employee-manifest@1' })

  return function whitelistPort(projection) {
    if (!isPlainObject(projection)) {
      return Object.freeze({
        allowed: false,
        rule: WHITELIST_PORT_CODES.NO_TOOL_NAME,
        reason: '岗位白名单收到一个不是对象的投影',
      })
    }
    const translated = translateToolName({ toolName: projection.toolName, routing, registry })
    // ★★★ 两个成功态：`unique`（反推只有一个）与 `decided`（部署对歧义做过裁决）。
    //
    //   第一版这里写的是 `!== 'unique'`，于是**登记了裁决反而恒拒**：
    //   裁决那一支把 `state` 记成 `decided`（它确实不是 `unique`），
    //   却被这条判据当成失败挡回去了。
    //
    //   > 一个「裁决写对了、而这一格恒拒」的实现，
    //   > 与一个「裁决根本没生效」的实现，在 `allowed:false` 上是同一个读数——
    //   > 只不过前者的理由栏是**空的**（因为拒绝时 `translated.code` 是 `null`），
    //   > 于是值班的人拿到一条没有理由的拒绝。
    //
    //   ★ 这条缺陷是`scripts/probes/_probe-r112-whitelist.mjs` 的读数逼出来的：
    //     它打印原始返回，`rule: null` + `translationState: 'decided'` 当场现形。
    //     只断言 `allowed === false/true` 的用例**看不见它**。
    if (translated.state !== 'unique' && translated.state !== 'decided') {      // ★ 拒绝理由里带上**是哪一步拒的**：`rule` 是给桥去拼文案的，
      //   而这里几种 state 的码各不相同，所以值班的人分得清
      //   "去登记路由表" / "去裁决歧义" / "去补投影"。
      return Object.freeze({
        allowed: false,
        rule: translated.code,
        reason: translated.reason,
        translationState: translated.state,
        candidates: translated.candidates,
      })
    }
    // ★ `capabilities` **刻意不传**（第三参缺席）：投影里的能力集是**执行面**
    //   词汇（`command:exec` / `file:read` …），而 `permitsTool` 要比的是
    //   `permit.allowedCapabilities` ——**Legion 能力词表**。传错词表会让
    //   "能力不都在允许集合里"这条规则在**每一次**调用上触发，而理由是编的。
    //   名字已经是 Legion 名了，`permitsTool` 自己会 `resolveTool()` 出正确的能力集。
    const verdict = permitsTool({ permit: normalized, toolName: translated.legionTool })
    return Object.freeze({
      allowed: verdict.allowed === true,
      rule: verdict.allowed === true ? null : (verdict.rule ?? 'whitelist-unspecified'),
      reason: verdict.allowed === true
        ? null
        : `${verdict.reason ?? '没有给出理由'}（翻译得到的是 ${translated.legionTool}）`,
      legionTool: translated.legionTool,
    })
  }
}

/**
 * 从 Runtime 子进程的环境里取那份岗位清单。
 *
 * ★ 缺席**如实**记成 `absent`（与另外三道**同一口径**）：没配不等于
 *   "没有岗位白名单"，处置归组合根——组合根拿到 `port: null` 时，
 *   `enforcementSurfaces().whitelist` 就还是 `false`（**没接就是没接**）。
 *
 * ★ 而配了却解释不通 ⇒ **抛**：那是配置错误，不是"没配"。
 *
 * ## 一对多的裁决从哪来：**许可对象自己的** `toolNameDecisions`
 *
 * 归属裁决**不另开一个环境键**，而是作为许可对象的一个字段下发。理由是一条
 * 已经在本仓栽过的形状：
 *
 *   > 一个「许可与它的裁决分两个键下发」的配置，
 *   > 与一个「裁决跟到了别的岗位上、而许可还是旧的」的配置，
 *   > 在两次配置都合法时是同一个东西——只不过后者会让**另一个岗位**的白名单
 *   > 按这份裁决去判，而两次配置各自都过得了校验。
 *
 * ★ 而 `toolNameDecisions` 是**强制面平面**的字段，`normalizeManifest` 的字段闭合
 *   会把它当未知字段拒掉。所以顺序是：**先摘出来**、再归一化主体、
 *   最后把裁决单独校验一遍。摘出来的那一步必须显式，不能靠"多余字段被顺手丢掉"。
 *
 * @param {object} p
 * @param {object} p.env
 * @param {object} [p.routing]
 * @returns {{state: string, port: Function|null, permit: object|null,
 *   decisions: object, reason: string|null}}
 */
export function whitelistPortFromEnv({ env, routing = LEGION_TOOL_ROUTING } = {}) {
  if (!isPlainObject(env)) {
    throw fail(WHITELIST_PORT_CODES.BAD_INPUT, 'whitelistPortFromEnv 需要一个环境对象')
  }
  const raw = env[WHITELIST_PORT_ENV_KEY]
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return Object.freeze({
      state: WHITELIST_PORT_STATES.ABSENT,
      port: null,
      permit: null,
      decisions: Object.freeze({}),
      reason: `环境里没有「${WHITELIST_PORT_ENV_KEY}」。这**不是**"这个岗位没有白名单"——`
        + '执行面在端口为 null 时那一段根本不进入（放行），所以这个缺席要由组合根显式处置',
    })
  }

  let declaration = raw
  if (typeof raw === 'string') {
    try {
      declaration = JSON.parse(raw)
    } catch (err) {
      throw fail(
        WHITELIST_PORT_CODES.BAD_PERMIT_TEXT,
        `「${WHITELIST_PORT_ENV_KEY}」不是合法 JSON（${err?.message ?? err}）。`
        + '不忽略这一段：一份被静默丢掉的岗位清单，与一份"什么都没限制"的清单，读数一样',
      )
    }
  }
  if (!isPlainObject(declaration)) {
    throw fail(
      WHITELIST_PORT_CODES.BAD_PERMIT,
      `「${WHITELIST_PORT_ENV_KEY}」必须是一个对象（一份有效许可），收到 ${JSON.stringify(declaration)}`,
    )
  }

  // ★ 显式摘出裁决表。**不靠** normalizeManifest 顺手丢掉多余字段——
  //   那会让"裁决写错了位置"表现成"裁决不存在"，而两者的修法不同。
  const { toolNameDecisions, ...body } = declaration
  const decisions = toolNameDecisions === undefined ? {} : toolNameDecisions
  if (!isPlainObject(decisions)) {
    throw fail(
      WHITELIST_PORT_CODES.BAD_DECISION,
      `许可里的 toolNameDecisions 必须是一个对象（DSH 工具名 → Legion 工具名），`
      + `收到 ${JSON.stringify(toolNameDecisions)}`,
    )
  }

  let permit
  try {
    permit = normalizeManifest({ version: 'legion/employee-manifest@1', ...body })
  } catch (err) {
    throw fail(
      WHITELIST_PORT_CODES.BAD_PERMIT,
      `「${WHITELIST_PORT_ENV_KEY}」过不了岗位清单的字段闭合：${err?.message ?? String(err)}`,
    )
  }

  // ★★ 裁决表在**装配期**逐键校验，不留到第一次工具调用。三条，各有各的下一手：
  //   ① 键**不歧义**（`read` / `write` / `edit` / `glob` / `grep`）⇒ 拒绝。
  //      *给一个已经确定的事实登记一次"裁决"，等于把它重新变成一个可被改错的值*；
  //   ② 键**根本不在路由表里** ⇒ 拒绝（一条永远命中不了的规则）；
  //   ③ 值**不在候选之内** ⇒ 拒绝（同"永远命中不了"）。
  //   三条都在这里，而不是留给 `translateToolName` 在每次调用上重复判。
  const back = reverseRouting(routing)
  for (const [key, value] of Object.entries(decisions)) {
    const cands = back.get(key)
    if (cands === undefined) {
      throw fail(
        WHITELIST_PORT_CODES.BAD_DECISION,
        `toolNameDecisions 里的「${key}」不是任何一条路由的执行面工具名——`
        + '这条裁决永远命中不了任何一次调用。要么名字拼错了，要么它本来就不需要裁决',
      )
    }
    if (cands.length <= 1) {
      throw fail(
        WHITELIST_PORT_CODES.BAD_DECISION,
        `toolNameDecisions 给「${key}」登记了裁决，而它**本来就不歧义**`
        + `（候选 ${JSON.stringify(cands)}）——`
        + '一个已经确定的事实被重新变成一个可被改错的值：'
        + '今天它对，而路由表加一条之后它会安静地变成错的',
      )
    }
    if (typeof value !== 'string' || !cands.includes(value)) {
      throw fail(
        WHITELIST_PORT_CODES.BAD_DECISION,
        `toolNameDecisions 把「${key}」判给了 ${JSON.stringify(value)}，而它的候选是 `
        + `${JSON.stringify(cands)}——该层会因此**静默拒绝**每一次 ${key} 调用，`
        + '而拒绝理由会指向一个不存在的归属',
      )
    }
  }

  return Object.freeze({
    state: WHITELIST_PORT_STATES.CONFIGURED,
    port: createWhitelistPort({ permit, routing, registry: decisions }),
    permit,
    decisions: Object.freeze({ ...decisions }),
    reason: null,
  })
}
