// board-plugin/tests/http-contract.test.mjs — P1-2 board-plugin 宿主 HTTP 契约测试。
//
// 运行：
//   1) node scripts/ci/build-external-package.mjs board-plugin   （需要 DSH_CHECKOUT 或默认候选路径）
//   2) node --test board-plugin/tests/http-contract.test.mjs
//
// 目标：在无完整 DSH GUI 的前提下，注入「编译后的 board-plugin」到一个最小 fake
// webServer context + 真实临时 HTTP 服务，覆盖 /api/artifact 逐条（raw/content-type/
// 越权/符号链接/404）、/api/board、/api/activity、SSE 初始/增量、/api/config、
// /api/daemon、/api/patch、kanban/console 前缀重写、本地写接口（fixture taskctl 替身）
// 与 hub 模式（fake team-hub 服务器）的 scope/token/错误映射。
// 产物 API 语义与 scrum/artifact-detail.test.mjs 使用同一组断言（K4-B/K5-A）。
// 说明：fixture taskctl.mjs / render.mjs 只是 HTTP 契约替身；真实 DSH 宿主注入冒烟
// （inject 生命周期、route prefix、SSE 清理）另行在宿主环境保留，不以 mock 冒充宿主验证。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, appendFileSync,
} from 'node:fs'
import { createServer, get as httpGet } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const T0 = '2026-09-01T00:00:00.000Z'
const T1 = '2026-09-02T00:00:00.000Z'

// ── 通用小工具 ──
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function jsonReq(base, path, opts = {}) {
  const { method = 'GET', body, headers = {} } = opts
  const init = { method, headers: { ...headers } }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return fetch(base + path, init)
}

async function getJson(base, path) {
  const res = await jsonReq(base, path)
  let data = null
  try { data = await res.json() } catch { /* 非 JSON */ }
  return { status: res.status, ct: res.headers.get('content-type'), data }
}

async function postJson(base, path, body) {
  const res = await jsonReq(base, path, { method: 'POST', body })
  let data = null
  try { data = await res.json() } catch { /* 非 JSON */ }
  return { status: res.status, data }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}
function closeServer(server) {
  return new Promise((resolve) => {
    try { server.closeAllConnections?.() } catch { /* ignore */ }
    server.close(() => resolve())
  })
}

/** fake webServer context：捕获 route 注册 + effect disposer，构造临时 HTTP 服务。 */
async function startBoardPlugin(options) {
  const disposers = []
  const registrations = []
  const fakeCtx = {
    webServer: {
      port: 38080,
      register(route) {
        registrations.push(route)
        return () => {
          const i = registrations.indexOf(route)
          if (i >= 0) registrations.splice(i, 1)
        }
      },
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  }
  apply(fakeCtx, {
    scrumDir: options.scrumDir,
    routePrefix: options.routePrefix ?? '/scrum-board',
    hubUrl: options.hubUrl ?? '',
    scope: options.scope ?? 'software',
    hubToken: options.hubToken ?? '',
    artifactRoots: options.artifactRoots ?? [],
  })
  const server = createServer((req, res) => {
    const route = registrations[0]
    if (!route?.handler) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('no plugin route')
      return
    }
    route.handler(req, res)
  })
  await listen(server)
  const base = 'http://127.0.0.1:' + server.address().port
  return {
    base,
    stop: async () => {
      await closeServer(server)
      for (const d of [...disposers].reverse()) {
        try { d() } catch { /* 已清理 */ }
      }
    },
  }
}

/** 简单 SSE 客户端：按 \n\n 切帧，waitFor 帧内文本。 */
function sseClient(base, path) {
  const frames = []
  let buf = ''
  let status = null
  const req = httpGet(base + path, (res) => {
    status = res.statusCode
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        frames.push(frame)
      }
    })
  })
  req.on('error', () => { /* destroy 后忽略 */ })
  return {
    get status() { return status },
    frames,
    waitFor(needle, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs
      return new Promise((resolve, reject) => {
        const tick = () => {
          if (frames.some((f) => f.includes(needle))) return resolve(true)
          if (Date.now() >= deadline) {
            return reject(new Error(`SSE 未收到 ${needle}；frames=${JSON.stringify(frames)}`))
          }
          setTimeout(tick, 25)
        }
        tick()
      })
    },
    close() { try { req.destroy() } catch { /* ignore */ } },
  }
}

