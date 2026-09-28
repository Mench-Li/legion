import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSceneController } from '../src/scene/sceneController.ts'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const roster = { agents: [{ role: 'dev', name: 'Dev', scope: 'lab', external: false }] }

test('订阅当前空间，事件合并、重连与手动刷新读取同空间快照', async () => {
  let event, status, off = false, timeout
  let reads = 0
  const snapshots = []
  const controller = createSceneController({
    scope: 'lab',
    subscribe: (onEvent, options) => { event = onEvent; status = options.onStatus; assert.equal(options.scope, 'lab'); return () => { off = true } },
    fetchRoster: async scope => { assert.equal(scope, 'lab'); reads++; return roster },
    fetchTasks: async scope => { assert.equal(scope, 'lab'); return [] },
    onSnapshot: value => snapshots.push(value), onError: () => {},
    timers: { setTimeout: fn => { timeout = fn; return 1 }, clearTimeout: () => {}, setInterval: () => 2, clearInterval: () => {} },
  })
  controller.start()
  await tick()
  assert.equal(reads, 1)
  event({ scope: 'other', action: 'claim', seq: 1 })
  assert.equal(timeout, undefined)
  event({ scope: 'lab', action: 'claim', seq: 2 })
  event({ scope: 'lab', action: 'transition', seq: 3 })
  timeout()
  await tick()
  assert.equal(reads, 2)
  status({ state: 'reconnected', opens: 2 })
  await tick()
  assert.equal(reads, 3)
  await controller.refresh()
  assert.equal(reads, 4)
  assert.equal(snapshots.length, 4)
  controller.stop()
  assert.equal(off, true)
})

test('停止后旧空间的迟到请求不能覆盖新空间，失败保留最后快照', async () => {
  let release
  let error = ''
  const snapshots = []
  const controller = createSceneController({
    scope: 'lab', subscribe: () => () => {},
    fetchRoster: () => new Promise(resolve => { release = resolve }),
    fetchTasks: async () => [],
    onSnapshot: value => snapshots.push(value), onError: value => { error = value },
  })
  controller.start()
  controller.stop()
  release(roster)
  await tick()
  assert.equal(snapshots.length, 0)
  assert.equal(error, '')
})
