// runtime/dsh-composition/runtime-contract-publication.mjs
// ============================================================================
// Runtime Contract 的**端口发布**（PRT-253 续批四：把临时端口交给 worker）
//
// ## 它补的是哪一截
//
// 服务端（`runtime-contract-server.mjs`）**允许** `port: 0`：内核分配临时端口，
// 真实端口从 `listen()` 读回。这是对的——一个固定端口会让「没配」与
// 「配在这个端口上」在读数上同形，而且两台 Runtime 会撞在同一个端口上。
//
// 但临时端口带来一个必须回答的问题：
//
//   > **消费方（另一个进程里的 worker）凭什么知道这个随机端口？**
//
// 本模块的回答是：**由真正绑定了端口的那个进程把实际端口写下来**，
// 写到 DataDir 下的一个固定位置。写下去的只有四样东西：
// `pid` / `host` / `port` / `wireVersion`。
//
// ## 为什么不是「Launcher 先分配一个再传给 Runtime」
//
// 那条路也走得通（Launcher 本来就在分配端口，见 `ports.mjs` 的
// `reserveEphemeralPort`），但它的失败模式**落在看不见的地方**：
//
//   · `reserveEphemeralPort` 是「先绑一次再放开」，放开到 Runtime 真的绑上
//     之间有一个窗口。窗口里被别的进程抢走时，Runtime 进程里那一行报
//     `LISTEN_FAILED`（具名、正确），可 **Runtime 进程自己仍然是健康的**
//     ——它的 `/` 照样返回 200，于是 Launcher 报「runtime 就绪」，
//     并把那个已经不属于任何人的端口交给 worker。worker 读到的是
//     `RUNTIME_UNREACHABLE`（"配了但够不着"），而真因（端口被抢）只在
//     另一个进程的一份服务值里。
//
//     > 一个把「端口被抢」报成「端点够不着」的部署，
//     > 会让排障的人去查网络，而问题在分配。
//
//   · 发布文件这条路把「谁真的绑上了」当成唯一事实来源：
//     监听成功之前**不发布**，因此「发布的端口」与「在听的端口」不会有分歧；
//     Launcher 拿不到匹配的发布就**具名拒绝**，不编一个 URL。
//
// 代价写在文档的诚实边界里：多一个文件、多一处需要在崩溃后处理的陈旧状态。
//
// ## 文件里**没有** token
//
// 发布的内容只有 `pid / host / port / wireVersion`。
// token 由 Launcher 生成并**只经环境变量**注入两个进程（见
// `product/launcher/runtime-contract-endpoint.mjs` 的 `generateRuntimeToken`），
// 落盘、打印、进状态文件都是被禁止的——所以这里**结构上**就没有它的位置。
//
//   > 把凭证放进一个"顺手也写一下"的发布文件里，
//   > 与把它写进日志，是同一种错误，只是前者更像设计。
//
// ## 写是**原子**的（先写临时文件，再 rename 覆盖）
//
// 消费方是另一个进程，它在任意时刻都可能来读。非原子写会在读侧产生一个
// **半截文件**，而半截文件与"坏掉的发布"在 JSON.parse 之后同形——
// 于是"写入方正在写"会被读成"发布坏了"，修法完全不同。
// rename 在同一卷上是原子的，因此读者只会看到旧版本或新版本，不会看到半截。
//
// ## 崩溃之后会留下一个陈旧文件——这是**有意的**
//
// 本模块**不**在启动时清理旧文件。清理的权威在消费侧（Launcher 在 spawn
// Runtime 之前删一次，然后用 `pid` 判定"这份发布是不是本次那个进程写的"）。
// 理由：一个"文件在就说明Runtime在跑"的判据是**假的**——进程可以被无条件
// 终止，文件却会留在那里。判定陈旧必须靠一个与进程身份绑定的字段，
// 而不是靠"文件存在"。见 `product/launcher/runtime-contract-endpoint.mjs`
// 的 `readRuntimeContractEndpoint`。
// ============================================================================

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { RUNTIME_CONTRACT_WIRE_VERSION } from '../contracts/wire.mjs'

/** 发布文件的格式版本。字段含义或取值域变化时递增。 */
export const RUNTIME_CONTRACT_PUBLICATION_VERSION = 1

/**
 * 发布文件在 DataDir 下的相对片段。
 *
 * 逐段导出（而不是只给一个字符串）：消费侧**不能** import 本模块
 * （依赖方向：`product/` 不 import `runtime/dsh-composition/`），
 * 于是它必须自己写一份同样的相对片段——用一条用例把两份**逐段**对账，
 * 比对一个拼好的字符串能更早地指出是哪一段漂了。
 *
 * 目录名 `runtime` 与 `product/launcher/launcher.mjs` 的 `DATA_PATH_ENV`
 * 是同一套约定（每个进程在 DataDir 下有自己的子目录）。
 */
