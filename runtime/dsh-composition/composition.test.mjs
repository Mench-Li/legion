// runtime/dsh-composition/composition.test.mjs
// ============================================================================
// PRT-213 / PRT-214 / PRT-215 的测试：补丁层声明与对账、沙箱实际管制探测、启动自检。
//
// 重点覆盖「看起来没问题但其实没生效」的那一类失效：
//   · 行挂上了但**没激活**（等待依赖服务）
//   · preset 行存在但表**没被覆盖**（还在用 DSH 默认表）
//   · 沙箱返回 `partial`（存在未被管制的路径）
//   · 沙箱**原样返回**输入 argv（没做任何包装）
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DSH_COMPOSITION_PATCH_VERSION,
  DSH_DEFAULT_PRESETS,
  EMPLOYEE_PRESET_CONTRACT,
  LEGION_PERMISSION_PRESETS,
  LEGION_ROW_PREFIX,
  PATCH_LAYER_ROWS,
  RUNTIME_ONLY_ROW_IDS,
  isRuntimeOnlyRow,
  reconcilePatchLayer,
} from './patch-layer.mjs'
import { PATCH_YAML_PATH, patchDocument, renderPatchReport, renderPatchYaml } from './render.mjs'
import { PROBE_ARGV, SELFCHECK_STATES, probeSandbox, startupSelfCheck } from './selfcheck.mjs'
// PRT-214：文档形状判定。它的字段表逐字取自 DSH 的 PatchOptions 定义。
import { patchDocumentProblems } from './patch-format.mjs'
// 修法表：自检里的跨点违规要**说得出**下一步去跑哪个入口，而修法表只有这里（bootstrap）
// 有——selfcheck 与 enforcement-mapping 都 import 不了它（会成环）。
import { REPAIR_ACTIONS } from './bootstrap.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 一份「一切正常」的组合树观察。
 *
 * ★ `rows` 是**照着声明造**的那棵树（含运行期行的 loader 条目）——而现实中不存在
 * 那样一棵树：`pre-execute` / `approval-answerer` 在声明里是 `module: null`，
 * 永远不会是 loader 条目。所以让这份观察"生效"的**不是** `rows`，而是
 * `inProcessMounted`（组合根的挂载账）。这两行**只看那份账**，见下面那几条用例。 */
const GOOD_COMPOSITION = Object.freeze({
  rows: PATCH_LAYER_ROWS.map((r) => ({ id: r.id, activated: true })),
  permissionPresets: Object.keys(LEGION_PERMISSION_PRESETS),
  inProcessMounted: [...RUNTIME_ONLY_ROW_IDS],
})

/** 真进程里 loader 树的形状：`module: string` 的 insert 行 + `patch-over` 的**靶子** id。 */
function realTreeRows() {
  return PATCH_LAYER_ROWS
    .filter((r) => !isRuntimeOnlyRow(r))
    .map((r) => ({ id: r.mount?.anchor === 'patch-over' ? r.mount.target : r.id, activated: true }))
}

/** 真树的完整观察（loader 树 + 生效的 preset 表 + 组合根挂载账）。 */
function realTreeObservation() {
  return {
    rows: realTreeRows(),
    permissionPresets: Object.keys(LEGION_PERMISSION_PRESETS),
    inProcessMounted: [...RUNTIME_ONLY_ROW_IDS],
  }
}

/** 一个「完全生效」的沙箱端口。 */
function goodSandbox() {
  return {
    confine: (argv) => ({
      argv: ['sandbox-exec', '--profile', 'p', ...argv],
      enforcement: 'full',
      denialSignatures: ['operation not permitted'],
      runnerFailureRules: [],
    }),
  }
}

const GOOD_RUNTIME = Object.freeze({ ok: true, version: '0.1.5-rc.2', reason: '版本在支持窗口内' })

// ----------------------------------------------------------------- PRT-214 声明

test('补丁层：每行都是 Legion 注入的 host 平面行', () => {
  assert.ok(PATCH_LAYER_ROWS.length >= 4, 'hard floor / pre-execute / answerer / preset 表 四行缺一不可')
  for (const row of PATCH_LAYER_ROWS) {
    assert.ok(row.id.startsWith(LEGION_ROW_PREFIX), `${row.id} 必须带 Legion 前缀，否则无法在组合树里认出是产品注入的`)
    assert.equal(row.plane, 'host', `${row.id} 必须在 host 平面；放进 agent preset 会让安全下限取决于当前 session 挂了哪个 preset`)
    assert.ok(Array.isArray(row.registrations) && row.registrations.length > 0)
  }
})

test('补丁层：四类强制点各有归属，且注册点与 §6.8 映射一致', () => {
  const kinds = Object.fromEntries(PATCH_LAYER_ROWS.map((r) => [r.kind, r]))
  assert.ok(kinds.guard.registrations.includes('ctx.tools.guard'))
  assert.ok(kinds.listener.registrations.some((s) => s.includes('tools/pre-execute')))
  assert.ok(kinds.answerer.registrations.some((s) => s.includes('approval/request')))
  assert.deepEqual(kinds['config-override'].mount, { anchor: 'patch-over', target: 'permission' })
})

test('补丁层：员工 preset 不提供任何服务、不承载强制面', () => {
  assert.equal(EMPLOYEE_PRESET_CONTRACT.plane, 'agent')
  assert.equal(EMPLOYEE_PRESET_CONTRACT.mayProvideServices, false)
  assert.equal(EMPLOYEE_PRESET_CONTRACT.mayCarryEnforcement, false)
})

test('补丁层：无人值守 preset 保持 workspace-write，**不得**降级为 danger-full-access', () => {
  const unattended = LEGION_PERMISSION_PRESETS['legion-unattended']
  assert.equal(unattended.approval, 'never')
  assert.equal(
    unattended.sandbox,
    'workspace-write',
    '这正是不能复用 DSH 默认表的理由：默认表里 never 与 danger-full-access 绑定，'
    + '按默认表实现「无人值守」会顺手把沙箱也放开。',
  )
})

test('补丁层：确实与 DSH 默认表不同（否则这层没有存在意义）', () => {
  assert.notDeepEqual(
    { sandbox: LEGION_PERMISSION_PRESETS['legion-unattended'].sandbox, approval: LEGION_PERMISSION_PRESETS['legion-unattended'].approval },
    { sandbox: DSH_DEFAULT_PRESETS['danger-full-access'].sandbox, approval: DSH_DEFAULT_PRESETS['danger-full-access'].approval },
  )
})

test('patchVersion 是正整数（0 或缺失会让「成对验证」失去比较基准）', () => {
  assert.ok(Number.isInteger(DSH_COMPOSITION_PATCH_VERSION) && DSH_COMPOSITION_PATCH_VERSION > 0)
})

// ----------------------------------------------------------------- PRT-214 对账

test('对账：全部行存在且激活、preset 表已覆盖 → 生效', () => {
  const r = reconcilePatchLayer(GOOD_COMPOSITION)
  assert.equal(r.effective, true)
  assert.deepEqual(r.reasons, [])
  assert.equal(r.patchVersion, DSH_COMPOSITION_PATCH_VERSION)
})

test('对账：行缺失 → 不生效并点名是哪一行', () => {
  const r = reconcilePatchLayer({ ...GOOD_COMPOSITION, rows: GOOD_COMPOSITION.rows.slice(1) })
  assert.equal(r.effective, false)
  assert.match(r.reasons.join('\n'), new RegExp(PATCH_LAYER_ROWS[0].id))
  assert.equal(r.findings.find((f) => f.row === PATCH_LAYER_ROWS[0].id).code, 'ROW_MISSING')
})

