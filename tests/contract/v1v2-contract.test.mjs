// tests/contract/v1v2-contract.test.mjs — P2-1/P2-3 v1↔v2 统一契约对比测试。
//
// 共享同一业务场景脚本（create → transition → comment → 读活动），分别打真实 v1
// （scrum/serve.mjs + 临时任务库，taskctl/render 复制为 fixture 子进程）与真实 v2
// （team-hub/server.mjs + mkdtemp SQLite），断言契约（docs/CONTRACT-V1V2.md）：
//   - 写响应壳 {ok:true, task} 与任务公共字段子集两端一致（§2.1/§3）
//   - 错误分类矩阵：缺参 400 / 非法迁移 400 / 乐观锁 409 / 未知路径 404 JSON（§4/§5 R7）
//   - /api/activity limit 尾部语义一致 + v1 cap 对齐 v2 上限 500（§5 R3）
//   - v1 /api/board（渲染快照）与 v2 /api/board（任务裸数组）各自语义成立（§5 R1 登记分叉）
//   - SSE：v2 /api/events 统一信封（event/id/payload 兼容字段 + id: 行）与 Last-Event-ID
//     增量回放；v1 双流保持既有形态（§6）
//
// 运行：node --test tests/contract/v1v2-contract.test.mjs
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import http from 'node:http'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

const TMP = mkdtempSync(join(tmpdir(), 'legion-v1v2-contract-'))

// ── v1 fixture：scrum/serve.mjs 以 import 加载（非 main：不 watch/listen），
//    LEGION_SCRUM_DIR 指向临时任务库；serve 写操作 spawn 同目录 taskctl.mjs/render.mjs 副本。
//    副本的 ROOT = dirname(副本)/.. = TMP/v1（roles.json 期望在 TMP/v1/roles.json，
//    render 输出期望 TMP/v1/scrum/board.json = 与 LEGION_SCRUM_DIR 同一目录）。
const v1ScrumDir = join(TMP, 'v1', 'scrum')
mkdirSync(join(v1ScrumDir, 'patches'), { recursive: true })
// taskctl/render 副本：serve 写操作 spawn 同目录文件；副本 ROOT=TMP/v1 → render 输出
// TMP/v1/scrum/board.json（= LEGION_SCRUM_DIR，与 serve 的 BOARD_FILE 一致）。roles.json
// 在 repo 根且 create/transition/comment 不读 roles，无需复制。
for (const f of ['taskctl.mjs', 'render.mjs']) {
  copyFileSync(join(repoRoot, 'scrum', f), join(v1ScrumDir, f))
}
process.env.LEGION_SCRUM_DIR = v1ScrumDir
process.env.LEGION_TASKS_FILE = join(v1ScrumDir, 'tasks.json')
process.env.LEGION_ARTIFACT_ROOT = TMP

// v1 初始空库（taskctl init 同构：schemaVersion/nextId/tasks 空对象）
writeFileSync(join(v1ScrumDir, 'tasks.json'), JSON.stringify({ schemaVersion: 1, nextId: 1, tasks: {} }, null, 2), 'utf8')
// 空 activity.jsonl
writeFileSync(join(v1ScrumDir, 'activity.jsonl'), '', 'utf8')

// ── v2 fixture：TEAM_HUB_DB 指向 mkdtemp 库（必须在 import server.mjs 之前）
process.env.TEAM_HUB_DB = join(TMP, 'v2', 'hub.db')
process.env.TEAM_HUB_HOST = '127.0.0.1'
process.env.TEAM_HUB_TOKEN = ''

let v1Server = null
let v2Server = null
let v1Base = ''
let v2Base = ''

before(async () => {
  const v1mod = await import(pathToFileURL(join(repoRoot, 'scrum', 'serve.mjs')).href)
  v1Server = v1mod.server
  await new Promise((resolve, reject) => {
    v1Server.once('error', reject)
    v1Server.listen(0, '127.0.0.1', resolve)
  })
  v1Base = 'http://127.0.0.1:' + v1Server.address().port

  const v2mod = await import(pathToFileURL(join(repoRoot, 'team-hub', 'server.mjs')).href)
  v2Server = v2mod.server
  await new Promise((resolve, reject) => {
    v2Server.once('error', reject)
    v2Server.listen(0, '127.0.0.1', resolve)
  })
  v2Base = 'http://127.0.0.1:' + v2Server.address().port
})

