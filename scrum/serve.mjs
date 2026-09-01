#!/usr/bin/env node
/**
 * serve —— 军团看板本地/局域网服务（零依赖，node 内置 http/fs/child_process）。
 *
 * 读接口（GET）：
 *   /                  → kanban.html（实时模式：SSE + 轮询兜底；拖拽写回）
 *   /board.json        → 看板数据快照
 *   /KANBAN.md         → 文本看板
 *   /api/board         → board.json 内容（轮询端点）
 *   /api/board/events  → SSE：board.json 变化时推送完整看板数据
 *   /api/activity         → 最近动态事件（守护生命周期流，JSON 数组，?limit=N）
 *   /api/activity/events  → SSE：activity.jsonl 追加时推送新事件
 *   /api/config        → { auth, host, port } 供页面探测是否需要令牌
 *
 * 写接口（POST，配置了 token 时要求携带令牌）：
 *   /api/create        → 新建任务（backlog）→ 自动 render + SSE 广播
 *   /api/transition    → 状态迁移（复用 taskctl 状态机/乐观锁/角色纪律）
 *   /api/comment       → 追加评论（承载退回反馈/需求变更）
 *
 * 令牌携带方式（任选其一）：Authorization: Bearer <t> / x-dsh-token: <t> / ?token=<t>。
 * GET 保持开放：看板数据非机密；拖拽/下达等写操作必须带令牌。
 * 每次写成功后自动跑 render.mjs 刷新 board.json，fs watch 触发 SSE 广播全端。
 *
 * 用法：
 *   node legion/scrum/serve.mjs [--port 4820] [--host 127.0.0.1] [--token <t>]
 * 局域网共享：--host 0.0.0.0 --token <t>，手机/其他电脑访问 http://<本机IP>:4820
 * 环境变量：DSH_KANBAN_PORT / DSH_KANBAN_HOST / DSH_KANBAN_TOKEN
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, watch, watchFile } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRUM = join(ROOT, 'scrum')
const BOARD_FILE = join(SCRUM, 'board.json')
const ACTIVITY_FILE = join(SCRUM, 'activity.jsonl')
const PATCHES_DIR = join(SCRUM, 'patches')
const TASKCTL = join(SCRUM, 'taskctl.mjs')
const RENDER = join(SCRUM, 'render.mjs')

const args = process.argv.slice(2)

/** 读取 `--key value` 参数，缺省时回退 */
function flag(key, fallback) {
  const i = args.indexOf(key)
  return i >= 0 ? args[i + 1] : fallback
}

const port = Number(flag('--port', process.env.DSH_KANBAN_PORT ?? 4820))
const host = flag('--host', process.env.DSH_KANBAN_HOST ?? '127.0.0.1')
const token = flag('--token', process.env.DSH_KANBAN_TOKEN ?? '')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}

/** 只允许 serve scrum 目录内的白名单静态文件，杜绝目录穿越 */
function safeStatic(pathname) {
  const allowed = new Set(['/kanban.html', '/board.json', '/KANBAN.md', '/'])
  const target = pathname === '/' ? '/kanban.html' : pathname
  if (!allowed.has(target)) return null
  return join(SCRUM, normalize(target).replace(/^[/\\]+/, ''))
}

/** SSE 客户端集合 */
const clients = new Set()

/** 读取 board.json 并把多行 JSON 转成 SSE 消息体（`data: ` 前缀 + 空行结尾） */
function payloadOf(data) {
  return `${String(data).split('\n').map(line => `data: ${line}`).join('\n')}\n\n`
}

/** 读 board.json 推给单个客户端 */
function sendTo(res) {
  readFile(BOARD_FILE, (err, data) => {
    if (!err) res.write(payloadOf(data))
  })
}

/** 读 board.json 推给所有 SSE 客户端（watch 事件防抖 100ms） */
let broadcastTimer = null
function broadcast() {
  clearTimeout(broadcastTimer)
  broadcastTimer = setTimeout(() => {
    readFile(BOARD_FILE, (err, data) => {
      if (err) return
      const payload = payloadOf(data)
      for (const res of clients) res.write(payload)
    })
  }, 100)
}

watch(BOARD_FILE, () => broadcast())

/** 动态（activity）SSE 客户端集合与已广播字节偏移（activity.jsonl 只追加） */
const activityClients = new Set()
let activityOffset = 0

/** 把若干行（每行一个 JSON 事件）推给单个动态 SSE 客户端 */
function sendActivityLines(res, lines) {
  for (const line of lines) res.write(`data: ${line}\n\n`)
}

/** 读取 activity.jsonl 自上次偏移后的完整新行，广播给所有动态 SSE 客户端 */
function broadcastActivity() {
  readFile(ACTIVITY_FILE, (err, buf) => {
    if (err) return
    const text = buf.toString('utf8')
    const delta = text.slice(activityOffset)
    const lastNewline = delta.lastIndexOf('\n')
    if (lastNewline === -1) return // 无完整新行（尾行未写完）
    const complete = delta.slice(0, lastNewline + 1)
    activityOffset += complete.length
    const lines = complete.split('\n').filter(l => l.length > 0)
    for (const res of activityClients) sendActivityLines(res, lines)
  })
}

