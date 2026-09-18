// scripts/prt/whitelist-limb.test.mjs
// ============================================================================
// PRT-603 的 `whitelist` 这一道：**§11 留下的两处"我没有量"**，外加一处它没提的。
//
// ## 为什么这条套件不是"再测一遍 permitsTool"
//
// `employee-manifest.test.mjs` 已经有 20 例把 `permitsTool` 的**每一条规则**都走到过
// 拒绝（还有 `proveEveryRuleFires` 逐条比对理由锚点）。那些用例全绿。
//
// 它们绿得对，而且**证明不了本文要问的事**——因为它们的夹具喂的是
// **Legion 能力名**（`read-file` / `delete-file` / …），而生产里那个端口
// 拿到的是**执行面（DSH）的工具名**（`read` / `write` / `bash` / `web_fetch` / …）。
//
//   > 一个「用 Legion 名字把每一条规则都走到拒绝」的套件，
//   > 与一个「真名字进来时这道检查到底放行过谁」的套件，
//   > 在摘要里都是绿的——只不过前者的绿是**词汇表自己对自己**的绿。
//
// 这不是我推测的。`docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md` §11.5 逐字写着：
//
//   > ⚠️ 边界：我没有核"包层接上之后 `permit` 是否能原样喂进 `permitsTool`"——
//   > 两边形状看着一致（都源自 `narrowToGrant`），但**我没有跑过一次**，
//   > 所以这句话在本文件里不成立、也不该被引用。
//
// 本套件就是那一次"跑一次"。跑出来的结论见 ③/④。
//
// ## 三件事，三组读数
//
//   (a) §11.3 ⚠️  `permit` 的另一半（`grant`）从哪来 —— 之前**没有量**
//   (b) §11.5 ⚠️  `permit` 能不能原样喂进 `permitsTool` —— 之前**没有跑**
//   (c) 本文新查出的：**两个同名的 `EmployeeManifest`**
//
// ## 而 ③ 与仓库里一条**已经写下来的**教义是同一个形状
//
// `runtime/dsh-composition/tool-capability.mjs:465-492` 那条长注释
// （`HIGH_RISK_TOOL_NAMES` 头上）逐字写着：
//
//   > 两个名字空间**不相交**……⇒ 所以：**作为数据**这一组是对的、也是单一来源；
//   > **作为 `denyTools`** 它是**空的**（`名单 ∩ 真工具名 = ∅`）。
//
// 那条讲的是**静态下限**（`createHardFloorGuard` 只看 `execution.name`）。
// 本套件 ③ 量的是**同一件事在白名单那一道上的形态**——而它此前
// **一个字都没被写过**，因为 `permitsTool` 在生产里**零调用方**：
//
//   > 一个「在生产里零调用方、于是它的名字空间问题从没被量过」的检查，
//   > 与一个「量过了、并且把结论写在了定义点上」的检查，
//   > 在今天的行为上是同一个东西——只不过接线的那天只有一个是对的。
//
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MANIFEST_FIELDS, FORBIDDEN_MANIFEST_FIELDS,
  assertManifestFieldsClosed, normalizeManifest, permitsTool,
} from '../../runtime/dsh-composition/employee-manifest.mjs'
import { resolveTool, RISK_RANK, UNKNOWN_TOOL_RISK } from '../../runtime/dsh-composition/tool-capability.mjs'
import { LEGION_TOOL_ROUTING, dshToolNamesOf } from '../../runtime/dsh-composition/employee-preset.mjs'
import { LEGION_PERMISSION_PRESETS } from '../../runtime/dsh-composition/patch-layer.mjs'
import {
  hostEnforcementSurface, assertPackAuthority, sampleHostSurface,
  PACK_AUTHORITY_CODES,
} from '../../runtime/packs/authority.mjs'
import { SAMPLE_TEAM, sampleTeamPack } from '../../runtime/packs/compiled-plan.mjs'
import { employeeManifestSource } from '../../runtime/context/sources.mjs'
import { analyze } from './reachability.mjs'