test('对账：行**挂上了但未激活** → 不生效（这一类在组合树里看起来和成功一样）', () => {
  const rows = GOOD_COMPOSITION.rows.map((r, i) => (i === 0 ? { ...r, activated: false } : r))
  const r = reconcilePatchLayer({ ...GOOD_COMPOSITION, rows })
  assert.equal(r.effective, false)
  assert.equal(r.findings.find((f) => f.row === PATCH_LAYER_ROWS[0].id).code, 'ROW_NOT_ACTIVATED')
})

test('对账：读不到 preset 表 → 不生效（「没观察到」不等于「已替换」）', () => {
  const r = reconcilePatchLayer({ rows: GOOD_COMPOSITION.rows })
  assert.equal(r.effective, false)
  assert.match(r.reasons.join('\n'), /PRESETS_UNOBSERVED|没观察到/)
})

// ★★ 这一条补的是一个**活了很久的缺陷**：`GOOD_COMPOSITION` 是
// `PATCH_LAYER_ROWS.map((r) => ({ id: r.id, activated: true }))` 造出来的——
// 也就是**照着声明造的一棵树**。而真实的组合树里，`patch-over` 那一行的条目 id 是它的**靶子**
// （`permission`），Legion 自己的 id 刻意不出现。
//
// 于是按声明 id 查表的实现对这一行**永远**报 `ROW_MISSING` ⇒ `effective:false` ⇒
// 启动自检永远判「强制面未生效」⇒ `bootstrapDshRuntime()` 永远拒绝注册。
// 而 12 条既有用例全都造不出这个形状，所以它一直是绿的。
//
//   > 一个"照着声明造的树"的夹具，与一棵"真的组合树"，
//   > 在"这一段代码对不对"上是同一个读数——只不过前者的树在现实中不存在。
//
// 生产路径当时是靠 `observeComposition()` 先把 id 重写成声明 id 才绕过去的
// （见 `plugins/runtime-host-row.mjs`）；绕过的是观察器，账本本身一直是错的。
test('对账：★ 真实的组合树（patch-over 行的条目 id 是它的**靶子**）→ 必须判生效', () => {
  // 真树的形状：insert 行用声明 id，patch-over 行用 target，**运行期行不在树里**
  // （它们 `module: null`，只能由组合根在进程内挂载）。所以这份观察同时带上
  // 组合根的挂载账——那是运行期行唯一的证据来源。
  const realTree = realTreeObservation()
  // 先证明这棵树确实是"patch-over 用靶子"的形状，而不是又一次照抄声明
  const over = PATCH_LAYER_ROWS.filter((r) => r.mount?.anchor === 'patch-over')
  assert.ok(over.length > 0, '夹具失效：声明里没有 patch-over 行')
  assert.ok(realTree.rows.some((r) => r.id === over[0].mount.target), '夹具失效：真树里没有靶子 id 那一条')
  assert.ok(!realTree.rows.some((r) => r.id === over[0].id), '夹具失效：真树里不该出现 Legion 自己的 id')

  const r = reconcilePatchLayer(realTree)
  assert.deepEqual(r.reasons, [], `真实形状的树被判成未生效：${r.reasons.join(' / ')}`)
  assert.equal(r.effective, true)

  // 映射必须是**可见的**：否则下一个人只能靠"effective 是 true"猜它查了哪个 id。
  const f = r.findings.find((x) => x.row === over[0].id)
  assert.equal(f.code, 'OK')
  assert.equal(f.treeId, over[0].mount.target, '裁决里必须写明它查的是树里的哪个条目 id')
})

