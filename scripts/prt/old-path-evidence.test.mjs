// scripts/prt/old-path-evidence.test.mjs — PRT-005 / PRT-009 旧路径证据提取单测
//
// 这套用例的重心不是「函数能跑」，而是**把两个会给出偏小数字的错误口径钉死**：
//
//   ① `audit.scope` 是**动作发起者当时的空间视图**，不是任务所属空间。
//      按 scope 过滤审计行会丢掉「将军从 default 视图推进 software 任务」这类行，
//      状态序列被截断、端到端耗时随之少算最后一段。
//      这类错误不抛异常、只给出偏小的数——是最难发现的一种，必须由用例守着。
//   ② `release-stale` 是守护每轮的释放扫描（生产库实测 5898 行），
//      不排掉就会淹没真实轨迹。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import {
  ACTION_TO_STATE,
  HEARTBEAT_ACTION,
  HUMAN_MEMBERS,
  NOISE_ACTIONS,
  availabilityGaps,
  checkExpectedSequence,
  countHumanInterventions,
  distinctStates,
  extractEvidence,
  latencyStats,
  measureLatency,
  parseDetail,
  percentile,
  reconstructSequence,
} from './old-path-evidence.mjs'

// ---------------------------------------------------------------- ① detail 解析

test('parseDetail：空值返回 {}，畸形返回 null（两者语义不同）', () => {
  assert.deepEqual(parseDetail(null), {})
  assert.deepEqual(parseDetail(undefined), {})
  assert.deepEqual(parseDetail(''), {})
  // 畸形 JSON 返回 null 而不是 {}：调用方据此区分「没有 detail」与「有但读不懂」，
  // 两者混为一谈会让审计模型腐坏被静默吞掉。
  assert.equal(parseDetail('{不是 json'), null)
  assert.deepEqual(parseDetail('{"to":"done"}'), { to: 'done' })
})

test('parseDetail：非对象 JSON 包成 {value}，已是对象则原样返回', () => {
  assert.deepEqual(parseDetail('5'), { value: 5 })
  assert.deepEqual(parseDetail('"x"'), { value: 'x' })
  const obj = { to: 'done' }
  assert.equal(parseDetail(obj), obj)
})

// ---------------------------------------------------------------- ② 序列还原

test('reconstructSequence：按 seq 排序，不依赖传入顺序', () => {
  const rows = [
    { seq: 3, action: 'transition', detail: '{"to":"done"}', ts: '2026-01-01T00:00:03Z', member: 'general' },
    { seq: 1, action: 'create', detail: '{"title":"x"}', ts: '2026-01-01T00:00:01Z', member: 'general' },
    { seq: 2, action: 'claim', detail: '{"soldier":"coder"}', ts: '2026-01-01T00:00:02Z', member: 'soldier-auto' },
  ]
  const { states } = reconstructSequence(rows)
  assert.deepEqual(states.map((s) => s.state), ['todo', 'in_progress', 'done'])
})

test('reconstructSequence：create→todo、claim→in_progress、advance→advanced', () => {
  assert.equal(ACTION_TO_STATE.create, 'todo')
  assert.equal(ACTION_TO_STATE.claim, 'in_progress')
  const { states } = reconstructSequence([
    { seq: 1, action: 'advance', detail: '{}', ts: '2026-01-01T00:00:01Z', member: 'coder' },
  ])
  // advance 不写 to 值，所以记为 advanced 而不是 done。
  // 若把 advance 直接当成 done，会把「流水线推进到下一环」误读成「任务已完成」。
  assert.deepEqual(states.map((s) => s.state), ['advanced'])
})

test('reconstructSequence：transition 缺 to 计入 unmapped，不静默丢弃', () => {
  const { states, unmappedActions } = reconstructSequence([
    { seq: 1, action: 'transition', detail: '{}', ts: '2026-01-01T00:00:01Z', member: 'x' },
  ])
  assert.deepEqual(states, [])
  assert.equal(unmappedActions.length, 1)
  assert.match(unmappedActions[0], /缺 to/)
})

