#!/usr/bin/env node
/**
 * T-125 tester 证据脚本：S2 对话健康端点 + AI 回复生命周期（隔离 hub，HTTP 级 E2E 复现）
 * 场景：A) 空库基线健康形状；B) M1 跨 scope 误报复现（别空间 worker 心跳令本 scope 假绿 + 模型泄漏）；
 *       C) 本 scope 心跳 → 在线为正例；D) M2 最近失败不随后续成功消除（恒红数据面）+ 存量旧笼统文案透出；
 *       E) fail→retry→answer 生命周期正向（回复/不重复/队列退出）。
 * 运行：node docs/G-mtr3su6f-1/T125-evidence/repro-health-m1m2.mjs  （零第三方依赖；node>=22.5）
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = process.cwd()
const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-t125-repro-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rows = []
const check = (name, actual) => { rows.push({ name, ...actual }); console.log((actual.pass ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + JSON.stringify(actual.got)) }

async function post(base, path, body, token) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  })
  let data = null; try { data = await r.json() } catch { /* no body */ }
  return { status: r.status, data }
}
const get = async (base, path) => { const r = await fetch(base + path); let d = null; try { d = await r.json() } catch {} ; return { status: r.status, data: d } }

async function startHub() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const dbFile = join(tmpRoot, 'hub-' + port + '.db')
    const child = spawn(process.execPath, ['team-hub/server.mjs'], {
      cwd: REPO,
      env: { ...process.env, TEAM_HUB_DB: dbFile, TEAM_HUB_PORT: String(port), TEAM_HUB_TOKEN: '' },
      stdio: 'ignore',
    })
    const base = 'http://127.0.0.1:' + port
    for (let i = 0; i < 100; i += 1) {
      try { const r = await fetch(base + '/api/config'); if (r.ok && (await r.json()).db === dbFile) return { child, base } } catch { /* not ready */ }
      await sleep(100)
    }
    child.kill()
  }
  throw new Error('hub not ready')
}

