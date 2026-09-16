// team-hub/run-floor.test.mjs
// ============================================================================
// PRT-214 缺口（静态 hard floor 的派生）的判据。
//
// 这一组盯的**不是**"能不能算出一个 {denyTools, denyPathPrefixes}"——
// 那个形状随手就能写出来。它盯的是四件在绿树上看不出差别的事：
//
//   ① ★★★★★ **一个来源**：控制面的 `isHardFloor` 与 DSH 侧能力目录的
//      `hardFloor` 标记取到的是**同一个数组对象**，而权限内核里没有第二份字面量。
//      判据必须落在"来源"上，不能落在"两处今天恰好同名"上——
//      > 一份「两处名单今天恰好同名」的一致性，
//      > 与一份「它们来自同一个来源」的一致性，
//      > 在没有人只改一边的那些日子里是同一个东西。
//   ② ★★★★★ **不认识的工具不能消失**：进下限、判静态拒绝，并带 `known: false`。
//   ③ ★★★★ **不可决定的输入是具名拒绝**，且 `floor` 是 `null` 而不是空数组。
//      > 一个「派生出来的空下限」，与一个「这次没有任何东西该被禁止」，
//      > 在空数组这个读数上是同一个东西——
//      > 只不过前者意味着强制面整段不在，而没有任何人会收到告警。
//   ④ ★★★ **路径前缀安全由构造保证**：存进去的就是 guard 会再算一次的那个值，
//      并且真的拿生产的 `createHardFloorGuard()` / `composePreExecuteFloor()`
//      拦一次越界写入（形状对 ≠ 拦得住）。
//
// ## 诚实边界（★ 本批改过：这条边界自己也搬了一次家）
//
// 上一版这一节写着「**没有任何东西**消费派生出来的下限」——`executor` 只搬
// `{preset, tools}`、契约里没有承载字段。那句话现在**不再成立**：
// `orchestrator/worker/executor.mjs` 有了生产调用方，§⑦ 读它。
//
//   > 一条只写在文件头、而代码已经走了的"边界"，
//   > 与一条不存在的边界，在后来读它的人那里是同一个东西——
//   > 只不过前者会让人以为这个缺口还没人动过。
//
// 所以这里换成**新的**边界，一条也不许省：
//
//   · 接上的是**生产者**，不是"生产已经在保护什么"。派生出来的名单写的是 Legion
//     的**工具名**（`delete-file` …），而 guard 比的是执行面的工具名——§⑦ 最后
//     两条把这个缺口从**生产者真的产出的**那一份上读出来。今天没有任何真实 DSH
//     进程因为一份"从 lease 的权限档位派生出来"的下限拒绝过工具调用：
//     真进程那一对（`runtime/dsh-composition/run-floor-dsh-process.test.mjs`）
//     里的下限仍然是**测试挂上去的**（§⑦ 把它也读了一遍，免得这句话悄悄过期）。
//   · 真 `claim()` 回来的 lease 上**没有** `permissions`，于是今天生产里的每一次
//     Run 都在**派发前**具名拒绝（`run-floor-permissions-missing`）。这条读数由
//     `orchestrator/worker/executor.test.mjs` 的 §⑥ 钉住；本套件只钉"它派得出来"。
//   · `denyPathPrefixes` 是**拒绝名单**。spec line 456 说的"禁止越界路径"
//     若按"工作区之外全都不许"理解，那是一个补集，guard 现在的形状表达不了
//     ——本模块只承载**声明过的**前缀，不假装能算出补集。
//   · 夹具根是空的、且一直是空的：本模块零 IO，"它没写文件"是个读数而不是承诺。
// ============================================================================

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  HARD_FLOOR_CAPABILITIES,
  RUN_FLOOR_DECISION_REASONS,
  RUN_FLOOR_NOTICE_CODES,
  RUN_FLOOR_REFUSAL_CODES,
  RUN_FLOOR_VERSION,
  RunFloorRefusalError,
  assertFloorInstallable,
  deriveRunFloor,
} from './run-floor.mjs'
// 控制面的**生产**判定入口：名单换掉之后它的行为必须跟着变。
import { evaluatePermission } from './permission-engine.mjs'
// 生产 guard 与它的 pre-execute 组合：下限是**给它们**吃的。
import {
  DEFAULT_HARD_FLOOR,
  canonicalizePath,
  composePreExecuteFloor,
  createHardFloorGuard,
} from '../runtime/dsh-composition/enforcement.mjs'
// DSH 侧能力目录：用**真实**的解析口，不写替身目录。
// 一份替我说话的目录，会让"未知工具"这一条变成"我构造的未知工具"。
import {
  CAPABILITY_IDS,
  CAPABILITY_KINDS,
  HARD_FLOOR_CAPABILITIES as FROM_TOOL_CAPABILITY,
  HIGH_RISK_TOOL_NAMES,
  TOOL_CATALOG,
  resolveTool,
} from '../runtime/dsh-composition/tool-capability.mjs'
// 名字空间那一条的**映射读数**住在 employee-preset（`dshToolNamesOf()` 读它）：
// 用例里不抄一份映射——抄一份的用例在映射改了之后仍然绿。
// ★ 名字空间那一半的解析口（本批）也来自这里：`executionDenialFor()` 是**生产实现**，
//   用一个手写替身会让"翻译对了没有"变成自问自答。
import { dshToolNamesOf, executionDenialFor } from '../runtime/dsh-composition/employee-preset.mjs'
// 线上三态与字段名的**唯一**来源。§⑦ 用它读"生产者产出的那一份到底是什么状态"。
import { RUN_FLOOR_STATES, RUN_FLOOR_WIRE_FIELD, readRunFloor } from '../runtime/contracts/run-floor.mjs'
// ★ 生产消费者本身就是**生产者**（PRT-214 缺口①最后那一格）。
//   这里 import 的是**产品模块**而不是替身：替身会让"接上了没有"变成自问自答。
import { deriveRunFloorCarrier, UNSUPPLIED_PERMISSIONS } from '../orchestrator/worker/executor.mjs'

