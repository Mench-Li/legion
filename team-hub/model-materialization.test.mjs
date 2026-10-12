// ============================================================================
// team-hub/model-materialization.test.mjs
//
// 物化读数那一族的路由面（`GET /api/model-materialization` + `POST .../reading`）。
//
// 两个方向各一个重点：
//   · **写**（POST）：没过令牌**必须拒** —— 它是外部进程往中枢写状态；
//   · **读**（GET）：**没收到过**与"没有差异"必须分得开（`reading: null`）。
//
// 自起进程 / 自己的库 / 自己的端口（与其它路由套件同一手法）。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'legion-matreading-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
// ★ 设了令牌，才能在同一个进程里同时验"带令牌能写"与"不带令牌被拒"。
process.env.TEAM_HUB_TOKEN = 'READING_T0KEN'
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

// ★ 显式收尾：不起眼的 `server.close()` 少了，`node --test` **不会退出**
//   （事件循环里还挂着一个监听中的 server），表现为整套用例跑完之后**挂住**。
after(async () => {
  try { mod.server.closeAllConnections?.() } catch { /* 无连接 */ }
  try { await new Promise((r) => mod.server.close(r)) } catch { /* 已关 */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 句柄 */ }
})

const call = async (m, p, body, { withToken = true } = {}) => {
  const res = await fetch(base + p, {
    method: m,
    headers: {
      ...(withToken ? { authorization: 'Bearer READING_T0KEN' } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const t = await res.text()
  let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}

const READING = {
  at: '2026-10-12T08:20:02.376Z',
  legionReadOk: true,
  actualReadOk: true,
  plan: {
    ok: true, clean: false,
    counts: { create: 0, update: 1, delete: 0, unchanged: 3 },
    create: [], update: [{ id: 'svea-ds', fields: ['api'] }], delete: [], unchanged: [],
    engineInternal: ['deepseek-official'], credentialsNeeded: [],
  },
  line: '供应商影子对账：新增 0 / 修改 1 / 删除 0 / 未变 3（clean=false）',
  gate: { applyModelConfig: false, applyModelConfigDeletes: false },
}

test('① ★★★ 没收到过 ⇒ `reading: null`（**不是** clean:true）', async () => {
  const r = await call('GET', '/api/model-materialization')
  assert.equal(r.status, 200)
  // ⚠ 这条要在任何一次上报**之前**跑：所以它排在最前面，且下面那条会真的写一份。
  assert.equal(r.body.reading, null, '没收到过必须是 null：把"不知道"渲染成"没有差异"是这一族最坏的错')
  assert.equal(r.body.ageMs, null)
})

test('② ★★ 带令牌上报 ⇒ 存住；`GET` 立刻读得到，并且**看得到是哪个字段变了**', async () => {
  const w = await call('POST', '/api/model-materialization/reading', READING)
  assert.equal(w.status, 200, JSON.stringify(w.body).slice(0, 200))
  assert.equal(w.body.ok, true)

  const r = await call('GET', '/api/model-materialization')
  assert.equal(r.status, 200)
  assert.equal(r.body.reading.at, READING.at)
  assert.equal(r.body.reading.plan.counts.update, 1)
  assert.deepEqual(r.body.reading.plan.update[0], { id: 'svea-ds', fields: ['api'] },
    '★ 这一格就是"打开写入会改什么"的全部价值：只有计数的话，人仍然不知道该动哪里')
  assert.deepEqual(r.body.reading.plan.engineInternal, ['deepseek-official'])
  assert.equal(r.body.reading.gate.applyModelConfig, false, '门的状态要一起报（否则面板说不清"现在填了密钥会不会真的写进去"）')
  assert.ok(Number.isInteger(r.body.ageMs), '新鲜度要能看出来')
})

test('③ ★★ 不带令牌 ⇒ 403，且**不改动**已存的那一份', async () => {
  const before = (await call('GET', '/api/model-materialization')).body.reading.at
  const bad = await call('POST', '/api/model-materialization/reading', { ...READING, at: '1999-01-01T00:00:00.000Z' }, { withToken: false })
  assert.equal(bad.status, 403)
  assert.equal(bad.body.code, 'READING_REQUIRES_TOKEN')
  const after = (await call('GET', '/api/model-materialization')).body.reading.at
  assert.equal(after, before, '被拒的上报不许改动存量')
})

test('④ ★★★ 坏形状 ⇒ 具名 400（不静默存下"看起来没有差异"的一份）', async () => {
  const bads = [
    [{ ...READING, plan: { counts: {}, clean: true, update: [] } }, /counts\.create/],
    [{ ...READING, plan: { counts: { create: 0, update: 0, delete: 0, unchanged: 0 }, clean: true, update: [{ id: 'a' }] } }, /fields/],
    [{ ...READING, at: '' }, /at/],
  ]
  for (const [body, re] of bads) {
    const r = await call('POST', '/api/model-materialization/reading', body)
    assert.equal(r.status, 400, `没拒：${JSON.stringify(body).slice(0, 120)}`)
    assert.match(String(r.body.error ?? r.body.message ?? ''), re)
  }
})

test('⑤ ★ 读不出来的那一轮**照样上报**：面板因此能说"这次没读到 DSH"，而不是"没有差异"', async () => {
  const w = await call('POST', '/api/model-materialization/reading', {
    ...READING, actualReadOk: false, plan: null, line: '供应商影子对账：**读不到 DSH 现状** → 本次无法对账',
  })
  assert.equal(w.status, 200)
  const r = await call('GET', '/api/model-materialization')
  assert.equal(r.body.reading.actualReadOk, false)
  assert.equal(r.body.reading.plan, null)
  assert.match(r.body.reading.line, /读不到 DSH 现状/)
})
