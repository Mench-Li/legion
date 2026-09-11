/**
 * notify-hub-smoke.test.mjs — P2-4 通知中心端到端（真实 team-hub v2 数据面 + 真实 SSE + IO 层）。
 *
 * 与 notify.test.mjs（纯函数）互补：这里起**真实** team-hub 进程，用 workbench 真实的 api.ts
 * （stub window/localStorage）跑完整链路，验证：
 *   ① 数据面：审计事件 → 通知项（白名单过滤真有过滤效果：原始就含 chat:*，通知列表不含）；
 *   ② 分类/优先级/跳转：真实 transition→blocked 为 high、goal:publish 跳目标、skill 分类；
 *   ③ 已读 IO 层：markNotifyRead/markAllNotifyRead 写本机存储、未读计数随之变化；
 *   ④ **反向断言**：已读与列表操作期间服务端 audit 零新行（TC-S7-05：已读不写服务端）；
 *   ⑤ 实时：真实 /api/events SSE 帧到达 → 去重合并 + 全局水位；
 *   ⑥ 断线恢复：kill 服务 → 状态上报重连中 → 重启 → 同实例自动重连（opens=2 → reconnected）。
 */
import { test, after as afterAll } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = join(ROOT, 'team-hub', 'server.mjs')

/** 已启动的 hub 子进程登记表。
 *  为什么需要它：本文件会起真实服务进程。`node --test` 的**实测语义**（2026-09-11 三文件哨兵实验）：
 *  文件**并行**执行，且一个文件的结果在它的**用例跑完时**就输出——**不等**该文件进程退出。
 *  因此「日志里已看到本文件的 2 个用例通过」**不能**推出「本文件的进程已退出」。
 *  历史事故（P2-7）与「候选 #3：notify 曾超时一次」属于同一类：**用例全绿，但进程不退出**。
 *  所以这里把「子进程 / SSE 订阅 / 就绪轮询」三类句柄全部登记，并在文件结束时兜底自检，
 *  把「静默卡死」（整份套件被 300s 上限杀掉、其余套件基线一起丢掉）变成「明确失败」。 */
const LIVE_CHILDREN = new Set()

/** 已建立的 SSE 订阅登记表。MiniEventSource 断线后每 300ms **无上限**重连（对齐浏览器语义），
 *  只要有一个没关，事件循环就永远不空 → 进程不退出。 */
const LIVE_SUBSCRIPTIONS = new Set()

/** 仍在运行的就绪轮询登记表。轮询是一个递归的 pending Timeout，同样会让进程无法退出。 */
const LIVE_WAITS = new Set()

/** 登记一个取消订阅函数，返回一个「关闭并注销」的包装（可重复调用）。 */
function trackSubscription(off) {
  LIVE_SUBSCRIPTIONS.add(off)
  return () => {
    if (!LIVE_SUBSCRIPTIONS.delete(off)) return false
    try { off() } catch { /* 关闭失败不应影响断言结论 */ }
    return true
  }
}

/** 关闭全部遗留订阅，返回仍未关闭的数量（应恒为 0）。 */
function sweepSubscriptions() {
  for (const off of [...LIVE_SUBSCRIPTIONS]) { LIVE_SUBSCRIPTIONS.delete(off); try { off() } catch { /* ignore */ } }
  return LIVE_SUBSCRIPTIONS.size
}

/** 有界、**可取消**的「等服务就绪」轮询。
 *  为什么不用裸递归 setTimeout（旧实现的三个缺陷）：
 *   ① **就绪后不停**：每个 tick 的 finally 只要没到 15s 就再排一个 tick，于是连上之后仍每 120ms
 *      打一次 HTTP 直到期限（哨兵实测 41 次 tick），并留下一个始终 pending 的 Timeout；
 *   ② 超时后调 `reject` 在已 resolve 的 promise 上是空操作，反而掩盖了「还在轮询」这一事实；
 *   ③ **每次请求没有上界**：旧实现直接 `fetch(...)`，而 undici 的 `headersTimeout` 默认 **300s**——
 *      若 hub 已 accept 却迟迟不回响应（重负载下事件循环被阻塞、或进程在错误的时刻被杀），
 *      那个请求会挂到 ~300s，**恰好等于套件级硬上限**。它是 fire-and-forget 的后台轮询，
 *      所以测试本身照常全绿，而进程因为还挂着一个未结请求而无法退出 —— 这正是「候选 #3」记录的症状。
 *  新实现：就绪即 `stop()`；超时即 `stop()` 再抛；**每个请求带 `AbortSignal.timeout`**，
 *  任何一次探测都不可能超过 `perRequestMs`；tick 计数与停止状态可被断言（见文末回归用例）。 */
