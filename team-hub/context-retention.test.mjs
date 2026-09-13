// team-hub/context-retention.test.mjs
// ============================================================================
// PRT-409（收尾）：快照保留策略——证据的去留，与"清掉了"必须留痕
//
// spec line 748：「日志、事件和产物设置容量上限与保留策略。」
// spec line 897：「`PRT-409`：持久化快照并支持查看和导出。」
//
// ## 本套件盯的三件事
//
// ① **清掉之后必须留墓碑。** `get()` 的 `null` 把"从来没存在过"与
//    "被策略清掉了"压成了同一个。对一个以"可还原"为卖点的产品，
//    这两件事的差别就是全部意义：
//
//      > 一份"被保留策略清掉"的快照，与一份"从来没有过"的快照，
//      > 在只看 `get()` 的代码里是同一个 `null`。
//
// ② **默认不销毁任何证据。** 默认策略是显式的 `{maxAgeDays:null,maxBytes:null}`。
//    一个有上限的默认值会成为一次**静默的数据丢失**。
//
// ③ **字节不是字符。** 快照正文大量是中文，UTF-8 下一个汉字 3 字节。
//    拿 `.length` 比字节上限，在纯英文数据上恰好是对的。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  planSnapshotRetention, utf8Bytes, snapshotRowBytes, DEFAULT_SNAPSHOT_RETENTION,
  SNAPSHOT_RETENTION_CODES, SNAPSHOT_CLASS_ID, SNAPSHOT_RETENTION_CHECKED,
  assertSnapshotRetentionExplicit,
} from './context-retention.mjs'
import { createContextStore, CONTEXT_STORE_ERRORS } from './context-store.mjs'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-snapret-'))
let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}
async function get(path) {
  const res = await fetch(base + path)
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

/** 用给定的 attemptId 与 frozenAtMs 冻一份快照。 */
async function freeze(attemptId, { frozenAtMs = 1_700_000_000_000, content = '一段正文' } = {}) {
  const r = await post('/api/context-snapshots/assemble', {
    attemptId, runId: attemptId, frozenAtMs, scope: 'default', canReadAll: true,
    candidates: [{
      source: {
        id: 'doc:1', type: 'document', version: 'v1', acquiredAtMs: frozenAtMs - 1000,
        content, trust: 'untrusted',
      },
    }],
  })
  assert.equal(r.status, 200, `装配失败：${JSON.stringify(r.body).slice(0, 200)}`)
  return attemptId
}

// ── ① 默认策略：不销毁任何证据 ───────────────────────────────────────────

test('① 默认策略**显式**不设上限，且默认计划一份都不清', () => {
  assert.equal(Object.hasOwn(DEFAULT_SNAPSHOT_RETENTION, 'maxAgeDays'), true)
  assert.equal(Object.hasOwn(DEFAULT_SNAPSHOT_RETENTION, 'maxBytes'), true)
  assert.equal(DEFAULT_SNAPSHOT_RETENTION.maxAgeDays, null)
  assert.equal(DEFAULT_SNAPSHOT_RETENTION.maxBytes, null)
  assert.equal(SNAPSHOT_RETENTION_CHECKED.deletesNothingByDefault, true,
    '默认必须是不销毁——一个有上限的默认值就是一次静默的数据丢失')
  assert.equal(SNAPSHOT_RETENTION_CHECKED.ok, true, JSON.stringify(SNAPSHOT_RETENTION_CHECKED.problems))

  // 一份极旧的快照，在默认策略下也不清
  const plan = planSnapshotRetention({
    rows: [{ attemptId: 'a', runId: 'r', frozenAtMs: NOW - 3650 * DAY, finalText: 'x', payloadJson: 'y' }],
    nowMs: NOW,
  })
  assert.equal(plan.purge.length, 0, '默认策略下一次清理都不该发生')
  assert.equal(plan.keep.length, 1)
})

test('①b 策略缺字段 **区分**"忘了配"与"故意不设"', () => {
  // 缺字段 → finding
  const missing = planSnapshotRetention({ rows: [], policy: {}, nowMs: NOW })
  assert.ok(missing.findings.some((f) => f.code === SNAPSHOT_RETENTION_CODES.POLICY_INCOMPLETE),
    '整个字段缺席必须报出来——那是配置事故')

  // 显式 null → **不报**（故意的）
  const explicit = planSnapshotRetention({
    rows: [], policy: { maxAgeDays: null, maxBytes: null }, nowMs: NOW,
  })
  assert.equal(explicit.findings.length, 0,
    '显式 null 是"故意不设上限"，不该被报成问题——两者混起来会让一个正确的配置一直报警')

  assert.equal(assertSnapshotRetentionExplicit({}).ok, false)
  assert.equal(assertSnapshotRetentionExplicit({ maxAgeDays: 30, maxBytes: null }).ok, true)
  assert.equal(assertSnapshotRetentionExplicit({ maxAgeDays: 0, maxBytes: 1 }).ok, false, '0 天不是合法上限')
  assert.equal(assertSnapshotRetentionExplicit({ maxAgeDays: -1, maxBytes: 1 }).ok, false)

  // ★★ 只钉 `.ok === false` **不够**——这是本项目第三次踩到同一个形状。
  //
  //    `assertSnapshotRetentionExplicit` 里有**两条**独立的拒绝：
  //    ① `!Object.hasOwn(policy, key)` —— "这个字段整个缺席"
  //    ② `!(Number.isInteger(...) && ... > 0)` —— "这个值不合法"
  //
  //    传 `{}` 时两条**都**会拒（`undefined` 既不是 own property，也不是正整数），
  //    于是撤掉①之后 `.ok` 仍然是 `false`，用例照样绿——
  //    而调用方拿到的理由从"你**忘了**写这个字段"变成了"这个值不合法，收到 undefined"。
  //
  //      > 一句"你忘了写 maxAgeDays"，与一句"maxAgeDays 只能是正整数或 null，
  //      > 收到 undefined"，在只看 ok 布尔的人眼里是同一个东西——
  //      > 只不过前者告诉调用方去**补一个字段**，
  //      > 后者会让它去**改一个它根本没写的值**。
  //
  //    所以理由必须单独钉住：两条防线给的说明必须**不同**，且各自提到自己的事。
  const missingField = assertSnapshotRetentionExplicit({})
  assert.ok(missingField.problems.some((p) => p.includes('缺少')),
    `★ "字段缺席"必须走**缺席**那条理由，实际：${JSON.stringify(missingField.problems)}`)
  const badValue = assertSnapshotRetentionExplicit({ maxAgeDays: 0, maxBytes: 1 })
  assert.ok(badValue.problems.some((p) => p.includes('只能是正整数')),
    `★ "值不合法"必须走**值**那条理由，实际：${JSON.stringify(badValue.problems)}`)
  assert.notDeepEqual(missingField.problems, badValue.problems,
    '★ 两条防线给的理由必须不同——一样的话，"补字段"与"改值"就分不出来了')
})

test('①c 没有 nowMs → **什么都不清**（不猜"现在"）', () => {
  const plan = planSnapshotRetention({
    rows: [{ attemptId: 'a', runId: 'r', frozenAtMs: 0, finalText: 'x', payloadJson: 'y' }],
    policy: { maxAgeDays: 1, maxBytes: 1 },
  })
  assert.equal(plan.purge.length, 0, '没有"现在"就无法判断"多久以前"，猜错方向的后果是删掉不该删的')
  assert.ok(plan.findings.some((f) => f.code === SNAPSHOT_RETENTION_CODES.NO_CLOCK))
})

// ── ② ★ 字节不是字符 ─────────────────────────────────────────────────────

test('★★★ 用量按 **UTF-8 字节**算，不是字符数（中文一比三）', () => {
  const zh = '中文汉字'
  assert.equal(zh.length, 4, '前置：这个字符串 4 个 UTF-16 码元')
  assert.equal(utf8Bytes(zh), 12, '★ 4 个汉字是 12 字节')
  assert.notEqual(utf8Bytes(zh), zh.length,
    '如果这两个数相等，说明用的是 .length')

  // 一条中文正文 + payload，字节数必须严格大于字符数
  const bytes = snapshotRowBytes({ finalText: zh, payloadJson: zh })
  assert.equal(bytes, 24)

  // ★ 后果：拿字符数去比字节上限，上限会宽三倍。
  //   构造一个"按字符算没超、按字节算超了"的场景。
  const row = { attemptId: 'zh', runId: 'r', frozenAtMs: NOW - 10 * DAY, finalText: zh, payloadJson: zh }
  const capByChars = 20   // 字符口径下 8 < 20，不会清
  const plan = planSnapshotRetention({
    rows: [row], policy: { maxAgeDays: null, maxBytes: capByChars }, nowMs: NOW,
  })
  assert.equal(plan.purge.length, 1,
    '★ 按字节算（24 > 20）必须清。一个"拿字符数当字节数"的实现会在这里漏掉——'
    + '而它在纯英文数据上恰好是对的')
  assert.equal(plan.usage.bytes, 24)
})

test('★★ 字节核算同时算正文与 payload（只算正文会低估）', () => {
  const a = snapshotRowBytes({ finalText: 'abcd', payloadJson: '' })
  const b = snapshotRowBytes({ finalText: 'abcd', payloadJson: 'x'.repeat(100) })
  assert.equal(a, 4)
  assert.equal(b, 104)
  assert.ok(b > a, 'payload 里有全部来源、分段与账本，来源多时它比正文大得多')
})

// ── ③ ★ 排序方向：最旧的先清 ─────────────────────────────────────────────

test('★★★ 容量不足时**从最旧的开始清**（不能反过来）', () => {
  const mk = (id, ageDays, size) => ({
    attemptId: id, runId: `r-${id}`, frozenAtMs: NOW - ageDays * DAY,
    finalText: 'x'.repeat(size), payloadJson: '',
  })
  // 三份，各 100 字节，上限 150 → 只能留下 1 份
  const plan = planSnapshotRetention({
    rows: [mk('newest', 1, 100), mk('oldest', 30, 100), mk('middle', 10, 100)],
    policy: { maxAgeDays: null, maxBytes: 150 },
    nowMs: NOW,
  })
  assert.equal(plan.purge.length, 2)
  assert.deepEqual(plan.purge.map((p) => p.attemptId), ['oldest', 'middle'],
    '★ 必须从最旧的清起。方向写反了不会报错，只会把**最有用的**证据删掉，而报表看起来正常')
  assert.deepEqual(plan.keep.map((k) => k.attemptId), ['newest'])
})

test('★ 计划是**确定的**：同刻的两份按 attemptId 定序', () => {
  const rows = [
    { attemptId: 'b', runId: 'r', frozenAtMs: NOW - 40 * DAY, finalText: 'x', payloadJson: '' },
    { attemptId: 'a', runId: 'r', frozenAtMs: NOW - 40 * DAY, finalText: 'x', payloadJson: '' },
  ]
  const p1 = planSnapshotRetention({ rows, policy: { maxAgeDays: 30, maxBytes: null }, nowMs: NOW })
  const p2 = planSnapshotRetention({ rows: [...rows].reverse(), policy: { maxAgeDays: 30, maxBytes: null }, nowMs: NOW })
  assert.deepEqual(p1.purge.map((x) => x.attemptId), p2.purge.map((x) => x.attemptId),
    '同一批输入在任何顺序下都必须算出同一个清理集——否则"这次会清哪些"不可复核')
})

// ── ④ ★ 被进行中 Run 引用的不清（两轮都要判） ─────────────────────────────

test('★★★ 被进行中 Run 引用的快照：**时间轮与容量轮都不清**', () => {
  const rows = [
    { attemptId: 'live-old', runId: 'run-active', frozenAtMs: NOW - 100 * DAY, finalText: 'x'.repeat(100), payloadJson: '' },
    { attemptId: 'dead-old', runId: 'run-done', frozenAtMs: NOW - 100 * DAY, finalText: 'x'.repeat(100), payloadJson: '' },
  ]
  // 时间轮：两者都过期，但 live 的被引用
  const byAge = planSnapshotRetention({
    rows, policy: { maxAgeDays: 30, maxBytes: null }, nowMs: NOW, activeRunIds: ['run-active'],
  })
  assert.deepEqual(byAge.purge.map((p) => p.attemptId), ['dead-old'])
  assert.ok(byAge.findings.some((f) => f.code === SNAPSHOT_RETENTION_CODES.PINNED
    && f.attemptId === 'live-old'),
  '被引用的必须留下一条**说明为什么没清**的 finding，而不是默默留着')

  // ★ 容量轮同样要判。
  //   `planRetention` 的第一版只在容量轮做了引用判断，漏了时间轮——
  //   于是"超过 30 天的产物"照样被删掉，哪怕它正被一个进行中的 Run 用着。
  //   这里两个方向都钉住，因为一个判断写两遍就会有一天只改一处。
  const byCap = planSnapshotRetention({
    rows: [
      { attemptId: 'live', runId: 'run-active', frozenAtMs: NOW - 1 * DAY, finalText: 'x'.repeat(300), payloadJson: '' },
      { attemptId: 'dead', runId: 'run-done', frozenAtMs: NOW - 2 * DAY, finalText: 'x'.repeat(300), payloadJson: '' },
    ],
    policy: { maxAgeDays: null, maxBytes: 400 }, nowMs: NOW, activeRunIds: ['run-active'],
  })
  assert.equal(byCap.purge.some((p) => p.attemptId === 'live'), false,
    '★ 容量轮也必须尊重"被引用的不删"')
  assert.equal(byCap.purge.some((p) => p.attemptId === 'dead'), true)
})

test('★★ 清完仍超上限 → 如实报 CAP_UNREACHABLE，而不是继续删', () => {
  const plan = planSnapshotRetention({
    rows: [
      { attemptId: 'live', runId: 'run-active', frozenAtMs: NOW - 5 * DAY, finalText: 'x'.repeat(500), payloadJson: '' },
    ],
    policy: { maxAgeDays: null, maxBytes: 100 }, nowMs: NOW, activeRunIds: ['run-active'],
  })
  assert.equal(plan.purge.length, 0, '唯一一份被引用了，一份都不能清')
  assert.ok(plan.findings.some((f) => f.code === SNAPSHOT_RETENTION_CODES.CAP_UNREACHABLE),
    '一个"上限达到了"的报表与一个"上限其实没达到"的报表，在只看有没有 finding 的人眼里是同一个东西')
})

test('★ 形状不对的行**不清**（宁可留着算不出大小的一份）', () => {
  const plan = planSnapshotRetention({
    rows: [
      { attemptId: 'ok', runId: 'r', frozenAtMs: NOW - 100 * DAY, finalText: 'x', payloadJson: '' },
      { runId: 'r', frozenAtMs: NOW - 100 * DAY },            // 缺 attemptId
      { attemptId: 'no-time', runId: 'r' },                    // 缺 frozenAtMs
    ],
    policy: { maxAgeDays: 30, maxBytes: null }, nowMs: NOW,
  })
  assert.equal(plan.purge.length, 1 + 0, '只有形状完整的那一份会被判')
  assert.equal(plan.purge[0].attemptId, 'ok')
  assert.equal(plan.findings.filter((f) => f.code === SNAPSHOT_RETENTION_CODES.ROW_MALFORMED).length, 2)
})

// ── ⑤ ★★ 墓碑：清掉 ≠ 从来没有过 ─────────────────────────────────────────

test('★★★ 清理后：`locate` 说 purged、`get` 说没有、墓碑里有哈希与理由', async () => {
  const attemptId = await freeze('att:tomb-1:1')
  const before = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}?verify=1`)
  assert.equal(before.status, 200)
  const hash = before.body.snapshotHash

  // 预演：什么都不做
  const dry = await post('/api/context-snapshots/purge', {
    dryRun: true, actor: 'ops', reason: '测试清理',
    policy: { maxAgeDays: null, maxBytes: 0 },
  })
  assert.equal(dry.status, 200)
  assert.equal(dry.body.dryRun, true)
  assert.ok(dry.body.wouldPurge >= 1)
  const stillThere = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}`)
  assert.equal(stillThere.status, 200, '★ 预演不许真的删——预演不是一次"差点发生的事故"')

  // 真清
  const real = await post('/api/context-snapshots/purge', {
    dryRun: false, actor: 'ops', reason: '测试清理',
    policy: { maxAgeDays: null, maxBytes: 0 }, activeRunIds: [],
  })
  assert.equal(real.status, 200, JSON.stringify(real.body).slice(0, 260))
  assert.ok(real.body.purged >= 1)
  assert.ok(real.body.freedBytes > 0)

  // ★ 读面必须给 **410**，不是 404
  const after = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}`)
  assert.equal(after.status, 410,
    '★ "存在过但被清掉了"必须与"从来没有过"分开。'
    + '一个借用 404 的实现会让一次静默的数据丢失伪装成"你查错了 id"')
  assert.equal(after.body.code, 'CONTEXT_SNAPSHOT_PURGED')
  assert.ok(after.body.tombstone, '墓碑必须一并返回——审计要说得出"丢了什么、谁清的、为什么"')
  assert.equal(after.body.tombstone.snapshotHash, hash, '墓碑必须留住内容哈希')
  assert.equal(after.body.tombstone.actor, 'ops')
  assert.equal(after.body.tombstone.reason, '测试清理')
  assert.ok(Number.isInteger(after.body.tombstone.purgedAtMs))
  assert.ok(after.body.tombstone.bytes > 0, '墓碑要记下丢掉了多少字节')
  assert.equal(after.body.tombstone.attemptId, attemptId)

  // 墓碑里**没有正文**
  const blob = JSON.stringify(after.body)
  assert.doesNotMatch(blob, /一段正文|最终文本|finalText/,
    '墓碑里不许有正文——那正是清掉它的理由')

  // 而"从来没有过"仍然是 404
  const absent = await get('/api/context-snapshots/att%3Anever%3A1')
  assert.equal(absent.status, 404, '没存在过的仍然是 404')
  assert.equal(absent.body.code, 'CONTEXT_NOT_FOUND')
  assert.equal(absent.body.tombstone, undefined)
})

test('★★★ 清掉之后正文**真的**不在库里了（不是只写了个墓碑）', async () => {
  const attemptId = await freeze('att:tomb-2:1', { content: '这段文字清完之后必须彻底消失' })
  await post('/api/context-snapshots/purge', {
    dryRun: false, actor: 'ops', reason: '验证真的删了',
    policy: { maxAgeDays: null, maxBytes: 0 }, activeRunIds: [],
  })
  const row = mod.db.prepare('SELECT attempt_id FROM run_context_snapshots WHERE attempt_id = ?').get(attemptId)
  assert.equal(row, undefined, '★ 现存表里必须没有这一行')
  const payloadLeak = mod.db.prepare(
    "SELECT COUNT(*) AS n FROM run_context_snapshots WHERE payload_json LIKE '%这段文字清完之后必须彻底消失%'",
  ).get().n
  assert.equal(payloadLeak, 0, 'payload 里的正文也必须没了')
  const tombLeak = mod.db.prepare(
    "SELECT COUNT(*) AS n FROM run_context_snapshot_tombstones WHERE attempt_id = ?",
  ).get(attemptId).n
  assert.equal(tombLeak, 1, '而墓碑必须在')
})

test('★★ 清两次是幂等的，且第二次如实说"早就清了"', async () => {
  const attemptId = await freeze('att:tomb-3:1')
  const p1 = await post('/api/context-snapshots/purge', {
    dryRun: false, actor: 'ops', reason: '第一次',
    policy: { maxAgeDays: null, maxBytes: 0 }, activeRunIds: [],
  })
  assert.equal(p1.status, 200)
  // 第二次：已经没有可清的现存行 → 0
  const p2 = await post('/api/context-snapshots/purge', {
    dryRun: false, actor: 'ops', reason: '第二次',
    policy: { maxAgeDays: null, maxBytes: 0 }, activeRunIds: [],
  })
  assert.equal(p2.status, 200)
  assert.equal(p2.body.purged, 0, '第二次没有可清的了')

  // 而墓碑**不会**被第二次改写：理由仍是最开始那一次
  const t = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}`)
  assert.equal(t.status, 410)
  assert.equal(t.body.tombstone.reason, '第一次',
    '★ 已清的墓碑不许被后来的清理覆盖——那会让"为什么清的"变成最近一次的说法')
})

