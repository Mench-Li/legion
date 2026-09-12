// runtime/packs/builtin/software-delivery.test.mjs
// ============================================================================
// PRT-1006 的判据：**软件交付团队**作为首个内置能力包。
//
// spec §6.13 line 572：
//   「软件交付团队作为内置首包验证协议；跨境电商团队在商业 Alpha 底座通过后接入。」
//
// 这个文件存在的理由与那个包本身一样：阶段 10 的六个任务里，五个是判据与机制，
// 只有这一个是"真的有东西在用它们"。
//
//   > 一个「所有判据都有用例、而没有任何一个真实包通过它们」的协议，
//   > 与一个「判据只在夹具上成立」的协议，是同一个东西——
//   > 只不过前者在报表上每一项都是绿的。
//
// 所以这里钉住的是**整条链路真的走通过**：预检 → 记录安装 → 启用 → 编译计划
// → 建目标 → 升级，并且升级之后运行中的目标**没有动**。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LEGION_PERMISSION_PRESETS } from '../../dsh-composition/patch-layer.mjs'
import { assertPackAuthority, hostEnforcementSurface, preflightPack, scanForEnforcementBypass, scanForSecrets } from '../authority.mjs'
import {
  COMPILED_TEAM_PLAN_VERSION,
  assertPlanImmutable,
  compileTeamPlan,
  planIdOf,
} from '../compiled-plan.mjs'
import { PACK_TYPES, contentHashOfEntries, normalizePackManifest, normalizePayload, readPackTeam } from '../manifest.mjs'
import { PACK_RECORD_KINDS } from '../store.mjs'
import {
  SOFTWARE_DELIVERY_BUILTIN_IDS,
  SOFTWARE_DELIVERY_CHECKED,
  SOFTWARE_DELIVERY_FLOW,
  SOFTWARE_DELIVERY_GRANT,
  SOFTWARE_DELIVERY_HOST,
  SOFTWARE_DELIVERY_PACK,
  SOFTWARE_DELIVERY_PACK_ID,
  SOFTWARE_DELIVERY_PACK_NEXT,
  SOFTWARE_DELIVERY_PLAN,
  SOFTWARE_DELIVERY_PLAN_NEXT,
  SOFTWARE_DELIVERY_SURFACE,
  SOFTWARE_DELIVERY_UPGRADE_VERDICT,
  SOFTWARE_DELIVERY_VERDICT,
  assertSoftwareDeliverySemantics,
  buildSoftwareDeliveryPack,
} from './software-delivery.mjs'

const codeOf = (fn) => {
  try {
    fn()
    return null
  } catch (err) {
    return err?.code ?? 'threw-without-code'
  }
}

// --------------------------------------------------------------- 装载自检

test('⑩ ★ 内置包在装载时就通过了预检（否则产品根本不该启动）', () => {
  // 与其余模块的自检不同，这里**抛**而不是留值：内置包是产品的一部分，
  // 它编译不出来就是产品坏了，不是"一条判据没通过"。
  assert.deepEqual(SOFTWARE_DELIVERY_CHECKED.problems, [])
  assert.equal(SOFTWARE_DELIVERY_VERDICT.ok, true, JSON.stringify(SOFTWARE_DELIVERY_VERDICT.problems.map((p) => p.code)))
  assert.equal(SOFTWARE_DELIVERY_UPGRADE_VERDICT.ok, true)
  assert.equal(SOFTWARE_DELIVERY_CHECKED.installedVersion, '1.0.0')
  assert.equal(SOFTWARE_DELIVERY_CHECKED.trust, 'builtin')
})

