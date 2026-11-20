#!/usr/bin/env node
/**
 * 存量「孤儿空间」补授权：给**一条角色行都没有**的空间指定一个 owner。
 *
 * ## 为什么需要它（BUG-048 的另一半）
 *
 * BUG-048 修的是**未来**：新建空间时把它登记到创建者名下（见 `server.mjs` 的
 * `grantSpaceCreator`）。但**已经建出来的**那些空间不会被那次修法碰到 ——
 * `POST /api/spaces` 的历史调用没有留下"谁建的"这个事实
 * （审计里 `space:create` 的 `member` 是 `general` 这个操作者名，不是 userId），
 * 所以"谁该拿到 owner"**只能由人来指定**，猜是错的：
 *
 *   > 一个按"看起来像谁建的"去补授权的脚本，
 *   > 与一个"把别人的空间送出去"的脚本，只差一次猜错。
 *
 * 所以本脚本**不猜**：它只做三件事 —— ① 列出孤儿空间（只读，默认行为）；
 * ② 在你**具名指定**用户之后，把那些空间授成他的 owner；③ 每一步都留审计。
 *
 * ## 现场（2026-11-20）
 *
 * 桌面端新建「🏠 本地/私有空间」（id=`personal-profile`，「个人履历」）得到 200，
 * 随后界面按新 scope 读任务，屏幕上是一行
 * `读取失败：403：无权访问空间「personal-profile」`。
 * 同一天之前建的 `nantai`、以及更早的 `default` 也是同样的孤儿状态。
 *
 * ## 用法
 *
 *   node team-hub/scripts/grant-orphan-spaces.mjs                          # 只读：列出孤儿空间
 *   node team-hub/scripts/grant-orphan-spaces.mjs --user general           # 只读：连"会授给谁"一起算出来
 *   node team-hub/scripts/grant-orphan-spaces.mjs --user general --apply   # 真写：授 owner + 审计
 *
 * `--db=<path>` 可指定库（缺省 `TEAM_HUB_DB`，再缺省 `team-hub/team.db`，与 hub 同一条口径）。
 * **默认不写**：`--apply` 是唯一会改库的开关 —— 与 `BUG-004-apply-fix.mjs` 同一条纪律
 * （先 `--dry-run` 复核再执行）。
 *
 * ## 幂等
 *
 * 判定是"这个空间**一条角色行都没有**"，而授予之后它就有了一条 ——
 * 所以重复跑第二次时那些空间**不再出现在计划里**，一行都不写（可反复运行）。
 * 已经有任何角色的空间**一律不动**：那不是孤儿，那是别人的空间。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 与 hub 同一条口径：`TEAM_HUB_DB` → 仓库内 `team-hub/team.db`。 */
export function resolveDbPath(env = process.env) {
  const fromEnv = String(env.TEAM_HUB_DB ?? '').trim()
  if (fromEnv.length > 0) return resolve(fromEnv)
  return resolve(join(HERE, '..', 'team.db'))
}

/** 纯函数：解析命令行。默认只读；只有 `--apply` 才写库。 */
export function parseArgs(argv = []) {
  const userArg = argv.find((a) => a.startsWith('--user='))
  const dbArg = argv.find((a) => a.startsWith('--db='))
  const userAt = argv.indexOf('--user')
  return {
    apply: argv.includes('--apply'),
    user: userArg
      ? userArg.slice('--user='.length).trim() || null
      : (userAt >= 0 ? String(argv[userAt + 1] ?? '').trim() || null : null),
    dbPath: dbArg ? dbArg.slice('--db='.length).trim() || null : null,
    help: argv.includes('--help') || argv.includes('-h'),
  }
}

/**
 * 算计划（**纯读**，不写库）。
 *
 * 返回 `{ orphans, user, plan, error }`：
 *   · `orphans` —— 一条角色行都没有的空间（含它当前的名字/是否私有，供人核对）；
 *   · `user` —— `--user` 指向的那个账号（没给 / 找不到时为 `null`，并给 `error`）；
 *   · `plan` —— 将要写的 `{ space, userId, role }` 列表（`user` 缺失时为空）。
 */
export function planOrphanGrants(db, { userName = null } = {}) {
  const orphans = db.prepare(`
    SELECT s.id, s.name, s.private, s.local_dir
      FROM spaces s
     WHERE NOT EXISTS (SELECT 1 FROM hub_space_roles r WHERE r.space = s.id)
     ORDER BY s.id
  `).all().map((r) => ({ id: r.id, name: r.name, private: r.private === 1, localDir: r.local_dir ?? '' }))

  if (userName === null) return { orphans, user: null, plan: [], error: null }

  // 与登录同一条归一（`user-store.mjs` 的 `nameKey` = trim 后 toLowerCase）。
  const key = String(userName).trim().toLowerCase()
  const rows = db.prepare('SELECT id, name, system_role, disabled_at_ms FROM hub_users WHERE name_key = ?').all(key)
  if (rows.length === 0) return { orphans, user: null, plan: [], error: `找不到用户「${userName}」（hub_users 按 name_key 查无此人）` }
  if (rows.length > 1) return { orphans, user: null, plan: [], error: `用户名「${userName}」不唯一（${rows.length} 条）——拒绝猜测` }
  const row = rows[0]
  if (row.disabled_at_ms !== null) return { orphans, user: null, plan: [], error: `用户「${userName}」已停用，不授予` }
  return {
    orphans,
    user: { id: row.id, name: row.name, systemRole: row.system_role },
    plan: orphans.map((s) => ({ space: s.id, userId: row.id, role: 'owner' })),
    error: null,
  }
}