test('★★ 墓碑清单：`everRecorded = live + purged`，丢过什么看得见', async () => {
  const r = await get('/api/context-snapshots/tombstones?limit=500')
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.body.tombstones))
  assert.ok(r.body.tombstones.length >= 3, `至少该有前面几条墓碑，实际 ${r.body.tombstones.length}`)
  const c = r.body.counts
  assert.equal(c.everRecorded, c.live + c.purged,
    '★ 清理之后"总数"不该看起来凭空变小——那正是"悄悄丢了证据"的样子')
  assert.ok(c.purged >= 3)
  // 每条墓碑都能回答"谁清的、为什么"
  for (const t of r.body.tombstones) {
    assert.ok(typeof t.actor === 'string' && t.actor !== '')
    assert.ok(typeof t.reason === 'string' && t.reason !== '')
    assert.ok(Number.isInteger(t.purgedAtMs))
    assert.ok(typeof t.snapshotHash === 'string' && t.snapshotHash.startsWith('sha256:'))
  }
})

// ── ⑥ 校验：不给默认值 ───────────────────────────────────────────────────

test('★★ `dryRun` 必须**显式**给——不给默认值', async () => {
  const r = await post('/api/context-snapshots/purge', {
    actor: 'ops', reason: 'r', policy: { maxAgeDays: null, maxBytes: 0 },
  })
  assert.equal(r.status, 400, `缺 dryRun 必须 400，实际 ${r.status}：${JSON.stringify(r.body).slice(0, 200)}`)
  assert.equal(r.body.code, 'RETENTION_DRYRUN_REQUIRED')
  // ★ 必须是 400 而**不是** 200。`handleRun` 会把回调的返回值展开成 200，
  //   所以校验失败必须抛——否则"缺 actor"会变成一次成功的响应，
  //   而调用方以为清理发生了。
  assert.notEqual(r.status, 200)

  const noActor = await post('/api/context-snapshots/purge', {
    dryRun: true, reason: 'r', policy: { maxAgeDays: null, maxBytes: 0 },
  })
  assert.equal(noActor.status, 400)
  assert.equal(noActor.body.code, 'RETENTION_ACTOR_REQUIRED')

  const noReason = await post('/api/context-snapshots/purge', {
    dryRun: true, actor: 'ops', policy: { maxAgeDays: null, maxBytes: 0 },
  })
  assert.equal(noReason.status, 400)
  assert.equal(noReason.body.code, 'RETENTION_REASON_REQUIRED')

  const noPolicy = await post('/api/context-snapshots/purge', {
    dryRun: true, actor: 'ops', reason: 'r',
  })
  assert.equal(noPolicy.status, 400)
  assert.equal(noPolicy.body.code, 'RETENTION_POLICY_REQUIRED')

  // 三个码必须**互不相同**：同一个码会让调用方不知道该补哪一个
  const codes = new Set([noActor.body.code, noReason.body.code, noPolicy.body.code])
  assert.equal(codes.size, 3)
})

