// product/update/zip.test.mjs
// ============================================================================
// 写端 → 读端的**闭环**回归
//
// 这个文件要证明的是一件事：**发布端产出的包，读端一定接受；而读端拒绝的
// 形状，发布端一定造不出来。**
//
// 这两句话听起来像同一个，其实不是：
//   · 前半句靠"写端用与读端同一组判据"（`validateEntryName`）保证；
//   · 后半句靠写端**不接受**未规范化路径（它不替调用方静默改写）。
//
// ## 为什么确定性要单独测
//
// "同一份输入两次产出逐字节相同的包"不是性能问题。设计 §4 line 78：
// 「同版本不同字节也必须使用不同 releaseId」。一个"每次打包字节都不同"的
// 发布流程会让 `releaseId` 与内容脱钩——于是"这个包是不是我上次发的那个"
// 变成一个无法回答的问题，而客户端的高水位判据（同 sequence 只允许完全
// 相同摘要）会在发布端**重新打同一个包**时拒掉它。
// ============================================================================

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildZip, crc32Of, shouldCompress } from './zip.mjs'
import { EXTRACT_CODES, extractArchive, planExtraction, readCentralDirectory, verifyExtractedTree } from './extract.mjs'
import { CLOSURE_ENTRY_NAME, CLOSURE_PROTOCOL, buildClosure, closureDigest, closureFromDirectory, parseClosure, serializeClosure, validateClosure } from './closure.mjs'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-zip-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 一份"产品树"：两个文件，其中一个可执行。 */
function productTree() {
  return [
    { path: 'product/launcher/cli.mjs', bytes: Buffer.from('#!/usr/bin/env node\nconsole.log(1)\n') },
    { path: 'product/release/runtime-manifest.json', bytes: Buffer.from('{"manifestFormat":"legion/version-manifest@1"}\n') },
    { path: 'product/assets/icon.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) },
  ]
}

/** 把一份产品树 + 闭包打成一个带 `closure.json` 的真包。 */
function packWithClosure(files, { closureName = CLOSURE_ENTRY_NAME } = {}) {
  const closure = buildClosure(files.map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: sha256(file.bytes) })))
  const closureBytes = serializeClosure(closure)
  const built = buildZip([...files, { path: closureName, bytes: closureBytes }])
  assert.equal(built.ok, true, built.reason)
  return { zip: built.bytes, closure, closureBytes, closureSha256: closureDigest(closureBytes), closureName }
}

// ---------------------------------------------------------------------------
// ① 确定性
// ---------------------------------------------------------------------------

test('★ 同一份输入两次产出逐字节相同的包', () => {
  const files = productTree()
  const a = buildZip(files)
  const b = buildZip(files)
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(sha256(a.bytes), sha256(b.bytes))
})

test('★ 输入顺序不影响产物字节（内部按路径升序写入）', () => {
  const files = productTree()
  const forward = buildZip(files)
  const reversed = buildZip([...files].reverse())
  assert.equal(sha256(forward.bytes), sha256(reversed.bytes))
  // 中央目录的顺序也必须是升序的。
  const directory = readCentralDirectory(forward.bytes)
  const names = directory.entries.map((entry) => entry.name)
  assert.deepEqual(names, [...names].sort())
})

test('★ 不把文件系统时间戳带进产物字节（默认固定时间）', () => {
  const files = [{ path: 'a.txt', bytes: Buffer.from('x'), mtimeMs: 1_700_000_000_000 }]
  const a = buildZip(files)
  const b = buildZip(files)
  assert.equal(sha256(a.bytes), sha256(b.bytes))
  // 显式传了 nowMs 才让它进字节。
  const withTime = buildZip(files, { nowMs: Date.UTC(2026, 9, 4, 12, 0, 0) })
  assert.notEqual(sha256(a.bytes), sha256(withTime.bytes))
})

// ---------------------------------------------------------------------------
// ② 写端拒绝读端会拒的形状
// ---------------------------------------------------------------------------

