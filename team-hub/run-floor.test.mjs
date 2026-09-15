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
// ## 诚实边界（本套件**没有**证明的东西）
//
//   · **没有任何东西消费派生出来的下限**：`orchestrator/worker/executor.mjs`
//     仍然只把 `{preset, tools}` 放进 RunRequest，`runtime/contracts/run.mjs`
//     里没有承载下限的字段。从"派生"到"装进一个运行中的 DSH"那一截是
//     Runtime Contract 的事（PRT-253 的地界），本套件一个字都没碰。
//   · 因此**没有任何真实 DSH 进程因为这份下限拒绝过一次工具调用**：
//     这里拦住的每一次都是本进程里直接调用的 guard。
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
  TOOL_CATALOG,
  resolveTool,
} from '../runtime/dsh-composition/tool-capability.mjs'

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

// ═══════════════════════════════════════ ⑦ ★★★ 诚实边界

test('⑦ ★★★ 诚实边界：**没有任何东西**消费派生出来的下限，也从来没有真 DSH 进程被它拒过', () => {
  // ① 生产装配点仍然只搬 {preset, tools}——下限没有出口。
  const executor = codeOf(fileURLToPath(new URL('../orchestrator/worker/executor.mjs', import.meta.url)))
  assert.equal(executor.includes('deriveRunFloor'), false,
    'executor 已经在用派生的下限了——这条诚实边界要连同文件头一起改')
  assert.equal(/denyTools|denyPathPrefixes/.test(executor), false,
    'executor 里出现了去往强制面的下限字段——那说明传输那一截已经接上了')

  // ② 运行契约里没有承载下限的字段：从"派生"到"装进运行中的 DSH"那一截不在本批。
  const contract = codeOf(fileURLToPath(new URL('../runtime/contracts/run.mjs', import.meta.url)))
  assert.equal(/denyTools|denyPathPrefixes/.test(contract), false,
    'RunRequest 契约里出现了下限字段——PRT-253 那一截已经动了，本用例要跟着改')

  // ③ 组合面那一行拿到的仍然是 DEFAULT_HARD_FLOOR（空下限），不是派生结果。
  const pluginPath = fileURLToPath(new URL('../runtime/dsh-composition/plugins/hard-floor.mjs', import.meta.url))
  const plugin = readFileSync(pluginPath, 'utf8')
  assert.equal(plugin.includes('deriveRunFloor'), false,
    'hard-floor 插件已经在用派生的下限了——"没有任何东西消费它"这句话不再成立')
  assert.equal(plugin.includes('DEFAULT_HARD_FLOOR'), true,
    '组合面那一行的默认值换了——先确认这是有意的，再改这条注释')

  // ★ 因此本套件**没有**证明：某个真实 DSH 进程被一份这样派生出来的下限拒过。
  //   这里每一次拒绝都发生在**本进程**里，用的是直接构造的 guard。
})
