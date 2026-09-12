// runtime/dsh-composition/enforcement-mapping.test.mjs — PRT-612 固定映射
//
// 判据：Legion 权限语义 → DSH 强制面的映射是**固定的**。
// "固定"在这里有确切含义：给定同一个模式与同一份现场，它落到同一组强制点、
// 由同一个点定案，且**没有任何输入能让它悄悄落到别处**。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DSH_ENFORCEMENT_POINTS,
  ENFORCEMENT_MAPPING,
  ENFORCEMENT_MAPPING_CHECKED,
  ENFORCEMENT_MAPPING_VERSION,
  LEGION_MODES,
  MAPPING_CODES,
  MODE_ROUTING,
  assertMappingConsistent,
  authorizationKeys,
  configPoints,
  decisionPoints,
  enforcementPathOf,
  mapPermissionMode,
  presetBinding,
  routeForMode,
} from './enforcement-mapping.mjs'
import { APPROVAL_DECISIONS, LEGION_PERMISSION_PRESETS } from './index.mjs'
import { CANONICAL_OP_KEYS, ENFORCEMENT_SOURCES } from './enforcement.mjs'
import { decideApproval } from './approval-policy.mjs'
import { PATCH_LAYER_ROWS } from './patch-layer.mjs'
import { probeSandbox } from './selfcheck.mjs'

/** 取 err.code，拿不到就返回 'NO-THROW'（省掉到处写 try/catch）。 */
function codeOf(fn) {
  try {
    fn()
    return 'NO-THROW'
  } catch (e) {
    return e.code ?? 'NO-CODE'
  }
}

const ATTENDED = Object.freeze({ policy: 'ask', requirement: 'ask', attended: true })
const UNATTENDED = Object.freeze({ policy: 'never', requirement: 'ask', attended: false })

// ---------------------------------------------------------------- 装载期自检

test('① 装载期自检通过，且它**查了**哪些东西被写下来（不是一个布尔 ok）', () => {
  assert.equal(ENFORCEMENT_MAPPING_CHECKED.ok, true, JSON.stringify(ENFORCEMENT_MAPPING_CHECKED.problems))
  // 证据必须是"算出来的"，不是"声明的"：
  assert.deepEqual(ENFORCEMENT_MAPPING_CHECKED.modes, [...LEGION_MODES])
  assert.deepEqual(ENFORCEMENT_MAPPING_CHECKED.routedModes, [...LEGION_MODES].sort())
  assert.deepEqual(ENFORCEMENT_MAPPING_CHECKED.mappingLines, [449, 450, 451, 452, 453, 454])
  // 六行 spec 对照，逐行留住行号——漏一行时这张读数会短一格，而不是变成 false。
  assert.equal(ENFORCEMENT_MAPPING.length, 6)
})

test('① ★ 装载期自检**没有查全**时会说出来（unresolvedPrimitives 不是被跳过）', () => {
  // selfcheck.mjs 是 import 本模块的那一侧，所以装载期解析不到 probeSandbox。
  // 处置是**记录下来**而不是跳过：
  //
  //   一个「自检说'所有原语都在'」的自检，
  //   与一个「其中一条原语从来没被查过」的自检，是同一个东西。
  assert.deepEqual(
    ENFORCEMENT_MAPPING_CHECKED.unresolvedPrimitives.map((u) => `${u.point}:${u.module}:${u.name}`),
    ['sandbox:selfcheck.mjs:probeSandbox'],
  )
  // 把那一侧注入进来之后就全查过了 —— 「全查过」这句话是两个调用点合起来才成立的。
  const full = assertMappingConsistent({ primitives: { 'selfcheck.mjs': { probeSandbox } } })
  assert.deepEqual(full.unresolvedPrimitives, [])
  assert.equal(full.ok, true)
})

// ---------------------------------------------------------------- 声明与审计口径

