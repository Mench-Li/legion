// product/lifecycle/retention.test.mjs
// ============================================================================
// PRT-904：日志、执行事件与产物的容量上限与保留策略。
//
// 这一组盯的**不是**"能不能算出一份删除清单"，而是**那份清单会不会删错**。
// 三种失败都很安静：
//
//   ① 只对一个类做容量核算，却把结果当成总用量 → 另外两类无界增长
//   ② 删掉最新而不是最旧 → 用量确实降下来了，指标完全成功
//   ③ 删掉还被进行中 Run 引用的产物 → 失败发生在很久之后的另一步
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DATA_CLASSES,
  DATA_CLASSES_CHECKED,
  DATA_CLASS_IDS,
  UNINSTALL_ACTIONS,
  UNINSTALL_MODE_IDS,
  UNINSTALL_MODES,
  classifyPath,
} from './data-classes.mjs'
import {
  DEFAULT_RETENTION,
  RETENTION_CHECKED,
  RETENTION_CLASSES,
  RETENTION_CODES,
  assertRetentionBounded,
  planRetention,
} from './retention.mjs'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

/** 造一条条目。 */
const e = (id, classId, ageDays, bytes, extra = {}) => ({
  id, classId, path: `/x/${id}`, bytes, atMs: NOW - ageDays * DAY, ...extra,
})

// ---------------------------------------------------------------- 台账

test('① ★★ 台账自检：每一类都有去留动作，且说明了为什么', () => {
  assert.equal(DATA_CLASSES_CHECKED.ok, true, JSON.stringify(DATA_CLASSES_CHECKED.problems))
  assert.equal(DATA_CLASSES_CHECKED.classCount, DATA_CLASS_IDS.length)
  for (const [id, action] of Object.entries(DATA_CLASSES_CHECKED.actions)) {
    assert.ok(UNINSTALL_ACTIONS.includes(action), `${id} 的动作 ${action} 不合法`)
    assert.ok(DATA_CLASSES[id].why.length > 0, `${id} 没有说明为什么`)
  }
})

test('① ★★ 密钥那一类的动作必须是 `ask`（它是"保留"与"彻底删"之间那条线）', () => {
  assert.equal(DATA_CLASSES.secret.onUninstall, 'ask')
})

test('① ★★ 三种卸载模式必须**两两不同**（三个名字同一组动作 = 只提供了一种选择）', () => {
  assert.equal(UNINSTALL_MODE_IDS.length, 3)
  const shapes = new Set(Object.values(UNINSTALL_MODES).map((m) => [...m.removes].sort().join(',')))
  assert.equal(shapes.size, 3, '三个模式的实际删除集合必须两两不同')
  // 每个模式都删程序、都不删工作区
  for (const m of Object.values(UNINSTALL_MODES)) {
    assert.ok(m.removes.includes('program'), `${m.id} 不删程序`)
    assert.ok(!m.removes.includes('workspace'), `${m.id} 会删工作区`)
  }
})

test('① ★★ 分类器先判**更窄**的类：密钥库配在 dataDir 下时仍归为 secret', () => {
  // 这是最要紧的一条。先判容器会把密钥归成"业务数据库"，
  // 于是 keep-data 会**静默地留下凭据**。
  const layout = { dataDir: 'C:/h/data', secretsFile: 'C:/h/data/secrets/secrets.json' }
  assert.equal(classifyPath({ path: 'C:/h/data/secrets/secrets.json' }, layout).classId, 'secret')
  assert.equal(classifyPath({ path: 'C:/h/data/team.db' }, layout).classId, null, '未标注的 dataDir 内容不该被猜成数据库')
})

test('① ★ 分类器对显式标注优先于 dataDir 兜底，认不出时返回 null（不猜）', () => {
  const layout = { dataDir: 'C:/h/data' }
  assert.equal(classifyPath({ path: 'C:/h/data/team.db', classId: 'database' }, layout).classId, 'database')
  assert.equal(classifyPath({ path: 'C:/elsewhere/thing' }, layout).classId, null)
  assert.equal(classifyPath({ path: '' }, layout).classId, null)
})

