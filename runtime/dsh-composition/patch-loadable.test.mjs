// runtime/dsh-composition/patch-loadable.test.mjs
// ============================================================================
// PRT-214：补丁层的**可加载性**——让真的 DSH 管线去读它。
//
// ## 为什么必须有这一套
//
// 此前守着补丁层的用例断言的是「磁盘上的 YAML == `renderPatchYaml()`」，
// 也就是**生成物与自己的声明一致**。那个断言是真的，也一直绿着——
// 而它从来没有让任何解析器去读那份文件。
//
//   > 一个"与自己的声明完全一致"的补丁层，
//   > 与一个"能被 DSH 加载"的补丁层，在用例上是同一个东西——
//   > 只不过前者的用例是绿的，而它从未被任何解析器读过。
//
// 用真解析器一读就发现三处硬伤：
//   ① 顶层是**映射**，而 DSH 只接受**顶层数组**（否则 `parsePatchList` 直接抛）；
//   ② `insert: after:tools` 里的 insert 是一个**字符串**，
//      而 `applyEntryPatches` 会对它调 `.forEach`；
//   ③ `plane: host` 不是 `PatchOptions` 的字段 —— DSH **不报错**，静默忽略。
//
// ## 这一套跑的是真管线
//
// 解析器是 **js-yaml**（`packages/boot/app-boot/src/index.ts:13` 就是
// `import * as yaml from 'js-yaml'`），schema 是那个包自己导出的 `entryListSchema`，
// 打补丁用的是真的 `applyEntryPatches`。
//
// ★ 而且 base 不是手编的：先应用 **DSH 自己的 base bundle 补丁**
//   （`packages/bundle/base/cordis.patch.yml`），再叠 Legion 这一层 ——
//   这正是 profile 层在运行时的真实位置（bundle 层之后）。
//
// ## 没有 DSH_CHECKOUT 时整组 SKIP
//
// 与 `plugins/`、`board-plugin/` 同一个纪律：**外部宿主测试不伪造通过**。
// 跳过是"这一次没跑"，不是"跑过了"。
// ============================================================================

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { patchDocument } from './render.mjs'
import { PATCH_YAML_PATH, renderPatchYaml, renderPatchReport } from './render.mjs'
import { PATCH_LAYER_ROWS } from './patch-layer.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')

// ── 外部 DSH 检出：不可用时整组 SKIP，不伪造通过 ──────────────────────────

const DSH = process.env.DSH_CHECKOUT ?? null
const INCLUDE_JS = DSH === null ? null : join(
  DSH, 'packages', 'boot', 'app-boot', 'node_modules',
  '@deepseek-ai', 'cordis-plugin-include', 'lib', 'index.js',
)
const JS_YAML_JS = DSH === null ? null : join(
  DSH, 'packages', 'boot', 'app-boot', 'node_modules', 'js-yaml', 'index.js',
)
const BASE_PATCH = DSH === null ? null : join(DSH, 'packages', 'bundle', 'base', 'cordis.patch.yml')

/** 为什么没跑。写清楚是缺哪一样，而不是笼统的"环境不支持"。 */
const UNAVAILABLE = DSH === null
  ? '未配置 DSH_CHECKOUT'
  : !existsSync(INCLUDE_JS)
    ? `DSH 检出里找不到 cordis-plugin-include（${INCLUDE_JS}）——依赖未安装？`
    : !existsSync(JS_YAML_JS)
      ? `DSH 检出里找不到 js-yaml（${JS_YAML_JS}）——依赖未安装？`
      : !existsSync(BASE_PATCH)
        ? `DSH 检出里找不到 base bundle 补丁（${BASE_PATCH}）`
        : null
const SKIP = UNAVAILABLE === null ? false : UNAVAILABLE

let applyEntryPatches = null
let entryListSchema = null
let yaml = null
if (!SKIP) {
  ;({ applyEntryPatches, entryListSchema } = await import(pathToFileURL(INCLUDE_JS).href))
  yaml = await import(pathToFileURL(JS_YAML_JS).href)
}