test('⑩ ★ 反向探针：把宿主基线**收窄一项**，同一个包立刻被拒', () => {
  // 正确实现下 `problems` 恒为空，所以"拒绝那一段"在真实输入上永远不触发：
  //
  //   > 一段永远不会触发的拒绝，与一段不存在的拒绝，
  //   > 在「它到底拦不拦得住」上是同一个东西。
  const s = SOFTWARE_DELIVERY_CHECKED.samples
  assert.equal(s.narrowVerdictCode, 'pack-authority-capability-widens-host')
  assert.equal(s.narrowVerdictCreatedNothing, true)
})

test('⑩ 自检可注入：换一份宿主基线必须得到不同的结论', () => {
  const pack = buildSoftwareDeliveryPack({ version: '1.0.0' })
  const narrow = hostEnforcementSurface({
    preset: 'legion-attended',
    patchVersion: SOFTWARE_DELIVERY_HOST.dshCompositionPatchVersion,
    grant: {
      allowedCapabilities: SOFTWARE_DELIVERY_GRANT.allowedCapabilities.filter((c) => c !== 'file:write'),
      allowedTools: SOFTWARE_DELIVERY_GRANT.allowedTools,
      maxRisk: SOFTWARE_DELIVERY_GRANT.maxRisk,
      workspaceRoot: SOFTWARE_DELIVERY_GRANT.workspaceRoot,
    },
  })
  const r = assertSoftwareDeliverySemantics({ pack, hostSurface: narrow })
  assert.equal(r.problems.length > 0, true, '收窄基线后自检没有报出问题')

  // 阳性对照：默认参数下必须没有未解决的问题
  assert.deepEqual(assertSoftwareDeliverySemantics().problems, [])
})

// --------------------------------------------------------------- ① 身份

test('① ★ 内置身份来自**宿主登记表**，不是包自己声明的', () => {
  const s = SOFTWARE_DELIVERY_CHECKED.samples
  assert.equal(s.trust, 'builtin')
  assert.equal(s.trustWithoutRegistry, 'unsigned', '"内置"不是宿主说的')
  assert.equal(SOFTWARE_DELIVERY_PACK.manifest.provenance, null, '内置包不该带一个自报的签名者')
  assert.deepEqual(SOFTWARE_DELIVERY_BUILTIN_IDS, [SOFTWARE_DELIVERY_PACK_ID])
})

test('① 包的基本形状：id / 类型 / 版本 / 协议版本', () => {
  const m = normalizePackManifest(SOFTWARE_DELIVERY_PACK.manifest)
  assert.equal(m.packId, SOFTWARE_DELIVERY_PACK_ID)
  assert.equal(SOFTWARE_DELIVERY_PACK_ID, 'legion.software-delivery')
  assert.equal(m.packType, 'team')
  assert.ok(PACK_TYPES.includes(m.packType))
  assert.equal(m.version, '1.0.0')
  assert.equal(m.packProtocolVersion, SOFTWARE_DELIVERY_HOST.packProtocolVersion)
  assert.equal(SOFTWARE_DELIVERY_PACK_NEXT.manifest.version, '1.1.0')
  assert.notEqual(
    SOFTWARE_DELIVERY_PACK.manifest.contentHash,
    SOFTWARE_DELIVERY_PACK_NEXT.manifest.contentHash,
    '两个版本的哈希相同——升级会以 UPGRADE_NO_CHANGE 被拒，那样"版本固定"就没法被检验',
  )
})

// --------------------------------------------------------------- ② 团队