test('★ 写端不产出读端会拒绝的形状', () => {
  const rejects = [
    ['父目录穿越', [{ path: '../x.txt', bytes: Buffer.from('x') }]],
    ['绝对路径', [{ path: '/x.txt', bytes: Buffer.from('x') }]],
    ['盘符', [{ path: 'C:/x.txt', bytes: Buffer.from('x') }]],
    ['反斜杠', [{ path: 'a\\b.txt', bytes: Buffer.from('x') }]],
    ['百分号编码', [{ path: 'a%2eb.txt', bytes: Buffer.from('x') }]],
    ['未规范化（尾斜杠）', [{ path: 'a/', bytes: Buffer.from('x') }]],
    ['空段', [{ path: 'a//b', bytes: Buffer.from('x') }]],
    ['重复路径', [{ path: 'a.txt', bytes: Buffer.from('x') }, { path: 'a.txt', bytes: Buffer.from('y') }]],
  ]
  for (const [name, entries] of rejects) {
    const built = buildZip(entries)
    assert.equal(built.ok, false, `写端造出了「${name}」`)
  }
})

test('写不出的东西读端也不会接受（同一组判据）', () => {
  // 写端拒绝的理由码必须是路径类，而不是"未知错误"——它复用读端的判据。
  const built = buildZip([{ path: '../x', bytes: Buffer.from('x') }])
  assert.equal(built.code, 'zip-path-escape')
})

// ---------------------------------------------------------------------------
// ③ 闭环：写 → 计划 → 解压 → 核对
// ---------------------------------------------------------------------------

test('★ 闭环：带包内闭包的包能被完整校验并解压', (t) => {
  const root = scratch(t)
  const packed = packWithClosure(productTree())
  const out = join(root, 'out')

  const planned = planExtraction({
    archiveBytes: packed.zip,
    closureEntry: { path: packed.closureName, sha256: packed.closureSha256 },
  })
  assert.equal(planned.ok, true, planned.reason)
  // 计划里的文件数 = 产品树 + 闭包自己。
  assert.equal(planned.plan.files.length, productTree().length + 1)

  const extracted = extractArchive({
    archiveBytes: packed.zip,
    targetDir: out,
    closureEntry: { path: packed.closureName, sha256: packed.closureSha256 },
  })
  assert.equal(extracted.ok, true, extracted.reason)
  // 字节与产品树一致。
  for (const file of productTree()) {
    assert.deepEqual(readFileSync(join(out, ...file.path.split('/'))), file.bytes, `${file.path} 内容不符`)
  }
  const verdict = verifyExtractedTree({ targetDir: out, expected: extracted.written })
  assert.equal(verdict.ok, true, verdict.problems.join('；'))
})

test('★ 包内闭包摘要不符 → 在解压任何东西之前就拒', (t) => {
  const root = scratch(t)
  const packed = packWithClosure(productTree())
  const out = join(root, 'out')
  const result = extractArchive({
    archiveBytes: packed.zip,
    targetDir: out,
    closureEntry: { path: packed.closureName, sha256: 'f'.repeat(64) },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, EXTRACT_CODES.CLOSURE_ENTRY)
  assert.match(result.reason, /摘要与发行清单不符/)
  // ★ 目录必须仍然是空的：第 0 步的意义就在这里。
  assert.equal(readdirSafe(out).length, 0, '拒绝之前已经把文件写到磁盘上了')
})

test('★ 包内闭包缺失 → 拒', () => {
  const built = buildZip(productTree())
  const planned = planExtraction({
    archiveBytes: built.bytes,
    closureEntry: { path: 'closure.json', sha256: 'a'.repeat(64) },
  })
  assert.equal(planned.ok, false)
  assert.equal(planned.code, EXTRACT_CODES.CLOSURE_ENTRY)
  assert.match(planned.reason, /没有闭包条目/)
})

test('★ 包内含闭包之外的可执行文件 → 拒（闭包来自包内也一样拦得住）', () => {
  const files = productTree()
  const closure = buildClosure(files.map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: sha256(file.bytes) })))
  const closureBytes = serializeClosure(closure)
  // 攻击形态：闭包只列了合法的那些，而包里多塞了一个 exe。
  const built = buildZip([...files, { path: 'product/surprise.exe', bytes: Buffer.from('MZ') }, { path: CLOSURE_ENTRY_NAME, bytes: closureBytes }])
  const planned = planExtraction({
    archiveBytes: built.bytes,
    closureEntry: { path: CLOSURE_ENTRY_NAME, sha256: closureDigest(closureBytes) },
  })
  assert.equal(planned.ok, false)
  assert.equal(planned.code, EXTRACT_CODES.UNKNOWN_EXECUTABLE)
  assert.match(planned.reason, /surprise\.exe/)
})

