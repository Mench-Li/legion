// team-hub/probe-service.mjs
// ============================================================================
// 把 PRT-504 的模型探测接到 Workbench 上（PRT-507 的「测试连接」后端）
//
// ## 为什么需要这个模块
//
// PRT-504 交付了 `runtime/probe/index.mjs` + `runtime/probe/http.mjs` + 两个套件，
// 但**没有任何非测试代码调用它**——`git grep createModelProbe` 的非测试命中
// 只有它自己的实现文件。也就是说：
//
//   「测试连接」这个功能整套都在，而**没有任何入口能触发它**。
//
// 这与 PRT-509 的 ACL runner 是同一个形态：功能有了、用例也有了，
// **而线的那一端没插上**。区别只是那次空的是"线中间那一截"，
// 这次空的是**整条线的外部端口**。
//
// ## 设计约束
//
// ### ① 密钥库打不开时，**不产生判定**
//
// 探测需要凭证。如果密钥库打不开（DPAPI 不可用 / 文件坏 / 布局不合法），
// 我们**没有问过供应商**。此时返回任何 `ok:false` 的探测判定都是**撒谎**——
// 它会显示成"模型连不上"，而真相是"我们连钥匙都没拿到"。
//
// 所以这里返回一个**独立的** `PROBE_UNAVAILABLE` 结果，文案明确说
// "这次没有探测过"。前端据此显示"无法测试"，而不是"测试失败"。
//
// 两种错法的代价不对称：说成"连不上"会让用户去查网络与供应商状态
// （一条完全错误的方向），而说成"没测过"只会让他去查密钥库。
//
// ### ② 布局解析失败也不伪装成探测失败
//
// 同上。`layoutDiagnostics` 有 error 时我们连密钥库在哪都不知道。
//
// ### ③ 探测实例**按密钥库生命周期缓存**
//
// 每次点击都重新开一次 DPAPI 会白花代价，但缓存**必须**在密钥库变化时失效。
// 这里用的是最保守的做法：只缓存"打开成功"的那一个，并提供一个
// `invalidate()` 由轮换/修改凭证的路径调用；**不做基于时间的猜测**。
// ============================================================================

import { createHttpTransport } from '../runtime/probe/http.mjs'
import { createModelProbe } from '../runtime/probe/index.mjs'

/** 探测不可用的原因码。它们**都不是**探测判定。 */
export const PROBE_UNAVAILABLE_CODES = Object.freeze({
  /** 布局不合法（密钥库位置本身是错的） */
  LAYOUT_BLOCKED: 'PROBE_LAYOUT_BLOCKED',
  /** 密钥库打不开（损坏 / 平台不支持 / 没配） */
  SECRETS_UNAVAILABLE: 'PROBE_SECRETS_UNAVAILABLE',
  /** 档案没有 secretRef，而这家供应商需要凭证 */
  NO_CREDENTIAL_REF: 'PROBE_NO_CREDENTIAL_REF',
})

/**
 * 造一条"这次没有探测过"的结果。
 *
 * **结构与探测判定刻意不同**：它没有 `class`（没有失败分类可言），
 * 但有 `unavailable: true`。调用方必须显式分支，不能顺手把它读成判定。
 */
export function unavailableResult(code, message, { detail = null } = {}) {
  return Object.freeze({
    ok: false,
    unavailable: true,
    code,
    message,
    detail,
  })
}

/**
 * 创建探测服务。
 *
 * 依赖全部可注入，于是"密钥库打不开时会发生什么"可以被确定性地测到，
 * 而不需要在一台真的能开 DPAPI 的机器上制造一次失败。
 */
