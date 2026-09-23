// runtime/toolcall/spool.mjs
// ============================================================================
// PRT-610 的**出站车道**：执行面把"这一次工具调用发生了什么"逐 Run 落进一个文件，
// 由**有凭证的那一侧**（worker）收进 `tool_calls`。
//
// ## 为什么需要这条车道（决策表第 19 条 / 第 15 项的施工）
//
// `team-hub/server.mjs:7296` 逐字写着写侧的唯一入口：
//
//   > 所以写侧只有一个入口：执行面调 `recordToolCall`。本进程只提供**读**与建表。
//
// 而**执行面调不了**它：`runtime` 进程的 `envNames` 里**故意没有** `TEAM_HUB_TOKEN`
// （`product/process-manifest.mjs`，读数是 §5.5 ①）。于是今天的结果是
// `toolCallLogEvidence().recorded === false` **永远**成立——不是"还没调用"，
// 是"没有任何一次真调用被它记过"。
//
// 业已裁决的方向（第 19 条：**选前者**）：执行面需要往控制面送的东西，
// 走**逐 Run 的载荷**，不给执行面开控制面入口。本模块就是那份载荷的**格式与落盘**。
//
// ```
//   执行面（无 token）                       worker（有 token）
//   toolCallRowOf(projection, {...})   ──▶   drainToolCallSpool()
//     → appendSpoolRecord()                    → recordToolCall() / markDispatched()
//        逐 Run 一个文件                          → recordResult()
//                                                 → 真库里的 tool_calls 行
// ```
//
// ## 四个必须成立的性质（每一条都有判据，而且都写得成"反过来的写法是什么"）
//
// **① 两个 Run 的账不许合流。**
// Run id 来自执行引擎，可能含路径分隔符。**不许"消毒"**——把 `a/b` 改成 `a_b`
// 与把 `a_b` 原样保留，会让**两个** Run 落进**同一个**目录：
//
//   > 一个「把 Run id 消毒后当目录名」的落盘，
//   > 与一个「两个 Run 的工具账互相写进对方账本」的落盘，是同一个东西——
//   > 只不过前者的触发条件是"某个 Run 的 id 里有一个斜杠"。
//
// 所以这里**拒绝**（具名 `toolcall-spool-bad-run-id`），不消毒。
//
// **② 坏行必须逐条具名，而且不许被跳过。**
//
//   > 一个「读到坏行就跳过、继续读完」的读取器，
//   > 与一个「把丢掉的行读成『本来就没有那一行』」的读取器，是同一个东西——
//   > 只不过前者的账本会**越读越短**，而它看起来像"这次 Run 只调了 3 个工具"。
//
// 所以 `readSpoolRecords` 返回 `refusals`（带**行号**），并且 `complete:false`。
//
// **③ 缺文件与空文件是两件事。**
// 一次 Run 可能**根本没调过工具**（写得出来、就是空的），也可能**根本没开这条车道**
// （文件不在）。两者都读成"没有记录"时，一个"车道坏了"与一个"这次没调工具"
// 是同一个读数。所以 `present` 是一个显式字段。
//
// **④ 本模块**不**校验决定来源的语义。**
// `decisionSource` 的合法取值与"哪个来源能给出哪个决定"由
// `team-hub/tool-call-log.mjs` 的 `assertSourceDecision` 说了算——**只有那一份**。
// 在这里再抄一份词表会得到两份额度不同的名单，而它的表现是
// "一条记录在写入端通过、在读取端被拒"，看起来像"这条记录格式坏了"。
//
//   > 一个「两端各校验一次同一份词表」的车道，
//   > 与一个「两端各抄一份词表、迟早不一样」的车道，是同一个东西——
//   > 只不过前者的第二次校验会把一次**语义**问题报成一次**格式**问题。
//
// 所以本模块只校验**结构**（哪些字段必须在），语义校验**恰好一次**，在收账那一侧。
//
// @module runtime/toolcall/spool
// ============================================================================

import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const TOOLCALL_SPOOL_VERSION = 'legion/toolcall-spool@1'

/** 落盘目录名（在 DataDir 之下，与 `tool_calls` 这张表同一个 Run 维度）。 */
export const TOOLCALL_SPOOL_DIRNAME = 'toolcall-spool'

/** 每个 Run 一个文件。追加写，永不重写。 */
export const TOOLCALL_SPOOL_FILENAME = 'records.jsonl'

