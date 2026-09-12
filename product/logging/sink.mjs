// product/logging/sink.mjs
// ============================================================================
// PRT-709 的写入侧：**排空子进程管道**，落盘、脱敏、并在超限时轮转
//
// ## 它先修的是一个比"没有日志"更重的问题
//
// `product/launcher/supervisor.mjs` 用 `stdio: ['ignore', 'pipe', 'pipe']`
// 起子进程，而整个 `product/launcher/` **没有任何地方读 `child.stdout`**。
// 于是一个话多的子进程会在写满管道缓冲区（Windows 上几十 KB）之后
// **阻塞在 write 上**：不退出、不报错、也不再干活。
//
//   熔断器看不到失败 → 永远不会介入；
//   就绪探针探不到响应 → 只会一路超时；
//   而没有日志 → 排查看不出任何线索。
//
// 所以这里的第一条纪律是：
//
//   > **排空管道这件事，不许依赖"日志有没有被配置好"。**
//
// 即使调用方一个 sink 都没给，supervisor 也必须把 `data` 接上（见
// `attachDrain`）——把输出丢掉是浪费，让子进程卡住是故障。
//
// ## 三条与脱敏有关的判断
//
// ① **按行脱敏，不按块。** 一个密钥被拆在两个 `data` 块之间时，
//    逐块跑正则是认不出来的。所以 sink 按行聚合再脱敏。这不是"更彻底"，
//    而是唯一的正确做法：`redactText` 是**行内**判据。
//
// ② **行不能无限聚合。** 一个不换行的巨型输出会把内存吃光，
//    所以有 `maxLineBytes`：超了就**先脱敏再落盘**、并记一条 note。
//    宁可多切一刀，不可把启动器撑爆。
//
// ③ **脱敏失败的输出不落盘。** 脱敏本身抛错时（模式表异常之类）
//    写原文出去是最坏的选择——那正是 §6.7 要防的事。所以这种情况
//    写一条**占位符**，并把错误报给调用方。
//
// ## 写入失败绝不抛回子进程的数据处理器
//
// `data` 回调里抛错会冒泡到 launcher 主流程。日志写不进去是**产品的问题**，
// 不是"让启动器崩掉"的理由。所有写入错误都转成 `onDiagnostic`。
// ============================================================================

import { join, resolve } from 'node:path'

import { REDACTED, redactText as sharedRedactText } from '../../runtime/contracts/redact-patterns.mjs'
import { DEFAULT_LOG_POLICY, LOG_CODES, rotateLogs, validateLogPolicy } from './rotation.mjs'

/** sink 自己的具名码。 */
export const SINK_CODES = Object.freeze({
  /** 写不进去。 */
  WRITE_FAILED: 'LOG_SINK_WRITE_FAILED',
  /** 脱敏抛错：写占位符而不是原文。 */
  REDACT_FAILED: 'LOG_SINK_REDACT_FAILED',
  /** 单行超长被强制切断。 */
  LINE_TOO_LONG: 'LOG_SINK_LINE_TOO_LONG',
  /** 策略不合法。 */
  BAD_POLICY: 'LOG_SINK_BAD_POLICY',
})

/** 单行聚合上限。超了就切断落盘——不换行的巨型输出不该把启动器撑爆。 */
export const DEFAULT_MAX_LINE_BYTES = 64 * 1024

/**
 * 由一个流名算出一个**保证落在 `logDir` 里**的日志文件路径。
 *
 * 导出成纯函数是有原因的。这段逻辑原本内联在 `createLogSink` 的 `fileFor` 里，
 * 而它守的第二道防线（解析后复核）**在用例里永远触发不了**——清洗那一层已经把
 * 路径分隔符和盘符全都换成 `-` 了，复核自然是恒真的。
 *
 *   > 一个永远不会触发的复核，与没有复核，
 *   > 在"它到底拦不拦得住"上原本同形。
 *
 * 提出来之后它可以被直接喂恶意名字（`../x`、`C:/x`、`..`）来验证，
 * 于是"哪天有人放宽了那条清洗正则"这件事有人接着。
 *
 * @returns `{ path, rejected }`。`rejected: true` 表示**复核拦下了**它。
 */
