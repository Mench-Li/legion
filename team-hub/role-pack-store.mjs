// team-hub/role-pack-store.mjs
// ============================================================================
// F-19 缺口②：把**冻结的岗位包**存下来。
//
// `runtime/employee/role-pack.mjs` 已经能产出一份"七类版本都固化"的岗位包，
// 但它是**算出来的**——一份算出来就丢掉的岗位包，与一份从来没算过的岗位包，
// 在"上周那个岗位是哪一版"这个问题上是同一个回答。
//
//   > 一个「只活在内存里的冻结产物」，
//   > 与一个「重启之后就没了」的冻结产物，是同一个东西——
//   > 只不过前者在代码里看起来是有产物的。
//
// ---------------------------------------------------------------------------
// ★ 为什么**不能**放进 `employee_manifests`
//
// hub 里已经有一张岗位表（`context-plan-store.mjs`），主键是 `(scope, role)`，
// 而且它**会被就地更新**（它带着 `updated_at_ms`）——那是"这个岗位**现在**是什么"。
//
// 岗位包要回答的是另一个问题："这个岗位**当时**是哪一版"。把两者放进同一张表，
// 主键 `(scope, role)` 会让第二版**覆盖**第一版：
//
//   > 一张「主键是 (scope, role)、就地更新」的冻结表，
//   > 与一张「只保留最近一版、而历史版本从未存在过」的表，是同一个东西——
//   > 只不过前者的表名叫 role_packs。
//
// 所以主键是 `(scope, role_pack_id, version)`：**多个版本同时存在**——
// 这正是"冻结"这个词的全部含义。
//
// ---------------------------------------------------------------------------
// ② 同一版本写入必须是**幂等或冲突**，没有第三种结果
//
// 重放一次"冻结"请求是最常见的事（重试、重启后补偿、两个进程同时冻同一版）。
// 于是"同一个 (id, version) 又写了一次"有三种可能语义：
//
//   · 覆盖 ⇒ ✗ 直接毁掉冻结：第二版把第一版的内容换掉，而 run 记录里
//     只有 `version`，于是"那次运行到底用的哪一份内容"永远无法回答。
//   · 报错 ⇒ ✗ 重试变成一个必须人工清理的错误，而它本该是幂等的。
//   · **内容相同则幂等成功、内容不同则 409** ⇒ ✓
//
//   > 一个「同版本覆盖」的写入，
//   > 与一个「版本号是标签、而标签可以被重新贴」的写入，是同一个东西。
//
// 这与 `runtime/employee/role-pack.mjs` 里那条纪律是同一件事在存储层的重演：
// **版本号是标签，内容哈希才是身份。**
//
// ---------------------------------------------------------------------------
// ③ ★ 行的**主内容**就是那份岗位包本身（`pack_json`）
//
// 表里另有一组查询列（`role` / `version` / `content_hash`）。它们**不是**
// 第二份真相，理由只有一条：这张表**只追加、从不 UPDATE**，
// 所以那些列是在同一条 INSERT 里写一次的**投影**，没有任何路径能单独改动它们。
//
//   > 一组「只在 INSERT 时写一次、此后没有任何 UPDATE 路径」的投影列，
//   > 与一组会各自漂移的第二真相，是同一个东西的唯一条件是：**没有 UPDATE 路径**。
//
// 那一条由结构级用例钉住（`role-pack-store.test.mjs` 断言本文件里
// 不出现 `UPDATE role_packs` / `DELETE FROM role_packs`）。
//
// 于是读出就是**原样**：`normalizeRolePack(record.pack)` 不需要任何转写。
// 控制面做任何转写，那个转写就是第二份推导，而两份推导今天一致、没人维持。
//
// ---------------------------------------------------------------------------
// ④ hub 与 runtime 之间是**单向**的产品边界
//
// 这一层**不 import** `runtime/employee/role-pack.mjs`。它自己写一份字面量
// （`ROLE_PACK_LITERALS`），并由用例**逐字比较**钉住：漂移当场变红。
// 直接 import 会让执行面的每一次内部重构都变成产品库的编译期依赖。
//
// 代价是必须同步——**那就是那条例外用例存在的理由**。
// ============================================================================

import { ensureColumn } from './schema-util.mjs'

/**
 * hub 侧对执行面字面量的**唯一**一份副本（见文件头 ④）。
 *
 * 取值必须与 `runtime/employee/role-pack.mjs` 逐字相同，由用例钉住。
 */
