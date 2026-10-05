// docs/bugs/BUG-002-live-verify.mjs — BUG-002 的**活体验证**（会写入生产中枢，手动运行，绝不进 CI）
//
// 为什么要它：单元测试与库副本 A/B 只能证明"队列看得见消息"，证不了"守护真的答了、答成了谁"。
// 这一步在 conv 25（编码工程师）里发一条**明确标注的**测试消息，然后等守护的回复。
//
// 运行：node docs/bugs/BUG-002-live-verify.mjs [--conv 25] [--scope software] [--timeout 240]
//   ⚠ 它会在目标会话留下：1 条提问 + 1 条 AI 回复（并产生一次模型调用）。默认只读地等 240s。
//   ★ `--retry <msgId>`：**不发新消息**，只把一条已 failed 的消息置回 awaiting 再等回复
//     （用于"改完模型配置后重跑同一条"，不往会话里再添一条提问）。
//
// 读数怎么判：
//   · 回复出现且 meta.aiStatus=replied → 队列修复生效（这是本 Bug 的主症状）
//   · 回复作者是 agent:<scope>:<role>   → 守护侧新代码已加载（BUG-002 的第二半）
//     回复作者是 <scope>-assistant      → 守护仍是旧代码（宿主未重启），符合预期
//   · 超时未回复 → 打 aiError（旧守护会给分类文案，服务端兜底给"回复超时"）
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const HUB = process.env.BUG002_HUB ?? 'http://127.0.0.1:8787'
const CONV = Number(arg('conv', '25'))
const SCOPE = arg('scope', 'software')
const RETRY = arg('retry', '')
const TIMEOUT_MS = Number(arg('timeout', '240')) * 1000
const BODY = process.env.BUG002_BODY ?? '【BUG-002 活体验证】这条消息用于确认「Agent 对话回复」是否恢复，可忽略。'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const get = async (p) => (await fetch(HUB + p)).json()
const msgs = async () => (await get(`/api/chat/messages?conv=${CONV}&limit=50`)).messages ?? []

const before = await msgs()
const lastId = before.at(-1)?.id ?? 0
console.log(`会话 ${CONV}：发前最后一条 id=${lastId}，共 ${before.length} 条`)

let mine
if (RETRY !== '') {
  const r = await fetch(HUB + '/api/chat/replies/retry', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgId: Number(RETRY), by: 'general' }),
  })
  const out = await r.json()
  console.log(`重试 msg ${RETRY}：HTTP ${r.status}，${JSON.stringify(out).slice(0, 200)}`)
  mine = out?.task
  if (r.status !== 200) process.exit(1)
} else {
  const res = await fetch(HUB + '/api/chat/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conv: CONV, body: BODY, by: 'general' }),
  })
  const sent = await res.json()
  mine = sent?.task ?? sent
  console.log(`已发送：HTTP ${res.status}，msg=${mine?.id}，aiStatus=${mine?.meta?.aiStatus}`)
  if (res.status !== 200) { console.error('发送失败：', JSON.stringify(sent)); process.exit(1) }
}

const started = Date.now()
const seen = new Set(before.map(m => m.id))
const srcId = Number(RETRY) || mine.id
let outcome = null
while (Date.now() - started < TIMEOUT_MS) {
  await sleep(10000)
  const list = await msgs()
  const replies = list.filter(m => !seen.has(m.id) && m.author !== 'general')
  const src = list.find(m => m.id === srcId)
  const elapsed = Math.round((Date.now() - started) / 1000)
  const ai = src?.meta?.aiStatus ?? '(无)'
  console.log(`  +${elapsed}s  源消息 aiStatus=${ai}${src?.meta?.aiError ? `  aiError=${src.meta.aiError.slice(0, 70)}` : ''}  新回复=${replies.length}`)
  if (replies.length > 0) { outcome = { replies, elapsed, src }; break }
  if (ai === 'failed') { outcome = { replies: [], elapsed, src, failed: true }; break }
}

if (outcome === null) {
  console.log(`\n结果：${TIMEOUT_MS / 1000}s 内没有回复（源消息既没 replied 也没 failed）`)
  process.exitCode = 1
} else if (outcome.failed) {
  console.log(`\n结果：源消息被判失败 —— aiError="${outcome.src.meta?.aiError}"（问题在守护/模型侧，不在队列）`)
  process.exitCode = 2
} else {
  const r = outcome.replies[0]
  const expected = `agent:${SCOPE}:coder`
  console.log(`\n结果：${outcome.elapsed}s 后收到回复 —— author=${r.author}`)
  console.log(`  队列修复：${r ? '生效（消息被守护看见了）' : '未生效'}`)
  console.log(`  守护侧新代码：${r.author === expected ? `已加载（作者=${expected}）` : `仍是旧代码（期望 ${expected}，实际 ${r.author}）`}`)
  console.log(`  回复正文：${String(r.body).slice(0, 160)}`)
}
process.exit(process.exitCode ?? 0)