/** 具名拒绝码。 */
export const TOOLCALL_SPOOL_CODES = Object.freeze({
  /** Run id 缺失/空/含路径分隔符/是 `.` 或 `..`。**拒绝，不消毒**。 */
  BAD_RUN_ID: 'toolcall-spool-bad-run-id',
  /** 没给 `dataDir`。 */
  NO_DATA_DIR: 'toolcall-spool-no-data-dir',
  /** 记录不是对象。 */
  NOT_OBJECT: 'toolcall-spool-record-not-object',
  /** 某一行不是合法 JSON。 */
  BAD_JSON: 'toolcall-spool-line-not-json',
  /** `kind` 不在封闭词表里。 */
  BAD_KIND: 'toolcall-spool-bad-kind',
  /** 缺某个该 kind 必填的字段。 */
  MISSING_FIELD: 'toolcall-spool-record-missing-field',
  /** 序列化之后含裸换行（会把一条记录切成两条）。 */
  NOT_ONE_LINE: 'toolcall-spool-record-not-one-line',
  /** 车道目录存在但**读不动**（权限、IO）。与"目录不在"分开报。 */
  LIST_FAILED: 'toolcall-spool-list-failed',
})

/**
 * 记录的三种 kind。**与 `tool-call-log.mjs` 的三个写入函数一一对应**——
 * 不是"三种日志级别"，是三个**不同的写操作**。
 *
 * @readonly
 * @enum {string}
 */
export const TOOLCALL_SPOOL_KINDS = Object.freeze({
  /** → `recordToolCall()`：决定已作出，落一行账。 */
  DECISION: 'decision',
  /** → `markDispatched()`：**先落库再真的派发**（顺序不能反，见 `markDispatched` 的注释）。 */
  DISPATCHED: 'dispatched',
  /** → `recordResult()`：结果回来了（`ok` / `error` / `unknown`）。 */
  RESULT: 'result',
})

/**
 * 每种 kind 的**结构**必填字段。
 *
 * `decision` 那一组**逐字**对应 `runtime/dsh-composition/tool-request.mjs` 的
 * `toolCallRowOf()` 的产出（PRT-610 的行形状）——那里已经算好了，
 * 本模块不重算、也不改名。
 */
export const TOOLCALL_SPOOL_REQUIRED = Object.freeze({
  decision: Object.freeze(['callId', 'toolName', 'decision', 'decisionSource', 'canonicalHash']),
  dispatched: Object.freeze(['callId']),
  result: Object.freeze(['callId', 'status']),
})

function spoolError(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * 把 Run id 变成一个**目录分量**——做法是**拒绝**不合法的，不是消毒。
 *
 * ★ 为什么不消毒：`a/b` 与 `a_b` 消毒之后是同一个目录，于是**两个 Run 的
 * 工具账写进同一本账**。而"哪个 Run 调了哪个工具"正是这本账存在的理由。
 *
 * @param {unknown} runId
 * @returns {string}
 */
export function safeRunId(runId) {
  if (!nonEmpty(runId)) {
    throw spoolError(TOOLCALL_SPOOL_CODES.BAD_RUN_ID, `Run id 必须是非空字符串，收到 ${JSON.stringify(runId)}`)
  }
  const id = String(runId)
  if (id === '.' || id === '..') {
    throw spoolError(TOOLCALL_SPOOL_CODES.BAD_RUN_ID, `Run id 是 ${JSON.stringify(id)}，它会把落盘位置指到别处`)
  }
  // 两个平台的路径分隔符都要挡：这份数据可能在一个平台上写、在另一个平台上读。
  if (/[/\\]/.test(id)) {
    throw spoolError(
      TOOLCALL_SPOOL_CODES.BAD_RUN_ID,
      `Run id ${JSON.stringify(id)} 含路径分隔符。`
      + '**不消毒**——消毒会让 a/b 与 a_b 落进同一个目录，也就是两个 Run 合流成一本账。'
      + '调用方应该用执行引擎那个**原生** run id，它本来就不该含分隔符',
    )
  }
  // ★★ 冒号：在 win32 上它是**盘符/ADS 分隔符**，`C:evil` 既可能被解释成盘符相对路径，
  //    也可能让 `mkdir` 直接失败——而后者在跑 Linux 的人手上**不会发生**。
  //    所以这里按"最严的那个平台"拒绝，理由与分隔符同：数据会跨平台。
  if (id.includes(':')) {
    throw spoolError(
      TOOLCALL_SPOOL_CODES.BAD_RUN_ID,
      `Run id ${JSON.stringify(id)} 含冒号。在 win32 上它是盘符/ADS 分隔符，`
      + '而这个文件可能在一个平台上写、在另一个平台上读',
    )
  }
  // ★★ 尾部的点与空格：**win32 会静默把它们去掉**。于是 `run-1.` 与 `run-1`
  //    是同一个目录——效果与"消毒"一模一样，而它连一个字符都没被替换。
  //
  //      > 一个「只挡路径分隔符」的落盘，
  //      > 与一个「`run-1.` 与 `run-1` 仍然合流」的落盘，是同一个东西——
  //      > 只不过后者的触发条件是"某个 Run id 末尾带一个点"，而那不是不可能。
  if (/[. ]$/.test(id)) {
    throw spoolError(
      TOOLCALL_SPOOL_CODES.BAD_RUN_ID,
      `Run id ${JSON.stringify(id)} 以点或空格结尾。win32 会**静默**去掉它们，`
      + `于是它与 ${JSON.stringify(id.replace(/[. ]+$/, ''))} 会落进同一个目录——`
      + '那与"消毒"是同一个后果（两个 Run 合流），而它一个字符都没被替换',
    )
  }
  // 控制字符（含 NUL）：它们要么让路径 API 截断，要么让日志与表格显示错位。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(id)) {
    throw spoolError(TOOLCALL_SPOOL_CODES.BAD_RUN_ID, `Run id ${JSON.stringify(id)} 含控制字符`)
  }
  return id
}