test('★★ 缺 actor / reason 的清理**一份都不许清**（不是"清了但没留痕"）', async () => {
  const attemptId = await freeze('att:tomb-6:1')
  const before = mod.db.prepare('SELECT COUNT(*) AS n FROM run_context_snapshots').get().n
  await post('/api/context-snapshots/purge', {
    dryRun: false, reason: 'r', policy: { maxAgeDays: null, maxBytes: 0 },
  })
  const now = mod.db.prepare('SELECT COUNT(*) AS n FROM run_context_snapshots').get().n
  assert.equal(now, before, '★ 校验失败的清理不能删任何东西——'
    + '"删了但没留痕"正是这个模块要防的那件事')
  const live = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}`)
  assert.equal(live.status, 200, '那份快照必须还在')
})

test('★ 保留计划预览：策略必须**显式**给两个字段', async () => {
  const missing = await get('/api/context-snapshots/retention?maxAgeDays=30')
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'RETENTION_POLICY_REQUIRED')

  const bad = await get('/api/context-snapshots/retention?maxAgeDays=0&maxBytes=null')
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'RETENTION_POLICY_INVALID')

  const ok = await get('/api/context-snapshots/retention?maxAgeDays=null&maxBytes=null')
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 200))
  assert.equal(ok.body.purge.length, 0, '默认（都不设上限）下一份都不清')
  assert.ok(ok.body.keepCount > 0)
  // 预览**只回计划，不回正文**
  assert.doesNotMatch(JSON.stringify(ok.body), /一段正文|finalText/,
    '预览一份计划不需要看到证据内容')
})

test('★★ 预览与实际执行对**同一批行**给同一个清理集', async () => {
  await freeze('att:tomb-8a:1', { frozenAtMs: NOW - 100 * DAY })
  await freeze('att:tomb-8b:1', { frozenAtMs: NOW - 100 * DAY })
  const policy = { maxAgeDays: null, maxBytes: null }
  const preview = await get('/api/context-snapshots/retention?maxAgeDays=null&maxBytes=null')
  assert.equal(preview.status, 200)
  const dry = await post('/api/context-snapshots/purge', {
    dryRun: true, actor: 'ops', reason: 'r', policy, activeRunIds: [],
  })
  // 两次调用的"现存行"可能因为中间的用例不同而不同，所以只比"同一时刻内两次算法一致"
  assert.equal(dry.status, 200)
  assert.equal(dry.body.wouldPurge, 0, '不设上限时预演也必须算出 0')
  assert.equal(preview.body.purge.length, 0)
})

// ── ⑦ store 层的直接断言（不经路由） ─────────────────────────────────────
//
// 上面全部走 HTTP。这一节直接在库上建一个 store——
// 因为"被清的墓碑不许被后来的清理覆盖"与"清理是一个事务"这两条
// 在**路由的返回值里看不出来**：路由只会说 `alreadyPurged: true`，
// 而它可能是"查到了墓碑"也可能是"又清了一次恰好也成功"。
// 判据必须落在库的状态上。

/** 在 server 的同一个库上建一个 store（不走路由，直接看库）。 */
function storeOnSharedDb() {
  return createContextStore({ db: mod.db, clock: () => NOW })
}

test('★★★ store.locate 三态：live / purged / absent', async () => {
  const store = storeOnSharedDb()
  const liveId = await freeze('att:loc-1:1')
  assert.equal(store.locate(liveId).kind, 'live')

  const goneId = await freeze('att:loc-2:1')
  store.purge(goneId, { reason: '三态用例', actor: 'tester', nowMs: NOW })
  const spot = store.locate(goneId)
  assert.equal(spot.kind, 'purged', '★ 清过之后必须能说"它存在过"')
  assert.equal(spot.tombstone.attemptId, goneId)
  assert.equal(store.get(goneId), null, '而 get() 仍然说没有——正是这个 null 太少了')

  assert.equal(store.locate('att:never-existed').kind, 'absent')
  assert.equal(store.tombstone('att:never-existed'), null)

  // ★ 三种状态互不相同。一个只有"有/没有"两态的读面，
  //   会把一次静默的数据丢失伪装成"你查错了 id"。
  const kinds = new Set([store.locate(liveId).kind, store.locate(goneId).kind, store.locate('x').kind])
  assert.equal(kinds.size, 3)
})

test('★★★ store.purge 缺 reason / actor / nowMs 一律**拒绝且不动库**', async () => {
  const store = storeOnSharedDb()
  const id = await freeze('att:purge-guard:1')
  const liveBefore = mod.db.prepare('SELECT COUNT(*) AS n FROM run_context_snapshots').get().n
  const tombBefore = mod.db.prepare('SELECT COUNT(*) AS n FROM run_context_snapshot_tombstones').get().n

  for (const [label, args] of [
    ['缺 reason', { actor: 'a', nowMs: NOW }],
    ['空 reason', { reason: '   ', actor: 'a', nowMs: NOW }],
    ['缺 actor', { reason: 'r', nowMs: NOW }],
    ['空 actor', { reason: 'r', actor: '  ', nowMs: NOW }],
    ['缺 nowMs', { reason: 'r', actor: 'a' }],
    ['非整数 nowMs', { reason: 'r', actor: 'a', nowMs: 1.5 }],
  ]) {
    assert.throws(() => store.purge(id, args),
      (e) => e.code === CONTEXT_STORE_ERRORS.PURGE_BAD_REQUEST,
      `${label} 必须抛 PURGE_BAD_REQUEST`)
  }

  // ★ 校验失败**一份都没动**。一个"先删了再校验"的实现会把
  //   "拒绝了这次请求"与"证据已经没了"变成同一个结果。
  assert.equal(mod.db.prepare('SELECT COUNT(*) AS n FROM run_context_snapshots').get().n, liveBefore)
  assert.equal(mod.db.prepare('SELECT COUNT(*) AS n FROM run_context_snapshot_tombstones').get().n, tombBefore)
  assert.equal(store.locate(id).kind, 'live', '那份快照必须原封不动')
})

test('★★★ 已清的墓碑**不许**被后来的清理覆盖（理由/时间/操作人都不能变）', async () => {
  const store = storeOnSharedDb()
  const id = await freeze('att:tomb-immutable:1')
  const first = store.purge(id, { reason: '第一次的理由', actor: 'alice', nowMs: NOW })
  assert.equal(first.purged, true)
  assert.equal(first.alreadyPurged, false)

  const later = store.purge(id, { reason: '第二次的理由', actor: 'bob', nowMs: NOW + 999999 })
  assert.equal(later.purged, false, '已经清过了，不该再清一次')
  assert.equal(later.alreadyPurged, true)
  // ★ 墓碑一字未改：
  //   一条"被后来某次清理顺手改写了理由"的墓碑，与一条"从没记过理由"的墓碑，
  //   对审计是同一个东西——只不过前者看起来是有记录的。
  assert.equal(later.tombstone.reason, '第一次的理由')
  assert.equal(later.tombstone.actor, 'alice')
  assert.equal(later.tombstone.purgedAtMs, NOW)
  assert.equal(store.tombstone(id).reason, '第一次的理由')
})

test('★★★ 墓碑记的 `bytes` 与 `snapshotHash` 是从**将被删的那一行**读出来的', async () => {
  const store = storeOnSharedDb()
  const content = '墓碑的字节数必须来自真实那一行'
  const id = await freeze('att:tomb-bytes:1', { content })
  // 直接从库里读真实大小
  const row = mod.db.prepare('SELECT final_text, payload_json, snapshot_hash FROM run_context_snapshots WHERE attempt_id = ?').get(id)
  const expected = snapshotRowBytes({ finalText: row.final_text, payloadJson: row.payload_json })

  // ★ 调用方**谎报**一个字节数，墓碑必须无视它。
  //   调用方给的值描述的是它**以为**自己删了什么，
  //   而墓碑要回答的是"我们实际丢掉了什么"。
  const r = store.purge(id, { reason: 'r', actor: 'a', nowMs: NOW, bytes: 1, snapshotHash: 'sha256:lie' })
  assert.equal(r.tombstone.bytes, expected, '★ 墓碑的字节数必须来自真实那一行，不是调用方说的')
  assert.equal(r.tombstone.snapshotHash, row.snapshot_hash, '哈希同理')
  assert.notEqual(r.tombstone.bytes, 1)
  assert.notEqual(r.tombstone.snapshotHash, 'sha256:lie')
})

test('★★★ 清理是一个**事务**：正文与墓碑要么都在要么都不在', async () => {
  const store = storeOnSharedDb()
  const id = await freeze('att:tomb-tx:1')
  store.purge(id, { reason: 'r', actor: 'a', nowMs: NOW })
  // 结果态：正文没了、墓碑在
  assert.equal(mod.db.prepare('SELECT attempt_id FROM run_context_snapshots WHERE attempt_id = ?').get(id), undefined)
  assert.notEqual(mod.db.prepare('SELECT attempt_id FROM run_context_snapshot_tombstones WHERE attempt_id = ?').get(id), undefined)

  // ★ "正文没了而墓碑没写"这个中间态是灾难性的：这份证据变成"从来没有过"。
  //   这里钉住的是**不存在**的状态，所以判据是"两件事同时成立"。
  const both = mod.db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM run_context_snapshots WHERE attempt_id = ?) AS live,
       (SELECT COUNT(*) FROM run_context_snapshot_tombstones WHERE attempt_id = ?) AS tomb`,
  ).get(id, id)
  assert.equal(both.live, 0)
  assert.equal(both.tomb, 1)
  assert.notEqual(both.live, both.tomb, '一个"只剩正文"或"只剩墓碑"的库是坏掉的库')
})

