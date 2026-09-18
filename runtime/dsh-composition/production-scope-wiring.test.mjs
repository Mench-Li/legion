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
  //   而 `tool-request.mjs:731` 在 `null` 上是**放行**。
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
  // ★★★ 2026-09-18 第 19 轮：`executionScope`（PRT-605）与 `pathScope` 同一个形状。
  assert.equal(keys.includes('executionScope'), true,
    `生产装配没有传 executionScope（keys=${JSON.stringify(keys)}）——`
    + 'PRT-605 的接线被去掉了？那会让越权命令重新变成放行')
  // ★★★ 2026-09-18 第 20 轮：`externalApiScope`（PRT-606）——**最后一道**。
  //   至此三道范围检查在生产装配里**形状一致**（都是"键恒在、缺席为 null"）。
  assert.equal(keys.includes('externalApiScope'), true,
    `生产装配没有传 externalApiScope（keys=${JSON.stringify(keys)}）——`
    + 'PRT-606 的接线被去掉了？那会让"一次读权限变成写"重新变成放行')

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
    // ★★★ PRT-605（2026-09-18 第 19 轮加）：命令/网络/MCP 范围。
    //    组合根这一层的生产入参里没有执行面授权表 ⇒ `false`。
    //    这一格**本批之前根本不存在**——而"不存在"比 `false` 更糟：
    //    `false` 至少能让运维问一句"我该配什么"。
    executionScope: false,
    // ★★★ PRT-606（2026-09-18 第 20 轮加）：外部 API 读/写范围。
    //    组合根这一层的生产入参里没有外部 API 授权表 ⇒ `false`。
    //    它**独立于相邻两格**：三格是三份不同的配置。
    externalApiScope: false,
    whitelist: false,
    policy: true,
    approval: true,
    // ★★ F-21 第二半（2026-09-18 加）：反馈面。组合根这一层的生产入参里
    //    **没有**连接器登记表，所以它是 `false`——而这一格存在的意义正是
    //    让"没装"**读得出来**（本批之前这一格**根本不存在**，
    //    于是"接了判定面、反馈面没装"在读数上与"全接好了"同形）。
    connectorFeedback: false,
    // ★★★ F-21 **第一半**（2026-09-18 加）：判定面。
    //
    //    同样 `false`，同样**不是"漏了"**——生产组合根这一层没有连接器登记表。
    //    它必须与上面那一格**分开报**：一个"反馈面装了、判定面没装"的强制面，
    //    与一个"连接器失败被记下来了、但记下来之后谁也不看"的强制面，
    //    在只有一格的读数里是同一个东西。
    connectorJudgment: false,
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

