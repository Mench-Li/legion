// experienceVotes.ts 单测（P0-3）——frontmatter 状态机 / 事件检测 / confidence / 门槛 / promote 改写
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDraftState, renderFrontmatter, replaceFrontmatter, applyVote,
  detectRecalledTaskIds, detectUpvotedTaskIds,
  daysSince, votesScore, recencyScore, ratioScore, confidenceOf,
  shouldPromote, shouldPrune, PROMOTE_GATES,
  skillIdForTask, buildPromotePrompt, fallbackSkill,
} from '../lib/experienceVotes.js'

/** 与 src/experienceVotes.ts 的 DraftState 对齐的测试夹具类型（.mjs 无类型，用 JSDoc 记形态）。 */
/** @typedef {{taskId: string, status: string, friction: number, recalled: number, recalledBy: string[], upvoted: number, upvotedBy: string[], createdAt: string, lastActivityAt: string, role: string, goalId: string, scope: string, promotedTo: string, promotedAt: string}} DraftState */

const T0 = '2026-09-01T00:00:00.000Z'

/** @param {Partial<DraftState>} over */
function baseState(over = {}) {
  return {
    taskId: 'T-110', status: 'draft', friction: 6.5,
    recalled: 0, recalledBy: [], upvoted: 0, upvotedBy: [],
    createdAt: T0, lastActivityAt: T0,
    role: 'devops', goalId: '', scope: 'software',
    promotedTo: '', promotedAt: '',
    ...over,
  }
}

test('frontmatter 解析：完整字段', () => {
  const md = '---\ntaskId: T-004\nstatus: draft\nfriction: 8.50\nrecalled: 0\nrecalledBy: []\nupvoted: 0\nupvotedBy: []\ncreatedAt: 2026-09-01T00:00:00.000Z\nlastActivityAt: 2026-09-01T00:00:00.000Z\nrole: soldier-auto\ngoalId: \nscope: software\npromotedTo: \npromotedAt: \n---\n\n# 正文'
  const s = parseDraftState(md)
  assert.equal(s.taskId, 'T-004')
  assert.equal(s.status, 'draft')
  assert.equal(s.friction, 8.5)
  assert.equal(s.createdAt, T0)
  assert.equal(s.lastActivityAt, T0)
})

test('frontmatter 解析：宽容缺字段与坏类型', () => {
  const s = parseDraftState('---\ntaskId: T-1\nstatus: weird\nrecalled: abc\n---')
  assert.equal(s.taskId, 'T-1')
  assert.equal(s.status, 'draft') // 未知 status → 默认
  assert.equal(s.recalled, 0)     // 非数字 → 0
  assert.ok(Array.isArray(s.recalledBy))
  assert.equal(s.lastActivityAt, s.createdAt) // 无活动时间回退到创建时间
})

test('frontmatter round-trip：渲染再解析保持一致', () => {
  const s = baseState({ recalled: 3, recalledBy: ['T-120', 'T-121'], upvoted: 1, upvotedBy: ['general'] })
  const back = parseDraftState(renderFrontmatter(s))
  assert.deepEqual(back.recalledBy, ['T-120', 'T-121'])
  assert.deepEqual(back.upvotedBy, ['general'])
  assert.equal(back.recalled, 3)
  assert.equal(back.scope, 'software')
})

test('replaceFrontmatter：保留正文，仅换 frontmatter', () => {
  const s = baseState({ status: 'promoted', promotedTo: 'exp-t110', promotedAt: T0 })
  const md = renderFrontmatter(s) + '\n# 经验草稿：T-110 x\n\n将军评语：…'
  const out = replaceFrontmatter(md, renderFrontmatter(s))
  assert.ok(out.includes('# 经验草稿：T-110 x'))
  assert.ok(out.includes('将军评语：…'))
  assert.ok(out.includes('status: promoted'))
  assert.equal(out.indexOf('---'), 0)
})

