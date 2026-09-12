// product/upgrade/manifest.mjs
// ============================================================================
// PRT-801 / PRT-802：产品版本清单与 DSH/依赖的**精确版本锁定**
//
// spec §9.1 line 674–689 给了一份不可变清单：
//
//   { productVersion, legionVersion, dshVersion, dshCompositionPatchVersion,
//     schemaVersion, runtimeContractVersion, packProtocolVersion, channel }
//
// 并补了一句本模块存在的全部理由：
//
//   「`dshCompositionPatchVersion` 与 `dshVersion` **强绑定**：补丁层通过 patch
//    锚点作用于 DSH bundle，锚点随 DSH 版本变化，因此两者必须成对验证，不允许
//    出现"DSH 已升级但补丁层仍是旧锚点"的组合。」
//
// ## 为什么"锁定版本"不是把字符串抄进去
//
// 第一层：一个版本号写成 `"^0.8.3"` 与写成 `"0.8.3"`，在清单里长得几乎一样。
// 而 `^0.8.3` 的含义是"某一天装上去的可能是 0.9.0"——也就是**清单描述的不是
// 那台机器上真正跑的东西**。所以本模块拒绝任何非精确版本（含 `*`、`^`、`~`、
// `>`、`latest`、空串），并且是按**每一个依赖**查，不只看顶层。
//
//   > 一个写着 `"^0.8.3"` 的版本清单，
//   > 与一个"清单说 0.8.3、机器上跑 0.9.0"的清单，在"出事时能不能复原现场"上
//   > 是同一个东西——只不过前者看起来是钉住的。
//
// 第二层才是 §9.1 那句话：`dshVersion` 与 `dshCompositionPatchVersion` 是两个
// 字段，但它们描述的是**一件事**。分开存是有必要的（补丁层要自己版本化），
// 分开验证就会得到下面这个东西：
//
//   > 一个"DSH 升级成功、补丁层没跟上"的安装，
//   > 与一个"强制面（ToolGuard / pre-execute / approval answerer / preset 表）
//   > 全都不在了、而进程照常起来"的安装，是同一个东西。
//
// 而它比 DSH API 变化更隐蔽：API 变了会抛错，补丁锚点失效**什么都不会发生**。
// 所以 `validateManifest` 把"成对"做成一条**显式判据**（`PATCH_PAIR_MISMATCH`），
// 由 `assertManifest` 在最外层兜住。
// ============================================================================

import { createHash } from 'node:crypto'

/** 清单自身的格式版本。改动字段集合时递增——否则历史清单无法解释。 */
export const MANIFEST_FORMAT = 'legion/version-manifest@1'

/** 三类清单消费者，顺序即 spec §9.2 的通道顺序。 */
export const CHANNELS = Object.freeze(['internal', 'canary', 'stable'])

/**
 * 精确版本号：`主.次.修订`（可带 `-预发布标识`）。
 *
 * 刻意**不接受** `v` 前缀：接受它就得决定 `v1.0.0` 与 `1.0.0` 是不是同一个版本，
 * 而两个仓库各答一次就会出现两个答案。要求写死一种写法，比容错更安全。
 */
export const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** 拒绝的版本区间记号。每一条对应一种"看起来钉住了"的写法。 */
export const RANGE_MARKERS = Object.freeze(['^', '~', '*', '>', '<', '=', '||', ' - ', '.x', '.X', 'x.', 'X.'])

/** 本模块的错误码。每一条都对应一种**会安静地错**的写法。 */
export const MANIFEST_CODES = Object.freeze({
  /** 字段缺失或类型不对。 */
  FIELD_MISSING: 'manifest-field-missing',
  /** 版本号不是精确版本。 */
  VERSION_NOT_EXACT: 'manifest-version-not-exact',
  /** 版本号形状不认识。 */
  VERSION_MALFORMED: 'manifest-version-malformed',
  /** `dshVersion` 与 `dshCompositionPatchVersion` 不成对（§9.1 line 689）。 */
  PATCH_PAIR_MISMATCH: 'manifest-patch-pair-mismatch',
  /** 依赖里有非精确版本。 */
  DEPENDENCY_NOT_EXACT: 'manifest-dependency-not-exact',
  /** 通道不认识。 */
  CHANNEL_UNKNOWN: 'manifest-channel-unknown',
  /** 两个清单不允许放在一条升级路径上。 */
  UPGRADE_NOT_ALLOWED: 'manifest-upgrade-not-allowed',
  /** 目标清单比当前清单旧。 */
  DOWNGRADE: 'manifest-downgrade',
})