/** 一个只读岗位的许可（**从真实的包层算出来**，不是手写的）。 */
function realPermit(surface = sampleHostSurface()) {
  const pack = sampleTeamPack()
  const out = assertPackAuthority({
    manifest: pack.manifest, files: pack.files, hostSurface: surface, employees: SAMPLE_TEAM.employees,
  })
  assert.equal(out.ok, true, `夹具本身要能过：${JSON.stringify(out.problems)}`)
  assert.ok(out.computed.permits.length > 0, '包层必须真的产出许可——否则下面每一条都在测空气')
  return out.computed.permits[0]
}

const PORT_KEYS = ['allowed', 'rule', 'reason']

// ══════════════════════════════════════════════════════════════════════════
// (a) §11.3 那半：`grant` 从哪来
// ══════════════════════════════════════════════════════════════════════════

test('① ★★ §11.3 的答案：`grant` 是**宿主显式注入**的，`preset` 来自 host 组合的补丁层表', () => {
  // §11.3 逐字写着「`permit` 的另一半（`grant` / `hostGrant`）从哪来、算不算
  // '部署配置'，本批**没有量**」。这一条把它量掉，而且**不靠读注释**——
  // 靠的是"不给它就会抛"这个行为。
  let code = null
  try { hostEnforcementSurface({ preset: 'legion-attended' }) } catch (err) { code = err.code }
  assert.equal(code, PACK_AUTHORITY_CODES.HOST_SURFACE_UNRESOLVED,
    '不给 grant 竟然没抛 ⇒ "没给授予"会被读成"没有限制"')

  // 而给了之后，用的是**调用方那一份**，不是从包里推出来的。
  const surface = hostEnforcementSurface({
    preset: 'legion-attended',
    grant: {
      allowedTools: ['marker-only-here'], allowedCapabilities: ['file:read'],
      maxRisk: 'low', workspaceRoot: 'C:/work/sample',
    },
  })
  assert.deepEqual([...surface.allowedTools], ['marker-only-here'],
    '注入的 grant 没有原样进基线 ⇒ 它可能是从别处推的')

  // preset 那一半来自 **host 组合**（`patch-layer.mjs`）——这决定了它与
  // 三道范围表是**同一族**（部署侧数据），而 `manifest` 那一半不是。
  assert.ok(Object.keys(LEGION_PERMISSION_PRESETS).includes('legion-attended'),
    'LEGION_PERMISSION_PRESETS 里没有夹具用的 preset ⇒ 这条断言的落点变了')
})

// ══════════════════════════════════════════════════════════════════════════
// (b) §11.5 那次"跑一次"：形状对得上，词汇表对不上
// ══════════════════════════════════════════════════════════════════════════

test('② ★★ §11.5 的形状那一半：`permitsTool` 的返回**装得下**桥要的三个键', () => {
  const permit = realPermit()
  const verdict = permitsTool({ permit, toolName: 'read-file' })
  for (const k of PORT_KEYS) assert.ok(k in verdict, `桥要 \`${k}\`，而它没给`)
  // ★ 正对照：它**真的会放行**——少了这一条，"永远返回 allowed:false 的实现"
  //   也能通过上面那个"键都在"的断言。
  assert.equal(verdict.allowed, true,
    '一个被点名的授权工具竟然不放行 ⇒ 夹具或实现变了，先核这里再往下读')
  assert.equal(verdict.rule, null)
  assert.ok('riskRaised' in verdict, '多出来的那个键——桥不读它，但它在这里是有用的读数')
})

