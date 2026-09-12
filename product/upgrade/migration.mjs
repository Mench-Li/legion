// product/upgrade/migration.mjs
// ============================================================================
// PRT-807：幂等数据库迁移框架（expand/contract，面向可回滚）
//
// spec §7 line 601：`schema_migrations` —— 「数据库迁移版本和执行结果」。
// spec §9.4 line 733：
//
//   「数据库迁移优先采用**向前兼容**和 expand/contract 策略。若新版本已写入
//    旧版本无法理解的数据，禁止仅回滚二进制；必须使用经过验证的数据库恢复
//    或向前修复流程。」
//
// 这三句话给出了本模块的全部形状。下面把它拆成三条纪律。
//
// ## 纪律一：「已应用」必须与「失败但被吞掉」区分开
//
// 最常见的那种"幂等"是这样写的：
//
//   try { db.exec(m.sql) } catch { /* 已经加过这一列 */ }
//
// 它确实幂等了。它同时把**所有**失败都幂等掉了——语法错误、磁盘满、
// 锁超时、以及那次真的把表改了一半的中途失败。
//
//   > 一个把异常吞掉的幂等迁移，
//   > 与一个"从来没跑过、但每次都报成功"的迁移，是同一个东西。
//
// 所以本模块里判断"已应用"的唯一依据是**存储里的那一行**（`status='applied'`），
// 而不是"这次有没有抛异常"。行只在整个 `up()` 正常返回之后才写；
// 任何抛出都原样向上冒，并落一条 `failed` 记录。
//
// ## 纪律二：迁移的身份是**内容**，不是版本号
//
// 一个已经应用过的版本号，如果它的 `up()` 代码后来被改过，那么"跳过"
// 这个动作就是在假设"改过之后的它与改过之前等价"。这个假设没有任何地方保证。
//
//   > 一个只按版本号判断"已应用"的幂等，
//   > 与一个"改了迁移代码之后、新库升级出来的结构与老库不一样"的幂等，
//   > 是同一个东西——只不过两边都报成功。
//
// 所以每份迁移有一个由 `up()` 源码算出的校验和；已应用而校验和不一致时，
// 结果是 `checksum-drift`（**失败**），不是"跳过"。
//
// ## 纪律三：能不能仅回滚程序，是一个**声明**，不是一个判断
//
// spec line 733 说"若新版本已写入旧版本无法理解的数据，禁止仅回滚二进制"。
// 这句话能不能被机器执行，取决于"这次迁移有没有写入旧版本无法理解的数据"——
// 而这件事只有**写迁移的人**知道。所以 `compatibility` 是迁移的必填字段：
// `additive`（expand，旧版本读得懂）或 `breaking`（contract，旧版本读不懂）。
//
// `planRollback()` 读这些声明，产出**恰好三种**结论之一，并把"会不会丢数据"
// 明确写出来。把三种塌成"回滚成功/失败"两种，会让 contract 迁移之后的那次
// 回滚看起来像是成功的——直到有人打开数据库。
// ============================================================================

import { createHash } from 'node:crypto'

/** 迁移框架版本。 */
export const MIGRATION_FRAMEWORK = 'legion/migration-framework@1'

/**
 * 迁移的兼容性声明。**必填**。
 *
 *   · `additive`  —— expand 阶段：只加表/列/索引，旧程序读得懂（可以只回滚程序）；
 *   · `breaking`  —— contract 阶段：改了旧程序读不懂的东西（不能只回滚程序）。
 */
export const COMPATIBILITY = Object.freeze(['additive', 'breaking'])

/** `schema_migrations` 的 `status` 取值。`partial` 不做——见 `runMigrations`。 */
export const APPLY_STATUSES = Object.freeze(['applied', 'failed'])

/** 一次迁移运行的裁决。**五个值，缺一不可**。 */
export const MIGRATION_OUTCOMES = Object.freeze([
  'no-migrations',
  'applied-all',
  'already-current',
  'failed',
  'checksum-drift',
])

/** 回滚可达性。spec line 733 的三种处置。 */
export const ROLLBACK_SAFETY = Object.freeze([
  'program-only-rollback',
  'forward-fix-required',
  'db-restore-required',
])

