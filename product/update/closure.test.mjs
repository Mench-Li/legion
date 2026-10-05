// product/update/closure.test.mjs
// ============================================================================
// 闭包协议的判据 —— 设计 §5 的「包摘要保护完整性」那一半
//
// ★★ 这个文件此前**不存在**，而 `extract.mjs` 里写着：
//
//   > 与 `closure.mjs` 的 `MAX_CLOSURE_BYTES` 是同一个数，但**不**从那里
//   > import：那份模块的路径判据用的正是本模块的 `validateEntryName`，
//   > 反向 import 会成环。两条常量各自声明，**`closure.test.mjs` 有一条
//   > 断言要求它们相等**——一旦有人改了一边，契约就红。
//
//   而 `closure.test.mjs` 不存在 ⇒ 那条断言不存在 ⇒ 两条
//   `MAX_CLOSURE_BYTES` **只靠人工保持一致**（当时它们恰好相等）。
//   这正是"一句'这个契约由某条判据守着'，比没有这句话更坏"的实例：
//   它让下一个人**不去检查**。
//
//   所以本文件的第一条用例就是那条被承诺的断言。
//
// ## 闭包为什么值得单独一组判据
//
// 闭包是"这个包里应该有这些文件、每个多大、每个什么摘要"的**自述**。
// 它有两个消费者，而且两边的失败都是静默的：
//
//   · 发布端 `closureFromDirectory()` 从一棵目录树生成它；
//   · 客户端 `extract.resolveClosureEntry()` 从包里取出它、与解压结果对账。
//
// 两份实现对同一个字符串给出不同结论时，症状是"闭包说没问题、解压说越界"
// （或反过来）——而那一次升级会失败在一个**看起来与路径无关**的地方。
// ============================================================================

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  CLOSURE_CHECKED, CLOSURE_CODES, CLOSURE_ENTRY_NAME, CLOSURE_PROTOCOL, MAX_CLOSURE_BYTES,
  buildClosure, closureDigest, closureFromDirectory, parseClosure, serializeClosure, toClosurePath,
  validateClosure,
} from './closure.mjs'
import { MAX_CLOSURE_BYTES as EXTRACT_MAX_CLOSURE_BYTES, validateEntryName } from './extract.mjs'
import { canonicalJson } from './canonical.mjs'

const sha = (text) => createHash('sha256').update(text).digest('hex')

function entry(path, text) {
  return { path, bytes: Buffer.byteLength(text), sha256: sha(text) }
}

// ---------------------------------------------------------------------------
// ① ★ 那条被承诺的断言（`extract.mjs` 说它在 `closure.test.mjs` 里）
// ---------------------------------------------------------------------------

test('★★★★ 两处 `MAX_CLOSURE_BYTES` 必须相等（`extract.mjs` 承诺的那条断言）', () => {
  // ★ 为什么不从同一处 import：`extract.mjs` 的路径判据用的正是
  //   `closure.mjs` 的 `validateEntryName`，反向 import 会成环。
  //   于是两边各自声明一个数——**代价是必须有人守着它们相等**，
  //   而那个"人"此前是一句不存在的承诺。
  assert.equal(MAX_CLOSURE_BYTES, EXTRACT_MAX_CLOSURE_BYTES,
    '两处 MAX_CLOSURE_BYTES 漂了：闭包条目在一处能过、在另一处被拒（或反过来）')
  // 而且它必须是个**有意义的**上限（不是 0、不是 Infinity）。
  assert.ok(Number.isSafeInteger(MAX_CLOSURE_BYTES) && MAX_CLOSURE_BYTES > 1024 * 1024,
    `闭包上限看起来不合理：${MAX_CLOSURE_BYTES}`)
})

test('★ 闭包协议名与默认条目名是契约的一部分（改名等于换协议）', () => {
  assert.equal(CLOSURE_PROTOCOL, 'legion/update-closure@1')
  assert.equal(CLOSURE_ENTRY_NAME, 'closure.json')
  // 条目名必须能过**路径判据**（它在包内是一个普通条目）。
  assert.equal(CLOSURE_ENTRY_NAME.includes('/'), false)
})

// ---------------------------------------------------------------------------
// ② 构造与规范化：排序与去重是"摘要稳定"的前提
// ---------------------------------------------------------------------------

