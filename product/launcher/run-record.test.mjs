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
  RUN_RECORD_FIELDS,
  RUN_RECORD_FILENAME,
  RUN_RECORD_OPTIONAL_FIELDS,
  RUN_RECORD_VERSION,
  buildRunRecord,
  classifyRecordedPids,
  clearRunRecord,
  createProcessProbe,
  normalizePeakResource,
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

test('① ★★★ 多一个字段**不算**坏记录 —— 而这是有意的（前向兼容），不是漏了', () => {
  // ★ 与 `run-record.mjs` 里 `RUN_RECORD_FIELDS` 的注释成对：那里原文写
  //   「多一个少一个都算坏记录」，实测**只有"少一个"被强制**。
  //
  //   为什么"多一个"必须继续被容忍：记录由**上一个** launcher 写下、由**这一个**
  //   读出来清理孤儿进程，写入方与读取方可能不是同一个版本。拒绝了多余字段，
  //   旧读取方就会说"记录坏了、不知道上次起了什么"⇒ 孤儿进程不被清理。
  // ★★ 这个例子**必须**用一个"不在任何一张表里"的字段。
  //   第一版用的是 `peakResource`，那时它确实是"多余的"；2026-09-18 之后它成了
  //   **已知的可选字段**，于是这条用例变成在断言"坏形状的 peakResource 也要放行"
  //   ——那是**反的**（有形状就必须查）。改名成 `somethingNobodyKnows` 之后，
  //   它测的还是原来那件事：**校验器不认识的多余字段，不拒。**
  const r = validateRunRecord({
    version: RUN_RECORD_VERSION, runId: 'x', launcherPid: null, startedAt: 'x',
    processes: [{ key: 'a', pid: 1, image: NODE, somethingNobodyKnows: { whatever: 99 } }],
  })
  assert.equal(r.ok, true, `多一个字段竟然被拒了：${JSON.stringify(r.problems)}`)
  // ★ 反向对照：同一份记录**少**一个字段必须红。
  //   少了这一条，"校验器恒 ok" 也能让上面那条绿。
  const missing = validateRunRecord({
    version: RUN_RECORD_VERSION, runId: 'x', processes: [{ key: 'a', pid: 1 }],
  })
  assert.equal(missing.ok, false, '少一个字段竟然通过了——那本组①的"不能用"那条就是假的')
  assert.ok(missing.problems.some((p) => p.includes('image')), JSON.stringify(missing.problems))
})

test('① ★★★ `buildRunRecord` 是**闭合**映射：不认识的字段被静默丢掉（"只加一行"接不上）', () => {
  // 这一条钉的是一个会让人**白干一轮**的机制。
  //   把新读数加进调用方 `persistRunRecord()` 那处 `supervisor.status().map(...)`
  //   是**不够的** —— 值会在 `buildRunRecord` 这一层被丢掉，而且不报错，
  //   于是记录里那个字段的读数永远是"没有"，看起来像"采样没采到"。
  //
  //   PRT-009 的记账写着「接上只是加一行」，那句是错的。本用例就是那句的读数。
  //
  // ★★★ 2026-09-18 续：`peakResource` **已经有意**加进来了，所以本用例改成
  //   断言**新的**分界线——它现在守的是"哪些字段被带上、哪些还是被丢掉"，
  //   以及**那条最容易走错的岔路**：
  //
  //     ✗ 加进 `RUN_RECORD_FIELDS`（「必须有」）
  //       ⇒ 上一个 launcher 写下的记录没有它 ⇒ 读取方判"记录坏了"
  //       ⇒ **孤儿进程不被清理**。
  //     ✓ 加进 `RUN_RECORD_OPTIONAL_FIELDS`（「可以有」）
  //       ⇒ 旧记录照常读、旧读取方照常清理。
  //
  //   > 一个"缺了这个字段所以记录不可用"的校验，与一个"这条记录本来就没有这个读数"，
  //   > 在"上一轮起的进程还活着吗"这个问题上是同一个东西：
  //   > 都得到"不知道"，而"不知道"的处置是**不动手**。
  const rec = buildRunRecord({
    runId: 'r1', startedAt: '2026-01-01T00:00:00.000Z',
    processes: [{
      key: 'runtime', pid: 4321, image: NODE,
      peakResource: { ok: true, samples: 7, peakWorkingSetBytes: 64 * 1024 * 1024 },
      // 这个字段不在任何一张表里 ⇒ 必须继续被丢掉
      somethingNobodyKnows: 'x',
    }],
  })
  const p = rec.processes[0]
  assert.deepEqual(Object.keys(p).sort(), ['image', 'key', 'peakResource', 'pid'],
    '被带上的字段集合变了。★ 加新读数请加进 `RUN_RECORD_OPTIONAL_FIELDS`，'
    + '**不要**加进 `RUN_RECORD_FIELDS`（那会让旧记录判死、孤儿进程清不掉）')
  assert.equal(Object.keys(p).includes('somethingNobodyKnows'), false,
    '一个不在任何表里的字段竟然被带上了 ⇒ 闭合映射漏了，记录形状会随调用方漂')
  assert.equal(JSON.stringify(rec).includes('peakWorkingSetBytes'), true,
    '峰值数字**没有**进记录 ⇒ PRT-009 那条"采了也没人接"又回来了')

  // ★★ 结构性断言：这个字段必须在**可选**那张表里、且**不在**必需那张表里。
  //   只断言"值被带上了"是不够的——值被带上、同时又被列成必需，
  //   旧记录一样会判死，而那时上面的读数**全是绿的**。
  assert.ok(RUN_RECORD_OPTIONAL_FIELDS.includes('peakResource'),
    '`peakResource` 不在可选表里')
  assert.equal(RUN_RECORD_FIELDS.includes('peakResource'), false,
    '`peakResource` 被加进了「必须有」那张表 ⇒ 上一个 launcher 写下的记录会判"坏记录"'
    + ' ⇒ 孤儿进程不被清理。它必须留在 `RUN_RECORD_OPTIONAL_FIELDS`。')
})

