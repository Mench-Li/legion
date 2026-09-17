// runtime/dsh-composition/run-identity.test.mjs
// ============================================================================
// PRT-214 缺口②：授权身份（`scope` / `taskId` / `cwd`）按 **Run** 生效。
//
// 这一套盯的是那条**只有多空间部署才看得见**的性质：
//
//   > 一个「用进程级身份服务所有 Run」的实现，
//   > 与一个「每次 Run 各带各的空间身份」的实现，
//   > 在只有一个空间的那些用例里是同一个东西——
//   > 只不过前者会把甲空间的事记在乙空间名下，而且**不报错**。
//
// 所以本套件里最要紧的几条都是**成对**的：一个 Run 用甲空间、另一个用乙空间，
// 断言两边的投影**真的不同**；再拿"没有覆盖时两边必须相同"作反面控制。
// 少了反面控制，"两边不同"可能只是因为别的东西变了。
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  RUN_IDENTITY_CODES,
  RUN_IDENTITY_PAYLOAD_KEYS,
  RUN_IDENTITY_STATES,
  RUN_IDENTITY_WIRE_VERSION,
  RUN_IDENTITY_CONTRACT_CHECKED,
  applyIdentityOverlay,
  readRunIdentity,
} from '../contracts/run-identity.mjs'
import {
  RUN_IDENTITY_CHILD_OPTION_KEY,
  RUN_IDENTITY_INSTALL_CHECKED,
  RUN_IDENTITY_RUN_OPTION_KEY,
  createRunIdentityInstallation,
  identityOverlayForExecution,
  installRunIdentityIntoAgent,
  readRunIdentityPortPayload,
  runIdentityCarrierOf,
  runIdentityInstalledOn,
  runIdentityOverlayOf,
  withRunIdentityCarrier,
} from './run-identity.mjs'
import { createEnforcementBridge, projectToolRequest } from './tool-request.mjs'

/** 进程级上下文——**故意**写成 `legion`/`task-1`，与下面每一次 Run 的覆盖都不同。 */
const PROC_CTX = Object.freeze({
  scope: 'legion', actor: 'employee-1', action: 'file.write', taskId: 'task-1',
  cwd: 'C:/work', platform: 'win32',
})

const identityOf = (scope, over = {}) => ({
  version: RUN_IDENTITY_WIRE_VERSION, scope, ...over,
})

/** 造一个假 Agent：装身份的落点只需要**对象身份**，不需要 ctx 缝合点。 */
const fakeAgent = (id) => ({ id })

const execOf = (agent, callId = 'c1', over = {}) => ({
  name: 'write-file', callId, arguments: { path: 'C:/work/a.txt', mode: 'w' }, agent, ...over,
})

// ════════════════════════════════════════════════════════════ 契约：三种处境

test('① ★ 缺席 / null / 带一份载荷：三种必须互相可分', () => {
  // 缺席 = 没人给；null = 有人打算说但什么也没说出来（那是生产者的写坏）；
  // 空对象 = 给了、但缺 scope。三者混成一个"没有覆盖"会让一次写坏看起来像一次缺席。
  const absent = readRunIdentity(undefined)
  assert.equal(absent.state, RUN_IDENTITY_STATES.ABSENT)
  assert.equal(absent.overlay, null)
  assert.equal(absent.code, RUN_IDENTITY_CODES.NOT_SUPPLIED)

  const nul = readRunIdentity(null)
  assert.equal(nul.state, RUN_IDENTITY_STATES.REFUSED, 'null 被读成了缺席')
  assert.equal(nul.code, RUN_IDENTITY_CODES.NOT_OBJECT)

  const empty = readRunIdentity({ version: RUN_IDENTITY_WIRE_VERSION })
  assert.equal(empty.state, RUN_IDENTITY_STATES.REFUSED)
  assert.equal(empty.code, RUN_IDENTITY_CODES.SCOPE_REQUIRED)
})

