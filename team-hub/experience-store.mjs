// team-hub/experience-store.mjs
// ============================================================================
// F-18 经验图谱 / 摩擦学习的**落盘面**。
//
// 执行面（`runtime/experience/*.mjs`）算摩擦分、造草稿、维护关系图；
// 这一层负责把它们的**记录**存下来，让控制面重启之后还能回答：
//   · 这张图里有过哪些边、哪些被收回过
//   · 有哪些草稿还没人看
//   · 一条草稿是谁、按什么理由晋升或丢弃的
//
// ---------------------------------------------------------------------------
// ★ ① 这一层只存**记录**，不存"现在的图长什么样"
//
// 与 F-20 的安装事实同一条纪律：记录是唯一的真相，状态是它的**推导**。
// 于是这里没有任何"保存整张图"的接口——那会让"图现在是什么样"变成第二份真相，
// 而它与记录流不一致时**没有任何东西能判定谁对**。
//
// ---------------------------------------------------------------------------
// ★ ② 两个进程共用一个 SQLite 文件（8787 独立进程 + 3080 宿主壳）
//
// 所以：`seq` 用一条 SQL 算出来（`MAX(seq)+1`），建表一律 `IF NOT EXISTS`，
// 主键冲突报 409 且**明说这次写入没有发生**，不重编号。
// 重编号会让记录的顺序与实际发生的顺序不一致——而那种账在事后复盘时
// 与"顺序本来就是对的"**无法区分**。
//
// ---------------------------------------------------------------------------
// ★ ③ 草稿的处置**也**是记录，不是 UPDATE
//
// 一条草稿被晋升之后，这里不会去改原来那行的 `status`，而是追加一条
// `promote` 记录。理由与图里的"收回"完全一样：
//
//   > 一个「把草稿的 status 改成 promoted」的表，
//   > 与一个「这条草稿当初是谁、按什么理由放的」无从回答的表，是同一个东西。
//
// 而且"它现在是什么状态"必须能从记录流**推**出来——同一份推导写在
// `deriveDraftState()` 里，执行面的 `promoteDraft`/`discardDraft` 与之同源。
// ============================================================================

import { ensureColumn } from './schema-util.mjs'

/** 记录流的形态版本。 */
export const EXPERIENCE_RECORD_VERSION = 'legion/experience-record@1'

/** 这一层认得的事件种类，**封闭词表**。 */
export const EXPERIENCE_KINDS = Object.freeze([
  'node', 'edge', 'retract', 'draft', 'promote', 'discard',
])

/** 草稿的状态（推导结果），**封闭词表**。 */
export const DRAFT_STATES = Object.freeze(['draft', 'promoted', 'discarded'])

export const EXPERIENCE_STORE_ERRORS = Object.freeze({
  BAD_RECORD: 'EXPERIENCE_RECORD_MALFORMED',
  UNKNOWN_KIND: 'EXPERIENCE_KIND_UNKNOWN',
  // ★ 这里**没有** `SEQ_CONFLICT`（F-20 的账有，这一本没有）。
  //   F-20 的 seq 是应用层用 `MAX(seq)+1` 一条 SQL 算出来的，两个进程会抢同一个号，
  //   所以那本账必须有一个"号被抢了"的表达。
  //   这一本的 seq 是 `INTEGER PRIMARY KEY AUTOINCREMENT`——**数据库**分配，
  //   两个进程由 SQLite 自己串行化，所以"号被抢"在这本账上不可能发生。
  //   保留一个不可能抛出的码，与一段被注释掉的代码是同一个东西，
  //   只不过前者会让"错误码清单"看起来更完整。（用例 ⑤ 会盯住这一点。）
  //   ——而这条路上**真实存在**的并发坑是另一个，它没有对应的错误码：
  //   写入后不能靠 `SELECT MAX(seq)` 回读自己的号（见 appendExperienceRecord）。
  DRAFT_NOT_FOUND: 'EXPERIENCE_DRAFT_NOT_FOUND',
  ALREADY_SETTLED: 'EXPERIENCE_DRAFT_ALREADY_SETTLED',
  WRITE_FAILED: 'EXPERIENCE_WRITE_FAILED',
  READ_FAILED: 'EXPERIENCE_READ_FAILED',
})

function fail(code, message, extra = {}, statusCode = 400) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  err.statusCode = statusCode
  Object.assign(err, extra)
  return err
}

