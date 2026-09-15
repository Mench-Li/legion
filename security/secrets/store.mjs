// security/secrets/store.mjs
// ============================================================================
// 本机密钥库（PRT-505 最小闭环 / PRT-258 第四份契约）
//
// spec §6.7 的硬约束，逐条落成结构而不是文档约定：
//   ① team-hub 只保存 `secretRef`，不保存明文            → 本模块的调用方只拿引用
//   ② Runtime 在获得授权后按需解析密钥                    → `get()` 是唯一的明文出口
//   ③ 密钥只注入需要它的执行进程和工具                    → 不做全局单例、不读 env
//   ④ 提示词/日志/异常/审计/诊断包/能力包不得含密钥        → `list()`/`toJSON()`/审计/错误
//                                                            全部只带元数据
//   ⑤ 新增/更新/轮换/删除写不含密文的审计                  → `onAudit` 载荷字段白名单
//   ⑥ 无法访问或解密时 fail closed                        → 全部抛错，不返回空串/undefined
//
// ## 分层：后端只存 blob，保护在 store
//
// 「存哪里」（内存/文件）与「怎么保护」（明文/DPAPI）是两个正交的问题。
// 把它们揉进一个后端会让「用内存后端测文件后端的原子写」这类事做不到，
// 也会让「保护方案」变成后端的隐藏属性。因此：
//
//   backend    只负责 blob 的读写与列举（`memoryBackend` / `fileBackend`）
//   protector  只负责 明文 <-> blob（`nullProtector` / `createDpapiProtector`）
//   store      组合两者，负责引用校验、元数据、审计与 fail-closed
//
// ## 刻意不做的事
//
// - **不做密钥的自动轮换或缓存**：在途 Run 必须保持其启动时解析到的那份凭证
//   （spec §6.7「不在中途替换」），缓存会把这条保证变成偶然。
//   ★ 保证的**提供者是调用方**：`security/secrets/run-credentials.mjs` 的
//   `openRunCredentials()` 在 Run 开始时抓一次、之后不再读这里。
//   本模块刻意不缓存，正是为了让"抓一次"这件事必须被**显式地**做出来——
//   一个隐式缓存的 store 会把"在途 Run 不变"变成"看后端有没有缓存"。
// - **不读 `process.env`**：配置面读取点必须可被 `scripts/config/scan.mjs` 扫描，
//   而密钥不该出现在环境变量里。
// ============================================================================

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

import { SecretStoreError } from './errors.mjs'
import { assertSecretRef } from './ref.mjs'
import { DPAPI_SCHEME, probeDpapi, protectValue, unprotectValue } from './dpapi.mjs'

/** 密钥库文件结构版本。结构变化时递增（升级时按版本迁移）。 */
export const SECRET_STORE_VERSION = 1

/** 保护方案。`none` 只允许用于测试与本地开发，store 会拒绝把它当受保护库。 */
export const PROTECTION_SCHEMES = Object.freeze(['none', DPAPI_SCHEME])

/** 允许随引用一起保存的元数据字段（白名单：多一个字段就多一条泄漏路径）。 */
export const SECRET_META_FIELDS = Object.freeze(['purpose'])

export const AUDIT_ACTIONS = Object.freeze([
  'secret.created',
  'secret.updated',
  'secret.rotated',
  'secret.deleted',
  'secret.read-failed',
])

// ---------------------------------------------------------------- protectors

/** 明文保护器：blob 即明文。**只能用于测试**；store 会把它标记为未受保护。 */
export function nullProtector() {
  return Object.freeze({
    scheme: 'none',
    protected: false,
    protect: (value) => value,
    unprotect: (blob) => blob,
  })
}

