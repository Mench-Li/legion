import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveStaleMinutes } from '../src/configSanity.ts'

// BUG-009-b 回归：`staleMinutes` 必须 **严格大于** `workerTimeoutMs/60000`。
//
// 为什么值得单独钉：这条关系原先只写在 `Config` 的字段注释里，schema 是
// `z.number().min(5).default(30)` —— **没有任何强制**。不满足时的症状离配置很远：
// 租约回收器会在 worker **还活着**的时候把任务释放回 todo，另一个 worker 认领它 ⇒
// 两个写者同时改同一片文件。配置是 45 分钟超时 / 40 分钟回收时就是这样。
//
// 处置选"启动时校正 + 打印一行"而不是"拒绝加载"：配置写错时，一个起不来的守护
// 与一个把原因写在日志里的守护，后者才能让人自己发现（前者只会让人以为插件坏了）。

test('原值已满足（严格大于）⇒ 不动，adjusted=false', () => {
  const v = resolveStaleMinutes({ workerTimeoutMs: 2_700_000, staleMinutes: 60 })   // 45 分钟超时
  assert.equal(v.staleMinutes, 60, '满足关系时不许改用户的值')
  assert.equal(v.adjusted, false)
  assert.equal(v.needed, 46, 'needed = ceil(45)+1 —— 关系是严格大于，相等时回收器与超时同时触发')
})

test('★ 原值不满足 ⇒ 校正到恰好满足，并把 needed 带出去（供日志引用）', () => {
  const v = resolveStaleMinutes({ workerTimeoutMs: 2_700_000, staleMinutes: 40 })   // 现场形状：45 超时 / 40 回收
  assert.equal(v.adjusted, true)
  assert.equal(v.staleMinutes, 46)
  assert.equal(v.needed, 46)
  assert.ok(v.staleMinutes > 2_700_000 / 60_000, '校正后必须严格大于超时分钟数')
})

test('★ 相等也要校正（严格大于：相等时回收器与 worker 超时同时触发，谁先拿写锁决定结果）', () => {
  const v = resolveStaleMinutes({ workerTimeoutMs: 2_700_000, staleMinutes: 45 })
  assert.equal(v.adjusted, true, '45 与 45 分钟相等 —— 这不是"满足"，是竞态')
  assert.equal(v.staleMinutes, 46)
})

test('默认配置（10 分钟超时 / 30 分钟回收）本来就满足，不许误改', () => {
  const v = resolveStaleMinutes({ workerTimeoutMs: 600_000, staleMinutes: 30 })
  assert.equal(v.adjusted, false)
  assert.equal(v.staleMinutes, 30)
})

test('分钟数向上取整（超时不是整分钟时仍留出边界）', () => {
  const v = resolveStaleMinutes({ workerTimeoutMs: 90_000, staleMinutes: 1 })   // 1.5 分钟
  assert.equal(v.needed, 3, 'ceil(1.5)=2，+1 = 3')
  assert.equal(v.staleMinutes, 3)
  assert.equal(v.adjusted, true)
})

test('脏输入不抛（NaN / undefined 都当作 0 处理）', () => {
  const v = resolveStaleMinutes({ workerTimeoutMs: Number.NaN, staleMinutes: Number.NaN })
  assert.equal(v.needed, 1)
  assert.equal(v.staleMinutes, 1)
  assert.equal(v.adjusted, true)
})