export function logFilePath(logDir, stream) {
  // **这一层的保证是全的**：清洗把所有非 `[A-Za-z0-9._-]` 的字符（含 `/`、`\`、`:`）
  // 都换成 `-` 并把长度截到 60，所以产出的名字里**不可能**有路径分隔符，
  // `resolve` 之后必然落在 `logDir` 内。
  //
  // 这里原本还有第二道"解析后复核"。破验证 ⑲㉗ 量到它**永远不会触发**：
  // 把它改成 `if (false)`，没有任何用例变红。
  //
  //   > 一个永远不会触发的复核，与没有复核，在"它到底拦不拦得住"上同形。
  //
  // 而留着它的代价不是性能，是**误导**：下一个人会以为"还有一道兜底"，
  // 从而在真正决定行为的那条正则上少想一层。所以它被删掉了——
  // 守这一层的现在是 `sink.test.mjs` 里那组**性质断言**（恶意流名一律解析回目录内）。
  const safe = String(stream ?? 'log').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'log'
  const base = resolve(String(logDir ?? '.'))
  return join(base, `${safe}.log`)
}

/**
 * 把子进程的输出接到一个 sink 上，**并且保证管道一定被排空**。
 *
 * 这是本文件存在的主要理由：`onData` 为 `null` 时它**照样**接上
 * `data`/`resume`，只是把内容丢掉。丢掉是浪费，卡住是故障。
 *
 * @param {object} child       `{ stdout, stderr }`（可为 null）
 * @param {object} deps
 * @param {(stream: string, chunk: Buffer|string) => void} [deps.onData]
 * @param {(err: unknown) => void} [deps.onError]
 * @returns {{drained: string[], detach: Function}}
 */
export function attachDrain(child, { onData = null, onError = null } = {}) {
  const drained = []
  const cleanups = []
  for (const [stream, handle] of [['stdout', child?.stdout], ['stderr', child?.stderr]]) {
    if (handle === null || handle === undefined) continue
    if (typeof handle.on === 'function') {
      const onChunk = (chunk) => {
        try {
          if (typeof onData === 'function') onData(stream, chunk)
        } catch (e) {
          // **绝不让写入错误冒回子进程的数据处理器。**
          if (typeof onError === 'function') { try { onError(e) } catch { /* 尽力而为 */ } }
        }
      }
      handle.on('data', onChunk)
      cleanups.push(() => { try { handle.off?.('data', onChunk) } catch { /* 尽力而为 */ } })
    } else if (typeof handle.on === 'function') {
      // 不可读的 handle：接不了 data，至少让它流动起来
      cleanups.push(() => { /* 无 */ })
    }
    if (typeof handle.resume === 'function') {
      handle.resume()
      cleanups.push(() => { /* resume 无需撤销 */ })
    }
    drained.push(stream)
  }
  return {
    drained,
    detach: () => { for (const fn of cleanups) fn() },
  }
}

/**
 * 创建一个日志 sink。
 *
 * @param {object} deps
 * @param {string} deps.logDir
 * @param {object} [deps.policy]
 * @param {object} deps.fs              `{ appendFileSync, mkdirSync, readdirSync, statSync, renameSync, rmSync, statfsSync }`
 * @param {Function} [deps.onDiagnostic] 每条诊断回调一次（`{severity, code, message}`）
 * @param {boolean} [deps.redact]      默认 `true`。**关掉它只有一种正当理由：测试脱敏本身**
 */
