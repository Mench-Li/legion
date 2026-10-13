#!/usr/bin/env node
/**
 * 头像迁移：把编队里**还不是 `human:<key>` 令牌**的头像就地迁成合法令牌。
 *
 * 用法：
 *   node team-hub/scripts/migrate-avatars.mjs              # 全库
 *   node team-hub/scripts/migrate-avatars.mjs --scope=ozon # 只迁一个空间
 *   node team-hub/scripts/migrate-avatars.mjs --dry        # 只报会改什么，不写库
 *
 * ## 为什么单独一个脚本，而不是并进 `seed-roster.mjs`
 *
 * 两者覆盖的**行集不同**：
 *   · `seed-roster` 只认 5 个内置空间的 25 个内置岗位（它还负责两段式展示名）；
 *   · 本脚本认**所有** scope 的所有行 —— 自建/空间专属 role（ozon 的 `soldier-*`、
 *     gf001 的 `implementer`）不在种子名单里，只有 `allocateAvatarToken` 能给出位面。
 *
 * 合并会让"跑种子"变成一件会顺手改动 ozon 编队的事，而那不是 seed 的职责。
 *
 * ## 为什么需要它（这次的真实故障）
 *
 * 头像渲染只认 `human:<key>`；旧 emoji 一律落到**同一个灰阶占位人形**。
 * 功能上线时库里 24 行**全是 emoji** ⇒ 8 个 Agent 显示同一个灰色剪影 ⇒
 * 用户看到的结论是"这个功能没做"。而渲染层的"优雅回退"**不会写回数据**，
 * 所以没有任何东西会自愈：必须有人显式跑一次。
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { db as defaultDb } from '../server.mjs'
import { migrateRosterAvatars, planRosterAvatarMigration } from '../agent-avatars.mjs'
import { ROSTER_NAMES, LEGACY_NAMES } from './seed-roster.mjs'

/** 纯函数：解析命令行。`--dry` 只报告不写库；`--names` 顺带换人性化展示名。 */
export function parseArgs(argv = []) {
  const scopeArg = argv.find((a) => a.startsWith('--scope='))
  return {
    dry: argv.includes('--dry'),
    names: argv.includes('--names'),
    scope: scopeArg ? scopeArg.slice('--scope='.length).trim() || null : null,
  }
}

/** (scope, role) → 人性化展示名（来自种子表；**只查不改**）。 */
function nameFor(scope, role) {
  const list = ROSTER_NAMES[scope]
  if (!Array.isArray(list)) return null
  const hit = list.find(([r]) => r === role)
  return hit ? hit[1] : null
}

/**
 * 跑迁移并把结果打成可读文本（返回 { changed, scanned, migrated, nameChanges, lines }，供测试直调）。
 *
 * `dry` = 预演：**用与真跑同一个 planner** 算出"会改什么"，然后一个字节都不写。
 */
export function runMigration(db, { scope = null, dry = false, names = false, quiet = false } = {}) {
  const rows = scope === null
    ? db.prepare('SELECT scope, role, name, avatar FROM roster ORDER BY scope, role').all()
    : db.prepare('SELECT scope, role, name, avatar FROM roster WHERE scope = ? ORDER BY scope, role').all(scope)

  // 头像：预演与真跑同一份计划（`planRosterAvatarMigration` 是纯函数）
  const aPlan = planRosterAvatarMigration(db, { scope })
  const nameChange = names ? planNameMigration(rows) : []
  // 名字先算（纯），真跑时先写名字再写头像：两步互不依赖，但分开写让失败更容易定位。
  const result = dry
    ? { scanned: rows.length, migrated: aPlan }
    : (() => {
      if (names) applyNameMigration(db, nameChange)
      return migrateRosterAvatars(db, { scope, plan: aPlan })
    })()

  const lines = [...nameChange.map(r => `  ${r.scope}/${r.role}  名字 ${JSON.stringify(r.from)} → ${r.to}`), ...formatLines(result.migrated)]
  if (!quiet) {
    const head = dry ? '预演（--dry，未写库）' : '已写入'
    console.log(`migrate-avatars: ${head}：扫描 ${rows.length} 行，头像迁移 ${result.migrated.length} 行` +
      (names ? `，名字迁移 ${nameChange.length} 行` : ''))
    for (const l of lines) console.log(l)
  }
  return {
    changed: result.migrated.length, scanned: rows.length, migrated: result.migrated,
    nameChanges: nameChange, lines, dry,
  }
}

/**
 * 纯计算：哪些行的人性化展示名该换。
 *
 * ★ 与 `seed-roster.mjs` 的关键区别：那个函数还会 `INSERT`（并 upsert 出 marketing/product/ops
 *   三个空间 + 14 个岗位）。这里**只认已有的行、只 UPDATE**——
 *   「把名字换成人性化的」与「替我新建三个空间、安插 14 个我没要的 Agent」是两件事，
 *   后者不该由一次改名顺手带来。
 *
 * 只改**仍是旧职称名**的行（`LEGACY_NAMES` 白名单）：用户自己起过的名字原样保留（AC-R10-1）。
 */
function planNameMigration(rows) {
  const out = []
  for (const row of rows) {
    const next = nameFor(row.scope, row.role)
    if (next === null) continue
    const cur = String(row.name ?? '')
    if (cur === next) continue
    if (!LEGACY_NAMES.has(cur)) continue // 不是旧默认名 ⇒ 用户自定义，别动
    out.push({ scope: row.scope, role: row.role, from: cur, to: next })
  }
  return out
}

function applyNameMigration(db, changes) {
  const update = db.prepare('UPDATE roster SET name = ? WHERE scope = ? AND role = ?')
  for (const c of changes) update.run(c.to, c.scope, c.role)
}

function formatLines(rows) {
  return rows.map((r) => `  ${r.scope}/${r.role}  ${JSON.stringify(r.from)} → ${r.to}`)
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href : false
if (isMain) {
  const { scope, dry, names } = parseArgs(process.argv.slice(2))
  const out = runMigration(defaultDb, { scope, dry, names })
  if (out.changed === 0 && out.nameChanges.length === 0) console.log('migrate-avatars: 没有需要迁移的行（全部已是合法令牌）')
  else if (dry) console.log('（预演结束；去掉 --dry 才会真正写库）')
}
