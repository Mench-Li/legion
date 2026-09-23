// runtime/toolcall/spool-writer.test.mjs
//
// PRT-610 写入侧宿主：**按事件取 Run**、缺锚具名拒绝、绝不把强制面炸掉。
//
// ★ 这些用例钉的是**理由**，不是形状：车道最容易退化成的样子是
//   "反正写进去了"——多个 Run 合流、随手找个目录、记账失败改变判定，
//   三种退化在返回值上都长得像成功。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  TOOLCALL_SPOOL_WRITER_CODES,
  createSpoolObserver,
  createToolCallSpoolWriter,
} from './spool-writer.mjs'
import { readSpoolRecords, spoolFileFor } from './spool.mjs'

const PROJECTION = Object.freeze({
  callId: 'call-1',
  toolName: 'read',
  canonicalHash: 'hash-1',
  arguments: Object.freeze({ path: '/tmp/x' }),
})

const eventOf = ({ runId = 'run-a', decided = 'allow', projection = PROJECTION } = {}) => Object.freeze({
  execution: Object.freeze({ agent: Object.freeze({}) }),
  decision: Object.freeze({ kind: decided, reason: null }),
  source: 'pre-execute',
  projection,
  // ★ 这一份是**注入**给用例的：真组合根从 `identityOverlayForExecution` 读。
  __runId: runId,
})

const writerFor = (dir, over = {}) => createToolCallSpoolWriter({
  dataDir: dir,
  runIdOf: (e) => e.__runId,
  rowOf: (e, runId) => ({
    callId: e.projection.callId,
    toolName: e.projection.toolName,
    decision: e.decision.kind,
    decisionSource: e.source,
    canonicalHash: e.projection.canonicalHash,
    runId,
  }),
  ...over,
})

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'legion-spool-writer-'))
}

