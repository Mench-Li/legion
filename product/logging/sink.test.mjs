// product/logging/sink.test.mjs
// ============================================================================
// PRT-709 的写入侧。这一组守的第一条比"日志好不好看"重得多：
//
//   **排空管道这件事，不许依赖"日志有没有被配置好"。**
//
// 在 sink 之前，`product/launcher/` 里没有任何地方读 `child.stdout`，
// 而子进程是按 `stdio: ['ignore','pipe','pipe']` 起的。一个话多的子进程会在
// 写满管道缓冲区之后**永久阻塞在 write 上**：不退出、不报错、也不再干活。
// 熔断器看不到失败，就永远不会介入。
//
// 所以 `attachDrain` 在**没有任何 sink** 的时候也必须接上 `data`。
//
// 其余三条：
//   ② 按**行**脱敏（一个密钥被拆成两个数据块时，逐块跑正则认不出来）；
//   ③ 不换行的巨型输出必须被切断落盘（不能把启动器撑爆），且**不是丢日志**；
//   ④ 任何写入错误都**不抛回**子进程的数据处理器。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  DEFAULT_MAX_LINE_BYTES,
  SINK_CODES,
  attachDrain,
  createLogSink,
  logFilePath,
} from './sink.mjs'

const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz012345'
const TOKEN = 'ghp_0123456789012345678901234567890123'
const D = 'C:/log'

/** 内存 fs：够验证 append/stat/rotate 的接线。
 *
 *  所有路径都**规范化成正斜杠**：sink 现在用 `resolve()` 构造路径，
 *  在 Windows 上得到的是反斜杠形式——不统一的话用例会因为分隔符而假红，
 *  而"因为分隔符失败的用例"和"因为逻辑失败的用例"在输出上长得一样。 */
