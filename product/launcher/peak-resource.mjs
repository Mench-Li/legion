// product/launcher/peak-resource.mjs
// ============================================================================
// PRT-009 的 `peak-resource`：**执行期外部采样**进程的峰值内存与 CPU。
//
// ## 它补的是哪一截
//
// `docs/PRT-009-evidence/verify-evidence.md` §4 里 `peak-resource` 一直挂着 ⛔，
// 理由是两句：
//
//   ① DSH 的**会话转录不记录进程资源**——所以从转录里永远采不到；
//   ② 目标平台取决于 **PRT-011 分发形态裁决**。
//
// ②已经解除：`PRT-011-dsh-distribution-decision.md` 载明「已裁决（2026-09-11）：路线 C」。
// 于是剩下的只有①，而①的修法就是这句话本身：**在执行期从进程外部采样**。
//
// ## 采的是**哪个**进程——这一条差点写错
//
// 最初的判断是"worker 每次 Run 的 DSH 子进程"。**那个进程不存在。**
// 实测的架构是：
//
//   · Launcher（`supervisor.mjs`）spawn 一个**长驻**的 DSH Runtime 进程；
//   · Runtime 把 `pid / host / port / wireVersion` 发布到 DataDir 下
//     （`runtime/dsh-composition/runtime-contract-publication.mjs`）；
//   · worker 是**另一个进程**，通过 HTTP 调 Runtime。
//
// 证据在 `orchestrator/worker/runtime-contract-client.mjs:11-14`：
//
//   > 它默认去 import DSH 适配器——那在 worker 进程里是 import 得到、
//   > **跑不起来的**（`host` 端口只有 DSH Runtime 进程里有）。
//   > 一个 import 得到的模块，与一个用得到的模块，是两件事。
//
// 而 `orchestrator/worker/` 的生产文件里 `spawn` **零命中**。
// 所以"每个 Run 一个 DSH 子进程"是一个**读起来合理、实现里不存在**的对象——
// 按它写采样器，会得到一个永远采不到东西、却看起来接好了的接线。
//
// **本模块采的是那个长驻的 DSH Runtime 进程**，也就是真正在干活的那台进程。
//
// ## 一条纪律：测不到就写 `null`，不写 0
//
// 与 PRT-010 的用量读数同一条纪律（见 PRT-510 那一行的「不知道被记成了零」）：
// `0` 是一个**测量结论**（"一个字节都没用"），不是"不知道"。
// 进程已经退出、平台不支持、PowerShell 读不出来——这些都是"不知道"，
// 一律 `ok: false` + 具名 `code` + `null`，绝不回落成 0。
//
//   > 一个把"没采到"记成 0 的采样器，会让"这台机器很省内存"
//   > 与"这台机器根本没采过"在基线上同形。
// ============================================================================
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** 采样方法。**它是读数的一部分**：不写方法，两个数字无从比较。 */
export const PEAK_RESOURCE_METHODS = Object.freeze({
  /** Windows：`Get-Process` 的 `WorkingSet64` / `PeakWorkingSet64` / `CPU`。 */
  WIN32_GET_PROCESS: 'win32-get-process',
  /** POSIX：`/proc/<pid>/status` 的 `VmHWM`/`VmRSS` + `/proc/<pid>/stat` 的 utime/stime。 */
  POSIX_PROC: 'posix-proc',
})

/** 采不到的**原因**，各自一个码。笼统一个 `FAILED` 会让五种修法看起来是同一种。 */
export const PEAK_RESOURCE_CODES = Object.freeze({
  /** 没给 pid，或给的不是正整数——**调用方接线错**，不是"进程没了"。 */
  NO_PID: 'PEAK_RESOURCE_NO_PID',
  /** 进程已经退出（或从来没有过）。 */
  PROCESS_GONE: 'PEAK_RESOURCE_PROCESS_GONE',
  /** 这个平台上本模块没有实现（既不是 win32 也不是有 /proc 的 posix）。 */
  UNSUPPORTED_PLATFORM: 'PEAK_RESOURCE_UNSUPPORTED_PLATFORM',
  /** 采样命令跑了但读数解析不出来——**不要**把这种当"采到了"。 */
  UNPARSEABLE: 'PEAK_RESOURCE_UNPARSEABLE',
  /** 采样本身抛了（权限、超时、解释器不在）。 */
  SAMPLE_FAILED: 'PEAK_RESOURCE_SAMPLE_FAILED',
})

/** `undefined`/`null`/非正整数一律不算 pid。`0` 在 win32 上是"系统空闲进程"，不是"没有"。 */
export function normalizePid(pid) {
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) return pid
  if (typeof pid === 'string' && /^\d+$/.test(pid.trim())) {
    const n = Number(pid.trim())
    return n > 0 ? n : null
  }
  return null
}