export const ROLE_PACK_LITERALS = Object.freeze({
  /** 对应 `ROLE_PACK_VERSION`。 */
  manifestVersion: 'legion/role-pack@1',
  /** 七类，顺序也要一致（它是哈希输入的一部分，顺序变了哈希就变）。 */
  sections: Object.freeze([
    'prompt', 'skills', 'tools', 'permissions', 'model', 'connectors', 'budget',
  ]),
})

/** 冻结产物的落盘格式版本（与 runtime 的形态版本是两件事）。 */
export const ROLE_PACK_RECORD_VERSION = 'legion/role-pack-record@1'

export const ROLE_PACK_STORE_ERRORS = Object.freeze({
  /** 记录本身不合法（缺字段 / 类型不对）。 */
  BAD_RECORD: 'ROLE_PACK_RECORD_MALFORMED',
  /** 七类对不上（少一类、多一类、顺序不同）。 */
  SECTIONS_MISMATCH: 'ROLE_PACK_SECTIONS_MISMATCH',
  /** 同一个 (id, version) 已有**不同内容**——不是重试，是身份冲突。 */
  VERSION_CONFLICT: 'ROLE_PACK_VERSION_CONFLICT',
  /** 找不到。 */
  NOT_FOUND: 'ROLE_PACK_NOT_FOUND',
  /** 写入失败（磁盘 / 约束）。 */
  WRITE_FAILED: 'ROLE_PACK_WRITE_FAILED',
  /** 读取失败。 */
  READ_FAILED: 'ROLE_PACK_READ_FAILED',
})

function fail(code, message, extra = {}, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode, ...extra })
}

/**
 * 建表。**加列走 `ensureColumn`**，于是老库可以平滑升级。
 *
 * 主键 `(scope, role_pack_id, version)` —— 见文件头 ★：多版本共存是"冻结"
 * 的全部含义。
 */
export function ensureRolePackSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS role_packs (
      scope TEXT NOT NULL,
      role_pack_id TEXT NOT NULL,
      version TEXT NOT NULL,
      role TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      pack_json TEXT NOT NULL,
      frozen_at_ms INTEGER NOT NULL,
      frozen_by TEXT,
      PRIMARY KEY (scope, role_pack_id, version)
    )
  `)
  // "这个岗位该用哪一版"是热路径（每次装配一次），
  // 而 `(scope, role_pack_id, version)` 那个主键对它是**用不上**的。
  db.exec('CREATE INDEX IF NOT EXISTS idx_role_packs_role ON role_packs (scope, role, frozen_at_ms)')
  // 按内容哈希反查：回答"这一版内容还有没有别的地方在用"。
  db.exec('CREATE INDEX IF NOT EXISTS idx_role_packs_hash ON role_packs (scope, content_hash)')
  // 老库平滑升级位（本版没有的新列留在这里加，避免以后漏写）。
  ensureColumn(db, 'role_packs', 'frozen_by', 'TEXT')
}

// ---------------------------------------------------------------- 形状

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 校验一条要落盘的记录。
 *
 * 记录的**主内容**是 `pack`（见文件头 ③），provenance 字段（谁冻的、什么时候）
 * 与它并列——因为它们不属于岗位包本身，混进去会被 `normalizeRolePack`
 * 的字段闭包拒掉，而"为了塞进去而在读的时候剥一层"正是那份多余的转写。
 *
 * 只做**结构**检查，不重算内容哈希——重算会让控制面拥有第二份哈希实现，
 * 而两份哈希实现今天一致、没人维持。哈希由执行面算好交过来，
 * 这里只保证"它与这一版绑在一起"。
 */
export function normalizeRolePackRecord(input) {
  if (!isPlainObject(input)) {
    throw fail(ROLE_PACK_STORE_ERRORS.BAD_RECORD, '岗位包记录必须是一个对象')
  }
  const pack = input.pack ?? input
  if (!isPlainObject(pack)) {
    throw fail(ROLE_PACK_STORE_ERRORS.BAD_RECORD, '岗位包记录的 `pack` 必须是一个对象')
  }
  const str = (v, field) => {
    const s = v === null || v === undefined ? '' : String(v).trim()
    if (s === '') {
      throw fail(ROLE_PACK_STORE_ERRORS.BAD_RECORD, `岗位包记录缺少 \`${field}\``, { field })
    }
    return s
  }
  const rolePackId = str(pack.rolePackId, 'rolePackId')
  const version = str(pack.version, 'version')
  const role = str(pack.role, 'role')

  if (pack.manifestVersion !== ROLE_PACK_LITERALS.manifestVersion) {
    throw fail(
      ROLE_PACK_STORE_ERRORS.BAD_RECORD,
      `岗位包的 manifestVersion 是 ${JSON.stringify(pack.manifestVersion)}，` +
      `期望 ${ROLE_PACK_LITERALS.manifestVersion}。**不猜**：形态版本对不上时，` +
      '旧记录按新规则读出来的字段含义可能已经不同',
    )
  }

  const sections = pack.sections
  if (!isPlainObject(sections)) {
    throw fail(ROLE_PACK_STORE_ERRORS.BAD_RECORD, `${rolePackId} 的 sections 必须是一个对象`)
  }
  // ★ 七类必须**逐个**对上，包括**顺序**——顺序是内容哈希的输入。
  const keys = Object.keys(sections)
  const want = [...ROLE_PACK_LITERALS.sections]
  if (keys.length !== want.length || want.some((s, i) => keys[i] !== s)) {
    throw fail(
      ROLE_PACK_STORE_ERRORS.SECTIONS_MISMATCH,
      `${rolePackId} 的 sections 键是 ${JSON.stringify(keys)}，期望 ${JSON.stringify(want)}。` +
      '七类必须逐个对上——**顺序也是**：它是内容哈希的输入，' +
      '顺序变了哈希就变，于是同一份岗位包会有两个身份',
      { rolePackId, keys, want },
    )
  }

  const contentHash = str(pack.contentHash, 'contentHash')
  if (!/^sha256:[0-9a-f]{64}$/.test(contentHash)) {
    throw fail(
      ROLE_PACK_STORE_ERRORS.BAD_RECORD,
      `${rolePackId} 的 contentHash ${JSON.stringify(pack.contentHash)} 不是 sha256:<64hex>`,
    )
  }

  const frozenAtMs = input.frozenAtMs === undefined || input.frozenAtMs === null
    ? Date.now()
    : Number(input.frozenAtMs)
  if (!Number.isInteger(frozenAtMs) || frozenAtMs < 0) {
    throw fail(ROLE_PACK_STORE_ERRORS.BAD_RECORD, `${rolePackId} 的 frozenAtMs 不是非负整数`)
  }

  // `pack` 原样存：**不挑字段、不重排、不补默认值**。
  // 挑字段就是那份转写；补默认值会让"作者没写"与"写了个默认值"变成同一件事。
  return Object.freeze({
    recordVersion: ROLE_PACK_RECORD_VERSION,
    pack: Object.freeze({ ...pack }),
    frozenAtMs,
    frozenBy: input.frozenBy === undefined || input.frozenBy === null ? null : String(input.frozenBy),
  })
}

