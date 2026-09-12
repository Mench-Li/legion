// runtime/packs/compiled-plan.test.mjs
// ============================================================================
// PRT-1004 的判据：不可变 `CompiledTeamPlan` 与**运行中版本固定**。
//
// spec §6.13 line 570：
//   「解析成功后生成不可变 `CompiledTeamPlan`。运行中的目标始终使用创建时快照，
//     能力包升级只影响之后创建的目标。」
// spec §6.5 line 344：RunContextSnapshot 的第一行就是「Compiled TeamPlan 快照」——
//   也就是说这份计划会**进入**每一个运行中目标的上下文快照。
//
// 完成标准 line 1006 的那半句「更新能力包不会改变运行中目标」在这个文件里。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  COMPILED_PLAN_CHECKED,
  COMPILED_TEAM_PLAN_VERSION,
  PIPELINE_STAGE_FIELDS,
  PLAN_CODES,
  PLAN_DOMAIN,
  SAMPLE_TEAM,
  assertPlanImmutable,
  compileTeamPlan,
  computePlanHash,
  createPlanRegistry,
  mutablePathsOf,
  planIdOf,
  sampleTeamPack,
  sampleTeamPackWith,
  verifyPlan,
} from './compiled-plan.mjs'

const codeOf = (fn) => {
  try {
    fn()
    return null
  } catch (err) {
    return err?.code ?? 'threw-without-code'
  }
}

const mk = (pack = sampleTeamPack()) => compileTeamPlan({
  manifest: pack.manifest, files: pack.files, compiledAtMs: 0,
})

// --------------------------------------------------------------- 装载自检

test('⑩ ★ 装载自检没有未解决的问题；读数里带的是**路径列表**不是一个布尔', () => {
  assert.deepEqual(COMPILED_PLAN_CHECKED.problems, [])
  const s = COMPILED_PLAN_CHECKED.samples
  assert.deepEqual(s.mutablePaths, [])
  assert.ok(s.frozenPathCount > 0, '冻结路径数是 0——那份"证据"什么也没覆盖')
  // ★ 只报一个 `<root>` 等于什么都没证明：第二层必须在列表里
  assert.ok(
    s.frozenPathsHead.length > 0 && s.frozenPathsHead.every((p) => typeof p === 'string'),
    '冻结路径列表不是路径',
  )
  assert.deepEqual(s.shallowFreezeMutablePaths, ['employees', 'employees[0]', 'pipeline'])
})

// --------------------------------------------------------------- ① 深冻结

test('① ★★ 冻结是**递归**的：`Object.isFrozen(plan)` 为真证明不了任何事', () => {
  // 只冻一层时 `Object.isFrozen(plan)` 是 `true`，看起来"不可变"——
  // 而"哪个员工在被派活"在**第二层**：
  //
  //   > 一个「只冻结了最外层的 CompiledTeamPlan」的实现，
  //   > 与一个「`plan.employees.push(...)` 能成功、于是运行中的团队被改了」的实现，
  //   > 是同一个东西——只不过前者会通过 `Object.isFrozen()` 的检查。
  const plan = mk()
  assert.equal(Object.isFrozen(plan), true)
  assert.equal(Object.isFrozen(plan.employees), true, '第二层数组没冻')
  assert.equal(Object.isFrozen(plan.employees[0]), true, '第二层对象没冻')
  assert.equal(Object.isFrozen(plan.employees[0].allowedTools), true, '第三层数组没冻')
  assert.equal(Object.isFrozen(plan.pipeline[0]), true, '流水线段没冻')

  assert.throws(() => { plan.employees.push({ role: 'x' }) }, TypeError)
  assert.throws(() => { plan.employees[0].maxRisk = 'critical' }, TypeError)
  assert.throws(() => { plan.employees[0].allowedTools.push('delete-file') }, TypeError)
  assert.throws(() => { plan.pipeline[0].role = 'other' }, TypeError)
  assert.throws(() => { plan.planHash = 'sha256:00' }, TypeError)

  // 改不动：值仍然是原来那个
  assert.equal(plan.employees[0].maxRisk, SAMPLE_TEAM.employees[0].maxRisk)
})

test('① mutablePathsOf 给出的是"**还有哪里没冻住**"，不是一个计数', () => {
  // 红的时候要的是这个：一句"没冻住"不能告诉你去改哪一行。
  const shallow = Object.freeze({ employees: [{ role: 'planner' }], pipeline: Object.freeze([]) })
  assert.deepEqual(mutablePathsOf(shallow), ['employees', 'employees[0]'])
  assert.deepEqual(mutablePathsOf(mk()), [], '深冻结的计划还有可变的路径')
  assert.deepEqual(mutablePathsOf(42), [])
  assert.deepEqual(mutablePathsOf(null), [])
})

