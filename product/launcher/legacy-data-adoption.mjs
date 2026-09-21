// product/launcher/legacy-data-adoption.mjs
// ============================================================================
// PRT-251 续 ④：把**安装目录里已有的业务数据**接进 DataDir
//
// spec 附录 A.2 第 2 条（实测结论，原文）：
//
//   「**数据落点越界**：3 处 path 字段的默认值落在安装目录内
//     （`TEAM_HUB_DB=team-hub/team.db` + whiteboard 三处）。安装目录会被
//     升级覆盖 → 需用 `DataDir` 承接（`PRT-505` / `PRT-257` 输入）。」
//
// spec §7 line 610：
//
//   「所有迁移必须幂等，旧数据库升级前自动备份。」
//
// Launcher 已经做到"**以后**写在 DataDir 下"（`DATA_PATH_ENV` + `envFor()`）。
// 本模块补的是**同一件事的另一半**：
//
//   > 「写路径已经指向 DataDir」与「DataDir 里已经有那些数据」
//   > 是两件不同的事——前者做到了，后者没做，于是切换之后界面是空的，
//   > 而日志里没有任何一条说"我少读了什么"。
//
// ## 一、为什么是**拷贝**而不是"让进程继续读旧路径"
//
// 让 team-hub 继续读 `<installDir>/team-hub/team.db` 看起来更简单，但它把
// 一处**必然发生**的故障往后推：安装目录在升级时被原子替换（spec §9.4），
// 那一刻数据目录连同库一起没了。数据必须落在"升级不会碰"的地方，
// 而 DataDir 就是那个地方——这也是 §6.10「不得把安装目录当作可写业务数据目录」
// 的同一句话。
//
// ## 二、★ WAL：只拷 `team.db` 会**静默丢数据**
//
// SQLite 的 WAL 模式下，已提交但尚未 checkpoint 的事务**只存在于 `-wal` 文件里**。
// 实测本机那份旧库：`team.db` 11.6 MB，而 `team.db-wal` **4.3 MB**。
// 于是"把 team.db 拷过去"会得到一个**能打开、能查询、schema 齐全、
// 却少了 4.3 MB 已提交数据**的库——
//
//   > 一个"拷了主文件、丢了 WAL"的接管，
//   > 与一个"数据本来就只有这么多"的接管，在**新库能正常打开**这个读数上
//   > 是同一个东西——只不过前者少掉的那部分数据，用户要到某一天才发现，
//   > 而且那时已经无法判断是没拷过来还是本来就没有。
//
// 所以本模块**不用文件拷贝**处理 SQLite，而是用 `VACUUM INTO`：
// 它由数据库自己产出一份**一致的**快照（含 WAL 里已提交的内容），
// 且**要求目标不存在**（目标已存在会报错）——幂等性因此不是靠我们记得检查，
// 而是 SQLite 自己保证的。
//
// ## 三、旧库仍在被写时怎么办
//
// 用户正在跑的旧 team-hub（`team-hub/server.mjs`）**正在写**那份库。
// 本模块**不去停它、不去 checkpoint 它、不删它**（本批的硬约束：
// 不改动旧路径的运行状态）。`VACUUM INTO` 读的是一个一致快照，
// 对正在写的库是安全的；读不到时（被独占锁住）**具名拒绝**，不猜。
//
// ## 四、四个不变量
//
//   1. **不覆盖**：目标已存在 ⇒ 跳过（`TARGET_EXISTS`），永不算失败。
//      接管只能发生一次，第二次运行必须是**空操作**。
//   2. **不删除来源**：源库原样留下。它同时就是 spec line 610 要的
//      "升级前自动备份"——把来源删掉等于把唯一的回退路径删掉。
//   3. **写不落在安装目录内**：目标路径必须通过 `isPathInside` 检查
//      （与 `layoutDiagnostics()` 同一条不变量）。
//   4. **来源不存在不是错误**：没见过旧库的新装机，四个来源**全都**不存在，
//      那是正常情况，不是"接管失败"。
// ============================================================================

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { isPathInside, normalizePath, pathApi, samePath } from '../paths.mjs'

/** 本模块的契约版本。 */
export const ADOPTION_VERSION = 'legion/legacy-data-adoption@1'

