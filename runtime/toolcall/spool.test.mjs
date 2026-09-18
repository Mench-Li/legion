// runtime/toolcall/spool.test.mjs
// ============================================================================
// PRT-610 出站车道的**写入侧**判据。
//
// 每一例都在问同一个问题：**反过来的写法会表现成什么**，以及**那两种表现在读数上
// 是不是同一个**。判据断言的是**码与字段**，不是"跑通了"。
//
//   · ① Run id 不许消毒（消毒 = 两个 Run 合流成一本账）
//   · ② 坏行必须逐条具名（跳过 = 账本越读越短，而它看起来像"只调了 3 个工具"）
//   · ③ 缺文件 ≠ 空文件
//   · ④ 无损：CJK / 嵌套 / 值里的换行 都要原样回得来（`assertCanonicalMatchesRaw` 要用）
//   · ⑤ 结构校验在这里，**语义**校验不在这里（词表只有一份）
//   · ⑥ 追加写（永不重写）、逐 Run 隔离
//   · ⑦ 一条记录不许跨行（挡的是"有人换了序列化器"）
//   · ⑧ kind 词表与必填字段表必须对齐（自检可被构造出来）
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  TOOLCALL_SPOOL_CHECKED,
  TOOLCALL_SPOOL_CODES,
  TOOLCALL_SPOOL_KINDS,
  TOOLCALL_SPOOL_REQUIRED,
  TOOLCALL_SPOOL_VERSION,
  appendSpoolRecord,
  assertKindsCovered,
  assertSpoolRecord,
  encodeSpoolRecord,
  readSpoolRecords,
  safeRunId,
  spoolDirFor,
  spoolFileFor,
} from './spool.mjs'

const root = mkdtempSync(join(tmpdir(), 'legion-toolcall-spool-'))
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }) } catch {} })