function waitForReady(url, { timeoutMs = 15000, intervalMs = 120, perRequestMs = null, label = 'hub' } = {}) {
  const reqCap = perRequestMs ?? Math.max(1000, intervalMs * 10)
  const t0 = Date.now()
  let ticks = 0
  let stopped = false
  let lastErr = ''
  const stop = () => { stopped = true }
  const promise = (async () => {
    while (!stopped) {
      ticks += 1
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(reqCap) })
        if (r.ok) { stop(); return }
      } catch (e) { lastErr = (e && e.message) || String(e) }
      if (Date.now() - t0 > timeoutMs) { stop(); throw new Error(label + ' boot timeout: ' + lastErr.slice(-300)) }
      if (!stopped) await sleep(intervalMs)
    }
  })()
  return { promise, stop, ticks: () => ticks, stopped: () => stopped }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等待子进程**真正退出**：`kill()` 只保证「信号已发出」，不代表进程已消失。
 *  宽限期内没退出就升级 SIGKILL（Windows 上 SIGTERM 若被忽略，只有强杀能回收）。 */
async function killChild(child, graceMs = 3000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true
  const exited = new Promise((r) => child.once('exit', () => r(true)))
  try { child.kill() } catch { /* ignore */ }
  if (await Promise.race([exited, sleep(graceMs).then(() => false)])) return true
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  return Boolean(await Promise.race([exited, sleep(2000).then(() => false)]))
}

/** 兜底回收：把所有仍登记的 hub 子进程杀掉，返回仍存活的数量（应恒为 0）。 */
async function sweepChildren() {
  let survived = 0
  for (const child of [...LIVE_CHILDREN]) {
    if (!(await killChild(child))) survived++
  }
  return survived
}

/** 内存版 localStorage（api.ts 的 IO 层依赖它）。 */
function makeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) },
    get length() { return map.size },
    key: (i) => [...map.keys()][i] ?? null,
    _map: map,
  }
}

/** 起一个隔离 hub 进程。 */
function boot(port, db) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, TEAM_HUB_PORT: String(port), TEAM_HUB_HOST: '127.0.0.1', TEAM_HUB_DB: db, TEAM_HUB_TOKEN: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  child.stderr.on('data', (d) => { err += d })
  LIVE_CHILDREN.add(child)
  child.on('exit', () => LIVE_CHILDREN.delete(child))
  const wait = waitForReady(`http://127.0.0.1:${port}/api/config`, { label: 'hub' })
  // 登记并在 settle 时注销：否则它就是一个「永远 pending 的 Timeout」，进程不会退出
  LIVE_WAITS.add(wait)
  const ready = wait.promise.catch((e) => { throw new Error(e.message + ' | stderr=' + err.slice(-300)) })
  void ready.then(() => {}, () => {}).finally(() => LIVE_WAITS.delete(wait))
  return { child, ready, port, wait }
}

const jpost = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json())

/** 准备环境：隔离库 + 绝对 hub 基址 + 内存存储，然后导入真实 api.ts / notify.ts。
 *
 *  顺序很关键：**先装载被测模块、再起服务进程**。
 *  被 import 的模块可能因相对导入缺扩展名等原因在 Node 下加载失败——那种失败必须在起服务之前暴露，
 *  否则 `setup()` 会在「服务已启动」之后 reject，调用方拿不到 ctx、无从回收，留下泄漏进程（历史事故）。 */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'notify-smoke-'))
  const db = join(dir, 'notify.db')
  const port = 30000 + Math.floor(Math.random() * 12000)

  // 模块加载期就需要的内存宿主对象（api.ts 的 IO 层依赖 localStorage / window / EventSource）
  const store = makeStorage()
  globalThis.localStorage = store
  globalThis.window = { location: { search: '' } }
  globalThis.EventSource = MiniEventSource
  store.setItem('legion.workbench.hub', `http://127.0.0.1:${port}`)

  const api = await import('../src/api.ts')
  const notify = await import('../src/notify.ts')

  const hub = boot(port, db)
  try {
    await hub.ready
  } catch (e) {
    await killChild(hub.child) // 起服务失败/超时同样要回收，不能把子进程留给调用方
    throw e
  }
  return { dir, db, port, hub, store, api, notify }
}

