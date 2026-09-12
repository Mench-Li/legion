// ============================================================================
// PRT-705 孤儿进程清理的判据。
//
// 这一组盯的**不是**"能不能把残留进程杀掉"，而是**会不会杀错**。
//
// 记录里写着 `pid=4321`，那个进程退出了，系统把 4321 分配给了用户的编辑器。
// 按号码去杀，杀掉的是编辑器——不可撤销，而且用户完全不知道为什么。
//
// 所以这里绝大多数断言问的是同一件事：**该不该动手，以及有没有管住手。**
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  RUN_RECORD_CODES,
  RUN_RECORD_FILENAME,
  RUN_RECORD_VERSION,
  buildRunRecord,
  classifyRecordedPids,
  clearRunRecord,
  createProcessProbe,
  orphanDiagnostics,
  parseImage,
  readRunRecord,
  runRecordPath,
  sweepOrphans,
  validateRunRecord,
  writeRunRecord,
} from './run-record.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'legion-runrec-'))
  return { root, file: runRecordPath(root), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function record(processes) {
  return buildRunRecord({ runId: 'r1', startedAt: '2026-01-01T00:00:00.000Z', processes })
}

const NODE = 'node.exe'

// ── 记录的形状 ──────────────────────────────────────────────────────────────

test('① 记录版本不认识时**拒绝**，不猜', () => {
  const bad = { version: 'legion/launcher-run@99', runId: 'x', processes: [] }
  const r = validateRunRecord(bad)
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => p.includes('版本不认识')), JSON.stringify(r.problems))
})

test('① 缺字段的记录**不能用**（一条写了一半的记录会让我们少清几个进程）', () => {
  const r = validateRunRecord({ version: RUN_RECORD_VERSION, runId: 'x', processes: [{ key: 'a', pid: 1 }] })
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => p.includes('image')), JSON.stringify(r.problems))
})

test('① `pid` 不是整数时记录算坏的（`"4321"` 与 `4321` 不是一回事）', () => {
  const r = validateRunRecord({
    version: RUN_RECORD_VERSION, runId: 'x',
    processes: [{ key: 'a', pid: '4321', image: NODE }],
  })
  assert.equal(r.ok, false)
})

test('① `pid: null` 是**合法**的（起进程失败的条目要能如实记下来）', () => {
  const r = validateRunRecord(record([{ key: 'a', pid: null, image: null }]))
  assert.equal(r.ok, true, JSON.stringify(r.problems))
})

// ── 读：三种失败是三件事 ────────────────────────────────────────────────────

test('② `runRecordPath` 在 dataDir 为空时返回 null（**不猜位置**）', () => {
  assert.equal(runRecordPath(''), null)
  assert.equal(runRecordPath(null), null)
  assert.equal(runRecordPath('D:/data').replace(/\\/g, '/'), 'D:/data/' + RUN_RECORD_FILENAME)
})

test('② 文件不存在 → 没有记录，且**不报诊断**（这确实是干净的情况）', () => {
  const f = fixture()
  try {
    const r = readRunRecord(join(f.root, 'nope.json'))
    assert.equal(r.record, null)
    assert.deepEqual(r.diagnostics, [])
  } finally { f.cleanup() }
})

test('② 读不出来 ≠ 没有记录：必须报出来，并且说清"不等于上次没有残留"', () => {
  const f = fixture()
  try {
    const r = readRunRecord(f.file, {
      fs: {
        existsSync: () => true,
        readFileSync: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e },
      },
    })
    assert.equal(r.record, null)
    assert.equal(r.diagnostics.length, 1)
    assert.equal(r.diagnostics[0].code, RUN_RECORD_CODES.RECORD_UNREADABLE)
    // 这一句是这条诊断存在的全部理由：用户不能把它读成"很干净"
    assert.ok(r.diagnostics[0].message.includes('不等于'), r.diagnostics[0].message)
  } finally { f.cleanup() }
})

test('② 记录是坏 JSON（断电时写到一半）→ 报出来，且**不按残缺记录清理**', () => {
  const f = fixture()
  try {
    writeFileSync(f.file, '{"version":"legion/launcher-run@1","processes":[{"key":"a"')
    const r = readRunRecord(f.file)
    assert.equal(r.record, null)
    assert.equal(r.diagnostics[0].code, RUN_RECORD_CODES.RECORD_CORRUPT)
    assert.ok(r.diagnostics[0].message.includes('少列'), r.diagnostics[0].message)
  } finally { f.cleanup() }
})

