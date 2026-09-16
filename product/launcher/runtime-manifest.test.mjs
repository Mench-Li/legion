// product/launcher/runtime-manifest.test.mjs
// ============================================================================
// PRT-257 缺口①／②：§9.1 清单能不能由这个仓库生成、补丁层能不能被交叉验证。
//
// 这一套守的是两句话：
//
//   ① "缺清单"不是一个可以靠写一份夹具绕过去的缺口。仓库里**真的有**三个
//      字段的权威来源（补丁层 / 契约 / 包协议各一个常量），也**真的没有**
//      另外五个（产品版本 / 实现版本 / DSH 版本 / schema 版本 / 通道）。
//      这两件事都要是读数，而不是注释。
//
//   ② 清单里的补丁层版本必须与**仓库里那份声明**一致——这是缺口②里唯一
//      一个能真的做出交叉验证的字段。而 `dshVersion` 那一半仍然只能由人给，
//      这件事以 `patchPairSource` 这个读数存在。
//
// ## 这一套最容易变成的假验证
//
//   > 用本模块自己的表去校验本模块自己组装出来的清单。
//
// 那样写，"来源表写错了"与"实现读错了"会一起绿。所以：
//   · 三个可推导字段的断言**直接 import 那些生产常量**，与本模块的实现无关；
//   · 组装结果必须通过 `product/upgrade/manifest.mjs` 的**生产**校验器
//     （那是消费者那一半，不是生成器这一半）；
//   · `releases/*/MANIFEST.json` 那一条是**真的去读磁盘上那些文件**，
//     不是断言一个常量。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MANIFEST_FIELD_SOURCES,
  PATCH_PAIR_SOURCE,
  RUNTIME_MANIFEST_CODES,
  buildVersionManifest,
  checkPatchVersionAgainstRepo,
  deriveManifestFields,
  renderVersionManifest,
  undecidedManifestFields,
} from './runtime-manifest.mjs'
// ★ 生产常量：**直接**从这里读，不经过本模块。这样"来源表写错了"必然红。
import { DSH_COMPOSITION_PATCH_VERSION } from '../../runtime/dsh-composition/index.mjs'
import { RUNTIME_CONTRACT_VERSION } from '../../runtime/contracts/adapter.mjs'
import { PACK_PROTOCOL_VERSION } from '../../runtime/packs/manifest.mjs'
import { MANIFEST_FORMAT, validateManifest } from '../upgrade/manifest.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 八个 §9.1 字段。写死在这里是**故意的**：它是 spec 的要求，不是实现的产物。 */
const SPEC_FIELDS = Object.freeze([
  'productVersion', 'legionVersion', 'dshVersion', 'dshCompositionPatchVersion',
  'schemaVersion', 'runtimeContractVersion', 'packProtocolVersion', 'channel',
])

const DECISIONS = Object.freeze({
  productVersion: '0.9.0', legionVersion: '0.9.0', dshVersion: '0.1.5-rc.2',
  schemaVersion: 1, channel: 'stable',
})

test('① ★★★★ 来源表覆盖 spec 的**全部八个**字段，一个不多一个不少', () => {
  const fields = MANIFEST_FIELD_SOURCES.map((f) => f.field)
  assert.deepEqual([...fields].sort(), [...SPEC_FIELDS].sort(),
    '来源表与 spec §9.1 的字段集对不上——多出来的字段会被当成要求，少掉的字段会没人负责')
  for (const f of MANIFEST_FIELD_SOURCES) {
    assert.equal(typeof f.why, 'string')
    assert.ok(f.why.length > 10, `${f.field} 没有说清"为什么推不出来/从哪来"`)
    if (f.derivable === true) {
      assert.equal(typeof f.source, 'string', `${f.field} 说可推导却没给出源`)
    } else {
      assert.equal(f.source, null, `${f.field} 不可推导却给了一个源：${f.source}`)
    }
  }
})