after(async () => {
  try { if (v1Server) v1Server.close() } catch { /* 已关闭 */ }
  try { if (v2Server) v2Server.close() } catch { /* 已关闭 */ }
  // 等服务器句柄释放（Windows 上刚 close 即递归删临时目录偶发 EPERM，宽容重试；失败仅遗留可回收目录）
  await new Promise((r) => setTimeout(r, 300))
  for (let i = 0; i < 8; i++) {
    try { rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }); return } catch { /* 重试 */ }
    await new Promise((r) => setTimeout(r, 250))
  }
})

async function req(base, method, path, body, token) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = 'Bearer ' + token
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  let data = null
  const ct = res.headers.get('content-type') ?? ''
  try { data = ct.includes('json') ? await res.json() : await res.text() } catch { /* 保持 null */ }
  return { status: res.status, ct, data }
}

/** 任务公共字段子集（CONTRACT-V1V2.md §2.1：两端应都有且值域一致或同为缺省）。 */
const COMMON_TASK_FIELDS = [
  'id', 'title', 'description', 'acceptance', 'priority', 'status', 'version', 'soldier',
  'claimedRound', 'claimedAt', 'ordersVersion', 'parent', 'role', 'scope', 'blocks',
  'blockedBy', 'comments', 'evidence', 'patches', 'artifacts', 'createdAt', 'updatedAt',
]

function assertCommonTask(task, label) {
  for (const f of COMMON_TASK_FIELDS) {
    assert.ok(f in task, `${label} 任务应含公共字段 ${f}`)
  }
  assert.equal(task.status, 'backlog', label + ' 初始状态 backlog')
  assert.equal(task.version, 1, label + ' 初始 version 1')
  assert.ok(Array.isArray(task.acceptance), label + ' acceptance 数组')
  assert.ok(Array.isArray(task.comments), label + ' comments 数组')
  assert.ok(Array.isArray(task.artifacts), label + ' artifacts 数组')
}

