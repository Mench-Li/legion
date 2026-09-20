// ============================================================================
// PRT-316 切片 21：`/api/comment`（追加批注：评论 / 证据 / 用户反馈）
//
// 这一族**也没有**专属判据 —— 破验 19 处里 **14 处没人管**。既有那几把
// （sources-loader / team-hub-parity / v1v2-contract）只钉住"能追加进去"和两端一致，
// 钉不住"**追加到哪一列**、什么算反馈、什么算证据、审计记成什么"。
//
// ★ 所有断言里的形状**都是量出来的**（`probe21-comment.mjs`）：
//   · 批注条目 = `{by, at, text}`
//   · 三列是 `comments` / `evidence` / `feedback`
//   · **`kind:'feedback'` 优先于 `isEvidence:true`**（④ 量出来的，不是猜的）
//   · `id` **不 trim**：只含空格的 id 会通过"非空"检查，然后死在 `未知任务` 上
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
const mkTask = async (extra) =>
  (await req('POST', '/api/create', { title: '批注宿主', by: 'general', ...extra })).body.task.id
const readTask = async (id) => (await req('GET', '/api/task?id=' + encodeURIComponent(id))).body
const note = (id, extra) => req('POST', '/api/comment', { id, text: '正文', by: 'general', ...extra })
const auditOf = async (id) => {
  const rows = (await req('GET', '/api/activity?taskId=' + encodeURIComponent(id))).body ?? []
  return [...rows].sort((a, b) => a.seq - b.seq)
}

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-commentroutes-'))
  process.env.TEAM_HUB_DB = join(dbDir, 'team.db')
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dbDir, { recursive: true, force: true })
})

test('① 默认落到 `comments` 列，条目形状是 `{by, at, text}`', async () => {
  const id = await mkTask({})
  const r = await note(id, {})
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true, '回执是 `{ok:true, task}`')
  assert.equal(r.body.task.id, id, '★ 回执里就是那个被追加的任务本身（写作方靠它拿最新批注）')
  const t = await readTask(id)
  assert.equal(t.comments.length, 1)
  assert.equal(t.comments[0].text, '正文')
  assert.equal(t.comments[0].by, 'general')
  assert.equal(typeof t.comments[0].at, 'string')
  assert.deepEqual([...t.evidence], [], '证据列不动')
  assert.deepEqual([...t.feedback], [], '反馈列不动')
})

test('② 三条路径各落到**自己那一列**（`kind` / `isEvidence` 的分派）', async () => {
  const id = await mkTask({})
  await note(id, { text: '普通' })
  await note(id, { text: '反馈', kind: 'feedback' })
  await note(id, { text: '证据', isEvidence: true })
  const t = await readTask(id)
  assert.deepEqual(t.comments.map((c) => c.text), ['普通'], '★ 反馈与证据**不能**混进评论列')
  assert.deepEqual(t.feedback.map((c) => c.text), ['反馈'])
  assert.deepEqual(t.evidence.map((c) => c.text), ['证据'])
})

test('③ ★★★ 优先级：`kind:\'feedback\'` 压过 `isEvidence:true`', async () => {
  const id = await mkTask({})
  const r = await note(id, { text: '两个都给', kind: 'feedback', isEvidence: true })
  assert.equal(r.status, 200)
  const t = await readTask(id)
  assert.deepEqual(t.feedback.map((c) => c.text), ['两个都给'],
    '两个都给时按 `kind` 走 —— 顺序反了会把用户反馈**存进证据列**，而两列是分开读的')
  assert.deepEqual([...t.evidence], [], '证据列不能被写进去')
})

test('④ `isEvidence` 只有**字面 true** 才算证据', async () => {
  const id = await mkTask({})
  for (const v of ['yes', 1, 'true']) {
    const r = await note(id, { text: 'e-' + String(v), isEvidence: v })
    assert.equal(r.status, 200)
  }
  const t = await readTask(id)
  assert.deepEqual([...t.evidence], [],
    '真值不算 —— 证据列是给人看"这条结论有什么凭据"的，混进普通评论会让它失去意义')
  assert.equal(t.comments.length, 3)
})

