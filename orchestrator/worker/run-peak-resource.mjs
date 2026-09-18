// orchestrator/worker/run-peak-resource.mjs
// ============================================================================
// PRT-009 `peak-resource` 的**worker 侧**那一半：把「这次 Run 期间，那台真在
// 干活的 DSH Runtime 进程峰值用了多少内存/CPU」变成一条读数。
//
// ## 谁采样、采谁
//
// worker 进程与 DSH Runtime **不是同一个进程**（`runtime-contract-client.mjs:11-14`：
// 「`host` 端口只有 DSH Runtime 进程里有」），而 `orchestrator/worker/` 的生产
// 文件里 `spawn` 零命中。所以 worker 采不了"自己的子进程"——它要采的是**另一个
// 进程**，那个进程由 Launcher 起、由 Runtime 自己把 `pid / host / port` 发布到
// DataDir 下。
//
// Launcher 那一侧已经在采（`product/launcher/supervisor.mjs` 接的
// `peak-resource.mjs`），它给的是**进程整个生命周期**的峰值。本模块给的是
// **按 Run 切开的窗口**——同一台进程，不同的时间窗。
//
// ## 本模块最要紧的一件事：worker 的"身份判据"与 Launcher **相反**
//
// Launcher **知道** pid（它 spawn 的），所以它的判据是「发布里的 pid == 我起的那台」。
// 见 `product/launcher/runtime-contract-endpoint.mjs` 的 `readRuntimeContractEndpoint`
// （`expectedPid`）——它把不符的那份报成 `PUBLICATION_STALE`。
//
// worker **不知道** pid（它只拿到 `LEGION_RUNTIME_URL`）。它的判据只能是
// 「发布里的 `host`/`port` == 我正在调的那个端点」。
//
//   > 一个"照发布文件里的 pid 去采样"的实现，与一个"先确认这份发布说的是
//   > 我正在调的那台进程"的实现，在 Runtime 从不重启、也从不崩溃的部署里
//   > 是同一个东西——只不过前者的 pid 可能属于**上一次运行**留下的那份发布，
//   > 而那个 pid 早就被系统回收给了一个毫不相干的进程。
//
// 那不是"采到 0"或"采不到"，那是**采了一个别人的数**——最坏的一种。所以：
// host/port 对不上就具名拒绝，一个数都不采。
//
// ★ 为什么 Launcher 那份校验不能直接复用：它的 `expectedPid` 在 worker 这一侧
//   **没有来源**（这正是本模块要解决的问题）。传 `undefined` 进去它会报
//   `PUBLICATION_STALE`——那个码本身是对的读数（"我不知道它是不是我以为的那台"），
//   但它不是**可用的**读数。所以这里做的是逆运算，而不是抄一遍。
//
// ## 一条纪律：采样失败**永远不许**让一次 Run 失败
//
// 资源读数是可观测量，不是正确性条件。采样器抛错、进程已经没了、发布文件读不动
// ——这些都必须被收成一条**可见的**读数（或 `null`），而不是异常。
//
//   > 一个"因为采不到内存而把一次成功的 Run 判成失败"的接线，
//   > 与一个根本没有采样器的接线，在业务上是同一个结果——只不过前者的
//   > 失败出现在 1% 的机器上，而排障的人会去查业务代码。
//
// 与 `executor.mjs` 的 `onFloorNotice` 同一条口径：出口默认 `null`（"没有出口"
// 是一个可读的事实），而不是 `() => {}`（那会让"没接"与"接了但什么都不做"同形）。
// ============================================================================
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'

import { createPeakResourceSampler } from '../../product/launcher/peak-resource.mjs'
import {
  RUNTIME_CONTRACT_PUBLICATION_FIELDS,
  RUNTIME_CONTRACT_PUBLICATION_HOSTS,
  RUNTIME_CONTRACT_PUBLICATION_RELPATH_PARTS,
  RUNTIME_CONTRACT_PUBLICATION_VERSION,
} from '../../runtime/dsh-composition/runtime-contract-publication.mjs'
import { RUNTIME_CONTRACT_WIRE_VERSION } from '../../runtime/contracts/wire.mjs'

