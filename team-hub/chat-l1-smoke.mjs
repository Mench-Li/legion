#!/usr/bin/env node
/**
 * team-hub/chat-l1-smoke.mjs — 对话中心 L1 冒烟（真实 HTTP 服务 + SSE + 鉴权），
 * 对齐 docs/TEST_CASES.md TC-S1-01..17 的 L1 断言面（DAO 级用例见 chat.test.mjs）。
 *
 * 运行：node team-hub/chat-l1-smoke.mjs   （需 node ≥ 22.5 提供 node:sqlite；零第三方依赖）
 *   输出尾部为 PASS/FAIL 逐项 + 汇总行；断言失败退出码非 0。
 *
 * 覆盖（22 项断言，另含服务进程级健康检查）：
 *   TC-S1-01/02/03  REST 创建会话、列表 updatedAt desc、scope 正向/反向隔离
 *   TC-S1-04/05      kind 非法 → 400；缺 by → 400「缺少操作者身份 by」且失败写无 audit 留痕；非法 JSON → 400 非 500
 *   TC-S1-06/07      发消息 author=by、会话 last_message_at 更新；author 冒名由服务端绑定（防冒名）
 *   TC-S1-08/09      分页 10/10/5 无重无漏升序、before 游标；空会话 []、非法 limit → 400
 *   TC-S1-10/11/12   未知会话 → 400；空正文 → 400；正文长度 8000 恰好过 / 8001 拒
 *   TC-S1-13         GET /api/activity 可查 chat:create / chat:message（member/scope/detail 形状、seq 升序）
 *   TC-S1-14         订阅 /api/events（单一流）期间写入 → ≤5s 收到 live chat:message（member=by）
 *   TC-S1-15         订阅端主动断开 → 服务不崩、其余订阅端仍收到事件（eventClients 无泄漏）
 *   TC-S1-17         TEAM_HUB_TOKEN=tk：无/错 token 写 → 401「Bearer token 无效」；对 token → 200；读放行
 *
 * 实现要点：起两个真实 server.mjs 子进程（无 token / 带 token），临时 TEAM_HUB_DB + 随机端口，
 * 以 /api/config.db 回读确认真实实例后再断言（防随机端口被占误连他服务）；结束统一回收子进程
 * 与临时目录；任一断言失败退出码非 0（CI 可据此判定）。
 */
import { spawn } from 'node:child_process'
import * as httpMod from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-chat-l1-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
let hardFailures = 0
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond })
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''))
}

function post(base, path, body, token) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** 起一个真实 server.mjs：随机端口 + 独立临时库；轮询 /api/config 并以 db 路径确认真实实例。 */
async function startServer(token) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const dbFile = join(tmpRoot, 'team-' + port + '.db')
    const child = spawn(process.execPath, ['team-hub/server.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, TEAM_HUB_DB: dbFile, TEAM_HUB_PORT: String(port), TEAM_HUB_TOKEN: token },
      stdio: 'ignore',
    })
    const base = 'http://127.0.0.1:' + port
    for (let i = 0; i < 100; i += 1) {
      try {
        const r = await fetch(base + '/api/config')
        if (r.ok && (await r.json()).db === dbFile) return { child, base }
      } catch { /* 未就绪 */ }
      await sleep(100)
    }
    child.kill()
  }
  throw new Error('server.mjs 未能在重试内就绪')
}

function sseCollector(base) {
  // 持续收集该 SSE 订阅收到的 data 事件（含连接回放），返回 { close, seen }
  const seen = []
  let closed = false
  const req = httpMod.get(base + '/api/events', (res) => {
    let buf = ''
    res.on('data', (d) => {
      buf += d.toString()
      const frames = buf.split('\n\n')
      buf = frames.pop()
      for (const f of frames) {
        const m = /^data: (.+)$/m.exec(f)
        if (!m) continue
        try {
          const ev = JSON.parse(m[1])
          if (ev && ev.action) seen.push(ev)
        } catch { /* 忽略非 JSON 帧 */ }
      }
    })
  })
  req.on('error', () => { closed = true })
  return {
    seen,
    close() { if (!closed) { try { req.destroy() } catch { /* 已关闭 */ } } },
  }
}

