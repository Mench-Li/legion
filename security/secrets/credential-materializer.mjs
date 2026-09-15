// security/secrets/credential-materializer.mjs
// ============================================================================
// PRT-509：把一次 Run 的**冻结凭证句柄**写进一份 DSH **真的读得回来**的
// `$DSH_HOME/.credentials.yaml`。
//
// ## 为什么需要它（施工之前的状态）
//
// `run-credentials.mjs` 把 Run 启动时解析到的那一份值冻进一个句柄里，句柄带
// `held` / `get` / `describe` / 元数据 `toJSON`——**没有任何生产代码消费它**。
// 同时 Legion 对 DSH 那个文件只有**读**的一侧（`dsh-credentials.mjs`），于是
// "一个解析成功的 Legion 凭证"与"某个模型客户端能拿到它"之间那一段是空的。
// 本模块补的就是那一段。
//
// ## 本模块的判据：不是"我把值写进了文件"，而是"那个文件被读者读回来了"
//
// 一个"写出去的格式符合我自己以为的格式"的用例，
// 与一个"DSH 真的读得回来"的用例，
// 在两边各自单测时是同一片绿——
// 只不过前者的绿，在读者一改键空间语法的那天照样是绿的。
//
// 所以本模块**不自己发明 YAML 子集的期望**：文档在落盘之前，先交给
// `dsh-credentials.mjs` 的**真实读者**`parseDshCredentialsDocument()` 读一遍，
// 逐条比对"读者读回来的名字与值"是否**逐字等于**我们要写的那一份。
// 证不出来就不写（`VERIFICATION_FAILED`）。于是：
//
//   · 读者改了键空间语法 → 本模块**拒绝写**，而不是安静地写出一份读者读岔的文件；
//   · 写者与读者**不可能各自绿着漂移**——它们在每一次写之前都被迫对过一次答案。
//
// ## 键空间：为什么必须由调用方给映射（这是本模块存在的主要摩擦）
//
// DSH 的凭证文档有两个**语法不同**的键空间（见 `planDshLookup`）：
//   `refs`    键是 POSIX 标识符（`DEEPSEEK_API_KEY`）；
//   `records` 键是**恰好两段**的小写连字符标识符（`legion/openai`）。
// 而 Legion 的模型引用是 `legion/model/<profileId>`——**三段**，于是
// `planDshLookup()` 对它返回 `{addressable:false, space:null}`：
// 这条引用在两个键空间里**都没有位置**。
//
//   > 一个"文件看起来完整、就是少了最要紧那一把钥匙"的读数，
//   > 与一个"文件本来就只该有这么多"的读数，在 `cat` 的输出里长得一模一样。
//
// 因此本模块要求调用方显式给出 `mapping`（Legion 引用 → DSH 可寻址的名字），
// 并且把"持有、但既不可寻址又没映射"的引用报成**具名拒绝** `REF_UNMAPPED`，
// 而不是跳过它。
//
// **映射的内容一个字都不在本模块里。** 那个名字的来源是 DSH 自己的声明——
// 行配置 `packages/bundle/base/cordis.patch.yml` 的 `apiKeyEnv: DEEPSEEK_API_KEY`，
// 以及 `packages/llm/llm-deepseek/src/index.ts` 的常量 DEFAULT_API_KEY_ENV
// （它的值就是 DEEPSEEK_API_KEY）。本模块**刻意不内置任何
// provider → 环境变量名的表**：那张表会随 DSH 的适配器一起过时，而过时的表现
// 是把一把钥匙写到一个**没有任何人读**的名字下面——它看起来完全成功。
//
// 这一条不是注释里的承诺：`credential-materializer.test.mjs` 的 ⑥ 会扫本文件，
// 断言"引号里的环境变量名形状字面量"**一个都不存在**（只有具名错误码）。
//
// ## 值：只有"证得出能原样读回来"的值才写得出去
//
// 落盘之前的值要先过两道：
//   ① 一道**刻意比读者更窄**的字符集/结构检查（换行、制表、`#`、`: `、首尾空白、
//      非 ASCII、引号……一律具名拒绝）。不做转义：转义是我们**猜**读者会怎么想，
//      而这一层的判据是"证得出来"。
//   ② 上面说的**真实读者回读比对**——它是权威，①只是让拒绝能指名道姓。
//
// ## 泄漏纪律（与 `run-credentials.mjs` 同一条）
//
// 任何错误消息、错误对象的可枚举属性、返回值、`describe()` / `toJSON()` 里
// **只有引用名、DSH 名字、路径、模式与计数**；**永远没有值**。写失败的 `cause`
// 只取 errno（`err.code`），绝不带底层 `message`（那里面可能有路径与内容）。
//
// ## 目标路径：fail closed
//
// 只写**调用方声明的 Legion 自有目录**（`allowedRoot`）里的、文件名为
// `DSH_CREDENTIALS_FILENAME` 的文件，并且**拒绝对/在 operator 的真实 home 内
// 写**（`$DSH_HOME` 与 `~/.dsh`）。
//
// `$DSH_HOME` 与 `~` 是**环境推导出来的事实**，而 `security/` 这一层的设计约束
// 是**不读 `process.env`**（`security/config-schema.mjs` 的 `allowEmptyFields`
// 就是这么来的：这份声明说"本目录 0 个读取点"，它必须继续说真话）。所以这两个
// 路径与 `mapping` 一样，**由调用方按自己已经声明过的口径注入**（`operatorHomes`），
// 本模块不自己去解析环境，也不去 stat 那些目录。
//
//   ★ 代价写在诚实边界里：调用方**漏注入** operator home 时，这条拒绝线不在。
//     为了不让"漏注入"安静地退化成"没有这条线"，`operatorHomes` 是**必填**的：
//     不声明就 `OPERATOR_HOME_REQUIRED`，不写。
// ============================================================================

