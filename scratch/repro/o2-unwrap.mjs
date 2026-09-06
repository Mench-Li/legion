// O2 验证: workbench api.ts 各 chat 写接口用 hubPost(...).then(res => res.task) 解包,
// 服务端 handleWrite 固定返回 {ok:true, task: result} → 实测真实 HTTP 响应形状, 判定 .task 是否可取。
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'legion-o2-'))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let fail = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) fail++
}
const port = 30000 + Math.floor(Math.random() * 20000)
const dbFile = join(tmp, 'team.db')
const child = spawn(process.execPath, ['team-hub/server.mjs'], {
  cwd: process.cwd(), stdio: 'ignore',
  env: { ...process.env, TEAM_HUB_DB: dbFile, TEAM_HUB_PORT: String(port), TEAM_HUB_TOKEN: '' },
})
const base = 'http://127.0.0.1:' + port
try {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/api/config'); if (r.ok) break } catch {}
    await sleep(100)
  }
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, by: 'general' }) })

  // 1) 会话 + 消息（awaiting）
  const convRes = await post('/api/chat/conversations', { scope: 'software', title: 'O2 验证会话' })
  const convJson = await convRes.json()
  check('conv 响应含 task 字段(api.ts 取 .task 所需)', convJson && typeof convJson.task === 'object' && convJson.task.id, JSON.stringify(convJson).slice(0, 160))
  const convId = convJson.task.id

  const msgRes = await post('/api/chat/messages', { conv: convId, body: '验证消息', kind: 'text' })
  const msgJson = await msgRes.json()
  check('msg 响应含 task 字段', msgJson && typeof msgJson.task === 'object' && msgJson.task.id, JSON.stringify(msgJson).slice(0, 200))
  const msgId = msgJson.task.id
  check('msg.task.meta.aiStatus=awaiting', msgJson.task.meta && msgJson.task.meta.aiStatus === 'awaiting', JSON.stringify(msgJson.task.meta))

  // 2) fail 回写 → failed
  const failRes = await post('/api/chat/replies/fail', { msgId, error: '测试失败注入' })
  const failJson = await failRes.json()
  // 注: failAiReply 返回 {skipped:false, source: 消息} 形状(非消息本身); 仅 plugins chat-responder 调用且不消费返回值 → 无用户影响(记录为 INFO)
  check('fail 响应形状={ok,task:{skipped,source}} 且 source.meta.aiStatus=failed', failJson && failJson.task && failJson.task.source && failJson.task.source.meta && failJson.task.source.meta.aiStatus === 'failed', JSON.stringify(failJson).slice(0, 260))

  // 3) retry（O2 关注点）→ 重置 awaiting
  const retryRes = await post('/api/chat/replies/retry', { msgId })
  const retryJson = await retryRes.json()
  check('retry 响应含 task 字段且可取', retryJson && typeof retryJson.task === 'object' && retryJson.task.id === msgId, '顶层键=' + JSON.stringify(Object.keys(retryJson || {})))
  check('retry 后 aiStatus=awaiting（服务端已成功重置）', retryJson.task.meta && retryJson.task.meta.aiStatus === 'awaiting', JSON.stringify(retryJson.task.meta))

  // 4) 对照 api.ts 消费链: hubPost→json {ok,task} → .then(res=>res.task) —— 服务端形状匹配
  const shapeMatches = (j) => j && typeof j.ok === 'boolean' && j.ok === true && typeof j.task === 'object' && j.task !== null
  check('O2 判定: 服务端 chat 写接口形状={ok,task}, 与 api.ts .task 消费链一致', shapeMatches(retryJson) && shapeMatches(msgJson) && shapeMatches(convJson),
    '（T-100 O2 声称 retryChatReply 取 .task 得 undefined → HTTP 实测 .task 存在）')
} finally {
  child.kill()
  await new Promise(r => setTimeout(r, 300))
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}
console.log(fail === 0 ? '== O2 结论: 服务端响应形状与 api.ts 消费链一致, 未复现 undefined ==' : '== O2 结论: 存在不一致（' + fail + ' 项 FAIL）==')
process.exitCode = fail === 0 ? 0 : 1