/**
 * 一次接管的**结论**。四态，缺一不可。
 *
 * `nothing` 与 `already` 的区别是**时间**：前者是"从来没有旧数据"，
 * 后者是"上次已经接过了"。它们的运维含义完全不同（一个是新装机，
 * 一个是重跑），而它们在"这次没有拷任何东西"这个读数上是同一个东西。
 */
export const ADOPTION_STATES = Object.freeze({
  /** 没有任何来源存在——新装机，正常。 */
  NOTHING: 'nothing-to-adopt',
  /** 这次真的拷了。 */
  ADOPTED: 'adopted',
  /** 目标已存在，这次什么都没做。 */
  ALREADY: 'already-adopted',
  /** 有来源、但接管被**拒绝**（需要人处置）。 */
  REFUSED: 'refused',
  /** 真的试了、真的失败了。 */
  FAILED: 'failed',
})

/** 每一项的具名码。 */
export const ADOPTION_CODES = Object.freeze({
  /** 来源不存在：跳过。**不是**错误。 */
  SOURCE_MISSING: 'ADOPTION_SOURCE_MISSING',
  /** 目标已存在：跳过。**不是**错误（幂等）。 */
  TARGET_EXISTS: 'ADOPTION_TARGET_EXISTS',
  /** 来源存在但打不开（被独占锁 / 不是数据库 / 权限）。 */
  SOURCE_UNREADABLE: 'ADOPTION_SOURCE_UNREADABLE',
  /** 拷贝/产出快照失败。 */
  COPY_FAILED: 'ADOPTION_COPY_FAILED',
  /** 拷完了但新库验不过（打不开 / integrity_check 不是 ok）。 */
  VERIFY_FAILED: 'ADOPTION_VERIFY_FAILED',
  /** 没有 DataDir，无处可接。 */
  NO_DATA_DIR: 'ADOPTION_NO_DATA_DIR',
  /** 目标路径落在安装目录内——与 §6.10 的不变量冲突。 */
  TARGET_INSIDE_INSTALL: 'ADOPTION_TARGET_INSIDE_INSTALL',
})

/** 一套数据落点的 `kind`：SQLite 库走快照，目录走递归拷贝。 */
export const ADOPTION_KINDS = Object.freeze({ SQLITE: 'sqlite', TREE: 'tree' })

/** 一个片段的 `kind` 由后缀决定——不另立一张清单（清单会漂移）。 */
export function kindOfFragment(fragment) {
  return /\.db$/i.test(String(fragment)) ? ADOPTION_KINDS.SQLITE : ADOPTION_KINDS.TREE
}

/**
 * 把「进程 → 数据写路径环境变量」映射展开成**逐项**的接管计划输入。
 *
 * ★ 这里的映射**由调用方注入**（生产是 `launcher.mjs` 的 `DATA_PATH_ENV`），
 *   本模块**不自己再写一份**。理由与 `topology-inventory.mjs` 那句逐字相同：
 *
 *   > 两份手写的清单必然漂移，而漂移的表现是"清单说已由 DataDir 承接、
 *   > 而接管路径其实没有"——那正是本模块要修的那个缺口的形状。
 *
 * **旧的落点由同一份映射推出来**：每个片段的旧默认值就在**安装目录**下的
 * 同一相对位置（`launcher.mjs:108-110` 原文：「这些键的**代码默认值落在
 * 安装目录内**」）。所以 `dataDir/team-hub/team.db` 的旧落点是
 * `installDir/team-hub/team.db`——**同一条片段**，不需要第二张表。
 *
 * @param {{ dataPathEnv: Record<string, Record<string, string>>, processes?: Iterable<string>|null }} args
 * @returns {ReadonlyArray<{process: string, env: string, fragment: string, kind: string}>}
 */
