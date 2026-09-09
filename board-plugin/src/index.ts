/**
 * @dsh-external/dsh-scrum-board — 军团 Scrum 看板 UI 面板（ui-panel 形态）。
 *
 * host 侧：在 DSH webServer 上自托管看板（serve kanban.html + /api/* + SSE），
 * 数据直接读 tasks.json / 调 taskctl.mjs / render.mjs，不依赖外部 serve.mjs。
 * client 侧（src/client）：conversation.view 槽位挂 iframe 面板，指向本路由。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { spawn } from 'node:child_process'
import { existsSync, readFile, watch, watchFile, unwatchFile } from 'node:fs'
import { readFile as readFileP, realpath as realpathP } from 'node:fs/promises'
import { basename, extname, join, normalize, sep } from 'node:path'
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http'
import { get as httpGet } from 'node:http'
import { normalizeArtifactPath } from '../../packages/shared/src/artifact-policy.mjs'
import { HUB_BOARD_HTML, HUB_CONSOLE_HTML } from './hub-panels.js'

export const name = '@dsh-external/dsh-scrum-board'
export const inject = ['webServer']

export interface Config {
  /** legion/scrum 目录（taskctl.mjs / render.mjs / kanban.html 所在）。 */
  scrumDir: string
  /** webServer 路由前缀（看板挂在此前缀下）。 */
  routePrefix: string
  /** team-hub 地址；非空则写/读走 hub（带 scope）。 */
  hubUrl: string
  /** hub 模式下的项目 scope（读过滤 + 写带上）。 */
  scope: string
  /** team-hub 写令牌；未显式配置时继承 TEAM_HUB_TOKEN。 */
  hubToken: string
  /** 产物预览额外允许根（默认仅 repoRoot；非隔离 worker 产物在 workspace 时把 workspace 加进来）。 */
  artifactRoots: string[]
  /** 未显式配置 hubUrl 时是否探测同宿主 /team-hub 并切换 hub 模式（P1-3 隔离 fixture 置 false）。 */
  hubProbe: boolean
}

export const Config = z.object({
  scrumDir: z.string().default('D:/project/dsh/legion/scrum'),
  routePrefix: z.string().default('/scrum-board'),
  hubUrl: z.string().default(''),
  scope: z.string().default('software'),
  hubToken: z.string().default(''),
  artifactRoots: z.array(z.string()).default([]),
  hubProbe: z.boolean().default(true),
})