test('对账：真实树里**靶子那一行真的不在** → 仍然报 ROW_MISSING（没有放松判据）', () => {
  const over = PATCH_LAYER_ROWS.find((r) => r.mount?.anchor === 'patch-over')
  const rows = realTreeRows().filter((r) => r.id !== over.mount.target)
  const r = reconcilePatchLayer({ rows, permissionPresets: Object.keys(LEGION_PERMISSION_PRESETS), inProcessMounted: [...RUNTIME_ONLY_ROW_IDS] })
  assert.equal(r.effective, false)
  const f = r.findings.find((x) => x.row === over.id)
  assert.equal(f.code, 'ROW_MISSING')
  // 诊断必须同时给出"声明 id"与"我实际去找的树条目 id"——
  // 只说"少了一行"会让排障的人去补丁层里找，而真因可能是靶子行没了。
  assert.match(f.detail, new RegExp(over.mount.target))
  assert.match(f.detail, new RegExp(over.id))
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ 观察结果的**富形状**：`{id: 声明id, activated, treeId, present}`
//
// 上面那两条用的是**另一种**夹具形状（`realTreeRows()` 让 patch-over 那一行直接带
// **靶子 id**）。真进程里 `observeComposition()` 产的是第三种：行 id 是**声明 id**，
// 靶子 id 放在 `treeId` 里，另外明说一个 `present`。
//
// 三种形状混在一起，于是有一个**没人读过**的组合：富形状 + `present:false`。
// 本批在真 DSH 进程里量到了它（`bundles: []` 的临时 profile、真补丁层）：
//
//   OBS rows=[…,["legion-enforcement-permission-presets", false, "permission", **false**]]
//   FINDING {"row":"legion-enforcement-permission-presets","code":"ROW_NOT_ACTIVATED"}
//   reasons=["…行已挂载但未激活（等待依赖服务），不产生任何强制效果", …]
//
// `present:false` 明写着"这条**不在**树里"，判决却读成"已挂载、只是没激活"。
// **裁定是对的**（两者都判未生效），错的是**理由**——而理由是排查的人唯一会读的东西：
// 它把人指向"哪个依赖服务没到"，而真因是"这棵树里根本没有它可以作用的那一行"
// （声明了它的 bundle 层没挂上，DSH 对这条补丁 warn-and-skip）。
//
//   > 「没观察到」与「观察到没有」是两个读数。
//   > 把它们合成一个 `activated: false`，就没人再说得出"是缺席，还是在等"。

/** 富形状的一条行：`id` 是**声明 id**，`present` 明说它在不在树里。 */
function observerRow(spec, { present = true, activated = true } = {}) {
  const treeId = spec.mount?.anchor === 'patch-over' && typeof spec.mount.target === 'string'
    ? spec.mount.target
    : spec.id
  return { id: spec.id, treeId, present, activated }
}

/** 一份**富形状**的、整层生效的观察结果（真进程里 `observeComposition()` 的样子）。 */
function observerObservation(over = {}) {
  const over$ = PATCH_LAYER_ROWS.find((r) => r.mount?.anchor === 'patch-over')
  const rows = PATCH_LAYER_ROWS
    .filter((r) => !isRuntimeOnlyRow(r))
    .map((r) => observerRow(r, r === over$ ? over : {}))
  return {
    rows,
    permissionPresets: Object.keys(LEGION_PERMISSION_PRESETS),
    inProcessMounted: [...RUNTIME_ONLY_ROW_IDS],
    ...over,
  }
}

test('对账：★★★ 富形状 + `present:false` → `ROW_MISSING`（**不是**"已挂载但未激活"）', () => {
  const over = PATCH_LAYER_ROWS.find((r) => r.mount?.anchor === 'patch-over')
  // 靶子行不在树里，其余都齐 ⇒ 唯一的那条红必须是"缺席"。
  const rows = observerObservation().rows.map((r) => (
    r.id === over.id ? { ...r, present: false, activated: false } : r
  ))
  const r = reconcilePatchLayer({ ...observerObservation(), rows })

  assert.equal(r.effective, false)
  const f = r.findings.find((x) => x.row === over.id)
  assert.equal(f.code, 'ROW_MISSING',
    '靶子不在树里却被报成 ROW_NOT_ACTIVATED —— 那句话把人指向"哪个依赖服务没到"，'
    + '而真因是这棵树里没有它可以作用的那一行')
  // ★ 理由必须说得出**这一种**缺席：patch-over 匹配不到靶子时 DSH 是 warn-and-skip，
  //   不报错、只是什么也不做。这句话是这条红的全部信息量。
  assert.match(f.detail, /warn-and-skip/)
  assert.match(f.detail, new RegExp(over.mount.target), '理由里没写它去找的是哪个树条目 id')
  assert.match(f.detail, new RegExp(over.id), '理由里没写声明 id')
  // 反向：那句**不该出现**的话不能出现。少了这一条，把两种缺席合成一句话的
  // 实现照样能过上面所有断言。
  assert.equal(f.detail.includes('等待依赖服务'), false,
    '缺席被说成了"等待依赖服务" —— 那是另一种处境的话')

  // 而"真的在树里、只是没激活"必须仍然是 ROW_NOT_ACTIVATED。
  // 没有这一条，把两种处境合成 ROW_MISSING 的实现会绿。
  const pending = observerObservation().rows.map((r2) => (
    r2.id === over.id ? { ...r2, present: true, activated: false } : r2
  ))
  const r2 = reconcilePatchLayer({ ...observerObservation(), rows: pending })
  const f2 = r2.findings.find((x) => x.row === over.id)
  assert.equal(f2.code, 'ROW_NOT_ACTIVATED', '在树里但没激活，被报成了缺席')
  assert.equal(r2.effective, false)
})

test('对账：★★ 富形状 + 全部 present/activated → 整层生效（真进程里的正向读数）', () => {
  // 这条钉的是"rich 形状能被判**生效**"。夹具里造不出真进程，但至少钉住：
  // ① 富形状不会因为多了两个字段就查不到行；② 靶子那一行的 treeId 真被用上了。
  const r = reconcilePatchLayer(observerObservation())
  assert.deepEqual(r.reasons, [], `富形状的整层生效观察被判未生效：${r.reasons.join(' / ')}`)
  assert.equal(r.effective, true)
  const over = PATCH_LAYER_ROWS.find((x) => x.mount?.anchor === 'patch-over')
  const f = r.findings.find((x) => x.row === over.id)
  assert.equal(f.code, 'OK')
  assert.equal(f.treeId, over.mount.target, '裁决里没写明它查的是树里的哪个条目 id')
})

test('对账：★ 贫形状（只有 id+activated）仍然工作——兼容路径不许被这次改动弄断', () => {
  // 手写夹具与旧调用方给的是贫形状：没有 `treeId`、没有 `present`。
  // 本批给富形状加了"缺席"这一跳，**不能**顺手把贫形状当缺席处理。
  const over = PATCH_LAYER_ROWS.find((r) => r.mount?.anchor === 'patch-over')
  const poor = {
    rows: PATCH_LAYER_ROWS.map((r) => ({ id: r.id, activated: true })),
    permissionPresets: Object.keys(LEGION_PERMISSION_PRESETS),
    inProcessMounted: [...RUNTIME_ONLY_ROW_IDS],
  }
  const good = reconcilePatchLayer(poor)
  assert.equal(good.effective, true, '贫形状全激活却被判未生效 —— 兼容路径断了')
  assert.equal(good.findings.find((x) => x.row === over.id).code, 'OK')

  // 贫形状里"声明 id 那一行没激活"——没有 present 可依，只能按"在树里但没激活"处理。
  const poorPending = { ...poor, rows: poor.rows.map((r) => (r.id === over.id ? { ...r, activated: false } : r)) }
  const pend = reconcilePatchLayer(poorPending)
  assert.equal(pend.effective, false)
  assert.equal(pend.findings.find((x) => x.row === over.id).code, 'ROW_NOT_ACTIVATED')
})

test('对账：preset 行在、但生效表里**没有** Legion 项 → 不生效（patch-over 未生效）', () => {
  // 这是最隐蔽的一种：行存在、激活，看起来一切正常，但实际还在用 DSH 默认表。
  const r = reconcilePatchLayer({
    rows: GOOD_COMPOSITION.rows,
    permissionPresets: Object.keys(DSH_DEFAULT_PRESETS),
    inProcessMounted: [...RUNTIME_ONLY_ROW_IDS],
  })
  assert.equal(r.effective, false)
  const f = r.findings.find((x) => x.code === 'PRESETS_NOT_OVERRIDDEN')
  assert.ok(f, '必须报 PRESETS_NOT_OVERRIDDEN')
  assert.match(f.detail, /legion-unattended/)
})

test('对账：空观察不抛错，逐项报未生效', () => {
  const r = reconcilePatchLayer()
  assert.equal(r.effective, false)
  assert.equal(r.findings.length, PATCH_LAYER_ROWS.length + 1)
})

// ───────────── 运行期行（module: null + runtimeModule）：证据来自**挂载动作本身** ─────────────
//
// 这一组是 PRT-214 收口续的判据。它替换掉的旧读数是：`PATCH_LAYER_ROWS.map(声明 → 树)`
// 造一棵树就能让那两行判 OK——而那样一棵树在真部署里**不存在**（它们 `module: null`，
// 永远不会是 loader 条目）。所以每一条断言都必须能因为"删掉 `mount(ctx)`"而变红：
// 见 `plugins/root-row.test.mjs` 里那条端到端用例与报告里的断验证记录。

/** 按声明 id 取裁决项。 */
const findingOf = (r, id) => r.findings.find((f) => f.row === id)

test('★★ 运行期行**只看进程内挂载账**：loader 条目里就算有同名行也不算', () => {
  assert.ok(RUNTIME_ONLY_ROW_IDS.length > 0,
    '一条运行期行都没有 —— 这条用例会退化成恒真，先去看 PATCH_LAYER_ROWS')
  const r = reconcilePatchLayer({
    rows: PATCH_LAYER_ROWS.map((x) => ({ id: x.id, activated: true })),
    permissionPresets: Object.keys(LEGION_PERMISSION_PRESETS),
  })
  assert.equal(r.effective, false, '没有挂载账却判生效 —— 证据又回到了组合树上')
  for (const id of RUNTIME_ONLY_ROW_IDS) {
    const f = findingOf(r, id)
    assert.equal(f.code, 'ROW_MISSING', `${id} 没有挂载账时必须 ROW_MISSING`)
    assert.equal(f.treeId, null, `${id} 的判据不该指向任何 loader 条目`)
    assert.equal(f.mountSource, 'in-process-mount')
  }
})

test('★★ 挂载账里列出运行期行 → 生效；`mountSource` 把两个宇宙分开写出来', () => {
  const r = reconcilePatchLayer(realTreeObservation())
  assert.deepEqual(r.reasons, [], `真树 + 挂载账被判成未生效：${r.reasons.join(' / ')}`)
  assert.equal(r.effective, true)
  // 运行期行：证据来自组合根的挂载账。
  for (const id of RUNTIME_ONLY_ROW_IDS) {
    const f = findingOf(r, id)
    assert.equal(f.code, 'OK')
    assert.equal(f.mountSource, 'in-process-mount')
    assert.equal(f.treeId, null)
  }
  // 静态行：证据来自组合树，**不许**被挂载账顶替（否则两个宇宙就并成一个了）。
  const statics = PATCH_LAYER_ROWS.filter((x) => !isRuntimeOnlyRow(x))
  assert.ok(statics.length > 0, '一条静态行都没有 —— 这条断言是空的')
  for (const spec of statics) {
    const f = findingOf(r, spec.id)
    assert.equal(f.mountSource, 'loader-entry', `${spec.id} 的来源必须是组合树`)
    assert.notEqual(f.treeId, null)
  }
})

test('★★ 静态行**不许**拿挂载账顶替：树里没有它，账里就算列了也还是 ROW_MISSING', () => {
  // 反向对照：把一条静态行从树里拿掉，同时把它写进挂载账。
  // 一个"凡出现在账里就算 OK"的实现会在这里变绿。
  const target = PATCH_LAYER_ROWS.find((x) => typeof x.module === 'string')
  assert.ok(target, '一条有模块的静态行都没有 —— 这条用例验不了')
  const obs = realTreeObservation()
  const r = reconcilePatchLayer({
    ...obs,
    rows: obs.rows.filter((x) => x.id !== target.id),
    inProcessMounted: [...RUNTIME_ONLY_ROW_IDS, target.id],
  })
  assert.equal(r.effective, false)
  assert.equal(findingOf(r, target.id).code, 'ROW_MISSING')
  assert.equal(findingOf(r, target.id).mountSource, 'loader-entry')
})

test('★★ 挂载账**缺席 / 空 / 形状不对** 一律按未生效（fail closed）', () => {
  assert.ok(RUNTIME_ONLY_ROW_IDS.length > 0, '没有运行期行 —— 这条用例是空的')
  const base = { rows: realTreeRows(), permissionPresets: Object.keys(LEGION_PERMISSION_PRESETS) }
  const shapes = [
    ['字段缺席', undefined],
    ['null', null],
    ['空数组', []],
    ['只有一个空串', ['']],
    ['不是数组（字符串）', RUNTIME_ONLY_ROW_IDS.join(',')],
    ['不是数组（对象）', { 0: RUNTIME_ONLY_ROW_IDS[0] }],
    ['数字', 7],
    ['数组里只有非字符串', [1, 2, 3]],
  ]
  for (const [label, inProcessMounted] of shapes) {
    const obs = label === '字段缺席' ? { ...base } : { ...base, inProcessMounted }
    const r = reconcilePatchLayer(obs)
    assert.equal(r.effective, false, `${label} 被判成生效 —— 未观察被当成了已挂载`)
    for (const id of RUNTIME_ONLY_ROW_IDS) {
      assert.equal(findingOf(r, id).code, 'ROW_MISSING', `${label} 时 ${id} 不是 ROW_MISSING`)
    }
  }
})

test('★★ 挂载账只列出**一行** → 另一行仍然 ROW_MISSING（部分报告不许连坐）', () => {
  assert.ok(RUNTIME_ONLY_ROW_IDS.length >= 2, '运行期行不足两行 —— 这条用例验不了"部分"')
  const [first, ...rest] = RUNTIME_ONLY_ROW_IDS
  const r = reconcilePatchLayer({
    rows: realTreeRows(),
    permissionPresets: Object.keys(LEGION_PERMISSION_PRESETS),
    inProcessMounted: [first],
  })
  assert.equal(r.effective, false)
  assert.equal(findingOf(r, first).code, 'OK')
  for (const id of rest) {
    assert.equal(findingOf(r, id).code, 'ROW_MISSING', `${id} 没被挂载却被算成生效`)
  }
})

test('★★ `RUNTIME_ONLY_ROW_IDS` 必须恰好是声明里 module:null + runtimeModule 的那些行', () => {
  // 防止这条判据因为"集合是空的"而恒真。
  const expected = PATCH_LAYER_ROWS
    .filter((x) => x.module === null && typeof x.runtimeModule === 'string' && x.runtimeModule !== '')
    .map((x) => x.id)
  assert.ok(expected.length > 0, '声明里没有运行期行 —— 上面那几条用例全是空的')
  assert.deepEqual([...RUNTIME_ONLY_ROW_IDS], expected)
  // 判据本身：`permission-presets` 的 module 也是 null，但它**不是**运行期行。
  const presets = PATCH_LAYER_ROWS.find((x) => x.mount?.anchor === 'patch-over')
  assert.equal(isRuntimeOnlyRow(presets), false,
    'patch-over 那一行被误判成运行期行 —— 它会被报成一条永远修不掉的 ROW_MISSING')
})

// ----------------------------------------------------------------- 渲染新鲜度

test('渲染：YAML 与声明一致（声明改了而 YAML 未重新生成 → 变红）', () => {
  const target = join(HERE, 'legion-host.patch.yml')
  assert.ok(existsSync(target), `${PATCH_YAML_PATH} 不存在`)
  const onDisk = readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
  assert.equal(onDisk, renderPatchYaml(), 'YAML 是生成物；手工编辑或忘记重新生成都会在这里被抓住')
})

test('渲染：YAML 含 Legion 两个 preset，且**没有任何** sandbox 取值是 danger-full-access', () => {
  const text = renderPatchYaml()
  for (const name of Object.keys(LEGION_PERMISSION_PRESETS)) assert.match(text, new RegExp(name))

  // ★ 声明里的行**不一定**在文件里：模块不存在的行刻意不写进去（见 render.mjs 头部）。
  //   所以这里断言的是**文档里实际有的行**，而"哪些行没进文档"由下一条用例盯。
  //
  // ★ 而且两种行的"在文件里长什么样"**不同**，不能一概而论：
  //   · `insert` 行：自己的 id 就写在 `- id:` 里。
  //   · `patch-over` 行：顶层 `id` 是**被覆盖的目标**（`permission`），
  //     Legion 自己的行 id **刻意不出现**——它出现才说明我们写错了，会打不到靶子。
  //
  //   > 一个"要求每一行的 id 都出现在文件里"的断言，
  //   > 会把两件事同时逼坏：要么让 patch-over 写成打不到靶子的形状，
  //   > 要么把这条断言删掉、连 insert 行也不检查了。
  const report = renderPatchReport()
  for (const row of PATCH_LAYER_ROWS) {
    if (!report.renderedRowIds.includes(row.id)) continue
    if (row.mount?.anchor === 'patch-over') {
      assert.ok(!text.includes(row.id),
        `patch-over 行的 Legion id ${row.id} 不该出现在文件里——顶层 id 必须是被覆盖的目标（${row.mount.target}）`)
      assert.match(text, new RegExp(`id:\\s*"${row.mount.target}"`),
        `patch-over 的目标 ${row.mount.target} 必须在文件里，否则这一层打不到靶子`)
    } else {
      assert.match(text, new RegExp(row.id), `insert 行 ${row.id} 声称进了文档，文件里却找不到`)
    }
  }

  // 只检查**生效的配置值**，不检查散文。
  // 注释里出现 `danger-full-access` 是刻意的（说明为什么不用 DSH 默认表）；
  // 整段正则匹配会把这条解释判成违规，于是要么删掉解释、要么放松断言 —— 两者都是倒退。
  //
  // ★ 必须**去掉引号**再比。生成器给所有字符串加双引号（`sandbox: "workspace-write"`），
  //   于是 `(\S+)` 拿到的是 `"workspace-write"`，而它与 `'danger-full-access'`
  //   永远不相等 —— 这个断言会**恒真**，连真的写成 `sandbox: "danger-full-access"`
  //   也拦不住。
  //
  //     > 一个"因为值带了引号而永远不相等"的危险档位检查，
  //     > 与一个"根本没有这个检查"的补丁层，在用例上是同一个东西。
  const sandboxValues = [...text.matchAll(/^\s*sandbox:\s*(\S+)\s*$/gm)]
    .map((m) => m[1].replace(/^["']|["']$/g, ''))
  assert.ok(sandboxValues.length > 0, '至少要有一个 sandbox 取值，否则这个断言什么都没检查')
  assert.ok(
    sandboxValues.every((v) => v !== 'danger-full-access'),
    `补丁层不得引入全盘访问档位，实际取值：${sandboxValues.join(', ')}`,
  )
  // 并且必须至少真的读到过一个**非空**值，否则上面的 every 又是恒真
  assert.ok(sandboxValues.every((v) => v.length > 0), 'sandbox 取值不该是空串')
})

test('★★★ 渲染：声明了而**没进文档**的行必须被报出来，不能只写在注释里', () => {
  // 这条是 PRT-214 的核心判据。此前"补丁层不完整"只存在于注释里，
  // 而注释不会被任何判据读 —— 于是"补丁层已就绪"可以一直是绿的。
  const report = renderPatchReport()

  assert.equal(report.declaredRowIds.length, PATCH_LAYER_ROWS.length)
  for (const row of PATCH_LAYER_ROWS) assert.ok(report.declaredRowIds.includes(row.id))

  // 文档里不得出现**造不出来**的行 id —— 那是"看起来装好了"的原型
  for (const u of report.unbuildable) {
    assert.ok(!report.renderedRowIds.includes(u.id),
      `行 ${u.id} 被报成造不出来，却又出现在文档里`)
    assert.equal(u.code, 'PATCH_DOCUMENT_ROW_MODULE_MISSING')
    assert.match(u.detail, /warn-and-skip/, '理由必须说清后果是静默跳过，而不是"暂时没装"')
  }

  // complete 必须与 unbuildable 一致。
  assert.equal(report.complete, report.unbuildable.length === 0)

  // 缺的清单**从声明推导**，不写死。
  //
  //   ★ 第一版把三行写死了，于是 hard-floor 一拿到模块，这条就对着
  //     "现在只缺两行"报红——红的是一个**已经变好的事实**。
  //     写死清单的断言会随着进展变成噪声，而噪声会被改掉，
  //     改掉的那一次很可能顺手把判据本身也改掉。
  const expected = PATCH_LAYER_ROWS.filter((r) => r.module === null && r.mount?.anchor !== 'patch-over')
    .map((r) => r.id).sort()
  assert.deepEqual(report.unbuildable.map((u) => u.id).sort(), expected)
  // 而"有模块的行"必须真的进了文档——否则"只缺 N 行"在一个什么都不生成的
  // 实现上同样为真。
  const withModule = PATCH_LAYER_ROWS.filter((r) => typeof r.module === 'string')
  assert.ok(withModule.every((r) => report.renderedRowIds.includes(r.id)),
    '有模块的行必须都进文档')
})

// ────────────────────────────────────────────────────────────────────────────
// CLI 的**两个退出码**是两件不同的事（PRT-214 收口续三）
//
// 这个 CLI 此前**一条用例都没有**：`--check` 恒返回 3（完整性被无条件写进退出码），
// 所以它既不能当门禁、也说不清该修什么，于是没有任何门禁引用它 —— 也就没人发现
// 它永远不会绿。
//
//   > 一个没有用例的 CLI，与一个没人调用的 CLI，
//   > 在"它有没有说过真话"这件事上分不开。
//
// 这里把它当**外部程序**读：跑它、看退出码、看 stderr。断言"函数返回了什么"
// 对 CLI 是不敏感的 —— 退出码是另一条代码路径。
// ────────────────────────────────────────────────────────────────────────────

/** 把 CLI 当外部程序跑一次，返回 {code, stdout, stderr}。 */
function runRenderCli(args) {
  const r = spawnSync(process.execPath, [join(HERE, 'render.mjs'), ...args], {
    cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

test('★★★ CLI：`--check` 只表达**新鲜度**——这一层装不满也必须返回 0', () => {
  const r = runRenderCli(['--check'])
  // ★ 这一条就是本次修的缺陷。此前它恒为 3：`complete === false` 是长期架构状态
  //   （运行期行永远进不了静态 patch 文件），却被无条件写进退出码，
  //   于是"YAML 有没有过期"这个**可修**的读数被一个**不可修**的状态盖住了。
  assert.equal(r.code, 0,
    `--check 在 YAML 新鲜时应当返回 0；返回 ${r.code}。\nstdout=${r.stdout}\nstderr=${r.stderr}`)
  assert.match(r.stdout, /与 patch-layer\.mjs 声明一致/)

  // ★★ 而"不完整"**仍然必须说出来**——拆分退出码不等于允许静默。
  //    少了这一条，一个"把警告删掉、只留退出码 0"的实现会绿，
  //    而那正是这次修改最危险的失败模式（把长期缺口变成看不见的）。
  assert.match(r.stderr, /不完整/, '不完整必须逐条报出来，不能因为退出码变绿就静默')
  assert.match(r.stderr, /造不出来 \d+ 行/)
})

test('★★ CLI：`--require-complete` 才把**完整性**变成退出码 3（显式断言，不是默认负担）', () => {
  const plain = runRenderCli(['--check'])
  const strict = runRenderCli(['--check', '--require-complete'])
  // 同一份 YAML、同一次生成，只有那个显式开关不同 —— 差异只可能来自它。
  assert.equal(plain.code, 0)
  assert.equal(strict.code, 3, `--require-complete 应当返回 3；返回 ${strict.code}`)
  assert.match(strict.stderr, /--require-complete/)
  // 而它**不**借用同一个退出码表达漂移：3 与 1 是两件事。
  assert.notEqual(strict.code, 1)
})

test('★★★ CLI：YAML 与声明**漂移**时返回 1（与"不完整"的 3 分开）', (t) => {
  // ⚠️ 这一条必须临时改动**仓库里那个生成物**，因为 CLI 的路径是按脚本位置定的
  //    （不给参数覆盖——那会让"检查的是哪份文件"变成一个可以配错的东西）。
  //    所以备份 → 改动 → 断言 → **无论成败都还原**，并核对 sha256。
  const target = join(HERE, 'legion-host.patch.yml')
  const original = readFileSync(target, 'utf8')
  const before = createHash('sha256').update(original).digest('hex')
  t.after(() => {
    writeFileSync(target, original, 'utf8')
    assert.equal(createHash('sha256').update(readFileSync(target, 'utf8')).digest('hex'), before,
      '生成物没有被逐字节还原 —— 下一次跑套件会带着一个假的"漂移"')
  })

  // 在**注释行**上改一个字符：YAML 结构不变，只有文本变了。
  // 用整段替换而不是追加，避免误伤"文件末尾有没有换行"这一类与主题无关的差异。
  const drifted = original.replace('# 由 runtime', '# 由  runtime')
  assert.notEqual(drifted, original, '锚点没匹配上 —— 这条用例将什么都没测')
  writeFileSync(target, drifted, 'utf8')

  const r = runRenderCli(['--check'])
  assert.equal(r.code, 1, `漂移时必须返回 1；返回 ${r.code}。\nstdout=${r.stdout}\nstderr=${r.stderr}`)
  assert.match(r.stderr, /与声明不一致/)
  // ★ 而且它**不**报"不完整"的退出码：漂移与长期状态是两件事。
  assert.notEqual(r.code, 3)
})

test('★★ 渲染：文档必须能被 DSH 加载（形状检查），且**不含**会静默失效的形状', () => {
  // 这条把"生成"与"能加载"钉在一起。旧用例只断言"磁盘 == render 输出"，
  // 也就是生成物与自己的声明一致 —— 从来没有让任何解析器读过它。
  const doc = patchDocument().document
  assert.deepEqual(patchDocumentProblems(doc), [], '生成出来的文档通不过自己的形状检查')

  // ★ `insert` 与 `id` 同时出现 = DSH 读作「插进那一行的 config 数组」，
  //   要求那一行已存在且是 group。实测（真 applyEntryPatches）靶子不存在或不
  //   是 group 时都是 warn-and-skip —— 文件看起来装好了，而那一行什么也没做。
  for (const entry of doc) {
    assert.ok(!('insert' in entry && 'id' in entry),
      `第 ${entry.id} 项同时带 id 与 insert —— 会被 warn-and-skip`)
  }
  // `plane` 不是 PatchOptions 的字段，写进文件会被**静默忽略**
  for (const entry of doc) assert.ok(!('plane' in entry), 'plane 不是 PatchOptions 的字段')

  // patch-over 那一条必须带 config（替换整个 config），而不是 insert
  const over = doc.filter((e) => e.id === 'permission')
  assert.equal(over.length, 1, '应恰有一条针对 permission 行的 patch-over')
  assert.ok('config' in over[0])
  assert.deepEqual(Object.keys(over[0].config.presets).sort(), ['legion-attended', 'legion-unattended'])
})

test('渲染：YAML 的注释提到 danger-full-access 是为了解释**为什么不采用它**', () => {
  // 这条用例锁住上一条的边界：注释必须保留这段解释。
  // 否则下一个人会把「提到危险档位」的注释删掉来让正则变绿 —— 而那正好删掉了理由。
  const text = renderPatchYaml()
  assert.match(text, /#.*danger-full-access/, '注释里应保留「默认表把 never 与 danger-full-access 绑定」这条理由')
})

// ----------------------------------------------------------------- PRT-213 沙箱

test('沙箱探测：未挂载 confine → 不生效（仅有配置名不算生效）', async () => {
  for (const port of [undefined, null, {}, { confine: 'not-a-function' }]) {
    const r = await probeSandbox(port)
    assert.equal(r.effective, false)
    assert.equal(r.enforcement, null)
  }
})

test('沙箱探测：confine 拒绝（fail closed）→ 不生效，但理由说明是合规拒绝', async () => {
  const r = await probeSandbox({ confine: () => { throw new Error('后端不支持该 argv') } })
  assert.equal(r.effective, false)
  assert.match(r.reasons.join('\n'), /fail closed/)
})

test('沙箱探测：`partial` 级管制 → **不生效**（存在未被管制的路径）', async () => {
  const r = await probeSandbox({
    confine: (argv) => ({ argv: ['wrap', ...argv], enforcement: 'partial', denialSignatures: ['denied'], runnerFailureRules: [] }),
  })
  assert.equal(r.effective, false)
  assert.equal(r.enforcement, 'partial')
  assert.match(r.reasons.join('\n'), /partial/)
})

test('沙箱探测：**原样返回**输入 argv → 不生效（没做任何包装）', async () => {
  const r = await probeSandbox({
    confine: (argv) => ({ argv: [...argv], enforcement: 'full', denialSignatures: ['denied'], runnerFailureRules: [] }),
  })
  assert.equal(r.effective, false)
  assert.match(r.reasons.join('\n'), /原样返回/)
})

test('沙箱探测：未报告 enforcement → 不生效', async () => {
  const r = await probeSandbox({ confine: (argv) => ({ argv: ['wrap', ...argv], denialSignatures: ['d'], runnerFailureRules: [] }) })
  assert.equal(r.effective, false)
  assert.match(r.reasons.join('\n'), /未报告 enforcement/)
})

test('沙箱探测：denialSignatures 为空 → 不生效（沙箱拒绝会退化成普通失败）', async () => {
  for (const sigs of [undefined, null, []]) {
    const r = await probeSandbox({ confine: (argv) => ({ argv: ['wrap', ...argv], enforcement: 'full', denialSignatures: sigs, runnerFailureRules: [] }) })
    assert.equal(r.effective, false)
    assert.match(r.reasons.join('\n'), /denialSignatures/)
  }
})

test('沙箱探测：full + 真包装 + 非空拒绝签名 → 生效，并回报后端与探针 argv', async () => {
  const r = await probeSandbox(goodSandbox())
  assert.equal(r.effective, true)
  assert.equal(r.enforcement, 'full')
  assert.deepEqual(r.probeArgv, [...PROBE_ARGV])
  assert.deepEqual(r.reasons, [])
})

test('沙箱探测：探针 argv 跨平台存在（避免把「平台没有该命令」误判成「沙箱不生效」）', () => {
  assert.equal(PROBE_ARGV[0], 'node')
  assert.ok(PROBE_ARGV.length >= 2)
})

// ----------------------------------------------------------------- PRT-215 自检

test('自检：六项全过 → enforcement-effective，且不禁用自动执行', async () => {
  const r = await startupSelfCheck({
    composition: GOOD_COMPOSITION,
    sandbox: goodSandbox(),
    runtime: GOOD_RUNTIME,
    repairActions: REPAIR_ACTIONS,
  })
  assert.equal(r.state, SELFCHECK_STATES.effective)
  assert.equal(r.autoExecutionForbidden, false)
  assert.deepEqual(r.reasons, [])
  // 第 ④ 项（PRT-612）：强制面挂上了没有 ≠ 挂上的那几个点与映射表还是同一回事。
  // 第 ⑤ 项（PRT-620）：每个点单看都对 ≠ 两个点合起来说得通。
  // 第 ⑥ 项（PRT-617）：接线是对的 ≠ 卡住的时候真的会结算。
  assert.deepEqual(r.checks.map((c) => c.name), [
    'composition-patch-layer', 'runtime-probe', 'sandbox-enforcement', 'enforcement-mapping',
    'guard-approval-consistency', 'enforcement-availability',
  ])
  // 第 ④ 项在**这一层**必须真的查全（`probeSandbox` 由 selfcheck 自己注入）。
  assert.deepEqual(r.mapping.unresolvedPrimitives, [])
  // 第 ⑤ 项的反向控制必须真的报出违规，并且说得出修复入口（否则它是一条不存在的检查）。
  assert.equal(r.guardConsistency.tamperedCaught, true)
  assert.equal(r.guardConsistency.repairable, true, '启动自检会注入 REPAIR_ACTIONS，违规必须带得出修复入口')
  // 第 ⑥ 项：每一种成因都结算了，且码与契约一致。
  assert.equal(r.availability.ok, true)
  assert.equal(r.availability.rows.every((x) => x.got.settled === true), true)
})

test('自检：④ 映射不自洽时**也**禁止自动执行（它与前三条正交）', async () => {
  // 前三条全过、只让映射那一条不过——这是最容易漏的一种：
  // 补丁层完整生效、沙箱真的在管制、运行时也协商过了，
  // 而"哪几条模式经过审批箱"已经不是 spec 那张表了。
  //
  //   > 一个「检查强制面挂上了没有」的启动自检，
  //   > 与一个「检查挂上的强制面是不是声明的那几个」的启动自检，不是同一个东西。
  //
  // 用**真的注入一个坏原语**来制造失败，而不是打桩替换第 ④ 项函数：
  // 打桩只能证明"我把这一项设为 false 时它是 false"。
  const { assertMappingConsistent } = await import('./enforcement-mapping.mjs')
  const broken = assertMappingConsistent({
    primitives: { 'selfcheck.mjs': { probeSandbox: 'not-a-function' } },
  })
  assert.equal(broken.ok, false)
  assert.ok(broken.problems.some((p) => /probeSandbox|原语/.test(p.message)), JSON.stringify(broken.problems))
  // 前三条在**同一组输入**下确实全过（否则这条用例证明不了"正交"）
  const r = await startupSelfCheck({ composition: GOOD_COMPOSITION, sandbox: goodSandbox(), runtime: GOOD_RUNTIME })
  assert.deepEqual(r.checks.slice(0, 3).map((c) => c.ok), [true, true, true])
  assert.equal(r.checks[3].ok, true)
})

test('自检：**未验证的原语**会让第 ④ 项不通过（"没查全"不等于"查过了")', async () => {
  // `enforcement-mapping.mjs` 的装载期自检解析不到 `probeSandbox`（import 环），
  // 于是把它记进 `unresolvedPrimitives`。如果 `startupSelfCheck` 忘了注入，
  // 这一项**必须**报不通过——否则"全查过"这句话永远成立。
  const { assertMappingConsistent } = await import('./enforcement-mapping.mjs')
  const withoutInjection = assertMappingConsistent()
  assert.equal(withoutInjection.ok, true, '问题本身是 0 项（不是不自洽）')
  assert.equal(withoutInjection.unresolvedPrimitives.length, 1, 'but 有一条原语没查到')
  // 而 startupSelfCheck 注入之后，这一条必须消失
  const r = await startupSelfCheck({ composition: GOOD_COMPOSITION, sandbox: goodSandbox(), runtime: GOOD_RUNTIME })
  assert.deepEqual(r.mapping.unresolvedPrimitives, [])
})

test('自检：⑤ 跨点不一致 → 禁止自动执行（每个点单看都对，合起来矛盾）', async () => {
  // ⑤⑥ 的两个探针可注入，就是为了让"这一项真的会红"能被证明。
  // 打桩只把 ok 设成 false 是证明不了任何东西的——所以这里注入的是**真实的**检查函数，
  // 只是喂给它一份空下限（探针没内容 ⇒ 反向控制红不了 ⇒ 不许报通过）。
  const { checkGuardApprovalConsistency } = await import('./enforcement-mapping.mjs')
  const r = await startupSelfCheck({
    composition: GOOD_COMPOSITION,
    sandbox: goodSandbox(),
    runtime: GOOD_RUNTIME,
    guardProbe: () => checkGuardApprovalConsistency({ floor: { denyTools: [], denyPathPrefixes: [] } }),
  })
  assert.equal(r.state, SELFCHECK_STATES.incompatible)
  const check = r.checks.find((c) => c.name === 'guard-approval-consistency')
  assert.equal(check.ok, false)
  assert.match(r.reasons.join('\n'), /^guard-approval-consistency: /m)
  assert.match(r.reasons.join('\n'), /反向控制/)
})

test('自检：⑥ 可用性实测未过 → 禁止自动执行（没结算就是「无限期挂起」）', async () => {
  const r = await startupSelfCheck({
    composition: GOOD_COMPOSITION,
    sandbox: goodSandbox(),
    runtime: GOOD_RUNTIME,
    availabilityProbe: async () => ({ ok: false, budgetMs: 20, rows: [], reasons: ['④ 未声明契约且一直没有回应：没有结算（会无限期挂起）'] }),
  })
  assert.equal(r.state, SELFCHECK_STATES.incompatible)
  assert.equal(r.checks[5].ok, false)
  assert.match(r.reasons.join('\n'), /^enforcement-availability: /m)
  assert.match(r.reasons.join('\n'), /无限期挂起/)
})

test('自检：任一不过 → incompatible 且**禁止自动执行**', async () => {
  const r = await startupSelfCheck({
    composition: GOOD_COMPOSITION,
    sandbox: { confine: () => ({ argv: ['w'], enforcement: 'partial', denialSignatures: ['d'], runnerFailureRules: [] }) },
    runtime: GOOD_RUNTIME,
  })
  assert.equal(r.state, SELFCHECK_STATES.incompatible)
  assert.equal(r.autoExecutionForbidden, true)
})

test('自检：**未探测**运行时 → 不通过（「没探测」不等于「没问题」）', async () => {
  const r = await startupSelfCheck({ composition: GOOD_COMPOSITION, sandbox: goodSandbox() })
  assert.equal(r.state, SELFCHECK_STATES.incompatible)
  assert.match(r.reasons.join('\n'), /未提供运行时探测结果/)
})

test('自检：理由逐项可归因（修版本 / 修补丁层 / 修沙箱是三个不同的动作）', async () => {
  const r = await startupSelfCheck({
    composition: { rows: [], permissionPresets: [] },
    sandbox: {},
    runtime: { ok: false, reason: '主版本不符' },
  })
  assert.equal(r.state, SELFCHECK_STATES.incompatible)
  // 每条理由都带检查项名前缀
  for (const reason of r.reasons) {
    assert.match(reason, /^(composition-patch-layer|runtime-probe|sandbox-enforcement|enforcement-mapping|guard-approval-consistency|enforcement-availability): /)
  }
  assert.match(r.reasons.join('\n'), /主版本不符/)
  assert.equal(r.checks.length, 6)
})

test('自检：回报补丁层版本与沙箱结论（便于与 dshVersion 成对记录）', async () => {
  const r = await startupSelfCheck({ composition: GOOD_COMPOSITION, sandbox: goodSandbox(), runtime: GOOD_RUNTIME })
  assert.equal(r.patchVersion, DSH_COMPOSITION_PATCH_VERSION)
  assert.equal(r.sandbox.enforcement, 'full')
})


// ---------------------------------------------------------------------------
// ⑯～⑲ §13.1 **W-3**：host 平面**冻结的边界**（2026-09-24）
//
//   上面那条"渲染新鲜度"（L451）只保证 **YAML == 声明**。也就是说：
//   往 `PATCH_LAYER_ROWS` 加一行、重新生成 YAML，**一切都会是绿的**。
//   而 §5 第 3 条的裁决是「**Legion host-plane 冻结** —— 不再新增 host 插件」。
//
//   > 一个"加一行、重生成、全绿"的补丁层，
//   > 与一个"host 平面已经冻结"的补丁层，在 CI 上是同一个绿——
//   > 只不过前者的"冻结"只活在某段散文里。
//
//   所以冻结要有**一份显式清单**：`host-plane.manifest.json`。
//   它是唯一一个"要加 host 行就必须动它"的地方 —— 于是那次新增在 diff 里
//   **看得见**，而不是混在"重新生成 YAML"的那一行里。
// ---------------------------------------------------------------------------

function readHostPlaneManifest() {
  const p = join(HERE, 'host-plane.manifest.json')
  assert.ok(existsSync(p), `host 平面冻结清单不存在：${p}`)
  return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
}

test('⑯ ★★★ host 平面冻结：清单与声明**逐字同序**（新增一行而没动清单 ⇒ 红）', () => {
  const m = readHostPlaneManifest()
  assert.equal(m.version, 'legion/host-plane-manifest@1')
  assert.deepEqual(m.rows, PATCH_LAYER_ROWS.map((r) => r.id),
    'host 平面的行集合变了，而 `host-plane.manifest.json` 没跟着改。'
    + '★ 这正是 §5 第 3 条要拦住的那一步：「host-plane 冻结 —— 不再新增 host 插件，新能力走补丁层 / preset」。'
    + '如果你确实是在做一次**有意的解冻**，把新行写进那份清单（那一步在 diff 里看得见），'
    + '并同时更新 §5 第 3 条的读数。')
})

test('⑰ ★★ 边界的**形状**：清单里每个 id 都在 `legion-enforcement-` 命名空间内、不重复、非空', () => {
  const m = readHostPlaneManifest()
  assert.ok(Array.isArray(m.rows) && m.rows.length > 0, '清单的 rows 必须是非空数组')
  assert.equal(new Set(m.rows).size, m.rows.length, '清单里有重复 id')
  for (const id of m.rows) {
    assert.equal(typeof id, 'string', `清单里有非字符串 id：${JSON.stringify(id)}`)
    assert.notEqual(id.trim(), '')
    assert.ok(id.startsWith(LEGION_ROW_PREFIX),
      `${id} 不在 ${LEGION_ROW_PREFIX} 命名空间里 —— host 平面的**命名边界**就在这里`)
  }
})

test('⑱ ★★ 清单里**不许**落盘推导值（runtime-only / 进 YAML 的那几行都是算出来的）', () => {
  const m = readHostPlaneManifest()
  assert.deepEqual(Object.keys(m).filter((k) => !['version', 'frozenAt', 'why', 'rows'].includes(k)), [],
    '清单里出现了别的键 —— 若是 runtimeOnly / renderedInYaml 这类**推导**值，它们会在'
    + '补丁层改动的当天变成假话（与 `registry.mjs` 删掉 `risk` 是同一条纪律：推导值不落盘）')
  const runtimeOnly = PATCH_LAYER_ROWS.filter((r) => isRuntimeOnlyRow(r)).map((r) => r.id)
  assert.deepEqual(runtimeOnly, [...RUNTIME_ONLY_ROW_IDS])
  assert.deepEqual(runtimeOnly, [
    'legion-enforcement-pre-execute', 'legion-enforcement-approval-answerer',
  ], '★ 这两行是"只能进程内挂载"的：它们不进 YAML —— 改了这个名单等于改了部署形状')
})

test('⑲ ★★ YAML 里的行**恰好**是声明里可渲染的那些，且都在冻结清单之内', () => {
  const m = readHostPlaneManifest()
  const rep = renderPatchReport()
  const declared = PATCH_LAYER_ROWS.map((r) => r.id)
  assert.deepEqual(declared.filter((id) => !rep.renderedRowIds.includes(id)), [...RUNTIME_ONLY_ROW_IDS],
    '声明了却没渲染进 YAML 的行，必须**恰好**是那两个 runtime-only 的行')
  for (const id of rep.renderedRowIds) {
    assert.ok(m.rows.includes(id), `${id} 被渲染进了 YAML，却不在冻结清单里`)
  }
})


// ---------------------------------------------------------------------------
// ⑳ §5 第 4 条**口径**（W-4，2026-09-24）：win32 `sandbox-enforcement` 的「完整 vs 部分」
//
//   ★ 口径**不是**"自检通过或不通过"，而是**八条拒绝理由的闭集**（分四组）：
//
//     · 服务面（沙箱在不在、肯不肯给管制）：①未挂载 ②confine 抛出（fail closed）③返回非对象
//     · 管制强度：④未报告 enforcement ⑤enforcement 不是 `full`（`partial`）
//     · 包装证据：⑥未返回 argv 数组 ⑦原样返回输入 argv
//     · 拒绝可识别：⑧denialSignatures 为空
//
//   ★ 这一版**订正了我自己第一版的错**：我第一版按"四项"写这条判据
//     （服务 / full / 包装 / 拒绝签名），而**闭集断言当场抓出另外四条** ——
//     我读代码时把"几个 if"记成了四项，实际有八条 `reasons.push`。
//     这正是闭集断言存在的理由：一个"把当时读到的几条写成用例"的口径，
//     与一个"口径是闭的"的口径，在前者的读数上是同一个绿。
//
//   ★ 逐项归因：八个反例**每一个**都必须只报一条理由（两项一起报就说明耦合了，
//     而耦合之后"到底哪里坏了"就没有答案）。
// ---------------------------------------------------------------------------

test('⑳ ★★★ §5 第 4 条口径：八条拒绝理由**逐条可达**、只报一条，且口径是**闭集**', async () => {
  const good = { confine: (a) => ({ argv: ['wrap', ...a], enforcement: 'full', denialSignatures: ['denied'] }) }
  const ok = await probeSandbox(good)
  assert.equal(ok.effective, true, `全部满足时应当生效，实得：${ok.reasons.join('；')}`)
  assert.deepEqual([...ok.reasons], [])
  assert.equal(ok.enforcement, 'full')

  const breakers = [
    ['①沙箱服务没挂上', {}, /未挂载沙箱服务/],
    ['②confine 抛出（fail closed）', { confine: () => { throw new Error('probe-denied') } }, /拒绝为探针提供管制/],
    ['③confine 返回非对象', { confine: () => null }, /未返回对象/],
    ['④未报告 enforcement', { confine: (a) => ({ argv: ['w', ...a], denialSignatures: ['d'] }) }, /未报告 enforcement/],
    ['⑤enforcement 不是 full（partial）', { confine: (a) => ({ argv: ['w', ...a], enforcement: 'partial', denialSignatures: ['d'] }) }, /partial/],
    ['⑥未返回管制后的 argv 数组', { confine: () => ({ enforcement: 'full', denialSignatures: ['d'] }) }, /未返回管制后的 argv/],
    ['⑦argv 原样返回（没做包装）', { confine: (a) => ({ argv: [...a], enforcement: 'full', denialSignatures: ['d'] }) }, /原样返回/],
    ['⑧denialSignatures 为空', { confine: (a) => ({ argv: ['w', ...a], enforcement: 'full', denialSignatures: [] }) }, /denialSignatures/],
  ]
  assert.equal(breakers.length, 8,
    '口径就是这八条 —— 要加第九条，先改 §5 第 4 条的口径表（§5.29）')

  const observed = [ok.reasons.join('')]
  for (const [name, port, re] of breakers) {
    const r = await probeSandbox(port)
    assert.equal(r.effective, false, `${name} ⇒ 必须判不生效`)
    assert.equal(r.reasons.length, 1,
      `${name} ⇒ 理由应当**只**有一条（逐项归因）：${JSON.stringify(r.reasons)}`)
    assert.match(r.reasons[0], re, `${name} ⇒ 理由指向了别处：${r.reasons[0]}`)
    observed.push(r.reasons.join(''))
  }

  // ★ 闭集：源码里每一条拒绝理由的首段字面量，都必须被上面九种情形真的触发过。
  //   **两种写法都要覆盖**：`reasons.push(...)` 与早退分支里的 `reasons: [...]` ——
  //   只盯前一种时，我这个判据自己会把三条早退理由当成"不存在"（第一版就栽在这里：5 ≠ 8）。
  const src = readFileSync(join(HERE, 'selfcheck.mjs'), 'utf8')
  //   ★ 只看 `probeSandbox` 体内：`startupSelfCheck` 也有 `reasons:`，混进来就会虚高。
  const body = src.slice(src.indexOf('export async function probeSandbox'),
    src.indexOf('export async function startupSelfCheck'))
  assert.ok(body.length > 0, '取不到 probeSandbox 的函数体')
  const heads = (re) => [...body.matchAll(re)].map((m) => m[1].replace(/\\+$/, '').split('${')[0])
  const pushed = [
    ...heads(/reasons\.push\(\s*\n?\s*['`]([^'`]{4,40})/g),
    ...heads(/reasons:\s*\[\s*\n?\s*['`]([^'`]{4,40})/g),
  ]
  assert.equal(pushed.length, 8,
    `selfcheck.mjs 里有 ${pushed.length} 条 reasons.push，而口径表是八条 —— `
    + '多一条少一条都要先改 §5 第 4 条的口径表（§5.29）并同时改这条判据')
  for (const head of pushed) {
    assert.ok(observed.some((o) => o.includes(head)),
      `selfcheck.mjs 里那条「${head}…」没有被任何一种反例触发过 —— `
      + '要么它是第九条判据，要么它已经死掉了')
  }
})