function assertDataDir(dataDir) {
  if (!nonEmpty(dataDir)) {
    throw spoolError(TOOLCALL_SPOOL_CODES.NO_DATA_DIR, `需要 dataDir，收到 ${JSON.stringify(dataDir)}`)
  }
  return String(dataDir)
}

/** 这个 Run 的落盘目录（不创建）。 */
export function spoolDirFor({ dataDir, runId } = {}) {
  return join(assertDataDir(dataDir), TOOLCALL_SPOOL_DIRNAME, safeRunId(runId))
}

/** 这个 Run 的落盘文件（不创建）。 */
export function spoolFileFor({ dataDir, runId } = {}) {
  return join(spoolDirFor({ dataDir, runId }), TOOLCALL_SPOOL_FILENAME)
}

/**
 * 这个 DataDir 下**所有已经开过车道**的 Run（收账侧扫一趟用）。
 *
 * ## 为什么不把 runId 从目录名反解回来
 *
 * `safeRunId()` 是**单向**的：危险字符它**直接拒绝、绝不消毒**（`:144-191`，理由是
 * 消毒会让 `a/b` 与 `a_b` 落进同一个目录，即两个 Run 合流成一本账）。而目录名就是
 * runId 本身 ⇒ 反解要么是恒等变换（那不如直接用目录名），要么就得**猜**——而猜错的
 * 后果与消毒一样。所以这里返回**目录名**与**已经拼好的文件路径**，不返回 runId。
 *
 * ## 两种"空"必须分开
 *
 * · `present:false` —— `toolcall-spool/` 这个目录**不在**：这条车道从没开过；
 * · `present:true` 且 `runs:[]` —— 目录在、里面没有 Run：开过，现在没有待收的。
 *
 * 两者在"这一趟收了几条"上是同一个读数（都是 0），所以只有 `present` 分得开
 * ——而"车道没开"与"车道开着但没人用"要处置的事情完全不同。
 *
 * @param {{dataDir?: string, readdirSync?: Function}} [opts]
 * @returns {Readonly<{present: boolean, runs: ReadonlyArray<Readonly<{dirName: string, file: string}>>}>}
 */
export function listSpooledRuns({ dataDir, readdirSync: readdirImpl = readdirSync } = {}) {
  const root = join(assertDataDir(dataDir), TOOLCALL_SPOOL_DIRNAME)
  let entries
  try {
    entries = readdirImpl(root, { withFileTypes: true })
  } catch (err) {
    if (err?.code === 'ENOENT') return Object.freeze({ present: false, runs: Object.freeze([]) })
    throw spoolError(
      TOOLCALL_SPOOL_CODES.LIST_FAILED,
      `车道目录存在但读不动：${root}（${err?.code ?? err?.message ?? String(err)}）`,
    )
  }
  const runs = []
  for (const entry of entries) {
    // 只认目录：同名文件（比如有人往那儿丢了个 README）不是一条车道。
    if (typeof entry?.isDirectory !== 'function' || entry.isDirectory() !== true) continue
    runs.push(Object.freeze({
      dirName: entry.name,
      file: join(root, entry.name, TOOLCALL_SPOOL_FILENAME),
    }))
  }
  // 顺序确定：收账的读数是给人看的，"每次顺序都不一样"会让两次对比失去意义。
  runs.sort((a, b) => (a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0))
  return Object.freeze({ present: true, runs: Object.freeze(runs) })
}