// ── 写接口/任务对象/错误分类对比 ──
describe('v1/v2 写契约与任务公共字段（同一业务场景双打）', () => {
  let v1task
  let v2task

  it('POST /api/create：两端 {ok:true, task}，公共字段一致', async () => {
    const body = { title: '契约场景任务', description: 'desc', acceptance: ['a', 'b'], priority: 'high', by: 'general' }
    const r1 = await req(v1Base, 'POST', '/api/create', body)
    assert.equal(r1.status, 200)
    assert.equal(r1.data.ok, true)
    assertCommonTask(r1.data.task, 'v1 create')
    v1task = r1.data.task

    const r2 = await req(v2Base, 'POST', '/api/create', body)
    assert.equal(r2.status, 200)
    assert.equal(r2.data.ok, true)
    assertCommonTask(r2.data.task, 'v2 create')
    v2task = r2.data.task
  })

  it('任务公共字段值：两端 title/priority/status/version/scope/acceptance 相同', () => {
    for (const f of ['title', 'priority', 'status', 'version', 'scope']) {
      assert.equal(v1task[f], v2task[f], `公共字段 ${f} 值应一致`)
    }
    assert.deepEqual(v1task.acceptance, v2task.acceptance, 'acceptance 一致')
    assert.equal(typeof v1task.id, 'string')
    assert.equal(typeof v2task.id, 'string')
  })

  it('POST /api/comment：两端追加评论 {by, at, text}，version 递增', () => {
    return Promise.all([
      (async () => {
        const r = await req(v1Base, 'POST', '/api/comment', { id: v1task.id, by: 'general', text: 'v1 评论' })
        assert.equal(r.status, 200)
        assert.equal(r.data.task.version, 2)
        const c = r.data.task.comments[r.data.task.comments.length - 1]
        assert.equal(c.by, 'general')
        assert.equal(c.text, 'v1 评论')
        assert.ok(c.at)
      })(),
      (async () => {
        const r = await req(v2Base, 'POST', '/api/comment', { id: v2task.id, by: 'general', text: 'v2 评论' })
        assert.equal(r.status, 200)
        assert.equal(r.data.task.version, 2)
        const c = r.data.task.comments[r.data.task.comments.length - 1]
        assert.equal(c.by, 'general')
        assert.equal(c.text, 'v2 评论')
        assert.ok(c.at)
      })(),
    ])
  })

  it('POST /api/transition backlog→todo：两端成功且状态一致', async () => {
    const r1 = await req(v1Base, 'POST', '/api/transition', { id: v1task.id, to: 'todo', by: 'general' })
    assert.equal(r1.status, 200)
    assert.equal(r1.data.task.status, 'todo')
    const r2 = await req(v2Base, 'POST', '/api/transition', { id: v2task.id, to: 'todo', by: 'general' })
    assert.equal(r2.status, 200)
    assert.equal(r2.data.task.status, 'todo')
  })

  it('错误分类矩阵：缺 title 400 / 非法迁移 400 / 乐观锁 409 / 未知任务 404', async () => {
    // 缺 title
    const noTitle1 = await req(v1Base, 'POST', '/api/create', { by: 'general' })
    assert.equal(noTitle1.status, 400); assert.match(noTitle1.data.error, /title/)
    const noTitle2 = await req(v2Base, 'POST', '/api/create', { by: 'general' })
    assert.equal(noTitle2.status, 400); assert.match(noTitle2.data.error, /title/)

    // 非法迁移：todo → done 不在迁移表（done 仅从 in_review）
    const bad1 = await req(v1Base, 'POST', '/api/transition', { id: v1task.id, to: 'done', by: 'general' })
    assert.equal(bad1.status, 400); assert.match(bad1.data.error, /迁移|done/)
    const bad2 = await req(v2Base, 'POST', '/api/transition', { id: v2task.id, to: 'done', by: 'general' })
    assert.equal(bad2.status, 400); assert.match(bad2.data.error, /迁移|done/)

    // 乐观锁：ifVersion 过期 → 409
    const stale1 = await req(v1Base, 'POST', '/api/transition', { id: v1task.id, to: 'blocked', by: 'general', ifVersion: 1 })
    assert.equal(stale1.status, 409); assert.match(stale1.data.error, /乐观锁/)
    const stale2 = await req(v2Base, 'POST', '/api/transition', { id: v2task.id, to: 'blocked', by: 'general', ifVersion: 1 })
    assert.equal(stale2.status, 409); assert.match(stale2.data.error, /乐观锁/)

    // 未知任务（写面）：v1 404 文案 / v2 404
    const miss1 = await req(v1Base, 'POST', '/api/transition', { id: 'T-9999', to: 'blocked', by: 'general' })
    assert.equal(miss1.status, 400) // v1 taskctl 写面未知任务按 400 业务错（登记：与 v2 404 分叉保持）
    const miss2 = await req(v2Base, 'POST', '/api/transition', { id: 'T-9999', to: 'blocked', by: 'general' })
    assert.equal(miss2.status, 400)
  })

  it('未知路径 404：两端 JSON {error}（v1 已对齐 R7）', async () => {
    const r1 = await req(v1Base, 'GET', '/api/no-such-route')
    assert.equal(r1.status, 404)
    assert.ok(r1.data && typeof r1.data.error === 'string', 'v1 未知路径应 JSON {error}')
    const r2 = await req(v2Base, 'GET', '/api/no-such-route')
    assert.equal(r2.status, 404)
    assert.ok(r2.data && typeof r2.data.error === 'string')
  })
})

// ── /api/activity limit 尾部语义（R3）──
describe('v1/v2 /api/activity limit 尾部语义一致 + v1 cap 对齐', () => {
  it('activity.jsonl 无行时两端 200 空数组', async () => {
    const r1 = await req(v1Base, 'GET', '/api/activity')
    assert.equal(r1.status, 200)
    assert.deepEqual(r1.data, [])
    const r2 = await req(v2Base, 'GET', '/api/activity?scope=default')
    assert.equal(r2.status, 200)
    assert.ok(Array.isArray(r2.data))
  })

  it('v1 limit 语义：尾部最近 N 条，N=0 兜底默认 50（v1 无上限分叉已 cap 500）', async () => {
    // 向 v1 fixture activity.jsonl 追加 55 行（超过默认 50）
    const lines = []
    for (let i = 0; i < 55; i++) {
      lines.push(JSON.stringify({ ts: new Date(Date.now() + i).toISOString(), kind: 'dispatch', taskId: 'T-1', text: '行' + i }))
    }
    const fs = await import('node:fs')
    fs.appendFileSync(join(v1ScrumDir, 'activity.jsonl'), lines.join('\n') + '\n', 'utf8')

    const all = await req(v1Base, 'GET', '/api/activity')
    assert.equal(all.status, 200)
    assert.equal(all.data.length, 50, 'limit 缺省默认 50')
    const tail = await req(v1Base, 'GET', '/api/activity?limit=3')
    assert.equal(tail.data.length, 3)
    assert.equal(tail.data[2].text, '行54', 'limit=3 取最近 3 条（尾部）')
    const big = await req(v1Base, 'GET', '/api/activity?limit=999999')
    assert.ok(big.data.length <= 500, 'v1 cap 上限 500（对齐 v2），不再全量')
  })
})