test('★ 包内闭包说有一个文件、包里没有 → 拒（缺条目）', () => {
  const files = productTree()
  const closure = buildClosure([
    ...files.map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: sha256(file.bytes) })),
    { path: 'product/missing.txt', bytes: 3, sha256: 'a'.repeat(64) },
  ])
  const closureBytes = serializeClosure(closure)
  // 注意：这里的闭包列了一个包内不存在的条目。为了让"闭包条目摘要"仍然
  // 对得上，`closure.json` 本身带着这条不存在的记录。
  const built = buildZip([...files, { path: CLOSURE_ENTRY_NAME, bytes: closureBytes }])
  const planned = planExtraction({
    archiveBytes: built.bytes,
    closureEntry: { path: CLOSURE_ENTRY_NAME, sha256: closureDigest(closureBytes) },
  })
  assert.equal(planned.ok, false)
  assert.equal(planned.code, EXTRACT_CODES.MISSING_ENTRY)
})

test('★ 内容被替换（闭包对、字节不对）→ 拒', (t) => {
  const root = scratch(t)
  const files = productTree()
  const closure = buildClosure(files.map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: sha256(file.bytes) })))
  const closureBytes = serializeClosure(closure)
  // 声明的大小与真实大小一致（否则会先在计划阶段因大小不符被拒），
  // 但内容不同 —— 这正是"摘要才拦得住"的那一类。
  const tampered = files.map((file, index) => (index === 0
    ? { path: file.path, bytes: Buffer.alloc(file.bytes.length, 0x41) }
    : file))
  const built = buildZip([...tampered, { path: CLOSURE_ENTRY_NAME, bytes: closureBytes }])
  const result = extractArchive({
    archiveBytes: built.bytes,
    targetDir: join(root, 'out'),
    closureEntry: { path: CLOSURE_ENTRY_NAME, sha256: closureDigest(closureBytes) },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, EXTRACT_CODES.DIGEST_MISMATCH)
})

test('同时给外部与包内闭包：一致才放行', (t) => {
  const root = scratch(t)
  const packed = packWithClosure(productTree())
  const same = extractArchive({
    archiveBytes: packed.zip,
    targetDir: join(root, 'ok'),
    closure: packed.closure.files,
    closureEntry: { path: packed.closureName, sha256: packed.closureSha256 },
  })
  assert.equal(same.ok, true, same.reason)

  const different = extractArchive({
    archiveBytes: packed.zip,
    targetDir: join(root, 'bad'),
    closure: [{ path: 'product/launcher/cli.mjs', bytes: 1, sha256: 'a'.repeat(64) }],
    closureEntry: { path: packed.closureName, sha256: packed.closureSha256 },
  })
  assert.equal(different.ok, false)
  assert.equal(different.code, EXTRACT_CODES.CLOSURE_MISMATCH)
})

// ---------------------------------------------------------------------------
// ④ 闭包自身的往返与规范化
// ---------------------------------------------------------------------------

test('★ 闭包字节往返稳定（摘要稳定的前提）', () => {
  const files = productTree().map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: sha256(file.bytes) }))
  const closure = buildClosure(files)
  const bytes = serializeClosure(closure)
  const parsed = parseClosure(bytes)
  assert.equal(parsed.ok, true, parsed.reason)
  assert.equal(closureDigest(bytes), closureDigest(serializeClosure({ protocol: CLOSURE_PROTOCOL, files: parsed.files })))
  // 顺序无关：乱序输入得到同一个闭包。
  const shuffled = buildClosure([...files].reverse())
  assert.equal(closureDigest(serializeClosure(shuffled)), closureDigest(bytes))
})

test('闭包拒绝未规范化路径与重复项', () => {
  assert.equal(validateClosure({ protocol: CLOSURE_PROTOCOL, files: [{ path: 'a/', bytes: 1, sha256: 'a'.repeat(64) }] }).ok, false)
  assert.equal(validateClosure({
    protocol: CLOSURE_PROTOCOL,
    files: [{ path: 'a', bytes: 1, sha256: 'a'.repeat(64) }, { path: 'a', bytes: 1, sha256: 'a'.repeat(64) }],
  }).ok, false)
  assert.equal(validateClosure({
    protocol: CLOSURE_PROTOCOL,
    files: [{ path: 'b', bytes: 1, sha256: 'a'.repeat(64) }, { path: 'a', bytes: 1, sha256: 'a'.repeat(64) }],
  }).ok, false, '未排序的闭包应被拒（摘要稳定的前提）')
})