test('★★ store.retentionRows 给的是**现存**行，且带正文与 payload', async () => {
  const store = storeOnSharedDb()
  const id = await freeze('att:rows-1:1', { content: '台账要能拿到正文' })
  const rows = store.retentionRows()
  const mine = rows.find((r) => r.attemptId === id)
  assert.ok(mine, '现存行必须在台账里')
  assert.equal(typeof mine.finalText, 'string')
  assert.equal(typeof mine.payloadJson, 'string')
  assert.ok(Number.isInteger(mine.frozenAtMs))
  assert.equal(mine.runId, id)
  // 墓碑**不参与**保留核算：它们已经没有正文了，再"清"一次没有意义
  store.purge(id, { reason: 'r', actor: 'a', nowMs: NOW })
  const after = store.retentionRows()
  assert.equal(after.some((r) => r.attemptId === id), false, '被清掉的不该还在保留台账里')
})

test('★★★ counts 区分 live / purged / everRecorded（清理不让总数凭空变小）', async () => {
  const store = storeOnSharedDb()
  const before = store.counts()
  const id = await freeze('att:counts-1:1')
  const mid = store.counts()
  assert.equal(mid.live, before.live + 1)
  assert.equal(mid.everRecorded, before.everRecorded + 1)

  store.purge(id, { reason: 'r', actor: 'a', nowMs: NOW })
  const after = store.counts()
  assert.equal(after.live, mid.live - 1)
  assert.equal(after.purged, mid.purged + 1)
  assert.equal(after.everRecorded, mid.everRecorded,
    '★ `everRecorded` 不该因为一次清理而变小——'
    + '一个"清理之后总数下降了"的报表与一个"证据悄悄丢了"的报表是同一个东西')
})