test('② 五个岗位：权限**按岗位收窄**，不是所有人都拿团队最大值', () => {
  const plan = SOFTWARE_DELIVERY_PLAN
  assert.deepEqual(plan.employees.map((e) => e.role), ['planner', 'architect', 'implementer', 'verifier', 'reviewer'])
  const byRole = Object.fromEntries(plan.employees.map((e) => [e.role, e]))

  // 只读岗位：不能写、不能跑命令
  for (const role of ['planner', 'architect', 'reviewer']) {
    assert.deepEqual(byRole[role].allowedCapabilities, ['file:read', 'repo:read'], `${role} 拿到了超出只读的权限`)
    assert.equal(byRole[role].allowedTools.includes('write-file'), false)
    assert.equal(byRole[role].allowedTools.includes('run-command'), false)
  }
  // 实现岗位：能改仓库，但**不能**跑命令、不能推
  assert.deepEqual(byRole.implementer.allowedCapabilities, ['file:read', 'file:write', 'repo:read', 'repo:write'])
  assert.equal(byRole.implementer.allowedCapabilities.includes('command:exec'), false)
  assert.equal(byRole.implementer.allowedCapabilities.includes('repo:push'), false)
  // 验证岗位：能跑命令，但**不能**改仓库
  assert.equal(byRole.verifier.allowedCapabilities.includes('command:exec'), true)
  assert.equal(byRole.verifier.allowedCapabilities.includes('file:write'), false)
  assert.equal(byRole.verifier.allowedCapabilities.includes('repo:write'), false)

  // 所有岗位的权限并起来恰好等于包声明的那一份（不多不少）
  const all = [...new Set(plan.employees.flatMap((e) => e.allowedCapabilities))].sort()
  assert.deepEqual(all, [...SOFTWARE_DELIVERY_PACK.manifest.requestedPermissions.capabilities].sort())
})

test('② 一条五段流水线，逐段交接，最后一段没有下游', () => {
  assert.deepEqual(
    SOFTWARE_DELIVERY_PLAN.pipeline.map((s) => `${s.stage}:${s.role}->${s.handoffTo ?? 'null'}`),
    [
      'plan:planner->architect',
      'design:architect->implementer',
      'implement:implementer->verifier',
      'verify:verifier->reviewer',
      'review:reviewer->null',
    ],
  )
})