test('① ★★★★★ 三个可推导字段**等于生产常量本身**（不是抄来的字面量）', () => {
  const d = deriveManifestFields()
  assert.equal(d.dshCompositionPatchVersion, DSH_COMPOSITION_PATCH_VERSION)
  assert.equal(d.runtimeContractVersion, RUNTIME_CONTRACT_VERSION)
  assert.equal(d.packProtocolVersion, PACK_PROTOCOL_VERSION)
  // 而且它们的源路径指向**真的存在**的文件，且那个文件**真的提到**那个常量。
  //
  // ★ 这条断言第一版只检查了"文件非空"与"常量名长得像常量名"——于是
  //   把源路径改成一个**别的**真实文件（例如把补丁层的源写成
  //   `runtime/contracts/adapter.mjs`）在破验里**没咬住**：那个文件也是非空的，
  //   而 `DSH_COMPOSITION_PATCH_VERSION` 也匹配 `^[A-Z_]+$`。
  //   > 一条"源路径指向的文件存在"的断言，
  //   > 与一条"源路径指向的文件真的是那个常量的家"的断言，
  //   > 在源路径恰好写对的时候是同一个东西。
  //   现在断言的是：**那个文件里必须出现那个名字**（直接声明或 barrel 转出都算）。
  for (const f of MANIFEST_FIELD_SOURCES.filter((x) => x.derivable === true)) {
    const rel = f.source.split(' → ')[0]
    const name = f.source.split(' → ')[1]
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8')
    assert.ok(text.length > 0, `${rel} 读不出内容——来源表指向了一个空文件`)
    assert.match(name, /^[A-Z_]+$/)
    assert.ok(new RegExp(`\\b${name}\\b`).test(text),
      `${rel} 里根本没有出现 ${name} —— 来源表把常量指到了一个别的文件`)
  }
  // 反向：常量名必须**真的**能从来源表说的那个模块里 import 出来。
  assert.equal(typeof RUNTIME_CONTRACT_VERSION, 'number')
  assert.equal(typeof PACK_PROTOCOL_VERSION, 'number')
  assert.equal(typeof DSH_COMPOSITION_PATCH_VERSION, 'number')
})

test('① ★★★★★ 五个字段缺一个就具名拒绝，**绝不填默认值**', () => {
  for (const field of undecidedManifestFields()) {
    const args = { ...DECISIONS }
    delete args[field]
    const r = buildVersionManifest(args)
    assert.equal(r.ok, false, `${field} 缺了却照样组装出了一份清单`)
    assert.equal(r.code, RUNTIME_MANIFEST_CODES.FIELD_UNDECIDED)
    assert.ok(r.missing.includes(field), `拒绝里没有点名 ${field}：${r.missing}`)
    assert.equal(r.manifest, undefined)
    // 拒绝里必须带上"为什么它推不出来"，否则下一个人还是不知道去哪找值。
    assert.match(r.message, new RegExp(field))
  }
  // 空串/空值也算缺。
  for (const v of ['', null, undefined]) {
    const r = buildVersionManifest({ ...DECISIONS, channel: v })
    assert.equal(r.code, RUNTIME_MANIFEST_CODES.FIELD_UNDECIDED)
  }
  // 五个都给齐 → 成功，而且缺一个都不行这一点由上面覆盖。
  assert.equal(buildVersionManifest(DECISIONS).ok, true)
})

test('① ★★★★★ 组装出来的清单必须通过**生产校验器**（生成器与消费者同一套判据）', () => {
  const r = buildVersionManifest(DECISIONS)
  assert.equal(r.ok, true, `${r.code} ${r.message}`)
  assert.equal(r.manifest.manifestFormat, MANIFEST_FORMAT)
  const v = validateManifest(r.manifest)
  assert.equal(v.ok, true, `生产校验器拒绝了生成器造出来的清单：${JSON.stringify(v.problems)}`)
  // 逐字段：生成器写进去的与校验器读到的是同一份。
  for (const f of SPEC_FIELDS) {
    if (DECISIONS[f] !== undefined) assert.equal(r.manifest[f], DECISIONS[f], `${f} 被生成器改过`)
  }
  for (const [k, val] of Object.entries(deriveManifestFields())) {
    assert.equal(r.manifest[k], val, `${k} 没有落进清单`)
  }
})

test('② ★★★★★ 清单与仓库声明的补丁层版本不一致 ⇒ 具名拒绝，且两边都印出来', () => {
  const ok = buildVersionManifest(DECISIONS)
  assert.equal(checkPatchVersionAgainstRepo(ok.manifest).ok, true)
  // 造一份"清单说补丁层是另一版"的：这正是 spec §9.1 点名要防的组合。
  const wrong = { ...ok.manifest, dshCompositionPatchVersion: DSH_COMPOSITION_PATCH_VERSION + 1 }
  const r = checkPatchVersionAgainstRepo(wrong)
  assert.equal(r.ok, false)
  assert.equal(r.code, RUNTIME_MANIFEST_CODES.PATCH_VERSION_MISMATCH)
  assert.equal(r.manifestValue, DSH_COMPOSITION_PATCH_VERSION + 1)
  assert.equal(r.repoValue, DSH_COMPOSITION_PATCH_VERSION)
  // ★ 它**不替用户决定**哪边对：不说"以仓库为准"，也不自己改清单。
  assert.match(r.message, /不替你决定/)
  assert.match(r.message, new RegExp(String(DSH_COMPOSITION_PATCH_VERSION)))
  // 而且组装器会把这份不一致的清单**挡在门外**（不是组装完再说）。
  const viaBuild = buildVersionManifest({ ...DECISIONS })
  assert.equal(viaBuild.ok, true)
  // 组装器本身不接受一个外部传入的补丁层版本——所以这里只能验"组装出来的那个一定一致"。
  assert.equal(viaBuild.manifest.dshCompositionPatchVersion, DSH_COMPOSITION_PATCH_VERSION)
})

