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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import {
  REPO, requireDshCheckout, makeFixture, spawnHost, waitReady, waitLog, waitSseClosed,
  req, sseCollect, freePort, sleep, routeMissDetail, drainLogs,
} from './host-fixture.mjs'
import { diagnoseHostLogs, formatDiagnosis, preflightEntries } from './host-diagnostics.mjs'

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
    // P4-2：**启动之前**先预检组合行的入口产物。这正是 CI 现场「team-hub/lib 缺失」的形状：
    // 以前只能等 60s 超时；现在直接点名「哪个条目 / 哪个入口 / 怎么构建」。
    const pre = fx.preflight()
    assert.deepEqual(pre.problems, [], '插件入口预检失败（启动前即可判定）：\n' + JSON.stringify(pre, undefined, 2))
    child = spawnHost(fx)
    // 传 child/rows：任何启动期失败都会变成点名到插件条目的诊断，而不是「host not ready within Nms」
    await waitReady(fx.base, { timeoutMs: 60000, child, rows: fx.rows })
  }, { timeout: 90000 })

  after(async () => {
    if (child && child.exitCode === null) {
      try { child.kill() } catch { /* gone */ }
    }
    if (fx) fx.cleanup()
  }, { timeout: 15000 })

  it('① 注入生命周期：三插件经真实 loader 组合 apply 成功，route prefix 各自挂载', async () => {
    // team-hub 宿主外壳 = v2 中枢（P1-1 合并后）：/team-hub 前缀由外壳挂到 v2 handle
    const th = await req(fx.base, 'GET', '/team-hub/api/config')
    // P4-2：状态断言失败时不再只给一个数字，而是把「该路径属于哪个插件、宿主日志怎么说」一并给出
    assert.equal(th.status, 200, routeMissDetail({ fx, child, res: th, path: '/team-hub/api/config', plugin: 'team-hub（宿主外壳）' }))
    assert.equal(th.data.auth, true) // teamToken 非空 → v2 auth 开启
    assert.ok(String(th.data.db).includes('p13-hub.db'), 'v2 config 应带 db 路径（隔离库）：' + JSON.stringify(th.data))
    assert.equal(th.data.port, fx.port) // 外壳把 webServer.port 传给 v2（宿主注入证据）

    // board-plugin 挂在 /scrum-board（自托管看板 API）
    const bp = await req(fx.base, 'GET', '/scrum-board/api/config')
    assert.equal(bp.status, 200, routeMissDetail({ fx, child, res: bp, path: '/scrum-board/api/config', plugin: 'board-plugin' }))

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

  it('①b P3-4：真实宿主注入下，守护启动即把生效配置（脱敏摘要）写进自己的日志', async () => {
    const logPath = join(fx.home, 'p13-worker.log')
    let text = ''
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      try {
        text = readFileSync(logPath, 'utf8')
        if (/\[config\] plugins /.test(text)) break
      } catch { /* 日志尚未落盘 */ }
      await sleep(200)
    }
    const line = text.split('\n').find((l) => l.includes('[config] plugins '))
    assert.ok(line, '守护日志缺少 P3-4 配置摘要行（真实宿主注入路径）：' + text.slice(-600))
    // 摘要必须包含六个已纳管字段，且未设置的走默认值（本 fixture 没有设置任何 CHAT_CTX_*/NORMS_*）
    for (const key of ['chatCtxBudgetChars=8000', 'chatCtxDigestBudgetChars=4000', 'chatCtxFileCapChars=4000',
      'normsGlobalMax=3000', 'normsSpaceMax=4000', 'normsTotalMax=7000']) {
      assert.ok(line.includes(key), `摘要缺少 ${key}：${line}`)
    }
    assert.ok(line.includes('（全部取默认值）') || line.includes('← 覆盖：'), '摘要必须说明值与默认值的关系：' + line)
    // 配置非法时不得静默：日志里出现错误行才算「大声降级」（本 fixture 无非法值，故不应出现）
    assert.ok(!text.includes('配置非法（已回退默认值）'), '无非法配置时不应出现错误行：' + text.slice(-600))
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

  it('④ SSE 宿主形态：v2 /team-hub/api/events 信封回放+增量 + board 本地全量', async () => {
    // team-hub /api/events（P1-1 后 = v2 中枢）：连接即回放最近 audit（含 ② 的
    // create/transition/comment 信封 id:+data:），随后一次新写触发增量帧（seq 递增、无重复）。
    const th = liveSse(fx.base, '/team-hub/api/events')
    try {
      assert.ok(await waitFrames(th.frames, (f) => f.some((x) => x.includes('retry:'))), '应收到 retry 帧')
      const replayed = await waitFrames(th.frames, (f) => f.some((x) => x.includes('"event":"comment"') && x.includes('T-001')))
      assert.ok(replayed, '连接应回放 v2 audit（信封含 event/seq/taskId）；frames=' + JSON.stringify(th.frames))
      // 新写 → 宿主内 audit 追加 → SSE 推新 seq（信封 event=comment、seq 严格递增于回放）
      const maxId = Math.max(0, ...th.frames.map((f) => {
        const m = f.match(/"id":\s*(\d+)/)
        return m ? Number(m[1]) : 0
      }))
      const cm = await req(fx.base, 'POST', '/team-hub/api/comment', { id: 'T-001', text: '宿主SSE增量', by: 'general' }, TOKEN)
      assert.equal(cm.status, 200, JSON.stringify(cm.data))
      assert.ok(
        await waitFrames(th.frames, (f) => f.some((x) => x.includes('"event":"comment"') && new RegExp(`"id":\\s*${maxId + 1}\\b`).test(x))),
        `新 audit（seq${maxId + 1}）应广播给已连客户端；frames=` + JSON.stringify(th.frames),
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

  it('⑤ P1-1 第 2 步：hub 模式 board（/scrum-board-hub）同宿主打 v2 /team-hub 全链路', async () => {
    // a. hub 动态面板（不再服务 render 静态产物）
    const page = await req(fx.base, 'GET', '/scrum-board-hub/')
    assert.equal(page.status, 200)
    const html = typeof page.data === 'string' ? page.data : JSON.stringify(page.data)
    assert.match(html, /v2 hub/)
    assert.match(html, /EventSource/)

    // b. 写走 v2：create 到 default scope（v2 库），读回裸任务数组
    const create = await req(fx.base, 'POST', '/scrum-board-hub/api/create', { title: 'hub面板契约任务', by: 'general' }, TOKEN)
    assert.equal(create.status, 200, JSON.stringify(create.data))
    const id = create.data.task.id
    const board = await req(fx.base, 'GET', '/scrum-board-hub/api/board')
    assert.equal(board.status, 200)
    assert.ok(Array.isArray(board.data), 'hub 模式 /api/board 应返回 v2 裸数组：' + JSON.stringify(board.data).slice(0, 160))
    assert.ok(board.data.some((t) => t.id === id), 'board 应含刚经 hub 创建的任务')

    // c. 活动流走 v2 audit（/api/activity 转发）
    const acts = await req(fx.base, 'GET', '/scrum-board-hub/api/activity?limit=10')
    assert.equal(acts.status, 200)
    assert.ok(Array.isArray(acts.data) && acts.data.some((a) => a.taskId === id), 'activity 应转发 v2 audit（含本次 create）')

    // d. reject/promote → 501 降级指引
    const rej = await req(fx.base, 'POST', '/scrum-board-hub/api/reject', { id, by: 'general', reason: 'x' }, TOKEN)
    assert.equal(rej.status, 501)
    assert.match(rej.data.error, /v2 hub 不支持 reject/)

    // e. hub 事件桥：经宿主 /team-hub 直接 transition → /scrum-board-hub 板 SSE 泵新帧
    const sse = liveSse(fx.base, '/scrum-board-hub/api/board/events')
    try {
      const first = await waitFrames(sse.frames, (f) => f.some((x) => x.includes(`"id": "${id}"`) || x.includes(`"id":"${id}"`)))
      assert.ok(first, 'hub 板 SSE 首帧应含 v2 全量（含新建任务）；frames=' + JSON.stringify(sse.frames).slice(0, 300))
      await req(fx.base, 'POST', '/team-hub/api/transition', { id, to: 'todo', by: 'general', ifVersion: create.data.task.version }, TOKEN)
      const pumped = await waitFrames(sse.frames, (f) => f.some((x) => x.includes('"status":"todo"') || x.includes('"status": "todo"')))
      assert.ok(pumped, '宿主 v2 事件应经桥泵给 hub 板 SSE 客户端（status→todo 帧）；frames=' + JSON.stringify(sse.frames).slice(-400))
    } finally {
      sse.close()
    }
  }, { timeout: 30000 })

  it('⑥ SP-P0 数据面流水线：经宿主 POST /api/pipeline → 真实守护下一轮改从 hub 取流水线', async () => {
    // 端到端闭环（对治 T-127 现场：流水线定义只在部署面文件里，与空间编队两份数据手工对齐）：
    //   宿主外壳路由 → team-hub 数据面 → 真实 dsh-scrum-worker 实例按 version 刷新 → daemon.json 见证。
    // 夹具 worker 的 rolesFile 为空且夹具工作区无 roles.json → 初始为「单角色模式」（pipeline=null）；
    // 导入数据面流水线后必须切换到 hub 来源——这就是「用户不必再碰宿主配置文件」的证据。
    const SCOPE = '__p13fixture__'
    const before = await req(fx.base, 'GET', `/team-hub/api/pipeline?scope=${SCOPE}`, undefined, TOKEN)
    assert.equal(before.status, 200, JSON.stringify(before.data))
    assert.deepEqual(before.data.stages, [], '夹具初始无数据面流水线')
    assert.equal(before.data.runtime.enabled, false)

    // 写入期校验在宿主形态同样生效：gate 无 artifact → 400
    const bad = await req(fx.base, 'POST', '/team-hub/api/pipeline', {
      scope: SCOPE, by: 'general', stages: [{ role: 'r1', label: '岗1', next: null, gate: true }],
    }, TOKEN)
    assert.equal(bad.status, 400, '非法规格应 400：' + JSON.stringify(bad.data))
    assert.ok(/artifact/.test(bad.data.error ?? ''), '错误文案应点明 artifact：' + JSON.stringify(bad.data))

    const write = await req(fx.base, 'POST', '/team-hub/api/pipeline', {
      scope: SCOPE, by: 'general',
      stages: [
        { role: 'soldier-research', label: '需求调研', prompt: '调研……', next: 'soldier-listing', docs: ['research/x/brief.md'] },
        { role: 'soldier-listing', label: '上架准备', prompt: '上架……', next: null },
      ],
      runtime: { enabled: true, maxWorkers: 1 },
    }, TOKEN)
    assert.equal(write.status, 200, JSON.stringify(write.data))
    const version = write.data.task.version
    assert.ok(version, '写入应返回 version 指纹')

    const after = await req(fx.base, 'GET', `/team-hub/api/pipeline?scope=${SCOPE}`, undefined, TOKEN)
    assert.deepEqual(after.data.activeRoles, ['soldier-research', 'soldier-listing'])
    assert.equal(after.data.runtime.enabled, true)

    // 守护按 intervalMs（夹具 5s）扫单 → 下一轮重新解析流水线来源；此处轮询 daemon.json 见证切换。
    const daemonFile = join(fx.scrumDir, 'daemon.json')
    let daemon = null
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      try {
        const d = JSON.parse(readFileSync(daemonFile, 'utf8'))
        if (d.pipeline && d.pipeline.source === 'hub') { daemon = d; break }
      } catch { /* not yet */ }
      await sleep(500)
    }
    assert.ok(daemon, '守护应在一个扫描周期内切到数据面流水线（daemon.json.pipeline.source=hub）；'
      + '当前 daemon.json=' + (() => { try { return readFileSync(daemonFile, 'utf8') } catch { return '(缺失)' } })().slice(0, 400)
      + '\n宿主输出：\n' + (child._p13logs.out + child._p13logs.err).slice(-800))
    assert.deepEqual(daemon.pipeline.stages, ['soldier-research', 'soldier-listing'], '守护阶段集合 = 数据面启用岗位')
    assert.equal(daemon.pipeline.version, version, '守护记录的内容指纹应与写入返回一致')
    assert.equal(daemon.scope, SCOPE)

    // 开工预检：此刻守护在线 + 流水线已配置 → 无 error 级项
    const prov = await req(fx.base, 'GET', `/team-hub/api/spaces/provision?id=${SCOPE}`, undefined, TOKEN)
    assert.equal(prov.status, 200, JSON.stringify(prov.data))
    const errs = prov.data.checks.filter((c) => c.level === 'error').map((c) => c.code)
    assert.deepEqual(errs, [], '守护在线 + 流水线就绪 → 不应有 error 级阻塞：' + JSON.stringify(prov.data.checks))
    assert.ok(prov.data.checks.some((c) => c.code === 'daemon-online'), '预检应识别到该空间守护在线')
    assert.ok(prov.data.checks.some((c) => c.code === 'pipeline-configured'), '预检应识别到流水线已配置')
  }, { timeout: 60000 })

  it('⑦ P4-2 诊断对照：健康宿主的日志不产生任何「插件加载失败」误报', async () => {
    // 反假阳性对照：诊断层是给失败现场用的，但它在**健康**日志上必须安静——
    // 否则「诊断」会变成新的噪音源。这里用真实宿主的实际日志（stdout+stderr）。
    const logText = child._p13logs.out + child._p13logs.err
    const diag = diagnoseHostLogs({ logText, rows: fx.rows, repoRoot: REPO })
    assert.deepEqual(diag.problems, [], '健康宿主不该被诊断出插件加载失败：' + JSON.stringify(diag.problems))
    // 组合行真值来自 fixture 写的补丁层：三个 legion 插件条目都在其中（诊断据此定位插件名）
    const names = fx.rows.map((r) => r.name)
    for (const n of ['@dsh-external/dsh-team-hub', '@dsh-external/dsh-scrum-board', '@dsh-external/dsh-scrum-worker']) {
      assert.ok(names.includes(n), `组合行里应有 ${n}，实际：${names.join(', ')}`)
    }
    const pre = fx.preflight()
    assert.ok(pre.checked >= 3, '预检应至少覆盖三个 legion 插件条目，实际 ' + pre.checked)
  })

  it('⑧ 关闭清理：bounded dispose 结束 SSE、进程自然退出 exit 0', async () => {
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

/**
 * P4-2（候选 #9）**负向**验证：把两种真实的「插件条目导入失败」交给真实宿主复现，
 * 断言诊断**快速**给出「哪个插件、哪个入口、什么错误、怎么修」，而不是等 45–60s 报「未就绪」。
 *
 * 为什么必须负向验证：诊断代码最容易变成「写得很漂亮但从没跑过」。两个场景各自独立夹具，
 * 保证失败可归因（同宿主挂两个坏条目时，宿主会在第一处失败就退出，第二处的错误可能根本不出现）：
 *   A) `file://…/broken-plugin.mjs`：模块在**导入期**抛错；
 *   B) `@dsh-external/dsh-p13-missing`：package.json 的 main 指向不存在的 lib/index.js
 *      —— **复现 CI 现场**（`team-hub/lib` 缺失时宿主只报「60s 未就绪」）。
 */
describeHost('P4-2 宿主插件导入失败：诊断可读性（负向 · 入口文件在导入期抛错）', () => {
  let fx, child

  before(async () => {
    const port = await freePort()
    fx = makeFixture({
      port,
      extraRows: [
        "    - id: p13-broken-file\n      name: 'file:///" + join(REPO, 'tests', 'p13-fixture', 'broken-plugin.mjs').replace(/\\/g, '/') + "'",
      ],
    })
    child = spawnHost(fx)
    // 实测：导入期抛错**不阻止**宿主把树挂起来（/__p13/ready 一度 200），随后 audit 失败 exit 1。
    // 因此这里等的是日志里那句装载器错误，而不是「未就绪」——这正是旧诊断看不到失败的原因。
    const seen = await waitLog(child, 'failed to import loader entry', { timeoutMs: 30000 })
    assert.ok(seen, '宿主日志里应出现装载器的条目导入失败文本；实际尾部：\n' + (child._p13logs.out + child._p13logs.err).slice(-1200))
  }, { timeout: 60000 })

  after(async () => {
    if (child && child.exitCode === null) { try { child.kill() } catch { /* gone */ } }
    if (fx) fx.cleanup()
  }, { timeout: 15000 })

  it('诊断点名坏条目：id + 入口文件 + 插件自己的错误 + 处置建议（结构化 + 可读两种形态）', () => {
    const logText = child._p13logs.out + child._p13logs.err
    const diag = diagnoseHostLogs({ logText, rows: fx.rows, repoRoot: REPO })
    assert.equal(diag.problems.length, 1, '应恰好定位到一处问题：' + JSON.stringify(diag.problems))
    const p = diag.problems[0]
    assert.equal(p.kind, 'import_threw', '入口存在却导入失败 → import_threw，实际：' + p.kind)
    assert.match(p.plugin, /^p13-broken-file（file:\/\/\//, '应点名组合行 id：' + p.plugin)
    assert.equal(p.entry, join(REPO, 'tests', 'p13-fixture', 'broken-plugin.mjs'), '应给出该行的入口文件')
    assert.match(p.detail, /故意在导入期抛错/, '应带上插件自己抛出的错误')
    assert.match(p.hint, /导入期/, '应说明失败发生在导入期')

    const text = formatDiagnosis(diag, { logText })
    assert.match(text, /宿主插件加载失败（已定位 1 处）/)
    assert.match(text, /入口：/)
    assert.match(text, /处置：/)
    assert.match(text, /宿主日志尾部/)
    // 健康条目不得被牵连
    assert.ok(!/dsh-team-hub|dsh-scrum-board|dsh-scrum-worker/.test(p.plugin), '不得牵连健康条目')
  })

  it('真实后果：宿主确实因该条目退出 exit 1（旧表现：客户端只看到「未就绪/路由缺失」）', async () => {
    const code = await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode)
      const timer = setTimeout(() => resolve('TIMEOUT'), 30000)
      child.once('close', (c) => { clearTimeout(timer); resolve(c) })
    })
    assert.equal(code, 1, '插件导入失败的宿主应以 exit 1 退出（实际 ' + code + '）')
    const logText = child._p13logs.out + child._p13logs.err
    assert.match(logText, /plugin tree failed to load/, '日志应带 app-boot 的阶段标签')
    assert.match(logText, /failed to import loader entry p13-broken-file/, '日志应带装载器点名的条目')
  }, { timeout: 40000 })
})

describeHost('P4-2 宿主插件导入失败：诊断可读性（负向 · 入口产物缺失）', () => {
  let fx, child, missingDir

  before(async () => {
    const port = await freePort()
    missingDir = mkdtempSync(join(tmpdir(), 'p13-missing-pkg-'))
    mkdirSync(join(missingDir, 'lib'), { recursive: true })
    writeFileSync(join(missingDir, 'package.json'), JSON.stringify({ name: 'dsh-p13-missing', version: '0.0.0', main: './lib/index.js' }))
    fx = makeFixture({
      port,
      extraPackages: { 'dsh-p13-missing': missingDir },
      extraRows: ["    - id: p13-broken-missing\n      name: '@dsh-external/dsh-p13-missing'"],
    })
    child = spawnHost(fx)
    // 该场景宿主**来不及**就绪：入口解析失败发生在树挂载期 → 直接从「未就绪」变成 exit 1
    const died = await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(true)
      const timer = setTimeout(() => resolve(false), 30000)
      child.once('close', () => { clearTimeout(timer); resolve(true) })
    })
    assert.ok(died, '入口缺失的宿主应在 30s 内退出；实际仍在运行（日志尾部：\n' + (child._p13logs.out + child._p13logs.err).slice(-800) + '）')
    await drainLogs(child)   // 等 stdio 排空，否则诊断只能看到被截断的日志
  }, { timeout: 60000 })

  after(async () => {
    if (child && child.exitCode === null) { try { child.kill() } catch { /* gone */ } }
    if (fx) fx.cleanup()
    if (missingDir) { try { rmSync(missingDir, { recursive: true, force: true }) } catch { /* tmp */ } }
  }, { timeout: 15000 })

  it('预检：入口不存在的条目在**启动之前**就被点名（含处置建议），不靠超时发现', () => {
    const pre = fx.preflight()
    const p = pre.problems.find((x) => x.plugin.includes('p13-broken-missing'))
    assert.ok(p, '预检应点名 p13-broken-missing，实际：' + JSON.stringify(pre))
    assert.match(p.entry, /lib[\\/]index\.js$/, '应给出缺失的入口路径')
    assert.match(p.hint, /入口文件不存在|入口产物缺失/, '应给出可行动的处置建议：' + p.hint)
    assert.ok(!pre.problems.some((x) => x.plugin.includes('p13-team-hub')), '健康条目不得误报')
  })

  it('真实宿主：入口缺失也能被反查到具体条目（真实宿主只打 `Cannot find package <路径>`）', async () => {
    const t0 = Date.now()
    let err = null
    try {
      // 宿主已退出：waitReady 必须**立刻**给出诊断（而不是等满 60s 超时）
      await waitReady(fx.base, { child, rows: fx.rows, timeoutMs: 60000 })
    } catch (e) { err = e }
    const elapsed = Date.now() - t0

    assert.ok(err, '宿主已退出 → 不应报「就绪」')
    assert.equal(err.name, 'HostBootError', '应抛出 HostBootError：' + String(err?.message ?? err).slice(0, 300))
    const msg = err.message
    assert.match(msg, /宿主进程已退出/)
    assert.match(msg, /p13-broken-missing|dsh-p13-missing/, '诊断必须把裸模块错误反查到组合行（否则只能报「未能定位」）')
    assert.match(msg, /lib[\\/]index\.js/, '应给出缺失的入口路径')
    assert.match(msg, /处置：/, '应给出处置建议')
    assert.ok(elapsed < 10000, `进程已退出时应即时失败（实际 ${elapsed}ms）`)
    const kinds = err.diagnosis.problems.map((p) => p.kind)
    assert.ok(kinds.includes('missing_entry'), '问题类型应为 missing_entry，实际：' + JSON.stringify(kinds))
  }, { timeout: 40000 })

  it('解析的是真实宿主日志（不是自造文本）：日志里确有 app-boot / Node 的解析失败原文', () => {
    const logText = child._p13logs.out + child._p13logs.err
    assert.match(logText, /plugin\(s\) failed to load|did not activate|Cannot find (module|package)|ERR_MODULE_NOT_FOUND/,
      '宿主日志里应出现真实加载失败文本；实际尾部：\n' + logText.slice(-800))
    assert.equal(child.exitCode, 1, '插件加载失败的宿主应以 exit 1 退出（旧症状：客户端只看到「60s 未就绪」）')
  }, { timeout: 20000 })
})
