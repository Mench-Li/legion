// runtime/dsh-composition/enforcement.mjs
// ============================================================================
// Legion 强制面原语（PRT-212）
//
// 三个强制点，各自只有一种语义：
//
//   guard         同步、确定性、**只有降级语义**。返回 reason 即拒绝。
//   pre-execute   动态 allow / deny / ask。fail closed。
//   approval      answerer waterfall 的一个参与者，返回 `allowed-once` 才放行。
//
// ## 本文件为什么零 DSH import
//
// 它实现的是**策略**，不是 DSH 的 API。策略可以在没有 DSH 的环境里被穷举测试：
// 超时、异常、并发、哈希漂移这些路径恰恰是真实故障最集中的地方，
// 而它们用真 DSH 几乎无法稳定复现。因此本文件用**结构化类型**描述契约
// （见下面各 `@typedef`），并由 `runtime/dsh-composition/install.mjs` 适配到真实 API。
//
// ## 一个贯穿全文件的判据：fail closed 要**可归因**
//
// 「拒绝了」不够，还要说得出**是哪个强制点、因为什么**拒绝的。
// 把策略拒绝与沙箱兜底拒绝混成一句「不允许」，会让修复动作无从下手：
// 前者要改策略，后者要改沙箱配置。因此每个决定都带 `source`。
// ============================================================================

import { createHash } from 'node:crypto'
import { canonicalJson } from '../contracts/canonical.mjs'

/** 强制点来源（§6.8 的 `tool_calls` 必须记录的字段）。 */
export const ENFORCEMENT_SOURCES = Object.freeze(['pre-execute', 'guard', 'approval', 'sandbox'])

/** 静态 hard floor 的默认规则集：不接受人工批准影响的那部分。 */
export const DEFAULT_HARD_FLOOR = Object.freeze({
  denyTools: Object.freeze([]),
  denyPathPrefixes: Object.freeze([]),
})

/**
 * **静态 hard floor 能力名单的唯一一份。**
 *
 * spec §6.8（`2026-09-11-legion-product-runtime-design.md:456`）把「hard floor」
 * 映射到「pre-execute 提前拒绝 + guard 最终复核」，而这两道闸都在本模块：
 * `DEFAULT_HARD_FLOOR` 是它们的空装配，`createHardFloorGuard()` 与
 * `composePreExecuteFloor()` 是它们的实现。名单因此放在**定义强制面**的一侧，
 * 而不是放在某一个消费方那里。
 *
 * ★ 放在这里还有一个方向上的理由，与 `enforcement-mapping.mjs:101-116` 记的是同一条：
 * `team-hub/` → `runtime/` 是本仓库既有的分层方向，而 `runtime/` → `team-hub/`
 * 是 **0 处**。名单落在本模块里，两个消费方拿到的是**同一个数组对象**：
 *
 *   · `team-hub/run-floor.mjs` → 本模块（team-hub → runtime，既有方向）
 *   · `runtime/dsh-composition/tool-capability.mjs` → 同目录的 `./enforcement.mjs`
 *
 * 于是「只有一份名单」是**构造上**成立的：不需要一条对拍用例去维持它，
 * 也不需要为了取一个常量反转一条已经一致的方向。
 *
 *   > 一个「两边各自声明、由一条用例断言相等」的一致，
 *   > 与一个「两边取的是同一个数组对象」的一致，
 *   > 在没有人只改一边的那些日子里是同一个东西——
 *   > 只不过前者的守卫是纪律，后者的守卫是引用。
 *
 * 三个名字是 §6.8 那三类"静态面"里落在**不可逆**上的那一组：
 * 删文件回不来、推远端别人也看得到、写密钥会让已录入的凭证无法恢复。
 * 想加一条就在这里加——改完两边同时变，这正是它只有一份的理由。
 */
export const HARD_FLOOR_CAPABILITIES = Object.freeze([
  'file:delete',
  'repo:push',
  'credential:write',
])

// ----------------------------------------------------------------- canonical op

/** canonical operation 的 schema 版本。**改变 canonical 形式必须递增它。** */
export const CANONICAL_OP_SCHEMA_VERSION = 1

/** domain separator：防止不同用途的哈希互相碰撞。 */
export const CANONICAL_OP_DOMAIN = 'legion.tool-execution.v1'

/**
 * 参与授权哈希的顶层字段，**顺序固定**。
 *
 * attemptId、UI 文案、时间戳等观察 metadata **不参与**：
 * 把它们算进去会让「同一个不可变操作」在不同观察时点得到不同哈希，
 * 于是一次批准无法覆盖真正相同的那次调用 —— 而审批的意义正是如此。
 */
export const CANONICAL_OP_KEYS = Object.freeze(['scope', 'actor', 'action', 'target', 'taskId', 'toolName', 'callId', 'arguments'])

/**
 * 规范化一个字符串：Unicode NFC。
 *
 * 不做 NFC 会让「看起来一样」的两个标识串得到不同哈希
 * （组合字符 vs 预组合字符），表现为「明明批准了却还是被拒」。
 */
export function nfc(value) {
  return String(value).normalize('NFC')
}

/**
 * 路径绝对化 + 分隔符统一。
 *
 * Windows 大小写规则：盘符与整串按**小写**归并。
 * 不做这一步，`C:\Work\a.txt` 与 `c:\work\A.TXT` 会是两个不同的哈希 ——
 * 而在这台机器上它们是同一个文件，于是「批准了 A 却写到了 a」无法被发现。
 *
 * 非绝对路径按 `cwd` 展开。`cwd` 缺失时**不猜**：直接抛错，
 * 因为猜出来的绝对路径会让哈希依赖于某个恰好生效的工作目录，而那是隐式状态。
 */
export function canonicalizePath(input, { cwd, platform = process.platform } = {}) {
  const raw = nfc(input).replace(/\\/g, '/').replace(/\/+$/, '')
  const isAbsolute = raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || raw.startsWith('//')
  let abs = raw
  if (!isAbsolute) {
    if (typeof cwd !== 'string' || cwd === '') {
      throw new Error(`无法规范化相对路径 ${JSON.stringify(input)}：缺少 cwd（不猜工作目录）`)
    }
    abs = `${nfc(cwd).replace(/\\/g, '/').replace(/\/+$/, '')}/${raw}`
  }
  // 折叠 `.` 与 `..`：不折叠会让 `a/../b` 与 `b` 哈希不同，而它们是同一个目标。
  const parts = []
  for (const seg of abs.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { parts.pop(); continue }
    parts.push(seg)
  }
  let out = parts.join('/')
  // 保留前导 `/`（POSIX 绝对路径）与 `//`（UNC 前缀）这两处结构信息
  if (abs.startsWith('//')) out = `//${out}`
  else if (abs.startsWith('/')) out = `/${out}`
  return platform === 'win32' ? out.toLowerCase() : out
}