/**
 * 解析 `ConvertTo-Json` 出来的那个对象。
 *
 * ★ `PeakWorkingSet64` 在某些进程上是 `null`（PowerShell 拿不到时），
 *   所以三个字段**各自**判空：一个字段读不到不该让另外两个也变成"不知道"。
 */
export function parseWin32ProcessJson(stdout) {
  let j = null
  try { j = JSON.parse(String(stdout).trim()) } catch { return null }
  if (j === null || typeof j !== 'object') return null
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
  const workingSet = num(j.WorkingSet64)
  const peakWorkingSet = num(j.PeakWorkingSet64)
  const cpuSeconds = num(j.CPU)
  if (workingSet === null && peakWorkingSet === null && cpuSeconds === null) return null
  return Object.freeze({
    workingSetBytes: workingSet,
    peakWorkingSetBytes: peakWorkingSet,
    cpuMs: cpuSeconds === null ? null : Math.round(cpuSeconds * 1000),
  })
}

/** `/proc/<pid>/status` 里的 `VmHWM`（峰值 RSS）与 `VmRSS`。单位是 kB。 */
export function parseProcStatus(text) {
  const grab = (key) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(String(text))
    return m ? Number(m[1]) * 1024 : null
  }
  const peakRss = grab('VmHWM')
  const rss = grab('VmRSS')
  if (peakRss === null && rss === null) return null
  return Object.freeze({ rssBytes: rss, peakRssBytes: peakRss })
}

/**
 * `/proc/<pid>/stat` 的 utime/stime（第 14/15 字段，单位是时钟滴答）。
 *
 * ★ 第 2 字段是 `(comm)`，**里面可以有空格和括号**，所以按**最后一个 `)`**
 *   切分再数——按空格切会在进程名带空格时整体错位，而那会把 CPU 时间
 *   读成完全无关的一个数（`state`、`ppid`……）。错位不会报错。
 */
export function parseProcStat(text, { clockTicksPerSecond = 100 } = {}) {
  const s = String(text)
  const close = s.lastIndexOf(')')
  if (close < 0) return null
  const rest = s.slice(close + 1).trim().split(/\s+/)
  // rest[0] 是 state（原第 3 字段），所以 utime(14)/stime(15) 落在 rest[11]/rest[12]
  const utime = Number(rest[11])
  const stime = Number(rest[12])
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null
  const ticks = clockTicksPerSecond > 0 ? clockTicksPerSecond : 100
  return Object.freeze({ cpuMs: Math.round(((utime + stime) / ticks) * 1000) })
}

/** 真实系统 IO。测试全部注入替身，因此本模块**不需要**盘上真有一个进程就能被测完。 */
export function createSystemIo() {
  return Object.freeze({
    platform: process.platform,
    now: () => Date.now(),
    readFile: (p) => readFileSync(p, 'utf8'),
    exec: (file, args) => {
      try {
        const stdout = execFileSync(file, args, {
          encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
        })
        return { ok: true, stdout: stdout ?? '', error: null }
      } catch (e) {
        // 退出码非 0 是**正常路径**（进程没了），所以不抛，交给调用方判码。
        return { ok: false, stdout: e?.stdout ?? '', error: e }
      }
    },
  })
}

const PS_ARGS = (pid) => [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
  `$ErrorActionPreference='Stop';$p=Get-Process -Id ${pid} -ErrorAction Stop;` +
  `[pscustomobject]@{WorkingSet64=$p.WorkingSet64;PeakWorkingSet64=$p.PeakWorkingSet64;CPU=$p.CPU}` +
  '|ConvertTo-Json -Compress',
]

/**
 * 造一个采样器。它**不是定时器**：什么时候采由调用方决定
 * （Run 的起止在 worker 那侧，见本文件头那段"采的是哪个进程"）。
 *
 * @param {object} opts
 * @param {number|string} opts.pid 目标进程
 * @param {object} [opts.io] 注入的系统 IO
 * @param {string} [opts.platform] 默认取 `io.platform ?? process.platform`
 * @param {number} [opts.clockTicksPerSecond] POSIX CPU 换算用
 * @param {string} [opts.powershellPath] win32 上 PowerShell 的可执行文件名
 */
