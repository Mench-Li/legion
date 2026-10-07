// product/update/extract.test.mjs
// ============================================================================
// 解压加固的回归 —— 设计 §6 line 142 的五条拒绝判据
//
// 这个文件自带一个最小的 ZIP **构造器**（不是读取器）：要驱动"越界路径""软链接"
// "重复目标""解压炸弹"这几条，必须能造出**合法 ZIP 语法但恶意内容**的归档。
// 用现成的打包库造不出来——它们的 API 正是"写一个正常的压缩包"。
//
// 构造器只写 stored（0）条目：deflate 的用例单独用手写的 deflate 流覆盖，
// 因为它要验证的正是"解压器会不会先解完再看长度"。
// ============================================================================

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  BOMB_POLICY, EXTRACT_CODES, extractArchive, looksExecutable, planExtraction, readCentralDirectory,
  validateEntryName, verifyExtractedTree,
} from './extract.mjs'

// ZIP 构造器来自共享夹具（`product/update/fixtures/` 会被打包流程按目录名排除，
// 见 `fixtures/zip.mjs` 的文件头）。
import { makeZipFixture as makeZip } from './fixtures/zip.mjs'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-extract-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ---------------------------------------------------------------------------
// ① 越界路径
// ---------------------------------------------------------------------------

test('★ 越界路径：五类写法逐条被拒', () => {
  const cases = [
    ['../outside.txt', '父目录穿越'],
    ['a/../../outside.txt', '嵌套穿越'],
    ['/etc/passwd', '绝对路径'],
    ['C:/Windows/x.dll', '盘符'],
    ['C:\\Windows\\x.dll', '盘符+反斜杠'],
    ['a\\..\\b.txt', '反斜杠穿越（POSIX 实现会当成普通文件名）'],
    ['%2e%2e/outside.txt', '编码绕过'],
    ['a//b.txt', '空路径段'],
    ['a/\u0000b.txt', 'NUL 字节'],
  ]
  for (const [name, why] of cases) {
    const zip = makeZip([{ name, bytes: Buffer.from('x') }])
    const planned = planExtraction({ archiveBytes: zip })
    assert.equal(planned.ok, false, `${why} 被放行了：${name}`)
    assert.equal(planned.code, EXTRACT_CODES.PATH_ESCAPE, `${why} 的错误码是 ${planned.code}`)
  }
})

test('★ 越界路径：不写任何文件（计划阶段就拒）', (t) => {
  const root = scratch(t)
  const zip = makeZip([{ name: 'ok.txt', bytes: Buffer.from('fine') }, { name: '../escape.txt', bytes: Buffer.from('bad') }])
  const result = extractArchive({ archiveBytes: zip, targetDir: join(root, 'out') })
  assert.equal(result.ok, false)
  assert.equal(result.code, EXTRACT_CODES.PATH_ESCAPE)
  // 连第一个合法条目都不该落盘：计划是**整体**通过的产物。
  assert.deepEqual(result.written, [])
})

// ---------------------------------------------------------------------------
// ② 软链接 / 重解析点
// ---------------------------------------------------------------------------

test('★ 符号链接条目被拒（校验读到的内容与最终生效的可以不同）', () => {
  const zip = makeZip([{ name: 'link', bytes: Buffer.from('C:\\Windows'), unixMode: 0o120777 }])
  const planned = planExtraction({ archiveBytes: zip })
  assert.equal(planned.ok, false)
  assert.equal(planned.code, EXTRACT_CODES.SYMLINK)
})

test('★ 解压**之后**再拒一次符号链接（计划阶段看不出来的序列）', (t) => {
  const root = scratch(t)
  const out = join(root, 'out')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'real.txt'), 'hello', 'utf8')
  // 模拟"解压出一个普通文件，随后它变成了链接"。
  writeFileSync(join(out, 'link.txt'), 'hello', 'utf8')
  try {
    rmSync(join(out, 'link.txt'), { force: true })
    symlinkSync(join(out, 'real.txt'), join(out, 'link.txt'))
  } catch {
    // Windows 上无权限创建符号链接时跳过（不是本判据的失败）。
    return
  }
  const verdict = verifyExtractedTree({
    targetDir: out,
    expected: [{ path: 'real.txt', bytes: 5, sha256: sha256(Buffer.from('hello')) }],
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join(' '), /符号链接/)
})