test('reconstructSequence：噪音动作被排除，与状态无关的动作也不报警', () => {
  const rows = [
    { seq: 1, action: 'create', detail: '{}', ts: '2026-01-01T00:00:01Z', member: 'general' },
    { seq: 2, action: 'release-stale', detail: '{"released":[]}', ts: '2026-01-01T00:00:02Z', member: 'soldier-auto' },
    { seq: 3, action: 'comment', detail: '{}', ts: '2026-01-01T00:00:03Z', member: 'soldier-auto' },
    { seq: 4, action: 'progress', detail: '{"percent":50}', ts: '2026-01-01T00:00:04Z', member: 'soldier-auto' },
  ]
  const { states, unmappedActions } = reconstructSequence(rows)
  assert.deepEqual(states.map((s) => s.state), ['todo'])
  assert.deepEqual(unmappedActions, [])
  assert.ok(NOISE_ACTIONS.includes('release-stale'))
})

test('reconstructSequence：畸形的 detail 被计数', () => {
  const { malformedDetails } = reconstructSequence([
    { seq: 1, action: 'create', detail: '{坏了', ts: '2026-01-01T00:00:01Z', member: 'general' },
  ])
  assert.equal(malformedDetails, 1)
})

// ---------------------------------------------------------------- ③ 状态去重

test('distinctStates：合并相邻重复，但保留回退后的再次出现', () => {
  const mk = (...names) => names.map((state, i) => ({ state, seq: i + 1 }))
  assert.deepEqual(distinctStates(mk('a', 'a', 'b', 'b', 'a')), ['a', 'b', 'a'])
  assert.deepEqual(distinctStates(mk('todo')), ['todo'])
  assert.deepEqual(distinctStates([]), [])
})

// ---------------------------------------------------------------- ④ 耗时口径

test('measureLatency：少于 2 个状态标记返回 null（不是 0）', () => {
  // 返回 0 会让「测不到」看起来像「瞬间完成」，直接把统计拉低。
  assert.equal(measureLatency([]), null)
  assert.equal(measureLatency([{ state: 'todo', at: '2026-01-01T00:00:00Z', seq: 1 }]), null)
  assert.equal(measureLatency(null), null)
})

test('measureLatency：取首末标记的墙钟差', () => {
  const r = measureLatency([
    { state: 'todo', at: '2026-01-01T00:00:00Z', seq: 1 },
    { state: 'done', at: '2026-01-01T00:01:30Z', seq: 2 },
  ])
  assert.equal(r.ms, 90_000)
  assert.equal(r.from, '2026-01-01T00:00:00Z')
  assert.equal(r.to, '2026-01-01T00:01:30Z')
})

test('measureLatency：时间戳不可解析时返回 null', () => {
  assert.equal(measureLatency([
    { state: 'a', at: '不是时间', seq: 1 },
    { state: 'b', at: '2026-01-01T00:00:00Z', seq: 2 },
  ]), null)
})

// ---------------------------------------------------------------- ⑤ 人工介入

test('countHumanInterventions：只认人（general），不认守护与岗位角色', () => {
  const rows = [
    { member: 'general', action: 'transition' },
    { member: 'general', action: 'comment' },
    { member: 'soldier-auto', action: 'claim' },
    { member: 'coder', action: 'transition' },
    { member: 'mediator-auto', action: 'advance' },
  ]
  const r = countHumanInterventions(rows)
  assert.equal(r.total, 2)
  assert.deepEqual(r.byAction, { transition: 1, comment: 1 })
  assert.deepEqual(HUMAN_MEMBERS, ['general'])
})