function fakeFs(files = {}) {
  const norm = (p) => String(p).replace(/\\/g, '/')
  const map = new Map(Object.entries(files).map(([k, v]) => [norm(k), { body: String(v) }]))
  const calls = { append: [] }
  return {
    map, calls,
    mkdirSync: () => {},
    readdirSync: (dir) => {
      const prefix = `${norm(dir)}/`
      return [...map.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map((k) => k.slice(prefix.length))
    },
    statSync: (p) => { if (!map.has(norm(p))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e } return { size: Buffer.byteLength(map.get(norm(p)).body), mtimeMs: 0 } },
    appendFileSync: (p, body) => {
      calls.append.push([norm(p), body])
      const prev = map.get(norm(p))?.body ?? ''
      map.set(norm(p), { body: `${prev}${body}` })
    },
    renameSync: (a, b) => { if (!map.has(norm(a))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e } map.set(norm(b), map.get(norm(a))); map.delete(norm(a)) },
    rmSync: (p) => { map.delete(norm(p)) },
  }
}

const contentOf = (fs, name) => fs.map.get(`${D}/${name}`)?.body ?? null

/** 一个可读的假子进程流。 */
function fakeStream() {
  const s = new EventEmitter()
  s.resumed = 0
  s.resume = () => { s.resumed += 1 }
  return s
}

// ============================================================================
// ① 排空管道：不依赖日志配置
// ============================================================================

test('① **没有任何 sink 时也接上 `data` 并把流 resume**（这是防止子进程卡死的那一条）', () => {
  const child = { stdout: fakeStream(), stderr: fakeStream() }
  const d = attachDrain(child, {})
  assert.deepEqual(d.drained.sort(), ['stderr', 'stdout'])
  assert.equal(child.stdout.listenerCount('data'), 1, '没接 data：子进程写满缓冲区就会永久阻塞')
  assert.equal(child.stderr.listenerCount('data'), 1)
  assert.equal(child.stdout.resumed, 1)
  assert.equal(child.stderr.resumed, 1)
})

test('① `onData` 为 null 时照样排空（丢掉是浪费，卡住是故障）', () => {
  const child = { stdout: fakeStream() }
  // 让它真的产数据，确认不会因为"没有消费者"而报错
  attachDrain(child, { onData: null })
  child.stdout.emit('data', Buffer.from('ignored\n'))
  assert.equal(child.stdout.listenerCount('data'), 1)
})

test('① 数据按流名送到 `onData`（stdout / stderr 必须能分开）', () => {
  const child = { stdout: fakeStream(), stderr: fakeStream() }
  const seen = []
  attachDrain(child, { onData: (stream, chunk) => seen.push([stream, String(chunk)]) })
  child.stdout.emit('data', 'out\n')
  child.stderr.emit('data', 'err\n')
  assert.deepEqual(seen, [['stdout', 'out\n'], ['stderr', 'err\n']])
})

test('① `onData` 抛错**不会**冒回数据处理器（否则会炸掉启动器）', () => {
  const child = { stdout: fakeStream() }
  const errors = []
  attachDrain(child, { onData: () => { throw new Error('sink 坏了') }, onError: (e) => errors.push(e.message) })
  // 这一句本身不能抛
  child.stdout.emit('data', 'x')
  assert.deepEqual(errors, ['sink 坏了'])
})

test('① 缺少 stdout/stderr 时不炸（进程可能没开管道）', () => {
  assert.deepEqual(attachDrain({}, {}).drained, [])
  assert.deepEqual(attachDrain({ stdout: null, stderr: undefined }, {}).drained, [])
})

test('① `detach` 之后不再收数据（不泄漏监听器）', () => {
  const child = { stdout: fakeStream() }
  const seen = []
  const d = attachDrain(child, { onData: (s, c) => seen.push(String(c)) })
  child.stdout.emit('data', 'a')
  d.detach()
  child.stdout.emit('data', 'b')
  assert.deepEqual(seen, ['a'])
})

// ============================================================================
// ② 按行脱敏
// ============================================================================

test('② 一行的密钥被替换成标记', () => {
  const fs = fakeFs()
  const sink = createLogSink({ logDir: D, fs })
  sink.write('stdout', `key=${SECRET}\n`)
  const body = contentOf(fs, 'stdout.log')
  assert.ok(!body.includes(SECRET), '原值被写进日志了')
  assert.match(body, /\[已脱敏\]/)
  assert.equal(sink.stats().redactionHits, 1)
})

test('② **一个密钥被拆成两个数据块时也能认出来**（逐块跑正则认不出）', () => {
  const fs = fakeFs()
  const sink = createLogSink({ logDir: D, fs })
  // 密钥从中间断开，两个块各自都不完整
  sink.write('stdout', `key=sk-abcdefghij`)
  sink.write('stdout', `klmnopqrstuvwxyz012345\n`)
  sink.flush()
  const body = contentOf(fs, 'stdout.log')
  assert.ok(!body.includes(SECRET), `断成两块之后原值漏了出去：${body}`)
  assert.equal(sink.stats().redactionHits, 1, '跨块的那一次命中没有被算出来')
})

test('② 没换行的尾巴**留在缓冲区**，flush 时才落盘', () => {
  const fs = fakeFs()
  const sink = createLogSink({ logDir: D, fs })
  sink.write('stdout', 'half a line')
  assert.equal(contentOf(fs, 'stdout.log'), null, '还没换行就落盘了')
  sink.flush()
  assert.equal(contentOf(fs, 'stdout.log'), 'half a line\n')
})

test('② 一次写多行会被逐行拆开（每行各自脱敏）', () => {
  const fs = fakeFs()
  const sink = createLogSink({ logDir: D, fs })
  sink.write('stdout', `a\n${SECRET}\nb\n`)
  const body = contentOf(fs, 'stdout.log')
  assert.ok(!body.includes(SECRET))
  assert.match(body, /^a\n/)
  assert.match(body, /\nb\n$/)
  assert.equal(sink.stats().lines, 3)
})

test('② 脱敏抛错时**写占位符而不是原文**，并报出来', () => {
  const fs = fakeFs()
  const diags = []
  // 真表对字符串不会抛，所以这条防线只有靠注入才走得到。
  // 注入的那个"坏表"每次抛错——**它拿到的原文绝不能出现在日志里**。
  const sink = createLogSink({
    logDir: D, fs, onDiagnostic: (d) => diags.push(d),
    redactText: () => { throw new Error('模式表坏了') },
  })
  sink.write('stdout', `key=${SECRET}\n`)
  const body = contentOf(fs, 'stdout.log')
  assert.equal(body !== null, true, '应当落一行占位符，而不是什么都不写')
  assert.ok(!body.includes(SECRET), `脱敏失败时把原文写出去了：${body}`)
  assert.ok(!body.includes(TOKEN))
  assert.match(body, /本行脱敏失败/)
  const d = diags.find((x) => x.code === SINK_CODES.REDACT_FAILED)
  assert.ok(d, '没有报 REDACT_FAILED')
  assert.equal(d.severity, 'error')
  assert.match(d.message, /没有落盘/, '必须说清这一行没有落盘，否则读的人以为日志是全的')
  // 而且 sink 必须继续工作（一行坏了不能停掉整个日志）。
  // 注意注入的表**每次都抛**，所以第二行也会是占位符——这恰好证明了
  // "它还在继续处理"，而不是"它已经死了"。
  assert.equal(sink.stats().lines, 1)
  sink.write('stdout', 'still alive\n')
  assert.equal(sink.stats().lines, 2, '一行脱敏失败之后 sink 就不再落盘了')
  assert.equal((contentOf(fs, 'stdout.log').match(/本行脱敏失败/g) ?? []).length, 2)
  assert.equal(diags.filter((d) => d.code === SINK_CODES.REDACT_FAILED).length, 2)
})

test('② 默认用的是**共享模式表**（不是自己写一份会漂移的）', () => {
  const fs = fakeFs()
  createLogSink({ logDir: D, fs }).write('stdout', `a=${SECRET} b=${TOKEN}\n`)
  const body = contentOf(fs, 'stdout.log')
  assert.ok(!body.includes(SECRET) && !body.includes(TOKEN),
    '默认脱敏没有认出共享表里的两种形态')
})

test('② `redact: false` 是**显式**的（默认一定脱敏）', () => {
  const fsDefault = fakeFs()
  createLogSink({ logDir: D, fs: fsDefault }).write('stdout', `${SECRET}\n`)
  assert.ok(!contentOf(fsDefault, 'stdout.log').includes(SECRET), '默认竟然没脱敏')

  const fsOff = fakeFs()
  createLogSink({ logDir: D, fs: fsOff, redact: false }).write('stdout', `${SECRET}\n`)
  assert.ok(contentOf(fsOff, 'stdout.log').includes(SECRET), 'redact:false 应当原样写')
})

// ============================================================================
// ③ 巨型单行
// ============================================================================

test('③ 不换行的巨型输出被**切断落盘**（不是丢日志，也不能撑爆内存）', () => {
  const fs = fakeFs()
  const diags = []
  const sink = createLogSink({ logDir: D, fs, maxLineBytes: 100, onDiagnostic: (d) => diags.push(d) })
  sink.write('stdout', 'y'.repeat(500))
  const body = contentOf(fs, 'stdout.log')
  assert.ok(body !== null, '巨型行被丢掉了')
  assert.equal(body.replace(/\n$/, '').length, 500, '内容应当完整落盘，只是不再等换行')
  const d = diags.find((x) => x.code === SINK_CODES.LINE_TOO_LONG)
  assert.ok(d, '没有报"强制切断"')
  assert.match(d.message, /不是丢日志/, '必须说清这不是丢日志，否则读的人会以为日志缺了')
})

test('③ 默认的单行上限存在且是有限值', () => {
  assert.ok(Number.isFinite(DEFAULT_MAX_LINE_BYTES))
  assert.ok(DEFAULT_MAX_LINE_BYTES >= 4096)
})

// ============================================================================
// ④ 写入失败的处理
// ============================================================================

test('④ 内部分块处理抛错时**报 WRITE_FAILED 而不是抛给调用方**', () => {
  const fs = fakeFs()
  const diags = []
  const sink = createLogSink({ logDir: D, fs, onDiagnostic: (d) => diags.push(d) })
  // 一个 toString 会抛的对象：`feed` 里的 `String(chunk)` 会炸。
  // 真实场景是"某个流给了一个奇怪的对象"，而不是常见路径。
  const evil = { toString: () => { throw new Error('boom') } }
  sink.write('stdout', evil)   // **这一句不能抛**
  const d = diags.find((x) => x.code === SINK_CODES.WRITE_FAILED)
  assert.ok(d, '内部错误没有被报出来')
  // 而且要能继续干活：一个坏块不能停掉整个日志
  sink.write('stdout', 'after\n')
  assert.match(contentOf(fs, 'stdout.log'), /after/)
})

test('④ 写不进去时**报诊断而不是抛错**（日志坏掉不能让启动器崩）', () => {
  const diags = []
  const fs = {
    ...fakeFs(),
    appendFileSync: () => { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e },
  }
  const sink = createLogSink({ logDir: D, fs, onDiagnostic: (d) => diags.push(d) })
  sink.write('stdout', 'hello\n')   // 不能抛
  const d = diags.find((x) => x.code === SINK_CODES.WRITE_FAILED)
  assert.ok(d, '写失败没有被报出来')
  assert.match(d.message, /这条本身也写不进日志/,
    '必须说清这条诊断也进不了日志——否则用户会去日志里找它')
})

test('④ 恶意流名一律被解析回日志目录内（这就是**全部**的保证）', () => {
  // 这里断言的是**性质**，不是某个分支：
  // 无论喂什么名字，结果路径都必须落在日志目录内。
  //
  // 值得一提的经过：这段代码原本还有第二道"解析后复核"，破验证 ⑲㉗ 量到它
  // **永远不会触发**（把复核那行改成 `if (false)`，没有任何用例变红）——
  // 因为清洗那一层是全的，产出的名字里不可能有分隔符。
  // 按与 ⑱㉖ / ⑲③ 同样的处置，那条分支被**删掉**了，留下的是这组性质断言。
  //
  //   > 一个永远不会触发的复核，与没有复核，在"它到底拦不拦得住"上同形。
  for (const evil of ['../x', '..\\x', 'C:/Windows/System32/evil', '../../../../etc/passwd', '..', '.', 'a/b']) {
    const p = logFilePath(D, evil).replace(/\\/g, '/')
    const segs = p.split('/')
    assert.ok(!segs.includes('..'), `${evil} → ${p}：逃出了日志目录`)
    assert.ok(!segs.includes('.'), `${evil} → ${p}：落到了当前目录段`)
    assert.ok(p.startsWith(`${D}/`), `${evil} → ${p}：不在日志目录内`)
    // 而且文件名里不可能残留分隔符（那正是清洗在做的事）
    const base = segs[segs.length - 1]
    assert.ok(/^[A-Za-z0-9._-]+\.log$/.test(base), `${evil} → 文件名不干净：${base}`)
  }
  // 正常名字原样可用
  assert.ok(logFilePath(D, 'team-hub.stdout').replace(/\\/g, '/').endsWith('/team-hub.stdout.log'))
})

test('④ 流名被清洗，且**解析后复核**确实落在日志目录里（两道防线）', () => {
  const fs = fakeFs()
  const sink = createLogSink({ logDir: D, fs })
  sink.write('../../evil', 'x\n')
  sink.write('C:/Windows/System32/evil', 'x\n')
  const paths = fs.calls.append.map(([p]) => p)
  assert.ok(paths.length > 0)
  for (const p of paths) {
    // 第一道断言（很弱）：看起来在目录下。`C:/log/../../evil.log` 也能过这一关，
    // 所以**不能只靠它**——这正是破验证 ⑲⑳ 量出来的："看起来在目录下"
    // 与"解析出来真的在目录下"是两个不同的断言。
    assert.ok(p.startsWith(`${D}/`), `路径不以日志目录开头：${p}`)
    // 第二道断言（真正的那道）：规范化之后仍然在目录内，且没有逃逸**段**。
    // 注意判的是"段"而不是"子串"：清洗之后的 `..-..-evil.log` 里含有 `..`，
    // 但它是一个**普通文件名**，不是逃逸。
    //   > 危险的是 `..` 这个路径段，不是 `..` 这两个字符。
    const normalized = p.replace(/\\/g, '/')
    const segs = normalized.split('/')
    assert.ok(!segs.includes('..'), `路径里有逃逸段：${p}`)
    assert.ok(!segs.includes('.'), `路径里有当前目录段：${p}`)
    assert.ok(/(^|\/)log\/[A-Za-z0-9._-]+\.log$/.test(normalized),
      `文件名不干净（可能含分隔符）：${p}`)
  }
})

test('④ `logDir` 自己带 `..` 时，路径**先被规范化**再拼接（不会拼出一个逃逸路径）', () => {
  // 这条与"恶意流名"是两件事：流名那一侧的保证由清洗给出，
  // 而 logDir 这一侧靠 `resolve` 把 `..` 段消掉再拼文件名。
  const fs = fakeFs()
  const sink = createLogSink({ logDir: `${D}/sub/..`, fs })
  sink.write('ok', 'x\n')
  const paths = fs.calls.append.map(([p]) => p.replace(/\\/g, '/'))
  // `C:/log/sub/..` resolve 之后是 `C:/log`，所以文件必须落在 C:/log 里
  assert.ok(paths.every((p) => p.startsWith(`${D}/`)), JSON.stringify(paths))
  assert.ok(paths.every((p) => !p.includes('/../')), JSON.stringify(paths))
})

test('④ sink 的 `close()` 先 flush 再拒绝后续写入', () => {
  const fs = fakeFs()
  const sink = createLogSink({ logDir: D, fs })
  sink.write('stdout', 'tail-without-newline')
  sink.close()
  assert.equal(contentOf(fs, 'stdout.log'), 'tail-without-newline\n')
  const before = sink.stats().chunks
  sink.write('stdout', 'after close\n')
  assert.equal(sink.stats().chunks, before, 'close 之后仍在接收数据')
})

// ============================================================================
// ⑤ 与轮转的接线
// ============================================================================

test('⑤ `rotate()` 把轮转失败与磁盘压力转成诊断，**不抛错**', async () => {
  const diags = []
  const fs = {
    ...fakeFs({ [`${D}/stdout.log`]: 'x'.repeat(200) }),
    renameSync: (a, b) => {
      if (a === `${D}/stdout.log`) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e }
      return fakeFs({}).renameSync(a, b)
    },
  }
  const sink = createLogSink({ logDir: D, fs, policy: { maxFileBytes: 100 }, onDiagnostic: (d) => diags.push(d) })
  const r = await sink.rotate()   // 不能抛
  assert.equal(r.ok, false)
  assert.ok(diags.some((d) => d.code === 'LOG_ROTATE_FILE_IN_USE'))
  assert.equal(sink.stats().rotations, 0, '没转成就不能把计数加上去')
})

