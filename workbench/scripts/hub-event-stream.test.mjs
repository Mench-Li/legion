import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildHubEventSourceUrl,
  hubCursorKey,
  readHubCursor,
  subscribeHubEventStream,
  writeHubCursor,
  isHubAuditEvent,
} from '../src/hubEventStream.ts'

describe('hub event cursor', () => {
  it('按 hub 与 scope 隔离并只允许单调递增', () => {
    const values = new Map()
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    }
    const key = hubCursorKey('https://hub.test/', 'scope-a')
    assert.equal(key, 'hub-events:https://hub.test/:scope-a')
    assert.equal(readHubCursor(storage, key), null)
    writeHubCursor(storage, key, 8)
    writeHubCursor(storage, key, 3)
    assert.equal(readHubCursor(storage, key), 8)
    assert.equal(readHubCursor(storage, hubCursorKey('https://hub.test/', 'scope-b')), null)
  })

  it('损坏游标按无游标处理，URL 正确编码 scope/cursor/token', () => {
    const storage = { getItem: () => 'bad', setItem: () => {} }
    assert.equal(readHubCursor(storage, 'k'), null)
    const url = buildHubEventSourceUrl('https://hub.test/api/events?existing=1', {
      scope: 'a b',
      sinceSeq: 8,
      token: 'x/y',
    })
    assert.equal(url, 'https://hub.test/api/events?existing=1&scope=a+b&sinceSeq=8&token=x%2Fy')
  })
})

describe('hub envelope validation', () => {
  it('接受统一信封并拒绝 id/seq 不一致或 payload 缺失', () => {
    const good = {
      id: 2,
      event: 'task:create',
      scope: 'a',
      seq: 2,
      ts: '2026-01-01',
      payload: {},
      action: 'task:create',
      member: 'general',
      taskId: null,
      goalId: null,
      detail: {},
    }
    assert.equal(isHubAuditEvent(good), true)
    assert.equal(isHubAuditEvent({ ...good, id: 3 }), false)
    assert.equal(isHubAuditEvent({ ...good, payload: undefined }), false)
  })

  it('订阅器只消费单调、匹配 scope 的合法事件并持久游标', () => {
    const values = new Map([['hub-events:https://hub.test/api/events/:a', '2']])
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    }
    class FakeEventSource {
      static instance
      constructor(url) { this.url = url; FakeEventSource.instance = this; this.onmessage = null }
      close() { this.closed = true }
    }
    const received = []
    const off = subscribeHubEventStream('https://hub.test/api/events', (event) => received.push(event), {
      scope: 'a',
      storage,
      token: 'token',
      EventSourceCtor: FakeEventSource,
    })
    assert.equal(FakeEventSource.instance.url, 'https://hub.test/api/events?scope=a&sinceSeq=2&token=token')
    const valid = { id: 3, event: 'task:create', scope: 'a', seq: 3, ts: '2026-01-01', payload: {}, action: 'task:create', member: 'general', taskId: null, goalId: null, detail: {} }
    FakeEventSource.instance.onmessage({ data: JSON.stringify(valid) })
    FakeEventSource.instance.onmessage({ data: JSON.stringify(valid) })
    FakeEventSource.instance.onmessage({ data: JSON.stringify({ ...valid, id: 4, seq: 4, scope: 'b' }) })
    FakeEventSource.instance.onmessage({ data: '{broken' })
    assert.deepEqual(received.map((event) => event.seq), [3])
    assert.equal(values.get('hub-events:https://hub.test/api/events/:a'), '3')
    off()
    assert.equal(FakeEventSource.instance.closed, true)
  })
})

describe('hub consumers', () => {
  it('三个 v2 消费者都把当前 scope 传给共享订阅器', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components')
    for (const file of ['ChatView.tsx', 'NotifyView.tsx', 'TaskCenterView.tsx']) {
      const source = readFileSync(join(root, file), 'utf8')
      assert.match(source, /subscribeHubAudit\(ev => \{[\s\S]*?\},\s*\{\s*scope(?:\s*:|\s*\})/, `${file} 未传递 scope`)
    }
  })
})