export const MIGRATION_CODES = Object.freeze({
  APPLIED: 'migration-applied',
  ALREADY_APPLIED: 'migration-already-applied',
  /** 已应用的行存在，但当前迁移代码的校验和与记录不一致。 */
  CHECKSUM_DRIFT: 'migration-checksum-drift',
  /** 迁移执行中抛出。**异常原样上抛，不吞**。 */
  UP_FAILED: 'migration-up-failed',
  /** 落记录失败——这一次的 `up()` 已经跑了，但没人知道。 */
  RECORD_FAILED: 'migration-record-failed',
  /** 迁移集合本身不合法（版本重复、缺字段、版本不连续）。 */
  PLAN_INVALID: 'migration-plan-invalid',
  /** 没有可跑的迁移。 */
  NOTHING_TO_DO: 'migration-nothing-to-do',
  /** 目标版本比当前 schema 旧，且没有降级迁移。 */
  DOWNGRADE_UNSUPPORTED: 'migration-downgrade-unsupported',
  /** `schema_migrations` 里出现了一个当前迁移集合里没有的版本。 */
  UNKNOWN_APPLIED_VERSION: 'migration-unknown-applied-version',
})

function migrationError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// ---------------------------------------------------------------------------
// 迁移定义
// ---------------------------------------------------------------------------

/**
 * 声明一份迁移。
 *
 * `hasDownMigration` **不是**可选的礼貌字段：它是 `planRollback` 判
 * `forward-fix-required` 的唯一依据。默认 `false` —— 一个没写 down 的迁移
 * 与一个"down 只是抛错"的迁移，在"能不能回退"上是一样的，所以默认必须是最坏的那档。
 */
export function defineMigration({ version, name, up, down = null, compatibility, description = null, downNote = null }) {
  const problems = []
  if (!Number.isInteger(version) || version < 1) problems.push(`version 必须是 >= 1 的整数（收到 ${JSON.stringify(version)}）`)
  if (typeof name !== 'string' || name.trim() === '') problems.push('name 必须是非空字符串')
  if (typeof up !== 'function') problems.push('up 必须是函数')
  if (!COMPATIBILITY.includes(compatibility)) {
    problems.push(`compatibility 必须是 ${COMPATIBILITY.join(' / ')} 之一（收到 ${JSON.stringify(compatibility)}）——` +
      '它决定 contract 迁移之后能不能只回滚程序，只有写迁移的人知道答案，不能靠猜')
  }
  if (problems.length > 0) {
    throw migrationError(MIGRATION_CODES.PLAN_INVALID, `迁移声明不合法：${problems.join('；')}`)
  }
  const source = typeof up === 'function' ? up.toString() : ''
  return Object.freeze({
    version,
    name: name.trim(),
    description,
    compatibility,
    up,
    down,
    hasDownMigration: typeof down === 'function',
    downNote,
    // 身份 = 版本 + 名字 + up 源码。改这三样里的任何一样都会被发现。
    checksum: checksumOf({ version, name: name.trim(), source }),
  })
}

/** 迁移校验和：`sha256:` + 十六进制，前 16 位足够且便于人读。 */
export function checksumOf({ version, name, source }) {
  const h = createHash('sha256').update(`${version}\0${name}\0${source}`, 'utf8').digest('hex')
  return `sha256:${h.slice(0, 32)}`
}

/**
 * 迁移集合自身的合法性。两份迁移用同一个版本号是一个**必然出事故**的配置：
 * 后跑的那一份会覆盖前一份的记录，于是"已应用"这句话对其中一份是假的。
 */
export function validateMigrationPlan(migrations) {
  const problems = []
  const seen = new Map()
  for (const m of migrations) {
    if (m === null || typeof m !== 'object') {
      problems.push(Object.freeze({ code: MIGRATION_CODES.PLAN_INVALID, version: null, message: '迁移不是一个对象' }))
      continue
    }
    if (seen.has(m.version)) {
      problems.push(Object.freeze({
        code: MIGRATION_CODES.PLAN_INVALID, version: m.version,
        message: `版本 ${m.version} 出现两次（${seen.get(m.version)} 与 ${m.name}）：` +
          '后跑的会覆盖前一份的记录，于是"已应用"对其中一份是假的',
      }))
    }
    seen.set(m.version, m.name)
    if (!COMPATIBILITY.includes(m.compatibility)) {
      problems.push(Object.freeze({
        code: MIGRATION_CODES.PLAN_INVALID, version: m.version,
        message: `迁移 ${m.name} 没有合法的 compatibility 声明`,
      }))
    }
  }
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) })
}

// ---------------------------------------------------------------------------
// 存储端口
// ---------------------------------------------------------------------------

