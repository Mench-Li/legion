// scripts/probes/_mutate-r116-xver.mjs — 破验：PRT-006 跨版本套件必须咬得住
//   M1: goal 重建时丢掉旧行（DROP 后不搬运）        ⇒ 期望"保住行数"红
//   M2: goal 重建不幂等（needsRebuild 恒 true）      ⇒ 期望"幂等"红
//   M3: 给老表加一个 NOT NULL 无默认列               ⇒ 期望"老 INSERT 真的跑一遍"红
//   M4: 删掉老代码用的一列（DROP COLUMN 语义模拟）    ⇒ 期望"每一列都还在"红
//   M5: 把 tasks.status 改成 NOT NULL 无默认          ⇒ 期望"补上来的列可空或有默认"或 INSERT 红
// 逐条改坏 → 跑 → **立刻**还原；每轮前先断言工作区与快照一致。
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const SERVER = 'team-hub/server.mjs'
const SUITE = ['--test', 'scripts/prt/backup-restore-cross-version.test.mjs']
const BAK = `${SERVER}.mutbak`

const MUTANTS = [
  ['M1 goal 重建丢掉旧行', SERVER,
    '        legacy.forEach((r, i) => {', '        ;[].forEach((r, i) => {'],
  ['M2 goal 重建不幂等', SERVER,
    "  const needsRebuild = () => !columnExists('goal', 'id')", '  const needsRebuild = () => true'],
  ['M3 老表加 NOT NULL 无默认列', SERVER,
    "ensureColumn('tasks', 'ttlMinutes', 'ttlMinutes INTEGER')", "ensureColumn('tasks', 'ttlMinutes', 'ttlMinutes INTEGER NOT NULL')"],
  // M4：给**老表**挂一个触发器。单行锚点（本文件是 CRLF，多行锚点会"找不到"）。
  //     挂在新表上不该红（那正是"新表闲置互不破坏"），挂在老表上才该红。
  ['M4 给老表 tasks 挂触发器', SERVER,
    "db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_web_history_scope_url ON web_fetch_history (scope, url)')",
    "db.exec('CREATE TRIGGER IF NOT EXISTS trg_old_tasks AFTER INSERT ON tasks BEGIN UPDATE tasks SET version = version WHERE id = NEW.id; END')\ndb.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_web_history_scope_url ON web_fetch_history (scope, url)')"],
  // M5：给老表加 NOT NULL 无默认列（M3 的另一种落点）
  ['M5 老表加 NOT NULL 无默认列（第二处）', SERVER,
    "ensureColumn('tasks', 'slice', 'slice TEXT')", "ensureColumn('tasks', 'slice', 'slice TEXT NOT NULL')"],
]

/**
 * ★ 一条**可证等价**的变异（不是"没咬住"，如实记下来）。
 *
 * 我原本还想试「把 `tasks.status` 的 `DEFAULT 'backlog'` 去掉」。
 * 量下来的结论是：它对今天的两侧**都不产生行为差异**——
 *
 *   · 新代码：`team-hub/server.mjs` 的两条 tasks INSERT **都显式写了 `status`**
 *     （列清单里有它，值来自 `input.status ?? 'backlog'`）；
 *   · 老代码：那一版的 INSERT 同样显式写了 `status`。
 *
 * 所以"去掉默认值"改变不了任何一条真实写入路径的结果。
 * 真要变成缺陷，得先有人写一条**不写 status** 的 INSERT——那时它才咬。
 *
 *   > 一个"今天等价"的变异，与一个"我漏掉了没测"的变异，
 *   > 在不写下来的时候是同一个东西——只不过前者下次还会被重新想一遍。
 *
 * 故记 `≈` 而不记为缺口（与 PRT-316 切片 34 §3.2 同一处置）。
 */
const EQUIVALENT_MUTANT = "tasks.status 去掉 DEFAULT 'backlog'（两侧 INSERT 都显式写 status，故行为无差异）"

copyFileSync(SERVER, BAK)
const snap = readFileSync(SERVER)
let bad = 0
const restore = () => { if (existsSync(BAK)) copyFileSync(BAK, SERVER) }
const assertClean = (when) => {
  if (Buffer.compare(snap, readFileSync(SERVER)) !== 0) {
    console.log(`✖ ${when}：工作区与快照不同——上一轮留了残渣，本轮不可信`); restore(); process.exit(1)
  }
}

try {
  for (const [name, file, from, to] of MUTANTS) {
    assertClean(`变异前 ${name}`)
    const text = readFileSync(BAK, 'utf8')
    if (!text.includes(from)) { console.log(`✖ ${name}：变异点找不到`); bad++; continue }
    writeFileSync(file, text.replace(from, to))
    let red = false
    try {
      execFileSync(process.execPath, SUITE, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch { red = true }
    console.log(`${red ? '✔' : '✖'} ${name} → ${red ? '咬住（红）' : '**没咬住**'}`)
    if (!red) bad++
    restore()
  }
} finally {
  restore()
  unlinkSync(BAK)
  console.log(`还原逐字节相同：${Buffer.compare(snap, readFileSync(SERVER)) === 0 ? '✔' : '✖'}`)
  console.log(`≈ 可证等价（不计缺口）：${EQUIVALENT_MUTANT}`)
  if (Buffer.compare(snap, readFileSync(SERVER)) !== 0) process.exit(1)
}
if (bad > 0) process.exit(1)
