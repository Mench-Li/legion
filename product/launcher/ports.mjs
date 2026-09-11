// product/launcher/ports.mjs
// ============================================================================
// 端口可用性与「谁在听」判定（PRT-703 端口冲突诊断）
//
// spec §6.10 要求 Launcher 提供「端口冲突检测与明确提示」。这里刻意把两件
// 常被混为一谈的事分开：
//
//   canBind()      我能不能绑定这个端口 —— 启动前必须先问这个
//   somethingIsListening()  有没有人在听 —— 只说明「有东西」，不说明是**对的东西**
//
// 用后者当前者会得到一个经典的假绿：某个残留进程正好占着 8787，
// 探针连得上、`/api/config` 也可能返回 200，Launcher 于是认为「team-hub 已就绪」，
// 而实际上跑的是上一次的旧实例（可能就是被升级替换掉的那一版程序）。
// 因此本模块只回答「能不能绑」与「谁在听」，
// 「听到的是不是我们自己」由 readiness 的**身份断言**回答（见 readiness.mjs）。
//
// 只监听回环（spec §10）：探测一律走 127.0.0.1，不解析主机名——
// `localhost` 在部分机器上会先解析到 ::1，于是「端口可连」的判断取决于 DNS 配置。
// ============================================================================

import { createServer, connect } from 'node:net'

const DEFAULT_TIMEOUT_MS = 1000

/**
 * 端口是否空闲（能否绑定）。
 *
 * 这是启动前的权威判据：`listen` 失败为 `EADDRINUSE`/`EACCES` 时说明端口不可用。
 * 用「真的去绑一次再放开」而不是查进程表：端口占用者可能不是本机 Node 进程，
 * 而且 `listen(0)` 分配端口之后到底归谁，只有绑一次才知道。
 */
export function canBind(port, { host = '127.0.0.1', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      resolve({ ok: false, code: 'PORT_OUT_OF_RANGE', port, message: `端口 ${port} 不是合法端口（0..65535）` })
      return
    }
    const server = createServer()
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      try { server.close() } catch { /* ignore */ }
      resolve(result)
    }
    const timer = setTimeout(() => done({ ok: false, code: 'PORT_CHECK_TIMEOUT', port, message: `绑定端口 ${port} 检测超时（${timeoutMs}ms）` }), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    server.once('error', (err) => {
      clearTimeout(timer)
      const code = err?.code === 'EADDRINUSE' ? 'PORT_IN_USE'
        : err?.code === 'EACCES' ? 'PORT_PRIVILEGED'
          : 'PORT_CHECK_FAILED'
      const message = code === 'PORT_IN_USE'
        ? `端口 ${port} 已被其他进程占用`
        : code === 'PORT_PRIVILEGED'
          ? `端口 ${port} 需要更高权限（<1024 的端口通常需要管理员）`
          : `端口 ${port} 不可用：${err?.code ?? err?.message ?? 'unknown'}`
      done({ ok: false, code, port, message })
    })
    server.listen({ port, host, exclusive: true }, () => {
      clearTimeout(timer)
      done({ ok: true, code: null, port, message: null })
    })
  })
}

/** 有没有人在监听（TCP 连接测试）。返回布尔；用于诊断文案，不用于就绪判定。 */
export function somethingIsListening(port, { host = '127.0.0.1', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * 让操作系统分配一个空闲端口。
 *
 * 有竞态（放开到别人用它之间有时间窗），因此**分配之后必须再 `canBind` 一次**，
 * 且启动进程后仍要以 readiness 为准。把它当成「保证拿到」的端口分配器是错的用法，
 * 这里因此不叫 `getFreePort` 而叫 `reserveEphemeralPort`：
 * 名字要让人觉得它只是「先问一下」。
 */
export function reserveEphemeralPort({ host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ port: 0, host, exclusive: true }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : null
      server.close(() => {
        if (typeof port !== 'number') reject(new Error('未能从操作系统获得端口分配结果'))
        else resolve(port)
      })
    })
  })
}

/**
 * 逐进程的端口检查。返回诊断列表（沿用 `ProcessDiagnostic` 形态，
 * 便于和 `validateProcessPlan` 的结果合并后一次性展示）。
 *
 * 两类问题分别处理，因为它们要说的排查方向完全不同：
 *
 *   ① **端口被外部占用**（`PORT_IN_USE`）→「去关掉那个进程，或换端口」。
 *   ② **同一批进程里两个都申请了同一端口**（`PORT_CLAIMED_TWICE`）→
 *      「你的配置写错了」。这一类必须**在探测之前**判出来：
 *      `canBind` 探完就立刻放开端口，所以「前一个进程已占用」在探测层面
 *      根本不存在——只有比对清单才能发现。曾经这里靠一个「探测成功的端口」
 *      集合去归因，那个集合永远为空，于是冲突被误报成「被外部占用」，
 *      把用户指向一个并不存在的占用进程。
 */
export async function checkPorts(processes, { allowInUse = [], timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const diagnostics = []
  const claimed = new Map()
  for (const proc of processes) {
    if (proc.port === null || proc.port === undefined) continue
    if (allowInUse.includes(proc.key)) continue

    const firstClaimant = claimed.get(proc.port)
    if (firstClaimant !== undefined) {
      diagnostics.push(Object.freeze({
        severity: 'error',
        code: 'PORT_CLAIMED_TWICE',
        process: proc.key,
        port: proc.port,
        portListening: false,
        message: `进程 ${proc.key} 与 ${firstClaimant} 申请了同一端口 ${proc.port}：` +
          '后启动的那一个会静默退出（绑定失败），而用户只会看到「某个功能没有数据」。' +
          '请为其中之一配置另一个端口。',
      }))
      continue
    }
    claimed.set(proc.port, proc.key)

    const result = await canBind(proc.port, { host: proc.host ?? '127.0.0.1', timeoutMs })
    if (result.ok === true) continue
    const listening = result.code === 'PORT_IN_USE'
      ? await somethingIsListening(proc.port, { host: proc.host ?? '127.0.0.1' })
      : false
    diagnostics.push(Object.freeze({
      severity: 'error',
      code: result.code,
      process: proc.key,
      message: result.code === 'PORT_IN_USE'
        ? `进程 ${proc.key} 的端口 ${proc.port} 被其他进程占用`
          + `${listening ? '，且该端口已有服务在监听' : ''}。`
          + '请关闭占用它的进程，或为该进程配置另一个端口后重试。'
        : result.message,
      port: proc.port,
      portListening: listening,
    }))
  }
  return Object.freeze(diagnostics)
}