test('② 形状不对的记录同样按"坏"处理', () => {
  const f = fixture()
  try {
    writeFileSync(f.file, JSON.stringify({ version: RUN_RECORD_VERSION, processes: [{ key: 'a' }] }))
    const r = readRunRecord(f.file)
    assert.equal(r.record, null)
    assert.equal(r.diagnostics[0].code, RUN_RECORD_CODES.RECORD_CORRUPT)
  } finally { f.cleanup() }
})

// ── 写与清 ──────────────────────────────────────────────────────────────────

test('③ 记录写得下、读得回（往返一致）', () => {
  const f = fixture()
  try {
    const rec = record([{ key: 'team-hub', pid: 4321, image: NODE }])
    const w = writeRunRecord(f.file, rec)
    assert.equal(w.ok, true)
    const r = readRunRecord(f.file)
    assert.equal(r.record.runId, 'r1')
    assert.deepEqual(r.record.processes, [{ key: 'team-hub', pid: 4321, image: NODE }])
  } finally { f.cleanup() }
})

test('③ 写失败**不抛**，但必须说清后果：下次认不出残留进程', () => {
  const f = fixture()
  try {
    const w = writeRunRecord(f.file, record([]), {
      fs: { writeFileSync: () => { const e = new Error('nope'); e.code = 'EROFS'; throw e } },
    })
    assert.equal(w.ok, false)
    assert.equal(w.diagnostic.code, RUN_RECORD_CODES.RECORD_WRITE_FAILED)
    // 后果必须写在消息里，否则这条 warn 看起来只是"一个文件没写成"
    assert.ok(w.diagnostic.message.includes('认不出'), w.diagnostic.message)
  } finally { f.cleanup() }
})

test('③ `clearRunRecord` 删得掉；删不掉也不抛（下次多判一轮而已）', () => {
  const f = fixture()
  try {
    writeRunRecord(f.file, record([]))
    assert.equal(clearRunRecord(f.file), true)
    assert.equal(readRunRecord(f.file).record, null)
    assert.equal(clearRunRecord(f.file), true, '幂等')
    assert.equal(clearRunRecord('', { fs: { rmSync: () => { throw new Error('x') } } }), false)
  } finally { f.cleanup() }
})

// ── 分类：本模块唯一的判断核心 ──────────────────────────────────────────────

test('④ 已经不在了 → `gone`（正常情况）', async () => {
  const e = await classifyRecordedPids(record([{ key: 'a', pid: 1, image: NODE }]), {
    isAlive: () => false, imageOf: () => NODE,
  })
  assert.deepEqual(e.map((x) => x.status), ['gone'])
})

test('④ 活着且映像名一致 → `verified`（**很可能是我们的**）', async () => {
  const e = await classifyRecordedPids(record([{ key: 'a', pid: 1, image: NODE }]), {
    isAlive: () => true, imageOf: () => NODE,
  })
  assert.equal(e[0].status, 'verified')
})

test('④ ★ 活着但映像名**对不上** → `recycled`（号码被系统给了别人）', async () => {
  // 这是整个模块存在的理由。记录里是 node.exe，现在这个号码上是 code.exe。
  const e = await classifyRecordedPids(record([{ key: 'a', pid: 4321, image: NODE }]), {
    isAlive: () => true, imageOf: () => 'Code.exe',
  })
  assert.equal(e[0].status, 'recycled')
  assert.equal(e[0].recordedImage, NODE)
  assert.equal(e[0].actualImage, 'Code.exe')
})

test('④ 映像名大小写不影响判定（Windows 上 `Node.EXE` 与 `node.exe` 是同一个）', async () => {
  const e = await classifyRecordedPids(record([{ key: 'a', pid: 1, image: 'node.exe' }]), {
    isAlive: () => true, imageOf: () => 'NODE.EXE',
  })
  assert.equal(e[0].status, 'verified')
})