/** 用给定的加解密函数构造保护器（用例夹具；也用于将来接入其他后端）。 */
export function createProtector({ scheme, protect, unprotect }) {
  if (typeof scheme !== 'string' || scheme === '' || scheme === 'none') {
    throw new Error('createProtector 需要一个非 "none" 的 scheme')
  }
  if (typeof protect !== 'function' || typeof unprotect !== 'function') {
    throw new Error('createProtector 需要 protect / unprotect 两个函数')
  }
  return Object.freeze({ scheme, protected: true, protect, unprotect })
}

/**
 * 当前用户作用域 DPAPI 保护器。
 *
 * 解释器在**构造时**探测一次并记住：每次加解密都去探测会在密钥库不可用
 * （无 PowerShell）时给出「有时成功有时失败」的表现。
 */
export function createDpapiProtector({ exe = null, platform = process.platform } = {}) {
  const probe = exe === null ? probeDpapi({ platform }) : { available: true, exe, scheme: DPAPI_SCHEME }
  if (probe.available !== true) {
    throw new SecretStoreError('SECRET_STORE_UNSUPPORTED_PLATFORM', { platform, cause: probe.reason })
  }
  const resolved = probe.exe
  return Object.freeze({
    scheme: DPAPI_SCHEME,
    protected: true,
    exe: resolved,
    protect: (value) => protectValue(value, { exe: resolved, platform }),
    unprotect: (blob) => unprotectValue(blob, { exe: resolved, platform }),
  })
}

// ---------------------------------------------------------------- backends

/**
 * 内存后端。只用于测试与「凭证仅在本次进程内有效」的场景。
 * 对外仍然只经 store 暴露，因此明文不会因为用了内存后端而多出一条读路径。
 */
export function memoryBackend() {
  const records = new Map()
  return Object.freeze({
    kind: 'memory',
    read: (ref) => (records.has(ref) ? { ...records.get(ref) } : null),
    write: (ref, record) => { records.set(ref, { ...record }) },
    remove: (ref) => records.delete(ref),
    entries: () => [...records.entries()].map(([ref, r]) => ({ ref, meta: { ...r.meta } })),
    /** 仅用于用例：直接读取落盘内容以断言「密文里不含明文」 */
    rawBlob: (ref) => (records.has(ref) ? records.get(ref).blob : null),
  })
}

/** 锁文件后缀。与库文件同级（同卷才能保证 `wx` 的原子性对所有人都成立）。 */
const LOCK_SUFFIX = '.lock'

/** 锁多久没被动过就算陈旧（持锁进程大概已经崩了）。 */
const DEFAULT_LOCK_TTL_MS = 10_000

/** 拿锁的总预算。**有界**：密钥库写入发生在启动路径上，不能无限等。 */
const DEFAULT_LOCK_TIMEOUT_MS = 2_000

/** 两次尝试之间的间隔。 */
const DEFAULT_LOCK_RETRY_MS = 10

/** 本进程内递增，保证同一进程的两次锁也不同 token。 */
let lockTokenSeq = 0

/**
 * 同步小睡。
 *
 * `Atomics.wait` 是 Node 里**不需要第三方依赖**的同步睡眠。刻意不忙等：
 * 争用恰恰发生在别的进程正忙的时候，忙等会把 CPU 抢给等待方、让持锁方更慢。
 */
