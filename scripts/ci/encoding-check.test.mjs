// scripts/ci/encoding-check.test.mjs
// ============================================================================
// 判据：源文件编码完整性门禁（scripts/ci/encoding-check.mjs）
//
// 为什么这道门禁存在（一次真实的教训，见模块头注释）：
//   用 PowerShell `Get-Content -Raw` / `Set-Content` 往返改写一个 UTF-8 源文件时，
//   多字节 CJK 字符会被写成 U+FFFD。文件**仍然能被 Node 解析**——被吃掉的字符在
//   字符串字面量**内部**，语法没坏、测试照样跑，只是那句错误信息悄悄变了样。
//
//   > 一个「在多字节字符被吃掉之后仍然能通过语法检查」的文件，
//   > 与一个「看起来没变、其实信息已经变了」的文件，是同一个东西。
//
// 用例直接打 `inspectBuffer` 这个纯函数（唯一需要注入的是字节）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { inspectBuffer, isTextFile } from './encoding-check.mjs'

const buf = (s) => Buffer.from(s, 'utf8')

// ------------------------------------------------- ① U+FFFD

test('① ★★ U+FFFD 一定判失败（它在字符串字面量里时语法完全正常）', () => {
  // 真实损坏的形态：'不一定' 的 '定' 被吃掉
  const corrupt = buf("throw fail('本模块不做分词——分词结果与执行时的分词器不一定\uFFFD')\n")
  const p = inspectBuffer(corrupt, 'runtime/dsh-composition/x.mjs')
  assert.equal(p.length, 1)
  assert.equal(p[0].kind, 'replacement-char')
  assert.equal(p[0].severity, 'fail')
  assert.match(p[0].detail, /U\+FFFD/)
  assert.match(p[0].detail, /第 1 行/)
  // ★ 关键：这份"损坏"的文件**语法完全正常**——这就是它危险的地方
  const text = corrupt.toString('utf8')
  assert.equal(text.includes('\uFFFD'), true)
  assert.doesNotThrow(() => new Function(`return ${JSON.stringify(text)}`))
  // 多个 U+FFFD 会报出总数
  const many = inspectBuffer(buf('a\uFFFDb\uFFFDc'), 'x.mjs')
  assert.match(many[0].detail, /含 2 个/)
  // 干净的文件不报
  assert.deepEqual(inspectBuffer(buf("const a = '不一定'\n"), 'x.mjs'), [])
  // 行号是对的（第 3 行的损坏）
  const line3 = inspectBuffer(buf('a\nb\nc\uFFFDd\n'), 'x.mjs')
  assert.match(line3[0].detail, /第 3 行/)
})

// ------------------------------------------------- ② 为什么没有"孤立代理项"这一条

test('② ★★ 非法 UTF-8 序列**全部**衰减成 U+FFFD，所以不需要单独查代理项', () => {
  // 曾经写过一条"孤立代理项"检查。它**不可能触发**：唯一入口是
  // `readFileSync(...).toString('utf8')`，而 Node 的解码器把所有非法序列都换成 U+FFFD
  // ——包括 CESU-8/WTF-8 形式的代理项。
  //
  //   > 一个「检查一个不可能出现的值」的检查，
  //   > 与一条不存在的检查，在"它到底拦住了什么"上是同一个东西。
  //
  // 这条用例把"不可达"这件事**钉住**：如果哪天 Node 换了行为（解码器开始透出
  // 代理项），它会在这里变红，那时才需要把那条检查加回来。
  const cesu8High = Buffer.from([0xed, 0xa0, 0x80])          // CESU-8 形式的 U+D800
  const cesu8Low = Buffer.from([0xed, 0xb0, 0x80])           // CESU-8 形式的 U+DC00
  const fourByteSurrogate = Buffer.from([0xf0, 0x8d, 0xa0, 0x80]) // 4 字节形式，仍解成 U+D800
  const truncated = Buffer.from([0xe4, 0xb8])                // 被截断的三字节序列
  const overlong = Buffer.from([0xc0, 0x80])                 // 过长编码
  const loneContinuation = Buffer.from([0x80])               // 孤立的续接字节

  for (const [label, b] of [['CESU-8 高', cesu8High], ['CESU-8 低', cesu8Low], ['4 字节代理项', fourByteSurrogate], ['截断', truncated], ['过长', overlong], ['孤立续接', loneContinuation]]) {
    const s = b.toString('utf8')
    // ★ 关键断言：结果里**没有**代理项，只有 U+FFFD
    const surrogates = [...s].filter((ch) => ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff)
    assert.equal(surrogates.length, 0, `${label} 解出了代理项（不可达性被打破，需要加回检查）`)
    assert.ok(s.includes('\uFFFD'), `${label} 没有衰减成 U+FFFD`)
  }
  // 而 U+FFFD 这一条**能**抓住它们（这就是"兜底"的意思）
  for (const b of [cesu8High, cesu8Low, fourByteSurrogate, truncated, overlong, loneContinuation]) {
    const p = inspectBuffer(b, 'x.mjs')
    assert.equal(p.length, 1)
    assert.equal(p[0].kind, 'replacement-char')
    assert.equal(p[0].severity, 'fail')
  }
  // ★ 反过来：合法的 4 字节字符（真正 > U+FFFF 的那些）**不能**被误判
  //   > 一个「把合法非 BMP 字符也判成损坏」的检查，
  //   > 与一个「见到 4 字节就报警」的检查，是同一个东西——而它会训练人忽略这道门禁。
  for (const s of ['𝄞 音乐符号', 'emoji 🎉 完成', '中文简体 繁體 日本語 한국어']) {
    assert.deepEqual(inspectBuffer(buf(s), 'a.md'), [], s)
  }
  // 成对代理项在 JS 里合法 —— 直接构造字符串时也不该被误判（虽然这条路径不走 Buffer）
  assert.equal([...'🎉'].length, 1)
  assert.equal('🎉'.length, 2)
})