test('countHumanInterventions：把所有人当人不等于正确 —— 判据错了会虚高', () => {
  const rows = [{ member: 'soldier-auto', action: 'claim' }, { member: 'coder', action: 'progress' }]
  assert.equal(countHumanInterventions(rows).total, 0, '守护/岗位不是人')
})

// ---------------------------------------------------------------- ⑥ 统计

test('percentile：空数组返回 null，单元素恒为它本身', () => {
  assert.equal(percentile([], 50), null)
  assert.equal(percentile([7], 50), 7)
  assert.equal(percentile([7], 99), 7)
})

test('percentile：p50 与 p90 落在正确位置', () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  assert.equal(percentile(v, 50), 5)
  assert.equal(percentile(v, 90), 9)
  assert.equal(percentile(v, 100), 10)
})

test('latencyStats：过滤非有限数值，空集返回 null', () => {
  assert.equal(latencyStats([]), null)
  assert.equal(latencyStats([null, undefined, NaN]), null)
  const s = latencyStats([1000, 3000, 2000])
  assert.equal(s.samples, 3)
  assert.equal(s.minMs, 1000)
  assert.equal(s.maxMs, 3000)
  assert.equal(s.meanMs, 2000)
  assert.equal(s.p50Ms, 2000)
})

// ---------------------------------------------------------------- ⑦ 全库提取

/**
 * 造一个最小 team-hub 库。
 *
 * 关键构造：`general` 推进 done 时,审计行的 `scope` 是 `default`，
 * 而任务属于 `software` —— 复刻生产库里真实存在的形态。
 */