function manifestError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/** 是否是精确版本。非字符串、空串、区间记号、形状不对——一律不是。 */
export function isExactVersion(value) {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (v === '') return false
  if (RANGE_MARKERS.some((m) => v.includes(m))) return false
  return EXACT_VERSION_RE.test(v)
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** 解析成 `{major, minor, patch, prerelease}`；形状不对返回 null。 */
export function parseVersion(value) {
  if (typeof value !== 'string') return null
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim())
  if (m === null) return null
  return Object.freeze({
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null,
  })
}

/**
 * 版本比较。**不能用字符串比较**：`'0.10.0' < '0.9.0'` 为真，
 * 而它会把"能否升级"整个判断反过来——且只在次版本跨过 9 的那一天翻车。
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa === null || pb === null) {
    throw manifestError(MANIFEST_CODES.VERSION_MALFORMED, `无法比较版本：${JSON.stringify(a)} / ${JSON.stringify(b)}`)
  }
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1
  }
  // 预发布版本**小于**同号正式版（SemVer 的规定）；两者都预发布时按字典序。
  if (pa.prerelease === null && pb.prerelease === null) return 0
  if (pa.prerelease === null) return 1
  if (pb.prerelease === null) return -1
  if (pa.prerelease === pb.prerelease) return 0
  return pa.prerelease < pb.prerelease ? -1 : 1
}

/** 主版本号（用于 N-1 与跨主版本判定）。 */
export function majorOf(version) {
  const p = parseVersion(version)
  if (p === null) throw manifestError(MANIFEST_CODES.VERSION_MALFORMED, `无法解析版本：${JSON.stringify(version)}`)
  return p.major
}

/** 规范化的键序 JSON —— 清单要能被签名，签名要求**同一份内容的字节完全一样**。 */
export function canonicalJson(value) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk)
    if (v !== null && typeof v === 'object') {
      const out = {}
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k])
      return out
    }
    return v
  }
  return JSON.stringify(walk(value))
}

/** 清单内容哈希（`sha256:` 前缀，与团队内部其余内容哈希口径一致）。 */
export function digestOf(manifest) {
  return `sha256:${createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex')}`
}

/**
 * 构造一份清单。**只做形状归一，不做合法性判断**——
 * 判断在 `validateManifest`，这样构造出来的坏清单可以喂给校验器当探针。
 */
export function createManifest(input = {}) {
  const out = {
    manifestFormat: input.manifestFormat ?? MANIFEST_FORMAT,
    productVersion: input.productVersion ?? null,
    legionVersion: input.legionVersion ?? null,
    dshVersion: input.dshVersion ?? null,
    dshCompositionPatchVersion: input.dshCompositionPatchVersion ?? null,
    schemaVersion: input.schemaVersion ?? null,
    runtimeContractVersion: input.runtimeContractVersion ?? null,
    packProtocolVersion: input.packProtocolVersion ?? null,
    channel: input.channel ?? null,
  }
  if (input.dependencies !== undefined) {
    out.dependencies = Object.fromEntries(
      Object.entries(input.dependencies).map(([k, v]) => [k, v]),
    )
  }
  if (input.releasedAt !== undefined) out.releasedAt = input.releasedAt
  return Object.freeze(out)
}

const REQUIRED_EXACT_VERSIONS = Object.freeze([
  ['productVersion', '产品版本'],
  ['legionVersion', 'Legion 实现版本'],
  ['dshVersion', 'DSH 引擎版本'],
])

const REQUIRED_FIELDS = Object.freeze([
  ['productVersion', 'string'],
  ['legionVersion', 'string'],
  ['dshVersion', 'string'],
  ['dshCompositionPatchVersion', 'int'],
  ['schemaVersion', 'int'],
  ['runtimeContractVersion', 'int'],
  ['packProtocolVersion', 'int'],
  ['channel', 'string'],
])

/**
 * 结构性校验。返回**逐项结论**，不是一个布尔。
 *
 * `ok` 之外必须能看见"哪一条判据在哪个字段上成立/不成立"——否则清单出了问题时
 * 排障只剩下一句"清单不合法"。
 *
 * @param {object} manifest
 * @param {{allowPrerelease?: boolean}} [options]
 */
