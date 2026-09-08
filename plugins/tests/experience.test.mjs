// experience.ts 单测（P0-2）——对齐 node --test 风格（见 package.json scripts.test）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectSignals, frictionScore, shouldDraft, buildDraft,
  FRICTION_DRAFT_MIN, clampText,
} from '../lib/experience.js'

// T-110 形态：worker 多次失败/超时 + 释放重试，最终一次提交验收（无将军介入）
const retryHeavy = {
  id: 'T-110', title: '部署与 CI/CD 需求', role: 'devops', soldier: 'devops', goalId: 'G-x', status: 'done',
  comments: [
    { by: 'soldier-auto', at: '2026-09-06T13:55:20.010Z', text: '🟢 已派 AI worker 开始执行' },
    { by: 'soldier-auto', at: '2026-09-06T13:55:20.961Z', text: '⚠ worker 未完成（error），任务保留在 in_progress' },
    { by: 'soldier-auto', at: '2026-09-06T14:43:27.256Z', text: '守护检测到认领超过 40 分钟无进展，自动释放回 todo' },
    { by: 'soldier-auto', at: '2026-09-06T14:43:28.769Z', text: '🟢 已派 AI worker 开始执行' },
    { by: 'soldier-auto', at: '2026-09-06T15:00:00.000Z', text: '⚠ worker 超时（守护强制结算），任务保留在 in_progress' },
    { by: 'soldier-auto', at: '2026-09-07T01:36:29.659Z', text: '✓ 完成并提交验收：…完成' },
  ],
  evidence: [], artifacts: [{ path: 'docs/DEPLOY.md' }],
}

// T-004 形态：将军退回评论 + 2 次提交验收
const generalReturned = {
  id: 'T-004', title: '补写 README', role: null, soldier: 'soldier-auto', status: 'done',
  comments: [
    { by: 'soldier-auto', at: '2026-08-16T14:01:35.906Z', text: '✓ 完成并提交验收：…' },
    { by: 'general', at: '2026-08-17T01:00:00.000Z', text: '退回：之前派工因 provider 名错误失败（已修复），请继续完成原任务' },
    { by: 'soldier-auto', at: '2026-08-21T17:15:58.586Z', text: '✓ 完成并提交验收：已验证并确认…' },
  ],
  evidence: [], artifacts: [],
}

// T-107 形态：合入失败 + 调解成功（无将军评语、有门禁信号）
const mediatorResolved = {
  id: 'T-107', title: '文档预览实现', role: 'coder', soldier: 'coder', status: 'done',
  comments: [
    { by: 'soldier-auto', at: '2026-09-06T08:00:25.119Z', text: '⚠ 编码实现完成，但自动合入主分支失败（可能冲突）…请人工合入并推进' },
    { by: 'mediator-auto', at: '2026-09-06T08:14:13.321Z', text: '⚠ 调解失败：冲突文件未能自动解决' },
    { by: 'mediator-auto', at: '2026-09-06T09:11:33.308Z', text: '✅ 调解完成：冲突文件已由调解员解决并合入主分支，任务推进 done' },
  ],
  evidence: [], artifacts: [],
}

// 顺滑任务：机器闸门一把过，无将军介入
const smoothMachine = {
  id: 'T-088', title: '切片测试', role: 'tester', soldier: 'tester', status: 'done',
  comments: [
    { by: 'soldier-auto', at: '2026-09-05T09:25:18.061Z', text: '✅ 切片测试通过（机器闸门自动 done）：TC-S6-01..10 全绿' },
  ],
  evidence: [], artifacts: [],
}

// 将军验收 gate 任务（research 闸门，将军明确验收）
const generalAccepted = {
  id: 'T-074', title: '方案搜索', role: 'researcher', soldier: 'researcher', goalId: 'G-x', status: 'done',
  comments: [
    { by: 'soldier-auto', at: '2026-09-06T10:00:00.000Z', text: '✅ 方案搜索完成，方案文档已合入主分支。**请将军人工验收**：通过 → …' },
    { by: 'general', at: '2026-09-06T11:00:00.000Z', text: '✅ 将军验收：docs/RESEARCH.md 已确认合入主分支，方案覆盖完整，放行流转 breaker。' },
  ],
  evidence: [{ by: 'researcher', at: '2026-09-06T10:00:00.000Z', text: '命令与输出要点：(1) 方案 A/B/C 对比 …' }],
  artifacts: [{ path: 'docs/G-x/RESEARCH.md' }],
}

test('friction：worker 重试多轮 + 最终提交 → 有摩擦分但无将军评语', () => {
  const sig = collectSignals(retryHeavy)
  assert.equal(sig.rework, 2, 'worker 未完成/超时各计 1 轮打回')
  assert.equal(sig.reviewRounds, 1, '一次提交验收')
  assert.ok(sig.score >= FRICTION_DRAFT_MIN, `score ${sig.score} 应过草稿线`)
  assert.equal(sig.generalQuote, '')
  // 无将军介入且失败仅 2 轮 → 偶发失败不产草稿（T-080/T-107 教训：1-2 轮多为环境偶发）
  assert.ok(!shouldDraft(retryHeavy, sig), '2 轮偶发失败不产草稿')
})