test('③ ★★★ §11.5 的词汇表那一半：**喂 DSH 名字进来，这道白名单只能拒、不可能放行**', () => {
  const permit = realPermit()

  // 夹具自证：同一份 permit 对 Legion 名字是放行的（② 已断言），
  // 对 DSH 名字**一个都不放行**。两组用**同一个** permit ⇒ 差异只来自词汇表。
  const dshNames = ['read', 'write', 'bash', 'web_fetch', 'read_file', 'glob']
  for (const name of dshNames) {
    const facts = resolveTool(name)
    assert.equal(facts.known, false,
      `${name} 居然是 known ⇒ 工具目录变了，这条读数的前提要重核`)
    assert.equal(facts.risk, UNKNOWN_TOOL_RISK)
    assert.deepEqual([...facts.capabilities], [], '未知工具的能力集必须是空的（空集是任何集合的子集）')
  }

  const blocked = dshNames.map((n) => permitsTool({ permit, toolName: n }))
  assert.deepEqual(blocked.map((v) => v.allowed), dshNames.map(() => false),
    '有 DSH 名字被放行了 ⇒ 这条读数的结论（"只能拒"）不成立，先核它是在哪一条规则上过的')
  // 而且拒它的是**风险上限**那条——第一个拒的码，不是"没点名"那条。
  assert.deepEqual([...new Set(blocked.map((v) => v.rule))], ['employee-manifest-risk-above-ceiling'],
    '拒的理由不是风险上限 ⇒ 规则先后变了，下面"抬上限救不了"那一条要重写')

  // ★★★ 决定性的一条：把上限抬到最高，看"未知工具必须点名"能不能救它。
  const permissive = { ...permit, maxRisk: 'critical' }
  const rescued = dshNames.map((n) => permitsTool({ permit: permissive, toolName: n }))
  assert.deepEqual(rescued.map((v) => v.allowed), dshNames.map(() => false),
    '抬高上限之后竟然放行了 ⇒ 这一条读数的结论要整个重写')
  assert.deepEqual([...new Set(rescued.map((v) => v.rule))], ['employee-manifest-unknown-tool-not-named'],
    '抬上限之后的拒因不是"必须点名" ⇒ 中间还有第三条规则在兜底')

  // ⇒ 于是两条"修复动作"互相指错方向：
  //   照第一条去改岗位清单的 maxRisk ⇒ 落到第二条；
  //   照第二条去"点名" ⇒ 点的是 Legion 名，而线上来的永远不是它。
  //
  //   > 一个「拒得对、而理由是错的」的检查，
  //   > 与一个「放行了它该拒的」的检查，
  //   > 在今天的行为上是同一个东西——只不过**照着理由去改的人会改错地方**，
  //   > 而改完仍然是拒的，于是没有人会发现理由本身是错的。
})

test('④ ★★ 反向映射**不是机械的**：shell 与 web 那两组是一对多', () => {
  // 有人会说"那就把 DSH 名字翻回 Legion 名字再喂进去"。这一条量的是
  // 那个"翻"能不能机械化。
  const back = new Map()
  for (const [legion, route] of Object.entries(LEGION_TOOL_ROUTING)) {
    for (const d of route.dshTools ?? []) {
      if (!back.has(d)) back.set(d, [])
      back.get(d).push(legion)
    }
  }
  // 一对一的那几个（不存在歧义）
  assert.deepEqual(back.get('read'), ['read-file'])
  assert.deepEqual(back.get('write'), ['write-file'])

  // ★ 一对多的那几个：**恰好是风险最高的那几个**
  const ambiguous = [...back.entries()].filter(([, ls]) => ls.length > 1).map(([d]) => d).sort()
  assert.deepEqual(ambiguous, ['bash', 'pwsh', 'web_fetch'],
    '一对多的集合变了 ⇒ "反推不唯一"这句话的射程跟着变，先重核')
  assert.deepEqual([...back.get('bash')].sort(), ['git-commit', 'git-push', 'git-status', 'run-command'],
    'bash 的反推集合变了')
  // ★ 而它把**低风险**的 `git-status` 与三个高风险动作塌在同一个名字上：
  assert.deepEqual([...back.get('bash')].includes('git-status'), true)
  assert.deepEqual([...back.get('bash')].includes('git-push'), true)
  //   > 一个「按 DSH 名字反推 Legion 名字」的翻译器，
  //   > 与一个「把 `git-status` 与 `git-push` 判成同一个东西」的翻译器，是同一个东西——
  //   > 只不过前者会让"只读岗位"要么连 `git-status` 都被拒、要么连 `git-push` 都被放行。
  //
  // 所以翻译**不是**一个可以顺手加的映射：它需要一个决定（取严？按参数？还是
  // 让 `permitsTool` 直接收 DSH 名 + 一份 DSH 侧的能力表）。这正是 §5 那一格要问的。
})