/**
 * 内存驱动。**只在测试与演练里用**——它给出 `schema_migrations` 的形状，
 * 让框架的判据可以被驱动到每一种组合上。
 *
 * `failOnRecord` 用来证明"记不上账时要抛"这条判据真的会拦人。
 */
export function createMemoryMigrationStore({ rows = [], failOnRecord = false } = {}) {
  const table = [...rows]
  return Object.freeze({
    kind: 'memory',
    async listApplied() {
      return table
        .filter((r) => r.status === 'applied')
        .map((r) => Object.freeze({ version: r.version, name: r.name, checksum: r.checksum }))
    },
    async recordApplied(entry) {
      if (failOnRecord) throw new Error('模拟：写 schema_migrations 失败（磁盘满 / 锁超时）')
      table.push(Object.freeze({ status: 'applied', ...entry }))
    },
    async recordFailed(entry) {
      table.push(Object.freeze({ status: 'failed', ...entry }))
    },
    rows: () => Object.freeze(table.map((r) => Object.freeze({ ...r }))),
  })
}

// ---------------------------------------------------------------------------
// 迁移运行
// ---------------------------------------------------------------------------

/**
 * 跑迁移。
 *
 * @param {object} args
 * @param {ReadonlyArray<object>} args.migrations
 * @param {{listApplied: Function, recordApplied: Function, recordFailed?: Function}} args.store
 * @param {(m: object, ctx: object) => Promise<object>|object} [args.base]
 *        承载 `up()` 的上下文。**不做任何异常包装**——`up()` 抛什么就往外抛什么。
 * @param {object} [args.plan] 可注入的迁移集合（用于证明"版本重复会被拦"）。
 */
