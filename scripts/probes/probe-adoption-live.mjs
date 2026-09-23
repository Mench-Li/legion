// scripts/probes/probe-adoption-live.mjs —— 只读探针：对**真**旧库验证接管链
//
// 它做三件事，每一件都是"读"，不改动旧库、不碰正在跑的 DSH：
//   ① 列出旧库的表与行数（只读打开）
//   ② 跑生产 `adoptLegacyData()`，把库接进一个临时 DataDir
//   ③ ★ 把「朴素文件拷贝」与「VACUUM INTO 快照」**并排**比一次
//      —— 这是本模块存在的全部理由：证明"只拷 team.db 会丢数据"
//         不是一句推测，而是一个可复现的读数。
import { mkdtempSync, rmSync, copyFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = pathToFileURL('D:/project/DSH/legion/').href
const { adoptLegacyData } = await import(`${ROOT}product/launcher/legacy-data-adoption.mjs`)
const { DATA_PATH_ENV } = await import(`${ROOT}product/launcher/launcher.mjs`)

const INSTALL = 'D:\\project\\DSH\\legion'
const LEGACY = join(INSTALL, 'team-hub', 'team.db')

function counts(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map((r) => r.name)
    const out = {}
    for (const t of tables) {
      try { out[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n } catch { out[t] = 'ERR' }
    }
    return out
  } finally { db.close() }
}

// ── ① 旧库现状 ────────────────────────────────────────────────────────────
console.log('① 旧库（安装目录内，**不动它**）')
console.log(`   team.db      ${statSync(LEGACY).size} bytes`)
const wal = `${LEGACY}-wal`
console.log(`   team.db-wal  ${existsSync(wal) ? `${statSync(wal).size} bytes` : '（不存在）'}`)
const before = counts(LEGACY)
console.log(`   表 ${Object.keys(before).length} 张，行数合计 ${Object.values(before).filter((v) => typeof v === 'number').reduce((a, b) => a + b, 0)}`)

// ── ② 生产接管 ────────────────────────────────────────────────────────────
const dataDir = mkdtempSync(join(tmpdir(), 'legion-adopt-live-'))
const layout = { installDir: INSTALL, dataDir, platform: 'win32' }

const result = await adoptLegacyData({
  layout,
  dataPathEnv: DATA_PATH_ENV,
  log: (level, msg) => console.log(`   [${level}] ${msg}`),
})
console.log('\n② 生产 adoptLegacyData()')
console.log(`   state=${result.state} ok=${result.ok} counts=${JSON.stringify(result.counts)}`)

const adopted = join(dataDir, 'team-hub', 'team.db')
console.log(`   接过来的库：${existsSync(adopted) ? `${statSync(adopted).size} bytes` : '**不存在**'}`)
const after = existsSync(adopted) ? counts(adopted) : null

// ── ③ ★ 朴素拷贝 vs 快照 ──────────────────────────────────────────────────
// 这是整个缺口最要紧的一个读数：**同一个旧库**，两条路径。
const naive = join(dataDir, 'naive-copy.db')
copyFileSync(LEGACY, naive)
const naiveCounts = counts(naive)

const tables = [...new Set([...Object.keys(before), ...Object.keys(naiveCounts)])].sort()
let naiveLost = 0
let naiveSame = 0
console.log('\n③ ★ 同一个旧库，两条路径（这才是"只拷主文件"真正的代价）')
console.log(`   ${'表'.padEnd(28)} ${'旧库'.padStart(8)} ${'朴素拷贝'.padStart(10)} ${'快照'.padStart(8)}`)
for (const t of tables) {
  const b = before[t] ?? 0
  const n = naiveCounts[t] ?? 0
  const s = after?.[t] ?? 0
  if (typeof b === 'number' && typeof n === 'number' && b !== n) naiveLost += b - n
  if (typeof b === 'number' && typeof s === 'number' && b === s) naiveSame += 1
  if (b !== n || b !== s) console.log(`   ${t.padEnd(28)} ${String(b).padStart(8)} ${String(n).padStart(10)} ${String(s).padStart(8)}`)
}
const total = (m) => Object.values(m).filter((v) => typeof v === 'number').reduce((a, b) => a + b, 0)
console.log(`   合计：旧库 ${total(before)} ｜ 朴素拷贝 ${total(naiveCounts)}（**少 ${naiveLost} 行**）｜ 快照 ${total(after ?? {})}`)
console.log(`   快照与旧库**逐表相等**的表：${naiveSame}/${tables.length}`)

// ── ④ 幂等：第二次必须什么都不做 ──────────────────────────────────────────
const second = await adoptLegacyData({ layout, dataPathEnv: DATA_PATH_ENV })
console.log(`\n④ 第二次运行：state=${second.state} counts=${JSON.stringify(second.counts)}（必须是 already，不能覆盖）`)

rmSync(dataDir, { recursive: true, force: true })

const ok = result.state === 'adopted'
  && total(after ?? {}) === total(before)
  && naiveLost > 0
  && second.state === 'already-adopted'
console.log(ok ? '\n★ 整条链接通了：旧库被完整接管，且朴素拷贝确实丢数据' : '\n✖ 链路没通')
process.exit(ok ? 0 : 1)
