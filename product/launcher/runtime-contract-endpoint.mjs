// product/launcher/runtime-contract-endpoint.mjs
// ============================================================================
// Runtime Contract 的**消费侧**：端点从哪里读、凭证怎么来（PRT-253 续批四）
//
// ## 它补的是哪一截
//
// `orchestrator/worker/executor-binding.mjs` 已经能从**环境**读两样东西：
//
//   `LEGION_RUNTIME_URL`   —— Runtime 进程里那台契约监听器在哪
//   `LEGION_RUNTIME_TOKEN` —— 与那台进程约定的凭证
//
// 而在此之前**没有任何东西往 worker 的环境里放这两项**：
// `product/launcher/allowlist.mjs` 的白名单只放行进程清单声明过的键，
// 所以在一个由 Launcher 启动的真实部署里它们会被丢掉，
// worker 永远报 `EXECUTOR_HOST_PORT_REQUIRED`。
//
//   > 一个"消费方会读、而没有任何生产方会写"的环境变量，
//   > 与一个不存在的环境变量，在部署上是同一个东西。
//
// 本模块是那条生产方，分两件事：
//
//   ① **端口**：Runtime 进程里那一行绑的是**临时端口**（`port: 0`）。
//      谁都不知道它会分到哪个，所以由那一行把实际端口发布到 DataDir 下，
//      由这里读回并校验。详见 `runtime/dsh-composition/runtime-contract-publication.mjs`
//      的文件头（那里写了"为什么不是 Launcher 先分配一个再传进去"）。
//
//   ② **凭证**：由 Launcher **每次启动生成一次**，只注入 runtime 与
//      orchestrator 两个子进程。理由写在 `generateRuntimeToken` 上。
//
// ## 依赖方向：**本模块不 import `runtime/dsh-composition/`**
//
// 那份发布格式在这里是**第二份副本**（相对路径片段、版本号、字段清单）。
// 这不是省事，是既有的依赖方向：`runtime/dsh-composition/` 才 import
// `product/`，反过来会把 DSH 组合层与 Launcher 缠在一起
// （同一条取舍见 `dsh-overlay.mjs` 顶部那段与 `enforcement-identity.mjs`
// 的 `ENFORCEMENT_IDENTITY_ENV`）。
//
// 两份副本之间由 `runtime-contract-endpoint.test.mjs` 的【逐段对账】用例钉住：
// 版本、相对路径片段、字段清单三样都要相等。
//
//   > 一份"读侧与写侧各写一遍格式、而没有判据说它们相同"的协议，
//   > 与一份"读侧读错了字段"的协议，在第一次跑之前是同一种东西——
//   > 只不过前者的代码看起来是通的。
//
// ## 三条纪律（都对应一条**具名**拒绝）
//
//   1. **不编 URL**：读不到、读不懂、读到的不是本次那个进程写的，
//      一律具名拒绝，绝不回落成 `http://127.0.0.1:3080` 这类默认值。
//   2. **不编凭证**：生成失败就不注入（于是对端以 `..._NO_TOKEN` 拒绝），
//      绝不注入空串、也绝不"关掉鉴权"。
//   3. **值不进任何可读输出**：token 只经环境变量传递；本模块的返回值里
//      只有 `{ok, token}`，而调用方（Launcher）把它掩码后再对外暴露。
// ============================================================================

import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'

import { pathApi } from '../paths.mjs'
import { LOOPBACK_HOSTS } from '../process-manifest.mjs'

/**
 * 端点模块的接口版本（码集 / 函数签名变化时递增）。
 * 它是**本模块自己的**版本，与线上协议版本（`wireVersion`）无关。
 */
export const RUNTIME_CONTRACT_ENDPOINT_VERSION = 1

/**
 * 发布文件的格式版本。★ 必须与
 * `runtime/dsh-composition/runtime-contract-publication.mjs` 的
 * `RUNTIME_CONTRACT_PUBLICATION_VERSION` 逐字相同——由用例钉住。
 */
export const RUNTIME_CONTRACT_PUBLICATION_VERSION = 1

/**
 * 发布文件在 DataDir 下的相对路径片段。★ 与 runtime 侧那份逐段对账。
 *
 * 逐段而不是整串：漂移时用例能指出**是哪一段**漂了（`runtime/` 与文件名
 * 是两件事，一个负责"哪个进程的目录约定"，一个负责"哪一份文件"）。
 */
