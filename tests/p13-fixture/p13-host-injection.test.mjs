/**
 * P1-3 — 真实 DSH 宿主注入冒烟（host-injection，非 fake context）。
 *
 * 在隔离 $DSH_HOME 上以真实 dsh CLI（apps/cli/lib/bin.js）+ base bundle 启动宿主，
 * profile 用户补丁层挂载 legion 三插件（@dsh-external/dsh-team-hub / dsh-scrum-board /
 * dsh-scrum-worker）+ fixture 控制插件（/__p13/ready、/__p13/shutdown）。
 *
 * 验证面（对应 P1-3 验收）：
 *   1) 注入生命周期：真实 loader 组合下三插件 apply 执行（webServer.register 生效、
 *      scrum-worker 注入面齐 → 守护启动日志），route prefix 各自挂载。
 *   2) HTTP/token 矩阵：/team-hub /api/config|board|create|transition|comment + Bearer 401/200、
 *      board-plugin /scrum-board api/board|create|artifact 404 语义。
 *   3) SSE 宿主形态：/team-hub/api/events（activity.jsonl watch 增量广播）、
 *      /scrum-board/api/board/events（连接即全量快照）。
 *   4) 关闭清理：保持 SSE 连接 → /__p13/shutdown（bounded dispose）→ SSE 被服务端 end、
 *      子进程 ≤20s 自然退出 exit 0（残留 watcher/interval/连接会让进程挂起 → 超时即 fail）。
 *
 * 隔离纪律：独立 home/端口/空任务库；worker scope=__p13fixture__（不存在）+ intervalMs 拉满，
 * 冒烟期间绝不触达生产 scrum 库 / team-hub :8787 / 3080 GUI 宿主（detectHub 仅探测只读 config）。
 * DSH_CHECKOUT 缺失时整组 SKIP（同 P1-2 纪律，不伪造通过）。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import {
  requireDshCheckout, makeFixture, spawnHost, waitReady, waitLog, waitSseClosed,
  req, sseCollect, freePort, sleep,
} from './host-fixture.mjs'

let HAS_DSH = true
try { requireDshCheckout() } catch { HAS_DSH = false }

/** 打开一条存活 SSE（不自动销毁），返回帧数组与 close()。 */
function liveSse(base, path, token) {
  const frames = []
  const headers = token ? { authorization: `Bearer ${token}` } : {}
  const req0 = http.request(new URL(base + path), { headers }, (res) => {
    res.setEncoding('utf8')
    let buf = ''
    res.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        frames.push(buf.slice(0, idx))
        buf = buf.slice(idx + 2)
      }
    })
    res.on('error', () => { /* 服务端主动断连（shutdown/超时）→ 由 close 事件收口 */ })
  })
  req0.on('error', () => { /* 同上：shutdown 断连时 ECONNRESET 走 close 收口 */ })
  req0.end()
  return { req: req0, frames, close: () => { try { req0.destroy() } catch { /* closed */ } } }
}

async function waitFrames(frames, predicate, { timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate(frames)) return true
    await sleep(100)
  }
  return false
}

const describeHost = HAS_DSH ? describe : describe.skip

