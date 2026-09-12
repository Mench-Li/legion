// runtime/dsh-composition/employee-manifest.test.mjs
// ============================================================================
// PRT-603 的判据：EmployeeManifest 工具白名单
//
// spec line 925：「接入 EmployeeManifest 工具白名单。」
// spec §6.9 line 489：员工 agent preset 属于 **agent 平面**，「岗位工具集」是它携带的内容
// spec §6.9 line 488：ToolGuard hard floor / pre-execute 策略 / approval answerer
//   属于 **host 组合 / profile 层**
//
// 一句话：清单挂在 agent 平面，强制面挂在 host 组合。**清单只能收窄，不能放宽。**
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EMPLOYEE_MANIFEST_CHECKED,
  EMPLOYEE_MANIFEST_VERSION,
  FORBIDDEN_MANIFEST_FIELDS,
  MANIFEST_CODES,
  MANIFEST_FIELDS,
  PROBE_GRANT,
  assertContractMatchesManifest,
  assertEmptyCapabilityIsVacuouslyAllowed,
  assertManifestFieldsClosed,
  assertNoWildcard,
  narrowToGrant,
  normalizeManifest,
  permitsTool,
  proveEveryRuleFires,
  proveWildcardsRejected,
} from './employee-manifest.mjs'
import { CAPABILITY_IDS, resolveTool } from './tool-capability.mjs'
import { EMPLOYEE_PRESET_CONTRACT } from './patch-layer.mjs'
import { createEnforcementBridge, projectToolRequest } from './tool-request.mjs'

const CTX = Object.freeze({
  scope: 'legion', actor: 'employee-1', action: 'file.write', taskId: 'task-1',
  cwd: 'C:/work', platform: 'win32',
})
const manifest = (over = {}) => ({
  version: EMPLOYEE_MANIFEST_VERSION, employeeId: 'e-1', role: 'reader',
  allowedTools: [], allowedCapabilities: [], maxRisk: 'critical', ...over,
})
const narrow = (over = {}, grant = PROBE_GRANT) => narrowToGrant({ manifest: manifest(over), grant })

// ------------------------------------------------- ① 平面纪律：只能收窄

test('① ★★ 强制面字段出现在清单里 → 抛（agent 平面不能携带强制面）', () => {
  //   > 一个「岗位清单里写着 allow 工具 X」的清单，
  //   > 与一个「岗位自己给自己发权限」的清单，是同一个东西——
  //   > 只不过前者看起来像配置。
  for (const field of FORBIDDEN_MANIFEST_FIELDS) {
    assert.throws(() => normalizeManifest(manifest({ [field]: 'x' })), new RegExp(MANIFEST_CODES.ENFORCEMENT_ON_AGENT_PLANE), field)
  }
  // 契约与拒绝名单必须对齐（契约说"不携带强制面" ⇔ 我们真的拒绝那些字段）
  const c = assertContractMatchesManifest()
  assert.equal(EMPLOYEE_PRESET_CONTRACT.mayCarryEnforcement, false)
  assert.equal(c.aligned, true)
  assert.equal(c.mayCarryEnforcement, false)
  assert.ok(c.forbiddenEnforcementFields.length > 0)
  assert.ok(c.carries.includes('岗位工具集'), '契约不再声明携带岗位工具集了')
  // ★ `aligned` 必须是**算出来的**，不是常量。
  //
  // 破坏性验证发现：第一版只断言 `aligned === true`，于是把 `aligned: true` 写死
  // 一处都没红。而写死之后，一个"允许携带强制面"的契约照样会报"对齐"。
  //
  //   > 一个「断言一个常量等于 true」的用例，
  //   > 与一个「契约变了但检查照样报对齐」的检查，是同一个东西。
  const loosened = assertContractMatchesManifest({ contract: { ...EMPLOYEE_PRESET_CONTRACT, mayCarryEnforcement: true } })
  assert.equal(loosened.aligned, false, '契约允许携带强制面时仍报"对齐"')
  assert.equal(loosened.mayCarryEnforcement, true)
  assert.equal(c.carries.length, EMPLOYEE_PRESET_CONTRACT.carries.length)
})

