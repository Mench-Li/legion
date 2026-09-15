// product/launcher/single-instance.mjs
// ============================================================================
// PRT-708 / PRT-254：**单实例保护**。
//
// 一个产品家目录（`DataDir`）同时被两个 Legion 实例拿着，坏在三个地方：
//
//   ① 托盘：两个实例各画一个图标，用户点了其中"停止"，另一个还在跑；
//   ② 进程观察：`observe()` 看到的是**同一批**进程，于是两边都以为自己管着它们，
//      谁先停都会去动另一个的进程；
//   ③ 端口发布：`runtime-contract-endpoint` 的 `STALE` 读数里带着 `publishedPid`，
//      而那句诊断的原文就是「去看是不是有第二个进程在写同一个 DataDir」——
//      也就是说那条诊断**假定**了这种东西存在，却没有任何东西拦着它。
//
// `product/launcher/` 里此前**没有任何锁**（`ports.mjs` 的 `exclusive: true`
// 说的是"这一个端口没被别人占"，不是"这个产品家目录没被别人用"）。
//
// ## 这把锁要同时满足三件互相拉扯的事
//
// **① 崩溃过的实例不能把产品永久锁死。**
//    锁文件是磁盘上的东西，进程死了它还在。一个"文件在就拒绝启动"的实现，
//    在第一次崩溃之后就让产品**再也起不来**，而用户手上唯一的线索是
//    "已经有一个实例在运行" —— 那句话还是假的。
//
//      > 一把"崩溃之后再也开不了"的锁，
//      > 与一个"崩了就再也起不来"的产品，
//      > 在用户那里是同一个东西——只不过前者会在提示里说自己是保护机制。
//
// **② 但"能不能回收"必须建立在**读得出来**的基础上。**
//    锁文件被截断、被写坏、或者宿主根本没权限读进程表时，我们**判断不了**
//    持有者是不是还活着。这时候两个方向都有代价，必须**选一个并说清**：
//
//      · 回收 → 可能真的开出第二个实例（保护失效，且是**静默**失效）；
//      · 拒绝 → 用户被挡在门外，但我们能告诉他**具体该删哪个文件**。
//
//    这里选**拒绝**。理由是这一层的目的就是"别开第二个"，而"我判断不了"
//    不能成为"所以我放你过去"的理由；同时把出路写在诊断里，
//    于是拒绝是可解的，不是死胡同（`line 275` 那条「提示修复或回滚」的同一条纪律）。
//
// **③ 释放时必须确认"这把锁还是我的"。**
//    一个无条件的 `unlink`，会在"我的锁已经被别人回收、别人又建了新的"之后，
//    把**别人**的锁删掉——于是第三个实例可以进来。
//
//      > 一个"不核对持有者就删锁"的释放，
//      > 与一个"根本没有锁"的实现，
//      > 在两次崩溃咬在一起的那一天是同一个东西。
//
// ## 判据是纯的，IO 是注入的
//
// 与 `ports.mjs` / `secrets-check.mjs` / `dsh-overlay.mjs` 同一做法：
// 决定"该拦谁、该放谁、该回收谁"的逻辑不碰磁盘，逐条可验证；
// 真实 IO 走一个可以注入的 `fs` 口子。
// ============================================================================

import { mkdirSync, readFileSync, writeFileSync, rmSync, openSync, closeSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 本模块的版本。落进锁文件，便于把一次运行与一份实现对起来。 */
export const SINGLE_INSTANCE_VERSION = 1

/** 锁文件名。放在产品家目录里（`DataDir`）——被保护的东西就在那儿。 */
export const INSTANCE_LOCK_FILENAME = 'legion-instance.lock'

/** 具名结论。退出码由调用方决定，这里只说清是**哪一种**。 */
export const SINGLE_INSTANCE_CODES = Object.freeze({
  /** 拿到锁，可以启动。 */
  ACQUIRED: 'INSTANCE_LOCK_ACQUIRED',
  /** 有一个**活着的**实例持有它。 */
  HELD: 'INSTANCE_ALREADY_RUNNING',
  /** 锁在，但持有者已经死了 → 已经回收并拿到锁。 */
  RECLAIMED: 'INSTANCE_LOCK_STALE_RECLAIMED',
  /** 锁在，但**判断不了**持有者死活（读不出 / 写坏了 / 问不到进程表）。 */
  UNKNOWN: 'INSTANCE_LOCK_HOLDER_UNKNOWN',
  /** 释放时发现这把锁已经不是自己的了。 */
  NOT_OURS: 'INSTANCE_LOCK_NOT_OURS',
})

/** 默认的锁文件路径。 */
export function instanceLockPath(dataDir) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') return null
  return join(dataDir, INSTANCE_LOCK_FILENAME)
}

