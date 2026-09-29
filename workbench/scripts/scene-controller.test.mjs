import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSceneController } from '../src/scene/sceneController.ts'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const roster = { agents: [{ role: 'dev', name: 'Dev', scope: 'lab', external: false }] }

test('默认计时器以 globalThis 为接收者调用浏览器原生定时器', () => {
  const original = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  }
  const browserTimer = result => function () {
    if (this !== globalThis) throw new TypeError('Illegal invocation')
    return result
  }
  try {
    globalThis.setTimeout = browserTimer(1)
    globalThis.clearTimeout = browserTimer(undefined)
    globalThis.setInterval = browserTimer(2)
    globalThis.clearInterval = browserTimer(undefined)
    const controller = createSceneController({
      scope: 'lab', subscribe: () => () => {},
      fetchRoster: async () => roster, fetchTasks: async () => [],
      onSnapshot: () => {}, onError: () => {},
    })
    assert.doesNotThrow(() => controller.start())
    controller.stop()
  } finally {
    Object.assign(globalThis, original)
  }
})

test('订阅当前空间，事件合并、重连与手动刷新读取同空间快照', async () => {
  let event, status, off = false, timeout, poll
  let reads = 0
  const snapshots = []
  const controller = createSceneController({
    scope: 'lab',
    subscribe: (onEvent, options) => { event = onEvent; status = options.onStatus; assert.equal(options.scope, 'lab'); return () => { off = true } },
    fetchRoster: async scope => { assert.equal(scope, 'lab'); reads++; return roster },
    fetchTasks: async scope => { assert.equal(scope, 'lab'); return [] },
    onSnapshot: value => snapshots.push(value), onError: () => {},
    timers: { setTimeout: fn => { timeout = fn; return 1 }, clearTimeout: () => {}, setInterval: fn => { poll = fn; return 2 }, clearInterval: () => {} },
  })
  controller.start()
  await tick()
  assert.equal(reads, 1)
  status({ state: 'open', opens: 1 })
  await tick()
  assert.equal(reads, 2)
  event({ scope: 'other', action: 'claim', seq: 1 })
  assert.equal(timeout, undefined)
  event({ scope: 'lab', action: 'claim', seq: 2 })
  event({ scope: 'lab', action: 'transition', seq: 3 })
  timeout()
  await tick()
  assert.equal(reads, 3)
  status({ state: 'reconnected', opens: 2 })
  await tick()
  assert.equal(reads, 4)
  await controller.refresh()
  assert.equal(reads, 5)
  poll()
  await tick()
  assert.equal(reads, 6)
  timeout = undefined
  event({ scope: 'lab', action: 'reassign', seq: 4 })
  assert.equal(typeof timeout, 'function')
  timeout(); await tick()
  assert.equal(reads, 7)
  assert.equal(snapshots.length, 7)
  controller.stop()
  assert.equal(off, true)
})

test('读取失败保留最后快照，恢复后清除提示', async () => {
  let fail = false, error = ''
  const snapshots = []
  const controller = createSceneController({ scope: 'lab', subscribe: () => () => {},
    fetchRoster: async () => { if (fail) throw new Error('offline'); return roster },
    fetchTasks: async () => [], onSnapshot: value => snapshots.push(value), onError: value => { error = value } })
  controller.start(); await tick()
  fail = true; await controller.refresh()
  assert.equal(snapshots.length, 1)
  assert.equal(error, 'offline')
  fail = false; await controller.refresh()
  assert.equal(snapshots.length, 2)
  assert.equal(error, '')
  controller.stop()
})

test('同空间较慢的旧请求不能覆盖较新的结果', async () => {
  const releases = [], snapshots = []
  const controller = createSceneController({ scope: 'lab', subscribe: () => () => {},
    fetchRoster: () => new Promise(resolve => releases.push(resolve)), fetchTasks: async () => [],
    onSnapshot: value => snapshots.push(value), onError: () => {} })
  controller.start()
  const fresh = controller.refresh()
  releases[1]({ agents: [{ role: 'new', scope: 'lab' }] })
  await fresh
  releases[0]({ agents: [{ role: 'old', scope: 'lab' }] })
  await tick()
  assert.deepEqual(snapshots.map(snapshot => snapshot.roster[0].role), ['new'])
  controller.stop()
})

test('事件触发的旧请求被重连刷新覆盖时仍保留真实完成提示', async () => {
  let emit, status, timeout
  const releases = [], cuesSeen = []
  let calls = 0
  const task = state => ({ id: 'one', title: 'One', scope: 'lab', role: 'dev', soldier: 'dev', status: state, blockedBy: [], goalId: null })
  const controller = createSceneController({ scope: 'lab',
    subscribe: (onEvent, options) => { emit = onEvent; status = options.onStatus; return () => {} },
    fetchRoster: async () => roster,
    fetchTasks: () => ++calls === 1 ? Promise.resolve([task('in_progress')]) : new Promise(resolve => releases.push(resolve)),
    onSnapshot: (_facts, cues) => cuesSeen.push(cues), onError: () => {}, now: () => 1500,
    timers: { setTimeout: fn => { timeout = fn; return 1 }, clearTimeout: () => {}, setInterval: () => 2, clearInterval: () => {} },
  })
  controller.start(); await tick()
  emit({ scope: 'lab', action: 'transition', taskId: 'one', seq: 42, ts: new Date(1000).toISOString(), payload: { to: 'done' } })
  timeout()
  status({ state: 'reconnected', opens: 2 })
  releases[1]([task('done')]); await tick()
  releases[0]([task('done')]); await tick()
  assert.equal(cuesSeen[1]?.[0]?.kind, 'completed')
  controller.stop()
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