test('② ★★★ `actor` / `action` **不被接受**（不是"可选"）', async () => {
  // 这一条是本模块最重要的一条安全判断：RunRequest 里**没有**能权威地assert
  // "这次由别人负责"的字段，所以接受按 Run 覆盖 actor 等于让审计归属由请求方自填。
  //
  //   > 一个"允许 Run 自带 actor"的载荷，
  //   > 与一个"审计里的责任人可以由图省事的调用方指定"的实现，是同一个东西。
  for (const key of ['actor', 'action']) {
    const r = readRunIdentity({ version: RUN_IDENTITY_WIRE_VERSION, scope: 'gf001', [key]: 'someone-else' })
    assert.equal(r.state, RUN_IDENTITY_STATES.REFUSED, `${key} 竟然被接受了`)
    assert.equal(r.code, RUN_IDENTITY_CODES.UNKNOWN_KEY)
    assert.match(r.message, /自填/, `${key} 的拒绝理由没有说清为什么`)
  }
  // 反向锚：`actor`/`action` 不在**允许键**表里。少了这一条，
  // 上面的用例可能只是因为"未知键检查"碰巧生效，而不是因为它们被明确排除。
  assert.equal(RUN_IDENTITY_PAYLOAD_KEYS.includes('actor'), false)
  assert.equal(RUN_IDENTITY_PAYLOAD_KEYS.includes('action'), false)
})

test('③ 版本不认识 / 未知键 / scope 写坏：都是**具名拒绝**，不是回落', () => {
  const badVer = readRunIdentity({ version: 99, scope: 's' })
  assert.equal(badVer.code, RUN_IDENTITY_CODES.BAD_VERSION)
  const unknown = readRunIdentity({ version: RUN_IDENTITY_WIRE_VERSION, scope: 's', nope: 1 })
  assert.equal(unknown.code, RUN_IDENTITY_CODES.UNKNOWN_KEY)
  const blank = readRunIdentity({ version: RUN_IDENTITY_WIRE_VERSION, scope: '   ' })
  assert.equal(blank.code, RUN_IDENTITY_CODES.SCOPE_REQUIRED)
  // ★ 写坏的 scope **不许**回落成进程级：那正是本次要消灭的错标，
  //   而回落会让"一份想覆盖却写坏了空间名的载荷"看起来成功了。
  assert.match(blank.message, /不回落/)
  for (const r of [badVer, unknown, blank]) assert.equal(r.overlay, null)
})

test('④ `null` 的 taskId 是**合法覆盖**（"这次没有任务"必须能表达）', () => {
  // 进程级的 taskId 本来就允许是 null（`root.mjs:321`：进程级装配时常常还没有任务）。
  // 于是"这次 Run 明确没有任务"必须能说出来，不能被读成"没给这个字段"而沿用上一个任务。
  const r = readRunIdentity(identityOf('s', { taskId: null }))
  assert.equal(r.state, RUN_IDENTITY_STATES.INSTALLED)
  assert.equal(r.overlay.taskId, null)
  assert.equal(Object.prototype.hasOwnProperty.call(r.overlay, 'taskId'), true)
  // 而"根本没提 taskId"时它**不在** overlay 里——两种形状必须不同。
  assert.equal(Object.prototype.hasOwnProperty.call(readRunIdentity(identityOf('s')).overlay, 'taskId'), false)
})

test('⑤ ★ 叠加只碰白名单字段，`actor` / `action` 一定来自进程级', () => {
  const got = applyIdentityOverlay(PROC_CTX, { scope: 'gf001', taskId: 'T-9', cwd: 'D:/x', actor: '伪造', action: '伪造' })
  assert.equal(got.scope, 'gf001')
  assert.equal(got.taskId, 'T-9')
  assert.equal(got.cwd, 'D:/x')
  assert.equal(got.actor, PROC_CTX.actor, 'actor 被覆盖了')
  assert.equal(got.action, PROC_CTX.action, 'action 被覆盖了')
  // 原对象不被改（投影读的是基线，改它会污染其它 Run）
  assert.equal(PROC_CTX.scope, 'legion')
  // 没有覆盖时返回**原样**那个对象（不是一份拷贝：拷贝会让"有没有覆盖"变得不可判定）
  assert.equal(applyIdentityOverlay(PROC_CTX, null), PROC_CTX)
})

