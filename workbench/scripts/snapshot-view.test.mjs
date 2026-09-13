// workbench/scripts/snapshot-view.test.mjs
// ============================================================================
// PRT-409 最后一件：上下文快照**查看**界面的纯判定层
// （spec line 897：「持久化快照并支持查看和导出」）
//
// ## 为什么这套件起一个**真的 hub**
//
// 本模块的全部工作就是：拿 hub 给的响应，决定屏幕上显示什么。
// 而"hub 到底给什么"——状态码、字段名、410 的形状、墓碑的字段——
// 只能由真 hub 回答。
//
//   > 一个用假 hub 喂出来的「界面已验证」，
//   > 与一个从没发过那次请求的「界面已验证」，是同一个东西，
//   > 只不过前者的用例数是完整的。
//
// 所以下面每一条"判定"都先用真请求拿到真响应，再喂给纯函数。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  snapshotPath, snapshotListPath, tombstonesPath, exportPath,
  readSnapshotResponse, verifyVerdict, verifyText, shortHash,
  ledgerView, ledgerText, ledgersOf, exclusionLabel, unknownReasons, EXCLUSION_REASON_LABEL,
  segmentViews, textPreview, tombstoneText, countsText, retentionView,
  relativeTime, bytesText, listRows, screenFor,
} from '../src/snapshotView.ts'

const REPO = resolve(import.meta.dirname, '..', '..')
const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-snapview-'))
let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  mod = await import(pathToFileURL(join(REPO, 'team-hub', 'server.mjs')).href)
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

/** 按模块给出的路径去请求真 hub，并把 HTTP 结果交给纯函数归一。 */
async function fetchSnapshot(attemptId, opts) {
  const res = await fetch(base + snapshotPath(attemptId, opts))
  const body = await res.json().catch(() => null)
  return { status: res.status, body, view: readSnapshotResponse(res.status, body) }
}

async function freeze(attemptId, { content = '一段正文', frozenAtMs = 1_700_000_000_000, candidates } = {}) {
  const res = await fetch(base + '/api/context-snapshots/assemble', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      attemptId, runId: attemptId, frozenAtMs, scope: 'default', canReadAll: true,
      candidates: candidates ?? [{
        source: {
          id: 'doc:1', type: 'document', version: 'v1', acquiredAtMs: frozenAtMs - 1000,
          content, trust: 'untrusted',
        },
      }],
    }),
  })
  assert.equal(res.status, 200, `装配失败：${(await res.text()).slice(0, 200)}`)
  return attemptId
}

// ── ① 三态：live / purged / missing ──────────────────────────────────────

test('★★★ 410 不是"没找到"：被清掉的快照归一成 purged，带墓碑', async () => {
  const id = await freeze('vw:purged:1')
  const live = await fetchSnapshot(id)
  assert.equal(live.status, 200)
  assert.equal(live.view.kind, 'live', '清之前当然是 live')

  const p = await fetch(base + '/api/context-snapshots/purge', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dryRun: false, actor: 'ops-view', reason: '界面用例清理',
      policy: { maxAgeDays: null, maxBytes: 0 }, activeRunIds: [],
    }),
  })
  assert.equal(p.status, 200)

  const gone = await fetchSnapshot(id)
  assert.equal(gone.status, 410, `★ hub 必须给 410，实际 ${gone.status}`)
  assert.equal(gone.view.kind, 'purged',
    '★ 一份"被策略清掉"的快照与一份"从来没有过"的快照，在屏幕上必须是两个东西——'
    + '只不过前者需要有人去追问"是谁清的、为什么"，后者只需要重新输入一次')

  // 真 hub 的墓碑字段必须够渲染出一句完整的话
  const t = gone.view.tombstone
  assert.equal(t.attemptId, id)
  assert.equal(t.actor, 'ops-view')
  assert.equal(t.reason, '界面用例清理')
  assert.ok(Number.isInteger(t.purgedAtMs))
  assert.ok(t.bytes > 0)
  assert.match(t.snapshotHash, /^sha256:/)

  const text = tombstoneText(t)
  assert.match(text, /ops-view/)
  assert.match(text, /界面用例清理/)
  assert.match(text, /存在过/)
  assert.match(text, /无法还原/, '★ 必须说出"这次的输入已经无法还原"——那是清掉的真正后果')
  assert.doesNotMatch(text, /一段正文/, '墓碑里不该带正文')
})

