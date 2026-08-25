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
import { readFile, watch, watchFile, unwatchFile } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

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
}

export const Config = z.object({
  scrumDir: z.string().default('D:/project/dsh/legion/scrum'),
  routePrefix: z.string().default('/scrum-board'),
  hubUrl: z.string().default(''),
  scope: z.string().default('software'),
})

export function apply(ctx: Context, config: Config): void {
  const scrumDir = config.scrumDir
  const prefix = config.routePrefix.replace(/\/+$/, '') || '/'
  const repoRoot = join(scrumDir, '..')
  const boardFile = join(scrumDir, 'board.json')
  const activityFile = join(scrumDir, 'activity.jsonl')
  const kanbanFile = join(scrumDir, 'kanban.html')
  const tasksFile = join(scrumDir, 'tasks.json')
  const patchesDir = join(scrumDir, 'patches')
  const taskctl = join(scrumDir, 'taskctl.mjs')
  const render = join(scrumDir, 'render.mjs')

  let hubUrl = config.hubUrl.replace(/\/+$/, '')
  let useHub = hubUrl !== ''

  /** 探测默认 hub（未显式配置 hubUrl 时）：同机 DSH web 端口的 /team-hub。 */
  async function detectHub(): Promise<void> {
    if (useHub) return
    try {
      const res = await fetch('http://127.0.0.1:3080/team-hub/api/config', { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        hubUrl = 'http://127.0.0.1:3080/team-hub'
        useHub = true
      }
    } catch { /* 探测失败保持本地模式 */ }
  }

  /** hub 写调用（POST）。 */
  async function hubPost(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${hubUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok) throw new Error(String(data.error ?? `hub ${path} 失败（${res.status}）`))
    return data.task ?? data
  }

  /** hub 读任务列表（按 scope 过滤）。 */
  async function hubBoard(): Promise<unknown> {
    const res = await fetch(`${hubUrl}/api/board?scope=${encodeURIComponent(config.scope)}`)
    if (!res.ok) throw new Error(`hub board 失败（${res.status}）`)
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
      await runRender()
      json(res, 200, { ok: true, task })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const status = message.includes('乐观锁') ? 409 : 400
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

  /** 服务 kanban.html，并把前端绝对路径 /api/* 重写为前缀下。 */
  function serveKanban(res: ServerResponse): void {
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
            return hubPost('/api/reject', { id, by, reason: reason.trim(), ifVersion: body.ifVersion, scope: config.scope })
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
            return hubPost('/api/promote', { id, by, ifVersion: body.ifVersion, scope: config.scope })
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
        json(res, 200, { auth: false, host: '127.0.0.1', port: ctx.webServer.port })
        return
      }
      if (path === '/api/board') {
        serveBoard(res)
        return
      }
      if (path === '/api/board/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write('retry: 2000\n\n')
        boardClients.add(res)
        sendBoard(res)
        const heartbeat = setInterval(() => res.write(':hb\n\n'), 15000)
        req.on('close', () => {
          clearInterval(heartbeat)
          boardClients.delete(res)
        })
        return
      }
      if (path === '/api/activity') {
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
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write('retry: 2000\n\n')
        activityClients.add(res)
        readFile(activityFile, (err, data) => {
          if (err) return
          const recent = data.toString('utf8').split('\n').filter((l) => l.length > 0).slice(-30)
          sendActivityLines(res, recent)
        })
        const heartbeat = setInterval(() => res.write(':hb\n\n'), 15000)
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
    const boardWatcher = watch(boardFile, () => broadcast())
    const tasksWatcher = watch(tasksFile, () => onTasksChange())
    watchFile(activityFile, { interval: 1000 }, onActivity)
    return () => {
      boardWatcher.close()
      tasksWatcher.close()
      unwatchFile(activityFile, onActivity)
      for (const res of boardClients) res.end()
      for (const res of activityClients) res.end()
      boardClients.clear()
      activityClients.clear()
    }
  }, `${name}: watchers`)

  // 启动即刷新一次看板（守护直接改 tasks.json 不改 board.json，需主动 render 保持新鲜）
  // 启动即探测 hub（探测成功则读/写走 hub）+ 刷新一次看板
  void detectHub()
  void runRender().catch(() => {})
}