// ════════════════════════════════════════════════════════════ 端口载荷

test('⑥ 端口载荷：absent 的 overlay 必须是 `null`，不能被合成身份冒名顶替', () => {
  const absent = createRunIdentityInstallation({ state: RUN_IDENTITY_STATES.ABSENT })
  assert.equal(absent.state, RUN_IDENTITY_STATES.ABSENT)
  assert.equal(absent.overlay, null,
    'absent 被塞了一份覆盖——那会让"没人给"与"给的就是进程级"变成同一个读数')
  // 说 absent 却带 identity：两件事必须分得开
  assert.equal(readRunIdentityPortPayload({ state: RUN_IDENTITY_STATES.ABSENT, identity: {} }).code,
    'RUN_IDENTITY_INSTALL_UNKNOWN_STATE')
  // 说 installed 却带一份解释不通的 identity：**拒绝**，不是当成缺席
  const broken = readRunIdentityPortPayload({ state: RUN_IDENTITY_STATES.INSTALLED, identity: { version: 1 } })
  assert.equal(broken.state, RUN_IDENTITY_STATES.REFUSED)
  assert.match(broken.message, /解释不通/)
})

// ════════════════════════════════════════════════════════════ 按 Agent 安装

test('⑦ ★★ 两个 Agent、两份身份：装上去的互不串台', () => {
  const a = fakeAgent('agent-a')
  const b = fakeAgent('agent-b')
  installRunIdentityIntoAgent({ agent: a, installation: createRunIdentityInstallation({ state: RUN_IDENTITY_STATES.INSTALLED, identity: identityOf('gf001') }) })
  installRunIdentityIntoAgent({ agent: b, installation: createRunIdentityInstallation({ state: RUN_IDENTITY_STATES.INSTALLED, identity: identityOf('ozon') }) })

  assert.equal(runIdentityOverlayOf(a).scope, 'gf001')
  assert.equal(runIdentityOverlayOf(b).scope, 'ozon')
  assert.equal(runIdentityInstalledOn(a), true)
  // 没装过的 Agent：`undefined`（不是空对象）
  assert.equal(runIdentityOverlayOf(fakeAgent('agent-c')), undefined)
})

test('⑧ ★ 重复安装返回**第一次**那份（后装的不许覆盖先装的）', () => {
  //   > 一个"后装的覆盖先装的"的登记簿，
  //   > 与一个"并发两个 Run 互相改对方身份"的实现，是同一个东西——
  //   > 只不过前者在串行跑的时候完全正常。
  const a = fakeAgent('agent-dup')
  const first = installRunIdentityIntoAgent({ agent: a, installation: createRunIdentityInstallation({ state: RUN_IDENTITY_STATES.INSTALLED, identity: identityOf('first') }) })
  const second = installRunIdentityIntoAgent({ agent: a, installation: createRunIdentityInstallation({ state: RUN_IDENTITY_STATES.INSTALLED, identity: identityOf('second') }) })
  assert.equal(first.overlay.scope, 'first')
  assert.equal(second.overlay.scope, 'first', '第二次安装覆盖了第一次')
  assert.equal(runIdentityOverlayOf(a).scope, 'first')
})

test('⑨ 装不上拒绝一切之外的东西：非 Agent 直接抛，不给半个登记', () => {
  for (const bad of [null, undefined, 42, 'agent']) {
    assert.throws(() => installRunIdentityIntoAgent({
      agent: bad,
      installation: createRunIdentityInstallation({ state: RUN_IDENTITY_STATES.ABSENT }),
    }), (e) => e.code === 'RUN_IDENTITY_INSTALL_NOT_AN_AGENT', `agent=${String(bad)} 竟然装上了`)
  }
})

test('⑩ `dispose()` 之后覆盖消失（这件事必须是可逆的，否则 Run 之间会串）', () => {
  const a = fakeAgent('agent-dispose')
  const reading = installRunIdentityIntoAgent({
    agent: a,
    installation: createRunIdentityInstallation({ state: RUN_IDENTITY_STATES.INSTALLED, identity: identityOf('gf001') }),
  })
  assert.equal(runIdentityOverlayOf(a).scope, 'gf001')
  reading.dispose()
  assert.equal(runIdentityOverlayOf(a), undefined)
  assert.equal(runIdentityInstalledOn(a), false)
})

