// runtime/dsh-composition/tool-request.test.mjs
// ============================================================================
// PRT-602 的判据：统一 ToolRequest 投影 + Enforcement Bridge
//
// spec §6.5 line 470：授权主体包含 scope、actor、action、target、taskId、toolName、
//   callId 和不可变工具参数；attemptId、UI 文案、时间戳等观察 metadata **不参与**。
// spec §6.8 line 479：任何已由 pre-execute 放行且获得 `allowed-once` 的调用，不得再被
//   guard 拒绝；出现"人工已批准但仍被 guard 拒绝"即视为强制面配置错误，**必须能由
//   审计定位到具体强制点**。
// spec §6.5 line 468：pre-execute **不允许改写工具参数**。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CALL_ID_FIELDS,
  CONTEXT_SCOPED_CAPABILITIES,
  GENERIC_TARGET_ARGUMENTS,
  OBSERVATION_KEYS,
  PROJECTION_CODES,
  SUBJECT_KEYS,
  TARGET_ARGUMENTS,
  TOOL_REQUEST_CHECKED,
  TOOL_REQUEST_VERSION,
  approvalRequestOf,
  assertNoProjectionDrift,
  assertObservationKeysRejected,
  assertProjectionAgrees,
  assertSubjectKeysShared,
  assertTargetArgumentsCoverAll,
  assertTargetlessSafe,
  assertUnknownToolsFailClosed,
  assertBridgeProvidesPorts,
  createEnforcementBridge,
  deriveTarget,
  guardInputOf,
  preExecuteInputOf,
  projectToolRequest,
  requestFromExecution,
  toolCallRowOf,
} from './tool-request.mjs'
import { AVAILABILITY_CODES, CANONICAL_OP_KEYS, createApprovalAnswerer } from './enforcement.mjs'
import { CAPABILITY_IDS } from './tool-capability.mjs'

const CTX = Object.freeze({
  scope: 'legion', actor: 'employee-1', action: 'file.write', taskId: 'task-1',
  cwd: 'C:/work', platform: 'win32',
})
const req = (over = {}) => ({ toolName: 'write-file', callId: 'call-1', arguments: { path: 'C:\\work\\a.txt', mode: 'w' }, ...over })
const project = (over = {}, ctx = CTX) => projectToolRequest({ request: req(over), context: ctx })

/** 只有强制面那三行的最小 patch 层夹具。 */
const TOOL_REQUEST_ROWS_FIXTURE = Object.freeze([
  { id: 'r-guard', registrations: ['ctx.tools.guard'] },
  { id: 'r-pre', registrations: ["ctx.on('tools/pre-execute')"] },
  { id: 'r-appr', registrations: ["ctx.on('approval/request')"] },
  { id: 'r-presets', registrations: ['config.presets'] },
])

// ------------------------------------------------------- ① 授权主体

test('① ★★ 主体**就是**强制面那一份键集合，顺序也一致', () => {
  // ★ 这里必须是**同一个对象**，不是"内容相同"。
  //
  // 破坏性验证抓到了这一点：第一版写的是 `deepEqual(SUBJECT_KEYS, CANONICAL_OP_KEYS)`，
  // 而抄一份出来的数组内容一模一样 → `deepEqual` 照样通过。
  //
  //   > 一个「断言两份列表内容相同」的用例，
  //   > 与一个「抄了一份、而且两份迟早不一样」的实现，是同一个东西——
  //   > 因为内容相同是**今天**的事实，不是"它们是同一份"这个**结构**事实。
  assert.equal(SUBJECT_KEYS, CANONICAL_OP_KEYS, '授权主体键集合不是强制面那一份（抄了一份）')
  assert.deepEqual([...SUBJECT_KEYS], ['scope', 'actor', 'action', 'target', 'taskId', 'toolName', 'callId', 'arguments'])
  assert.deepEqual(Object.keys(project().subject), [...SUBJECT_KEYS], '主体的键序不是固定的')
})

test('① ★★ 观察 metadata 出现在**参数**里时拒绝投影（不是滤掉）', () => {
  //   > 一个「把观察 metadata 从哈希里滤掉、但允许它留在主体对象里」的投影，
  //   > 与一个「它随时会被下一次重构重新算进去」的投影，是同一个东西。
  const e = assertObservationKeysRejected()
  assert.deepEqual(e.observationKeysAccepted, [], '有观察 metadata 被静默接受了')
  assert.deepEqual(e.observationKeysRejected, [...OBSERVATION_KEYS])
  for (const r of e.observationKeysRejectedWith) {
    assert.equal(r.code, PROJECTION_CODES.LEAKED_OBSERVATION_KEY, r.key)
  }
  assert.throws(() => project({ arguments: { path: 'C:/work/a.txt', attemptId: 'att-1' } }), /观察 metadata/)
  assert.throws(() => project({ arguments: { path: 'C:/work/a.txt', attemptId: 'att-1' } }), new RegExp(PROJECTION_CODES.LEAKED_OBSERVATION_KEY))
})

test('① ★★ 观察 metadata 挂在**请求**上时不影响哈希（spec line 470 的正面读法）', () => {
  const inv = TOOL_REQUEST_CHECKED.sampleObservationInvariant
  assert.equal(inv.length, 2)
  assert.equal(inv[0], inv[1], '请求上的 attemptId/时间戳/UI 文案改变了授权哈希')
  const [a, b] = inv
  assert.match(a, /^sha256:[0-9a-f]{64}$/)
  assert.equal(b, a)
})

test('① ★★ 缺 callId 必须抛，不得降级成"不用 callId 的身份"', () => {
  //   > 一个「没有 callId 就按其余字段算一个身份」的降级，
  //   > 与一个「同一时刻两次调用共用一个身份」的降级，是同一个东西。
  for (const bad of [undefined, null, '', '   ']) {
    assert.throws(() => project({ callId: bad }), /缺少 callId|需要非空/, String(bad))
  }
  assert.throws(() => requestFromExecution({ name: 'write-file', arguments: {} }), /缺少 callId/)
  assert.throws(() => requestFromExecution({ name: 'write-file', arguments: {} }), new RegExp(PROJECTION_CODES.NO_CALL_ID))
})

