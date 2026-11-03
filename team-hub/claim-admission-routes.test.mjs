// team-hub/claim-admission-routes.test.mjs
// ============================================================================
// F6/F7 · 认领准入在 `/api/claim` 上的接线（设计稿 §8.1 / §8.2）
//
// 这个文件在**开关打开**的形态下跑（`LEGION_CLAIM_ADMISSION=1`），因为默认关闭的行为
// 已经被全仓其它认领用例覆盖（它们都是默认环境）。
//
// 判据：
//   ① 只剩保留槽时，后台请求认领 ⇒ 409 + code（I-7.3）
//   ② 同一情形下人请求 ⇒ 放行
//   ③ 关闭开关时一律放行（单独进程验证，见文件末尾的环境说明）
// ============================================================================
process.env.LEGION_CLAIM_ADMISSION = '1'

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mod
let base
let dbDir

const req = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method, agent: false,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try { payload = await res.json() } catch { /* 无正文 */ }
  return { status: res.status, body: payload }
}

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-admission-'))
  process.env.TEAM_HUB_DB = join(dbDir, 'team.db')
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port

  // 空间配置：2 个槽、保留 1 个；当前已有 1 个在跑 ⇒ 后台只剩 0 个可用
  mod.db.prepare(`INSERT INTO space_runtime (scope, enabled, maxWorkers, isolate, reserved_slots)
    VALUES ('default',1,2,1,1) ON CONFLICT(scope) DO UPDATE SET maxWorkers=2, reserved_slots=1`).run()
  const busy = await req('POST', '/api/create', { title: '占槽', by: 'general' })
  mod.db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(busy.body.task.id)
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dbDir, { recursive: true, force: true })
})

test('① 只剩保留槽时后台请求认领 ⇒ 409 + code（I-7.3）', async () => {
  const t = await req('POST', '/api/create', { title: '后台任务', by: 'general' })
  const id = t.body.task.id
  await req('POST', '/api/transition', { id, to: 'todo', by: 'general' })
  // 归后台（agent 身份）：soldier=agent:coder
  const r = await req('POST', '/api/claim', { id, soldier: 'agent:coder', by: 'general' })
  assert.equal(r.status, 409)
  assert.equal(r.body.code, 'SLOT_RESERVED_FOR_HUMAN')
})

test('② 同一情形下人请求 ⇒ 放行', async () => {
  const t = await req('POST', '/api/create', { title: '人的任务', by: 'general' })
  const id = t.body.task.id
  await req('POST', '/api/transition', { id, to: 'todo', by: 'general' })
  const r = await req('POST', '/api/claim', { id, soldier: 'general', by: 'general' })
  assert.equal(r.status, 200, `预期放行，实际 ${r.status} ${JSON.stringify(r.body)}`)
})