export function adoptionItems({ dataPathEnv, processes = null }) {
  // ★ `processes` 是**受限启动范围**（`--include`）。语义：
  //   **只为这次真的要启动的进程接管它的数据。**
  //
  //   这不是优化，是正确性。否则 `--include=runtime` 那种"我只想试试把 DSH
  //   起起来"的启动会顺手把 team-hub 的库接走——而接管是**一次性的快照**
  //   （目标存在即永远跳过），于是那次试运行把唯一一次接管机会用掉了，
  //   而且是在旧 hub 还在写那个库的时候。
  //
  //   `null` 表示"不设范围"（全量），与"空集合"是两件事：
  //   前者是"没告诉我要启动哪些"，后者是"一个都不启动"。
  const scope = processes === null || processes === undefined ? null : new Set(processes)
  const items = []
  for (const [process, mapping] of Object.entries(dataPathEnv ?? {})) {
    if (scope !== null && !scope.has(process)) continue
    for (const [env, fragment] of Object.entries(mapping)) {
      items.push(Object.freeze({ process, env, fragment, kind: kindOfFragment(fragment) }))
    }
  }
  return Object.freeze(items)
}

/** 逐项解析出源/目标绝对路径。 */
export function adoptionPathsFor({ layout, item, platform = layout?.platform ?? process.platform }) {
  const api = pathApi(platform)
  const rel = item.fragment.split('/')
  return Object.freeze({
    source: api.join(layout?.installDir ?? '', ...rel),
    target: api.join(layout?.dataDir ?? '', ...rel),
  })
}

function verdictOf(item, code, message, extra = {}) {
  return Object.freeze({ ...item, code, message, ...extra })
}

/**
 * **纯计划**：只看文件系统事实，不做任何写入。
 *
 * 判据必须能在"不真的拷一份库"的前提下断言——否则接管这件事只有在
 * 有一份真旧库的机器上才验得了，而那不是 CI。
 *
 * @param {object} args
 * @param {object} args.layout
 * @param {Record<string, Record<string, string>>} args.dataPathEnv
 * @param {(p: string) => boolean} [args.exists]
 * @returns {{ok: boolean, items: ReadonlyArray<object>, counts: object}}
 */
export function planAdoption({ layout, dataPathEnv, processes = null, exists = existsSync } = {}) {
  const platform = layout?.platform ?? process.platform
  const items = []
  const dataDir = layout?.dataDir ?? null

  for (const item of adoptionItems({ dataPathEnv, processes })) {
    const { source, target } = adoptionPathsFor({ layout, item, platform })

    if (typeof dataDir !== 'string' || dataDir === '') {
      items.push(verdictOf(item, ADOPTION_CODES.NO_DATA_DIR,
        `没有 DataDir，无法接管 ${item.process} 的 ${item.env}。`))
      continue
    }
    // ★ 不变量：写不得落在安装目录内（与 `layoutDiagnostics()` 同一条）。
    if (isPathInside(layout.installDir, target, platform)) {
      items.push(verdictOf(item, ADOPTION_CODES.TARGET_INSIDE_INSTALL,
        `接管目标落在安装目录内（${target}）——安装目录会被升级覆盖，写在那里等于没接管。`))
      continue
    }
    if (!exists(source)) {
      items.push(verdictOf(item, ADOPTION_CODES.SOURCE_MISSING,
        `安装目录里没有 ${item.fragment}，无需接管。`, { state: ADOPTION_STATES.NOTHING }))
      continue
    }
    if (exists(target)) {
      items.push(verdictOf(item, ADOPTION_CODES.TARGET_EXISTS,
        `DataDir 里已经有 ${item.fragment}，**不覆盖**（接管只能发生一次）。`,
        { state: ADOPTION_STATES.ALREADY, source, target }))
      continue
    }
    // ★ WAL 是**信息**，不是错误：`VACUUM INTO` 会把它一起带过去，
    //   而"只拷主文件"的实现不会——那正是要防的那件事，所以把它报出来。
    const walPresent = item.kind === ADOPTION_KINDS.SQLITE && exists(`${source}-wal`)
    items.push(verdictOf(item, null, walPresent
      ? `可以接管：${item.fragment}（含未 checkpoint 的 WAL——用快照产出，不拷主文件）。`
      : `可以接管：${item.fragment}。`,
    { state: ADOPTION_STATES.ADOPTED, source, target, walPresent }))
  }

  const counts = {
    adoptable: items.filter((i) => i.state === ADOPTION_STATES.ADOPTED).length,
    already: items.filter((i) => i.state === ADOPTION_STATES.ALREADY).length,
    nothing: items.filter((i) => i.state === ADOPTION_STATES.NOTHING).length,
    refused: items.filter((i) => i.state === undefined).length,
  }
  return Object.freeze({
    ok: counts.refused === 0,
    items: Object.freeze(items),
    counts: Object.freeze(counts),
  })
}

