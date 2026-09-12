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
 * 连接段与响应段分开计时：连接快而响应慢是「策略算得慢」，
 * 连接就慢是「team-hub 不健康」。两者的处置不同，合成一个总超时会丢掉这个区分。
 */
export function createPreExecutePolicy({ decide, connectTimeoutMs = 2000, responseTimeoutMs = 3000, now = () => Date.now(), onDecision } = {}) {
  if (typeof decide !== 'function') throw new Error('createPreExecutePolicy 需要 decide 端口')

  async function withDeadline(fn, ms, label) {
    let timer
    try {
      return await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
          // 不 unref：这个定时器必须能把挂起的 promise 解开，unref 会让进程退出时静默丢失它。
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /** @type {import('./enforcement.mjs').PreExecuteListenerLike} */
  async function listener(execution) {
    const started = now()
    let decision
    try {
      decision = await withDeadline(
        () => decide(execution),
        connectTimeoutMs + responseTimeoutMs,
        '策略门',
      )
    } catch (err) {
      const d = PRE_DECISIONS.deny(`策略门不可用，已按 fail closed 拒绝：${err?.message ?? String(err)}`)
      onDecision?.({ execution, decision: d, source: 'pre-execute', reason: 'unavailable', elapsedMs: now() - started })
      return d
    }

    // 端口返回垃圾 = 策略实现有 bug，不是「没问题」。按拒绝处理。
    const kind = decision?.kind
    if (kind !== 'allow' && kind !== 'deny' && kind !== 'ask') {
      const d = PRE_DECISIONS.deny(`策略门返回了无法识别的判定 ${JSON.stringify(kind)}，已按 fail closed 拒绝`)
      onDecision?.({ execution, decision: d, source: 'pre-execute', reason: 'malformed', elapsedMs: now() - started })
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
} = {}) {
  if (typeof request !== 'function') throw new Error('createApprovalAnswerer 需要 request 端口')

  async function withDeadline(fn, ms, label) {
    let timer
    try {
      return await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /** @type {import('./enforcement.mjs').ApprovalAnswererLike} */
  async function answerer(req) {
    const started = now()
    const finish = (outcome, reason) => {
      onOutcome?.({ req, outcome, reason, elapsedMs: now() - started })
      return outcome
    }
    if (req === null || typeof req !== 'object') return finish('unavailable', 'malformed-request')
    // 请求已被取消：连问都不必问。返回 cancelled 而不是 unavailable ——
    // 这是调用方主动撤回，不是我们问不到人。
    if (req.signal?.aborted === true) return finish('cancelled', 'already-aborted')

    let outcome
    try {
      outcome = await withDeadline(
        () => request({
          toolName: req.toolName,
          callId: req.callId,
          reason: req.reason,
          signal: req.signal,
          connectTimeoutMs,
          responseTimeoutMs,
        }),
        connectTimeoutMs + responseTimeoutMs,
        '审批箱',
      )
    } catch (err) {
      return finish('unavailable', `不可用：${err?.message ?? String(err)}`)
    }

    if (!APPROVAL_OUTCOMES.includes(outcome)) {
      // 端口返回了闭集之外的值 —— 不能当作放行，也不能当作拒绝，
      // 只能当作「这个 answerer 现在不可信」。
      return finish('unavailable', `审批箱返回了闭集外的结果 ${JSON.stringify(outcome)}`)
    }
    return finish(outcome, outcome === 'allowed-once' ? 'granted' : 'denied')
  }

  return answerer
}
