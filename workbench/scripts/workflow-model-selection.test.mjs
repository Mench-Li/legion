import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

let modelSelection
try {
  modelSelection = await import('../src/workflowModelSelection.ts')
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
  modelSelection = {}
}

const profiles = [{ id: 'fast', version: 2 }, { id: 'broken', version: 'latest' }]

describe('DAG 阶段模型覆盖选择状态', () => {
  test('DSH 阶段有有效模型档案时显示可选状态', () => {
    assert.equal(modelSelection.workflowModelSelectionState(
      { tool: 'dsh-native', toolConfigRef: null }, [], profiles,
    ), 'selectable')
  })

  test('没有有效模型档案时只使用默认模型并显示空状态', () => {
    assert.equal(modelSelection.workflowModelSelectionState(
      { tool: 'dsh-native', toolConfigRef: null }, [], [{ id: 'broken', version: 'latest' }],
    ), 'no-profiles')
  })

  test('Claude Code 与 Codex 不显示模型覆盖选项', () => {
    for (const tool of ['claude-code', 'codex']) {
      assert.equal(modelSelection.workflowModelSelectionState(
        { tool, toolConfigRef: null }, [], profiles,
      ), 'unsupported')
    }
  })

  test('固定 DSH 配置允许模型覆盖，固定外部配置不允许', () => {
    const stage = { tool: 'dsh-native', toolConfigRef: { id: 'dsh', version: 1 } }
    assert.equal(modelSelection.workflowModelSelectionState(stage, [
      { id: 'dsh', version: 1, adapter: 'dsh-native' },
    ], profiles), 'selectable')
    assert.equal(modelSelection.workflowModelSelectionState(stage, [
      { id: 'dsh', version: 1, adapter: 'dsh-subagent' },
    ], profiles), 'unsupported')
  })

  test('找不到固定配置时不允许猜测其模型能力', () => {
    assert.equal(modelSelection.workflowModelSelectionState(
      { tool: 'dsh-native', toolConfigRef: { id: 'missing', version: 1 } }, [], profiles,
    ), 'missing-config')
  })

  test('已保存模型档案不在当前有效列表时能识别为失效引用', () => {
    assert.equal(modelSelection.workflowModelSelectionState({
      tool: 'dsh-native', toolConfigRef: null, modelConfigRef: { id: 'removed', version: 1 },
    }, [], profiles), 'missing-profile')
  })
})