// ---------------------------------------------------------------------------
// ③ 重复目标
// ---------------------------------------------------------------------------

test('★ 重复目标被拒（胜负取决于解压顺序，而清单校验看不出来）', () => {
  const zip = makeZip([
    { name: 'a.txt', bytes: Buffer.from('first') },
    { name: 'a.txt', bytes: Buffer.from('second') },
  ])
  const planned = planExtraction({ archiveBytes: zip })
  assert.equal(planned.ok, false)
  assert.equal(planned.code, EXTRACT_CODES.DUPLICATE_TARGET)
})

test('目录条目与文件条目同名也算重复', () => {
  const zip = makeZip([
    { name: 'a/', isDirectory: true, bytes: Buffer.alloc(0) },
    { name: 'a', bytes: Buffer.from('x') },
  ])
  const planned = planExtraction({ archiveBytes: zip })
  assert.equal(planned.ok, false)
  assert.equal(planned.code, EXTRACT_CODES.DUPLICATE_TARGET)
})

// ---------------------------------------------------------------------------
// ④ 解压炸弹
// ---------------------------------------------------------------------------

test('★ 单条目超过上限被拒（声明值，不必真的解）', () => {
  const zip = makeZip([{
    name: 'big.bin', bytes: Buffer.from('aaaa'), declaredUncompressed: BOMB_POLICY.maxEntryBytes + 1,
  }])
  const planned = planExtraction({ archiveBytes: zip })
  assert.equal(planned.ok, false)
  assert.equal(planned.code, EXTRACT_CODES.BOMB)
})

test('★ 压缩比超限被拒（4 字节压成 1 的极端比）', () => {
  const zip = makeZip([{ name: 'ratio.bin', bytes: Buffer.from('aaaa'), declaredUncompressed: 10_000 }])
  const planned = planExtraction({ archiveBytes: zip, policy: { ...BOMB_POLICY, maxRatio: 5 } })
  assert.equal(planned.ok, false)
  assert.equal(planned.code, EXTRACT_CODES.BOMB)
})

test('★ 总量超限被拒（多个条目叠加）', () => {
  const entries = Array.from({ length: 4 }, (_, i) => ({
    name: `f${i}.bin`, bytes: Buffer.alloc(1024), declaredUncompressed: 1024,
  }))
  const zip = makeZip(entries)
  const planned = planExtraction({ archiveBytes: zip, policy: { ...BOMB_POLICY, maxTotalBytes: 3000 } })
  assert.equal(planned.ok, false)
  assert.equal(planned.code, EXTRACT_CODES.BOMB)
})

test('★ 条目数超限被拒', () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, bytes: Buffer.from('x') }))
  const zip = makeZip(entries)
  const planned = planExtraction({ archiveBytes: zip, policy: { ...BOMB_POLICY, maxEntries: 3 } })
  assert.equal(planned.ok, false)
  assert.equal(planned.code, EXTRACT_CODES.BOMB)
})

test('★ deflate 条目的实际展开不能超过声明（上限交给 zlib，不是解完再看）', (t) => {
  const root = scratch(t)
  // 声明 8 字节，实际 deflate 流展开出 4096 字节 —— 一个"声明很小、实际很大"
  // 的条目。读取器必须拒绝它，而不是把 4096 字节写出去。
  const real = Buffer.alloc(4096, 0x41)
  const zip = makeZip([{ name: 'lie.bin', bytes: real, method: 8, declaredUncompressed: 8 }])
  const result = extractArchive({ archiveBytes: zip, targetDir: join(root, 'out') })
  assert.equal(result.ok, false)
  assert.equal(result.code, EXTRACT_CODES.BAD_ARCHIVE)
})

// ---------------------------------------------------------------------------
// ⑤ 未知可执行文件
// ---------------------------------------------------------------------------

test('★ 没有闭包时，可执行文件一律被拒', () => {
  const zip = makeZip([{ name: 'product/evil.exe', bytes: Buffer.from('MZ') }])
  const planned = planExtraction({ archiveBytes: zip })
  assert.equal(planned.ok, false)
  assert.equal(planned.code, EXTRACT_CODES.UNKNOWN_EXECUTABLE)
})