/**
 * 进程活着吗？**三态**：`true` / `false` / `null`（判断不了）。
 *
 * `null` 与 `false` 必须分开：把"问不到"读成"死了"会去回收一把活锁
 * （= 真的开出第二个实例），而那是这一层唯一不能出的错。
 *
 * @param {number} pid
 * @param {(pid: number, signal: number) => void} [kill] 注入点（默认 `process.kill`）
 * @returns {boolean|null}
 */
export function processAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    // 信号 0：不真的发信号，只做存在性与权限检查。
    kill(pid, 0)
    return true
  } catch (e) {
    // ESRCH = 没有这个进程 → **确定**死了。
    if (e?.code === 'ESRCH') return false
    // EPERM = 进程在，但不是我们的 → **确定**活着。
    if (e?.code === 'EPERM') return true
    // 其它一律"判断不了"。这不是保守，是如实：我们确实不知道。
    return null
  }
}

/** 解析锁文件内容。**畸形一律返回 null**，绝不猜出一个持有者。 */
export function parseLock(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  let v = null
  try { v = JSON.parse(text) } catch { return null }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  // `pid` 是唯一的硬要求：没有它，这把锁说不出是谁拿着，也就无从判断死活。
  if (!Number.isInteger(v.pid) || v.pid <= 0) return null
  return Object.freeze({
    version: Number.isInteger(v.version) ? v.version : null,
    pid: v.pid,
    startedAt: typeof v.startedAt === 'string' ? v.startedAt : null,
    dataDir: typeof v.dataDir === 'string' ? v.dataDir : null,
  })
}

/** 默认的真实 IO。 */
const realFs = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, 'utf8'),
  /** `wx` = 只在文件**不存在**时创建。这是这把锁的原子性来源。 */
  createExclusive: (p, text) => {
    const fd = openSync(p, 'wx')
    try { writeFileSync(fd, text, 'utf8') } finally { closeSync(fd) }
  },
  remove: (p) => rmSync(p, { force: true }),
  ensureDir: (p) => mkdirSync(p, { recursive: true }),
}

/**
 * 拿这把锁。
 *
 * @param {object} deps
 * @param {string} deps.dataDir 产品家目录（被保护的东西）
 * @param {number} [deps.pid] 本进程 pid
 * @param {() => string} [deps.now]
 * @param {(pid: number) => boolean|null} [deps.alive] 注入点
 * @param {object} [deps.fs] 注入点（默认真实 IO）
 * @returns {Promise<object>} `{ok, code, lock, holder, handle, diagnostics}`
 */
