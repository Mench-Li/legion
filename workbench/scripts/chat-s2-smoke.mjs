#!/usr/bin/env node
/**
 * workbench/scripts/chat-s2-smoke.mjs — 对话中心（S2 ChatView + 接线）L1 冒烟。
 * 真实起两个服务：
 *   ① team-hub v2（server.mjs，随机端口 + 临时库）＝ 对话/SSE 数据源；
 *   ② workbench 生产静态服务（scripts/serve.mjs，随机端口 + DSH_HUB_UPSTREAM→①）＝ :5173 同款宿主。
 * 客户端一律走 http://127.0.0.1:<servePort>/hub/...（浏览器 ChatView 的 hubBase() 默认路径），
 * 覆盖 S2 主路径与实时收发的**HTTP/SSE 数据面**（GUI 渲染项见 docs/T047-evidence/README.md L2 清单）：
 *   S2-A   GET /（SPA 入口，serve.mjs 托管产物）→ 200 html            [S2 AC3 浏览器入口]
 *   S2-B   GET /hub/api/config（同源 /hub 反向代理）→ 200              [AC4 单一 /hub 源]
 *   S2-C   会话列表空态（新空间可建）                                    [TC-S2-02]
 *   S2-D   POST /hub/api/chat/conversations 新建会话 → ok+task          [TC-S2-02]
 *   S2-E   连发 60 条消息 + 会话 last_message_at/updatedAt 更新          [TC-S2-02/10③]
 *   S2-F   分页：limit=50 最新升序 + before=最旧向前翻 → 60 条无重无漏    [TC-S2-04 完整历史 / P1-4]
 *   S2-G   scope 隔离：software/ops 两空间会话列表双向不含对方            [TC-S2-05 / I4]
 *   S2-H   双订阅（都经 /hub/api/events）POST 新消息 → 双方 ≤5s 收到同一 live chat:message
 *          （第二标签页 ≤15s 实时收发的数据面等价；hub 事件源仍只有这一个） [TC-S2-03 / TC-S2-08 / I8]
 * 断言失败退出码非 0；node ≥ 22.5（node:sqlite）；零第三方依赖；子进程 stdio:ignore（沙箱允许）。
 */
import { spawn } from 'node:child_process'
import * as httpMod from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)) // …/workbench/scripts
const REPO = join(HERE, '..', '..')
const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-chat-s2-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond })
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''))
}

async function postJson(base, path, body) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await r.json().catch(() => null)
  return { status: r.status, data }
}

/** 起 server.mjs：随机端口 + 独立临时库；轮询 /api/config 以 db 路径确认真实实例。 */
async function startHub() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const dbFile = join(tmpRoot, 'hub-' + port + '.db')
    const child = spawn(process.execPath, [join(REPO, 'team-hub', 'server.mjs')], {
      cwd: REPO,
      env: { ...process.env, TEAM_HUB_DB: dbFile, TEAM_HUB_PORT: String(port), TEAM_HUB_TOKEN: '' },
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
  throw new Error('team-hub 未能在重试内就绪')
}

/** 起 serve.mjs（:5173 同款宿主）：DSH_HUB_UPSTREAM 指向测试中枢。 */
async function startHost(hubBase) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const port = 30000 + Math.floor(Math.random() * 15000)
    const child = spawn(process.execPath, [join(REPO, 'workbench', 'scripts', 'serve.mjs'), '--port', String(port)], {
      cwd: join(REPO, 'workbench'),
      env: { ...process.env, DSH_HUB_UPSTREAM: hubBase, DSH_WORKBENCH_PORT: String(port) },
      stdio: 'ignore',
    })
    const base = 'http://127.0.0.1:' + port
    for (let i = 0; i < 100; i += 1) {
      try {
        const r = await fetch(base + '/hub/api/config')
        if (r.ok) return { child, base }
      } catch { /* 未就绪 */ }
      await sleep(100)
    }
    child.kill()
  }
  throw new Error('serve.mjs 未能在重试内就绪')
}

