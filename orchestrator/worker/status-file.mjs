// orchestrator/worker/status-file.mjs
// ============================================================================
// worker 状态文件（PRT-301 起）
//
// 为什么一个「没有监听端口」的 worker 仍然需要一个可观测出口：
// Launcher 的就绪判据对 orchestrator 声明的是 `kind: 'none'`——也就是说
// 「进程起来了」就等于「好了」。对 worker 而言这两件事差得很远：
// 它可能起来了但拿不到 team-hub、可能没有执行引擎、可能熔断停手。
// 没有状态文件时，这三种情况在外部**完全同形**，都表现成「进程在，队列不动」。
//
// 三条约束：
// ① **原子替换**（写临时文件再 rename）。诊断页与 Launcher 都会读这个文件，
//    读到半截 JSON 会得到一个「状态未知」，而真正的原因只是写入被打断。
// ② **绝不写入 token 或任何凭证**。状态文件会被贴进 issue 与诊断包，
//    而 `TEAM_HUB_TOKEN` 恰好是这个进程持有的东西——脱敏必须在写入侧做，
//    不能指望每个读它的人自己记得。
// ③ **写不进去不致命**：状态文件是观测手段，不是业务数据。
//    磁盘满 / 权限变化时 worker 必须继续干活，只在日志里记一笔。
// ============================================================================

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 状态文件相对 DataDir 的路径。 */
export const STATUS_RELPATH = 'orchestrator/worker.status.json'

/**
 * 状态文件里**永远不出现**的键。
 *
 * 用键名黑名单而不是「记得删掉 token」：新增字段的人不会知道这条规则，
 * 而黑名单会在写入时拦下他。
 */
export const FORBIDDEN_STATUS_KEYS = Object.freeze([
  'token', 'TEAM_HUB_TOKEN', 'authorization', 'Authorization', 'secret', 'password', 'apiKey', 'api_key',
])

/** 从状态对象里剔除禁用键（递归），并把命中的键名报出来。 */
export function redactStatus(value, { path = '' } = {}) {
  const removed = []
  const walk = (v, prefix) => {
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${prefix}[${i}]`))
    const out = {}
    for (const [k, raw] of Object.entries(v)) {
      if (FORBIDDEN_STATUS_KEYS.includes(k)) {
        removed.push(prefix === '' ? k : `${prefix}.${k}`)
        continue
      }
      out[k] = walk(raw, prefix === '' ? k : `${prefix}.${k}`)
    }
    return out
  }
  return Object.freeze({ value: walk(value, path), removed: Object.freeze(removed) })
}

/**
 * 原子写入状态文件。
 *
 * 返回 `{ ok, path, removed, code, message }`。**写失败不抛错**（见文件头 ③）：
 * worker 的职责是执行任务，不是保证观测文件可写。
 */
export function writeStatusFile(path, status, {
  mkdir = (p) => mkdirSync(p, { recursive: true }),
  writeFile = writeFileSync,
  rename = renameSync,
  unlink = unlinkSync,
  now = () => new Date().toISOString(),
} = {}) {
  const { value, removed } = redactStatus(status)
  const payload = { ...value, statusWrittenAt: now() }
  const tmp = `${path}.tmp`
  try {
    mkdir(dirname(path))
    writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8' })
    rename(tmp, path)
  } catch (e) {
    try { unlink(tmp) } catch { /* 临时文件可能压根没建出来 */ }
    return Object.freeze({
      ok: false,
      path,
      removed,
      code: 'STATUS_WRITE_FAILED',
      message: `状态文件写入失败 ${path}：${e?.code ?? e?.message ?? e}。` +
        '这只是观测手段，worker 会继续工作；但外部将看不到它的真实状态',
    })
  }
  return Object.freeze({ ok: true, path, removed, code: null, message: null, payload })
}

/** 读回状态文件。不存在或解析失败时如实说明，不猜。 */
export function readStatusFile(path, { exists = existsSync, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  if (!exists(path)) return Object.freeze({ ok: false, status: null, reason: '状态文件不存在（worker 未启动过或未写成功）', path })
  try {
    const raw = JSON.parse(readFile(path).replace(/^\uFEFF/, ''))
    return Object.freeze({ ok: true, status: Object.freeze(raw), path })
  } catch (e) {
    return Object.freeze({ ok: false, status: null, reason: `状态文件不可解析：${e?.message ?? e}`, path })
  }
}

/** 状态文件的默认新鲜度窗口：超过它就只能算「历史」，不能算「在跑」。 */
export const DEFAULT_STATUS_MAX_AGE_MS = 30000

/**
 * 状态是否仍然新鲜。
 *
 * **这条判据的存在本身是一个平台事实的产物**：Windows 上
 * `child.kill('SIGTERM')`（以及任何进程管理器发的「终止」）会**无条件终止**目标进程，
 * 接收方的信号处理器根本不会被调用。因此优雅停止路径在 Windows 上可能一次都没走过，
 * 状态文件会永远停在最后一刻写的那个值（例如 `executing`）。
 * 「文件存在」与「worker 还活着」因此是两件事，必须分开判定。
 *
 * 判定不了（缺时间戳）时返回 `fresh: false`：宁可说「不确定」，
 * 也不要把一个可能已经死掉的 worker 报成在跑——后者的代价是任务永远没人认领。
 */
export function isStatusFresh(status, { now = Date.now(), maxAgeMs = DEFAULT_STATUS_MAX_AGE_MS } = {}) {
  const writtenAt = status?.statusWrittenAt
  if (typeof writtenAt !== 'string') {
    return Object.freeze({ fresh: false, ageMs: null, reason: '状态文件没有写入时间：无法判断它是当前的还是历史遗留的' })
  }
  const t = Date.parse(writtenAt)
  if (Number.isNaN(t)) {
    return Object.freeze({ fresh: false, ageMs: null, reason: `状态文件的写入时间不可解析：${writtenAt}` })
  }
  const ageMs = now - t
  if (ageMs < 0) {
    // 时钟回拨（或跨机读取）不得被当成「非常新鲜」
    return Object.freeze({ fresh: false, ageMs, reason: `状态文件的写入时间在未来（${writtenAt}）：时钟可能被调整过，不能据此判断存活` })
  }
  if (ageMs > maxAgeMs) {
    return Object.freeze({
      fresh: false,
      ageMs,
      reason: `状态文件已过期 ${Math.round(ageMs / 1000)}s（阈值 ${Math.round(maxAgeMs / 1000)}s）：` +
        'worker 可能已被强制终止（Windows 上「终止」不会走信号处理器），文件会停在最后一刻的值',
    })
  }
  return Object.freeze({ fresh: true, ageMs, reason: null })
}
