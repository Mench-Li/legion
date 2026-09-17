// team-hub/experience-store.test.mjs
// ============================================================================
// F-18 落盘面的判据。
//
// 两条主线：
//   · 这一层只存**记录**、不存"现在的图/状态"——状态是推导出来的
//   · 草稿的处置**也是记录**：`draft → promote|discard` 追加，不 UPDATE
// 第三条：**坏行**与"没有这一行"必须分得开。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DRAFT_STATES, EXPERIENCE_KINDS, EXPERIENCE_RECORD_VERSION, EXPERIENCE_STORE_ERRORS,
  appendExperienceRecord, deriveDraftState, draftCounts, ensureExperienceSchema,
  experienceAccount, experienceRecords, exportExperience, normalizeExperienceRecord, settleDraft,
} from './experience-store.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function freshDb() {
  const db = new DatabaseSync(':memory:')
  ensureExperienceSchema(db)
  return db
}

function throwsCode(fn, code) {
  let err = null
  try { fn() } catch (e) { err = e }
  assert.notEqual(err, null, `期望抛出 ${code}，但没有抛`)
  assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}：${err.message}`)
  return err
}

/** 一条草稿 + 可选的处置。 */
function draft(db, id = 'd1', { settle = null, scope = 'default' } = {}) {
  appendExperienceRecord({
    db, scope,
    record: { kind: 'draft', draftId: id, atMs: 1000, subject: { kind: 'skill', id: 'skill.diff' }, score: 9 },
  })
  if (settle !== null) {
    settleDraft({ db, scope, draftId: id, action: settle, by: 'general', reason: settle === 'promote' ? 'recurring' : 'one-off', atMs: 2000 })
  }
}

// ---------------------------------------------------------------------------
// ① 只存记录，不存状态
// ---------------------------------------------------------------------------

test('① ★★★ 本模块**没有** `UPDATE` / `DELETE` / "保存整张图"的出口', () => {
  const src = readFileSync(join(HERE, 'experience-store.mjs'), 'utf8')
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  // 记录流只追加。一条 UPDATE 会让"这条记录当初是什么"被改写。
  assert.deepEqual([...code.matchAll(/UPDATE\s+experience_records/gi)].map((m) => m[0]), [])
  assert.deepEqual([...code.matchAll(/DELETE\s+FROM\s+experience_records/gi)].map((m) => m[0]), [])
  assert.match(code, /INSERT INTO experience_records/)
  assert.match(src, /CREATE TABLE IF NOT EXISTS experience_records/)
  // 没有"把整张图存下来"的接口——那会是第二份真相。
  for (const banned of ['saveGraph', 'saveState', 'upsertDraft', 'setStatus']) {
    assert.equal(code.includes(banned), false, `出现了 ${banned}`)
  }
})

test('① ★★ 建表是幂等的（两个进程同时启动）', () => {
  const db = new DatabaseSync(':memory:')
  ensureExperienceSchema(db)
  ensureExperienceSchema(db)
  assert.equal(draftCounts({ db }).readable, true)
})

test('① ★★ 记录的 `atMs` 必填且必须是整数（`undefined` 与"当时就是 0"长得一样）', () => {
  const err = throwsCode(
    () => normalizeExperienceRecord({ kind: 'draft', draftId: 'd' }),
    EXPERIENCE_STORE_ERRORS.BAD_RECORD,
  )
  assert.match(err.message, /不给默认值/)
  throwsCode(() => normalizeExperienceRecord({ kind: 'draft', draftId: 'd', atMs: '2024-01-01' }),
    EXPERIENCE_STORE_ERRORS.BAD_RECORD)
  // 未知种类不给默认归类。
  const err2 = throwsCode(
    () => normalizeExperienceRecord({ kind: 'mystery', atMs: 1 }),
    EXPERIENCE_STORE_ERRORS.UNKNOWN_KIND,
  )
  assert.match(err2.message, /敢不敢说"我不知道"/)
  assert.deepEqual([...EXPERIENCE_KINDS], ['node', 'edge', 'retract', 'draft', 'promote', 'discard'])
})

test('① ★★ 边必须带 source；收回必须署名（不知道谁加的边只能整条删掉）', () => {
  throwsCode(
    () => normalizeExperienceRecord({ kind: 'edge', edgeId: 'e1', from: 'a', to: 'b', atMs: 1 }),
    EXPERIENCE_STORE_ERRORS.BAD_RECORD,
  )
  throwsCode(
    () => normalizeExperienceRecord({ kind: 'retract', edgeId: 'e1', atMs: 1 }),
    EXPERIENCE_STORE_ERRORS.BAD_RECORD,
  )
  throwsCode(
    () => normalizeExperienceRecord({ kind: 'node', nodeKind: 'mystery', id: 'x', atMs: 1 }),
    EXPERIENCE_STORE_ERRORS.BAD_RECORD,
  )
})

// ---------------------------------------------------------------------------
// ② 处置是记录，状态是推导
// ---------------------------------------------------------------------------

test('② ★★★ 处置追加一条记录，**不**改写草稿那一行', () => {
  const db = freshDb()
  draft(db, 'd1')
  const before = experienceRecords({ db, draftId: 'd1' })
  assert.equal(before.length, 1)
  settleDraft({ db, draftId: 'd1', action: 'promote', by: 'general', reason: 'recurring', atMs: 2000 })
  const after = experienceRecords({ db, draftId: 'd1' })
  assert.equal(after.length, 2, '处置应该是**追加**，不是改写')
  // 原来那条 draft 记录一字未动（这是"当初是关于什么"的唯一证据）。
  assert.equal(after[0].record.kind, 'draft')
  assert.equal(after[0].record.draftId, 'd1')
  assert.deepEqual(after[0].record.subject, { kind: 'skill', id: 'skill.diff' })
  assert.equal(after[0].record.score, 9)
  assert.equal(after[1].record.kind, 'promote')
  assert.equal(after[1].record.by, 'general')
  assert.equal(after[1].record.reason, 'recurring')
  // 草稿那一行里**没有** status 字段——状态从来不存在于行里。
  assert.equal('status' in after[0].record, false)
})

test('② ★★★ 状态是从记录流推出来的，且两个终点互斥', () => {
  const db = freshDb()
  draft(db, 'd1')
  assert.equal(deriveDraftState(experienceRecords({ db, draftId: 'd1' })).state, 'draft')
  settleDraft({ db, draftId: 'd1', action: 'discard', by: 'general', reason: 'environmental', atMs: 2000 })
  const s = deriveDraftState(experienceRecords({ db, draftId: 'd1' }))
  assert.equal(s.state, 'discarded')
  assert.equal(s.by, 'general')
  assert.equal(s.reason, 'environmental')
  assert.equal(s.atMs, 2000)
  assert.deepEqual([...DRAFT_STATES], ['draft', 'promoted', 'discarded'])
  draft(db, 'd2', { settle: 'promote' })
  assert.equal(deriveDraftState(experienceRecords({ db, draftId: 'd2' })).state, 'promoted')
})

test('② ★★★ 已处置的草稿不许再次处置（409，且说清现在是什么状态）', () => {
  const db = freshDb()
  draft(db, 'd1', { settle: 'promote' })
  const err = throwsCode(
    () => settleDraft({ db, draftId: 'd1', action: 'discard', by: 'other', reason: 'one-off' }),
    EXPERIENCE_STORE_ERRORS.ALREADY_SETTLED,
  )
  assert.equal(err.statusCode, 409)
  assert.match(err.message, /只有一个终点/)
  assert.match(err.message, /分别加了两次/)
  // 冲突响应里带着"现在是什么状态"，调用方不必再查一次。
  assert.deepEqual(err.currentSettlement, {
    draftId: 'd1', state: 'promoted', by: 'general', reason: 'recurring', atMs: 2000,
  })
  // 而且真的没有写入第二条处置。
  assert.equal(experienceRecords({ db, draftId: 'd1' }).length, 2)
  // 同一动作重复也不行。
  throwsCode(
    () => settleDraft({ db, draftId: 'd1', action: 'promote', by: 'general', reason: 'recurring' }),
    EXPERIENCE_STORE_ERRORS.ALREADY_SETTLED,
  )
})

test('② ★★ 处置必须有署名与理由（丢弃也要写理由）', () => {
  const db = freshDb()
  draft(db, 'd1')
  // 理由空着由**两层**分别拦：normalize 拦空串，settleDraft 之前先看状态。
  const err = throwsCode(
    () => settleDraft({ db, draftId: 'd1', action: 'discard', by: 'general', reason: '   ' }),
    EXPERIENCE_STORE_ERRORS.BAD_RECORD,
  )
  assert.match(err.message, /丢弃也要写理由/)
  throwsCode(
    () => settleDraft({ db, draftId: 'd1', action: 'promote', by: '', reason: 'recurring' }),
    EXPERIENCE_STORE_ERRORS.BAD_RECORD,
  )
  // 动作只有两个。
  throwsCode(
    () => settleDraft({ db, draftId: 'd1', action: 'delete', by: 'g', reason: 'one-off' }),
    EXPERIENCE_STORE_ERRORS.BAD_RECORD,
  )
  // 一个都没写进去。
  assert.equal(experienceRecords({ db, draftId: 'd1' }).length, 1)
})

test('② ★★ 只有 promote/discard 而没有 draft 的流 ⇒ 报错，不给空状态', () => {
  // "来源丢了的草稿"与"一条还没人看的草稿"必须是两个读数。
  const db = freshDb()
  const err = throwsCode(
    () => settleDraft({ db, draftId: 'ghost', action: 'promote', by: 'g', reason: 'recurring' }),
    EXPERIENCE_STORE_ERRORS.DRAFT_NOT_FOUND,
  )
  assert.match(err.message, /来源丢了/)
  // 直接调推导也一样。
  throwsCode(
    () => deriveDraftState([{ seq: 1, kind: 'promote', record: { draftId: 'x' }, readable: true }]),
    EXPERIENCE_STORE_ERRORS.DRAFT_NOT_FOUND,
  )
})

// ---------------------------------------------------------------------------
// ③ 坏行与"没有这一行"分得开
// ---------------------------------------------------------------------------

test('③ ★★★ 坏 `record_json` ⇒ `readable:false`、`record:null`，**不是**当作不存在', () => {
  const db = freshDb()
  draft(db, 'd1')
  settleDraft({ db, draftId: 'd1', action: 'promote', by: 'general', reason: 'recurring', atMs: 2000 })
  db.prepare("UPDATE experience_records SET record_json = '{ 坏了' WHERE kind = 'promote'").run()
  const recs = experienceRecords({ db, draftId: 'd1' })
  assert.equal(recs.length, 2, '坏行仍然要出现在结果里——悄悄丢掉它会让"从没记过"与"这行坏了"变成同一个读数')
  assert.equal(recs[1].readable, false)
  assert.equal(recs[1].record, null)
  assert.equal(recs[1].kind, 'promote', '投影列还在，于是至少知道这里曾经有一条处置记录')
})

test('③ ★★ 坏行单独计数，不并进 `draft`（否则"来源丢了"看起来像"还没人看"）', () => {
  const db = freshDb()
  draft(db, 'd1')                     // 正常，未处置
  draft(db, 'd2', { settle: 'promote' })
  draft(db, 'd3')
  db.prepare("UPDATE experience_records SET record_json = 'x' WHERE draft_id = 'd3'").run()
  const c = draftCounts({ db })
  assert.equal(c.readable, true)
  assert.equal(c.total, 3)
  assert.equal(c.draft, 1, '只有 d1 是"还没人看"')
  assert.equal(c.promoted, 1)
  assert.equal(c.discarded, 0)
  assert.equal(c.broken, 1, 'd3 的流坏了，单独计数')
  // 积压率的分母**不含**坏的那些（能判定状态的只有 2 条）。
  assert.equal(c.openRatio, 1 / 2)
})

test('③ ★★ 读不出来时报 `readable:false` + null，不是 0', () => {
  const broken = { prepare: () => { throw new Error('表被删了') } }
  const c = draftCounts({ db: broken })
  assert.equal(c.readable, false)
  assert.equal(c.total, null)
  assert.equal(c.draft, null)
  assert.equal(c.openRatio, null)
  assert.match(c.reason, /表被删了/)
  // 一条都没有时积压率是 null（0% 会被读成"流程很健康"）。
  assert.equal(draftCounts({ db: freshDb() }).openRatio, null)
})

test('③ 读失败要抛 500（读不出来与"没有记录"不能同形）', () => {
  const broken = { prepare: () => { throw new Error('库打不开') } }
  const err = throwsCode(() => experienceRecords({ db: broken }), EXPERIENCE_STORE_ERRORS.READ_FAILED)
  assert.equal(err.statusCode, 500)
  throwsCode(() => appendExperienceRecord({ db: broken, record: { kind: 'draft', draftId: 'd', atMs: 1 } }),
    EXPERIENCE_STORE_ERRORS.WRITE_FAILED)
  throwsCode(() => appendExperienceRecord({ db: null, record: { kind: 'draft', draftId: 'd', atMs: 1 } }),
    EXPERIENCE_STORE_ERRORS.WRITE_FAILED)
})

// ---------------------------------------------------------------------------
// ④ 图记录：节点 / 边 / 收回都在同一本账里
// ---------------------------------------------------------------------------

test('④ ★★ 节点、边、收回都是记录，收回**不删**那条边', () => {
  const db = freshDb()
  appendExperienceRecord({ db, record: { kind: 'node', nodeKind: 'task', id: 't1', atMs: 1 } })
  appendExperienceRecord({ db, record: { kind: 'node', nodeKind: 'file', id: 'a.mjs', atMs: 1 } })
  appendExperienceRecord({
    db,
    record: { kind: 'edge', edgeId: 'e1', from: 'task:t1', to: 'file:a.mjs', edgeKind: 'touched', source: 'worker', reason: 'diff 里有它', atMs: 2 },
  })
  appendExperienceRecord({ db, record: { kind: 'retract', edgeId: 'e1', by: 'general', reason: '只是读了一下', atMs: 3 } })
  // ★ 那条边**仍在**账里（收回是追加），于是"存在过、被谁按什么理由收了"能回答。
  const edges = experienceRecords({ db, edgeId: 'e1' })
  assert.deepEqual(edges.map((r) => r.kind), ['edge', 'retract'])
  assert.equal(edges[0].record.reason, 'diff 里有它')
  assert.equal(edges[1].record.reason, '只是读了一下')
  assert.equal(edges[1].record.by, 'general')
  // 按种类过滤，以及按节点投影列过滤。
  assert.equal(experienceRecords({ db, kind: 'edge' }).length, 1)
  assert.equal(experienceRecords({ db, kind: 'retract' }).length, 1)
  assert.equal(experienceRecords({ db, kind: 'node' }).length, 2)
})

test('④ ★ 可按 `sinceSeq` 增量拉（重启后接着走，不必整本重读）', () => {
  const db = freshDb()
  draft(db, 'd1')
  const first = experienceRecords({ db })
  const high = first[first.length - 1].seq
  draft(db, 'd2')
  const delta = experienceRecords({ db, sinceSeq: high })
  assert.equal(delta.length, 1)
  assert.equal(delta[0].record.draftId, 'd2')
  // limit 也认。
  assert.equal(experienceRecords({ db, limit: 1 }).length, 1)
  // 未知种类要抛。
  throwsCode(() => experienceRecords({ db, kind: 'mystery' }), EXPERIENCE_STORE_ERRORS.UNKNOWN_KIND)
})

test('④ ★★ `scope` 隔离：同名草稿在两个空间里互不可见', () => {
  const db = freshDb()
  draft(db, 'd1', { scope: 'team-a' })
  draft(db, 'd1', { settle: 'promote', scope: 'team-b' })
  assert.equal(deriveDraftState(experienceRecords({ db, scope: 'team-a', draftId: 'd1' })).state, 'draft')
  assert.equal(deriveDraftState(experienceRecords({ db, scope: 'team-b', draftId: 'd1' })).state, 'promoted')
  // 一个空间里的处置不会撞上另一个空间。
  settleDraft({ db, scope: 'team-a', draftId: 'd1', action: 'discard', by: 'g', reason: 'one-off' })
  assert.equal(deriveDraftState(experienceRecords({ db, scope: 'team-a', draftId: 'd1' })).state, 'discarded')
  assert.equal(experienceRecords({ db, scope: 'team-b' }).length, 2)
})

// ---------------------------------------------------------------------------
// ⑤ 账与导出
// ---------------------------------------------------------------------------

test('⑤ ★ `experienceAccount` 给出记录流 + 坏行数（重启后可据此重建）', () => {
  const db = freshDb()
  draft(db, 'd1', { settle: 'promote' })
  const acct = experienceAccount({ db })
  assert.equal(acct.format, EXPERIENCE_RECORD_VERSION)
  assert.equal(acct.scope, 'default')
  assert.equal(acct.records.length, 2)
  assert.equal(acct.brokenCount, 0)
  assert.equal(acct.counts.promoted, 1)
  // 坏行单独报出来。
  db.prepare("UPDATE experience_records SET record_json = 'x' WHERE kind = 'promote'").run()
  assert.equal(experienceAccount({ db }).brokenCount, 1)
})

test('⑤ ★★ 导出是白名单：不含草稿正文 / subject / payload', () => {
  const db = freshDb()
  draft(db, 'd1', { settle: 'promote' })
  const { text, doc } = exportExperience({ db, exportedAtMs: 1700000000000 })
  assert.equal(doc.format, 'legion/experience-export@1')
  assert.equal(doc.records.length, 2)
  assert.deepEqual(doc.records.map((r) => r.kind), ['draft', 'promote'])
  assert.equal(doc.records[0].draftId, 'd1')
  assert.equal(doc.records[1].reason, 'recurring')
  assert.equal(doc.records[1].actor, 'general')
  // ★ 白名单：草稿的 subject/payload **不许**出现（它们会引用任务细节，
  //   而进了 Git 历史就删不掉）。
  assert.equal(text.includes('payload'), false, '导出带上了 payload')
  assert.equal(text.includes('subject'), false, '导出带上了 subject')
  assert.equal(text.includes('skill.diff'), false, '导出带上了草稿指向的具体技能')
  assert.equal(text.includes('score'), false, '导出带上了草稿分数')
  // 但计数要在（审阅的人要看积压）。
  assert.equal(doc.counts.promoted, 1)
})

test('⑤ 导出的图记录给的是"可读的形状"，而不是原始 JSON', () => {
  const db = freshDb()
  appendExperienceRecord({ db, record: { kind: 'node', nodeKind: 'task', id: 't1', atMs: 1 } })
  appendExperienceRecord({
    db,
    record: { kind: 'edge', edgeId: 'e1', from: 'task:t1', to: 'file:a.mjs', edgeKind: 'touched', source: 'worker', atMs: 2 },
  })
  const { doc } = exportExperience({ db })
  assert.equal(doc.records[0].node, 'task:t1')
  assert.equal(doc.records[1].edge, 'task:t1->file:a.mjs(touched)')
})

test('⑤ 空账上的导出也能用，且给出真实的 0（不是缺字段）', () => {
  const db = freshDb()
  const { doc } = exportExperience({ db })
  assert.deepEqual(doc.records, [])
  assert.equal(doc.counts.total, 0)
  assert.equal(doc.counts.readable, true)
  assert.equal(doc.counts.openRatio, null, '没有草稿时积压率是 null，不是 0')
})

test('⑤ 每个码都至少被一个用例触达', () => {
  const src = readFileSync(join(HERE, 'experience-store.mjs'), 'utf8')
  const declared = [...src.matchAll(/^\s{2}([A-Z_]+):\s*'/gm)].map((m) => m[1])
  const testSrc = readFileSync(join(HERE, 'experience-store.test.mjs'), 'utf8')
  const unreachable = declared.filter((n) => !testSrc.includes(`EXPERIENCE_STORE_ERRORS.${n}`))
  assert.deepEqual(unreachable, [], `这些码没有用例触达：${unreachable.join(', ')}`)
})

test('⑤ ★★★ 返回的 `seq` 是**自己那一条**的号，不是 `MAX(seq)` 回读出来的', () => {
  // 两个进程共用一个 SQLite 文件（8787 独立进程 + 3080 宿主壳），于是：
  //   A: INSERT  → seq=5
  //   B: INSERT  → seq=6
  //   A: SELECT MAX(seq) → **6**  ← A 把 6 报成自己的号
  // 调用方拿它做增量读（`sinceSeq`）时，第 5 条**永远读不到**——
  // 而账看起来完全正常，只是少一条。
  //
  // 这个交错没法用真的并发在单进程里稳定复现，所以用一个**假 db** 把它固定下来：
  // `run()` 给出真实的 lastInsertRowid=5，而 `MAX(seq)` 故意返回 6。
  const real = new DatabaseSync(':memory:')
  ensureExperienceSchema(real)
  const fake = {
    prepare(sql) {
      if (/^\s*INSERT/i.test(sql)) {
        // 真的插进去（这样后面的断言能核对行），但谎报"我读到的是 6"。
        return { run: (...args) => { real.prepare(sql).run(...args); return { changes: 1, lastInsertRowid: 5 } } }
      }
      if (/MAX\(seq\)/i.test(sql)) return { get: () => ({ seq: 6 }) }
      return real.prepare(sql)
    },
  }
  const r = appendExperienceRecord({ db: fake, record: { kind: 'draft', draftId: 'd1', atMs: 1 } })
  assert.equal(r.seq, 5, '报回来的必须是自己那一条的号')
  assert.notEqual(r.seq, 6, '这就是 `MAX(seq)` 回读会给出的错号')
  // 真实路径上，返回的号必须与那一行自己的号一致。
  const db = freshDb()
  const a = appendExperienceRecord({ db, record: { kind: 'draft', draftId: 'x', atMs: 1 } })
  const b = appendExperienceRecord({ db, record: { kind: 'draft', draftId: 'y', atMs: 2 } })
  assert.equal(a.seq, 1)
  assert.equal(b.seq, 2)
  const rows = experienceRecords({ db })
  assert.deepEqual(rows.map((x) => x.seq), [a.seq, b.seq])
  // 增量读用返回的号也接得上（这是 seq 唯一的用途）。
  assert.equal(experienceRecords({ db, sinceSeq: a.seq }).length, 1)
})

test('⑤ ★★ `SEQ_CONFLICT` **不存在**（这本账的 seq 由数据库分配，抢号不可能发生）', () => {
  // F-20 的账有那个码，因为它用应用层 `MAX(seq)+1` 算号；
  // 这一本用 AUTOINCREMENT，所以那个码会是一个**永远抛不出**的分支。
  // 一个不可能触发的错误码，与一段被注释掉的代码是同一个东西。
  assert.equal('SEQ_CONFLICT' in EXPERIENCE_STORE_ERRORS, false)
  const src = readFileSync(join(HERE, 'experience-store.mjs'), 'utf8')
  assert.match(src, /AUTOINCREMENT/, '记录流的 seq 必须由数据库自增（两个进程共用一个文件）')
  // 而且不能有 MAX(seq) 回读（那是这条路上真实的坑）。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  assert.equal(/SELECT\s+MAX\(seq\)/i.test(code), false, '出现了 MAX(seq) 回读')
  assert.match(code, /lastInsertRowid/)
})