test('① ★ 浅冻结必须被拒，而且**指出是哪一条路径**', () => {
  const shallow = Object.freeze({ employees: [{ role: 'planner' }], pipeline: Object.freeze([]) })
  let err = null
  try {
    assertPlanImmutable({ plan: shallow })
  } catch (e) {
    err = e
  }
  assert.ok(err !== null, '浅冻结通过了不可变性校验')
  assert.equal(err.code, PLAN_CODES.NOT_DEEPLY_FROZEN)
  assert.match(err.message, /employees/, '拒绝理由没有指出是哪一条路径')
})

test('① `mutablePaths` 可注入，所以"拒绝那一段"能被真的走到', () => {
  //   > 一段永远不会触发的拒绝，与一段不存在的拒绝，
  //   > 在「它到底拦不拦得住」上是同一个东西。
  assert.equal(codeOf(() => assertPlanImmutable({ plan: mk(), mutablePaths: ['employees[0]'] })), PLAN_CODES.NOT_DEEPLY_FROZEN)
  assert.equal(assertPlanImmutable({ plan: mk() }).mutablePaths.length, 0)
})

test('① 冻结证据是一个**算出来的路径列表**，路径覆盖到二级字段', () => {
  const r = assertPlanImmutable({ plan: mk() })
  assert.ok(r.frozenPaths.length > 0)
  assert.equal(r.frozenPathCount, r.frozenPaths.length)
  assert.ok(
    r.frozenPaths.some((p) => /^employees[.[]0[.\]]/.test(p)),
    `路径列表没有覆盖到 employees 的第二层：${JSON.stringify(r.frozenPaths.slice(0, 10))}`,
  )
})

// --------------------------------------------------------------- ② 编译

test('② 编译需要时点：没有 compiledAtMs 就不编译', () => {
  const pack = sampleTeamPack()
  assert.equal(codeOf(() => compileTeamPlan({ manifest: pack.manifest, files: pack.files })), PLAN_CODES.TEAM_SOURCE_MISSING)
})

test('② overlay 包不能被编译成团队方案', () => {
  const pack = sampleTeamPack()
  const overlay = { ...pack.manifest, packType: 'overlay' }
  assert.equal(codeOf(() => compileTeamPlan({ manifest: overlay, files: pack.files, compiledAtMs: 0 })), PLAN_CODES.NOT_A_TEAM_PACK)
})

test('② 计划绑定的是**内容**，不只是版本号', () => {
  // 同一个版本号换一份内容，在版本比较里看不出来，而运行中目标看到的东西已经变了。
  const a = sampleTeamPack({ version: '1.0.0', note: '甲' })
  const b = sampleTeamPack({ version: '1.0.0', note: '乙' })
  const pa = mk(a)
  const pb = mk(b)
  assert.equal(pa.packVersion, pb.packVersion)
  assert.equal(planIdOf(pa), planIdOf(pb), '夹具没有做到"同版本号"')
  assert.notEqual(pa.contentHash, pb.contentHash)
  assert.notEqual(pa.planHash, pb.planHash)
})

test('② 计划里的岗位与流水线逐条来自包内容，且权限**按岗位**保留', () => {
  const plan = mk()
  assert.deepEqual(plan.employees.map((e) => e.role), ['planner', 'verifier'])
  assert.deepEqual(plan.pipeline.map((s) => `${s.stage}:${s.role}->${s.handoffTo ?? 'null'}`), ['plan:planner->verifier', 'verify:verifier->null'])
  const planner = plan.employees.find((e) => e.role === 'planner')
  const verifier = plan.employees.find((e) => e.role === 'verifier')
  assert.deepEqual(planner.allowedCapabilities, ['file:read', 'repo:read'])
  assert.deepEqual(verifier.allowedCapabilities, ['file:read', 'repo:read', 'command:exec'])
  assert.notDeepEqual(planner.allowedCapabilities, verifier.allowedCapabilities, '两个岗位拿到了同一份权限——岗位这个维度没了')
})