test('★ 有闭包时，闭包之外的可执行文件被拒（摘要对得上不代表包里没别的东西）', () => {
  const allowed = Buffer.from('#!/usr/bin/env node\n')
  const zip = makeZip([
    { name: 'product/launcher/cli.mjs', bytes: allowed },
    { name: 'product/hidden.exe', bytes: Buffer.from('MZ') },
  ])
  const planned = planExtraction({
    archiveBytes: zip,
    closure: [{ path: 'product/launcher/cli.mjs', bytes: allowed.length, sha256: sha256(allowed) }],
  })
  assert.equal(planned.ok, false)
  assert.equal(planned.code, EXTRACT_CODES.UNKNOWN_EXECUTABLE)
  assert.match(planned.reason, /摘要对得上只说明包没被换/)
})

test('闭包之外的非可执行条目按"多余条目"拒（错误码可区分）', () => {
  const zip = makeZip([
    { name: 'a.txt', bytes: Buffer.from('a') },
    { name: 'extra.txt', bytes: Buffer.from('b') },
  ])
  const planned = planExtraction({ archiveBytes: zip, closure: [{ path: 'a.txt', bytes: 1, sha256: sha256(Buffer.from('a')) }] })
  assert.equal(planned.ok, false)
  assert.equal(planned.code, EXTRACT_CODES.EXTRA_ENTRY)
})

test('★ 闭包里缺一个条目 → 拒（"解压前后校验闭包"的前一半）', () => {
  const zip = makeZip([{ name: 'a.txt', bytes: Buffer.from('a') }])
  const planned = planExtraction({
    archiveBytes: zip,
    closure: [
      { path: 'a.txt', bytes: 1, sha256: sha256(Buffer.from('a')) },
      { path: 'missing.txt', bytes: 1, sha256: sha256(Buffer.from('m')) },
    ],
  })
  assert.equal(planned.ok, false)
  assert.equal(planned.code, EXTRACT_CODES.MISSING_ENTRY)
})

test('★ 内容摘要不符 → 拒（闭包授权的是字节，不只是文件名）', (t) => {
  const root = scratch(t)
  const zip = makeZip([{ name: 'a.txt', bytes: Buffer.from('real content') }])
  const result = extractArchive({
    archiveBytes: zip,
    targetDir: join(root, 'out'),
    closure: [{ path: 'a.txt', bytes: 12, sha256: 'f'.repeat(64) }],
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, EXTRACT_CODES.DIGEST_MISMATCH)
})

// ---------------------------------------------------------------------------
// 正常路径
// ---------------------------------------------------------------------------

test('正常路径：stored 与 deflate 条目都能解开，且摘要与计划一致', (t) => {
  const root = scratch(t)
  const out = join(root, 'out')
  const text = Buffer.from('{"format":"legion/version-manifest@1"}\n', 'utf8')
  const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03])
  const zip = makeZip([
    { name: 'product/release/runtime-manifest.json', bytes: text, method: 8 },
    { name: 'data/blob.bin', bytes: binary, method: 0 },
    { name: 'product/launcher/', bytes: Buffer.alloc(0), isDirectory: true },
  ])
  const closure = [
    { path: 'product/release/runtime-manifest.json', bytes: text.length, sha256: sha256(text) },
    { path: 'data/blob.bin', bytes: binary.length, sha256: sha256(binary) },
  ]
  const result = extractArchive({ archiveBytes: zip, targetDir: out, closure })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.fileCount, 2)
  assert.deepEqual(readFileSync(join(out, 'data', 'blob.bin')), binary)
  assert.equal(readFileSync(join(out, 'product', 'release', 'runtime-manifest.json'), 'utf8'), text.toString('utf8'))
  // 解压**之后**的闭包核对必须通过。
  const verdict = verifyExtractedTree({ targetDir: out, expected: closure })
  assert.equal(verdict.ok, true, verdict.problems.join('；'))
})

test('★ 解压之后的核对能发现计划之外的残留文件', (t) => {
  const root = scratch(t)
  const out = join(root, 'out')
  const text = Buffer.from('hello', 'utf8')
  const zip = makeZip([{ name: 'a.txt', bytes: text }])
  extractArchive({ archiveBytes: zip, targetDir: out, closure: [{ path: 'a.txt', bytes: text.length, sha256: sha256(text) }] })
  // 目标目录里有一个**上次升级留下的**文件。
  writeFileSync(join(out, 'stale.exe'), 'MZ', 'utf8')
  const verdict = verifyExtractedTree({ targetDir: out, expected: [{ path: 'a.txt', bytes: text.length, sha256: sha256(text) }] })
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join(' '), /计划之外/)
})