// activity.jsonl 由守护追加（文件可能尚未创建），用 poll watchFile 处理不存在/截断
watchFile(ACTIVITY_FILE, { interval: 1000 }, (curr, prev) => {
  if (curr.size < prev.size) activityOffset = 0 // 文件被截断/轮转
  if (curr.size !== prev.size) broadcastActivity()
})

/**
 * 以子进程方式执行 taskctl 命令（唯一变更入口，保证状态机/乐观锁/角色纪律一致）。
 * @param {string[]} argv - taskctl 子命令与参数，如 ['transition', 'T-001', '--to', 'done', '--by', 'general']
 * @returns {Promise<object>} 成功时 taskctl stdout 的 JSON（通常是任务对象）
 */
function runTaskctl(argv) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [TASKCTL, ...argv], { cwd: ROOT })
    let out = ''
    let err = ''
    proc.stdout.on('data', d => { out += d })
    proc.stderr.on('data', d => { err += d })
    proc.on('error', e => reject(e))
    proc.on('close', code => {
      if (code === 0) {
        try {
          resolve(JSON.parse(out))
        } catch (e) {
          reject(new Error(`taskctl 输出不是 JSON：${out.slice(0, 200)}`))
        }
      } else {
        reject(new Error(err.trim() || `taskctl 退出码 ${code}`))
      }
    })
  })
}

/** 每次写成功后重跑 render.mjs，刷新 board.json / KANBAN.md / kanban.html（watch 触发 SSE 广播） */
function runRender() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [RENDER], { cwd: ROOT })
    let err = ''
    proc.stderr.on('data', d => { err += d })
    proc.on('error', e => reject(e))
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(err.trim() || `render.mjs 退出码 ${code}`))
    })
  })
}

