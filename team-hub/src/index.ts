/**
 * @dsh-external/dsh-team-hub — 军团团队协作中枢（服务形态）。
 *
 * 在 DSH webServer 上提供共享任务池的鉴权入口 + 任务变化事件流（SSE）：
 *   - POST /api/create|transition|comment|claim|reject|promote：写操作，需
 *     `Authorization: Bearer <teamToken>`（token 非空时），操作者经 `body.by`
 *     传递，须在 `config.members` 白名单内（白名单非空时）。
 *   - GET /api/board：任务列表（读，按 role/soldier/status 过滤）。
 *   - GET /api/activity：最近动态（读）。
 *   - GET /api/events：SSE 任务变化事件流（activity.jsonl 推送），多客户端实时同步。
 *
 * 后端直接调 taskctl.mjs（带跨进程文件锁 + 乐观锁），与 scrum-board 看板、
 * scrum-worker 守护共享同一 tasks.json。多进程并发写由 taskctl 的文件锁保证互斥。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { spawn } from 'node:child_process'
import { readFile, watchFile, unwatchFile } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = '@dsh-external/dsh-team-hub'
export const inject = ['webServer']

export interface Config {
  /** legion/scrum 目录（taskctl.mjs / tasks.json / activity.jsonl 所在）。 */
  scrumDir: string
  /** webServer 路由前缀（hub 挂在此前缀下）。 */
  routePrefix: string
  /** 团队共享 token；非空时写操作需 `Authorization: Bearer <token>`。 */
  teamToken: string
  /** 全局成员白名单；非空时写操作的 `body.by` 必须是其中之一。 */
  members: string[]
  /** scope 级成员白名单：scope 名 → 允许操作的成员列表（非空时该 scope 写操作须匹配）。 */
  scopes: Record<string, string[]>
}

export const Config = z.object({
  scrumDir: z.string().default('D:/project/dsh/legion/scrum'),
  routePrefix: z.string().default('/team-hub'),
  teamToken: z.string().default(''),
  members: z.array(z.string()).default([]),
  scopes: z.dict(z.array(z.string())).default({}),
})