/**
 * 校验一条记录的**结构**。★ **不**校验 `decisionSource` / `decision` 的语义
 * ——那一份词表在 `tool-call-log.mjs`，只有那一份（见文件头 ④）。
 *
 * @param {unknown} record
 * @returns {Readonly<object>} 同一个对象（只校验，不复制、不改写）
 */
export function assertSpoolRecord(record) {
  if (!isPlainObject(record)) {
    throw spoolError(TOOLCALL_SPOOL_CODES.NOT_OBJECT, `记录必须是普通对象，收到 ${JSON.stringify(record)}`)
  }
  const kind = record.kind
  const required = TOOLCALL_SPOOL_REQUIRED[kind]
  if (required === undefined) {
    throw spoolError(
      TOOLCALL_SPOOL_CODES.BAD_KIND,
      `kind 是 ${JSON.stringify(kind)}，不在封闭词表 [${Object.values(TOOLCALL_SPOOL_KINDS).join(', ')}] 里`,
    )
  }
  const row = isPlainObject(record.row) ? record.row : null
  if (row === null) {
    throw spoolError(TOOLCALL_SPOOL_CODES.MISSING_FIELD, `${kind} 记录必须带一个 row 对象`)
  }
  for (const f of required) {
    const v = row[f]
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      throw spoolError(
        TOOLCALL_SPOOL_CODES.MISSING_FIELD,
        `${kind} 记录缺必填字段 row.${f}（收到 ${JSON.stringify(v)}）`,
      )
    }
  }
  return record
}

/**
 * 编码成**一行**（含结尾换行）。
 *
 * ★ `JSON.stringify` 会把字符串里的换行转义成 `\n` 两个字符，所以用默认序列化器时
 * 一条记录物理上不可能跨行。那为什么还要这条断言？因为它挡的**不是**默认序列化器，
 * 而是**换掉序列化器**这件事：有人为了"日志好看"把它换成带缩进的版本（或换成
 * `util.inspect`），记录就静默地变成多行——而读取端会把一条读成好几条**半条**，
 * 看起来像"参数被截断了"。
 *
 *   > 一个「假设序列化器永远不会产多行」的写入端，
 *   > 与一个「有人把序列化器换成缩进版之后、账本里每条记录都变成半条」的写入端，
 *   > 是同一个东西——只不过后者的报错方式是"参数少了一半"。
 *
 * `stringify` 可注入，让这条断言**能被真的构造出来**（不然它就是一条
 * 没有任何输入能触发的判据，而那与不存在同形）。
 *
 * @param {unknown} record
 * @param {{stringify?: (v: unknown) => string}} [opts]
 * @returns {string}
 */
export function encodeSpoolRecord(record, { stringify = JSON.stringify } = {}) {
  assertSpoolRecord(record)
  const withVersion = record.version === TOOLCALL_SPOOL_VERSION
    ? record
    : { ...record, version: TOOLCALL_SPOOL_VERSION }
  const line = stringify(withVersion)
  if (typeof line !== 'string') {
    throw spoolError(TOOLCALL_SPOOL_CODES.NOT_ONE_LINE, `序列化器返回了 ${typeof line}，不是字符串`)
  }
  if (line.includes('\n') || line.includes('\r')) {
    throw spoolError(
      TOOLCALL_SPOOL_CODES.NOT_ONE_LINE,
      '序列化之后含裸换行，拒绝写入：一条记录跨行会在读取端被读成好几条**半条**记录',
    )
  }
  return line + '\n'
}

/**
 * 追加一条。**只追加，永不重写**——重写会让"已经落过的那几条"与
 * "这次落的那一条"在崩溃时互相覆盖，而账本丢掉一笔与"这一笔没发生过"同形。
 *
 * @returns {Readonly<{file: string, bytes: number}>}
 */
export function appendSpoolRecord({ file, record, mkdir = true } = {}) {
  if (!nonEmpty(file)) {
    throw spoolError(TOOLCALL_SPOOL_CODES.NO_DATA_DIR, '需要 file')
  }
  const line = encodeSpoolRecord(record)
  if (mkdir) mkdirSync(dirname(String(file)), { recursive: true })
  appendFileSync(String(file), line, 'utf8')
  return Object.freeze({ file: String(file), bytes: Buffer.byteLength(line, 'utf8') })
}

