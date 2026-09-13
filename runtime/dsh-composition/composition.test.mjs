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
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DSH_COMPOSITION_PATCH_VERSION,
  DSH_DEFAULT_PRESETS,
  EMPLOYEE_PRESET_CONTRACT,
  LEGION_PERMISSION_PRESETS,
  LEGION_ROW_PREFIX,
  PATCH_LAYER_ROWS,
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

/** 一份「一切正常」的组合树观察。 */
const GOOD_COMPOSITION = Object.freeze({
  rows: PATCH_LAYER_ROWS.map((r) => ({ id: r.id, activated: true })),
  permissionPresets: Object.keys(LEGION_PERMISSION_PRESETS),
})

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

test('对账：preset 行在、但生效表里**没有** Legion 项 → 不生效（patch-over 未生效）', () => {
  // 这是最隐蔽的一种：行存在、激活，看起来一切正常，但实际还在用 DSH 默认表。
  const r = reconcilePatchLayer({ rows: GOOD_COMPOSITION.rows, permissionPresets: Object.keys(DSH_DEFAULT_PRESETS) })
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
  for (const id of renderPatchReport().renderedRowIds) assert.match(text, new RegExp(id))

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

  // complete 必须与 unbuildable 一致，且**当前**应为 false（三个模块还没有）
  assert.equal(report.complete, report.unbuildable.length === 0)
  assert.equal(report.complete, false,
    '★ 三个 enforcement 模块尚不存在，这一层现在**必须是**不完整的；' +
    '如果这条红了，说明你补上了模块——那很好，请把这条断言连同 PRT-214 的状态一起改掉')

  // 而且缺的正是那三个 enforcement 行
  assert.deepEqual(
    report.unbuildable.map((u) => u.id).sort(),
    ['legion-enforcement-approval-answerer', 'legion-enforcement-hard-floor', 'legion-enforcement-pre-execute'],
  )
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
