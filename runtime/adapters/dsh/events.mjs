// runtime/adapters/dsh/events.mjs
// ============================================================================
// DSH 运行生命周期 → RunEvent 转换（PRT-203）
//
// ## 最重要的一条：不编造我们观测不到的事件
//
// DSH 给我们的表面是 `run.result`（一个 promise，可能永不结算）+ `stopReason`。
// 它**不**保证给出带类型的细粒度事件流。因此这里有两条路径：
//
//   · 宿主端口提供了 `subscribeRun`（可选能力）→ 逐条映射真实事件；
//   · 没有 → **只发我们确实知道的生命周期事件**：`run.started`、
//     `model.selected`、以及终态。
//
// 绝不为了「事件看起来更丰富」而合成 `message.delta` / `tool.completed`。
// 合成本质上是伪造审计：事后回放时会看到一次并不存在的工具调用，
// 而审计的全部价值就在于「它记的确实发生过」。
// 诚实的稀疏事件流远比伪造的丰富事件流有用。
//
// ## 未识别的 DSH 事件不丢弃
//
// 映射表命中即转换；未命中时发一条 `run.progress`（带 `unmapped` 标记）
// 而不是静默丢掉。静默丢弃会让「DSH 加了个新事件类型」这件事
// 在任何地方都看不见——等到需要那个信息时才发现它从来没被记下来。
//
// ## 序号唯一权威
//
// `seq` 由适配器分配（`createSeqAllocator` 来自契约），不由 DSH 提供。
// 引擎重启或并发运行都不该让我们的审计序号出现空洞或重号。
// ============================================================================
import { createSeqAllocator, isKnownEventType } from '../../contracts/index.mjs'
import { redactValue } from './redact.mjs'

/**
 * 已知 DSH 事件名 → 契约 RunEventType。
 *
 * 左列是**我们观测到的/合理的** DSH 侧命名；不在表内的走 `unmapped` 路径。
 * 表为空是允许的（说明宿主端口没有事件流能力），不是错误。
 */
export const DSH_EVENT_MAP = Object.freeze({
  'run.started': 'run.started',
  'agent.started': 'run.started',
  'model.selected': 'model.selected',
  'model.resolved': 'model.selected',
  'message.delta': 'message.delta',
  'message.delta.produced': 'message.delta',
  'tool.requested': 'tool.requested',
  'tool.started': 'tool.started',
  'tool.completed': 'tool.completed',
  'tool.failed': 'tool.failed',
  'usage.updated': 'usage.updated',
  'token.usage': 'usage.updated',
  'artifact.produced': 'artifact.produced',
  'file.produced': 'artifact.produced',
  'run.completed': 'run.completed',
  'run.failed': 'run.failed',
  'run.cancelled': 'run.cancelled',
  'run.canceled': 'run.cancelled',
  'run.outcome_unknown': 'run.outcome_unknown',
})

/**
 * 把一个原始 DSH 事件映射为 RunEvent 的**载荷**（不含 seq/at，由调用方补）。
 *
 * 返回 `{ type, unmapped, payload }`。`unmapped: true` 时 `type` 为
 * `run.progress` 且 payload 保留原名，供审计发现「引擎有了新事件」。
 */
export function mapDshEvent(raw) {
  if (raw === null || typeof raw !== 'object' || typeof raw.type !== 'string') {
    return { type: 'run.progress', unmapped: true, payload: { unmappedReason: '事件缺少 type', raw: redactValue(raw).value } }
  }
  const mapped = DSH_EVENT_MAP[raw.type]
  const rest = {}
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'type') continue
    if (k === 'seq' || k === 'at') continue // 序号与时间由适配器权威分配，不接受引擎覆盖
    rest[k] = v
  }
  const redacted = redactValue(rest)
  if (!mapped) {
    return {
      type: 'run.progress',
      unmapped: true,
      payload: { ...redacted.value, dshEventType: raw.type },
      redactedPaths: redacted.redacted,
    }
  }
  if (!isKnownEventType(mapped)) {
    // 映射表自身写错了：这是我们的 bug，必须可见而不是发出非法事件类型
    return {
      type: 'run.progress',
      unmapped: true,
      payload: { ...redacted.value, dshEventType: raw.type, mappingError: `映射表产出非法类型：${mapped}` },
      redactedPaths: redacted.redacted,
    }
  }
  return { type: mapped, unmapped: false, payload: redacted.value, redactedPaths: redacted.redacted }
}

/**
 * 事件发射器：统一分配 seq、时间戳，并强制终态只能出现一次。
 *
 * 序号从 **1** 开始：`validateRunEvent` 要求 `seq >= 1`，
 * 从 0 开始会被契约自己的校验器判为非法事件。
 *
 * 终态唯一性在这里再兜一层（契约侧已有 `createTerminalArbiter`）：
 * 适配器是事件的**产生者**，产生者不该依赖消费者去重。
 * 重复终态会直接违背 §6.4「历史不可覆盖」。
 */
export function createEventEmitter({ runId, now = () => Date.now(), startSeq = 1, terminalTypes }) {
  const nextSeq = createSeqAllocator(startSeq)
  const terminalSet = new Set(terminalTypes ?? ['run.completed', 'run.failed', 'run.cancelled', 'run.outcome_unknown'])
  let terminalType = null
  const late = []

  return {
    /** 发一个事件。终态已发出后再发终态 → 不发出，记入 `late`。 */
    emit(type, extra = {}) {
      if (terminalSet.has(type)) {
        if (terminalType !== null) {
          late.push({ type, at: now(), reason: `已有终态 ${terminalType}` })
          return null
        }
        terminalType = type
      }
      return { type, runId, seq: nextSeq(), at: now(), ...extra }
    },
    /** 便捷：发已映射的载荷。 */
    emitMapped(mapped, extra = {}) {
      return this.emit(mapped.type, { ...mapped.payload, ...extra })
    },
    terminalType() {
      return terminalType
    },
    isTerminal() {
      return terminalType !== null
    },
    /** 迟到的终态（诊断用；正常应为空）。 */
    lateTerminals() {
      return late.slice()
    },
  }
}

/** `stopReason` → 终态事件类型。与 errors.mjs 的分类配合使用。 */
export function terminalTypeFor(stopReason, classification) {
  if (classification?.code === null) return 'run.completed'
  const code = classification?.code
  if (code === 'CANCELLED') return 'run.cancelled'
  if (code === 'OUTCOME_UNKNOWN') return 'run.outcome_unknown'
  return 'run.failed'
}
