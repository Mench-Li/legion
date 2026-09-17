// team-hub/compaction-store.mjs
// ============================================================================
// F-17 长会话压缩（MULTI-AGENT-FEATURE-OPTIMIZATION.md §4.3）
//
// spec 的要求是一句话，但它把三件事绑在一起：
//
//   > 长会话压缩：不可变原文 + 版本化摘要 + 引用回原文。
//
// ## 为什么必须是这三件一起，而不是"存一份摘要"
//
// 只说"压缩会话"时，最自然的实现是"把消息换成摘要"——而那是一个
// **不可逆**的动作：
//
//   > 一个"把长会话换成一段摘要"的实现，与一个"摘要里漏掉了后来证明是关键
//   > 的那一句、而原文已经没了"的系统，在压缩完成的那一刻是同一个东西——
//   > 只不过前者在"当前上下文长度"这一栏上看起来做对了事。
//
// 所以三件事各自的**失败方向**决定了它们必须同时存在：
//
//   · **原文不可变**（`compaction_messages` 只追加，无 UPDATE/DELETE）。
//     可改写时，"摘要说错了"这件事**无法被证伪**——你没有任何东西可以对。
//   · **摘要版本化**（`compaction_summaries` 每次压缩新增一行，`version` 只增）。
//     只留最新版时，一次"更差的摘要"会**盖掉**上一个好摘要，而没有任何
//     痕迹说明曾经有过一个更好的。改摘要=新增行，不是改行。
//   · **引用回原文**（每条摘要带 `covers_from_seq`/`covers_to_seq`，
//     且每个被引用的原文 seq **必须真的存在**）。
//     没有回引时，摘要是一段**无法复核**的文本——读者只能选择相信它。
//
// ## 与 `context-store.mjs` 的分工
//
// `context-store` 存的是**一次 Run 的上下文快照**（PRT-409，不可变 + 哈希）。
// 本模块存的是**一段会话的压缩产物**。两者不是一个东西：
//   · 快照是"这次运行开始时看到了什么"（一次性、按 attemptId 定位）；
//   · 压缩是"这段很长的历史现在用哪几段代表"（演进式、按 session 定位、
//     有版本、原文永久保留）。
// 合成一个会让"压缩把快照改了"变成可能——而快照的第一条纪律就是不可变。
//
// ## 一条刻意的"不做"
//
// 本模块**不调用任何模型**。`proposeSummary()` 接受一个**已经算好的**摘要文本，
// 只负责记账、版本与回引校验。理由：
//   · 决定"什么时候压、压多少"是产品策略（属于本模块）；
//   · 决定"这段文字怎么概括"是模型能力（属于执行面）。
// 把两者混在一起，会让一次"摘要没写好"表现为"压缩功能坏了"，
// 而修法完全不同。
// ============================================================================

import { ensureColumn } from './schema-util.mjs'

export const COMPACTION_ERRORS = Object.freeze({
  BAD_SESSION: 'COMPACTION_SESSION_REQUIRED',
  BAD_ACTOR: 'COMPACTION_ACTOR_REQUIRED',
  BAD_RANGE: 'COMPACTION_BAD_RANGE',
  BAD_SUMMARY: 'COMPACTION_SUMMARY_REQUIRED',
  /** 引用的原文 seq 在库里不存在。**这是内容完整性问题，不是参数问题。** */
  DANGLING_REFERENCE: 'COMPACTION_DANGLING_REFERENCE',
  SESSION_NOT_FOUND: 'COMPACTION_SESSION_NOT_FOUND',
  VERSION_NOT_FOUND: 'COMPACTION_VERSION_NOT_FOUND',
  VERSION_CONFLICT: 'COMPACTION_VERSION_CONFLICT',
  ALREADY_COMPACTED: 'COMPACTION_RANGE_ALREADY_COVERED',
})

/** 一条会话里的原文**只能处于两种状态**：active（还在上下文里）或 compacted（被摘要代表）。 */
export const MESSAGE_STATES = Object.freeze(['active', 'compacted'])