/** 请求是否携带合法令牌（token 未配置时恒放行） */
function authorized(req) {
  if (!token) return true
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`)
  const header = req.headers.authorization ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  const custom = req.headers['x-dsh-token']
  const query = url.searchParams.get('token')
  return bearer === token || custom === token || query === token
}

/** 读取请求 JSON 体 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', d => { raw += d })
    req.on('end', () => {
      try {
        resolve(raw.length === 0 ? {} : JSON.parse(raw))
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 统一的 JSON 响应 */
function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data, null, 2))
}

/**
 * 处理一次写操作：校验令牌 → 执行 taskctl → 重跑 render 刷新看板。
 * 乐观锁冲突映射为 409，其余业务错误映射为 400。
 */
async function handleWrite(req, res, run) {
  if (!authorized(req)) {
    json(res, 401, { error: '缺少或错误的令牌（--token 已启用）；用 ?token=… 或 Authorization: Bearer … 携带' })
    return
  }
  try {
    const body = await readBody(req)
    const task = await run(body)
    await runRender()
    json(res, 200, { ok: true, task })
  } catch (e) {
    const message = String(e.message ?? e)
    const status = message.includes('乐观锁') ? 409 : 400
    json(res, status, { error: message })
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`)
  // 允许 DSH Web GUI 或局域网页面 iframe/fetch 嵌入（file:// 与同源访问不受影响）
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('cross-origin-resource-policy', 'cross-origin')

  // CORS 预检（跨端口 iframe/局域网页面发 POST 需要）
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization, x-dsh-token',
      'access-control-max-age': '600',
    })
    res.end()
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/transition') {
    void handleWrite(req, res, body => {
      if (typeof body.id !== 'string' || body.id.length === 0) throw new Error('缺少参数 id')
      if (typeof body.to !== 'string' || body.to.length === 0) throw new Error('缺少参数 to')
      const argv = ['transition', body.id, '--to', body.to]
      if (typeof body.by === 'string' && body.by.length > 0) argv.push('--by', body.by)
      if (Number.isInteger(body.ifVersion)) argv.push('--if-version', String(body.ifVersion))
      if (body.force === true) argv.push('--force')
      return runTaskctl(argv)
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/create') {
    void handleWrite(req, res, body => {
      if (typeof body.title !== 'string' || body.title.trim().length === 0) throw new Error('缺少参数 title')
      const argv = ['create', '--title', body.title.trim()]
      if (typeof body.description === 'string' && body.description.length > 0) argv.push('--description', body.description)
      if (Array.isArray(body.acceptance) && body.acceptance.length > 0) {
        argv.push('--acceptance', body.acceptance.map(s => String(s).trim()).filter(Boolean).join(';'))
      }
      if (typeof body.priority === 'string' && body.priority.length > 0) argv.push('--priority', body.priority)
      return runTaskctl(argv)
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/comment') {
    void handleWrite(req, res, body => {
      if (typeof body.id !== 'string' || body.id.length === 0) throw new Error('缺少参数 id')
      if (typeof body.by !== 'string' || body.by.length === 0) throw new Error('缺少参数 by')
      if (typeof body.text !== 'string' || body.text.trim().length === 0) throw new Error('缺少参数 text')
      return runTaskctl(['comment', body.id, '--by', body.by, '--text', body.text.trim()])
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/reject') {
    void handleWrite(req, res, body => {
      if (typeof body.id !== 'string' || body.id.length === 0) throw new Error('缺少参数 id')
      if (typeof body.by !== 'string' || body.by.length === 0) throw new Error('缺少参数 by')
      if (typeof body.reason !== 'string' || body.reason.trim().length === 0) throw new Error('缺少参数 reason')
      const argv = ['reject', body.id, '--by', body.by, '--reason', body.reason.trim()]
      if (typeof body.ifVersion === 'number') argv.push('--if-version', String(body.ifVersion))
      return runTaskctl(argv)
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/promote') {
    void handleWrite(req, res, body => {
      if (typeof body.id !== 'string' || body.id.length === 0) throw new Error('缺少参数 id')
      if (typeof body.by !== 'string' || body.by.length === 0) throw new Error('缺少参数 by')
      const argv = ['promote', body.id, '--by', body.by]
      if (typeof body.ifVersion === 'number') argv.push('--if-version', String(body.ifVersion))
      return runTaskctl(argv)
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/patch') {
    const patchId = url.searchParams.get('id') ?? ''
    if (!/^[A-Za-z0-9-]+$/.test(patchId)) {
      json(res, 400, { error: '非法 patch id' })
      return
    }
    readFile(join(PATCHES_DIR, `${patchId}.patch`), (err, data) => {
      if (err) {
        json(res, 404, { error: `patch 不存在：${patchId}` })
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(data)
    })
    return
  }

  if (url.pathname === '/api/config') {
    readFile(join(ROOT, 'roles.json'), 'utf8', (e1, rolesRaw) => {
      readFile(join(SCRUM, 'daemon.json'), 'utf8', (e2, daemonRaw) => {
        let pipeline = null
        let daemon = null
        try {
          const r = JSON.parse(rolesRaw)
          pipeline = { name: r.name ?? null, stages: (r.stages ?? []).map(s => ({ role: s.role ?? null, label: s.label ?? null })) }
        } catch { /* roles.json 缺失/损坏则 pipeline=null */ }
        try { daemon = JSON.parse(daemonRaw) } catch { /* daemon.json 缺失则 daemon=null */ }
        json(res, 200, { auth: Boolean(token), host, port, pipeline, daemon })
      })
    })
    return
  }

  if (url.pathname === '/api/daemon') {
    readFile(join(SCRUM, 'daemon.json'), 'utf8', (err, data) => {
      if (err) {
        json(res, 200, {})
        return
      }
      try { json(res, 200, JSON.parse(data)) } catch { json(res, 200, {}) }
    })
    return
  }

  if (url.pathname === '/api/board') {
    readFile(BOARD_FILE, (err, data) => {
      if (err) {
        json(res, 404, { error: 'board.json 不存在，先运行 render.mjs' })
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(data)
    })
    return
  }

  if (url.pathname === '/api/board/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('retry: 2000\n\n')
    clients.add(res)
    // 连接即推当前数据（内联数据可能已过期）
    sendTo(res)
    // 心跳防代理超时
    const heartbeat = setInterval(() => res.write(':hb\n\n'), 15000)
    req.on('close', () => {
      clearInterval(heartbeat)
      clients.delete(res)
    })
    return
  }

  if (url.pathname === '/api/activity') {
    const limit = Number(url.searchParams.get('limit') ?? 50)
    readFile(ACTIVITY_FILE, (err, data) => {
      if (err) {
        json(res, 200, []) // 尚无动态
        return
      }
      const tail = data.toString('utf8').split('\n')
        .filter(l => l.length > 0)
        .slice(-limit)
        .map(l => { try { return JSON.parse(l) } catch { return null } })
        .filter(Boolean)
      json(res, 200, tail)
    })
    return
  }

  if (url.pathname === '/api/activity/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('retry: 2000\n\n')
    activityClients.add(res)
    // 连接即推最近 30 条历史动态，之后只推增量
    readFile(ACTIVITY_FILE, (err, data) => {
      if (err) return
      const recent = data.toString('utf8').split('\n').filter(l => l.length > 0).slice(-30)
      sendActivityLines(res, recent)
    })
    const heartbeat = setInterval(() => res.write(':hb\n\n'), 15000)
    req.on('close', () => {
      clearInterval(heartbeat)
      activityClients.delete(res)
    })
    return
  }

  const file = safeStatic(url.pathname)
  if (file === null) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(data)
  })
})

server.listen(port, host, () => {
  const auth = token ? `（写操作需令牌）` : '（无令牌）'
  process.stdout.write(`军团看板服务已启动：http://${host}:${port}${auth}（SSE 实时推送 + 拖拽写回，Ctrl-C 停止）\n`)
})