/** 行 → 记录。读出口的**唯一**一条路径。 */
function rowToRecord(row) {
  if (!row) return null
  let pack = null
  let readable = true
  try {
    pack = JSON.parse(row.pack_json)
  } catch {
    // ★ 坏 JSON **不**当成"这个岗位包是空的"：那是把一次数据损坏读成
    //   "这个岗位当时什么限制都没有"。`.pack === null` 是一个明确的读数。
    readable = false
  }
  return Object.freeze({
    recordVersion: ROLE_PACK_RECORD_VERSION,
    pack: pack === null ? null : Object.freeze(pack),
    packReadable: readable,
    frozenAtMs: row.frozen_at_ms,
    frozenBy: row.frozen_by ?? null,
    // 投影列的读数也一并给出，但**它只是投影**（见文件头 ③）。
    projected: Object.freeze({
      scope: row.scope, rolePackId: row.role_pack_id, version: row.version,
      role: row.role, contentHash: row.content_hash,
    }),
  })
}

// ---------------------------------------------------------------- 读写

/**
 * 冻结一份岗位包。
 *
 * 三种结果，**没有第四种**（见文件头 ②）：
 *   · `{ frozen: true, created: true }`  —— 新的一版
 *   · `{ frozen: true, created: false }` —— 同 (id, version) 同哈希，幂等重放
 *   · 抛 `VERSION_CONFLICT`（409）        —— 同 (id, version) **不同**哈希
 *
 * ★ 冲突那一条的文案必须说清"这次写入**没有**发生"——否则调用方会以为
 *   "没报错的那部分生效了"，而冻结是一件事，没有半件。
 */
