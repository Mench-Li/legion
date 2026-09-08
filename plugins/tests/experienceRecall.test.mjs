// P2-③ 经验自动召回单测：分词 / 打分 / 阈值选择 / 注入段渲染
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recallTokens, scoreRecall, pickRecall, renderRecallSection, countableRefs, RECALL_SCORE_MIN,
} from '../lib/experienceRecall.js'

/** @param {Partial<import('../lib/experienceRecall.js').RecallDoc>} o */
function doc(o) {
  return {
    taskId: 'T-001', kind: 'draft', title: '部署环境不一致教训', body: '沙箱与生产代理行为不一致，根因是历史演进遗留',
    ...o,
  }
}

const CORPUS = [
  doc({ taskId: 'T-092', title: '回归复跑先查上游防空转', body: '接到回归/复跑任务先核对上游是否已交付验证，避免 worker 空转；验证记录合入 main 为准。' }),
  doc({ taskId: 'T-110', title: '部署与文档预览环节', body: '任务详情要能直接打开预览产生的文档；workbench 类型检查 TSC=0；tsc emit 到 lib。' }),
  doc({ taskId: 'T-003', title: '看板接入将军轮次循环', body: '任务库重建为真实数据；看板协议文档就绪；render 每轮自动跑。' }),
]

test('recallTokens：CJK 词 + 英文标识符混合', () => {
  const t = recallTokens('回归复跑 TS1185 workbench 类型检查')
  assert.ok(t.includes('回归'))
  assert.ok(t.includes('复跑'))
  assert.ok(t.includes('ts1185'))
  assert.ok(t.includes('workbench'))
  assert.ok(t.includes('类型'))
  assert.ok(t.includes('检查'))
})

test('scoreRecall：同主题草稿分高于无关草稿', () => {
  const terms = recallTokens('回归复跑任务先查上游验证防空转')
  const scored = scoreRecall(terms, CORPUS)
  const byId = Object.fromEntries(scored.map((s) => [s.doc.taskId, s.score]))
  assert.ok(byId['T-092'] > byId['T-003'], `T-092(${byId['T-092']}) 应高于 T-003(${byId['T-003']})`)
  assert.ok(byId['T-092'] > byId['T-110'])
})

test('pickRecall：只选高于阈值且命中的相关草稿', () => {
  const picks = pickRecall('回归复跑类任务先查上游验证防空转', CORPUS)
  assert.ok(picks.length >= 1)
  assert.equal(picks[0].doc.taskId, 'T-092')
  for (const p of picks) assert.ok(p.score >= RECALL_SCORE_MIN)
})

test('pickRecall：无关查询不召回（无噪音上票）', () => {
  const picks = pickRecall('把白板画布改成支持多人协作光标', CORPUS)
  assert.equal(picks.length, 0)
})

test('pickRecall：topN 封顶', () => {
  const many = [...CORPUS, doc({ taskId: 'T-200', title: '回归测试空转处理', body: '同批回归复跑防空转，先查上游验证记录' })]
  const picks = pickRecall('回归复跑空转', many, { topN: 2, minScore: 0.5 })
  assert.ok(picks.length <= 2)
})

test('renderRecallSection：无命中返回 null；有命中渲染引用行', () => {
  assert.equal(renderRecallSection([]), null)
  const picks = pickRecall('回归复跑任务防空转', CORPUS, { minScore: 0.5 })
  const sec = renderRecallSection(picks)
  assert.ok(sec.includes('相关团队经验（自动召回'))
  assert.ok(sec.includes('T-092'))
  assert.ok(sec.includes('相关度'))
  assert.ok(sec.includes('经验草稿'))
})

test('renderRecallSection：learning 资产标注', () => {
  const sec = renderRecallSection([{ doc: doc({ kind: 'learning', title: '跨 space 授权前缀教训' }), score: 5 }])
  assert.ok(sec.includes('经验条目(learning)'))
})

test('阈值行为：minScore=0 且无命中词也召回（边界测试用）', () => {
  const picks = pickRecall('完全无关主题词甲', CORPUS, { minScore: 0, topN: 5 })
  // 无命中词时 scoreRecall 给 0 分；pickRecall 要求 hit.length>0 → 仍为空
  assert.equal(picks.length, 0)
})

test('countableRefs：自引用排除 + 同目标兄弟排除（只注入不计数）', () => {
  const picks = [
    { doc: doc({ taskId: 'T-123', goalId: 'G-1' }), score: 20 },   // 自引用（本任务）
    { doc: doc({ taskId: 'T-115', goalId: 'G-1' }), score: 18 },   // 同目标兄弟
    { doc: doc({ taskId: 'T-092', goalId: 'G-2' }), score: 6 },    // 跨目标真命中
  ]
  const counted = countableRefs(picks, 'T-123', 'G-1')
  assert.deepEqual(counted.map((c) => c.doc.taskId), ['T-092'])
})

test('countableRefs：无 goalId 的任务跨任务计数（防同 id 自引用即可）', () => {
  const picks = [
    { doc: doc({ taskId: 'T-110' }), score: 5 }, // doc 无 goalId
  ]
  const counted = countableRefs(picks, 'T-120', null)
  assert.equal(counted.length, 1)
})
