import assert from 'node:assert/strict'
import test from 'node:test'
import { subagentProviderCapabilities, subagentProviderPermissionMode } from './subagent-client.mjs'

function contextFor(provider) {
  return {
    subagents: {
      getProvider(name) { return name === 'codex' ? provider : undefined },
    },
  }
}

test('reads the effective permission mode from DSH provider config', () => {
  const ctx = contextFor({
    capabilities: {},
    config: { permissionMode: 'approve-for-me' },
  })

  assert.equal(subagentProviderPermissionMode(ctx, 'codex'), 'approve-for-me')
  assert.deepEqual(subagentProviderCapabilities(ctx, 'codex'), {
    outputSchema: false,
    toolFilter: false,
    cancellation: true,
    permissionMode: 'approve-for-me',
  })
})

test('keeps compatibility with providers exposing permissionMode at top level', () => {
  const ctx = contextFor({
    capabilities: {},
    permissionMode: 'approve-for-me',
    config: { permissionMode: 'never' },
  })

  assert.equal(subagentProviderPermissionMode(ctx, 'codex'), 'approve-for-me')
})