test('② 空团队 / 空流水线 / 未知岗位 / 交接成环 / 岗位没进流水线，各有自己的码', () => {
  const cases = [
    ['空流水线', { pipeline: [] }, PLAN_CODES.PIPELINE_EMPTY],
    ['未知岗位', { pipeline: [{ stage: 'a', role: 'nobody', handoffTo: null }] }, PLAN_CODES.UNKNOWN_ROLE],
    ['交接成环', {
      pipeline: [
        { stage: 'plan', role: 'planner', handoffTo: 'verifier' },
        { stage: 'verify', role: 'verifier', handoffTo: 'planner' },
      ],
    }, PLAN_CODES.HANDOFF_CYCLE],
    ['岗位没进流水线', { pipeline: [{ stage: 'plan', role: 'planner', handoffTo: null }] }, PLAN_CODES.ROLE_NOT_IN_PIPELINE],
  ]
  for (const [name, patch, code] of cases) {
    const broken = sampleTeamPackWith(patch)
    assert.equal(
      codeOf(() => compileTeamPlan({ manifest: broken.manifest, files: broken.files, compiledAtMs: 0 })),
      code, `${name} 没有得到 ${code}`,
    )
  }
})

test('② 交接给自己 / 流水线段字段多一个少一个 / 同一岗位两个位置，都要拒', () => {
  const cases = [
    [{ pipeline: [{ stage: 'plan', role: 'planner', handoffTo: 'planner' }, { stage: 'v', role: 'verifier', handoffTo: null }] }, PLAN_CODES.SELF_HANDOFF],
    [{ pipeline: [{ stage: 'plan', role: 'planner', handoffTo: 'verifier', extra: 1 }, { stage: 'v', role: 'verifier', handoffTo: null }] }, PLAN_CODES.BAD_STAGE],
    [{ pipeline: [{ stage: 'plan', role: 'planner' }, { stage: 'v', role: 'verifier', handoffTo: null }] }, PLAN_CODES.BAD_STAGE],
    [{ pipeline: [{ stage: 'a', role: 'planner', handoffTo: 'verifier' }, { stage: 'b', role: 'planner', handoffTo: null }, { stage: 'c', role: 'verifier', handoffTo: null }] }, PLAN_CODES.BAD_STAGE],
  ]
  for (const [patch, code] of cases) {
    const broken = sampleTeamPackWith(patch)
    assert.equal(
      codeOf(() => compileTeamPlan({ manifest: broken.manifest, files: broken.files, compiledAtMs: 0 })),
      code, `${JSON.stringify(patch)} 没有得到 ${code}`,
    )
  }
  assert.deepEqual(PIPELINE_STAGE_FIELDS, ['stage', 'role', 'handoffTo'])
})

test('② 员工重复 / 岗位重复要拒（按岗位派活时谁干活不该由顺序决定）', () => {
  const dupId = sampleTeamPackWith({
    employees: [SAMPLE_TEAM.employees[0], { ...SAMPLE_TEAM.employees[1], employeeId: SAMPLE_TEAM.employees[0].employeeId }],
  })
  assert.equal(
    codeOf(() => compileTeamPlan({ manifest: dupId.manifest, files: dupId.files, compiledAtMs: 0 })),
    PLAN_CODES.EMPLOYEE_DUPLICATE,
  )
  const dupRole = sampleTeamPackWith({
    employees: [SAMPLE_TEAM.employees[0], { ...SAMPLE_TEAM.employees[1], role: 'planner' }],
  })
  assert.equal(
    codeOf(() => compileTeamPlan({ manifest: dupRole.manifest, files: dupRole.files, compiledAtMs: 0 })),
    PLAN_CODES.EMPLOYEE_DUPLICATE,
  )
})

test('② 一个员工也没有的团队包 → 拒绝（空团队与"没有方案"在派活时是两种失败）', () => {
  const broken = sampleTeamPackWith({ employees: [], pipeline: [] })
  assert.equal(
    codeOf(() => compileTeamPlan({ manifest: broken.manifest, files: broken.files, compiledAtMs: 0 })),
    PLAN_CODES.EMPLOYEES_EMPTY,
  )
})

test('② 阳性对照：样例包必须编译得出来，且哈希稳定', () => {
  const a = mk()
  const b = mk()
  assert.equal(a.planHash, b.planHash, '同一个输入两次编译得到了不同的计划哈希')
  assert.equal(a.planVersion, COMPILED_TEAM_PLAN_VERSION)
  assert.equal(a.teamPlanPath, 'team/team-plan.json')
  assert.equal(PLAN_DOMAIN, 'legion.compiled-team-plan.v1')
})

