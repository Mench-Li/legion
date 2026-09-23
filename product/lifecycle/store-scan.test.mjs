// product/lifecycle/store-scan.test.mjs
// ============================================================================
// `store-scan` 的判据。
//
// 这一套要钉住的，是**五个"看起来像扫完了"的形状**（文件头那五条），
// 外加一条最重要的：**认不出的落点不许被猜一个类别** ——
// 因为上层的拒绝（`uninstall-unclassified-store` / `export-class-unknown`）
// 是**设计好的行为**，而猜出来的类别会让那些拒绝永远不出现。
//
// ★ 注入 `io` 的用例与真相隔着一层：实现里"根本没去读盘"也能让它们全绿。
//   所以最后一条是**真文件系统**的正对照。
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanStores, STORE_SCAN_CODES, DEFAULT_MAX_ENTRIES } from './store-scan.mjs'

/** 造一个假的 dirent（只实现本模块真的用到的三个方法）。 */
function dirent(name, kind = 'file') {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'link',
  }
}

/** 造一个假的 stat。 */
function statOf(kind, { size = 10, mtimeMs = 1000 } = {}) {
  return {
    size,
    mtimeMs,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
  }
}

/**
 * 一棵假树 + 三个注入点。
 * @param {Record<string, Array<object>|Error>} tree 路径 ⇒ 目录项列表（或一个抛错）
 * @param {Record<string, object|Error>} stats 路径 ⇒ stat（或一个抛错）
 */