export async function runMigrations({ migrations, store, base = {}, now = () => Date.now() } = {}) {
  if (!Array.isArray(migrations)) throw migrationError(MIGRATION_CODES.PLAN_INVALID, 'migrations 必须是数组')
  if (store === undefined || typeof store.listApplied !== 'function' || typeof store.recordApplied !== 'function') {
    throw migrationError(MIGRATION_CODES.PLAN_INVALID, 'store 必须提供 listApplied() 与 recordApplied()')
  }

  const planVerdict = validateMigrationPlan(migrations)
  if (!planVerdict.ok) {
    return Object.freeze({
      outcome: 'failed',
      code: MIGRATION_CODES.PLAN_INVALID,
      applied: Object.freeze([]),
      skipped: Object.freeze([]),
      failed: null,
      targetVersion: null,
      currentVersion: null,
      plan: planVerdict,
      reason: planVerdict.problems.map((p) => p.message).join('；'),
    })
  }

  const ordered = [...migrations].sort((a, b) => a.version - b.version)
  const appliedRows = await store.listApplied()
  const appliedByVersion = new Map(appliedRows.map((r) => [r.version, r]))
  const planVersions = new Set(ordered.map((m) => m.version))

  // 当前集合里没有的已应用版本：**不忽略**。
  // 它说明这台机器上跑过一个我们不知道的迁移（回滚了一半、或换了分支）。
  const unknown = appliedRows.filter((r) => !planVersions.has(r.version))
  if (unknown.length > 0) {
    return Object.freeze({
      outcome: 'failed',
      code: MIGRATION_CODES.UNKNOWN_APPLIED_VERSION,
      applied: Object.freeze([]), skipped: Object.freeze([]), failed: null,
      targetVersion: ordered[ordered.length - 1]?.version ?? null,
      currentVersion: maxVersion(appliedRows),
      plan: planVerdict,
      reason: `schema_migrations 里有当前迁移集合里没有的版本：${unknown.map((r) => r.version).join(', ')}。` +
        '忽略它们等于在一台状态不明的库上继续迁移',
    })
  }

  const toRun = []
  const skipped = []
  for (const m of ordered) {
    const row = appliedByVersion.get(m.version)
    if (row === undefined) { toRun.push(m); continue }
    if (row.checksum !== m.checksum) {
      // ★ 校验和漂移是一个**失败**，不是"跳过"。
      return Object.freeze({
        outcome: 'checksum-drift',
        code: MIGRATION_CODES.CHECKSUM_DRIFT,
        applied: Object.freeze([]),
        skipped: Object.freeze(skipped),
        failed: Object.freeze({ version: m.version, name: m.name }),
        targetVersion: ordered[ordered.length - 1]?.version ?? null,
        currentVersion: maxVersion(appliedRows),
        plan: planVerdict,
        reason: `迁移 ${m.version}（${m.name}）已应用，但当前代码的校验和 ${m.checksum} 与记录的 ${row.checksum} 不一致。` +
          '跳过它等于假设"改过之后的迁移与改过之前等价"——这个假设没有任何地方保证',
      })
    }
    skipped.push(Object.freeze({ version: m.version, name: m.name, checksum: m.checksum }))
  }

  if (toRun.length === 0) {
    return Object.freeze({
      outcome: ordered.length === 0 ? 'no-migrations' : 'already-current',
      code: ordered.length === 0 ? MIGRATION_CODES.NOTHING_TO_DO : MIGRATION_CODES.ALREADY_APPLIED,
      applied: Object.freeze([]),
      skipped: Object.freeze(skipped),
      failed: null,
      targetVersion: ordered[ordered.length - 1]?.version ?? null,
      currentVersion: maxVersion(appliedRows),
      plan: planVerdict,
      reason: ordered.length === 0
        ? '没有声明任何迁移'
        : `全部 ${skipped.length} 份迁移已应用（按记录，不是按"没抛异常"）`,
    })
  }

  const applied = []
  for (const m of toRun) {
    try {
      await m.up(base)
    } catch (e) {
      // ★ 异常原样上抛的内容记进 failed，**不吞**。
      if (typeof store.recordFailed === 'function') {
        try {
          await store.recordFailed({
            version: m.version, name: m.name, checksum: m.checksum,
            atMs: now(), error: String(e?.message ?? e),
          })
        } catch { /* 记失败记录失败，不再掩盖原始异常 */ }
      }
      return Object.freeze({
        outcome: 'failed',
        code: MIGRATION_CODES.UP_FAILED,
        applied: Object.freeze(applied),
        skipped: Object.freeze(skipped),
        failed: Object.freeze({ version: m.version, name: m.name, error: String(e?.message ?? e) }),
        targetVersion: ordered[ordered.length - 1]?.version ?? null,
        currentVersion: maxVersion(appliedRows),
        plan: planVerdict,
        reason: `迁移 ${m.version}（${m.name}）执行失败：${e?.message ?? e}。` +
          '异常**不吞**——"已应用"的依据是记录里那一行，不是"这次有没有抛异常"',
      })
    }
    try {
      await store.recordApplied({ version: m.version, name: m.name, checksum: m.checksum, atMs: now() })
    } catch (e) {
      // ★ 记不上账 = 这一次的 `up()` 已经跑了，但下一次还会再跑一遍。
      //   对一个可能不幂等的迁移来说，这是最危险的组合，所以**必须失败**。
      return Object.freeze({
        outcome: 'failed',
        code: MIGRATION_CODES.RECORD_FAILED,
        applied: Object.freeze(applied),
        skipped: Object.freeze(skipped),
        failed: Object.freeze({ version: m.version, name: m.name, error: String(e?.message ?? e) }),
        targetVersion: ordered[ordered.length - 1]?.version ?? null,
        currentVersion: maxVersion(appliedRows),
        plan: planVerdict,
        reason: `迁移 ${m.version}（${m.name}）执行成功但记录失败：${e?.message ?? e}。` +
          '下一次启动会把它再跑一遍——对一份"看起来幂等"的迁移，这是最危险的组合',
      })
    }
    applied.push(Object.freeze({ version: m.version, name: m.name, checksum: m.checksum, compatibility: m.compatibility }))
  }

  const targetVersion = ordered[ordered.length - 1]?.version ?? null
  return Object.freeze({
    outcome: 'applied-all',
    code: MIGRATION_CODES.APPLIED,
    applied: Object.freeze(applied),
    skipped: Object.freeze(skipped),
    failed: null,
    targetVersion,
    currentVersion: targetVersion,
    plan: planVerdict,
    reason: `应用了 ${applied.length} 份迁移，跳过 ${skipped.length} 份已应用的`,
  })
}

function maxVersion(rows) {
  const versions = rows.map((r) => r.version).filter((v) => Number.isInteger(v))
  return versions.length === 0 ? null : Math.max(...versions)
}

// ---------------------------------------------------------------------------
// 回滚可达性（PRT-809 的数据侧输入）
// ---------------------------------------------------------------------------

