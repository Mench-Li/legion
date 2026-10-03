import assert from 'node:assert/strict'
import test from 'node:test'

import { expectedExternalPermissionMode, externalPermissionProfile } from './agent-provider-policy.mjs'

test('supported DSH external tools freeze exact native permission modes', () => {
  assert.equal(externalPermissionProfile('codex'), 'codex-workspace-write')
  assert.equal(externalPermissionProfile('claude-code'), 'claude-code-acceptEdits')
  assert.equal(expectedExternalPermissionMode({ adapter: 'dsh-subagent', providerName: 'codex', permissionProfile: 'codex-workspace-write' }), 'approve-for-me')
  assert.equal(expectedExternalPermissionMode({ adapter: 'dsh-subagent', providerName: 'claude-code', permissionProfile: 'claude-code-acceptEdits' }), 'acceptEdits')
})

test('unknown providers and ambiguous or dangerous profile aliases do not resolve', () => {
  assert.equal(expectedExternalPermissionMode({ adapter: 'dsh-subagent', providerName: 'codex', permissionProfile: 'codex-native-default' }), null)
  assert.equal(expectedExternalPermissionMode({ adapter: 'dsh-subagent', providerName: 'codex', permissionProfile: 'dangerously-bypass-approvals-and-sandbox' }), null)
  assert.equal(expectedExternalPermissionMode({ adapter: 'dsh-subagent', providerName: 'claude-code', permissionProfile: 'claude-code-dontAsk' }), null)
  assert.equal(expectedExternalPermissionMode({ adapter: 'dsh-subagent', providerName: 'custom-codex', permissionProfile: 'codex-workspace-write' }), null)
  assert.equal(expectedExternalPermissionMode({ adapter: 'dsh-native', providerName: 'deepseek', permissionProfile: 'dsh-native:deepseek' }), null)
})