export function validateManifest(manifest, options = {}) {
  const problems = []
  const add = (code, field, message) => problems.push(Object.freeze({ code, field, message }))

  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return Object.freeze({
      ok: false, format: MANIFEST_FORMAT,
      problems: Object.freeze([Object.freeze({
        code: MANIFEST_CODES.FIELD_MISSING, field: '(root)', message: '清单不是一个对象',
      })]),
    })
  }

  for (const [field, kind] of REQUIRED_FIELDS) {
    const v = manifest[field]
    if (kind === 'int') {
      if (!Number.isInteger(v) || v < 0) {
        add(MANIFEST_CODES.FIELD_MISSING, field, `${field} 必须是 >= 0 的整数（收到 ${JSON.stringify(v)}）`)
      }
      continue
    }
    if (!isNonEmptyString(v)) {
      add(MANIFEST_CODES.FIELD_MISSING, field, `${field} 缺失或不是非空字符串`)
    }
  }

  // ① 精确版本：逐个字段查，不是只看顶层。
  for (const [field, label] of REQUIRED_EXACT_VERSIONS) {
    const v = manifest[field]
    if (!isNonEmptyString(v)) continue // 上面已经报过缺失，不重复报
    if (!isExactVersion(v)) {
      // 「形状不对」与「写的是区间」是两件事，修法不同（改写法 vs 改取值）。
      // 分类按**是否写了区间记号**，不按解析结果：`^0.8.3` 解析不出来，
      // 但它的问题不是"这个版本号看不懂"，而是"它压根不是一个确定版本"。
      const isRange = RANGE_MARKERS.some((m) => v.includes(m))
      add(
        isRange ? MANIFEST_CODES.VERSION_NOT_EXACT : MANIFEST_CODES.VERSION_MALFORMED,
        field,
        `${label} ${field} 必须是精确版本（如 "0.8.3"），收到 ${JSON.stringify(v)}——` +
        '区间记号意味着清单描述的不是那台机器上真正跑的东西',
      )
    }
  }

  // ② §9.1 line 689：`dshVersion` 与 `dshCompositionPatchVersion` 必须成对。
  if (!Number.isInteger(manifest.dshCompositionPatchVersion) || manifest.dshCompositionPatchVersion < 1) {
    add(
      MANIFEST_CODES.PATCH_PAIR_MISMATCH, 'dshCompositionPatchVersion',
      '补丁层版本必须是 >= 1 的整数：0 或缺失表示"没有补丁层"，' +
      '而强制性 ToolGuard / pre-execute / approval answerer / preset 表全都由它挂载',
    )
  }
  if (isNonEmptyString(manifest.dshVersion) && parseVersion(manifest.dshVersion.trim()) === null) {
    add(
      MANIFEST_CODES.PATCH_PAIR_MISMATCH, 'dshVersion',
      'DSH 版本不是一个可比较的精确版本，因此无法验证"补丁层与 DSH 版本成对"',
    )
  }

  // ③ 依赖必须逐个精确。
  const deps = manifest.dependencies
  if (deps !== undefined) {
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) {
      add(MANIFEST_CODES.FIELD_MISSING, 'dependencies', 'dependencies 必须是对象')
    } else {
      for (const [name, version] of Object.entries(deps)) {
        if (!isExactVersion(version)) {
          add(
            MANIFEST_CODES.DEPENDENCY_NOT_EXACT, `dependencies.${name}`,
            `依赖 ${name} 不是精确版本：${JSON.stringify(version)}。` +
            '一个写区间的依赖等于"这次发布的组合里有一项是待定的"',
          )
        }
      }
    }
  }

  // ④ 通道。
  if (isNonEmptyString(manifest.channel) && !CHANNELS.includes(manifest.channel)) {
    add(MANIFEST_CODES.CHANNEL_UNKNOWN, 'channel', `未知通道 ${JSON.stringify(manifest.channel)}（已知：${CHANNELS.join(' / ')}）`)
  }

  // ⑤ 格式版本。
  if (manifest.manifestFormat !== MANIFEST_FORMAT) {
    add(
      MANIFEST_CODES.FIELD_MISSING, 'manifestFormat',
      `清单格式版本是 ${JSON.stringify(manifest.manifestFormat)}，本实现认识 ${MANIFEST_FORMAT}`,
    )
  }

  return Object.freeze({
    ok: problems.length === 0,
    format: MANIFEST_FORMAT,
    problems: Object.freeze(problems),
    dependencyCount: deps === undefined || deps === null ? 0 : Object.keys(deps).length,
  })
}

