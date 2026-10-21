import assert from 'node:assert/strict'
import test from 'node:test'
import { dshWorkflowCapabilityMismatch } from '../lib/workflowCapabilities.js'

test('treats an omitted provider toolFilter capability as false like the hub heartbeat does', () => {
  const mismatch = dshWorkflowCapabilityMismatch(
    { outputSchema: true },
    { outputSchema: true, toolFilter: false },
    false,
  )

  assert.equal(mismatch, null)
})

test('rejects a missing structured output capability required by the frozen workflow', () => {
  const mismatch = dshWorkflowCapabilityMismatch(
    { outputSchema: false },
    { outputSchema: true, toolFilter: false },
    false,
  )

  assert.match(mismatch, /outputSchema/)
})

test('rejects a missing tool filter only when the worker has deny rules', () => {
  const mismatch = dshWorkflowCapabilityMismatch(
    { outputSchema: true },
    { outputSchema: true, toolFilter: false },
    true,
  )

  assert.match(mismatch, /toolFilter/)
})