test('★★★ 从来没存在过 → missing；与 purged **必须是不同的**归一结果', async () => {
  const r = await fetchSnapshot('vw:never-existed')
  assert.equal(r.status, 404)
  assert.equal(r.view.kind, 'missing')
  assert.notEqual(r.view.kind, 'purged',
    '★ 两者混淆的唯一后果是：一次静默的数据丢失被读成一次输错')
  assert.equal(screenFor({ fetch: r.view }), 'missing')

  // 两种状态在 screenFor 上也必须分开
  const purgedish = readSnapshotResponse(410, { code: 'CONTEXT_SNAPSHOT_PURGED', error: 'x' })
  assert.equal(screenFor({ fetch: purgedish }), 'purged')
  assert.notEqual(screenFor({ fetch: purgedish }), screenFor({ fetch: r.view }))
})

test('★★ 410 但后端没给墓碑 → **仍然不降级成 missing**', () => {
  const v = readSnapshotResponse(410, { ok: false, code: 'CONTEXT_SNAPSHOT_PURGED' })
  assert.equal(v.kind, 'purged',
    '★ 墓碑缺失是后端的问题，而"存在过"这个事实由**状态码**确认了。'
    + '降级成 missing 会把一次数据丢失说成一次输错')
  assert.match(tombstoneText(v.tombstone), /后端未给出墓碑/)
})

test('★ 状态码是协议层事实：body 里写成 CONTEXT_NOT_FOUND 也**不改** 410 的判定', () => {
  const v = readSnapshotResponse(410, { code: 'CONTEXT_NOT_FOUND', error: 'x' })
  assert.equal(v.kind, 'purged',
    '一个被中间层改写过的 `code` 不该让界面把 410 当成"没有"')
  const v2 = readSnapshotResponse(404, { code: 'CONTEXT_SNAPSHOT_PURGED', error: 'x' })
  assert.equal(v2.kind, 'missing', '反过来也一样：404 就是没有')
})

// ── ② 验证三态 ───────────────────────────────────────────────────────────

test('★★★ 真 hub 的 verification 让界面判成 ok，且两个哈希真的相同', async () => {
  const id = await freeze('vw:verify:1')
  const r = await fetchSnapshot(id)
  assert.equal(r.view.kind, 'live')
  const d = r.view.detail
  assert.ok(d.verification, 'hub 必须给 verification —— ?verify=1 永远带上')
  assert.equal(verifyVerdict(d), 'ok')
  assert.equal(d.verification.storedHash, d.verification.recomputedHash,
    '★ ok:true 的同时两个哈希必须真的相同')
  assert.match(verifyText('ok'), /通过/)
})

test('★★★ "没验过" 与 "验过了通过" **不是**同一个绿', () => {
  assert.equal(verifyVerdict({}), 'unverified')
  assert.equal(verifyVerdict(null), 'unverified')
  assert.equal(verifyVerdict({ verification: null }), 'unverified')
  assert.equal(verifyVerdict({ verification: { ok: true, storedHash: 'a', recomputedHash: 'a' } }), 'ok')
  assert.notEqual(verifyVerdict({}), verifyVerdict({ verification: { ok: true, storedHash: 'a', recomputedHash: 'a' } }),
    '★ 一个"没验过"的快照与一个"验过了且通过"的快照，在只显示一个绿色对勾的界面上是同一个东西——'
    + '只不过前者会让用户以为有人检查过')
  assert.match(verifyText('unverified'), /未知/)
})

test('★★★ `ok:true` 但两个哈希互相矛盾 → 仍然判 mismatch', () => {
  assert.equal(verifyVerdict({ verification: { ok: true, storedHash: 'sha256:aaa', recomputedHash: 'sha256:bbb' } }),
    'mismatch',
    '★ 一个"结论说通过、而证据字段互相矛盾"的结果，不能按通过处理')
  assert.equal(verifyVerdict({ verification: { ok: false, storedHash: 'a', recomputedHash: 'b' } }), 'mismatch')
  assert.match(verifyText('mismatch'), /不要/)
})

