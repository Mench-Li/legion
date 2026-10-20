import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { goalWorkflowOptions } from '../src/goalWorkflowOptions.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const goalModalSource = readFileSync(join(root, 'src', 'components', 'GoalModal.tsx'), 'utf8')
const apiSource = readFileSync(join(root, 'src', 'api.ts'), 'utf8')

describe('发布目标的可选工作流', () => {
  test('保留已发布的并行汇合 DAG，不把它限制成三阶段线性链', () => {
    const parallelDag = {
      id: 'workflow.parallel', version: 2, name: '设计后并行开发与测试',
      stages: [
        { id: 'design', role: 'designer' },
        { id: 'implement', role: 'coder' },
        { id: 'test', role: 'tester' },
        { id: 'review', role: 'reviewer' },
      ],
      edges: [
        { from: 'design', to: 'implement' },
        { from: 'design', to: 'test' },
        { from: 'implement', to: 'review' },
        { from: 'test', to: 'review' },
      ],
    }

    const options = goalWorkflowOptions([parallelDag])

    assert.equal(options.length, 1)
    assert.equal(options[0].value, 'workflow.parallel@2')
    assert.equal(options[0].label, '设计后并行开发与测试 · v2')
    assert.equal(options[0].definition, parallelDag)
  })

  test('读取失败或中枢无响应时结束加载并提供重试', () => {
    const loader = apiSource.slice(apiSource.indexOf('export async function fetchAgentWorkflowDefinitions'), apiSource.indexOf('export function registerAgentWorkflowDefinition'))

    assert.match(loader, /hubGet\([^\n]+,\s*15_000\)/, '工作流列表 GET 应有 15 秒请求超时')
    assert.match(goalModalSource, /definitionsError/, '弹窗要保留列表读取错误')
    assert.match(goalModalSource, /重试/, '列表读取失败后要能从弹窗重试')
  })
})