/**
 * SQLite：用 `VACUUM INTO` 产出一份**一致**快照。
 *
 * 为什么不是 `copyFileSync`：见文件头第二节。一句话——
 * 主文件里没有 WAL 里已提交的那部分，而拷出来的库**照样能打开**。
 *
 * 为什么不是 `db.backup()`：`node:sqlite` 的 `backup()` 在目标 Node 版本上
 * 不一定存在，而 `VACUUM INTO` 是 SQL 层的、自 SQLite 3.27 起就有。
 * 依赖一个语言绑定里"恰好有这个函数"，与依赖一条 SQL 语句，前者的可用面
 * 小得多——而这条链要能在一台只有 Node 的机器上跑通。
 *
 * @returns {{ok: boolean, code: string|null, message: string|null}}
 */
export function snapshotSqlite({ source, target, openDatabase, busyTimeoutMs = 5000 }) {
  let db = null
  try {
    db = openDatabase(source, { readOnly: true })
  } catch (error) {
    return {
      ok: false,
      code: ADOPTION_CODES.SOURCE_UNREADABLE,
      message: `打不开旧库 ${source}：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  try {
    // 正在被写的库会遇到锁；给一个短预算然后**具名拒绝**，不无限等
    // （一个没有上限的等待在用户那里表现为"卡住了"，那是比失败更坏的读数）。
    try { db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)}`) } catch { /* 可选 */ }
    // ★ 参数不能绑到 `VACUUM INTO` 的目标上（SQLite 只接受字面量），
    //   所以这里只能拼字符串——于是**必须**自己转义单引号。
    //   一个不转义的拼接在路径含 `'` 时会变成语法错误或（更坏）写错地方。
    const targetLiteral = String(target).replace(/'/g, "''")
    db.exec(`VACUUM INTO '${targetLiteral}'`)
    return { ok: true, code: null, message: null }
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    const locked = /busy|locked/i.test(raw)
    return {
      ok: false,
      code: locked ? ADOPTION_CODES.SOURCE_UNREADABLE : ADOPTION_CODES.COPY_FAILED,
      message: locked
        ? `旧库正被占用（${raw}）——它可能正被另一个 team-hub 实例打开。`
          + `接管是只读快照，不需要停服务；但需要那一刻**不是**独占锁。`
        : `从 ${source} 产出快照失败：${raw}`,
    }
  } finally {
    try { db?.close() } catch { /* 关不上不该盖住真正的结论 */ }
  }
}

