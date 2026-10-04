// docs/bugs/BUG-003-reconcile-probe.mjs — 在**库副本**上跑一次真正的对账，看看今天还欠哪些汇报
//
// 只读生产库一次（复制），随后所有写入都落在临时副本上。
// 判读：对账后新增的条数 = 当前这一份数据里「本应汇报、但还没有」的缺口。
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = process.cwd()
const SRC = process.env.BUG003_SNAPSHOT_DB ?? join(process.env.BUG003_SOURCE_REPO ?? 'D:/project/DSH/legion', 'team-hub', 'team.db')
const dir = mkdtempSync(join(tmpdir(), 'bug3-reconcile-'))
const db = join(dir, 'team.db')
copyFileSync(SRC, db)
for (const s of ['-wal', '-shm']) if (existsSync(SRC + s)) copyFileSync(SRC + s, db + s)

process.env.TEAM_HUB_DB = db
process.env.TEAM_HUB_TOKEN = ''
process.env.TEAM_HUB_PORT = '8799'

const hub = await import(new URL('../../team-hub/server.mjs', import.meta.url).href)

const before = {
  messages: hub.db.prepare('SELECT COUNT(*) n FROM messages').get().n,
  reports: hub.db.prepare('SELECT COUNT(*) n FROM agent_reports').get().n,
  maxMsg: hub.db.prepare('SELECT COALESCE(MAX(id),0) v FROM messages').get().v,
  maxCreated: hub.db.prepare("SELECT COALESCE(MAX(createdAt),'') v FROM messages").get().v,
}
hub.reconcileAgentConversations()
const after = {
  messages: hub.db.prepare('SELECT COUNT(*) n FROM messages').get().n,
  reports: hub.db.prepare('SELECT COUNT(*) n FROM agent_reports').get().n,
}
const fresh = hub.db.prepare('SELECT id, conv_id, scope, createdAt, substr(body,1,60) b FROM messages WHERE id > ? ORDER BY id').all(before.maxMsg)
console.log(JSON.stringify({
  source: SRC,
  before, after,
  addedMessages: after.messages - before.messages,
  addedReports: after.reports - before.reports,
  fresh,
}, null, 2))
hub.db.close()
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
process.exit(0)