test('① ★ `requestFromExecution` 只改名、不推导（DSH 的 name → toolName）', () => {
  const got = requestFromExecution({ name: 'write-file', callId: 'c1', arguments: { path: '/w/a' }, uiText: '写入' })
  assert.equal(got.toolName, 'write-file')
  assert.equal(got.callId, 'c1')
  assert.deepEqual(got.arguments, { path: '/w/a' })
  assert.equal(got.uiText, '写入')
  // callId 的所有候选字段名都要认
  for (const f of CALL_ID_FIELDS) {
    assert.equal(requestFromExecution({ name: 't', [f]: 'call-9', arguments: {} }).callId, 'call-9', f)
  }
  assert.throws(() => requestFromExecution(null), /需要一个执行对象/)
  assert.throws(() => requestFromExecution({ callId: 'c1' }), /缺少工具名/)
  // ★ 候选字段名要**写死在用例里**，不能遍历 `CALL_ID_FIELDS`。
  //
  // 破坏性验证抓到了这一点：第一版写的是
  //   `for (const f of CALL_ID_FIELDS) assert.equal(requestFromExecution({[f]: ...})...)`
  // ——它遍历的正是被检查的那份名单。把名单改短，循环也跟着变短，用例照样绿。
  //
  //   > 一个「遍历被检查对象自己声明的列表」的用例，
  //   > 与一个「什么都不检查」的用例，在「列表被改短了会怎样」上是同一个东西。
  for (const f of ['callId', 'call_id', 'id']) {
    assert.equal(requestFromExecution({ name: 't', [f]: 'call-9', arguments: {} }).callId, 'call-9', f)
    assert.ok(CALL_ID_FIELDS.includes(f), `CALL_ID_FIELDS 不再认 ${f}`)
  }
  // 空参数：`null` 与 `undefined` 都当作"没有参数"（DSH 序列化时空参数两种都会出现）
  assert.deepEqual(requestFromExecution({ name: 't', callId: 'c', arguments: null }).arguments, {})
  assert.deepEqual(requestFromExecution({ name: 't', callId: 'c' }).arguments, {})
})

test('① ★★ 工具名过 NFC 与 trim（同一个工具名两种写法是同一个身份）', () => {
  // 破坏性验证发现这条没有用例覆盖。工具名不做 NFC/trim 时，
  // 一个组合字符写法与预组合字符写法会得到两个身份，
  // 而 DSH 侧与 F-02 侧对同一个工具名可能给出不同写法。
  //
  //   > 一个「工具名原样进哈希」的投影，
  //   > 与一个「同一个工具两种写法要问两次审批」的投影，是同一个东西——
  //   > 而它更坏的一面是：审计里同一个工具出现了两个不同的名字。
  const a = projectToolRequest({ request: { toolName: 'cafe\u0301_write', callId: 'c', arguments: { path: '/w/a' } }, context: CTX })
  const b = projectToolRequest({ request: { toolName: 'caf\u00e9_write', callId: 'c', arguments: { path: '/w/a' } }, context: CTX })
  assert.equal(a.toolName, 'caf\u00e9_write')
  assert.equal(a.canonicalHash, b.canonicalHash, '工具名的 NFC 没有生效')
  const c = projectToolRequest({ request: { toolName: '  write-file  ', callId: 'c', arguments: { path: '/w/a' } }, context: CTX })
  assert.equal(c.toolName, 'write-file', '工具名没有 trim')
  assert.equal(c.canonicalHash, projectToolRequest({ request: { toolName: 'write-file', callId: 'c', arguments: { path: '/w/a' } }, context: CTX }).canonicalHash, '工具名的空白改变了身份')
  // 而不同的工具名必须不同（否则上面两条是空的）
  assert.notEqual(a.canonicalHash, projectToolRequest({ request: { toolName: 'other-name', callId: 'c', arguments: { path: '/w/a' } }, context: CTX }).canonicalHash)
})

test('① ★ 上下文缺授权主体字段要抛（不补默认值）', () => {
  for (const key of ['scope', 'actor', 'action', 'taskId']) {
    const ctx = { ...CTX }
    delete ctx[key]
    assert.throws(() => project({}, ctx), new RegExp(`缺少授权主体字段 ${key}`), key)
  }
  assert.throws(() => projectToolRequest({}), /需要一个原始请求对象/)
  assert.throws(() => projectToolRequest({ request: req() }), /需要一个 Legion 上下文/)
  assert.throws(() => project({ arguments: [1, 2] }), /必须是一个对象/)
  assert.throws(() => project({ arguments: 'path=/w/a' }), /必须是一个对象/)
})

// ------------------------------------------------------- ② 目标推导

test('② ★★ 目标推导是**能力**驱动的，不是工具名驱动的', () => {
  // 换一个工具名、同样的能力 → 目标字段仍然被认出来。
  const a = projectToolRequest({ request: { toolName: 'write-file', callId: 'c', arguments: { path: '/w/a' } }, context: CTX })
  const b = projectToolRequest({ request: { toolName: '自定义写入工具', callId: 'c', arguments: { path: '/w/a' } }, context: CTX })
  assert.equal(a.target, '/w/a')
  assert.equal(b.target, '/w/a', '未登记工具的 path 没有被识别成目标（generic 候选没生效）')
  assert.equal(a.targetFrom, 'argument:path')
  assert.equal(b.targetFrom, 'argument:path')
  // 能力表覆盖了每一个能力种类，两个方向都查过
  assert.deepEqual(TOOL_REQUEST_CHECKED.targetArguments.missing, [])
  assert.deepEqual(TOOL_REQUEST_CHECKED.targetArguments.orphan, [])
  assert.deepEqual([...Object.keys(TARGET_ARGUMENTS)].sort(), [...CAPABILITY_IDS].sort())
})

test('② ★★ 显式 `target` 优先（工具可以说清自己的目标）', () => {
  const p = project({ arguments: { path: '/w/a', target: '/w/explicit' } })
  assert.equal(p.target, '/w/explicit')
  assert.equal(p.targetFrom, 'explicit')
})

test('② ★★ 目标**推不出来就抛**，绝不用空串兜底', () => {
  //   > 一个「有外部效果、但目标推导不出来时用空串兜底」的投影，
  //   > 与一个「所有无法定位的写操作共用同一个身份」的投影，是同一个东西——
  //   > 而它的方向是**放行**：一次批准覆盖了任意目标。
  assert.throws(() => project({ arguments: { mode: 'w' } }), /目标推导不出来/)
  assert.throws(() => project({ arguments: { mode: 'w' } }), new RegExp(PROJECTION_CODES.TARGET_MISSING))
  // 空串与全空白也不算目标
  assert.throws(() => project({ arguments: { path: '   ' } }), /目标推导不出来/)
  // 未登记工具同样不许兜底
  const u = assertUnknownToolsFailClosed()
  assert.equal(u[0].noTarget.ok, false, '未登记工具无目标时被放行了')
  assert.equal(u[0].noTarget.code, PROJECTION_CODES.TARGET_MISSING)
})

