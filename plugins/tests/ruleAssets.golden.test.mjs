// P1-4.4 golden 测试：真实注入路径闭环 —— LEGION.md 文件族 → norms 拼装产物 → ruleAssets doctor 校验
// 断言：doctor 对真实注入产物全量 present；注入产物字节稳定（golden 快照）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildNormSections, REPO_RULES_HEADER } from '../lib/norms.js'
import { runRuleDoctor, splitNormUnits } from '../lib/ruleAssets.js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// 真实 LEGION.md（仓库根 plugins/../..，空间层单文件现状）
const LEGION_MD = readFileSync(join(here, '..', '..', 'LEGION.md'), 'utf8')

test('golden-1：真实 LEGION.md 兼容单文件形态注入产物字节稳定（golden 快照）', () => {
  const { sections } = buildNormSections({ globalText: '', files: [{ label: 'LEGION.md', content: LEGION_MD }] })
  assert.equal(sections.length, 1)
  assert.ok(sections[0].startsWith(REPO_RULES_HEADER + '\n# LEGION.md'))
  // 注入产物应与直接拼装逐字一致（字节 golden）
  const expected = REPO_RULES_HEADER + '\n' + LEGION_MD
  assert.equal(sections[0], expected)
})

test('golden-2：真实 LEGION.md → doctor 全量 present（将军规则确实进了提示词）', () => {
  const { sections, truncated } = buildNormSections({ globalText: '', files: [{ label: 'LEGION.md', content: LEGION_MD }] })
  const rep = runRuleDoctor({
    files: [{ label: 'LEGION.md', content: LEGION_MD }],
    globalText: '',
    injectedText: sections.join('\n'),
    truncated,
  })
  assert.equal(rep.ok, true)
  assert.equal(rep.truncated, false)
  assert.ok(rep.items.length >= 4, `真实 LEGION.md 至少 4 个 ## 规则单元（实际 ${rep.items.length}）`)
  for (const it of rep.items) {
    assert.equal(it.present, true, `单元「${it.title}」应 present`)
    assert.equal(it.source, 'LEGION.md')
  }
  // 抽查标题集：将军实际维护的规则标题都应在
  const titles = rep.items.map(i => i.title)
  for (const t of ['变更纪律', '代码纪律', '规范分层总纲（R-2）', '完成回报']) {
    assert.ok(titles.includes(t), `缺规则单元「${t}」`)
  }
})

test('golden-3：真实注入产物里逐单元指纹唯一（不因指纹前 140 字重合而误合并）', () => {
  const units = splitNormUnits('LEGION.md', LEGION_MD)
  const fps = units.map(u => u.fingerprint)
  assert.equal(new Set(fps).size, fps.length, '各单元指纹应互异')
})

test('golden-4：doctor 能发现真实"被截断"场景（超长注入源时规则没进提示词）', () => {
  // 两段形态（有全局层 → 不走兼容分支）下人为制造超长空间层（超过 spaceMax 2000）
  // → norms 按段落边界截断保前弃后 → 尾部规则单元 fingerprint missing → doctor 报缺失。
  const globalText = '## 全局验收纪律\n- 将军一句话验收才算 done。'
  const longContent = LEGION_MD + '\n\n## 尾部补充规则\n' + ('- 一条很长的补充规则，重复填充超过预算阈值。'.repeat(60))
  const { sections, truncated } = buildNormSections(
    { globalText, files: [{ label: 'LEGION.md', content: longContent }] },
    { spaceMax: 2000, totalMax: 0 },
  )
  const rep = runRuleDoctor({
    files: [{ label: 'LEGION.md', content: longContent }],
    globalText,
    injectedText: sections.join('\n'),
    truncated,
  })
  assert.equal(rep.truncated, true)
  const missing = rep.items.filter(i => !i.present)
  assert.ok(missing.length > 0, '超长时应有规则单元被判 missing')
  // 尾部被截断的单元一定是 missing（预算保前弃后）
  const tailMissing = missing.some(i => i.title === '尾部补充规则')
  assert.equal(tailMissing, true, '尾部补充规则应因截断缺失')
})
