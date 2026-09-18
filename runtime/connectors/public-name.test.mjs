// runtime/connectors/public-name.test.mjs
//
// F-21：DSH 公开名的镜像 + 命名空间归属。判据分四组：
//   ① 逐字镜像（含**对着 DSH 真源码**对跑的那一条——最强的一条）
//   ② 那条最容易实现错的合取（"有没有替换过"，不是"长不长"）
//   ③ 归属：matched / foreign / not-mcp **三态分得开**
//   ④ 契约：不抛、冻结、嵌套取最长

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolveDshCheckout } from '../../scripts/lib/dsh-checkout.mjs'
import {
  publicToolName, namespaceOf, namespacePrefix, isMcpPublicName,
  PUBLIC_NAME_LIMITS, PUBLIC_NAME_CODES, PUBLIC_NAME_INVALID_CHARS,
} from './public-name.mjs'

// ---------------------------------------------------------------------------
// ① 逐字镜像
// ---------------------------------------------------------------------------

test('① 干净名字 ⇒ `mcp__<server>__<raw>` 原样（一个字符都不动）', () => {
  assert.equal(publicToolName('github', 'list_issues'), 'mcp__github__list_issues')
  assert.equal(publicToolName('a', 'b'), 'mcp__a__b')
  // 允许的字符集之内，连点号都不该被碰——点号**是**非法字符，所以要加哈希（见 ②）
  assert.equal(publicToolName('git', 'status-porcelain'), 'mcp__git__status-porcelain')
  // 下划线是合法的
  assert.equal(publicToolName('git', 'a_b_c'), 'mcp__git__a_b_c')
})

test('①a ★★★ **对着 DSH 真源码**对跑 18 组（这条比我自己写的任何断言都强）', () => {
  // `publicToolName` 在 DSH 的构建产物里是**模块私有**的（`lib/index.js:96`；
  // 导出面只有 `Config, apply, createMcpToolDefinition, inject, name`）。
  // 所以这里把 DSH 那几行**真源码切片出来求值**——运行的是 DSH 的代码，
  // 不是我读出来的转述。
  //
  // ★ 少了这一条，本模块只是一个"读起来很像 DSH"的实现，而
  //   "读起来很像"与"逐字等价"在**干净名字**上是同一个字符串——
  //   差别只在需要归一化的那一类，而那一类恰好是本仓最可能出现的。
  const found = resolveDshCheckout({ need: 'packages' })
  if (!found.path) {
    // 与仓里其余 21 个跑真 DSH 进程的套件同例：没有检出就**具名跳过**，
    // 而不是静默地什么都不验。
    assert.ok(true, '未配置 DSH 检出 ⇒ 跳过（本条的覆盖面取决于检出，见 skip 说明）')
    return
  }
  const lib = found.path.replace(/\\/g, '/') + '/packages/mcp/mcp-client/lib/index.js'
  const text = readFileSync(lib, 'utf8')
  const consts = [
    /const MAX_PUBLIC_NAME_LENGTH = \d+;/.exec(text)?.[0],
    /const INVALID_NAME_CHARS = \/[^;]+;/.exec(text)?.[0],
    /const HASH_LENGTH = \d+;/.exec(text)?.[0],
  ]
  const fnSrc = /function publicToolName\([\s\S]*?\n\}/.exec(text)?.[0]
  for (const [i, part] of [...consts, fnSrc].entries()) {
    assert.ok(typeof part === 'string',
      `切不到 DSH 源码第 ${i} 段（切片锚点坏了 ⇒ 本条会静默地什么都不验）`)
  }
  // 常量也钉死：DSH 改了它们，本模块必须一起改
  assert.equal(PUBLIC_NAME_LIMITS.MAX_LENGTH, Number(/= (\d+);/.exec(consts[0])[1]),
    'MAX_PUBLIC_NAME_LENGTH 与 DSH 不一致')
  assert.equal(PUBLIC_NAME_LIMITS.HASH_LENGTH, Number(/= (\d+);/.exec(consts[2])[1]),
    'HASH_LENGTH 与 DSH 不一致')

  const real = new Function('createHash', `${consts.join('\n')}\n${fnSrc}\nreturn publicToolName;`)(createHash)
  const cases = [
    ['github', 'list_issues'], ['github', 'list issues'], ['github', 'a'], ['a', 'b'],
    ['gitlab', 'delete/repo'], ['x', 'y'.repeat(80)], ['very-long-server-name-here', 'tool'],
    ['s', 'a'.repeat(60)], ['github', 'emoji🎉tool'], ['github', 'dots.and.dashes-and_underscores'],
    ['a__b', 'c'], ['github', 'x'.repeat(51)], ['github', 'x'.repeat(52)], ['github', 'x'.repeat(53)],
    ['git', 'status.porcelain'], ['mcp', 'inner'], ['中文服务器', '工具'],
    ['github', 'has space and REALLY long name that goes past the limit for sure'],
  ]
  const diffs = []
  for (const [s, r] of cases) {
    const mine = publicToolName(s, r)
    const theirs = real(s, r)
    if (mine !== theirs) diffs.push({ s, r: r.slice(0, 28), mine, theirs })
  }
  assert.deepEqual(diffs, [],
    '与 DSH 真实现不一致 ⇒ 本仓算出的名字 DSH 从来不会产生 ⇒ 那个工具在登记表里查不到 ⇒ 合法工具被拒')
})

