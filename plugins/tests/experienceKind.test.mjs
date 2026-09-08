// P2-① 经验形态分流单测：classifyDraftKind / resolveKind / learnings 落盘格式 / 溯源
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyDraftKind, resolveKind, learningIdForTask, buildLearningPrompt,
  renderLearningFile, fallbackLearning, parseDraftState, renderFrontmatter,
} from '../lib/experienceVotes.js'

const PROCEDURE_BODY = [
  '# 经验草稿：T-091 跨模块合入冲突',
  '## 将军评语',
  '做法：先跑 typecheck 再 build，复现命令 node scripts/check.mjs',
  '步骤：1. 核对上游 2. 按以下命令验证 3. 检查测试覆盖',
].join('\n')

const DECLARATIVE_BODY = [
  '# 经验草稿：T-110 部署环境',
  '## 将军评语',
  '背景：沙箱与生产行为不一致，根因是代理层历史演进遗留，',
  '决策理由：选择统一走网关而非直连，教训是环境差异要先确认。',
].join('\n')

test('classifyDraftKind：步骤式正文 → procedure', () => {
  assert.equal(classifyDraftKind(PROCEDURE_BODY), 'procedure')
})

test('classifyDraftKind：陈述/决策正文 → declarative', () => {
  assert.equal(classifyDraftKind(DECLARATIVE_BODY), 'declarative')
})

test('classifyDraftKind：平局默认 procedure（保守不把可复用做法埋掉）', () => {
  assert.equal(classifyDraftKind('## 将军评语\n普通内容没有明确信号'), 'procedure')
})

test('resolveKind：frontmatter 显式 declarative 优先于启发式', () => {
  assert.equal(resolveKind({ kind: 'declarative' }, PROCEDURE_BODY), 'declarative')
  assert.equal(resolveKind({ kind: 'procedure' }, DECLARATIVE_BODY), 'procedure')
})

test('resolveKind：空 kind 走启发式', () => {
  assert.equal(resolveKind({ kind: '' }, DECLARATIVE_BODY), 'declarative')
  assert.equal(resolveKind({ kind: '' }, PROCEDURE_BODY), 'procedure')
})

test('learningIdForTask：T-092 → learning-t092', () => {
  assert.equal(learningIdForTask('T-092'), 'learning-t092')
})

test('renderLearningFile：frontmatter 含 kind:declarative/status:learning + 溯源', () => {
  const md = renderLearningFile({
    taskId: 'T-110', scope: 'software', role: 'devops', goalId: 'G-x',
    createdAt: '2026-09-01T00:00:00.000Z', promotedAt: '2026-09-05T00:00:00.000Z',
    body: '## 背景\n沙箱与生产不一致。\n\n源自任务 T-110',
  })
  // learning 是终态资产（不回流草稿管线），格式上仍是可读 frontmatter + 正文
  assert.ok(md.startsWith('---\n'))
  assert.ok(md.includes('kind: declarative'))
  assert.ok(md.includes('status: learning'))
  assert.ok(md.includes('taskId: T-110'))
  assert.ok(md.includes('scope: software'))
  assert.ok(md.includes('promotedAt: 2026-09-05T00:00:00.000Z'))
  assert.ok(md.includes('## 背景'))
  assert.ok(md.trim().endsWith('源自任务 T-110'))
})

test('frontmatter kind 字段渲染/回读（草稿源，kind 空字符串兼容 P0-2 旧文件）', () => {
  const fm = renderFrontmatter({
    taskId: 'T-004', status: 'draft', friction: 8.5, recalled: 0, recalledBy: [],
    upvoted: 0, upvotedBy: [], createdAt: '', lastActivityAt: '', role: '', goalId: '', scope: '',
    promotedTo: '', promotedAt: '', kind: '',
  })
  assert.ok(fm.includes('kind: '))
  const s = parseDraftState(`---\n${fm.split('\n').slice(1, -1).join('\n')}\n---\n正文`)
  assert.equal(s.kind, '')
  const fm2 = renderFrontmatter({
    taskId: 'T-110', status: 'promoted', friction: 6.5, recalled: 2, recalledBy: ['T-120'],
    upvoted: 1, upvotedBy: ['general'], createdAt: '', lastActivityAt: '', role: '', goalId: '', scope: 'software',
    promotedTo: 'learning-t110', promotedAt: '2026-09-05T00:00:00.000Z', kind: 'declarative',
  })
  assert.ok(fm2.includes('kind: declarative'))
  assert.ok(fm2.includes('promotedTo: learning-t110'))
})

test('buildLearningPrompt：要求输出 markdown 正文（非 JSON 外壳）+ 溯源任务 id', () => {
  const p = buildLearningPrompt('T-110', DECLARATIVE_BODY)
  assert.ok(p.includes('陈述性/决策类'))
  assert.ok(p.includes('只输出正文'))
  assert.ok(p.includes('不要输出 JSON 外壳'))
  assert.ok(p.includes('T-110'))
  assert.ok(p.includes('不要硬编成操作步骤'))
})

test('fallbackLearning：剥 frontmatter 用原文保底且溯源不断', () => {
  const withFm = `---\ntaskId: T-110\nkind: \n---\n\n${DECLARATIVE_BODY}`
  const fb = fallbackLearning('T-110', withFm)
  assert.ok(fb.includes('源自任务 T-110'))
  assert.ok(fb.includes('部署环境'))
  assert.ok(!fb.includes('kind: ')) // frontmatter 已被剥除
})