test('② ★ 决定来源**恰等于**审计口径，且 config 点不在里面', () => {
  // spec 的表有 6 行、`ENFORCEMENT_SOURCES` 只有 4 个。这中间的差不是漏了，
  // 而是"能对某一次调用定案的点"与"只绑定配置的点"之分。
  //
  //   一个「把配置绑定点也算进决定来源」的审计，
  //   与一个「source 列上出现一个从不做判定的来源」的审计，是同一个东西。
  assert.deepEqual(decisionPoints(), ['approval', 'guard', 'pre-execute', 'sandbox'])
  assert.deepEqual(decisionPoints(), [...ENFORCEMENT_SOURCES].sort())
  assert.deepEqual(configPoints(), ['canonical-operation', 'permissionPresets'])
  for (const cfg of configPoints()) {
    assert.ok(!ENFORCEMENT_SOURCES.includes(cfg), `${cfg} 是 config 点，不该出现在审计来源里`)
  }
})

test('② ★ 决定来源漂移会被自检抓到（两个方向）', () => {
  // 去掉一个来源
  const missing = assertMappingConsistent({ enforcementSources: ['pre-execute', 'guard', 'approval'] })
  assert.equal(missing.ok, false)
  assert.ok(missing.problems.some((p) => p.code === MAPPING_CODES.SOURCE_DRIFT))
  // 多一个 config 点
  const extra = assertMappingConsistent({
    enforcementSources: ['pre-execute', 'guard', 'approval', 'sandbox', 'permissionPresets'],
  })
  assert.equal(extra.ok, false)
  assert.ok(extra.problems.some((p) => p.code === MAPPING_CODES.SOURCE_DRIFT))
})

test('② ★ 每个决定来源都被至少一行映射引用（声明了却没人要求它做事 = 同一个东西）', () => {
  // 只查"引用的点都存在"会漏掉反方向：表里声明 `guard` 是决定来源，
  // 而没有任何一行要求它做任何事——审计口径里仍然有 guard，自检照样全绿。
  for (const p of decisionPoints()) {
    const inMapping = ENFORCEMENT_MAPPING.some((row) => row.points.includes(p))
    const inRouting = Object.values(MODE_ROUTING).some((r) => r.points.includes(p))
    assert.ok(inMapping || inRouting, `决定来源 "${p}" 没有被任何一行引用`)
  }
  // 直接约束 spec line 449 那一行：hard floor 必须同时落到早退与终审两个点。
  const hardFloor = ENFORCEMENT_MAPPING.find((r) => r.line === 449)
  assert.deepEqual([...hardFloor.points], ['pre-execute', 'guard'])
})

test('② ★ "无人引用"会被自检抓到', () => {
  // 造一个 guard 不被任何一行引用的世界：把 spec line 449 那一行的 points 掏空。
  // 这条断言存在的意义是——上面那条"每个决定来源都被引用"的检查**真的在跑**，
  // 而不是因为它恰好总为真。探针 ㊹① 第一次就是栽在这里：它改错了地方，
  // 而没有任何用例因此变红，说明当时**反方向确实没人查**。
  const rows = ENFORCEMENT_MAPPING.map((r) => (r.line === 449 ? { ...r, points: ['pre-execute'] } : r))
  const routing = { ...MODE_ROUTING, deny: { ...MODE_ROUTING.deny, points: ['pre-execute'] } }
  const r = assertMappingConsistent({ mappingRows: rows, routing })
  assert.equal(r.ok, false)
  assert.ok(
    r.problems.some((p) => p.code === MAPPING_CODES.POINT_UNREFERENCED && /guard/.test(p.message)),
    JSON.stringify(r.problems),
  )
})

test('② ★ 每个点声明的补丁行真的在 PATCH_LAYER_ROWS 里；删掉一行会被抓', () => {
  // 映射点名了一个不存在（或已被删）的补丁行时，它在描述一个不存在的强制面。
  const pruned = PATCH_LAYER_ROWS.filter((r) => r.id !== 'legion-enforcement-hard-floor')
  const r = assertMappingConsistent({ patchRows: pruned })
  assert.equal(r.ok, false)
  assert.ok(
    r.problems.some((p) => p.code === MAPPING_CODES.PATCH_ROW_MISSING && /hard-floor/.test(p.message)),
    JSON.stringify(r.problems),
  )
})