test('recalled 事件：借鉴语义词 + 草稿路径两种形态', () => {
  assert.deepEqual(detectRecalledTaskIds('这个任务参考 T-004 经验来写验收'), ['T-004'])
  assert.deepEqual(detectRecalledTaskIds('复用经验草稿 T-110 的做法'), ['T-110'])
  assert.deepEqual(detectRecalledTaskIds('按 docs/experience/drafts/T-088.md 的要点'), ['T-088'])
  // 无借鉴语义的任务 id 提法不算 recalled（流水线链引用不误计；自引用过滤由 applyVote 承担）
  assert.deepEqual(detectRecalledTaskIds('已审查 T-040 的代码 diff 并复跑验证'), [])
  assert.deepEqual(detectRecalledTaskIds('T-110 任务自己提到 T-110'), []) // 无语义词不检出
})

test('upvoted 事件：将军采纳评论', () => {
  assert.deepEqual(detectUpvotedTaskIds('采纳草稿 T-110：部署经验有效'), ['T-110'])
  assert.deepEqual(detectUpvotedTaskIds('按 T-004 的经验办'), []) // 无采纳强语义不算 upvoted
  assert.deepEqual(detectUpvotedTaskIds('点赞经验草稿 T-092'), ['T-092'])
})

test('applyVote：recalled/upvoted 累加 + 活动时间刷新 + 去重', () => {
  const later = '2026-09-10T00:00:00.000Z'
  let s = applyVote({ state: baseState(), recalledByTaskId: 'T-120', now: later })
  assert.equal(s.recalled, 1)
  assert.deepEqual(s.recalledBy, ['T-120'])
  assert.equal(s.lastActivityAt, later)
  // 同一任务重复引用不重复计
  s = applyVote({ state: s, recalledByTaskId: 'T-120', now: later })
  assert.equal(s.recalled, 1)
  // 另一任务引用 + 将军采纳
  s = applyVote({ state: s, recalledByTaskId: 'T-121', upvotedBy: 'general', now: later })
  assert.equal(s.recalled, 2)
  assert.equal(s.upvoted, 1)
  assert.deepEqual(s.upvotedBy, ['general'])
  // 自引用（草稿源任务自己）不计数
  s = applyVote({ state: s, recalledByTaskId: 'T-110', now: later })
  assert.equal(s.recalled, 2)
})

test('daysSince / votes / recency / ratio 分量', () => {
  const later = '2026-10-01T00:00:00.000Z'
  assert.equal(daysSince(T0, later), 30)
  assert.ok(Math.abs(votesScore(2, 1) - Math.min(1, 0.3 + 0.35)) < 1e-9)
  assert.equal(recencyScore(T0, later), 0)             // 恰好 30 天 → 0
  assert.equal(recencyScore(T0, '2026-09-16T00:00:00.000Z'), 0.5) // 15 天 → 0.5
  assert.equal(ratioScore(0, 1), 0)
  assert.equal(ratioScore(2, 1), 0.5)
  assert.equal(ratioScore(1, 5), 1) // 封顶
})

test('confidence：组合公式 + 衰减拖垮', () => {
  // 有引用有采纳且刚活动 → 高
  const active = baseState({ recalled: 2, recalledBy: ['T-120', 'T-121'], upvoted: 1, upvotedBy: ['general'], lastActivityAt: T0 })
  const cActive = confidenceOf(active, T0)
  assert.ok(cActive > 0.6, `活跃草稿 confidence 应高，实际 ${cActive}`)
  // 同样票数但 40 天无活动 → recency=0 → 被拖垮
  const stale = { ...active, lastActivityAt: '2026-08-01T00:00:00.000Z' }
  const cStale = confidenceOf(stale, T0)
  assert.ok(cStale < cActive - 0.25, `衰减后应显著低于活跃 ${cActive} vs ${cStale}`)
  // 零票新草稿 → 低但非零（recency 满）——观察窗期间不被 promote
  const fresh = baseState()
  const cFresh = confidenceOf(fresh, T0)
  assert.ok(cFresh < PROMOTE_GATES.CONF_PROMOTE_MIN, `零票 confidence ${cFresh} 低于晋升线`)
})