// --------------------------------------------------------------- ③ 哈希核验

test('③ 计划哈希自洽：computePlanHash 重算等于计划里写的', () => {
  const plan = mk()
  assert.equal(computePlanHash(plan), plan.planHash)
  assert.equal(verifyPlan({ plan }).ok, true)
})

test('③ ★ 哈希对不上时给出**两边**的值，不是一句"被改过"', () => {
  const plan = mk()
  // 计划是深冻结的，所以这里用一份"看起来像计划"的普通对象来构造被改过的情形
  const tampered = { ...plan, planHash: `sha256:${'0'.repeat(64)}` }
  const v = verifyPlan({ plan: tampered })
  assert.equal(v.ok, false)
  assert.equal(v.code, PLAN_CODES.PLAN_TAMPERED)
  assert.equal(v.planHash, `sha256:${'0'.repeat(64)}`)
  assert.notEqual(v.recomputed, v.planHash)
})

test('③ ★ 哈希自洽证明不了"它对应的是那份内容"：换一份载荷必须判不一致', () => {
  const pack = sampleTeamPack()
  const plan = mk(pack)
  assert.equal(verifyPlan({ plan, files: pack.files }).ok, true)
  const other = verifyPlan({ plan, files: [{ path: 'other.txt', text: 'x' }] })
  assert.equal(other.ok, false)
  assert.equal(other.code, PLAN_CODES.PLAN_TAMPERED)
  assert.equal(other.contentHash, plan.contentHash)
  assert.notEqual(other.recomputedContentHash, plan.contentHash)
})

test('③ 计划里绑的内容哈希等于那份包 manifest 声明的哈希', () => {
  const pack = sampleTeamPack()
  const plan = mk(pack)
  assert.equal(plan.contentHash, pack.manifest.contentHash)
})

// --------------------------------------------------------------- ④ 版本固定

test('④ ★★ 升级**真的发生了**，而运行中的目标**没有动**', () => {
  //   > 一个「升级之后运行中目标的版本没变」的断言，
  //   > 与一个「升级根本没发生」的断言，在"版本固定到底有没有生效"上是同一个东西。
  //
  // 所以两个方向都必须断言：最新版**已经**变了，目标**仍然**是旧的。
  const registry = createPlanRegistry({ now: () => 0 })
  const v1 = registry.compileAndPublish({ ...sampleTeamPack({ version: '1.0.0', note: '甲' }), compiledAtMs: 0 })
  const target = registry.createTarget({ targetId: 'goal-1', planId: planIdOf(v1) })
  const v2 = registry.compileAndPublish({ ...sampleTeamPack({ version: '2.0.0', note: '乙' }), compiledAtMs: 0 })

  assert.equal(registry.latestPlanOf(v1.packId).packVersion, '2.0.0', '最新版没变——那"目标没变"这条断言证明不了任何东西')
  assert.equal(registry.latestPlanOf(v1.packId), v2)
  assert.equal(registry.versionOf(target.targetId).packVersion, '1.0.0', '升级改变了运行中目标')
  assert.equal(registry.planOf(target.targetId), v1, '运行中目标拿到了新计划')
  assert.equal(registry.planOf(target.targetId).packVersion, '1.0.0')
})

test('④ ★ 已经建出来的目标**不许重绑**（重绑与"升级即改运行中目标"是同一个东西）', () => {
  const registry = createPlanRegistry({ now: () => 0 })
  const v1 = registry.compileAndPublish({ ...sampleTeamPack({ version: '1.0.0', note: '甲' }), compiledAtMs: 0 })
  registry.createTarget({ targetId: 'goal-1', planId: planIdOf(v1) })
  const v2 = registry.compileAndPublish({ ...sampleTeamPack({ version: '2.0.0', note: '乙' }), compiledAtMs: 0 })
  assert.equal(
    codeOf(() => registry.createTarget({ targetId: 'goal-1', planId: planIdOf(v2) })),
    PLAN_CODES.TARGET_EXISTS,
  )
  assert.equal(registry.planOf('goal-1').packVersion, '1.0.0')
  assert.equal(registry.targetCount(), 1)
})