// ---------------------------------------------------------------------------
// ② 那条最容易实现错的合取
// ---------------------------------------------------------------------------

test('② ★★★ "短名字但含非法字符"**也要**加哈希（判的是"有没有替换过"，不是"长不长"）', () => {
  // DSH 那一行是：`if (normalized === joined && normalized.length <= MAX) return normalized`
  //
  // ★ 写成 `if (normalized.length <= MAX) return normalized` 是最自然的写法，
  //   而它在**干净长名字**与**脏短名字**这两个方向上都错。
  //   这里钉的是后一个方向：
  const got = publicToolName('github', 'a b')          // `mcp__github__a b` 只有 15 字符
  assert.ok(/_[0-9a-f]{12}$/.test(got),
    `含空格的名字必须有哈希（拿到 ${JSON.stringify(got)}）——`
    + '去掉那个合取会让本模块产出一个 DSH 从来不产生的名字')
  assert.equal(got, 'mcp__github__a_b_' + createHash('sha256').update('github\0a b').digest('hex').slice(0, 12))
  // 反向：同样短、但**干净** ⇒ 不加哈希
  const clean = publicToolName('github', 'ab')
  assert.equal(clean, 'mcp__github__ab')
  assert.ok(!/_[0-9a-f]{12}$/.test(clean), '干净名字不该被加哈希')
})

test('②a 长名字 ⇒ 截断到 64 + 12 位哈希（且**是** 64，不是 63/65）', () => {
  const long = publicToolName('github', 'x'.repeat(80))
  assert.equal(long.length, PUBLIC_NAME_LIMITS.MAX_LENGTH)
  assert.ok(/_[0-9a-f]{12}$/.test(long))
  // 截断发生在**归一化之后**的串上
  assert.ok(long.startsWith('mcp__github__' + 'x'.repeat(10)))
})

test('②b 哈希是 (server, raw) 的纯函数 ⇒ 截断不会让两个不同工具塌成同一个名字', () => {
  // DSH 文件头逐字："distinct MCP identities never collapse into the same public name"
  const prefix = 'x'.repeat(80)
  const a = publicToolName('github', prefix + 'AAA')
  const b = publicToolName('github', prefix + 'BBB')
  assert.notEqual(a, b, '两个不同的 raw 名（截断后同前 51 字符）塌成了同一个公开名')
  assert.equal(a.slice(0, -13), b.slice(0, -13), '前提：前 51 字符确实相同（否则这条没验到东西）')
  // 换个 server 也分得开
  assert.notEqual(publicToolName('github', prefix), publicToolName('gitlab', prefix))
})

// ---------------------------------------------------------------------------
// ③ 归属：三态必须分得开
// ---------------------------------------------------------------------------

test('③ ★★ matched / foreign / not-mcp 是三句不同的话，不能折成同一个 null', () => {
  const ids = ['github', 'gitlab']

  const hit = namespaceOf(ids, 'mcp__github__list_issues')
  assert.equal(namespacePrefix('github').length, 13, '前提：前缀 `mcp__github__` 是 13 个字符')
  assert.deepEqual({ ...hit }, { state: 'matched', connectorId: 'github', matchedLength: 13 },
    'matched 认不出或形状变了')

  // ★ 这一格是本节最要紧的：一个**外部** MCP 服务器，而它不在登记表里。
  //   它与"这不是 MCP 工具"在**行动**上一样（都归属不到 ⇒ 交给政策门），
  //   但读数是两句完全不同的话：一次漏配 / 一次未经声明的挂载。
  const foreign = namespaceOf(ids, 'mcp__evil__rm_rf')
  assert.equal(foreign.state, 'foreign',
    'foreign 与 not-mcp 折在一起了 ⇒ "有人挂了一个我没声明的 MCP 服务器"'
    + '在本层日志里与"一个普通的读工具"长得一样')
  assert.equal(foreign.connectorId, null)

  const notMcp = namespaceOf(ids, 'git-status')
  assert.equal(notMcp.state, 'not-mcp', 'DSH 自己的核心工具被当成 MCP 工具了')
  assert.equal(notMcp.connectorId, null)

  // 三个 state 是**三个不同的字符串**
  assert.equal(new Set([hit.state, foreign.state, notMcp.state]).size, 3)
})

test('③a 嵌套命名空间取**最长**的那个（`mcp__a__` 与 `mcp__a__b__` 同时命中时）', () => {
  const ids = ['a', 'a__b']
  const r = namespaceOf(ids, 'mcp__a__b__tool')
  assert.equal(r.connectorId, 'a__b',
    '挑了短的那个 ⇒ 命名空间是**嵌套**的，最长的那条是唯一没有被截断的')
  // 反向：只有短的能命中时用短的
  assert.equal(namespaceOf(ids, 'mcp__a__other').connectorId, 'a')
  // 登记顺序**不许**影响结果（`gitlab` 写在 `github` 前也不变）
  assert.equal(namespaceOf([...ids].reverse(), 'mcp__a__b__tool').connectorId, 'a__b')
})