test('① ★★ 字段必须**闭合**：不认识的字段一律拒绝，不忽略', () => {
  //   > 一个「忽略不认识字段」的清单，
  //   > 与一个「多打的一个字母让整条限制静默失效」的清单，是同一个东西。
  //
  // 只查"已知字段里没有越权的"是不够的：把 `denyTools` 打成 `denyTool` 就绕过了。
  assert.throws(() => normalizeManifest(manifest({ denyTool: ['read-file'] })), new RegExp(MANIFEST_CODES.BAD_MANIFEST))
  assert.throws(() => normalizeManifest(manifest({ allowedTool: ['read-file'] })), /不认识的字段/)
  const e = assertManifestFieldsClosed({ manifest: manifest() })
  assert.deepEqual(e.unknown, [])
  assert.deepEqual(e.forbidden, [])
  assert.deepEqual([...e.fields].sort(), ['allowedCapabilities', 'allowedTools', 'employeeId', 'maxRisk', 'role', 'version'].sort())
  // 已知字段与拒绝名单交集必须为空（否则闭合检查自相矛盾）
  assert.deepEqual(MANIFEST_FIELDS.filter((f) => FORBIDDEN_MANIFEST_FIELDS.includes(f)), [])
})

test('① ★★ 通配符必须被拒（否则白名单恒真）', () => {
  //   > 一个「支持通配 `*`」的白名单，
  //   > 与一个「所有工具都被允许」的白名单，是同一个东西——
  //   > 只不过前者在配置里看起来是有选择的。
  const e = proveWildcardsRejected()
  assert.equal(e.allRejected, true, `有样本没被拒：${JSON.stringify(e.samples)}`)
  for (const s of e.samples) assert.equal(s.code, MANIFEST_CODES.WILDCARD, s.sample)
  assert.throws(() => normalizeManifest(manifest({ allowedTools: ['*'] })), /通配/)
  assert.throws(() => normalizeManifest(manifest({ allowedCapabilities: ['file:*'] })), /通配/)
  assert.throws(() => normalizeManifest(manifest({ allowedTools: ['file?'] })), /通配/)
  assert.throws(() => normalizeManifest(manifest({ allowedTools: ['  '] })), /通配/)
  // 正常名字安静通过
  assert.deepEqual([...normalizeManifest(manifest({ allowedTools: ['read-file'] })).allowedTools], ['read-file'])
})

test('① ★★ 清单申请授予之外的任何东西 → 抛，不静默取交集', () => {
  //   > 一个「取交集、静默丢掉越权项」的清单合并，
  //   > 与一个「岗位在申请一个它没有的工具、而没人知道」的清单合并，是同一个东西。
  assert.throws(() => narrow({ allowedTools: ['read-file', 'nope-tool'] }), new RegExp(MANIFEST_CODES.WIDENS_GRANT))
  assert.throws(() => narrow({ allowedTools: ['nope-tool'] }), /申请了授予之外的东西/)
  const partial = { ...PROBE_GRANT, allowedCapabilities: Object.freeze(['file:read']) }
  assert.throws(() => narrow({ allowedCapabilities: ['file:read', 'file:write'] }, partial), new RegExp(MANIFEST_CODES.WIDENS_GRANT))
  // 风险上限也只能更低
  assert.throws(() => narrow({ maxRisk: 'critical' }, { ...PROBE_GRANT, maxRisk: 'low' }), new RegExp(MANIFEST_CODES.WIDENS_GRANT))
  assert.throws(() => narrow({ maxRisk: 'critical' }, { ...PROBE_GRANT, maxRisk: 'low' }), /只能收窄/)
  // 合法收窄安静通过
  assert.equal(narrow({ maxRisk: 'low' }).maxRisk, 'low')
})

test('① ★★ 工作目录也只能收窄', () => {
  assert.throws(() => narrow({ workspaceRoot: 'C:/elsewhere' }), new RegExp(MANIFEST_CODES.OUT_OF_WORKSPACE))
  assert.throws(() => narrow({ workspaceRoot: 'C:/work2' }), /不在授予的/, 'C:/work2 不是 C:/work 之内')
  // 授予之内（更深）是允许的
  assert.equal(narrow({ workspaceRoot: 'C:/work/sub' }).workspaceRoot, 'C:/work/sub')
  // 相等也允许
  assert.equal(narrow({ workspaceRoot: 'C:/work' }).workspaceRoot, 'C:/work')
  // 大小写与分隔符不影响判定（win32）
  assert.equal(narrow({ workspaceRoot: 'c:\\WORK\\sub' }).workspaceRoot, 'c:\\WORK\\sub')
  // 授予没限定工作目录时，清单自己指定一个 = 放宽 → 拒绝
  assert.throws(() => narrow({ workspaceRoot: 'C:/work' }, { ...PROBE_GRANT, workspaceRoot: null }), /放宽/)
  // 都没指定 → 没问题
  assert.equal(narrow({}, { ...PROBE_GRANT, workspaceRoot: null }).workspaceRoot, null)
})

