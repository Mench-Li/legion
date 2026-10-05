// docs/bugs/BUG-006-live-ab.mjs — 用**生产库副本**把新旧两种取法并排算出来（只读，不碰生产库）
//
// 为什么需要它：重启前后的现场读数确实不同（`paths:["(whole repository)"]` → `paths:["team-hub"]`），
// 但那一段时间里 T-183 的 `fileDomain` **也从 null 被改成了 ["team-hub/","docs/bugs/"]** ——
// 两个变量同时变了，所以那对读数**不能单独证明是代码修好的**。
// 本脚本把变量隔离：**同一份当前库状态**下，并排算"旧写法"与"新函数"，差异只可能来自代码。
//
// 运行：node docs/bugs/BUG-006-live-ab.mjs   （可用 BUG006_ROOT 覆盖主检出位置）
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createWriteIntentStore, ensureWriteIntentSchema } from '../../team-hub/write-intent-store.mjs'

// ★ 活库在**主检出**里，不在工作树里（`team-hub/team.db` 是 gitignored 的本地状态，
//   git worktree 之间不共享它）。所以路径不能按"本脚本所在目录往上两级"取 ——
//   在 `.legion-worktrees/<x>` 下那样算会落到工作树自己的目录，那里的 team.db
//   要么不存在、要么是一份与生产无关的旧副本（实测：读到 **0 个任务**，小结看着像"没有分叉"，
//   而这正好是这个脚本要防的那类假绿）。用 `--git-common-dir` 才能稳定拿到共同的 .git，
//   其父目录就是主检出。
function resolveLegionRoot() {
  if (process.env.BUG006_ROOT) return process.env.BUG006_ROOT
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8' }).trim()
    return dirname(common)
  } catch {
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  }
}

const root = resolveLegionRoot()
const live = join(root, 'team-hub', 'team.db')
console.log(`主检出（活库所在）：${root}`)
const dir = mkdtempSync(join(tmpdir(), 'bug006-live-ab-'))
const copy = join(dir, 'team.db')
copyFileSync(live, copy)
const db = new DatabaseSync(copy)
db.exec('PRAGMA busy_timeout = 10000')
ensureWriteIntentSchema(db)
const store = createWriteIntentStore(db)

// repoId 从库里取，**不硬编码机器路径**：预约是按 `write_reservations.repo_id` 键的，
// 硬编码会在别的机器/别的检出上悄悄算出一堆"无冲突"（又一个假绿来源）。
const repoId = db.prepare('SELECT repo_id FROM write_reservations ORDER BY id DESC LIMIT 1').get()?.repo_id
  ?? db.prepare('SELECT repo_id FROM task_write_intents ORDER BY rowid DESC LIMIT 1').get()?.repo_id
if (!repoId) { console.error('这份库里没有任何预约/意图记录 —— 无法判定，拒绝输出结论。'); db.close(); rmSync(dir, { recursive: true, force: true }); process.exit(1) }

console.log('=== 同一份生产库状态，两条取法并排（变量已隔离）')
console.log(`库副本：${copy}`)
console.log(`repoId（取自库）：${repoId}\n`)

const rows = db.prepare(`SELECT id, status, fileDomain,
    (SELECT COUNT(*) FROM task_write_intents i WHERE i.task_id = t.id) AS intents,
    scheduling_state
  FROM tasks t
  WHERE status NOT IN ('done','canceled') OR scheduling_state='waiting-file'
  ORDER BY CAST(SUBSTR(id,3) AS INTEGER)`).all()

// ★ 护栏：读不到任务时**必须报错退出**，不能安静地打印"0 个不同"。
//   实测踩到过：脚本按"自己所在目录往上两级"找库，在 `fix/bugs` 工作树里读到的不是活库，
//   于是小结是"0 个任务里 0 个不同"—— 一个看起来像"没有分叉"的假绿。
if (rows.length === 0) {
  console.error(`这份库里没有可判定的任务（库：${copy}）。`)
  console.error('这通常说明**读到的不是活库**：`team-hub/team.db` 是 gitignored 的本地状态，')
  console.error('git worktree 之间不共享它 —— 活库在主检出里（本脚本用 git-common-dir 解析）。')
  db.close(); rmSync(dir, { recursive: true, force: true }); process.exit(1)
}

let diverged = 0
for (const t of rows) {
  const intent = store.getIntent(t.id)
  const oldPaths = intent?.paths ?? []                     // ← 缺陷取法（诊断端点当年的写法）
  const { paths: newPaths, from } = store.resolvePlannedPaths(t.id, { intent })
  const oldV = store.inspectContention({ repoId, taskId: t.id, paths: oldPaths, exclusive: oldPaths.length === 0 })
  const newV = store.inspectContention({ repoId, taskId: t.id, paths: newPaths, exclusive: newPaths.length === 0 })
  // ★ 判"分叉"不能只看 `ok`：缺陷的本质是**读数与事实不一致**。
  //   实测 T-183/T-184 两种取法的 ok 都是 false（确实有冲突），但旧写法报的是
  //   "整仓独占 (whole repository)"，新写法报的是真实冲突路径 "team-hub" ——
  //   同一句"有冲突"，一个把人指向"整个仓库被占了"，一个指向"team-hub 被占了"。
  //   所以这里同时比 ok 与 paths 集合。（我第一版只比 ok，得出"0 个不同"的错误小结。）
  const key = (v) => `${v.ok}|${[...(v.paths ?? [])].sort().join(',')}`
  const same = key(oldV) === key(newV)
  if (!same) diverged += 1
  const fmt = (v) => (v.ok ? 'ok:true  无冲突' : `ok:false ${v.code} → ${JSON.stringify(v.paths)}`)
  console.log(`任务 ${t.id}（status=${t.status} fileDomain=${t.fileDomain ?? 'null'} intent=${t.intents}）`)
  console.log(`   旧 intent?.paths ?? []      ⇒ ${fmt(oldV)}`)
  console.log(`   新 resolvePlannedPaths()   ⇒ ${fmt(newV)}   (from=${from})`)
  console.log(`   ${same ? '一致' : '★ 读数不同 —— 旧写法报的不是实际冲突范围'}`)
  console.log('')
}

console.log(`=== 小结：${rows.length} 个任务里 ${diverged} 个的**读数**在新旧取法下不同`)
console.log('（ok 相同但 paths 不同的也算：那就是"有冲突"这句话在骗人 —— 它说的范围不是真的）')
console.log('（ok 与 paths 都相同的，说明该任务没有 fileDomain，两种取法本来就该一致）')

db.close()
rmSync(dir, { recursive: true, force: true })
