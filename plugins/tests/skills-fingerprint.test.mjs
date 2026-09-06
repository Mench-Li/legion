// plugins/tests/skills-fingerprint.test.mjs — S3（R-1）守护技能缓存指纹纯函数契约。
// 运行：node plugins/tests/skills-fingerprint.test.mjs（宿主 node --test 同义）；依赖 pnpm build 产物 plugins/lib。
import assert from 'node:assert/strict'
import test from 'node:test'
import { skillsFingerprint, skillsChanged } from '../lib/skillsCache.js'

const S = (over = {}) => ({ id: 'skill-a', name: '技能A', prompt: 'p', version: 1, contentHash: 'h1', ...over })

test('TC-S3-02 同指纹不刷新：相同内容/数量/成员 → skillsChanged=false', () => {
  const a = [S(), S({ id: 'skill-b', version: 1, contentHash: 'h2' })]
  const b = [S(), S({ id: 'skill-b', version: 1, contentHash: 'h2' })]
  assert.equal(skillsChanged(a, b), false)
  assert.equal(skillsFingerprint(a), skillsFingerprint(b))
})

test('TC-S3-06 顺序变化不视为变化（排序指纹），不崩', () => {
  const a = [S(), S({ id: 'skill-b', version: 1, contentHash: 'h2' })]
  const b = [S({ id: 'skill-b', version: 1, contentHash: 'h2' }), S()]
  assert.equal(skillsChanged(a, b), false, '同集合顺序互换 → 不刷新')
})

test('TC-S3-01 同量内容改版（version+1/contentHash 变化）→ 刷新', () => {
  const prev = [S()]
  const next = [S({ version: 2, contentHash: 'h1b' })]
  assert.equal(skillsChanged(prev, next), true, '同数量改版 → changed')
  const onlyHash = [S({ contentHash: 'h-other' })]
  assert.equal(skillsChanged(prev, onlyHash), true, '仅 contentHash 变 → changed')
})

test('TC-S3-03 撤销移除（数量/成员变化）→ 刷新；新授权加入 → 刷新', () => {
  const two = [S(), S({ id: 'skill-b' })]
  assert.equal(skillsChanged(two, [S()]), true, '移除 → changed')
  assert.equal(skillsChanged([S()], two), true, '新增 → changed')
})

test('TC-S3-05/06 空列表不崩；空→非空 / 非空→空均触发刷新', () => {
  assert.equal(skillsChanged([], []), false)
  assert.equal(skillsChanged([], [S()]), true)
  assert.equal(skillsChanged([S()], []), true)
  assert.equal(skillsFingerprint([S(), { id: 'x' }]), skillsFingerprint([{ id: 'x' }, S()]))
})

test('TC-S3-04 授权-撤销端到端指纹（纯函数视角）：状态机走查', () => {
  const cache = [S()] // 守护缓存：已授权技能
  // 授权：新条目入列 → changed
  const afterGrant = [...cache, S({ id: 'skill-c', version: 1, contentHash: 'hc' })]
  assert.equal(skillsChanged(cache, afterGrant), true)
  // 撤销：回到原集合 → 相对当前缓存 changed → 刷新回原集合
  assert.equal(skillsChanged(afterGrant, cache), true)
})
