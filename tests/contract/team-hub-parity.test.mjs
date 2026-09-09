// P1-1 双形态对拍：v2 权威实现（team-hub/server.mjs）的「独立服务形态」与
// 「宿主前缀外壳形态」对同一批请求返回等价语义。
//
//   形态 A（无前缀独立服务，模拟 8787）：server.mjs 导出的 server 直接 listen(0)。
//   形态 B（带前缀宿主外壳）：http.createServer 把同 handle(req,res,'/team-hub')
//     挂到前缀下 —— 与 src/index.ts 外壳的 handler 完全同构。
//
// 断言：① 前缀剥离正确（B 的 /team-hub/api/* == A 的 /api/*，错误文案无前缀残留）；
//       ② 只读请求同库同时刻绝对等价（board/config/404 全等）；
//       ③ 写请求两侧结构等价（create→transition→comment、409 乐观锁、401 鉴权矩阵）。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import http from 'node:http'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TMP = mkdtempSync(join(tmpdir(), 'p11-parity-'))
const DB = join(TMP, 'parity.db')
const TOKEN = 'tk-parity'

// ── env 必须在 import server.mjs 之前（模块加载即按 env 建库/读 token/读 port）
process.env.TEAM_HUB_DB = DB
process.env.TEAM_HUB_HOST = '127.0.0.1'
process.env.TEAM_HUB_TOKEN = TOKEN
process.env.TEAM_HUB_PORT = '0'

let aServer = null
let bServer = null
let baseA = ''
let baseB = ''

async function listen(srv) {
  await new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', resolve)
  })
  return 'http://127.0.0.1:' + srv.address().port
}

before(async () => {
  const mod = await import(pathToFileURL(join(REPO, 'team-hub', 'server.mjs')).href)
  aServer = mod.server
  baseA = await listen(aServer)
  // 形态 B：与 src/index.ts 外壳同构的前缀 wrap（stripPrefix='/team-hub'）
  bServer = http.createServer((req, res) => { void mod.handle(req, res, '/team-hub') })
  baseB = await listen(bServer)
})

after(async () => {
  try { if (aServer) await new Promise((r) => aServer.close(r)) } catch { /* 已关 */ }
  try { if (bServer) await new Promise((r) => bServer.close(r)) } catch { /* 已关 */ }
  await new Promise((r) => setTimeout(r, 300))
  for (let i = 0; i < 8; i++) {
    try { rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }); return } catch { /* 重试 */ }
    await new Promise((r) => setTimeout(r, 250))
  }
})

async function req(base, path, { method = 'GET', body, token } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = 'Bearer ' + token
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try { data = await res.json() } catch { /* 非 JSON */ }
  return { status: res.status, data }
}

/** 剔除时序/自增字段后的任务规范化（对拍比较用）。 */
function normTask(t) {
  if (!t || typeof t !== 'object') return t
  const out = { ...t }
  for (const k of ['createdAt', 'updatedAt', 'ts', 'seq', 'claimedAt']) delete out[k]
  if (Array.isArray(out.comments)) out.comments = out.comments.map((c) => ({ ...c, at: 'T' }))
  return out
}

