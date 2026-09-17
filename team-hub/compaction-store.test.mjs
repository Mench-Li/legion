// team-hub/compaction-store.test.mjs
// ============================================================================
// F-17 长会话压缩的判据：**不可变原文 + 版本化摘要 + 引用回原文**。
//
// 三件事各自对应一个不可逆的失效方向，所以它们是分开验的：
//
//   ① **原文不可变** —— 若可改写，"摘要读起来不对"这件事**无法被证伪**
//      （你没有任何东西可以对）。所以：重复 seq 拒绝、源码里没有
//      `UPDATE compaction_messages SET content`、也没有 DELETE。
//   ② **摘要版本化** —— 若只留最新版，一次更差的摘要会**盖掉**上一个
//      好摘要，而没有任何痕迹说明曾经有过更好的。所以：改摘要=新增行。
//   ③ **引用回原文** —— 若没有回引，摘要是一段**无法复核**的文本。
//      所以：引用的 seq 必须真的存在（`DANGLING_REFERENCE` 是内容完整性
//      问题，不是参数问题）。
//
// 另外四条判据各自钉住一个具体的坏读数：
//   · `baseVersion` CAS —— 不检查时两个进程会各写一份"版本 1"；
//   · 区间不许重叠 —— 重叠时同一条消息被两版摘要代表，会被算两次；
//   · `effectiveContext` 的顺序前提 —— 违反时输出的仍是合法文本，只是语义错乱；
//   · `truncated` 与 `isPartial` —— 只给 totalTokens 时，"装得下"与
//     "刚好被截断在上限"是同一个读数。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COMPACTION_ERRORS,
  SUMMARY_AUTHORS,
  createCompactionStore,
  ensureCompactionSchema,
  estimateTokens,
} from './compaction-store.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function makeEnv() {
  const db = new DatabaseSync(':memory:')
  ensureCompactionSchema(db)
  const store = createCompactionStore({ db, clock: () => 1_800_000_000_000 })
  const seed = (sessionId, n, text = null) => {
    for (let i = 1; i <= n; i += 1) {
      store.appendMessage({ sessionId, seq: i, role: i % 2 === 1 ? 'user' : 'assistant', content: text ?? `第 ${i} 条消息的内容` })
    }
  }
  return { db, store, seed, dispose: () => { try { db.close() } catch { /* 已关 */ } } }
}

const S = 'sess-1'

// ---------------------------------------------------------------- ① 原文不可变

test('① 原文只追加：重复 seq 被拒（覆盖会让"第 N 条"有两个可能的内容）', () => {
  const env = makeEnv()
  try {
    env.store.appendMessage({ sessionId: S, seq: 1, role: 'user', content: '原始内容' })
    assert.throws(
      () => env.store.appendMessage({ sessionId: S, seq: 1, role: 'user', content: '改过的内容' }),
      (e) => e.statusCode === 409,
      '重复 seq 被接受了 —— 覆盖会让摘要里的回引指向不确定的东西',
    )
    assert.equal(env.store.messageOf(S, 1).content, '原始内容')
    assert.throws(() => env.store.appendMessage({ sessionId: S, seq: -1, role: 'user', content: 'x' }),
      (e) => e.code === COMPACTION_ERRORS.BAD_RANGE)
    assert.throws(() => env.store.appendMessage({ sessionId: '', seq: 1, role: 'user', content: 'x' }),
      (e) => e.code === COMPACTION_ERRORS.BAD_SESSION)
  } finally { env.dispose() }
})

