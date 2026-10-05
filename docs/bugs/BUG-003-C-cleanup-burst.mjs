// docs/bugs/BUG-003-C-cleanup-burst.mjs — 清掉"迁移窗口里被旧进程灌进主对话"的那一批历史汇报
//
// 现场与成因（**是我自己的执行顺序造成的，不是产品缺陷**）：
//   修法 C 的迁移把 `agent_conversation_bindings` 从 conv 7 搬到 conv 25（主对话）之后、
//   中枢重启（加载带"新鲜窗口"的新代码）之前的这几十秒里，**仍在运行的旧进程**照常对账。
//   旧代码没有新鲜窗口，于是把几周前的终态（`T-006 任务状态：已取消。`…）一次性灌进 conv 25，
//   而且作者用的是稳定 agent_id（旧代码的选择）。
//   新代码不会再这样做：它对每条汇报带**事件发生时间**，超出 24h 窗口就不投影
//   （`team-hub/agent-conversations.test.mjs` 的「历史事件不补播」用例钉着这条）。
//
// 本脚本做的纠正（精确、可核对）：
//   删除 conv 25 里 `meta.source='progress'` 且**作者是稳定 agent_id** 的消息，
//   连同它们在 `agent_reports` 上 `conv_id=25` 的投递记录。
//   删掉记录是必须的：否则它们会被当成"已投递"，而真正新鲜的事件反而补不进来。
//   删完之后新代码会自动**只把窗口内的新鲜事件**重新投影进来（作者为 `agent:<scope>:<role>`）。
//
// 用法：node docs/bugs/BUG-003-C-cleanup-burst.mjs --convs 24,25 [--db <path>] [--apply]
//
// ★ `--convs` 是**必填**的，默认空：只清理"这次迁移收养的那几条主对话"。
//   第一版把这个过滤条件写漏了，结果是 210 条历史汇报（conv 3..23 里几个月前正常投递的那些）
//   全部进了候选集 —— 那会把整个仓库的正常汇报史删掉。一个"清理"脚本的范围写宽了，
//   与一个删除脚本没有区别，所以这里宁可不给默认值。
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def
}
const APPLY = process.argv.includes('--apply')
const dbPath = arg('db', join(root, 'team-hub', 'team.db'))
const convArg = arg('convs', '')
if (convArg.trim() === '') {
  console.error('缺少 --convs：请显式列出这次迁移收养的主对话，例如 --convs 24,25')
  process.exit(2)
}
const convIds = convArg.split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0)
if (convIds.length === 0) { console.error('--convs 没解析出任何会话号'); process.exit(2) }
if (!existsSync(dbPath)) { console.error(`库不存在：${dbPath}`); process.exit(1) }
const db = new DatabaseSync(dbPath)
db.exec('PRAGMA busy_timeout = 10000')

// 目标集合：**只在指定的主对话里**、"作者是稳定 agent_id"的汇报消息。
// 稳定 agent_id 的形态是 `agent-<uuid>`（岗位身份是 `agent:<scope>:<role>`，带冒号）。
const placeholders = convIds.map(() => '?').join(',')
const rows = db.prepare(`SELECT m.id, m.conv_id, m.author, m.body,
    json_extract(m.meta,'$.reportId') AS report_id
  FROM messages m
  WHERE m.conv_id IN (${placeholders})
    AND json_extract(m.meta,'$.source')='progress'
    AND m.author LIKE 'agent-%'
    AND m.author NOT LIKE 'agent:%'
  ORDER BY m.id`).all(...convIds)

console.log(`目标：${rows.length} 条「作者是稳定 agent_id 的汇报」`)
console.log(`库：${dbPath}`)
if (rows.length === 0) { console.log('没有需要清理的（幂等）。'); db.close(); process.exit(0) }
const byConv = {}
for (const r of rows) byConv[r.conv_id] = (byConv[r.conv_id] ?? 0) + 1
console.log(`分布：${Object.entries(byConv).map(([c, n]) => `conv ${c} × ${n}`).join('，')}`)
console.log('样例：')
for (const r of rows.slice(0, 5)) console.log(`  msg=${r.id} conv=${r.conv_id} ${r.body.slice(0, 40)}`)

if (!APPLY) {
  console.log('\n（未加 --apply：什么都没删）')
  db.close()
  process.exit(0)
}

db.exec('BEGIN IMMEDIATE')
try {
  const ids = rows.map(r => r.id)
  const reportIds = rows.map(r => r.report_id).filter(Boolean)
  const delMsgs = db.prepare(`DELETE FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
  let delReports = { changes: 0 }
  if (reportIds.length > 0) {
    delReports = db.prepare(`DELETE FROM agent_reports WHERE report_id IN (${reportIds.map(() => '?').join(',')})`).run(...reportIds)
  }
  // 会话的 last_message_at 重算（删掉尾部消息后不该留着旧时间戳）
  for (const convId of Object.keys(byConv)) {
    const last = db.prepare('SELECT MAX(createdAt) t FROM messages WHERE conv_id=?').get(Number(convId))?.t ?? null
    db.prepare('UPDATE conversations SET last_message_at=?, updatedAt=COALESCE(?,updatedAt) WHERE id=?').run(last, last, Number(convId))
  }
  db.exec('COMMIT')
  console.log(`\n已删除消息 ${delMsgs.changes} 条，投递记录 ${delReports.changes} 条。`)
} catch (e) {
  db.exec('ROLLBACK')
  console.error('回滚：', e.message)
  process.exitCode = 1
}

const left = db.prepare(`SELECT COUNT(*) n FROM messages
  WHERE conv_id IN (${placeholders})
    AND json_extract(meta,'$.source')='progress' AND author LIKE 'agent-%' AND author NOT LIKE 'agent:%'`).get(...convIds).n
console.log(`清理后仍存在的「uuid 作者汇报」：${left} 条`)
console.log('接下来新代码会把**窗口内的新鲜事件**重新投影进来（作者 agent:<scope>:<role>）。')
db.close()
