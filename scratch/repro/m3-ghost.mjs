// M3 repro: awaiting 超龄兜底只扫最新500条 + 回复队列只取 ASC LIMIT min(n*4,800)=80 行
// → 窗口外 awaiting 永不 failed 也永不被守护取走（幽灵 ⏳）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const tmp = mkdtempSync(join(tmpdir(), 'legion-m3-'))
process.env.TEAM_HUB_DB = join(tmp, 'team.db')
process.env.CHAT_REPLY_TIMEOUT_MS = '100' // 缩短超时便于测试（⚖️ env 可配，默认 120000）
const mod = await import(pathToFileURL(join(process.cwd(), 'team-hub', 'server.mjs')).href)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

let fail = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) fail++
}
const metaOf = (id) => JSON.parse(mod.db.prepare('SELECT meta FROM messages WHERE id = ?').get(id).meta)

// ── 控制组（小库，<80 条）：awaiting 可被队列取到、超龄可被兜底 ──
{
  const conv = mod.createConversation({ by: 'general', scope: 'ctrl', title: '控制会话' })
  const m = mod.postMessage({ conv: conv.id, by: 'general', body: '控制组提问' }) // awaiting
  check('控制: 发送后 meta.aiStatus=awaiting', metaOf(m.id).aiStatus === 'awaiting')
  const q0 = mod.listAwaitingReplies({ scope: 'ctrl', sinceMsgId: 0, limit: 20 })
  check('控制: since=0 队列能取到该 awaiting（msg ' + m.id + '）', q0.some(x => x.id === m.id), 'queue=' + JSON.stringify(q0.map(x => x.id)))
  await sleep(220) // > CHAT_REPLY_TIMEOUT_MS=100
  mod.listAwaitingReplies({ scope: 'ctrl', sinceMsgId: 0, limit: 20 }) // 触发 markStaleAwaiting
  const mAfter = metaOf(m.id)
  check('控制: 超龄后 awaiting→failed（兜底生效于窗口内）', mAfter.aiStatus === 'failed', JSON.stringify({ aiStatus: mAfter.aiStatus, aiError: mAfter.aiError }))
}

// ── 主场景（大库）：先灌 80 条普通消息 → awaiting 落在第 81 条 → 再灌 500 条 ──
{
  const conv = mod.createConversation({ by: 'general', scope: 'busy', title: '高活跃会话' })
  const filler = (n) => { for (let i = 0; i < n; i++) mod.postMessage({ conv: conv.id, by: 'busy-assistant', body: 'filler ' + i + ' xxxxx' }) }
  filler(80)                                   // ids 2..81（conv id1 不计入 messages; 消息从 id2 起）
  const t = mod.postMessage({ conv: conv.id, by: 'general', body: '请审阅这段代码并给出意见' }) // awaiting
  const targetId = t.id
  check('主场景: 目标消息已标 awaiting（id=' + targetId + '）', metaOf(targetId).aiStatus === 'awaiting', 'id=' + targetId)
  filler(500)                                  // 目标之后又灌 500 条 → 目标不在最新 500 窗口内
  const totalBefore = mod.db.prepare('SELECT COUNT(*) c FROM messages WHERE scope = ?').get('busy').c
  await sleep(220)                             // 远超超时
  const q = mod.listAwaitingReplies({ scope: 'busy', sinceMsgId: 0, limit: 20 }) // = 守护 GET /api/chat/replies?limit=20 的实际查询(sinceMsgId 恒 0)
  const metaT = metaOf(targetId)
  check('M3-1 超龄兜底漏网: 窗口外老 awaiting 应被标 failed（实际仍 awaiting）', metaT.aiStatus === 'failed',
    '实际=' + metaT.aiStatus + '（总消息数=' + totalBefore + '，目标 id=' + targetId + ' 不在最新500窗口）')
  check('M3-2 队列饥饿: 守护式拉取(since=0,limit=20)应能取到该 awaiting', q.some(x => x.id === targetId),
    'queue=' + JSON.stringify(q.map(x => x.id)) + '（实际空/不含目标）')
  if (metaT.aiStatus !== 'failed' && !q.some(x => x.id === targetId)) {
    console.log('  → 幽灵 awaiting 实证: 消息 ' + targetId + ' 既不进队列、也不被兜底为 failed，UI 将永久显示 ⏳')
  }
  // 补充实证: 新发一条 awaiting（最新 id=583，位于最新500窗口内）→ 超龄后应被兜底 → 证明窗口边界是唯一差异
  const fresh = mod.postMessage({ conv: conv.id, by: 'general', body: '窗口内新提问' })
  await sleep(220) // 让 fresh 也超龄（age > CHAT_REPLY_TIMEOUT_MS=100）
  mod.listAwaitingReplies({ scope: 'busy', sinceMsgId: 0, limit: 20 }) // 触发 markStaleAwaiting
  const metaF = metaOf(fresh.id)
  check('对照: 窗口内(最新500)新 awaiting 超龄后被兜底 failed', metaF.aiStatus === 'failed', JSON.stringify({ aiStatus: metaF.aiStatus, id: fresh.id }))
}

console.log(fail === 0 ? '== M3 结论: 无窗口缺陷 ==' : '== M3 结论: 确认窗口缺陷（' + fail + ' 项 FAIL）==')
mod.db.close()
rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