/** 采不到 / 对不上时的**具名码**。笼统一个 `FAILED` 会让五种修法看起来是同一种。 */
export const RUN_PEAK_CODES = Object.freeze({
  /** 没有 `LEGION_DATA_DIR`：不知道发布文件在哪。**不猜路径。** */
  NO_DATA_DIR: 'RUN_PEAK_NO_DATA_DIR',
  /** `LEGION_RUNTIME_URL` 缺失或解析不出 host/port。 */
  BAD_RUNTIME_URL: 'RUN_PEAK_BAD_RUNTIME_URL',
  /** 发布文件不在：Runtime 那一行没挂上，或它没拿到 DataDir。 */
  PUBLICATION_ABSENT: 'RUN_PEAK_PUBLICATION_ABSENT',
  /** 发布文件在、但读不动（权限/盘）。**与"不在"修法不同。** */
  PUBLICATION_UNREADABLE: 'RUN_PEAK_PUBLICATION_UNREADABLE',
  /** 内容不是合法 JSON，或字段形状不对。 */
  PUBLICATION_INVALID: 'RUN_PEAK_PUBLICATION_INVALID',
  /** ★ 发布说的是**另一台**进程（host/port 与我在调的端点不符）。 */
  PUBLICATION_FOREIGN: 'RUN_PEAK_PUBLICATION_FOREIGN',
})

/**
 * 默认采样周期。与 `supervisor.mjs` 的 `DEFAULT_PEAK_SAMPLE_MS` 取同一个数，
 * 理由也同一个：win32 上采一次要起一个 PowerShell，周期太短会让采样器
 * 自己变成被测对象。
 */
export const DEFAULT_RUN_PEAK_SAMPLE_MS = 5000

/**
 * 从一个 URL 里取出 `{host, port}`。
 *
 * ★ 两条都是被用例咬出来的（第一版两条都错）：
 *
 * ① **IPv6 的方括号**：`new URL('http://[::1]:1234').hostname` 给的是 `[::1]`
 *    （**带方括号**），而发布文件里的 host 是 `::1`。不归一化就会把一台**正常的**
 *    IPv6 runtime 判成 `PUBLICATION_FOREIGN`——一个只在 IPv6 机器上出现的假红。
 *
 * ② **默认端口**：WHATWG 的 `URL` 会把**默认端口规范化掉**——
 *    `new URL('http://localhost:80').port` 是**空串**，`'https://x:443'` 同理。
 *    第一版把空串一律当"没有端口"⇒返回 `null`，理由写的是"不能猜 80"。
 *    那个理由是错的：`http` 的 80 与 `https` 的 443 **不是猜的，是协议默认值**。
 *    于是 `http://localhost` 这个**完全可解析**的端点会被报成 `BAD_RUNTIME_URL`
 *    ——把"我认不出这个 URL"与"它没有端口"压成同一个读数。
 *
 *    对一个**不认识**的协议才该拒绝（那时默认端口确实是猜的）。
 *
 *    规则因此收敛成一句：**契约只说 http(s)**。别的协议一律拒绝，
 *    哪怕它明写了端口——`ftp://127.0.0.1:4567` 这个端点本身是明确的，
 *    但"用 ftp 去调 Runtime 契约"是一次接线错误，把它当成一个可用端点
 *    会让错误延后到真正发起请求时才暴露，而那时报的是网络故障。
 */
export function parseRuntimeEndpoint(runtimeUrl) {
  if (typeof runtimeUrl !== 'string' || runtimeUrl.trim() === '') return null
  let u
  try {
    u = new URL(runtimeUrl.trim())
  } catch {
    return null
  }
  /** 协议默认端口。**只有这两个协议认识**，别的协议一律拒绝而不是猜一个。 */
  const defaultPorts = { 'http:': 80, 'https:': 443 }
  if (!Object.prototype.hasOwnProperty.call(defaultPorts, u.protocol)) return null
  const port = u.port === '' ? defaultPorts[u.protocol] : Number(u.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  const host = u.hostname.startsWith('[') && u.hostname.endsWith(']')
    ? u.hostname.slice(1, -1)
    : u.hostname
  if (host === '') return null
  return Object.freeze({ host, port })
}

/** 发布文件在 DataDir 下的绝对路径；DataDir 不可用时 `null`。 */
export function runPeakPublicationPath(dataDir, { joinImpl = null } = {}) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') return null
  const join = joinImpl ?? joinPath
  return join(dataDir, ...RUNTIME_CONTRACT_PUBLICATION_RELPATH_PARTS)
}