/** 收尾：回收本用例起的 hub（含重启循环里的候选进程）与隔离目录。
 *  允许 ctx 为空——`setup()` 自身失败时也必须能安全调用（这正是历史事故的修复点）。 */
async function cleanup(ctx) {
  if (ctx && ctx.hub) {
    // 幂等：就绪成功时轮询已自行 stop()，失败/中断路径下由这里兜底
    try { ctx.hub.wait?.stop() } catch { /* ignore */ }
    await killChild(ctx.hub.child)
  }
  sweepSubscriptions()
  await sweepChildren()
  if (!ctx) return
  // Windows：hub 进程句柄释放有延迟，rmSync 可能 EPERM。清理失败不影响断言结论
  // （隔离库在系统临时目录，由 OS 回收），故容错重试后忽略。
  try { rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }) } catch { /* ignore */ }
}

/** 造一批审计事件（覆盖 task/goal/skill + 应被过滤的 chat）。
 *  注意：v2 写操作的审计 scope 取自请求体 scope（缺省 default），因此每处都要显式带 scope，
 *  否则事件落到 default 空间、按 scope=software 查询就看不到（不是服务端 bug）。 */
async function seed(port) {
  const t = await jpost(port, '/api/create', { title: '通知冒烟任务', by: 'general', scope: 'software' })
  const tid = t.task.id
  const ver = t.task.version
  await jpost(port, '/api/transition', { id: tid, to: 'blocked', by: 'general', scope: 'software', ifVersion: ver })
  await jpost(port, '/api/create', { title: '通知冒烟任务2', by: 'general', scope: 'software' })
  await jpost(port, '/api/goal', { scope: 'software', objective: '通知中心端到端目标', by: 'general', mode: 'chain' })
  await jpost(port, '/api/skills/register', { id: 'notify-smoke-skill', name: '通知冒烟技能', body: '# smoke', by: 'general', scope: 'software' })
  const conv = await jpost(port, '/api/chat/conversations', { scope: 'software', title: '不应刷屏的会话', kind: 'space', by: 'general' })
  const convId = conv.conversation?.id ?? conv.task?.id
  if (convId) await jpost(port, '/api/chat/messages', { conv: convId, scope: 'software', kind: 'text', body: 'hello', by: 'general' })
  return { tid }
}

/**
 * 最小 EventSource（Node 无内置全局 EventSource）。
 *
 * 行为对齐浏览器 EventSource 的关键点：
 *   - 打开成功 → onopen；连接/流中断 → onerror 后**自动重连**（这里 300ms 退避）；
 *   - 解析 `data:` / `id:` 行 → onmessage({data, lastEventId})；
 *   - 重连时携带 `Last-Event-ID` 请求头（与浏览器一致）→ 服务端 v2 据此续传（P2-3 信封）。
 * 边界（诚实登记）：不实现 retry: 指令与超时关闭；不足以替代浏览器实现，仅用于 Node 侧逻辑回归。
 */
class MiniEventSource {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.onopen = null
    this.onerror = null
    this.onmessage = null
    this.lastEventId = ''
    this._closed = false
    void this._connect()
  }

  async _connect() {
    try {
      const headers = { accept: 'text/event-stream' }
      if (this.lastEventId) headers['last-event-id'] = this.lastEventId
      const res = await fetch(this.url, { headers })
      if (!res.ok || !res.body) throw new Error('SSE status ' + String(res.status))
      this.readyState = 1
      this.onopen?.({})
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          this._frame(chunk)
        }
      }
      throw new Error('SSE stream ended')
    } catch (e) {
      if (this._closed) return
      this.readyState = 0
      this.onerror?.(e)
      setTimeout(() => { if (!this._closed) void this._connect() }, 300)
    }
  }

  _frame(chunk) {
    const data = []
    for (const line of chunk.split('\n')) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      else if (line.startsWith('id:')) this.lastEventId = line.slice(3).trim()
    }
    if (data.length > 0) this.onmessage?.({ data: data.join('\n'), lastEventId: this.lastEventId })
  }

  close() {
    this._closed = true
    this.readyState = 2
  }
}

