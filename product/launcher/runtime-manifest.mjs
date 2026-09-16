// product/launcher/runtime-manifest.mjs
// ============================================================================
// PRT-257 缺口① 与 缺口②：**§9.1 清单到底能不能由这个仓库生成**。
//
// ## 缺口①是什么
//
// spec §9.1（`2026-09-11-legion-product-runtime-design.md:679-698`）要求
// 「每个产品版本携带不可变清单」，八个字段：
//
//   productVersion / legionVersion / dshVersion / dshCompositionPatchVersion
//   schemaVersion / runtimeContractVersion / packProtocolVersion / channel
//
// 而在此之前，**产品里没有任何一份这样的清单**：`releases/*/MANIFEST.json`
// 全部是**构建清单**（`name: "legion-release"`、`gitHead`、`platform`、
// `distFiles`、`ciStages`），字段名与 §9.1 **一个都不重合**。
// 于是 `--runtime-install-plan` 在真实机器上只能退出 3（`RUNTIME_PLAN_NO_MANIFEST`），
// 用户必须手工写一份。
//
//   > 一个"清单格式有校验器、有 33 条用例"的产品，
//   > 与一个"发出去的每一个版本里都没有那份清单"的产品，
//   > 在测试报告上是同一个东西——只不过前者的绿全部来自自己造的夹具。
//
// ## 这个模块做什么、**不**做什么
//
// 它做一件很小的事：**把八个字段逐个问一遍「你的值从哪来」**，然后把
// 「这个仓库里真的有权威来源」的那几个**读出来**，把剩下的**列出来**。
//
// 它**不**做的那件事更重要：它**不**给任何字段编一个看起来合理的默认值。
// 一份编出来的清单比没有清单更坏——`installRuntime` 会照着它去锁一个
// 具体的 DSH 版本、`dshPatchPairOf()` 会照着它去判补丁层成对，
// 于是"我们按 A 版本验的"会变成"我们按一个没人决定过的版本验的"。
//
//   > 一个"缺清单就拒绝启动"的产品，
//   > 与一个"缺清单就现编一份"的产品，在厂商的机器上都能起来——
//   > 只不过后者的清单里写着厂商的猜测，而它会被当成合同。
//
// ## 逐个字段的来源（这就是缺口①的完整答案）
//
// | 字段 | 本仓库里有没有权威来源 |
// |---|---|
// | `dshCompositionPatchVersion` | **有**：`runtime/dsh-composition/patch-layer.mjs` 的 `DSH_COMPOSITION_PATCH_VERSION` |
// | `runtimeContractVersion` | **有**：`runtime/contracts/adapter.mjs` 的 `RUNTIME_CONTRACT_VERSION` |
// | `packProtocolVersion` | **有**：`runtime/packs/manifest.mjs` 的 `PACK_PROTOCOL_VERSION` |
// | `schemaVersion` | **没有**：仓库里从来没有一个"数据面 schema 版本"常量 |
// | `dshVersion` | **没有**：仓库里没有一处 DSH 版本 pin（除了用例夹具）。它是**发布决定**（这一版支持哪个 DSH） |
// | `productVersion` / `legionVersion` | **没有**：仓库连根 `package.json` 都没有，没有版本源的载体 |
// | `channel` | **没有**：通道是发布决定（internal / canary / stable） |
//
// 三个"有来源"的字段里，`dshCompositionPatchVersion` **就是**缺口②的答案：
// 它不再需要由那份清单自证（见下）。五个"没有来源"的字段必须由发布流程
// 写进来——本模块把它们做成**必填参数**，缺任何一个都返回具名拒绝。
//
// ## 缺口②是什么，以及它现在能被证到什么程度
//
// `planRuntimeInstall()` 的 `patchBindings` 是"已知可用的
// `(dshVersion, dshCompositionPatchVersion)` 绑定表"。在此之前，那份表的
// **唯一输入**就是待装的那份清单本身，于是"清单说的"与"表说的"永远一致：
//
//   > 一个"用自己的值校验自己"的检查，
//   > 与一个没有这个检查的实现，在每一次运行里都是同一个结论。
//
// 现在这一层能证的比之前多一件事：`dshCompositionPatchVersion` 有**第二个**
// 独立来源——`runtime/dsh-composition/patch-layer.mjs` 的声明。
// 于是可以做成一次真正的交叉验证：
//
//   清单里的 `dshCompositionPatchVersion` 必须等于**仓库里那份补丁层声明的版本**。
//
// 两边不一致时该怎么读，本模块刻意**不替用户决定**：它是"清单写错了"还是
// "仓库里的补丁层被改了却没重新出清单"，取决于哪一边先动。返回的拒绝里
// 把两边都印出来，让人自己判。
//
// **说清楚还差什么**：`dshVersion` 那一半仍然没有第二个来源。
// "哪个 DSH 版本与哪一版补丁层配对"是一张**经验表**（来自一次真的装配过、
// 真的自检过），而本仓库里没有一次真实的装配记录可查。
// 所以 `patchBindings` 里的 `dshVersion` 列**仍然只能由人给**；
// 这一层只能保证"补丁层那一列与仓库里的声明一致"。
// 这一条残余在代码里以 `PATCH_PAIR_SOURCE` 这个读数存在，不靠注释。
// ============================================================================