test('② 数据依赖逐条声明，且种类都是 §6.5 认得的来源类型', () => {
  assert.deepEqual(SOFTWARE_DELIVERY_CHECKED.samples.dataDependencyKinds, [
    'workspace-state', 'goal-context', 'upstream-delivery', 'artifact',
  ])
  const verdict = preflightPack({
    manifest: SOFTWARE_DELIVERY_PACK.manifest,
    files: SOFTWARE_DELIVERY_PACK.files,
    host: SOFTWARE_DELIVERY_HOST,
    hostSurface: SOFTWARE_DELIVERY_SURFACE,
    builtinPackIds: SOFTWARE_DELIVERY_BUILTIN_IDS,
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.computed.dataDependencies.length, 4)
})

test('② 包内容里确实有提示段 / 规则 / 样例（不是一个空壳 team-plan.json）', () => {
  const paths = SOFTWARE_DELIVERY_PACK.files.map((f) => f.path).sort()
  assert.deepEqual(paths, [
    'docs/CHANGELOG.md',
    'docs/README.md',
    'prompts/architect.md',
    'prompts/implementer.md',
    'prompts/planner.md',
    'prompts/reviewer.md',
    'prompts/verifier.md',
    'rules/acceptance.md',
    'schema/task.json',
    'team/team-plan.json',
    'tests/samples.json',
  ])
  assert.equal(SOFTWARE_DELIVERY_CHECKED.fileCount, 11)
  const team = readPackTeam({
    manifest: normalizePackManifest(SOFTWARE_DELIVERY_PACK.manifest),
    files: SOFTWARE_DELIVERY_PACK.files,
  })
  assert.equal(team.employees.length, 5)
  assert.equal(team.pipeline.length, 5)
})

// --------------------------------------------------------------- ③ 权限方向

test('③ ★ 包 ⊆ 宿主：宿主收窄任一项，内置包也必须被拒', () => {
  const pack = SOFTWARE_DELIVERY_PACK
  const cases = [
    ['少一个能力', { allowedCapabilities: SOFTWARE_DELIVERY_GRANT.allowedCapabilities.filter((c) => c !== 'repo:write') }],
    ['少一个工具', { allowedTools: SOFTWARE_DELIVERY_GRANT.allowedTools.filter((t) => t !== 'git-commit') }],
    ['风险上限压低', { maxRisk: 'low' }],
    ['工作目录换到别处', { workspaceRoot: 'C:/other' }],
  ]
  for (const [name, patch] of cases) {
    const surface = hostEnforcementSurface({
      preset: 'legion-attended',
      patchVersion: SOFTWARE_DELIVERY_HOST.dshCompositionPatchVersion,
      grant: { ...SOFTWARE_DELIVERY_GRANT, ...patch },
    })
    const verdict = preflightPack({
      manifest: pack.manifest, files: pack.files, host: SOFTWARE_DELIVERY_HOST,
      hostSurface: surface, builtinPackIds: SOFTWARE_DELIVERY_BUILTIN_IDS,
    })
    assert.equal(verdict.ok, false, `${name} 时内置包仍然通过了`)
  }
})

test('③ 内置包用的强制面是 Legion 自有的有人值守档，不是 DSH 默认表', () => {
  assert.equal(SOFTWARE_DELIVERY_SURFACE.preset, 'legion-attended')
  const preset = LEGION_PERMISSION_PRESETS['legion-attended']
  assert.equal(SOFTWARE_DELIVERY_SURFACE.sandbox, preset.sandbox)
  assert.equal(SOFTWARE_DELIVERY_SURFACE.approval, preset.approval)
  assert.equal(SOFTWARE_DELIVERY_CHECKED.surfaceSandbox, 'workspace-write')
  assert.equal(SOFTWARE_DELIVERY_CHECKED.surfaceApproval, 'ask')
})

// --------------------------------------------------------------- ④ 密钥与强制面

test('④ ★ 内置包不带凭据——这是**扫出来的读数**，不是作者说没有', () => {
  assert.equal(SOFTWARE_DELIVERY_PACK.manifest.containsSecrets, false)
  assert.equal(SOFTWARE_DELIVERY_CHECKED.samples.secretHits, 0)
  assert.deepEqual(scanForSecrets({ files: SOFTWARE_DELIVERY_PACK.files }), [])
  // 反向探针：往这份载荷里塞一个凭据，扫描必须立刻响
  const poisoned = [...SOFTWARE_DELIVERY_PACK.files, { path: 'x.json', text: '{"apiKey": "hunter2swordfish"}' }]
  assert.equal(scanForSecrets({ files: poisoned }).length, 1, '往内置包里塞凭据竟然扫不出来')
})

test('④ ★ 内置包不绕越强制面（提示段里提到"留引用"不是绕越）', () => {
  assert.equal(SOFTWARE_DELIVERY_CHECKED.samples.bypassHits, 0)
  assert.deepEqual(scanForEnforcementBypass({ files: SOFTWARE_DELIVERY_PACK.files }), [])
  // 反向探针：塞一份策略文件，扫描必须立刻响
  const poisoned = [...SOFTWARE_DELIVERY_PACK.files, { path: 'x.json', text: '{"approvalPolicy": "never"}' }]
  assert.ok(scanForEnforcementBypass({ files: poisoned }).length > 0)
})

test('④ 提示段里那句"不要提交凭据"是**散文**，不是一份策略配置', () => {
  const impl = SOFTWARE_DELIVERY_PACK.files.find((f) => f.path === 'prompts/implementer.md')
  assert.match(impl.text, /不要提交凭据/)
  assert.deepEqual(scanForSecrets({ files: [impl] }), [])
  assert.deepEqual(scanForEnforcementBypass({ files: [impl] }), [])
})

// --------------------------------------------------------------- ⑤ 计划

test('⑤ 编译出的计划是不可变的，且冻结路径是算出来的', () => {
  const r = assertPlanImmutable({ plan: SOFTWARE_DELIVERY_PLAN })
  assert.deepEqual(r.mutablePaths, [])
  assert.ok(r.frozenPathCount > 40, `冻结路径只有 ${r.frozenPathCount} 条`)
  assert.equal(SOFTWARE_DELIVERY_PLAN.planVersion, COMPILED_TEAM_PLAN_VERSION)
  assert.equal(SOFTWARE_DELIVERY_CHECKED.samples.planFrozenPathCount, r.frozenPathCount)
  assert.throws(() => { SOFTWARE_DELIVERY_PLAN.employees[2].allowedCapabilities.push('repo:push') }, TypeError)
})

test('⑤ 计划绑的是内容哈希；同一个版本号换一份内容会得到另一个计划', () => {
  assert.equal(SOFTWARE_DELIVERY_PLAN.contentHash, SOFTWARE_DELIVERY_PACK.manifest.contentHash)
  assert.notEqual(SOFTWARE_DELIVERY_PLAN.planHash, SOFTWARE_DELIVERY_PLAN_NEXT.planHash)
  assert.equal(planIdOf(SOFTWARE_DELIVERY_PLAN), 'legion.software-delivery@1.0.0')
  assert.equal(SOFTWARE_DELIVERY_CHECKED.planId, planIdOf(SOFTWARE_DELIVERY_PLAN))
  // 逐字节重编必须得到同一个计划（否则"同一个包"会有两个哈希）
  const again = compileTeamPlan({
    manifest: SOFTWARE_DELIVERY_PACK.manifest, files: SOFTWARE_DELIVERY_PACK.files, compiledAtMs: 0,
  })
  assert.equal(again.planHash, SOFTWARE_DELIVERY_PLAN.planHash)
})

// --------------------------------------------------------------- ⑥ 真实链路

test('⑥ ★ 真实链路走完：预检 → 安装 → 启用 → 编译 → 建目标 → 升级', () => {
  const f = SOFTWARE_DELIVERY_CHECKED.flow
  assert.equal(f.installKind, 'install')
  assert.equal(f.enableChanged, true)
  assert.deepEqual(f.recordKinds, ['install', 'enable', 'upgrade'])
  assert.ok(f.recordKinds.every((k) => PACK_RECORD_KINDS.includes(k)))
  assert.equal(f.upgradeFrom, '1.0.0')
  assert.equal(f.upgradeTo, '1.1.0')
  assert.equal(f.activeVersion, '1.1.0')
  assert.equal(f.enabled, true, '升级把启用状态弄丢了')
})

test('⑥ ★★ 更新能力包**不会**改变运行中目标（完成标准 line 1006 的后半句）', () => {
  // 两个方向都要断言：最新版**已经**是 1.1.0，而运行中的目标**仍然**报 1.0.0。
  //
  //   > 一个「升级之后运行中目标的版本没变」的断言，
  //   > 与一个「升级根本没发生」的断言，在"版本固定到底有没有生效"上是同一个东西。
  const f = SOFTWARE_DELIVERY_CHECKED.flow
  assert.equal(f.latestVersionAfterUpgrade, '1.1.0', '升级没发生——那"目标没变"证明不了任何东西')
  assert.equal(f.targetVersionAfterUpgrade, '1.0.0', '升级改变了运行中目标')
  assert.equal(f.targetStillTheSamePlan, true)

  // 直接对着注册表再查一遍（不只信自检里那个布尔）
  const registry = SOFTWARE_DELIVERY_FLOW.registry
  assert.equal(registry.latestPlanOf(SOFTWARE_DELIVERY_PACK_ID).packVersion, '1.1.0')
  assert.equal(registry.planOf('goal-1'), SOFTWARE_DELIVERY_PLAN)
  assert.equal(registry.versionOf('goal-1').packVersion, '1.0.0')
  assert.equal(registry.versionOf('goal-1').planHash, SOFTWARE_DELIVERY_PLAN.planHash)
})

test('⑥ 升级之后**新**建的目标拿到的是新版本', () => {
  // 否则"升级只影响之后创建的目标"这半句就没有证据。
  const registry = SOFTWARE_DELIVERY_FLOW.registry
  const target = registry.createTarget({ targetId: 'goal-2-after-upgrade', planId: planIdOf(SOFTWARE_DELIVERY_PLAN_NEXT) })
  assert.equal(registry.versionOf(target.targetId).packVersion, '1.1.0')
  assert.equal(registry.planOf(target.targetId), SOFTWARE_DELIVERY_PLAN_NEXT)
})

test('⑥ 升级走的是**同一条**校验链，没有"绕过校验的升级通道"', () => {
  assert.equal(SOFTWARE_DELIVERY_UPGRADE_VERDICT.ok, true)
  assert.deepEqual(SOFTWARE_DELIVERY_UPGRADE_VERDICT.problems, [])
  // 依赖预检拿到的已安装清单里必须有 1.0.0（否则那不是一次升级）
  assert.deepEqual(SOFTWARE_DELIVERY_CHECKED.upgradeVerdictCodes, [])

  // 反向探针：把 1.1.0 的内容换成一个带凭据的版本，升级预检必须拒
  const poisoned = buildSoftwareDeliveryPack({ version: '1.1.0' })
  const files = [...poisoned.files, { path: 'leak.json', text: '{"apiKey": "hunter2swordfish"}' }]
  const entries = normalizePayload(files)
  const verdict = preflightPack({
    manifest: {
      ...poisoned.manifest,
      contents: entries.map((e) => ({ path: e.path, sha256: e.sha256, chars: e.chars })),
      contentHash: contentHashOfEntries(entries),
    },
    files,
    host: SOFTWARE_DELIVERY_HOST,
    hostSurface: SOFTWARE_DELIVERY_SURFACE,
    builtinPackIds: SOFTWARE_DELIVERY_BUILTIN_IDS,
  })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.problems.some((p) => p.code === 'pack-authority-secret-in-content'), JSON.stringify(verdict.problems.map((p) => p.code)))
})