/**
 * 读并**只做形状校验**发布文件。
 *
 * 身份校验不在这里（它需要调用方知道"我在调哪个端点"），见
 * `resolveRuntimePidForSampling`。分开的原因：一个形状就坏掉的文件，
 * 即使 host/port 恰好相符也不能用；反过来则会把"文件坏了"报成"进程换了"。
 * 这与 Launcher 那份 reader 的顺序（先形状、后身份）是同一条理由。
 */
export function readRuntimePublication({ dataDir, fs = null, joinImpl = null } = {}) {
  const path = runPeakPublicationPath(dataDir, { joinImpl })
  if (path === null) {
    return Object.freeze({
      ok: false,
      code: RUN_PEAK_CODES.NO_DATA_DIR,
      message: `没有可用的 DataDir（收到 ${dataDir === null ? 'null' : typeof dataDir}）：`
        + '不知道 Runtime 把端点发布在哪里。**不猜一个路径**——猜出来的路径读不到东西时，'
        + '会被报成"Runtime 没发布"，而真因是我们在错的地方找',
      path: null,
    })
  }
  const read = fs?.readFileSync ?? readFileSync
  let text
  try {
    text = read(path, 'utf8')
  } catch (e) {
    if (e?.code === 'ENOENT') {
      return Object.freeze({
        ok: false,
        code: RUN_PEAK_CODES.PUBLICATION_ABSENT,
        message: `Runtime 进程没有发布契约端点（${path} 不存在）。这次 Run 的资源读数**没有来源**`,
        path,
      })
    }
    return Object.freeze({
      ok: false,
      code: RUN_PEAK_CODES.PUBLICATION_UNREADABLE,
      message: `读端口发布失败（${e?.code ?? e?.name ?? 'Error'}）：${e?.message ?? String(e)}`,
      path,
    })
  }

  let record
  try {
    record = JSON.parse(text)
  } catch (e) {
    return Object.freeze({
      ok: false,
      code: RUN_PEAK_CODES.PUBLICATION_INVALID,
      message: `端口发布不是合法 JSON：${e?.message ?? String(e)}`,
      path,
    })
  }

  const problems = []
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    problems.push(`顶层是 ${record === null ? 'null' : Array.isArray(record) ? 'array' : typeof record}`)
  } else {
    if (record.version !== RUNTIME_CONTRACT_PUBLICATION_VERSION) {
      problems.push(`version=${JSON.stringify(record.version)}（期望 ${RUNTIME_CONTRACT_PUBLICATION_VERSION}）`)
    }
    // ★ pid 就是**消费侧唯一的陈旧判据**（发布方的原话）。它必须是正整数——
    //   少了这一条，`record.pid` 可能是 `undefined`，而 `undefined` 传给
    //   `Get-Process -Id undefined` 会得到一个**语法错误**，那不是"采不到"。
    if (!Number.isInteger(record.pid) || record.pid <= 0) problems.push(`pid=${JSON.stringify(record.pid)}`)
    if (typeof record.host !== 'string' || !RUNTIME_CONTRACT_PUBLICATION_HOSTS.includes(record.host)) {
      problems.push(`host=${JSON.stringify(record.host)}（只允许 ${RUNTIME_CONTRACT_PUBLICATION_HOSTS.join(' / ')}）`)
    }
    if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535) {
      problems.push(`port=${JSON.stringify(record.port)}`)
    }
    // ★ wireVersion 也要查。Launcher 那份 reader 查它，而**我第一版漏了**——
    //   是上面那条"坏 JSON / 坏字段"的用例把我咬住的（`wireVersion: 2` 本该被拒）。
    //   一份线路版本不同的发布说明写它的 Runtime 与我们协议不同，
    //   照它去采 pid 会把"协议漂移"读成一次正常采样。
    if (record.wireVersion !== RUNTIME_CONTRACT_WIRE_VERSION) {
      problems.push(`wireVersion=${JSON.stringify(record.wireVersion)}（期望 ${RUNTIME_CONTRACT_WIRE_VERSION}）`)
    }
    // ★ 未知字段要拒：发布文件是**跨进程契约**，多出字段说明写它的不是我们
    //   认识的那个版本。忽略它等于把一个版本漂移读成一次正常发布。
    for (const k of Object.keys(record)) {
      if (!RUNTIME_CONTRACT_PUBLICATION_FIELDS.includes(k)) problems.push(`未知字段 ${JSON.stringify(k)}`)
    }
  }
  if (problems.length > 0) {
    return Object.freeze({
      ok: false,
      code: RUN_PEAK_CODES.PUBLICATION_INVALID,
      message: `端口发布的内容不合法：${problems.join('；')}。**不回落成"文件在就用"**：`
        + '一份读得出来但内容不对的发布，比没有发布更危险',
      path,
    })
  }
  return Object.freeze({ ok: true, code: null, message: null, path, record })
}