test('就绪轮询：连上即停、超时即停（回归：旧实现在就绪后仍每 120ms 空转到 15s 期限）', async () => {
  const { createServer } = await import('node:http')
  let hits = 0
  const srv = createServer((req, res) => { hits += 1; res.writeHead(200); res.end('ok') })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const livePort = srv.address().port
  // 取一个**已关闭**的端口：fetch 会立即 ECONNREFUSED，用于测超时路径
  const dead = createServer()
  await new Promise((r) => dead.listen(0, '127.0.0.1', r))
  const deadPort = dead.address().port
  await new Promise((r) => dead.close(r))
  try {
    const ok = waitForReady(`http://127.0.0.1:${livePort}/api/config`, { intervalMs: 30, timeoutMs: 5000 })
    await ok.promise
    assert.equal(ok.ticks(), 1, '首次即成功应只轮询一次')
    assert.equal(ok.stopped(), true, '就绪后必须停止轮询')
    assert.equal(hits, 1, '就绪后不得再打 HTTP')
    await sleep(300) // 若仍空转，ticks 会在此增长（旧实现正是如此）
    assert.equal(ok.ticks(), 1, '就绪后不得再有 tick（旧实现：直到 15s 期限都在轮询，哨兵实测 41 次）')

    const to = waitForReady(`http://127.0.0.1:${deadPort}/api/config`, { intervalMs: 10, timeoutMs: 200 })
    await assert.rejects(() => to.promise, /boot timeout/)
    assert.equal(to.stopped(), true, '超时后必须停止轮询')
    const at = to.ticks()
    await sleep(150)
    assert.equal(to.ticks(), at, '超时后不得继续轮询')
  } finally {
    await new Promise((r) => srv.close(r))
  }
})

test('就绪轮询：服务端 accept 后**永不出响应**时仍必须按时收敛（回归：无上界的 fetch 会挂到 undici 的 300s headersTimeout）', async () => {
  const { createServer } = await import('node:http')
  // 黑洞服务端：接受连接但从不回响应。旧实现直接 `fetch(...)`，会在这里挂到 undici 的
  // headersTimeout（默认 300s）——套件级硬上限也正好是 300s，于是表现为「用例全绿却永不退出」。
  const sockets = new Set()
  const blackHole = createServer(() => { /* 故意不回响应 */ })
  blackHole.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise((r) => blackHole.listen(0, '127.0.0.1', r))
  const port = blackHole.address().port
  try {
    const t0 = Date.now()
    const w = waitForReady(`http://127.0.0.1:${port}/api/config`, { intervalMs: 20, perRequestMs: 150, timeoutMs: 800 })
    await assert.rejects(() => w.promise, /boot timeout/, '永不出响应时必须靠自身的上界收敛并抛错，而不是挂到 300s')
    const elapsed = Date.now() - t0
    assert.ok(elapsed < 5000, '必须在自身期限内收敛（实测 ' + String(elapsed) + 'ms），不得接近 undici 的 300s 默认值')
    assert.equal(w.stopped(), true, '收敛后必须停止轮询')
    assert.ok(w.ticks() >= 2, '每个请求都被上界截断后应继续下一轮（ticks=' + String(w.ticks()) + '）')
  } finally {
    for (const s of sockets) { try { s.destroy() } catch { /* ignore */ } }
    await new Promise((r) => blackHole.close(r))
  }
})

