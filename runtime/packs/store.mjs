// runtime/packs/store.mjs
// ============================================================================
// PRT-1003：安装、启用、停用和升级**记录**。
//
// spec §6.13 line 568：「安装、启用、停用和升级记录。」
//
// ---------------------------------------------------------------------------
// ① 记录不是日志，是**状态的唯一来源**
//
// 最省事的写法是维护一个可变的 `installed: Map<packId, entry>`，顺手把每次操作
// 打一行日志。它在一个方向上是对的——查"现在装了什么"很快；而在另一个方向上
// 是错的：**"它什么时候被停用的、是谁停的、当时装的是哪个版本"从日志里拼不出来**，
// 因为日志是给人看的文本，不是可以复算的状态。
//
//   > 一个「边上有个 installed 表、旁边再打一行日志」的存储，
//   > 与一个「日志里偶尔缺一条，而表看起来完全正常」的存储，是同一个东西——
//   > 只不过前者在排查"为什么这个包是停用状态"时，只有一句无从核对的文本。
//
// 所以这里反过来：**记录是唯一的账**，`stateOf()` 是账的**推导**。
// 推导出来的状态与账不一致在结构上不可能（它每次都是重算的），
// 而"记录被改过"这件事由 `records` 的不可变与 `seq` 单调守住。
//
// ---------------------------------------------------------------------------
// ② 没有预检结论的安装，等于"没人验过的包"
//
// `install` 的入参里必须有 `verdict`（预检结论），而且 `verdict.ok` 必须为真、
// 它算出来的 `contentHash` 必须与 manifest 里写的相等。
//
//   > 一个「接口上留一个 withoutVerification 开关的安装」，
//   > 与一个「只要有人手滑一次，账上就多一个没人验过的包」的安装，是同一个东西。
//
// 所以这里**没有**那条开关：预检结论是必填参数，且要与 manifest 对得上。
// ============================================================================

import { compareSemver, isSemver, PACK_MANIFEST_VERSION, PACK_TRUST_LEVELS } from './manifest.mjs'

/** 记录账本的形态版本。账的形状变了，读账的人要能看出来。 */
export const PACK_STORE_VERSION = 'legion/pack-store@1'

/** 四类记录。**没有第五类**——"更新一下元数据"这种操作不在首版协议里。 */
export const PACK_RECORD_KINDS = Object.freeze(['install', 'enable', 'disable', 'upgrade'])

export const STORE_CODES = Object.freeze({
  /** 安装/升级没有带预检结论。 */
  NO_VERDICT: 'pack-store-no-preflight-verdict',
  /** 预检结论是"不通过"。 */
  VERDICT_REJECTED: 'pack-store-preflight-rejected',
  /** 预检算出的内容哈希与 manifest 里写的不一致。 */
  VERDICT_MISMATCH: 'pack-store-verdict-manifest-mismatch',
  /** 同一个版本装了两次。 */
  ALREADY_INSTALLED: 'pack-store-already-installed',
  /** 这个包从来没装过。 */
  NOT_INSTALLED: 'pack-store-not-installed',
  /** 启用了没装过的包。 */
  ENABLE_WITHOUT_INSTALL: 'pack-store-enable-without-install',
  /** 打包内容与已安装版本完全相同——升级会写一条没有变化的记录。 */
  UPGRADE_NO_CHANGE: 'pack-store-upgrade-no-change',
  /** 目标版本不比当前版本高。降级是另一个操作（回滚），不走这里。 */
  NOT_AN_UPGRADE: 'pack-store-not-an-upgrade',
  /** 记录不合法（调用方直接喂了坏数据）。 */
  BAD_RECORD: 'pack-store-bad-record',
})