test('② ★★ 目标**不唯一就抛**（不猜是文件还是 URL）', () => {
  //   > 一个「两个候选里随便挑一个」的投影，
  //   > 与一个「审批绑定 A、guard 检查 B」的投影，是同一个东西。
  //
  // 歧义只可能出现在**候选集合本身有多个族**的时候：
  //  · 未登记工具 → 用 generic 候选，于是 `path` 与 `url` 都是候选 → 歧义 → 抛
  //  · 同时声明了文件与网络能力的工具 → 候选是并集 → 歧义 → 抛
  const u = assertUnknownToolsFailClosed()
  assert.equal(u[0].twoTargets.ok, false, '未登记工具给出两个目标候选时被放行了')
  assert.equal(u[0].twoTargets.code, PROJECTION_CODES.TARGET_AMBIGUOUS)
  assert.throws(
    () => projectToolRequest({ request: { toolName: 'mystery', callId: 'c', arguments: { path: '/w/a', url: 'https://x' } }, context: CTX }),
    /目标不唯一/,
  )
  assert.throws(
    () => deriveTarget({ capabilities: ['file:write', 'network:read'], args: { path: '/w/a', url: 'https://x' }, toolName: 't' }),
    new RegExp(PROJECTION_CODES.TARGET_AMBIGUOUS),
  )
  // 同一个值出现在两个候选名里不算歧义（那不是两个目标）
  assert.equal(project({ arguments: { path: '/w/a', file_path: '/w/a' } }).target, '/w/a')
})

test('② ★★ 已登记工具**只认自己能力的候选**（多余字段不参与，也不制造歧义）', () => {
  // 这正是"能力驱动"的含义：`write-file` 的能力是 `file:write`，
  // 所以它参数里的 `url` **不是**它的目标——那个字段对它没有意义。
  //
  //   > 一个「把参数里所有看起来像目标的字段都当候选」的投影，
  //   > 与一个「工具多带一个无关字段就再也无法被投影」的投影，是同一个东西。
  const p = project({ arguments: { path: '/w/a', url: 'https://x' } })
  assert.equal(p.target, '/w/a')
  assert.equal(p.targetFrom, 'argument:path')
})

test('② ★★ 无目标调用落到**工作目录**上，且只在声明过的能力里允许', () => {
  const p = projectToolRequest({ request: { toolName: 'git-status', callId: 'c', arguments: {} }, context: CTX })
  assert.equal(p.targetFrom, 'cwd')
  assert.equal(p.canonicalTarget, 'c:/work')
  // 没有 cwd → 抛（不猜工作目录）
  const noCwd = { ...CTX }
  delete noCwd.cwd
  assert.throws(() => projectToolRequest({ request: { toolName: 'git-status', callId: 'c', arguments: {} }, context: noCwd }), /拿不到工作目录/)
  // 一个不该允许无目标的能力：不带 url 的 fetch-url 必须抛，不能被当成"读当前目录"
  assert.throws(
    () => projectToolRequest({ request: { toolName: 'fetch-url', callId: 'c', arguments: {} }, context: CTX }),
    /目标推导不出来/,
    '不带 url 的网络调用被当成了无目标调用',
  )
})

test('② ★★ "无目标"名单里不得有外部效果/不可逆/hard floor 的能力', () => {
  //   > 一个「有外部效果的能力被放进'无目标'名单」的表，
  //   > 与一个「不带参数的网络调用被当成读本地文件」的表，是同一个东西。
  const ok = assertTargetlessSafe()
  assert.deepEqual(ok.unsafe, [])
  assert.deepEqual(ok.unknown, [])
  assert.deepEqual([...ok.scoped], ['repo:read'])
  // 自检**真的会拦**：把三个危险能力逐个塞进去
  for (const bad of ['network:read', 'file:delete', 'credential:write', 'repo:push']) {
    assert.throws(() => assertTargetlessSafe({ scoped: ['repo:read', bad] }), /不该出现的项/, bad)
  }
  // 未知能力名也要拦（拼错的名字 = 名单静默失效）
  assert.throws(() => assertTargetlessSafe({ scoped: ['repo:read', 'nope:read'] }), /未知/)
})

test('② ★★ 目标参数表与能力种类必须两个方向都对得上', () => {
  const ok = assertTargetArgumentsCoverAll()
  assert.equal(ok.covered.length, CAPABILITY_IDS.length)
  // 少一项 → 那个能力的目标推导不出来（然后兜底 = 放行）
  const drop = { ...TARGET_ARGUMENTS }
  delete drop['file:write']
  assert.throws(() => assertTargetArgumentsCoverAll({ targetArguments: drop }), /缺 \["file:write"\]/)
  // 多一项 → 指向一个已不存在的能力
  assert.throws(
    () => assertTargetArgumentsCoverAll({ targetArguments: { ...TARGET_ARGUMENTS, 'ghost:do': ['x'] } }),
    /多 \["ghost:do"\]/,
  )
})

test('② ★ 推导函数本身可直接调用，并报出它是从哪个参数拿到的', () => {
  const d = deriveTarget({ capabilities: ['network:read'], args: { url: 'https://e.com/x' }, toolName: 't', platform: 'linux' })
  assert.equal(d.target, 'https://e.com/x')
  assert.equal(d.from, 'argument:url')
  const arr = deriveTarget({ capabilities: ['command:exec'], args: { argv: ['ls', '-la'] }, toolName: 't', platform: 'linux' })
  assert.equal(arr.target, 'ls -la', 'argv 数组没有拼成一个目标')
})

// ------------------------------------------------------- ③ 四个摄入适配器