/**
 * 一次已经跑过迁移的升级，能不能**只回滚程序**。
 *
 * 读的是各迁移的 `compatibility` 声明（纪律三）。结论恰好三种，且每一种都
 * 把"会不会丢数据"写出来：
 *
 *   · `program-only-rollback` — 本次应用的全部是 `additive`：旧程序读得懂新结构，
 *     回滚程序即可，**业务数据不丢**；
 *   · `forward-fix-required`  — 出现了 `breaking`，且那些迁移**没有** down：
 *     数据库里已经是旧程序读不懂的数据，回滚二进制会让旧程序读到它不理解的东西。
 *     **向前修复**是唯一安全的路；
 *   · `db-restore-required`   — 出现了 `breaking`，且**全部**都有 down：
 *     可以退回去，但要么执行 down（有丢数据风险，由迁移作者在 `downNote` 里说明），
 *     要么恢复备份。本函数**不**替你选，它把选择摆出来。
 *
 * 注意本函数**不执行**任何回滚动作。它只回答"程序侧的回滚够不够"。
 * 这条区分就是 spec line 733 那句话的可执行形式。
 *
 * @param {{applied?: Array<object>, migrations?: Array<object>}} args
 */
export function planRollback({ applied = [], migrations = [] } = {}) {
  const byVersion = new Map(migrations.map((m) => [m.version, m]))
  // 只认**真的写过库**的那些：`applied` 是本次运行的记录。
  const effective = applied
    .map((a) => byVersion.get(a.version) ?? a)
    .filter((m) => m !== undefined)

  const breaking = effective.filter((m) => m.compatibility === 'breaking')
  const hasDownMigrations = breaking.length > 0 && breaking.every((m) => m.hasDownMigration === true)

  if (breaking.length === 0) {
    return Object.freeze({
      safety: 'program-only-rollback',
      appliedVersions: Object.freeze(effective.map((m) => m.version)),
      breakingVersions: Object.freeze([]),
      dbMustBeRestored: false,
      programRollbackSufficient: true,
      // 明确写出"回滚**做**了什么、**没有**做什么"——这句话是这一档存在的理由。
      restores: Object.freeze(['程序版本（InstallDir 的活动指针）', '数据库：无需恢复，本次迁移都是 additive（expand），旧程序读得懂']),
      doesNotRestore: Object.freeze([]),
      reason: effective.length === 0
        ? '本次升级没有应用任何迁移：回滚程序即可，数据库从未被改动'
        : `本次应用的 ${effective.length} 份迁移全部声明为 additive（expand）：旧程序读得懂新结构，回滚程序不会丢业务数据`,
    })
  }

  if (!hasDownMigrations) {
    return Object.freeze({
      safety: 'forward-fix-required',
      appliedVersions: Object.freeze(effective.map((m) => m.version)),
      breakingVersions: Object.freeze(breaking.map((m) => m.version)),
      dbMustBeRestored: true,
      programRollbackSufficient: false,
      restores: Object.freeze([]),
      doesNotRestore: Object.freeze([
        '程序版本（回滚它会让旧程序读到它不认识的数据）',
        '数据库（没有 down 迁移可退）',
      ]),
      reason: `本次应用了 ${breaking.length} 份 breaking（contract）迁移且它们没有 down：` +
        '数据库里已经是旧版本读不懂的数据。spec line 733 明确禁止此时仅回滚二进制——' +
        '必须向前修复，或从经过验证的备份恢复数据库',
    })
  }

  return Object.freeze({
    safety: 'db-restore-required',
    appliedVersions: Object.freeze(effective.map((m) => m.version)),
    breakingVersions: Object.freeze(breaking.map((m) => m.version)),
    dbMustBeRestored: true,
    programRollbackSufficient: false,
    restores: Object.freeze(['程序版本（在数据库退回之后）']),
    doesNotRestore: Object.freeze([
      '数据库（必须显式执行 down 迁移或从备份恢复；两者都可能丢数据）',
    ]),
    reason: `本次应用了 ${breaking.length} 份 breaking 迁移，它们都提供了 down：` +
      '可以退回，但退回动作本身**可能丢数据**（down 的代价由迁移作者在 downNote 里说明）。' +
      '本判定不替你选"执行 down"还是"从备份恢复"',
  })
}

/**
 * 找出已应用迁移的最后一个 `additive` 边界。
 *
 * 回滚到"某个版本"时，真正要问的是"退回去之后旧程序读得懂吗"。
 * 这一条把答案做成一个**版本号**，供 switchover 决定是只换指针还是必须恢复数据库。
 */