import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import {
  DSH_CREDENTIALS_CODES,
  DSH_CREDENTIALS_FILENAME,
  DSH_DOCUMENT_VERSION,
  parseDshCredentialsDocument,
  planDshLookup,
} from './dsh-credentials.mjs'

/** 本模块的版本。落进返回值，便于把一次运行与一份实现对起来。 */
export const CREDENTIAL_MATERIALIZER_VERSION = 1

/** 具名内部码。它们**不是**契约码：契约码仍由 `security/secrets/errors.mjs` 决定。 */
export const CREDENTIAL_MATERIALIZER_CODES = Object.freeze({
  // ── 入参形状 ──────────────────────────────────────────────────────────
  /** 没有可用的凭证句柄（或句柄的 `refs` 与 `held()` 自相矛盾）。 */
  HANDLE_REQUIRED: 'CREDENTIAL_MATERIALIZER_HANDLE_REQUIRED',
  /** 没给目标路径。 */
  TARGET_REQUIRED: 'CREDENTIAL_MATERIALIZER_TARGET_REQUIRED',
  /** 目标不是绝对路径——相对路径的"哪里"取决于当前工作目录，那不是一个可复核的目标。 */
  TARGET_NOT_ABSOLUTE: 'CREDENTIAL_MATERIALIZER_TARGET_NOT_ABSOLUTE',
  /** 目标文件名不是 DSH 的 `CREDENTIALS_FILENAME`：DSH 不会读别的名字。 */
  TARGET_BASENAME: 'CREDENTIAL_MATERIALIZER_TARGET_BASENAME',
  /** 没给允许写入的根。 */
  ALLOWED_ROOT_REQUIRED: 'CREDENTIAL_MATERIALIZER_ALLOWED_ROOT_REQUIRED',
  /** 允许写入的根解析不出来（不存在 / 读不出）——证不出在根内，就不写。 */
  ALLOWED_ROOT_UNRESOLVED: 'CREDENTIAL_MATERIALIZER_ALLOWED_ROOT_UNRESOLVED',
  /** 目标不在允许的根内。 */
  TARGET_OUTSIDE_ROOT: 'CREDENTIAL_MATERIALIZER_TARGET_OUTSIDE_ROOT',
  /** 目标的父目录解析不出来（通常是不存在）——本模块**不**替调用方 mkdir。 */
  TARGET_DIR_UNRESOLVED: 'CREDENTIAL_MATERIALIZER_TARGET_DIR_UNRESOLVED',
  /** 没声明 operator 的真实 home（`$DSH_HOME` / `~/.dsh`）就不写（见文件头）。 */
  OPERATOR_HOME_REQUIRED: 'CREDENTIAL_MATERIALIZER_OPERATOR_HOME_REQUIRED',
  /** 声明的 operator home 本身不是绝对路径。 */
  OPERATOR_HOME_INVALID: 'CREDENTIAL_MATERIALIZER_OPERATOR_HOME_INVALID',
  /** 目标落在 operator 的真实 home 里/上——只写 Legion 自有的 home。 */
  TARGET_IN_OPERATOR_HOME: 'CREDENTIAL_MATERIALIZER_TARGET_IN_OPERATOR_HOME',
  /** 文件模式不是"仅所有者可读写"。 */
  MODE_NOT_PRIVATE: 'CREDENTIAL_MATERIALIZER_MODE_NOT_PRIVATE',

  // ── 映射与寻址 ────────────────────────────────────────────────────────
  /** 映射不是一个 ref → name 的映射（含空键/空名字）。 */
  MAPPING_INVALID: 'CREDENTIAL_MATERIALIZER_MAPPING_INVALID',
  /**
   * 句柄持有这个引用，但它既不可被 DSH 寻址、也没被映射。
   * **具名拒绝，不是跳过**：跳过会让文件看起来完整却少了最要紧那一把钥匙。
   */
  REF_UNMAPPED: 'CREDENTIAL_MATERIALIZER_REF_UNMAPPED',
  /** 映射给出的名字**自己**也不可被 DSH 寻址（换了个位置，还是没人读）。 */
  MAPPING_TARGET_INVALID: 'CREDENTIAL_MATERIALIZER_MAPPING_TARGET_INVALID',
  /** 两个引用被映射到同一个名字：后写的会静默压掉先写的。 */
  MAPPING_DUPLICATE: 'CREDENTIAL_MATERIALIZER_MAPPING_DUPLICATE',

  // ── 值 ────────────────────────────────────────────────────────────────
  /** 值不是非空字符串。 */
  VALUE_NOT_A_STRING: 'CREDENTIAL_MATERIALIZER_VALUE_NOT_A_STRING',
  /** 值以本子集无法**原样读回来**的方式表示（换行/制表/`#`/`: `/首尾空白/…）。 */
  VALUE_NOT_REPRESENTABLE: 'CREDENTIAL_MATERIALIZER_VALUE_NOT_REPRESENTABLE',

  // ── 落盘 ──────────────────────────────────────────────────────────────
  /** 写前自校验失败：真实读者读回来的东西与意图不等（或直接拒绝了这份文档）。 */
  VERIFICATION_FAILED: 'CREDENTIAL_MATERIALIZER_VERIFICATION_FAILED',
  /** 落盘失败（只带 errno，不带路径与底层 message）。临时文件已尽力清理。 */
  WRITE_FAILED: 'CREDENTIAL_MATERIALIZER_WRITE_FAILED',
})