/**
 * 执行计划（**唯一会写库**的入口）：角色行 + 审计行同一个事务。
 *
 * 审计的形状与 `grantSpaceRole({ by: null })` 完全一致（`identity:grant-role`，
 * `member` = `system`，`detail.userId` = 被授权人），这样在审计里
 * "自动授予"与"这次补授权"讲的是同一句话，读审计的人不用分辨两套格式。
 */
export function applyOrphanGrants(db, plan, { now = () => new Date().toISOString() } = {}) {
  if (plan.length === 0) return { granted: 0, spaces: [] }
  const insertRole = db.prepare(`INSERT INTO hub_space_roles (user_id, space, role, granted_by, granted_at_ms)
    VALUES (?, ?, ?, 'system', ?)
    ON CONFLICT(user_id, space) DO UPDATE SET role=excluded.role, granted_by=excluded.granted_by, granted_at_ms=excluded.granted_at_ms`)
  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM audit')
  const insertAudit = db.prepare('INSERT INTO audit (seq, ts, member, scope, action, taskId, detail, goalId) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)')

  db.exec('BEGIN IMMEDIATE')
  try {
    let seq = Number(maxSeq.get().m)
    const ts = now()
    for (const item of plan) {
      insertRole.run(item.userId, item.space, item.role, Date.parse(ts))
      seq += 1
      insertAudit.run(seq, ts, 'system', item.space, 'identity:grant-role',
        JSON.stringify({ userId: item.userId, role: item.role, via: 'grant-orphan-spaces' }))
    }
    db.exec('COMMIT')
    return { granted: plan.length, spaces: plan.map((p) => p.space) }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
}

/** 把计划打成人能读的几行（只读路径与真写路径共用同一份措辞）。 */
export function formatPlan(result, { apply = false, dbPath = '' } = {}) {
  const lines = []
  lines.push(`库：${dbPath}`)
  if (result.orphans.length === 0) {
    lines.push('孤儿空间：无（每个空间都至少有一条角色行）—— 不需要补授权。')
    return lines
  }
  lines.push(`孤儿空间：${result.orphans.length} 个（一条角色行都没有 ⇒ 对**所有人**都是 403）`)
  for (const s of result.orphans) {
    lines.push(`  · ${s.id}　「${s.name}」${s.private ? '（本地/私有）' : ''}${s.localDir ? `　localDir=${s.localDir}` : ''}`)
  }
  if (result.error !== null) {
    lines.push(`✗ ${result.error}`)
    return lines
  }
  if (result.user === null) {
    lines.push('未指定 --user：上面只做了**只读**盘点。补授权要显式指名一个账号：')
    lines.push('  node team-hub/scripts/grant-orphan-spaces.mjs --user <用户名>   # 先看会写什么')
    lines.push('  node team-hub/scripts/grant-orphan-spaces.mjs --user <用户名> --apply')
    return lines
  }
  lines.push(`将授予：${result.user.name}（${result.user.id}，系统角色 ${result.user.systemRole}）→ 以下空间的 owner`)
  for (const p of result.plan) lines.push(`  · ${p.space} → ${p.role}`)
  lines.push(apply ? '以上已写入（含审计）。' : '以上**未写入**。确认无误后加 --apply。')
  return lines
}

function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log('用法: node team-hub/scripts/grant-orphan-spaces.mjs [--user <用户名>] [--apply] [--db=<path>]')
    return 0
  }
  const dbPath = args.dbPath ? resolve(args.dbPath) : resolveDbPath()
  if (!existsSync(dbPath)) {
    console.error(`✗ 库不存在：${dbPath}（用 --db= 或 TEAM_HUB_DB 指定）`)
    return 1
  }
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const result = planOrphanGrants(db, { userName: args.user })
    for (const line of formatPlan(result, { apply: args.apply, dbPath })) console.log(line)
    if (result.error !== null) return 1
    if (args.apply !== true) return 0
    if (result.user === null) {
      console.error('✗ --apply 必须同时给 --user（不指定就把空间送出去，等于猜）')
      return 1
    }
    const done = applyOrphanGrants(db, result.plan)
    console.log(`✓ 已授予 ${done.granted} 个空间（${done.spaces.join(', ')}）`)
    return 0
  } finally {
    try { db.close() } catch { /* 已关 */ }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