export const RUNTIME_CONTRACT_PUBLICATION_RELPATH_PARTS = Object.freeze(['runtime', 'runtime-contract.json'])

/** 同一份事实的字符串形式（用例用它逐字对账）。 */
export const RUNTIME_CONTRACT_PUBLICATION_RELPATH = RUNTIME_CONTRACT_PUBLICATION_RELPATH_PARTS.join('/')

/**
 * 发布记录里的字段，**顺序即写入顺序**。
 *
 * 它是给消费侧的对账锚：`product/launcher/runtime-contract-endpoint.mjs`
 * 有一份同样的清单，两边由用例钉住相等。字段多一个少一个都要两边一起改，
 * 而"少一个"正是那种"读侧静默把它当成 undefined 然后判非法"的漂移。
 */
export const RUNTIME_CONTRACT_PUBLICATION_FIELDS = Object.freeze([
  'version', 'pid', 'host', 'port', 'wireVersion',
])

/** 允许出现在发布里的 host。与 `product/process-manifest.mjs` 的 `LOOPBACK_HOSTS` 同集合。 */
export const RUNTIME_CONTRACT_PUBLICATION_HOSTS = Object.freeze(['127.0.0.1', '::1', 'localhost'])

/** 本模块的具名码。每一条对应一种**不同的修法**。 */
export const RUNTIME_CONTRACT_PUBLICATION_CODES = Object.freeze({
  /** 没有 DataDir：不知道发布写到哪。**不猜一个目录**。 */
  NO_DATA_DIR: 'RUNTIME_CONTRACT_PUBLICATION_NO_DATA_DIR',
  /** 地址/进程身份不合法（端口越界、host 不是回环、pid 不是正整数）。 */
  INVALID_ADDRESS: 'RUNTIME_CONTRACT_PUBLICATION_INVALID_ADDRESS',
  /** 写失败（目录建不出来、盘满、权限）。**与"没配目录"是两件事**。 */
  WRITE_FAILED: 'RUNTIME_CONTRACT_PUBLICATION_WRITE_FAILED',
  /** 清理失败。它不是致命的（消费侧还有 pid 判定），但必须被看见。 */
  CLEAR_FAILED: 'RUNTIME_CONTRACT_PUBLICATION_CLEAR_FAILED',
})

const defaultFs = Object.freeze({
  mkdirSync: (p, o) => mkdirSync(p, o),
  writeFileSync: (p, d, o) => writeFileSync(p, d, o),
  renameSync: (a, b) => renameSync(a, b),
  rmSync: (p, o) => rmSync(p, o),
})

/** 临时文件名的序号：同一个进程里连续两次发布不能撞在同一个临时文件上。 */
let tmpSeq = 0

function refusal(code, message, reasons = []) {
  return Object.freeze({
    ok: false, code, message, reasons: Object.freeze([...reasons]),
  })
}

/**
 * 发布文件在 DataDir 下的绝对路径；`dataDir` 不可用时返回 `null`。
 *
 * 返回 `null` 而不是抛错：调用方（那一行）要把"没有目录"变成一条
 * **可见的**降级状态，而不是让整个 Runtime 进程起不来。
 */
export function runtimeContractPublicationPath(dataDir, { joinImpl = join } = {}) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') return null
  return joinImpl(dataDir, ...RUNTIME_CONTRACT_PUBLICATION_RELPATH_PARTS)
}

/**
 * 写下「本进程的契约监听器实际绑在哪个地址上」。
 *
 * @param {object} input
 * @param {string} input.dataDir  DataDir（发布落在它下面）
 * @param {string} input.host     实际绑定地址（来自 `listen()` 的 `address()`）
 * @param {number} input.port     实际端口（**必须是从 `address()` 读回的那个**）
 * @param {number} input.pid      发布者进程 pid（消费侧靠它判陈旧）
 * @param {number} [input.wireVersion]
 * @param {object} [input.fs]     注入 `{mkdirSync, writeFileSync, renameSync, rmSync}`
 * @returns {{ok:true, path:string, record:object}|{ok:false, code:string, message:string, reasons:string[]}}
 */
