// product/compliance/inventory.test.mjs
// ============================================================================
// PRT-901 / PRT-902 的判据：第三方组件清单与 SBOM，以及商业分发条件。
//
// 这一组盯的**不是**"能不能生成一份 SBOM"，而是**那份 SBOM 会不会漏东西**。
// 它坏在两个方向，而只有一个方向会有人来报 bug：
//
//   ① 漏报 → 报表说"覆盖完整"，而随产品分发的第三方代码没被算进去（没人报 bug）
//   ② 夸大 → 把"还没读到"报成"没有许可"，让人去修一个不存在的问题
//
// 所以下面每一条都要用**注入的假磁盘**去问，而不是断言仓库当前的状态——
// 断言仓库当前状态会在仓库变化时变红，却证明不了判据本身在不在。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  INVENTORY_FINDINGS,
  LICENSE_TERMS,
  SBOM_VERSION,
  assertInventoryComplete,
  buildSbom,
  collectManifests,
  distributionReport,
  distributionTerms,
} from './inventory.mjs'

// ---------------------------------------------------------------- 假磁盘

/** 造一个可注入的假文件系统。`tree` 是 `{ 路径: 内容 }`，'<DIR>' 表示空目录。 */
function fakeFs(tree) {
  // 根目录统一记成 `.`——第一版把根记成了空串，于是 `listDir('.')` 什么都找不到，
  // 10 条用例红成一片。**这不是被测代码的问题，是夹具的问题**：
  // 一个永远返回空目录的假磁盘，会让"注入"这件事看起来已经做到了。
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '') || '.'
  const dirs = new Map()
  const ensure = (d) => { if (!dirs.has(d)) dirs.set(d, []) ; return dirs.get(d) }

  for (const [p, content] of Object.entries(tree)) {
    const key = norm(p)
    const parts = key.split('/')
    // 逐级登记：每一段的父目录都要把这一段列进自己的孩子里，
    // 否则 `sub/package.json` 会被登记进 `sub` 而 `sub` 自己不出现在根目录下，
    // 遍历就永远走不到它——树是"平的"看起来却像"空的"。
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/') || '.'
      ensure(parent)
      if (!dirs.get(parent).includes(parts[i])) dirs.get(parent).push(parts[i])
      if (i < parts.length - 1) ensure(parts.slice(0, i + 1).join('/'))
    }
    if (content === '<DIR>') ensure(key)
  }
  return {
    listDir: (d) => {
      const here = norm(d)
      return (dirs.get(here) ?? []).map((n) => {
        const child = here === '.' ? n : `${here}/${n}`
        return { name: n, isDirectory: () => dirs.has(child) }
      })
    },
    readText: (p) => {
      const key = norm(p)
      if (!(key in tree)) throw new Error(`ENOENT: ${key}`)
      return tree[key]
    },
  }
}

const ALPHA = JSON.stringify({ name: 'alpha', version: '1.0.0', license: 'MIT', dependencies: { left: '^1.0.0' } })
const BETA = JSON.stringify({ name: 'beta', version: '2.0.0', private: true })

// ---------------------------------------------------------------- 清单收集

test('① ★ 清单收集是**可注入**的（否则测不了"磁盘上多了一棵树"）', () => {
  const io = fakeFs({ 'package.json': ALPHA, 'sub/package.json': BETA })
  const m = collectManifests('.', io)
  assert.deepEqual(m.map((x) => x.path).sort(), ['package.json', 'sub/package.json'])
})

test('① ★ 解析不了的清单**也留下**（丢掉会让"有一个坏的"变成"少了一个"）', () => {
  const io = fakeFs({ 'package.json': '{ 不是 json' })
  const m = collectManifests('.', io)
  assert.equal(m.length, 1)
  assert.equal(m[0].manifest, null, '坏清单必须留下并被标成 null')
})

test('① ★ `node_modules` 被跳过（它不是随产品分发的台账）', () => {
  const io = fakeFs({ 'package.json': ALPHA, 'node_modules/dep/package.json': BETA })
  const m = collectManifests('.', io)
  assert.deepEqual(m.map((x) => x.path), ['package.json'])
})

// ---------------------------------------------------------------- ★★ 两个来源

test('② ★★ 只有清单、没有 vendored 树时，`vendoredCount` 是 0（而不是编一个出来）', () => {
  const io = fakeFs({ 'package.json': ALPHA })
  const sbom = buildSbom({ manifests: collectManifests('.', io) })
  assert.equal(sbom.vendoredCount, 0)
  assert.equal(sbom.declaredCount, 1)
})