test('① ★ 工作区与其他落点分得开（工作区永远不删）', () => {
  const layout = { workspaceDir: 'C:/w', logDir: 'C:/h/log' }
  assert.equal(classifyPath({ path: 'C:/w/repo/a.js' }, layout).classId, 'workspace')
  assert.equal(classifyPath({ path: 'C:/h/log/a.log' }, layout).classId, 'log')
  assert.equal(DATA_CLASSES.workspace.onUninstall, 'never')
})

// ---------------------------------------------------------------- 策略健全性

test('② ★★ 每个受约束的类都必须有上限，且"不设上限"要**显式**写 null', () => {
  assert.equal(RETENTION_CHECKED.ok, true, JSON.stringify(RETENTION_CHECKED.problems))
  assert.deepEqual([...RETENTION_CLASSES], ['log', 'event', 'artifact'])
  // 缺席（忘了配）必须被报出来
  const missing = assertRetentionBounded({ log: { maxAgeDays: 1, maxBytes: 1 } })
  assert.equal(missing.ok, false)
  assert.match(missing.problems.join('\n'), /event|artifact/)
  // 两个维度都不设上限也要被报出来
  const wide = assertRetentionBounded({
    log: { maxAgeDays: null, maxBytes: null }, event: { maxAgeDays: 1, maxBytes: 1 }, artifact: { maxAgeDays: 1, maxBytes: 1 },
  })
  assert.equal(wide.ok, false)
  assert.match(wide.problems.join('\n'), /不受约束/)
  // 显式 null 只在一维上是允许的
  const okNull = assertRetentionBounded({
    log: { maxAgeDays: null, maxBytes: 100 }, event: { maxAgeDays: 1, maxBytes: 1 }, artifact: { maxAgeDays: 1, maxBytes: 1 },
  })
  assert.equal(okNull.ok, true, JSON.stringify(okNull.problems))
})

test('② ★★ 缺策略的类报 `UNBOUNDED_CLASS`（"忘了配"不能变成"没有上限"）', () => {
  const r = planRetention({ entries: [], policy: { log: { maxAgeDays: 1, maxBytes: 10 } }, nowMs: NOW })
  const codes = r.findings.map((f) => f.code)
  assert.ok(codes.includes(RETENTION_CODES.UNBOUNDED_CLASS))
})

// ---------------------------------------------------------------- ★★ 坑①：总用量

test('③ ★★ 总用量是**三类之和**，且列出没有上限的类（一个类的用量不能冒充总量）', () => {
  const entries = [e('l1', 'log', 1, 100), e('e1', 'event', 1, 200), e('a1', 'artifact', 1, 300)]
  const r = planRetention({ entries, nowMs: NOW })
  assert.deepEqual(r.usageByClass, { log: 100, event: 200, artifact: 300 })
  assert.equal(r.usageTotal.bytes, 600, '总量必须是三类之和')
  assert.equal(r.usageTotal.classes, 3)
  // 把 artifact 设成不设上限 → 必须能被看见
  const r2 = planRetention({
    entries, nowMs: NOW,
    policy: { log: { maxAgeDays: 1, maxBytes: 10 }, event: { maxAgeDays: 1, maxBytes: 10 }, artifact: { maxAgeDays: null, maxBytes: null } },
  })
  assert.deepEqual([...r2.usageTotal.unbounded], ['artifact'])
  // 而 assertRetentionBounded 会拦住它
  assert.equal(assertRetentionBounded({
    log: { maxAgeDays: 1, maxBytes: 10 }, event: { maxAgeDays: 1, maxBytes: 10 }, artifact: { maxAgeDays: null, maxBytes: null },
  }).ok, false)
})

// ---------------------------------------------------------------- ★★ 坑②：删最新