function syncSleep(ms) {
  if (!(ms > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 单文件 JSON 后端。结构刻意与 `$DSH_HOME/.credentials.yaml` 的
 * `refs → records` 引用式存储同形（PRT-003 §3.2 的结论：复用既有机制，不另建密钥库），
 * 便于将来把两处收敛到一处。
 *
 * 写入用「临时文件 + rename」：rename 在同一卷内是原子的，
 * 半截写入的密钥库比没有密钥库更危险——它会以「所有密钥都无法解密」的形式失败，
 * 而用户看不出是写入被打断了。
 *
 * ## ★ 但「写是原子的」不等于「读-改-写是原子的」（PRT-254 的并发缺口）
 *
 * `write()` / `remove()` 都是**整体读-改-写**：读全量 → 改一条 → 写回全量。
 * `rename` 只保证**每一次写**不会被撕成半截，它对**两次读-改-写交错**毫无帮助：
 *
 *   P1 读 {A}          P2 读 {A}
 *   P1 写 {A,B}        P2 写 {A,C}      ← P2 的 rename 覆盖掉 P1，**B 静默消失**
 *
 * 而这不是理论：Legion 的写入方**本来就有多个进程**——Launcher（安装向导 /
 * `--set-secret`）与 hub（工作台那 5 条密钥路由），多 Runtime 并存也是正常形态。
 *
 *   > 一个"写下去就返回成功"的密钥库，与一个"刚才存的那把钥匙下次启动时不见了"
 *   > 的密钥库，在用户那一次操作里是同一个东西——只不过前者会回一句"已保存"。
 *
 * 所以写路径加一把**跨进程**的锁：`<file>.lock`，用 `flag: 'wx'`
 * （`O_CREAT|O_EXCL`，它是在不引第三方依赖的前提下**唯一**可用的原子占位）。
 *
 * 三条纪律：
 *   ① **拿不到锁就不写**。超时即抛 `SECRET_STORE_LOCK_TIMEOUT`，绝不"无锁照写"——
 *      那正好把丢更新重新变成静默的；也绝不把失败报成成功。
 *   ② **陈旧的锁要能破**。持锁进程崩了不能把密钥库永久锁死：锁文件 mtime 超过
 *      `lockTtlMs` 即视为陈旧，抢过来（`unlink` 与 `wx` 之间有竞态，但只有一个能建成）。
 *   ③ **只删自己的锁**。锁文件里写一个本进程唯一 token，释放前核对；
 *      TTL 到期后别人可能已把陈旧的锁抢走并建了他自己的，那时替它删锁
 *      等于**同时放行两个写者**。
 *
 * 读路径（`read` / `entries`）**不加锁**：读没有丢更新的问题，而给读加锁会让
 * 「诊断/列表」这些路径在别的进程写库时被阻塞。
 */
export function fileBackend({
  file,
  fs: fsImpl = null,
  lockTtlMs = DEFAULT_LOCK_TTL_MS,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  lockRetryMs = DEFAULT_LOCK_RETRY_MS,
  sleep = syncSleep,
  nowMs = () => Date.now(),
} = {}) {
  if (typeof file !== 'string' || file === '') throw new Error('fileBackend 需要 file 路径')
  const io = fsImpl ?? { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, statSync, dirname }
  const readAll = () => {
    if (!io.existsSync(file)) return { version: SECRET_STORE_VERSION, refs: {}, records: {} }
    let text
    try {
      text = io.readFileSync(file, 'utf8')
    } catch (e) {
      throw new SecretStoreError('SECRET_STORE_UNREADABLE', { cause: e?.code ?? 'read-error' })
    }
    try {
      const parsed = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      return {
        version: Number.isInteger(parsed.version) ? parsed.version : SECRET_STORE_VERSION,
        refs: parsed.refs && typeof parsed.refs === 'object' ? parsed.refs : {},
        records: parsed.records && typeof parsed.records === 'object' ? parsed.records : {},
      }
    } catch {
      throw new SecretStoreError('SECRET_STORE_CORRUPT')
    }
  }
  const writeAll = (data) => {
    try {
      io.mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}`
      io.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      io.renameSync(tmp, file)
    } catch (e) {
      if (e instanceof SecretStoreError) throw e
      throw new SecretStoreError('SECRET_STORE_WRITE_FAILED', { cause: e?.code ?? 'write-error' })
    }
  }

  // ── 跨进程写锁（见文件头「读-改-写不是原子的」那一节）────────────────────────
  const lockFile = `${file}${LOCK_SUFFIX}`
  const lockToken = `${process.pid}-${++lockTokenSeq}`
  const lockTimeoutError = () => new SecretStoreError('SECRET_STORE_LOCK_TIMEOUT')

  /** 读锁文件里的 token；读不到（不存在 / 刚被删）返回 `null`。 */
  const lockTokenOnDisk = () => {
    try {
      return io.readFileSync(lockFile, 'utf8')
    } catch {
      return null
    }
  }

  /**
   * 锁文件存在多久了（ms）。**取不到年龄就返回 `null`**，调用方按「不陈旧」处理。
   *
   * `statSync` 可以被注入的 fs 省掉。省掉时我们**不猜年龄**，于是永远不会去破锁——
   * 代价只是争用时走到超时（fail closed）；反过来猜一次，就可能把别人**正持有的**
   * 活锁当成陈旧的破掉，那等于同时放行两个写者。
   */
  const lockAgeMs = () => {
    if (typeof io.statSync !== 'function') return null
    try {
      const st = io.statSync(lockFile)
      const mtime = typeof st?.mtimeMs === 'number' ? st.mtimeMs : null
      if (mtime === null) return null
      const age = nowMs() - mtime
      return Number.isFinite(age) ? age : null
    } catch {
      return null
    }
  }

  /** 尝试占位：成功 `true`，被别人占了 `false`。 */
  const tryAcquireLock = () => {
    try {
      io.writeFileSync(lockFile, lockToken, { encoding: 'utf8', flag: 'wx' })
      return true
    } catch (e) {
      // ★★ 「被占用」的判据**不能只认 `EEXIST`**——这是本机实测出来的，不是推演：
      //
      //   · **静态**场景（文件已存在，单进程）：报 `EEXIST`。
      //   · **并发**场景（8 进程 × 400 次建/删同一路径）：实测分布
      //     `EEXIST 1393 / 成功 1594 / **EPERM 213**`——约 6.7% 的独占创建在争用下
      //     报的是 `EPERM`（Windows 上名字正被别人删/建时，独占创建拿到的不是
      //     "已存在"而是"访问被拒"）。
      //
      //   于是"只认 EEXIST"的实现在**单进程用例里全绿**（用例都是静态造一个锁文件），
      //   一到真并发就把 6.7% 的正常争用当成致命错误：实测 8 进程 × 40 写，
      //   320 条只落 208 条，失败的子进程报 `SECRET_STORE_LOCK_FAILED`。
      //
      //   > 一个"在夹具里认得出被占用"的判据，
      //   > 与一个"在真争用下认得出被占用"的判据，在只跑单进程用例时是同一个东西——
      //   > 只不过前者会让真并发的写入随机失败。
      if (e?.code === 'EEXIST' || e?.code === 'EPERM') return false
      // 不是"被占用"而是别的写失败（目录不可写 / 磁盘满）：具名抛，不退化。
      throw new SecretStoreError('SECRET_STORE_LOCK_FAILED', { cause: e?.code ?? 'lock-error' })
    }
  }

  /**
   * 放弃时区分「抢不到」与「建不出来」。
   *
   * 两者的修法完全不同——前者是"等一会儿再试"，后者是"去修目录权限"。
   * 判据是锁文件到底在不在：它不在，就说明整个预算内**没有人持有它**，
   * 而我们却始终没能把它建出来 ⇒ 那是权限问题，不是争用。
   */
  const lockGiveUpError = () => (lockTokenOnDisk() === null
    ? new SecretStoreError('SECRET_STORE_LOCK_FAILED')
    : lockTimeoutError())

  /** 在锁的保护下跑 `fn`。拿不到锁**就抛**，绝不无锁照写。 */
  const withWriteLock = (fn) => {
    const deadline = nowMs() + lockTimeoutMs
    for (;;) {
      if (tryAcquireLock()) break
      const age = lockAgeMs()
      // `lockTtlMs > 0` 是必要条件而不是防御性写法：配成 0 会让**任何**锁立刻算陈旧，
      // 于是去破一把别人正持有的活锁——那比不加锁更坏。
      if (lockTtlMs > 0 && age !== null && age > lockTtlMs) {
        try { io.unlinkSync(lockFile) } catch { /* 别人已经删了 */ }
        if (nowMs() >= deadline) throw lockGiveUpError()
        continue
      }
      if (nowMs() >= deadline) throw lockGiveUpError()
      sleep(lockRetryMs)
    }
    try {
      return fn()
    } finally {
      // 只删自己的锁（纪律 ③）：TTL 到期后别人可能已把陈旧的锁抢走并建了他自己的。
      if (lockTokenOnDisk() === lockToken) {
        try { io.unlinkSync(lockFile) } catch { /* 已经没了 */ }
      }
    }
  }

  return Object.freeze({
    kind: 'file',
    file,
    read(ref) {
      const data = readAll()
      const record = data.records[ref]
      if (record === undefined) return null
      return { blob: record.blob, meta: { ...(data.refs[ref] ?? {}) } }
    },
    write(ref, record) {
      // ★ `readAll()` 必须在锁**里面**：锁外读出来的就是一份可能在写回前过期的快照，
      //   而那正是丢更新的成因。
      return withWriteLock(() => {
        const data = readAll()
        data.version = SECRET_STORE_VERSION
        data.records[ref] = { scheme: record.meta.scheme, blob: record.blob }
        data.refs[ref] = { ...record.meta }
        writeAll(data)
      })
    },
    remove(ref) {
      return withWriteLock(() => {
        const data = readAll()
        const existed = data.records[ref] !== undefined
        delete data.records[ref]
        delete data.refs[ref]
        writeAll(data)
        return existed
      })
    },
    entries() {
      const data = readAll()
      return Object.keys(data.records).map((ref) => ({ ref, meta: { ...(data.refs[ref] ?? {}) } }))
    },
  })
}

// ---------------------------------------------------------------- store

const DEFAULT_META_PURPOSE = 'model-credential'

function freezeMeta(ref, meta) {
  return Object.freeze({
    ref,
    purpose: typeof meta.purpose === 'string' && meta.purpose !== '' ? meta.purpose : DEFAULT_META_PURPOSE,
    scheme: meta.scheme ?? null,
    createdAt: meta.createdAt ?? null,
    updatedAt: meta.updatedAt ?? null,
    rotatedAt: meta.rotatedAt ?? null,
  })
}

/**
 * 创建密钥库。
 *
 * @param {object} options
 * @param {object} options.backend `memoryBackend()` / `fileBackend({file})`
 * @param {object} options.protector `nullProtector()` / `createDpapiProtector()`
 * @param {() => string} [options.now] 注入时钟（用例里必须是确定值）
 * @param {(event: object) => void} [options.onAudit] 审计回调；载荷字段受白名单限制
 */
export function createSecretStore({ backend, protector, now = () => new Date().toISOString(), onAudit = null } = {}) {
  if (backend === null || typeof backend !== 'object') throw new Error('createSecretStore 需要 backend')
  if (protector === null || typeof protector !== 'object') throw new Error('createSecretStore 需要 protector')
  if (!PROTECTION_SCHEMES.includes(protector.scheme)) {
    throw new Error(`未知保护方案「${protector.scheme}」：只允许 ${PROTECTION_SCHEMES.join(' / ')}`)
  }

  const audit = (action, ref, extra = {}) => {
    if (typeof onAudit !== 'function') return
    // 白名单：审计载荷里**只**允许这些字段。密文/明文/长度都不在名单内——
    // 密文长度也能泄漏信息，而审计是会被导出与上报的东西。
    const event = Object.freeze({ action, ref, at: now(), ...extra })
    for (const key of Object.keys(event)) {
      if (key === 'action' || key === 'ref' || key === 'at' || key === 'purpose') continue
      throw new Error(`审计事件含未允许字段「${key}」：审计载荷有白名单，避免密钥或其指纹随审计外带`)
    }
    onAudit(event)
  }

  const protectedStore = protector.protected === true

  const store = {
    /** 保护方案与是否真的受保护。 */
    protection() {
      return Object.freeze({ scheme: protector.scheme, protected: protectedStore })
    },

    /**
     * 写入（已存在则视为更新）。返回元数据，**不返回**值或密文。
     */
    async put(ref, value, { purpose } = {}) {
      assertSecretRefOrThrow(ref)
      if (typeof value !== 'string' || value === '') throw new SecretStoreError('SECRET_VALUE_EMPTY', { ref })
      const existing = await backend.read(ref)
      const createdAt = existing?.meta?.createdAt ?? now()
      const meta = freezeMeta(ref, {
        purpose,
        scheme: protector.scheme,
        createdAt,
        updatedAt: now(),
        rotatedAt: existing?.meta?.rotatedAt ?? null,
      })
      await backend.write(ref, { blob: protector.protect(value), meta: serializeMeta(meta) })
      audit(existing === null ? 'secret.created' : 'secret.updated', ref, { purpose: meta.purpose })
      return meta
    },

    /**
     * 轮换：引用名不变、值替换，并记录 `rotatedAt`。
     *
     * **只影响轮换之后创建的 Run**（spec §6.7 / `line 428`）。但那条保证
     * **不由本模块提供**——本模块刻意不缓存，所以**同一个 `get(ref)` 在轮换
     * 前后会返回两个不同的值**。把它变成真的是调用方的事：
     *
     *   `security/secrets/run-credentials.mjs` 的 `openRunCredentials()`
     *   在 Run 开始时把值抓一次、返回冻结句柄，此后不再读这里。
     *
     * ⚠️ 这一段原来是「在途 Run 已把凭证解析进进程内，这里不需要也无法影响它们」——
     * 那句话把一个**承诺**写成了**事实**：当时没有任何对象在"把凭证解析进进程内"，
     * 于是对任何"两次读取之间可能发生轮换"的调用方，那条保证是假的。
     *
     *   > 一句"在途 Run 已把凭证解析进进程内"的注释，
     *   > 与一个真的把凭证解析进进程内的机制，
     *   > 在读到那句话的人眼里是同一个东西——
     *   > 只不过前者会在某一次轮换之后，让一个跑到一半的任务换掉手里的钥匙。
     *
     * 而且这一整类失败**不报错**：轮换期间的一次重读拿到的是**合法的**新值，
     * 调用方会正常地把任务跑完，没有任何读数显示"换了"。
     */
    async rotate(ref, value, { purpose } = {}) {
      assertSecretRefOrThrow(ref)
      const existing = await backend.read(ref)
      if (existing === null) throw new SecretStoreError('SECRET_NOT_FOUND', { ref })
      if (typeof value !== 'string' || value === '') throw new SecretStoreError('SECRET_VALUE_EMPTY', { ref })
      const at = now()
      const meta = freezeMeta(ref, {
        purpose: purpose ?? existing.meta?.purpose,
        scheme: protector.scheme,
        createdAt: existing.meta?.createdAt ?? at,
        updatedAt: at,
        rotatedAt: at,
      })
      await backend.write(ref, { blob: protector.protect(value), meta: serializeMeta(meta) })
      audit('secret.rotated', ref, { purpose: meta.purpose })
      return meta
    },

    /**
     * 解析引用。这是**唯一的明文出口**。
     * 不存在、解不开、库坏掉一律抛错（fail closed），不返回空串。
     */
    async get(ref) {
      assertSecretRefOrThrow(ref)
      const record = await backend.read(ref)
      if (record === null) {
        audit('secret.read-failed', ref, { purpose: null })
        throw new SecretStoreError('SECRET_NOT_FOUND', { ref })
      }
      let value
      try {
        value = protector.unprotect(record.blob)
      } catch (e) {
        audit('secret.read-failed', ref, { purpose: record.meta?.purpose ?? null })
        if (e instanceof SecretStoreError) throw e
        throw new SecretStoreError('SECRET_DECRYPT_FAILED', { ref, cause: e?.code ?? 'decrypt-error' })
      }
      if (typeof value !== 'string' || value === '') {
        audit('secret.read-failed', ref, { purpose: record.meta?.purpose ?? null })
        throw new SecretStoreError('SECRET_DECRYPT_FAILED', { ref, cause: 'empty-plaintext' })
      }
      return Object.freeze({ ref, value, resolvedAt: now() })
    },

    async has(ref) {
      assertSecretRefOrThrow(ref)
      return (await backend.read(ref)) !== null
    },

    async describe(ref) {
      assertSecretRefOrThrow(ref)
      const record = await backend.read(ref)
      return record === null ? null : freezeMeta(ref, record.meta ?? {})
    },

    /** 只列元数据。**永远不含值、密文或长度。** */
    async list() {
      const rows = await backend.entries()
      return Object.freeze(rows
        .map((row) => freezeMeta(row.ref, row.meta ?? {}))
        .sort((a, b) => a.ref.localeCompare(b.ref)))
    },

    async remove(ref) {
      assertSecretRefOrThrow(ref)
      const existed = await backend.remove(ref)
      if (existed) audit('secret.deleted', ref, { purpose: null })
      return existed
    },

    /**
     * 序列化时自动脱敏。定义 `toJSON` 是为了堵住「有人顺手 JSON.stringify(store)」
     * 这条最容易被忽略的泄漏路径——它不会报错，只会把密钥写进日志。
     */
    toJSON() {
      return { protection: { scheme: protector.scheme, protected: protectedStore }, refs: '<redacted: 用 list() 取元数据>' }
    },
    toString() {
      return `[SecretStore scheme=${protector.scheme} protected=${protectedStore}]`
    },
  }

  return Object.freeze(store)
}

/** 元数据序列化：只保留白名单字段，避免把内部对象整体塞进后端。 */
function serializeMeta(meta) {
  const out = {}
  for (const key of SECRET_META_FIELDS) {
    if (meta[key] !== undefined) out[key] = meta[key]
  }
  out.scheme = meta.scheme
  out.createdAt = meta.createdAt
  out.updatedAt = meta.updatedAt
  out.rotatedAt = meta.rotatedAt
  return out
}

function assertSecretRefOrThrow(ref) {
  try {
    assertSecretRef(ref)
  } catch (e) {
    throw new SecretStoreError('SECRET_REF_INVALID', { ref: typeof ref === 'string' ? ref : null, cause: e?.message })
  }
}

/**
 * 断言密钥库确实受保护（spec §6.7「无法访问或解密密钥时 fail closed」的前置）。
 *
 * 用途是启动自检：明文后端必须**拒绝**被当成真实密钥库使用，
 * 而不是“能跑就先跑着”。返回 store 便于链式使用。
 */
export function assertProtectedStore(store, { allowedSchemes = [DPAPI_SCHEME] } = {}) {
  const protection = store?.protection?.()
  if (protection === undefined) throw new Error('assertProtectedStore 需要一个 SecretStore')
  if (!allowedSchemes.includes(protection.scheme) || protection.protected !== true) {
    throw new SecretStoreError('SECRET_STORE_UNPROTECTED', { cause: `scheme=${protection.scheme}` })
  }
  return store
}

/** 便捷构造：文件 + DPAPI 的产品默认组合。 */
export function createProductSecretStore({ file, platform = process.platform, now, onAudit, exe = null } = {}) {
  const protector = createDpapiProtector({ exe, platform })
  return createSecretStore({ backend: fileBackend({ file }), protector, now, onAudit })
}
