/**
 * verify-cancel-strand.mjs — 「取消目标 → 在办任务留痕 + 挂 hold」的**真实 HTTP 端到端**验证。
 *
 * 为什么不只靠 team-hub/goal.test.mjs：那个用例直接调 setGoalState()，绕过 HTTP 层，
 * 因此看不见响应信封形状——本次即因此漏掉一个真 bug：hub 写端点统一回 `{ ok, task }`，
 * 前端若按 `r.strandedTasks` 读会永远 undefined，提示静默失效。本脚本走完整 HTTP 路径补上这一层。
 *
 * 起独立临时库 + 独立端口（8788）的 team-hub 实例，不碰生产 team.db。
 * 用法：node scratch/verify-cancel-strand.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 8788
const BASE = `http://127.0.0.1:${PORT}`
const tmp = mkdtempSync(join(tmpdir(), 'hub-e2e-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const post = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ by: 'general', ...body }),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}
const get = async (path) => {
  const res = await fetch(BASE + path)
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

const child = spawn(process.execPath, ['team-hub/server.mjs'], {
  cwd: 'D:/project/DSH/legion',
  env: { ...process.env, TEAM_HUB_PORT: String(PORT), TEAM_HUB_DB: join(tmp, 'team.db'), TEAM_HUB_TOKEN: '', TEAM_HUB_HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', (d) => { log += String(d) })
child.stderr.on('data', (d) => { log += String(d) })

const out = {}
let failed = null
try {
  // 等启动
  for (let i = 0; i < 60; i++) {
    try { const r = await get('/api/config'); if (r.status === 200) break } catch { /* 未起 */ }
    await sleep(250)
  }
  await post('/api/agents', { scope: 'e2e', role: 'planner', name: '计划官' })
  await post('/api/agents', { scope: 'e2e', role: 'implementer', name: '实现官' })
  const pub = await post('/api/goal', { scope: 'e2e', objective: 'E2E：取消目标留痕验证' })
  out.publish = { status: pub.status, goalId: pub.json?.task?.goal?.id ?? null }
  const gid = out.publish.goalId

  const board = await get(`/api/board?scope=e2e`)
  const rawTasks = Array.isArray(board.json) ? board.json : (board.json?.tasks ?? [])
  const tasks = rawTasks.filter((t) => t.goalId === gid)
  out.chain = tasks.map((t) => ({ id: t.id, status: t.status, role: t.role }))
  const [t1, t2] = tasks
  if (!t1 || !t2) throw new Error('链任务未生成：' + JSON.stringify(out.chain))

  out.moves = []
  for (const to of ['in_progress', 'in_review']) {
    const r = await post('/api/transition', { id: t1.id, to })
    out.moves.push({ id: t1.id, to, status: r.status })
  }

  const cancel = await post('/api/goal/status', { id: gid, status: 'canceled' })
  out.cancel = {
    httpStatus: cancel.status,
    envelopeKeys: cancel.json && typeof cancel.json === 'object' ? Object.keys(cancel.json) : String(cancel.json),
    canceledTasks: cancel.json?.task?.canceledTasks,
    strandedTasks: cancel.json?.task?.strandedTasks,
  }
  const stranded = cancel.json?.task?.strandedTasks

  const after = await get(`/api/task?id=${t1.id}`)
  const t = after.json
  out.strandedTask = {
    status: t.status,
    hold: t.hold,
    lastCommentBy: t.comments?.at(-1)?.by,
    lastComment: (t.comments?.at(-1)?.text ?? '').slice(0, 90),
  }
  const other = await get(`/api/task?id=${t2.id}`)
  out.otherTask = { id: t2.id, status: other.json.status, hold: other.json.hold }

  // 断言
  const checks = [
    ['cancel 返回 strandedTasks 含 t1', Array.isArray(stranded) && stranded.includes(t1.id)],
    ['cancel 硬取消数 = 1（未开工那条）', out.cancel.canceledTasks === 1],
    ['t1 未被处决（仍 in_review）', out.strandedTask.status === 'in_review'],
    ['t1 已置 hold', out.strandedTask.hold === true],
    ['t1 有将军提示评论', out.strandedTask.lastCommentBy === 'general' && out.strandedTask.lastComment.includes('已取消')],
    ['t2 被取消', out.otherTask.status === 'canceled'],
  ]
  out.checks = checks.map(([name, ok]) => `${ok ? 'PASS' : 'FAIL'} ${name}`)
  failed = checks.filter(([, ok]) => !ok)
} catch (e) {
  failed = [['异常', String(e)]]
  out.error = String(e)
} finally {
  child.kill()
  await sleep(800) // 等子进程释放 SQLite WAL 句柄（Windows 下立刻删目录会 EPERM）
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* 临时目录留待系统清理 */ }
}
console.log(JSON.stringify(out, null, 2))
if (failed && failed.length > 0) { console.error('FAIL:', JSON.stringify(failed)); process.exit(1) }
console.log('全部断言 PASS')