test('★ 短哈希可比对、且看得出 `sha256:` 前缀', () => {
  assert.equal(shortHash('sha256:abcdef0123456789'), 'sha256:abcdef012345…')
  assert.equal(shortHash(''), '—')
  assert.equal(shortHash(null), '—')
  assert.equal(shortHash(undefined), '—')
})

// ── ③ 三本账 ─────────────────────────────────────────────────────────────

test('★★★ 真 hub 的快照：入选 + 排除 == 候选数（守恒断言在界面上也算一遍）', async () => {
  const id = await freeze('vw:ledger:1')
  const r = await fetchSnapshot(id)
  const l = ledgerView(r.view.detail)
  assert.equal(l.contractBroken, false, ledgerText(l))
  assert.equal(l.balanced, true, ledgerText(l))
  assert.equal(l.candidates, l.included + l.excluded)
  assert.equal(l.partial, false)
  assert.match(ledgerText(l), /候选 1/)
})

test('★★★ 不守恒时界面**必须说出来**（三个数字并排看起来是一样的）', () => {
  const bad = ledgerView({
    candidateCount: 5, includedCount: 2, excludedCount: 1,
    snapshot: { excluded: [], truncations: [], redactions: [] },
  })
  assert.equal(bad.balanced, false)
  assert.equal(bad.contractBroken, false)
  const t = ledgerText(bad)
  assert.match(t, /不守恒/)
  assert.match(t, /不能/, '★ 必须说这份快照不能用来证明"来源已完整清点"')

  // ★ 三个数字并排 vs 一句"不守恒"：看的人是**不会**去做这个加法的
  const good = ledgerView({
    candidateCount: 5, includedCount: 2, excludedCount: 3,
    snapshot: { excluded: [], truncations: [], redactions: [] },
  })
  assert.equal(good.balanced, true)
  assert.notEqual(ledgerText(bad), ledgerText(good))
})

test('★★★ ★ 读错层级给出的是**假的 0**：契约破裂必须说出来', () => {
  // ★ 这是实测出来的真缺陷形状：三本账住在 `snapshot.*` 里，
  //   顶层只有计数。第一版模块从顶层读 `excluded`，
  //   于是 `Array.isArray(undefined)` → `[]` → "排除 0"。
  //
  //     一个"从错误的层级读账本、于是永远读到 undefined"的界面，
  //     与一个"这份快照确实没有排除任何来源"的界面，长得一模一样——
  //     只不过前者会在一次越权过滤之后，向用户显示"来源已完整清点"。
  const topLevelOnly = ledgerView({ candidateCount: 1, includedCount: 0, excludedCount: 1 })
  assert.equal(topLevelOnly.contractBroken, true,
    '★ 键根本不在 → 契约破裂，不能说成"没有排除"')
  assert.equal(topLevelOnly.redacted, 0)
  const t = ledgerText(topLevelOnly)
  assert.match(t, /账本读不到/)
  assert.match(t, /读错了地方/, '★ 必须说清这个 0 是读错地方得来的')
  assert.doesNotMatch(t, /^候选/, '不能渲染成一份正常的三本账')

  // 而"键在、值是空数组"才是真的没有排除
  const genuinelyEmpty = ledgerView({
    candidateCount: 1, includedCount: 1, excludedCount: 0,
    snapshot: { excluded: [], truncations: [], redactions: [] },
  })
  assert.equal(genuinelyEmpty.contractBroken, false)
  assert.match(ledgerText(genuinelyEmpty), /^候选/)

  // 两者在**计数完全相同**的情况下给出不同的结论——这正是这条判据的意义
  assert.equal(topLevelOnly.candidates, genuinelyEmpty.candidates)
  assert.notEqual(topLevelOnly.contractBroken, genuinelyEmpty.contractBroken)
  assert.notEqual(ledgerText(topLevelOnly), ledgerText(genuinelyEmpty))
})