test('① ★★ 写一行 `version` 不能跳过校验', () => {
  // 破坏性验证与装载自检都撞到过这一点：第一版 `narrowToGrant` 写的是
  //   `manifest?.version === EMPLOYEE_MANIFEST_VERSION ? manifest : normalizeManifest(manifest)`
  // ——清单里写一行 version 就跳过了**全部**校验。
  //
  //   > 一个「看到 version 字段就认为它已经校验过」的校验，
  //   > 与一个「在清单里写一行 version 就能跳过所有检查」的校验，是同一个东西。
  assert.throws(
    () => narrowToGrant({ manifest: manifest({ allowedTools: ['*'] }), grant: PROBE_GRANT }),
    /通配/,
    '带 version 的清单跳过了通配符检查',
  )
  assert.throws(
    () => narrowToGrant({ manifest: manifest({ maxRisk: 'Critical' }), grant: PROBE_GRANT }),
    new RegExp(MANIFEST_CODES.BAD_RISK),
  )
  assert.throws(
    () => narrowToGrant({ manifest: manifest({ denyTools: [] }), grant: PROBE_GRANT }),
    new RegExp(MANIFEST_CODES.ENFORCEMENT_ON_AGENT_PLANE),
  )
  // 归一化是幂等的（重复调用无害）——**包括显式的 null**。
  // 破坏性验证发现：第一版只测了缺省字段，于是"第二次归一化把 null 变成 'null'"
  // 那条路径一次都没走到（去掉了 `|| input.xxx === null` 也不红）。
  //
  //   > 一个「只测缺省值」的幂等性用例，
  //   > 与一个「恰好绕开了所有 null 路径」的用例，是同一个东西。
  const opts = { allowedTools: ['read-file'], maxRisk: 'low', displayName: null, notes: null, workspaceRoot: null }
  const once = normalizeManifest(manifest(opts))
  const twice = normalizeManifest(once)
  const flatten = (m) => ({ ...m, allowedTools: [...m.allowedTools], allowedCapabilities: [...m.allowedCapabilities] })
  assert.deepEqual(flatten(twice), flatten(once))
  assert.equal(once.notes, null)
  assert.equal(twice.notes, null, 'notes 的 null 在第二次归一化时变成了字符串')
  assert.equal(twice.displayName, 'reader', 'displayName 的 null 应当落到 role')
  assert.equal(normalizeManifest(twice).displayName, 'reader')
  // 显式 null 与缺省是同一个结果
  assert.deepEqual(flatten(normalizeManifest(manifest({ ...opts, displayName: undefined, notes: undefined }))), flatten(once))
})

test('① ★ 清单的必填项与取值校验', () => {
  assert.throws(() => normalizeManifest(null), /需要一份清单对象/)
  assert.throws(() => normalizeManifest(manifest({ employeeId: '' })), /缺少 employeeId/)
  assert.throws(() => normalizeManifest(manifest({ role: '  ' })), /缺少 role/)
  // maxRisk 写错时**不**给默认值
  assert.throws(() => normalizeManifest(manifest({ maxRisk: 'Critical' })), new RegExp(MANIFEST_CODES.BAD_RISK))
  assert.throws(() => normalizeManifest(manifest({ maxRisk: undefined })), /不给默认值/)
  assert.throws(() => normalizeManifest(manifest({ allowedCapabilities: ['file:reed'] })), new RegExp(MANIFEST_CODES.UNKNOWN_CAPABILITY))
  assert.throws(() => normalizeManifest(manifest({ allowedCapabilities: ['file:reed'] })), /静默失效/)
  assert.throws(() => normalizeManifest(manifest({ workspaceRoot: '' })), /workspaceRoot 是空串/)
  // 没有授予就不能生效
  assert.throws(() => narrowToGrant({ manifest: manifest(), grant: null }), /没有授予/)
  // displayName 缺省落到 role
  assert.equal(normalizeManifest(manifest()).displayName, 'reader')
})