export async function acquireSingleInstance({
  dataDir, pid = process.pid, now = () => new Date().toISOString(),
  alive = processAlive, fs = realFs,
} = {}) {
  const file = instanceLockPath(dataDir)
  if (file === null) {
    throw new Error('acquireSingleInstance: 需要 dataDir（被保护的产品家目录）')
  }
  const diagnostics = []
  const record = { version: SINGLE_INSTANCE_VERSION, pid, startedAt: now(), dataDir: file }

  const writeLock = () => {
    fs.ensureDir(dirname(file))
    fs.createExclusive(file, JSON.stringify(record))
  }

  // ── 第一次尝试：直接独占创建 ──────────────────────────────────────────
  // 这是**唯一**的原子操作。不要用 `exists()` 再 `write()` 的两步法：
  // 两步之间正好是另一个实例插进来的窗口，而那个窗口里两边的读数都说"没人"。
  try {
    writeLock()
    return result(true, SINGLE_INSTANCE_CODES.ACQUIRED, { file, pid }, record, diagnostics, fs)
  } catch (e) {
    if (e?.code !== 'EEXIST') {
      // 目录不可写、路径不对 …… 这是**接线/环境**问题，必须响亮。
      throw e
    }
  }

  // ── 锁已存在：读出来看是谁 ────────────────────────────────────────────
  let holder = null
  try {
    holder = parseLock(fs.read(file))
  } catch (e) {
    diagnostics.push(`读锁文件失败：${e?.code ?? e?.message ?? String(e)}`)
    holder = null
  }

  if (holder === null) {
    // 读不出 / 写坏了 → **判断不了**。拒绝，并把出路写清楚。
    diagnostics.push(
      `锁文件存在但读不出持有者（${file}）。`,
      '不回收：读不出持有者时无法判断它是否还活着，回收可能真的开出第二个实例。',
      `确认没有 Legion 在跑之后，删掉这个文件再启动：${file}`,
    )
    return result(false, SINGLE_INSTANCE_CODES.UNKNOWN, { file, pid }, null, diagnostics, fs)
  }

  const isAlive = alive(holder.pid)
  if (isAlive === true) {
    diagnostics.push(
      `已经有一个 Legion 实例在跑（pid ${holder.pid}`
      + `${holder.startedAt === null ? '' : `，起于 ${holder.startedAt}`}）。`,
      '同一个产品家目录只能有一个实例：两个实例会各画一个托盘图标，',
      '并且 `observe()` 会看到同一批进程 —— 谁先停都会去动另一个的进程。',
    )
    return result(false, SINGLE_INSTANCE_CODES.HELD, { file, pid }, holder, diagnostics, fs)
  }

  if (isAlive === null) {
    diagnostics.push(
      `锁文件说持有者是 pid ${holder.pid}，但**问不到**这个进程还在不在。`,
      '不回收：把"问不到"读成"死了"会去抢一把可能还活着的锁。',
      `确认没有 Legion 在跑之后，删掉这个文件再启动：${file}`,
    )
    return result(false, SINGLE_INSTANCE_CODES.UNKNOWN, { file, pid }, holder, diagnostics, fs)
  }

  // ── 持有者确定死了：回收 ──────────────────────────────────────────────
  // 先删再建（而不是直接 `write`）：`createExclusive` 只在文件不存在时成功，
  // 所以必须先让"陈旧的它"消失。删的是**确认过持有者已死**的那一个。
  diagnostics.push(
    `发现一个崩溃留下的锁（pid ${holder.pid} 已经不在了），已回收并接管。`,
    '不回收的话，第一次崩溃之后产品就再也起不来了 —— '
    + '而用户看到的提示会是"已经有一个实例在运行"，那句话还是假的。',
  )
  fs.remove(file)
  try {
    writeLock()
  } catch (e) {
    if (e?.code === 'EEXIST') {
      // 刚删完又被别人建上了：另一个实例和我们同时在做回收。
      // 这一支**不是**理论上的——两个进程同时启动正好走这里。
      diagnostics.push('回收过程中另一个实例抢先建了锁 —— 按"已有活实例"处理。')
      const other = (() => { try { return parseLock(fs.read(file)) } catch { return null } })()
      return result(false, SINGLE_INSTANCE_CODES.HELD, { file, pid }, other, diagnostics, fs)
    }
    throw e
  }
  return result(true, SINGLE_INSTANCE_CODES.RECLAIMED, { file, pid }, holder, diagnostics, fs)
}

/** 组装结果，并挂上 `handle`（只有拿到锁才有）。 */
function result(ok, code, lock, holder, diagnostics, fs) {
  const handle = ok
    ? Object.freeze({
      lock,
      /**
       * 释放。**必须先核对这把锁还是自己的。**
       *
       * 无条件 `unlink` 会在"我的锁已被回收、别人又建了新的"之后删掉**别人**
       * 的锁 —— 于是第三个实例可以进来。
       */
      release() {
        let current = null
        try { current = parseLock(fs.read(lock.file)) } catch { current = null }
        if (current === null) {
          return { ok: false, code: SINGLE_INSTANCE_CODES.NOT_OURS, reason: '锁文件不存在或读不出' }
        }
        if (current.pid !== lock.pid) {
          return {
            ok: false,
            code: SINGLE_INSTANCE_CODES.NOT_OURS,
            reason: `锁现在属于 pid ${current.pid}，不是我们（${lock.pid}）`,
          }
        }
        fs.remove(lock.file)
        return { ok: true, code: 'INSTANCE_LOCK_RELEASED' }
      },
    })
    : null
  return Object.freeze({
    ok, code, lock, holder, handle, diagnostics: Object.freeze(diagnostics),
  })
}