test('★★ `buildClosure` 自己排序，且不依赖调用方的输入顺序', () => {
  // ★ 排序不是审美：摘要在排序之后才算得稳定，而摘要不稳定会让发布端与
  //   客户端算出不同的值 —— 一次**永远失败**的升级。
  const a = buildClosure([entry('b.txt', 'b'), entry('a.txt', 'a')])
  const b = buildClosure([entry('a.txt', 'a'), entry('b.txt', 'b')])
  assert.deepEqual(a.files.map((f) => f.path), ['a.txt', 'b.txt'])
  assert.equal(serializeClosure(a).toString('utf8'), serializeClosure(b).toString('utf8'),
    '不同的输入顺序得到了不同的闭包字节 —— 摘要会漂')
})

test('★★ `buildClosure` 拒绝重复路径（同一路径两条 = 摘要取决于谁赢）', () => {
  assert.throws(() => buildClosure([entry('a.txt', 'a'), entry('a.txt', 'b')]),
    /重复/, '重复路径被接受了')
})

test('★★ `buildClosure` 拒绝非规范化路径（它在包内是一条归档条目）', () => {
  for (const bad of ['/abs.txt', '../up.txt', 'a//b.txt', 'a/./b.txt', 'a/']) {
    assert.throws(() => buildClosure([{ path: bad, bytes: 1, sha256: sha('x') }]),
      (error) => /不合法|规范化/.test(String(error?.message)), `路径 ${JSON.stringify(bad)} 被接受了`)
  }
})

test('★★ `validateClosure` 逐条判据：协议、字段集合、类型、顺序', () => {
  const good = { protocol: CLOSURE_PROTOCOL, files: [entry('a.txt', 'a')] }
  assert.equal(validateClosure(good).ok, true, JSON.stringify(validateClosure(good).problems))

  const cases = [
    [null, CLOSURE_CODES.BAD_FORMAT, '不是对象'],
    [[], CLOSURE_CODES.BAD_FORMAT, '数组'],
    [{ protocol: 'other', files: [] }, CLOSURE_CODES.BAD_FORMAT, '协议名不对'],
    [{ protocol: CLOSURE_PROTOCOL, files: 'no' }, CLOSURE_CODES.BAD_FORMAT, 'files 不是数组'],
    [{ protocol: CLOSURE_PROTOCOL, files: ['x'] }, CLOSURE_CODES.BAD_ENTRY, '条目不是对象'],
    [{ protocol: CLOSURE_PROTOCOL, files: [{ path: 'a', bytes: 1 }] }, CLOSURE_CODES.BAD_ENTRY, '字段不全'],
    [{ protocol: CLOSURE_PROTOCOL, files: [{ path: 'a', bytes: 1, sha256: sha('x'), extra: 1 }] },
      CLOSURE_CODES.BAD_ENTRY, '多了一个字段'],
    [{ protocol: CLOSURE_PROTOCOL, files: [{ path: '../x', bytes: 1, sha256: sha('x') }] },
      CLOSURE_CODES.PATH_PROBLEM, '路径越界'],
    [{ protocol: CLOSURE_PROTOCOL, files: [{ path: './a', bytes: 1, sha256: sha('x') }] },
      CLOSURE_CODES.PATH_PROBLEM, '路径非规范化'],
    [{ protocol: CLOSURE_PROTOCOL, files: [{ path: 'a', bytes: -1, sha256: sha('x') }] },
      CLOSURE_CODES.BAD_ENTRY, 'bytes 负数'],
    [{ protocol: CLOSURE_PROTOCOL, files: [{ path: 'a', bytes: 1.5, sha256: sha('x') }] },
      CLOSURE_CODES.BAD_ENTRY, 'bytes 非整数'],
    [{ protocol: CLOSURE_PROTOCOL, files: [{ path: 'a', bytes: 1, sha256: 'ABC' }] },
      CLOSURE_CODES.BAD_ENTRY, '摘要不是小写十六进制'],
  ]
  for (const [value, code, label] of cases) {
    const result = validateClosure(value)
    assert.equal(result.ok, false, `${label}：被接受了`)
    assert.equal(result.code, code, `${label}：码是 ${result.code}（期望 ${code}）`)
  }
})

test('★★★ 顺序不是严格升序 ⇒ 拒（`UNSORTED` 与"重复"是两条码）', () => {
  const unordered = {
    protocol: CLOSURE_PROTOCOL,
    files: [entry('b.txt', 'b'), entry('a.txt', 'a')],
  }
  const result = validateClosure(unordered)
  assert.equal(result.ok, false)
  assert.equal(result.code, CLOSURE_CODES.UNSORTED, JSON.stringify(result.problems))
  // ★ 重复路径会**先**撞上 `DUPLICATE`：两条判据的顺序是刻意的
  //   （"重复"比"顺序"更具体，报出来更有用）。
  const dup = validateClosure({
    protocol: CLOSURE_PROTOCOL,
    files: [entry('a.txt', 'a'), entry('a.txt', 'a')],
  })
  assert.equal(dup.code, CLOSURE_CODES.DUPLICATE, JSON.stringify(dup.problems))
  assert.notEqual(CLOSURE_CODES.UNSORTED, CLOSURE_CODES.DUPLICATE)
})

