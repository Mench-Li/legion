// team-hub/pack-facts.mjs
// ============================================================================
// F-20 缺口③：把**能力包的安装事实**持久化到产品库。
//
// spec §4.4 对 F-20 的要求是「校验能力包签名、依赖、权限和 Runtime Contract，
// **安装可回滚**；**team-hub 保存安装事实**，Git 提供审阅与导出」。
// 校验面与回滚已由 `runtime/packs/` 交付；这一层补的是后半句。
//
// ---------------------------------------------------------------------------
// ① 这一层**不做推导**，它只是账的持久化
//
// `runtime/packs/store.mjs` 已经定下一条纪律：**记录是唯一的账，
// `stateOf()` 是账的推导**。所以这里存的是**记录**，不是"当前装了什么"。
//
// 最省事的写法是在 hub 里再放一张 `installed_packs(pack_id, version, enabled)`，
// 顺手在每次 append 时更新它。它在一个方向上很快——查"现在装了什么"不用扫账；
// 而在另一个方向上是错的：**那张表和账会漂移**，而漂移的那一天，
// "账上写着装了、表上写着没装"没有任何东西能判定谁对。
//
//   > 一份「用推导结果当第二份真相」的缓存，
//   > 与一份「在排查时无法判断哪个是对的」的真相，是同一个东西。
//
// 所以 `packAccount()` 直接把账交出去，交给 `createPackStore({ history })`
// 重建——**推导只有一处实现**，重启之后的读数因此与重启前逐字相同。
//
// ---------------------------------------------------------------------------
// ② 只追加，而且 `seq` 由 CAS 把关
//
// 账是"只追加、记录不可变"的，这一条由**两张表的 REVOKE** 保证不了（SQLite
// 没有列级权限），所以它由两件事保证：这一层没有 UPDATE/DELETE 语句（有结构级
// 用例盯着），以及 `seq` 的唯一性。
//
// `seq` 必须**恰好**是 `MAX(seq) + 1`，由 SQL 里的 `INSERT ... SELECT` 一次
// 算出，不是"先读再写"。两个进程同时写时，第二个会撞上主键约束——那正是我们
// 要的：一条静默重编号的记录会让账的顺序与实际发生的顺序不一致，
// 而"顺序"是复盘时唯一能确定因果的东西。
//
//   > 一条被静默重新编号的记录，与一条被插入到错误位置的记录，
//   > 在事后复盘里是同一个东西——只不过前者的账看起来是完整的。
// ============================================================================

import { ensureColumn } from './schema-util.mjs'

export const PACK_FACT_ERRORS = Object.freeze({
  BAD_FACT: 'PACK_FACT_MALFORMED',
  BAD_KIND: 'PACK_FACT_UNKNOWN_KIND',
  SEQ_CONFLICT: 'PACK_FACT_SEQ_CONFLICT',
  WRITE_FAILED: 'PACK_FACT_WRITE_FAILED',
  READ_FAILED: 'PACK_FACT_READ_FAILED',
})

/**
 * 记录账本的形态版本。
 *
 * ★ 与 `runtime/packs/store.mjs` 的 `PACK_STORE_VERSION` **必须同值**，
 * 而这一层刻意**不 import 它**：hub 与 runtime 之间是一条单向的产品边界
 * （hub 是控制面，runtime 是执行面），让 hub 去 import 执行面的常量会把
 * 两端耦合成"改一边必须同时改另一边"，而那样一来漂移就只会在运行时出现。
 * 代价是这里多一份字面量——由用例钉住两者相等，漂移当场变红。
 */
export const PACK_FACT_ACCOUNT_VERSION = 'legion/pack-store@1'

/** 五类记录。与 `PACK_RECORD_KINDS` 同值，理由同上（用例钉住相等）。 */
export const PACK_FACT_KINDS = Object.freeze(['install', 'enable', 'disable', 'upgrade', 'rollback'])

