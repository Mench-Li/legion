// workbench/src/deliveryBadge.ts
// ============================================================================
// 并行任务文件冲突治理（G-mujfc9vi-1 S7）：交付子状态 / 写入调度状态的**纯展示**映射。
//
// DOM-free：可被 node --experimental-strip-types 直接测。只做「状态 → 徽标」的翻译，
// 不发明状态：未知状态返回 null，**绝不**把不可读画成「0 / 正常」。
// ============================================================================

export type BadgeTone = 'ok' | 'warn' | 'busy' | 'wait' | 'muted' | 'unknown'

export interface Badge {
  key: string
  label: string
  tone: BadgeTone
  title: string
}

export const DELIVERY_LABELS: Record<string, string> = Object.freeze({
  'awaiting-acceptance': '⏳ 待裁决',
  ready: '🚀 待集成',
  preparing: '📦 集成准备中',
  validating: '🔁 集成后验证中',
  'needs-review': '⚠ 待复验',
  integrated: '✅ 已集成',
  abandoned: '🗑 已放弃',
})

const DELIVERY_TONES: Record<string, BadgeTone> = Object.freeze({
  'awaiting-acceptance': 'warn',
  ready: 'busy',
  preparing: 'busy',
  validating: 'busy',
  'needs-review': 'warn',
  integrated: 'ok',
  abandoned: 'muted',
})

export const SCHEDULING_LABELS: Record<string, string> = Object.freeze({
  unplanned: '○ 未规划',
  'waiting-file': '⏸ 等待文件',
  reserved: '🔒 已预约写入',
  reconciling: '🔄 对账中',
  released: '🔓 已释放',
})

export interface DeliveryBadgeInput {
  deliveryState?: string | null
}

export interface SchedulingBadgeInput {
  schedulingState?: string | null
  blockingTaskId?: string | null
  blockingPath?: string | null
}

export function deliveryBadgeOf(input: DeliveryBadgeInput | null | undefined): Badge | null {
  const state = input?.deliveryState ?? null
  if (state === null || state === undefined || state === '') return null
  const label = DELIVERY_LABELS[state]
  if (!label) return null
  return { key: 'delivery:' + state, label, tone: DELIVERY_TONES[state] ?? 'unknown', title: `交付状态：${state}（服务端权威）` }
}

export function schedulingBadgeOf(input: SchedulingBadgeInput | null | undefined): Badge | null {
  const state = input?.schedulingState ?? null
  if (state === null || state === undefined || state === '' || state === 'unplanned') return null
  const label = SCHEDULING_LABELS[state]
  if (!label) return null
  if (state === 'waiting-file') {
    const holder = input?.blockingTaskId ?? '其它任务'
    const file = input?.blockingPath ?? '未知文件'
    return { key: 'scheduling:waiting-file', label, tone: 'wait', title: `等待任务 ${holder} 释放 ${file}；等待期间只读工作不受限` }
  }
  return { key: 'scheduling:' + state, label, tone: state === 'reserved' ? 'busy' : 'muted', title: `写入调度状态：${state}` }
}

/** 组合徽标：调度状态在前、交付状态在后（都可缺省）。 */
export function deliveryBadges(input: DeliveryBadgeInput & SchedulingBadgeInput): Badge[] {
  const out: Badge[] = []
  const s = schedulingBadgeOf(input)
  if (s) out.push(s)
  const d = deliveryBadgeOf(input)
  if (d) out.push(d)
  return out
}

/**
 * 不可读必须显式为「无读数」而非 0：指标/交付读不到时前端用它，禁止默认成 0。
 */
export function unreadableBadge(reason: string | null | undefined): Badge {
  return {
    key: 'unreadable',
    label: '❓ 无读数',
    tone: 'unknown',
    title: reason && reason.length > 0 ? `该读数不可用：${reason}` : '该读数不可用（原因未知）',
  }
}
