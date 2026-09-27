// T-172 证据：任务详情 API 是否下发调度/交付子状态（S7 徽标数据链）。
// 数据源 = GET /api/task?id=<id>（team-hub/routes/read-models.mjs:84-92，内部走 rowToTask）。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'legion-t172-fields-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('../../../team-hub/server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port
const db = mod.db
const cols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name)
console.log('tasks 表含调度/交付列 =', cols.includes('scheduling_state'), '/', cols.includes('delivery_state'))
db.prepare('INSERT INTO tasks (id,title,status,scope,fixCount,scheduling_state,delivery_state) VALUES (?,?,?,?,?,?,?)')
  .run('T-a', 'A', 'todo', 'default', 0, 'waiting-file', 'integrated')
const res = await fetch(base + '/api/task?id=T-a')
const task = await res.json()
const keys = Object.keys(task)
console.log('GET /api/task 状态 =', res.status)
console.log('返回体里调度/交付相关键 =', JSON.stringify(keys.filter((k) => /schedul|deliver|blocked/i.test(k))))
console.log('schedulingState =', task.schedulingState, '| deliveryState =', task.deliveryState)
console.log('VERDICT: 前端徽标所需字段是否下发 =', task.schedulingState !== undefined || task.deliveryState !== undefined)
try { mod.server.closeAllConnections?.() } catch {}
try { mod.server.close() } catch {}
try { db.close?.() } catch {}
rmSync(dir, { recursive: true, force: true })