test('★ ledgersOf 只认 snapshot.* 一层（不偷偷回落到顶层）', () => {
  const led = ledgersOf({
    excludedCount: 9,
    snapshot: { excluded: [{ id: 'x', reason: 'unauthorized' }], truncations: [], redactions: [] },
  })
  assert.equal(led.excluded.length, 1)
  assert.equal(led.contractBroken, false)
  // null / undefined 一律算契约破裂，不是"没有排除"
  assert.equal(ledgersOf(null).contractBroken, true)
  assert.equal(ledgersOf({}).contractBroken, true)
  assert.equal(ledgersOf({ snapshot: {} }).contractBroken, true)
})

test('★★ 真 hub 的超预算快照：`partial` 判得出来（第三种状态）', async () => {
  const id = await freeze('vw:partial:1', {
    candidates: [{
      source: {
        id: 'big', type: 'document', version: 'v1', acquiredAtMs: 1_699_999_999_000,
        content: 'x'.repeat(4000), trust: 'untrusted',
      },
    }],
  })
  // 用一个很小的预算重新装配，制造"部分包含"
  const res = await fetch(base + '/api/context-snapshots/assemble', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      attemptId: 'vw:partial:small', runId: 'vw:partial:small', frozenAtMs: 1_700_000_000_000,
      scope: 'default', canReadAll: true, maxTokens: 5,
      candidates: [{
        source: {
          id: 'big', type: 'document', version: 'v1', acquiredAtMs: 1_699_999_999_000,
          content: 'x'.repeat(4000), trust: 'untrusted',
        },
      }],
    }),
  })
  assert.equal(res.status, 200, (await res.text()).slice(0, 200))
  const r = await fetchSnapshot('vw:partial:small')
  const l = ledgerView(r.view.detail)
  assert.equal(l.balanced, true, ledgerText(l))
  assert.equal(l.partial, true,
    '★ 一份**截断过的**快照如果只显示正文，用户会以为模型读完了全文——'
    + '这正是 PRT-407 存在的理由，而界面是它唯一被看到的地方')
  void id
})

test('★★★ 真 hub 的排除理由**住在 snapshot 里**，界面全认得出（没有"未知理由"）', async () => {
  // 造一个越权排除
  const res = await fetch(base + '/api/context-snapshots/assemble', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      attemptId: 'vw:excl:1', runId: 'vw:excl:1', frozenAtMs: 1_700_000_000_000,
      scope: 'default', canReadIds: [],
      candidates: [{
        source: {
          id: 'doc:secret', type: 'document', version: 'v1', acquiredAtMs: 1_699_999_999_000,
          content: '不该被读到的内容', trust: 'untrusted', scope: 'default',
        },
      }],
    }),
  })
  assert.equal(res.status, 200, (await res.text()).slice(0, 200))
  const r = await fetchSnapshot('vw:excl:1')
  const d = r.view.detail

  // ★ 先钉住**位置**：顶层没有 excluded，它住在 snapshot 里。
  //   这条断言是这套件里最有价值的一条——它把"读错层级"钉死在用例上。
  assert.equal(d.excluded, undefined,
    '顶层**没有** excluded —— 三本账住在 snapshot.* 里（实测）')
  assert.ok(Array.isArray(d.snapshot.excluded))

  const led = ledgersOf(d)
  assert.equal(led.contractBroken, false, '真 hub 的响应必须满足契约')
  assert.ok(led.excluded.length > 0, '越权来源必须出现在 snapshot.excluded 里')
  const reasons = led.excluded.map((e) => e.reason)
  assert.ok(reasons.includes('unauthorized'), `实际理由：${JSON.stringify(reasons)}`)

  // 界面据此算出的账本必须**守恒**且**说出了排除**——而不是"排除 0"
  const l = ledgerView(d)
  assert.equal(l.balanced, true, ledgerText(l))
  assert.equal(l.excluded, 1, '★ 越权过滤必须在界面上显示为 1 条排除，而不是 0')
  assert.match(ledgerText(l), /排除 1/)

  assert.deepEqual(unknownReasons(led.excluded), [],
    '★ 真 hub 给出的理由界面必须全都认得出')
  assert.match(exclusionLabel('unauthorized'), /无权/)
  // 未知理由 **不能**被吞成通用文案
  assert.equal(exclusionLabel('brand-new-reason'), '未知理由：brand-new-reason')
  assert.deepEqual(unknownReasons([{ id: 'x', reason: 'brand-new-reason' }]), ['brand-new-reason'],
    '★ 新的、可能很重要的排除理由不能在界面上与一句废话等价')
  assert.deepEqual(unknownReasons(null), [])
  assert.deepEqual(unknownReasons([null, 42]), [])
})