/** fixture 任务对象（与 scrum/artifact-detail.test.mjs 同语义）。 */
function task(id, artifacts, status = 'in_review') {
  return {
    id, title: 'fixture ' + id, description: '', acceptance: [], priority: 'medium',
    status, version: 1, soldier: null, claimedRound: null, claimedAt: null, parent: null,
    role: 'requirement', scope: 'software', hold: false, blocks: [], blockedBy: [],
    comments: [], evidence: [], patches: [], artifacts, progress: [], updatedAt: T1,
  }
}

/** 隔离 fixture：base 即 repoRoot，base/scrum 即 scrumDir；含 link-in/link-out junction。 */
function buildFixture() {
  const base = mkdtempSync(join(tmpdir(), 'board-plugin-http-'))
  const outside = mkdtempSync(join(tmpdir(), 'board-plugin-outside-'))
  const scrumDir = join(base, 'scrum')
  mkdirSync(join(scrumDir, 'patches'), { recursive: true })
  mkdirSync(join(base, 'docs'), { recursive: true })
  mkdirSync(join(base, 'out'), { recursive: true })
  mkdirSync(join(base, '.legion-worktrees', 'T-200', 'docs'), { recursive: true })

  // 静态 fixture：taskctl/render 替身、kanban/console、roles.json
  cpSync(join(FIXTURES, 'taskctl.mjs'), join(scrumDir, 'taskctl.mjs'))
  cpSync(join(FIXTURES, 'render.mjs'), join(scrumDir, 'render.mjs'))
  cpSync(join(FIXTURES, 'kanban.html'), join(scrumDir, 'kanban.html'))
  cpSync(join(FIXTURES, 'console.html'), join(scrumDir, 'console.html'))
  cpSync(join(FIXTURES, 'roles.json'), join(base, 'roles.json'))
  writeFileSync(join(scrumDir, 'patches', 'ok-123.patch'), 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n', 'utf8')

  // 产物内容：主仓根 / 分支态（worktree 优先）
  writeFileSync(join(base, 'docs', 'x.md'), '# 方案\nMAIN 主仓内容\n', 'utf8')
  writeFileSync(join(base, 'docs', 'main.md'), 'MAIN-ONLY\n', 'utf8')
  writeFileSync(join(base, 'out', 'a.html'), '<p>AA</p>', 'utf8')
  writeFileSync(join(base, 'out', 'b.html'), '<p>BB</p>', 'utf8')
  writeFileSync(join(base, '.legion-worktrees', 'T-200', 'docs', 'x.md'), '# 方案\nBRANCH 分支态 v2\n', 'utf8')

  // 符号链接样本：link-out → 根外目录（越权），link-in → 根内 docs（放行）
  let linksOk = true
  try {
    symlinkSync(outside, join(base, 'link-out'), 'junction')
    symlinkSync(join(base, 'docs'), join(base, 'link-in'), 'junction')
  } catch {
    linksOk = false // 无 junction 权限的环境跳过符号链接用例（同 files-api 先例）
  }
  writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET\n', 'utf8')
  writeFileSync(join(base, 'docs', 'inside.txt'), 'INSIDE-OK\n', 'utf8')

  // 任务库
  const tasks = {
    'T-200': task('T-200', [
      { by: 'soldier-auto', at: T0, kind: 'file', path: 'docs/x.md', title: '需求文档（md）' },
      { by: 'soldier-auto', at: T0, kind: 'html', path: 'out/a.html', title: 'A 预览页' },
      { by: 'soldier-auto', at: T0, kind: 'url', path: 'https://example.test/x', title: '外部参考' },
      { by: 'soldier-auto', at: T1, kind: 'html', path: 'out/b.html', title: 'B 预览页' },
    ]),
    'T-MAIN': task('T-MAIN', [{ by: 'soldier-auto', at: T1, kind: 'file', path: 'docs/main.md', title: '主仓 md' }]),
    'T-EMPTY': task('T-EMPTY', []),
    'T-MISSING': task('T-MISSING', [{ by: 'soldier-auto', at: T0, kind: 'file', path: 'docs/nope.md', title: '不存在' }]),
    'T-EVIL': task('T-EVIL', [{ by: 'soldier-auto', at: T0, kind: 'file', path: '../secret.md' }]),
    'T-EVILABS': task('T-EVILABS', [{ by: 'soldier-auto', at: T0, kind: 'file', path: 'C:/Windows/win.ini' }]),
    'T-GIT': task('T-GIT', [{ by: 'soldier-auto', at: T0, kind: 'file', path: '.git/config' }]),
    'T-LINKOUT': task('T-LINKOUT', [{ by: 'soldier-auto', at: T0, kind: 'file', path: 'link-out/secret.txt' }]),
    'T-LINKIN': task('T-LINKIN', [{ by: 'soldier-auto', at: T0, kind: 'file', path: 'link-in/inside.txt' }]),
  }
  writeFileSync(join(scrumDir, 'tasks.json'), JSON.stringify({ schemaVersion: 1, nextId: 100, tasks }, null, 2), 'utf8')

  // activity / daemon / board（board 先按 render 语义预置，启动 render 会再刷新）
  writeFileSync(join(scrumDir, 'activity.jsonl'),
    [
      JSON.stringify({ id: 'act-1', event: 'create', task: 'T-200', ts: T0 }),
      JSON.stringify({ id: 'act-2', event: 'comment', task: 'T-200', ts: T0 }),
      JSON.stringify({ id: 'act-3', event: 'transition', task: 'T-200', ts: T1 }),
      '',
    ].join('\n'), 'utf8')
  writeFileSync(join(scrumDir, 'daemon.json'), JSON.stringify({ pid: 4242, status: 'running', startedAt: T0 }, null, 2), 'utf8')
  const board = {
    fixture: true,
    generatedAt: T0,
    columns: [{ id: 'all', title: '全部', cards: Object.values(tasks).map((t) => ({ id: t.id, title: t.title, status: t.status, version: t.version })) }],
  }
  writeFileSync(join(scrumDir, 'board.json'), JSON.stringify(board), 'utf8')

  return {
    base, scrumDir, outside, linksOk,
    cleanup() {
      // Windows 上含 junction 的目录树在新建后立即递归删除会偶发 EPERM（Defender/索引器瞬时锁）。
      // 先单独移除 junction 本身，再宽容重试删除；仍失败只遗留临时目录（系统可回收），不让套件假红。
      for (const p of [join(base, 'link-out'), join(base, 'link-in')]) {
        try { rmSync(p, { recursive: true, force: true }) } catch { /* junction 删除抖动，随父目录重试 */ }
      }
      for (const p of [base, outside]) {
        try { rmSync(p, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }) } catch { /* 临时目录遗留可回收 */ }
      }
    },
  }
}

