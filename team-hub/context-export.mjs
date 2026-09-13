// team-hub/context-export.mjs
// ============================================================================
// 上下文快照的**导出**（PRT-409 右半部分，spec line 897「支持查看和导出」）
//
// ## 导出要解决的问题
//
// `run_context_snapshots` 里那份快照是本机的一个 SQLite 行。而"导出"的用途
// 几乎总是**离开这台机器**：给审计的人、给支持的人、附在 bug 报告里。
// 一旦离开，它就要能自己回答一个问题：
//
//   > 我手上这份文件，和当初冻下来的那份，是不是同一份？
//
// ## ★ 为什么要**两个**哈希，而不是一个
//
// 快照自带 `snapshotHash`，它盖住的是**冻结下来的正文**。很自然地会想：
// 既然如此，导出里带着它不就能验证了吗？**不能**——因为导出文件还有一层
// **封皮**：这份导出是从哪个 attempt 导的、谁导的、什么时候导的。
//
//   > 一个"正文哈希在导出里验得过、而封皮没有任何哈希"的导出，
//   > 与一个"谁都能把 attemptId 换成另一个 Attempt"的导出，是同一个东西——
//   > 只不过前者看起来是可验证的。
//
// 具体后果：把封皮里的 `attemptId` 从 `att:A:1` 改成 `att:B:1`，正文原样不动。
// 单哈希验证会**照样通过**，于是这份文件指着另一个 Attempt，而它"验过了"。
// 对审计来说这比没有导出更坏——它是一份**盖过章的错证据**。
//
// 所以导出有**两个**独立的哈希，验证也分开报：
//
//   · `snapshotHash` 不对 → **正文**被改过（内容不可信）；
//   · `snapshotHash` 对、`exportHash` 不对 → **封皮**被改过（这份文件在说谎
//     关于它从哪里来）。两者错的东西完全不同，所以必须分开报，不能合成一个 `ok`。
//
// ## 为什么验证必须**离线**
//
// 一份"要连回那台服务器才能验证"的导出，不是导出，是截图。所以本模块
// 只依赖 `runtime/contracts/context.mjs` 里的纯函数——**不碰库、不碰网络**。
// 用例里专门用一个没有数据库、没有 hub 的子进程来验这件事。
//
// ## 导出是**只读**的
//
// 与 `product/lifecycle/data-export.mjs`（PRT-905）同一条纪律：导出不改动源。
// 本模块不 import 任何 store，唯一的输入是调用方给的记录。
// ============================================================================

import {
  canonicalJson, domainSeparatedHash,
} from '../runtime/contracts/canonical.mjs'
import {
  CONTEXT_SNAPSHOT_SCHEMA_VERSION, verifySnapshotHash,
} from '../runtime/contracts/context.mjs'

/** 导出封面的版本。改动封面字段或哈希覆盖范围时递增。 */
export const CONTEXT_EXPORT_VERSION = 'legion/context-snapshot-export@1'

/** domain separator：导出哈希与快照哈希必须落在不同的域里。 */
export const CONTEXT_EXPORT_DOMAIN = 'legion.context-snapshot-export.v1'

export const CONTEXT_EXPORT_CODES = Object.freeze({
  /** 给的记录不是 store.get() 的形状。 */
  BAD_RECORD: 'CONTEXT_EXPORT_BAD_RECORD',
  /** 记录里的正文哈希对不上——拒绝把一份验不过的东西包装成"可验证的导出"。 */
  RECORD_NOT_VERIFIED: 'CONTEXT_EXPORT_RECORD_NOT_VERIFIED',
  /** 导出文档结构不合法。 */
  MALFORMED_DOC: 'CONTEXT_EXPORT_MALFORMED_DOC',
  /** 正文被改过。 */
  SNAPSHOT_TAMPERED: 'CONTEXT_EXPORT_SNAPSHOT_TAMPERED',
  /** 封皮被改过（正文没动）。 */
  ENVELOPE_TAMPERED: 'CONTEXT_EXPORT_ENVELOPE_TAMPERED',
  /** 存储行哈希与正文哈希不一致（库里的行被改过）。 */
  STORE_HASH_MISMATCH: 'CONTEXT_EXPORT_STORE_HASH_MISMATCH',
})

export class ContextExportError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'ContextExportError'
    this.code = code
    this.detail = Object.freeze({ ...detail })
  }
}