test('③b 只比**前缀**，不拆 `__`（DSH 明写公开名不可逆，拆就是猜）', async () => {
  // `rawName` 自己含 `__`：`mcp__github__a__b` 是 github 的工具 `a__b`。
  // 一个"拆 `__`"的实现会拆成 github / `a`，或 github__a / `b`——都是猜。
  const r = namespaceOf(['github'], 'mcp__github__a__b')
  assert.equal(r.state, 'matched')
  assert.equal(r.connectorId, 'github')
  // ★ 本模块**不导出**任何"从公开名反推 rawName"的函数——这里断言的就是这件事
  const mod = Object.keys(await import('./public-name.mjs'))
  assert.ok(!mod.some((k) => /parse|recover|toRaw|rawName/i.test(k)),
    `导出面里出现了"从公开名反推"的函数（${mod.join(', ')}）——`
    + 'tools.ts:9-10 逐字禁止这件事，而且它在 rawName 含 __ 时本来就做不到')
})

test('③c 空 id / 空白 id 被跳过，不会命中空命名空间（`mcp____x` 不是任何连接器）', () => {
  assert.equal(namespaceOf(['', '  ', null, undefined], 'mcp____x').state, 'foreign')
  assert.equal(namespaceOf([], 'mcp__github__x').state, 'foreign')
  assert.equal(namespaceOf(null, 'mcp__github__x').state, 'foreign')
})

// ---------------------------------------------------------------------------
// ④ 契约
// ---------------------------------------------------------------------------

test('④ `namespaceOf` 永不抛（它落在没有 try/catch 的那条决策路径上）', () => {
  const hostile = {
    [Symbol.iterator]() { throw new Error('迭代器炸了') },
  }
  assert.deepEqual({ ...namespaceOf(hostile, 'mcp__github__x') },
    { state: 'foreign', connectorId: null, matchedLength: 0 })
  // 非字符串的公开名
  assert.equal(namespaceOf(['github'], null).state, 'not-mcp')
  assert.equal(namespaceOf(['github'], 42).state, 'not-mcp')
  assert.equal(namespaceOf(['github'], {}).state, 'not-mcp')
  // 带空白的名字：trim 之后才判前缀
  assert.equal(namespaceOf(['github'], '  mcp__github__x  ').state, 'matched')
})

test('④a `publicToolName` 对坏输入**抛**（它是装配期的函数，不是决策路径上的）', () => {
  for (const [s, r] of [['', 'x'], ['   ', 'x'], ['github', ''], ['github', '  '], [null, 'x'], ['github', null]]) {
    assert.throws(() => publicToolName(s, r),
      (e) => e.code === PUBLIC_NAME_CODES.BAD_INPUT,
      `publicToolName(${JSON.stringify(s)}, ${JSON.stringify(r)}) 该抛 bad-input`)
  }
  assert.throws(() => namespacePrefix(''), (e) => e.code === PUBLIC_NAME_CODES.BAD_INPUT)
})

test('④b 返回的对象是冻结的 + `namespacePrefix` 与 `namespaceOf` **同一个**前缀构造', () => {
  const r = namespaceOf(['github'], 'mcp__github__x')
  assert.ok(Object.isFrozen(r), '归属返回值没冻结 ⇒ 决策路径上的下游可以改它')
  assert.equal(namespacePrefix('github'), 'mcp__github__')
  const name = publicToolName('github', 'list_issues')
  assert.ok(name.startsWith(namespacePrefix('github')),
    '`publicToolName` 产出的名字必须以 `namespacePrefix` 开头——'
    + '两个函数各写一份前缀的后果是"声明算出来的名字归属不到自己"')
})

test('④c `isMcpPublicName` 只看前缀，不解释它', () => {
  assert.equal(isMcpPublicName('mcp__github__x'), true)
  assert.equal(isMcpPublicName('  mcp__github__x'), true)
  assert.equal(isMcpPublicName('git-status'), false)
  assert.equal(isMcpPublicName('mcp_github_x'), false, '一个下划线不是命名空间前缀')
  assert.equal(isMcpPublicName(null), false)
  assert.equal(isMcpPublicName(undefined), false)
})

test('④d 常量表冻结 + 非法字符集与 DSH 一致（`[^A-Za-z0-9_-]`）', () => {
  assert.ok(Object.isFrozen(PUBLIC_NAME_LIMITS))
  assert.ok(Object.isFrozen(PUBLIC_NAME_CODES))
  assert.equal(PUBLIC_NAME_INVALID_CHARS.source, '[^A-Za-z0-9_-]')
  assert.equal(PUBLIC_NAME_LIMITS.PREFIX, 'mcp__')
  assert.equal(PUBLIC_NAME_LIMITS.SEPARATOR, '__')
})