test('①c ★★★ 同一个组合根，env 里配上执行面授权表 ⇒ `executionScope` 翻成 true，且**真的会拦人**', async () => {
  // ★ 与 ①b 完全同一个形状，换到 PRT-605 那一条上。
  //   少了它，① 那个 `executionScope: false` 可能只是"这一格恒 false"——
  //   而一个恒 false 的读数与一个正确报出"没配"的读数，在 ① 的断言下是同一条绿。
  //
  //   ★★ 而"报 true"还不够：本批之前的教训正是**"那一格对了"与"这一道真的会拦人"
  //      被读成同一件事**。所以这条一路走到 `preExecute`，看真实裁决。
  const { installEnforcementRoot, resetEnforcementRoot } = await import('./root.mjs')
  const { executionScopePortFromEnv, EXECUTION_SCOPE_PORT_ENV_KEY } = await import('./execution-scope-port.mjs')
  const env = {
    TEAM_HUB_URL: 'http://hub.invalid:8787',
    LEGION_ACTOR: 'alice',
    LEGION_SCOPE: 'space-1',
    LEGION_ENFORCEMENT_ACTION: 'write',
    LEGION_CWD: 'C:/work',
    [EXECUTION_SCOPE_PORT_ENV_KEY]: JSON.stringify({ command: { programs: ['git'] } }),
  }
  const execScope = executionScopePortFromEnv({ env })
  assert.equal(execScope.state, 'configured', '配了却没有被解析出来')

  resetEnforcementRoot()
  const installed = installEnforcementRoot({
    env,
    decide: () => ({ kind: 'allow' }),
    createRequestApproval: () => (async () => 'rejected'),
    pathScope: null,
    executionScope: execScope.port,
  })
  assert.equal(installed.ok, true, `${installed.code} ${installed.message}`)
  const surfaces = installed.root.enforcementSurfaces()
  assert.equal(surfaces.executionScope, true,
    '配了执行面授权表却仍报 false——① 那条"没配"的读数就不能用来判断了')
  // ★ 而路径范围**仍然**是 false：两格是**独立**的读数。
  //   一个"两道范围检查共用一个布尔"的实现，会让"只配了一道"读成"两道都配了"。
  assert.equal(surfaces.pathScope, false,
    '只配了执行面却把 pathScope 也报成 true——两格必须独立')

  // ★★ 真实裁决：同一个组合根造出的桥，越权命令必须被拒。
  const bridge = installed.root.bridge
  if (bridge !== undefined) {
    const denyVerdict = await bridge.preExecute({
      name: 'run-command', callId: 'c1', arguments: { command: ['rm', '-rf', '/'] },
    })
    assert.equal(denyVerdict.kind, 'deny',
      `越权命令被放行了：${JSON.stringify(denyVerdict)}——组合根"接上了"就只是接了个摆设`)
    assert.match(denyVerdict.reason, /执行面越界/)
    const allowVerdict = await bridge.preExecute({
      name: 'run-command', callId: 'c2', arguments: { command: ['git', 'status'] },
    })
    assert.equal(allowVerdict.kind, 'allow',
      `授权表里的命令被拒了——那这个端口就是在"全拒"：${allowVerdict.reason}`)
  }
  resetEnforcementRoot()
})

test('①d ★★★ 同一个组合根，env 里配上外部 API 授权表 ⇒ `externalApiScope` 翻成 true，且**真的会拦人**', async () => {
  // ★ 与 ①b/①c 完全同一个形状，换到 PRT-606 那一条上。三道范围检查至此
  //   **各有一条**"配了就翻 true、且真的会拦人"的读数。
  const { installEnforcementRoot, resetEnforcementRoot } = await import('./root.mjs')
  const { externalApiScopePortFromEnv, EXTERNAL_API_SCOPE_PORT_ENV_KEY } =
    await import('./external-api-scope-port.mjs')
  const env = {
    TEAM_HUB_URL: 'http://hub.invalid:8787',
    LEGION_ACTOR: 'alice',
    LEGION_SCOPE: 'space-1',
    LEGION_ENFORCEMENT_ACTION: 'write',
    LEGION_CWD: 'C:/work',
    [EXTERNAL_API_SCOPE_PORT_ENV_KEY]: JSON.stringify({
      endpoints: [{ host: 'api.example.com', pattern: '/api/items/{id}', effects: ['read'], idempotent: true }],
    }),
  }
  const apiScope = externalApiScopePortFromEnv({ env })
  assert.equal(apiScope.state, 'configured', '配了却没有被解析出来')

  resetEnforcementRoot()
  const installed = installEnforcementRoot({
    env,
    decide: () => ({ kind: 'allow' }),
    createRequestApproval: () => (async () => 'rejected'),
    pathScope: null,
    externalApiScope: apiScope.port,
  })
  assert.equal(installed.ok, true, `${installed.code} ${installed.message}`)
  const surfaces = installed.root.enforcementSurfaces()
  assert.equal(surfaces.externalApiScope, true,
    '配了外部 API 授权表却仍报 false——① 那条"没配"的读数就不能用来判断了')
  // ★ 而另外两道**仍然**是 false：三格是**独立**的读数。
  assert.equal(surfaces.pathScope, false, '只配了外部 API 却把 pathScope 也报成 true——三格必须独立')
  assert.equal(surfaces.executionScope, false, '只配了外部 API 却把 executionScope 也报成 true——三格必须独立')

  // ★★ 真实裁决：同一个组合根造出的桥，未被授权的端点必须被拒。
  const bridge = installed.root.bridge
  if (bridge !== undefined) {
    const denyVerdict = await bridge.preExecute({
      name: 'call-api', callId: 'c1',
      arguments: { url: 'https://api.example.com/api/other/1' },
    })
    assert.equal(denyVerdict.kind, 'deny',
      `未被授权的外部 API 端点被放行了：${JSON.stringify(denyVerdict)}——`
      + '组合根"接上了"就只是接了个摆设')
    assert.match(denyVerdict.reason, /外部 API 越界/)
    // ★ 授权表里的端点放行。少了这条，这个端口可能在"全拒"。
    const allowVerdict = await bridge.preExecute({
      name: 'call-api', callId: 'c2',
      arguments: { url: 'https://api.example.com/api/items/1' },
    })
    assert.equal(allowVerdict.kind, 'allow',
      `授权表里的端点被拒了——那这个端口就是在"全拒"：${allowVerdict.reason}`)
  }
  resetEnforcementRoot()
})