test('★★★ 读面：purged 的 verify 也必须是 410（不是 404）', async () => {
  const attemptId = await freeze('att:tomb-10:1')
  await post('/api/context-snapshots/purge', {
    dryRun: false, actor: 'ops', reason: 'r',
    policy: { maxAgeDays: null, maxBytes: 0 }, activeRunIds: [],
  })
  const v = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}?verify=1`)
  assert.equal(v.status, 410,
    '★ 带 ?verify=1 的读也必须是 410——两条读路给不同的状态码会让'
    + '调用方以为"只有某一种查法查不到"')
  assert.equal(v.body.code, 'CONTEXT_SNAPSHOT_PURGED')
})

test('★ 导出：被清掉的快照不许被导出一份"空的但格式正确"的文档', async () => {
  const attemptId = await freeze('att:tomb-11:1')
  await post('/api/context-snapshots/purge', {
    dryRun: false, actor: 'ops', reason: 'r',
    policy: { maxAgeDays: null, maxBytes: 0 }, activeRunIds: [],
  })
  const e = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}/export?by=a&atMs=1700000001000`)
  assert.equal(e.status, 404, `被清掉的快照导不出来必须是 404，实际 ${e.status}`)
  assert.equal(e.body.export, undefined)
})

// ── ⑧ 台账自检 ───────────────────────────────────────────────────────────