test('③ ★★ 四个摄入适配器报告**同一个**哈希、**同一份**参数', () => {
  const p = project()
  const e = assertProjectionAgrees({ projection: p })
  assert.equal(e.agreed, true)
  assert.deepEqual(e.perSurface.map((s) => s.surface), ['guard', 'pre-execute', 'approval', 'audit'])
  assert.equal(e.sameArguments, true)
  for (const s of e.perSurface) assert.equal(s.canonicalHash, p.canonicalHash, s.surface)
  // 四个面拿到的是同一个引用，不是四份副本
  assert.equal(guardInputOf(p).arguments, p.arguments)
  assert.equal(preExecuteInputOf(p).arguments, p.arguments)
  assert.equal(approvalRequestOf(p).arguments, p.arguments)
  assert.equal(toolCallRowOf(p, { decision: 'allow', decisionSource: 'pre-execute' }).canonicalInput, p.arguments)
})

test('③ ★★ 漂移必须被拦下（有人报了另一个哈希 / 拿了别的参数）', () => {
  const p = project()
  // 只让**一个**适配器漂移：其余三个仍报真实哈希
  const e = assertProjectionAgrees({
    projection: p,
    adapters: { approvalRequestOf: (x) => ({ ...approvalRequestOf(x), canonicalHash: 'sha256:forged' }) },
  })
  assert.equal(e.agreed, false, '一个适配器报伪造哈希，却被判成一致')
  assert.equal(e.code, PROJECTION_CODES.PROJECTION_DRIFT)
  assert.deepEqual(e.perSurface.map((s) => s.canonicalHash), [p.canonicalHash, p.canonicalHash, 'sha256:forged', p.canonicalHash])
  assert.throws(() => assertNoProjectionDrift(e), /强制面之间投影不一致/)
  assert.throws(() => assertNoProjectionDrift(e), /实现 bug/)
  // 参数被换掉（内容相同、引用不同）也算不一致
  const copying = assertProjectionAgrees({ projection: p, adapters: { guardInputOf: (x) => ({ ...guardInputOf(x), arguments: structuredClone(x.arguments) }) } })
  assert.equal(copying.sameArguments, false)
  assert.equal(copying.agreed, false)
  assert.throws(() => assertNoProjectionDrift(copying), /同一份参数=false/)
  // 真实实现安静通过
  assert.equal(assertNoProjectionDrift(assertProjectionAgrees({ projection: p })).agreed, true)
})

test('③ ★★ 适配器**不得**再推导一次目标（否则就是漂移的来源）', () => {
  // 这条把"适配器只摆放"钉成可测的性质：guard 适配器报的目标必须**就是**
  // 投影算出来的那个规范化目标，而不是它从 arguments 里再找一遍的结果。
  const p = project({ arguments: { path: 'C:\\work\\a.txt' } })
  assert.equal(guardInputOf(p).__legionTarget, p.canonicalTarget)
  assert.notEqual(guardInputOf(p).__legionTarget, p.arguments.path, '适配器报的是原始参数，不是投影算出的规范化目标')
  assert.equal(preExecuteInputOf(p).target, p.canonicalTarget)
  assert.equal(approvalRequestOf(p).target, p.canonicalTarget)
})

test('③ ★ 主体键集合自检**真的会拦**"抄一份"的实现', () => {
  assert.deepEqual([...assertSubjectKeysShared().keys], [...CANONICAL_OP_KEYS])
  assert.throws(() => assertSubjectKeysShared({ subjectKeys: CANONICAL_OP_KEYS.slice(0, 7) }), /不一致/)
  assert.throws(() => assertSubjectKeysShared({ subjectKeys: [...CANONICAL_OP_KEYS, 'extra'] }), /不一致/)
  // 顺序不同也算不一致（键序是身份的一部分）
  const swapped = [...CANONICAL_OP_KEYS]
  ;[swapped[0], swapped[1]] = [swapped[1], swapped[0]]
  assert.throws(() => assertSubjectKeysShared({ subjectKeys: swapped }), /不一致/)
})

// ------------------------------------------------------- ④ 桥

test('④ ★★ guard **只有降级语义**：返回 string 或 undefined，永远没有 allow', async () => {
  const bridge = createEnforcementBridge({ context: CTX, floor: { denyTools: ['delete-file'] }, decide: () => ({ kind: 'allow' }) })
  const allowed = bridge.guard({ name: 'write-file', callId: 'c1', arguments: { path: 'C:/work/a.txt' } })
  assert.equal(allowed, undefined, 'guard 对允许的调用返回了不是 undefined 的东西')
  const denied = bridge.guard({ name: 'delete-file', callId: 'c2', arguments: { path: 'C:/work/b.txt' } })
  assert.equal(typeof denied, 'string', 'guard 的拒绝不是字符串')
  assert.match(denied, /hard floor/)
  assert.match(denied, /delete-file/)
})

test('④ ★★★★ 下限里的调用**根本走不到**策略门——两道闸现在是同一份判定', async () => {
  // ★★ 这一条是**本批最重的一条**，而它是**实测逼出来的**。
  //
  // 在这之前，这一个位置上的用例钉的是**相反**的行为：
  // 「pre-execute 放行 + guard 拒绝 → 归类为强制点冲突」。
  // 那一版之所以绿，是因为桥的 pre-execute 那一段**从不跑下限判定**——
  // 而 spec §6.8（`:456`）要求的是**两道闸**：
  // 「`tools/pre-execute` 提前拒绝」+「`ctx.tools.guard()` 最终复核」。
  // `composePreExecuteFloor()`（写出第一道闸的函数）在全仓库只有用例在调。
  //
  //   > 一条"造出一个强制点冲突、断言它能被归类"的用例，
  //   > 与一条"证明这个冲突**根本不该发生**"的用例，
  //   > 在绿树上长得一样——只不过前者把缺陷当成了被测规格。
  //
  // 实测证据（修之前，真桥、真下限）：
  //   一次 `delete-file` → pre-execute `allow` → 策略门被调用 **1** 次
  //   → guard「hard floor：工具 delete-file 被静态禁止（不可由审批解除）」
  // 也就是：注定被拒的调用走进了审批箱，人批了仍然被拒。
  const policyCalls = []
  const bridge = createEnforcementBridge({
    context: CTX,
    floor: { denyTools: ['write-file'], denyPathPrefixes: [] },
    // 策略门记下**它看见了什么**——这是"有没有走进审批箱"的唯一判据。
    decide: (projection) => { policyCalls.push(projection.toolName); return { kind: 'allow' } },
  })
  const execution = { name: 'write-file', callId: 'c9', arguments: { path: 'C:/work/a.txt' } }

  const pre = await bridge.preExecute(execution)
  assert.equal(pre.kind, 'deny', '下限里的调用在 pre-execute 被放行了')
  // ① ★ 策略门**一次都没被叫**：没有走进审批箱，也就没有"人批了仍然被拒"。
  assert.deepEqual(policyCalls, [],
    `注定被 guard 拒绝的调用进了策略门（看见了 ${JSON.stringify(policyCalls)}）——`
    + '那正是"人工已批准但仍被拒绝"这条无修复动作的审计记录的产生方式')
  // ② 两道闸说**同一句话**：不是"两处各有一份拒绝理由"，是同一份判定。
  const guardReason = bridge.guard(execution)
  assert.equal(typeof guardReason, 'string')
  assert.equal(pre.reason, guardReason,
    'pre-execute 与 guard 给出的理由不同 —— 两份"同一个下限"的实现会漂，'
    + '而漂的那一天只表现为"这次怎么被拒了"')
  assert.match(pre.reason, /write-file/)
  // ③ 于是**没有冲突可归**：冲突检测器是正确的安静，不是失效。
  assert.deepEqual(bridge.assertNoContradiction(), [],
    '早退生效之后不该再有"放行过、又被 guard 拒"的对')
})