export const isPackFactKind = (k) => PACK_FACT_KINDS.includes(k)

function fail(code, message, extra = {}, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode, ...extra })
}

/**
 * 建表。**加列走 `ensureColumn`**，于是老库可以平滑升级：
 * 一次"新版本多记一个字段"的升级不该要求用户重建数据库
 * （重建意味着**丢掉全部安装事实**，而那正是这一层存在的理由）。
 */
export function ensurePackFactSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pack_install_facts (
      seq INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      pack_id TEXT NOT NULL,
      version TEXT NOT NULL,
      pack_type TEXT,
      pack_protocol_version TEXT,
      content_hash TEXT,
      declared_content_hash TEXT,
      trust TEXT,
      from_version TEXT,
      from_content_hash TEXT,
      preflight_version TEXT,
      verdict_codes_json TEXT NOT NULL,
      recorded_at_ms INTEGER NOT NULL
    )
  `)
  // 读出口最常用的两种切法：按包读全部记录、按 seq 增量拉。
  db.exec('CREATE INDEX IF NOT EXISTS idx_pack_facts_pack ON pack_install_facts (pack_id, seq)')
  // 兼容列：形状将来加字段时不必重建表。
  ensureColumn(db, 'pack_install_facts', 'declared_content_hash', 'TEXT')
}

/**
 * 把一条来自 `runtime/packs/store.mjs` 的记录落进账。
 *
 * **入参是那条记录本身**，不是它的字段列表：这样加字段时调用方不用改，
 * 而"hub 少存了一个字段"这件事也不会发生——少存的那一天，
 * 重建出来的账在某个字段上是 `undefined`，而它与"当时就是空"长得一样。
 */
export function appendPackFact({ db, record, nowMs = Date.now() } = {}) {
  if (db === null || typeof db?.prepare !== 'function') {
    throw fail(PACK_FACT_ERRORS.WRITE_FAILED, 'appendPackFact 需要一个打开的数据库', {}, 500)
  }
  if (record === null || typeof record !== 'object') {
    throw fail(PACK_FACT_ERRORS.BAD_FACT, '要追加的是一条记录对象')
  }
  const kind = record.kind
  if (!isPackFactKind(kind)) {
    throw fail(
      PACK_FACT_ERRORS.BAD_KIND,
      `未知的记录类型 ${JSON.stringify(kind)}（允许：${PACK_FACT_KINDS.join('/')}）——` +
      '账里出现一个读不出来的类型时，整本账的可信度取决于读的人敢不敢说"我不知道"',
    )
  }
  const packId = String(record.packId ?? '').trim()
  if (packId === '') throw fail(PACK_FACT_ERRORS.BAD_FACT, '记录的 packId 不能为空')
  const version = String(record.version ?? '').trim()
  if (version === '') throw fail(PACK_FACT_ERRORS.BAD_FACT, '记录的 version 不能为空')
  const at = Number.isInteger(record.at) ? record.at : null
  if (at === null) throw fail(PACK_FACT_ERRORS.BAD_FACT, '记录的 at 必须是整数毫秒时间戳')

  // ★ `seq` 由**一条 SQL** 算出，不是"先 SELECT MAX 再 INSERT"。
  //   两步之间有一个窗口，两个进程同时进来会拿到同一个 seq，
  //   而那时要么其中一条被覆盖（静默丢账），要么两条共用 seq（账失去顺序）。
  const verdictCodes = JSON.stringify(
    Array.isArray(record.verdictCodes) ? record.verdictCodes.map((c) => String(c)) : [],
  )
  try {
    db.prepare(`
      INSERT INTO pack_install_facts (
        seq, at, kind, pack_id, version, pack_type, pack_protocol_version,
        content_hash, declared_content_hash, trust, from_version, from_content_hash,
        preflight_version, verdict_codes_json, recorded_at_ms
      )
      SELECT
        COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM pack_install_facts
    `).run(
      at, kind, packId, version,
      record.packType ?? null, record.packProtocolVersion ?? null,
      record.contentHash ?? null, record.declaredContentHash ?? null,
      record.trust ?? null, record.fromVersion ?? null, record.fromContentHash ?? null,
      record.preflightVersion ?? null, verdictCodes, nowMs,
    )
  } catch (err) {
    // 主键冲突 = 另一个写入者抢先占了那个 seq。**不重试、不重编号**：
    // 重编号会让这条记录的顺序与实际发生的顺序不一致，而那种账
    // 在事后复盘时无法与"顺序本来就是对的"区分开。
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(err?.message ?? ''))) {
      throw fail(
        PACK_FACT_ERRORS.SEQ_CONFLICT,
        '账的 seq 被另一个写入者抢先占用了。这次写入**没有**发生——' +
        '重编号会静默改掉记录的顺序，请重新读账后再试',
        { cause: String(err?.message ?? err) },
        409,
      )
    }
    throw fail(PACK_FACT_ERRORS.WRITE_FAILED, `写入安装事实失败：${err?.message ?? err}`, {}, 500)
  }
  const row = db.prepare('SELECT MAX(seq) AS seq FROM pack_install_facts').get()
  return { appended: true, seq: Number(row?.seq ?? 0) }
}

function rowToRecord(row) {
  let verdictCodes = []
  try {
    const parsed = JSON.parse(row.verdict_codes_json ?? '[]')
    verdictCodes = Array.isArray(parsed) ? parsed : []
  } catch {
    // 存进去的是我们自己序列化的，读不回来只可能是外部改写。
    // 这时**不猜**：给空数组会让"当时没有任何预检问题"与"这段 JSON 坏了"
    // 变成同一个读数，所以标记出来（由读出口把它当作一份不可信的账）。
    verdictCodes = null
  }
  return Object.freeze({
    seq: Number(row.seq),
    at: Number(row.at),
    kind: row.kind,
    packId: row.pack_id,
    version: row.version,
    packType: row.pack_type ?? null,
    packProtocolVersion: row.pack_protocol_version ?? null,
    contentHash: row.content_hash ?? null,
    declaredContentHash: row.declared_content_hash ?? null,
    trust: row.trust ?? null,
    fromVersion: row.from_version ?? null,
    fromContentHash: row.from_content_hash ?? null,
    preflightVersion: row.preflight_version ?? null,
    verdictCodes: verdictCodes === null ? Object.freeze([]) : Object.freeze(verdictCodes),
    verdictCodesUnreadable: verdictCodes === null,
  })
}

/** 读账。`packId` 缺省 = 整本；`sinceSeq` 用来增量拉。 */
export function packFacts({ db, packId = null, sinceSeq = 0, limit = null } = {}) {
  if (db === null || typeof db?.prepare !== 'function') {
    throw fail(PACK_FACT_ERRORS.READ_FAILED, 'packFacts 需要一个打开的数据库', {}, 500)
  }
  const clauses = ['seq > ?']
  const args = [Number.isInteger(sinceSeq) && sinceSeq >= 0 ? sinceSeq : 0]
  if (packId !== null && packId !== undefined && String(packId).trim() !== '') {
    clauses.push('pack_id = ?')
    args.push(String(packId).trim())
  }
  let sql = `SELECT * FROM pack_install_facts WHERE ${clauses.join(' AND ')} ORDER BY seq ASC`
  if (Number.isInteger(limit) && limit > 0) {
    sql += ' LIMIT ?'
    args.push(limit)
  }
  try {
    return Object.freeze(db.prepare(sql).all(...args).map(rowToRecord))
  } catch (err) {
    throw fail(PACK_FACT_ERRORS.READ_FAILED, `读取安装事实失败：${err?.message ?? err}`, {}, 500)
  }
}

/**
 * 把整本账交出去，形态**就是** `createPackStore({ history })` 认的那个。
 *
 * 这一层的存在理由写在文件头 ①：推导只在 `runtime/packs/` 那一处实现。
 * 若这里顺手算一个 `activeVersion` 出来，重启后的读数就会由**第二份推导**
 * 产生——而两份推导今天一致、没有人维持。
 */
export function packAccount({ db } = {}) {
  const records = packFacts({ db })
  const seq = records.length === 0 ? 0 : records[records.length - 1].seq
  return Object.freeze({
    version: PACK_FACT_ACCOUNT_VERSION,
    seq,
    records,
    // 账里有没有读不回来的东西。**单独给一个读数**：
    // 一个"用坏账重建出来的状态"，与一个"账本来就是那样"的状态，
    // 在 `stateOf()` 上长得一模一样，而前者不该被当成事实使用。
    readable: records.every((r) => r.verdictCodesUnreadable !== true),
  })
}

/**
 * 「Git 提供审阅与导出」的那个导出。
 *
 * 它是一份**可以提交进仓库**的文本：人能在 diff 里看出"这次装了什么、
 * 回滚到哪一版"，而不是读一份二进制快照。刻意**不含**任何凭证或包内容——
 * 一个把包内容一起导出的文件，会在第一次被人 `git add .` 时把整包源码
 * 带进版本历史，而版本历史是删不掉的。
 */
export function exportPackFacts({ db, exportedAtMs = Date.now(), pretty = true } = {}) {
  const account = packAccount({ db })
  const document = {
    format: 'legion/pack-install-facts@1',
    // 账的形状版本与导出格式版本是两件事：前者变了说明记录字段变了，
    // 后者变了说明这份**导出文档**的结构变了。合成一个会让两种变化
    // 在读者眼里无法区分。
    accountVersion: account.version,
    exportedAtMs,
    seq: account.seq,
    packs: summarize(account.records),
    records: account.records.map((r) => Object.freeze({
      seq: r.seq, at: r.at, kind: r.kind, packId: r.packId, version: r.version,
      contentHash: r.contentHash, trust: r.trust,
      fromVersion: r.fromVersion, fromContentHash: r.fromContentHash,
      preflightVersion: r.preflightVersion,
      verdictCodes: r.verdictCodes,
    })),
  }
  return Object.freeze({
    document: Object.freeze(document),
    text: pretty ? `${JSON.stringify(document, null, 2)}\n` : JSON.stringify(document),
  })
}

/** 每个包的当前读数（**仅供导出时给人看**，不作为状态来源）。 */
function summarize(records) {
  const byPack = new Map()
  for (const r of records) {
    if (!byPack.has(r.packId)) {
      byPack.set(r.packId, { packId: r.packId, activeVersion: null, enabled: false, versions: new Set() })
    }
    const entry = byPack.get(r.packId)
    if (r.kind === 'install' || r.kind === 'upgrade' || r.kind === 'rollback') {
      entry.activeVersion = r.version
      entry.versions.add(r.version)
    }
    if (r.kind === 'enable') entry.enabled = true
    if (r.kind === 'disable') entry.enabled = false
  }
  return Object.freeze([...byPack.values()]
    .map((e) => Object.freeze({
      packId: e.packId,
      activeVersion: e.activeVersion,
      enabled: e.enabled,
      versions: Object.freeze([...e.versions]),
    }))
    .sort((a, b) => (a.packId < b.packId ? -1 : 1)))
}

export function packFactCounts({ db } = {}) {
  const rows = db.prepare(
    'SELECT kind, COUNT(*) AS n FROM pack_install_facts GROUP BY kind ORDER BY kind ASC',
  ).all()
  const counts = {}
  for (const k of PACK_FACT_KINDS) counts[k] = 0
  for (const r of rows) counts[r.kind] = Number(r.n)
  const total = db.prepare('SELECT COUNT(*) AS n FROM pack_install_facts').get()
  return Object.freeze({ counts: Object.freeze(counts), total: Number(total?.n ?? 0) })
}
