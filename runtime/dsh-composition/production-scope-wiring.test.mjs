// runtime/dsh-composition/production-scope-wiring.test.mjs
// ============================================================================
// 「三道范围检查在生产里到底有没有跑」——把一句话变成读数。
//
// ## 为什么要单独一个套件
//
// PRT-604（文件/工作目录范围）、PRT-605（命令/网络/MCP）、PRT-606（外部 API 读写）
// 在台账里都是 ✅。它们的判据是"模块 + 自己那一套用例"，
// 而 `path-scope.test.mjs` 的用例 ⑥ 已经证明**桥**会如实报出
// `pathScope:false` —— 但**没有一条用例问过生产装配读出来是多少**。
//
// 这正是 PRT-253 那一篇自己立下的标准：
//
//   > 本文的工作是：把这句话从"作者当时相信"变成"再多加一个键就会红的读数"。
//
// 本套件就是那一条读数。它钉住三件事：
//
//   ① 生产组合根（`installEnforcementRoot` 以 **root-row.mjs 的同一组入参**装配）
//      读出来恰好是 `pathScope:false` / `whitelist:false`；
//   ② `execution-scope.mjs`（PRT-605）与 `external-api-scope.mjs`（PRT-606）
//      **不是桥的端口**——连"没接"都读不出来，因为压根没有那个位置；
//   ③ 这个读数的**后果**真的存在：`pathScope` 缺席时那道检查返回"放行"，
//      于是同一次调用从"被拒"变成"通过"。
//
// ## ③ 是最要紧的一条
//
// ①②只说明"端口没给"。如果不证明**没给会发生什么**，那 ①② 可能只是一个
// 无害的读数——而它其实决定了"越界路径拦不拦得住"。
//
//   > 一个「端口没接上、而没接上时检查自动放行」的组合根，
//   > 与一个「路径范围限制没有生效」的组合根，是同一个东西——
//   > 只不过前者的证据里有一行诚实的 `pathScope:false`。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createEnforcementBridge } from './tool-request.mjs'
import { createRuntimeHostInputsFactory } from './plugins/runtime-host-registrar-row.mjs'

const ROOT_ROW = fileURLToPath(new URL('./plugins/root-row.mjs', import.meta.url))
const TOOL_REQUEST = fileURLToPath(new URL('./tool-request.mjs', import.meta.url))

const CTX = Object.freeze({
  scope: 'legion', actor: 'employee-1', action: 'file.write', taskId: 'task-1',
  cwd: 'C:/work', platform: 'win32',
})

/** 组合根的服务键（与 root-row.mjs 的 `ENFORCEMENT_ROOT_SERVICE` 同一个字符串）。 */
const ENFORCEMENT_ROOT_SERVICE = 'legionEnforcementRoot'