test('④ ★★★ 冲突检测器在同桥之内**结构上不可达**（这正是"一份判定"的目的，可实测）', async () => {
  // 上一条把"下限造成的冲突"消灭了。于是有一个必须回答的问题：
  // 那个检测器是不是变成了死代码？
  //
  // 答案是"同桥之内不可达，但它守的是**另一种**处境"。这一条把"不可达"
  // 当**判据**钉住，而不是靠推理——穷举桥上所有公开调用序列，一条都不该造出冲突：
  // 只 guard / preExecute→guard / guard→guard / 别的工具先过→本工具 guard。
  //
  //   > 一个"两个强制点各有一份下限"的实现，
  //   > 与一个"两个强制点共用同一次 `createHardFloorGuard` 调用结果"的实现，
  //   > 在**拒绝行为**上是同一个东西——只不过前者迟早会出现一条
  //   > "人批了仍然被拒"的对，而那条对里没有任何东西告诉你去改哪里。
  //
  // ★ 而检测器**没有**变成死代码：它守的是**别的行**挂了一份会漂的下限
  //   （补丁层里的 `legion-enforcement-hard-floor` 是一个**独立**的行，
  //   它拿到的 floor 与桥的这一份在构造上不是同一个对象）。
  //   那正是本仓库反复出现的形状，所以检测器必须留着。
  //   它自己的逻辑由 `guard-consistency.test.mjs` 的合成对覆盖
  //   （`checkApprovedCallsSurviveGuard` / `assertNoContradiction`）——
  //   不需要在这里假装构造一次。
  const exOfWriteFile = () => ({ name: 'write-file', callId: 'c1', arguments: { path: 'C:/work/a.txt' } })
  const SEQUENCES = {
    '只 guard': async (b) => { b.guard(exOfWriteFile()) },
    'preExecute → guard': async (b) => { await b.preExecute(exOfWriteFile()); b.guard(exOfWriteFile()) },
    'guard → guard': async (b) => { b.guard(exOfWriteFile()); b.guard(exOfWriteFile()) },
    '别的工具先过 → 本工具 guard': async (b) => {
      await b.preExecute({ name: 'read-file', callId: 'c2', arguments: { path: 'C:/work/a.txt' } })
      b.guard(exOfWriteFile())
    },
  }
  for (const [name, run] of Object.entries(SEQUENCES)) {
    const findings = []
    const bridge = createEnforcementBridge({
      context: CTX,
      floor: { denyTools: ['write-file'], denyPathPrefixes: [] },
      decide: () => ({ kind: 'allow' }),
      onContradiction: (f) => findings.push(f),
    })
    await run(bridge)
    assert.deepEqual(findings, [],
      `「${name}」造出了 ${findings.length} 条强制点冲突——两道闸不是同一份判定了`)
    assert.deepEqual(bridge.assertNoContradiction(), [])
  }
})

test('④ ★★ 没有冲突时审计安静（不能"永远报一条冲突"）', async () => {
  const bridge = createEnforcementBridge({ context: CTX, floor: { denyTools: ['delete-file'] }, decide: () => ({ kind: 'allow' }) })
  await bridge.preExecute({ name: 'write-file', callId: 'ok1', arguments: { path: 'C:/work/a.txt' } })
  assert.equal(bridge.guard({ name: 'write-file', callId: 'ok1', arguments: { path: 'C:/work/a.txt' } }), undefined)
  assert.deepEqual(bridge.contradictions(), [])
  assert.deepEqual(bridge.assertNoContradiction(), [])
  // 被**拒绝**但从未放行过的调用不算冲突
  bridge.guard({ name: 'delete-file', callId: 'ok2', arguments: { path: 'C:/work/b.txt' } })
  assert.deepEqual(bridge.assertNoContradiction(), [])
})

test('④ ★★ pre-execute **不允许改写参数**：改了就把这次调用改成拒绝', async () => {
  // spec §6.5 line 468：只能拒绝当前调用并要求产生一个新的 Tool Call。
  const bridge = createEnforcementBridge({
    context: CTX,
    decide: () => ({ kind: 'allow', arguments: { path: 'C:/etc/passwd', mode: 'w' } }),
  })
  const d = await bridge.preExecute({ name: 'write-file', callId: 'rw1', arguments: { path: 'C:/work/a.txt', mode: 'w' } })
  assert.equal(d.kind, 'deny', 'pre-execute 改写了参数却被放行')
  assert.match(d.reason, /改写/)
  assert.match(d.reason, /只允许拒绝/)
  // 同值返回（内容相同）不算改写
  const ok = createEnforcementBridge({ context: CTX, decide: () => ({ kind: 'allow', arguments: { path: 'C:/work/a.txt', mode: 'w' } }) })
  const d2 = await ok.preExecute({ name: 'write-file', callId: 'rw2', arguments: { path: 'C:/work/a.txt', mode: 'w' } })
  assert.equal(d2.kind, 'allow')
})

