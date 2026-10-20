import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { findReusableAgentToolConfig, matchesAgentToolConfig } from '../src/agentToolConfigCompatibility.mjs'

const expected = {
  providerName: 'spawn',
  adapter: 'dsh-native',
  permissionProfile: 'dsh-native:spawn',
  capabilities: {
    textInput: true,
    textOutput: true,
    outputSchema: true,
    toolFilter: false,
    localAgent: true,
    sessionResume: false,
    cancellation: true,
  },
}

const config = (version, toolFilter) => ({
  id: 'tool.dsh-spawn', version, providerName: 'spawn', adapter: 'dsh-native',
  permissionProfile: 'dsh-native:spawn', enabled: true,
  capabilities: {
    textInput: true,
    textOutput: true,
    outputSchema: true,
    toolFilter,
    localAgent: true,
    sessionResume: false,
    cancellation: true,
  },
})

describe('工作流发布使用当前兼容的 Agent 工具配置', () => {
  test('旧固定版本与节点最新能力不一致时判定为过期', () => {
    assert.equal(matchesAgentToolConfig(config(1, true), expected), false)
  })

  test('只复用能力匹配的启用配置，并取最高兼容版本', () => {
    const old = config(1, true)
    const current = config(2, false)

    assert.equal(findReusableAgentToolConfig([old, current], expected), current)
    assert.equal(findReusableAgentToolConfig([old], expected), null)
  })

  test('能力对象的键顺序不同不影响兼容判断', () => {
    const reordered = config(2, false)
    reordered.capabilities = Object.fromEntries(Object.entries(reordered.capabilities).reverse())

    assert.equal(matchesAgentToolConfig(reordered, expected), true)
  })
})
