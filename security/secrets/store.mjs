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
// - **不读 `process.env`**：配置面读取点必须可被 `scripts/config/scan.mjs` 扫描，
//   而密钥不该出现在环境变量里。
// ============================================================================

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
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

/**
 * 单文件 JSON 后端。结构刻意与 `$DSH_HOME/.credentials.yaml` 的
 * `refs → records` 引用式存储同形（PRT-003 §3.2 的结论：复用既有机制，不另建密钥库），
 * 便于将来把两处收敛到一处。
 *
 * 写入用「临时文件 + rename」：rename 在同一卷内是原子的，
 * 半截写入的密钥库比没有密钥库更危险——它会以「所有密钥都无法解密」的形式失败，
 * 而用户看不出是写入被打断了。
 */
export function fileBackend({ file, fs: fsImpl = null } = {}) {
  if (typeof file !== 'string' || file === '') throw new Error('fileBackend 需要 file 路径')
  const io = fsImpl ?? { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, dirname }
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
      const data = readAll()
      data.version = SECRET_STORE_VERSION
      data.records[ref] = { scheme: record.meta.scheme, blob: record.blob }
      data.refs[ref] = { ...record.meta }
      writeAll(data)
    },
    remove(ref) {
      const data = readAll()
      const existed = data.records[ref] !== undefined
      delete data.records[ref]
      delete data.refs[ref]
      writeAll(data)
      return existed
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
     * **只影响轮换之后创建的 Run**——在途 Run 已把凭证解析进进程内（spec §6.7），
     * 这里不需要也无法影响它们。
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