/**
 * 建表。
 *
 * ★ 一张表，只追加。`draft_id`/`edge_id` 只作为**查询用的投影列**存在
 *   （它们与 `record_json` 里的同一字段重复，之所以不是第二份真相，
 *   唯一的理由是**这张表没有任何 UPDATE 路径**——由用例钉住）。
 */
export function ensureExperienceSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS experience_records (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL DEFAULT 'default',
      kind TEXT NOT NULL,
      draft_id TEXT,
      edge_id TEXT,
      node_key TEXT,
      at_ms INTEGER NOT NULL,
      actor TEXT,
      record_json TEXT NOT NULL,
      recorded_at_ms INTEGER NOT NULL
    )
  `)
  // 按草稿取历史（推导状态用），按 scope 取全量（导出/诊断用）。
  db.exec('CREATE INDEX IF NOT EXISTS idx_experience_draft ON experience_records(scope, draft_id, seq)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_experience_edge ON experience_records(scope, edge_id, seq)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_experience_kind ON experience_records(scope, kind, seq)')
  // 老库可能没有这几列；`CREATE TABLE IF NOT EXISTS` 对已存在的表是空操作。
  ensureColumn(db, 'experience_records', 'node_key', 'TEXT')
  ensureColumn(db, 'experience_records', 'actor', 'TEXT')
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 规范化一条要追加的记录。
 *
 * ★ 形态对不上时**不猜**：一条被猜出来的记录会永远留在只追加的表里，
 *   而它看起来与一条真的记录完全一样。
 */
export function normalizeExperienceRecord(input) {
  if (!isPlainObject(input)) {
    throw fail(EXPERIENCE_STORE_ERRORS.BAD_RECORD, '要追加的是一条记录对象')
  }
  const kind = String(input.kind ?? '').trim()
  if (!EXPERIENCE_KINDS.includes(kind)) {
    throw fail(
      EXPERIENCE_STORE_ERRORS.UNKNOWN_KIND,
      `未知的记录种类 ${JSON.stringify(input.kind)}（允许：${EXPERIENCE_KINDS.join('/')}）。` +
      '账里出现一个读不出来的种类时，整本账的可信度取决于读的人敢不敢说"我不知道"',
    )
  }
  // ★ `atMs` 必填且必须是整数：`undefined` 与"当时就是 0"长得一样，
  //   而"这条记录是什么时候发生的"是把图与真实运行对上号的唯一入口。
  if (!Number.isInteger(input.atMs)) {
    throw fail(
      EXPERIENCE_STORE_ERRORS.BAD_RECORD,
      `记录的 atMs 必须是整数毫秒时间戳，收到 ${JSON.stringify(input.atMs)}。` +
      '**不给默认值**：`undefined` 与"当时就是 0"会长得一样',
    )
  }
  const record = { kind, atMs: input.atMs }
  if (kind === 'node') {
    const nodeKind = String(input.nodeKind ?? '').trim()
    const id = String(input.id ?? '').trim()
    // 与执行面同一张封闭词表：不给默认种类。
    if (!['task', 'file', 'skill', 'error'].includes(nodeKind)) {
      throw fail(EXPERIENCE_STORE_ERRORS.BAD_RECORD, `node 节点的种类 ${JSON.stringify(input.nodeKind)} 不合法`)
    }
    if (id === '') throw fail(EXPERIENCE_STORE_ERRORS.BAD_RECORD, 'node 节点缺 id')
    record.nodeKind = nodeKind
    record.id = id
  } else if (kind === 'edge') {
    const edgeId = String(input.edgeId ?? '').trim()
    if (edgeId === '') throw fail(EXPERIENCE_STORE_ERRORS.BAD_RECORD, 'edge 缺 edgeId')
    if (String(input.from ?? '') === '' || String(input.to ?? '') === '') {
      throw fail(EXPERIENCE_STORE_ERRORS.BAD_RECORD, 'edge 必须同时有 from 与 to')
    }
    // ★ `source` 必填：一条不知道谁记的边，在被怀疑时只能整条删掉。
    if (String(input.source ?? '').trim() === '') {
      throw fail(EXPERIENCE_STORE_ERRORS.BAD_RECORD, 'edge 必须记下 source（谁记的）')
    }
    record.edgeId = edgeId
    record.from = String(input.from); record.to = String(input.to)
    record.edgeKind = String(input.edgeKind ?? '').trim()
    record.source = String(input.source).trim()
    record.reason = input.reason ?? null
  } else if (kind === 'retract') {
    const edgeId = String(input.edgeId ?? '').trim()
    if (edgeId === '') throw fail(EXPERIENCE_STORE_ERRORS.BAD_RECORD, 'retract 缺 edgeId')
    if (String(input.by ?? '').trim() === '') {
      throw fail(EXPERIENCE_STORE_ERRORS.BAD_RECORD, 'retract 必须署名（by）')
    }
    record.edgeId = edgeId
    record.by = String(input.by).trim()
    record.reason = input.reason ?? null
  } else {
    // draft / promote / discard
    const draftId = String(input.draftId ?? '').trim()
    if (draftId === '') throw fail(EXPERIENCE_STORE_ERRORS.BAD_RECORD, `${kind} 缺 draftId`)
    record.draftId = draftId
    record.subject = input.subject ?? null
    record.score = input.score ?? null
    record.payload = input.payload ?? null
    if (kind !== 'draft') {
      if (String(input.by ?? '').trim() === '') {
        throw fail(EXPERIENCE_STORE_ERRORS.BAD_RECORD, `${kind} 必须署名（by）`)
      }
      record.by = String(input.by).trim()
      // ★ 理由是**必填**且由执行面校验封闭词表。这一层只保证它非空：
      //   两层都塞一份词表，就是两份会各自漂移的词表。
      if (String(input.reason ?? '').trim() === '') {
        throw fail(
          EXPERIENCE_STORE_ERRORS.BAD_RECORD,
          `${kind} 必须带 reason。**丢弃也要写理由**：` +
          '一条教训消失的方式，与它被写下来的方式同样值得留痕',
        )
      }
      record.reason = String(input.reason).trim()
    }
  }
  return Object.freeze(record)
}

/** 一条记录投影出去要用的字段。 */
function projections(record) {
  return {
    draftId: record.draftId ?? null,
    edgeId: record.edgeId ?? null,
    nodeKey: record.nodeKind ? `${record.nodeKind}:${record.id}` : null,
    actor: record.by ?? record.source ?? null,
  }
}

/**
 * 追加一条记录。
 *
 * `seq` 由**一条 SQL** 算出（见文件头 ②）。
 */
export function appendExperienceRecord({ db, record, scope = 'default', nowMs = Date.now() } = {}) {
  if (db === null || typeof db?.prepare !== 'function') {
    throw fail(EXPERIENCE_STORE_ERRORS.WRITE_FAILED, 'appendExperienceRecord 需要一个打开的数据库', {}, 500)
  }
  const rec = normalizeExperienceRecord(record)
  const p = projections(rec)
  let seq
  try {
    const res = db.prepare(`
      INSERT INTO experience_records (
        scope, kind, draft_id, edge_id, node_key, at_ms, actor, record_json, recorded_at_ms
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
    `).run(
      scope, rec.kind, p.draftId, p.edgeId, p.nodeKey, rec.atMs, p.actor,
      JSON.stringify(rec), nowMs,
    )
    // ★ 必须用 `lastInsertRowid`，**不能**再 `SELECT MAX(seq)`。
    //
    //   这里踩过一次真实的坑：两个进程共用一个 SQLite 文件（8787 独立进程
    //   + 3080 宿主壳，见文件头 ②）。于是会发生
    //     A: INSERT  → seq=5
    //     B: INSERT  → seq=6
    //     A: SELECT MAX(seq) → **6**
    //   A 于是把 6 报成自己的 seq。调用方拿它做增量读（`sinceSeq`）时，
    //   第 5 条记录**永远读不到**——而账看起来完全正常，只是少一条。
    //
    //   `MAX(seq)` 在单进程测试里永远是对的，所以它只在生产上错。
    seq = Number(res.lastInsertRowid)
  } catch (err) {
    throw fail(EXPERIENCE_STORE_ERRORS.WRITE_FAILED,
      `写入经验记录失败：${err?.message ?? err}`, {}, 500)
  }
  return Object.freeze({ appended: true, seq, kind: rec.kind })
}

function rowToRecord(row) {
  let rec = null
  let readable = true
  try {
    rec = JSON.parse(row.record_json)
    if (!isPlainObject(rec)) readable = false
  } catch {
    // ★ 存进去的是我们自己序列化的，读不回来只可能是外部改写。
    //   这时**不猜**：把坏行当成"没有这条记录"，会让"这条边从没被记过"
    //   与"这行坏了"变成同一个读数——而前者是正常的、后者是要报警的。
    readable = false
  }
  return Object.freeze({
    seq: Number(row.seq),
    scope: row.scope,
    kind: row.kind,
    atMs: Number(row.at_ms),
    actor: row.actor ?? null,
    record: readable ? Object.freeze(rec) : null,
    readable,
  })
}

/** 读记录流。可按草稿 / 边 / 种类过滤，支持 `sinceSeq` 增量。 */
export function experienceRecords({
  db, scope = 'default', draftId = null, edgeId = null, kind = null, sinceSeq = 0, limit = null,
} = {}) {
  if (db === null || typeof db?.prepare !== 'function') {
    throw fail(EXPERIENCE_STORE_ERRORS.READ_FAILED, 'experienceRecords 需要一个打开的数据库', {}, 500)
  }
  if (kind !== null && !EXPERIENCE_KINDS.includes(kind)) {
    throw fail(EXPERIENCE_STORE_ERRORS.UNKNOWN_KIND, `未知的记录种类 ${JSON.stringify(kind)}`)
  }
  const where = ['scope = ?', 'seq > ?']
  const args = [scope, Number(sinceSeq) || 0]
  if (draftId !== null) { where.push('draft_id = ?'); args.push(draftId) }
  if (edgeId !== null) { where.push('edge_id = ?'); args.push(edgeId) }
  if (kind !== null) { where.push('kind = ?'); args.push(kind) }
  const cap = Number.isInteger(limit) && limit > 0 ? ` LIMIT ${limit}` : ''
  try {
    const rows = db.prepare(
      `SELECT * FROM experience_records WHERE ${where.join(' AND ')} ORDER BY seq ASC${cap}`,
    ).all(...args)
    return Object.freeze(rows.map(rowToRecord))
  } catch (err) {
    throw fail(EXPERIENCE_STORE_ERRORS.READ_FAILED, `读经验记录失败：${err?.message ?? err}`, {}, 500)
  }
}

/**
 * 从**记录流**推导一条草稿现在的状态。
 *
 * ★ 这是文件头 ③ 的那份推导，只写在这里一处。
 *   调用方要看状态就调它，不要自己去翻记录——自己翻的人会漏掉
 *   "先晋升后丢弃"这种组合，而那时两个终点的先后顺序就是全部的信息。
 */
export function deriveDraftState(records) {
  if (!Array.isArray(records)) {
    throw fail(EXPERIENCE_STORE_ERRORS.BAD_RECORD, 'deriveDraftState 需要一组记录')
  }
  const draft = records.find((r) => r.kind === 'draft')
  if (draft === undefined) {
    throw fail(
      EXPERIENCE_STORE_ERRORS.DRAFT_NOT_FOUND,
      '**没有** `draft` 记录。一条只有 promote/discard 的流说明这条草稿的来源丢了——' +
      '而"它当初是关于什么的"从此无从回答，所以这里报错而不是给一个空状态',
    )
  }
  // 终点的先后顺序是全部信息：取了第一个终点。
  const settled = records.find((r) => r.kind === 'promote' || r.kind === 'discard')
  if (settled === undefined) {
    return Object.freeze({ draftId: draft.record?.draftId ?? null, state: 'draft', by: null, reason: null, atMs: null })
  }
  return Object.freeze({
    draftId: draft.record?.draftId ?? null,
    state: settled.kind === 'promote' ? 'promoted' : 'discarded',
    by: settled.record?.by ?? null,
    reason: settled.record?.reason ?? null,
    atMs: settled.atMs,
  })
}

/**
 * 追加一条草稿处置记录。
 *
 * ★ 已经处置过的草稿**不许再次处置**（见执行面的同一条纪律：
 *   一次草稿只有一个终点）。这一层也要拦，因为它是**唯一**的写入口——
 *   只在执行面拦时，一个直接打 HTTP 的调用方可以绕过去。
 */
export function settleDraft({ db, scope = 'default', draftId, action, by, reason, atMs, nowMs = Date.now() } = {}) {
  if (action !== 'promote' && action !== 'discard') {
    throw fail(EXPERIENCE_STORE_ERRORS.BAD_RECORD, `action 只能是 promote 或 discard，收到 ${JSON.stringify(action)}`)
  }
  const history = experienceRecords({ db, scope, draftId })
  const state = deriveDraftState(history)
  if (state.state !== 'draft') {
    throw fail(
      EXPERIENCE_STORE_ERRORS.ALREADY_SETTLED,
      `草稿 ${draftId} 已经是 \`${state.state}\`（由 ${state.by} 于 ${state.atMs} 处置，理由 ${state.reason}）。` +
      '**一次草稿只有一个终点**：一个能被处置两次的草稿，' +
      '与一个"这条规则被两拨人分别加了两次"的系统，是同一个东西',
      {
        // ★ 现状用**一个具名字段**带出去，而不是把 `by`/`reason` 摊在顶层。
        //   顶层那两个名字太泛（它们在任何错误上都可能被解读成别的东西），
        //   而 `handleRun` 的错误出口是**白名单**式的（逐个字段判断，
        //   不展开整个 error 对象，避免把 stack 带出去）。一个具名字段
        //   只需要在白名单里占一行，且不会与别的路由的语义撞车。
        currentSettlement: state,
      },
      409,
    )
  }
  return appendExperienceRecord({
    db,
    scope,
    nowMs,
    record: { kind: action, draftId, by, reason, atMs: atMs ?? nowMs },
  })
}