// ════════════════════════════════════════════════════════════ 载体

test('⑪ 载体走 `agentOptions`，且**不改**调用方的 options 对象', () => {
  const opts = { provider: 'p', agentOptions: { keep: 1 } }
  const carried = withRunIdentityCarrier(opts, { state: 'installed' })
  assert.equal(carried.agentOptions[RUN_IDENTITY_CHILD_OPTION_KEY].state, 'installed')
  assert.equal(carried.agentOptions.keep, 1, '合并时丢了原有 agentOptions')
  assert.equal(opts.agentOptions[RUN_IDENTITY_CHILD_OPTION_KEY], undefined,
    '改了调用方的 options：端口读到的与适配器交出去的必须能分别断言')
  // 从**已创建**的 Agent 读回来（引擎把 agentOptions 摊到 agent.options 上）
  assert.equal(runIdentityCarrierOf({ id: 'x', options: carried.agentOptions }).state, 'installed')
  assert.equal(runIdentityCarrierOf({ id: 'x' }), undefined)
})

test('⑫ `identityOverlayForExecution`：没有 agent 就**不猜**（返回 undefined）', () => {
  // 全局 guard 那条路径上 `exec.agent` 是 undefined（`tools/src/index.ts:1128`）。
  // 那时必须回落进程级，而不是"找一个最近装过的身份"。
  for (const exec of [{}, { name: 'write-file' }, null, undefined, { agent: null }]) {
    assert.equal(identityOverlayForExecution(exec), undefined, `exec=${JSON.stringify(exec)} 竟然取到了覆盖`)
  }
})

// ════════════════════════════════════════════════════════════ 桥：真正的落点

test('⑬ ★★★ 两个空间的两次调用 → 两个 `scope`、两个 `canonicalHash`', () => {
  // 本套件的核心。`scope` 进 `canonicalOperationHash`，也就是审批绑定与审计归属。
  const a = fakeAgent('bridge-a')
  const b = fakeAgent('bridge-b')
  installRunIdentityIntoAgent({ agent: a, installation: createRunIdentityInstallation({ state: RUN_IDENTITY_STATES.INSTALLED, identity: identityOf('gf001', { taskId: 'T-gf' }) }) })
  installRunIdentityIntoAgent({ agent: b, installation: createRunIdentityInstallation({ state: RUN_IDENTITY_STATES.INSTALLED, identity: identityOf('ozon', { taskId: 'T-oz' }) }) })

  const bridge = createEnforcementBridge({ context: PROC_CTX, decide: () => ({ kind: 'allow' }) })
  const pa = bridge.projectionFor(execOf(a, 'call-a')).projection
  const pb = bridge.projectionFor(execOf(b, 'call-b')).projection

  assert.equal(pa.subject.scope, 'gf001')
  assert.equal(pb.subject.scope, 'ozon')
  assert.equal(pa.subject.taskId, 'T-gf')
  assert.equal(pb.subject.taskId, 'T-oz')
  // ★ 归属真的分开了：两个空间的同一次工具调用**不能**共用一个授权哈希。
  assert.notEqual(pa.canonicalHash, pb.canonicalHash,
    '两个空间的同一次调用算出了同一个 canonicalHash——审批绑定与审计归属又合到一起了')
  // 而 actor/action 仍然来自进程级（⑫ 那条安全判断的落点）
  assert.equal(pa.subject.actor, PROC_CTX.actor)
  assert.equal(pb.subject.action, PROC_CTX.action)
})