function fakeIo(tree, stats = {}) {
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(tree, p) || Object.prototype.hasOwnProperty.call(stats, p),
    stat: (p) => {
      const s = stats[p]
      if (s instanceof Error) throw s
      if (s === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return s
    },
    readdir: (p) => {
      const t = tree[p]
      if (t instanceof Error) throw t
      if (t === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return t
    },
  }
}

const WIN = process.platform === 'win32'
const p = (...parts) => parts.join(WIN ? '\\' : '/')

test('① 正向：走进去、按 classifyPath 分类，且带出大小与时间', () => {
  const layout = { logDir: p('C:', 'prod', 'logs'), cacheDir: p('C:', 'prod', 'cache') }
  const io = fakeIo(
    {
      [p('C:', 'prod', 'logs')]: [dirent('a.log'), dirent('sub', 'dir')],
      [p('C:', 'prod', 'logs', 'sub')]: [dirent('b.log')],
      [p('C:', 'prod', 'cache')]: [dirent('c.bin')],
    },
    {
      [p('C:', 'prod', 'logs')]: statOf('dir'),
      [p('C:', 'prod', 'logs', 'a.log')]: statOf('file', { size: 11, mtimeMs: 111 }),
      [p('C:', 'prod', 'logs', 'sub')]: statOf('dir'),
      [p('C:', 'prod', 'logs', 'sub', 'b.log')]: statOf('file', { size: 22, mtimeMs: 222 }),
      [p('C:', 'prod', 'cache')]: statOf('dir'),
      [p('C:', 'prod', 'cache', 'c.bin')]: statOf('file', { size: 33, mtimeMs: 333 }),
    },
  )
  const r = scanStores({ roots: [layout.logDir, layout.cacheDir], layout, io })
  assert.equal(r.truncated, false)
  assert.equal(r.stores.length, 3, `应当扫到 3 个落点，实得 ${r.stores.length}`)
  const byName = Object.fromEntries(r.stores.map((s) => [s.path, s]))
  assert.equal(byName[p('C:', 'prod', 'logs', 'a.log')].classId, 'log')
  assert.equal(byName[p('C:', 'prod', 'logs', 'sub', 'b.log')].classId, 'log', '子目录里的也要带上类别')
  assert.equal(byName[p('C:', 'prod', 'logs', 'a.log')].bytes, 11)
  assert.equal(byName[p('C:', 'prod', 'logs', 'a.log')].atMs, 111)
})

test('② ★★★ 认不出的落点**原样带出**、并报出来（绝不在这一层猜一个类别）', () => {
  const layout = { dataDir: p('C:', 'prod', 'data') }
  const io = fakeIo(
    { [layout.dataDir]: [dirent('events.sqlite'), dirent('artifacts', 'dir')] },
    {
      [layout.dataDir]: statOf('dir'),
      [p('C:', 'prod', 'data', 'events.sqlite')]: statOf('file'),
      [p('C:', 'prod', 'data', 'artifacts')]: statOf('dir'),
    },
  )
  const r = scanStores({ roots: [layout.dataDir], layout, io })
  // ★ 它**在**清单里（上层要能具名拒绝它），而不是被悄悄丢掉
  assert.equal(r.stores.length, 1, '认不出的落点必须留在清单里：上层要靠它报"这一类我认不出来"')
  assert.equal(r.stores[0].classId, null)
  const codes = r.findings.map((f) => f.code)
  assert.ok(codes.includes(STORE_SCAN_CODES.UNCLASSIFIED),
    '认不出却没报 ⇒ 上层会以为"这一类没问题"，而那些拒绝本来正是设计好的行为')
  // ★ 反面：**不许**出现任何"猜出来"的类别
  for (const s of r.stores) {
    assert.ok(s.classId === null, `扫描器猜了一个类别 ${s.classId} —— 那会让上层的具名拒绝永远不出现`)
  }
})

test('③ ★★ 到上限 ⇒ truncated 且报出来（"没扫完"与"扫完了"不许同形）', () => {
  const layout = { logDir: p('C:', 'logs') }
  const many = Array.from({ length: 10 }, (_, i) => dirent(`f${i}.log`))
  const stats = { [layout.logDir]: statOf('dir') }
  for (let i = 0; i < 10; i += 1) stats[p('C:', 'logs', `f${i}.log`)] = statOf('file')
  const r = scanStores({ roots: [layout.logDir], layout, maxEntries: 4, io: fakeIo({ [layout.logDir]: many }, stats) })
  assert.equal(r.truncated, true, '到上限却没标 truncated ⇒ 上层会把它当完整清单')
  assert.ok(r.stores.length <= 4, `到上限后不许再多收：实得 ${r.stores.length}`)
  assert.ok(r.findings.some((f) => f.code === STORE_SCAN_CODES.TRUNCATED))
})

test('④ ★★ 根不存在 ⇒ 报 ROOT_MISSING（"不知道"不许被读成"是空的"）', () => {
  const r = scanStores({ roots: [p('C:', 'nope')], layout: {}, io: fakeIo({}, {}) })
  assert.equal(r.stores.length, 0)
  assert.ok(r.findings.some((f) => f.code === STORE_SCAN_CODES.ROOT_MISSING),
    '根不存在却没报 ⇒ 空清单会被读成"扫完了，没什么好导的"')
})

test('⑤ ★★ 读不了的子目录 ⇒ 报 UNREADABLE_DIR（清单不完整）', () => {
  const layout = { logDir: p('C:', 'logs') }
  const io = fakeIo(
    {
      [layout.logDir]: [dirent('ok.log'), dirent('locked', 'dir')],
      [p('C:', 'logs', 'locked')]: Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    },
    { [layout.logDir]: statOf('dir'), [p('C:', 'logs', 'ok.log')]: statOf('file') },
  )
  const r = scanStores({ roots: [layout.logDir], layout, io })
  assert.equal(r.stores.length, 1)
  assert.ok(r.findings.some((f) => f.code === STORE_SCAN_CODES.UNREADABLE_DIR),
    '读不了的目录被静默跳过 ⇒ 少了一棵子树而清单看起来是完整的')
})

test('⑥ ★★ 符号链接被跳过并报数（不跟出根）', () => {
  const layout = { logDir: p('C:', 'logs') }
  const io = fakeIo(
    { [layout.logDir]: [dirent('real.log'), dirent('outside', 'link')] },
    { [layout.logDir]: statOf('dir'), [p('C:', 'logs', 'real.log')]: statOf('file') },
  )
  const r = scanStores({ roots: [layout.logDir], layout, io })
  assert.equal(r.stores.length, 1, '符号链接下的东西不许进清单')
  const f = r.findings.find((x) => x.code === STORE_SCAN_CODES.SYMLINK_SKIPPED)
  assert.ok(f, '跳过链接却没报 ⇒ "没扫"与"扫了但没有"同形')
  assert.equal(f.count, 1)
})

test('⑦ 根本身是一个文件（如 secretsFile）⇒ 它就是一个落点，类别是 secret', () => {
  const layout = { secretsFile: p('C:', 'prod', 'secrets', 'credentials.json') }
  const io = fakeIo({}, { [layout.secretsFile]: statOf('file', { size: 7, mtimeMs: 7 }) })
  const r = scanStores({ roots: [layout.secretsFile], layout, io })
  assert.equal(r.stores.length, 1)
  assert.equal(r.stores[0].classId, 'secret')
})

test('⑧ 一个根都不给 ⇒ NO_ROOTS（"没扫"不是"扫过了、是空的"）', () => {
  const r = scanStores({ roots: [], io: fakeIo({}, {}) })
  assert.ok(r.findings.some((f) => f.code === STORE_SCAN_CODES.NO_ROOTS))
})

test('⑨ 取不到 stat ⇒ 仍收进清单，但报 STAT_FAILED（容量与"多久以前"缺依据）', () => {
  const layout = { logDir: p('C:', 'logs') }
  const io = fakeIo(
    { [layout.logDir]: [dirent('a.log')] },
    { [layout.logDir]: statOf('dir'), [p('C:', 'logs', 'a.log')]: Object.assign(new Error('EBUSY'), { code: 'EBUSY' }) },
  )
  const r = scanStores({ roots: [layout.logDir], layout, io })
  assert.equal(r.stores.length, 1, '取不到 stat 的落点不许被丢掉（丢掉了计划就会"看起来干净"）')
  assert.equal(r.stores[0].bytes, null)
  assert.ok(r.findings.some((f) => f.code === STORE_SCAN_CODES.STAT_FAILED))
})

test('⑩ ★★★ 真文件系统正对照：注入 io 的用例挡不住"实现根本没读盘"', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-store-scan-'))
  try {
    const logs = join(root, 'logs')
    const cache = join(root, 'cache')
    const data = join(root, 'data')
    mkdirSync(logs); mkdirSync(cache); mkdirSync(data)
    writeFileSync(join(logs, 'a.log'), 'x'.repeat(12))
    writeFileSync(join(cache, 'b.bin'), 'y'.repeat(34))
    writeFileSync(join(data, 'mystery.db'), 'z')

    const layout = { logDir: logs, cacheDir: cache, dataDir: data }
    const r = scanStores({ roots: [logs, cache, data], layout })
    assert.equal(r.roots.length, 3)
    const classOf = (name) => r.stores.find((s) => s.path.endsWith(name))?.classId
    assert.equal(classOf('a.log'), 'log')
    assert.equal(classOf('b.bin'), 'cache')
    assert.equal(classOf('mystery.db'), null, 'dataDir 下的落点认不出就必须是 null，不许猜')
    const a = r.stores.find((s) => s.path.endsWith('a.log'))
    assert.equal(a.bytes, 12, '真盘上的大小要读出来')
    assert.ok(a.atMs > 0, '真盘上的时间要读出来')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('⑪ ★ 真文件系统：符号链接真的被跳过（Windows 上造不出来就跳过这一条）', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-store-scan-link-'))
  try {
    const logs = join(root, 'logs')
    const outside = join(root, 'outside')
    mkdirSync(logs); mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'not ours')
    writeFileSync(join(logs, 'a.log'), 'ok')
    let linked = true
    try {
      symlinkSync(outside, join(logs, 'link'), 'junction')
    } catch {
      linked = false // 没有权限造链接（Windows 非管理员）⇒ 这一条不适用
    }
    const r = scanStores({ roots: [logs], layout: { logDir: logs } })
    assert.equal(r.stores.filter((s) => s.path.endsWith('a.log')).length, 1)
    if (linked) {
      assert.equal(r.stores.filter((s) => s.path.includes('secret.txt')).length, 0,
        '跟着链接走出了根：别人的文件进了本产品的落点清单')
      assert.ok(r.findings.some((f) => f.code === STORE_SCAN_CODES.SYMLINK_SKIPPED))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('⑫ 上限是个正数（不为 0 或负 —— 那会让"扫"变成一句空话）', () => {
  assert.ok(Number.isInteger(DEFAULT_MAX_ENTRIES) && DEFAULT_MAX_ENTRIES > 0)
})