/** 本模块的错误类型。带上 `code`，让调用方能按码分支而不是按文案匹配。 */
export class CredentialMaterializerError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'CredentialMaterializerError'
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * 真实的 `node:fs` 门面。用例注入自己的一份来**数**出调用次序
 * （"用了临时文件 + rename"必须是读数，而不是从"文件最终存在"推出来的）。
 */
const NODE_IO = Object.freeze({
  realpathSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  chmodSync,
  renameSync,
  unlinkSync,
})

/**
 * 允许出现在值里的字符。**刻意比读取器更窄**：读取器的普通标量还允许 `#`
 * （只要它不跟在空白后面），但 `#` 是"这一行从哪里开始是注释"的唯一开关，
 * 而写出去的行里值总是跟在 `": "` 之后——夹在值里的 `#` 在前一位是空格时
 * 会被读者截断。少写一条而不是写一条会被读岔的，是这一层的取舍。
 */
const SAFE_VALUE_RE = /^[A-Za-z0-9._~+=/][A-Za-z0-9._+\-/=~:@, ]*$/

/** `path.resolve()` + win32 大小写归一：Windows 的文件系统不区分大小写，"在不在根内"也不该区分。 */
function norm(p) {
  const r = resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

/** `child` 是否等于 `root` 或落在 `root` 之内（两边都必须是已归一的绝对路径）。 */
function isInsideOrEqual(child, root) {
  const prefixed = root.endsWith(sep) ? root : root + sep
  return child === root || child.startsWith(prefixed)
}

/** 把映射归一到 `Map<ref, name>`。接受 `Map` 与普通对象两种形状。 */
function normalizeMapping(mapping) {
  if (mapping === undefined || mapping === null) return new Map()
  let pairs
  if (mapping instanceof Map) {
    pairs = [...mapping.entries()]
  } else if (typeof mapping === 'object' && !Array.isArray(mapping)) {
    // `Object.keys` 而不是 `Object.entries`：`Object.entries` 读的是可枚举的**自**属性，
    // 两者对 `__proto__` 这类键的处理在"字面量 vs defineProperty"之间不同；
    // 无论哪一边漏掉，漏掉的后果都是 REF_UNMAPPED（拒绝），不会变成"写了个错名字"。
    pairs = Object.keys(mapping).map((ref) => [ref, mapping[ref]])
  } else {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.MAPPING_INVALID,
      'mapping 必须是一个 ref → DSH 名字的 Map 或对象（"没有映射"要显式给空对象/空 Map，而不是给别的类型）',
      { cause: 'not-a-map-or-object' })
  }
  const out = new Map()
  for (const [ref, name] of pairs) {
    if (typeof ref !== 'string' || ref === '') {
      throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.MAPPING_INVALID,
        'mapping 里出现了非字符串/空的引用名', { cause: 'ref-key-not-a-string' })
    }
    if (typeof name !== 'string' || name === '') {
      throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.MAPPING_INVALID,
        `mapping[${ref}] 不是一个非空字符串——映射的目标是 DSH 的条目名，不是一个可以省略的东西`,
        { ref, cause: 'target-not-a-string' })
    }
    out.set(ref, name)
  }
  return out
}