const { child, base } = await startHub()
try {
  // A) 空库基线
  let h = (await get(base, '/api/chat/health?scope=alpha')).data
  check('A1 空库 health?scope=alpha：online=false enabled=true model=null lastFail=null（形状）', {
    pass: h.scope === 'alpha' && h.online === false && h.enabled === true && h.model === null && h.modelResolved === false && h.lastFail === null && typeof h.okAt === 'string' && typeof h.honestNote === 'string',
    got: JSON.stringify(h),
  })

  // B) M1：只有 beta 空间守护心跳（kind=worker 新鲜），问 alpha 健康
  await post(base, '/api/heartbeat', { by: 'worker@beta', scope: 'beta', kind: 'worker', model: { provider: 'fake-prov', model: 'beta-model' } })
  h = (await get(base, '/api/chat/health?scope=alpha')).data
  check('B1 M1复现 alpha 无本空间 worker：online 应=false（别空间心跳不得令 alpha 假绿）', {
    pass: h.online === false,
    got: JSON.stringify({ online: h.online, daemon: h.daemon }),
  })
  check('B2 M1复现 alpha model 兜底不应取 beta 守护心跳模型（跨 scope 泄漏）', {
    pass: h.model === null && h.modelResolved === false,
    got: JSON.stringify({ model: h.model, modelResolved: h.modelResolved }),
  })

  // C) 正例：alpha 自己心跳 → 在线 + model 解析自本 scope
  await post(base, '/api/heartbeat', { by: 'worker@alpha', scope: 'alpha', kind: 'worker', model: { provider: 'fake-prov', model: 'alpha-model' } })
  h = (await get(base, '/api/chat/health?scope=alpha')).data
  check('C1 alpha 本空间心跳后 online=true 且 daemon.member=worker@alpha', {
    pass: h.online === true && h.daemon && h.daemon.member === 'worker@alpha',
    got: JSON.stringify({ online: h.online, daemon: h.daemon }),
  })
  check('C2 model 解析链 daemon-heartbeat 兜底取本 scope 行（alpha-model）', {
    pass: h.model && h.model.model === 'alpha-model' && h.model.source === 'daemon-heartbeat' && h.modelResolved === true,
    got: JSON.stringify(h.model),
  })

  // D) M2：历史 failed 不随后续成功消除 + 存量旧笼统文案透出
  const cv = (await post(base, '/api/chat/conversations', { scope: 'alpha', title: 'repro', kind: 'space', by: 'general' })).data.task.id
  const m1 = (await post(base, '/api/chat/messages', { conv: cv, kind: 'text', body: '帮我总结一下', by: 'general' })).data.task
  check('D1 发消息 → meta.aiStatus=awaiting 入队', { pass: m1.meta.aiStatus === 'awaiting', got: JSON.stringify(m1.meta) })
  const f1 = await post(base, '/api/chat/replies/fail', { msgId: m1.id, by: 'alpha-assistant', error: '回复子代理未完成（error）' })
  const m1a = (await get(base, '/api/chat/messages?conv=' + cv)).data.messages.find((x) => x.id === m1.id)
  check('D2 fail 回写 → aiStatus=failed，error 原文入 meta.aiError（旧笼统文案存量语义）', {
    pass: f1.status === 200 && m1a.meta.aiStatus === 'failed' && m1a.meta.aiError === '回复子代理未完成（error）',
    got: JSON.stringify(m1a.meta),
  })
  const m2 = (await post(base, '/api/chat/messages', { conv: cv, kind: 'text', body: '第二条问题', by: 'general' })).data.task
  const a2 = await post(base, '/api/chat/replies/answer', { msgId: m2.id, body: '这是成功回复（alpha-assistant）', by: 'alpha-assistant', model: 'alpha-model' })
  const m2a = (await get(base, '/api/chat/messages?conv=' + cv)).data.messages.find((x) => x.id === m2.id)
  const d3replies = (await get(base, '/api/chat/messages?conv=' + cv)).data.messages
  check('D3 后发消息 answer 成功 → 源消息 replied（replyMsg 引用回复行）+ 恰一条 assistant 回复', {
    pass: a2.status === 200 && m2a.meta.aiStatus === 'replied' && typeof m2a.meta.replyMsg === 'number' && d3replies.filter((x) => x.author === 'alpha-assistant').length === 1,
    got: JSON.stringify({ meta: m2a.meta, assistantReplies: d3replies.filter((x) => x.author === 'alpha-assistant').length }),
  })
  h = (await get(base, '/api/chat/health?scope=alpha')).data
  check('D4 M2复现 最近成功 replied 之后 lastFail 应消除（按四态设计绿可达）；现实现仍透出旧 failed 与旧笼统文案', {
    pass: h.lastFail === null,
    got: JSON.stringify(h.lastFail),
  })

  // E) retry 生命周期：failed 源消息可 retry → awaiting → answer → replied 幂等
  const r1 = await post(base, '/api/chat/replies/retry', { msgId: m1.id, by: 'general' })
  const m1b = (await get(base, '/api/chat/messages?conv=' + cv)).data.messages.find((x) => x.id === m1.id)
  const q = (await get(base, '/api/chat/replies?scope=alpha')).data.messages
  check('E1 retry → 源消息回 awaiting 且重新入队', {
    pass: r1.status === 200 && m1b.meta.aiStatus === 'awaiting' && q.some((x) => x.id === m1.id),
    got: JSON.stringify({ retryStatus: r1.status, meta: m1b.meta, inQueue: q.some((x) => x.id === m1.id) }),
  })
  const a1 = await post(base, '/api/chat/replies/answer', { msgId: m1.id, body: '重试后的成功回复', by: 'alpha-assistant', model: 'alpha-model' })
  const m1c = (await get(base, '/api/chat/messages?conv=' + cv)).data.messages.find((x) => x.id === m1.id)
  const q2 = (await get(base, '/api/chat/replies?scope=alpha')).data.messages
  check('E2 retry 后 answer → replied；重复 answer 幂等（skipped 不重复）；队列退出', {
    pass: a1.status === 200 && m1c.meta.aiStatus === 'replied' && !q2.some((x) => x.id === m1.id),
    got: JSON.stringify({ a1: a1.status, meta: m1c.meta, inQueue: q2.some((x) => x.id === m1.id) }),
  })
  const again = await post(base, '/api/chat/replies/answer', { msgId: m1.id, body: '重复回复', by: 'alpha-assistant', model: 'alpha-model' })
  check('E3 已 replied 消息再 answer → task.skipped=true 幂等无重复', {
    pass: again.status === 200 && again.data && again.data.task && again.data.task.skipped === true,
    got: JSON.stringify(again.data),
  })
  const replies = (await get(base, '/api/chat/messages?conv=' + cv)).data.messages.filter((x) => x.author === 'alpha-assistant').length
  check('E4 全程 alpha-assistant 回复恰 2 条（无重复无多写）', { pass: replies === 2, got: 'count=' + replies })

  const failed = rows.filter((r) => !r.pass)
  console.log('\n==== 复现汇总 ====')
  console.log('总断言 ' + rows.length + '，预期成立 PASS ' + rows.filter(r => r.pass).length + '，行为复现(FAIL=缺陷现形) ' + failed.length)
  for (const f of failed) console.log('  [复现] ' + f.name)
} finally {
  child.kill()
  await sleep(300)
  rmSync(tmpRoot, { recursive: true, force: true })
}