export const RUNTIME_CONTRACT_PUBLICATION_RELPATH_PARTS = Object.freeze(['runtime', 'runtime-contract.json'])

/** 同一份事实的字符串形式。 */
export const RUNTIME_CONTRACT_PUBLICATION_RELPATH = RUNTIME_CONTRACT_PUBLICATION_RELPATH_PARTS.join('/')

/** 发布记录里必须出现的字段。★ 与 runtime 侧那份逐字对账。 */
export const RUNTIME_CONTRACT_PUBLICATION_FIELDS = Object.freeze([
  'version', 'pid', 'host', 'port', 'wireVersion',
])

/**
 * 本模块认得的线上协议版本。
 *
 * 写侧发布的是它自己那一份 `RUNTIME_CONTRACT_WIRE_VERSION`（来自
 * `runtime/contracts/wire.mjs`）。这里**不猜**：对不上的发布一律
 * `PUBLICATION_INVALID`——一个"协议版本对不上但端口能用"的端点，
 * 会让 worker 按另一版协议说话，而失败会发生在每一次请求的解析里。
 * 用例把本常量与 `wire.mjs` 的那个值钉住相等。
 */
export const RUNTIME_CONTRACT_WIRE_VERSION_EXPECTED = 1

/** 生成的凭证字节数（base64url 之后 43 个字符）。 */
export const RUNTIME_CONTRACT_TOKEN_BYTES = 32

/** 本模块的具名码。**逐条可分**——每一条的下一步动作都不一样。 */
export const RUNTIME_CONTRACT_ENDPOINT_CODES = Object.freeze({
  /** 生不出凭证（随机源不可用 / 返回值不可用）。**fail closed：不注入任何 token**。 */
  TOKEN_GENERATION_FAILED: 'RUNTIME_CONTRACT_TOKEN_GENERATION_FAILED',
  /** 没有 DataDir：连发布文件该在哪都不知道。**不猜路径**。 */
  PUBLICATION_PATH_UNAVAILABLE: 'RUNTIME_CONTRACT_PUBLICATION_PATH_UNAVAILABLE',
  /** 发布文件不在。**最多见的一种**：Runtime 那一行没挂 / 没发布 / 还没发布。 */
  PUBLICATION_ABSENT: 'RUNTIME_CONTRACT_PUBLICATION_ABSENT',
  /** 文件在，但读不出来或不是 JSON。**与"不在"必须分开**：一个是没写，一个是写坏了。 */
  PUBLICATION_UNREADABLE: 'RUNTIME_CONTRACT_PUBLICATION_UNREADABLE',
  /** 文件读得出来，但内容不合法（版本/字段/取值域不对）。 */
  PUBLICATION_INVALID: 'RUNTIME_CONTRACT_PUBLICATION_INVALID',
  /** 文件合法，但它描述的**不是本次启动的那个 Runtime 进程**（pid 不符）。 */
  PUBLICATION_STALE: 'RUNTIME_CONTRACT_PUBLICATION_STALE',
  /** 清理上一次留下的发布失败。它不是致命的（pid 判定仍在），但必须可见。 */
  PUBLICATION_CLEAR_FAILED: 'RUNTIME_CONTRACT_PUBLICATION_CLEAR_FAILED',
})

/**
 * 哪些拒绝值得**继续等**。
 *
 * 这个集合的判据是"再等一会儿它有没有可能变成我要的东西"：
 *   · `ABSENT` —— Runtime 那一行还在跟别的行并发地起（Loader 并发建行），
 *     发布随时可能出现。**必须等**，否则一次正常的启动会被报成缺发布。
 *   · `UNREADABLE` / `INVALID` / `STALE` —— 看起来像"永久坏了"，但都能是
 *     **上一个进程留下的旧文件**：新进程覆盖它之前，我们读到的就是旧的。
 *     所以也要等（等到本次那个 pid 的那一份出现为止）。
 *   · `PATH_UNAVAILABLE` —— DataDir 不会自己冒出来。等没有意义。
 */
export const RUNTIME_CONTRACT_RETRYABLE_CODES = Object.freeze([
  RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_ABSENT,
  RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_UNREADABLE,
  RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_INVALID,
  RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_STALE,
])