test('② 原文内容列**永远不被改写**：源码里只有 state 的 UPDATE，没有 content 的', () => {
  const src = readFileSync(join(HERE, 'compaction-store.mjs'), 'utf8')
  // 唯一允许的 UPDATE 是 `SET state = 'compacted', covered_by_version = ?`。
  const updates = [...src.matchAll(/UPDATE\s+compaction_messages\s+SET([^`]*)/gi)].map((m) => m[1])
  assert.equal(updates.length, 1, `compaction_messages 有 ${updates.length} 处 UPDATE，只应有 1 处`)
  assert.match(updates[0], /state\s*=\s*'compacted'/)
  assert.equal(/content\s*=/.test(updates[0]), false,
    'UPDATE 里出现了 content —— 原文可改写时，"摘要读起来不对"这件事无法被证伪')
  // 只追加：没有任何 DELETE 路径。
  assert.equal(/DELETE\s+FROM\s+compaction_messages/i.test(src), false, '出现了 DELETE 原文的路径')
  assert.equal(/DELETE\s+FROM\s+compaction_summaries/i.test(src), false,
    '出现了 DELETE 摘要的路径 —— 删掉旧版本会让"曾经有过一个更好的摘要"没有痕迹')
})

test('③ 覆盖标记是**单向**的：compacted 不会回到 active', () => {
  const env = makeEnv()
  try {
    env.seed(S, 5)
    env.store.proposeSummary({ sessionId: S, coversFromSeq: 1, coversToSeq: 3, summary: '前三条的摘要', createdBy: 'auto' })
    assert.equal(env.store.messagesOf(S, { state: 'compacted' }).length, 3)
    assert.equal(env.store.messagesOf(S, { state: 'active' }).length, 2)
    // 没有回到 active 的路径：`proposeSummary` 是唯一写 state 的地方，
    // 而它只会把 active 写成 compacted。
    //
    // ★ 判据必须只取 **SET 到 WHERE 之间**的赋值列表。
    //   写成 `/state = 'active'/` 会匹配到 `... AND state = 'active'` 这个
    //   **WHERE 谓词**——它是"只覆盖那些还没被覆盖的"这道读屏障，正是
    //   "不许回到 active"的另一半，却被当成违规。一条会对着正确代码报警的
    //   守卫，与一条不存在的守卫，在被人手动关掉之后是同一个东西。
    const setClausesOf = (sql) => [...sql.matchAll(/UPDATE\s+\w+\s+SET\s+([\s\S]*?)(?=\sWHERE|`|$)/gi)].map((m) => m[1])
    const src = readFileSync(join(HERE, 'compaction-store.mjs'), 'utf8')
    const backToActive = setClausesOf(src).filter((s) => /state\s*=\s*'active'/.test(s))
    assert.deepEqual(backToActive, [], '存在把原文写回 active 的 SET 路径')
    // 反向对照：守卫真的会抓到违规写法（否则它是个恒过的空断言）。
    assert.equal(setClausesOf("UPDATE compaction_messages SET state = 'active' WHERE 1").length, 1)
    assert.equal(/state\s*=\s*'active'/.test(setClausesOf("UPDATE compaction_messages SET state = 'active' WHERE 1")[0]), true)

    // 另一条同样重要：允许的那一处 SET **必须**带 `AND state = 'active'` 读屏障
    // ——没有它，一次重复覆盖会把已经归属版本 1 的原文改挂到版本 2 上，
    // 而版本 1 的 `covers_from_seq/to_seq` 仍然声称覆盖它们。
    const allowed = setClausesOf(src).filter((s) => /state\s*=\s*'compacted'/.test(s))
    assert.equal(allowed.length, 1)
    assert.match(src, /SET state = 'compacted', covered_by_version = \?[\s\S]{0,120}AND state = 'active'/)
  } finally { env.dispose() }
})

// ---------------------------------------------------------------- ② 版本化摘要

test('④ 摘要只增不改：改摘要 = 新增一行，旧版永久可读', () => {
  const env = makeEnv()
  try {
    env.seed(S, 9)
    const v1 = env.store.proposeSummary({ sessionId: S, coversFromSeq: 1, coversToSeq: 3, summary: '第一次的摘要', createdBy: 'auto' })
    const v2 = env.store.proposeSummary({
      sessionId: S, coversFromSeq: 4, coversToSeq: 6, summary: '第二次的、更好的摘要',
      baseVersion: 1, createdBy: 'auto',
    })
    assert.equal(v1.summary.version, 1)
    assert.equal(v2.summary.version, 2)
    const all = env.store.summariesOf(S)
    assert.equal(all.length, 2, '旧版被覆盖了 —— 一次更差的摘要会盖掉上一个好摘要，而没有任何痕迹')
    assert.equal(all[0].summary, '第一次的摘要')
    assert.equal(all[1].summary, '第二次的、更好的摘要')
    // 按版本取回旧版仍然可行。
    assert.equal(env.store.summaryAt(S, 1).summary, '第一次的摘要')
    assert.equal(env.store.latestSummaryOf(S).version, 2)
    assert.equal(env.store.summaryAt(S, 99), null)
  } finally { env.dispose() }
})