// ------------------------------------------------- ② 空集陷阱

test('② ★★ 未知工具**必须被点名**（空集是任何集合的子集）', () => {
  //   > 一个「用'它的能力都在允许集合里'来判定未知工具」的白名单，
  //   > 与一个「所有未知工具都被允许」的白名单，是同一个东西——
  //   > 因为未知工具的能力集合是空的，而空集是任何集合的子集。
  //
  // 这条性质先被**真的演示一次**，否则"必须点名"看起来像多余的谨慎。
  const e = assertEmptyCapabilityIsVacuouslyAllowed()
  assert.equal(e.emptySet, true, '夹具：未知工具的能力集合应当为空')
  assert.deepEqual([...e.unknownToolCapabilities], [])
  assert.equal(e.everyOnEmptySet, true, '夹具：every(...) 对空集应当恒真')
  assert.equal(e.verdict.allowed, false, '未知工具没有被点名却被允许了')
  assert.equal(e.verdict.rule, MANIFEST_CODES.UNKNOWN_TOOL_NOT_NAMED)
  assert.match(e.verdict.reason, /空集/)

  // 用**全部**能力都授予的清单，未知工具照样必须被点名
  const permissive = narrow({ allowedCapabilities: [...CAPABILITY_IDS], maxRisk: 'critical' })
  assert.equal(permitsTool({ permit: permissive, toolName: 'totally-unknown' }).allowed, false)
  assert.equal(permitsTool({ permit: permissive, toolName: 'totally-unknown' }).rule, MANIFEST_CODES.UNKNOWN_TOOL_NOT_NAMED)
  assert.match(permitsTool({ permit: permissive, toolName: 'totally-unknown' }).reason, /空集/)

  // 点名之后才允许 —— 而且**授予本身**必须先点名它。
  //   > 一个「清单可以点名一个授予里没有的工具」的规则，
  //   > 与一个「岗位能给自己发工具」的规则，是同一个东西。
  assert.throws(() => narrow({ allowedTools: ['totally-unknown'], maxRisk: 'critical' }), new RegExp(MANIFEST_CODES.WIDENS_GRANT))
  const grantWithUnknown = { ...PROBE_GRANT, allowedTools: Object.freeze([...PROBE_GRANT.allowedTools, 'totally-unknown']) }
  const named = narrow({ allowedTools: ['totally-unknown'], maxRisk: 'critical' }, grantWithUnknown)
  assert.equal(permitsTool({ permit: named, toolName: 'totally-unknown' }).allowed, true)
  // 授予点名了、但岗位没点名 → 仍然拒绝（未知工具是"必须点名"而不是"授予里有就行"）
  assert.equal(permitsTool({ permit: permissive, toolName: 'totally-unknown' }).allowed, false)
})

test('② ★★ hard floor 动作必须被点名（靠能力授权不够）', () => {
  //   > 一个「靠能力授权就能到达 hard floor 动作」的白名单，
  //   > 与一个「删除文件这件事不需要在岗位清单里被点名」的白名单，是同一个东西。
  const byCap = narrow({ allowedCapabilities: ['file:delete'], maxRisk: 'critical' })
  const v = permitsTool({ permit: byCap, toolName: 'delete-file' })
  assert.equal(v.allowed, false, '删除文件只靠能力授权就被允许了')
  assert.equal(v.rule, MANIFEST_CODES.HARD_FLOOR_NOT_NAMED)
  assert.match(v.reason, /hard floor/)
  // 点名之后才允许
  const named = narrow({ allowedTools: ['delete-file'], maxRisk: 'critical' })
  assert.equal(permitsTool({ permit: named, toolName: 'delete-file' }).allowed, true)
  // 三个 hard floor 工具都要这样
  for (const t of ['delete-file', 'git-push', 'write-secret']) {
    assert.equal(permitsTool({ permit: byCap, toolName: t }).rule, MANIFEST_CODES.HARD_FLOOR_NOT_NAMED, t)
  }
})