const defaultFs = Object.freeze({
  readFileSync: (p, enc) => readFileSync(p, enc),
  rmSync: (p, o) => rmSync(p, o),
})

function refusal(code, message, reasons = [], extra = {}) {
  return Object.freeze({
    ok: false, code, message, reasons: Object.freeze([...reasons]), ...extra,
  })
}

/** 发布文件在本机文件系统上的绝对路径；`dataDir` 不可用时返回 `null`。 */
export function runtimeContractEndpointPath(dataDir, platform = process.platform) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') return null
  return pathApi(platform).join(dataDir, ...RUNTIME_CONTRACT_PUBLICATION_RELPATH_PARTS)
}

/**
 * **每次启动生成一份**运行时凭证。
 *
 * ## 为什么是"每次启动"而不是"一个仓库里的常量"
 *
 *   · 一个提交进仓库的常量会让**任何**拿到那份源码的进程都能调用执行面，
 *     而"谁能调用执行面"正是这条边界要守住的东西；
 *   · 一个跨启动复用的常量会在进程被替换之后继续有效——那时它保护的是
 *     一个已经不存在的会话。
 *
 * 生成者是 **Launcher**：它是唯一同时看得到 runtime 与 orchestrator 两个
 * 子进程的地方（`buildChildEnv` 的白名单注入是它独占的能力），
 * 也是唯一能把同一份值只交给这两个进程的地方。
 *
 * ## 失败必须 fail closed
 *
 * 随机源坏了的时候**没有任何东西**可以补：不注入空串（会被服务端读成
 * "没配"从而拒绝，但那条拒绝离真因很远）、不注入默认值（那就等于没有鉴权）。
 * 返回具名码，调用方据此不注入，并让"这次运行没有凭证"留在诊断里。
 * 于是对端的读数是 `..._NO_TOKEN`（"这台机器没配"），
 * 与 `..._UNAUTHORIZED`（"你给的凭证不对"）仍然分得开。
 *
 * @param {object} [input]
 * @param {(n:number)=>any} [input.randomBytesImpl] 注入随机源（用例要验失败路径）
 * @returns {{ok:true, token:string}|{ok:false, code:string, message:string, reasons:string[]}}
 */
export function generateRuntimeToken({ randomBytesImpl = randomBytes } = {}) {
  try {
    const buf = randomBytesImpl(RUNTIME_CONTRACT_TOKEN_BYTES)
    if (buf === null || buf === undefined || typeof buf.toString !== 'function') {
      throw new TypeError(`随机源返回了 ${buf === null ? 'null' : typeof buf}，而不是字节缓冲`)
    }
    const token = buf.toString('base64url')
    if (typeof token !== 'string' || token.length < RUNTIME_CONTRACT_TOKEN_BYTES || /\s/.test(token)) {
      throw new TypeError(`随机源产出的凭证不可用（长度 ${typeof token === 'string' ? token.length : 'n/a'}）`)
    }
    return Object.freeze({ ok: true, code: null, message: null, reasons: Object.freeze([]), token })
  } catch (e) {
    return refusal(
      RUNTIME_CONTRACT_ENDPOINT_CODES.TOKEN_GENERATION_FAILED,
      `生成运行时凭证失败（${e?.name ?? 'Error'}）：${e?.message ?? String(e)}`,
      [
        '**不注入任何凭证**（不写空串、不写默认值、不"关掉鉴权"）',
        '对端会以 RUNTIME_CONTRACT_NO_TOKEN 拒绝需要鉴权的操作——那是"没配"，不是"配对了"',
      ],
    )
  }
}

/**
 * 读回并校验 Runtime 进程发布的端点。
 *
 * 校验顺序**刻意**是"先形状、后身份"：一个形状非法的文件即使 pid 恰好
 * 相同也不能用，反过来则会把"文件坏了"报成"进程变了"。
 *
 * @param {object} input
 * @param {string} input.dataDir
 * @param {number|undefined} input.expectedPid 本次启动的 runtime 子进程 pid
 * @param {object} [input.fs] 注入 `{readFileSync, rmSync}`（用例不需要真磁盘）
 * @param {string} [input.platform]
 */