// ===================================================================
// 本地文件模式（无 hub、无 DSH 宿主）
// ===================================================================
describe('board-plugin HTTP 契约：本地文件模式（fake webServer + fixture 替身）', () => {
  const origFetch = globalThis.fetch
  let fx
  let board
  let boardFile
  let boardPath

  before(async () => {
    fx = buildFixture()
    boardFile = join(fx.scrumDir, 'board.json')
    boardPath = '/scrum-board'
    // 屏蔽 ambient hub 探测（127.0.0.1:3080），保证本地模式确定性
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('127.0.0.1:3080')) return new Response('', { status: 404 })
      return origFetch(input, init)
    }
    board = await startBoardPlugin({ scrumDir: fx.scrumDir, hubUrl: '', hubToken: '' })
  })

  after(async () => {
    await board.stop()
    globalThis.fetch = origFetch
    fx.cleanup()
  })

  describe('静态与旁路接口', () => {
    it('GET /api/config：pipeline（roles.json 映射）+ daemon + auth:false + 端口', async () => {
      const r = await getJson(board.base, boardPath + '/api/config')
      assert.equal(r.status, 200)
      assert.equal(r.data.auth, false)
      assert.equal(r.data.host, '127.0.0.1')
      assert.equal(r.data.port, 38080) // fake webServer.port
      assert.deepEqual(r.data.pipeline, {
        name: 'fixture-pipeline',
        stages: [
          { role: 'requirement', label: '需求澄清' },
          { role: 'coder', label: '编码实现' },
        ],
      })
      assert.deepEqual(r.data.daemon, { pid: 4242, status: 'running', startedAt: T0 })
    })

    it('GET /api/daemon：文件缺失时返回 {}', async () => {
      const daemonFile = join(fx.scrumDir, 'daemon.json')
      const raw = readFileSync(daemonFile)
      rmSync(daemonFile)
      try {
        const r = await getJson(board.base, boardPath + '/api/daemon')
        assert.equal(r.status, 200)
        assert.deepEqual(r.data, {})
      } finally {
        writeFileSync(daemonFile, raw)
      }
    })

    it('GET /api/patch：非法 id 400 / 不存在 404 / 命中返回 patch 文本', async () => {
      const bad = await getJson(board.base, boardPath + '/api/patch?id=../x')
      assert.equal(bad.status, 400)
      assert.match(bad.data.error, /非法 patch id/)
      const miss = await getJson(board.base, boardPath + '/api/patch?id=nope-1')
      assert.equal(miss.status, 404)
      assert.match(miss.data.error, /patch 不存在/)
      const res = await fetch(board.base + boardPath + '/api/patch?id=ok-123')
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') ?? '', /text\/plain/)
      assert.ok((await res.text()).includes('diff --git'))
    })

    it('kanban/console 页面：HTML 内 /api/* 前缀重写为路由前缀', async () => {
      for (const [path, marker] of [
        [boardPath + '/kanban.html', "'/scrum-board/api/board/events'"],
        [boardPath + '/', "'/scrum-board/api/board/events'"],
        [boardPath + '/console', "'/scrum-board/api/daemon'"],
      ]) {
        const res = await fetch(board.base + path)
        assert.equal(res.status, 200, path)
        assert.match(res.headers.get('content-type') ?? '', /text\/html/)
        const html = await res.text()
        assert.ok(html.includes(marker), `${path} 应含 ${marker}`)
        assert.ok(!html.includes("'/api/board/events'") || path.includes('console') || !html.includes("'/api/board/events'"), `${path} 不应残留未重写绝对 API`)
      }
    })

    it('kanban.html 缺失 → 404 明确文案', async () => {
      const kanbanFile = join(fx.scrumDir, 'kanban.html')
      const raw = readFileSync(kanbanFile)
      rmSync(kanbanFile)
      try {
        const r = await getJson(board.base, boardPath + '/')
        assert.equal(r.status, 404)
        assert.match(r.data.error, /kanban\.html 不存在/)
      } finally {
        writeFileSync(kanbanFile, raw)
      }
    })

    it('未知路径 → 404 JSON；OPTIONS 预检 → 204 + CORS 头', async () => {
      const nf = await getJson(board.base, boardPath + '/nope')
      assert.equal(nf.status, 404)
      assert.match(nf.data.error, /not found/)
      const res = await fetch(board.base + boardPath + '/api/board', { method: 'OPTIONS' })
      assert.equal(res.status, 204)
      assert.match(res.headers.get('access-control-allow-methods') ?? '', /GET, POST, OPTIONS/)
    })

    it('GET /api/board：返回 board.json（render 语义内容）', async () => {
      const r = await getJson(board.base, boardPath + '/api/board')
      assert.equal(r.status, 200)
      assert.match(r.ct ?? '', /application\/json/)
      const cards = r.data.columns.flatMap((c) => c.cards)
      const t200 = cards.find((c) => c.id === 'T-200')
      assert.ok(t200, 'T-200 在看板卡片中')
      assert.equal(t200.status, 'in_review')
    })

    it('GET /api/activity：JSONL 尾部（limit 生效）', async () => {
      const r = await getJson(board.base, boardPath + '/api/activity')
      assert.equal(r.status, 200)
      assert.equal(r.data.length, 3)
      const tail = await getJson(board.base, boardPath + '/api/activity?limit=1')
      assert.equal(tail.data.length, 1)
      assert.equal(tail.data[0].id, 'act-3')
    })
  })

  describe('/api/artifact 逐条内容服务（与 scrum/artifact-detail.test.mjs 同语义）', () => {
    async function art(qs) {
      const res = await fetch(board.base + boardPath + '/api/artifact?' + qs)
      let body = null
      try { body = await res.json() } catch { /* raw/302 */ }
      return { status: res.status, ct: res.headers.get('content-type'), body }
    }

    it('缺少 task 参数 → 400', async () => {
      const r = await art('')
      assert.equal(r.status, 400)
      assert.match(r.body.error, /缺少参数 task/)
    })

    it('i=0 元信息 + raw：分支态（worktree）优先，text/markdown', async () => {
      const meta = await art('task=T-200&i=0')
      assert.equal(meta.status, 200)
      assert.equal(meta.body.i, 0)
      assert.equal(meta.body.kind, 'file')
      assert.equal(meta.body.total, 4)
      assert.equal(meta.body.exists, true)
      const raw = await fetch(board.base + boardPath + '/api/artifact?task=T-200&i=0&raw=1')
      assert.equal(raw.status, 200)
      assert.match(raw.headers.get('content-type') ?? '', /^text\/markdown/)
      assert.ok((await raw.text()).includes('BRANCH 分支态 v2'))
    })

    it('主仓兜底：无分支态文件时读主仓库根全文', async () => {
      const raw = await fetch(board.base + boardPath + '/api/artifact?task=T-MAIN&i=0&raw=1')
      assert.equal(raw.status, 200)
      assert.equal(await raw.text(), 'MAIN-ONLY\n')
    })

    it('两条 html 逐条独立可预览（i=1、i=3，text/html）', async () => {
      for (const [i, needle] of [[1, 'AA'], [3, 'BB']]) {
        const raw = await fetch(board.base + boardPath + `/api/artifact?task=T-200&i=${i}&raw=1`)
        assert.equal(raw.status, 200)
        assert.match(raw.headers.get('content-type') ?? '', /^text\/html/)
        assert.ok((await raw.text()).includes(`<p>${needle}</p>`))
      }
    })

    it('i 缺省取最新一条（idx=total-1）', async () => {
      const meta = await art('task=T-200')
      assert.equal(meta.status, 200)
      assert.equal(meta.body.i, 3)
      assert.equal(meta.body.kind, 'html')
    })

    it('url 产物：raw 缺省返回 {url:true}，raw=1 → 302 跳外链', async () => {
      const meta = await art('task=T-200&i=2')
      assert.equal(meta.status, 200)
      assert.equal(meta.body.url, true)
      assert.equal(meta.body.path, 'https://example.test/x')
      const res = await fetch(board.base + boardPath + '/api/artifact?task=T-200&i=2&raw=1', { redirect: 'manual' })
      assert.equal(res.status, 302)
      assert.equal(res.headers.get('location'), 'https://example.test/x')
    })

    it('越界/非法 i → 400 可区分；未知任务/无产物 → 404', async () => {
      assert.match((await art('task=T-200&i=9')).body.error, /越界/)
      assert.match((await art('task=T-200&i=abc')).body.error, /非法/)
      assert.equal((await art('task=T-UNKNOWN&i=0')).status, 404)
      assert.equal((await art('task=T-EMPTY&i=0')).status, 404)
    })

    it('白名单安全：../、根外盘符、.git 段 → 403 可区分', async () => {
      for (const taskId of ['T-EVIL', 'T-EVILABS', 'T-GIT']) {
        const r = await art(`task=${taskId}&i=0&raw=1`)
        assert.equal(r.status, 403, taskId)
        assert.match(r.body.error, /不在允许根内/)
      }
    })

    it('符号链接逃逸（link-out → 根外）拒绝 403；根内（link-in）放行', async (t) => {
      // describe 体在模块加载期执行（fx 尚为 undefined），必须在用例体内运行时判定
      if (!fx?.linksOk) return t.skip('junction 不可用')
      const out = await art('task=T-LINKOUT&i=0&raw=1')
      assert.equal(out.status, 403)
      assert.match(out.body.error, /不在允许根内/)
      const meta = await art('task=T-LINKOUT&i=0')
      assert.equal(meta.status, 403, '元信息面同样拒绝逃逸路径')
      const inRes = await fetch(board.base + boardPath + '/api/artifact?task=T-LINKIN&i=0&raw=1')
      assert.equal(inRes.status, 200)
      assert.equal(await inRes.text(), 'INSIDE-OK\n')
    })

    it('文件不存在（主仓与分支态均无）→ raw 404 明确文案', async () => {
      const r = await art('task=T-MISSING&i=0&raw=1')
      assert.equal(r.status, 404)
      assert.match(r.body.error, /产物文件不存在/)
      const meta = await art('task=T-MISSING&i=0')
      assert.equal(meta.status, 200)
      assert.equal(meta.body.exists, false)
    })

    it('非 html/md/txt 产物 raw → application/octet-stream', async () => {
      const bin = join(fx.base, 'out', 'blob.bin')
      writeFileSync(bin, Buffer.from([0x00, 0x01, 0x02]))
      const db = JSON.parse(readFileSync(join(fx.scrumDir, 'tasks.json'), 'utf8'))
      db.tasks['T-BIN'] = task('T-BIN', [{ by: 'soldier-auto', at: T0, kind: 'file', path: 'out/blob.bin', title: '二进制' }])
      writeFileSync(join(fx.scrumDir, 'tasks.json'), JSON.stringify(db, null, 2), 'utf8')
      const res = await fetch(board.base + boardPath + '/api/artifact?task=T-BIN&i=0&raw=1')
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') ?? '', /application\/octet-stream/)
      assert.equal((await res.arrayBuffer()).byteLength, 3)
    })
  })

  describe('本地写接口（fixture taskctl 替身）', () => {
    it('缺参 400：create 缺 title、transition 缺 id/to、comment 缺 text、reject 缺 reason、promote 缺 by', async () => {
      const cases = [
        [postJson(board.base, boardPath + '/api/create', { description: 'x' }), /缺少参数 title/],
        [postJson(board.base, boardPath + '/api/transition', { to: 'done' }), /缺少参数 id/],
        [postJson(board.base, boardPath + '/api/transition', { id: 'T-200' }), /缺少参数 to/],
        [postJson(board.base, boardPath + '/api/comment', { id: 'T-200', by: 'x' }), /缺少参数 text/],
        [postJson(board.base, boardPath + '/api/reject', { id: 'T-200', by: 'x' }), /缺少参数 reason/],
        [postJson(board.base, boardPath + '/api/promote', { id: 'T-200' }), /缺少参数 by/],
      ]
      for (const [p, re] of cases) {
        const r = await p
        assert.equal(r.status, 400)
        assert.match(r.data.error, re)
      }
    })

    it('create 成功 → 200 {ok, task}；看板随后含新任务', async () => {
      const r = await postJson(board.base, boardPath + '/api/create', {
        title: '  新契约任务  ', description: 'd', priority: 'high', acceptance: ['a1', 'a2'],
      })
      assert.equal(r.status, 200)
      assert.equal(r.data.ok, true)
      assert.equal(r.data.task.id, 'T-100')
      assert.equal(r.data.task.title, '新契约任务') // taskctl 替身不 trim；plugin 传 trim 后标题
      assert.equal(r.data.task.status, 'todo')
      assert.equal(r.data.task.version, 1)
      const boardRes = await getJson(board.base, boardPath + '/api/board')
      const cards = boardRes.data.columns.flatMap((c) => c.cards)
      assert.ok(cards.some((c) => c.id === 'T-100'), 'render 后看板含新任务 T-100')
    })

    it('transition：成功 + ifVersion 乐观锁冲突 → 409', async () => {
      const ok1 = await postJson(board.base, boardPath + '/api/transition', { id: 'T-100', to: 'in_review', by: 'soldier-auto' })
      assert.equal(ok1.status, 200)
      assert.equal(ok1.data.task.status, 'in_review')
      assert.equal(ok1.data.task.version, 2)
      const conflict = await postJson(board.base, boardPath + '/api/transition', { id: 'T-100', to: 'blocked', ifVersion: 1 })
      assert.equal(conflict.status, 409)
      assert.match(conflict.data.error, /乐观锁/)
      const ok2 = await postJson(board.base, boardPath + '/api/transition', { id: 'T-100', to: 'blocked', ifVersion: 2 })
      assert.equal(ok2.status, 200)
      assert.equal(ok2.data.task.status, 'blocked')
    })

    it('未知任务 → 400（taskctl 错误透传）', async () => {
      const r = await postJson(board.base, boardPath + '/api/transition', { id: 'T-NOPE', to: 'done', by: 'x' })
      assert.equal(r.status, 400)
      assert.match(r.data.error, /任务不存在：T-NOPE/)
    })

    it('comment / reject / promote 成功路径', async () => {
      const c = await postJson(board.base, boardPath + '/api/comment', { id: 'T-100', by: '将军', text: '  同意  ' })
      assert.equal(c.status, 200)
      assert.equal(c.data.task.comments.length, 1)
      assert.equal(c.data.task.comments[0].by, '将军')
      const rj = await postJson(board.base, boardPath + '/api/reject', { id: 'T-100', by: '将军', reason: '证据不足' })
      assert.equal(rj.status, 200)
      assert.equal(rj.data.task.status, 'rejected')
      const pm = await postJson(board.base, boardPath + '/api/promote', { id: 'T-100', by: '将军' })
      assert.equal(pm.status, 200)
      assert.equal(pm.data.task.status, 'promoted')
    })
  })

  describe('SSE 实时通道（初始数据 + 增量广播）', () => {
    it('/api/board/events：retry + 初始 board 帧 + 写操作后增量帧', async () => {
      const sse = sseClient(board.base, boardPath + '/api/board/events')
      try {
        await sse.waitFor('retry: 2000')
        await sse.waitFor('T-200')
        const title = 'SSE-脉冲-' + Date.now()
        const r = await postJson(board.base, boardPath + '/api/create', { title })
        assert.equal(r.status, 200)
        await sse.waitFor(title, 10000)
      } finally {
        sse.close()
      }
    })

    it('/api/activity/events：初始历史 + 新行增量推送', async () => {
      const sse = sseClient(board.base, boardPath + '/api/activity/events')
      try {
        await sse.waitFor('act-3')
        const line = JSON.stringify({ id: 'act-9', event: 'live', task: 'T-100', ts: new Date().toISOString() })
        appendFileSync(join(fx.scrumDir, 'activity.jsonl'), line + '\n', 'utf8')
        await sse.waitFor('act-9', 12000) // watchFile 轮询 1s
      } finally {
        sse.close()
      }
    })
  })
})