test('② ★ 原语不存在会被抓（映射点名了一个不存在的函数）', () => {
  const r = assertMappingConsistent({
    primitives: { 'enforcement.mjs': { createPreExecutePolicy: 'not-a-function' } },
  })
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => p.code === MAPPING_CODES.PRIMITIVE_MISSING))
})

test('② ★ 每个点都点名了 purpose 与它在 DSH 里的落点', () => {
  for (const [id, p] of Object.entries(DSH_ENFORCEMENT_POINTS)) {
    assert.equal(p.id, id)
    assert.ok(['decision', 'config'].includes(p.kind), `${id} 的 kind 必须是 decision/config`)
    assert.equal(typeof p.context, 'string')
    assert.ok(p.context.length > 0, `${id} 必须写明它在 DSH 里的落点`)
    assert.ok(p.purpose.length > 0, `${id} 必须写明它是干什么的`)
    assert.ok(p.primitive.module.endsWith('.mjs'))
    assert.ok(p.primitive.name.length > 0)
  }
})

// ---------------------------------------------------------------- 固定路由

test('③ ★ 不认识的模式**抛**，不兜底', () => {
  //   一个「不认识的 mode 就按 ask 处理」的兜底，
  //   与一个「拼错的 deny 被当成 ask、于是危险操作被送进审批箱等着被批」的兜底，
  //   是同一个东西。
  assert.equal(codeOf(() => routeForMode('allowd')), MAPPING_CODES.MODE_UNROUTED)
  assert.equal(codeOf(() => routeForMode('DENY')), MAPPING_CODES.MODE_UNROUTED)
  assert.equal(codeOf(() => routeForMode('')), MAPPING_CODES.MODE_UNROUTED)
  assert.equal(codeOf(() => routeForMode(undefined)), MAPPING_CODES.MODE_UNROUTED)
  assert.equal(codeOf(() => routeForMode(null)), MAPPING_CODES.MODE_UNROUTED)
  assert.equal(codeOf(() => mapPermissionMode({ mode: 'denyy' })), MAPPING_CODES.MODE_UNROUTED)
  // 五个真模式都不抛
  for (const m of LEGION_MODES) assert.doesNotThrow(() => routeForMode(m), m)
})

test('③ ★ `allow-once` 必须经过审批箱（不许被当成纯放行）', () => {
  // 名字里带 "allow"，所以最自然的写法是把它映射成 pre-execute 放行。那是错的：
  // spec line 451 把 ask 与 allow-once 并列在审批箱下，并说"只有 allowed-once 执行"
  // ——allow-once 描述的不是"这次调用已经安全"，而是"持有一张必须被消费的票据"。
  //
  //   一个「把 allow-once 映射成 pre-execute 直接放行」的表，
  //   与一个「票据从来没被消费过、于是同一张票能放行任意多次」的表，
  //   是同一个东西。
  assert.equal(MODE_ROUTING['allow-once'].viaApprovalBox, true)
  assert.equal(MODE_ROUTING.ask.viaApprovalBox, true)
  assert.ok(MODE_ROUTING['allow-once'].points.includes('approval'))
  const r = mapPermissionMode({ mode: 'allow-once', ...ATTENDED, requirement: 'allow-once' })
  assert.equal(r.decidedBy, 'approval')
  assert.ok(r.points.includes('approval'))
})

test('③ ★★ 找不到审批箱的模式不会拿到一个写死的 decision', () => {
  // 需要人过目的两条模式的 conclusion 由 decideApproval 决定，MODE_ROUTING 里
  // 必须是 null。写死一个值 = 把"无人值守怎么办"在映射层又实现了一遍。
  assert.equal(MODE_ROUTING.ask.decision, null)
  assert.equal(MODE_ROUTING['allow-once'].decision, null)
  // 其余三条不经过审批箱，结局由模式本身定死
  assert.equal(MODE_ROUTING.deny.decision, 'deny')
  assert.equal(MODE_ROUTING['allow-by-policy'].decision, 'allow')
  assert.equal(MODE_ROUTING['allow-for-task'].decision, 'allow')
})

