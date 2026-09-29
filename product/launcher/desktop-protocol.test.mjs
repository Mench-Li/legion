import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLineDecoder, parseRequest } from './desktop-protocol.mjs'

test('partial lines are joined and each complete request is emitted once', () => {
  const lines = []
  const decoder = createLineDecoder((line) => lines.push(line))
  decoder.push(Buffer.from('{"version":1,"id":"a","type":"sta'))
  assert.deepEqual(lines, [])
  decoder.push(Buffer.from('tus","payload":{}}\n'))
  assert.equal(parseRequest(lines[0]).type, 'status')
  assert.equal(lines.length, 1)
})

test('an oversized line is rejected and the next line remains usable', () => {
  const lines = []
  const decoder = createLineDecoder((line) => lines.push(line), { maxBytes: 80 })
  decoder.push(Buffer.from('x'.repeat(81)))
  decoder.push(Buffer.from('\n{"version":1,"id":"b","type":"status","payload":{}}\n'))
  assert.equal(lines[0].code, 'LINE_TOO_LARGE')
  assert.equal(parseRequest(lines[1]).id, 'b')
})

test('unsupported version, type and non-object payload fail with named codes', () => {
  for (const [value, code] of [
    [{ version: 2, id: 'a', type: 'status', payload: {} }, 'BAD_VERSION'],
    [{ version: 1, id: 'a', type: 'shell', payload: {} }, 'UNKNOWN_TYPE'],
    [{ version: 1, id: 'a', type: 'status', payload: [] }, 'BAD_PAYLOAD'],
  ]) {
    assert.throws(() => parseRequest(JSON.stringify(value)), { code })
  }
})
