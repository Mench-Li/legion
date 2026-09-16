// runtime/dsh-composition/patch-format.test.mjs
// ============================================================================
// PRT-214：补丁文档的**形状**与 YAML 生成器。
//
// 本套件不连 DSH（真管线那一套在 `patch-loadable.test.mjs`）。这里守的是
// `patch-format.mjs` 自己的判据：
//
//   · 每一个拒绝码**都够得着**（没有"写了但永远触发不了"的分支）
//   · 生成器吐出的东西**通过自己的检查器**（"能造"与"能加载"不能是两件事）
//   · 字符串一律双引号 → `!!js` 这一整类注入没有路径能产出
// ============================================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PATCH_DOCUMENT_CODES, PATCH_FORMAT_CHECKED, PATCH_FORMAT_VERSION, PATCH_OPTIONS_KEYS,
  assertPatchDocumentLoadable, isPlainObject, patchDocumentProblems, renderPatchYamlText,
  scalarOf, toPatchDocument, unknownPatchKeys,
} from './patch-format.mjs'
import { LEGION_PERMISSION_PRESETS, legionPresetForApproval } from './patch-layer.mjs'

const ALL_CODES = Object.values(PATCH_DOCUMENT_CODES)

// ============================================================================
// PRT-214 第二步：`approvalPolicy`（自由文本）→ preset（闭集）的反查
// ============================================================================
//
// 这一组守的是那条接线里**唯一会静默放宽**的一步。控制面存下来的
// `approvalPolicy` 是自由文本（`team-hub` 只做 `optionalString`），执行面认的
// preset 是闭集。两者之间那次翻译如果"给个默认"，一个拼写错误就会变成一个
// 档位——而它在清单里看不出来。

describe('legionPresetForApproval：反查，而且只认那两个值', () => {
  test('★★★★ 两个已知值各查到**不同**的 preset（双射）', () => {
    const entries = Object.entries(LEGION_PERMISSION_PRESETS)
    assert.deepEqual(entries.map(([id]) => id).sort(), ['legion-attended', 'legion-unattended'])
    assert.equal(legionPresetForApproval('ask'), 'legion-attended')
    assert.equal(legionPresetForApproval('never'), 'legion-unattended')
    // 双射：两个值不能查到同一个 preset，否则"问一下"与"永远不行"会合并。
    assert.notEqual(legionPresetForApproval('ask'), legionPresetForApproval('never'))
    // 反向对照：每个 preset 的 `approval` 都能查回它自己（正表与反查同源）。
    for (const [id, p] of entries) {
      assert.equal(legionPresetForApproval(p.approval), id, id + ' 的 approval 查不回自己')
    }
  })

  test('★★★★★ 认不出来的值一律 `null`，**不给默认**', () => {
    // 每一个都必须 `null`。给默认的那一天，拼写错误会变成一个**具体**的档位。
    for (const bad of [
      'ask-on-write',      // ← 生产里真实出现过的取值（sources-loader 的夹具）
      'askOnWrite', 'no-approval', 'never ', ' never', 'NEVER', 'Ask',
      '', '   ', null, undefined, 42, {}, [],
    ]) {
      assert.equal(legionPresetForApproval(bad), null,
        `${JSON.stringify(bad)} 竟然查出了一个 preset——那是一个**猜**出来的档位`)
    }
    // ★ 尤其：`' never'` / `'NEVER'` 不许被 trim / 转小写后当作 `never`。
    //   一个"顺手规范化一下"的实现会把控制面里一个手滑的空格变成一次**放宽**。
    assert.notEqual(legionPresetForApproval(' never'), 'legion-unattended')
  })

  test('★★★★ 反查读的是那张表本身：改表就改答案（没有第二份字面量）', () => {
    // 替身表：如果反查里抄了一份 `{ask: ..., never: ...}`，这个用例会红。
    const presets = { 'probe-a': { approval: 'probe-ask' }, 'probe-b': { approval: 'probe-never' } }
    assert.equal(legionPresetForApproval('probe-ask', presets), 'probe-a')
    assert.equal(legionPresetForApproval('probe-never', presets), 'probe-b')
    // 而真表里的两个值在替身表里查不到——证明答案真的来自传入的那张表。
    assert.equal(legionPresetForApproval('ask', presets), null)
  })

  test('★★★★ 多对一时**抛错**，不许由遍历顺序决定用哪个 preset', () => {
    // `approval` 今天在真表里是双射。哪一天不是了，这件事必须由人重新裁决
    // ——"哪个 preset 才是这个 approval 的意思"不是一个可以由 `Object.keys`
    // 顺序回答的问题。
    const ambiguous = { 'probe-x': { approval: 'same' }, 'probe-y': { approval: 'same' } }
    assert.throws(() => legionPresetForApproval('same', ambiguous), /重新裁决|不唯一|遍历顺序/)
    // 反向对照：只有一个命中时不抛（否则上面那条在一个"永远抛"的实现上也是绿的）。
    assert.equal(legionPresetForApproval('same', { 'probe-x': { approval: 'same' } }), 'probe-x')
  })
})

