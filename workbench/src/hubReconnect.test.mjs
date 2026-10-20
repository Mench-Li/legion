import assert from 'node:assert/strict'
import test from 'node:test'
import { hubRetryDelay } from './hubReconnect.ts'

test('Hub reconnect delay grows and then stays at the 30 second cap', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 20].map(hubRetryDelay),
    [1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000],
  )
  assert.equal(hubRetryDelay(-1), 1_000)
  assert.equal(hubRetryDelay(Number.NaN), 1_000)
})