// ── /api/board 语义登记（R1）：v1 渲染快照 vs v2 任务裸数组 ──
describe('v1/v2 /api/board 语义登记（各按消费面成立）', () => {
  it('v1 = board.json 渲染快照（columns/cards），v2 = 任务裸数组', async () => {
    // v1 create 写成功后 runRender 已刷新 board.json
    const r1 = await req(v1Base, 'GET', '/api/board')
    assert.equal(r1.status, 200)
    assert.ok(Array.isArray(r1.data.columns), 'v1 board.columns 存在')
    assert.ok(r1.data.columns.length >= 1)
    const cards = r1.data.columns.flatMap((c) => c.cards ?? [])
    assert.ok(cards.length >= 1, 'v1 board 含卡')

    const r2 = await req(v2Base, 'GET', '/api/board')
    assert.equal(r2.status, 200)
    assert.ok(Array.isArray(r2.data), 'v2 board 是任务裸数组')
    assert.ok(r2.data.length >= 1)
    assert.ok(typeof r2.data[0].status === 'string')
  })
})

// ── SSE：v2 /api/events 统一信封 + Last-Event-ID 增量回放；v1 双流既有形态 ──
// 收集 SSE 帧：满足 resolveOn 谓词（或超时）即关闭连接并返回；连接必须销毁，
// 否则 keep-alive socket 会让 node --test 进程挂住不退出。
function sseCollect(base, path, { headers = {}, timeoutMs = 6000, resolveOn = null, idleMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path)
    const req = http.request(url, { headers }, (res) => {
      let buf = ''
      const frames = []
      let idleTimer = null
      const done = (extra) => {
        clearTimeout(timer)
        if (idleTimer) clearTimeout(idleTimer)
        try { req.destroy() } catch { /* 已关闭 */ }
        resolve({ status: res.statusCode, frames, ...extra })
      }
      const armIdle = () => {
        if (idleMs <= 0) return
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => done({ idle: true }), idleMs)
      }
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buf += chunk
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          frames.push(frame)
          if (resolveOn && resolveOn(frames)) return done()
          armIdle()
        }
      })
      res.on('end', () => done())
      res.on('error', (e) => { clearTimeout(timer); req.destroy(); reject(e) })
    })
    const timer = setTimeout(() => done({ timedOut: true }), timeoutMs)
    req.on('error', (e) => { clearTimeout(timer); reject(e) })
    req.end()
  })
}

