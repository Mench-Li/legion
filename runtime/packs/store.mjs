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

/**
 * 五类记录。
 *
 * ★ 「没有第五类」曾经写在这里，而 `rollback` 恰恰是需要的那第五类。
 * 原文的理由是"降级不是首版协议"，但 §4.4 对 F-20 的要求是
 * **「安装可回滚」**——于是"回滚"这件事要么有一条自己的记录，
 * 要么它只能被塞进 `upgrade` 或伪装成一次 `install`。
 *
 *   > 一个「升级与降级共用一条记录」的账，
 *   > 与一个「值班的人看不出这次变动是前进还是后退」的账，是同一个东西。
 *
 * 所以补上 `rollback`：它与 `install`/`upgrade` 同属"改了生效版本"的那一类，
 * 但**方向相反**，而这个方向必须留在账上。
 */
export const PACK_RECORD_KINDS = Object.freeze(['install', 'enable', 'disable', 'upgrade', 'rollback'])

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
  /** 回滚目标不是"更低的版本"。往回走才是回滚。 */
  NOT_A_ROLLBACK: 'pack-store-not-a-rollback',
  /** 回滚目标从来没有被安装过——那是一次 install，不是回滚。 */
  ROLLBACK_TARGET_UNKNOWN: 'pack-store-rollback-target-unknown',
  /** 回滚目标就是当前版本——没有状态变化，不该写记录。 */
  ROLLBACK_NO_CHANGE: 'pack-store-rollback-no-change',
  /** 回滚目标版本在账里找不到内容哈希。 */
  ROLLBACK_TARGET_UNREADABLE: 'pack-store-rollback-target-unreadable',
  /** 重建时喂进来的账不是一本合法的账。 */
  BAD_SNAPSHOT: 'pack-store-bad-snapshot',
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
export function createPackStore({ now = () => Date.now(), history = null } = {}) {
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

  /**
   * ★ F-20 缺口②：用一本**已存在的账**重建存储。
   *
   * 这个入口存在的理由是那句自陈——"它是纯内存的"。一份重启就失忆的安装账，
   * 在生产上等价于**每次启动都认为什么都没装**：`enabledPacks()` 返回空、
   * `installedList()` 返回空，而依赖预检会拿这份空基线去判"依赖缺失"，
   * 于是重启之后每一个包都突然有了"缺依赖"的问题，而它们其实都装着。
   *
   *   > 一本重启即失忆的账，与一本从来没有写过的账，
   *   > 在"现在装了什么"这个问题上是同一个回答。
   *
   * ## 为什么坏账**整本拒绝**，而不是跳过坏的那几条
   *
   * 跳过的读数是"剩下的都是好的"。但调用方问的是"现在装了什么"——
   * 一份被跳掉三条 install 的账，会安静地回答"这三个包没装过"，
   * 而那与"这三个包真的没装过"**长得一模一样**。
   * 一半的账比没有账更坏：没有账时至少没有人会信它。
   *
   * 所以这里逐条校验，任一条不合法就抛 `BAD_SNAPSHOT` 并说明是第几条。
   */
  const restore = (incoming) => {
    const list = Array.isArray(incoming) ? incoming : incoming?.records
    if (!Array.isArray(list)) {
      throw storeError(STORE_CODES.BAD_SNAPSHOT, '重建要一份记录数组（或一个含 records 的快照）')
    }
    let prevSeq = 0
    for (let i = 0; i < list.length; i += 1) {
      const r = list[i]
      const bad = (why) => {
        throw storeError(STORE_CODES.BAD_SNAPSHOT, `第 ${i + 1} 条记录不合法（${why}），` +
          '整本账被拒绝——跳过坏记录会让"这几个包没装过"与"这几条记录坏了"变成同一个读数')
      }
      if (r === null || typeof r !== 'object') bad('不是对象')
      if (!PACK_RECORD_KINDS.includes(r.kind)) bad(`未知的记录类型 ${JSON.stringify(r.kind)}`)
      if (typeof r.packId !== 'string' || r.packId.trim() === '') bad('packId 为空')
      if (typeof r.version !== 'string' || r.version === '') bad('version 为空')
      if (!Number.isInteger(r.seq) || r.seq !== prevSeq + 1) {
        bad(`seq 必须是连续递增的整数（期望 ${prevSeq + 1}，实际 ${JSON.stringify(r.seq)}）`)
      }
      prevSeq = r.seq
      records.push(Object.freeze({ ...r }))
    }
    seq = prevSeq
  }

  if (history !== null && history !== undefined) restore(history)

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
      if (r.kind === 'install' || r.kind === 'upgrade' || r.kind === 'rollback') {
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

    /** 一个包当前的**推导**状态（`installed` / `enabled` / `activeVersion` / …）。 */
    stateOf,
    /** 一个包的全部记录（时间序）。 */
    recordsOf: (packId) => stateOf(packId).records,

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

    /**
     * ★ F-20 缺口①：回滚到一个**装过的、更低的**版本。
     *
     * `upgrade()` 的注释此前写着"降级是另一个操作（回滚）"——而那个操作
     * **不存在**。于是"安装可回滚"这条要求，在代码里没有任何落点：
     * 需要回滚的人只能去调 `install()`（会被 `ALREADY_INSTALLED` 拒掉，
     * 因为目标版本装过）或者 `upgrade()`（会被 `NOT_AN_UPGRADE` 拒掉，
     * 因为目标版本更低）。**两条路都堵着，而读数上说"升级接口存在"。**
     *
     * ## 四条拒绝，各自对应一个真实的失效方向
     *
     * · 目标**没装过** → `ROLLBACK_TARGET_UNKNOWN`。回滚是"回到一个曾经验过的
     *   版本"，不是"装一个我从没有过的版本"。把后者接受下来，"回滚"就变成了一条
     *   绕过安装预检的通道——它带着"回到已知安全版本"的名义装上一个**新的**内容。
     * · 目标**就是当前版本** → `ROLLBACK_NO_CHANGE`。与 `enable/disable` 同一条
     *   纪律：没有状态变化就不写记录，否则"这个包被回滚过几次"会变成一个
     *   没人能解释的数字。
     * · 目标**更高** → `NOT_A_ROLLBACK`。那是升级，走 `upgrade()`；
     *   两者合成一个 `setVersion()` 会让账上看不出方向，而认错方向正是
     *   事故复盘里最贵的那一步。
     * · 目标版本的**内容哈希从账里读**，**不接受调用方传 manifest**。
     *   这是这一条里最要紧的一处：接受一份新 manifest 就等于允许
     *   "同样的版本号配不同的内容"，而版本号是账上唯一的身份。
     */
    rollback({ packId, toVersion } = {}) {
      const state = requireInstalled(packId, '回滚')
      const target = String(toVersion ?? '').trim()
      if (target === '') {
        throw storeError(STORE_CODES.BAD_RECORD, '回滚必须给出目标版本')
      }
      if (target === state.activeVersion) {
        throw storeError(
          STORE_CODES.ROLLBACK_NO_CHANGE,
          `能力包 ${state.packId} 当前就是 ${target}，回滚它没有任何状态变化`,
        )
      }
      if (!state.installedVersions.includes(target)) {
        throw storeError(
          STORE_CODES.ROLLBACK_TARGET_UNKNOWN,
          `能力包 ${state.packId} 从来没有装过 ${target}，不能"回滚"到它。` +
          '回滚是回到一个**已经验过**的版本；接受一个没装过的版本，等于开着一条' +
          '绕过安装预检的通道，而它看起来叫"回滚到已知安全版本"',
        )
      }
      if (!isSemver(target)) {
        throw storeError(STORE_CODES.BAD_RECORD, `回滚目标版本不是语义版本：${JSON.stringify(target)}`)
      }
      if (compareSemver(target, state.activeVersion) >= 0) {
        throw storeError(
          STORE_CODES.NOT_A_ROLLBACK,
          `能力包 ${state.packId} 的回滚目标 ${target} 不低于当前 ${state.activeVersion}。` +
          '往前进是升级（走 upgrade），把它当回滚记会让账上的方向反过来',
        )
      }
      // 从**账**里取那一版的内容哈希，而不是从调用方手里。
      const source = [...state.records].reverse().find(
        (r) => (r.kind === 'install' || r.kind === 'upgrade') && r.version === target,
      )
      if (source === undefined) {
        throw storeError(
          STORE_CODES.ROLLBACK_TARGET_UNREADABLE,
          `能力包 ${state.packId} 的 ${target} 在账上没有留下内容哈希，无法回滚到它`,
        )
      }
      const at = now()
      return append({
        at, kind: 'rollback', packId: state.packId, version: target,
        packType: source.packType, packProtocolVersion: source.packProtocolVersion,
        contentHash: source.contentHash, declaredContentHash: source.declaredContentHash,
        trust: source.trust,
        fromVersion: state.activeVersion, fromContentHash: state.contentHash,
        verdictCodes: Object.freeze([]), preflightVersion: source.preflightVersion,
      })
    },

    /**
     * 可以回滚到哪些版本（降序）。给界面/CLI 一个**读出口**。
     *
     * 没有它，每个调用方都要自己从 `recordsOf()` 里推一遍——而"目标必须是
     * 装过的、更低的版本"这件事只要有第二个人实现，就会有两个版本，
     * 它们今天一致而没有人维持。
     */
    rollbackTargets: (packId) => {      const state = stateOf(packId)
      if (!state.installed) return Object.freeze([])
      return Object.freeze(
        state.installedVersions
          .filter((v) => isSemver(v) && compareSemver(v, state.activeVersion) < 0)
          .sort((a, b) => compareSemver(b, a)),
      )
    },

    /**
     * ★ F-20 缺口②的另一半：把账交出去，以便持久化。
     *
     * 形态带 `version`：账的形状变了，读账的人要能**看出来**，
     * 而不是把一本按旧规则写的账读成"记录少了"。
     */
    snapshot: () => Object.freeze({
      version: PACK_STORE_VERSION,
      seq,
      records: Object.freeze([...records]),
    }),
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