export function apply(ctx: Context, config: Config): void {
  const scrumDir = config.scrumDir
  const prefix = config.routePrefix.replace(/\/+$/, '') || '/'
  const repoRoot = join(scrumDir, '..')
  const activityFile = join(scrumDir, 'activity.jsonl')
  const taskctl = join(scrumDir, 'taskctl.mjs')

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

  /** 校验团队 token；token 为空视为开发模式（不鉴权）。 */
  function authorized(req: IncomingMessage): boolean {
    if (config.teamToken === '') return true
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    return token === config.teamToken
  }

  /** 校验操作者身份：by 非空，且（全局白名单非空时）在全局白名单内，且（scope 白名单非空时）在 scope 白名单内。 */
  function requireMember(body: Record<string, unknown>, scope: string): string {
    const by = body.by
    if (typeof by !== 'string' || by.trim().length === 0) throw new Error('缺少操作者身份 by')
    const member = by.trim()
    if (config.members.length > 0 && !config.members.includes(member)) {
      throw new Error(`成员 ${member} 不在全局白名单（${config.members.join(', ')}）`)
    }
    const scopeMembers = config.scopes[scope]
    if (scopeMembers !== undefined && scopeMembers.length > 0 && !scopeMembers.includes(member)) {
      throw new Error(`成员 ${member} 不在 scope ${scope} 的白名单（${scopeMembers.join(', ')}）`)
    }
    return member
  }

  /** 从请求体读 scope（缺省 'default'）。 */
  function readScope(body: Record<string, unknown>): string {
    return typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : 'default'
  }

  /** 统一写入口：鉴权 → 读体 → 执行（body 里带 by + scope）→ 返回结果。 */
  async function handleWrite(
    req: IncomingMessage,
    res: ServerResponse,
    run: (body: Record<string, unknown>, by: string, scope: string) => Promise<unknown>,
  ): Promise<void> {
    try {
      if (!authorized(req)) {
        json(res, 401, { error: '未授权：Bearer token 无效' })
        return
      }
      const body = await readBody(req)
      const scope = readScope(body)
      const by = requireMember(body, scope)
      const result = await run(body, by, scope)
      json(res, 200, { ok: true, task: result })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const status = message.includes('乐观锁') ? 409 : 400
      json(res, status, { error: message })
    }
  }

  // ── SSE 事件流：activity.jsonl 的增量推送 ──
  const eventClients = new Set<ServerResponse>()
  let activityOffset = 0

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
      for (const res of eventClients) sendActivityLines(res, lines)
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
          'access-control-allow-headers': 'content-type, authorization',
          'access-control-max-age': '600',
        })
        res.end()
        return
      }

      // ── 写接口（鉴权）──
      if (req.method === 'POST' && path === '/api/create') {
        await handleWrite(req, res, async (body, by, scope) => {
          const title = body.title
          if (typeof title !== 'string' || title.trim().length === 0) throw new Error('缺少参数 title')
          const argv = ['create', '--title', title.trim(), '--scope', scope]
          if (typeof body.description === 'string' && body.description.length > 0) argv.push('--description', body.description)
          if (typeof body.role === 'string' && body.role.length > 0) argv.push('--role', body.role)
          if (typeof body.priority === 'string' && body.priority.length > 0) argv.push('--priority', body.priority)
          if (typeof body.parent === 'string' && body.parent.length > 0) argv.push('--parent', body.parent)
          if (typeof body.status === 'string' && body.status.length > 0) argv.push('--status', body.status)
          if (typeof body.ttlMinutes === 'number') argv.push('--ttl-minutes', String(body.ttlMinutes))
          void by
          return runTaskctl(argv)
        })
        return
      }

      if (req.method === 'POST' && path === '/api/claim') {
        await handleWrite(req, res, async (body, by) => {
          const id = body.id
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          const soldier = typeof body.soldier === 'string' && body.soldier.length > 0 ? body.soldier : by
          const argv = ['claim', id, '--soldier', soldier]
          if (typeof body.round === 'number') argv.push('--round', String(body.round))
          if (typeof body.ifVersion === 'number') argv.push('--if-version', String(body.ifVersion))
          if (typeof body.requestId === 'string' && body.requestId.length > 0) argv.push('--request-id', body.requestId)
          if (typeof body.ttlMinutes === 'number') argv.push('--ttl-minutes', String(body.ttlMinutes))
          if (body.force === true) argv.push('--force')
          return runTaskctl(argv)
        })
        return
      }

      if (req.method === 'POST' && path === '/api/reassign') {
        await handleWrite(req, res, async (body, by) => {
          const id = body.id
          const soldier = body.soldier
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          if (typeof soldier !== 'string' || soldier.trim().length === 0) throw new Error('缺少参数 soldier')
          const argv = ['reassign', id, '--soldier', soldier.trim(), '--by', by]
          if (typeof body.ifVersion === 'number') argv.push('--if-version', String(body.ifVersion))
          return runTaskctl(argv)
        })
        return
      }

      if (req.method === 'POST' && path === '/api/transition') {
        await handleWrite(req, res, async (body, by) => {
          const id = body.id
          const to = body.to
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          if (typeof to !== 'string' || to.length === 0) throw new Error('缺少参数 to')
          const argv = ['transition', id, '--to', to, '--by', by]
          if (typeof body.ifVersion === 'number') argv.push('--if-version', String(body.ifVersion))
          if (body.force === true) argv.push('--force')
          return runTaskctl(argv)
        })
        return
      }

      if (req.method === 'POST' && path === '/api/advance') {
        await handleWrite(req, res, async (body, by) => {
          const id = body.id
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          const argv = ['advance', id, '--by', by]
          if (typeof body.ifVersion === 'number') argv.push('--if-version', String(body.ifVersion))
          return runTaskctl(argv)
        })
        return
      }

      if (req.method === 'POST' && path === '/api/comment') {
        await handleWrite(req, res, async (body, by) => {
          const id = body.id
          const text = body.text
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          if (typeof text !== 'string' || text.trim().length === 0) throw new Error('缺少参数 text')
          return runTaskctl(['comment', id, '--by', by, '--text', text.trim()])
        })
        return
      }

      if (req.method === 'POST' && path === '/api/reject') {
        await handleWrite(req, res, async (body, by) => {
          const id = body.id
          const reason = body.reason
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          if (typeof reason !== 'string' || reason.trim().length === 0) throw new Error('缺少参数 reason')
          const argv = ['reject', id, '--by', by, '--reason', reason.trim()]
          if (typeof body.ifVersion === 'number') argv.push('--if-version', String(body.ifVersion))
          return runTaskctl(argv)
        })
        return
      }

      if (req.method === 'POST' && path === '/api/promote') {
        await handleWrite(req, res, async (body, by) => {
          const id = body.id
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          const argv = ['promote', id, '--by', by]
          if (typeof body.ifVersion === 'number') argv.push('--if-version', String(body.ifVersion))
          return runTaskctl(argv)
        })
        return
      }

      // ── 读接口 ──
      if (req.method === 'GET' && path === '/api/board') {
        const argv = ['list']
        if (url.searchParams.get('status')) argv.push('--status', url.searchParams.get('status') as string)
        if (url.searchParams.get('soldier')) argv.push('--soldier', url.searchParams.get('soldier') as string)
        if (url.searchParams.get('role')) argv.push('--role', url.searchParams.get('role') as string)
        if (url.searchParams.get('scope')) argv.push('--scope', url.searchParams.get('scope') as string)
        try {
          json(res, 200, await runTaskctl(argv))
        } catch (e) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) })
        }
        return
      }

      if (req.method === 'GET' && path === '/api/activity') {
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

      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write('retry: 2000\n\n')
        eventClients.add(res)
        readFile(activityFile, (err, data) => {
          if (err) return
          const recent = data.toString('utf8').split('\n').filter((l) => l.length > 0).slice(-30)
          sendActivityLines(res, recent)
        })
        const heartbeat = setInterval(() => res.write(':hb\n\n'), 15000)
        req.on('close', () => {
          clearInterval(heartbeat)
          eventClients.delete(res)
        })
        return
      }

      if (req.method === 'GET' && path === '/api/inbox') {
        const role = url.searchParams.get('role')
        const soldier = url.searchParams.get('soldier')
        if (role === null && soldier === null) {
          json(res, 400, { error: 'inbox 需要 role 或 soldier 参数' })
          return
        }
        const argv = ['inbox']
        if (role !== null) argv.push('--role', role)
        if (soldier !== null) argv.push('--soldier', soldier)
        if (url.searchParams.get('scope')) argv.push('--scope', url.searchParams.get('scope') as string)
        try {
          json(res, 200, await runTaskctl(argv))
        } catch (e) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) })
        }
        return
      }

      if (path === '/api/config') {
        json(res, 200, { auth: config.teamToken !== '', members: config.members, host: '127.0.0.1', port: ctx.webServer.port })
        return
      }

      json(res, 404, { error: `not found: ${path}` })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (res.headersSent) res.end()
      else json(res, 500, { error: message })
    }
  }

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
    watchFile(activityFile, { interval: 1000 }, broadcastActivity)
    return () => {
      unwatchFile(activityFile, broadcastActivity)
      for (const res of eventClients) res.end()
      eventClients.clear()
    }
  }, `${name}: activity watcher`)

  ctx.logger?.info?.(`[${name}] 团队协作中枢已挂载：${prefix}（鉴权=${config.teamToken !== '' ? 'on' : 'off'}，成员=${config.members.join(',') || '不限'}）`)
}