test('⑤ `kind` 只认 `feedback` 这一个值，别的都当普通评论', async () => {
  const id = await mkTask({})
  for (const v of ['other', 'comments', 'FEEDBACK', '']) await note(id, { text: 'k-' + v, kind: v })
  const t = await readTask(id)
  assert.deepEqual([...t.feedback], [], '不认识的 kind 不许当反馈')
  assert.equal(t.comments.length, 4)
})

test('⑥ text 的四种坏法都要 400 `缺少参数 text`；text 会被 trim', async () => {
  const id = await mkTask({})
  for (const [what, v] of [['只含空格', '   '], ['空串', ''], ['缺失', undefined], ['非字符串', 7]]) {
    const r = await note(id, { text: v })
    assert.equal(r.status, 400, `${what} 应当 400`)
    assert.equal(r.body.error, '缺少参数 text', `${what} 的文案`)
  }
  await note(id, { text: '  两边空格  ' })
  const t = await readTask(id)
  assert.equal(t.comments.at(-1).text, '两边空格', '存进去的是 trim 过的')
})

test('⑦ ★ `id` 不 trim：只含空格的 id 通过"非空"检查，死在"未知任务"上', async () => {
  const empty = await note('', { text: 'x' })
  assert.equal(empty.status, 400)
  assert.equal(empty.body.error, '缺少参数 id', '**空** id 是"没给"')

  const blank = await note('   ', { text: 'x' })
  assert.equal(blank.status, 400)
  assert.equal(blank.body.error, '未知任务    ',
    '★ 只含空格的 id **不算"没给"**，它走进了查库、然后查不到 —— ' +
    '两条路径给出**不同**的文案，调用方靠它区分"我忘了传"和"这个任务不在"')

  const missing = await note('T-999', { text: 'x' })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error, '未知任务 T-999')
})

test('⑧ ★★★ 审计动作按**实际落到的那一列**记（comment / feedback / evidence）', async () => {
  const id = await mkTask({})
  await note(id, { text: 'a' })
  await note(id, { text: 'b', kind: 'feedback' })
  await note(id, { text: 'c', isEvidence: true })
  await note(id, { text: 'd', kind: 'feedback', isEvidence: true })
  const actions = (await auditOf(id)).map((e) => e.action)
  assert.deepEqual(actions, ['create', 'comment', 'feedback', 'evidence', 'feedback'],
    '★ 审计里恒记 `comment` 的话，"这条反馈是谁记的"就查不出来了 —— ' +
    '而三条路径共用写入口这件事，只有审计动作能把它们再分开')
})

test('⑨ ★ 审计要带上任务的 goalId（少一条，批注与目标就断开了）', async () => {
  const id = await mkTask({ goalId: 'goal-c21' })
  await note(id, { text: 'a' })
  const entries = await auditOf(id)
  const c = entries.find((e) => e.action === 'comment')
  assert.ok(c, '找不到那条 comment 审计')
  assert.equal(c.goalId, 'goal-c21',
    '审计的 goalId 取自追加后的任务 —— 不传它就永远是 null，谁也发现不了')
})

test('⑩ 只有 POST 认这条路径', async () => {
  for (const m of ['GET', 'PUT', 'DELETE']) {
    assert.equal((await req(m, '/api/comment')).status, 404, `${m} /api/comment 应当 404`)
  }
})

test('⑪ ★★★ 写门面炸了必须**向调用方抛出**，不能变成没人管的 promise', async () => {
  // 与切片 20 同一条：happy path 上有没有 `await` 看起来一样，差别只在
  // `handleWrite` 的 catch 块里那句 `json(...)` 也抛的时候（比如客户端已断开）——
  // 那时没有 await 就是**未处理的 promise**，Node 15+ 默认直接杀掉进程。
  const routes = await import('./routes/comment.mjs')
  const built = routes.createCommentRoutes({
    json: () => {},
    appendTaskNote: () => ({ id: 'T-999', goalId: null }),
    audit: () => {},
    handleWrite: async () => { throw new Error('写门面炸了') },
  })
  await assert.rejects(
    () => built.dispatch({ method: 'POST' }, {}, { path: '/api/comment', url: new URL('http://127.0.0.1/api/comment') }),
    /写门面炸了/,
    '写门面的异常必须传给调用方，而不是逃逸成未处理的 promise')
})