test('② ★★★★ `patchPairSource` 说清哪一列可交叉验证、哪一列只能人工', () => {
  const r = buildVersionManifest(DECISIONS)
  assert.equal(r.patchPairSource.compositionPatchVersion.source, 'repo-declaration')
  assert.equal(r.patchPairSource.dshVersion.source, 'human')
  assert.match(r.patchPairSource.dshVersion.detail, /没有真实装配记录/)
  // 常量本身要能被外部断言（不然"这一列是人工的"这句话无法被检查）。
  assert.equal(PATCH_PAIR_SOURCE.dshVersion.source, 'human')
})

test('① ★★★ 渲染出来的文本是**合法 JSON**，且带上"这是生成的"', () => {
  const r = buildVersionManifest(DECISIONS)
  const text = renderVersionManifest(r)
  const parsed = JSON.parse(text) // 抛就红
  assert.match(parsed._generated, /生成/)
  assert.match(parsed._generated, /不要手工编辑/)
  for (const f of SPEC_FIELDS) assert.ok(f in parsed, `渲染结果里少了 ${f}`)
  // 来源要能读出来：哪几个是读出来的、哪几个是发布决定。
  assert.equal(typeof parsed._fieldSources, 'object')
  for (const f of SPEC_FIELDS) assert.equal(typeof parsed._fieldSources[f], 'string')
  // 渲染器对失败的组装结果返回空串（不抛、也不渲染半份清单）。
  assert.equal(renderVersionManifest({ ok: false }), '')
  assert.equal(renderVersionManifest(null), '')
})

test('① ★★★★★ 磁盘上的 `releases/*/MANIFEST.json` **没有一份**能当 §9.1 清单用', () => {
  // 这一条是缺口①的机器可读形式，而且它是**真的在读磁盘**。
  // ★ 前向兼容：将来真的出了一份合法清单时，它自己会通过校验；
  //   出了半份（既不是合法安装清单、也不是构建清单）则红。
  const releasesDir = join(REPO_ROOT, 'releases')
  let dirs = []
  try { dirs = readdirSync(releasesDir) } catch { dirs = [] }
  const scanned = []
  const installable = []
  for (const dir of dirs) {
    let raw = null
    try { raw = readFileSync(join(releasesDir, dir, 'MANIFEST.json'), 'utf8') } catch { continue }
    let parsed = null
    try { parsed = JSON.parse(raw) } catch {
      assert.fail(`releases/${dir}/MANIFEST.json 不是合法 JSON`)
    }
    scanned.push(dir)
    // 构建清单的形状：`name: 'legion-release'` + gitHead。要有**明确**的标记。
    const isBuildManifest = parsed.name === 'legion-release' && typeof parsed.gitHead === 'string'
    const looksLikeInstaller = parsed.manifestFormat === MANIFEST_FORMAT
      || SPEC_FIELDS.some((f) => f in parsed)
    if (looksLikeInstaller) {
      const v = validateManifest(parsed)
      assert.equal(v.ok, true,
        `releases/${dir}/MANIFEST.json 看起来是安装清单但没通过校验：${JSON.stringify(v.problems)}`)
      installable.push(dir)
    } else {
      assert.equal(isBuildManifest, true,
        `releases/${dir}/MANIFEST.json 既不是安装清单、也没有构建清单的标记 —— `
        + '一份说不清自己是什么的清单，会在发布时被当成另一种')
    }
  }
  assert.ok(scanned.length > 0, '一个 releases 目录都没扫到：这条断言证明不了任何事')
  // ★ 当前的事实：**一份可安装清单都没有**。这一条红了，说明有人真的发布了
  //   一份 §9.1 清单——那时请把这里改成"至少有一份，且校验通过"。
  assert.deepEqual(installable, [],
    `releases/ 下出现了可安装的 §9.1 清单：${installable.join('、')}。`
    + '缺口①可能已经被关掉了 —— 请更新这条用例，让它改成断言"它校验通过"')
})