// 文件级兜底自检：所有用例结束后，不得有任何 hub 子进程存活。
// 泄漏会让 `node --test` 永不退出（CI 表现为零输出、永久等待），所以这里**显式失败**而不是等它卡住。
afterAll(async () => {
  const survived = await sweepChildren()
  assert.equal(survived, 0, '测试结束时仍有 ' + survived + ' 个 hub 子进程未回收（会导致测试进程无法退出）')
  // 订阅与轮询同样会吊住事件循环。二者都在上面被显式清理，这里断言「确实清干净了」——
  // 这是把「用例全绿却卡死」变成「明确失败」的关键一道闸。
  const subs = sweepSubscriptions()
  assert.equal(subs, 0, '测试结束时仍有 ' + subs + ' 个 SSE 订阅未关闭（断线后无上限重连 → 进程无法退出）')
  assert.equal(LIVE_WAITS.size, 0, '测试结束时仍有 ' + LIVE_WAITS.size + ' 个就绪轮询在运行（pending Timeout → 进程无法退出）')
})

test('数据面 + 分类/优先级/跳转：真实审计派生通知，chat:* 被过滤，已读 IO 零服务端写入', { timeout: 90000 }, async () => {
  let ctx
  try {
    ctx = await setup()
    const { port, api, notify, store } = ctx
    await seed(port)

    // 原始审计：应含 chat:*（证明过滤确实起作用，而不是数据没产生）
    const raw = await api.fetchHubActivity({ scope: 'software', limit: 200 })
    assert.ok(raw.length >= 5, '原始审计条数 = ' + String(raw.length))
    assert.ok(raw.some((r) => r.action.startsWith('chat:')), '原始审计应含 chat:* 行')

    // 通知列表：chat:* 被白名单过滤掉
    const items = notify.toNotifyItems(raw, api.notifyReadState('software'))
    assert.ok(items.length >= 4, '通知项条数 = ' + String(items.length))
    assert.ok(items.every((i) => !i.action.startsWith('chat:')), '通知列表不得含 chat:*')
    assert.ok(items.every((i) => i.source === 'hub-audit'))

    // 分类
    const counts = notify.categoryCounts(items)
    assert.ok(counts.task.total >= 2, 'task 分类应含 create/transition：' + JSON.stringify(counts.task))
    assert.ok(counts.goal.total >= 1, 'goal 分类应含 goal:publish')
    assert.ok(counts.skill.total >= 1, 'skill 分类应含 skill:submit')

    // 优先级：真实 transition→blocked 应为 high
    const blocked = items.find((i) => i.action === 'transition')
    assert.ok(blocked, '应有 transition 通知项')
    assert.equal(blocked.priority, 'high', 'transition→blocked 应为 high（detail.to=' + JSON.stringify(blocked.detail) + '）')

    // 跳转协议：transition 带 taskId → task；goal:publish → goal（动作域优先，即使带 taskId）
    assert.equal(blocked.jump.kind, 'task')
    const goalItem = items.find((i) => i.action === 'goal:publish')
    assert.ok(goalItem, '应有 goal:publish 通知项')
    assert.equal(goalItem.jump.kind, 'goal', 'goal:publish 应跳目标面板（taskId=' + String(goalItem.taskId) + '）')

    // 已读 IO：初始全未读 → 单条（最高 seq）已读 → 全部已读
    assert.equal(api.countNotifyUnread(raw, 'software'), items.length)
    const maxSeq = notify.highestSeq(items)
    const st1 = api.markNotifyRead('software', [maxSeq])
    // 只读最高一条时其下仍有未读 → 游标不推进，落到显式已读集合（压实语义）
    assert.equal(st1.cursor, 0, '非连续已读不推进游标')
    assert.deepEqual(st1.ids, [maxSeq], '该条进入显式已读集合')
    assert.ok(api.notifyReadState('software').ids.includes(maxSeq), '状态已持久化到本机存储')
    assert.equal(api.countNotifyUnread(raw, 'software'), items.length - 1)
    // 批量选中所有未读 → 连续区间被压实，游标推进到最高 seq
    const stBatch = api.markNotifyRead('software', items.map((i) => i.seq))
    assert.equal(stBatch.cursor, maxSeq, '批量已读全覆盖 → 游标压实推进')
    assert.deepEqual(stBatch.ids, [], '压实后显式集合清空')
    assert.equal(api.countNotifyUnread(raw, 'software'), 0, '全部已读后未读为 0')
    api.markAllNotifyRead('software', maxSeq)
    assert.equal(store.getItem('legion.notify.read.software'), String(maxSeq), '游标写在本机存储')

    // per-scope 隔离：另一空间不受影响
    assert.equal(api.notifyReadState('marketing').cursor, 0, 'per-scope 隔离')

    // 反向断言：以上已读/列表操作期间，服务端 audit 零新行（已读纯本地）
    const after = await api.fetchHubActivity({ scope: 'software', limit: 200 })
    assert.equal(after.length, raw.length, 'audit 行数不得变化（已读不写服务端）')
    assert.equal(notify.highestSeq(after), notify.highestSeq(raw), 'audit 最大 seq 不得变化')
  } finally {
    await cleanup(ctx)
  }
})

