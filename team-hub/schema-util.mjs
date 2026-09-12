// team-hub/schema-util.mjs
// ============================================================================
// 启动期迁移的最小工具（PRT-314 / PRT-316）
//
// 为什么它值得单独一个模块：这是**两个进程并发启动、同时打开同一个库**时
// 唯一一处「检查 + 变更」必须原子的地方。这一段逻辑的正确性不靠调用方自觉，
// 而它此前在 server.mjs 里是一份内联实现，运行面仓储又照抄了一份非原子的——
// 一份微妙的并发原语存在两份实现时，其中一份迟早会腐烂，
// 而腐烂的表现是「其中一个进程在模块加载期崩溃」，看起来与迁移毫无关系。
//
// 为什么 `ensureColumn` 必须是原子的：
//
// 本仓库的既有部署形态是**两进程同时打开同一个库**（8787 独立进程 + 3080 宿主 v2 外壳），
// 两者启动时并发跑同一批迁移。`PRAGMA table_info` 与 `ALTER TABLE` 之间没有互斥，
// 两个进程都会读到「列不存在」，于是都执行 ALTER —— 后者拿到
// `SQLite error: duplicate column name: xxx`（真实复现：同时启动两个 server.mjs
// 指向同一新库，其中一个在模块加载期即崩溃退出；宿主侧表现为 /team-hub 路由缺失
// 并打一条加载失败日志，直到重启）。
//
// 做法：在 `BEGIN IMMEDIATE` 里**重读一次**列名再决定是否 ALTER。
// IMMEDIATE 直接取写锁（不走 DEFERRED 的读→升写路径，避免并发下的锁升级死锁），
// 把「检查 + 变更」变成原子操作。拿不到写锁时最多等待 busy_timeout，
// 超时会抛错：这是既有语义（迁移失败不静默继续）。
//
// 用法：本模块的函数都**接收 db 参数**，不自持连接——运行面仓储与 server
// 各有自己的 DatabaseSync 实例（同一进程内也可以是同一个），
// 持有连接会把这个纯工具变成又一个隐式单例。
// ============================================================================

/**
 * 某张表有没有这一列。
 *
 * 表不存在时返回 false（`PRAGMA table_info` 对不存在的表返回空集）——
 * 这正好是调用方想要的语义：「还没有这一列，该加」。
 */
export function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)
}

/**
 * 缺列才补列（幂等 + 并发安全）。
 *
 * 已经是目标状态时**不开事务**——启动期绝大多数调用都属于这种情况，
 * 为一次读就取写锁会让两个进程的启动互相排队（实测能感觉到启动变慢）。
 */
export function ensureColumn(db, table, column, ddl) {
  if (columnExists(db, table, column)) return false
  db.exec('BEGIN IMMEDIATE')
  try {
    if (!columnExists(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
    db.exec('COMMIT')
    return true
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    // 另一进程可能在等待写锁期间已完成同一列：重读确认，已存在即视为成功（迁移幂等）
    if (columnExists(db, table, column)) return false
    throw e
  }
}