const CODES = RUN_FLOOR_REFUSAL_CODES
const REASONS = RUN_FLOOR_DECISION_REASONS

/** 整棵夹具树。`after()` 一律删掉，**失败时也删**。 */
const ROOT = mkdtempSync(join(tmpdir(), 'legion-run-floor-'))
after(() => { try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* Windows 偶发占用 */ } })

const MODULE_PATH = fileURLToPath(new URL('./run-floor.mjs', import.meta.url))
const PERMISSION_ENGINE_PATH = fileURLToPath(new URL('./permission-engine.mjs', import.meta.url))
const TOOL_CAPABILITY_PATH = fileURLToPath(new URL('../runtime/dsh-composition/tool-capability.mjs', import.meta.url))

const WIN = { cwd: 'C:\\work', platform: 'win32' }

/** 派生一次用的最小合法输入。 */
function derive(overrides) {
  return deriveRunFloor({
    permissions: { preset: 'legion-attended', tools: ['read-file'] },
    resolveTool,
    // ★ 与 `resolveTool` 同一条纪律：默认给**生产实现**，不给替身。
    //   少给这一个口时，任何"必须被禁"的工具都会走"禁不了 ⇒ 具名拒绝"——
    //   那是**正确**的兜底，但它会让本组绝大多数用例落在拒绝那一档，
    //   于是它们断言的东西（名单里有什么）根本走不到。
    resolveExecutionNames: executionDenialFor,
    cwd: WIN.cwd,
    platform: WIN.platform,
    ...overrides,
  })
}

/**
 * 剥掉注释再读**代码**。理由与 `credential-materializer.test.mjs` 同源：
 * 注释里可以（也应该）出现"我不用那份字面量"这类说明，被判的是代码。
 */
