import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { defaultGoalWorkflowSelection, goalWorkflowOptions } from '../src/goalWorkflowOptions.mjs'

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

  test('同一工作流只向新目标提供最新版本，不要求用户挑历史版本', () => {
    const oldVersion = { id: 'workflow.main', version: 1, name: '方案—实现—审查' }
    const latestVersion = { id: 'workflow.main', version: 3, name: '方案—实现—审查' }
    const anotherWorkflow = { id: 'workflow.quick', version: 2, name: '快速修复' }

    const options = goalWorkflowOptions([oldVersion, latestVersion, anotherWorkflow])

    assert.deepEqual(options.map(option => option.value), ['workflow.main@3', 'workflow.quick@2'])
    assert.equal(options[0].definition, latestVersion)
  })

  test('只有一条已发布工作流时自动选择最新版本；多条时保留空间当前设置', () => {
    const onlyOption = [{ value: 'workflow.main@3' }]
    const severalOptions = [...onlyOption, { value: 'workflow.quick@2' }]

    assert.equal(defaultGoalWorkflowSelection(onlyOption), 'workflow.main@3')
    assert.equal(defaultGoalWorkflowSelection(severalOptions), '')
    assert.equal(defaultGoalWorkflowSelection([]), '')
  })

  test('读取失败或中枢无响应时结束加载并提供重试', () => {
    const loader = apiSource.slice(apiSource.indexOf('export async function fetchAgentWorkflowDefinitions'), apiSource.indexOf('export function registerAgentWorkflowDefinition'))

    assert.match(loader, /hubGet\([^\n]+,\s*15_000\)/, '工作流列表 GET 应有 15 秒请求超时')
    assert.match(goalModalSource, /definitionsError/, '弹窗要保留列表读取错误')
    assert.match(goalModalSource, /重试/, '列表读取失败后要能从弹窗重试')
  })

  test('目标发布文案说明配置入口、最新版本和已发布目标快照', () => {
    assert.match(goalModalSource, /Agent 工作流.*设置页维护/)
    assert.match(goalModalSource, /仅显示每条工作流最新发布的版本/)
    assert.match(goalModalSource, /已发布目标保留创建时的版本/)
  })
})