export function readRuntimeContractEndpoint({ dataDir, expectedPid, fs = null, platform = process.platform } = {}) {
  const io = fs ?? defaultFs
  const path = runtimeContractEndpointPath(dataDir, platform)
  if (path === null) {
    return refusal(
      RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_PATH_UNAVAILABLE,
      `没有可用的 DataDir（收到 ${dataDir === null ? 'null' : typeof dataDir}）：` +
      '不知道 Runtime 把端口发布在哪里。**不猜一个路径**——猜出来的路径读不到东西时，' +
      '会被报成"Runtime 没发布"，而真因是我们在错的地方找',
      ['把布局里的 dataDir 传进来（Launcher 是唯一知道它的那一侧）'],
    )
  }

  let text
  try {
    text = io.readFileSync(path, 'utf8')
  } catch (e) {
    if (e?.code === 'ENOENT') {
      return refusal(
        RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_ABSENT,
        `Runtime 进程没有发布契约端口（${path} 不存在）。` +
        '**不编一个 URL**：一个猜出来的地址会让"引擎在哪里"变成一个我们其实不知道的答案',
        [
          'Runtime 进程里要挂上契约服务端那一行（它绑定成功后才会发布）',
          '发布只在 `listen()` 成功之后写，所以「有发布、但那个端口没人听」**不会**发生；' +
          '反过来不成立——一台没拿到 `dataDir` 的监听器**在听但发布不出来**' +
          '（那一侧的具名读数是 RUNTIME_CONTRACT_ROW_NO_PUBLICATION_DIR，与"那一行没挂上"是两件事）',
        ],
        { path },
      )
    }
    return refusal(
      RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_UNREADABLE,
      `读端口发布失败（${e?.code ?? e?.name ?? 'Error'}）：${e?.message ?? String(e)}`,
      ['**与"文件不在"不同**：文件在而读不了，要去看权限/盘/路径，不是去看那一行挂没挂'],
      { path },
    )
  }

  let record
  try {
    record = JSON.parse(text)
  } catch (e) {
    return refusal(
      RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_UNREADABLE,
      `端口发布不是合法 JSON：${e?.message ?? String(e)}`,
      ['**与"文件不在"不同**：写坏了与没写过，修法不同（一个去查写入方，一个去查那一行）'],
      { path },
    )
  }

  const problems = []
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    problems.push(`顶层是 ${record === null ? 'null' : Array.isArray(record) ? 'array' : typeof record}`)
  } else {
    if (record.version !== RUNTIME_CONTRACT_PUBLICATION_VERSION) {
      problems.push(`version=${JSON.stringify(record.version)}（期望 ${RUNTIME_CONTRACT_PUBLICATION_VERSION}）`)
    }
    if (!Number.isInteger(record.pid) || record.pid <= 0) problems.push(`pid=${JSON.stringify(record.pid)}`)
    if (typeof record.host !== 'string' || !LOOPBACK_HOSTS.includes(record.host)) {
      problems.push(`host=${JSON.stringify(record.host)}（只允许 ${LOOPBACK_HOSTS.join(' / ')}）`)
    }
    if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535) {
      problems.push(`port=${JSON.stringify(record.port)}`)
    }
    if (record.wireVersion !== RUNTIME_CONTRACT_WIRE_VERSION_EXPECTED) {
      problems.push(`wireVersion=${JSON.stringify(record.wireVersion)}（期望 ${RUNTIME_CONTRACT_WIRE_VERSION_EXPECTED}）`)
    }
  }
  if (problems.length > 0) {
    return refusal(
      RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_INVALID,
      `端口发布的内容不合法：${problems.join('；')}`,
      ['**不回落成"文件在就用"**：一份读得出来但内容不对的发布，比没有发布更危险'],
      { path, problems: Object.freeze(problems) },
    )
  }

  if (record.pid !== expectedPid) {
    return refusal(
      RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_STALE,
      `端口发布不是本次 Runtime 进程写的：发布里的 pid=${record.pid}，` +
      `本次启动的 runtime 子进程 pid=${expectedPid === undefined ? '未提供' : expectedPid}。` +
      '它的含义是**上一次运行（或另一个 Runtime 进程）留下的**，端口早已不属于那个进程',
      [
        'Launcher 在 spawn Runtime 之前会先清一次；清完之后仍然对不上，说明有第二个进程在写同一个 DataDir',
        '**不采用它**：照着一个陈旧的端口去连，可能连上另一台引擎',
      ],
      { path, publishedPid: record.pid, expectedPid: expectedPid ?? null },
    )
  }

  // 回环地址里的 IPv6 字面量在 URL 里必须加方括号，否则 `http://::1:1234` 不成立。
  const hostForUrl = record.host === '::1' ? '[::1]' : record.host
  return Object.freeze({
    ok: true,
    code: null,
    message: null,
    reasons: Object.freeze([]),
    url: `http://${hostForUrl}:${record.port}`,
    host: record.host,
    port: record.port,
    pid: record.pid,
    wireVersion: record.wireVersion,
    path,
  })
}