describeHost('P1-3 真实 DSH 宿主注入冒烟（legion 三插件）', () => {
  let fx, child
  const TOKEN = 'p13-fixture-token'

  before(async () => {
    const port = await freePort()
    fx = makeFixture({ port, teamToken: TOKEN })
    child = spawnHost(fx)
    await waitReady(fx.base, { timeoutMs: 60000 })
  }, { timeout: 90000 })

  after(async () => {
    if (child && child.exitCode === null) {
      try { child.kill() } catch { /* gone */ }
    }
    if (fx) fx.cleanup()
  }, { timeout: 15000 })

  it('① 注入生命周期：三插件经真实 loader 组合 apply 成功，route prefix 各自挂载', async () => {
    // team-hub 适配器挂在 /team-hub（taskctl 旧 API + SSE 的宿主承载）
    const th = await req(fx.base, 'GET', '/team-hub/api/config')
    assert.equal(th.status, 200, JSON.stringify(th.data))
    assert.equal(th.data.auth, true) // teamToken 非空 → auth 开启
    assert.equal(th.data.host, '127.0.0.1')
    assert.equal(th.data.port, fx.port) // 读的是真实 webServer.port（宿主注入证据）

    // board-plugin 挂在 /scrum-board（自托管看板 API）
    const bp = await req(fx.base, 'GET', '/scrum-board/api/config')
    assert.equal(bp.status, 200, JSON.stringify(bp.data))

    // scrum-worker 无 webServer；注入面（timer/agents/subagents/agentDefaultModel/agentPresets）
    // 全 resolved 才执行 apply → apply 内同步 writeDaemonStatus(0) 写 daemon.json
    // （含 agentDefaultModel.currentSelection()）→ 文件出现即完整 mount 证据。
    const daemonFile = join(fx.scrumDir, 'daemon.json')
    let daemon = null
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      try {
        daemon = JSON.parse(readFileSync(daemonFile, 'utf8'))
        break
      } catch { /* not yet */ }
      await sleep(300)
    }
    assert.ok(daemon, 'daemon.json 未出现 → scrum-worker apply 未执行（注入服务未全 resolved？）。宿主输出：\n' + (child._p13logs.out + child._p13logs.err).slice(-1500))
    assert.equal(daemon.role, 'soldier-auto')
    assert.equal(daemon.mode, 'worker')
    assert.equal(daemon.scope, '__p13fixture__')
    assert.ok(daemon.lastSweepAt, 'daemon.json 应含 lastSweepAt')
    assert.ok(daemon.model && daemon.model.provider, 'agentDefaultModel.currentSelection() 应解析出模型（base 默认）')

    // 控制插件（file:// 注入的普通 cordis 插件）也在同一宿主生效
    const ctl = await req(fx.base, 'GET', '/__p13/ready')
    assert.equal(ctl.status, 200)
  })

  it('② team-hub 宿主路径 HTTP 契约 + token 矩阵（Bearer）', async () => {
    // 无 token 写 → 401；错误 token → 401
    assert.equal((await req(fx.base, 'POST', '/team-hub/api/create', { title: 'x', by: 'general' })).status, 401)
    assert.equal((await req(fx.base, 'POST', '/team-hub/api/create', { title: 'x', by: 'general' }, 'wrong')).status, 401)
    // 正确 token → 200
    const create = await req(fx.base, 'POST', '/team-hub/api/create', {
      title: '宿主契约任务', description: '由真实宿主注入验证', by: 'general', scope: 'default',
    }, TOKEN)
    assert.equal(create.status, 200, JSON.stringify(create.data))
    const id = create.data.task.id
    assert.equal(create.data.task.status, 'backlog')
    assert.equal(create.data.task.scope, 'default')

    // 读面（board）在宿主路径返回任务
    const board = await req(fx.base, 'GET', '/team-hub/api/board')
    assert.equal(board.status, 200)
    const list = Array.isArray(board.data) ? board.data : board.data.tasks ? Object.values(board.data.tasks) : null
    assert.ok(list, 'board 数据形状异常：' + JSON.stringify(board.data).slice(0, 200))
    assert.ok(list.some((t) => t.id === id))

    // 乐观锁 409：先成功迁移（拿新 version），再用旧 version 重复迁移 → 409
    const first = await req(fx.base, 'POST', '/team-hub/api/transition', {
      id, to: 'todo', by: 'general', ifVersion: create.data.task.version,
    }, TOKEN)
    assert.equal(first.status, 200, JSON.stringify(first.data))
    const stale = await req(fx.base, 'POST', '/team-hub/api/transition', {
      id, to: 'in_progress', by: 'general', ifVersion: create.data.task.version,
    }, TOKEN)
    assert.equal(stale.status, 409, JSON.stringify(stale.data))

    // comment 成功且版本递增
    const before = await req(fx.base, 'GET', '/team-hub/api/board')
    const taskB = (Array.isArray(before.data) ? before.data : Object.values(before.data.tasks)).find((t) => t.id === id)
    const cm = await req(fx.base, 'POST', '/team-hub/api/comment', { id, text: '宿主注入评论', by: 'general' }, TOKEN)
    assert.equal(cm.status, 200, JSON.stringify(cm.data))
    assert.ok(cm.data.task.comments.some((c) => c.text === '宿主注入评论'))
    assert.ok(cm.data.task.version > taskB.version)
  })

  it('③ board-plugin 宿主路径：board 快照 / kanban / artifact 404 语义', async () => {
    // board-plugin 本地模式写接口无 token 门禁（与 http-contract 语义一致）
    const create = await req(fx.base, 'POST', '/scrum-board/api/create', {
      title: '看板契约任务', by: 'general',
    })
    assert.equal(create.status, 200, JSON.stringify(create.data))
    const id = create.data.task.id

    // tasks.json 变化 → board-plugin watcher → 防抖 runRender → board.json 刷新
    let board
    for (let i = 0; i < 30; i++) {
      board = await req(fx.base, 'GET', '/scrum-board/api/board')
      const text = JSON.stringify(board.data)
      if (text.includes(id)) break
      await sleep(300)
    }
    assert.equal(board.status, 200)
    assert.ok(JSON.stringify(board.data).includes(id), 'render 后 board.json 应含新任务')

    // kanban.html 由 render 生成、宿主静态托管
    const kanban = await fetch(fx.base + '/scrum-board/kanban.html')
    assert.equal(kanban.status, 200)
    const html = await kanban.text()
    assert.match(html, /<html/i)

    // artifact：任务存在但无产物 → 404 JSON（语义对齐 v1 artifact-detail）
    const art = await req(fx.base, 'GET', `/scrum-board/api/artifact?task=${id}`)
    assert.equal(art.status, 404)
    assert.ok(art.data && art.data.error)
  }, { timeout: 30000 })

  it('④ SSE 宿主形态：activity.jsonl watch 增量广播 + board 连接即全量', async () => {
    // team-hub /api/events：连接建立（retry 帧）后，外部追加 activity.jsonl →
    // 宿主内 watchFile 捕获并广播 data 帧（增量推送闭环，activityOffset 由宿主维护）
    const th = liveSse(fx.base, '/team-hub/api/events')
    try {
      assert.ok(await waitFrames(th.frames, (f) => f.some((x) => x.includes('retry:'))), '应收到 retry 帧')
      appendFileSync(join(fx.scrumDir, 'activity.jsonl'), JSON.stringify({ ts: new Date().toISOString(), kind: 'create', taskId: 'T-001', text: '宿主SSE增量' }) + '\n')
      assert.ok(
        await waitFrames(th.frames, (f) => f.some((x) => x.includes('宿主SSE增量'))),
        'watchFile 应把外部追加行广播给已连客户端；frames=' + JSON.stringify(th.frames),
      )
    } finally {
      th.close()
    }

    // board-plugin /scrum-board/api/board/events：连接即推 board.json 全量快照
    const bp = await sseCollect(fx.base, '/scrum-board/api/board/events', {
      timeoutMs: 5000, resolveOn: (f) => f.filter((x) => x.includes('data:')).length >= 1,
    })
    assert.equal(bp.status, 200)
    assert.ok(bp.frames.some((f) => f === 'retry: 2000'))
    const boardFrames = bp.frames.filter((f) => f.includes('data:'))
    assert.ok(boardFrames.length >= 1)
    // 帧内每行 data: 前缀 → 多行 JSON（board.json 缩进格式）拼接后解析
    const payload = boardFrames[0].split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6))
      .join('')
    const parsed = JSON.parse(payload)
    assert.ok(Array.isArray(parsed.columns), 'board/events 推完整渲染快照（columns 数组）')
  })

  it('⑤ 关闭清理：bounded dispose 结束 SSE、进程自然退出 exit 0', async () => {
    // 保持两条 SSE 连接（一条已消费增量、一条看板全量）；close promise 须在
    // shutdown 前注册（dispose 会立刻 end 连接，晚注册会错过 close 事件）
    const sse1 = liveSse(fx.base, '/team-hub/api/events')
    const sse2 = liveSse(fx.base, '/scrum-board/api/board/events')
    await sleep(800) // 让两边都完成 add-client 与首帧
    const c1p = waitSseClosed(sse1.req, { timeoutMs: 8000 })
    const c2p = waitSseClosed(sse2.req, { timeoutMs: 8000 })

    const exitPromise = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))

    const shut = await req(fx.base, 'POST', '/__p13/shutdown')
    assert.equal(shut.status, 200)

    // 宿主 teardown 应 end 所有 SSE 客户端（legion 插件 teardown effects）
    const c1 = await c1p
    const c2 = await c2p
    assert.ok(c1, 'team-hub SSE 客户端应在 dispose 时被服务端关闭')
    assert.ok(c2, 'board SSE 客户端应在 dispose 时被服务端关闭')

    // 全树 dispose 无残留句柄 → 进程 ≤20s 自然退出 exit 0（残留 interval/watcher 会挂起 → 超时 fail）
    const { code } = await Promise.race([
      exitPromise,
      sleep(20000).then(() => ({ code: 'TIMEOUT' })),
    ])
    assert.equal(code, 0, '宿主应优雅退出 exit 0（实际 code=' + code + '）；stderr：\n' + (child._p13logs.err || '').slice(-1500))
  }, { timeout: 40000 })
})