export function apply(ctx: Context, config: Config): void {
  const scrumDir = config.scrumDir
  const prefix = config.routePrefix.replace(/\/+$/, '') || '/'
  const repoRoot = join(scrumDir, '..')
  const boardFile = join(scrumDir, 'board.json')
  const activityFile = join(scrumDir, 'activity.jsonl')
  const kanbanFile = join(scrumDir, 'kanban.html')
  const consoleFile = join(scrumDir, 'console.html')
  const tasksFile = join(scrumDir, 'tasks.json')
  const patchesDir = join(scrumDir, 'patches')
  const taskctl = join(scrumDir, 'taskctl.mjs')
  const render = join(scrumDir, 'render.mjs')

  let hubUrl = config.hubUrl.replace(/\/+$/, '')
  let useHub = hubUrl !== ''
  const hubToken = config.hubToken || process.env.TEAM_HUB_TOKEN || ''
  const hubHeaders = (): Record<string, string> => hubToken ? { authorization: `Bearer ${hubToken}` } : {}

  /** 读 JSON 文件，不存在/损坏返回 null（daemon.json、roles.json 均为可缺失的旁路信息）。 */
  async function readJson(file: string): Promise<unknown> {
    try {
      return JSON.parse(await readFileP(file, 'utf8'))
    } catch {
      return null
    }
  }

  /** 产物预览白名单：仅允许 repoRoot 与配置的额外根（防任意文件读取）。 */
  function artifactAllowed(p: string): boolean {
    const norm = normalize(p)
    const roots = [repoRoot, ...config.artifactRoots].map(r => normalize(r))
    return roots.some(r => norm === r || norm.startsWith(r + sep))
  }

  /**
   * 产物逐条内容服务（R-4 S2 / K4-B，对齐 serve.mjs 语义）：
   * GET /api/artifact?task=T-00X[&i=N] → JSON 元信息（i 缺省 = 最新一条，兼容既有行为）；
   *   &raw=1 → 文件内容：html→text/html（逐条 iframe）、md/txt→text/markdown|text/plain、其余 octet-stream；url→302 跳外链。
   * path 一律取自 tasks.json 的 artifact 记录（不经用户查询串）；相对路径按 repoRoot/artifactRoots 白名单解析，
   * 任一段 .. / .git（不区分大小写）拒绝；未 promote 分支态优先读 repoRoot/.legion-worktrees/<taskId>/<rel>，主仓库根兜底（K5-A）。
   */
  async function serveArtifact(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '', 'http://localhost')
      const taskId = url.searchParams.get('task') ?? ''
      const raw = url.searchParams.get('raw') === '1'
      const iRaw = url.searchParams.get('i')
      if (!taskId) { json(res, 400, { error: '缺少参数 task' }); return }
      const db = (await readJson(tasksFile)) as { tasks?: Record<string, { artifacts?: { by?: string; at?: string; kind: string; title?: string; path: string }[] }> } | null
      const t = db?.tasks?.[taskId]
      if (!t) { json(res, 404, { error: `任务不存在：${taskId}` }); return }
      const arts = t.artifacts ?? []
      if (arts.length === 0) { json(res, 404, { error: `任务 ${taskId} 无产物` }); return }
      let a: { by?: string; at?: string; kind: string; title?: string; path: string }
      let idx: number
      if (iRaw === null || iRaw === '') { idx = arts.length - 1; a = arts[idx] }
      else {
        if (!/^\d+$/.test(iRaw)) { json(res, 400, { error: '条目序号非法（应为非负整数）' }); return }
        idx = Number(iRaw)
        if (idx >= arts.length) { json(res, 400, { error: `条目序号越界：任务 ${taskId} 共 ${arts.length} 条产物（i=${idx}）` }); return }
        a = arts[idx]
      }
      const meta = { taskId, i: idx, kind: a.kind, title: a.title ?? '', path: a.path, at: a.at ?? null, by: a.by ?? null, total: arts.length }
      if (a.kind === 'url') {
        if (!raw) { json(res, 200, { ...meta, url: true }); return }
        res.writeHead(302, { location: a.path }); res.end(); return
      }
      const abs = await resolveArtifactFile(taskId, a.path)
      if (abs === null) { json(res, 403, { error: '产物路径不在允许根内' }); return }
      if (!raw) {
        const ok = await readFileP(abs).then(() => true).catch(() => false)
        json(res, 200, { ...meta, exists: ok })
        return
      }
      let data: Buffer
      try {
        data = await readFileP(abs)
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') { json(res, 404, { error: '产物文件不存在' }); return }
        throw e
      }
      const ext = extname(abs).toLowerCase()
      const ct = ext === '.html' ? 'text/html; charset=utf-8'
        : ext === '.md' || ext === '.markdown' ? 'text/markdown; charset=utf-8'
        : ext === '.txt' ? 'text/plain; charset=utf-8'
        : 'application/octet-stream'
      res.writeHead(200, { 'content-type': ct })
      res.end(data)
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) })
    }
  }

  /** 白名单文件解析：绝对路径须落在某允许根内；相对路径拒绝 ../ 与 .git 段后，
   *  分支态（repoRoot/.legion-worktrees/<taskId>/<rel>）优先、主根（repoRoot/artifactRoots 逐个）兜底。
   *  返回命中的绝对路径；白名单外返回 null。
   */
  async function resolveArtifactFile(taskId: string, p: string): Promise<string | null> {
    const raw = String(p ?? '').trim()
    if (raw.length === 0) return null
    const winAbs = /^[A-Za-z]:[\\/]/.test(raw)
    const posixAbs = raw.startsWith('/') || raw.startsWith('\\\\')
    const roots = [repoRoot, ...config.artifactRoots]
    const lexical = normalizeArtifactPath(raw, roots)
    if (!lexical) return null
    if (lexical.absolute) {
      const n = lexical.path
      if (!existsSync(n)) return n
      try {
        const real = await realpathP(n)
        const rootsReal = await Promise.all(roots.map(async root => { try { return await realpathP(root) } catch { return normalize(root) } }))
        return rootsReal.some(root => real === root || real.startsWith(root + sep)) ? real : null
      } catch { return null }
    }
    const segs = lexical.segments
    if (!segs) return null
    const rootsReal = await Promise.all(roots.map(async root => {
      try { return await realpathP(root) } catch { return normalize(root) }
    }))
    const safeExisting = async (candidate: string): Promise<string | null> => {
      if (!existsSync(candidate)) return null
      try {
        const real = await realpathP(candidate)
        return rootsReal.some(root => real === root || real.startsWith(root + sep)) ? real : null
      } catch { return null }
    }
    const branch = join(repoRoot, '.legion-worktrees', taskId, ...segs)
    if (artifactAllowed(branch)) {
      const safeBranch = await safeExisting(branch)
      if (safeBranch) return safeBranch
    }
    let unsafeHit = false
    for (const root of roots) {
      const abs = join(root, ...segs)
      const safe = await safeExisting(abs)
      if (safe) return safe
      // 候选路径存在但 realpath 复检未通过（仓库内符号链接/junction 指向根外，如 workbench/node_modules）：
      // 绝不回退到该可穿透路径；全部候选均不安全时整体拒绝（403），只允许「文件暂不存在」走主根兜底。
      if (existsSync(abs)) unsafeHit = true
    }
    return unsafeHit ? null : join(repoRoot, ...segs) // 文件暂不存在也返回主根候选，供调用方做 exists 元信息
  }


  /** 探测默认 hub（未显式配置 hubUrl 时）：同宿主 webServer 的 /team-hub
   * （P1-3 真实宿主注入修正：原硬编码 3080 会把 board 指到其他宿主/生产实例，
   *  board 与 team-hub 同宿主挂载时探测 ctx.webServer.port 的 /team-hub 才正确）。 */
  async function detectHub(): Promise<void> {
    if (useHub || !config.hubProbe) return
    try {
      const origin = `http://127.0.0.1:${ctx.webServer.port}`
      const hub = `${origin}/team-hub`
      const res = await fetch(`${hub}/api/config`, { headers: hubHeaders(), signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        hubUrl = hub
        useHub = true
        // P1-1 第 2 步：探测成功后建立上游 /api/events 订阅（事件桥）
        if (hubEventsAlive) connectHubEvents()
      }
    } catch { /* 探测失败保持本地模式 */ }
  }

  /** hub 写调用（POST）。 */
  async function hubPost(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${hubUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...hubHeaders() },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok) throw new Error(String(data.error ?? `hub ${path} 失败（${res.status}）`))
    return data.task ?? data
  }

  /** hub 读任务列表（按 scope 过滤）。 */
  async function hubBoard(): Promise<unknown> {
    const res = await fetch(`${hubUrl}/api/board?scope=${encodeURIComponent(config.scope)}`, { headers: hubHeaders() })
    if (!res.ok) throw new Error(`hub board 失败（${res.status}）`)
    return res.json()
  }

  /** hub 通用 GET（v2 audit / activity 面）。 */
  async function hubGet(path: string): Promise<unknown> {
    const res = await fetch(`${hubUrl}${path}`, { headers: hubHeaders() })
    if (!res.ok) throw new Error(`hub ${path} 失败（${res.status}）`)
    return res.json()
  }

  /** 以子进程执行 taskctl（Electron 下 process.execPath 非 node，加 ELECTRON_RUN_AS_NODE）。 */
  function runTaskctl(argv: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [taskctl, ...argv], {
        cwd: repoRoot,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
      let out = ''
      let err = ''
      proc.stdout.on('data', (d) => { out += d })
      proc.stderr.on('data', (d) => { err += d })
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code === 0) {
          try {
            resolve(JSON.parse(out))
          } catch {
            reject(new Error(`taskctl 输出不是 JSON：${out.slice(0, 200)}`))
          }
        } else {
          reject(new Error(err.trim() || `taskctl 退出码 ${code}`))
        }
      })
    })
  }

  /** 重跑 render.mjs 刷新 board.json / KANBAN.md / kanban.html。 */
  function runRender(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [render], {
        cwd: repoRoot,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
      let err = ''
      proc.stderr.on('data', (d) => { err += d })
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(err.trim() || `render.mjs 退出码 ${code}`))
      })
    })
  }

  function json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data, null, 2))
  }

  function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let raw = ''
      req.on('data', (d) => { raw += d })
      req.on('end', () => {
        try {
          resolve(raw.length === 0 ? {} : JSON.parse(raw))
        } catch {
          reject(new Error('请求体不是合法 JSON'))
        }
      })
      req.on('error', reject)
    })
  }

  // ── SSE 客户端与广播 ──
  const boardClients = new Set<ServerResponse>()
  const activityClients = new Set<ServerResponse>()
  let activityOffset = 0

  function ssePayload(data: string): string {
    return `${data.split('\n').map((line) => `data: ${line}`).join('\n')}\n\n`
  }

  function sendBoard(res: ServerResponse): void {
    readFile(boardFile, (err, data) => {
      if (!err) res.write(ssePayload(data.toString('utf8')))
    })
  }

  let broadcastTimer: NodeJS.Timeout | undefined
  function broadcast(): void {
    clearTimeout(broadcastTimer)
    broadcastTimer = setTimeout(() => {
      readFile(boardFile, (err, data) => {
        if (err) return
        const payload = ssePayload(data.toString('utf8'))
        for (const res of boardClients) res.write(payload)
      })
    }, 100)
  }

  function sendActivityLines(res: ServerResponse, lines: string[]): void {
    for (const line of lines) res.write(`data: ${line}\n\n`)
  }

  function broadcastActivity(): void {
    readFile(activityFile, (err, buf) => {
      if (err) return
      const text = buf.toString('utf8')
      const delta = text.slice(activityOffset)
      const lastNewline = delta.lastIndexOf('\n')
      if (lastNewline === -1) return
      const complete = delta.slice(0, lastNewline + 1)
      activityOffset += complete.length
      const lines = complete.split('\n').filter((l) => l.length > 0)
      for (const res of activityClients) sendActivityLines(res, lines)
    })
  }

  function onActivity(): void {
    broadcastActivity()
  }

  // ── P1-1 第 2 步：hub 模式事件桥（R9 缺口收口）──
  // 本地模式：board.json watch → 全量帧；activity.jsonl watch → 增量行。
  // hub 模式：订阅上游 v2 /api/events（audit 信封）→
  //   ① board/events 客户端：防抖重拉 hub /api/board 推全量帧；
  //   ② activity/events 客户端：把 v2 信封 data 行透传。
  const hubBoardClients = new Set<ServerResponse>()
  const hubActivityClients = new Set<ServerResponse>()
  let hubPumpTimer: NodeJS.Timeout | undefined
  let hubUpstream: { req: ClientRequest; close: () => void } | null = null
  let hubEventsAlive = true // hub events effect 的 dispose 守卫（detectHub 晚到时不重建上游）

  function sseHeaders(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
  }

  async function pumpHubBoard(): Promise<void> {
    try {
      const data = await hubBoard()
      const payload = ssePayload(JSON.stringify(data))
      for (const res of hubBoardClients) res.write(payload)
    } catch { /* 上游暂不可达，保持连接，下个事件再试 */ }
  }

  function scheduleHubPump(): void {
    clearTimeout(hubPumpTimer)
    hubPumpTimer = setTimeout(() => { void pumpHubBoard() }, 200)
  }

  function connectHubEvents(): void {
    if (!useHub || !hubEventsAlive || hubUpstream) return
    // v2 /api/events：id 行 + data 信封；只有 data: JSON 需要透传
    const req = httpGet(`${hubUrl}/api/events`, hubHeaders(), (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        scheduleHubRetry()
        return
      }
      let buf = ''
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '') continue
          for (const ac of hubActivityClients) ac.write(`data: ${data}\n\n`)
          scheduleHubPump()
        }
      })
      res.on('end', () => scheduleHubRetry())
      res.on('error', () => scheduleHubRetry())
    })
    req.on('error', () => scheduleHubRetry())
    hubUpstream = {
      req,
      close: () => { try { req.destroy() } catch { /* ignore */ } },
    }
  }

  let hubRetryTimer: NodeJS.Timeout | undefined
  function scheduleHubRetry(): void {
    if (!hubEventsAlive) return
    if (hubUpstream) {
      try { hubUpstream.close() } catch { /* ignore */ }
      hubUpstream = null
    }
    clearTimeout(hubRetryTimer)
    hubRetryTimer = setTimeout(() => connectHubEvents(), 3000)
  }

  // tasks.json 变更 → 防抖重渲染（守护经 taskctl 直接改库，不经过写接口，需主动刷新看板）
  let renderTimer: NodeJS.Timeout | undefined
  function onTasksChange(): void {
    clearTimeout(renderTimer)
    renderTimer = setTimeout(() => {
      runRender().catch(() => {})
    }, 300)
  }

  // ── 写接口 ──
  async function handleWrite(
    req: IncomingMessage,
    res: ServerResponse,
    run: (body: Record<string, unknown>) => Promise<unknown>,
  ): Promise<void> {
    try {
      const body = await readBody(req)
      const task = await run(body)
      if (!useHub) await runRender() // 本地模式：taskctl 改文件库 → 重渲染 board.json
      json(res, 200, { ok: true, task })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // P1-1 第 2 步：hub 模式 v1 独有动作（reject/promote）降级 501 带指引
      const status = (e as { status?: number }).status
        ?? (message.includes('乐观锁') ? 409 : message.includes('不支持') ? 501 : 400)
      json(res, status, { error: message })
    }
  }

  /** 读 board.json；hub 模式下从 hub 读（带 scope 过滤），否则本地读。 */
  function serveBoard(res: ServerResponse): void {
    if (useHub) {
      hubBoard()
        .then((data) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(data))
        })
        .catch((e) => json(res, 500, { error: e instanceof Error ? e.message : String(e) }))
      return
    }
    readFile(boardFile, (err, data) => {
      if (!err) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(data)
        return
      }
      runRender()
        .then(() => {
          readFile(boardFile, (err2, data2) => {
            if (err2) {
              json(res, 500, { error: 'board.json 生成失败' })
              return
            }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(data2)
          })
        })
        .catch(() => json(res, 500, { error: 'render.mjs 执行失败' }))
    })
  }

  /** 服务 kanban.html，并把前端绝对路径 /api/* 重写为前缀下。
   *  hub 模式（P1-1 第 2 步）：render 静态产物是 v1 columns 语义，与 v2 裸任务数组
   *  不兼容 → 返回内联动态面板（拉 /api/board 自渲染 + SSE 刷新 + v2 动作）。 */
  function serveKanban(res: ServerResponse): void {
    if (useHub) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(HUB_BOARD_HTML)
      return
    }
    readFile(kanbanFile, (err, data) => {
      if (err) {
        json(res, 404, { error: 'kanban.html 不存在，先运行 render.mjs' })
        return
      }
      const html = data.toString('utf8').replaceAll("'/api/", `'${prefix}/api/`)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    })
  }

  /** 服务军团总指挥部 console.html（同样的 /api/* 前缀重写）；hub 模式给 v2 动态页。 */
  function serveConsole(res: ServerResponse): void {
    if (useHub) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(HUB_CONSOLE_HTML)
      return
    }
    readFile(consoleFile, (err, data) => {
      if (err) {
        json(res, 404, { error: 'console.html 不存在（scrum/console.html）' })
        return
      }
      const html = data.toString('utf8').replaceAll("'/api/", `'${prefix}/api/`)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    })
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      let path = url.pathname
      if (path === prefix) path = '/'
      else if (path.startsWith(`${prefix}/`)) path = path.slice(prefix.length)

      res.setHeader('access-control-allow-origin', '*')
      res.setHeader('cross-origin-resource-policy', 'cross-origin')
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization, x-dsh-token',
          'access-control-max-age': '600',
        })
        res.end()
        return
      }

      if (req.method === 'POST' && path === '/api/transition') {
        await handleWrite(req, res, (body) => {
          const id = body.id
          const to = body.to
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          if (typeof to !== 'string' || to.length === 0) throw new Error('缺少参数 to')
          const by = typeof body.by === 'string' && body.by.length > 0 ? body.by : 'general'
          if (useHub) {
            return hubPost('/api/transition', { id, to, by, ifVersion: body.ifVersion, force: body.force === true, scope: config.scope })
          }
          const argv = ['transition', id, '--to', to, '--by', by]
          if (typeof body.ifVersion === 'number') argv.push('--if-version', String(body.ifVersion))
          if (body.force === true) argv.push('--force')
          return runTaskctl(argv)
        })
        return
      }

      if (req.method === 'POST' && path === '/api/create') {
        await handleWrite(req, res, (body) => {
          const title = body.title
          if (typeof title !== 'string' || title.trim().length === 0) throw new Error('缺少参数 title')
          if (useHub) {
            return hubPost('/api/create', { title: title.trim(), description: body.description, priority: body.priority, by: 'general', scope: config.scope })
          }
          const argv = ['create', '--title', title.trim()]
          if (typeof body.description === 'string' && body.description.length > 0) argv.push('--description', body.description)
          if (Array.isArray(body.acceptance) && body.acceptance.length > 0) {
            argv.push('--acceptance', body.acceptance.map((s) => String(s).trim()).filter(Boolean).join(';'))
          }
          if (typeof body.priority === 'string' && body.priority.length > 0) argv.push('--priority', body.priority)
          return runTaskctl(argv)
        })
        return
      }

      if (req.method === 'POST' && path === '/api/comment') {
        await handleWrite(req, res, (body) => {
          const id = body.id
          const by = body.by
          const text = body.text
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          if (typeof by !== 'string' || by.length === 0) throw new Error('缺少参数 by')
          if (typeof text !== 'string' || text.trim().length === 0) throw new Error('缺少参数 text')
          if (useHub) {
            return hubPost('/api/comment', { id, by, text: text.trim(), scope: config.scope })
          }
          return runTaskctl(['comment', id, '--by', by, '--text', text.trim()])
        })
        return
      }

      if (req.method === 'POST' && path === '/api/reject') {
        await handleWrite(req, res, (body) => {
          const id = body.id
          const by = body.by
          const reason = body.reason
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          if (typeof by !== 'string' || by.length === 0) throw new Error('缺少参数 by')
          if (typeof reason !== 'string' || reason.trim().length === 0) throw new Error('缺少参数 reason')
          if (useHub) {
            // P1-1 第 2 步（D3）：reject 的 v1 worktree 回滚语义在 v2 不存在（v2 无 w/<id> 分支纪律），
            // 将军打回请用 transition + comment；这里显式降级，避免把 body 打到 /api/reject 拿 404。
            const err = new Error('v2 hub 不支持 reject（v1 worktree 打回已退役）：请用 transition 迁移 + comment 说明原因') as Error & { status?: number }
            err.status = 501
            throw err
          }
          const argv = ['reject', id, '--by', by, '--reason', reason.trim()]
          if (typeof body.ifVersion === 'number') argv.push('--if-version', String(body.ifVersion))
          return runTaskctl(argv)
        })
        return
      }

      if (req.method === 'POST' && path === '/api/promote') {
        await handleWrite(req, res, (body) => {
          const id = body.id
          const by = body.by
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          if (typeof by !== 'string' || by.length === 0) throw new Error('缺少参数 by')
          if (useHub) {
            // P1-1 第 2 步（D3）：promote（v1 将军合入 worktree 分支）在 v2 无对应端点；
            // v2 的隔离分支合入由 worker/守护完成。显式 501 带指引。
            const err = new Error('v2 hub 不支持 promote（v1 worktree 合入已退役）：v2 分支合入由 worker 完成，将军验收请用 transition done') as Error & { status?: number }
            err.status = 501
            throw err
          }
          const argv = ['promote', id, '--by', by]
          if (typeof body.ifVersion === 'number') argv.push('--if-version', String(body.ifVersion))
          return runTaskctl(argv)
        })
        return
      }

      if (req.method === 'GET' && path === '/api/patch') {
        const patchId = url.searchParams.get('id') ?? ''
        if (!/^[A-Za-z0-9-]+$/.test(patchId)) {
          json(res, 400, { error: '非法 patch id' })
          return
        }
        readFile(join(patchesDir, `${patchId}.patch`), (err, data) => {
          if (err) {
            json(res, 404, { error: `patch 不存在：${patchId}` })
            return
          }
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(data)
        })
        return
      }

      if (path === '/api/config') {
        const [pipelineRaw, daemon] = await Promise.all([
          readJson(join(repoRoot, 'roles.json')),
          readJson(join(scrumDir, 'daemon.json')),
        ])
        const pipeline = pipelineRaw && typeof pipelineRaw === 'object' && 'stages' in pipelineRaw
          ? { name: (pipelineRaw as { name?: string }).name ?? null, stages: (pipelineRaw as { stages?: { role?: string; label?: string }[] }).stages?.map(s => ({ role: s.role ?? null, label: s.label ?? null })) ?? [] }
          : null
        json(res, 200, { auth: false, host: '127.0.0.1', port: ctx.webServer.port, pipeline, daemon })
        return
      }
      if (path === '/api/daemon') {
        const daemon = await readJson(join(scrumDir, 'daemon.json'))
        json(res, 200, daemon ?? {})
        return
      }
      if (path === '/api/artifact') {
        await serveArtifact(req, res)
        return
      }
      if (path === '/api/board') {
        serveBoard(res)
        return
      }
      if (path === '/api/board/events') {
        sseHeaders(res)
        res.write('retry: 2000\n\n')
        const heartbeat = setInterval(() => res.write(':hb\n\n'), 15000)
        if (useHub) {
          // hub 模式（P1-1 第 2 步）：连接即推一次 v2 全量，随后由上游 /api/events 泵推送
          hubBoardClients.add(res)
          void pumpHubBoard()
          req.on('close', () => {
            clearInterval(heartbeat)
            hubBoardClients.delete(res)
          })
          return
        }
        boardClients.add(res)
        sendBoard(res)
        req.on('close', () => {
          clearInterval(heartbeat)
          boardClients.delete(res)
        })
        return
      }
      if (path === '/api/activity') {
        if (useHub) {
          const limit = Number(url.searchParams.get('limit') ?? 50)
          const scope = config.scope
          try {
            const data = await hubGet(`/api/activity?scope=${encodeURIComponent(scope)}&limit=${limit}`)
            json(res, 200, data)
          } catch (e) {
            json(res, 500, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }
        const limit = Number(url.searchParams.get('limit') ?? 50)
        readFile(activityFile, (err, data) => {
          if (err) {
            json(res, 200, [])
            return
          }
          const tail = data.toString('utf8').split('\n').filter((l) => l.length > 0).slice(-limit)
            .map((l) => {
              try { return JSON.parse(l) } catch { return null }
            })
            .filter(Boolean)
          json(res, 200, tail)
        })
        return
      }
      if (path === '/api/activity/events') {
        sseHeaders(res)
        res.write('retry: 2000\n\n')
        const heartbeat = setInterval(() => res.write(':hb\n\n'), 15000)
        if (useHub) {
          // hub 模式：上游 v2 /api/events 的 data 信封逐条透传（不含本地 activity.jsonl）
          hubActivityClients.add(res)
          try {
            const recent = await hubGet(`/api/activity?scope=${encodeURIComponent(config.scope)}&limit=30`) as unknown[]
            for (const line of recent) {
              const payload = typeof line === 'string' ? line : JSON.stringify(line)
              res.write(`data: ${payload}\n\n`)
            }
          } catch { /* 回放失败跳过，实时流照常 */ }
          req.on('close', () => {
            clearInterval(heartbeat)
            hubActivityClients.delete(res)
          })
          return
        }
        activityClients.add(res)
        readFile(activityFile, (err, data) => {
          if (err) return
          const recent = data.toString('utf8').split('\n').filter((l) => l.length > 0).slice(-30)
          sendActivityLines(res, recent)
        })
        req.on('close', () => {
          clearInterval(heartbeat)
          activityClients.delete(res)
        })
        return
      }

      if (path === '/' || path === '/kanban.html') {
        serveKanban(res)
        return
      }
      if (path === '/console' || path === '/console.html') {
        serveConsole(res)
        return
      }

      json(res, 404, { error: `not found: ${path}` })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (res.headersSent) res.end()
      else json(res, 500, { error: message })
    }
  }

  // 注册路由 + 监听 + 初始渲染
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: prefix,
      handler: (req, res) => {
        void handle(req, res)
      },
    }),
    `${name}: route`,
  )

  ctx.effect(() => {
    // P1-3 真实宿主注入修正：原 watch(board.json) 在 board.json 尚未由 render 生成时
    // 同步抛 ENOENT，导致插件在空任务库/冷启动宿主上 mount 失败。改为目录级 watch
    // （scrumDir 必然存在）+ filename 分派：board.json 变化 → 广播；tasks.json 变化 →
    // 防抖重渲染（渲染会再写 board.json，闭环不变）。
    const dirWatcher = watch(scrumDir, (_event, filename) => {
      const name = typeof filename === 'string' ? basename(filename) : ''
      if (name === 'board.json') broadcast()
      else if (name === 'tasks.json' || name === '') onTasksChange()
    })
    watchFile(activityFile, { interval: 1000 }, onActivity)
    return () => {
      dirWatcher.close()
      unwatchFile(activityFile, onActivity)
      for (const res of boardClients) res.end()
      for (const res of activityClients) res.end()
      boardClients.clear()
      activityClients.clear()
    }
  }, `${name}: watchers`)

  ctx.effect(() => {
    // P1-1 第 2 步：hub 模式下订阅上游 v2 /api/events（事件桥），并把连接/泵收进 fiber 清理
    if (useHub) connectHubEvents()
    return () => {
      hubEventsAlive = false
      if (hubUpstream) {
        try { hubUpstream.close() } catch { /* ignore */ }
        hubUpstream = null
      }
      clearTimeout(hubRetryTimer)
      clearTimeout(hubPumpTimer)
      for (const res of hubBoardClients) res.end()
      for (const res of hubActivityClients) res.end()
      hubBoardClients.clear()
      hubActivityClients.clear()
    }
  }, `${name}: hub events`)

  // 启动即探测 hub（探测成功则读/写走 hub）+ 本地模式刷新一次看板
  void detectHub()
  if (!useHub) void runRender().catch(() => {})
}