test('⑭ ★★★ 反面控制：**没有**身份覆盖时，两次调用必须完全相同', () => {
  // 少了这一条，⑬ 的"两边不同"可能只是因为工具名/参数不同，而不是身份在起作用。
  const a = fakeAgent('ctrl-a')
  const b = fakeAgent('ctrl-b')
  const bridge = createEnforcementBridge({ context: PROC_CTX, decide: () => ({ kind: 'allow' }) })
  const pa = bridge.projectionFor(execOf(a, 'call-a')).projection
  const pb = bridge.projectionFor(execOf(b, 'call-b')).projection
  assert.equal(pa.subject.scope, PROC_CTX.scope, '没装身份却改了 scope')
  assert.equal(pb.subject.scope, PROC_CTX.scope)
  // 两次调用的 callId 不同 ⇒ 哈希本来就该不同；这里比的是**授权主体**那几项。
  assert.deepEqual(
    { ...pa.subject, callId: null, arguments: null },
    { ...pb.subject, callId: null, arguments: null },
    '没有任何身份覆盖时，两个 Agent 的授权主体竟然不同',
  )
})

test('⑮ ★★ 同一个 Agent 上的两次调用用**同一份**身份；`cwd` 覆盖真的改变目标规范化', () => {
  const a = fakeAgent('same-a')
  installRunIdentityIntoAgent({ agent: a, installation: createRunIdentityInstallation({ state: RUN_IDENTITY_STATES.INSTALLED, identity: identityOf('software', { cwd: 'D:/proj' }) }) })
  const bridge = createEnforcementBridge({ context: PROC_CTX, decide: () => ({ kind: 'allow' }) })
  const p1 = bridge.projectionFor(execOf(a, 'c1')).projection
  const p2 = bridge.projectionFor(execOf(a, 'c2')).projection
  assert.equal(p1.subject.scope, 'software')
  assert.equal(p2.subject.scope, 'software', '同一个 Agent 的第二次调用换了空间')

  // ★ `cwd` **不在**授权主体里（`CANONICAL_OP_KEYS` 没有它）——它是**目标规范化**的基准。
  //   所以"cwd 覆盖生效了"不能靠读 `subject.cwd` 断言，要靠一条**相对路径**解出来的
  //   绝对目标来读。这正是"一个只看 subject 的用例会漏掉 cwd 覆盖"的地方。
  const rel = { name: 'write-file', callId: 'rel-1', arguments: { path: 'a.txt', mode: 'w' }, agent: a }
  const pr = bridge.projectionFor(rel).projection
  // `canonicalizePath` 在 win32 上会折叠大小写，所以这里按大小写不敏感比对。
  assert.match(pr.canonicalTarget, /^d:\/proj\//i,
    `相对路径没有按 Run 的 cwd 规范化：${pr.canonicalTarget}`)

  // 反面控制：进程级的 cwd 是 `C:/work`，同一个相对路径必须解到**另一处**。
  // 少了这一条，"解到 D:/proj"可能只是因为进程级 cwd 本来就是它。
  const noIdentity = createEnforcementBridge({ context: PROC_CTX, decide: () => ({ kind: 'allow' }) })
  const pProc = noIdentity.projectionFor({ ...rel, agent: fakeAgent('no-identity') }).projection
  assert.match(pProc.canonicalTarget, /^c:\/work\//i, `进程级 cwd 没有生效：${pProc.canonicalTarget}`)
  assert.notEqual(pr.canonicalTarget, pProc.canonicalTarget)
})

test('⑯ ★ `identityFor` 抛错时回落进程级，**不**让整次调用失败', () => {
  // 一个坏掉的查表函数没有任何能推导出"这次该用哪个身份"的信息。
  // 身份缺失不会让强全面少一个面（见模块文件头），所以回落是对的处置。
  const bridge = createEnforcementBridge({
    context: PROC_CTX,
    decide: () => ({ kind: 'allow' }),
    identityFor: () => { throw new Error('登记簿坏了') },
  })
  const p = bridge.projectionFor(execOf(fakeAgent('x'), 'c1')).projection
  assert.equal(p.subject.scope, PROC_CTX.scope)
})

test('⑰ ★ pre-execute 与 guard 对**同一次**调用读到同一份身份（不许在两道闸之间漂移）', async () => {
  // spec §6.8 要求四个强制点共用同一份投影。身份按 Run 解析之后，
  // "同一个 callId 在 pre-execute 与 guard 上解析出两个不同空间"是一种新的漂移。
  const a = fakeAgent('drift-a')
  installRunIdentityIntoAgent({ agent: a, installation: createRunIdentityInstallation({ state: RUN_IDENTITY_STATES.INSTALLED, identity: identityOf('gf001') }) })
  const seen = []
  const bridge = createEnforcementBridge({
    context: PROC_CTX,
    decide: (projection) => { seen.push(projection.subject.scope); return { kind: 'allow' } },
    onDecision: () => {},
  })
  const exec = execOf(a, 'drift-1')
  await bridge.preExecute(exec)
  bridge.guard(exec)
  assert.deepEqual(seen, ['gf001'], `策略门看到的空间不是这一次 Run 的：${JSON.stringify(seen)}`)
  // 同一个 callId 第二次投影必须命中缓存，且 scope 不变
  const again = bridge.projectionFor(exec)
  assert.equal(again.remembered, true)
  assert.equal(again.projection.subject.scope, 'gf001')
})

test('⑱ ★ 投影出来的主体**没有**被覆盖的键（`actor`/`action` 不许从载荷进来）', () => {
  // 端到端把 ② 那条安全判断验一遍：即使有人绕过契约直接往登记簿里塞一份带 actor 的
  // overlay，叠加白名单也不让它进授权主体。
  const a = fakeAgent('wl-a')
  installRunIdentityIntoAgent({
    agent: a,
    installation: { state: RUN_IDENTITY_STATES.INSTALLED, code: null, message: null, overlay: { scope: 'gf001', actor: '伪造的', action: '伪造的' } },
  })
  const bridge = createEnforcementBridge({ context: PROC_CTX, decide: () => ({ kind: 'allow' }) })
  const p = bridge.projectionFor(execOf(a, 'c1')).projection
  assert.equal(p.subject.scope, 'gf001')
  assert.equal(p.subject.actor, PROC_CTX.actor, 'actor 从 overlay 进到了授权主体')
  assert.equal(p.subject.action, PROC_CTX.action, 'action 从 overlay 进到了授权主体')
})

// ════════════════════════════════════════════════════════════ 装载期自检

test('⑲ 装载期自检：算出来的产物，不是一个布尔', () => {
  assert.equal(RUN_IDENTITY_CONTRACT_CHECKED.absentState, 'absent')
  assert.equal(RUN_IDENTITY_CONTRACT_CHECKED.nullIsRefused, true)
  assert.equal(RUN_IDENTITY_CONTRACT_CHECKED.minimalOverlayScope, 's')
  assert.equal(RUN_IDENTITY_CONTRACT_CHECKED.actorRefused, RUN_IDENTITY_CODES.UNKNOWN_KEY)
  assert.equal(RUN_IDENTITY_CONTRACT_CHECKED.actionRefused, RUN_IDENTITY_CODES.UNKNOWN_KEY)
  assert.equal(RUN_IDENTITY_CONTRACT_CHECKED.nullTaskIdOverlay, null)
  assert.deepEqual([...RUN_IDENTITY_CONTRACT_CHECKED.overlayKeys], ['scope'])
  assert.equal(RUN_IDENTITY_CONTRACT_CHECKED.overlaidScope, 'run')
  assert.equal(RUN_IDENTITY_CONTRACT_CHECKED.overlayKeepsActor, 'a')
  assert.equal(RUN_IDENTITY_INSTALL_CHECKED.absentOverlayIsNull, true)
  assert.equal(RUN_IDENTITY_INSTALL_CHECKED.installedOverlayScope, 's')
  assert.equal(RUN_IDENTITY_INSTALL_CHECKED.brokenInstalledCode, 'RUN_IDENTITY_INSTALL_UNKNOWN_STATE')
})

test('⑳ `projectToolRequest` 本身不认识身份（叠加是桥的职责，不是投影的）', () => {
  // 投影是纯函数：给它什么上下文它就用什么。身份解析在桥那一层，
  // 于是"投影对不对"与"身份从哪来"可以分别验。
  const p = projectToolRequest({ request: { toolName: 'write-file', callId: 'c', arguments: { path: 'C:/work/a.txt' } }, context: PROC_CTX })
  assert.equal(p.subject.scope, PROC_CTX.scope)
})