import { DSH_COMPOSITION_PATCH_VERSION } from '../../runtime/dsh-composition/index.mjs'
import { RUNTIME_CONTRACT_VERSION } from '../../runtime/contracts/adapter.mjs'
import { PACK_PROTOCOL_VERSION } from '../../runtime/packs/manifest.mjs'
import { MANIFEST_FORMAT, CHANNELS, validateManifest } from '../upgrade/manifest.mjs'

/** 本模块的版本。 */
export const RUNTIME_MANIFEST_VERSION = 1

export const RUNTIME_MANIFEST_CODES = Object.freeze({
  /** 缺一个只能由人决定的字段。 */
  FIELD_UNDECIDED: 'RUNTIME_MANIFEST_FIELD_UNDECIDED',
  /** 清单里的补丁层版本与仓库里那份声明的版本不一致。 */
  PATCH_VERSION_MISMATCH: 'RUNTIME_MANIFEST_PATCH_VERSION_MISMATCH',
  /** 组装出来的清单没通过**生产校验器**（`validateManifest`）。 */
  INVALID: 'RUNTIME_MANIFEST_INVALID',
})

/**
 * 八个字段逐个的**来源**。这是缺口①的机器可读形式，不是一段散文。
 *
 * `derivable: true` 的字段由 `deriveManifestFields()` 从**真实常量**读出；
 * `false` 的字段必须由调用方显式给出，否则 `buildVersionManifest()` 具名拒绝。
 *
 * `source` 是给人看的源路径；`why` 说清"为什么它推不出来"——一句"需要人工决定"
 * 不足以让下一个人知道**该去哪里决定**。
 */
export const MANIFEST_FIELD_SOURCES = Object.freeze([
  Object.freeze({
    field: 'dshCompositionPatchVersion', derivable: true,
    source: 'runtime/dsh-composition/patch-layer.mjs → DSH_COMPOSITION_PATCH_VERSION',
    why: '补丁层自己在代码里声明它锚定哪一版 DSH 组合（spec §9.1 要求它与 dshVersion 成对验证）',
  }),
  Object.freeze({
    field: 'runtimeContractVersion', derivable: true,
    source: 'runtime/contracts/adapter.mjs → RUNTIME_CONTRACT_VERSION',
    why: '适配器契约的版本就写在实现里，清单只是把它抄给客户',
  }),
  Object.freeze({
    field: 'packProtocolVersion', derivable: true,
    source: 'runtime/packs/manifest.mjs → PACK_PROTOCOL_VERSION',
    why: '包协议版本同上：实现是权威来源',
  }),
  Object.freeze({
    field: 'schemaVersion', derivable: false,
    source: null,
    why: '仓库里没有任何一个"数据面 schema 版本"常量。这个字段要由发布流程定义'
      + '（它说的是这一版产品写出来的数据面形状，客户升级时按它判兼容）',
  }),
  Object.freeze({
    field: 'dshVersion', derivable: false,
    source: null,
    why: '仓库里没有一处 DSH 版本 pin（用例夹具里的 0.1.5-rc.2 是夹具，不是决定）。'
      + '它是**发布决定**：这一版产品带的是哪一个 DSH。装的时候会被锁成 =<这个值>',
  }),
  Object.freeze({
    field: 'productVersion', derivable: false,
    source: null,
    why: '仓库里没有版本源的载体（没有 package.json）。产品版本号由发布流程给',
  }),
  Object.freeze({
    field: 'legionVersion', derivable: false,
    source: null,
    why: '同上。它与 productVersion 可以不同：产品版本对外，实现版本对内',
  }),
  Object.freeze({
    field: 'channel', derivable: false,
    source: null,
    why: `通道是发布决定，取值只有 ${CHANNELS.join(' / ')}。它推不出来——`
      + '同一份代码可以走 internal 也可以走 stable',
  }),
])