test('④ ★ 计划查不到时**不回落**到最新版', () => {
  //   > 一个「目标找不到自己的计划就回落到最新版」的查询，
  //   > 与一个「在升级的那一刻，所有运行中的目标一起换了计划」的查询，
  //   > 是同一个东西——只不过前者只在"计划被清理过"的时候发生。
  const registry = createPlanRegistry({ now: () => 0 })
  const v1 = registry.compileAndPublish({ ...sampleTeamPack({ version: '1.0.0', note: '甲' }), compiledAtMs: 0 })
  const target = registry.createTarget({ targetId: 'goal-1', planId: planIdOf(v1) })
  assert.equal(registry.planOf(target.targetId).packVersion, '1.0.0')
  assert.equal(registry.latestPlanOf(v1.packId).packVersion, '1.0.0')
  // 同一个版本号发布了**另一份内容** → 这是一个会改变"1.0.0 是什么"的发布，拒绝
  assert.equal(
    codeOf(() => registry.compileAndPublish({ ...sampleTeamPack({ version: '1.0.0', note: '改过' }), compiledAtMs: 0 })),
    PLAN_CODES.PLAN_TAMPERED,
  )
  // 运行中的目标仍然指着原来那一份
  assert.equal(registry.planOf(target.targetId), v1)
})

test('④ 同一个包可以有很多目标，各自钉在自己创建时的版本上', () => {
  const registry = createPlanRegistry({ now: () => 0 })
  const v1 = registry.compileAndPublish({ ...sampleTeamPack({ version: '1.0.0', note: '甲' }), compiledAtMs: 0 })
  const t1 = registry.createTarget({ targetId: 'goal-1', planId: planIdOf(v1) })
  const v2 = registry.compileAndPublish({ ...sampleTeamPack({ version: '2.0.0', note: '乙' }), compiledAtMs: 0 })
  const t2 = registry.createTarget({ targetId: 'goal-2', planId: planIdOf(v2) })

  assert.equal(registry.versionOf(t1.targetId).packVersion, '1.0.0')
  assert.equal(registry.versionOf(t2.targetId).packVersion, '2.0.0')
  assert.notEqual(registry.planOf(t1.targetId), registry.planOf(t2.targetId))
  assert.deepEqual(registry.targetsOf(v1.packId), ['goal-1', 'goal-2'])
  assert.deepEqual(registry.publishedPlanIds(), ['legion.sample-team@1.0.0', 'legion.sample-team@2.0.0'])
})

test('④ 建目标要指名一个**存在**的计划，且 targetId 非空', () => {
  const registry = createPlanRegistry({ now: () => 0 })
  const v1 = registry.compileAndPublish({ ...sampleTeamPack({ version: '1.0.0', note: '甲' }), compiledAtMs: 0 })
  assert.equal(codeOf(() => registry.createTarget({ targetId: '', planId: planIdOf(v1) })), PLAN_CODES.TARGET_UNKNOWN)
  assert.equal(codeOf(() => registry.createTarget({ targetId: 'g', planId: 'nope@1.0.0' })), PLAN_CODES.PLAN_UNKNOWN)
  assert.equal(codeOf(() => registry.planOf('ghost')), PLAN_CODES.TARGET_UNKNOWN)
  assert.equal(codeOf(() => registry.latestPlanOf('ghost')), PLAN_CODES.PLAN_UNKNOWN)
})

test('④ ★ 目标的版本三元组是**钉住那一刻**的读数，不是查询那一刻的', () => {
  const registry = createPlanRegistry({ now: (() => { let t = 100; return () => (t += 5) })() })
  const v1 = registry.compileAndPublish({ ...sampleTeamPack({ version: '1.0.0', note: '甲' }), compiledAtMs: 0 })
  const target = registry.createTarget({ targetId: 'goal-1', planId: planIdOf(v1) })
  assert.equal(target.pinnedAtMs, 105)
  assert.equal(target.planHash, v1.planHash)
  assert.equal(target.contentHash, v1.contentHash)

  registry.compileAndPublish({ ...sampleTeamPack({ version: '2.0.0', note: '乙' }), compiledAtMs: 0 })
  const after = registry.versionOf(target.targetId)
  assert.equal(after.planHash, v1.planHash, '目标自报的计划哈希变了')
  assert.equal(after.planId, planIdOf(v1))
})

test('④ 装载自检里的那一对版本读数就是这条判据的留证', () => {
  const u = COMPILED_PLAN_CHECKED.samples.upgrade
  assert.equal(u.latestAfterUpgrade, '2.0.0')
  assert.equal(u.targetVersionAfterUpgrade, '1.0.0')
  assert.equal(u.targetStillSamePlan, true)
  assert.equal(u.latestIsTheNewPlan, true)
  assert.equal(u.rebindCode, PLAN_CODES.TARGET_EXISTS)
})
