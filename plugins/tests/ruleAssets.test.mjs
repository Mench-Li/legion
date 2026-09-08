import test from 'node:test'
import assert from 'node:assert/strict'
import {
  splitNormUnits, fingerprintOf, unitPresentIn, parseTombstones, applyTombstones,
  sourceMarkerIn, runRuleDoctor,
} from '../lib/ruleAssets.js'

const LEGION = `# LEGION.md —— 军团仓库规则

## 变更纪律

- 改动只落在当前 worktree。
- 不要 push。

## 代码纪律

- 所有变更必须真实验证。

## 规范分层总纲（R-2）

仓库规则分层注入。
`

test('按 ## 二级标题切分规则单元；无标题时整文本一个单元', () => {
  const units = splitNormUnits('LEGION.md', LEGION)
  assert.equal(units.length, 3)
  assert.equal(units[0].source, 'LEGION.md')
  assert.equal(units[0].title, '变更纪律')
  assert.ok(units[0].body.includes('改动只落在当前 worktree'))
  assert.equal(units[2].title, '规范分层总纲（R-2）')
  // 无 ## 的纯文本 → 1 个单元，title = 首行前 24 字
  const plain = splitNormUnits('agent.md', '第一行规则\n第二行细节\n')
  assert.equal(plain.length, 1)
  assert.equal(plain[0].title, '第一行规则')
  assert.ok(plain[0].body.includes('第二行细节'))
  // 空文本 → 无单元
  assert.equal(splitNormUnits('x.md', '   \n').length, 0)
})

test('fingerprint 忽略空白差异；截断到前 140 字防指纹随长规则全文增长', () => {
  const a = fingerprintOf('第 一行\n第二 行', '标题甲')
  const b = fingerprintOf('第一行第二行', '标题甲')
  assert.equal(a, b)
  const long = '字'.repeat(400)
  const fp = fingerprintOf(long, '长标题')
  assert.ok(fp.length <= 140)
})

test('unitPresentIn：注入文本含单元指纹（空白归一后）判 present，缺则 missing', () => {
  const unit = splitNormUnits('LEGION.md', '## 变更纪律\n- 不要 push。\n')[0]
  assert.equal(unitPresentIn(unit, '## 变更纪律\n- 不要 push。\n'), true)
  assert.equal(unitPresentIn(unit, '   ##   变更纪律   \n- 不要\npush。  '), true) // 空白/换行差异可忽略
  assert.equal(unitPresentIn(unit, '## 变更纪律\n- 不要 push'), false) // 尾字被截 → missing
  assert.equal(unitPresentIn(unit, ''), false)
})

test('tombstone：解析注释/空行；按文件名过滤注入源文件族', () => {
  const removed = parseTombstones('# 停用说明\nAGENTS.md\n\nagent.md\n')
  assert.deepEqual([...removed].sort(), ['AGENTS.md', 'agent.md'])
  const files = [
    { label: 'LEGION.md', content: 'a' },
    { label: 'AGENTS.md', content: 'b' },
    { label: 'agent.md', content: 'c' },
  ]
  const active = applyTombstones(files, removed)
  assert.deepEqual(active.map(f => f.label), ['LEGION.md'])
  assert.equal(applyTombstones(files, new Set()).length, 3)
})

test('sourceMarkerIn：空间层文件 marker 与全局层 header 归属校验', () => {
  const text = '【来源：仓库文件 LEGION.md】\n内容\n【来源：仓库文件 AGENTS.md】\n更多\n全局规范（必须遵守，来自 team-hub rules 全局层）：\n全局规则'
  assert.equal(sourceMarkerIn('LEGION.md', text), true)
  assert.equal(sourceMarkerIn('AGENTS.md', text), true)
  assert.equal(sourceMarkerIn('agent.md', text), false)
  assert.equal(sourceMarkerIn('global', text), true)
})

test('runRuleDoctor：全量 present 且无截断 → ok', () => {
  const files = [{ label: 'LEGION.md', content: '## 变更纪律\n- 不要 push。' }]
  const injected = '【来源：仓库文件 LEGION.md】\n## 变更纪律\n- 不要 push。\n'
  const rep = runRuleDoctor({ files, globalText: '', injectedText: injected, truncated: false })
  assert.equal(rep.ok, true)
  assert.equal(rep.items.length, 1)
  assert.equal(rep.items[0].present, true)
  assert.deepEqual(rep.removedSources, [])
})

test('runRuleDoctor：规则被预算截断吞掉 → missing 且 ok=false（doctor 发现规则没进提示词）', () => {
  const files = [{ label: 'LEGION.md', content: '## 变更纪律\n- 不要 push。\n## 代码纪律\n- 必须真实验证。' }]
  // 模拟 norms 预算截断：只注入前一个单元，注入文本带截断说明
  const injected = '【来源：仓库文件 LEGION.md】\n## 变更纪律\n- 不要 push。\n（规范超限截断…）'
  const rep = runRuleDoctor({ files, globalText: '', injectedText: injected, truncated: true })
  assert.equal(rep.ok, false)
  assert.equal(rep.truncated, true)
  const missing = rep.items.filter(i => !i.present)
  assert.equal(missing.length, 1)
  assert.equal(missing[0].title, '代码纪律')
  assert.equal(missing[0].source, 'LEGION.md')
})

test('runRuleDoctor：tombstone 停用的源不进 desired-set（不误报缺失）', () => {
  const files = [
    { label: 'LEGION.md', content: '## 变更纪律\n- 不要 push。' },
    { label: 'AGENTS.md', content: '## 旧规则\n已停用内容。' },
  ]
  const injected = '【来源：仓库文件 LEGION.md】\n## 变更纪律\n- 不要 push。\n'
  const removed = new Set(['AGENTS.md'])
  const rep = runRuleDoctor({ files, globalText: '', injectedText: injected, removed })
  assert.equal(rep.ok, true) // AGENTS.md 被停用不算缺失
  assert.deepEqual(rep.removedSources, ['AGENTS.md'])
  assert.equal(rep.items.length, 1)
})

test('runRuleDoctor：全局层规则也逐条校验（marker=全局 header）', () => {
  const files = []
  const globalText = '## 全局验收纪律\n- 将军一句话验收才算 done。'
  const injected = '全局规范（必须遵守，来自 team-hub rules 全局层）：\n## 全局验收纪律\n- 将军一句话验收才算 done。'
  const rep = runRuleDoctor({ files, globalText, injectedText: injected })
  assert.equal(rep.ok, true)
  assert.equal(rep.items[0].source, 'global')
  assert.equal(rep.items[0].title, '全局验收纪律')
  // 全局层没进注入 → missing
  const rep2 = runRuleDoctor({ files, globalText, injectedText: '' })
  assert.equal(rep2.ok, false)
  assert.equal(rep2.items[0].present, false)
})