// ── ④ 正文与分段 ─────────────────────────────────────────────────────────

test('★★★ 分段有**洞**时必须算出来（洞里的字符不属于任何来源）', () => {
  const r = segmentViews([
    { at: 'doc:a', from: 0, to: 10 },
    { at: 'doc:b', from: 15, to: 25 },
  ])
  assert.equal(r.segments.length, 2)
  assert.equal(r.gaps, 5,
    '★ 前一段的 to 是 10、后一段的 from 是 15，中间 5 个字符**不属于任何来源**，'
    + '而它确实被发给了模型。只把分段列表画出来的界面看不到这个洞')
  assert.equal(r.covered, 20)

  const noGap = segmentViews([{ at: 'a', from: 0, to: 10 }, { at: 'b', from: 10, to: 20 }])
  assert.equal(noGap.gaps, 0)
  // 顺序被打乱也要能算出同样的洞
  const shuffled = segmentViews([{ at: 'b', from: 15, to: 25 }, { at: 'a', from: 0, to: 10 }])
  assert.equal(shuffled.gaps, 5)
  assert.deepEqual(shuffled.segments.map((s) => s.at), ['a', 'b'])
  assert.equal(segmentViews(null).gaps, 0)
  assert.equal(segmentViews([null, {}]).segments.length, 0)
})

test('★ 正文预览截断时**说出来**，不让预览看起来是全文', () => {
  const short = textPreview('hello', 10)
  assert.equal(short.truncated, false)
  assert.equal(short.totalChars, 5)
  const long = textPreview('x'.repeat(100), 10)
  assert.equal(long.truncated, true)
  assert.equal(long.text.length, 10)
  assert.equal(long.totalChars, 100, '★ 总长度必须留着——否则用户不知道被截掉了多少')
  assert.equal(textPreview(null).text, '')
})

// ── ⑤ 墓碑与保留 ─────────────────────────────────────────────────────────

test('★★★ counts 必须显示 `everRecorded`（清理不让总数凭空变小）', async () => {
  const res = await fetch(base + tombstonesPath({ limit: 500 }))
  const body = await res.json()
  const t = countsText(body.counts)
  assert.match(t, /现存/)
  assert.match(t, /已清理/)
  assert.match(t, /累计产生/,
    '★ 一个"清理之后总数下降了"的报表，与一个"证据悄悄丢了"的报表，'
    + '在只看一个数字的人眼里是同一个东西')
  assert.equal(countsText(null), '')
})

test('★★★ 保留计划：`bounded:false`（不设上限）必须看得出来', () => {
  const unbounded = retentionView({ policy: { maxAgeDays: null, maxBytes: null }, purge: [], keepCount: 3 })
  assert.equal(unbounded.bounded, false)
  const bounded = retentionView({ policy: { maxAgeDays: 30, maxBytes: null }, purge: [], keepCount: 3 })
  assert.equal(bounded.bounded, true)
  // ★ 两者"当前要清的"都是 0，数字完全相同——而它们意味着完全不同的未来
  assert.equal(unbounded.purgeCount, bounded.purgeCount)
  assert.notEqual(unbounded.bounded, bounded.bounded)
  assert.equal(retentionView(null).purgeCount, 0)
})

test('★ 保留计划读的是真 hub 的响应形状', async () => {
  const res = await fetch(base + '/api/context-snapshots/retention?maxAgeDays=null&maxBytes=null')
  assert.equal(res.status, 200)
  const v = retentionView(await res.json())
  assert.equal(v.bounded, false, '两个都传 null 就是"不设上限"')
  assert.equal(v.purgeCount, 0)
  assert.ok(v.keepCount > 0)
})

// ── ⑥ 时间与大小 ─────────────────────────────────────────────────────────