test('④ 映像名读不出来 → `unknown`，**不是** `verified`（不知道 ≠ 是我们的）', async () => {
  for (const imageOf of [() => null, () => '', () => { throw new Error('tasklist 没了') }]) {
    const e = await classifyRecordedPids(record([{ key: 'a', pid: 1, image: NODE }]), {
      isAlive: () => true, imageOf,
    })
    assert.equal(e[0].status, 'unknown', '读不出映像名时不能当成"确认是我们的"')
  }
})

test('④ 记录里**没有**映像名时是 `unknown`（没有任何依据说这号码还是我们的）', async () => {
  const e = await classifyRecordedPids(record([{ key: 'a', pid: 1, image: null }]), {
    isAlive: () => true, imageOf: () => NODE,
  })
  assert.equal(e[0].status, 'unknown')
})

test('④ `isAlive` 抛错时**不当成"活着"**（探针坏了不该触发动手）', async () => {
  const e = await classifyRecordedPids(record([{ key: 'a', pid: 1, image: NODE }]), {
    isAlive: () => { throw new Error('boom') }, imageOf: () => NODE,
  })
  assert.equal(e[0].status, 'gone')
})

test('④ `pid: null` 的条目算 `gone`（那次压根没起起来）', async () => {
  const e = await classifyRecordedPids(record([{ key: 'a', pid: null, image: null }]), {
    isAlive: () => { throw new Error('不该被调用') }, imageOf: () => { throw new Error('不该被调用') },
  })
  assert.equal(e[0].status, 'gone')
})

// ── 清理：管住手 ────────────────────────────────────────────────────────────

test('⑤ ★ `recycled` **无论传什么参数都不杀**（那是别人的程序）', async () => {
  const entries = await classifyRecordedPids(record([{ key: 'a', pid: 4321, image: NODE }]), {
    isAlive: () => true, imageOf: () => 'Code.exe',
  })
  const killed = []
  for (const opts of [{}, { allowUnverified: true }, { allowUnverified: 'yes' }]) {
    const r = await sweepOrphans(entries, { killTree: (pid) => { killed.push(pid); return true }, ...opts })
    assert.deepEqual(r.killed, [], 'recycled 的 pid 被杀了——那很可能是用户的编辑器')
    assert.equal(r.refused[0].reason, 'pid-recycled')
  }
  assert.deepEqual(killed, [], 'killTree 一次都不该被调用')
})

test('⑤ `unknown` 默认不杀；显式 `allowUnverified: true` 才杀', async () => {
  const entries = await classifyRecordedPids(record([{ key: 'a', pid: 7, image: NODE }]), {
    isAlive: () => true, imageOf: () => null,
  })
  let killed = 0
  const r1 = await sweepOrphans(entries, { killTree: () => { killed += 1; return true } })
  assert.equal(killed, 0)
  assert.equal(r1.refused[0].reason, 'identity-unknown')

  const r2 = await sweepOrphans(entries, { killTree: () => { killed += 1; return true }, allowUnverified: true })
  assert.equal(killed, 1)
  assert.equal(r2.killed.length, 1)
})

test('⑤ `verified` 会被杀，且结果里带上映像名', async () => {
  const entries = await classifyRecordedPids(record([{ key: 'a', pid: 9, image: NODE }]), {
    isAlive: () => true, imageOf: () => NODE,
  })
  const r = await sweepOrphans(entries, { killTree: (pid) => pid === 9 })
  assert.deepEqual(r.killed, [{ key: 'a', pid: 9, image: NODE }])
})

test('⑤ 杀失败**不算杀过**：`failed` 与 `killed` 分开列', async () => {
  const entries = await classifyRecordedPids(record([{ key: 'a', pid: 9, image: NODE }]), {
    isAlive: () => true, imageOf: () => NODE,
  })
  const r = await sweepOrphans(entries, { killTree: () => false })
  assert.deepEqual(r.killed, [])
  assert.equal(r.failed.length, 1)
  assert.equal(r.diagnostics[0].code, RUN_RECORD_CODES.SWEEP_FAILED)
  // "杀失败"不能被读成"它已经没了"，也不能被读成"它还在"
  assert.ok(r.diagnostics[0].message.includes('不代表'), r.diagnostics[0].message)
})