// ===================================================================
// Hub 模式（fake team-hub 服务器）：scope / token / 错误映射
// ===================================================================
describe('board-plugin HTTP 契约：hub 模式（fake team-hub）', () => {
  let hub
  let hubLog
  let hubState
  let board

  before(async () => {
    // fake team-hub：记录全部请求，行为可按用例调整
    hubLog = []
    hubState = {
      board: { status: 200, body: { from: 'hub', tasks: [{ id: 'H-0', title: 'hub-task', status: 'todo' }] } },
      write: { status: 200, body: { task: { id: 'H-9', title: 'hub-created', status: 'todo', version: 1 } }, raw: false },
    }
    hub = createServer((req, res) => {
      let raw = ''
      req.on('data', (d) => { raw += d })
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://hub.test')
        const entry = { method: req.method, path: url.pathname, search: url.search, auth: req.headers.authorization ?? null }
        if (raw) {
          try { entry.body = JSON.parse(raw) } catch { entry.body = raw }
        }
        hubLog.push(entry)
        const send = (status, payload, isRaw) => {
          res.writeHead(status, { 'content-type': isRaw ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8' })
          res.end(isRaw ? payload : JSON.stringify(payload))
        }
        if (req.method === 'POST') {
          const w = hubState.write
          return send(w.status, w.raw ? w.raw : w.body, !!w.raw)
        }
        if (url.pathname === '/api/board') {
          const b = hubState.board
          return send(b.status, b.body)
        }
        return send(200, { auth: true })
      })
    })
    await listen(hub)
    const hubPort = hub.address().port
    const fx = buildFixture()
    board = await startBoardPlugin({
      scrumDir: fx.scrumDir,
      hubUrl: `http://127.0.0.1:${hubPort}`,
      scope: 'software',
      hubToken: 'tk-hub-1',
    })
    board.cleanupFx = fx.cleanup
  })

  after(async () => {
    await board.stop()
    await closeServer(hub)
    board.cleanupFx()
  })

  function lastHub() {
    return hubLog[hubLog.length - 1]
  }

  it('GET /api/board：走 hub 读取并带 scope + Bearer token', async () => {
    const r = await getJson(board.base, '/scrum-board/api/board')
    assert.equal(r.status, 200)
    assert.equal(r.data.from, 'hub')
    const e = lastHub()
    assert.equal(e.path, '/api/board')
    assert.match(e.search, /scope=software/)
    assert.equal(e.auth, 'Bearer tk-hub-1')
  })

  it('hub 读失败（500）→ /api/board 500 明确文案', async () => {
    hubState.board = { status: 500, body: { error: 'hub board down' } }
    const r = await getJson(board.base, '/scrum-board/api/board')
    assert.equal(r.status, 500)
    assert.match(r.data.error, /hub board 失败（500）/)
    hubState.board = { status: 200, body: { from: 'hub' } }
  })

  it('POST /api/create：转发到 hub 并带 scope/token，响应透传', async () => {
    hubState.write = { status: 200, body: { task: { id: 'H-9', title: 'hub-created', status: 'todo', version: 1 } } }
    const r = await postJson(board.base, '/scrum-board/api/create', { title: '  hub 任务  ', description: 'd', priority: 'high' })
    assert.equal(r.status, 200)
    assert.equal(r.data.ok, true)
    assert.equal(r.data.task.id, 'H-9')
    const e = lastHub()
    assert.equal(e.path, '/api/create')
    assert.equal(e.auth, 'Bearer tk-hub-1')
    assert.equal(e.body.title, 'hub 任务')
    assert.equal(e.body.scope, 'software')
    assert.equal(e.body.by, 'general')
    assert.equal(e.body.description, 'd')
  })

  it('POST /api/transition：ifVersion/force/scope 全量透传', async () => {
    const r = await postJson(board.base, '/scrum-board/api/transition', { id: 'H-9', to: 'in_review', by: '将军', ifVersion: 3, force: true })
    assert.equal(r.status, 200)
    const e = lastHub()
    assert.equal(e.path, '/api/transition')
    assert.equal(e.body.id, 'H-9')
    assert.equal(e.body.to, 'in_review')
    assert.equal(e.body.by, '将军')
    assert.equal(e.body.ifVersion, 3)
    assert.equal(e.body.force, true)
    assert.equal(e.body.scope, 'software')
  })

  it('hub 写错误映射：乐观锁 → 409，业务错 → 400', async () => {
    hubState.write = { status: 409, body: { error: '乐观锁冲突：版本 2 != 3' } }
    const conf = await postJson(board.base, '/scrum-board/api/transition', { id: 'H-9', to: 'blocked', ifVersion: 2 })
    assert.equal(conf.status, 409)
    assert.match(conf.data.error, /乐观锁冲突/)
    hubState.write = { status: 400, body: { error: '非法状态转移' } }
    const biz = await postJson(board.base, '/scrum-board/api/transition', { id: 'H-9', to: 'nope' })
    assert.equal(biz.status, 400)
    assert.match(biz.data.error, /非法状态转移/)
  })

  it('hub 写失败非 JSON（500）→ 400 明确文案', async () => {
    hubState.write = { status: 500, raw: 'boom', body: null }
    const r = await postJson(board.base, '/scrum-board/api/transition', { id: 'H-9', to: 'done' })
    assert.equal(r.status, 400)
    assert.match(r.data.error, /hub \/api\/transition 失败（500）/)
  })
})