test('★★★ 字节文案用**字节**，不是字符（中文一比三）', () => {
  assert.equal(bytesText(0), '0 B')
  assert.equal(bytesText(512), '512 B')
  assert.equal(bytesText(1024), '1.0 KB')
  assert.equal(bytesText(1024 * 1024), '1.0 MB')
  assert.equal(bytesText(3 * 1024 * 1024 * 1024), '3.00 GB')
  assert.equal(bytesText(NaN), '—')
  assert.equal(bytesText(-1), '—')
  // 12 个字节的 4 个汉字，在界面上必须显示 12 B 而不是 "4"
  assert.equal(bytesText('中文汉字'.length * 3), '12 B')
})

test('★ 相对时间：未来时间不能显示成"负几分钟前"', () => {
  const now = 1_800_000_000_000
  assert.equal(relativeTime(now - 30_000, now), '刚刚')
  assert.equal(relativeTime(now - 5 * 60_000, now), '5 分钟前')
  assert.equal(relativeTime(now - 3 * 3600_000, now), '3 小时前')
  assert.equal(relativeTime(now - 5 * 86400_000, now), '5 天前')
  assert.equal(relativeTime(now + 60_000, now), '（时间在未来）')
  assert.equal(relativeTime(NaN, now), '—')
})

// ── ⑦ 列表归一 ───────────────────────────────────────────────────────────

test('★★★ 列表行：`budgetTrimmed` / 截断 / 排除 / **缺哈希** 都要成为可见标记', () => {
  const rows = listRows([
    {
      attemptId: 'a', runId: 'r1', frozenAtMs: 1_800_000_000_000 - 60_000,
      snapshotHash: 'sha256:abcdef0123456789', tokens: { kind: 'conservative-estimate', tokens: 10 },
      maxTokens: 100, budgetTrimmed: true, truncationCount: 2, excludedCount: 1, candidateCount: 4,
      includedCount: 3, recordedAtMs: 0,
    },
    { attemptId: 'b', runId: 'r2', frozenAtMs: 1_800_000_000_000, tokens: { kind: 'exact', tokens: 5 } },
  ], 1_800_000_000_000)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0].flags, ['已裁剪', '截断 2', '排除 1'])
  assert.equal(rows[0].tokens, '10 / 100 tokens')
  assert.match(rows[0].hash, /^sha256:/)
  assert.equal(rows[0].frozenAt, '1 分钟前')

  // ★ 第二行没有 snapshotHash —— 必须**看得见**，不能静默留空
  assert.deepEqual(rows[1].flags, ['⚠ 缺哈希'],
    '★ 一份没有哈希的列表项在界面上与一份有哈希的看起来一样，而前者无法用于任何比对')
  assert.equal(rows[1].tokens, '5 tokens', '没有 maxTokens 时不臆造一个上限')
  assert.equal(rows[1].hash, '—')
})

test('★ 列表归一扛得住脏数据', () => {
  assert.deepEqual(listRows(null), [])
  assert.deepEqual(listRows([null, 42, {}, { attemptId: 'ok' }]).length, 1)
})

test('★ 真 hub 的列表响应能直接喂给列表归一', async () => {
  const res = await fetch(base + snapshotListPath({ scope: 'default', limit: 10 }))
  const body = await res.json()
  assert.ok(Array.isArray(body.snapshots))
  const rows = listRows(body.snapshots, Date.now())
  assert.equal(rows.length, body.snapshots.length, 'hub 给的每一行都必须能归一（没有一行因形状不对被丢掉）')
  for (const r of rows) {
    assert.ok(typeof r.attemptId === 'string' && r.attemptId !== '')
    assert.ok(!r.flags.includes('⚠ 缺哈希'), `hub 给的列表项必须有哈希：${r.attemptId}`)
  }
})

// ── ⑧ 取数路径 ───────────────────────────────────────────────────────────

test('★★★ `verify=1` **永远**带上（不是可选参数）', () => {
  assert.match(snapshotPath('abc'), /verify=1/,
    '★ 一个"默认不验、想看才验"的查看界面会让绝大多数人看到的是**未被校验过**的内容，'
    + '而界面上没有任何东西提示这一点')
  assert.equal(snapshotPath('abc', { verify: false }), '/api/context-snapshots/abc')
  // attemptId 必须编码
  assert.match(snapshotPath('att:1/2'), /att%3A1%2F2/)
})