test('⑤ 轮转成功时计数增加，并把被删的文件从记账里去掉', async () => {
  const fs = fakeFs({ [`${D}/stdout.log`]: 'x'.repeat(200), [`${D}/stdout.log.1`]: 'old' })
  const sink = createLogSink({ logDir: D, fs, policy: { maxFileBytes: 100, keepFiles: 1, maxTotalBytes: 1e9 } })
  const r = await sink.rotate()
  assert.equal(r.ok, true, JSON.stringify(r.failures))
  assert.equal(sink.stats().rotations, 1)
  assert.ok(r.rotated.includes('stdout.log'))
})

test('⑤ 策略不合法时**一开始就说**，而不是等到写的时候才发现', () => {
  const diags = []
  createLogSink({ logDir: D, fs: fakeFs(), policy: { maxFileBytes: -1 }, onDiagnostic: (d) => diags.push(d) })
  assert.ok(diags.some((d) => d.code === SINK_CODES.BAD_POLICY && d.severity === 'error'))
})

test('⑤ `stats()` 的形状是稳定的（排查要读它）', () => {
  const sink = createLogSink({ logDir: D, fs: fakeFs() })
  const s = sink.stats()
  for (const k of ['chunks', 'lines', 'bytes', 'redactionHits', 'redactedLines', 'droppedBytes', 'rotations', 'buffers', 'policy', 'logDir']) {
    assert.ok(k in s, `stats 缺少 ${k}`)
  }
  assert.equal(Object.isFrozen(s), true)
})