test('③ ★★ 按时间裁时删的是**最旧的**，最新的必须留下（排序反了不会报错）', () => {
  const entries = [e('new', 'log', 1, 10), e('mid', 'log', 40, 10), e('old', 'log', 90, 10)]
  const r = planRetention({ entries, nowMs: NOW })   // 默认 30 天
  const deleted = r.delete.map((d) => d.id).sort()
  assert.deepEqual(deleted, ['mid', 'old'], '超过 30 天的才该删')
  assert.ok(r.keep.some((k) => k.id === 'new'), '最新的必须留下')
  assert.ok(!r.delete.some((d) => d.id === 'new'), '最新的**绝不能**被删')
})

test('③ ★★ 按容量裁时也从**最旧的**开始删', () => {
  const entries = [e('old', 'log', 10, 100), e('mid', 'log', 5, 100), e('new', 'log', 1, 100)]
  // 上限 250：删掉最旧的一个（old）后剩 200 ≤ 250，因此**只**删一个。
  // （上限写 150 会需要删两个——那是容量算术，不是排序问题。）
  const r = planRetention({
    entries, nowMs: NOW,
    policy: { log: { maxAgeDays: 999, maxBytes: 250 }, event: { maxAgeDays: 999, maxBytes: 1e9 }, artifact: { maxAgeDays: 999, maxBytes: 1e9 } },
  })
  assert.deepEqual(r.delete.map((d) => d.id), ['old'], '只该删最旧的那一个')
  const kept = r.keep.filter((k) => k.classId === 'log').map((k) => k.id).sort()
  assert.deepEqual(kept, ['mid', 'new'])
})

test('③ ★★ 容量不够时必须一直删到**低于**上限，而不是删一个就交差', () => {
  const entries = [e('old', 'log', 10, 100), e('mid', 'log', 5, 100), e('new', 'log', 1, 100)]
  const r = planRetention({
    entries, nowMs: NOW,
    policy: { log: { maxAgeDays: 999, maxBytes: 150 }, event: { maxAgeDays: 999, maxBytes: 1e9 }, artifact: { maxAgeDays: 999, maxBytes: 1e9 } },
  })
  // 300 > 150，删 old → 200 仍 > 150，必须再删 mid → 100 ≤ 150
  assert.deepEqual(r.delete.map((d) => d.id).sort(), ['mid', 'old'])
  assert.equal(r.keep.filter((k) => k.classId === 'log').map((k) => k.id).join(','), 'new')
})

test('③ ★★ 时间与容量**两种都表达**：时间不超但容量超时仍然要裁', () => {
  const entries = [e('a', 'artifact', 1, 100), e('b', 'artifact', 2, 100)]
  const r = planRetention({
    entries, nowMs: NOW,
    policy: { log: { maxAgeDays: 1, maxBytes: 1 }, event: { maxAgeDays: 1, maxBytes: 1 }, artifact: { maxAgeDays: 999, maxBytes: 100 } },
  })
  // ★ 最旧的是 `b`（2 天前），不是 `a`。排序写反就会删 `a`。
  assert.equal(r.delete.length, 1, '容量超了必须裁，即使时间没超')
  assert.equal(r.delete[0].id, 'b', '裁掉的必须是最旧的（b 是 2 天前）')
})

test('③ ★★ 默认策略下 artifact **没有**时间上限（只有容量上限）', () => {
  // 这一条钉住默认值本身，免得下一个人以为"产物也会按 30 天清掉"。
  const r = planRetention({ entries: [e('old', 'artifact', 9999, 10)], nowMs: NOW })
  assert.equal(r.delete.length, 0, '默认策略不清旧产物——它只有容量上限')
  assert.equal(DEFAULT_RETENTION.artifact.maxAgeDays, null)
})

// ---------------------------------------------------------------- ★★ 坑③：引用