test('★ 路径构造：参数缺席就不带上，limit 只在是整数时带上', () => {
  assert.equal(snapshotListPath(), '/api/context-snapshots')
  assert.equal(snapshotListPath({ runId: 'r' }), '/api/context-snapshots?runId=r')
  assert.match(snapshotListPath({ runId: 'r', scope: 'default', limit: 5 }), /runId=r/)
  assert.match(snapshotListPath({ runId: 'r', scope: 'default', limit: 5 }), /limit=5/)
  assert.equal(snapshotListPath({ limit: 2.5 }), '/api/context-snapshots', '非整数 limit 不带上')
  assert.equal(tombstonesPath(), '/api/context-snapshots/tombstones')
  assert.equal(tombstonesPath({ limit: 7 }), '/api/context-snapshots/tombstones?limit=7')
  const ep = exportPath('a', { by: 'me', atMs: 1700000000000 })
  assert.match(ep, /by=me/)
  assert.match(ep, /atMs=1700000000000/)
  assert.match(ep, /\/export\?/)
  assert.match(exportPath('a', { by: 'me', atMs: 1, reason: 'r' }), /reason=r/)
})

test('★★★ 导出的两个必填参数就是 hub 强制的两个（路径构造与后端一致）', async () => {
  const id = await freeze('vw:export:1')
  // 少了 atMs → 真 hub 给 EXPORT_AT_REQUIRED
  const bad = await fetch(base + `/api/context-snapshots/${encodeURIComponent(id)}/export?by=me`)
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).code, 'EXPORT_AT_REQUIRED')

  // 模块构造出来的路径必须**直接可用**
  const good = await fetch(base + exportPath(id, { by: 'me', atMs: 1_700_000_001_000 }))
  assert.equal(good.status, 200, `模块构造的导出路径必须可用，实际 ${good.status}`)
  const body = await good.json()
  assert.equal(body.ok, true)
  assert.ok(body.export?.exportHash, '导出必须带封皮哈希')
  assert.equal(body.verification?.ok, true)
})

// ── ⑨ 屏幕选择 ───────────────────────────────────────────────────────────

test('★★★ 四屏互不相同：list / detail / purged / missing', () => {
  const kinds = new Set([
    screenFor({ items: [] }),
    screenFor({ fetch: { kind: 'live', detail: {} } }),
    screenFor({ fetch: readSnapshotResponse(410, {}) }),
    screenFor({ fetch: readSnapshotResponse(404, {}) }),
  ])
  assert.equal(kinds.size, 4,
    '★ 少一屏就会让两种情况在界面上重合，而这里重合的每一对都意味着'
    + '用户会对"这份证据还在不在"得出错误结论')
  assert.equal(screenFor({ fetch: null }), 'list')
})

// ── ⑩ 理由表本身 ─────────────────────────────────────────────────────────

test('★★ 排除理由表与后端枚举**逐一对齐**', () => {
  // 后端枚举（runtime/contracts/context.mjs 的 EXCLUSION_REASONS）
  const backend = ['unauthorized', 'stale', 'over-budget', 'redacted', 'missing', 'out-of-scope']
  for (const r of backend) {
    assert.ok(Object.hasOwn(EXCLUSION_REASON_LABEL, r),
      `★ 后端定义的排除理由 ${r} 界面必须有文案——否则它会被渲染成"未知理由"`)
    assert.ok(exclusionLabel(r) !== `未知理由：${r}`)
  }
  assert.equal(Object.keys(EXCLUSION_REASON_LABEL).length, backend.length,
    '界面不该自己发明后端没有的理由')
})