function storeError(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

/**
 * 从一个"预检结论 + manifest"得出这条记录里该写下的字段。
 *
 * 这一层存在的唯一理由是**把对表放在一处**：
 *
 *   > 一个「记录字段在 install 与 upgrade 里各写一遍」的存储，
 *   > 与一个「两条路径对同一个包写下不同 metadata」的存储，是同一个东西。
 */
function metaFrom({ manifest, verdict, at, kind, fromVersion = null, fromContentHash = null }) {
  if (verdict === undefined || verdict === null || typeof verdict !== 'object') {
    throw storeError(
      STORE_CODES.NO_VERDICT,
      `拒绝在没有预检结论的情况下记录 ${kind}——` +
      '一个"接口上留一个跳过校验的开关"的安装，与一个"只要有人手滑一次账上就多一个没人验过的包"的安装，是同一个东西',
    )
  }
  if (verdict.ok !== true) {
    throw storeError(
      STORE_CODES.VERDICT_REJECTED,
      `预检没有通过（${verdict.code ?? 'unknown'}），不能记录 ${kind}：${JSON.stringify((verdict.problems ?? []).map((p) => p.code))}`,
    )
  }
  if (manifest === null || typeof manifest !== 'object' || manifest.manifestVersion !== PACK_MANIFEST_VERSION) {
    throw storeError(STORE_CODES.BAD_RECORD, `${kind} 需要一份已归一化的 manifest（${PACK_MANIFEST_VERSION}）`)
  }
  const computed = verdict.computed?.contentHash ?? null
  if (computed === null || computed !== manifest.contentHash) {
    throw storeError(
      STORE_CODES.VERDICT_MISMATCH,
      `预检算出的内容哈希（${computed}）与 manifest 里写的（${manifest.contentHash}）不一致——` +
      '账上记的必须是**算出来的**那一个，否则这条记录只是在抄作者的声明',
    )
  }
  const trust = verdict.computed?.trust ?? null
  if (!PACK_TRUST_LEVELS.includes(trust)) {
    throw storeError(STORE_CODES.NO_VERDICT, `预检结论里没有合法的来源等级（${JSON.stringify(trust)}）`)
  }
  return Object.freeze({
    seq: -1, // 由 append 填
    at,
    kind,
    packId: manifest.packId,
    version: manifest.version,
    packType: manifest.packType,
    packProtocolVersion: manifest.packProtocolVersion,
    contentHash: computed,
    declaredContentHash: manifest.contentHash,
    trust,
    fromVersion,
    fromContentHash,
    // 留证：预检当时**逐条**给出了什么。没有它，一条"通过"的记录只是四个字。
    verdictCodes: Object.freeze((verdict.problems ?? []).map((p) => p.code)),
    preflightVersion: verdict.version ?? null,
  })
}

/**
 * 建一个能力包存储。
 *
 * 它是**纯内存**的：spec §6.13 的首版不做在线市场，而"安装记录"要进的是
 * 产品库（§7 的迁移列了一堆表，但没有 pack 那几张）。这里先把**语义**与
 * **不可变性**做出来并被用例钉住；持久化接线是另一件事，接到那一层时
 * 这里的每一条拒绝码都还要成立。
 */
export function createPackStore({ now = () => Date.now() } = {}) {
  if (typeof now !== 'function') throw storeError(STORE_CODES.BAD_RECORD, 'now 必须是函数')
  /** 唯一的账。只追加，元素冻结。 */
  const records = []
  let seq = 0

  const append = (meta) => {
    seq += 1
    const record = Object.freeze({ ...meta, seq })
    records.push(record)
    return record
  }

  /** 账的推导：一个包的全部状态。 */
  const stateOf = (packId) => {
    const id = String(packId ?? '').trim()
    const mine = records.filter((r) => r.packId === id)
    if (mine.length === 0) {
      return Object.freeze({
        packId: id, installed: false, enabled: false,
        installedVersions: Object.freeze([]), activeVersion: null,
        contentHash: null, trust: null, records: Object.freeze([]),
      })
    }
    const installedVersions = Object.freeze([...new Set(
      mine.filter((r) => r.kind === 'install' || r.kind === 'upgrade').map((r) => r.version),
    )])
    let enabled = false
    let activeVersion = null
    let contentHash = null
    let trust = null
    for (const r of mine) {
      if (r.kind === 'install' || r.kind === 'upgrade') {
        activeVersion = r.version
        contentHash = r.contentHash
        trust = r.trust
      } else if (r.kind === 'enable') {
        enabled = true
      } else if (r.kind === 'disable') {
        enabled = false
      }
    }
    return Object.freeze({
      packId: id,
      installed: true,
      enabled,
      installedVersions,
      activeVersion,
      contentHash,
      trust,
      records: Object.freeze(mine),
    })
  }

  const requireInstalled = (packId, kind) => {
    const s = stateOf(packId)
    if (!s.installed) {
      throw storeError(
        STORE_CODES.NOT_INSTALLED,
        `能力包 ${JSON.stringify(String(packId ?? ''))} 没有安装记录，不能 ${kind}`,
      )
    }
    return s
  }

  return Object.freeze({
    version: PACK_STORE_VERSION,

    /** 安装一个版本。同版本重复安装拒绝（不是幂等吞掉）。 */
    install({ manifest, verdict } = {}) {
      const at = now()
      const state = stateOf(manifest?.packId)
      if (state.installedVersions.includes(manifest?.version)) {
        throw storeError(
          STORE_CODES.ALREADY_INSTALLED,
          `能力包 ${manifest?.packId}@${manifest?.version} 已经装过了。` +
          '同版本重复安装要么是调用方搞错了版本，要么是它以为自己装的是另一个包——两种都不该静默吞掉',
        )
      }
      return append(metaFrom({ manifest, verdict, at, kind: 'install' }))
    },

    /**
     * 启用。返回 `{changed, record}`。
     *
     * 已经是启用状态时不再写一条记录：**"又按了一次启用"不是一次状态变化**，
     * 而账里多出来的一条会让"这个包被启用过几次"这个数字变成没人能解释的东西。
     */
    enable(packId) {
      const state = requireInstalled(packId, '启用')
      if (state.enabled) return Object.freeze({ changed: false, record: null, state })
      const at = now()
      const record = append({
        at, kind: 'enable', packId: state.packId, version: state.activeVersion,
        packType: null, packProtocolVersion: null,
        contentHash: state.contentHash, declaredContentHash: null, trust: state.trust,
        fromVersion: null, fromContentHash: null, verdictCodes: Object.freeze([]), preflightVersion: null,
      })
      return Object.freeze({ changed: true, record, state: stateOf(packId) })
    },

    /** 停用。与启用同一条纪律：没有状态变化就不写记录。 */
    disable(packId) {
      const state = requireInstalled(packId, '停用')
      if (!state.enabled) return Object.freeze({ changed: false, record: null, state })
      const at = now()
      const record = append({
        at, kind: 'disable', packId: state.packId, version: state.activeVersion,
        packType: null, packProtocolVersion: null,
        contentHash: state.contentHash, declaredContentHash: null, trust: state.trust,
        fromVersion: null, fromContentHash: null, verdictCodes: Object.freeze([]), preflightVersion: null,
      })
      return Object.freeze({ changed: true, record, state: stateOf(packId) })
    },

    /**
     * 升级到一个**更高**的版本。
     *
     * ★ 降级不走这里。一次"降级"在账上与"升级"长得一样（都是一条 install 类的
     * 记录），而两者的**方向**相反；把它们合成一个 `setVersion()` 的接口，
     * 等于让"回到上一个版本"这件事在账上无法与"前进到下一个版本"区分。
     *
     *   > 一个「升级与降级共用一条记录」的账，
     *   > 与一个「值班的人看不出这次变动是前进还是后退」的账，是同一个东西。
     */
    upgrade({ manifest, verdict } = {}) {
      const state = requireInstalled(manifest?.packId, '升级')
      const computed = verdict?.computed?.contentHash ?? null
      if (verdict?.ok === true && computed !== null && computed === state.contentHash) {
        throw storeError(
          STORE_CODES.UPGRADE_NO_CHANGE,
          `能力包 ${manifest?.packId} 的内容哈希与当前版本完全相同（${computed}）——` +
          '版本号变了而内容没变，要么是作者忘了改内容，要么是这条记录写不出任何信息',
        )
      }
      if (!isSemver(manifest?.version)) {
        throw storeError(STORE_CODES.BAD_RECORD, `升级目标版本不是语义版本：${JSON.stringify(manifest?.version)}`)
      }
      if (compareSemver(manifest.version, state.activeVersion) <= 0) {
        throw storeError(
          STORE_CODES.NOT_AN_UPGRADE,
          `能力包 ${manifest?.packId} 的目标版本 ${manifest.version} 不高于当前 ${state.activeVersion}。` +
          '降级是另一个操作（回滚），把它塞进 upgrade 会让账上看不出方向',
        )
      }
      const at = now()
      return append(metaFrom({
        manifest, verdict, at, kind: 'upgrade',
        fromVersion: state.activeVersion, fromContentHash: state.contentHash,
      }))
    },

    stateOf,
    /** 一个包的全部记录（时间序）。 */
    recordsOf: (packId) => stateOf(packId).records,
    /** 整本账。返回的是**副本**，改它不影响账。 */
    history: () => Object.freeze([...records]),
    /** 当前处于启用状态的包（账的推导，不是另一份表）。 */
    enabledPacks: () => Object.freeze(
      [...new Set(records.map((r) => r.packId))].filter((id) => stateOf(id).enabled).sort(),
    ),
    /** 当前生效的版本表，供**依赖预检**当基线用（`preflightManifest` 的 `installed`）。 */
    installedList: () => Object.freeze(
      [...new Set(records.map((r) => r.packId))]
        .map((id) => stateOf(id))
        .filter((s) => s.installed)
        .map((s) => Object.freeze({ packId: s.packId, version: s.activeVersion, contentHash: s.contentHash, enabled: s.enabled }))
        .sort((a, b) => (a.packId < b.packId ? -1 : 1)),
    ),
  })
}