/**
 * 值能不能被这个子集**原样**表示。拒绝时给出**具体**的原因（cause），
 * 但 cause 里永远只有类别名，没有值本身。
 */
function assertValueRepresentable(value, { ref, name }) {
  if (typeof value !== 'string' || value === '') {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.VALUE_NOT_A_STRING,
      `${name} 的值不是一个非空字符串（句柄契约保证非空字符串；这里再判一次是因为空值会被读者报成"这一条没有值"）`,
      { ref, name, cause: value === '' ? 'empty' : 'not-a-string' })
  }
  // 结构破坏：换行/回车/制表/其它控制字符。**不做转义**：转义是猜，而这里要的是证明。
  for (const ch of value) {
    const cp = ch.codePointAt(0)
    if (cp >= 0x20 && cp !== 0x7f) continue
    const cause = ch === '\n' ? 'newline'
      : ch === '\r' ? 'carriage-return'
        : ch === '\t' ? 'tab'
          : 'control-character'
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.VALUE_NOT_REPRESENTABLE,
      `${name} 的值里有会改变文件结构的字符（${cause}）——这一层的判据是"证得出能被原样读回来"，不是"转义后大概能"`,
      { ref, name, cause })
  }
  // 首尾空白：YAML 在普通标量首尾折掉空白，读者读回来的会比写出去的多/少几个字符。
  if (value !== value.trim()) {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.VALUE_NOT_REPRESENTABLE,
      `${name} 的值首尾有空白——YAML 会把普通标量的首尾空白折掉，读回来的值与写的不是同一个`,
      { ref, name, cause: 'leading-or-trailing-whitespace' })
  }
  // `#`：注释起点。它是不是注释取决于前一位是不是空白，而值前面恰好是 `": "`。
  if (value.includes('#')) {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.VALUE_NOT_REPRESENTABLE,
      `${name} 的值里有 "#"——它可能在读者那里成为注释起点，后面的内容会被整段丢掉`,
      { ref, name, cause: 'comment-indicator' })
  }
  // `: ` / 行尾 `:`：读者把它们当成行内映射（"读不出边界的结构"）。
  if (value.endsWith(':') || value.includes(': ')) {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.VALUE_NOT_REPRESENTABLE,
      `${name} 的值里有 ": " 或以 ":" 结尾——读者会把它当成行内映射的边界`,
      { ref, name, cause: 'inline-mapping' })
  }
  if (!SAFE_VALUE_RE.test(value)) {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.VALUE_NOT_REPRESENTABLE,
      `${name} 的值里有本子集不承认的字符（引号/括号/反斜杠/非 ASCII/…）——不猜、不转义、不截断`,
      { ref, name, cause: 'unsafe-character' })
  }
  return value
}

/**
 * 渲染 DSH 文档。形状**只有一个来源**：`dsh-credentials.mjs` 的读者
 * （`version` + `refs` + `records`），并且写前还要被它回读一遍。
 */