/**
 * `patchBindings` 那张表的**来源**读数。缺口②的诚实边界就挂在这上面。
 *
 * `dshVersion` 那一列只能是 `human`：本仓库里没有一次真实装配记录可查，
 * 而"哪一版 DSH 配哪一版补丁层"正是那种只能由一次真实装配产出的知识。
 */
export const PATCH_PAIR_SOURCE = Object.freeze({
  compositionPatchVersion: Object.freeze({
    source: 'repo-declaration',
    detail: 'runtime/dsh-composition/patch-layer.mjs → DSH_COMPOSITION_PATCH_VERSION（可交叉验证）',
  }),
  dshVersion: Object.freeze({
    source: 'human',
    detail: '本仓库里没有真实装配记录，无法推出；只能由一次真的装过并自检过的人给出',
  }),
})

/** 只把"有权威来源"的三个字段读出来。**没有任何字面量版本号。** */
export function deriveManifestFields() {
  return Object.freeze({
    dshCompositionPatchVersion: DSH_COMPOSITION_PATCH_VERSION,
    runtimeContractVersion: RUNTIME_CONTRACT_VERSION,
    packProtocolVersion: PACK_PROTOCOL_VERSION,
  })
}

/** 这份仓库**推不出来**、必须由发布流程给出的字段名。 */
export function undecidedManifestFields() {
  return Object.freeze(MANIFEST_FIELD_SOURCES.filter((f) => f.derivable !== true).map((f) => f.field))
}

function refuse(code, message, extra = {}) {
  return Object.freeze({ version: RUNTIME_MANIFEST_VERSION, ok: false, code, message, ...extra })
}

/**
 * ★ 缺口②的交叉验证：清单里的补丁层版本 vs **仓库里那份声明的**版本。
 *
 * 两边不一致时把两边都印出来；**不猜**哪一边是对的。
 * 一个"以仓库为准、悄悄改掉清单"的实现，会把一次"清单写错了"变成一次
 * 不声不响的版本变更——而那正是这份清单存在的理由（它是合同）。
 */
export function checkPatchVersionAgainstRepo(manifest) {
  const declared = manifest?.dshCompositionPatchVersion
  const repo = DSH_COMPOSITION_PATCH_VERSION
  if (declared === repo) {
    return Object.freeze({
      version: RUNTIME_MANIFEST_VERSION, ok: true, code: null, manifestValue: declared, repoValue: repo,
      source: PATCH_PAIR_SOURCE.compositionPatchVersion.source,
      message: `补丁层版本两边一致：${repo}`,
    })
  }
  return refuse(
    RUNTIME_MANIFEST_CODES.PATCH_VERSION_MISMATCH,
    `清单说补丁层是 ${JSON.stringify(declared)}，而仓库里那份补丁层声明的是 ${JSON.stringify(repo)}`
      + '（runtime/dsh-composition/patch-layer.mjs）。**两边都印出来、不替你决定哪边对**：'
      + '如果是清单写错了，重出清单；如果是补丁层被改了，那么这一版产品带的补丁层与清单说的不是同一个——'
      + '那正是 spec §9.1 那句"不允许出现 DSH 已升级但补丁层仍是旧锚点"要防的组合',
    { manifestValue: declared ?? null, repoValue: repo,
      source: PATCH_PAIR_SOURCE.compositionPatchVersion.source },
  )
}

/**
 * 组装一份 §9.1 清单。
 *
 * 三个可推导字段由 `deriveManifestFields()` 读出来；五个必须显式给出。
 * **缺一个就具名拒绝**（列出缺哪些），绝不填默认值。
 *
 * 成功时用**生产的** `validateManifest()` 再校一遍再返回——生成器与消费者
 * 必须是同一套判据。生成器自己判"我造的对"而消费者判"它不对"，
 * 就是又一次"两个各自绿了的半边"。
 *
 * @param {object} o
 * @param {string} o.productVersion
 * @param {string} o.legionVersion
 * @param {string} o.dshVersion
 * @param {number} o.schemaVersion
 * @param {string} o.channel
 * @param {string|null} [o.releasedAt]
 */
