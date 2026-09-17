// runtime/experience/friction.test.mjs
// ============================================================================
// F-18 摩擦学习的判据。
//
// 两条主线：
//   · 摩擦**只从结构化字段算**（不数评论散文里的中文短语）
//   · 缺失的输入是"不知道"、不是 0
// 第三条线是草稿的生命周期：**草稿不是知识**，两个终点都要人 + 封闭理由。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DISCARD_REASONS, FRICTION_CAPS, FRICTION_CODES, FRICTION_DIMENSIONS, FRICTION_DRAFT_MIN,
  FRICTION_WEIGHTS, PROMOTE_REASONS,
  buildDraft, collectFriction, discardDraft, draftBacklog, frictionScore, promoteDraft, shouldDraft,
} from './friction.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function throwsCode(fn, code) {
  let err = null
  try { fn() } catch (e) { err = e }
  assert.notEqual(err, null, `期望抛出 ${code}，但没有抛`)
  assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}：${err.message}`)
  return err
}

/** 一份**完整**的输入（每一维的数据都给了）。 */
function full(over = {}) {
  return {
    validations: [{ decision: 'rejected' }, { decision: 'approved' }],
    attempts: [{ taskId: 't1', state: 'failed' }, { taskId: 't1', state: 'done' }],
    rollbacks: [],
    reconciliations: [],
    ...over,
  }
}

// ---------------------------------------------------------------------------
// ① ★ 只从结构化字段取值
// ---------------------------------------------------------------------------

test('① ★★★ 本模块**不**对评论文本做正则匹配（旧实现的核心手法）', () => {
  const src = readFileSync(join(HERE, 'friction.mjs'), 'utf8')
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  // 判据：代码里不出现正则字面量，也不出现对某个"文本"做 test/match 的调用。
  const regexLiterals = [...code.matchAll(/=\s*\/[^/\n]+\/[gimsuy]*/g)].map((m) => m[0])
  assert.deepEqual(regexLiterals, [], `出现了正则字面量：${regexLiterals.join(' , ')}`)
  for (const banned of [/\.test\(/, /\.match\(/, /\.replace\(\s*\//, /texts\b/]) {
    assert.equal(banned.test(code), false, `出现了 ${banned}——摩擦不能从散文里数`)
  }
  // 反向锚点：模块里**确实**在从结构化字段取值。
  assert.match(code, /decision/)
  assert.match(code, /taskId/)
})

test('① ★★ 拒绝从 `validations.decision` 数，与评论内容无关', () => {
  const a = collectFriction(full())
  // 换一段完全无关的评论文本，分数必须**一模一样**。
  const b = collectFriction(full({ comments: [{ by: 'general', text: '打回！退回：请修订' }] }))
  assert.deepEqual(b.counts, a.counts, '评论内容影响了摩擦读数——那说明有人在数散文')
  assert.equal(a.counts.rejected, 1, '只有 decision===rejected 的那一条算')
  // 认不出的 decision 一律**不算**拒绝（也不报错：那是上游的词表问题）。
  const c = collectFriction(full({ validations: [{ decision: 'maybe' }, { decision: 'approved' }] }))
  assert.equal(c.counts.rejected, 0)
})

test('① ★★ 重做与"连续失败"是两个数，不能混', () => {
  // t1 试了三次、其中两次失败：重做 = 2（第 2、3 次），连续失败 = 1（失败的第 2 次起）。
  const s = collectFriction(full({
    attempts: [
      { taskId: 't1', state: 'failed' }, { taskId: 't1', state: 'failed' }, { taskId: 't1', state: 'done' },
      { taskId: 't2', state: 'done' },
    ],
  }))
  assert.equal(s.counts.rework, 2, '重做应该是"同一任务的第 2 次及以后"')
  assert.equal(s.counts.repeatFailure, 1, '连续失败应该是"失败 attempt 的第 2 次起"')
  // 一条失败的、且只试过一次的任务：不算重做，也不算连续失败。
  const single = collectFriction(full({ attempts: [{ taskId: 't9', state: 'failed' }] }))
  assert.equal(single.counts.rework, 0)
  assert.equal(single.counts.repeatFailure, 0)
})

test('① ★★ 没有 taskId 的 attempt **不归进"未知任务"桶**', () => {
  // 归进去会把"三条不同任务的失败"读成"同一个任务失败了三次"，
  // 于是一个偶发问题被报成系统性问题。
  const err = throwsCode(
    () => collectFriction(full({ attempts: [{ state: 'failed' }] })),
    FRICTION_CODES.BAD_INPUT,
  )
  assert.match(err.message, /未知任务/)
  assert.match(err.message, /偶发/)
})

test('① 认不出的 attempt 状态一律不算失败', () => {
  const s = collectFriction(full({
    attempts: [{ taskId: 't1', state: 'running' }, { taskId: 't1', state: 'Queued' }],
  }))
  // 两次尝试 ⇒ 重做 1；但那两个状态都不算失败 ⇒ 连续失败 0。
  assert.equal(s.counts.rework, 1)
  assert.equal(s.counts.repeatFailure, 0)
  assert.equal(s.known.repeatFailure, true)
})

test('① 交接**不算**摩擦（流程的正常一环）', () => {
  const src = readFileSync(join(HERE, 'friction.mjs'), 'utf8')
  assert.equal(FRICTION_DIMENSIONS.includes('handoff'), false, 'handoff 不该是摩擦维度')
  // 明明没有 handoff 这一维，却传了交接数据时读数不受影响。
  const a = collectFriction(full())
  const b = collectFriction(full({ handoffs: [{}], handoff: [{}] }))
  assert.deepEqual(b.counts, a.counts)
  void src
})

// ---------------------------------------------------------------------------
// ② ★★★ 缺失是"不知道"，不是 0
// ---------------------------------------------------------------------------

test('② ★★★ 缺一维 ⇒ `complete:false`、`score` **抛**，而不是给一个低分', () => {
  const s = collectFriction({ validations: [{ decision: 'rejected' }] })
  assert.equal(s.complete, false)
  assert.deepEqual([...s.unknownDimensions].sort(), ['repeatFailure', 'rework', 'rollback', 'unknownOutcome'].sort())
  // ★ 缺的那一维是 null，不是 0。
  assert.equal(s.capped.rollback, null)
  assert.equal(s.counts.rollback, null)
  assert.equal(s.capped.rejected, 1, '已知的那一维照常算')
  const err = throwsCode(() => frictionScore(s), FRICTION_CODES.INCOMPLETE)
  assert.match(err.message, /数据没到/)
  assert.match(err.message, /allowPartial/)
})

test('② ★★★ 显式要部分分时，返回的数字**带着自己的局限**走', () => {
  const s = collectFriction({ validations: [{ decision: 'rejected' }] })
  const p = frictionScore(s, { allowPartial: true })
  assert.equal(p.partial, true, '部分分必须自报家门')
  assert.equal(p.complete, false)
  assert.equal(p.score, FRICTION_WEIGHTS.rejected)
  assert.deepEqual([...p.missing].sort(), [...s.unknownDimensions].sort())
  // 完整时 partial 是 false，且 missing 为空。
  const fullScore = frictionScore(collectFriction(full()))
  assert.equal(fullScore.partial, false)
  assert.deepEqual([...fullScore.missing], [])
})

test('② ★★ 完整时 `score` 是逐维封顶后的加权和', () => {
  const s = collectFriction(full({
    validations: [{ decision: 'rejected' }, { decision: 'rejected' }],
    attempts: [{ taskId: 't1', state: 'failed' }, { taskId: 't1', state: 'failed' }],
    rollbacks: [{}], reconciliations: [{}],
  }))
  assert.equal(s.complete, true)
  const expect = 2 * FRICTION_WEIGHTS.rejected   // 2
    + 1 * FRICTION_WEIGHTS.rework               // 1
    + 1 * FRICTION_WEIGHTS.rollback             // 1
    + 1 * FRICTION_WEIGHTS.repeatFailure        // 1
    + 1 * FRICTION_WEIGHTS.unknownOutcome       // 1
  assert.equal(frictionScore(s).score, expect)
})

test('② ★★ 封顶：一次"卡了 40 轮"不会压成"这个岗位一直很差"', () => {
  const many = (n) => Array.from({ length: n }, () => ({ decision: 'rejected' }))
  // ★ 基线单独量一次：`full()` 里除了 rejected 还有 rework=1
  //   （t1 试了两次），所以要拿"封顶后的 rejected 贡献 + 其余维度"来比，
  //   不能只写 `CAPS.rejected * WEIGHT.rejected`——那样算出来的差
  //   恰好是 rework 那一项，而红的原因与要看的东西无关。
  const capped = collectFriction(full({ validations: many(40) }))
  assert.equal(capped.counts.rejected, 40, '原始计数如实保留')
  assert.equal(capped.capped.rejected, FRICTION_CAPS.rejected, '封顶只作用于加权，不改原始计数')
  const expected = FRICTION_CAPS.rejected * FRICTION_WEIGHTS.rejected
    + 1 * FRICTION_WEIGHTS.rework
  assert.equal(frictionScore(capped).score, expected)
  // 未封顶时这一维会贡献 3*40=120；封顶后整分远低于它。
  assert.equal(frictionScore(capped).score < 40 * FRICTION_WEIGHTS.rejected, true)
  assert.match(readFileSync(join(HERE, 'friction.mjs'), 'utf8'), /"偶发但严重"与"长期系统性"分得开/)
})

test('② ★★ 数据不完整时**不出草稿**（"数据没到"不该被读成"没有摩擦"）', () => {
  const incomplete = collectFriction({ validations: [] })
  const r = shouldDraft(incomplete)
  assert.equal(r.draft, false)
  assert.equal(r.reason, 'incomplete-data')
  assert.equal(r.score, null, '"不知道"的这一项不能是 0')
  // 完整且低于阈值 ⇒ 不出。
  const calm = collectFriction(full({ validations: [{ decision: 'approved' }] }))
  assert.equal(shouldDraft(calm).reason, 'below-threshold')
  // 完整且到阈值 ⇒ 出。
  const hot = collectFriction(full({
    validations: Array.from({ length: FRICTION_DRAFT_MIN }, () => ({ decision: 'rejected' })),
  }))
  const rh = shouldDraft(hot)
  assert.equal(rh.draft, true)
  assert.equal(rh.reason, 'above-threshold')
  assert.equal(rh.score >= FRICTION_DRAFT_MIN, true)
})

test('② `known` 与 `counts` 同时给出（0 与 null 在读数里分得开）', () => {
  // 显式给了空数组 ⇒ known:true、count 0（一个**结论**："这段时间一次都没有"）。
  const zero = collectFriction({ validations: [], attempts: [], rollbacks: [], reconciliations: [] })
  assert.equal(zero.complete, true)
  assert.equal(zero.capped.rejected, 0)
  // 没给 ⇒ known:false、count null（"我没拿到"）。
  const unknown = collectFriction({})
  assert.equal(unknown.complete, false)
  assert.equal(unknown.capped.rejected, null)
  assert.notEqual(zero.capped.rejected, unknown.capped.rejected, '0 与"不知道"必须可分辨')
})

// ---------------------------------------------------------------------------
// ③ 草稿不是知识
// ---------------------------------------------------------------------------

function sampleDraft(over = {}) {
  const signals = collectFriction(full({
    validations: Array.from({ length: 3 }, () => ({ decision: 'rejected' })),
  }))
  return buildDraft({
    subject: { kind: 'skill', id: 'skill.diff' },
    signals,
    evidence: { taskId: 't1' },
    createdAtMs: 1000,
    ...over,
  })
}

test('③ ★★★ 草稿的初始状态恒为 draft，且本模块**没有**自动晋升出口', () => {
  const d = sampleDraft()
  assert.equal(d.status, 'draft')
  assert.equal(d.promotedBy, null)
  assert.equal(d.promotedReason, null)
  assert.equal(d.discardedBy, null)
  const src = readFileSync(join(HERE, 'friction.mjs'), 'utf8')
  // 没有"分数够了就自己晋升"这种路径。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  assert.equal(/status:\s*'promoted'/.test(code.split('export function promoteDraft')[0]), false,
    'promoteDraft 之外出现了 status: promoted——那就是一条自动晋升路径')
})

test('③ ★★★ 晋升要人 + 封闭理由；理由是自由文本时被拒', () => {
  const d = sampleDraft()
  throwsCode(() => promoteDraft({ draft: d, by: '', reason: 'recurring' }), FRICTION_CODES.NO_ACTOR)
  const err = throwsCode(
    () => promoteDraft({ draft: d, by: 'general', reason: '因为我觉得应该固化一下' }),
    FRICTION_CODES.BAD_REASON,
  )
  assert.match(err.message, /三个月后无法聚合/)
  assert.deepEqual([...PROMOTE_REASONS],
    ['recurring', 'high-impact', 'safety', 'verified-by-human'])
  const p = promoteDraft({ draft: d, by: 'general', reason: 'recurring', rule: { note: '先跑 diff' } })
  assert.equal(p.status, 'promoted')
  assert.equal(p.promotedBy, 'general')
  assert.equal(p.promotedReason, 'recurring')
  assert.equal(p.rule.note, '先跑 diff')
  // 原草稿不变（冻结对象）。
  assert.equal(d.status, 'draft')
  assert.equal(Object.isFrozen(p), true)
})

test('③ ★★★ 丢弃**同样**要署名与理由（教训消失的方式也要留痕）', () => {
  const d = sampleDraft()
  throwsCode(() => discardDraft({ draft: d, by: '', reason: 'one-off' }), FRICTION_CODES.NO_ACTOR)
  const err = throwsCode(
    () => discardDraft({ draft: d, by: 'general', reason: '不太行' }),
    FRICTION_CODES.BAD_REASON,
  )
  assert.match(err.message, /丢弃也要写理由/)
  assert.deepEqual([...DISCARD_REASONS],
    ['one-off', 'already-known', 'environmental', 'not-actionable'])
  const x = discardDraft({ draft: d, by: 'general', reason: 'environmental' })
  assert.equal(x.status, 'discarded')
  assert.equal(x.discardedReason, 'environmental')
})

test('③ ★★ 一次草稿只有一个终点：二次处置被拒', () => {
  const p = promoteDraft({ draft: sampleDraft(), by: 'g', reason: 'recurring' })
  const err = throwsCode(
    () => promoteDraft({ draft: p, by: 'g', reason: 'recurring' }),
    FRICTION_CODES.BAD_TRANSITION,
  )
  assert.match(err.message, /只有一个终点/)
  assert.match(err.message, /分别加了两次/)
  throwsCode(() => discardDraft({ draft: p, by: 'g', reason: 'one-off' }), FRICTION_CODES.BAD_TRANSITION)
  // 丢弃过的不许再晋升。
  const x = discardDraft({ draft: sampleDraft(), by: 'g', reason: 'one-off' })
  throwsCode(() => promoteDraft({ draft: x, by: 'g', reason: 'recurring' }), FRICTION_CODES.BAD_TRANSITION)
})

test('③ ★★ 草稿必须指向一个有 kind 与 id 的东西', () => {
  const signals = collectFriction(full())
  const err = throwsCode(
    () => buildDraft({ subject: { kind: 'skill' }, signals }),
    FRICTION_CODES.BAD_DRAFT,
  )
  assert.match(err.message, /没有任何地方能应用它/)
  throwsCode(() => buildDraft({ subject: { id: 'x' }, signals }), FRICTION_CODES.BAD_DRAFT)
  throwsCode(() => buildDraft({ subject: 'skill.diff', signals }), FRICTION_CODES.BAD_DRAFT)
  // 形态版本对不上时不猜。
  throwsCode(() => promoteDraft({ draft: { version: 'legion/friction@0', status: 'draft' }, by: 'g', reason: 'recurring' }),
    FRICTION_CODES.BAD_DRAFT)
  throwsCode(() => promoteDraft({ draft: null, by: 'g', reason: 'recurring' }), FRICTION_CODES.BAD_DRAFT)
})

test('③ ★★ 草稿带着逐维读数（只有总分时"这条教训在说什么"无从判断）', () => {
  const d = sampleDraft()
  assert.equal(d.dimensions.length > 0, true)
  assert.equal(d.dimensions[0].dimension, 'rejected')
  assert.equal(d.dimensions[0].capped, 3)
  assert.equal(d.dimensions[0].weight, FRICTION_WEIGHTS.rejected)
  // 贡献大的排在前面。
  const s2 = collectFriction(full({ rollbacks: [{}, {}, {}] }))
  const d2 = buildDraft({ subject: { kind: 'task', id: 't1' }, signals: s2 })
  assert.equal(d2.dimensions[0].dimension, 'rollback')
  // 0 的那几维不列出来（列出来会让"在说什么"被噪声淹没）。
  assert.equal(d2.dimensions.some((x) => x.capped === 0), false)
})

test('③ 草稿带上"这份读数从来就不完整过吗"', () => {
  const incomplete = collectFriction({ validations: [{ decision: 'rejected' }] })
  // 不完整时 buildDraft 会因为拿不到 score 而抛——这正是要的。
  throwsCode(() => buildDraft({ subject: { kind: 'task', id: 't' }, signals: incomplete }), FRICTION_CODES.INCOMPLETE)
  const complete = collectFriction(full())
  const d = buildDraft({ subject: { kind: 'task', id: 't' }, signals: complete })
  assert.equal(d.complete, true)
})

// ---------------------------------------------------------------------------
// ④ 积压读数
// ---------------------------------------------------------------------------

test('④ ★★ 一条都还没处置时积压率是 `null`，不是 0（0% 会被读成"流程很健康"）', () => {
  const empty = draftBacklog([])
  assert.equal(empty.total, 0)
  assert.equal(empty.openRatio, null, '分母为 0 时不能给 0')
  const d = sampleDraft()
  const one = draftBacklog([d])
  assert.equal(one.draft, 1)
  // ★ 一条草稿、一条都没处置过 ⇒ 积压率 **1**（100% 还没人看），不是 0。
  //   这里第一版把期望写成 0，是把它与"空清单"那种情况搞混了：
  //   0 的含义是"没有任何未处置的草稿"，而那条草稿显然还没被处置。
  assert.equal(one.openRatio, 1)
  const mixed = draftBacklog([
    d,
    promoteDraft({ draft: d, by: 'g', reason: 'recurring' }),
    discardDraft({ draft: d, by: 'g', reason: 'one-off' }),
    discardDraft({ draft: d, by: 'g', reason: 'one-off' }),
    discardDraft({ draft: d, by: 'g', reason: 'one-off' }),
  ])
  assert.deepEqual([mixed.draft, mixed.promoted, mixed.discarded], [1, 1, 3])
  assert.equal(mixed.total, 5)
  assert.equal(mixed.openRatio, 1 / 5)
  // 非草稿对象进来要抛（否则"积压了几条"会被一个形状不对的东西污染）。
  throwsCode(() => draftBacklog([{ status: 'draft' }]), FRICTION_CODES.BAD_DRAFT)
  throwsCode(() => draftBacklog('nope'), FRICTION_CODES.BAD_INPUT)
})

// ---------------------------------------------------------------------------
// ⑤ 结构级
// ---------------------------------------------------------------------------

test('⑤ ★ 维度/权重/上限三张表**完全对齐**（少一项就是一个永远取不到 key 的读数）', () => {
  assert.deepEqual(Object.keys(FRICTION_WEIGHTS), [...FRICTION_DIMENSIONS])
  assert.deepEqual(Object.keys(FRICTION_CAPS), [...FRICTION_DIMENSIONS])
  // 每条权重都是正数：0 权重的维度是一个"算了但永远不影响结论"的维度。
  for (const d of FRICTION_DIMENSIONS) {
    assert.equal(FRICTION_WEIGHTS[d] > 0, true, `${d} 的权重不是正数`)
    assert.equal(FRICTION_CAPS[d] > 0, true, `${d} 的上限不是正数`)
  }
  assert.equal(FRICTION_DIMENSIONS.length, 5)
})

test('⑤ 每个码都至少被一个用例触达', () => {
  const src = readFileSync(join(HERE, 'friction.mjs'), 'utf8')
  const declared = [...src.matchAll(/^\s{2}([A-Z_]+):\s*'/gm)].map((m) => m[1])
  const testSrc = readFileSync(join(HERE, 'friction.test.mjs'), 'utf8')
  const unreachable = declared.filter((n) => !testSrc.includes(`FRICTION_CODES.${n}`))
  assert.deepEqual(unreachable, [], `这些码没有用例触达：${unreachable.join(', ')}`)
})

test('⑤ ★ 结果对象是冻结的（读数不能被调用方顺手改掉）', () => {
  const s = collectFriction(full())
  assert.equal(Object.isFrozen(s), true)
  assert.equal(Object.isFrozen(s.counts), true)
  assert.equal(Object.isFrozen(s.capped), true)
  assert.equal(Object.isFrozen(s.known), true)
  assert.equal(Object.isFrozen(frictionScore(s)), true)
  assert.equal(Object.isFrozen(shouldDraft(s)), true)
})