/** 校验失败即抛；抛出错误里带全部逐项问题。 */
export function assertManifest(manifest, options = {}) {
  const v = validateManifest(manifest, options)
  if (!v.ok) {
    const text = v.problems.map((p) => `${p.code}@${p.field}: ${p.message}`).join('\n  ')
    throw manifestError(v.problems[0].code, `版本清单不满足不变量：\n  ${text}`)
  }
  return manifest
}

// ---------------------------------------------------------------------------
// N-1 升级窗口（§9.4 line 737）
// ---------------------------------------------------------------------------

/**
 * N-1 窗口是一段**可以测的区间**，不是一句口号。
 *
 * spec line 737：「商业 Alpha 支持从当前 stable 的 N-1 版本升级到 N，不承诺
 * 跨多个主版本直接升级；更旧版本先按逐级升级或离线迁移处理。」
 *
 * 于是"窗口"就是 `[N-1, N]`：N-2 必须**被拒绝**并把下一步指出来。一个把 N-2
 * 也放过的实现与"不承诺跨主版本"这句话无关——它只是没有实现那句话。
 *
 *   > 一个"允许 N-2 直接升到 N"的升级窗口，
 *   > 与一个"没有升级窗口、每次都能升"的实现，是同一个东西。
 *
 * @returns {{allowed: boolean, code: string|null, from: string, to: string,
 *            steps: number, reason: string}}
 */
export function upgradeWindow(currentVersion, targetVersion) {
  const from = currentVersion
  const to = targetVersion
  const cmp = compareVersions(from, to)
  if (cmp === 0) {
    return Object.freeze({
      allowed: false, code: MANIFEST_CODES.UPGRADE_NOT_ALLOWED, from, to, steps: 0,
      reason: '目标版本与当前版本相同：这不是一次升级',
    })
  }
  if (cmp > 0) {
    return Object.freeze({
      allowed: false, code: MANIFEST_CODES.DOWNGRADE, from, to, steps: -1,
      reason: `目标是更旧的版本（${from} → ${to}）：降级必须走回滚路径，不是升级路径`,
    })
  }
  const pf = parseVersion(from)
  const pt = parseVersion(to)
  const fromMajor = pf.major
  const toMajor = pt.major
  if (toMajor - fromMajor > 1) {
    return Object.freeze({
      allowed: false, code: MANIFEST_CODES.UPGRADE_NOT_ALLOWED, from, to, steps: toMajor - fromMajor,
      reason: `跨 ${toMajor - fromMajor} 个主版本（${from} → ${to}）：超出 N-1 窗口，需要逐级升级或离线迁移`,
    })
  }
  // 主版本 0 是**开发期**：版本号还没有承诺，`0.x` 之间任意前后相邻都在窗口内。
  //
  // 这条分支必须显式写出来，而不是靠"主版本没变所以窗口内"顺带成立：
  // 商业 Alpha 的产品版本正是 0.x，而 1.0 之后 N-1 是一个**主版本边界**。
  // 两种语义混在一起时，`0.9.0 → 1.0.0` 会被读成"跨一个主版本、所以窗口内"，
  // 而它实际上要求当前是 `0.1.0`——也就是要求 `0.9.0` 先逐级退回去。
  //
  //   > 一个把"0.x 内部"与"1.0 边界"用同一条规则处理的窗口判定，
  //   > 与一个"0.9 能直接升到 1.0"的判定，是同一个东西——
  //   > 只不过它把 N-1 这条约束在最需要它的那一次升级上放掉了。
  if (toMajor === 0 && fromMajor === 0) {
    return Object.freeze({
      allowed: true, code: null, from, to, steps: 0,
      reason: `开发期 0.x 内升级（${from} → ${to}）`,
    })
  }
  // 同一主版本内（1.x 及以上）：逐次发布都在窗口内。
  if (toMajor === fromMajor) {
    return Object.freeze({
      allowed: true, code: null, from, to, steps: 0,
      reason: `同一主版本 ${fromMajor} 内升级（${from} → ${to}）`,
    })
  }
  // 跨主版本：当前必须恰好落在上一个边界 `(N-1).1.0`，目标是 `N.0.0`。
  const targetIsMajorBoundary = pt.minor === 0 && pt.patch === 0
  if (!targetIsMajorBoundary) {
    return Object.freeze({
      allowed: false, code: MANIFEST_CODES.UPGRADE_NOT_ALLOWED, from, to, steps: 1,
      reason: `目标 ${to} 不是主版本边界（应是 ${toMajor}.0.0）：逐级升级要求先升到边界`,
    })
  }
  if (fromMajor !== toMajor - 1 || pf.minor !== 1 || pf.patch !== 0) {
    return Object.freeze({
      allowed: false, code: MANIFEST_CODES.UPGRADE_NOT_ALLOWED, from, to, steps: toMajor - fromMajor,
      reason: `N-1 窗口要求从 ${toMajor - 1}.1.0 升到 ${to}，当前是 ${from}：` +
        '从更旧的版本直接升到边界是跨多个 N，需要逐级升级或离线迁移',
    })
  }
  return Object.freeze({
    allowed: true, code: null, from, to, steps: 1,
    reason: `N-1 窗口：主版本边界 ${from} → ${to}`,
  })
}