// ── 可选字段 `peakResource`：可缺席、不可坏、且"没采到"不许写 0 ──────────────

test("①a ★★ 旧记录**没有** `peakResource` ⇒ 必须照常通过（前向兼容的那一半）", () => {
  // 这一条是整组的关键：它守的是**孤儿进程清不掉**那个后果。
  //   记录由上一个 launcher 写下、由这一个读出来清理孤儿进程。
  //   如果校验器要求 `peakResource` 必须在，那么**所有**在加这个字段之前
  //   写下的记录都会判"坏记录"⇒ 读取方拒绝动手 ⇒ 上一轮泄漏的进程留在机器上。
  const old = {
    version: RUN_RECORD_VERSION, runId: 'x', launcherPid: null, startedAt: 'x',
    processes: [{ key: 'a', pid: 1, image: NODE }],
  }
  const r = validateRunRecord(old)
  assert.equal(r.ok, true,
    '一条没有 `peakResource` 的旧记录被拒了 ⇒ 孤儿进程清不掉。'
    + `问题：${JSON.stringify(r.problems)}`)
  // ★ 反向对照：这份"旧记录"**确实**被读过一遍（不是校验器恒 ok）。
  //   少了这一条，把校验器改坏成恒 true 也能让上面那条绿。
  const broken = validateRunRecord({ ...old, processes: [{ key: 'a', pid: 1 }] })
  assert.equal(broken.ok, false, '少 `image` 竟然也过了 ⇒ 上面那条绿不算数')
})

test("①b ★★★ `ok=false` 的读数必须**完整**进记录，且三个测量值全是 null", () => {
  // "采过但采不到"是**三种**状态里的一种，不许塌缩成"没有读数"。
  //   一个被丢掉的 `ok:false`，与"压根没接线"在记录里同形。
  const rec = buildRunRecord({
    runId: 'r', startedAt: 'x',
    processes: [{
      key: 'runtime', pid: 1, image: NODE,
      peakResource: {
        ok: false, pid: 1, platform: 'win32', samples: 3, lastCode: 'PEAK_RESOURCE_PROCESS_GONE',
        peakWorkingSetBytes: null, peakRssBytes: null, cpuMs: null,
      },
    }],
  })
  const pr = rec.processes[0].peakResource
  assert.equal(pr.ok, false, 'ok=false 没被带进记录')
  assert.equal(pr.samples, 3, 'samples 丢了 ⇒ "采过"这件事看不出来')
  assert.equal(pr.lastCode, 'PEAK_RESOURCE_PROCESS_GONE', '具名码丢了 ⇒ 读的人不知道为什么采不到')
  assert.equal(validateRunRecord(rec).ok, true, '一份合法的"采不到"记录被拒了')
})