test('⑤ `killTree` 抛错时算失败，不冒泡（清理阶段的异常会中断整个关闭流程）', async () => {
  const entries = await classifyRecordedPids(record([{ key: 'a', pid: 9, image: NODE }]), {
    isAlive: () => true, imageOf: () => NODE,
  })
  const r = await sweepOrphans(entries, { killTree: () => { throw new Error('boom') } })
  assert.equal(r.failed.length, 1)
  assert.equal(r.killed.length, 0)
})

test('⑤ `gone` 的条目不产生任何动作、也不产生"拒绝"', async () => {
  const entries = await classifyRecordedPids(record([{ key: 'a', pid: 1, image: NODE }]), {
    isAlive: () => false, imageOf: () => NODE,
  })
  const r = await sweepOrphans(entries, { killTree: () => { throw new Error('不该被调用') } })
  assert.deepEqual([r.killed, r.refused, r.failed], [[], [], []])
})

test('⑤ 一次清理同时涉及四种状态时，四条路各自走对', async () => {
  const entries = await classifyRecordedPids(record([
    { key: 'gone', pid: 1, image: NODE },
    { key: 'ours', pid: 2, image: NODE },
    { key: 'stolen', pid: 3, image: NODE },
    { key: 'mystery', pid: 4, image: NODE },
  ]), {
    isAlive: (pid) => pid !== 1,
    imageOf: (pid) => (pid === 2 ? NODE : pid === 3 ? 'chrome.exe' : null),
  })
  const killed = []
  const r = await sweepOrphans(entries, { killTree: (pid) => { killed.push(pid); return true } })
  assert.deepEqual(killed, [2], '只该杀那一个确认是我们的')
  assert.deepEqual(r.refused.map((x) => x.key).sort(), ['mystery', 'stolen'])
  assert.ok(r.diagnostics.some((d) => d.code === RUN_RECORD_CODES.SWEEP_REFUSED))
})

// ── 诊断：三条路要说成三句不同的话 ──────────────────────────────────────────

test('⑥ 只报**确实有事**的那几条（全都 gone 时不产生任何诊断）', () => {
  const d = orphanDiagnostics([
    { key: 'a', pid: 1, status: 'gone', recordedImage: NODE, actualImage: null },
  ])
  assert.deepEqual(d, [])
})

test('⑥ 有残留时告诉用户"这就是端口被占用的真实原因"，并给出出口', () => {
  const d = orphanDiagnostics([
    { key: 'team-hub', pid: 4321, status: 'verified', recordedImage: NODE, actualImage: NODE },
  ])
  assert.equal(d.length, 1)
  assert.equal(d[0].code, RUN_RECORD_CODES.ORPHANS_FOUND)
  assert.deepEqual(d[0].pids, [4321])
  assert.ok(d[0].message.includes('端口'), d[0].message)
  assert.ok(d[0].message.includes('--sweep-orphans'), '必须给出出口，否则用户只能自己去猜')
})

test('⑥ pid 被回收时**必须有独立的一条**，并解释"按号码杀会误伤"', () => {
  const d = orphanDiagnostics([
    { key: 'a', pid: 4321, status: 'recycled', recordedImage: NODE, actualImage: 'Code.exe' },
  ])
  assert.equal(d.length, 1)
  assert.equal(d[0].code, RUN_RECORD_CODES.PID_RECYCLED)
  assert.ok(d[0].message.includes('Code.exe'), '要说清现在这个号码上是哪个程序')
  assert.ok(d[0].message.includes('误伤'), d[0].message)
  // 不能把这条说成"需要你处理"
  assert.ok(d[0].message.includes('不需要处理'), d[0].message)
})

test('⑥ 读不出身份时也要在**清理之后**仍然报出来（拒绝本身就是结果）', async () => {
  const entries = [{ key: 'a', pid: 5, status: 'unknown', recordedImage: NODE, actualImage: null }]
  const r = await sweepOrphans(entries, { killTree: () => true })
  assert.equal(r.refused[0].reason, 'identity-unknown')
  const refusedDiag = r.diagnostics.find((d) => d.code === RUN_RECORD_CODES.SWEEP_REFUSED)
  assert.ok(refusedDiag, '拒绝清理必须留下一条诊断')
  assert.ok(refusedDiag.message.includes('纪律'), refusedDiag.message)
})

// ── 探针 ────────────────────────────────────────────────────────────────────

