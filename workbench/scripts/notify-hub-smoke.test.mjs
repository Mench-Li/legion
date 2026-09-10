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
 *  为什么需要它：本文件会起真实服务进程，而 `node --test` 只有在**测试进程退出**后才会输出结果——
 *  任何一个没被回收的子进程都会让整份文件「永不结束」。历史事故：`setup()` 中途抛错（模块相对
 *  导入缺扩展名）发生在 `boot()` 之后，拿不到 ctx 却留下一个 hub 子进程，CI 于是永久挂起、
 *  全量基线长期无法产出（见 docs/P2-7-evidence/verify-evidence.md §7）。
 *  因此这里把「起进程」与「收进程」都集中管理，并在文件结束时做兜底自检。 */
const LIVE_CHILDREN = new Set()

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
  const ready = new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      fetch(`http://127.0.0.1:${port}/api/config`)
        .then((r) => { if (r.ok) resolve() })
        .catch(() => {})
        .finally(() => {
          if (Date.now() - t0 > 15000) reject(new Error('hub boot timeout: ' + err.slice(-300)))
          else setTimeout(tick, 120)
        })
    }
    tick()
  })
  return { child, ready, port }
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
  if (ctx && ctx.hub) await killChild(ctx.hub.child)
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

// 文件级兜底自检：所有用例结束后，不得有任何 hub 子进程存活。
// 泄漏会让 `node --test` 永不退出（CI 表现为零输出、永久等待），所以这里**显式失败**而不是等它卡住。
afterAll(async () => {
  const survived = await sweepChildren()
  assert.equal(survived, 0, '测试结束时仍有 ' + survived + ' 个 hub 子进程未回收（会导致测试进程无法退出）')
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
  try {
    ctx = await setup()
    const { port, api, notify } = ctx
    let hub = ctx.hub
    const seen = []
    const statuses = []
    const off = api.subscribeHubAudit((ev) => seen.push(ev), { onStatus: (st) => statuses.push(st) })
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

    off()
  } finally {
    await cleanup(ctx)
  }
})