test('★ 快照**不在** log/event/artifact 三类里（它有自己的策略）', () => {
  assert.equal(SNAPSHOT_CLASS_ID, 'context-snapshot')
  assert.equal(SNAPSHOT_RETENTION_CHECKED.classId, SNAPSHOT_CLASS_ID)
  // 一个"给快照挂上 event 类、于是 30 天上限顺手生效"的实现，
  // 与一个"30 天之后再也回答不了那次运行看到了什么"的实现，是同一个东西。
  assert.equal(['log', 'event', 'artifact'].includes(SNAPSHOT_CLASS_ID), false,
    '★ 快照不能被归进日志那三类——那会让一次为日志调的参数悄悄改变证据的去留')
})

test('★ 错误码是具名的，且 purge 的三种缺参互不相同', () => {
  assert.equal(CONTEXT_STORE_ERRORS.PURGED, 'CONTEXT_SNAPSHOT_PURGED')
  assert.equal(CONTEXT_STORE_ERRORS.PURGE_BAD_REQUEST, 'CONTEXT_PURGE_BAD_REQUEST')
  assert.notEqual(CONTEXT_STORE_ERRORS.PURGED, CONTEXT_STORE_ERRORS.NOT_FOUND,
    '★ "被清掉了"与"没找到"必须是两个码——合成一个就丢掉了整个墓碑设计的理由')
})