/**
 * 导出哈希盖住的东西：**这份文档里除 `exportHash` 自己以外的每一个字段**。
 *
 * ★ 这个定义是刻意写成"取余"而不是"列举"的。
 *
 * 第一版写的是 `{ envelope, snapshot }`——于是顶层那个冗余的 `snapshotHash`
 * **不在覆盖范围内**。用例里把顶层 `snapshotHash` 改成另一个值，验证结果
 * 仍然报 `ok: true`：findings 里躺着一条"两个 snapshotHash 不一致"，
 * 而总的结论是"通过"。这是一类很隐蔽的坏结果：
 *
 *   > 一份"报了问题却仍然说 ok"的验证结果，
 *   > 与一份"没问题"的验证结果，对调用方是同一个东西——
 *   > 只不过前者的 findings 里躺着一行没人看的字。
 *
 * 而"列举要哈希的字段"这个写法本身还有一个更慢的毛病：
 *
 *   > 一个"新加一个字段就必须记得把它加进哈希"的导出格式，
 *   > 与一个"某天有人加了一个字段、而它不在哈希覆盖范围内"的导出格式，
 *   > 是同一个东西——只不过前者的哈希覆盖范围看起来是完整的。
 *
 * 所以改成"除了它自己，全都盖住"：新增字段自动被覆盖，忘记不了。
 */
function computeExportHash(doc) {
  const { exportHash, ...covered } = doc
  void exportHash
  return domainSeparatedHash(CONTEXT_EXPORT_DOMAIN, CONTEXT_SNAPSHOT_SCHEMA_VERSION, covered)
}

/** 封面里允许出现的键。白名单，理由与 ContextSource 同：忽略会让不该有的字段搭便车。 */
const ENVELOPE_KEYS = Object.freeze([
  'exportVersion', 'attemptId', 'runId', 'exportedAtMs', 'exportedBy', 'sourceStoreHash', 'exportedReason',
])

function requireString(v, field) {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ContextExportError(CONTEXT_EXPORT_CODES.BAD_RECORD, `导出需要非空字符串 ${field}`)
  }
  return v
}

/**
 * 把一条 `store.get()` 的记录做成一份**自验证**的导出。
 *
 * @param {object} record `contextStore().get(attemptId)` 的返回值
 * @param {{exportedBy: string, exportedAtMs: number, exportedReason?: string|null}} opts
 *
 * ★ 导出前**必须**先验一遍正文哈希：一次成功的导出会把"可验证"这三个字
 *   盖在这份文件上。把一份验不过的记录导出出去，等于把一次篡改**洗白**成
 *   一份看起来带哈希的正规文件。
 */
export function buildSnapshotExport(record, { exportedBy, exportedAtMs, exportedReason = null } = {}) {
  if (record === null || typeof record !== 'object') {
    throw new ContextExportError(CONTEXT_EXPORT_CODES.BAD_RECORD, '导出需要 store.get() 返回的记录')
  }
  const attemptId = requireString(record.attemptId, 'record.attemptId')
  const runId = requireString(record.runId, 'record.runId')
  const actor = requireString(exportedBy, 'exportedBy')
  if (!Number.isInteger(exportedAtMs)) {
    // 与 `acquiredAtMs` 同一条纪律：不拿"现在"当默认值。
    // 一个没写时间的导出会被读成"就是刚导的"，而那是一次无法复核的猜测。
    throw new ContextExportError(CONTEXT_EXPORT_CODES.BAD_RECORD,
      '导出需要整数毫秒 exportedAtMs：不拿"现在"当默认值——导出时间是要被复核的')
  }

  const snapshot = record.snapshot
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new ContextExportError(CONTEXT_EXPORT_CODES.BAD_RECORD,
      `记录 ${attemptId} 没有 snapshot 正文：只有摘要的记录导不出"模型当时看到了什么"`)
  }

  // ★ 两道校验，缺一不可：
  //   ① 正文自洽（内容没被改过）；
  //   ② 正文哈希与**库里那一行**记的哈希一致（行没被改过）。
  //   只做 ① 会漏掉"有人把整行连同 payload 一起换成另一份自洽的快照"。
  if (verifySnapshotHash(snapshot) !== true) {
    throw new ContextExportError(CONTEXT_EXPORT_CODES.RECORD_NOT_VERIFIED,
      `快照 ${attemptId} 的正文哈希与内容不符：它被改过。拒绝把一份验不过的记录导出成"可验证的文件"。`,
      { attemptId })
  }
  const storeHash = snapshot.snapshotHash
  if (typeof record.snapshotHash === 'string' && record.snapshotHash !== storeHash) {
    throw new ContextExportError(CONTEXT_EXPORT_CODES.STORE_HASH_MISMATCH,
      `快照 ${attemptId} 的存储行哈希（${String(record.snapshotHash).slice(0, 19)}…）与正文哈希` +
      `（${String(storeHash).slice(0, 19)}…）不一致：库里的那一行被改过。拒绝导出。`,
      { attemptId, storeHash: record.snapshotHash, snapshotHash: storeHash })
  }

  const envelope = Object.freeze({
    exportVersion: CONTEXT_EXPORT_VERSION,
    attemptId,
    runId,
    exportedAtMs,
    exportedBy: actor,
    // 记下"导出时库里的那一行是什么哈希"，让这份文件能**对回**一次具体查询。
    sourceStoreHash: storeHash,
    ...(exportedReason === null ? {} : { exportedReason: requireString(exportedReason, 'exportedReason') }),
  })

  // 先拼出"除 exportHash 以外"的整份文档，再算哈希——哈希覆盖范围由
  // `computeExportHash` 的"取余"定义决定，这里不需要（也不该）再列举一遍。
  const body = Object.freeze({
    exportVersion: CONTEXT_EXPORT_VERSION,
    envelope,
    snapshot,
    // 冗余写一份，纯粹为了让"人拿文本编辑器打开"也能一眼看到两个哈希。
    // ★ 它同样落在哈希覆盖范围内（见 computeExportHash）。
    snapshotHash: storeHash,
  })

  return Object.freeze({ ...body, exportHash: computeExportHash(body) })
}