/**
 * 得出「这次 Run 该采哪个 pid」——**先认端点，再信 pid**。
 *
 * @returns `{ok:true, pid, host, port, path}` 或 `{ok:false, code, message, path}`
 */
export function resolveRuntimePidForSampling({ dataDir, runtimeUrl, fs = null, joinImpl = null } = {}) {
  const endpoint = parseRuntimeEndpoint(runtimeUrl)
  if (endpoint === null) {
    return Object.freeze({
      ok: false,
      code: RUN_PEAK_CODES.BAD_RUNTIME_URL,
      message: `LEGION_RUNTIME_URL 缺失或解析不出 host/port（收到 ${JSON.stringify(runtimeUrl)}）：`
        + '没有端点就无从判断一份发布说的是不是"我正在调的那台"',
      path: null,
    })
  }
  const pub = readRuntimePublication({ dataDir, fs, joinImpl })
  if (!pub.ok) return Object.freeze({ ok: false, code: pub.code, message: pub.message, path: pub.path })

  const { record } = pub
  if (record.host !== endpoint.host || record.port !== endpoint.port) {
    return Object.freeze({
      ok: false,
      code: RUN_PEAK_CODES.PUBLICATION_FOREIGN,
      message: `端口发布说的不是本次要调的那台进程：发布 host:port=${record.host}:${record.port}`
        + `（pid=${record.pid}），而我在调 ${endpoint.host}:${endpoint.port}。`
        + '**一个数都不采**——照着一份对不上的发布去采 pid，采到的可能是上一次运行'
        + '留下的那个 pid，而它早被系统回收给了别的进程',
      path: pub.path,
    })
  }
  return Object.freeze({
    ok: true,
    code: null,
    message: null,
    pid: record.pid,
    host: record.host,
    port: record.port,
    path: pub.path,
  })
}

/**
 * 本模块读的两个环境键。**它们已经登记在 `orchestrator/config-schema.mjs` 里**
 * （`LEGION_DATA_DIR` / `LEGION_RUNTIME_URL` 都是 worker 既有的配置面）。
 *
 * ★ 为什么读 env 这件事必须留在**本文件**里，而不是由产品入口传进来：
 *   `product/` 有自己的一份 config-schema，而 `LEGION_RUNTIME_URL` **不在**其中
 *   （它归 orchestrator 进程）。在产品入口里读它，`topology-inventory --diff`
 *   会报 `product.envReadKeys += LEGION_RUNTIME_URL`——那条门禁是对的：
 *   一个在 product 进程里被读、却没在 product 的配置面里声明的键，
 *   在"这个产品认哪些环境变量"这件事上是一个缺口。
 */
export const RUN_PEAK_ENV = Object.freeze({
  DATA_DIR: 'LEGION_DATA_DIR',
  RUNTIME_URL: 'LEGION_RUNTIME_URL',
})

/**
 * 从**进程环境**解析出该采哪个 pid。
 *
 * 与 `orchestrator/worker/run.mjs` 的 `readWorkerEnv(env = process.env)` 同一个形状：
 * 默认读 `process.env`，但允许调用方注入，于是它不需要真环境就能被测到。
 */
export function resolveRuntimePidFromEnv(env = process.env, { fs = null, joinImpl = null } = {}) {
  return resolveRuntimePidForSampling({
    dataDir: env?.[RUN_PEAK_ENV.DATA_DIR] ?? null,
    runtimeUrl: env?.[RUN_PEAK_ENV.RUNTIME_URL] ?? null,
    fs,
    joinImpl,
  })
}