test('P1-1 双形态对拍：独立服务(无前缀) vs 宿主外壳(/team-hub 前缀) 语义等价', async () => {
  // ① 前缀剥离正确：B 的 /team-hub/api/* 与 A 的 /api/* 等价；404 文案无前缀残留
  const cA = await req(baseA, '/api/config')
  const cB = await req(baseB, '/team-hub/api/config')
  assert.equal(cA.status, 200)
  assert.deepEqual(cB.data, cA.data, 'config 响应应全等（auth/db/port 相同）')
  assert.equal(cB.data.auth, true)
  assert.equal(cB.data.port, 0) // TEAM_HUB_PORT=0 原样透出（v2 config 报告 env port）

  const nA = await req(baseA, '/api/nope')
  const nB = await req(baseB, '/team-hub/api/nope')
  assert.equal(nA.status, 404)
  assert.equal(nB.status, 404)
  assert.equal(nB.data.error, nA.data.error, '404 错误文案一致')
  assert.ok(!nB.data.error.includes('/team-hub'), '前缀应被剥离，错误里不得残留 /team-hub：' + nB.data.error)

  // ② 鉴权矩阵两侧一致（无 token / 错 token → 401）
  const u1A = await req(baseA, '/api/create', { method: 'POST', body: { title: 'x', by: 'general' } })
  const u1B = await req(baseB, '/team-hub/api/create', { method: 'POST', body: { title: 'x', by: 'general' } })
  assert.equal(u1A.status, 401)
  assert.equal(u1B.status, 401)
  assert.equal(u1B.data.error, u1A.data.error, '401 文案一致')
  const u2A = await req(baseA, '/api/create', { method: 'POST', body: { title: 'x', by: 'general' }, token: 'wrong' })
  const u2B = await req(baseB, '/team-hub/api/create', { method: 'POST', body: { title: 'x', by: 'general' }, token: 'wrong' })
  assert.equal(u2A.status, 401)
  assert.equal(u2B.status, 401)

  // ③ 写请求两侧结构等价（同库错开任务：A=T-001、B=T-002）
  const mk = (title) => ({ title, description: '对拍', by: 'general', scope: 'default' })
  const cA2 = await req(baseA, '/api/create', { method: 'POST', body: mk('形态A任务'), token: TOKEN })
  const cB2 = await req(baseB, '/team-hub/api/create', { method: 'POST', body: mk('形态B任务'), token: TOKEN })
  assert.equal(cA2.status, 200)
  assert.equal(cB2.status, 200)
  const idA = cA2.data.task.id
  const idB = cB2.data.task.id
  assert.equal(idA, 'T-001')
  assert.equal(idB, 'T-002')
  assert.deepEqual(normTask(cB2.data.task), { ...normTask(cA2.data.task), id: idB, title: '形态B任务' })

  // transition 成功（各自 version 1）→ 200 todo；再用旧 version → 409（文案一致）
  const t1A = await req(baseA, '/api/transition', { method: 'POST', body: { id: idA, to: 'todo', by: 'general', ifVersion: 1 }, token: TOKEN })
  const t1B = await req(baseB, '/team-hub/api/transition', { method: 'POST', body: { id: idB, to: 'todo', by: 'general', ifVersion: 1 }, token: TOKEN })
  assert.equal(t1A.status, 200)
  assert.equal(t1B.status, 200)
  assert.equal(t1B.data.task.status, 'todo')
  const t2A = await req(baseA, '/api/transition', { method: 'POST', body: { id: idA, to: 'in_progress', by: 'general', ifVersion: 1 }, token: TOKEN })
  const t2B = await req(baseB, '/team-hub/api/transition', { method: 'POST', body: { id: idB, to: 'in_progress', by: 'general', ifVersion: 1 }, token: TOKEN })
  assert.equal(t2A.status, 409)
  assert.equal(t2B.status, 409)
  // 文案含各自任务 id → 归一化 id 后一致
  const normErr = (s) => s.replace(/T-\d{3}/g, 'T-###')
  assert.equal(normErr(t2B.data.error), normErr(t2A.data.error), '409 乐观锁文案（除任务 id）一致')

  // comment 两侧结构等价
  const m1A = await req(baseA, '/api/comment', { method: 'POST', body: { id: idA, text: '对拍评论', by: 'general' }, token: TOKEN })
  const m1B = await req(baseB, '/team-hub/api/comment', { method: 'POST', body: { id: idB, text: '对拍评论', by: 'general' }, token: TOKEN })
  assert.equal(m1A.status, 200)
  assert.equal(m1B.status, 200)
  assert.deepEqual(normTask(m1B.data.task), { ...normTask(m1A.data.task), id: idB, title: '形态B任务' })

  // ④ 只读同库同时刻绝对等价：board 含两任务且两侧响应全等
  const bA = await req(baseA, '/api/board?scope=default')
  const bB = await req(baseB, '/team-hub/api/board?scope=default')
  assert.equal(bA.status, 200)
  assert.deepEqual(bB.data, bA.data, 'board 响应应全等（同一 v2 库同一时刻）')
  assert.ok(Array.isArray(bA.data) && bA.data.some((t) => t.id === 'T-001') && bA.data.some((t) => t.id === 'T-002'))
})