function makeDb(tasks, audit) {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, scope TEXT, role TEXT, status TEXT,
                        title TEXT, goalId TEXT, createdAt TEXT, updatedAt TEXT);
    CREATE TABLE audit (seq INTEGER PRIMARY KEY, ts TEXT, member TEXT, scope TEXT,
                        action TEXT, taskId TEXT, detail TEXT, goalId TEXT);
  `)
  const ti = db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)')
  for (const t of tasks) {
    ti.run(t.id, t.scope, t.role ?? 'coder', t.status, t.title ?? 't', t.goalId ?? null,
      t.createdAt ?? '2026-01-01T00:00:00Z', t.updatedAt ?? '2026-01-01T00:00:00Z')
  }
  const ai = db.prepare('INSERT INTO audit VALUES (?,?,?,?,?,?,?,?)')
  for (const a of audit) {
    ai.run(a.seq, a.ts, a.member, a.scope ?? a.taskScope ?? 'software', a.action, a.taskId,
      a.detail ?? '{}', a.goalId ?? null)
  }
  return db
}

test('extractEvidence：**致命口径** —— audit.scope 与任务空间不同时不得丢行', () => {
  // 这条用例锁的是一个真实踩过的坑：按 `audit.scope='software'` 过滤会丢掉
  // general 从 default 视图发起的 done 迁移，序列被截断在 in_review，
  // 端到端耗时随之少算最后一段（实测把 p50 从 4184s 低估成 2531s）。
  const db = makeDb(
    [{ id: 'T-1', scope: 'software', status: 'done' }],
    [
      { seq: 1, ts: '2026-01-01T00:00:00Z', member: 'general', scope: 'default', action: 'create', taskId: 'T-1', detail: '{"title":"x"}' },
      { seq: 2, ts: '2026-01-01T00:10:00Z', member: 'soldier-auto', scope: 'software', action: 'claim', taskId: 'T-1', detail: '{"soldier":"coder"}' },
      { seq: 3, ts: '2026-01-01T00:20:00Z', member: 'coder', scope: 'software', action: 'transition', taskId: 'T-1', detail: '{"to":"in_review"}' },
      // ↓ 人从 default 视图推进 —— 按 scope 过滤就会丢掉这一行
      { seq: 4, ts: '2026-01-01T00:30:00Z', member: 'general', scope: 'default', action: 'transition', taskId: 'T-1', detail: '{"to":"done"}' },
    ],
  )
  const ev = extractEvidence(db, { scope: 'software' })
  db.close()

  const t = ev.perTask.find((x) => x.id === 'T-1')
  assert.deepEqual(t.states, ['todo', 'in_progress', 'in_review', 'done'], '序列必须到达 done')
  assert.equal(t.latencyMs, 30 * 60_000, '耗时必须覆盖到 done 那一段')
  assert.equal(t.humanInterventions, 2, '人发起的两次动作都要算上')
  // 并且这个不一致本身要被记录，因为它才是「按 scope 过滤会漏行」的证据
  assert.equal(ev.auditScopeMismatch.rows, 2)
  assert.equal(ev.auditScopeMismatch.byScope.default, 2)
})

test('extractEvidence：另一空间的任务不进结果', () => {
  const db = makeDb(
    [
      { id: 'T-1', scope: 'software', status: 'done' },
      { id: 'T-9', scope: 'ozon', status: 'done' },
    ],
    [
      { seq: 1, ts: '2026-01-01T00:00:00Z', member: 'general', scope: 'software', action: 'create', taskId: 'T-1' },
      { seq: 2, ts: '2026-01-01T00:00:00Z', member: 'general', scope: 'ozon', action: 'create', taskId: 'T-9' },
    ],
  )
  const ev = extractEvidence(db, { scope: 'software' })
  db.close()
  assert.equal(ev.taskCount, 1)
  assert.deepEqual(ev.perTask.map((t) => t.id), ['T-1'])
})

test('extractEvidence：两个总体分开报 —— 任务视角与空间视角不混为一谈', () => {
  // 这是本工具最容易说错的地方：`audit.scope` 视角与「归属本空间任务」视角
  // 双向不同。共用一个数字会让读者以为看到的是空间全貌。
  const db = makeDb(
    [{ id: 'T-1', scope: 'software', status: 'done' }],
    [
      { seq: 1, ts: '2026-01-01T00:00:00Z', member: 'general', scope: 'software', action: 'create', taskId: 'T-1' },
      // 守护扫描：在空间视角里，不归属任何任务
      { seq: 2, ts: '2026-01-01T00:00:01Z', member: 'soldier-auto', scope: 'software', action: 'release-stale', taskId: '*' },
      // 人从 default 视图推进：归属任务，但不在空间视角里
      { seq: 3, ts: '2026-01-01T00:00:02Z', member: 'general', scope: 'default', action: 'transition', taskId: 'T-1', detail: '{"to":"done"}' },
    ],
  )
  const ev = extractEvidence(db, { scope: 'software' })
  db.close()

  // 空间视角 2 行（create + release-stale），任务视角 2 行（create + done 迁移）
  assert.equal(ev.auditRows, 2)
  assert.equal(ev.auditRowsTaskAttributed, 2)
  // 空间视角能看到 release-stale —— 它确实在本空间发生
  assert.equal(ev.actionCounts['release-stale'], 1)
  assert.equal(ev.memberCounts['soldier-auto'], 1)
  // 任务视角的序列必须到达 done
  assert.deepEqual(ev.perTask[0].states, ['todo', 'done'])
  // 人工介入 = general 在本空间任务上发起的动作：发布任务（create）+ 推进 done，共 2 次。
  // 关键在**不包含** soldier-auto 的 release-stale——它虽是本空间动作，
  // 但与任何任务无关；把它算进来会让「每完成任务人工介入次数」虚高。
  assert.equal(ev.human.total, 2)
})

test('extractEvidence：release-stale（taskId=*）不进任何任务的轨迹', () => {
  const db = makeDb(
    [{ id: 'T-1', scope: 'software', status: 'done' }],
    [
      { seq: 1, ts: '2026-01-01T00:00:00Z', member: 'general', scope: 'software', action: 'create', taskId: 'T-1' },
      { seq: 2, ts: '2026-01-01T00:00:01Z', member: 'soldier-auto', scope: 'software', action: 'release-stale', taskId: '*' },
    ],
  )
  const ev = extractEvidence(db, { scope: 'software' })
  db.close()
  assert.deepEqual(ev.perTask[0].states, ['todo'])
  assert.equal(ev.tasksWithTrail, 1)
})

test('extractEvidence：显式列出「旧路径记不到」的项，而不是留空', () => {
  const db = makeDb([{ id: 'T-1', scope: 'software', status: 'done' }], [])
  const ev = extractEvidence(db, { scope: 'software' })
  db.close()
  const keys = ev.notRecorded.map((n) => n.key)
  assert.ok(keys.includes('token-usage'))
  assert.ok(keys.includes('estimated-cost'))
  assert.ok(keys.includes('peak-resource'))
  for (const n of ev.notRecorded) assert.ok(n.why.length > 10, '每项都要说明为什么记不到')
})

test('extractEvidence：缺表时明确报错，不静默返回空结果', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE tasks (id TEXT)')
  assert.throws(() => extractEvidence(db, { scope: 'software' }), /缺少表 audit/)
  db.close()
})

// ---------------------------------------------------------------- ⑧ 预期序列核对

test('checkExpectedSequence：识别出「多数任务不走 in_review」并给出结论', () => {
  // 这正是黄金流程 `expectedTaskStateSequence` 的真实处境：写的是
  // todo→in_progress→in_review→done，而 76 个完成任务里只有 4 个符合，
  // 42 个根本不经过 in_review（`advanceTask` 允许 in_progress 直接 done）。
  const perTask = [
    { id: 'a', status: 'done', states: ['todo', 'in_progress', 'in_review', 'done'] },
    { id: 'b', status: 'done', states: ['in_progress', 'advanced'] },
    { id: 'c', status: 'done', states: ['in_progress', 'advanced'] },
  ]
  const r = checkExpectedSequence(perTask, ['todo', 'in_progress', 'in_review', 'done'])
  assert.equal(r.completedWithTrail, 3)
  assert.equal(r.exactPrefixMatches, 1)
  assert.equal(r.tasksSkippingInReview, 2)
  assert.match(r.conclusion, /不符|修正/)
})

test('checkExpectedSequence：全部合规时结论为正', () => {
  const perTask = [
    { id: 'a', status: 'done', states: ['todo', 'in_progress', 'in_review', 'done'] },
    { id: 'b', status: 'done', states: ['todo', 'in_progress', 'in_review', 'done'] },
  ]
  const r = checkExpectedSequence(perTask, ['todo', 'in_progress', 'in_review', 'done'])
  assert.equal(r.exactPrefixMatches, 2)
  assert.equal(r.tasksSkippingInReview, 0)
  assert.match(r.conclusion, /可作对拍基准/)
})

test('checkExpectedSequence：无样本时 matchRate 为 null 而非 0', () => {
  const r = checkExpectedSequence([], ['todo', 'in_progress'])
  assert.equal(r.completedWithTrail, 0)
  assert.equal(r.matchRate, null)
})

// ---------------------------------------------------------------- ⑤ 可用性空窗

/** 造一串等间隔心跳。 */
function heartbeats(fromIso, count, stepMs) {
  const t0 = Date.parse(fromIso)
  return Array.from({ length: count }, (_, i) => ({ seq: i, ts: new Date(t0 + i * stepMs).toISOString(), action: HEARTBEAT_ACTION, member: 'soldier-auto', detail: '{"released":[]}' }))
}

test('availabilityGaps：按心跳动作识别，健康节奏不产生空窗', () => {
  const rows = heartbeats('2026-09-11T00:00:00Z', 20, 30_000)
  const a = availabilityGaps(rows)
  assert.equal(a.heartbeatCount, 20)
  assert.equal(a.medianIntervalMs, 30_000)
  assert.equal(a.gapCount, 0)
  assert.equal(a.longestGapMs, null)
})

test('availabilityGaps：只有 release-stale 算心跳；别的动作再密也补不上空窗', () => {
  // 这一点必须先量过才能依赖：如果心跳是「有动作才写」，那么空窗只说明「没东西可释放」，
  // 与进程死没死无关——拿它判可用性就是错的。用例把这条判据钉死。
  const rows = [
    ...heartbeats('2026-09-11T00:00:00Z', 3, 30_000),
    // 空窗期间别的动作在写（将军在别的空间干活），但本条空窗不受影响，因为是全空间视图
    { seq: 99, ts: '2026-09-11T00:20:00Z', action: 'comment', member: 'general', detail: '{}' },
    ...heartbeats('2026-09-11T01:00:00Z', 2, 30_000),
  ]
  const a = availabilityGaps(rows)
  assert.equal(a.heartbeatCount, 5)
  assert.equal(a.gapCount, 1)
  assert.equal(a.longestGapMs, Date.parse('2026-09-11T01:00:00Z') - Date.parse('2026-09-11T00:01:00Z'))
})

test('availabilityGaps：低于阈值不报（抖动不淹没清单），到阈值才报', () => {
  const rows = [
    ...heartbeats('2026-09-11T00:00:00Z', 2, 30_000),
    ...heartbeats('2026-09-11T00:04:00Z', 2, 30_000), // 3 分钟空窗
  ]
  assert.equal(availabilityGaps(rows, { minGapMs: 300_000 }).gapCount, 0)
  const withShort = availabilityGaps(rows, { minGapMs: 60_000 })
  assert.equal(withShort.gapCount, 1)
  assert.equal(withShort.gapsByBucket['5-30m'], 1)
})

test('availabilityGaps：分桶区分「跨夜关机」与「白天掉线」，recentGaps 保最近几段', () => {
  // 三种空窗各一段：14h（跨夜关机）、90m（白天掉线）、40m（白天短抖）。
  // 时刻写死而不是用等间隔助手拼——助手会引入我没打算要的额外空窗，
  // 那样断言就会去解释一个不是本用例意图的形状。
  const at = (...ts) => ts.map((t, i) => ({ seq: i, ts: t, action: HEARTBEAT_ACTION, member: 'soldier-auto', detail: '{"released":[]}' }))
  const rows = [
    ...at('2026-09-01T00:00:00.000Z', '2026-09-01T00:00:30.000Z'),
    ...at('2026-09-01T14:00:30.000Z', '2026-09-01T14:01:00.000Z'), // 空窗 14h
    ...at('2026-09-01T15:31:00.000Z', '2026-09-01T15:31:30.000Z'), // 空窗 90m
    ...at('2026-09-01T16:11:30.000Z', '2026-09-01T16:12:00.000Z'), // 空窗 40m
  ]
  const a = availabilityGaps(rows)
  assert.equal(a.gapCount, 3)
  assert.equal(a.gapsByBucket['>=2h'], 1)
  assert.equal(a.gapsByBucket['1-2h'], 1)
  assert.equal(a.gapsByBucket['30-60m'], 1)
  assert.equal(a.gapsByBucket['5-30m'], 0)
  // 最长的一段排在最前
  assert.equal(a.gaps[0].from, '2026-09-01T00:00:30.000Z')
  assert.equal(a.longestGapMs, 14 * 3_600_000)
  // recentGaps 是**时序**上的最后几段，与「最长的几段」不是同一个集合
  assert.equal(a.recentGaps.at(-1).to, '2026-09-01T16:11:30.000Z')
})

test('availabilityGaps：无心跳时各项为 null/0，不抛错（新空间还没跑过就是这种状态）', () => {
  const a = availabilityGaps([])
  assert.equal(a.heartbeatCount, 0)
  assert.equal(a.medianIntervalMs, null)
  assert.equal(a.longestGapMs, null)
  assert.deepEqual(a.gaps, [])
})