test('① ★★ 按**事件**取 Run：同一个 writer 把两个 Run 写进两本账', () => {
  const dir = tempDir()
  try {
    const writer = writerFor(dir)
    const a = writer.observeDecision(eventOf({ runId: 'run-a' }))
    const b = writer.observeDecision(eventOf({ runId: 'run-b' }))
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)

    // 两个**不同**的文件——这一条就是 §14.5 那处设计的验收点：
    // 装配期绑死 Run 的实现会让这两条落进同一个文件里。
    assert.notEqual(a.file, b.file)
    const rowsA = readSpoolRecords({ file: spoolFileFor({ dataDir: dir, runId: 'run-a' }) }).records
    const rowsB = readSpoolRecords({ file: spoolFileFor({ dataDir: dir, runId: 'run-b' }) }).records
    assert.equal(rowsA.length, 1)
    assert.equal(rowsB.length, 1)
    assert.equal(rowsA[0].row.runId, 'run-a')
    assert.equal(rowsB[0].row.runId, 'run-b')
    assert.deepEqual(writer.reading(), {
      version: writer.version, dataDir: dir, written: 2, refused: 0, lastRefusal: null,
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('② 车道文件的形状：一行一个 `decision` 记录，且**追加**而不是覆盖', () => {
  const dir = tempDir()
  try {
    const writer = writerFor(dir)
    writer.observeDecision(eventOf({ decided: 'allow' }))
    writer.observeDecision(eventOf({ decided: 'deny' }))
    const file = spoolFileFor({ dataDir: dir, runId: 'run-a' })
    const text = readFileSync(file, 'utf8')
    assert.equal(text.split('\n').filter((l) => l.trim() !== '').length, 2, '两次决定 = 两行')
    const rows = readSpoolRecords({ file }).records
    assert.deepEqual(rows.map((r) => [r.kind, r.row.decision]), [['decision', 'allow'], ['decision', 'deny']])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('③a ★ 缺 `LEGION_DATA_DIR`：具名拒绝 + **一个字节都不写**（不回落）', () => {
  const dir = tempDir()
  try {
    for (const dataDir of [null, '', '   ', 42]) {
      const writer = writerFor(dir, { dataDir })
      const res = writer.observeDecision(eventOf())
      assert.equal(res.ok, false)
      assert.equal(res.code, TOOLCALL_SPOOL_WRITER_CODES.NO_DATA_DIR)
      assert.equal(res.file, null)
      assert.equal(writer.reading().written, 0)
      assert.equal(writer.reading().dataDir, null)
      assert.equal(writer.fileOf('run-a'), null)
    }
    // 目录里**没有**被造出任何车道文件（"随手找个地方写"是这条用例要拦住的那个退化）
    // ★ 缺文件在这里**是一条读数**（`present:false`）而不是异常——`readSpoolRecords` 的契约。
    const reading = readSpoolRecords({ file: spoolFileFor({ dataDir: dir, runId: 'run-a' }) })
    assert.equal(reading.present, false)
    assert.equal(reading.total, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('③b ★ 读不出 Run 号：具名拒绝，**不**回落成"进程级那一本"', () => {
  const dir = tempDir()
  try {
    const writer = writerFor(dir, { runIdOf: () => null })
    for (const bad of [null, '', '  ', 7]) {
      const res = writer.observeDecision(eventOf({ runId: bad }))
      assert.equal(res.ok, false)
      assert.equal(res.code, TOOLCALL_SPOOL_WRITER_CODES.NO_RUN_ID)
    }
    assert.equal(writer.reading().written, 0)
    // ★ 关键：没有任何 Run 号下被造出文件——**没有**"兜底那一本"。
    for (const probe of ['run-a', 'default', '_process']) {
      assert.equal(readSpoolRecords({ file: spoolFileFor({ dataDir: dir, runId: probe }) }).present, false,
        `不该有 ${probe} 这本账`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('④ 没带投影的事件（非工具调用级）：具名拒绝，不猜一行出来', () => {
  const dir = tempDir()
  try {
    const writer = writerFor(dir)
    // ★ `undefined` 与"键都不在"是两件事，两种都试：
    //   （写成 `projection: undefined` 会**命中默认参数**，于是它其实是 `PROJECTION`——
    //    这正是本用例要避免的那种"看起来测了"的写法。）
    const noSuchKey = Object.freeze({
      execution: Object.freeze({ agent: Object.freeze({}) }),
      decision: Object.freeze({ kind: 'allow', reason: null }),
      source: 'pre-execute',
      __runId: 'run-a',
    })
    for (const event of [eventOf({ projection: null }), noSuchKey]) {
      const res = writer.observeDecision(event)
      assert.equal(res.ok, false)
      assert.equal(res.code, TOOLCALL_SPOOL_WRITER_CODES.NO_PROJECTION)
    }
    assert.equal(writer.reading().written, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑤ ★★ 记账失败**不抛**，也不改变任何判定（观察点不许影响强制面）', () => {
  const dir = tempDir()
  try {
    // 行构造器抛 / 造出非对象 / 追加抛：三种坏法都必须被收成具名读数
    const cases = [
      [{ rowOf: () => { throw new Error('投影器坏了') } }, TOOLCALL_SPOOL_WRITER_CODES.ROW_UNUSABLE],
      [{ rowOf: () => null }, TOOLCALL_SPOOL_WRITER_CODES.ROW_UNUSABLE],
      [{ rowOf: () => 42 }, TOOLCALL_SPOOL_WRITER_CODES.ROW_UNUSABLE],
      [{ append: () => { const e = new Error('磁盘满了'); e.code = 'ENOSPC'; throw e } }, 'ENOSPC'],
    ]
    for (const [over, code] of cases) {
      const writer = writerFor(dir, over)
      let res
      assert.doesNotThrow(() => { res = writer.observeDecision(eventOf()) })
      assert.equal(res.ok, false)
      assert.equal(res.code, code)
      assert.equal(writer.reading().written, 0)
      assert.equal(writer.reading().refused, 1)
      assert.ok(writer.reading().lastRefusal.reason.length > 0, '拒绝要带理由')
    }
    // 非法 Run 号（`a/b`）由 `spool.mjs` 具名拒绝，本模块同样收成读数而不是抛
    const writer = writerFor(dir, { runIdOf: () => 'a/b' })
    let res
    assert.doesNotThrow(() => { res = writer.observeDecision(eventOf()) })
    assert.equal(res.ok, false)
    assert.equal(writer.reading().written, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑤b 观测点自己抛，也**不许**影响写入与返回值', () => {
  const dir = tempDir()
  try {
    const writer = writerFor(dir, { onReading: () => { throw new Error('观测点坏了') } })
    let res
    assert.doesNotThrow(() => { res = writer.observeDecision(eventOf({ runId: null })) })
    assert.equal(res.ok, false)
    assert.equal(res.code, TOOLCALL_SPOOL_WRITER_CODES.NO_RUN_ID)
    // 好的一条照写
    assert.equal(writer.observeDecision(eventOf()).ok, true)
    assert.equal(writer.reading().written, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑥ 缺行构造器（装配错误）与"没配 DataDir"是两个码——处置不同', () => {
  const dir = tempDir()
  try {
    const writer = writerFor(dir, { rowOf: null })
    const res = writer.observeDecision(eventOf())
    assert.equal(res.code, TOOLCALL_SPOOL_WRITER_CODES.NO_ROW_BUILDER)
    assert.notEqual(res.code, TOOLCALL_SPOOL_WRITER_CODES.NO_DATA_DIR)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑦ 写入的账**收得回来**：与收账侧共用同一份契约（读回来的行能给 drain 用）', () => {
  const dir = tempDir()
  try {
    const writer = writerFor(dir)
    writer.observeDecision(eventOf({ runId: 'run-z' }))
    const rows = readSpoolRecords({ file: writer.fileOf('run-z') }).records
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'decision')
    // `TOOLCALL_SPOOL_REQUIRED.decision` 那五个字段逐字都在（行形状是 toolCallRowOf 的产出）
    for (const k of ['callId', 'toolName', 'decision', 'decisionSource', 'canonicalHash']) {
      assert.ok(rows[0].row[k] !== undefined && rows[0].row[k] !== null, `行缺 ${k}`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── 第 118 轮第十七轮：`dispatched` 的写入侧 ────────────────────────────────
//
// ★ 这一族钉的是"派发这件事真的被记下来了"，而最容易的失败方式是
//   **看起来记下来了**：写了一条状态不是"派发"的记录、或者给 deny 也写一条。

test('⑧ ★★★ 放行 ⇒ 两条记录，且**顺序**是契约（`decision` 在前、`dispatched` 在后）', () => {
  const dir = tempDir()
  try {
    const writer = writerFor(dir)
    const observe = createSpoolObserver(writer, { allowKind: 'allow' })
    const reading = observe(eventOf({ runId: 'run-d', decided: 'allow' }))
    assert.equal(reading.ok, true)

    const rows = readSpoolRecords({ file: writer.fileOf('run-d') }).records
    assert.deepEqual(rows.map((r) => r.kind), ['decision', 'dispatched'])
    // ★ 两条说的是**同一次调用**（收账侧靠 `callId` 算幂等键找到那一行）
    assert.equal(rows[0].row.callId, rows[1].row.callId)
    assert.equal(rows[1].row.runId, 'run-d')
    // ★ 顺序不是审美：收账侧按文件里的先后逐条应用（`decision` 建行 → `dispatched` 推状态），
    //   反过来 `markDispatched` 会**找不到那一行**，而"找不到"与"这次调用没派发"
    //   在收账读数上是同一个东西。
    assert.equal(writer.reading().written, 2, '两条记录都该计进 `written`')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑨ ★★★ `deny` / `ask` **不许**产生派发行（那会是一批并不存在的派发）', () => {
  const dir = tempDir()
  try {
    const writer = writerFor(dir)
    const observe = createSpoolObserver(writer, { allowKind: 'allow' })
    observe(eventOf({ runId: 'run-deny', decided: 'deny' }))
    observe(eventOf({ runId: 'run-ask', decided: 'ask' }))

    for (const runId of ['run-deny', 'run-ask']) {
      const rows = readSpoolRecords({ file: writer.fileOf(runId) }).records
      assert.deepEqual(rows.map((r) => r.kind), ['decision'],
        `${runId}：只有决定，没有派发`)
    }
    assert.equal(writer.reading().written, 2)
    // ★ 反向对照：同一个 writer 上一条 `allow` **必须**多出那一条 ——
    //   否则上面两条断言在一个"永远不写派发"的实现下也会全绿。
    observe(eventOf({ runId: 'run-allow', decided: 'allow' }))
    assert.deepEqual(
      readSpoolRecords({ file: writer.fileOf('run-allow') }).records.map((r) => r.kind),
      ['decision', 'dispatched'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑩ ★★ 两个入口**共用同一组具名拒绝**：第二种记录不会因为"是新的"而放松', () => {
  const dir = tempDir()
  try {
    // 缺 Run 号 ⇒ NO_RUN_ID（两个入口同码）
    const noRun = writerFor(dir, { runIdOf: () => null })
    assert.equal(noRun.observeDecision(eventOf()).code, TOOLCALL_SPOOL_WRITER_CODES.NO_RUN_ID)
    assert.equal(noRun.observeDispatch(eventOf()).code, TOOLCALL_SPOOL_WRITER_CODES.NO_RUN_ID)
    assert.equal(noRun.reading().written, 0)

    // 有 Run 号、没投影 ⇒ NO_PROJECTION（两个入口同码）
    const noProj = writerFor(dir)
    assert.equal(noProj.observeDecision(eventOf({ projection: null })).code,
      TOOLCALL_SPOOL_WRITER_CODES.NO_PROJECTION)
    assert.equal(noProj.observeDispatch(eventOf({ projection: null })).code,
      TOOLCALL_SPOOL_WRITER_CODES.NO_PROJECTION)
    assert.equal(noProj.reading().written, 0)

    // 没配 DataDir ⇒ NO_DATA_DIR
    const noDir = createToolCallSpoolWriter({
      dataDir: null, runIdOf: (e) => e.__runId, rowOf: () => ({}),
    })
    assert.equal(noDir.observeDispatch(eventOf()).code, TOOLCALL_SPOOL_WRITER_CODES.NO_DATA_DIR)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑪ ★★ 写入宿主缺半个入口 ⇒ **装配期就抛**，不静默降级成"只记决定"', () => {
  assert.throws(() => createSpoolObserver({ observeDecision: () => ({}) }), /observeDispatch/)
  assert.throws(() => createSpoolObserver(null), /observeDecision/)
})

test('⑫ ★★★ 第二个通知点（`plugins/pre-execute.mjs`）报的是哪个码 —— 实测，不照注释', () => {
  const dir = tempDir()
  try {
    const writer = writerFor(dir)
    const observe = createSpoolObserver(writer, { allowKind: 'allow' })
    // 逐字是 `plugins/pre-execute.mjs:112/134/142` 的载荷形状：`{exec, decision, claimed}`
    // ——它既没有 `execution`（Run 号从那里取）也没有 `projection`。
    observe({ exec: { name: 'write-file', callId: 'c-1' }, decision: { kind: 'allow' }, claimed: true })

    assert.equal(writer.reading().written, 0, '这一条本来就没有行的形状，不许写')
    // ★★★ 实测结果：**`NO_RUN_ID`**，不是 `NO_PROJECTION`。
    //   `root-row.mjs` 那段注释（第 118 轮第八轮写的）说这一条会得到 `NO_PROJECTION`
    //   —— 那是**从"它没有投影"推出来的**，而守卫的顺序是先取 Run 号：
    //   这个载荷的键叫 `exec` 而不是 `execution`，于是**先**卡在 Run 号上。
    //
    //   两者的**处置相同**（不写、只告警一次、不丢账），所以这个差别不改变行为；
    //   它改变的是**值班的人看到的那一行理由** —— 而"理由指错了一格"
    //   正是这个仓库反复量到的那种账：看起来有解释，只是解释的是别的东西。
    assert.equal(writer.reading().lastRefusal.code, TOOLCALL_SPOOL_WRITER_CODES.NO_RUN_ID)
    assert.notEqual(writer.reading().lastRefusal.code, TOOLCALL_SPOOL_WRITER_CODES.NO_PROJECTION)
    // ★ 同一次调用**两条记录都拒绝**（决定 + 派发），而告警按码去重 ⇒ 值班仍只看到一行。
    assert.equal(writer.reading().refused, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