// ---------------------------------------------------------------------------
// ③ 字节口径：规范化 JSON 是**唯一**的编码方式
// ---------------------------------------------------------------------------

test('★★★ `serializeClosure` 走规范化 JSON：字段顺序与输入对象无关', () => {
  // ★ 与信封同一条纪律：签名/摘要只对**一种**字节编码计算。
  //   一个跟着对象字面量顺序走的序列化，会让"同一份闭包"有两个摘要。
  const closure = { files: [entry('a.txt', 'a')], protocol: CLOSURE_PROTOCOL }
  const text = serializeClosure(closure).toString('utf8')
  assert.equal(text, `${canonicalJson(closure)}\n`, '闭包字节不是规范化 JSON + 换行')
  // 键序打乱之后字节仍然相同。
  const shuffled = { protocol: closure.protocol, files: closure.files }
  assert.equal(serializeClosure(shuffled).toString('utf8'), text)
})

test('★★★ 往返：`parseClosure(serializeClosure(x))` 逐字段相同', () => {
  const built = buildClosure([entry('a/b.txt', 'hello'), entry('c.txt', 'world')])
  const bytes = serializeClosure(built)
  const parsed = parseClosure(bytes)
  assert.equal(parsed.ok, true, parsed.reason)
  assert.deepEqual(parsed.files, built.files)
  // ★ 我第一版在这里断言 `parsed.totalBytes === built.totalBytes`——而
  //   `buildClosure` **不**产出 `totalBytes`（它是 `validateClosure` 的**读数**，
  //   不是闭包的一部分）。那条断言测的是我脑子里的形状，不是它们之间的契约。
  //
  //   > 一条断言"两个来自不同函数的东西相等"的用例，
  //   > 在其中一个从来不产出那个字段时，红的是用例、不是实现。
  assert.equal(parsed.totalBytes, built.files.reduce((sum, f) => sum + f.bytes, 0),
    '解析出来的 totalBytes 与逐条求和不同')
  assert.equal(closureDigest(bytes), sha(bytes.toString('utf8')),
    '闭包摘要的口径不是"字节的裸 sha256"')
})

test('★★★ `parseClosure` 拒绝：非严格 JSON、超上限、协议不对', () => {
  // 重复键（严格 JSON 的判据在 `parseJsonStrict` 里）。
  const dupKey = Buffer.from('{"protocol":"legion/update-closure@1","protocol":"x","files":[]}', 'utf8')
  assert.equal(parseClosure(dupKey).ok, false, '带重复键的闭包被接受了')
  assert.equal(parseClosure(dupKey).code, CLOSURE_CODES.BAD_FORMAT)

  // 超上限：**不读内容**就能拒（否则上限没有意义）。
  const huge = Buffer.alloc(MAX_CLOSURE_BYTES + 1, 0x20)
  const tooLarge = parseClosure(huge)
  assert.equal(tooLarge.ok, false)
  assert.equal(tooLarge.code, CLOSURE_CODES.TOO_LARGE, JSON.stringify(tooLarge))

  const wrongProto = parseClosure(Buffer.from('{"protocol":"nope","files":[]}', 'utf8'))
  assert.equal(wrongProto.ok, false)
  assert.equal(wrongProto.code, CLOSURE_CODES.BAD_FORMAT)
})

// ---------------------------------------------------------------------------
// ④ 从目录树构造：符号链接/非普通文件必须拒
// ---------------------------------------------------------------------------