// ══════════════════════════════════════════════════════════════════════════
// (c) 本文新查出：**两个同名的 EmployeeManifest**
// ══════════════════════════════════════════════════════════════════════════

test('⑤ ★★★ 仓库里有两个都叫 EmployeeManifest 的东西，而它们**互不可转换**', () => {
  // 一个在**强制面**（`dsh-composition/employee-manifest.mjs`），一个在**上下文**
  // （`context/sources.mjs` 的 `employeeManifestSource`）。两边都有 `employeeId` /
  // `role` / `displayName` / `allowedTools`，所以它们**看起来是同一个东西**。
  const ctxFields = ['employeeId', 'role', 'scope', 'displayName', 'responsibilities',
    'allowedTools', 'deniedTools', 'approvalPolicy', 'limits', 'createdAtMs', 'updatedAtMs']
  const shared = ctxFields.filter((f) => MANIFEST_FIELDS.includes(f))
  assert.deepEqual(shared, ['employeeId', 'role', 'displayName', 'allowedTools'],
    '交集变了 ⇒ 下面两条的落点跟着变')

  // 方向一：context 形状 → 强制面 ⇒ **抛**
  const ctxShaped = {
    version: 'legion/employee-manifest@1', employeeId: 'e-1', role: 'planner', scope: 's-1',
    displayName: '规划', responsibilities: ['排期'], allowedTools: ['read-file'],
    deniedTools: ['rm-rf'], approvalPolicy: 'attended', limits: { usd: 1 },
    createdAtMs: 1, updatedAtMs: 2,
  }
  // ★ 正对照：把越权字段拿掉、换成一个纯强制面形状的清单 ⇒ 必须过。
  const clean = {
    version: 'legion/employee-manifest@1', employeeId: 'e-1', role: 'planner',
    displayName: '规划', allowedTools: ['read-file'], allowedCapabilities: ['file:read'],
    maxRisk: 'low', workspaceRoot: 'C:/w', unattended: true, notes: null,
  }
  assertManifestFieldsClosed({ manifest: clean })   // 不抛
  assert.ok(normalizeManifest(clean), '干净的强制面清单应当能归一化')

  let c1 = null
  try { assertManifestFieldsClosed({ manifest: ctxShaped }) } catch (err) { c1 = err.code }
  assert.equal(c1, 'employee-manifest-enforcement-on-agent-plane',
    'context 形状竟然过了强制面的字段闭合 ⇒ 两个形状事实上是兼容的，本节要重写')

  //   ★★ 而**拒得对**：`approvalPolicy` 正躺在 `FORBIDDEN_MANIFEST_FIELDS` 里
  //   （那是"一个能给自己发权限的清单"那条教义），所以这不是"少登记了一个字段"。
  assert.ok(FORBIDDEN_MANIFEST_FIELDS.includes('approvalPolicy'))
  const unknownToEnforcement = ctxFields
    .filter((f) => !MANIFEST_FIELDS.includes(f) && !FORBIDDEN_MANIFEST_FIELDS.includes(f))
  assert.deepEqual(unknownToEnforcement, ['scope', 'responsibilities', 'deniedTools', 'limits', 'createdAtMs', 'updatedAtMs'],
    '"根本不认识"的集合变了')

  // 方向二：强制面形状 → context ⇒ **接受，但丢字段**
  const src = employeeManifestSource(clean, { scope: 's-1', nowMs: 1 })
  const text = src.source.content
  for (const lost of ['allowedCapabilities', 'maxRisk', 'workspaceRoot', 'unattended']) {
    assert.equal(text.includes(lost), false,
      `context 侧竟然带上了 ${lost} ⇒ 方向二的结论变了`)
  }
  //   ⇒ 于是两个方向**都不可转换**：一边抛，一边丢。
  //
  //   > 一个「两个同名对象、一个抛一个丢字段」的仓库，
  //   > 与一个「它们只是同一个东西的两个视图」的仓库，
  //   > 在只读其中一侧的时候是同一个东西——只不过前者的接线人
  //   > 会在第一次把 hub 里那份员工清单喂进强制面时拿到一个**具名拒绝**，
  //   > 而那个拒绝看起来像"这份清单写错了"。
})