// ------------------------------------------------- ③ NUL 按扩展名分级

test('③ ★★ NUL 字节：代码里判失败，采集类文档只记账', () => {
  //   > 一个「为了让门禁变绿而不再检查」的检查，
  //   > 与一个「把历史遗留当成新回归、于是门禁永远红」的检查，是同一个东西——
  //   > 两者都让这道门禁不再说话。
  const utf16 = Buffer.from('\uFEFF# 标题\n正文\n', 'utf16le')
  assert.ok(utf16.includes(0), '夹具：UTF-16LE 里应当有 NUL 字节')
  // 代码 / 配置 ⇒ FAIL
  for (const rel of ['a.mjs', 'a.js', 'a.ts', 'a.json', 'a.yml', 'a.sql', 'a.sh', 'dir/b.ps1']) {
    const p = inspectBuffer(utf16, rel)
    assert.equal(p.length, 1, rel)
    assert.equal(p[0].kind, 'nul-bytes', rel)
    assert.equal(p[0].severity, 'fail', rel)
  }
  // 采集类文档 ⇒ note（仍报出来，但不判失败）
  for (const rel of ['docs/T058-run.txt', 'scratch/baseline/RESEARCH-T096.md', 'a.markdown']) {
    const p = inspectBuffer(utf16, rel)
    assert.equal(p.length, 1, rel)
    assert.equal(p[0].severity, 'note', rel)
  }
  // NUL 命中后**直接返回**：按 UTF-8 再判后面两项没有意义
  const both = Buffer.concat([utf16, buf('\uFFFD')])
  assert.equal(inspectBuffer(both, 'a.mjs').length, 1)
  assert.equal(inspectBuffer(both, 'a.mjs')[0].kind, 'nul-bytes')
  // 比率出现在说明里
  assert.match(inspectBuffer(utf16, 'a.mjs')[0].detail, /%/)
})

// ------------------------------------------------- ④ 只扫文本类文件

test('④ ★★ 二进制扩展名不进扫描（图片 / SQLite 本来就有任意字节）', () => {
  //   > 一个「把所有文件都按 UTF-8 检查」的检查，
  //   > 与一个「因为仓库里有 .jpg 所以永远红」的检查，是同一个东西。
  const binary = Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x89, 0x50, 0x4e, 0x47])
  for (const rel of ['a.jpg', 'a.png', 'a.db', 'a.db-wal', 'a.db-shm', 'a.zip', 'a.woff2', 'a.ico', 'a.pdf']) {
    assert.equal(isTextFile(rel), false, rel)
  }
  // 文本类要进
  for (const rel of ['a.mjs', 'a.ts', 'a.json', 'a.md', 'a.yml', 'a.css', 'a.html', 'a.txt', 'a.sql', 'a.svg']) {
    assert.equal(isTextFile(rel), true, rel)
  }
  // 没扩展名但一定是文本的
  for (const rel of ['LICENSE', 'Makefile', 'Dockerfile', 'CODEOWNERS', 'NOTICE']) {
    assert.equal(isTextFile(rel), true, rel)
  }
  // 没扩展名、也不在白名单里 ⇒ 不扫
  assert.equal(isTextFile('some-binary'), false)
  // 判定只看 basename，不看目录（`docs/x.txt` 与 `x.txt` 一样）
  assert.equal(isTextFile('a/b/c/x.txt'), true)
  // 上面那份二进制**永远不会**被 inspectBuffer 看到 —— 由调用方的过滤保证
  assert.ok(binary.includes(0))
})

// ------------------------------------------------- ⑤ 组合

test('⑤ ★★ 一份文件同时有多种损坏时，NUL 会短路（按 UTF-8 再判就不成立了）', () => {
  // NUL 命中后直接返回：那时"按 UTF-8 解码"这件事本身不成立，
  // 继续判 U+FFFD 只会报出一堆由错误解码产生的噪音，而不是真正的信息。
  const nulAndFffd = Buffer.concat([buf('\uFFFD'), Buffer.from('a\u0000b')])
  assert.deepEqual(inspectBuffer(nulAndFffd, 'x.mjs').map((p) => p.kind), ['nul-bytes'])
  // 而 UTF-8 编码的 U+FFFD 字节序列（EF BF BD）本身也能被认出来
  const encodedFffd = Buffer.from([0xef, 0xbf, 0xbd])
  assert.equal(encodedFffd.toString('utf8'), '\uFFFD')
  assert.equal(inspectBuffer(encodedFffd, 'x.mjs')[0].kind, 'replacement-char')
  // 每条问题都带 severity（调用方靠它分流 fail / note）
  for (const p of inspectBuffer(encodedFffd, 'x.mjs')) assert.ok(['fail', 'note'].includes(p.severity))
})

test('⑤ ★★ 空文件与纯 ASCII 安静通过', () => {
  assert.deepEqual(inspectBuffer(Buffer.alloc(0), 'a.mjs'), [])
  assert.deepEqual(inspectBuffer(buf('plain ascii\n'), 'a.mjs'), [])
  // 正常的中日韩内容（含 4 字节区）安静通过
  assert.deepEqual(inspectBuffer(buf('中文简体 繁體 日本語 한국어\n'), 'a.md'), [])
})