// canonicalJson / canonicalScalar 现在来自**共享基础库**（PRT-401/413）。
// 原先这里有一份自己的实现：两份今天行为一致，而**没有任何东西在维持它**——
// 只要有人改了其中一份的键排序或 -0 处理，审批与快照就会对"同样的内容"
// 给出不同哈希，而**两边各自的用例都还是绿的**。重导出以保持既有 import 面不变。
export { canonicalJson, canonicalScalar } from '../contracts/canonical.mjs'
/**
 * 计算一次工具执行的 canonical operation 哈希。
 *
 * @param {object} op 授权关键字段，见 {@link CANONICAL_OP_KEYS}
 * @returns {string} `sha256:<hex>`
 */
export function canonicalOperationHash(op, { cwd, platform = process.platform } = {}) {
  if (op === null || typeof op !== 'object') throw new Error('canonical operation 必须是对象')
  const normalized = {}
  for (const key of CANONICAL_OP_KEYS) {
    const v = op[key]
    if (v === undefined) throw new Error(`canonical operation 缺少必需字段：${key}`)
    normalized[key] = key === 'target' ? canonicalizePath(v, { cwd, platform }) : v
  }
  const payload = `${CANONICAL_OP_DOMAIN}\u0000${CANONICAL_OP_SCHEMA_VERSION}\u0000${canonicalJson(normalized)}`
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`
}

// ----------------------------------------------------------------- hard floor

/**
 * 构造静态 hard floor guard（§6.8：「Guard 只做同步、确定性拒绝；后续流程不可撤销」）。
 *
 * 三条不可协商的性质，都写成断言而不是注释：
 *   · **同步**：不能 await。guard 位于 pre-execute 之后，把它变成异步
 *     会让「最终」这个语义消失 —— 后面的 listener 又能翻案了。
 *   · **只降级**：返回 `string`（拒绝理由）或 `undefined`（不动）。
 *     永远没有「允许」这个返回值，因此顺序无关。
 *   · **不受审批影响**：hard floor 不看批准。能被批准的就不叫下限。
 */
export function createHardFloorGuard(floor = DEFAULT_HARD_FLOOR) {
  const denyTools = new Set((floor.denyTools ?? []).map(nfc))
  const denyPathPrefixes = (floor.denyPathPrefixes ?? []).map((p) => canonicalizePath(p, { cwd: floor.cwd, platform: floor.platform }))

  /** @type {import('./enforcement.mjs').ToolGuardLike} */
  const guard = (execution) => {
    if (execution === null || typeof execution !== 'object') return 'hard floor：执行对象缺失'
    const name = nfc(execution.name ?? '')
    if (denyTools.has(name)) return `hard floor：工具 ${name} 被静态禁止（不可由审批解除）`

    // 路径类参数逐一比对。**只检查参数里确实出现的路径**，
    // 不推断工具语义 —— 推断会在工具改名时静默失效。
    const target = execution.arguments?.path ?? execution.arguments?.target ?? execution.arguments?.file_path
    if (typeof target === 'string' && denyPathPrefixes.length > 0) {
      let abs
      try {
        abs = canonicalizePath(target, { cwd: floor.cwd, platform: floor.platform })
      } catch {
        // 路径无法规范化（没有 cwd）→ 不能证明它不在禁止前缀下 → 拒绝。
        return `hard floor：路径 ${target} 无法规范化，无法证明其不在禁止范围内`
      }
      for (const prefix of denyPathPrefixes) {
        if (abs === prefix || abs.startsWith(`${prefix}/`)) {
          return `hard floor：路径落入静态禁止范围（${prefix}）`
        }
      }
    }
    return undefined
  }

  guard.__legionGuardKind = 'hard-floor'
  return guard
}

// ----------------------------------------------------------------- pre-execute

/** 策略门的判定结果（对应 DSH 的 PreToolDecision）。 */
export const PRE_DECISIONS = Object.freeze({
  allow: () => ({ kind: 'allow' }),
  deny: (reason) => ({ kind: 'deny', reason }),
  ask: (reason) => (reason === undefined ? { kind: 'ask' } : { kind: 'ask', reason }),
})

// ------------------------------------------------------- 可用性：两个阶段（PRT-617）

/**
 * 强制点的两个阶段。
 *
 * **必须分开观测**：连接快而响应慢是"策略算得慢"，连接就慢是"team-hub 不健康"。
 * 两者的处置不同，合成一个总超时会把这个区分丢掉——丢掉之后，值班的人拿到
 * "策略门超时了"只能两边都查一遍，而其中一边根本没问题。
 */
export const ENFORCEMENT_PHASES = Object.freeze(['connect', 'response'])

/**
 * 不可用的分类码。**每个阶段都有自己的码**，另外还有两个"不归因"的诚实码。
 *
 * 闭集之外的东西不许出现：一个可以是任意字符串的 `code` 字段会退化成一句"出错了"，
 * 而审计要回答的是"去哪一边修"。
 */
export const AVAILABILITY_CODES = Object.freeze({
  /** 连接阶段：端口声明了分阶段契约，却在连接窗口内没有任何回应。 */
  CONNECT_TIMEOUT: 'enforcement-connect-timeout',
  /** 响应阶段：端口自报了连接建立，但响应窗口内没有答案。 */
  RESPONSE_TIMEOUT: 'enforcement-response-timeout',
  /** 端口抛错且**尚未**自报连接建立：team-hub 不可达（拒绝连接 / DNS / 隧道断）。 */
  UNREACHABLE: 'enforcement-team-hub-unreachable',
  /** 端口抛错但**已经**自报连接建立：不是不可达，是这一次请求本身失败。 */
  PORT_ERROR: 'enforcement-port-error',
  /** 端口返回了闭集之外的判定。 */
  MALFORMED: 'enforcement-malformed-port-result',
  /**
   * 超时了，而端口**从未自报阶段边界**：无法归因到某一段。
   *
   *   > 一个「超时了、但归因到错的那一段」的分类，
   *   > 与一个「把值班的人派去修另一边」的分类，是同一个东西。
   */
  PHASE_UNREPORTED: 'enforcement-phase-unreported',
})

/** 分类码 → 它属于哪一段（`null` = 这次分类**不归因**到任何一段，不猜）。 */
export const AVAILABILITY_PHASE_OF = Object.freeze({
  [AVAILABILITY_CODES.CONNECT_TIMEOUT]: 'connect',
  [AVAILABILITY_CODES.RESPONSE_TIMEOUT]: 'response',
  [AVAILABILITY_CODES.UNREACHABLE]: 'connect',
  [AVAILABILITY_CODES.PORT_ERROR]: 'response',
  [AVAILABILITY_CODES.MALFORMED]: null,
  [AVAILABILITY_CODES.PHASE_UNREPORTED]: null,
})

/**
 * 端口契约：`onConnected()`。
 *
 * 端口在**连接建立**的那一刻调用它一次；响应窗口从那一刻开始计时。
 *
 * ## 为什么"端口有没有自报阶段边界"必须显式声明
 *
 * 一个从不自报的端口，与一个"我们分不清它卡在哪一段"的端口，是同一个东西。
 * 于是只有两条路：猜一段（把一半的故障派给错的人），或者如实说"不知道"。
 * 本模块选后者——`PHASE_UNREPORTED` 就是那句"不知道"。
 *
 * 但"不知道"不能是终点：需要分段的调用方应当声明 `portsPhases: true`，
 * 于是连接窗口成为**硬期限**，到期即 `CONNECT_TIMEOUT`。声明之后就不再有不归因
 * 的情形，两个阶段各自可观测。**声明与否是调用方的事实，不是我们猜出来的。**
 */
async function runWithPhaseDeadlines(invoke, {
  connectTimeoutMs, responseTimeoutMs, portsPhases = false, now = () => Date.now(), label,
}) {
  const started = now()
  const budget = connectTimeoutMs + responseTimeoutMs
  let timer = null
  let settled = false
  let connected = false
  let rejectGate = null

  const gate = new Promise((_, reject) => { rejectGate = reject })

  const failWith = (code, phase, ms) => {
    const where = phase === 'connect' ? '连接阶段' : phase === 'response' ? '响应阶段' : '阶段未自报'
    const err = new Error(`${label}不可用（${where}，${code}，${ms}ms）`)
    err.code = code
    err.phase = phase
    err.phaseDeclared = portsPhases
    err.connected = connected
    rejectGate(err)
  }

  // 剩余预算。连接窗口之后才开始的那一段必须是"剩下的那些"：
  // 一个迟到的连接自报不该把总预算撑成两倍——Run 有期限约束。
  const remaining = () => Math.max(1, budget - (now() - started))
  const arm = (code, phase, ms) => {
    timer = setTimeout(() => { if (!settled) failWith(code, phase, ms) }, ms)
  }

  if (portsPhases) {
    arm(AVAILABILITY_CODES.CONNECT_TIMEOUT, 'connect', connectTimeoutMs)
  } else {
    timer = setTimeout(() => {
      if (settled || connected) return
      // 连接窗口到期但端口没自报：**不判失败**（它仍可能在总预算内给出答案），
      // 转入剩余预算；此时超时只能报"阶段未自报"。
      arm(AVAILABILITY_CODES.PHASE_UNREPORTED, null, remaining())
    }, connectTimeoutMs)
  }

  const onConnected = () => {
    if (settled || connected) return
    connected = true
    if (timer !== null) clearTimeout(timer)
    arm(AVAILABILITY_CODES.RESPONSE_TIMEOUT, 'response', Math.min(responseTimeoutMs, remaining()))
  }

  try {
    const value = await Promise.race([invoke(onConnected), gate])

    // ★★ 迟到的答案不是答案（PRT-212 补：本批修的缺陷）。
    //
    // 上面的闸门是一个**计时器**，而计时器抢不了同步代码：端口只要在返回前把事件循环
    // 占住（同步阻塞、一次长 GC、别的插件在同一个 tick 里干重活），闸门就一次也 fire
    // 不了，于是一个**远远超期**的答案会直接赢下 `Promise.race`。
    // 事件循环只是卡顿超过总预算时也一样：那一刻 `remaining()` 被夹到 1ms，
    // 谁先结算取决于计时器的插入顺序——那是一个硬币。
    //
    // 本仓库那条 PRT-212 用例（`tool-request.test.mjs`「自报了连接才算响应阶段超时」）
    // 长期抖动就是这个硬币：干净树上单独跑 6 次红 4 次，失败时那一侧返回 `allowed-once`。
    // 一个"偶尔把超期的放行当成决定"的审批箱，在真实系统里是一类**最坏**的失败：
    // 它看起来像"用户批准了"。
    //
    //   > 一个"超时了"的判据，如果只由计时器表达，与一个"谁先结算谁赢"的判据，
    //   > 在事件循环从不卡顿的世界里是同一个东西——
    //   > 只不过前者的承诺会在下一次卡顿时变成后者。
    //
    // 所以判据要在**端口返回之后**再核一次：期限是**事实**，不是一次调度。
    // 形状与 `approval` 入边那条后置核验同源——"端口被调用过 ≠ 那一行存在"，
    // 所以进 `AwaitingApproval` 之后要回头查库；这里是"端口返回过 ≠ 它在期限内返回过"。
    const elapsedMs = now() - started
    if (elapsedMs > budget) {
      // 归因口径与计时器路径保持一致：自报过连接就是响应阶段超时；
      // 没自报时，声明了分段的调用方拿 `CONNECT_TIMEOUT`，没声明的拿"阶段未自报"。
      const code = connected
        ? AVAILABILITY_CODES.RESPONSE_TIMEOUT
        : (portsPhases ? AVAILABILITY_CODES.CONNECT_TIMEOUT : AVAILABILITY_CODES.PHASE_UNREPORTED)
      const phase = AVAILABILITY_PHASE_OF[code]
      const where = phase === 'connect' ? '连接阶段' : phase === 'response' ? '响应阶段' : '阶段未自报'
      const err = new Error(`${label}不可用（${where}，${code}，${elapsedMs}ms）：` +
        `端口在期限（${budget}ms）之后才给出答案，这个答案不算数。` +
        '**不降级**成"它毕竟答了"——审批箱的截止时间来自 Run 的期限约束，' +
        '晚到的放行与没有放行，在下游看来必须是同一件事')
      err.code = code
      err.phase = phase
      err.phaseDeclared = portsPhases
      err.connected = connected
      err.lateAnswer = true
      err.elapsedMs = elapsedMs
      throw err
    }
    return value
  } catch (err) {
    // 端口自己抛的错：按"有没有自报连接建立"归因。一律叫"不可达"会让一次
    // "策略请求本身失败"被读成"team-hub 挂了"，于是排查方向从一开始就是错的。
    if (typeof err?.code === 'string' && AVAILABILITY_PHASE_OF[err.code] !== undefined) throw err
    const code = connected ? AVAILABILITY_CODES.PORT_ERROR : AVAILABILITY_CODES.UNREACHABLE
    const wrap = new Error(`${label}不可用（${connected ? '响应阶段' : '连接阶段'}，${code}）：${err?.message ?? String(err)}`)
    wrap.code = code
    wrap.phase = AVAILABILITY_PHASE_OF[code]
    wrap.phaseDeclared = portsPhases
    wrap.connected = connected
    wrap.reason = err
    throw wrap
  } finally {
    settled = true
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * 构造一次分类（`code` 必须是闭集里的码）。供**不经过异常**的归类使用，
 * 例如端口返回了闭集外的值——那不是抛错，是"这个端口现在不可信"。
 */
export function availabilityOf(code, detail, { phaseDeclared = false, connected = false, lateAnswer = false } = {}) {
  if (AVAILABILITY_PHASE_OF[code] === undefined) {
    throw new Error(`未知的可用性分类码 ${JSON.stringify(code)}（闭集之外的东西不能进审计）`)
  }
  return Object.freeze({
    unavailable: true,
    code,
    phase: AVAILABILITY_PHASE_OF[code] ?? null,
    phaseDeclared,
    connected,
    // ★ `lateAnswer`：端口**答了，但答晚了**。
    //
    // 不带上这一项，"超期才到的答案"与"端口根本没答"在审计里是同一个读数
    // ——而这两件事该派去查的地方完全不同：前者要去看那个端口为什么慢
    // （它活着、链路通、只是在期限之后才回来），后者要去看它是不是挂了。
    //
    //   > 一个"答了但答晚了"的读数，与一个"没答"的读数，
    //   > 在只有 `code` 一个字段的时候是同一个东西——
    //   > 只不过前者会让人去查一个根本没挂的服务。
    //
    // ⚠️ 这里**不放** `elapsedMs`：它已经由 `createApprovalAnswerer` 的 `finish()`
    // 放在同一个对象上了，而且那是**权威**值。第一版在这里也加了 `elapsedMs: null`，
    // 它在展开时覆盖掉 `finish()` 的数值，把 `availability.test.mjs` 里
    // 「`typeof elapsedMs === 'number'`」那条断言打破——**重复的字段不是冗余，是遮蔽。**
    lateAnswer,
    detail,
  })
}

/**
 * 把一次失败归类成"哪个强制点、哪一段、什么码"。
 *
 * 它是 `err.code` 的唯一读法：**闭集之外一律当作"我们不知道"**。把未知错误
 * 读成"没问题"是这一层最坏的一种兜底；读成"不可达"至少会让人去检查连接。
 *
 * `phaseDeclared` / `connected` 是这次归因的**依据**，一并带出去：
 * 审计要能区分"连接阶段真的失败了"与"端口根本没自报过阶段边界"。
 */
export function classifyAvailability(err) {
  const known = typeof err?.code === 'string' && AVAILABILITY_PHASE_OF[err.code] !== undefined
  const detail = err?.message ?? String(err)
  if (!known) {
    return Object.freeze({
      unavailable: true,
      code: AVAILABILITY_CODES.UNREACHABLE,
      phase: null,
      phaseDeclared: err?.phaseDeclared === true,
      connected: err?.connected === true,
      lateAnswer: err?.lateAnswer === true,
      detail,
    })
  }
  return availabilityOf(err.code, detail, {
    phaseDeclared: err?.phaseDeclared === true,
    connected: err?.connected === true,
    // ★ `lateAnswer` 必须**透传**：`classifyAvailability` 会重建一个对象，
    // 忘了带就等于"迟到的答案"这个事实在归因那一步被丢掉——
    // 而丢掉它的后果正是本批修的那个缺陷"看起来像用户批准了"的审计版本。
    lateAnswer: err?.lateAnswer === true,
  })
}

/**
 * 构造 `tools/pre-execute` 策略 listener。
 *
 * ## 双段超时，且两段都要 fail closed
 *
 * §6.8：DSH 会在异步门 settle 之后重新检查取消，但**不会放弃挂起的 promise**。
 * team-hub 进程活着却不响应（SQLite 卡住、事件循环阻塞、请求排队）时，
 * 工具调用会**无限期挂起** —— 既不失败也不成功，整条流水线停在那里。
 * 因此超时必须自己带，且超时后返回 `deny` 而不是「不知道」。
 *
 * 连接段与响应段分开计时（见 `runWithPhaseDeadlines`）：连接快而响应慢是
 * 「策略算得慢」，连接就慢是「team-hub 不健康」。两者的处置不同，
 * 合成一个总超时会丢掉这个区分——而区分就是这里唯一能给人的东西。
 *
 * `portsPhases: true` 表示**调用方声明**这个 `decide` 端口遵守 `onConnected` 契约。
 * 不声明时总预算照旧封顶，但超时只报 `PHASE_UNREPORTED`（不猜哪一段）。
 */
export function createPreExecutePolicy({
  decide, connectTimeoutMs = 2000, responseTimeoutMs = 3000, now = () => Date.now(), onDecision, portsPhases = false,
} = {}) {
  if (typeof decide !== 'function') throw new Error('createPreExecutePolicy 需要 decide 端口')

  /** @type {import('./enforcement.mjs').PreExecuteListenerLike} */
  async function listener(execution) {
    const started = now()
    let decision
    try {
      decision = await runWithPhaseDeadlines(
        (onConnected) => decide(execution, { onConnected }),
        { connectTimeoutMs, responseTimeoutMs, portsPhases, now, label: '策略门' },
      )
    } catch (err) {
      // 超时与异常都按 fail closed 处理，但**归因不同**：`code` / `phase` 说的是
      // 连不上、算得慢、还是我们根本不知道它卡在哪一段——三者的修法不同。
      const a = classifyAvailability(err)
      const d = PRE_DECISIONS.deny(`策略门不可用，已按 fail closed 拒绝：${a.detail}`)
      onDecision?.({ execution, decision: d, source: 'pre-execute', reason: 'unavailable', elapsedMs: now() - started, ...a })
      return d
    }

    // 端口返回垃圾 = 策略实现有 bug，不是「没问题」。按拒绝处理。
    const kind = decision?.kind
    if (kind !== 'allow' && kind !== 'deny' && kind !== 'ask') {
      const d = PRE_DECISIONS.deny(`策略门返回了无法识别的判定 ${JSON.stringify(kind)}，已按 fail closed 拒绝`)
      // 与超时那一路共用同一份分类：`reason: 'malformed'` 只说"没看懂"，
      // 说得出"这是端口不可信、不是策略说不"才是审计要的东西。
      const a = availabilityOf(AVAILABILITY_CODES.MALFORMED, `策略门返回了无法识别的判定 ${JSON.stringify(kind)}`, { phaseDeclared: portsPhases === true })
      onDecision?.({ execution, decision: d, source: 'pre-execute', reason: 'malformed', elapsedMs: now() - started, ...a })
      return d
    }
    if (kind === 'deny' && (typeof decision.reason !== 'string' || decision.reason === '')) {
      // 拒绝必须带理由：没有理由的拒绝在审计里无法归因，用户也拿不到可执行的提示。
      const d = PRE_DECISIONS.deny('策略拒绝但未给出理由（已补齐占位理由，实现应当修复）')
      onDecision?.({ execution, decision: d, source: 'pre-execute', reason: 'reasonless-deny', elapsedMs: now() - started })
      return d
    }
    onDecision?.({ execution, decision, source: 'pre-execute', reason: kind, elapsedMs: now() - started })
    return decision
  }

  return listener
}

/**
 * 把静态 hard floor 接到 `tools/pre-execute` 的**最前面**。
 *
 * spec §6.8 line 437：`tools/pre-execute` 负责"静态禁令提前拒绝以避免无效询问"。
 * 这一行是 PRT-620 那条不变量成立的前提。没有它，"pre-execute 放行 + guard 拒绝"
 * 不是配置错误，而是必然：一个注定被 guard 拒绝的调用会走进审批箱，人批了、
 * guard 仍然拒——审计里于是出现一条"人工已批准但仍被拒绝"，而它没有修复动作。
 *
 *   > 一个「hard floor 只在 guard 一处生效」的接线，
 *   > 与一个「人批了之后仍然被 guard 拒绝、而审计里找不到该修哪里」的接线，
 *   > 是同一个东西。
 *
 * 下限判定与 guard **共用同一个 `createHardFloorGuard` 调用结果**，不另写一份比较：
 * 两份"同一个下限"的实现，与一个"下限会在 pre-execute 与 guard 之间漂移"的实现，
 * 是同一个东西——而漂移的那一天只表现为"这次怎么被拒了"。
 */
export function composePreExecuteFloor({ floor = DEFAULT_HARD_FLOOR, decide } = {}) {
  if (typeof decide !== 'function') {
    throw new Error('composePreExecuteFloor 需要 decide 端口（下限之后由谁判）')
  }
  const guard = createHardFloorGuard(floor)
  return (execution, options) => {
    const reason = guard(execution)
    // 下限说不行就直接 `deny`，**不是** `ask`：问一个注定被拒的问题，
    // 只会让审计里多出一条"人工已批准但仍被拒绝"。
    if (reason !== undefined) return PRE_DECISIONS.deny(reason)
    return decide(execution, options)
  }
}

// ----------------------------------------------------------------- approval

/** answerer 结果：返回 `null` 表示「本次不认领」，交回 waterfall 的 `next()`。 */
export const APPROVAL_OUTCOMES = Object.freeze(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

/**
 * `allow-once` 的原子消费箱。
 *
 * §6.8：F-02 的 `allow-once` 是按 **canonical operation 哈希** 的一次性决定，
 * DSH 的 `allowed-once` 是按 `callId` 的一次性授权。两者不是一回事，
 * 所以不能把 DSH 的 callId 授权当成 F-02 的哈希批准。
 *
 * 这里实现的是**哈希那一侧**：同一个哈希只能成功消费一次。
 * 并发重复调用必须**只有一个**拿到 true —— 因此用同步 CAS
 * （单线程 JS 里同步读改写就是原子的；用 async 会引入 await 点，
 * 两个并发调用就能同时读到「未消费」）。
 */
export function createAllowOnceStore() {
  const consumed = new Set()

  return {
    /**
     * 消费一次批准。
     * @returns {true} 首次消费成功；{false} 已被消费过（必须 deny）
     */
    consume(hash) {
      if (consumed.has(hash)) return false
      consumed.add(hash)
      return true
    },
    /** 该哈希是否已消费（只读观察，不改变状态）。 */
    isConsumed(hash) {
      return consumed.has(hash)
    },
    get size() {
      return consumed.size
    },
  }
}

/**
 * 构造 approval answerer。
 *
 * ## 为什么超时后返回 `unavailable` 而不是 `rejected`
 *
 * `rejected` 是「人说不」；`unavailable` 是「问不到人」。
 * 两者对用户和审计的含义完全不同：前者是决策，后者是故障。
 * 把故障伪装成决策，会让人以为「用户拒绝了这次写入」，
 * 从而去追问一个从未被问过的人。
 *
 * ## 不等待 team-hub 恢复
 *
 * §6.8：team-hub 不可达时**不得**「等它恢复后再询问」——
 * 那会突破 Run 的期限约束，并且把「不可达」伪装成「待审批」。
 */
export function createApprovalAnswerer({
  request,
  connectTimeoutMs = 2000,
  responseTimeoutMs = 60_000,
  now = () => Date.now(),
  onOutcome,
  portsPhases = false,
} = {}) {
  if (typeof request !== 'function') throw new Error('createApprovalAnswerer 需要 request 端口')

  /** @type {import('./enforcement.mjs').ApprovalAnswererLike} */
  async function answerer(req) {
    const started = now()
    const finish = (outcome, reason, availability = null) => {
      onOutcome?.({ req, outcome, reason, elapsedMs: now() - started, ...(availability ?? {}) })
      return outcome
    }
    if (req === null || typeof req !== 'object') return finish('unavailable', 'malformed-request')
    // 请求已被取消：连问都不必问。返回 cancelled 而不是 unavailable ——
    // 这是调用方主动撤回，不是我们问不到人。
    if (req.signal?.aborted === true) return finish('cancelled', 'already-aborted')

    let outcome
    try {
      outcome = await runWithPhaseDeadlines(
        (onConnected) => request({
          toolName: req.toolName,
          callId: req.callId,
          reason: req.reason,
          signal: req.signal,
          connectTimeoutMs,
          responseTimeoutMs,
          onConnected,
        }),
        { connectTimeoutMs, responseTimeoutMs, portsPhases, now, label: '审批箱' },
      )
    } catch (err) {
      // ★ `unavailable`，**不是** `rejected`，也**不是**"保持等待"：
      // 前者是"问不到人"，中者是"人说不"，后者是"等 team-hub 恢复后再问"——
      // 而 spec §6.8 line 477 明确禁止后者（等待会突破 Run 的期限约束）。
      const a = classifyAvailability(err)
      return finish('unavailable', `不可用：${a.detail}`, a)
    }

    if (!APPROVAL_OUTCOMES.includes(outcome)) {
      // 端口返回了闭集之外的值 —— 不能当作放行，也不能当作拒绝，
      // 只能当作「这个 answerer 现在不可信」。
      const detail = `审批箱返回了闭集外的结果 ${JSON.stringify(outcome)}`
      return finish('unavailable', detail, availabilityOf(AVAILABILITY_CODES.MALFORMED, detail, { phaseDeclared: portsPhases === true }))
    }
    return finish(outcome, outcome === 'allowed-once' ? 'granted' : 'denied')
  }

  return answerer
}

// ------------------------------------------- 可用性语义的一致性（PRT-617）

/**
 * 每种成因**应当**产出什么。这张表是"分类说不说得通"的判据。
 *
 * `outcome` 用审批箱（answerer）那一侧的名字：它是唯一同时能把"故障"与"决定"
 * 表达出来的闭集。策略门那一侧对应的结局是 `deny`——**同一份分类的另一种投影**，
 * 不是另一份判定。
 */
export const AVAILABILITY_CONTRACT = Object.freeze({
  ok: Object.freeze({ outcome: 'allowed-once', code: null, phase: null }),
  cancelled: Object.freeze({ outcome: 'cancelled', code: null, phase: null }),
  rejected: Object.freeze({ outcome: 'rejected', code: null, phase: null }),
  'connect-timeout': Object.freeze({ outcome: 'unavailable', code: AVAILABILITY_CODES.CONNECT_TIMEOUT, phase: 'connect' }),
  'response-timeout': Object.freeze({ outcome: 'unavailable', code: AVAILABILITY_CODES.RESPONSE_TIMEOUT, phase: 'response' }),
  unreachable: Object.freeze({ outcome: 'unavailable', code: AVAILABILITY_CODES.UNREACHABLE, phase: 'connect' }),
  'port-error': Object.freeze({ outcome: 'unavailable', code: AVAILABILITY_CODES.PORT_ERROR, phase: 'response' }),
  malformed: Object.freeze({ outcome: 'unavailable', code: AVAILABILITY_CODES.MALFORMED, phase: null }),
  'phase-unreported': Object.freeze({ outcome: 'unavailable', code: AVAILABILITY_CODES.PHASE_UNREPORTED, phase: null }),
})

export const AVAILABILITY_CHECK_CODES = Object.freeze({
  /** 故障被记成了一次决定（`rejected` / `cancelled`）。 */
  FAULT_AS_REJECTED: 'availability-fault-as-rejected',
  /** 一次真实的决定被记成了 `unavailable`（反方向同样有害）。 */
  DECISION_AS_FAULT: 'availability-decision-as-fault',
  /** 没有结算 = 会无限期挂起。 */
  NEVER_SETTLES: 'availability-never-settles',
  /** 分类码 / 阶段与契约对不上。 */
  CODE_UNKNOWN: 'availability-code-unknown',
  /** 结局不在"故障 / 决定"两类的任何一边。 */
  OUTCOME_UNKNOWN: 'availability-outcome-unknown',
  /** 成因不在契约里。 */
  CAUSE_UNKNOWN: 'availability-cause-unknown',
})

/**
 * 一致性判据：**故障不得被记成决定，也不得永远不结算**。
 *
 * 三个方向都要查，因为它们各自对应一种安静的错误：
 *   ① 故障 → `rejected`：审计里写着"用户拒绝了这次写入"，而用户从没被问过；
 *   ② 决定 → `unavailable`：审计里写着"问不到人"，而人其实明确说了不；
 *   ③ 不结算：工具调用无限期挂在那里（spec line 476 描述的那个故障）。
 *
 * 行是**注入**的。理由与前几批完全一样：真实输入下这三条永远成立，
 * 于是它是一条从不执行的检查——
 *
 *   > 一个「检查一个不可能出现的值」的检查，
 *   > 与一条不存在的检查，在"它到底拦住了什么"上是同一个东西。
 */
export function assertUnavailableIsNotPendingNorRejected(rows = []) {
  const checked = []
  const violations = []
  const push = (row, code, detail) => violations.push(Object.freeze({
    code, cause: row?.cause ?? null, label: row?.label ?? null, auditSource: 'approval', detail,
  }))

  for (const row of Array.isArray(rows) ? rows : []) {
    const expected = AVAILABILITY_CONTRACT[row?.cause]
    checked.push(Object.freeze({
      label: row?.label ?? null,
      cause: row?.cause ?? null,
      outcome: row?.outcome ?? null,
      settled: row?.settled === true,
      code: row?.code ?? null,
      phase: row?.phase ?? null,
      expected: expected ?? null,
    }))
    if (expected === undefined) {
      push(row, AVAILABILITY_CHECK_CODES.CAUSE_UNKNOWN,
        `成因 ${JSON.stringify(row?.cause)} 不在契约里：未知成因的分类无法被验证`)
      continue
    }
    if (row?.settled !== true) {
      // spec §6.8 line 477：不得"等 team-hub 恢复后再询问"。
      push(row, AVAILABILITY_CHECK_CODES.NEVER_SETTLES,
        '这一次没有结算——等待会突破 Run 的期限约束。'
        + '一个「等 team-hub 恢复后再问」的实现，与一个「把不可达伪装成待审批」的实现，是同一个东西')
    }
    if (row?.outcome !== expected.outcome) {
      if (expected.outcome === 'unavailable') {
        push(row, AVAILABILITY_CHECK_CODES.FAULT_AS_REJECTED,
          `故障被记成 ${JSON.stringify(row?.outcome)}（应当是 unavailable）：`
          + '把故障伪装成决定，会让值班的人去追问一个从未被问过的人')
      } else if (row?.outcome === 'unavailable') {
        push(row, AVAILABILITY_CHECK_CODES.DECISION_AS_FAULT,
          `一次真实的决定（${expected.outcome}）被记成 unavailable：`
          + '反方向同样有害——人明确说了不，审计里却写着"问不到人"')
      } else {
        push(row, AVAILABILITY_CHECK_CODES.OUTCOME_UNKNOWN,
          `结局 ${JSON.stringify(row?.outcome)} 与契约不一致，且不在"故障 / 决定"两类的任何一边`)
      }
    }
    if ((row?.code ?? null) !== expected.code || (row?.phase ?? null) !== expected.phase) {
      push(row, AVAILABILITY_CHECK_CODES.CODE_UNKNOWN,
        `分类码与阶段对不上契约：得到 code=${JSON.stringify(row?.code ?? null)} phase=${JSON.stringify(row?.phase ?? null)}，`
        + `应当是 code=${JSON.stringify(expected.code)} phase=${JSON.stringify(expected.phase)}——`
        + '没有阶段码的故障派不到正确的那一边去修')
    }
  }

  return Object.freeze({
    rows: Object.freeze(checked),
    violations: Object.freeze(violations),
    ok: violations.length === 0,
    // ★ 留证而不是布尔：调用方要能看出这次到底验了几行故障、几行决定。
    faultRows: checked.filter((r) => r.expected !== null && r.expected.outcome === 'unavailable').length,
    decisionRows: checked.filter((r) => r.expected !== null && r.expected.outcome !== 'unavailable').length,
    violationCodes: Object.freeze([...new Set(violations.map((v) => v.code))].sort()),
  })
}

/**
 * 装载期自检（PRT-617）。
 *
 * 与所有自检同一条纪律：**留下计算值，且必须是能红的**。
 * `tampered` 那三行是故意写坏的——它们必须被拦下，否则这条检查与一条不存在的检查，
 * 在"它到底拦住了什么"上是同一个东西。
 */
export function availabilitySelfCheck() {
  const declaredRows = Object.keys(AVAILABILITY_CONTRACT).map((cause) => Object.freeze({
    label: cause, cause,
    outcome: AVAILABILITY_CONTRACT[cause].outcome,
    settled: true,
    code: AVAILABILITY_CONTRACT[cause].code,
    phase: AVAILABILITY_CONTRACT[cause].phase,
  }))
  const tamperedRows = Object.freeze([
    Object.freeze({
      label: '超时被记成 rejected', cause: 'connect-timeout', outcome: 'rejected',
      settled: true, code: AVAILABILITY_CODES.CONNECT_TIMEOUT, phase: 'connect',
    }),
    Object.freeze({
      label: '不可达被记成"等它恢复"', cause: 'unreachable', outcome: 'unavailable',
      settled: false, code: AVAILABILITY_CODES.UNREACHABLE, phase: 'connect',
    }),
    Object.freeze({
      label: '故障没有阶段码', cause: 'response-timeout', outcome: 'unavailable',
      settled: true, code: null, phase: null,
    }),
  ])
  const declared = assertUnavailableIsNotPendingNorRejected(declaredRows)
  const broken = assertUnavailableIsNotPendingNorRejected(tamperedRows)
  return Object.freeze({
    declared: Object.freeze({ rows: declared.rows.length, violations: declared.violations.length, faultRows: declared.faultRows }),
    tampered: Object.freeze({
      rows: tamperedRows.length,
      violations: broken.violations.length,
      codes: broken.violationCodes,
    }),
    phases: ENFORCEMENT_PHASES,
    // 每个阶段各自有哪些码——"一个码 per 阶段"这句话的可查形式。
    phaseCodes: Object.freeze(ENFORCEMENT_PHASES.map((phase) => Object.freeze({
      phase,
      codes: Object.freeze(Object.keys(AVAILABILITY_PHASE_OF).filter((c) => AVAILABILITY_PHASE_OF[c] === phase).sort()),
    }))),
    // 码闭集 = 契约里出现过的那些。多出来的码就是"从没被验证过"的码。
    codes: Object.freeze([...new Set(Object.values(AVAILABILITY_CODES))].sort()),
    codesInContract: Object.freeze([...new Set(
      Object.values(AVAILABILITY_CONTRACT).map((v) => v.code).filter((c) => c !== null),
    )].sort()),
    // ★ 能红才是价值：坏行必须被拦下，而正常行必须不误报。
    tamperedCaught: broken.violations.length > 0 && declared.violations.length === 0,
  })
}

/** 装载期结论（计算值，不是 `ok` 布尔）。 */
export const AVAILABILITY_CHECKED = Object.freeze(availabilitySelfCheck())

/**
 * 用**真定时器**把每一种成因各跑一遍（PRT-617 的实测证据）。
 *
 * 它不读常量表：每一条都真的等一次超时，再看它落到哪个码上。
 * 这是"两个阶段可以独立观测"唯一能被证明的方式——
 *
 *   > 一个「声明了两个阶段」的模块，
 *   > 与一个「两个阶段其实共用一条总超时」的模块，是同一个东西。
 *
 * `ok === false` 的含义是具体的：要么某个成因落到了别的码上，
 * 要么某一条**没有结算**（没结算 = 工具调用会无限期挂起）。
 */
/**
 * ★★★ 计时**护栏**（不是延迟断言）。见 `probeTwoPhaseAvailability` 的注释。
 *
 * 它拦的是"配置的超时根本没生效"——那种情况实测会落在调用方的响应预算上
 * （默认 60 秒）或干脆不结算，与 5 秒差着十几倍。而**精确**的延迟性质由
 * 注入时钟确定性断言，不靠墙钟。
 *
 * 取值理由是**负载**而不是性能：CI 机器上 10ms 的定时器实测到过 272ms
 * （约 27 倍）。一个紧贴配置预算的容差会让 `startupSelfCheck` 在繁忙机器上
 * 判出 `incompatible`，从而让**健康的部署拒绝启动**。
 */
export const ENFORCEMENT_HANG_GUARD_MS = 5000

export async function probeTwoPhaseAvailability({
  connectTimeoutMs = 10, responseTimeoutMs = 10, now = () => Date.now(), scenarioSet = null,
} = {}) {
  const budget = connectTimeoutMs + responseTimeoutMs
  // ## ★★ 这个数**不是延迟断言，是挂起护栏**
  //
  // 原先这里是 `slack = Math.max(150, budget * 4)`——一个**紧贴**配置预算的容差
  // （默认 20ms 预算 ⇒ 170ms 生效阈值）。它的问题不是"偶尔误报"，而是**在产品里
  // 制造假阴性**：`startupSelfCheck` 用的是**真**探针，而 `ok === false` 会让它把
  // 强制面判成 `incompatible` ⇒ 拒绝注册宿主端口 ⇒ **一个健康的部署起不来**。
  //
  // 实测（2026-09-15 两次全量 CI）：CI 机器上 10ms 的定时器实测到 251ms / 272ms；
  // `runtime/dsh-composition/composition.test.mjs:710` 因此拿到 `incompatible`
  // 而不是 `enforcement-effective`——**在干净树上单跑 48/48 全绿**。
  //
  //   > 一条"加载一高就判定生产环境不兼容"的判据，
  //   > 与一条"拒绝启动"的判据，在值班的人那里是同一个东西——
  //   > 只不过前者是机器的错，而报出来的是产品的错。
  //
  // 与本函数下方那段注释对照着读：那里写着"判据是'有没有结算、码对不对'，
  // **不是**精确耗时"。**那句话一直是对的，错的是代码没有照它做。**
  //
  // 所以这里把两种性质分开：
  //   · **语义**（结算了没有、码与阶段对不对）—— 与负载无关，仍然是严格判据，
  //     它们在 `ok` 里、也在每一条用例里逐项断言；
  //   · **耗时** —— 退成**护栏**：它要拦的是"配置的 10ms 超时根本没生效"，
  //     那种情况下实测会落在**调用方给的响应预算**上（默认 `responseTimeoutMs`
  //     是 60 秒）或干脆不结算，与 5 秒差了十几倍。
  //
  // 护栏取 5s：是 60s 默认响应预算的 1/12，离任何真实故障都还很远；
  // 而精确的延迟性质改由**注入时钟**确定性地断言（见 availability.test.mjs）。
  const slack = Math.max(ENFORCEMENT_HANG_GUARD_MS - budget, budget * 4)
  const withinBudgetMs = budget + slack

  const runAnswerer = async (s) => {
    const started = now()
    const seen = {}
    const answerer = createApprovalAnswerer({
      request: s.request,
      connectTimeoutMs,
      responseTimeoutMs,
      portsPhases: s.portsPhases === true,
      now,
      onOutcome: (o) => { Object.assign(seen, o) },
    })
    let outcome = null
    let settled = true
    try { outcome = await answerer({ toolName: 'probe', callId: 'probe' }) } catch { settled = false }
    return { outcome, settled, code: seen.code ?? null, phase: seen.phase ?? null, elapsedMs: now() - started }
  }

  const runPolicyGate = async (s) => {
    const started = now()
    const seen = []
    const listener = createPreExecutePolicy({
      decide: s.request,
      connectTimeoutMs,
      responseTimeoutMs,
      portsPhases: s.portsPhases === true,
      now,
      onDecision: (d) => seen.push(d),
    })
    let decision = null
    let settled = true
    try { decision = await listener({ name: 'probe' }) } catch { settled = false }
    const last = seen[seen.length - 1] ?? {}
    return { kind: decision?.kind ?? null, settled, code: last.code ?? null, phase: last.phase ?? null, elapsedMs: now() - started }
  }

  const defaultScenarios = [
    {
      id: '①', what: '连接阶段：端口抛错（team-hub 不可达）',
      via: 'answerer', portsPhases: true,
      request: () => { throw new Error('ECONNREFUSED 127.0.0.1:1') },
      expect: { outcome: 'unavailable', code: AVAILABILITY_CODES.UNREACHABLE, phase: 'connect' },
    },
    {
      id: '②', what: '连接阶段：声明了分阶段契约却一直没有回应',
      via: 'answerer', portsPhases: true,
      request: () => new Promise(() => {}),
      expect: { outcome: 'unavailable', code: AVAILABILITY_CODES.CONNECT_TIMEOUT, phase: 'connect' },
    },
    {
      id: '③', what: '响应阶段：自报连接建立后不再回应',
      via: 'answerer', portsPhases: true,
      request: ({ onConnected }) => { onConnected(); return new Promise(() => {}) },
      expect: { outcome: 'unavailable', code: AVAILABILITY_CODES.RESPONSE_TIMEOUT, phase: 'response' },
    },
    {
      id: '④', what: '未声明契约且一直没有回应：**不猜**是哪一段',
      via: 'answerer', portsPhases: false,
      request: () => new Promise(() => {}),
      expect: { outcome: 'unavailable', code: AVAILABILITY_CODES.PHASE_UNREPORTED, phase: null },
    },
    {
      id: '⑤', what: '自报连接建立之后这一次请求本身失败',
      via: 'answerer', portsPhases: true,
      request: ({ onConnected }) => { onConnected(); throw new Error('boom') },
      expect: { outcome: 'unavailable', code: AVAILABILITY_CODES.PORT_ERROR, phase: 'response' },
    },
    {
      id: '⑥', what: '正常放行不被降级成故障',
      via: 'answerer', portsPhases: true,
      request: () => 'allowed-once',
      expect: { outcome: 'allowed-once', code: null, phase: null },
    },
    {
      id: '⑦', what: '策略门：不可用时是 deny（不是挂起，也不是放行）',
      via: 'policy', portsPhases: false,
      request: () => new Promise(() => {}),
      expect: { kind: 'deny', code: AVAILABILITY_CODES.PHASE_UNREPORTED, phase: null },
    },
    {
      id: '⑧', what: '策略门：端口抛错时是 deny，且归到连接阶段',
      via: 'policy', portsPhases: true,
      request: () => { throw new Error('ECONNREFUSED') },
      expect: { kind: 'deny', code: AVAILABILITY_CODES.UNREACHABLE, phase: 'connect' },
    },
  ]

  // 场景集合可注入：一条只会在全绿输入上跑过的探针，与一条不存在的探针，
  // 在"它到底拦住了什么"上是同一个东西。反向控制见表里的用例。
  const scenarios = Array.isArray(scenarioSet) ? scenarioSet : defaultScenarios

  const rows = []
  for (const s of scenarios) {
    const got = s.via === 'policy' ? await runPolicyGate(s) : await runAnswerer(s)
    const matches = Object.entries(s.expect).every(([k, v]) => (got[k] ?? null) === v)
    rows.push(Object.freeze({
      id: s.id, what: s.what, via: s.via, portsPhases: s.portsPhases === true,
      expected: Object.freeze({ ...s.expect }),
      got: Object.freeze({ ...got }),
      matches,
      withinBudget: got.elapsedMs <= withinBudgetMs,
    }))
  }

  const unsettled = rows.filter((r) => r.got.settled !== true)
  const mismatched = rows.filter((r) => r.matches !== true)
  const overBudget = rows.filter((r) => r.withinBudget !== true)
  // ★★ 判据是 `budget + slack`，**不是** `budget`。理由里必须报**生效的**那个阈值。
  //
  // 此前这条理由写的是「耗时 Xms 超过预算 20ms」——而 20ms 是 `connect + response`
  // 两个**模拟**超时之和，生效判据其实是它加 150ms 余量 = 170ms。于是同一个读数：
  //
  //   · 按理由读 → 超出 12.5 倍，像是"哪里严重不对"；
  //   · 按真实判据读 → 超出 1.5 倍，像是"这台机器当时很忙"。
  //
  // 两个结论指向**完全不同的**排查动作。实测（2026-09-15 一次全量 CI）：
  // 真读数 251ms / 272ms，理由报的是 20ms。
  //
  //   > 一个把生效阈值写成"预算"的理由，与一个把 1.5 倍报成 12.5 倍的理由，
  //   > 在排查的人手里是同一个东西——只不过前者会让他去查代码，而真因是机器忙。
  //
  // 这与本函数的注释（"判据是'有没有结算、码对不对'，不是精确耗时"）是同一件事：
  // 余量是为繁忙机器留的，那么报出来的就必须是含余量的阈值。
  return Object.freeze({
    ok: unsettled.length === 0 && mismatched.length === 0 && overBudget.length === 0,
    connectTimeoutMs,
    responseTimeoutMs,
    budgetMs: budget,
    slackMs: slack,
    /**
     * ★ 生效阈值 = budget + slack。**读的是这个**，不是 budgetMs。
     * 它是**挂起护栏**（见 `ENFORCEMENT_HANG_GUARD_MS`），不是延迟断言。
     */
    withinBudgetMs,
    rows: Object.freeze(rows),
    reasons: Object.freeze([
      ...unsettled.map((r) => `${r.id} ${r.what}：没有结算（会无限期挂起）`),
      ...mismatched.map((r) => `${r.id} ${r.what}：得到 ${JSON.stringify(r.got)}，期望 ${JSON.stringify(r.expected)}`),
      ...overBudget.map((r) =>
        `${r.id} ${r.what}：耗时 ${r.got.elapsedMs}ms 超过挂起护栏 ${withinBudgetMs}ms`
        + `（${budget}ms 预算 + ${slack}ms 护栏余量；护栏不是延迟断言，见 ENFORCEMENT_HANG_GUARD_MS）`),
    ]),
  })
}