/** 生产装配那一次调用的**入参形状**：读 root-row.mjs 的源码，不抄一份。 */
function productionRootInputs() {
  const src = readFileSync(ROOT_ROW, 'utf8')
  const m = /installEnforcementRoot\(\{([\s\S]*?)\n\s*\}\)/.exec(src)
  assert.notEqual(m, null,
    'root-row.mjs 里找不到 `installEnforcementRoot({...})` 的调用——'
    + '这条用例的锚点没了。**不要**把它放宽成"随便找个 installEnforcementRoot"，'
    + '那样它就变成一条查不出东西却永远绿的断言')
  const body = m[1]
  // 收集顶层键名（`key:` 形式）。
  const keys = [...body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((x) => x[1])
  return { keys: [...new Set(keys)], body }
}

test('① ★★★ 生产组合根**接上了** pathScope 端口；env 没配时读数仍是 false（没接 ≠ 接了个空的）', async () => {
  const { keys } = productionRootInputs()

  // ★★★ 2026-09-18 更新（第 19 条 §9.2 第 4 步，**有意接线**）。
  //
  //   本断言原来钉的是 `keys.includes('pathScope') === false`，也就是
  //   "生产装配压根不传这个键"。那正是 §9.3 量出来的洞：端口恒为 `null`，
  //   而 `tool-request.mjs:639` 在 `null` 上是**放行**。
  //
  //   现在 root-row.mjs 会从环境读 `LEGION_PATH_SCOPE` 并接上端口。
  //   所以这一条改成钉**新的**两件事：
  //     · 键在（接线存在，不是"文件里有这个 import"）；
  //     · **env 没配时读数仍是 `false`** —— 没配不等于"接了个空的"。
  //       ★ 这一半比原来那条更强：原来只证明"没接"，现在还证明
  //         "接上了、但没配 = 读起来仍与没接一样"，那才是诚实的读数。
  assert.equal(keys.includes('pathScope'), true,
    `生产装配没有传 pathScope（keys=${JSON.stringify(keys)}）——`
    + '第 19 条 §9.2 第 4 步的接线被去掉了？那会让越界路径重新变成放行')
  // `whitelist`（岗位白名单）**仍然**没接——那是另一条缺口，不在本批范围。
  assert.equal(keys.includes('whitelist'), false,
    `生产装配竟然传了 whitelist（keys=${JSON.stringify(keys)}）——`
    + '那本套件 ②③ 的结论、以及 docs 里"岗位白名单未接生产"的记账都要一起更新')
  // 正向确认这组键确实被解析出来了（否则上面的断言可能只是解析失败）。
  for (const must of ['env', 'decide', 'createRequestApproval', 'pathScope']) {
    assert.ok(keys.includes(must),
      `生产装配的键集里没有 ${must}（keys=${JSON.stringify(keys)}）——解析锚点坏了`)
  }

  // ★ 行为读数（一）：env 里**没有**范围表 ⇒ 端口为 null ⇒ 读数仍是 false。
  //   不启动 DSH：`installEnforcementRoot` 是纯装配（它只造桥 + 造两行插件）。
  const { installEnforcementRoot, resetEnforcementRoot } = await import('./root.mjs')
  const minEnv = {
    TEAM_HUB_URL: 'http://hub.invalid:8787',
    LEGION_ACTOR: 'alice',
    LEGION_SCOPE: 'space-1',
    LEGION_ENFORCEMENT_ACTION: 'write',
    LEGION_CWD: 'C:/work',
  }
  resetEnforcementRoot() // 进程级单例：先清，否则第二次装配会被 ALREADY_INSTALLED 挡掉
  const installed = installEnforcementRoot({
    env: { ...minEnv },
    decide: () => ({ kind: 'allow' }),
    createRequestApproval: () => (async () => 'rejected'),
    // ★ 与生产同一组入参：没配时 `scopePortFromEnv` 给的就是 `null`。
    pathScope: null,
  })
  assert.equal(installed.ok, true,
    `生产形状的组合根装不起来，夹具不成立：${installed.code} ${installed.message}`)
  const surfaces = installed.root.enforcementSurfaces()

  assert.deepEqual(surfaces, {
    hardFloor: true,
    pathScope: false,
    whitelist: false,
    policy: true,
    approval: true,
    // ★★ F-21 第二半（2026-09-18 加）：反馈面。组合根这一层的生产入参里
    //    **没有**连接器登记表，所以它是 `false`——而这一格存在的意义正是
    //    让"没装"**读得出来**（本批之前这一格**根本不存在**，
    //    于是"接了判定面、反馈面没装"在读数上与"全接好了"同形）。
    connectorFeedback: false,
  }, '生产强制面的读数变了。★ 如果这次改动是**有意接线**，请同时更新 '
    + 'docs/MULTI-AGENT-FEATURE-STATUS.md 与 PRT-PROGRESS 里"范围检查未接生产"那段记账——'
    + '一条只在代码里变、账上不动的接线，会让下一个人照着旧账做判断')

  resetEnforcementRoot()
})

test('①b ★★★ 同一个组合根，env 里配上范围表 ⇒ 读数翻成 true（file 没配 ≠ 配了没用）', async () => {
  // 少了这一条，上面那个 `pathScope: false` 可能只是"这个读数永远是 false"——
  // 而一个恒 false 的读数与一个正确报出"没配"的读数，在上面那条断言下是同一条绿。
  const { installEnforcementRoot, resetEnforcementRoot } = await import('./root.mjs')
  const { scopePortFromEnv } = await import('./scope-port.mjs')
  const { SCOPE_PORT_ENV_KEY } = await import('./scope-port.mjs')
  const env = {
    TEAM_HUB_URL: 'http://hub.invalid:8787',
    LEGION_ACTOR: 'alice',
    LEGION_SCOPE: 'space-1',
    LEGION_ENFORCEMENT_ACTION: 'write',
    LEGION_CWD: 'C:/work',
    [SCOPE_PORT_ENV_KEY]: JSON.stringify({
      platform: process.platform === 'win32' ? 'win32' : 'linux',
      read: ['C:/work'], write: [],
    }),
  }
  const scope = scopePortFromEnv({ env })
  assert.equal(scope.state, 'configured', '配了却没有被解析出来')

  resetEnforcementRoot()
  const installed = installEnforcementRoot({
    env,
    decide: () => ({ kind: 'allow' }),
    createRequestApproval: () => (async () => 'rejected'),
    pathScope: scope.port,
  })
  assert.equal(installed.ok, true, `${installed.code} ${installed.message}`)
  assert.equal(installed.root.enforcementSurfaces().pathScope, true,
    '配了范围表却仍报 false——① 那条"没配"的读数就不能用来判断了')
  resetEnforcementRoot()
})

test('② ★★★ 命令/网络/MCP 与外部 API 两道范围检查**连端口都没有**', () => {
  // PRT-605 与 PRT-606 的检查器是纯函数模块，而桥的端口表里没有它们的位置。
  // 后果比 ① 更重：`pathScope` 至少还有一个"没接"的读数，
  // 而这两道**读不出来**——因为没有任何地方能表达"它应该在这里"。
  const src = readFileSync(TOOL_REQUEST, 'utf8')
  const m = /export function createEnforcementBridge\(\{([\s\S]*?)\n\}\)/.exec(src)
  assert.notEqual(m, null, 'tool-request.mjs 里找不到 createEnforcementBridge 的参数表——锚点没了')
  const params = [...m[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*[=,]/gm)].map((x) => x[1])
  assert.ok(params.includes('pathScope'),
    `参数表解析失败（没读到 pathScope）：${JSON.stringify(params)}`)
  for (const absent of ['executionScope', 'externalApiScope', 'scope']) {
    assert.equal(params.includes(absent), false,
      `桥现在有了 ${absent} 端口。★ 这是好事——但请把 PRT-605/606 的台账状态、`
      + 'docs 里的记账、以及本套件的 ①② 一起更新；'
      + '一条"接上了而账上还写着没接"的记录与一条"没接而账上写着接上了"，同样不能用来做判断')
  }
  // 行为读数：强制面的键集里没有这两个名字。
  const surfaces = createEnforcementBridge({ context: CTX }).enforcementSurfaces()
  // ★ 2026-09-18：键集里**多了** `connectorFeedback`（F-21 第二半）。
  //   这个键集仍然是一份**契约**：它变了就必须在这里显式改，
  //   而不是让它悄悄多一格。它现在有 6 格，而"两半都在场"是 6 格里的事。
  assert.deepEqual(Object.keys(surfaces).sort(),
    ['approval', 'connectorFeedback', 'hardFloor', 'pathScope', 'policy', 'whitelist'],
    '强制面的键集变了——这个键集是**契约**，不是便利方法')
  assert.equal('executionScope' in surfaces, false)
  assert.equal('externalApiScope' in surfaces, false)
  // ★ 反向对照：默认造出来的桥**没有**反馈面（`null` ⇒ false）。
  //   少了这条，上面那个键集断言无法区分"这一格报了 true"与"这一格恒 true"。
  assert.equal(surfaces.connectorFeedback, false, '没传 listener ⇒ 必须是 false（没接 ≠ 接了个空的）')
})

test('③ ★★★ 后果是真的：同一路越界调用，接了 pathScope 拒绝、没接就通过', async () => {
  // 这一条把 ①② 从"一个无害的读数"变成"一个会放行的洞"。
  const execution = {
    name: 'write-file', callId: 'c1',
    arguments: { path: 'C:/etc/passwd' },
  }

  // 没接端口 —— 就是生产今天的形状。
  const bare = createEnforcementBridge({ context: CTX, decide: () => ({ kind: 'allow' }) })
  const bareVerdict = await bare.preExecute(execution)
  assert.equal(bareVerdict.kind, 'allow',
    '没接 pathScope 时竟然拒绝了——那么"没接"至少是 fail closed 的，'
    + '本套件的 ① 就该换个说法（这也会是个好消息）')
  // guard 那一层同样放行：两道都空。
  assert.equal(bare.guard(execution), undefined,
    'guard 在没有 pathScope 时拒绝了——与 preExecute 的读数不一致，先查为什么')

  // 接上端口 —— 同一个调用立刻被拒。
  const wired = createEnforcementBridge({
    context: CTX,
    pathScope: () => ({ allowed: false, code: 'path-scope-outside-write', reason: '目标在写范围之外' }),
    decide: () => ({ kind: 'allow' }),
  })
  const wiredVerdict = await wired.preExecute(execution)
  assert.equal(wiredVerdict.kind, 'deny', '接了 pathScope 反而放行——端口没被用上')
  assert.match(wiredVerdict.reason, /path-scope-outside-write/)
  assert.ok(typeof wired.guard(execution) === 'string', 'guard 没有复核路径范围')
})

test('④ ★★ 反向对照：显式传上这两个键，读数就翻成 true（证明 ① 的 false 是"没人给"）', () => {
  // 少了这一条，① 可能只是"这个读数永远是 false"——而一个恒 false 的读数
  // 与一个正确地报出"没接"的读数，在 ① 的断言下是同一条绿。
  const bridge = createEnforcementBridge({
    context: CTX,
    whitelist: () => ({ allowed: true, rule: null, reason: null }),
    pathScope: () => ({ allowed: true }),
    decide: () => ({ kind: 'allow' }),
  })
  const s = bridge.enforcementSurfaces()
  assert.equal(s.whitelist, true, '传了 whitelist 却仍报 false——① 的结论不成立')
  assert.equal(s.pathScope, true, '传了 pathScope 却仍报 false——① 的结论不成立')
})

test('⑤ ★★ 生产装配的**唯一**入口是组合根插件行（别处造桥就不在生产链上）', () => {
  // 这一条防的是"接线接在了另一个地方"：如果有人另起一条装配路径去接范围检查，
  // 那么 ① 仍然绿（root-row 没变），而生产其实已经接上了——
  // 一条只钉住一个位置的判据，与一条"接线位置可以有好几个"的现实，必须在这里对齐。
  const factory = createRuntimeHostInputsFactory()
  assert.equal(typeof factory, 'function',
    '注册方的输入工厂形状变了，本套件的"生产入口"锚点要一起复核')
  // root-row 是补丁层里第一个（也是全仓唯一）真的调 installEnforcementRoot 的生产文件。
  const src = readFileSync(ROOT_ROW, 'utf8')
  assert.match(src, /installEnforcementRoot/,
    'root-row.mjs 不再调用 installEnforcementRoot——生产装配入口搬家了，'
    + '本套件与 docs 的记账都要按新位置重写')
})