/** 一版草稿的读数：还没人看的有几条。 */
export function draftCounts({ db, scope = 'default' } = {}) {
  try {
    const rows = db.prepare(
      'SELECT DISTINCT draft_id FROM experience_records WHERE scope = ? AND draft_id IS NOT NULL',
    ).all(scope)
    const by = { draft: 0, promoted: 0, discarded: 0, broken: 0 }
    for (const row of rows) {
      const history = experienceRecords({ db, scope, draftId: row.draft_id })
      if (history.some((r) => !r.readable)) { by.broken += 1; continue }
      try {
        by[deriveDraftState(history).state] += 1
      } catch {
        // 没有 draft 记录的流：**单独计数**，不并进"draft"。
        // 并进去会让"来源丢了的草稿"看起来像"一条还没人看的草稿"。
        by.broken += 1
      }
    }
    return Object.freeze({
      readable: true, total: rows.length, ...by,
      // ★ 积压率的分母是**能判定状态的那些**。分母为 0 时给 `null` 而不是 0
      //   ——0% 会被读成"流程很健康"。
      openRatio: (by.draft + by.promoted + by.discarded) === 0
        ? null
        : by.draft / (by.draft + by.promoted + by.discarded),
    })
  } catch (err) {
    // 读数失败时报 `readable:false` + null，**不是 0**：
    // 每个数字都要有一个"不知道"的邻居。
    return Object.freeze({
      readable: false, total: null, draft: null, promoted: null, discarded: null,
      broken: null, openRatio: null, reason: String(err?.message ?? err),
    })
  }
}

