// plugins/tests/space-pipeline.test.mjs — SP-P0 守护侧契约：hub 空间流水线载荷解析。
//
// 覆盖目标：数据面（hub GET /api/pipeline）成为流水线单源后，**坏远端数据绝不能污染守护运行态**；
// 以及「未配置数据面流水线」必须能被识别为空数组（→ 回退部署面 rolesFile）。
// 运行：node --test plugins/tests/space-pipeline.test.mjs（需先 build：lib/index.js 为被测产物）
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { stagesFromHubPayload } from '../lib/index.js'

describe('TC-SP-P0-D1 hub 载荷 → StageDef：正常映射', () => {
  it('逐字段映射：role/label/prompt/next/gate/artifact/docs', () => {
    const stages = stagesFromHubPayload([
      { role: 'soldier-research', label: '需求调研', prompt: '调研……', next: 'soldier-selection', gate: false, docs: ['research/ozon/rerun-brief.md'] },
      { role: 'soldier-selection', label: '选品与类目', prompt: '选品……', next: null, gate: true, artifact: 'docs/REQUIREMENTS.md' },
    ])
    assert.equal(stages.length, 2)
    assert.deepEqual(stages[0], {
      role: 'soldier-research', label: '需求调研', prompt: '调研……',
      next: 'soldier-selection', gate: false, docs: ['research/ozon/rerun-brief.md'],
    })
    assert.deepEqual(stages[1], {
      role: 'soldier-selection', label: '选品与类目', prompt: '选品……',
      next: null, gate: true, artifact: 'docs/REQUIREMENTS.md',
    })
    assert.equal('artifact' in stages[0], false, '无 artifact 不落 undefined 键（避免下游用 in 判断踩坑）')
    assert.equal('docs' in stages[1], false)
  })

  it('顺序保持提交顺序（排序由 hub 负责：sort 字段）', () => {
    const stages = stagesFromHubPayload([{ role: 'b' }, { role: 'a' }, { role: 'c' }])
    assert.deepEqual(stages.map(s => s.role), ['b', 'a', 'c'])
  })

  it('label 缺省回落 role；prompt 缺省为空串；next 空串/null 归一为 null（末环）', () => {
    const stages = stagesFromHubPayload([
      { role: 'only-role' },
      { role: 'tail', label: '  ', next: '' },
    ])
    assert.equal(stages[0].label, 'only-role')
    assert.equal(stages[0].prompt, '')
    assert.equal(stages[0].next, null)
    assert.equal(stages[1].label, 'tail')
    assert.equal(stages[1].next, null)
    assert.equal(stages[1].gate, false)
  })
})

describe('TC-SP-P0-D2 防御式解析：坏数据整条丢弃，绝不半更新', () => {
  it('非数组 / null / 字符串 → 空数组（= 未配置数据面流水线，回退部署面）', () => {
    for (const bad of [null, undefined, 'x', 42, {}, { stages: [] }]) {
      assert.deepEqual(stagesFromHubPayload(bad), [], JSON.stringify(bad) + ' 应为空')
    }
  })

  it('数组内坏元素逐条丢弃，好元素照常保留', () => {
    const stages = stagesFromHubPayload([
      null, 'str', 7, [],
      { role: '' }, { role: '   ' }, { label: '无 role 的项' },
      { role: 'good-one', label: '好岗位' },
    ])
    assert.deepEqual(stages.map(s => s.role), ['good-one'])
  })

  it('字段类型错位被归一而非透传（gate 非 true 即 false；docs 逐项过滤非字符串）', () => {
    const stages = stagesFromHubPayload([{
      role: 'r1', label: 123, prompt: { a: 1 }, next: 42, gate: 'yes',
      artifact: '   ', docs: ['ok.md', 3, null, '  ', 'x/y.md'],
    }])
    assert.equal(stages.length, 1)
    const s = stages[0]
    assert.equal(s.label, 'r1', 'label 非字符串 → 回落 role')
    assert.equal(s.prompt, '', 'prompt 非字符串 → 空串（不把对象塞进提示词）')
    assert.equal(s.next, null, 'next 非字符串 → null')
    assert.equal(s.gate, false, 'gate 必须严格 === true')
    assert.equal('artifact' in s, false, '空白 artifact → 省略（等价于无闸门产物）')
    assert.deepEqual(s.docs, ['ok.md', 'x/y.md'], 'docs 只保留非空字符串')
  })

  it('role 前后空白被裁剪（hub 与编队逐字对齐的前提）', () => {
    const stages = stagesFromHubPayload([{ role: '  soldier-listing  ' }])
    assert.equal(stages[0].role, 'soldier-listing')
  })

  it('大量阶段不截断（守护按 hub 为准，裁剪是 hub 侧职责）', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ role: 'r' + i }))
    assert.equal(stagesFromHubPayload(many).length, 40)
  })
})
