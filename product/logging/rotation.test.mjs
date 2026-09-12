// product/logging/rotation.test.mjs
// ============================================================================
// PRT-709：日志轮转与磁盘保护
//
// 这一组守的核心是**"磁盘写满时不要做错事"**，而不是"能不能轮转"：
//
//   ① **绝不删活动文件**（没有代数后缀的那个）。它是正在写的那一份。
//      在磁盘写满的时刻删掉当前日志，等于把证据和空间一起弄没了。
//   ② **绝不删代数 1**。删了它，`keepFiles=0` 或预算极小时轮转就只剩
//      "把日志扔掉"这一个效果——转一圈什么也没留下。
//   ③ **绝不把"没做成"报成成功**。Windows 上另一个进程持有句柄时 rename
//      会失败（EPERM/EBUSY），这时不能假装轮转成功，也不能转而去删活动文件。
//   ④ **读不出来 ≠ 目录是空的**，**没查磁盘 ≠ 空间充足**。两条都是
//      "把一个未知数记成了一个已知的零"。
//   ⑤ **位移必须从最大代数往下**，否则第一次 rename 就会覆盖掉还需要的旧日志。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_LOG_POLICY,
  LOG_CODES,
  freeBytesFromStatfs,
  isInUseError,
  parseLogName,
  planRotation,
  rotateLogs,
  validateLogPolicy,
} from './rotation.mjs'

/** 内存 fs：够用来模拟 rename/rm/statfs 与各种失败。 */
function fakeFs(files = {}, opts = {}) {
  const map = new Map(Object.entries(files).map(([k, v]) => [k, { body: v, size: Buffer.byteLength(String(v)) }]))
  const calls = { rename: [], rm: [], append: [] }
  const fs = {
    calls, map,
    readdirSync: (dir) => {
      if (opts.readdirThrows === true) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e }
      const prefix = `${dir}/`
      return [...map.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map((k) => k.slice(prefix.length))
    },
    statSync: (p) => {
      if (!map.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
      return { size: map.get(p).size, mtimeMs: map.get(p).mtimeMs ?? 0 }
    },
    renameSync: (a, b) => {
      calls.rename.push([a, b])
      if (opts.renameFails && opts.renameFails(a, b)) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e }
      if (!map.has(a)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
      map.set(b, map.get(a)); map.delete(a)
    },
    rmSync: (p) => {
      calls.rm.push(p)
      if (opts.rmFails && opts.rmFails(p)) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e }
      map.delete(p)
    },
    appendFileSync: (p, body) => {
      calls.append.push([p, body])
      const prev = map.get(p)?.body ?? ''
      const next = `${prev}${body}`
      map.set(p, { body: next, size: Buffer.byteLength(next) })
    },
    mkdirSync: () => {},
    statfsSync: opts.statfs ? () => opts.statfs : undefined,
  }
  return fs
}

const GB = 1024 * 1024 * 1024
const sparse = (freeBytes) => ({ bsize: 4096, bavail: Math.floor(freeBytes / 4096) })

const D = 'C:/log'

// ============================================================================
// ① 判定：纯函数部分
// ============================================================================