test("①c ★★★ 变异：`ok=false` 却写 0 ⇒ 必须报出来（0 是测量结论，不是「不知道」）", () => {
  // 这是这一层唯一能**机械判**的那条纪律。
  //   > 一个把"没采到"写成 0 的记录，会让"这台机器很省内存"
  //   > 与"这台机器根本没采到"在事后读记录时同形。
  const mk = (measures) => ({
    version: RUN_RECORD_VERSION, runId: 'x', launcherPid: null, startedAt: 'x',
    processes: [{ key: 'a', pid: 1, image: NODE, peakResource: { ok: false, samples: 1, ...measures } }],
  })
  const zero = validateRunRecord(mk({ peakWorkingSetBytes: 0, peakRssBytes: null, cpuMs: null }))
  assert.equal(zero.ok, false, 'ok=false 带着 0 竟然通过了')
  assert.ok(zero.problems.some((p) => p.includes('不许写 0') || p.includes('必须写 null')),
    `报的话里没说清是"没采到不许写 0"：${JSON.stringify(zero.problems)}`)
  // ★ 反向对照：**ok=true** 时 0 是合法的（真的可能一个字节都没用），不许误报。
  const okTrue = validateRunRecord(mk({ ok: true, peakWorkingSetBytes: 0, peakRssBytes: 0, cpuMs: 0 }))
  assert.equal(okTrue.ok, true,
    'ok=true 时 0 被误报了 ⇒ 这条判据会红在正确的地方，'
    + `而一条红在正确地方的判据会教人删掉它。问题：${JSON.stringify(okTrue.problems)}`)
})

test("①d 坏形状必须报出来（不许静默塌缩成 null）", () => {
  const base = { version: RUN_RECORD_VERSION, runId: 'x', launcherPid: null, startedAt: 'x' }
  const withPr = (pr) => ({
    ...base,
    processes: [{ key: 'a', pid: 1, image: NODE, peakResource: pr }],
  })
  for (const [what, pr, needle] of [
    ['ok 不是布尔', { ok: 'yes', peakWorkingSetBytes: 1 }, 'ok 不是布尔'],
    ['测量值是字符串', { ok: true, peakWorkingSetBytes: '64MiB' }, 'peakWorkingSetBytes'],
    ['测量值是 NaN', { ok: true, peakWorkingSetBytes: Number.NaN }, 'peakWorkingSetBytes'],
    ['整个是数组', [], '既不是 null 也不是对象'],
  ]) {
    const r = validateRunRecord(withPr(pr))
    assert.equal(r.ok, false, `${what} 没被报出来：${JSON.stringify(r.problems)}`)
    assert.ok(r.problems.some((p) => p.includes(needle)),
      `${what} 报的话里没提到「${needle}」：${JSON.stringify(r.problems)}`)
  }
  // ★ `null` 与**整个字段缺席**都必须放行——它们是"这个写入方没有这个读数"。
  assert.equal(validateRunRecord(withPr(null)).ok, true, 'peakResource=null 被拒了')
  const absent = { ...base, processes: [{ key: 'a', pid: 1, image: NODE }] }
  assert.equal(validateRunRecord(absent).ok, true, '字段缺席被拒了')
})

test("①e `normalizePeakResource`：null / 非对象 / 部分字段", () => {
  // null 是一等公民：它表示"从未采样"，与 ok:false（采过但采不到）不是同一件事。
  assert.equal(normalizePeakResource(null), null)
  assert.equal(normalizePeakResource(undefined), null)
  for (const bad of [0, 1, 'x', true, [], () => {}]) {
    assert.equal(normalizePeakResource(bad), null, `${JSON.stringify(bad)} 没被规范成 null`)
  }
  // 部分字段：缺的填空值，但不许凭空造 0
  const n = normalizePeakResource({ ok: true, peakWorkingSetBytes: 1234 })
  assert.equal(n.peakWorkingSetBytes, 1234)
  assert.equal(n.peakRssBytes, null, '缺的测量值被造出来了（应为 null）')
  assert.equal(n.cpuMs, null)
  assert.equal(n.samples, 0, 'samples 缺省应为 0（"一次都没采"是事实，不是 null）')
  assert.equal(n.ok, true)
  // `ok` 的强制布尔化：只有字面 `true` 才算 true（与 peak-resource 的 ok 语义一致）
  assert.equal(normalizePeakResource({ ok: 1 }).ok, false, 'ok 应为严格布尔')
  assert.equal(normalizePeakResource({ ok: 'true' }).ok, false, 'ok 应为严格布尔')
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
    // ★ 2026-09-18：进程对象现在**恒定**带 `peakResource`（没传就是 `null`）。
    //   这是有意的：`null` = "这个写入方没有这个读数"，与"字段整个不在"
    //   （= 更旧的写入方）在读取方那里是**两种**输入，形状上要能分开。
    assert.deepEqual(r.record.processes,
      [{ key: 'team-hub', pid: 4321, image: NODE, peakResource: null }])
  } finally { f.cleanup() }
})

