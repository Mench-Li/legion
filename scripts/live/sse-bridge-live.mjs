// 生产 SSE 桥端到端实测（P1-1 第 2 步现场）：board hub 板 SSE ← 宿主 v2 事件。
const base = process.argv[2] ?? 'http://127.0.0.1:3080'
const ac = new AbortController()
const res = await fetch(base + '/scrum-board/api/board/events', { signal: ac.signal })
console.log('board SSE status =', res.status)

const frames = []
const reader = res.body.getReader()
const dec = new TextDecoder()
const pump = (async () => {
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      frames.push(dec.decode(value))
    }
  } catch { /* abort */ }
})()

await new Promise((r) => setTimeout(r, 1200))
const first = frames.join('')
console.log('首帧含 data 帧 =', first.includes('data:') ? 'yes' : 'no', '| 首帧含任务 id =', first.includes('"id"') ? 'yes' : 'no')

const mk = await fetch(base + '/team-hub/api/create', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'SSE 桥实测', by: 'general', scope: 'software' }),
}).then((r) => r.json())
const tid = mk.task?.id
console.log('经宿主 v2 create =', tid ?? JSON.stringify(mk).slice(0, 140))
if (tid) {
  await fetch(base + '/team-hub/api/transition', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: tid, to: 'todo', by: 'general', ifVersion: mk.task.version }),
  })
}
await new Promise((r) => setTimeout(r, 1500))
const all = frames.join('')
const hits = (all.match(/data: /g) ?? []).length
const sawNew = tid ? all.includes(tid) : false
console.log('桥泵帧数(data:) =', hits, '| 含新任务 id =', sawNew)

if (tid) {
  await fetch(base + '/team-hub/api/transition', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: tid, to: 'canceled', by: 'general', ifVersion: mk.task.version + 1 }),
  })
  console.log('已清理实测任务', tid, '→ canceled')
}
ac.abort()
await pump.catch(() => {})
const ok = res.status === 200 && hits >= 2 && sawNew
console.log(ok ? 'SSE 桥端到端 PASS' : 'SSE 桥端到端 FAIL（需复核）')
process.exit(ok ? 0 : 1)