test('④ ★★ 投影不了的调用一律**拒绝**，三条路径都一样', async () => {
  //   > 一个「投影失败就跳过强制」的路径，
  //   > 与一个「强制面可以被一次畸形请求关掉」的路径，是同一个东西。
  const bridge = createEnforcementBridge({ context: CTX, decide: () => ({ kind: 'allow' }), requestApproval: async () => 'allowed-once' })
  // 没有 callId → 投影不了
  const noCall = { name: 'write-file', arguments: { path: 'C:/work/a.txt' } }
  const pg = bridge.guard(noCall)
  assert.equal(typeof pg, 'string', 'guard 对投影不了的调用放行了')
  assert.match(pg, /无法投影/)
  assert.match(pg, new RegExp(PROJECTION_CODES.NO_CALL_ID))
  const pd = await bridge.preExecute(noCall)
  assert.equal(pd.kind, 'deny')
  assert.match(pd.reason, /无法投影/)
  const pa = await bridge.answerer({ toolName: 'write-file', arguments: { path: 'C:/work/a.txt' } })
  assert.equal(pa, 'unavailable', 'answerer 对投影不了的请求返回了非 unavailable')
  // 目标推不出来 → 同样三条都拒绝
  const noTarget = { name: 'write-file', callId: 'x1', arguments: { mode: 'w' } }
  assert.match(bridge.guard(noTarget), /无法投影/)
  assert.equal((await bridge.preExecute(noTarget)).kind, 'deny')
  assert.equal(await bridge.answerer({ toolName: 'write-file', callId: 'x2', arguments: { mode: 'w' } }), 'unavailable')
})

test('④ ★★ answerer 命中 allowed-once 时记账，其它结果也记账', async () => {
  const outcomes = { 'c-ok': 'allowed-once', 'c-no': 'rejected', 'c-cancel': 'cancelled' }
  const bridge = createEnforcementBridge({
    context: CTX,
    requestApproval: async (p) => outcomes[p.callId] ?? 'unavailable',
  })
  const mk = (callId) => ({ name: 'write-file', callId, arguments: { path: `C:/work/${callId}.txt` } })
  for (const callId of Object.keys(outcomes)) {
    const got = await bridge.answerer(mk(callId))
    assert.equal(got, outcomes[callId], callId)
    const p = bridge.projectionFor(mk(callId)).projection
    const entries = bridge.ledgerOf(p.canonicalHash)
    assert.equal(entries.length, 1, `${callId} 没有记账`)
    assert.equal(entries[0].source, 'approval')
    assert.equal(entries[0].decision, outcomes[callId])
  }
  // allowed-once 之后 guard 拒绝 → 冲突（审批已批准却被 guard 拒）
  const allowedExec = mk('c-ok')
  await bridge.answerer(allowedExec)
  const conflicting = createEnforcementBridge({
    context: CTX,
    floor: { denyTools: ['write-file'] },
    requestApproval: async () => 'allowed-once',
    onContradiction: () => {},
  })
  const exec = { name: 'write-file', callId: 'c-ok', arguments: { path: 'C:/work/c-ok.txt' } }
  await conflicting.answerer(exec)
  assert.equal(typeof conflicting.guard(exec), 'string')
  assert.equal(conflicting.assertNoContradiction().length, 1)
})

test('④ ★★ 账本记**放行**也记拒绝（否则事后分不清 guard 到底跑没跑）', async () => {
  // 破坏性验证发现：删掉 guard 的放行记账，一处都没红——因为用例只查过
  // "冲突那一条账"。而没有放行记录的账本，回答不了最基础的一个问题：
  // **这一次调用到底经过 guard 了吗？**
  //
  //   > 一个「只在拒绝时记账」的账本，
  //   > 与一个「事后分不清 guard 到底跑没跑」的账本，是同一个东西。
  const bridge = createEnforcementBridge({ context: CTX, floor: { denyTools: ['delete-file'] }, decide: () => ({ kind: 'allow' }) })
  const exec = { name: 'write-file', callId: 'g1', arguments: { path: 'C:/work/a.txt' } }
  assert.equal(bridge.guard(exec), undefined)
  const p = bridge.projectionFor(exec).projection
  const entries = bridge.ledgerOf(p.canonicalHash)
  assert.equal(entries.length, 1, 'guard 放行了却没有记账')
  assert.equal(entries[0].source, 'guard')
  assert.equal(entries[0].decision, 'allow')
  assert.equal(typeof entries[0].at, 'number')
  // 拒绝也要记
  bridge.guard({ name: 'delete-file', callId: 'g2', arguments: { path: 'C:/work/b.txt' } })
  const p2 = bridge.projectionFor({ name: 'delete-file', callId: 'g2', arguments: { path: 'C:/work/b.txt' } }).projection
  const e2 = bridge.ledgerOf(p2.canonicalHash)
  assert.equal(e2.length, 1)
  assert.equal(e2[0].decision, 'deny')
  assert.match(e2[0].reason, /hard floor/)
  // 投影不了的调用也要留痕（挂在 null 下），否则"被拒绝了"在账上完全消失
  assert.match(bridge.guard({ name: 'write-file', arguments: { path: 'C:/work/c.txt' } }), /无法投影/)
  const unattributed = bridge.ledgerOf(null)
  assert.equal(unattributed.length, 1, '投影不了的拒绝没有留痕')
  assert.match(unattributed[0].reason, /无法投影/)
  // 但它不得混进"有身份的哈希"里
  assert.equal(bridge.ledgerHashes().includes(null), false)
})