export function publishRuntimeContractEndpoint({
  dataDir,
  host,
  port,
  pid,
  wireVersion = RUNTIME_CONTRACT_WIRE_VERSION,
  fs = null,
} = {}) {
  const io = fs ?? defaultFs
  const target = runtimeContractPublicationPath(dataDir)
  if (target === null) {
    return refusal(
      RUNTIME_CONTRACT_PUBLICATION_CODES.NO_DATA_DIR,
      `没有可用的 DataDir（收到 ${dataDir === null ? 'null' : typeof dataDir}）：` +
      '**不猜一个目录**——写到一个碰巧存在的路径上，会让"发布成功了"与"发布到别处了"同形',
      ['把 LEGION_DATA_DIR 交给 Runtime 进程；Launcher 是唯一知道它的那一侧'],
    )
  }
  if (typeof host !== 'string' || !RUNTIME_CONTRACT_PUBLICATION_HOSTS.includes(host)) {
    return refusal(
      RUNTIME_CONTRACT_PUBLICATION_CODES.INVALID_ADDRESS,
      `host 是 ${JSON.stringify(host)}，只允许回环地址 ${RUNTIME_CONTRACT_PUBLICATION_HOSTS.join(' / ')}。` +
      '**不发布一个非回环地址**：消费侧会照着它去连，而 spec §10 只允许监听回环',
    )
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return refusal(
      RUNTIME_CONTRACT_PUBLICATION_CODES.INVALID_ADDRESS,
      `port 是 ${JSON.stringify(port)}，而它必须是 1..65535 的整数。` +
      '**不从 0 推断**：0 的含义是"让内核分配"，发布 0 等于发布"不知道"',
    )
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return refusal(
      RUNTIME_CONTRACT_PUBLICATION_CODES.INVALID_ADDRESS,
      `pid 是 ${JSON.stringify(pid)}，而它必须是正整数：消费侧唯一的陈旧判据就是它`,
    )
  }
  if (!Number.isInteger(wireVersion) || wireVersion <= 0) {
    return refusal(
      RUNTIME_CONTRACT_PUBLICATION_CODES.INVALID_ADDRESS,
      `wireVersion 是 ${JSON.stringify(wireVersion)}，而它必须是正整数`,
    )
  }

  const record = Object.freeze({ version: RUNTIME_CONTRACT_PUBLICATION_VERSION, pid, host, port, wireVersion })
  const text = `${JSON.stringify(record)}\n`
  tmpSeq += 1
  const tmp = `${target}.tmp-${pid}-${tmpSeq}`
  try {
    io.mkdirSync(dirname(target), { recursive: true })
    io.writeFileSync(tmp, text, 'utf8')
    io.renameSync(tmp, target)
  } catch (e) {
    // 尽力清掉半截的临时文件：留着它会让"目录里有东西"变成一个假信号。
    try { io.rmSync(tmp, { force: true }) } catch { /* 尽力而为 */ }
    return refusal(
      RUNTIME_CONTRACT_PUBLICATION_CODES.WRITE_FAILED,
      `写端口发布失败（${e?.code ?? e?.name ?? 'Error'}）：${e?.message ?? String(e)}`,
      ['消费侧读不到匹配的发布时会具名拒绝（RUNTIME_CONTRACT_PUBLICATION_ABSENT），不会编一个 URL'],
    )
  }
  return Object.freeze({ ok: true, code: null, message: null, reasons: Object.freeze([]), path: target, record })
}

/**
 * 删掉发布文件。
 *
 * 谁该调用它：**消费侧在 spawn Runtime 之前**（把上一次崩溃留下的陈旧发布
 * 清掉，于是"本次启动之后出现的发布"只可能来自本次那个进程）。
 *
 * "文件本来就不在"算成功：清理是幂等的，而把 ENOENT 报成一个码会让
 * 一个正常的新装机器每次启动都收到一条假告警。
 */
export function clearRuntimeContractPublication({ dataDir, fs = null } = {}) {
  const io = fs ?? defaultFs
  const target = runtimeContractPublicationPath(dataDir)
  if (target === null) {
    return refusal(RUNTIME_CONTRACT_PUBLICATION_CODES.NO_DATA_DIR, '没有可用的 DataDir：不知道要清理哪一份发布')
  }
  try {
    io.rmSync(target, { force: true })
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      return refusal(
        RUNTIME_CONTRACT_PUBLICATION_CODES.CLEAR_FAILED,
        `清理端口发布失败（${e?.code ?? e?.name ?? 'Error'}）：${e?.message ?? String(e)}`,
        ['陈旧发布不会被误当成本次的：消费侧还会比对 pid'],
      )
    }
  }
  return Object.freeze({ ok: true, code: null, message: null, reasons: Object.freeze([]), path: target })
}