test('③ `deny` 同时落 pre-execute 与 guard（早退与终审各有其责）', () => {
  // guard 只有降级语义、没有 allow 语义，所以"终审"只能由它承担；
  // 而"早退"必须发生在能省的活儿之前。
  assert.deepEqual([...MODE_ROUTING.deny.points], ['pre-execute', 'guard'])
  assert.equal(MODE_ROUTING.deny.decidedBy, 'pre-execute')
})

// ---------------------------------------------------------------- 落点函数

test('④ ★★ 无人值守：判定是 deny，且**不**进 answerer waterfall', () => {
  // spec line 452 的重点在那个"**前**"字：无人值守时 DSH 在 waterfall 之前拒绝。
  //
  //   一个「无人值守时仍然把请求送进 answerer waterfall」的映射，
  //   与一个「去问一个不在场的人、然后一直等下去」的映射，是同一个东西。
  const r = mapPermissionMode({ mode: 'ask', ...UNATTENDED })
  assert.equal(r.decision, 'deny')
  assert.equal(r.answererInvoked, false, '无人值守 + never 必须在 waterfall 之前就定案')
  assert.equal(r.approval.decision, 'deny')
  assert.equal(r.approval.code, 'approval-never-would-allow')
  // 但审批点**仍然在路径上**：定案发生在那个点上，不是在 pre-execute 就地放行。
  assert.ok(r.points.includes('approval'))
})

test('④ ★★ 有人值守 + ask：判定是 ask，且进 answerer waterfall', () => {
  const r = mapPermissionMode({ mode: 'ask', ...ATTENDED })
  assert.equal(r.decision, 'ask')
  assert.equal(r.answererInvoked, true)
  assert.equal(r.approval.needsHuman, true)
})

test('④ ★★ answererInvoked 与判定的关系是一条不变量，不是巧合', () => {
  // 逐组真实现场走一遍：**只有 ask 才进 waterfall**。
  const cases = [
    [{ policy: 'ask', requirement: 'ask', attended: true }, true],
    [{ policy: 'ask', requirement: 'allow-once', attended: true }, true],
    [{ policy: 'ask', requirement: 'none', attended: true }, false],
    [{ policy: 'never', requirement: 'ask', attended: false }, false],
    [{ policy: 'never', requirement: 'allow-once', attended: false }, false],
    [{ policy: 'never', requirement: 'none', attended: false }, false],
  ]
  for (const [input, expected] of cases) {
    // 两种需要人过目的的模式都要走同一条规则
    for (const mode of ['ask', 'allow-once']) {
      const r = mapPermissionMode({ mode, ...input })
      const label = `${mode} ${JSON.stringify(input)}`
      assert.equal(r.answererInvoked, expected, label)
      // 不变量本身：invoke ⟺ 判定是 ask
      assert.equal(r.answererInvoked, r.decision === 'ask', `${label}: answererInvoked 必须恰在判定为 ask 时为真`)
      assert.ok(APPROVAL_DECISIONS.includes(r.decision), `${label}: ${r.decision}`)
    }
  }
})

test('④ ★★ 映射层与 decideApproval 对"无人值守"的判断必须完全一致', () => {
  // 映射层如果自己再写一遍（`attended ? 'ask' : 'deny'`），就会有两份实现。
  // 这里逐组比对：映射给出的 decision 必须**就是** decideApproval 的 decision。
  for (const requirement of ['none', 'ask', 'allow-once']) {
    for (const attended of [true, false]) {
      for (const policy of ['ask', 'never']) {
        const input = { policy, requirement, attended, highRisk: false }
        const verdict = decideApproval(input)
        for (const mode of ['ask', 'allow-once']) {
          const r = mapPermissionMode({ mode, ...input })
          assert.equal(
            r.decision, verdict.decision,
            `${mode} ${JSON.stringify(input)}：映射层给出了 ${r.decision}，判定函数给出 ${verdict.decision}`,
          )
          assert.equal(r.approval.code, verdict.code)
          assert.equal(r.approval.reason, verdict.reason)
        }
      }
    }
  }
})