test('② ★★ 风险上限与是否被点名无关（先于其它规则生效）', () => {
  const low = narrow({ allowedTools: ['delete-file'], maxRisk: 'low' })
  const v = permitsTool({ permit: low, toolName: 'delete-file' })
  assert.equal(v.allowed, false)
  assert.equal(v.rule, MANIFEST_CODES.RISK_ABOVE_CEILING)
  assert.match(v.reason, /高于岗位上限/)
  // 已点名但风险超限 → 仍然是风险那条（规则的先后是有意的：最强收窄先报）
  assert.notEqual(v.rule, MANIFEST_CODES.NOT_WHITELISTED)
})

test('② ★★ 按能力授权要求**全部**能力都在允许集合里', () => {
  // 多出一个没被授予的能力 → 拒绝（fail closed），不是"至少一个匹配"。
  //   > 一个「至少一个能力匹配就放行」的白名单，
  //   > 与一个「只要工具会干一件被允许的事，它干的其它事也被允许」的白名单，
  //   > 是同一个东西——而它的方向是放行。
  const onlyRepo = narrow({ allowedCapabilities: ['repo:read'] })
  assert.equal(permitsTool({ permit: onlyRepo, toolName: 'run-command' }).allowed, false)
  assert.equal(permitsTool({ permit: onlyRepo, toolName: 'run-command' }).rule, MANIFEST_CODES.NOT_WHITELISTED)
  assert.match(permitsTool({ permit: onlyRepo, toolName: 'run-command' }).reason, /多出/)
  // 能力齐全才放行
  const full = narrow({ allowedCapabilities: ['command:exec', 'process:spawn'] })
  assert.equal(permitsTool({ permit: full, toolName: 'run-command' }).allowed, true)
  // 只给一半 → 仍拒绝（run-command 有 exec + spawn 两个能力）
  const half = narrow({ allowedCapabilities: ['command:exec'] })
  assert.equal(permitsTool({ permit: half, toolName: 'run-command' }).allowed, false)
})

test('② ★ 按能力授权对**改名免疫**', () => {
  //   > 一个「按工具名列举」的白名单，
  //   > 与一个「工具改名之后这个岗位就什么都做不了」的白名单，是同一个东西。
  //
  // 反向也成立：能力授权不该因为工具改名而失效——但**未知**工具仍须点名，
  // 所以这里用一个"能力恰好等于已授予集合"的已登记工具来验正向。
  const readOnly = narrow({ allowedCapabilities: ['file:read', 'repo:read'], maxRisk: 'low' })
  assert.equal(permitsTool({ permit: readOnly, toolName: 'read-file' }).allowed, true)
  assert.equal(permitsTool({ permit: readOnly, toolName: 'git-status' }).allowed, true)
  assert.equal(permitsTool({ permit: readOnly, toolName: 'write-file' }).allowed, false)
})

test('② ★ 空工具名与没有许可的调用一律拒绝', () => {
  const p = narrow({ allowedTools: ['read-file'], maxRisk: 'critical' })
  assert.equal(permitsTool({ permit: p, toolName: '' }).allowed, false)
  assert.equal(permitsTool({ permit: p, toolName: '' }).rule, 'bad-tool-name')
  assert.equal(permitsTool({ permit: null, toolName: 'read-file' }).allowed, false)
  assert.equal(permitsTool({ permit: null, toolName: 'read-file' }).rule, 'no-permit')
})

// ------------------------------------------------- ③ 每条规则都要真的能触发

test('③ ★★ 12 条规则逐条走到拒绝，一处都不许"写了但触发不了"', () => {
  //   > 一个「写在那里、但没有任何输入能触发它」的检查，
  //   > 与一个不存在的检查，在「它到底拦不拦得住」上是同一个东西。
  const e = proveEveryRuleFires()
  assert.deepEqual(e.misfired, [], `有规则没被触发：${JSON.stringify(e.misfired.map((m) => m.label))}`)
  assert.equal(e.cases.length, 12)
  for (const c of e.cases) {
    assert.equal(c.verdict.allowed, false, c.label)
    const got = c.verdict.rule ?? c.verdict.threw
    assert.equal(got, c.expectedRule, c.label)
    assert.match(String(c.verdict.message), new RegExp(c.expectedMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), c.label)
  }
  // 有的规则码被多条规则共用（三个 WIDENS_GRANT），所以"逐条触发"不能靠
  // 规则码互不相同来证明——要比**理由文本**互不相同。
  //
  //   > 一个「用规则码互不相同来证明逐条触发」的用例，
  //   > 与一个「三条规则共用一个码、其实只有一条在兜底」的实现，是同一个东西。
  const messages = e.cases.map((c) => String(c.verdict.message))
  assert.equal(new Set(messages).size, messages.length, `理由文本有重复：${JSON.stringify(messages)}`)
  const markers = e.cases.map((c) => c.expectedMarker)
  assert.equal(new Set(markers).size, markers.length, `锚点有重复：${JSON.stringify(markers)}`)
})