test('shouldPromote 四门槛：观察窗/recalled/upvoted/confidence 全过才 promote', () => {
  const now = '2026-09-15T00:00:00.000Z' // 落盘 14 天后
  const ready = baseState({
    recalled: 2, recalledBy: ['T-120', 'T-121'],
    upvoted: 1, upvotedBy: ['general'],
    lastActivityAt: '2026-09-10T00:00:00.000Z',
  })
  const r = shouldPromote(ready, now)
  assert.equal(r.promote, true, r.gates.map(g => `${g.name}=${g.pass}(${g.detail})`).join('; '))

  // 观察窗不足
  const young = shouldPromote(baseState({
    recalled: 2, recalledBy: ['T-120', 'T-121'], upvoted: 1, upvotedBy: ['general'], lastActivityAt: '2026-09-14T00:00:00.000Z',
  }), now) // 落盘 T0=9/1，14 天——但 lastActivity 近。观察窗用 createdAt → 已过
  assert.equal(young.promote, true)
  const young2 = shouldPromote(baseState({
    createdAt: '2026-09-13T00:00:00.000Z', lastActivityAt: '2026-09-14T00:00:00.000Z',
    recalled: 2, recalledBy: ['T-120', 'T-121'], upvoted: 1, upvotedBy: ['general'],
  }), now)
  assert.equal(young2.promote, false, '落盘未满观察窗不晋升')

  // recalled 不足
  const lowRecall = shouldPromote(baseState({
    recalled: 1, recalledBy: ['T-120'], upvoted: 1, upvotedBy: ['general'],
  }), now)
  assert.equal(lowRecall.promote, false)

  // upvoted 不足（将军未采纳）
  const noUpvote = shouldPromote(baseState({
    recalled: 3, recalledBy: ['T-120', 'T-121', 'T-122'], upvoted: 0,
  }), now)
  assert.equal(noUpvote.promote, false, '无将军采纳不晋升（人工确认关）')

  // confidence 不足（活动太旧被衰减）
  const oldVotes = shouldPromote(baseState({
    createdAt: '2026-06-01T00:00:00.000Z',
    recalled: 2, recalledBy: ['T-120', 'T-121'], upvoted: 1, upvotedBy: ['general'],
    lastActivityAt: '2026-06-01T00:00:00.000Z', // 100+ 天前
  }), now)
  assert.equal(oldVotes.promote, false, '衰减后 confidence 不足不晋升')
})

test('shouldPrune：90 天无活动且 confidence 趋零 → stale（标记不删）', () => {
  const now = '2027-01-01T00:00:00.000Z'
  const dead = baseState({ createdAt: '2026-06-01T00:00:00.000Z', lastActivityAt: '2026-06-01T00:00:00.000Z' })
  assert.equal(shouldPrune(dead, now), true)
  // 有过真实票（哪怕一次引用）不算死——团队小时好经验久未被再次用到仍保留
  const alive = baseState({
    createdAt: '2026-06-01T00:00:00.000Z', lastActivityAt: '2026-12-01T00:00:00.000Z',
    recalled: 1, recalledBy: ['T-200'],
  })
  assert.equal(shouldPrune(alive, now), false)
  // 已 promoted 不 prune
  const promoted = baseState({ status: 'promoted', createdAt: '2026-06-01T00:00:00.000Z', lastActivityAt: '2026-06-01T00:00:00.000Z' })
  assert.equal(shouldPrune(promoted, now), false)
})

test('skillIdForTask：taskId → 合法 skill id', () => {
  assert.equal(skillIdForTask('T-004'), 'exp-t004')
  assert.equal(skillIdForTask('T-110'), 'exp-t110')
  assert.match(skillIdForTask('T-110'), /^[a-z0-9][a-z0-9-]{0,63}$/)
})

test('buildPromotePrompt：含草稿正文与输出 JSON 要求', () => {
  const p = buildPromotePrompt('T-110', '# 经验草稿：T-110 部署\n\n将军评语：xxx')
  assert.ok(p.includes('T-110'))
  assert.ok(p.includes('"main"'))
  assert.ok(p.includes('草稿正文'))
})

test('fallbackSkill：子代理不可用时降级模板保底', () => {
  const s = baseState()
  const f = fallbackSkill('T-110', s, '# 经验草稿：T-110 部署经验\n\n将军评语：先检查 Y')
  assert.ok(f.name.length <= 40)
  assert.ok(f.description.includes('T-110'))
  assert.ok(f.main.includes('将军评语'))
})
