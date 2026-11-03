// team-hub/mention-routes.test.mjs
// ============================================================================
// F3 · `@` 在 `/api/comment` 上的**可观测结果**（设计稿 §3 F3 / M4）
//
// 单元判据（mentions.test.mjs）钉的是解析与分流；这里钉"落盘之后能看见什么"：
//   ① 普通评论 ⇒ kind='comment'，无 meta
//   ② @<其他成员> ⇒ kind='order'，meta.mention_role 指向被 @ 的人
//   ③ @general ⇒ 升级为提问：meta.effect='escalate' + 真的建出一条未答问题
//   ④ @ 不在编队里的角色 ⇒ 退回普通评论（并留下 unknown 诊断）
//   ⑤ 重复 @ 同一个人 ⇒ 只算一次，不产生两条订单
// ============================================================================
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
const mkTask = async (title = '@ 宿主') =>
  (await req('POST', '/api/create', { title, by: 'general' })).body.task.id
const say = (id, text, by = 'general') => req('POST', '/api/comment', { id, text, by })
const inputsOf = async (id) => (await req('GET', `/api/tasks/${id}/inputs`)).body.inputs
const openQuestions = (id) =>
  mod.db.prepare("SELECT COUNT(*) c FROM agent_questions WHERE task_id=? AND status='open'").get(id).c

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-mentions-'))
  process.env.TEAM_HUB_DB = join(dbDir, 'team.db')
  mod = await import('./server.mjs')
  // 编队成员：@ 只认成员。直接写 registry，避免依赖脚手架同步。
  mod.db.prepare(`INSERT OR IGNORE INTO agent_registry (agent_id, scope, role, name, archived)
    VALUES (?,?,?,?,0)`).run('agent-coder-1', 'default', 'coder', '编码兵')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dbDir, { recursive: true, force: true })
})

test('① 普通评论仍是 comment（行为不变）', async () => {
  const id = await mkTask()
  await say(id, '这里看着不对')
  const [input] = await inputsOf(id)
  assert.equal(input.kind, 'comment')
  assert.deepEqual(input.meta, {})
})

test('② @<成员> ⇒ kind=order + meta.mention_role', async () => {
  const id = await mkTask()
  await say(id, '@coder 顺手把日志也加上')
  const [input] = await inputsOf(id)
  assert.equal(input.kind, 'order', '★ 追加续跑要能和普通批注分开')
  assert.equal(input.meta.mention_role, 'coder')
  assert.equal(input.meta.effect, 'order')
})

test('③ @general ⇒ 升级为提问（真的建出未答问题）', async () => {
  const id = await mkTask()
  await say(id, '@general 这个取舍要您定')
  const [input] = await inputsOf(id)
  assert.equal(input.meta.effect, 'escalate')
  assert.equal(openQuestions(id), 1, '★ 升级为提问 = 留下一个等人拍板的问题')
})

test('④ @ 不在编队里的角色 ⇒ 退回普通评论', async () => {
  const id = await mkTask()
  await say(id, '@ghost 你看下这个')
  const [input] = await inputsOf(id)
  assert.equal(input.kind, 'comment', '未注册角色不该产生订单')
})

test('⑤ 重复 @ 同一个人只算一次', async () => {
  const id = await mkTask()
  await say(id, '@coder @coder @coder 干活')
  const inputs = await inputsOf(id)
  assert.equal(inputs.length, 1, '一条评论一条输入')
  assert.equal(inputs[0].kind, 'order')
  assert.deepEqual(inputs[0].meta.addressed_to, ['coder'])
})