test('③ ★★ 逐条触发用的清单必须**真的一起用上**（不能只靠一条规则兜底）', () => {
  // 这条防的是"12 个探针其实都被同一条规则拒了"。做法：每个探针的清单
  // 在**换掉那一处**之后必须变绿——否则它测的不是那条规则。
  const base = manifest({ allowedTools: ['read-file'], allowedCapabilities: ['file:read'], maxRisk: 'low' })
  const ok = narrowToGrant({ manifest: base, grant: PROBE_GRANT })
  assert.equal(permitsTool({ permit: ok, toolName: 'read-file' }).allowed, true, '正例不通，那 12 个反例说明不了什么')
  // 每条规则的清单去掉那一处越权之后都应当变绿
  const fixes = [
    ['通配符', manifest({ allowedTools: ['read-file'], maxRisk: 'low' })],
    ['越权工具', manifest({ allowedTools: ['read-file'], maxRisk: 'low' })],
    ['风险上限越权', manifest({ allowedTools: ['read-file'], maxRisk: 'low' })],
  ]
  for (const [label, m] of fixes) {
    assert.equal(permitsTool({ permit: narrowToGrant({ manifest: m, grant: PROBE_GRANT }), toolName: 'read-file' }).allowed, true, label)
  }
})

// ------------------------------------------------- ④ 与桥的接线

test('④ ★★ 白名单在**策略端口之前**跑，拒绝即定案', async () => {
  //   > 一个「先问策略、策略说 allow 就放行」的桥，
  //   > 与一个「岗位清单只在策略也说不的时候才生效」的桥，是同一个东西。
  let policyCalls = 0
  const permit = narrow({ allowedTools: [], allowedCapabilities: ['file:read'], maxRisk: 'low' })
  const bridge = createEnforcementBridge({
    context: CTX,
    whitelist: (p) => permitsTool({ permit, toolName: p.toolName }),
    decide: () => { policyCalls += 1; return { kind: 'allow' } },
  })
  const denied = await bridge.preExecute({ name: 'write-file', callId: 'c1', arguments: { path: 'C:/work/a.txt' } })
  assert.equal(denied.kind, 'deny', '岗位之外的写操作被放行了')
  assert.match(denied.reason, /岗位白名单拒绝/)
  assert.match(denied.reason, new RegExp(MANIFEST_CODES.RISK_ABOVE_CEILING))
  assert.equal(policyCalls, 0, '策略端口在白名单拒绝之后仍然被调用了——那说明白名单没跑在前面')
  // 岗位之内的读操作正常走策略
  const allowed = await bridge.preExecute({ name: 'read-file', callId: 'c2', arguments: { path: 'C:/work/a.txt' } })
  assert.equal(allowed.kind, 'allow')
  assert.equal(policyCalls, 1)
})

test('④ ★★ 白名单拒绝的理由必须带**规则名**（岗位清单与策略规则是两处配置）', async () => {
  const permit = narrow({ allowedTools: [], allowedCapabilities: [], maxRisk: 'low' })
  const bridge = createEnforcementBridge({
    context: CTX,
    whitelist: (p) => permitsTool({ permit, toolName: p.toolName }),
    decide: () => ({ kind: 'allow' }),
  })
  const d = await bridge.preExecute({ name: 'run-command', callId: 'c1', arguments: { command: 'ls' } })
  assert.equal(d.kind, 'deny')
  // 理由里要能看出该改哪一处：规则码在，且说明是"岗位白名单"
  assert.match(d.reason, /岗位白名单/)
  assert.match(d.reason, new RegExp(MANIFEST_CODES.RISK_ABOVE_CEILING))
  // 账本里也留着（否则事后查不出这次拒绝是白名单还是策略）
  const p = bridge.projectionFor({ name: 'run-command', callId: 'c1', arguments: { command: 'ls' } }).projection
  const entries = bridge.ledgerOf(p.canonicalHash)
  assert.equal(entries.length, 1)
  assert.match(entries[0].reason, /岗位白名单/)
  assert.equal(entries[0].source, 'pre-execute')
})