test('① 策略校验：负值/非数/**悄悄纠正**都不行——宁可拒绝也不猜', () => {
  assert.equal(validateLogPolicy({}).ok, true)
  for (const bad of [{ maxFileBytes: -1 }, { keepFiles: 1.5 }, { maxTotalBytes: 'x' }, { minFreeBytes: Number.NaN }]) {
    const r = validateLogPolicy(bad)
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 应当被拒绝`)
    assert.ok(r.problems.length > 0)
  }
  const r = planRotation({ entries: [], policy: { maxFileBytes: -1 } })
  assert.equal(r.ok, false)
  assert.equal(r.code, LOG_CODES.BAD_POLICY)
})

test('① 文件名解析：`app.log` 是活动文件，`app.log.1` 是最新一代，数字越大越旧', () => {
  assert.deepEqual(parseLogName('app.log'), { base: 'app.log', generation: null })
  assert.deepEqual(parseLogName('app.log.1'), { base: 'app.log', generation: 1 })
  assert.deepEqual(parseLogName('app.log.12'), { base: 'app.log', generation: 12 })
  // `.0` 与超大数字**不当作代数**：否则它会被算进"最旧的可删那一批"
  assert.deepEqual(parseLogName('app.log.0'), { base: 'app.log.0', generation: null })
  assert.equal(parseLogName('weird.log.99999999999999999999').generation, null)
})

test('① 超过阈值才轮转；正好等于阈值也轮转（边界是 `>=`）', () => {
  const pol = { maxFileBytes: 100, maxTotalBytes: 1e9, keepFiles: 5, minFreeBytes: 0 }
  const at = planRotation({ entries: [{ name: 'a.log', size: 100 }], policy: pol })
  const under = planRotation({ entries: [{ name: 'a.log', size: 99 }], policy: pol })
  assert.deepEqual(at.rotate, ['a.log'])
  assert.deepEqual(under.rotate, [])
})

test('① 认不出的文件**一个都不动**，并留下一条说明（"最旧"对它没有定义）', () => {
  const r = planRotation({
    entries: [
      { name: 'a.log', size: 10 },
      { name: 'notes.txt', size: 999 },
      { name: 'a.log.1', size: 10 },
    ],
    policy: { maxFileBytes: 1e9, maxTotalBytes: 10, keepFiles: 5, minFreeBytes: 0 },
  })
  const all = [...r.rotate, ...r.prune.map((p) => p.name)]
  assert.ok(!all.includes('notes.txt'), '不认识的 txt 被当成可删的日志了')
  assert.ok(r.notes.some((n) => n.code === 'FOREIGN_FILES'))
})

test('① 保留代数：超过 `keepFiles` 的旧代被删，**代数 1 永不删**', () => {
  const r = planRotation({
    entries: [
      { name: 'a.log', size: 10 },
      { name: 'a.log.1', size: 10 },
      { name: 'a.log.2', size: 10 },
      { name: 'a.log.6', size: 10 },
    ],
    policy: { maxFileBytes: 1e9, maxTotalBytes: 1e9, keepFiles: 5, minFreeBytes: 0 },
  })
  assert.deepEqual(r.prune.map((p) => p.name), ['a.log.6'])
  assert.ok(!r.prune.some((p) => p.name === 'a.log.1'))
  assert.ok(!r.prune.some((p) => p.name === 'a.log'))
})

test('① **`keepFiles: 0` 时也不许删代数 1**（否则轮转只是把日志扔掉）', () => {
  const r = planRotation({
    entries: [{ name: 'a.log', size: 10 }, { name: 'a.log.1', size: 10 }, { name: 'a.log.2', size: 10 }],
    policy: { maxFileBytes: 1e9, maxTotalBytes: 1e9, keepFiles: 0, minFreeBytes: 0 },
  })
  assert.ok(!r.prune.some((p) => p.name === 'a.log.1'), '代数 1 被删了：转一圈等于什么都没留下')
  assert.ok(r.prune.some((p) => p.name === 'a.log.2'))
  assert.ok(r.notes.some((n) => n.code === 'PROTECTED_GEN1'))
})

test('① 总量预算：从最旧开始删，**删到真的进预算为止**（不是只删一个）', () => {
  const r = planRotation({
    entries: [
      { name: 'a.log', size: 500 },      // 活动文件，本身很大
      { name: 'a.log.1', size: 300 },    // 代数 1，受保护
      { name: 'a.log.2', size: 300 },
      { name: 'a.log.3', size: 300 },
    ],
    policy: { maxFileBytes: 1e9, maxTotalBytes: 1000, keepFiles: 5, minFreeBytes: 0 },
  })
  const pruned = r.prune.map((p) => p.name)
  assert.ok(!pruned.includes('a.log'), '活动文件被删了')
  assert.ok(!pruned.includes('a.log.1'), '代数 1 被删了')
  // 1400 → 删 .3 得 1100（仍超）→ 再删 .2 得 800。**必须删到进预算**：
  // 只删一个就收手的话，剩下的 100 字节超支会一直留着。
  assert.deepEqual(pruned, ['a.log.3', 'a.log.2'])
  assert.ok(r.after.totalBytes <= 1000, `修剪后仍超预算：${r.after.totalBytes}`)
})

test('① 修剪之后仍超预算 → 一条**可见**的 note，并说清唯一的办法', () => {
  const r = planRotation({
    entries: [{ name: 'a.log', size: 5000 }],   // 单个活动文件就超总预算
    policy: { maxFileBytes: 1e9, maxTotalBytes: 1000, keepFiles: 5, minFreeBytes: 0 },
  })
  assert.equal(r.overBudget, true)
  const note = r.notes.find((n) => n.code === LOG_CODES.STILL_OVER_BUDGET)
  assert.ok(note, '没有报超预算')
  // 必须指出**是单个文件本身超预算**这一种情形，且不要建议去删它
  assert.match(note.message, /单个活动文件本身就超预算/)
  assert.match(note.message, /maxFileBytes/)
  assert.ok(!r.prune.some((p) => p.name === 'a.log'))
})

// ============================================================================
// ② 磁盘保护
// ============================================================================

test('② `freeBytes` 为 `null`（**没查**）时不做磁盘判定——不猜成"充足"', () => {
  const r = planRotation({
    entries: [{ name: 'a.log', size: 10 }, { name: 'a.log.3', size: 10 }],
    policy: { maxFileBytes: 1e9, maxTotalBytes: 1e9, keepFiles: 9, minFreeBytes: 1e9 },
    freeBytes: null,
  })
  assert.equal(r.pressure, null, 'null 被当成"查过了、空间足够"了')
  assert.ok(!r.prune.some((p) => p.name === 'a.log.3'))
})

test('② 可用空间低于下限 → 更激进地删，但**仍然不碰活动文件与代数 1**', () => {
  const r = planRotation({
    entries: [
      { name: 'a.log', size: 10 },
      { name: 'a.log.1', size: 10 },
      { name: 'a.log.2', size: 10 },
      { name: 'a.log.3', size: 10 },
    ],
    policy: { maxFileBytes: 1e9, maxTotalBytes: 1e9, keepFiles: 9, minFreeBytes: 1e9 },
    freeBytes: 0,
  })
  const pruned = r.prune.map((p) => p.name)
  assert.deepEqual(pruned.sort(), ['a.log.2', 'a.log.3'])
  assert.ok(r.notes.some((n) => n.code === LOG_CODES.DISK_PRESSURE))
  const note = r.notes.find((n) => n.code === LOG_CODES.DISK_PRESSURE)
  assert.match(note.message, /活动日志不会被删/,
    '没说清"不删活动日志"：读的人可能以为腾空间就该删当前日志')
})

test('② 磁盘紧张但**没有可删的** → 如实说"得从别处腾空间"', () => {
  const r = planRotation({
    entries: [{ name: 'a.log', size: 10 }, { name: 'a.log.1', size: 10 }],
    policy: { maxFileBytes: 1e9, maxTotalBytes: 1e9, keepFiles: 9, minFreeBytes: 1e9 },
    freeBytes: 1024,
  })
  const note = r.notes.find((n) => n.code === LOG_CODES.DISK_PRESSURE)
  assert.ok(note)
  assert.match(note.message, /没有任何可以删的已轮转文件/)
})

test('② `statfs` 读不出来时返回 `null`，**不是 0**（0 会被读成"磁盘满了"）', () => {
  assert.equal(freeBytesFromStatfs(null), null)
  assert.equal(freeBytesFromStatfs({}), null)
  assert.equal(freeBytesFromStatfs({ bsize: 'x', bavail: 1 }), null)
  assert.equal(freeBytesFromStatfs({ bsize: 4096, bavail: 10 }), 40960)
  assert.equal(freeBytesFromStatfs({ bsize: 4096, bavail: 0 }), 0, '真的是 0 时要是 0')
})

test('② 占用判定的错误码集合是明确的（Windows 与 POSIX 不同）', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES', 'ETXTBSY']) {
    assert.equal(isInUseError({ code }), true, code)
  }
  for (const code of ['ENOENT', 'EISDIR', 'undefined', undefined]) {
    assert.equal(isInUseError({ code }), false, String(code))
  }
})

// ============================================================================
// ③ 执行：位移顺序与失败处置
// ============================================================================

test('③ 位移**从最大代数往下**：不会覆盖掉还需要的旧日志', async () => {
  const fs = fakeFs({
    [`${D}/a.log`]: 'x'.repeat(200),
    [`${D}/a.log.1`]: 'one',
    [`${D}/a.log.2`]: 'two',
  })
  const r = await rotateLogs({
    logDir: D, fs,
    policy: { maxFileBytes: 100, maxTotalBytes: 1e9, keepFiles: 5, minFreeBytes: 0 },
  })
  assert.equal(r.ok, true, JSON.stringify(r.failures))
  // 内容必须整体后移一代，且一个都没丢
  assert.equal(fs.map.get(`${D}/a.log.2`)?.body, 'one')
  assert.equal(fs.map.get(`${D}/a.log.3`)?.body, 'two')
  assert.equal(fs.map.get(`${D}/a.log.1`)?.body, 'x'.repeat(200))
  // 顺序：先 2→3，再 1→2，最后 active→1
  const order = fs.calls.rename.map(([a]) => a.replace(`${D}/`, ''))
  assert.deepEqual(order, ['a.log.2', 'a.log.1', 'a.log'])
})

test('③ 超过保留代数的旧文件在位移**之前**被删（否则会占着目标名）', async () => {
  const fs = fakeFs({
    [`${D}/a.log`]: 'x'.repeat(200),
    // keepFiles=5 表示保留代数 1..5，所以**第 6 代**才是超出的那一代。
    // 第一版这里写的是 .5，那在保留范围内——用例本身写错了。
    [`${D}/a.log.6`]: 'beyond',
  })
  const r = await rotateLogs({
    logDir: D, fs,
    policy: { maxFileBytes: 100, maxTotalBytes: 1e9, keepFiles: 5, minFreeBytes: 0 },
  })
  assert.equal(r.ok, true, JSON.stringify(r.failures))
  assert.ok(fs.calls.rm.includes(`${D}/a.log.6`), '第 6 代没有被删')
  assert.equal(fs.map.has(`${D}/a.log.6`), false)
})

test('③ 位移到保留边界时**覆盖最旧的那一代**，而不是丢新数据（代数不会撞车）', async () => {
  // keepFiles=3、代 1..3 都在：移动 2→3 会覆盖旧代 3，再 1→2、active→1。
  // 覆盖是有意的（代 3 就是保留边界，它该被挤掉），但**不能出现两代同名**。
  const fs = fakeFs({
    [`${D}/a.log`]: 'x'.repeat(200),
    [`${D}/a.log.1`]: 'g1',
    [`${D}/a.log.2`]: 'g2',
    [`${D}/a.log.3`]: 'g3',
  })
  const r = await rotateLogs({
    logDir: D, fs,
    policy: { maxFileBytes: 100, maxTotalBytes: 1e9, keepFiles: 3, minFreeBytes: 0 },
  })
  assert.equal(r.ok, true, JSON.stringify(r.failures))
  assert.equal(fs.map.get(`${D}/a.log.1`)?.body, 'x'.repeat(200))
  assert.equal(fs.map.get(`${D}/a.log.2`)?.body, 'g1')
  assert.equal(fs.map.get(`${D}/a.log.3`)?.body, 'g2')
  // 保留边界之外不应再有代数
  assert.equal(fs.map.has(`${D}/a.log.4`), false)
})

test('③ **文件被占着时轮转失败必须可见**，且**绝不**转而删掉活动文件', async () => {
  const fs = fakeFs(
    { [`${D}/a.log`]: 'x'.repeat(200) },
    { renameFails: (a) => a === `${D}/a.log` },
  )
  const r = await rotateLogs({
    logDir: D, fs,
    policy: { maxFileBytes: 100, maxTotalBytes: 1e9, keepFiles: 5, minFreeBytes: 0 },
  })
  assert.equal(r.ok, false, '被占着却报了成功')
  assert.equal(r.failures[0].code, LOG_CODES.FILE_IN_USE)
  assert.match(r.failures[0].message, /没有删它/)
  assert.ok(!fs.calls.rm.includes(`${D}/a.log`), '转而删掉了活动文件——最坏的一种"腾空间"')
  assert.ok(fs.map.has(`${D}/a.log`), '活动文件必须还在')
})

test('③ 非占用类的轮转失败用**另一个码**（EPERM 与其它原因是两条排查路径）', async () => {
  const fs = fakeFs(
    { [`${D}/a.log`]: 'x'.repeat(200) },
    { renameFails: (a) => a === `${D}/a.log` },
  )
  // 把 rename 的失败码换成非占用类
  const orig = fs.renameSync
  fs.renameSync = (a, b) => {
    if (a === `${D}/a.log`) { const e = new Error('EXDEV'); e.code = 'EXDEV'; throw e }
    return orig(a, b)
  }
  const r = await rotateLogs({
    logDir: D, fs,
    policy: { maxFileBytes: 100, maxTotalBytes: 1e9, keepFiles: 5, minFreeBytes: 0 },
  })
  assert.equal(r.failures[0].code, LOG_CODES.ROTATE_FAILED)
  assert.notEqual(r.failures[0].code, LOG_CODES.FILE_IN_USE)
})

test('③ 删不掉某个文件时**不静默**：记一条 PRUNE_FAILED，其余照做', async () => {
  const fs = fakeFs(
    { [`${D}/a.log`]: 'x'.repeat(200), [`${D}/a.log.9`]: 'x' },
    { rmFails: (p) => p.endsWith('a.log.9') },
  )
  const r = await rotateLogs({
    logDir: D, fs,
    policy: { maxFileBytes: 100, maxTotalBytes: 1e9, keepFiles: 5, minFreeBytes: 0 },
  })
  assert.ok(r.failures.some((f) => f.code === LOG_CODES.PRUNE_FAILED))
  // 删除失败不该阻断轮转本身
  assert.deepEqual(r.rotated, ['a.log'])
})

test('③ 目录读不出来 → **报错**，不当作"目录是空的、无事可做"', async () => {
  const fs = fakeFs({}, { readdirThrows: true })
  const r = await rotateLogs({ logDir: D, fs, policy: {} })
  assert.equal(r.ok, false)
  assert.equal(r.code, LOG_CODES.UNREADABLE)
  assert.match(r.message, /不等于没有日志要轮转/)
})

test('③ 没给日志目录 → 报错，**不猜默认位置**', async () => {
  const r = await rotateLogs({ logDir: '', fs: fakeFs({}), policy: {} })
  assert.equal(r.ok, false)
  assert.equal(r.code, LOG_CODES.UNREADABLE)
  assert.match(r.message, /不猜/)
})

test('③ `statfs` 不可用时**说出来**，而不是默认"空间充足"', async () => {
  const fs = fakeFs({ [`${D}/a.log`]: 'x' })
  // fakeFs 在 opts.statfs 缺失时 statfsSync 是 undefined → 模拟不支持
  const r = await rotateLogs({ logDir: D, fs, policy: { maxFileBytes: 1e9 } })
  assert.equal(r.freeChecked, false)
  assert.ok(r.notes.some((n) => n.code === 'FREE_SPACE_UNKNOWN'))
  const note = r.notes.find((n) => n.code === 'FREE_SPACE_UNKNOWN')
  assert.match(note.message, /不要把这条读成"空间充足"/)
})

test('③ `statfs` 可用时会真的用它做磁盘保护', async () => {
  const fs = fakeFs(
    { [`${D}/a.log`]: 'x', [`${D}/a.log.4`]: 'y' },
    { statfs: sparse(1024) },
  )
  const r = await rotateLogs({
    logDir: D, fs,
    policy: { maxFileBytes: 1e9, maxTotalBytes: 1e9, keepFiles: 9, minFreeBytes: 1e9 },
  })
  assert.equal(r.freeChecked, true)
  assert.deepEqual(r.pruned, ['a.log.4'])
})

test('③ 无事可做时也返回一个**完整**结果（不是 undefined 字段）', async () => {
  const fs = fakeFs({ [`${D}/a.log`]: 'tiny' }, { statfs: sparse(10 * GB) })
  const r = await rotateLogs({ logDir: D, fs, policy: { maxFileBytes: 1000 } })
  assert.equal(r.ok, true)
  assert.deepEqual(r.rotated, [])
  assert.deepEqual(r.pruned, [])
  assert.deepEqual(r.failures, [])
  assert.equal(typeof r.before.totalBytes, 'number')
  assert.equal(r.freeChecked, true)
})

test('③ 默认策略存在且自洽（单文件上限 ≤ 总预算；保留代数 ≥ 1）', () => {
  assert.ok(DEFAULT_LOG_POLICY.maxFileBytes <= DEFAULT_LOG_POLICY.maxTotalBytes)
  assert.ok(DEFAULT_LOG_POLICY.keepFiles >= 1)
  assert.ok(validateLogPolicy({}).ok)
})