export function lastAdditiveBoundary(applied = [], migrations = []) {
  const byVersion = new Map(migrations.map((m) => [m.version, m]))
  const effective = applied
    .map((a) => byVersion.get(a.version) ?? a)
    .filter((m) => m !== undefined)
    .sort((a, b) => a.version - b.version)
  let boundary = null
  for (const m of effective) {
    if (m.compatibility !== 'additive') break
    boundary = m.version
  }
  return boundary
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/** 一份"标准的"三迁移集合，供自检与用例共用。 */
export function sampleMigrations() {
  return Object.freeze([
    defineMigration({
      version: 1, name: 'create-runs', compatibility: 'additive',
      up: (db) => { db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY)') },
      down: (db) => { db.exec('DROP TABLE runs') },
    }),
    defineMigration({
      version: 2, name: 'add-runs-started-at', compatibility: 'additive',
      up: (db) => { db.exec('ALTER TABLE runs ADD COLUMN started_at INTEGER') },
    }),
    defineMigration({
      version: 3, name: 'drop-legacy-runs-view', compatibility: 'breaking',
      up: (db) => { db.exec('DROP VIEW legacy_runs') },
      downNote: 'down 会重建一个空视图，视图里的行来自历史表，**重建不等于恢复**',
    }),
  ])
}

/**
 * 装载期自检：把本模块的**四条**核心判据各真的跑一遍，留下算出来的值。
 *
 * 这里的每一条都对应文件头的一条纪律；跑不动的那一条意味着纪律没落地。
 */
export function selfCheckMigration() {
  const problems = []
  const samples = sampleMigrations()

  // 判据零：示例集合本身合法。
  const planOk = validateMigrationPlan(samples)
  if (!planOk.ok) problems.push(`示例迁移集合被判为不合法：${planOk.problems.map((p) => p.message).join('；')}`)

  // 判据一：「失败但被吞掉的迁移」必须报 failed，且**不写** applied 记录。
  //         这一段是同步的，用同步驱动跑：`runMigrations` 是 async，所以
  //         自检只算**静态**的那部分（校验和、集合合法性、回滚可达性），
  //         需要真的驱动 `up()` 的判据放在用例里（`migration.test.mjs`）。
  const drift = checksumOf({ version: 1, name: 'create-runs', source: 'function changed() {}' })
  const original = samples[0].checksum
  if (drift === original) problems.push('改了 up 源码之后校验和没变——校验和没有覆盖迁移内容')

  // 判据二：版本重复必须被拦。
  const dup = validateMigrationPlan([...samples, samples[0]])
  if (dup.ok) problems.push('同一个版本号出现两次被判为合法')

  // 判据三：breaking 且无 down → forward-fix-required（不是"回滚成功"）。
  const forward = planRollback({ applied: [samples[2]], migrations: samples })
  if (forward.safety !== 'forward-fix-required') {
    problems.push(`breaking 且无 down 的回滚可达性被判成 ${forward.safety}——它必须是 forward-fix-required`)
  }
  // 判据四：全部 additive → program-only-rollback，且**明确写出**数据库不用恢复。
  const programOnly = planRollback({ applied: [samples[0], samples[1]], migrations: samples })
  if (programOnly.safety !== 'program-only-rollback') {
    problems.push(`全 additive 的回滚可达性被判成 ${programOnly.safety}`)
  }
  if (!programOnly.restores.some((r) => r.includes('数据库'))) {
    problems.push('program-only-rollback 没有写明数据库是否被恢复')
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    framework: MIGRATION_FRAMEWORK,
    compatibility: COMPATIBILITY,
    outcomes: MIGRATION_OUTCOMES,
    rollbackSafety: ROLLBACK_SAFETY,
    samples: Object.freeze({
      sampleCount: samples.length,
      sampleChecksums: Object.freeze(samples.map((m) => `${m.version}:${m.checksum}`)),
      planOk: planOk.ok,
      duplicatePlanOk: dup.ok,
      forwardFixSafety: forward.safety,
      programOnlySafety: programOnly.safety,
      programOnlyRestoresDb: programOnly.restores.some((r) => r.includes('数据库')),
      boundary: lastAdditiveBoundary([samples[0], samples[1], samples[2]], samples),
    }),
  })
}

/** 装载时算一次。`problems` 非空即本模块自己的判据不自洽。 */
export const MIGRATION_CHECKED = selfCheckMigration()
