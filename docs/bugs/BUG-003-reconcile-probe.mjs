// docs/bugs/BUG-003-reconcile-probe.mjs — 在**库副本**上跑一次真正的对账（只读生产库，写入只落副本）
//
// 两个判读：
//   ① 缺口：对账新增多少条（= 这一份数据里"本应汇报、但还没有"的量）
//   ② 多播是否生效：新增的汇报里，有多少落进了**对话中心那条会话**（conversations.agent_role）
//      —— 这是 BUG-003 的判据：修前那个数字是 0，修后它会>0（并把存量任务的汇报一次性补齐）
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
}
hub.reconcileAgentConversations()
const after = {
  messages: hub.db.prepare('SELECT COUNT(*) n FROM messages').get().n,
  reports: hub.db.prepare('SELECT COUNT(*) n FROM agent_reports').get().n,
}
const fresh = hub.db.prepare('SELECT id, conv_id, author, substr(body,1,70) b FROM messages WHERE id > ? ORDER BY id').all(before.maxMsg)
const roleConvs = new Map(hub.db.prepare('SELECT id, scope, agent_role FROM conversations WHERE agent_role IS NOT NULL').all().map(r => [r.id, `${r.scope}/${r.agent_role}`]))
const intoRoleConv = fresh.filter(m => roleConvs.has(m.conv_id))

// 第二段：造一个**新事件**（只在副本上改一行），看它是否同时进两条会话。
// 这一段是判据本身：只播新事件、不补播存量，两者的差别就在这两个数字上。
const pick = hub.db.prepare(`SELECT t.id, t.version, t.scope, COALESCE(t.role,t.soldier) role, c.id conv_id
  FROM tasks t JOIN conversations c ON c.scope = t.scope AND c.agent_role = COALESCE(t.role,t.soldier)
  WHERE t.status = 'in_progress' LIMIT 1`).get()
let newEvent = null
if (pick) {
  const mark = hub.db.prepare('SELECT COALESCE(MAX(id),0) v FROM messages').get().v
  hub.db.prepare("UPDATE tasks SET status='in_review',version=version+1 WHERE id=?").run(pick.id)
  hub.reconcileAgentConversations()
  newEvent = {
    task: pick.id, role: pick.role, chatViewConv: pick.conv_id,
    intoChatView: hub.db.prepare('SELECT COUNT(*) n FROM messages WHERE id > ? AND conv_id = ?').get(mark, pick.conv_id).n,
    intoAllConvs: hub.db.prepare('SELECT COUNT(*) n FROM messages WHERE id > ?').get(mark).n,
    sample: hub.db.prepare('SELECT conv_id, author, substr(body,1,60) b FROM messages WHERE id > ? ORDER BY id').all(mark),
  }
}

console.log(JSON.stringify({
  source: SRC,
  phase1_history: {
    before, after,
    addedMessages: after.messages - before.messages,
    addedReports: after.reports - before.reports,
    addedIntoChatViewConversations: intoRoleConv.length,
    note: '应当是 0：存量历史不许补播（每条都会被盖上"现在"的时间戳）',
  },
  phase2_newEvent: newEvent ?? '（副本里没有 in_progress 且岗位已建对话中心会话的任务，跳过）',
  chatViewConversations: Object.fromEntries(roleConvs),
  freshTotal: fresh.length,
}, null, 2))
hub.db.close()
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
process.exit(0)