export function createLogSink({
  logDir, policy = {}, fs, onDiagnostic = null, redact = true,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  // 脱敏函数**可注入**。默认就是那张共享模式表（这是唯一正当的默认值），
  // 注入口的存在是为了让"脱敏抛错时写占位符"那条防线**可被观测**——
  // 用真表是触发不了它的（对字符串跑正则不会抛）。
  //
  //   > 一条只有靠注入才能走到的分支，与一条走不到的分支，
  //   > 在"它到底拦不拦得住"上原本是同一个答案；注入口把它变成了前者的**可验证**版本。
  redactText = sharedRedactText,
} = {}) {
  const check = validateLogPolicy(policy)
  const pol = check.policy
  const buffers = new Map()   // stream 名 → 未成行的尾巴
  const written = new Map()   // 文件名 → 已写字节
  const stats = { chunks: 0, lines: 0, bytes: 0, redactionHits: 0, redactedLines: 0, droppedBytes: 0, rotations: 0 }
  let closed = false

  const report = (severity, code, message) => {
    if (typeof onDiagnostic !== 'function') return
    try { onDiagnostic(Object.freeze({ severity, code, message })) } catch { /* 尽力而为 */ }
  }

  if (!check.ok) report('error', SINK_CODES.BAD_POLICY, `日志策略不合法：${check.problems.join('；')}`)

  /** 文件路径。走导出的纯函数 `logFilePath`（那个函数里有完整的安全说明）。 */
  function fileFor(stream) {
    return logFilePath(logDir, stream)
  }

  function sizeOf(path) {
    try { return fs.statSync(path).size } catch { return 0 }
  }

  function append(path, text) {
    if (check.ok !== true) return false
    try {
      if (typeof fs.mkdirSync === 'function') fs.mkdirSync(logDir, { recursive: true })
      fs.appendFileSync(path, text)
      written.set(path, (written.get(path) ?? sizeOf(path)) + Buffer.byteLength(text))
      stats.bytes += Buffer.byteLength(text)
      return true
    } catch (e) {
      // 写不进去是产品的问题，**不是让启动器崩掉**的理由
      report('warn', SINK_CODES.WRITE_FAILED,
        `日志写不进去（${path}）：${e?.code ?? e?.name ?? 'Error'}。**这条本身也写不进日志**，` +
        '所以只能报到诊断里；请检查 LogDir 的权限与剩余空间')
      return false
    }
  }

  /** 脱敏一行。抛错时返回占位符——**绝不落原文**。 */
  function redactLine(line) {
    if (redact !== true) return { text: line, hits: 0 }
    try {
      const { text, hits } = redactText(line)
      if (hits.length > 0) { stats.redactionHits += hits.length; stats.redactedLines += 1 }
      return { text, hits: hits.length }
    } catch (e) {
      report('error', SINK_CODES.REDACT_FAILED,
        `脱敏抛错（${e?.name ?? 'Error'}）：这一行**没有落盘**，只写了占位符。` +
        '宁可少一行日志，不能把可能含密钥的原文写出去')
      return { text: `[本行脱敏失败，已丢弃：${REDACTED}]\n`, hits: 0 }
    }
  }

  /** 落盘一行（含换行）。 */
  function emit(path, line, { force = false } = {}) {
    const { text } = redactLine(line)
    const body = text.endsWith('\n') ? text : `${text}\n`
    if (append(path, body)) stats.lines += 1
    void force
  }

  /** 按行切分并聚合。返回未成行的尾巴。 */
  function feed(stream, chunk) {
    if (closed) return
    stats.chunks += 1
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '')
    if (text === '') return
    const path = fileFor(stream)
    const prev = buffers.get(stream) ?? ''
    const parts = `${prev}${text}`.split('\n')
    const tail = parts.pop() ?? ''
    for (const part of parts) emit(path, part)
    if (Buffer.byteLength(tail) > maxLineBytes) {
      // 不换行的巨型输出：先脱敏再落盘，并说清为什么切断
      stats.droppedBytes += Buffer.byteLength(tail)
      report('warn', SINK_CODES.LINE_TOO_LONG,
        `${stream} 有一行超过 ${maxLineBytes} 字节仍未换行，已强制切断落盘（该段 ${Buffer.byteLength(tail)} 字节）。` +
        '**这不是丢日志**：切断后的内容仍然写下去了，只是不再等换行符')
      emit(path, tail)
      buffers.set(stream, '')
      return
    }
    buffers.set(stream, tail)
  }

  return Object.freeze({
    /** 收到一个数据块（通常来自 `attachDrain`）。**不抛错。** */
    write(stream, chunk) {
      try { feed(stream, chunk) } catch (e) {
        report('warn', SINK_CODES.WRITE_FAILED, `日志写入内部错误：${e?.name ?? 'Error'}`)
      }
    },
    /** 把还没成行的尾巴落盘（进程退出前调）。 */
    flush() {
      for (const [stream, tail] of buffers) {
        if (tail !== '') emit(fileFor(stream), tail)
        buffers.set(stream, '')
      }
    },
    /** 触发一次轮转。**失败不抛**，报进诊断。 */
    async rotate() {
      try {
        const r = await rotateLogs({ logDir, policy: pol, fs })
        if (r.ok === true) stats.rotations += 1
        for (const f of r.failures) report('warn', f.code, f.message)
        for (const n of r.notes) report(n.code === LOG_CODES.DISK_PRESSURE ? 'error' : 'info', n.code, n.message)
        for (const p of r.pruned) written.delete(`${logDir}/${p}`)
        return r
      } catch (e) {
        report('warn', LOG_CODES.ROTATE_FAILED, `轮转抛错：${e?.name ?? 'Error'}`)
        return null
      }
    },
    /** 关掉：先 flush 再拒绝后续写入。**不关文件句柄**——sink 用的是
     *  每次 append，没有长期持有的句柄，这正是 Windows 上不锁文件的做法。 */
    close() {
      this.flush()
      closed = true
    },
    stats() { return Object.freeze({ ...stats, buffers: buffers.size, policy: pol, logDir }) },
    policy: pol,
  })
}