/**
 * 用一个**按 Run 开合的采样窗口**包住执行引擎。
 *
 * 只在 `onReading` 是函数时包：没有出口的采样与不采样是同一个结果，
 * 而"接了但没人读"会让接线看起来是通的。
 *
 * @param {object} executor 原执行引擎（要有 `execute`）
 * @param {object} opts
 * @param {Function} opts.onReading  窗口收口时被调：`(reading, context) => void`
 * @param {Function} opts.resolvePid 返回 `resolveRuntimePidForSampling` 那种结果
 * @param {number} [opts.sampleMs]
 * @param {Function} [opts.createSampler]
 * @param {Function} [opts.setIntervalImpl]
 * @param {Function} [opts.clearIntervalImpl]
 * @param {Function} [opts.logger] 采样本身的问题走这里，**不走异常**
 */
export function withRunPeakResource(executor, {
  onReading,
  resolvePid,
  sampleMs = DEFAULT_RUN_PEAK_SAMPLE_MS,
  createSampler = createPeakResourceSampler,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  logger = null,
} = {}) {
  if (typeof onReading !== 'function') return executor
  if (executor === null || typeof executor !== 'object' || typeof executor.execute !== 'function') {
    return executor
  }
  if (typeof resolvePid !== 'function') return executor

  const note = (message) => { if (typeof logger === 'function') logger(message) }

  function openWindow() {
    // ★ 解析失败**不是**这次 Run 的错误，是一条读数。
    const resolved = resolvePid()
    if (resolved === null || resolved.ok !== true) {
      // ★ 用 `'(无码)'` 而不是编一个像码的字符串：那个占位符会进日志、
      //   看起来像一条可检索的具名码，而它在任何注册表里都不存在——
      //   "一个没人登记过的码"与"一个真码"在下一次有人按码排查时是两件事。
      note(`[peak-resource] 这次 Run 采不到：${resolved?.code ?? '(无码)'} —— ${resolved?.message ?? ''}`)
      return null
    }
    if (!(sampleMs > 0)) return null
    let sampler
    try {
      sampler = createSampler({ pid: resolved.pid })
      // 先采一次：只靠定时器的话，一个活不过一个周期的 Run 会连一个读数都没有。
      sampler.sample()
    } catch (e) {
      note(`[peak-resource] 采样器构造/首次采样抛错（已吞，不影响 Run）：${e?.message ?? e}`)
      return null
    }
    const timer = setIntervalImpl(() => {
      try { sampler.sample() } catch (e) { note(`[peak-resource] 采样抛错（已吞）：${e?.message ?? e}`) }
    }, sampleMs)
    if (timer !== null && typeof timer.unref === 'function') timer.unref()
    return { sampler, timer, resolved }
  }

  function closeWindow(session) {
    if (session === null) return
    if (session.timer !== null) {
      try { clearIntervalImpl(session.timer) } catch { /* 尽力而为 */ }
    }
    let reading = null
    try {
      reading = session.sampler.window()
    } catch (e) {
      note(`[peak-resource] 收口读数抛错（已吞）：${e?.message ?? e}`)
    }
    try {
      onReading(reading, Object.freeze({
        pid: session.resolved.pid,
        host: session.resolved.host,
        port: session.resolved.port,
        publicationPath: session.resolved.path,
      }))
    } catch (e) {
      // 出口自己坏了也不许把一次已经跑完的 Run 变成失败。
      note(`[peak-resource] 读数出口抛错（已吞，不影响 Run）：${e?.message ?? e}`)
    }
  }

  const wrapped = {
    ...executor,
    async execute(...args) {
      let session = null
      try {
        session = openWindow()
      } catch (e) {
        // openWindow 内部已经尽力了；这一层是"连它自己都坏了"的兜底。
        note(`[peak-resource] 开窗口抛错（已吞，不影响 Run）：${e?.message ?? e}`)
        session = null
      }
      try {
        return await executor.execute(...args)
      } finally {
        try {
          closeWindow(session)
        } catch (e) {
          note(`[peak-resource] 关窗口抛错（已吞）：${e?.message ?? e}`)
        }
      }
    },
  }
  return Object.freeze(wrapped)
}