test('③ ★★ 被进行中 Run 引用的产物**不删**（删了失败会发生在很久之后的另一步）', () => {
  // 默认策略下 artifact 没有时间上限，所以这里必须给一个**有**时间上限的策略，
  // 否则"什么都没删"会让这条用例变成空的（第一版就是这个问题）。
  const policy = {
    log: { maxAgeDays: 999, maxBytes: 1e9 }, event: { maxAgeDays: 999, maxBytes: 1e9 },
    artifact: { maxAgeDays: 30, maxBytes: 1e9 },
  }
  const entries = [e('old', 'artifact', 100, 100), e('used', 'artifact', 100, 100)]
  const r = planRetention({ entries, nowMs: NOW, activeRefs: ['used'], policy })
  assert.ok(!r.delete.some((d) => d.id === 'used'), '被引用的不能被删')
  assert.ok(r.keep.some((k) => k.id === 'used'))
  assert.ok(r.delete.some((d) => d.id === 'old'), `没被引用的照样该删，实际 ${JSON.stringify(r.delete)}`)
})

test('③ ★★ 引用的**间接**关系也算（条目自己声明了 referencedBy）', () => {
  const policy = {
    log: { maxAgeDays: 999, maxBytes: 1e9 }, event: { maxAgeDays: 999, maxBytes: 1e9 },
    artifact: { maxAgeDays: 30, maxBytes: 1e9 },
  }
  const entries = [e('art', 'artifact', 100, 100, { referencedBy: ['run-1'] })]
  const r = planRetention({ entries, nowMs: NOW, activeRefs: ['run-1'], policy })
  assert.equal(r.delete.length, 0, '被进行中的 Run 间接引用的产物不能被删')
})

test('③ ★★ 删无可删仍然超限时报 `CAP_UNREACHABLE`，而不是假装成功', () => {
  const entries = [e('a', 'artifact', 100, 100), e('b', 'artifact', 100, 100)]
  const r = planRetention({
    entries, nowMs: NOW, activeRefs: ['a', 'b'],
    policy: { log: { maxAgeDays: 1, maxBytes: 1 }, event: { maxAgeDays: 1, maxBytes: 1 }, artifact: { maxAgeDays: 999, maxBytes: 50 } },
  })
  assert.equal(r.delete.length, 0)
  const f = r.findings.find((x) => x.code === RETENTION_CODES.CAP_UNREACHABLE)
  assert.ok(f, `必须报出无法达到上限，实际 ${JSON.stringify(r.findings)}`)
  assert.equal(f.classId, 'artifact')
  assert.ok(f.remainingBytes > f.capBytes)
})

// ---------------------------------------------------------------- 边界

test('④ ★★ 没有 `nowMs` 时**什么都不删**（不猜当前时间）', () => {
  const entries = [e('old', 'log', 9999, 100)]
  const r = planRetention({ entries })
  assert.equal(r.delete.length, 0)
  assert.equal(r.keep.length, 1)
  assert.ok(r.findings.some((f) => f.code === RETENTION_CODES.ENTRY_MALFORMED))
})

test('④ ★ 不受保留策略约束的类一律保留（不能顺手删掉数据库）', () => {
  const entries = [e('db', 'database', 9999, 100), e('sec', 'secret', 9999, 100), e('prog', 'program', 9999, 100)]
  const r = planRetention({ entries, nowMs: NOW })
  assert.equal(r.delete.length, 0, JSON.stringify(r.delete))
  assert.equal(r.keep.length, 3)
})

test('④ ★ 删除项带 `reason`（报表要能解释为什么删它）', () => {
  const r = planRetention({ entries: [e('old', 'log', 90, 10)], nowMs: NOW })
  assert.ok(r.delete[0].reason.length > 0)
  assert.ok(r.keep.length === 0)
})

test('④ ★ 返回对象被冻结', () => {
  const r = planRetention({ entries: [], nowMs: NOW })
  assert.ok(Object.isFrozen(r))
  assert.ok(Object.isFrozen(r.delete))
  assert.throws(() => { 'use strict'; r.delete = [] }, TypeError)
})

test('④ ★ 默认策略本身就是健全的（否则每个调用方都要自己发现）', () => {
  assert.equal(assertRetentionBounded(DEFAULT_RETENTION).ok, true)
})