// ── ⑪ ★★ 三态必须**在样式上也**分得开 ─────────────────────────────────────
//
// 这一节是被实测逼出来的：组件第一版写了
// `className={verdict === 'ok' ? 'ok' : verdict === 'mismatch' ? 'err' : 'warn'}`，
// 而本仓库的 index.css 里**没有**独立的 `.ok` / `.warn` / `.err`——
// 只有 `.toast.err`、`.state-box .err` 这类复合选择器。
// 于是三个状态渲染出来是**同一个样子**。
//
//   > 一个"算出了三种状态、而它们共用一套灰底"的界面，
//   > 与一个"只算了一种状态"的界面，对用户是同一个东西——
//   > 只不过前者的代码里写着 verdict === 'mismatch'。
//
// 所以这里核对 **CSS 文件本身**，而不只是组件里写了三态。

const CSS = readFileSync(join(REPO, 'workbench', 'src', 'index.css'), 'utf8')
const COMPONENT = readFileSync(join(REPO, 'workbench', 'src', 'components', 'SnapshotView.tsx'), 'utf8')

test('★★★ 三种验证结论在 CSS 里**互不相同**（不是共用一套底）', () => {
  const rule = (cls) => {
    const m = CSS.match(new RegExp(`\\.snapshot-view \\.snap-verdict\\.${cls}\\s*\\{([^}]*)\\}`))
    return m === null ? null : m[1]
  }
  const ok = rule('ok')
  const warn = rule('warn')
  const err = rule('err')
  assert.notEqual(ok, null, '★ .snap-verdict.ok 必须在 index.css 里定义')
  assert.notEqual(warn, null, '★ .snap-verdict.warn 必须在 index.css 里定义')
  assert.notEqual(err, null, '★ .snap-verdict.err 必须在 index.css 里定义')
  // ★ 三者必须真的不同——两个状态样式相同就是把三态退化成两态
  assert.notEqual(ok, err, '★ "校验通过"与"哈希对不上"不能长成一样')
  assert.notEqual(ok, warn, '★ "校验通过"与"未校验"不能长成一样')
  assert.notEqual(warn, err, '★ "未校验"与"哈希对不上"不能长成一样')

  // 每条都要有自己的颜色与左边框，而不是只改文字
  for (const [name, body] of [['ok', ok], ['warn', warn], ['err', err]]) {
    assert.match(body, /border-left-color/, `${name} 必须有可区分的左边框色`)
    assert.match(body, /background/, `${name} 必须有可区分的底色`)
  }
})

test('★★ 组件里**不许**再用裸 `.ok`/`.warn`/`.err`（本仓库没有独立定义）', () => {
  const bare = [...COMPONENT.matchAll(/className="(ok|warn|err)"/g)].map((m) => m[1])
  assert.deepEqual(bare, [],
    `★ 裸 class 在 index.css 里没有独立定义，会渲染成无样式：${bare.join(', ')}。`
    + '必须用 snap-verdict / snap-note 前缀')
  // 三态判定必须真的出现在组件里（不是只写在模块里）
  assert.match(COMPONENT, /snap-verdict/, '组件必须把验证结论渲染成 snap-verdict')
  assert.match(COMPONENT, /verdict === 'ok'/, '组件必须区分 ok')
  assert.match(COMPONENT, /verdict === 'mismatch'/, '组件必须区分 mismatch')
})

test('★ 组件**不许**自己重算哈希（权威在后端）', () => {
  // 一个在前端重算哈希的实现会造出第二个事实来源，
  // 而它与后端不一致时，界面不知道该信谁。
  assert.doesNotMatch(COMPONENT, /createHash|subtle\.digest|sha256\s*\(/,
    '★ 前端不重算哈希——它没有库、没有完整上下文，只呈现后端给的两个哈希是否相同')
  assert.match(COMPONENT, /verifyVerdict/)
})

test('★ 组件必须**真的**用上每个判定（不做"测试绿但线上未用"的假接线）', () => {
  // 这些是本模块的导出一半以上，逐个确认组件里有调用点。
  // 一个"写好了判定、没接进界面"的模块，与一个"没写过"的模块，对用户是同一个东西。
  for (const fn of ['verifyVerdict', 'ledgerView', 'ledgersOf', 'segmentViews', 'textPreview',
    'unknownReasons', 'tombstoneText', 'countsText', 'listRows', 'screenFor', 'exportPath']) {
    assert.match(COMPONENT, new RegExp(`\\b${fn}\\b`), `★ 组件必须调用 ${fn}`)
  }
})
