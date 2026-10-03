import test from 'node:test'
import assert from 'node:assert/strict'
import { agentOptionsForFrozenModel } from './agent-model-selection.mjs'

const ref = { id: 'model.coder', version: 4 }
const resolved = { ...ref, provider: 'custom-ds', model: 'coder-v4', reasoningEffort: 'high' }
const nativeTool = { adapter: 'dsh-native' }

test('冻结模型快照只生成不含凭据的 DSH agentOptions', () => {
  assert.deepEqual(agentOptionsForFrozenModel({
    modelRef: ref, resolvedModel: resolved, agentToolConfig: nativeTool,
    providerCapabilities: { agentOptions: true },
  }), { provider: 'custom-ds', model: 'coder-v4', reasoningEffort: 'high' })
})

test('没有模型引用时不注入任何运行参数', () => {
  assert.equal(agentOptionsForFrozenModel({ modelRef: null, resolvedModel: null }), null)
})

test('拒绝版本不匹配、外部 Agent 及不支持 agentOptions 的 provider', () => {
  assert.throws(() => agentOptionsForFrozenModel({
    modelRef: ref, resolvedModel: { ...resolved, version: 3 }, agentToolConfig: nativeTool,
    providerCapabilities: { agentOptions: true },
  }), /引用与冻结解析结果不匹配/)
  assert.throws(() => agentOptionsForFrozenModel({
    modelRef: ref, resolvedModel: resolved, agentToolConfig: { adapter: 'dsh-subagent' },
    providerCapabilities: { agentOptions: true },
  }), /只支持 DSH 原生/)
  assert.throws(() => agentOptionsForFrozenModel({
    modelRef: ref, resolvedModel: resolved, agentToolConfig: nativeTool,
    providerCapabilities: { agentOptions: false },
  }), /拒绝忽略冻结模型/)
})