function codeOf(path) {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

/** 一条决定在不在。断言"有"而不是"没有"，避免用空集合换绿。 */
function entryFor(result, tool) {
  const found = result.entries.filter((e) => e.tool === tool)
  assert.notDeepEqual(found, [], '决定表里没有「' + tool + '」这一条——它去哪了？')
  return found[0]
}

/** 同一个工具可能有多条决定（允许名单一条、政策声明一条），这条取"拒绝"那一条。 */
function denyEntryFor(result, tool) {
  const found = result.entries.filter((e) => e.tool === tool && e.deny === true)
  assert.notDeepEqual(found, [], '决定表里没有「' + tool + '」的拒绝记录')
  return found[0]
}

// ═══════════════════════════════════════════ ① ★★★★★ 一个来源，不是两份

test('① ★★★★★ 控制面、DSH 侧目录与派生模块取到的是**同一个数组对象**', () => {
  // ★ 本批 1 → 2：`denyTools` 的名字空间从 Legion 能力名改成执行面工具名，
  //   那是一件**改变 guard 行为**的事，不是加了个码。
  assert.equal(RUN_FLOOR_VERSION, 2)
  assert.equal(Object.isFrozen(HARD_FLOOR_CAPABILITIES), true)
  assert.deepEqual([...HARD_FLOOR_CAPABILITIES], ['file:delete', 'repo:push', 'credential:write'])

  // ★ 恒等（===）而不是 deepEqual：deepEqual 对"两份今天恰好相等的名单"也是绿的，
  //   而恒等只在"同一条绑定"上成立。
  assert.equal(FROM_TOOL_CAPABILITY, HARD_FLOOR_CAPABILITIES,
    'tool-capability.mjs 导出的不是 run-floor.mjs 的那一个数组对象——它又自己算了一份')
})

test('① ★★★★★ 权限内核里没有第二份字面量，而且它用**就是**这条绑定（源扫描）', () => {
  const code = codeOf(PERMISSION_ENGINE_PATH)
  // 先证这段提取真的读到了权限内核（否则下面那条"零命中"对空字符串也成立）。
  assert.equal(code.includes('function isHardFloor'), true, '没读到 isHardFloor——下面的零命中不算数')

  const literals = [...code.matchAll(/'(file:delete|repo:push|credential:write)'/g)].map((m) => m[1])
  assert.deepEqual(literals, [],
    'permission-engine.mjs 的代码里出现了硬底线动作名的字面量：那是一份**第二名单**，'
    + '而它只会在有人只改一边的第二天安静地少掉一条')

  assert.match(code, /import\s*\{\s*HARD_FLOOR_CAPABILITIES\s*\}\s*from\s*'\.\/run-floor\.mjs'/)
  assert.match(code, /HARD_FLOOR_CAPABILITIES\.includes\(operation\.action\)/)
})

test('① ★★★★★ 名单里的每一个动作，控制面那道闸都判 hard-floor；不在名单里的不判', () => {
  const rule = [{ id: 'all', mode: 'allow-by-policy' }]
  for (const action of HARD_FLOOR_CAPABILITIES) {
    const r = evaluatePermission({ scope: 's', actor: 'general', action, target: 't' }, rule, { now: 0 })
    assert.equal(r.decision, 'deny', action + ' 没有被控制面判成 hard floor')
    assert.equal(r.reason, 'hard-floor', action + ' 的拒绝理由不是 hard-floor')
  }
  // 反向对照：同一份 allow-by-policy 规则对**不在**名单里的动作必须放行，
  // 否则上面那三条在一个"什么都拒"的实现上也是绿的。
  const ok = evaluatePermission({ scope: 's', actor: 'general', action: 'file:write', target: 't' }, rule, { now: 0 })
  assert.equal(ok.decision, 'allow')
  assert.equal(ok.allowed, true)
})

test('① ★★★★★ DSH 侧：目录里恰好三个工具带硬底线，且各自对应名单里的一个能力', () => {
  const hardFloored = Object.values(TOOL_CATALOG).filter((t) => t.hardFloor === true).map((t) => t.name).sort()
  assert.deepEqual(hardFloored, ['delete-file', 'git-push', 'write-secret'])

  const pairs = [['delete-file', 'file:delete'], ['git-push', 'repo:push'], ['write-secret', 'credential:write']]
  for (const [tool, capability] of pairs) {
    assert.equal(HARD_FLOOR_CAPABILITIES.includes(capability), true, capability + ' 不在共享名单里')
    assert.equal(resolveTool(tool).hardFloor, true, tool + ' 在目录里不是硬底线')
    assert.equal(resolveTool(tool).capabilities.includes(capability), true, tool + ' 没声明 ' + capability)
    // 工具名到能力的映射真的是**目录**给的，不是本套件按名字猜的
    assert.equal(CAPABILITY_KINDS[capability].hardFloor, true)
  }
  // 目录里非 hard-floor 的能力一律为 false：这条防的是"整表变成 true"——
  // 那种实现会让上面三条照样绿。
  for (const id of CAPABILITY_IDS) {
    const expected = HARD_FLOOR_CAPABILITIES.includes(id)
    assert.equal(CAPABILITY_KINDS[id].hardFloor, expected, id + ' 的 hardFloor 与共享名单不一致')
  }
  assert.equal(CAPABILITY_IDS.length > HARD_FLOOR_CAPABILITIES.length, true)
})

// ═══════════════════════════════════════════ ② ★★★★★ 未知工具 fail closed

test('② ★★★★★ 不认识的工具**进下限**：决定带 known:false 与 notice，然后因为"禁不了"整次拒绝', () => {
  const result = derive({
    permissions: { preset: 'legion-attended', tools: ['read-file', 'ghost-tool'] },
    runId: 'run-ghost',
  })

  // ★ 本批之前这里断言的是 `derived === true` 且 `denyTools === ['ghost-tool']`。
  //   那个读数**看起来**是"未知工具被禁了"，实际上 `denyTools` 里放的是一个
  //   **执行面认不出的名字**——guard 比的是 `execution.name`，于是它谁也没拦到。
  //
  //     > 一个"未知工具进了名单、而名单里的名字在执行面上不存在"的下限，
  //     > 与一个"未知工具从来没进过名单"的下限，
  //     > 在下一次真调用时是同一个东西——只不过前者的摘要看起来在防。
  //
  //   所以现在这一档是**禁不了 ⇒ 整次 Run 具名拒绝**（与 hosted 同一个码，
  //   修法不同，靠 `why` 分）。
  assert.equal(result.derived, false)
  assert.equal(result.floor, null, '禁不了的时候 floor 必须是 null，不许补一个空下限')
  assert.deepEqual([...result.refusals.map((r) => r.code)], [CODES.HARD_FLOOR_NOT_ENFORCEABLE_AT_PLANE])
  assert.equal(result.refusals[0].why, 'unrouted', '修法不是接线而是登记路由表，`why` 必须说出来')
  assert.equal(result.refusals[0].tool, 'ghost-tool')

  // 决定本身**仍然在**，而且仍然带着 `known:false`——修法是登记工具，不是放宽名单。
  const ghost = entryFor(result, 'ghost-tool')
  assert.equal(ghost.deny, true)
  assert.equal(ghost.reason, REASONS.UNKNOWN_TOOL)
  assert.equal(ghost.known, false, '决定里必须留下 known:false——修法是登记工具，不是放宽名单')
  assert.equal(ghost.executionNames, undefined,
    '禁不了的那一条**不许**补一个 `executionNames: []`：空数组读起来是"这里没有要禁的名字"，'
    + '而事实是"这里有一个禁不掉的东西"')

  assert.equal(result.notices.filter((n) => n.code === RUN_FLOOR_NOTICE_CODES.UNKNOWN_TOOL_DENIED).length, 1)
  assert.equal(result.notices[0].tool, 'ghost-tool')
  assert.equal(String(result.notices[0].message).includes('ghost-tool'), true)

  // 反向对照：同一份输入里那个**认得出**的工具不进下限。
  assert.equal(entryFor(result, 'read-file').deny, false)
})

test('② ★★★★ 高风险的**已知**工具不进静态下限：目录说它审批可解除', () => {
  // `git-push` 是可表达的硬底线（→ 执行面的 `bash`/`pwsh`），
  // 而 `post-external-api` / `run-command` 是审批可解除的——两者必须分得开。
  const result = derive({
    permissions: { preset: 'legion-attended', tools: ['git-push', 'post-external-api', 'run-command'] },
  })
  assert.equal(result.derived, true)
  // ★ 名字空间：进去的是**执行面**的名字，不是 `git-push` 这个能力名。
  assert.deepEqual([...result.floor.denyTools], ['bash', 'pwsh'])

  // `external-api:write` 的风险是 critical，但目录说 hardFloor 是 false——
  // 即"审批可以解除"。把它也塞进静态下限，等于把"问一下"改成"永远不行"。
  const post = entryFor(result, 'post-external-api')
  assert.equal(post.deny, false)
  assert.equal(post.reason, REASONS.APPROVAL_LIFTABLE)
  assert.equal(post.requiresApproval, true)
  assert.equal(resolveTool('post-external-api').risk, 'critical')
  assert.equal(resolveTool('post-external-api').hardFloor, false)

  // 而 hard-floor 的那一条，理由、命中的能力、以及**落到哪些执行面名字**都要能读出来。
  const push = entryFor(result, 'git-push')
  assert.equal(push.reason, REASONS.HARD_FLOOR_CAPABILITY)
  assert.equal(push.capability, 'repo:push')
  assert.deepEqual([...push.executionNames], ['bash', 'pwsh'])
})

test('② ★★★★★ 硬底线里**禁不了**的那两个（hosted）：整次 Run 具名拒绝，且说清修法', () => {
  // `HARD_FLOOR_CAPABILITIES` 三个里有两个（`file:delete` / `credential:write`）
  // 由 Legion 宿主平面提供，执行面上**没有名字**可以让 guard 去拒。
  //
  //   > 一份"三个硬底线里能表达的那个被翻译了、另两个被静默跳过"的下限，
  //   > 与一份"三个都覆盖了"的下限，在 `denyTools` 的长度上是同一个读数——
  //   > 只不过前者漏掉的恰好是"删文件回不来"与"写密钥会让已录入的凭证无法恢复"。
  for (const [tool, capability] of [['delete-file', 'file:delete'], ['write-secret', 'credential:write']]) {
    const result = derive({ permissions: { preset: 'legion-attended', tools: ['read-file', tool] } })
    assert.equal(result.derived, false, tool + ' 在这一层禁不了，却派生出下限来了')
    assert.equal(result.floor, null)
    assert.deepEqual([...result.refusals.map((r) => r.code)],
      [CODES.HARD_FLOOR_NOT_ENFORCEABLE_AT_PLANE], tool + ' 的拒绝码不对')
    assert.equal(result.refusals[0].why, 'hosted', '修法是接线（给宿主平面接一个强制面），`why` 必须说出来')
    assert.equal(result.refusals[0].tool, tool)
    // 决定本身仍然在，而且仍然指着那个硬底线能力——被拒的是"装不出下限"，不是"这条决定不成立"。
    assert.equal(entryFor(result, tool).capability, capability)
  }

  // 反向对照：把 hosted 的那一条从允许名单里去掉，同一份输入就能派生了。
  // 少了这条，上面两轮在一个"什么都拒"的实现上也是绿的。
  const ok = derive({ permissions: { preset: 'legion-attended', tools: ['read-file', 'git-status'] } })
  assert.equal(ok.derived, true)
  assert.deepEqual([...ok.floor.denyTools], [])
})

// ═══════════════════════════════════════ ③ ★★★★ 不可决定的输入 → 具名拒绝

test('③ ★★★★ 读不出来的输入是具名拒绝，`floor` 是 null（不是空数组）', () => {
  const cases = [
    ['档位整个不在', { permissions: null }, CODES.PERMISSIONS_MISSING],
    ['tools 不是数组', { permissions: { preset: 'p', tools: 'read-file' } }, CODES.TOOLS_NOT_A_LIST],
    ['tools 缺席', { permissions: { preset: 'p' } }, CODES.TOOLS_NOT_A_LIST],
    ['tools 里有一条不是字符串', { permissions: { preset: 'p', tools: ['read-file', 42] } }, CODES.TOOL_NAME_INVALID],
    ['有工具要判却没注入解析口', { permissions: { preset: 'p', tools: ['read-file'] }, resolveTool: undefined }, CODES.RESOLVER_MISSING],
    ['解析口不是函数', { permissions: { preset: 'p', tools: ['read-file'] }, resolveTool: 'yes' }, CODES.RESOLVER_MISSING],
    ['解析口抛了', { permissions: { preset: 'p', tools: ['read-file'] }, resolveTool: () => { throw new Error('目录炸了') } }, CODES.RESOLVER_THREW],
    ['解析结果没有 known', { permissions: { preset: 'p', tools: ['read-file'] }, resolveTool: () => ({ capabilities: [] }) }, CODES.RESOLVER_CONTRACT],
    ['解析结果的 capabilities 不是数组', { permissions: { preset: 'p', tools: ['read-file'] }, resolveTool: () => ({ known: true }) }, CODES.RESOLVER_CONTRACT],
    ['解析结果不是对象', { permissions: { preset: 'p', tools: ['read-file'] }, resolveTool: () => null }, CODES.RESOLVER_CONTRACT],
    ['declaredDenyTools 不是数组', { declaredDenyTools: 'delete-file' }, CODES.DECLARED_DENY_TOOLS_INVALID],
    ['declaredDenyTools 里有一条是数字', { declaredDenyTools: [42] }, CODES.DECLARED_DENY_TOOLS_INVALID],
    ['declaredDenyPathPrefixes 不是数组', { declaredDenyPathPrefixes: 'C:\\work' }, CODES.DECLARED_PATH_PREFIXES_INVALID],
  ]

  for (const [label, overrides, code] of cases) {
    const result = derive({ ...overrides })
    assert.equal(result.derived, false, label + '：居然派生出下限来了')
    assert.equal(result.floor, null, label + '：不可派生时 floor 必须是 null')
    assert.equal(result.refusals.length > 0, true, label + '：一条拒绝都没记')
    assert.equal(result.refusals[0].code, code, label + '：拒绝码不对（得到 ' + result.refusals[0].code + '）')
    assert.equal(typeof result.refusals[0].message, 'string')

    let caught = null
    try { assertFloorInstallable(result) } catch (e) { caught = e }
    assert.notEqual(caught, null, label + '：assertFloorInstallable 没有拦住')
    assert.equal(caught instanceof RunFloorRefusalError, true, label + '：拒绝不是具名的')
    assert.equal(caught.code, code, label + '：错误的 code 读不出是哪一个输入的问题')
    assert.equal(caught.refusals.length > 0, true)
  }

  // 什么参数都不给的默认调用：权限档位整个不在，同样是具名拒绝。
  const bare = deriveRunFloor()
  assert.equal(bare.derived, false)
  assert.equal(bare.floor, null)
  assert.equal(bare.refusals[0].code, CODES.PERMISSIONS_MISSING)

  // 一个 null 下限不能被 guard 当成"空闸"吃下去：它会当场抛，
  // 而不是安静地变成一道不拦任何东西的 guard。
  assert.throws(() => createHardFloorGuard(null), TypeError)
})

test('③ ★★★ 合法的空下限与"从未派生"必须分得开', () => {
  // 允许名单是空的 = "这个员工不能用任何工具"：一份**派生完成**的空下限。
  const empty = deriveRunFloor({ permissions: { preset: 'p', tools: [] }, resolveTool })
  assert.equal(empty.derived, true)
  assert.deepEqual([...empty.refusals], [])
  assert.notEqual(empty.floor, null)
  assert.deepEqual([...empty.floor.denyTools], [])
  assert.deepEqual([...empty.floor.denyPathPrefixes], [])

  // 同形的一边：档位读不出来。
  const refused = deriveRunFloor({ permissions: undefined, resolveTool })
  assert.equal(refused.derived, false)
  assert.equal(refused.floor, null)
  assert.equal(refused.refusals[0].code, CODES.PERMISSIONS_MISSING)

  // ★ 两个读数在"空数组"上长得一样，所以判据必须落在**别的**地方：
  //   一个 `derived` 位，以及"未派生时 floor 是 null"这个结构性事实。
  assert.notEqual(empty.derived, refused.derived)
  assert.throws(() => assertFloorInstallable(refused), RunFloorRefusalError)
  assert.equal(assertFloorInstallable(empty), empty.floor)

  // 组合面默认那一份是空下限——"挂了一道空闸"与"没有这道闸"在组合树上同形，
  // 这正是本模块存在的理由。
  assert.deepEqual([...DEFAULT_HARD_FLOOR.denyTools], [])
  assert.deepEqual([...DEFAULT_HARD_FLOOR.denyPathPrefixes], [])
})

// ═══════════════════════════════════════ ④ ★★★★ 路径前缀安全由构造保证

test('④ ★★★★ 相对 / 非法 / 非绝对的前缀是具名拒绝，不按 cwd 猜一个基准', () => {
  const cases = [
    ['相对路径', ['relative/dir'], CODES.PATH_PREFIX_RELATIVE],
    ['盘符相对（C:foo）', ['C:drive-relative'], CODES.PATH_PREFIX_RELATIVE],
    ['空串', [''], CODES.PATH_PREFIX_NOT_A_STRING],
    ['数字', [42], CODES.PATH_PREFIX_NOT_A_STRING],
    ['null', [null], CODES.PATH_PREFIX_NOT_A_STRING],
    ['只空白', ['   '], CODES.PATH_PREFIX_NOT_A_STRING],
  ]
  for (const [label, prefixes, code] of cases) {
    const result = derive({ declaredDenyPathPrefixes: prefixes })
    assert.equal(result.derived, false, label + '：居然接受了')
    assert.equal(result.floor, null, label)
    assert.equal(result.refusals[0].code, code, label + '（得到 ' + result.refusals[0].code + '）')
  }
})

test('④ ★★★★ 存进去的前缀就是 guard 会再算一次的那个值，而且真的拦得住越界写入', () => {
  const declared = 'C:\\Work\\Proj\\..\\Proj\\Secrets\\'
  const result = derive({
    permissions: { preset: 'p', tools: ['read-file', 'write-file'] },
    declaredDenyPathPrefixes: [declared],
  })
  assert.equal(result.derived, true)

  const expected = canonicalizePath(declared, { cwd: WIN.cwd, platform: WIN.platform })
  assert.deepEqual([...result.floor.denyPathPrefixes], [expected],
    '存进去的不是规范化后的值——一个没规范化过的前缀与一条不存在的禁令同形')
  // 幂等：guard 会对它再规范化一次，再算一次必须还是它。
  assert.equal(canonicalizePath(expected, { cwd: WIN.cwd, platform: WIN.platform }), expected)
  assert.equal(result.pathPrefixes[0].declared, declared, '声明过的原文要留在证据里')
  assert.equal(result.pathPrefixes[0].normalized, expected)
  // 下限里带着规范化的两个事实：guard 用的是同一对。
  assert.equal(result.floor.cwd, WIN.cwd)
  assert.equal(result.floor.platform, WIN.platform)

  // ★ 形状对还不够：拿**生产的** guard 拦一次。
  const guard = createHardFloorGuard(result.floor)
  const hit = guard({ name: 'write-file', arguments: { path: 'C:/Work/Proj/Secrets/key.pem' } })
  assert.match(hit, /^hard floor：路径落入静态禁止范围（/)
  assert.equal(hit.includes(expected), true)

  // 不在范围内的路径不许被误伤；并列目录（Secrets2）也不算后代。
  assert.equal(guard({ name: 'write-file', arguments: { path: 'C:/Work/Proj/Public/readme.md' } }), undefined)
  assert.equal(guard({ name: 'write-file', arguments: { path: 'C:/Work/Proj/Secrets2/x.txt' } }), undefined)

  // 而这个前缀不是装饰：它同时也该在 pre-execute 那道闸上生效。
  const gate = composePreExecuteFloor({ floor: result.floor, decide: () => ({ kind: 'allow' }) })
  const denied = gate({ name: 'write-file', arguments: { path: 'c:\\work\\proj\\secrets\\a.txt' } })
  assert.equal(denied.kind, 'deny')
  assert.equal(gate({ name: 'write-file', arguments: { path: 'c:\\work\\proj\\public\\a.txt' } }).kind, 'allow')
})

test('④ ★★★ 上限：工具面与路径面在同一份下限里同时生效', () => {
  const result = derive({
    permissions: { preset: 'p', tools: ['read-file', 'git-push'] },
    declaredDenyPathPrefixes: ['/var/legion/secrets'],
  })
  assert.equal(result.derived, true)
  // 工具面进去的是**执行面**名字（`git-push` 只有在 shell 上才能被拒）；
  // 路径面进去的是规范化后的绝对前缀。两者在同一份下限里。
  assert.deepEqual([...result.floor.denyTools], ['bash', 'pwsh'])
  assert.equal(result.floor.denyPathPrefixes.length, 1)

  const guard = createHardFloorGuard(result.floor)
  assert.match(guard({ name: 'pwsh', arguments: {} }), /^hard floor：工具 pwsh 被静态禁止/)
  assert.match(guard({ name: 'bash', arguments: {} }), /^hard floor：工具 bash 被静态禁止/)
  assert.match(guard({ name: 'read-file', arguments: { path: '/var/legion/secrets/x' } }),
    /^hard floor：路径落入静态禁止范围（/)
  assert.equal(guard({ name: 'read-file', arguments: { path: '/var/legion/secrets.json' } }), undefined)
  assert.equal(guard({ name: 'read-file', arguments: {} }), undefined)
  // 反向对照：名单外的执行面名字照常放行——静态下限是**拒绝名单**，不是允许名单。
  assert.equal(guard({ name: 'write', arguments: { path: '/var/legion/ok.txt' } }), undefined)
})

// ═══════════════════════════════════════ ⑤ ★★★ 声明过的禁用与控制面显式禁止

test('⑤ ★★★ 控制面显式禁止的工具进下限；与允许名单撞名时拒绝优先且只出现一次', () => {
  const result = derive({
    permissions: { preset: 'p', tools: ['read-file', 'git-commit'] },
    declaredDenyTools: ['git-commit'],
  })
  assert.equal(result.derived, true)
  // ★ 政策声明的名字同样是 **Legion 能力名**，于是它也要过同一遍翻译：
  //   `git-commit` 在执行面上是 `bash`/`pwsh`。
  assert.deepEqual([...result.floor.denyTools], ['bash', 'pwsh'])

  const declared = denyEntryFor(result, 'git-commit')
  assert.equal(declared.reason, REASONS.POLICY_DECLARED)
  assert.equal(declared.declaredBy, 'declaredDenyTools')
  assert.deepEqual([...declared.executionNames], ['bash', 'pwsh'])
  // 同一个工具两条决定（一条"允许名单放行"、一条"政策禁止"）是**如实**的：
  // 它们来自两个不同的输入，合并成一条会丢掉其中一个。
  assert.equal(result.entries.filter((e) => e.tool === 'git-commit').length, 2)
  assert.equal(result.entries.filter((e) => e.tool === 'git-commit' && e.deny === true).length, 1)
  // 而 denyTools 不许出现重复项（两条决定都指向同一批执行面名字）。
  assert.equal(result.floor.denyTools.filter((t) => t === 'bash').length, 1)

  // 反向对照：只给 `read-file` 时政策声明那条不存在，下限必须是空的。
  const plain = derive({ permissions: { preset: 'p', tools: ['read-file', 'git-commit'] } })
  assert.equal(plain.derived, true)
  assert.deepEqual([...plain.floor.denyTools], [],
    '`git-commit` 是 `repo:write`（审批可解除），不该被静态禁——'
    + '它进下限只可能是因为政策显式禁止了它')
})

test('⑤ ★★★★ 政策声明禁一个**执行面上没有名字**的工具：也是整次拒绝，不是记一条就算', () => {
  // 与允许名单那一侧同一条规则——"必须被禁"与"禁得了"是两件事，
  // 后者不成立时前者不构成一份可安装的下限。
  const result = derive({
    permissions: { preset: 'p', tools: ['read-file'] },
    declaredDenyTools: ['mcp-invoke'],
  })
  assert.equal(result.derived, false)
  assert.equal(result.floor, null)
  assert.deepEqual([...result.refusals.map((r) => r.code)], [CODES.HARD_FLOOR_NOT_ENFORCEABLE_AT_PLANE])
  assert.equal(result.refusals[0].why, 'hosted')
  assert.equal(result.refusals[0].tool, 'mcp-invoke')
  // 明说：这一条不是"拒绝执行"的意思丢失了，而是这一层表达不了它。
  assert.match(String(result.refusals[0].message), /执行面上没有名字/)
})

// ═══════════════════════════════════════ ⑥ ★★★ 零 IO、冻结、叶子

test('⑥ ★★★ 整棵夹具根在派生前后都是空的：本模块零 IO', () => {
  assert.deepEqual(readdirSync(ROOT), [], '夹具根一开始就该是空的')
  deriveRunFloor({
    permissions: { preset: 'p', tools: ['read-file', 'delete-file', 'ghost'] },
    declaredDenyTools: ['git-commit'],
    declaredDenyPathPrefixes: ['C:\\work\\secrets'],
    resolveTool, cwd: WIN.cwd, platform: WIN.platform, runId: 'run-io',
  })
  deriveRunFloor({ permissions: undefined })
  assert.deepEqual(readdirSync(ROOT), [], '派生写了文件——"零 IO"这句话就不成立了')
})

test('⑥ ★★★ 返回值是冻结的纯数据（可 JSON、可进审计）', () => {
  const result = derive({
    permissions: { preset: 'p', tools: ['read-file', 'git-push'] },
    declaredDenyPathPrefixes: ['/srv/legion/secrets'],
  })
  for (const value of [result, result.floor, result.floor.denyTools, result.floor.denyPathPrefixes,
    result.entries, result.pathPrefixes, result.notices, result.refusals]) {
    assert.equal(Object.isFrozen(value), true, '有没冻结的返回值')
  }
  for (const entry of result.entries) assert.equal(Object.isFrozen(entry), true)
  // ★ 连带代价的读数也是冻结的：它进审计，而审计里的对象被下游改过就不再是证据。
  for (const notice of result.notices) {
    assert.equal(Object.isFrozen(notice), true)
    if (notice.collateral !== undefined) assert.equal(Object.isFrozen(notice.collateral), true)
    if (notice.dshTools !== undefined) assert.equal(Object.isFrozen(notice.dshTools), true)
  }
  assert.equal(typeof JSON.stringify(result), 'string')
  assert.equal(result.runId, null)
  assert.equal(result.preset, 'p')

  // 纯数据 = 没有函数、没有活对象：JSON 往返之后形状一致。
  const round = JSON.parse(JSON.stringify(result))
  assert.deepEqual(round.floor.denyTools, [...result.floor.denyTools])
  assert.deepEqual(round.notices, [...result.notices])
})

test('⑥ ★★★ 本模块是叶子：它 import 的东西里没有能力目录（否则就是一个真实的模块环）', () => {
  const code = codeOf(MODULE_PATH)
  const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(imports, ['../runtime/dsh-composition/enforcement.mjs'],
    '本模块的 import 集合变了——它是叶子这件事是本模块能存在的前提')
  assert.equal(imports.some((specifier) => specifier.includes('tool-capability')), false,
    '本模块 import 了能力目录：那就与 tool-capability → run-floor 成环，'
    + '而环的表现是"强制面整段加载不上"')
  assert.equal(/process\.env/.test(code), false, '本模块读了进程环境')
  assert.equal(/readFileSync|writeFileSync|\bopenSync\b|child_process/.test(code), false, '本模块有 IO')
  // 反向对照：上面那些"零命中"不是因为提取没读到东西。
  assert.equal(code.includes('export function deriveRunFloor'), true)
  assert.equal(code.includes('HARD_FLOOR_CAPABILITIES'), true)
})

// ═══════════════════════════════════════ ⑦ ★★★ 诚实边界（新版）
//
// 旧版这一组断言的是「**没有任何东西**消费派生出来的下限」：
//
//   · `executor.includes('deriveRunFloor') === false`
//   · `/denyTools|denyPathPrefixes/.test(executor) === false`
//   · `/denyTools|denyPathPrefixes/.test(contract) === false`
//   · `plugin.includes('deriveRunFloor') === false` / `plugin.includes('DEFAULT_HARD_FLOOR') === true`
//
// 前两条的**前提**已经不成立了（后两条仍然成立，理由不同，见下）。一条断言
// "没人消费它"的用例，在有人消费它之后**必须**换成一条断言"谁在消费、消费出了
// 什么，以及还有什么是它没证明的"——直接把用例删掉，等于把这道边界一起删掉。

/** 生产者要吃的最小一份 RunRequest（只用到 `permissions` / `workdir` / `runId`）。 */
const REQUEST = Object.freeze({
  runId: 'run:prt-214', attemptId: 'att:prt-214', workdir: WIN.cwd,
  permissions: Object.freeze({ preset: 'legion-attended', tools: Object.freeze(['read-file']) }),
})

test('⑦ ★★★ 生产者**接上了**：executor 从这个模块取下限、从真能力目录取解析口', () => {
  const executor = codeOf(fileURLToPath(new URL('../orchestrator/worker/executor.mjs', import.meta.url)))

  // ① 它 import 的是**这个**模块。一个 import 了却没人调的函数，与一个没 import 的
  //    函数，在运行时是同一个东西——所以下面还有一条**行为**读数（第二条）。
  assert.match(executor, /from\s+'\.\.\/\.\.\/team-hub\/run-floor\.mjs'/,
    'executor 没有从控制面这个模块取派生的下限——那它产出的那份东西是哪来的？')
  // ② 解析口来自**真**能力目录：一个"什么都认识"的替身会让未知工具静默放行。
  assert.match(executor, /from\s+'\.\.\/\.\.\/runtime\/dsh-composition\/tool-capability\.mjs'/,
    '解析口不是从真能力目录注入的——那"不认识的工具默认最严"这条就没了')
  // ③ 三态判定借用**契约那一份**，不在这里另立一条。
  assert.match(executor, /from\s+'\.\.\/\.\.\/runtime\/contracts\/run-floor\.mjs'/,
    'executor 没有用契约里的三态判定：两份判定会漂，而漂的那天表现为'
    + '"生产者说能装、适配器说解释不了"')
  assert.match(executor, /RUN_FLOOR_WIRE_VERSION/,
    '线上形状的版本号被手写了一遍——契约改了它不会跟着改')
})

test('⑦ ★★★ 行为读数：同一份输入，executor 产出的下限与本模块派生的一模一样', () => {
  const permissions = { preset: 'legion-unattended', tools: ['read-file', 'git-push', 'git-commit'] }
  const carried = deriveRunFloorCarrier({ ...REQUEST, permissions }, { platform: WIN.platform })

  assert.equal(carried.state, RUN_FLOOR_STATES.INSTALLED, JSON.stringify(carried.payload))
  const mine = derive({ permissions })
  assert.deepEqual([...carried.payload.floor.denyTools], [...mine.floor.denyTools],
    'executor 的产出与直接派生**不一样**——那说明它在派生之外又加了一条自己的规则')
  assert.deepEqual(carried.payload.floor.denyTools, ['bash', 'pwsh'],
    '`git-push` 是硬底线，它在执行面上只有 shell 那一对名字可禁')
  assert.deepEqual([...carried.payload.floor.denyPathPrefixes], [])
  // 载荷必须**挂在请求上**，而且是同一份对象（传输层按对象身份认"哪份下限属于哪次 Run"）。
  assert.equal(carried.request[RUN_FLOOR_WIRE_FIELD], carried.payload)
  assert.equal(readRunFloor(carried.request[RUN_FLOOR_WIRE_FIELD]).state, RUN_FLOOR_STATES.INSTALLED)
})

test('⑦ ★★ 派生失败**不是缺席**：载荷是 `derived:false`（传输层读成"拒收"），原因码跟着走', () => {
  const carried = deriveRunFloorCarrier({ ...REQUEST, permissions: UNSUPPLIED_PERMISSIONS })
  assert.equal(carried.state, RUN_FLOOR_STATES.REFUSED)
  // 这一条与下一条合起来才是重点：它不是 `absent`（"没有人给我下限"），
  // 而是 `refused`（"给了，但解释不了"）——两者的修法完全不同。
  assert.equal(readRunFloor(carried.payload).state, RUN_FLOOR_STATES.REFUSED)
  assert.notEqual(readRunFloor(carried.payload).state, RUN_FLOOR_STATES.ABSENT)
  assert.equal(carried.payload.derived, false)
  assert.equal(carried.payload.floor, null)
  assert.deepEqual([...carried.payload.refusals], [CODES.PERMISSIONS_MISSING])
})

test('⑦ ★★★★★ 生产出来的名单**真的命中执行面**了（本批把这条从"记录，不修"翻过来）', () => {
  // ★ 这一条的前身叫「生产出来的名单对**执行面**的名字一个都不命中（记录，不修）」，
  //   它逐条断言的是那个缺口：名单里写的是 Legion 能力名，而 guard 比的是
  //   `execution.name`（执行面工具名），两个空间不相交，于是**一个真工具都没拦住**。
  //
  //   一条断言"缺陷还在"的用例，在缺陷被修掉之后**必须**换成一条断言"修好了，
  //   而且修的方式是这一种"——把它删掉，等于把这道边界一起删掉；把它改成
  //   `assert.ok(true)`，等于留下一个看起来在守东西的装饰。
  const { payload, refusals } = deriveRunFloorCarrier(
    { ...REQUEST, permissions: { preset: 'p', tools: [...HIGH_RISK_TOOL_NAMES] } },
    { platform: WIN.platform },
  )
  // ① 九个高风险能力里有一个 `git-push` 是硬底线、两个（`delete-file` /
  //    `write-secret`）是硬底线但**执行面上没有名字** ⇒ 这一档派生出不来。
  //    九个一起喂进来正好把两种处置都触发：先证明它拒了。
  assert.equal(payload.derived, false, '九个高风险能力一起吃进来，能表达的那一个不该把它救回来')
  // 载荷上只带**码**（那是跨进程那一层要读的东西）；具名信息在 `refusals` 上。
  assert.deepEqual([...new Set(payload.refusals)], [CODES.HARD_FLOOR_NOT_ENFORCEABLE_AT_PLANE],
    '拒绝码不是"硬底线在这一层表达不了"——那是另一件事，要重判这一组')
  // 每一条拒绝都指着一个**具名**工具：`delete-file` 与 `write-secret` 各一条。
  // 断言"指的是哪两个"而不是"条数等于 1"——条数是"有几个工具禁不了"的读数，
  // 它会随目录增长而变，而这里要守的是**是哪几个**。
  assert.deepEqual(
    [...refusals.map((r) => r.tool)].sort(),
    ['delete-file', 'write-secret'],
    '禁不了的硬底线不止/不止这两个，要重判这一组',
  )

  // ② 把禁不了的那两个去掉，剩下的硬底线 `git-push` **真的被翻译了**。
  //    判据是「硬底线 **且** 执行面上有名字」——只看后者会把 `run-command` /
  //    `git-commit` 也算进来（它们同样落到 shell 上，但它们是审批可解除的）。
  const expressible = HIGH_RISK_TOOL_NAMES.filter(
    (n) => TOOL_CATALOG[n]?.hardFloor === true && executionDenialFor(n).dshTools.length > 0)
  assert.deepEqual([...expressible], ['git-push'], '能表达的高风险硬底线不止/不止这一条，要重判')
  const carried = deriveRunFloorCarrier(
    { ...REQUEST, permissions: { preset: 'p', tools: [...expressible, 'read-file'] } },
    { platform: WIN.platform },
  )
  assert.equal(carried.payload.derived, true)
  const guard = createHardFloorGuard(carried.payload.floor)

  // ③ ★ 承重段：名单里的每一个名字，guard **真的拒**。
  assert.deepEqual([...carried.payload.floor.denyTools], ['bash', 'pwsh'])
  for (const name of carried.payload.floor.denyTools) {
    assert.equal(typeof guard({ name, arguments: {} }), 'string',
      `${name} 在名单里却没有被拒——那说明名单里放的仍然不是执行面的名字`)
  }

  // ④ 反向对照：这批名字是**从执行面那一侧**取来的，不是我们自己写死的。
  //    少了这条，上面那段在一个"把 bash/pwsh 硬编码进名单"的实现上也是绿的。
  assert.deepEqual([...carried.payload.floor.denyTools], [...dshToolNamesOf(['git-push'])])

  // ⑤ 连带代价必须被读出来：`bash`/`pwsh` 同时承载 run-command / git-status / git-commit。
  const collateralNotice = carried.result.notices.find((n) => n.code === RUN_FLOOR_NOTICE_CODES.COLLATERAL_DENIAL)
  assert.notEqual(collateralNotice, undefined, '连带禁止没有留读数——那"为了拦一个推送而关掉整个 shell"就看不出来了')
  assert.equal(collateralNotice.tool, 'git-push')
  assert.deepEqual([...collateralNotice.collateral], ['run-command', 'git-status', 'git-commit'])

  // ⑥ 而名字名单**仍然不是** fail closed：名单外的执行面名字照常放行。
  //    这条是这一组唯一没变的一句，也正因为没变才要留着——
  //    它防的是下一个人把"翻译对了"读成"下限现在已经完备了"。
  assert.equal(guard({ name: 'write', arguments: {} }), undefined)
  assert.equal(guard({ name: 'edit', arguments: {} }), undefined)
})

test('⑦ ★ 组合面那一行拿到的仍然是 DEFAULT_HARD_FLOOR（那次装配与"按 Run"是两条缝）', () => {
  const pluginPath = fileURLToPath(new URL('../runtime/dsh-composition/plugins/hard-floor.mjs', import.meta.url))
  const plugin = readFileSync(pluginPath, 'utf8')
  assert.equal(plugin.includes('deriveRunFloor'), false,
    'hard-floor 插件直接开始派生了——那天再改这条，并且要说清它拿哪一次的权限档位')
  assert.equal(plugin.includes('DEFAULT_HARD_FLOOR'), true,
    '组合面那一行的默认值换了——先确认这是有意的，再改这条注释')
  // 运行契约里仍然**没有**承载下限的字段：形状住在 `runtime/contracts/run-floor.mjs`，
  // 它在 `run.mjs` 里只被调用、不被复制。这一条是防"两份形状"的。
  const contract = codeOf(fileURLToPath(new URL('../runtime/contracts/run.mjs', import.meta.url)))
  assert.equal(/denyTools|denyPathPrefixes/.test(contract), false,
    'RunRequest 契约里又出现了一份下限形状——它会与 run-floor.mjs 那份漂')
})

test('⑦ ★ 真进程那一对里的下限仍然是**测试挂上去的**（这句话过期时这里要红）', () => {
  const dshProcess = readFileSync(
    fileURLToPath(new URL('../runtime/dsh-composition/run-floor-dsh-process.test.mjs', import.meta.url)), 'utf8')
  assert.match(dshProcess, /enforcementFloor: floorForScenario/,
    '真进程套件里的下限不再是用例手写的了——那么"没有真实 DSH 进程被**派生出来的**'
    + '下限拒过"这句话要重判，这一组与文件头都要跟着改')
})