test('⑤ ★ baseVersion 是 CAS：并发压缩不许各写一份"版本 1"', () => {
  const env = makeEnv()
  try {
    env.seed(S, 9)
    env.store.proposeSummary({ sessionId: S, coversFromSeq: 1, coversToSeq: 3, summary: 'A', createdBy: 'auto' })
    // 第二个压缩还拿着"我认为还没有任何摘要"的观点。
    assert.throws(
      () => env.store.proposeSummary({ sessionId: S, coversFromSeq: 4, coversToSeq: 6, summary: 'B', baseVersion: null, createdBy: 'auto' }),
      (e) => e.code === COMPACTION_ERRORS.VERSION_CONFLICT,
      '两个并发压缩各写了一份"版本 1" —— 而"哪一个是当时的 1"事后无法回答',
    )
    // 反向对照：带上正确的 baseVersion 就能过。
    const ok = env.store.proposeSummary({ sessionId: S, coversFromSeq: 4, coversToSeq: 6, summary: 'B', baseVersion: 1, createdBy: 'auto' })
    assert.equal(ok.summary.version, 2)
    // 没有摘要时 baseVersion: null 是**正确**的（不是"必须给一个数"）。
    const env2 = makeEnv()
    try {
      env2.seed(S, 3)
      const first = env2.store.proposeSummary({ sessionId: S, coversFromSeq: 1, coversToSeq: 3, summary: 'X', baseVersion: null, createdBy: 'auto' })
      assert.equal(first.summary.version, 1)
    } finally { env2.dispose() }
  } finally { env.dispose() }
})

// ---------------------------------------------------------------- ③ 引用回原文

test('⑥ ★ 引用回原文：引用了不存在的 seq 必须被拒（内容完整性，不是参数问题）', () => {
  const env = makeEnv()
  try {
    env.seed(S, 5)
    // 区间超出了已有的原文。
    const e = assert.throws(
      () => env.store.proposeSummary({ sessionId: S, coversFromSeq: 3, coversToSeq: 9, summary: 'x', createdBy: 'auto' }),
      (err) => err.code === COMPACTION_ERRORS.DANGLING_REFERENCE,
    )
    void e
    // 中间挖洞：删掉一条再引用跨过它的区间。
    env.db.prepare('DELETE FROM compaction_messages WHERE session_id = ? AND seq = 4').run(S)
    assert.throws(
      () => env.store.proposeSummary({ sessionId: S, coversFromSeq: 3, coversToSeq: 5, summary: 'x', createdBy: 'auto' }),
      (err) => err.code === COMPACTION_ERRORS.DANGLING_REFERENCE && err.missing.includes(4),
      '引用了不存在的原文 seq=4 —— 读的人会以为摘要代表了一段并不存在的历史',
    )
  } finally { env.dispose() }
})

test('⑦ 区间不许与上一版重叠（重叠会让同一条消息被算两次）', () => {
  const env = makeEnv()
  try {
    env.seed(S, 9)
    env.store.proposeSummary({ sessionId: S, coversFromSeq: 1, coversToSeq: 4, summary: 'A', createdBy: 'auto' })
    assert.throws(
      () => env.store.proposeSummary({ sessionId: S, coversFromSeq: 4, coversToSeq: 6, summary: 'B', baseVersion: 1, createdBy: 'auto' }),
      (err) => err.code === COMPACTION_ERRORS.ALREADY_COMPACTED,
      'seq=4 被两版摘要同时覆盖 —— 拼上下文时会把它算两次',
    )
    // 相邻但不重叠是允许的。
    const ok = env.store.proposeSummary({ sessionId: S, coversFromSeq: 5, coversToSeq: 6, summary: 'B', baseVersion: 1, createdBy: 'auto' })
    assert.equal(ok.summary.version, 2)
  } finally { env.dispose() }
})