test('实时 + 断线恢复：SSE 帧去重合并、全局水位、kill 后同实例自动重连（opens=2 → reconnected）', { timeout: 120000 }, async () => {
  let ctx
  let off = null
  try {
    ctx = await setup()
    const { port, api, notify } = ctx
    let hub = ctx.hub
    const seen = []
    const statuses = []
    off = trackSubscription(api.subscribeHubAudit((ev) => seen.push(ev), { onStatus: (st) => statuses.push(st) }))
    await sleep(600)
    assert.equal(statuses[0]?.state, 'open', '首连应为 open（opens=1）')

    // 造事件 → 应实时到达
    await seed(port)
    await sleep(900)
    assert.ok(seen.length >= 4, 'SSE 应实时收到事件：' + String(seen.length))
    assert.ok(seen.some((e) => e.action === 'transition'), 'SSE 应含 transition 帧')

    // 去重合并：同一帧重复投递不产生重复项
    const asItems = notify.toNotifyItems(seen, notify.EMPTY_READ_STATE)
    const merged = notify.mergeNotifyItems(asItems, asItems, 200)
    assert.equal(merged.length, asItems.length, '重复帧合并后条数不变')
    assert.equal(new Set(merged.map((i) => i.seq)).size, merged.length, 'seq 唯一')

    // 全局水位：单调递增；构造缺口判据
    const wm = notify.highestSeq(seen)
    assert.ok(wm > 0, '水位应推进')
    assert.equal(notify.shouldRefill(wm, [{ seq: wm + 1 }]), false, '连续帧不需补齐')
    assert.equal(notify.shouldRefill(wm, [{ seq: wm + 3 }]), true, '跳变即判缺口')

    // 断线 → 重启 → 同实例自动重连（EventSource 自动重连 + Last-Event-ID）
    await killChild(hub.child) // 等它真正退出，避免同端口重启时与新进程抢端口
    await sleep(1500)
    assert.ok(statuses.some((s) => s.state === 'reconnecting' || s.state === 'closed'), '应上报重连中/已关闭：' + JSON.stringify(statuses.slice(-3)))

    let restarted = null
    for (let i = 0; i < 6 && !restarted; i++) {
      const candidate = boot(port, ctx.db)
      try { await candidate.ready; restarted = candidate } catch { await killChild(candidate.child); await sleep(500) }
    }
    assert.ok(restarted, '服务应能在同端口重启（断线恢复场景）')
    hub = restarted
    ctx.hub = restarted

    const t0 = Date.now()
    while (Date.now() - t0 < 20000 && !statuses.some((s) => s.state === 'reconnected')) await sleep(300)
    const re = statuses.filter((s) => s.state === 'reconnected')
    assert.ok(re.length > 0, '同实例重连成功应上报 reconnected：' + JSON.stringify(statuses))
    assert.ok(re[0].opens >= 2, 'opens 应 >= 2（重连次数）')

    // 重连后仍能收到新事件（补齐窗口内的新帧）
    const before = seen.length
    await jpost(port, '/api/create', { title: '重连后新任务', by: 'general', scope: 'software' })
    await sleep(1200)
    assert.ok(seen.length > before, '重连后应继续收到新帧')

  } finally {
    // 订阅必须在这里关：MiniEventSource 断线后每 300ms **无上限**重连，原先 `off()` 写在 try 末尾，
    // 一旦中途断言失败就永不执行 → 事件循环永不空 → 进程不退出 → 本套件被 300s 上限杀掉。
    // 失败必须是「干净的失败」，不能升级成「卡死」。
    if (off) off()
    await cleanup(ctx)
  }
})