test('★★ `closureFromDirectory` 拒绝目录树里的符号链接/重解析点', (t) => {
  // ★ 理由与解压端同一条：一份"从符号链接读出来"的闭包描述的是**另一个
  //   位置**的内容，而解压端会按路径去找，找到的东西可能不同。
  const root = mkdtempSync(join(tmpdir(), 'legion-closure-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'real.txt'), 'real')
  writeFileSync(join(root, 'link.txt'), 'link')

  // ★ 两套造法，都指向同一个要被拒的形状（重解析点）：
  //   优先试普通文件符号链接；Windows 上它是 EPERM，退到**目录联接**
  //   （不需要特权，而 Node 对它的 `isSymbolicLink()` 也报 `true`）。
  let made = null
  try {
    rmSync(join(root, 'link.txt'))
    symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'), 'file')
    made = 'file-symlink'
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
    try {
      symlinkSync(root, join(root, 'self-link'), 'junction')
      made = 'junction'
    } catch (inner) {
      t.skip(`本环境两种重解析点都建不了（${error?.code} / ${inner?.code}）——这一条没有跑，不是通过`)
      return
    }
  }
  const collected = closureFromDirectory(root)
  assert.equal(collected.ok, false, `重解析点（${made}）被收进闭包了`)
  assert.ok(collected.problems.some((p) => /符号链接|重解析/.test(p)),
    `拒绝理由没提到重解析点：${collected.problems.join('；')}`)
})

test('★★ 从真目录树构造的闭包，逐条与磁盘对得上', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'legion-closure-ok-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'nested'), { recursive: true })
  writeFileSync(join(root, 'top.txt'), 'top')
  writeFileSync(join(root, 'nested', 'deep.txt'), 'deep')

  const collected = closureFromDirectory(root)
  assert.equal(collected.ok, true, collected.problems.join('；'))
  assert.deepEqual(collected.closure.files.map((f) => f.path), ['nested/deep.txt', 'top.txt'])
  for (const file of collected.closure.files) {
    const onDisk = readFileSync(join(root, ...file.path.split('/')))
    assert.equal(file.bytes, onDisk.length, `${file.path} 的字节数不对`)
    assert.equal(file.sha256, sha(onDisk.toString('utf8')), `${file.path} 的摘要不对`)
  }
  // 而且它必须能被解析回来（发布端 → 客户端的往返）。
  const round = parseClosure(serializeClosure(collected.closure))
  assert.equal(round.ok, true, round.reason)
  assert.deepEqual(round.files, collected.closure.files)
})

// ---------------------------------------------------------------------------
// ⑤ 与归档口径的一致性：`toClosurePath`
// ---------------------------------------------------------------------------

test('★★★ `toClosurePath` 与归档条目用**同一个**路径口径', () => {
  // ★ 两份实现会在某一次改动之后对同一个字符串给出不同结论，
  //   而那意味着"闭包说没问题、解压说越界"。
  const root = process.cwd()
  const inside = join(root, 'product', 'update', 'closure.mjs')
  assert.equal(toClosurePath(root, inside), 'product/update/closure.mjs',
    '闭包路径没有用 / 分隔或没去掉根前缀')

  // ★★ 关于越界路径：这个函数**不**负责判越界——它的文档写的是"相对路径口径
  //    （发布端列目录时用）"，而发布端列目录时每一项**按构造**都在树内。
  //    我第一版在这里断言"越界路径必须返回 null 或非 `..` 前缀"，那是把一个
  //   它从未声称的性质加在它头上。
  //
  //    真正该判的是**接得上**：它给出的越界路径必须被**下一层**拒掉
  //    （闭包校验与解压共用同一个 `validateEntryName`）。这才是安全性质的位置。
  const outside = toClosurePath(root, join(root, '..', 'elsewhere.txt'))
  assert.equal(validateEntryName(outside).ok, false,
    `越界路径 ${JSON.stringify(outside)} 竟然能过路径判据 —— 那么"闭包说没问题、解压说越界"的接缝就断了`)
  // 顺着这个口径产出的**树内**路径必须能过同一套判据。
  assert.equal(validateEntryName(toClosurePath(root, inside)).ok, true)
})

// ---------------------------------------------------------------------------
// ⑥ 自检本身是"检查过的"
// ---------------------------------------------------------------------------

test('★★ 装载期自检结论 ok，且它**真的查了东西**', () => {
  assert.equal(CLOSURE_CHECKED.ok, true, JSON.stringify(CLOSURE_CHECKED.problems))
  // ★ 一条永远返回 ok 的自检比没有自检更糟（它会让"有人放宽了某条拒绝"
  //   看起来已经通过）。所以至少要求它报出**非零**的读数量。
  const readings = Object.entries(CLOSURE_CHECKED)
    .filter(([key]) => key !== 'ok' && key !== 'problems')
  assert.ok(readings.length > 0, '自检没有报出任何读数量 —— 它可能什么都没查')
  assert.ok(readings.some(([, value]) => typeof value === 'number' && value > 0)
    || readings.some(([, value]) => Array.isArray(value) && value.length > 0),
  `自检的读数量全是空的：${JSON.stringify(readings)}`)
})
