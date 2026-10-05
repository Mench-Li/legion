// docs/bugs/BUG-006-verify.mjs —— BUG-006 的 A/B 判据（在**临时库**上跑，不碰生产库）
//
// 它把"同一个任务的两条取法"并排算出来，让分叉**看得见**：
//   · 旧取法（缺陷）：`intent?.paths ?? []`            —— 诊断端点当年的写法
//   · 新取法（修复）：`store.resolvePlannedPaths(id)` —— 认领/预约/过渡/诊断四处共用
// 然后在同一份 fixture 上跑一次真实的 `inspectContention`，打印两种取法各自的判定。
//
// 运行：node docs/bugs/BUG-006-verify.mjs
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWriteIntentStore, ensureWriteIntentSchema } from '../../team-hub/write-intent-store.mjs'

const dir = mkdtempSync(join(tmpdir(), 'bug006-verify-'))
const db = new DatabaseSync(join(dir, 'fixture.db'))
ensureWriteIntentSchema(db)
// 诊断端点读 tasks.fileDomain；这里只建它需要的最小列。
db.exec('CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, fileDomain TEXT)')

const store = createWriteIntentStore(db)
const REPO = 'd:/repo/.git'

// ── fixture：与现场同形 ────────────────────────────────────────────────────────
// 持有者 T-hold 占住 feature/a（有 active intent —— 生产里"正在跑"就是这个样子）；
// T-dom 声明了 fileDomain=["feature/b","feature/c"] 但**没有** write-intent。
// 这正是缺陷现场：T-dom 的文件域与持有者不冲突，但它"没申报 intent"。
db.prepare('INSERT INTO tasks (id, fileDomain) VALUES (?,?)').run('T-hold', null)
db.prepare('INSERT INTO tasks (id, fileDomain) VALUES (?,?)').run('T-dom', JSON.stringify(['feature/b', 'feature/c']))
db.prepare('INSERT INTO tasks (id, fileDomain) VALUES (?,?)').run('T-none', null)

store.upsertIntent({ repoId: REPO, taskId: 'T-hold', attemptId: 'hold-1', targetRef: null, paths: ['feature/a'] })
const held = store.reserve({ repoId: REPO, taskId: 'T-hold', attemptId: 'hold-1', epoch: 1, paths: ['feature/a'] })
if (held.ok !== true) { console.error('fixture 搭建失败：持有者没占住', held); process.exit(1) }

const rows = []
for (const id of ['T-dom', 'T-none']) {
  const intent = store.getIntent(id)
  const oldPaths = intent?.paths ?? []                                   // ← 缺陷取法
  const { paths: newPaths, from } = store.resolvePlannedPaths(id, { intent })
  const oldVerdict = store.inspectContention({ repoId: REPO, taskId: id, paths: oldPaths, exclusive: oldPaths.length === 0 })
  const newVerdict = store.inspectContention({ repoId: REPO, taskId: id, paths: newPaths, exclusive: newPaths.length === 0 })
  rows.push({ id, oldPaths, newPaths, from, oldVerdict, newVerdict })
}

console.log('=== 同一份 fixture，两条取法并排 ===')
console.log(`库：${join(dir, 'fixture.db')}（临时，跑完删除）`)
console.log(`持有者：T-hold 占住 ["feature/a"]（state=reserved）\n`)
for (const r of rows) {
  const verdict = v => `${v.ok ? 'ok:true  无冲突' : `ok:false ${v.code} → ${JSON.stringify(v.paths)}`}`
  console.log(`任务 ${r.id}`)
  console.log(`  旧取法 intent?.paths ?? []        paths=${JSON.stringify(r.oldPaths)}  ⇒  ${verdict(r.oldVerdict)}`)
  console.log(`  新取法 resolvePlannedPaths()      paths=${JSON.stringify(r.newPaths)}  (from=${r.from})  ⇒  ${verdict(r.newVerdict)}`)
  const diverged = r.oldVerdict.ok !== r.newVerdict.ok
  console.log(`  ${diverged ? '★ 两条取法结论不同 —— 这就是"读数与事实不一致"' : '（两条取法一致：这个任务没有 fileDomain，整仓独占是正确判定）'}\n`)
}

const dom = rows.find(r => r.id === 'T-dom')
console.log('=== 判据 ===')
console.log(`  ① 声明 fileDomain、无 intent ⇒ 新取法 ok:true（旧取法 ok:false 整仓独占）：${dom.newVerdict.ok === true && dom.oldVerdict.ok === false ? '✅ 分叉已消除' : '❌'}`)
const none = rows.find(r => r.id === 'T-none')
console.log(`  ② 未声明 fileDomain、无 intent ⇒ 仍整仓独占：${none.newVerdict.ok === false ? '✅ 未被放宽' : '❌ 被顺手改掉了'}`)
console.log(`  ③ 新取法带 from 说明来源：T-dom from=${dom.from}`)

db.close()
rmSync(dir, { recursive: true, force: true })