test('⑦ `parseImage` 认不出形状时返回 `null`（**不回退成 pid 或整行**）', () => {
  // 一个"看起来像映像名"的东西如果其实是别的，会让分类判成 recycled/verified，
  // 而那两个结论都会导致动手。null 只会导致不动手。
  assert.equal(parseImage('', 'win32'), null)
  assert.equal(parseImage('信息: 没有运行的任务匹配指定标准。', 'win32'), null)
  assert.equal(parseImage('"node.exe","1234","Console","1","100,000 K"', 'win32'), 'node.exe')
  assert.equal(parseImage('/usr/bin/node\n', 'linux'), '/usr/bin/node')
  assert.equal(parseImage('\n', 'linux'), null)
})

test('⑦ `parseImage` 在非 Windows 上只取第一行的非空内容', () => {
  assert.equal(parseImage('node\nother\n', 'darwin'), 'node')
})

test('⑦ `isAlive`：`ESRCH` 是"没了"，其他 errno 是"在但不是我们能动的"', () => {
  const probeFor = (err) => createProcessProbe({
    killImpl: () => { throw err }, spawnImpl: null,
  })
  const esrch = new Error('no such process'); esrch.code = 'ESRCH'
  assert.equal(probeFor(esrch).isAlive(1), false)
  const eperm = new Error('not permitted'); eperm.code = 'EPERM'
  assert.equal(probeFor(eperm).isAlive(1), true, 'EPERM 说明进程在，只是不是我们能动的')
  assert.equal(createProcessProbe({ killImpl: () => {}, spawnImpl: null }).isAlive(1), true)
  assert.equal(createProcessProbe({ killImpl: () => {}, spawnImpl: null }).isAlive('x'), false)
})

test('⑦ `imageOf` 在 spawn 不可用或出错时返回 `null`（**不抛**）', async () => {
  const noSpawn = createProcessProbe({ spawnImpl: null })
  assert.equal(await noSpawn.imageOf(1), null)

  const boom = createProcessProbe({ spawnImpl: () => { throw new Error('x') } })
  assert.equal(await boom.imageOf(1), null)

  const errChild = { stdout: { on: () => {} }, once: (ev, cb) => { if (ev === 'error') cb(new Error('x')) } }
  const onErr = createProcessProbe({ spawnImpl: () => errChild })
  assert.equal(await onErr.imageOf(1), null)

  assert.equal(await noSpawn.imageOf('not-a-pid'), null)
})

test('⑦ `imageOf` 从真实输出里取到映像名（Windows 的 CSV 与 POSIX 的第一行）', async () => {
  const fake = (text) => ({
    stdout: { on: (ev, cb) => { if (ev === 'data') cb(text) } },
    once: (ev, cb) => { if (ev === 'exit') cb(0) },
  })
  const win = createProcessProbe({ platform: 'win32', spawnImpl: () => fake('"node.exe","77","Console","1","1 K"') })
  assert.equal(await win.imageOf(77), 'node.exe')
  const posix = createProcessProbe({ platform: 'linux', spawnImpl: () => fake('node\n') })
  assert.equal(await posix.imageOf(77), 'node')
})

// ── 默认值自洽 ──────────────────────────────────────────────────────────────

test('⑧ 记录文件名不落在安装目录里（它是运行时状态，不是产品文件）', () => {
  assert.equal(RUN_RECORD_FILENAME, 'launcher-run.json')
  assert.equal(/[\\/]/.test(RUN_RECORD_FILENAME), false, '文件名里不该有路径分隔符')
})

test('⑧ `buildRunRecord` 的 pid 只在**确实是数字**时才记下来', () => {
  const r = buildRunRecord({ processes: [{ key: 'a', pid: '4321', image: 'x' }, { key: 'b', pid: 5, image: 'y' }] })
  assert.equal(r.processes[0].pid, null, '`"4321"` 不是 pid，记下来会被当成号码用')
  assert.equal(r.processes[1].pid, 5)
})

test('⑧ 记录可以被序列化（它要落盘，不能含任何活对象）', () => {
  const r = record([{ key: 'a', pid: 1, image: NODE }])
  const text = JSON.stringify(r)
  assert.ok(text.includes(RUN_RECORD_VERSION))
  assert.deepEqual(JSON.parse(text).processes, [{ key: 'a', pid: 1, image: NODE }])
  assert.equal(Object.isFrozen(r), true)
})