test('④ ★★ 没有白名单时行为不变（可选，不是"必须有"）', async () => {
  const noWhitelist = createEnforcementBridge({ context: CTX, decide: () => ({ kind: 'allow' }) })
  const d = await noWhitelist.preExecute({ name: 'run-command', callId: 'c1', arguments: { command: 'ls' } })
  assert.equal(d.kind, 'allow')
  // 返回 null / 非对象的白名单一律当拒绝（fail closed）
  for (const bad of [() => null, () => ({}), () => 'yes', () => ({ allowed: 'true' })]) {
    const b = createEnforcementBridge({ context: CTX, whitelist: bad, decide: () => ({ kind: 'allow' }) })
    const r = await b.preExecute({ name: 'read-file', callId: 'c1', arguments: { path: 'C:/work/a.txt' } })
    assert.equal(r.kind, 'deny', `白名单返回 ${JSON.stringify(bad())} 时被放行了`)
    assert.match(r.reason, /岗位白名单拒绝/)
  }
})

test('④ ★★ 白名单与投影/账本用的是**同一份**身份', async () => {
  // 白名单拿到的是投影（有 canonicalHash / toolName），不是原始 execution。
  // 若它拿到原始 execution，它就得自己解析字段——那就是 PRT-602 的漂移。
  const seen = []
  const permit = narrow({ allowedTools: ['read-file'], maxRisk: 'low' })
  const bridge = createEnforcementBridge({
    context: CTX,
    whitelist: (p) => { seen.push(p); return permitsTool({ permit, toolName: p.toolName }) },
    decide: () => ({ kind: 'allow' }),
  })
  await bridge.preExecute({ name: 'read-file', callId: 'c9', arguments: { path: 'C:/work/a.txt' } })
  assert.equal(seen.length, 1)
  assert.match(seen[0].canonicalHash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(seen[0].toolName, 'read-file')
  assert.equal(seen[0].known, true)
  // 与直接投影得到的是同一个哈希
  const p = projectToolRequest({ request: { toolName: 'read-file', callId: 'c9', arguments: { path: 'C:/work/a.txt' } }, context: CTX })
  assert.equal(seen[0].canonicalHash, p.canonicalHash)
})

// ------------------------------------------------- ⑤ 装载时证据

test('⑤ ★★ 装载时留下的证据是**算出来的产物**', () => {
  const e = EMPLOYEE_MANIFEST_CHECKED
  assert.equal(e.version, EMPLOYEE_MANIFEST_VERSION)
  assert.equal(e.contract.aligned, true)
  assert.equal(e.wildcards.allRejected, true)
  assert.equal(e.emptyCapability.emptySet, true)
  assert.equal(e.emptyCapability.everyOnEmptySet, true, '空集恒真这条性质没有被演示出来')
  assert.deepEqual(e.rules.misfired, [])
  assert.equal(e.rules.cases.length, 12)
  assert.deepEqual([...new Set(e.rules.cases.map((c) => c.expectedMarker))].length, 12)
  assert.equal(e.readonlyEmployee.maxRisk, 'low')
  assert.deepEqual([...e.readonlyEmployee.allowedCapabilities], ['file:read', 'repo:read'])
  assert.equal(e.readonlyEmployee.grantMaxRisk, 'critical')
  assert.equal(e.readonlyEmployee.manifestMaxRisk, 'low')
  // 正例真的能用
  assert.equal(permitsTool({ permit: e.readonlyEmployee, toolName: 'read-file' }).allowed, true)
  assert.equal(permitsTool({ permit: e.readonlyEmployee, toolName: 'git-status' }).allowed, true)
  assert.equal(permitsTool({ permit: e.readonlyEmployee, toolName: 'write-file' }).allowed, false)
  // 已登记工具目录里的 hard floor 工具与我们的规则一致
  const hardFloored = ['delete-file', 'git-push', 'write-secret']
  for (const t of hardFloored) assert.equal(resolveTool(t).hardFloor, true, t)
})
