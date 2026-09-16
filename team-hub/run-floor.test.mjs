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
import { dshToolNamesOf } from '../runtime/dsh-composition/employee-preset.mjs'
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
  assert.equal(RUN_FLOOR_VERSION, 1)
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

test('② ★★★★★ 不认识的工具**进下限**并判静态拒绝，带 known:false 与 notice', () => {
  const result = deriveRunFloor({
    permissions: { preset: 'legion-attended', tools: ['read-file', 'ghost-tool'] },
    resolveTool, cwd: WIN.cwd, platform: WIN.platform, runId: 'run-ghost',
  })
  assert.equal(result.derived, true)
  // 只留一个未知工具：如果它"消失"了，这里就是一个空数组。
  assert.deepEqual([...result.floor.denyTools], ['ghost-tool'],
    '不认识的工具从下限里消失了——那与"所有未知工具都自动放行"是同一个东西')

  const ghost = entryFor(result, 'ghost-tool')
  assert.equal(ghost.deny, true)
  assert.equal(ghost.reason, REASONS.UNKNOWN_TOOL)
  assert.equal(ghost.known, false, '决定里必须留下 known:false——修法是登记工具，不是放宽名单')

  assert.equal(result.notices.length, 1)
  assert.equal(result.notices[0].code, RUN_FLOOR_NOTICE_CODES.UNKNOWN_TOOL_DENIED)
  assert.equal(result.notices[0].tool, 'ghost-tool')
  assert.equal(String(result.notices[0].message).includes('ghost-tool'), true)

  // 反向对照：同一份输入里那个**认得出**的工具不进下限。
  assert.equal(entryFor(result, 'read-file').deny, false)
})

test('② ★★★★ 高风险的**已知**工具不进静态下限：目录说它审批可解除', () => {
  const result = deriveRunFloor({
    permissions: { preset: 'legion-attended', tools: ['delete-file', 'post-external-api', 'run-command'] },
    resolveTool, cwd: WIN.cwd, platform: WIN.platform,
  })
  assert.equal(result.derived, true)
  assert.deepEqual([...result.floor.denyTools], ['delete-file'])

  // `external-api:write` 的风险是 critical，但目录说 hardFloor 是 false——
  // 即"审批可以解除"。把它也塞进静态下限，等于把"问一下"改成"永远不行"。
  const post = entryFor(result, 'post-external-api')
  assert.equal(post.deny, false)
  assert.equal(post.reason, REASONS.APPROVAL_LIFTABLE)
  assert.equal(post.requiresApproval, true)
  assert.equal(resolveTool('post-external-api').risk, 'critical')
  assert.equal(resolveTool('post-external-api').hardFloor, false)

  // 而 hard-floor 的那一条，理由与命中的能力都要能读出来。
  const del = entryFor(result, 'delete-file')
  assert.equal(del.reason, REASONS.HARD_FLOOR_CAPABILITY)
  assert.equal(del.capability, 'file:delete')
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
    permissions: { preset: 'p', tools: ['read-file', 'delete-file'] },
    declaredDenyTools: ['mcp-invoke'],
    declaredDenyPathPrefixes: ['/var/legion/secrets'],
  })
  assert.equal(result.derived, true)
  assert.deepEqual([...result.floor.denyTools], ['delete-file', 'mcp-invoke'])

  const guard = createHardFloorGuard(result.floor)
  assert.match(guard({ name: 'delete-file', arguments: { path: '/var/legion/ok.txt' } }),
    /^hard floor：工具 delete-file 被静态禁止/)
  assert.match(guard({ name: 'mcp-invoke', arguments: {} }), /^hard floor：工具 mcp-invoke 被静态禁止/)
  assert.match(guard({ name: 'read-file', arguments: { path: '/var/legion/secrets/x' } }),
    /^hard floor：路径落入静态禁止范围（/)
  assert.equal(guard({ name: 'read-file', arguments: { path: '/var/legion/secrets.json' } }), undefined)
  assert.equal(guard({ name: 'read-file', arguments: {} }), undefined)
})

// ═══════════════════════════════════════ ⑤ ★★★ 声明过的禁用与控制面显式禁止

