import test from 'node:test'
import assert from 'node:assert/strict'
import {
  renderSkillMd, parseSkillMarker, planSkillSync, parseSkillTombstones,
} from '../lib/skillsBridge.js'

const skill = (id, hash = 'abc123') => ({
  id, name: id, description: 'desc', body: `【${id}】\n主指引内容`, contentHash: hash,
})

test('renderSkillMd：frontmatter(name=id/description) + body + legion marker 行', () => {
  const md = renderSkillMd(skill('code-review-checklist', 'h1'))
  assert.ok(md.startsWith('---\nname: code-review-checklist\ndescription: desc\n---'))
  assert.ok(md.includes('主指引内容'))
  assert.ok(md.includes('<!-- legion-skill: code-review-checklist: h1 -->'))
})

test('parseSkillMarker：解析 id/hash；无 marker → null', () => {
  const md = renderSkillMd(skill('ozon-listing', 'h2'))
  assert.deepEqual(parseSkillMarker(md), { id: 'ozon-listing', hash: 'h2' })
  assert.equal(parseSkillMarker('# 纯手工技能\n没有 marker'), null)
  assert.equal(parseSkillMarker(''), null)
})

test('planSkillSync：首次同步 → 全部 desired writes', () => {
  const plan = planSkillSync([skill('a', 'h1'), skill('b', 'h2')], new Map(), new Set())
  assert.equal(plan.changed, true)
  assert.deepEqual(plan.writes.map(w => w.id).sort(), ['a', 'b'])
  assert.deepEqual(plan.deletes, [])
})

test('planSkillSync：hash 未变不重写（幂等）；hash 变则更新', () => {
  const existing = new Map([['a', renderSkillMd(skill('a', 'h1'))]])
  const p1 = planSkillSync([skill('a', 'h1')], existing, new Set())
  assert.equal(p1.changed, false)
  assert.deepEqual(p1.writes, [])
  const p2 = planSkillSync([skill('a', 'h2')], existing, new Set())
  assert.equal(p2.changed, true)
  assert.deepEqual(p2.writes.map(w => w.id), ['a'])
  assert.ok(p2.writes[0].content.includes('h2'))
})

test('planSkillSync：desired 同名目录无 marker → 被本桥接管（写入 marker 版）', () => {
  const existing = new Map([['a', '# 手动创建的同名技能\n没有 legion marker']])
  const plan = planSkillSync([skill('a', 'h1')], existing, new Set())
  assert.equal(plan.changed, true)
  assert.deepEqual(plan.writes.map(w => w.id), ['a'])
})

test('planSkillSync：本桥曾写但已停用 → 有 tombstone 才删；无 tombstone 保留', () => {
  const mine = renderSkillMd(skill('gone', 'h1'))
  const synced = renderSkillMd(skill('a', 'h1'))
  const existing = new Map([['a', synced], ['gone', mine]])
  const p1 = planSkillSync([skill('a', 'h1')], existing, new Set())
  assert.equal(p1.changed, false) // a 已同步无变化；gone 保留（未确认停用）
  assert.deepEqual(p1.writes, [])
  assert.deepEqual(p1.deletes, [])
  const p2 = planSkillSync([skill('a', 'h1')], existing, new Set(['gone']))
  assert.equal(p2.changed, true)
  assert.deepEqual(p2.writes, [])
  assert.deepEqual(p2.deletes, [{ id: 'gone' }])
})

test('planSkillSync：非本桥目录（个人技能）绝不动（即使同名不在 desired）', () => {
  const personal = new Map([
    ['a', renderSkillMd(skill('a', 'h1'))],
    ['mine', '# 我的个人技能\n无 marker'],
  ])
  const plan = planSkillSync([skill('a', 'h1')], personal, new Set(['mine']))
  assert.equal(plan.changed, false)
  assert.deepEqual(plan.writes, [])
  assert.deepEqual(plan.deletes, [])
})

test('parseSkillTombstones：注释/空行跳过，返回停用 id 集合', () => {
  const removed = parseSkillTombstones('# 停用说明\nold-skill\n\nexp-t004\n')
  assert.deepEqual([...removed].sort(), ['exp-t004', 'old-skill'])
  assert.equal(parseSkillTombstones(null).size, 0)
  assert.equal(parseSkillTombstones('').size, 0)
})