describe('PRT-214 补丁文档形状与 YAML 生成', () => {
  // ── 自检本身（一个没人断言的检查等于没有检查）────────────────────────────

  test('★★★ 模块自检必须通过，且留下**真的触发过**的拒绝码', () => {
    assert.deepEqual(PATCH_FORMAT_CHECKED.problems, [],
      `patch-format 自己的判据不自洽：${JSON.stringify(PATCH_FORMAT_CHECKED.problems)}`)
    assert.equal(PATCH_FORMAT_CHECKED.ok, true)
    assert.equal(PATCH_FORMAT_CHECKED.version, PATCH_FORMAT_VERSION)
    assert.ok(PATCH_FORMAT_CHECKED.checkedRefusals.length > 0,
      '自检没有真的触发过任何拒绝 —— 那它什么都没证明')
    assert.ok(PATCH_FORMAT_CHECKED.sampleYaml.length > 0)
  })

  test('★★★ 每一个拒绝码都够得着（不留"永远触发不了"的分支）', () => {
    // ★ `ROW_MODULE_MISSING` 由 `toPatchDocument` 抛（不是形状问题），其余全部
    //   由 `patchDocumentProblems` 判。两边合起来必须覆盖**整张码表**。
    const fromShape = new Set(PATCH_FORMAT_CHECKED.checkedRefusals)
    const fromBuilder = new Set(
      toPatchDocument({ rows: [{ id: 'r', mount: { anchor: 'insert' }, module: null }] }).unbuildable.map((u) => u.code),
    )
    const covered = new Set([...fromShape, ...fromBuilder])
    const uncovered = ALL_CODES.filter((c) => !covered.has(c))
    assert.deepEqual(uncovered, [],
      `这些拒绝码没有任何一条路径能触发（等于死代码）：${uncovered.join(', ')}`)
    // 反向：不该冒出码表外的码
    for (const c of covered) assert.ok(ALL_CODES.includes(c), `${c} 不在码表里`)
  })

  test('★ 字段表逐字取自 DSH 的 PatchOptions', () => {
    // 抄自 cordis-plugin-include/lib/types/index.d.ts。
    // 少一个就会把合法字段误报成 UNKNOWN_KEY；多一个就会放过静默忽略的字段。
    assert.deepEqual([...PATCH_OPTIONS_KEYS].sort(),
      ['config', 'disabled', 'group', 'id', 'inject', 'insert', 'intercept', 'isolate', 'name'])
    // ★ `plane` 不在表里 —— 它此前被写进补丁文件，而 DSH 有索引签名，静默忽略。
    assert.ok(!PATCH_OPTIONS_KEYS.includes('plane'))
  })

  // ── 形状检查：逐条 ───────────────────────────────────────────────────────

  test('★★ 顶层必须是数组（DSH 对非数组直接抛）', () => {
    for (const bad of [{ patch: [] }, null, 'x', 42, undefined]) {
      const got = patchDocumentProblems(bad)
      assert.ok(got.some((p) => p.code === PATCH_DOCUMENT_CODES.NOT_AN_ARRAY),
        `${JSON.stringify(bad)} 没有被拦下`)
    }
    // DSH 自己的模板就是 `[]`，必须**合法**
    assert.deepEqual(patchDocumentProblems([]), [])
  })

  test('★★ `insert` 必须是数组（DSH 会直接 .forEach 它）', () => {
    // `insert: after:tools` 正是此前磁盘上那份文件的真实形状。
    const legacy = [{ id: 'legion-enforcement-hard-floor', insert: 'after:tools', plane: 'host' }]
    const codes = patchDocumentProblems(legacy).map((p) => p.code)
    assert.ok(codes.includes(PATCH_DOCUMENT_CODES.INSERT_NOT_ARRAY))
    assert.ok(codes.includes(PATCH_DOCUMENT_CODES.UNKNOWN_KEY))
    // 数组元素也必须是对象
    assert.ok(patchDocumentProblems([{ insert: [1] }]).some((p) => p.code === PATCH_DOCUMENT_CODES.INSERT_ENTRY_NOT_OBJECT))
    assert.ok(patchDocumentProblems([{ insert: [null] }]).some((p) => p.code === PATCH_DOCUMENT_CODES.INSERT_ENTRY_NOT_OBJECT))
  })

  test('★★★ `insert` 与 `id` 同时出现必须被拦下（会被 warn-and-skip）', () => {
    // 实测（真 applyEntryPatches）：靶子不存在或不 group 时都是
    // `patch insert: entry ... not found / is not a group` → 静默跳过。
    // 而它**看起来**像"给这次插入取个 id"。
    const got = patchDocumentProblems([
      { id: 'legion-enforcement-hard-floor', insert: [{ name: 'file:///x.js' }] },
    ])
    assert.ok(got.some((p) => p.code === PATCH_DOCUMENT_CODES.INSERT_WITH_TARGET_ID))
    assert.match(got.find((p) => p.code === PATCH_DOCUMENT_CODES.INSERT_WITH_TARGET_ID).detail,
      /group/, '理由必须说清靶子得是已存在的 group 行')
    // 根级 insert（无 id）必须合法
    assert.deepEqual(patchDocumentProblems([{ insert: [{ name: 'file:///x.js' }] }]), [])
    // patch-over（id + config）必须合法
    assert.deepEqual(patchDocumentProblems([{ id: 'permission', config: { presets: {} } }]), [])
  })

  test('★★ insert 项没有 name 会被 warn-and-skip，必须被拦下', () => {
    for (const bad of [{}, { name: '' }, { name: '   ' }, { id: 'x' }]) {
      const got = patchDocumentProblems([{ insert: [bad] }])
      assert.ok(got.some((p) => p.code === PATCH_DOCUMENT_CODES.INSERT_ENTRY_NO_NAME),
        `${JSON.stringify(bad)} 没被拦下`)
    }
  })

  test('★★ 未知键必须被点名（DSH 不报错，静默忽略）', () => {
    const doc = [{ id: 'a', plane: 'host' }, { id: 'b', insert: [{ name: 'x' }], after: 'tools' }]
    const unknown = unknownPatchKeys(doc)
    assert.deepEqual(unknown.map((u) => u.key).sort(), ['after', 'plane'])
    const got = patchDocumentProblems(doc)
    assert.equal(got.filter((p) => p.code === PATCH_DOCUMENT_CODES.UNKNOWN_KEY).length, 2)
    // ★ 按码取，不要按位置取：`problems` 是按**项序**排的，第 1 项同时有
    //   insert-with-id 与未知键两个问题，`got[0]` 抓到的是前一个。
    assert.match(got.find((p) => p.code === PATCH_DOCUMENT_CODES.UNKNOWN_KEY).detail, /静默忽略/)
  })

  test('★ `config` 必须是普通对象', () => {
    for (const bad of ['x', 1, []]) {
      assert.ok(patchDocumentProblems([{ id: 'permission', config: bad }])
        .some((p) => p.code === PATCH_DOCUMENT_CODES.CONFIG_NOT_OBJECT))
    }
    assert.deepEqual(patchDocumentProblems([{ id: 'permission', config: {} }]), [])
  })

  test('★ `assertPatchDocumentLoadable` 抛出的错带码与全部问题', () => {
    try {
      assertPatchDocumentLoadable([{ id: 'a', plane: 'host' }])
      assert.fail('应当抛')
    } catch (e) {
      assert.equal(e.code, PATCH_DOCUMENT_CODES.UNKNOWN_KEY)
      assert.ok(Array.isArray(e.problems) && e.problems.length >= 1)
      assert.match(e.message, /不能被 DSH 加载/)
    }
    // 合法文档原样返回
    const good = [{ insert: [{ name: 'file:///x.js' }] }]
    assert.equal(assertPatchDocumentLoadable(good), good)
  })

  test('★ isPlainObject 的边界', () => {
    for (const v of [{}, { a: 1 }]) assert.equal(isPlainObject(v), true)
    for (const v of [null, undefined, [], 'x', 1, true]) assert.equal(isPlainObject(v), false)
  })

  // ── 生成器 ───────────────────────────────────────────────────────────────

  test('★★★ 字符串**一律**双引号 —— `!!js` 注入没有路径能产出', () => {
    // 不做"看起来危险才加引号"的判断：
    //
    //   > 一个"只在看起来危险时才加引号"的生成器，
    //   > 与一个"该加的时候恰好没加"的生成器，在它漏的那一天之前是同一个东西。
    //
    // 双引号标量永远不会被当成 tag，于是整类注入被**结构**关掉，而不是被一个判据关掉。
    for (const s of ['plain', 'workspace-write', 'Legion · 有人值守', '!!js process.exit(1)',
      'a: b', '#c', '- d', '*e', '&f', '|g', '>h', '%i', '@j', '`k', '{l}', '[m]', 'true', 'null', '123', '']) {
      const out = scalarOf(s)
      assert.equal(out, JSON.stringify(s), `${JSON.stringify(s)} 没被印成双引号标量`)
      assert.equal(JSON.parse(out), s, '双引号标量必须能原样 JSON 往返')
      assert.ok(out.startsWith('"') && out.endsWith('"'))
    }
  })

  test('★★ 标量生成器拒绝非有限数与不支持的载体', () => {
    assert.equal(scalarOf(null), 'null')
    assert.equal(scalarOf(true), 'true')
    assert.equal(scalarOf(false), 'false')
    assert.equal(scalarOf(0), '0')
    assert.throws(() => scalarOf(NaN), /非有限数/)
    assert.throws(() => scalarOf(Infinity), /非有限数/)
    assert.throws(() => scalarOf(undefined), /不接受/)
    assert.throws(() => scalarOf(() => {}), /不接受/)
    assert.throws(() => scalarOf([]), /不接受/)
  })

  test('★★★ 生成器吐出的 YAML **通过它自己的检查器**', () => {
    // "能造出来"与"能加载"不能是两件事——那正是本模块要消灭的那道缝。
    const built = toPatchDocument({
      rows: [
        { id: 'legion-enforcement-hard-floor', mount: { anchor: 'insert', after: 'tools' }, module: 'file:///x.js' },
        { id: 'legion-enforcement-approval-answerer', mount: { anchor: 'insert', after: 'approval' }, module: 'file:///y.js' },
        { id: 'legion-enforcement-permission-presets', mount: { anchor: 'patch-over', target: 'permission' }, module: null },
      ],
      presets: { 'legion-attended': { sandbox: 'workspace-write', approval: 'ask', name: 'Legion · 有人值守' } },
    })
    assert.deepEqual(built.unbuildable, [])
    assert.deepEqual(patchDocumentProblems(built.document), [])

    const text = renderPatchYamlText(built.document)
    const lines = text.split('\n')
    assert.equal(lines[0], '- insert:', '第一个补丁项应是根级 insert（与 DSH 的 base bundle 同形）')
    // 两行 insert 必须在**同一个** insert 项里
    assert.equal(built.document.filter((d) => 'insert' in d).length, 1)
    assert.equal(built.document.find((d) => 'insert' in d).insert.length, 2)
    assert.match(text, /file:\/\/\/x\.js/)
    assert.match(text, /Legion · 有人值守/)
    assert.match(text, /sandbox: "workspace-write"/, '字符串值要带引号')
    assert.ok(!/^\s*plane:/m.test(text), 'plane 不得进文件')
  })

  test('★ 空数组 / 空对象印成 `[]` / `{}`（不是空行）', () => {
    const text = renderPatchYamlText([
      { id: 'a', config: { presets: {} } },
      { insert: [{ name: 'file:///x.js', inject: [] }] },
    ])
    assert.match(text, /presets: \{\}/)
    assert.match(text, /inject: \[\]/)
    assert.ok(!/\n\s*\n/.test(text.replace(/^\n/, '')), '不应出现由空容器造成的空行')
  })

  test('★ 自定义 header 会加上 `#`，且不破坏数组首位', () => {
    const text = renderPatchYamlText([{ insert: [{ name: 'x' }] }], { header: ['已注释', '# 已带井号'] })
    assert.match(text, /^# 已注释$/m)
    assert.match(text, /^# 已带井号$/m)
    // ★ 必须对**匹配结果**取反，不是对正则对象取反 ——
    //   一个正则对象永远是真值，于是 `assert.ok(!/re/)` 恒假。
    //   （这条断言第一版就是这么写错的：它红了，但理由是"它在断言一个恒假的东西"，
    //    而不是"生成器重复加了井号"。）
    assert.ok(!/^## 已带井号$/m.test(text), '不该重复加井号')
  })

  // ── 组装器 ───────────────────────────────────────────────────────────────

  test('★★★ patch-over 只带 config；insert 只带根级一个插入项', () => {
    const rows = [
      { id: 'legion-enforcement-hard-floor', mount: { anchor: 'insert', after: 'tools' }, module: null },
      { id: 'legion-enforcement-pre-execute', mount: { anchor: 'insert', after: 'tools' }, module: null },
      { id: 'legion-enforcement-permission-presets', mount: { anchor: 'patch-over', target: 'permission' }, module: null },
    ]
    // 模块都有：两个 insert 行合成**一个**根级插入项，patch-over 单独一项
    const built = toPatchDocument({ rows, presets: { p: { sandbox: 'read-only' } }, moduleUrlOf: (m) => `file:///${m}.js` })
    assert.deepEqual(built.unbuildable, [])
    assert.equal(built.document.length, 2)
    const ins = built.document.find((d) => 'insert' in d)
    assert.ok(!('id' in ins), '根级插入项不得带 id')
    assert.deepEqual(ins.insert.map((e) => e.id), ['legion-enforcement-hard-floor', 'legion-enforcement-pre-execute'])
    const over = built.document.find((d) => d.id === 'permission')
    assert.deepEqual(over.config.presets, { p: { sandbox: 'read-only' } })
    assert.ok(!('insert' in over))

    // 模块全缺：只有 patch-over 进文档，两行被报成造不出来
    const none = toPatchDocument({ rows, presets: {} })
    assert.equal(none.document.length, 1)
    assert.equal(none.unbuildable.length, 2)
    for (const u of none.unbuildable) {
      assert.equal(u.code, PATCH_DOCUMENT_CODES.ROW_MODULE_MISSING)
      assert.match(u.detail, /warn-and-skip/)
    }
  })

  test('★★ `moduleUrlOf` 默认**不给兜底**（编不出模块名就不该假装有）', () => {
    //   > 一个"模块名编也能编出来"的默认值，会让 unbuildable 永远是空的。
    const built = toPatchDocument({ rows: [{ id: 'r', mount: { anchor: 'insert' }, module: null }] })
    assert.equal(built.unbuildable.length, 1)
    assert.deepEqual(built.document, [])
    // 传了 resolver 就必须用它的返回值
    const withR = toPatchDocument({
      rows: [{ id: 'r', mount: { anchor: 'insert' }, module: null }],
      moduleUrlOf: () => 'file:///resolved.js',
    })
    assert.equal(withR.unbuildable.length, 0)
    assert.equal(withR.document[0].insert[0].name, 'file:///resolved.js')
    // resolver 返回空白也算没有
    const blank = toPatchDocument({
      rows: [{ id: 'r', mount: { anchor: 'insert' }, module: 'm' }],
      moduleUrlOf: () => '   ',
    })
    assert.equal(blank.unbuildable.length, 1)
  })

  test('★ 没有可插入的行时，文档里不出现空的 insert 项', () => {
    const built = toPatchDocument({
      rows: [{ id: 'legion-enforcement-permission-presets', mount: { anchor: 'patch-over', target: 'permission' }, module: null }],
      presets: { p: {} },
    })
    assert.equal(built.document.length, 1)
    assert.ok(!built.document.some((d) => 'insert' in d), '空的 insert 项没有意义，不该出现')
  })
})
