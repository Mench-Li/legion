// plugins/tests/norms.test.mjs — S5（R-2）分层规范合并/预算截断纯函数契约。
// 运行：node plugins/tests/norms.test.mjs；依赖 pnpm build 产物 plugins/lib。
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildNormSections, truncateNormsText, REPO_RULES_HEADER } from '../lib/norms.js'

const LEGION = 'LEGION.md'; const AGENTS = 'AGENTS.md'; const AGENT = 'agent.md'

test('TC-S5-01 两段顺序稳定：先全局层段、后空间层段；空间层带优先级声明与来源标注', () => {
  const r = buildNormSections({ globalText: 'G全局规范内容', files: [{ label: AGENT, content: 'S空间规范内容' }] })
  assert.equal(r.sections.length, 2)
  assert.ok(r.sections[0].includes('全局规范（必须遵守，来自 team-hub rules 全局层）'), '全局段头')
  assert.ok(r.sections[0].includes('G全局规范内容'))
  assert.ok(r.sections[1].includes('空间/项目层规范（优先于全局层，必须遵守）'), '空间段优先级声明')
  assert.ok(r.sections[1].includes('agent.md'), '空间段来源标注')
  assert.ok(r.sections[1].includes('S空间规范内容'))
})

test('TC-S5-02 文件族组合：①三文件按序读全部 ②仅 LEGION ③仅 agent.md ④全缺', () => {
  const all = buildNormSections({ globalText: '', files: [
    { label: LEGION, content: 'L1' },
    { label: AGENTS, content: 'A1' },
    { label: AGENT, content: 'a1' },
  ] })
  assert.equal(all.sections.length, 1, '无全局层 → 仅空间层段')
  const pos = (s) => all.sections[0].indexOf(s)
  assert.ok(pos('L1') < pos('A1') && pos('A1') < pos('a1'), '文件按 LEGION→AGENTS→agent.md 固定序')
  assert.ok(all.sections[0].includes('【来源：仓库文件 LEGION.md】'))
  const only = buildNormSections({ globalText: '', files: [{ label: LEGION, content: 'L-L' }] })
  assert.equal(only.sections.length, 1)
  assert.ok(only.sections[0].startsWith(REPO_RULES_HEADER))
  const onlyAgent = buildNormSections({ globalText: '', files: [{ label: AGENT, content: 'GGG' }] })
  assert.ok(onlyAgent.sections[0].includes('GGG'))
  assert.ok(onlyAgent.sections[0].includes('agent.md'))
  const none = buildNormSections({ globalText: '', files: [] })
  assert.deepEqual(none.sections, [])
})

test('TC-S5-03 兼容回归：仅 LEGION.md 且无全局层 → 与现状 readRepoRules 逐字一致', () => {
  const content = '# 军团规则\n第一条：只做实现与验证。'
  const r = buildNormSections({ globalText: '', files: [{ label: LEGION, content }] })
  assert.equal(r.sections[0], REPO_RULES_HEADER + '\n' + content, '逐字一致（含段首文案）')
})

test('TC-S5-04 无全局无文件 → 不输出规范段、不报错', () => {
  const r = buildNormSections({ globalText: '', files: [] })
  assert.deepEqual(r.sections, [])
  assert.equal(r.truncated, false)
})

test('TC-S5-05 预算截断：分层超限+提示真实数字+代码围栏不半截+合计超限', () => {
  const bigGlobal = '段落一：' + 'x'.repeat(40) + '\n\n段落二：' + 'y'.repeat(40)
  const g = truncateNormsText(bigGlobal, 60)
  assert.ok(g.truncated)
  assert.match(g.body, /规范超限截断：原文 \d+ 字，已保留前 \d+ 字/)
  const codeBlock = '```\ncode line 1\ncode line 2\n```\n\n说明段落。'
  const c = truncateNormsText(codeBlock, 40)
  const open = (c.body.match(/```/g) ?? []).length
  assert.equal(open % 2, 0, '输出围栏配对（无半截代码块）')
  const gl = 'g'.repeat(3500); const sp = 's'.repeat(4000)
  const r = buildNormSections({ globalText: gl, files: [{ label: AGENT, content: sp }] }, { globalMax: 4000, spaceMax: 4000, totalMax: 7000 })
  assert.ok(r.sections[0].length + r.sections[1].length <= 7000 + 160, '合计 ≤ 总预算+提示开销')
  assert.ok(r.sections[1].includes('空间/项目层规范'), '空间层段保留')
})

test('TC-S5-06 预算可配（三值法）：恰 100 全量；101 → 截断+提示', () => {
  const c100 = 'c'.repeat(100)
  assert.equal(truncateNormsText(c100, 100).truncated, false, '恰 100 不截断')
  const t = truncateNormsText(c100 + 'x', 100)
  assert.ok(t.truncated, '101 → 截断')
  const r = buildNormSections({ globalText: c100 + 'x', files: [] }, { globalMax: 100 })
  assert.ok(r.truncated)
  assert.ok(r.sections[0].includes('规范超限截断'))
})

test('TC-S5-08 全局层来源缺失 → 降级只用空间层段，不报错', () => {
  const r = buildNormSections({ globalText: '', files: [{ label: AGENT, content: 'SPACE' }] })
  assert.equal(r.sections.length, 1)
  assert.ok(r.sections[0].includes('SPACE'))
})
