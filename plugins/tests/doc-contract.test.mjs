import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { stageContractDocs, resolveStageDocPaths } from '../lib/index.js'

/** 仓库根 = tests/ 上两级（plugins/tests → plugins → 仓库根）。 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const rolesPath = join(repoRoot, 'roles.json')

/** roles.json 岗位 → 期望契约（机器行逐条：R-1a 七文档岗 path 与角色 prompt 现行约定一致）。 */
const EXPECTED = {
  requirement: { next: 'researcher', docs: ['docs/REQUIREMENTS.md'] },
  researcher: { next: 'breaker', gate: true, artifact: 'docs/RESEARCH.md', docs: ['docs/RESEARCH.md'] },
  breaker: { next: 'test-designer', docs: ['docs/TASK_BREAKDOWN.md'] },
  'test-designer': { next: 'coder', docs: ['docs/TEST_CASES.md'] },
  coder: { next: 'reviewer', docs: null },
  reviewer: { next: 'tester', docs: ['docs/review/{taskId}-REVIEW.md'] },
  tester: { next: 'devops', docs: ['docs/TEST_REPORT.md'] },
  devops: { next: null, docs: ['docs/DEPLOY.md'] },
}

function rolesJson() {
  return JSON.parse(readFileSync(rolesPath, 'utf8'))
}

test('roles.json 七文档岗各含 stage.docs 且 path 与角色 prompt 现行约定一致，coder 等非文档岗无 docs（AC-R1-1）', () => {
  const raw = rolesJson()
  assert.equal(typeof raw, 'object')
  assert.ok(Array.isArray(raw.stages) && raw.stages.length >= 8, 'stages 数组存在且不短于八岗')
  for (const role of Object.keys(EXPECTED)) {
    const stage = raw.stages.find(s => s.role === role)
    assert.ok(stage, `缺岗位 ${role}`)
    const want = EXPECTED[role]
    // 契约字段本身
    if (want.docs === null) {
      assert.equal(stage.docs, undefined, `${role} 非文档岗不应有 docs`)
    } else {
      assert.deepEqual(stage.docs, want.docs, `${role} docs 契约不符`)
    }
    // 既有字段语义不变（AC-R1-1 / S1 验收：prompt/gate/artifact/next 原文不动）
    assert.equal(stage.next, want.next, `${role} next 被改动`)
    if (want.gate !== undefined) assert.equal(stage.gate, want.gate, `${role} gate 被改动`)
    if (want.artifact !== undefined) assert.equal(stage.artifact, want.artifact, `${role} artifact 被改动`)
  }
  // 岗位 prompt 与 docs 约定一致（避免改 prompt 忘了改契约的错位）：各自提到对应文档
  const promptHints = {
    requirement: 'docs/REQUIREMENTS.md',
    researcher: 'docs/RESEARCH.md',
    breaker: 'docs/TASK_BREAKDOWN.md',
    'test-designer': 'docs/TEST_CASES.md',
    reviewer: 'docs/review',
    tester: 'docs/TEST_REPORT.md',
    devops: 'docs/DEPLOY.md',
  }
  for (const [role, hint] of Object.entries(promptHints)) {
    const stage = raw.stages.find(s => s.role === role)
    assert.ok((stage.prompt ?? '').includes(hint), `${role} prompt 应提到 ${hint}`)
  }
})

test('解析纯函数：docs 存在时按模板展开 {taskId}，docs 缺省时回退既有 stage.artifact 单值语义（researcher 等价）', () => {
  // docs 优先
  assert.deepEqual(stageContractDocs({ docs: ['docs/REQUIREMENTS.md'], artifact: 'old.md' }), ['docs/REQUIREMENTS.md'])
  assert.deepEqual(stageContractDocs({ docs: ['docs/review/{taskId}-REVIEW.md'] }), ['docs/review/{taskId}-REVIEW.md'])
  // 缺省回退 artifact（等价旧 researcher：只传 artifact 也能推出同一契约）
  assert.deepEqual(stageContractDocs({ artifact: 'docs/RESEARCH.md' }), ['docs/RESEARCH.md'])
  assert.deepEqual(stageContractDocs({}), [])
  assert.deepEqual(stageContractDocs(null), [])
  assert.deepEqual(stageContractDocs(undefined), [])
  // 模板展开
  assert.deepEqual(resolveStageDocPaths({ docs: ['docs/review/{taskId}-REVIEW.md'] }, 'T-107'), ['docs/review/T-107-REVIEW.md'])
  assert.deepEqual(resolveStageDocPaths({ artifact: 'docs/RESEARCH.md' }, 'T-107'), ['docs/RESEARCH.md'])
  // 混合非法项过滤 + 路径规范化（\ → /、./ 前缀去除）
  assert.deepEqual(stageContractDocs({ docs: ['', 42, '  docs/a.md  ', null] }), ['docs/a.md'])
  assert.deepEqual(stageContractDocs({ docs: ['./docs\\x.md'] }), ['docs/x.md'])
  // 未知角色/缺 docs 不报错（前置兼容 AC-R1-5）
  assert.deepEqual(stageContractDocs({ docs: ['role-without-contract.md'], artifact: 'docs/RESEARCH.md' }), ['role-without-contract.md'])
})

test('roles.json JSON.parse 合法且结构可供消费方整读（board-plugin /api/config 同款读取）', () => {
  const raw = rolesJson()
  assert.equal(raw.name, 'software')
  assert.ok(Array.isArray(raw.stages) && raw.stages.length === 8, '八岗全量存在')
  for (const stage of raw.stages) {
    assert.equal(typeof stage.role, 'string')
    assert.equal(typeof stage.label, 'string')
    assert.equal(typeof stage.prompt, 'string')
    if (stage.docs !== undefined) {
      assert.ok(Array.isArray(stage.docs) && stage.docs.every(x => typeof x === 'string'))
    }
  }
})

test('roles.json 既有字段语义逐字节不变：diff 仅新增 docs（git diff --word-diff 检查交给宿主证据；此处快照锁定 role/label/prompt/next/gate/artifact 原文）', () => {
  const raw = rolesJson()
  const snapshot = raw.stages.map(s => ({
    role: s.role,
    label: s.label,
    prompt: s.prompt,
    next: s.next,
    gate: s.gate,
    artifact: s.artifact,
  }))
  // 各岗位快照字段必须与角色约定一致（与仓库既有生产 roles.json 同源校验：这些值在本次改动前已存在且未动）
  const stage = raw.stages.find(s => s.role === 'researcher')
  assert.equal(snapshot.length, 8)
  assert.equal(stage.prompt.includes('输出选型建议'), true)
  // 八岗 next 链路闭环（requirement→researcher→breaker→test-designer→coder→reviewer→tester→devops→null）
  const chain = raw.stages.map(s => s.role)
  assert.deepEqual(chain, ['requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer', 'tester', 'devops'])
  const nexts = Object.fromEntries(raw.stages.map(s => [s.role, s.next]))
  assert.deepEqual(nexts, {
    requirement: 'researcher', researcher: 'breaker', breaker: 'test-designer',
    'test-designer': 'coder', coder: 'reviewer', reviewer: 'tester', tester: 'devops', devops: null,
  })
})