test('⑧ author 在封闭词表里；createdBy 必填（压缩必须能定位到主体）', () => {
  const env = makeEnv()
  try {
    env.seed(S, 3)
    for (const a of SUMMARY_AUTHORS) {
      const env2 = makeEnv()
      try {
        env2.seed(S, 3)
        assert.equal(env2.store.proposeSummary({ sessionId: S, coversFromSeq: 1, coversToSeq: 1, summary: 'x', author: a, createdBy: 'auto' }).summary.author, a)
      } finally { env2.dispose() }
    }
    assert.throws(
      () => env.store.proposeSummary({ sessionId: S, coversFromSeq: 1, coversToSeq: 1, summary: 'x', author: '自动的', createdBy: 'auto' }),
      (e) => e.code === COMPACTION_ERRORS.BAD_SUMMARY,
    )
    assert.throws(
      () => env.store.proposeSummary({ sessionId: S, coversFromSeq: 1, coversToSeq: 1, summary: 'x' }),
      (e) => e.code === COMPACTION_ERRORS.BAD_ACTOR,
      '压缩会减少后续可见的信息量，必须能定位到主体',
    )
    assert.throws(
      () => env.store.proposeSummary({ sessionId: S, coversFromSeq: 1, coversToSeq: 1, summary: '   ', createdBy: 'auto' }),
      (e) => e.code === COMPACTION_ERRORS.BAD_SUMMARY,
    )
    assert.throws(
      () => env.store.proposeSummary({ sessionId: S, coversFromSeq: 3, coversToSeq: 1, summary: 'x', createdBy: 'auto' }),
      (e) => e.code === COMPACTION_ERRORS.BAD_RANGE,
    )
    assert.throws(
      () => env.store.proposeSummary({ sessionId: 'nope', coversFromSeq: 1, coversToSeq: 1, summary: 'x', createdBy: 'auto' }),
      (e) => e.code === COMPACTION_ERRORS.SESSION_NOT_FOUND,
    )
  } finally { env.dispose() }
})

// ---------------------------------------------------------------- ④ 有效上下文

test('⑨ effectiveContext：摘要在前、剩余原文在后，且被覆盖的原文不再出现', () => {
  const env = makeEnv()
  try {
    env.seed(S, 6)
    env.store.proposeSummary({ sessionId: S, coversFromSeq: 1, coversToSeq: 3, summary: '前三条的摘要', createdBy: 'auto' })
    const ctx = env.store.effectiveContext(S)
    assert.equal(ctx.parts.length, 4, `应有 1 摘要 + 3 原文，实际 ${ctx.parts.length}`)
    assert.equal(ctx.parts[0].kind, 'summary')
    assert.deepEqual([ctx.parts[0].coversFromSeq, ctx.parts[0].coversToSeq], [1, 3])
    assert.deepEqual(ctx.parts.slice(1).map((p) => p.seq), [4, 5, 6],
      '被压缩掉的 1..3 又出现在了上下文里 —— 那会被算两次 token')
    assert.equal(ctx.truncated, false)
    assert.equal(ctx.isPartial, false)
    // token 合计必须等于各部分之和（不给一个"算出来但解释不了"的数）。
    assert.equal(ctx.totalTokens, ctx.parts.reduce((a, p) => a + p.tokens, 0))
  } finally { env.dispose() }
})

test('⑩ ★ 超限时从最老的原文开始丢，**摘要永不丢**，且 truncated 与"刚好装下"分得开', () => {
  const env = makeEnv()
  try {
    env.seed(S, 4, '这是一条比较长的消息内容用来撑 token 数')
    env.store.proposeSummary({ sessionId: S, coversFromSeq: 1, coversToSeq: 1, summary: '第一条的摘要', createdBy: 'auto' })
    const full = env.store.effectiveContext(S)
    const tight = Math.max(1, full.totalTokens - 5)
    const cut = env.store.effectiveContext(S, { maxTokens: tight })
    assert.equal(cut.truncated, true)
    assert.equal(cut.isPartial, true,
      '被截断了但 isPartial 是 false —— 只给 totalTokens 时，"装得下"与'
      + '"刚好被截断在上限"是同一个读数')
    assert.ok(cut.parts.some((p) => p.kind === 'summary'),
      '摘要被丢掉了 —— 丢掉摘要等于把"曾经压缩过一次"忘掉，下一轮会把那些原文重新当成 active')
    assert.ok(cut.totalTokens <= tight)
    // 反向对照：上限给足时不截断。
    const roomy = env.store.effectiveContext(S, { maxTokens: full.totalTokens })
    assert.equal(roomy.truncated, false)
    assert.equal(roomy.isPartial, false)
  } finally { env.dispose() }
})