test('⑥ 升级后的那份内容也过越权检查（不是只查首包）', () => {
  const verdict = assertPackAuthority({
    manifest: SOFTWARE_DELIVERY_PACK_NEXT.manifest,
    files: SOFTWARE_DELIVERY_PACK_NEXT.files,
    hostSurface: SOFTWARE_DELIVERY_SURFACE,
    employees: null,
  })
  // 没给员工清单时越权层必须报"查不了"，而不是静默通过
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'pack-authority-employees-undeclared')
})

test('⑥ 版本 1.1.0 只有内容差异，没有权限差异（升级不是一次扩权）', () => {
  assert.deepEqual(
    SOFTWARE_DELIVERY_PACK_NEXT.manifest.requestedPermissions,
    SOFTWARE_DELIVERY_PACK.manifest.requestedPermissions,
    '1.1.0 悄悄改了权限声明',
  )
  const before = compileTeamPlan({ manifest: SOFTWARE_DELIVERY_PACK.manifest, files: SOFTWARE_DELIVERY_PACK.files, compiledAtMs: 0 })
  assert.deepEqual(
    SOFTWARE_DELIVERY_PLAN_NEXT.employees.map((e) => e.allowedCapabilities),
    before.employees.map((e) => e.allowedCapabilities),
    '1.1.0 悄悄给某个岗位扩了权',
  )
})

test('⑥ 版本号可注入，但注入不改结构（升级夹具不是手写的第二份包）', () => {
  for (const v of ['1.0.0', '1.1.0', '2.0.0']) {
    const p = buildSoftwareDeliveryPack({ version: v })
    assert.equal(p.manifest.version, v)
    assert.equal(p.files.length, SOFTWARE_DELIVERY_PACK.files.length)
    assert.equal(codeOf(() => compileTeamPlan({ manifest: p.manifest, files: p.files, compiledAtMs: 0 })), null)
  }
})