export function freezeRolePack({ db, record, scope = 'default' } = {}) {
  const r = normalizeRolePackRecord(record)
  const { rolePackId, version, role, contentHash } = {
    rolePackId: r.pack.rolePackId, version: r.pack.version,
    role: r.pack.role, contentHash: r.pack.contentHash,
  }
  const select = () => db.prepare(
    'SELECT * FROM role_packs WHERE scope = ? AND role_pack_id = ? AND version = ?',
  ).get(scope, rolePackId, version)

  const existing = select()
  if (existing) {
    if (existing.content_hash === contentHash) {
      // 幂等：**不更新** `frozen_at_ms`/`frozen_by`。
      // 更新它们会让"第一次是什么时候冻的"被一次重试改写——
      // 而"什么时候冻的"正是事后定位"那次运行用的哪一版"的入口。
      return Object.freeze({ frozen: true, created: false, record: rowToRecord(existing) })
    }
    // ★ 这条断言看着多余（上面的 `if` 已经保证两个哈希不同），但它防的是一类
    //   很具体的错：下面那段文案**断言**"内容不同"。只要有人调换了这两个分支，
    //   文案就会开始撒谎——而且是拿着两个一模一样的哈希说"内容不同"。
    //   实测（变异验证）把上面那个 `if` 改成恒假时，报错正是：
    //   「已冻结 sha256:791e…，本次 sha256:791e…（内容不同）」。
    //   一条会撒谎的报错，比一条没有报错更坏：读它的人会去查一个不存在的差异。
    if (existing.content_hash === contentHash) {
      throw fail(
        ROLE_PACK_STORE_ERRORS.WRITE_FAILED,
        '内部不一致：走到"版本冲突"分支时两个哈希却是相同的。' +
        '报 500 而不是让下面那段文案带着同样的哈希说"内容不同"',
        { rolePackId, version }, 500,
      )
    }
    throw fail(
      ROLE_PACK_STORE_ERRORS.VERSION_CONFLICT,
      `${rolePackId} 的 ${version} 已经冻结过，但**内容不同**` +
      `（已冻结 ${existing.content_hash}，本次 ${contentHash}）。**这一次写入没有发生。**` +
      '★ 版本号是标签、内容哈希才是身份：允许同版本换内容，等于允许"两次运行引用同一个' +
      '版本号、而实际上是两份不同的岗位"——那时"当时用的是哪一版"就再也回答不了了。' +
      '确实改了内容就**递增版本号**',
      { rolePackId, version, existingHash: existing.content_hash, incomingHash: contentHash },
      409,
    )
  }

  try {
    db.prepare(`
      INSERT INTO role_packs (
        scope, role_pack_id, version, role, content_hash, pack_json, frozen_at_ms, frozen_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scope, rolePackId, version, role, contentHash,
      JSON.stringify(r.pack), r.frozenAtMs, r.frozenBy,
    )
  } catch (e) {
    // 两个进程同时冻同一版的竞态：唯一约束会在这里挡住。
    // ★ 此时**再查一次**：如果现在读到的哈希与本次相同，那是幂等而不是失败——
    //   把一次成功重试报成 500 会让调用方**无限重试**一个已经成功的写入。
    const after = select()
    if (after && after.content_hash === contentHash) {
      return Object.freeze({ frozen: true, created: false, record: rowToRecord(after) })
    }
    if (after) {
      throw fail(
        ROLE_PACK_STORE_ERRORS.VERSION_CONFLICT,
        `${rolePackId} 的 ${version} 已被另一个写入者冻成不同内容。**这一次写入没有发生。**`,
        { rolePackId, version },
        409,
      )
    }
    throw fail(
      ROLE_PACK_STORE_ERRORS.WRITE_FAILED,
      `冻结 ${rolePackId}@${version} 失败：${e?.message ?? e}。` +
      '报 5xx 而不是 4xx：把磁盘错误报成"你的请求有问题"，会让调用方放弃一个其实可以重试的写入',
      {}, 500,
    )
  }

  return Object.freeze({ frozen: true, created: true, record: rowToRecord(select()) })
}

/**
 * 取一版（不传 `version` 就是**最新**那一版）。
 *
 * ★ 按 `frozen_at_ms` 降序、再按 `version` 降序：只按 `frozen_at_ms` 时，
 *   同一毫秒冻的两版顺序不定，而"最新"取决于磁盘恰好怎么排——
 *   一个"最新版本取决于返回顺序"的查询，与一个随机返回一版的查询是同一个东西。
 */
export function getRolePack({ db, rolePackId, version = null, scope = 'default' } = {}) {
  const id = String(rolePackId ?? '').trim()
  if (id === '') {
    throw fail(ROLE_PACK_STORE_ERRORS.BAD_RECORD, 'getRolePack 需要 rolePackId', { field: 'rolePackId' })
  }
  const row = version === null || version === undefined
    ? db.prepare(
      'SELECT * FROM role_packs WHERE scope = ? AND role_pack_id = ? ORDER BY frozen_at_ms DESC, version DESC LIMIT 1',
    ).get(scope, id)
    : db.prepare(
      'SELECT * FROM role_packs WHERE scope = ? AND role_pack_id = ? AND version = ?',
    ).get(scope, id, String(version))
  return rowToRecord(row)
}

/** 按岗位 / 包 id 列出各版本（新的在前）。 */
export function listRolePacks({ db, role = null, rolePackId = null, scope = 'default', limit = 100 } = {}) {
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 100
  const where = ['scope = ?']
  const args = [scope]
  if (rolePackId !== null) { where.push('role_pack_id = ?'); args.push(String(rolePackId)) }
  if (role !== null) { where.push('role = ?'); args.push(String(role)) }
  const rows = db.prepare(
    `SELECT * FROM role_packs WHERE ${where.join(' AND ')} ORDER BY frozen_at_ms DESC, version DESC LIMIT ?`,
  ).all(...args, n)
  return Object.freeze(rows.map(rowToRecord).filter(Boolean))
}

/**
 * 冻结时刻的读数：够不够回答"当时是哪一版"。
 *
 * 与 F-15 那条纪律同源——每个数字都要有一个"不知道"的邻居，
 * 拿不到时**不能报 0**（0 会被读成"一版都没冻过"，而那是一个结论）。
 */
export function rolePackCounts({ db, scope = 'default' } = {}) {
  try {
    const one = (sql) => db.prepare(sql).get(scope)?.n
    const total = one('SELECT COUNT(*) AS n FROM role_packs WHERE scope = ?')
    const ids = one('SELECT COUNT(DISTINCT role_pack_id) AS n FROM role_packs WHERE scope = ?')
    const roles = one('SELECT COUNT(DISTINCT role) AS n FROM role_packs WHERE scope = ?')
    return Object.freeze({
      readable: true,
      total: Number.isFinite(total) ? total : null,
      rolePackIds: Number.isFinite(ids) ? ids : null,
      roles: Number.isFinite(roles) ? roles : null,
    })
  } catch (e) {
    return Object.freeze({
      readable: false, total: null, rolePackIds: null, roles: null,
      reason: String(e?.message ?? e),
    })
  }
}

/**
 * 导出成一段可提交进 Git 的审阅文本。
 *
 * ★ 字段是**白名单**。岗位包本身不含凭证（连接器一节只许引用，见
 * `role-pack.mjs` 文件头 ④），但仍然只导"审阅需要的那些"：
 * 一个把整包原样 dump 出去的导出，会在第一次 `git add .` 时把内容带进
 * 版本历史，而版本历史删不掉。
 */
export function exportRolePacks({ db, scope = 'default', exportedAtMs = Date.now(), pretty = true } = {}) {
  let rows = []
  try {
    rows = db.prepare(
      'SELECT * FROM role_packs WHERE scope = ? ORDER BY role_pack_id ASC, frozen_at_ms ASC, version ASC',
    ).all(scope)
  } catch (e) {
    throw fail(ROLE_PACK_STORE_ERRORS.READ_FAILED, `读岗位包失败：${e?.message ?? e}`, {}, 500)
  }
  const packs = rows.map((row) => {
    let pack = null
    try { pack = JSON.parse(row.pack_json) } catch { pack = null }
    return {
      rolePackId: row.role_pack_id,
      version: row.version,
      role: row.role,
      contentHash: row.content_hash,
      // 七类的**引用**是审阅的核心：它回答"这一版固化了哪些 id@版本"。
      sections: pack === null ? null : Object.fromEntries(
        Object.entries(pack.sections ?? {}).map(([k, v]) => [k, summarizeSection(v)]),
      ),
      frozenAtMs: row.frozen_at_ms,
    }
  })
  const doc = {
    format: 'legion/role-pack-frozen@1',
    recordVersion: ROLE_PACK_RECORD_VERSION,
    manifestVersion: ROLE_PACK_LITERALS.manifestVersion,
    exportedAtMs,
    counts: rolePackCounts({ db, scope }),
    packs,
  }
  return pretty ? `${JSON.stringify(doc, null, 2)}\n` : JSON.stringify(doc)
}

/** 只取"审阅要看的东西"：id 与版本。**不带 hash**——审阅时它是噪声。 */
function summarizeSection(v) {
  if (Array.isArray(v)) return v.map((x) => `${x?.id}@${x?.version}`)
  if (v === null || typeof v !== 'object') return null
  const idField = ['id', 'presetId', 'policyId', 'profileId'].find((f) => v[f] !== undefined)
  return idField === undefined ? null : `${v[idField]}@${v.version}`
}