test('⑪ ★ 库内不一致（原文既 active 又被覆盖）**抛错而不是顺手修**', () => {
  const env = makeEnv()
  try {
    env.seed(S, 3)
    env.store.proposeSummary({ sessionId: S, coversFromSeq: 1, coversToSeq: 2, summary: 'x', createdBy: 'auto' })
    // 人为造出不一致（模拟一次别的写入留下的坏状态）。
    env.db.prepare("UPDATE compaction_messages SET state = 'active' WHERE session_id = ? AND seq = 1").run(S)
    assert.throws(() => env.store.effectiveContext(S),
      (e) => e.statusCode === 500,
      '不一致被静默修复了 —— 那会掩盖产生它的那次写入缺陷，于是它会再发生一次')
  } finally { env.dispose() }
})

// ---------------------------------------------------------------- ⑤ 读数

test('⑫ compactionState：节省 token 可正可负；未登记状态吃进来并使 settled 为假', () => {
  const env = makeEnv()
  try {
    env.seed(S, 9)
    assert.equal(env.store.compactionState(S).versions, 0)
    assert.equal(env.store.compactionState(S).latestVersion, null)

    const r = env.store.proposeSummary({ sessionId: S, coversFromSeq: 1, coversToSeq: 8, summary: '很短', createdBy: 'auto' })
    assert.equal(r.savedTokens, r.messageTokens - r.summaryTokens)
    assert.ok(r.savedTokens > 0)
    let st = env.store.compactionState(S)
    assert.equal(st.versions, 1)
    assert.equal(st.latestVersion, 1)
    assert.equal(st.settled, true)
    assert.deepEqual([...st.unrecognizedStates], [])
    assert.equal(st.byState.compacted.count, 8)
    assert.equal(st.byState.active.count, 1)
    // 原文总数 = active + compacted（压缩不会让原文消失）。
    assert.equal(st.rawTokens, st.byState.active.tokens + st.byState.compacted.tokens)

    // 塞一行坏状态。
    env.db.prepare(
      `INSERT INTO compaction_messages (session_id, seq, role, content, tokens, state, covered_by_version, created_at_ms)
       VALUES (?, 99, 'user', 'x', 1, 'mutated', NULL, 0)`,
    ).run(S)
    st = env.store.compactionState(S)
    assert.deepEqual([...st.unrecognizedStates], ['mutated'])
    assert.equal(st.settled, false, '未登记状态被当成了安定 —— 一行坏数据读起来像"一切都好"')
    assert.equal(st.byState.mutated.count, 1, '未登记状态没有被报出来')
  } finally { env.dispose() }
})

test('⑬ token 估计是**保守的**（宁高不低：低估会让"压缩后仍超限"变成惊喜）', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('中文'), 2, '中文按字算比按字节算接近真实值')
  assert.equal(estimateTokens('abcd中文'), 3)
  // 非字符串不炸（它会出现在一条坏数据上，而"读数算不出来"比"整个读数没了"好）。
  assert.equal(estimateTokens(null), 0)
  assert.equal(estimateTokens(42), 0)
  // 保守性：纯 ASCII 的估计值不低于字符数/5。
  const long = 'a'.repeat(1000)
  assert.ok(estimateTokens(long) >= 200)
})

test('⑭ 唯一键：同一 session 不会出现两个同号版本（并发写入的数据库层保证）', () => {
  const env = makeEnv()
  try {
    env.seed(S, 3)
    env.store.proposeSummary({ sessionId: S, coversFromSeq: 1, coversToSeq: 1, summary: 'A', createdBy: 'auto' })
    // 绕过仓储直接插一行同版本：必须被唯一索引拦住。
    assert.throws(
      () => env.db.prepare(
        `INSERT INTO compaction_summaries
           (session_id, version, covers_from_seq, covers_to_seq, summary, author, created_at_ms)
         VALUES (?, 1, 2, 2, 'B', 'model', 0)`,
      ).run(S),
      /UNIQUE|PRIMARY/i,
      '同一 session 出现了两个版本 1 —— baseVersion CAS 会因此失效',
    )
    // 而 session 之间互不影响。
    env.seed('sess-2', 1)
    assert.equal(env.store.proposeSummary({ sessionId: 'sess-2', coversFromSeq: 1, coversToSeq: 1, summary: 'Y', createdBy: 'auto' }).summary.version, 1)
  } finally { env.dispose() }
})