/** 经指定 base 订阅 /api/events（收集 data 帧，仅保留 chat:*），返回 { seen, close }。 */
function sseChatCollector(base) {
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
          if (ev && typeof ev.action === 'string' && ev.action.startsWith('chat:')) seen.push(ev)
        } catch { /* 忽略非 JSON 帧 */ }
      }
    })
  })
  req.on('error', () => { closed = true })
  return {
    seen,
    /** 等待 detail.msg 命中指定消息 id 的 live chat:message（≤timeoutMs）。 */
    waitMsg(msgId, timeoutMs = 5000) {
      const t0 = Date.now()
      return new Promise((resolve) => {
        const timer = setInterval(() => {
          const hit = seen.find(e => e.action === 'chat:message' && Number(e.detail?.msg) === msgId)
          if (hit) { clearInterval(timer); resolve(hit); return }
          if (Date.now() - t0 > timeoutMs) { clearInterval(timer); resolve(null) }
        }, 60)
      })
    },
    close() { if (!closed) { try { req.destroy() } catch { /* 已关闭 */ } } },
  }
}

const hub = await startHub()
const host = await startHost(hub.base)
const children = [hub.child, host.child]
let exitCode = 0
try {
  // S2-A：浏览器主路径入口（SPA index.html 由 serve.mjs 托管）
  try {
    const idx = await fetch(host.base + '/')
    const ct = idx.headers.get('content-type') ?? ''
    check('S2-A GET / → 200 + html（:5173 产物入口）', idx.status === 200 && ct.includes('text/html'), 'status=' + idx.status)
  } catch (e) {
    check('S2-A GET / → 200 + html（:5173 产物入口）', false, String(e.message ?? e))
  }

  // S2-B：同源 /hub 反向代理可达（ChatView hubBase() 默认 '/hub'）
  const cfg = await fetch(host.base + '/hub/api/config')
  check('S2-B GET /hub/api/config → 200（单一 /hub 源代理）', cfg.status === 200, 'status=' + cfg.status)

  // S2-C：新空间会话空态（可建）
  const emptyList = await (await fetch(host.base + '/hub/api/chat/conversations?scope=software')).json()
  check('S2-C 空库会话列表 = []（空态可建）', Array.isArray(emptyList.conversations) && emptyList.conversations.length === 0)

  // S2-D：新建会话（写纪律 by 必填 → hub 侧由工作台注入 by=general；响应 {ok:true, task}）
  const c1 = await postJson(host.base, '/hub/api/chat/conversations', { scope: 'software', title: 'S2 主路径冒烟会话', kind: 'space', by: 'general' })
  const convId = c1.data?.task?.id
  check('S2-D POST 会话 → 200 ok:true task{id,title,kind,last_message_at:null}',
    c1.status === 200 && c1.data?.ok === true && typeof convId === 'number' && c1.data.task.title === 'S2 主路径冒烟会话'
      && c1.data.task.kind === 'space' && c1.data.task.last_message_at === null,
    'conv=' + convId)

  // S2-E：连发 60 条消息；会话 last_message_at/updatedAt 随写更新
  const posted = []
  for (let i = 1; i <= 60; i += 1) {
    const body = 'S2-冒烟消息 #' + i + '：纯文本内容（<script>alert(1)</script> 仅作文本样例）'
    const m = await postJson(host.base, '/hub/api/chat/messages', { conv: convId, body, kind: 'text', clientTs: new Date().toISOString(), by: 'general' })
    if (m.status !== 200 || !m.data?.task) throw new Error('POST 消息失败 #' + i + ' status=' + m.status)
    posted.push(m.data.task)
  }
  const ids = posted.map(m => m.id)
  const ascStrict = ids.every((id, ix) => ix === 0 || id > ids[ix - 1])
  const afterList = await (await fetch(host.base + '/hub/api/chat/conversations?scope=software')).json()
  const afterConv = afterList.conversations.find(c => c.id === convId)
  check('S2-E 连发 60 条全部 200 且 id 严格升序 + 会话 last_message_at 更新',
    posted.length === 60 && ascStrict && !!afterConv && afterConv.last_message_at !== null,
    'min=' + ids[0] + ' max=' + ids[59])

  // S2-F：分页「加载更早」数据面 —— 最近 50 条 + before=最旧 向前翻 → 60 条无重无漏（P1-4 / TC-S2-04）
  const page1 = (await (await fetch(host.base + '/hub/api/chat/messages?conv=' + convId + '&limit=50')).json()).messages
  const oldest = page1[0].id
  const page2 = (await (await fetch(host.base + '/hub/api/chat/messages?conv=' + convId + '&limit=50&before=' + oldest)).json()).messages
  const allIds = [...page2.map(m => m.id), ...page1.map(m => m.id)]
  const unique = new Set(allIds)
  const contig = allIds.length === 60 && unique.size === 60 && allIds[59] === ids[59] && allIds[0] === ids[0]
    && allIds.every((id, ix) => ix === 0 || id === allIds[ix - 1] + 1)
  check('S2-F 分页 50+10 无重无漏、页内升序、页间连续（=ChatView 加载更早的数据面）',
    page1.length === 50 && page2.length === 10 && contig,
    'p1=' + page1.length + ' p2=' + page2.length)

  // S2-G：scope 隔离（software 与 ops 两空间互不可见；反向断言）
  await postJson(host.base, '/hub/api/chat/conversations', { scope: 'ops', title: '运营空间会话', kind: 'space', by: 'general' })
  const softList = (await (await fetch(host.base + '/hub/api/chat/conversations?scope=software')).json()).conversations
  const opsList = (await (await fetch(host.base + '/hub/api/chat/conversations?scope=ops')).json()).conversations
  check('S2-G scope 隔离：software/ops 列表各自独立互不含对方（TC-S2-05 数据面）',
    softList.length === 1 && softList[0].scope === 'software' && opsList.length === 1 && opsList[0].scope === 'ops')

  // S2-H：实时 —— 两个订阅（均经 /hub 代理的单一 /api/events）都 ≤5s 收到同一 live chat:message
  const subA = sseChatCollector(host.base + '/hub')
  const subB = sseChatCollector(host.base + '/hub')
  await sleep(400) // 确保两订阅已就绪
  const live = await postJson(host.base, '/hub/api/chat/messages', { conv: convId, body: 'S2-实时：第二标签页应收到本消息', kind: 'text', by: 'general' })
  const liveId = live.data?.task?.id
  const gotA = liveId !== undefined ? await subA.waitMsg(liveId, 5000) : null
  const gotB = liveId !== undefined ? await subB.waitMsg(liveId, 5000) : null
  check('S2-H 双订阅 ≤5s 收到同一 live chat:message（≤15s 实时收发的数据面等价）',
    !!gotA && !!gotB && gotA.detail.msg === liveId && gotB.detail.msg === liveId,
    'msg=' + liveId)
  check('S2-H2 事件 action 前缀 chat:（前端 filter chat:* 依据；hub 事件源仅此一个）',
    gotA?.action === 'chat:message' && gotA.scope === 'software' && gotA.member === 'general')
  subA.close()
  subB.close()

  // 汇总
  const failed = results.filter(r => !r.ok)
  console.log('')
  console.log('S2 L1 冒烟汇总：' + (results.length - failed.length) + '/' + results.length + ' 断言通过' + (failed.length ? '，失败：' + failed.map(f => f.name).join('；') : ''))
  exitCode = failed.length ? 1 : 0
} catch (e) {
  console.error('S2 L1 冒烟异常中断：', e)
  exitCode = 2
} finally {
  for (const c of children) { try { c.kill() } catch { /* 已退出 */ } }
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 清理尽力 */ }
}
process.exit(exitCode)