/** 一条合法的 `decision` 记录——字段名**逐字**取自 `toolCallRowOf()` 的产出。 */
function decisionRow(over = {}) {
  return {
    kind: TOOLCALL_SPOOL_KINDS.DECISION,
    row: {
      callId: 'call-1',
      toolName: 'git-commit',
      decision: 'deny',
      decisionSource: 'pre-execute',
      reason: '策略门拒绝（不允许提交）',
      rawInput: { message: 'x' },
      canonicalInput: { message: 'x' },
      canonicalHash: 'deadbeef'.repeat(8),
      runId: 'run-1',
      attemptId: 'att-1',
      atText: '2026-09-18T00:00:00.000Z',
      ...over,
    },
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ① ★★★ Run id 不许消毒
// ══════════════════════════════════════════════════════════════════════════

test('① ★★★ Run id 含分隔符时**拒绝**——消毒会让两个 Run 落进同一个目录', () => {
  const bad = ['', '   ', null, undefined, 42, '.', '..', 'a/b', 'a\\b', 'C:evil', 'a\0b', 'a\u001fb',
    'run-1.', 'run-1 ', 'run-1. ', 'run-1..']
  for (const v of bad) {
    assert.throws(
      () => safeRunId(v),
      (err) => err.code === TOOLCALL_SPOOL_CODES.BAD_RUN_ID,
      `${JSON.stringify(v)} 应当被拒（BAD_RUN_ID）`,
    )
  }

  // ★ 反证：把"消毒"这个错写法**真的执行一遍**，看它怎么把两个 Run 合成一个。
  const sanitize = (id) => String(id).replace(/[/\\:]/g, '_')
  assert.equal(sanitize('a/b'), 'a_b', '消毒把 a/b 变成 a_b')
  assert.equal(sanitize('a_b'), 'a_b', '而 a_b 消毒之后**还是** a_b')
  assert.equal(
    sanitize('a/b'), sanitize('a_b'),
    '⇒ 两个不同的 Run id 消毒之后是同一个目录名：两个 Run 的工具账会写进同一本账',
  )

  // 而正确写法下，这两个 id 都不合法（都被拒），所以永远到不了"合流"那一步。
  for (const id of ['a/b', 'a_b']) {
    const refused = id === 'a/b'
    if (refused) assert.throws(() => safeRunId(id), (e) => e.code === TOOLCALL_SPOOL_CODES.BAD_RUN_ID)
    else assert.equal(safeRunId(id), 'a_b', 'a_b 是**合法**的 Run id，它不被改')
  }
})

test('①c ★★ win32 的尾部点/空格：不挡就会与"消毒"同一个后果（两个 Run 合流）', () => {
  // 这是"只挡分隔符"那个写法会漏掉的一整类。
  for (const id of ['run-1.', 'run-1 ', 'run-1. ']) {
    assert.throws(
      () => safeRunId(id),
      (err) => err.code === TOOLCALL_SPOOL_CODES.BAD_RUN_ID,
      `${JSON.stringify(id)} 必须被拒——win32 会静默去掉尾部的点/空格`,
    )
  }
  // 反证：win32 的折叠规则下，这三个与 'run-1' 是**同一个目录名**。
  const win32Fold = (id) => String(id).replace(/[. ]+$/, '')
  assert.equal(win32Fold('run-1.'), 'run-1')
  assert.equal(win32Fold('run-1 '), 'run-1')
  assert.equal(win32Fold('run-1. '), 'run-1')
  assert.equal(
    win32Fold('run-1.'), win32Fold('run-1'),
    '⇒ 它一个字符都没被替换，却与"消毒"得到同一个结果：两个 Run 合流',
  )
})

test('①b 合法的 Run id 原样保留，不折叠大小写、不替换字符', () => {
  for (const id of ['run-1', 'RUN-1', 'r.1', 'run_1', '0f3a-9c', '中文-run']) {
    assert.equal(safeRunId(id), id, `${id} 必须原样保留`)
  }
  // 大小写不同的两个 id 必须是两个目录（在大小写敏感的 FS 上）
  assert.notEqual(safeRunId('Run-1'), safeRunId('run-1'))
})

// ══════════════════════════════════════════════════════════════════════════
// ② ★★★ 坏行逐条具名，且不许被跳过
// ══════════════════════════════════════════════════════════════════════════

test('② ★★★ 中间一行坏掉时：好的两条照常读回，坏的**具名带行号**，complete=false', () => {
  const file = join(root, 'corrupt', 'records.jsonl')
  appendSpoolRecord({ file, record: decisionRow({ callId: 'c-1' }) })
  appendSpoolRecord({ file, record: decisionRow({ callId: 'c-2' }) })
  appendSpoolRecord({ file, record: decisionRow({ callId: 'c-3' }) })

  // 把第 2 行改成坏 JSON（保持"文件还在、行数还是 3"）
  const lines = readFileSync(file, 'utf8').split('\n')
  lines[1] = '{"kind":"decision","row":{'   // 截断
  writeFileSync(file, lines.join('\n'), 'utf8')

  const read = readSpoolRecords({ file })
  assert.equal(read.present, true)
  assert.equal(read.records.length, 2, '好的两条要照常读回')
  assert.deepEqual(read.records.map((r) => r.row.callId), ['c-1', 'c-3'], '顺序与文件一致')
  assert.equal(read.refusals.length, 1, '坏的那一条要**具名**出现，不许被跳过')
  assert.equal(read.refusals[0].line, 2, '必须报出**行号**')
  assert.equal(read.refusals[0].code, TOOLCALL_SPOOL_CODES.BAD_JSON)
  assert.equal(read.complete, false, '★ 这一趟不完整，必须读得出来')
  assert.equal(read.total, 3, '总行数如实')

  // ★★ 反证：数值上"跳过派"与"逐条具名派"读出的**记录数完全一样**。
  //    ⇒ 只看 `records.length` 的人**分不出**这两者，差别只在 `complete` / `refusals`。
  const skipStyle = read.records.length
  assert.equal(skipStyle, 2, '跳过派也会得出 2 条')
  assert.notEqual(read.complete, true, '而本实现同时告诉你"少了东西"')
})

test('②b 结构不合法的行（缺字段 / 未知 kind）同样逐条具名，行号正确', () => {
  const file = join(root, 'badshape', 'records.jsonl')
  appendSpoolRecord({ file, record: decisionRow({ callId: 'ok-1' }) })
  // 直接写两行有问题的：缺 canonicalHash；以及 kind 不认识
  const bad1 = JSON.stringify({ version: TOOLCALL_SPOOL_VERSION, kind: 'decision', row: { callId: 'x', toolName: 't', decision: 'deny', decisionSource: 'pre-execute' } })
  const bad2 = JSON.stringify({ version: TOOLCALL_SPOOL_VERSION, kind: 'not-a-kind', row: { callId: 'y' } })
  const ok2 = encodeSpoolRecord(decisionRow({ callId: 'ok-2' })).trimEnd()
  writeFileSync(file, readFileSync(file, 'utf8') + bad1 + '\n' + bad2 + '\n' + ok2 + '\n', 'utf8')

  const read = readSpoolRecords({ file })
  assert.deepEqual(read.records.map((r) => r.row.callId), ['ok-1', 'ok-2'])
  assert.equal(read.refusals.length, 2)
  assert.deepEqual(read.refusals.map((r) => r.line), [2, 3])
  assert.equal(read.refusals[0].code, TOOLCALL_SPOOL_CODES.MISSING_FIELD, '缺 canonicalHash ⇒ MISSING_FIELD')
  assert.equal(read.refusals[1].code, TOOLCALL_SPOOL_CODES.BAD_KIND, '未知 kind ⇒ BAD_KIND')
  assert.equal(read.complete, false)
})

// ══════════════════════════════════════════════════════════════════════════
// ③ ★★ 缺文件 ≠ 空文件
// ══════════════════════════════════════════════════════════════════════════

test('③ ★★ 缺文件与空文件是**两件**事（`present` 是显式字段）', () => {
  const missing = join(root, 'never-written', 'records.jsonl')
  const m = readSpoolRecords({ file: missing })
  assert.equal(m.present, false, '没写过的 Run：present=false')
  assert.equal(m.records.length, 0)
  assert.equal(m.complete, true, '缺文件**不是**不完整——它只是"没有过"')

  const empty = join(root, 'empty', 'records.jsonl')
  appendSpoolRecord({ file: empty, record: decisionRow({ callId: 'only' }) })
  writeFileSync(empty, '', 'utf8') // 建出来了、就是空的
  const e = readSpoolRecords({ file: empty })
  assert.equal(e.present, true, '写过的 Run：present=true')
  assert.equal(e.records.length, 0)
  assert.equal(e.complete, true)

  // ★ 只看 records.length 时两者同形；`present` 把它们分开。
  assert.equal(m.records.length, e.records.length, '记录数相同（都是 0）')
  assert.notEqual(m.present, e.present, '而 present 分得开')
})

// ══════════════════════════════════════════════════════════════════════════
// ④ ★★ 无损
// ══════════════════════════════════════════════════════════════════════════

test('④ ★★ 无损：CJK / 嵌套 / 值里的换行与引号 原样回得来，且仍是一行', () => {
  const file = join(root, 'lossless', 'records.jsonl')
  const nasty = {
    path: 'C:\\工作\\a.txt',
    message: '第一行\n第二行\t带制表',
    quote: '他说："就这样"',
    nested: { deep: [{ '键': '值' }, null, true, 0, -1.5] },
    emoji: '✅🟡⏸',
  }
  appendSpoolRecord({ file, record: decisionRow({ callId: 'lossy?', rawInput: nasty, canonicalInput: nasty }) })

  const read = readSpoolRecords({ file })
  assert.equal(read.records.length, 1, '值里有换行也必须仍是一条记录')
  assert.deepEqual(read.records[0].row.rawInput, nasty, 'rawInput 必须逐字段相等')
  assert.deepEqual(read.records[0].row.canonicalInput, nasty, 'canonicalInput 必须逐字段相等')

  // 物理读数：文件里正好 1 个非空行
  const physical = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '')
  assert.equal(physical.length, 1, '值里的 \\n 是被 JSON 转义的，物理上仍然只有一行')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑤ ★★★ 结构在这里校验，语义不在这里（词表只有一份）
// ══════════════════════════════════════════════════════════════════════════

test('⑤ ★★★ 本模块**故意**不校验 `decisionSource` 的语义——词表只有一份', () => {
  // 一个语义上不可能的组合（来源不认识），**结构上完全合法**。
  const nonsense = decisionRow({ decisionSource: 'not-a-real-source', decision: 'allow' })
  assert.doesNotThrow(
    () => assertSpoolRecord(nonsense),
    '本模块只看结构：它必须**通过**，否则这里就有第二份来源词表了',
  )
  const file = join(root, 'semantics', 'records.jsonl')
  appendSpoolRecord({ file, record: nonsense })
  const read = readSpoolRecords({ file })
  assert.equal(read.records.length, 1)
  assert.equal(read.complete, true, '写入端照收')
  // ⇒ 语义校验发生在收账侧（`recordToolCall` 的 `assertSourceDecision`）。
  //   那半边在 `orchestrator/worker/toolcall-drain.test.mjs` ② 里被正面断言。
})

test('⑤b 本模块源码里**不出现**来源词表（否则就是抄了第二份）', () => {
  const src = readFileSync(new URL('./spool.mjs', import.meta.url), 'utf8')
  for (const token of ['pre-execute', 'guard', 'approval', 'sandbox']) {
    assert.ok(
      !new RegExp(`['"\`]${token}['"\`]`).test(src),
      `spool.mjs 里不该出现来源名 ${JSON.stringify(token)}——那是 tool-call-log.mjs 的词表`,
    )
  }
})

// ══════════════════════════════════════════════════════════════════════════
// ⑥ 只追加 + 逐 Run 隔离
// ══════════════════════════════════════════════════════════════════════════

test('⑥ 只追加：两次 append 之后前一条字节不变；逐 Run 隔离：两个 Run 两个文件', () => {
  const dir = join(root, 'append')
  const file = spoolFileFor({ dataDir: dir, runId: 'run-A' })
  appendSpoolRecord({ file, record: decisionRow({ callId: 'a-1' }) })
  const afterFirst = readFileSync(file, 'utf8')
  appendSpoolRecord({ file, record: decisionRow({ callId: 'a-2' }) })
  const afterSecond = readFileSync(file, 'utf8')
  assert.ok(afterSecond.startsWith(afterFirst), '第二次追加不许改动前一次的字节')

  const other = spoolFileFor({ dataDir: dir, runId: 'run-B' })
  appendSpoolRecord({ file: other, record: decisionRow({ callId: 'b-1' }) })
  assert.notEqual(file, other, '两个 Run 是两个文件')
  assert.deepEqual(readSpoolRecords({ file }).records.map((r) => r.row.callId), ['a-1', 'a-2'])
  assert.deepEqual(readSpoolRecords({ file: other }).records.map((r) => r.row.callId), ['b-1'])

  // 目录形状
  assert.equal(spoolDirFor({ dataDir: dir, runId: 'run-A' }), join(dir, 'toolcall-spool', 'run-A'))
  assert.ok(file.endsWith(join('toolcall-spool', 'run-A', 'records.jsonl')))
})

// ══════════════════════════════════════════════════════════════════════════
// ⑦ 一条记录不许跨行（挡的是"换了序列化器"）
// ══════════════════════════════════════════════════════════════════════════

test('⑦ ★★ 序列化器若产出多行 ⇒ 具名拒绝（注入式，所以这条判据真的能触发）', () => {
  const pretty = (v) => JSON.stringify(v, null, 2) // "为了日志好看"的那种改法
  assert.throws(
    () => encodeSpoolRecord(decisionRow(), { stringify: pretty }),
    (err) => err.code === TOOLCALL_SPOOL_CODES.NOT_ONE_LINE,
    '带缩进的序列化器必须被拒——它会静默地把一条记录变成多行',
  )
  assert.throws(
    () => encodeSpoolRecord(decisionRow(), { stringify: () => 42 }),
    (err) => err.code === TOOLCALL_SPOOL_CODES.NOT_ONE_LINE,
    '序列化器返回非字符串也必须被拒',
  )
  // 默认序列化器下正常
  assert.equal(encodeSpoolRecord(decisionRow()).endsWith('\n'), true)
  assert.equal(encodeSpoolRecord(decisionRow()).split('\n').length, 2, '一行 + 结尾换行')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑧ 自检：kind 词表 ↔ 必填字段表 必须对齐
// ══════════════════════════════════════════════════════════════════════════

test('⑧ ★★ 自检能被真的构造出来：少一种 kind 的必填字段表 ⇒ 抛', () => {
  assert.doesNotThrow(() => assertKindsCovered())
  assert.throws(
    () => assertKindsCovered({ required: { decision: ['callId'] } }),
    /不对齐/,
    '少两种 kind 的必填字段表必须被自检抓住',
  )
  assert.throws(
    () => assertKindsCovered({ kinds: { ONLY: 'only' }, required: { decision: [], dispatched: [], result: [], only: [] } }),
    /不对齐/,
    '多一种 kind 也必须被抓住',
  )
  // 未知 kind 在**写入时**就具名拒绝（不是等到收账）
  assert.throws(
    () => assertSpoolRecord({ kind: 'nope', row: {} }),
    (err) => err.code === TOOLCALL_SPOOL_CODES.BAD_KIND,
  )
  assert.throws(
    () => assertSpoolRecord(null),
    (err) => err.code === TOOLCALL_SPOOL_CODES.NOT_OBJECT,
  )
})

test('⑧b 装载时自检的读数存在、且三种 kind 都在', () => {
  assert.equal(TOOLCALL_SPOOL_CHECKED.aligned, true)
  assert.equal(TOOLCALL_SPOOL_CHECKED.version, TOOLCALL_SPOOL_VERSION)
  assert.deepEqual([...TOOLCALL_SPOOL_CHECKED.kinds].sort(), ['decision', 'dispatched', 'result'])
  // `TOOLCALL_SPOOL_KINDS` 的键是枚举名（大写），值才是 kind 本身——与
  // `tool-call-log.mjs` 的 `RESULT_STATUSES`（`NONE: 'none'`）同一个风格。
  for (const k of Object.values(TOOLCALL_SPOOL_KINDS)) {
    assert.ok(Array.isArray(TOOLCALL_SPOOL_REQUIRED[k]), `${k} 必须有必填字段表`)
    assert.deepEqual([...TOOLCALL_SPOOL_CHECKED.requiredFields[k]], [...TOOLCALL_SPOOL_REQUIRED[k]])
  }
})

test('⑧c 每一类 kind 的必填字段**都能被缺一次而触发**（判据都有输入）', () => {
  for (const [kind, fields] of Object.entries(TOOLCALL_SPOOL_REQUIRED)) {
    for (const f of fields) {
      const row = Object.fromEntries(fields.map((x) => [x, `v-${x}`]))
      delete row[f]
      assert.throws(
        () => assertSpoolRecord({ kind, row }),
        (err) => err.code === TOOLCALL_SPOOL_CODES.MISSING_FIELD,
        `${kind} 缺 ${f} 时必须被拒`,
      )
    }
  }
})