/**
 * **离线**验证一份导出。
 *
 * 不碰库、不碰网络：只依赖纯哈希函数。
 * 返回的是**分别**的两个结论，不合并成一个布尔——正文被改与封皮被改
 * 是两件不同的事，合成一个 `ok` 会让其中一件悄悄消失。
 *
 * @returns {{wellFormed: boolean, ok: boolean, exportOk: boolean, snapshotOk: boolean,
 *            recomputedExportHash: string|null, recomputedSnapshotHash: string|null,
 *            findings: ReadonlyArray<{code: string, detail: string}>}}
 */
export function verifySnapshotExport(doc) {
  const findings = []
  const bad = (code, detail) => Object.freeze({ code, detail })

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return Object.freeze({
      wellFormed: false, ok: false, exportOk: false, snapshotOk: false,
      recomputedExportHash: null, recomputedSnapshotHash: null,
      findings: Object.freeze([bad(CONTEXT_EXPORT_CODES.MALFORMED_DOC, '导出必须是对象')]),
    })
  }
  // ★ 这个局部量**故意不叫 `env`**。
  //
  //   第一版叫 `env`，于是拓扑清单的扫描器把 `env.exportVersion` 读成了
  //   "读了一个环境变量 exportVersion"，报出一条 undeclaredEnvKeys 漂移。
  //
  //     > 一个把封皮局部量命名为 env 的函数，
  //     > 与一个真的读了环境变量的函数，
  //     > 在只看 `env.X` 的扫描器眼里是同一个东西——
  //     > 只不过前者会让下一个人去查一个不存在的配置项。
  //
  //   改名比给扫描器加例外好：例外会让**真的**环境读取也一起被放过，
  //   而"漏掉一次真实的环境依赖"正是那条检查存在的理由。
  const envelopeDoc = doc.envelope
  if (envelopeDoc === null || typeof envelopeDoc !== 'object' || Array.isArray(envelopeDoc)) {
    return Object.freeze({
      wellFormed: false, ok: false, exportOk: false, snapshotOk: false,
      recomputedExportHash: null, recomputedSnapshotHash: null,
      findings: Object.freeze([bad(CONTEXT_EXPORT_CODES.MALFORMED_DOC, '导出缺少 envelope 封皮')]),
    })
  }
  if (envelopeDoc.exportVersion !== CONTEXT_EXPORT_VERSION) {
    // 版本不同**不猜**：封面字段的语义会随版本变，按旧语义读新文件
    // 会把"字段挪了位置"读成"内容被改了"。
    findings.push(bad(CONTEXT_EXPORT_CODES.MALFORMED_DOC,
      `导出封面版本是 ${JSON.stringify(envelopeDoc.exportVersion)}，本实现只认 ${CONTEXT_EXPORT_VERSION}。` +
      '不按未知版本猜测字段语义'))
  }
  if (doc.snapshot === null || typeof doc.snapshot !== 'object' || Array.isArray(doc.snapshot)) {
    return Object.freeze({
      wellFormed: false, ok: false, exportOk: false, snapshotOk: false,
      recomputedExportHash: null, recomputedSnapshotHash: null,
      findings: Object.freeze([
        ...findings,
        bad(CONTEXT_EXPORT_CODES.MALFORMED_DOC, '导出缺少 snapshot 正文'),
      ]),
    })
  }

  // ① 正文
  const recomputedSnapshotHash = doc.snapshot.snapshotHash ?? null
  const snapshotOk = verifySnapshotHash(doc.snapshot) === true
  if (!snapshotOk) {
    findings.push(bad(CONTEXT_EXPORT_CODES.SNAPSHOT_TAMPERED,
      `正文哈希对不上：记录的 ${String(doc.snapshotHash).slice(0, 19)}…，` +
      `重算的 ${String(recomputedSnapshotHash).slice(0, 19)}…。这份文件里的上下文被改过。`))
  }
  // 冗余字段也要对——它不一致说明有人只改了其中一个。
  if (typeof doc.snapshotHash === 'string' && doc.snapshotHash !== recomputedSnapshotHash) {
    findings.push(bad(CONTEXT_EXPORT_CODES.SNAPSHOT_TAMPERED,
      '导出顶层的 snapshotHash 与正文自带的 snapshotHash 不一致：两者只改了一个'))
  }

  // ② 封皮 + 整份快照
  const recomputedExportHash = computeExportHash(doc)
  const exportOk = doc.exportHash === recomputedExportHash
  if (!exportOk && snapshotOk) {
    // ★ 这一条是"单哈希导出"抓不到的那一类：**正文一字未动，封皮在说谎**。
    findings.push(bad(CONTEXT_EXPORT_CODES.ENVELOPE_TAMPERED,
      `封皮哈希对不上（正文本身是好的）：记录的 ${String(doc.exportHash).slice(0, 19)}…，` +
      `重算的 ${recomputedExportHash.slice(0, 19)}…。这份文件关于"它从哪里来"的那部分是假的——` +
      '注意正文仍然验得过，所以只看正文哈希会以为一切正常'))
  } else if (!exportOk) {
    findings.push(bad(CONTEXT_EXPORT_CODES.ENVELOPE_TAMPERED,
      '封皮哈希对不上（正文也已验不过）：两份都不可信'))
  }

  const wellFormed = findings.every((f) => f.code !== CONTEXT_EXPORT_CODES.MALFORMED_DOC)

  return Object.freeze({
    wellFormed,
    // ★ `ok` 的定义是"**一条问题都没有**"，而不是"两个布尔都是 true"。
    //
    //   第一版写的是 `exportOk && snapshotOk`。于是顶层 `snapshotHash` 与正文
    //   不一致时（一条真实的 finding）总判定仍是 `ok: true`：
    //
    //     > 一份"报了问题却仍然说 ok"的验证结果，
    //     > 与一份"没问题"的验证结果，对调用方是同一个东西——
    //     > 只不过前者的 findings 里躺着一行没人看的字。
    //
    //   把 findings 也算进来，是给**将来的**每一条新检查上的一份保险：
    //   新增一条 finding 而忘了翻转某个布尔，是很容易发生的事。
    ok: wellFormed && exportOk && snapshotOk && findings.length === 0,
    exportOk,
    snapshotOk,
    recomputedExportHash,
    recomputedSnapshotHash,
    findings: Object.freeze(findings),
  })
}

/** 导出封面里允许出现的键（供用例与文档引用）。 */
export const CONTEXT_EXPORT_ENVELOPE_KEYS = ENVELOPE_KEYS

/**
 * 导出文档的 canonical 文本——"这份文件到底是什么"的字节级答案。
 *
 * 覆盖范围与 `computeExportHash` **完全一致**（除 `exportHash` 以外的全部字段）。
 * 两处若各列一份清单，它们迟早不一样——而"哈希盖住的东西"与
 * "用来比对的东西"不是同一批字段，会让一次比对通过而哈希不通过。
 */
export function exportCanonicalJson(doc) {
  const { exportHash, ...covered } = doc
  void exportHash
  return canonicalJson(covered)
}
