// runtime/dsh-composition/inflight.mjs
// ============================================================================
// PRT-214：在飞的工具调用登记簿（callId → 投影）。
//
// ## 为什么需要它
//
// DSH 把 `ask` 交给审批服务时，**只递这五个字段**（`tools/src/index.ts:1696`）：
//
//     approval.request({ agent, toolName: exec.name, callId: exec.callId, reason, signal })
//
// **没有工具参数。** 而 team-hub 的权限检查要靠参数算绑定哈希
// （`hashToolArguments`）——没有参数，就造不出一次**可被消费**的批准：
// 人批了，执行时哈希对不上，票据作废。
//
//   > 一个"没有参数也算得出主体"的审批，
//   > 与一个"人批了却在执行时不匹配"的审批，在审计里是同一个东西——
//   > 只不过前者会让每一次批准都白批。
//
// 而 `tools/pre-execute` **拿得到**完整 `exec`（含 `arguments`）。
// 于是这两个缝合点必须共享一份状态：
//
//     pre-execute 行  ──put(callId, 投影)──▶  【本登记簿】  ◀──peek(callId)──  answerer 行
//
// ## 为什么是进程级单例而不是 Cordis 服务
//
// 两行是**两个独立的 DSH 补丁行**，各自加载自己的模块。它们之间只有两条路可走：
// 一个服务（谁 provide？两行都想要它，于是得再有第三行），或者一个共享模块。
// 这里选后者：ESM 会把同一份模块实例给两行，而补丁层一共只有四行——
// 为一份纯数据结构再加一行，是拿组合树的复杂度换一点点整洁。
//
// ⚠️ **代价说清楚**：进程级单例是隐藏的全局状态。所以它：
//   · 有 TTL（一个永远不被审批的调用不能永远占着内存）；
//   · 有 `clear()`（用例之间必须能互相隔离，否则测的是累积效果）；
//   · 只放**纯数据**（投影本身），不放 ctx、不放活对象。
// ============================================================================

/** 登记簿版本；接口（peek/put/…）变化时递增。 */
export const IN_FLIGHT_VERSION = 1

/** 默认存活时长：一个工具调用从"开始判"到"被问到人"不该超过这个跨度。 */
export const DEFAULT_IN_FLIGHT_TTL_MS = 5 * 60 * 1000

/** 超过这个条数就强制清理一次过期项（防止只写不读的泄漏）。 */
const SWEEP_THRESHOLD = 64

/**
 * 造一个在飞登记簿。
 *
 * @param {object} [options]
 * @param {number} [options.ttlMs] 条目存活时长；超过即视为过期。
 * @param {() => number} [options.now] 时间源（用例要能拨表）。
 * @returns {{
 *   put: (callId: string, projection: object) => boolean,
 *   peek: (callId: string) => object|undefined,
 *   take: (callId: string) => object|undefined,
 *   has: (callId: string) => boolean,
 *   sweep: () => number,
 *   clear: () => void,
 *   readonly size: number,
 *   ttlMs: number,
 * }}
 */
export function createInFlightRegistry({ ttlMs = DEFAULT_IN_FLIGHT_TTL_MS, now = () => Date.now() } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`createInFlightRegistry 的 ttlMs 必须是正数，收到 ${JSON.stringify(ttlMs)}`)
  }
  /** @type {Map<string, {projection: object, at: number}>} */
  const entries = new Map()
  let puts = 0

  const isExpired = (entry, t) => t - entry.at >= ttlMs

  /** 惰性清理：读的时候顺手丢掉过期的，比定时器可靠（定时器要有人负责关）。 */
  const live = (callId, t) => {
    const entry = entries.get(callId)
    if (entry === undefined) return undefined
    if (isExpired(entry, t)) {
      entries.delete(callId)
      return undefined
    }
    return entry
  }

  return {
    /**
     * 记下一次在飞的调用。
     *
     * `callId` 为空时**返回 false 而不是抛**：调用方（pre-execute 行）此时应当
     * 按 fail closed 处理，而"登记不了"是个可预期的局面（DSH 的 `callId` 在
     * 嵌套调度下可能缺席），不是本模块的故障。
     */
    put(callId, projection) {
      if (typeof callId !== 'string' || callId === '') return false
      if (projection === null || typeof projection !== 'object') return false
      const t = now()
      entries.set(callId, { projection, at: t })
      puts += 1
      if (puts % SWEEP_THRESHOLD === 0) this.sweep()
      return true
    },
    /** 读但**不**删：answerer 可能被问不止一次（同一 callId 的策略重判）。 */
    peek(callId) {
      if (typeof callId !== 'string' || callId === '') return undefined
      const entry = live(callId, now())
      return entry === undefined ? undefined : entry.projection
    },
    /** 读并删：调用真正结束后由收尾方调用，避免条目靠 TTL 才消失。 */
    take(callId) {
      if (typeof callId !== 'string' || callId === '') return undefined
      const entry = live(callId, now())
      if (entry === undefined) return undefined
      entries.delete(callId)
      return entry.projection
    },
    has(callId) { return this.peek(callId) !== undefined },
    /** 丢掉全部过期项，返回丢掉几条。 */
    sweep() {
      const t = now()
      let dropped = 0
      for (const [callId, entry] of entries) {
        if (isExpired(entry, t)) { entries.delete(callId); dropped += 1 }
      }
      return dropped
    },
    /** 用例之间必须能互相隔离——否则测的是前面所有步骤的累积效果。 */
    clear() { entries.clear() },
    get size() { return entries.size },
    ttlMs,
  }
}

/**
 * **进程级**登记簿：`pre-execute` 行与 `answerer` 行共用的那一份。
 *
 * 两行由 DSH 分别加载，模块实例由 ESM 缓存共享——这就是它们唯一的会合点。
 */
export const IN_FLIGHT = createInFlightRegistry()