export const isMessageState = (s) => MESSAGE_STATES.includes(s)

/** 摘要的角色：给读的人判别"这一段是谁写的"。 */
export const SUMMARY_AUTHORS = Object.freeze(['model', 'human', 'imported'])

function fail(code, message, extra = {}, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode, ...extra })
}

export function ensureCompactionSchema(db) {
  // ── 不可变原文 ──────────────────────────────────────────────────────
  //
  // `state` 是唯一**允许变**的一列（`active → compacted`），而且是单向的：
  // 一条消息被摘要代表之后不再回到 active，因为"它又出现在上下文里了"
  // 与"它被摘要代表了"同时成立时，同一条消息会被算两次 token。
  //
  // 正文本身（`content`）永远不改。允许改写时，"摘要读起来不对"这件事
  // 无法被证伪——你没有任何东西可以对。
  db.exec(`
    CREATE TABLE IF NOT EXISTS compaction_messages (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tokens INTEGER,
      state TEXT NOT NULL DEFAULT 'active',
      covered_by_version INTEGER,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_compaction_messages_state ON compaction_messages(session_id, state)')

  // ── 版本化摘要 ──────────────────────────────────────────────────────
  //
  // `version` 从 1 起、只增不减。**同一 session 的 version 唯一**
  // （唯一索引）：两个并发的压缩各算一次 version 时会写出两行 version=2，
  // 而"哪一个是当时的 2"事后无法回答——`base_version` 是用来做 CAS 的，
  // 撞号会让 CAS 失效。
  db.exec(`
    CREATE TABLE IF NOT EXISTS compaction_summaries (
      session_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      covers_from_seq INTEGER NOT NULL,
      covers_to_seq INTEGER NOT NULL,
      summary TEXT NOT NULL,
      author TEXT NOT NULL,
      base_version INTEGER,
      message_tokens INTEGER,
      summary_tokens INTEGER,
      created_by TEXT,
      reason TEXT,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (session_id, version)
    )
  `)
  ensureColumn(db, 'compaction_summaries', 'message_tokens', 'INTEGER')
  ensureColumn(db, 'compaction_summaries', 'summary_tokens', 'INTEGER')
  ensureColumn(db, 'compaction_summaries', 'base_version', 'INTEGER')
}

/**
 * 把一段文本粗估成 token 数。
 *
 * **刻意是一个保守的估计而不是精确分词器**：这个数字只有一个用途——
 * "压缩之后上下文短了多少"。为它接一个真 tokenizer 会让本模块依赖
 * 执行面（而它的纪律是"不调用任何模型"）。
 *
 * 估计规则：ASCII 每 4 字符 1 token（OpenAI 系的经验值），非 ASCII
 * 每字符 1 token（中文按字算比按字节算接近真实值）。宁高不低——
 * 低估会让"压缩后仍然超限"变成惊喜。
 */
export function estimateTokens(text) {
  if (typeof text !== 'string') return 0
  let ascii = 0
  let wide = 0
  for (const ch of text) {
    if (ch.codePointAt(0) < 128) ascii += 1
    else wide += 1
  }
  return Math.ceil(ascii / 4) + wide
}

export function createCompactionStore({ db, clock = () => Date.now() } = {}) {
  if (typeof clock !== 'function') throw new TypeError('createCompactionStore 需要 clock')

  const withTx = (fn) => {
    if (db.isTransaction === true) return fn()
    db.exec('BEGIN IMMEDIATE')
    try { const r = fn(); db.exec('COMMIT'); return r } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 事务已经没了 */ }
      throw e
    }
  }

  const shapeMessage = (r) => Object.freeze({
    sessionId: r.session_id,
    seq: Number(r.seq),
    role: r.role,
    content: r.content,
    tokens: r.tokens === null || r.tokens === undefined ? null : Number(r.tokens),
    state: r.state,
    coveredByVersion: r.covered_by_version === null || r.covered_by_version === undefined
      ? null : Number(r.covered_by_version),
    createdAtMs: Number(r.created_at_ms),
  })

  const shapeSummary = (r) => Object.freeze({
    sessionId: r.session_id,
    version: Number(r.version),
    coversFromSeq: Number(r.covers_from_seq),
    coversToSeq: Number(r.covers_to_seq),
    summary: r.summary,
    author: r.author,
    baseVersion: r.base_version === null || r.base_version === undefined ? null : Number(r.base_version),
    messageTokens: r.message_tokens === null || r.message_tokens === undefined ? null : Number(r.message_tokens),
    summaryTokens: r.summary_tokens === null || r.summary_tokens === undefined ? null : Number(r.summary_tokens),
    createdBy: r.created_by ?? null,
    reason: r.reason ?? null,
    createdAtMs: Number(r.created_at_ms),
  })

  /**
   * 追加一条**原文**。
   *
   * `seq` 由调用方给（会话自己的序号），并且**重复 seq 被拒绝**而不是覆盖：
   * 覆盖会让"第 7 条消息"有两个可能的内容，而摘要里的回引
   * （`covers_from_seq: 5, covers_to_seq: 9`）会指向**不确定**的东西。
   */
  function appendMessage({ sessionId, seq, role, content, nowMs = null }) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') throw fail(COMPACTION_ERRORS.BAD_SESSION, '需要 sessionId')
    if (!Number.isSafeInteger(seq) || seq < 0) throw fail(COMPACTION_ERRORS.BAD_RANGE, `seq 必须是非负安全整数（收到 ${JSON.stringify(seq)}）`)
    if (typeof role !== 'string' || role.trim() === '') throw fail(COMPACTION_ERRORS.BAD_RANGE, '需要 role')
    if (typeof content !== 'string') throw fail(COMPACTION_ERRORS.BAD_RANGE, 'content 必须是字符串')
    const at = nowMs ?? clock()
    return withTx(() => {
      const existing = db.prepare('SELECT seq FROM compaction_messages WHERE session_id = ? AND seq = ?').get(sessionId, seq)
      if (existing !== undefined) {
        throw fail(COMPACTION_ERRORS.ALREADY_COMPACTED,
          `会话 ${sessionId} 的第 ${seq} 条已经存在。**不覆盖**：覆盖会让"第 ${seq} 条"有两个可能的内容，`
          + '而摘要里的回引会指向不确定的东西', {}, 409)
      }
      db.prepare(
        `INSERT INTO compaction_messages (session_id, seq, role, content, tokens, state, covered_by_version, created_at_ms)
         VALUES (?,?,?,?,?,'active',NULL,?)`,
      ).run(sessionId, seq, role, content, estimateTokens(content), at)
      return shapeMessage(db.prepare('SELECT * FROM compaction_messages WHERE session_id = ? AND seq = ?').get(sessionId, seq))
    })
  }

  function messagesOf(sessionId, { state = null, limit = 5000 } = {}) {
    if (state !== null && !isMessageState(state)) {
      throw fail(COMPACTION_ERRORS.BAD_RANGE, `不认识的 state：${JSON.stringify(state)}，可选 ${MESSAGE_STATES.join(' / ')}`)
    }
    const sql = state === null
      ? 'SELECT * FROM compaction_messages WHERE session_id = ? ORDER BY seq ASC LIMIT ?'
      : 'SELECT * FROM compaction_messages WHERE session_id = ? AND state = ? ORDER BY seq ASC LIMIT ?'
    const rows = state === null
      ? db.prepare(sql).all(sessionId, limit)
      : db.prepare(sql).all(sessionId, state, limit)
    return Object.freeze(rows.map(shapeMessage))
  }

  function messageOf(sessionId, seq) {
    const r = db.prepare('SELECT * FROM compaction_messages WHERE session_id = ? AND seq = ?').get(sessionId, seq)
    return r === undefined ? null : shapeMessage(r)
  }

  function summariesOf(sessionId) {
    return Object.freeze(db.prepare('SELECT * FROM compaction_summaries WHERE session_id = ? ORDER BY version ASC')
      .all(sessionId).map(shapeSummary))
  }

  function latestSummaryOf(sessionId) {
    const r = db.prepare('SELECT * FROM compaction_summaries WHERE session_id = ? ORDER BY version DESC LIMIT 1').get(sessionId)
    return r === undefined ? null : shapeSummary(r)
  }

  function summaryAt(sessionId, version) {
    const r = db.prepare('SELECT * FROM compaction_summaries WHERE session_id = ? AND version = ?').get(sessionId, version)
    return r === undefined ? null : shapeSummary(r)
  }

  /**
   * 写入一版**摘要**。这是本模块的核心写入口。
   *
   * 五条纪律，每一条对应一个具体的失效：
   *
   *   ① **`baseVersion` 是 CAS**。给 `null` 表示"我认为还没有任何摘要"。
   *      两个并发的压缩各写一版时，后到的那个会看到 `VERSION_CONFLICT`
   *      而不是静默产生第二份"版本 1"。
   *   ② **区间必须落在真实存在的原文上**。`DANGLING_REFERENCE` 是一个
   *      **内容完整性**问题，不是参数问题——它说的是"库里没有这段东西"，
   *      而读的人会因此以为摘要代表了一段并不存在的历史。
   *   ③ **区间不许重叠上一次**。重叠时同一条消息被两版摘要代表，
   *      拼上下文的人会**把它算两次**（或多算一次 token）。
   *   ④ **`author` 在封闭词表里**。自由文本会让"这段摘要是谁写的"
   *      退化成一句备注，而它决定了要不要人工复核。
   *   ⑤ **原文的被覆盖标记是单向的**（`active → compacted`），且在
   *      同一个事务里完成。分两步时，崩在中间会留下"摘要说覆盖了 1..9、
   *      而 1..9 还是 active"——两者不一致，而没有任何东西会去修它。
   */
  function proposeSummary({
    sessionId, coversFromSeq, coversToSeq, summary, author = 'model',
    baseVersion = null, createdBy = null, reason = null, nowMs = null,
  }) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') throw fail(COMPACTION_ERRORS.BAD_SESSION, '需要 sessionId')
    if (typeof summary !== 'string' || summary.trim() === '') {
      throw fail(COMPACTION_ERRORS.BAD_SUMMARY, '摘要正文不能为空')
    }
    if (typeof createdBy !== 'string' || createdBy.trim() === '') {
      // 压缩会**减少**后续可见的信息量，因此它必须能定位到人（或到那个
      // 自动环节的名字）。没有主体的压缩是一次无法复核的信息删除。
      throw fail(COMPACTION_ERRORS.BAD_ACTOR, '压缩必须记录 createdBy —— 它会减少后续可见的信息量，必须能定位到主体')
    }
    if (!SUMMARY_AUTHORS.includes(author)) {
      throw fail(COMPACTION_ERRORS.BAD_SUMMARY,
        `不认识的 author：${JSON.stringify(author)}，可选 ${SUMMARY_AUTHORS.join(' / ')}。`
        + '自由文本会让"这段摘要是谁写的"退化成一句备注，而它决定了要不要人工复核')
    }
    if (!Number.isSafeInteger(coversFromSeq) || !Number.isSafeInteger(coversToSeq) || coversToSeq < coversFromSeq) {
      throw fail(COMPACTION_ERRORS.BAD_RANGE,
        `压缩区间不合法：[${coversFromSeq}, ${coversToSeq}]（必须都是安全整数且 to >= from）`)
    }
    const at = nowMs ?? clock()
    return withTx(() => {
      const total = db.prepare('SELECT COUNT(*) AS n FROM compaction_messages WHERE session_id = ?').get(sessionId).n
      if (Number(total) === 0) {
        throw fail(COMPACTION_ERRORS.SESSION_NOT_FOUND, `会话 ${sessionId} 没有任何原文`, {}, 404)
      }
      // ① CAS：baseVersion 必须与当前最新版**完全一致**。
      const latest = latestSummaryOf(sessionId)
      const currentVersion = latest === null ? null : latest.version
      if (baseVersion !== currentVersion) {
        throw fail(COMPACTION_ERRORS.VERSION_CONFLICT,
          `baseVersion 不符：请求 ${JSON.stringify(baseVersion)}，当前最新 ${JSON.stringify(currentVersion)}。`
          + '这是并发压缩的判据——不检查时两个进程会各写一份"版本 1"', {}, 409)
      }
      // ② 回引必须落在真实存在的原文上。
      const picked = db.prepare(
        'SELECT seq FROM compaction_messages WHERE session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq',
      ).all(sessionId, coversFromSeq, coversToSeq)
      if (picked.length !== coversToSeq - coversFromSeq + 1) {
        const have = new Set(picked.map((r) => Number(r.seq)))
        const missing = []
        for (let s = coversFromSeq; s <= coversToSeq; s += 1) if (!have.has(s)) missing.push(s)
        throw fail(COMPACTION_ERRORS.DANGLING_REFERENCE,
          `摘要引用的原文不存在：缺 seq ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''}。`
          + '这是**内容完整性**问题而不是参数问题——读的人会因此以为摘要代表了一段并不存在的历史',
          { missing }, 409)
      }
      // ③ 不许与上一版重叠。
      if (latest !== null && coversFromSeq <= latest.coversToSeq) {
        throw fail(COMPACTION_ERRORS.ALREADY_COMPACTED,
          `区间 [${coversFromSeq}, ${coversToSeq}] 与版本 ${latest.version} 的 `
          + `[${latest.coversFromSeq}, ${latest.coversToSeq}] 重叠。`
          + '重叠时同一条消息被两版摘要代表，拼上下文的人会把它算两次', {}, 409)
      }
      const version = (latest === null ? 0 : latest.version) + 1
      const msgTokens = db.prepare(
        'SELECT COALESCE(SUM(tokens),0) AS n FROM compaction_messages WHERE session_id = ? AND seq BETWEEN ? AND ?',
      ).get(sessionId, coversFromSeq, coversToSeq).n
      const sumTokens = estimateTokens(summary)
      db.prepare(
        `INSERT INTO compaction_summaries
           (session_id, version, covers_from_seq, covers_to_seq, summary, author, base_version,
            message_tokens, summary_tokens, created_by, reason, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(sessionId, version, coversFromSeq, coversToSeq, summary, author, baseVersion,
        Number(msgTokens), sumTokens, createdBy, reason, at)
      // ⑤ 标记被覆盖的原文（单向）。
      db.prepare(
        `UPDATE compaction_messages SET state = 'compacted', covered_by_version = ?
          WHERE session_id = ? AND seq BETWEEN ? AND ? AND state = 'active'`,
      ).run(version, sessionId, coversFromSeq, coversToSeq)
      return Object.freeze({
        ok: true,
        summary: summaryAt(sessionId, version),
        // 「压掉了多少」是两个数一起给的读数，不是一个比率：
        // 比率为 0.9 时，你无法判断是"压了 10 倍"还是"几乎没压"。
        messageTokens: Number(msgTokens),
        summaryTokens: sumTokens,
        savedTokens: Number(msgTokens) - sumTokens,
        coveredCount: picked.length,
        serverTimeMs: at,
      })
    })
  }

  /**
   * 「现在该给模型看什么」——把 active 原文与所有摘要**按时间拼回去**。
   *
   * 顺序是：摘要（按 version 升序）→ 剩余 active 原文（按 seq 升序）。
   * 这个顺序有一个前提：**被压缩的一定是较早的一段**（否则摘要会出现在
   * 它代表的内容之后，读起来像一段预言）。这里断言这条前提，
   * 因为违反它时输出**仍然是一段合法文本**，只是语义错乱——
   * 而那正是最难发现的一类。
   */
  function effectiveContext(sessionId, { maxTokens = null } = {}) {
    const sums = summariesOf(sessionId)
    const msgs = messagesOf(sessionId, { state: 'active' })
    const firstActive = msgs.length === 0 ? null : msgs[0].seq
    if (firstActive !== null && sums.length > 0) {
      const maxCovered = sums[sums.length - 1].coversToSeq
      if (firstActive <= maxCovered) {
        // 这是内部不一致（被摘要覆盖的原文不该还是 active）。报出来，
        // 不"顺手修一下"——那会掩盖掉产生它那次写入的缺陷。
        throw fail(COMPACTION_ERRORS.ALREADY_COMPACTED,
          `会话 ${sessionId} 的原文 seq=${firstActive} 既是 active 又被版本覆盖到 ${maxCovered}：`
          + '库内不一致。不自动修复——那会掩盖产生它的那次写入缺陷', {}, 500)
      }
    }
    const parts = [
      ...sums.map((s) => ({ kind: 'summary', version: s.version, tokens: s.summaryTokens ?? estimateTokens(s.summary), text: s.summary, coversFromSeq: s.coversFromSeq, coversToSeq: s.coversToSeq })),
      ...msgs.map((m) => ({ kind: 'message', seq: m.seq, role: m.role, tokens: m.tokens ?? estimateTokens(m.content), text: m.content })),
    ]
    const totalTokens = parts.reduce((a, p) => a + p.tokens, 0)
    if (maxTokens === null) {
      return Object.freeze({ parts: Object.freeze(parts), totalTokens, truncated: false, isPartial: false })
    }
    // 超限时**从最老的原文开始丢**，但摘要永不丢：丢掉摘要等于把"曾经
    // 压缩过一次"这件事忘掉，于是下一轮会把那些原文重新当成 active。
    const kept = []
    let used = 0
    for (const p of parts) {
      if (p.kind === 'summary') { kept.push(p); used += p.tokens; continue }
      if (used + p.tokens > maxTokens) break
      kept.push(p); used += p.tokens
    }
    const truncated = kept.length < parts.length
    return Object.freeze({
      parts: Object.freeze(kept),
      totalTokens: used,
      truncated,
      // 「被截断了」与「刚好用完」必须能分开：只给 totalTokens 时，
      // 一个正好等于上限的读数会被读成"装得下"。
      isPartial: truncated,
    })
  }

  /** 诊断读数："这条会话现在压缩到什么程度"。 */
  function compactionState(sessionId) {
    const at = clock()
    const rows = db.prepare(
      'SELECT state, COUNT(*) AS n, COALESCE(SUM(tokens),0) AS t FROM compaction_messages WHERE session_id = ? GROUP BY state',
    ).all(sessionId)
    const byState = { active: { count: 0, tokens: 0 }, compacted: { count: 0, tokens: 0 } }
    const unrecognizedStates = []
    for (const r of rows) {
      if (Object.prototype.hasOwnProperty.call(byState, r.state)) {
        byState[r.state] = { count: Number(r.n), tokens: Number(r.t) }
      } else {
        // 未登记状态照样报出来（与 run-store / event-delivery 同一纪律）。
        byState[r.state] = { count: Number(r.n), tokens: Number(r.t) }
        unrecognizedStates.push(r.state)
      }
    }
    const sums = summariesOf(sessionId)
    const summaryTokens = sums.reduce((a, s) => a + (s.summaryTokens ?? 0), 0)
    return Object.freeze({
      sessionId,
      byState: Object.freeze(byState),
      unrecognizedStates: Object.freeze(unrecognizedStates),
      versions: sums.length,
      latestVersion: sums.length === 0 ? null : sums[sums.length - 1].version,
      /** 原文全部 token（压缩前会占多少）。 */
      rawTokens: byState.active.tokens + byState.compacted.tokens,
      /** 摘要 token 之和（压缩后那些原文变成的东西）。 */
      summaryTokens,
      /** 压缩节省的净 token。负数是正常的（摘要比原文还长）。 */
      savedTokens: byState.compacted.tokens - summaryTokens,
      // 「有未登记状态」与「一切都好」必须能分开（同 event-delivery 的 settled）。
      settled: unrecognizedStates.length === 0,
      serverTimeMs: at,
    })
  }

  return Object.freeze({
    appendMessage, messagesOf, messageOf,
    proposeSummary, summariesOf, latestSummaryOf, summaryAt,
    effectiveContext, compactionState,
    withTx,
  })
}