/** 产出的库能不能用：打得开、且 `integrity_check` 是 `ok`。 */
export function verifySqlite({ target, openDatabase }) {
  let db = null
  try {
    db = openDatabase(target, { readOnly: true })
  } catch (error) {
    return {
      ok: false,
      message: `接管后的库打不开：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  try {
    const row = db.prepare('PRAGMA integrity_check').get()
    const value = row === undefined || row === null ? null : Object.values(row)[0]
    if (value !== 'ok') return { ok: false, message: `integrity_check = ${String(value)}` }
    return { ok: true, message: null }
  } catch (error) {
    return {
      ok: false,
      message: `检不出接管后的库：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    try { db?.close() } catch { /* 同上 */ }
  }
}

/** 目录：递归拷贝（白板房间目录/审计目录）。 */
export function copyTree({ source, target, fs = { existsSync, mkdirSync, readdirSync, copyFileSync, statSync } }) {
  try {
    fs.mkdirSync(target, { recursive: true })
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const from = join(source, entry.name)
      const to = join(target, entry.name)
      if (entry.isDirectory()) {
        const nested = copyTree({ source: from, target: to, fs })
        if (!nested.ok) return nested
      } else {
        fs.copyFileSync(from, to)
      }
    }
    return { ok: true, code: null, message: null }
  } catch (error) {
    return {
      ok: false,
      code: ADOPTION_CODES.COPY_FAILED,
      message: `拷贝目录 ${source} 失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * 真的执行接管。
 *
 * `openDatabase` 默认惰性加载 `node:sqlite`——**不在模块顶层 import**：
 * 那份内建模块在 Node 22 之前不存在，而本模块在 `--check` / 计划路径上
 * 也要能被加载（"加载即崩"会让"没有旧库"这件事长得像"接管功能坏了"）。
 *
 * `processes` 是受限启动范围（`--include`），见 `adoptionItems()`。
 */
export async function adoptLegacyData({
  layout,
  dataPathEnv,
  processes = null,
  plan = null,
  openDatabase = null,
  fs = null,
  log = null,
} = {}) {
  const resolvedPlan = plan ?? planAdoption({
    layout, dataPathEnv, processes, exists: fs?.existsSync ?? existsSync,
  })
  const results = []
  const dataDir = layout?.dataDir ?? null

  const opener = openDatabase ?? (await defaultOpenDatabase())
  if (opener === null) {
    return Object.freeze({
      ok: false,
      state: ADOPTION_STATES.FAILED,
      items: Object.freeze([Object.freeze({
        code: ADOPTION_CODES.COPY_FAILED,
        message: '本机 Node 没有 `node:sqlite`（需要 22+），无法安全接管 SQLite 旧库；'
          + '**不会**退化成文件拷贝——那会静默丢掉 WAL 里已提交的数据。',
      })]),
    })
  }
  if (typeof dataDir === 'string' && dataDir !== '') {
    try { mkdirSync(join(dataDir), { recursive: true }) } catch { /* 下面按项报 */ }
  }

  for (const item of resolvedPlan.items) {
    if (item.code !== null) {
      // 跳过/拒绝：原样带过，不算失败（拒绝已在 plan.ok 里体现）。
      results.push(item)
      continue
    }
    const { source, target } = item
    const parent = target.slice(0, Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\')))
    try { mkdirSync(parent === '' ? dataDir : parent, { recursive: true }) } catch { /* 按项报 */ }

    const outcome = item.kind === ADOPTION_KINDS.SQLITE
      ? snapshotSqlite({ source, target, openDatabase: opener })
      : copyTree({ source, target, fs: fs ?? undefined })

    if (!outcome.ok) {
      const failed = Object.freeze({
        ...item, code: outcome.code, message: outcome.message, state: ADOPTION_STATES.FAILED,
      })
      results.push(failed)
      log?.('error', `接管失败：${item.fragment} —— ${outcome.message}`)
      continue
    }

    if (item.kind === ADOPTION_KINDS.SQLITE) {
      const verify = verifySqlite({ target, openDatabase: opener })
      if (!verify.ok) {
        results.push(Object.freeze({
          ...item,
          code: ADOPTION_CODES.VERIFY_FAILED,
          message: `${item.fragment} 拷过去了但验不过：${verify.message}`,
          state: ADOPTION_STATES.FAILED,
        }))
        log?.('error', `接管后校验失败：${item.fragment} —— ${verify.message}`)
        continue
      }
    }

    results.push(Object.freeze({ ...item, state: ADOPTION_STATES.ADOPTED }))
    log?.('info', `已接管 ${item.fragment}：${source} → ${target}${item.walPresent ? '（含 WAL）' : ''}`)
  }

  const counts = {
    // 成功的那些：`code` 仍是 `null` 且结论是 `adopted`。
    // 失败的会被写上非空 `code`，所以这一条不会把失败算成成功。
    adopted: results.filter((r) => r.code === null && r.state === ADOPTION_STATES.ADOPTED).length,
    already: results.filter((r) => r.code === ADOPTION_CODES.TARGET_EXISTS).length,
    nothing: results.filter((r) => r.code === ADOPTION_CODES.SOURCE_MISSING).length,
    failed: results.filter((r) => r.state === ADOPTION_STATES.FAILED).length,
    refused: results.filter((r) => r.code === ADOPTION_CODES.NO_DATA_DIR
      || r.code === ADOPTION_CODES.TARGET_INSIDE_INSTALL).length,
  }
  const state = counts.failed > 0
    ? ADOPTION_STATES.FAILED
    : counts.refused > 0
      ? ADOPTION_STATES.REFUSED
      : counts.adopted > 0
        ? ADOPTION_STATES.ADOPTED
        : counts.already > 0
          ? ADOPTION_STATES.ALREADY
          : ADOPTION_STATES.NOTHING

  return Object.freeze({
    ok: counts.failed === 0 && counts.refused === 0,
    state,
    items: Object.freeze(results),
    counts: Object.freeze(counts),
  })
}

/** 惰性加载 `node:sqlite`；没有就返回 `null`（**不抛**）。 */
async function defaultOpenDatabase() {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    return (file, options = {}) => new DatabaseSync(file, options)
  } catch {
    return null
  }
}

/**
 * 同一目录的**旧**位置是否与**新**位置是同一个文件——
 * 给"用户把 DataDir 指到了安装目录"这种布置用。
 *
 * 它存在的理由：那种布置下 `planAdoption()` 会判"可以接管"，
 * 而 `VACUUM INTO` 会拒绝（目标就是来源）。与其让 SQLite 报一句
 * 难懂的话，不如在这里先具名说清。
 */
export function pathsAreSameFile({ layout, item, platform = layout?.platform ?? process.platform }) {
  const { source, target } = adoptionPathsFor({ layout, item, platform })
  return samePath(normalizePath(source, platform), normalizePath(target, platform), platform)
}

/** 装载期自检：算出来的产物，不是一个布尔。 */
function selfCheckAdoption() {
  const layout = { installDir: '/opt/legion', dataDir: '/home/u/.legion/data', platform: 'linux' }
  const dataPathEnv = { 'team-hub': { TEAM_HUB_DB: 'team-hub/team.db' } }

  // ① 旧的落点由**同一片段**推到安装目录下（不另立清单）
  const item = adoptionItems({ dataPathEnv })[0]
  const { source, target } = adoptionPathsFor({ layout, item })
  if (source !== '/opt/legion/team-hub/team.db') throw new Error(`旧落点推错：${source}`)
  if (target !== '/home/u/.legion/data/team-hub/team.db') throw new Error(`新落点推错：${target}`)

  // ② 后缀决定 kind
  if (kindOfFragment('team-hub/team.db') !== ADOPTION_KINDS.SQLITE) throw new Error('kind 判错：sqlite')
  if (kindOfFragment('whiteboard/rooms') !== ADOPTION_KINDS.TREE) throw new Error('kind 判错：tree')

  // ③ 三态各自可达，且**来源不存在不是拒绝**
  const nothing = planAdoption({ layout, dataPathEnv, exists: () => false })
  if (nothing.items[0].code !== ADOPTION_CODES.SOURCE_MISSING) throw new Error('缺来源没判成 SOURCE_MISSING')
  if (nothing.ok !== true) throw new Error('缺来源被判成了"不可接管"')

  const already = planAdoption({ layout, dataPathEnv, exists: () => true })
  if (already.items[0].code !== ADOPTION_CODES.TARGET_EXISTS) throw new Error('目标已存在没判成 TARGET_EXISTS')
  if (already.ok !== true) throw new Error('目标已存在被判成了"不可接管"')

  const adoptable = planAdoption({
    layout, dataPathEnv, exists: (p) => p === '/opt/legion/team-hub/team.db',
  })
  if (adoptable.items[0].state !== ADOPTION_STATES.ADOPTED) throw new Error('可接管没判成 ADOPTED')

  // ④ 没有 DataDir 是**拒绝**（有来源却无处可接）
  const noData = planAdoption({
    layout: { ...layout, dataDir: null }, dataPathEnv,
    exists: (p) => p === '/opt/legion/team-hub/team.db',
  })
  if (noData.ok !== false) throw new Error('没有 DataDir 却没判成不可接管')

  // ⑤ 写落在安装目录内是**拒绝**（§6.10 不变量）
  const inside = planAdoption({
    layout: { installDir: '/opt/legion', dataDir: '/opt/legion/data', platform: 'linux' }, dataPathEnv,
    exists: (p) => p === '/opt/legion/team-hub/team.db',
  })
  if (inside.items[0].code !== ADOPTION_CODES.TARGET_INSIDE_INSTALL) {
    throw new Error('目标落在安装目录内却没拒绝')
  }

  return Object.freeze({
    version: ADOPTION_VERSION,
    itemsPerProcess: adoptionItems({ dataPathEnv }).length,
    states: Object.values(ADOPTION_STATES).length,
    checked: 'plan 三态 + 两种拒绝',
  })
}

export const ADOPTION_CHECKED = selfCheckAdoption()