test('④ ★ 不经过审批箱的模式：approval 为 null、answererInvoked 为 false', () => {
  // 显式给 false，而不是留给调用方读 `approval === null` 去猜。
  for (const mode of ['deny', 'allow-by-policy', 'allow-for-task']) {
    const r = mapPermissionMode({ mode })
    assert.equal(r.approval, null, mode)
    assert.equal(r.answererInvoked, false, mode)
    assert.ok(r.points.length > 0)
  }
})

test('④ 落点结果是冻结的，且带版本', () => {
  const r = mapPermissionMode({ mode: 'ask', ...ATTENDED })
  assert.equal(r.version, ENFORCEMENT_MAPPING_VERSION)
  assert.ok(Object.isFrozen(r))
})

// ---------------------------------------------------------------- 固定路径视图

test('⑤ ★ enforcementPathOf 把 approval 点展开成两个阶段（那个"前"字的落地）', () => {
  const path = enforcementPathOf('ask')
  assert.deepEqual(path.map((x) => x.point), ['pre-execute', 'approval'])
  const approval = path.find((x) => x.point === 'approval')
  assert.deepEqual([...approval.stages], ['policy-gate', 'answerer'])
  // 不经过审批箱的模式没有这个展开
  const denyPath = enforcementPathOf('deny')
  assert.deepEqual(denyPath.map((x) => x.point), ['pre-execute', 'guard'])
  for (const step of denyPath) assert.deepEqual([...step.stages], [null])
})

// ---------------------------------------------------------------- preset 绑定

test('⑥ preset 绑定读得出沙箱与审批策略；未声明的抛', () => {
  // Legion **不复用** DSH 默认表：默认表把 danger-full-access↔never 绑在一起，
  // 按它实现"无人值守 = never"会同时把沙箱升到 danger-full-access。
  const unattended = presetBinding('legion-unattended')
  assert.equal(unattended.sandbox, 'workspace-write')
  assert.equal(unattended.approval, 'never')
  const attended = presetBinding('legion-attended')
  assert.equal(attended.sandbox, 'workspace-write')
  assert.equal(attended.approval, 'ask')
  // 两个 preset 的沙箱**相同**——无人值守改的只是"要不要问人"
  assert.equal(unattended.sandbox, attended.sandbox)
  assert.equal(codeOf(() => presetBinding('legion-whatever')), MAPPING_CODES.POINT_UNKNOWN)
  assert.deepEqual(Object.keys(LEGION_PERMISSION_PRESETS).sort(), ['legion-attended', 'legion-unattended'])
})

test('⑥ ★ preset 的 approval 与映射的 policy 输入是同一个词表', () => {
  // 如果 preset 里写 `never` 而 decideApproval 只认别的拼法，无人值守那条分支
  // 永远走不到——而它在单测里看起来是被覆盖的。
  for (const name of Object.keys(LEGION_PERMISSION_PRESETS)) {
    const b = presetBinding(name)
    assert.ok(['ask', 'never'].includes(b.approval), `${name}: ${b.approval}`)
    // 真的能喂进落点函数而不抛
    assert.doesNotThrow(() =>
      mapPermissionMode({ mode: 'ask', policy: b.approval, requirement: 'ask', attended: b.approval === 'ask' }),
    )
  }
})

// ---------------------------------------------------------------- 授权键

test('⑦ 授权键直接取自 enforcement.mjs，不另抄一份', () => {
  //   一个「在映射层再抄一份参与授权的键列表」的实现，
  //   与一个「映射说参与了、而哈希里没有它」的实现，是同一个东西。
  assert.equal(authorizationKeys(), CANONICAL_OP_KEYS)
  assert.ok(authorizationKeys().includes('toolName'))
  assert.ok(authorizationKeys().includes('arguments'))
  // 观察 metadata 不在里面
  for (const obs of ['attemptId', 'timestamp', 'uiText']) {
    assert.ok(!authorizationKeys().includes(obs), `${obs} 是观察 metadata，不该参与授权哈希`)
  }
})