test('★ 解压之后的核对能发现被截断的文件', (t) => {
  const root = scratch(t)
  const out = join(root, 'out')
  const text = Buffer.from('0123456789', 'utf8')
  const zip = makeZip([{ name: 'a.txt', bytes: text }])
  extractArchive({ archiveBytes: zip, targetDir: out, closure: null })
  writeFileSync(join(out, 'a.txt'), '01234', 'utf8')
  const verdict = verifyExtractedTree({ targetDir: out, expected: [{ path: 'a.txt', bytes: 10, sha256: sha256(text) }] })
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join(' '), /大小不符/)
})

test('dryRun：只校验不写文件', (t) => {
  const root = scratch(t)
  const out = join(root, 'out')
  const zip = makeZip([{ name: 'a.txt', bytes: Buffer.from('x') }])
  const result = extractArchive({ archiveBytes: zip, targetDir: out, dryRun: true })
  assert.equal(result.ok, true)
  assert.deepEqual(result.written, [])
  assert.equal(readdirSafe(out).length, 0)
})

// ---------------------------------------------------------------------------
// 归档层自身的判据
// ---------------------------------------------------------------------------

test('非 ZIP / 截断输入：明确报"不是合法归档"，不抛', () => {
  for (const bytes of [Buffer.alloc(4), Buffer.from('x'.repeat(100)), Buffer.alloc(0)]) {
    const read = readCentralDirectory(bytes)
    assert.equal(read.ok, false)
    assert.equal(read.code, EXTRACT_CODES.BAD_ARCHIVE)
  }
  const planned = planExtraction({ archiveBytes: Buffer.from('not a zip') })
  assert.equal(planned.ok, false)
  assert.equal(planned.code, EXTRACT_CODES.BAD_ARCHIVE)
})

test('不支持的压缩方式被拒（只认 stored/deflate）', () => {
  const zip = makeZip([{ name: 'a.txt', bytes: Buffer.from('x'), method: 12 }]) // bzip2
  const planned = planExtraction({ archiveBytes: zip })
  assert.equal(planned.ok, false)
  assert.equal(planned.code, EXTRACT_CODES.UNSUPPORTED_METHOD)
})

test('中央目录里的非法 UTF-8 条目名被拒（避免两个名字落到同一个替换结果）', () => {
  const zip = makeZip([{ name: 'a.txt', bytes: Buffer.from('x') }])
  // 把中央目录里的名字字节改成非法序列。
  const index = zip.lastIndexOf(Buffer.from('a.txt', 'utf8'))
  zip[index] = 0xff
  zip[index + 1] = 0xfe
  const planned = planExtraction({ archiveBytes: zip })
  assert.equal(planned.ok, false)
  assert.equal(planned.code, EXTRACT_CODES.BAD_ARCHIVE)
})

test('validateEntryName 的边界', () => {
  assert.equal(validateEntryName('a/b/c.txt').path, 'a/b/c.txt')
  assert.equal(validateEntryName('a/b/').path, 'a/b')
  assert.equal(validateEntryName('a/b/').segments.length, 2)
  for (const bad of ['a'.repeat(300) + '/x', 'a/' + 'b'.repeat(300)]) {
    assert.equal(validateEntryName(bad).ok, false, `超长段被放行：${bad.slice(0, 20)}…`)
  }
})

test('looksExecutable 覆盖随包 Node 会执行的那些后缀', () => {
  for (const name of ['x.exe', 'x.dll', 'x.node', 'x.bat', 'x.ps1', 'x.mjs', 'x.cjs', 'x.vbs', 'x.msi']) {
    assert.equal(looksExecutable(name), true, `${name} 没被当成可执行`)
  }
  for (const name of ['x.txt', 'x.md', 'x.json', 'notes.zh-CN.txt', 'icon.png']) {
    assert.equal(looksExecutable(name), false, `${name} 被误判为可执行`)
  }
})

function readdirSafe(dir) {
  try { return readdirSync(dir) } catch { return [] }
}
