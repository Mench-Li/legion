// docs/bugs/BUG-003-C-migrate.mjs — 修法 C 的**存量迁移**：把"两条同名会话"收敛成一条主对话。
//
// 用法：
//   node docs/bugs/BUG-003-C-migrate.mjs                     # 只读：在**生产库副本**上演示，打印收敛结果
//   node docs/bugs/BUG-003-C-migrate.mjs --db <path>         # 对指定库文件（副本）执行
//   node docs/bugs/BUG-003-C-migrate.mjs --db <live> --apply # 对**生产库**真执行（显式开关）
//
// 它做四件事（全部在一个 BEGIN IMMEDIATE 事务里，幂等）：
//   ① 把 `agent_conversation_bindings` 从"汇报流那条"搬到该岗位的 `agent_role` 那条（主对话）；
//   ② 主对话标题回到纯岗位名；
//   ③ 历史那条摘掉 `agent_role`（它本来就没有）、标题写明去向：`岗位名 · 历史汇报（已并入主对话）`；
//   ④ 没有双子的（新库）给直接绑定那条补上 `agent_role`。
// **一条消息都不搬**：旧会话的全部消息与 agent_reports 记录原样留着，只是不再挂在这个岗位上。
//
// 为什么要有它、而不是让服务启动时自动跑：它改的是**用户看得见的会话归属**。
// 一个在启动时顺手改归属的迁移，与一个没人知道发生过的迁移，在"出问题时能否回退"上不是一回事。
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentConversationService } from '../../team-hub/agent-conversations.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def
}
const APPLY = process.argv.includes('--apply')
const LIVE = join(root, 'team-hub', 'team.db')

/** 目标库：默认在副本上演示（绝不碰生产库，除非显式 --db <live> --apply）。 */
let dbPath = arg('db', '')
let tempCopy = ''
if (dbPath === '') {
  const dir = join(tmpdir(), `bug003-c-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  tempCopy = join(dir, 'team.db')
  copyFileSync(LIVE, tempCopy)
  dbPath = tempCopy
  console.log(`（未指定 --db：在生产库的**副本**上演示）\n  ${tempCopy}`)
}
if (!existsSync(dbPath)) { console.error(`库不存在：${dbPath}`); process.exit(1) }
if (APPLY && dbPath !== LIVE) console.log('（--apply：对指定库真执行）')
if (!APPLY) console.log('（默认只演示：会真的跑迁移，但跑在库副本上；对生产库要加 --db <live> --apply）')

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA busy_timeout = 10000')

/** 与 server.mjs 同形的写事务（BEGIN IMMEDIATE + 嵌套 SAVEPOINT）。 */
let txDepth = 0
function withTx(mutate) {
  const nested = txDepth > 0
  const name = `tx_sp_${txDepth + 1}`
  if (nested) db.exec(`SAVEPOINT ${name}`); else db.exec('BEGIN IMMEDIATE')
  txDepth += 1
  try {
    const result = mutate()
    if (nested) db.exec(`RELEASE ${name}`); else db.exec('COMMIT')
    txDepth -= 1
    return result
  } catch (e) {
    try { if (nested) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`) } else db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    txDepth -= 1
    throw e
  }
}
const auditLog = []
const audit = (...args) => { auditLog.push(args) }

/** 收敛前的现场：每个空间的会话清单（谁带 agent_role、谁被 binding 指着、各有多少消息）。 */
function snapshot(label) {
  const rows = db.prepare(`SELECT c.id, c.scope, c.title, c.agent_role,
      (SELECT COUNT(*) FROM messages m WHERE m.conv_id = c.id) AS msgs,
      (SELECT COUNT(*) FROM agent_conversation_bindings b WHERE b.conv_id = c.id) AS bound
    FROM conversations c
    WHERE c.agent_role IS NOT NULL
       OR EXISTS (SELECT 1 FROM agent_conversation_bindings b WHERE b.conv_id = c.id)
    ORDER BY c.scope, c.id`).all()
  console.log(`\n=== ${label} ===`)
  for (const r of rows) {
    const role = r.agent_role ?? '—'
    console.log(`  conv=${String(r.id).padStart(3)} [${r.scope}] ${String(r.title).padEnd(28)} agent_role=${String(role).padEnd(9)} 消息=${String(r.msgs).padStart(3)} binding=${r.bound}`)
  }
  const dup = db.prepare(`SELECT scope, agent_role, COUNT(*) n FROM conversations
    WHERE agent_role IS NOT NULL GROUP BY scope, agent_role HAVING n > 1`).all()
  console.log(`  带同一 (scope, agent_role) 的多条会话：${dup.length} 组${dup.length ? ' ← 不该发生' : ''}`)
  return rows
}

snapshot('迁移前')
const service = createAgentConversationService({
  db, withTx, audit,
  recordRunEvents: () => {},
  createTask: () => { throw new Error('迁移不该建任务') },
})
const out = service.convergeAgentConversations()
console.log('\n=== 迁移动作 ===')
console.log(JSON.stringify(out, null, 2))
console.log(`审计条目：${auditLog.length} 条`)

const after = snapshot('迁移后')

// 判据（C-1 / C-5）：不许有重复的 (scope, agent_role)；每个岗位恰好一条主对话，且被 binding 指着
const dups = db.prepare(`SELECT scope, agent_role, COUNT(*) n FROM conversations
  WHERE agent_role IS NOT NULL GROUP BY scope, agent_role HAVING n > 1`).all()
const mains = db.prepare(`SELECT c.id, c.scope, c.agent_role, c.title,
    (SELECT COUNT(*) FROM agent_conversation_bindings b WHERE b.conv_id = c.id) AS bound,
    (SELECT COUNT(*) FROM messages m WHERE m.conv_id = c.id) AS msgs
  FROM conversations c WHERE c.agent_role IS NOT NULL ORDER BY c.scope, c.id`).all()
console.log('\n=== 判据 ===')
console.log(`  C-1 每 (空间, 岗位) 只有一条主对话：${dups.length === 0 ? '✅' : '❌ ' + JSON.stringify(dups)}`)
const unbound = mains.filter(m => m.bound === 0)
console.log(`  C-1b 每条主对话都被 binding 指着（汇报写得进来）：${unbound.length === 0 ? '✅' : '❌ ' + JSON.stringify(unbound)}`)
console.log(`  C-6 主对话的标题是纯岗位名：${mains.every(m => !/汇报流|历史汇报/.test(m.title)) ? '✅' : '❌ ' + JSON.stringify(mains.filter(m => /汇报流|历史汇报/.test(m.title)))}`)
const hist = db.prepare(`SELECT id, scope, title, (SELECT COUNT(*) FROM messages m WHERE m.conv_id = conversations.id) msgs
  FROM conversations WHERE title LIKE '%历史汇报%'`).all()
console.log(`  历史会话（消息原样保留）：${hist.length} 条`)
for (const h of hist) console.log(`     conv=${h.id} [${h.scope}] ${h.title} — ${h.msgs} 条消息仍在`)

const beforeTotal = db.prepare('SELECT COUNT(*) n FROM messages').get().n
console.log(`  消息总数：${beforeTotal}（迁移不搬消息，只改归属）`)

db.close()
if (tempCopy) rmSync(dirname(tempCopy), { recursive: true, force: true })
if (!APPLY) console.log('\n（演示结束；生产库没被动过。）')