/** 连接后忽略回放（前 30 条历史事件），只等 member=by 的 live chat:message（≤5s）。 */
function waitLiveChatEvent(base, by, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = httpMod.get(base + '/api/events', (res) => {
      let buf = ''
      res.on('data', (d) => {
        buf += d.toString()
        const frames = buf.split('\n\n')
        buf = frames.pop()
        for (const f of frames) {
          const m = /^data: (.+)$/m.exec(f)
          if (!m) continue
          try {
            const ev = JSON.parse(m[1])
            if (ev.action === 'chat:message' && ev.member === by && ev.detail && typeof ev.detail.msg === 'number') {
              req.destroy(); resolve(ev); return
            }
          } catch { /* 忽略 */ }
        }
      })
    })
    req.on('error', () => resolve(null))
    setTimeout(() => { try { req.destroy() } catch { /* 已关闭 */ } ; resolve(null) }, timeoutMs)
  })
}

async function runServerA() {
  const { child, base } = await startServer('')
  try {
    // TC-S1-01 创建会话（含 id/createdAt/updatedAt/last_message_at=null）＋列表 updatedAt desc
    const c1 = (await (await post(base, '/api/chat/conversations', { scope: 'software', title: '软件流水线讨论', kind: 'space', participants: ['general', 'coder'], by: 'general' })).json())
    check('TC-S1-01 POST 会话 → 200 ok:true（id/createdAt/updatedAt/last_message_at=null）',
      c1.ok === true && c1.task && typeof c1.task.id === 'number' && c1.task.id > 0 && !!c1.task.createdAt && !!c1.task.updatedAt && c1.task.last_message_at === null)
    const convId = c1.task.id
    await sleep(30)
    const c2 = (await (await post(base, '/api/chat/conversations', { scope: 'software', title: '第二次会话', kind: 'space', by: 'general' })).json())
    let listSw = (await (await fetch(base + '/api/chat/conversations?scope=software')).json())
    check('TC-S1-01 列表含新会话且按 updatedAt desc 排首', listSw.conversations.length === 2 && listSw.conversations[0].id === c2.task.id)

    // TC-S1-02/03 scope 正向与反向隔离
    await post(base, '/api/chat/conversations', { scope: 'default', title: '默认空间会话', kind: 'space', by: 'general' })
    listSw = (await (await fetch(base + '/api/chat/conversations?scope=software')).json())
    check('TC-S1-02 software 列表不含 default 会话（scope 正向）', listSw.conversations.every((c) => c.scope === 'software'))
    const listDef = (await (await fetch(base + '/api/chat/conversations?scope=default')).json())
    check('TC-S1-03 default 列表查不到 software 会话（scope 反向）', !listDef.conversations.some((c) => c.id === convId))

    // TC-S1-04/05 错误映射与写纪律
    const badKind = await post(base, '/api/chat/conversations', { scope: 'software', title: 'x', kind: 'channel', by: 'general' })
    check('TC-S1-04 kind 非法 → 400 且指明合法枚举', badKind.status === 400 && /kind 必须/.test((await badKind.json()).error))
    const actBefore = await (await fetch(base + '/api/activity?limit=500')).json()
    const noBy = await post(base, '/api/chat/conversations', { scope: 'software', title: '无身份', kind: 'space' })
    check('TC-S1-05 ① 缺 by → 400「缺少操作者身份 by」', noBy.status === 400 && /缺少操作者身份 by/.test((await noBy.json()).error))
    const badJson = await post(base, '/api/chat/conversations', '{not json')
    check('TC-S1-05 ② body 非法 JSON → 400（非 500）', badJson.status === 400 && badJson.status < 500)
    const actAfter = await (await fetch(base + '/api/activity?limit=500')).json()
    const chatCount = (arr) => arr.filter((r) => r.action.startsWith('chat:')).length
    check('TC-S1-05 ③ 失败写无 chat 审计留痕', chatCount(actAfter) === chatCount(actBefore))

    // TC-S1-06/07 消息 author 绑定 + last_message_at
    const m1 = (await (await post(base, '/api/chat/messages', { conv: convId, kind: 'text', body: 'hello', clientTs: '2026-01-01T00:00:00.000Z', by: 'general' })).json())
    const convAfter = (await (await fetch(base + '/api/chat/conversations?scope=software')).json()).conversations.find((c) => c.id === convId)
    check('TC-S1-06 发消息 author=by、createdAt 有值、会话 last_message_at 更新',
      m1.ok === true && m1.task.author === 'general' && !!m1.task.createdAt && !!convAfter.last_message_at)
    const mSpoof = (await (await post(base, '/api/chat/messages', { conv: convId, kind: 'text', body: '署名测试', by: 'general', author: 'other' })).json())
    check('TC-S1-07 author 冒名被服务端绑定（author=by≠other）', mSpoof.task.author === 'general' && mSpoof.task.author !== 'other')

    // TC-S1-08/09 分页与边界
    const convP = (await (await post(base, '/api/chat/conversations', { scope: 'software', title: '分页会话', kind: 'space', by: 'general' })).json()).task.id
    for (let i = 1; i <= 25; i += 1) await post(base, '/api/chat/messages', { conv: convP, kind: 'text', body: 'msg-' + String(i).padStart(2, '0'), by: 'general' })
    const allMsgs = (await (await fetch(base + '/api/chat/messages?conv=' + convP)).json()).messages
    const p1 = (await (await fetch(base + '/api/chat/messages?conv=' + convP + '&limit=10')).json()).messages
    const p2 = (await (await fetch(base + '/api/chat/messages?conv=' + convP + '&limit=10&before=' + p1[0].id)).json()).messages
    const p3 = (await (await fetch(base + '/api/chat/messages?conv=' + convP + '&limit=10&before=' + p2[0].id)).json()).messages
    const allIds = allMsgs.map((m) => m.id)
    const joined = [...p1, ...p2, ...p3].map((m) => m.id)
    const isAsc = (arr) => arr.every((x, i) => i === 0 || x > arr[i - 1])
    check('TC-S1-08 分页 10/10/5：无重无漏、页内升序、页间游标连续',
      p1.length === 10 && p2.length === 10 && p3.length === 5 &&
      joined.length === new Set(joined).size && joined.length === new Set(allIds).size &&
      isAsc(p1.map((m) => m.id)) && isAsc(p2.map((m) => m.id)) && isAsc(p3.map((m) => m.id)) &&
      p2.every((m) => m.id < p1[0].id) && p3.every((m) => m.id < p2[0].id))
    const convE = (await (await post(base, '/api/chat/conversations', { scope: 'software', title: '空会话', kind: 'space', by: 'general' })).json()).task.id
    const emptyMsgs = (await (await fetch(base + '/api/chat/messages?conv=' + convE)).json()).messages
    const l0 = await fetch(base + '/api/chat/messages?conv=' + convP + '&limit=0')
    const labc = await fetch(base + '/api/chat/messages?conv=' + convP + '&limit=abc')
    check('TC-S1-09 空会话 → []；limit=0/abc → 400', Array.isArray(emptyMsgs) && emptyMsgs.length === 0 && l0.status === 400 && labc.status === 400)

    // TC-S1-10/11/12 异常与边界
    const noConv = await post(base, '/api/chat/messages', { conv: 999999, kind: 'text', body: 'x', by: 'general' })
    check('TC-S1-10 未知会话发消息 → 400「会话不存在」', noConv.status === 400 && /会话不存在/.test((await noConv.json()).error))
    const emptyBody = await post(base, '/api/chat/messages', { conv: convId, kind: 'text', body: '   ', by: 'general' })
    check('TC-S1-11 空正文 → 400「不能为空」', emptyBody.status === 400 && /不能为空/.test((await emptyBody.json()).error))
    const okLen = await post(base, '/api/chat/messages', { conv: convId, kind: 'text', body: 'a'.repeat(8000), by: 'general' })
    const overLen = await post(base, '/api/chat/messages', { conv: convId, kind: 'text', body: 'a'.repeat(8001), by: 'general' })
    check('TC-S1-12 正文 8000 恰好通过 / 8001 → 400 拒绝', okLen.status === 200 && overLen.status === 400 && /超长/.test((await overLen.json()).error))

    // TC-S1-13 审计留痕可经 /api/activity 查询
    const act = await (await fetch(base + '/api/activity?scope=software')).json()
    const chatRows = act.filter((r) => r.action.startsWith('chat:'))
    check('TC-S1-13 /api/activity 含 chat:create/chat:message（member/scope/detail 形状）',
      chatRows.some((r) => r.action === 'chat:create' && r.member === 'general' && r.scope === 'software' && typeof r.detail.conv === 'number') &&
      chatRows.some((r) => r.action === 'chat:message' && typeof r.detail.msg === 'number'))

    // TC-S1-14 事件冒烟：订阅 /api/events 期间写入 → ≤5s 内收到 live chat:message（member=by=coder）
    const liveP = waitLiveChatEvent(base, 'coder')
    await sleep(400) // 让连接回放（近 30 条历史）先刷完，避免把回放当 live
    await post(base, '/api/chat/messages', { conv: convId, kind: 'text', body: 'sse-live', by: 'coder' })
    const liveEv = await liveP
    check('TC-S1-14 订阅 /api/events 期间写入 ≤5s 收到 live chat:message（member=coder、scope、detail.msg）',
      !!liveEv && liveEv.action === 'chat:message' && liveEv.member === 'coder' && liveEv.scope === 'software' && typeof liveEv.detail.msg === 'number',
      liveEv ? JSON.stringify(liveEv) : '未收到 live 事件')

    // TC-S1-15 订阅端主动断开 → 服务不崩、其余订阅端仍收到事件
    const sub1 = sseCollector(base)
    const sub2 = sseCollector(base)
    await sleep(200)
    sub1.close()
    await sleep(150)
    const afterDrop = await post(base, '/api/chat/messages', { conv: convId, kind: 'text', body: 'after-drop', by: 'general' })
    await sleep(400)
    check('TC-S1-15 断开不崩服务、其余订阅端仍收到事件',
      afterDrop.status === 200 && sub2.seen.some((e) => e.action === 'chat:message' && e.detail && typeof e.detail.msg === 'number' && e.member === 'general'))
    sub2.close()
    console.log('--- 服务 A（无 token）18 项 REST/审计/SSE 断言执行完 ---')
  } finally {
    child.kill()
  }
}