/** 从记录流重建一张图 / 一批草稿（重启之后控制面不必自己再推一遍）。 */
export function experienceAccount({ db, scope = 'default' } = {}) {
  const records = experienceRecords({ db, scope })
  const broken = records.filter((r) => !r.readable)
  return Object.freeze({
    format: EXPERIENCE_RECORD_VERSION,
    scope,
    records,
    // ★ 坏行**单独报**，不混进记录流里当作不存在（见 `rowToRecord`）。
    brokenCount: broken.length,
    counts: draftCounts({ db, scope }),
  })
}

/**
 * 导出成可提交进 Git 的文本。
 *
 * 与 F-20 的导出同一条理由：这份东西的用途是进 diff、被人审阅。
 * 字段是**白名单**——草稿正文可能引用任务细节，而进了 Git 历史就删不掉。
 */
export function exportExperience({ db, scope = 'default', exportedAtMs = Date.now(), pretty = true } = {}) {
  let records
  try {
    records = experienceRecords({ db, scope })
  } catch (err) {
    throw fail(EXPERIENCE_STORE_ERRORS.READ_FAILED, `导出前读记录失败：${err?.message ?? err}`, {}, 500)
  }
  const doc = {
    format: 'legion/experience-export@1',
    recordVersion: EXPERIENCE_RECORD_VERSION,
    scope,
    exportedAtMs,
    counts: draftCounts({ db, scope }),
    // 只出**白名单字段**：`payload`/`subject` 都可能带任务细节。
    records: records.map((r) => ({
      seq: r.seq,
      kind: r.kind,
      atMs: r.atMs,
      actor: r.actor,
      readable: r.readable,
      draftId: r.record?.draftId ?? null,
      edgeId: r.record?.edgeId ?? null,
      node: r.record?.nodeKind ? `${r.record.nodeKind}:${r.record.id}` : null,
      edge: r.record?.from ? `${r.record.from}->${r.record.to}(${r.record.edgeKind})` : null,
      reason: r.record?.reason ?? null,
    })),
  }
  return { text: JSON.stringify(doc, null, pretty ? 2 : 0), doc }
}