/** DSH 的 `parsePatchList` 等价物：真 js-yaml + 真 schema + 顶层数组断言。 */
function parseLikeDsh(file) {
  const parsed = yaml.load(readFileSync(file, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) {
    throw new Error(`config ${file} must be a top-level YAML array of entries`)
  }
  return parsed
}

/** 应用一层补丁，返回 `{tree, warnings}`。 */
function applyLayer(tree, patches) {
  const warnings = []
  const out = applyEntryPatches(tree, patches, (m, ...a) => {
    let i = 0
    warnings.push(m.replace(/%C/g, () => JSON.stringify(a[i++])))
  })
  return { tree: out, warnings }
}

const INSIDE = (fn) => { if (SKIP === false) fn() }

// ─────────────────────────────────────────────────────────────────────────────

/**
 * 逐条 SKIP，而不是整组 `describe({skip})`。
 *
 * ★ 为什么：`describe` 级的 skip 不把里面的用例计进 `skipped`，
 *   摘要里只少了几条 —— 于是"这一套被跳过了"与"根本没有这一套"
 *   在 CI 读数上长得一模一样。逐条 `t.skip()` 会留下 `skipped: N`。
 *
 *   > 一个「整组跳过、于是计数里什么都不显示」的套件，
 *   > 与一个「压根不存在」的套件，在"这次到底跑了什么"上是同一个东西。
 */
const guarded = (name, fn) => test(name, (t) => {
  if (SKIP !== false) return t.skip(`SKIP：${SKIP}`)
  return fn(t)
})

describe('PRT-214 补丁层可加载性（真 DSH 管线）', () => {
  guarded('★★★ Legion 的补丁文件是真的顶层数组，且每一项都是合法 PatchOptions', () => {
    const parsed = parseLikeDsh(join(ROOT, PATCH_YAML_PATH))
    assert.ok(Array.isArray(parsed), '顶层必须是数组（DSH 的 parsePatchList 只接受数组）')
    assert.ok(parsed.length > 0, '空数组会让这一层等于没有；当前至少该有 permission 的 patch-over')

    for (const [i, p] of parsed.entries()) {
      assert.equal(typeof p, 'object', `第 ${i} 项不是对象`)
      assert.ok(!('plane' in p), `第 ${i} 项带了 plane —— 它不是 PatchOptions 的字段，DSH 会静默忽略`)
      if ('insert' in p) {
        assert.ok(Array.isArray(p.insert), `第 ${i} 项的 insert 必须是数组`)
        assert.ok(!('id' in p),
          `第 ${i} 项同时带 id 与 insert —— DSH 读作「插进那一行」并要求它是已存在的 group，否则 warn-and-skip`)
        for (const e of p.insert) {
          assert.equal(typeof e.name, 'string', `insert 项 ${e.id} 没有可加载的 name`)
          assert.ok(e.name.trim() !== '', `insert 项 ${e.id} 的 name 是空的`)
        }
      }
    }
  })

  guarded('★★★ 叠在真 base bundle 上：Legion 这一层**零警告**', () => {
    // 这是本套件的核心判据。任何一条 warn 都意味着
    // "文件看起来装好了，而那一行什么也没做"。
    const base = applyLayer([], parseLikeDsh(BASE_PATCH))
    assert.equal(base.warnings.length, 0, `DSH 自己的 base bundle 有警告：${base.warnings.join(' | ')}`)
    assert.ok(base.tree.length > 50, `base 层只造出 ${base.tree.length} 行，样本太小`)

    const legion = applyLayer(base.tree, parseLikeDsh(join(ROOT, PATCH_YAML_PATH)))
    assert.deepEqual(legion.warnings, [],
      `Legion 层产生了警告——那意味着有一条补丁被静默跳过：${legion.warnings.join(' | ')}`)
  })

  guarded('★★★ Legion 层真的**替换**了 permission 行的 preset 表', () => {
    const base = applyLayer([], parseLikeDsh(BASE_PATCH)).tree
    const before = base.find((e) => e.id === 'permission')
    assert.ok(before !== undefined, 'base bundle 应当造出 permission 行')
    // 先确认**默认表里有** danger-full-access —— 否则下面的"被移除"是空断言
    assert.ok(Object.keys(before.config.presets).includes('danger-full-access'),
      'DSH 默认 preset 表里本该有 danger-full-access；它不在，说明这个断言没在检查任何东西')

    const after = applyLayer(base, parseLikeDsh(join(ROOT, PATCH_YAML_PATH)))
      .tree.find((e) => e.id === 'permission')
    assert.deepEqual(
      Object.keys(after.config.presets).sort(),
      ['legion-attended', 'legion-unattended'],
      'DSH 的语义是**替换整个 config**，不是合并',
    )
    assert.ok(!Object.keys(after.config.presets).includes('danger-full-access'),
      '默认表里那个把 never 与全盘访问绑定的档位必须消失')
    for (const spec of Object.values(after.config.presets)) {
      assert.notEqual(spec.sandbox, 'danger-full-access')
      assert.equal(spec.sandbox, 'workspace-write')
    }
  })

  guarded('★★★ 对照：会静默失效的形状**真的**会被 warn-and-skip', () => {
    // 没有这一条，上面那两个"零警告"就是空的：一个恒不报警的检查
    // 与一个没有检查，在读数上是同一个东西。
    const base = applyLayer([], parseLikeDsh(BASE_PATCH)).tree

    // 形状 A：insert 带自己的行 id（我第一版生成的就是这个）
    const a = applyLayer(base, [{ id: 'legion-enforcement-hard-floor', insert: [{ name: 'file:///x.js' }] }])
    assert.equal(a.warnings.length, 1, '形状 A 竟然没有警告')
    assert.match(a.warnings[0], /not found/)
    assert.ok(!a.tree.some((e) => e.id === 'legion-enforcement-hard-floor'),
      '这一行根本没被插进去——正是"看起来装好了"的样子')

    // 形状 B：把 `after: tools` 字面翻译成 id=tools 的 insert
    const b = applyLayer(base, [{ id: 'tools', insert: [{ id: 'legion-hf', name: 'file:///x.js' }] }])
    assert.equal(b.warnings.length, 1, '形状 B 竟然没有警告')
    assert.match(b.warnings[0], /is not a group/)
    assert.ok(!b.tree.some((e) => e.id === 'legion-hf'))

    // 形状 C：patch-over 打错 id
    const c = applyLayer(base, [{ id: 'permissoin', config: { presets: {} } }])
    assert.equal(c.warnings.length, 1, '形状 C 竟然没有警告')
    assert.match(c.warnings[0], /not found/)
  })

  guarded('★★★ 模块齐备时，插入路径**真的**能把三个 enforcement 行插进树里', () => {
    // 三个 enforcement 模块现在还不存在（`module: null`），于是默认文档里没有它们。
    // 但"生成器会不会正确地插入"必须现在就被证明——否则等模块写好的那天，
    // 我们只是在**同一个从未跑过的插入路径**上填了名字。
    //
    //   > 一个"等模块写好了就生效"的插入路径，
    //   > 与一个"根本不工作"的插入路径，在模块不存在时是同一个东西。
    const base = applyLayer([], parseLikeDsh(BASE_PATCH)).tree
    const withModules = patchDocument({ moduleUrlOf: (m) => `file:///legion/${m ?? 'x'}.js` })
    assert.deepEqual(withModules.unbuildable, [], '给了模块名之后不该还有造不出来的行')

    const applied = applyLayer(base, withModules.document)
    assert.deepEqual(applied.warnings, [], `插入路径产生了警告：${applied.warnings.join(' | ')}`)

    const ids = applied.tree.map((e) => e.id)
    for (const id of ['legion-enforcement-hard-floor', 'legion-enforcement-pre-execute', 'legion-enforcement-approval-answerer']) {
      assert.ok(ids.includes(id), `行 ${id} 没有被插进树里`)
    }
    // 插进去的行必须带 name，否则挂载时加载不到模块
    for (const id of ids.filter((x) => x !== undefined && x.startsWith('legion-enforcement-'))) {
      const row = applied.tree.find((e) => e.id === id)
      assert.equal(typeof row.name, 'string')
      assert.match(row.name, /^file:\/\//)
    }
  })

  guarded('★★ DSH 的 schema 能接受文档里的每一个值（含中文与引号规避）', () => {
    // `!!js` 注入：生成器把所有字符串都印成双引号标量，于是没有任何一条路径
    // 能产出裸标量 —— 靠的不是一个判据，而是"没有路径"。
    const parsed = parseLikeDsh(join(ROOT, PATCH_YAML_PATH))
    const presets = parsed.find((p) => p.id === 'permission')?.config?.presets
    assert.ok(presets !== undefined)
    for (const spec of Object.values(presets)) {
      assert.equal(typeof spec.sandbox, 'string')
      assert.equal(typeof spec.approval, 'string')
      assert.equal(typeof spec.name, 'string')
      // 中文必须原样往返，不能被转义成 \uXXXX 或吃掉
      assert.match(spec.name, /Legion/)
    }
    assert.match(presets['legion-attended'].name, /有人值守/)
    assert.match(presets['legion-unattended'].name, /无人值守/)
  })

  guarded('★★★ 文档里每一行 insert 的 `name` 都指向一个**真的存在**的模块', () => {
    // `./` 开头的 name 由 DSH 按 `dirname(patchFile)` 解析成 file:// URL
    // （`anchorInsertedPluginNames`，`packages/boot/app-boot/src/index.ts:326`）。
    // 所以这里做同一件事，然后确认那个文件在。
    //
    //   > 一个"指向不存在模块"的补丁行，与一个"根本没写这一行"的补丁行，
    //   > 在运行时的效果是同一个东西——只不过前者在文件里看起来是装好的。
    const patchFile = join(ROOT, PATCH_YAML_PATH)
    const parsed = parseLikeDsh(patchFile)
    const seen = []
    for (const entry of parsed) {
      for (const item of entry.insert ?? []) {
        seen.push({ id: item.id, name: item.name })
        assert.equal(typeof item.name, 'string', `insert 项 ${item.id} 没有 name`)
        if (!item.name.startsWith('./') && !item.name.startsWith('../')) {
          continue // 包名：装没装由 DSH 的加载器判，本仓库判不了
        }
        const abs = resolve(dirname(patchFile), item.name)
        assert.ok(existsSync(abs),
          `insert 项 ${item.id} 的 name=${JSON.stringify(item.name)} 解析到 ${abs}，而它不存在`)
      }
    }
    // 至少有一个真实模块被检查过——否则这条断言是空的。
    assert.ok(seen.length > 0, '文档里一行 insert 都没有，这条断言什么都没检查')
    assert.ok(seen.some((s) => s.id === 'legion-enforcement-hard-floor'),
      'hard-floor 那一行应当已经在文档里了（它现在有模块了）')
  })

  guarded('★ 生成物与 `renderPatchYaml()` 一致（新鲜度）', () => {
    const onDisk = readFileSync(join(ROOT, PATCH_YAML_PATH), 'utf8').replace(/\r\n/g, '\n')
    assert.equal(onDisk, renderPatchYaml(),
      'YAML 是生成物；手工编辑或忘记重新生成都会在这里被抓住')
  })

  guarded('★ 报告说清"这一层还不完整"，并点名缺的是哪几个模块', () => {
    // ★ **不写死**缺哪几行，而是从声明里推导：`module === null` 的行就是缺的。
    //
    //   第一版把三行写死了，于是 hard-floor 一拿到模块，这条用例就对着
    //   "现在只缺两行"报红——红的是一个**已经变好的事实**。
    //   写死清单的断言会随着进展变成噪声，而噪声会被改掉，改掉的可能是判据本身。
    const expected = PATCH_LAYER_ROWS.filter((r) => r.module === null && r.mount?.anchor !== 'patch-over')
      .map((r) => r.id).sort()
    const report = renderPatchReport()
    assert.deepEqual(report.unbuildable.map((u) => u.id).sort(), expected,
      '报告的缺行清单必须与声明里 module=null 的行逐一对上')
    // 现在应当仍然不完整（强制面本体还没写完）——若哪天完整了，这条会提醒改判据。
    if (expected.length > 0) {
      assert.equal(report.complete, false, `还缺 ${expected.length} 行模块，这一层必须是不完整的`)
    }
    for (const u of report.unbuildable) {
      assert.match(u.detail, /warn-and-skip/, '理由必须说清后果是静默跳过')
    }
  })

  guarded('★★★ `module` 非 null 的行**真的**在文档里，且指向存在的文件', () => {
    // 与上一条互为反面：上一条守"缺的行被报出来"，这条守"有的行真进去了"。
    // 少了任何一条，"报告说缺 2 行"都可以在一个什么都没生成的实现上为真。
    const withModule = PATCH_LAYER_ROWS.filter((r) => typeof r.module === 'string')
    assert.ok(withModule.length > 0, '一行有模块的都没有，这条断言是空的')
    const report = renderPatchReport()
    for (const row of withModule) {
      assert.ok(report.renderedRowIds.includes(row.id),
        `行 ${row.id} 有模块却没进文档 —— 那它永远不会被加载`)
      const abs = resolve(dirname(join(ROOT, PATCH_YAML_PATH)), row.module)
      assert.ok(existsSync(abs), `行 ${row.id} 的模块 ${row.module} 解析到 ${abs}，不存在`)
    }
  })
})

// 即使用的是逐条 skip，也要在文件末尾留一句：这一套**有条件**。
// 摘要里的 `skipped: N` 只说"有 N 条没跑"，不说为什么。
if (SKIP !== false) {
  test('PRT-214 可加载性套件本次未运行', () => {
    assert.ok(true, `SKIP 原因：${SKIP}。外部宿主测试不伪造通过——跑不了就不算跑过。`)
  })
}