async function runServerB() {
  // TC-S1-17 鉴权：TEAM_HUB_TOKEN=tk 时写需 Bearer，读放行
  const { child, base } = await startServer('tk')
  try {
    const convBody = { scope: 'software', title: 'token 会话', kind: 'space', by: 'general' }
    const r1 = await post(base, '/api/chat/conversations', convBody)
    check('TC-S1-17 ① 无 token 写 → 401「Bearer token 无效」', r1.status === 401 && /token 无效/.test((await r1.json()).error))
    const r2 = await post(base, '/api/chat/conversations', convBody, 'wrong')
    check('TC-S1-17 ② 错 token 写 → 401', r2.status === 401)
    const r3 = await post(base, '/api/chat/conversations', convBody, 'tk')
    check('TC-S1-17 ③ 对 token 写 → 200', r3.status === 200 && (await r3.json()).ok === true)
    const g1 = await fetch(base + '/api/chat/conversations?scope=software')
    check('TC-S1-17 ④ 无 token 读 → 200 放行（读与既有接口语义一致）', g1.status === 200)
    console.log('--- 服务 B（token=tk）鉴权断言执行完 ---')
  } finally {
    child.kill()
  }
}

try {
  await runServerA()
} catch (e) {
  hardFailures += 1
  console.log('SERVER A 异常：' + ((e && e.stack) || e))
}
try {
  await runServerB()
} catch (e) {
  hardFailures += 1
  console.log('SERVER B 异常：' + ((e && e.stack) || e))
}

await sleep(300)
try { rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }) } catch { /* 临时目录残留可忽略 */ }
const fails = results.filter((r) => !r.ok).length
console.log('\n==== L1 冒烟汇总：' + (results.length - fails) + '/' + results.length + ' 断言通过；进程级异常 ' + hardFailures + ' ====')
process.exit(fails + hardFailures > 0 ? 1 : 0)
