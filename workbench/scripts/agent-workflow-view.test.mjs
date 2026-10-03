import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { formatCodexSystemProxyMode } from '../src/agentWorkflowView.ts'

describe('Codex proxy status shown for each execution node', () => {
  test('system identifies configured system mode and its development-stage caveat', () => {
    assert.match(formatCodexSystemProxyMode('system'), /已配置系统代理/)
    assert.match(formatCodexSystemProxyMode('system'), /respect_system_proxy/)
    assert.match(formatCodexSystemProxyMode('system'), /需本节点实测/)
  })

  test('inherit does not misleadingly claim that the connection is direct', () => {
    const label = formatCodexSystemProxyMode('inherit')
    assert.match(label, /未强制系统代理/)
    assert.match(label, /代理环境变量/)
    assert.match(label, /仍可能走代理/)
  })

  test('missing or unknown heartbeat data says proxy use cannot be determined', () => {
    for (const mode of [null, undefined, 'unknown', 1]) {
      assert.match(formatCodexSystemProxyMode(mode), /无法判断此节点是否走代理/)
    }
  })
})