/**
 * 两个清单能否放在一条升级路径上。窗口判定之外，还要求 §9.1 的成对关系
 * **真的能对上**：目标清单的补丁层版本必须与它自己的 DSH 版本同名同源——
 * 我们无法在离线环境里验证锚点，所以把可验证的那一半钉死：**补丁层版本不能
 * 与 DSH 版本解耦到"只改一个"**。
 *
 * `patchPair` 是这条判据唯一能"真的发现错误"的地方：调用方把
 * `{dshVersion, dshCompositionPatchVersion}` 的**已知绑定表**传进来，
 * 表里没有这一对组合就拒。缺省不传时返回 `unverified`，而不是 `ok`——
 *
 *   > 一个"没有绑定表于是默认放行"的成对校验，
 *   > 与一个从来没有查过成对关系的校验，是同一个东西。
 */
export function checkUpgradePath(current, target, { patchPair = null } = {}) {
  const problems = []
  const add = (code, message) => problems.push(Object.freeze({ code, message }))

  const window = upgradeWindow(current.productVersion, target.productVersion)
  if (!window.allowed) add(window.code, window.reason)

  if (current.channel !== null && target.channel !== null && current.channel !== target.channel) {
    // 通道迁移由 PRT-810 判定；这里只报"两个清单不在同一条通道上"，避免
    // 升级逻辑在没读过通道策略的情况下自己决定能不能跨通道。
    add(
      MANIFEST_CODES.UPGRADE_NOT_ALLOWED,
      `清单通道不同（当前 ${current.channel} → 目标 ${target.channel}）：跨通道升级必须由通道策略决定`,
    )
  }

  let pairVerdict = 'unverified'
  if (patchPair !== null) {
    pairVerdict = patchPair === 'match' ? 'match' : 'mismatch'
    if (pairVerdict === 'mismatch') {
      add(
        MANIFEST_CODES.PATCH_PAIR_MISMATCH,
        `补丁层版本 ${target.dshCompositionPatchVersion} 与 DSH ${target.dshVersion} 不成对：` +
        '补丁锚点随 DSH 版本变化，锚点失效时进程照常启动而强制面全都不在',
      )
    }
  }

  return Object.freeze({
    allowed: problems.length === 0,
    window,
    patchPair: pairVerdict,
    problems: Object.freeze(problems),
    digest: digestOf(target),
  })
}

// ---------------------------------------------------------------------------
// 与"实际装了什么"对账（§9.1 line 691）
// ---------------------------------------------------------------------------

/**
 * spec line 691：「客户不能在产品内单独升级 DSH。启动时发现实际版本与清单不一致，
 * 应停止自动执行并引导修复，不带病运行。」
 *
 * `drift` 是本函数的全部产出：为空才是"实际与清单一致"。
 * 注意 `dshVersion` 与 `dshCompositionPatchVersion` **分开比**——只比前者会漏掉
 * 那条最隐蔽的组合（DSH 升了、补丁层没跟上）。
 */