test('⑤ ★★★ 控制面显式禁止的工具进下限；与允许名单撞名时拒绝优先且只出现一次', () => {
  const result = derive({
    permissions: { preset: 'p', tools: ['read-file', 'git-commit'] },
    declaredDenyTools: ['git-commit', 'delete-file'],
  })
  assert.equal(result.derived, true)
  assert.deepEqual([...result.floor.denyTools], ['git-commit', 'delete-file'])

  const declared = denyEntryFor(result, 'git-commit')
  assert.equal(declared.reason, REASONS.POLICY_DECLARED)
  assert.equal(declared.declaredBy, 'declaredDenyTools')
  // 同一个工具两条决定（一条"允许名单放行"、一条"政策禁止"）是**如实**的：
  // 它们来自两个不同的输入，合并成一条会丢掉其中一个。
  assert.equal(result.entries.filter((e) => e.tool === 'git-commit').length, 2)
  assert.equal(result.entries.filter((e) => e.tool === 'git-commit' && e.deny === true).length, 1)
  // 而 denyTools 不许出现重复项。
  assert.equal(result.floor.denyTools.filter((t) => t === 'git-commit').length, 1)

  // 目录里的 `delete-file` 是**已知**的（证据字段），但拒绝理由仍是政策声明。
  assert.equal(entryFor(result, 'delete-file').known, true)
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
    permissions: { preset: 'p', tools: ['read-file', 'delete-file', 'ghost'] },
    declaredDenyPathPrefixes: ['/srv/legion/secrets'],
  })
  for (const value of [result, result.floor, result.floor.denyTools, result.floor.denyPathPrefixes,
    result.entries, result.pathPrefixes, result.notices, result.refusals]) {
    assert.equal(Object.isFrozen(value), true, '有没冻结的返回值')
  }
  for (const entry of result.entries) assert.equal(Object.isFrozen(entry), true)
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
  const permissions = { preset: 'legion-unattended', tools: ['read-file', 'delete-file', 'ghost'] }
  const carried = deriveRunFloorCarrier({ ...REQUEST, permissions }, { platform: WIN.platform })

  assert.equal(carried.state, RUN_FLOOR_STATES.INSTALLED, JSON.stringify(carried.payload))
  const mine = derive({ permissions })
  assert.deepEqual([...carried.payload.floor.denyTools], [...mine.floor.denyTools],
    'executor 的产出与直接派生**不一样**——那说明它在派生之外又加了一条自己的规则')
  assert.deepEqual(carried.payload.floor.denyTools, ['delete-file', 'ghost'],
    '这一档里两个该被静态禁止的工具没进去（硬底线能力 + 未登记工具）')
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

test('⑦ ★★★ 生产出来的名单对**执行面**的名字一个都不命中（记录，不修）', () => {
  // 这一条是 round-53 那个发现的**生产者侧**读数：以前它读的是手写名单，
  // 现在读的是**生产真的会产出的那一份**。结论没变，证据换成了真的。
  const { payload } = deriveRunFloorCarrier(
    { ...REQUEST, permissions: { preset: 'p', tools: [...HIGH_RISK_TOOL_NAMES] } },
    { platform: WIN.platform },
  )
  const guard = createHardFloorGuard(payload.floor)

  // ① 九个高风险能力**全都授权了**，而进静态下限的只有带硬底线能力的那三个
  //    （其余六个是 `approval-liftable`：高风险但审批可以解除，那是另一个政策）。
  //    这一半是**读数**，不是猜：从目录自己的标记算出来。
  const hardFloorToolNames = Object.values(TOOL_CATALOG).filter((t) => t.hardFloor === true).map((t) => t.name).sort()
  assert.deepEqual([...payload.floor.denyTools].sort(), hardFloorToolNames,
    '静态下限里的名字与目录标了 `hardFloor` 的那一组对不上')

  // ② 这些 Legion 名字**真的被拒**（不是"看起来在拒"）。
  for (const name of hardFloorToolNames) {
    assert.equal(typeof guard({ name, arguments: {} }), 'string', `${name} 没有被这份下限拒`)
  }
  // ③ 而它们真正落到的执行面名字**一个都不在名单里**——这正是那个缺口。
  //    九个高风险能力里，映射到执行面的只有 shell 那一对（另外六个是宿主平面的，
  //    `employee-preset.mjs` 里 `hosted: true`）。
  const mapped = dshToolNamesOf(HIGH_RISK_TOOL_NAMES)
  assert.deepEqual([...mapped], ['bash', 'pwsh'], '名字空间的映射读数变了，这一条要重判')
  for (const name of mapped) {
    assert.equal(guard({ name, arguments: {} }), undefined,
      `${name} 被拒了——那说明有人把 Legion 名字**翻译**成了执行面名字，`
      + '而那会过度禁止（`bash`/`pwsh` 也是低风险 `git-status` 的落地方式）')
  }
  // ④ 尤其：`git-push`（硬底线、不可逆）在**执行面**上没有任何名字可禁——
  //    它在名单里，但它跑起来叫 `pwsh`，而 `pwsh` 是放行的。
  assert.equal(payload.floor.denyTools.includes('git-push'), true)
  assert.equal(guard({ name: 'pwsh', arguments: {} }), undefined)
  // ⑤ 哪个名单里都没有的执行面名字同样放行：**名字名单不是 fail closed**。
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