test('③-2 ★★★ 峰值读数真的**落盘并读得回**（PRT-009 那条"采了也没人接"的读数据此关掉）', () => {
  // ★ 这一条是全组的**落点**：前面所有断言都在说"值被带上了"、
  //   "形状是对的"、"旧记录不判死"——那些都可能在**磁盘这一层**丢掉。
  //
  //   PRT-009 的原文是：`supervisor.peakResource()` 在整个仓库里**只出现一次**
  //   （它自己的定义）。后果是具体的：
  //   **就算真跑一次黄金任务，那个数也会被算出来然后丢掉**，
  //   于是那一项永远关不掉，理由还不是"没跑"，是"**跑了也没人接**"。
  //
  //   ⚠️ 这里仍然**不是**那次真实部署的实跑读数（那件事本机永远发生不了，
  //   见 `docs/STATUS.md` §4 第 15 条）。本条证明的是**"接了"这一半**：
  //   一个有形状的读数从写入方出发，经 `buildRunRecord` → `writeRunRecord`
  //   → 磁盘 → `readRunRecord`，回来时**数字还是那个数字**。
  const f = fixture()
  try {
    const reading = {
      ok: true, pid: 4321, platform: 'win32', samples: 7,
      startedAtMs: 1000, endedAtMs: 9000, lastOkAtMs: 8000, lastCode: null,
      peakWorkingSetBytes: 64 * 1024 * 1024, peakRssBytes: 32 * 1024 * 1024, cpuMs: 1234,
    }
    const rec = record([{ key: 'runtime', pid: 4321, image: NODE, peakResource: reading }])
    assert.equal(writeRunRecord(f.file, rec).ok, true)

    // ★★ 先看**磁盘上的字节**，而不是只看读回来的对象。
    //   "读回来的对象里有这个字段"与"那个数字真的写在文件里"是两件事——
    //   中间隔着一个序列化。要让这条判据守得住，就得看文件。
    const onDisk = readFileSync(f.file, 'utf8')
    assert.ok(onDisk.includes('"peakResource"'), '磁盘上的记录里没有 peakResource 这个键')
    assert.ok(onDisk.includes(String(64 * 1024 * 1024)),
      `磁盘上的记录里没有那个**数字**（${64 * 1024 * 1024}B）⇒ "算出来然后丢掉"又回来了`)

    const back = readRunRecord(f.file).record.processes[0].peakResource
    assert.equal(back.peakWorkingSetBytes, 64 * 1024 * 1024, '往返之后峰值内存变了')
    assert.equal(back.cpuMs, 1234, '往返之后 CPU 时间变了')
    assert.equal(back.samples, 7, '往返之后 samples 变了')
    assert.equal(back.ok, true)
    assert.equal(back.lastCode, null)
    assert.equal(validateRunRecord(readRunRecord(f.file).record).ok, true,
      '写完再读回来的记录自己校验不过')

    // ★ 反面：一份**新写入方**的富记录，落到**旧读取方**的校验器上必须仍然 ok。
    //   这正是 `RUN_RECORD_OPTIONAL_FIELDS` 存在的理由——旧读取方要能
    //   照常按 `{key,pid,image}` 去清孤儿进程。
    const asOldReaderWouldSee = validateRunRecord({
      version: RUN_RECORD_VERSION, runId: 'x', launcherPid: null, startedAt: 'x',
      processes: [{ key: 'a', pid: 1, image: NODE, peakResource: reading }],
    })
    assert.equal(asOldReaderWouldSee.ok, true,
      `更富的记录被拒了 ⇒ 孤儿进程清不掉。问题：${JSON.stringify(asOldReaderWouldSee.problems)}`)
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
  assert.deepEqual(JSON.parse(text).processes,
    [{ key: 'a', pid: 1, image: NODE, peakResource: null }])
  assert.equal(Object.isFrozen(r), true)
})