test('② ★★ 一棵**没有清单**的 vendored 树会被收进来，并报"未被覆盖"', () => {
  // 这正是"只读 package.json 的 SBOM"会整棵漏掉的那一种。
  const io = fakeFs({ 'package.json': ALPHA, 'vendor/thing/index.js': '// 拷进来的第三方代码' })
  const sbom = buildSbom({ manifests: collectManifests('.', io), vendoredTrees: ['vendor/thing'] })
  assert.equal(sbom.vendoredCount, 1)
  const f = sbom.findings.find((x) => x.code === INVENTORY_FINDINGS.VENDORED_UNCOVERED)
  assert.ok(f, `未覆盖的 vendored 树必须报出来，实际 findings=${JSON.stringify(sbom.findings)}`)
  assert.equal(f.path, 'vendor/thing')
  assert.equal(assertInventoryComplete(sbom).ok, false)
})

test('② ★★ 一棵**带清单**的 vendored 树不会被算两次（同一份代码只算一次）', () => {
  // 第一版这里错了：`.skills-cache/.../teamai-cli-main` 既是一棵 vendored 树、
  // 又有一份清单，于是两处各记一个组件，`distributionReport` 把同一个 MIT
  // 组件数成了 `permissive: 2`。
  //
  //   > 一个「同一份代码在报表里出现两次、于是'覆盖了 2 个宽松许可组件'」的 SBOM，
  //   > 与一个「其实只有 1 个」的 SBOM，是同一个东西——
  //   > 只不过前者让人以为覆盖面更大。
  const io = fakeFs({ 'vendor/thing/package.json': ALPHA, 'app/package.json': BETA })
  const sbom = buildSbom({ manifests: collectManifests('.', io), vendoredTrees: ['vendor/thing'] })
  const named = sbom.components.filter((c) => c.name === 'alpha')
  assert.equal(named.length, 1, `同一棵树只能出现一次，实际 ${JSON.stringify(named.map((c) => c.kind))}`)
  assert.equal(named[0].kind, 'vendored')
  // 但它的**依赖**仍然要收（依赖与它以什么身份出现无关）
  assert.equal(sbom.components.filter((c) => c.kind === 'dependency' && c.name === 'left').length, 1)
})

test('② ★★ vendored 树带清单、但清单没有 license → 报未知（分发的代码不能有未知条件）', () => {
  const io = fakeFs({ 'vendor/thing/package.json': BETA, 'app/package.json': ALPHA })
  const sbom = buildSbom({ manifests: collectManifests('.', io), vendoredTrees: ['vendor/thing'] })
  // BETA 是 private:true，作为 workspace 会被跳过；但作为 vendored 树它随产品分发，
  // 所以"没有 license"必须被报出来。
  const f = sbom.findings.find((x) => x.code === INVENTORY_FINDINGS.LICENSE_UNKNOWN && String(x.path).includes('vendor'))
  assert.ok(f, `实际 findings=${JSON.stringify(sbom.findings)}`)
})

test('② ★★ 一个清单都没有时**不报"完整"**（"扫出来是空的" ≠ "真的没有第三方"）', () => {
  const sbom = buildSbom({ manifests: [], vendoredTrees: [] })
  assert.ok(sbom.findings.some((f) => f.code === INVENTORY_FINDINGS.NO_MANIFESTS))
  const inv = assertInventoryComplete(sbom)
  assert.equal(inv.ok, false)
})

test('② ★ 依赖的携带方向（`from` 指向声明它的清单）', () => {
  const io = fakeFs({ 'app/package.json': ALPHA })
  const sbom = buildSbom({ manifests: collectManifests('.', io) })
  const dep = sbom.components.find((c) => c.kind === 'dependency')
  assert.equal(dep.name, 'left')
  assert.equal(dep.from, 'app/package.json')
  assert.equal(dep.dev, false)
})

test('② ★ devDependencies 被标成 dev', () => {
  const io = fakeFs({ 'package.json': JSON.stringify({ name: 'x', private: true, devDependencies: { t: '^1' } }) })
  const sbom = buildSbom({ manifests: collectManifests('.', io) })
  assert.equal(sbom.components.find((c) => c.kind === 'dependency').dev, true)
})

test('② ★★ 声明了但磁盘上没有 → 报"清单与磁盘不一致"（只在给了磁盘信息时）', () => {
  const io = fakeFs({ 'app/package.json': ALPHA })
  const manifests = collectManifests('.', io)
  // 不给磁盘信息：不猜
  const noInfo = buildSbom({ manifests })
  assert.equal(noInfo.findings.filter((f) => f.code === INVENTORY_FINDINGS.DECLARED_NOT_INSTALLED).length, 0)
  // 给了磁盘信息且确实没有：报
  const withInfo = buildSbom({ manifests, installedPrefixes: [] })
  assert.ok(withInfo.findings.some((f) => f.code === INVENTORY_FINDINGS.DECLARED_NOT_INSTALLED))
  // 给了且确实有：不报
  const satisfied = buildSbom({ manifests, installedPrefixes: ['app/node_modules/left'] })
  assert.equal(satisfied.findings.filter((f) => f.code === INVENTORY_FINDINGS.DECLARED_NOT_INSTALLED).length, 0)
})

