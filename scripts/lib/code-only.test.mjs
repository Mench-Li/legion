// scripts/lib/code-only.test.mjs
// ============================================================================
// 剥注释工具的判据。
//
// 它自己是"判据的判据"——所以最要紧的是**两个方向都要有反例**：
//   · 注释里的名字必须被**去掉**（否则用它的判据恒真）
//   · 代码里的名字必须被**留下**（否则用它的判据恒假）
//
// 只测一个方向的工具，会让依赖它的判据整体偏向一边 ——
// 而那种偏向在判据本身看来是"绿的"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { codeOnly, codeOfFile } from './code-only.mjs'

// ── ① ★★★ 注释里的名字必须被去掉 ────────────────────────────────────────────

test('★★★ 行注释里的名字被去掉（这是它存在的理由）', () => {
  const src = 'const a = 1 // rmSync 是禁止的\nconst b = rmSync\n'
  const code = codeOnly(src)
  assert.equal(code.includes('rmSync 是禁止的'), false, '注释内容必须被去掉')
  // 而代码里那个真的调用必须**留下**。
  assert.equal(code.includes('rmSync'), true, '代码里的名字必须留下')
  assert.equal(code.split('rmSync').length - 1, 1, '只剩代码里那一处')
})

test('★★★ 块注释（含跨行）里的名字被去掉', () => {
  const src = '/*\n * 这里解释为什么不用 writeFileSync(DEFAULT_STATE_PATH\n */\nconst x = writeFileSync(p)\n'
  const code = codeOnly(src)
  assert.equal(code.includes('writeFileSync(DEFAULT_STATE_PATH'), false, '块注释必须被去掉')
  assert.equal(code.includes('writeFileSync(p)'), true, '代码必须留下')
})

test('★★★ 行尾块注释也被去掉', () => {
  const code = codeOnly('const x = 1 /* rmSync */ + 2\n')
  assert.equal(code.includes('rmSync'), false)
  assert.equal(code.includes('const x = 1'), true)
  assert.equal(code.includes('+ 2'), true)
})

// ── ② ★★★ 代码与字符串必须留下（否则判据恒假）────────────────────────────

test('★★★ 字符串字面量里的名字**留下**（判据要找的就是"代码里出现了什么"）', () => {
  // 例如 `assert.equal(src.includes('rmSync'), false)` 里的 `'rmSync'`
  // 是一个字符串，但它是**代码**的一部分。
  const code = codeOnly("const banned = ['rmSync', 'rmdirSync']\n")
  assert.equal(code.includes('rmSync'), true, '字符串内容必须留下')
  assert.equal(code.includes('rmdirSync'), true)
})

test('★★★ 字符串里的 `//` **不**被当成注释起点', () => {
  // 这是个真陷阱：URL、路径、正则里都有 `//`。
  const code = codeOnly("const u = 'https://example.com/x'\nconst after = 1\n")
  assert.equal(code.includes('https://example.com/x'), true, '字符串必须完整保留')
  assert.equal(code.includes('const after = 1'), true, '它后面的代码不许被吃掉')
})

test('★★ 模板字面量保留（含里面的表达式）', () => {
  const code = codeOnly('const s = `a ${x.b} c`\nconst after = 1\n')
  assert.equal(code.includes('${x.b}'), true)
  assert.equal(code.includes('const after = 1'), true)
})

test('★★ 模板字面量里的 `//` 不被当注释', () => {
  const code = codeOnly('const s = `http://x/y`\nconst after = 2\n')
  assert.equal(code.includes('http://x/y'), true)
  assert.equal(code.includes('const after = 2'), true)
})

// ── ③ ★★★ 行结构必须保住 ──────────────────────────────────────────────────

test('★★★ 换行数不变（否则基于行号的判据会漂）', () => {
  const src = 'const a = 1 // 注释\n/* 跨\n行\n注释 */\nconst b = 2\n'
  assert.equal(codeOnly(src).split('\n').length, src.split('\n').length,
    '剥注释不许改变行数')
})

