// product/server/_acceptance-helper.mjs
// 验收用的服务器侧助手：建任务 → 推 todo → 观察。
//
// 用 JS 而不是 shell + 嵌套 heredoc：那套引号转义在实测里已经错过一次
// （任务建出来了但没推到 todo，表现为"节点就绪却什么都不派发"——
//  一个看起来像产品缺陷、实际是脚本转义的假象）。
import { DatabaseSync } from 'node:sqlite'

const HUB = `http://127.0.0.1:${process.env.TEAM_HUB_PORT || 8787}`
const TOKEN = process.env.TEAM_HUB_TOKEN
const DB = process.env.TEAM_HUB_DB || '/var/lib/legion-hub/team.db'
const headers = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const j = async (r) => {
  const t = await r.text()
  try { return JSON.parse(t) } catch { return { raw: t } }
}
const post = (path, body) => fetch(HUB + path, { method: 'POST', headers, body: JSON.stringify(body) }).then(j)
const get = (path) => fetch(HUB + path, { headers }).then(j)

const command = process.argv[2]

if (command === 'create') {
  const title = process.argv[3] ?? `端到端验收-${Date.now()}`
  const created = await post('/api/create', { by: 'acceptance', scope: 'default', title, role: 'general' })
  const id = created?.task?.id ?? created?.id
  if (!id) { console.log(JSON.stringify({ ok: false, step: 'create', created })); process.exit(1) }
  const board = await get('/api/board?scope=default')
  const list = Array.isArray(board) ? board : (board.tasks ?? [])
  const row = list.find((t) => t.id === id)
  const moved = await post('/api/transition', { by: 'acceptance', scope: 'default', id, to: 'todo', ifVersion: row.version })
  // 读回确认：**不要**假设写成功了。脚本里"以为推过去了"与"真的推过去了"
  // 在后续步骤里长得一模一样（都表现为任务不动）。
  const after = await get('/api/board?scope=default')
  const list2 = Array.isArray(after) ? after : (after.tasks ?? [])
  const now = list2.find((t) => t.id === id)
  console.log(JSON.stringify({ ok: now?.status === 'todo', id, title, status: now?.status, moved: moved?.error ?? 'ok' }))
  process.exit(0)
}

if (command === 'state') {
  const db = new DatabaseSync(DB)
  const t = db.prepare("SELECT id,title,status FROM tasks WHERE title LIKE '端到端验收-%' ORDER BY id DESC LIMIT 1").get()
  if (!t) { console.log('(还没有验收任务)'); process.exit(0) }
  const a = db.prepare('SELECT state, worker_id, lease_epoch FROM run_attempts WHERE task_id=? ORDER BY attempt_no DESC LIMIT 1').get(t.id)
  const res = db.prepare("SELECT state FROM write_reservations WHERE task_id=? ORDER BY id DESC LIMIT 1").get(t.id)
  console.log(`${t.id} 任务=${t.status} | 尝试=${a ? `${a.state} by ${a.worker_id ?? '-'}` : '-'} | 预约=${res?.state ?? '-'}`)
  process.exit(0)
}

if (command === 'attempts') {
  const db = new DatabaseSync(DB)
  for (const r of db.prepare('SELECT id,task_id,state,worker_id,lease_epoch FROM run_attempts ORDER BY id').all()) {
    console.log('  ', JSON.stringify(r))
  }
  process.exit(0)
}

console.log('用法: _acceptance-helper.mjs create [标题] | state | attempts')