// 失败 ≥3 轮的无将军任务才值得沉淀
const retrySevere = {
  id: 'T-090', title: '切片测试', role: 'tester', soldier: 'tester', status: 'done',
  comments: [
    { by: 'soldier-auto', at: '2026-09-05T08:00:00.000Z', text: '⚠ worker 未完成（error），任务保留在 in_progress' },
    { by: 'soldier-auto', at: '2026-09-05T08:30:00.000Z', text: '⚠ worker 超时（守护强制结算），任务保留在 in_progress' },
    { by: 'soldier-auto', at: '2026-09-05T09:00:00.000Z', text: '⚠ worker 未完成（error），任务保留在 in_progress' },
    { by: 'soldier-auto', at: '2026-09-05T10:00:00.000Z', text: '✅ 切片测试通过（机器闸门自动 done）' },
  ],
  evidence: [], artifacts: [],
}

test('friction：无将军但失败 ≥3 轮 → 产草稿（反复失败本身就是经验）', () => {
  const sig = collectSignals(retrySevere)
  assert.ok(sig.rework >= 3)
  assert.ok(shouldDraft(retrySevere, sig), `严重反复失败应产草稿，score=${sig.score}`)
})

test('friction：将军退回 + 二次提交 → 高分且带将军评语', () => {
  const sig = collectSignals(generalReturned)
  assert.equal(sig.generalNotes, 1)
  assert.equal(sig.rework, 1, '退回计打回')
  assert.equal(sig.reviewRounds, 2, '两次提交验收')
  assert.ok(sig.generalQuote.includes('退回'))
  assert.ok(shouldDraft(generalReturned, sig), '将军退回任务应产草稿')
})

test('friction：调解员解决合入（无将军、无打回）→ 不产草稿（机制摩擦归守护自己处理，无将军经验可沉淀）', () => {
  const sig = collectSignals(mediatorResolved)
  assert.equal(sig.score, 0, '合入调解是守护机制动作，不计将军摩擦')
  assert.ok(!shouldDraft(mediatorResolved, sig), '纯调解成功不刷草稿')
})

test('friction：纯机器闸门一把过 → 不产草稿', () => {
  const sig = collectSignals(smoothMachine)
  assert.ok(!shouldDraft(smoothMachine, sig), '顺滑自动任务不应刷草稿')
})

test('friction：将军验收 gate 任务 → 有将军评语与闸门信号，产草稿', () => {
  const sig = collectSignals(generalAccepted)
  assert.equal(sig.generalNotes, 1)
  assert.equal(sig.gateRounds, 1)
  assert.ok(sig.generalQuote.includes('将军验收'))
  assert.ok(shouldDraft(generalAccepted, sig))
})

test('草稿生成：frontmatter 含 taskId/status/friction/recalled/upvoted，正文含将军评语与 evidence', () => {
  const sig = collectSignals(generalAccepted)
  const md = buildDraft(generalAccepted, sig)
  assert.ok(md.startsWith('---\ntaskId: T-074'))
  assert.ok(md.includes('status: draft'))
  assert.ok(md.includes('recalled: 0'))
  assert.ok(md.includes('recalledBy: []'))
  assert.ok(md.includes('upvoted: 0'))
  assert.ok(md.includes('upvotedBy: []'))
  assert.ok(md.includes('createdAt: '), 'frontmatter 应带 createdAt（P0-3 观察窗需要）')
  assert.ok(md.includes('将军验收：docs/RESEARCH.md'))
  assert.ok(md.includes('方案 A/B/C 对比'), 'evidence 摘录应在草稿')
  assert.ok(md.includes('docs/G-x/RESEARCH.md'), 'artifacts 应在草稿')
  assert.ok(md.includes('## 待晋升'))
})

test('草稿幂等性：相同输入产出确定文本（无时间戳/随机量）；meta.createdAt 显式传入才带值', () => {
  const a = buildDraft(generalAccepted, collectSignals(generalAccepted))
  const b = buildDraft(generalAccepted, collectSignals(generalAccepted))
  assert.equal(a, b)
  // 不传 meta → createdAt 空；传了 → 反映在 frontmatter
  assert.ok(a.includes('createdAt: \n'))
  const c = buildDraft(generalAccepted, collectSignals(generalAccepted), { createdAt: '2026-09-08T00:00:00.000Z' })
  assert.ok(c.includes('createdAt: 2026-09-08T00:00:00.000Z'))
})

test('clampText 超长截断带提示', () => {
  const out = clampText('x'.repeat(100), 50)
  assert.ok(out.includes('…（已截断'))
  assert.equal(clampText('short', 50), 'short')
})

test('frictionScore 权重表驱动', () => {
  assert.equal(frictionScore({ rework: 0, reviewRounds: 0, gateRounds: 0, generalNotes: 0, artifactMiss: 0 }), 0)
  const g = frictionScore({ rework: 1, reviewRounds: 0, gateRounds: 0, generalNotes: 0, artifactMiss: 0 })
  assert.ok(g >= 2, `rework 单项应 ≥ 权重 2，实际 ${g}`)
})