test('④ ★ 账按哈希索引，且能列出全部哈希', async () => {
  const bridge = createEnforcementBridge({ context: CTX, floor: { denyTools: [] }, decide: () => ({ kind: 'allow' }) })
  await bridge.preExecute({ name: 'write-file', callId: 'h1', arguments: { path: 'C:/work/a.txt' } })
  await bridge.preExecute({ name: 'write-file', callId: 'h2', arguments: { path: 'C:/work/b.txt' } })
  const hashes = bridge.ledgerHashes()
  assert.equal(hashes.length, 2)
  for (const h of hashes) assert.match(h, /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(bridge.ledgerOf('sha256:nope'), [])
  // 两次不同的调用必须得到两个不同的哈希（否则账会合并成一条）
  assert.notEqual(hashes[0], hashes[1])
})

// ------------------------------------------------------- ⑤ 规范化语义

test('⑤ ★★ 同一文件的两种写法：**目标**规范化后相同，**哈希**不同（有意的方向）', () => {
  // 破坏性验证与首次运行都确认过这里的读数，它们是**两件不同的事**：
  //   · canonicalTarget 相同 → 路径规范化（绝对化/分隔符/大小写）生效
  //   · 哈希不同 → arguments 里那两个字符串本身不同
  //
  // 哈希不同是**有意**的，方向是**多问一次**（拒绝）：
  //   > 一个「为了让两种写法得到同一个审批而把 arguments 也规范化一遍」的投影，
  //   > 与一个「执行时看到的参数不是被哈希的那一份」的投影，是同一个东西——
  //   > 而 spec §6.5 line 468 恰恰禁止改写参数。
  const c = TOOL_REQUEST_CHECKED.caseInsensitive
  assert.equal(c.targets[0], c.targets[1], '路径规范化没有生效（大小写/分隔符）')
  assert.equal(c.targets[0], 'c:/work/a.txt')
  assert.notEqual(c.hashes[0], c.hashes[1], '两种写法得到了同一个哈希——那说明 arguments 被改写了')
  // 规范化确实压在 target 上：反斜杠与盘符都被归并
  assert.equal(project({ arguments: { path: 'C:\\work\\.\\sub\\..\\a.txt' } }).canonicalTarget, 'c:/work/a.txt')
})

test('⑤ ★ 非 win32 不做大小写归并（那是平台规则，不是通用规则）', () => {
  const linux = { ...CTX, platform: 'linux' }
  assert.equal(project({ arguments: { path: '/Work/A.txt' } }, linux).canonicalTarget, '/Work/A.txt')
  assert.equal(project({ arguments: { path: '/Work/A.txt' } }, CTX).canonicalTarget, '/work/a.txt')
})

test('⑤ ★ 相对路径按 cwd 展开，缺 cwd 时不猜', () => {
  assert.equal(project({ arguments: { path: 'sub/a.txt' } }).canonicalTarget, 'c:/work/sub/a.txt')
  // `deriveTarget` 本身不做路径规范化（那是投影的第二步），所以缺 cwd 时抛的是投影
  const noCwd = { ...CTX }
  delete noCwd.cwd
  assert.throws(() => project({ arguments: { path: 'sub/a.txt' } }, noCwd), /缺少 cwd/)
  assert.throws(() => project({ arguments: { path: 'sub/a.txt' } }, noCwd), /不猜工作目录/)
  // 绝对路径不需要 cwd（但 win32 上仍要平台信息；平台有默认值）
  const absCtx = { ...noCwd }
  assert.equal(projectToolRequest({ request: req(), context: absCtx }).canonicalTarget, 'c:/work/a.txt')
})

test('⑤ ★ 未登记工具：保守风险 + 唯一目标可投影', () => {
  const p = projectToolRequest({ request: { toolName: 'mystery-tool', callId: 'c', arguments: { path: '/w/a' } }, context: CTX })
  assert.equal(p.known, false)
  assert.equal(p.risk, 'critical')
  assert.equal(p.isWrite, true, '未登记工具被判成"不是写"')
  assert.equal(p.hardFloor, true)
  assert.deepEqual([...p.capabilities], [])
  // 已登记只读工具：isWrite 为 false
  const r = projectToolRequest({ request: { toolName: 'read-file', callId: 'c', arguments: { path: '/w/a' } }, context: CTX })
  assert.equal(r.isWrite, false)
  assert.equal(r.direction, 'read')
})

test('⑤ ★★ 主体里的 `arguments` 是**冻结体那一份**，不是调用方的对象', () => {
  // 破坏性验证发现这条没有用例覆盖（把主体里的 arguments 换成原始参数，一处都没红）。
  // 而它的后果很具体：调用方在投影之后改一下自己手里的对象，
  // 审计里记下的 `subject` 就与那个哈希对不上了——哈希对、参数被换过。
  //
  //   > 一个「主体里那一条 arguments 是调用方对象的引用」的投影，
  //   > 与一个「审批之后调用方改一下手里的对象，审计里记的就是另一份参数」的投影，
  //   > 是同一个东西。
  const mine = { path: 'C:/work/a.txt', mode: 'w' }
  const p = projectToolRequest({ request: { toolName: 'write-file', callId: 'c1', arguments: mine }, context: CTX })
  assert.notEqual(p.subject.arguments, mine, '主体直接持有了调用方的对象')
  assert.equal(Object.isFrozen(p.subject.arguments), true, '主体里的参数没有被冻结')
  assert.equal(Object.isFrozen(p.subject.arguments), true)
  // 改调用方手里的对象，主体与投影都必须纹丝不动
  mine.path = 'C:/etc/passwd'
  assert.equal(p.subject.arguments.path, 'C:/work/a.txt', '调用方改了对象，主体跟着变了')
  assert.equal(p.arguments.path, 'C:/work/a.txt')
  assert.equal(p.canonicalHash, projectToolRequest({ request: { toolName: 'write-file', callId: 'c1', arguments: { path: 'C:/work/a.txt', mode: 'w' } }, context: CTX }).canonicalHash)
  // 主体本身也是冻结的（改不动身份字段）
  assert.throws(() => { p.subject.target = 'C:/etc/passwd' }, TypeError)
})

test('⑤ ★★ patch 层那几行注册的端口，桥都真的提供', () => {
  // 那三行是**声明**，桥是**实现**。两者之间今天只有散文在维持：
  //   > 一个「在文档里写着'三个强制点共用一个桥'」的组合，
  //   > 与一个「三行里有一行注册了桥根本没提供的方法」的组合，是同一个东西——
  //   > 只不过后者的表现是"那一行挂上了，但什么都没发生"。
  const e = TOOL_REQUEST_CHECKED.bridgePorts
  const regs = e.ports.map((p) => p.registration).sort()
  assert.deepEqual(regs, ['ctx.on(\'approval/request\')', 'ctx.on(\'tools/pre-execute\')', 'ctx.tools.guard'].sort())
  assert.deepEqual([...new Set(e.ports.map((p) => p.method))].sort(), ['answerer', 'guard', 'preExecute'])
  assert.deepEqual(e.unmapped, [], '有强制面端口没被映射到桥的方法上')
  // 自检**真的会拦**：少一个方法、或换一个不认识的方法名
  const bridge = createEnforcementBridge({ context: CTX, decide: () => ({ kind: 'allow' }), requestApproval: async () => 'rejected' })
  assert.throws(() => assertBridgeProvidesPorts({ rows: TOOL_REQUEST_ROWS_FIXTURE, bridge: { ...bridge, preExecute: undefined } }), /不提供的端口/)
  assert.throws(() => assertBridgeProvidesPorts({ rows: TOOL_REQUEST_ROWS_FIXTURE, bridge: null }), /不提供的端口/)
  // 一行强制面都没有 → 这一层的检查已经落空，也要抛
  assert.throws(() => assertBridgeProvidesPorts({ rows: [{ id: 'x', registrations: ['config.presets'] }], bridge }), /找不到任何强制面端口行/)
  assert.throws(() => assertBridgeProvidesPorts({ rows: [], bridge }), /找不到任何强制面端口行/)
})

test('⑤ ★ 装载时留下的证据都是**算出来的产物**', () => {
  const e = TOOL_REQUEST_CHECKED
  assert.equal(e.version, TOOL_REQUEST_VERSION)
  assert.match(e.sampleCanonicalHash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(e.projection.agreed, true)
  assert.equal(e.projection.expected, e.sampleCanonicalHash)
  assert.deepEqual(e.unknownTools[0].oneTarget.ok, true)
  assert.equal(GENERIC_TARGET_ARGUMENTS.includes('path'), true)
  assert.equal(CONTEXT_SCOPED_CAPABILITIES.includes('repo:read'), true)
})

// ─────────────────────────────────────────────────────────────────────────────
// PRT-212：`requestApproval` 端口必须拿到 `onConnected` / `signal`（补记的透传）
// ─────────────────────────────────────────────────────────────────────────────

test('★★★ PRT-212：`onConnected` 必须**透传到** `requestApproval`（不是只传投影）', async () => {
  // 这条测的是一个**已经发生过的**缺陷：`request: async (short) => …` 那一层
  // 只把 `projection` 交给了 `requestApproval`，于是上面 `createApprovalAnswerer`
  // 的 `onConnected` **一次都不会被调用**。
  //
  // 后果不是报错，而是**报错的东西**：`runWithPhaseDeadlines` 在连接窗口到期
  // 而端口没自报时，会退化成 `PHASE_UNREPORTED`（"阶段未自报"）而不是
  // `RESPONSE_TIMEOUT`。于是：
  //
  //   > 一个"从不自报已连接"的审批桥，
  //   > 与一个"每次都连不上审批箱"的审批桥，在可用性报告上是同一个东西——
  //   > 只不过前者其实已经把申请放进审批箱了，而且很可能只是没人批。
  //
  // 而这两件事的排查方向完全相反：一个去看 hub 起没起，一个去看谁的申请积压着。
  const seen = []
  const bridge = createEnforcementBridge({
    context: CTX,
    decide: () => ({ kind: 'ask' }),
    // ★ 端口把收到的第二个参数记下来——这正是被漏掉的那一半。
    requestApproval: async (_projection, ports) => {
      seen.push(ports)
      // 一个**真的**会自报已连接的端口该做的事：先自报，再给结局。
      ports?.onConnected?.()
      return 'allowed-once'
    },
  })

  const outcome = await bridge.answerer({
    toolName: 'write-file', callId: 'call-onconnected-1',
    arguments: { path: 'C:\\work\\a.txt', mode: 'w' },
  })
  assert.equal(outcome, 'allowed-once')
  assert.equal(seen.length, 1, '`requestApproval` 没被调用')
  const ports = seen[0]
  assert.equal(typeof ports?.onConnected, 'function',
    '★★ `onConnected` 没有透传下去——审批箱的"连上了"永远报不出来')
  assert.ok('signal' in (ports ?? {}), '`signal` 也应该透传（调用方撤回时端口要能看见）')
  assert.ok('responseTimeoutMs' in (ports ?? {}),
    '`responseTimeoutMs` 也要透传：端口自己的轮询预算要跟调用方的窗口一致，' +
    '否则轮询会比 Run 的期限活得更久')
})

test('★★★ PRT-212：自报了连接才算**响应阶段**超时，不自报就不是', async () => {
  // 上一条证明了回调传下去了；这条证明**传下去有什么用**。
  //
  // 同样一次"端口超时"，两种端口的归因必须不同：
  //   · 自报了已连接 → `RESPONSE_TIMEOUT`（响应阶段）→ 去看谁的申请积压着；
  //   · 没自报       → `PHASE_UNREPORTED`（阶段未自报）→ 端口没告诉我们它在哪一段。
  //
  // 直接在 `createApprovalAnswerer` 这一层测：只有它有 `onOutcome`，
  // 而归因（`code`/`phase`）只在 `onOutcome` 里看得见。
  // 从 `bridge.answerer()` 只能看到"结局是 unavailable"——而两个端口都是 unavailable，
  // 断言它们相等等于什么都没断言。
  const mk = (report) => {
    const seen = []
    const answerer = createApprovalAnswerer({
      request: async (_req) => {
        if (report) _req.onConnected()
        await new Promise((r) => setTimeout(r, 60))
        return 'allowed-once'
      },
      connectTimeoutMs: 5,
      responseTimeoutMs: 25,
      onOutcome: (e) => seen.push(e),
    })
    return { answerer, seen }
  }

  const reported = mk(true)
  const silent = mk(false)
  const [a, b] = await Promise.all([
    reported.answerer({ toolName: 'write-file', callId: 'c1' }),
    silent.answerer({ toolName: 'write-file', callId: 'c2' }),
  ])

  assert.equal(a, 'unavailable')
  assert.equal(b, 'unavailable', '两条路径的**结局**相同——这正是必须看归因的原因')

  const codeOf = (s) => s[0]?.code ?? null
  const phaseOf = (s) => s[0]?.phase ?? null
  assert.equal(codeOf(reported.seen), AVAILABILITY_CODES.RESPONSE_TIMEOUT,
    `自报了连接的端口应该记成响应阶段超时，实际 ${codeOf(reported.seen)}`)
  assert.equal(phaseOf(reported.seen), 'response', '自报了连接就该落在响应阶段')
  assert.equal(reported.seen[0].connected, true)

  assert.notEqual(codeOf(silent.seen), codeOf(reported.seen),
    '★ 不自报与自报的归因**必须不同**——否则"连不上"与"等不到人"就再也分不开了')
  assert.equal(codeOf(silent.seen), AVAILABILITY_CODES.PHASE_UNREPORTED)
  assert.equal(phaseOf(silent.seen), null, '没自报时不该硬安一个阶段')
  assert.equal(silent.seen[0].connected, false)
})