/**
 * 逐行读回。
 *
 * @returns {Readonly<{
 *   present: boolean,
 *   entries: ReadonlyArray<{line: number, record: object}>,
 *   records: ReadonlyArray<object>,
 *   refusals: ReadonlyArray<{line: number, code: string, reason: string}>,
 *   complete: boolean, total: number,
 * }>}
 *   `present:false` = 这个 Run **没有过**这个文件（要么没调过工具，要么车道没开）；
 *   `present:true` 且 `records:[]` = 文件在、就是空的。
 *   `complete:false` = 至少有一行读不出来，**它没有被跳过，它出现在 `refusals` 里**。
 *
 * ★ `entries` 带**行号**，`records` 是它的投影。两样一起给，是因为**下游也要行号**：
 * 收账侧在"落账失败"时若只报 `line: null`，值班的人拿到一条具名拒绝却**找不到它在
 * 哪一行**——而"知道错在哪"与"能去改"是两件事。`records` 只是便利视图，
 * 与 `entries` 在**同一次循环**里建出来，所以两者不可能不一致。
 */
export function readSpoolRecords({ file } = {}) {
  if (!nonEmpty(file)) {
    throw spoolError(TOOLCALL_SPOOL_CODES.NO_DATA_DIR, '需要 file')
  }
  const f = String(file)
  if (!existsSync(f)) {
    return Object.freeze({
      present: false,
      entries: Object.freeze([]),
      records: Object.freeze([]),
      refusals: Object.freeze([]),
      complete: true,
      total: 0,
    })
  }
  const text = readFileSync(f, 'utf8')
  const entries = []
  const refusals = []
  // 只按 `\n` 切：CRLF 时行尾会留一个 `\r`，先 rtrim 掉再解析。
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].replace(/\r$/, '')
    if (raw.trim() === '') continue // 空行不是坏行：追加写可能在崩溃时留下半行，也可能留下空行
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      refusals.push(Object.freeze({
        line: i + 1,
        code: TOOLCALL_SPOOL_CODES.BAD_JSON,
        reason: `第 ${i + 1} 行不是合法 JSON：${err?.message ?? String(err)}`,
      }))
      continue
    }
    try {
      entries.push(Object.freeze({ line: i + 1, record: Object.freeze(assertSpoolRecord(parsed)) }))
    } catch (err) {
      refusals.push(Object.freeze({
        line: i + 1,
        code: err?.code ?? TOOLCALL_SPOOL_CODES.NOT_OBJECT,
        reason: `第 ${i + 1} 行结构不合法：${err?.message ?? String(err)}`,
      }))
    }
  }
  return Object.freeze({
    present: true,
    entries: Object.freeze(entries),
    records: Object.freeze(entries.map((e) => e.record)),
    refusals: Object.freeze(refusals),
    complete: refusals.length === 0,
    total: entries.length + refusals.length,
  })
}

// ---------------------------------------------------------------- 装载时自检

/**
 * 自检：`TOOLCALL_SPOOL_REQUIRED` 的键必须与 `TOOLCALL_SPOOL_KINDS` 的值**逐个对齐**。
 *
 * 加一种 kind 却忘了给它一张必填字段表，代码里完全看不出来：那种记录照样写得进去
 * （`required` 是 `undefined` 时**会抛**，所以这里其实是"少一种 kind 就在写入时炸"）
 * ——本自检把它提前到**装载时**，这样它是一次启动失败，而不是一次运行中的拒绝。
 *
 * `kinds` / `required` 可注入，让"漏了一种"能被真的构造出来。
 */
export function assertKindsCovered({
  kinds = TOOLCALL_SPOOL_KINDS,
  required = TOOLCALL_SPOOL_REQUIRED,
} = {}) {
  const values = Object.values(kinds)
  const missing = values.filter((k) => required[k] === undefined)
  const extra = Object.keys(required).filter((k) => !values.includes(k))
  if (missing.length || extra.length) {
    throw new Error(
      `TOOLCALL_SPOOL_REQUIRED 与 TOOLCALL_SPOOL_KINDS 不对齐：`
      + `缺 [${missing.join(', ')}]、多 [${extra.join(', ')}]——`
      + '一张与它管辖的 kind 名单不对齐的必填字段表，会让那一种记录在**写入时**才炸，'
      + '而那离"加了一种 kind"已经很远了',
    )
  }
  return Object.freeze({ kinds: values.length, aligned: true })
}

const SELF_CHECK = assertKindsCovered()

/** 装载时自检结果（供门禁读；`toolcall-spool` 套件断言它存在且对齐）。 */
export const TOOLCALL_SPOOL_CHECKED = Object.freeze({
  version: TOOLCALL_SPOOL_VERSION,
  kinds: Object.freeze(Object.values(TOOLCALL_SPOOL_KINDS)),
  requiredFields: Object.freeze(
    Object.fromEntries(Object.entries(TOOLCALL_SPOOL_REQUIRED).map(([k, v]) => [k, Object.freeze([...v])])),
  ),
  aligned: SELF_CHECK.aligned,
})