// ---------------------------------------------------------------- 分发条件

test('③ ★★ 未知许可**不是**宽松许可（`unknown` 与 `permissive` 不同）', () => {
  assert.equal(distributionTerms({ license: null }).verdict, 'unknown')
  assert.equal(distributionTerms({ license: '' }).verdict, 'unknown')
  // 名单之外的许可也按 unknown，而不是"看起来像 MIT 就算 MIT"
  assert.equal(distributionTerms({ license: 'WTFPL-something' }).verdict, 'unknown')
  assert.equal(distributionTerms({ license: 'MIT' }).verdict, 'permissive')
})

test('③ ★★ "没读到"与"没有"报出的原因**不同**（夸大一个缺口与漏报一个是同一件事）', () => {
  const read = distributionTerms({ kind: 'dependency', name: 'chalk', license: null })
  const absent = distributionTerms({ kind: 'workspace', name: 'app', license: null })
  assert.equal(read.verdict, absent.verdict)          // 结论一样
  assert.notEqual(read.reason, absent.reason)          // 但原因必须分得清
  assert.match(read.reason, /尚未读取/)
  assert.match(absent.reason, /没有 license 字段/)
})

test('③ ★ copyleft 与 restricted 被区分（AGPL 的网络义务与 GPL 不同）', () => {
  assert.equal(distributionTerms({ license: 'GPL-3.0' }).verdict, 'copyleft')
  assert.equal(distributionTerms({ license: 'AGPL-3.0' }).verdict, 'restricted')
  assert.ok(distributionTerms({ license: 'AGPL-3.0' }).obligations.some((o) => /网络服务/.test(o)))
  assert.ok(!distributionTerms({ license: 'GPL-3.0' }).obligations.some((o) => /网络服务/.test(o)))
})

test('③ ★ 每个已知许可都给出**义务**（只说"宽松"等于没说分发时要做什么）', () => {
  for (const [name, terms] of Object.entries(LICENSE_TERMS)) {
    const r = distributionTerms({ license: name })
    assert.equal(r.verdict, terms.verdict, name)
    if (terms.notice) assert.ok(r.obligations.some((o) => /声明/.test(o)), `${name} 应有声明义务`)
  }
})

test('③ ★★ `private: true` 的 workspace 不参与分发条件（但 vendored 树参与）', () => {
  const io = fakeFs({ 'app/package.json': JSON.stringify({ name: 'app', private: true, license: 'GPL-3.0' }) })
  const sbom = buildSbom({ manifests: collectManifests('.', io) })
  const rep = distributionReport(sbom)
  // 私有包即使写着 GPL 也不随产品分发，不该成为一个 blocker
  assert.equal(rep.rows.filter((r) => r.name === 'app').length, 0)
  assert.equal(rep.counts.restricted + rep.counts.copyleft, 0)
})

test('③ ★★ `clear` 只有在**没有** unknown/restricted 时才为 true', () => {
  const clean = distributionReport(buildSbom({
    manifests: collectManifests('.', fakeFs({ 'a/package.json': JSON.stringify({ name: 'a', license: 'MIT' }) })),
  }))
  assert.equal(clean.clear, true)
  const dirty = distributionReport(buildSbom({
    manifests: collectManifests('.', fakeFs({ 'a/package.json': JSON.stringify({ name: 'a', license: null }) })),
  }))
  assert.equal(dirty.clear, false)
  // unknown 必须算 blocker——它是最容易被"跳过"的那一类
  assert.ok(dirty.blockers.some((b) => b.verdict === 'unknown'))
})

// ---------------------------------------------------------------- 完整性

test('④ ★★ `assertInventoryComplete` 报出未覆盖的树与未知许可的**路径**（不是只报个数）', () => {
  const io = fakeFs({ 'package.json': ALPHA, 'vendor/x/index.js': 'x' })
  const sbom = buildSbom({ manifests: collectManifests('.', io), vendoredTrees: ['vendor/x'] })
  const inv = assertInventoryComplete(sbom)
  assert.equal(inv.ok, false)
  assert.deepEqual([...inv.unknownLicensePaths], [])
  assert.match(inv.problems.join('\n'), /vendor\/x/)
  assert.equal(inv.vendoredCount, 1)
})

test('④ ★ 版本号是常量字符串（报表要能解释自己是按哪版格式算的）', () => {
  assert.match(SBOM_VERSION, /^legion\/sbom@\d+$/)
})

test('④ ★ 返回的对象被冻结（调用方改它不能改掉清单结论）', () => {
  const sbom = buildSbom({ manifests: collectManifests('.', fakeFs({ 'package.json': ALPHA })) })
  assert.ok(Object.isFrozen(sbom))
  assert.ok(Object.isFrozen(sbom.components))
  assert.throws(() => { 'use strict'; sbom.declaredCount = 999 }, TypeError)
})