test('★ 从目录树构造闭包：与打包结果逐条一致', (t) => {
  const root = scratch(t)
  const tree = productTree()
  for (const file of tree) {
    const { mkdirSync } = fsSync()
    const target = join(root, ...file.path.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, file.bytes)
  }
  const built = closureFromDirectory(root)
  assert.equal(built.ok, true, built.problems.join('；'))
  const expected = buildClosure(tree.map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: sha256(file.bytes) })))
  assert.deepEqual(built.closure.files, expected.files)
  // 于是"目录树 → 闭包 → 打包 → 解压 → 闭包"这条链上闭包不变。
  const zipped = buildZip([...tree, { path: CLOSURE_ENTRY_NAME, bytes: serializeClosure(built.closure) }])
  assert.equal(zipped.ok, true)
  const planned = planExtraction({
    archiveBytes: zipped.bytes,
    closureEntry: { path: CLOSURE_ENTRY_NAME, sha256: closureDigest(serializeClosure(built.closure)) },
  })
  assert.equal(planned.ok, true, planned.reason)
})

// ---------------------------------------------------------------------------
// ⑤ 与测试夹具的对齐
// ---------------------------------------------------------------------------

test('★ 生产写端与测试夹具产出的包读端都接受', async () => {
  // 夹具刻意允许恶意形状，所以它不该被用来生产；但"夹具产出的**合法**包
  // 读端也接受"这条要有，否则某天夹具与读端的字节口径分叉，会有一批
  // 测试开始测一个不存在的格式。
  const { makeZipFixture } = await import('./fixtures/zip.mjs')
  const files = productTree()
  // 夹具的字段名是 `name`（它是另一个用途的东西），生产写端是 `path`。
  // 这里显式转换，而不是让夹具"顺便也认 path"：两份构造器各自的形状保持
  // 可见，混用的时候才有人发现。
  const fixtureZip = makeZipFixture(files.map((file) => ({ name: file.path, bytes: file.bytes })))
  // 必须给闭包：产品树里有一个 `.mjs`，而没有闭包时可执行文件一律被拒
  // （fail-closed，见 extract.mjs 的注释）。这条断言顺带证明了"写端（夹具
  // 或生产）产出的**合法**包 + 正确闭包"这条组合是通的。
  const closure = buildClosure(files.map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: sha256(file.bytes) })))
  const planned = planExtraction({ archiveBytes: fixtureZip, closure: closure.files })
  assert.equal(planned.ok, true, planned.reason)
  assert.equal(planned.plan.files.length, files.length)

  // 同一份文件由**生产写端**产出的包，计划得到的**条目集合**必须一致。
  // 不比顺序：生产写端刻意按路径升序写入（确定性），而夹具按输入顺序写。
  const production = buildZip(files)
  assert.equal(production.ok, true, production.reason)
  const productionPlan = planExtraction({ archiveBytes: production.bytes, closure: closure.files })
  assert.equal(productionPlan.ok, true, productionPlan.reason)
  const asSet = (plan) => plan.plan.files.map((file) => file.path).sort()
  assert.deepEqual(asSet(productionPlan), asSet(planned), '生产写端与夹具产出的条目集合不同')
  // 而生产写端**自己**是排好序的。
  assert.deepEqual(productionPlan.plan.files.map((file) => file.path), files.map((file) => file.path).sort())
})

test('crc32Of 与 known vectors 一致', () => {
  // 标准测试向量：`123456789` 的 CRC-32 是 0xCBF43926。
  assert.equal(crc32Of(Buffer.from('123456789')), 0xcbf43926)
  assert.equal(crc32Of(Buffer.alloc(0)), 0)
})

test('shouldCompress 不压缩已压缩格式', () => {
  assert.equal(shouldCompress('a.txt'), true)
  assert.equal(shouldCompress('a.mjs'), true)
  for (const path of ['a.png', 'a.jpg', 'a.zip', 'a.gz', 'a.asar', 'a.node', 'a.exe', 'a.dll', 'a.woff2']) {
    assert.equal(shouldCompress(path), false, `${path} 不该被压缩`)
  }
})

function readdirSafe(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

function fsSync() {
  return fsModule
}

import * as fsModule from 'node:fs'