export function createProbeService({
  // 返回 `{ layout, diagnostics }`；缺省用真实的 `resolveLayout`
  resolveLayoutImpl = null,
  // 返回 `openProductSecrets(...)` 的产物；缺省用真实的实现
  openSecrets = null,
  env = process.env,
  transport = null,
  clock = () => Date.now(),
  ttlMs = undefined,
  negativeTtlMs = undefined,
  // 打开密钥库时要显式给出的 ACL 所有者。**不猜**（同 product/secrets.mjs）。
  owner = null,
  platform = process.platform,
  fetchImpl = undefined,
} = {}) {
  /** 打开成功的密钥库（含 resolver）。失败时保持 null，下次点击重试。 */
  let opened = null
  let openedFor = null
  /** 探测实例与它绑定的密钥库；密钥库一换，探测缓存必须一起换。 */
  let probe = null
  let transportImpl = transport

  async function openStore() {
    if (opened !== null) return { ok: true, ...opened }

    const { layout, diagnostics } = await resolveLayoutNow()
    if (Array.isArray(diagnostics) && diagnostics.some((d) => d.severity === 'error')) {
      return {
        ok: false,
        result: unavailableResult(PROBE_UNAVAILABLE_CODES.LAYOUT_BLOCKED,
          '无法测试连接：产品目录布局未确定，因此不知道密钥库在哪里。**这次没有探测过**。',
          { detail: diagnostics.filter((d) => d.severity === 'error').map((d) => d.code).join(',') }),
      }
    }

    const check = await openSecretsImpl({ layout, platform, owner })
    if (check?.ok !== true) {
      return {
        ok: false,
        result: unavailableResult(PROBE_UNAVAILABLE_CODES.SECRETS_UNAVAILABLE,
          `无法测试连接：密钥库打不开（${check?.code ?? '未知'}）。` +
          '**这次没有探测过**——这不是"模型连不上"，别去查网络。',
          { detail: check?.code ?? null }),
      }
    }

    opened = { layout, check, resolver: check.resolver, storePath: check.path ?? null }
    openedFor = check.path ?? layout?.secretsFile ?? null
    return { ok: true, ...opened }
  }

  async function resolveLayoutNow() {
    if (typeof resolveLayoutImpl === 'function') {
      return await resolveLayoutImpl({ env })
    }
    const mod = await import('../product/paths.mjs')
    return mod.resolveLayout({ env })
  }

  async function openSecretsImpl(args) {
    if (typeof openSecrets === 'function') return await openSecrets(args)
    const mod = await import('../product/secrets.mjs')
    return mod.openProductSecrets({ ...args, requireProtected: true })
  }

  function ensureProbe(resolver) {
    if (probe !== null) return probe
    const t = transportImpl ?? createHttpTransport({ fetchImpl })
    transportImpl = t
    const opts = { transport: t, clock }
    // 只在显式给出时传，避免用 `undefined` 覆盖掉契约里的默认 TTL。
    if (ttlMs !== undefined) opts.ttlMs = ttlMs
    if (negativeTtlMs !== undefined) opts.negativeTtlMs = negativeTtlMs
    if (typeof resolver?.resolveSecret === 'function') opts.resolveSecret = resolver.resolveSecret
    if (typeof resolver?.credentialVersionOf === 'function') opts.credentialVersionOf = resolver.credentialVersionOf
    probe = createModelProbe(opts)
    return probe
  }

  return Object.freeze({
    /**
     * 探测一个模型档案。
     *
     * @param {object} profile 产品登记的模型档案（含 provider/model/endpoint/secretRef）
     * @param {object} [opts]
     * @param {string[]} [opts.requiredCapabilities]
     * @param {boolean}  [opts.force] 忽略新鲜缓存，强制真探一次
     */
    async probeModelProfile(profile, { requiredCapabilities = [], force = false } = {}) {
      if (profile === null || typeof profile !== 'object') {
        return unavailableResult(PROBE_UNAVAILABLE_CODES.NO_CREDENTIAL_REF, '没有给出模型档案。')
      }
      // 没有 endpoint 就没法探。这是**配置缺失**，不是供应商故障。
      const endpoint = typeof profile.endpoint === 'string' ? profile.endpoint.trim() : ''
      if (endpoint === '') {
        return unavailableResult(PROBE_UNAVAILABLE_CODES.LAYOUT_BLOCKED,
          '无法测试连接：这个档案没有填 endpoint。**这次没有探测过**。',
          { detail: 'endpoint' })
      }

      const store = await openStore()
      if (store.ok !== true) return store.result

      const p = ensureProbe(store.resolver)
      // 判定由执行器给出；这里**不加任何解释性包装**——
      // 包装会让"哪里出的结论"变得模糊，而这一整条链路的可诊断性
      // 恰恰依赖"判定只有一处产生"。
      return await p.probe({ profile, requiredCapabilities, force })
    },

    /**
     * 让探测缓存失效。
     *
     * 在**轮换/删除/新增凭证**之后必须调用：缓存键里含凭证版本，
     * 但"密钥库本身换了文件"这件事只有调用方知道。
     */
    invalidate(profileId = undefined) {
      if (probe !== null && profileId !== undefined) return probe.invalidate(profileId)
      const had = probe !== null
      probe = null
      opened = null
      openedFor = null
      return had ? 1 : 0
    },

    /**
     * 只读状态，供诊断与用例断言。**不含任何凭证，也不含引用名。**
     *
     * 这里只取 `size` 而**不**取 `probe.inspect().entries`：缓存键是
     * `profileId\u0000fingerprint`，而 fingerprint **含 `secretRef` 的引用名**
     * （那是刻意的——同一引用名下换钥匙必须让判定重来）。但引用名一旦进了
     * 诊断快照，就能画出"这台机器配了哪些供应商"，而那正是 PRT-254 明确
     * 禁止的（`product/secrets.test.mjs` 有用例守着）。
     *
     * **能算出指纹 ≠ 该把指纹写进日志。**
     */
    inspect() {
      const snap = probe === null ? null : probe.inspect()
      return Object.freeze({
        opened: opened !== null,
        storePath: openedFor,
        hasProbe: probe !== null,
        cacheSize: snap === null ? 0 : snap.size,
        cacheCodes: snap === null ? Object.freeze([]) : Object.freeze(snap.entries.map((e) => e.code)),
      })
    },
  })
}