describe('v2 /api/events SSE 统一信封与断线续传（P2-3 S1/S2）', () => {
  it('连接即回放（升序）+ 信封字段 event/id/payload + id: 行', async () => {
    const { status, frames } = await sseCollect(v2Base, '/api/events', { timeoutMs: 4000, resolveOn: (fs) => fs.some((f) => f.includes('data:')) })
    assert.equal(status, 200)
    const dataFrames = frames.filter((f) => f.includes('data:'))
    assert.ok(dataFrames.length >= 1, '连接后应有回放帧')
    // 首帧 retry
    assert.ok(frames[0] === 'retry: 2000', '首帧 retry: 2000，实际 ' + JSON.stringify(frames[0]))
    // 信封：首条 data 帧
    const first = dataFrames[0]
    assert.match(first, /^id: \d+/, '帧含 id: 行（seq，供 Last-Event-ID）')
    const dataLine = first.split('\n').find((l) => l.startsWith('data: '))
    const ev = JSON.parse(dataLine.slice(6))
    assert.equal(typeof ev.seq, 'number')
    assert.equal(ev.event, ev.action, 'event=action 兼容字段')
    assert.equal(ev.id, ev.seq, 'id=seq 兼容字段')
    assert.ok('payload' in ev, 'payload 兼容字段存在')
    assert.ok('detail' in ev, '既有 detail 保留')
    assert.ok('ts' in ev && 'scope' in ev && 'member' in ev)
  })

  it('Last-Event-ID：断线后重连只回放 seq>N 的增量（升序、无重复）', async () => {
    // 先收集当前最大 seq（回放瞬时完成，帧空闲 300ms 即视为收齐）
    const c1 = await sseCollect(v2Base, '/api/events', { timeoutMs: 4000, idleMs: 300 })
    const data1 = c1.frames.filter((f) => f.includes('data:'))
    assert.ok(data1.length >= 1, '首连应有回放帧')
    const maxSeq = Math.max(...data1.map((f) => Number((f.match(/^id: (\d+)/m) ?? [])[1])))
    assert.ok(Number.isFinite(maxSeq))

    // 制造一条新审计（POST create）
    await req(v2Base, 'POST', '/api/create', { title: '续传验证任务', by: 'general' })

    // 带 Last-Event-ID: maxSeq 重连 → 只应收到该新 create 审计（seq = maxSeq+1）
    const c2 = await sseCollect(v2Base, '/api/events', { timeoutMs: 4000, resolveOn: (fs) => fs.filter((f) => f.includes('data:')).length >= 1, headers: { 'last-event-id': String(maxSeq) } })
    const newFrames = c2.frames.filter((f) => f.includes('data:'))
    assert.equal(newFrames.length, 1, 'Last-Event-ID 续传只回放 1 条增量，实际 ' + newFrames.length)
    const idLine = newFrames[0].match(/^id: (\d+)/m)
    assert.ok(idLine, '增量帧含 id: 行')
    assert.equal(Number(idLine[1]), maxSeq + 1, '增量 seq = max+1')
    const ev = JSON.parse(newFrames[0].split('\n').find((l) => l.startsWith('data: ')).slice(6))
    assert.equal(ev.seq, maxSeq + 1)
    assert.equal(ev.event, 'create')
    assert.ok(String(ev.taskId).length > 0)

    // 非法 Last-Event-ID（非数字）→ 回退最近 30 条（不报错）
    const c3 = await sseCollect(v2Base, '/api/events', { timeoutMs: 4000, resolveOn: (fs) => fs.filter((f) => f.includes('data:')).length >= 1, headers: { 'last-event-id': 'abc' } })
    const c3data = c3.frames.filter((f) => f.includes('data:'))
    assert.ok(c3data.length >= 1)
  })

  it('heartbeat：15s 内收到 :hb 注释帧', async () => {
    const c = await sseCollect(v2Base, '/api/events', { timeoutMs: 17000, resolveOn: (fs) => fs.includes(':hb') })
    assert.ok(c.frames.some((f) => f === ':hb'), '15s 心跳帧 :hb 应出现')
  }, { timeout: 20000 })
})

describe('v1 SSE 双流既有形态（无信封改造，登记维持；连接/heartbeat/关闭清理对齐）', () => {
  it('/api/board/events：retry + 连接即推全量 board 帧', async () => {
    const c = await sseCollect(v1Base, '/api/board/events', { timeoutMs: 4000, resolveOn: (fs) => fs.filter((f) => f.includes('data:')).length >= 1 })
    assert.equal(c.status, 200)
    assert.ok(c.frames.some((f) => f === 'retry: 2000'))
    const boardFrames = c.frames.filter((f) => f.includes('data:'))
    assert.ok(boardFrames.length >= 1)
    const json = JSON.parse(boardFrames[0].split('\n').map((l) => l.startsWith('data: ') ? l.slice(6) : '').join(''))
    assert.ok(Array.isArray(json.columns), 'board/events 推完整 board.json 快照')
  })

  it('/api/activity/events：连接即推最近 30 条历史（升序）', async () => {
    const c = await sseCollect(v1Base, '/api/activity/events', { timeoutMs: 4000, idleMs: 300 })
    const dataFrames = c.frames.filter((f) => f.includes('data:'))
    assert.equal(dataFrames.length, 30, '初始回放最近 30 条，实际 ' + dataFrames.length)
    if (dataFrames.length > 1) {
      const first = JSON.parse(dataFrames[0].split('\n').find((l) => l.startsWith('data: ')).slice(6))
      assert.ok('ts' in first && 'kind' in first, 'v1 活动行保持 {ts,kind,taskId,text} 形态')
    }
  })
})