export function buildVersionManifest({
  productVersion = null, legionVersion = null, dshVersion = null,
  schemaVersion = null, channel = null, releasedAt = null, dependencies = undefined,
} = {}) {
  const derived = deriveManifestFields()
  const supplied = { productVersion, legionVersion, dshVersion, schemaVersion, channel }
  const missing = Object.entries(supplied)
    .filter(([, v]) => v === null || v === undefined || v === '')
    .map(([k]) => k)
  if (missing.length > 0) {
    const why = MANIFEST_FIELD_SOURCES
      .filter((f) => missing.includes(f.field))
      .map((f) => `  · ${f.field}：${f.why}`)
      .join('\n')
    return refuse(
      RUNTIME_MANIFEST_CODES.FIELD_UNDECIDED,
      `这份清单需要 ${missing.length} 个只能由发布决定的值，现在缺：${missing.join('、')}。`
        + '**不给默认值**：一份编出来的清单比没有清单更坏——安装器会照着它锁一个具体版本，'
        + '而那个版本从来没有人决定过。缺的这几项分别是：\n' + why,
      { missing: Object.freeze(missing) },
    )
  }

  const manifest = {
    manifestFormat: MANIFEST_FORMAT,
    productVersion,
    legionVersion,
    dshVersion,
    ...derived,
    schemaVersion,
    channel,
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(releasedAt === null ? {} : { releasedAt }),
  }

  const validity = validateManifest(manifest)
  if (validity.ok !== true) {
    return refuse(
      RUNTIME_MANIFEST_CODES.INVALID,
      `组装出来的清单没通过生产校验器（${validity.problems.length} 项）：`
        + validity.problems.map((p) => `${p.field}（${p.code}）`).join('、')
        + '。生成器与消费者用的是同一套判据：这一条红说明**生成器**写错了，'
        + '而不是"清单看起来没问题"',
      { problems: validity.problems },
    )
  }

  const pair = checkPatchVersionAgainstRepo(manifest)
  if (pair.ok !== true) return pair

  return Object.freeze({
    version: RUNTIME_MANIFEST_VERSION,
    ok: true,
    code: null,
    message: `§9.1 清单组装完成：产品 ${productVersion}／Legion ${legionVersion}／`
      + `DSH ${dshVersion}／补丁层 ${derived.dshCompositionPatchVersion}／通道 ${channel}。`
      + `其中 3 个字段从仓库常量读出、5 个由发布流程给出；补丁层版本已与仓库声明交叉验证`,
    manifest: Object.freeze(manifest),
    derived,
    // ★ 说清哪一半是推出来的、哪一半是人给的。少了这个读数，
    //   "清单里有 8 个字段"会被读成"这 8 个字段都有依据"。
    fieldSources: MANIFEST_FIELD_SOURCES,
    patchPairSource: Object.freeze({
      compositionPatchVersion: PATCH_PAIR_SOURCE.compositionPatchVersion,
      dshVersion: PATCH_PAIR_SOURCE.dshVersion,
    }),
    validity,
  })
}

/**
 * 把一份清单渲染成**能直接落盘**的文本，并带上"这是生成的"这件事。
 *
 * 为什么注释里要写"生成"：产物长得像一份手写的合同，而手写的东西会被就地编辑。
 * 一份"看起来是手写的、其实是生成的"清单，在某次手工改过一个字段之后
 * 就再也回不到生成器这条路上了。
 */
export function renderVersionManifest(result) {
  if (result === null || typeof result !== 'object' || result.ok !== true) {
    // 渲染器的输入就是组装器的输出；不合法时**返回空串**而不是抛，
    // 与 `renderDoctor` 对畸形输入的处理同一条纪律。
    return ''
  }
  // 逐字段输出**按来源表的顺序**：读的人一眼能看出哪几个是读出来的。
  // ★ 行尾**不能**加 `//` 注释，也**不能**在最后一个字段后面留逗号：
  //   这份文本必须首先是**合法 JSON**（安装器与校验器都直接 `JSON.parse` 它）。
  //   "哪个字段从哪来"由上面的 `_fieldSources` 承载——把注释塞进 JSON
  //   会让这份清单谁都读不了。
  //
  //   所以这里是"先攒成一个条目数组、再 `join(',\n')`"，
  //   而不是"逐行输出、每行带逗号"：后者一定会在最后一行留下尾逗号，
  //   而尾逗号与合法 JSON 之间差的正是**所有消费者**（不是格式美观）。
  const entries = [
    '  "_generated": "product/launcher/runtime-manifest.mjs 生成 —— 不要手工编辑；'
      + '改了请走 buildVersionManifest() 重新生成"',
    `  "_fieldSources": ${JSON.stringify(Object.fromEntries(
      result.fieldSources.map((f) => [f.field, f.derivable === true ? f.source : 'release-decision']),
    ))}`,
    ...result.fieldSources.map((f) => {
      const v = result.manifest[f.field]
      const rendered = typeof v === 'string' ? JSON.stringify(v) : String(v)
      return `  ${JSON.stringify(f.field)}: ${rendered}`
    }),
  ]
  return `{\n${entries.join(',\n')}\n}\n`
}