// ══════════════════════════════════════════════════════════════════════════
// (d) 产出者那一侧的现状：能算出许可，但**没有生产路径**
// ══════════════════════════════════════════════════════════════════════════

test('⑥ ★★ 许可的生产者**是活的（能算）**，而它的模块**不可达（不跑）**', () => {
  // 这两件事必须分开断言。"能算"证明 §11.2 那张图的上半段是真的；
  // "不可达"证明它确实没有生产入口——两者合起来才是 §11.2 的结论。
  const permit = realPermit()
  assert.equal(typeof permit.employeeId, 'string')
  assert.ok(Array.isArray(permit.allowedTools) && permit.allowedTools.length > 0)

  const an = analyze()
  for (const f of ['runtime/packs/authority.mjs', 'runtime/packs/compiled-plan.mjs', 'runtime/packs/store.mjs']) {
    assert.equal(an.known.has(f), true, `${f} 不在扫描面里 ⇒ 这条读数的前提变了`)
    assert.equal(an.reach.has(f), false,
      `${f} 变成可达了 ⇒ 包层接上了，§11.2/§11.3 的分类和本套件 ③ 的结论都要重核`)
  }
  // ★ 而 `employee-manifest.mjs` 自己是**可达**的——它里面有那个端口要用的函数。
  //   这正是基线 `$comment` 那句"可达性是逐模块测的"的具体实例。
  assert.equal(an.reach.has('runtime/dsh-composition/employee-manifest.mjs'), true,
    '强制面那一份清单模块竟然不可达 ⇒ 前提变了')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑦ ★ 闭环：桥要的那个"真名字"到底长什么样
// ══════════════════════════════════════════════════════════════════════════

test('⑦ ★★ 桥拿到的名字是 DSH 名，而 `dshToolNamesOf` 只覆盖得到**一部分** Legion 工具', () => {
  // 这一条把"两个名字空间"这件事钉成一个**可数**的读数：
  // Legion 目录里的 `KNOWN_TOOL_NAMES` 有多少个能映射到执行面工具名。
  const mapped = dshToolNamesOf()
  assert.ok(mapped.length > 0)
  // 映射出来的是**执行面**名字（DSH 名），所以它们**不在** tool-capability 的目录里：
  for (const d of mapped) {
    assert.equal(resolveTool(d).known, false,
      `${d} 竟然在执行面目录里被认得 ⇒ 两个名字空间不再不相交，本节的前提要重核`)
  }
  // ★ 而没有一个 Legion 名字等于任何 DSH 名字：
  const legionNames = Object.keys(LEGION_TOOL_ROUTING)
  assert.equal(legionNames.some((n) => mapped.includes(n)), false,
    '有 Legion 名字与 DSH 名字重名 ⇒ "不相交"不成立')
  // ⇒ 两个空间**结构上不相交**（这与 `tool-capability.mjs:465` 那条注释逐字一致），
  //   所以"把 DSH 名直接喂进 permitsTool"不可能偶然正确。
})