/**
 * 等一份**属于本次那个进程**的发布出现。
 *
 * 为什么必须等而不是读一次：DSH 的 Loader 用
 * `Promise.allSettled(config.map(create))` **并发**创建补丁行，因此
 * "Runtime 进程的就绪"/"orchestrator 那一波开始"与"契约那一行绑好端口"
 * 之间没有顺序保证——读一次会把一次正常的启动报成缺发布。
 *
 * 超时之后返回的是**最后一次**的拒绝（不是合成一个新码）：
 *   · 一直没出现过 → `PUBLICATION_ABSENT`（它就是"没人发布"的准确读数）；
 *   · 一直是旧进程那一份 → `PUBLICATION_STALE`（"有东西在写，但不是本次那个"）。
 * 合成一个 `..._TIMEOUT` 会把这两种修法完全不同的处境压成一个。
 */
export async function waitForRuntimeContractEndpoint({
  dataDir,
  expectedPid,
  timeoutMs = 5000,
  intervalMs = 50,
  fs = null,
  platform = process.platform,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const beganAt = now()
  let attempts = 0
  let last = null
  for (;;) {
    attempts += 1
    const r = readRuntimeContractEndpoint({ dataDir, expectedPid, fs, platform })
    if (r.ok === true) {
      return Object.freeze({ ...r, attempts, waitedMs: now() - beganAt })
    }
    last = r
    if (!RUNTIME_CONTRACT_RETRYABLE_CODES.includes(r.code)) {
      return Object.freeze({ ...r, attempts, waitedMs: now() - beganAt })
    }
    if (now() - beganAt >= timeoutMs) {
      return Object.freeze({
        ...r,
        attempts,
        waitedMs: now() - beganAt,
        message: `${r.message}（等待 ${timeoutMs}ms、读了 ${attempts} 次仍未出现）`,
      })
    }
    await sleep(intervalMs)
  }
}

/**
 * 把一次端点拒绝转成 Launcher 的诊断。
 *
 * 只在**拒绝**时使用（成功不发诊断：一条"没事"的诊断会稀释真正的告警）。
 *
 * `process: 'orchestrator'` 是**刻意的**：这条缺口的后果落在 worker 身上
 * （它拿不到端点，于是报 `EXECUTOR_HOST_PORT_REQUIRED`），
 * 而"该去看哪里"也是 worker 那一侧的环境注入。
 *
 * ⚠️ **但它不参与作用域降级。** `launcher.mjs` 里那段「被 `--include` 排除的
 * 进程降级为 warn」的判定跑在**启动计划**那一步（`planDiagnostics`），
 * 而这些诊断是**启动过程中**才产生的，直接拼进最终列表、不经过那一段。
 * 也就是说：写在这里的 `process` 只影响**人去哪里找**，
 * 不影响严重级——严重级由调用点显式给（`severity`）。
 *
 *   > 第一版的注释写的是"带错 process 会让降级判据落空"。
 *   > 实跑一个 `--include orchestrator`（不含 runtime）的启动才发现：
 *   > 它**根本不走那条判据**，于是那句话是错的，而且错得刚好相反
 *   > ——一个刻意的受限启动会带着一条不会阻塞的 `error` 出来。
 */
export function runtimeContractDiagnostic(result, { severity = 'error' } = {}) {
  return Object.freeze({
    severity,
    code: result?.code ?? RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_ABSENT,
    process: 'orchestrator',
    message: result?.message ?? '',
    reasons: Object.freeze([...(result?.reasons ?? [])]),
  })
}