export function reconcileObserved(manifest, observed = {}) {
  const drift = []
  const fields = [
    ['dshVersion', '实际 DSH 版本'],
    ['dshCompositionPatchVersion', '实际补丁层版本'],
    ['runtimeContractVersion', '实际 Runtime Contract 版本'],
    ['packProtocolVersion', '实际能力包协议版本'],
  ]
  for (const [field, label] of fields) {
    const actual = observed[field]
    // 观测不到**不是**一致。缺失的观测与"没有漂移"是两件事。
    if (actual === undefined || actual === null) {
      drift.push(Object.freeze({
        field, expected: manifest[field], observed: null, kind: 'unobserved',
        message: `${label}（${field}）没有观测到：没有观测不等于一致`,
      }))
      continue
    }
    if (actual !== manifest[field]) {
      drift.push(Object.freeze({
        field, expected: manifest[field], observed: actual, kind: 'mismatch',
        message: `${label}与清单不一致：清单 ${JSON.stringify(manifest[field])}，实际 ${JSON.stringify(actual)}`,
      }))
    }
  }
  return Object.freeze({
    consistent: drift.length === 0,
    drift: Object.freeze(drift),
    digest: digestOf(manifest),
  })
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/**
 * 装载期自检：把本模块的**四条**核心判据各真的跑一遍，留下**算出来的值**。
 *
 * 这里不为了"覆盖"，是为了让"这两条判据到底拦住了什么"在导入时就有据可查。
 */
export function selfCheckManifest() {
  const problems = []

  const good = createManifest({
    productVersion: '0.9.0', legionVersion: '0.9.0', dshVersion: '0.8.3',
    dshCompositionPatchVersion: 2, schemaVersion: 12, runtimeContractVersion: 1,
    packProtocolVersion: 1, channel: 'stable',
    dependencies: { 'node:sqlite': '1.0.0' },
  })
  const goodVerdict = validateManifest(good)
  if (!goodVerdict.ok) problems.push(`一份完整清单被判为不合法：${goodVerdict.problems.map((p) => p.code).join(',')}`)

  // 判据一：区间版本必须被拒。
  const ranged = validateManifest(createManifest({ ...good, dshVersion: '^0.8.3' }))
  if (ranged.ok) problems.push('区间版本 ^0.8.3 被判为精确版本')

  // 判据二：补丁层版本缺失（= 0）必须被拒——它就是 §9.1 那句"成对"的反面。
  const noPatch = validateManifest(createManifest({ ...good, dshCompositionPatchVersion: 0 }))
  if (noPatch.ok) problems.push('补丁层版本 0 被判为合法（强制面没有挂载点）')
  const pairBroken = validateManifest(createManifest({ ...good, dshVersion: '0.8.x' }))
  if (pairBroken.ok) problems.push('不可比较的 DSH 版本被判为合法（成对关系无从验证）')
  if (!pairBroken.problems.some((p) => p.code === MANIFEST_CODES.PATCH_PAIR_MISMATCH)) {
    problems.push('不可比较的 DSH 版本没有被报成"成对关系无从验证"')
  }
  if (!pairBroken.problems.some((p) => p.field === 'dshVersion' && p.code === MANIFEST_CODES.VERSION_NOT_EXACT)) {
    problems.push('0.8.x 没有被报成"写的是区间"')
  }

  // 判据三：N-2 必须被拒，N-1 必须被允许（1.x 时代才是 N-1 真正生效的时候）。
  const n2 = upgradeWindow('1.2.0', '2.0.0')
  const n1 = upgradeWindow('1.1.0', '2.0.0')
  if (n2.allowed) problems.push('1.2.0 → 2.0.0（N-2）被判为在窗口内')
  if (!n1.allowed) problems.push(`1.1.0 → 2.0.0（N-1）被判为不在窗口内：${n1.reason}`)
  const crossTwo = upgradeWindow('1.0.0', '3.0.0')
  if (crossTwo.allowed) problems.push('1.0.0 → 3.0.0（跨两个主版本）被判为在窗口内')
  const dev = upgradeWindow('0.7.0', '0.9.0')
  if (!dev.allowed) problems.push(`开发期 0.7.0 → 0.9.0 被判为不在窗口内：${dev.reason}`)

  // 判据四：观测不到版本不算一致。
  const unobserved = reconcileObserved(good, { dshVersion: '0.8.3' })
  if (unobserved.consistent) problems.push('只观测到 DSH 版本时被判为"与清单一致"')

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    format: MANIFEST_FORMAT,
    channels: CHANNELS,
    samples: Object.freeze({
      goodOk: goodVerdict.ok,
      rangedOk: ranged.ok,
      rangedCode: ranged.problems[0]?.code ?? null,
      noPatchOk: noPatch.ok,
      pairBrokenOk: pairBroken.ok,
      pairBrokenCode: pairBroken.problems[0]?.code ?? null,
      n2Allowed: n2.allowed,
      n2Code: n2.code,
      n1Allowed: n1.allowed,
      unobservedDrift: unobserved.drift.length,
      goodDigest: digestOf(good),
    }),
  })
}

/** 装载时算一次。`problems` 非空即本模块自己的判据不自洽。 */
export const MANIFEST_CHECKED = selfCheckManifest()