export function createPeakResourceSampler({
  pid,
  io = createSystemIo(),
  platform = io.platform ?? process.platform,
  clockTicksPerSecond = 100,
  powershellPath = 'powershell.exe',
} = {}) {
  const target = normalizePid(pid)
  const startedAtMs = io.now()
  let samples = 0
  let lastOkAtMs = null
  let lastCode = null
  let peakWorkingSetBytes = null
  let workingSetBytes = null
  let peakRssBytes = null
  let rssBytes = null
  let cpuMs = null

  const bump = (cur, next) => (next === null ? cur : cur === null ? next : Math.max(cur, next))

  function readOnce() {
    const sampledAtMs = io.now()
    const base = { pid: target, platform, sampledAtMs }
    if (target === null) {
      return Object.freeze({ ok: false, code: PEAK_RESOURCE_CODES.NO_PID, method: null, ...base })
    }
    const isWin = platform === 'win32'
    const isPosix = platform === 'linux' || platform === 'darwin' || platform === 'freebsd'
    if (!isWin && !isPosix) {
      return Object.freeze({
        ok: false, code: PEAK_RESOURCE_CODES.UNSUPPORTED_PLATFORM, method: null, ...base,
      })
    }
    try {
      if (isWin) {
        const r = io.exec(powershellPath, PS_ARGS(target))
        // 进程没了时 Get-Process 抛，PowerShell 退出码非 0、stdout 为空。
        // **空 stdout 与"读到全 null"是两件事**：前者是没读到，后者是读到了但字段空。
        if (!r.ok && String(r.stdout).trim() === '') {
          return Object.freeze({
            ok: false, code: PEAK_RESOURCE_CODES.PROCESS_GONE,
            method: PEAK_RESOURCE_METHODS.WIN32_GET_PROCESS, ...base,
          })
        }
        const parsed = parseWin32ProcessJson(r.stdout)
        if (parsed === null) {
          return Object.freeze({
            ok: false, code: PEAK_RESOURCE_CODES.UNPARSEABLE,
            method: PEAK_RESOURCE_METHODS.WIN32_GET_PROCESS, ...base,
          })
        }
        return Object.freeze({
          ok: true, code: null, method: PEAK_RESOURCE_METHODS.WIN32_GET_PROCESS,
          workingSetBytes: parsed.workingSetBytes,
          peakWorkingSetBytes: parsed.peakWorkingSetBytes,
          rssBytes: null, peakRssBytes: null,
          cpuMs: parsed.cpuMs,
          ...base,
        })
      }
      let status = null
      try { status = parseProcStatus(io.readFile(`/proc/${target}/status`)) } catch { status = null }
      if (status === null) {
        return Object.freeze({
          ok: false, code: PEAK_RESOURCE_CODES.PROCESS_GONE,
          method: PEAK_RESOURCE_METHODS.POSIX_PROC, ...base,
        })
      }
      let cpu = null
      try { cpu = parseProcStat(io.readFile(`/proc/${target}/stat`), { clockTicksPerSecond }) } catch { cpu = null }
      return Object.freeze({
        ok: true, code: null, method: PEAK_RESOURCE_METHODS.POSIX_PROC,
        workingSetBytes: null, peakWorkingSetBytes: null,
        rssBytes: status.rssBytes, peakRssBytes: status.peakRssBytes,
        cpuMs: cpu === null ? null : cpu.cpuMs,
        ...base,
      })
    } catch (e) {
      return Object.freeze({
        ok: false, code: PEAK_RESOURCE_CODES.SAMPLE_FAILED, method: null,
        error: String(e?.message ?? e), ...base,
      })
    }
  }

  /** 采一次并**并入窗口**。窗口里的每个分量各自取最大——读不到的那次不覆盖已有的读数。 */
  function sample() {
    const r = readOnce()
    samples += 1
    if (r.ok) {
      lastOkAtMs = r.sampledAtMs
      peakWorkingSetBytes = bump(peakWorkingSetBytes, r.peakWorkingSetBytes)
      workingSetBytes = bump(workingSetBytes, r.workingSetBytes)
      peakRssBytes = bump(peakRssBytes, r.peakRssBytes)
      rssBytes = bump(rssBytes, r.rssBytes)
      cpuMs = bump(cpuMs, r.cpuMs)
      lastCode = null
    } else {
      lastCode = r.code
    }
    return r
  }

  /**
   * 窗口读数。
   *
   * ★ `ok` 的含义是**采到过至少一次**，不是"最后一次成功"——
   *   一个在 Run 中途退出、但中途采到过峰值的进程，它的读数**仍然有效**，
   *   而 `lastCode` 同时说明它最后是以什么方式结束的。
   */
  function window() {
    return Object.freeze({
      ok: samples > 0 && peakWorkingSetBytes !== null || samples > 0 && peakRssBytes !== null,
      pid: target,
      platform,
      samples,
      startedAtMs,
      endedAtMs: io.now(),
      lastOkAtMs,
      lastCode,
      peakWorkingSetBytes,
      peakRssBytes,
      cpuMs,
    })
  }

  return Object.freeze({ pid: target, readOnce, sample, window })
}