test('★★ 单行注释不会把下一行吃掉', () => {
  // 「注释吃掉换行」在本仓库里真的造成过一次生产事故（`server.mjs` 那次
  // `const workbenchDist is not defined`）—— 所以这条要有判据。
  const src = '// 一整行注释\nconst live = 1\n'
  const code = codeOnly(src)
  assert.equal(code.includes('const live = 1'), true, '注释不许吞掉下一行')
  // ⚠️ 要跟**源文**比行数，不要写死一个数：结尾的 `\n` 会让 `split` 多出一个
  //    空元素（第一版我写了 `=== 2`，于是判据在正确实现上红了）。
  assert.equal(code.split('\n').length, src.split('\n').length)
  assert.equal(code.split('\n').length, 3, '（同时钉住这个数是 3，免得上面那条变成两个错的数相等）')
})

// ── ④ ★★★ 反例守卫：两个方向合起来证明它**不是**恒真/恒假 ─────────────────

test('★★★ 同一个样本：注释里去掉、代码里留下（一次断言两个方向）', () => {
  const src = [
    '// 我们不能用 rmSync，理由见文件头',
    "const BANNED = ['rmSync']",
    'export function check(src) {',
    '  // src.includes(\'rmSync\')',
    '  return src.includes(BANNED[0])',
    '}',
  ].join('\n')
  const code = codeOnly(src)
  // 注释里那两处没了。
  assert.equal(code.includes('我们不能用 rmSync'), false)
  assert.equal(code.includes("src.includes('rmSync')"), false)
  // 代码里那两处还在。
  assert.equal(code.includes("const BANNED = ['rmSync']"), true)
  assert.equal(code.includes('src.includes(BANNED[0])'), true)
  // 数一数：只剩一处 `rmSync` 字面量。
  assert.equal(code.split('rmSync').length - 1, 1)
})

// ── ⑤ ★★ 畸形输入不抛 ──────────────────────────────────────────────────────

test('★★ 畸形输入不抛，且不吞掉整个文件', () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.doesNotThrow(() => codeOnly(bad))
    assert.equal(codeOnly(bad), '')
  }
  // 未闭合的字符串：不抛，且后面的代码不至于全丢（退化成尽量保留）。
  assert.doesNotThrow(() => codeOnly("const a = 'unterminated\nconst b = 2\n"))
  // 未闭合的块注释：不抛。
  assert.doesNotThrow(() => codeOnly('/* 没关\nconst a = 1'))
})

// ── ⑥ ★★★ 用它扫**真实文件**：本仓库里那个真的踩过的坑 ────────────────────

test('★★★ 真实样本：`storage-check.mjs` 的注释里有 `rmSync`，代码里没有', () => {
  // 这正是它被抽出来的原因 —— 那次判据在**完全正确**的实现上变红。
  const url = new URL('../../scripts/ops/storage-check.mjs', import.meta.url)
  const raw = readFileSync(url, 'utf8')
  const code = codeOnly(raw)
  // 原文件里**有**（注释中解释"为什么禁止 rmSync"）。
  assert.equal(raw.includes('rmSync'), true, '原文件的注释里应当提到它')
  // 代码里**没有**（那正是实现正确的证据）。
  assert.equal(code.includes('rmSync'), false, '代码里不许出现 rmSync')
  // 而一个真的在代码里的名字，两边都有。
  assert.equal(code.includes('statfsSync'), true)
  assert.equal(raw.includes('statfsSync'), true)
  // 行数一致。
  assert.equal(code.split('\n').length, raw.replace(/\r\n/g, '\n').split('\n').length)
})

test('★★ `codeOfFile` 是同一个东西（只是多读一次文件）', () => {
  const url = new URL('./code-only.mjs', import.meta.url)
  const a = codeOfFile(url, readFileSync)
  const b = codeOnly(readFileSync(url, 'utf8'))
  assert.equal(a, b)
})
