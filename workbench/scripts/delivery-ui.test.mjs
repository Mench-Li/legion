// workbench/scripts/delivery-ui.test.mjs —— S7（交付/调度徽标纯函数回归）
// 运行：node --experimental-strip-types workbench/scripts/delivery-ui.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deliveryBadgeOf, schedulingBadgeOf, deliveryBadges, unreadableBadge,
  DELIVERY_LABELS, SCHEDULING_LABELS,
} from '../src/deliveryBadge.ts'

test('TC-S7-01 交付子状态逐个映射为可读徽标，未知状态不发明徽标', () => {
  for (const state of Object.keys(DELIVERY_LABELS)) {
    const b = deliveryBadgeOf({ deliveryState: state })
    assert.ok(b, state)
    assert.equal(b.label, DELIVERY_LABELS[state])
    assert.notEqual(b.tone, 'unknown', state)
  }
  assert.equal(deliveryBadgeOf({ deliveryState: 'teleported' }), null)
  assert.equal(deliveryBadgeOf({ deliveryState: null }), null)
  assert.equal(deliveryBadgeOf(null), null)
})

test('TC-S7-02 integrated / needs-review 徽标语义不混淆', () => {
  assert.match(deliveryBadgeOf({ deliveryState: 'integrated' }).label, /已集成/)
  assert.match(deliveryBadgeOf({ deliveryState: 'needs-review' }).label, /复验/)
  assert.equal(deliveryBadgeOf({ deliveryState: 'integrated' }).tone, 'ok')
  assert.equal(deliveryBadgeOf({ deliveryState: 'needs-review' }).tone, 'warn')
})

test('TC-S7-03 waiting-file 徽标写出「等谁/等哪个文件」，等待不伪装成失败', () => {
  const b = schedulingBadgeOf({ schedulingState: 'waiting-file', blockingTaskId: 'T-9', blockingPath: 'src/a.mjs' })
  assert.equal(b.label, '⏸ 等待文件')
  assert.equal(b.tone, 'wait')
  assert.match(b.title, /T-9/)
  assert.match(b.title, /src\/a\.mjs/)
  assert.equal(schedulingBadgeOf({ schedulingState: 'unplanned' }), null)
  assert.equal(schedulingBadgeOf({ schedulingState: 'bogus' }), null)
})

test('TC-S7-04 组合徽标顺序稳定：调度在前、交付在后', () => {
  const both = deliveryBadges({ schedulingState: 'reserved', deliveryState: 'ready' })
  assert.equal(both.length, 2)
  assert.equal(both[0].key, 'scheduling:reserved')
  assert.equal(both[1].key, 'delivery:ready')
  assert.deepEqual(deliveryBadges({}), [])
})

test('TC-S7-05 不可读显式为「无读数」而非 0', () => {
  const b = unreadableBadge('该仓库没有集成 job 样本')
  assert.match(b.label, /无读数/)
  assert.equal(b.tone, 'unknown')
  assert.match(b.title, /没有集成 job 样本/)
  assert.doesNotMatch(b.label, /0/)
  const def = unreadableBadge(undefined)
  assert.match(def.title, /不可用/)
})

test('TC-S7-06 标签表覆盖设计中的全部子状态（不漏词）', () => {
  for (const s of ['awaiting-acceptance', 'ready', 'preparing', 'validating', 'needs-review', 'integrated', 'abandoned']) {
    assert.ok(DELIVERY_LABELS[s], s)
  }
  for (const s of ['waiting-file', 'reserved', 'reconciling', 'released']) {
    assert.ok(SCHEDULING_LABELS[s], s)
  }
})