test('② ★★★ PRT-604/605/606 三道都接了；而 `whitelist` **有位置却没人给值**', () => {
  // ★★★ 2026-09-18 第 20 轮：这一条**第三次**改了要钉的东西，而且三次都按它自己的指示改。
  //
  //   版本史：
  //     · 初版钉 `executionScope` / `externalApiScope` **都不在**桥的参数表里；
  //     · 第 19 轮（PRT-605 接上）→ 转成钉 `externalApiScope` 不在，
  //       并在失败消息里逐字写着"请把 PRT-606 的台账状态、docs 里的记账、
  //       以及本套件的 ①③ 一起更新"；
  //     · 第 20 轮（PRT-606 接上）→ 就是现在这一次。
  //
  //   ⇒ 三道范围检查**全部**接了。而这条判据**没有变成空断言**，也**没有被删掉**：
  //     它换到了同一族里**仍然成立**的那个形状上——`whitelist`。
  //
  //   > 一条判据在它守的东西被修好之后**不该消失**，它该指向下一件同类的事——
  //   > 否则"修好了"与"这条判据本来就是空的"在覆盖率报告里长得一样。
  //
  //   ★ 而 `whitelist` 与前三道**不是同一个形状**，这一点值得写清楚：
  //     前三道是"**桥里没有位置**"（连一格 `false` 都读不出来），
  //     `whitelist` 是"**位置在、而生产装配从不给它值**"——它在
  //     `enforcementSurfaces()` 里已经有一格 `false`，所以这个缺口**读得出来**，
  //     只是没有任何一处会去问"谁该给它值"。
  //
  //     > 一个"没有位置的能力"与一个"有位置而没人给值的能力"，
  //     > 在**这一次**的读数上是 `false` 与 `false`——只不过前者连"我该配什么"
  //     > 都问不出来，而后者问得出来却**没有任何人**在问。
  const src = readFileSync(TOOL_REQUEST, 'utf8')
  const m = /export function createEnforcementBridge\(\{([\s\S]*?)\n\}\)/.exec(src)
  assert.notEqual(m, null, 'tool-request.mjs 里找不到 createEnforcementBridge 的参数表——锚点没了')
  const params = [...m[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*[=,]/gm)].map((x) => x[1])
  assert.ok(params.includes('pathScope'),
    `参数表解析失败（没读到 pathScope）：${JSON.stringify(params)}`)
  // ★★ 三道范围检查**现在都是正向断言**，不再是"它们不该在"。
  for (const wired of ['pathScope', 'executionScope', 'externalApiScope']) {
    assert.equal(params.includes(wired), true,
      `PRT 的范围端口 ${wired} 不见了。★ 这不可能是"回滚"——本套件 ① 与`
      + '对应的 *-port.test.mjs 都指着它；先查是不是参数被改名了')
  }
  // ★ 而 `whitelist`（PRT-603）是这一族里**仍然没接**的那一个。
  assert.equal(params.includes('whitelist'), true,
    '载具：`whitelist` 必须在参数表里——本条的结论是"**有位置**而没人给值"，'
    + '不是"没有位置"。若它连参数都没有了，本条要重写成另一件事')

  // 行为读数：强制面的键集里三道范围**都在**（键集是一份契约）。
  const surfaces = createEnforcementBridge({ context: CTX }).enforcementSurfaces()
  // ★ 2026-09-18 第 19 轮：键集 7 → 8（`executionScope`）；
  //   第 20 轮：8 → **9**（`externalApiScope`）。
  assert.deepEqual(Object.keys(surfaces).sort(),
    ['approval', 'connectorFeedback', 'connectorJudgment',
      'executionScope', 'externalApiScope', 'hardFloor', 'pathScope', 'policy', 'whitelist'],
    '强制面的键集变了——这个键集是**契约**，不是便利方法')
  // ★ 反向对照：默认造出来的桥**全都没接**（`null` ⇒ false）。
  //   少了这条，上面那个键集断言无法区分"这一格报了 true"与"这一格恒 true"。
  assert.equal(surfaces.executionScope, false, '没传执行面端口 ⇒ 必须是 false（没接 ≠ 接了个空的）')
  assert.equal(surfaces.externalApiScope, false, '没传外部 API 端口 ⇒ 必须是 false（同上）')
  assert.equal(surfaces.connectorFeedback, false, '没传 listener ⇒ 必须是 false（没接 ≠ 接了个空的）')
  assert.equal(surfaces.connectorJudgment, false, '没传判定端口 ⇒ 必须是 false')
  // ★★ 而 `whitelist` 在**生产装配**里同样是 `false`——它不是"桥没接"，
  //    是"装配那一侧从来不给它值"。这一格读得出来，却没有任何门禁会问它。
  assert.equal(surfaces.whitelist, false, '岗位白名单今天仍然没接（PRT-603 那一族的剩余项）')
  const { keys } = productionRootInputs()
  assert.equal(keys.includes('whitelist'), false,
    '生产装配竟然传了 whitelist ⇒ 这一族的最后一个缺口被关了。'
    + '★ 那是好事——请把本条**再换一个对象**（或明确写成"这一族已全接"），'
    + '而不是把它删掉；同时更新 docs 里"岗位白名单未接生产"的记账')
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

test('③b ★★★ PRT-605 的后果是真的：同一路越界命令，接了执行面端口就拒、没接就通过', async () => {
  // ★ 与 ③ 同一个形状，换到 PRT-605 那一条上。少了它，"executionScope 接上了"
  //   只是"`enforcementSurfaces()` 里多了一格"——而那一格与"这一道真的会拦人"
  //   是两件事（本项目反复撞到的正是这两件事被读成同一件）。
  //
  //   这一条的**前提**必须是真的越界：授权表只许 `git status`，
  //   而这次调用起的是 `rm`。
  const { executionScopePortFromEnv } = await import('./execution-scope-port.mjs')
  const env = {
    LEGION_EXECUTION_SCOPE: JSON.stringify({
      command: { programs: ['git'] },
    }),
  }
  const scope = executionScopePortFromEnv({ env })
  assert.equal(scope.state, 'configured', '配了却没有被解析出来')

  // `run-command` **是登记过的**工具，能力集 = `['command:exec','process:spawn']`
  //   （`tool-capability.mjs:327`）⇒ 按能力查表就落进 `command` 那一类。
  //   ★ 未登记工具走的是**另一条**路（按参数证据反推），
  //     由 `scope-facts.test.mjs` ② 单独立据；这里要证的是**能力驱动**那条路。
  const execution = {
    name: 'run-command', callId: 'c1',
    arguments: { command: ['rm', '-rf', '/'] },
  }

  // ① 没接端口 —— 就是生产在本批之前的形状。
  const bare = createEnforcementBridge({ context: CTX, decide: () => ({ kind: 'allow' }) })
  const bareVerdict = await bare.preExecute(execution)
  assert.equal(bareVerdict.kind, 'allow',
    '没接 executionScope 时竟然拒绝了——那么"没接"至少是 fail closed 的，'
    + '本套件的 ① 就该换个说法（这也会是个好消息）')

  // ② 接上端口 —— 同一个调用立刻被拒，而且理由是**这一道**给的。
  const wired = createEnforcementBridge({
    context: CTX,
    executionScope: scope.port,
    decide: () => ({ kind: 'allow' }),
  })
  const wiredVerdict = await wired.preExecute(execution)
  assert.equal(wiredVerdict.kind, 'deny', '接了执行面端口反而放行——端口没被用上')
  assert.match(wiredVerdict.reason, /执行面越界/,
    `拒绝理由必须写明是执行面那一道（不是路径、不是策略）：${wiredVerdict.reason}`)
  assert.match(wiredVerdict.reason, /exec-scope-program-not-allowed/,
    `理由里要带判定器的码，值班的人才知道改哪张表：${wiredVerdict.reason}`)

  // ③ guard 那一层同样复核（spec §6.6 line 449：两处都查）。
  const guardReason = wired.guard(execution)
  assert.ok(typeof guardReason === 'string', 'guard 没有复核执行面范围')
  assert.match(guardReason, /执行面越界/)

  // ④ ★ 前提对照（反向）：**授权表之内**的命令必须照旧放行。
  //    少了它，② 可能只是"这个端口对什么都拒"。
  const okExecution = {
    name: 'run-command', callId: 'c2',
    arguments: { command: ['git', 'status'] },
  }
  const okVerdict = await wired.preExecute(okExecution)
  assert.equal(okVerdict.kind, 'allow',
    `授权表里的命令被拒了——那这个端口就是在"全拒"，② 证明不了任何事：${okVerdict.reason}`)
})

test('③d ★★★ PRT-606 的后果是真的：同一次未被授权的调用，接了外部 API 端口就拒、没接就通过', async () => {
  // ★ 与 ③/③b 同一个形状，换到 PRT-606 上——三道范围检查至此**各有一条**
  //   "没接就放行"的读数。这是最要紧的一类断言：
  //
  //   > 一个「端口没接上、而没接上时检查自动放行」的组合根，
  //   > 与一个「那道范围限制没有生效」的组合根，是同一个东西。
  const { externalApiScopePortFromEnv } = await import('./external-api-scope-port.mjs')
  const scope = externalApiScopePortFromEnv({
    env: {
      LEGION_EXTERNAL_API_SCOPE: JSON.stringify({
        endpoints: [{ host: 'api.example.com', pattern: '/api/items/{id}', effects: ['read'], idempotent: true }],
      }),
    },
  })
  assert.equal(scope.state, 'configured', '配了却没有被解析出来')

  // `call-api` 是登记过的工具，能力集含 `external-api:read`/`external-api:write`
  //   ⇒ 按能力查表落进 `external-api` 那一类。
  const execution = {
    name: 'call-api', callId: 'c1',
    arguments: { url: 'https://evil.example.com/api/items/1' },
  }

  // ① 没接端口 —— 生产在本批之前的形状。
  const bare = createEnforcementBridge({ context: CTX, decide: () => ({ kind: 'allow' }) })
  const bareVerdict = await bare.preExecute(execution)
  assert.equal(bareVerdict.kind, 'allow',
    '没接 externalApiScope 时竟然拒绝了——那么"没接"至少是 fail closed 的，'
    + '本套件的 ① 就该换个说法（这也会是个好消息）')

  // ② 接上端口 —— 同一个调用立刻被拒，而且理由是**这一道**给的。
  const wired = createEnforcementBridge({
    context: CTX,
    externalApiScope: scope.port,
    decide: () => ({ kind: 'allow' }),
  })
  const wiredVerdict = await wired.preExecute(execution)
  assert.equal(wiredVerdict.kind, 'deny', '接了外部 API 端口反而放行——端口没被用上')
  assert.match(wiredVerdict.reason, /外部 API 越界/,
    `拒绝理由必须写明是外部 API 那一道（不是路径、不是执行面、不是策略）：${wiredVerdict.reason}`)
  assert.match(wiredVerdict.reason, /api-scope-endpoint-not-granted/,
    `理由里要带判定器的码，值班的人才知道改哪张表：${wiredVerdict.reason}`)

  // ③ guard 那一层同样复核（spec §6.6 line 449：两处都查）。
  const guardReason = wired.guard(execution)
  assert.ok(typeof guardReason === 'string', 'guard 没有复核外部 API 范围')
  assert.match(guardReason, /外部 API 越界/)

  // ④ ★ 前提对照（反向）：**授权表之内**的调用必须照旧放行。
  //    少了它，② 可能只是"这个端口对什么都拒"。
  const okVerdict = await wired.preExecute({
    name: 'call-api', callId: 'c2',
    arguments: { url: 'https://api.example.com/api/items/42' },
  })
  assert.equal(okVerdict.kind, 'allow',
    `授权表里的端点被拒了——那这个端口就是在"全拒"，② 证明不了任何事：${okVerdict.reason}`)

  // ⑤ ★★ 而三道**互不串台**：同一个桥接了外部 API 端口，一条**越权命令**
  //    仍然要放行（执行面没接），一条**越界路径**也仍然要放行（路径范围没接）。
  //    少了这条，"接一道就等于三道都生效"与"三道各自独立"在①-④下同形。
  const cmdVerdict = await wired.preExecute({
    name: 'run-command', callId: 'c3', arguments: { command: ['rm', '-rf', '/'] },
  })
  assert.equal(cmdVerdict.kind, 'allow',
    '接了外部 API 端口却把越权命令也拦了——三道的端口**不能**互相顶替')
})

test('③c ★★★ MCP 那一条**未接**，而它必须是**具名**的拒绝，不是"名字有歧义"', async () => {
  // ★★ 本批刻意**没有**接 MCP 那一条（理由见 `execution-scope-port.mjs` 文件头 ③：
  //    DSH 的公开名有两个 `__`，`splitMcpTool` 要求恰好一个；而"哪些 MCP 工具可用"
  //    在生产里**已经有一个权威**——F-21 的连接器登记表）。
  //
  //    这一条钉的是"未接"这件事**读得出来**：
  //    一个"未接"与一个"检查不通过"，在最终 `deny` 上是同一个读数——
  //    只不过前者的理由里写着"未接"，而后者写着"不在授权列表之内"。
  const { executionScopePortFromEnv, EXECUTION_SCOPE_PORT_CODES } = await import('./execution-scope-port.mjs')

  // ① 授权表里**没有** `mcp` 段 ⇒ 这一条是**真的在判**（不需要拆名字）。
  const noMcp = executionScopePortFromEnv({
    env: { LEGION_EXECUTION_SCOPE: JSON.stringify({ command: { programs: ['git'] } }) },
  })
  const v1 = noMcp.port({
    scopeFacts: { version: 'legion/scope-facts@1', kinds: ['mcp'], mcp: { tool: 'mcp__github__list_issues', from: 'toolName' } },
  })
  assert.equal(v1.allowed, false)
  assert.equal(v1.code, 'exec-scope-mcp-server-denied', `理由必须是"没有 MCP 授权"，而不是别的：${v1.code}`)

  // ② 授权表里**有** `mcp` 段 ⇒ **未接**，而且要具名。
  const withMcp = executionScopePortFromEnv({
    env: {
      LEGION_EXECUTION_SCOPE: JSON.stringify({
        mcp: { servers: [{ server: 'github', tools: ['list_issues'] }] },
      }),
    },
  })
  const v2 = withMcp.port({
    scopeFacts: { version: 'legion/scope-facts@1', kinds: ['mcp'], mcp: { tool: 'mcp__github__list_issues', from: 'toolName' } },
  })
  assert.equal(v2.allowed, false, 'MCP 绝不能被静默放行')
  assert.equal(v2.code, EXECUTION_SCOPE_PORT_CODES.MCP_LIMB_UNWIRED,
    `这一条必须是"未接"这个码，而不是判定器的某个码——`
    + `两者都拒，但一个说"去裁决"，一个说"改授权表"：${v2.code}`)
  assert.match(v2.reason, /连接器登记表/, '理由必须点名权威在哪，否则下一个人只会去改授权表')
})

test('⑥ ★★ 生产装配的**唯一**入口是组合根插件行（别处造桥就不在生产链上）', () => {
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