function renderDocument(entries) {
  const lines = [`version: ${DSH_DOCUMENT_VERSION}`]
  const refs = entries.filter((e) => e.space === 'refs')
  const records = entries.filter((e) => e.space === 'records')
  if (refs.length > 0) {
    lines.push('refs:')
    for (const e of refs) lines.push(`  ${e.name}: ${e.value}`)
  }
  if (records.length > 0) {
    lines.push('records:')
    for (const e of records) {
      lines.push(`  ${e.name}:`)
      lines.push('    kind: api-key')
      lines.push(`    key: ${e.value}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * 写前自校验：把即将落盘的文本交给**真实读者**，逐条比对名字与值。
 *
 * 这是本模块与读取器之间那条"不许各自绿着漂移"的缝。读者的具名拒绝码会成为
 * 我们错误的 `cause`：读者拒绝这份文档这件事本身是事实，而我们只转述**哪一类**。
 */
function verifyRendered(text, entries) {
  let parsed
  try {
    parsed = parseDshCredentialsDocument(text)
  } catch (err) {
    const readerCode = typeof err?.code === 'string' ? err.code : 'reader-refused'
    const holder = entries.find((e) => e.name === err?.ref)
    // 读者点名了某一条（`err.ref` 是**键名**，不是值），而那条正是"读不出一个字符串"，
    // 那这仍是一个"值无法表示"的问题——按值拒绝对调用方才可操作。
    const valueLevel = readerCode === DSH_CREDENTIALS_CODES.REF_VALUE_NOT_STRING
      || readerCode === DSH_CREDENTIALS_CODES.REF_VALUE_MISSING
      || readerCode === DSH_CREDENTIALS_CODES.API_KEY_VALUE_INVALID
    if (holder !== undefined && valueLevel) {
      throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.VALUE_NOT_REPRESENTABLE,
        `${holder.name} 的值被真实读者判成"读不出一个字符串"（${readerCode}）——拒绝写出而不是写一份读者读岔的文件`,
        { ref: holder.ref, name: holder.name, cause: readerCode })
    }
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.VERIFICATION_FAILED,
      `写前自校验失败：Legion 的真实读者拒绝了这份即将写出的文档（${readerCode}）——`
      + '这通常意味着读取器的键空间/词法语法变了，而本模块还没有跟上；此时**不写**才是对的',
      { cause: readerCode })
  }

  const wantRefs = new Map()
  const wantRecords = new Map()
  for (const e of entries) (e.space === 'refs' ? wantRefs : wantRecords).set(e.name, e.value)

  // 数量先对上：多一条少一条都说明我们对文档形状的理解与读者不同。
  if (parsed.refs.size !== wantRefs.size || parsed.records.size !== wantRecords.size) {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.VERIFICATION_FAILED,
      '写前自校验失败：读者读回来的条目数与意图不等'
      + `（refs ${parsed.refs.size}/${wantRefs.size}，records ${parsed.records.size}/${wantRecords.size}）`,
      { cause: 'shape-mismatch' })
  }
  for (const [name, value] of wantRefs) {
    if (parsed.refs.get(name) !== value) {
      throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.VERIFICATION_FAILED,
        `写前自校验失败：refs 里的 ${name} 读回来的值与要写的不等`,
        { name, cause: 'value-mismatch' })
    }
  }
  for (const [name, value] of wantRecords) {
    const record = parsed.records.get(name)
    if (record === undefined || record.kind !== 'api-key' || record.key !== value) {
      throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.VERIFICATION_FAILED,
        `写前自校验失败：records 里的 ${name} 读回来的记录与要写的不等`,
        { name, cause: 'value-mismatch' })
    }
  }
  return true
}

/** 只含名字/路径/计数的描述对象。`toJSON()` 与 `describe()` 共用它。 */
function descriptorOf({ target, mode, bytes, entries, unusedMappingRefs, runId, resolvedAt }) {
  return Object.freeze({
    version: CREDENTIAL_MATERIALIZER_VERSION,
    targetFile: target,
    mode,
    bytes,
    runId,
    resolvedAt,
    count: entries.length,
    refs: entries.filter((e) => e.space === 'refs').length,
    records: entries.filter((e) => e.space === 'records').length,
    entries: Object.freeze(entries.map((e) => Object.freeze({ ref: e.ref, name: e.name, space: e.space }))),
    unusedMappingRefs: Object.freeze([...unusedMappingRefs]),
    /** 写前被**真实读者**回读比对过（见 `verifyRendered`）——不是"写完了"的意思。 */
    verified: true,
  })
}

/**
 * 把一个 Run 的冻结凭证句柄，写成 DSH 读得回来的 `.credentials.yaml`。
 *
 * 同步函数：句柄的 `get()` 是同步的，落盘也是原子的一步（临时文件 + chmod + rename）。
 *
 * @param {object} deps
 * @param {{refs: ReadonlyArray<string>, held: (ref: string) => boolean, get: (ref: string) => string,
 *          runId?: string, resolvedAt?: string}} deps.handle
 *   来自 `openRunCredentials()` 的冻结句柄。**只读**：本模块不改变、不替换它持有的任何一份值。
 * @param {string} deps.targetFile `.credentials.yaml` 的绝对路径（文件名必须是 DSH 的
 *   `CREDENTIALS_FILENAME`），且必须落在 `allowedRoot` 内、不得落在 operator home 内。
 * @param {Map<string,string>|Record<string,string>} [deps.mapping]
 *   Legion 引用 → DSH 可寻址的名字。**内容由调用方给**（来源是 DSH 自己的 `apiKeyEnv`
 *   声明，见文件头）；本模块不内置任何 provider → 名字的表。
 * @param {number} [deps.mode] 目标模式，默认 `0o600`；只接受"仅所有者可读写"。
 * @param {string} deps.allowedRoot 允许写入的根（**Legion 自有**的目录，绝对路径）。
 * @param {ReadonlyArray<string>} deps.operatorHomes operator 的真实 home 清单
 *   （`$DSH_HOME` 与 `~/.dsh`；绝对路径）。**必填**——见文件头"漏注入"的代价。
 * @param {object} [deps.io] 文件操作门面（用例注入；默认 `node:fs`）。
 * @returns {Readonly<object>} 只有名字/路径/模式/计数的元数据（`describe()` 与 `toJSON()` 同形）
 * @throws {CredentialMaterializerError}
 */
export function materializeRunCredentials({
  handle,
  targetFile,
  mapping,
  mode = 0o600,
  allowedRoot,
  operatorHomes,
  io = NODE_IO,
} = {}) {
  // ── ① 句柄：`refs` 与 `held()` 必须自洽，否则连"它持有什么"都说不清 ──────
  if (handle === null || typeof handle !== 'object'
    || typeof handle.held !== 'function' || typeof handle.get !== 'function'
    || !Array.isArray(handle.refs)) {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.HANDLE_REQUIRED,
      '没有可用的凭证句柄（需要 refs 数组、held() 与 get()）——不能凭一个说不清内容的句柄去写凭证文件',
      { cause: 'handle-shape' })
  }

  // ── ② 目标路径：绝对、且必须是 DSH 会读的那个文件名 ────────────────────
  if (typeof targetFile !== 'string' || targetFile.trim() === '') {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.TARGET_REQUIRED,
      '没有目标路径', { cause: 'not-a-string' })
  }
  if (!isAbsolute(targetFile)) {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.TARGET_NOT_ABSOLUTE,
      '目标不是绝对路径——相对路径落在哪里取决于当前工作目录，那不是一个可复核的写入目标',
      { cause: 'not-absolute' })
  }
  const target = resolve(targetFile)
  const targetName = basename(target)
  if (targetName !== DSH_CREDENTIALS_FILENAME) {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.TARGET_BASENAME,
      `目标文件名必须是 ${DSH_CREDENTIALS_FILENAME}（DSH 只读这个名字）`,
      { cause: 'basename' })
  }

  // ── ③ operator home：**纯字符串比较，一次 fs 都不碰**（绝不 stat 用户的 .dsh） ─
  if (!Array.isArray(operatorHomes) || operatorHomes.length === 0) {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.OPERATOR_HOME_REQUIRED,
      '没有声明 operator 的真实 home（$DSH_HOME / ~/.dsh）——'
      + '本模块不读 process.env（密钥层不得有环境读取点），所以这两个路径必须由调用方注入；'
      + '不注入就等于这条拒绝线不在，因此这里拒绝写而不是照写',
      { cause: 'not-declared' })
  }
  const homes = []
  for (const home of operatorHomes) {
    if (typeof home !== 'string' || home.trim() === '' || !isAbsolute(home)) {
      throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.OPERATOR_HOME_INVALID,
        '声明的 operator home 里有非字符串/非绝对路径的条目',
        { cause: 'not-absolute' })
    }
    homes.push(norm(home))
  }
  for (const home of homes) {
    if (isInsideOrEqual(norm(target), home)) {
      throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.TARGET_IN_OPERATOR_HOME,
        '目标落在 operator 的真实 home 里/上——本模块只写 Legion 自有的目录，'
        + '改 operator 的凭证文件是 DSH 自己的事',
        { cause: 'operator-home' })
    }
  }

  // ── ④ 允许的根：先做**纯词法**包含判定（这一层不该为了拒绝一次而去碰盘） ──
  if (typeof allowedRoot !== 'string' || allowedRoot.trim() === '' || !isAbsolute(allowedRoot)) {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.ALLOWED_ROOT_REQUIRED,
      '没有给 allowedRoot（必须是绝对路径的 Legion 自有目录）——"写到哪里都可以"不是一种授权',
      { cause: 'not-absolute' })
  }
  const rootLexical = norm(allowedRoot)
  if (!isInsideOrEqual(norm(target), rootLexical)) {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.TARGET_OUTSIDE_ROOT,
      '目标不在 allowedRoot 内', { cause: 'outside-root' })
  }

  // ── ⑤ 模式：只接受"仅所有者可读写"，0600 是默认值而不是最低要求 ─────────
  if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.MODE_NOT_PRIVATE,
      'mode 不是一个 0..0o777 的整数', { cause: 'not-a-mode' })
  }
  if ((mode & 0o077) !== 0) {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.MODE_NOT_PRIVATE,
      `mode ${mode.toString(8)} 允许组/其他人访问——凭证文件只接受仅所有者可读写（默认 0o600）`,
      { cause: 'group-or-other-bits' })
  }
  if ((mode & 0o400) === 0) {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.MODE_NOT_PRIVATE,
      `mode ${mode.toString(8)} 连所有者都读不了——那不是一份 DSH 读得到的凭证文件`,
      { cause: 'owner-read-missing' })
  }

  // ── ⑥ 映射形状 ────────────────────────────────────────────────────────
  const map = normalizeMapping(mapping)

  // ── ⑦ 逐条决定"写在哪里"，不可寻址且未映射 → **具名拒绝** ─────────────
  const entries = []
  const usedMappingRefs = new Set()
  const unmappedRefs = []
  const notAddressable = []
  for (const ref of handle.refs) {
    if (typeof ref !== 'string' || ref === '') {
      throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.HANDLE_REQUIRED,
        '句柄的 refs 里有非字符串/空的引用', { cause: 'ref-not-a-string' })
    }
    if (handle.held(ref) !== true) {
      throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.HANDLE_REQUIRED,
        `句柄的 refs 里有 ${ref}，但 held(${ref}) 说没有——一个自相矛盾的句柄不能用来写凭证文件`,
        { ref, cause: 'ref-not-held' })
    }
    let name
    if (map.has(ref)) {
      name = map.get(ref)
      usedMappingRefs.add(ref)
    } else {
      name = ref
    }
    const plan = planDshLookup(name)
    if (!plan.addressable) {
      // ★ 这里是本模块的第二条存在理由：**拒绝，而不是跳过**。
      //   跳过会让文件看起来完整，却少了最要紧的那一把钥匙。
      if (map.has(ref)) {
        throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.MAPPING_TARGET_INVALID,
          `mapping[${ref}] = ${name} 自己也不可被 DSH 寻址（两个键空间都放不下它）——`
          + '换了个位置还是没有人会读它',
          { ref, name, cause: 'not-addressable' })
      }
      unmappedRefs.push(ref)
      notAddressable.push({ ref, name })
      continue
    }
    const value = handle.get(ref)
    assertValueRepresentable(value, { ref, name })
    entries.push({ ref, name, space: plan.space, value })
  }
  if (unmappedRefs.length > 0) {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.REF_UNMAPPED,
      `有 ${unmappedRefs.length} 个引用既不可被 DSH 寻址、也没有映射（${unmappedRefs.join(', ')}）——`
      + '本模块拒绝在"少写一把钥匙"的情况下产出文件；请给 mapping 补上 DSH 那一侧的名字'
      + '（来源是 DSH 自己的 apiKeyEnv 声明，例如 cordis.patch.yml 的 DEEPSEEK_API_KEY）',
      {
        ref: unmappedRefs[0],
        unmappedRefs: Object.freeze([...unmappedRefs]),
        notAddressable: Object.freeze(notAddressable.map((x) => Object.freeze({ ...x }))),
        runId: typeof handle.runId === 'string' ? handle.runId : null,
        heldRefs: Object.freeze([...handle.refs]),
      })
  }
  if (entries.length === 0) {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.HANDLE_REQUIRED,
      '句柄没有持有任何引用——写一份空凭证文件不是"这次运行不需要凭证"',
      { cause: 'no-entries' })
  }
  const byName = new Map()
  for (const e of entries) {
    if (byName.has(e.name)) {
      throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.MAPPING_DUPLICATE,
        `${e.ref} 与 ${byName.get(e.name)} 都被映射到 ${e.name}——后写的会静默压掉先写的，`
        + '而"少了一把钥匙"不会在任何读数里出现',
        { name: e.name, refs: Object.freeze([byName.get(e.name), e.ref]), cause: 'duplicate-name' })
    }
    byName.set(e.name, e.ref)
  }
  const unusedMappingRefs = [...map.keys()].filter((ref) => !usedMappingRefs.has(ref))

  // ── ⑧ 真实根解析（防符号链接逃逸）：证不出在根内，就不写 ────────────────
  let realRoot
  try {
    realRoot = norm(io.realpathSync(resolve(allowedRoot)))
  } catch (err) {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.ALLOWED_ROOT_UNRESOLVED,
      'allowedRoot 解析不出来（不存在或读不出）——证不出目标落在根内，就不写',
      { cause: typeof err?.code === 'string' ? err.code : 'unresolved' })
  }
  let realParent
  try {
    realParent = norm(io.realpathSync(dirname(target)))
  } catch (err) {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.TARGET_DIR_UNRESOLVED,
      '目标的父目录解析不出来（通常是不存在）——本模块不替调用方创建目录：'
      + '写进一个计划外的新目录是另一种意外',
      { cause: typeof err?.code === 'string' ? err.code : 'unresolved' })
  }
  if (!isInsideOrEqual(realParent, realRoot)) {
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.TARGET_OUTSIDE_ROOT,
      '目标的真实父目录不在 allowedRoot 之内（符号链接指向了根外）',
      { cause: 'outside-real-root' })
  }

  // ── ⑨ 渲染 + 写前自校验（**真实读者**是权威） ───────────────────────────
  const text = renderDocument(entries)
  verifyRendered(text, entries)
  const bytes = Buffer.byteLength(text, 'utf8')

  // ── ⑩ 原子落盘：同目录临时文件 → chmod → rename ────────────────────────
  //
  // `open` 的 mode 会被 umask 削，所以 chmod 是**必须**的一步，不是冗余。
  // 临时文件与目标同目录：跨设备的 rename 会退化成"复制 + 删"，那就不再是原子的。
  const tmp = join(dirname(target), `.${targetName}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
  let fd = -1
  try {
    fd = io.openSync(tmp, 'wx', mode)
    io.writeSync(fd, text, null, 'utf8')
    io.fsyncSync(fd)
    io.closeSync(fd)
    fd = -1
    io.chmodSync(tmp, mode)
    io.renameSync(tmp, target)
  } catch (err) {
    if (fd !== -1) {
      try { io.closeSync(fd) } catch { /* 已经没救了：下面还会试删临时文件 */ }
    }
    try { io.unlinkSync(tmp) } catch { /* 临时文件可能压根没建起来 */ }
    // ★ cause 只取 errno：底层 message 里可能有路径与内容。
    throw new CredentialMaterializerError(CREDENTIAL_MATERIALIZER_CODES.WRITE_FAILED,
      '写凭证文件失败（临时文件已尽力清理）——目标未被改动',
      { cause: typeof err?.code === 'string' ? err.code : 'write-error' })
  }

  const descriptor = descriptorOf({
    target,
    mode,
    bytes,
    entries,
    unusedMappingRefs,
    runId: typeof handle.runId === 'string' ? handle.runId : null,
    resolvedAt: typeof handle.resolvedAt === 'string' ? handle.resolvedAt : null,
  })
  return Object.freeze({ ...descriptor, describe: () => descriptor, toJSON: () => descriptor })
}
